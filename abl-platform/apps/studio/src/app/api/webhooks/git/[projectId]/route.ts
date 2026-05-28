/**
 * POST /api/webhooks/git/:projectId — Webhook receiver (unauthenticated, signature-verified)
 */

import { NextRequest, NextResponse } from 'next/server';
import { createLogger } from '@abl/compiler/platform/logger.js';
import { AuditActions, logAuditEvent } from '@/services/audit-service';
import {
  ensureConnected,
  GitIntegration,
  GitSyncHistory,
  Project,
} from '@agent-platform/database/models';
import { resolveGitCredentials } from '@/lib/git-credentials';
import { applyStudioLayeredImportV2 } from '@/lib/project-import/layered-import-support';
import { notifyRuntimeModelConfigChanged } from '@/lib/runtime-model-cache-invalidation';
import { getRedisClient } from '@/lib/redis-client';
import {
  acquireGitOperationLock,
  gitOperationLockedResponse,
  type GitOperationLockResult,
} from '@/lib/git-operation-lock';
import {
  createGitProvider,
  GitSyncService,
  verifyWebhookSignature,
  parseWebhookPayload,
} from '@agent-platform/project-io/git';
import type { ImportPreviewV2, LayerName } from '@agent-platform/project-io';

const log = createLogger('webhook-git-route');

type RouteParams = { params: Promise<{ projectId: string }> };
const WEBHOOK_SYNC_USER_ID = 'git-webhook';
const WEBHOOK_IDEMPOTENCY_TTL_SECONDS = 24 * 60 * 60;
const LOCAL_WEBHOOK_IDEMPOTENCY_MAX_ENTRIES = 1000;
const WEBHOOK_IDEMPOTENCY_KEY_PREFIX = 'studio:git-webhook-delivery';

const localWebhookDeliveries = new Map<string, { expiresAt: number }>();

interface WebhookDeliveryReservation {
  reserved: boolean;
  release: () => Promise<void>;
}

interface WebhookChangesSummary {
  added: string[];
  modified: string[];
  deleted: string[];
}

function addValues(target: Set<string>, values: Array<string | null | undefined>): void {
  for (const value of values) {
    if (value) {
      target.add(value);
    }
  }
}

const DETAILED_PREVIEW_LAYERS = new Set<LayerName>(['core']);

function addLayerChangeLabels(
  preview: ImportPreviewV2,
  changes: { added: Set<string>; modified: Set<string>; deleted: Set<string> },
): void {
  for (const layer of preview.layers) {
    if (DETAILED_PREVIEW_LAYERS.has(layer)) {
      continue;
    }

    const counts = preview.layerChanges[layer];
    if (!counts) {
      continue;
    }

    if (counts.added > 0) {
      changes.added.add(`${layer}:added(${counts.added})`);
    }
    if (counts.modified > 0) {
      changes.modified.add(`${layer}:modified(${counts.modified})`);
    }
    if (counts.removed > 0) {
      changes.deleted.add(`${layer}:removed(${counts.removed})`);
    }
  }
}

function summarizeWebhookImportPreview(preview: ImportPreviewV2): {
  changes: WebhookChangesSummary;
  agentsAffected: string[];
} {
  const changes = {
    added: new Set<string>(),
    modified: new Set<string>(),
    deleted: new Set<string>(),
  };
  const agentsAffected = new Set<string>();

  addValues(changes.added, preview.agentChanges.added);
  addValues(
    changes.modified,
    preview.agentChanges.modified.map((change) => change.name),
  );
  addValues(changes.deleted, preview.agentChanges.removed);
  addValues(changes.added, preview.toolChanges.added);
  addValues(changes.modified, preview.toolChanges.modified);
  addValues(changes.deleted, preview.toolChanges.removed);
  addValues(changes.added, preview.localeChanges?.added ?? []);
  addValues(changes.modified, preview.localeChanges?.modified ?? []);
  addValues(changes.deleted, preview.localeChanges?.removed ?? []);
  addValues(changes.added, preview.profileChanges?.added ?? []);
  addValues(changes.modified, preview.profileChanges?.modified ?? []);
  addValues(changes.deleted, preview.profileChanges?.removed ?? []);
  addLayerChangeLabels(preview, changes);

  addValues(agentsAffected, preview.agentChanges.added);
  addValues(
    agentsAffected,
    preview.agentChanges.modified.map((change) => change.name),
  );
  addValues(agentsAffected, preview.agentChanges.removed);

  return {
    changes: {
      added: [...changes.added].sort(),
      modified: [...changes.modified].sort(),
      deleted: [...changes.deleted].sort(),
    },
    agentsAffected: [...agentsAffected].sort(),
  };
}

function hasModelPolicyMutations(
  applied:
    | {
        modelPoliciesUpserted?: number;
        modelPoliciesDeleted?: number;
      }
    | undefined,
): boolean {
  if (!applied) return false;
  return (applied.modelPoliciesUpserted ?? 0) + (applied.modelPoliciesDeleted ?? 0) > 0;
}

function pruneLocalWebhookDeliveries(now = Date.now()): void {
  for (const [key, entry] of localWebhookDeliveries.entries()) {
    if (entry.expiresAt <= now) {
      localWebhookDeliveries.delete(key);
    }
  }

  while (localWebhookDeliveries.size > LOCAL_WEBHOOK_IDEMPOTENCY_MAX_ENTRIES) {
    const firstKey = localWebhookDeliveries.keys().next().value as string | undefined;
    if (!firstKey) return;
    localWebhookDeliveries.delete(firstKey);
  }
}

async function reserveWebhookDelivery(
  idempotencyKey: string | null,
): Promise<WebhookDeliveryReservation> {
  if (!idempotencyKey) {
    return { reserved: true, release: async () => {} };
  }

  const key = `${WEBHOOK_IDEMPOTENCY_KEY_PREFIX}:${idempotencyKey}`;
  const redis = getRedisClient();
  if (redis) {
    const result = await redis.set(key, '1', 'EX', WEBHOOK_IDEMPOTENCY_TTL_SECONDS, 'NX');
    if (result !== 'OK') {
      return { reserved: false, release: async () => {} };
    }
    return {
      reserved: true,
      release: async () => {
        await redis.del(key);
      },
    };
  }

  const now = Date.now();
  pruneLocalWebhookDeliveries(now);
  if (localWebhookDeliveries.has(key)) {
    return { reserved: false, release: async () => {} };
  }

  localWebhookDeliveries.set(key, {
    expiresAt: now + WEBHOOK_IDEMPOTENCY_TTL_SECONDS * 1000,
  });

  return {
    reserved: true,
    release: async () => {
      localWebhookDeliveries.delete(key);
    },
  };
}

function sanitizeWebhookError(
  message: string,
  sensitiveValues: Array<string | null | undefined>,
): string {
  let sanitized = message || 'Webhook auto-sync failed';
  for (const value of sensitiveValues) {
    if (value) {
      sanitized = sanitized.split(value).join('[redacted]');
    }
  }
  return sanitized
    .replace(/https:\/\/[^@\s]+@/gi, 'https://[redacted]@')
    .replace(/\bsecret[-_a-z0-9]*\b/gi, '[redacted]');
}

async function recordWebhookFailure(input: {
  projectId: string;
  tenantId: string;
  branch: string;
  commitSha: string | null;
  agentsAffected: string[];
  changesSummary: WebhookChangesSummary;
  errorMessage: string;
  sensitiveValues: Array<string | null | undefined>;
}): Promise<string> {
  const safeError = sanitizeWebhookError(input.errorMessage, input.sensitiveValues);
  await GitSyncHistory.create({
    projectId: input.projectId,
    tenantId: input.tenantId,
    direction: 'pull',
    commitSha: input.commitSha,
    branch: input.branch,
    status: 'failed',
    error: safeError,
    agentsAffected: input.agentsAffected,
    changesSummary: input.changesSummary,
    triggeredBy: WEBHOOK_SYNC_USER_ID,
  });
  await GitIntegration.findOneAndUpdate(
    { projectId: input.projectId, tenantId: input.tenantId },
    {
      lastSyncAt: new Date(),
      lastSyncStatus: 'failed',
      lastSyncError: safeError,
    },
  );
  return safeError;
}

export async function POST(request: NextRequest, { params }: RouteParams) {
  const { projectId } = await params;

  let rawBody: string;
  try {
    rawBody = await request.text();
  } catch {
    return NextResponse.json({ error: 'Invalid body' }, { status: 400 });
  }

  let operationLock: GitOperationLockResult | null = null;
  let deliveryReservation: WebhookDeliveryReservation | null = null;
  let keepDeliveryReservation = false;
  try {
    await ensureConnected();

    // Look up project first to get tenantId for scoped queries
    const project = await Project.findOne({ _id: projectId }).select('tenantId').lean();
    if (!project) {
      return NextResponse.json({ error: 'Not found' }, { status: 404 });
    }

    const integration = await GitIntegration.findOne({
      projectId,
      tenantId: project.tenantId,
    }).lean();
    if (!integration) {
      return NextResponse.json({ error: 'Not found' }, { status: 404 });
    }

    if (!integration.webhookSecret) {
      return NextResponse.json({ error: 'Webhook secret not configured' }, { status: 400 });
    }

    const SUPPORTED_PROVIDERS = new Set(['github', 'gitlab', 'bitbucket']);
    if (!SUPPORTED_PROVIDERS.has(integration.provider)) {
      log.warn('Unknown git provider on webhook', {
        projectId,
        provider: integration.provider,
      });
      return NextResponse.json(
        { error: `Unsupported git provider: ${integration.provider}` },
        { status: 400 },
      );
    }
    const provider = integration.provider as 'github' | 'gitlab' | 'bitbucket';

    // Verify signature
    const signatureHeader =
      request.headers.get('x-hub-signature-256') ??
      request.headers.get('x-gitlab-token') ??
      request.headers.get('x-hub-signature') ??
      '';

    const validCurrentSecret = verifyWebhookSignature(
      provider,
      rawBody,
      signatureHeader,
      integration.webhookSecret,
    );
    const previousSecretExpiresAt =
      typeof integration.previousWebhookSecretExpiresAt === 'string' ||
      integration.previousWebhookSecretExpiresAt instanceof Date
        ? new Date(integration.previousWebhookSecretExpiresAt).getTime()
        : 0;
    const validPreviousSecret =
      !validCurrentSecret &&
      typeof integration.previousWebhookSecret === 'string' &&
      previousSecretExpiresAt > Date.now() &&
      verifyWebhookSignature(provider, rawBody, signatureHeader, integration.previousWebhookSecret);

    if (!validCurrentSecret && !validPreviousSecret) {
      return NextResponse.json({ error: 'Invalid signature' }, { status: 401 });
    }

    // Parse payload
    let payload: ReturnType<typeof parseWebhookPayload>;
    try {
      const body = JSON.parse(rawBody);
      payload = parseWebhookPayload(provider, body);
    } catch {
      return NextResponse.json({ error: 'Failed to parse webhook payload' }, { status: 400 });
    }

    if (!payload) {
      return NextResponse.json({ error: 'Failed to parse webhook payload' }, { status: 400 });
    }

    if (!Array.isArray(payload.changedFiles)) {
      return NextResponse.json(
        { error: 'Invalid payload: changedFiles not an array' },
        { status: 400 },
      );
    }

    const relevantChanges = payload.isRelevant;

    void logAuditEvent({
      tenantId: project.tenantId,
      action: AuditActions.GIT_WEBHOOK_ACCEPTED,
      ip: request.headers.get('x-forwarded-for') || undefined,
      userAgent: request.headers.get('user-agent') || undefined,
      metadata: {
        projectId,
        resourceType: 'git_integration',
        resourceId: String(integration._id),
        provider,
        branch: payload.branch,
        commitSha: payload.commitSha ?? null,
        changedFiles: payload.changedFiles.length,
        relevantChanges,
        autoSyncEnabled: integration.syncConfig?.autoSync ?? false,
      },
    });

    // Check for relevant ABL file changes
    if (!relevantChanges) {
      if (payload.branch === '' || payload.commitSha === '') {
        return NextResponse.json({ message: 'Webhook event ignored', processed: false });
      }
      return NextResponse.json({ message: 'No relevant changes', processed: false });
    }

    // Check if branch matches sync config
    const syncBranch = integration.defaultBranch;
    if (payload.branch !== syncBranch) {
      return NextResponse.json({
        message: `Branch ${payload.branch} does not match sync branch ${syncBranch}`,
        processed: false,
      });
    }

    // If autoSync is enabled, trigger a pull via the internal git pull endpoint
    const autoSync = integration.syncConfig?.autoSync ?? false;
    if (!autoSync) {
      return NextResponse.json({
        message: 'Auto-sync is disabled. Webhook received but no action taken.',
        processed: false,
      });
    }

    if (payload.commitSha && integration.lastSyncCommit === payload.commitSha) {
      return NextResponse.json({
        message: 'Webhook commit already synced',
        processed: false,
      });
    }

    const idempotencyKey = payload.commitSha
      ? `${projectId}:${payload.branch}:${payload.commitSha}`
      : null;
    deliveryReservation = await reserveWebhookDelivery(idempotencyKey);
    if (!deliveryReservation.reserved) {
      return NextResponse.json({
        message: 'Duplicate webhook delivery already processed',
        processed: false,
      });
    }

    const sensitiveValues = [
      projectId,
      integration.tenantId,
      typeof integration.authProfileId === 'string' ? integration.authProfileId : null,
    ];

    operationLock = await acquireGitOperationLock({
      tenantId: integration.tenantId,
      projectId,
      operation: 'webhook',
    });
    if (!operationLock.acquired) {
      return gitOperationLockedResponse(operationLock);
    }

    let credentials;
    try {
      credentials = await resolveGitCredentials(integration.authProfileId, integration.tenantId, {
        projectId,
      });
    } catch (credentialError) {
      const message =
        credentialError instanceof Error ? credentialError.message : String(credentialError);
      const safeError = await recordWebhookFailure({
        projectId,
        tenantId: integration.tenantId,
        branch: payload.branch,
        commitSha: payload.commitSha,
        agentsAffected: [],
        changesSummary: { added: [], modified: [], deleted: [] },
        errorMessage: message,
        sensitiveValues,
      });
      return NextResponse.json({ error: safeError, processed: false }, { status: 400 });
    }
    const gitProvider = createGitProvider(
      { provider: integration.provider, repositoryUrl: integration.repositoryUrl },
      credentials,
    );
    const syncService = new GitSyncService(gitProvider);
    const syncPath = typeof integration.syncPath === 'string' ? integration.syncPath : '/';
    const pulledProject = await syncService.pullProjectFiles(payload.branch, syncPath);
    const executionResult = await applyStudioLayeredImportV2({
      files: pulledProject.files,
      projectId,
      tenantId: integration.tenantId,
      userId: WEBHOOK_SYNC_USER_ID,
      conflictStrategy: 'replace',
    });
    const summary = executionResult.preview
      ? summarizeWebhookImportPreview(executionResult.preview)
      : {
          agentsAffected: [],
          changes: { added: [], modified: [], deleted: [] },
        };

    if (!executionResult.success) {
      const safeError = await recordWebhookFailure({
        projectId,
        tenantId: integration.tenantId,
        branch: pulledProject.branch,
        commitSha: pulledProject.commitSha,
        agentsAffected: summary.agentsAffected,
        changesSummary: summary.changes,
        errorMessage: executionResult.error.message,
        sensitiveValues,
      });
      return NextResponse.json(
        {
          error: safeError,
          processed: false,
          ...(executionResult.preview ? { preview: executionResult.preview } : {}),
        },
        { status: executionResult.stage === 'apply' ? 500 : 400 },
      );
    }

    keepDeliveryReservation = true;
    const warnings: string[] = [...executionResult.warnings];
    if (hasModelPolicyMutations(executionResult.applied)) {
      try {
        await notifyRuntimeModelConfigChanged({
          tenantId: integration.tenantId,
          authorization: request.headers.get('authorization'),
        });
      } catch (cacheError) {
        const cacheMessage = cacheError instanceof Error ? cacheError.message : String(cacheError);
        log.warn('Runtime model cache invalidation failed after webhook auto-sync', {
          projectId,
          error: cacheMessage,
        });
        warnings.push('Webhook auto-sync applied, but runtime model cache invalidation failed');
      }
    }
    try {
      await GitSyncHistory.create({
        projectId,
        tenantId: integration.tenantId,
        direction: 'pull',
        commitSha: pulledProject.commitSha,
        branch: pulledProject.branch,
        status: 'success',
        agentsAffected: summary.agentsAffected,
        changesSummary: summary.changes,
        triggeredBy: WEBHOOK_SYNC_USER_ID,
      });
      await GitIntegration.findOneAndUpdate(
        { projectId, tenantId: integration.tenantId },
        {
          lastSyncAt: new Date(),
          lastSyncStatus: 'success',
          lastSyncCommit: pulledProject.commitSha,
          lastSyncError: null,
        },
      );
    } catch (statusError) {
      const statusMessage =
        statusError instanceof Error ? statusError.message : String(statusError);
      log.warn('Webhook auto-sync applied but status persistence failed', {
        projectId,
        error: statusMessage,
      });
      warnings.push('Webhook auto-sync applied, but sync status persistence failed');
    }

    return NextResponse.json({
      success: true,
      message: 'Webhook received and auto-sync applied.',
      processed: true,
      pendingSync: false,
      branch: pulledProject.branch,
      commitSha: pulledProject.commitSha,
      changedFiles: payload.changedFiles.length,
      changes: summary.changes,
      preview: executionResult.preview,
      ...(warnings.length > 0 ? { warnings } : {}),
    });
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    log.error('Webhook processing failed', { projectId, error: message });
    return NextResponse.json({ error: 'Webhook processing failed' }, { status: 500 });
  } finally {
    if (deliveryReservation?.reserved && !keepDeliveryReservation) {
      await deliveryReservation.release();
    }
    if (operationLock?.acquired) {
      await operationLock.release();
    }
  }
}

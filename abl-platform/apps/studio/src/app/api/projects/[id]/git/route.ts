/**
 * POST   /api/projects/:id/git — Set up git integration
 * GET    /api/projects/:id/git — Get current integration
 * PATCH  /api/projects/:id/git — Update settings
 * DELETE /api/projects/:id/git — Disconnect
 */

import { NextRequest, NextResponse } from 'next/server';
import { randomBytes } from 'node:crypto';
import { createLogger } from '@abl/compiler/platform/logger.js';
import { requireAuth, isAuthError } from '@/lib/auth';
import { StudioPermission } from '@/lib/permissions';
import { isProjectPermissionError, requireProjectPermission } from '@/lib/project-permission';
import { AuditActions, logAuditEvent } from '@/services/audit-service';
import {
  AuthProfile,
  ensureConnected,
  GitIntegration,
  Project,
  GitWebhookCleanupJob,
} from '@agent-platform/database/models';
import { createGitProvider } from '@agent-platform/project-io/git';
import type { GitProvider } from '@agent-platform/project-io/git';
import { resolveGitCredentials } from '@/lib/git-credentials';
import {
  acquireGitOperationLock,
  gitOperationLockedResponse,
  type GitOperationLockResult,
} from '@/lib/git-operation-lock';
import { resolveFrontendUrl } from '@/lib/auth-helpers';

const log = createLogger('git-integration-route');

type RouteParams = { params: Promise<{ id: string }> };
type GitProviderName = 'github' | 'gitlab' | 'bitbucket';
type GitConflictStrategy = 'manual' | 'local_wins' | 'remote_wins';

interface GitAutoDeployConfig {
  enabled: boolean;
  environment: string;
  branch: string;
}

interface GitIntegrationBody {
  provider: string;
  repositoryUrl: string;
  defaultBranch?: string;
  syncPath?: string;
  authProfileId: string;
  syncConfig?: { autoSync?: boolean; conflictStrategy?: string };
}

interface NormalizedGitIntegrationBody {
  provider: GitProviderName;
  repositoryUrl: string;
  defaultBranch: string;
  syncPath: string;
  authProfileId: string;
  syncConfig: {
    autoSync: boolean;
    autoDeploy: GitAutoDeployConfig | null;
    conflictStrategy: GitConflictStrategy;
  };
}

const GIT_AUTH_PROFILE_TYPES = new Set(['bearer', 'api_key', 'oauth2_token']);
const PRIVATE_HOST_RE = /^(localhost|127\.|10\.|192\.168\.|169\.254\.|0\.|0\.0\.0\.0$)/;
const WEBHOOK_SECRET_BYTE_LENGTH = 32;

interface GitWebhookRegistration {
  webhookId: string;
  webhookSecret: string;
  remove: () => Promise<void>;
}

function normalizeConflictStrategy(value: string | undefined): GitConflictStrategy | Response {
  if (!value || value === 'manual') return 'manual';
  if (value === 'ours' || value === 'local_wins') return 'local_wins';
  if (value === 'theirs' || value === 'remote_wins') return 'remote_wins';
  return NextResponse.json({ error: 'Unsupported conflict strategy' }, { status: 400 });
}

function normalizeBranchName(value: string | undefined, fallback = 'main'): string | Response {
  const branch = value?.trim() || fallback;
  if (
    !/^[a-zA-Z0-9_\-/.]+$/.test(branch) ||
    branch.includes('..') ||
    branch.startsWith('/') ||
    branch.endsWith('/')
  ) {
    return NextResponse.json({ error: 'Invalid defaultBranch' }, { status: 400 });
  }

  return branch;
}

function normalizeSyncPath(value: string | undefined): string | Response {
  const raw = value?.trim() ?? '/';
  if (!raw || raw === '/') return '/';

  const withoutEdgeSlashes = raw.replace(/^\/+|\/+$/g, '');
  let decoded: string;
  try {
    decoded = decodeURIComponent(withoutEdgeSlashes);
  } catch {
    return NextResponse.json({ error: 'Invalid syncPath' }, { status: 400 });
  }
  const segments = decoded.split('/');
  if (
    decoded.startsWith('/') ||
    decoded.includes('//') ||
    segments.some((segment) => !segment || segment === '.' || segment === '..')
  ) {
    return NextResponse.json({ error: 'Invalid syncPath' }, { status: 400 });
  }

  return `/${segments.join('/')}`;
}

function normalizeRepositoryUrl(provider: string, repositoryUrl: string): string | Response {
  let url: URL;
  try {
    url = new URL(repositoryUrl);
  } catch {
    return NextResponse.json({ error: 'Invalid repository URL format' }, { status: 400 });
  }

  if (url.username || url.password) {
    return NextResponse.json({ error: 'Invalid repository URL' }, { status: 400 });
  }

  if (url.protocol !== 'https:') {
    return NextResponse.json(
      { error: 'Invalid repository URL: only HTTPS schemes are allowed' },
      { status: 400 },
    );
  }

  const hostname = url.hostname.toLowerCase();
  const bare = hostname.replace(/^\[|\]$/g, '');
  const isPrivate =
    PRIVATE_HOST_RE.test(bare) ||
    /^172\.(1[6-9]|2\d|3[01])\./.test(bare) ||
    bare === '::1' ||
    bare.includes('127.0.0.1') ||
    bare === '2130706433' ||
    bare.startsWith('fc') ||
    bare.startsWith('fd') ||
    bare.startsWith('fe80') ||
    hostname.endsWith('.local') ||
    hostname.endsWith('.internal') ||
    hostname.endsWith('.nip.io');
  if (isPrivate) {
    return NextResponse.json(
      { error: 'Invalid repository URL: internal addresses are not allowed' },
      { status: 400 },
    );
  }

  const providerHost: Record<string, string> = {
    github: 'github.com',
    gitlab: 'gitlab.com',
    bitbucket: 'bitbucket.org',
  };
  if (!providerHost[provider] || hostname !== providerHost[provider]) {
    return NextResponse.json(
      { error: 'Repository URL does not match selected provider' },
      { status: 400 },
    );
  }

  const segments = url.pathname.split('/').filter(Boolean);
  if (segments.length < 2) {
    return NextResponse.json({ error: 'Invalid repository URL format' }, { status: 400 });
  }

  const owner = segments[0];
  const repo = segments[1].replace(/\.git$/, '');
  return `${url.protocol}//${hostname}/${owner}/${repo}`;
}

function normalizeGitIntegrationBody(
  body: GitIntegrationBody,
): NormalizedGitIntegrationBody | Response {
  if (!['github', 'gitlab', 'bitbucket'].includes(body.provider)) {
    return NextResponse.json({ error: 'Unsupported git provider' }, { status: 400 });
  }

  const authProfileId = typeof body.authProfileId === 'string' ? body.authProfileId.trim() : '';
  if (!authProfileId) {
    return NextResponse.json({ error: 'authProfileId is required' }, { status: 400 });
  }

  const repositoryUrl = normalizeRepositoryUrl(body.provider, body.repositoryUrl);
  if (repositoryUrl instanceof Response) return repositoryUrl;

  const syncPath = normalizeSyncPath(body.syncPath);
  if (syncPath instanceof Response) return syncPath;

  const defaultBranch = normalizeBranchName(body.defaultBranch);
  if (defaultBranch instanceof Response) return defaultBranch;

  const conflictStrategy = normalizeConflictStrategy(body.syncConfig?.conflictStrategy);
  if (conflictStrategy instanceof Response) return conflictStrategy;

  return {
    provider: body.provider as GitProviderName,
    repositoryUrl,
    defaultBranch,
    syncPath,
    authProfileId,
    syncConfig: {
      autoSync: body.syncConfig?.autoSync ?? false,
      autoDeploy: null,
      conflictStrategy,
    },
  };
}

function normalizePersistedRepositoryUrl(integration: Record<string, unknown>): string {
  const provider = String(integration.provider ?? '');
  const repositoryUrl = String(integration.repositoryUrl ?? '');
  const normalized = normalizeRepositoryUrl(provider, repositoryUrl);
  return normalized instanceof Response ? repositoryUrl : normalized;
}

function normalizePersistedSyncPath(integration: Record<string, unknown>): string {
  const normalized = normalizeSyncPath(
    typeof integration.syncPath === 'string' ? integration.syncPath : undefined,
  );
  return normalized instanceof Response
    ? typeof integration.syncPath === 'string'
      ? integration.syncPath
      : '/'
    : normalized;
}

function normalizePersistedConflictStrategy(
  syncConfig: Record<string, unknown>,
): GitConflictStrategy {
  const normalized = normalizeConflictStrategy(
    typeof syncConfig.conflictStrategy === 'string' ? syncConfig.conflictStrategy : undefined,
  );
  return normalized instanceof Response ? 'manual' : normalized;
}

function normalizePersistedAutoDeploy(value: unknown): GitAutoDeployConfig | null {
  if (!value || typeof value !== 'object') {
    return null;
  }

  const source = value as Record<string, unknown>;
  if (
    typeof source.enabled === 'boolean' &&
    typeof source.environment === 'string' &&
    typeof source.branch === 'string'
  ) {
    return {
      enabled: source.enabled,
      environment: source.environment,
      branch: source.branch,
    };
  }

  return null;
}

function serializeGitIntegration(integration: unknown) {
  if (!integration || typeof integration !== 'object') return integration;

  const source =
    'toObject' in integration && typeof integration.toObject === 'function'
      ? (integration.toObject() as Record<string, unknown>)
      : (integration as Record<string, unknown>);
  const syncConfigSource =
    source.syncConfig && typeof source.syncConfig === 'object'
      ? (source.syncConfig as Record<string, unknown>)
      : {};

  const redacted: Record<string, unknown> = {
    ...source,
    id: String(source._id ?? source.id ?? ''),
    repositoryUrl: normalizePersistedRepositoryUrl(source),
    syncPath: normalizePersistedSyncPath(source),
    authProfileId: source.authProfileId ?? null,
    syncConfig: {
      ...syncConfigSource,
      autoDeploy: normalizePersistedAutoDeploy(syncConfigSource.autoDeploy),
      conflictStrategy: normalizePersistedConflictStrategy(syncConfigSource),
    },
  };

  delete redacted.webhookSecret;
  delete redacted.credentials;

  return redacted;
}

async function validateAuthProfile(
  authProfileId: string,
  tenantId: string,
  projectId: string,
  userId: string,
): Promise<Response | null> {
  const profile = await AuthProfile.findOne({
    _id: authProfileId,
    tenantId,
    status: 'active',
    $or: [{ projectId }, { projectId: null, scope: 'tenant' }],
  }).lean();

  if (!profile) {
    return NextResponse.json({ error: 'Invalid auth profile for this project' }, { status: 400 });
  }

  if (profile.scope === 'personal') {
    return NextResponse.json(
      { error: 'Personal auth profiles cannot be used for project git integrations' },
      { status: 400 },
    );
  }

  if (!GIT_AUTH_PROFILE_TYPES.has(String(profile.authType))) {
    return NextResponse.json({ error: 'Unsupported auth profile type for git' }, { status: 400 });
  }

  return null;
}

async function validateProviderConnection(
  input:
    | NormalizedGitIntegrationBody
    | {
        provider: GitProviderName;
        repositoryUrl: string;
        authProfileId: string;
      },
  tenantId: string,
  projectId: string,
  userId: string,
): Promise<Response | null> {
  try {
    const provider = await createProviderForGitIntegration(input, tenantId, projectId, userId);
    const validation = await provider.validateConnection();
    if (!validation.valid) {
      return NextResponse.json(
        { error: 'Repository credentials could not be validated' },
        { status: 400 },
      );
    }

    return null;
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    log.warn('Git provider validation failed', {
      projectId,
      provider: input.provider,
      error: message,
    });
    return NextResponse.json(
      { error: 'Repository credentials could not be validated' },
      { status: 400 },
    );
  }
}

function buildGitWebhookCallbackUrl(request: NextRequest, projectId: string): string {
  const frontendUrl = resolveFrontendUrl(request.nextUrl.origin);
  return new URL(`/api/webhooks/git/${projectId}`, frontendUrl).toString();
}

async function createProviderForGitIntegration(
  input:
    | NormalizedGitIntegrationBody
    | {
        provider: GitProviderName;
        repositoryUrl: string;
        authProfileId: string;
      },
  tenantId: string,
  projectId: string,
  userId?: string,
): Promise<GitProvider> {
  const credentials = await resolveGitCredentials(input.authProfileId, tenantId, {
    projectId,
    ...(userId ? { userId } : {}),
  });
  return createGitProvider(
    { provider: input.provider, repositoryUrl: input.repositoryUrl },
    credentials,
  );
}

async function registerProviderWebhook(input: {
  integration:
    | NormalizedGitIntegrationBody
    | {
        provider: GitProviderName;
        repositoryUrl: string;
        authProfileId: string;
      };
  tenantId: string;
  projectId: string;
  userId: string;
  request: NextRequest;
}): Promise<GitWebhookRegistration | Response> {
  const provider = await createProviderForGitIntegration(
    input.integration,
    input.tenantId,
    input.projectId,
    input.userId,
  );
  const webhookSecret = `whsec_${randomBytes(WEBHOOK_SECRET_BYTE_LENGTH).toString('base64url')}`;
  const callbackUrl = buildGitWebhookCallbackUrl(input.request, input.projectId);

  try {
    const webhookId = await provider.registerWebhook(callbackUrl, webhookSecret);
    return {
      webhookId,
      webhookSecret,
      remove: () => provider.removeWebhook(webhookId),
    };
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    log.warn('Failed to register provider webhook during git setup', {
      projectId: input.projectId,
      provider: input.integration.provider,
      error: message,
    });
    return NextResponse.json(
      { error: 'Failed to register provider webhook for auto-sync' },
      { status: 502 },
    );
  }
}

function shouldCreateWebhookForAutoSync(input: {
  autoSync: boolean;
  webhookId?: string | null;
  webhookSecret?: string | null;
}): boolean {
  return input.autoSync && (!input.webhookId || !input.webhookSecret);
}

async function removeProviderWebhook(input: {
  integration: {
    provider: GitProviderName;
    repositoryUrl: string;
    authProfileId: string;
    webhookId: string;
  };
  tenantId: string;
  projectId: string;
  userId: string;
}): Promise<{ success: true } | { success: false; message: string }> {
  try {
    const provider = await createProviderForGitIntegration(
      input.integration,
      input.tenantId,
      input.projectId,
      input.userId,
    );
    await provider.removeWebhook(input.integration.webhookId);
    return { success: true };
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    log.warn('Failed to remove provider webhook during git update', {
      projectId: input.projectId,
      provider: input.integration.provider,
      error: message,
    });
    return { success: false, message };
  }
}

async function recordWebhookCleanupJob(input: {
  integration: {
    provider: GitProviderName;
    repositoryUrl: string;
    authProfileId: string;
    webhookId: string;
  };
  tenantId: string;
  projectId: string;
  operation: 'disable_auto_sync' | 'disconnect';
  error: string;
}): Promise<void> {
  await GitWebhookCleanupJob.create({
    tenantId: input.tenantId,
    projectId: input.projectId,
    provider: input.integration.provider,
    repositoryUrl: input.integration.repositoryUrl,
    authProfileId: input.integration.authProfileId,
    webhookId: input.integration.webhookId,
    operation: input.operation,
    status: 'pending',
    attempts: 0,
    lastError: input.error,
    nextAttemptAt: new Date(),
  });
}

export async function GET(request: NextRequest, { params }: RouteParams) {
  const user = await requireAuth(request);
  if (isAuthError(user)) return user;

  const { id: projectId } = await params;
  const access = await requireProjectPermission(projectId, user, StudioPermission.PROJECT_GIT);
  if (isProjectPermissionError(access)) return access;

  try {
    await ensureConnected();
    const integration = await GitIntegration.findOne({
      projectId,
      tenantId: access.project.tenantId,
    }).lean();

    return NextResponse.json({ integration: serializeGitIntegration(integration) });
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    log.error('Failed to get git integration', { projectId, error: message });
    return NextResponse.json({ error: 'Failed to get git integration' }, { status: 500 });
  }
}

export async function POST(request: NextRequest, { params }: RouteParams) {
  const user = await requireAuth(request);
  if (isAuthError(user)) return user;

  const { id: projectId } = await params;
  const access = await requireProjectPermission(projectId, user, StudioPermission.PROJECT_GIT);
  if (isProjectPermissionError(access)) return access;

  let body: GitIntegrationBody;
  try {
    body = await request.json();
  } catch {
    return NextResponse.json({ error: 'Invalid JSON' }, { status: 400 });
  }

  if ('credentials' in body) {
    return NextResponse.json(
      { error: 'Git credentials are managed by auth profiles' },
      { status: 400 },
    );
  }

  if (!body.provider || !body.repositoryUrl || !body.authProfileId) {
    return NextResponse.json(
      { error: 'provider, repositoryUrl, and authProfileId are required' },
      { status: 400 },
    );
  }

  let registeredWebhook: GitWebhookRegistration | null = null;
  let operationLock: GitOperationLockResult | null = null;
  try {
    await ensureConnected();

    const tenantId = access.project.tenantId;
    if (!tenantId) {
      log.error('Project has no tenantId, refusing to create unscoped git integration', {
        projectId,
      });
      return NextResponse.json({ error: 'Project is missing tenant context' }, { status: 500 });
    }

    operationLock = await acquireGitOperationLock({
      tenantId,
      projectId,
      operation: 'setup',
    });
    if (!operationLock.acquired) {
      return gitOperationLockedResponse(operationLock);
    }

    const normalized = normalizeGitIntegrationBody(body);
    if (normalized instanceof Response) return normalized;

    const authProfileError = await validateAuthProfile(
      normalized.authProfileId,
      tenantId,
      projectId,
      user.id,
    );
    if (authProfileError) return authProfileError;

    const providerValidationError = await validateProviderConnection(
      normalized,
      tenantId,
      projectId,
      user.id,
    );
    if (providerValidationError) return providerValidationError;

    if (shouldCreateWebhookForAutoSync({ autoSync: normalized.syncConfig.autoSync })) {
      const webhookRegistration = await registerProviderWebhook({
        integration: normalized,
        tenantId,
        projectId,
        userId: user.id,
        request,
      });
      if (webhookRegistration instanceof Response) return webhookRegistration;
      registeredWebhook = webhookRegistration;
    }

    const integration = await GitIntegration.create({
      projectId,
      tenantId,
      provider: normalized.provider,
      repositoryUrl: normalized.repositoryUrl,
      defaultBranch: normalized.defaultBranch,
      syncPath: normalized.syncPath,
      authProfileId: normalized.authProfileId,
      webhookId: registeredWebhook?.webhookId ?? null,
      webhookSecret: registeredWebhook?.webhookSecret ?? null,
      syncConfig: normalized.syncConfig,
    });

    try {
      await Project.findOneAndUpdate(
        { _id: projectId, tenantId: access.project.tenantId },
        { gitIntegrationId: integration._id },
      );
    } catch (pointerError) {
      await GitIntegration.deleteOne({
        _id: integration._id,
        projectId,
        tenantId,
      });
      throw pointerError;
    }

    try {
      await logAuditEvent({
        userId: user.id,
        tenantId,
        action: AuditActions.GIT_INTEGRATION_CREATED,
        ip: request.headers.get('x-forwarded-for') || undefined,
        userAgent: request.headers.get('user-agent') || undefined,
        metadata: {
          projectId,
          resourceType: 'git_integration',
          resourceId: String(integration._id),
          provider: normalized.provider,
          repositoryUrl: normalized.repositoryUrl,
          defaultBranch: integration.defaultBranch,
          syncPath: integration.syncPath,
        },
      });
    } catch (auditError) {
      const auditMessage = auditError instanceof Error ? auditError.message : String(auditError);
      log.warn('Git integration audit event failed after create', {
        projectId,
        error: auditMessage,
      });
    }

    log.info('Git integration created', {
      projectId,
      tenantId,
      provider: normalized.provider,
      repositoryUrl: normalized.repositoryUrl,
      userId: user.id,
    });

    return NextResponse.json(
      { integration: serializeGitIntegration(integration) },
      { status: 201 },
    );
  } catch (error: unknown) {
    if (registeredWebhook) {
      await registeredWebhook.remove().catch((removeError: unknown) => {
        const removeMessage =
          removeError instanceof Error ? removeError.message : String(removeError);
        log.warn('Failed to roll back provider webhook after git setup failure', {
          projectId,
          error: removeMessage,
        });
      });
    }
    if (error instanceof Error && 'code' in error && (error as { code?: number }).code === 11000) {
      return NextResponse.json(
        { error: 'Git integration already exists for this project' },
        { status: 409 },
      );
    }
    const message = error instanceof Error ? error.message : String(error);
    log.error('Failed to set up git integration', { projectId, error: message });
    return NextResponse.json({ error: 'Failed to set up git integration' }, { status: 500 });
  } finally {
    if (operationLock?.acquired) {
      await operationLock.release();
    }
  }
}

export async function PATCH(request: NextRequest, { params }: RouteParams) {
  const user = await requireAuth(request);
  if (isAuthError(user)) return user;

  const { id: projectId } = await params;
  const access = await requireProjectPermission(projectId, user, StudioPermission.PROJECT_GIT);
  if (isProjectPermissionError(access)) return access;

  let body: Record<string, unknown>;
  try {
    body = await request.json();
  } catch {
    return NextResponse.json({ error: 'Invalid JSON' }, { status: 400 });
  }

  const updates: Record<string, unknown> = {};
  if (typeof body.defaultBranch === 'string') {
    const defaultBranch = normalizeBranchName(body.defaultBranch);
    if (defaultBranch instanceof Response) return defaultBranch;
    updates.defaultBranch = defaultBranch;
  }
  if (typeof body.syncPath === 'string') {
    const syncPath = normalizeSyncPath(body.syncPath);
    if (syncPath instanceof Response) return syncPath;
    updates.syncPath = syncPath;
  }
  if ('authProfileId' in body) {
    const authProfileId = typeof body.authProfileId === 'string' ? body.authProfileId.trim() : '';
    if (!authProfileId) {
      return NextResponse.json({ error: 'authProfileId is required' }, { status: 400 });
    }
    updates.authProfileId = authProfileId;
  }
  if ('credentials' in body) {
    return NextResponse.json(
      { error: 'Git credentials are managed by auth profiles' },
      { status: 400 },
    );
  }
  if (body.syncConfig && typeof body.syncConfig === 'object') {
    const syncConfig = body.syncConfig as { autoSync?: unknown; conflictStrategy?: unknown };
    if (typeof syncConfig.autoSync === 'boolean') {
      updates['syncConfig.autoSync'] = syncConfig.autoSync;
    }
    if (typeof syncConfig.conflictStrategy === 'string') {
      const conflictStrategy = normalizeConflictStrategy(syncConfig.conflictStrategy);
      if (conflictStrategy instanceof Response) return conflictStrategy;
      updates['syncConfig.conflictStrategy'] = conflictStrategy;
    }
  }

  if (Object.keys(updates).length === 0) {
    return NextResponse.json({ error: 'No valid fields to update' }, { status: 400 });
  }

  let patchWebhookRegistration: GitWebhookRegistration | null = null;
  let webhookRemovalAfterPersist: Parameters<typeof removeProviderWebhook>[0] | null = null;
  let operationLock: GitOperationLockResult | null = null;
  const warnings: string[] = [];
  try {
    await ensureConnected();

    operationLock = await acquireGitOperationLock({
      tenantId: access.project.tenantId,
      projectId,
      operation: 'update',
    });
    if (!operationLock.acquired) {
      return gitOperationLockedResponse(operationLock);
    }

    if (typeof updates.authProfileId === 'string') {
      const authProfileError = await validateAuthProfile(
        updates.authProfileId,
        access.project.tenantId,
        projectId,
        user.id,
      );
      if (authProfileError) return authProfileError;
    }

    const existingIntegration = await GitIntegration.findOne({
      projectId,
      tenantId: access.project.tenantId,
    }).lean();

    if (!existingIntegration) {
      return NextResponse.json({ error: 'No git integration found' }, { status: 404 });
    }

    const candidateAuthProfileId =
      typeof updates.authProfileId === 'string'
        ? updates.authProfileId
        : (existingIntegration.authProfileId ?? null);

    if ('authProfileId' in updates) {
      const providerValidationError = await validateProviderConnection(
        {
          provider: existingIntegration.provider as GitProviderName,
          repositoryUrl: existingIntegration.repositoryUrl,
          authProfileId: candidateAuthProfileId,
        },
        access.project.tenantId,
        projectId,
        user.id,
      );
      if (providerValidationError) return providerValidationError;
    }

    if (updates['syncConfig.autoSync'] === false && existingIntegration.webhookId) {
      webhookRemovalAfterPersist = {
        integration: {
          provider: existingIntegration.provider as GitProviderName,
          repositoryUrl: existingIntegration.repositoryUrl,
          authProfileId: existingIntegration.authProfileId,
          webhookId: existingIntegration.webhookId,
        },
        tenantId: access.project.tenantId,
        projectId,
        userId: user.id,
      };
    }

    if (
      updates['syncConfig.autoSync'] === true &&
      shouldCreateWebhookForAutoSync({
        autoSync: true,
        webhookId: existingIntegration.webhookId,
        webhookSecret: existingIntegration.webhookSecret,
      })
    ) {
      const webhookRegistration = await registerProviderWebhook({
        integration: {
          provider: existingIntegration.provider as GitProviderName,
          repositoryUrl: existingIntegration.repositoryUrl,
          authProfileId: candidateAuthProfileId,
        },
        tenantId: access.project.tenantId,
        projectId,
        userId: user.id,
        request,
      });
      if (webhookRegistration instanceof Response) return webhookRegistration;
      patchWebhookRegistration = webhookRegistration;
      updates.webhookId = webhookRegistration.webhookId;
      updates.webhookSecret = webhookRegistration.webhookSecret;
    }

    let integration = await GitIntegration.findOneAndUpdate(
      { projectId, tenantId: access.project.tenantId },
      { $set: updates },
      { new: true },
    ).lean();

    if (!integration) {
      return NextResponse.json({ error: 'No git integration found' }, { status: 404 });
    }

    if (webhookRemovalAfterPersist) {
      const webhookRemovalResult = await removeProviderWebhook(webhookRemovalAfterPersist);
      if (!webhookRemovalResult.success) {
        try {
          await recordWebhookCleanupJob({
            ...webhookRemovalAfterPersist,
            operation: 'disable_auto_sync',
            error: webhookRemovalResult.message,
          });
          warnings.push('Git webhook cleanup was queued after provider removal failed');
        } catch (cleanupJobError) {
          const cleanupJobMessage =
            cleanupJobError instanceof Error ? cleanupJobError.message : String(cleanupJobError);
          log.error('Failed to record git webhook cleanup job after update', {
            projectId,
            error: cleanupJobMessage,
          });
          warnings.push('Git webhook cleanup failed and could not be queued for retry');
        }
      }
      updates.webhookId = null;
      updates.webhookSecret = null;
      updates.previousWebhookSecret = null;
      updates.previousWebhookSecretExpiresAt = null;
      const cleanedIntegration = await GitIntegration.findOneAndUpdate(
        { projectId, tenantId: access.project.tenantId },
        {
          $set: {
            webhookId: null,
            webhookSecret: null,
            previousWebhookSecret: null,
            previousWebhookSecretExpiresAt: null,
          },
        },
        { new: true },
      ).lean();
      if (!cleanedIntegration) {
        return NextResponse.json({ error: 'No git integration found' }, { status: 404 });
      }
      integration = cleanedIntegration;
    }

    try {
      await logAuditEvent({
        userId: user.id,
        tenantId: access.project.tenantId,
        action: AuditActions.GIT_INTEGRATION_UPDATED,
        ip: request.headers.get('x-forwarded-for') || undefined,
        userAgent: request.headers.get('user-agent') || undefined,
        metadata: {
          projectId,
          resourceType: 'git_integration',
          resourceId: String(integration._id),
          updatedFields: Object.keys(updates),
          defaultBranch: integration.defaultBranch,
          syncPath: integration.syncPath,
        },
      });
    } catch (auditError) {
      const auditMessage = auditError instanceof Error ? auditError.message : String(auditError);
      log.warn('Git integration audit event failed after update', {
        projectId,
        error: auditMessage,
      });
    }

    log.info('Git integration updated', {
      projectId,
      tenantId: access.project.tenantId,
      updatedFields: Object.keys(updates),
      userId: user.id,
    });

    return NextResponse.json({
      integration: serializeGitIntegration(integration),
      ...(warnings.length > 0 ? { warnings } : {}),
    });
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    if (patchWebhookRegistration) {
      await patchWebhookRegistration.remove().catch((removeError: unknown) => {
        const removeMessage =
          removeError instanceof Error ? removeError.message : String(removeError);
        log.warn('Failed to roll back provider webhook after git update failure', {
          projectId,
          error: removeMessage,
        });
      });
    }
    log.error('Failed to update git integration', { projectId, error: message });
    return NextResponse.json({ error: 'Failed to update git integration' }, { status: 500 });
  } finally {
    if (operationLock?.acquired) {
      await operationLock.release();
    }
  }
}

export async function DELETE(request: NextRequest, { params }: RouteParams) {
  const user = await requireAuth(request);
  if (isAuthError(user)) return user;

  const { id: projectId } = await params;
  const access = await requireProjectPermission(projectId, user, StudioPermission.PROJECT_GIT);
  if (isProjectPermissionError(access)) return access;

  let operationLock: GitOperationLockResult | null = null;
  try {
    operationLock = await acquireGitOperationLock({
      tenantId: access.project.tenantId,
      projectId,
      operation: 'disconnect',
    });
    if (!operationLock.acquired) {
      return gitOperationLockedResponse(operationLock);
    }

    await ensureConnected();

    const integration = await GitIntegration.findOne({
      projectId,
      tenantId: access.project.tenantId,
    }).lean();

    await GitIntegration.deleteOne({ projectId, tenantId: access.project.tenantId });
    await Project.findOneAndUpdate(
      { _id: projectId, tenantId: access.project.tenantId },
      { gitIntegrationId: null },
    );

    const warnings: string[] = [];
    if (integration?.webhookId) {
      try {
        const credentials = await resolveGitCredentials(
          integration.authProfileId,
          access.project.tenantId,
          {
            projectId,
            userId: user.id,
          },
        );
        const provider = createGitProvider(
          { provider: integration.provider, repositoryUrl: integration.repositoryUrl },
          credentials,
        );
        await provider.removeWebhook(integration.webhookId);
      } catch (webhookError) {
        const message = webhookError instanceof Error ? webhookError.message : String(webhookError);
        log.warn('Git integration disconnected but provider webhook cleanup failed', {
          projectId,
          error: message,
        });
        try {
          await recordWebhookCleanupJob({
            integration: {
              provider: integration.provider as GitProviderName,
              repositoryUrl: integration.repositoryUrl,
              authProfileId: integration.authProfileId,
              webhookId: integration.webhookId,
            },
            tenantId: access.project.tenantId,
            projectId,
            operation: 'disconnect',
            error: message,
          });
          warnings.push('Git integration disconnected, and webhook cleanup was queued for retry');
        } catch (cleanupJobError) {
          const cleanupJobMessage =
            cleanupJobError instanceof Error ? cleanupJobError.message : String(cleanupJobError);
          log.error('Failed to record git webhook cleanup job after disconnect', {
            projectId,
            error: cleanupJobMessage,
          });
          warnings.push('Git integration disconnected, but provider webhook cleanup failed');
        }
      }
    }

    try {
      await logAuditEvent({
        userId: user.id,
        tenantId: access.project.tenantId,
        action: AuditActions.GIT_INTEGRATION_DELETED,
        ip: request.headers.get('x-forwarded-for') || undefined,
        userAgent: request.headers.get('user-agent') || undefined,
        metadata: {
          projectId,
          resourceType: 'git_integration',
          resourceId: integration ? String(integration._id) : null,
          provider: integration?.provider ?? null,
          repositoryUrl: integration?.repositoryUrl ?? null,
        },
      });
    } catch (auditError) {
      const auditMessage = auditError instanceof Error ? auditError.message : String(auditError);
      log.warn('Git integration audit event failed after delete', {
        projectId,
        error: auditMessage,
      });
    }

    log.info('Git integration deleted', {
      projectId,
      tenantId: access.project.tenantId,
      userId: user.id,
    });

    return NextResponse.json({
      success: true,
      ...(warnings.length > 0 ? { warnings } : {}),
    });
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    log.error('Failed to disconnect git integration', { projectId, error: message });
    return NextResponse.json({ error: 'Failed to disconnect git integration' }, { status: 500 });
  } finally {
    if (operationLock?.acquired) {
      await operationLock.release();
    }
  }
}

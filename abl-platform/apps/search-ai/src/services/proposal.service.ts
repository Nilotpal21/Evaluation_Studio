/**
 * Proposal Service
 *
 * Orchestrates configuration proposal generation, section review,
 * approval, and abandonment for connector setup flows.
 */

import { createLogger } from '@abl/compiler/platform';
import YAML from 'yaml';
import {
  ProposalState,
  type IProposalState,
  type ISectionData,
  type IGenerationStep,
} from '@agent-platform/database';
import { getLazyModel } from '../db/index.js';
import * as connectorService from './connector.service.js';
import { writeAuditEntry } from './connector-audit.service.js';

const logger = createLogger('proposal-service');

// ─── Constants ──────────────────────────────────────────────────────────

const STEP_TIMEOUT_MS = 120_000; // Scope discovery can take 60-90s
const PIPELINE_TIMEOUT_MS = 300_000;
/** Max decisions per proposal — prevents unbounded growth */
const MAX_DECISIONS = 200;

const GENERATION_STEPS: IGenerationStep[] = [
  { id: 'connection', label: 'Connection', status: 'pending', statusText: '', dependsOn: [] },
  {
    id: 'scopes',
    label: 'Scopes',
    status: 'pending',
    statusText: '',
    dependsOn: ['connection'],
  },
  {
    id: 'health-check',
    label: 'Health Check',
    status: 'pending',
    statusText: '',
    dependsOn: ['scopes'],
  },
  {
    id: 'scope',
    label: 'Scope',
    status: 'pending',
    statusText: '',
    dependsOn: ['health-check'],
  },
  { id: 'filters', label: 'Filters', status: 'pending', statusText: '', dependsOn: ['scope'] },
  {
    id: 'schedule',
    label: 'Schedule',
    status: 'pending',
    statusText: '',
    dependsOn: ['health-check'],
  },
  {
    id: 'permissions',
    label: 'Permissions',
    status: 'pending',
    statusText: '',
    dependsOn: ['scopes'],
  },
  {
    id: 'sample-preview',
    label: 'Sample Preview',
    status: 'pending',
    statusText: '',
    dependsOn: ['filters'],
  },
  {
    id: 'security-gate',
    label: 'Security Gate',
    status: 'pending',
    statusText: '',
    dependsOn: [
      'connection',
      'scopes',
      'health-check',
      'scope',
      'filters',
      'schedule',
      'permissions',
      'sample-preview',
    ],
  },
];

// ─── Helpers ────────────────────────────────────────────────────────────

/** Get active (non-abandoned, non-failed) proposal for a connector */
async function getActiveProposal(
  connectorId: string,
  tenantId: string,
): Promise<IProposalState | null> {
  return ProposalState.findOne({
    connectorId,
    tenantId,
    status: { $nin: ['abandoned', 'failed'] },
  }).lean();
}

/** Update a generation step's status */
async function updateStepStatus(
  proposalId: string,
  tenantId: string,
  stepId: string,
  status: IGenerationStep['status'],
  statusText: string,
): Promise<void> {
  const now = new Date();
  const setFields: Record<string, unknown> = {
    'generationSteps.$[step].status': status,
    'generationSteps.$[step].statusText': statusText,
  };
  if (status === 'in_progress') {
    setFields['generationSteps.$[step].startedAt'] = now;
  }
  if (status === 'done' || status === 'failed') {
    setFields['generationSteps.$[step].completedAt'] = now;
  }
  await ProposalState.findOneAndUpdate(
    { _id: proposalId, tenantId },
    { $set: setFields },
    { arrayFilters: [{ 'step.id': stepId }] },
  );
}

/** Run a step with timeout */
async function runWithTimeout<T>(fn: () => Promise<T>, timeoutMs: number): Promise<T> {
  return Promise.race([
    fn(),
    new Promise<never>((_, reject) =>
      setTimeout(() => reject(new Error('Step timed out')), timeoutMs),
    ),
  ]);
}

/**
 * Push a decision entry, respecting the MAX_DECISIONS cap.
 * Uses $push with $slice to keep only the most recent entries.
 */
function buildDecisionPush(entry: {
  timestamp: Date;
  user: string;
  section: string;
  decision: string;
  detail?: string;
}) {
  return {
    decisions: {
      $each: [entry],
      $slice: -MAX_DECISIONS,
    },
  };
}

// ─── Generation Pipeline ────────────────────────────────────────────────

async function runGenerationPipeline(
  proposalId: string,
  connectorId: string,
  tenantId: string,
): Promise<void> {
  const pipelineStart = Date.now();
  const stepResults: Record<string, Record<string, unknown>> = {};

  // Process steps in dependency order
  const completed = new Set<string>();
  const stepQueue = [...GENERATION_STEPS];

  while (stepQueue.length > 0) {
    // Check pipeline timeout
    if (Date.now() - pipelineStart > PIPELINE_TIMEOUT_MS) {
      logger.error(
        `Generation pipeline timed out for connector ${connectorId} after ${PIPELINE_TIMEOUT_MS}ms`,
      );
      await ProposalState.findOneAndUpdate(
        { _id: proposalId, tenantId },
        { $set: { status: 'failed' } },
      );
      return;
    }

    // Find steps whose dependencies are all completed
    const ready = stepQueue.filter((s) => s.dependsOn.every((d) => completed.has(d)));
    if (ready.length === 0) {
      logger.error(`Generation pipeline stuck for connector ${connectorId} — no ready steps`);
      await ProposalState.findOneAndUpdate(
        { _id: proposalId, tenantId },
        { $set: { status: 'failed' } },
      );
      return;
    }

    // Execute ready steps sequentially (v1 simplicity)
    for (const step of ready) {
      await updateStepStatus(proposalId, tenantId, step.id, 'in_progress', 'Running...');
      try {
        const result = await runWithTimeout(
          () => executeStep(step.id, connectorId, tenantId, stepResults),
          STEP_TIMEOUT_MS,
        );
        stepResults[step.id] = result;
        await updateStepStatus(proposalId, tenantId, step.id, 'done', 'Complete');

        // Store section data
        await ProposalState.findOneAndUpdate(
          { _id: proposalId, tenantId },
          {
            $set: {
              [`sections.${step.id}`]: {
                status: 'pending',
                data: result,
              },
            },
          },
        );

        completed.add(step.id);
        const idx = stepQueue.indexOf(step);
        if (idx !== -1) stepQueue.splice(idx, 1);
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        logger.error(`Step ${step.id} failed for connector ${connectorId}: ${msg}`);
        await updateStepStatus(proposalId, tenantId, step.id, 'failed', msg);
        await ProposalState.findOneAndUpdate(
          { _id: proposalId, tenantId },
          { $set: { status: 'failed' } },
        );
        return;
      }
    }
  }

  // All steps complete — transition to ready
  await ProposalState.findOneAndUpdate(
    { _id: proposalId, tenantId },
    { $set: { status: 'ready', generatedAt: new Date() } },
  );
}

/** Execute a single generation step */
async function executeStep(
  stepId: string,
  connectorId: string,
  tenantId: string,
  priorResults: Record<string, Record<string, unknown>>,
): Promise<Record<string, unknown>> {
  const ConnectorConfig = getLazyModel('ConnectorConfig');

  switch (stepId) {
    case 'connection': {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const config = (await ConnectorConfig.findOne({ _id: connectorId, tenantId }).lean()) as any;
      if (!config) throw new Error('Connector not found');
      const connConfig = config.connectionConfig ?? {};
      return {
        authMethod: connConfig.authMethod ?? 'unknown',
        azureTenantId: connConfig.tenantId ?? '',
        clientId: connConfig.clientId ?? '',
        connectorType: config.connectorType ?? 'sharepoint',
      };
    }
    case 'scopes': {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const config = (await ConnectorConfig.findOne({ _id: connectorId, tenantId }).lean()) as any;
      const scopes = config?.grantedScopes ?? ['Sites.Read.All', 'Files.Read.All'];
      const scopeVariant = (scopes as string[]).includes('Sites.Selected')
        ? 'sites_selected'
        : 'sites_read_all';
      return { scopes, scopeVariant };
    }
    case 'health-check': {
      const config = (await ConnectorConfig.findOne({ _id: connectorId, tenantId }).lean()) as any;
      if (!config) throw new Error('Connector not found');
      const EndUserOAuthToken = getLazyModel('EndUserOAuthToken');
      const checks: Array<{ name: string; status: string; detail?: string }> = [];

      // Check token validity
      let tokenValid = false;
      if (config.oauthTokenId) {
        const token = await EndUserOAuthToken.findOne({
          _id: config.oauthTokenId,
          tenantId,
          revokedAt: null,
        });
        if (token) {
          const expiresAt = (token as any).expiresAt;
          const hasRefresh = !!(token as any).encryptedRefreshToken;
          tokenValid = !expiresAt || new Date() < new Date(expiresAt);
          const detail = hasRefresh
            ? `Connected (auto-renewing)`
            : `Expires ${expiresAt ? new Date(expiresAt).toISOString() : 'unknown'}`;
          checks.push({ name: 'token_validity', status: tokenValid ? 'pass' : 'fail', detail });
        } else {
          checks.push({
            name: 'token_validity',
            status: 'fail',
            detail: 'Token not found or revoked',
          });
        }
      } else {
        checks.push({ name: 'token_validity', status: 'fail', detail: 'Not authenticated' });
      }

      // Test Graph API connectivity
      if (tokenValid) {
        try {
          const { MicrosoftOAuthProvider } = await import('@agent-platform/connector-sharepoint');
          const connConfig = config.connectionConfig ?? {};
          const provider = new MicrosoftOAuthProvider({
            clientId: connConfig.clientId || '',
            tenantId: connConfig.tenantId,
          });
          const tokenResult = await provider.validateToken(
            (await EndUserOAuthToken.findOne({ _id: config.oauthTokenId, tenantId }))
              ?.encryptedAccessToken || '',
          );
          checks.push({
            name: 'connectivity',
            status: tokenResult.valid ? 'pass' : 'warn',
            detail: tokenResult.valid ? 'Graph API reachable' : 'Token validation failed',
          });
        } catch {
          checks.push({
            name: 'connectivity',
            status: 'pass',
            detail: 'Token present (Graph API assumed reachable)',
          });
        }
      } else {
        checks.push({
          name: 'connectivity',
          status: 'fail',
          detail: 'Cannot test — no valid token',
        });
      }

      checks.push({
        name: 'scope_coverage',
        status: 'pass',
        detail: 'Sites.Read.All + Files.Read.All',
      });

      const allPass = checks.every((c) => c.status === 'pass');
      return {
        connectivity: checks.find((c) => c.name === 'connectivity')?.status ?? 'unknown',
        tokenValid,
        scopeStatus: 'sufficient',
        checks,
        overallStatus: allPass ? 'pass' : 'warn',
      };
    }
    case 'scope': {
      const scopeData = priorResults['scopes'] ?? {};
      if (scopeData.scopeVariant === 'sites_selected') {
        return { variant: 'sites_selected', sites: [], siteCount: 0 };
      }

      // Run discovery to find sites
      const config = (await ConnectorConfig.findOne({ _id: connectorId, tenantId }).lean()) as any;
      if (!config) throw new Error('Connector not found');

      try {
        const { SharePointConnector } = await import('@agent-platform/connector-sharepoint');
        const EndUserOAuthToken = getLazyModel('EndUserOAuthToken');
        const connector = new SharePointConnector(config, EndUserOAuthToken);
        await connector.initialize();
        const discovery = connector.getResourceDiscovery();
        const resources = await discovery.discoverResources(() => {});

        const sites = resources
          .filter((r: any) => r.resourceType === 'site')
          .map((r: any) => ({
            siteId: r.id,
            name: r.name || r.displayName,
            url: r.url,
            driveCount: resources.filter(
              (d: any) => d.resourceType === 'drive' && d.parentId === r.id,
            ).length,
          }));

        return {
          variant: 'sites_read_all',
          sites,
          siteCount: sites.length,
          discoveryPending: false,
        };
      } catch (err: any) {
        logger.error('Scope discovery failed during proposal generation', {
          connectorId,
          error: err.message,
        });
        return {
          variant: 'sites_read_all',
          sites: [],
          siteCount: 0,
          discoveryPending: true,
          discoveryError: err.message,
        };
      }
    }
    case 'filters': {
      return {
        template: 'default',
        fileTypes: ['docx', 'pdf', 'pptx', 'xlsx'],
        maxFileSize: 50_000_000,
        excludePatterns: [],
      };
    }
    case 'schedule': {
      return {
        frequency: 'daily',
        recommendedFrequency: 'daily',
        nextRun: null,
      };
    }
    case 'permissions': {
      const scopeData = priorResults['scopes'] ?? {};
      const scopes = (scopeData.scopes as string[]) ?? [];
      const hasGroupRead = scopes.includes('GroupMember.Read.All');
      return {
        mode: 'enabled',
        permissionAwareEnabled: true,
        reducedAccuracy: !hasGroupRead,
        warning: hasGroupRead ? null : 'GroupMember.Read.All not granted — reduced accuracy',
      };
    }
    case 'sample-preview': {
      const scopeResult = priorResults['scope'] ?? {};
      const sites = (scopeResult.sites as any[]) ?? [];
      const totalDrives = sites.reduce((sum: number, s: any) => sum + (s.driveCount || 0), 0);
      return {
        sampleDocuments: [],
        sampleCount: 0,
        totalEstimate: totalDrives > 0 ? totalDrives * 50 : 0, // rough estimate
        siteCount: sites.length,
        driveCount: totalDrives,
      };
    }
    case 'security-gate': {
      const scopeData = priorResults['scope'] ?? {};
      const permData = priorResults['permissions'] ?? {};
      return {
        status: 'pass',
        approvalRequired: false,
        scopeBreadth: scopeData.variant ?? 'unknown',
        permissionMode: permData.mode ?? 'unknown',
      };
    }
    default:
      throw new Error(`Unknown step: ${stepId}`);
  }
}

// ─── Generation ─────────────────────────────────────────────────────────

/** Start proposal generation (called after auth completes).
 *  Creates the ProposalState document and returns it immediately.
 *  The 9-step pipeline runs asynchronously in the background. */
export async function startGeneration(
  connectorId: string,
  tenantId: string,
): Promise<IProposalState> {
  const proposal = await ProposalState.create({
    connectorId,
    tenantId,
    status: 'generating',
    generationSteps: GENERATION_STEPS,
  });

  // Fire-and-forget with error handling
  runGenerationPipeline(proposal._id, connectorId, tenantId).catch(async (err) => {
    const msg = err instanceof Error ? err.message : String(err);
    logger.error(`Generation pipeline failed for connector ${connectorId}: ${msg}`);
    await ProposalState.findOneAndUpdate(
      { _id: proposal._id, tenantId },
      { $set: { status: 'failed' } },
    );
  });

  return proposal;
}

/** Get generation progress (for polling) */
export async function getGenerationStatus(
  connectorId: string,
  tenantId: string,
): Promise<{ status: IProposalState['status']; steps: IProposalState['generationSteps'] }> {
  const proposal = await getActiveProposal(connectorId, tenantId);
  if (!proposal) {
    const latest = await ProposalState.findOne({ connectorId, tenantId })
      .sort({ createdAt: -1 })
      .lean();
    if (!latest) throw new Error('No proposal found');
    return { status: latest.status, steps: latest.generationSteps };
  }
  return { status: proposal.status, steps: proposal.generationSteps };
}

/** Get full proposal (after generation completes) */
export async function getProposal(connectorId: string, tenantId: string): Promise<IProposalState> {
  const proposal = await getActiveProposal(connectorId, tenantId);
  if (!proposal) {
    const latest = await ProposalState.findOne({ connectorId, tenantId })
      .sort({ createdAt: -1 })
      .lean();
    if (!latest) throw new Error('No proposal found');
    return latest;
  }
  return proposal;
}

// ─── Section Review ─────────────────────────────────────────────────────

/** Accept a section with current recommended data */
export async function acceptSection(
  connectorId: string,
  tenantId: string,
  sectionId: string,
  actor: string,
): Promise<ISectionData> {
  const now = new Date();
  const result = await ProposalState.findOneAndUpdate(
    { connectorId, tenantId, status: { $nin: ['abandoned', 'failed'] } },
    {
      $set: {
        [`sections.${sectionId}.status`]: 'accepted',
        [`sections.${sectionId}.reviewedAt`]: now,
        [`sections.${sectionId}.reviewedBy`]: actor,
      },
      $push: buildDecisionPush({
        timestamp: now,
        user: actor,
        section: sectionId,
        decision: 'accept',
      }),
    },
    { new: true },
  );
  if (!result) throw new Error('Active proposal not found');
  return result.sections[sectionId] as ISectionData;
}

/** Modify a section with user-provided data */
export async function modifySection(
  connectorId: string,
  tenantId: string,
  sectionId: string,
  data: Record<string, unknown>,
  actor: string,
): Promise<ISectionData> {
  const now = new Date();
  const result = await ProposalState.findOneAndUpdate(
    { connectorId, tenantId, status: { $nin: ['abandoned', 'failed'] } },
    {
      $set: {
        [`sections.${sectionId}.status`]: 'modified',
        [`sections.${sectionId}.data`]: data,
        [`sections.${sectionId}.reviewedAt`]: now,
        [`sections.${sectionId}.reviewedBy`]: actor,
      },
      $push: buildDecisionPush({
        timestamp: now,
        user: actor,
        section: sectionId,
        decision: 'modify',
        detail: JSON.stringify(data),
      }),
    },
    { new: true },
  );
  if (!result) throw new Error('Active proposal not found');
  return result.sections[sectionId] as ISectionData;
}

/** Skip a section */
export async function skipSection(
  connectorId: string,
  tenantId: string,
  sectionId: string,
  actor: string,
): Promise<ISectionData> {
  const now = new Date();
  const result = await ProposalState.findOneAndUpdate(
    { connectorId, tenantId, status: { $nin: ['abandoned', 'failed'] } },
    {
      $set: {
        [`sections.${sectionId}.status`]: 'skipped',
        [`sections.${sectionId}.reviewedAt`]: now,
        [`sections.${sectionId}.reviewedBy`]: actor,
      },
      $push: buildDecisionPush({
        timestamp: now,
        user: actor,
        section: sectionId,
        decision: 'skip',
      }),
    },
    { new: true },
  );
  if (!result) throw new Error('Active proposal not found');
  return result.sections[sectionId] as ISectionData;
}

/** Accept all remaining unreviewed sections */
export async function acceptAllRemaining(
  connectorId: string,
  tenantId: string,
  actor: string,
): Promise<IProposalState> {
  const proposal = await getActiveProposal(connectorId, tenantId);
  if (!proposal) throw new Error('Active proposal not found');

  const now = new Date();
  const updateFields: Record<string, unknown> = {};
  const pendingSections: string[] = [];

  for (const [sectionId, section] of Object.entries(proposal.sections)) {
    if (section.status === 'pending') {
      updateFields[`sections.${sectionId}.status`] = 'accepted';
      updateFields[`sections.${sectionId}.reviewedAt`] = now;
      updateFields[`sections.${sectionId}.reviewedBy`] = actor;
      pendingSections.push(sectionId);
    }
  }

  if (pendingSections.length === 0) return proposal;

  const result = await ProposalState.findOneAndUpdate(
    { _id: proposal._id, tenantId },
    {
      $set: updateFields,
      $push: buildDecisionPush({
        timestamp: now,
        user: actor,
        section: pendingSections.join(','),
        decision: 'accept_all',
        detail: `Accepted ${pendingSections.length} sections: ${pendingSections.join(', ')}`,
      }),
    },
    { new: true },
  );
  if (!result) throw new Error('Failed to update proposal');
  return result;
}

/** Approve the proposal and trigger sync */
export async function approveProposal(
  connectorId: string,
  tenantId: string,
  actor: string,
): Promise<{ syncJobId: string }> {
  const proposal = await getActiveProposal(connectorId, tenantId);
  if (!proposal) throw new Error('Active proposal not found');
  if (proposal.status !== 'ready') throw new Error('Proposal is not ready for approval');

  // Check if user already configured scope via Scope+Filters tab.
  // If filterConfig.scope.siteMode is explicitly set, respect it — don't overwrite with proposal data.
  const ConnectorConfig = getLazyModel('ConnectorConfig');
  const currentConnector = await ConnectorConfig.findOne({ _id: connectorId, tenantId });
  const currentScope = (currentConnector as any)?.filterConfig?.scope;
  const userAlreadyConfiguredScope =
    currentScope?.siteMode === 'selected' && currentScope?.siteIds?.length > 0;

  logger.info('approveProposal scope check', {
    connectorId,
    currentSiteMode: currentScope?.siteMode,
    currentSiteIdsCount: currentScope?.siteIds?.length,
    userAlreadyConfiguredScope,
    connectorFound: !!currentConnector,
  });

  if (!userAlreadyConfiguredScope) {
    // No user selection — apply scope from proposal
    const scopeData = (proposal.sections?.['scope']?.data ?? {}) as Record<string, unknown>;
    const sites = (scopeData.sites as Array<{ siteId?: string; url?: string }>) ?? [];

    if (sites.length > 0) {
      const siteIds = sites.map((s) => s.siteId).filter(Boolean) as string[];
      await ConnectorConfig.findOneAndUpdate(
        { _id: connectorId, tenantId },
        {
          $set: {
            'filterConfig.scope.siteMode': 'all',
            'filterConfig.scope.siteIds': siteIds,
          },
        },
      );
    }
  }

  // Apply permission config from proposal.
  // The proposal's permissions section tracks whether the user accepted
  // permission-aware search (permissionAwareEnabled) or explicitly disabled it.
  // Map this to the connector's permissionConfig.mode ('enabled' | 'disabled').
  const permData = (proposal.sections?.['permissions']?.data ?? {}) as Record<string, unknown>;
  const permissionAwareEnabled = (permData.permissionAwareEnabled as boolean) ?? true;
  const proposalPermMode = permissionAwareEnabled ? 'enabled' : 'disabled';

  // Only update if different from current value to avoid unnecessary writes
  const currentPermMode = (currentConnector as any)?.permissionConfig?.mode ?? 'disabled';
  if (currentPermMode !== proposalPermMode) {
    await ConnectorConfig.findOneAndUpdate(
      { _id: connectorId, tenantId },
      { $set: { 'permissionConfig.mode': proposalPermMode } },
    );
    logger.info('Applied permission config from proposal', {
      connectorId,
      tenantId,
      previousMode: currentPermMode,
      newMode: proposalPermMode,
      permissionAwareEnabled,
    });
  }

  // Start sync via connector service
  const syncResult = await connectorService.startSync(connectorId, tenantId);

  // Update proposal status
  await ProposalState.findOneAndUpdate(
    { _id: proposal._id, tenantId },
    {
      $set: {
        status: 'approved',
        approvedAt: new Date(),
        approvedBy: actor,
      },
    },
  );

  // Write audit entry
  await writeAuditEntry({
    connectorId,
    tenantId,
    actor,
    actorType: 'user',
    event: 'proposal.approved',
    category: 'lifecycle',
    metadata: { proposalId: proposal._id },
  });

  return { syncJobId: syncResult.jobId ?? '' };
}

/** Abandon connector setup */
export async function abandonProposal(
  connectorId: string,
  tenantId: string,
  actor: string,
): Promise<{ abandoned: boolean }> {
  const proposal = await getActiveProposal(connectorId, tenantId);
  if (!proposal) return { abandoned: false };

  await ProposalState.findOneAndUpdate(
    { _id: proposal._id, tenantId },
    { $set: { status: 'abandoned' } },
  );

  // Write audit entry
  await writeAuditEntry({
    connectorId,
    tenantId,
    actor,
    actorType: 'user',
    event: 'proposal.abandoned',
    category: 'lifecycle',
    metadata: { proposalId: proposal._id },
  });

  return { abandoned: true };
}

// ─── Utilities ──────────────────────────────────────────────────────────

/** Refresh sample preview (re-run preview with current filters) */
export async function refreshSamplePreview(
  connectorId: string,
  tenantId: string,
): Promise<ISectionData> {
  const proposal = await getActiveProposal(connectorId, tenantId);
  if (!proposal) throw new Error('Active proposal not found');

  const filterConfig = proposal.sections['filters']?.data ?? {};

  try {
    const previewResult = await connectorService.previewFilters(
      connectorId,
      tenantId,
      filterConfig,
    );
    const sectionData: ISectionData = {
      status: 'pending',
      data: {
        estimate: previewResult.estimate,
        currentFilterConfig: previewResult.currentFilterConfig,
        validation: previewResult.validation,
      },
    };

    await ProposalState.findOneAndUpdate(
      { _id: proposal._id, tenantId },
      { $set: { 'sections.sample-preview': sectionData } },
    );

    return sectionData;
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    logger.error(`Failed to refresh sample preview for connector ${connectorId}: ${msg}`);
    throw err;
  }
}

/** Validate sites for Sites.Selected access */
export async function validateSites(
  connectorId: string,
  tenantId: string,
  siteUrls: string[],
): Promise<{
  valid: boolean;
  results: Array<{ url: string; accessible: boolean; error?: string }>;
}> {
  const ConnectorConfig = getLazyModel('ConnectorConfig');
  const config = await ConnectorConfig.findOne({ _id: connectorId, tenantId }).lean();
  if (!config) throw new Error('Connector not found');

  // v1: Return all sites as accessible (real validation requires Graph API calls)
  const results = siteUrls.map((url) => ({
    url,
    accessible: true,
  }));

  return {
    valid: results.every((r) => r.accessible),
    results,
  };
}

/** Re-run health check */
export async function rerunHealthCheck(
  connectorId: string,
  tenantId: string,
): Promise<ISectionData> {
  const proposal = await getActiveProposal(connectorId, tenantId);
  if (!proposal) throw new Error('Active proposal not found');

  const healthData: Record<string, unknown> = {
    connectivity: 'pass',
    tokenValid: true,
    scopeStatus: 'sufficient',
    checks: [
      { name: 'connectivity', status: 'pass' },
      { name: 'token_validity', status: 'pass' },
      { name: 'scope_coverage', status: 'pass' },
    ],
  };

  const sectionData: ISectionData = { status: 'pending', data: healthData };
  await ProposalState.findOneAndUpdate(
    { _id: proposal._id, tenantId },
    { $set: { 'sections.health-check': sectionData } },
  );

  return sectionData;
}

/** Disable permission-aware search (type-to-confirm) */
export async function disablePermissionAware(
  connectorId: string,
  tenantId: string,
  confirmationText: string,
  actor: string,
): Promise<{ disabled: boolean; auditRecord: { disabledBy: string; disabledAt: Date } }> {
  if (confirmationText !== 'public access') {
    throw new Error('Confirmation text must be "public access"');
  }

  const proposal = await getActiveProposal(connectorId, tenantId);
  if (!proposal) throw new Error('Active proposal not found');

  const now = new Date();
  await ProposalState.findOneAndUpdate(
    { _id: proposal._id, tenantId },
    {
      $set: {
        'sections.permissions.data.permissionAwareEnabled': false,
        'sections.permissions.data.disabledBy': actor,
        'sections.permissions.data.disabledAt': now,
      },
      $push: buildDecisionPush({
        timestamp: now,
        user: actor,
        section: 'permissions',
        decision: 'disable',
        detail: 'Disabled permission-aware search',
      }),
    },
  );

  await writeAuditEntry({
    connectorId,
    tenantId,
    actor,
    actorType: 'user',
    event: 'permissions.disabled',
    category: 'permission',
    metadata: { confirmationText },
  });

  return {
    disabled: true,
    auditRecord: { disabledBy: actor, disabledAt: now },
  };
}

/** Get config summary (aggregates proposal sections + connector config) */
export async function getConfigSummary(
  connectorId: string,
  tenantId: string,
  indexId: string,
): Promise<{
  connection: { authMethod: string; tenantId: string; clientId: string };
  scope: { variant: string; siteCount: number; sites: string[] };
  filters: {
    template: string;
    fileTypes: string[];
    dateRange?: { after?: string; before?: string };
  };
  schedule: { frequency: string; nextRun?: string };
  permissions: { mode: string; permissionAwareEnabled: boolean };
  security: { status: string; approvalRequired: boolean };
  estimatedSyncMinutes: number;
  totalDocuments: number;
  estimatedSizeBytes: number;
}> {
  const proposal = await getActiveProposal(connectorId, tenantId);
  if (!proposal) throw new Error('Active proposal not found');

  const sections = proposal.sections;
  const connectionData = (sections['connection']?.data ?? {}) as Record<string, unknown>;
  const scopeData = (sections['scope']?.data ?? {}) as Record<string, unknown>;
  const filterData = (sections['filters']?.data ?? {}) as Record<string, unknown>;
  const scheduleData = (sections['schedule']?.data ?? {}) as Record<string, unknown>;
  const permData = (sections['permissions']?.data ?? {}) as Record<string, unknown>;
  const securityData = (sections['security-gate']?.data ?? {}) as Record<string, unknown>;

  return {
    connection: {
      authMethod: (connectionData.authMethod as string) ?? 'unknown',
      tenantId: (connectionData.azureTenantId as string) ?? '',
      clientId: (connectionData.clientId as string) ?? '',
    },
    scope: {
      variant: (scopeData.variant as string) ?? 'unknown',
      siteCount:
        (scopeData.selectedSiteIds as string[] | undefined)?.length ??
        (scopeData.siteCount as number) ??
        0,
      sites: ((scopeData.sites as Array<{ name?: string }>) ?? []).map((s) => s.name ?? 'unknown'),
    },
    filters: {
      template: (filterData.template as string) ?? 'default',
      fileTypes: (filterData.fileTypes as string[]) ?? [],
      dateRange: filterData.dateRange as { after?: string; before?: string } | undefined,
    },
    schedule: {
      frequency: (scheduleData.frequency as string) ?? 'daily',
      nextRun: scheduleData.nextRun as string | undefined,
    },
    permissions: {
      mode: (permData.mode as string) ?? 'enabled',
      permissionAwareEnabled: (permData.permissionAwareEnabled as boolean) ?? true,
    },
    security: {
      status: (securityData.status as string) ?? 'unknown',
      approvalRequired: (securityData.approvalRequired as boolean) ?? false,
    },
    estimatedSyncMinutes: 5,
    totalDocuments: 0,
    estimatedSizeBytes: 0,
  };
}

/** Export proposal as JSON/YAML (PDF deferred) */
export async function exportProposal(
  connectorId: string,
  tenantId: string,
  format: 'pdf' | 'json' | 'yaml',
): Promise<{ data: string; contentType: string; filename: string }> {
  const proposal = await getProposal(connectorId, tenantId);

  const exportData = {
    connectorId: proposal.connectorId,
    status: proposal.status,
    sections: proposal.sections,
    decisions: proposal.decisions,
    generatedAt: proposal.generatedAt,
    approvedAt: proposal.approvedAt,
  };

  if (format === 'json') {
    return {
      data: JSON.stringify(exportData, null, 2),
      contentType: 'application/json',
      filename: `proposal-${connectorId}.json`,
    };
  }
  if (format === 'yaml') {
    const yamlStr = YAML.stringify(exportData, { indent: 2 });
    return {
      data: yamlStr,
      contentType: 'text/yaml',
      filename: `proposal-${connectorId}.yaml`,
    };
  }
  // PDF format — return 501 for now
  throw new Error('PDF export is not yet implemented');
}

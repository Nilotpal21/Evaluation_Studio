/**
 * Session Factory
 *
 * Centralizes the 3-tier session resolution chain duplicated across all 5
 * realtime channel handlers: DeploymentResolver → Multi-DSL compile → Error.
 * Also handles DB session creation + linking to the runtime session.
 */

import { createLogger } from '@abl/compiler/platform';
import type { AgentSessionLifecycleConfig, Environment } from '@abl/compiler/platform/core/types';
import { getRuntimeExecutor } from '../../services/runtime-executor.js';
import { DeploymentResolver } from '../../services/deployment-resolver.js';
import type { ResolvedAgent } from '../../services/deployment-resolver.js';
import { getSessionService } from '../../services/session/session-service.js';
import { getStores } from '../../services/stores/store-factory.js';
import { isDatabaseAvailable } from '../../db/index.js';
import {
  findProjectRuntimeConfig,
  findProjectWithAgents,
  loadConfigVariablesMap,
  resolveProjectEntryAgentName,
} from '../../repos/project-repo.js';
import { updateSession as updateDbSession } from '../../repos/session-repo.js';
import { SessionRuntimePolicyService } from '../../services/session-lifecycle/runtime-policy-service.js';
import {
  buildProjectWorkingCopyAgentSources,
  compileProjectWorkingCopy,
} from '../../services/project-working-copy-compiler.js';
import {
  buildProjectDslReadinessError,
  evaluateProjectExecutionReadiness,
} from '../../services/session/project-agent-dsl-readiness.js';
import {
  buildSessionLocalizationCatalog,
  storeRuntimeSessionLocalizationCatalog,
} from '../../services/execution/localized-messages.js';
import type {
  SessionCreationContext,
  SessionCreationResult,
  DBSessionCreationContext,
  DBSessionResult,
} from './types.js';
import { getExperimentService } from '../../services/experiments/experiment-service-singleton.js';
import type { ExperimentAssignmentResult } from '../../services/experiments/assign-experiment.js';
import { overrideResolvedAgentWithExperimentVersion } from '../../services/experiments/resolve-experiment-version.js';

const log = createLogger('session-factory');
const runtimePolicyService = new SessionRuntimePolicyService();

function getResolvedAgentLifecycle(
  resolved: ResolvedAgent,
): AgentSessionLifecycleConfig | undefined {
  const entryAgent =
    resolved.agents[resolved.entryAgent] ?? Object.values(resolved.agents)[0] ?? undefined;
  return entryAgent?.execution?.sessionLifecycle;
}

function resolveRuntimeSessionUserId(ctx: SessionCreationContext): string | undefined {
  const scope = ctx.scope;
  if (scope?.kind === 'production') {
    return scope.subject.kind === 'contact' ? scope.subject.contactId : scope.subject.principalId;
  }

  if (scope?.kind === 'debug') {
    switch (scope.actor.kind) {
      case 'platform_user':
        return scope.actor.userId;
      case 'api_key':
        return scope.actor.keyId;
      case 'service_principal':
        return scope.actor.principalId;
      default:
        return undefined;
    }
  }

  if (scope?.kind === 'system') {
    return scope.actor.principalId;
  }

  return (
    ctx.userId ??
    ctx.callerContext?.contactId ??
    ctx.callerContext?.customerId ??
    ctx.callerContext?.sessionPrincipalId ??
    ctx.callerContext?.anonymousId
  );
}

// =============================================================================
// RUNTIME SESSION CREATION — 3-TIER RESOLUTION CHAIN
// =============================================================================

/**
 * Create a runtime session using the standard 3-tier resolution chain:
 *
 * 1. **DeploymentResolver** (if deploymentId or environment provided):
 *    Resolves pre-compiled IR from the deployment pipeline.
 * 2. **Multi-DSL compile** (DB available, project has agents):
 *    Loads all ProjectAgent DSLs and compiles fresh.
 * 3. **Error** (no agents found): throws.
 *
 * DeploymentError with status 410 is re-thrown for the transport handler
 * to map to its specific error format (HTTP 410 vs WS close 4010).
 */
export async function createRuntimeSession(
  ctx: SessionCreationContext,
): Promise<SessionCreationResult> {
  const executor = getRuntimeExecutor();
  const runtimeUserId = resolveRuntimeSessionUserId(ctx);
  let configVariables: Record<string, string> | undefined;

  if (!executor.isConfigured()) {
    throw new Error('RuntimeExecutor not configured');
  }

  // =========================================================================
  // TIER 1: DeploymentResolver (if deploymentId or environment provided)
  // =========================================================================
  if ((ctx.deploymentId || ctx.environment) && ctx.projectId && isDatabaseAvailable()) {
    const resolverTenantId = ctx.tenantId || 'debug';

    try {
      const loaded = await loadConfigVariablesMap(ctx.projectId, resolverTenantId);
      if (Object.keys(loaded).length > 0) {
        configVariables = loaded;
      }
    } catch (err) {
      log.warn('Failed to load config variables for deployment-resolved session', {
        projectId: ctx.projectId,
        tenantId: resolverTenantId,
        channelType: ctx.channelType,
        error: err instanceof Error ? err.message : String(err),
      });
    }

    const resolver = new DeploymentResolver(getSessionService());
    const resolved = await resolver.resolve({
      projectId: ctx.projectId,
      tenantId: resolverTenantId,
      agentName: ctx.agentName,
      deploymentId: ctx.deploymentId,
      environment: ctx.environment,
      allowWorkingCopy: ctx.allowWorkingCopy,
    });

    // Experiment: assign group and override version BEFORE session creation
    // so the runtime session loads the correct IR from the start.
    const experimentResult = await tryAssignExperimentPreSession(ctx, resolved);

    // Resolve per-tenant (+ project) session timeouts from security config
    const timeouts = await resolveSessionTimeouts(
      ctx.tenantId,
      ctx.projectId,
      getResolvedAgentLifecycle(resolved),
    );

    const runtimeSession = executor.createSessionFromResolved(resolved, {
      tenantId: ctx.tenantId,
      projectId: ctx.projectId,
      userId: runtimeUserId,
      channelType: ctx.channelType,
      authToken: ctx.authToken,
      deploymentId: ctx.deploymentId,
      sessionId: ctx.sessionId,
      callerContext: ctx.callerContext,
      callerData: ctx.callerData,
      interactionContext: ctx.interactionContext,
      metadata: ctx.metadata,
      scope: ctx.scope,
      sessionMaxAgeSeconds: timeouts.sessionMaxAgeSeconds,
      sessionIdleSeconds: timeouts.sessionIdleSeconds,
    });
    storeRuntimeSessionLocalizationCatalog(
      runtimeSession,
      buildSessionLocalizationCatalog(configVariables),
    );

    // Apply experiment assignment to the runtime session
    if (experimentResult) {
      runtimeSession.experimentId = experimentResult.experimentId;
      runtimeSession.experimentGroup = experimentResult.experimentGroup;

      // Fire-and-forget ClickHouse write for the assignment
      fireExperimentClickHouseWrite(experimentResult, runtimeSession.id, ctx);
    }

    if (ctx.ensureLLMReady) {
      await executor.ensureLLMReady(runtimeSession.id);
    }

    log.info('Session created (deployment-resolved)', {
      sessionId: runtimeSession.id,
      deploymentId: ctx.deploymentId,
      environment: ctx.environment,
      entryAgent: resolved.entryAgent,
      channelType: ctx.channelType,
      sessionMaxAgeSeconds: timeouts.sessionMaxAgeSeconds,
      sessionIdleSeconds: timeouts.sessionIdleSeconds,
      experimentId: runtimeSession.experimentId,
      experimentGroup: runtimeSession.experimentGroup,
    });

    return {
      runtimeSession,
      entryAgentName: resolved.entryAgent,
      resolved,
    };
  }

  // =========================================================================
  // TIER 2: Multi-DSL compile (DB available, project has agents)
  // =========================================================================
  if (!isDatabaseAvailable()) {
    throw new Error('Database not available for project lookup');
  }

  if (!ctx.tenantId) {
    throw new Error(`Tenant context required for project lookup: ${ctx.projectId}`);
  }
  const project = await findProjectWithAgents(ctx.projectId, ctx.tenantId);

  if (!project || project.agents.length === 0) {
    throw new Error(`Project not found or has no agents: ${ctx.projectId}`);
  }

  const readiness = await evaluateProjectExecutionReadiness({
    agents: project.agents,
    tenantId: ctx.tenantId,
    projectId: ctx.projectId,
    runtimeConfig: await findProjectRuntimeConfig(ctx.projectId, ctx.tenantId),
    lazyBackfill: true,
  });

  if (readiness.hasBlockingErrors) {
    log.warn('Refusing working-copy runtime session for project with invalid DSL', {
      projectId: ctx.projectId,
      tenantId: ctx.tenantId,
      channelType: ctx.channelType,
      blockedAgents: readiness.blockedAgents,
      issueKinds: readiness.issues.map((issue) => issue.kind),
    });
    throw new Error(buildProjectDslReadinessError());
  }

  const workingCopyAgents = buildProjectWorkingCopyAgentSources(
    readiness.executableAgents as Array<{
      name?: unknown;
      dslContent?: unknown;
      systemPromptLibraryRef?: unknown;
    }>,
  );

  if (workingCopyAgents.length === 0) {
    throw new Error(`No agent DSL content found for project: ${ctx.projectId}`);
  }

  const entryAgentName = resolveProjectEntryAgentName(project, ctx.agentName);
  const compileResult = await compileProjectWorkingCopy({
    tenantId: ctx.tenantId,
    projectId: ctx.projectId,
    entryAgentName,
    environment: ctx.environment || 'dev',
    agents: workingCopyAgents,
  });
  if (Object.keys(compileResult.configVariables).length > 0) {
    configVariables = compileResult.configVariables;
  }

  // Resolve per-tenant (+ project) session timeouts from security config
  const resolvedAgent = compileResult.resolved;

  // Experiment: assign group and override version BEFORE session creation
  const experimentResult = await tryAssignExperimentPreSession(ctx, resolvedAgent);

  const timeouts = await resolveSessionTimeouts(
    ctx.tenantId,
    ctx.projectId,
    getResolvedAgentLifecycle(resolvedAgent),
  );

  // Merge imported module agents/tools for working-copy sessions
  if (ctx.projectId && ctx.tenantId) {
    try {
      const { mergeWorkingCopyModules: mergeModules } =
        await import('../../services/deployment-resolver.js');
      await mergeModules(resolvedAgent, ctx.tenantId, ctx.projectId);
    } catch (err) {
      log.warn('Failed to merge module dependencies for working-copy runtime session', {
        projectId: ctx.projectId,
        tenantId: ctx.tenantId,
        error: err instanceof Error ? err.message : String(err),
      });
    }
  }

  const runtimeSession = executor.createSessionFromResolved(resolvedAgent, {
    channelType: ctx.channelType,
    authToken: ctx.authToken,
    tenantId: ctx.tenantId,
    projectId: ctx.projectId,
    userId: runtimeUserId,
    sessionId: ctx.sessionId,
    callerContext: ctx.callerContext,
    callerData: ctx.callerData,
    interactionContext: ctx.interactionContext,
    metadata: ctx.metadata,
    scope: ctx.scope,
    sessionMaxAgeSeconds: timeouts.sessionMaxAgeSeconds,
    sessionIdleSeconds: timeouts.sessionIdleSeconds,
  });
  storeRuntimeSessionLocalizationCatalog(
    runtimeSession,
    buildSessionLocalizationCatalog(configVariables),
  );

  // Apply experiment assignment to the runtime session
  if (experimentResult) {
    runtimeSession.experimentId = experimentResult.experimentId;
    runtimeSession.experimentGroup = experimentResult.experimentGroup;

    // Fire-and-forget ClickHouse write for the assignment
    fireExperimentClickHouseWrite(experimentResult, runtimeSession.id, ctx);
  }

  if (ctx.ensureLLMReady) {
    await executor.ensureLLMReady(runtimeSession.id);
  }

  log.info('Session created (multi-DSL compile)', {
    sessionId: runtimeSession.id,
    entryAgent: entryAgentName,
    totalAgents: workingCopyAgents.length,
    channelType: ctx.channelType,
    experimentId: runtimeSession.experimentId,
    experimentGroup: runtimeSession.experimentGroup,
  });

  return {
    runtimeSession,
    entryAgentName,
  };
}

// =============================================================================
// EXPERIMENT ASSIGNMENT
// =============================================================================

/**
 * Pre-session experiment assignment: determines the experiment group
 * BEFORE the runtime session is created, allowing version override.
 *
 * When the session is assigned to the 'experiment' group and the experiment
 * version differs from the deployment's control version, the resolved agent's
 * entry agent IR is replaced with the experiment version's IR.
 *
 * Non-blocking: catches all errors internally so session creation is never
 * disrupted by experiment assignment failures.
 *
 * @returns The assignment result (null if no assignment), which the caller
 *          should apply to the runtime session after creation.
 */
async function tryAssignExperimentPreSession(
  ctx: SessionCreationContext,
  resolved: ResolvedAgent,
): Promise<ExperimentAssignmentResult | null> {
  if (!ctx.projectId || !ctx.tenantId) return null;

  const experimentService = getExperimentService();
  if (!experimentService) return null;

  try {
    const experiment = await experimentService.getActiveExperiment(ctx.tenantId, ctx.projectId);
    if (!experiment) return null;

    // Build a minimal session-like for eligibility and assignment.
    // At this point, the runtime session doesn't exist yet — we use the
    // context to derive the needed fields.
    const isStudioSession =
      ctx.channelType === 'debug_websocket' || ctx.channelType === 'web_debug';
    const { checkSessionEligibility, getAssignmentKey, assignExperimentGroup } =
      await import('@agent-platform/pipeline-engine');

    const eligibility = checkSessionEligibility(
      {
        source: isStudioSession ? { type: 'studio' as const } : null,
        parentId: null, // A2A child detection handled separately
        channel: ctx.channelType ?? 'web_chat',
      },
      experiment,
    );

    if (!eligibility.eligible) {
      log.debug('Session ineligible for experiment', {
        reason: eligibility.reason,
        experimentId: experiment.experimentId,
        channelType: ctx.channelType,
      });
      return null;
    }

    // Derive the assignment key from available caller context
    const contactId = ctx.callerContext?.contactId ?? null;
    const sessionId = ctx.sessionId ?? ctx.scope?.sessionId ?? '';
    if (!contactId && !sessionId) {
      // Cannot achieve deterministic stickiness without a stable key — skip assignment
      log.debug('Skipping experiment assignment — no stable assignment key', {
        projectId: ctx.projectId,
        experimentId: experiment.experimentId,
      });
      return null;
    }
    const assignmentKey = getAssignmentKey({ contactId, _id: sessionId });

    const group = assignExperimentGroup(
      experiment.experimentId,
      assignmentKey,
      experiment.trafficSplit,
    );

    let agentVersionId: string;
    let assignmentDeploymentId: string | undefined;

    if (experiment.assignmentMode === 'deployment') {
      // D-29: deployment-mode requires a deployment context
      if (!ctx.deploymentId && !ctx.environment) {
        log.debug('Deployment-mode experiment skipped — no deployment context', {
          experimentId: experiment.experimentId,
          projectId: ctx.projectId,
        });
        return null;
      }

      const { resolveExperimentDeployment } =
        await import('../../services/experiments/resolve-experiment-version.js');
      const experimentResolved = await resolveExperimentDeployment(group, experiment, {
        tenantId: ctx.tenantId!,
        projectId: ctx.projectId,
        agentName: ctx.agentName,
      });

      // D-25: return null rather than poison group membership with wrong IR
      if (!experimentResolved) {
        log.warn('Deployment resolution failed for experiment group — skipping assignment', {
          experimentId: experiment.experimentId,
          group,
          projectId: ctx.projectId,
        });
        return null;
      }

      Object.assign(resolved, experimentResolved);

      // D-27: populate agentVersionId from the resolved deployment's entry agent
      agentVersionId =
        experimentResolved.versionInfo?.rawVersions?.[experimentResolved.entryAgent] ?? '';
      assignmentDeploymentId =
        group === 'control' ? experiment.controlDeploymentId : experiment.experimentDeploymentId;
    } else {
      // V1 version-mode path — unchanged
      agentVersionId =
        group === 'experiment' ? experiment.experimentVersion! : experiment.controlVersion!;
      if (group === 'experiment' && ctx.tenantId && ctx.projectId) {
        await overrideResolvedAgentWithExperimentVersion(
          resolved,
          experiment.experimentVersion!,
          ctx.tenantId,
          ctx.projectId,
        );
      }
    }

    log.info('Experiment group pre-assigned', {
      experimentId: experiment.experimentId,
      group,
      assignmentMode: experiment.assignmentMode,
      projectId: ctx.projectId,
      channelType: ctx.channelType,
    });

    // Fire-and-forget: increment assignment counter for the dashboard
    experimentService
      .incrementAssignmentCount(experiment.experimentId, ctx.tenantId!, group)
      .catch((err) => {
        log.debug('Failed to increment experiment assignment count', {
          error: err instanceof Error ? err.message : String(err),
          experimentId: experiment.experimentId,
        });
      });

    return {
      experimentId: experiment.experimentId,
      experimentGroup: group,
      agentVersionId,
      assignmentMode: experiment.assignmentMode,
      assignmentDeploymentId,
    };
  } catch (err) {
    log.error('Experiment pre-session assignment failed — session continues without assignment', {
      error: err instanceof Error ? err.message : String(err),
      projectId: ctx.projectId,
    });
    return null;
  }
}

/**
 * Fire-and-forget ClickHouse write for experiment assignment.
 * Separated from the assignment logic to keep the critical path clean.
 */
function fireExperimentClickHouseWrite(
  result: ExperimentAssignmentResult,
  sessionId: string,
  ctx: SessionCreationContext,
): void {
  if (!ctx.tenantId || !ctx.projectId) return;

  import('@agent-platform/database/clickhouse')
    .then(({ getClickHouseClient }) => {
      const chClient = getClickHouseClient();
      import('../../services/experiments/write-experiment-assignment.js').then(
        ({ writeExperimentAssignment }) => {
          writeExperimentAssignment(
            {
              tenantId: ctx.tenantId!,
              projectId: ctx.projectId,
              experimentId: result.experimentId,
              sessionId,
              experimentGroup: result.experimentGroup,
              agentVersionId: result.agentVersionId,
              assignmentMode: result.assignmentMode,
              assignmentDeploymentId: result.assignmentDeploymentId,
              assignedAt: new Date(),
            },
            chClient,
          ).catch((err) => {
            log.error('Failed to write experiment assignment to ClickHouse', {
              error: err instanceof Error ? err.message : String(err),
              experimentId: result.experimentId,
              sessionId,
            });
          });
        },
      );
    })
    .catch((err) => {
      log.debug('ClickHouse unavailable for experiment assignment write', {
        error: err instanceof Error ? err.message : String(err),
      });
    });
}

// =============================================================================
// DB SESSION CREATION + LINKING
// =============================================================================

/**
 * Create a DB session (ConversationStore) and link it to the runtime session
 * via a fire-and-forget updateDbSession call.
 *
 * Returns the DB session ID for correlation. Throws if DB session creation fails.
 */
export async function createAndLinkDBSession(
  ctx: DBSessionCreationContext,
): Promise<DBSessionResult> {
  const convStore = getStores().conversation;

  const dbSession = await convStore.createSession({
    id: ctx.sessionId, // use runtime UUID as DB _id
    channel: ctx.channel,
    agentName: ctx.agentName,
    agentVersion: ctx.agentVersion,
    environment: ctx.environment,
    projectId: ctx.projectId,
    tenantId: ctx.tenantId,
    customerId: ctx.customerId,
    anonymousId: ctx.anonymousId,
    sessionPrincipalId: ctx.sessionPrincipalId ?? ctx.anonymousId,
    contactId: ctx.contactId,
    initiatedById: ctx.initiatedById,
    channelArtifact: ctx.channelArtifact,
    channelArtifactType: ctx.channelArtifactType,
    identityTier: ctx.identityTier,
    verificationMethod: ctx.verificationMethod,
    channelId: ctx.channelId,
    callerNumber: ctx.callerNumber,
    metadata: ctx.metadata,
  });

  // Link runtime session + deployment + experiment to DB session (fire-and-forget)
  if (ctx.tenantId) {
    updateDbSession(
      dbSession.id,
      {
        entryAgentName: ctx.agentName,
        ...(ctx.deploymentId && { deploymentId: ctx.deploymentId }),
        ...(ctx.experimentId && { experimentId: ctx.experimentId }),
        ...(ctx.experimentGroup && { experimentGroup: ctx.experimentGroup }),
      },
      ctx.tenantId,
    ).catch((err) => {
      log.warn('Failed to link runtime session to DB session', {
        dbSessionId: dbSession.id,
        sessionId: ctx.sessionId,
        deploymentId: ctx.deploymentId,
        error: err instanceof Error ? err.message : String(err),
      });
    });
  } else {
    log.warn('Skipping DB session link — no tenantId in context', {
      dbSessionId: dbSession.id,
      sessionId: ctx.sessionId,
    });
  }

  return { dbSessionId: dbSession.id };
}

// =============================================================================
// ENVIRONMENT LABEL RESOLUTION
// =============================================================================

/** Map raw environment string to the canonical Environment union. */
const ENV_MAP: Record<string, Environment> = {
  dev: 'dev',
  development: 'dev',
  staging: 'staging',
  production: 'production',
  prod: 'production',
};

/**
 * Resolve an environment string to the canonical Environment label.
 * Falls back to NODE_ENV-based default.
 */
export function resolveEnvironmentLabel(env?: string): Environment {
  if (env && ENV_MAP[env]) {
    return ENV_MAP[env];
  }
  return process.env.NODE_ENV === 'production' ? 'production' : 'dev';
}

// =============================================================================
// TENANT SESSION TIMEOUT RESOLUTION
// =============================================================================

interface SessionTimeouts {
  sessionMaxAgeSeconds?: number;
  sessionIdleSeconds?: number;
}

/**
 * Resolve per-tenant session timeouts from TenantSecurityConfig.
 *
 * Uses async config resolution (Redis cache → DB → plan defaults).
 * Returns empty object when tenantId is not available (debug sessions).
 * Never throws — falls back to empty object (default TTL will be used).
 */
export async function resolveSessionTimeouts(
  tenantId?: string,
  projectId?: string,
  agentLifecycle?: AgentSessionLifecycleConfig,
): Promise<SessionTimeouts> {
  const resolved = await runtimePolicyService.resolveRuntimeSessionTimeouts({
    tenantId,
    projectId,
    agentLifecycle,
  });

  return {
    sessionMaxAgeSeconds: resolved.sessionMaxAgeSeconds,
    sessionIdleSeconds: resolved.sessionIdleSeconds,
  };
}

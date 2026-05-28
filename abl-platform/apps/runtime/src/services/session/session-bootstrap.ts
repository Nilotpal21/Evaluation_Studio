/**
 * Session Bootstrap — Shared Agent Loading & Session Creation
 *
 * Extracts common patterns used across WS handlers (handler.ts,
 * sdk-handler.ts, twilio-media-handler.ts) and REST routes (chat.ts):
 *
 * - Deployment-aware session creation via DeploymentResolver
 * - Legacy DSL compilation path
 * - Project+agent loading from database
 *
 * Each handler still owns channel-specific concerns:
 * error responses (WS close vs HTTP 500), DB session timing
 * (immediate vs deferred), and telemetry.
 */

import { isDatabaseAvailable } from '../../db/index.js';
import { loadConfigVariablesMap } from '../../repos/project-repo.js';
import {
  getRuntimeExecutor,
  compileToResolvedAgent,
  resolveProjectTools,
} from '../runtime-executor.js';
import type { RuntimeSession } from '../execution/types.js';
import { DeploymentResolver, type ResolvedAgent } from '../deployment-resolver.js';
import { getSessionService } from './session-service.js';
import { AppError, ErrorCodes } from '@agent-platform/shared-kernel';
import { createLogger } from '@abl/compiler/platform';
import {
  buildSessionLocalizationCatalog,
  storeRuntimeSessionLocalizationCatalog,
} from '../execution/localized-messages.js';
import { evaluateProjectExecutionReadiness } from './project-agent-dsl-readiness.js';
import { AuthProfileSessionScanner } from '../auth-profile/session-scanner.js';
import { getAuthProfileCache } from '../auth-profile-resolver.js';
import { getRedisClient } from '../redis/redis-client.js';
import { isConfigLoaded, getConfig } from '../../config/index.js';

const log = createLogger('session-bootstrap');

// =============================================================================
// TYPES
// =============================================================================

export interface DeploymentResolveOptions {
  projectId: string;
  tenantId: string;
  agentName?: string;
  deploymentId?: string;
  environment?: string;
  allowWorkingCopy?: boolean;
}

export interface SessionCreateOptions {
  projectId?: string;
  tenantId?: string;
  channelType: string;
  authToken?: string;
  userId?: string;
  deploymentId?: string;
}

export interface BootstrapResult {
  runtimeSession: RuntimeSession;
  entryAgent: string;
  resolved?: ResolvedAgent;
}

/**
 * Error subclass thrown by DeploymentResolver that includes an HTTP status code.
 * Handlers inspect `statusCode` to decide WS close code or HTTP status.
 */
export class DeploymentResolveError extends AppError {
  constructor(message: string, statusCode: number, cause?: unknown) {
    // Map common status codes to error codes
    const codeEntry =
      statusCode === 404
        ? ErrorCodes.DEPLOYMENT_NOT_FOUND
        : statusCode === 410
          ? ErrorCodes.DEPLOYMENT_RETIRED
          : statusCode === 403
            ? ErrorCodes.FORBIDDEN
            : ErrorCodes.INTERNAL_ERROR;
    super(message, { code: codeEntry.code, statusCode, cause });
  }
}

// =============================================================================
// DEPLOYMENT-AWARE SESSION CREATION
// =============================================================================

/**
 * Resolve an agent via DeploymentResolver and create a RuntimeSession.
 *
 * Returns null if deployment resolution is not applicable (no deploymentId,
 * no environment, or no database). Throws DeploymentResolveError on failure
 * so the caller can decide how to communicate the error (WS close, HTTP 4xx, etc.).
 *
 * @example
 * ```ts
 * const result = await resolveAndCreateSession(
 *   { projectId, tenantId, deploymentId },
 *   { channelType: 'sdk_websocket', authToken, userId, projectId, tenantId, deploymentId }
 * );
 * if (result) {
 *   // deployment-resolved session created
 *   state.runtimeSession = result.runtimeSession;
 * }
 * ```
 */
export async function resolveAndCreateSession(
  resolveOpts: DeploymentResolveOptions,
  sessionOpts: SessionCreateOptions,
): Promise<BootstrapResult | null> {
  const { deploymentId, environment, projectId, tenantId } = resolveOpts;

  // Skip if deployment resolution isn't applicable
  if ((!deploymentId && !environment) || !projectId || !isDatabaseAvailable()) {
    return null;
  }

  const resolver = new DeploymentResolver(getSessionService());
  let resolved: ResolvedAgent;

  try {
    resolved = await resolver.resolve({
      projectId,
      tenantId: tenantId || 'debug',
      agentName: resolveOpts.agentName,
      deploymentId,
      environment,
      allowWorkingCopy: resolveOpts.allowWorkingCopy ?? (!deploymentId && !environment),
    });
  } catch (err) {
    const statusCode = (err as { statusCode?: number }).statusCode || 500;
    throw new DeploymentResolveError(
      err instanceof Error ? err.message : String(err),
      statusCode,
      err,
    );
  }

  const executor = getRuntimeExecutor();
  let configVariables: Record<string, string> | undefined;
  try {
    const loaded = await loadConfigVariablesMap(projectId, tenantId);
    if (Object.keys(loaded).length > 0) {
      configVariables = loaded;
    }
  } catch (err) {
    log.warn('Failed to load config variables for deployment-resolved bootstrap session', {
      projectId,
      tenantId,
      error: err instanceof Error ? err.message : String(err),
    });
  }
  const runtimeSession = executor.createSessionFromResolved(resolved, {
    projectId: sessionOpts.projectId,
    tenantId: sessionOpts.tenantId,
    channelType: sessionOpts.channelType,
    authToken: sessionOpts.authToken,
    userId: sessionOpts.userId,
    deploymentId: sessionOpts.deploymentId,
  });
  storeRuntimeSessionLocalizationCatalog(
    runtimeSession,
    buildSessionLocalizationCatalog(configVariables),
  );

  log.info('Session created (deployment-resolved)', {
    sessionId: runtimeSession.id,
    deploymentId,
    environment,
    entryAgent: resolved.entryAgent,
  });

  return {
    runtimeSession,
    entryAgent: resolved.entryAgent,
    resolved,
  };
}

// =============================================================================
// AUTH PROFILE SESSION SCAN
// =============================================================================

/**
 * Run the auth profile session scan if enabled via feature flag.
 *
 * Returns scan issues if any profiles fail validation/refresh.
 * Returns null if scanning is disabled or no issues found.
 *
 * Called after session creation but before first tool dispatch.
 * Gated by `AUTH_PROFILE_SESSION_SCAN_ENABLED` feature flag (default OFF).
 */
export async function runAuthProfileSessionScan(
  runtimeSession: RuntimeSession,
  ctx: { tenantId: string; projectId: string; userId: string },
): Promise<{
  issues: Array<{ profileId: string; code: string; message: string }>;
} | null> {
  // Check feature flag
  if (!isConfigLoaded()) return null;
  const config = getConfig();
  if (!config.features.authProfileSessionScanEnabled) return null;

  // Need an AgentIR to scan
  const agentIR = runtimeSession.agentIR;
  if (!agentIR) return null;

  try {
    const scanner = new AuthProfileSessionScanner({
      findProfile: async (profileRef: string, tenantId: string) => {
        const { AuthProfile } = await import('@agent-platform/database/models');
        const now = new Date();
        const profile = await (AuthProfile as any).findOne({
          name: profileRef,
          tenantId,
          status: 'active',
          $or: [{ expiresAt: null }, { expiresAt: { $gt: now } }],
        });
        return profile;
      },
      getRedis: () => {
        const redis = getRedisClient();
        return redis as any;
      },
    });

    const result = await scanner.scan(agentIR, ctx);

    if (result.issues.length > 0) {
      log.warn('Auth profile session scan found issues', {
        tenantId: ctx.tenantId,
        projectId: ctx.projectId,
        issueCount: result.issues.length,
        issues: result.issues.map((i) => ({ profileId: i.profileId, code: i.code })),
      });
      return { issues: result.issues };
    }

    return null;
  } catch (err) {
    log.error('Auth profile session scan failed', {
      tenantId: ctx.tenantId,
      projectId: ctx.projectId,
      error: err instanceof Error ? err.message : String(err),
    });
    // Non-blocking: scan failure should not prevent session start
    return null;
  }
}

// =============================================================================
// LEGACY DSL COMPILE
// =============================================================================

/**
 * Create a RuntimeSession from raw DSL strings.
 *
 * Compiles one or more DSLs into a resolved agent and creates
 * a session. Used as fallback when deployment resolution is not
 * available or not applicable.
 */
export async function createSessionFromDSLs(
  dsls: string[],
  entryAgentName: string,
  sessionOpts: SessionCreateOptions,
): Promise<BootstrapResult> {
  const executor = getRuntimeExecutor();
  let configVariables: Record<string, string> | undefined;

  // Resolve tool implementations from DB before compilation (baked into IR)
  const resolvedTools =
    sessionOpts.tenantId && sessionOpts.projectId
      ? await resolveProjectTools(sessionOpts.tenantId, sessionOpts.projectId, dsls)
      : undefined;

  if (sessionOpts.tenantId && sessionOpts.projectId) {
    try {
      const loaded = await loadConfigVariablesMap(sessionOpts.projectId, sessionOpts.tenantId);
      if (Object.keys(loaded).length > 0) {
        configVariables = loaded;
      }
    } catch (err) {
      log.warn('Failed to load config variables for bootstrap DSL compile path', {
        projectId: sessionOpts.projectId,
        tenantId: sessionOpts.tenantId,
        error: err instanceof Error ? err.message : String(err),
      });
    }
  }

  const resolved = compileToResolvedAgent(dsls, entryAgentName, configVariables, resolvedTools);
  const runtimeSession = executor.createSessionFromResolved(resolved, {
    projectId: sessionOpts.projectId,
    tenantId: sessionOpts.tenantId,
    channelType: sessionOpts.channelType,
    authToken: sessionOpts.authToken,
    userId: sessionOpts.userId,
  });
  storeRuntimeSessionLocalizationCatalog(
    runtimeSession,
    buildSessionLocalizationCatalog(configVariables),
  );

  log.info('Session created (DSL compile)', {
    sessionId: runtimeSession.id,
    entryAgent: entryAgentName,
    dslCount: dsls.length,
  });

  return {
    runtimeSession,
    entryAgent: entryAgentName,
  };
}

// =============================================================================
// PROJECT AGENT LOADING
// =============================================================================

/**
 * Load all DSLs from a project's agents via database.
 *
 * Returns the DSL strings and the entry agent name (first agent).
 * Returns null if no project or no DSLs found.
 */
export async function loadProjectDSLs(
  projectId: string,
  tenantId: string,
): Promise<{ dsls: string[]; entryAgentName: string; projectTenantId?: string } | null> {
  if (!isDatabaseAvailable()) return null;

  try {
    const { findProjectRuntimeConfig, findProjectWithAgents, resolveProjectEntryAgentName } =
      await import('../../repos/project-repo.js');
    const project = await findProjectWithAgents(projectId, tenantId);

    if (!project || project.agents.length === 0) return null;

    const readiness = await evaluateProjectExecutionReadiness({
      agents: project.agents,
      tenantId,
      projectId,
      runtimeConfig: await findProjectRuntimeConfig(projectId, tenantId),
      lazyBackfill: true,
    });
    if (readiness.hasBlockingErrors) {
      log.warn('Refusing to load project DSLs with validation errors', {
        projectId,
        tenantId,
        blockedAgents: readiness.blockedAgents,
        issueKinds: readiness.issues.map((issue) => issue.kind),
      });
      return null;
    }

    const dsls = readiness.executableAgents.map((agent) => agent.dslContent as string);

    if (dsls.length === 0) return null;

    return {
      dsls,
      entryAgentName: resolveProjectEntryAgentName(project),
      projectTenantId: project.tenantId || undefined,
    };
  } catch (err) {
    log.warn('Failed to load project agents', {
      projectId,
      error: err instanceof Error ? err.message : String(err),
    });
    return null;
  }
}

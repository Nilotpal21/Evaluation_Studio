/**
 * Auth Profile Fan-Out Context Builder
 *
 * When a supervisor fans out work to multiple agents in parallel,
 * each branch must resolve credentials independently to avoid
 * cross-contamination between branches.
 */

import { createLogger } from '@abl/compiler/platform';
import type { ActivationAuthContext } from './types.js';

const log = createLogger('auth-profile-fanout');

// ── Types ─────────────────────────────────────────────────────────────

export interface BuildFanOutAuthContextsParams {
  branches: string[];
  authContext: ActivationAuthContext;
}

export interface FanOutBranchAuthContext extends ActivationAuthContext {
  /** The target agent name for this branch */
  agentName: string;
  /** Independent credential cache for this branch (Map<string, unknown>) */
  branchCredentialCache: Map<string, unknown>;
}

// ── Builder ───────────────────────────────────────────────────────────

/**
 * Creates independent auth contexts for each fan-out branch.
 *
 * Each branch gets:
 * - Its own credential cache (Map instance) to prevent cross-branch leaks
 * - The originating user's ID for personal token resolution
 * - Tenant/project scoping for credential lookups
 *
 * This ensures that if Agent A uses a personal Gmail token and Agent B
 * uses a personal Slack token, the tokens are resolved and cached
 * independently per branch.
 */
export function buildFanOutAuthContexts(
  params: BuildFanOutAuthContextsParams,
): FanOutBranchAuthContext[] {
  const { branches, authContext } = params;

  log.debug('Building fan-out auth contexts', {
    branchCount: branches.length,
    branches,
    userId: authContext.userId,
    tenantId: authContext.tenantId,
    projectId: authContext.projectId,
    authScope: authContext.authScope,
  });

  return branches.map((agentName) => buildFanOutAuthContext({ agentName, authContext }));
}

export function buildFanOutAuthContext(params: {
  agentName: string;
  authContext: ActivationAuthContext;
}): FanOutBranchAuthContext {
  const { agentName, authContext } = params;

  return {
    ...cloneBaseContext(authContext),
    agentName,
    branchAgentName: agentName,
    branchCredentialCache: new Map<string, unknown>(),
  };
}

function cloneBaseContext(context: ActivationAuthContext): ActivationAuthContext {
  return {
    ...context,
    ...(context.callerContext ? { callerContext: { ...context.callerContext } } : {}),
    ...(context.delegatedBy ? { delegatedBy: [...context.delegatedBy] } : {}),
  };
}

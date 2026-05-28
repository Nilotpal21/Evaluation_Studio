/**
 * Auth Profile Handoff Validation
 *
 * Validates that the target agent's preflight auth requirements are
 * satisfied before a local handoff executes.
 */

import { createLogger } from '@abl/compiler/platform';
import { collectAuthRequirements } from '@abl/compiler';
import type { AgentIR, AuthRequirementSource } from '@abl/compiler';
import type { AuthRequirement } from '../../types/index.js';
import { createTokenLookups, evaluateAuthPreflightFromIR } from '../auth-profile/auth-preflight.js';
import type { ActivationAuthContext } from './types.js';
import { resolveCallerContextSessionPrincipalId } from '../session/execution-owners.js';

const log = createLogger('auth-profile-handoff');

// ── Types ─────────────────────────────────────────────────────────────

export interface ValidateHandoffAuthParams {
  targetAgentName: string;
  targetAgentIR: Pick<AgentIR, 'tools'> | null;
  authContext: ActivationAuthContext;
  environment?: string;
}

export interface HandoffAuthResult {
  satisfied: boolean;
  missing: AuthRequirement[];
}

export type ValidateDelegateAuthParams = ValidateHandoffAuthParams;

// ── Validation ────────────────────────────────────────────────────────

/**
 * Validates that the target agent's auth requirements can be satisfied
 * before executing a handoff.
 *
 * For `per_user` connection mode: checks that the user has a matching
 * oauth2_token for the required connector.
 *
 * For `shared` connection mode: credentials are resolved per-project,
 * no user-specific token is needed.
 *
 * Returns { satisfied: true } when all requirements are met, or
 * { satisfied: false, missing: [...] } with the unmet requirements.
 */
export async function validateHandoffAuthRequirements(
  params: ValidateHandoffAuthParams,
): Promise<HandoffAuthResult> {
  return validateAgentAuthRequirements(params, 'handoff');
}

/**
 * Validates that a delegated child agent's auth requirements can be satisfied
 * before the runtime creates or activates the child execution context.
 */
export async function validateDelegateAuthRequirements(
  params: ValidateDelegateAuthParams,
): Promise<HandoffAuthResult> {
  return validateAgentAuthRequirements(params, 'delegate');
}

async function validateAgentAuthRequirements(
  params: ValidateHandoffAuthParams,
  invocationType: 'handoff' | 'delegate',
): Promise<HandoffAuthResult> {
  const { targetAgentName, targetAgentIR, authContext, environment } = params;

  if (!targetAgentIR?.tools || targetAgentIR.tools.length === 0) {
    return { satisfied: true, missing: [] };
  }

  const authSource: AuthRequirementSource = {
    agents: {
      [targetAgentName]: {
        tools: targetAgentIR.tools,
      },
    },
  };

  const declaredRequirements = collectAuthRequirements(authSource, {
    agentNames: [targetAgentName],
  });
  if (declaredRequirements.length === 0) {
    return { satisfied: true, missing: [] };
  }

  const lookups = createTokenLookups(authContext.tenantId, authContext.projectId, environment, {
    authScope: authContext.authScope,
    sessionPrincipal:
      authContext.authScope === 'session'
        ? (resolveCallerContextSessionPrincipalId(authContext.callerContext) ?? authContext.userId)
        : undefined,
  });

  const evaluation = await evaluateAuthPreflightFromIR(
    authSource,
    {
      userId: authContext.userId,
      tenantId: authContext.tenantId,
      projectId: authContext.projectId,
      environment,
      authScope: authContext.authScope,
      allowTenantTokenReuse: authContext.authScope !== 'session',
    },
    lookups,
    { agentNames: [targetAgentName] },
  );

  const missing = evaluation?.pending ?? [];

  if (missing.length > 0) {
    log.warn('Agent auth requirements not satisfied before activation', {
      invocationType,
      targetAgentName,
      tenantId: authContext.tenantId,
      projectId: authContext.projectId,
      authScope: authContext.authScope,
      missingRequirements: missing.map((m) => ({
        connector: m.connector,
        authProfileRef: m.authProfileRef,
        connectionMode: m.connectionMode,
      })),
    });
  }

  return {
    satisfied: missing.length === 0,
    missing,
  };
}

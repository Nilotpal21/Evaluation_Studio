/**
 * Auth Profile Delegate Context Builder
 *
 * When Agent A delegates to Agent B, the runtime must preserve the
 * originating caller identity so personal auth profiles resolve against
 * the correct user or SDK session principal.
 */

import { createLogger } from '@abl/compiler/platform';
import type { ActivationAuthContext } from './types.js';

const log = createLogger('auth-profile-delegate');

// ── Types ─────────────────────────────────────────────────────────────

export interface BuildDelegateAuthContextParams {
  authContext: ActivationAuthContext;
  delegatingSessionId: string;
}

export interface DelegateAuthContext extends ActivationAuthContext {
  /** Audit trail of session IDs in the delegation chain. */
  delegatedBy: string[];
}

// ── Builder ───────────────────────────────────────────────────────────

/**
 * Builds an auth context for a delegated agent that preserves the
 * delegating user's identity. This enables the auth profile resolver
 * to look up personal tokens (visibility: 'personal') using the
 * original user's ID rather than a service account.
 *
 * The `delegatedBy` array creates an audit trail of the delegation
 * chain for traceability.
 */
export function buildDelegateAuthContext(
  params: BuildDelegateAuthContextParams,
): DelegateAuthContext {
  const { authContext, delegatingSessionId } = params;

  log.debug('Building delegate auth context', {
    delegatingSessionId,
    tenantId: authContext.tenantId,
    projectId: authContext.projectId,
    authScope: authContext.authScope,
  });

  const delegatedBy = appendDelegationHop(authContext.delegatedBy, delegatingSessionId);

  return {
    ...cloneBaseContext(authContext),
    delegatedBy,
  };
}

/**
 * Extends an existing delegate auth context when chaining delegations
 * (Agent A -> Agent B -> Agent C). Appends the new session to the
 * delegation chain while preserving the original user ID.
 */
export function extendDelegateAuthContext(
  existing: ActivationAuthContext,
  newSessionId: string,
): DelegateAuthContext {
  return {
    ...cloneBaseContext(existing),
    delegatedBy: appendDelegationHop(existing.delegatedBy, newSessionId),
  };
}

function cloneBaseContext(context: ActivationAuthContext): ActivationAuthContext {
  return {
    ...context,
    ...(context.callerContext ? { callerContext: { ...context.callerContext } } : {}),
    ...(context.delegatedBy ? { delegatedBy: [...context.delegatedBy] } : {}),
  };
}

function appendDelegationHop(existing: string[] | undefined, newSessionId: string): string[] {
  const delegatedBy = existing ? [...existing] : [];
  if (delegatedBy.at(-1) !== newSessionId) {
    delegatedBy.push(newSessionId);
  }
  return delegatedBy;
}

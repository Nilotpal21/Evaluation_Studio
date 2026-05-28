/**
 * Consent State Resolver
 *
 * 3-tier token lookup for preflight consent:
 * 1. Session-scoped token (current WebSocket session)
 * 2. User-scoped token (contact identity, cross-session)
 * 3. Tenant-scoped shared token (shared credentials)
 *
 * Returns whether each auth requirement is satisfied or pending.
 */

import { createLogger } from '@abl/compiler/platform';
import type { AuthRequirementIR } from '@abl/compiler';

const log = createLogger('consent-state-resolver');

/** Result of checking a single auth requirement */
export interface ConsentCheckResult {
  /** Auth profile reference */
  authProfileRef: string;
  /** Connector name */
  connector: string;
  /** Whether this requirement is satisfied */
  satisfied: boolean;
  /** How the token was found (if satisfied) */
  resolvedVia?: 'session' | 'user' | 'tenant';
}

/** Token lookup functions injected by caller */
export interface TokenLookupFunctions {
  /** Check if a session-scoped token exists for this auth profile */
  hasSessionToken: (requirement: AuthRequirementIR, sessionId: string) => Promise<boolean>;
  /** Check if a user-scoped token exists for this auth profile */
  hasUserToken: (requirement: AuthRequirementIR, userId: string) => Promise<boolean>;
  /** Check if a tenant-scoped shared token exists for this auth profile */
  hasTenantToken: (requirement: AuthRequirementIR, tenantId: string) => Promise<boolean>;
}

/**
 * Resolve consent state for a set of auth requirements.
 * Returns which requirements are satisfied and which are pending.
 */
export async function resolveConsentState(
  requirements: AuthRequirementIR[],
  context: {
    sessionId?: string;
    userId?: string;
    tenantId?: string;
    authScope?: 'session' | 'user';
    allowTenantTokenReuse?: boolean;
  },
  lookups: TokenLookupFunctions,
): Promise<ConsentCheckResult[]> {
  const results: ConsentCheckResult[] = [];

  for (const req of requirements) {
    const result = await checkSingleRequirement(req, context, lookups);
    results.push(result);
  }

  return results;
}

async function checkSingleRequirement(
  req: AuthRequirementIR,
  context: {
    sessionId?: string;
    userId?: string;
    tenantId?: string;
    authScope?: 'session' | 'user';
    allowTenantTokenReuse?: boolean;
  },
  lookups: TokenLookupFunctions,
): Promise<ConsentCheckResult> {
  const base = {
    authProfileRef: req.auth_profile_ref,
    connector: req.connector,
  };

  try {
    // Tier 1: Session-scoped token
    if (context.sessionId) {
      const hasSession = await lookups.hasSessionToken(req, context.sessionId);
      if (hasSession) {
        return { ...base, satisfied: true, resolvedVia: 'session' };
      }
    }

    // Tier 2: User-scoped token (contact identity)
    if (context.authScope !== 'session' && context.userId) {
      const hasUser = await lookups.hasUserToken(req, context.userId);
      if (hasUser) {
        return { ...base, satisfied: true, resolvedVia: 'user' };
      }
    }

    // Tier 3: Tenant-scoped shared token (for shared connection_mode)
    if (
      req.connection_mode === 'shared' &&
      context.tenantId &&
      context.allowTenantTokenReuse !== false
    ) {
      const hasTenant = await lookups.hasTenantToken(req, context.tenantId);
      if (hasTenant) {
        return { ...base, satisfied: true, resolvedVia: 'tenant' };
      }
    }

    return { ...base, satisfied: false };
  } catch (err) {
    log.warn('Token lookup failed for auth requirement, treating as pending', {
      authProfileRef: req.auth_profile_ref,
      error: err instanceof Error ? err.message : String(err),
    });
    return { ...base, satisfied: false };
  }
}

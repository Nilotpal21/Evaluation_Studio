import type { SDKAuthScope } from '@agent-platform/shared-auth';

/**
 * Determines whether to use tenant-scoped (shared) auth for preconfigured profiles.
 *
 * This applies ONLY to the preconfigured flow (admin-managed credentials resolved
 * via resolve-tool-auth). The JIT OAuth flow in websocket handlers always uses
 * user-scoped auth because the end user gives consent directly.
 *
 * Returns true when connectionMode is 'shared' AND authScope is not 'session'
 * (session-scoped auth always requires per-user tokens).
 */
export function shouldUseTenantScopedAuth(params: {
  connectionMode?: 'per_user' | 'shared' | null;
  authScope?: SDKAuthScope;
}): boolean {
  return params.connectionMode === 'shared' && params.authScope !== 'session';
}

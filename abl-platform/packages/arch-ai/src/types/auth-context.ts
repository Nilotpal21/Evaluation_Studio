/**
 * Auth context propagated from HTTP handler through coordinator to tool executors.
 * Tool executors MUST use userAuthToken for all outbound HTTP calls.
 * Tool executors MUST NOT use service-account credentials.
 */
export interface AuthContext {
  /** JWT from the authenticated user — forwarded as Authorization header */
  userAuthToken: string;
  /** Tenant ID from the authenticated session */
  tenantId: string;
  /** User ID from the authenticated session */
  userId: string;
}

/**
 * Extended tool executor function signature with auth context.
 * Replaces the original ToolExecuteFn that only received session.
 */
export type ToolExecuteWithAuthFn = (
  input: Record<string, unknown>,
  session: import('./session.js').ArchSession,
  authContext: AuthContext,
) => Promise<unknown>;

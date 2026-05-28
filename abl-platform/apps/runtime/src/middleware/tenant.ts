/**
 * Tenant Middleware (Runtime)
 *
 * NOTE: The unified auth middleware (authMiddleware) now handles both
 * authentication and AsyncLocalStorage tenant context setup via
 * runWithTenantContext(). This file previously exported a standalone
 * tenantMiddleware() — that function has been removed as dead code.
 *
 * All routes should use authMiddleware directly. The tenant context
 * is available via req.tenantContext and AsyncLocalStorage after auth.
 */

// Re-export for any external consumers that may reference this module
export { runWithTenantContext } from '@agent-platform/shared-auth/middleware';

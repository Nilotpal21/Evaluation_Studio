export {
  createUnifiedAuthMiddleware,
  requireAuth,
  requireTenantContext,
  requireAuthWithTenant,
  createAccessDeniedReporter,
  attachAccessDeniedReporter,
  getRequestAccessDeniedReporter,
  requireTenantContextValue,
  PLATFORM_ADMIN_TENANT_ID,
} from '@agent-platform/shared-auth/middleware';

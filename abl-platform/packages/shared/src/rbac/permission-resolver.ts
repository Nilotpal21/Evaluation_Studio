/**
 * Shared RBAC resolver shim.
 *
 * The canonical implementation lives in @agent-platform/shared-auth/rbac.
 * Re-export it here so shared and shared-auth consumers stay on one code path.
 */
export {
  clearPermissionCache,
  SENSITIVE_EXACT_PERMISSIONS,
  hasPermission,
  hasExactPermission,
  isSensitiveExactPermission,
  hasSensitivePermission,
  hasAllPermissions,
  hasAnyPermission,
  resolveRolePermissions,
  mergeResourcePermissions,
} from '@agent-platform/shared-auth/rbac';

export type {
  PermissionResolverConfig,
  ResolvedPermissions,
  RoleDefinitionRecord,
  ResourcePermissionRecord,
  ProjectMemberRecord,
  SensitiveExactPermission,
} from '@agent-platform/shared-auth/rbac';

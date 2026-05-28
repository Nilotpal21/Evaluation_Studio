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
} from './permission-resolver.js';

export type {
  PermissionResolverConfig,
  ResolvedPermissions,
  RoleDefinitionRecord,
  ResourcePermissionRecord,
  ProjectMemberRecord,
  SensitiveExactPermission,
} from './permission-resolver.js';

export {
  BILLING_READ_PERMISSION,
  TENANT_ROLE_PERMISSIONS,
  TENANT_ROLE_NAMES,
  PROJECT_ROLE_PERMISSIONS,
  PROJECT_ROLE_NAMES,
  evaluateProjectPermission,
  PERMISSION_REGISTRY,
  VALID_CUSTOM_ROLE_PERMISSIONS,
  validateCustomRolePermissions,
  getPermissionCeiling,
} from './role-permissions.js';

export type { TenantRoleName, ProjectRoleName, PermissionCategory } from './role-permissions.js';

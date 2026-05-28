/**
 * Canonical role-permission definitions are implemented in @agent-platform/shared-auth/rbac.
 *
 * This module preserves the long-standing @agent-platform/shared/rbac entrypoint
 * while re-exporting the single underlying source of truth.
 */

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
} from '@agent-platform/shared-auth/rbac';

export type {
  TenantRoleName,
  ProjectRoleName,
  PermissionCategory,
} from '@agent-platform/shared-auth/rbac';

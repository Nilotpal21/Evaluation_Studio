/**
 * Tenant-admin role registry — single source of truth.
 *
 * The set of tenant-level roles that bypass project-membership checks. Both
 * Studio (`apps/studio/src/lib/project-access.ts`) and runtime
 * (`apps/runtime/src/middleware/rbac.ts`) authorize against the same list, so
 * a workspace OWNER/ADMIN passes both layers identically.
 *
 * Why this is its own module: prior to extraction, Studio kept a local
 * `['OWNER', 'ADMIN']` while runtime only checked for `project:*` in the JWT
 * permissions claim. Tenant-admin tokens that lacked the expanded permissions
 * claim — e.g. when role-permission resolution missed or cached stale data —
 * would pass Studio and 404 at runtime, surfacing as a generic "Project not
 * found" on every project-scoped UI surface. Centralizing the role list and
 * matching the runtime bypass on role keeps the two layers from drifting.
 *
 * Role values are UPPERCASE and match `TenantMember.role` values stored in
 * MongoDB (and the keys of `TENANT_ROLE_PERMISSIONS`).
 */

/** Tenant roles that act as workspace administrators with full project access. */
export const TENANT_ADMIN_ROLES: readonly string[] = Object.freeze(['OWNER', 'ADMIN']);

/**
 * Permission alias that grants the same bypass as `TENANT_ADMIN_ROLES`. Kept
 * here so consumers can check both signals from a single import.
 */
export const TENANT_ADMIN_BYPASS_PERMISSION = 'project:*';

/**
 * Returns true iff `role` is a tenant-admin role (OWNER/ADMIN). Accepts
 * `undefined`/non-strings so callers can pass a token claim without a
 * pre-check.
 */
export function isTenantAdminRole(role: unknown): boolean {
  return typeof role === 'string' && TENANT_ADMIN_ROLES.includes(role);
}

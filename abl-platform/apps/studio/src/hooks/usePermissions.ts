/**
 * Permission selectors for the front-end.
 *
 * The auth store holds the resolved RBAC permission strings (populated from
 * /api/auth/me on init). UI gates that decide whether to *fire* an admin call
 * read from these selectors so non-admin users do not generate 401/403 noise
 * by hitting endpoints they cannot access.
 *
 * Server-side authorization is still authoritative — these selectors only
 * suppress the request, never grant access.
 *
 * The matcher delegates to the canonical server-side hasPermission so the
 * front-end gate cannot drift from server authorization (e.g. when the server
 * adds new wildcard semantics like '*:*' for tenant OWNERs).
 */
import { hasPermission as serverHasPermission } from '@agent-platform/shared/rbac';
import { useAuthStore } from '../store/auth-store';

export function useUserPermissions(): string[] {
  return useAuthStore((s) => s.user?.permissions ?? []);
}

export function useIsSuperAdmin(): boolean {
  return useAuthStore((s) => s.isSuperAdmin);
}

export function userHasPermission(permissions: string[], required: string): boolean {
  return serverHasPermission(permissions, required);
}

/**
 * Returns true when the current user has the named permission, or is a super
 * admin (super admins bypass all tenant-level RBAC for visibility).
 */
export function useHasPermission(required: string): boolean {
  const permissions = useUserPermissions();
  const isSuperAdmin = useIsSuperAdmin();
  if (isSuperAdmin) return true;
  return userHasPermission(permissions, required);
}

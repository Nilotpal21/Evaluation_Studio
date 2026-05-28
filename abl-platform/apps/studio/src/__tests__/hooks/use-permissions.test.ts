import { describe, it, expect } from 'vitest';
import { userHasPermission } from '../../hooks/usePermissions';

describe('userHasPermission', () => {
  it('returns false for an empty permissions array', () => {
    expect(userHasPermission([], 'billing:read')).toBe(false);
  });

  it('returns true when the exact permission is granted', () => {
    expect(userHasPermission(['billing:read'], 'billing:read')).toBe(true);
  });

  it('returns true when a resource wildcard covers the required permission', () => {
    expect(userHasPermission(['tenant:*'], 'tenant:manage_members')).toBe(true);
    expect(userHasPermission(['tenant:*'], 'tenant:read')).toBe(true);
  });

  it('returns true for the platform-wide *:* grant (tenant OWNER role)', () => {
    // OWNER resolves to ['*:*'] server-side — the front-end gate must not
    // hide admin UI from owners just because they are not super-admins.
    expect(userHasPermission(['*:*'], 'billing:read')).toBe(true);
    expect(userHasPermission(['*:*'], 'tenant:manage_members')).toBe(true);
    expect(userHasPermission(['*:*'], 'project:create')).toBe(true);
  });

  it('does not treat a non-wildcard prefix as a wildcard', () => {
    expect(userHasPermission(['tenant:read'], 'tenant:manage_members')).toBe(false);
  });

  it('does not let a resource wildcard cross resources', () => {
    expect(userHasPermission(['tenant:*'], 'project:read')).toBe(false);
  });

  it('returns false when no granted permission matches', () => {
    expect(userHasPermission(['project:read', 'tool:read'], 'billing:read')).toBe(false);
  });
});

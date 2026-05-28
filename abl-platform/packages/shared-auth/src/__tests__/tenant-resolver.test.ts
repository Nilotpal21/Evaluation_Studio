/**
 * Centralized Tenant Resolver Tests (Sprint 1 — Task 1.2)
 *
 * Tests for the new resolveTenantContext() function extracted into shared-auth.
 * This replaces the duplicate resolveWSTenantContext() in handler.ts by providing
 * a single resolution path shared across REST, WS debug, and SDK channels.
 *
 * The function encapsulates: userId → tenant membership → permission resolution → TenantContextData.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

interface TenantResolutionInput {
  userId: string;
  tenantIdHint?: string;
  authType: 'user' | 'sdk_session' | 'api_key';
}

interface TenantResolutionDeps {
  resolveTenantMembership: (
    userId: string,
    tenantId: string,
  ) => Promise<{ role: string; customRoleId?: string | null; orgId?: string } | null>;
  resolveDefaultTenant: (userId: string) => Promise<{
    tenantId: string;
    role: string;
    customRoleId?: string | null;
    orgId?: string;
  } | null>;
  resolveEffectivePermissions: (
    tenantId: string,
    userId: string,
    role: string,
    customRoleId?: string | null,
  ) => Promise<string[]>;
  superAdminUserIds?: string[];
}

// ---------------------------------------------------------------------------
// Dynamic import — will fail until implementation exists
// ---------------------------------------------------------------------------

async function getResolveTenantContext() {
  try {
    const mod = await import('../services/tenant-resolver.js');
    return mod.resolveTenantContext as (
      input: TenantResolutionInput,
      deps: TenantResolutionDeps,
    ) => Promise<import('../types/index.js').TenantContextData>;
  } catch {
    throw new Error(
      'resolveTenantContext is not available from ../services/tenant-resolver.js. ' +
        'Implement Task 1.2 to make these tests pass.',
    );
  }
}

// ---------------------------------------------------------------------------
// Mock dependencies
// ---------------------------------------------------------------------------

function makeDeps(overrides: Partial<TenantResolutionDeps> = {}): TenantResolutionDeps {
  return {
    resolveTenantMembership: vi.fn(async () => ({
      role: 'ADMIN',
      customRoleId: null,
      orgId: 'org-1',
    })),
    resolveDefaultTenant: vi.fn(async () => ({
      tenantId: 'default-tenant',
      role: 'MEMBER',
      customRoleId: null,
      orgId: 'org-default',
    })),
    resolveEffectivePermissions: vi.fn(async () => ['agent:read', 'agent:execute']),
    superAdminUserIds: [],
    ...overrides,
  };
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('resolveTenantContext', () => {
  let resolveTenantContext: Awaited<ReturnType<typeof getResolveTenantContext>>;

  beforeEach(async () => {
    resolveTenantContext = await getResolveTenantContext();
  });

  describe('with explicit tenantIdHint', () => {
    it('resolves tenant context when user has membership', async () => {
      const deps = makeDeps();

      const result = await resolveTenantContext(
        { userId: 'user-1', tenantIdHint: 'tenant-1', authType: 'user' },
        deps,
      );

      expect(result.tenantId).toBe('tenant-1');
      expect(result.userId).toBe('user-1');
      expect(result.role).toBe('ADMIN');
      expect(result.authType).toBe('user');
      expect(result.isSuperAdmin).toBe(false);
      expect(result.permissions).toEqual(['agent:read', 'agent:execute']);
      expect(deps.resolveTenantMembership).toHaveBeenCalledWith('user-1', 'tenant-1');
      expect(deps.resolveDefaultTenant).not.toHaveBeenCalled();
    });

    it('throws when user has no membership in the hinted tenant', async () => {
      const deps = makeDeps({
        resolveTenantMembership: vi.fn(async () => null),
      });

      await expect(
        resolveTenantContext(
          { userId: 'user-1', tenantIdHint: 'tenant-other', authType: 'user' },
          deps,
        ),
      ).rejects.toThrow();
    });

    it('sets orgId from membership', async () => {
      const deps = makeDeps({
        resolveTenantMembership: vi.fn(async () => ({
          role: 'ADMIN',
          customRoleId: null,
          orgId: 'org-abc',
        })),
      });

      const result = await resolveTenantContext(
        { userId: 'user-1', tenantIdHint: 'tenant-1', authType: 'user' },
        deps,
      );

      expect(result.orgId).toBe('org-abc');
    });

    it('passes customRoleId to permission resolver', async () => {
      const deps = makeDeps({
        resolveTenantMembership: vi.fn(async () => ({
          role: 'CUSTOM',
          customRoleId: 'custom-role-123',
        })),
      });

      await resolveTenantContext(
        { userId: 'user-1', tenantIdHint: 'tenant-1', authType: 'user' },
        deps,
      );

      expect(deps.resolveEffectivePermissions).toHaveBeenCalledWith(
        'tenant-1',
        'user-1',
        'CUSTOM',
        'custom-role-123',
      );
    });
  });

  describe('without tenantIdHint (default tenant)', () => {
    it('resolves default tenant when no hint provided', async () => {
      const deps = makeDeps();

      const result = await resolveTenantContext({ userId: 'user-1', authType: 'user' }, deps);

      expect(result.tenantId).toBe('default-tenant');
      expect(result.role).toBe('MEMBER');
      expect(deps.resolveDefaultTenant).toHaveBeenCalledWith('user-1');
      expect(deps.resolveTenantMembership).not.toHaveBeenCalled();
    });

    it('throws when user has no default tenant', async () => {
      const deps = makeDeps({
        resolveDefaultTenant: vi.fn(async () => null),
      });

      await expect(
        resolveTenantContext({ userId: 'orphan-user', authType: 'user' }, deps),
      ).rejects.toThrow();
    });
  });

  describe('super admin', () => {
    it('sets isSuperAdmin when userId is in superAdminUserIds', async () => {
      const deps = makeDeps({ superAdminUserIds: ['super-user-1'] });

      const result = await resolveTenantContext(
        { userId: 'super-user-1', tenantIdHint: 'tenant-1', authType: 'user' },
        deps,
      );

      expect(result.isSuperAdmin).toBe(true);
    });

    it('sets isSuperAdmin false for normal users', async () => {
      const deps = makeDeps({ superAdminUserIds: ['super-user-1'] });

      const result = await resolveTenantContext(
        { userId: 'normal-user', tenantIdHint: 'tenant-1', authType: 'user' },
        deps,
      );

      expect(result.isSuperAdmin).toBe(false);
    });
  });

  describe('authType propagation', () => {
    it('propagates user authType', async () => {
      const result = await resolveTenantContext(
        { userId: 'user-1', tenantIdHint: 'tenant-1', authType: 'user' },
        makeDeps(),
      );
      expect(result.authType).toBe('user');
    });

    it('propagates sdk_session authType', async () => {
      const result = await resolveTenantContext(
        { userId: 'user-1', tenantIdHint: 'tenant-1', authType: 'sdk_session' },
        makeDeps(),
      );
      expect(result.authType).toBe('sdk_session');
    });

    it('propagates api_key authType', async () => {
      const result = await resolveTenantContext(
        { userId: 'user-1', tenantIdHint: 'tenant-1', authType: 'api_key' },
        makeDeps(),
      );
      expect(result.authType).toBe('api_key');
    });
  });

  describe('error handling', () => {
    it('throws with descriptive error when membership lookup fails', async () => {
      const deps = makeDeps({
        resolveTenantMembership: vi.fn(async () => {
          throw new Error('DB connection lost');
        }),
      });

      await expect(
        resolveTenantContext(
          { userId: 'user-1', tenantIdHint: 'tenant-1', authType: 'user' },
          deps,
        ),
      ).rejects.toThrow();
    });

    it('throws with descriptive error when permission resolution fails', async () => {
      const deps = makeDeps({
        resolveEffectivePermissions: vi.fn(async () => {
          throw new Error('Permission service unavailable');
        }),
      });

      await expect(
        resolveTenantContext(
          { userId: 'user-1', tenantIdHint: 'tenant-1', authType: 'user' },
          deps,
        ),
      ).rejects.toThrow();
    });
  });
});

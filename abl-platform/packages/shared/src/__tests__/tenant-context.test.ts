/**
 * Tenant Context (AsyncLocalStorage) Tests
 *
 * Tests runWithTenantContext, getCurrentTenantId, getCurrentUserId,
 * isSuperAdminContext, and getTenantContextData.
 */

import { describe, it, expect } from 'vitest';
import {
  runWithTenantContext,
  getCurrentTenantId,
  getCurrentUserId,
  isSuperAdminContext,
  getTenantContextData,
} from '../middleware/tenant-context.js';
import type { TenantContextData } from '../types/index.js';

function createContext(overrides: Partial<TenantContextData> = {}): TenantContextData {
  return {
    tenantId: 'tenant1',
    userId: 'user1',
    role: 'ADMIN',
    permissions: ['project:read'],
    authType: 'user',
    isSuperAdmin: false,
    ...overrides,
  };
}

describe('runWithTenantContext', () => {
  it('should make context available within the callback', () => {
    const ctx = createContext();
    const result = runWithTenantContext(ctx, () => {
      return getCurrentTenantId();
    });
    expect(result).toBe('tenant1');
  });

  it('should return the callback return value', () => {
    const ctx = createContext();
    const result = runWithTenantContext(ctx, () => 42);
    expect(result).toBe(42);
  });
});

describe('getCurrentTenantId', () => {
  it('should return undefined outside of tenant context', () => {
    expect(getCurrentTenantId()).toBeUndefined();
  });

  it('should return tenantId inside tenant context', () => {
    const ctx = createContext({ tenantId: 'my-tenant' });
    runWithTenantContext(ctx, () => {
      expect(getCurrentTenantId()).toBe('my-tenant');
    });
  });
});

describe('getCurrentUserId', () => {
  it('should return undefined outside of tenant context', () => {
    expect(getCurrentUserId()).toBeUndefined();
  });

  it('should return userId inside tenant context', () => {
    const ctx = createContext({ userId: 'my-user' });
    runWithTenantContext(ctx, () => {
      expect(getCurrentUserId()).toBe('my-user');
    });
  });
});

describe('isSuperAdminContext', () => {
  it('should return false outside of tenant context', () => {
    expect(isSuperAdminContext()).toBe(false);
  });

  it('should return false when isSuperAdmin is false', () => {
    const ctx = createContext({ isSuperAdmin: false });
    runWithTenantContext(ctx, () => {
      expect(isSuperAdminContext()).toBe(false);
    });
  });

  it('should return true when isSuperAdmin is true', () => {
    const ctx = createContext({ isSuperAdmin: true });
    runWithTenantContext(ctx, () => {
      expect(isSuperAdminContext()).toBe(true);
    });
  });
});

describe('getTenantContextData', () => {
  it('should return undefined outside of tenant context', () => {
    expect(getTenantContextData()).toBeUndefined();
  });

  it('should return full context data inside tenant context', () => {
    const ctx = createContext({ tenantId: 'test-tenant', userId: 'test-user' });
    runWithTenantContext(ctx, () => {
      const data = getTenantContextData();
      expect(data).toBeDefined();
      expect(data!.tenantId).toBe('test-tenant');
      expect(data!.userId).toBe('test-user');
      expect(data!.role).toBe('ADMIN');
    });
  });
});

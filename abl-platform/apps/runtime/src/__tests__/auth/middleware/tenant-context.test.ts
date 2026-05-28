/**
 * Tenant Context Tests
 *
 * Covers AsyncLocalStorage-based tenant context propagation:
 * runWithTenantContext, getCurrentTenantId, getCurrentUserId,
 * isSuperAdminContext, getTenantContextData.
 */

import { describe, test, expect } from 'vitest';
import {
  runWithTenantContext,
  getCurrentTenantId,
  getCurrentUserId,
  isSuperAdminContext,
  getTenantContextData,
} from '@agent-platform/shared';

describe('Tenant Context (AsyncLocalStorage)', () => {
  // ---------------------------------------------------------------------------
  // Outside context — all accessors return undefined/false
  // ---------------------------------------------------------------------------

  describe('outside tenant context', () => {
    test('getCurrentTenantId returns undefined', () => {
      expect(getCurrentTenantId()).toBeUndefined();
    });

    test('getCurrentUserId returns undefined', () => {
      expect(getCurrentUserId()).toBeUndefined();
    });

    test('isSuperAdminContext returns false', () => {
      expect(isSuperAdminContext()).toBe(false);
    });

    test('getTenantContextData returns undefined', () => {
      expect(getTenantContextData()).toBeUndefined();
    });
  });

  // ---------------------------------------------------------------------------
  // Inside context — accessors return correct values
  // ---------------------------------------------------------------------------

  describe('inside tenant context', () => {
    test('getCurrentTenantId returns the tenant ID', () => {
      runWithTenantContext({ tenantId: 'tenant_1', userId: 'user_1' }, () => {
        expect(getCurrentTenantId()).toBe('tenant_1');
      });
    });

    test('getCurrentUserId returns the user ID', () => {
      runWithTenantContext({ tenantId: 'tenant_1', userId: 'user_42' }, () => {
        expect(getCurrentUserId()).toBe('user_42');
      });
    });

    test('isSuperAdminContext returns true when isSuperAdmin is set', () => {
      runWithTenantContext({ tenantId: 't1', userId: 'u1', isSuperAdmin: true }, () => {
        expect(isSuperAdminContext()).toBe(true);
      });
    });

    test('isSuperAdminContext returns false when isSuperAdmin is not set', () => {
      runWithTenantContext({ tenantId: 't1', userId: 'u1' }, () => {
        expect(isSuperAdminContext()).toBe(false);
      });
    });

    test('getTenantContextData returns the full context object', () => {
      const ctx = { tenantId: 'tenant_1', userId: 'user_1', isSuperAdmin: false };
      runWithTenantContext(ctx, () => {
        const data = getTenantContextData();
        expect(data).toBeDefined();
        expect(data!.tenantId).toBe('tenant_1');
        expect(data!.userId).toBe('user_1');
        expect(data!.isSuperAdmin).toBe(false);
      });
    });
  });

  // ---------------------------------------------------------------------------
  // Nesting and isolation
  // ---------------------------------------------------------------------------

  describe('nesting and isolation', () => {
    test('nested context overrides outer context', () => {
      runWithTenantContext({ tenantId: 'outer', userId: 'u1' }, () => {
        expect(getCurrentTenantId()).toBe('outer');

        runWithTenantContext({ tenantId: 'inner', userId: 'u2' }, () => {
          expect(getCurrentTenantId()).toBe('inner');
          expect(getCurrentUserId()).toBe('u2');
        });

        // After inner exits, outer context is restored
        expect(getCurrentTenantId()).toBe('outer');
        expect(getCurrentUserId()).toBe('u1');
      });
    });

    test('context does not leak between sequential runs', () => {
      runWithTenantContext({ tenantId: 'first', userId: 'u1' }, () => {
        expect(getCurrentTenantId()).toBe('first');
      });

      // After the run, context is gone
      expect(getCurrentTenantId()).toBeUndefined();

      runWithTenantContext({ tenantId: 'second', userId: 'u2' }, () => {
        expect(getCurrentTenantId()).toBe('second');
      });
    });

    test('async operations within context preserve tenant data', async () => {
      await new Promise<void>((resolve) => {
        runWithTenantContext({ tenantId: 'async_tenant', userId: 'u1' }, () => {
          setTimeout(() => {
            expect(getCurrentTenantId()).toBe('async_tenant');
            resolve();
          }, 10);
        });
      });
    });
  });

  // ---------------------------------------------------------------------------
  // Return value passthrough
  // ---------------------------------------------------------------------------

  describe('return value', () => {
    test('runWithTenantContext passes through the return value', () => {
      const result = runWithTenantContext({ tenantId: 't1', userId: 'u1' }, () => {
        return 42;
      });
      expect(result).toBe(42);
    });

    test('runWithTenantContext passes through string return', () => {
      const result = runWithTenantContext({ tenantId: 't1', userId: 'u1' }, () => 'hello');
      expect(result).toBe('hello');
    });

    test('runWithTenantContext passes through object return', () => {
      const result = runWithTenantContext({ tenantId: 't1', userId: 'u1' }, () => ({ key: 'val' }));
      expect(result).toEqual({ key: 'val' });
    });
  });
});

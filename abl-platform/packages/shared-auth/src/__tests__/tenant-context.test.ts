import { describe, it, expect } from 'vitest';
import type { TenantContextData } from '../types/index.js';
import {
  runWithTenantContext,
  getCurrentTenantId,
  getCurrentUserId,
  isSuperAdminContext,
  getTenantContextData,
} from '../middleware/tenant-context.js';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeContext(overrides: Partial<TenantContextData> = {}): TenantContextData {
  return {
    tenantId: 'tenant-1',
    userId: 'user-1',
    role: 'ADMIN',
    permissions: ['agent:read'],
    authType: 'user',
    isSuperAdmin: false,
    ...overrides,
  };
}

// ---------------------------------------------------------------------------
// runWithTenantContext
// ---------------------------------------------------------------------------

describe('runWithTenantContext', () => {
  it('executes a synchronous function within context', () => {
    const ctx = makeContext();
    const result = runWithTenantContext(ctx, () => {
      return getCurrentTenantId();
    });
    expect(result).toBe('tenant-1');
  });

  it('executes an async function within context', async () => {
    const ctx = makeContext({ tenantId: 'tenant-async' });
    const result = await runWithTenantContext(ctx, async () => {
      // Simulate async work
      await new Promise((resolve) => setTimeout(resolve, 1));
      return getCurrentTenantId();
    });
    expect(result).toBe('tenant-async');
  });

  it('nested contexts override the outer context', () => {
    const outerCtx = makeContext({ tenantId: 'outer' });
    const innerCtx = makeContext({ tenantId: 'inner' });

    runWithTenantContext(outerCtx, () => {
      expect(getCurrentTenantId()).toBe('outer');
      runWithTenantContext(innerCtx, () => {
        expect(getCurrentTenantId()).toBe('inner');
      });
      // Back to outer after inner exits
      expect(getCurrentTenantId()).toBe('outer');
    });
  });

  it('maintains isolation across parallel promises', async () => {
    const results = await Promise.all([
      runWithTenantContext(makeContext({ tenantId: 'parallel-a' }), async () => {
        await new Promise((resolve) => setTimeout(resolve, 5));
        return getCurrentTenantId();
      }),
      runWithTenantContext(makeContext({ tenantId: 'parallel-b' }), async () => {
        await new Promise((resolve) => setTimeout(resolve, 1));
        return getCurrentTenantId();
      }),
    ]);

    expect(results).toEqual(['parallel-a', 'parallel-b']);
  });

  it('returns the function result', () => {
    const ctx = makeContext();
    const result = runWithTenantContext(ctx, () => 42);
    expect(result).toBe(42);
  });

  it('propagates exceptions from the callback', () => {
    const ctx = makeContext();
    expect(() => {
      runWithTenantContext(ctx, () => {
        throw new Error('kaboom');
      });
    }).toThrow('kaboom');
  });
});

// ---------------------------------------------------------------------------
// getCurrentTenantId
// ---------------------------------------------------------------------------

describe('getCurrentTenantId', () => {
  it('returns tenantId when inside a context', () => {
    const ctx = makeContext({ tenantId: 'tenant-abc' });
    runWithTenantContext(ctx, () => {
      expect(getCurrentTenantId()).toBe('tenant-abc');
    });
  });

  it('returns undefined when outside a context', () => {
    expect(getCurrentTenantId()).toBeUndefined();
  });
});

// ---------------------------------------------------------------------------
// getCurrentUserId
// ---------------------------------------------------------------------------

describe('getCurrentUserId', () => {
  it('returns userId when inside a context', () => {
    const ctx = makeContext({ userId: 'user-xyz' });
    runWithTenantContext(ctx, () => {
      expect(getCurrentUserId()).toBe('user-xyz');
    });
  });

  it('returns undefined when outside a context', () => {
    expect(getCurrentUserId()).toBeUndefined();
  });
});

// ---------------------------------------------------------------------------
// isSuperAdminContext
// ---------------------------------------------------------------------------

describe('isSuperAdminContext', () => {
  it('returns true when isSuperAdmin is true', () => {
    const ctx = makeContext({ isSuperAdmin: true });
    runWithTenantContext(ctx, () => {
      expect(isSuperAdminContext()).toBe(true);
    });
  });

  it('returns false when isSuperAdmin is false', () => {
    const ctx = makeContext({ isSuperAdmin: false });
    runWithTenantContext(ctx, () => {
      expect(isSuperAdminContext()).toBe(false);
    });
  });

  it('returns false when outside a context', () => {
    expect(isSuperAdminContext()).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// getTenantContextData
// ---------------------------------------------------------------------------

describe('getTenantContextData', () => {
  it('returns full context data when inside a context', () => {
    const ctx = makeContext({ tenantId: 'tenant-full', userId: 'user-full', role: 'VIEWER' });
    runWithTenantContext(ctx, () => {
      const data = getTenantContextData();
      expect(data).toBeDefined();
      expect(data!.tenantId).toBe('tenant-full');
      expect(data!.userId).toBe('user-full');
      expect(data!.role).toBe('VIEWER');
      expect(data!.authType).toBe('user');
      expect(data!.permissions).toEqual(['agent:read']);
    });
  });

  it('returns undefined when outside a context', () => {
    expect(getTenantContextData()).toBeUndefined();
  });
});

/**
 * Per-Tenant Retention Cleanup Tests
 *
 * Verifies that the session cleanup job uses per-tenant retention from
 * TenantConfigService instead of a single global TTL:
 *
 * 1. Uses per-tenant retention from TenantConfigService (not global)
 * 2. Skips tenants with unlimited retention (-1)
 * 3. Different tenants get different cutoff dates
 * 4. Falls back to TEAM plan defaults on config failure
 * 5. Falls back to legacy global cleanup when getDistinctTenantIds fails
 * 6. Global message cleanup still works as before
 * 7. Passes canonical terminal statuses to session and message cleanup queries
 * 8. Passes tenantId to deleteSessionsByIds for tenant-scoped deletion
 *
 * Unit-level tests — no Redis or MongoDB required.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

// ---------------------------------------------------------------------------
// Mocks — must be declared before importing the module under test
// ---------------------------------------------------------------------------

const mockGetConfigAsync = vi.fn();

vi.mock('../../services/tenant-config.js', () => ({
  getTenantConfigService: () => ({
    getConfigAsync: mockGetConfigAsync,
  }),
  PLAN_LIMITS: {
    FREE: {
      sessionRetentionDays: 7,
      traceRetentionDays: 7,
      messageRetentionDays: 30,
    },
    TEAM: {
      sessionRetentionDays: 30,
      traceRetentionDays: 30,
      messageRetentionDays: 90,
    },
  },
  DEFAULT_SECURITY: {
    FREE: {
      sessionIdleSeconds: 600,
      sessionMaxAgeSeconds: 3_600,
    },
    TEAM: {
      sessionIdleSeconds: 1_800,
      sessionMaxAgeSeconds: 28_800,
    },
  },
}));

// Mock DB availability
const mockIsDatabaseAvailable = vi.fn().mockReturnValue(true);

vi.mock('../../db/index.js', () => ({
  isDatabaseAvailable: () => mockIsDatabaseAvailable(),
}));

// Keep the cleanup job on the unit-test path without real Redis coordination.
vi.mock('../../services/redis/redis-client.js', () => ({
  getRedisClient: () => null,
  getRedisHandle: () => null,
}));

// Mock session-repo functions
const mockFindOldSessions = vi.fn().mockResolvedValue([]);
const mockFindOldSessionsByTenant = vi.fn().mockResolvedValue([]);
const mockGetDistinctTenantIds = vi.fn().mockResolvedValue([]);
const mockDeleteSessionsByIds = vi.fn().mockResolvedValue(0);
const mockDeleteOldMessages = vi.fn().mockResolvedValue(0);
const mockFindSessionById = vi.fn().mockResolvedValue(null);
const mockFindSessionByRuntimeId = vi.fn().mockResolvedValue(null);
const mockUpdateSession = vi.fn().mockResolvedValue(null);

vi.mock('../../repos/session-repo.js', () => ({
  findOldSessions: (...args: unknown[]) => mockFindOldSessions(...args),
  findOldSessionsByTenant: (...args: unknown[]) => mockFindOldSessionsByTenant(...args),
  getDistinctTenantIds: () => mockGetDistinctTenantIds(),
  deleteSessionsByIds: (...args: unknown[]) => mockDeleteSessionsByIds(...args),
  deleteSessionsByIdsSystem: (...args: unknown[]) => mockDeleteSessionsByIds(...args),
  deleteOldMessages: (...args: unknown[]) => mockDeleteOldMessages(...args),
  findSessionById: (...args: unknown[]) => mockFindSessionById(...args),
  findSessionByRuntimeId: (...args: unknown[]) => mockFindSessionByRuntimeId(...args),
  updateSession: (...args: unknown[]) => mockUpdateSession(...args),
}));

// Mock @abl/compiler/platform logger while preserving other platform exports
vi.mock('@abl/compiler/platform', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@abl/compiler/platform')>();
  return {
    ...actual,
    createLogger: () => ({
      info: vi.fn(),
      warn: vi.fn(),
      error: vi.fn(),
      debug: vi.fn(),
    }),
  };
});

// Mock @agent-platform/database/models for Pass 2 (markTimedOutSessions)
const mockSessionFind = vi.fn();
const mockSessionBulkWrite = vi.fn().mockResolvedValue({ modifiedCount: 1 });

vi.mock('@agent-platform/database/models', () => ({
  Session: {
    find: (...args: unknown[]) => mockSessionFind(...args),
    bulkWrite: (...args: unknown[]) => mockSessionBulkWrite(...args),
  },
  Message: {},
}));

// Import after mocks
import {
  startSessionCleanupJob,
  stopSessionCleanupJob,
} from '../../services/session-cleanup-job.js';
import type { TenantConfig } from '../../services/tenant-config.js';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function buildTenantConfig(
  tenantId: string,
  plan: 'FREE' | 'TEAM' | 'BUSINESS' | 'ENTERPRISE',
  overrides?: Partial<TenantConfig['limits']>,
): TenantConfig {
  const planLimits: Record<string, TenantConfig['limits']> = {
    FREE: {
      maxConcurrentSessions: 10,
      maxServiceTimeoutMs: 10_000,
      maxResponseBodyBytes: 524_288,
      maxConcurrentServiceCalls: 3,
      maxPendingTimers: 100,
      maxAgentsPerProject: 3,
      maxEventTypesPerApp: 10,
      maxProjectsPerOrg: 3,
      requestsPerMinute: 60,
      tokensPerMinute: 50_000,
      toolCallsPerMinute: 30,
      messagesPerMonth: 1_000,
      traceRetentionDays: 7,
      sessionRetentionDays: 7,
      auditLogRetentionDays: 30,

      messageRetentionDays: 30,
    },
    TEAM: {
      maxConcurrentSessions: 50,
      maxServiceTimeoutMs: 30_000,
      maxResponseBodyBytes: 2_097_152,
      maxConcurrentServiceCalls: 10,
      maxPendingTimers: 1_000,
      maxAgentsPerProject: 20,
      maxEventTypesPerApp: 50,
      maxProjectsPerOrg: 20,
      requestsPerMinute: 300,
      tokensPerMinute: 200_000,
      toolCallsPerMinute: 100,
      messagesPerMonth: 50_000,
      traceRetentionDays: 30,
      sessionRetentionDays: 30,
      auditLogRetentionDays: 90,

      messageRetentionDays: 90,
    },
    BUSINESS: {
      maxConcurrentSessions: 500,
      maxServiceTimeoutMs: 45_000,
      maxResponseBodyBytes: 5_242_880,
      maxConcurrentServiceCalls: 25,
      maxPendingTimers: 10_000,
      maxAgentsPerProject: 100,
      maxEventTypesPerApp: 100,
      maxProjectsPerOrg: 100,
      requestsPerMinute: 1_000,
      tokensPerMinute: 500_000,
      toolCallsPerMinute: 300,
      messagesPerMonth: 500_000,
      traceRetentionDays: 90,
      sessionRetentionDays: 90,
      auditLogRetentionDays: 365,

      messageRetentionDays: 365,
    },
    ENTERPRISE: {
      maxConcurrentSessions: -1,
      maxServiceTimeoutMs: 60_000,
      maxResponseBodyBytes: 10_485_760,
      maxConcurrentServiceCalls: 50,
      maxPendingTimers: 100_000,
      maxAgentsPerProject: -1,
      maxEventTypesPerApp: 200,
      maxProjectsPerOrg: -1,
      requestsPerMinute: -1,
      tokensPerMinute: -1,
      toolCallsPerMinute: -1,
      messagesPerMonth: -1,
      traceRetentionDays: 365,
      sessionRetentionDays: 365,
      auditLogRetentionDays: 2_555,

      messageRetentionDays: 730,
    },
  };

  const planSecurity: Record<string, TenantConfig['security']> = {
    FREE: {
      sessionMaxAgeSeconds: 3_600,
      sessionIdleSeconds: 600,
      requireMfa: false,
      scrubPII: false,
    },
    TEAM: {
      sessionMaxAgeSeconds: 28_800,
      sessionIdleSeconds: 1_800,
      requireMfa: false,
      scrubPII: false,
    },
    BUSINESS: {
      sessionMaxAgeSeconds: 28_800,
      sessionIdleSeconds: 3_600,
      requireMfa: true,
      scrubPII: true,
    },
    ENTERPRISE: {
      sessionMaxAgeSeconds: 86_400,
      sessionIdleSeconds: 7_200,
      requireMfa: true,
      scrubPII: true,
    },
  };

  return {
    tenantId,
    plan,
    limits: { ...planLimits[plan], ...overrides },
    features: {} as TenantConfig['features'],
    security: planSecurity[plan],
  };
}

/**
 * Start the cleanup job, wait for the initial run to complete, then stop it.
 * Uses a short interval so we don't need to wait long.
 */
async function runCleanupOnce(config?: {
  sessionTtlHours?: number;
  messageTtlHours?: number;
}): Promise<void> {
  const cleanupConfig = {
    sessionTtlHours: config?.sessionTtlHours ?? 168, // 7 days default
    messageTtlHours: config?.messageTtlHours ?? 168,
    intervalMinutes: 9999, // Very long interval so only initial run fires
  };

  startSessionCleanupJob(cleanupConfig);

  await waitForCleanupToSettle();

  stopSessionCleanupJob();
}

async function waitForCleanupToSettle(): Promise<void> {
  const getActivitySignature = () =>
    [
      mockGetDistinctTenantIds.mock.calls.length,
      mockGetConfigAsync.mock.calls.length,
      mockFindOldSessions.mock.calls.length,
      mockFindOldSessionsByTenant.mock.calls.length,
      mockDeleteSessionsByIds.mock.calls.length,
      mockDeleteOldMessages.mock.calls.length,
      mockSessionFind.mock.calls.length,
      mockSessionBulkWrite.mock.calls.length,
    ].join(':');

  const noActivitySignature = '0:0:0:0:0:0:0:0';
  const pollIntervalMs = 20;
  const requiredStablePolls = 2;
  const deadlineMs = Date.now() + 2_000;

  let previousSignature = getActivitySignature();
  let sawActivity = previousSignature !== noActivitySignature;
  let stablePolls = 0;

  while (Date.now() < deadlineMs) {
    await new Promise((resolve) => setTimeout(resolve, pollIntervalMs));

    const currentSignature = getActivitySignature();
    if (currentSignature !== noActivitySignature) {
      sawActivity = true;
    }

    if (!sawActivity) {
      previousSignature = currentSignature;
      continue;
    }

    if (currentSignature === previousSignature) {
      stablePolls += 1;
      if (stablePolls >= requiredStablePolls) {
        return;
      }
    } else {
      stablePolls = 0;
      previousSignature = currentSignature;
    }
  }

  throw new Error('Timed out waiting for the session cleanup run to settle.');
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('Per-Tenant Retention Cleanup', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockIsDatabaseAvailable.mockReturnValue(true);
    delete process.env.SESSION_TERMINALIZATION_ENABLED;
    // Ensure cleanup timer is cleared between tests
    stopSessionCleanupJob();
  });

  afterEach(() => {
    stopSessionCleanupJob();
    vi.restoreAllMocks();
  });

  // -------------------------------------------------------------------------
  // 1. Uses per-tenant retention from TenantConfigService
  // -------------------------------------------------------------------------

  describe('per-tenant retention from TenantConfigService', () => {
    it('calls getDistinctTenantIds to iterate tenants', async () => {
      mockGetDistinctTenantIds.mockResolvedValue(['tenant-a']);
      mockGetConfigAsync.mockResolvedValue(buildTenantConfig('tenant-a', 'FREE'));
      mockFindOldSessionsByTenant.mockResolvedValue([]);

      await runCleanupOnce();

      expect(mockGetDistinctTenantIds).toHaveBeenCalled();
    });

    it('resolves retention per-tenant via getConfigAsync', async () => {
      mockGetDistinctTenantIds.mockResolvedValue(['tenant-team']);
      mockGetConfigAsync.mockResolvedValue(buildTenantConfig('tenant-team', 'TEAM'));
      mockFindOldSessionsByTenant.mockResolvedValue([]);

      await runCleanupOnce();

      expect(mockGetConfigAsync).toHaveBeenCalledWith('tenant-team');
    });

    it('uses findOldSessionsByTenant (not findOldSessions) for per-tenant queries', async () => {
      mockGetDistinctTenantIds.mockResolvedValue(['tenant-a']);
      mockGetConfigAsync.mockResolvedValue(buildTenantConfig('tenant-a', 'FREE'));
      mockFindOldSessionsByTenant.mockResolvedValue([]);

      await runCleanupOnce();

      expect(mockFindOldSessionsByTenant).toHaveBeenCalled();
      // The legacy findOldSessions should NOT be called (per-tenant path succeeded)
      expect(mockFindOldSessions).not.toHaveBeenCalled();
    });

    it('passes canonical terminal statuses to per-tenant cleanup queries', async () => {
      mockGetDistinctTenantIds.mockResolvedValue(['tenant-a']);
      mockGetConfigAsync.mockResolvedValue(buildTenantConfig('tenant-a', 'FREE'));
      mockFindOldSessionsByTenant.mockResolvedValue([]);

      await runCleanupOnce();

      const [, , statuses] = mockFindOldSessionsByTenant.mock.calls[0];
      expect(statuses).toEqual(['completed', 'ended', 'escalated', 'abandoned', 'error']);
    });
  });

  // -------------------------------------------------------------------------
  // 2. Skips tenants with unlimited retention (-1)
  // -------------------------------------------------------------------------

  describe('unlimited retention skip', () => {
    it('skips tenants with unlimited (-1) sessionRetentionDays', async () => {
      mockGetDistinctTenantIds.mockResolvedValue(['ent-tenant']);
      // ENTERPRISE sessionRetentionDays = 365, but let's override to -1 for unlimited
      mockGetConfigAsync.mockResolvedValue(
        buildTenantConfig('ent-tenant', 'ENTERPRISE', { sessionRetentionDays: -1 }),
      );

      await runCleanupOnce();

      // Should NOT query for old sessions — retention is unlimited
      expect(mockFindOldSessionsByTenant).not.toHaveBeenCalled();
      expect(mockDeleteSessionsByIds).not.toHaveBeenCalled();
    });
  });

  // -------------------------------------------------------------------------
  // 3. Different tenants get different cutoff dates
  // -------------------------------------------------------------------------

  describe('different cutoffs per tenant', () => {
    it('uses different cutoff dates for FREE (7d) vs BUSINESS (90d) tenants', async () => {
      const now = Date.now();
      vi.spyOn(Date, 'now').mockReturnValue(now);

      mockGetDistinctTenantIds.mockResolvedValue(['tenant-free', 'tenant-biz']);

      mockGetConfigAsync
        .mockResolvedValueOnce(buildTenantConfig('tenant-free', 'FREE'))
        .mockResolvedValueOnce(buildTenantConfig('tenant-biz', 'BUSINESS'));

      mockFindOldSessionsByTenant.mockResolvedValue([]);

      await runCleanupOnce({ sessionTtlHours: 0 }); // 0 = no global safety floor

      // Verify two calls to findOldSessionsByTenant with different cutoffs
      expect(mockFindOldSessionsByTenant).toHaveBeenCalledTimes(2);

      const [firstCall, secondCall] = mockFindOldSessionsByTenant.mock.calls;

      // First call: tenant-free, cutoff = now - 7 days
      expect(firstCall[0]).toBe('tenant-free');
      const freeCutoff = firstCall[1] as Date;
      const expectedFreeCutoffMs = now - 7 * 24 * 60 * 60 * 1000;
      expect(freeCutoff.getTime()).toBe(expectedFreeCutoffMs);

      // Second call: tenant-biz, cutoff = now - 90 days
      expect(secondCall[0]).toBe('tenant-biz');
      const bizCutoff = secondCall[1] as Date;
      const expectedBizCutoffMs = now - 90 * 24 * 60 * 60 * 1000;
      expect(bizCutoff.getTime()).toBe(expectedBizCutoffMs);
    });

    it('deletes sessions and passes tenantId to deleteSessionsByIds', async () => {
      mockGetDistinctTenantIds.mockResolvedValue(['tenant-a']);
      mockGetConfigAsync.mockResolvedValue(buildTenantConfig('tenant-a', 'FREE'));
      mockFindOldSessionsByTenant
        .mockResolvedValueOnce([{ id: 'sess-1' }, { id: 'sess-2' }])
        .mockResolvedValueOnce([]); // second call returns empty to stop batching
      mockDeleteSessionsByIds.mockResolvedValue(2);

      await runCleanupOnce();

      expect(mockDeleteSessionsByIds).toHaveBeenCalledWith(['sess-1', 'sess-2'], 'tenant-a');
    });
  });

  // -------------------------------------------------------------------------
  // 4. Falls back to TEAM plan defaults on config failure
  // -------------------------------------------------------------------------

  describe('config failure fallback', () => {
    it('uses TEAM plan retention (30 days) when getConfigAsync fails for a tenant', async () => {
      const now = Date.now();
      vi.spyOn(Date, 'now').mockReturnValue(now);

      mockGetDistinctTenantIds.mockResolvedValue(['broken-tenant']);
      mockGetConfigAsync.mockRejectedValue(new Error('Redis down'));
      mockFindOldSessionsByTenant.mockResolvedValue([]);

      await runCleanupOnce({ sessionTtlHours: 0 }); // 0 = no global safety floor

      // Should still query using TEAM plan default of 30 days
      expect(mockFindOldSessionsByTenant).toHaveBeenCalledTimes(1);
      const [tenantId, cutoff] = mockFindOldSessionsByTenant.mock.calls[0];
      expect(tenantId).toBe('broken-tenant');

      const expectedCutoffMs = now - 30 * 24 * 60 * 60 * 1000;
      expect((cutoff as Date).getTime()).toBe(expectedCutoffMs);
    });
  });

  // -------------------------------------------------------------------------
  // 5. Falls back to legacy global cleanup when distinct query fails
  // -------------------------------------------------------------------------

  describe('legacy global fallback', () => {
    it('uses legacy findOldSessions when getDistinctTenantIds throws', async () => {
      mockGetDistinctTenantIds.mockRejectedValue(new Error('distinct not supported'));
      mockFindOldSessions.mockResolvedValue([]);

      await runCleanupOnce({ sessionTtlHours: 168 }); // 7 days

      // Legacy path should be used
      expect(mockFindOldSessions).toHaveBeenCalled();
      const [, statuses] = mockFindOldSessions.mock.calls[0];
      expect(statuses).toEqual(['completed', 'ended', 'escalated', 'abandoned', 'error']);
    });
  });

  // -------------------------------------------------------------------------
  // 6. Global message cleanup still works as before
  // -------------------------------------------------------------------------

  describe('global message cleanup', () => {
    it('deletes old messages using global messageTtlHours', async () => {
      const now = Date.now();
      vi.spyOn(Date, 'now').mockReturnValue(now);

      mockGetDistinctTenantIds.mockResolvedValue([]); // no tenants with sessions

      await runCleanupOnce({ messageTtlHours: 336 }); // 14 days

      expect(mockDeleteOldMessages).toHaveBeenCalledTimes(1);
      const [cutoff, statuses] = mockDeleteOldMessages.mock.calls[0];

      const expectedCutoffMs = now - 336 * 60 * 60 * 1000;
      expect((cutoff as Date).getTime()).toBe(expectedCutoffMs);
      expect(statuses).toEqual(['completed', 'ended', 'escalated', 'abandoned', 'error']);
    });

    it('skips message cleanup when messageTtlHours is 0', async () => {
      mockGetDistinctTenantIds.mockResolvedValue([]);

      await runCleanupOnce({ messageTtlHours: 0 });

      expect(mockDeleteOldMessages).not.toHaveBeenCalled();
    });
  });

  // -------------------------------------------------------------------------
  // 7. Global safety floor (Math.min with config.sessionTtlHours)
  // -------------------------------------------------------------------------

  describe('global safety floor', () => {
    it('uses Math.min of plan retention and global TTL as effective cutoff', async () => {
      const now = Date.now();
      vi.spyOn(Date, 'now').mockReturnValue(now);

      mockGetDistinctTenantIds.mockResolvedValue(['tenant-biz']);
      // BUSINESS plan: 90 days = 2160 hours
      mockGetConfigAsync.mockResolvedValue(buildTenantConfig('tenant-biz', 'BUSINESS'));
      mockFindOldSessionsByTenant.mockResolvedValue([]);

      // Global safety floor: 720 hours (30 days) — stricter than BUSINESS 90 days
      await runCleanupOnce({ sessionTtlHours: 720 });

      const [, cutoff] = mockFindOldSessionsByTenant.mock.calls[0];
      // Should use 720 hours (the smaller / more aggressive value)
      const expectedCutoffMs = now - 720 * 60 * 60 * 1000;
      expect((cutoff as Date).getTime()).toBe(expectedCutoffMs);
    });

    it('uses plan retention when global TTL is 0 (disabled safety floor)', async () => {
      const now = Date.now();
      vi.spyOn(Date, 'now').mockReturnValue(now);

      mockGetDistinctTenantIds.mockResolvedValue(['tenant-team']);
      // TEAM plan: 30 days = 720 hours
      mockGetConfigAsync.mockResolvedValue(buildTenantConfig('tenant-team', 'TEAM'));
      mockFindOldSessionsByTenant.mockResolvedValue([]);

      await runCleanupOnce({ sessionTtlHours: 0 });

      const [, cutoff] = mockFindOldSessionsByTenant.mock.calls[0];
      const expectedCutoffMs = now - 30 * 24 * 60 * 60 * 1000;
      expect((cutoff as Date).getTime()).toBe(expectedCutoffMs);
    });
  });

  // -------------------------------------------------------------------------
  // 8. Database unavailable — no-op
  // -------------------------------------------------------------------------

  describe('database unavailable', () => {
    it('no-ops when database is unavailable', async () => {
      mockIsDatabaseAvailable.mockReturnValue(false);

      // startSessionCleanupJob should not start when DB is unavailable
      startSessionCleanupJob({
        sessionTtlHours: 168,
        messageTtlHours: 168,
        intervalMinutes: 9999,
      });

      await new Promise((resolve) => setTimeout(resolve, 50));
      stopSessionCleanupJob();

      expect(mockGetDistinctTenantIds).not.toHaveBeenCalled();
      expect(mockFindOldSessionsByTenant).not.toHaveBeenCalled();
      expect(mockDeleteSessionsByIds).not.toHaveBeenCalled();
    });
  });

  // -------------------------------------------------------------------------
  // 9. Batch processing
  // -------------------------------------------------------------------------

  describe('batch processing', () => {
    it('continues batching until fewer than BATCH_SIZE sessions returned', async () => {
      mockGetDistinctTenantIds.mockResolvedValue(['tenant-a']);
      mockGetConfigAsync.mockResolvedValue(buildTenantConfig('tenant-a', 'FREE'));

      // First batch: 500 sessions (full batch — triggers another)
      const batch1 = Array.from({ length: 500 }, (_, i) => ({ id: `sess-${i}` }));
      // Second batch: 200 sessions (less than 500 — stops)
      const batch2 = Array.from({ length: 200 }, (_, i) => ({ id: `sess-${500 + i}` }));

      mockFindOldSessionsByTenant
        .mockResolvedValueOnce(batch1)
        .mockResolvedValueOnce(batch2)
        .mockResolvedValueOnce([]);

      mockDeleteSessionsByIds.mockResolvedValueOnce(500).mockResolvedValueOnce(200);

      await runCleanupOnce();

      // Two delete calls — one per batch
      expect(mockDeleteSessionsByIds).toHaveBeenCalledTimes(2);
    });
  });

  // -------------------------------------------------------------------------
  // 10. Per-tenant error isolation
  // -------------------------------------------------------------------------

  describe('per-tenant error isolation', () => {
    it('continues to next tenant when one tenant cleanup fails', async () => {
      mockGetDistinctTenantIds.mockResolvedValue(['bad-tenant', 'good-tenant']);

      mockGetConfigAsync
        .mockResolvedValueOnce(buildTenantConfig('bad-tenant', 'FREE'))
        .mockResolvedValueOnce(buildTenantConfig('good-tenant', 'TEAM'));

      // bad-tenant: findOldSessionsByTenant throws
      mockFindOldSessionsByTenant
        .mockRejectedValueOnce(new Error('query timeout'))
        .mockResolvedValueOnce([]); // good-tenant returns empty

      await runCleanupOnce();

      // Should have attempted the second tenant despite first failing
      expect(mockFindOldSessionsByTenant).toHaveBeenCalledTimes(2);
      expect(mockFindOldSessionsByTenant.mock.calls[1][0]).toBe('good-tenant');
    });
  });

  // -------------------------------------------------------------------------
  // 11. Active-session timeout enforcement moved to the timeout sweep job
  // -------------------------------------------------------------------------

  describe('retention cleanup no longer terminalizes active sessions', () => {
    it('does not mark idle sessions with messages during retention cleanup', async () => {
      mockGetDistinctTenantIds.mockResolvedValue(['tenant-a']);
      mockGetConfigAsync.mockResolvedValue(buildTenantConfig('tenant-a', 'FREE'));
      mockFindOldSessionsByTenant.mockResolvedValue([]);

      await runCleanupOnce();

      expect(mockSessionFind).not.toHaveBeenCalled();
      expect(mockSessionBulkWrite).not.toHaveBeenCalled();
    });

    it('does not mark idle sessions with no messages during retention cleanup', async () => {
      mockGetDistinctTenantIds.mockResolvedValue(['tenant-a']);
      mockGetConfigAsync.mockResolvedValue(buildTenantConfig('tenant-a', 'FREE'));
      mockFindOldSessionsByTenant.mockResolvedValue([]);

      await runCleanupOnce();

      expect(mockSessionFind).not.toHaveBeenCalled();
      expect(mockSessionBulkWrite).not.toHaveBeenCalled();
    });

    it('does not execute the active-session timeout pass even with multiple tenants', async () => {
      mockGetDistinctTenantIds.mockResolvedValue(['tenant-a', 'tenant-b']);
      mockGetConfigAsync
        .mockResolvedValueOnce(buildTenantConfig('tenant-a', 'FREE'))
        .mockResolvedValueOnce(buildTenantConfig('tenant-b', 'TEAM'));
      mockFindOldSessionsByTenant.mockResolvedValue([]);

      await expect(runCleanupOnce()).resolves.not.toThrow();

      expect(mockSessionFind).not.toHaveBeenCalled();
      expect(mockSessionBulkWrite).not.toHaveBeenCalled();
    });
  });
});

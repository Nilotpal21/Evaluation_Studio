/**
 * Tests for metricsBuffer size cap (M-2).
 *
 * Verifies that the in-memory metricsBuffer is bounded and evicts
 * oldest entries when at capacity.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('@agent-platform/database/models', () => ({}));

// Mock dependencies before import
vi.mock('../db/index.js', () => ({
  isDatabaseAvailable: vi.fn().mockReturnValue(true),
  requirePrisma: vi.fn(),
}));

vi.mock('../services/stores/store-factory.js', () => ({
  getStores: vi.fn().mockReturnValue({
    message: { create: vi.fn(), batchCreate: vi.fn() },
    conversation: {},
  }),
  DualWriteMessageStore: class {},
}));

vi.mock('../services/tenant-config.js', () => ({
  getTenantConfigService: vi.fn().mockReturnValue({
    getConfigAsync: vi.fn().mockResolvedValue({
      security: { scrubPII: false },
      limits: { messageRetentionDays: 90 },
    }),
    resolveProjectMessageRetention: vi.fn().mockResolvedValue(null),
  }),
  PLAN_LIMITS: { TEAM: { messageRetentionDays: 90 } },
}));

vi.mock('@agent-platform/shared/encryption', () => ({
  isTenantEncryptionReady: () => true,
  encryptForTenantAuto: async (plaintext: string) => plaintext,
  decryptForTenantAuto: async (ciphertext: string) => ciphertext,
  wrapJobDataForEncrypt: async (_purpose: string, data: unknown) => data,
  unwrapJobDataForDecrypt: async (_purpose: string, data: unknown) => data,
}));

vi.mock('../repos/session-repo.js', () => ({
  batchCreateMessages: vi.fn(),
  applySessionTurnUpdate: vi.fn(),
}));

vi.mock('@agent-platform/shared-auth/middleware', () => ({
  runWithTenantContext: (_ctx: any, fn: () => any) => fn(),
  getTenantContextData: () => undefined,
}));

vi.mock('@agent-platform/database/mongo', () => ({
  getCurrentTenantContext: () => undefined,
}));

import {
  persistTurnMetrics,
  _resetForTest,
  _setBullAvailable,
  _getMetricsBufferSize,
  _getMetricsEntry,
  MAX_METRICS_BUFFER,
} from '../services/message-persistence-queue.js';

describe('metricsBuffer size cap (M-2)', () => {
  beforeEach(() => {
    _resetForTest();
    _setBullAvailable(true);
  });

  it('caps metricsBuffer at MAX_METRICS_BUFFER entries', async () => {
    // Fill buffer to capacity
    for (let i = 0; i < MAX_METRICS_BUFFER + 100; i++) {
      await persistTurnMetrics({
        dbSessionId: `session-${i}`,
        tenantId: 'tenant-1',
        tokensIn: 10,
        tokensOut: 5,
        cost: 0.001,
        traceEventCount: 1,
        errorCount: 0,
        handoffCount: 0,
      });
    }

    expect(_getMetricsBufferSize()).toBeLessThanOrEqual(MAX_METRICS_BUFFER);
  });

  it('evicts approximately 10% of entries on overflow', async () => {
    // Fill buffer exactly to capacity
    for (let i = 0; i < MAX_METRICS_BUFFER; i++) {
      await persistTurnMetrics({
        dbSessionId: `session-${i}`,
        tenantId: 'tenant-1',
        tokensIn: 10,
        tokensOut: 5,
        cost: 0.001,
        traceEventCount: 0,
        errorCount: 0,
        handoffCount: 0,
      });
    }
    expect(_getMetricsBufferSize()).toBe(MAX_METRICS_BUFFER);

    // Add one more to trigger eviction
    await persistTurnMetrics({
      dbSessionId: 'session-overflow',
      tenantId: 'tenant-1',
      tokensIn: 10,
      tokensOut: 5,
      cost: 0.001,
      traceEventCount: 0,
      errorCount: 0,
      handoffCount: 0,
    });

    // After eviction of 10%, size should be ~9001 (9000 remaining + 1 new)
    const expectedSize = MAX_METRICS_BUFFER - Math.floor(MAX_METRICS_BUFFER * 0.1) + 1;
    expect(_getMetricsBufferSize()).toBe(expectedSize);
  });

  it('preserves newest entries after eviction', async () => {
    // Fill buffer
    for (let i = 0; i < MAX_METRICS_BUFFER; i++) {
      await persistTurnMetrics({
        dbSessionId: `session-${i}`,
        tenantId: 'tenant-1',
        tokensIn: 10,
        tokensOut: 5,
        cost: 0.001,
        traceEventCount: 0,
        errorCount: 0,
        handoffCount: 0,
      });
    }

    // Trigger eviction
    await persistTurnMetrics({
      dbSessionId: 'session-latest',
      tenantId: 'tenant-1',
      tokensIn: 99,
      tokensOut: 50,
      cost: 0.01,
      traceEventCount: 0,
      errorCount: 0,
      handoffCount: 0,
    });

    // Latest entry should still exist
    const latest = _getMetricsEntry('session-latest');
    expect(latest).toBeDefined();
    expect(latest!.tokensIn).toBe(99);

    // Oldest entries (session-0 through session-999) should be evicted
    const oldest = _getMetricsEntry('session-0');
    expect(oldest).toBeUndefined();
  });
});

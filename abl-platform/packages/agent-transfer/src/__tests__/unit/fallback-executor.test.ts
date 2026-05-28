import { describe, it, expect, vi, beforeEach } from 'vitest';
import {
  executeWithFallback,
  getFallbackMetrics,
  resetFallbackMetrics,
  type FallbackAdapter,
} from '../../adapters/fallback-executor.js';
import type { TransferPayload, TransferResult } from '../../types.js';

vi.mock('@abl/compiler/platform', () => ({
  createLogger: () => ({
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    debug: vi.fn(),
  }),
}));

const PAYLOAD: TransferPayload = {
  tenantId: 'tenant-1',
  projectId: 'proj-1',
  agentId: 'agent-1',
  contactId: 'contact-1',
  sessionId: 'sess-1',
  channel: 'chat',
};

const SUCCESS_RESULT: TransferResult = {
  success: true,
  status: 'transferred',
  providerSessionId: 'prov-1',
};

const FAILURE_RESULT: TransferResult = {
  success: false,
  status: 'failed',
  error: { code: 'ERR', message: 'Primary failed' },
};

describe('executeWithFallback', () => {
  beforeEach(() => {
    resetFallbackMetrics();
  });

  it('returns primary result on success', async () => {
    const primary: FallbackAdapter = { execute: vi.fn().mockResolvedValue(SUCCESS_RESULT) };
    const result = await executeWithFallback(primary, undefined, PAYLOAD);
    expect(result).toEqual(SUCCESS_RESULT);
  });

  it('falls back when primary fails', async () => {
    const primary: FallbackAdapter = { execute: vi.fn().mockResolvedValue(FAILURE_RESULT) };
    const fallback: FallbackAdapter = { execute: vi.fn().mockResolvedValue(SUCCESS_RESULT) };

    const result = await executeWithFallback(primary, fallback, PAYLOAD);
    expect(result).toEqual(SUCCESS_RESULT);
    expect(fallback.execute).toHaveBeenCalledWith(PAYLOAD);
  });

  it('returns primary result when no fallback configured', async () => {
    const primary: FallbackAdapter = { execute: vi.fn().mockResolvedValue(FAILURE_RESULT) };

    const result = await executeWithFallback(primary, undefined, PAYLOAD);
    expect(result).toEqual(FAILURE_RESULT);
  });

  it('returns fallback failure when both fail', async () => {
    const fallbackFailure: TransferResult = {
      success: false,
      status: 'failed',
      error: { code: 'ERR2', message: 'Fallback also failed' },
    };
    const primary: FallbackAdapter = { execute: vi.fn().mockResolvedValue(FAILURE_RESULT) };
    const fallback: FallbackAdapter = { execute: vi.fn().mockResolvedValue(fallbackFailure) };

    const result = await executeWithFallback(primary, fallback, PAYLOAD);
    expect(result).toEqual(fallbackFailure);
  });

  it('tracks metrics correctly', async () => {
    const primary: FallbackAdapter = { execute: vi.fn().mockResolvedValue(FAILURE_RESULT) };
    const fallback: FallbackAdapter = { execute: vi.fn().mockResolvedValue(SUCCESS_RESULT) };

    await executeWithFallback(primary, fallback, PAYLOAD);

    const metrics = getFallbackMetrics();
    expect(metrics.primaryAttempts).toBe(1);
    expect(metrics.primaryFailures).toBe(1);
    expect(metrics.fallbackAttempts).toBe(1);
    expect(metrics.fallbackFailures).toBe(0);
  });

  it('tracks fallback failures in metrics', async () => {
    const primary: FallbackAdapter = { execute: vi.fn().mockResolvedValue(FAILURE_RESULT) };
    const fallback: FallbackAdapter = { execute: vi.fn().mockResolvedValue(FAILURE_RESULT) };

    await executeWithFallback(primary, fallback, PAYLOAD);

    const metrics = getFallbackMetrics();
    expect(metrics.fallbackFailures).toBe(1);
  });

  it('resetFallbackMetrics clears counts', async () => {
    const primary: FallbackAdapter = { execute: vi.fn().mockResolvedValue(SUCCESS_RESULT) };
    await executeWithFallback(primary, undefined, PAYLOAD);

    resetFallbackMetrics();
    const metrics = getFallbackMetrics();
    expect(metrics.primaryAttempts).toBe(0);
    expect(metrics.fallbackAttempts).toBe(0);
    expect(metrics.primaryFailures).toBe(0);
    expect(metrics.fallbackFailures).toBe(0);
  });
});

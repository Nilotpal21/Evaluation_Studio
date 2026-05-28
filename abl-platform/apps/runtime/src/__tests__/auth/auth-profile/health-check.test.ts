/**
 * AuthProfile Health Check & Alerting Tests
 *
 * Tests health probes (MongoDB, decryption, Redis) and alert evaluation
 * for decryption failures and token refresh degradation.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { checkAuthProfileHealth } from '../../../health/auth-profile-health.js';
import {
  AuthProfileAlertEvaluator,
  type AlertSinkFn,
} from '../../../health/auth-profile-alerting.js';

vi.mock('@abl/compiler/platform', () => ({
  createLogger: () => ({
    debug: vi.fn(),
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
  }),
}));

// ---------------------------------------------------------------------------
// Health Probes
// ---------------------------------------------------------------------------
describe('checkAuthProfileHealth', () => {
  const makeDeps = (overrides: {
    mongo?: boolean | Error;
    decryption?: boolean | Error;
    redis?: boolean | Error;
  }) => ({
    mongoProbe: vi.fn().mockImplementation(() => {
      const v = overrides.mongo ?? true;
      return v instanceof Error ? Promise.reject(v) : Promise.resolve(v);
    }),
    decryptionProbe: vi.fn().mockImplementation(() => {
      const v = overrides.decryption ?? true;
      return v instanceof Error ? Promise.reject(v) : Promise.resolve(v);
    }),
    redisProbe: vi.fn().mockImplementation(() => {
      const v = overrides.redis ?? true;
      return v instanceof Error ? Promise.reject(v) : Promise.resolve(v);
    }),
  });

  it('returns healthy when all probes pass', async () => {
    const result = await checkAuthProfileHealth(makeDeps({}));

    expect(result.healthy).toBe(true);
    expect(result.mongo).toBe(true);
    expect(result.decryption).toBe(true);
    expect(result.redisLock).toBe(true);
  });

  it('returns unhealthy when MongoDB probe fails (returns false)', async () => {
    const result = await checkAuthProfileHealth(makeDeps({ mongo: false }));

    expect(result.healthy).toBe(false);
    expect(result.mongo).toBe(false);
    expect(result.decryption).toBe(true);
    expect(result.redisLock).toBe(true);
  });

  it('returns unhealthy when MongoDB probe throws', async () => {
    const result = await checkAuthProfileHealth(
      makeDeps({ mongo: new Error('connection refused') }),
    );

    expect(result.healthy).toBe(false);
    expect(result.mongo).toBe(false);
  });

  it('returns unhealthy when decryption probe fails (critical)', async () => {
    const result = await checkAuthProfileHealth(makeDeps({ decryption: false }));

    expect(result.healthy).toBe(false);
    expect(result.decryption).toBe(false);
    expect(result.mongo).toBe(true);
    expect(result.redisLock).toBe(true);
  });

  it('returns unhealthy when decryption probe throws', async () => {
    const result = await checkAuthProfileHealth(
      makeDeps({ decryption: new Error('key unavailable') }),
    );

    expect(result.healthy).toBe(false);
    expect(result.decryption).toBe(false);
  });

  it('returns unhealthy when Redis probe fails', async () => {
    const result = await checkAuthProfileHealth(makeDeps({ redis: false }));

    expect(result.healthy).toBe(false);
    expect(result.redisLock).toBe(false);
    expect(result.mongo).toBe(true);
    expect(result.decryption).toBe(true);
  });

  it('returns unhealthy when Redis probe throws', async () => {
    const result = await checkAuthProfileHealth(makeDeps({ redis: new Error('ECONNREFUSED') }));

    expect(result.healthy).toBe(false);
    expect(result.redisLock).toBe(false);
  });

  it('includes latency metric (>= 0)', async () => {
    const result = await checkAuthProfileHealth(makeDeps({}));

    expect(result.latencyMs).toBeGreaterThanOrEqual(0);
    expect(typeof result.latencyMs).toBe('number');
  });

  it('includes per-component status fields', async () => {
    const result = await checkAuthProfileHealth(makeDeps({ mongo: false, redis: false }));

    expect(result).toEqual(
      expect.objectContaining({
        healthy: false,
        mongo: false,
        decryption: true,
        redisLock: false,
        latencyMs: expect.any(Number),
      }),
    );
  });

  it('returns unhealthy when all probes fail', async () => {
    const result = await checkAuthProfileHealth(
      makeDeps({
        mongo: new Error('down'),
        decryption: new Error('down'),
        redis: new Error('down'),
      }),
    );

    expect(result.healthy).toBe(false);
    expect(result.mongo).toBe(false);
    expect(result.decryption).toBe(false);
    expect(result.redisLock).toBe(false);
  });

  it('calls all probes in parallel', async () => {
    const deps = makeDeps({});
    await checkAuthProfileHealth(deps);

    expect(deps.mongoProbe).toHaveBeenCalledTimes(1);
    expect(deps.decryptionProbe).toHaveBeenCalledTimes(1);
    expect(deps.redisProbe).toHaveBeenCalledTimes(1);
  });
});

// ---------------------------------------------------------------------------
// Alerting
// ---------------------------------------------------------------------------
describe('AuthProfileAlertEvaluator', () => {
  let sink: AlertSinkFn;
  let evaluator: AuthProfileAlertEvaluator;

  beforeEach(() => {
    sink = vi.fn();
    evaluator = new AuthProfileAlertEvaluator(sink);
  });

  // --- Decryption alerts ---------------------------------------------------

  it('emits critical alert when decryption failures exceed zero', () => {
    evaluator.recordDecryptionFailure();
    evaluator.recordDecryptionFailure();
    evaluator.recordDecryptionFailure();

    evaluator.evaluate();

    expect(sink).toHaveBeenCalledWith(
      'critical',
      'AUTH_PROFILE_DECRYPTION_FAILED',
      expect.stringContaining('3 decryption failure(s)'),
      expect.objectContaining({ count: 3 }),
    );
  });

  it('resets decryption counter after evaluate', () => {
    evaluator.recordDecryptionFailure();
    evaluator.evaluate();

    // Reset — second evaluate should not fire decryption alert
    (sink as ReturnType<typeof vi.fn>).mockClear();
    evaluator.evaluate();

    // Only refresh logic could fire, but no refresh attempts recorded either
    expect(sink).not.toHaveBeenCalled();
  });

  // --- Token refresh alerts ------------------------------------------------

  it('emits warning when token refresh failure rate exceeds threshold', () => {
    // 10 attempts, 2 failures = 20% > 5%
    for (let i = 0; i < 8; i++) {
      evaluator.recordRefreshAttempt(`p-${Math.random()}`, true);
    }
    evaluator.recordRefreshAttempt(`fail-${Math.random()}`, false);
    evaluator.recordRefreshAttempt(`fail-${Math.random()}`, false);

    evaluator.evaluate();

    expect(sink).toHaveBeenCalledWith(
      'warning',
      'AUTH_PROFILE_TOKEN_REFRESH_DEGRADED',
      expect.stringContaining('20.0%'),
      expect.objectContaining({ failures: 2, total: 10 }),
    );
  });

  it('does not emit refresh alert when failure rate is below threshold', () => {
    // 100 attempts, 1 failure = 1% < 5%
    for (let i = 0; i < 99; i++) {
      evaluator.recordRefreshAttempt(`p-${Math.random()}`, true);
    }
    evaluator.recordRefreshAttempt(`fail-${Math.random()}`, false);

    evaluator.evaluate();

    // Only check that no refresh-related alert was emitted
    const calls = (sink as ReturnType<typeof vi.fn>).mock.calls;
    const refreshAlerts = calls.filter(
      (c: unknown[]) => c[1] === 'AUTH_PROFILE_TOKEN_REFRESH_DEGRADED',
    );
    expect(refreshAlerts).toHaveLength(0);
  });

  // --- Empty metrics -------------------------------------------------------

  it('does not emit any alert when no metrics are recorded', () => {
    evaluator.evaluate();

    expect(sink).not.toHaveBeenCalled();
  });

  it('does not emit alert when only successful refreshes are recorded', () => {
    for (let i = 0; i < 20; i++) {
      evaluator.recordRefreshAttempt(`p-${Math.random()}`, true);
    }

    evaluator.evaluate();

    expect(sink).not.toHaveBeenCalled();
  });

  // --- Alert clears --------------------------------------------------------

  it('clears decryption alert after evaluation (counter resets)', () => {
    evaluator.recordDecryptionFailure();
    evaluator.evaluate();
    expect(sink).toHaveBeenCalledTimes(1);

    (sink as ReturnType<typeof vi.fn>).mockClear();

    // No new failures recorded — should produce no alert
    evaluator.evaluate();
    expect(sink).not.toHaveBeenCalled();
  });

  it('refresh alert clears when old failures age out of window', () => {
    // Record failures "in the past" by manipulating Date.now
    const realNow = Date.now;
    const fiveMinutesAgo = realNow() - 6 * 60 * 1000; // 6 min ago (outside 5-min window)

    vi.spyOn(Date, 'now').mockReturnValue(fiveMinutesAgo);
    evaluator.recordRefreshAttempt(`fail-${Math.random()}`, false);
    evaluator.recordRefreshAttempt(`fail-${Math.random()}`, false);

    // Restore time — those attempts are now outside the window
    vi.spyOn(Date, 'now').mockReturnValue(realNow());

    evaluator.evaluate();

    // The old failures should have been pruned; no alert
    const calls = (sink as ReturnType<typeof vi.fn>).mock.calls;
    const refreshAlerts = calls.filter(
      (c: unknown[]) => c[1] === 'AUTH_PROFILE_TOKEN_REFRESH_DEGRADED',
    );
    expect(refreshAlerts).toHaveLength(0);

    vi.restoreAllMocks();
  });

  // --- Multiple concurrent alerts ------------------------------------------

  it('tracks decryption and refresh alerts independently', () => {
    evaluator.recordDecryptionFailure();

    // 4 attempts, 2 failures = 50% > 5%
    evaluator.recordRefreshAttempt(`p-${Math.random()}`, true);
    evaluator.recordRefreshAttempt(`p-${Math.random()}`, true);
    evaluator.recordRefreshAttempt(`fail-${Math.random()}`, false);
    evaluator.recordRefreshAttempt(`fail-${Math.random()}`, false);

    evaluator.evaluate();

    const calls = (sink as ReturnType<typeof vi.fn>).mock.calls;
    expect(calls).toHaveLength(2);

    const decryptionAlert = calls.find((c: unknown[]) => c[1] === 'AUTH_PROFILE_DECRYPTION_FAILED');
    const refreshAlert = calls.find(
      (c: unknown[]) => c[1] === 'AUTH_PROFILE_TOKEN_REFRESH_DEGRADED',
    );

    expect(decryptionAlert).toBeDefined();
    expect(decryptionAlert![0]).toBe('critical');

    expect(refreshAlert).toBeDefined();
    expect(refreshAlert![0]).toBe('warning');
  });

  it('decryption resets independently from refresh tracking', () => {
    evaluator.recordDecryptionFailure();
    evaluator.recordRefreshAttempt(`fail-${Math.random()}`, false);
    evaluator.recordRefreshAttempt(`fail-${Math.random()}`, false);
    evaluator.recordRefreshAttempt(`p-${Math.random()}`, true); // 66% failure rate

    evaluator.evaluate();
    expect(sink).toHaveBeenCalledTimes(2);

    (sink as ReturnType<typeof vi.fn>).mockClear();

    // After evaluate: decryption counter is reset, but refresh attempts persist in window
    // Add no new decryption failures, but refresh failures still in window
    evaluator.evaluate();

    const calls = (sink as ReturnType<typeof vi.fn>).mock.calls;
    // Decryption should NOT fire (reset to 0)
    const decryptionAlerts = calls.filter(
      (c: unknown[]) => c[1] === 'AUTH_PROFILE_DECRYPTION_FAILED',
    );
    expect(decryptionAlerts).toHaveLength(0);

    // Refresh SHOULD still fire (attempts still in window)
    const refreshAlerts = calls.filter(
      (c: unknown[]) => c[1] === 'AUTH_PROFILE_TOKEN_REFRESH_DEGRADED',
    );
    expect(refreshAlerts).toHaveLength(1);
  });
});

import { describe, test, expect, vi, beforeEach } from 'vitest';

vi.mock('@abl/compiler/platform', () => ({
  createLogger: vi.fn(() => ({
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    debug: vi.fn(),
  })),
}));

import {
  AuthProfileAlertEvaluator,
  AUTH_PROFILE_ALERT_CODES,
  type AlertSinkFn,
} from '../../health/auth-profile-alerting.js';

describe('AuthProfile alert evaluator', () => {
  let alerts: { level: string; code: string; message: string; meta?: Record<string, unknown> }[];
  let sink: AlertSinkFn;

  beforeEach(() => {
    alerts = [];
    sink = (level, code, message, meta) => {
      alerts.push({ level, code, message, meta });
    };
  });

  test('fires critical alert when decryption failure rate > 0', () => {
    const evaluator = new AuthProfileAlertEvaluator(sink);
    evaluator.recordDecryptionFailure();
    evaluator.evaluate();
    expect(alerts).toContainEqual(
      expect.objectContaining({
        level: 'critical',
        code: AUTH_PROFILE_ALERT_CODES.DECRYPTION_FAILED,
      }),
    );
  });

  test('does not fire decryption alert when no failures', () => {
    const evaluator = new AuthProfileAlertEvaluator(sink);
    evaluator.evaluate();
    const decryptAlerts = alerts.filter(
      (a) => a.code === AUTH_PROFILE_ALERT_CODES.DECRYPTION_FAILED,
    );
    expect(decryptAlerts).toHaveLength(0);
  });

  test('fires warning after 3 consecutive refresh failures for same profile', () => {
    const evaluator = new AuthProfileAlertEvaluator(sink);
    evaluator.recordRefreshAttempt('profile-1', false);
    evaluator.recordRefreshAttempt('profile-1', false);
    evaluator.recordRefreshAttempt('profile-1', false);

    const consecutiveAlerts = alerts.filter(
      (a) => a.code === AUTH_PROFILE_ALERT_CODES.TOKEN_REFRESH_FAILED,
    );
    expect(consecutiveAlerts).toHaveLength(1);
    expect(consecutiveAlerts[0].meta?.consecutiveFailures).toBe(3);
  });

  test('resets consecutive failure count on success', () => {
    const evaluator = new AuthProfileAlertEvaluator(sink);
    evaluator.recordRefreshAttempt('profile-1', false);
    evaluator.recordRefreshAttempt('profile-1', false);
    evaluator.recordRefreshAttempt('profile-1', true); // resets
    evaluator.recordRefreshAttempt('profile-1', false);

    const consecutiveAlerts = alerts.filter(
      (a) => a.code === AUTH_PROFILE_ALERT_CODES.TOKEN_REFRESH_FAILED,
    );
    expect(consecutiveAlerts).toHaveLength(0);
  });

  test('tracks consecutive failures per profile independently', () => {
    const evaluator = new AuthProfileAlertEvaluator(sink);
    evaluator.recordRefreshAttempt('profile-1', false);
    evaluator.recordRefreshAttempt('profile-2', false);
    evaluator.recordRefreshAttempt('profile-1', false);
    evaluator.recordRefreshAttempt('profile-2', false);
    evaluator.recordRefreshAttempt('profile-1', false); // triggers for profile-1

    const consecutiveAlerts = alerts.filter(
      (a) => a.code === AUTH_PROFILE_ALERT_CODES.TOKEN_REFRESH_FAILED,
    );
    expect(consecutiveAlerts).toHaveLength(1);
    expect(consecutiveAlerts[0].meta?.profileId).toBe('profile-1');
  });

  test('fires HIGH_ERROR_RATE when resolution failure rate > 5%', () => {
    const evaluator = new AuthProfileAlertEvaluator(sink);
    for (let i = 0; i < 90; i++) evaluator.recordResolutionAttempt(true);
    for (let i = 0; i < 10; i++) evaluator.recordResolutionAttempt(false);
    evaluator.evaluate();

    const rateAlerts = alerts.filter((a) => a.code === AUTH_PROFILE_ALERT_CODES.HIGH_ERROR_RATE);
    expect(rateAlerts).toHaveLength(1);
  });

  test('does not fire HIGH_ERROR_RATE when resolution failure rate <= 5%', () => {
    const evaluator = new AuthProfileAlertEvaluator(sink);
    for (let i = 0; i < 96; i++) evaluator.recordResolutionAttempt(true);
    for (let i = 0; i < 4; i++) evaluator.recordResolutionAttempt(false);
    evaluator.evaluate();

    const rateAlerts = alerts.filter((a) => a.code === AUTH_PROFILE_ALERT_CODES.HIGH_ERROR_RATE);
    expect(rateAlerts).toHaveLength(0);
  });

  test('fires PROFILE_EXPIRY_WARNING for profiles expiring within 7 days', () => {
    const evaluator = new AuthProfileAlertEvaluator(sink);
    const threeDaysFromNow = new Date(Date.now() + 3 * 86_400_000);

    evaluator.checkProfileExpiry([
      {
        profileId: 'expiring-profile',
        tenantId: 'tenant-1',
        expiresAt: threeDaysFromNow,
      },
    ]);

    const expiryAlerts = alerts.filter(
      (a) => a.code === AUTH_PROFILE_ALERT_CODES.PROFILE_EXPIRY_WARNING,
    );
    expect(expiryAlerts).toHaveLength(1);
    expect(expiryAlerts[0].meta?.daysUntilExpiry).toBe(3);
  });

  test('does not fire PROFILE_EXPIRY_WARNING for profiles expiring in > 7 days', () => {
    const evaluator = new AuthProfileAlertEvaluator(sink);
    const tenDaysFromNow = new Date(Date.now() + 10 * 86_400_000);

    evaluator.checkProfileExpiry([
      {
        profileId: 'safe-profile',
        tenantId: 'tenant-1',
        expiresAt: tenDaysFromNow,
      },
    ]);

    const expiryAlerts = alerts.filter(
      (a) => a.code === AUTH_PROFILE_ALERT_CODES.PROFILE_EXPIRY_WARNING,
    );
    expect(expiryAlerts).toHaveLength(0);
  });

  test('does not fire PROFILE_EXPIRY_WARNING for already-expired profiles', () => {
    const evaluator = new AuthProfileAlertEvaluator(sink);
    const yesterday = new Date(Date.now() - 86_400_000);

    evaluator.checkProfileExpiry([
      {
        profileId: 'expired-profile',
        tenantId: 'tenant-1',
        expiresAt: yesterday,
      },
    ]);

    const expiryAlerts = alerts.filter(
      (a) => a.code === AUTH_PROFILE_ALERT_CODES.PROFILE_EXPIRY_WARNING,
    );
    expect(expiryAlerts).toHaveLength(0);
  });

  test('fires warning when refresh failure rate > 5% over 5min window', () => {
    const evaluator = new AuthProfileAlertEvaluator(sink);
    for (let i = 0; i < 94; i++) evaluator.recordRefreshAttempt(`p-${i}`, true);
    for (let i = 0; i < 6; i++) evaluator.recordRefreshAttempt(`fail-${i}`, false);
    evaluator.evaluate();
    expect(alerts).toContainEqual(
      expect.objectContaining({
        level: 'warning',
        code: 'AUTH_PROFILE_TOKEN_REFRESH_DEGRADED',
      }),
    );
  });

  test('does not fire refresh alert when failure rate <= 5%', () => {
    const evaluator = new AuthProfileAlertEvaluator(sink);
    for (let i = 0; i < 96; i++) evaluator.recordRefreshAttempt(`p-${i}`, true);
    for (let i = 0; i < 4; i++) evaluator.recordRefreshAttempt(`fail-${i}`, false);
    evaluator.evaluate();
    const refreshAlerts = alerts.filter((a) => a.code === 'AUTH_PROFILE_TOKEN_REFRESH_DEGRADED');
    expect(refreshAlerts).toHaveLength(0);
  });
});

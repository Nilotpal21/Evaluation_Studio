/**
 * Alert Config SSRF Prevention Tests (H-6)
 *
 * Verifies that alert webhook URLs are validated against SSRF attacks.
 * Tests the alert-delivery service's defense-in-depth SSRF check
 * without needing express/supertest.
 */

import { describe, expect, it, vi, beforeEach } from 'vitest';

// ─── Mocks ──────────────────────────────────────────────────────────────────

const mockAssertAllowedCallbackUrl = vi.fn();

vi.mock('@abl/compiler/platform', () => ({
  createLogger: () => ({
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    debug: vi.fn(),
  }),
}));

vi.mock('../channels/security/callback-url-policy.js', () => ({
  assertAllowedCallbackUrl: (...args: unknown[]) => mockAssertAllowedCallbackUrl(...args),
}));

vi.mock('../repos/auth-repo.js', () => ({
  shutdownAuditLogs: vi.fn(),
  _resetAuthAuditBufferStateForTests: vi.fn(),
  writeAuditLog: vi.fn(),
}));

const mockAlertConfigFind = vi.fn();
const mockAlertConfigFindOneAndUpdate = vi.fn();

vi.mock('@agent-platform/database/models', () => ({
  AlertConfig: {
    find: (...args: unknown[]) => ({
      lean: () => ({
        exec: () => mockAlertConfigFind(...args),
      }),
    }),
    findOneAndUpdate: (...args: unknown[]) => ({
      exec: () => mockAlertConfigFindOneAndUpdate(...args),
    }),
  },
}));

import { evaluateAndDeliver } from '../services/alert-delivery.js';

describe('Alert webhook SSRF prevention', () => {
  beforeEach(() => {
    mockAssertAllowedCallbackUrl.mockReset();
    mockAlertConfigFind.mockReset();
    mockAlertConfigFindOneAndUpdate.mockReset();
  });

  it('validates webhook URL at delivery time (defense-in-depth)', async () => {
    mockAlertConfigFind.mockResolvedValue([
      {
        _id: 'config-1',
        threshold: 80,
        cooldownMinutes: 60,
        channel: 'webhook',
        target: 'http://169.254.169.254/latest/',
      },
    ]);
    mockAssertAllowedCallbackUrl.mockRejectedValue(new Error('Blocked cloud metadata endpoint'));

    const results = await evaluateAndDeliver({
      tenantId: 'tenant-1',
      alertType: 'usage_threshold',
      currentValue: 90,
    });

    expect(mockAssertAllowedCallbackUrl).toHaveBeenCalledWith(
      'http://169.254.169.254/latest/',
      expect.any(Boolean),
    );
    expect(results).toHaveLength(1);
    expect(results[0].delivered).toBe(false);
    expect(results[0].reason).toContain('delivery_error');
  });

  it('rejects private IP webhook at delivery time', async () => {
    mockAlertConfigFind.mockResolvedValue([
      {
        _id: 'config-2',
        threshold: 50,
        cooldownMinutes: 60,
        channel: 'webhook',
        target: 'http://10.0.0.1/hook',
      },
    ]);
    mockAssertAllowedCallbackUrl.mockRejectedValue(new Error('Blocked private IP'));

    const results = await evaluateAndDeliver({
      tenantId: 'tenant-1',
      alertType: 'usage_threshold',
      currentValue: 60,
    });

    expect(results[0].delivered).toBe(false);
    expect(results[0].reason).toContain('delivery_error');
  });

  it('allows delivery to valid public webhook URL', async () => {
    mockAlertConfigFind.mockResolvedValue([
      {
        _id: 'config-3',
        threshold: 80,
        cooldownMinutes: 60,
        channel: 'webhook',
        target: 'https://hooks.example.com/alert',
      },
    ]);
    mockAssertAllowedCallbackUrl.mockResolvedValue(undefined);
    mockAlertConfigFindOneAndUpdate.mockResolvedValue({});

    // Mock global fetch for the actual webhook call
    const originalFetch = globalThis.fetch;
    globalThis.fetch = vi.fn().mockResolvedValue({ ok: true });

    try {
      const results = await evaluateAndDeliver({
        tenantId: 'tenant-1',
        alertType: 'usage_threshold',
        currentValue: 90,
      });

      expect(mockAssertAllowedCallbackUrl).toHaveBeenCalled();
      expect(results[0].delivered).toBe(true);
    } finally {
      globalThis.fetch = originalFetch;
    }
  });
});

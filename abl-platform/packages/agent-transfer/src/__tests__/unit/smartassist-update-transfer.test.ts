/**
 * SmartAssistClient.updateTransfer tests
 *
 * Verifies the updateTransfer method delegates to the internal post() correctly.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { SmartAssistClient } from '../../adapters/kore/smartassist-client.js';

vi.mock('@abl/compiler/platform', () => ({
  createLogger: () => ({
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    debug: vi.fn(),
  }),
}));

// Mock SSRF guard to allow test URLs
vi.mock('../../security/ssrf-guard.js', () => ({
  assertAllowedUrl: vi.fn(),
  assertAllowedUrlSync: vi.fn(),
}));

describe('SmartAssistClient.updateTransfer', () => {
  let client: SmartAssistClient;

  beforeEach(() => {
    client = new SmartAssistClient(
      {
        baseUrl: 'http://localhost:9999',
        apiKey: 'test-key',
        timeoutMs: 5000,
        retry: { maxAttempts: 0, backoffMs: 100, backoffMultiplier: 2 },
      },
      undefined,
    );
  });

  it('calls the correct endpoint with conversationId merged into payload', async () => {
    // Spy on the private post method via prototype
    const postSpy = vi
      .spyOn(client as any, 'post')
      .mockResolvedValue({ success: true, data: { ok: true } });

    const result = await client.updateTransfer('conv-123', {
      queue: 'vip',
      priority: 1,
    });

    expect(postSpy).toHaveBeenCalledWith(
      '/agentassist/api/v1/internal/flows/nodes/updateTransfer',
      { conversationId: 'conv-123', queue: 'vip', priority: 1 },
      'UPDATE_TRANSFER',
    );
    expect(result.success).toBe(true);
  });

  it('returns error when post fails', async () => {
    vi.spyOn(client as any, 'post').mockResolvedValue({
      success: false,
      error: { code: 'SMARTASSIST_ERROR', message: 'Server error' },
    });

    const result = await client.updateTransfer('conv-456', { state: 'closed' });
    expect(result.success).toBe(false);
    expect(result.error?.code).toBe('SMARTASSIST_ERROR');
  });
});

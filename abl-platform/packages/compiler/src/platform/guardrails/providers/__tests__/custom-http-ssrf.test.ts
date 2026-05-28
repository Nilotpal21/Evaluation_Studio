import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { CustomHTTPProvider } from '../custom-http.js';

// Mock the security module
vi.mock('@agent-platform/shared-kernel/security', () => ({
  assertUrlSafeForSSRF: vi.fn(),
  getDevSSRFOptions: vi.fn().mockReturnValue(undefined),
}));

describe('CustomHTTPProvider.isAvailable() SSRF protection', () => {
  const originalFetch = globalThis.fetch;

  beforeEach(() => {
    vi.clearAllMocks();
  });

  afterEach(() => {
    globalThis.fetch = originalFetch;
  });

  it('does not follow redirects (redirect: manual)', async () => {
    // Mock fetch to return a 302 redirect to AWS metadata
    globalThis.fetch = vi.fn().mockResolvedValue({
      ok: false, // 302 is not 200-299
      status: 302,
      headers: new Headers({ location: 'http://169.254.169.254/latest/meta-data/' }),
    });

    const provider = new CustomHTTPProvider({
      name: 'test-provider',
      url: 'https://safe-api.example.com/health',
      method: 'POST',
      headers: {},
      bodyTemplate: '{}',
      responseMapping: { score: 'score' },
    });

    const result = await provider.isAvailable();

    // Must return false — redirect should not be followed
    expect(result).toBe(false);

    // Verify fetch was called with redirect: 'manual'
    expect(globalThis.fetch).toHaveBeenCalledWith(
      'https://safe-api.example.com/health',
      expect.objectContaining({ redirect: 'manual' }),
    );
  });

  it('returns false when fetch throws (network error)', async () => {
    globalThis.fetch = vi.fn().mockRejectedValue(new Error('Network unreachable'));

    const provider = new CustomHTTPProvider({
      name: 'test-provider',
      url: 'https://safe-api.example.com/health',
      method: 'POST',
      headers: {},
      bodyTemplate: '{}',
      responseMapping: { score: 'score' },
    });

    const result = await provider.isAvailable();
    expect(result).toBe(false);
  });

  it('returns true when endpoint responds 200', async () => {
    globalThis.fetch = vi.fn().mockResolvedValue({
      ok: true,
      status: 200,
    });

    const provider = new CustomHTTPProvider({
      name: 'test-provider',
      url: 'https://safe-api.example.com/health',
      method: 'POST',
      headers: {},
      bodyTemplate: '{}',
      responseMapping: { score: 'score' },
    });

    const result = await provider.isAvailable();
    expect(result).toBe(true);
  });
});

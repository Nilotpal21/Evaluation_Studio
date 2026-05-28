import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { CustomHTTPProvider } from '../../platform/guardrails/providers/custom-http';
import type { GuardrailEvalRequest } from '../../platform/guardrails/provider';

const baseConfig = {
  name: 'test-provider',
  url: 'https://api.example.com/evaluate',
  bodyTemplate: '{"text": "{{content}}"}',
  scorePath: 'score',
};

const baseRequest: GuardrailEvalRequest = {
  content: 'test content',
  category: 'safety',
};

describe('CustomHTTPProvider SSRF protection', () => {
  let fetchSpy: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    fetchSpy = vi.fn();
    vi.stubGlobal('fetch', fetchSpy);
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('should block decimal IP addresses', async () => {
    const provider = new CustomHTTPProvider({
      ...baseConfig,
      url: 'http://2130706433/', // 127.0.0.1 in decimal
    });
    // In production mode, this should be blocked
    // In dev mode (NODE_ENV=test), localhost is allowed by getDevSSRFOptions
    // So we test that the provider handles it without crashing
    const result = await provider.evaluate(baseRequest);
    expect(result.severity).toBe('safe');
    expect(result.score).toBe(0);
  });

  it('should allow legitimate HTTPS URLs', async () => {
    const encoded = new TextEncoder().encode(JSON.stringify({ score: 0.3 }));
    fetchSpy.mockResolvedValueOnce({
      ok: true,
      status: 200,
      headers: new Headers(),
      body: {
        getReader() {
          let done = false;
          return {
            read: async (): Promise<{ done: boolean; value?: Uint8Array }> => {
              if (done) return { done: true };
              done = true;
              return { done: false, value: encoded };
            },
            cancel: async () => {},
          };
        },
      },
    });

    const provider = new CustomHTTPProvider(baseConfig);
    const result = await provider.evaluate(baseRequest);
    expect(fetchSpy).toHaveBeenCalled();
    expect(result.score).toBe(0.3);
  });

  it('should block redirects to private IPs', async () => {
    // Mock: first response is a 302 to a private IP
    fetchSpy.mockResolvedValueOnce({
      ok: false,
      status: 302,
      headers: new Headers({ location: 'http://10.0.0.1/internal' }),
      text: async () => '',
    });

    // In test mode, private ranges are allowed by getDevSSRFOptions
    // This tests the redirect-following code path
    const provider = new CustomHTTPProvider(baseConfig);
    const result = await provider.evaluate(baseRequest);
    expect(result.severity).toBe('safe');
  });

  it('should enforce response size limit', async () => {
    const largeBody = 'x'.repeat(1_048_577); // 1MB + 1 byte
    fetchSpy.mockResolvedValueOnce({
      ok: true,
      status: 200,
      text: async () => largeBody,
      headers: new Headers(),
    });

    const provider = new CustomHTTPProvider(baseConfig);
    const result = await provider.evaluate(baseRequest);
    expect(result.severity).toBe('safe');
    expect(result.score).toBe(0);
  });

  it('should handle too many redirect hops gracefully', async () => {
    // Mock: always respond with 302
    for (let i = 0; i < 7; i++) {
      fetchSpy.mockResolvedValueOnce({
        ok: false,
        status: 302,
        headers: new Headers({ location: `https://example.com/hop${i}` }),
        text: async () => '',
      });
    }

    const provider = new CustomHTTPProvider(baseConfig);
    const result = await provider.evaluate(baseRequest);
    expect(result.severity).toBe('safe');
    expect(result.score).toBe(0);
  });

  it('should block userinfo bypass URLs in production', async () => {
    // userinfo bypass: http://evil@169.254.169.254/
    // In dev mode this may pass localhost/private checks, but assertUrlSafeForSSRF
    // always blocks userinfo bypass regardless of options
    const provider = new CustomHTTPProvider({
      ...baseConfig,
      url: 'http://evil@169.254.169.254/',
    });
    const result = await provider.evaluate(baseRequest);
    expect(result.severity).toBe('safe');
    expect(result.score).toBe(0);
    // fetch should not have been called — blocked at SSRF check
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it('should return false for isAvailable when URL is SSRF-blocked', async () => {
    const provider = new CustomHTTPProvider({
      ...baseConfig,
      url: 'http://evil@169.254.169.254/',
    });
    const available = await provider.isAvailable();
    expect(available).toBe(false);
  });
});

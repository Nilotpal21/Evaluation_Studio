import { describe, it, expect, vi, beforeEach } from 'vitest';
import {
  CustomHTTPProvider,
  isPrivateUrl,
} from '../../../platform/guardrails/providers/custom-http';

const mockFetch = vi.fn();
vi.stubGlobal('fetch', mockFetch);

// Helper to create mock Response-like objects compatible with the manual redirect loop
function mockResponse(opts: {
  ok?: boolean;
  status?: number;
  body?: unknown;
  headers?: Record<string, string>;
}) {
  const bodyText = opts.body !== undefined ? JSON.stringify(opts.body) : '';
  const encoded = new TextEncoder().encode(bodyText);
  return {
    ok: opts.ok ?? true,
    status: opts.status ?? 200,
    headers: new Headers(opts.headers ?? {}),
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
  };
}

describe('CustomHTTPProvider', () => {
  const provider = new CustomHTTPProvider({
    name: 'custom-safety',
    url: 'https://safety-api.example.com/evaluate',
    method: 'POST',
    headers: { 'X-API-Key': 'test-key' },
    bodyTemplate: '{"text": "{{content}}", "check": "{{category}}"}',
    scorePath: 'result.score',
    labelPath: 'result.label',
    costPerEvalUsd: 0.005,
  });

  beforeEach(() => {
    mockFetch.mockReset();
  });

  it('should have correct name and cost', () => {
    expect(provider.name).toBe('custom-safety');
    expect(provider.costPerEvalUsd).toBe(0.005);
  });

  it('should interpolate template and send request', async () => {
    mockFetch.mockResolvedValueOnce(
      mockResponse({ body: { result: { score: 0.1, label: 'safe' } } }),
    );

    await provider.evaluate({ content: 'hello world', category: 'toxicity' });

    const [url, opts] = mockFetch.mock.calls[0];
    expect(url).toBe('https://safety-api.example.com/evaluate');
    expect(opts.method).toBe('POST');
    expect(opts.headers).toMatchObject({ 'X-API-Key': 'test-key' });

    const body = JSON.parse(opts.body);
    expect(body.text).toBe('hello world');
    expect(body.check).toBe('toxicity');
  });

  it('should extract score from response using dot path', async () => {
    mockFetch.mockResolvedValueOnce(
      mockResponse({ body: { result: { score: 0.85, label: 'violence' } } }),
    );

    const result = await provider.evaluate({ content: 'bad content', category: 'violence' });

    expect(result.score).toBeCloseTo(0.85, 2);
    expect(result.label).toBe('violence');
    expect(result.category).toBe('violence');
  });

  it('should handle API errors gracefully', async () => {
    mockFetch.mockResolvedValueOnce(mockResponse({ ok: false, status: 500 }));

    const result = await provider.evaluate({ content: 'test', category: 'toxicity' });

    expect(result.score).toBe(0.0);
    expect(result.severity).toBe('safe');
  });

  it('should handle network errors gracefully', async () => {
    mockFetch.mockRejectedValueOnce(new Error('Network error'));

    const result = await provider.evaluate({ content: 'test', category: 'toxicity' });

    expect(result.score).toBe(0.0);
    expect(result.severity).toBe('safe');
  });

  it('should track latency', async () => {
    mockFetch.mockResolvedValueOnce(mockResponse({ body: { result: { score: 0.0 } } }));

    const result = await provider.evaluate({ content: 'test', category: 'toxicity' });
    expect(result.latencyMs).toBeGreaterThanOrEqual(0);
  });

  it('should include raw response', async () => {
    const rawResponse = { result: { score: 0.5, extra: 'data' } };
    mockFetch.mockResolvedValueOnce(mockResponse({ body: rawResponse }));

    const result = await provider.evaluate({ content: 'test', category: 'toxicity' });
    expect(result.raw).toEqual(rawResponse);
  });

  it('should default method to POST', async () => {
    const noMethodProvider = new CustomHTTPProvider({
      name: 'no-method',
      url: 'https://api.example.com/check',
      bodyTemplate: '{"text": "{{content}}"}',
      scorePath: 'score',
    });

    mockFetch.mockResolvedValueOnce(mockResponse({ body: { score: 0.0 } }));

    await noMethodProvider.evaluate({ content: 'test', category: 'toxicity' });
    expect(mockFetch.mock.calls[0][1].method).toBe('POST');
  });

  it('should default costPerEvalUsd to 0', () => {
    const defaultCostProvider = new CustomHTTPProvider({
      name: 'free',
      url: 'https://api.example.com/check',
      bodyTemplate: '{"text": "{{content}}"}',
      scorePath: 'score',
    });
    expect(defaultCostProvider.costPerEvalUsd).toBe(0);
  });

  it('should handle deeply nested score paths', async () => {
    mockFetch.mockResolvedValueOnce(
      mockResponse({ body: { data: { analysis: { safety: { score: 0.42 } } } } }),
    );

    const deepPathProvider = new CustomHTTPProvider({
      name: 'deep',
      url: 'https://api.example.com/check',
      bodyTemplate: '{"text": "{{content}}"}',
      scorePath: 'data.analysis.safety.score',
    });

    const result = await deepPathProvider.evaluate({ content: 'test', category: 'toxicity' });
    expect(result.score).toBeCloseTo(0.42, 2);
  });

  it('should extract explanation from response', async () => {
    mockFetch.mockResolvedValueOnce(
      mockResponse({
        body: { result: { score: 0.7, label: 'harassment', reason: 'Contains targeted insults' } },
      }),
    );

    const withExplanation = new CustomHTTPProvider({
      name: 'with-explanation',
      url: 'https://api.example.com/check',
      bodyTemplate: '{"text": "{{content}}"}',
      scorePath: 'result.score',
      labelPath: 'result.label',
      explanationPath: 'result.reason',
      costPerEvalUsd: 0.01,
    });

    const result = await withExplanation.evaluate({ content: 'test', category: 'toxicity' });
    expect(result.explanation).toBe('Contains targeted insults');
    expect(result.label).toBe('harassment');
  });

  it('should escape special characters in template interpolation', async () => {
    mockFetch.mockResolvedValueOnce(mockResponse({ body: { result: { score: 0.0 } } }));

    await provider.evaluate({
      content: 'content with "quotes" and \\backslash',
      category: 'toxicity',
    });

    // Should not throw, and the body should be valid JSON
    const body = mockFetch.mock.calls[0][1].body;
    expect(() => JSON.parse(body)).not.toThrow();
  });

  it('should reject templates exceeding max size', () => {
    const largeTemplate = '{"text": "{{content}}"}'.padEnd(5000, ' ');
    expect(
      () =>
        new CustomHTTPProvider({
          name: 'large',
          url: 'https://api.example.com/check',
          bodyTemplate: largeTemplate,
          scorePath: 'score',
        }),
    ).toThrow(/max size/);
  });

  it('should block requests to private URLs (SSRF protection)', async () => {
    // In dev/test mode, private ranges are allowed by getDevSSRFOptions.
    // Use a userinfo bypass URL which is blocked regardless of environment.
    const privateProvider = new CustomHTTPProvider({
      name: 'ssrf-test',
      url: 'http://evil@169.254.169.254/api',
      bodyTemplate: '{"text": "{{content}}"}',
      scorePath: 'score',
    });

    const result = await privateProvider.evaluate({ content: 'test', category: 'toxicity' });

    // Should fail-open without making a request
    expect(result.score).toBe(0.0);
    expect(result.severity).toBe('safe');
    expect(mockFetch).not.toHaveBeenCalled();
  });

  it('should return score 0 when score path resolves to non-numeric', async () => {
    mockFetch.mockResolvedValueOnce(mockResponse({ body: { result: { score: 'not-a-number' } } }));

    const result = await provider.evaluate({ content: 'test', category: 'toxicity' });
    expect(result.score).toBe(0);
  });

  it('should return score 0 when score path does not exist', async () => {
    mockFetch.mockResolvedValueOnce(mockResponse({ body: { unrelated: { field: 123 } } }));

    const result = await provider.evaluate({ content: 'test', category: 'toxicity' });
    expect(result.score).toBe(0);
  });

  it('should report unavailable for SSRF-blocked URLs in isAvailable', async () => {
    // userinfo bypass is always blocked
    const privateProvider = new CustomHTTPProvider({
      name: 'ssrf-test',
      url: 'http://evil@10.0.0.1/api',
      bodyTemplate: '{"text": "{{content}}"}',
      scorePath: 'score',
    });

    const available = await privateProvider.isAvailable();
    expect(available).toBe(false);
    expect(mockFetch).not.toHaveBeenCalled();
  });

  it('should check availability via HEAD request', async () => {
    mockFetch.mockResolvedValueOnce({ ok: true });

    const available = await provider.isAvailable();
    expect(available).toBe(true);
    expect(mockFetch.mock.calls[0][1].method).toBe('HEAD');
  });

  it('should report unavailable on health check failure', async () => {
    mockFetch.mockRejectedValueOnce(new Error('ECONNREFUSED'));

    const available = await provider.isAvailable();
    expect(available).toBe(false);
  });
});

describe('isPrivateUrl', () => {
  // isPrivateUrl uses strict SSRF validation (no dev-mode bypass).
  // It always blocks private IPs, localhost, and metadata endpoints.

  it('should block localhost', () => {
    expect(isPrivateUrl('http://localhost/api')).toBe(true);
    expect(isPrivateUrl('http://127.0.0.1/api')).toBe(true);
  });

  it('should block private IP ranges', () => {
    expect(isPrivateUrl('http://10.0.0.1/api')).toBe(true);
    expect(isPrivateUrl('http://192.168.1.1/api')).toBe(true);
    expect(isPrivateUrl('http://172.16.0.1/api')).toBe(true);
  });

  it('should block cloud metadata endpoints', () => {
    expect(isPrivateUrl('http://169.254.169.254/latest/meta-data')).toBe(true);
  });

  it('should block userinfo bypass URLs', () => {
    expect(isPrivateUrl('http://evil@169.254.169.254/latest/meta-data')).toBe(true);
  });

  it('should allow public URLs', () => {
    expect(isPrivateUrl('https://api.example.com/evaluate')).toBe(false);
    expect(isPrivateUrl('https://safety.openai.com/v1')).toBe(false);
  });

  it('should block IPv6 loopback', () => {
    expect(isPrivateUrl('http://[::1]/api')).toBe(true);
  });

  it('should block invalid URLs', () => {
    expect(isPrivateUrl('not-a-url')).toBe(true);
  });

  it('should block 172.16-31 range but allow 172.32+', () => {
    expect(isPrivateUrl('http://172.16.0.1/api')).toBe(true);
    expect(isPrivateUrl('http://172.31.255.255/api')).toBe(true);
    expect(isPrivateUrl('http://172.32.0.1/api')).toBe(false);
  });
});

describe('CustomHTTPProvider failMode (M-10)', () => {
  beforeEach(() => {
    mockFetch.mockReset();
  });

  it('fails closed when failMode is "closed"', async () => {
    const provider = new CustomHTTPProvider({
      name: 'strict-safety',
      url: 'https://safety-api.example.com/evaluate',
      bodyTemplate: '{"text": "{{content}}"}',
      scorePath: 'score',
      failMode: 'closed',
    });

    // Make fetch throw
    mockFetch.mockRejectedValue(new Error('Connection refused'));

    const result = await provider.evaluate({
      content: 'test content',
      category: 'toxicity',
    });

    expect(result.severity).toBe('critical');
    expect(result.score).toBe(1.0);
    expect((result.raw as Record<string, unknown>)?.failedClosed).toBe(true);
  });

  it('fails open by default (backward compat)', async () => {
    const provider = new CustomHTTPProvider({
      name: 'lenient-safety',
      url: 'https://safety-api.example.com/evaluate',
      bodyTemplate: '{"text": "{{content}}"}',
      scorePath: 'score',
      // no failMode — defaults to 'open'
    });

    // Make fetch throw
    mockFetch.mockRejectedValue(new Error('Connection refused'));

    const result = await provider.evaluate({
      content: 'test content',
      category: 'toxicity',
    });

    expect(result.severity).toBe('safe');
    expect(result.score).toBe(0);
  });

  it('fails open when failMode is explicitly "open"', async () => {
    const provider = new CustomHTTPProvider({
      name: 'explicit-open-safety',
      url: 'https://safety-api.example.com/evaluate',
      bodyTemplate: '{"text": "{{content}}"}',
      scorePath: 'score',
      failMode: 'open',
    });

    mockFetch.mockRejectedValue(new Error('Timeout'));

    const result = await provider.evaluate({
      content: 'test content',
      category: 'toxicity',
    });

    expect(result.severity).toBe('safe');
  });
});

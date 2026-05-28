import { describe, it, expect, vi, beforeEach } from 'vitest';
import { OpenAIModerationProvider } from '../../../platform/guardrails/providers/openai-moderation';

const mockFetch = vi.fn();
vi.stubGlobal('fetch', mockFetch);

function moderationResponse(
  categories: Record<string, boolean>,
  scores: Record<string, number>,
  flagged = true,
) {
  return {
    ok: true,
    status: 200,
    json: async () => ({
      results: [{ flagged, categories, category_scores: scores }],
    }),
  };
}

describe('OpenAIModerationProvider', () => {
  const provider = new OpenAIModerationProvider({
    apiKey: 'test-key',
  });

  beforeEach(() => {
    mockFetch.mockReset();
  });

  it('should have correct name and zero cost', () => {
    expect(provider.name).toBe('openai-moderation');
    expect(provider.costPerEvalUsd).toBe(0);
  });

  it('should detect hate content', async () => {
    mockFetch.mockResolvedValueOnce(
      moderationResponse(
        { hate: true, violence: false, sexual: false },
        { hate: 0.89, violence: 0.01, sexual: 0.002 },
      ),
    );

    const result = await provider.evaluate({
      content: 'hateful content',
      category: 'hate',
    });

    expect(result.score).toBeCloseTo(0.89, 2);
    expect(result.category).toBe('hate');
    expect(result.label).toBe('hate');
  });

  it('should return safe for non-flagged content', async () => {
    mockFetch.mockResolvedValueOnce(
      moderationResponse({ hate: false, violence: false }, { hate: 0.01, violence: 0.001 }, false),
    );

    const result = await provider.evaluate({
      content: 'hello world',
      category: 'hate',
    });

    expect(result.score).toBeCloseTo(0.01, 2);
    expect(result.severity).toBe('safe');
  });

  it('should return max score across all categories when category is "all"', async () => {
    mockFetch.mockResolvedValueOnce(
      moderationResponse(
        { hate: false, violence: true, sexual: false },
        { hate: 0.1, violence: 0.92, sexual: 0.05 },
      ),
    );

    const result = await provider.evaluate({
      content: 'violent content',
      category: 'all',
    });

    expect(result.score).toBeCloseTo(0.92, 2);
    expect(result.label).toBe('violence');
  });

  it('should send correct request', async () => {
    mockFetch.mockResolvedValueOnce(moderationResponse({}, {}, false));

    await provider.evaluate({ content: 'test', category: 'hate' });

    expect(mockFetch).toHaveBeenCalledWith(
      'https://api.openai.com/v1/moderations',
      expect.objectContaining({
        method: 'POST',
        headers: expect.objectContaining({
          'Content-Type': 'application/json',
          Authorization: 'Bearer test-key',
        }),
      }),
    );
  });

  it('should send content in request body as input field', async () => {
    mockFetch.mockResolvedValueOnce(moderationResponse({}, {}, false));

    await provider.evaluate({ content: 'check this text', category: 'hate' });

    const body = JSON.parse(mockFetch.mock.calls[0][1].body);
    expect(body.input).toBe('check this text');
  });

  it('should send configured model in request body when provided', async () => {
    const modelProvider = new OpenAIModerationProvider({
      apiKey: 'test-key',
      model: 'omni-moderation-latest',
    });
    mockFetch.mockResolvedValueOnce(moderationResponse({}, {}, false));

    await modelProvider.evaluate({ content: 'check this text', category: 'hate' });

    const body = JSON.parse(mockFetch.mock.calls[0][1].body);
    expect(body).toEqual({
      input: 'check this text',
      model: 'omni-moderation-latest',
    });
  });

  it('should handle API errors gracefully', async () => {
    mockFetch.mockResolvedValueOnce({ ok: false, status: 429 });

    const result = await provider.evaluate({ content: 'test', category: 'hate' });

    expect(result.score).toBe(0.0);
    expect(result.severity).toBe('safe');
  });

  it('should handle network errors gracefully', async () => {
    mockFetch.mockRejectedValueOnce(new Error('Network error'));

    const result = await provider.evaluate({ content: 'test', category: 'hate' });

    expect(result.score).toBe(0.0);
    expect(result.severity).toBe('safe');
  });

  it('should track latency', async () => {
    mockFetch.mockResolvedValueOnce(moderationResponse({}, {}, false));

    const result = await provider.evaluate({ content: 'test', category: 'hate' });
    expect(result.latencyMs).toBeGreaterThanOrEqual(0);
  });

  it('should use custom baseUrl when provided', async () => {
    const customProvider = new OpenAIModerationProvider({
      apiKey: 'test-key',
      baseUrl: 'http://my-proxy.internal',
    });

    mockFetch.mockResolvedValueOnce(moderationResponse({}, {}, false));

    await customProvider.evaluate({ content: 'test', category: 'hate' });

    expect(mockFetch).toHaveBeenCalledWith(
      'http://my-proxy.internal/v1/moderations',
      expect.anything(),
    );
  });

  it('should map subcategories with slashes correctly', async () => {
    mockFetch.mockResolvedValueOnce(
      moderationResponse(
        { 'hate/threatening': true, hate: true },
        { 'hate/threatening': 0.78, hate: 0.65 },
      ),
    );

    const result = await provider.evaluate({
      content: 'threatening hate',
      category: 'hate/threatening',
    });

    expect(result.score).toBeCloseTo(0.78, 2);
    expect(result.category).toBe('hate/threatening');
    expect(result.label).toBe('hate/threatening');
  });

  it('should return zero score when requested category is missing from response', async () => {
    mockFetch.mockResolvedValueOnce(moderationResponse({ hate: false }, { hate: 0.01 }, false));

    const result = await provider.evaluate({
      content: 'test',
      category: 'nonexistent-category',
    });

    expect(result.score).toBe(0);
    expect(result.severity).toBe('safe');
  });

  it('should include raw response for debugging', async () => {
    mockFetch.mockResolvedValueOnce(moderationResponse({ hate: true }, { hate: 0.95 }));

    const result = await provider.evaluate({
      content: 'test',
      category: 'hate',
    });

    expect(result.raw).toBeDefined();
    expect((result.raw as any).category_scores).toBeDefined();
  });

  it('should handle empty results array gracefully', async () => {
    mockFetch.mockResolvedValueOnce({
      ok: true,
      status: 200,
      json: async () => ({ results: [] }),
    });

    const result = await provider.evaluate({ content: 'test', category: 'hate' });

    expect(result.score).toBe(0.0);
    expect(result.severity).toBe('safe');
  });

  it('should set label only when category is flagged', async () => {
    mockFetch.mockResolvedValueOnce(
      moderationResponse({ hate: false, violence: false }, { hate: 0.15, violence: 0.03 }, false),
    );

    const result = await provider.evaluate({
      content: 'borderline content',
      category: 'hate',
    });

    // Score is 0.15 but category is not flagged — label should be undefined
    expect(result.score).toBeCloseTo(0.15, 2);
    expect(result.label).toBeUndefined();
  });
});

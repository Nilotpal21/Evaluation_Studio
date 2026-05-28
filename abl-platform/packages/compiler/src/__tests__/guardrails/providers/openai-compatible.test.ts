import { describe, it, expect, vi, beforeEach } from 'vitest';
import { OpenAICompatibleProvider } from '../../../platform/guardrails/providers/openai-compatible';

// Mock global fetch
const mockFetch = vi.fn();
vi.stubGlobal('fetch', mockFetch);

function mockResponse(content: string, status = 200) {
  return {
    ok: status >= 200 && status < 300,
    status,
    json: async () => ({
      choices: [{ message: { content } }],
    }),
  };
}

describe('OpenAICompatibleProvider', () => {
  const provider = new OpenAICompatibleProvider({
    name: 'test-vllm',
    baseUrl: 'http://localhost:8000',
    model: 'meta-llama/Llama-Guard-3-8B',
    apiKey: 'test-key',
    costPerEvalUsd: 0.001,
  });

  beforeEach(() => {
    mockFetch.mockReset();
  });

  it('should have correct name and cost', () => {
    expect(provider.name).toBe('test-vllm');
    expect(provider.costPerEvalUsd).toBe(0.001);
  });

  it('should parse safe response', async () => {
    mockFetch.mockResolvedValueOnce(mockResponse('safe'));

    const result = await provider.evaluate({
      content: 'Hello world',
      category: 'toxicity',
    });

    expect(result.score).toBe(0.0);
    expect(result.severity).toBe('safe');
    expect(result.category).toBe('toxicity');
  });

  it('should parse unsafe response with category', async () => {
    mockFetch.mockResolvedValueOnce(mockResponse('unsafe\nS1'));

    const result = await provider.evaluate({
      content: 'bad content',
      category: 'violence',
    });

    expect(result.score).toBe(1.0);
    expect(result.severity).not.toBe('safe');
    expect(result.label).toBe('S1');
  });

  it('should send correct request to endpoint', async () => {
    mockFetch.mockResolvedValueOnce(mockResponse('safe'));

    await provider.evaluate({
      content: 'test content',
      category: 'toxicity',
    });

    expect(mockFetch).toHaveBeenCalledWith(
      'http://localhost:8000/v1/chat/completions',
      expect.objectContaining({
        method: 'POST',
        headers: expect.objectContaining({
          'Content-Type': 'application/json',
          Authorization: 'Bearer test-key',
        }),
      }),
    );

    const body = JSON.parse(mockFetch.mock.calls[0][1].body);
    expect(body.model).toBe('meta-llama/Llama-Guard-3-8B');
    expect(body.messages).toBeDefined();
    expect(body.max_tokens).toBe(100);
    expect(body.temperature).toBe(0);
    expect(body.max_completion_tokens).toBeUndefined();
  });

  it('should omit unsupported sampling controls for OpenAI reasoning models', async () => {
    const reasoningProvider = new OpenAICompatibleProvider({
      name: 'openai-reasoning',
      baseUrl: 'http://localhost:8000',
      model: 'openai/gpt-5',
      apiKey: 'test-key',
    });
    mockFetch.mockResolvedValueOnce(mockResponse('safe'));

    await reasoningProvider.evaluate({
      content: 'test content',
      category: 'toxicity',
    });

    const body = JSON.parse(mockFetch.mock.calls[0][1].body);
    expect(body.model).toBe('openai/gpt-5');
    expect(body.max_completion_tokens).toBe(100);
    expect(body).not.toHaveProperty('max_tokens');
    expect(body).not.toHaveProperty('temperature');
  });

  it('should avoid system role for provider-prefixed o-series models', async () => {
    const reasoningProvider = new OpenAICompatibleProvider({
      name: 'openai-o-series',
      baseUrl: 'http://localhost:8000',
      model: 'openai/o3-mini',
      apiKey: 'test-key',
    });
    mockFetch.mockResolvedValueOnce(mockResponse('safe'));

    await reasoningProvider.evaluate({
      content: 'test content',
      category: 'toxicity',
    });

    const body = JSON.parse(mockFetch.mock.calls[0][1].body);
    expect(body.messages[0].role).toBe('user');
    expect(body.messages[0].content).toContain('You are a safety classifier');
    expect(body.max_completion_tokens).toBe(100);
    expect(body).not.toHaveProperty('temperature');
  });

  it('should normalize routed provider prefixes for o-series reasoning models', async () => {
    const reasoningProvider = new OpenAICompatibleProvider({
      name: 'openrouter-o-series',
      baseUrl: 'http://localhost:8000',
      model: 'openrouter/openai/o3-mini',
      apiKey: 'test-key',
    });
    mockFetch.mockResolvedValueOnce(mockResponse('safe'));

    await reasoningProvider.evaluate({
      content: 'test content',
      category: 'toxicity',
    });

    const body = JSON.parse(mockFetch.mock.calls[0][1].body);
    expect(body.messages[0].role).toBe('user');
    expect(body.max_completion_tokens).toBe(100);
    expect(body).not.toHaveProperty('max_tokens');
    expect(body).not.toHaveProperty('temperature');
  });

  it('should keep system role for non-reasoning models that start with o', async () => {
    const omniProvider = new OpenAICompatibleProvider({
      name: 'openai-omni',
      baseUrl: 'http://localhost:8000',
      model: 'openai/omni-moderation-latest',
      apiKey: 'test-key',
    });
    mockFetch.mockResolvedValueOnce(mockResponse('safe'));

    await omniProvider.evaluate({
      content: 'test content',
      category: 'toxicity',
    });

    const body = JSON.parse(mockFetch.mock.calls[0][1].body);
    expect(body.messages[0].role).toBe('system');
    expect(body.max_tokens).toBe(100);
    expect(body.temperature).toBe(0);
  });

  it('should handle API errors gracefully', async () => {
    mockFetch.mockResolvedValueOnce({
      ok: false,
      status: 500,
      json: async () => ({ error: { message: 'Internal server error' } }),
    });

    const result = await provider.evaluate({
      content: 'test',
      category: 'toxicity',
    });

    // Should fail-open on API error
    expect(result.score).toBe(0.0);
    expect(result.severity).toBe('safe');
  });

  it('should handle network errors gracefully', async () => {
    mockFetch.mockRejectedValueOnce(new Error('ECONNREFUSED'));

    const result = await provider.evaluate({
      content: 'test',
      category: 'toxicity',
    });

    expect(result.score).toBe(0.0);
    expect(result.severity).toBe('safe');
  });

  it('should check availability via health endpoint', async () => {
    mockFetch.mockResolvedValueOnce({ ok: true });

    const available = await provider.isAvailable();
    expect(available).toBe(true);
  });

  it('should report unavailable on health check failure', async () => {
    mockFetch.mockRejectedValueOnce(new Error('ECONNREFUSED'));

    const available = await provider.isAvailable();
    expect(available).toBe(false);
  });

  it('should include custom taxonomy in prompt', async () => {
    mockFetch.mockResolvedValueOnce(mockResponse('safe'));

    await provider.evaluate({
      content: 'test',
      category: 'custom',
      customTaxonomy: ['safe_topic', 'harmful_topic', 'off_topic'],
    });

    const body = JSON.parse(mockFetch.mock.calls[0][1].body);
    const systemMsg = body.messages.find((m: any) => m.role === 'system');
    expect(systemMsg?.content).toContain('safe_topic');
  });

  it('should track latency', async () => {
    mockFetch.mockResolvedValueOnce(mockResponse('safe'));

    const result = await provider.evaluate({
      content: 'test',
      category: 'toxicity',
    });

    expect(result.latencyMs).toBeGreaterThanOrEqual(0);
  });

  it('should work without apiKey (no Authorization header)', async () => {
    const noKeyProvider = new OpenAICompatibleProvider({
      name: 'local-ollama',
      baseUrl: 'http://localhost:11434',
      model: 'llama-guard',
    });

    mockFetch.mockResolvedValueOnce(mockResponse('safe'));

    await noKeyProvider.evaluate({
      content: 'test',
      category: 'toxicity',
    });

    const headers = mockFetch.mock.calls[0][1].headers;
    expect(headers).not.toHaveProperty('Authorization');
  });

  it('should default costPerEvalUsd to 0', () => {
    const defaultCostProvider = new OpenAICompatibleProvider({
      name: 'free-local',
      baseUrl: 'http://localhost:8000',
      model: 'test-model',
    });
    expect(defaultCostProvider.costPerEvalUsd).toBe(0);
  });

  it('should include recent messages in context', async () => {
    mockFetch.mockResolvedValueOnce(mockResponse('safe'));

    await provider.evaluate({
      content: 'latest message',
      category: 'toxicity',
      context: {
        recentMessages: [
          { role: 'user', content: 'first message' },
          { role: 'assistant', content: 'response' },
        ],
      },
    });

    const body = JSON.parse(mockFetch.mock.calls[0][1].body);
    // System message + 2 context messages + user message = 4 messages
    expect(body.messages.length).toBe(4);
    expect(body.messages[1].content).toBe('first message');
    expect(body.messages[2].content).toBe('response');
  });

  it('should handle ambiguous unsafe response', async () => {
    mockFetch.mockResolvedValueOnce(
      mockResponse('The content appears to be unsafe based on the guidelines'),
    );

    const result = await provider.evaluate({
      content: 'test',
      category: 'toxicity',
    });

    // Contains "unsafe" keyword but not in standard format
    expect(result.score).toBe(0.8);
    expect(result.severity).not.toBe('safe');
  });

  it('should include raw response in result', async () => {
    mockFetch.mockResolvedValueOnce(mockResponse('safe'));

    const result = await provider.evaluate({
      content: 'test',
      category: 'toxicity',
    });

    expect(result.raw).toBeDefined();
  });
});

import { afterEach, describe, expect, it, vi } from 'vitest';
import { GuardrailProviderRegistry } from '../../platform/guardrails/provider-registry';
import { BuiltinPIIProvider } from '../../platform/guardrails/providers/builtin-pii';
import { CustomHTTPProvider } from '../../platform/guardrails/providers/custom-http';
import { OpenAIModerationProvider } from '../../platform/guardrails/providers/openai-moderation';
import type {
  GuardrailModelProvider,
  GuardrailEvalRequest,
  GuardrailEvalResult,
} from '../../platform/guardrails/provider';

class MockProvider implements GuardrailModelProvider {
  readonly name: string;
  readonly costPerEvalUsd = 0;
  constructor(name: string) {
    this.name = name;
  }
  async evaluate(req: GuardrailEvalRequest): Promise<GuardrailEvalResult> {
    return { score: 0.5, severity: 'medium', category: req.category, latencyMs: 1 };
  }
  async isAvailable(): Promise<boolean> {
    return true;
  }
}

class FailingProvider implements GuardrailModelProvider {
  readonly name: string;
  readonly costPerEvalUsd = 0;
  constructor(name: string) {
    this.name = name;
  }
  async evaluate(): Promise<GuardrailEvalResult> {
    throw new Error('Provider unavailable');
  }
  async isAvailable(): Promise<boolean> {
    return false;
  }
}

class FlakyProvider implements GuardrailModelProvider {
  readonly name: string;
  readonly costPerEvalUsd = 0;
  attempts = 0;

  constructor(name: string) {
    this.name = name;
  }

  async evaluate(req: GuardrailEvalRequest): Promise<GuardrailEvalResult> {
    this.attempts += 1;
    if (this.attempts < 3) {
      throw new Error(`Transient failure ${this.attempts}`);
    }
    return { score: 0.1, severity: 'safe', category: req.category, latencyMs: 1 };
  }

  async isAvailable(): Promise<boolean> {
    return true;
  }
}

describe('GuardrailProviderRegistry', () => {
  afterEach(() => {
    vi.useRealTimers();
    vi.unstubAllGlobals();
  });

  it('should auto-register builtin-pii provider', () => {
    const registry = new GuardrailProviderRegistry();
    const pii = registry.get('builtin-pii');
    expect(pii).toBeDefined();
    expect(pii).toBeInstanceOf(BuiltinPIIProvider);
  });

  it('should register and retrieve providers', () => {
    const registry = new GuardrailProviderRegistry();
    const mock = new MockProvider('test-provider');
    registry.register(mock);
    expect(registry.get('test-provider')).toBe(mock);
  });

  it('should list all registered providers', () => {
    const registry = new GuardrailProviderRegistry();
    registry.register(new MockProvider('provider-a'));
    registry.register(new MockProvider('provider-b'));
    const names = registry.listProviders();
    expect(names).toContain('builtin-pii');
    expect(names).toContain('provider-a');
    expect(names).toContain('provider-b');
  });

  it('should return undefined for unknown provider', () => {
    const registry = new GuardrailProviderRegistry();
    expect(registry.get('nonexistent')).toBeUndefined();
  });

  it('should unregister providers', () => {
    const registry = new GuardrailProviderRegistry();
    registry.register(new MockProvider('temp'));
    expect(registry.get('temp')).toBeDefined();
    registry.unregister('temp');
    expect(registry.get('temp')).toBeUndefined();
  });

  it('should evaluate through provider with circuit breaker', async () => {
    const registry = new GuardrailProviderRegistry();
    const mock = new MockProvider('test');
    registry.register(mock);

    const result = await registry.evaluate('test', { content: 'hello', category: 'toxicity' });
    expect(result).toBeDefined();
    expect(result!.score).toBe(0.5);
  });

  it('should return undefined when evaluating unknown provider', async () => {
    const registry = new GuardrailProviderRegistry();
    const result = await registry.evaluate('nonexistent', {
      content: 'test',
      category: 'toxicity',
    });
    expect(result).toBeUndefined();
  });

  it('should handle provider evaluation failure gracefully', async () => {
    const registry = new GuardrailProviderRegistry();
    const failing = new FailingProvider('failing');
    registry.register(failing);

    const result = await registry.evaluate('failing', {
      content: 'test',
      category: 'toxicity',
    });
    // Should return safe fallback on error, not throw
    expect(result).toBeDefined();
    expect(result!.score).toBe(0.0);
    expect(result!.severity).toBe('safe');
  });

  it('should open circuit breaker after repeated failures', async () => {
    const registry = new GuardrailProviderRegistry({ failureThreshold: 2, resetTimeoutMs: 60000 });
    const failing = new FailingProvider('failing');
    registry.register(failing);

    // Two failures should open the circuit breaker
    await registry.evaluate('failing', { content: 'test', category: 'toxicity' });
    await registry.evaluate('failing', { content: 'test', category: 'toxicity' });

    // Third call should be blocked by circuit breaker (returns safe fallback without calling provider)
    const result = await registry.evaluate('failing', { content: 'test', category: 'toxicity' });
    expect(result).toBeDefined();
    expect(result!.score).toBe(0.0);
    expect(result!.severity).toBe('safe');
  });

  it('should not allow re-registering built-in provider to be unregistered and lose it', () => {
    const registry = new GuardrailProviderRegistry();
    registry.unregister('builtin-pii');
    expect(registry.get('builtin-pii')).toBeUndefined();
    // Re-register manually
    registry.register(new BuiltinPIIProvider());
    expect(registry.get('builtin-pii')).toBeDefined();
  });

  it('should replace provider when registering with same name', () => {
    const registry = new GuardrailProviderRegistry();
    const first = new MockProvider('dup');
    const second = new MockProvider('dup');
    registry.register(first);
    registry.register(second);
    expect(registry.get('dup')).toBe(second);
  });

  it('expires non-permanent providers after the registry TTL', () => {
    vi.useFakeTimers();

    const registry = new GuardrailProviderRegistry();
    registry.register(new MockProvider('ephemeral'));

    vi.advanceTimersByTime(5 * 60 * 1000 + 1);

    expect(registry.get('ephemeral')).toBeUndefined();
    expect(registry.listProviders()).not.toContain('ephemeral');
  });

  it('keeps permanent providers after the registry TTL', () => {
    vi.useFakeTimers();

    const registry = new GuardrailProviderRegistry();
    const permanent = new MockProvider('permanent');
    registry.register(permanent, { permanent: true });

    vi.advanceTimersByTime(5 * 60 * 1000 + 1);

    expect(registry.get('permanent')).toBe(permanent);
    expect(registry.listProviders()).toContain('permanent');
  });

  it('retries provider evaluation when a retry override is configured', async () => {
    const registry = new GuardrailProviderRegistry();
    const flaky = new FlakyProvider('flaky-provider');
    registry.register(flaky);

    const result = await registry.evaluate(
      'flaky-provider',
      {
        content: 'retry me',
        category: 'toxicity',
      },
      {
        providerOverride: {
          retry: { maxRetries: 2, backoffBaseMs: 0 },
        },
      },
    );

    expect(result).toBeDefined();
    expect(result!.score).toBe(0.1);
    expect(flaky.attempts).toBe(3);
  });

  it('stores runtime provider config supplied at registration', () => {
    const registry = new GuardrailProviderRegistry();
    registry.register(new MockProvider('configured-provider'), {
      runtimeConfig: {
        defaultCategory: 'self_harm',
        defaultThreshold: 0.82,
        costPerEvalUsd: 0.12,
        circuitBreaker: { failureThreshold: 2, resetTimeoutMs: 45_000 },
        retry: { maxRetries: 3, backoffBaseMs: 25 },
      },
    });

    expect(registry.getRuntimeConfig('configured-provider')).toEqual({
      defaultCategory: 'self_harm',
      defaultThreshold: 0.82,
      costPerEvalUsd: 0.12,
      circuitBreaker: { failureThreshold: 2, resetTimeoutMs: 45_000 },
      retry: { maxRetries: 3, backoffBaseMs: 25 },
    });
  });

  it('applies registered retry defaults when no per-policy override is supplied', async () => {
    const registry = new GuardrailProviderRegistry();
    const flaky = new FlakyProvider('registered-retry-provider');
    registry.register(flaky, {
      runtimeConfig: {
        retry: { maxRetries: 2, backoffBaseMs: 0 },
      },
    });

    const result = await registry.evaluate('registered-retry-provider', {
      content: 'retry me',
      category: 'toxicity',
    });

    expect(result).toBeDefined();
    expect(result!.score).toBe(0.1);
    expect(flaky.attempts).toBe(3);
  });

  it('uses registered provider failMode when no per-call failMode is supplied', async () => {
    const registry = new GuardrailProviderRegistry();
    registry.register(new FailingProvider('closed-provider'), {
      runtimeConfig: {
        circuitBreaker: {
          failureThreshold: 1,
          resetTimeoutMs: 60_000,
          failMode: 'closed',
        },
      },
    });

    const result = await registry.evaluate('closed-provider', {
      content: 'test',
      category: 'toxicity',
    });

    expect(result).toBeDefined();
    expect(result!.score).toBe(1.0);
    expect(result!.severity).toBe('critical');
  });

  it('uses the overridden endpoint for runtime-overrideable providers', async () => {
    const fetchMock = vi.fn().mockResolvedValue(
      new Response(JSON.stringify({ score: 0.2, severity: 'safe', category: 'toxicity' }), {
        status: 200,
        headers: { 'Content-Type': 'application/json' },
      }),
    );
    vi.stubGlobal('fetch', fetchMock);

    const registry = new GuardrailProviderRegistry();
    registry.register(
      new CustomHTTPProvider({
        name: 'custom-http',
        url: 'https://primary.example.com/eval',
        bodyTemplate: '{"content":"{{content}}","category":"{{category}}"}',
        scorePath: 'score',
      }),
    );

    const result = await registry.evaluate(
      'custom-http',
      {
        content: 'test',
        category: 'toxicity',
      },
      {
        providerOverride: {
          endpoint: 'https://override.example.com/eval',
        },
      },
    );

    expect(result).toBeDefined();
    expect(fetchMock).toHaveBeenCalledWith(
      'https://override.example.com/eval',
      expect.objectContaining({
        method: 'POST',
      }),
    );
  });

  it('applies endpoint overrides to OpenAI moderation providers', async () => {
    const fetchMock = vi.fn().mockResolvedValue({
      ok: true,
      json: async () => ({
        results: [
          {
            flagged: true,
            categories: { hate: true },
            category_scores: { hate: 0.75 },
          },
        ],
      }),
    });
    vi.stubGlobal('fetch', fetchMock);

    const registry = new GuardrailProviderRegistry();
    registry.register(
      new OpenAIModerationProvider({
        name: 'openai-moderation-primary',
        apiKey: 'test-key',
        endpoint: 'https://primary.example.com/moderations',
      }),
    );

    const result = await registry.evaluate(
      'openai-moderation-primary',
      {
        content: 'unsafe content',
        category: 'hate',
      },
      {
        providerOverride: {
          endpoint: 'https://override.example.com/moderations',
        },
      },
    );

    expect(result!.score).toBe(0.75);
    expect(fetchMock).toHaveBeenCalledWith(
      'https://override.example.com/moderations',
      expect.any(Object),
    );
  });
});

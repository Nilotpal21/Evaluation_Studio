import { describe, expect, it, beforeEach, afterEach } from 'vitest';

import {
  OpenAiApiExecutor,
  MODEL_PRICING_USD,
  mapSseDeltaToStreamEvent,
} from '../models/openai-api-executor.js';
import type {
  OpenAiStreamChunkLike,
  OpenAiClientLike,
  OpenAiChatCompletionLike,
} from '../models/openai-api-executor.js';
import { ModelRouter } from '../models/model-router.js';
import type { ExecutorResult, StreamEvent } from '../types.js';
import { makeFakeOpenAiClient } from './test-helpers/plan-fixtures.js';

// ── Env save/restore ────────────────────────────────────────────
let savedApiKey: string | undefined;

beforeEach(() => {
  savedApiKey = process.env.OPENAI_API_KEY;
});

afterEach(() => {
  if (savedApiKey !== undefined) {
    process.env.OPENAI_API_KEY = savedApiKey;
  } else {
    delete process.env.OPENAI_API_KEY;
  }
});

// ─── UT-1: MODEL_PRICING_USD Lookups ────────────────────────────

describe('UT-1: MODEL_PRICING_USD lookups', () => {
  it('returns populated rates for known model gpt-5', () => {
    const pricing = MODEL_PRICING_USD['gpt-5'];
    expect(pricing).toBeDefined();
    expect(pricing.inputUsdPer1M).toBe(10.0);
    expect(pricing.outputUsdPer1M).toBe(30.0);
    expect(pricing.reasoningUsdPer1M).toBe(30.0);
  });

  it('returns populated rates for known model gpt-5.5', () => {
    const pricing = MODEL_PRICING_USD['gpt-5.5'];
    expect(pricing).toBeDefined();
    expect(pricing.inputUsdPer1M).toBe(2.0);
    expect(pricing.outputUsdPer1M).toBe(8.0);
  });

  it('returns populated rates for known model gpt-4o', () => {
    const pricing = MODEL_PRICING_USD['gpt-4o'];
    expect(pricing).toBeDefined();
    expect(pricing.inputUsdPer1M).toBe(2.5);
    expect(pricing.outputUsdPer1M).toBe(10.0);
    expect(pricing.reasoningUsdPer1M).toBeUndefined();
  });

  it('returns populated rates for known model gpt-4o-mini', () => {
    const pricing = MODEL_PRICING_USD['gpt-4o-mini'];
    expect(pricing).toBeDefined();
    expect(pricing.inputUsdPer1M).toBe(0.15);
    expect(pricing.outputUsdPer1M).toBe(0.6);
  });

  it('returns undefined for unknown model (fallback behavior)', () => {
    const pricing = MODEL_PRICING_USD['gpt-nonexistent'];
    expect(pricing).toBeUndefined();
  });
});

// ─── UT-2: Stream Event Mapper ──────────────────────────────────

describe('UT-2: mapSseDeltaToStreamEvent', () => {
  it('maps content.delta to output event', () => {
    const chunk: OpenAiStreamChunkLike = {
      id: 'test',
      choices: [{ delta: { content: 'Hello world' }, finish_reason: null }],
    };
    const event = mapSseDeltaToStreamEvent(chunk, 1);
    expect(event).not.toBeNull();
    expect(event!.type).toBe('output');
    expect(event!.message).toContain('Hello world');
    expect(event!.message).toContain('[turn 1]');
    expect(event!.timestamp).toBeDefined();
  });

  it('maps reasoning.delta to progress event', () => {
    const chunk: OpenAiStreamChunkLike = {
      id: 'test',
      choices: [{ delta: { reasoning: 'Thinking about this...' }, finish_reason: null }],
    };
    const event = mapSseDeltaToStreamEvent(chunk, 2);
    expect(event).not.toBeNull();
    expect(event!.type).toBe('progress');
    expect(event!.message).toContain('thinking...');
    expect(event!.message).toContain('[turn 2]');
  });

  it('maps usage-only chunk to null (no event to emit)', () => {
    const chunk: OpenAiStreamChunkLike = {
      id: 'test',
      usage: { prompt_tokens: 100, completion_tokens: 50, total_tokens: 150 },
    };
    const event = mapSseDeltaToStreamEvent(chunk, 1);
    expect(event).toBeNull();
  });

  it('maps finish_reason to complete event', () => {
    const chunk: OpenAiStreamChunkLike = {
      id: 'test',
      choices: [{ delta: {}, finish_reason: 'stop' }],
    };
    const event = mapSseDeltaToStreamEvent(chunk, 1);
    expect(event).not.toBeNull();
    expect(event!.type).toBe('complete');
    expect(event!.message).toContain('stop');
  });

  it('returns null for empty delta with no finish_reason', () => {
    const chunk: OpenAiStreamChunkLike = {
      id: 'test',
      choices: [{ delta: {}, finish_reason: null }],
    };
    const event = mapSseDeltaToStreamEvent(chunk, 1);
    expect(event).toBeNull();
  });

  it('truncates long content to 200 characters in event message', () => {
    const longContent = 'x'.repeat(300);
    const chunk: OpenAiStreamChunkLike = {
      id: 'test',
      choices: [{ delta: { content: longContent }, finish_reason: null }],
    };
    const event = mapSseDeltaToStreamEvent(chunk, 1);
    expect(event).not.toBeNull();
    expect(event!.message).toContain('...');
    // The preview portion should be at most 200 chars of the actual content
    expect(event!.message.length).toBeLessThan(longContent.length);
  });
});

// ─── UT-3: computeCostUsd (via round-trip) ──────────────────────

describe('UT-3: cost computation', () => {
  it('computes cost correctly for gpt-5 with reasoning tokens', async () => {
    process.env.OPENAI_API_KEY = 'sk-test-cost-calc';
    const client = makeFakeOpenAiClient({
      chatCompletionsCreate: async () => ({
        id: 'test',
        choices: [{ message: { content: 'output' }, finish_reason: 'stop' }],
        usage: {
          prompt_tokens: 1_000_000,
          completion_tokens: 500_000,
          total_tokens: 1_500_000,
          completion_tokens_details: { reasoning_tokens: 200_000 },
        },
      }),
    });

    const executor = new OpenAiApiExecutor('/tmp', () => Promise.resolve(client));
    const result = await executor.execute('test', { engine: 'openai-api', model: 'gpt-5' });

    // input: 1M tokens * $10/1M = $10
    // non-reasoning output: 300K * $30/1M = $9
    // reasoning: 200K * $30/1M = $6
    // total = $25
    expect(result.costUsd).toBeCloseTo(25.0, 2);
  });

  it('returns zero cost for zero tokens', async () => {
    process.env.OPENAI_API_KEY = 'sk-test-zero-tokens';
    const client = makeFakeOpenAiClient({
      chatCompletionsCreate: async () => ({
        id: 'test',
        choices: [{ message: { content: 'output' }, finish_reason: 'stop' }],
        usage: {
          prompt_tokens: 0,
          completion_tokens: 0,
          total_tokens: 0,
          completion_tokens_details: { reasoning_tokens: 0 },
        },
      }),
    });

    const executor = new OpenAiApiExecutor('/tmp', () => Promise.resolve(client));
    const result = await executor.execute('test', { engine: 'openai-api', model: 'gpt-5' });
    expect(result.costUsd).toBe(0);
  });

  it('returns undefined cost for missing usage', async () => {
    process.env.OPENAI_API_KEY = 'sk-test-missing-usage';
    const client = makeFakeOpenAiClient({
      chatCompletionsCreate: async () => ({
        id: 'test',
        choices: [{ message: { content: 'output' }, finish_reason: 'stop' }],
        usage: null,
      }),
    });

    const executor = new OpenAiApiExecutor('/tmp', () => Promise.resolve(client));
    const result = await executor.execute('test', { engine: 'openai-api', model: 'gpt-5' });
    expect(result.costUsd).toBeUndefined();
  });

  it('returns undefined cost for unknown model with stderr warning', async () => {
    process.env.OPENAI_API_KEY = 'sk-test-unknown-model';
    const client = makeFakeOpenAiClient({
      chatCompletionsCreate: async () => ({
        id: 'test',
        choices: [{ message: { content: 'output' }, finish_reason: 'stop' }],
        usage: {
          prompt_tokens: 1000,
          completion_tokens: 500,
          total_tokens: 1500,
        },
      }),
    });

    const executor = new OpenAiApiExecutor('/tmp', () => Promise.resolve(client));
    const result = await executor.execute('test', {
      engine: 'openai-api',
      model: 'gpt-nonexistent',
    });
    expect(result.costUsd).toBeUndefined();
  });
});

// ─── UT-10: isAvailable() ───────────────────────────────────────

describe('UT-10: isAvailable()', () => {
  it('returns true when OPENAI_API_KEY is a non-empty string', async () => {
    process.env.OPENAI_API_KEY = 'sk-test-availability';
    const executor = new OpenAiApiExecutor('/tmp');
    expect(await executor.isAvailable()).toBe(true);
  });

  it('returns false when OPENAI_API_KEY is unset', async () => {
    delete process.env.OPENAI_API_KEY;
    const executor = new OpenAiApiExecutor('/tmp');
    expect(await executor.isAvailable()).toBe(false);
  });

  it('returns false when OPENAI_API_KEY is empty string', async () => {
    process.env.OPENAI_API_KEY = '';
    const executor = new OpenAiApiExecutor('/tmp');
    expect(await executor.isAvailable()).toBe(false);
  });
});

// ─── INT-1: Round-Trip With Fake Client ─────────────────────────

describe('INT-1: round-trip with injected fake client', () => {
  it('populates ExecutorResult with output, costUsd, turnsUsed, duration', async () => {
    process.env.OPENAI_API_KEY = 'sk-test-roundtrip';
    const client = makeFakeOpenAiClient({ trackCalls: true });
    const executor = new OpenAiApiExecutor('/tmp', () => Promise.resolve(client));

    const result = await executor.execute('Analyze this code', {
      engine: 'openai-api',
      model: 'gpt-5',
    });

    expect(result.output).toBeTruthy();
    expect(result.engine).toBe('openai-api');
    expect(result.model).toBe('gpt-5');
    expect(result.turnsUsed).toBeGreaterThanOrEqual(1);
    expect(result.durationMs).toBeGreaterThanOrEqual(0);
    expect(result.error).toBeUndefined();
    expect(client._calls).toHaveLength(1);
  });

  it('emits streaming events via onStream callback', async () => {
    process.env.OPENAI_API_KEY = 'sk-test-streaming';
    const events: StreamEvent[] = [];
    const client = makeFakeOpenAiClient();
    const executor = new OpenAiApiExecutor('/tmp', () => Promise.resolve(client));

    const result = await executor.execute(
      'test prompt',
      { engine: 'openai-api', model: 'gpt-5' },
      undefined,
      (event) => events.push(event),
    );

    expect(result.error).toBeUndefined();
    expect(events.length).toBeGreaterThan(0);
    expect(events.some((e) => e.type === 'output' || e.type === 'complete')).toBe(true);
  });

  it('propagates abort via abortSignal', async () => {
    process.env.OPENAI_API_KEY = 'sk-test-abort';
    const abortController = new AbortController();

    const client = makeFakeOpenAiClient({
      chatCompletionsCreate: async () => {
        // Create an async iterable that yields after a delay
        return (async function* (): AsyncIterable<OpenAiStreamChunkLike> {
          yield { choices: [{ delta: { content: 'partial' }, finish_reason: null }] };
          // Abort before next chunk
          abortController.abort();
          // This chunk should not be processed after abort
          yield { choices: [{ delta: { content: ' more' }, finish_reason: null }] };
          yield { choices: [{ delta: {}, finish_reason: 'stop' }] };
          yield { usage: { prompt_tokens: 10, completion_tokens: 5 } };
        })();
      },
    });

    const events: StreamEvent[] = [];
    const executor = new OpenAiApiExecutor('/tmp', () => Promise.resolve(client));
    const result = await executor.execute(
      'test',
      { engine: 'openai-api', model: 'gpt-5' },
      undefined,
      (event) => events.push(event),
      undefined,
      undefined,
      abortController.signal,
    );

    expect(result.error).toContain('aborted');
  });

  it('passes response_format for structured output when outputSchema is set', async () => {
    process.env.OPENAI_API_KEY = 'sk-test-structured';
    const client = makeFakeOpenAiClient({
      trackCalls: true,
      chatCompletionsCreate: async () => ({
        id: 'test',
        choices: [
          {
            message: { content: '{"summary":"ok","findings":[],"decisions":[]}' },
            finish_reason: 'stop',
          },
        ],
        usage: { prompt_tokens: 100, completion_tokens: 50 },
      }),
    });

    const executor = new OpenAiApiExecutor('/tmp', () => Promise.resolve(client));
    await executor.execute('test', { engine: 'openai-api', model: 'gpt-5' }, undefined, undefined, {
      id: 'oracle-review',
      strict: true,
    });

    expect(client._calls).toHaveLength(1);
    const params = client._calls[0].args;
    expect(params['response_format']).toBeDefined();
    const rf = params['response_format'] as Record<string, unknown>;
    expect(rf['type']).toBe('json_schema');
  });

  it('returns BudgetExceededError in result.error when budget cap is hit', async () => {
    process.env.OPENAI_API_KEY = 'sk-test-budget';
    const client = makeFakeOpenAiClient({
      chatCompletionsCreate: async () => ({
        id: 'test',
        choices: [{ message: { content: 'expensive output' }, finish_reason: 'stop' }],
        usage: {
          prompt_tokens: 1_000_000,
          completion_tokens: 1_000_000,
          total_tokens: 2_000_000,
          completion_tokens_details: { reasoning_tokens: 0 },
        },
      }),
    });

    const executor = new OpenAiApiExecutor('/tmp', () => Promise.resolve(client));
    const result = await executor.execute('test', {
      engine: 'openai-api',
      model: 'gpt-5',
      maxBudgetUsd: 0.01,
    });

    // cost = 1M*10/1M + 1M*30/1M = $40, well above $0.01
    expect(result.error).toContain('BudgetExceededError');
  });
});

// ─── INT-11: Error-Path Matrix ──────────────────────────────────

describe('INT-11: error-path matrix', () => {
  it('429 rate limit returns ExecutorResult with error, does not throw', async () => {
    process.env.OPENAI_API_KEY = 'sk-test-429';
    const client = makeFakeOpenAiClient({
      shouldFail: { code: 'rate_limit', statusCode: 429 },
    });

    const executor = new OpenAiApiExecutor('/tmp', () => Promise.resolve(client));
    const result = await executor.execute('test', { engine: 'openai-api', model: 'gpt-5' });

    expect(result.error).toBeTruthy();
    expect(result.error).toContain('rate_limit');
    expect(result.output).toBe('');
  });

  it('500 server error returns ExecutorResult with error, does not throw', async () => {
    process.env.OPENAI_API_KEY = 'sk-test-500';
    const client = makeFakeOpenAiClient({
      shouldFail: { code: 'internal_server_error', statusCode: 500 },
    });

    const executor = new OpenAiApiExecutor('/tmp', () => Promise.resolve(client));
    const result = await executor.execute('test', { engine: 'openai-api', model: 'gpt-5' });

    expect(result.error).toBeTruthy();
    expect(result.error).toContain('internal_server_error');
    expect(result.output).toBe('');
  });

  it('malformed SSE chunk is skipped without crash', async () => {
    process.env.OPENAI_API_KEY = 'sk-test-malformed';
    const events: StreamEvent[] = [];
    const client = makeFakeOpenAiClient({
      chatCompletionsCreate: async () =>
        (async function* (): AsyncIterable<OpenAiStreamChunkLike> {
          yield { choices: [{ delta: { content: 'good' }, finish_reason: null }] };
          // Malformed chunk — no delta, no choices
          yield {} as OpenAiStreamChunkLike;
          yield { choices: [{ delta: { content: ' data' }, finish_reason: null }] };
          yield { choices: [{ delta: {}, finish_reason: 'stop' }] };
          yield { usage: { prompt_tokens: 10, completion_tokens: 5 } };
        })(),
    });

    const executor = new OpenAiApiExecutor('/tmp', () => Promise.resolve(client));
    const result = await executor.execute(
      'test',
      { engine: 'openai-api', model: 'gpt-5' },
      undefined,
      (event) => events.push(event),
    );

    expect(result.error).toBeUndefined();
    expect(result.output).toContain('good');
    expect(result.output).toContain('data');
  });

  it('budget-exceeded mid-stream returns ExecutorResult with BudgetExceededError', async () => {
    process.env.OPENAI_API_KEY = 'sk-test-budget-stream';
    const events: StreamEvent[] = [];
    const client = makeFakeOpenAiClient({
      chatCompletionsCreate: async () =>
        (async function* (): AsyncIterable<OpenAiStreamChunkLike> {
          yield { choices: [{ delta: { content: 'output' }, finish_reason: null }] };
          yield { choices: [{ delta: {}, finish_reason: 'stop' }] };
          yield {
            usage: {
              prompt_tokens: 1_000_000,
              completion_tokens: 1_000_000,
              total_tokens: 2_000_000,
              completion_tokens_details: { reasoning_tokens: 0 },
            },
          };
        })(),
    });

    const executor = new OpenAiApiExecutor('/tmp', () => Promise.resolve(client));
    const result = await executor.execute(
      'test',
      { engine: 'openai-api', model: 'gpt-5', maxBudgetUsd: 0.01 },
      undefined,
      (event) => events.push(event),
    );

    expect(result.error).toContain('BudgetExceededError');
  });

  it('client factory failure returns ExecutorResult with error', async () => {
    process.env.OPENAI_API_KEY = 'sk-test-factory-fail';
    const executor = new OpenAiApiExecutor('/tmp', () =>
      Promise.reject(new Error('SDK init failed')),
    );
    const result = await executor.execute('test', { engine: 'openai-api', model: 'gpt-5' });

    expect(result.error).toContain('Failed to initialize OpenAI client');
    expect(result.error).toContain('SDK init failed');
  });
});

// ─── SEC-1: API Key Non-Persistence ─────────────────────────────

describe('SEC-1: API key non-persistence', () => {
  it('marker key value never appears in any emitted StreamEvent or ExecutorResult', async () => {
    const marker = 'sk-test-MARKER-abc';
    process.env.OPENAI_API_KEY = marker;

    const events: StreamEvent[] = [];
    const client = makeFakeOpenAiClient();
    const executor = new OpenAiApiExecutor('/tmp', () => Promise.resolve(client));

    const result = await executor.execute(
      'test prompt with some content',
      { engine: 'openai-api', model: 'gpt-5' },
      undefined,
      (event) => events.push(event),
    );

    // Check no event contains the marker
    for (const event of events) {
      expect(event.message).not.toContain(marker);
    }

    // Check result fields
    expect(result.output).not.toContain(marker);
    if (result.error) {
      expect(result.error).not.toContain(marker);
    }
  });
});

// ─── SEC-2: Stream Event Redaction ──────────────────────────────

describe('SEC-2: stream event redaction', () => {
  it('request/response bodies are not interpolated into StreamEvent.message', async () => {
    const secretKey = 'sk-proj-SECRETVALUE12345678901234567890';
    process.env.OPENAI_API_KEY = 'sk-test-redact';

    const events: StreamEvent[] = [];
    const client = makeFakeOpenAiClient({
      chatCompletionsCreate: async () =>
        (async function* (): AsyncIterable<OpenAiStreamChunkLike> {
          // Emit content that contains a secret-like pattern
          yield {
            choices: [
              {
                delta: {
                  content: `The API key is ${secretKey}`,
                },
                finish_reason: null,
              },
            ],
          };
          yield { choices: [{ delta: {}, finish_reason: 'stop' }] };
          yield { usage: { prompt_tokens: 10, completion_tokens: 5 } };
        })(),
    });

    const executor = new OpenAiApiExecutor('/tmp', () => Promise.resolve(client));
    await executor.execute('test', { engine: 'openai-api', model: 'gpt-5' }, undefined, (event) =>
      events.push(event),
    );

    // The secret pattern should be redacted in event messages
    for (const event of events) {
      expect(event.message).not.toContain(secretKey);
    }
  });
});

// ─── SEC-3: Unavailable → Graceful Error ────────────────────────

describe('SEC-3: unavailable engine returns graceful error', () => {
  it('ModelRouter returns ExecutorResult with non-empty error, no stack trace, no key echo', async () => {
    delete process.env.OPENAI_API_KEY;

    const router = new ModelRouter('/nonexistent-codex', '/tmp');
    const result = await router.execute(
      'test prompt',
      { primary: { engine: 'openai-api', model: 'gpt-5' } },
      [],
    );

    expect(result.error).toBeTruthy();
    expect(result.error).toContain('not available');
    // No stack trace frames
    expect(result.error).not.toMatch(/at\s+\S+:\d+:\d+/);
    // No env var key names
    expect(result.error).not.toContain('OPENAI_API_KEY');
    expect(result.error).not.toContain('process.env');
  });
});

// ─── PERF-2: Streaming Backpressure ─────────────────────────────

describe('PERF-2: 1000 SSE chunks streaming backpressure', () => {
  it('processes 1000 chunks without error and onStream called for each content event', async () => {
    process.env.OPENAI_API_KEY = 'sk-test-perf';
    const chunkCount = 1000;

    const client = makeFakeOpenAiClient({
      chatCompletionsCreate: async () =>
        (async function* (): AsyncIterable<OpenAiStreamChunkLike> {
          for (let i = 0; i < chunkCount; i++) {
            yield {
              choices: [{ delta: { content: `chunk-${i} ` }, finish_reason: null }],
            };
          }
          yield { choices: [{ delta: {}, finish_reason: 'stop' }] };
          yield { usage: { prompt_tokens: 1000, completion_tokens: chunkCount } };
        })(),
    });

    const events: StreamEvent[] = [];
    const executor = new OpenAiApiExecutor('/tmp', () => Promise.resolve(client));
    const result = await executor.execute(
      'test',
      { engine: 'openai-api', model: 'gpt-4o-mini' },
      undefined,
      (event) => events.push(event),
    );

    expect(result.error).toBeUndefined();
    expect(result.output).toBeTruthy();

    // Each content chunk maps to an output event, plus the finish_reason maps to a complete event
    const contentEvents = events.filter((e) => e.type === 'output');
    const completeEvents = events.filter((e) => e.type === 'complete');
    expect(contentEvents).toHaveLength(chunkCount);
    expect(completeEvents).toHaveLength(1);
  });
});

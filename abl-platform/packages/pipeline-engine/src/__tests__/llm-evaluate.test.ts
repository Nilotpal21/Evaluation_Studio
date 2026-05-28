import { describe, test, expect, vi, beforeEach } from 'vitest';
import type { PipelineStepContext, StepOutput } from '../pipeline/types.js';

// ---------------------------------------------------------------------------
// Mocks
// ---------------------------------------------------------------------------

const mockGenerateText = vi.fn();
vi.mock('../pipeline/services/llm-client-factory.js', () => ({
  PipelineLLMResolutionError: class PipelineLLMResolutionError extends Error {},
  isPipelineLLMResolutionError: () => false,
  resolvePipelineLLM: () =>
    Promise.resolve({
      provider: 'openai',
      modelId: 'gpt-4o-mini',
      apiKey: 'test-key',
      source: 'tenant' as const,
    }),
}));
vi.mock('@agent-platform/llm', () => ({
  createVercelProvider: () => 'mock-model',
  generateText: (...args: any[]) => mockGenerateText(...args),
}));

const mockInsert = vi.fn().mockResolvedValue(undefined);
vi.mock('@agent-platform/database/clickhouse', () => ({
  getClickHouseClient: () => ({ insert: mockInsert }),
}));

vi.mock('@abl/compiler/platform', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@abl/compiler/platform')>();
  return {
    ...actual,
    createLogger: () => ({
      debug: vi.fn(),
      info: vi.fn(),
      warn: vi.fn(),
      error: vi.fn(),
    }),
    parseJSON: (text: string) => {
      try {
        const m = text.match(/```(?:json)?\s*([\s\S]*?)```/) || [null, text];
        const clean = (m[1] || text).trim();
        const s = clean.indexOf('{');
        const e = clean.lastIndexOf('}');
        if (s === -1 || e === -1) return null;
        return JSON.parse(clean.substring(s, e + 1));
      } catch {
        return null;
      }
    },
  };
});

const { llmEvaluateService } = await import('../pipeline/services/llm-evaluate.service.js');

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function ctx(): any {
  return {
    run: async (_label: string, fn: () => any) => fn(),
    console: { log: () => {} },
  };
}

function getExecute(svc: any): (ctx: any, input: PipelineStepContext) => Promise<StepOutput> {
  return (svc as any).service.execute;
}

const execute = getExecute(llmEvaluateService);

function makeInput(overrides: Partial<PipelineStepContext> = {}): PipelineStepContext {
  return {
    tenantId: 'acme-corp',
    projectId: 'support-bot',
    sessionId: 'sess-001',
    config: {
      tag: 'test_eval',
      systemPrompt: 'You are a helpful analyst.',
      userPrompt: 'Analyze this conversation.',
    },
    previousSteps: {},
    pipelineInput: {
      tenantId: 'acme-corp',
      projectId: 'support-bot',
      sessionId: 'sess-001',
    },
    ...overrides,
  };
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('LLMEvaluate service', () => {
  beforeEach(() => {
    mockGenerateText.mockReset();
    mockInsert.mockClear();
  });

  test('calls LLM, extracts score, and writes to ClickHouse', async () => {
    mockGenerateText.mockResolvedValue({
      text: '{"score": 0.85, "summary": "Good extraction"}',
      usage: { inputTokens: 100, outputTokens: 25 },
    });

    const result = await execute(ctx(), makeInput());

    expect(result.status).toBe('success');
    expect(result.data.score).toBe(0.85);
    expect(result.data.tag).toBe('test_eval');

    // Verify ClickHouse write
    expect(mockInsert).toHaveBeenCalledTimes(1);
    const insertCall = mockInsert.mock.calls[0][0];
    expect(insertCall.table).toBe('abl_platform.llm_evaluate');
    const row = insertCall.values[0];
    expect(row.tag).toBe('test_eval');
    expect(row.score).toBe(0.85);
    expect(row.tenant_id).toBe('acme-corp');
  });

  test('uses custom scoreField to extract score', async () => {
    mockGenerateText.mockResolvedValue({
      text: '{"quality": 0.72, "details": "some info"}',
      usage: { inputTokens: 80, outputTokens: 20 },
    });

    const input = makeInput({
      config: {
        tag: 'custom_score',
        systemPrompt: 'Evaluate quality.',
        userPrompt: 'Check this.',
        scoreField: 'quality',
      },
    });

    const result = await execute(ctx(), input);

    expect(result.status).toBe('success');
    expect(result.data.score).toBe(0.72);
    const row = mockInsert.mock.calls[0][0].values[0];
    expect(row.score).toBe(0.72);
  });

  test('stores null score when scoreField is missing from output', async () => {
    mockGenerateText.mockResolvedValue({
      text: '{"analysis": "done"}',
      usage: { inputTokens: 50, outputTokens: 10 },
    });

    const result = await execute(ctx(), makeInput());

    expect(result.status).toBe('success');
    expect(result.data.score).toBeNull();
    const row = mockInsert.mock.calls[0][0].values[0];
    expect(row.score).toBeNull();
  });

  test('resolves {{...}} template variables in userPrompt', async () => {
    mockGenerateText.mockResolvedValue({
      text: '{"score": 0.9}',
      usage: { inputTokens: 120, outputTokens: 10 },
    });

    const input = makeInput({
      config: {
        tag: 'template_test',
        systemPrompt: 'Evaluate.',
        userPrompt: 'Analyze:\n\n{{steps.read-conversation.output.transcript}}',
      },
      previousSteps: {
        'read-conversation': {
          status: 'success',
          data: { transcript: 'User: Hello\nAssistant: Hi!' },
        },
      },
    });

    const result = await execute(ctx(), input);

    expect(result.status).toBe('success');
    const callArgs = mockGenerateText.mock.calls[0][0];
    expect(callArgs.messages[0].content).toContain('User: Hello\nAssistant: Hi!');
  });

  test('injects outputSchema into system prompt', async () => {
    mockGenerateText.mockResolvedValue({
      text: '{"score": 0.8, "count": 5}',
      usage: { inputTokens: 150, outputTokens: 15 },
    });

    const schema = {
      type: 'object',
      properties: {
        score: { type: 'number' },
        count: { type: 'number' },
      },
      required: ['score', 'count'],
    };

    const input = makeInput({
      config: {
        tag: 'schema_test',
        systemPrompt: 'You are an evaluator.',
        userPrompt: 'Evaluate this.',
        outputSchema: schema,
      },
    });

    const result = await execute(ctx(), input);

    expect(result.status).toBe('success');
    const callArgs = mockGenerateText.mock.calls[0][0];
    expect(callArgs.system).toContain('You are an evaluator.');
    expect(callArgs.system).toContain('"score"');
    expect(callArgs.system).toContain('You MUST respond with valid JSON');
  });

  test('strict mode retries on invalid JSON', async () => {
    mockGenerateText
      .mockResolvedValueOnce({
        text: 'not json at all',
        usage: { inputTokens: 50, outputTokens: 10 },
      })
      .mockResolvedValueOnce({
        text: '{"score": 0.7}',
        usage: { inputTokens: 80, outputTokens: 15 },
      });

    const input = makeInput({
      config: {
        tag: 'strict_json_test',
        systemPrompt: 'Evaluate.',
        userPrompt: 'Check this.',
        outputSchema: {
          type: 'object',
          properties: { score: { type: 'number' } },
        },
        strict: true,
      },
    });

    const result = await execute(ctx(), input);

    expect(result.status).toBe('success');
    expect(result.data.score).toBe(0.7);
    expect(mockGenerateText).toHaveBeenCalledTimes(2);
    // Second call should contain error feedback
    const retryCall = mockGenerateText.mock.calls[1][0];
    const lastMsg = retryCall.messages[retryCall.messages.length - 1];
    expect(lastMsg.content).toContain('not valid JSON');
  });

  test('strict mode retries on schema validation failure', async () => {
    mockGenerateText
      .mockResolvedValueOnce({
        text: '{"wrong_field": true}',
        usage: { inputTokens: 50, outputTokens: 10 },
      })
      .mockResolvedValueOnce({
        text: '{"score": 0.6, "count": 3}',
        usage: { inputTokens: 80, outputTokens: 15 },
      });

    const input = makeInput({
      config: {
        tag: 'strict_schema_test',
        systemPrompt: 'Evaluate.',
        userPrompt: 'Check this.',
        outputSchema: {
          type: 'object',
          properties: {
            score: { type: 'number' },
            count: { type: 'number' },
          },
          required: ['score', 'count'],
        },
        strict: true,
      },
    });

    const result = await execute(ctx(), input);

    expect(result.status).toBe('success');
    expect(result.data.score).toBe(0.6);
    expect(mockGenerateText).toHaveBeenCalledTimes(2);
    const retryCall = mockGenerateText.mock.calls[1][0];
    const lastMsg = retryCall.messages[retryCall.messages.length - 1];
    expect(lastMsg.content).toContain('did not match the required schema');
  });

  test('strict mode gives up after max retries', async () => {
    mockGenerateText.mockResolvedValue({
      text: 'always invalid',
      usage: { inputTokens: 50, outputTokens: 10 },
    });

    const input = makeInput({
      config: {
        tag: 'strict_giveup',
        systemPrompt: 'Evaluate.',
        userPrompt: 'Check this.',
        outputSchema: {
          type: 'object',
          properties: { score: { type: 'number' } },
        },
        strict: true,
      },
    });

    const result = await execute(ctx(), input);

    expect(result.status).toBe('fail');
    expect(mockGenerateText).toHaveBeenCalledTimes(3); // 1 initial + 2 retries
  });

  test('non-strict mode does not retry on schema mismatch', async () => {
    mockGenerateText.mockResolvedValue({
      text: '{"wrong": true}',
      usage: { inputTokens: 50, outputTokens: 10 },
    });

    const input = makeInput({
      config: {
        tag: 'nonstrict_test',
        systemPrompt: 'Evaluate.',
        userPrompt: 'Check this.',
        outputSchema: {
          type: 'object',
          properties: { score: { type: 'number' } },
          required: ['score'],
        },
        strict: false,
      },
    });

    const result = await execute(ctx(), input);

    expect(result.status).toBe('success');
    expect(mockGenerateText).toHaveBeenCalledTimes(1); // no retry
    expect(result.data.score).toBeNull(); // score field missing
  });

  test('skips ClickHouse write when tag is absent (call-llm compat mode)', async () => {
    mockGenerateText.mockResolvedValue({
      text: '{"result": "ok"}',
      usage: { inputTokens: 50, outputTokens: 10 },
    });

    const input = makeInput({
      config: {
        systemPrompt: 'Summarize.',
        userPrompt: 'Do it.',
        // no tag
      },
    });

    const result = await execute(ctx(), input);

    expect(result.status).toBe('success');
    expect(result.data.parsed).toEqual({ result: 'ok' });
    expect(mockInsert).not.toHaveBeenCalled(); // no storage
  });

  test('fails when no userPrompt is provided', async () => {
    const input = makeInput({
      config: {
        tag: 'no_prompt',
        systemPrompt: 'Evaluate.',
      },
    });

    const result = await execute(ctx(), input);
    expect(result.status).toBe('fail');
    expect(result.data.error).toContain('userPrompt');
  });

  test('logs warning for score outside 0-1 range', async () => {
    mockGenerateText.mockResolvedValue({
      text: '{"score": 85}',
      usage: { inputTokens: 50, outputTokens: 10 },
    });

    const result = await execute(ctx(), makeInput());

    expect(result.status).toBe('success');
    expect(result.data.score).toBe(85); // stored as-is, not clamped
  });

  test('fails gracefully on LLM error', async () => {
    mockGenerateText.mockRejectedValue(new Error('Rate limit exceeded'));

    const result = await execute(ctx(), makeInput());

    expect(result.status).toBe('fail');
    expect(result.data.error).toContain('Rate limit exceeded');
    expect(mockInsert).not.toHaveBeenCalled();
  });
});

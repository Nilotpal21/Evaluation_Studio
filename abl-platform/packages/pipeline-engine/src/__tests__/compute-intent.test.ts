import { describe, test, expect, vi, beforeEach } from 'vitest';
import type { PipelineStepContext, StepOutput } from '../pipeline/types.js';

// ---------------------------------------------------------------------------
// Mocks — must be set up before importing the service
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

const mockInsert = vi.fn();
vi.mock('@agent-platform/database/clickhouse', () => ({
  getClickHouseClient: () => ({
    insert: mockInsert,
  }),
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

const { computeIntentService } = await import('../pipeline/services/compute-intent.service.js');

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Minimal restate.Context mock: ctx.run executes fn() directly. */
function ctx(): any {
  return {
    run: async (_label: string, fn: () => any) => fn(),
    console: { log: () => {} },
  };
}

function getExecute(svc: any): (ctx: any, input: PipelineStepContext) => Promise<StepOutput> {
  return (svc as any).service.execute;
}

const execute = getExecute(computeIntentService);

function makeInput(overrides: Partial<PipelineStepContext> = {}): PipelineStepContext {
  return {
    tenantId: 'acme-corp',
    projectId: 'support-bot',
    sessionId: 'sess-001',
    config: {},
    previousSteps: {
      'read-conversation': {
        status: 'success',
        data: {
          transcript: 'User: I want a refund\nAssistant: I can help with that',
          messages: [
            {
              messageId: 'msg-1',
              role: 'user',
              content: 'I want a refund for my last order',
              timestamp: '2025-01-01T00:00:00Z',
              channel: 'web_chat',
            },
            {
              messageId: 'msg-2',
              role: 'assistant',
              content: 'I can help you with a refund. Let me look up your order.',
              timestamp: '2025-01-01T00:00:01Z',
              channel: 'web_chat',
            },
            {
              messageId: 'msg-3',
              role: 'user',
              content: 'Order number is 12345',
              timestamp: '2025-01-01T00:00:02Z',
              channel: 'web_chat',
            },
          ],
          toolCalls: [],
          escalations: [],
          metadata: {
            agentName: 'SupportBot',
            channel: 'web_chat',
            messageCount: 3,
            durationMs: 2000,
          },
        },
      },
    },
    pipelineInput: {
      tenantId: 'acme-corp',
      projectId: 'support-bot',
      sessionId: 'sess-001',
    },
    ...overrides,
  };
}

const STANDARD_LLM_RESPONSE = {
  text: JSON.stringify({
    intent: 'billing_refund',
    intent_display: 'Billing - Refund Request',
    confidence: 0.92,
    secondary_intents: [{ intent: 'order_status', confidence: 0.3 }],
    reasoning: 'User explicitly asks for a refund',
  }),
  usage: { inputTokens: 150, outputTokens: 60 },
};

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('ComputeIntent service', () => {
  beforeEach(() => {
    mockGenerateText.mockReset();
    mockInsert.mockReset();
    mockInsert.mockResolvedValue(undefined);
  });

  test('classifies intent and writes to ClickHouse', async () => {
    mockGenerateText.mockResolvedValue(STANDARD_LLM_RESPONSE);

    const result = await execute(ctx(), makeInput());

    expect(result.status).toBe('success');
    expect(result.data.intent).toBe('billing_refund');
    expect(result.data.intentDisplay).toBe('Billing - Refund Request');
    expect(result.data.confidence).toBe(0.92);
    expect(result.data.secondaryIntents).toEqual(['order_status']);
    expect(result.data.inputTokens).toBe(150);
    expect(result.data.outputTokens).toBe(60);

    // Verify ClickHouse write
    expect(mockInsert).toHaveBeenCalledTimes(1);
    const insertCall = mockInsert.mock.calls[0][0];
    expect(insertCall.table).toBe('abl_platform.intent_classifications');
    expect(insertCall.values).toHaveLength(1);
    expect(insertCall.format).toBe('JSONEachRow');

    const row = insertCall.values[0];
    expect(row.tenant_id).toBe('acme-corp');
    expect(row.project_id).toBe('support-bot');
    expect(row.session_id).toBe('sess-001');
    expect(row.intent).toBe('billing_refund');
    expect(row.confidence).toBe(0.92);
    expect(row.secondary_intents).toEqual(['order_status']);
  });

  test('includes pipeline_id and pipeline_type in ClickHouse insert', async () => {
    mockGenerateText.mockResolvedValue(STANDARD_LLM_RESPONSE);

    const result = await execute(
      ctx(),
      makeInput({ pipelineId: 'test-pipe-1', pipelineType: 'custom' }),
    );

    expect(result.status).toBe('success');

    const insertCall = mockInsert.mock.calls[0][0];
    expect(insertCall.table).toBe('abl_platform.intent_classifications');
    expect(insertCall.values[0].pipeline_id).toBe('test-pipe-1');
    expect(insertCall.values[0].pipeline_type).toBe('custom');
  });

  test('applies confidence threshold — low confidence becomes unknown', async () => {
    mockGenerateText.mockResolvedValue({
      ...STANDARD_LLM_RESPONSE,
      text: JSON.stringify({
        intent: 'maybe_billing',
        intent_display: 'Maybe Billing',
        confidence: 0.3,
        secondary_intents: [],
      }),
    });

    const result = await execute(
      ctx(),
      makeInput({
        config: { confidenceThreshold: 0.6 },
      }),
    );

    expect(result.status).toBe('success');
    expect(result.data.intent).toBe('unknown');
    expect(result.data.confidence).toBe(0.3);
  });

  test('uses custom unknown intent label from config', async () => {
    mockGenerateText.mockResolvedValue({
      ...STANDARD_LLM_RESPONSE,
      text: JSON.stringify({
        intent: 'something',
        intent_display: 'Something',
        confidence: 0.2,
      }),
    });

    const result = await execute(
      ctx(),
      makeInput({
        config: { confidenceThreshold: 0.5, unknownIntentLabel: 'unclassified' },
      }),
    );

    expect(result.status).toBe('success');
    expect(result.data.intent).toBe('unclassified');
  });

  test('detects auto-discovered intents not in taxonomy', async () => {
    mockGenerateText.mockResolvedValue(STANDARD_LLM_RESPONSE);

    const result = await execute(
      ctx(),
      makeInput({
        config: {
          taxonomy: [
            { name: 'order_status', description: 'Check order status' },
            { name: 'shipping', description: 'Shipping inquiries' },
          ],
        },
      }),
    );

    expect(result.status).toBe('success');
    expect(result.data.isAutoDiscovered).toBe(true);

    const row = mockInsert.mock.calls[0][0].values[0];
    expect(row.is_auto_discovered).toBe(1);
  });

  test('intent in taxonomy is not marked as auto-discovered', async () => {
    mockGenerateText.mockResolvedValue(STANDARD_LLM_RESPONSE);

    const result = await execute(
      ctx(),
      makeInput({
        config: {
          taxonomy: [
            { name: 'billing_refund', description: 'Refund requests' },
            { name: 'order_status', description: 'Check order status' },
          ],
        },
      }),
    );

    expect(result.status).toBe('success');
    expect(result.data.isAutoDiscovered).toBe(false);
  });

  test('respects first_user input message strategy', async () => {
    mockGenerateText.mockResolvedValue(STANDARD_LLM_RESPONSE);

    await execute(
      ctx(),
      makeInput({
        config: { inputMessageStrategy: 'first_user' },
      }),
    );

    // Only the first user message should be in the LLM prompt
    const chatArgs = mockGenerateText.mock.calls[0][0];
    const userPrompt = chatArgs.messages.find((m: any) => m.role === 'user')?.content;
    expect(userPrompt).toContain('[0] user:');
    expect(userPrompt).not.toContain('[1]');
  });

  test('skips conversations with no user messages', async () => {
    const input = makeInput({
      previousSteps: {
        'read-conversation': {
          status: 'success',
          data: {
            transcript: 'System: Init.',
            messages: [
              {
                messageId: 'msg-1',
                role: 'system',
                content: 'You are a helpful assistant.',
                timestamp: '2025-01-01T00:00:00Z',
              },
            ],
            toolCalls: [],
            escalations: [],
            metadata: { messageCount: 1 },
          },
        },
      },
    });

    const result = await execute(ctx(), input);

    expect(result.status).toBe('skipped');
    expect(result.data.reason).toContain('No user messages');
    expect(mockGenerateText).not.toHaveBeenCalled();
    expect(mockInsert).not.toHaveBeenCalled();
  });

  test('fails when read-conversation step is missing', async () => {
    const result = await execute(
      ctx(),
      makeInput({
        previousSteps: {},
      }),
    );

    expect(result.status).toBe('fail');
    expect(result.data.error).toContain('read-conversation');
  });

  test('fails on invalid JSON from LLM', async () => {
    mockGenerateText.mockResolvedValue({
      text: 'not valid json at all',
      usage: { inputTokens: 100, outputTokens: 10 },
    });

    const result = await execute(ctx(), makeInput());

    expect(result.status).toBe('fail');
    expect(result.data.error).toContain('parse');
  });

  test('filters secondary intents below 0.2 confidence', async () => {
    mockGenerateText.mockResolvedValue({
      ...STANDARD_LLM_RESPONSE,
      text: JSON.stringify({
        intent: 'billing_refund',
        intent_display: 'Billing - Refund Request',
        confidence: 0.9,
        secondary_intents: [
          { intent: 'high_conf', confidence: 0.5 },
          { intent: 'low_conf', confidence: 0.1 },
        ],
      }),
    });

    const result = await execute(ctx(), makeInput());

    expect(result.data.secondaryIntents).toEqual(['high_conf']);
  });
});

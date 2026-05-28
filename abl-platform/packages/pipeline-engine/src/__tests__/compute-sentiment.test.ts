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

const { computeSentimentService } =
  await import('../pipeline/services/compute-sentiment.service.js');

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

const execute = getExecute(computeSentimentService);

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
          transcript: 'User: Hello\nAssistant: Hi there!\nUser: I need help\nAssistant: Sure!',
          messages: [
            {
              messageId: 'msg-1',
              role: 'user',
              content: 'Hello',
              timestamp: '2025-01-01T00:00:00Z',
              channel: 'web_chat',
            },
            {
              messageId: 'msg-2',
              role: 'assistant',
              content: 'Hi there!',
              timestamp: '2025-01-01T00:00:01Z',
              channel: 'web_chat',
            },
            {
              messageId: 'msg-3',
              role: 'user',
              content: 'I need help with my order',
              timestamp: '2025-01-01T00:00:02Z',
              channel: 'web_chat',
            },
            {
              messageId: 'msg-4',
              role: 'assistant',
              content: 'Sure, I can help you with that!',
              timestamp: '2025-01-01T00:00:03Z',
              channel: 'web_chat',
            },
          ],
          toolCalls: [],
          escalations: [],
          metadata: {
            agentName: 'SupportBot',
            channel: 'web_chat',
            messageCount: 4,
            durationMs: 3000,
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

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('ComputeSentiment service', () => {
  beforeEach(() => {
    mockGenerateText.mockReset();
    mockInsert.mockReset();
    mockInsert.mockResolvedValue(undefined);
  });

  test('scores sentiment per message and computes trajectory', async () => {
    mockGenerateText.mockResolvedValue({
      text: JSON.stringify({
        scores: [
          {
            index: 0,
            sentiment_score: 0.5,
            sentiment_label: 'positive',
            frustration_detected: false,
            frustration_signals: [],
          },
          {
            index: 1,
            sentiment_score: 0.7,
            sentiment_label: 'positive',
            frustration_detected: false,
            frustration_signals: [],
          },
          {
            index: 2,
            sentiment_score: 0.3,
            sentiment_label: 'neutral',
            frustration_detected: false,
            frustration_signals: [],
          },
          {
            index: 3,
            sentiment_score: 0.8,
            sentiment_label: 'very_positive',
            frustration_detected: false,
            frustration_signals: [],
          },
        ],
      }),
      usage: { inputTokens: 200, outputTokens: 80 },
    });

    const result = await execute(ctx(), makeInput());

    expect(result.status).toBe('success');

    // Check per-message sentiments
    expect(result.data.messageSentiments).toHaveLength(4);
    expect(result.data.messageSentiments[0].sentiment_score).toBe(0.5);
    expect(result.data.messageSentiments[0].sentiment_label).toBe('positive');
    expect(result.data.messageSentiments[0].message_id).toBe('msg-1');

    // Check conversation-level sentiment
    const convSentiment = result.data.conversationSentiment;
    expect(convSentiment.avg_sentiment).toBeGreaterThan(0);
    expect(convSentiment.start_sentiment).toBe(0.5);
    expect(convSentiment.end_sentiment).toBe(0.8);
    expect(convSentiment.sentiment_trajectory).toBe('improving');
    expect(convSentiment.tenant_id).toBe('acme-corp');
    expect(convSentiment.session_id).toBe('sess-001');

    // Check token counts
    expect(result.data.inputTokens).toBe(200);
    expect(result.data.outputTokens).toBe(80);

    // Verify ClickHouse writes: 2 insert calls (message_sentiment + conversation_sentiment)
    expect(mockInsert).toHaveBeenCalledTimes(2);

    // First call: message_sentiment table
    const msgInsert = mockInsert.mock.calls[0][0];
    expect(msgInsert.table).toBe('abl_platform.message_sentiment');
    expect(msgInsert.values).toHaveLength(4);
    expect(msgInsert.format).toBe('JSONEachRow');

    // Second call: conversation_sentiment table
    const convInsert = mockInsert.mock.calls[1][0];
    expect(convInsert.table).toBe('abl_platform.conversation_sentiment');
    expect(convInsert.values).toHaveLength(1);
  });

  test('includes pipeline_id and pipeline_type in ClickHouse inserts', async () => {
    mockGenerateText.mockResolvedValue({
      text: JSON.stringify({
        scores: [
          {
            index: 0,
            sentiment_score: 0.5,
            sentiment_label: 'positive',
            frustration_detected: false,
            frustration_signals: [],
          },
          {
            index: 1,
            sentiment_score: 0.7,
            sentiment_label: 'positive',
            frustration_detected: false,
            frustration_signals: [],
          },
          {
            index: 2,
            sentiment_score: 0.3,
            sentiment_label: 'neutral',
            frustration_detected: false,
            frustration_signals: [],
          },
          {
            index: 3,
            sentiment_score: 0.8,
            sentiment_label: 'very_positive',
            frustration_detected: false,
            frustration_signals: [],
          },
        ],
      }),
      usage: { inputTokens: 200, outputTokens: 80 },
    });

    const result = await execute(
      ctx(),
      makeInput({ pipelineId: 'test-pipe-1', pipelineType: 'custom' }),
    );

    expect(result.status).toBe('success');

    // Verify message_sentiment rows include pipeline_id and pipeline_type
    const msgInsert = mockInsert.mock.calls[0][0];
    expect(msgInsert.table).toBe('abl_platform.message_sentiment');
    for (const row of msgInsert.values) {
      expect(row.pipeline_id).toBe('test-pipe-1');
      expect(row.pipeline_type).toBe('custom');
      expect(row.project_id).toBe('support-bot');
    }

    // Verify conversation_sentiment row includes pipeline_id and pipeline_type
    const convInsert = mockInsert.mock.calls[1][0];
    expect(convInsert.table).toBe('abl_platform.conversation_sentiment');
    expect(convInsert.values[0].pipeline_id).toBe('test-pipe-1');
    expect(convInsert.values[0].pipeline_type).toBe('custom');
  });

  test('skips conversations with no user messages', async () => {
    const input = makeInput({
      previousSteps: {
        'read-conversation': {
          status: 'success',
          data: {
            transcript: 'System: Initialize.',
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
            metadata: {
              messageCount: 1,
            },
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
});

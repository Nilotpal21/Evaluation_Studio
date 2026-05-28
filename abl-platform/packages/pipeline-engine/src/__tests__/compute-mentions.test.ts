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

const mockInsert = vi.fn();
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
  };
});

const { computeMentionsService, parseMentionResponse } =
  await import('../pipeline/services/compute-mentions.service.js');

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

const execute = getExecute(computeMentionsService);

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
          messages: [
            {
              role: 'user',
              content: 'I switched to Zendesk last month because of the downtime.',
              timestamp: '2026-03-01T10:00:00Z',
            },
            {
              role: 'assistant',
              content: 'I am sorry to hear that. Let me help you.',
              timestamp: '2026-03-01T10:00:05Z',
            },
            {
              role: 'user',
              content: 'Can you add a dark mode feature?',
              timestamp: '2026-03-01T10:00:30Z',
            },
          ],
          transcript: '',
          metadata: { agentName: 'support-bot', channel: 'web' },
        },
      },
    },
    pipelineInput: {
      tenantId: 'acme-corp',
      sessionId: 'sess-001',
      projectId: 'support-bot',
    },
    ...overrides,
  };
}

// ---------------------------------------------------------------------------
// Pure function tests
// ---------------------------------------------------------------------------

describe('parseMentionResponse', () => {
  test('parses valid JSON array into MentionResult[] with detail', () => {
    const input = JSON.stringify([
      {
        type: 'competitor',
        text: 'Zendesk',
        detail: 'Customer switched to Zendesk due to downtime',
        confidence: 0.9,
      },
      {
        type: 'feature_request',
        text: 'dark mode',
        detail: 'User requested dark mode UI theme',
        confidence: 0.85,
      },
    ]);
    const result = parseMentionResponse(input);
    expect(result).toHaveLength(2);
    expect(result[0]).toEqual({
      type: 'competitor',
      text: 'Zendesk',
      detail: 'Customer switched to Zendesk due to downtime',
      confidence: 0.9,
    });
    expect(result[1]).toEqual({
      type: 'feature_request',
      text: 'dark mode',
      detail: 'User requested dark mode UI theme',
      confidence: 0.85,
    });
  });

  test('defaults detail to empty string when missing', () => {
    const input = JSON.stringify([{ type: 'competitor', text: 'Zendesk', confidence: 0.9 }]);
    const result = parseMentionResponse(input);
    expect(result).toHaveLength(1);
    expect(result[0].detail).toBe('');
  });

  test('returns empty array for invalid JSON', () => {
    expect(parseMentionResponse('not valid json')).toEqual([]);
  });

  test('returns empty array for empty array input', () => {
    expect(parseMentionResponse('[]')).toEqual([]);
  });

  test('filters out entries missing required fields', () => {
    const input = JSON.stringify([
      { type: 'competitor', text: 'Zendesk', confidence: 0.9 },
      { type: 'bug_report' }, // missing text and confidence
      { text: 'something', confidence: 0.5 }, // missing type
      { type: 'feature_request', text: 'dark mode' }, // missing confidence
    ]);
    const result = parseMentionResponse(input);
    expect(result).toHaveLength(1);
    expect(result[0].type).toBe('competitor');
  });

  test('returns empty array for non-array JSON', () => {
    expect(parseMentionResponse('{"type": "competitor"}')).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// Service tests
// ---------------------------------------------------------------------------

describe('ComputeMentions service', () => {
  beforeEach(() => {
    mockGenerateText.mockReset();
    mockInsert.mockReset();
    mockInsert.mockResolvedValue(undefined);
  });

  test('extracts mentions from conversation and writes to ClickHouse', async () => {
    mockGenerateText.mockResolvedValue({
      text: JSON.stringify([
        {
          type: 'competitor',
          text: 'Zendesk',
          detail: 'Customer switched to Zendesk due to downtime',
          confidence: 0.9,
        },
        {
          type: 'feature_request',
          text: 'dark mode',
          detail: 'User requested dark mode feature',
          confidence: 0.85,
        },
      ]),
      usage: { inputTokens: 200, outputTokens: 80 },
    });

    const result = await execute(ctx(), makeInput());

    expect(result.status).toBe('success');
    expect(result.data.mentionCount).toBe(2);
    expect(result.data.mentions).toHaveLength(2);
    expect(result.data.byType.competitor).toBe(1);
    expect(result.data.byType.feature_request).toBe(1);
    expect(result.data.byType.bug_report).toBe(0);
    expect(result.data.byType.channel_switch).toBe(0);

    expect(mockInsert).toHaveBeenCalledTimes(1);
    expect(mockInsert.mock.calls[0][0].table).toBe('abl_platform.conversation_mentions');

    const rows = mockInsert.mock.calls[0][0].values;
    expect(rows).toHaveLength(2);
    expect(rows[0].tenant_id).toBe('acme-corp');
    expect(rows[0].mention_type).toBe('competitor');
    expect(rows[0].mention_detail).toBe('Customer switched to Zendesk due to downtime');
    expect(rows[0].company_name).toBe('');
  });

  test('includes pipeline_id, pipeline_type, and channel in ClickHouse insert', async () => {
    mockGenerateText.mockResolvedValue({
      text: JSON.stringify([
        {
          type: 'competitor',
          text: 'Zendesk',
          detail: 'Customer switched to Zendesk due to downtime',
          confidence: 0.9,
        },
      ]),
      usage: { inputTokens: 200, outputTokens: 40 },
    });

    const result = await execute(
      ctx(),
      makeInput({ pipelineId: 'test-pipe-1', pipelineType: 'custom' }),
    );

    expect(result.status).toBe('success');
    expect(mockInsert).toHaveBeenCalledTimes(1);

    const rows = mockInsert.mock.calls[0][0].values;
    expect(rows[0].pipeline_id).toBe('test-pipe-1');
    expect(rows[0].pipeline_type).toBe('custom');
    expect(rows[0].channel).toBe('web');
  });

  test('passes companyName and competitors config to LLM prompt', async () => {
    mockGenerateText.mockResolvedValue({
      text: JSON.stringify([
        {
          type: 'competitor',
          text: 'Freshdesk',
          detail: 'Mentioned as alternative',
          confidence: 0.8,
        },
      ]),
      usage: { inputTokens: 200, outputTokens: 40 },
    });

    const result = await execute(
      ctx(),
      makeInput({
        config: {
          companyName: 'Acme Corp',
          competitors: ['Freshdesk', 'Intercom'],
        },
      }),
    );

    expect(result.status).toBe('success');
    expect(result.data.mentionCount).toBe(1);

    // Verify the LLM prompt includes company context
    const userMessage = mockGenerateText.mock.calls[0][0].messages[0].content;
    expect(userMessage).toContain('Acme Corp');
    expect(userMessage).toContain('Freshdesk, Intercom');

    // Verify ClickHouse row includes company_name
    const rows = mockInsert.mock.calls[0][0].values;
    expect(rows[0].company_name).toBe('Acme Corp');
  });

  test('handles no messages gracefully', async () => {
    const result = await execute(
      ctx(),
      makeInput({
        previousSteps: {
          'read-conversation': {
            status: 'success',
            data: { messages: [], transcript: '', metadata: {} },
          },
        },
      }),
    );

    expect(result.status).toBe('success');
    expect(result.data.mentionCount).toBe(0);
    expect(result.data.mentions).toEqual([]);
    expect(mockGenerateText).not.toHaveBeenCalled();
  });

  test('handles LLM returning empty array', async () => {
    mockGenerateText.mockResolvedValue({
      text: '[]',
      usage: { inputTokens: 100, outputTokens: 10 },
    });

    const result = await execute(ctx(), makeInput());

    expect(result.status).toBe('success');
    expect(result.data.mentionCount).toBe(0);
    expect(mockInsert).not.toHaveBeenCalled();
  });

  test('fails when sessionId is missing', async () => {
    const result = await execute(
      ctx(),
      makeInput({
        sessionId: undefined,
        pipelineInput: { tenantId: 'acme-corp', projectId: 'support-bot' },
      }),
    );

    expect(result.status).toBe('fail');
    expect(result.data.error).toContain('Missing tenantId, projectId, or sessionId');
  });

  test('fails when read-conversation step is missing', async () => {
    const result = await execute(ctx(), makeInput({ previousSteps: {} }));

    expect(result.status).toBe('fail');
    expect(result.data.error).toContain('read-conversation');
  });

  test('fails when read-conversation step failed', async () => {
    const result = await execute(
      ctx(),
      makeInput({
        previousSteps: {
          'read-conversation': {
            status: 'fail',
            data: { error: 'could not read' },
          },
        },
      }),
    );

    expect(result.status).toBe('fail');
    expect(result.data.error).toContain('read-conversation');
  });

  test('handles LLM returning invalid JSON gracefully', async () => {
    mockGenerateText.mockResolvedValue({
      text: 'I found some mentions but cannot format them',
      usage: { inputTokens: 100, outputTokens: 20 },
    });

    const result = await execute(ctx(), makeInput());

    // parseMentionResponse returns [] for invalid JSON, so service succeeds with 0 mentions
    expect(result.status).toBe('success');
    expect(result.data.mentionCount).toBe(0);
    expect(mockInsert).not.toHaveBeenCalled();
  });

  test('handles LLM errors gracefully', async () => {
    mockGenerateText.mockRejectedValue(new Error('API rate limit exceeded'));

    const result = await execute(ctx(), makeInput());

    expect(result.status).toBe('fail');
    expect(result.data.error).toContain('API rate limit exceeded');
  });
});

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

vi.mock('@abl/compiler/platform', () => ({
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
  buildNLUConfig: () => ({
    piiRedaction: {
      enabled: false,
      redactInput: false,
      redactOutput: false,
    },
  }),
  PIIRecognizerRegistry: class {
    register = vi.fn();
    recognize = vi.fn(() => []);
  },
  PIIVault: class {},
  RegexPIIRecognizer: class {
    constructor(config: { name?: string; piiType?: string }) {
      Object.assign(this, config);
    }
  },
  registerBuiltInRecognizers: vi.fn(),
  renderValueForPIIBoundary: <T>(value: T) => value,
}));

const { conversationAnalyzerService } =
  await import('../pipeline/services/compute-llm-evaluation.service.js');

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

const execute = getExecute(conversationAnalyzerService);

function makeInput(
  evaluationType: string,
  overrides: Partial<PipelineStepContext> = {},
): PipelineStepContext {
  return {
    tenantId: 'acme-corp',
    projectId: 'support-bot',
    sessionId: 'sess-001',
    config: { evaluationType },
    previousSteps: {
      'read-conversation': {
        status: 'success',
        data: {
          messages: [
            { role: 'user', content: 'My bill is wrong', timestamp: '2026-03-01T10:00:00Z' },
            {
              role: 'assistant',
              content: 'Let me check your account.',
              timestamp: '2026-03-01T10:00:05Z',
            },
          ],
          transcript: 'User: My bill is wrong\nAssistant: Let me check your account.',
          metadata: { agentName: 'billing-bot', channel: 'web' },
          toolCalls: [],
          escalations: [],
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
// Tests
// ---------------------------------------------------------------------------

describe('ConversationAnalyzer service', () => {
  beforeEach(() => {
    mockGenerateText.mockReset();
    mockInsert.mockReset();
    mockInsert.mockResolvedValue(undefined);
  });

  test('evaluates hallucination profile and writes to ClickHouse', async () => {
    mockGenerateText.mockResolvedValue({
      text: JSON.stringify({
        faithfulness_score: 0.85,
        claims: ['The bill is incorrect'],
        unsupported_claims: [],
        consistency_index: 0.95,
        contradiction_detected: false,
      }),
      usage: { inputTokens: 200, outputTokens: 80 },
    });

    const result = await execute(ctx(), makeInput('hallucination'));

    expect(result.status).toBe('success');
    expect(result.data.faithfulness_score).toBe(0.85);
    expect(result.data.flagged).toBe(false);
    expect(mockInsert).toHaveBeenCalledTimes(1);
    expect(mockInsert.mock.calls[0][0].table).toBe('abl_platform.hallucination_evaluations');

    const row = mockInsert.mock.calls[0][0].values[0];
    expect(row.tenant_id).toBe('acme-corp');
    expect(row.faithfulness_score).toBe(0.85);
    expect(row.source).toBe('batch');
  });

  test('marks realtime ClickHouse rows as realtime so dashboards can exclude them', async () => {
    mockGenerateText.mockResolvedValue({
      text: JSON.stringify({
        faithfulness_score: 0.85,
        claims: [],
        unsupported_claims: [],
        consistency_index: 0.95,
        contradiction_detected: false,
      }),
      usage: { inputTokens: 200, outputTokens: 80 },
    });

    const result = await execute(
      ctx(),
      makeInput('hallucination', { executionMode: 'realtime', triggerId: 'realtime-agent' }),
    );

    expect(result.status).toBe('success');
    expect(mockInsert.mock.calls[0][0].values[0].source).toBe('realtime');
  });

  test('includes pipeline_id and pipeline_type in ClickHouse insert', async () => {
    mockGenerateText.mockResolvedValue({
      text: JSON.stringify({
        faithfulness_score: 0.85,
        claims: ['The bill is incorrect'],
        unsupported_claims: [],
        consistency_index: 0.95,
        contradiction_detected: false,
      }),
      usage: { inputTokens: 200, outputTokens: 80 },
    });

    const result = await execute(
      ctx(),
      makeInput('hallucination', { pipelineId: 'test-pipe-1', pipelineType: 'custom' }),
    );

    expect(result.status).toBe('success');
    expect(mockInsert).toHaveBeenCalledTimes(1);

    const row = mockInsert.mock.calls[0][0].values[0];
    expect(row.pipeline_id).toBe('test-pipe-1');
    expect(row.pipeline_type).toBe('custom');
  });

  test('flags low faithfulness scores', async () => {
    mockGenerateText.mockResolvedValue({
      text: JSON.stringify({
        faithfulness_score: 0.3,
        claims: ['Your account shows a credit of $500'],
        unsupported_claims: ['Your account shows a credit of $500'],
        consistency_index: 0.4,
        contradiction_detected: true,
      }),
      usage: { inputTokens: 200, outputTokens: 80 },
    });

    const result = await execute(ctx(), makeInput('hallucination'));

    expect(result.status).toBe('success');
    expect(result.data.flagged).toBe(true);
  });

  test('evaluates knowledge_gap profile', async () => {
    mockGenerateText.mockResolvedValue({
      text: JSON.stringify({
        retrieval_precision: 0.6,
        citation_rate: 0.4,
        gap_detected: true,
        gap_topics: ['international roaming rates'],
        unused_articles: ['article-123'],
        article_ids_cited: [],
      }),
      usage: { inputTokens: 300, outputTokens: 100 },
    });

    const result = await execute(ctx(), makeInput('knowledge_gap'));

    expect(result.status).toBe('success');
    expect(result.data.gap_detected).toBe(true);
    expect(mockInsert.mock.calls[0][0].table).toBe('abl_platform.knowledge_gap_evaluations');
  });

  test('evaluates guardrail profile', async () => {
    mockGenerateText.mockResolvedValue({
      text: JSON.stringify({
        false_positive_score: 0.1,
        false_negative_score: 0.7,
        bypass_detected: false,
        bypass_technique: '',
        severity: 'medium',
        violation_categories: ['policy_violation'],
      }),
      usage: { inputTokens: 250, outputTokens: 90 },
    });

    const result = await execute(ctx(), makeInput('guardrail'));

    expect(result.status).toBe('success');
    expect(result.data.flagged).toBe(true); // false_negative_score > 0.5
    expect(mockInsert.mock.calls[0][0].table).toBe('abl_platform.guardrail_evaluations');
  });

  test('flags guardrail false positives so safety score can drop below 100%', async () => {
    mockGenerateText.mockResolvedValue({
      text: JSON.stringify({
        false_positive_score: 0.8,
        false_negative_score: 0.1,
        bypass_detected: false,
        bypass_technique: '',
        severity: 'medium',
        violation_categories: ['overblocking'],
      }),
      usage: { inputTokens: 250, outputTokens: 90 },
    });

    const result = await execute(ctx(), makeInput('guardrail'));

    expect(result.status).toBe('success');
    expect(result.data.flagged).toBe(true);
    expect(mockInsert.mock.calls[0][0].values[0].flagged).toBe(1);
  });

  test('evaluates context_preservation profile', async () => {
    mockGenerateText.mockResolvedValue({
      text: JSON.stringify({
        context_score: 0.9,
        lost_context_items: [],
        duplication_detected: false,
        duplication_count: 0,
        handoff_count: 1,
      }),
      usage: { inputTokens: 200, outputTokens: 70 },
    });

    const result = await execute(ctx(), makeInput('context_preservation'));

    expect(result.status).toBe('success');
    expect(result.data.context_score).toBe(0.9);
    expect(result.data.flagged).toBe(false);
  });

  test('fails for unknown evaluation type', async () => {
    const result = await execute(ctx(), makeInput('nonexistent_type'));
    expect(result.status).toBe('fail');
    expect(result.data.error).toContain('Unknown evaluation type');
  });

  test('fails when read-conversation step is missing', async () => {
    const result = await execute(ctx(), makeInput('hallucination', { previousSteps: {} }));
    expect(result.status).toBe('fail');
    expect(result.data.error).toContain('read-conversation');
  });

  test('fails on invalid JSON from LLM', async () => {
    mockGenerateText.mockResolvedValue({
      text: 'not valid json',
      usage: { inputTokens: 100, outputTokens: 20 },
    });

    const result = await execute(ctx(), makeInput('hallucination'));
    expect(result.status).toBe('fail');
    expect(result.data.error).toContain('parse');
  });

  test('skips when no messages in conversation', async () => {
    const result = await execute(
      ctx(),
      makeInput('hallucination', {
        previousSteps: {
          'read-conversation': {
            status: 'success',
            data: { messages: [], transcript: '', metadata: {} },
          },
        },
      }),
    );
    expect(result.status).toBe('skipped');
  });
});

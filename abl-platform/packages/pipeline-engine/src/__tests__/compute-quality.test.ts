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
  };
});

const { computeQualityService } = await import('../pipeline/services/compute-quality.service.js');

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

const execute = getExecute(computeQualityService);

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
              messageId: 'msg-1',
              role: 'user',
              content: 'I need help with my order',
              timestamp: '2025-01-01T00:00:00Z',
              channel: 'web_chat',
            },
            {
              messageId: 'msg-2',
              role: 'assistant',
              content:
                'I would be happy to help! Let me look up your order. Could you provide the order number?',
              timestamp: '2025-01-01T00:00:01Z',
              channel: 'web_chat',
            },
            {
              messageId: 'msg-3',
              role: 'user',
              content: 'It is ORD-12345',
              timestamp: '2025-01-01T00:00:02Z',
              channel: 'web_chat',
            },
            {
              messageId: 'msg-4',
              role: 'assistant',
              content:
                'I found your order ORD-12345. It shipped yesterday and should arrive by Friday.',
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

const STANDARD_LLM_RESPONSE = {
  text: JSON.stringify({
    dimensions: [
      { name: 'helpfulness', score: 4.5, rationale: 'Addressed the user need directly' },
      { name: 'accuracy', score: 4.0, rationale: 'Information was correct' },
      { name: 'professionalism', score: 4.8, rationale: 'Very polite and professional tone' },
      { name: 'instruction_following', score: 4.2, rationale: 'Followed standard workflow' },
    ],
    overall_reasoning: 'Good quality conversation with prompt resolution',
    confidence: 0.9,
    flag_reasons: [],
  }),
  usage: { inputTokens: 300, outputTokens: 120 },
};

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('ComputeQuality service', () => {
  beforeEach(() => {
    mockGenerateText.mockReset();
    mockInsert.mockReset();
    mockInsert.mockResolvedValue(undefined);
  });

  test('evaluates quality and writes to ClickHouse', async () => {
    mockGenerateText.mockResolvedValue(STANDARD_LLM_RESPONSE);

    const result = await execute(ctx(), makeInput());

    expect(result.status).toBe('success');
    expect(result.data.overallScore).toBeGreaterThan(0);
    expect(result.data.dimensions.helpfulness).toBe(4.5);
    expect(result.data.dimensions.accuracy).toBe(4.0);
    expect(result.data.flagged).toBe(false);
    expect(result.data.inputTokens).toBe(300);

    // Verify ClickHouse writes (quality + outcome)
    expect(mockInsert).toHaveBeenCalledTimes(2);
    const qualityInsert = mockInsert.mock.calls.find(
      (c: any) => c[0].table === 'abl_platform.quality_evaluations',
    )![0];
    expect(qualityInsert.values).toHaveLength(1);
    expect(qualityInsert.format).toBe('JSONEachRow');

    const row = qualityInsert.values[0];
    expect(row.tenant_id).toBe('acme-corp');
    expect(row.session_id).toBe('sess-001');
    expect(row.helpfulness).toBe(4.5);
    expect(row.accuracy).toBe(4.0);
    expect(row.professionalism).toBe(4.8);
    expect(row.flagged).toBe(0);
  });

  test('includes pipeline_id and pipeline_type in ClickHouse inserts', async () => {
    mockGenerateText.mockResolvedValue(STANDARD_LLM_RESPONSE);

    const result = await execute(
      ctx(),
      makeInput({ pipelineId: 'test-pipe-1', pipelineType: 'custom' }),
    );

    expect(result.status).toBe('success');

    // Verify quality_evaluations row
    const qualityInsert = mockInsert.mock.calls.find(
      (c: any) => c[0].table === 'abl_platform.quality_evaluations',
    )![0];
    expect(qualityInsert.values[0].pipeline_id).toBe('test-pipe-1');
    expect(qualityInsert.values[0].pipeline_type).toBe('custom');

    // Verify conversation_outcomes row
    const outcomeInsert = mockInsert.mock.calls.find(
      (c: any) => c[0].table === 'abl_platform.conversation_outcomes',
    )![0];
    expect(outcomeInsert.values[0].pipeline_id).toBe('test-pipe-1');
    expect(outcomeInsert.values[0].pipeline_type).toBe('custom');
  });

  test('flags low-quality conversations', async () => {
    mockGenerateText.mockResolvedValue({
      ...STANDARD_LLM_RESPONSE,
      text: JSON.stringify({
        dimensions: [
          { name: 'helpfulness', score: 1.5, rationale: 'Did not address the issue' },
          { name: 'accuracy', score: 2.0, rationale: 'Incorrect information' },
          { name: 'professionalism', score: 3.0, rationale: 'Adequate tone' },
          { name: 'instruction_following', score: 1.0, rationale: 'Did not follow process' },
        ],
        overall_reasoning: 'Poor quality interaction',
        confidence: 0.85,
        flag_reasons: ['Incorrect information provided', 'Failed to follow escalation process'],
      }),
    });

    const result = await execute(ctx(), makeInput());

    expect(result.status).toBe('success');
    expect(result.data.flagged).toBe(true);
    expect(result.data.flagReasons).toHaveLength(2);

    const qualityInsert = mockInsert.mock.calls.find(
      (c: any) => c[0].table === 'abl_platform.quality_evaluations',
    )![0];
    const row = qualityInsert.values[0];
    expect(row.flagged).toBe(1);
    expect(row.flag_reasons).toHaveLength(2);
  });

  test('uses custom dimensions from config', async () => {
    mockGenerateText.mockResolvedValue({
      ...STANDARD_LLM_RESPONSE,
      text: JSON.stringify({
        dimensions: [
          { name: 'empathy', score: 4.0, rationale: 'Showed understanding' },
          { name: 'resolution_speed', score: 3.5, rationale: 'Resolved in 2 exchanges' },
        ],
        overall_reasoning: 'Good empathetic interaction',
        confidence: 0.88,
        flag_reasons: [],
      }),
    });

    const result = await execute(
      ctx(),
      makeInput({
        config: {
          dimensions: [
            {
              name: 'empathy',
              displayName: 'Empathy',
              description: 'Did the agent show empathy?',
              scale: { min: 1, max: 5 },
              weight: 1.0,
            },
            {
              name: 'resolution_speed',
              displayName: 'Resolution Speed',
              description: 'How quickly was the issue resolved?',
              scale: { min: 1, max: 5 },
              weight: 0.5,
            },
          ],
        },
      }),
    );

    expect(result.status).toBe('success');
    expect(result.data.dimensions.empathy).toBe(4.0);
    expect(result.data.dimensions.resolution_speed).toBe(3.5);

    // Custom dimensions stored in JSON
    const qualityInsert = mockInsert.mock.calls.find(
      (c: any) => c[0].table === 'abl_platform.quality_evaluations',
    )![0];
    const row = qualityInsert.values[0];
    expect(row.custom_dimensions).toContain('empathy');
    expect(row.custom_dimensions).toContain('resolution_speed');
  });

  test('normalizes string scale and weight values from quality config', async () => {
    mockGenerateText.mockResolvedValue({
      ...STANDARD_LLM_RESPONSE,
      text: JSON.stringify({
        dimensions: [
          { name: 'empathy', score: 4.0, rationale: 'Showed understanding' },
          { name: 'resolution_speed', score: 7.0, rationale: 'Resolved quickly' },
        ],
        overall_reasoning: 'Good interaction',
        confidence: 0.88,
        flag_reasons: [],
      }),
    });

    const result = await execute(
      ctx(),
      makeInput({
        config: {
          dimensions: [
            {
              name: 'empathy',
              displayName: 'Empathy',
              description: 'Did the agent show empathy?',
              scale: '5',
              weight: '0.5',
            },
            {
              name: 'resolution_speed',
              displayName: 'Resolution Speed',
              description: 'How quickly was the issue resolved?',
              scale: '1-10',
              weight: '1',
            },
          ],
        },
      }),
    );

    expect(result.status).toBe('success');
    expect(result.data.dimensions.empathy).toBe(4.0);
    expect(result.data.dimensions.resolution_speed).toBe(7.0);
    expect(result.data.overallScore).toBeGreaterThan(0);
  });

  test('skips when no assistant messages', async () => {
    const input = makeInput({
      previousSteps: {
        'read-conversation': {
          status: 'success',
          data: {
            messages: [
              {
                messageId: 'msg-1',
                role: 'user',
                content: 'Hello?',
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
    expect(result.data.reason).toContain('both user and assistant');
    expect(mockGenerateText).not.toHaveBeenCalled();
  });

  test('fails when read-conversation step is missing', async () => {
    const result = await execute(ctx(), makeInput({ previousSteps: {} }));

    expect(result.status).toBe('fail');
    expect(result.data.error).toContain('read-conversation');
  });

  test('fails on invalid JSON from LLM', async () => {
    mockGenerateText.mockResolvedValue({
      text: 'I cannot evaluate this conversation',
      usage: { inputTokens: 100, outputTokens: 20 },
    });

    const result = await execute(ctx(), makeInput());

    expect(result.status).toBe('fail');
    expect(result.data.error).toContain('parse');
  });

  test('includes domain context in judge prompt when configured', async () => {
    mockGenerateText.mockResolvedValue(STANDARD_LLM_RESPONSE);

    await execute(
      ctx(),
      makeInput({
        config: {
          domainContext: 'We are a telecom company specializing in fiber optic services.',
        },
      }),
    );

    const chatArgs = mockGenerateText.mock.calls[0][0];
    expect(chatArgs.system).toContain('telecom company');
  });
});

// ---------------------------------------------------------------------------
// Outcome classification tests
// ---------------------------------------------------------------------------

describe('ComputeQuality outcome classification', () => {
  beforeEach(() => {
    mockGenerateText.mockReset();
    mockInsert.mockReset();
    mockInsert.mockResolvedValue(undefined);
  });

  test('escalated via heuristic when escalations array has entries', async () => {
    mockGenerateText.mockResolvedValue(STANDARD_LLM_RESPONSE);

    const input = makeInput({
      previousSteps: {
        'read-conversation': {
          status: 'success',
          data: {
            messages: [
              {
                messageId: 'msg-1',
                role: 'user',
                content: 'I need help with my order',
                timestamp: '2025-01-01T00:00:00Z',
                channel: 'web_chat',
              },
              {
                messageId: 'msg-2',
                role: 'assistant',
                content: 'Let me transfer you to a human agent.',
                timestamp: '2025-01-01T00:00:01Z',
                channel: 'web_chat',
              },
            ],
            toolCalls: [],
            escalations: [{ reason: 'Customer requested human agent', severity: 'medium' }],
            metadata: {
              agentName: 'SupportBot',
              channel: 'web_chat',
              messageCount: 2,
              durationMs: 1000,
            },
          },
        },
      },
    });

    const result = await execute(ctx(), input);

    expect(result.status).toBe('success');
    expect(result.data.outcome).toBe('escalated');
    expect(result.data.outcomeMethod).toBe('heuristic');

    // Should write to BOTH quality_evaluations AND conversation_outcomes
    expect(mockInsert).toHaveBeenCalledTimes(2);

    const outcomeInsert = mockInsert.mock.calls.find(
      (c: any) => c[0].table === 'abl_platform.conversation_outcomes',
    )![0];
    expect(outcomeInsert.values).toHaveLength(1);
    const outcomeRow = outcomeInsert.values[0];
    expect(outcomeRow.outcome).toBe('escalated');
    expect(outcomeRow.outcome_method).toBe('heuristic');
    expect(outcomeRow.confidence).toBe(1.0);
    expect(outcomeRow.escalation_reason).toBe('Customer requested human agent');
  });

  test('abandoned via heuristic when endReason is timeout', async () => {
    mockGenerateText.mockResolvedValue(STANDARD_LLM_RESPONSE);

    const input = makeInput({
      pipelineInput: {
        tenantId: 'acme-corp',
        projectId: 'support-bot',
        sessionId: 'sess-001',
        endReason: 'timeout',
      },
    });

    const result = await execute(ctx(), input);

    expect(result.status).toBe('success');
    expect(result.data.outcome).toBe('abandoned');
    expect(result.data.outcomeMethod).toBe('heuristic');

    const outcomeInsert = mockInsert.mock.calls.find(
      (c: any) => c[0].table === 'abl_platform.conversation_outcomes',
    )![0];
    const outcomeRow = outcomeInsert.values[0];
    expect(outcomeRow.outcome).toBe('abandoned');
    expect(outcomeRow.outcome_method).toBe('heuristic');
    expect(outcomeRow.confidence).toBe(1.0);
  });

  test('completed via LLM with outcome in response', async () => {
    const llmResponseWithOutcome = {
      text: JSON.stringify({
        dimensions: [
          { name: 'helpfulness', score: 4.5, rationale: 'Addressed the user need directly' },
          { name: 'accuracy', score: 4.0, rationale: 'Information was correct' },
          {
            name: 'professionalism',
            score: 4.8,
            rationale: 'Very polite and professional tone',
          },
          {
            name: 'instruction_following',
            score: 4.2,
            rationale: 'Followed standard workflow',
          },
        ],
        overall_reasoning: 'Good quality conversation with prompt resolution',
        confidence: 0.9,
        flag_reasons: [],
        outcome: {
          outcome: 'contained_resolved',
          goal_detected: 'Customer wanted to track their order status',
          goal_achieved: true,
          outcome_reasoning:
            'The agent successfully looked up and provided order tracking information',
        },
      }),
      usage: { inputTokens: 300, outputTokens: 150 },
    };

    mockGenerateText.mockResolvedValue(llmResponseWithOutcome);

    const result = await execute(ctx(), makeInput());

    expect(result.status).toBe('success');
    expect(result.data.outcome).toBe('contained_resolved');
    expect(result.data.outcomeMethod).toBe('llm_evaluated');
    expect(result.data.goalDetected).toBe('Customer wanted to track their order status');
    expect(result.data.goalAchieved).toBe(true);

    // System prompt should contain "Outcome Classification" for non-heuristic path
    const chatArgs = mockGenerateText.mock.calls[0][0];
    expect(chatArgs.system).toContain('Outcome Classification');

    // Outcome row should be written to conversation_outcomes
    const outcomeInsert = mockInsert.mock.calls.find(
      (c: any) => c[0].table === 'abl_platform.conversation_outcomes',
    )![0];
    const outcomeRow = outcomeInsert.values[0];
    expect(outcomeRow.outcome).toBe('contained_resolved');
    expect(outcomeRow.outcome_method).toBe('llm_evaluated');
    expect(outcomeRow.goal_detected).toBe('Customer wanted to track their order status');
    expect(outcomeRow.goal_achieved).toBe(1);
    expect(outcomeRow.model_id).toBe('gpt-4o-mini');
  });

  test('invalid LLM outcome falls back to heuristic', async () => {
    const llmResponseWithBadOutcome = {
      text: JSON.stringify({
        dimensions: [
          { name: 'helpfulness', score: 4.5, rationale: 'Addressed the user need directly' },
          { name: 'accuracy', score: 4.0, rationale: 'Information was correct' },
          {
            name: 'professionalism',
            score: 4.8,
            rationale: 'Very polite and professional tone',
          },
          {
            name: 'instruction_following',
            score: 4.2,
            rationale: 'Followed standard workflow',
          },
        ],
        overall_reasoning: 'Good quality conversation',
        confidence: 0.85,
        flag_reasons: [],
        outcome: {
          outcome: 'some_invalid_value',
          goal_detected: 'Something',
          goal_achieved: false,
          outcome_reasoning: 'Some reasoning',
        },
      }),
      usage: { inputTokens: 300, outputTokens: 140 },
    };

    mockGenerateText.mockResolvedValue(llmResponseWithBadOutcome);

    const result = await execute(ctx(), makeInput());

    expect(result.status).toBe('success');
    expect(result.data.outcome).toBe('contained');
    expect(result.data.outcomeMethod).toBe('heuristic_fallback');

    const outcomeInsert = mockInsert.mock.calls.find(
      (c: any) => c[0].table === 'abl_platform.conversation_outcomes',
    )![0];
    const outcomeRow = outcomeInsert.values[0];
    expect(outcomeRow.outcome).toBe('contained');
    expect(outcomeRow.outcome_method).toBe('heuristic_fallback');
    expect(outcomeRow.confidence).toBe(1.0);
    expect(outcomeRow.goal_detected).toBeNull();
    expect(outcomeRow.goal_achieved).toBeNull();
  });
});

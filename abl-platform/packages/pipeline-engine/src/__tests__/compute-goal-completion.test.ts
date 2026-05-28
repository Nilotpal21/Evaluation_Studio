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

const { computeGoalCompletionService } =
  await import('../pipeline/services/compute-goal-completion.service.js');

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

const execute = getExecute(computeGoalCompletionService);

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
              content: 'I need to cancel my subscription',
              timestamp: '2025-01-01T00:00:00Z',
              channel: 'web_chat',
            },
            {
              messageId: 'msg-2',
              role: 'assistant',
              content:
                'I can help you with that. Let me process the cancellation for your account right away.',
              timestamp: '2025-01-01T00:00:01Z',
              channel: 'web_chat',
            },
            {
              messageId: 'msg-3',
              role: 'user',
              content: 'Thank you, that was quick!',
              timestamp: '2025-01-01T00:00:02Z',
              channel: 'web_chat',
            },
            {
              messageId: 'msg-4',
              role: 'assistant',
              content:
                'Your subscription has been cancelled. You will receive a confirmation email shortly.',
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
    criteria: {
      issue_diagnosed: {
        score: 0.9,
        evidence: 'Agent identified cancellation request immediately',
      },
      solution_provided: {
        score: 0.95,
        evidence: 'Agent processed cancellation and confirmed with email notification',
      },
    },
    overall_goal_completion: 0.92,
    summary: 'Customer wanted to cancel subscription. Agent completed the cancellation promptly.',
  }),
  usage: { inputTokens: 250, outputTokens: 100 },
};

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('ComputeGoalCompletion service', () => {
  beforeEach(() => {
    mockGenerateText.mockReset();
    mockInsert.mockReset();
    mockInsert.mockResolvedValue(undefined);
  });

  test('writes goal completion to ClickHouse', async () => {
    mockGenerateText.mockResolvedValue(STANDARD_LLM_RESPONSE);

    const result = await execute(ctx(), makeInput());

    expect(result.status).toBe('success');
    expect(result.data.overallScore).toBeCloseTo(0.92, 2);
    expect(result.data.goalAchieved).toBe(true);
    expect(result.data.summary).toContain('cancel subscription');
    expect(result.data.criteria.issue_diagnosed.score).toBe(0.9);
    expect(result.data.criteria.solution_provided.score).toBe(0.95);
    expect(result.data.inputTokens).toBe(250);
    expect(result.data.outputTokens).toBe(100);

    // Verify ClickHouse write
    expect(mockInsert).toHaveBeenCalledTimes(1);
    const insertCall = mockInsert.mock.calls[0][0];
    expect(insertCall.table).toBe('abl_platform.goal_completions');
    expect(insertCall.values).toHaveLength(1);
    expect(insertCall.format).toBe('JSONEachRow');

    const row = insertCall.values[0];
    expect(row.tenant_id).toBe('acme-corp');
    expect(row.project_id).toBe('support-bot');
    expect(row.session_id).toBe('sess-001');
    expect(row.overall_score).toBeCloseTo(0.92, 2);
    expect(row.goal_achieved).toBe(1);
    expect(row.model_id).toBe('gpt-4o-mini');
    expect(row.input_tokens).toBe(250);
    expect(row.output_tokens).toBe(100);
  });

  test('handles LLM parse failure gracefully', async () => {
    mockGenerateText.mockResolvedValue({
      text: 'I cannot evaluate this conversation properly',
      usage: { inputTokens: 100, outputTokens: 20 },
    });

    const result = await execute(ctx(), makeInput());

    expect(result.status).toBe('fail');
    expect(result.data.error).toContain('parse');
    expect(mockInsert).not.toHaveBeenCalled();
  });

  test('includes pipeline_id and pipeline_type in ClickHouse row', async () => {
    mockGenerateText.mockResolvedValue(STANDARD_LLM_RESPONSE);

    const result = await execute(
      ctx(),
      makeInput({ pipelineId: 'goal-pipe-1', pipelineType: 'custom' }),
    );

    expect(result.status).toBe('success');

    const insertCall = mockInsert.mock.calls[0][0];
    const row = insertCall.values[0];
    expect(row.pipeline_id).toBe('goal-pipe-1');
    expect(row.pipeline_type).toBe('custom');
  });

  test('handles missing conversation data', async () => {
    const result = await execute(ctx(), makeInput({ previousSteps: {} }));

    expect(result.status).toBe('fail');
    expect(result.data.error).toContain('read-conversation');
    expect(mockGenerateText).not.toHaveBeenCalled();
    expect(mockInsert).not.toHaveBeenCalled();
  });

  test('uses default system prompt when none provided', async () => {
    mockGenerateText.mockResolvedValue(STANDARD_LLM_RESPONSE);

    await execute(ctx(), makeInput());

    const callArgs = mockGenerateText.mock.calls[0][0];
    expect(callArgs.system).toContain('goal completion evaluator');
    expect(callArgs.system).toContain('0-1 scale');
  });

  test('uses custom system prompt when provided', async () => {
    mockGenerateText.mockResolvedValue(STANDARD_LLM_RESPONSE);

    await execute(
      ctx(),
      makeInput({
        config: {
          systemPrompt: 'You are a custom goal evaluator for telecom support.',
        },
      }),
    );

    const callArgs = mockGenerateText.mock.calls[0][0];
    expect(callArgs.system).toBe('You are a custom goal evaluator for telecom support.');
  });

  test('marks goal as not achieved when score is below threshold', async () => {
    mockGenerateText.mockResolvedValue({
      ...STANDARD_LLM_RESPONSE,
      text: JSON.stringify({
        criteria: {
          issue_diagnosed: { score: 0.3, evidence: 'Agent did not fully understand the issue' },
          solution_provided: { score: 0.2, evidence: 'No clear solution was offered' },
        },
        overall_goal_completion: 0.25,
        summary: 'Customer goal was not achieved.',
      }),
    });

    const result = await execute(ctx(), makeInput());

    expect(result.status).toBe('success');
    expect(result.data.goalAchieved).toBe(false);

    const insertCall = mockInsert.mock.calls[0][0];
    const row = insertCall.values[0];
    expect(row.goal_achieved).toBe(0);
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

  test('includes criteria list in user prompt when provided', async () => {
    mockGenerateText.mockResolvedValue(STANDARD_LLM_RESPONSE);

    await execute(
      ctx(),
      makeInput({
        config: {
          criteria: ['issue_diagnosed', 'solution_provided', 'customer_satisfied'],
        },
      }),
    );

    const callArgs = mockGenerateText.mock.calls[0][0];
    const userPrompt = callArgs.messages[0].content;
    expect(userPrompt).toContain('issue_diagnosed');
    expect(userPrompt).toContain('solution_provided');
    expect(userPrompt).toContain('customer_satisfied');
  });

  test('strips markdown fences from LLM response', async () => {
    mockGenerateText.mockResolvedValue({
      ...STANDARD_LLM_RESPONSE,
      text:
        '```json\n' +
        JSON.stringify({
          criteria: {
            resolved: { score: 0.8, evidence: 'Issue was resolved' },
          },
          overall_goal_completion: 0.8,
          summary: 'Goal achieved.',
        }) +
        '\n```',
    });

    const result = await execute(ctx(), makeInput());

    expect(result.status).toBe('success');
    expect(result.data.overallScore).toBeCloseTo(0.8, 2);
  });
});

import { describe, test, expect, vi, beforeEach } from 'vitest';
import type { PipelineStepContext, StepOutput } from '../pipeline/types.js';

// ---------------------------------------------------------------------------
// Mocks — must be set up before importing the service
// ---------------------------------------------------------------------------

const mockInsert = vi.fn();
vi.mock('@agent-platform/database/clickhouse', () => ({
  getClickHouseClient: () => ({
    insert: mockInsert,
  }),
}));

vi.mock('@abl/compiler/platform', () => ({
  createLogger: () => ({
    debug: vi.fn(),
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
  }),
}));

const { computeToxicityService } = await import('../pipeline/services/compute-toxicity.service.js');

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

/**
 * Extract the raw execute handler from a Restate service definition.
 * Restate exposes handler functions at <service>.service.<handlerName>.
 */
function getExecute(svc: any): (ctx: any, input: PipelineStepContext) => Promise<StepOutput> {
  return (svc as any).service.execute;
}

const execute = getExecute(computeToxicityService);

interface TestMessage {
  messageId: string;
  role: string;
  content: string;
  timestamp?: string;
  channel?: string;
}

function makeInput(
  overrides: Partial<PipelineStepContext> = {},
  messages: TestMessage[] = [],
): PipelineStepContext {
  return {
    tenantId: 'acme-corp',
    projectId: 'support-bot',
    sessionId: 'sess-001',
    config: {
      params: { threshold: 0.7 },
    },
    previousSteps: {
      'read-conversation': {
        status: 'success',
        data: {
          messages,
          metadata: {
            agentName: 'SupportBot',
            channel: 'web_chat',
            sessionStartedAt: '2025-01-01T00:00:00Z',
            messageCount: messages.length,
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

describe('ComputeToxicity service', () => {
  beforeEach(() => {
    mockInsert.mockReset();
    mockInsert.mockResolvedValue(undefined);
  });

  test('scores safe messages as pass with low toxicity', async () => {
    const messages: TestMessage[] = [
      { messageId: 'msg-1', role: 'user', content: 'Hello, can you help me?' },
      { messageId: 'msg-2', role: 'user', content: 'Thank you for your help!' },
    ];

    const result = await execute(ctx(), makeInput({}, messages));

    expect(result.status).toBe('success');
    expect(result.data.status).toBe('pass');
    expect(result.data.messageCount).toBe(2);
    expect(result.data.flagged).toBe(false);

    // Verify ClickHouse writes: message_toxicity + toxicity_evaluations
    expect(mockInsert).toHaveBeenCalledTimes(2);

    const msgInsert = mockInsert.mock.calls[0][0];
    expect(msgInsert.table).toBe('abl_platform.message_toxicity');
    expect(msgInsert.values).toHaveLength(2);
    expect(msgInsert.format).toBe('JSONEachRow');
    expect(msgInsert.values[0].status).toBe('pass');

    const sessionInsert = mockInsert.mock.calls[1][0];
    expect(sessionInsert.table).toBe('abl_platform.toxicity_evaluations');
    expect(sessionInsert.values).toHaveLength(1);
    expect(sessionInsert.values[0].status).toBe('pass');
    expect(sessionInsert.values[0].flagged).toBe(0);
  });

  test('detects toxic language and marks as fail', async () => {
    // Hit multiple pattern categories: profanity (idiot, stupid, incompetent),
    // aggressive (terrible, awful, worst), threats (sue, lawyer), hostility (damn),
    // plus excessive punctuation — total weight well above 0.7
    const messages: TestMessage[] = [
      {
        messageId: 'msg-1',
        role: 'user',
        content:
          'You are an idiot and stupid and incompetent! This is terrible awful worst service! I will sue you and get a lawyer! Damn!!!',
      },
    ];

    const result = await execute(ctx(), makeInput({}, messages));

    expect(result.status).toBe('success');
    expect(result.data.status).toBe('fail');
    expect(result.data.flagged).toBe(true);

    // Verify per-message row has fail status
    const msgInsert = mockInsert.mock.calls[0][0];
    expect(msgInsert.table).toBe('abl_platform.message_toxicity');
    expect(msgInsert.values[0].toxicity_score).toBeGreaterThan(0.7);
    expect(msgInsert.values[0].status).toBe('fail');

    // Verify session-level row has fail status and flagged = 1
    const sessionInsert = mockInsert.mock.calls[1][0];
    expect(sessionInsert.values[0].status).toBe('fail');
    expect(sessionInsert.values[0].flagged).toBe(1);
  });

  test('writes per-message rows with correct message IDs', async () => {
    const messages: TestMessage[] = [
      { messageId: 'msg-1', role: 'user', content: 'Hello' },
      { messageId: 'msg-2', role: 'user', content: 'Goodbye' },
    ];

    const result = await execute(ctx(), makeInput({}, messages));

    expect(result.status).toBe('success');
    const msgInsert = mockInsert.mock.calls[0][0];
    expect(msgInsert.values[0].message_id).toBe('msg-1');
    expect(msgInsert.values[1].message_id).toBe('msg-2');
  });

  test('filters to user messages only by default (skips assistant)', async () => {
    const messages: TestMessage[] = [
      { messageId: 'msg-1', role: 'user', content: 'Question' },
      { messageId: 'msg-2', role: 'assistant', content: 'Answer' },
      { messageId: 'msg-3', role: 'user', content: 'Follow-up' },
    ];

    const result = await execute(ctx(), makeInput({}, messages));

    expect(result.data.messageCount).toBe(2);

    const msgInsert = mockInsert.mock.calls[0][0];
    expect(msgInsert.values).toHaveLength(2);
  });

  test('includes agent messages when includeAgent param is true', async () => {
    const messages: TestMessage[] = [
      { messageId: 'msg-1', role: 'user', content: 'Question' },
      { messageId: 'msg-2', role: 'assistant', content: 'Answer' },
    ];

    const input = makeInput(
      {
        config: { params: { threshold: 0.7, includeAgent: true } },
      },
      messages,
    );
    const result = await execute(ctx(), input);

    expect(result.data.messageCount).toBe(2);

    const msgInsert = mockInsert.mock.calls[0][0];
    expect(msgInsert.values).toHaveLength(2);
  });

  test('reads messages from previousSteps read-conversation data', async () => {
    const messages: TestMessage[] = [{ messageId: 'msg-1', role: 'user', content: 'Hello' }];

    const result = await execute(ctx(), makeInput({}, messages));

    expect(result.status).toBe('success');
    expect(result.data.messageCount).toBe(1);
  });

  test('fails when sessionId is missing', async () => {
    const input = makeInput({ sessionId: undefined });

    const result = await execute(ctx(), input);
    expect(result.status).toBe('fail');
    expect(result.data.error).toContain('sessionId');
  });

  test('writes empty session row to ClickHouse when no messages found', async () => {
    const result = await execute(ctx(), makeInput());

    expect(result.status).toBe('success');
    expect(result.data.status).toBe('pass');
    expect(result.data.messageCount).toBe(0);
    expect(result.data.flagged).toBe(false);

    // Only the session-level row should be written (no message rows)
    expect(mockInsert).toHaveBeenCalledTimes(1);
    const sessionInsert = mockInsert.mock.calls[0][0];
    expect(sessionInsert.table).toBe('abl_platform.toxicity_evaluations');
    expect(sessionInsert.values).toHaveLength(1);
    expect(sessionInsert.values[0].message_count).toBe(0);
    expect(sessionInsert.values[0].status).toBe('pass');
  });

  test('session-level avgToxicity and maxToxicity are computed correctly', async () => {
    const messages: TestMessage[] = [
      { messageId: 'msg-1', role: 'user', content: 'Hello nice to meet you' },
      {
        messageId: 'msg-2',
        role: 'user',
        content: 'You stupid incompetent idiots are the worst terrible awful service!',
      },
    ];

    const result = await execute(ctx(), makeInput({}, messages));

    expect(result.data.messageCount).toBe(2);
    expect(result.data.avgToxicity).toBeGreaterThan(0);
    expect(result.data.maxToxicity).toBeGreaterThan(result.data.avgToxicity);

    // Verify per-message rows: first should be lower than second
    const msgInsert = mockInsert.mock.calls[0][0];
    expect(msgInsert.values[0].toxicity_score).toBeLessThan(msgInsert.values[1].toxicity_score);

    // Verify session-level row has aggregate values
    const sessionInsert = mockInsert.mock.calls[1][0];
    expect(sessionInsert.values[0].avg_toxicity).toBe(result.data.avgToxicity);
    expect(sessionInsert.values[0].max_toxicity).toBe(result.data.maxToxicity);
    expect(sessionInsert.values[0].message_count).toBe(2);
  });

  test('uses custom threshold from params', async () => {
    const messages: TestMessage[] = [
      { messageId: 'msg-1', role: 'user', content: 'This is somewhat annoying terrible service' },
    ];

    const inputLow = makeInput({ config: { params: { threshold: 0.1 } } }, messages);
    const resultLow = await execute(ctx(), inputLow);

    mockInsert.mockClear();
    mockInsert.mockResolvedValue(undefined);

    const inputHigh = makeInput({ config: { params: { threshold: 0.99 } } }, messages);
    const resultHigh = await execute(ctx(), inputHigh);

    // Raw toxicity scores should be the same regardless of threshold
    // The toxicity_score is based on keyword matching, not threshold
    expect(resultLow.data.avgToxicity).toBe(resultHigh.data.avgToxicity);
  });

  test('includes pipeline_id and pipeline_type in ClickHouse inserts', async () => {
    const messages: TestMessage[] = [{ messageId: 'msg-1', role: 'user', content: 'Hello there' }];

    const result = await execute(
      ctx(),
      makeInput({ pipelineId: 'test-pipe-1', pipelineType: 'custom' }, messages),
    );

    expect(result.status).toBe('success');

    // Verify message_toxicity rows include pipeline_id and pipeline_type
    const msgInsert = mockInsert.mock.calls[0][0];
    expect(msgInsert.table).toBe('abl_platform.message_toxicity');
    for (const row of msgInsert.values) {
      expect(row.pipeline_id).toBe('test-pipe-1');
      expect(row.pipeline_type).toBe('custom');
      expect(row.project_id).toBe('support-bot');
    }

    // Verify toxicity_evaluations row includes pipeline_id and pipeline_type
    const sessionInsert = mockInsert.mock.calls[1][0];
    expect(sessionInsert.table).toBe('abl_platform.toxicity_evaluations');
    expect(sessionInsert.values[0].pipeline_id).toBe('test-pipe-1');
    expect(sessionInsert.values[0].pipeline_type).toBe('custom');
  });

  test('populates agent_name and channel from conversation metadata', async () => {
    const messages: TestMessage[] = [{ messageId: 'msg-1', role: 'user', content: 'Hello' }];

    const result = await execute(ctx(), makeInput({}, messages));

    expect(result.status).toBe('success');

    // Verify metadata is passed through to ClickHouse rows
    const msgInsert = mockInsert.mock.calls[0][0];
    expect(msgInsert.values[0].agent_name).toBe('SupportBot');
    expect(msgInsert.values[0].channel).toBe('web_chat');

    const sessionInsert = mockInsert.mock.calls[1][0];
    expect(sessionInsert.values[0].agent_name).toBe('SupportBot');
    expect(sessionInsert.values[0].channel).toBe('web_chat');
  });
});

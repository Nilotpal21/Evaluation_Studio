/**
 * Integration test: Toxicity pipeline — ComputeToxicity writes directly to ClickHouse
 *
 * Tests the data flow from compute handler to ClickHouse storage.
 * Mocks only external I/O (MongoDB, ClickHouse) — all business logic runs real.
 */
import { describe, test, expect, vi, beforeEach } from 'vitest';
import type { PipelineStepContext, StepOutput } from '../pipeline/types.js';

// Mock MongoDB (service reads messages from mongoose collection)
const mockToArray = vi.fn();
const mockFind = vi.fn().mockReturnValue({ toArray: mockToArray });
const mockCollection = vi.fn().mockReturnValue({ find: mockFind });

vi.mock('mongoose', () => ({
  default: {
    connection: {
      collection: mockCollection,
    },
  },
}));

// Mock ClickHouse
const mockInsert = vi.fn().mockResolvedValue(undefined);
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
}));

const { computeToxicityService } = await import('../pipeline/services/compute-toxicity.service.js');

function ctx(): any {
  return {
    run: async (_label: string, fn: () => any) => fn(),
    console: { log: (...args: any[]) => console.log('[Restate]', ...args) },
  };
}

function handler(svc: any): (ctx: any, input: PipelineStepContext) => Promise<StepOutput> {
  return svc.service.execute;
}

describe('Integration: ComputeToxicity direct ClickHouse write', () => {
  const computeToxicity = handler(computeToxicityService);

  beforeEach(() => {
    mockInsert.mockClear().mockResolvedValue(undefined);
    mockToArray.mockReset();
    mockFind.mockClear().mockReturnValue({ toArray: mockToArray });
    mockCollection.mockClear().mockReturnValue({ find: mockFind });
  });

  function makeInput(
    messages: Array<{ messageId: string; role: string; content: string }>,
    overrides: Partial<PipelineStepContext> = {},
  ): PipelineStepContext {
    // Set up MongoDB mock to return these messages
    mockToArray.mockResolvedValue(
      messages.map((m) => ({
        _id: m.messageId,
        tenantId: 'acme',
        sessionId: overrides.sessionId ?? 'sess-1',
        role: m.role,
        content: m.content,
        timestamp: '2025-01-01T00:00:00Z',
      })),
    );

    return {
      tenantId: 'acme',
      projectId: 'proj-1',
      sessionId: 'sess-1',
      config: { threshold: 0.7 },
      previousSteps: {
        'read-conversation': {
          status: 'success',
          data: {
            messages: messages.map((m) => ({
              ...m,
              timestamp: '2025-01-01T00:00:00Z',
              channel: 'web_chat',
            })),
            metadata: {
              agentName: 'TestBot',
              channel: 'web_chat',
              messageCount: messages.length,
              durationMs: 3000,
              sessionStartedAt: '2025-01-01T00:00:00Z',
            },
          },
        },
      },
      pipelineInput: { tenantId: 'acme', projectId: 'proj-1', sessionId: 'sess-1' },
      ...overrides,
    };
  }

  test('safe session → writes to toxicity_evaluations and message_toxicity tables', async () => {
    const result = await computeToxicity(
      ctx(),
      makeInput([
        { messageId: 'msg-1', role: 'user', content: 'Hello, can you help?' },
        { messageId: 'msg-2', role: 'user', content: 'Thank you!' },
      ]),
    );

    expect(result.status).toBe('success');
    expect(result.data.status).toBe('pass');
    expect(result.data.flagged).toBe(false);

    // Should write to 2 tables: message_toxicity first, then toxicity_evaluations
    expect(mockInsert).toHaveBeenCalledTimes(2);

    const msgInsert = mockInsert.mock.calls[0][0];
    expect(msgInsert.table).toBe('abl_platform.message_toxicity');
    expect(msgInsert.values).toHaveLength(2);

    const sessionInsert = mockInsert.mock.calls[1][0];
    expect(sessionInsert.table).toBe('abl_platform.toxicity_evaluations');
    expect(sessionInsert.values[0].tenant_id).toBe('acme');
    expect(sessionInsert.values[0].status).toBe('pass');
  });

  test('toxic session → flagged with fail status', async () => {
    const result = await computeToxicity(
      ctx(),
      makeInput(
        [
          {
            messageId: 'msg-1',
            role: 'user',
            content: 'You stupid incompetent idiots are terrible!',
          },
        ],
        { sessionId: 'sess-2', config: { params: { threshold: 0.3 } } },
      ),
    );

    expect(result.status).toBe('success');
    expect(result.data.status).toBe('fail');
    expect(result.data.flagged).toBe(true);
    expect(result.data.avgToxicity).toBeGreaterThan(0.3);

    const sessionInsert = mockInsert.mock.calls[1][0];
    expect(sessionInsert.values[0].status).toBe('fail');
    expect(sessionInsert.values[0].flagged).toBe(1);
  });

  test('includes pipeline provenance in ClickHouse rows', async () => {
    const result = await computeToxicity(
      ctx(),
      makeInput([{ messageId: 'msg-1', role: 'user', content: 'Hello' }], {
        pipelineId: 'builtin:toxicity',
        pipelineType: 'builtin',
      }),
    );

    expect(result.status).toBe('success');

    // message_toxicity is written first, toxicity_evaluations second
    const msgRow = mockInsert.mock.calls[0][0].values[0];
    expect(msgRow.pipeline_id).toBe('builtin:toxicity');
    expect(msgRow.pipeline_type).toBe('builtin');

    const sessionRow = mockInsert.mock.calls[1][0].values[0];
    expect(sessionRow.pipeline_id).toBe('builtin:toxicity');
    expect(sessionRow.pipeline_type).toBe('builtin');
  });
});

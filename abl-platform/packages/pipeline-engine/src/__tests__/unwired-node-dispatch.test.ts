/**
 * Dispatch tests for the 7 newly-wired node types.
 *
 * Verifies that the activity router can dispatch to each service and
 * that each returns a valid StepOutput (status: 'success' | 'fail', data: object).
 *
 * Uses the same test pattern as activity-router.test.ts: mock Restate context,
 * mock external dependencies, call execute handler with each activity type.
 */
import { describe, test, expect, vi } from 'vitest';

vi.mock('@agent-platform/database/clickhouse', () => ({
  getClickHouseClient: () => ({
    insert: vi.fn().mockResolvedValue({}),
    query: vi.fn().mockResolvedValue({ json: () => Promise.resolve([]) }),
  }),
}));

vi.mock('mongoose', async (importOriginal) => {
  const actual = await importOriginal<typeof import('mongoose')>();
  const coll = {
    insertOne: vi.fn().mockResolvedValue({}),
    find: vi.fn().mockReturnValue({
      limit: vi.fn().mockReturnValue({
        toArray: vi.fn().mockResolvedValue([]),
      }),
    }),
  };
  const mockDb = {
    collection: vi.fn().mockReturnValue(coll),
  };
  const mockConnection = {
    ...actual.default.connection,
    db: mockDb,
  };
  return {
    ...actual,
    connection: mockConnection,
    default: {
      ...actual.default,
      connection: mockConnection,
    },
  };
});

import { activityRouter } from '../pipeline/handlers/activity-router.service.js';
import type { ActivityRouterInput } from '../pipeline/handlers/activity-router.service.js';
import type { PipelineStep, StepOutput } from '../pipeline/types.js';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function createMockContext(): any {
  return {
    run: async (_label: string, fn: () => any) => fn(),
    console: { log: () => {} },
    serviceClient: () => ({
      run: vi.fn().mockResolvedValue({ status: 'success', data: {} }),
    }),
    awakeable: () => ({
      id: 'test-awakeable-id',
      promise: Promise.resolve({}),
    }),
    sleep: vi.fn().mockResolvedValue(undefined),
  };
}

function makeInput(
  stepOverrides: Partial<PipelineStep> & { type: string },
  previousSteps: Record<string, StepOutput> = {},
): ActivityRouterInput {
  const step: PipelineStep = {
    id: 'test-step-1',
    name: 'Test Step',
    config: {},
    ...stepOverrides,
  };
  return {
    step,
    previousSteps,
    pipelineInput: {
      tenantId: 'test-tenant',
      projectId: 'test-project',
      sessionId: 'test-session',
    },
  };
}

const execute = (activityRouter as any).service.execute as (
  ctx: any,
  input: ActivityRouterInput,
) => Promise<StepOutput>;

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('Newly-wired node types dispatch', () => {
  describe('filter', () => {
    test('dispatches and returns valid StepOutput with matching items', async () => {
      const ctx = createMockContext();
      const input = makeInput(
        {
          type: 'filter',
          config: {
            source: 'input.items',
            expression: "item.status == 'active'",
          },
        },
        {},
      );
      input.pipelineInput.items = [
        { status: 'active', name: 'a' },
        { status: 'inactive', name: 'b' },
        { status: 'active', name: 'c' },
      ];

      const result = await execute(ctx, input);
      expect(result.status).toBe('success');
      expect(result.data).toBeDefined();
      expect(result.data.items).toHaveLength(2);
      expect(result.data.count).toBe(2);
      expect(result.data.originalCount).toBe(3);
    });

    test('returns fail when config is missing', async () => {
      const ctx = createMockContext();
      const input = makeInput({ type: 'filter', config: {} });

      const result = await execute(ctx, input);
      expect(result.status).toBe('fail');
      expect(result.data.error).toContain('source');
    });
  });

  describe('aggregate', () => {
    test('dispatches and computes aggregations', async () => {
      const ctx = createMockContext();
      const input = makeInput(
        {
          type: 'aggregate',
          config: {
            source: 'input.scores',
            operations: [
              { field: 'value', op: 'sum', as: 'total' },
              { field: 'value', op: 'avg', as: 'average' },
              { field: 'value', op: 'count', as: 'count' },
            ],
          },
        },
        {},
      );
      input.pipelineInput.scores = [{ value: 10 }, { value: 20 }, { value: 30 }];

      const result = await execute(ctx, input);
      expect(result.status).toBe('success');
      expect(result.data.total).toBe(60);
      expect(result.data.average).toBe(20);
      expect(result.data.count).toBe(3);
    });

    test('returns fail when config is missing', async () => {
      const ctx = createMockContext();
      const input = makeInput({ type: 'aggregate', config: {} });

      const result = await execute(ctx, input);
      expect(result.status).toBe('fail');
      expect(result.data.error).toContain('source');
    });
  });

  describe('send-email', () => {
    test('dispatches and returns fail when external module unavailable', async () => {
      const ctx = createMockContext();
      const input = makeInput({
        type: 'send-email',
        config: { to: 'user@test.com', subject: 'Test', body: 'Hello' },
      });

      const result = await execute(ctx, input);
      // Will fail — @agent-platform/notifications not installed in test env
      expect(result.status).toBe('fail');
      expect(result.data.error).toBeDefined();
    });

    test('returns fail when required config is missing', async () => {
      const ctx = createMockContext();
      const input = makeInput({ type: 'send-email', config: {} });

      const result = await execute(ctx, input);
      expect(result.status).toBe('fail');
      expect(result.data.error).toContain('to');
    });
  });

  describe('send-slack', () => {
    test('dispatches and returns fail when external module unavailable', async () => {
      const ctx = createMockContext();
      const input = makeInput({
        type: 'send-slack',
        config: { channel: '#test', message: 'Hello' },
      });

      const result = await execute(ctx, input);
      // Will fail — @agent-platform/notifications not installed in test env
      expect(result.status).toBe('fail');
      expect(result.data.error).toBeDefined();
    });

    test('returns fail when required config is missing', async () => {
      const ctx = createMockContext();
      const input = makeInput({ type: 'send-slack', config: {} });

      const result = await execute(ctx, input);
      expect(result.status).toBe('fail');
      expect(result.data.error).toContain('channel');
    });
  });

  describe('publish-kafka', () => {
    test('dispatches and returns fail when external module unavailable', async () => {
      const ctx = createMockContext();
      const input = makeInput({
        type: 'publish-kafka',
        config: { topic: 'test-topic', payload: { data: 'test' } },
      });

      const result = await execute(ctx, input);
      // Will fail — @agent-platform/messaging not installed in test env
      expect(result.status).toBe('fail');
      expect(result.data.error).toBeDefined();
    });

    test('returns fail when required config is missing', async () => {
      const ctx = createMockContext();
      const input = makeInput({ type: 'publish-kafka', config: {} });

      const result = await execute(ctx, input);
      expect(result.status).toBe('fail');
      expect(result.data.error).toContain('topic');
    });
  });

  describe('db-query', () => {
    test('ClickHouse path rejects DDL/DML queries via validateSQL', async () => {
      const ctx = createMockContext();
      const input = makeInput({
        type: 'db-query',
        config: {
          database: 'clickhouse',
          table: 'abl_platform.platform_events',
          query: 'DROP TABLE sessions',
        },
      });

      const result = await execute(ctx, input);
      expect(result.status).toBe('fail');
      expect(result.data.error).toContain('validation failed');
    });

    test('ClickHouse path requires tenant_id in query via validateSQL', async () => {
      const ctx = createMockContext();
      const input = makeInput({
        type: 'db-query',
        config: {
          database: 'clickhouse',
          table: 'abl_platform.platform_events',
          query: 'SELECT * FROM sessions',
        },
      });

      const result = await execute(ctx, input);
      expect(result.status).toBe('fail');
      expect(result.data.error).toContain('tenant_id');
    });

    test('MongoDB path returns fail for invalid JSON filter', async () => {
      const ctx = createMockContext();
      const input = makeInput({
        type: 'db-query',
        config: {
          database: 'mongodb',
          collection: 'messages',
          query: 'not valid json',
        },
      });

      const result = await execute(ctx, input);
      expect(result.status).toBe('fail');
      expect(result.data.error).toContain('Invalid MongoDB filter JSON');
    });

    test('MongoDB path executes query with tenant and project scoping', async () => {
      const ctx = createMockContext();
      const input = makeInput({
        type: 'db-query',
        config: {
          database: 'mongodb',
          collection: 'messages',
          query: '{"status": "active"}',
        },
      });

      const result = await execute(ctx, input);
      expect(result.status).toBe('success');
      expect(result.data.database).toBe('mongodb');
      expect(result.data.collection).toBe('messages');
    });

    test('returns fail when database or query not provided', async () => {
      const ctx = createMockContext();
      const input = makeInput({ type: 'db-query', config: {} });

      const result = await execute(ctx, input);
      expect(result.status).toBe('fail');
      expect(result.data.error).toContain('database');
    });

    test('returns fail when tenantId or projectId missing from pipeline input', async () => {
      const ctx = createMockContext();
      const input = makeInput({
        type: 'db-query',
        config: { database: 'clickhouse', query: 'SELECT 1' },
      });
      input.pipelineInput.tenantId = '';
      input.pipelineInput.projectId = '';

      const result = await execute(ctx, input);
      expect(result.status).toBe('fail');
      expect(result.data.error).toContain('tenantId');
    });
  });

  describe('sub-pipeline', () => {
    test('returns fail when pipelineId is missing', async () => {
      const ctx = createMockContext();
      const input = makeInput({ type: 'sub-pipeline', config: {} });

      const result = await execute(ctx, input);
      expect(result.status).toBe('fail');
      expect(result.data.error).toContain('pipelineId');
    });
  });
});

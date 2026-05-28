/**
 * Unit tests for the DbQuery Restate activity service.
 *
 * Tests validation, MongoDB path (tenant+project isolation), ClickHouse path
 * (SQL validation via validateSQL from nl-query), and missing-module graceful degradation.
 */
import { describe, test, expect, vi, beforeEach } from 'vitest';
import type { PipelineStepContext, StepOutput } from '../pipeline/types.js';

// ---------------------------------------------------------------------------
// Mock external dependencies
// ---------------------------------------------------------------------------

// Mock createLogger to avoid real logger initialization
vi.mock('@abl/compiler/platform', async (importOriginal) => {
  const actual = (await importOriginal()) as Record<string, unknown>;
  return {
    ...actual,
    createLogger: () => ({
      info: vi.fn(),
      warn: vi.fn(),
      error: vi.fn(),
      debug: vi.fn(),
    }),
  };
});

// Module-level mongoose mock with a mutable collection fn.
// The wrapper function dereferences mockMongoCollection at call time so each test
// can reassign it without needing vi.resetModules() (which breaks the hoisted mock above).
let mockMongoCollection: ReturnType<typeof vi.fn> = vi.fn();
vi.mock('mongoose', async (importOriginal) => {
  const actual = await importOriginal<Record<string, unknown>>();
  const actualDefault = (actual.default ?? actual) as Record<string, unknown>;
  return {
    ...actual,
    default: {
      ...actualDefault,
      connection: {
        db: {
          collection: (...args: unknown[]) => mockMongoCollection(...args),
        },
      },
    },
  };
});

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function createMockContext(): any {
  return {
    run: async (_label: string, fn: () => any) => fn(),
  };
}

function makeInput(overrides: Partial<PipelineStepContext> = {}): PipelineStepContext {
  return {
    tenantId: 'tenant-1',
    projectId: 'project-1',
    sessionId: 'sess-1',
    config: {},
    previousSteps: {},
    pipelineInput: { tenantId: 'tenant-1', projectId: 'project-1', sessionId: 'sess-1' },
    ...overrides,
  };
}

function getExecute(svc: any): (ctx: any, input: PipelineStepContext) => Promise<StepOutput> {
  return (svc as any).service.execute;
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('DbQueryService', () => {
  beforeEach(() => {
    vi.restoreAllMocks();
  });

  test('returns fail when database config is missing', async () => {
    const { dbQueryService } = await import('../pipeline/services/db-query.service.js');
    const execute = getExecute(dbQueryService);

    const ctx = createMockContext();
    const input = makeInput({
      config: { query: 'SELECT 1' },
    });

    const result = await execute(ctx, input);

    expect(result.status).toBe('fail');
    expect(result.data.error).toContain("'database'");
  });

  // ClickHouse requires 'table' to close the allowlist bypass where a user could omit 'table'
  // and query any table via raw SQL.
  test('ClickHouse path: fails when table is missing', async () => {
    const { dbQueryService } = await import('../pipeline/services/db-query.service.js');
    const execute = getExecute(dbQueryService);

    const ctx = createMockContext();
    const input = makeInput({
      config: {
        database: 'clickhouse',
        query: 'SELECT * FROM abl_platform.system_tables WHERE tenant_id = {tenantId:String}',
      },
    });

    const result = await execute(ctx, input);

    expect(result.status).toBe('fail');
    expect(result.data.error).toContain("'table'");
  });

  // query is optional for clickhouse when table is provided
  test('ClickHouse path: uses default query when query is omitted but table is set', async () => {
    vi.doMock('@agent-platform/database/clickhouse', () => ({
      getClickHouseClient: vi.fn().mockReturnValue({
        query: vi.fn().mockResolvedValue({ json: vi.fn().mockResolvedValue([]) }),
      }),
    }));

    const { dbQueryService } = await import('../pipeline/services/db-query.service.js');
    const execute = getExecute(dbQueryService);

    const ctx = createMockContext();
    const input = makeInput({
      config: { database: 'clickhouse', table: 'abl_platform.platform_events_by_session' },
    });

    const result = await execute(ctx, input);

    // Default query includes tenant_id — should pass validateSQL and reach the CH client
    expect(result.status).toBe('success');
    expect((result.data as Record<string, unknown>).table).toBe(
      'abl_platform.platform_events_by_session',
    );
  });

  test('returns fail when tenantId is missing', async () => {
    const { dbQueryService } = await import('../pipeline/services/db-query.service.js');
    const execute = getExecute(dbQueryService);

    const ctx = createMockContext();
    const input = makeInput({
      tenantId: undefined as any,
      config: { database: 'clickhouse', query: 'SELECT 1' },
      pipelineInput: { projectId: 'project-1' },
    });

    const result = await execute(ctx, input);

    expect(result.status).toBe('fail');
    expect(result.data.error).toContain('tenantId and projectId');
  });

  test('returns fail when projectId is missing', async () => {
    const { dbQueryService } = await import('../pipeline/services/db-query.service.js');
    const execute = getExecute(dbQueryService);

    const ctx = createMockContext();
    const input = makeInput({
      projectId: undefined,
      config: { database: 'clickhouse', query: 'SELECT 1' },
      pipelineInput: { tenantId: 'tenant-1' },
    });

    const result = await execute(ctx, input);

    expect(result.status).toBe('fail');
    expect(result.data.error).toContain('tenantId and projectId');
  });

  test('returns fail when sessionId is missing', async () => {
    const { dbQueryService } = await import('../pipeline/services/db-query.service.js');
    const execute = getExecute(dbQueryService);

    const ctx = createMockContext();
    const input = makeInput({
      sessionId: undefined as any,
      config: {
        database: 'clickhouse',
        table: 'abl_platform.platform_events_by_session',
        query:
          'SELECT * FROM abl_platform.platform_events_by_session WHERE tenant_id = {tenantId:String}',
      },
      pipelineInput: { tenantId: 'tenant-1', projectId: 'project-1' },
    });

    const result = await execute(ctx, input);

    expect(result.status).toBe('fail');
    expect(result.data.error).toContain('sessionId');
  });

  test('resolves config.sessionId template expression like {{input.sessionId}}', async () => {
    const mockFind = vi.fn().mockReturnValue({
      limit: vi.fn().mockReturnValue({
        toArray: vi.fn().mockResolvedValue([{ _id: 'doc1' }]),
      }),
    });
    mockMongoCollection = vi.fn().mockReturnValue({ find: mockFind });

    const { dbQueryService } = await import('../pipeline/services/db-query.service.js');
    const execute = getExecute(dbQueryService);

    const ctx = createMockContext();
    const input = makeInput({
      sessionId: undefined as any, // force resolution to come from config + pipelineInput
      config: {
        database: 'mongodb',
        collection: 'messages',
        sessionId: '{{input.sessionId}}', // template — must be substituted
        query: '{}',
      },
      pipelineInput: {
        tenantId: 'tenant-1',
        projectId: 'project-1',
        sessionId: 'resolved-sess-xyz',
      },
    });

    const result = await execute(ctx, input);

    expect(result.status).toBe('success');
    // Filter should have the RESOLVED sessionId, not the literal template string
    const filterUsed = mockFind.mock.calls[0][0];
    expect(filterUsed.sessionId).toBe('resolved-sess-xyz');
    expect(filterUsed.sessionId).not.toContain('{{');
  });

  test('returns fail when mongodb is selected without collection', async () => {
    const { dbQueryService } = await import('../pipeline/services/db-query.service.js');
    const execute = getExecute(dbQueryService);

    const ctx = createMockContext();
    const input = makeInput({
      config: { database: 'mongodb', query: '{}' },
    });

    const result = await execute(ctx, input);

    expect(result.status).toBe('fail');
    expect(result.data.error).toContain("'collection'");
  });

  test('ClickHouse path: rejects DDL statements via validateSQL', async () => {
    const { dbQueryService } = await import('../pipeline/services/db-query.service.js');
    const execute = getExecute(dbQueryService);

    const ctx = createMockContext();
    const input = makeInput({
      config: {
        database: 'clickhouse',
        table: 'abl_platform.platform_events_by_session',
        query: 'DROP TABLE analytics',
      },
    });

    const result = await execute(ctx, input);

    expect(result.status).toBe('fail');
    expect(result.data.error).toContain('Query validation failed');
  });

  test('ClickHouse path: rejects INSERT statements', async () => {
    const { dbQueryService } = await import('../pipeline/services/db-query.service.js');
    const execute = getExecute(dbQueryService);

    const ctx = createMockContext();
    const input = makeInput({
      config: {
        database: 'clickhouse',
        table: 'abl_platform.platform_events_by_session',
        query: 'INSERT INTO analytics VALUES (1, 2)',
      },
    });

    const result = await execute(ctx, input);

    expect(result.status).toBe('fail');
    expect(result.data.error).toContain('Query validation failed');
  });

  test('ClickHouse path: rejects SELECT query without tenant_id', async () => {
    const { dbQueryService } = await import('../pipeline/services/db-query.service.js');
    const execute = getExecute(dbQueryService);

    const ctx = createMockContext();
    const input = makeInput({
      config: {
        database: 'clickhouse',
        table: 'abl_platform.platform_events_by_session',
        query: 'SELECT * FROM abl_platform.platform_events_by_session WHERE project_id = 123',
      },
    });

    const result = await execute(ctx, input);

    expect(result.status).toBe('fail');
    expect(result.data.error).toContain('tenant_id');
  });

  test('ClickHouse path: rejects non-allowlisted table in config', async () => {
    const { dbQueryService } = await import('../pipeline/services/db-query.service.js');
    const execute = getExecute(dbQueryService);

    const ctx = createMockContext();
    const input = makeInput({
      config: {
        database: 'clickhouse',
        table: 'abl_platform.system_tables',
        query: 'SELECT * FROM abl_platform.system_tables WHERE tenant_id = {tenantId:String}',
      },
    });

    const result = await execute(ctx, input);

    expect(result.status).toBe('fail');
    expect(result.data.error).toContain('not in the allowed list');
  });

  test('ClickHouse path: graceful degradation when module not found', async () => {
    // Mock the module so getClickHouseClient throws a "Cannot find module" error
    vi.doMock('@agent-platform/database/clickhouse', () => ({
      getClickHouseClient: () => {
        throw new Error('Cannot find module @agent-platform/database/clickhouse');
      },
    }));

    // Re-import to pick up the mock
    const { dbQueryService } = await import('../pipeline/services/db-query.service.js');
    const execute = getExecute(dbQueryService);

    const ctx = createMockContext();
    const input = makeInput({
      config: {
        database: 'clickhouse',
        table: 'abl_platform.platform_events_by_session',
        query:
          'SELECT * FROM abl_platform.platform_events_by_session WHERE tenant_id = {tenantId:String}',
      },
    });

    const result = await execute(ctx, input);

    expect(result.status).toBe('fail');
    expect(result.data.error).toContain('not available');
  });

  test('MongoDB path: constructs query with tenantId and projectId in filter', async () => {
    const mockFind = vi.fn().mockReturnValue({
      limit: vi.fn().mockReturnValue({
        toArray: vi.fn().mockResolvedValue([{ _id: 'doc1', name: 'test' }]),
      }),
    });

    mockMongoCollection = vi.fn().mockReturnValue({ find: mockFind });

    const { dbQueryService } = await import('../pipeline/services/db-query.service.js');
    const execute = getExecute(dbQueryService);

    const ctx = createMockContext();
    const input = makeInput({
      config: {
        database: 'mongodb',
        query: '{"status": "active"}',
        collection: 'messages',
      },
    });

    const result = await execute(ctx, input);

    expect(result.status).toBe('success');
    expect(result.data.rows).toEqual([{ _id: 'doc1', name: 'test' }]);
    expect(result.data.rowCount).toBe(1);
    expect(result.data.database).toBe('mongodb');

    // Verify tenantId and projectId were injected into the filter
    const filterUsed = mockFind.mock.calls[0][0];
    expect(filterUsed.tenantId).toBe('tenant-1');
    expect(filterUsed.projectId).toBe('project-1');
    expect(filterUsed.sessionId).toBe('sess-1');
    expect(filterUsed.status).toBe('active');
  });

  test('MongoDB path: returns fail for invalid JSON filter', async () => {
    mockMongoCollection = vi.fn();

    const { dbQueryService } = await import('../pipeline/services/db-query.service.js');
    const execute = getExecute(dbQueryService);

    const ctx = createMockContext();
    const input = makeInput({
      config: {
        database: 'mongodb',
        query: 'not-valid-json{{{',
        collection: 'messages',
      },
    });

    const result = await execute(ctx, input);

    expect(result.status).toBe('fail');
    expect(result.data.error).toContain('Invalid MongoDB filter JSON');
  });

  test('MongoDB path: rejects collection not in allowlist', async () => {
    mockMongoCollection = vi.fn();

    const { dbQueryService } = await import('../pipeline/services/db-query.service.js');
    const execute = getExecute(dbQueryService);

    const ctx = createMockContext();
    const input = makeInput({
      config: {
        database: 'mongodb',
        query: '{"status": "active"}',
        collection: 'sessions',
      },
    });

    const result = await execute(ctx, input);

    expect(result.status).toBe('fail');
    expect(result.data.error).toContain('not in the allowed list');
  });

  test('MongoDB path: rejects $where operator', async () => {
    mockMongoCollection = vi.fn();

    const { dbQueryService } = await import('../pipeline/services/db-query.service.js');
    const execute = getExecute(dbQueryService);

    const ctx = createMockContext();
    const input = makeInput({
      config: {
        database: 'mongodb',
        query: '{"$where": "this.tenantId === \\"t1\\""}',
        collection: 'messages',
      },
    });

    const result = await execute(ctx, input);

    expect(result.status).toBe('fail');
    expect(result.data.error).toContain('$where');
    expect(result.data.error).toContain('not allowed');
  });

  test('MongoDB path: rejects $expr operator', async () => {
    mockMongoCollection = vi.fn();

    const { dbQueryService } = await import('../pipeline/services/db-query.service.js');
    const execute = getExecute(dbQueryService);

    const ctx = createMockContext();
    const input = makeInput({
      config: {
        database: 'mongodb',
        query: '{"$expr": {"$eq": ["$tenantId", "t1"]}}',
        collection: 'messages',
      },
    });

    const result = await execute(ctx, input);

    expect(result.status).toBe('fail');
    expect(result.data.error).toContain('$expr');
  });

  test('MongoDB path: rejects nested forbidden operator', async () => {
    mockMongoCollection = vi.fn();

    const { dbQueryService } = await import('../pipeline/services/db-query.service.js');
    const execute = getExecute(dbQueryService);

    const ctx = createMockContext();
    const input = makeInput({
      config: {
        database: 'mongodb',
        query: '{"$and": [{"status": "active"}, {"$where": "1==1"}]}',
        collection: 'custom_pipeline_results',
      },
    });

    const result = await execute(ctx, input);

    expect(result.status).toBe('fail');
    expect(result.data.error).toContain('$where');
  });

  test('MongoDB path: allows messages collection with safe operators', async () => {
    const mockFind = vi.fn().mockReturnValue({
      limit: vi.fn().mockReturnValue({
        toArray: vi.fn().mockResolvedValue([{ _id: 'msg1', role: 'user' }]),
      }),
    });
    mockMongoCollection = vi.fn().mockReturnValue({ find: mockFind });

    const { dbQueryService } = await import('../pipeline/services/db-query.service.js');
    const execute = getExecute(dbQueryService);

    const ctx = createMockContext();
    const input = makeInput({
      config: {
        database: 'mongodb',
        query: '{"role": {"$in": ["user", "assistant"]}}',
        collection: 'messages',
      },
    });

    const result = await execute(ctx, input);

    expect(result.status).toBe('success');
    expect(result.data.rows).toEqual([{ _id: 'msg1', role: 'user' }]);
  });

  test('MongoDB path: allows custom_pipeline_results collection', async () => {
    const mockFind = vi.fn().mockReturnValue({
      limit: vi.fn().mockReturnValue({
        toArray: vi.fn().mockResolvedValue([{ _id: 'r1', score: 0.9 }]),
      }),
    });
    mockMongoCollection = vi.fn().mockReturnValue({ find: mockFind });

    const { dbQueryService } = await import('../pipeline/services/db-query.service.js');
    const execute = getExecute(dbQueryService);

    const ctx = createMockContext();
    const input = makeInput({
      config: {
        database: 'mongodb',
        query: '{"score": {"$gt": 0.8}}',
        collection: 'custom_pipeline_results',
      },
    });

    const result = await execute(ctx, input);

    expect(result.status).toBe('success');
    expect(result.data.rows).toEqual([{ _id: 'r1', score: 0.9 }]);
  });
});

/**
 * ClickHouse Fact Store Tests
 *
 * Tests for ClickHouseFactStore using mocked ClickHouse client.
 * Covers CRUD operations, batch operations, query patterns,
 * TTL handling, and the createClickHouseFactStore factory.
 */

import { describe, test, expect, beforeEach, vi } from 'vitest';

// =============================================================================
// MOCK DEPENDENCIES
// =============================================================================

vi.mock('../../config/loader.js', () => ({
  isConfigLoaded: () => false,
  getConfig: () => ({ encryption: { masterKey: '' } }),
}));

import {
  ClickHouseFactStore,
  createClickHouseFactStore,
} from '../../services/stores/clickhouse-fact-store';

function createMockClickHouseClient() {
  return {
    insert: vi.fn().mockResolvedValue(undefined),
    query: vi.fn(),
    command: vi.fn().mockResolvedValue(undefined),
    close: vi.fn(),
  };
}

function mockQueryResult(rows: any[]) {
  return {
    json: vi.fn().mockResolvedValue(rows),
  };
}

// =============================================================================
// FACT STORE TESTS
// =============================================================================

describe('ClickHouseFactStore', () => {
  let store: ClickHouseFactStore;
  let mockClient: ReturnType<typeof createMockClickHouseClient>;

  beforeEach(() => {
    vi.clearAllMocks();
    mockClient = createMockClickHouseClient();
    store = new ClickHouseFactStore({ type: 'clickhouse' }, { client: mockClient as any });
  });

  // ===========================================================================
  // set()
  // ===========================================================================

  describe('set', () => {
    test('should insert a new fact with correct row structure', async () => {
      // Mock get() returning no existing fact
      mockClient.query.mockResolvedValueOnce(mockQueryResult([]));
      // Mock the insert
      mockClient.insert.mockResolvedValueOnce(undefined);

      const result = await store.set({
        key: 'user.preferences.theme',
        value: 'dark',
        source: { type: 'user' },
        metadata: { updatedBy: 'ui' },
      });

      expect(result.key).toBe('user.preferences.theme');
      expect(result.value).toBe('dark');
      expect(result.source.type).toBe('user');
      expect(result.id).toBeDefined();
      expect(result.createdAt).toBeInstanceOf(Date);
      expect(result.updatedAt).toBeInstanceOf(Date);

      expect(mockClient.insert).toHaveBeenCalledWith(
        expect.objectContaining({
          table: 'abl_platform.facts',
          format: 'JSONEachRow',
        }),
      );
    });

    test('should preserve id and createdAt for existing facts', async () => {
      const existingRow = {
        id: 'existing-id-123',
        key: 'system.config',
        value: '"old"',
        created_at: '2025-01-01T00:00:00.000Z',
        updated_at: '2025-01-01T00:00:00.000Z',
        expires_at: null,
        source_type: 'system',
        source_agent_name: '',
        source_session_id: '',
        source_trace_id: '',
        metadata: '{}',
      };
      mockClient.query.mockResolvedValueOnce(mockQueryResult([existingRow]));
      mockClient.insert.mockResolvedValueOnce(undefined);

      const result = await store.set({
        key: 'system.config',
        value: 'new',
      });

      expect(result.id).toBe('existing-id-123');
      expect(result.createdAt.toISOString()).toBe('2025-01-01T00:00:00.000Z');
      expect(result.value).toBe('new');
    });

    test('should handle TTL by setting expiresAt', async () => {
      mockClient.query.mockResolvedValueOnce(mockQueryResult([]));
      mockClient.insert.mockResolvedValueOnce(undefined);

      const result = await store.set({
        key: 'temp.value',
        value: 42,
        ttlMs: 3600000, // 1 hour
      });

      expect(result.expiresAt).toBeInstanceOf(Date);
      expect(result.expiresAt!.getTime()).toBeGreaterThan(Date.now());
    });

    test('should default source to system', async () => {
      mockClient.query.mockResolvedValueOnce(mockQueryResult([]));
      mockClient.insert.mockResolvedValueOnce(undefined);

      const result = await store.set({
        key: 'test.key',
        value: 'val',
      });

      expect(result.source.type).toBe('system');
    });

    test('should serialize complex values as JSON', async () => {
      mockClient.query.mockResolvedValueOnce(mockQueryResult([]));
      mockClient.insert.mockResolvedValueOnce(undefined);

      const complexValue = { nested: { array: [1, 2, 3], obj: { a: true } } };
      const result = await store.set({
        key: 'complex.value',
        value: complexValue,
      });

      const insertCall = mockClient.insert.mock.calls[0][0];
      const row = insertCall.values[0];
      expect(JSON.parse(row.value)).toEqual(complexValue);
    });
  });

  // ===========================================================================
  // get()
  // ===========================================================================

  describe('get', () => {
    test('should return fact when found', async () => {
      const row = {
        id: 'fact-1',
        key: 'user.name',
        value: '"Alice"',
        created_at: '2025-06-01T00:00:00.000Z',
        updated_at: '2025-06-01T12:00:00.000Z',
        expires_at: null,
        source_type: 'agent',
        source_agent_name: 'greeter',
        source_session_id: 'sess-1',
        source_trace_id: 'trace-1',
        metadata: '{"confidence":0.95}',
      };
      mockClient.query.mockResolvedValueOnce(mockQueryResult([row]));

      const result = await store.get({ key: 'user.name' });

      expect(result).not.toBeNull();
      expect(result!.id).toBe('fact-1');
      expect(result!.key).toBe('user.name');
      expect(result!.value).toBe('Alice');
      expect(result!.source.agentName).toBe('greeter');
      expect(result!.source.sessionId).toBe('sess-1');
      expect(result!.metadata).toEqual({ confidence: 0.95 });
    });

    test('should return null when not found', async () => {
      mockClient.query.mockResolvedValueOnce(mockQueryResult([]));

      const result = await store.get({ key: 'nonexistent' });
      expect(result).toBeNull();
    });

    test('should use FINAL for deduplication', async () => {
      mockClient.query.mockResolvedValueOnce(mockQueryResult([]));

      await store.get({ key: 'test' });

      const queryCall = mockClient.query.mock.calls[0][0];
      expect(queryCall.query).toContain('FINAL');
    });

    test('should filter expired facts', async () => {
      mockClient.query.mockResolvedValueOnce(mockQueryResult([]));

      await store.get({ key: 'test' });

      const queryCall = mockClient.query.mock.calls[0][0];
      expect(queryCall.query).toContain('expires_at');
    });

    test('should handle malformed JSON value gracefully', async () => {
      const row = {
        id: 'fact-bad',
        key: 'bad.json',
        value: 'not-valid-json',
        created_at: '2025-06-01T00:00:00.000Z',
        updated_at: '2025-06-01T00:00:00.000Z',
        expires_at: null,
        source_type: 'system',
        source_agent_name: '',
        source_session_id: '',
        source_trace_id: '',
        metadata: 'bad-metadata',
      };
      mockClient.query.mockResolvedValueOnce(mockQueryResult([row]));

      const result = await store.get({ key: 'bad.json' });

      expect(result).not.toBeNull();
      // tryParseJson returns raw string as fallback for value
      expect(result!.value).toBe('not-valid-json');
      // tryParseJson returns {} for bad metadata
      expect(result!.metadata).toEqual({});
    });
  });

  // ===========================================================================
  // delete()
  // ===========================================================================

  describe('delete', () => {
    test('should return true and issue DELETE when fact exists', async () => {
      // exists() query
      mockClient.query.mockResolvedValueOnce(mockQueryResult([{ found: 1 }]));

      const result = await store.delete('old.fact');

      expect(result).toBe(true);
      expect(mockClient.command).toHaveBeenCalledWith(
        expect.objectContaining({
          query: expect.stringContaining('DELETE'),
        }),
      );
      expect(mockClient.command.mock.calls[0][0].query).toContain('SETTINGS mutations_sync = 1');
    });

    test('should return false when fact does not exist', async () => {
      mockClient.query.mockResolvedValueOnce(mockQueryResult([]));

      const result = await store.delete('nonexistent');

      expect(result).toBe(false);
      expect(mockClient.command).not.toHaveBeenCalled();
    });
  });

  // ===========================================================================
  // exists()
  // ===========================================================================

  describe('exists', () => {
    test('should return true when fact exists', async () => {
      mockClient.query.mockResolvedValueOnce(mockQueryResult([{ found: 1 }]));

      const result = await store.exists('user.name');
      expect(result).toBe(true);
    });

    test('should return false when fact does not exist', async () => {
      mockClient.query.mockResolvedValueOnce(mockQueryResult([]));

      const result = await store.exists('missing');
      expect(result).toBe(false);
    });

    test('should use parameterized query', async () => {
      mockClient.query.mockResolvedValueOnce(mockQueryResult([]));

      await store.exists('test.key');

      const queryCall = mockClient.query.mock.calls[0][0];
      expect(queryCall.query_params.key).toBe('test.key');
    });
  });

  // ===========================================================================
  // query()
  // ===========================================================================

  describe('query', () => {
    test('should filter by prefix', async () => {
      mockClient.query.mockResolvedValueOnce(mockQueryResult([]));

      await store.query({ prefix: 'user.' });

      const queryCall = mockClient.query.mock.calls[0][0];
      expect(queryCall.query).toContain('LIKE');
      expect(queryCall.query_params.prefix).toBe('user.%');
    });

    test('should filter by pattern', async () => {
      mockClient.query.mockResolvedValueOnce(mockQueryResult([]));

      await store.query({ pattern: 'user.*.name' });

      const queryCall = mockClient.query.mock.calls[0][0];
      expect(queryCall.query).toContain('match');
    });

    test('should filter by source type', async () => {
      mockClient.query.mockResolvedValueOnce(mockQueryResult([]));

      await store.query({ sourceType: 'agent' });

      const queryCall = mockClient.query.mock.calls[0][0];
      expect(queryCall.query).toContain('source_type');
      expect(queryCall.query_params.sourceType).toBe('agent');
    });

    test('should include expired facts when requested', async () => {
      mockClient.query.mockResolvedValueOnce(mockQueryResult([]));

      await store.query({ includeExpired: true });

      const queryCall = mockClient.query.mock.calls[0][0];
      expect(queryCall.query).not.toContain('expires_at');
    });

    test('should respect limit', async () => {
      mockClient.query.mockResolvedValueOnce(mockQueryResult([]));

      await store.query({ limit: 10 });

      const queryCall = mockClient.query.mock.calls[0][0];
      expect(queryCall.query).toContain('LIMIT');
      expect(queryCall.query_params.limit).toBe(10);
    });

    test('should return mapped facts', async () => {
      const rows = [
        {
          id: 'f1',
          key: 'a.b',
          value: '42',
          created_at: '2025-01-01T00:00:00.000Z',
          updated_at: '2025-01-01T00:00:00.000Z',
          expires_at: null,
          source_type: 'system',
          source_agent_name: '',
          source_session_id: '',
          source_trace_id: '',
          metadata: '{}',
        },
      ];
      mockClient.query.mockResolvedValueOnce(mockQueryResult(rows));

      const result = await store.query({});

      expect(result).toHaveLength(1);
      expect(result[0].id).toBe('f1');
      expect(result[0].value).toBe(42);
    });
  });

  // ===========================================================================
  // batchSet()
  // ===========================================================================

  describe('batchSet', () => {
    test('should set multiple facts', async () => {
      // Each set() calls get() first, then insert()
      mockClient.query.mockResolvedValue(mockQueryResult([]));
      mockClient.insert.mockResolvedValue(undefined);

      const result = await store.batchSet({
        facts: [
          { key: 'a', value: 1 },
          { key: 'b', value: 2 },
        ],
        defaultSource: { type: 'system' },
      });

      expect(result).toHaveLength(2);
      expect(result[0].key).toBe('a');
      expect(result[1].key).toBe('b');
    });

    test('should use default source when per-fact source not specified', async () => {
      mockClient.query.mockResolvedValue(mockQueryResult([]));
      mockClient.insert.mockResolvedValue(undefined);

      const result = await store.batchSet({
        facts: [{ key: 'test', value: 'val' }],
        defaultSource: { type: 'agent', agentName: 'bot' },
      });

      expect(result[0].source.type).toBe('agent');
      expect(result[0].source.agentName).toBe('bot');
    });
  });

  // ===========================================================================
  // batchDelete()
  // ===========================================================================

  describe('batchDelete', () => {
    test('should delete multiple facts and return count', async () => {
      mockClient.query.mockResolvedValueOnce(mockQueryResult([{ cnt: '3' }]));

      const result = await store.batchDelete(['a', 'b', 'c']);

      expect(result).toBe(3);
      expect(mockClient.command).toHaveBeenCalledWith(
        expect.objectContaining({
          query: expect.stringContaining('DELETE'),
        }),
      );
      expect(mockClient.command.mock.calls[0][0].query).toContain('SETTINGS mutations_sync = 1');
    });

    test('should return 0 for empty keys array', async () => {
      const result = await store.batchDelete([]);
      expect(result).toBe(0);
      expect(mockClient.query).not.toHaveBeenCalled();
    });

    test('should not issue DELETE command when count is 0', async () => {
      mockClient.query.mockResolvedValueOnce(mockQueryResult([{ cnt: '0' }]));

      const result = await store.batchDelete(['nonexistent']);

      expect(result).toBe(0);
      expect(mockClient.command).not.toHaveBeenCalled();
    });
  });

  // ===========================================================================
  // clear()
  // ===========================================================================

  describe('clear', () => {
    test('should truncate table and return previous count', async () => {
      mockClient.query.mockResolvedValueOnce(mockQueryResult([{ cnt: '50' }]));

      const result = await store.clear();

      expect(result).toBe(50);
      expect(mockClient.command).toHaveBeenCalledWith(
        expect.objectContaining({
          query: expect.stringContaining('TRUNCATE'),
        }),
      );
    });

    test('should not truncate when table is empty', async () => {
      mockClient.query.mockResolvedValueOnce(mockQueryResult([{ cnt: '0' }]));

      const result = await store.clear();

      expect(result).toBe(0);
      expect(mockClient.command).not.toHaveBeenCalled();
    });
  });

  // ===========================================================================
  // cleanup()
  // ===========================================================================

  describe('cleanup', () => {
    test('should delete expired facts and return count', async () => {
      mockClient.query.mockResolvedValueOnce(mockQueryResult([{ cnt: '5' }]));

      const result = await store.cleanup();

      expect(result).toBe(5);
      expect(mockClient.command).toHaveBeenCalledWith(
        expect.objectContaining({
          query: expect.stringContaining('expires_at'),
        }),
      );
      expect(mockClient.command.mock.calls[0][0].query).toContain('SETTINGS mutations_sync = 1');
    });

    test('should not issue DELETE when no expired facts', async () => {
      mockClient.query.mockResolvedValueOnce(mockQueryResult([{ cnt: '0' }]));

      const result = await store.cleanup();

      expect(result).toBe(0);
      expect(mockClient.command).not.toHaveBeenCalled();
    });
  });

  // ===========================================================================
  // Factory
  // ===========================================================================

  describe('createClickHouseFactStore', () => {
    test('should create a store with correct config', () => {
      const client = createMockClickHouseClient();
      const store = createClickHouseFactStore(client as any);

      expect(store).toBeInstanceOf(ClickHouseFactStore);
    });

    test('should accept partial config overrides', () => {
      const client = createMockClickHouseClient();
      const store = createClickHouseFactStore(client as any, {
        defaultTtlMs: 3600000,
        keyPrefix: 'custom:',
      });

      expect(store).toBeInstanceOf(ClickHouseFactStore);
    });
  });
});

/**
 * ClickHouse Store Implementation Tests
 *
 * Tests for ClickHouseMessageStore, ClickHouseMetricsStore,
 * and ClickHouseAuditStore.
 * Uses mocked ClickHouse client and EncryptionService.
 */

import { describe, test, expect, beforeEach, vi } from 'vitest';

// =============================================================================
// MOCK DEPENDENCIES
// =============================================================================

const { mockLogger } = vi.hoisted(() => ({
  mockLogger: {
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    debug: vi.fn(),
  },
}));

vi.mock('@abl/compiler/platform', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@abl/compiler/platform')>();
  return {
    ...actual,
    createLogger: vi.fn(() => mockLogger),
  };
});

// Shared mock writer functions
const mockWriterInsert = vi.fn();
const mockWriterFlush = vi.fn().mockResolvedValue(undefined);
const mockWriterClose = vi.fn().mockResolvedValue(undefined);

// Mock BufferedClickHouseWriter as a proper class to support `new`
vi.mock('@agent-platform/database/clickhouse', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@agent-platform/database/clickhouse')>();
  return {
    ...actual,
    BufferedClickHouseWriter: class MockBufferedWriter {
      insert = mockWriterInsert;
      insertMany = vi.fn();
      flush = mockWriterFlush;
      close = mockWriterClose;
      pending = 0;
      constructor(_client: any, _opts: any) {}
    },
  };
});

import { ClickHouseMessageStore } from '../../services/stores/clickhouse-message-store';
import { ClickHouseMetricsStore } from '../../services/stores/clickhouse-metrics-store';
import { ClickHouseAuditStore } from '../../services/stores/clickhouse-audit-store';

const TEST_TENANT_ID = 'tenant-test-123';

function createMockClickHouseClient() {
  return {
    insert: vi.fn().mockResolvedValue(undefined),
    query: vi.fn(),
    command: vi.fn().mockResolvedValue(undefined),
    close: vi.fn(),
  };
}

// =============================================================================
// MESSAGE STORE TESTS
// =============================================================================

describe('ClickHouseMessageStore', () => {
  let store: ClickHouseMessageStore;
  let mockClient: ReturnType<typeof createMockClickHouseClient>;

  beforeEach(() => {
    vi.clearAllMocks();
    mockClient = createMockClickHouseClient();
    store = new ClickHouseMessageStore(
      { maxMessagesPerSession: 1000, retentionDays: 90 },
      {
        client: mockClient as any,
        tenantId: TEST_TENANT_ID,
      },
    );
  });

  describe('addMessage', () => {
    test('should return message with original content (not encrypted)', async () => {
      const result = await store.addMessage({
        sessionId: 'session-1',
        role: 'user',
        content: 'Hello, agent!',
        channel: 'web',
        metadata: { intent: 'greeting' },
      });

      expect(result.content).toBe('Hello, agent!');
      expect(result.sessionId).toBe('session-1');
      expect(result.role).toBe('user');
      expect(result.channel).toBe('web');
      expect(result.id).toBeTruthy();
      expect(result.timestamp).toBeInstanceOf(Date);
    });

    test('should write plaintext content to buffer (interceptor encrypts on flush)', async () => {
      await store.addMessage({
        sessionId: 'session-1',
        role: 'user',
        content: 'Secret message',
        channel: 'web',
      });

      expect(mockWriterInsert).toHaveBeenCalledTimes(1);
      const row = mockWriterInsert.mock.calls[0][0];

      // Store writes plaintext — the ClickHouse interceptor encrypts during flush
      expect(row.content).toBe('Secret message');

      // Row should have correct tenant and session
      expect(row.tenant_id).toBe(TEST_TENANT_ID);
      expect(row.session_id).toBe('session-1');
      expect(row.role).toBe('user');
      expect(row.encrypted).toBe(0);
    });

    test('should serialize metadata as JSON', async () => {
      await store.addMessage({
        sessionId: 'session-1',
        role: 'user',
        content: 'test',
        channel: 'web',
        metadata: { intent: 'greeting', confidence: 0.95 },
      });

      const row = mockWriterInsert.mock.calls[0][0];
      expect(JSON.parse(row.metadata)).toEqual({ intent: 'greeting', confidence: 0.95 });
    });

    test('should set traceId on the row when provided', async () => {
      await store.addMessage({
        sessionId: 'session-1',
        role: 'user',
        content: 'test',
        channel: 'web',
        traceId: 'trace-abc',
      });

      const row = mockWriterInsert.mock.calls[0][0];
      expect(row.trace_id).toBe('trace-abc');
    });

    test('should default traceId to empty string when not provided', async () => {
      await store.addMessage({
        sessionId: 'session-1',
        role: 'user',
        content: 'test',
        channel: 'web',
      });

      const row = mockWriterInsert.mock.calls[0][0];
      expect(row.trace_id).toBe('');
    });

    test('writes project_id from params to the row', async () => {
      await store.addMessage({
        sessionId: 'session-1',
        role: 'user',
        content: 'after-call-work note',
        channel: 'voice',
        projectId: 'proj-abc',
      });

      const row = mockWriterInsert.mock.calls[0][0];
      expect(row.project_id).toBe('proj-abc');
    });

    test('writes empty project_id when params.projectId is omitted', async () => {
      await store.addMessage({
        sessionId: 'session-1',
        role: 'assistant',
        content: 'reply',
        channel: 'web',
      });

      const row = mockWriterInsert.mock.calls[0][0];
      expect(row.project_id).toBe('');
    });
  });

  describe('getMessages', () => {
    test('should return message content from ClickHouse rows (interceptor decrypts before store)', async () => {
      // The ClickHouse interceptor decrypts content before it reaches the store,
      // so the store receives plaintext from the query result.
      mockClient.query.mockResolvedValue({
        json: () =>
          Promise.resolve([
            {
              tenant_id: TEST_TENANT_ID,
              session_id: 'session-1',
              created_at: '2024-01-01T00:00:00.000Z',
              message_id: 'msg-1',
              contact_id: '',
              role: 'user',
              channel: 'web',
              content: 'Decrypted message',
              metadata: '{"key":"value"}',
              encrypted: 1,
              key_version: 1,
              has_pii: 0,
              scrubbed: 0,
              trace_id: '',
            },
          ]),
      });

      const messages = await store.getMessages({ sessionId: 'session-1' });

      expect(messages).toHaveLength(1);
      expect(messages[0].content).toBe('Decrypted message');
      expect(messages[0].role).toBe('user');
      expect(messages[0].metadata).toEqual({ key: 'value' });
    });

    test('should handle unencrypted rows (encrypted=0)', async () => {
      mockClient.query.mockResolvedValue({
        json: () =>
          Promise.resolve([
            {
              tenant_id: TEST_TENANT_ID,
              session_id: 'session-1',
              created_at: '2024-01-01T00:00:00.000Z',
              message_id: 'msg-1',
              contact_id: '',
              role: 'assistant',
              channel: 'web',
              content: 'Plain text response',
              metadata: '{}',
              encrypted: 0,
              key_version: 0,
              has_pii: 0,
              scrubbed: 0,
              trace_id: '',
            },
          ]),
      });

      const messages = await store.getMessages({ sessionId: 'session-1' });

      expect(messages).toHaveLength(1);
      expect(messages[0].content).toBe('Plain text response');
    });

    test('should build query with correct tenant filter', async () => {
      mockClient.query.mockResolvedValue({
        json: () => Promise.resolve([]),
      });

      await store.getMessages({ sessionId: 'session-1' });

      expect(mockClient.query).toHaveBeenCalledTimes(1);
      const call = mockClient.query.mock.calls[0][0];
      expect(call.query).toContain('tenant_id = {tenantId:String}');
      expect(call.query).toContain('session_id = {sessionId:String}');
      expect(call.query_params.tenantId).toBe(TEST_TENANT_ID);
      expect(call.query_params.sessionId).toBe('session-1');
    });

    test('should apply role filter when provided', async () => {
      mockClient.query.mockResolvedValue({
        json: () => Promise.resolve([]),
      });

      await store.getMessages({ sessionId: 'session-1', roles: ['user', 'assistant'] });

      const call = mockClient.query.mock.calls[0][0];
      expect(call.query).toContain('role IN ({roles:Array(String)})');
    });

    test('should exclude system messages by default', async () => {
      mockClient.query.mockResolvedValue({
        json: () => Promise.resolve([]),
      });

      await store.getMessages({ sessionId: 'session-1' });

      const call = mockClient.query.mock.calls[0][0];
      expect(call.query).toContain("role != 'system'");
    });

    test('should include system messages when includeSystem is true', async () => {
      mockClient.query.mockResolvedValue({
        json: () => Promise.resolve([]),
      });

      await store.getMessages({ sessionId: 'session-1', includeSystem: true });

      const call = mockClient.query.mock.calls[0][0];
      expect(call.query).not.toContain("role != 'system'");
    });

    test('should apply pagination with offset and limit', async () => {
      mockClient.query.mockResolvedValue({
        json: () => Promise.resolve([]),
      });

      await store.getMessages({ sessionId: 'session-1', offset: 20, limit: 10 });

      const call = mockClient.query.mock.calls[0][0];
      expect(call.query_params.offset).toBe(20);
      expect(call.query_params.limit).toBe(10);
    });
  });

  describe('getMessageCount', () => {
    test('should return count from ClickHouse', async () => {
      mockClient.query.mockResolvedValue({
        json: () => Promise.resolve([{ cnt: '42' }]),
      });

      const count = await store.getMessageCount('session-1');
      expect(count).toBe(42);
    });

    test('should return 0 for empty result', async () => {
      mockClient.query.mockResolvedValue({
        json: () => Promise.resolve([]),
      });

      const count = await store.getMessageCount('session-1');
      expect(count).toBe(0);
    });
  });

  describe('deleteBySession', () => {
    test('should issue ALTER TABLE DELETE', async () => {
      mockClient.query.mockResolvedValue({
        json: () => Promise.resolve([{ cnt: '5' }]),
      });

      const deleted = await store.deleteBySession('session-1');

      expect(deleted).toBe(5);
      expect(mockClient.command).toHaveBeenCalledTimes(1);
      const cmd = mockClient.command.mock.calls[0][0];
      expect(cmd.query).toContain('ALTER TABLE abl_platform.messages DELETE');
      expect(cmd.query).toContain('SETTINGS mutations_sync = 1');
      expect(cmd.query_params.sessionId).toBe('session-1');
    });
  });

  describe('cleanup', () => {
    test('should delete messages older than specified time', async () => {
      mockClient.query.mockResolvedValue({
        json: () => Promise.resolve([{ cnt: '10' }]),
      });

      const deleted = await store.cleanup(7 * 24 * 60 * 60 * 1000); // 7 days

      expect(deleted).toBe(10);
      expect(mockClient.command).toHaveBeenCalledTimes(1);
      const cmd = mockClient.command.mock.calls[0][0];
      expect(cmd.query).toContain('ALTER TABLE abl_platform.messages DELETE');
      expect(cmd.query).toContain('created_at < {cutoff:DateTime64(3)}');
      expect(cmd.query).toContain('SETTINGS mutations_sync = 1');
    });

    test('should skip delete when count is zero', async () => {
      mockClient.query.mockResolvedValue({
        json: () => Promise.resolve([{ cnt: '0' }]),
      });

      const deleted = await store.cleanup(7 * 24 * 60 * 60 * 1000);

      expect(deleted).toBe(0);
      expect(mockClient.command).not.toHaveBeenCalled();
    });
  });

  describe('close', () => {
    test('should close the writer', async () => {
      await store.close();
      expect(mockWriterClose).toHaveBeenCalledTimes(1);
    });
  });
});

// =============================================================================
// METRICS STORE TESTS
// =============================================================================

describe('ClickHouseMetricsStore', () => {
  let store: ClickHouseMetricsStore;
  let mockClient: ReturnType<typeof createMockClickHouseClient>;

  beforeEach(() => {
    vi.clearAllMocks();
    mockClient = createMockClickHouseClient();
    store = new ClickHouseMetricsStore(
      { retentionDays: 365 },
      { client: mockClient as any, tenantId: TEST_TENANT_ID },
    );
  });

  describe('record', () => {
    test('should buffer a metric row', async () => {
      await store.record({
        modelId: 'gpt-4',
        provider: 'openai',
        sessionId: 'session-1',
        projectId: 'project-1',
        inputTokens: 100,
        outputTokens: 50,
        totalTokens: 150,
        estimatedCost: 0.015,
        latencyMs: 250,
        streamingUsed: true,
        toolCallCount: 2,
      });

      expect(mockWriterInsert).toHaveBeenCalledTimes(1);
      const row = mockWriterInsert.mock.calls[0][0];
      expect(row.tenant_id).toBe(TEST_TENANT_ID);
      expect(row.model_id).toBe('gpt-4');
      expect(row.provider).toBe('openai');
      expect(row.input_tokens).toBe(100);
      expect(row.output_tokens).toBe(50);
      expect(row.total_tokens).toBe(150);
      expect(row.estimated_cost).toBe(0.015);
      expect(row.streaming_used).toBe(1);
      expect(row.tool_call_count).toBe(2);
      expect(row.success).toBe(1);
    });

    test('should default estimated_cost to 0 when not provided', async () => {
      await store.record({
        modelId: 'gpt-4',
        provider: 'openai',
        sessionId: 'session-1',
        projectId: 'project-1',
        inputTokens: 10,
        outputTokens: 5,
        totalTokens: 15,
        latencyMs: 100,
        streamingUsed: false,
        toolCallCount: 0,
      });

      const row = mockWriterInsert.mock.calls[0][0];
      expect(row.estimated_cost).toBe(0);
      expect(row.streaming_used).toBe(0);
    });

    test('backs off flush attempts after a ClickHouse connection failure', async () => {
      const nowSpy = vi.spyOn(Date, 'now');
      nowSpy.mockReturnValue(1_000);
      mockWriterFlush.mockRejectedValueOnce(new Error('connect ECONNREFUSED 127.0.0.1:8123'));

      await store.record({
        modelId: 'gpt-4',
        provider: 'openai',
        sessionId: 'session-1',
        projectId: 'project-1',
        inputTokens: 10,
        outputTokens: 5,
        totalTokens: 15,
        latencyMs: 100,
        streamingUsed: false,
        toolCallCount: 0,
      });

      expect(mockWriterFlush).toHaveBeenCalledTimes(1);

      nowSpy.mockReturnValue(2_000);
      await store.record({
        modelId: 'gpt-4',
        provider: 'openai',
        sessionId: 'session-2',
        projectId: 'project-1',
        inputTokens: 20,
        outputTokens: 10,
        totalTokens: 30,
        latencyMs: 110,
        streamingUsed: false,
        toolCallCount: 0,
      });

      expect(mockWriterInsert).toHaveBeenCalledTimes(2);
      expect(mockWriterFlush).toHaveBeenCalledTimes(1);
      expect(mockLogger.warn).toHaveBeenCalledWith(
        'Immediate metrics flush failed, backing off',
        expect.objectContaining({
          error: 'connect ECONNREFUSED 127.0.0.1:8123',
          retryInMs: 60_000,
        }),
      );

      nowSpy.mockReturnValue(61_500);
      await store.record({
        modelId: 'gpt-4',
        provider: 'openai',
        sessionId: 'session-3',
        projectId: 'project-1',
        inputTokens: 30,
        outputTokens: 15,
        totalTokens: 45,
        latencyMs: 120,
        streamingUsed: true,
        toolCallCount: 1,
      });

      expect(mockWriterFlush).toHaveBeenCalledTimes(2);
      nowSpy.mockRestore();
    });
  });

  describe('getUsage', () => {
    test('should return aggregated usage summary', async () => {
      mockClient.query.mockResolvedValue({
        json: () =>
          Promise.resolve([
            {
              totalRequests: '1000',
              inputTokens: '50000',
              outputTokens: '25000',
              totalTokens: '75000',
              estimatedCost: '7.50',
              avgLatencyMs: '234.5',
            },
          ]),
      });

      const usage = await store.getUsage({ projectId: 'project-1' });

      expect(usage.totalRequests).toBe(1000);
      expect(usage.inputTokens).toBe(50000);
      expect(usage.outputTokens).toBe(25000);
      expect(usage.totalTokens).toBe(75000);
      expect(usage.estimatedCost).toBe(7.5);
      expect(usage.avgLatencyMs).toBe(235); // rounded
    });

    test('should return zeros for empty data', async () => {
      mockClient.query.mockResolvedValue({
        json: () => Promise.resolve([{}]),
      });

      const usage = await store.getUsage({ projectId: 'project-1' });
      expect(usage.totalRequests).toBe(0);
      expect(usage.totalTokens).toBe(0);
      expect(usage.estimatedCost).toBe(0);
    });

    test('should apply date filters when provided', async () => {
      mockClient.query.mockResolvedValue({
        json: () => Promise.resolve([{}]),
      });

      await store.getUsage({
        projectId: 'project-1',
        startDate: new Date('2024-01-01'),
        endDate: new Date('2024-06-30'),
      });

      const call = mockClient.query.mock.calls[0][0];
      expect(call.query).toContain('timestamp >= {startDate:DateTime64(3)}');
      expect(call.query).toContain('timestamp <= {endDate:DateTime64(3)}');
    });

    test('should always filter by tenant_id and project_id', async () => {
      mockClient.query.mockResolvedValue({
        json: () => Promise.resolve([{}]),
      });

      await store.getUsage({ projectId: 'project-1' });

      const call = mockClient.query.mock.calls[0][0];
      expect(call.query).toContain('tenant_id = {tenantId:String}');
      expect(call.query).toContain('project_id = {projectId:String}');
      expect(call.query_params.tenantId).toBe(TEST_TENANT_ID);
      expect(call.query_params.projectId).toBe('project-1');
    });
  });

  describe('getCostBreakdown', () => {
    test('should return per-model cost breakdown', async () => {
      mockClient.query.mockResolvedValue({
        json: () =>
          Promise.resolve([
            {
              modelId: 'gpt-4',
              provider: 'openai',
              requests: '500',
              inputTokens: '25000',
              outputTokens: '12500',
              totalTokens: '37500',
              estimatedCost: '5.00',
            },
            {
              modelId: 'claude-3',
              provider: 'anthropic',
              requests: '300',
              inputTokens: '15000',
              outputTokens: '7500',
              totalTokens: '22500',
              estimatedCost: '2.50',
            },
          ]),
      });

      const breakdown = await store.getCostBreakdown({ projectId: 'project-1' });

      expect(breakdown).toHaveLength(2);
      expect(breakdown[0].modelId).toBe('gpt-4');
      expect(breakdown[0].provider).toBe('openai');
      expect(breakdown[0].estimatedCost).toBe(5.0);
      expect(breakdown[1].modelId).toBe('claude-3');
      expect(breakdown[1].requests).toBe(300);
    });

    test('should return empty array when no data', async () => {
      mockClient.query.mockResolvedValue({
        json: () => Promise.resolve([]),
      });

      const breakdown = await store.getCostBreakdown({ projectId: 'project-1' });
      expect(breakdown).toEqual([]);
    });
  });

  describe('close', () => {
    test('should close the writer', async () => {
      await store.close();
      expect(mockWriterClose).toHaveBeenCalled();
    });
  });
});

// =============================================================================
// AUDIT STORE TESTS
// =============================================================================

describe('ClickHouseAuditStore', () => {
  let store: ClickHouseAuditStore;
  let mockClient: ReturnType<typeof createMockClickHouseClient>;

  beforeEach(() => {
    vi.clearAllMocks();
    mockClient = createMockClickHouseClient();
    store = new ClickHouseAuditStore(
      {
        enabled: true,
        retentionDays: 365,
        sensitiveActions: ['delete_user', 'modify_permissions'],
      },
      { client: mockClient as any, tenantId: TEST_TENANT_ID },
    );
  });

  describe('query', () => {
    test('should return audit logs with pagination', async () => {
      // Mock count query
      mockClient.query
        .mockResolvedValueOnce({
          json: () => Promise.resolve([{ cnt: '100' }]),
        })
        // Mock data query
        .mockResolvedValueOnce({
          json: () =>
            Promise.resolve([
              {
                tenant_id: TEST_TENANT_ID,
                timestamp: '2024-01-01 00:00:00',
                action: 'login',
                event_id: 'evt-1',
                actor_id: 'user-1',
                actor_type: 'user',
                actor_ip: '192.168.1.1',
                resource_type: 'session',
                resource_id: 'session-1',
                session_id: '',
                project_id: '',
                old_value: '',
                new_value: '{"status":"active"}',
                metadata: '{}',
                success: 1,
                failure_reason: '',
              },
            ]),
        });

      const result = await store.query({
        tenantId: TEST_TENANT_ID,
        startTime: new Date('2024-01-01'),
        endTime: new Date('2024-12-31'),
        limit: 50,
        offset: 0,
      });

      expect(result.total).toBe(100);
      expect(result.logs).toHaveLength(1);
      expect(result.logs[0].action).toBe('login');
      expect(result.logs[0].actor).toBe('user-1');
      expect(result.logs[0].ipAddress).toBe('192.168.1.1');
      expect(result.logs[0].newValue).toEqual({ status: 'active' });
      expect(result.logs[0].tenantId).toBe(TEST_TENANT_ID);
      expect(result.logs[0].projectId).toBeUndefined();
    });

    test('should build query with optional filters', async () => {
      mockClient.query
        .mockResolvedValueOnce({ json: () => Promise.resolve([{ cnt: '0' }]) })
        .mockResolvedValueOnce({ json: () => Promise.resolve([]) });

      await store.query({
        tenantId: TEST_TENANT_ID,
        startTime: new Date('2024-01-01'),
        endTime: new Date('2024-12-31'),
        actor: 'user-1',
        resourceType: 'agent',
        resourceId: 'agent-1',
        eventTypes: ['create', 'update'],
      });

      // Check count query has all filters
      const countQuery = mockClient.query.mock.calls[0][0];
      expect(countQuery.query).toContain('actor_id = {actorId:String}');
      expect(countQuery.query).toContain('resource_type = {resourceType:String}');
      expect(countQuery.query).toContain('resource_id = {resourceId:String}');
      expect(countQuery.query).toContain('IN ({eventTypes:Array(String)})');
    });

    test('should handle empty old_value and new_value', async () => {
      mockClient.query
        .mockResolvedValueOnce({ json: () => Promise.resolve([{ cnt: '1' }]) })
        .mockResolvedValueOnce({
          json: () =>
            Promise.resolve([
              {
                tenant_id: TEST_TENANT_ID,
                timestamp: '2024-01-01 00:00:00',
                action: 'view',
                event_id: 'evt-2',
                actor_id: 'user-1',
                actor_type: 'user',
                actor_ip: '',
                resource_type: 'dashboard',
                resource_id: 'dash-1',
                session_id: '',
                project_id: '',
                old_value: '',
                new_value: '',
                metadata: '{}',
                success: 1,
                failure_reason: '',
              },
            ]),
        });

      const result = await store.query({
        tenantId: TEST_TENANT_ID,
        startTime: new Date('2024-01-01'),
        endTime: new Date('2024-12-31'),
      });

      expect(result.logs[0].oldValue).toBeUndefined();
      expect(result.logs[0].newValue).toBeUndefined();
      expect(result.logs[0].ipAddress).toBeUndefined();
    });

    test('should always include tenant_id and time range in query', async () => {
      mockClient.query
        .mockResolvedValueOnce({ json: () => Promise.resolve([{ cnt: '0' }]) })
        .mockResolvedValueOnce({ json: () => Promise.resolve([]) });

      await store.query({
        tenantId: TEST_TENANT_ID,
        startTime: new Date('2024-01-01'),
        endTime: new Date('2024-12-31'),
      });

      const call = mockClient.query.mock.calls[0][0];
      expect(call.query).toContain('tenant_id = {tenantId:String}');
      expect(call.query).toContain('timestamp >= {startTime:DateTime}');
      expect(call.query).toContain('timestamp <= {endTime:DateTime}');
      expect(call.query_params.tenantId).toBe(TEST_TENANT_ID);
    });
  });

  describe('getSummary', () => {
    test('should aggregate events by type, actor, and resource', async () => {
      mockClient.query.mockResolvedValue({
        json: () =>
          Promise.resolve([
            { event_type: 'login', actor_id: 'user-1', resource_type: 'session', cnt: '50' },
            { event_type: 'login', actor_id: 'user-2', resource_type: 'session', cnt: '30' },
            { event_type: 'create', actor_id: 'user-1', resource_type: 'agent', cnt: '10' },
          ]),
      });

      const summary = await store.getSummary(
        'unscoped',
        'production',
        new Date('2024-01-01'),
        new Date('2024-12-31'),
      );

      expect(summary.totalEvents).toBe(90);
      expect(summary.eventsByType['login']).toBe(80);
      expect(summary.eventsByType['create']).toBe(10);
      expect(summary.eventsByActor['user-1']).toBe(60);
      expect(summary.eventsByActor['user-2']).toBe(30);
      expect(summary.eventsByResource['session']).toBe(80);
      expect(summary.eventsByResource['agent']).toBe(10);
    });

    test('should return zeros for empty data', async () => {
      mockClient.query.mockResolvedValue({
        json: () => Promise.resolve([]),
      });

      const summary = await store.getSummary(
        'unscoped',
        'production',
        new Date('2024-01-01'),
        new Date('2024-12-31'),
      );

      expect(summary.totalEvents).toBe(0);
      expect(summary.eventsByType).toEqual({});
    });
  });

  describe('getByTraceId', () => {
    test('should return audit logs for a trace', async () => {
      mockClient.query.mockResolvedValue({
        json: () =>
          Promise.resolve([
            {
              tenant_id: TEST_TENANT_ID,
              timestamp: '2024-01-01 00:00:00',
              action: 'tool_call',
              event_id: 'evt-1',
              actor_id: 'agent-1',
              actor_type: 'agent',
              actor_ip: '',
              resource_type: 'tool',
              resource_id: 'search-tool',
              session_id: 'trace-1',
              project_id: '',
              old_value: '',
              new_value: '',
              metadata: '{}',
              success: 1,
              failure_reason: '',
            },
          ]),
      });

      const logs = await store.getByTraceId('unscoped', 'trace-1');

      expect(logs).toHaveLength(1);
      expect(logs[0].action).toBe('tool_call');
      expect(logs[0].tenantId).toBe(TEST_TENANT_ID);
      expect(logs[0].projectId).toBeUndefined();

      // Verify query uses session_id for trace lookup
      const queryCall = mockClient.query.mock.calls[0][0];
      expect(queryCall.query).toContain('session_id = {traceId:String}');
      expect(queryCall.query_params.traceId).toBe('trace-1');
    });

    test('should return empty array for nonexistent trace', async () => {
      mockClient.query.mockResolvedValue({
        json: () => Promise.resolve([]),
      });

      const logs = await store.getByTraceId('unscoped', 'nonexistent');
      expect(logs).toEqual([]);
    });
  });

  describe('close', () => {
    test('should close the writer', async () => {
      await store.close();
      expect(mockWriterClose).toHaveBeenCalled();
    });
  });
});

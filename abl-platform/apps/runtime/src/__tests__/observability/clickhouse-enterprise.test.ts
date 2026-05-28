/**
 * ClickHouse Enterprise Readiness Tests
 *
 * Tests for security, tenant isolation, error resilience,
 * large payloads, compliance, and edge cases.
 */

import { describe, test, expect, beforeEach, vi } from 'vitest';
import crypto from 'crypto';

// Shared mock writer functions
const mockWriterInsert = vi.fn();
const mockWriterClose = vi.fn().mockResolvedValue(undefined);

vi.mock('@agent-platform/database/clickhouse', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@agent-platform/database/clickhouse')>();
  return {
    ...actual,
    BufferedClickHouseWriter: class MockBufferedWriter {
      insert = mockWriterInsert;
      insertMany = vi.fn();
      flush = vi.fn().mockResolvedValue(undefined);
      close = mockWriterClose;
      pending = 0;
      constructor(_client: any, _opts: any) {}
    },
  };
});

import { ClickHouseMessageStore } from '../../services/stores/clickhouse-message-store';
import { ClickHouseMetricsStore } from '../../services/stores/clickhouse-metrics-store';
import { ClickHouseAuditStore } from '../../services/stores/clickhouse-audit-store';

// Helper to create a ClickHouseMessageStore without encryptionService (now handled by interceptor)
function createMessageStore(mockClient: any, tenantId: string) {
  return new ClickHouseMessageStore(
    { maxMessagesPerSession: 1000, retentionDays: 90 },
    { client: mockClient, tenantId },
  );
}

function createMockClickHouseClient() {
  return {
    insert: vi.fn().mockResolvedValue(undefined),
    query: vi.fn(),
    command: vi.fn().mockResolvedValue(undefined),
    close: vi.fn(),
  };
}

// =============================================================================
// TENANT ISOLATION TESTS
// =============================================================================

describe('Tenant Isolation', () => {
  test('message store always includes tenant_id in queries', async () => {
    const mockClient = createMockClickHouseClient();
    const store = createMessageStore(mockClient as any, 'tenant-isolated');

    mockClient.query.mockResolvedValue({ json: () => Promise.resolve([]) });

    await store.getMessages({ sessionId: 'any-session' });
    const query = mockClient.query.mock.calls[0][0];
    expect(query.query).toContain('tenant_id = {tenantId:String}');
    expect(query.query_params.tenantId).toBe('tenant-isolated');
  });

  test('audit store always includes tenant_id in queries', async () => {
    const mockClient = createMockClickHouseClient();
    const store = new ClickHouseAuditStore(
      { enabled: true, retentionDays: 365, sensitiveActions: [] },
      { client: mockClient as any, tenantId: 'tenant-audit' },
    );

    mockClient.query
      .mockResolvedValueOnce({ json: () => Promise.resolve([{ cnt: '0' }]) })
      .mockResolvedValueOnce({ json: () => Promise.resolve([]) });

    await store.query({
      tenantId: 'tenant-audit',
      startTime: new Date('2024-01-01'),
      endTime: new Date('2024-12-31'),
    });

    // Both count and data queries must have tenant filter
    for (const call of mockClient.query.mock.calls) {
      expect(call[0].query).toContain('tenant_id = {tenantId:String}');
      expect(call[0].query_params.tenantId).toBe('tenant-audit');
    }
  });

  test('metrics store includes tenant_id in all queries', async () => {
    const mockClient = createMockClickHouseClient();
    const store = new ClickHouseMetricsStore(
      { retentionDays: 365 },
      { client: mockClient as any, tenantId: 'tenant-metrics' },
    );

    mockClient.query.mockResolvedValue({ json: () => Promise.resolve([{}]) });

    await store.getUsage({ projectId: 'proj-1' });
    expect(mockClient.query.mock.calls[0][0].query_params.tenantId).toBe('tenant-metrics');

    await store.getCostBreakdown({ projectId: 'proj-1' });
    expect(mockClient.query.mock.calls[1][0].query_params.tenantId).toBe('tenant-metrics');
  });
});

// =============================================================================
// SQL INJECTION PREVENTION
// =============================================================================

describe('SQL Injection Prevention', () => {
  test('parameterized queries prevent SQL injection in sessionId', async () => {
    const mockClient = createMockClickHouseClient();
    const store = createMessageStore(mockClient as any, 'tenant-1');

    mockClient.query.mockResolvedValue({ json: () => Promise.resolve([]) });

    // Attempt SQL injection via sessionId
    await store.getMessages({
      sessionId: "'; DROP TABLE messages; --",
    });

    const call = mockClient.query.mock.calls[0][0];
    // sessionId should be passed as a parameter, NOT interpolated into SQL
    expect(call.query).not.toContain('DROP TABLE');
    expect(call.query).toContain('session_id = {sessionId:String}');
    expect(call.query_params.sessionId).toBe("'; DROP TABLE messages; --");
  });

  test('parameterized queries prevent SQL injection in actor filter', async () => {
    const mockClient = createMockClickHouseClient();
    const store = new ClickHouseAuditStore(
      { enabled: true, retentionDays: 365, sensitiveActions: [] },
      { client: mockClient as any, tenantId: 'tenant-1' },
    );

    mockClient.query
      .mockResolvedValueOnce({ json: () => Promise.resolve([{ cnt: '0' }]) })
      .mockResolvedValueOnce({ json: () => Promise.resolve([]) });

    await store.query({
      startTime: new Date('2024-01-01'),
      endTime: new Date('2024-12-31'),
      actor: "admin' OR '1'='1",
    });

    const call = mockClient.query.mock.calls[0][0];
    expect(call.query).not.toContain("OR '1'='1");
    expect(call.query).toContain('actor_id = {actorId:String}');
    expect(call.query_params.actorId).toBe("admin' OR '1'='1");
  });
});

// =============================================================================
// ERROR RESILIENCE
// =============================================================================

describe('Error Resilience', () => {
  test('message store handles ClickHouse query failure gracefully', async () => {
    const mockClient = createMockClickHouseClient();
    const store = createMessageStore(mockClient as any, 'tenant-1');

    mockClient.query.mockRejectedValue(new Error('ClickHouse connection refused'));

    await expect(store.getMessages({ sessionId: 'session-1' })).rejects.toThrow(
      'ClickHouse connection refused',
    );
  });

  test('audit store handles malformed JSON gracefully', async () => {
    const mockClient = createMockClickHouseClient();
    const store = new ClickHouseAuditStore(
      { enabled: true, retentionDays: 365, sensitiveActions: [] },
      { client: mockClient as any, tenantId: 'tenant-1' },
    );

    mockClient.query
      .mockResolvedValueOnce({ json: () => Promise.resolve([{ cnt: '1' }]) })
      .mockResolvedValueOnce({
        json: () =>
          Promise.resolve([
            {
              tenant_id: 'tenant-1',
              timestamp: '2024-01-01 00:00:00',
              action: 'test',
              event_id: 'evt-1',
              actor_id: 'user-1',
              actor_type: 'user',
              actor_ip: '',
              resource_type: 'test',
              resource_id: 'res-1',
              session_id: '',
              project_id: '',
              old_value: '{invalid json', // malformed
              new_value: '',
              metadata: 'not-json', // malformed
              success: 1,
              failure_reason: '',
            },
          ]),
      });

    // Should not throw — tryParseJson handles malformed data
    const result = await store.query({
      startTime: new Date('2024-01-01'),
      endTime: new Date('2024-12-31'),
    });

    expect(result.logs).toHaveLength(1);
    expect(result.logs[0].oldValue).toBeUndefined(); // gracefully undefined
    expect(result.logs[0].metadata).toEqual({}); // fallback to empty
  });

  test('message store passes through content from interceptor (corruption caught at interceptor layer)', async () => {
    const mockClient = createMockClickHouseClient();
    const store = createMessageStore(mockClient as any, 'tenant-1');

    // The ClickHouse interceptor handles decryption — if data is corrupted,
    // the interceptor catches the error. The store receives whatever the
    // interceptor returns. Here we simulate the interceptor returning plaintext.
    mockClient.query.mockResolvedValue({
      json: () =>
        Promise.resolve([
          {
            tenant_id: 'tenant-1',
            session_id: 'session-1',
            created_at: '2024-01-01T00:00:00.000Z',
            message_id: 'msg-1',
            contact_id: '',
            role: 'user',
            channel: 'web',
            content: 'recovered plaintext',
            metadata: '{}',
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
    expect(messages[0].content).toBe('recovered plaintext');
  });

  test('metrics store handles empty query results', async () => {
    const mockClient = createMockClickHouseClient();
    const store = new ClickHouseMetricsStore(
      { retentionDays: 365 },
      { client: mockClient as any, tenantId: 'tenant-1' },
    );

    // Empty result (no rows at all)
    mockClient.query.mockResolvedValue({
      json: () => Promise.resolve([]),
    });

    const usage = await store.getUsage({ projectId: 'project-1' });
    expect(usage.totalRequests).toBe(0);
    expect(usage.estimatedCost).toBe(0);
  });
});

// =============================================================================
// LARGE PAYLOADS
// =============================================================================

describe('Large Payloads', () => {
  test('message store writes large content to buffer (interceptor encrypts on flush)', async () => {
    vi.clearAllMocks();
    const mockClient = createMockClickHouseClient();
    const store = createMessageStore(mockClient as any, 'tenant-1');

    const largeMessage = 'B'.repeat(100_000); // 100KB
    await store.addMessage({
      sessionId: 'session-1',
      role: 'user',
      content: largeMessage,
      channel: 'web',
    });

    const row = mockWriterInsert.mock.calls[0][0];
    // Store writes plaintext — the ClickHouse interceptor encrypts during flush
    expect(row.content).toBe(largeMessage);
    expect(row.encrypted).toBe(0);
  });
});

// =============================================================================
// EDGE CASES
// =============================================================================

describe('Edge Cases', () => {
  test('audit store handles zero results in getSummary', async () => {
    const mockClient = createMockClickHouseClient();
    const store = new ClickHouseAuditStore(
      { enabled: true, retentionDays: 365, sensitiveActions: [] },
      { client: mockClient as any, tenantId: 'tenant-1' },
    );

    mockClient.query.mockResolvedValue({
      json: () => Promise.resolve([]),
    });

    const summary = await store.getSummary('unscoped', 'production' as any, new Date(), new Date());
    expect(summary.totalEvents).toBe(0);
    expect(summary.eventsByType).toEqual({});
    expect(summary.eventsByActor).toEqual({});
    expect(summary.eventsByResource).toEqual({});
  });

  test('message store cleanup returns 0 when no expired messages', async () => {
    const mockClient = createMockClickHouseClient();
    const store = createMessageStore(mockClient as any, 'tenant-1');

    mockClient.query.mockResolvedValue({
      json: () => Promise.resolve([{ cnt: '0' }]),
    });

    const count = await store.cleanup(86400000);
    expect(count).toBe(0);
    expect(mockClient.command).not.toHaveBeenCalled();
  });

  test('metrics store handles concurrent usage queries', async () => {
    const mockClient = createMockClickHouseClient();
    const store = new ClickHouseMetricsStore(
      { retentionDays: 365 },
      { client: mockClient as any, tenantId: 'tenant-1' },
    );

    mockClient.query.mockResolvedValue({
      json: () =>
        Promise.resolve([
          {
            totalRequests: '100',
            inputTokens: '5000',
            outputTokens: '2500',
            totalTokens: '7500',
            estimatedCost: '0.75',
            avgLatencyMs: '200',
          },
        ]),
    });

    // Run multiple queries concurrently
    const results = await Promise.all([
      store.getUsage({ projectId: 'proj-1' }),
      store.getUsage({ projectId: 'proj-2' }),
      store.getUsage({ projectId: 'proj-3' }),
    ]);

    expect(results).toHaveLength(3);
    for (const usage of results) {
      expect(usage.totalRequests).toBe(100);
    }
  });
});

// =============================================================================
// BUFFERED WRITER RESILIENCE TESTS
// =============================================================================

describe('BufferedWriter Resilience (via database package)', () => {
  // Import separately for direct testing
  test('writer handles backpressure with maxBufferSize', async () => {
    // This is tested via the updated clickhouse-writer.test.ts
    // Here we verify the stores construct writers correctly
    vi.clearAllMocks();
    const mockClient = createMockClickHouseClient();

    // Should not throw during construction
    const store = createMessageStore(mockClient as any, 'tenant-1');

    // Multiple rapid writes should not throw
    for (let i = 0; i < 100; i++) {
      await store.addMessage({
        sessionId: `session-${i}`,
        role: 'user',
        content: `Message ${i}`,
        channel: 'web',
      });
    }

    expect(mockWriterInsert).toHaveBeenCalledTimes(100);
  });
});

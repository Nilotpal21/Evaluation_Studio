import { beforeEach, describe, expect, test, vi } from 'vitest';
import type { ClickHouseAuditRow } from '../services/stores/clickhouse-audit-store.js';

const { mockWriterInsert, mockWriterFlush, mockWriterClose, mockLogger } = vi.hoisted(() => ({
  mockWriterInsert: vi.fn(),
  mockWriterFlush: vi.fn().mockResolvedValue(undefined),
  mockWriterClose: vi.fn().mockResolvedValue(undefined),
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

vi.mock('@agent-platform/database/clickhouse', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@agent-platform/database/clickhouse')>();
  return {
    ...actual,
    BufferedClickHouseWriter: class MockBufferedWriter {
      insert = mockWriterInsert;
      flush = mockWriterFlush;
      close = mockWriterClose;
      pending = 0;
      constructor(_client: unknown, _opts: unknown) {}
    },
  };
});

import { ClickHouseAuditStore } from '../services/stores/clickhouse-audit-store.js';

function createMockClickHouseClient() {
  return {
    query: vi.fn(),
    command: vi.fn().mockResolvedValue(undefined),
    close: vi.fn(),
  };
}

describe('ClickHouseAuditStore', () => {
  const tenantId = 'tenant-clickhouse';
  let mockClient: ReturnType<typeof createMockClickHouseClient>;
  let store: ClickHouseAuditStore;

  beforeEach(() => {
    vi.clearAllMocks();
    mockClient = createMockClickHouseClient();
    store = new ClickHouseAuditStore(
      { type: 'clickhouse' },
      {
        client: mockClient as never,
        canonicalWriterEnabled: true,
      },
    );
  });

  test('append() writes canonical rows with traceId and compatibility metadata', async () => {
    await store.log({
      tenantId,
      projectId: 'project-1',
      eventType: 'session.started',
      actor: 'user-1',
      actorType: 'user',
      resourceType: 'session',
      resourceId: 'sess-1',
      environment: 'production',
      action: 'session.created',
      metadata: { channel: 'web' },
      traceId: 'trace-1',
    });

    expect(mockWriterInsert).toHaveBeenCalledTimes(1);
    const row = mockWriterInsert.mock.calls[0][0] as ClickHouseAuditRow;
    expect(row.tenant_id).toBe(tenantId);
    expect(row.project_id).toBe('project-1');
    expect(row.session_id).toBe('trace-1');
    expect(row.action).toBe('session.created');

    const metadata = JSON.parse(row.metadata) as Record<string, unknown>;
    expect(metadata.eventType).toBe('session.started');
    expect(metadata.traceId).toBe('trace-1');
    expect(metadata.source).toBe('runtime-store');
    expect(metadata.schemaVersion).toBe(2);
    expect(metadata.metadataEncoding).toBe('object');
    expect(metadata.retentionClass).toBe('default');
    expect(metadata.channel).toBe('web');
  });

  test('query() is tenant-scoped and decodes canonical eventType from metadata', async () => {
    mockClient.query
      .mockResolvedValueOnce({ json: () => Promise.resolve([{ cnt: '1' }]) })
      .mockResolvedValueOnce({
        json: () =>
          Promise.resolve([
            {
              tenant_id: tenantId,
              timestamp: '2026-04-16 12:00:00',
              action: 'session.created',
              event_id: 'evt-1',
              actor_id: 'user-1',
              actor_type: 'user',
              actor_ip: '10.0.0.1',
              actor_user_agent: '',
              resource_type: 'session',
              resource_id: 'sess-1',
              session_id: 'trace-1',
              project_id: 'project-1',
              old_value: '',
              new_value: '',
              metadata: JSON.stringify({
                eventType: 'session.started',
                actorType: 'user',
                tenantId,
                projectId: 'project-1',
                resourceType: 'session',
                resourceId: 'sess-1',
                environment: 'production',
                traceId: 'trace-1',
                source: 'runtime-store',
                schemaVersion: 2,
                metadataEncoding: 'object',
                retentionClass: 'default',
                channel: 'web',
              }),
              success: 1,
              failure_reason: '',
            },
          ]),
      });

    const result = await store.query({
      tenantId,
      startTime: new Date('2026-04-16T00:00:00.000Z'),
      endTime: new Date('2026-04-17T00:00:00.000Z'),
      eventTypes: ['session.started'],
      actor: 'user-1',
      resourceType: 'session',
      resourceId: 'sess-1',
      environment: 'production',
    });

    expect(result.total).toBe(1);
    expect(result.logs).toHaveLength(1);
    expect(result.logs[0].tenantId).toBe(tenantId);
    expect(result.logs[0].eventType).toBe('session.started');
    expect(result.logs[0].action).toBe('session.created');
    expect(result.logs[0].traceId).toBe('trace-1');
    expect(result.logs[0].metadata.channel).toBe('web');

    const countQuery = mockClient.query.mock.calls[0][0];
    expect(countQuery.query).toContain(`tenant_id = {tenantId:String}`);
    expect(countQuery.query).toContain(`JSONExtractString(metadata, 'eventType')`);
    expect(countQuery.query).toContain(`JSONExtractString(metadata, 'environment')`);
    expect(countQuery.query_params.tenantId).toBe(tenantId);
    expect(countQuery.query_params.environment).toBe('production');
  });

  test('getSummary() groups by canonical eventType', async () => {
    mockClient.query.mockResolvedValue({
      json: () =>
        Promise.resolve([
          { event_type: 'session.started', actor_id: 'user-1', resource_type: 'session', cnt: '2' },
          { event_type: 'tool.executed', actor_id: 'agent-1', resource_type: 'tool', cnt: '1' },
        ]),
    });

    const summary = await store.getSummary(
      tenantId,
      'production',
      new Date('2026-04-16T00:00:00.000Z'),
      new Date('2026-04-17T00:00:00.000Z'),
    );

    expect(summary.totalEvents).toBe(3);
    expect(summary.eventsByType['session.started']).toBe(2);
    expect(summary.eventsByType['tool.executed']).toBe(1);
    expect(summary.eventsByActor['user-1']).toBe(2);
    expect(summary.eventsByResource['session']).toBe(2);

    const summaryQuery = mockClient.query.mock.calls[0][0];
    expect(summaryQuery.query).toContain(`JSONExtractString(metadata, 'environment')`);
    expect(summaryQuery.query_params.environment).toBe('production');
  });

  test('getByTraceId() supports canonical and legacy trace compatibility lookup', async () => {
    mockClient.query.mockResolvedValue({
      json: () =>
        Promise.resolve([
          {
            tenant_id: tenantId,
            timestamp: '2026-04-16 12:00:00',
            action: 'tool.executed',
            event_id: 'evt-legacy-trace',
            actor_id: 'agent-1',
            actor_type: 'agent',
            actor_ip: '',
            actor_user_agent: '',
            resource_type: 'tool',
            resource_id: 'lookup',
            session_id: '',
            project_id: '',
            old_value: '',
            new_value: '',
            metadata: JSON.stringify({
              eventType: 'tool.executed',
              actorType: 'agent',
              tenantId,
              resourceType: 'tool',
              resourceId: 'lookup',
              environment: 'production',
              traceId: 'trace-legacy',
              source: 'runtime-store',
              schemaVersion: 2,
              metadataEncoding: 'object',
              retentionClass: 'default',
            }),
            success: 1,
            failure_reason: '',
          },
        ]),
    });

    const logs = await store.getByTraceId(tenantId, 'trace-legacy');

    expect(logs).toHaveLength(1);
    expect(logs[0].traceId).toBe('trace-legacy');
    expect(logs[0].eventType).toBe('tool.executed');

    const queryCall = mockClient.query.mock.calls[0][0];
    expect(queryCall.query).toContain(`session_id = {traceId:String}`);
    expect(queryCall.query).toContain(`JSONExtractString(metadata, 'traceId') = {traceId:String}`);
    expect(queryCall.query_params.tenantId).toBe(tenantId);
  });

  test('decodeRow() preserves legacy metadata.eventType when it differs from action', () => {
    const decoded = ClickHouseAuditStore.decodeRow({
      tenant_id: tenantId,
      timestamp: '2026-04-16 12:00:00',
      action: 'session.created',
      event_id: 'evt-legacy-event-type',
      actor_id: 'user-1',
      actor_type: 'user',
      actor_ip: '',
      actor_user_agent: '',
      resource_type: 'session',
      resource_id: 'sess-1',
      session_id: 'trace-legacy',
      project_id: '',
      old_value: '',
      new_value: '',
      metadata: JSON.stringify({
        eventType: 'session.started',
        environment: 'production',
      }),
      success: 1,
      failure_reason: '',
    });

    expect(decoded.eventType).toBe('session.started');
    expect(decoded.action).toBe('session.created');
    expect(decoded.environment).toBe('production');
  });

  test('query() requires an explicit tenant when no tenant-scoped store default exists', async () => {
    mockClient.query.mockResolvedValue({ json: () => Promise.resolve([]) });

    await expect(
      store.query({
        startTime: new Date('2026-04-16T00:00:00.000Z'),
        endTime: new Date('2026-04-17T00:00:00.000Z'),
      }),
    ).rejects.toThrow('tenantId is required for ClickHouse audit reads');
  });
});

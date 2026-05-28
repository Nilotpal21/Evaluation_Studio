import { beforeEach, describe, expect, test, vi } from 'vitest';

const { mockQuery, mockGetClickHouseClient } = vi.hoisted(() => ({
  mockQuery: vi.fn(),
  mockGetClickHouseClient: vi.fn(),
}));

vi.mock('@agent-platform/database/clickhouse', () => ({
  getClickHouseClient: (...args: unknown[]) => mockGetClickHouseClient(...args),
}));

describe('admin ClickHouse audit reader', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockGetClickHouseClient.mockReturnValue({
      query: mockQuery,
    });
  });

  test('maps ClickHouse audit rows into admin audit entries', async () => {
    mockQuery
      .mockResolvedValueOnce({
        json: () => Promise.resolve([{ cnt: '1' }]),
      })
      .mockResolvedValueOnce({
        json: () =>
          Promise.resolve([
            {
              tenant_id: '',
              timestamp: '2026-04-21 10:00:00',
              action: 'secret_rotate',
              event_id: 'audit-1',
              actor_id: 'admin-1',
              actor_type: 'admin',
              actor_ip: '10.0.0.5',
              actor_user_agent: '',
              resource_type: 'secret',
              resource_id: 'secrets/prod/api-key',
              session_id: 'trace-1',
              project_id: '',
              old_value: '',
              new_value: '',
              metadata: JSON.stringify({
                target: 'secrets/prod/api-key',
                actorRole: 'ADMIN',
                environment: 'production',
                eventType: 'secret_rotate',
                source: 'admin',
                schemaVersion: 2,
                metadataEncoding: 'object',
                retentionClass: 'crud',
                note: 'clickhouse',
              }),
              success: 1,
              failure_reason: '',
            },
          ]),
      });

    const { queryAdminAuditLogsFromClickHouse } =
      await import('../lib/admin-clickhouse-audit-reader');
    const result = await queryAdminAuditLogsFromClickHouse({
      actor: 'admin-1',
      action: 'secret_rotate',
      limit: 10,
    });

    expect(result).toHaveLength(1);
    expect(result[0]).toMatchObject({
      actor: 'admin-1',
      actorRole: 'ADMIN',
      action: 'secret_rotate',
      target: 'secrets/prod/api-key',
      environment: 'production',
      ipAddress: '10.0.0.5',
      metadata: {
        target: 'secrets/prod/api-key',
        actorRole: 'ADMIN',
        note: 'clickhouse',
      },
    });

    expect(mockQuery.mock.calls[0][0].query_params).toMatchObject({
      actorId: 'admin-1',
      actions: ['secret_rotate'],
    });
  });

  test('supports explicit tenant-scoped admin reads when requested', async () => {
    mockQuery
      .mockResolvedValueOnce({
        json: () => Promise.resolve([{ cnt: '0' }]),
      })
      .mockResolvedValueOnce({
        json: () => Promise.resolve([]),
      });

    const { queryAdminAuditLogsFromClickHouse } =
      await import('../lib/admin-clickhouse-audit-reader');
    await queryAdminAuditLogsFromClickHouse({
      tenantId: 'tenant-123',
      scope: 'tenant',
      limit: 10,
    });

    expect(mockQuery.mock.calls[0][0].query).toContain('tenant_id = {tenantId:String}');
    expect(mockQuery.mock.calls[0][0].query_params).toMatchObject({
      tenantId: 'tenant-123',
    });
  });
});

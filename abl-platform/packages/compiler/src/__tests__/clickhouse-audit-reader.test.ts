import { describe, expect, test, vi } from 'vitest';
import {
  ClickHouseAuditReader,
  decodeClickHouseAuditRow,
  type ClickHouseAuditRow,
} from '../platform/stores/clickhouse-audit-reader.js';

function createMockClickHouseClient() {
  return {
    query: vi.fn(),
  };
}

describe('ClickHouseAuditReader', () => {
  test('queries canonical audit rows with optional tenant filtering', async () => {
    const client = createMockClickHouseClient();
    client.query
      .mockResolvedValueOnce({ json: () => Promise.resolve([{ cnt: '1' }]) })
      .mockResolvedValueOnce({
        json: () =>
          Promise.resolve([
            {
              tenant_id: 'tenant-a',
              timestamp: '2026-04-21 10:00:00',
              action: 'workspace_created',
              event_id: 'audit-1',
              actor_id: 'user-1',
              actor_type: 'user',
              actor_ip: '10.0.0.5',
              actor_user_agent: 'agent',
              resource_type: 'workspace',
              resource_id: 'workspace-1',
              session_id: 'trace-1',
              project_id: '',
              old_value: '',
              new_value: '',
              metadata: JSON.stringify({
                eventType: 'workspace_created',
                tenantId: 'tenant-a',
                environment: 'production',
                source: 'studio',
                schemaVersion: 2,
                metadataEncoding: 'object',
                retentionClass: 'crud',
                workspaceName: 'Acme',
              }),
              success: 1,
              failure_reason: '',
            } satisfies ClickHouseAuditRow,
          ]),
      });

    const reader = new ClickHouseAuditReader(client as never, {
      requireTenantId: false,
    });
    const result = await reader.query({
      actor: 'user-1',
      projectId: 'project-1',
      eventTypes: ['workspace_created'],
      startTime: new Date('2026-04-21T00:00:00.000Z'),
      endTime: new Date('2026-04-22T00:00:00.000Z'),
      limit: 10,
      offset: 0,
    });

    expect(result.total).toBe(1);
    expect(result.logs).toHaveLength(1);
    expect(result.logs[0]).toMatchObject({
      tenantId: 'tenant-a',
      actor: 'user-1',
      action: 'workspace_created',
      eventType: 'workspace_created',
      ipAddress: '10.0.0.5',
    });

    const countQuery = client.query.mock.calls[0][0];
    expect(countQuery.query).not.toContain('tenant_id = {tenantId:String}');
    expect(countQuery.query).toContain(`actor_id = {actorId:String}`);
    expect(countQuery.query).toContain(`project_id = {projectId:String}`);
    expect(countQuery.query).toContain(`JSONExtractString(metadata, 'eventType')`);
    expect(countQuery.query_params).toMatchObject({
      projectId: 'project-1',
    });
  });

  test('applies explicit action filters when requested', async () => {
    const client = createMockClickHouseClient();
    client.query
      .mockResolvedValueOnce({ json: () => Promise.resolve([{ cnt: '0' }]) })
      .mockResolvedValueOnce({
        json: () => Promise.resolve([]),
      });

    const reader = new ClickHouseAuditReader(client as never, {
      requireTenantId: false,
    });

    await reader.query({
      actions: ['secret_rotate'],
      startTime: new Date('2026-04-21T00:00:00.000Z'),
      endTime: new Date('2026-04-22T00:00:00.000Z'),
      limit: 10,
      offset: 0,
    });

    const countQuery = client.query.mock.calls[0][0];
    expect(countQuery.query).toContain(`action IN ({actions:Array(String)})`);
    expect(countQuery.query_params).toMatchObject({
      actions: ['secret_rotate'],
    });
  });

  test('requires tenant scope by default', async () => {
    const reader = new ClickHouseAuditReader(createMockClickHouseClient() as never);

    await expect(
      reader.query({
        startTime: new Date('2026-04-21T00:00:00.000Z'),
        endTime: new Date('2026-04-22T00:00:00.000Z'),
      }),
    ).rejects.toThrow('tenantId is required for ClickHouse audit reads');
  });

  test('rejects invalid table names before issuing SQL', () => {
    expect(
      () =>
        new ClickHouseAuditReader(createMockClickHouseClient() as never, {
          requireTenantId: false,
          tableName: 'abl_platform.audit_events; DROP TABLE users',
        }),
    ).toThrow('Invalid ClickHouse audit table name');
  });

  test('decodes legacy rows that only carry compatibility metadata', () => {
    const decoded = decodeClickHouseAuditRow({
      tenant_id: 'tenant-a',
      timestamp: '2026-04-21 10:00:00',
      action: 'session.created',
      event_id: 'audit-2',
      actor_id: 'user-1',
      actor_type: 'user',
      actor_ip: '',
      actor_user_agent: '',
      resource_type: 'session',
      resource_id: 'session-1',
      session_id: 'trace-1',
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
    expect(decoded.timestamp).toBeInstanceOf(Date);
  });

  test('decodes normalized multi-stream rows with projected canonical fields', () => {
    const decoded = decodeClickHouseAuditRow({
      tenant_id: 'tenant-a',
      timestamp: '2026-04-21 10:00:00',
      action: 'encrypt',
      event_id: 'audit-3',
      actor_id: 'system',
      actor_type: 'system',
      actor_ip: '',
      actor_user_agent: '',
      resource_type: 'kms_key',
      resource_id: 'key-1',
      session_id: '',
      project_id: 'project-1',
      old_value: JSON.stringify({ status: 'pending' }),
      new_value: JSON.stringify({ status: 'encrypted' }),
      metadata: JSON.stringify({ providerType: 'local' }),
      success: 1,
      failure_reason: '',
      event_type: 'kms.encrypt',
      source: 'admin',
      environment: 'production',
    });

    expect(decoded).toMatchObject({
      tenantId: 'tenant-a',
      projectId: 'project-1',
      action: 'encrypt',
      eventType: 'kms.encrypt',
      resourceType: 'kms_key',
      resourceId: 'key-1',
      source: 'admin',
      environment: 'production',
      oldValue: { status: 'pending' },
      newValue: { status: 'encrypted' },
    });
  });
});

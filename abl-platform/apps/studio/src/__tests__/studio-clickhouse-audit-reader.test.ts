import { beforeEach, describe, expect, test, vi } from 'vitest';
import {
  appendInMemoryAuditTestEvent,
  resetInMemoryAuditTestBackend,
} from '@abl/compiler/platform/stores';

const { mockClickHouseQuery } = vi.hoisted(() => ({
  mockClickHouseQuery: vi.fn(),
}));

vi.mock('@agent-platform/database/clickhouse', () => ({
  getClickHouseClient: () => ({
    query: mockClickHouseQuery,
  }),
}));

describe('queryStudioAuditLogsFromClickHouse', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    delete process.env.AUDIT_PIPELINE_TEST_BACKEND;
    resetInMemoryAuditTestBackend();
    mockClickHouseQuery.mockImplementation(async ({ query }: { query: string }) => ({
      json: async () => (query.includes('count()') ? [{ cnt: '0' }] : []),
    }));
  });

  test('routes trace-id-only queries through the explorer SQL path', async () => {
    const { queryStudioAuditLogsFromClickHouse } =
      await import('../lib/studio-clickhouse-audit-reader');

    await queryStudioAuditLogsFromClickHouse({
      scope: 'workspace',
      personalScopeMode: 'tenant-safe',
      userId: 'user-1',
      tenantId: 'tenant-1',
      traceId: 'trace-1',
      from: '2026-05-01T00:00:00.000Z',
      to: '2026-05-08T00:00:00.000Z',
      limit: 50,
      offset: 0,
    });

    expect(mockClickHouseQuery).toHaveBeenCalled();
    const queries = mockClickHouseQuery.mock.calls.map(([params]) => String(params.query));
    expect(queries.some((query) => query.includes('session_id = {traceId:String}'))).toBe(true);
    expect(queries.some((query) => query.includes('abl_platform.kms_audit_log'))).toBe(true);
    expect(queries.some((query) => query.includes('abl_platform.connector_audit_log'))).toBe(true);
  });

  test('applies compliance audit filtering to default queries', async () => {
    const { queryStudioAuditLogsFromClickHouse } =
      await import('../lib/studio-clickhouse-audit-reader');

    await queryStudioAuditLogsFromClickHouse({
      scope: 'workspace',
      personalScopeMode: 'tenant-safe',
      userId: 'user-1',
      tenantId: 'tenant-1',
      from: '2026-05-01T00:00:00.000Z',
      to: '2026-05-08T00:00:00.000Z',
      limit: 50,
      offset: 0,
    });

    const queryParams = mockClickHouseQuery.mock.calls[0][0].query_params;
    expect(queryParams.complianceValues).toEqual(
      expect.arrayContaining(['login', 'project_updated', 'audit_export_downloaded']),
    );
    expect(queryParams.complianceValues).not.toContain('token_refresh');
    expect(queryParams.complianceValues).not.toContain('tool.executed');
  });

  test('filters stored project lifecycle events across all explorer dimensions', async () => {
    process.env.AUDIT_PIPELINE_TEST_BACKEND = 'memory';
    const { queryStudioAuditLogsFromClickHouse } =
      await import('../lib/studio-clickhouse-audit-reader');

    appendInMemoryAuditTestEvent({
      auditId: 'audit-project-target',
      timestamp: '2026-05-02T10:00:00.000Z',
      source: 'studio',
      eventType: 'project_created',
      action: 'project_created',
      actorId: 'actor-admin',
      actorType: 'user',
      tenantId: 'tenant-1',
      projectId: 'project-1',
      resourceType: 'project',
      resourceId: 'project-1',
      environment: 'production',
      traceId: 'trace-project-1',
      ipAddress: '203.0.113.10',
      metadata: {
        name: 'Billing Project',
        success: false,
        source: 'studio',
        traceId: 'trace-project-1',
      },
    });
    appendInMemoryAuditTestEvent({
      auditId: 'audit-project-other-action',
      timestamp: '2026-05-02T11:00:00.000Z',
      source: 'studio',
      eventType: 'project_updated',
      action: 'project_updated',
      actorId: 'actor-admin',
      actorType: 'user',
      tenantId: 'tenant-1',
      projectId: 'project-1',
      resourceType: 'project',
      resourceId: 'project-1',
      environment: 'production',
      traceId: 'trace-project-1',
      ipAddress: '203.0.113.10',
      metadata: { name: 'Billing Project', success: false },
    });
    appendInMemoryAuditTestEvent({
      auditId: 'audit-project-other-resource',
      timestamp: '2026-05-02T12:00:00.000Z',
      source: 'studio',
      eventType: 'project_created',
      action: 'project_created',
      actorId: 'actor-admin',
      actorType: 'user',
      tenantId: 'tenant-1',
      projectId: 'project-2',
      resourceType: 'project',
      resourceId: 'project-2',
      environment: 'production',
      traceId: 'trace-project-1',
      ipAddress: '203.0.113.10',
      metadata: { name: 'Billing Project', success: false },
    });
    appendInMemoryAuditTestEvent({
      auditId: 'audit-workspace-governance',
      timestamp: '2026-05-02T13:00:00.000Z',
      source: 'studio',
      eventType: 'member_joined',
      action: 'member_joined',
      actorId: 'actor-admin',
      actorType: 'user',
      tenantId: 'tenant-1',
      resourceType: 'tenant_member',
      resourceId: 'actor-admin',
      environment: 'production',
      ipAddress: '203.0.113.10',
      metadata: { name: 'Billing Project', success: false },
    });

    const result = await queryStudioAuditLogsFromClickHouse({
      scope: 'workspace',
      personalScopeMode: 'tenant-safe',
      userId: 'requester-admin',
      tenantId: 'tenant-1',
      from: '2026-05-01T00:00:00.000Z',
      to: '2026-05-03T00:00:00.000Z',
      categories: ['project_agent_lifecycle'],
      actions: ['project_created'],
      query: 'billing',
      actor: 'actor-admin',
      actorTypes: ['user'],
      projectId: 'project-1',
      resourceTypes: ['project'],
      resourceId: 'project-1',
      traceId: 'trace-project-1',
      sources: ['studio'],
      environments: ['production'],
      success: 'failure',
      ipAddress: '203.0.113.',
      metadataKey: 'name',
      metadataValue: 'billing',
      limit: 50,
      offset: 0,
    });

    expect(result.total).toBe(1);
    expect(result.logs[0]).toMatchObject({
      id: 'audit-project-target',
      action: 'project_created',
      tenantId: 'tenant-1',
      projectId: 'project-1',
      resourceType: 'project',
      resourceId: 'project-1',
      actor: 'actor-admin',
    });
  });
});

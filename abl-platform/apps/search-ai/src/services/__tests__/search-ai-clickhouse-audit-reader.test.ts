import { beforeEach, describe, expect, it, vi } from 'vitest';
import {
  queryKnowledgeBaseActivityAuditLogsFromClickHouse,
  querySearchAIAuditLogsFromClickHouse,
} from '../search-ai-clickhouse-audit-reader.js';

const { mockClickHouseQuery, mockGetClickHouseClient } = vi.hoisted(() => {
  const mockClickHouseQuery = vi.fn();
  const mockGetClickHouseClient = vi.fn(() => ({
    query: mockClickHouseQuery,
  }));
  return { mockClickHouseQuery, mockGetClickHouseClient };
});

vi.mock('@agent-platform/database/clickhouse', () => ({
  getClickHouseClient: mockGetClickHouseClient,
}));

describe('search-ai-clickhouse-audit-reader', () => {
  beforeEach(() => {
    mockClickHouseQuery.mockReset();
    mockGetClickHouseClient.mockClear();
    delete process.env.AUDIT_PIPELINE_TEST_BACKEND;
  });

  it('queries generic search-ai audit logs through ClickHouseAuditReader', async () => {
    mockClickHouseQuery
      .mockResolvedValueOnce({
        json: async () => [{ cnt: '1' }],
      })
      .mockResolvedValueOnce({
        json: async () => [
          {
            tenant_id: 'tenant-1',
            timestamp: '2026-04-22 12:00:00',
            action: 'custom_domain.create',
            event_id: 'audit-1',
            actor_id: 'user-1',
            actor_type: 'user',
            actor_ip: '1.2.3.4',
            actor_user_agent: 'Mozilla/5.0',
            resource_type: 'custom_domain',
            resource_id: 'domain-1',
            session_id: '',
            project_id: '',
            old_value: '',
            new_value: '',
            metadata: JSON.stringify({
              eventType: 'custom_domain_created',
              environment: 'dev',
            }),
            success: 1,
            failure_reason: '',
          },
        ],
      });

    const logs = await querySearchAIAuditLogsFromClickHouse({
      tenantId: 'tenant-1',
      resourceType: 'custom_domain',
      resourceId: 'domain-1',
      limit: 25,
    });

    expect(logs).toHaveLength(1);
    expect(logs[0]?.id).toBe('audit-1');
    expect(logs[0]?.eventType).toBe('custom_domain_created');
    expect(mockClickHouseQuery).toHaveBeenCalledTimes(2);
  });

  it('queries knowledge base activity with index and source filters', async () => {
    mockClickHouseQuery
      .mockResolvedValueOnce({
        json: async () => [{ cnt: '2' }],
      })
      .mockResolvedValueOnce({
        json: async () => [
          {
            tenant_id: 'tenant-1',
            timestamp: '2026-04-22 12:00:00',
            action: 'search.source.added',
            event_id: 'audit-1',
            actor_id: 'user-1',
            actor_type: 'user',
            actor_ip: '',
            actor_user_agent: '',
            resource_type: 'source',
            resource_id: 'source-1',
            session_id: '',
            project_id: 'project-1',
            old_value: '',
            new_value: '',
            metadata: JSON.stringify({
              eventType: 'search.source.added',
              resourceType: 'source',
              resourceId: 'source-1',
              environment: 'dev',
            }),
            success: 1,
            failure_reason: '',
          },
        ],
      });

    const result = await queryKnowledgeBaseActivityAuditLogsFromClickHouse({
      tenantId: 'tenant-1',
      indexId: 'idx-1',
      sourceIds: ['source-1', 'source-2'],
      limit: 20,
      offset: 0,
    });

    expect(result.total).toBe(2);
    expect(result.logs[0]?.resourceType).toBe('source');
    expect(mockClickHouseQuery).toHaveBeenNthCalledWith(
      1,
      expect.objectContaining({
        query: expect.stringContaining("resource_type = 'index'"),
        query_params: expect.objectContaining({
          tenantId: 'tenant-1',
          indexId: 'idx-1',
          sourceIds: ['source-1', 'source-2'],
        }),
      }),
    );
  });

  it('uses the in-memory audit backend for knowledge base activity when enabled', async () => {
    process.env.AUDIT_PIPELINE_TEST_BACKEND = 'memory';

    const { appendInMemoryAuditTestEvent, resetInMemoryAuditTestBackend } =
      await import('@abl/compiler/platform/stores');
    resetInMemoryAuditTestBackend();
    appendInMemoryAuditTestEvent({
      auditId: 'audit-1',
      stream: 'shared',
      schemaVersion: 2,
      timestamp: new Date('2026-04-22T12:00:00.000Z'),
      source: 'search-ai',
      eventType: 'search.source.added',
      action: 'search.source.added',
      actorId: 'user-1',
      actorType: 'user',
      tenantId: 'tenant-1',
      projectId: 'project-1',
      resourceType: 'source',
      resourceId: 'source-1',
      environment: 'dev',
      traceId: null,
      ipAddress: null,
      userAgent: null,
      metadata: {
        resourceType: 'source',
        resourceId: 'source-1',
      },
      metadataEncoding: 'object',
      retentionClass: 'crud',
      expiresAt: null,
      oldValue: null,
      newValue: null,
    });

    const result = await queryKnowledgeBaseActivityAuditLogsFromClickHouse({
      tenantId: 'tenant-1',
      indexId: 'idx-1',
      sourceIds: ['source-1'],
      limit: 10,
      offset: 0,
    });

    expect(result.total).toBe(1);
    expect(result.logs[0]?.id).toBe('audit-1');
    expect(mockClickHouseQuery).not.toHaveBeenCalled();
  });
});

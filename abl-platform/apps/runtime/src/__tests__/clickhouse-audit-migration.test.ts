import { describe, expect, test, vi } from 'vitest';
import { buildClickHouseAuditCompatSummary } from '../scripts/clickhouse-audit-compat-report.js';
import {
  buildClickHouseAuditBackfillPlan,
  runClickHouseAuditBackfill,
} from '../scripts/clickhouse-audit-backfill-v2.js';

describe('clickhouse-audit-migration', () => {
  test('flags legacy rows that are missing session_id but still carry traceId in metadata', () => {
    const [entry] = buildClickHouseAuditBackfillPlan([
      {
        tenant_id: 'tenant-1',
        timestamp: '2026-04-16 12:00:00',
        action: 'session.created',
        event_id: 'evt-1',
        actor_id: 'user-1',
        actor_type: 'user',
        actor_ip: '',
        actor_user_agent: '',
        resource_type: 'session',
        resource_id: 'sess-1',
        session_id: '',
        project_id: '',
        old_value: '',
        new_value: '',
        metadata: JSON.stringify({
          eventType: 'session.started',
          actorType: 'user',
          tenantId: 'tenant-1',
          projectId: 'project-1',
          resourceType: 'session',
          resourceId: 'sess-1',
          environment: 'production',
          traceId: 'trace-1',
          channel: 'web',
        }),
        success: 1,
        failure_reason: '',
      },
    ]);

    expect(entry.shouldUpdate).toBe(true);
    expect(entry.patch.session_id).toBe('trace-1');
    expect(entry.patch.project_id).toBe('project-1');
    expect(entry.patch.metadata).toBeDefined();
  });

  test('is idempotent for canonical rows that already match the shared contract', () => {
    const metadata = JSON.stringify({
      eventType: 'session.started',
      actorType: 'user',
      tenantId: 'tenant-1',
      projectId: 'project-1',
      resourceType: 'session',
      resourceId: 'sess-1',
      environment: 'production',
      traceId: 'trace-1',
      oldValue: null,
      newValue: null,
      source: 'runtime-store',
      schemaVersion: 2,
      metadataEncoding: 'object',
      retentionClass: 'default',
      expiresAt: null,
      channel: 'web',
    });

    const [entry] = buildClickHouseAuditBackfillPlan([
      {
        tenant_id: 'tenant-1',
        timestamp: '2026-04-16 12:00:00',
        action: 'session.created',
        event_id: 'evt-2',
        actor_id: 'user-1',
        actor_type: 'user',
        actor_ip: '',
        actor_user_agent: '',
        resource_type: 'session',
        resource_id: 'sess-1',
        session_id: 'trace-1',
        project_id: 'project-1',
        old_value: '',
        new_value: '',
        metadata,
        success: 1,
        failure_reason: '',
      },
    ]);

    expect(entry.shouldUpdate).toBe(false);
    expect(entry.patch).toEqual({});
  });

  test('compat report counts backfill candidates and missing trace linkage', () => {
    const summary = buildClickHouseAuditCompatSummary([
      {
        tenant_id: 'tenant-1',
        timestamp: '2026-04-16 12:00:00',
        action: 'session.created',
        event_id: 'evt-legacy',
        actor_id: 'user-1',
        actor_type: 'user',
        actor_ip: '',
        actor_user_agent: '',
        resource_type: 'session',
        resource_id: 'sess-1',
        session_id: '',
        project_id: '',
        old_value: '',
        new_value: '',
        metadata: JSON.stringify({
          eventType: 'session.started',
          actorType: 'user',
          tenantId: 'tenant-1',
          projectId: 'project-1',
          resourceType: 'session',
          resourceId: 'sess-1',
          environment: 'production',
          traceId: 'trace-legacy',
        }),
        success: 1,
        failure_reason: '',
      },
      {
        tenant_id: 'tenant-1',
        timestamp: '2026-04-16 12:05:00',
        action: 'tool.executed',
        event_id: 'evt-canonical',
        actor_id: 'agent-1',
        actor_type: 'agent',
        actor_ip: '',
        actor_user_agent: '',
        resource_type: 'tool',
        resource_id: 'lookup',
        session_id: 'trace-2',
        project_id: '',
        old_value: '',
        new_value: '',
        metadata: JSON.stringify({
          eventType: 'tool.executed',
          actorType: 'agent',
          tenantId: 'tenant-1',
          projectId: null,
          resourceType: 'tool',
          resourceId: 'lookup',
          environment: 'production',
          traceId: 'trace-2',
          oldValue: null,
          newValue: null,
          source: 'runtime-store',
          schemaVersion: 2,
          metadataEncoding: 'object',
          retentionClass: 'default',
          expiresAt: null,
        }),
        success: 1,
        failure_reason: '',
      },
    ]);

    expect(summary.processed).toBe(2);
    expect(summary.backfillCandidates).toBe(1);
    expect(summary.missingTraceSessionLinkRows).toBe(1);
    expect(summary.legacyRows).toBeGreaterThanOrEqual(1);
  });

  test('dry-run backfill reports updates without mutating data', async () => {
    const mockClient = {
      query: vi.fn().mockResolvedValue({
        json: () =>
          Promise.resolve([
            {
              tenant_id: 'tenant-1',
              timestamp: '2026-04-16 12:00:00',
              action: 'session.created',
              event_id: 'evt-1',
              actor_id: 'user-1',
              actor_type: 'user',
              actor_ip: '',
              actor_user_agent: '',
              resource_type: 'session',
              resource_id: 'sess-1',
              session_id: '',
              project_id: '',
              old_value: '',
              new_value: '',
              metadata: JSON.stringify({
                eventType: 'session.started',
                actorType: 'user',
                tenantId: 'tenant-1',
                projectId: 'project-1',
                resourceType: 'session',
                resourceId: 'sess-1',
                environment: 'production',
                traceId: 'trace-1',
              }),
              success: 1,
              failure_reason: '',
            },
          ]),
      }),
      command: vi.fn().mockResolvedValue(undefined),
    };

    const result = await runClickHouseAuditBackfill(
      { tenantId: 'tenant-1', batchSize: 10, dryRun: true },
      mockClient as never,
    );

    expect(result.processed).toBe(1);
    expect(result.updated).toBe(1);
    expect(result.skipped).toBe(0);
    expect(mockClient.command).not.toHaveBeenCalled();
  });

  test('backfill waits for ClickHouse audit update mutations before reporting updates', async () => {
    const mockClient = {
      query: vi.fn().mockResolvedValue({
        json: () =>
          Promise.resolve([
            {
              tenant_id: 'tenant-1',
              timestamp: '2026-04-16 12:00:00',
              action: 'session.created',
              event_id: 'evt-1',
              actor_id: 'user-1',
              actor_type: 'user',
              actor_ip: '',
              actor_user_agent: '',
              resource_type: 'session',
              resource_id: 'sess-1',
              session_id: '',
              project_id: '',
              old_value: '',
              new_value: '',
              metadata: JSON.stringify({
                eventType: 'session.started',
                actorType: 'user',
                tenantId: 'tenant-1',
                projectId: 'project-1',
                resourceType: 'session',
                resourceId: 'sess-1',
                environment: 'production',
                traceId: 'trace-1',
              }),
              success: 1,
              failure_reason: '',
            },
          ]),
      }),
      command: vi.fn().mockResolvedValue(undefined),
    };

    const result = await runClickHouseAuditBackfill(
      { tenantId: 'tenant-1', batchSize: 10, dryRun: false },
      mockClient as never,
    );

    expect(result.updated).toBe(1);
    expect(mockClient.command).toHaveBeenCalledWith(
      expect.objectContaining({
        query: expect.stringContaining('SETTINGS mutations_sync = 1'),
      }),
    );
  });

  test('backfill paginates across multiple batches instead of re-reading the first page', async () => {
    const mockClient = {
      query: vi
        .fn()
        .mockResolvedValueOnce({
          json: () =>
            Promise.resolve([
              {
                tenant_id: 'tenant-1',
                timestamp: '2026-04-16 12:00:00',
                action: 'session.created',
                event_id: 'evt-1',
                actor_id: 'user-1',
                actor_type: 'user',
                actor_ip: '',
                actor_user_agent: '',
                resource_type: 'session',
                resource_id: 'sess-1',
                session_id: '',
                project_id: '',
                old_value: '',
                new_value: '',
                metadata: JSON.stringify({
                  eventType: 'session.started',
                  actorType: 'user',
                  tenantId: 'tenant-1',
                  projectId: 'project-1',
                  resourceType: 'session',
                  resourceId: 'sess-1',
                  environment: 'production',
                  traceId: 'trace-1',
                }),
                success: 1,
                failure_reason: '',
              },
            ]),
        })
        .mockResolvedValueOnce({
          json: () =>
            Promise.resolve([
              {
                tenant_id: 'tenant-1',
                timestamp: '2026-04-16 12:05:00',
                action: 'session.created',
                event_id: 'evt-2',
                actor_id: 'user-2',
                actor_type: 'user',
                actor_ip: '',
                actor_user_agent: '',
                resource_type: 'session',
                resource_id: 'sess-2',
                session_id: '',
                project_id: '',
                old_value: '',
                new_value: '',
                metadata: JSON.stringify({
                  eventType: 'session.started',
                  actorType: 'user',
                  tenantId: 'tenant-1',
                  projectId: 'project-1',
                  resourceType: 'session',
                  resourceId: 'sess-2',
                  environment: 'production',
                  traceId: 'trace-2',
                }),
                success: 1,
                failure_reason: '',
              },
            ]),
        })
        .mockResolvedValueOnce({
          json: () => Promise.resolve([]),
        }),
      command: vi.fn().mockResolvedValue(undefined),
    };

    const result = await runClickHouseAuditBackfill(
      { tenantId: 'tenant-1', batchSize: 1, dryRun: true },
      mockClient as never,
    );

    expect(result.processed).toBe(2);
    expect(result.updated).toBe(2);
    expect(mockClient.query).toHaveBeenCalledTimes(3);

    const secondQuery = mockClient.query.mock.calls[1][0];
    expect(secondQuery.query_params.cursorTimestamp).toBe('2026-04-16 12:00:00');
    expect(secondQuery.query_params.cursorEventId).toBe('evt-1');
  });
});

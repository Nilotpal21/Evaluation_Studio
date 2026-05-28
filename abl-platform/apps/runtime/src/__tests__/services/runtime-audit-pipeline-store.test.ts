import { describe, expect, test, vi } from 'vitest';
import { RuntimeAuditPipelineStore } from '../../services/audit/runtime-audit-pipeline-store.js';

describe('RuntimeAuditPipelineStore', () => {
  test('emits canonical shared audit events for existing AuditStore callers', async () => {
    const emitter = {
      emit: vi.fn(),
      emitBatch: vi.fn(),
      flush: vi.fn(),
      close: vi.fn(async () => {}),
    };
    const reader = {
      query: vi.fn(),
      getSummary: vi.fn(),
      getByTraceId: vi.fn(),
      close: vi.fn(async () => {}),
    };
    const store = new RuntimeAuditPipelineStore(
      { type: 'clickhouse' },
      {
        emitter,
        reader,
      },
    );

    await store.log({
      tenantId: 'tenant-a',
      projectId: 'project-a',
      eventType: 'workflow.updated',
      actor: 'user-1',
      actorType: 'user',
      resourceType: 'workflow_definition',
      resourceId: 'wf-1',
      environment: 'production',
      action: 'workflow.updated',
      metadata: { changedField: 'name' },
      traceId: 'trace-1',
      source: 'runtime-store',
      retentionClass: 'crud',
    });

    expect(emitter.emit).toHaveBeenCalledTimes(1);
    const [event] = emitter.emit.mock.calls[0];
    expect(event).toMatchObject({
      stream: 'shared',
      tenantId: 'tenant-a',
      projectId: 'project-a',
      eventType: 'workflow.updated',
      actorId: 'user-1',
      actorType: 'user',
      resourceType: 'workflow_definition',
      resourceId: 'wf-1',
      action: 'workflow.updated',
      traceId: 'trace-1',
      source: 'runtime-store',
      retentionClass: 'crud',
    });
    expect(event.auditId).toEqual(expect.any(String));
    expect(event.timestamp).toBeInstanceOf(Date);
  });

  test('delegates read APIs and closes both emitter and reader', async () => {
    const queryResult = { logs: [], total: 0 };
    const summaryResult = {
      totalEvents: 0,
      eventsByType: {},
      eventsByActor: {},
      eventsByResource: {},
    };
    const emitter = {
      emit: vi.fn(),
      emitBatch: vi.fn(),
      flush: vi.fn(),
      close: vi.fn(async () => {}),
      getStatus: vi.fn(() => ({
        healthy: true,
        started: true,
        bufferedMessages: 0,
        inFlightProducerDrains: 0,
        inFlightMaterializations: 0,
        publishedMessages: 2,
        materializedMessages: 2,
        failedProducerDrains: 0,
        failedMaterializations: 0,
        lastProducedAt: new Date('2026-04-21T00:00:00.000Z'),
        lastMaterializedAt: new Date('2026-04-21T00:01:00.000Z'),
        lastErrorAt: null,
        lastError: null,
      })),
    };
    const reader = {
      query: vi.fn(async () => queryResult),
      getSummary: vi.fn(async () => summaryResult),
      getByTraceId: vi.fn(async () => []),
      close: vi.fn(async () => {}),
    };
    const store = new RuntimeAuditPipelineStore(
      { type: 'clickhouse' },
      {
        emitter,
        reader,
      },
    );

    await expect(
      store.query({
        tenantId: 'tenant-a',
        startTime: new Date('2026-04-21T00:00:00.000Z'),
        endTime: new Date('2026-04-22T00:00:00.000Z'),
      }),
    ).resolves.toEqual(queryResult);
    await expect(
      store.getSummary(
        'tenant-a',
        'production',
        new Date('2026-04-21T00:00:00.000Z'),
        new Date('2026-04-22T00:00:00.000Z'),
      ),
    ).resolves.toEqual(summaryResult);
    await expect(store.getByTraceId('tenant-a', 'trace-1')).resolves.toEqual([]);
    expect(store.getPipelineStatus()).toMatchObject({
      healthy: true,
      publishedMessages: 2,
      materializedMessages: 2,
    });

    await store.close();

    expect(reader.query).toHaveBeenCalledTimes(1);
    expect(reader.getSummary).toHaveBeenCalledTimes(1);
    expect(reader.getByTraceId).toHaveBeenCalledWith('tenant-a', 'trace-1');
    expect(emitter.getStatus).toHaveBeenCalledTimes(1);
    expect(emitter.close).toHaveBeenCalledTimes(1);
    expect(reader.close).toHaveBeenCalledTimes(1);
  });
});

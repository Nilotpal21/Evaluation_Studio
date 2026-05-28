import { describe, expect, test } from 'vitest';
import { InMemoryAuditStore } from '@abl/compiler/platform/stores/audit-store.js';
import { decodeSharedAuditRecord } from '@abl/compiler/platform/stores/shared-audit-codec.js';

describe('audit contract integration', () => {
  test('preserves append-only history, tenant isolation, actor attribution, and trace lookup', async () => {
    const store = new InMemoryAuditStore({ type: 'memory' });

    await store.log({
      tenantId: 'tenant-a',
      projectId: 'project-a',
      eventType: 'escalation.triggered',
      actor: 'agent-a',
      actorType: 'agent',
      resourceType: 'session',
      resourceId: 'session-1',
      environment: 'production',
      action: 'Escalation triggered',
      traceId: 'trace-1',
      metadata: { reason: 'handoff required' },
    });
    await store.log({
      tenantId: 'tenant-a',
      projectId: 'project-a',
      eventType: 'session.modified',
      actor: 'admin-a',
      actorType: 'admin',
      resourceType: 'session',
      resourceId: 'session-1',
      environment: 'production',
      action: 'Session tagged for review',
      traceId: 'trace-1',
      metadata: { tag: 'review' },
    });
    await store.log({
      tenantId: 'tenant-b',
      projectId: 'project-b',
      eventType: 'escalation.triggered',
      actor: 'agent-b',
      actorType: 'agent',
      resourceType: 'session',
      resourceId: 'session-2',
      environment: 'production',
      action: 'Other tenant escalation',
      traceId: 'trace-2',
    });

    const tenantAResult = await store.query({
      tenantId: 'tenant-a',
      startTime: new Date('2026-01-01T00:00:00.000Z'),
      endTime: new Date('2027-01-01T00:00:00.000Z'),
      limit: 50,
    });

    expect(tenantAResult.total).toBe(2);
    expect(tenantAResult.logs.map((log) => log.tenantId)).toEqual(['tenant-a', 'tenant-a']);
    expect(tenantAResult.logs.some((log) => log.actor === 'admin-a')).toBe(true);
    expect(tenantAResult.logs.some((log) => log.actorType === 'admin')).toBe(true);

    const traceLogs = await store.getByTraceId('tenant-a', 'trace-1');
    expect(traceLogs).toHaveLength(2);
    expect(traceLogs.map((log) => log.action)).toEqual([
      'Escalation triggered',
      'Session tagged for review',
    ]);

    // Append-only behavior: both events for the same session remain queryable.
    expect(traceLogs.map((log) => log.eventType)).toEqual([
      'escalation.triggered',
      'session.modified',
    ]);
  });

  test('compatibility decode still works for legacy shared rows', () => {
    const decoded = decodeSharedAuditRecord({
      _id: 'legacy-1',
      userId: 'user-legacy',
      tenantId: 'tenant-legacy',
      action: 'session.started',
      metadata: JSON.stringify({
        eventType: 'session.started',
        actorType: 'user',
        resourceType: 'session',
        resourceId: 'session-legacy',
        environment: 'production',
        traceId: 'trace-legacy',
        channel: 'voice',
      }),
    });

    expect(decoded.kind).toBe('legacy-string-metadata');
    expect(decoded.envelope).toMatchObject({
      tenantId: 'tenant-legacy',
      actorId: 'user-legacy',
      actorType: 'user',
      resourceType: 'session',
      resourceId: 'session-legacy',
      traceId: 'trace-legacy',
      metadata: { channel: 'voice' },
    });
  });
});

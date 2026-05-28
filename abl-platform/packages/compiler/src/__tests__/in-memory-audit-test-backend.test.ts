import { beforeEach, describe, expect, test } from 'vitest';
import {
  appendInMemoryAuditTestEvent,
  queryInMemoryAuditTestLogs,
  resetInMemoryAuditTestBackend,
  setInMemoryAuditTestWriteFailure,
} from '../platform/stores/in-memory-audit-test-backend.js';

describe('in-memory audit test backend', () => {
  beforeEach(() => {
    resetInMemoryAuditTestBackend();
  });

  test('stores and filters shared audit events', async () => {
    appendInMemoryAuditTestEvent({
      auditId: 'audit-1',
      timestamp: '2026-04-22T10:00:00.000Z',
      eventType: 'login',
      action: 'login',
      actorId: 'user-1',
      actorType: 'user',
      tenantId: 'tenant-1',
      resourceType: 'session',
      resourceId: 'session-1',
      environment: 'dev',
      metadata: { source: 'test' },
    });
    appendInMemoryAuditTestEvent({
      auditId: 'audit-2',
      timestamp: '2026-04-22T11:00:00.000Z',
      eventType: 'workspace_created',
      action: 'workspace_created',
      actorId: 'user-2',
      actorType: 'user',
      tenantId: 'tenant-2',
      resourceType: 'workspace',
      resourceId: 'workspace-1',
      environment: 'staging',
      metadata: { source: 'test' },
    });

    const result = await queryInMemoryAuditTestLogs({
      tenantId: 'tenant-1',
      actor: 'user-1',
      startTime: new Date('2026-04-22T00:00:00.000Z'),
      endTime: new Date('2026-04-23T00:00:00.000Z'),
      limit: 10,
    });

    expect(result.total).toBe(1);
    expect(result.logs[0]).toMatchObject({
      id: 'audit-1',
      tenantId: 'tenant-1',
      actor: 'user-1',
      action: 'login',
      environment: 'dev',
    });
  });

  test('surfaces configured write failures', () => {
    setInMemoryAuditTestWriteFailure('forced audit failure');

    expect(() =>
      appendInMemoryAuditTestEvent({
        auditId: 'audit-failure',
        timestamp: '2026-04-22T10:00:00.000Z',
        eventType: 'login',
        action: 'login',
        actorId: 'user-1',
        actorType: 'user',
        tenantId: 'tenant-1',
        resourceType: 'session',
        resourceId: 'session-1',
        environment: 'dev',
        metadata: {},
      }),
    ).toThrow('forced audit failure');
  });

  test('caps retained logs to the newest in-memory entries', async () => {
    for (let index = 0; index < 10_005; index += 1) {
      appendInMemoryAuditTestEvent({
        auditId: `audit-${index}`,
        timestamp: '2026-04-22T10:00:00.000Z',
        eventType: 'login',
        action: 'login',
        actorId: `user-${index}`,
        actorType: 'user',
        tenantId: 'tenant-1',
        resourceType: 'session',
        resourceId: `session-${index}`,
        environment: 'dev',
        metadata: {},
      });
    }

    const result = await queryInMemoryAuditTestLogs({
      tenantId: 'tenant-1',
      startTime: new Date('2026-04-22T00:00:00.000Z'),
      endTime: new Date('2026-04-23T00:00:00.000Z'),
      limit: 10_010,
    });

    expect(result.total).toBe(10_000);
    expect(result.logs.some((log) => log.id === 'audit-0')).toBe(false);
    expect(result.logs.some((log) => log.id === 'audit-10004')).toBe(true);
  });
});

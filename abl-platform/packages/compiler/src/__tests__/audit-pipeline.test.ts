import { describe, expect, test } from 'vitest';
import {
  createAuditEventFromAuditLog,
  toAuditLogFromAuditEvent,
} from '../platform/stores/audit-pipeline.js';
import type { AuditLog } from '../platform/core/types.js';

describe('audit-pipeline', () => {
  test('creates canonical audit events from audit logs', () => {
    const auditLog: AuditLog = {
      id: 'audit-1',
      tenantId: 'tenant-a',
      projectId: 'project-a',
      timestamp: new Date('2026-04-21T10:00:00.000Z'),
      eventType: 'workflow.updated',
      actor: 'user-1',
      actorType: 'user',
      resourceType: 'workflow_definition',
      resourceId: 'wf-1',
      environment: 'production',
      action: 'workflow.updated',
      metadata: { changedField: 'name' },
      traceId: 'trace-1',
      source: 'studio',
      retentionClass: 'crud',
      expiresAt: null,
    };

    const event = createAuditEventFromAuditLog(auditLog);

    expect(event.auditId).toBe('audit-1');
    expect(event.stream).toBe('shared');
    expect(event.timestamp).toEqual(auditLog.timestamp);
    expect(event.eventType).toBe('workflow.updated');
    expect(event.source).toBe('studio');
    expect(event.retentionClass).toBe('crud');
  });

  test('round-trips audit events back to audit logs', () => {
    const auditLog: AuditLog = {
      id: 'audit-2',
      tenantId: 'tenant-b',
      timestamp: new Date('2026-04-21T11:00:00.000Z'),
      eventType: 'tool.executed',
      actor: 'system',
      actorType: 'system',
      resourceType: 'tool',
      resourceId: 'lookup',
      environment: 'dev',
      action: 'tool:lookup',
      metadata: { success: true },
      source: 'runtime-store',
      retentionClass: 'default',
      expiresAt: null,
    };

    const event = createAuditEventFromAuditLog(auditLog, 'shared');
    const roundTripped = toAuditLogFromAuditEvent(event);

    expect(roundTripped).toMatchObject({
      id: auditLog.id,
      tenantId: auditLog.tenantId,
      eventType: auditLog.eventType,
      actor: auditLog.actor,
      action: auditLog.action,
      source: auditLog.source,
      retentionClass: auditLog.retentionClass,
    });
    expect(roundTripped.timestamp).toEqual(auditLog.timestamp);
  });
});

import { describe, expect, test } from 'vitest';
import type { AuditLog } from '../platform/core/types.js';
import {
  buildSharedAuditBackfillPatch,
  classifySharedAuditRecord,
  createSharedAuditEnvelopeFromAuditLog,
  decodeSharedAuditRecord,
  deriveRetentionClass,
  encodeSharedAuditEnvelopeToMongoDocument,
} from '../platform/stores/shared-audit-codec.js';

describe('shared-audit-codec', () => {
  test('canonical envelope round-trips through Mongo encoding and decoding', () => {
    const auditLog: AuditLog = {
      id: 'audit-1',
      tenantId: 'tenant-1',
      projectId: 'project-1',
      timestamp: new Date('2026-04-16T10:00:00.000Z'),
      eventType: 'session.started',
      actor: 'user-1',
      actorType: 'user',
      resourceType: 'session',
      resourceId: 'sess-1',
      environment: 'production',
      action: 'session.started',
      oldValue: { state: 'new' },
      newValue: { state: 'active' },
      metadata: { channel: 'web' },
      ipAddress: '10.0.0.8',
      traceId: 'trace-1',
    };

    const envelope = createSharedAuditEnvelopeFromAuditLog(auditLog);
    const mongoDoc = encodeSharedAuditEnvelopeToMongoDocument(auditLog.id, envelope);
    const decoded = decodeSharedAuditRecord({
      ...mongoDoc,
      createdAt: auditLog.timestamp,
    });

    expect(decoded.kind).toBe('canonical-v2');
    expect(decoded.envelope).toMatchObject({
      eventType: 'session.started',
      action: 'session.started',
      actorId: 'user-1',
      actorType: 'user',
      tenantId: 'tenant-1',
      projectId: 'project-1',
      resourceType: 'session',
      resourceId: 'sess-1',
      environment: 'production',
      traceId: 'trace-1',
      ipAddress: '10.0.0.8',
      metadata: { channel: 'web' },
      retentionClass: 'default',
    });
    expect(decoded.envelope?.oldValue).toEqual({ state: 'new' });
    expect(decoded.envelope?.newValue).toEqual({ state: 'active' });
  });

  test('canonical compatibility metadata cannot be overridden by custom metadata', () => {
    const auditLog: AuditLog = {
      id: 'audit-canonical-collision',
      tenantId: 'tenant-canonical',
      projectId: 'project-canonical',
      timestamp: new Date('2026-04-16T10:00:00.000Z'),
      eventType: 'prompt.created',
      actor: 'user-canonical',
      actorType: 'user',
      resourceType: 'prompt',
      resourceId: 'prompt-1',
      environment: 'production',
      action: 'prompt.created',
      metadata: {
        eventType: 'forged.event',
        tenantId: 'tenant-forged',
        projectId: 'project-forged',
        resourceType: 'forged-resource',
        customField: 'safe-custom-value',
      },
    };

    const envelope = createSharedAuditEnvelopeFromAuditLog(auditLog);
    const mongoDoc = encodeSharedAuditEnvelopeToMongoDocument(auditLog.id, envelope);

    expect(mongoDoc.metadata).toMatchObject({
      eventType: 'prompt.created',
      tenantId: 'tenant-canonical',
      projectId: 'project-canonical',
      resourceType: 'prompt',
      customField: 'safe-custom-value',
    });
    expect(mongoDoc.metadata).not.toMatchObject({
      eventType: 'forged.event',
      tenantId: 'tenant-forged',
      projectId: 'project-forged',
    });
  });

  test('decodes legacy string metadata rows', () => {
    const decoded = decodeSharedAuditRecord({
      _id: 'legacy-string-1',
      userId: 'user-2',
      tenantId: 'tenant-2',
      action: 'login_success',
      ip: '10.0.0.9',
      metadata: JSON.stringify({
        eventType: 'user.login',
        actorType: 'user',
        projectId: 'project-2',
        resourceType: 'session',
        resourceId: 'sess-2',
        environment: 'production',
        traceId: 'trace-2',
        channel: 'voice',
      }),
    });

    expect(decoded.kind).toBe('legacy-string-metadata');
    expect(decoded.envelope).toMatchObject({
      eventType: 'user.login',
      action: 'login_success',
      actorId: 'user-2',
      actorType: 'user',
      tenantId: 'tenant-2',
      projectId: 'project-2',
      resourceType: 'session',
      resourceId: 'sess-2',
      metadataEncoding: 'json-string',
      metadata: { channel: 'voice' },
      retentionClass: 'auth',
    });
  });

  test('decodes legacy object metadata rows', () => {
    const decoded = decodeSharedAuditRecord({
      _id: 'legacy-object-1',
      userId: 'admin-1',
      action: 'contact.updated',
      metadata: {
        eventType: 'contact.updated',
        actorType: 'admin',
        tenantId: 'tenant-3',
        resourceType: 'contact',
        resourceId: 'contact-1',
        environment: 'dev',
        changedFields: ['email'],
      },
    });

    expect(decoded.kind).toBe('legacy-object-metadata');
    expect(decoded.envelope).toMatchObject({
      eventType: 'contact.updated',
      actorType: 'admin',
      tenantId: 'tenant-3',
      resourceType: 'contact',
      resourceId: 'contact-1',
      metadataEncoding: 'object',
      metadata: { changedFields: ['email'] },
      retentionClass: 'crud',
    });
  });

  test('decodes bare ClickHouse timestamps as UTC', () => {
    const decoded = decodeSharedAuditRecord({
      _id: 'clickhouse-bare-timestamp-1',
      userId: 'user-1',
      tenantId: 'tenant-1',
      action: 'login',
      metadata: {
        eventType: 'login',
        actorType: 'user',
        resourceType: 'agent',
      },
      createdAt: '2026-05-10 16:25:05',
    });

    expect(decoded.envelope?.timestamp?.toISOString()).toBe('2026-05-10T16:25:05.000Z');
  });

  test('classifies mongoose plugin rows separately and does not require shared fields', () => {
    const record = {
      _id: 'plugin-1',
      collectionName: 'projects',
      documentId: 'project-1',
      operation: 'update',
      changes: { name: 'New Name' },
      previousValues: { name: 'Old Name' },
    };

    expect(classifySharedAuditRecord(record)).toBe('mongoose-plugin');

    const decoded = decodeSharedAuditRecord(record);
    expect(decoded.kind).toBe('mongoose-plugin');
    expect(decoded.envelope).toMatchObject({
      source: 'mongoose-plugin',
      resourceType: 'projects',
      resourceId: 'project-1',
      eventType: 'mongoose.update',
      action: 'update',
    });

    const patch = buildSharedAuditBackfillPatch(record);
    expect(patch.patch).toEqual({});
  });

  test('defaults retention class to default when no auth or crud signal exists', () => {
    expect(
      deriveRetentionClass({
        source: 'runtime-store',
        eventType: 'trace.queried',
        action: 'trace.queried',
        explicitRetentionClass: null,
      }),
    ).toBe('default');
  });
});

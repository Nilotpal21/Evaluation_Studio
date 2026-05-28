import { describe, expect, test, vi } from 'vitest';
import {
  AuditLog,
  createAuditLogSchema,
  ensureAuditLogTTLIndex,
  isAuditLogTTLIndexEnabled,
} from '../models/audit-log.model.js';

function findIndexByKey(schema: ReturnType<typeof createAuditLogSchema>, key: string) {
  return schema.indexes().find(([spec]) => Object.keys(spec).join(',') === key);
}

describe('AuditLog model', () => {
  test('includes canonical shared audit fields on the schema', () => {
    const paths = AuditLog.schema.paths;

    expect(paths.eventType).toBeTruthy();
    expect(paths.actorType).toBeTruthy();
    expect(paths.projectId).toBeTruthy();
    expect(paths.resourceType).toBeTruthy();
    expect(paths.resourceId).toBeTruthy();
    expect(paths.environment).toBeTruthy();
    expect(paths.traceId).toBeTruthy();
    expect(paths.source).toBeTruthy();
    expect(paths.schemaVersion).toBeTruthy();
    expect(paths.metadataEncoding).toBeTruthy();
    expect(paths.retentionClass).toBeTruthy();
    expect(paths.expiresAt).toBeTruthy();
  });

  test('preserves legacy indexes while adding canonical indexes', () => {
    const schema = createAuditLogSchema({ enableTtlIndex: false });
    const indexes = schema.indexes();
    const indexKeys = indexes.map(([spec]) => Object.keys(spec).join(','));

    expect(indexKeys).toContain('tenantId,createdAt');
    expect(indexKeys).toContain('userId');
    expect(indexKeys).toContain('action');
    expect(indexKeys).toContain('createdAt');
    expect(indexKeys).toContain('tenantId,action,createdAt');
    expect(indexKeys).toContain('tenantId,metadata.resourceType,metadata.resourceId');

    expect(indexKeys).toContain('tenantId,eventType,createdAt');
    expect(indexKeys).toContain('tenantId,resourceType,resourceId,createdAt');
    expect(indexKeys).toContain('tenantId,projectId,createdAt');
    expect(indexKeys).toContain('traceId,createdAt');
    expect(indexKeys).toContain('schemaVersion,source,createdAt');
  });

  test('does not include the expiresAt TTL index unless explicitly enabled', () => {
    const schema = createAuditLogSchema({ enableTtlIndex: false });
    const ttlIndex = findIndexByKey(schema, 'expiresAt');

    expect(ttlIndex).toBeFalsy();
  });

  test('defines a sparse TTL index on expiresAt when explicitly enabled', () => {
    const schema = createAuditLogSchema({ enableTtlIndex: true });
    const ttlIndex = findIndexByKey(schema, 'expiresAt');

    expect(ttlIndex).toBeTruthy();
    expect(ttlIndex?.[1]).toMatchObject({
      expireAfterSeconds: 0,
      sparse: true,
    });
  });

  test('uses safe TTL index env defaults', () => {
    expect(isAuditLogTTLIndexEnabled({})).toBe(false);
    expect(isAuditLogTTLIndexEnabled({ AUDIT_LOG_TTL_INDEX_ENABLED: 'true' })).toBe(true);
    expect(isAuditLogTTLIndexEnabled({ AUDIT_LOG_TTL_INDEX_ENABLED: 'false' })).toBe(false);
    expect(isAuditLogTTLIndexEnabled({ AUDIT_LOG_TTL_INDEX_ENABLED: 'not-a-bool' })).toBe(false);
  });

  test('explicitly ensures the TTL index when enabled', async () => {
    const createIndex = vi.fn().mockResolvedValue('expiresAt_1');

    await expect(
      ensureAuditLogTTLIndex({ AUDIT_LOG_TTL_INDEX_ENABLED: 'true' }, { createIndex }),
    ).resolves.toBe(true);

    expect(createIndex).toHaveBeenCalledWith(
      { expiresAt: 1 },
      expect.objectContaining({
        name: 'expiresAt_1',
        expireAfterSeconds: 0,
        sparse: true,
      }),
    );
  });

  test('skips explicit TTL index creation when disabled', async () => {
    const createIndex = vi.fn();

    await expect(
      ensureAuditLogTTLIndex({ AUDIT_LOG_TTL_INDEX_ENABLED: 'false' }, { createIndex }),
    ).resolves.toBe(false);

    expect(createIndex).not.toHaveBeenCalled();
  });

  test('defaults shared retention fields to a non-expiring default contract', () => {
    const schema = createAuditLogSchema({ enableTtlIndex: false });
    const retentionClassPath = schema.path('retentionClass');
    const expiresAtPath = schema.path('expiresAt');

    expect(retentionClassPath.options.default).toBe('default');
    expect(expiresAtPath.options.default).toBeNull();
  });
});

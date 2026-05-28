import { describe, expect, it } from 'vitest';
import {
  DEFAULT_PII_TOKEN_VAULT_RETENTION_DAYS,
  PII_TOKEN_SOURCE_SURFACES,
  PIITokenVault,
  type PIITokenSourceSurface,
} from '../models/pii-token-vault.model.js';

describe('PIITokenVault', () => {
  const validEntry = () => ({
    tenantId: 'tenant-1',
    projectId: 'proj-1',
    sessionId: 'session-1',
    tokenId: 'token-1',
    token: '{{PII:email:token-1}}',
    piiType: 'email',
    patternName: 'email',
    encryptedOriginalValue: 'user@example.com',
  });

  it('sets defaults on instantiation', () => {
    const entry = new PIITokenVault(validEntry());

    expect(entry._id).toBeDefined();
    expect(entry.tenantId).toBe('tenant-1');
    expect(entry.projectId).toBe('proj-1');
    expect(entry.sessionId).toBe('session-1');
    expect(entry.tokenId).toBe('token-1');
    expect(entry.token).toBe('{{PII:email:token-1}}');
    expect(entry.piiType).toBe('email');
    expect(entry.patternName).toBe('email');
    expect(entry.encryptedOriginalValue).toBe('user@example.com');
    expect(entry.sourceSurface).toBe('unknown');
    expect(entry.revealable).toBe(true);
    expect(entry.erasedAt).toBeNull();
    expect(entry.erasureReason).toBeNull();
    expect(entry.expireAt).toBeInstanceOf(Date);
    expect(entry._v).toBe(1);
  });

  it('sets expireAt default to retention window', () => {
    const before = Date.now();
    const entry = new PIITokenVault(validEntry());
    const after = Date.now();
    const retentionMs = DEFAULT_PII_TOKEN_VAULT_RETENTION_DAYS * 24 * 60 * 60 * 1000;

    expect(entry.expireAt.getTime()).toBeGreaterThanOrEqual(before + retentionMs - 1000);
    expect(entry.expireAt.getTime()).toBeLessThanOrEqual(after + retentionMs + 1000);
  });

  it('requires all identity and encrypted value fields', () => {
    for (const field of [
      'tenantId',
      'projectId',
      'sessionId',
      'tokenId',
      'token',
      'piiType',
      'patternName',
      'encryptedOriginalValue',
    ]) {
      const data = validEntry() as Record<string, unknown>;
      delete data[field];

      const err = new PIITokenVault(data).validateSync();
      expect(err?.errors[field], field).toBeDefined();
    }
  });

  it('accepts valid source surfaces and rejects invalid values', () => {
    for (const sourceSurface of PII_TOKEN_SOURCE_SURFACES as readonly PIITokenSourceSurface[]) {
      const entry = new PIITokenVault({ ...validEntry(), sourceSurface });
      expect(entry.validateSync()).toBeUndefined();
    }

    const err = new PIITokenVault({
      ...validEntry(),
      sourceSurface: 'invalid',
    }).validateSync();
    expect(err?.errors.sourceSurface).toBeDefined();
  });

  it('defines encryption plugin metadata for original values', () => {
    expect(PIITokenVault.schema.path('encryptedOriginalValue')).toBeDefined();
    expect(PIITokenVault.schema.path('ire')).toBeDefined();
    expect(PIITokenVault.schema.path('cek')).toBeDefined();
    expect(PIITokenVault.schema.path('fieldsToEncrypt')).toBeDefined();
  });

  it('has tenant, project, session, uniqueness, and TTL indexes', () => {
    const indexes = PIITokenVault.schema.indexes();
    const indexKeys = indexes.map((idx: any) => JSON.stringify(idx[0]));

    expect(indexKeys).toContain(
      JSON.stringify({ tenantId: 1, projectId: 1, sessionId: 1, tokenId: 1 }),
    );
    expect(indexKeys).toContain(JSON.stringify({ tenantId: 1, projectId: 1, sessionId: 1 }));
    expect(indexKeys).toContain(
      JSON.stringify({ tenantId: 1, projectId: 1, sessionId: 1, revealable: 1 }),
    );
    expect(indexKeys).toContain(
      JSON.stringify({ tenantId: 1, projectId: 1, piiType: 1, createdAt: -1 }),
    );

    const uniqueIndex = indexes.find(
      (idx: any) =>
        JSON.stringify(idx[0]) ===
        JSON.stringify({ tenantId: 1, projectId: 1, sessionId: 1, tokenId: 1 }),
    );
    expect(uniqueIndex?.[1]).toMatchObject({ unique: true });

    const ttlIndex = indexes.find(
      (idx: any) => JSON.stringify(idx[0]) === JSON.stringify({ expireAt: 1 }),
    );
    expect(ttlIndex?.[1]).toMatchObject({ expireAfterSeconds: 0 });
  });

  it('uses the pii_token_vault collection', () => {
    expect((PIITokenVault.schema as any).options.collection).toBe('pii_token_vault');
  });
});

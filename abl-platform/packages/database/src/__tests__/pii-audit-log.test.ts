import { describe, it, test, expect } from 'vitest';
import { PIIAuditLog } from '../models/pii-audit-log.model.js';

// ─── PIIAuditLog Model ───────────────────────────────────────────────────────

describe('PIIAuditLog', () => {
  const validEntry = () => ({
    tenantId: 'tenant-1',
    projectId: 'proj-1',
    sessionId: 'session-1',
    tokenId: 'token-1',
    piiType: 'email',
    consumer: 'llm',
    action: 'tokenize',
  });

  it('sets default fields on instantiation', () => {
    const entry = new PIIAuditLog(validEntry());
    expect(entry._id).toBeDefined();
    expect(entry.tenantId).toBe('tenant-1');
    expect(entry.projectId).toBe('proj-1');
    expect(entry.sessionId).toBe('session-1');
    expect(entry.tokenId).toBe('token-1');
    expect(entry.piiType).toBe('email');
    expect(entry.consumer).toBe('llm');
    expect(entry.action).toBe('tokenize');
    expect(entry.metadata).toBeNull();
    expect(entry.expireAt).toBeInstanceOf(Date);
    expect(entry._v).toBe(1);
  });

  it('sets expireAt default to ~90 days from now', () => {
    const before = Date.now();
    const entry = new PIIAuditLog(validEntry());
    const after = Date.now();
    const ninetyDaysMs = 90 * 24 * 60 * 60 * 1000;
    expect(entry.expireAt.getTime()).toBeGreaterThanOrEqual(before + ninetyDaysMs - 1000);
    expect(entry.expireAt.getTime()).toBeLessThanOrEqual(after + ninetyDaysMs + 1000);
  });

  it('allows custom expireAt', () => {
    const customDate = new Date('2027-01-01T00:00:00Z');
    const entry = new PIIAuditLog({ ...validEntry(), expireAt: customDate });
    expect(entry.expireAt).toEqual(customDate);
  });

  it('requires tenantId', () => {
    const data = validEntry();
    delete (data as any).tenantId;
    const err = new PIIAuditLog(data).validateSync();
    expect(err).toBeDefined();
    expect(err!.errors.tenantId).toBeDefined();
  });

  it('requires projectId', () => {
    const data = validEntry();
    delete (data as any).projectId;
    const err = new PIIAuditLog(data).validateSync();
    expect(err).toBeDefined();
    expect(err!.errors.projectId).toBeDefined();
  });

  it('requires sessionId', () => {
    const data = validEntry();
    delete (data as any).sessionId;
    const err = new PIIAuditLog(data).validateSync();
    expect(err).toBeDefined();
    expect(err!.errors.sessionId).toBeDefined();
  });

  it('requires tokenId', () => {
    const data = validEntry();
    delete (data as any).tokenId;
    const err = new PIIAuditLog(data).validateSync();
    expect(err).toBeDefined();
    expect(err!.errors.tokenId).toBeDefined();
  });

  it('requires piiType', () => {
    const data = validEntry();
    delete (data as any).piiType;
    const err = new PIIAuditLog(data).validateSync();
    expect(err).toBeDefined();
    expect(err!.errors.piiType).toBeDefined();
  });

  it('requires consumer', () => {
    const data = validEntry();
    delete (data as any).consumer;
    const err = new PIIAuditLog(data).validateSync();
    expect(err).toBeDefined();
    expect(err!.errors.consumer).toBeDefined();
  });

  it('requires action', () => {
    const data = validEntry();
    delete (data as any).action;
    const err = new PIIAuditLog(data).validateSync();
    expect(err).toBeDefined();
    expect(err!.errors.action).toBeDefined();
  });

  it('validates consumer enum', () => {
    const err = new PIIAuditLog({ ...validEntry(), consumer: 'invalid' }).validateSync();
    expect(err).toBeDefined();
    expect(err!.errors.consumer).toBeDefined();
  });

  it('accepts valid consumer values', () => {
    const consumers = ['llm', 'user', 'logs', 'tools', 'admin', 'system'];
    for (const consumer of consumers) {
      const entry = new PIIAuditLog({ ...validEntry(), consumer });
      const err = entry.validateSync();
      expect(err).toBeUndefined();
      expect(entry.consumer).toBe(consumer);
    }
  });

  it('validates action enum', () => {
    const err = new PIIAuditLog({ ...validEntry(), action: 'invalid' }).validateSync();
    expect(err).toBeDefined();
    expect(err!.errors.action).toBeDefined();
  });

  it('accepts valid action values', () => {
    const actions = ['tokenize', 'detokenize', 'render', 'clear'];
    for (const action of actions) {
      const entry = new PIIAuditLog({ ...validEntry(), action });
      const err = entry.validateSync();
      expect(err).toBeUndefined();
      expect(entry.action).toBe(action);
    }
  });

  it('accepts optional metadata', () => {
    const entry = new PIIAuditLog({
      ...validEntry(),
      metadata: { toolName: 'stripe', reason: 'payment' },
    });
    expect(entry.metadata).toEqual({ toolName: 'stripe', reason: 'payment' });
  });

  it('has correct indexes defined on schema', () => {
    const schema = PIIAuditLog.schema;
    const indexes = schema.indexes();
    // Compound indexes (not including individual field indexes)
    const indexKeys = indexes.map((idx: any) => JSON.stringify(idx[0]));
    expect(indexKeys).toContain(JSON.stringify({ tenantId: 1, sessionId: 1 }));
    expect(indexKeys).toContain(JSON.stringify({ tenantId: 1, projectId: 1 }));
    expect(indexKeys).toContain(JSON.stringify({ tenantId: 1, createdAt: -1 }));
    expect(indexKeys).toContain(JSON.stringify({ tenantId: 1, piiType: 1, createdAt: -1 }));
  });

  it('schema collection name is pii_audit_logs', () => {
    const collectionName = (PIIAuditLog.schema as any).options.collection;
    expect(collectionName).toBe('pii_audit_logs');
  });
});

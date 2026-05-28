/**
 * MongoMessageStore scrub methods tests
 *
 * Tests scrubMessages() and scrubMessagesBySession() for GDPR right-to-erasure.
 * Uses mongodb-memory-server for in-memory integration tests.
 */

import { describe, test, expect, beforeAll, afterAll, afterEach, vi } from 'vitest';
import { initDEKFacade } from '@agent-platform/database/kms';
import { setupTestMongo, teardownTestMongo, clearCollections } from './helpers/setup-mongo.js';
import { MongoMessageStore } from '../services/stores/mongo-message-store.js';
import { Message as MessageModel } from '@agent-platform/database/models';
import { setMasterKey } from '@agent-platform/database/mongo';

// Stub tenant-config to avoid Redis/DB dependencies
vi.mock('../services/tenant-config.js', () => ({
  getTenantConfigService: () => ({
    getConfigAsync: async () => ({ limits: { messageRetentionDays: 90 } }),
    resolveProjectMessageRetention: async () => null,
  }),
  PLAN_LIMITS: { FREE: { messageRetentionDays: 30 }, TEAM: { messageRetentionDays: 90 } },
}));

const TENANT_A = 'tenant-a';
const TENANT_B = 'tenant-b';
const CONTACT_1 = 'contact-1';
const SESSION_1 = 'session-1';
const SESSION_2 = 'session-2';
const PROJECT_1 = 'project-1';

/** Helper to insert a message directly via the model (bypasses session lookup) */
async function insertMessage(overrides: Partial<Record<string, unknown>> = {}) {
  return MessageModel.create({
    sessionId: SESSION_1,
    tenantId: TENANT_A,
    projectId: PROJECT_1,
    contactId: CONTACT_1,
    role: 'user',
    content: 'Hello, world!',
    channel: 'web',
    timestamp: new Date(),
    ...overrides,
  });
}

describe('MongoMessageStore scrub methods', () => {
  let store: MongoMessageStore;

  beforeAll(async () => {
    // Encryption plugin requires a master key for Message model's pre('save') hook
    setMasterKey('a'.repeat(64));
    await setupTestMongo();
    await initDEKFacade({ masterKeyHex: 'a'.repeat(64) });
    store = new MongoMessageStore({ type: 'mongodb' });
  });

  afterEach(async () => {
    await clearCollections();
  });

  afterAll(async () => {
    await teardownTestMongo();
  });

  // ── scrubMessages (by contactId) ──────────────────────────────────────

  test('scrubMessages redacts all messages for a contact', { timeout: 30000 }, async () => {
    await insertMessage({ content: 'Message 1', metadata: { foo: 'bar' } });
    await insertMessage({ content: 'Message 2', metadata: { pii: 'sensitive' } });
    await insertMessage({ content: 'Message 3' });

    const count = await store.scrubMessages(TENANT_A, CONTACT_1);
    expect(count).toBe(3);

    const docs = await MessageModel.find({ tenantId: TENANT_A, contactId: CONTACT_1 }).lean();
    for (const doc of docs) {
      expect(doc.content).toBe('[REDACTED]');
      expect(doc.metadata).toEqual({});
      expect(doc.scrubbed).toBe(true);
      expect(doc.scrubbedAt).toBeInstanceOf(Date);
    }
  });

  test('scrubMessages is idempotent — already-scrubbed messages not re-scrubbed', async () => {
    await insertMessage({ content: 'Will be scrubbed' });
    await insertMessage({
      content: '[REDACTED]',
      scrubbed: true,
      scrubbedAt: new Date('2025-01-01'),
    });

    const count = await store.scrubMessages(TENANT_A, CONTACT_1);
    expect(count).toBe(1);

    // Verify the already-scrubbed message kept its original scrubbedAt
    const alreadyScrubbed = await MessageModel.findOne({
      tenantId: TENANT_A,
      contactId: CONTACT_1,
      scrubbedAt: new Date('2025-01-01'),
    }).lean();
    expect(alreadyScrubbed).toBeTruthy();
  });

  test('scrubMessages does not affect other tenants', async () => {
    await insertMessage({ tenantId: TENANT_A, content: 'Tenant A msg' });
    await insertMessage({ tenantId: TENANT_B, content: 'Tenant B msg' });

    const count = await store.scrubMessages(TENANT_A, CONTACT_1);
    expect(count).toBe(1);

    // Tenant B message untouched
    const tenantBDoc = await MessageModel.findOne({ tenantId: TENANT_B }).lean();
    expect(tenantBDoc!.content).toBe('Tenant B msg');
    expect(tenantBDoc!.scrubbed).toBe(false);
  });

  // ── scrubMessagesBySession ────────────────────────────────────────────

  test('scrubMessagesBySession only affects target sessionId', async () => {
    await insertMessage({ sessionId: SESSION_1, content: 'Session 1 msg' });
    await insertMessage({ sessionId: SESSION_2, content: 'Session 2 msg' });

    const count = await store.scrubMessagesBySession(TENANT_A, SESSION_1);
    expect(count).toBe(1);

    // Session 1 scrubbed
    const s1Doc = await MessageModel.findOne({ sessionId: SESSION_1 }).lean();
    expect(s1Doc!.content).toBe('[REDACTED]');
    expect(s1Doc!.scrubbed).toBe(true);
    expect(s1Doc!.scrubbedAt).toBeInstanceOf(Date);

    // Session 2 untouched
    const s2Doc = await MessageModel.findOne({ sessionId: SESSION_2 }).lean();
    expect(s2Doc!.content).toBe('Session 2 msg');
    expect(s2Doc!.scrubbed).toBe(false);
  });

  test('scrubMessagesBySession is idempotent', async () => {
    await insertMessage({ sessionId: SESSION_1, content: 'Msg A' });
    await insertMessage({ sessionId: SESSION_1, content: 'Msg B' });

    const first = await store.scrubMessagesBySession(TENANT_A, SESSION_1);
    expect(first).toBe(2);

    const second = await store.scrubMessagesBySession(TENANT_A, SESSION_1);
    expect(second).toBe(0);
  });

  test('scrubMessagesBySession does not affect other tenants', async () => {
    await insertMessage({ tenantId: TENANT_A, sessionId: SESSION_1, content: 'Tenant A' });
    await insertMessage({ tenantId: TENANT_B, sessionId: SESSION_1, content: 'Tenant B' });

    const count = await store.scrubMessagesBySession(TENANT_A, SESSION_1);
    expect(count).toBe(1);

    const tenantBDoc = await MessageModel.findOne({
      tenantId: TENANT_B,
      sessionId: SESSION_1,
    }).lean();
    expect(tenantBDoc!.content).toBe('Tenant B');
    expect(tenantBDoc!.scrubbed).toBe(false);
  });
});

/**
 * Omnichannel Identity Linking — Integration Tests
 *
 * Tests the verification → consent → recall flow:
 * - Contact verification creates identity record
 * - Consent granting enables recall
 * - Recall returns messages only when both verification and consent are satisfied
 * - Consent revocation blocks future recall
 *
 * Uses MongoMemoryServer for real MongoDB queries.
 * Does NOT mock the services under test — only external dependencies.
 */

import { afterAll, beforeAll, beforeEach, describe, expect, test } from 'vitest';
import { MongoMemoryServer } from 'mongodb-memory-server';
import { initDEKFacade } from '@agent-platform/database/kms';
import { MongoConnectionManager } from '@agent-platform/database/mongo';
import { initMongoBackend, disconnectDatabase } from '../../db/index.js';
import { RecallService } from '../../services/omnichannel/recall-service.js';

const TEST_MASTER_KEY = '2'.repeat(64);
const MONGOMS_VERSION = process.env.MONGOMS_VERSION || '7.0.20';

let mongod: MongoMemoryServer;

const TENANT_ID = 'tenant-identity-integ';
const PROJECT_ID = 'project-identity-integ';
const CONTACT_ID = 'contact-identity-001';
const SESSION_ID = 'session-identity-current';
const PREV_SESSION_ID = 'session-identity-prev';

async function getModels() {
  const models = await import('@agent-platform/database/models');
  return models;
}

describe('Omnichannel identity linking integration', () => {
  beforeAll(async () => {
    mongod = await MongoMemoryServer.create({
      binary: { version: MONGOMS_VERSION },
      instance: { launchTimeout: 30_000 },
    });

    const mongoUri = mongod.getUri();
    process.env.DATABASE_URL = mongoUri;
    process.env.ENCRYPTION_MASTER_KEY = TEST_MASTER_KEY;
    process.env.REDIS_ENABLED = 'false';

    await MongoConnectionManager.reset();
    await initMongoBackend({
      enabled: true,
      url: mongoUri,
      database: 'abl_platform_identity_test',
      minPoolSize: 1,
      maxPoolSize: 5,
      maxIdleTimeMs: 10_000,
      connectTimeoutMs: 10_000,
      socketTimeoutMs: 10_000,
      serverSelectionTimeoutMs: 10_000,
      heartbeatFrequencyMs: 10_000,
      tls: false,
      tlsAllowInvalidCertificates: false,
      authSource: 'admin',
      writeConcern: '1',
      readPreference: 'primary',
      retryWrites: true,
      retryReads: true,
      directConnection: true,
      autoIndex: true,
      slowQueryThresholdMs: 250,
      appName: 'identity-linking-integration-test',
    });

    const { setMasterKey } = await getModels();
    setMasterKey(TEST_MASTER_KEY);
    await initDEKFacade({ masterKeyHex: TEST_MASTER_KEY });
  }, 60_000);

  beforeEach(async () => {
    const { Contact, Message, ContactCapabilityConsent } = await getModels();
    await Contact.deleteMany({});
    await Message.deleteMany({});
    await ContactCapabilityConsent.deleteMany({});
  });

  afterAll(async () => {
    await disconnectDatabase();
    await MongoConnectionManager.reset();
    await mongod.stop();
  }, 30_000);

  // ─── Helpers ──────────────────────────────────────────────────────────────

  async function seedContact(contactId: string) {
    const { Contact } = await getModels();
    await Contact.create({
      _id: contactId,
      tenantId: TENANT_ID,
      type: 'customer',
      identityType: 'email',
      identity: `${contactId}@example.com`,
      identities: [],
      tags: [],
      firstSeenAt: new Date(),
      lastSeenAt: new Date(),
      deletedAt: null,
      contactContext: { preferences: {}, custom: {} },
    });
  }

  async function seedMessage(sessionId: string, contactId: string, content: string) {
    const { Message } = await getModels();
    await Message.create({
      tenantId: TENANT_ID,
      projectId: PROJECT_ID,
      sessionId,
      contactId,
      role: 'user',
      content,
      channel: 'web',
      final: true,
      createdAt: new Date(),
      timestamp: new Date(),
    });
  }

  async function grantConsent(contactId: string) {
    const { ContactCapabilityConsent } = await getModels();
    await ContactCapabilityConsent.create({
      tenantId: TENANT_ID,
      projectId: PROJECT_ID,
      contactId,
      capability: 'cross_channel_recall',
      state: 'granted',
      grantedBy: 'test-system',
      grantedAt: new Date(),
    });
  }

  async function revokeConsent(contactId: string) {
    const { ContactCapabilityConsent } = await getModels();
    await ContactCapabilityConsent.updateOne(
      {
        tenantId: TENANT_ID,
        projectId: PROJECT_ID,
        contactId,
        capability: 'cross_channel_recall',
      },
      { $set: { state: 'revoked', revokedAt: new Date() } },
    );
  }

  // ─── Tests ────────────────────────────────────────────────────────────────

  test('recall returns empty without consent even with messages', async () => {
    await seedContact(CONTACT_ID);
    await seedMessage(PREV_SESSION_ID, CONTACT_ID, 'previous message');

    const svc = new RecallService(TENANT_ID, PROJECT_ID);
    const result = await svc.getRecallMessages({
      sessionId: SESSION_ID,
      tenantId: TENANT_ID,
      projectId: PROJECT_ID,
      contactId: CONTACT_ID,
    });

    expect(result.messages).toHaveLength(0);
  });

  test('recall returns messages after consent is granted', async () => {
    await seedContact(CONTACT_ID);
    await seedMessage(PREV_SESSION_ID, CONTACT_ID, 'previous message');
    await grantConsent(CONTACT_ID);

    const svc = new RecallService(TENANT_ID, PROJECT_ID);
    const result = await svc.getRecallMessages({
      sessionId: SESSION_ID,
      tenantId: TENANT_ID,
      projectId: PROJECT_ID,
      contactId: CONTACT_ID,
    });

    expect(result.messages.length).toBeGreaterThan(0);
  });

  test('recall returns empty after consent is revoked', async () => {
    await seedContact(CONTACT_ID);
    await seedMessage(PREV_SESSION_ID, CONTACT_ID, 'previous message');
    await grantConsent(CONTACT_ID);

    // Verify recall works with consent
    const svc = new RecallService(TENANT_ID, PROJECT_ID);
    const resultBefore = await svc.getRecallMessages({
      sessionId: SESSION_ID,
      tenantId: TENANT_ID,
      projectId: PROJECT_ID,
      contactId: CONTACT_ID,
    });
    expect(resultBefore.messages.length).toBeGreaterThan(0);

    // Revoke consent
    await revokeConsent(CONTACT_ID);

    // Verify recall now returns empty
    const resultAfter = await svc.getRecallMessages({
      sessionId: SESSION_ID,
      tenantId: TENANT_ID,
      projectId: PROJECT_ID,
      contactId: CONTACT_ID,
    });
    expect(resultAfter.messages).toHaveLength(0);
  });

  test('cross-tenant isolation — recall never crosses tenant boundaries', async () => {
    const OTHER_TENANT = 'tenant-identity-other';
    await seedContact(CONTACT_ID);
    await grantConsent(CONTACT_ID);
    await seedMessage(PREV_SESSION_ID, CONTACT_ID, 'tenant A message');

    // Recall from a different tenant should return nothing
    const svc = new RecallService(OTHER_TENANT, PROJECT_ID);
    const result = await svc.getRecallMessages({
      sessionId: SESSION_ID,
      tenantId: OTHER_TENANT,
      projectId: PROJECT_ID,
      contactId: CONTACT_ID,
    });

    expect(result.messages).toHaveLength(0);
  });

  test('consent is scoped to project — different project consent not honored', async () => {
    const OTHER_PROJECT = 'project-identity-other';
    await seedContact(CONTACT_ID);
    await seedMessage(PREV_SESSION_ID, CONTACT_ID, 'project A message');

    // Grant consent in a different project
    const { ContactCapabilityConsent } = await getModels();
    await ContactCapabilityConsent.create({
      tenantId: TENANT_ID,
      projectId: OTHER_PROJECT,
      contactId: CONTACT_ID,
      capability: 'cross_channel_recall',
      state: 'granted',
      grantedBy: 'test-system',
      grantedAt: new Date(),
    });

    // Recall in the test project should still return empty
    const svc = new RecallService(TENANT_ID, PROJECT_ID);
    const result = await svc.getRecallMessages({
      sessionId: SESSION_ID,
      tenantId: TENANT_ID,
      projectId: PROJECT_ID,
      contactId: CONTACT_ID,
    });

    expect(result.messages).toHaveLength(0);
  });

  test('full flow: contact creation → consent → recall → revoke → empty', async () => {
    // Step 1: Create contact
    await seedContact(CONTACT_ID);
    await seedMessage(PREV_SESSION_ID, CONTACT_ID, 'step-1 message');

    const svc = new RecallService(TENANT_ID, PROJECT_ID);

    // Step 2: No consent yet — empty
    const r1 = await svc.getRecallMessages({
      sessionId: SESSION_ID,
      tenantId: TENANT_ID,
      projectId: PROJECT_ID,
      contactId: CONTACT_ID,
    });
    expect(r1.messages).toHaveLength(0);

    // Step 3: Grant consent — recall works
    await grantConsent(CONTACT_ID);
    const r2 = await svc.getRecallMessages({
      sessionId: SESSION_ID,
      tenantId: TENANT_ID,
      projectId: PROJECT_ID,
      contactId: CONTACT_ID,
    });
    expect(r2.messages.length).toBeGreaterThan(0);

    // Step 4: Revoke consent — empty again
    await revokeConsent(CONTACT_ID);
    const r3 = await svc.getRecallMessages({
      sessionId: SESSION_ID,
      tenantId: TENANT_ID,
      projectId: PROJECT_ID,
      contactId: CONTACT_ID,
    });
    expect(r3.messages).toHaveLength(0);
  });
});

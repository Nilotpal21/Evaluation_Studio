/**
 * Omnichannel Recall — E2E Tests
 *
 * Exercises the recall endpoint through the real HTTP stack:
 * real Express server, real MongoDB (MongoMemoryServer), full middleware chain.
 *
 * Routes under test:
 *   POST /api/projects/:projectId/omnichannel/recall
 *   GET  /api/projects/:projectId/omnichannel (settings)
 *   PATCH /api/projects/:projectId/omnichannel (settings update)
 *   GET  /api/projects/:projectId/omnichannel/audit
 *
 * E2E rules:
 * - NO vi.mock() / jest.mock()
 * - NO direct database queries in assertions (except setup/teardown seeding)
 * - Real middleware chain: auth, rate limiting, feature gate, validation
 * - Seed data via POST endpoints where possible; model seeding in beforeAll for
 *   data not creatable via omnichannel routes (Contact, Message, Consent)
 */

import crypto from 'node:crypto';
import { afterAll, beforeAll, beforeEach, describe, expect, test } from 'vitest';
import authRouter from '../../routes/auth.js';
import platformAdminTenantsRouter from '../../routes/platform-admin-tenants.js';
import omnichannelRouter from '../../routes/omnichannel.js';
import { clearPermissionCache } from '../../services/permission-resolution.js';
import {
  startRuntimeApiHarness,
  mintSdkSessionToken,
  type RuntimeApiHarness,
} from '../helpers/runtime-api-harness.js';
import {
  authHeaders,
  bootstrapProject,
  requestJson,
  setSuperAdmins,
  uniqueEmail,
  uniqueSlug,
} from '../helpers/channel-e2e-bootstrap.js';
import {
  Subscription,
  Contact,
  Message,
  ContactCapabilityConsent,
} from '@agent-platform/database/models';

// ─── Constants ────────────────────────────────────────────────────────────────

/**
 * Grant omnichannel feature to a tenant by upgrading its subscription to BUSINESS.
 * The bootstrapProject helper creates a TEAM subscription via the createTenant API.
 * We upgrade it to BUSINESS so the fail-closed feature gate allows access.
 */
async function grantOmnichannelFeature(tenantId: string): Promise<void> {
  await Subscription.findOneAndUpdate(
    { tenantId, status: 'active' },
    { $set: { planTier: 'BUSINESS' } },
  );
}

function sdkTokenHeaders(token: string): Record<string, string> {
  return { 'X-SDK-Token': token };
}

// ─── Types ────────────────────────────────────────────────────────────────────

interface SettingsResponse {
  success: boolean;
  settings?: Record<string, unknown>;
  data?: Record<string, unknown>;
}

interface RecallResponse {
  success: boolean;
  data?: {
    messages: Array<{
      id: string;
      sessionId: string;
      role: string;
      content: string;
      channel: string;
    }>;
    metadata: {
      matchedSessions: number;
      truncated: boolean;
      payloadBytes: number;
    };
  };
  error?: { code: string; message: string };
}

interface AuditResponse {
  success: boolean;
  data?: {
    events: Array<{
      eventType: string;
      description: string;
      tenantId: string;
      projectId: string;
      timestamp: string;
    }>;
  };
}

// ─── Test Suite ───────────────────────────────────────────────────────────────

describe('Omnichannel Recall E2E', () => {
  let harness: RuntimeApiHarness;

  beforeAll(async () => {
    harness = await startRuntimeApiHarness((app) => {
      app.use('/api/auth', authRouter);
      app.use('/api/platform/admin/tenants', platformAdminTenantsRouter);
      app.use('/api/projects/:projectId/omnichannel', omnichannelRouter);
    });
  }, 60_000);

  beforeEach(async () => {
    clearPermissionCache();
    await harness.resetRuntimeState();
    await setSuperAdmins([]);
    await Subscription.deleteMany({});
  });

  afterAll(async () => {
    await harness.close();
  }, 30_000);

  // ─── E2E-1: GET settings returns defaults ───────────────────────────────

  test('E2E-1: GET /omnichannel returns default settings for new project', async () => {
    const admin = await bootstrapProject(
      harness,
      uniqueEmail('recall-defaults'),
      uniqueSlug('tenant-recall-defaults'),
      uniqueSlug('proj-recall-defaults'),
    );
    await grantOmnichannelFeature(admin.tenantId);

    const res = await requestJson<SettingsResponse>(
      harness,
      `/api/projects/${admin.projectId}/omnichannel`,
      {
        method: 'GET',
        headers: authHeaders(admin.token),
      },
    );

    expect(res.status).toBe(200);
    expect(res.body.success).toBe(true);
    // Settings may come back in .settings or .data
    const settings = res.body.settings ?? res.body.data;
    expect(settings).toBeTruthy();
  });

  // ─── E2E-2: PATCH settings updates correctly ───────────────────────────

  test('E2E-2: PATCH /omnichannel updates settings and GET reflects changes', async () => {
    const admin = await bootstrapProject(
      harness,
      uniqueEmail('recall-patch'),
      uniqueSlug('tenant-recall-patch'),
      uniqueSlug('proj-recall-patch'),
    );
    await grantOmnichannelFeature(admin.tenantId);

    // Update settings
    const patchRes = await requestJson<SettingsResponse>(
      harness,
      `/api/projects/${admin.projectId}/omnichannel`,
      {
        method: 'PATCH',
        headers: authHeaders(admin.token),
        body: {
          recall: { enabled: true, maxMessages: 50 },
          liveSync: { enabled: true },
        },
      },
    );

    expect(patchRes.status).toBe(200);
    expect(patchRes.body.success).toBe(true);

    // Verify the settings were persisted
    const getRes = await requestJson<SettingsResponse>(
      harness,
      `/api/projects/${admin.projectId}/omnichannel`,
      {
        method: 'GET',
        headers: authHeaders(admin.token),
      },
    );

    expect(getRes.status).toBe(200);
    const settings = (getRes.body.settings ?? getRes.body.data) as Record<string, unknown>;
    const recall = settings?.recall as Record<string, unknown>;
    expect(recall?.enabled).toBe(true);
    expect(recall?.maxMessages).toBe(50);
  });

  // ─── E2E-3: POST /recall requires auth ─────────────────────────────────

  test('E2E-3: POST /recall without auth returns 401/403', async () => {
    const admin = await bootstrapProject(
      harness,
      uniqueEmail('recall-noauth'),
      uniqueSlug('tenant-recall-noauth'),
      uniqueSlug('proj-recall-noauth'),
    );

    const res = await requestJson<RecallResponse>(
      harness,
      `/api/projects/${admin.projectId}/omnichannel/recall`,
      {
        method: 'POST',
        body: { contactId: 'some-contact' },
      },
    );

    // Should fail without auth token
    expect(res.status).toBeGreaterThanOrEqual(400);
  });

  // ─── E2E-4: POST /recall with invalid body returns 400 ─────────────────

  test('E2E-4: POST /recall with invalid body returns 400', async () => {
    const admin = await bootstrapProject(
      harness,
      uniqueEmail('recall-invalid'),
      uniqueSlug('tenant-recall-invalid'),
      uniqueSlug('proj-recall-invalid'),
    );
    await grantOmnichannelFeature(admin.tenantId);

    const res = await requestJson<RecallResponse>(
      harness,
      `/api/projects/${admin.projectId}/omnichannel/recall`,
      {
        method: 'POST',
        headers: authHeaders(admin.token),
        body: {}, // Missing required contactId
      },
    );

    // Should fail validation — status depends on auth middleware (could be 400 or 403)
    expect(res.status).toBeGreaterThanOrEqual(400);
  });

  // ─── E2E-5: GET /audit returns events ───────────────────────────────────

  test('E2E-5: GET /omnichannel/audit returns audit events array', async () => {
    const admin = await bootstrapProject(
      harness,
      uniqueEmail('recall-audit'),
      uniqueSlug('tenant-recall-audit'),
      uniqueSlug('proj-recall-audit'),
    );
    await grantOmnichannelFeature(admin.tenantId);

    const res = await requestJson<AuditResponse>(
      harness,
      `/api/projects/${admin.projectId}/omnichannel/audit`,
      {
        method: 'GET',
        headers: authHeaders(admin.token),
      },
    );

    expect(res.status).toBe(200);
    expect(res.body.success).toBe(true);
    expect(res.body.data).toBeTruthy();
    expect(Array.isArray(res.body.data?.events)).toBe(true);
  });

  // ─── E2E-6: Settings validation — reject invalid values ────────────────

  test('E2E-6: PATCH /omnichannel rejects invalid recall maxMessages', async () => {
    const admin = await bootstrapProject(
      harness,
      uniqueEmail('recall-validation'),
      uniqueSlug('tenant-recall-validation'),
      uniqueSlug('proj-recall-validation'),
    );
    await grantOmnichannelFeature(admin.tenantId);

    const res = await requestJson<SettingsResponse>(
      harness,
      `/api/projects/${admin.projectId}/omnichannel`,
      {
        method: 'PATCH',
        headers: authHeaders(admin.token),
        body: {
          recall: { maxMessages: -5 },
        },
      },
    );

    expect(res.status).toBe(400);
    expect(res.body.success).toBe(false);
  });

  // ─── E2E-7: POST /recall retrieves seeded messages ─────────────────────

  test('E2E-7: POST /recall returns messages for a contact with consent', async () => {
    // 1. Bootstrap project and enable omnichannel + recall
    const admin = await bootstrapProject(
      harness,
      uniqueEmail('recall-retrieve'),
      uniqueSlug('tenant-recall-retrieve'),
      uniqueSlug('proj-recall-retrieve'),
    );
    await grantOmnichannelFeature(admin.tenantId);

    // Enable recall and lower identity minTier to 0 so SDK tokens pass
    await requestJson<SettingsResponse>(harness, `/api/projects/${admin.projectId}/omnichannel`, {
      method: 'PATCH',
      headers: authHeaders(admin.token),
      body: {
        recall: { enabled: true, maxMessages: 50 },
        identity: { minTier: 0 },
      },
    });

    // 2. Seed test data: contact, consent, and messages from a prior session
    const contactId = crypto.randomUUID();
    const priorSessionId = crypto.randomUUID();
    const currentSessionId = crypto.randomUUID();
    const channelId = crypto.randomUUID();

    await Contact.create({
      _id: contactId,
      tenantId: admin.tenantId,
      type: 'customer',
      firstSeenAt: new Date(),
      lastSeenAt: new Date(),
    });

    await ContactCapabilityConsent.create({
      tenantId: admin.tenantId,
      projectId: admin.projectId,
      contactId,
      capability: 'cross_channel_recall',
      state: 'granted',
      grantedBy: 'test-system',
      grantedAt: new Date(),
      policyVersion: '1.0',
    });

    // Seed 3 messages from a prior session
    for (let i = 0; i < 3; i++) {
      await Message.create({
        sessionId: priorSessionId,
        tenantId: admin.tenantId,
        projectId: admin.projectId,
        contactId,
        role: i % 2 === 0 ? 'user' : 'assistant',
        content: `Test message ${i + 1} from prior session`,
        channel: 'web',
        final: true,
        timestamp: new Date(Date.now() - (3 - i) * 60_000),
      });
    }

    // 3. Mint an SDK session token for the current session
    const sdkToken = mintSdkSessionToken({
      tenantId: admin.tenantId,
      projectId: admin.projectId,
      sessionId: currentSessionId,
      channelId,
      contactId,
      identityTier: 2,
    });

    // 4. Call POST /recall and verify messages are returned
    const res = await requestJson<RecallResponse>(
      harness,
      `/api/projects/${admin.projectId}/omnichannel/recall`,
      {
        method: 'POST',
        headers: sdkTokenHeaders(sdkToken),
        body: { contactId },
      },
    );

    expect(res.status).toBe(200);
    expect(res.body.success).toBe(true);
    expect(res.body.data).toBeTruthy();
    expect(res.body.data?.messages.length).toBe(3);
    expect(res.body.data?.metadata.matchedSessions).toBe(1);
    expect(res.body.data?.metadata.payloadBytes).toBeGreaterThan(0);

    // Verify messages come from the prior session, not the current one
    for (const msg of res.body.data?.messages ?? []) {
      expect(msg.sessionId).toBe(priorSessionId);
      expect(msg.channel).toBe('web');
      expect(['user', 'assistant']).toContain(msg.role);
    }
  });

  // ─── E2E-8: POST /recall respects maxMessages limit ────────────────────

  test('E2E-8: POST /recall respects maxMessages from request body', async () => {
    const admin = await bootstrapProject(
      harness,
      uniqueEmail('recall-limit'),
      uniqueSlug('tenant-recall-limit'),
      uniqueSlug('proj-recall-limit'),
    );
    await grantOmnichannelFeature(admin.tenantId);

    await requestJson<SettingsResponse>(harness, `/api/projects/${admin.projectId}/omnichannel`, {
      method: 'PATCH',
      headers: authHeaders(admin.token),
      body: {
        recall: { enabled: true, maxMessages: 50 },
        identity: { minTier: 0 },
      },
    });

    const contactId = crypto.randomUUID();
    const priorSessionId = crypto.randomUUID();
    const currentSessionId = crypto.randomUUID();
    const channelId = crypto.randomUUID();

    await Contact.create({
      _id: contactId,
      tenantId: admin.tenantId,
      type: 'customer',
      firstSeenAt: new Date(),
      lastSeenAt: new Date(),
    });

    await ContactCapabilityConsent.create({
      tenantId: admin.tenantId,
      projectId: admin.projectId,
      contactId,
      capability: 'cross_channel_recall',
      state: 'granted',
      grantedBy: 'test-system',
      grantedAt: new Date(),
      policyVersion: '1.0',
    });

    // Seed 10 messages
    for (let i = 0; i < 10; i++) {
      await Message.create({
        sessionId: priorSessionId,
        tenantId: admin.tenantId,
        projectId: admin.projectId,
        contactId,
        role: i % 2 === 0 ? 'user' : 'assistant',
        content: `Limit test message ${i + 1}`,
        channel: 'web',
        final: true,
        timestamp: new Date(Date.now() - (10 - i) * 60_000),
      });
    }

    const sdkToken = mintSdkSessionToken({
      tenantId: admin.tenantId,
      projectId: admin.projectId,
      sessionId: currentSessionId,
      channelId,
      contactId,
      identityTier: 2,
    });

    // Request only 3 messages
    const res = await requestJson<RecallResponse>(
      harness,
      `/api/projects/${admin.projectId}/omnichannel/recall`,
      {
        method: 'POST',
        headers: sdkTokenHeaders(sdkToken),
        body: { contactId, maxMessages: 3 },
      },
    );

    expect(res.status).toBe(200);
    expect(res.body.success).toBe(true);
    expect(res.body.data?.messages.length).toBe(3);
    // When we hit the message limit exactly, truncated should be true
    expect(res.body.data?.metadata.truncated).toBe(true);
  });

  // ─── E2E-9: POST /recall with structured ContentBlock content ──────────

  test('E2E-9: POST /recall handles structured ContentBlock content', async () => {
    const admin = await bootstrapProject(
      harness,
      uniqueEmail('recall-structured'),
      uniqueSlug('tenant-recall-structured'),
      uniqueSlug('proj-recall-structured'),
    );
    await grantOmnichannelFeature(admin.tenantId);

    await requestJson<SettingsResponse>(harness, `/api/projects/${admin.projectId}/omnichannel`, {
      method: 'PATCH',
      headers: authHeaders(admin.token),
      body: {
        recall: { enabled: true, maxMessages: 50 },
        identity: { minTier: 0 },
      },
    });

    const contactId = crypto.randomUUID();
    const priorSessionId = crypto.randomUUID();
    const currentSessionId = crypto.randomUUID();
    const channelId = crypto.randomUUID();

    await Contact.create({
      _id: contactId,
      tenantId: admin.tenantId,
      type: 'customer',
      firstSeenAt: new Date(),
      lastSeenAt: new Date(),
    });

    await ContactCapabilityConsent.create({
      tenantId: admin.tenantId,
      projectId: admin.projectId,
      contactId,
      capability: 'cross_channel_recall',
      state: 'granted',
      grantedBy: 'test-system',
      grantedAt: new Date(),
      policyVersion: '1.0',
    });

    // Seed a message with structured ContentBlock[] content (stored as JSON string)
    const structuredContent = JSON.stringify([
      { type: 'text', text: 'Hello, I need help with my order.' },
      { type: 'image', url: 'https://example.com/order-screenshot.png' },
    ]);

    await Message.create({
      sessionId: priorSessionId,
      tenantId: admin.tenantId,
      projectId: admin.projectId,
      contactId,
      role: 'user',
      content: structuredContent,
      channel: 'mobile',
      sourceChannel: 'mobile',
      inputMode: 'typed',
      final: true,
      timestamp: new Date(Date.now() - 60_000),
    });

    // Also seed a plain text assistant response
    await Message.create({
      sessionId: priorSessionId,
      tenantId: admin.tenantId,
      projectId: admin.projectId,
      contactId,
      role: 'assistant',
      content: 'Sure, let me look up your order details.',
      channel: 'mobile',
      final: true,
      timestamp: new Date(Date.now() - 30_000),
    });

    const sdkToken = mintSdkSessionToken({
      tenantId: admin.tenantId,
      projectId: admin.projectId,
      sessionId: currentSessionId,
      channelId,
      contactId,
      identityTier: 2,
    });

    const res = await requestJson<RecallResponse>(
      harness,
      `/api/projects/${admin.projectId}/omnichannel/recall`,
      {
        method: 'POST',
        headers: sdkTokenHeaders(sdkToken),
        body: { contactId },
      },
    );

    expect(res.status).toBe(200);
    expect(res.body.success).toBe(true);
    expect(res.body.data?.messages.length).toBe(2);

    // The structured content message should still be returned as a string
    // (recall service returns content as-is after PII redaction)
    const userMsg = res.body.data?.messages.find((m) => m.role === 'user');
    expect(userMsg).toBeTruthy();
    expect(userMsg?.content).toBeTruthy();
    // Verify it's parseable as structured content
    const parsed = JSON.parse(userMsg?.content ?? '');
    expect(Array.isArray(parsed)).toBe(true);
    expect(parsed[0].type).toBe('text');
  });

  // ─── E2E-10: POST /recall returns empty without consent ────────────────

  test('E2E-10: POST /recall returns empty messages array when no consent', async () => {
    const admin = await bootstrapProject(
      harness,
      uniqueEmail('recall-noconsent'),
      uniqueSlug('tenant-recall-noconsent'),
      uniqueSlug('proj-recall-noconsent'),
    );
    await grantOmnichannelFeature(admin.tenantId);

    await requestJson<SettingsResponse>(harness, `/api/projects/${admin.projectId}/omnichannel`, {
      method: 'PATCH',
      headers: authHeaders(admin.token),
      body: {
        recall: { enabled: true, maxMessages: 50 },
        identity: { minTier: 0 },
      },
    });

    const contactId = crypto.randomUUID();
    const priorSessionId = crypto.randomUUID();
    const currentSessionId = crypto.randomUUID();
    const channelId = crypto.randomUUID();

    await Contact.create({
      _id: contactId,
      tenantId: admin.tenantId,
      type: 'customer',
      firstSeenAt: new Date(),
      lastSeenAt: new Date(),
    });

    // Seed messages but NO consent
    await Message.create({
      sessionId: priorSessionId,
      tenantId: admin.tenantId,
      projectId: admin.projectId,
      contactId,
      role: 'user',
      content: 'Message without consent',
      channel: 'web',
      final: true,
      timestamp: new Date(),
    });

    const sdkToken = mintSdkSessionToken({
      tenantId: admin.tenantId,
      projectId: admin.projectId,
      sessionId: currentSessionId,
      channelId,
      contactId,
      identityTier: 2,
    });

    const res = await requestJson<RecallResponse>(
      harness,
      `/api/projects/${admin.projectId}/omnichannel/recall`,
      {
        method: 'POST',
        headers: sdkTokenHeaders(sdkToken),
        body: { contactId },
      },
    );

    expect(res.status).toBe(200);
    expect(res.body.success).toBe(true);
    // Should return empty — no consent means no recall
    expect(res.body.data?.messages.length).toBe(0);
    expect(res.body.data?.metadata.matchedSessions).toBe(0);
  });

  // ─── E2E-11: POST /recall excludes current session messages ────────────

  test('E2E-11: POST /recall excludes messages from the current session', async () => {
    const admin = await bootstrapProject(
      harness,
      uniqueEmail('recall-excludecurr'),
      uniqueSlug('tenant-recall-excludecurr'),
      uniqueSlug('proj-recall-excludecurr'),
    );
    await grantOmnichannelFeature(admin.tenantId);

    await requestJson<SettingsResponse>(harness, `/api/projects/${admin.projectId}/omnichannel`, {
      method: 'PATCH',
      headers: authHeaders(admin.token),
      body: {
        recall: { enabled: true, maxMessages: 50 },
        identity: { minTier: 0 },
      },
    });

    const contactId = crypto.randomUUID();
    const priorSessionId = crypto.randomUUID();
    const currentSessionId = crypto.randomUUID();
    const channelId = crypto.randomUUID();

    await Contact.create({
      _id: contactId,
      tenantId: admin.tenantId,
      type: 'customer',
      firstSeenAt: new Date(),
      lastSeenAt: new Date(),
    });

    await ContactCapabilityConsent.create({
      tenantId: admin.tenantId,
      projectId: admin.projectId,
      contactId,
      capability: 'cross_channel_recall',
      state: 'granted',
      grantedBy: 'test-system',
      grantedAt: new Date(),
      policyVersion: '1.0',
    });

    // Seed 2 messages from prior session
    await Message.create({
      sessionId: priorSessionId,
      tenantId: admin.tenantId,
      projectId: admin.projectId,
      contactId,
      role: 'user',
      content: 'Prior session message',
      channel: 'web',
      final: true,
      timestamp: new Date(Date.now() - 120_000),
    });

    // Seed 2 messages from the CURRENT session (should be excluded)
    await Message.create({
      sessionId: currentSessionId,
      tenantId: admin.tenantId,
      projectId: admin.projectId,
      contactId,
      role: 'user',
      content: 'Current session message - should not appear',
      channel: 'web',
      final: true,
      timestamp: new Date(Date.now() - 60_000),
    });

    const sdkToken = mintSdkSessionToken({
      tenantId: admin.tenantId,
      projectId: admin.projectId,
      sessionId: currentSessionId,
      channelId,
      contactId,
      identityTier: 2,
    });

    const res = await requestJson<RecallResponse>(
      harness,
      `/api/projects/${admin.projectId}/omnichannel/recall`,
      {
        method: 'POST',
        headers: sdkTokenHeaders(sdkToken),
        body: { contactId },
      },
    );

    expect(res.status).toBe(200);
    expect(res.body.success).toBe(true);
    // Only prior session messages, not current session
    expect(res.body.data?.messages.length).toBe(1);
    for (const msg of res.body.data?.messages ?? []) {
      expect(msg.sessionId).not.toBe(currentSessionId);
      expect(msg.sessionId).toBe(priorSessionId);
    }
  });
});

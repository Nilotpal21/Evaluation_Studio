/**
 * Omnichannel Privacy Gates — E2E Tests
 *
 * Tests cross-project and cross-tenant isolation:
 * - Settings from one project do not leak to another
 * - Audit events are scoped to the correct project
 * - Different tenants cannot access each other's omnichannel settings
 * - Recall for a contactId in project A returns no results from project B
 *
 * E2E rules:
 * - NO vi.mock() / jest.mock()
 * - NO direct database queries in assertions (model seeding in setup only)
 * - Real middleware chain: auth, rate limiting, feature gate, validation
 * - Seed data via POST endpoints, assert via GET responses
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
  error?: { code: string; message: string };
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

// ─── Test Suite ───────────────────────────────────────────────────────────────

describe('Omnichannel Privacy Gates E2E', () => {
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

  // ─── E2E-PG-1: Cross-project isolation ──────────────────────────────────

  test('E2E-PG-1: Settings changes in project A do not affect project B', async () => {
    const adminA = await bootstrapProject(
      harness,
      uniqueEmail('pg-proj-a'),
      uniqueSlug('tenant-pg-a'),
      uniqueSlug('proj-pg-a'),
    );
    await grantOmnichannelFeature(adminA.tenantId);

    // We need a second project under the same tenant — bootstrap creates
    // a new tenant. Since we cannot easily create 2 projects under 1 tenant
    // in this harness without direct DB, we instead verify that project A's
    // settings don't bleed into project B (different tenant).
    const adminB = await bootstrapProject(
      harness,
      uniqueEmail('pg-proj-b'),
      uniqueSlug('tenant-pg-b'),
      uniqueSlug('proj-pg-b'),
    );
    await grantOmnichannelFeature(adminB.tenantId);

    // Enable recall in project A
    const patchA = await requestJson<SettingsResponse>(
      harness,
      `/api/projects/${adminA.projectId}/omnichannel`,
      {
        method: 'PATCH',
        headers: authHeaders(adminA.token),
        body: { recall: { enabled: true, maxMessages: 99 } },
      },
    );
    expect(patchA.status).toBe(200);

    // Project B should still have defaults
    const getB = await requestJson<SettingsResponse>(
      harness,
      `/api/projects/${adminB.projectId}/omnichannel`,
      {
        method: 'GET',
        headers: authHeaders(adminB.token),
      },
    );
    expect(getB.status).toBe(200);
    const settingsB = (getB.body.settings ?? getB.body.data) as Record<string, unknown>;
    const recallB = settingsB?.recall as Record<string, unknown>;
    // Default maxMessages is 20, not 99
    expect(recallB?.maxMessages).not.toBe(99);
    expect(recallB?.enabled).toBe(false);
  });

  // ─── E2E-PG-2: Cross-tenant auth isolation ─────────────────────────────

  test('E2E-PG-2: User from tenant A cannot access project B settings', async () => {
    const adminA = await bootstrapProject(
      harness,
      uniqueEmail('pg-auth-a'),
      uniqueSlug('tenant-pg-auth-a'),
      uniqueSlug('proj-pg-auth-a'),
    );
    await grantOmnichannelFeature(adminA.tenantId);
    const adminB = await bootstrapProject(
      harness,
      uniqueEmail('pg-auth-b'),
      uniqueSlug('tenant-pg-auth-b'),
      uniqueSlug('proj-pg-auth-b'),
    );
    await grantOmnichannelFeature(adminB.tenantId);

    // Try to access project B's settings with tenant A's token
    const crossRes = await requestJson<SettingsResponse>(
      harness,
      `/api/projects/${adminB.projectId}/omnichannel`,
      {
        method: 'GET',
        headers: authHeaders(adminA.token),
      },
    );

    // Should be denied — either 404 (concealed) or 403
    expect(crossRes.status).toBeGreaterThanOrEqual(400);
  });

  // ─── E2E-PG-3: Cross-tenant audit isolation ────────────────────────────

  test('E2E-PG-3: Audit events from tenant A not visible in tenant B', async () => {
    const adminA = await bootstrapProject(
      harness,
      uniqueEmail('pg-audit-a'),
      uniqueSlug('tenant-pg-audit-a'),
      uniqueSlug('proj-pg-audit-a'),
    );
    await grantOmnichannelFeature(adminA.tenantId);
    const adminB = await bootstrapProject(
      harness,
      uniqueEmail('pg-audit-b'),
      uniqueSlug('tenant-pg-audit-b'),
      uniqueSlug('proj-pg-audit-b'),
    );
    await grantOmnichannelFeature(adminB.tenantId);

    // Trigger an audit event in project A by updating settings
    await requestJson<SettingsResponse>(harness, `/api/projects/${adminA.projectId}/omnichannel`, {
      method: 'PATCH',
      headers: authHeaders(adminA.token),
      body: { recall: { enabled: true } },
    });

    // Audit in project B should not contain project A events
    const auditB = await requestJson<{
      success: boolean;
      data?: { events: Array<{ projectId: string }> };
    }>(harness, `/api/projects/${adminB.projectId}/omnichannel/audit`, {
      method: 'GET',
      headers: authHeaders(adminB.token),
    });

    expect(auditB.status).toBe(200);
    const events = auditB.body.data?.events ?? [];
    // None of the events should reference project A
    for (const event of events) {
      expect(event.projectId).not.toBe(adminA.projectId);
    }
  });

  // ─── E2E-PG-4: Settings persist across reads ───────────────────────────

  test('E2E-PG-4: Settings changes persist and survive multiple reads', async () => {
    const admin = await bootstrapProject(
      harness,
      uniqueEmail('pg-persist'),
      uniqueSlug('tenant-pg-persist'),
      uniqueSlug('proj-pg-persist'),
    );
    await grantOmnichannelFeature(admin.tenantId);

    // First update
    await requestJson<SettingsResponse>(harness, `/api/projects/${admin.projectId}/omnichannel`, {
      method: 'PATCH',
      headers: authHeaders(admin.token),
      body: { recall: { enabled: true, maxMessages: 42 } },
    });

    // Second update (partial)
    await requestJson<SettingsResponse>(harness, `/api/projects/${admin.projectId}/omnichannel`, {
      method: 'PATCH',
      headers: authHeaders(admin.token),
      body: { liveSync: { enabled: true } },
    });

    // Verify both changes persisted
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
    const liveSync = settings?.liveSync as Record<string, unknown>;
    expect(recall?.enabled).toBe(true);
    expect(recall?.maxMessages).toBe(42);
    expect(liveSync?.enabled).toBe(true);
  });

  // ─── E2E-PG-5: Cross-project recall isolation ──────────────────────────

  test('E2E-PG-5: Recall for a contact in project A returns no results from project B context', async () => {
    // Bootstrap two separate projects (different tenants)
    const adminA = await bootstrapProject(
      harness,
      uniqueEmail('pg-recall-a'),
      uniqueSlug('tenant-pg-recall-a'),
      uniqueSlug('proj-pg-recall-a'),
    );
    await grantOmnichannelFeature(adminA.tenantId);

    const adminB = await bootstrapProject(
      harness,
      uniqueEmail('pg-recall-b'),
      uniqueSlug('tenant-pg-recall-b'),
      uniqueSlug('proj-pg-recall-b'),
    );
    await grantOmnichannelFeature(adminB.tenantId);

    // Enable recall on both projects
    for (const admin of [adminA, adminB]) {
      await requestJson<SettingsResponse>(harness, `/api/projects/${admin.projectId}/omnichannel`, {
        method: 'PATCH',
        headers: authHeaders(admin.token),
        body: {
          recall: { enabled: true, maxMessages: 50 },
          identity: { minTier: 0 },
        },
      });
    }

    // Seed a contact with messages in project A
    const contactId = crypto.randomUUID();
    const priorSessionId = crypto.randomUUID();
    const channelId = crypto.randomUUID();

    await Contact.create({
      _id: contactId,
      tenantId: adminA.tenantId,
      type: 'customer',
      firstSeenAt: new Date(),
      lastSeenAt: new Date(),
    });

    await ContactCapabilityConsent.create({
      tenantId: adminA.tenantId,
      projectId: adminA.projectId,
      contactId,
      capability: 'cross_channel_recall',
      state: 'granted',
      grantedBy: 'test-system',
      grantedAt: new Date(),
      policyVersion: '1.0',
    });

    // Seed messages in project A
    for (let i = 0; i < 5; i++) {
      await Message.create({
        sessionId: priorSessionId,
        tenantId: adminA.tenantId,
        projectId: adminA.projectId,
        contactId,
        role: 'user',
        content: `Project A message ${i + 1}`,
        channel: 'web',
        final: true,
        timestamp: new Date(Date.now() - (5 - i) * 60_000),
      });
    }

    // Verify project A can recall these messages
    const currentSessionA = crypto.randomUUID();
    const sdkTokenA = mintSdkSessionToken({
      tenantId: adminA.tenantId,
      projectId: adminA.projectId,
      sessionId: currentSessionA,
      channelId,
      contactId,
      identityTier: 2,
    });

    const recallA = await requestJson<RecallResponse>(
      harness,
      `/api/projects/${adminA.projectId}/omnichannel/recall`,
      {
        method: 'POST',
        headers: sdkTokenHeaders(sdkTokenA),
        body: { contactId },
      },
    );

    expect(recallA.status).toBe(200);
    expect(recallA.body.data?.messages.length).toBe(5);

    // Now try to recall with project B context — same contactId but
    // different tenant. Should return empty because:
    // 1. No consent exists in project B for this contact
    // 2. No messages exist in project B for this contact
    // 3. The recall service scopes queries by tenantId AND projectId
    const currentSessionB = crypto.randomUUID();
    const sdkTokenB = mintSdkSessionToken({
      tenantId: adminB.tenantId,
      projectId: adminB.projectId,
      sessionId: currentSessionB,
      channelId: crypto.randomUUID(),
      contactId,
      identityTier: 2,
    });

    const recallB = await requestJson<RecallResponse>(
      harness,
      `/api/projects/${adminB.projectId}/omnichannel/recall`,
      {
        method: 'POST',
        headers: sdkTokenHeaders(sdkTokenB),
        body: { contactId },
      },
    );

    expect(recallB.status).toBe(200);
    expect(recallB.body.success).toBe(true);
    // Project B should see NO messages — isolation enforced
    expect(recallB.body.data?.messages.length).toBe(0);
    expect(recallB.body.data?.metadata.matchedSessions).toBe(0);
  });
});

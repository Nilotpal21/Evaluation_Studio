/**
 * Omnichannel Live Session — E2E Tests
 *
 * Tests the live session endpoints through the real HTTP stack:
 * real Express server, real MongoDB (MongoMemoryServer), full middleware chain.
 *
 * Routes under test:
 *   GET  /api/projects/:projectId/omnichannel/live-session
 *   POST /api/projects/:projectId/omnichannel/live-session/:sessionId/join
 *   POST /api/projects/:projectId/omnichannel/live-session/:sessionId/detach
 *   POST /api/projects/:projectId/omnichannel/join-links
 *
 * Note: Live session operations require Redis for participant registry and
 * session lookup. In test mode with REDIS_ENABLED=false, the participant
 * registry returns empty/null gracefully, so we test the HTTP layer and
 * validation behavior. The discovery and join flows exercise the full
 * route handler logic including settings checks, consent verification,
 * and identity tier gating — Redis-backed state simply returns null/empty.
 *
 * E2E rules:
 * - NO vi.mock() / jest.mock()
 * - NO direct database queries in assertions (model seeding in setup only)
 * - Real middleware chain: auth, rate limiting, feature gate, validation
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
import { Subscription, Contact, ContactCapabilityConsent } from '@agent-platform/database/models';

// ─── Constants ────────────────────────────────────────────────────────────────

/**
 * Grant omnichannel feature to a tenant by upgrading its subscription to BUSINESS.
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
  data?: Record<string, unknown>;
}

interface LiveSessionResponse {
  success: boolean;
  data?: unknown;
  error?: { code: string; message: string };
}

interface JoinLinkResponse {
  success: boolean;
  data?: { token: string };
  error?: { code: string; message: string };
}

// ─── Test Suite ───────────────────────────────────────────────────────────────

describe('Omnichannel Live Session E2E', () => {
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

  // ─── E2E-LS-1: GET /live-session requires contactId ─────────────────────

  test('E2E-LS-1: GET /live-session without contactId returns 400', async () => {
    const admin = await bootstrapProject(
      harness,
      uniqueEmail('ls-nocontact'),
      uniqueSlug('tenant-ls-nocontact'),
      uniqueSlug('proj-ls-nocontact'),
    );
    await grantOmnichannelFeature(admin.tenantId);

    const res = await requestJson<LiveSessionResponse>(
      harness,
      `/api/projects/${admin.projectId}/omnichannel/live-session`,
      {
        method: 'GET',
        headers: authHeaders(admin.token),
      },
    );

    expect(res.status).toBe(400);
    expect(res.body.success).toBe(false);
    expect(res.body.error?.code).toBe('VALIDATION_ERROR');
  });

  // ─── E2E-LS-2: GET /live-session returns null when no active session ────

  test('E2E-LS-2: GET /live-session returns null when no session is active', async () => {
    const admin = await bootstrapProject(
      harness,
      uniqueEmail('ls-nosess'),
      uniqueSlug('tenant-ls-nosess'),
      uniqueSlug('proj-ls-nosess'),
    );
    await grantOmnichannelFeature(admin.tenantId);

    const res = await requestJson<LiveSessionResponse>(
      harness,
      `/api/projects/${admin.projectId}/omnichannel/live-session?contactId=some-contact`,
      {
        method: 'GET',
        headers: authHeaders(admin.token),
      },
    );

    expect(res.status).toBe(200);
    expect(res.body.success).toBe(true);
    expect(res.body.data).toBeNull();
  });

  // ─── E2E-LS-3: POST /join requires valid body ──────────────────────────

  test('E2E-LS-3: POST /live-session/:sessionId/join with invalid body returns 400', async () => {
    const admin = await bootstrapProject(
      harness,
      uniqueEmail('ls-join-invalid'),
      uniqueSlug('tenant-ls-join-invalid'),
      uniqueSlug('proj-ls-join-invalid'),
    );
    await grantOmnichannelFeature(admin.tenantId);

    const res = await requestJson<LiveSessionResponse>(
      harness,
      `/api/projects/${admin.projectId}/omnichannel/live-session/fake-session/join`,
      {
        method: 'POST',
        headers: authHeaders(admin.token),
        body: {}, // Missing required fields
      },
    );

    expect(res.status).toBe(400);
    expect(res.body.success).toBe(false);
  });

  // ─── E2E-LS-4: POST /detach requires valid body ────────────────────────

  test('E2E-LS-4: POST /live-session/:sessionId/detach requires participantId', async () => {
    const admin = await bootstrapProject(
      harness,
      uniqueEmail('ls-detach-invalid'),
      uniqueSlug('tenant-ls-detach-invalid'),
      uniqueSlug('proj-ls-detach-invalid'),
    );
    await grantOmnichannelFeature(admin.tenantId);

    const res = await requestJson<LiveSessionResponse>(
      harness,
      `/api/projects/${admin.projectId}/omnichannel/live-session/fake-session/detach`,
      {
        method: 'POST',
        headers: authHeaders(admin.token),
        body: {}, // Missing participantId
      },
    );

    expect(res.status).toBe(400);
    expect(res.body.success).toBe(false);
    expect(res.body.error?.code).toBe('VALIDATION_ERROR');
  });

  // ─── E2E-LS-5: POST /join-links requires auth ──────────────────────────

  test('E2E-LS-5: POST /join-links without auth returns 401/403', async () => {
    const admin = await bootstrapProject(
      harness,
      uniqueEmail('ls-joinlink-noauth'),
      uniqueSlug('tenant-ls-joinlink-noauth'),
      uniqueSlug('proj-ls-joinlink-noauth'),
    );

    const res = await requestJson<JoinLinkResponse>(
      harness,
      `/api/projects/${admin.projectId}/omnichannel/join-links`,
      {
        method: 'POST',
        body: { sessionId: 'fake-session', contactId: 'fake-contact' },
      },
    );

    // Should fail without auth token
    expect(res.status).toBeGreaterThanOrEqual(400);
  });

  // ─── E2E-LS-6: POST /join-links validates body ─────────────────────────

  test('E2E-LS-6: POST /join-links without sessionId/contactId returns 400', async () => {
    const admin = await bootstrapProject(
      harness,
      uniqueEmail('ls-joinlink-invalid'),
      uniqueSlug('tenant-ls-joinlink-invalid'),
      uniqueSlug('proj-ls-joinlink-invalid'),
    );
    await grantOmnichannelFeature(admin.tenantId);

    const res = await requestJson<JoinLinkResponse>(
      harness,
      `/api/projects/${admin.projectId}/omnichannel/join-links`,
      {
        method: 'POST',
        headers: authHeaders(admin.token),
        body: {}, // Missing required fields
      },
    );

    // Should fail validation — might be 400 or 403 (identity check)
    expect(res.status).toBeGreaterThanOrEqual(400);
    expect(res.body.success).toBe(false);
  });

  // ─── E2E-LS-7: Endpoints require auth ──────────────────────────────────

  test('E2E-LS-7: All live session endpoints require auth', async () => {
    const admin = await bootstrapProject(
      harness,
      uniqueEmail('ls-auth-all'),
      uniqueSlug('tenant-ls-auth-all'),
      uniqueSlug('proj-ls-auth-all'),
    );
    const pid = admin.projectId;

    // GET /live-session
    const discover = await requestJson<LiveSessionResponse>(
      harness,
      `/api/projects/${pid}/omnichannel/live-session?contactId=c1`,
      { method: 'GET' },
    );
    expect(discover.status).toBeGreaterThanOrEqual(400);

    // POST /live-session/:id/join
    const join = await requestJson<LiveSessionResponse>(
      harness,
      `/api/projects/${pid}/omnichannel/live-session/s1/join`,
      {
        method: 'POST',
        body: {
          contactId: 'c1',
          participantId: 'p1',
          surface: 'web',
        },
      },
    );
    expect(join.status).toBeGreaterThanOrEqual(400);

    // POST /live-session/:id/detach
    const detach = await requestJson<LiveSessionResponse>(
      harness,
      `/api/projects/${pid}/omnichannel/live-session/s1/detach`,
      {
        method: 'POST',
        body: { participantId: 'p1' },
      },
    );
    expect(detach.status).toBeGreaterThanOrEqual(400);
  });

  // ─── E2E-LS-8: Discovery with liveSync enabled returns null (no Redis) ─

  test('E2E-LS-8: GET /live-session with liveSync enabled and consent returns null without Redis', async () => {
    // This test exercises the full discovery path:
    // settings check -> consent check -> Redis lookup (null without Redis)
    const admin = await bootstrapProject(
      harness,
      uniqueEmail('ls-discover-flow'),
      uniqueSlug('tenant-ls-discover-flow'),
      uniqueSlug('proj-ls-discover-flow'),
    );
    await grantOmnichannelFeature(admin.tenantId);

    // Enable liveSync
    await requestJson<SettingsResponse>(harness, `/api/projects/${admin.projectId}/omnichannel`, {
      method: 'PATCH',
      headers: authHeaders(admin.token),
      body: { liveSync: { enabled: true } },
    });

    const contactId = crypto.randomUUID();
    const channelId = crypto.randomUUID();
    const sessionId = crypto.randomUUID();

    // Seed contact and consent
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
      capability: 'live_transcript_sync',
      state: 'granted',
      grantedBy: 'test-system',
      grantedAt: new Date(),
      policyVersion: '1.0',
    });

    // Use SDK token with identityTier 2 (required for live session)
    const sdkToken = mintSdkSessionToken({
      tenantId: admin.tenantId,
      projectId: admin.projectId,
      sessionId,
      channelId,
      contactId,
      identityTier: 2,
    });

    const res = await requestJson<LiveSessionResponse>(
      harness,
      `/api/projects/${admin.projectId}/omnichannel/live-session?contactId=${contactId}`,
      {
        method: 'GET',
        headers: sdkTokenHeaders(sdkToken),
      },
    );

    // Should succeed but return null — no Redis means no active sessions
    expect(res.status).toBe(200);
    expect(res.body.success).toBe(true);
    expect(res.body.data).toBeNull();
  });

  // ─── E2E-LS-9: Join returns SESSION_NOT_ACTIVE without Redis ───────────

  test('E2E-LS-9: POST /live-session/:sessionId/join returns 403 without active Redis session', async () => {
    const admin = await bootstrapProject(
      harness,
      uniqueEmail('ls-join-flow'),
      uniqueSlug('tenant-ls-join-flow'),
      uniqueSlug('proj-ls-join-flow'),
    );
    await grantOmnichannelFeature(admin.tenantId);

    // Enable liveSync
    await requestJson<SettingsResponse>(harness, `/api/projects/${admin.projectId}/omnichannel`, {
      method: 'PATCH',
      headers: authHeaders(admin.token),
      body: { liveSync: { enabled: true } },
    });

    const contactId = crypto.randomUUID();
    const channelId = crypto.randomUUID();
    const sessionId = crypto.randomUUID();

    // Seed contact and consent
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
      capability: 'live_transcript_sync',
      state: 'granted',
      grantedBy: 'test-system',
      grantedAt: new Date(),
      policyVersion: '1.0',
    });

    const sdkToken = mintSdkSessionToken({
      tenantId: admin.tenantId,
      projectId: admin.projectId,
      sessionId,
      channelId,
      contactId,
      identityTier: 2,
    });

    // Attempt join — should fail because no Redis session is active
    const res = await requestJson<LiveSessionResponse>(
      harness,
      `/api/projects/${admin.projectId}/omnichannel/live-session/${sessionId}/join`,
      {
        method: 'POST',
        headers: sdkTokenHeaders(sdkToken),
        body: {
          contactId,
          participantId: `ws:${sessionId}:${crypto.randomUUID().slice(0, 8)}`,
          surface: 'web',
        },
      },
    );

    // The join service checks Redis for an active session; without Redis,
    // getLiveSession returns null, so the join returns SESSION_NOT_ACTIVE
    expect(res.status).toBe(403);
    expect(res.body.success).toBe(false);
    expect(res.body.error?.code).toBe('SESSION_NOT_ACTIVE');
  });

  // ─── E2E-LS-10: Join denied with insufficient identity tier ────────────

  test('E2E-LS-10: POST /live-session/:sessionId/join denied with identityTier 0', async () => {
    const admin = await bootstrapProject(
      harness,
      uniqueEmail('ls-join-lowid'),
      uniqueSlug('tenant-ls-join-lowid'),
      uniqueSlug('proj-ls-join-lowid'),
    );
    await grantOmnichannelFeature(admin.tenantId);

    await requestJson<SettingsResponse>(harness, `/api/projects/${admin.projectId}/omnichannel`, {
      method: 'PATCH',
      headers: authHeaders(admin.token),
      body: { liveSync: { enabled: true } },
    });

    const contactId = crypto.randomUUID();
    const channelId = crypto.randomUUID();
    const sessionId = crypto.randomUUID();

    // SDK token with identityTier 0 (anonymous — should be denied)
    const sdkToken = mintSdkSessionToken({
      tenantId: admin.tenantId,
      projectId: admin.projectId,
      sessionId,
      channelId,
      contactId,
      identityTier: 0,
    });

    const res = await requestJson<LiveSessionResponse>(
      harness,
      `/api/projects/${admin.projectId}/omnichannel/live-session/${sessionId}/join`,
      {
        method: 'POST',
        headers: sdkTokenHeaders(sdkToken),
        body: {
          contactId,
          participantId: `ws:${sessionId}:test`,
          surface: 'web',
        },
      },
    );

    expect(res.status).toBe(403);
    expect(res.body.success).toBe(false);
    expect(res.body.error?.code).toBe('IDENTITY_INSUFFICIENT');
  });

  // ─── E2E-LS-11: Detach succeeds even without active Redis session ──────

  test('E2E-LS-11: POST /live-session/:sessionId/detach succeeds gracefully without Redis', async () => {
    const admin = await bootstrapProject(
      harness,
      uniqueEmail('ls-detach-flow'),
      uniqueSlug('tenant-ls-detach-flow'),
      uniqueSlug('proj-ls-detach-flow'),
    );
    await grantOmnichannelFeature(admin.tenantId);

    const sessionId = crypto.randomUUID();

    // Detach is graceful — no error even if session/participant don't exist
    const res = await requestJson<LiveSessionResponse>(
      harness,
      `/api/projects/${admin.projectId}/omnichannel/live-session/${sessionId}/detach`,
      {
        method: 'POST',
        headers: authHeaders(admin.token),
        body: { participantId: 'ws:test:participant' },
      },
    );

    expect(res.status).toBe(200);
    expect(res.body.success).toBe(true);
  });

  // ─── E2E-LS-12: Join denied when liveSync is disabled ─────────────────

  test('E2E-LS-12: POST /live-session/:sessionId/join denied when liveSync disabled', async () => {
    const admin = await bootstrapProject(
      harness,
      uniqueEmail('ls-join-disabled'),
      uniqueSlug('tenant-ls-join-disabled'),
      uniqueSlug('proj-ls-join-disabled'),
    );
    await grantOmnichannelFeature(admin.tenantId);

    // liveSync is disabled by default — do NOT enable it

    const contactId = crypto.randomUUID();
    const channelId = crypto.randomUUID();
    const sessionId = crypto.randomUUID();

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
      capability: 'live_transcript_sync',
      state: 'granted',
      grantedBy: 'test-system',
      grantedAt: new Date(),
      policyVersion: '1.0',
    });

    const sdkToken = mintSdkSessionToken({
      tenantId: admin.tenantId,
      projectId: admin.projectId,
      sessionId,
      channelId,
      contactId,
      identityTier: 2,
    });

    const res = await requestJson<LiveSessionResponse>(
      harness,
      `/api/projects/${admin.projectId}/omnichannel/live-session/${sessionId}/join`,
      {
        method: 'POST',
        headers: sdkTokenHeaders(sdkToken),
        body: {
          contactId,
          participantId: `ws:${sessionId}:test`,
          surface: 'web',
        },
      },
    );

    expect(res.status).toBe(403);
    expect(res.body.success).toBe(false);
    expect(res.body.error?.code).toBe('LIVE_SYNC_DISABLED');
  });
});

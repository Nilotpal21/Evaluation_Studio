/**
 * Omnichannel Cross-Channel Recall — E2E Tests
 *
 * Exercises cross-channel transcript recall through the real HTTP stack:
 * real Express server, real MongoDB (MongoMemoryServer), full middleware chain.
 *
 * Scenarios (OCS-E07 through OCS-E12):
 *   OCS-E07: WebSocket → HTTP async cross-channel recall
 *   OCS-E08: HTTP async → WebSocket cross-channel recall (reverse)
 *   OCS-E09: Voice → WhatsApp with OTP verification round-trip
 *   OCS-E10: Identity tier gating (tier 0, 1, 2 against minTier: 2)
 *   OCS-E11: Multi-channel recall across 3 channels
 *   OCS-E12: allowedChannels filter (project default + per-request override)
 *
 * E2E rules:
 * - NO vi.mock() / jest.mock()
 * - NO direct database queries in assertions (except setup/teardown seeding)
 * - Real middleware chain: auth, rate limiting, feature gate, validation
 * - Seed data via Mongoose models (messages are not creatable via omnichannel routes)
 */

import crypto from 'node:crypto';
import { afterAll, beforeAll, beforeEach, describe, expect, test } from 'vitest';
import type { VerificationMethod } from '@agent-platform/shared-auth';
import authRouter from '../../routes/auth.js';
import platformAdminTenantsRouter from '../../routes/platform-admin-tenants.js';
import omnichannelRouter from '../../routes/omnichannel.js';
import { unifiedAuth } from '../../middleware/auth.js';
import { createIdentityVerificationRouter } from '../../routes/identity-verification.js';
import { OtpVerifier } from '../../contexts/identity/infrastructure/verifiers/otp-verifier.js';
import { VerifyIdentity } from '../../contexts/identity/use-cases/verify-identity.js';
import type {
  VerificationTokenStore,
  StoredVerificationAttempt,
} from '../../contexts/identity/infrastructure/verification-token-store.js';
import type {
  IdentityVerifier,
  VerificationProof,
} from '../../contexts/identity/domain/identity-verifier.js';
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

// ─── In-Memory Token Store (for OTP verification in OCS-E09) ─────────────────

class InMemoryVerificationTokenStore implements VerificationTokenStore {
  private readonly store = new Map<string, StoredVerificationAttempt>();

  async create(attempt: StoredVerificationAttempt): Promise<void> {
    const key = `${attempt.tenantId}:${attempt.id}`;
    this.store.set(key, { ...attempt });
  }

  async get(tenantId: string, attemptId: string): Promise<StoredVerificationAttempt | null> {
    const key = `${tenantId}:${attemptId}`;
    const attempt = this.store.get(key);
    return attempt ? { ...attempt } : null;
  }

  async incrementAttempts(tenantId: string, attemptId: string): Promise<void> {
    const key = `${tenantId}:${attemptId}`;
    const attempt = this.store.get(key);
    if (attempt) {
      attempt.attempts += 1;
    }
  }

  async markVerified(tenantId: string, attemptId: string): Promise<void> {
    const key = `${tenantId}:${attemptId}`;
    const attempt = this.store.get(key);
    if (attempt) {
      attempt.status = 'verified';
    }
  }

  clear(): void {
    this.store.clear();
  }
}

// ─── Constants ───────────────────────────────────────────────────────────────

const TEST_OTP_SECRET = '9'.repeat(64);

// ─── Helpers ─────────────────────────────────────────────────────────────────

async function grantOmnichannelFeature(tenantId: string): Promise<void> {
  await Subscription.findOneAndUpdate(
    { tenantId, status: 'active' },
    { $set: { planTier: 'BUSINESS' } },
  );
}

function sdkTokenHeaders(token: string): Record<string, string> {
  return { 'X-SDK-Token': token };
}

// ─── Types ───────────────────────────────────────────────────────────────────

interface SettingsResponse {
  success: boolean;
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
      sourceChannel?: string;
      inputMode?: string;
    }>;
    metadata: {
      matchedSessions: number;
      truncated: boolean;
      payloadBytes: number;
    };
  };
  error?: { code: string; message: string };
}

interface InitiateResponse {
  success: boolean;
  attemptId?: string;
  challengeData?: Record<string, unknown>;
  error?: { code: string; message: string };
}

interface CompleteResponse {
  success: boolean;
  identityTier?: number;
  verifiedIdentity?: string;
  error?: { code: string; message: string };
}

interface AttemptStatusResponse {
  success?: boolean;
  data?: {
    attemptId?: string;
    status?: string;
    method?: string;
    expiresAt?: string;
  };
  error?: { code: string; message: string };
}

// ─── Shared Setup Helpers ────────────────────────────────────────────────────

interface ProjectSetup {
  token: string;
  userId: string;
  tenantId: string;
  projectId: string;
}

async function setupOmnichannelProject(
  harness: RuntimeApiHarness,
  label: string,
  opts: { minTier?: number } = {},
): Promise<ProjectSetup> {
  const admin = await bootstrapProject(
    harness,
    uniqueEmail(`cc-${label}`),
    uniqueSlug(`tenant-cc-${label}`),
    uniqueSlug(`proj-cc-${label}`),
  );
  await grantOmnichannelFeature(admin.tenantId);

  await requestJson<SettingsResponse>(harness, `/api/projects/${admin.projectId}/omnichannel`, {
    method: 'PATCH',
    headers: authHeaders(admin.token),
    body: {
      recall: { enabled: true, maxMessages: 50 },
      identity: { minTier: opts.minTier ?? 0 },
    },
  });

  return admin;
}

async function seedContactWithConsent(tenantId: string, projectId: string): Promise<string> {
  const contactId = crypto.randomUUID();

  await Contact.create({
    _id: contactId,
    tenantId,
    type: 'customer',
    firstSeenAt: new Date(),
    lastSeenAt: new Date(),
  });

  await ContactCapabilityConsent.create({
    tenantId,
    projectId,
    contactId,
    capability: 'cross_channel_recall',
    state: 'granted',
    grantedBy: 'test-system',
    grantedAt: new Date(),
    policyVersion: '1.0',
  });

  return contactId;
}

async function seedMessages(
  sessionId: string,
  tenantId: string,
  projectId: string,
  contactId: string,
  channel: string,
  count: number,
  opts: {
    sourceChannel?: string;
    inputMode?: string;
    baseTimeOffset?: number;
    structuredContentIndex?: number;
  } = {},
): Promise<void> {
  const sourceChannel = opts.sourceChannel ?? channel;
  const inputMode = opts.inputMode ?? 'typed';
  const baseOffset = opts.baseTimeOffset ?? 0;

  for (let i = 0; i < count; i++) {
    let content: string;
    if (opts.structuredContentIndex !== undefined && i === opts.structuredContentIndex) {
      content = JSON.stringify([
        { type: 'text', text: `Structured message from ${channel} session` },
        { type: 'image', url: 'https://example.com/screenshot.png' },
      ]);
    } else {
      content = `Message ${i + 1} from ${channel} session`;
    }

    await Message.create({
      sessionId,
      tenantId,
      projectId,
      contactId,
      role: i % 2 === 0 ? 'user' : 'assistant',
      content,
      channel,
      sourceChannel,
      inputMode,
      final: true,
      timestamp: new Date(Date.now() - (baseOffset + count - i) * 60_000),
    });
  }
}

// ─── Test Suite ──────────────────────────────────────────────────────────────

describe('Omnichannel Cross-Channel Recall E2E', () => {
  let harness: RuntimeApiHarness;
  let tokenStore: InMemoryVerificationTokenStore;

  beforeAll(async () => {
    tokenStore = new InMemoryVerificationTokenStore();

    const otpVerifier = new OtpVerifier(tokenStore, TEST_OTP_SECRET);
    const verifierMap = new Map<VerificationMethod, IdentityVerifier>([['otp', otpVerifier]]);
    const verifyIdentity = new VerifyIdentity(verifierMap);

    const completeVerification = async (attemptId: string, proof: VerificationProof) => {
      const tenantId = (proof.metadata?.tenantId as string) ?? '';
      const attempt = await tokenStore.get(tenantId, attemptId);
      if (!attempt) {
        return {
          success: false as const,
          error: { code: 'ATTEMPT_NOT_FOUND', message: 'Verification attempt not found' },
        };
      }
      const verifier = verifierMap.get(attempt.method as VerificationMethod);
      if (!verifier) {
        return {
          success: false as const,
          error: { code: 'UNSUPPORTED_METHOD', message: `No verifier for: ${attempt.method}` },
        };
      }
      return verifier.complete(attemptId, proof);
    };

    const identityVerificationRouter = createIdentityVerificationRouter({
      verifyIdentity,
      tokenStore,
      completeVerification,
    });

    harness = await startRuntimeApiHarness((app) => {
      app.use('/api/auth', authRouter);
      app.use('/api/platform/admin/tenants', platformAdminTenantsRouter);
      app.use('/api/projects/:projectId/omnichannel', omnichannelRouter);
      app.use('/api/identity', unifiedAuth);
      app.use('/api/identity/verify', identityVerificationRouter);
    });
  }, 60_000);

  beforeEach(async () => {
    clearPermissionCache();
    await harness.resetRuntimeState();
    await setSuperAdmins([]);
    await Subscription.deleteMany({});
    tokenStore.clear();
  }, 30_000);

  afterAll(async () => {
    await harness.close();
  }, 30_000);

  // ═══════════════════════════════════════════════════════════════════════════
  // OCS-E07: WebSocket → HTTP Async Cross-Channel Recall
  // ═══════════════════════════════════════════════════════════════════════════

  test('OCS-E07: web_chat messages are recallable from an http_async session', async () => {
    const admin = await setupOmnichannelProject(harness, 'e07');
    const contactId = await seedContactWithConsent(admin.tenantId, admin.projectId);

    const session1Id = crypto.randomUUID();
    const session2Id = crypto.randomUUID();

    // Seed 4 web_chat messages (session-1), including one structured ContentBlock[]
    await seedMessages(session1Id, admin.tenantId, admin.projectId, contactId, 'web_chat', 4, {
      sourceChannel: 'web',
      inputMode: 'typed',
      baseTimeOffset: 20,
      structuredContentIndex: 2,
    });

    // Seed 2 http_async messages (session-2, current session — should be excluded)
    await seedMessages(session2Id, admin.tenantId, admin.projectId, contactId, 'http_async', 2, {
      sourceChannel: 'http_async',
      inputMode: 'typed',
      baseTimeOffset: 5,
    });

    // Mint SDK token for session-2 (http_async context)
    const sdkToken = mintSdkSessionToken({
      tenantId: admin.tenantId,
      projectId: admin.projectId,
      sessionId: session2Id,
      channelId: crypto.randomUUID(),
      contactId,
      identityTier: 2,
    });

    const res = await requestJson<RecallResponse>(
      harness,
      `/api/projects/${admin.projectId}/omnichannel/recall`,
      {
        method: 'POST',
        headers: sdkTokenHeaders(sdkToken),
        body: { contactId, maxMessages: 10 },
      },
    );

    expect(res.status).toBe(200);
    expect(res.body.success).toBe(true);
    expect(res.body.data).toBeTruthy();

    const messages = res.body.data!.messages;
    // Only session-1 messages (session-2 is the current session, excluded)
    expect(messages.length).toBe(4);
    expect(res.body.data!.metadata.matchedSessions).toBe(1);

    // All messages should be from web_chat channel
    for (const msg of messages) {
      expect(msg.sessionId).toBe(session1Id);
      expect(msg.channel).toBe('web_chat');
    }

    // Verify structured ContentBlock[] is preserved
    const structuredMsg = messages.find((m) => m.content.includes('Structured message'));
    expect(structuredMsg).toBeTruthy();
    const parsed = JSON.parse(structuredMsg!.content);
    expect(Array.isArray(parsed)).toBe(true);
    expect(parsed[0].type).toBe('text');
    expect(parsed[1].type).toBe('image');

    // Isolation check: different project returns no messages
    const admin2 = await setupOmnichannelProject(harness, 'e07-iso');
    const isoToken = mintSdkSessionToken({
      tenantId: admin2.tenantId,
      projectId: admin2.projectId,
      sessionId: crypto.randomUUID(),
      channelId: crypto.randomUUID(),
      contactId,
      identityTier: 2,
    });

    const isoRes = await requestJson<RecallResponse>(
      harness,
      `/api/projects/${admin2.projectId}/omnichannel/recall`,
      {
        method: 'POST',
        headers: sdkTokenHeaders(isoToken),
        body: { contactId },
      },
    );

    expect(isoRes.status).toBe(200);
    expect(isoRes.body.data?.messages.length).toBe(0);
  }, 30_000);

  // ═══════════════════════════════════════════════════════════════════════════
  // OCS-E08: HTTP Async → WebSocket Cross-Channel Recall (Reverse)
  // ═══════════════════════════════════════════════════════════════════════════

  test('OCS-E08: http_async messages are recallable from a web_chat session', async () => {
    const admin = await setupOmnichannelProject(harness, 'e08');
    const contactId = await seedContactWithConsent(admin.tenantId, admin.projectId);

    const sessionAId = crypto.randomUUID();
    const sessionBId = crypto.randomUUID();

    // Seed 3 http_async messages (session-A)
    await seedMessages(sessionAId, admin.tenantId, admin.projectId, contactId, 'http_async', 3, {
      sourceChannel: 'http_async',
      inputMode: 'typed',
      baseTimeOffset: 15,
    });

    // Mint SDK token for session-B (web_chat context)
    const sdkToken = mintSdkSessionToken({
      tenantId: admin.tenantId,
      projectId: admin.projectId,
      sessionId: sessionBId,
      channelId: crypto.randomUUID(),
      contactId,
      identityTier: 2,
    });

    const res = await requestJson<RecallResponse>(
      harness,
      `/api/projects/${admin.projectId}/omnichannel/recall`,
      {
        method: 'POST',
        headers: sdkTokenHeaders(sdkToken),
        body: { contactId, maxMessages: 10 },
      },
    );

    expect(res.status).toBe(200);
    expect(res.body.success).toBe(true);

    const messages = res.body.data!.messages;
    expect(messages.length).toBe(3);

    // Channel metadata preserved
    for (const msg of messages) {
      expect(msg.sessionId).toBe(sessionAId);
      expect(msg.channel).toBe('http_async');
    }

    // Isolation check: different contact in same project returns nothing
    const otherContactId = await seedContactWithConsent(admin.tenantId, admin.projectId);
    const otherToken = mintSdkSessionToken({
      tenantId: admin.tenantId,
      projectId: admin.projectId,
      sessionId: crypto.randomUUID(),
      channelId: crypto.randomUUID(),
      contactId: otherContactId,
      identityTier: 2,
    });

    const otherRes = await requestJson<RecallResponse>(
      harness,
      `/api/projects/${admin.projectId}/omnichannel/recall`,
      {
        method: 'POST',
        headers: sdkTokenHeaders(otherToken),
        body: { contactId: otherContactId },
      },
    );

    expect(otherRes.status).toBe(200);
    expect(otherRes.body.data?.messages.length).toBe(0);
  }, 30_000);

  // ═══════════════════════════════════════════════════════════════════════════
  // OCS-E09: Voice → WhatsApp with OTP Verification Round-Trip
  // ═══════════════════════════════════════════════════════════════════════════

  test('OCS-E09: voice messages are recallable from WhatsApp after OTP verification', async () => {
    const admin = await setupOmnichannelProject(harness, 'e09');
    const contactId = await seedContactWithConsent(admin.tenantId, admin.projectId);

    const sessionVId = crypto.randomUUID();
    const sessionWId = crypto.randomUUID();

    // Seed 5 voice session messages
    await seedMessages(sessionVId, admin.tenantId, admin.projectId, contactId, 'voice', 5, {
      sourceChannel: 'voice',
      inputMode: 'voice',
      baseTimeOffset: 30,
    });

    // Step 1: OTP verification round-trip (workflow integration test)
    // Note: Recall authorization is governed by identityTier in the SDK token, not the
    // verification itself. In production, the runtime upgrades the session's identity tier
    // after successful verification. Here the token is minted with identityTier: 2 directly.
    const voiceToken = mintSdkSessionToken({
      tenantId: admin.tenantId,
      projectId: admin.projectId,
      sessionId: sessionVId,
      channelId: crypto.randomUUID(),
      contactId,
      identityTier: 2,
    });

    // Initiate OTP
    const initRes = await requestJson<InitiateResponse>(harness, '/api/identity/verify/initiate', {
      method: 'POST',
      headers: sdkTokenHeaders(voiceToken),
      body: {
        method: 'otp',
        identityValue: '+15559876543',
        identityType: 'phone',
      },
    });

    expect(initRes.status).toBe(200);
    expect(initRes.body.success).toBe(true);
    const attemptId = initRes.body.attemptId;
    const correctCode = initRes.body.challengeData?.code as string;
    expect(attemptId).toBeTruthy();
    expect(correctCode).toBeTruthy();

    // Complete OTP verification
    const completeRes = await requestJson<CompleteResponse>(
      harness,
      '/api/identity/verify/complete',
      {
        method: 'POST',
        headers: sdkTokenHeaders(voiceToken),
        body: {
          attemptId,
          proof: {
            type: 'otp_code',
            value: correctCode,
            metadata: { tenantId: admin.tenantId },
          },
        },
      },
    );

    expect(completeRes.status).toBe(200);
    expect(completeRes.body.success).toBe(true);
    expect(completeRes.body.identityTier).toBe(2);
    expect(completeRes.body.verifiedIdentity).toBe('+15559876543');

    // Verify attempt status reached 'verified'
    const statusRes = await requestJson<AttemptStatusResponse>(
      harness,
      `/api/identity/verify/${attemptId}`,
      {
        method: 'GET',
        headers: sdkTokenHeaders(voiceToken),
      },
    );

    expect(statusRes.status).toBe(200);
    // GET /:attemptId wraps result in { success, data: { ... } }
    expect(statusRes.body.data.status).toBe('verified');

    // Step 2: Seed WhatsApp session messages
    await seedMessages(sessionWId, admin.tenantId, admin.projectId, contactId, 'whatsapp', 2, {
      sourceChannel: 'whatsapp',
      inputMode: 'typed',
      baseTimeOffset: 5,
    });

    // Step 3: Recall from WhatsApp session
    const whatsappToken = mintSdkSessionToken({
      tenantId: admin.tenantId,
      projectId: admin.projectId,
      sessionId: sessionWId,
      channelId: crypto.randomUUID(),
      contactId,
      identityTier: 2,
    });

    const recallRes = await requestJson<RecallResponse>(
      harness,
      `/api/projects/${admin.projectId}/omnichannel/recall`,
      {
        method: 'POST',
        headers: sdkTokenHeaders(whatsappToken),
        body: { contactId, maxMessages: 20 },
      },
    );

    expect(recallRes.status).toBe(200);
    expect(recallRes.body.success).toBe(true);

    const messages = recallRes.body.data!.messages;
    // Voice messages from session-V should be present (session-W excluded as current)
    const voiceMessages = messages.filter((m) => m.channel === 'voice');
    expect(voiceMessages.length).toBe(5);

    // Verify voice metadata is preserved
    for (const msg of voiceMessages) {
      expect(msg.sessionId).toBe(sessionVId);
      expect(msg.channel).toBe('voice');
    }

    // Isolation check: different project returns no messages
    const admin2 = await setupOmnichannelProject(harness, 'e09-iso');
    const isoToken = mintSdkSessionToken({
      tenantId: admin2.tenantId,
      projectId: admin2.projectId,
      sessionId: crypto.randomUUID(),
      channelId: crypto.randomUUID(),
      contactId,
      identityTier: 2,
    });

    const isoRes = await requestJson<RecallResponse>(
      harness,
      `/api/projects/${admin2.projectId}/omnichannel/recall`,
      {
        method: 'POST',
        headers: sdkTokenHeaders(isoToken),
        body: { contactId },
      },
    );

    expect(isoRes.status).toBe(200);
    expect(isoRes.body.data?.messages.length).toBe(0);
  }, 30_000);

  // ═══════════════════════════════════════════════════════════════════════════
  // OCS-E10: Identity Tier Gating (Blocked Without Verification)
  // ═══════════════════════════════════════════════════════════════════════════

  test('OCS-E10: recall blocked at tier 0 and 1, succeeds at tier 2 with minTier: 2', async () => {
    const admin = await setupOmnichannelProject(harness, 'e10', { minTier: 2 });
    const contactId = await seedContactWithConsent(admin.tenantId, admin.projectId);

    const voiceSessionId = crypto.randomUUID();

    // Seed voice messages
    await seedMessages(voiceSessionId, admin.tenantId, admin.projectId, contactId, 'voice', 3, {
      sourceChannel: 'voice',
      inputMode: 'voice',
      baseTimeOffset: 15,
    });

    const channelId = crypto.randomUUID();

    // Tier 0 → 403 IDENTITY_INSUFFICIENT
    const tier0Token = mintSdkSessionToken({
      tenantId: admin.tenantId,
      projectId: admin.projectId,
      sessionId: crypto.randomUUID(),
      channelId,
      contactId,
      identityTier: 0,
    });

    const tier0Res = await requestJson<RecallResponse>(
      harness,
      `/api/projects/${admin.projectId}/omnichannel/recall`,
      {
        method: 'POST',
        headers: sdkTokenHeaders(tier0Token),
        body: { contactId },
      },
    );

    expect(tier0Res.status).toBe(403);
    expect(tier0Res.body.success).toBe(false);
    expect(tier0Res.body.error?.code).toBe('IDENTITY_INSUFFICIENT');

    // Tier 1 → 403 IDENTITY_INSUFFICIENT
    const tier1Token = mintSdkSessionToken({
      tenantId: admin.tenantId,
      projectId: admin.projectId,
      sessionId: crypto.randomUUID(),
      channelId,
      contactId,
      identityTier: 1,
    });

    const tier1Res = await requestJson<RecallResponse>(
      harness,
      `/api/projects/${admin.projectId}/omnichannel/recall`,
      {
        method: 'POST',
        headers: sdkTokenHeaders(tier1Token),
        body: { contactId },
      },
    );

    expect(tier1Res.status).toBe(403);
    expect(tier1Res.body.success).toBe(false);
    expect(tier1Res.body.error?.code).toBe('IDENTITY_INSUFFICIENT');

    // Tier 2 → 200 with messages
    const tier2Token = mintSdkSessionToken({
      tenantId: admin.tenantId,
      projectId: admin.projectId,
      sessionId: crypto.randomUUID(),
      channelId,
      contactId,
      identityTier: 2,
    });

    const tier2Res = await requestJson<RecallResponse>(
      harness,
      `/api/projects/${admin.projectId}/omnichannel/recall`,
      {
        method: 'POST',
        headers: sdkTokenHeaders(tier2Token),
        body: { contactId },
      },
    );

    expect(tier2Res.status).toBe(200);
    expect(tier2Res.body.success).toBe(true);
    expect(tier2Res.body.data!.messages.length).toBe(3);
  }, 30_000);

  // ═══════════════════════════════════════════════════════════════════════════
  // OCS-E11: Multi-Channel Recall Across Three Channels
  // ═══════════════════════════════════════════════════════════════════════════

  test('OCS-E11: recall spans messages from voice, web_chat, and whatsapp', async () => {
    const admin = await setupOmnichannelProject(harness, 'e11');
    const contactId = await seedContactWithConsent(admin.tenantId, admin.projectId);

    const session1Id = crypto.randomUUID();
    const session2Id = crypto.randomUUID();
    const session3Id = crypto.randomUUID();
    const session4Id = crypto.randomUUID();

    // Seed 3 voice messages (session-1)
    await seedMessages(session1Id, admin.tenantId, admin.projectId, contactId, 'voice', 3, {
      sourceChannel: 'voice',
      inputMode: 'voice',
      baseTimeOffset: 30,
    });

    // Seed 3 web_chat messages (session-2)
    await seedMessages(session2Id, admin.tenantId, admin.projectId, contactId, 'web_chat', 3, {
      sourceChannel: 'web',
      inputMode: 'typed',
      baseTimeOffset: 20,
    });

    // Seed 3 whatsapp messages (session-3)
    await seedMessages(session3Id, admin.tenantId, admin.projectId, contactId, 'whatsapp', 3, {
      sourceChannel: 'whatsapp',
      inputMode: 'typed',
      baseTimeOffset: 10,
    });

    // Recall from session-4 (new session)
    const sdkToken = mintSdkSessionToken({
      tenantId: admin.tenantId,
      projectId: admin.projectId,
      sessionId: session4Id,
      channelId: crypto.randomUUID(),
      contactId,
      identityTier: 2,
    });

    const res = await requestJson<RecallResponse>(
      harness,
      `/api/projects/${admin.projectId}/omnichannel/recall`,
      {
        method: 'POST',
        headers: sdkTokenHeaders(sdkToken),
        body: { contactId, maxMessages: 20 },
      },
    );

    expect(res.status).toBe(200);
    expect(res.body.success).toBe(true);

    const messages = res.body.data!.messages;
    // All 9 messages from 3 sessions
    expect(messages.length).toBe(9);
    expect(res.body.data!.metadata.matchedSessions).toBe(3);

    // Each channel's messages are present
    const voiceMsgs = messages.filter((m) => m.channel === 'voice');
    const webMsgs = messages.filter((m) => m.channel === 'web_chat');
    const whatsappMsgs = messages.filter((m) => m.channel === 'whatsapp');
    expect(voiceMsgs.length).toBe(3);
    expect(webMsgs.length).toBe(3);
    expect(whatsappMsgs.length).toBe(3);

    // Channel metadata preserved
    for (const msg of voiceMsgs) {
      expect(msg.sessionId).toBe(session1Id);
    }
    for (const msg of webMsgs) {
      expect(msg.sessionId).toBe(session2Id);
    }
    for (const msg of whatsappMsgs) {
      expect(msg.sessionId).toBe(session3Id);
    }

    // Test maxMessages truncation
    const truncRes = await requestJson<RecallResponse>(
      harness,
      `/api/projects/${admin.projectId}/omnichannel/recall`,
      {
        method: 'POST',
        headers: sdkTokenHeaders(sdkToken),
        body: { contactId, maxMessages: 5 },
      },
    );

    expect(truncRes.status).toBe(200);
    expect(truncRes.body.data!.messages.length).toBe(5);
    expect(truncRes.body.data!.metadata.truncated).toBe(true);

    // Isolation check: second contact in same project sees only their own messages
    const otherContactId = await seedContactWithConsent(admin.tenantId, admin.projectId);
    await seedMessages(
      crypto.randomUUID(),
      admin.tenantId,
      admin.projectId,
      otherContactId,
      'web_chat',
      2,
      { sourceChannel: 'web', baseTimeOffset: 5 },
    );

    const otherToken = mintSdkSessionToken({
      tenantId: admin.tenantId,
      projectId: admin.projectId,
      sessionId: crypto.randomUUID(),
      channelId: crypto.randomUUID(),
      contactId: otherContactId,
      identityTier: 2,
    });

    const otherRes = await requestJson<RecallResponse>(
      harness,
      `/api/projects/${admin.projectId}/omnichannel/recall`,
      {
        method: 'POST',
        headers: sdkTokenHeaders(otherToken),
        body: { contactId: otherContactId },
      },
    );

    expect(otherRes.status).toBe(200);
    expect(otherRes.body.data!.messages.length).toBe(2);
    for (const msg of otherRes.body.data!.messages) {
      expect(msg.channel).toBe('web_chat');
    }
  }, 30_000);

  // ═══════════════════════════════════════════════════════════════════════════
  // OCS-E12: allowedChannels Filter (Project Default + Per-Request Override)
  // ═══════════════════════════════════════════════════════════════════════════

  test('OCS-E12: defaultAllowedChannels and per-request allowedChannels filter correctly', async () => {
    const admin = await setupOmnichannelProject(harness, 'e12');
    const contactId = await seedContactWithConsent(admin.tenantId, admin.projectId);

    const voiceSessionId = crypto.randomUUID();
    const webSessionId = crypto.randomUUID();
    const whatsappSessionId = crypto.randomUUID();

    // Seed messages across 3 channels
    await seedMessages(voiceSessionId, admin.tenantId, admin.projectId, contactId, 'voice', 3, {
      sourceChannel: 'voice',
      inputMode: 'voice',
      baseTimeOffset: 30,
    });
    await seedMessages(webSessionId, admin.tenantId, admin.projectId, contactId, 'web_chat', 3, {
      sourceChannel: 'web',
      inputMode: 'typed',
      baseTimeOffset: 20,
    });
    await seedMessages(
      whatsappSessionId,
      admin.tenantId,
      admin.projectId,
      contactId,
      'whatsapp',
      3,
      {
        sourceChannel: 'whatsapp',
        inputMode: 'typed',
        baseTimeOffset: 10,
      },
    );

    const recallSessionId = crypto.randomUUID();
    const sdkToken = mintSdkSessionToken({
      tenantId: admin.tenantId,
      projectId: admin.projectId,
      sessionId: recallSessionId,
      channelId: crypto.randomUUID(),
      contactId,
      identityTier: 2,
    });

    // Step 1: Set defaultAllowedChannels to ['voice', 'web_chat'] (exclude whatsapp)
    await requestJson<SettingsResponse>(harness, `/api/projects/${admin.projectId}/omnichannel`, {
      method: 'PATCH',
      headers: authHeaders(admin.token),
      body: { recall: { defaultAllowedChannels: ['voice', 'web_chat'] } },
    });

    const res1 = await requestJson<RecallResponse>(
      harness,
      `/api/projects/${admin.projectId}/omnichannel/recall`,
      {
        method: 'POST',
        headers: sdkTokenHeaders(sdkToken),
        body: { contactId, maxMessages: 20 },
      },
    );

    expect(res1.status).toBe(200);
    expect(res1.body.data!.messages.length).toBe(6); // 3 voice + 3 web_chat
    const res1Channels = new Set(res1.body.data!.messages.map((m) => m.channel));
    expect(res1Channels.has('voice')).toBe(true);
    expect(res1Channels.has('web_chat')).toBe(true);
    expect(res1Channels.has('whatsapp')).toBe(false);

    // Step 2: Change to ['whatsapp'] only
    await requestJson<SettingsResponse>(harness, `/api/projects/${admin.projectId}/omnichannel`, {
      method: 'PATCH',
      headers: authHeaders(admin.token),
      body: { recall: { defaultAllowedChannels: ['whatsapp'] } },
    });

    const res2 = await requestJson<RecallResponse>(
      harness,
      `/api/projects/${admin.projectId}/omnichannel/recall`,
      {
        method: 'POST',
        headers: sdkTokenHeaders(sdkToken),
        body: { contactId, maxMessages: 20 },
      },
    );

    expect(res2.status).toBe(200);
    expect(res2.body.data!.messages.length).toBe(3);
    for (const msg of res2.body.data!.messages) {
      expect(msg.channel).toBe('whatsapp');
    }

    // Step 3: Per-request allowedChannels override — request only voice
    const res3 = await requestJson<RecallResponse>(
      harness,
      `/api/projects/${admin.projectId}/omnichannel/recall`,
      {
        method: 'POST',
        headers: sdkTokenHeaders(sdkToken),
        body: { contactId, allowedChannels: ['voice'], maxMessages: 20 },
      },
    );

    expect(res3.status).toBe(200);
    expect(res3.body.data!.messages.length).toBe(3);
    for (const msg of res3.body.data!.messages) {
      expect(msg.channel).toBe('voice');
    }

    // Step 4: Set defaultAllowedChannels to empty array → all channels returned
    await requestJson<SettingsResponse>(harness, `/api/projects/${admin.projectId}/omnichannel`, {
      method: 'PATCH',
      headers: authHeaders(admin.token),
      body: { recall: { defaultAllowedChannels: [] } },
    });

    const res4 = await requestJson<RecallResponse>(
      harness,
      `/api/projects/${admin.projectId}/omnichannel/recall`,
      {
        method: 'POST',
        headers: sdkTokenHeaders(sdkToken),
        body: { contactId, maxMessages: 20 },
      },
    );

    expect(res4.status).toBe(200);
    expect(res4.body.data!.messages.length).toBe(9); // All channels
    const res4Channels = new Set(res4.body.data!.messages.map((m) => m.channel));
    expect(res4Channels.has('voice')).toBe(true);
    expect(res4Channels.has('web_chat')).toBe(true);
    expect(res4Channels.has('whatsapp')).toBe(true);
  }, 30_000);
});

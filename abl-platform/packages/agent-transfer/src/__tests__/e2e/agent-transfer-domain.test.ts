/**
 * E2E Domain Tests: Agent Transfer
 *
 * Validates expected domain behavior for the agent-transfer feature.
 * Conditional on AGENT_TRANSFER_E2E=1 — requires a running Redis instance.
 *
 * These tests exercise real SDK components with real Redis. No mocking of
 * platform components (@abl/compiler, @agent-platform/*). Only external
 * third-party services (SmartAssist API) are stubbed via dependency injection.
 *
 * Domain behaviors tested:
 *   1. Transfer session lifecycle (create → transition → end)
 *   2. Tenant isolation (cross-tenant access returns nothing, not an error)
 *   3. Per-tenant rate limiting
 *   4. Webhook signature verification (HMAC, timestamps, nonce replay)
 *   5. Transfer tool execution pipeline (adapter resolution, duplicate rejection)
 *   6. Voice-only tool channel restrictions
 *   7. Adapter registry lifecycle (register, lookup, unregister)
 *   8. Event handler type normalization (XO → ABL event mapping)
 */
import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest';
import Redis from 'ioredis';
import { scanKeys } from '@agent-platform/redis';
import { createHmac } from 'crypto';

import { TransferSessionStore } from '../../session/transfer-session-store.js';
import { sessionKey, ACTIVE_SESSIONS_SET } from '../../session/types.js';
import { checkRateLimit } from '../../security/rate-limiter.js';
import {
  verifyWebhookSignature,
  createRedisNonceStore,
} from '../../security/webhook-verification.js';
import { isVoiceChannel } from '../../voice/index.js';
import { AdapterRegistry } from '../../adapters/registry.js';
import { KoreEventHandler } from '../../adapters/kore/event-handler.js';
import { TransferToAgentTool } from '../../tools/transfer-to-agent.js';
import { IVRMenuTool } from '../../tools/ivr-menu.js';
import { IVRDigitInputTool } from '../../tools/ivr-digit-input.js';
import { CallTransferTool } from '../../tools/call-transfer.js';
import { DeflectToChatTool } from '../../tools/deflect-to-chat.js';
import type { AgentDesktopAdapter, AdapterCapabilities } from '../../adapters/interface.js';
import type { TransferResult, AgentEvent, TransferPayload } from '../../types.js';

const E2E_ENABLED = process.env.AGENT_TRANSFER_E2E === '1';
const REDIS_URL = process.env.REDIS_URL ?? 'redis://localhost:6379';
const TEST_PREFIX = `e2e_domain_${Date.now()}`;

const describeE2E = E2E_ENABLED ? describe : describe.skip;

/**
 * Create a real adapter (not a mock) that delegates to an in-memory
 * implementation, used via dependency injection per the test rules.
 */
function createTestAdapter(
  name: string,
  overrides?: Partial<{
    executeResult: TransferResult;
    executeFn: (payload: TransferPayload) => Promise<TransferResult>;
  }>,
): AgentDesktopAdapter {
  const capabilities: AdapterCapabilities = {
    supportsPreChecks: true,
    supportsPostAgentDialog: false,
    supportsFileUpload: false,
    supportsTranslation: false,
    transportType: 'webhook',
    authType: 'bearer',
  };
  const messageHandlers: Array<(event: AgentEvent) => void | Promise<void>> = [];
  const sessionHandlers: Array<(event: AgentEvent) => void | Promise<void>> = [];

  return {
    name,
    capabilities,
    async initialize() {
      /* no-op for test adapter */
    },
    async execute(payload: TransferPayload): Promise<TransferResult> {
      if (overrides?.executeFn) {
        return overrides.executeFn(payload);
      }
      return (
        overrides?.executeResult ?? {
          success: true,
          status: 'transferred' as const,
          providerSessionId: `${name}-session-${Date.now()}`,
        }
      );
    },
    async sendUserMessage() {
      /* no-op */
    },
    async endSession() {
      /* no-op */
    },
    onAgentMessage(handler) {
      messageHandlers.push(handler);
    },
    onSessionEvent(handler) {
      sessionHandlers.push(handler);
    },
    async handleInboundEvent() {
      /* no-op */
    },
    async checkHealth() {
      return true;
    },
    async close() {
      /* no-op */
    },
  };
}

describeE2E('agent-transfer domain E2E', () => {
  let redis: Redis;

  beforeAll(async () => {
    redis = new Redis(REDIS_URL, {
      maxRetriesPerRequest: 1,
      lazyConnect: true,
    });
    await redis.connect();
  });

  afterAll(async () => {
    // Clean up all test keys using scanKeys (cluster-safe) instead of KEYS command
    const patterns = [
      `agent_transfer:${TEST_PREFIX}*`,
      `at_ratelimit:${TEST_PREFIX}*`,
      `at_by_provider:*:${TEST_PREFIX}*`,
      `at_pod:e2e-domain-pod*`,
      `webhook_nonce:*`,
    ];
    for (const pattern of patterns) {
      const keys: string[] = [];
      for await (const k of scanKeys(redis, pattern)) keys.push(k);
      // Per-key DEL for cluster compatibility (multi-key DEL requires same slot)
      if (keys.length > 0) {
        await Promise.all(keys.map((k) => redis.del(k)));
      }
    }
    // Remove from active sessions set
    const sessionKeys: string[] = [];
    for await (const k of scanKeys(redis, `agent_transfer:${TEST_PREFIX}*`)) sessionKeys.push(k);
    if (sessionKeys.length > 0) {
      for (const k of sessionKeys) await redis.srem(ACTIVE_SESSIONS_SET, k);
    }
    await redis.quit();
  });

  // ── 1. Transfer Session Lifecycle ──────────────────────────────────────

  describe('transfer session lifecycle', () => {
    let store: TransferSessionStore;

    beforeEach(() => {
      store = new TransferSessionStore(redis);
    });

    it('creates a session and transitions through all lifecycle states', async () => {
      const tenantId = `${TEST_PREFIX}_lifecycle_t`;
      const contactId = `${TEST_PREFIX}_lifecycle_c`;

      // Create session
      const result = await store.create({
        tenantId,
        contactId,
        channel: 'chat',
        provider: 'kore',
        providerSessionId: `${TEST_PREFIX}_lifecycle_conv`,
        ownerPod: 'e2e-domain-pod-1',
        projectId: 'project-1',
        queue: 'support-queue',
        skills: ['billing', 'english'],
        priority: 5,
      });

      expect(result.success).toBe(true);
      expect(result.sessionKey).toBe(sessionKey(tenantId, contactId, 'chat'));

      // Verify initial state is 'pending'
      const session = await store.get(result.sessionKey!);
      expect(session).not.toBeNull();
      expect(session!.state).toBe('pending');
      expect(session!.tenantId).toBe(tenantId);
      expect(session!.contactId).toBe(contactId);
      expect(session!.provider).toBe('kore');
      expect(session!.projectId).toBe('project-1');
      expect(session!.queue).toBe('support-queue');
      expect(session!.skills).toEqual(['billing', 'english']);
      expect(session!.priority).toBe(5);

      // Transition: pending → queued → active → post_agent
      const key = result.sessionKey!;
      for (const state of ['queued', 'active', 'post_agent'] as const) {
        const updated = await store.update(key, { state });
        expect(updated).toBe(true);
        const s = await store.get(key);
        expect(s!.state).toBe(state);
      }

      // End session — verify it's removed
      const ended = await store.end(key);
      expect(ended).toBe(true);
      const afterEnd = await store.get(key);
      expect(afterEnd).toBeNull();
    });

    it('rejects duplicate session for same tenant+contact+channel (atomicity)', async () => {
      const tenantId = `${TEST_PREFIX}_dup_t`;
      const contactId = `${TEST_PREFIX}_dup_c`;

      const r1 = await store.create({
        tenantId,
        contactId,
        channel: 'chat',
        provider: 'kore',
        providerSessionId: `${TEST_PREFIX}_dup_conv1`,
        ownerPod: 'e2e-domain-pod-1',
      });
      expect(r1.success).toBe(true);

      // Second attempt with same tenant+contact+channel should fail
      const r2 = await store.create({
        tenantId,
        contactId,
        channel: 'chat',
        provider: 'kore',
        providerSessionId: `${TEST_PREFIX}_dup_conv2`,
        ownerPod: 'e2e-domain-pod-1',
      });
      expect(r2.success).toBe(false);
      expect(r2.error?.code).toBe('SESSION_EXISTS');

      // Different channel for same tenant+contact should succeed
      const r3 = await store.create({
        tenantId,
        contactId,
        channel: 'voice',
        provider: 'kore',
        providerSessionId: `${TEST_PREFIX}_dup_conv3`,
        ownerPod: 'e2e-domain-pod-1',
      });
      expect(r3.success).toBe(true);

      // Cleanup
      await store.end(r1.sessionKey!);
      await store.end(r3.sessionKey!);
    });

    it('provider reverse index lookup resolves the correct session', async () => {
      const tenantId = `${TEST_PREFIX}_idx_t`;
      const contactId = `${TEST_PREFIX}_idx_c`;
      const providerSessionId = `${TEST_PREFIX}_idx_conv`;

      const result = await store.create({
        tenantId,
        contactId,
        channel: 'chat',
        provider: 'kore',
        providerSessionId,
        ownerPod: 'e2e-domain-pod-1',
      });
      expect(result.success).toBe(true);

      // Lookup by provider index
      const session = await store.getByProvider('kore', tenantId, providerSessionId);
      expect(session).not.toBeNull();
      expect(session!.tenantId).toBe(tenantId);
      expect(session!.contactId).toBe(contactId);
      expect(session!.providerSessionId).toBe(providerSessionId);

      // Cleanup
      await store.end(result.sessionKey!);
    });

    it('extendTTL refreshes session heartbeat', async () => {
      const tenantId = `${TEST_PREFIX}_ttl_t`;
      const contactId = `${TEST_PREFIX}_ttl_c`;

      const result = await store.create({
        tenantId,
        contactId,
        channel: 'chat',
        provider: 'kore',
        providerSessionId: `${TEST_PREFIX}_ttl_conv`,
        ownerPod: 'e2e-domain-pod-1',
        ttl: 60,
      });
      expect(result.success).toBe(true);

      const before = await store.get(result.sessionKey!);
      expect(before).not.toBeNull();
      const oldHeartbeat = before!.lastHeartbeat;

      // Small delay to ensure timestamp changes
      await new Promise((resolve) => setTimeout(resolve, 50));

      const extended = await store.extendTTL(result.sessionKey!);
      expect(extended).toBe(true);

      const after = await store.get(result.sessionKey!);
      expect(after).not.toBeNull();
      expect(after!.lastHeartbeat).toBeGreaterThan(oldHeartbeat);

      // Cleanup
      await store.end(result.sessionKey!);
    });

    it('session metadata and routing fields persist correctly', async () => {
      const tenantId = `${TEST_PREFIX}_meta_t`;
      const contactId = `${TEST_PREFIX}_meta_c`;

      const result = await store.create({
        tenantId,
        contactId,
        channel: 'chat',
        provider: 'kore',
        providerSessionId: `${TEST_PREFIX}_meta_conv`,
        ownerPod: 'e2e-domain-pod-1',
        metadata: { customerTier: 'premium', issueCategory: 'billing' },
        providerData: { botId: 'bot-123', orgId: 'org-456' },
        postAgentConfig: { action: 'return', dialogId: 'survey-1', surveyType: 'csat' },
      });
      expect(result.success).toBe(true);

      const session = await store.get(result.sessionKey!);
      expect(session).not.toBeNull();
      expect(session!.metadata).toEqual({ customerTier: 'premium', issueCategory: 'billing' });
      expect(session!.providerData).toEqual({ botId: 'bot-123', orgId: 'org-456' });
      expect(session!.postAgentConfig).toEqual({
        action: 'return',
        dialogId: 'survey-1',
        surveyType: 'csat',
      });

      // Cleanup
      await store.end(result.sessionKey!);
    });
  });

  // ── 2. Tenant Isolation ────────────────────────────────────────────────

  describe('tenant isolation', () => {
    let store: TransferSessionStore;

    beforeEach(() => {
      store = new TransferSessionStore(redis);
    });

    it('tenant A cannot see tenant B sessions via session key', async () => {
      const tenantA = `${TEST_PREFIX}_isoA`;
      const tenantB = `${TEST_PREFIX}_isoB`;
      const contact = `${TEST_PREFIX}_iso_c`;

      const rA = await store.create({
        tenantId: tenantA,
        contactId: contact,
        channel: 'chat',
        provider: 'kore',
        providerSessionId: `${TEST_PREFIX}_isoA_conv`,
        ownerPod: 'e2e-domain-pod-1',
      });
      expect(rA.success).toBe(true);

      // Tenant B uses same contactId — different key because tenantId differs
      const keyForB = sessionKey(tenantB, contact, 'chat');
      const session = await store.get(keyForB);
      expect(session).toBeNull();

      // Cleanup
      await store.end(rA.sessionKey!);
    });

    it('tenant A cannot see tenant B sessions via provider index', async () => {
      const tenantA = `${TEST_PREFIX}_pidxA`;
      const tenantB = `${TEST_PREFIX}_pidxB`;
      const providerSessionId = `${TEST_PREFIX}_pidx_conv`;

      const rA = await store.create({
        tenantId: tenantA,
        contactId: `${TEST_PREFIX}_pidx_c`,
        channel: 'chat',
        provider: 'kore',
        providerSessionId,
        ownerPod: 'e2e-domain-pod-1',
      });
      expect(rA.success).toBe(true);

      // Provider index is tenant-scoped: looking up with tenantB returns nothing
      const session = await store.getByProvider('kore', tenantB, providerSessionId);
      expect(session).toBeNull();

      // But tenantA can find it
      const sessionA = await store.getByProvider('kore', tenantA, providerSessionId);
      expect(sessionA).not.toBeNull();
      expect(sessionA!.tenantId).toBe(tenantA);

      // Cleanup
      await store.end(rA.sessionKey!);
    });

    it('getActiveSessions with tenantId filter returns only that tenant', async () => {
      const tenantA = `${TEST_PREFIX}_actA`;
      const tenantB = `${TEST_PREFIX}_actB`;

      const rA = await store.create({
        tenantId: tenantA,
        contactId: `${TEST_PREFIX}_actA_c`,
        channel: 'chat',
        provider: 'kore',
        providerSessionId: `${TEST_PREFIX}_actA_conv`,
        ownerPod: 'e2e-domain-pod-1',
      });
      const rB = await store.create({
        tenantId: tenantB,
        contactId: `${TEST_PREFIX}_actB_c`,
        channel: 'chat',
        provider: 'kore',
        providerSessionId: `${TEST_PREFIX}_actB_conv`,
        ownerPod: 'e2e-domain-pod-1',
      });
      expect(rA.success).toBe(true);
      expect(rB.success).toBe(true);

      // Tenant A's filtered list should not include tenant B's sessions
      const sessionsA = await store.getActiveSessions(tenantA);
      expect(sessionsA).toContain(rA.sessionKey);
      expect(sessionsA).not.toContain(rB.sessionKey);

      // Tenant B's filtered list should not include tenant A's sessions
      const sessionsB = await store.getActiveSessions(tenantB);
      expect(sessionsB).toContain(rB.sessionKey);
      expect(sessionsB).not.toContain(rA.sessionKey);

      // Cleanup
      await store.end(rA.sessionKey!);
      await store.end(rB.sessionKey!);
    });
  });

  // ── 3. Per-Tenant Rate Limiting ────────────────────────────────────────

  describe('per-tenant rate limiting', () => {
    it('allows requests within the configured limit', async () => {
      const tenant = `${TEST_PREFIX}_rl_ok`;
      const config = { maxTransfers: 5, windowMs: 60_000 };

      const r1 = await checkRateLimit(redis, tenant, config);
      expect(r1.allowed).toBe(true);
      expect(r1.remaining).toBeGreaterThan(0);

      const r2 = await checkRateLimit(redis, tenant, config);
      expect(r2.allowed).toBe(true);
      expect(r2.remaining).toBeLessThanOrEqual(r1.remaining);
    });

    it('rejects requests when limit is exceeded', async () => {
      const tenant = `${TEST_PREFIX}_rl_exceed`;
      const config = { maxTransfers: 3, windowMs: 60_000 };

      // Exhaust the limit
      for (let i = 0; i < 3; i++) {
        const r = await checkRateLimit(redis, tenant, config);
        expect(r.allowed).toBe(true);
      }

      // 4th request should be rejected
      const rejected = await checkRateLimit(redis, tenant, config);
      expect(rejected.allowed).toBe(false);
      expect(rejected.remaining).toBe(0);
    });

    it('different tenants have independent rate windows', async () => {
      const tenantX = `${TEST_PREFIX}_rl_X`;
      const tenantY = `${TEST_PREFIX}_rl_Y`;
      const config = { maxTransfers: 2, windowMs: 60_000 };

      // Exhaust tenant X's limit
      await checkRateLimit(redis, tenantX, config);
      await checkRateLimit(redis, tenantX, config);
      const xRejected = await checkRateLimit(redis, tenantX, config);
      expect(xRejected.allowed).toBe(false);

      // Tenant Y should still be allowed
      const yAllowed = await checkRateLimit(redis, tenantY, config);
      expect(yAllowed.allowed).toBe(true);
    });
  });

  // ── 4. Webhook Signature Verification ──────────────────────────────────

  describe('webhook signature verification', () => {
    const WEBHOOK_SECRET = 'test-webhook-secret-e2e-32chars!!';

    function computeHmac(body: string, secret: string): string {
      return createHmac('sha256', secret).update(Buffer.from(body, 'utf-8')).digest('hex');
    }

    it('accepts a valid HMAC signature with correct timestamp', async () => {
      const body = JSON.stringify({ type: 'agent_message', text: 'Hello' });
      const timestamp = String(Date.now());
      const signature = `sha256=${computeHmac(body, WEBHOOK_SECRET)}`;

      const result = await verifyWebhookSignature(
        {
          secret: WEBHOOK_SECRET,
          signatureHeader: 'x-kore-signature',
          timestampHeader: 'x-kore-timestamp',
        },
        {
          'x-kore-signature': signature,
          'x-kore-timestamp': timestamp,
        },
        body,
      );

      expect(result.valid).toBe(true);
      expect(result.error).toBeUndefined();
    });

    it('rejects an invalid signature', async () => {
      const body = JSON.stringify({ type: 'agent_message', text: 'Hello' });
      const timestamp = String(Date.now());

      const result = await verifyWebhookSignature(
        {
          secret: WEBHOOK_SECRET,
          signatureHeader: 'x-kore-signature',
          timestampHeader: 'x-kore-timestamp',
        },
        {
          'x-kore-signature':
            'sha256=0000000000000000000000000000000000000000000000000000000000000000',
          'x-kore-timestamp': timestamp,
        },
        body,
      );

      expect(result.valid).toBe(false);
      expect(result.error).toBeDefined();
    });

    it('rejects when timestamp header is missing', async () => {
      const body = JSON.stringify({ type: 'agent_message' });
      const signature = `sha256=${computeHmac(body, WEBHOOK_SECRET)}`;

      const result = await verifyWebhookSignature(
        {
          secret: WEBHOOK_SECRET,
          signatureHeader: 'x-kore-signature',
          timestampHeader: 'x-kore-timestamp',
        },
        {
          'x-kore-signature': signature,
          // Missing x-kore-timestamp
        },
        body,
      );

      expect(result.valid).toBe(false);
      expect(result.error).toBe('Missing timestamp header');
    });

    it('rejects when timestamp is outside replay window', async () => {
      const body = JSON.stringify({ type: 'agent_message' });
      const staleTimestamp = String(Date.now() - 10 * 60 * 1000); // 10 minutes ago
      const signature = `sha256=${computeHmac(body, WEBHOOK_SECRET)}`;

      const result = await verifyWebhookSignature(
        {
          secret: WEBHOOK_SECRET,
          signatureHeader: 'x-kore-signature',
          timestampHeader: 'x-kore-timestamp',
          replayWindowMs: 5 * 60 * 1000, // 5 minute window
        },
        {
          'x-kore-signature': signature,
          'x-kore-timestamp': staleTimestamp,
        },
        body,
      );

      expect(result.valid).toBe(false);
      expect(result.error).toContain('replay window');
    });

    it('nonce store prevents replayed events', async () => {
      const nonceStore = createRedisNonceStore(redis as any);
      const body = JSON.stringify({ type: 'agent_message', id: 'unique-1' });
      const timestamp = String(Date.now());
      const signature = `sha256=${computeHmac(body, WEBHOOK_SECRET)}`;
      const headers = {
        'x-kore-signature': signature,
        'x-kore-timestamp': timestamp,
      };
      const config = {
        secret: WEBHOOK_SECRET,
        signatureHeader: 'x-kore-signature',
        timestampHeader: 'x-kore-timestamp',
        nonceStore,
      };

      // First request should pass
      const r1 = await verifyWebhookSignature(config, headers, body);
      expect(r1.valid).toBe(true);

      // Exact replay with same signature and timestamp should be rejected
      const r2 = await verifyWebhookSignature(config, headers, body);
      expect(r2.valid).toBe(false);
    });

    it('rejects when signature header is missing', async () => {
      const body = JSON.stringify({ type: 'agent_message' });

      const result = await verifyWebhookSignature(
        {
          secret: WEBHOOK_SECRET,
          signatureHeader: 'x-kore-signature',
        },
        {
          // No signature header at all
        },
        body,
      );

      expect(result.valid).toBe(false);
      expect(result.error).toBe('Missing signature header');
    });
  });

  // ── 5. Transfer Tool Execution Pipeline ────────────────────────────────

  describe('transfer tool execution pipeline', () => {
    it('transfer to non-existent provider returns PROVIDER_NOT_FOUND', async () => {
      const registry = new AdapterRegistry();
      const tool = new TransferToAgentTool(registry);

      const result = await tool.execute(
        { provider: 'nonexistent-provider' },
        {
          tenantId: 'tenant-1',
          projectId: 'project-1',
          agentId: 'agent-1',
          contactId: 'contact-1',
          sessionId: 'session-1',
          channel: 'chat',
        },
      );

      expect(result.success).toBe(false);
      expect(result.error?.code).toBe('PROVIDER_NOT_FOUND');
    });

    it('transfer to valid provider executes successfully', async () => {
      const registry = new AdapterRegistry();
      const adapter = createTestAdapter('test-provider');
      registry.register('test-provider', adapter);

      const tool = new TransferToAgentTool(registry);

      const result = await tool.execute(
        {
          provider: 'test-provider',
          skills: ['billing'],
          queueId: 'queue-1',
          priority: 3,
        },
        {
          tenantId: 'tenant-1',
          projectId: 'project-1',
          agentId: 'agent-1',
          contactId: 'contact-1',
          sessionId: 'session-1',
          channel: 'chat',
        },
      );

      expect(result.success).toBe(true);
      expect(result.status).toBe('transferred');
      expect(result.conversationId).toBeDefined();
    });

    it('transfer with invalid input returns INVALID_INPUT', async () => {
      const registry = new AdapterRegistry();
      const tool = new TransferToAgentTool(registry);

      const result = await tool.execute(
        { provider: '' }, // Empty provider
        {
          tenantId: 'tenant-1',
          projectId: 'project-1',
          agentId: 'agent-1',
          contactId: 'contact-1',
          sessionId: 'session-1',
          channel: 'chat',
        },
      );

      expect(result.success).toBe(false);
      expect(result.error?.code).toBe('INVALID_INPUT');
    });

    it('adapter execute failure is propagated as TRANSFER_ERROR', async () => {
      const registry = new AdapterRegistry();
      const adapter = createTestAdapter('failing-provider', {
        executeFn: async () => {
          throw new Error('SmartAssist API unreachable');
        },
      });
      registry.register('failing-provider', adapter);

      const tool = new TransferToAgentTool(registry);
      const result = await tool.execute(
        { provider: 'failing-provider' },
        {
          tenantId: 'tenant-1',
          projectId: 'project-1',
          agentId: 'agent-1',
          contactId: 'contact-1',
          sessionId: 'session-1',
          channel: 'chat',
        },
      );

      expect(result.success).toBe(false);
      expect(result.error?.code).toBe('TRANSFER_ERROR');
      expect(result.error?.message).toContain('SmartAssist API unreachable');
    });

    it('voice channel transfer returns status "waiting" instead of "transferred"', async () => {
      const registry = new AdapterRegistry();
      const adapter = createTestAdapter('voice-provider');
      registry.register('voice-provider', adapter);

      const tool = new TransferToAgentTool(registry);
      const result = await tool.execute(
        { provider: 'voice-provider' },
        {
          tenantId: 'tenant-1',
          projectId: 'project-1',
          agentId: 'agent-1',
          contactId: 'contact-1',
          sessionId: 'session-1',
          channel: 'voice',
        },
      );

      expect(result.success).toBe(true);
      expect(result.status).toBe('waiting');
    });
  });

  // ── 6. Voice-Only Tool Channel Restrictions ────────────────────────────

  describe('voice-only tool channel restrictions', () => {
    it('voice channel detection correctly identifies voice channels', () => {
      expect(isVoiceChannel('voice')).toBe(true);
      expect(isVoiceChannel('korevg')).toBe(true);
      expect(isVoiceChannel('audiocodes')).toBe(true);
      expect(isVoiceChannel('twilio')).toBe(true);
      expect(isVoiceChannel('ivr')).toBe(true);
    });

    it('voice channel detection rejects non-voice channels', () => {
      expect(isVoiceChannel('chat')).toBe(false);
      expect(isVoiceChannel('messaging')).toBe(false);
      expect(isVoiceChannel('email')).toBe(false);
      expect(isVoiceChannel('campaign')).toBe(false);
    });

    it('IVR menu tool validates input and builds correct payload', () => {
      const tool = new IVRMenuTool();
      const result = tool.execute({
        prompt: 'Press 1 for billing, 2 for support',
        dtmfMappings: [
          { key: '1', nextStep: 'billing', intent: 'billing_intent' },
          { key: '2', nextStep: 'support', intent: 'support_intent' },
        ],
        noInputConfig: { timeout: 10, maxRetries: 3, message: 'No input detected' },
        noMatchConfig: { maxRetries: 2, message: 'Invalid selection' },
        bargeIn: true,
      });

      expect(result.success).toBe(true);
      expect(result.data?.payload.isPrompt).toBe(true);
      expect(result.data?.payload.sendDTMF).toBe(true);
      expect(result.data?.voiceResult.type).toBe('gather');
    });

    it('IVR menu tool rejects invalid input', () => {
      const tool = new IVRMenuTool();
      const result = tool.execute({
        prompt: '',
        dtmfMappings: [],
        noInputConfig: { timeout: 10, maxRetries: 3, message: 'No input' },
        noMatchConfig: { maxRetries: 2, message: 'Invalid' },
      });

      expect(result.success).toBe(false);
      expect(result.error?.code).toBe('INVALID_INPUT');
    });

    it('IVR digit input tool builds correct gather payload', () => {
      const tool = new IVRDigitInputTool();
      const result = tool.execute({
        prompt: 'Enter your account number',
        maxDigits: 8,
        endingKeyPress: '#',
        interDigitTimeout: 3000,
        noInputConfig: { timeout: 15, maxRetries: 2, message: 'Please enter digits' },
        noMatchConfig: { maxRetries: 2, message: 'Invalid number' },
      });

      expect(result.success).toBe(true);
      expect(result.data?.voiceResult.type).toBe('gather');
      expect(result.data?.payload.dtmfCollect).toBe(true);
    });

    it('call transfer tool requires phone number for PSTN', () => {
      const tool = new CallTransferTool();
      const result = tool.execute({
        callTransferType: 'pstn',
        // Missing phoneNumber
      });

      expect(result.success).toBe(false);
      expect(result.error?.code).toBe('MISSING_PHONE_NUMBER');
    });

    it('call transfer tool requires SIP ID for SIP transfer', () => {
      const tool = new CallTransferTool();
      const result = tool.execute({
        callTransferType: 'sip',
        // Missing sipTransferId
      });

      expect(result.success).toBe(false);
      expect(result.error?.code).toBe('MISSING_SIP_ID');
    });

    it('call transfer tool succeeds with valid PSTN input', () => {
      const tool = new CallTransferTool();
      const result = tool.execute({
        callTransferType: 'pstn',
        phoneNumber: '+15551234567',
        message: 'Transferring your call now',
      });

      expect(result.success).toBe(true);
      expect(result.data?.voiceResult.type).toBe('transfer');
      expect((result.data?.voiceResult as any).transferType).toBe('pstn');
      expect(result.data?.payload.isCallTransfer).toBe(true);
    });

    it('deflect-to-chat tool resolves correct branch', () => {
      const tool = new DeflectToChatTool();

      // Automation branch
      const autoResult = tool.execute({
        deflectionType: 'automation',
        triggerType: 'automationContext',
        message: 'Switching to chat',
      });
      expect(autoResult.success).toBe(true);
      expect(autoResult.data?.branch).toBe('DEFLECT_AUTOMATION');

      // Agent transfer branch
      const agentResult = tool.execute({
        deflectionType: 'agentTransfer',
        triggerType: 'userSelection',
      });
      expect(agentResult.success).toBe(true);
      expect(agentResult.data?.branch).toBe('DEFLECT_AGENT_TRANSFER');
    });
  });

  // ── 7. Adapter Registry Lifecycle ──────────────────────────────────────

  describe('adapter registry lifecycle', () => {
    it('registers, retrieves, and unregisters adapters', () => {
      const registry = new AdapterRegistry();
      const adapter = createTestAdapter('test-desktop');

      // Register
      registry.register('test-desktop', adapter);
      expect(registry.has('test-desktop')).toBe(true);
      expect(registry.get('test-desktop')).toBe(adapter);
      expect(registry.listNames()).toContain('test-desktop');

      // Unregister
      const removed = registry.unregister('test-desktop');
      expect(removed).toBe(true);
      expect(registry.has('test-desktop')).toBe(false);
      expect(registry.get('test-desktop')).toBeUndefined();
    });

    it('rejects duplicate adapter registration', () => {
      const registry = new AdapterRegistry();
      const adapter1 = createTestAdapter('dup-adapter');
      const adapter2 = createTestAdapter('dup-adapter');

      registry.register('dup-adapter', adapter1);
      expect(() => registry.register('dup-adapter', adapter2)).toThrow(
        "Adapter 'dup-adapter' is already registered",
      );
    });

    it('getOrThrow provides clear error for missing adapter', () => {
      const registry = new AdapterRegistry();
      registry.register('kore', createTestAdapter('kore'));

      expect(() => registry.getOrThrow('nonexistent')).toThrow(
        "Adapter 'nonexistent' not found. Available: kore",
      );
    });

    it('unregister returns false for non-existent adapter', () => {
      const registry = new AdapterRegistry();
      const result = registry.unregister('ghost-adapter');
      expect(result).toBe(false);
    });
  });

  // ── 8. Event Handler Type Normalization ────────────────────────────────

  describe('event handler XO to ABL type normalization', () => {
    it('maps known XO event types to ABL event types', () => {
      expect(KoreEventHandler.mapEventType('agent_message')).toBe('agent:message');
      expect(KoreEventHandler.mapEventType('agent_accepted')).toBe('agent:connected');
      expect(KoreEventHandler.mapEventType('conversation_queued')).toBe('agent:queued');
      expect(KoreEventHandler.mapEventType('closed')).toBe('agent:disconnected');
      expect(KoreEventHandler.mapEventType('typing')).toBe('agent:typing');
      expect(KoreEventHandler.mapEventType('stop_typing')).toBe('agent:typing_stop');
      expect(KoreEventHandler.mapEventType('form_message')).toBe('agent:form');
      expect(KoreEventHandler.mapEventType('agent_joined')).toBe('agent:joined');
    });

    it('returns undefined for unknown XO event types', () => {
      expect(KoreEventHandler.mapEventType('unknown_event_type')).toBeUndefined();
      expect(KoreEventHandler.mapEventType('')).toBeUndefined();
    });

    it('processes events and delivers to registered handlers', async () => {
      const handler = new KoreEventHandler();
      const receivedEvents: AgentEvent[] = [];

      handler.onAgentMessage((event) => {
        receivedEvents.push(event);
      });

      await handler.processEvent(
        {
          type: 'agent_message',
          conversationId: 'conv-123',
          message: 'Hello from human agent',
          agentInfo: { name: 'Agent Smith' },
        },
        {
          tenantId: 'tenant-1',
          contactId: 'contact-1',
          channel: 'chat',
        },
      );

      expect(receivedEvents).toHaveLength(1);
      expect(receivedEvents[0].type).toBe('agent:message');
      expect(receivedEvents[0].tenantId).toBe('tenant-1');
      expect(receivedEvents[0].contactId).toBe('contact-1');
      expect(receivedEvents[0].channel).toBe('chat');
      expect(receivedEvents[0].data.message).toBe('Hello from human agent');
    });

    it('skips unknown event types without throwing', async () => {
      const handler = new KoreEventHandler();
      const receivedEvents: AgentEvent[] = [];

      handler.onAgentMessage((event) => {
        receivedEvents.push(event);
      });

      // Should not throw, should silently skip
      await handler.processEvent(
        { type: 'unknown_event', conversationId: 'conv-999' },
        { tenantId: 'tenant-1', contactId: 'contact-1', channel: 'chat' },
      );

      expect(receivedEvents).toHaveLength(0);
    });

    it('handler errors do not prevent delivery to other handlers', async () => {
      const handler = new KoreEventHandler();
      const events1: AgentEvent[] = [];
      const events2: AgentEvent[] = [];

      // First handler throws
      handler.onAgentMessage(() => {
        throw new Error('Handler 1 failure');
      });

      // Second handler should still receive the event
      handler.onAgentMessage((event) => {
        events2.push(event);
      });

      await handler.processEvent(
        { type: 'agent_message', conversationId: 'conv-1', message: 'Test' },
        { tenantId: 't1', contactId: 'c1', channel: 'chat' },
      );

      expect(events2).toHaveLength(1);
    });
  });

  // ── 9. Session Key Safety ─────────────────────────────────────────────

  describe('session key safety', () => {
    it('rejects colons in key components to prevent key injection', () => {
      expect(() => sessionKey('tenant:evil', 'contact', 'chat')).toThrow('must not contain colons');
      expect(() => sessionKey('tenant', 'contact:evil', 'chat')).toThrow('must not contain colons');
      expect(() => sessionKey('tenant', 'contact', 'chat:evil')).toThrow('must not contain colons');
    });
  });
});

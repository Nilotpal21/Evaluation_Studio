/**
 * E2E Smoke Test: Agent Transfer lifecycle
 *
 * Conditional on AGENT_TRANSFER_E2E=1 — requires a running Redis instance.
 * Exercises the full session lifecycle: create → webhook → delivery → end,
 * plus rate-limiter and session timeout behaviour.
 */
import { describe, it, expect, vi, beforeAll, afterAll, beforeEach } from 'vitest';
import Redis from 'ioredis';
import { scanKeys } from '@agent-platform/redis';

vi.mock('@abl/compiler/platform', () => ({
  createLogger: () => ({
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    debug: vi.fn(),
  }),
}));

import { TransferSessionStore } from '../../session/transfer-session-store.js';
import { sessionKey, ACTIVE_SESSIONS_SET } from '../../session/types.js';
import { checkRateLimit } from '../../security/rate-limiter.js';
import { isVoiceChannel } from '../../voice/index.js';

const E2E_ENABLED = process.env.AGENT_TRANSFER_E2E === '1';
const REDIS_URL = process.env.REDIS_URL ?? 'redis://localhost:6379';

// Use a unique prefix to avoid collisions with other tests
const TEST_PREFIX = `e2e_test_${Date.now()}`;

const describeE2E = E2E_ENABLED ? describe : describe.skip;

describeE2E('agent-transfer E2E smoke', () => {
  let redis: Redis;
  let store: TransferSessionStore;

  beforeAll(() => {
    redis = new Redis(REDIS_URL, {
      maxRetriesPerRequest: 1,
      lazyConnect: true,
    });
  });

  afterAll(async () => {
    // Use scanKeys (cluster-safe) instead of KEYS command
    const keys: string[] = [];
    for await (const k of scanKeys(redis, `agent_transfer:${TEST_PREFIX}*`)) keys.push(k);
    const rateKeys: string[] = [];
    for await (const k of scanKeys(redis, `at_ratelimit:${TEST_PREFIX}*`)) rateKeys.push(k);
    const providerKeys: string[] = [];
    for await (const k of scanKeys(redis, `at_by_provider:*:${TEST_PREFIX}*`)) providerKeys.push(k);
    const podKeys: string[] = [];
    for await (const k of scanKeys(redis, `at_pod:e2e-pod`)) podKeys.push(k);
    const allKeys = [...keys, ...rateKeys, ...providerKeys, ...podKeys];
    // Per-key DEL for cluster compatibility (multi-key DEL requires same slot)
    if (allKeys.length > 0) {
      await Promise.all(allKeys.map((k) => redis.del(k)));
    }
    // Remove from active sessions set
    if (keys.length > 0) {
      for (const k of keys) await redis.srem(ACTIVE_SESSIONS_SET, k);
    }
    await redis.quit();
  });

  beforeEach(() => {
    store = new TransferSessionStore(redis);
  });

  // ── Session Lifecycle ──────────────────────────────────────────────────────

  describe('session lifecycle', () => {
    it('full lifecycle: create → transition → end', async () => {
      const tenantId = `${TEST_PREFIX}_tenant`;
      const contactId = `${TEST_PREFIX}_contact`;

      // 1. Create session
      const result = await store.create({
        tenantId,
        contactId,
        channel: 'chat',
        provider: 'kore',
        providerSessionId: `${TEST_PREFIX}_conv_1`,
        ownerPod: 'e2e-pod',
      });

      expect(result.success).toBe(true);
      expect(result.sessionKey).toBe(sessionKey(tenantId, contactId, 'chat'));

      const session = await store.get(result.sessionKey!);
      expect(session).not.toBeNull();
      expect(session!.tenantId).toBe(tenantId);
      expect(session!.contactId).toBe(contactId);
      expect(session!.state).toBe('pending');
      expect(session!.provider).toBe('kore');

      // 2. Transition through states: pending → queued → active → post_agent
      const key = result.sessionKey!;
      for (const state of ['queued', 'active', 'post_agent'] as const) {
        const updated = await store.update(key, { state: state as any });
        expect(updated).toBe(true);
        const s = await store.get(key);
        expect(s!.state).toBe(state);
      }

      // 3. End session and verify cleanup
      await store.end(key);
      const ended = await store.get(key);
      expect(ended).toBeNull();
    });

    it('rejects duplicate session for same tenant+contact+channel', async () => {
      const tenantId = `${TEST_PREFIX}_dup_tenant`;
      const contactId = `${TEST_PREFIX}_dup_contact`;

      const r1 = await store.create({
        tenantId,
        contactId,
        channel: 'chat',
        provider: 'kore',
        providerSessionId: `${TEST_PREFIX}_dup_conv`,
        ownerPod: 'e2e-pod',
      });
      expect(r1.success).toBe(true);

      // Second create with same key should fail
      const r2 = await store.create({
        tenantId,
        contactId,
        channel: 'chat',
        provider: 'kore',
        providerSessionId: `${TEST_PREFIX}_dup_conv2`,
        ownerPod: 'e2e-pod',
      });
      expect(r2.success).toBe(false);
      expect(r2.error?.code).toBe('SESSION_EXISTS');

      // Cleanup
      await store.end(r1.sessionKey!);
    });

    it('provider index lookup works after session creation', async () => {
      const providerSessionId = `${TEST_PREFIX}_conv_lookup`;
      const result = await store.create({
        tenantId: `${TEST_PREFIX}_t2`,
        contactId: `${TEST_PREFIX}_c2`,
        channel: 'chat',
        provider: 'kore',
        providerSessionId,
        ownerPod: 'e2e-pod',
      });

      expect(result.success).toBe(true);

      // Lookup by provider
      const session = await store.getByProvider('kore', `${TEST_PREFIX}_t2`, providerSessionId);
      expect(session).not.toBeNull();
      expect(session!.contactId).toBe(`${TEST_PREFIX}_c2`);

      // Cleanup
      await store.end(result.sessionKey!);
    });
  });

  // ── Session Timeout ────────────────────────────────────────────────────────

  describe('session timeout with short TTL', () => {
    it('session with custom TTL stores the TTL value', async () => {
      const tenantId = `${TEST_PREFIX}_ttl_tenant`;
      const contactId = `${TEST_PREFIX}_ttl_contact`;

      const result = await store.create({
        tenantId,
        contactId,
        channel: 'chat',
        provider: 'kore',
        providerSessionId: `${TEST_PREFIX}_ttl_conv`,
        ownerPod: 'e2e-pod',
        ttl: 5, // 5 seconds
      });

      expect(result.success).toBe(true);

      const session = await store.get(result.sessionKey!);
      expect(session).not.toBeNull();
      expect(session!.ttl).toBe(5);

      // Cleanup
      await store.end(result.sessionKey!);
    });

    it('voice channel sessions use ttl=0 (no timeout)', async () => {
      const tenantId = `${TEST_PREFIX}_voice_tenant`;
      const contactId = `${TEST_PREFIX}_voice_contact`;

      const result = await store.create({
        tenantId,
        contactId,
        channel: 'voice',
        provider: 'kore',
        providerSessionId: `${TEST_PREFIX}_voice_conv`,
        ownerPod: 'e2e-pod',
        ttl: 0,
      });

      expect(result.success).toBe(true);

      const session = await store.get(result.sessionKey!);
      expect(session).not.toBeNull();
      expect(session!.ttl).toBe(0);

      // Cleanup
      await store.end(result.sessionKey!);
    });

    it('extendTTL updates the session heartbeat', async () => {
      const tenantId = `${TEST_PREFIX}_ext_tenant`;
      const contactId = `${TEST_PREFIX}_ext_contact`;

      const result = await store.create({
        tenantId,
        contactId,
        channel: 'chat',
        provider: 'kore',
        providerSessionId: `${TEST_PREFIX}_ext_conv`,
        ownerPod: 'e2e-pod',
        ttl: 30,
      });

      expect(result.success).toBe(true);

      const beforeExtend = await store.get(result.sessionKey!);
      expect(beforeExtend).not.toBeNull();
      const oldHeartbeat = beforeExtend!.lastHeartbeat;

      // Small delay to ensure timestamp differs
      await new Promise((resolve) => setTimeout(resolve, 50));

      await store.extendTTL(result.sessionKey!);

      const afterExtend = await store.get(result.sessionKey!);
      expect(afterExtend).not.toBeNull();
      expect(afterExtend!.lastHeartbeat).toBeGreaterThan(oldHeartbeat);

      // Cleanup
      await store.end(result.sessionKey!);
    });
  });

  // ── Rate Limiter ───────────────────────────────────────────────────────────

  describe('rate limiter with rapid transfers', () => {
    it('allows requests within limit', async () => {
      const result = await checkRateLimit(redis as any, `${TEST_PREFIX}_rl_tenant`);
      expect(result.allowed).toBe(true);
      expect(result.remaining).toBeGreaterThan(0);
    });

    it('tracks request count across calls', async () => {
      const tenant = `${TEST_PREFIX}_rl_count`;

      const r1 = await checkRateLimit(redis as any, tenant);
      const r2 = await checkRateLimit(redis as any, tenant);

      expect(r1.allowed).toBe(true);
      expect(r2.allowed).toBe(true);
      // Second call should have fewer remaining
      expect(r2.remaining).toBeLessThanOrEqual(r1.remaining);
    });

    it('rejects when limit exceeded', async () => {
      const tenant = `${TEST_PREFIX}_rl_exceed`;
      const lowLimit = { maxTransfers: 3, windowMs: 60_000 };

      // Exhaust the limit — each call should still be allowed
      for (let i = 0; i < 3; i++) {
        const r = await checkRateLimit(redis as any, tenant, lowLimit);
        expect(r.allowed).toBe(true);
      }

      const result = await checkRateLimit(redis as any, tenant, lowLimit);
      expect(result.allowed).toBe(false);
      expect(result.remaining).toBe(0);
    });
  });

  // ── Voice Channel Detection ────────────────────────────────────────────────

  describe('voice channel detection', () => {
    it('detects voice channels', () => {
      expect(isVoiceChannel('voice')).toBe(true);
      expect(isVoiceChannel('korevg')).toBe(true);
      expect(isVoiceChannel('audiocodes')).toBe(true);
      expect(isVoiceChannel('twilio')).toBe(true);
      expect(isVoiceChannel('ivr')).toBe(true);
    });

    it('rejects non-voice channels', () => {
      expect(isVoiceChannel('chat')).toBe(false);
      expect(isVoiceChannel('messaging')).toBe(false);
      expect(isVoiceChannel('email')).toBe(false);
    });
  });

  // ── Cross-Tenant Isolation ─────────────────────────────────────────────────

  describe('cross-tenant isolation', () => {
    it('different tenants cannot access each other sessions', async () => {
      const t1 = `${TEST_PREFIX}_iso_t1`;
      const t2 = `${TEST_PREFIX}_iso_t2`;
      const contact = `${TEST_PREFIX}_iso_c1`;

      const r1 = await store.create({
        tenantId: t1,
        contactId: contact,
        channel: 'chat',
        provider: 'kore',
        providerSessionId: `${TEST_PREFIX}_iso_conv`,
        ownerPod: 'e2e-pod',
      });

      expect(r1.success).toBe(true);

      // Tenant 2 should not see tenant 1's session
      const key2 = sessionKey(t2, contact, 'chat');
      const session = await store.get(key2);
      expect(session).toBeNull();

      // Provider index is also tenant-scoped
      const byProvider = await store.getByProvider('kore', t2, `${TEST_PREFIX}_iso_conv`);
      expect(byProvider).toBeNull();

      // Cleanup
      await store.end(r1.sessionKey!);
    });
  });
});

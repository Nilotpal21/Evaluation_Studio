/**
 * Phase 2 Security Hardening Tests
 *
 * Covers:
 * - 2.1 (C10): Webhook nonce with timestamp-based dedup
 * - 2.2 (I9): Session key colon validation
 * - 2.3 (I12): Rate limiter memory amplification fix
 * - 2.4 (I16): SSRF guard blocking DNS failures
 */
import { createHmac } from 'crypto';
import { describe, it, expect, vi, beforeEach } from 'vitest';
import {
  verifyWebhookSignature,
  type WebhookNonceStore,
  type WebhookVerificationConfig,
} from '../security/webhook-verification.js';
import { checkRateLimit, type RateLimitConfig } from '../security/rate-limiter.js';
import { assertAllowedUrl } from '../security/ssrf-guard.js';
import { sessionKey } from '../session/types.js';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeSignature(secret: string, body: string): string {
  return createHmac('sha256', secret).update(Buffer.from(body, 'utf-8')).digest('hex');
}

function createInMemoryNonceStore(): WebhookNonceStore {
  const seen = new Set<string>();
  return {
    async markSeen(nonce: string, _ttlMs: number): Promise<boolean> {
      if (seen.has(nonce)) return false;
      seen.add(nonce);
      return true;
    },
  };
}

// ---------------------------------------------------------------------------
// 2.1 — Webhook nonce accepts retries with different timestamps
// ---------------------------------------------------------------------------
describe('Webhook nonce (C10)', () => {
  const secret = 'test-secret';
  const body = '{"event":"test"}';
  const sig = makeSignature(secret, body);

  it('accepts the same payload sent at different timestamps (legitimate retry)', async () => {
    const nonceStore = createInMemoryNonceStore();
    const baseConfig: WebhookVerificationConfig = {
      secret,
      signatureHeader: 'x-sig',
      timestampHeader: 'x-ts',
      replayWindowMs: 300_000,
      nonceStore,
    };

    const ts1 = Date.now().toString();
    const ts2 = (Date.now() + 1000).toString();

    const result1 = await verifyWebhookSignature(baseConfig, { 'x-sig': sig, 'x-ts': ts1 }, body);
    expect(result1.valid).toBe(true);

    // Same payload, different timestamp => different nonce => should be accepted
    const result2 = await verifyWebhookSignature(baseConfig, { 'x-sig': sig, 'x-ts': ts2 }, body);
    expect(result2.valid).toBe(true);
  });

  it('rejects replays with identical timestamps', async () => {
    const nonceStore = createInMemoryNonceStore();
    const baseConfig: WebhookVerificationConfig = {
      secret,
      signatureHeader: 'x-sig',
      timestampHeader: 'x-ts',
      replayWindowMs: 300_000,
      nonceStore,
    };

    const ts = Date.now().toString();

    const result1 = await verifyWebhookSignature(baseConfig, { 'x-sig': sig, 'x-ts': ts }, body);
    expect(result1.valid).toBe(true);

    // Exact replay: same timestamp + same payload => same nonce => rejected
    const result2 = await verifyWebhookSignature(baseConfig, { 'x-sig': sig, 'x-ts': ts }, body);
    expect(result2.valid).toBe(false);
    expect(result2.error).toBe('Webhook verification failed');
  });

  it('works without timestamp header (falls back to signature-only nonce)', async () => {
    const nonceStore = createInMemoryNonceStore();
    const baseConfig: WebhookVerificationConfig = {
      secret,
      signatureHeader: 'x-sig',
      // No timestampHeader
      nonceStore,
    };

    const result1 = await verifyWebhookSignature(baseConfig, { 'x-sig': sig }, body);
    expect(result1.valid).toBe(true);

    // Without timestamps, same payload always produces the same nonce => replay blocked
    const result2 = await verifyWebhookSignature(baseConfig, { 'x-sig': sig }, body);
    expect(result2.valid).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// 2.2 — Session key rejects colons in components
// ---------------------------------------------------------------------------
describe('Session key colon validation (I9)', () => {
  it('rejects tenantId containing a colon', () => {
    expect(() => sessionKey('tenant:1', 'contact1', 'chat')).toThrow(
      'Session key components must not contain colons',
    );
  });

  it('rejects contactId containing a colon', () => {
    expect(() => sessionKey('tenant1', 'contact:1', 'chat')).toThrow(
      'Session key components must not contain colons',
    );
  });

  it('rejects channel containing a colon', () => {
    expect(() => sessionKey('tenant1', 'contact1', 'chat:web')).toThrow(
      'Session key components must not contain colons',
    );
  });

  it('accepts valid components without colons', () => {
    const key = sessionKey('tenant1', 'contact1', 'chat');
    expect(key).toBe('agent_transfer:tenant1:contact1:chat');
  });
});

// ---------------------------------------------------------------------------
// 2.3 — Rate limiter does not add entries when limit exceeded
// ---------------------------------------------------------------------------
describe('Rate limiter memory amplification (I12)', () => {
  let evalResults: number;
  let evalCalls: Array<{ script: string; args: unknown[] }>;
  let mockRedis: {
    eval: (...args: unknown[]) => Promise<number>;
  };

  beforeEach(() => {
    evalResults = 1; // default: allowed (count + 1 = 1)
    evalCalls = [];
    mockRedis = {
      eval: vi.fn(async (...args: unknown[]) => {
        evalCalls.push({ script: args[0] as string, args: args.slice(1) });
        return evalResults;
      }),
    };
  });

  it('returns allowed=true when under the limit', async () => {
    evalResults = 1; // Lua returns count+1 when allowed
    const result = await checkRateLimit(mockRedis as never, 'tenant1', {
      maxTransfers: 10,
      windowMs: 60_000,
    });
    expect(result.allowed).toBe(true);
    expect(result.remaining).toBe(9); // 10 - 1
  });

  it('returns allowed=false when limit exceeded (Lua returns -1)', async () => {
    evalResults = -1; // Lua returns -1 when rejected
    const result = await checkRateLimit(mockRedis as never, 'tenant1', {
      maxTransfers: 10,
      windowMs: 60_000,
    });
    expect(result.allowed).toBe(false);
    expect(result.remaining).toBe(0);
  });

  it('uses a Lua script (single eval call) instead of pipeline', async () => {
    evalResults = 1;
    await checkRateLimit(mockRedis as never, 'tenant1', {
      maxTransfers: 10,
      windowMs: 60_000,
    });
    // Should use redis.eval, not pipeline
    expect(mockRedis.eval).toHaveBeenCalledTimes(1);
    // The Lua script should contain ZCARD and conditional ZADD logic
    const script = evalCalls[0].script;
    expect(script).toContain('ZREMRANGEBYSCORE');
    expect(script).toContain('ZCARD');
    expect(script).toContain('ZADD');
    expect(script).toContain('return -1');
  });

  it('does not add entries when limit is exceeded', async () => {
    // The Lua script itself handles this atomically.
    // When result is -1, no ZADD was called inside the script.
    // We verify the script contains the conditional logic.
    evalResults = -1;
    const result = await checkRateLimit(mockRedis as never, 'tenant1', {
      maxTransfers: 2,
      windowMs: 60_000,
    });
    expect(result.allowed).toBe(false);

    // Verify the Lua script has conditional ZADD (only adds when count < limit)
    const script = evalCalls[0].script;
    expect(script).toContain('if count < tonumber(ARGV[2]) then');
  });
});

// ---------------------------------------------------------------------------
// 2.4 — SSRF guard blocks on DNS failure
// ---------------------------------------------------------------------------

// vi.mock hoists to the top, so we use vi.hoisted() to declare mock fns
// that are available at hoist time. The source uses
// `import dns from 'node:dns/promises'` (default import).
const { mockResolve4, mockResolve6 } = vi.hoisted(() => ({
  mockResolve4: vi.fn(),
  mockResolve6: vi.fn(),
}));

vi.mock('node:dns/promises', () => ({
  default: {
    resolve4: mockResolve4,
    resolve6: mockResolve6,
  },
  resolve4: mockResolve4,
  resolve6: mockResolve6,
}));

describe('SSRF guard DNS failure (I16)', () => {
  beforeEach(() => {
    mockResolve4.mockReset();
    mockResolve6.mockReset();
    // Default: resolve6 throws ENODATA (no AAAA records — common)
    mockResolve6.mockRejectedValue(new Error('queryAAAA ENODATA'));
  });

  it('blocks when DNS resolution fails', async () => {
    mockResolve4.mockRejectedValue(new Error('getaddrinfo ENOTFOUND example.test'));

    await expect(assertAllowedUrl('https://example.test/path')).rejects.toThrow(
      'SSRF blocked: DNS resolution failed for example.test',
    );
  });

  it('re-throws SSRF blocked errors from DNS resolution', async () => {
    mockResolve4.mockResolvedValue(['10.0.0.1']);

    await expect(assertAllowedUrl('https://evil.example.com/path')).rejects.toThrow(
      'SSRF blocked: evil.example.com resolves to private IP 10.0.0.1',
    );
  });

  it('allows URLs when DNS resolves to public IPs', async () => {
    mockResolve4.mockResolvedValue(['93.184.216.34']);
    mockResolve6.mockResolvedValue(['2606:2800:220:1:248:1893:25c8:1946']);

    await expect(assertAllowedUrl('https://example.com/path')).resolves.toBeUndefined();
  });
});

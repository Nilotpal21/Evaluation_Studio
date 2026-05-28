/**
 * Session Lua Script Fixes Tests
 *
 * Validates the three atomicity/correctness fixes:
 * - C7: Empty providerSessionId does NOT create a blank index key
 * - C8: end() atomically reads provider info and cleans up index key (no TOCTOU)
 * - I8: extendTTL uses atomic Lua script; expired key returns false, no ghost record
 *
 * Note: redis.eval() in this codebase refers to the ioredis API for executing
 * Lua scripts on the Redis server, not JavaScript's eval(). This is the standard
 * approach for atomic Redis operations.
 */
import { describe, it, expect, vi } from 'vitest';
import { TransferSessionStore } from '../session/transfer-session-store.js';
import {
  LUA_COMPLETE_ACW_IF_PENDING,
  LUA_CREATE_SESSION,
  LUA_END_SESSION,
  LUA_EXTEND_TTL,
} from '../session/lua-scripts.js';

vi.mock('@abl/compiler/platform', () => ({
  createLogger: () => ({
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    debug: vi.fn(),
  }),
}));

describe('session lua script fixes', () => {
  describe('C7: empty providerSessionId does NOT create index key', () => {
    it('TransferSessionStore.create() omits the provider-index SET when providerSessionId is empty', async () => {
      // Post-Phase 2.2: the not-empty guard moved out of the Lua body and
      // into the caller's index writes (cluster-safety required single-key
      // Lua). The behaviour is preserved: an empty providerSessionId never
      // produces a `set(indexKey, ...)` call.
      const setCalls: string[] = [];
      const mockRedis = {
        eval: vi.fn().mockResolvedValue(1),
        set: vi.fn().mockImplementation((key: string) => {
          setCalls.push(key);
          return Promise.resolve('OK');
        }),
        sadd: vi.fn().mockResolvedValue(1),
      };

      const store = new TransferSessionStore(mockRedis as any);
      const result = await store.create({
        tenantId: 'tenant-1',
        contactId: 'contact-1',
        channel: 'chat',
        provider: 'kore',
        providerSessionId: '', // empty
        ownerPod: 'pod-1',
      });

      expect(result.success).toBe(true);
      // No SET on the provider index — the caller short-circuits when
      // providerSessionId is empty.
      expect(setCalls).toEqual([]);
    });

    it('TransferSessionStore.create() includes the provider-index SET when providerSessionId is non-empty', async () => {
      const setCalls: Array<[string, string]> = [];
      const mockRedis = {
        eval: vi.fn().mockResolvedValue(1),
        set: vi.fn().mockImplementation((key: string, value: string) => {
          setCalls.push([key, value]);
          return Promise.resolve('OK');
        }),
        sadd: vi.fn().mockResolvedValue(1),
      };

      const store = new TransferSessionStore(mockRedis as any);
      const result = await store.create({
        tenantId: 'tenant-1',
        contactId: 'contact-1',
        channel: 'chat',
        provider: 'kore',
        providerSessionId: 'conv-123',
        ownerPod: 'pod-1',
      });

      expect(result.success).toBe(true);
      // The provider lookup index is set after the Lua returns.
      expect(setCalls).toEqual([
        ['at_by_provider:kore:tenant-1:conv-123', 'agent_transfer:tenant-1:contact-1:chat'],
      ]);
    });
  });

  describe('C8: end() atomically reads-then-deletes the session hash', () => {
    it('LUA_END_SESSION reads provider info from hash before deleting (no TOCTOU)', () => {
      // The script reads provider, providerSessionId, ownerPod from the
      // session hash BEFORE the DEL, then returns the trio so the caller
      // can clean up the cross-slot indexes.
      expect(LUA_END_SESSION).toContain("HGET', sessionKey, 'provider'");
      expect(LUA_END_SESSION).toContain("HGET', sessionKey, 'providerSessionId'");
      expect(LUA_END_SESSION).toContain("HGET', sessionKey, 'ownerPod'");
      expect(LUA_END_SESSION).toContain("DEL', sessionKey");
    });

    it('end() issues cross-slot index DELs individually after the Lua returns', async () => {
      // The provider-index DEL no longer lives inside the Lua body — it
      // moved to a caller-side individual call (Promise.allSettled) because
      // ioredis Cluster's pipeline() requires same-slot keys.
      const delCalls: string[] = [];
      const mockRedis = {
        hmget: vi.fn().mockResolvedValue([null, null, null]), // skip alias-key path
        eval: vi.fn().mockResolvedValue(['kore', 'conv-1', 'pod-1']),
        del: vi.fn().mockImplementation((key: string) => {
          delCalls.push(key);
          return Promise.resolve(1);
        }),
        srem: vi.fn().mockResolvedValue(1),
      };

      const store = new TransferSessionStore(mockRedis as any);
      const ok = await store.end('agent_transfer:tenant-1:contact-1:chat');
      expect(ok).toBe(true);
      expect(delCalls).toContain('at_by_provider:kore:tenant-1:conv-1');
    });

    it('end() does not call get() before the Lua script (no TOCTOU)', async () => {
      // The Lua script atomically reads + deletes; end() must NOT call
      // hgetall() up front (which would race a concurrent expiry).
      // It does perform a tightly-scoped hmget for the optional alias-key
      // cleanup — that's a separate concern and is checked here.
      const callOrder: string[] = [];

      const mockRedis = {
        hgetall: vi.fn().mockImplementation(() => {
          callOrder.push('hgetall');
          return Promise.resolve({});
        }),
        hmget: vi.fn().mockImplementation(() => {
          callOrder.push('hmget');
          return Promise.resolve([null, null, null]);
        }),
        eval: vi.fn().mockImplementation(() => {
          callOrder.push('lua-eval');
          return Promise.resolve(['kore', 'conv-1', 'pod-1']);
        }),
        del: vi.fn().mockResolvedValue(1),
        srem: vi.fn().mockResolvedValue(1),
      };

      const store = new TransferSessionStore(mockRedis as any);
      await store.end('agent_transfer:tenant-1:contact-1:chat');

      // hgetall (the heavy full-session fetch) is never called.
      expect(mockRedis.hgetall).not.toHaveBeenCalled();
      // The alias-key hmget is targeted (3 fields) and happens before lua-eval.
      expect(callOrder.indexOf('hmget')).toBeLessThan(callOrder.indexOf('lua-eval'));
    });

    it('end() passes the session hash as the only Lua key (single-key, cluster-safe)', async () => {
      const mockRedis = {
        eval: vi.fn().mockResolvedValue(['kore', 'conv-1', 'pod-1']),
        del: vi.fn().mockResolvedValue(1),
        srem: vi.fn().mockResolvedValue(1),
      };

      const store = new TransferSessionStore(mockRedis as any);
      await store.end('agent_transfer:tenant-abc:contact-1:chat');

      // Lua call: (script, numKeys=1, sessionKey). No additional KEYS or
      // ARGV — cross-slot ops moved to the pipeline below.
      expect(mockRedis.eval).toHaveBeenCalledWith(
        LUA_END_SESSION,
        1,
        'agent_transfer:tenant-abc:contact-1:chat',
      );
    });

    it('end() cleans up session atomically (Lua reads-then-deletes the session hash)', async () => {
      let sessionDeleted = false;
      const mockRedis = {
        eval: vi.fn().mockImplementation((script: string, numKeys: number, sessionKey: string) => {
          if (script === LUA_END_SESSION) {
            expect(numKeys).toBe(1);
            expect(sessionKey).toBe('agent_transfer:tenant-1:contact-1:chat');
            sessionDeleted = true;
            // Lua returns the {provider, providerSessionId, ownerPod} trio.
            return Promise.resolve(['kore', 'conv-end-test', 'pod-1']);
          }
          return Promise.resolve(0);
        }),
        del: vi.fn().mockResolvedValue(1),
        srem: vi.fn().mockResolvedValue(1),
        hgetall: vi.fn().mockImplementation(() => {
          if (sessionDeleted) return Promise.resolve({});
          return Promise.resolve({
            tenantId: 'tenant-1',
            contactId: 'contact-1',
            channel: 'chat',
            provider: 'kore',
            providerSessionId: 'conv-end-test',
            state: 'active',
            metadata: '{}',
            providerData: '{}',
            ownerPod: 'pod-1',
            lastHeartbeat: String(Date.now()),
            createdAt: String(Date.now()),
            updatedAt: String(Date.now()),
            ttl: '1800',
          });
        }),
      };

      const store = new TransferSessionStore(mockRedis as any);

      // Verify session exists before end
      const session = await store.get('agent_transfer:tenant-1:contact-1:chat');
      expect(session).not.toBeNull();

      // End the session
      const endResult = await store.end('agent_transfer:tenant-1:contact-1:chat');
      expect(endResult).toBe(true);
      expect(sessionDeleted).toBe(true);

      // Session should be gone after end
      const afterEnd = await store.get('agent_transfer:tenant-1:contact-1:chat');
      expect(afterEnd).toBeNull();
    });

    it('end() returns false for non-existent session', async () => {
      const mockRedis = {
        // ioredis .eval() runs a Lua script on Redis server (not JS eval)
        eval: vi.fn().mockImplementation((..._args: unknown[]) => {
          return Promise.resolve(0);
        }),
      };

      const store = new TransferSessionStore(mockRedis as any);
      const result = await store.end('agent_transfer:tenant-1:contact-1:chat');
      expect(result).toBe(false);
    });
  });

  describe('I8: non-atomic extendTTL fix', () => {
    it('LUA_EXTEND_TTL script checks existence before extending', () => {
      expect(LUA_EXTEND_TTL).toContain("redis.call('EXISTS', KEYS[1])");
      expect(LUA_EXTEND_TTL).toContain('return 0');
      expect(LUA_EXTEND_TTL).toContain("redis.call('EXPIRE', KEYS[1], ARGV[1])");
      expect(LUA_EXTEND_TTL).toContain("redis.call('HMSET', KEYS[1]");
    });

    it('extendTTL on expired/missing key returns false, no ghost record', async () => {
      // Simulate: session does not exist (hmget returns nulls)
      const mockRedis = {
        hmget: vi.fn().mockResolvedValue([null, null, null]),
      };

      const store = new TransferSessionStore(mockRedis as any);
      const result = await store.extendTTL('agent_transfer:tenant-1:contact-1:chat', 1800, 'chat');

      expect(result).toBe(false);
      // The Lua runner should NOT have been called because hmget returned null
    });

    it('extendTTL on valid key uses single-key Lua and returns true', async () => {
      const mockRedis = {
        hmget: vi.fn().mockResolvedValue(['kore', 'tenant-1', 'conv-123']),
        eval: vi.fn().mockImplementation((..._args: unknown[]) => {
          return Promise.resolve(1);
        }),
        hget: vi.fn().mockResolvedValue(null),
        expire: vi.fn().mockResolvedValue(1),
      };

      const store = new TransferSessionStore(mockRedis as any);
      const result = await store.extendTTL('agent_transfer:tenant-1:contact-1:chat', 1800, 'chat');

      expect(result).toBe(true);

      expect(mockRedis.eval).toHaveBeenCalledTimes(1);
      const luaCall = mockRedis.eval.mock.calls[0];
      expect(luaCall[0]).toBe(LUA_EXTEND_TTL);
      // numKeys = 1 (session key only — provider-index TTL extension is a
      // separate cross-slot operation, run after the Lua via redis.expire).
      expect(luaCall[1]).toBe(1);
      // KEYS[1] = session key
      expect(luaCall[2]).toBe('agent_transfer:tenant-1:contact-1:chat');
      // ARGV[1] = TTL — runLuaScript stringifies all args (Redis ARGV is always
      // string-typed at the protocol level).
      expect(luaCall[3]).toBe('1800');
      // ARGV[2] / ARGV[3] are timestamps (strings)
      expect(typeof luaCall[4]).toBe('string');
      expect(typeof luaCall[5]).toBe('string');

      // Provider index TTL extension lives outside the Lua boundary now.
      expect(mockRedis.expire).toHaveBeenCalledWith('at_by_provider:kore:tenant-1:conv-123', 1800);
    });

    it('extendTTL uses Lua script instead of pipeline', async () => {
      const pipelineMock = {
        expire: vi.fn().mockReturnThis(),
        hmset: vi.fn().mockReturnThis(),
        exec: vi.fn().mockResolvedValue([]),
      };

      const mockRedis = {
        hmget: vi.fn().mockResolvedValue(['kore', 'tenant-1', 'conv-123']),
        // ioredis .eval() runs a Lua script on Redis server (not JS eval)
        eval: vi.fn().mockImplementation((..._args: unknown[]) => {
          return Promise.resolve(1);
        }),
        pipeline: vi.fn().mockReturnValue(pipelineMock),
      };

      const store = new TransferSessionStore(mockRedis as any);
      await store.extendTTL('agent_transfer:tenant-1:contact-1:chat', 1800, 'chat');

      // Lua script runner should be called (atomic approach)
      expect(mockRedis.eval).toHaveBeenCalledTimes(1);
      // pipeline() should NOT be called (old non-atomic approach)
      expect(mockRedis.pipeline).not.toHaveBeenCalled();
    });

    it('extendTTL with Lua script returning 0 (expired session) returns false', async () => {
      const mockRedis = {
        hmget: vi.fn().mockResolvedValue(['kore', 'tenant-1', 'conv-123']),
        // ioredis .eval() runs a Lua script on Redis server (not JS eval)
        // Lua returns 0: session expired between hmget and the script execution
        eval: vi.fn().mockImplementation((..._args: unknown[]) => {
          return Promise.resolve(0);
        }),
      };

      const store = new TransferSessionStore(mockRedis as any);
      const result = await store.extendTTL('agent_transfer:tenant-1:contact-1:chat', 1800, 'chat');

      // The Lua script found the session expired, so it returned 0
      expect(result).toBe(false);
    });

    it('extendTTL with empty providerSessionId passes only session key', async () => {
      const mockRedis = {
        hmget: vi.fn().mockResolvedValue(['kore', 'tenant-1', '']),
        // ioredis .eval() runs a Lua script on Redis server (not JS eval)
        eval: vi.fn().mockImplementation((..._args: unknown[]) => {
          return Promise.resolve(1);
        }),
      };

      const store = new TransferSessionStore(mockRedis as any);
      await store.extendTTL('agent_transfer:tenant-1:contact-1:chat', 1800, 'chat');

      const luaCall = mockRedis.eval.mock.calls[0];
      expect(luaCall[0]).toBe(LUA_EXTEND_TTL);
      // numKeys = 1 (only session key, no index key since providerSessionId is empty)
      expect(luaCall[1]).toBe(1);
      expect(luaCall[2]).toBe('agent_transfer:tenant-1:contact-1:chat');
      // ARGV[1] = TTL (runLuaScript stringifies all args)
      expect(luaCall[3]).toBe('1800');
    });

    it('extendTTL for voice channel (TTL=0) returns true without running Lua script', async () => {
      const mockRedis = {
        hmget: vi.fn().mockResolvedValue([null, null, null]),
        hgetall: vi.fn().mockResolvedValue({
          tenantId: 'tenant-1',
          contactId: 'contact-1',
          channel: 'voice',
          provider: 'kore',
          providerSessionId: 'conv-1',
          state: 'active',
          metadata: '{}',
          providerData: '{}',
          ownerPod: 'pod-1',
          lastHeartbeat: String(Date.now()),
          createdAt: String(Date.now()),
          updatedAt: String(Date.now()),
          ttl: '0',
        }),
        eval: vi.fn(),
      };

      const store = new TransferSessionStore(mockRedis as any);
      // No channel hint, so it calls get() which uses hgetall
      const result = await store.extendTTL('agent_transfer:tenant-1:contact-1:voice');

      expect(result).toBe(true);
      // Voice has TTL=0, so the Lua script should NOT be called
      expect(mockRedis.eval).not.toHaveBeenCalled();
    });
  });

  describe('ACW completion: exactly-once Lua marker', () => {
    it('completeAcwIfPending uses a single-key Lua script and stores ACW fields', async () => {
      const mockRedis = {
        eval: vi.fn().mockResolvedValue(1),
      };

      const store = new TransferSessionStore(mockRedis as any);
      const result = await store.completeAcwIfPending('agent_transfer:tenant-1:sess-1:chat', {
        acwTimedOut: false,
        acwCloseReason: 'agent_closed',
        acwEndedAt: 1_747_389_126_000,
        dispositionCode: 'Resolved',
        wrapUpNotes: 'Submitted plan',
      });

      expect(result).toBe(true);
      expect(mockRedis.eval).toHaveBeenCalledTimes(1);
      const luaCall = mockRedis.eval.mock.calls[0];
      expect(luaCall[0]).toBe(LUA_COMPLETE_ACW_IF_PENDING);
      expect(luaCall[1]).toBe(1);
      expect(luaCall[2]).toBe('agent_transfer:tenant-1:sess-1:chat');
      expect(luaCall).toEqual(
        expect.arrayContaining([
          'acwEnabled',
          'true',
          'acwCompletedEmitted',
          'true',
          'acwTimedOut',
          'false',
          'acwCloseReason',
          'agent_closed',
          'acwEndedAt',
          '1747389126000',
          'dispositionCode',
          'Resolved',
          'wrapUpNotes',
          'Submitted plan',
        ]),
      );
    });

    it('completeAcwIfPending returns false when Lua reports an already-completed or missing session', async () => {
      const mockRedis = {
        eval: vi.fn().mockResolvedValue(0),
      };

      const store = new TransferSessionStore(mockRedis as any);
      const result = await store.completeAcwIfPending('agent_transfer:tenant-1:sess-1:chat', {
        acwTimedOut: true,
        acwCloseReason: 'timeout',
        acwEndedAt: 1_747_389_126_000,
      });

      expect(result).toBe(false);
    });
  });
});

import { beforeEach, describe, expect, it } from 'vitest';
import { RedisFanOutBarrierStore } from '../redis-fan-out-barrier.js';
import type { RedisClient } from '../redis-callback-registry.js';

class FakeRedis implements RedisClient {
  private readonly strings = new Map<string, string>();
  private readonly hashes = new Map<string, Map<string, string>>();
  private readonly sets = new Map<string, Set<string>>();

  async set(key: string, value: string): Promise<string | null> {
    this.strings.set(key, value);
    return 'OK';
  }

  async get(key: string): Promise<string | null> {
    return this.strings.get(key) ?? null;
  }

  async del(key: string | string[]): Promise<number> {
    const keys = Array.isArray(key) ? key : [key];
    let deleted = 0;
    for (const entry of keys) {
      deleted += this.strings.delete(entry) ? 1 : 0;
      deleted += this.hashes.delete(entry) ? 1 : 0;
      deleted += this.sets.delete(entry) ? 1 : 0;
    }
    return deleted;
  }

  async eval(script: string, numkeys: number, ...args: (string | number)[]): Promise<unknown> {
    const keys = args.slice(0, numkeys).map(String);
    const argv = args.slice(numkeys).map(String);

    // LUA_CREATE_BARRIER (TTL is the LAST ARGV; field/value pairs precede it)
    if (script.includes('for i = 1, #ARGV - 1, 2 do')) {
      const hash = this.getHash(keys[0]);
      for (let index = 0; index < argv.length - 1; index += 2) {
        hash.set(argv[index], argv[index + 1]);
      }
      return 1;
    }

    // LUA_COMPLETE_BRANCH — KEYS[1]=barrier hash, KEYS[2]=result key,
    // KEYS[3]=registry SET. ARGV[4]=branchKey for the SADD into KEYS[3].
    if (script.includes("if redis.call('EXISTS', KEYS[1]) == 0 then")) {
      return this.completeBranch(keys[0], keys[1], keys[2], argv);
    }

    if (script.includes("return redis.call('HGET', KEYS[1], ARGV[1])")) {
      return this.hashes.get(keys[0])?.get(argv[0]) ?? null;
    }

    if (script.includes("return redis.call('HGETALL', KEYS[1])")) {
      const hash = this.hashes.get(keys[0]);
      if (!hash) {
        return [];
      }
      return [...hash.entries()].flatMap(([field, value]) => [field, value]);
    }

    // LUA_SCAN_RESULT_KEYS — iterate registry SET (KEYS[2]) and GET each
    // `${KEYS[1]}:result:${branchKey}`.
    if (
      script.includes("local keys = redis.call('SMEMBERS', KEYS[2])") &&
      script.includes('table.insert(results, fullKey)')
    ) {
      const registryKey = keys[1];
      const branchKeys = [...(this.sets.get(registryKey) ?? new Set<string>())];
      const out: string[] = [];
      for (const branchKey of branchKeys) {
        const fullKey = `${keys[0]}:result:${branchKey}`;
        const value = this.strings.get(fullKey);
        if (value !== undefined) {
          out.push(fullKey, value);
        }
      }
      return out;
    }

    if (script.includes("redis.call('HSET', KEYS[1], ARGV[1], ARGV[2])")) {
      this.getHash(keys[0]).set(argv[0], argv[1]);
      return 1;
    }

    if (script.includes("redis.call('HSET', KEYS[1], 'status', 'cancelled')")) {
      const hash = this.getHash(keys[0]);
      hash.set('status', 'cancelled');
      hash.set('cancelReason', argv[0]);
      hash.set('closedAt', argv[1]);
      return 1;
    }

    // LUA_DELETE_BARRIER — iterate registry SET, DEL each result key, then
    // DEL the registry SET and the barrier hash.
    if (
      script.includes("local keys = redis.call('SMEMBERS', KEYS[2])") &&
      script.includes("redis.call('DEL', KEYS[1])")
    ) {
      const registryKey = keys[1];
      const branchKeys = [...(this.sets.get(registryKey) ?? new Set<string>())];
      for (const branchKey of branchKeys) {
        this.strings.delete(`${keys[0]}:result:${branchKey}`);
      }
      this.sets.delete(registryKey);
      this.hashes.delete(keys[0]);
      return 1;
    }

    throw new Error(`Unhandled fake Redis script: ${script.slice(0, 80)}`);
  }

  private completeBranch(
    barrierKey: string,
    resultKey: string,
    registryKey: string,
    argv: string[],
  ): [string, number, number, number] {
    const hash = this.hashes.get(barrierKey);
    if (!hash) {
      return ['barrier_missing', 0, 0, 0];
    }

    const now = Number(argv[2]);
    const branchKey = argv[3] ?? '';
    const total = Number(hash.get('totalBranches') ?? 0);
    let completed = Number(hash.get('completedBranches') ?? 0);
    let parentResumeReady = Number(hash.get('parentResumeReady') ?? 0);
    let status = hash.get('status') || 'open';
    const expiresAt = Number(hash.get('expiresAt') ?? 0);

    if (status !== 'open') {
      hash.set('ignoredLateArrivals', String(Number(hash.get('ignoredLateArrivals') ?? 0) + 1));
      return ['ignored_late', completed, total, parentResumeReady];
    }

    if (expiresAt > 0 && expiresAt <= now) {
      hash.set('status', 'expired');
      hash.set('closedAt', String(now));
      hash.set('ignoredLateArrivals', String(Number(hash.get('ignoredLateArrivals') ?? 0) + 1));
      return ['ignored_late', completed, total, parentResumeReady];
    }

    if (this.strings.has(resultKey)) {
      return ['duplicate', completed, total, parentResumeReady];
    }

    this.strings.set(resultKey, argv[0]);
    this.getSet(registryKey).add(branchKey);
    completed += 1;
    hash.set('completedBranches', String(completed));
    hash.set('terminalBranches', String(completed));

    if (completed >= total && parentResumeReady === 0) {
      parentResumeReady = 1;
      hash.set('parentResumeReady', '1');
      hash.set('status', 'completed');
      hash.set('closedAt', String(now));
      status = 'completed';
    }

    if (status === 'open') {
      hash.set('status', 'open');
    }

    return ['recorded', completed, total, parentResumeReady];
  }

  private getHash(key: string): Map<string, string> {
    let hash = this.hashes.get(key);
    if (!hash) {
      hash = new Map();
      this.hashes.set(key, hash);
    }
    return hash;
  }

  private getSet(key: string): Set<string> {
    let set = this.sets.get(key);
    if (!set) {
      set = new Set();
      this.sets.set(key, set);
    }
    return set;
  }
}

describe('RedisFanOutBarrierStore', () => {
  let redis: FakeRedis;
  let store: RedisFanOutBarrierStore;

  beforeEach(() => {
    redis = new FakeRedis();
    store = new RedisFanOutBarrierStore(redis);
  });

  it('creates barriers with the additive hardened metadata fields', async () => {
    const barrierId = await store.create({
      parentSessionId: 'session-1',
      parentExecutionId: 'exec-1',
      tenantId: 'tenant-1',
      totalBranches: 2,
      timeoutMs: 60_000,
    });

    await store.setParentSuspension(barrierId, 'parent-suspension');
    const barrier = await store.get(barrierId);

    expect(barrier).toEqual(
      expect.objectContaining({
        barrierId,
        parentSessionId: 'session-1',
        parentExecutionId: 'exec-1',
        tenantId: 'tenant-1',
        totalBranches: 2,
        completedBranches: 0,
        status: 'open',
        parentResumeReady: false,
        terminalBranches: 0,
        ignoredLateArrivals: 0,
        parentSuspensionId: 'parent-suspension',
      }),
    );
  });

  it('deduplicates repeated branch completion attempts by branchId', async () => {
    const barrierId = await store.create({
      parentSessionId: 'session-1',
      parentExecutionId: 'exec-1',
      tenantId: 'tenant-1',
      totalBranches: 2,
      timeoutMs: 60_000,
    });

    const first = await store.completeBranch(barrierId, {
      branchId: 'branch-1',
      branchAgent: 'Billing_Agent',
      status: 'completed',
      response: 'done',
      completedAt: 10,
    });
    const second = await store.completeBranch(barrierId, {
      branchId: 'branch-1',
      branchAgent: 'Billing_Agent',
      status: 'error',
      error: 'late duplicate',
      completedAt: 20,
    });

    const barrier = await store.get(barrierId);

    expect(first.disposition).toBe('recorded');
    expect(second.disposition).toBe('duplicate');
    expect(barrier?.completedBranches).toBe(1);
    expect(barrier?.terminalBranches).toBe(1);
  });

  it('flips parentResumeReady exactly once when the final unique branch completes', async () => {
    const barrierId = await store.create({
      parentSessionId: 'session-1',
      parentExecutionId: 'exec-1',
      tenantId: 'tenant-1',
      totalBranches: 2,
      timeoutMs: 60_000,
    });

    const first = await store.completeBranch(barrierId, {
      branchId: 'branch-1',
      branchAgent: 'Billing_Agent',
      status: 'completed',
      response: 'billing done',
      completedAt: 10,
    });
    const second = await store.completeBranch(barrierId, {
      branchId: 'branch-2',
      branchAgent: 'Shipping_Agent',
      status: 'timeout',
      error: 'shipping timeout',
      completedAt: 20,
    });

    const barrier = await store.get(barrierId);
    const results = await store.getResults(barrierId);

    expect(first.parentResumeReady).toBe(false);
    expect(second.parentResumeReady).toBe(true);
    expect(second.allComplete).toBe(true);
    expect(barrier).toEqual(
      expect.objectContaining({
        completedBranches: 2,
        status: 'completed',
        parentResumeReady: true,
        terminalBranches: 2,
      }),
    );
    expect(Object.keys(results).sort()).toEqual(['branch-1', 'branch-2']);
  });

  it('ignores late arrivals after the barrier has been cancelled', async () => {
    const barrierId = await store.create({
      parentSessionId: 'session-1',
      parentExecutionId: 'exec-1',
      tenantId: 'tenant-1',
      totalBranches: 1,
      timeoutMs: 60_000,
    });

    await store.cancel(barrierId, 'user_cancelled');
    const outcome = await store.completeBranch(barrierId, {
      branchId: 'branch-1',
      branchAgent: 'Shipping_Agent',
      status: 'completed',
      response: 'late response',
      completedAt: 30,
    });
    const barrier = await store.get(barrierId);

    expect(outcome.disposition).toBe('ignored_late');
    expect(barrier?.completedBranches).toBe(0);
    expect(barrier?.ignoredLateArrivals).toBe(1);
    expect(barrier?.status).toBe('cancelled');
  });
});

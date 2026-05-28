/**
 * Mock Redis for Circuit Breaker Tests
 *
 * A minimal in-memory Redis mock that supports the subset of operations
 * used by the circuit breaker Lua scripts. Instead of running actual Lua,
 * we emulate the script behavior in TypeScript.
 *
 * This allows testing without a real Redis instance while preserving
 * the exact semantics of the Lua scripts.
 */

export interface MockRedis {
  advanceTime(ms: number): void;
  /**
   * Test-side dispatcher used by the `vi.mock('@agent-platform/redis')` factory
   * to route `runLuaScript` calls into in-memory emulators. Mirrors the
   * `runLuaScript(client, script, keys, args)` contract.
   */
  evalScript(name: string, keys: string[], argv: string[]): Promise<unknown>;
}

export function createMockRedis(): MockRedis & Record<string, any> {
  // In-memory storage
  const store: Map<string, string> = new Map();
  const sortedSets: Map<string, Map<string, number>> = new Map(); // key -> (member -> score)
  const expiries: Map<string, number> = new Map(); // key -> expiry timestamp

  // Use Date.now() directly — tests mock Date.now() via vi.spyOn
  function now(): number {
    return Date.now();
  }

  function isExpired(key: string): boolean {
    const expiry = expiries.get(key);
    if (expiry === undefined) return false;
    return now() > expiry;
  }

  function cleanKey(key: string): void {
    if (isExpired(key)) {
      store.delete(key);
      sortedSets.delete(key);
      expiries.delete(key);
    }
  }

  function getSortedSet(key: string): Map<string, number> {
    cleanKey(key);
    if (!sortedSets.has(key)) {
      sortedSets.set(key, new Map());
    }
    return sortedSets.get(key)!;
  }

  const mock: any = {
    // ── Core Commands ──────────────────────────────────────

    async get(key: string): Promise<string | null> {
      cleanKey(key);
      return store.get(key) ?? null;
    },

    async set(key: string, value: string): Promise<'OK'> {
      store.set(key, String(value));
      return 'OK';
    },

    async del(...keys: string[]): Promise<number> {
      let count = 0;
      for (const key of keys) {
        if (store.has(key) || sortedSets.has(key)) count++;
        store.delete(key);
        sortedSets.delete(key);
        expiries.delete(key);
      }
      return count;
    },

    async incr(key: string): Promise<number> {
      cleanKey(key);
      const val = Number(store.get(key) || '0') + 1;
      store.set(key, String(val));
      return val;
    },

    async decr(key: string): Promise<number> {
      cleanKey(key);
      const val = Math.max(0, Number(store.get(key) || '0') - 1);
      store.set(key, String(val));
      return val;
    },

    async pexpire(key: string, ms: number): Promise<number> {
      if (store.has(key) || sortedSets.has(key)) {
        expiries.set(key, now() + ms);
        return 1;
      }
      return 0;
    },

    // ── Sorted Set Commands ────────────────────────────────

    async zadd(key: string, score: number, member: string): Promise<number> {
      const set = getSortedSet(key);
      const isNew = !set.has(member);
      set.set(member, score);
      return isNew ? 1 : 0;
    },

    async zcard(key: string): Promise<number> {
      cleanKey(key);
      return getSortedSet(key).size;
    },

    async zcount(key: string, min: number | string, max: number | string): Promise<number> {
      const set = getSortedSet(key);
      const minVal = min === '-inf' ? -Infinity : Number(min);
      const maxVal = max === '+inf' ? Infinity : Number(max);
      let count = 0;
      for (const score of set.values()) {
        if (score >= minVal && score <= maxVal) count++;
      }
      return count;
    },

    async zremrangebyscore(
      key: string,
      min: number | string,
      max: number | string,
    ): Promise<number> {
      const set = getSortedSet(key);
      const minVal = min === '-inf' ? -Infinity : Number(min);
      const maxVal = max === '+inf' ? Infinity : Number(max);
      let removed = 0;
      for (const [member, score] of set.entries()) {
        if (score >= minVal && score <= maxVal) {
          set.delete(member);
          removed++;
        }
      }
      return removed;
    },

    // ── Pipeline ───────────────────────────────────────────

    pipeline() {
      const ops: Array<{ method: string; args: any[] }> = [];
      const pipe: any = {};

      const methods = [
        'get',
        'set',
        'del',
        'incr',
        'decr',
        'zadd',
        'zcard',
        'zcount',
        'zremrangebyscore',
        'pexpire',
      ];
      for (const method of methods) {
        pipe[method] = (...args: any[]) => {
          ops.push({ method, args });
          return pipe;
        };
      }

      pipe.exec = async () => {
        const results: Array<[Error | null, any]> = [];
        for (const op of ops) {
          try {
            const result = await mock[op.method](...op.args);
            results.push([null, result]);
          } catch (err) {
            results.push([err as Error, null]);
          }
        }
        return results;
      };

      return pipe;
    },

    // ── SCAN ───────────────────────────────────────────────

    async scan(
      cursor: string,
      _match: string,
      pattern: string,
      _count: string,
      count: number,
    ): Promise<[string, string[]]> {
      const regex = new RegExp('^' + pattern.replace(/\*/g, '.*') + '$');
      const allKeys = [...store.keys(), ...sortedSets.keys()];
      const matched = allKeys.filter((k) => regex.test(k) && !isExpired(k));
      return ['0', matched]; // Return all in one scan (mock)
    },

    // ── Lua emulator dispatcher ─────────────────────────────

    async evalScript(name: string, keys: string[], argv: string[]): Promise<unknown> {
      switch (name) {
        case 'breakerRecordFailure':
          return emulateRecordFailure(keys, argv, mock, now);
        case 'breakerRecordSuccess':
          return emulateRecordSuccess(keys, argv, mock, now);
        case 'breakerCheckState':
          return emulateCheckState(keys, argv, mock, now);
        case 'breakerForceReset':
          return emulateForceReset(keys, argv, mock, now);
        default:
          throw new Error(`Unknown script: ${name}`);
      }
    },

    // ── Test Helper ────────────────────────────────────────
    // No-op: time is controlled via Date.now() mock in tests
    advanceTime(_ms: number): void {},
  };

  return mock;
}

async function emulateRecordFailure(
  keys: string[],
  argv: string[],
  redis: any,
  now: () => number,
): Promise<[string, number, number, number]> {
  const [failuresKey, successesKey, stateKey, openedAtKey, halfOpenKey] = keys;
  const [timestamp, errorId, windowStart, failThreshold, rateThreshold, minRequests, resetTimeout] =
    argv;

  // Add failure
  const member = `${timestamp}:${errorId}`;
  await redis.zadd(failuresKey, Number(timestamp), member);

  // Trim window
  await redis.zremrangebyscore(failuresKey, '-inf', Number(windowStart));
  await redis.zremrangebyscore(successesKey, '-inf', Number(windowStart));

  // Count
  const failureCount = await redis.zcard(failuresKey);
  const successCount = await redis.zcard(successesKey);
  const totalCount = failureCount + successCount;

  // Get state
  const state = (await redis.get(stateKey)) || 'CLOSED';

  const failureRate = totalCount > 0 ? Math.floor((failureCount / totalCount) * 100) : 0;

  if (state === 'HALF_OPEN') {
    await redis.set(stateKey, 'OPEN');
    await redis.set(openedAtKey, timestamp);
    await redis.set(halfOpenKey, '0');
    const ttl = Number(resetTimeout) * 2;
    await redis.pexpire(stateKey, ttl);
    await redis.pexpire(openedAtKey, ttl);
    await redis.pexpire(failuresKey, ttl);
    await redis.pexpire(successesKey, ttl);
    await redis.pexpire(halfOpenKey, ttl);
    return ['OPEN', failureCount, totalCount, failureRate];
  }

  // Check thresholds
  let shouldOpen = false;
  if (failureCount >= Number(failThreshold)) shouldOpen = true;
  if (totalCount >= Number(minRequests) && totalCount > 0) {
    const rate = Math.floor((failureCount / totalCount) * 100);
    if (rate >= Number(rateThreshold)) shouldOpen = true;
  }

  if (shouldOpen && state !== 'OPEN') {
    await redis.set(stateKey, 'OPEN');
    await redis.set(openedAtKey, timestamp);
    const ttl = Number(resetTimeout) * 2;
    await redis.pexpire(stateKey, ttl);
    await redis.pexpire(openedAtKey, ttl);
    await redis.pexpire(failuresKey, ttl);
    await redis.pexpire(successesKey, ttl);
    await redis.pexpire(halfOpenKey, ttl);
    return ['OPEN', failureCount, totalCount, failureRate];
  }

  await redis.pexpire(failuresKey, Number(resetTimeout) * 2);
  await redis.pexpire(successesKey, Number(resetTimeout) * 2);

  return [state, failureCount, totalCount, failureRate];
}

async function emulateRecordSuccess(
  keys: string[],
  argv: string[],
  redis: any,
  _now: () => number,
): Promise<[string, number]> {
  const [successesKey, stateKey, failuresKey, halfOpenKey, openedAtKey] = keys;
  const [timestamp, windowStart, successThreshold, nonce] = argv;

  // Add success (nonce ensures uniqueness within same ms)
  const member = `${timestamp}:${nonce || '0'}`;
  await redis.zadd(successesKey, Number(timestamp), member);

  // Trim
  await redis.zremrangebyscore(successesKey, '-inf', Number(windowStart));

  const state = (await redis.get(stateKey)) || 'CLOSED';
  const successCount = await redis.zcard(successesKey);

  if (state === 'HALF_OPEN') {
    const current = Number((await redis.get(halfOpenKey)) || '0');
    if (current > 0) await redis.decr(halfOpenKey);

    const openedAt = Number((await redis.get(openedAtKey)) || '0');
    const recentSuccesses = await redis.zcount(successesKey, openedAt, '+inf');

    if (recentSuccesses >= Number(successThreshold)) {
      await redis.set(stateKey, 'CLOSED');
      await redis.del(failuresKey, successesKey, halfOpenKey, openedAtKey);
      return ['CLOSED', recentSuccesses];
    }
  }

  return [state, successCount];
}

async function emulateCheckState(
  keys: string[],
  argv: string[],
  redis: any,
  now: () => number,
): Promise<[string, number, number]> {
  const [stateKey, openedAtKey, halfOpenKey] = keys;
  const [timestamp, resetTimeout, maxHalfOpen] = argv;

  const state = (await redis.get(stateKey)) || 'CLOSED';
  const currentTime = Number(timestamp) || now();

  if (state === 'CLOSED') {
    return ['CLOSED', 1, 0];
  }

  if (state === 'OPEN') {
    const openedAt = Number((await redis.get(openedAtKey)) || '0');
    const elapsed = currentTime - openedAt;

    if (elapsed >= Number(resetTimeout)) {
      await redis.set(stateKey, 'HALF_OPEN');
      await redis.set(halfOpenKey, '1');
      return ['HALF_OPEN', 1, 0];
    } else {
      const retryAfter = Number(resetTimeout) - elapsed;
      return ['OPEN', 0, retryAfter];
    }
  }

  if (state === 'HALF_OPEN') {
    const count = Number((await redis.get(halfOpenKey)) || '0');
    if (count < Number(maxHalfOpen)) {
      await redis.incr(halfOpenKey);
      return ['HALF_OPEN', 1, 0];
    } else {
      return ['HALF_OPEN', 0, 5000];
    }
  }

  return [state, 0, 0];
}

async function emulateForceReset(
  keys: string[],
  argv: string[],
  redis: any,
  _now: () => number,
): Promise<[string, string]> {
  const [stateKey, failuresKey, successesKey, halfOpenKey, openedAtKey] = keys;
  const [targetState, timestamp, resetTimeout] = argv;

  if (targetState === 'CLOSED') {
    await redis.set(stateKey, 'CLOSED');
    await redis.del(failuresKey, successesKey, halfOpenKey, openedAtKey);
    return ['CLOSED', 'forced'];
  } else if (targetState === 'OPEN') {
    await redis.set(stateKey, 'OPEN');
    await redis.set(openedAtKey, timestamp);
    const ttl = Number(resetTimeout) * 2;
    await redis.pexpire(stateKey, ttl);
    await redis.pexpire(openedAtKey, ttl);
    return ['OPEN', 'forced'];
  } else if (targetState === 'HALF_OPEN') {
    await redis.del(failuresKey, successesKey);
    await redis.set(stateKey, 'HALF_OPEN');
    await redis.set(halfOpenKey, '0');
    await redis.set(openedAtKey, timestamp);
    return ['HALF_OPEN', 'forced'];
  }

  return ['UNKNOWN', 'invalid_target_state'];
}

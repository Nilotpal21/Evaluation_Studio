# Agent Learnings: @agent-platform/redis

## Redis Dual-Mode (Standalone + Cluster) — 2026-05-05

### Cluster-aware abstractions

- **`handle.duplicate()` is the cluster-safe path for pub/sub**. Raw `client.duplicate()` is fine on `Redis` but does not exist on `Cluster`. Always use `createSubscriber(handle)` for pub/sub connections; it instantiates a fresh `Cluster` from `handle.nodes` + `handle.baseOptions` when cluster mode is active.
- **`createBullMQPair(handle)` for BullMQ**. Two independent connections are needed (`{queueConnection, workerConnection, disconnect()}`). The `disconnect()` method must call through to both; do not return a no-op or the `shutdown()` test will fail.
- **`runLuaScript(client, script, keys, args)` for all Lua**. `defineCommand` is not supported on `Cluster`. The `eval`/`evalsha`/`NOSCRIPT` fallback loop is handled internally by ioredis on both `Redis` and `Cluster`; no custom SHA1 caching needed.
- **`scanKeys(client, pattern)`** iterates `client.nodes('master')` in cluster and uses a `Set` for deduplication across masters. Mid-failover it skips dead nodes with a `redis.scanKeys.nodeError` structured log (does not throw).

### Key design patterns

- **Hash tags**: `hashTag('a', 'b')` → `'{a:b}'`. Braces force slot computation on the tagged content only. In standalone they are inert literal characters. Use for any multi-key Lua (all keys must share a tag).
- **`pipeline()` not `multi()` for cross-slot writes**. `MULTI`/`EXEC` transactions throw `CROSSSLOT` in cluster. Use `client.pipeline()` for batching cross-slot writes; it executes them in parallel with no atomicity guarantee (acceptable for advisory indexes and cache invalidation).
- **Never pass raw `Redis` to `createBullMQPair`**. The `instanceof Redis / Cluster` check in `packages/redis/src/bullmq.ts:200-213` will throw. Unit tests that pass mock Redis objects must stub `createBullMQPair` via `vi.mock('@agent-platform/redis', ...)`.

### Test mocking pattern

When unit-testing any class that calls `createBullMQPair` or `createSubscriber` in its constructor:

```typescript
vi.mock('@agent-platform/redis', async () => {
  const actual =
    await vi.importActual<typeof import('@agent-platform/redis')>('@agent-platform/redis');
  return {
    ...actual,
    createBullMQPair: (handle: { duplicate: (opts?: unknown) => { disconnect: () => void } }) => {
      const qc = handle.duplicate({ maxRetriesPerRequest: null });
      const wc = handle.duplicate({ maxRetriesPerRequest: null });
      return {
        queueConnection: qc,
        workerConnection: wc,
        disconnect: () => {
          qc.disconnect();
          wc.disconnect();
        },
      };
    },
  };
});
```

The pass-through `disconnect()` is required whenever the class under test calls `this.bullMQPair.disconnect()` and a test asserts that the individual connection `disconnect` spies were called.

### GAP-008 watchdog

`startWorkerWatchdog()` (default-on in cluster mode) polls BullMQ worker connection status every 5 s. After 30 s stuck in a non-healthy state, it forces `disconnect()` to trigger ioredis reconnect. Counter: `redis.bullmq.watchdog.recover`. Timer is `.unref()`'d — does not keep the process alive. Disable with `{ watchdog: false }` in `createBullMQPair` options for standalone-only services.

### Package layout (added in redis-dual-mode feature)

| File                   | Purpose                                                                                                                 |
| ---------------------- | ----------------------------------------------------------------------------------------------------------------------- |
| `src/subscriber.ts`    | `createSubscriber(handle)` — mode-aware pub/sub connection                                                              |
| `src/lua.ts`           | `runLuaScript(client, script, keys, args)` — uniform Lua over Redis &#124; Cluster                                      |
| `src/keys.ts`          | `hashTag(...parts)`, `scanKeys(client, pattern)`                                                                        |
| `src/errors.ts`        | `RedisOperationError`, `RedisCrossSlotError`                                                                            |
| `src/observability.ts` | OTel counters: `crossslotErrors`, `movedRedirects`, `clusterFailovers`, `subscriberReconnects`, `bullmqWatchdogRecover` |

## Phase B PR-Review Fixes — 2026-05-06

### getRedisInitError()

`packages/redis/src/singleton.ts` now exports `getRedisInitError(): Error | null`. Returns the error from the last failed `initializeRedis()` call, or `null` if init succeeded or hasn't been called. Useful for health-check endpoints that need to surface the root cause when Redis is unavailable. The export is additive — no existing callers break.

### runLuaScript requires LuaScript, not a raw string

`runLuaScript<T>(client, script, keys, args)` — the `script` parameter must be a `LuaScript = { name: string; body: string; numberOfKeys: number }` object, NOT a raw string. Passing a raw string causes a TypeScript error. Use named module-level constants (not inline literals) so the `name` field is reusable and the intent is clear. Example from `distributed-lock.ts`:

```typescript
const RELEASE_SCRIPT: LuaScript = {
  name: 'distributed-lock:release',
  body: `if redis.call("GET", KEYS[1]) == ARGV[1] then ...`,
  numberOfKeys: 1,
};
const result = await runLuaScript<number>(redis, RELEASE_SCRIPT, [lock.key], [lock.value]);
```

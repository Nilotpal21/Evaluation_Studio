# Agent Learnings: @agent-platform/circuit-breaker

## Redis Dual-Mode (Standalone + Cluster) — 2026-05-05

### Lua and key design

- **`defineCommand` is not Cluster-friendly**. The author's comment at `src/scripts.ts:79` was correct — `defineCommand` on an ioredis `Cluster` instance silently fails to route commands to the right node. Replaced with `runLuaScript(client, script, keys, args)` from `@agent-platform/redis` for all 4 breaker scripts.
- **`breakerKeys(level, key)` in `src/types.ts` is the single source of truth for key shapes**. All 5 keys for a breaker instance (`state`, `failures`, `successes`, `opened_at`, `half_open_count`) are generated here with `hashTag(level, key)` so they all land in the same Redis slot. Do not construct breaker key strings anywhere else.
- **Hash tag format**: `breaker:{<level>:<key>}:state` etc. The `{}` wrapping is inert in standalone mode — keys are stored with the literal braces. No migration script needed; old keys self-expire via `reset_timeout * 2` TTL.

### File loading

- **`readFileSync` is forbidden in server code** (CLAUDE.md). `src/scripts.ts` previously used `readFileSync` to load `.lua` files at import time (blocking I/O). Replaced with `fs.promises.readFile` and top-level `await` in the module. If you need to add a new Lua script, load it the same way: `const body = await fs.promises.readFile(new URL('./lua/my-script.lua', import.meta.url), 'utf8')`.

### Constructor widening

- **`RedisCircuitBreaker` constructor accepts `RedisClient = Redis | Cluster`** (not just `Redis`). If you are adding a test and constructing `RedisCircuitBreaker` with a mock, the mock must either be an actual `Redis`/`Cluster` instance or you must stub `runLuaScript` via `vi.mock('@agent-platform/redis')`. The circuit-breaker test mock in `src/__tests__/helpers/mock-redis.ts` uses the latter pattern.

### Test pattern for mocking `runLuaScript`

```typescript
vi.mock('@agent-platform/redis', async () => {
  const actual =
    await vi.importActual<typeof import('@agent-platform/redis')>('@agent-platform/redis');
  return {
    ...actual,
    runLuaScript: vi.fn().mockImplementation(async (_client, script, keys, args) => {
      // dispatch to per-script mock handlers
    }),
  };
});
```

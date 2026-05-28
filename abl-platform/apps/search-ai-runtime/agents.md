# Agent Learnings: apps/search-ai-runtime

## 2026-05-06 — Redis Dual-Mode Phase B: cluster-safe del + getdel type

**Category**: gotcha | architecture

### Multi-key DEL throws CROSSSLOT in cluster mode

`ioredis.Cluster` does NOT auto-split multi-key `DEL` across slots (unlike `mget`/`mset` which ioredis routes per-slot). If the keys hash to different slots, `client.del(key1, key2, key3)` throws `ReplyError: CROSSSLOT Keys in request don't hash to the same slot`.

Fix: loop one key at a time. The performance difference is negligible for all current callers (≤ 3 keys each):

```typescript
async del(...keys: string[]): Promise<number> {
  if (keys.length === 1) return this.redis.del(keys[0]!);
  let deleted = 0;
  for (const key of keys) deleted += await this.redis.del(key);
  return deleted;
}
```

**File**: `src/services/cache/redis-client.ts`
**Impact**: Any new wrapper method that calls `redis.del(key1, key2, ...)` must be refactored to the per-key loop pattern when running in cluster mode.

### ioredis v5.7 types expose `getdel` natively

`ioredis` v5.7 properly types `getdel(key: string): Promise<string | null>` on both `Redis` and `Cluster`. Remove any `(this.redis as any).getdel(key)` cast — it is unnecessary and hides the type contract.

/**
 * Task 79: Cache invalidation via Redis Pub/Sub
 *
 * Requires: Redis
 * Tests that auth profile updates publish invalidation events
 * and that subscribers evict stale cache entries.
 */
import { describe, it } from 'vitest';

describe('Auth Profile Cache Invalidation — Redis Pub/Sub', () => {
  it.todo('profile update publishes invalidation event');
  it.todo('profile delete publishes invalidation event');
  it.todo('subscriber evicts matching LRU cache entry on event');
  it.todo('subscriber evicts matching Redis cache entry on event');
  it.todo('invalidation scoped to tenantId:profileId');
  it.todo('tenant-wide invalidation clears all profiles for tenant');
});

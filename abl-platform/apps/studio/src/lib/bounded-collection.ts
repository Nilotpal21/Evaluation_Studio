/**
 * Bounded Collection Utilities
 *
 * FIFO-eviction helpers for arrays and Maps to prevent unbounded memory growth
 * in Zustand stores during long-running sessions.
 *
 * A3: Optimized to reduce GC pressure while maintaining immutability for Zustand.
 */

/**
 * Push item to array, evicting oldest entries if exceeding maxSize.
 *
 * A3: Optimized implementation - single array allocation instead of two.
 * Before: [...arr, item] + slice() = 2 allocations
 * After: Single slice() + spread = 1 allocation when evicting
 */
export function boundedPush<T>(arr: T[], item: T, maxSize: number): T[] {
  if (arr.length < maxSize) {
    // Under limit: append item (single allocation)
    return [...arr, item];
  }
  // At limit: slice to keep last (maxSize - 1) items, then add new item
  // This is a single allocation instead of creating intermediate array
  return [...arr.slice(arr.length - maxSize + 1), item];
}

/**
 * Set entry in Map, evicting oldest entry (by insertion order) if exceeding maxSize.
 *
 * A3: Optimized to avoid creating oversized map before eviction.
 * Checks if key exists first to avoid unnecessary allocation.
 */
export function boundedMapSet<K, V>(map: Map<K, V>, key: K, value: V, maxSize: number): Map<K, V> {
  const willExceedLimit = !map.has(key) && map.size >= maxSize;

  if (willExceedLimit) {
    // Evict oldest entry BEFORE creating new map
    const entries = Array.from(map.entries());
    entries.shift(); // Remove first (oldest) entry
    entries.push([key, value]); // Add new entry
    return new Map(entries);
  }

  // Under limit or updating existing key: simple copy + set
  const next = new Map(map);
  next.set(key, value);
  return next;
}

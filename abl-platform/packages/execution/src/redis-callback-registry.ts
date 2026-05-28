/**
 * RedisCallbackRegistry — Redis-backed implementation of CallbackRegistry.
 *
 * Uses a simple key-value pattern with TTL for auto-expiry. The critical
 * claim() operation uses a Lua script for atomic GET + DEL, ensuring
 * exactly-once callback processing across all pods.
 *
 * Key pattern: callback:{callbackId} → JSON(CallbackRegistryEntry)
 */

import { runLuaScript, type LuaScript, type RedisClient } from '@agent-platform/redis';
import type { CallbackRegistry, CallbackRegistryEntry } from './callback-registry.js';

// Re-export for siblings that use the same client without re-importing the
// dual-mode redis package.
export type { RedisClient };

/**
 * Lua script: atomically GET + DEL a key.
 * Returns the value if found, nil otherwise.
 * This guarantees exactly-once claim — no two pods can both get the value.
 */
const SCRIPT_CLAIM: LuaScript = {
  name: 'callback_registry.claim',
  numberOfKeys: 1,
  body: `
local val = redis.call('GET', KEYS[1])
if val then
  redis.call('DEL', KEYS[1])
  return val
end
return nil
`,
};

export class RedisCallbackRegistry implements CallbackRegistry {
  private readonly keyPrefix = 'callback';

  constructor(private readonly redis: RedisClient) {}

  async register(entry: CallbackRegistryEntry): Promise<void> {
    const key = `${this.keyPrefix}:${entry.callbackId}`;
    const ttlMs = entry.expiresAt - Date.now();
    if (ttlMs <= 0) return; // Already expired, don't register

    await this.redis.set(
      key,
      JSON.stringify(entry),
      'PX',
      ttlMs,
      'NX', // Only set if not exists (idempotent)
    );
  }

  async lookup(callbackId: string): Promise<CallbackRegistryEntry | null> {
    const key = `${this.keyPrefix}:${callbackId}`;
    const data = await this.redis.get(key);
    return data ? (JSON.parse(data) as CallbackRegistryEntry) : null;
  }

  async claim(callbackId: string): Promise<CallbackRegistryEntry | null> {
    const key = `${this.keyPrefix}:${callbackId}`;
    const result = await runLuaScript<string | null>(this.redis, SCRIPT_CLAIM, [key], []);
    return result ? (JSON.parse(result) as CallbackRegistryEntry) : null;
  }

  async remove(callbackId: string): Promise<void> {
    await this.redis.del(`${this.keyPrefix}:${callbackId}`);
  }
}

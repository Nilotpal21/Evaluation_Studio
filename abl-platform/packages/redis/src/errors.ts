/**
 * Redis-specific error types.
 *
 * All errors extend the platform's centralized `AppError` so they participate
 * in the structured error envelope ({ success: false, error: { code, message } })
 * and carry HTTP status hints for route handlers.
 */

import { AppError } from '@agent-platform/shared-kernel';

export class RedisOperationError extends AppError {
  constructor(message: string, cause?: unknown, code = 'REDIS_OPERATION_ERROR') {
    super(message, { code, statusCode: 503, cause });
  }
}

/**
 * Thrown when a Lua script's KEYS span multiple cluster slots in cluster mode.
 *
 * This is a programming error — it means the keys passed to `runLuaScript` are
 * not hash-tagged consistently. Callers should NOT retry; the call would just
 * fail again. Fix the key construction (use `hashTag(...)`) instead.
 */
export class RedisCrossSlotError extends RedisOperationError {
  public readonly scriptName: string;
  public readonly keys: readonly string[];

  constructor(scriptName: string, keys: string[], cause?: unknown) {
    // Key names are omitted from the message (they contain tenant-scoped identifiers
    // that must not appear in API error responses). Use this.keys for debugging.
    super(
      `Lua script "${scriptName}" keys span multiple cluster slots (${keys.length} keys)`,
      cause,
      'REDIS_CROSSSLOT_ERROR',
    );
    this.scriptName = scriptName;
    this.keys = [...keys];
  }
}

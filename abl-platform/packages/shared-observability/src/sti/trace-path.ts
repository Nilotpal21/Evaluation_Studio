/**
 * tracePath() — Higher-Order Function wrapper
 *
 * Wraps an async function to automatically record its execution
 * as an STR entry. Reads the current traceId from AsyncLocalStorage
 * and records path, duration, and outcome.
 *
 * Kill switch: STI_ENABLED env var (default: false / disabled).
 * Overhead: <10us — just an ALS read + array push.
 * Exception safety: wrapper errors never propagate to the caller.
 */

import { getCurrentTraceId } from '../context.js';
import { STRBuffer } from './str-buffer.js';

// ---------------------------------------------------------------------------
// Singleton buffer (shared across all tracePath wrappers in this process)
// ---------------------------------------------------------------------------

let sharedBuffer: STRBuffer | undefined;

function getBuffer(): STRBuffer {
  if (!sharedBuffer) {
    sharedBuffer = new STRBuffer();
  }
  return sharedBuffer;
}

/**
 * Replace the shared STR buffer (useful for testing).
 * Returns the previous buffer instance, if any.
 */
export function setSharedSTRBuffer(buffer: STRBuffer | undefined): STRBuffer | undefined {
  const prev = sharedBuffer;
  sharedBuffer = buffer;
  return prev;
}

/**
 * Get the shared STR buffer instance.
 */
export function getSharedSTRBuffer(): STRBuffer {
  return getBuffer();
}

// ---------------------------------------------------------------------------
// Kill switch
// ---------------------------------------------------------------------------

function isSTIEnabled(): boolean {
  return process.env.STI_ENABLED === 'true';
}

// ---------------------------------------------------------------------------
// tracePath HOF
// ---------------------------------------------------------------------------

/**
 * Wrap an async function so that every invocation is recorded as an STR entry
 * under the given path. The wrapper is transparent: same signature in, same
 * result out, same exceptions thrown.
 *
 * When STI_ENABLED is not 'true', returns the original function unchanged
 * (zero overhead).
 */
export function tracePath<T extends (...args: any[]) => Promise<any>>(
  path: string,
  fn: T,
  depth = 0,
): T {
  if (!isSTIEnabled()) return fn;

  const traced = async function (this: any, ...args: any[]) {
    // Obtain trace context; if wrapper internals fail, fall back to raw fn call.
    let traceId: string | undefined;
    try {
      traceId = getCurrentTraceId();
    } catch {
      return fn.apply(this, args);
    }
    if (!traceId) return fn.apply(this, args);

    let entry: ReturnType<STRBuffer['recordEntry']>;
    try {
      const buffer = getBuffer();
      entry = buffer.recordEntry(traceId, path, depth);
    } catch {
      return fn.apply(this, args);
    }

    const start = process.hrtime.bigint();
    try {
      const result = await fn.apply(this, args);
      entry.markSuccess();
      return result;
    } catch (err) {
      entry.markError();
      throw err;
    } finally {
      const durationUs = Number(process.hrtime.bigint() - start) / 1000;
      entry.recordDuration(durationUs);
    }
  } as unknown as T;

  return traced;
}

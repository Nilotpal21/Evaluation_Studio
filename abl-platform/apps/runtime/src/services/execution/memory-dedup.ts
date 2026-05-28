/**
 * REMEMBER Trigger Dedup Helpers
 *
 * Pure functions used by `memory-integration.evaluateRememberAfterStateChange`
 * to avoid redundant FactStore writes when a trigger's computed value is
 * unchanged from the prior stored value.
 *
 * Bruce feedback 3.1: without dedup, REMEMBER triggers were writing 2–4
 * redundant values per turn per session.
 *
 * Depth-capped deep equal is the safety bound: comparison never recurses
 * past `depthCap` levels. Values that would require deeper comparison are
 * treated as "not equal" so the write still happens (safe fallback).
 */

/** Default recursion depth cap when no project setting is provided. */
export const DEFAULT_DEDUP_MAX_DEPTH = 8;

/** Minimum permitted dedup depth cap (must compare at least the top level). */
export const MIN_DEDUP_MAX_DEPTH = 1;

/** Maximum permitted dedup depth cap (guards against pathological configs). */
export const MAX_DEDUP_MAX_DEPTH = 32;

export interface RememberOperation {
  key: string;
  value: unknown;
  ttl?: string;
}

export interface DedupResult {
  /** Operations that changed or are new — dispatch these to the FactStore */
  toWrite: RememberOperation[];
  /** Operations that match the current value — skip */
  skipped: RememberOperation[];
}

/**
 * Value-equality comparison with a fixed recursion cap.
 *
 * Treats `null`, `undefined`, and missing as interchangeable (all "unset").
 * When recursion would exceed `depthCap`, returns `false` (safer: forces a
 * write rather than silently skipping a potentially-changed value).
 */
export function deepEqualWithCap(a: unknown, b: unknown, depthCap: number): boolean {
  return deepEqualInner(a, b, 0, depthCap);
}

function deepEqualInner(a: unknown, b: unknown, depth: number, cap: number): boolean {
  // Treat null/undefined as equal ("unset").
  if (a == null && b == null) return true;
  if (a == null || b == null) return false;

  // Primitives: strict equality.
  const ta = typeof a;
  const tb = typeof b;
  if (ta !== tb) return false;
  if (ta !== 'object') return a === b;

  // Past depth cap → bail out safely.
  if (depth >= cap) return false;

  // Arrays.
  const aIsArr = Array.isArray(a);
  const bIsArr = Array.isArray(b);
  if (aIsArr !== bIsArr) return false;
  if (aIsArr && bIsArr) {
    const arrA = a as unknown[];
    const arrB = b as unknown[];
    if (arrA.length !== arrB.length) return false;
    for (let i = 0; i < arrA.length; i++) {
      if (!deepEqualInner(arrA[i], arrB[i], depth + 1, cap)) return false;
    }
    return true;
  }

  // Plain objects.
  const keysA = Object.keys(a as Record<string, unknown>);
  const keysB = Object.keys(b as Record<string, unknown>);
  if (keysA.length !== keysB.length) return false;
  const sortedA = keysA.slice().sort();
  const sortedB = keysB.slice().sort();
  for (let i = 0; i < sortedA.length; i++) {
    if (sortedA[i] !== sortedB[i]) return false;
  }
  for (const key of sortedA) {
    if (
      !deepEqualInner(
        (a as Record<string, unknown>)[key],
        (b as Record<string, unknown>)[key],
        depth + 1,
        cap,
      )
    ) {
      return false;
    }
  }
  return true;
}

/**
 * Partition REMEMBER operations into writes and skips based on current
 * stored values. Operations whose target key has no entry in `currentValues`
 * always write. Operations whose value is deep-equal to the stored value
 * are skipped.
 */
export function filterUnchangedOperations(
  operations: RememberOperation[],
  currentValues: Map<string, unknown>,
  depthCap: number,
): DedupResult {
  const toWrite: RememberOperation[] = [];
  const skipped: RememberOperation[] = [];

  for (const op of operations) {
    if (!currentValues.has(op.key)) {
      toWrite.push(op);
      continue;
    }
    const current = currentValues.get(op.key);
    if (deepEqualWithCap(op.value, current, depthCap)) {
      skipped.push(op);
    } else {
      toWrite.push(op);
    }
  }

  return { toWrite, skipped };
}

/** Clamp a depth-cap value to the valid range. */
export function clampDedupDepthCap(value: number | null | undefined): number {
  if (value == null || !Number.isFinite(value)) return DEFAULT_DEDUP_MAX_DEPTH;
  const int = Math.floor(value);
  if (int < MIN_DEDUP_MAX_DEPTH) return MIN_DEDUP_MAX_DEPTH;
  if (int > MAX_DEDUP_MAX_DEPTH) return MAX_DEDUP_MAX_DEPTH;
  return int;
}

/**
 * Dual-read merger — pure function that unions rows from Mongo + ClickHouse
 * and dedups by a caller-supplied key (LLD §5.1, HLD §4 concern #5).
 *
 * Semantics
 * ---------
 *  - UNION: every row from both inputs is considered.
 *  - DEDUP by `keyFn(row)`. On overlap, **Mongo wins**. Rationale: during
 *    the migration, the Mongo row is the source of truth — the CH row is a
 *    projection of events that may be eventually consistent with the
 *    current state (HLD §4 concern #5).
 *  - SORT DESC by the supplied `sortFn`. For executions we sort by
 *    `startedAt`; for human tasks we sort by `requestedAt`/`createdAt` as
 *    the caller specifies.
 *
 * Location rationale
 * ------------------
 * Kept in `apps/workflow-engine/src/persistence/` because this is a novel
 * pattern. The existing auth-profile dual-read at
 * `packages/shared-auth-profile/src/dual-read.ts` is a binary A-OR-B
 * branching function, not a UNION+dedup merger. If a second Mongo→CH
 * migration follows, this function can be promoted verbatim to
 * `packages/database/src/migration-helpers/` — flagged as an LLD §7 open
 * question, not blocking Phase 5.
 *
 * Pure function: no logging, no I/O, no metrics. Metrics are emitted by
 * the hybrid-reader callers (LLD §5.2, §5.3).
 */

/**
 * Union Mongo + ClickHouse rows, dedup by `keyFn` (Mongo wins on overlap),
 * sort descending by `sortFn`.
 *
 * @param mongoRows   Rows from the authoritative Mongo collection.
 * @param chRows      Rows from the `_latest` CH projection.
 * @param keyFn       Returns the dedup key (e.g. `row => row.executionId`).
 * @param sortFn      Returns a sortable value — rows with higher values
 *                    come first. Common choices: `row => Date.parse(row.startedAt)`
 *                    or `row => row.startedAt ?? ''`.
 */
export function mergeMongoAndCH<T>(
  mongoRows: readonly T[],
  chRows: readonly T[],
  keyFn: (row: T) => string,
  sortFn: (row: T) => number | string,
): T[] {
  // Mongo first ⇒ Mongo wins on key collision.
  const byKey = new Map<string, T>();
  for (const row of mongoRows) {
    byKey.set(keyFn(row), row);
  }
  for (const row of chRows) {
    const key = keyFn(row);
    if (!byKey.has(key)) {
      byKey.set(key, row);
    }
  }

  const merged = Array.from(byKey.values());
  merged.sort((a, b) => {
    const va = sortFn(a);
    const vb = sortFn(b);
    if (va === vb) return 0;
    return va < vb ? 1 : -1;
  });
  return merged;
}

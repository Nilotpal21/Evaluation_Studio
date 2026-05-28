# Slice 4 PR Review — Round 1

**Commit**: `fc4374f84` on `develop`
**Reviewer**: pr-reviewer agent (Claude Opus 4.6)
**Date**: 2026-04-18

## Analyze-Counter-Fix Audit Trail

| #   | Finding                                           | Severity | Action                          | Evidence                                                                                                                                                                                                                                |
| --- | ------------------------------------------------- | -------- | ------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 1   | TTL refresh skipped on dedup                      | MEDIUM   | CONFIRMED (acceptable with doc) | See detailed analysis below                                                                                                                                                                                                             |
| 2   | Cross-tenant leak via getMany keys                | LOW      | COUNTERED                       | MongoDBFactStore.ownerFilter() at mongodb-fact-store.ts:109-116 includes tenantId+userId+projectId on every query                                                                                                                       |
| 3   | getMany failure cascades to no-dedup              | LOW      | COUNTERED                       | try/catch at memory-integration.ts:375-381 catches all errors; falls into outer catch which logs and returns (fire-and-forget)                                                                                                          |
| 4   | Skipped ops missing memory_trigger_evaluated      | LOW      | COUNTERED                       | By design: skipped ops emit `memory_dedup_skipped` (always-on) instead. `memory_trigger_evaluated` is for writes. Dashboard semantics are clearer with distinct event types.                                                            |
| 5   | N+1 query risk per trigger                        | LOW      | COUNTERED                       | One `getMany()` per scope per turn at lines 304. For 10 triggers in user scope: 1 DB query. For mixed user+project: 2 queries max.                                                                                                      |
| 6   | Config change window — cached depth cap           | INFO     | CONFIRMED (acceptable)          | `resolvedDedupMaxDepth` cached on session (line 850). Change takes effect on new sessions only. Same pattern as `resolvedCompactionThreshold`. Acceptable.                                                                              |
| 7   | PII exposure in traces                            | LOW      | COUNTERED                       | `memory_dedup_skipped` at line 327-337 emits only `trigger` (key name) and `scope`. No value. `memory_trigger_evaluated` at line 361-369 emits value for writes — this is pre-existing behavior, not new exposure.                      |
| 8   | Breaking change — memory field on ProjectSettings | LOW      | COUNTERED                       | Additive: `memory: { type: Schema.Types.Mixed, default: null }` at project-settings.model.ts:132. Existing documents get null. PUT callers that don't send `memory` are unaffected (line 43 of repo: `if (data.memory !== undefined)`). |
| 9   | vi.mock of platform components                    | LOW      | COUNTERED                       | Lock tests use `InMemoryFactStore` directly (imported, not mocked). `vi.spyOn` on instance methods is acceptable — not `vi.mock`.                                                                                                       |
| 10  | Error handling — fire-and-forget preserved        | LOW      | COUNTERED                       | Outer try/catch at lines 219/375-381 catches everything, logs via `log.error`, emits `memory_error` trace, never throws. Same pattern as pre-existing code.                                                                             |

## Detailed Finding Analysis

### Finding 1: TTL Refresh Skipped on Dedup (MEDIUM)

**Analysis**: When a REMEMBER trigger has a TTL (e.g., `TTL: "90d"`) and fires with the same value as currently stored, the dedup logic skips the `set()` call. This means the fact's `expiresAt` timestamp is NOT refreshed. If a user interacts every day for 90 days, the fact set on day 1 expires on day 91 — even though triggers fired every day.

**Impact assessment**:

- The `RememberTrigger` interface has an optional `ttl` field (schema.ts:1302)
- MongoDBFactStore.set() at mongodb-fact-store.ts:134 computes `expiresAt` from TTL
- The default TTL is 90 days (mongodb-fact-store.ts:39)
- For active users, this means facts could expire while they're actively using the system

**Severity**: MEDIUM (not CRITICAL) because:

1. Most REMEMBER triggers in the codebase don't use explicit TTL (it's optional)
2. The default 90d TTL from MongoDBFactStore is long enough that most sessions won't hit this
3. The dedup specifically saves redundant writes (2-4 per turn) which is the primary goal
4. A fix is straightforward: compare TTL in addition to value, or always refresh TTL on match

**Recommendation**: Document this as a known limitation. If TTL refresh is needed, a follow-up slice should add TTL-aware comparison: skip only when value matches AND remaining TTL > threshold (e.g., >50% of original TTL remaining). This is NOT a commit blocker.

### Finding 2: Tenant Isolation (COUNTERED)

The `getMany()` calls at memory-integration.ts:304 use `session.factStore` and `session.projectFactStore`. These are constructed via:

- `createMongoDBFactStore(tenantId, userId, projectId)` at runtime-session-identity.ts:59
- `createProjectFactStore(tenantId, projectId)` at runtime-session-identity.ts:64

Every query in MongoDBFactStore goes through `ownerFilter()` which always includes `tenantId`, `userId`, `projectId`, and `scope`. Keys passed to `getMany()` are just path strings (e.g., "user.pref") — the store handles isolation. No cross-tenant risk.

### Finding 3: getMany Failure Mode (COUNTERED)

If `targetStore.getMany(keys)` throws at line 304, the error propagates up to the outer try/catch at line 375. This catch:

1. Logs `evaluateRememberAfterStateChange failed` via `log.error`
2. Emits a `memory_error` trace event
3. Returns void (fire-and-forget)

All writes proceed without dedup in this case — matching old behavior (before dedup, writes always happened). This is the correct fail-open strategy.

### Finding 5: Performance — One getMany Per Scope (COUNTERED)

The bucketing at lines 278-321 groups operations by scope first:

- `userBucket` and `projectBucket` are built
- One `getMany()` per non-empty bucket
- Maximum 2 DB queries per REMEMBER evaluation (user scope + project scope)

For the common case (all user-scoped triggers), this is exactly 1 DB query regardless of trigger count. Verified correct.

### Finding 6: Config Change Window (CONFIRMED — acceptable)

`resolveDedupDepthCap` at line 828 caches on `session.resolvedDedupMaxDepth`. This matches the existing pattern for `resolvedCompactionThreshold` (types.ts:346). An operator changing `dedupMaxDepth` mid-session won't see the effect until new sessions start. This is acceptable for a depth-cap setting — it's a tuning knob, not a security control.

## Verification Results

- **Build**: PASS (`pnpm build --filter=@agent-platform/runtime` — 27 tasks, 0 failures)
- **Lock tests**: PASS (35/35 across 6 test files: remember-dedup-deep-equal, remember-dedup-pure-helper, remember-dedup-no-write-on-same-value, remember-dedup-write-on-change, remember-dedup-trace-emission, flow-set-remember-regressions)
- **Memory integration tests**: PASS (15/15 in memory-integration.test.ts)
- **Memory decision traces**: PASS (28/28 in memory-decision-traces.test.ts)
- **Memory executor**: PASS (7/7 in memory-executor.test.ts)
- **Flow intents/digressions**: PASS (15/15)
- **Total**: 85/85 tests pass, 0 failures
- **Prettier**: PASS (all 7 files formatted)
- **Jira**: PASS (commit uses ABLP-411, matching the TDD plan)

## OpenAI Review

OpenAI reviewer MCP tool not available. Skipped.

## Code Quality Assessment

### memory-dedup.ts (NEW, 138 LOC) — COMPLETE

- Pure functions, zero side effects, fully tested
- Depth cap safety: exceeds cap returns false (forces write)
- null/undefined treated as equal (correct for "unset" semantics)
- Array order-sensitive, object order-independent (correct)
- Constants well-named with MIN/MAX/DEFAULT

### memory-integration.ts (MODIFIED, +131/-30) — COMPLETE

- Clean bucket-then-batch pattern
- Proper scope routing via scopeMap
- Skip traces always-on (correct for dashboard observability)
- Write traces verbosity-gated (preserving existing semantics)
- `isDatabaseAvailable()` gate prevents mongoose buffering hangs in tests
- Dynamic import of `findProjectSettings` avoids circular dependency

### project-settings.ts (MODIFIED, +25) — COMPLETE

- Zod schema validates dedupMaxDepth as int in [1, 32], nullable
- Manual validation block for PUT mirrors existing patterns
- GET response includes `memory` field with null default

### project-settings-repo.ts (MODIFIED, +3) — COMPLETE

- `memory` added to upsert $set with `undefined` guard
- Type imported from database package

### project-settings.model.ts (MODIFIED, +14) — COMPLETE

- `IProjectMemorySettings` interface with JSDoc
- Schema field: `Mixed, default: null`
- Interface property on IProjectSettings: `memory: IProjectMemorySettings | null`

### types.ts (MODIFIED, +4) — COMPLETE

- `resolvedDedupMaxDepth?: number` with JSDoc
- Follows existing pattern (resolvedCompactionThreshold, resolvedEnableThinking)

### index.ts (MODIFIED, +3) — COMPLETE

- Exports `IProjectMemorySettings` from project-settings.model.ts barrel

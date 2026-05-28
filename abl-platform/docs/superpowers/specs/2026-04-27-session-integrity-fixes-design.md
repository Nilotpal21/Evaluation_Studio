# Session Integrity Fixes — Design Spec

**Date:** 2026-04-27
**Branch:** fix/remove-stale-connector-dockerfile-refs (rebased onto origin/develop)
**Sources:** Code audit (image findings 1-11) + live session-audit-report.md + codebase exploration

---

## Problem Statement

The runtime session storage layer has accumulated 16 confirmed integrity defects spanning four concerns:

1. **Field parity gaps** — fields written into `SessionData` in memory are silently dropped when persisted to Redis or MongoDB cold store, meaning cross-pod resume and cold restores produce structurally different sessions than the original.
2. **Timestamp drift** — `lastActivityAt` is overwritten with `Date.now()` at persist time (not interaction time); `createdAt` drifts to the Mongoose document creation timestamp on cold restore.
3. **Lifecycle & event integrity** — analytics sessions accumulate as zombies (`endedAt=null`), `agent.exited` schema rejects valid result values, WS frames omit `executionId` and `agentName`, `conversationPhase` stays stuck at `"start"`.
4. **Operational hygiene** — Redis runs with `noeviction` + no BullMQ key TTLs, reap path leaks tracers/memory bridges/paused executions, debug instrumentation in hot paths, noisy logs.

---

## Scope

All 16 active findings from the audit. Retired/reclassified findings (items 17-24 in the audit report) are excluded.

---

## Architecture

The fix is structured as **6 isolated, sequentially-committed clusters**. Each cluster touches at most 3 packages and 40 files, satisfying the CLAUDE.md commit-scope guard. Each cluster has its own integration tests — no mocking of platform components.

---

## Cluster 1 — Redis Field Parity

### Problem

`agentRawVersions`, `backtrackCounts`, `constraintCollectState`, `moduleProvenance` are written to `SessionData` by the executor (snapshot path lines 4585-4600) but are absent from `SESSION_HASH_FIELDS` / `SESSION_JSON_FIELDS` in `redis-session-store.ts` (lines 109-163). They are silently dropped on every Redis write and not restored in `hashToSession()`. Cross-pod resume loses all four fields.

### Fix

- Add `agentRawVersions`, `backtrackCounts`, `constraintCollectState`, `moduleProvenance` to `SESSION_JSON_FIELDS`
- Add corresponding restore logic in `hashToSession()` for all four fields
- `moduleProvenance` is potentially large — add it to `COMPRESSIBLE_FIELDS` (alongside `threads`, `dataValues`)
- Add `agentRawVersions` to `ENCRYPTED_FIELDS` alongside `authToken` (contains version strings that could identify internal deployments)

### Files

- `apps/runtime/src/services/session/redis-session-store.ts`

---

## Cluster 2 — Cold Store Field Parity

### Problem (8 sub-issues)

**2a. Missing fields in stateData blob:**
`piiVaultData`, `piiRedactionConfig`, `gatherFieldsCollected`, `agentRawVersions`, `moduleProvenance` are not in the `stateData` blob written by `session-state-repo.ts:upsert()` (lines 164-191). Cold restore at lines 552-596 does not return these fields.

**2b. `userId` not mapped back on cold restore:**
`doc.userId` is stored as a top-level Mongo field but is never included in the return value of `docToSessionData()`.

**2c. `authToken` intentionally absent from cold store:**
`authToken` is stored encrypted in Redis but not in MongoDB cold store. This is an intentional security decision (short-lived token, minimize blast radius). The absence must be explicitly documented at the restore callsite so callers handle `authToken === undefined` after cold restore.

**2d. `compilationHash` hardcoded to `null` on cold restore:**
`docToSessionData()` always returns `compilationHash: null` (line 556). The hash is not stored in the `stateData` blob. Sessions cold-restored can't benefit from compilation caches until recompilation occurs.

**2e. `irSourceHash` skew risk:**
Cold restore returns `irSourceHash` from the active thread as it was at last cold persist. If the agent was redeployed between persist and restore, the session continues with a stale hash. The restore path must compare the restored hash against the current compiled agent and invalidate if mismatched.

**2f. `conversationHistory` cross-thread loss:**
Session-level `conversationHistory` (the merged sliding window) is never written to cold store. Cold restore rebuilds it from `threads[activeThreadIndex]?.conversationHistory || []` only (line 557). Multi-thread/handoff sessions lose all history except the active thread on cold restore.

**2g. `pendingAwaitAttachment` not rehydrated:**
Stored correctly in Mongo thread `threadMetadata` buffer (line 158) and Redis `threads` JSON blob, but not mapped back in `rehydrateSession()` thread deserialization (lines 2277-2297). Suspended `AWAIT_ATTACHMENT` threads lose their pending attachment state after rehydration.

**2h. `irData` / `compilationData` dead schema:**
Both fields are declared in the Mongo schema (model.ts:126-127) and listed in `fieldsToEncrypt` (model.ts:148) but `upsert()` never writes them. Remove both from `fieldsToEncrypt` to eliminate dead encryption overhead and add a schema comment explaining they are reserved for future use.

### Fix

- Add to stateData blob: `piiVaultData`, `piiRedactionConfig`, `gatherFieldsCollected`, `agentRawVersions`, `moduleProvenance`, `compilationHash`
- Add to `docToSessionData()` return: `userId` (from `doc.userId`), all newly-added stateData fields
- Add explicit code comment at `authToken` restore site: `// authToken is intentionally not persisted to cold store — callers must handle undefined`
- Add `originalCreatedAt` to stateData blob (store `session.createdAt` epoch ms), restore it in `docToSessionData()` instead of using `new Date(doc.createdAt).getTime()`
- On cold restore: compare `irSourceHash` from stateData against compiled agent hash — if mismatched, set `irSourceHash` to compiled hash and `compilationHash` to null (forces recompile)
- Merge `conversationHistory`: on cold restore, rebuild session-level history by concatenating thread histories in thread-stack order (not just active thread)
- Add `pendingAwaitAttachment` to thread deserialization in `rehydrateSession()`
- Remove `irData` and `compilationData` from `fieldsToEncrypt` in session-state.model.ts; add schema comment

### Files

- `apps/runtime/src/services/session/session-state-repo.ts`
- `apps/runtime/src/services/runtime-executor.ts` (rehydrateSession thread deserialization)
- `packages/database/src/models/session-state.model.ts`

---

## Cluster 3 — Timestamp Faithfulness

### Problem (3 sub-issues)

**3a. `lastActivityAt` overwritten at persist time:**
Three independent paths rewrite `lastActivityAt` with the current clock:

- `runtime-executor.ts:4565` — snapshot: `lastActivityAt: Date.now()`
- `session-service.ts:266` — saveSession spread: `lastActivityAt: Date.now()`
- `session-state-repo.ts:421, 493` — cold-store `touch()`: `$set: { lastActivityAt: new Date() }`

The true user-interaction timestamp is set at `runtime-executor.ts:~2778` (`session.lastActivityAt = new Date()`). Every subsequent persist path overwrites this with the persist-time clock. Analytics recency and idle TTL calculations are biased toward "time of last persist", not "time of last user activity".

**3b. `createdAt` drift on cold restore:**
`docToSessionData()` line 593 returns `createdAt: new Date(doc.createdAt).getTime()`. `doc.createdAt` is set by Mongoose `timestamps: true` — it is the first cold upsert time, not the original session creation time. A session created at T=0 that is first cold-persisted at T=60s will report `createdAt=T+60s` after cold restore.

### Fix

- `runtime-executor.ts:4565` — change to `lastActivityAt: session.lastActivityAt?.getTime() ?? Date.now()`
- `session-service.ts:266` — remove `lastActivityAt: Date.now()` from the `updated` spread; preserve `session.lastActivityAt`
- `session-state-repo.ts touch()` — use the `session.lastActivityAt` passed in, not `new Date()`; only use `new Date()` as fallback when no session is available
- Cold store stateData: add `originalCreatedAt: session.createdAt` (number, epoch ms) to the blob
- `docToSessionData()` — return `createdAt: stateObj.originalCreatedAt ?? new Date(doc.createdAt).getTime()` (fallback for existing docs without the field)

### Files

- `apps/runtime/src/services/runtime-executor.ts`
- `apps/runtime/src/services/session/session-service.ts`
- `apps/runtime/src/services/session/session-state-repo.ts`

---

## Cluster 4 — Lifecycle & Event Integrity

### Problem (6 sub-issues)

**4a. Zombie analytics sessions (`endedAt=null`):**
Live audit confirmed 11 `status='active'` analytics sessions with `endedAt=null`. The WS handler's resumable-disconnect path (`handler.ts:1339-1345`) returns without calling `endSession()` or updating the analytics record. Reactivation (`handler.ts:185-189`) explicitly clears `endedAt` and sets `status='active'`. A reactivated session that is then disconnected with `disconnectBehavior !== 'end'` will have `endedAt=null` indefinitely.

**4b. `agent.exited` schema mismatch:**
Schema (`agent-events.ts:33`) currently enumerates `['completed', 'continue', 'constraint_blocked', 'handoff', 'delegate', 'error']`. The executor also emits `'escalate'` (line 3427) and various `flowResult.action?.type` values. `'escalate'` is the only confirmed missing value — add it to the enum.

**4c. `executionId` absent from client-facing WS frames:**
`response_start`, `response_end`, and `status_update` frames do not carry `executionId`. Clients cannot correlate streaming frames to a specific execution.

**4d. `agentName` absent from `agent_response` and `session_updated` events:**
Live-confirmed: both events carry metadata but omit `agentName`, making it impossible to attribute responses to specific agents in multi-agent sessions.

**4e. `conversationPhase` stuck at `"start"` after completed turn:**
Live-confirmed: `conversationPhase` remains `"start"` after a full reasoning + tool-call turn. The phase transition must be fired after execution completes; trace the signal path to find where `conversationPhase` should be updated to `"active"` and wire it.

**4f. Reap vs endSession cleanup gap:**
`reapStaleSessions()` (lines 1032-1130) is missing:

- `after_agent` lifecycle hook execution
- `_tracerRegistry.remove()` (tracer memory leak)
- `getMemoryBridgeRegistry().unregister()` (memory bridge leak)
- `svc.deleteSession()` (reaped sessions remain in Redis until TTL)
- `getPausedExecutionStore().cleanupSession()` (paused execution leak)

`endSession()` is missing: `realtimeVoiceExecutors.delete()` (minor gap in the other direction).

### Fix

- **4a:** On resumable disconnect, call `updateSession(dbSid, { status: 'idle', endedAt: null }, tid)` before returning. `idle` is part of the existing `Session.status` enum and keeps resumable sessions non-terminal while preventing them from appearing as active zombies. On reactivation, set `{ status: 'active', endedAt: null }` (existing behavior preserved for the reactivation side).
- **4b:** Add `'escalate'` to the `agent.exited` result enum in `agent-events.ts`.
- **4c:** Pass `executionId` from the execution context into `response_start`/`response_end`/`status_update` frame builders in `handler.ts`.
- **4d:** Add `agentName` to `agent_response` and `session_updated` event payloads.
- **4e:** After execution completes and `stateUpdates` are available, update `session.state.conversationPhase` to `'active'` if it is still `'start'` and the turn produced a non-empty response.
- **4f:** Extract `_cleanupSessionResources(sessionId, session)` private method on `RuntimeExecutor` containing the shared cleanup steps. Both `endSession()` and `_doReap()` call it. Add `realtimeVoiceExecutors.delete()` to `endSession()` as well (closes the minor gap in that direction).

### Files

- `apps/runtime/src/websocket/handler.ts`
- `packages/eventstore/src/schema/events/agent-events.ts`
- `apps/runtime/src/services/runtime-executor.ts`

---

## Cluster 5 — Redis Operational Hygiene

### Problem (3 sub-issues)

**5a. Redis `maxmemory=0` + `noeviction` + BullMQ keys with TTL=-1:**
Live audit: `DBSIZE=5140`; 5031 BullMQ keys; 5024 with `TTL=-1`. Redis will grow unboundedly. On memory pressure, it will OOM or reject writes (noeviction policy).

**5b. Two-round-trip consistency gap in `saveAndReplaceConversation()`:**
`redis-session-store.ts:578-634`: session hash is saved via Lua (atomic), then conversation list is replaced via a separate pipeline. A crash between the two leaves the session at new version but with a stale conversation list. Self-healing comment exists in the code but no test covers the recovery path.

**5c. Write amplification — multiple cold upserts in quick succession:**
Live audit: a short debug session triggered v1→v2→v3 cold upserts within seconds. `coldPersistDebounceMs` now defaults to 2000ms in both runtime config and `DEFAULT_SESSION_CONFIG`, with a schema floor of 500ms to prevent accidental write amplification.

### Fix

- **5a:** Add Redis configuration documentation to `docs/guides/redis-config.md` specifying `maxmemory-policy=allkeys-lru` and BullMQ job TTL settings. Add BullMQ default `removeOnComplete: { age: 86400 }` and `removeOnFail: { age: 86400 * 7 }` to BullMQ queue defaults in the runtime's queue initialization code.
- **5b:** Add a comment and integration test that verifies the self-healing behavior: if hash version advances but conversation list is stale, the next save overwrites both correctly.
- **5c:** Change the `coldPersistDebounceMs` config minimum from `min(0)` to `min(500)` in `config/index.ts`. Update default from 1000 to 2000.

### Files

- `apps/runtime/src/config/index.ts`
- BullMQ queue initialization file (to be located during implementation)
- `docs/guides/redis-config.md` (new file)

---

## Cluster 6 — Observability & UX Correctness

### Problem (5 sub-issues)

**6a. TTL documentation wrong:**
Any document stating Redis TTL=30min or cold TTL=7 days is incorrect. Actual defaults: 24h hot, 90-day cold (`config/index.ts:74,76`).

**6b. `interactionContext` fields remain null:**
Live-confirmed: `language=null`, `locale=null`, `timezone=null`, `confidence=low` after a completed turn. The resolver is not wired into the session lifecycle. Root cause investigation required.

**6c. `agentVersions={}` in dev mode:**
Live-confirmed: `agent_response` and `session_updated` carry `agentVersions={}` when agent is compiled from working copy. Emit `{ [agentName]: 'dev' }` or suppress the field when versions are unavailable.

**6d. `projectId` omission returns generic error:**
Omitting `projectId` from `load_agent` returns `Invalid message format` instead of a field-specific validation error. Add explicit Zod `.refine()` or field-level error message.

**6e. Debug instrumentation cleanup:**
The stashed debug changes include `sessionIds: [...this.sessions.keys()]` in `executeMessage` (hot path — every message). This must be removed. All new `log.info` lifecycle calls should be downgraded to `log.debug`. The stash should be cleaned up before merging.

### Fix

- **6a:** Update `session-flow-analysis.md` TTL values; add config reference links.
- **6b:** Trace `interactionContext` resolver — find where it should be called post-execution and wire it.
- **6c:** In the WS frame builder for `agent_response`/`session_updated`, emit `agentVersions: { [agentName]: 'dev' }` when `agentVersions` is empty and runtime is in dev/working-copy mode.
- **6d:** Add field-specific Zod error to `load_agent` / `load_agent_with_context` message schema for `projectId`.
- **6e:** Remove `sessionIds` array from `executeMessage` log. Change all 4 new `log.info` lifecycle calls to `log.debug`.

### Files

- `apps/runtime/src/websocket/handler.ts`
- `apps/runtime/src/services/session/session-flow-analysis.md` (if exists, else docs update)
- `apps/runtime/src/services/runtime-executor.ts` (stash cleanup)
- `apps/runtime/src/services/session/redis-session-store.ts` (stash cleanup)
- `apps/runtime/src/services/session/session-state-repo.ts` (stash cleanup)
- `apps/runtime/src/services/session/tiered-session-store.ts` (stash cleanup)

---

## Testing Strategy

Each cluster requires integration tests that exercise real Redis/MongoDB — no mocking of platform components.

| Cluster | Test type         | What to verify                                                                                                                                                                           |
| ------- | ----------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 1       | Redis integration | Fields survive round-trip: write SessionData with all 4 new fields, read back, assert equality                                                                                           |
| 2       | Mongo integration | Cold upsert + restore: all new fields present; conversationHistory merged from all threads; pendingAwaitAttachment restored in thread                                                    |
| 3       | Unit (pure)       | `lastActivityAt` preserved through snapshot; `createdAt` round-trips via originalCreatedAt                                                                                               |
| 4       | WS integration    | Resumable disconnect sets `status=idle` with `endedAt=null`; reactivation sets `status=active`; `agent.exited` with `escalate` accepted by schema; reap calls same cleanup as endSession |
| 5       | Config unit       | coldPersistDebounceMs rejects values <500; BullMQ queue defaults carry TTL                                                                                                               |
| 6       | WS integration    | `projectId` omission returns field-level error; `agentVersions` in dev mode is non-empty                                                                                                 |

---

## Commit Plan

| Commit | Type                    | Jira     | Scope                                                                                           |
| ------ | ----------------------- | -------- | ----------------------------------------------------------------------------------------------- |
| 1      | fix(runtime)            | ABLP-155 | Redis field parity: agentRawVersions, backtrackCounts, constraintCollectState, moduleProvenance |
| 2      | fix(runtime,database)   | ABLP-155 | Cold store field parity: 8 sub-issues                                                           |
| 3      | fix(runtime)            | ABLP-155 | Timestamp faithfulness: lastActivityAt, createdAt                                               |
| 4      | fix(runtime,eventstore) | ABLP-155 | Lifecycle & event integrity: zombies, schema, executionId, agentName, reap                      |
| 5      | fix(runtime)            | ABLP-155 | Redis hygiene: BullMQ TTL, debounce floor, consistency gap doc                                  |
| 6      | fix(runtime)            | ABLP-155 | Observability: doc fixes, interactionContext, dev agentVersions, projectId error, debug cleanup |

Each commit stays under 40 files and 3 packages.

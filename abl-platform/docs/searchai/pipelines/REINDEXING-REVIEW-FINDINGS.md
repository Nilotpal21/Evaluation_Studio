# Reindexing Implementation Review Findings

Reviewed: 2026-03-11
Scope: Full 4-checkpoint reindexing system (RX-1 through RX-11)

## Verdict

Architecturally sound. The 4-checkpoint model, subsumption logic, dedup sets, and orchestrator dispatch are correct. Issues below are operational hardening (batching, resource management, error propagation) rather than logic bugs.

---

## CRITICAL

### C1: `multimodal` stage type missing from `STAGE_ORDER`

- **File:** `apps/search-ai/src/services/reindexing/helpers.ts`
- `STAGE_ORDER` only lists `['extraction', 'chunking', 'enrichment', 'embedding']`
- `findEarliestDifferingStage()` will never detect changes to multimodal stages
- `stageToCheckpoint('multimodal')` silently falls through to checkpoint 4

### C2: KB-level trigger fetches ALL tenant documents (pre-existing)

- **File:** `apps/search-ai/src/routes/pipeline-triggers.ts:490`
- Queries `{ tenantId }` without `indexId`/`kbId` filter
- Not introduced by reindexing work

### C3: No `requireProjectPermission` on pipeline routes (pre-existing)

- **File:** `apps/search-ai/src/routes/pipelines.ts`, `pipeline-triggers.ts`
- Auth middleware verifies identity but does not enforce project-level permissions
- Not introduced by reindexing work

---

## HIGH

### H1: Router loads ALL documents/chunks into memory

- **File:** `apps/search-ai/src/services/reindexing/router.ts`
- `resolveRoutingChanges` and `resolveEmbeddingChanges` do `.find().lean()` with no cursor/batching
- OOM risk for large knowledge bases (100K+ documents, 1M+ chunks)
- **Fix:** Use cursor-based iteration or batched pagination

### H2: Pre-chunk handler creates a new Queue per document

- **File:** `apps/search-ai/src/services/reindexing/handlers/pre-chunk.ts:95-109`
- 10K docs = 10K Redis connection open/close cycles
- **Fix:** Cache Queue instances by `queueName` for the duration of `execute()`, close all in finally

### H3: Pre-chunk handler silently returns success when pipeline not found

- **File:** `apps/search-ai/src/services/reindexing/handlers/pre-chunk.ts:59-65`
- Logs error but returns void; orchestrator thinks it succeeded
- **Fix:** Throw an error so orchestrator can mark batch as failed

### H4: Pre-chunk handler silently continues on flow build failures

- **File:** `apps/search-ai/src/services/reindexing/handlers/pre-chunk.ts:110-116`
- No failure threshold; all-docs-fail still returns success
- **Fix:** Track failure count, throw if threshold breached

### H5: Post-chunk job data missing `indexId` and `documentId`

- **File:** `apps/search-ai/src/services/reindexing/handlers/post-chunk.ts:47-59`
- Compare with embedding handler which includes both fields
- **Fix:** Add `indexId: params.indexId` and `documentId: action.documentId` to job data

### H6: Frontend — `reindex: null` from backend silently treated as "no changes"

- **File:** `apps/studio/src/store/pipeline-store.ts:355`
- No distinction between "analyzed and no changes" vs "analysis not performed"
- **Fix:** Check for null vs `{ hasChanges: false }` separately

### H7: Frontend — No ESC key, backdrop click, or focus trapping on ReindexConfirmDialog

- **File:** `apps/studio/src/components/search-ai/pipelines/ReindexConfirmDialog.tsx`
- Raw `<div>` overlay without standard modal behavior
- **Fix:** Add keyboard handler, backdrop click handler, consider using a dialog primitive

---

## MEDIUM

### M1: Orchestrator continues to later checkpoints when earlier one fails

- **File:** `apps/search-ai/src/services/reindexing/orchestrator.ts:158-165`
- CP2 fail + CP3 succeed = enrichment on stale extraction data
- **Fix:** Consider aborting subsequent checkpoints or filtering affected actions

### M2: No compound index for `{ tenantId, indexId, flowId }` on SearchChunk

- **File:** `apps/search-ai/src/services/reindexing/router.ts:213`
- `resolvePostChunkChanges` queries this combination; will collection scan
- **Fix:** Add compound index to SearchChunk schema

### M3: `addBulk` used without post-add validation (embedding + post-chunk)

- **Files:** `handlers/embedding.ts:46`, `handlers/post-chunk.ts:46`
- BullMQ Issue #3851: `addBulk` can silently fail during Redis failover
- **Fix:** Validate returned job IDs after `addBulk`

### M4: Embedding handler defaults missing `documentId` to empty string

- **File:** `apps/search-ai/src/services/reindexing/handlers/embedding.ts:52`
- `documentId: action.documentId ?? ''` — should skip or error instead
- **Fix:** Add guard like pre-chunk handler: `if (!action.documentId) continue`

### M5: `BackpressureError.retryAfterMs` never consumed

- **Files:** All three handlers call `checkBackpressure()`
- Queue full = entire batch aborted with no retry
- **Fix:** Handle `BackpressureError` in orchestrator with retry/wait logic

### M6: Frontend — Stale `reindexError` not cleared on new publish

- **File:** `apps/studio/src/store/pipeline-store.ts:355`
- **Fix:** Add `reindexError: null` to the publish success `set()` call

### M7: Frontend — `ReindexResult` with `batchId` discarded after confirm

- **File:** `apps/studio/src/store/pipeline-store.ts:446-448`
- `batchId` needed for future progress tracking
- **Fix:** Store `batchId` in state for potential polling/status display

### M8: Publish lacks optimistic concurrency control

- **File:** `apps/search-ai/src/routes/pipelines.ts:269-319`
- Two concurrent publishes could both succeed
- **Fix:** Use `findOneAndUpdate` with version guard

---

## LOW

### L1: Missing `language`/`sourceId` mapping in `buildFlowContext`

- **File:** `apps/search-ai/src/services/reindexing/helpers.ts:75-90`
- `FlowContext.document.language` and `FlowContext.source.id` never populated

### L2: `ReindexTrigger` interface defined but never implemented

- **File:** `apps/search-ai/src/services/reindexing/types.ts`
- Future-facing dead code

### L3: `console.log` in `page-processing-worker.ts` (pre-existing)

- **File:** `apps/search-ai/src/workers/page-processing-worker.ts:38-41`
- Should use `createLogger('module')`

### L4: Checkpoint counts not rendered in ReindexConfirmDialog

- Available in `ReindexSummary` but dialog only shows totals

### L5: Missing ARIA attributes on ReindexConfirmDialog

- No `role="dialog"`, `aria-modal`, `aria-labelledby`

### L6: Error response shape inconsistency in routes (pre-existing)

- Most use `{ error: 'string' }` instead of `{ success, error: { code, message } }`

### L7: `_id` vs `changeSetId` redundancy in MongoChangeStore

- Both defined; `_id` never used for lookups

### L8: `checkpoint1Count` always 0 (dead counter)

- Router resolves routing to CP2/3/4 actions, so CP1 actions never appear

### L9: Asymmetric disabled-flow removal detection in change-identifier

- Removing a disabled flow doesn't trigger `routingChanged`; re-adding one does

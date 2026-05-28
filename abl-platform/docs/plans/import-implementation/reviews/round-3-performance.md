# Round 3 Review: Performance & Operability

**Reviewer:** Auditor 3 -- Performance & Operability
**Date:** 2026-03-15
**Scope:** Verification of R4 fixes (GridFS index, tenant-scoped reads, resume-aware cross-ref detection, `_` field stripping safety net) and consistency check across Sections 01, 03, and 05
**Cross-referenced:** Updated Sections 1, 3, and 5; Round 2 performance review

---

## R2 Recommendation Verification

### [GridFS metadata index] -- RESOLVED

**Fix applied:** Section 5 (lines 189-197) adds a blockquoted note specifying:

```
db.collection('importFiles.files').createIndex({ 'metadata.expiresAt': 1 })
```

**Verification:** The index is specified as a one-time migration step, scoped to the `importFiles.files` collection (the GridFS metadata collection, not the chunks collection). This is correct -- the cleanup job at line 1654 queries `{ 'metadata.expiresAt': { $lt: now } }`, and this index makes that query an index scan instead of a collection scan. No concerns.

**Status: FULLY RESOLVED.**

---

### [Tenant-scoped GridFS reads] -- RESOLVED with one consistency gap

**Fix applied:** Section 5, `loadImportFiles` (lines 144-171) now accepts `tenantId` as a parameter and scopes the GridFS `find()` query by both `filename` and `metadata.tenantId`. The `[R2 Fix: R2-GRIDFS-1]` marker is present with a defense-in-depth rationale.

**Verification:**

1. **Core fix is correct.** The `bucket.find({ filename, 'metadata.tenantId': tenantId })` query returns only files belonging to the specified tenant. The subsequent `openDownloadStream(files[0]._id)` downloads by the matched file's `_id`, not by name, preventing any cross-tenant access even if filenames collide (they use `operationId.gz`, which is globally unique via UUIDv7, but the tenant filter is defense-in-depth).

2. **Consistency gap: worker skeleton not updated.** The worker skeleton at line 344-346 still calls `loadImportFiles(db, operationId)` with two arguments. The updated function signature at line 149 requires three arguments: `(db, operationId, tenantId)`. This is a call-site inconsistency -- the function definition was updated but the caller was not. During implementation, this would be a compile error (TypeScript arity check), so it will be caught. Not blocking at the plan level, but worth noting.

3. **`deleteImportFiles` (line 176) remains unscoped.** The delete function queries by `filename` alone, without `tenantId`. This is acceptable for two reasons: (a) the worker only deletes its own operation's files on success, and (b) the operationId in the filename is globally unique. However, for consistency with the defense-in-depth principle applied to `loadImportFiles`, `deleteImportFiles` could accept `tenantId` and scope its query. This is a minor consistency note, not a functional issue.

**Status: RESOLVED. One minor call-site inconsistency (non-blocking, caught by TypeScript).**

---

### [Resume-aware `resolving_refs` phase] -- RESOLVED

**Fix applied:** Section 5, `determineResumePoint` (lines 1198-1208) adds a `[R2 Fix: R2-RESUME-1]` block. When `state.status === 'staging'` and all layers are complete, the function returns `{ phase: 'resolving_refs', completedLayers }`.

**Verification:**

1. **Logic is correct.** If a job fails after staging all layers but before or during cross-ref resolution, the state document will show `status: 'staging'` with all layers marked as `staged`. The function correctly detects this and returns `resolving_refs`, which causes the worker to skip re-staging and go directly to cross-ref resolution.

2. **Idempotency is sound.** The comment at line 1200 notes that cross-ref resolution is idempotent. This is accurate: the resolver reads staged records, builds name-to-ID maps, and issues `$set/$unset` operations. Running it twice produces the same result because: (a) anchor queries return the same staged records, (b) `$set` with the same value is a no-op at the MongoDB level, and (c) `$unset` on already-absent fields is a no-op.

3. **No dedicated status for `resolving_refs`.** The comment at line 1206 acknowledges that Phase 2.5 does not have a dedicated status in `ImportOperationState`. This means the function must infer `resolving_refs` from indirect evidence (all layers staged). This works but has a subtle implication: if the cross-ref resolution _completes_ but the job fails immediately after (before the status transitions to `activating`), the function would still return `resolving_refs`, causing an unnecessary but harmless re-run of the resolver. This is acceptable given idempotency.

4. **R2 gap still present: `determineResumePoint` not wired into worker skeleton.** The worker skeleton (lines 320-380) still does not call `determineResumePoint()`. This was flagged in R2 and remains unfixed at the plan level. The function is defined and correct, but the worker goes straight to lock acquisition and file loading without invoking it.

**Status: RESOLVED (the logic is correct). The wiring gap remains a known implementation TODO from R2.**

---

## Round-Trip Count Consistency Check

The R4 fix (NEW-3) added 5 re-queries to the cross-ref resolver (STEP 2), changing the total from ~12 to ~18-20 round trips.

| Location                              | Stated Count                                       | Breakdown                                                   | Consistent?      |
| ------------------------------------- | -------------------------------------------------- | ----------------------------------------------------------- | ---------------- |
| Section 01, line 1303                 | `~18-20 round trips`                               | 5 anchor + 5 re-query + 7-8 bulkWrite                       | Yes              |
| Section 03, line 1214                 | `~18-20`                                           | `10 queries + 7-8 bulkWrites`                               | Yes              |
| Section 03, line 1365                 | `~18-20 round trips (10 queries + 7-8 bulkWrites)` | Same breakdown                                              | Yes              |
| Section 05, latency table (line 1846) | NOT UPDATED                                        | Staging ~60s + Activation ~20s. **No cross-ref line item.** | **Inconsistent** |

**Finding: Section 05 throughput estimates (lines 1836-1846) do not include a cross-ref resolution line item.** The max-size estimate shows Validation (~2s) + Staging (~60s) + Activation (~20s) = ~90s, but cross-ref resolution adds ~300-600ms for max-size. This is negligible relative to the 90s total, so the estimate remains accurate in practice. However, for completeness, a cross-ref line should be added. The R2 review's recalculated latency table (which does include cross-ref at ~500ms) is the authoritative source.

**Verdict: Round-trip counts are consistent across Sections 01 and 03. Section 05 latency table is stale but not materially wrong.**

---

## Pre-Activation `_` Field Stripping: Performance Impact

**Location:** Section 3, lines 1216-1231 (R2 Fix: R2-CROSSREF-2)

The safety net scans all staged records across all collections and issues `$unset` for any `data._`-prefixed fields found.

### Normal Case (no residual `_` fields)

The cross-ref resolver already strips all `_` fields as part of its bulkWrite operations. In the normal case, the safety net scan finds zero records with `_` fields and issues zero updates. Cost:

- **Read pass:** One query per collection in `stagedRecordIds` (~20 collections). Each query projects `{ data: 1 }` and filters by `{ status: 'staged' }`. For 12,150 records across 20 collections, this is ~20 queries returning full `data` subdocuments.
- **Estimated latency:** ~5ms per query x 20 = ~100ms.
- **Memory:** Full `data` field for 12,150 records is the dominant cost. Average `data` size is ~1-5KB, so reading all of them pulls ~12-60MB into the worker. This is significant -- it effectively re-reads the entire import payload from MongoDB.

### Abnormal Case (residual `_` fields exist)

If `_` fields remain, the safety net issues one `bulkWrite` per affected collection. Since only ~5 collections have `_` temp fields in the resolver (the ones with cross-references), at most 5 bulkWrites would fire. Cost: ~5 x 40ms = ~200ms additional.

### Performance Concern: NEW-PERF-5

**Severity: LOW-MEDIUM**

The safety net's read pass projects `{ data: 1 }`, which loads the full `data` subdocument for every staged record. For the normal case (no residual `_` fields), this is a pure overhead of ~100ms latency and ~12-60MB of memory -- reading the entire import dataset from MongoDB a second time just to verify that no `_` fields remain.

**Optimization:** Instead of projecting `{ data: 1 }` and scanning in the worker, use a MongoDB aggregation or query that checks for `_` fields server-side:

```
db.collection(coll).countDocuments({
  _id: { $in: ids },
  status: 'staged',
  $or: [
    { 'data._indexSlug': { $exists: true } },
    { 'data._channelDisplayName': { $exists: true } },
    { 'data._parentSetName': { $exists: true } },
    { 'data._nestedScenarioNames': { $exists: true } },
    { 'data._nestedPersonaNames': { $exists: true } },
  ]
})
```

If count is 0 (the normal case), skip the bulkWrite entirely. This replaces ~20 full-projection queries with ~20 count queries that use the `_id` index and check field existence without transferring document bodies. Cost: ~20 x 2ms = ~40ms with negligible memory.

**Status: NOT BLOCKING.** The safety net is a correctness backstop, and the ~100ms overhead is <0.2% of total import time. But the optimization above is straightforward and avoids transferring ~12-60MB of data in the normal case.

---

## New Issues from R4 Fixes

### [NEW-PERF-5] Safety Net Full-Document Read in Normal Case -- Severity: LOW

Described above. The pre-activation `_` field stripping reads `{ data: 1 }` for all staged records even when no residual fields exist. Optimization: use `countDocuments` with `$exists` checks first, only do the full scan if count > 0.

---

### [NEW-PERF-6] Section 05 Memory Budget Still Not Updated -- Severity: LOW

**Location:** Section 5, lines 1811-1823

The R2 review recommended updating the memory budget to include the GridFS download buffer (~17MB per import) and adjusting the "fits in 512MB pod" claim. As of this review, the memory budget table still shows:

```
Peak per import:                ~58 MB
x3 concurrent imports:          ~174 MB
Total worker memory budget:     ~275 MB (fits in 512MB pod)
```

The R2 review calculated the actual peak at ~76MB per import (~400MB total at concurrency=3), noting that 512MB is tight. This has not been incorporated into Section 05.

Additionally, the safety net's `{ data: 1 }` read pass (NEW-PERF-5 above) adds another transient memory spike of ~12-60MB. If this overlaps with the decompressed file still being in scope (before GC), peak per import could briefly reach ~90MB+.

**Status: NOT BLOCKING.** The memory numbers in Section 05 are optimistic. The R2 review's corrected numbers should be folded in during implementation planning.

---

### [NEW-PERF-7] `resolving_refs` Resume Re-reads All Files from GridFS -- Severity: NEGLIGIBLE

When `determineResumePoint` returns `{ phase: 'resolving_refs' }`, the worker still loads files from GridFS (line 344) and runs validation (line 351) before reaching the cross-ref phase. If the worker skeleton is eventually updated to skip phases based on the resume point, this becomes moot. If it is not, the re-read adds ~300ms (GridFS download + decompress) for a resumed job that only needs cross-ref resolution. Since resume is a rare path (manual DLQ re-enqueue only), this is negligible.

**Status: NOT BLOCKING.**

---

## Previously Identified Issues -- Status Check

| Issue                                      | R2 Status           | R3 Status | Notes                               |
| ------------------------------------------ | ------------------- | --------- | ----------------------------------- |
| PERF-2 (50MB file map in memory)           | Partially addressed | Unchanged | Still held in memory for all layers |
| PERF-3 (activation bulkWrite ordered mode) | Open                | Unchanged | No `{ ordered: false }` specified   |
| SCALE-1 (single queue HOL blocking)        | Open                | Unchanged | Known limitation                    |
| OPS-3 (v1/v2 lock independence)            | Open                | Unchanged | Separate key prefix noted           |
| OPS-4 (1-hour TTL may delete active ops)   | Partially addressed | Unchanged | TTL refresh not implemented         |
| TIME-1 (phase timeouts sum > job timeout)  | Open                | Unchanged | 1530s sum vs 600s job timeout       |
| FAIL-1 (pod crash during activation)       | Open                | Unchanged | No automatic rollback               |
| FAIL-2 (Redis crash, lock lost)            | Open                | Unchanged | Static TTL chosen over heartbeat    |
| NEW-PERF-1 (GridFS read latency)           | Not blocking        | Unchanged | ~40-70ms one-time cost              |
| NEW-PERF-2 (cross-ref query load)          | Not blocking        | Unchanged | ~300-600ms bounded                  |
| NEW-PERF-3 (resume point query)            | Negligible          | Unchanged | ~5ms one-time                       |
| NEW-PERF-4 (stagedRecordIds memory)        | Not blocking        | Unchanged | ~400KB well within bounds           |
| NEW-OPS-1 (GridFS/state TTL misalignment)  | Not blocking        | Unchanged | Intentional design                  |

---

## Verdict

**PASS -- No blocking performance issues found in R4 fixes.**

| Verified Item                                   | Status                 | Residual                                        |
| ----------------------------------------------- | ---------------------- | ----------------------------------------------- |
| Round-trip count consistency (01 vs 03)         | Consistent (~18-20)    | Section 05 latency table missing cross-ref line |
| GridFS metadata index                           | Properly specified     | None                                            |
| `determineResumePoint` handles `resolving_refs` | Correct and idempotent | Worker skeleton still not wired (R2 carry-over) |
| Tenant-scoped GridFS reads                      | Correctly implemented  | Worker call-site uses old 2-arg signature       |
| Pre-activation `_` field stripping              | Correct but over-reads | Optimize with `countDocuments` + `$exists`      |

**New issues from fixes:** One low-severity performance concern (NEW-PERF-5: safety net reads full documents unnecessarily in the normal case). Two informational notes (stale memory budget in Section 05, unnecessary file reload on resume path).

**Key implementation notes carried forward from R2 + R3:**

1. Create index: `db.collection('importFiles.files').createIndex({ 'metadata.expiresAt': 1 })` -- specified in plan.
2. Wire `determineResumePoint()` into the worker processor before file loading -- still not done.
3. Update `loadImportFiles` call-site in worker skeleton to pass `tenantId` (3-arg signature).
4. Add `import_v2_gridfs_read_ms` metric alongside `import_v2_gridfs_write_ms` -- still missing.
5. Update memory budget table: ~76MB peak per import, ~400MB at concurrency=3, recommend 768MB pod.
6. Add cross-ref resolution (~500ms) as a line item in Section 05 throughput estimates.
7. Optimize safety net: use `countDocuments` with `$exists` before full-document scan.

# Round 3 Review: Security & Correctness

**Reviewer**: Auditor 2 (Security & Correctness)
**Scope**: Sections 01-05, focused on R2 must-fix items and five medium-severity carryovers
**Prior reviews**: `round-1-security.md`, `round-2-security.md`

---

## R2 Must-Fix Verification

### R2-AUTH-1 / INT-1: Fuzzy Auth Auto-Application -- RESOLVED

**R2 finding**: Fuzzy matches (score >= 0.7) were auto-applied to `nameToIdMap`, silently wiring connections to potentially wrong credentials.

**Fix applied** (Section 4.2, lines 244-398):

1. `ResolutionStrategy` type changed from `'exact_name' | 'fuzzy_match' | 'user_mapped'` to `'exact_name' | 'user_mapped'`. The `fuzzy_match` strategy is eliminated as an auto-apply path.
2. `UnresolvedAuthProfile` now has a `suggestedMatch?: { id, name, authType, score }` field (lines 270-281). The `[R2 Fix: R2-AUTH-1]` comment at line 271 explicitly states: "NEVER auto-applied -- the user must explicitly confirm via userMappings."
3. In `resolveAuthProfiles()`, the cascade is:
   - Step 0: `user_mapped` (manual override) -- populates `nameToIdMap`. Correct.
   - Step 1: `exact_name` (case-insensitive) -- populates `nameToIdMap`. Correct.
   - Step 2: Fuzzy scoring -- candidates are computed but the result always goes to `unresolved.push(...)` (line 383). The `suggestedMatch` is populated from the top candidate if `score >= 0.7` (line 392-393), but `nameToIdMap` is never touched.
4. The `[R2 Fix]` comment block at lines 373-378 is clear and well-reasoned, citing the "Salesforce Production" / "Salesforce Staging" scenario.

**Verification**: I traced the data flow from `scoreCandidates()` through to `nameToIdMap`. Fuzzy matches never populate `resolved` or `nameToIdMap`. Only `exact_name` (confidence 1.0) and `user_mapped` do. The user must confirm fuzzy suggestions by passing them as `userMappings` in the import request.

**Verdict**: FULLY RESOLVED.

---

### R2-AUTH-4: DLQ Endpoints Require Platform Admin -- RESOLVED

**R2 finding**: DLQ endpoints lacked auth specification, risking cross-tenant information disclosure.

**Fix applied** (Section 5, lines 1275-1304):

1. `[R2 Fix: R2-AUTH-4]` blockquote at line 1275 explicitly states: "All DLQ endpoints require `requirePlatformAdmin()` middleware."
2. Route paths moved under `/api/admin/import/v2/dlq` (lines 1283-1285), making the admin scope visible in the URL structure.
3. All three routes show `requireAuth(), requirePlatformAdmin()` middleware in the registration code (lines 1292-1304):
   - `GET /api/admin/import/v2/dlq`
   - `POST /api/admin/import/v2/dlq/:jobId/retry`
   - `DELETE /api/admin/import/v2/dlq/:jobId`

**Verdict**: FULLY RESOLVED.

---

## R2 Medium-Severity Carryover Verification

### R2-GRIDFS-1: GridFS Tenant Scoping on Read -- RESOLVED (with residual)

**Fix applied** (Section 5, lines 141-171):

`loadImportFiles` signature updated to `(db, operationId, tenantId)` (line 149). The function queries GridFS with `{ filename: '${operationId}.gz', 'metadata.tenantId': tenantId }` (lines 153-157), then opens the download stream by `files[0]._id` (line 166). Defense-in-depth is achieved: even if an attacker guesses the `operationId`, the tenantId filter prevents cross-tenant reads.

**Residual R3-GRIDFS-CALLSITE (LOW)**: The worker skeleton at line 345 still calls `loadImportFiles(db, operationId)` without passing the `tenantId` argument. The function signature at line 149 requires three parameters. This is a plan inconsistency -- the call site was not updated to match the new signature. The fix is trivial: change line 345 to `loadImportFiles(db, operationId, tenantId)`. `tenantId` is already destructured from `job.data` at line 321.

**Residual R3-GRIDFS-DELETE (LOW)**: `deleteImportFiles` (lines 176-182) queries by `{ filename: '${operationId}.gz' }` without tenant scoping. While this function is only called after a successful import by the worker that already verified tenant context, it should also accept and filter by `tenantId` for the same defense-in-depth reasoning applied to `loadImportFiles`.

**Verdict**: Core issue resolved. Two low-severity call-site consistency items remain.

---

### R2-CROSSREF-2: Temporary `_` Fields Stripped Before Activation -- RESOLVED

**Fix applied** (Section 3, lines 1216-1231):

A `[R2 Fix: R2-CROSSREF-2]` safety-net block is added after the cross-ref resolver completes. It specifies a pre-activation pass that:

1. Iterates all collections in `stagedRecordIds`.
2. Queries staged records and checks for `data._*` fields.
3. Issues `$unset` for any remaining `_`-prefixed fields.

The comment notes this is O(N) but only fires if `_` fields remain, which should not happen in the normal case. This is a correct safety-net design -- it catches both error-path leaks (resolver throws but activation proceeds) and future disassembler additions that might introduce new temp fields not yet covered by the resolver.

Additionally, each specific cross-ref update already explicitly `$unset`s its temp fields: `_indexSlug` (lines 1125, 1143), `_channelDisplayName` (line 1162), `_nestedScenarioNames` and `_nestedPersonaNames` (lines 1183-1184), `_parentSetName` (lines 1193, 1200).

**Verdict**: FULLY RESOLVED. Both the targeted `$unset` in the resolver and the generic safety-net in pre-activation provide two layers of defense.

---

### R2-RESUME-1: Resume Logic Handles Phase 2.5 -- RESOLVED

**Fix applied** (Section 5, lines 1198-1208):

`determineResumePoint` now includes a `[R2 Fix: R2-RESUME-1]` block (lines 1198-1208):

```
if (state.status === 'staging' &&
    completedLayers.length === Object.keys(state.layers ?? {}).length) {
  return { phase: 'resolving_refs', completedLayers };
}
```

When all layers are staged but the operation status is still `'staging'`, the worker returns `phase: 'resolving_refs'` instead of incorrectly assuming staging is in progress. The comment acknowledges that Phase 2.5 does not have a dedicated status and uses the heuristic of "all layers complete but status is still staging" to detect this case.

The cross-ref resolution is idempotent (`$set`/`$unset` on staged records by `_id`), so re-running it after a crash is safe.

**Verdict**: RESOLVED. The heuristic is sound given the existing state model.

---

## New R3 Findings

### R3-GRIDFS-CALLSITE: Worker Skeleton Missing tenantId in loadImportFiles Call (LOW)

**Location**: Section 5, line 345

The `loadImportFiles` function signature was updated to `(db, operationId, tenantId)` as part of the R2-GRIDFS-1 fix, but the worker skeleton at line 345 still calls `loadImportFiles(db, operationId)` without the third argument. This would cause a TypeScript compilation error during implementation, so it is self-correcting, but the plan should be consistent.

**Fix**: Update line 345 to `loadImportFiles(db, operationId, tenantId)`.

---

### R3-GRIDFS-DELETE: deleteImportFiles Lacks Tenant Scoping (LOW)

**Location**: Section 5, lines 176-182

`deleteImportFiles(db, operationId)` queries GridFS by filename only, without tenant scoping. The same defense-in-depth argument used for `loadImportFiles` applies here. A future caller could delete another tenant's import files if they know the `operationId`.

**Fix**: Add `tenantId` parameter and query `{ filename, 'metadata.tenantId': tenantId }`.

---

### R3-DEEPREPLACE-DEPTH: deepReplace Still Has No Depth Limit (LOW)

**Location**: Section 4.5, lines 2035-2056

R2-DEPTH-1 flagged `deepReplace()` as lacking a depth parameter. This remains unaddressed. All other recursive functions (`scanObject`, `scanForInjection`, `scanForSecrets`, `scanForRedacted`, `sanitizeImportedData`) now have `MAX_SCAN_DEPTH` limits, but `deepReplace` recurses without any guard.

The scope is limited to connection files (processed through `sanitizeRedactedForStorage`), so the attack surface is smaller than the scan functions. A maliciously crafted `.connection.json` with 10K levels of nesting could still overflow the stack.

**Fix**: Add `depth` parameter with `MAX_SCAN_DEPTH` limit, consistent with the other functions.

---

### R3-PROGRESS-PHASE: Progress Calculator Missing resolving_refs Phase (LOW)

**Location**: Section 5, lines 565-574

The `PHASE_WEIGHTS` map in `calculateProgress` defines weights for: `queued`, `validating`, `staging`, `activating`, `completed`, `failed`, `rolling_back`, `cancelled`. The `resolving_refs` phase introduced by the R2-RESUME-1 fix is not present. If the worker enters this phase and calls `calculateProgress`, the `basePercent` lookup will return `undefined`, and the arithmetic will produce `NaN`.

**Fix**: Add `resolving_refs: 62` to `PHASE_WEIGHTS` (logically between staging at 5-65% and activating at 65-95%, representing "staging done, resolving references").

---

### R3-WORKER-FLOW-GAP: Worker Skeleton Does Not Show Phase 2.5 Execution (LOW)

**Location**: Section 5, lines 341-371

The worker skeleton (Section 1.6) shows phases: validate -> stage -> complete. It does not show the cross-ref resolution phase between staging and activation, nor does it show the safety-net `_` field stripping. While the detailed Phase 2.5 implementation is covered in Section 3 (cross-ref resolver), the worker skeleton should at minimum reference it to prevent implementers from missing it.

This is a documentation completeness issue, not a security issue.

---

## Summary

### R2 Must-Fix Verification

| R2 Finding                        | R3 Verdict     | Notes                                             |
| --------------------------------- | -------------- | ------------------------------------------------- |
| R2-AUTH-1 (Fuzzy auth auto-apply) | FULLY RESOLVED | Fuzzy matches are suggestions only, never applied |
| R2-AUTH-4 (DLQ admin auth)        | FULLY RESOLVED | All routes require `requirePlatformAdmin()`       |

### R2 Medium-Severity Carryover Verification

| R2 Finding                             | R3 Verdict             | Notes                                            |
| -------------------------------------- | ---------------------- | ------------------------------------------------ |
| R2-GRIDFS-1 (GridFS tenant scoping)    | RESOLVED (2 residuals) | Core fix correct; call site + delete need update |
| R2-CROSSREF-2 (Temp `_` field leakage) | FULLY RESOLVED         | Targeted `$unset` + generic safety net           |
| R2-RESUME-1 (Phase 2.5 resume logic)   | RESOLVED               | Heuristic detection is sound                     |

### New R3 Findings

| Finding              | Severity | Category           |
| -------------------- | -------- | ------------------ |
| R3-GRIDFS-CALLSITE   | LOW      | Plan inconsistency |
| R3-GRIDFS-DELETE     | LOW      | Tenant isolation   |
| R3-DEEPREPLACE-DEPTH | LOW      | DoS (carryover)    |
| R3-PROGRESS-PHASE    | LOW      | Correctness        |
| R3-WORKER-FLOW-GAP   | LOW      | Documentation      |

---

## Verdict

**PASS -- No blocking issues remain.**

Both R2 must-fix items are fully resolved. The fuzzy auth fix is clean and well-documented. The DLQ auth fix uses the correct middleware and moves routes under `/api/admin/`. The three medium-severity carryovers (GridFS scoping, temp field stripping, resume logic) are all addressed with appropriate fixes.

The five new R3 findings are all LOW severity. They are plan-level consistency items and a single remaining depth-limit gap on `deepReplace`. None require another review round -- they should be tracked as implementation notes.

The plan's security posture is now solid across all reviewed dimensions: tenant isolation, authorization, input validation, injection prevention, SSRF defense, and data integrity.

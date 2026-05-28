# Data-Flow & Dependency-Wiring Audit: OCR / Approval / Data Entry

**Date**: 2026-05-21
**Auditor**: Claude (automated, 2 rounds)
**Feature**: OCR node (ADI + Docling), Approval node fixes, Data Entry parity — branch `feature/wf/ocrnode`

## Sensitive Values Audited

- `callbackSecret` — CREDENTIAL (HMAC signing secret)
- `awakeableId` — CREDENTIAL (Restate durable promise handle)
- `callbackUrl` — INTERNAL (contains tenantId, executionId, stepId)
- `rejectStepIds` — INTERNAL (rejection routing topology)
- `hasHumanWait` — INTERNAL (sweeper exclusion flag)
- Step output payload (form data, approval decisions) — BUSINESS/PII
- ADI/Docling BullMQ job data — INTERNAL
- `tenantId` isolation across new queries — INTERNAL

## Round 1 Findings

| ID         | Severity | Dimension       | Finding                                                           |
| ---------- | -------- | --------------- | ----------------------------------------------------------------- |
| F-RJ-1     | HIGH     | Read Paths      | `rejectStepIds` not stripped from REST API (unlike `nextStepIds`) |
| F-CB-1     | MEDIUM   | Policy Boundary | Legacy callback route unscoped — no tenantId in DB query          |
| F-AW-1     | MEDIUM   | Writes          | `awakeableId` stored as plaintext in MongoDB                      |
| F-RJ-2     | MEDIUM   | Parallel Paths  | Timeout enforcer has no `onTimeout: 'reject'` routing             |
| F-TI-1/2/3 | MEDIUM   | Consumers       | Sweeper/enforcer find queries are cross-tenant (system actors)    |
| F-CB-2     | LOW      | Writes          | `callbackUrl` not encrypted in BullMQ queue payloads              |
| F-HW-1     | LOW      | Writes          | `hasHumanWait` not declared in Mongoose schema                    |
| F-AW-2     | LOW      | Consumers       | `awakeableId` logged in error handlers                            |
| F-CB-3     | LOW      | Consumers       | `callbackUrl` (with tenantId) logged in ADI worker                |
| F-PII-1    | LOW      | Writes          | User form data stored as plaintext (TTL-gated)                    |
| F-ADI-1    | LOW      | Writes          | ADI job URL fields unencrypted in Redis                           |

## Round 2: Fix Verification

| Finding     | Severity | Fix Commit | Code Verified                                           | Boundary Test                                                     |
| ----------- | -------- | ---------- | ------------------------------------------------------- | ----------------------------------------------------------------- |
| F-RJ-1      | HIGH     | cc2f1a508c | ✓ `rejectStepIds` at line 371 of workflow-executions.ts | ✗ GAP — no test for STEP_SENSITIVE_FIELDS stripping               |
| F-CB-2      | LOW      | cc2f1a508c | ✓ `callbackUrl` in manifest lines 38-39                 | PARTIAL — round-trip tested; at-rest encryption assertion missing |
| F-HW-1      | LOW      | cc2f1a508c | ✓ interface line 89 + schema line 131                   | ✗ GAP — no test for hasHumanWait field                            |
| Studio edge | UI       | cc2f1a508c | ✓ `canvasNodeType ?? step.nodeType` + `data_entry` case | ✗ GAP — no computeExecutionEdges test                             |

### callbackUrl Decrypt Path Verification

The encryption of `callbackUrl` introduced a risk: if SEC-10 hostname validation or the HTTP POST runs before decryption, it would fail or operate on ciphertext.

**ADI poll worker** (`adi-poll-worker.ts`):

- Line 171: `unwrapJobDataForDecrypt` decrypts all fields including `callbackUrl`
- Lines 260–276: SEC-10 hostname validation runs **after** decryption ✓
- Lines 240, 295: `postCallback(callbackUrl, ...)` uses decrypted URL ✓
- Lines 445–464: `reEnqueue` re-encrypts via `wrapJobDataForEncrypt` before re-queuing ✓
- **Verdict: SAFE**

**Docling extraction worker** (`extraction-only.ts`):

- Line 63–70: `unwrapJobDataForDecrypt` decrypts `callbackUrl` ✓
- Line 161: `url: callbackUrl` passed to `postCallback()` — decrypted URL used correctly ✓
- No SEC-10 hostname check (new finding N-1)
- **Verdict: SAFE (no regression; N-1 tracked separately)**

## Open / Accepted Findings

| ID         | Severity | Rationale                                                                                                                                                                                                              |
| ---------- | -------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| F-CB-1     | MEDIUM   | HMAC + timestamp tolerance is mandatory auth gate before any state read/write. Acceptable until relay-race migration completes; TODO deprecation comment added.                                                        |
| F-AW-1     | MEDIUM   | Relay-race is the default path — no new `awakeableId` values generated. Legacy in-flight executions have the value stripped from all API surfaces (STEP_SENSITIVE_FIELDS, PUBLISH_SENSITIVE_STEP_FIELDS, WS snapshot). |
| F-RJ-2     | MEDIUM   | Design limitation — `onTimeout: 'reject'` routing is not implemented. Only `terminate` and `skip` exist. Acceptable; not requested by current feature scope.                                                           |
| F-TI-1/2/3 | MEDIUM   | Sweeper and enforcer are system actors operating across tenants by design. Write paths are always tenantId+projectId scoped. Batch size cap (100) limits exposure.                                                     |
| F-AW-2     | LOW      | Operational debugging value; `awakeableId` is stripped from all client-facing surfaces.                                                                                                                                |
| F-CB-3     | LOW      | Full `callbackUrl` logged at warn/error level; low risk with at-rest encryption now in place.                                                                                                                          |
| F-PII-1    | LOW      | TTL-based auto-deletion when `WORKFLOW_MONGO_TTL_ENABLED=true`. Project-scoped data visible only to authenticated designers.                                                                                           |
| F-ADI-1    | LOW      | `operationLocation`, `endpoint`, `sourceUrl` are non-credential internal URLs. At-rest encryption of `callbackUrl` (F-CB-2) reduces overall Redis exposure.                                                            |

## New Findings (Round 2)

| ID  | Severity | Finding                                                                                                                                                                           | Fix                                                                                               |
| --- | -------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------- |
| N-1 | LOW      | Docling extraction-only worker missing SEC-10 `callbackUrl` hostname validation (ADI has it at lines 52–60; Docling does not)                                                     | Add `EXPECTED_CALLBACK_HOST` check before `postCallback()` in `extraction-only.ts`                |
| N-2 | LOW      | `extraction-callback-secret-encryption.test.ts` line 91: comment says "non-encrypted fields are untouched" for `callbackUrl`, which is now stale since `callbackUrl` IS encrypted | Update comment + add `expect(atRest.callbackUrl).not.toBe(producerPayload.callbackUrl)` assertion |

## Boundary Test Gaps

| Gap                                 | File to Add Test                                | Assertion                                                                                                            |
| ----------------------------------- | ----------------------------------------------- | -------------------------------------------------------------------------------------------------------------------- |
| `rejectStepIds` stripped from API   | `workflow-executions.test.ts`                   | `GET /executions/:id` response must not contain `rejectStepIds` in any step                                          |
| `callbackUrl` at-rest encrypted     | `extraction-callback-secret-encryption.test.ts` | `atRest.callbackUrl !== plaintext` (currently only tests round-trip)                                                 |
| `hasHumanWait` persisted + filtered | `execution-store.test.ts`                       | parkStep sets flag; sweeper query excludes it                                                                        |
| `computeExecutionEdges` data_entry  | `computeExecutionEdges.test.ts`                 | `data_entry` node completed → `on_success` edge traversed; `human_task` node completed → `on_approve` edge traversed |

## Final Verdict

- [x] No CRITICAL findings open
- [x] HIGH findings closed — F-RJ-1 verified at `workflow-executions.ts:371`
- [x] callbackUrl encrypt/decrypt path safe — decrypt before validate before use, no regression
- [x] Parallel paths verified — relay-race default; sweeper write path tenant-scoped
- [ ] Boundary tests: 4 gaps remain (non-blocking, tracked above)
- [ ] N-1: Docling missing SEC-10 (non-blocking LOW)
- [ ] N-2: Stale test comment (non-blocking LOW)

**Feature branch is safe to proceed. No blocking findings.**

---

## Round 3: Deep Re-Audit (2026-05-21)

### Check Results

| Check                                     | Status                | Evidence                                                             |
| ----------------------------------------- | --------------------- | -------------------------------------------------------------------- |
| `rejectStepIds` in WS publish path        | NEW FINDING F-WS-1    | `PUBLISH_SENSITIVE_STEP_FIELDS` only had 2 fields; REST API had 10   |
| N-1 fix position (Docling SEC-10)         | PASS ✓                | Check at `extraction-only.ts:96–108` — post-decrypt, pre-use         |
| `stepTimeoutFor`/`timeoutDecision` fields | PASS ✓                | Transient Restate param only — no DB write, no API exposure, no PII  |
| `HumanStepTimeoutEnforcer` wiring         | PASS ✓                | All deps wired at `index.ts:935–943`; shutdown at `index.ts:568–573` |
| `StuckExecutionSweeper` wiring            | PASS ✓                | Wired at `index.ts:926–929`; shutdown at `index.ts:568–573`          |
| `parkPoint` in WS publish path            | FAIL (part of F-WS-1) | Same parity gap as `rejectStepIds`                                   |
| Boundary test gaps                        | 3 of 4 still open     | `callbackUrl` at-rest assertion added; 3 others remain               |
| Legacy callback deprecation TODO          | FIXED ✓               | `// TODO(SEC-1): deprecate once relay-race migration complete` added |
| Approval / Data Entry parallel parity     | PASS ✓                | All 5 behaviors identical in both route files                        |

### New Finding: F-WS-1

**Severity**: LOW
**Dimension**: Read Paths / Parallel Path parity
**Finding**: `PUBLISH_SENSITIVE_STEP_FIELDS` (Redis pub-sub) and `SNAPSHOT_STEP_SENSITIVE_FIELDS` (WS snapshot) only stripped `callbackSecret` and `awakeableId`. The REST API `STEP_SENSITIVE_FIELDS` set strips 8 additional orchestration-internal fields: `parkPoint`, `nextStepIds`, `rejectStepIds`, `joinStepId`, `barrierTotal`, `barrierCount`, `branchId`, `failureStrategy`.
**Impact**: Authenticated Studio clients receiving step data via WebSocket could see internal routing topology.
**Fix**: Added all 8 fields to both sets in `workflow-handler.ts:904` and `wf-bridge.ts:28`.
**Status**: CLOSED in this round.

### Round 3 Final Verdict

- [x] No CRITICAL findings open
- [x] HIGH findings closed (F-RJ-1 verified, F-WS-1 closed)
- [x] `stepTimeoutFor`/`timeoutDecision` clean — no PII, no persistence, no API exposure
- [x] Both new services correctly wired and shut down
- [x] WS/REST parity gap closed (F-WS-1)
- [ ] Boundary tests: 3 gaps remain (non-blocking)

**All three strip sets are now in parity. Feature branch is safe to proceed.**

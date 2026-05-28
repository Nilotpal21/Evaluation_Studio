# Post-Implementation Sync: wf-ocr-approval (ABLP-1073)

**Date**: 2026-05-21
**Feature**: Document Extraction Integrations — OCR nodes, Approval/Data Entry fixes
**Docs slug**: `document-extraction-integrations`
**Branch**: `feature/wf/ocrnode`
**Ticket**: ABLP-1073

## Documents Updated

- [x] Feature spec: `docs/features/document-extraction-integrations.md` — Phase 5 section added, data model updated, gaps updated, env vars updated
- [x] Test spec: `docs/testing/document-extraction-integrations.md` — boundary test coverage updated, new test files added
- [x] Post-impl log: `docs/sdlc-logs/wf-ocr-approval/post-impl-sync.log.md` — this file
- [x] Data-flow audit: `docs/sdlc-logs/wf-ocr-approval/data-flow-audit.md` — already complete (3 rounds)
- [x] `apps/workflow-engine/agents.md` — Phase 5 learnings: rejection routing, exact timer, hasHumanWait, strip set parity, relay-race test patterns
- [x] `apps/search-ai/agents.md` — SEC-10 parity fix: callbackUrl hostname validation must be in both ADI and Docling workers
- [x] `apps/studio/agents.md` — canvas edge canvasNodeType fallback, StepLogItem status extension pattern

## Migration Script

**NOT REQUIRED.** All schema changes are additive:

- `hasHumanWait?: boolean` — optional boolean, Mongoose index auto-created on startup
- `rejectStepIds` on step context — optional, `?? []` default used everywhere
- `callbackUrl` encryption in BullMQ — backward-compatible via `_enc` detection
- Loop scratch cleanup — fire-and-forget, non-fatal, no migration needed

**Operator action note**: The compound partial index `{ status: 1, startedAt: 1, hasHumanWait: 1 }` on `WorkflowExecution` is created by Mongoose `ensureIndex` on first workflow-engine startup after deploy. For large collections this may cause brief startup overhead.

## Coverage Delta

| Type                   | Before (2026-05-20) | After (2026-05-21)                        |
| ---------------------- | ------------------- | ----------------------------------------- |
| Unit tests             | ~1050 passing       | 1054 passing                              |
| Integration/HTTP tests | 71 passing          | 155 passing (HTTP suite unblocked)        |
| E2E tests              | 0                   | 0 (still gap)                             |
| Data-flow audit        | Round 2             | Round 3 complete                          |
| PR review              | Not done            | Phase A complete, blocking findings fixed |

## Implementation Deviations from Plan

1. **Timeout enforcement** — originally planned as sweeper-polling (60s lag); implemented as Restate-native exact timer (`startWorkflow` with `delayMs`) for zero lag. HumanStepTimeoutEnforcer retained as 60s fallback backstop.
2. **Approval rejection** — `rejectStepIds` stored at park time (relay-race path only); legacy Restate awakeable path continues to use `nextStepIds`. Both paths handle `isRejection` normalization.
3. **Data Entry** — confirmed no reject button in UI, Case B (reject) is N/A. Human-task route mirrors all 5 approval behaviors.
4. **Strip set parity** — discovered gap (F-WS-1) in PR review: WS/Redis strip sets had only 2 fields vs REST API's 11. Fixed in this PR.
5. **SEC-10 in Docling** — discovered during data-flow audit Round 2: Docling worker lacked hostname validation that ADI had. Added as N-1 fix.

## Remaining Open Items

| ID                                              | Severity | Description                                                                                                                                    |
| ----------------------------------------------- | -------- | ---------------------------------------------------------------------------------------------------------------------------------------------- |
| F-CB-1                                          | MEDIUM   | Legacy callback route `/api/v1/workflows/callbacks/:executionId/:stepId` still unscoped by tenantId — TODO deprecation added, safe due to HMAC |
| F-RJ-2                                          | MEDIUM   | No `onTimeout: 'reject'` routing in timeout enforcer — design gap, out of scope                                                                |
| F-2                                             | LOW      | Timeout `startWorkflow` not in `restateCtx.run()` — duplicate timer on replay, CAS guard prevents data corruption                              |
| Boundary test: rejectStepIds stripping          | LOW      | No E2E test asserting REST API strips rejectStepIds from response                                                                              |
| Boundary test: hasHumanWait persistence         | LOW      | No test asserting parkStep sets flag and sweeper filters it                                                                                    |
| Boundary test: computeExecutionEdges data_entry | LOW      | No unit test for data_entry → on_success edge handle resolution                                                                                |
| E2E suite                                       | HIGH     | All 13 E2E scenarios from test spec are PLANNED, none implemented                                                                              |

## Feature Status

**BETA** (was BETA at last sync — no promotion this cycle)

BETA → STABLE gate requires:

- 5+ E2E tests passing -- (0 exist)
- 5+ integration tests passing -- (155 exist)
- All CRITICAL/HIGH gaps resolved -- yes
- Security tests passing -- (data-flow audit 3 rounds)
- Production soak -- (not yet deployed)

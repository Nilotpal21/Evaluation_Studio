# SDLC Log: Workflow Triggers — LLD

**Phase**: LLD
**Date**: 2026-03-24
**Artifact**: `docs/plans/2026-03-24-workflow-triggers-impl-plan.md`

---

## Oracle Decisions

All 15 clarifying questions answered autonomously (0 AMBIGUOUS, 0 escalated to user).

### Implementation Strategy

| #   | Question                         | Classification | Decision                                                                                      |
| --- | -------------------------------- | -------------- | --------------------------------------------------------------------------------------------- |
| Q1  | Preferred implementation order?  | ANSWERED       | Data layer → API → UI. Phase 1: Core Process API, Phase 2: Scheduling+Callbacks, Phase 3: UI  |
| Q2  | Existing patterns to follow?     | ANSWERED       | TriggerEngine, TriggerScheduler, connector patterns. DI via constructor deps, pure functions. |
| Q3  | Feature flag for phased rollout? | ANSWERED       | No. All changes additive. Rollback = route unmount.                                           |
| Q4  | Acceptable scope for phase 1?    | ANSWERED       | FR-01-07, FR-17, FR-18. Sync/async execution, polling, auth, tenant isolation.                |
| Q5  | Hard deadlines?                  | INFERRED       | None. Quality over speed.                                                                     |

### Technical Details

| #   | Question                         | Classification | Decision                                                                                   |
| --- | -------------------------------- | -------------- | ------------------------------------------------------------------------------------------ |
| Q6  | Files: modification vs creation? | ANSWERED       | 16 new files, 8 modified. Detailed in file-level change map.                               |
| Q7  | Testing strategy?                | ANSWERED       | Test-after per phase. E2E with real servers, integration at service boundaries.            |
| Q8  | Type definitions to change?      | ANSWERED       | WorkflowExecution interface (triggerMetadata), ExecutionPersistence interface, TriggerReg. |
| Q9  | Database migration strategy?     | ANSWERED       | No migration. Additive schema changes: optional fields, new Mixed fields.                  |
| Q10 | Performance-sensitive paths?     | ANSWERED       | Sync execution (Redis Pub/Sub subscribe → wait → fetch). 100 max concurrent limit.         |

### Risk & Dependencies

| #   | Question                     | Classification | Decision                                                                       |
| --- | ---------------------------- | -------------- | ------------------------------------------------------------------------------ |
| Q11 | Other ongoing changes?       | ANSWERED       | Canvas-based workflow editor recently merged. No conflicts.                    |
| Q12 | Biggest implementation risk? | INFERRED       | Redis Pub/Sub reliability for sync wait. Mitigated by timeout → async fallback |
| Q13 | Team dependencies?           | DECIDED        | Self-contained. No external team review needed.                                |
| Q14 | Monitoring/alerting?         | ANSWERED       | Existing Restate/BullMQ monitoring. No new dashboards for Phase 1.             |
| Q15 | Definition of done?          | ANSWERED       | All 24 FRs, 13 E2E, 10 INT, 7 UT suites passing. Post-impl-sync complete.      |

## Design Decisions

9 decisions documented (D-1 through D-9):

- D-1: Pure function preset resolver (not class — no state needed)
- D-2: Separate BullMQ queue for callbacks (isolation from scheduling)
- D-3: SSRF check in callback worker (block private IPs)
- D-4: Client-side API key filtering for reuse detection
- D-5: uuidv7 for runtime-generated executionId
- D-6: 100 max concurrent sync subscriptions
- D-7: i18n for all new Studio components
- D-8: Per-tenant HMAC secret from tenant config (user decision)
- D-9: SWR invalidation + loading states for Studio components

## Audit Findings

### Round 1 — NEEDS_REVISION (lld-reviewer)

| Severity | Finding                                            | Resolution                                                                             |
| -------- | -------------------------------------------------- | -------------------------------------------------------------------------------------- |
| CRITICAL | `req.apiKeyResolution` doesn't exist               | Replaced with `req.tenantContext` (correct fields: permissions, etc.)                  |
| CRITICAL | triggerMetadata field missing on WorkflowExecution | Added as `Schema.Types.Mixed` with interface update                                    |
| CRITICAL | executionId threading through Restate unclear      | Documented full path: Process API → execute endpoint → startWorkflow → createExecution |
| HIGH     | Auth type field undocumented                       | Added `authType: 'api_key'` check                                                      |

### Round 2 — NEEDS_REVISION (lld-reviewer)

| Severity | Finding                                      | Resolution                                                               |
| -------- | -------------------------------------------- | ------------------------------------------------------------------------ |
| CRITICAL | ExecutionPersistence interface not mentioned | Added explicit interface update at workflow-handler.ts lines 76-85       |
| HIGH     | Scope check returns 404 but HLD says 403     | Reverted to 403 for missing scope, 404 only for cross-tenant/project     |
| HIGH     | Workflow lookup without projectId            | Tenant-scoped query first, then projectId verification against key scope |
| HIGH     | UUIDv4 vs v7 inconsistency                   | Changed to `uuidv7()` from `@agent-platform/database`                    |

### Round 3 — NEEDS_REVISION (lld-reviewer)

| Severity | Finding                                  | Resolution                                                  |
| -------- | ---------------------------------------- | ----------------------------------------------------------- |
| HIGH     | Wrong input schema field path            | Changed to `workflow.inputSchema` (top-level field)         |
| HIGH     | Dockerfile COPY note incorrect           | Removed — cron-parser is npm package, not workspace package |
| MEDIUM   | cron-parser validation specifics unclear | Documented validation approach in Task 2.1                  |

### Round 4 — NEEDS_REVISION (phase-auditor, cross-phase)

| Severity | Finding                                          | Resolution                                                              |
| -------- | ------------------------------------------------ | ----------------------------------------------------------------------- |
| CRITICAL | Test file mapping diverges from test spec Sec. 8 | Updated all test file names in New Files table and Phase 2/3 tasks      |
| CRITICAL | FR-23 reuse-key query not specified              | Added client-side filtering logic to Task 3.2 (WebhookKeyCreationModal) |
| HIGH     | Phase 1 E2E test references missing auth file    | Added `process-api-auth.e2e.test.ts` to Phase 1 Files Touched           |

### Round 5 — APPROVED (lld-reviewer, final sweep)

| Severity | Finding                                            | Resolution                                                            |
| -------- | -------------------------------------------------- | --------------------------------------------------------------------- |
| MEDIUM   | UT-4 not explicitly assigned to a test task        | Noted as subsumed by INT-9/INT-10 in Task 1.8                         |
| MEDIUM   | SEC-8 not explicitly assigned to a test task       | Noted as covered by existing trigger CRUD route isolation in Task 3.9 |
| LOW      | Feature spec FR-20 has stale field path            | Flagged for `/post-impl-sync` correction                              |
| LOW      | Open question #2 (secret storage) still unresolved | Deferred to Phase 2 implementation                                    |

All prior round fixes verified: auth properties, field paths, executionId, BullMQ standards, wiring checklist, test file mapping.

## Cross-Phase Consistency

- All 24 FRs from feature spec mapped to implementation phases
- All 13 E2E scenarios from test spec mapped to test tasks with correct file names
- All 10 integration scenarios mapped to test tasks with correct file names
- All 7 unit test scenarios mapped (UT-4 subsumed by INT-9/INT-10)
- SEC-1 through SEC-8 all mapped to specific test tasks
- Error codes match HLD error table (401/403/404/400/502/503)
- Data flow matches HLD sequence diagrams

## Files Created/Modified

- `docs/plans/2026-03-24-workflow-triggers-impl-plan.md` (LLD — NEW)
- `docs/sdlc-logs/workflow-triggers/lld.log.md` (this file)

## Next Phase

Run `/implement workflow-triggers` to begin implementation.

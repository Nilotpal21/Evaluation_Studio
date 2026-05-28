# SDLC Log: Workflow Triggers — Test Spec

**Phase**: TEST-SPEC
**Date**: 2026-03-24
**Artifact**: `docs/testing/sub-features/workflow-triggers.md`

---

## Oracle Decisions

All 15 clarifying questions answered autonomously (0 AMBIGUOUS, 0 escalated to user).

| #   | Question                            | Classification | Decision                                                                              |
| --- | ----------------------------------- | -------------- | ------------------------------------------------------------------------------------- |
| Q1  | Highest-risk FRs?                   | ANSWERED       | FR-01 (auth), FR-03/05 (sync+timeout), FR-09 (HMAC), FR-13 (one-shot), FR-17 (audit)  |
| Q2  | Known edge cases/failures?          | INFERRED       | No production data; code reveals missing tz, required connectorName, no timeout logic |
| Q3  | Current test coverage baseline?     | ANSWERED       | 15 unit tests, all mocked. Zero E2E/integration. All 24 FRs NOT TESTED.               |
| Q4  | External deps: mock vs real?        | INFERRED       | Real: MongoDB, Redis, Express, BullMQ. Mock via DI: Restate only.                     |
| Q5  | Test environment setup?             | INFERRED       | 3 vitest configs, Docker for MongoDB/Redis, Restate mocked via TriggerEngineDeps DI   |
| Q6  | Critical user journeys?             | ANSWERED       | 7 existing E2E scenarios + 4 missing (callback, one-shot, auto-key, input validation) |
| Q7  | Auth/permission combos?             | ANSWERED       | API key: valid/invalid/no-scope/wrong-project/expired/revoked. JWT: CRUD permissions. |
| Q8  | Cross-feature interactions?         | ANSWERED       | ApiKey system, WorkflowExecution, BullMQ, webhook-signature, deployments              |
| Q9  | Data seeding?                       | INFERRED       | Via POST endpoints: tenant, user, project, workflow, API key. No direct DB inserts.   |
| Q10 | Performance/load scenarios?         | ANSWERED       | PERF-1 (sync p99<5s), PERF-2 (poll p99<200ms). Sufficient for PLANNED.                |
| Q11 | Service boundaries for integration? | INFERRED       | Runtime→Engine proxy, Process API→ApiKey, Scheduler→BullMQ→MongoDB, Callback→URL      |
| Q12 | Webhook/event-driven flows?         | ANSWERED       | Outbound callback, Redis Pub/Sub completion, async Process API                        |
| Q13 | Tenant/project isolation?           | ANSWERED       | Cross-tenant→404, cross-project→404, status polling scoped to workflowId              |
| Q14 | Race conditions?                    | INFERRED       | Sync timeout race, concurrent calls, one-shot+pause TOCTOU, key revocation mid-flight |
| Q15 | Error/failure paths?                | INFERRED       | Restate down→503, workflow not active→404, bad schema→400, callback fail→retry        |

## Test Spec Summary

- **Coverage matrix**: 24 FRs mapped across Unit/Integration/E2E/Manual
- **E2E scenarios**: 12 (E2E-1 through E2E-12)
- **Integration scenarios**: 10 (INT-1 through INT-10)
- **Unit scenarios**: 7 (UT-1 through UT-7)
- **Security scenarios**: 8 (SEC-1 through SEC-8)
- **Performance scenarios**: 3 (PERF-1 through PERF-3)
- **Test file mapping**: 11 planned files + 9 existing unit files

## Audit Findings

### Round 1 — NEEDS_REVISION

| Severity | Finding                                       | Resolution                                                        |
| -------- | --------------------------------------------- | ----------------------------------------------------------------- |
| CRITICAL | FR-05 has no E2E coverage                     | Added E2E-13 (sync timeout auto-promotion)                        |
| CRITICAL | FR-12 coverage matrix inconsistent with INT-3 | Updated FR-12 integration column, added FR-12 to INT-3 covers     |
| CRITICAL | FR-15 has no integration coverage             | Updated FR-15 integration column, added to INT-3 with step 9      |
| HIGH     | Missing cross-user isolation test             | Added SEC-8 (triggers are project-scoped, N/A with justification) |
| HIGH     | Only one failure-path integration test        | Added INT-10 (cancelled workflow status)                          |
| HIGH     | E2E-3 preconditions underspecified            | Fleshed out with full seed steps                                  |
| HIGH     | SEC-7 mapped to wrong test file               | Moved to `trigger-schedule.e2e.test.ts`                           |
| HIGH     | Inconsistent integration test file naming     | Standardized to `process-api.integration.test.ts`                 |
| MEDIUM   | ioredis-mock scope ambiguity                  | Qualified as "real Redis required for integration/E2E"            |
| MEDIUM   | mongodb-memory-server role ambiguous          | Added note about HTTP-based seeding                               |

### Round 2 — APPROVED

| Severity | Finding                                       | Resolution                                         |
| -------- | --------------------------------------------- | -------------------------------------------------- |
| HIGH     | No partial retry path for callback (500→200)  | Deferred to implementation — logged as enhancement |
| MEDIUM   | FR-09 coverage matrix E2E column inconsistent | Fixed: updated FR-09 E2E column to match E2E-8     |
| MEDIUM   | Manual test checklist pointer missing         | Deferred — will create during implementation       |

## Files Created/Modified

- `docs/testing/sub-features/workflow-triggers.md` (test spec — REPLACED placeholder)
- `docs/sdlc-logs/workflow-triggers/test-spec.log.md` (this file)

## Next Phase

Run `/hld workflow-triggers` to generate the High-Level Design document.

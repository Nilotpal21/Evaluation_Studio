# SDLC Log: Workflow Versioning — Test Spec

**Phase**: TEST-SPEC
**Date**: 2026-04-14
**Feature Slug**: workflow-versioning
**Artifact**: `docs/testing/sub-features/workflow-versioning.md`

---

## Oracle Decisions

All 15 clarifying questions answered by the product oracle. No AMBIGUOUS items required user escalation.

### Test Scope & Priorities

| #   | Question                        | Classification | Decision                                                                                                       |
| --- | ------------------------------- | -------------- | -------------------------------------------------------------------------------------------------------------- |
| Q1  | Highest-risk FRs?               | INFERRED       | FR-12 (cascade) > FR-14 (resolution) > FR-8 (trigger binding) > FR-18 (cron path) > FR-17 (env routing)        |
| Q2  | Current test coverage baseline? | ANSWERED       | 3 test files (28 tests) cover OLD 5-status model only. Zero new-model coverage. Route tests have 6 vi.mocks.   |
| Q3  | External deps mock vs real?     | INFERRED       | Real: MongoDB (MongoMemoryServer), Express middleware. Mock via DI: BullMQ, Restate. No mocking platform code. |
| Q4  | Test environment setup?         | ANSWERED       | Docker (Mongo 27018, Redis 6380, Restate 8091), MongoMemoryServer, Vitest tiered, Playwright for Studio E2E    |
| Q5  | Edge cases from gaps?           | ANSWERED       | 8 gaps mapped to test edge cases. GAP-001/004/008 are High severity with mandatory test scenarios.             |

### E2E Scenarios

| #   | Question                | Classification | Decision                                                                                                                |
| --- | ----------------------- | -------------- | ----------------------------------------------------------------------------------------------------------------------- |
| Q6  | Critical user journeys? | INFERRED       | 6 journeys: full lifecycle, default resolution, soft delete cascade, cron frozen flow, trigger toggle, explicit version |
| Q7  | Auth/permission combos? | INFERRED       | deployment:create, workflow:write/read/delete, cross-tenant/project 404, API key auth                                   |
| Q8  | Cross-feature E2E?      | ANSWERED       | 5 interactions: workflow-as-tool, deployments, Process API, import/export, canvas auto-save                             |
| Q9  | Data seeding?           | INFERRED       | 2 tenants, 2 projects, 2 users, workflow with nodes/edges, triggers, published versions                                 |
| Q10 | API endpoints coverage? | ANSWERED       | 14 runtime + 5 studio proxy endpoints. 10 rated HIGH priority.                                                          |

### Integration Boundaries

| #   | Question             | Classification | Decision                                                                                               |
| --- | -------------------- | -------------- | ------------------------------------------------------------------------------------------------------ |
| Q11 | Service boundaries?  | INFERRED       | 7 boundaries: VersionService→Mongo, VersionService→TriggerReg, Engine→Scheduler→BullMQ, fire paths     |
| Q12 | Event-driven flows?  | ANSWERED       | 3 flows: webhook fire, app-event env routing (5 cases), cron processing                                |
| Q13 | Isolation scenarios? | INFERRED       | 7 scenarios: cross-tenant list/activate, cross-project access, resolution isolation, trigger isolation |
| Q14 | Race conditions?     | ANSWERED       | 6 scenarios: concurrent activate/deactivate, draft save during deploy, cron fire after deactivation    |
| Q15 | Error/failure paths? | INFERRED       | 12 error paths: BullMQ down, tx failure, version not found, frozen field edit, toggle on inactive      |

### Decisions Made

| #   | Decision                                         | Rationale                                          |
| --- | ------------------------------------------------ | -------------------------------------------------- |
| D-1 | Activate already-active version = idempotent 200 | Follows platform's idempotent state patterns       |
| D-2 | Delete already-deleted workflow = idempotent 200 | Same rationale, existing soft delete is idempotent |

---

## Audit Results

| Round | Result         | Findings                                                                                                       |
| ----- | -------------- | -------------------------------------------------------------------------------------------------------------- |
| 1     | NEEDS_REVISION | 1 CRITICAL (FR-11 no scenario), 3 HIGH (missing 401 E2E, FR-19 matrix inconsistency, incomplete auth contexts) |
| 2     | APPROVED       | 1 MEDIUM (envVars mutability TBD — deferred to HLD)                                                            |

## Files Created/Modified

- `docs/testing/sub-features/workflow-versioning.md` — full test spec (9 E2E, 12 INT, 6 UT)
- `docs/testing/README.md` — updated entry counts
- `docs/features/sub-features/workflow-versioning.md` — updated §17 testing notes
- `docs/sdlc-logs/workflow-versioning/test-spec.log.md` — this log

## Next Phase

Run `/hld workflow-versioning` to generate the high-level design.

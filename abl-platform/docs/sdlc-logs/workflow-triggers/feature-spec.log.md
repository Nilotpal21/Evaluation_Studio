# SDLC Log: Workflow Triggers — Feature Spec

**Phase**: FEATURE-SPEC
**Date**: 2026-03-24
**Artifact**: `docs/features/sub-features/workflow-triggers.md`

---

## Oracle Decisions

All 15 clarifying questions answered autonomously (0 AMBIGUOUS, 0 escalated to user).

| #   | Question                     | Classification | Decision                                                        |
| --- | ---------------------------- | -------------- | --------------------------------------------------------------- |
| Q1  | Enhancement vs greenfield?   | ANSWERED       | Enhancement — substantial trigger infrastructure already exists |
| Q2  | New public process API?      | DECIDED        | Yes, coexists with internal project-scoped API                  |
| Q3  | API key only or JWT too?     | DECIDED        | Both supported — API key for public, JWT for internal           |
| Q4  | Callback URL scoping?        | DECIDED        | Per-API-call (in request body)                                  |
| Q5  | External apps scope?         | INFERRED       | Catalog only, no implementation                                 |
| Q6  | Primary personas?            | INFERRED       | External developers + Studio business users                     |
| Q7  | Once trigger behavior?       | DECIDED        | Auto-pause (not delete) for audit trail                         |
| Q8  | Poll response content?       | DECIDED        | Full result when completed                                      |
| Q9  | Sync timeout behavior?       | DECIDED        | 30s timeout, auto-promote to async                              |
| Q10 | Schedule defaults?           | DECIDED        | 9:00 AM, Monday, 1st of month                                   |
| Q11 | Route location?              | DECIDED        | Runtime (port 3112) — public-facing service                     |
| Q12 | Reuse webhook models?        | DECIDED        | Reuse webhook-signature.ts, skip Subscription models            |
| Q13 | API key model?               | ANSWERED       | Extend existing WorkflowApiKey                                  |
| Q14 | Timezone approach?           | DECIDED        | BullMQ native `tz` option                                       |
| Q15 | External apps spec approach? | ANSWERED       | List connectors + reference existing infra                      |

## Audit Findings

### Round 1 — APPROVED

| Severity | Finding                                                                    | Resolution                                            |
| -------- | -------------------------------------------------------------------------- | ----------------------------------------------------- |
| HIGH     | Missing `keyHash` index on WorkflowApiKey                                  | Added to Data Model + delivery subtask 0.1            |
| HIGH     | TriggerRegistration `connectorName`/`connectionId` required for time-based | Documented as needing optional + delivery subtask 0.2 |
| HIGH     | traceId mapping unclear, API table missing query param                     | Added TraceId Mapping section, updated API table      |
| MEDIUM   | Model described as "existing" but unwired                                  | Clarified model exists but no routes/middleware       |
| MEDIUM   | NG4 inbound/outbound confusion                                             | Reworded for clarity                                  |

### Round 2 — APPROVED

| Severity | Finding                          | Resolution                                          |
| -------- | -------------------------------- | --------------------------------------------------- |
| HIGH     | FR-19 doesn't specify service    | Added "Runtime service (port 3112)"                 |
| MEDIUM   | `once` strategy enum unspecified | Clarified as `strategy: 'cron'` with BullMQ `delay` |

## Files Created

- `docs/features/sub-features/workflow-triggers.md` (feature spec)
- `docs/testing/sub-features/workflow-triggers.md` (testing guide placeholder)
- `docs/sdlc-logs/workflow-triggers/feature-spec.log.md` (this file)
- Updated: `docs/features/sub-features/README.md`, `docs/testing/sub-features/README.md`

## Next Phase

Run `/test-spec workflow-triggers` to generate the full test specification.

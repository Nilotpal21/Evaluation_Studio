# SDLC Log: Workflow Triggers — HLD

**Phase**: HLD
**Date**: 2026-03-24
**Artifact**: `docs/specs/workflow-triggers.hld.md`

---

## Oracle Decisions

All 12 clarifying questions answered autonomously (0 AMBIGUOUS, 0 escalated to user).

| #   | Question                                  | Classification | Decision                                                                                        |
| --- | ----------------------------------------- | -------------- | ----------------------------------------------------------------------------------------------- |
| Q1  | Preferred architecture pattern?           | ANSWERED       | Two-service: Runtime (public) + Workflow Engine (internal). Runtime proxies execution requests. |
| Q2  | Data flow: request-driven or event-driven | ANSWERED       | Both: sync via Redis Pub/Sub, async via BullMQ queues, scheduling via BullMQ repeatable jobs    |
| Q3  | Expected scale?                           | INFERRED       | Low-medium initially; sync p99<5s, poll p99<200ms. BullMQ handles scheduling scale.             |
| Q4  | Existing patterns to follow?              | ANSWERED       | Existing TriggerEngine, TriggerScheduler, connector trigger patterns. Process API is new.       |
| Q5  | Deployment topology?                      | ANSWERED       | Same two services, no new deployments. New BullMQ queue `workflow-callbacks`.                   |
| Q6  | Existing service dependencies?            | ANSWERED       | ApiKey system, WorkflowExecution model, BullMQ, Redis Pub/Sub, Restate                          |
| Q7  | New external dependencies?                | ANSWERED       | None. All infrastructure (Redis, BullMQ, MongoDB) already exists.                               |
| Q8  | API contract with consumers?              | ANSWERED       | Process API: POST /api/v1/process/:workflowId, GET status?traceId=. Auth via x-api-key header.  |
| Q9  | Breaking changes?                         | ANSWERED       | No breaking changes. TriggerRegistration schema relaxed (connectorName/connectionId optional).  |
| Q10 | Biggest technical risk?                   | INFERRED       | Sync execution timeout handling and Redis Pub/Sub reliability for completion notification       |
| Q11 | Data migration needed?                    | ANSWERED       | No migration — existing triggers continue working. New fields are optional additions.           |
| Q12 | Rollback strategy?                        | INFERRED       | Remove Process API routes, stop new BullMQ queue. Existing triggers and workflows unaffected.   |

## Alternatives Considered

| Option                      | Verdict     | Rationale                                                                     |
| --------------------------- | ----------- | ----------------------------------------------------------------------------- |
| A: Redis Pub/Sub (selected) | RECOMMENDED | Leverages existing infrastructure, sub-second latency, minimal new complexity |
| B: MongoDB polling          | REJECTED    | 1-2s latency floor, DB load at scale, inefficient for sync use case           |
| C: Direct Restate access    | REJECTED    | Violates two-service architecture, couples runtime to Restate internals       |

## Audit Findings

### Round 1 — NEEDS_REVISION

| Severity | Finding                                              | Resolution                                                                     |
| -------- | ---------------------------------------------------- | ------------------------------------------------------------------------------ |
| HIGH     | Option C referenced unverified RestateWorkflowClient | Changed to "Restate ingress API"                                               |
| HIGH     | Status polling missing tenantId in query             | Added tenantId to polling query in concern #2                                  |
| HIGH     | Subscribe-before-start race condition                | Redesigned: runtime generates executionId (UUIDv7), subscribes BEFORE starting |
| HIGH     | Missing traceId validation error code                | Added INVALID_TRACE_ID 400 error                                               |
| MEDIUM   | Design lint at 90% (missing Overview/Goal)           | Added Section 1 with Problem Statement and Design Goal subsections             |

### Round 2 — NEEDS_REVISION

| Severity | Finding                                                  | Resolution                                                                            |
| -------- | -------------------------------------------------------- | ------------------------------------------------------------------------------------- |
| HIGH     | Pub/Sub completion event carries no result payload       | Added MongoDB fetch step (step 12) to sync diagram; added MongoDB unavailability mode |
| HIGH     | Strategy enum mapping undocumented                       | Added mapping: webhook->'webhook', presets->'cron', once->'cron' with delay           |
| HIGH     | HTTP 502/503 codes inconsistent                          | Split: 502 UPSTREAM_UNAVAILABLE (engine down), 503 SERVICE_UNAVAILABLE (Restate down) |
| HIGH     | callbackUrl wiring from request to delivery undocumented | Added explicit wiring documentation through triggerMetadata → execution → BullMQ      |
| MEDIUM   | Rollback plan missing orphaned queue jobs                | Added BullMQ TTL expiry and manual queue.obliterate() to rollback plan                |

### Round 3 — APPROVED

| Severity | Finding                                             | Resolution                                                                  |
| -------- | --------------------------------------------------- | --------------------------------------------------------------------------- |
| HIGH     | ExecutionId UUIDv7 vs existing UUIDv4 contract gap  | Added internal API contract change note (additive, backward-compatible)     |
| MEDIUM   | FR-23 reuse-key query logic not described           | Deferred to LLD — query pattern will be specified in implementation plan    |
| MEDIUM   | Redis Pub/Sub channel event filtering not mentioned | Deferred to LLD — subscriber must filter for workflow-level terminal events |
| MEDIUM   | Open question #3 (webhook secret source) unresolved | Flagged as must-resolve-before-LLD blocking dependency                      |

## Cross-Phase Consistency

- All 24 FRs from feature spec traceable to HLD design decisions
- 13 E2E scenarios from test spec align with HLD data flows
- 10 integration scenarios align with HLD service boundaries
- Terminology consistent across all three documents
- No scope drift from feature spec goals/non-goals

## Files Created/Modified

- `docs/specs/workflow-triggers.hld.md` (HLD — NEW)
- `docs/sdlc-logs/workflow-triggers/hld.log.md` (this file)

## Next Phase

Run `/lld workflow-triggers` to generate the Low-Level Design and implementation plan.

**Must resolve before LLD**: Open question #3 (callback webhook HMAC signing secret source).

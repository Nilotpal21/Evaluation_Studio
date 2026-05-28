# SDLC Log: Webhook System — HLD

**Phase:** High-Level Design
**Date:** 2026-03-22
**Status:** Complete

## 12 Architectural Concerns Coverage

| #   | Concern                        | Addressed | Key Mechanism                                                                      |
| --- | ------------------------------ | --------- | ---------------------------------------------------------------------------------- |
| 1   | Resource Isolation             | YES       | tenantId on all queries, 404 for cross-tenant, project validation                  |
| 2   | Authentication & Authorization | YES       | authMiddleware + requirePermission per endpoint                                    |
| 3   | Stateless & Distributed        | YES       | All state in MongoDB/Redis, BullMQ distributes jobs, Redis distributed locks       |
| 4   | Traceability                   | YES       | AuditStore for CRUD, structured logging, WebhookDelivery as audit trail            |
| 5   | Compliance                     | YES       | Encryption at rest, TTL retention, data minimization, secret lifecycle             |
| 6   | Performance                    | YES       | Concurrent workers, queue cleanup, response truncation, compound indexes           |
| 7   | Error Handling                 | YES       | Categorized retry (5xx vs 4xx vs 410), graceful degradation, auth profile fallback |
| 8   | Scalability                    | YES       | Horizontal pod scaling, BullMQ distribution, no bottlenecks                        |
| 9   | Observability                  | YES       | Structured logging, audit store, delivery records, failure tracking                |
| 10  | Backward Compatibility         | YES       | Auth profile dual-read, forward-looking event type union                           |
| 11  | Deployment & Configuration     | YES       | Environment variables documented, infrastructure requirements listed               |
| 12  | Alternatives Considered        | YES       | 6 alternatives evaluated and rejected with rationale                               |

## Key Decisions

| ID  | Classification | Decision                                                                     |
| --- | -------------- | ---------------------------------------------------------------------------- |
| H1  | ANSWERED       | BullMQ is the delivery queue (already implemented, consistent with platform) |
| H2  | ANSWERED       | HMAC-SHA256 with timestamp is the signing standard (industry standard)       |
| H3  | ANSWERED       | SSRF protection uses dual-check (registration + delivery time)               |
| H4  | DECIDED        | No separate webhook microservice — delivery worker colocated with runtime    |
| H5  | DECIDED        | No circuit breaker in initial design — deferred to future enhancement        |
| H6  | DECIDED        | Response bodies truncated to 1000 chars for storage efficiency               |

## Output

- `docs/specs/webhook-system.hld.md` — HLD addressing all 12 architectural concerns

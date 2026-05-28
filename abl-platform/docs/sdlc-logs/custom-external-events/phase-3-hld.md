# SDLC Log: Custom External Events -- Phase 3 (HLD)

**Date:** 2026-03-23
**Phase:** HLD
**Artifact:** `docs/specs/custom-external-events.hld.md`

## Architecture Decisions

| Decision           | Choice                                                                                   | Alternatives Rejected                                                       |
| ------------------ | ---------------------------------------------------------------------------------------- | --------------------------------------------------------------------------- |
| Event type storage | MongoDB                                                                                  | Redis (no persistence guarantees), ClickHouse (not suited for CRUD)         |
| Payload validation | Ajv JSON Schema                                                                          | Zod (not standard for external schema definition), custom validators        |
| Session delivery   | In-process event bus                                                                     | Redis Pub/Sub (adds latency), WebSocket (external systems use REST)         |
| Event persistence  | ClickHouse                                                                               | MongoDB (not optimized for time-series), Kafka log compaction (too complex) |
| Webhook delivery   | BullMQ                                                                                   | Direct HTTP (no retry), Kafka (overkill for webhook fan-out)                |
| Naming convention  | `custom:<name>` in lifecycle, `custom.<name>` in event bus, `abl.custom.<name>` in Kafka | Single naming (causes confusion between lifecycle and transport layers)     |

## 12 Concerns Coverage

All 12 architectural concerns addressed:

1. Resource Isolation -- tenant + project scoping on all queries
2. Auth -- authMiddleware + requireProjectScope + permissions
3. Rate Limiting -- per-tenant, per-project on ingestion
4. Validation -- name rules, JSON Schema, payload size
5. Error Handling -- standard envelope, specific error codes
6. Observability -- trace events, structured logging, ClickHouse audit trail
7. Performance -- async writes, cached validators, batch inserts
8. Data Integrity -- server-side IDs, ReplacingMergeTree, unique indexes
9. Scalability -- ClickHouse for volume, MongoDB for config, BullMQ for webhooks
10. Compliance -- TTL, erasure cascades, encrypted secrets
11. Backward Compatibility -- additive changes only
12. Failure Modes -- graceful degradation for each dependency

## Phase Audit

### Self-Review Findings

| #   | Severity | Finding                                                                                                       | Resolution                                                                                                                                                     |
| --- | -------- | ------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 1   | HIGH     | Naming inconsistency: `custom:order.shipped` in lifecycle vs `custom.order.shipped` in event bus -- confusing | Documented explicitly in HLD; the colon is lifecycle convention (`agent:X:before`), dot is Kafka convention (`session.ended`). Both map to same logical event. |
| 2   | MEDIUM   | No cross-pod event delivery strategy for sessions on different runtime pods                                   | Documented as future work; MVP uses in-process delivery. For multi-pod, need Redis Pub/Sub or Kafka consumer group.                                            |
| 3   | MEDIUM   | Webhook secret storage says "encrypted at rest" but no specific encryption mechanism named                    | Uses platform's `encryption_master_key` via existing `@agent-platform/shared-kernel` encryption utilities                                                      |
| 4   | LOW      | No explicit API versioning strategy for custom events API                                                     | Uses same versioning as rest of platform (URL-based if needed)                                                                                                 |

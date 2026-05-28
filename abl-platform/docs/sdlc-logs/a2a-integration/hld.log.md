# HLD Log: A2A Integration

**Date**: 2026-03-22
**Phase**: 3 - HLD
**Feature**: a2a-integration

## Clarifying Questions & Decision Protocol

### Architecture & Data Flow

| Question                        | Classification | Answer                                                                                                                        |
| ------------------------------- | -------------- | ----------------------------------------------------------------------------------------------------------------------------- |
| Preferred architecture pattern? | ANSWERED       | Hexagonal architecture already implemented in `packages/a2a/` -- domain ports, application use cases, infrastructure adapters |
| Data flow pattern?              | ANSWERED       | Request-driven (JSON-RPC) + event-driven (SSE streaming, push notification callbacks, BullMQ resume)                          |
| Expected scale?                 | INFERRED       | Standard platform scale (100s of concurrent connections). Redis-backed stores support multi-pod.                              |
| Existing patterns to follow?    | ANSWERED       | Channel connection model, suspension/resumption engine, callback registry pattern                                             |

### Integration & Dependencies

| Question                      | Classification | Answer                                                                             |
| ----------------------------- | -------------- | ---------------------------------------------------------------------------------- |
| Which services depend on A2A? | ANSWERED       | RoutingExecutor (outbound), Channel system (connection type), Studio (CRUD UI)     |
| External dependencies?        | ANSWERED       | `@a2a-js/sdk` v0.2.5+ (npm), Redis, BullMQ                                         |
| Breaking changes?             | DECIDED        | None -- A2A is additive. Connection-scoped endpoints don't affect existing routes. |

### Risk & Migration

| Question                | Classification | Answer                                                                           |
| ----------------------- | -------------- | -------------------------------------------------------------------------------- |
| Biggest technical risk? | DECIDED        | SDK stability (generator hang, history clearing, relative URLs)                  |
| Data migration needed?  | ANSWERED       | No -- all Redis data has TTLs, channel_connections schema is backward-compatible |
| Rollback strategy?      | DECIDED        | Deactivate connections or remove A2A route mounting. All data expires via TTL.   |

## Files Created

- `docs/specs/a2a-integration.hld.md` -- 10 sections, all 12 architectural concerns, 3 alternatives, architecture diagrams

## Review Summary

### Round 1 -- Full Audit

- All 12 architectural concerns addressed with specific code references
- 3 alternatives considered (global mounting, connection-scoped, SDK-native)
- Architecture diagrams: system context, component, 3 data flow sequences
- Data model complete with Redis key schema
- API design references existing endpoints
- 5 open questions listed

### Round 2 -- Deep Dive

- Data model verified against actual Redis key patterns in `redis-task-store.ts`
- Error model covers 8 specific error cases with HTTP status and JSON-RPC codes
- Performance budget is realistic (based on Redis operation latencies)
- Failure modes cover Redis down, BullMQ failure, SDK hang, remote agent unreachable

### Round 3 -- Cross-Phase Consistency

- HLD implements all 10 FRs from feature spec
- Test strategy aligns with 7 E2E + 7 integration scenarios from test spec
- No contradictions between feature spec and HLD
- Tenant isolation documented at query level for all data stores

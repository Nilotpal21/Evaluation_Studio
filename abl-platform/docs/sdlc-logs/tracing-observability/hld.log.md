# SDLC Log: Tracing & Observability -- HLD

**Phase:** High-Level Design (Phase 3)
**Date:** 2026-03-22
**Status:** Complete

## Process

### Inputs

- Feature spec: `docs/features/tracing-observability.md`
- Test spec: `docs/testing/tracing-observability.md`
- Source code from 20+ files across observatory, runtime, studio, eventstore packages

### 12 Architectural Concerns Addressed

| #   | Concern               | Status    | Key Points                                                                                 |
| --- | --------------------- | --------- | ------------------------------------------------------------------------------------------ |
| 1   | Resource Isolation    | Addressed | Tenant-scoped Redis keys, tenantId in all queries, project permission guards               |
| 2   | Centralized Auth      | Addressed | All endpoints use createUnifiedAuthMiddleware, debug server has optional auth token        |
| 3   | Stateless Distributed | Addressed | Redis Streams + Pub/Sub for cross-pod, ClickHouse as canonical store, anti-duplicate logic |
| 4   | Traceability          | Addressed | This IS the traceability system (30+ event types, W3C IDs, hierarchical spans)             |
| 5   | Compliance            | Addressed | PII scrubbing at emission, GDPR cascades, encryption at rest, retention policies           |
| 6   | Performance           | Addressed | Ring buffer, bounded maps, Redis batching, memory pressure CB, buffered ClickHouse writes  |
| 7   | Error Handling        | Addressed | Fire-and-forget persistence, WAL recovery, dead socket cleanup, fallback chain             |
| 8   | Extensibility         | Addressed | TraceStoreInterface, extensible event types, mapping tables, debug protocol commands       |
| 9   | Observability         | Addressed | Store stats, memory monitoring, OTEL self-diagnostics, shed counting                       |
| 10  | Testing               | Addressed | 28 existing E2E + 23 new scenarios planned                                                 |
| 11  | Deployment            | Addressed | Feature flags (OTEL_ENABLED, METRICS_ENABLED), graceful shutdown, optional components      |
| 12  | Migration             | Addressed | Decision log merge completed, feature flag removal, no schema migration needed             |

### Design Decisions (8)

| ID  | Decision                          | Rationale                                   |
| --- | --------------------------------- | ------------------------------------------- |
| D1  | Three-tier storage                | Hot cache + warm cross-pod + cold analytics |
| D2  | Merge decisions into trace events | Single pipeline, single UI                  |
| D3  | W3C Trace Context IDs             | OTEL interop, standard tooling              |
| D4  | Redis Streams + Pub/Sub           | Durable replay + real-time fan-out          |
| D5  | Memory pressure circuit breaker   | Prevents Redis OOM                          |
| D6  | Fire-and-forget persistence       | Never block agent execution                 |
| D7  | Verbosity gating at emission      | Zero-cost suppression                       |
| D8  | PII scrubbing at emission         | PII never enters persistence                |

### Risks Identified (6)

- Memory TraceStore unbounded growth (mitigated: 50K cap + LRU)
- Redis memory exhaustion (mitigated: circuit breaker + MAXLEN)
- ClickHouse write lag (mitigated: buffering + WAL)
- OTEL activeSpans leak (partially mitigated: cleanup method exists, no automatic scheduling)
- Debug server port conflict (mitigated: configurable)
- Tenant cache exhaustion (mitigated: bounded LRU)

### Output

- HLD: `docs/specs/tracing-observability.hld.md`
- All 12 architectural concerns addressed
- 8 key design decisions documented with alternatives considered
- 6 risks with mitigations
- Complete API contract summary (REST, WebSocket, Debug protocol)
- Package dependency graph

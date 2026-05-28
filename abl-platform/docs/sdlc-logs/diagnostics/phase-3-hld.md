# SDLC Log: Diagnostics -- Phase 3 (HLD)

> **Date:** 2026-03-22
> **Phase:** HLD
> **Artifact:** `docs/specs/diagnostics.hld.md`

## Architectural Decisions

| Decision                                           | Rationale                                                                        |
| -------------------------------------------------- | -------------------------------------------------------------------------------- |
| MongoDB for report storage (not ClickHouse)        | Reports are nested documents, MongoDB is primary store, ClickHouse is optional   |
| Polling-based API (not WebSocket streaming)        | Diagnostics are periodic, not real-time; simpler architecture                    |
| Keep diagnostics in runtime (not separate service) | Analyzers need direct access to runtime internals                                |
| BullMQ for scheduling                              | Consistent with existing platform patterns, distributed, deduplication via jobId |
| Feature flag for persistence                       | Gradual rollout, backward-compatible by default                                  |

## 12 Architectural Concerns Addressed

1. **Resource Isolation**: Tenant, project, and user isolation documented with query-level enforcement
2. **Centralized Auth**: Standard middleware chain, new permissions (diagnostics:read/write)
3. **Stateless Distributed**: MongoDB persistence, BullMQ scheduling, no pod-local state
4. **Traceability**: TraceEvents for scheduled runs and remediation actions
5. **Compliance**: No credential exposure, TTL cleanup, right to erasure
6. **Performance**: Concurrent analyzers, compression, pagination, staggering
7. **Error Handling**: Per-analyzer try/catch, graceful degradation, standard error envelope
8. **Scalability**: Horizontal BullMQ workers, compound indexes, TTL auto-cleanup
9. **Observability**: Prometheus metrics, ClickHouse events, structured logging
10. **Backward Compatibility**: Opt-in persistence, additive schema changes, existing endpoints unchanged
11. **Deployment**: Feature flag, auto-collection creation, rolling deployment safe
12. **Testing**: Full test spec reference with 7 E2E + 8 integration scenarios

## Alternatives Evaluated

| Alternative             | Decision | Key Reason                                                |
| ----------------------- | -------- | --------------------------------------------------------- |
| ClickHouse for reports  | Rejected | Poor fit for nested documents, optional infrastructure    |
| Redis Pub/Sub streaming | Rejected | Unnecessary complexity for periodic checks                |
| Separate microservice   | Rejected | Analyzers need runtime internals, adds latency/complexity |

## New Components Designed

- 4 new analyzers (guardrail, memory, webhook, conversation quality)
- Report persistence service
- Diagnostic scheduler (BullMQ worker)
- Summary aggregation service
- Remediation framework with action registry
- 2 new MongoDB collections (diagnostic_reports, diagnostic_schedules)

## Audit Notes

- All 12 architectural concerns addressed with specific design decisions
- 3 alternatives evaluated with explicit pro/con analysis
- Data flow documented for 4 key scenarios
- Risk register with 6 identified risks and mitigations
- Schema design includes proper indexes and TTL

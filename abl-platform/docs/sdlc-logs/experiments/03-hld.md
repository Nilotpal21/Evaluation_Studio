# SDLC Log: Experiments — Phase 3 (HLD)

**Date**: 2026-03-23
**Artifact**: `docs/specs/experiments.hld.md`
**Status**: COMPLETE

## Alternatives Evaluated

| Option                | Description                                          | Verdict                                         |
| --------------------- | ---------------------------------------------------- | ----------------------------------------------- |
| A. Runtime-Integrated | Extend runtime session creation + version resolution | **Selected** — natural fit, minimal latency     |
| B. External Service   | Separate experiment microservice                     | Rejected — over-engineered, extra hop           |
| C. Client-Side SDK    | SDK assigns group before session                     | Rejected — cannot enforce server-side integrity |

## Key Architecture Decisions

1. **FNV-1a hash** for assignment — ~2ns, excellent uniformity, no crypto dependency
2. **Redis cache** for active experiment lookup — avoids MongoDB query per session creation
3. **Partial unique index** on `(projectId, status)` where `status = 'running'` — enforces one-active-per-project at DB level
4. **Async ClickHouse write** for assignment records — non-blocking session creation
5. **Periodic cron** for results computation — batch ClickHouse aggregation is more efficient than streaming
6. **Optimistic locking** (`_v` field) for experiment status transitions

## 12 Architectural Concerns Addressed

All 12 concerns documented in HLD Section 7:

- Tenant isolation (query-level, Redis key scoping)
- Auth (RBAC experiment:read/write)
- Performance (<2ms assignment overhead)
- Scalability (stateless hash, Redis cache, ClickHouse MVs)
- Reliability (graceful degradation, distributed locks)
- Observability (TraceEvents, structured logging)
- Security (RBAC, version validation, bounded inputs)
- Data consistency (atomic transitions, partial unique index, immutable assignments)
- Compliance (no PII, TTLs, right to erasure)
- Error handling (envelope response, specific error codes)
- Migration (backward compatible, additive changes)
- Testing (full specification in test-spec)

## Audit Findings

- Round 1: Verified all FRs are addressed by architecture components
- Round 2: Added sequence diagrams for session creation and guardrail check flows
- Round 3: Confirmed ClickHouse schema additions are backward compatible (DEFAULT '' columns)

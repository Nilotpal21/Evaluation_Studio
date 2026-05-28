# SDLC Log: Tracing & Observability -- LLD

**Phase:** Low-Level Design + Implementation Plan (Phase 4)
**Date:** 2026-03-22
**Status:** Complete

## Process

### Inputs

- Feature spec: `docs/features/tracing-observability.md`
- Test spec: `docs/testing/tracing-observability.md`
- HLD: `docs/specs/tracing-observability.hld.md`
- Source code from 20+ files across observatory, runtime, studio packages

### Implementation Status Assessment

The tracing & observability system is **largely implemented**. 18 components are complete and operational. The LLD focuses on:

1. Code quality hardening (3 files)
2. Test coverage gaps (13 new test files across 4 phases)
3. Production readiness features (sampling, UI wiring, Prometheus endpoint)

### Gaps Identified (10)

| ID  | Gap                                       | Severity | Phase   |
| --- | ----------------------------------------- | -------- | ------- |
| G1  | OtelTraceStore no periodic orphan cleanup | Medium   | Phase 1 |
| G2  | console.log in trace-store.ts             | Low      | Phase 1 |
| G3  | No trace sampling                         | Medium   | Phase 5 |
| G4  | SpanTree not rendered in UI               | Medium   | Phase 5 |
| G5  | No Prometheus scrape endpoint             | Low      | Phase 5 |
| G6  | Tenant cache size not configurable        | Low      | Phase 1 |
| G7  | No PII scrubbing E2E test                 | Medium   | Phase 4 |
| G8  | No Redis cross-pod integration test       | Medium   | Phase 3 |
| G9  | No OTEL bridge integration test           | Medium   | Phase 3 |
| G10 | CSV export CH fallback incomplete         | Low      | Phase 5 |

### Phase Plan Summary

| Phase | Priority | Objective                  | Files            | Exit Criteria                                          |
| ----- | -------- | -------------------------- | ---------------- | ------------------------------------------------------ |
| 1     | P0       | Code quality + hardening   | 3 modified       | Zero console.log, periodic cleanup, configurable cache |
| 2     | P0       | Core test coverage         | 6 new test files | INT-1, INT-2, INT-5, INT-9, INT-10, UNIT-1-5 pass      |
| 3     | P1       | Advanced integration tests | 3 new test files | INT-6, INT-7, INT-8 pass                               |
| 4     | P1       | E2E tests                  | 4 new test files | E2E-1, E2E-2, E2E-4, E2E-6 pass                        |
| 5     | P2       | Production readiness       | 3-4 files        | Sampling, SpanTree UI, Prometheus endpoint             |

### Wiring Verification

All 12 wiring points verified via source code reading:

- TraceEmitter -> TraceStore -> EventStore -> ClickHouse pipeline complete
- Redis Streams + Pub/Sub cross-pod delivery operational
- OTEL SDK initialized correctly as first import
- Debug server integrated with DebugRuntimeExecutor
- GDPR cascade hooks registered
- Graceful shutdown handlers in place

### Output

- LLD + Implementation Plan: `docs/plans/2026-03-22-tracing-observability-impl-plan.md`
- 5 phases with exit criteria
- 16 new test files planned across phases 2-4
- 12 wiring points verified
- 10 gaps documented with severity and target phase
- File change summary per phase
- Definition of done checklist

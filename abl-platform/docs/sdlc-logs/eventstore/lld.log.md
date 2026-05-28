# EventStore LLD - SDLC Log

> **Phase**: LLD (Phase 4)
> **Date**: 2026-03-22
> **Feature**: eventstore

## Summary

Generated Low-Level Design documenting the existing implementation (STABLE) and identifying remaining work for production hardening across 4 phases.

## Key Decisions

1. **Post-impl LLD format**: Since EventStore is already fully implemented, the LLD documents current state and identifies hardening gaps rather than prescribing new implementation from scratch
2. **Phase ordering**: Security (P0) and Code Quality (P1) can run in parallel; Testing depends on Security fixes; Observability depends on Code Quality (needs createLogger in place)
3. **Cross-tenant wildcard fix**: Recommended Option A (event handler callback) over per-tenant iteration or explicit wildcard support — eliminates polling entirely
4. **Rollback via feature flags**: Phase 1 (Security) can be rolled back via `EVENTSTORE_EVAL_POLLING_ENABLED=false`; Phase 4 (Observability) via `OTEL_SDK_DISABLED=true`

## Implementation Status

| Subsystem           | Files  | Status     |
| ------------------- | ------ | ---------- |
| Interfaces          | 6      | COMPLETE   |
| Schema/Registry     | 17     | COMPLETE   |
| Emitter             | 2      | COMPLETE   |
| Queues              | 5      | COMPLETE   |
| Stores (ClickHouse) | 4      | COMPLETE   |
| Query Service       | 3      | COMPLETE   |
| Retention/GDPR      | 3      | COMPLETE   |
| Webhook Forwarder   | 1      | COMPLETE   |
| Resilience (WAL)    | 3      | COMPLETE   |
| Evaluation Pipeline | 5      | COMPLETE   |
| Alerting Engine     | 5      | COMPLETE   |
| Migration Bridge    | 1      | COMPLETE   |
| Runtime Integration | 3      | COMPLETE   |
| Analytics API       | 1      | COMPLETE   |
| **Total**           | **59** | **STABLE** |

## Hardening Phases

### Phase 1: Security Fixes (P0)

- Fix cross-tenant wildcard `tenantId: '*'` in EvaluationDispatcher (HIGH severity)
- Add `tenant_id` non-empty validation in EventEmitter before enqueue
- 4 files changed, 1 new test

### Phase 2: Code Quality (P1)

- Replace 58 `console.log/warn/error/debug` calls across 9 files with `createLogger`
- Add `MAX_EVALUATORS = 50` bound to EvaluationDispatcher evaluators Map
- 10 files changed

### Phase 3: Testing (P1)

- 5 E2E tests against real ClickHouse (write-read, tenant isolation, aggregation, GDPR cascade, wildcard behavior)
- 8 integration tests (emit pipeline, failover, cache, webhooks, evaluation, retention, GDPR anonymize, alerting)
- 14 new test files

### Phase 4: Observability (P2)

- 5 OTEL observable gauges (buffer.pending, queue.pending, wal.buffer_size, wal.file_size_bytes, cache.hit_rate)
- Health check endpoint extension for EventStore status
- 5 files changed

## Wiring Status

- 6 wiring points confirmed WIRED (singleton init, trace-emitter dual-write, analytics API routes, GDPR cascade hooks, WAL recovery, server startup)
- 4 wiring points NOT WIRED (OTEL metrics, health check, retention scheduler cron, evaluation dispatcher activation)

## Risk Assessment

| Risk                           | Severity | Phase | Mitigation                                     |
| ------------------------------ | -------- | ----- | ---------------------------------------------- |
| Cross-tenant wildcard polling  | HIGH     | 1     | Replace with event handler callback (Option A) |
| 58 console.log violations      | MEDIUM   | 2     | Batch replace with createLogger                |
| Unbounded evaluators Map       | LOW      | 2     | Add MAX_EVALUATORS = 50 constant               |
| No E2E against real ClickHouse | MEDIUM   | 3     | Docker-based ClickHouse test infrastructure    |
| No OTEL metrics                | LOW      | 4     | Wire observable gauges per INTEGRATION.md      |

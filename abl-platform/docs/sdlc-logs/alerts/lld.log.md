# SDLC Log: Alerts LLD

**Feature:** alerts
**Phase:** LLD (Low-Level Design + Implementation Plan)
**Date:** 2026-03-22
**Author:** SDLC Pipeline

## Summary

Generated a 4-phase implementation plan with exit criteria and wiring checklist. The plan prioritizes security hardening (SQL injection + mass-assignment fixes) before production readiness, test coverage, and observability.

## Phase Summary

| Phase | Title                | Priority | Duration | Key Deliverables                              |
| ----- | -------------------- | -------- | -------- | --------------------------------------------- |
| 1     | Security Hardening   | P0       | 1-2 days | Allowlist validation, PUT field filtering     |
| 2     | Production Readiness | P1       | 2-3 days | Redis stores, distributed lock, rule limits   |
| 3     | E2E Test Coverage    | P1       | 2-3 days | 7 E2E tests, 6 integration tests              |
| 4     | Observability        | P2       | 1-2 days | TraceEvents, audit logging, secret encryption |

## Files to Create or Modify

### New Files

| File                                                                     | Phase | Purpose                         |
| ------------------------------------------------------------------------ | ----- | ------------------------------- |
| `packages/pipeline-engine/src/pipeline/services/clickhouse-allowlist.ts` | 1     | ClickHouse identifier allowlist |
| `packages/eventstore/src/alerting/redis-stores.ts`                       | 2     | Redis cooldown + state stores   |
| `apps/runtime/src/__tests__/e2e/alerts-e2e.test.ts`                      | 3     | E2E test suite                  |
| `apps/runtime/src/__tests__/integration/alerts-integration.test.ts`      | 3     | Integration test suite          |

### Modified Files

| File                                                                        | Phase | Changes                             |
| --------------------------------------------------------------------------- | ----- | ----------------------------------- |
| `apps/runtime/src/routes/alerts.ts`                                         | 1,2   | Validation, field filtering, limits |
| `packages/pipeline-engine/src/pipeline/services/alert-evaluator.service.ts` | 1     | Defense-in-depth validation         |
| `packages/pipeline-engine/src/schemas/alert-rule.schema.ts`                 | 1     | Schema-level validation             |
| `packages/eventstore/src/alerting/alert-scheduler.ts`                       | 2     | Distributed lock                    |

## Critical Security Fixes

1. **SQL Injection (CRITICAL):** Two interpolation points in ClickHouse queries (`rule.metric`, `rule.sourceTable`) need allowlist validation at creation time and defense-in-depth at evaluation time
2. **Mass Assignment (HIGH):** PUT endpoint needs field allowlist to prevent overwriting system fields (tenantId, projectId, status, createdBy)

## Decision Log

| ID  | Classification | Decision                                                             |
| --- | -------------- | -------------------------------------------------------------------- |
| D-1 | DECIDED        | Phase 1 blocks BETA promotion                                        |
| D-2 | DECIDED        | Allowlist approach for SQL injection (not parameterized identifiers) |
| D-3 | DECIDED        | Redis for cooldown/state (not Restate)                               |
| D-4 | INFERRED       | ioredis-mock for Redis unit tests                                    |
| D-5 | DECIDED        | Phases 2 and 3 can proceed in parallel after Phase 1                 |

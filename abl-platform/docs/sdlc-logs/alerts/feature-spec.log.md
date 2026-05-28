# SDLC Log: Alerts Feature Spec

**Feature:** alerts
**Phase:** Feature Spec
**Date:** 2026-03-22
**Author:** SDLC Pipeline

## Summary

Generated a complete feature spec for the Alerts feature with all 18 template sections, grounded in actual codebase analysis.

## Source Files Analyzed

- `apps/runtime/src/routes/alerts.ts` -- Project-scoped alert rule CRUD + test-fire
- `apps/runtime/src/routes/alert-config.ts` -- Tenant-scoped alert config CRUD
- `apps/runtime/src/services/alert-delivery.ts` -- Webhook/email delivery with HMAC
- `packages/eventstore/src/alerting/interfaces.ts` -- Core type contracts
- `packages/eventstore/src/alerting/threshold-evaluator.ts` -- Pure threshold logic
- `packages/eventstore/src/alerting/alert-scheduler.ts` -- Periodic evaluation loop
- `packages/eventstore/src/alerting/alert-notifier.ts` -- Notification delivery
- `packages/eventstore/src/alerting/memory-stores.ts` -- Test implementations
- `packages/pipeline-engine/src/schemas/alert-rule.schema.ts` -- Mongoose model
- `packages/pipeline-engine/src/pipeline/services/alert-evaluator.service.ts` -- Restate service
- `apps/runtime/src/__tests__/alert-config-ssrf.test.ts` -- SSRF test
- `packages/eventstore/src/__tests__/alerting-scheduler.test.ts` -- Scheduler tests
- `packages/eventstore/src/__tests__/alerting-threshold.test.ts` -- Threshold tests
- `packages/pipeline-engine/src/__tests__/alert-evaluator.test.ts` -- Evaluator tests

## Key Findings

### CRITICAL: SQL Injection Vulnerability

Both `alerts.ts` (line 452) and `alert-evaluator.service.ts` (line 145) interpolate user-controlled `rule.metric` and `rule.sourceTable` values directly into ClickHouse SQL queries without parameterization or allowlist validation. This allows project-write users to execute arbitrary ClickHouse SQL.

### Architecture Duplication

Two parallel evaluation implementations exist:

1. **EventStore alerting engine** -- Clean interfaces (IAlertRuleStore, ICooldownStore, IMetricsReader), pure evaluation logic, scheduler with concurrency control
2. **Pipeline-engine evaluator** -- Restate-based service, direct Mongoose/ClickHouse access, duplicates threshold logic

These should be consolidated to prevent drift.

### Missing Coverage

- No E2E tests exist
- No integration tests with real MongoDB or ClickHouse
- No Studio UI
- Email delivery is placeholder only

## Decision Log

| ID  | Classification | Decision                                                 |
| --- | -------------- | -------------------------------------------------------- |
| D-1 | DECIDED        | SQL injection remediation is P0, blocks BETA status      |
| D-2 | DECIDED        | Feature status remains ALPHA until E2E tests exist       |
| D-3 | INFERRED       | Alert rule limit of 100 per project (no enforcement yet) |
| D-4 | AMBIGUOUS      | Consolidation of two evaluation engines deferred         |

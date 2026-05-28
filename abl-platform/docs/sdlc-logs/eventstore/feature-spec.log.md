# EventStore Feature Spec - SDLC Log

> **Phase**: Feature Spec (Phase 1)
> **Date**: 2026-03-22
> **Feature**: eventstore

## Clarifying Questions

### Q1: What storage backends are implemented vs. interface-only?

**Classification**: ANSWERED
**Evidence**: `src/stores/` contains `clickhouse/` (production), `memory/` (tests), `remote/` (HTTP client). Factory supports `'clickhouse' | 'memory'` as `EventStoreBackend`. Remote mode uses HTTP clients, not a direct store implementation.

### Q2: How are events emitted from runtime into EventStore?

**Classification**: ANSWERED
**Evidence**: `apps/runtime/src/services/trace-emitter.ts` (line 134-175) dual-writes every trace event to TraceStore AND EventStore via `getEventStore().emitter.emit()`. PII scrubbing and secret redaction applied before write. Singleton initialized in `eventstore-singleton.ts`.

### Q3: What is the cross-tenant wildcard issue in EvaluationDispatcher?

**Classification**: ANSWERED
**Evidence**: `src/evaluation/evaluation-dispatcher.ts` line 193 uses `tenantId: '*'` in `pollAndProcess()`. ClickHouse WHERE clause uses `tenant_id = {tenantId:String}` which matches literal '\*' (not wildcard). However, MemoryEventStore may behave differently. Comment says "system privileges" but no authorization check.

### Q4: How many event types are registered and in which categories?

**Classification**: ANSWERED
**Evidence**: 15 event schema files in `src/schema/events/` register 40+ event types across 15 categories. PII-containing events: `evaluation.summary.generated`, `feedback.submitted`.

### Q5: What queue backends exist and which are production-ready?

**Classification**: ANSWERED
**Evidence**: `src/queues/` contains DirectQueue, BullMQEventQueue, KafkaEventQueue, MemoryEventQueue. Factory in `queue-factory.ts` creates based on `EventQueueConfig.type`.

### Q6: How does the resilient emitter failover work?

**Classification**: ANSWERED
**Evidence**: `src/emitter/resilient-event-emitter.ts` implements 3-level cascade. Health check every 5s via `isHealthy()`. Level 1: primary queue, Level 2: fallback DirectQueue -> store, Level 3: FileSystemWAL.

### Q7: What ClickHouse DDL structures exist?

**Classification**: ANSWERED
**Evidence**: `src/stores/clickhouse/platform-events-table.ts` defines main table (ReplicatedMergeTree), 3 materialized views (session_metrics_daily, llm_cost_hourly, platform_events_by_session). TTL tiers: 30d warm, 90d cold, 730d DELETE.

### Q8: How does GDPR compliance work?

**Classification**: ANSWERED
**Evidence**: `src/retention/event-gdpr-service.ts` delegates to `IEventLifecycle` for `deleteBySessionIds`, `anonymizeActor`, `deleteTenant`. ClickHouse implements via ALTER TABLE DELETE/UPDATE. Integrated via `registerEventCascadeHook` in singleton.

### Q9: What is the alerting engine architecture?

**Classification**: ANSWERED
**Evidence**: `src/alerting/` contains `interfaces.ts` (AlertRule, IAlertRuleStore, ICooldownStore, IMetricsReader), `threshold-evaluator.ts` (pure comparison functions), `alert-scheduler.ts` (periodic evaluation + notification), `alert-notifier.ts` (webhook delivery).

### Q10: Does EventStore use console.log instead of createLogger?

**Classification**: ANSWERED
**Evidence**: 58 occurrences of console.log/warn/error/debug across 9 files. Violates CLAUDE.md rule. Only exception: `eventstore-singleton.ts` in runtime correctly uses `createLogger('eventstore-singleton')`.

### Q11: What Analytics API endpoints exist?

**Classification**: ANSWERED
**Evidence**: `apps/runtime/src/routes/analytics.ts` defines 8 endpoints under `/api/projects/:projectId/analytics`: GET metrics, events, agents/:name, cost-breakdown, session-metrics, event-counts; POST query, aggregate, sql-query. All use auth + RBAC + rate limiting.

### Q12: How is the evaluation pipeline configured per project?

**Classification**: ANSWERED
**Evidence**: `src/evaluation/interfaces.ts` defines `ProjectEvaluationConfig` with evaluator list, global sampling, daily budget cap. `IEvaluationConfigProvider` is injected by runtime (MongoDB-backed). Sampling supports random, all, stratified, anomaly_triggered.

## Decisions Made

1. Feature status set to STABLE based on comprehensive implementation across all subsystems
2. Cross-tenant wildcard documented as HIGH-severity known issue
3. console.log usage documented as code quality issue (not security)
4. All 15 categories and 40+ event types documented from code evidence

## Files Read

- `packages/eventstore/src/index.ts`
- `packages/eventstore/src/factory.ts`
- `packages/eventstore/src/interfaces/*.ts` (6 files)
- `packages/eventstore/src/schema/platform-event.ts`
- `packages/eventstore/src/schema/event-registry.ts`
- `packages/eventstore/src/schema/event-categories.ts`
- `packages/eventstore/src/schema/events/*.ts` (15 files, 5 read in detail)
- `packages/eventstore/src/stores/clickhouse/clickhouse-event-store.ts`
- `packages/eventstore/src/stores/clickhouse/clickhouse-row-mapper.ts`
- `packages/eventstore/src/stores/clickhouse/platform-events-table.ts`
- `packages/eventstore/src/emitter/event-emitter.ts`
- `packages/eventstore/src/emitter/resilient-event-emitter.ts`
- `packages/eventstore/src/query/event-query-service.ts`
- `packages/eventstore/src/retention/event-retention-service.ts`
- `packages/eventstore/src/retention/event-gdpr-service.ts`
- `packages/eventstore/src/webhook/event-webhook-forwarder.ts`
- `packages/eventstore/src/evaluation/evaluation-dispatcher.ts`
- `packages/eventstore/src/evaluation/interfaces.ts`
- `packages/eventstore/src/evaluation/evaluators/code-scorer.ts`
- `packages/eventstore/src/evaluation/evaluators/llm-judge-evaluator.ts`
- `packages/eventstore/src/alerting/interfaces.ts`
- `packages/eventstore/src/alerting/threshold-evaluator.ts`
- `packages/eventstore/src/alerting/alert-scheduler.ts`
- `packages/eventstore/src/alerting/alert-notifier.ts`
- `packages/eventstore/src/resilience/filesystem-wal.ts`
- `packages/eventstore/src/resilience/event-recovery-service.ts`
- `packages/eventstore/src/queues/queue-factory.ts`
- `packages/eventstore/src/migration/llm-metrics-bridge.ts`
- `packages/eventstore/README.md`
- `packages/eventstore/INTEGRATION.md`
- `apps/runtime/src/services/eventstore-singleton.ts`
- `apps/runtime/src/services/trace-emitter.ts`
- `apps/runtime/src/routes/analytics.ts`

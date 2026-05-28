# Observatory — Phase 3: HLD Log

**Date:** 2026-03-23
**Phase:** High-Level Design
**Status:** COMPLETE

## Clarifying Questions & Decisions

| #   | Question                                               | Classification | Resolution                                                                                                                                            |
| --- | ------------------------------------------------------ | -------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------- |
| 1   | Where should analytics routes live?                    | DECIDED        | `apps/runtime/src/routes/analytics.ts` — same auth chain as sessions, same service                                                                    |
| 2   | Should we use prom-client or OTEL Prometheus exporter? | DECIDED        | prom-client — simpler, direct control, OTEL already exports to Collector via gRPC for different consumers                                             |
| 3   | Do we need new ClickHouse tables?                      | ANSWERED       | NO — all required tables and materialized views already exist (`platform_events`, `llm_metrics`, `llm_metrics_hourly_dest`, `llm_metrics_daily_dest`) |
| 4   | Should Prometheus metrics be on separate port?         | DECIDED        | Same port, `/metrics` path — standard for Express apps                                                                                                |
| 5   | How to handle ContentBlock[] in trace display?         | INFERRED       | Defensive type check at render time; no schema change needed. `typeof content === 'string' ? content : renderBlocks(content)`                         |

## Audit Findings

### Round 1 (Self-Audit)

- CRITICAL: None
- HIGH: Must verify that `llm_metrics_hourly_dest` and `llm_metrics_daily_dest` materialized views have `tenant_id` and `project_id` in ORDER BY
- MEDIUM: HLD should note that prom-client and OTEL metrics are separate systems — no double-counting concern

### Resolution

- Verified from `01-init.sql` line 124: `ORDER BY (tenant_id, project_id, model_id, provider, agent_name, hour)` — tenant and project isolation confirmed
- Section 5.6 and 6.3 explicitly address the prom-client vs OTEL separation
- Verified `llm_metrics_daily_dest` also has tenant_id, project_id in ORDER BY (line 171)

## Architectural Concerns Coverage

All 12 concerns addressed in Section 5:

1. Tenant Isolation — tenant_id + project_id in all queries
2. Auth — existing middleware chain reused
3. Performance — materialized views, partition pruning, streaming CSV
4. Scalability — stateless runtime, pre-aggregated MVs
5. Reliability — three-tier storage, fallback chain
6. Observability — self-monitoring via Prometheus + CH observability
7. Security — PII scrubbing, encryption, bounded metrics labels
8. Data Integrity — idempotent writes, ordered events, schema validation
9. Backward Compatibility — all changes additive
10. Deployment — no migrations, no feature flags needed
11. Error Handling — standard envelope, timeouts, streaming errors
12. Testing — 20 E2E + 10 integration + 8 unit

## Artifacts

- `docs/specs/observatory.hld.md` — High-level design document

## Codebase Verification

- `scripts/clickhouse-init/01-init.sql` lines 102-144: llm_metrics_hourly materialized view with tenant_id, project_id in GROUP BY
- `scripts/clickhouse-init/01-init.sql` lines 276-331: platform_events table with span_id, parent_span_id, tenant_id
- `apps/runtime/src/observability/metrics.ts`: Existing OTEL metrics instruments (8 total)
- `apps/runtime/src/observability/otel-setup.ts`: OTEL SDK configuration
- `apps/runtime/src/routes/sessions.ts` lines 1-68: Auth middleware chain

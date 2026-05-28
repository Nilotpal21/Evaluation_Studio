# ABLP-999 H-Fix Audit (Round 2) — 2026-05-11

## Verdict

FAIL — 0 Critical / 1 High / 5 Medium / 1 Low open.

The four round-1 HIGH findings are fixed in the feature branch. Merge is still blocked by a W1.2 composition issue: the cost-rollup `eval_conversations` migration exists and the merged writer/query code depends on `customer_visible_cost` and `cost_by_model`, but that migration is not registered in `packages/database/src/change-management/manifest.ts`.

Audit refs: feature `origin/feat/ablp-eval-retention` at `da272ddad1`; user-pinned base `085fcf0066`. Fetch advanced live `origin/develop` to `c7d1a9085e`, so the merge-tree result below is against that live ref.

## H findings — fix verification

### H1 — migration database parameterization

Status: FIXED

Evidence:

- The numbered SQL file still shows `abl_platform`, but it explicitly documents itself as manual/documentation-only and directs production deployments to the TypeScript runner: `packages/database/clickhouse/migrations/2026-05-11-eval-retention-ttl-columns.sql:9-12`. The hardcoded statements remain at `packages/database/clickhouse/migrations/2026-05-11-eval-retention-ttl-columns.sql:14-26`, but are no longer the canonical production runner.
- The canonical TypeScript migration resolves the database before building `ALTER TABLE` statements: `packages/database/src/clickhouse-schemas/migrations/eval-retention-ttl-columns.ts:12-16`, `packages/database/src/clickhouse-schemas/migrations/eval-retention-ttl-columns.ts:19-33`.
- Database resolution uses the passed option, then `CLICKHOUSE_DATABASE`, then the default, and validates the identifier: `packages/database/src/clickhouse-schemas/database.ts:5-13`.
- The migration is registered in the change-management manifest and expected surface inventory: `packages/database/src/change-management/manifest.ts:687-704`, `packages/database/src/change-management/manifest.ts:970-973`.
- `initEvalTables()` resolves the configured database and rewrites both create and alter DDL before execution: `packages/pipeline-engine/src/pipeline/schemas/init-eval-tables.ts:39-40`, `packages/pipeline-engine/src/pipeline/schemas/init-eval-tables.ts:340-354`.

Notes: no H1 recurrence found.

### H2 — eval knownSource propagation

Status: FIXED

Evidence:

- `buildEvalRuntimeAgentChatBody()` accepts `knownSource`, maps `synthetic` to `'synthetic'`, and maps every other eval value to `'eval'`: `packages/pipeline-engine/src/pipeline/services/eval/eval-runtime-request.ts:9`, `packages/pipeline-engine/src/pipeline/services/eval/eval-runtime-request.ts:18`.
- The runtime request body carries top-level `knownSource`: `packages/pipeline-engine/src/pipeline/services/eval/eval-runtime-request.ts:28-34`.
- `ExecuteAgentTurn` threads `knownSource` into `buildEvalRuntimeAgentChatBody()` and the runtime call: `packages/pipeline-engine/src/pipeline/services/eval/execute-agent-turn.service.ts:71-79`, `packages/pipeline-engine/src/pipeline/services/eval/execute-agent-turn.service.ts:231-242`.
- `RunEvalConversation` defaults `knownSource` to `'eval'`, passes it into each runtime turn, and writes it to the ClickHouse eval row: `packages/pipeline-engine/src/pipeline/services/eval/run-eval-conversation.service.ts:197`, `packages/pipeline-engine/src/pipeline/services/eval/run-eval-conversation.service.ts:99-106`, `packages/pipeline-engine/src/pipeline/services/eval/run-eval-conversation.service.ts:290-300`, `packages/pipeline-engine/src/pipeline/services/eval/run-eval-conversation.service.ts:399`.
- The internal runtime route accepts `knownSource` in schema, extracts it, and passes it into created runtime sessions: `apps/runtime/src/routes/internal-chat.ts:70-72`, `apps/runtime/src/routes/internal-chat.ts:106-114`, `apps/runtime/src/routes/internal-chat.ts:276-283`.
- Runtime session types and creation preserve the field: `apps/runtime/src/services/execution/types.ts:313-315`, `apps/runtime/src/services/runtime-executor.ts:1505-1506`, `apps/runtime/src/services/runtime-executor.ts:1644`.
- Mongo session persistence includes `knownSource` when a DB session is created: `apps/runtime/src/services/stores/mongo-conversation-store.ts:196`.

Notes: no double-write or shape mismatch found. Eval sends a top-level `knownSource`; runtime stores the same top-level session field that W1.4 added.

### H3 — tenant retention PATCH owner-only

Status: FIXED

Evidence:

- GET remains lower-tier read access through workspace READ permission: `apps/studio/src/app/api/tenant/retention/route.ts:50-67`.
- PATCH now requires `requireWorkspaceRole(user.tenantId, user, 'OWNER', ...)`: `apps/studio/src/app/api/tenant/retention/route.ts:80-90`.
- OWNER PATCH success and read-back are covered: `apps/studio/src/__tests__/eval-retention-api.e2e.test.ts:255-299`.
- ADMIN PATCH denial is covered with 403 while GET still succeeds: `apps/studio/src/__tests__/eval-retention-api.e2e.test.ts:301-329`.
- All tenant roles listed in the test have GET access: `apps/studio/src/__tests__/eval-retention-api.e2e.test.ts:331-350`.

Notes: the functional H3 fix is present. See NEW-M1 for a test-quality issue in the same E2E file.

### H4 — cleanup TraceEvents

Status: FIXED

Evidence:

- Cleanup defines durable event types for `eval.retention.cleanup_started`, `eval.retention.run_archived`, `eval.retention.run_hard_deleted`, `eval.retention.cleanup_error`, and `eval.retention.cleanup_complete`: `packages/pipeline-engine/src/pipeline/services/eval/eval-retention-cleanup.ts:16-21`.
- `EvalRetentionTraceSink` is explicit and the ClickHouse implementation writes to `${database}.platform_events`: `packages/pipeline-engine/src/pipeline/services/eval/eval-retention-cleanup.ts:30-32`, `packages/pipeline-engine/src/pipeline/services/eval/eval-retention-cleanup.ts:74-89`.
- The emitted platform event rows include `event_type`, `category: 'eval'`, `known_source: 'eval'`, `agent_name: 'eval-retention-cleanup'`, duration/error fields, and serialized event data: `packages/pipeline-engine/src/pipeline/services/eval/eval-retention-cleanup.ts:90-118`.
- Cleanup emits start, per-run hard-delete, per-run archive, per-run error, per-tenant error, and completion events: `packages/pipeline-engine/src/pipeline/services/eval/eval-retention-cleanup.ts:208-222`, `packages/pipeline-engine/src/pipeline/services/eval/eval-retention-cleanup.ts:232-240`, `packages/pipeline-engine/src/pipeline/services/eval/eval-retention-cleanup.ts:264-274`, `packages/pipeline-engine/src/pipeline/services/eval/eval-retention-cleanup.ts:281-290`, `packages/pipeline-engine/src/pipeline/services/eval/eval-retention-cleanup.ts:298-306`, `packages/pipeline-engine/src/pipeline/services/eval/eval-retention-cleanup.ts:308-319`.
- Production wiring installs the ClickHouse trace sink during pipeline-engine startup: `packages/pipeline-engine/src/pipeline/server.ts:468-475`.
- Cleanup remains in pipeline-engine/restate, not runtime: `packages/pipeline-engine/src/pipeline/handlers/eval-retention-scheduler.ts:23-42`, `packages/pipeline-engine/src/pipeline/server.ts:553-565`.

Notes: no H4 recurrence found.

## MEDIUM findings (round 1)

- M1 — `resolveOptionalTtl()` truncates non-integer tenant settings: STILL-OPEN. The resolver still returns `Math.trunc(value)` before bounds validation, so a direct persisted decimal can become an integer before `assertEvalRetentionTtlBounds()`: `packages/database/src/eval-retention.ts:58-63`, `packages/database/src/eval-retention.ts:103-112`.
- M2 — no E2E confirming tenant override propagates into actual ClickHouse row: STILL-OPEN. The Studio E2E verifies API persistence only, and the pipeline-engine DDL test verifies schema text only: `apps/studio/src/__tests__/eval-retention-api.e2e.test.ts:255-299`, `packages/pipeline-engine/src/__tests__/init-eval-tables-retention.test.ts:21-29`.
- M3 — `productionScoresTtlDays` accepted but no write path applies it: STILL-OPEN. The API/schema accepts and resolves it, and DDL defines `eval_production_scores.ttl_override_days`, but the only production-score usage found is a read join; no insert/write path applies the resolved tenant TTL: `apps/studio/src/app/api/tenant/retention/route.ts:34`, `packages/database/src/eval-retention.ts:90-110`, `packages/pipeline-engine/src/pipeline/schemas/init-eval-tables.ts:183`, `packages/pipeline-engine/src/pipeline/services/experiment-results.service.ts:116-126`.
- M4 — archived 410 response only on heatmap route: STILL-OPEN. Heatmap returns structured 410 for archived runs, but run detail returns the run normally and compare fetches run metadata then queries ClickHouse without archived handling: `apps/studio/src/app/api/projects/[id]/evals/runs/[runId]/heatmap/route.ts:37-50`, `apps/studio/src/app/api/projects/[id]/evals/runs/[runId]/route.ts:30-35`, `apps/studio/src/app/api/projects/[id]/evals/runs/compare/route.ts:63-69`, `apps/studio/src/app/api/projects/[id]/evals/runs/compare/route.ts:85-109`.
- M5 / LOW — hard delete does not explicitly clear trace payloads outside Mongo: STILL-OPEN. Hard delete removes only the Mongo `EvalRun` document by `{ _id, tenantId }`; ClickHouse conversation/score payloads rely on TTL rather than explicit deletion: `packages/pipeline-engine/src/pipeline/services/eval/eval-retention-cleanup.ts:227-240`.

## NEW findings (introduced since round 1)

### HIGH — W1.2 cost-column migration is not registered in the manifest

The merged code now depends on `customer_visible_cost` and `cost_by_model` in `eval_conversations`, but the SQL migration that adds those columns is not registered in `packages/database/src/change-management/manifest.ts`.

Evidence:

- The W1.2 SQL migration exists and adds both columns: `packages/database/clickhouse/migrations/2026-05-11-add-cost-breakdown-to-eval-conversations.sql:10-14`.
- The full init DDL contains both W1.2 cost columns and ABLP-999 retention columns: `packages/pipeline-engine/src/pipeline/schemas/init-eval-tables.ts:69-70`, `packages/pipeline-engine/src/pipeline/schemas/init-eval-tables.ts:78-79`.
- Runtime eval conversation writes now include all four fields: `packages/pipeline-engine/src/pipeline/services/eval/run-eval-conversation.service.ts:380-405`.
- Aggregation now queries `customer_visible_cost` and `cost_by_model`: `packages/pipeline-engine/src/pipeline/services/eval/aggregate-eval-run.service.ts:194-213`, `packages/pipeline-engine/src/pipeline/services/eval/aggregate-eval-run.service.ts:231-260`.
- The manifest registers ABLP-999 `clickhouse.eval-retention-ttl-columns`, but `git show origin/feat/ablp-eval-retention:packages/database/src/change-management/manifest.ts | grep -n "customer_visible_cost\\|cost_by_model\\|add-cost-breakdown"` returned no matches: `packages/database/src/change-management/manifest.ts:687-704`, `packages/database/src/change-management/manifest.ts:970-973`.

Impact: existing ClickHouse deployments that already have `eval_conversations` will not be guaranteed to receive the W1.2 cost columns before writers insert rows containing those fields and aggregators query them. This is merge-blocking unless the W1.2 migration is registered and executable through the repo change-management path.

### MEDIUM — new Studio E2E mutates DB directly for role setup

The new retention API E2E changes roles by importing the database model and calling `TenantMember.updateOne()` directly: `apps/studio/src/__tests__/eval-retention-api.e2e.test.ts:236-239`.

Impact: this violates the repo E2E rule that workflow/API E2E tests seed and mutate state via public API rather than direct Mongoose access. It weakens the H3 authorization regression by bypassing the API path for role changes.

## Composition with merged W1.x on develop

- W1.2 + ABLP-999 eval_conversations DDL: PARTIAL / BLOCKED. The init DDL builds the full superset (`customer_visible_cost`, `cost_by_model`, `known_source`, `ttl_override_days`) and the row writer populates all four fields: `packages/pipeline-engine/src/pipeline/schemas/init-eval-tables.ts:69-79`, `packages/pipeline-engine/src/pipeline/services/eval/run-eval-conversation.service.ts:380-405`. `rollupAgentTokenCost()` still feeds `customerVisibleCost` and `costByModel`: `packages/shared-kernel/src/llm-trace-classifier.ts:205-245`. Blocking gap: W1.2's cost-column migration is not listed in the manifest.
- W1.4 + H2 propagation: PASS. Eval sends top-level `knownSource`; internal chat accepts it; runtime session creation stores it; platform events use session `knownSource`: `packages/pipeline-engine/src/pipeline/services/eval/eval-runtime-request.ts:18-34`, `apps/runtime/src/routes/internal-chat.ts:70-72`, `apps/runtime/src/routes/internal-chat.ts:276-283`, `apps/runtime/src/services/runtime-executor.ts:2921-2924`.
- W1.3 system/arch + ABLP-999: PASS. The build-repair commit leaves the Next route with only Next-compatible exports and moves testable helper/types to `handler.ts`: `apps/studio/src/app/api/internal/arch-ai/invoke/route.ts:1-6`, `apps/studio/src/app/api/internal/arch-ai/invoke/handler.ts:77-80`, `apps/studio/src/app/api/internal/arch-ai/invoke/handler.ts:260-285`.
- Trace event consistency (known_source on platform_events): PASS. `platform_events` and `platform_events_by_session` define `known_source`, the session MV carries it, runtime emits session-known source, and retention cleanup emits distinct `eval.retention.*` event types with `known_source: 'eval'`: `packages/database/src/clickhouse-schemas/init.ts:879`, `packages/database/src/clickhouse-schemas/init.ts:1289`, `packages/database/src/clickhouse-schemas/init.ts:1488-1493`, `apps/runtime/src/services/runtime-executor.ts:1851-1856`, `packages/pipeline-engine/src/pipeline/services/eval/eval-retention-cleanup.ts:94-104`.

## CLAUDE.md invariants

- Stateless Agent Runtime (#4): PASS. Scheduler state is Restate-owned in pipeline-engine, with a durable object and sweep service, and startup invokes Restate ingress from pipeline-engine: `packages/pipeline-engine/src/pipeline/handlers/eval-retention-scheduler.ts:23-42`, `packages/pipeline-engine/src/pipeline/server.ts:553-565`.
- Resource Isolation (#1): PASS for audited production paths. Project routes use `requireProjectAccess()` and tenant/project-scoped queries: `apps/studio/src/app/api/projects/[id]/evals/runs/[runId]/heatmap/route.ts:23-35`, `apps/studio/src/app/api/projects/[id]/evals/runs/compare/route.ts:63-67`. Cleanup scans tenants as a system job, then filters and mutates eval runs by tenant id: `packages/pipeline-engine/src/pipeline/services/eval/eval-retention-cleanup.ts:166-168`, `packages/pipeline-engine/src/pipeline/services/eval/eval-retention-cleanup.ts:193-200`, `packages/pipeline-engine/src/pipeline/services/eval/eval-retention-cleanup.ts:227-228`, `packages/pipeline-engine/src/pipeline/services/eval/eval-retention-cleanup.ts:245-247`.
- Centralized Auth (#2): PASS for audited route changes. Tenant retention uses `requireTenantAuth()` plus workspace permission/role helpers; project eval routes use `requireTenantAuth()` plus `requireProjectAccess()`: `apps/studio/src/app/api/tenant/retention/route.ts:50-65`, `apps/studio/src/app/api/tenant/retention/route.ts:80-90`, `apps/studio/src/app/api/projects/[id]/evals/runs/[runId]/route.ts:22-31`.
- Traceability (#5): PASS for H4. Cleanup emits durable `eval.retention.*` platform events through a configured ClickHouse trace sink: `packages/pipeline-engine/src/pipeline/services/eval/eval-retention-cleanup.ts:16-21`, `packages/pipeline-engine/src/pipeline/services/eval/eval-retention-cleanup.ts:87-112`, `packages/pipeline-engine/src/pipeline/server.ts:471-475`.
- Tests: PARTIAL. No new E2E `vi.mock()` of `@agent-platform/*` or `@abl/*` was introduced in the retention E2E file, and it starts a real local HTTP server on a random port: `apps/studio/src/__tests__/eval-retention-api.e2e.test.ts:147-176`. However, it directly imports `TenantMember` and mutates Mongo for role setup, violating the E2E API-only rule: `apps/studio/src/__tests__/eval-retention-api.e2e.test.ts:236-239`.

## Build / merge feasibility

- `git merge-tree origin/develop origin/feat/ablp-eval-retention`: clean; command returned tree `11c38a3f8dbb39ac3877eed405691c5c2c4a6916` with exit code 0 and no conflict hunks.
- No build runs in audit mode; rely on commit-time evidence.

## Recommendation

- Merge: NO.
- Prerequisites before merge:
  - Register and wire the W1.2 cost-breakdown ClickHouse migration in `packages/database/src/change-management/manifest.ts` using the repo's executable migration path. Prefer a parameterized TypeScript runner, matching the ABLP-999 H1 fix, so non-default ClickHouse databases are safe.
  - Replace the direct `TenantMember.updateOne()` role mutation in the Studio retention E2E with an API-mediated setup path, or move that part out of E2E classification.
- Remaining open work:
  - M1 STILL-OPEN: decimal TTL values are truncated before validation.
  - M2 STILL-OPEN: no E2E proves tenant TTL override reaches actual ClickHouse rows.
  - M3 STILL-OPEN: `productionScoresTtlDays` has no production-score write path.
  - M4 STILL-OPEN: archived run 410 behavior is heatmap-only.
  - M5/LOW STILL-OPEN: hard delete does not explicitly clear non-Mongo trace payloads before ClickHouse TTL.

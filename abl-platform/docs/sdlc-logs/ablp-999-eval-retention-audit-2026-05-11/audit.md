# ABLP-999 Eval Retention Audit — 2026-05-11

## Verdict

FAIL — 0 Critical / 4 High / 5 Medium / 1 Low.

The branch implements much of the retention contract, but it is not merge-ready. The largest gaps are: the standalone ClickHouse migration hardcodes `abl_platform`, synthetic source is not propagated through the Runtime request boundary required for W1.4 composition, the tenant retention PATCH endpoint permits ADMIN/settings permission rather than owner-only control, and the cleanup path logs but does not emit durable TraceStore observability.

## Fix-by-fix verification

### Fix 1 — Tenant-configurable TTL

Status: PARTIAL

Evidence:

- Defaults are preserved at 730/365 and the synthetic default is named: `packages/database/src/constants/eval-limits.ts:52`, `packages/database/src/constants/eval-limits.ts:53`, `packages/database/src/constants/eval-limits.ts:56`.
- Effective retention defaults and tenant override resolution exist: `packages/database/src/eval-retention.ts:39`, `packages/database/src/eval-retention.ts:77`.
- Bounds checks exist for resolved TTL fields: `packages/database/src/eval-retention.ts:65`, `packages/database/src/eval-retention.ts:103`.
- ClickHouse init DDL adds `known_source`, `ttl_override_days UInt16`, and column-driven TTL in generated table setup: `packages/pipeline-engine/src/pipeline/schemas/init-eval-tables.ts:66`, `packages/pipeline-engine/src/pipeline/schemas/init-eval-tables.ts:67`, `packages/pipeline-engine/src/pipeline/schemas/init-eval-tables.ts:87`.
- Studio tenant retention API validates min/max via Zod and returns defaults/effective values: `apps/studio/src/app/api/tenant/retention/route.ts:24`, `apps/studio/src/app/api/tenant/retention/route.ts:64`, `apps/studio/src/app/api/tenant/retention/route.ts:134`.

Issues found:

- HIGH: The standalone migration hardcodes `abl_platform` instead of using `${DATABASE}` substitution: `packages/database/clickhouse/migrations/2026-05-11-eval-retention-ttl-columns.sql:9`, `packages/database/clickhouse/migrations/2026-05-11-eval-retention-ttl-columns.sql:14`, `packages/database/clickhouse/migrations/2026-05-11-eval-retention-ttl-columns.sql:19`.
- MEDIUM: `resolveOptionalTtl()` truncates non-integer tenant settings before validation, so direct Mongo settings like `7.9` become `7` instead of failing integer validation: `packages/database/src/eval-retention.ts:58`, `packages/database/src/eval-retention.ts:62`, `packages/database/src/eval-retention.ts:103`.
- MEDIUM: `productionScoresTtlDays` is accepted and resolved, but no production-score insert path writes `ttl_override_days`; the branch only defines DDL and reads `eval_production_scores`: `packages/database/src/eval-retention.ts:90`, `packages/pipeline-engine/src/pipeline/schemas/init-eval-tables.ts:171`, `packages/pipeline-engine/src/pipeline/services/experiment-results.service.ts:122`.
- MEDIUM: Tests assert DDL and API persistence, but no E2E confirms a tenant override propagates into an actual ClickHouse row. Current coverage is API-only at `apps/studio/src/__tests__/eval-retention-api.e2e.test.ts:239` and DDL-only at `packages/pipeline-engine/src/__tests__/init-eval-tables-retention.test.ts:22`.

### Fix 2 — Synthetic short TTL

Status: PARTIAL

Evidence:

- 30-day default is a named constant: `packages/database/src/constants/eval-limits.ts:56`.
- Default startup assertion is invoked during pipeline-engine startup: `packages/pipeline-engine/src/pipeline/server.ts:32`, `packages/pipeline-engine/src/pipeline/server.ts:400`.
- Eval run creation accepts `source.knownSource` and persists normalized `knownSource`: `apps/studio/src/app/api/projects/[id]/evals/runs/route.ts:30`, `apps/studio/src/app/api/projects/[id]/evals/runs/route.ts:106`.
- The eval workflow reads run `knownSource`, resolves tenant TTL, and passes it to conversation/judge services: `packages/pipeline-engine/src/pipeline/handlers/eval-run.workflow.ts:134`, `packages/pipeline-engine/src/pipeline/handlers/eval-run.workflow.ts:155`, `packages/pipeline-engine/src/pipeline/handlers/eval-run.workflow.ts:324`, `packages/pipeline-engine/src/pipeline/handlers/eval-run.workflow.ts:437`.
- ClickHouse conversation and score rows include `known_source` and `ttl_override_days`: `packages/pipeline-engine/src/pipeline/services/eval/run-eval-conversation.service.ts:389`, `packages/pipeline-engine/src/pipeline/services/eval/run-eval-conversation.service.ts:390`, `packages/pipeline-engine/src/pipeline/services/eval/judge-conversation.service.ts:568`, `packages/pipeline-engine/src/pipeline/services/eval/judge-conversation.service.ts:569`.

Issues found:

- HIGH: `knownSource` is not propagated through `eval-runtime-request`; `EvalRuntimeAgentChatBodyParams` has no source field, and the body only carries `callerContext.source = 'pipeline-engine'`. This means W1.4 `Session.source.knownSource` cannot be set by this path: `packages/pipeline-engine/src/pipeline/services/eval/eval-runtime-request.ts:1`, `packages/pipeline-engine/src/pipeline/services/eval/eval-runtime-request.ts:24`, `packages/pipeline-engine/src/pipeline/services/eval/eval-runtime-request.ts:39`, `packages/pipeline-engine/src/pipeline/services/eval/run-eval-conversation.service.ts:97`.

### Fix 3 — Symmetric Mongo cleanup

Status: PARTIAL

Evidence:

- Cleanup scheduler is Restate-backed, using a virtual object with durable `ctx.sleep`, not an in-process runtime timer: `packages/pipeline-engine/src/pipeline/handlers/eval-retention-scheduler.ts:23`, `packages/pipeline-engine/src/pipeline/handlers/eval-retention-scheduler.ts:30`, `packages/pipeline-engine/src/pipeline/handlers/eval-retention-scheduler.ts:37`.
- Scheduler and sweep service are bound in the pipeline-engine Restate endpoint and started through Restate ingress: `packages/pipeline-engine/src/pipeline/server.ts:368`, `packages/pipeline-engine/src/pipeline/server.ts:544`, `packages/pipeline-engine/src/pipeline/server.ts:555`.
- No ABLP-999 eval retention scheduler was added under `apps/runtime`; the only new scheduler binding is under `packages/pipeline-engine`.
- Archive marks `archived`, `archivedAt`, and `archivedReason: 'retention_expired'`, and strips selected detail fields while preserving `summary`: `packages/pipeline-engine/src/pipeline/services/eval/eval-retention-cleanup.ts:73`, `packages/pipeline-engine/src/pipeline/services/eval/eval-retention-cleanup.ts:79`.
- Hard delete removes expired `EvalRun` docs when configured: `packages/pipeline-engine/src/pipeline/services/eval/eval-retention-cleanup.ts:67`, `packages/pipeline-engine/src/pipeline/services/eval/eval-retention-cleanup.ts:68`.
- Heatmap drill-down returns structured 410 for archived runs: `apps/studio/src/app/api/projects/[id]/evals/runs/[runId]/heatmap/route.ts:37`, `apps/studio/src/app/api/projects/[id]/evals/runs/[runId]/heatmap/route.ts:49`.

Issues found:

- HIGH: Cleanup observability is log-only, not durable TraceStore/TraceEvent observability. Scheduler logs a summary and cleanup logs per-tenant failures, with no TraceStore import or emit path: `packages/pipeline-engine/src/pipeline/handlers/eval-retention-scheduler.ts:42`, `packages/pipeline-engine/src/pipeline/handlers/eval-retention-scheduler.ts:43`, `packages/pipeline-engine/src/pipeline/services/eval/eval-retention-cleanup.ts:86`, `packages/pipeline-engine/src/pipeline/services/eval/eval-retention-cleanup.ts:89`.
- MEDIUM: Other run drill-down/analytics endpoints do not return 410 for archived runs. Compare loads archived run metadata and still queries ClickHouse; run detail returns the archived run as normal metadata: `apps/studio/src/app/api/projects/[id]/evals/runs/compare/route.ts:63`, `apps/studio/src/app/api/projects/[id]/evals/runs/compare/route.ts:85`, `apps/studio/src/app/api/projects/[id]/evals/runs/[runId]/route.ts:31`, `apps/studio/src/app/api/projects/[id]/evals/runs/[runId]/route.ts:35`.
- LOW: The hard-delete path deletes only Mongo `EvalRun` docs; it does not explicitly clear related trace payloads if they exist outside ClickHouse TTL timing: `packages/pipeline-engine/src/pipeline/services/eval/eval-retention-cleanup.ts:67`.

### Fix 4 — Docs + settings

Status: PARTIAL

Evidence:

- `GET /api/tenant/retention` returns defaults and effective resolved values: `apps/studio/src/app/api/tenant/retention/route.ts:46`, `apps/studio/src/app/api/tenant/retention/route.ts:64`.
- `PATCH /api/tenant/retention` validates the strict schema and persists under the current tenant id: `apps/studio/src/app/api/tenant/retention/route.ts:76`, `apps/studio/src/app/api/tenant/retention/route.ts:100`, `apps/studio/src/app/api/tenant/retention/route.ts:128`.
- Studio Data Retention page calls the API and exposes TTLs, hard delete, and PII scrubbing: `apps/studio/src/components/settings/DataRetentionSettingsPage.tsx:95`, `apps/studio/src/components/settings/DataRetentionSettingsPage.tsx:152`, `apps/studio/src/components/settings/DataRetentionSettingsPage.tsx:247`, `apps/studio/src/components/settings/DataRetentionSettingsPage.tsx:277`.
- Navigation is wired in both sidebar config and content renderer: `apps/studio/src/components/navigation/ProjectSidebar.tsx:193`, `apps/studio/src/components/navigation/ProjectSidebar.tsx:217`, `apps/studio/src/components/navigation/AppShell.tsx:826`.
- Customer-facing feature doc covers defaults, overrides, retained/deleted behavior, archive semantics, synthetic TTL, ClickHouse/Mongo split, and PII scrubbing: `docs/features/eval-retention.md:65`, `docs/features/eval-retention.md:83`, `docs/features/eval-retention.md:90`, `docs/features/eval-retention.md:100`, `docs/features/eval-retention.md:110`.

Issues found:

- HIGH: PATCH is not owner-only. It requires `tenant:manage_settings`; ADMIN has that permission, while the feature doc and audit intent say tenant owner changes this setting: `apps/studio/src/app/api/tenant/retention/route.ts:81`, `apps/studio/src/app/api/tenant/retention/route.ts:84`, `packages/shared-auth/src/rbac/role-permissions.ts:35`, `packages/shared-auth/src/rbac/role-permissions.ts:39`, `docs/features/eval-retention.md:26`.

### Fix 5 — PII scrubbing

Status: FIXED

Evidence:

- Default is opt-in/off: `packages/database/src/eval-retention.ts:44`, `packages/database/src/eval-retention.ts:45`, `packages/database/src/eval-retention.ts:98`.
- v0 regex scrubber is clearly marked as a placeholder with a follow-up to extract the richer detector: `packages/database/src/eval-pii-scrubber.ts:11`, `packages/database/src/eval-pii-scrubber.ts:16`.
- Scrubbing runs on persona create/validate and update: `packages/database/src/models/eval-persona.model.ts:98`, `packages/database/src/models/eval-persona.model.ts:108`.
- Scrubbing runs on scenario create/validate and update: `packages/database/src/models/eval-scenario.model.ts:87`, `packages/database/src/models/eval-scenario.model.ts:97`.
- Tests cover scrub-on, scrub-off, and update semantics: `packages/database/src/__tests__/eval-pii-scrubber.model.test.ts:40`, `packages/database/src/__tests__/eval-pii-scrubber.model.test.ts:65`, `packages/database/src/__tests__/eval-pii-scrubber.model.test.ts:92`.

Issues found:

- None blocking.

## CRITICAL findings (block merge)

None.

## HIGH findings (must fix before merge)

1. Standalone ClickHouse migration hardcodes `abl_platform` rather than using database substitution: `packages/database/clickhouse/migrations/2026-05-11-eval-retention-ttl-columns.sql:9`.
2. Synthetic `knownSource` does not cross the Runtime request boundary, so W1.4 `Session.source.knownSource` composition is missing: `packages/pipeline-engine/src/pipeline/services/eval/eval-runtime-request.ts:1`, `packages/pipeline-engine/src/pipeline/services/eval/eval-runtime-request.ts:39`.
3. Tenant retention PATCH is settings-permission based, not owner-only: `apps/studio/src/app/api/tenant/retention/route.ts:84`, `packages/shared-auth/src/rbac/role-permissions.ts:39`.
4. Cleanup scheduler emits logs but no durable TraceStore/TraceEvent observability: `packages/pipeline-engine/src/pipeline/handlers/eval-retention-scheduler.ts:43`, `packages/pipeline-engine/src/pipeline/services/eval/eval-retention-cleanup.ts:89`.

## MEDIUM / LOW findings

1. MEDIUM: TTL resolver truncates decimals before integer validation: `packages/database/src/eval-retention.ts:58`.
2. MEDIUM: No E2E test proves tenant TTL overrides land in actual ClickHouse rows: `apps/studio/src/__tests__/eval-retention-api.e2e.test.ts:239`, `packages/pipeline-engine/src/__tests__/init-eval-tables-retention.test.ts:22`.
3. MEDIUM: `productionScoresTtlDays` has API/schema support but no write path applying it to production score rows: `packages/database/src/eval-retention.ts:90`, `packages/pipeline-engine/src/pipeline/schemas/init-eval-tables.ts:171`.
4. MEDIUM: Archived run 410 behavior is implemented for heatmap only, while compare/detail paths still proceed normally: `apps/studio/src/app/api/projects/[id]/evals/runs/compare/route.ts:63`, `apps/studio/src/app/api/projects/[id]/evals/runs/[runId]/route.ts:35`.
5. LOW: Hard delete does not explicitly clear trace payloads outside Mongo `EvalRun` deletion if such payloads exist outside ClickHouse TTL timing: `packages/pipeline-engine/src/pipeline/services/eval/eval-retention-cleanup.ts:68`.

## Cross-cutting / composition

- Composes with W1.2 cost rollup: NOT CONFIRMED. This branch's eval DDL and row types include `known_source` and `ttl_override_days`, but no `customer_visible_cost` or `cost_by_model` fields are present in `EvalConversationRow` or `eval_conversations` DDL: `packages/pipeline-engine/src/pipeline/services/eval/eval-types.ts:195`, `packages/pipeline-engine/src/pipeline/schemas/init-eval-tables.ts:41`. Rebase/merge with W1.2 must reconcile those columns explicitly.
- Composes with W1.4 known_source propagation: PARTIAL. EvalRun-to-ClickHouse propagation works, but Runtime session source propagation does not because `eval-runtime-request` has no `knownSource` field: `packages/pipeline-engine/src/pipeline/handlers/eval-run.workflow.ts:324`, `packages/pipeline-engine/src/pipeline/services/eval/eval-runtime-request.ts:1`.
- Stateless Agent Runtime invariant (#4): PASS for scheduler placement. Cleanup is Restate-backed in workflow-engine and bound in `pipeline-engine`, with no new eval retention timer under `apps/runtime`: `packages/pipeline-engine/src/pipeline/handlers/eval-retention-scheduler.ts:30`, `packages/pipeline-engine/src/pipeline/server.ts:544`.
- Traceability invariant (#4): PARTIAL/FAIL for cleanup observability. Logs exist, but no durable TraceStore events are emitted for sweep start/end/error: `packages/pipeline-engine/src/pipeline/handlers/eval-retention-scheduler.ts:43`.

## Build/test results

- No build/test runs in audit mode; this review is read-only and relies on source and commit-time evidence.

## Recommendation

Do not merge as-is. Fix the four HIGH findings first, then add a ClickHouse row-level propagation test for tenant TTL overrides.

Merge order: land W1.2 cost-rollup DDL/types first or rebase ABLP-999 on it and reconcile `eval_conversations` columns in one DDL contract. W1.4 should land before or alongside ABLP-999 if synthetic retention is meant to rely on `Session.source.knownSource`; otherwise ABLP-999 must add the compatibility field now and keep it additive.

Prerequisites before merge:

- Replace hardcoded migration database names with the repo's migration substitution mechanism.
- Add `knownSource` to the eval Runtime request body in the shape W1.4 expects.
- Enforce owner-only PATCH or update the approved contract if ADMIN is intentionally allowed.
- Emit durable retention sweep TraceEvents/TraceStore records.
- Add coverage for ClickHouse row TTL propagation and archived compare/detail behavior.

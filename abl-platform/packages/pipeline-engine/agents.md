# agents.md — packages / pipeline-engine

Agent learning journal for this package. Append-only log of architectural decisions, patterns, gotchas, and insights discovered during SDLC work.

Agents MUST read this file before modifying code in this package. Agents MUST append learnings after completing work.

---

<!-- Append new entries below this line. Format:
## <DATE> — <Feature/Context>
**Category**: architecture | testing | pattern | gotcha | process
**Learning**: <what was learned — specific and actionable>
**Files**: <key files involved>
**Impact**: <how this affects future work in this package>
-->

## 2026-03-23 — Pipeline Engine SDLC Pipeline Completion

**Category**: architecture
**Learning**: `walkGraph()` in `graph-walker.ts` is a pure function with no side effects beyond calling the node executor function. This enables unit testing without Restate. Restate wraps the graph walker for production execution via `pipeline-run.workflow.ts`. Do not add side effects to the graph walker — keep it pure.
**Files**: `src/pipeline/graph-walker.ts`, `src/pipeline/handlers/pipeline-run.workflow.ts`
**Impact**: Any new graph traversal logic must remain side-effect-free. Test graph walking without Restate, test Restate integration separately.

**Category**: architecture
**Learning**: Restate virtual objects provide single-writer guarantee for `PipelineScheduler`. The scheduler is keyed by pipeline ID, preventing duplicate schedule instances. Uses durable sleep + loop pattern for cron scheduling.
**Files**: `src/pipeline/handlers/pipeline-scheduler.ts`
**Impact**: Never create a second scheduler mechanism — rely on Restate's single-writer guarantee.

**Category**: gotcha
**Learning**: Expression evaluator uses a whitelist-only approach for safety — comparison operators, logical operators, dot-path access only. No `eval()`, no `Function()`, no bracket access, no arithmetic. Banned keywords are enforced.
**Files**: `src/pipeline/expression-evaluator.ts`
**Impact**: Never add new operators or features without security review. The whitelist is intentionally restrictive.

**Category**: gotcha
**Learning**: All Restate handler files now use `createLogger` for structured logging (GAP-005 resolved). The three files — `activity-router.service.ts`, `pipeline-trigger.service.ts`, `pipeline-run.workflow.ts` — all import `createLogger` from `@abl/compiler/platform`.
**Files**: `src/pipeline/handlers/activity-router.service.ts`, `src/pipeline/handlers/pipeline-trigger.service.ts`, `src/pipeline/handlers/pipeline-run.workflow.ts`
**Impact**: Maintain structured logging in all new handler files. Use `log.info`/`log.warn`/`log.error` with context objects, never bare `console.log`.

**Category**: gotcha
**Learning**: `eval-preflight.test.ts` sets `ENCRYPTION_MASTER_KEY` in its own `beforeEach` — it is self-contained and does NOT require external env setup. The original agents.md note was incorrect.
**Files**: `src/__tests__/eval-preflight.test.ts`
**Impact**: No CI env setup needed for this test. Always verify claims about env dependencies before propagating them.

**Category**: testing
**Learning**: 5 integration tests now exist. The new `integration-execution-pipeline.test.ts` bridges walkGraph → buildExecutionContext → real service handlers (EvaluateMetrics, EvaluatePolicy, Transform), mimicking runGraphMode's data flow without Restate. The key pattern: create an executor closure that accumulates nodeOutputs and executionContext, then dispatches to real Restate service handlers with a minimal `ctx.run` passthrough. This tests the full execution path minus durable state. 5 E2E suites (22 tests) cover config CRUD, isolation, RBAC, Zod validation, and trigger states via real HTTP API.
**Files**: `src/__tests__/integration-execution-pipeline.test.ts`, `apps/runtime/src/__tests__/pipeline-config-e2e.test.ts`
**Impact**: Execution path testing no longer blocked by Restate infrastructure. New handlers added to SERVICE_HANDLERS should be added to REAL_HANDLERS in the execution pipeline test.

**Category**: process
**Learning**: Feature was initially marked STABLE in all SDLC docs (feature spec, HLD, LLD). This conflated "document is finalized" with "feature is production-ready". Corrected to ALPHA during post-impl-sync (2026-03-23). The correct vocabulary is: HLD status = APPROVED/DRAFT, LLD status = DONE/IN PROGRESS, feature spec status = PLANNED/ALPHA/BETA/STABLE.
**Files**: `docs/features/pipeline-engine.md`, `docs/specs/pipeline-engine.hld.md`, `docs/plans/pipeline-engine.lld.md`
**Impact**: Always use the correct status vocabulary per artifact type. Never conflate document finality with feature maturity.

## 2026-03-23 — Trigger Execution Path: Bug Fix + Integration Tests

**Category**: gotcha
**Learning**: `resolveActiveTriggers()` in `pipeline-config.service.ts` used `config?.activeTriggers ?? definition.defaultTriggerIds`. Mongoose defaults `activeTriggers` to `[]` (empty array) because the schema defines it as `[{ type: String }]`. The `??` operator only falls through on null/undefined, NOT on empty array. Result: no triggers were ever activated for configs that didn't explicitly set `activeTriggers`. Fixed: check `configTriggers && configTriggers.length > 0` before using `??`.
**Files**: `src/pipeline/services/pipeline-config.service.ts`
**Impact**: Any Mongoose array field used with `??` fallback is suspect. Mongoose defaults all `[Type]` fields to `[]`. Always check `.length > 0` before falling through with `??`.

**Category**: testing
**Learning**: Pipeline config CRUD E2E tests are insufficient for BETA qualification. They only test the API layer — not the execution path. The integration-trigger-execution test covers the real production path: Kafka event → PipelineTrigger.handleEvent → findActivePipelinesForEvent (real MongoDB query) → tenant isolation → event filter matching → multi-trigger strategy resolution → activeTriggers override → sampling rate → manual trigger → activity dispatch with real service handlers → run record persistence. It also caught a real bug that unit tests with mocked DBs could never catch.
**Files**: `src/__tests__/integration-trigger-execution.test.ts`
**Impact**: Execution path testing is a gate for BETA. Any new trigger/execution feature must have integration test coverage against real MongoDB.

**Category**: testing
**Learning**: MongoMemoryServer cannot run global `mongoose.connection.syncIndexes()` when models from other packages register partial filter expressions (e.g., `{ projectId: { $ne: '' } }`). Fix: sync indexes per model — `PipelineDefinitionModel.syncIndexes()`, `PipelineConfigModel.syncIndexes()`, `PipelineRunRecordModel.syncIndexes()`.
**Files**: `src/__tests__/integration-trigger-execution.test.ts`
**Impact**: Always use model-specific `syncIndexes()` in tests, never global `mongoose.connection.syncIndexes()`.

## 2026-03-24 — Feature Spec + HLD Audit: Implementation vs Documentation Gap

**Category**: architecture
**Learning**: The pipeline-engine package contains 7 standalone analytical services (NL Query, ROI Calculator, Alert Evaluator, Outcome Classification, Experiment Results, LLM Client Factory, Conversation Reader) that exist outside the pipeline execution framework. They are not pipeline node types and do not use the activity router or graph walker. They were undocumented in the feature spec and HLD until this audit.
**Files**: `src/pipeline/services/nl-query.service.ts`, `src/pipeline/services/roi-calculator.service.ts`, `src/pipeline/services/alert-evaluator.service.ts`, `src/pipeline/services/outcome-classification.ts`, `src/pipeline/services/experiment-results.service.ts`, `src/pipeline/services/llm-client-factory.ts`
**Impact**: When adding new standalone services, document them in the feature spec §10 "Standalone Services" section and HLD §3.7. They are architecturally distinct from pipeline node types.

**Category**: gotcha
**Learning**: 7 node types (`sub-pipeline`, `db-query`, `filter`, `aggregate`, `send-email`, `send-slack`, `publish-kafka`) have complete Restate service implementations AND are seeded into MongoDB `node_type_definitions` (visible in Studio Node Palette), but are NOT registered in `SERVICE_HANDLERS` or `ACTIVITY_TYPES` in `activity-router.service.ts`. Users can drag these nodes onto the canvas in Studio, but they fail at runtime with "Unknown activity type" errors.
**Files**: `src/pipeline/handlers/activity-router.service.ts`, `src/pipeline/services/sub-pipeline.service.ts`, `src/pipeline/services/db-query.service.ts`, `src/pipeline/services/filter.service.ts`, `src/pipeline/services/aggregate.service.ts`, `src/pipeline/services/send-email.service.ts`, `src/pipeline/services/send-slack.service.ts`, `src/pipeline/services/publish-kafka.service.ts`
**Impact**: Before adding new node types, check ALL three registration points: (1) `ACTIVITY_TYPES` metadata, (2) `SERVICE_HANDLERS` dispatch table, (3) `.bind()` in `server.ts`. Missing any one causes silent runtime failure.

**Category**: gotcha
**Learning**: `alertEvaluatorService` is defined as a Restate service but is NOT bound to the Restate endpoint in `server.ts` (line 311-343). It is exported from the package index but has no caller. It needs `.bind()` plus an invocation mechanism (cron or trigger) to become functional.
**Files**: `src/pipeline/services/alert-evaluator.service.ts`, `src/pipeline/server.ts`
**Impact**: When creating new Restate services, always verify they are bound in `server.ts`. Exported ≠ deployed.

**Category**: architecture
**Learning**: ClickHouse analytics tables use `ReplacingMergeTree(processed_at)` (not plain `MergeTree`) for deduplication on reprocessing. Eval tables use `MergeTree`. Analytics materialized views use `SummingMergeTree`, eval MVs use `AggregatingMergeTree`. Total: 27 tables, 10 materialized views.
**Files**: `init-analytics-tables.ts`, `init-eval-tables.ts`
**Impact**: When adding new ClickHouse tables, use `ReplacingMergeTree` for analytics (enables idempotent reprocessing) and `MergeTree` for append-only data.

## 2026-03-24 — BETA → STABLE LLD: Security & Wiring Audit

**Category**: gotcha
**Learning**: `db-query.service.ts` ClickHouse path (`executeClickHouseQuery`) had NO tenant_id or project_id filtering — user-provided queries ran unscoped against all tenant data. The MongoDB path also lacked `projectId` enforcement (only had `tenantId`). The `nl-query.service.ts` already exports `validateSQL()` with FORBIDDEN_PATTERNS and SELECT-only enforcement — reuse it rather than reimplementing. For ClickHouse tenant isolation, use parameterized `query_params: { tenantId, projectId, limit }` matching the nl-query and alert-evaluator patterns.
**Files**: `src/pipeline/services/db-query.service.ts`, `src/pipeline/services/nl-query.service.ts`
**Impact**: Before wiring ANY new service into SERVICE_HANDLERS, audit its query paths for tenant/project isolation. ClickHouse queries MUST use `query_params` with `tenant_id` and `project_id`. MongoDB queries MUST include both `tenantId` AND `projectId` in filters.

**Category**: gotcha
**Learning**: 3 services (`computeGoalCompletionService`, `httpRequestService`, `readMessageWindowService`) were in SERVICE_HANDLERS and ACTIVITY_TYPES but never `.bind()`-ed in `server.ts`. The activity router calls handlers directly (not via `ctx.serviceClient`), so they worked — but they would fail if any other service tried to call them via `ctx.serviceClient()`. The completeness test (`activity-metadata-completeness.test.ts`) should prevent this going forward.
**Files**: `src/pipeline/server.ts`, `src/pipeline/handlers/activity-router.service.ts`
**Impact**: All three registration points (ACTIVITY_TYPES, SERVICE_HANDLERS, server.ts `.bind()`) must be checked together. The completeness test is the automated guardrail.

**Category**: gotcha
**Learning**: `sub-pipeline.service.ts` line 44 queries `tenantId: pipelineInput.tenantId` which excludes built-in definitions (`tenantId: '__platform__'`). The correct pattern (used by `pipeline-trigger.service.ts` line 324) is `tenantId: { $in: ['__platform__', tenantId] }`. Any service looking up `PipelineDefinitionModel` must use the `$in` pattern to include built-in definitions.
**Files**: `src/pipeline/services/sub-pipeline.service.ts`, `src/pipeline/handlers/pipeline-trigger.service.ts`
**Impact**: When querying `PipelineDefinitionModel`, always use `tenantId: { $in: ['__platform__', tenantId] }` unless specifically excluding built-in definitions.

**Category**: architecture
**Learning**: `AlertEvaluationScheduler` must be a SEPARATE Restate virtual object from `PipelineScheduler`. PipelineScheduler is keyed by pipeline ID (single-writer per pipeline). Alert evaluation is keyed by tenant ID (cross-cuts all pipelines). Mixing concerns in one virtual object creates confusing key spaces.
**Files**: `src/pipeline/handlers/alert-evaluation-scheduler.ts` (new), `src/pipeline/handlers/pipeline-scheduler.ts`
**Impact**: Each Restate virtual object should have a single keying strategy and a single responsibility. Do not reuse objects across concerns even if the durable-sleep-loop pattern is the same.

## 2026-03-24 — Phase 2: Unit Tests for 7 Node Type Services

**Category**: testing
**Learning**: When mocking dynamic `import()` calls inside Restate service handlers using vitest with `pool: 'forks'`, `vi.doMock` does NOT intercept the import path. Only `vi.mock` (hoisted) works. The `vi.mock` path must be relative to the test file, not relative to the source file containing the dynamic import. Example: service imports `../../schemas/pipeline-definition.schema.js` (relative to `src/pipeline/services/`), but the test at `src/__tests__/` must mock `../schemas/pipeline-definition.schema.js`.
**Files**: `src/__tests__/sub-pipeline.test.ts`
**Impact**: Always use `vi.mock` (hoisted) for mocking modules that are dynamically imported inside service handlers. Verify the correct relative path from the test file's location.

**Category**: testing
**Learning**: For "module not found" graceful degradation tests, cannot throw inside `vi.doMock` or `vi.mock` factory — vitest wraps the error with its own message that doesn't contain "Cannot find module". Instead, mock the module to return a function that throws with "Cannot find module" in the message. The service handlers check `msg.includes('Cannot find module') || msg.includes('MODULE_NOT_FOUND')`.
**Files**: `src/__tests__/db-query.test.ts`, `src/__tests__/send-email.test.ts`, `src/__tests__/send-slack.test.ts`, `src/__tests__/publish-kafka.test.ts`
**Impact**: Follow this pattern for any future "module not available" test.

**Category**: testing
**Learning**: Restate service handler functions are accessible at `(serviceVar as any).service.execute`, not at `serviceVar.handlers.execute`. The Restate SDK wraps the handlers during `restate.service()` creation. This is the standard access pattern for unit testing Restate services in this package (also used by `http-request.test.ts` and `unwired-node-dispatch.test.ts`).
**Files**: All 7 new test files in `src/__tests__/`
**Impact**: Always access handlers via `.service.execute` when testing Restate services.

## 2026-03-30 — LLM Client Migration: createPipelineLLMClient → resolvePipelineLLM + Vercel AI SDK

**Category**: architecture
**Learning**: `llm-client-factory.ts` now exports ONLY `resolvePipelineLLM` (resolution) and `ResolvedPipelineLLM` (type). The old `createPipelineLLMClient`, `resolveLLMCredentials`, and `PipelineChatMessage` have been removed. All LLM calls use the pattern: `resolvePipelineLLM` → `createVercelProvider` (from `@agent-platform/llm`) → `generateText` (from `@agent-platform/llm`). The `generateText` return uses `.text` (not `.content`) and `.usage?.inputTokens` / `.usage?.outputTokens`. System prompts go as a separate `system` param, not in the messages array.
**Files**: `src/pipeline/services/llm-evaluate.service.ts`, `src/pipeline/services/nl-query.service.ts`, `src/pipeline/services/eval/simulate-persona.service.ts`, `src/pipeline/services/eval/run-eval-conversation.service.ts`, `src/pipeline/services/eval/judge-conversation.service.ts`, `src/pipeline/services/eval/eval-preflight.ts`
**Impact**: Any new LLM-calling service must follow this pattern. Never import `createPipelineLLMClient` — it no longer exists. Tests mocking the old `createPipelineLLMClient` need to be updated to mock `resolvePipelineLLM` + `@agent-platform/llm` instead.

## 2026-04-06 — Bruce Wilcox Feedback Slice 2 Filter Parsing

**Category**: gotcha
**Learning**: Filter expressions must not detect comparison operators with raw `indexOf()` scans. Quoted literals can contain tokens like `!=` or `==`, so the safe pattern is a shared top-level splitter that tracks quote state and nesting before matching comparison operators.
**Files**: `src/pipeline/expression-evaluator.ts`, `src/pipeline/services/filter.service.ts`, `src/__tests__/filter-service.test.ts`
**Impact**: Any future pipeline-engine code that splits comparison expressions should reuse `splitTopLevelComparison()` instead of adding a local operator search.

## 2026-04-13 — Pipeline Observability Phase 1: Schema Denormalization

**Category**: architecture
**Learning**: `IPipelineRunRecord` now has optional `projectId`, `triggerInput`, and `triggerInputTruncated` fields. `projectId` is denormalized from `PipelineConfig` to support project-scoped Recent Runs queries without joins. `triggerInput` stores the raw trigger payload for Re-run. Two composite indexes added: `{ tenantId, projectId, startedAt }` and `{ tenantId, projectId, pipelineId, startedAt }`.
**Files**: `src/schemas/pipeline-run-record.schema.ts`, `src/__tests__/run-record-project-isolation.test.ts`
**Impact**: Later phases will populate these fields during pipeline execution (in `pipeline-trigger.service.ts`) and query them via new API routes. All fields are optional so existing records are unaffected.

## 2026-04-15 — Pipeline Observability: Stuck-run watchdog removed

**Category**: architecture
**Learning**: The stuck-run watchdog (`promoteStuckRuns()` + `PipelineScheduler.runWatchdog`) was designed as a safety net for manual/step-less runs that persisted a `PipelineRunRecord` but never produced step transitions. The handler was defined on `PipelineScheduler` but never bootstrapped — no caller ever sent `runWatchdog` on key `__watchdog__`, so the durable loop never started in any environment. Restate's own delivery guarantees cover the main failure mode the watchdog claimed to protect (fire-and-forget `workflowSendClient` sends are journaled inside the parent handler), so the watchdog was removed rather than wired up. If orphan `status: 'running'` rows are ever observed in production, revive via git history.
**Files**: `src/pipeline/handlers/pipeline-scheduler.ts` (removed `runWatchdog` handler and related imports)
**Impact**: `PipelineScheduler` is now cron-only. The 90-day TTL on `PipelineRunRecord` is the sole garbage-collection path for any orphaned run records. New failure modes that produce stuck records should be handled at the source (inside the trigger path), not via a periodic sweeper.

## 2026-04-13 — Pipeline Observability: Cross-Phase Learnings

**Category**: architecture
**Learning**: PipelineTrigger.triggerManual was extended (not duplicated) to own manual-run creation. handleEvent and triggerManual both denormalize projectId onto PipelineRunRecord — one-line change, avoids a Mongo lookup on every Recent Runs query.
**Files**: `src/pipeline/handlers/pipeline-trigger.service.ts`, `src/schemas/pipeline-run-record.schema.ts`
**Impact**: Any new trigger path must continue to populate projectId + triggerInput.

**Category**: pattern
**Learning**: ClickHouse analytics tables gained run*id + pipeline_id columns with minmax indexes. All compute-* services and store-results write these fields. Query builder in Studio includes them in every WHERE clause.
**Files**: `packages/database/clickhouse/migrations/2026-04-13-add-run-id-to-analytics-tables.sql`, `src/pipeline/services/compute-_.service.ts`
**Impact**: New ClickHouse output tables must include run_id + pipeline_id + tenant_id + project_id columns.

**Category**: gotcha
**Learning**: Trigger templates live in packages/pipeline-engine/src/pipeline/trigger-templates/ as static JSON. The build script copies them to dist. Adding resolveJsonModule to tsconfig was required.
**Files**: `tsconfig.json`, `package.json`
**Impact**: New Kafka trigger types need a template JSON here.

## 2026-04-24 — ABLP-564 Phase 1: Contract Foundation

**Category**: architecture
**Learning**: Phase 1 of the custom-pipeline UX redesign introduces three typed contracts in `src/pipeline/contracts/`: `TriggerContract`, `NodeContract`, `DestinationContract`, plus a `ContractRegistry` that hydrates from existing sources (`ACTIVITY_TYPES` in `activity-metadata.ts`, `seed-data/trigger-definitions.json`, `seed-data/node-type-definitions.json`) and two new data files (`node-contract-data.ts` with per-node `NODE_ENRICHMENT`, `destination-contract.ts` with `DESTINATION_REGISTRY`). Contracts are the single source of truth going forward for all UX-side validation, autocomplete, preview filtering, and error interpretation. Zero user-visible change in this phase; downstream phases consume the registry.
**Files**: `src/pipeline/contracts/*.ts`, `src/pipeline/seed-data/trigger-definitions.json` (extended with `exampleOutput`), `src/index.ts` (barrel), `package.json` (added `./contracts` subpath export)
**Impact**: New node types must register an entry in BOTH `ACTIVITY_TYPES` (existing shape) AND `contracts/node-contract-data.ts` (enrichment). The `registry.integration.test.ts` + the coverage assertion in `node-contract.test.ts` enforce that `NODE_ENRICHMENT` keys match `ACTIVITY_TYPES` keys — a new node without enrichment fails CI. When a contract tightens for an existing node, bump its `contractVersion` in `node-contract-data.ts`.

**Category**: gotcha
**Learning**: The `.claude/hooks/unbounded-collections.sh` hook blocks `new Map()` / `new Set()` in service/package files unless the content around it mentions `MAX_`, `maxSize`, `.delete(`, `evict`, `LRU`, `lru`, `TTL`, `ttl`, `expire`, `cache.clear`, or `.clear(`. Even statically-bounded collections trigger the block. Workarounds: (1) use a `readonly Foo[]` + `.includes()` for small sets of literals; (2) for genuine Maps, add explicit `MAX_*` constants and an `assertBounds()` check — the docs/check also serves as real defensive code.
**Files**: `src/pipeline/contracts/registry.ts`, `src/pipeline/contracts/trigger-contract.ts`, `src/pipeline/contracts/destination-contract.ts`, `src/pipeline/contracts/node-contract.ts`
**Impact**: Future additions of registries or lookup maps in this package must include explicit size bounds with runtime assertions, or refactor to readonly arrays.

## 2026-04-24 — ABLP-564 Phase 2: Save-time gates

**Category**: architecture
**Learning**: `validateGraphPipeline` now takes an optional third `contractRegistry` argument. When provided, it cross-checks the entry node's `NodeContract.inputRequirements.fromTrigger` against every `supportedTriggers[].id`'s `TriggerContract.outputSchema`. Two classes of failure: (1) trigger id not in `compatibleTriggers` allowlist, (2) required trigger field missing from outputSchema. Legacy pipelines — where the entry node has no `contractVersion` stamp — get warnings instead of errors, so existing production pipelines keep loading. New `PipelineNode.contractVersion?: number` field added to types.ts (absent = legacy grandfather mode). A lazy module-level singleton `getDefaultContractRegistry()` lets callers who don't pass a registry opt into contract validation automatically without constructing one themselves.
**Files**: `src/pipeline/validation.ts`, `src/pipeline/types.ts`, `src/__tests__/contracts/trigger-node-compat.test.ts`
**Impact**: Studio POST/PATCH routes now pass a `ContractRegistry` into `validateGraphPipeline` and stamp `contractVersion` on each node at save time. When bumping contractVersion for a node, existing saved pipelines stay at the old version until re-saved — the validator only enforces the version that's stamped. For new callers: if you're wiring a runtime validator into a save path, also arrange for `contractVersion` stamping so subsequent saves are strict, not legacy.

## 2026-04-25 — ABLP-564 Phase 3: Destination UX + exampleOutput plumbing

**Category**: pattern
**Learning**: Added `'info'` as a new `ConfigField.type` for non-interactive inline banners. Unlike data fields, `info` fields carry their message in `description`, are styled via the new optional `intent: 'info' | 'warning' | 'success' | 'error'` property, and honor the existing `showWhen` visibility rule — letting authors compose contextual help panels declaratively in the seed JSON rather than hardcoding conditions in ConfigSchemaForm. The store-results seed uses this for four banners that switch on `destination` (ClickHouse format hint, Mongo/callback/none preview-not-supported warnings). When adding new banners, prefix field names with `__` (they're non-persisted UI hints, not config keys — the `__` convention avoids collisions with real config names). Also added `exampleOutput` to the `TriggerEntry` Mongoose sub-schema — without the explicit `Schema.Types.Mixed` declaration Mongoose silently strips unknown fields on save.
**Files**: `src/pipeline/types.ts` (ConfigField.type + intent), `src/pipeline/seed-data/node-type-definitions.json` (store-results banners), `src/schemas/pipeline-definition.schema.ts` (TriggerEntrySchema.exampleOutput), `src/pipeline/trigger-registry.ts` (TriggerDefinition.exampleOutput)
**Impact**: New banners are cheap to add — one JSON entry per condition. The `__` prefix convention for non-persisted field names applies to any future form-only UI hooks. Any new field added to a Mongoose sub-schema that flows client→server→client must be declared in the `.schema.ts` file; pure TS interface changes are NOT enough.

## 2026-04-25 — ABLP-564 Phase 4: Store Results score/document persistence

**Category**: architecture
**Learning**: Store Results now has an explicit analytics/document split instead of treating ClickHouse and MongoDB as interchangeable targets. `storageStrategy: score_and_document` writes one numeric score projection to the shared ClickHouse table and the full selected document to MongoDB; `score_only` writes only ClickHouse; `document_only` writes only MongoDB. `scorePath`/`scoreName` control the analytics projection, `documentPath` controls the Mongo payload, and legacy `destination` behavior remains for existing pipelines. Shared ClickHouse writes intentionally store only `score_name`, `score_path`, `score_value`, metadata, and a minimal `output_json` audit payload so analytics filters stay first-class.
**Files**: `src/pipeline/services/store-results.service.ts`, `src/pipeline/contracts/destination-contract.ts`, `src/pipeline/seed-data/node-type-definitions.json`, `src/pipeline/templates/*.json`
**Impact**: New analytics-oriented custom pipeline templates should prefer `score_and_document` when they emit a primary numeric score plus nested evidence. Use `document_only` for guardrail/evidence payloads with no stable numeric score. Do not pass a ClickHouse `database.table` fallback into Mongo strategy writes; blank Mongo collection means the shared `custom_pipeline_results` collection.

## 2026-04-25 — EvalRun terminal failure handling

**Category**: gotcha
**Learning**: `EvalRunWorkflow` must not rely on thrown deterministic errors to update run state. Missing eval sets, missing referenced personas/scenarios/evaluators, failed preflight, and cancelled runs are terminal conditions. If they bubble without a workflow-boundary catch, Restate may stop retrying but the persisted `EvalRun` can still be left in a stale `running` state. The safe pattern is to classify known deterministic failures, convert load-time misses like `EvalSet ... not found` into `TerminalError`, then catch terminal failures at the workflow boundary to set durable status to `failed` and persist `completedAt` before returning a failed result.
**Files**: `src/pipeline/handlers/eval-run.workflow.ts`, `src/pipeline/handlers/eval-run-errors.ts`, `src/__tests__/eval-run-errors.test.ts`
**Impact**: Any future deterministic eval-run failure path should be added to `classifyEvalRunError()` and handled at the workflow boundary instead of depending on implicit Restate retry semantics.

## 2026-04-26 — Eval Preflight AES-GCM Auth Tag Length

**Category**: gotcha
**Learning**: `eval-preflight.ts` performs a real AES-256-GCM round-trip against `ENCRYPTION_MASTER_KEY`, so its `createDecipheriv()` call needs `{ authTagLength: 16 }` explicitly. Relying on OpenSSL defaults here can drift from the stricter runtime/database/shared-encryption paths and turn a health check into a false negative during Node/OpenSSL upgrades.
**Files**: `src/pipeline/services/eval/eval-preflight.ts`, `src/__tests__/eval-preflight.test.ts`
**Impact**: Any future pipeline-engine AES-GCM smoke test or readiness probe should set the auth tag length explicitly instead of assuming provider defaults.

## 2026-04-28 — ABLP-2 Phase 2: Experiment Assignment & Service Layer

**Category**: architecture
**Learning**: Experiment assignment functions (FNV-1a hashing, eligibility checks) live in `src/services/experiment-assignment.ts` as pure functions — no side effects, no DB calls, no mocks needed for testing. `ExperimentService` class in `src/services/experiment.service.ts` handles Redis caching and DB queries. This separation follows the "extract pure functions" testing philosophy.
**Files**: `src/services/experiment-assignment.ts`, `src/services/experiment.service.ts`
**Impact**: Any new experiment logic that is deterministic (e.g., new eligibility rules, different hashing strategies) should go in experiment-assignment.ts. Side-effectful operations (cache, DB) stay in ExperimentService.

**Category**: gotcha
**Learning**: `ISession` and `Session` are exported from `@agent-platform/database/models`, NOT from `@agent-platform/database` root. The root export provides ClickHouse client, ModelRegistry, and connection utilities. Mongoose models are always at the `/models` subpath.
**Files**: `src/services/experiment-assignment.ts`
**Impact**: Always use `from '@agent-platform/database/models'` when importing Mongoose models or their interfaces in pipeline-engine.

**Category**: gotcha
**Learning**: `SessionSource` type (`'studio' | 'public' | 'channel'`) is NOT exported from the database models barrel (`@agent-platform/database/models`). Use `Pick<ISession, 'source'>` to infer the correct type without needing the explicit `SessionSource` import.
**Files**: `src/services/experiment-assignment.ts`
**Impact**: When using session source types, rely on Pick/inferred types rather than trying to import SessionSource directly.

**Category**: pattern
**Learning**: `RedisLike` type in `src/pipeline/services/definition-cache.ts` includes `get`, `set`, `del`, and `keys` methods — reuse this interface for any new Redis-dependent service in this package rather than defining a new one.
**Files**: `src/services/experiment.service.ts`
**Impact**: New services needing Redis access should import `RedisLike` from definition-cache.ts.

## 2026-04-28 — ABLP-2 Phase 5: Experiment Results Computation, Safety Rules, Cron

**Category**: architecture
**Learning**: `computeExperimentResults()` on `ExperimentResultsService` queries ClickHouse `experiment_assignments` joined with `quality_evaluations` and `eval_production_scores` to compute per-group metrics. The table originally named `conversation_quality` in the LLD does not exist — the actual table is `quality_evaluations` in the `abl_platform` database. ClickHouse query results from `ch.query()` return `{ data: T[] }` when calling `.json()` — always destructure `.data` from the result.
**Files**: `src/pipeline/services/experiment-results.service.ts`
**Impact**: When writing ClickHouse queries, always verify table names against `init-analytics-tables.ts` and `init-eval-tables.ts`. The `.json()` result wraps rows in a `.data` property.

**Category**: architecture
**Learning**: Safety rule evaluation is a pure function in `src/services/experiment-safety.ts` — follows the same pattern as experiment-assignment.ts (pure function file separate from side-effectful services). The `evaluateOperator` helper maps operator strings to comparison functions. The operator defines the "passing" condition: `operator: 'lt', threshold: 0.05` means "passing when value < 0.05".
**Files**: `src/services/experiment-safety.ts`, `src/__tests__/experiment-safety.test.ts`
**Impact**: Safety rule operators define the passing condition, not the breach condition. A breach is `passing === false`.

**Category**: pattern
**Learning**: The experiment results cron uses `setInterval` + Redis distributed lock (`SET NX PX`) rather than a Restate virtual object. This is because the cron processes all running experiments across all tenants in a single sweep, which doesn't fit the per-tenant keyed Restate object model used by `AlertEvaluationScheduler`. The Redis lock key is `cron:experiment-results` with 5-minute TTL.
**Files**: `src/pipeline/handlers/experiment-results-cron.ts`, `src/pipeline/server.ts`
**Impact**: Use Redis distributed locking for cross-tenant cron jobs. Use Restate virtual objects for per-tenant/per-entity scheduling.

**Category**: gotcha
**Learning**: The `RedisLike` type from `definition-cache.ts` doesn't support the `SET key value PX ttl NX` overload needed for distributed locking. The cron handler defines its own `LockableRedis` interface with `set(key, value, ...args)`. ioredis supports this overload natively.
**Files**: `src/pipeline/handlers/experiment-results-cron.ts`
**Impact**: For distributed locking, define a separate Redis interface or extend `RedisLike`. Don't try to use `RedisLike.set(key, value, 'EX', ttl)` for NX locking.

**Category**: gotcha
**Learning**: The `AuditLog` model is in `@agent-platform/database/models`, not in pipeline-engine. The cron handler uses a lazy `import('@agent-platform/database/models')` to write audit entries for auto-stop events.
**Files**: `src/pipeline/handlers/experiment-results-cron.ts`
**Impact**: Audit log writes from pipeline-engine must use lazy imports of `AuditLog` from the database package.

## 2026-04-28 — ABLP-2 Phase 7: Experiment Test Suite

**Category**: testing
**Learning**: Experiment pure functions (`getAssignmentKey`, `assignExperimentGroup`, `checkSessionEligibility`) are fully testable without mocks. The `ExperimentService` class uses dependency injection (RedisLike, model factory function, session lookup function) — create in-test fakes rather than vi.mock(). The `createFakeRedis()` pattern uses a `Map<string, string>` and tracks deleted keys. The `createFakeModelFactory()` returns a fake model with a `findOne().lean()` chain and call counting.
**Files**: `src/__tests__/experiment-assignment.test.ts`, `src/__tests__/experiment-eligibility.test.ts`, `src/__tests__/experiment-stickiness.test.ts`, `src/__tests__/experiment-status.test.ts`
**Impact**: Future experiment service tests should follow this pattern: inject fakes at construction, not mock at module level. 43 total tests cover all AC scenarios (UNIT-1 through UNIT-5).

## 2026-04-29 — Experiments PR Review Fixes

**Category**: testing
**Learning**: Statistical computation methods (tTest, chiSquared, normalCDF, minSampleSizeForEffect, confidenceInterval) that are class methods but have zero instance dependencies should be extracted to a standalone pure-functions module. This eliminates the need to mock platform imports (createLogger, getClickHouseClient) just to test math. Pattern: create `experiment-stats.ts` with exported functions, have the service delegate to them. Tests import the pure module directly.
**Files**: `src/pipeline/services/experiment-stats.ts`, `src/pipeline/services/experiment-results.service.ts`, `src/__tests__/experiment-results.test.ts`
**Impact**: Any future service with pure computation methods should follow this extract-then-test pattern. vi.mock of @abl/_ or @agent-platform/_ is always wrong — fix the code instead.

**Category**: architecture
**Learning**: Redis cache keys for project-scoped data MUST include tenantId even when projectIds are UUIDs and practically unique. The cache key `experiment:active:{tenantId}:{projectId}` is architecturally correct; `experiment:active:{projectId}` alone violates the tenant isolation principle even if collisions are impossible with UUID generation. Similarly, invalidateCache() must accept tenantId to construct the full scoped key.
**Files**: `src/services/experiment.service.ts`
**Impact**: Always include tenantId in Redis cache keys for tenant-scoped resources. Update invalidateCache() signatures to accept tenantId.

**Category**: gotcha
**Learning**: Duplicate ClickHouse DDL across init files (init-analytics-tables.ts + init-experiment-tables.ts both defining experiment_assignments) silently uses CREATE TABLE IF NOT EXISTS — whichever runs first wins. This means a newer/corrected schema may be silently ignored if the old one was created first. Always canonicalize table DDL in exactly one file and remove duplicates immediately when discovered.
**Files**: `src/pipeline/schemas/init-analytics-tables.ts`, `src/pipeline/schemas/init-experiment-tables.ts`
**Impact**: When adding new ClickHouse tables, check init-analytics-tables.ts for pre-existing definitions and remove them.

## 2026-05-11 — Eval Retention TTL Columns and Cleanup

**Category**: architecture
**Learning**: ClickHouse MergeTree TTL can reference regular `UInt16` columns through `toIntervalDay(ttl_override_days)`. For tenant-specific eval retention, write the resolved TTL onto each eval row instead of trying to read Mongo settings dynamically from ClickHouse.
**Files**: `src/pipeline/schemas/init-eval-tables.ts`, `src/pipeline/services/eval/eval-retention.ts`, `src/pipeline/services/eval/run-eval-conversation.service.ts`, `src/pipeline/services/eval/judge-conversation.service.ts`
**Impact**: Future per-tenant ClickHouse lifecycle policies should prefer row-level resolved columns when TTL can be decided at write time.

**Category**: pattern
**Learning**: Retention cleanup is a Restate-backed workflow-engine concern, not an in-process timer. The eval retention scheduler starts a durable virtual-object loop and invokes a service that archives or deletes expired Mongo `EvalRun` documents.
**Files**: `src/pipeline/handlers/eval-retention-scheduler.ts`, `src/pipeline/services/eval/eval-retention-cleanup.ts`, `src/pipeline/server.ts`
**Impact**: New nightly/background sweeps in pipeline-engine should be implemented as Restate services/objects so multiple pods do not create local timer state.

# High-Level Design: Agent Testing & Evals

**Feature Slug:** `agent-testing-evals`
**Status:** ALPHA
**Last Updated:** 2026-03-22

---

## 1. Overview

The Agent Testing & Evals system provides automated quality validation for agents built on the ABL Platform. It enables teams to define test personas, scenarios, and evaluators, compose them into eval sets, and execute evaluation runs that simulate multi-turn conversations against the live Runtime. Results are scored via LLM judges, code-based scorers, trajectory analysis, and human review queuing, then persisted to ClickHouse for analytics and regression detection.

### System Context

```
                    ┌──────────────┐
                    │  Studio UI   │
                    │  (Next.js)   │
                    └──────┬───────┘
                           │ REST API
                    ┌──────▼───────┐         ┌──────────────┐
                    │  Studio API  │────────→│   MongoDB     │
                    │  Routes      │         │ (Config Store)│
                    └──────┬───────┘         └──────────────┘
                           │ Trigger
                    ┌──────▼───────┐         ┌──────────────┐
                    │  Pipeline    │────────→│  ClickHouse   │
                    │  Engine      │         │ (Result Store) │
                    │  (Restate)   │         └──────────────┘
                    └──────┬───────┘
                           │ HTTP API
                    ┌──────▼───────┐         ┌──────────────┐
                    │   Runtime    │────────→│  LLM Provider │
                    │  (Express)   │         │  (External)   │
                    └──────────────┘         └──────────────┘
```

## 2. Architecture Decisions

### AD-1: Dual Storage Strategy (MongoDB + ClickHouse)

**Decision:** Configuration entities (personas, scenarios, evaluators, eval sets, runs) are stored in MongoDB. Execution data (conversations, scores) is stored in ClickHouse.

**Rationale:**

- MongoDB excels at flexible document schemas, tenant-scoped queries, and the CRUD patterns needed for configuration management
- ClickHouse excels at columnar analytics, time-series aggregation, and materialized views needed for heatmaps and trend analysis
- Eval conversations can be large (compressed JSON); ClickHouse's ZSTD codec + app-layer gzip handles this efficiently
- TTL-based data lifecycle is native to ClickHouse partitioning

**Alternatives Considered:**

- MongoDB-only: Would require manual aggregation for heatmaps; poor performance at scale for analytical queries
- ClickHouse-only: Poor fit for CRUD-heavy config management; no mature schema migration tooling

### AD-2: Restate Durable Workflow for Orchestration

**Decision:** Eval runs are orchestrated by a Restate durable workflow (`EvalRunWorkflow`) rather than the generic `PipelineRun` workflow.

**Rationale:**

- Eval runs need custom fan-out logic (persona x scenario x variant matrix) that doesn't map to generic step-by-step pipeline execution
- Restate provides durable execution: survives pod restarts, retries transient failures, tracks progress via shared state
- Batched concurrency control (maxConcurrency) is natively supported via `CombineablePromise.all()`

**Alternatives Considered:**

- BullMQ Flows: Would work but lacks Restate's deterministic replay and durable state
- Generic PipelineRun: Too rigid for matrix fan-out/fan-in pattern

### AD-3: Four Evaluator Types

**Decision:** Support 4 evaluator types: `llm_judge`, `code_scorer`, `trajectory`, `human_review`.

**Rationale:**

- LLM judges provide nuanced scoring but are expensive and potentially biased
- Code scorers provide deterministic, zero-cost scoring for measurable properties
- Trajectory scorers validate multi-agent handoff paths and milestone achievement
- Human review handles edge cases where automated scoring has low confidence

### AD-4: Persona Simulation via LLM

**Decision:** Personas are simulated by an LLM generating user messages based on persona profiles and scenario context.

**Rationale:**

- LLM simulation produces diverse, realistic conversation patterns
- Adversarial personas (prompt injection, social engineering, etc.) test agent robustness
- Alternative: scripted test cases are more predictable but less realistic and harder to maintain

### AD-5: Bias Mitigation as First-Class Feature

**Decision:** LLM judge bias mitigation is built in with 4 techniques: position swap, blind evaluation, evidence-first (RULERS), cross-model judge.

**Rationale:**

- LLM judges exhibit known biases (position bias, anchoring, model preference)
- Position swap detects and mitigates position bias by averaging scores
- Evidence-first forcing reduces anchoring by requiring evidence extraction before scoring
- These are configurable per evaluator to balance cost vs accuracy

## 3. Component Architecture

### 3.1 Configuration Layer (MongoDB)

```
┌─────────────────────────────────────────────────────────────┐
│                    MongoDB Collections                       │
├─────────────┬─────────────┬──────────────┬─────────────────┤
│ eval_personas│eval_scenarios│eval_evaluators│   eval_sets    │
│             │             │              │ (composition)    │
│ uuidv7 _id  │ uuidv7 _id  │ uuidv7 _id   │ uuidv7 _id     │
│ tenantId    │ tenantId    │ tenantId     │ tenantId        │
│ projectId   │ projectId   │ projectId    │ projectId       │
│ version (_v)│ version (_v)│ version (_v) │ personaIds[]    │
│ name        │ name        │ name         │ scenarioIds[]   │
│ commStyle   │ entryAgent  │ type (4)     │ evaluatorIds[]  │
│ domainKnow  │ maxTurns    │ judgeModel   │ variants        │
│ goals       │ milestones  │ scoringRubric│ maxConcurrency  │
│ adversarial │ agentPath   │ biasSettings │ ciEnabled       │
└─────────────┴─────────────┴──────────────┴─────────────────┘
                                              │
                                              ▼
                                        ┌──────────┐
                                        │eval_runs │
                                        │ status   │
                                        │ summary  │
                                        │ regress. │
                                        └──────────┘
```

**Key Design Properties:**

- All collections use `uuidv7` string IDs (not ObjectId)
- `tenantIsolationPlugin` enforces tenant scoping at the Mongoose layer
- Eval sets denormalize names (`_personaNames`, `_scenarioNames`, `_evaluatorNames`) for display
- Referential integrity is enforced at the application layer (409 on delete of referenced entity)
- Version tracking (`_v` field) enables entity versioning for reproducibility

### 3.2 Execution Layer (Restate + Pipeline Engine)

```
┌──────────────────────────────────────────────────────────────┐
│                    EvalRunWorkflow (Restate)                  │
│                                                              │
│  1. Load EvalSet + entities from MongoDB                     │
│  2. Preflight validation (7 checks)                          │
│  3. Build matrix: persona × scenario × variant               │
│  4. Fan-out RunEvalConversation (batched by maxConcurrency)  │
│  5. Fan-out JudgeConversation (conversation × evaluator)     │
│  6. AggregateEvalRun (statistics + regression)               │
│  7. Finalize (update EvalRun status)                         │
└──────────────────────────────────────────────────────────────┘

Services (Restate):
┌────────────────────────┐  ┌────────────────────────┐
│  RunEvalConversation   │  │   JudgeConversation    │
│  ────────────────────  │  │  ────────────────────  │
│  - Persona message gen │  │  - LLM Judge (R1 bias) │
│  - Agent turn via HTTP │  │  - Code Scorer (3)     │
│  - Milestone tracking  │  │  - Trajectory Scorer   │
│  - ClickHouse write    │  │  - Human Review queue  │
│  - Circuit breaker     │  │  - ClickHouse write    │
│  - Rate limiting       │  │  - Circuit breaker     │
└────────────────────────┘  └────────────────────────┘

┌────────────────────────┐  ┌────────────────────────┐
│   SimulatePersona      │  │   AggregateEvalRun     │
│  ────────────────────  │  │  ────────────────────  │
│  - LLM message gen     │  │  - Flush CH writers    │
│  - Adversarial support │  │  - Query scores from CH│
│  - END signal detect   │  │  - Mean, StdDev, CI    │
│                        │  │  - Pass@k, Pass^k      │
│                        │  │  - Regression detection │
│                        │  │  - Update MongoDB      │
└────────────────────────┘  └────────────────────────┘
```

### 3.3 Analytics Layer (ClickHouse)

```
┌─────────────────────────────────────────────────────────────┐
│                    ClickHouse Tables                         │
├────────────────────┬──────────────────┬─────────────────────┤
│ eval_conversations │  eval_scores     │ eval_production_    │
│                    │                  │ scores              │
│ run_id             │ run_id           │ session_id          │
│ persona_id         │ evaluator_id     │ agent_name          │
│ scenario_id        │ score            │ evaluator_name      │
│ variant_index      │ passed           │ score               │
│ conversation (gz)  │ reasoning (gz)   │ reasoning           │
│ trace_events (gz)  │ evidence (gz)    │ confidence          │
│ turn_count         │ confidence       │ timestamp           │
│ duration_ms        │ bias fields      │                     │
│ milestones_hit[]   │ trajectory fields│                     │
│ actual_agent_path[]│ human_review     │                     │
│ tool_call_count    │ judge_cost       │                     │
│ known_source       │ known_source     │ ttl_override_days   │
│ ttl_override_days  │ ttl_override_days│                     │
│ has_error          │ evaluator_version│                     │
│ persona_version    │                  │                     │
│ scenario_version   │                  │                     │
├────────────────────┴──────────────────┴─────────────────────┤
│ Partitioning: toYYYYMM(created_at)                          │
│ TTL: per-row tenant override, default 730 eval / 365 prod   │
│ Codec: ZSTD(1) for IDs, ZSTD(3) for large text, T64 for ints│
│ Indexes: bloom_filter on IDs, minmax on metrics, set on flags│
└─────────────────────────────────────────────────────────────┘

Materialized Views:
┌──────────────────────────┐  ┌────────────────────────────────┐
│ mv_eval_heatmap          │  │ mv_eval_run_evaluator_summary  │
│ ─────────────────────────│  │ ───────────────────────────────│
│ avg, var, min, max score │  │ avg, p5, p50, p95 score        │
│ by run×eval×persona×scen │  │ by run × evaluator             │
└──────────────────────────┘  └────────────────────────────────┘

┌──────────────────────────┐  ┌────────────────────────────────┐
│ mv_eval_score_trend      │  │ mv_eval_production_hourly      │
│ ─────────────────────────│  │ ───────────────────────────────│
│ daily avg by evaluator   │  │ hourly avg by eval × agent     │
└──────────────────────────┘  └────────────────────────────────┘
```

### 3.4 Studio Integration Layer

```
┌──────────────────────────────────────────────────────────────┐
│                    Studio (Next.js)                           │
│                                                              │
│  Zustand Store (evals-store.ts)                             │
│  ├── activeTab: 'personas'|'scenarios'|'evaluators'|...      │
│  ├── selectedRunId                                           │
│  ├── selectedCell (heatmap cell)                            │
│  └── compareBaselineId / compareCurrentId                    │
│                                                              │
│  SWR Hooks (useEvalData.ts)                                 │
│  ├── useEvalPersonas(projectId)                             │
│  ├── useEvalScenarios(projectId)                            │
│  ├── useEvalEvaluators(projectId)                           │
│  ├── useEvalSets(projectId)                                 │
│  ├── useEvalRuns(projectId)                                 │
│  ├── useEvalHeatMap(projectId, runId)                       │
│  ├── useEvalRunStatus(projectId, runId, isRunning)          │
│  └── useEvalComparison(projectId, baselineId, currentId)    │
│                                                              │
│  Repo (eval-repo.ts)                                        │
│  ├── findPersonasByProject / findScenariosByProject / ...   │
│  ├── create/update/delete operations                        │
│  ├── stripProtected (system field guard)                    │
│  ├── guardDeletion (referential integrity)                  │
│  └── resolveEvalSetNames (ID→name denormalization)          │
│                                                              │
│  API Routes: 22 routes under /api/projects/[id]/evals/      │
└──────────────────────────────────────────────────────────────┘
```

## 4. Twelve Architectural Concerns

### 4.1 Resource Isolation

- **Tenant:** Every MongoDB query includes `tenantId`. ClickHouse queries parameterize `tenant_id`.
- **Project:** All entities scoped to `projectId`. Routes under `/api/projects/:projectId/evals/`.
- **User:** `createdBy` tracked on all entities. Run `triggeredBy` records who started it.
- **Cross-scope:** Returns 404 (not 403) for cross-tenant/cross-project access.
- **Eval Sessions:** Prefixed with `eval-` to isolate from production sessions.

### 4.2 Authentication & Authorization

- **Studio Routes:** Use `requireProjectPermission` middleware from centralized auth.
- **Pipeline-to-Runtime:** Service JWT tokens generated via `createServiceToken(tenantId)`.
- **Preflight Validation:** `checkRuntimeAuth` verifies service JWT is accepted by Runtime.
- **Eval Mode Header:** `X-Eval-Mode: true` header distinguishes eval requests from production.

### 4.3 Data Model & Persistence

- **MongoDB:** 6 collections with Mongoose schemas, `tenantIsolationPlugin`, `uuidv7` IDs.
- **ClickHouse:** 3 tables + 4 MVs with partition-by-month, bloom filter indexes, TTL expiration.
- **Compression:** App-layer gzip for payloads > 1KB; ClickHouse ZSTD codec at storage layer.
- **Versioning:** `_v` field on all config entities for version tracking and reproducibility.
- **Name Denormalization:** Eval sets store `_personaNames` etc. for efficient display without joins.

### 4.4 Error Handling & Resilience

- **Circuit Breakers:** 3 breakers (persona LLM, judge LLM, agent executor) with configurable thresholds, ring buffer error context, and `EvalCircuitOpenError` with diagnostic information.
- **Rate Limiting:** Per-tenant LLM call limits, conversation slots, and run slots prevent resource exhaustion.
- **Preflight Validation:** 7 checks (encryption, env vars, Runtime health, ClickHouse access, LLM credentials, provider/key match, Runtime auth) gate all runs.
- **Restate Durability:** Workflow state persists across pod restarts; transient failures are automatically retried.
- **Diagnostic Summary:** Failed conversations are grouped by error pattern and persisted to EvalRun for Studio visibility.
- **Graceful Degradation:** Aggregation failure still marks run as failed (best-effort MongoDB update in catch block).

### 4.5 Observability

- **Metrics:** 20+ OpenTelemetry instruments across run lifecycle, conversations, persona simulation, judging, scoring, circuit breakers, rate limiting, and cost tracking.
- **Logging:** Structured logging via `createLogger('eval-*')` at all service boundaries.
- **Tracing:** Full trace events collected from agent execution and stored in ClickHouse.
- **Status Polling:** Real-time workflow state via Restate shared handler (`getStatus`).

### 4.6 Performance & Scalability

- **Batched Fan-out:** `maxConcurrency` (1-20) controls parallel conversation execution.
- **Buffered ClickHouse Writes:** Batch inserts reduce round-trips.
- **Materialized Views:** Pre-computed aggregations for heatmaps, trends, and evaluator summaries.
- **Smart Polling:** Client-side polling interval adapts based on run status (2s while running, 0 when terminal).
- **Payload Compression:** Gzip at app layer + ZSTD at storage layer minimizes I/O.

### 4.7 Security

- **Encryption Validation:** Preflight verifies `ENCRYPTION_MASTER_KEY` with AES-256-GCM round-trip test before any run.
- **Service Auth:** Pipeline engine authenticates to Runtime via service JWT, not user tokens.
- **Provider Key Validation:** Heuristic check that LLM API key format matches provider (e.g., `sk-ant-` for Anthropic).
- **No Secret Exposure:** Circuit breaker error context sanitizes IDs (`<id>` replacement) before logging.

### 4.8 Compliance & Data Lifecycle

- **Tenant Retention Contract:** Eval transcript and score retention is resolved from
  `Tenant.settings.evalRetention`, exposed through `/api/tenant/retention`, and shown in Studio
  Settings. Missing tenant settings fall back to 730 days for eval conversations/scores, 365 days
  for production scores, and 30 days for synthetic eval runs.
- **ClickHouse TTL:** Eval ClickHouse tables carry `ttl_override_days` per row and use a
  column-driven MergeTree TTL so tenant overrides are applied by ClickHouse at storage level.
  `known_source='synthetic'` rows use the synthetic TTL, which must be strictly shorter than normal
  eval retention.
- **Mongo Cleanup:** The Restate-backed workflow-engine retention sweep archives expired
  `EvalRun` metadata, strips drill-down fields, and preserves run summaries. Tenants can opt into
  hard delete with `evalRetention.hardDeleteExpiredRuns`.
- **Deletion Guard:** Referential integrity prevents orphaned references (409 on delete of referenced entity).
- **Audit Trail:** EvalRun tracks `triggeredBy`, `triggerSource`, timestamps, and full diagnostic summaries.
- **Data Minimization:** Conversation data is compressed and has TTL; no indefinite retention.

### 4.9 Extensibility

- **Pluggable Evaluators:** 4 evaluator types with extensible scorer registry (code_scorer `scorerName` switch).
- **Custom Judge Prompts:** `judgePrompt` field allows per-evaluator custom LLM prompts.
- **Configurable Bias Settings:** 4 bias mitigation techniques can be independently enabled/disabled per evaluator.
- **Template System:** Built-in persona and evaluator templates for bootstrapping.
- **AI Generation:** Endpoints for AI-powered persona and scenario generation from agent context.

### 4.10 Testing Strategy

- **Unit:** Pure function testing for trajectory scorers, aggregation math, prompt builders.
- **Integration:** Service boundary testing with real MongoDB, mock LLM for judge/persona.
- **E2E:** Full lifecycle through HTTP API with real infrastructure.
- **Zero-Cost CI:** Code scorers enable full pipeline testing without LLM calls.

### 4.11 Migration & Backward Compatibility

- **ClickHouse DDL:** All tables use `CREATE TABLE IF NOT EXISTS` for idempotent initialization.
- **Schema Evolution:** Mongoose schemas with default values for new fields; ClickHouse uses `DEFAULT` clauses.
- **Pipeline Metadata:** `evalPipelineDefinition` registered for discovery even when Restate is unavailable.
- **Versioned Snapshots:** Conversation and score records include `persona_version`, `scenario_version`, `evaluator_version` for reproducibility.

### 4.12 Cost Management

- **Cost Tracking:** Every LLM call records `tokensUsed`, `cost`, and `latencyMs`.
- **Run-Level Aggregation:** `summary.estimatedCost` and `summary.actualCost` tracked per run.
- **Rate Limiting:** Prevents runaway LLM costs from misconfigured eval sets.
- **Circuit Breakers:** Stop retrying failing LLM calls that waste budget.
- **Code Scorers:** Zero-cost alternative to LLM judges for measurable properties.
- **Metrics:** `eval.run.cost_usd`, `eval.judge.cost_usd`, `eval.persona.cost_usd` enable cost monitoring.

## 5. Data Flow Diagrams

### 5.1 Eval Run Execution Flow

```
User triggers run via Studio
    │
    ▼
POST /api/projects/:projectId/evals/runs/:runId/start
    │
    ▼
EvalRunWorkflow.run(tenantId, projectId, runId, evalSetId)
    │
    ├─ 1. Load EvalSet + entities from MongoDB
    │     └─ Validate: all persona/scenario/evaluator IDs exist
    │
    ├─ 2. Preflight validation
    │     ├─ checkEncryptionMasterKey()
    │     ├─ checkRequiredEnvVars()
    │     ├─ checkRuntimeReachable()
    │     ├─ checkClickHouse()
    │     ├─ checkLLMCredentials() [tenant-specific]
    │     ├─ checkProviderKeyMatch() [tenant-specific]
    │     └─ checkRuntimeAuth() [tenant-specific]
    │
    ├─ 3. Build matrix
    │     └─ persona × scenario × variant = N cells
    │
    ├─ 4. Fan-out conversations (batched by maxConcurrency)
    │     For each cell:
    │     ├─ Generate/use initial persona message
    │     ├─ Loop: persona message → agent turn → track milestones
    │     ├─ Write eval_conversations to ClickHouse
    │     └─ Return conversation + metrics
    │
    ├─ 5. Fan-out judging (batched by maxConcurrency)
    │     For each (conversation × evaluator):
    │     ├─ LLM Judge: rubric + bias mitigation
    │     ├─ Code Scorer: deterministic scoring
    │     ├─ Trajectory: milestone/handoff/path/tool scoring
    │     ├─ Human Review: queue for expert
    │     └─ Write eval_scores to ClickHouse
    │
    ├─ 6. Aggregate
    │     ├─ Flush ClickHouse writers
    │     ├─ Query scores
    │     ├─ Compute: mean, stdDev, 95% CI, Pass@k, Pass^k
    │     ├─ Regression detection vs baseline
    │     └─ Update EvalRun in MongoDB
    │
    └─ 7. Finalize
          └─ Set status: completed | failed
```

### 5.2 Score Heatmap Query Flow

```
Studio UI: useEvalHeatMap(projectId, runId)
    │
    ▼
GET /api/projects/:projectId/evals/runs/:runId/heatmap
    │
    ▼
Query mv_eval_heatmap_dest (Materialized View)
    WHERE tenant_id = :tenantId
    AND project_id = :projectId
    AND run_id = :runId
    │
    ▼
Return: Array<{
    personaId, scenarioId, evaluatorId,
    avgScore, count, variance, minScore, maxScore
}>
```

## 6. Alternatives Considered

| Decision Point     | Chosen                  | Alternative       | Why Not                                                                                                |
| ------------------ | ----------------------- | ----------------- | ------------------------------------------------------------------------------------------------------ |
| Config storage     | MongoDB                 | PostgreSQL        | MongoDB already in use; flexible schemas fit eval entity diversity                                     |
| Result storage     | ClickHouse              | MongoDB           | MongoDB lacks efficient columnar aggregation for heatmaps/trends at scale                              |
| Orchestration      | Restate                 | BullMQ            | Restate provides deterministic replay and durable state; BullMQ requires custom state management       |
| Persona simulation | LLM-based               | Scripted          | LLM produces more diverse and realistic conversations; adversarial testing needs generative capability |
| Bias mitigation    | Built-in (4 techniques) | Post-hoc analysis | Built-in mitigation is more actionable; post-hoc analysis adds latency to feedback loop                |
| Scoring system     | 4 evaluator types       | LLM-only          | Code scorers and trajectory analysis are deterministic and zero-cost; diversity improves coverage      |

## 7. Open Questions

| #   | Question                                                                        | Status | Impact                                                           |
| --- | ------------------------------------------------------------------------------- | ------ | ---------------------------------------------------------------- |
| 1   | How should production eval scoring be wired to the existing analytics pipeline? | Open   | Medium — production_scores table exists but no pipeline feeds it |
| 2   | What is the CI trigger mechanism for ciEnabled eval sets?                       | Open   | High — blocks deployment quality gates                           |
| 3   | Should eval results be exportable (JSON/CSV) for external analysis?             | Open   | Low — nice-to-have for advanced users                            |
| 4   | How should human review scores be reconciled back into run summaries?           | Open   | Medium — affects aggregate accuracy                              |
| 5   | Should there be an eval scheduling mechanism (cron/periodic)?                   | Open   | Medium — useful for continuous monitoring                        |

## 8. Revision History

| Date       | Author        | Change                                       |
| ---------- | ------------- | -------------------------------------------- |
| 2026-03-22 | SDLC Pipeline | Initial HLD generated from codebase analysis |

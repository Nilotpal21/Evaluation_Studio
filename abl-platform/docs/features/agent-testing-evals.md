# Feature Spec: Agent Testing & Evals

**Status:** BETA
**Feature Slug:** `agent-testing-evals`
**Owner:** Platform Team
**Last Updated:** 2026-04-15

---

## 1. Problem Statement

Agent developers building on ABL Platform lack a systematic, automated way to validate agent quality before and after deployment. Manual testing is ad-hoc, unrepeatable, and cannot scale across the persona-scenario-evaluator matrix needed for multi-agent systems. Without automated regression detection, agent changes (DSL updates, model swaps, prompt edits) can silently degrade quality, costing organizations through undetected hallucinations, broken handoff paths, and poor user experiences.

**Who it affects:** Agent developers, QA teams, project managers, DevOps/CI pipelines.

**Current pain:** No built-in test infrastructure means teams resort to manual conversation testing, spreadsheet-based scoring, and hope-driven deployments.

## 2. Goals & Non-Goals

### Goals

- **G1:** Provide a complete evaluation framework: define personas, scenarios, evaluators, and compose them into reusable eval sets.
- **G2:** Execute evaluation runs as a persona x scenario x variant matrix with full conversation simulation against the live Runtime.
- **G3:** Score conversations via 4 evaluator types: LLM judge (with bias mitigation), code-based scorers, trajectory analysis, and human review queuing.
- **G4:** Detect quality regressions by comparing run results against baseline runs with configurable thresholds.
- **G5:** Persist all eval data (conversations, scores, trajectory metrics) to ClickHouse for analytics, with materialized views for heatmaps and trend analysis.
- **G6:** Expose Studio UI for managing eval entities, triggering runs, viewing heatmaps, and comparing runs.
- **G7:** Provide production eval scoring for live sessions (eval_production_scores table).
- **G8:** Support CI/CD integration via eval sets with `ciEnabled` flag for automated quality gates.

### Non-Goals

- **NG1:** Real-time production traffic sampling and scoring (production evals are post-hoc).
- **NG2:** A/B testing framework for live traffic splitting between agent versions.
- **NG3:** Custom LLM fine-tuning based on eval results.
- **NG4:** Multi-tenant cross-project eval comparison (evals are project-scoped).

## 3. User Stories

| ID    | As a...         | I want to...                                                                     | So that...                                      | Priority |
| ----- | --------------- | -------------------------------------------------------------------------------- | ----------------------------------------------- | -------- |
| US-1  | Agent Developer | Define test personas with communication styles, goals, and adversarial behaviors | I can simulate realistic user interactions      | P0       |
| US-2  | Agent Developer | Define test scenarios with entry agents, expected milestones, and agent paths    | I can validate specific conversation flows      | P0       |
| US-3  | Agent Developer | Configure evaluators with scoring rubrics, bias settings, and judge prompts      | I can measure agent quality objectively         | P0       |
| US-4  | Agent Developer | Compose personas, scenarios, and evaluators into eval sets                       | I can run the full evaluation matrix            | P0       |
| US-5  | Agent Developer | Trigger an eval run and see real-time progress                                   | I know how far along the evaluation is          | P0       |
| US-6  | QA Engineer     | View heatmap of scores by persona x scenario x evaluator                         | I can identify weak spots in agent behavior     | P0       |
| US-7  | QA Engineer     | Compare two eval runs side-by-side                                               | I can see the impact of agent changes           | P1       |
| US-8  | Agent Developer | Set a baseline run and detect regressions automatically                          | I get alerted when quality drops                | P1       |
| US-9  | DevOps Engineer | Enable CI evaluation on an eval set                                              | Quality gates block bad deployments             | P1       |
| US-10 | Agent Developer | Auto-generate personas and scenarios from agent DSL                              | I can bootstrap test suites quickly             | P2       |
| US-11 | QA Engineer     | Queue low-confidence scores for human review                                     | Uncertain judgments get expert validation       | P2       |
| US-12 | Agent Developer | Use built-in persona and evaluator templates                                     | I can start testing without deep eval expertise | P1       |
| US-13 | Agent Developer | Run a quick evaluation without setting up a full eval set                        | I can rapidly validate during development       | P2       |

## 4. Requirements

### Functional Requirements

| ID    | Requirement                                                                                                                                                  | Priority | Status      |
| ----- | ------------------------------------------------------------------------------------------------------------------------------------------------------------ | -------- | ----------- |
| FR-1  | CRUD API for eval personas (MongoDB, tenant+project scoped, uuidv7 IDs)                                                                                      | P0       | Implemented |
| FR-2  | CRUD API for eval scenarios (entry agent, milestones, agent path, max turns)                                                                                 | P0       | Implemented |
| FR-3  | CRUD API for eval evaluators (4 types: llm_judge, code_scorer, trajectory, human_review)                                                                     | P0       | Implemented |
| FR-4  | CRUD API for eval sets (composition of persona/scenario/evaluator IDs + variants + concurrency)                                                              | P0       | Implemented |
| FR-5  | Eval run creation, triggering, cancellation via API                                                                                                          | P0       | Implemented |
| FR-6  | EvalRunWorkflow: Restate durable workflow for persona x scenario x variant matrix fan-out                                                                    | P0       | Implemented |
| FR-7  | RunEvalConversation: multi-turn conversation loop via Runtime HTTP API with session isolation                                                                | P0       | Implemented |
| FR-8  | JudgeConversation: 4 evaluator types with R1 bias mitigation (position swap, blind eval, evidence-first)                                                     | P0       | Implemented |
| FR-9  | AggregateEvalRun: statistical aggregation (mean, stdDev, 95% CI, Pass@k, Pass^k) + regression detection                                                      | P0       | Implemented |
| FR-10 | ClickHouse tables: eval_conversations, eval_scores, eval_production_scores with TTL + bloom filters                                                          | P0       | Implemented |
| FR-11 | Materialized views: mv_eval_heatmap, mv_eval_run_evaluator_summary, mv_eval_score_trend, mv_eval_production_hourly                                           | P0       | Implemented |
| FR-12 | Eval preflight validation (encryption key, env vars, Runtime reachable, ClickHouse, LLM credentials, provider/key match)                                     | P0       | Implemented |
| FR-13 | Circuit breakers for persona LLM, judge LLM, and agent executor with ring buffer error context                                                               | P0       | Implemented |
| FR-14 | Rate limiting: LLM calls per tenant, conversation slots per tenant, run slots per tenant                                                                     | P0       | Implemented |
| FR-15 | OpenTelemetry metrics: 20+ instruments across run lifecycle, conversations, judging, cost tracking                                                           | P0       | Implemented |
| FR-16 | Trajectory scoring: milestone completion, handoff correctness (LCS), path efficiency, tool sequence                                                          | P0       | Implemented |
| FR-17 | Persona simulation prompts with adversarial persona types (prompt_injection, social_engineering, off_topic, abusive, edge_case)                              | P0       | Implemented |
| FR-18 | Studio eval hooks (SWR): useEvalPersonas, useEvalScenarios, useEvalEvaluators, useEvalSets, useEvalRuns, useEvalHeatMap, useEvalRunStatus, useEvalComparison | P0       | Implemented |
| FR-19 | Studio eval store (Zustand): active tab, selected run, selected cell, comparison pair                                                                        | P0       | Implemented |
| FR-20 | Studio eval repo: data access layer with tenant/project scoping, reference-checking on delete, name resolution for eval sets                                 | P0       | Implemented |
| FR-21 | Studio API routes: 21 Next.js API routes covering CRUD, run management, heatmap, comparison, preflight, quick eval, templates, and AI generation             | P0       | Implemented |
| FR-22 | Persona and evaluator template APIs for bootstrapping                                                                                                        | P1       | Implemented |
| FR-23 | AI-powered persona and scenario generation from agent context                                                                                                | P2       | Implemented |
| FR-24 | Eval data compression (gzip for payloads > 1KB) in ClickHouse writes                                                                                         | P0       | Implemented |
| FR-25 | Human review queuing via EvalHumanReview MongoDB model                                                                                                       | P2       | Implemented |
| FR-26 | Run status polling endpoint with smart refresh intervals                                                                                                     | P0       | Implemented |
| FR-27 | Referential integrity: prevent deletion of personas/scenarios/evaluators referenced by eval sets (409 Conflict)                                              | P0       | Implemented |

### Non-Functional Requirements

| ID    | Requirement                                                                                | Target      |
| ----- | ------------------------------------------------------------------------------------------ | ----------- |
| NFR-1 | Eval run matrix of 10 personas x 10 scenarios x 3 variants completes within 30 minutes     | < 30 min    |
| NFR-2 | Circuit breaker opens after 5 LLM failures within 60s window, resets after 30s             | Configured  |
| NFR-3 | ClickHouse eval data TTL: 730 days (2 years) for test data, 365 days for production scores | Configured  |
| NFR-4 | Buffered ClickHouse writes batch inserts for throughput                                    | Implemented |
| NFR-5 | Conversation payloads > 1KB are gzip compressed before ClickHouse storage                  | Implemented |
| NFR-6 | Max concurrency per eval set is configurable (1-20, default 5)                             | Configured  |
| NFR-7 | All eval queries are tenant+project scoped (resource isolation)                            | Enforced    |
| NFR-8 | Eval sessions are prefixed with "eval-" to distinguish from production                     | Implemented |

## 5. Architecture Overview

### Data Model

**MongoDB Collections (Configuration):**

- `eval_personas` — User simulation profiles (communication style, domain knowledge, goals, adversarial type)
- `eval_scenarios` — Test case definitions (entry agent, expected milestones, agent path, max turns)
- `eval_evaluators` — Scoring configurations (4 types: llm_judge, code_scorer, trajectory, human_review)
- `eval_sets` — Composed test suites (persona IDs + scenario IDs + evaluator IDs + variants + concurrency)
- `eval_runs` — Execution records (status, summary, regression detection, diagnostic summary)
- `eval_human_reviews` — Queued low-confidence scores for human validation

**ClickHouse Tables (Execution Data):**

- `eval_conversations` — Full conversation logs with trajectory data, compressed
- `eval_scores` — Individual score records with bias mitigation data
- `eval_production_scores` — Live session evaluation scores

**ClickHouse Materialized Views:**

- `mv_eval_heatmap_dest` — Pre-aggregated persona x scenario x evaluator scores
- `mv_eval_run_evaluator_summary_dest` — Per-run evaluator-level statistics
- `mv_eval_score_trend_dest` — Daily score trends per evaluator
- `mv_eval_production_hourly_dest` — Hourly production eval aggregates

### Execution Flow

```
Studio UI / CI Trigger
  └→ POST /api/projects/:projectId/evals/runs/:runId/start
       └→ EvalRunWorkflow (Restate durable workflow)
            ├→ 1. Load EvalSet + referenced entities from MongoDB
            ├→ 2. Preflight validation (encryption, LLM creds, Runtime health, ClickHouse)
            ├→ 3. Build persona x scenario x variant matrix
            ├→ 4. Fan-out RunEvalConversation (batched by maxConcurrency)
            │    ├→ Generate persona messages (LLM)
            │    ├→ Execute agent turns (Runtime HTTP API)
            │    ├→ Track milestones, agent path, tool calls
            │    └→ Write conversation record to ClickHouse
            ├→ 5. Fan-out JudgeConversation (conversation x evaluator)
            │    ├→ LLM Judge: structured rubric + R1 bias mitigation
            │    ├→ Code Scorer: deterministic built-in scorers
            │    ├→ Trajectory: milestone/handoff/path/tool scoring
            │    ├→ Human Review: queue for expert validation
            │    └→ Write score record to ClickHouse
            ├→ 6. AggregateEvalRun: compute summary + regression detection
            └→ 7. Update EvalRun document with results
```

### Studio Integration

- **Store:** `evals-store.ts` — Zustand with persist middleware for active tab state
- **Hooks:** `useEvalData.ts` — 8 SWR hooks with smart polling for running evals
- **Repo:** `eval-repo.ts` — Data access layer with referential integrity guards
- **API Routes:** 22 Next.js API routes under `/api/projects/[id]/evals/`

### Resilience

- **Circuit Breakers:** 3 breakers (persona LLM, judge LLM, agent executor) with configurable thresholds
- **Rate Limiting:** Per-tenant LLM call limits, conversation slot limits, run slot limits
- **Preflight:** 7 checks before any run starts (encryption, env vars, Runtime, ClickHouse, LLM creds, provider/key match, Runtime auth)
- **Durable Execution:** Restate workflow survives pod restarts, retries transient failures

## 6. Key Entities & Data Flow

### Entity Relationships

```
EvalPersona (N) ──┐
                   ├──→ EvalSet ──→ EvalRun ──→ EvalRunWorkflow
EvalScenario (N) ──┤                                │
                   │                    ┌────────────┴──────────┐
EvalEvaluator (N) ─┘                    │                       │
                              RunEvalConversation      JudgeConversation
                              (persona x scenario)     (conversation x evaluator)
                                      │                        │
                                      ▼                        ▼
                              eval_conversations         eval_scores
                              (ClickHouse)              (ClickHouse)
                                                              │
                                                              ▼
                                                     AggregateEvalRun
                                                     (summary + regression)
```

### Evaluator Types

| Type           | Description                                                                                                       | Cost       | Latency |
| -------------- | ----------------------------------------------------------------------------------------------------------------- | ---------- | ------- |
| `llm_judge`    | LLM-based scoring with structured rubric, supports R1 bias mitigation (position swap, blind eval, evidence-first) | LLM tokens | 2-10s   |
| `code_scorer`  | Deterministic built-in scorers (toolSuccessScorer, responseLengthScorer, errorFreeScorer)                         | Zero       | < 1ms   |
| `trajectory`   | Milestone completion, handoff correctness (LCS), path efficiency, tool sequence scoring                           | Zero       | < 1ms   |
| `human_review` | Queue for human expert validation, scored as pending until reviewed                                               | Zero       | Async   |

### Bias Mitigation (R1)

| Technique               | Description                                                                            |
| ----------------------- | -------------------------------------------------------------------------------------- |
| Position Swap           | Run judge twice with conversation order reversed, average scores. Warns on delta > 1.0 |
| Blind Evaluation        | Strip model/agent attribution from transcript (Speaker A/B instead of Customer/Agent)  |
| Evidence-First (RULERS) | Force judge to extract evidence before scoring to reduce anchoring bias                |
| Cross-Model Judge       | Use different model family for judging (configurable)                                  |

### Trajectory Scoring (R5)

| Metric               | Computation                                                      | Range |
| -------------------- | ---------------------------------------------------------------- | ----- |
| Milestone Completion | % of expected milestones hit (set intersection)                  | 0-1   |
| Handoff Correctness  | Longest common subsequence of actual vs expected agent path      | 0-1   |
| Path Efficiency      | expected path length / actual path length (capped at 1.0)        | 0-1   |
| Tool Sequence        | Tool calls within threshold (maxToolCalls or 2x turns heuristic) | 0-1   |

## 7. API Surface

### Studio API Routes (Next.js)

| Route                                               | Methods          | Description                   |
| --------------------------------------------------- | ---------------- | ----------------------------- |
| `/api/projects/[id]/evals/personas`                 | GET, POST        | List/create personas          |
| `/api/projects/[id]/evals/personas/[personaId]`     | GET, PUT, DELETE | Single persona CRUD           |
| `/api/projects/[id]/evals/personas/templates`       | GET              | Built-in persona templates    |
| `/api/projects/[id]/evals/scenarios`                | GET, POST        | List/create scenarios         |
| `/api/projects/[id]/evals/scenarios/[scenarioId]`   | GET, PUT, DELETE | Single scenario CRUD          |
| `/api/projects/[id]/evals/evaluators`               | GET, POST        | List/create evaluators        |
| `/api/projects/[id]/evals/evaluators/[evaluatorId]` | GET, PUT, DELETE | Single evaluator CRUD         |
| `/api/projects/[id]/evals/evaluators/templates`     | GET              | Built-in evaluator templates  |
| `/api/projects/[id]/evals/sets`                     | GET, POST        | List/create eval sets         |
| `/api/projects/[id]/evals/sets/[setId]`             | GET, PUT, DELETE | Single eval set CRUD          |
| `/api/projects/[id]/evals/runs`                     | GET, POST        | List/create runs              |
| `/api/projects/[id]/evals/runs/[runId]`             | GET              | Run detail                    |
| `/api/projects/[id]/evals/runs/[runId]/start`       | POST             | Trigger run execution         |
| `/api/projects/[id]/evals/runs/[runId]/cancel`      | POST             | Cancel running eval           |
| `/api/projects/[id]/evals/runs/[runId]/status`      | GET              | Poll run status               |
| `/api/projects/[id]/evals/runs/[runId]/heatmap`     | GET              | Score heatmap data            |
| `/api/projects/[id]/evals/runs/compare`             | GET              | Compare two runs              |
| `/api/projects/[id]/evals/preflight`                | GET              | Run preflight checks          |
| `/api/projects/[id]/evals/quick`                    | POST             | Quick eval without full setup |
| `/api/projects/[id]/evals/generate/personas`        | POST             | AI-generate personas          |
| `/api/projects/[id]/evals/generate/scenarios`       | POST             | AI-generate scenarios         |

### Pipeline Engine Services (Restate)

| Service               | Handler     | Description                                                             |
| --------------------- | ----------- | ----------------------------------------------------------------------- |
| `EvalRunWorkflow`     | `run`       | Orchestrate full eval run (fan-out conversations, judging, aggregation) |
| `EvalRunWorkflow`     | `getStatus` | Shared handler for real-time status polling                             |
| `RunEvalConversation` | `execute`   | Execute single persona-agent conversation loop                          |
| `JudgeConversation`   | `execute`   | Score a conversation using specified evaluator                          |
| `AggregateEvalRun`    | `execute`   | Compute run-level statistics and regression detection                   |
| `SimulatePersona`     | `execute`   | Generate persona message for next conversation turn                     |

## 8. Observability

### OpenTelemetry Metrics (Meter: `abl-eval`)

| Category           | Metrics                                                                                                                                            | Type                   |
| ------------------ | -------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------- |
| Run Lifecycle      | `eval.run.started`, `eval.run.completed`, `eval.run.failed`, `eval.run.duration_ms`                                                                | Counter, Histogram     |
| Conversations      | `eval.conversation.started`, `eval.conversation.completed`, `eval.conversation.failed`, `eval.conversation.duration_ms`, `eval.conversation.turns` | Counter, Histogram     |
| Persona Simulation | `eval.persona.started`, `eval.persona.completed`, `eval.persona.failed`, `eval.persona.duration_ms`, `eval.persona.cost_usd`                       | Counter, Histogram     |
| Judging            | `eval.judge.started`, `eval.judge.completed`, `eval.judge.failed`, `eval.judge.duration_ms`, `eval.judge.tokens_used`, `eval.judge.cost_usd`       | Counter, Histogram     |
| Scores             | `eval.score.value`, `eval.regression.detected`                                                                                                     | Histogram, Counter     |
| Circuit Breakers   | `eval.circuit_breaker.opened`                                                                                                                      | Counter                |
| Rate Limiting      | `eval.rate_limit.rejected`, `eval.rate_limit.queue_depth`                                                                                          | Counter, UpDownCounter |
| Active State       | `eval.active_runs`, `eval.active_conversations`, `eval.active_judge_calls`                                                                         | UpDownCounter          |

## 9. Security & Isolation

- **Tenant Isolation:** All MongoDB queries include `tenantId`. All ClickHouse queries filter by `tenant_id`.
- **Project Isolation:** All eval entities are scoped to `projectId`. Routes are under `/api/projects/:projectId/evals/`.
- **Auth:** Studio API routes use `requireProjectPermission`. Pipeline-to-Runtime auth uses service JWT tokens via `createServiceToken()`.
- **Eval Session Isolation:** Each eval conversation gets a fresh Runtime session prefixed with `eval-` to prevent state leakage.
- **Data Encryption:** Preflight validates `ENCRYPTION_MASTER_KEY` with AES-256-GCM round-trip test.
- **Cross-scope Access:** Returns 404 (not 403) to avoid resource existence leaking.

## 10. Performance

- **Batched Fan-out:** Conversations execute in batches of `maxConcurrency` (default 5, max 20) to bound resource usage.
- **ClickHouse Compression:** Conversation payloads and trace events are gzip-compressed at the application layer before storage (ZSTD codec at ClickHouse layer).
- **Buffered Writes:** ClickHouse inserts are batched via buffered writers for throughput.
- **Materialized Views:** Heatmap, evaluator summary, score trend, and production hourly aggregations are pre-computed by ClickHouse MVs.
- **Smart Polling:** Studio `useEvalRunStatus` hook polls every 2s while running, stops on terminal status.

## 11. Key Implementation Files

### Pipeline Engine (Eval Services)

| File                                                                                   | Description                                         |
| -------------------------------------------------------------------------------------- | --------------------------------------------------- |
| `packages/pipeline-engine/src/pipeline/services/eval/aggregate-eval-run.service.ts`    | Run-level statistical aggregation + regression      |
| `packages/pipeline-engine/src/pipeline/services/eval/eval-alerts.ts`                   | Eval alerting hooks                                 |
| `packages/pipeline-engine/src/pipeline/services/eval/eval-auth.ts`                     | Service JWT creation for eval-to-Runtime auth       |
| `packages/pipeline-engine/src/pipeline/services/eval/eval-circuit-breakers.ts`         | Circuit breakers (persona LLM, judge LLM, executor) |
| `packages/pipeline-engine/src/pipeline/services/eval/eval-clickhouse-writers.ts`       | Buffered ClickHouse writes for conversations/scores |
| `packages/pipeline-engine/src/pipeline/services/eval/eval-compression.ts`              | Gzip compression for payloads > 1KB                 |
| `packages/pipeline-engine/src/pipeline/services/eval/eval-logger.ts`                   | Eval-scoped logger                                  |
| `packages/pipeline-engine/src/pipeline/services/eval/eval-metrics.ts`                  | OpenTelemetry metrics (20+ instruments)             |
| `packages/pipeline-engine/src/pipeline/services/eval/eval-preflight.ts`                | 7-check preflight validation                        |
| `packages/pipeline-engine/src/pipeline/services/eval/eval-preflight.service.ts`        | Preflight Restate service handler                   |
| `packages/pipeline-engine/src/pipeline/services/eval/eval-rate-limiter.ts`             | Per-tenant LLM/conversation/run rate limits         |
| `packages/pipeline-engine/src/pipeline/services/eval/eval-types.ts`                    | Shared eval type definitions                        |
| `packages/pipeline-engine/src/pipeline/services/eval/execute-agent-turn.service.ts`    | Single agent turn execution via Runtime HTTP API    |
| `packages/pipeline-engine/src/pipeline/services/eval/judge-conversation.service.ts`    | 4-type evaluator scoring + R1 bias mitigation       |
| `packages/pipeline-engine/src/pipeline/services/eval/run-eval-conversation.service.ts` | Multi-turn conversation loop with session isolation |
| `packages/pipeline-engine/src/pipeline/services/eval/simulate-persona.service.ts`      | Persona LLM message generation                      |
| `packages/pipeline-engine/src/pipeline/services/eval/trajectory-scorers.ts`            | Milestone, handoff, path, tool sequence scorers     |
| `packages/pipeline-engine/src/pipeline/handlers/eval-run.workflow.ts`                  | Restate durable workflow orchestrator               |
| `packages/pipeline-engine/src/pipeline/schemas/init-eval-tables.ts`                    | ClickHouse DDL (tables + materialized views)        |
| `packages/pipeline-engine/src/pipeline/prompts/evaluation.prompts.ts`                  | Persona simulation + judge prompt builders          |
| `packages/pipeline-engine/src/pipeline/definitions/eval-pipeline.ts`                   | Eval pipeline metadata registration                 |

### Database Models

| File                                                        | Description                  |
| ----------------------------------------------------------- | ---------------------------- |
| `packages/database/src/models/eval-persona.model.ts`        | EvalPersona Mongoose model   |
| `packages/database/src/models/eval-scenario.model.ts`       | EvalScenario Mongoose model  |
| `packages/database/src/models/eval-evaluator.model.ts`      | EvalEvaluator Mongoose model |
| `packages/database/src/models/eval-set.model.ts`            | EvalSet Mongoose model       |
| `packages/database/src/models/eval-run.model.ts`            | EvalRun Mongoose model       |
| `packages/database/src/models/eval-human-review.model.ts`   | EvalHumanReview model        |
| `packages/database/src/constants/eval-limits.ts`            | Eval constants and limits    |
| `packages/database/src/templates/eval-persona-templates.ts` | Built-in persona templates   |
| `packages/database/src/templates/eval-rubric-templates.ts`  | Built-in rubric templates    |

### Eventstore (Production Evaluation Pipeline)

| File                                                                   | Description                                       |
| ---------------------------------------------------------------------- | ------------------------------------------------- |
| `packages/eventstore/src/evaluation/evaluation-dispatcher.ts`          | Async eval dispatcher (session.ended -> evaluate) |
| `packages/eventstore/src/evaluation/evaluators/llm-judge-evaluator.ts` | LLM-as-Judge evaluator with criteria rubrics      |
| `packages/eventstore/src/schema/events/evaluation-events.ts`           | Evaluation event schema definitions               |

### Studio (UI + API)

| File                                                                       | Description                                  |
| -------------------------------------------------------------------------- | -------------------------------------------- |
| `apps/studio/src/repos/eval-repo.ts`                                       | Data access layer with referential integrity |
| `apps/studio/src/hooks/useEvalData.ts`                                     | 8 SWR hooks for eval data fetching           |
| `apps/studio/src/store/evals-store.ts`                                     | Zustand store (tabs, selection, comparison)  |
| `apps/studio/src/components/evals/EvalsPage.tsx`                           | Main evals page component                    |
| `apps/studio/src/components/evals/EvalPreflightPanel.tsx`                  | Preflight status panel                       |
| `apps/studio/src/components/evals/tabs/PersonasTab.tsx`                    | Personas management tab                      |
| `apps/studio/src/components/evals/tabs/ScenariosTab.tsx`                   | Scenarios management tab                     |
| `apps/studio/src/components/evals/tabs/EvaluatorsTab.tsx`                  | Evaluators management tab                    |
| `apps/studio/src/components/evals/tabs/EvalSetsTab.tsx`                    | Eval sets management tab                     |
| `apps/studio/src/components/evals/tabs/RunsTab.tsx`                        | Runs management + status tab                 |
| `apps/studio/src/components/evals/heatmap/HeatMap.tsx`                     | Score heatmap visualization                  |
| `apps/studio/src/components/evals/heatmap/HeatMapCell.tsx`                 | Individual heatmap cell                      |
| `apps/studio/src/components/evals/heatmap/HeatMapLegend.tsx`               | Heatmap color legend                         |
| `apps/studio/src/components/evals/heatmap/ScoreDetail.tsx`                 | Detailed score drill-down                    |
| `apps/studio/src/components/evals/comparison/RunComparison.tsx`            | Side-by-side run comparison                  |
| `apps/studio/src/components/evals/comparison/ScoreTrend.tsx`               | Score trend chart                            |
| `apps/studio/src/components/evals/shared/QuickEvalButton.tsx`              | Quick eval trigger                           |
| `apps/studio/src/components/evals/shared/EvalSuggestionToast.tsx`          | Eval suggestion notification                 |
| `apps/studio/src/components/evals/shared/BiasSettingsPanel.tsx`            | Bias mitigation settings                     |
| `apps/studio/src/components/evals/shared/RubricBuilder.tsx`                | Evaluator rubric builder                     |
| `apps/studio/src/components/evals/shared/StatisticalSummary.tsx`           | Run statistics summary                       |
| `apps/studio/src/components/evals/shared/EvalBadge.tsx`                    | Score/status badges                          |
| `apps/studio/src/components/evals/shared/CostEstimate.tsx`                 | Cost estimation display                      |
| `apps/studio/src/components/evals/dialogs/CreatePersonaDialog.tsx`         | Persona creation dialog                      |
| `apps/studio/src/components/evals/dialogs/CreateScenarioDialog.tsx`        | Scenario creation dialog                     |
| `apps/studio/src/components/evals/dialogs/CreateEvaluatorDialog.tsx`       | Evaluator creation dialog                    |
| `apps/studio/src/components/evals/dialogs/CreateEvalSetDialog.tsx`         | Eval set creation dialog                     |
| `apps/studio/src/components/evals/dialogs/StartRunDialog.tsx`              | Start run dialog                             |
| 21 Next.js API routes under `apps/studio/src/app/api/projects/[id]/evals/` | See §7 API Surface for full list             |

### Project I/O (Export/Import)

| File                                                                       | Description                               |
| -------------------------------------------------------------------------- | ----------------------------------------- |
| `packages/project-io/src/export/layer-assemblers/evals-assembler.ts`       | Export eval entities to portable format   |
| `packages/project-io/src/import/layer-disassemblers/evals-disassembler.ts` | Import eval entities from portable format |

## 12. Known Gaps & Future Work

### Open Gaps

| Gap                      | Priority | Description                                                                                                                       |
| ------------------------ | -------- | --------------------------------------------------------------------------------------------------------------------------------- |
| E2E Tests                | P0       | No end-to-end tests exercising the full eval pipeline through HTTP API                                                            |
| Integration Tests        | P0       | Limited integration tests (eval-preflight, circuit-breakers only in pipeline-engine)                                              |
| Production Eval Pipeline | P1       | `eval_production_scores` table exists but no production scoring pipeline is wired                                                 |
| Human Review UI          | P2       | `EvalHumanReview` model exists but no Studio UI for reviewing/scoring                                                             |
| CI/CD Integration        | P1       | `ciEnabled` flag on eval sets exists but no CI trigger mechanism is implemented                                                   |
| Custom Code Scorers      | P2       | Only 5 built-in code scorers (turnEfficiency, repetition, errorOutcome, toolSuccess, containment); no user-defined scorer support |
| Cost Estimation          | P1       | `estimatedCostPerRun` field exists on EvalSet but no cost estimation logic is implemented                                         |
| Pagination               | P1       | All list queries use a hardcoded limit of 50 (`EVAL_LIST_DEFAULT_PAGE_SIZE`) with no cursor pagination                            |

### Mitigated Gaps

| Gap                  | Resolution                                                                                                                                                                                   |
| -------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Studio UI Components | Fully implemented: 5 tab components, 5 dialog components, 4 heatmap components, 2 comparison components, 7 shared components under `apps/studio/src/components/evals/` (23 total components) |
| Eval Export/Import   | Implemented via `packages/project-io/`: `evals-assembler.ts` (export) and `evals-disassembler.ts` (import) with test coverage in `evals-assembler.test.ts`                                   |

## 13. Dependencies

| Dependency       | Type           | Description                                                                         |
| ---------------- | -------------- | ----------------------------------------------------------------------------------- |
| Restate          | Infrastructure | Durable workflow engine for eval run orchestration                                  |
| ClickHouse       | Infrastructure | Columnar store for eval conversations, scores, and materialized views               |
| MongoDB          | Infrastructure | Configuration store for eval entities (personas, scenarios, evaluators, sets, runs) |
| Runtime HTTP API | Service        | Agent execution endpoint (`/api/v1/chat/agent`) for conversation simulation         |
| LLM Provider     | External       | Model inference for persona simulation and LLM judge scoring                        |
| OpenTelemetry    | Library        | Metrics instrumentation for observability                                           |

## 14. Risks & Mitigations

| Risk                                        | Impact | Mitigation                                                                                                 |
| ------------------------------------------- | ------ | ---------------------------------------------------------------------------------------------------------- |
| LLM cost explosion in large eval matrices   | High   | Rate limiting per tenant, maxConcurrency cap, circuit breakers, cost tracking metrics                      |
| Restate unavailability blocks all eval runs | High   | Preflight checks verify connectivity; eval pipeline metadata registered for discovery even without Restate |
| ClickHouse downtime loses eval results      | Medium | Buffered writers with flush-on-failure; MongoDB EvalRun status updated as fallback                         |
| Position swap doubles LLM cost              | Medium | Position swap is opt-in per evaluator, cost is tracked in `judge_cost` metric                              |
| Stale eval data accumulates                 | Low    | TTL-based expiration (730 days for test data, 365 days for production scores)                              |

## 15. Success Metrics

| Metric                                  | Target                     | Measurement                                                   |
| --------------------------------------- | -------------------------- | ------------------------------------------------------------- |
| Eval runs completed successfully        | > 95%                      | `eval.run.completed / (eval.run.completed + eval.run.failed)` |
| Mean eval run duration (10x10x3 matrix) | < 30 min                   | `eval.run.duration_ms` P50                                    |
| Score variance across variants          | < 0.5 stdDev               | `eval_scores` query                                           |
| Regression detection accuracy           | > 90% (no false negatives) | Manual audit of flagged regressions                           |
| Studio eval page load time              | < 2s                       | SWR cache + API response time                                 |

## 16. Glossary

| Term               | Definition                                                                                                            |
| ------------------ | --------------------------------------------------------------------------------------------------------------------- |
| Persona            | A simulated user profile with communication style, domain knowledge, goals, and optional adversarial behavior         |
| Scenario           | A test case definition with entry agent, expected milestones, agent path, and max turns                               |
| Evaluator          | A scoring configuration that judges conversation quality (LLM judge, code scorer, trajectory, or human review)        |
| Eval Set           | A composition of persona IDs, scenario IDs, and evaluator IDs that defines the evaluation matrix                      |
| Eval Run           | A single execution of an eval set producing conversation records and scores                                           |
| Variant            | A repeated execution of the same persona-scenario pair for statistical confidence                                     |
| Bias Mitigation    | Techniques to reduce scoring bias: position swap, blind evaluation, evidence-first, cross-model judge                 |
| Trajectory Scoring | Scoring based on conversation path metrics: milestone completion, handoff correctness, path efficiency, tool sequence |
| Pass@k             | Probability that at least 1 of k variants passes: 1 - (1-passRate)^k                                                  |
| Pass^k             | Probability that ALL k variants pass: passRate^k                                                                      |
| Preflight          | Pre-run validation that checks all integration points before executing an eval                                        |
| Circuit Breaker    | Resilience pattern that stops calling a failing dependency after threshold failures                                   |

## 17. Testing Status

### Test Files

| Test File                                                                    | Package         | Type | Tests | Coverage Area                                            |
| ---------------------------------------------------------------------------- | --------------- | ---- | ----- | -------------------------------------------------------- |
| `packages/pipeline-engine/src/__tests__/eval-preflight.test.ts`              | pipeline-engine | Unit | 8     | Preflight encryption, env vars, overall status           |
| `packages/pipeline-engine/src/__tests__/eval-circuit-breaker-errors.test.ts` | pipeline-engine | Unit | 12    | Circuit breaker states, error context, auth contract     |
| `packages/eventstore/src/__tests__/evaluation-code-scorer.test.ts`           | eventstore      | Unit | 24    | 5 built-in code scorers + CodeScorerEvaluator class      |
| `packages/eventstore/src/__tests__/evaluation-llm-judge.test.ts`             | eventstore      | Unit | ~10   | LLM judge evaluator, criteria, structured output parsing |
| `packages/eventstore/src/__tests__/evaluation-dispatcher.test.ts`            | eventstore      | Unit | ~20   | Evaluation dispatcher orchestration, sampling, fan-out   |
| `packages/project-io/src/__tests__/evals-assembler.test.ts`                  | project-io      | Unit | 6     | Eval entity export, field stripping, reference warnings  |
| `apps/studio/src/__tests__/components/evals/runs-tab-preflight.test.tsx`     | studio          | Unit | 2     | RunsTab preflight panel visibility                       |

### Coverage Summary

| Layer       | Tests | Files | Status                                                                        |
| ----------- | ----- | ----- | ----------------------------------------------------------------------------- |
| Unit        | ~82   | 7     | Preflight, circuit breakers, code scorers, LLM judge, dispatcher, export, UI  |
| Integration | 0     | 0     | No integration tests (repo CRUD, trajectory scoring, aggregation, ClickHouse) |
| E2E         | 0     | 0     | No end-to-end tests                                                           |

### Key Gaps

- No tests for trajectory scorers (`trajectory-scorers.ts`) -- pure functions, high value
- No tests for aggregation math (`aggregate-eval-run.service.ts`) -- pure functions, high value
- No tests for persona simulation prompts or judge prompt builders
- No tests for compression, rate limiter
- No integration tests for eval repo CRUD, workflow load/validation, ClickHouse writes
- No E2E tests for any eval API route

## 18. Revision History

| Date       | Author         | Change                                                              |
| ---------- | -------------- | ------------------------------------------------------------------- |
| 2026-03-22 | SDLC Pipeline  | Initial feature spec generated from codebase analysis               |
| 2026-04-15 | Post-Impl Sync | Added key implementation files, mitigated gaps, updated test status |

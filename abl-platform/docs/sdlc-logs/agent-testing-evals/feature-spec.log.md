# SDLC Log: Agent Testing & Evals — Feature Spec

**Phase:** Feature Spec (Phase 1)
**Date:** 2026-03-22
**Status:** Completed

## Inputs Read

1. **Pipeline Engine Eval Services:** 15 TypeScript files in `packages/pipeline-engine/src/pipeline/services/eval/` covering types, workflow, conversation execution, judging, aggregation, persona simulation, circuit breakers, rate limiting, metrics, compression, ClickHouse writers, auth, preflight, alerts, and logger.
2. **Pipeline Definitions:** `eval-pipeline.ts` (Restate workflow metadata), pipeline types, config schemas.
3. **Prompts:** `simulation.prompts.ts` (persona + judge prompt builders), `evaluation.prompts.ts` (hallucination, knowledge gap, guardrail, quality judge prompts).
4. **ClickHouse DDL:** `init-eval-tables.ts` — 3 tables (eval_conversations, eval_scores, eval_production_scores) + 4 materialized views.
5. **Database Models:** 6 Mongoose models (EvalSet, EvalRun, EvalPersona, EvalScenario, EvalEvaluator, EvalHumanReview).
6. **Constants:** `eval-limits.ts` — 30+ domain constants for validation limits, defaults, TTLs.
7. **Studio Store:** `evals-store.ts` — Zustand store with 5 state slices.
8. **Studio Hooks:** `useEvalData.ts` — 8 SWR hooks for all eval entities.
9. **Studio Repo:** `eval-repo.ts` — Data access layer with referential integrity.
10. **Studio API Routes:** 22 Next.js API route files under `/api/projects/[id]/evals/`.
11. **Existing Tests:** `eval-preflight.test.ts`, `eval-circuit-breaker-errors.test.ts`.
12. **EvalRunWorkflow:** Restate durable workflow with fan-out/fan-in orchestration.

## Decision Protocol

| Question                                               | Classification | Resolution                                                                         |
| ------------------------------------------------------ | -------------- | ---------------------------------------------------------------------------------- |
| What is the primary data store for eval configuration? | ANSWERED       | MongoDB (6 collections with uuidv7 IDs, tenant isolation plugin)                   |
| Where are eval execution results stored?               | ANSWERED       | ClickHouse (3 tables + 4 MVs with TTL and compression)                             |
| How is eval execution orchestrated?                    | ANSWERED       | Restate durable workflow (EvalRunWorkflow) with batched fan-out                    |
| What evaluator types are supported?                    | ANSWERED       | 4 types: llm_judge, code_scorer, trajectory, human_review                          |
| How is bias mitigated?                                 | ANSWERED       | R1: position swap, blind eval, evidence-first (RULERS), cross-model judge          |
| What trajectory metrics exist?                         | ANSWERED       | 4: milestone completion, handoff correctness (LCS), path efficiency, tool sequence |
| Is there a Studio UI?                                  | ANSWERED       | Hooks + store + repo + 22 API routes exist; no React page components yet           |
| How does CI integration work?                          | INFERRED       | `ciEnabled` flag on EvalSet exists but no CI trigger pipeline is implemented yet   |

## Sections Generated

All 16 sections of the feature spec were generated, code-grounded from the actual implementation.

## Key Findings

1. **Rich backend, thin frontend:** The pipeline engine has a complete eval subsystem (15+ services) but Studio has no eval-specific React components yet.
2. **Production eval gap:** `eval_production_scores` table and MV exist but no production scoring pipeline is wired.
3. **Limited test coverage:** Only 2 test files (preflight, circuit-breakers) — no E2E tests, no integration tests for the full pipeline.
4. **No pagination:** List queries hardcode `EVAL_LIST_DEFAULT_PAGE_SIZE = 50` with no cursor support.

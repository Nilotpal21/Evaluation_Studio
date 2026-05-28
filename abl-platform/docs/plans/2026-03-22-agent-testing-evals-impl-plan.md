# LLD & Implementation Plan: Agent Testing & Evals

**Feature Slug:** `agent-testing-evals`
**Status:** ALPHA
**Last Updated:** 2026-03-22

---

## 1. Current State Assessment

### What Exists

The Agent Testing & Evals feature has a substantial backend implementation:

| Component                                | LOC (approx) | Status      |
| ---------------------------------------- | ------------ | ----------- |
| Pipeline Engine eval services (15 files) | ~2,500       | Implemented |
| Database models (6 collections)          | ~600         | Implemented |
| Database constants                       | ~50          | Implemented |
| ClickHouse DDL (3 tables, 4 MVs)         | ~300         | Implemented |
| Studio eval repo                         | ~430         | Implemented |
| Studio eval hooks                        | ~250         | Implemented |
| Studio eval store                        | ~60          | Implemented |
| Studio API routes (22 files)             | ~1,000 est.  | Implemented |
| Existing tests (2 files)                 | ~200         | Implemented |

### What's Missing

| Gap                                      | Priority | Impact                                                                 |
| ---------------------------------------- | -------- | ---------------------------------------------------------------------- |
| Studio UI components (eval pages)        | P0       | Users cannot interact with the eval system through the UI              |
| Unit tests for pure functions            | P0       | No validation of trajectory scorers, aggregation math, prompt builders |
| Integration tests for service boundaries | P0       | No validation of repo layer, workflow orchestration, ClickHouse writes |
| E2E tests for full pipeline              | P0       | No validation that the entire system works end-to-end                  |
| Production eval scoring pipeline         | P1       | `eval_production_scores` table is unused                               |
| CI/CD trigger mechanism                  | P1       | `ciEnabled` flag exists but cannot be triggered                        |
| Human review UI                          | P2       | EvalHumanReview model exists but no Studio UI                          |
| Cursor pagination for list queries       | P1       | Hardcoded limit of 50 with no pagination controls                      |

## 2. Implementation Phases

### Phase 1: Unit Tests for Pure Functions

**Goal:** Validate all pure function logic without infrastructure dependencies.

**Files to Create:**

#### 1.1 `packages/pipeline-engine/src/__tests__/trajectory-scorers.test.ts`

Tests for all 4 trajectory scorers and trace extraction functions.

**Test Cases:**

```
milestoneCompletionScorer:
  - 3/4 milestones hit → 0.75
  - 0 expected milestones → 1.0 (no expectations)
  - 0 milestones hit of 3 expected → 0.0
  - All milestones hit → 1.0
  - Duplicate milestones in hit list → still correct ratio

handoffCorrectnessScorer:
  - Exact match [A, B, C] vs [A, B, C] → 1.0
  - Partial match [A, C] vs [A, B, C] → 0.67 (LCS=2/3)
  - No match [X, Y] vs [A, B, C] → 0.0
  - Empty expected → 1.0
  - Empty actual → 0.0
  - Longer actual than expected → partial credit

pathEfficiencyScorer:
  - Same length → 1.0
  - Shorter actual → 1.0
  - Double length actual → 0.5
  - Empty expected → 1.0
  - Empty actual → 0.0

toolSequenceScorer:
  - Within explicit maxToolCalls → 1.0
  - Over explicit maxToolCalls → degraded
  - No maxToolCalls, within 2x turns → 1.0
  - No maxToolCalls, over 2x turns → degraded

extractMilestonesFromTraces:
  - tool_call event with matching toolName → extracted
  - flow_step_enter with matching stepName → extracted
  - decision event with matching decision → extracted
  - handoff event with matching toAgent → extracted
  - No matching events → empty array

extractAgentPathFromTraces:
  - Sequential agent_enter events → ordered path
  - Duplicate consecutive agents → deduplicated
  - No agent_enter events → empty array

computeTrajectoryScores:
  - All perfect → all 1.0
  - All empty → appropriate defaults
```

#### 1.2 `packages/pipeline-engine/src/__tests__/aggregation-math.test.ts`

Tests for statistical functions used in AggregateEvalRun.

**Test Cases:**

```
computeStdDev:
  - [3, 4, 5] with mean 4.0 → 1.0
  - [5, 5, 5] with mean 5.0 → 0.0
  - Single value → 0.0
  - Empty array → 0.0 (guard)

compute95CI:
  - n=100, known mean/stddev → narrow interval
  - n=5, same mean/stddev → wider interval
  - n=1 → [mean, mean]

computePassAtK:
  - 80% pass rate, k=3 → 0.992
  - 0% pass rate, k=3 → 0.0
  - 100% pass rate, k=3 → 1.0
  - 50% pass rate, k=1 → 0.5

computePassExpK:
  - 80% pass rate, k=3 → 0.512
  - 0% pass rate, k=3 → 0.0
  - 100% pass rate, k=3 → 1.0
  - 50% pass rate, k=1 → 0.5
```

#### 1.3 `packages/pipeline-engine/src/__tests__/eval-prompts.test.ts`

Tests for prompt builder functions.

**Test Cases:**

```
buildPersonaSystemPrompt:
  - Basic persona → contains name, communication style, domain knowledge
  - Adversarial persona → contains adversarial instructions
  - Custom systemPrompt → overrides everything
  - Persona with goals and constraints → included in output
  - Scenario context → included with max turns

getAdversarialInstructions:
  - 'prompt_injection' → contains prompt injection instructions
  - 'social_engineering' → contains social engineering instructions
  - 'off_topic' → contains off-topic instructions
  - 'abusive' → contains abusive instructions
  - 'edge_case' → contains edge case instructions
  - unknown → generic adversarial instruction

buildStandardJudgePrompt:
  - With rubric → includes rubric points
  - Without rubric → still valid prompt
  - With custom judgePrompt → includes custom section

buildEvidenceFirstPrompt:
  - Contains RULERS-style step instructions
  - Contains evidence extraction requirement

formatTranscript / stripAttribution / swapTranscript:
  - formatTranscript produces [Turn N] Customer/Agent labels
  - stripAttribution produces Speaker A/B labels
  - swapTranscript reverses roles correctly
```

**Exit Criteria Phase 1:**

- All 3 test files pass with `pnpm test --filter=pipeline-engine`
- Total: 40+ test cases covering trajectory, aggregation, and prompt logic
- No infrastructure dependencies (MongoDB, ClickHouse, Restate)

---

### Phase 2: Integration Tests for Service Boundaries

**Goal:** Validate service boundary interactions with real MongoDB.

**Files to Create:**

#### 2.1 `packages/pipeline-engine/src/__tests__/eval-code-scorers.test.ts`

Tests for the 3 built-in code scorers and trajectory scorer within JudgeConversation.

**Test Cases:**

```
toolSuccessScorer:
  - All tools succeed → score 5
  - Half tools fail → score ~2.5
  - No tool calls → score 5 (default)

responseLengthScorer:
  - Average 100 chars → score 5
  - Average 10 chars → score 2
  - Average 3000 chars → score 3

errorFreeScorer:
  - 0 errors → score 5
  - 2 errors → score 3
  - 5+ errors → score 1
```

#### 2.2 `packages/pipeline-engine/src/__tests__/eval-rate-limiter.test.ts`

Tests for the eval rate limiting system.

**Test Cases:**

```
checkLLMRateLimit:
  - First call → true
  - After exhausting limit → false

acquireConversationSlot / releaseConversationSlot:
  - Acquire → true
  - Acquire up to limit → all true
  - Acquire over limit → false
  - Release then acquire → true again
```

**Exit Criteria Phase 2:**

- All integration test files pass
- Code scorers produce expected score ranges
- Rate limiter correctly bounds concurrent usage

---

### Phase 3: Studio UI Components

**Goal:** Create the core eval UI pages for Studio.

**Files to Create:**

#### 3.1 `apps/studio/src/components/evals/EvalsPage.tsx`

Main eval page with tab navigation (personas, scenarios, evaluators, eval-sets, runs).

**Key Design:**

- Uses `useEvalsStore` for active tab state
- Renders tab panels for each eval entity type
- Connected to all SWR hooks via `useEvalData.ts`

#### 3.2 `apps/studio/src/components/evals/PersonasList.tsx`

List view for eval personas with create/edit/delete actions.

#### 3.3 `apps/studio/src/components/evals/ScenariosList.tsx`

List view for eval scenarios with create/edit/delete actions.

#### 3.4 `apps/studio/src/components/evals/EvaluatorsList.tsx`

List view for eval evaluators with type badges and create/edit/delete actions.

#### 3.5 `apps/studio/src/components/evals/EvalSetsList.tsx`

List view for eval sets showing composed entity counts and run actions.

#### 3.6 `apps/studio/src/components/evals/RunsList.tsx`

List view for eval runs with status badges, scores, and comparison selection.

#### 3.7 `apps/studio/src/components/evals/RunDetail.tsx`

Detail view for a single run showing summary, heatmap, and drill-down.

#### 3.8 `apps/studio/src/components/evals/HeatMap.tsx`

Score heatmap visualization (persona rows x scenario columns, evaluator filter).

**Exit Criteria Phase 3:**

- Eval page accessible from Studio navigation
- All 5 entity types have list views with CRUD
- Run detail shows summary and heatmap
- No TypeScript errors (`pnpm build --filter=studio`)

---

### Phase 4: E2E Tests

**Goal:** Validate the complete eval system through its HTTP API.

**Files to Create:**

#### 4.1 `apps/studio/src/__tests__/e2e/eval-crud.e2e.test.ts`

E2E tests for eval entity CRUD and referential integrity (E2E-2, E2E-6).

#### 4.2 `apps/studio/src/__tests__/e2e/eval-templates.e2e.test.ts`

E2E tests for built-in template endpoints (E2E-7).

#### 4.3 `apps/studio/src/__tests__/e2e/eval-preflight.e2e.test.ts`

E2E tests for preflight validation endpoint (E2E-3).

**Exit Criteria Phase 4:**

- All E2E tests pass against real Studio server
- CRUD operations verified through HTTP API
- Referential integrity enforced (409 on referenced delete)
- Templates return valid data
- Preflight returns check results

---

### Phase 5: Production Hardening

**Goal:** Address P1 gaps for production readiness.

#### 5.1 Cursor Pagination

Add cursor-based pagination to all list endpoints.

**Changes:**

- Add `cursor` and `limit` query parameters to list routes
- Update repo functions to support cursor-based queries
- Update SWR hooks to support pagination

#### 5.2 CI/CD Integration

Wire `ciEnabled` eval sets to Harness CI pipeline.

**Changes:**

- Add `/api/projects/:projectId/evals/ci/trigger` endpoint
- Create Harness pipeline step that calls the trigger endpoint
- Gate deployment on eval pass/fail status

#### 5.3 Cost Estimation

Implement pre-run cost estimation for eval sets.

**Changes:**

- Calculate estimated LLM tokens based on persona count, scenario maxTurns, evaluator types
- Apply model-specific pricing
- Store as `estimatedCostPerRun` on EvalSet

**Exit Criteria Phase 5:**

- All list endpoints support cursor pagination
- CI trigger mechanism is functional
- Cost estimation is calculated and displayed

## 3. Wiring Checklist

| #   | Wiring Point                   | Source              | Target                       | Status                   |
| --- | ------------------------------ | ------------------- | ---------------------------- | ------------------------ |
| W1  | Eval page in Studio navigation | Navigation store    | EvalsPage component          | Not wired                |
| W2  | Eval page route registration   | Next.js app router  | `/projects/[id]/evals` page  | Not wired                |
| W3  | Heatmap data fetching          | RunDetail component | useEvalHeatMap hook          | Not wired (no component) |
| W4  | Run status polling             | RunsList component  | useEvalRunStatus hook        | Not wired (no component) |
| W5  | Run comparison                 | RunsList component  | useEvalComparison hook       | Not wired (no component) |
| W6  | Production eval pipeline       | Analytics pipeline  | eval_production_scores table | Not wired                |
| W7  | CI trigger                     | Harness CI step     | `/evals/ci/trigger` endpoint | Not wired                |
| W8  | Human review UI                | Studio              | EvalHumanReview model        | Not wired                |

## 4. File Inventory

### Phase 1 (Unit Tests — New Files)

| File                                                                | Purpose                            |
| ------------------------------------------------------------------- | ---------------------------------- |
| `packages/pipeline-engine/src/__tests__/trajectory-scorers.test.ts` | Trajectory scorer unit tests       |
| `packages/pipeline-engine/src/__tests__/aggregation-math.test.ts`   | Statistical aggregation unit tests |
| `packages/pipeline-engine/src/__tests__/eval-prompts.test.ts`       | Prompt builder unit tests          |

### Phase 2 (Integration Tests — New Files)

| File                                                               | Purpose                        |
| ------------------------------------------------------------------ | ------------------------------ |
| `packages/pipeline-engine/src/__tests__/eval-code-scorers.test.ts` | Code scorer integration tests  |
| `packages/pipeline-engine/src/__tests__/eval-rate-limiter.test.ts` | Rate limiter integration tests |

### Phase 3 (Studio UI — New Files)

| File                                                  | Purpose                     |
| ----------------------------------------------------- | --------------------------- |
| `apps/studio/src/components/evals/EvalsPage.tsx`      | Main eval page              |
| `apps/studio/src/components/evals/PersonasList.tsx`   | Persona list + CRUD         |
| `apps/studio/src/components/evals/ScenariosList.tsx`  | Scenario list + CRUD        |
| `apps/studio/src/components/evals/EvaluatorsList.tsx` | Evaluator list + CRUD       |
| `apps/studio/src/components/evals/EvalSetsList.tsx`   | Eval set list + run actions |
| `apps/studio/src/components/evals/RunsList.tsx`       | Run list + status + compare |
| `apps/studio/src/components/evals/RunDetail.tsx`      | Run detail + heatmap        |
| `apps/studio/src/components/evals/HeatMap.tsx`        | Heatmap visualization       |
| `apps/studio/src/app/projects/[id]/evals/page.tsx`    | Next.js page route          |

### Phase 4 (E2E Tests — New Files)

| File                                                       | Purpose                          |
| ---------------------------------------------------------- | -------------------------------- |
| `apps/studio/src/__tests__/e2e/eval-crud.e2e.test.ts`      | CRUD + referential integrity E2E |
| `apps/studio/src/__tests__/e2e/eval-templates.e2e.test.ts` | Template endpoints E2E           |
| `apps/studio/src/__tests__/e2e/eval-preflight.e2e.test.ts` | Preflight validation E2E         |

### Phase 5 (Production Hardening — Modified Files)

| File                                   | Change                          |
| -------------------------------------- | ------------------------------- |
| `apps/studio/src/repos/eval-repo.ts`   | Add cursor pagination           |
| `apps/studio/src/hooks/useEvalData.ts` | Add pagination support to hooks |
| Studio API list routes (6 files)       | Add cursor/limit query params   |

## 5. Risk Assessment

| Risk                                      | Phase     | Mitigation                                                                                                  |
| ----------------------------------------- | --------- | ----------------------------------------------------------------------------------------------------------- |
| Restate not available in test environment | Phase 4   | E2E tests focus on CRUD/API layer; workflow tests are integration-level with mock Restate context           |
| ClickHouse not available in CI            | Phase 4   | E2E tests for heatmap/comparison may need Docker ClickHouse; code scorer tests don't need it                |
| LLM costs in tests                        | Phase 1-4 | All tests use code_scorer evaluators (zero LLM cost); LLM judge tested only in integration with mock client |
| Studio component design uncertainty       | Phase 3   | Follow existing Studio component patterns (Zustand + SWR + Tailwind + Lucide icons)                         |

## 6. Dependencies Between Phases

```
Phase 1 (Unit Tests)         ← No dependencies
Phase 2 (Integration Tests)  ← No dependencies
Phase 3 (Studio UI)          ← Depends on existing hooks/store/repo (already implemented)
Phase 4 (E2E Tests)          ← Depends on Phase 3 (UI needs to exist for page routes)
Phase 5 (Hardening)          ← Depends on Phase 3 (pagination in UI) + Phase 4 (tests verify changes)
```

Phases 1 and 2 can run in parallel. Phase 3 can start independently. Phase 4 depends on Phase 3. Phase 5 depends on Phases 3 and 4.

## 7. Revision History

| Date       | Author        | Change                              |
| ---------- | ------------- | ----------------------------------- |
| 2026-03-22 | SDLC Pipeline | Initial LLD and implementation plan |

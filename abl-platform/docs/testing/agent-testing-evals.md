# Test Spec: Agent Testing & Evals

**Feature Slug:** `agent-testing-evals`
**Last Updated:** 2026-04-09

---

## 1. Test Coverage Summary

### Current State

| Layer                  | Tests | Files | Coverage                                                                        |
| ---------------------- | ----- | ----- | ------------------------------------------------------------------------------- |
| Unit (pipeline-engine) | ~20   | 2     | Eval preflight (8 tests), circuit breakers + auth contract (12 tests)           |
| Unit (eventstore)      | ~54   | 3     | Code scorers (24 tests), LLM judge evaluator (~10), evaluation dispatcher (~20) |
| Unit (project-io)      | 6     | 1     | Evals assembler export (6 tests)                                                |
| Unit (studio)          | 2     | 1     | RunsTab preflight panel visibility (2 tests)                                    |
| Integration            | 0     | 0     | No integration tests                                                            |
| E2E                    | 0     | 0     | No end-to-end tests                                                             |

### Target State

| Layer       | Min Scenarios | Focus                                                                     |
| ----------- | ------------- | ------------------------------------------------------------------------- |
| E2E         | 8             | Full eval run lifecycle through HTTP API                                  |
| Integration | 8             | Service boundaries: repo layer, workflow orchestration, ClickHouse writes |
| Unit        | 15+           | Trajectory scorers, aggregation math, prompt builders, compression        |

## 2. Existing Tests

### `packages/pipeline-engine/src/__tests__/eval-preflight.test.ts` (8 tests)

Tests the eval preflight validation system:

- Encryption master key validation (valid 64-hex, missing, wrong length)
- Required environment variables (all set, missing JWT_SECRET)
- Overall status (fail when any check fails)
- System-level preflight (skips tenant-specific checks)
- Result includes timestamp
- Each check has durationMs >= 0

### `packages/pipeline-engine/src/__tests__/eval-circuit-breaker-errors.test.ts` (12 tests)

Tests the eval circuit breaker error context and auth contract:

- Error message capture in recentErrors
- HTTP status code extraction from error messages (valid HTTP, non-HTTP, mixed text)
- Ring buffer max size enforcement (10 entries)
- Breaker state transitions (CLOSED -> OPEN via threshold)
- openedReason set on transition
- EvalCircuitOpenError enrichment (openedReason, recentErrors)
- Force reset clears error context
- getEvalBreakerStates returns all breakers
- isBreakerOpen returns correct state
- HALF_OPEN probe failure re-opens breaker
- Auth contract: createServiceToken produces valid JWT with type/tenantId/role/expiry

### `packages/eventstore/src/__tests__/evaluation-code-scorer.test.ts` (24 tests)

Tests all 5 built-in code scorers and the CodeScorerEvaluator class:

- `turnEfficiencyScorer`: 5 tests for turn count thresholds (<=3, 4-6, 7-10, 11-15, >15) + reasoning
- `repetitionScorer`: 4 tests for unique/repeated/case-insensitive/no-agent messages
- `errorOutcomeScorer`: 2 tests for pass/fail based on session endReason
- `toolSuccessScorer`: 5 tests for no-tools/success-rate/all-pass/all-fail/non-tool-events
- `containmentScorer`: 3 tests for contained/escalated/timeout
- `CodeScorerEvaluator` class: 5 tests for name/type, running all scorers, latency, multi-score arrays, failing scorers
- `BUILT_IN_SCORERS` export validation

### `packages/eventstore/src/__tests__/evaluation-llm-judge.test.ts` (~10 tests)

Tests the LLM-as-Judge evaluator:

- Evaluator name and type
- Criteria-based scoring with structured LLM output parsing
- Default quality criteria (resolution_quality, response_accuracy, helpfulness, coherence, professionalism, safety, pii_handling)
- Mock completion function injection via DI

### `packages/eventstore/src/__tests__/evaluation-dispatcher.test.ts` (~20 tests)

Tests the evaluation dispatcher orchestrator:

- Session.ended event subscription and processing
- Project evaluation config lookup
- Sampling-based evaluator selection
- Concurrent evaluator fan-out
- Evaluation result event emission
- Poll mode with tenant+project scoping
- Mock providers via DI (config, conversation, event emitter, event reader)

### `packages/project-io/src/__tests__/evals-assembler.test.ts` (6 tests)

Tests eval entity export:

- Layer name is "evals"
- Assembles eval sets with nested scenarios, personas, evaluators
- Strips internal fields (\_id, \_\_v, projectId, tenantId, timestamps)
- Warns about missing scenario references
- Handles empty project with no evals
- Counts entities correctly

### `apps/studio/src/__tests__/components/evals/runs-tab-preflight.test.tsx` (2 tests)

Tests RunsTab preflight panel visibility:

- Shows preflight panel when there are no runs
- Shows preflight panel alongside existing runs

## 3. E2E Test Scenarios

All E2E tests MUST exercise the real system through its HTTP API. No mocks, no direct DB access.

### E2E-1: Full Eval Run Lifecycle

**Objective:** Validate the complete eval run lifecycle from entity creation through execution and result retrieval.

**Steps:**

1. POST `/api/projects/:projectId/evals/personas` - Create a test persona
2. POST `/api/projects/:projectId/evals/scenarios` - Create a test scenario
3. POST `/api/projects/:projectId/evals/evaluators` - Create a code_scorer evaluator
4. POST `/api/projects/:projectId/evals/sets` - Create eval set referencing the above
5. POST `/api/projects/:projectId/evals/runs` - Create a run
6. POST `/api/projects/:projectId/evals/runs/:runId/start` - Trigger run
7. Poll GET `/api/projects/:projectId/evals/runs/:runId/status` until terminal
8. GET `/api/projects/:projectId/evals/runs/:runId` - Verify run has summary with scores
9. GET `/api/projects/:projectId/evals/runs/:runId/heatmap` - Verify heatmap data

**Assertions:**

- Run transitions through statuses: pending -> running -> completed
- Summary contains totalConversations, totalEvaluations, avgScore
- Heatmap contains cells with persona x scenario x evaluator scores

**Infrastructure:** Real Studio server, real Runtime, real ClickHouse, real MongoDB.

### E2E-2: Eval Entity CRUD and Referential Integrity

**Objective:** Verify all eval entity CRUD operations and deletion guards.

**Steps:**

1. Create persona, scenario, evaluator via POST
2. Verify GET returns created entities with correct fields
3. Update each entity via PUT, verify changes
4. Create eval set referencing all three
5. Attempt DELETE persona - expect 409 Conflict
6. DELETE eval set
7. DELETE persona - expect 200 success

**Assertions:**

- All CRUD operations return correct response shapes
- 409 on delete of referenced entity with eval set names in error message
- Successful delete after removing references
- Tenant/project isolation: cross-project requests return 404

### E2E-3: Eval Preflight Validation

**Objective:** Validate that preflight correctly identifies integration issues.

**Steps:**

1. GET `/api/projects/:projectId/evals/preflight` with all services running
2. Verify all checks pass

**Assertions:**

- Result contains `overall: 'pass'`
- Individual checks include: encryption_master_key, required_env_vars, runtime_reachable, clickhouse
- Each check has name, status, message, durationMs

### E2E-4: Run Cancellation

**Objective:** Verify that a running eval can be cancelled.

**Steps:**

1. Create eval set with slow scenario (high maxTurns)
2. Create and start run
3. Immediately POST `/api/projects/:projectId/evals/runs/:runId/cancel`
4. Verify run status transitions to 'cancelled'

**Assertions:**

- Cancel endpoint returns success
- Run status is 'cancelled'
- No further conversation processing occurs

### E2E-5: Run Comparison

**Objective:** Verify run comparison endpoint returns meaningful diff data.

**Steps:**

1. Create eval set
2. Run two eval runs to completion
3. GET `/api/projects/:projectId/evals/runs/compare?runIds=runId1,runId2`

**Assertions:**

- Response contains comparison data with both run IDs
- Evaluator scores are present for both runs
- Pass rates are included

### E2E-6: Tenant and Project Isolation

**Objective:** Verify that eval data is properly isolated between tenants and projects.

**Steps:**

1. Create persona in project A (tenant 1)
2. Attempt to read persona from project B (tenant 1) - expect 404
3. Attempt to read persona from project A (tenant 2) - expect 404
4. Create eval set in project A with persona from project A - succeeds
5. Update eval set with persona from project B - expect 400 (reference not found)

**Assertions:**

- Cross-project access returns 404 (not 403)
- Cross-tenant access returns 404
- Eval set creation validates all referenced entity IDs exist in same tenant+project

### E2E-7: Built-in Templates

**Objective:** Verify template endpoints provide bootstrap data.

**Steps:**

1. GET `/api/projects/:projectId/evals/personas/templates`
2. GET `/api/projects/:projectId/evals/evaluators/templates`

**Assertions:**

- Templates are returned with pre-populated fields
- Template personas cover diverse communication styles
- Template evaluators cover all 4 types

### E2E-8: Quick Eval

**Objective:** Verify quick evaluation without full eval set setup.

**Steps:**

1. POST `/api/projects/:projectId/evals/quick` with minimal config
2. Wait for completion

**Assertions:**

- Returns eval results without requiring pre-created eval set
- Results contain scores and summary

## 4. Integration Test Scenarios

Integration tests verify service boundary interactions with real infrastructure (MongoDB, ClickHouse) but may use test doubles for external LLM calls.

### INT-1: Eval Repo CRUD Operations

**Objective:** Verify the eval-repo data access layer against real MongoDB.

**Setup:** MongoMemoryServer

**Tests:**

1. `findPersonasByProject` - Returns personas for correct project, excludes other projects
2. `createPersona` - Creates with uuidv7 ID, sets version to 1
3. `updatePersona` - Increments version, strips protected fields
4. `deletePersona` - Removes document, returns null on re-read
5. `guardDeletion` - Throws 409 when persona referenced by eval set
6. `resolveEvalSetNames` - Returns ID->name maps, throws on missing refs
7. `findRunsByProject` - Returns runs sorted by createdAt desc, capped at page size

### INT-2: EvalRunWorkflow Load and Validation

**Objective:** Verify the workflow correctly loads and validates eval set data.

**Setup:** MongoMemoryServer with seeded eval entities

**Tests:**

1. Load eval set with valid persona/scenario/evaluator IDs - succeeds
2. Load eval set with missing persona ID - throws TerminalError
3. Load eval set with missing scenario ID - throws TerminalError
4. Load eval set with missing evaluator ID - throws TerminalError
5. Matrix building: 2 personas x 3 scenarios x 2 variants = 12 cells
6. Status transitions: loading -> running -> aggregating -> completed

### INT-3: Trajectory Scoring

**Objective:** Verify all 4 trajectory scorers compute correct values.

**Tests:**

1. `milestoneCompletionScorer`: 3/4 milestones hit = 0.75
2. `milestoneCompletionScorer`: 0 expected milestones = 1.0
3. `handoffCorrectnessScorer`: Exact match = 1.0
4. `handoffCorrectnessScorer`: Partial match (LCS) = partial score
5. `pathEfficiencyScorer`: Shorter path = 1.0
6. `pathEfficiencyScorer`: Double-length path = 0.5
7. `toolSequenceScorer`: Within threshold = 1.0
8. `toolSequenceScorer`: Over threshold = degraded score
9. `extractMilestonesFromTraces`: Extracts from tool_call, flow_step_enter, decision, handoff events
10. `extractAgentPathFromTraces`: Builds agent path from agent_enter events

### INT-4: Aggregation Statistics

**Objective:** Verify aggregation math (mean, stdDev, CI, Pass@k, Pass^k).

**Tests:**

1. Mean of [3, 4, 5] = 4.0
2. StdDev of [3, 4, 5] with mean 4.0 = 1.0
3. 95% CI calculation for n=100 vs n=5 (wider CI for smaller n)
4. Pass@k with 80% pass rate, k=3 = 0.992
5. Pass^k with 80% pass rate, k=3 = 0.512
6. Empty scores array returns zeros for all metrics
7. Regression detection: baseline 4.0, current 3.0, threshold 0.5 -> regression detected
8. Regression detection: baseline 4.0, current 3.8, threshold 0.5 -> no regression

### INT-5: Circuit Breaker State Machine

**Objective:** Verify circuit breaker transitions and error context.

**Tests:**

1. CLOSED: N-1 failures keep breaker closed
2. CLOSED -> OPEN: N failures within window opens breaker
3. OPEN: Calls rejected with EvalCircuitOpenError
4. OPEN -> HALF_OPEN: After resetTimeout elapsed
5. HALF_OPEN -> CLOSED: After successThreshold successes
6. HALF_OPEN -> OPEN: Single failure re-opens
7. Window pruning: Old failures outside window are discarded
8. Error ring buffer: Capped at MAX_RECENT_ERRORS (10)
9. Force reset: Returns breaker to CLOSED state

### INT-6: Judge Conversation Service

**Objective:** Verify all 4 evaluator types produce correct output shapes.

**Tests:**

1. Code scorer (toolSuccessScorer): All tools succeed -> score 5
2. Code scorer (responseLengthScorer): Average length 100 chars -> score 5
3. Code scorer (errorFreeScorer): 2 errors -> score 3
4. Trajectory scorer: All milestones hit, exact path -> score 5
5. Human review: Creates EvalHumanReview document, returns score 0 with needsHumanReview=true
6. Unknown evaluator type: Returns status 'fail'

### INT-7: ClickHouse Table Initialization

**Objective:** Verify eval ClickHouse DDL is idempotent and creates all tables/MVs.

**Setup:** Real ClickHouse (test instance)

**Tests:**

1. `initEvalTables` creates 3 tables (eval_conversations, eval_scores, eval_production_scores)
2. `initEvalTables` creates 4 materialized views
3. Second call is idempotent (no errors)
4. Tables have correct column types and indexes

### INT-8: Eval Preflight Checks

**Objective:** Verify each preflight check in isolation.

**Tests:**

1. `checkEncryptionMasterKey`: Valid key -> pass
2. `checkEncryptionMasterKey`: Missing key -> fail
3. `checkEncryptionMasterKey`: Invalid format -> fail with descriptive message
4. `checkRequiredEnvVars`: All present -> pass
5. `checkRequiredEnvVars`: Missing JWT_SECRET -> fail
6. `checkRuntimeReachable`: Runtime up -> pass
7. `checkRuntimeReachable`: Runtime down -> fail with URL in message
8. `checkClickHouse`: Table accessible -> pass
9. System-level preflight: Skips tenant-specific checks

## 5. Unit Test Scenarios

Unit tests for pure functions and isolated logic.

### Trajectory Scorers (Pure Functions)

- `milestoneCompletionScorer`: Edge cases (empty arrays, all hit, none hit)
- `handoffCorrectnessScorer`: LCS algorithm correctness with various path lengths
- `pathEfficiencyScorer`: Path shorter than expected, equal, longer
- `toolSequenceScorer`: With and without explicit maxToolCalls
- `longestCommonSubsequence`: Correctness for known sequences

### Prompt Builders (Pure Functions)

- `buildPersonaSystemPrompt`: With/without adversarial type, with custom systemPrompt override
- `getAdversarialInstructions`: All 5 adversarial types
- `buildConversationContext`: Empty conversation, multi-turn conversation
- `buildStandardJudgePrompt`: With/without rubric, with/without custom judgePrompt
- `buildEvidenceFirstPrompt`: RULERS pattern output structure
- `formatTranscript` / `stripAttribution` / `swapTranscript`: Bias mitigation transcript transformations

### Aggregation Math (Pure Functions)

- `computeStdDev`: Single value, identical values, known distribution
- `compute95CI`: Large n (normal approx) vs small n (wider CI)
- `computePassAtK` / `computePassExpK`: Edge cases (0% pass rate, 100% pass rate, k=1)

### Compression

- `compressField`: Objects < 1KB not compressed, > 1KB compressed
- `compressString`: Empty string handling

### Rate Limiter

- `checkLLMRateLimit`: Within limit -> true, exceeded -> false
- `acquireConversationSlot` / `releaseConversationSlot`: Slot tracking

## 6. Test Infrastructure Requirements

### E2E Test Server Setup

```
Required Services:
- Studio (Next.js): Port 0 (random)
- Runtime (Express): Port 0 (random)
- MongoDB: MongoMemoryServer or test database
- ClickHouse: Test instance (Docker)
- Restate: Test instance (Docker) or mock server for workflow dispatch

Environment Variables:
- ENCRYPTION_MASTER_KEY=<valid 64-hex>
- JWT_SECRET=test-jwt-secret
- RUNTIME_URL=http://localhost:<runtime-port>
- CLICKHOUSE_URL=http://localhost:<ch-port>
```

### Test Data Fixtures

```typescript
// Minimal persona for testing
const testPersona = {
  name: 'Test Persona',
  communicationStyle: 'professional',
  domainKnowledge: 'general',
  behaviorTraits: ['polite'],
  goals: 'Resolve a simple query',
  constraints: '',
  isAdversarial: false,
};

// Minimal scenario for testing
const testScenario = {
  name: 'Test Scenario',
  category: 'general',
  difficulty: 'easy',
  maxTurns: 3,
  expectedMilestones: ['greeting'],
  agentPath: ['main-agent'],
};

// Code scorer evaluator (zero LLM cost)
const testEvaluator = {
  name: 'Error-Free Scorer',
  type: 'code_scorer',
  category: 'reliability',
  scorerName: 'errorFreeScorer',
  chainOfThought: false,
  temperature: 0,
  biasSettings: {
    positionSwapEnabled: false,
    blindEvaluation: false,
    crossModelJudge: false,
    evidenceFirstMode: false,
  },
};
```

## 7. Coverage Targets

| Package                         | Current | Target | Priority | Notes                                                      |
| ------------------------------- | ------- | ------ | -------- | ---------------------------------------------------------- |
| pipeline-engine (eval services) | ~10%    | 60%    | P0       | Preflight + circuit breakers covered; 15 files untested    |
| eventstore (evaluation)         | ~40%    | 60%    | P1       | Code scorer, LLM judge, dispatcher covered                 |
| project-io (evals layer)        | ~50%    | 60%    | P1       | Assembler covered; disassembler untested                   |
| studio (eval hooks/repo/routes) | ~2%     | 40%    | P1       | Only RunsTab preflight; 23 components + 21 routes untested |
| database (eval models)          | 0%      | 30%    | P2       | No model-level tests                                       |

## 8. Test Execution Strategy

### Phase 1: Unit Tests (No infrastructure)

- Trajectory scorers, aggregation math, prompt builders, compression
- Can run in CI without Docker dependencies

### Phase 2: Integration Tests (MongoDB only)

- Eval repo CRUD, workflow validation, preflight checks
- Requires MongoMemoryServer

### Phase 3: Integration Tests (MongoDB + ClickHouse)

- ClickHouse table initialization, score queries
- Requires Docker ClickHouse

### Phase 4: E2E Tests (Full stack)

- Complete eval run lifecycle through HTTP API
- Requires all services running (Studio, Runtime, MongoDB, ClickHouse, Restate)

## 9. Revision History

| Date       | Author         | Change                                                                                                 |
| ---------- | -------------- | ------------------------------------------------------------------------------------------------------ |
| 2026-03-22 | SDLC Pipeline  | Initial test spec generated from codebase analysis                                                     |
| 2026-04-09 | Post-Impl Sync | Updated coverage matrix with 7 test files (~82 tests); added eventstore + project-io + studio coverage |

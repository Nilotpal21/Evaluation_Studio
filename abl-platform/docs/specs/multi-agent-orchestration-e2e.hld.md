# Multi-Agent Orchestration E2E Test Suite — High-Level Design

## What

Build a comprehensive E2E test suite that validates the multi-agent orchestration mechanics of the ABL runtime through its HTTP API. This is the most critical testing gap in the platform: existing tests either use in-process RuntimeExecutor directly (not exercising the middleware chain) or mock LLM clients (missing real orchestration bugs). The new suite will exercise the FULL runtime path — HTTP request → auth middleware → session management → agent execution → handoff/delegate/fan-out → response — using two tiers: deterministic (scripted agents, no LLM) and live-LLM (env-gated).

## Architecture Approach

### Packages That Change

| Package        | What Changes                                 |
| -------------- | -------------------------------------------- |
| `apps/runtime` | New test file, new harness, new ABL fixtures |

No production code changes. This is a test-only deliverable.

### Data Flow (Deterministic Tier)

```
Test Setup:
  startRuntimeApiHarness() → Express server on random port + MongoMemoryServer
  bootstrapProject() → dev-login → create tenant → create project
  importProjectFiles() → upload ABL agent fixtures via /api/projects/:id/project-io/import
  createDeployment() → POST /api/projects/:id/deployments (activates agents)
  createSdkPublicKey() → POST /api/projects/:id/sdk-public-keys
  initSdkSession() → POST /api/v1/sdk/init (get SDK session token)

Test Execution:
  POST /api/v1/sdk/init → SDK session token
  ↓
  [Send message via channel pipeline OR direct executor interaction]
  ↓
  RuntimeExecutor.executeMessage() [behind HTTP boundary]
  ↓
  Scripted FLOW agent (deterministic, no LLM)
    → GATHER fields from ON_INPUT rules
    → HANDOFF to child agent (creates thread)
    → Child GATHER + COMPLETE
    → RETURN to parent (thread resume)
  ↓
  GET /api/sessions/:id/detail → verify thread state, history, data
```

### Data Flow (Live LLM Tier)

```
Same setup + provisionTenantModel() → configure LLM credentials

Test Execution:
  POST message → reasoning agent (real LLM call)
  ↓
  LLM interprets user intent → calls __handoff__ tool
  ↓
  Child specialist agent activated (reasoning)
  ↓
  LLM extracts entities via GATHER → calls tools
  ↓
  Agent completes → RETURN to supervisor
  ↓
  Verify: correct routing, entity extraction, history integrity
```

### Key Integration Points

1. **RuntimeApiHarness** (existing) — starts Express + MongoMemoryServer
2. **channel-e2e-bootstrap** (existing) — bootstrapProject, importProjectFiles, initSdkSession, provisionTenantModel
3. **Deployment pipeline** — agents must be deployed before SDK channels can route to them
4. **Session detail API** — GET /api/sessions/:sessionId/detail returns full thread state
5. **Trace store** — trace events captured during execution for assertion

## Decisions & Tradeoffs

### Decision 1: Two-tier approach (deterministic + live-LLM)

**Chose** split tiers **over** all-LLM tests **because** deterministic tests run fast, are reliable in CI, and validate orchestration mechanics without network dependencies. Live-LLM tests validate the reasoning path but are env-gated and slower.

### Decision 2: Use existing channel-e2e-bootstrap helpers

**Chose** extending channel-e2e-bootstrap **over** building new harness **because** it already provides bootstrapProject, importProjectFiles, initSdkSession, and provisionTenantModel — exactly what we need. We add a thin orchestration-specific wrapper on top.

### Decision 3: Direct RuntimeExecutor for deterministic tier, HTTP API for live-LLM tier

**Chose** hybrid approach **over** pure HTTP-only **because** the deterministic tier tests orchestration MECHANICS (thread creation, context passing, fan-out) which are internal to the executor. The existing test pattern (flow-handoff-threads.test.ts) uses RuntimeExecutor directly and this is the architecturally correct level for testing these mechanics. The live-LLM tier uses the full HTTP path. Both tiers avoid mocking.

### Decision 4: ABL fixture files in test fixtures directory

**Chose** inline ABL DSL in fixture files **over** importing from examples/ **because** test fixtures should be self-contained and stable. Production example agents evolve independently of tests.

### Decision 5: Single consolidated test file with describe blocks

**Chose** one file with clear describe blocks **over** many small files **because** the test infrastructure (harness setup, teardown) is expensive and shared. Vitest's beforeAll/afterAll at the describe level keeps this manageable.

## Task Decomposition

| Task                                      | Package(s)   | Independent? | Est. Files |
| ----------------------------------------- | ------------ | ------------ | ---------- |
| T-1: Orchestration harness + ABL fixtures | apps/runtime | Yes          | 4-5        |
| T-2: Deterministic tier tests             | apps/runtime | No (T-1)     | 1          |
| T-3: Live LLM tier tests                  | apps/runtime | No (T-1)     | 1          |

Since T-2 and T-3 both depend on T-1 and write to the same test file, all three tasks are sequential.

## Test File Structure

```
apps/runtime/src/__tests__/
  multi-agent-orchestration.e2e.test.ts       # Main test file (both tiers)
  helpers/
    orchestration-harness.ts                   # Orchestration-specific test utilities
  fixtures/
    orchestration/
      supervisor-router.abl                    # Scripted supervisor that routes by intent
      specialist-booking.abl                   # Scripted booking specialist (GATHER + COMPLETE)
      specialist-support.abl                   # Scripted support specialist
      fan-out-coordinator.abl                  # Fan-out coordinator agent
      reasoning-supervisor.abl                 # Reasoning-mode supervisor (for live LLM tier)
      reasoning-specialist.abl                 # Reasoning specialist (for live LLM tier)
```

## Deterministic Tier Scenarios (No LLM)

These use scripted FLOW agents with ON_INPUT rules for deterministic behavior.

| #    | Scenario                                          | Gap Covered                    |
| ---- | ------------------------------------------------- | ------------------------------ |
| D-1  | Supervisor → specialist handoff (scripted)        | Basic orchestration            |
| D-2  | Handoff with PASS field propagation               | Context passing                |
| D-3  | RETURN: true → parent thread resumes              | Gap #1: Thread resume          |
| D-4  | ON_RETURN MAP data back to supervisor             | Gap #3: ON_RETURN MAP          |
| D-5  | Fan-out to multiple specialists (parallel)        | Gap #4: Fan-out barrier        |
| D-6  | Fan-out with partial failure                      | Fan-out edge case              |
| D-7  | 3-level delegation chain (A → B → C → B → A)      | Gap #6: Auth propagation chain |
| D-8  | Multi-intent dispatch (primary_queue strategy)    | Gap #5: Multi-intent dispatch  |
| D-9  | Thread data isolation between concurrent handoffs | Data integrity                 |
| D-10 | Handoff target not found → graceful fallback      | Error handling                 |

## Live LLM Tier Scenarios (Env-Gated)

These use reasoning-mode agents with real LLM calls.

| #   | Scenario                                                    | Gap Covered                |
| --- | ----------------------------------------------------------- | -------------------------- |
| L-1 | Reasoning supervisor routes to specialist via **handoff**   | LLM-driven routing         |
| L-2 | Specialist GATHER with multi-turn entity extraction         | Real extraction            |
| L-3 | Supervisor → specialist → RETURN → supervisor continuation  | Full roundtrip             |
| L-4 | History strategy: last_n vs full (compare thread histories) | Gap #2: History strategies |
| L-5 | Multi-turn with corrections (user changes entity value)     | Correction handling        |

## Shared Utilities (orchestration-harness.ts)

New helper functions that wrap existing channel-e2e-bootstrap:

1. `setupOrchestrationHarness()` — calls startRuntimeApiHarness with all needed routes mounted
2. `deployAgents(harness, token, projectId, fixtures)` — importProjectFiles + create deployment
3. `sendMessage(executor, sessionId, message)` — send message and collect traces
4. `assertThreadCount(session, count)` — verify thread count
5. `assertActiveAgent(session, agentName)` — verify active agent
6. `assertHandoffOccurred(traces, from, to)` — verify handoff trace event
7. `assertDataPassed(session, threadIndex, key, value)` — verify PASS field propagation
8. `waitForCompletion(executor, sessionId, timeout)` — wait for agent to complete

## Out of Scope

- **Gap #7: Cross-tenant A2A E2E** — Requires two runtime instances; separate test suite
- **Gap #8: Remote delegate via A2A** — Requires A2A server setup; separate test suite
- **Gap #9: Voice-specific handoff** — Requires LiveKit/voice infrastructure; separate test suite
- **Gap #10: Async handoff push notification** — Requires WebSocket/push infrastructure; separate test suite
- Production code changes — this is test-only
- Performance/load testing — separate concern

# LLD: Interactions Tab — Implementation Plan

**Feature Spec**: `docs/features/interactions-tab.md`
**HLD**: `docs/specs/interactions-tab.hld.md`
**Test Spec**: `docs/testing/interactions-tab.md`
**Status**: DRAFT
**Date**: 2026-04-02

---

## Document Type: Hybrid (Retroactive + Forward-Looking)

**Retroactive**: Documents existing implementation (UI complete, 27 components, 6 unit tests)
**Forward-Looking**: Plans test implementation work (integration + E2E tests required for BETA)

**Current Status**: ALPHA
**Target Status**: BETA (requires minimum 3 integration + 3 E2E tests passing, GAP-001 resolved, 5 PR review rounds)

---

## 1. Design Decisions

### Decision Log

| #   | Decision                                          | Rationale                                                            | Alternatives Rejected                                                  |
| --- | ------------------------------------------------- | -------------------------------------------------------------------- | ---------------------------------------------------------------------- |
| D-1 | Client-side event processing (Option B from HLD)  | Zero backend changes, instant real-time updates, simple architecture | Server-side processing (complexity), Hybrid (waterfall loading)        |
| D-2 | Event processor groups by user_message boundaries | Natural interaction boundaries, aligns with user mental model        | Group by time windows (arbitrary), group by agent switches (too coarse |

) |
| D-3 | Filter out pure-init interactions (no user/agent steps) | Remove noise from timeline — session setup events without actual interaction are not useful for debugging | Show all interactions (too noisy), hide via UI toggle (state complexity) |
| D-4 | switchMap limited to 100 agent switches | Prevent unbounded memory growth for long sessions | No limit (memory leak risk), limit to 50 (too aggressive) |
| D-5 | Token data fallback chain (3 levels) | Backward compatibility with older trace event schemas | Single source (breaks old traces), two levels (misses legacy field) |
| D-6 | Integration tests before E2E tests | Lower complexity, no Playwright setup, faster feedback loop | E2E first (infrastructure overhead), parallel (resource contention) |
| D-7 | Playwright for E2E tests | Mentioned in test spec, industry standard for browser automation | Cypress (not aligned with spec), Testing Library (not true E2E) |

### Key Interfaces & Types

**Core Types** (`apps/studio/src/components/observatory/interactions/types.ts`):

```typescript
interface Interaction {
  id: string;
  index: number;
  steps: InteractionStep[];
  status: 'ok' | 'warning' | 'error';
  startTime: Date;
  endTime?: Date;
  durationMs: number;
}

interface InteractionStep {
  id: string;
  type: InteractionStepType;
  timestamp: Date;
  data: Record<string, unknown>;
  status: 'ok' | 'warning' | 'error';
}

type InteractionStepType =
  | 'user_input'
  | 'input_guard'
  | 'llm_call'
  | 'tool_call'
  | 'agent_response'
  | 'memory_diff'
  | 'flow_transition'
  | 'decision'
  | 'error';

interface SessionSummary {
  sessionId: string;
  interactionCount: number;
  agentCount: number;
  llmCallCount: number;
  toolCallCount: number;
  totalDurationMs: number;
  totalTokensIn: number;
  totalTokensOut: number;
  totalCost: number;
  maxContextWindow: number;
  guardrailSummary: GuardrailSummary;
}
```

**Test Fixture Types** (to be created):

```typescript
// For integration tests
interface TraceEventFixture {
  type: string;
  timestamp: Date;
  sessionId: string;
  agentName: string;
  data: {
    usage?: {
      inputTokens: number;
      outputTokens: number;
    };
    // ... other fields
  };
  metadata: Record<string, unknown>;
}
```

### Module Boundaries

| Module                | Responsibility                                                        | Depends On                              |
| --------------------- | --------------------------------------------------------------------- | --------------------------------------- |
| `InteractionsTab.tsx` | Root component, orchestrates event processing and rendering           | ObservatoryStore, SessionStore, useMemo |
| `event-processor.ts`  | Transform flat events into grouped interactions, detect parallel exec | types.ts, constants.ts                  |
| `InteractionCard.tsx` | Render single interaction with collapsible step timeline              | InteractionStep.tsx, TokenBadge, Framer |
| `SessionHeader.tsx`   | Display aggregate session stats (token totals, guardrail summary)     | types.ts, TokenBadge, GuardrailCompact  |
| `ErrorBoundary.tsx`   | Catch errors in event processing/rendering, display fallback UI       | React.Component, ErrorInfo              |
| Test fixtures (new)   | Provide realistic trace event data for integration tests              | types.ts, constants.ts (event mappings) |
| E2E test infra (new)  | Playwright config, test DB seeding, auth setup                        | Playwright, MongoDB, Studio REST API    |

---

## 2. File-Level Change Map

### New Files (Test Implementation)

| File                                                         | Purpose                                            | LOC Estimate |
| ------------------------------------------------------------ | -------------------------------------------------- | ------------ |
| `apps/studio/src/__tests__/fixtures/trace-events.ts`         | Realistic trace event fixtures with correct schema | 200-300      |
| `apps/studio/src/__tests__/fixtures/trace-events.test.ts`    | Unit tests for fixture factory validation          | 50-100       |
| `apps/studio/src/__tests__/helpers/test-utils.ts`            | Integration test helpers (mocks, assertions)       | 100-150      |
| `apps/studio/src/__tests__/interactions-integration.test.ts` | Integration tests (INT-1, INT-2, INT-6)            | 300-400      |
| `apps/studio/e2e/interactions-tab.spec.ts`                   | E2E tests (E2E-1, SEC-1, SEC-2)                    | 400-500      |
| `apps/studio/e2e/helpers/test-db.ts`                         | Test database seeding helpers                      | 150-200      |
| `apps/studio/e2e/fixtures/sessions.ts`                       | E2E test session fixtures (seed data)              | 200-300      |
| `apps/studio/e2e/smoke.spec.ts`                              | Smoke test for E2E infrastructure verification     | 50-100       |

**Total New LOC**: ~1,450-2,050

### Modified Files

| File                                | Change Description                                              | Risk |
| ----------------------------------- | --------------------------------------------------------------- | ---- |
| `docs/features/interactions-tab.md` | Update §16 GAP-001 status from Open → Resolved                  | Low  |
| `docs/features/interactions-tab.md` | Update status from ALPHA → BETA                                 | Low  |
| `docs/testing/interactions-tab.md`  | Update test file mapping with actual implemented test files     | Low  |
| `docs/testing/README.md`            | Update Interactions Tab status from PLANNED → PARTIAL or STABLE | Low  |

**Note**: `apps/studio/package.json` and `apps/studio/playwright.config.ts` already have Playwright installed and configured (per Phase 3 Task 3.1). `apps/studio/e2e/helpers/auth.ts` already exists with `loginViaDevApi()` and `getDevAccessToken()` functions (per Phase 3 Task 3.3). No modifications to these files are required.

### Deleted Files

None.

---

## 3. Implementation Phases

**Note**: Phase 0 documents the existing implementation (already complete). Phases 1-5 are forward-looking test implementation work. Phase 0 is numbered "0" to distinguish retroactive documentation from new work.

### Phase 0: Existing Implementation (RETROACTIVE — Already Complete)

**Goal**: Document the already-implemented UI and unit tests for completeness.

**Tasks**:

0.1. Core Infrastructure (COMPLETE)

- `types.ts` — 113 lines, defines Interaction, InteractionStep, SessionSummary, AgentSwitch, etc.
- `constants.ts` — 395 lines, EVENT_TO_STEP mapping (37+ event types), STEP_CONFIG (intent colors, labels)
- `event-processor.ts` — 20KB, `processEventsToInteractions()` function
- Unit tests: `interactions-event-processor.test.ts` (12KB)

  0.2. Feature A — Token & Cost Intelligence (COMPLETE)

- `TokenBadge.tsx` — 57 lines, displays token counts and cost with color-coded context window bar
- `ContextWindowBar.tsx` — token usage visualization
- Session header token aggregation logic in `SessionHeader.tsx`
- Unit tests: `interactions-token-guard.test.ts` (6KB)

  0.3. Feature B — Guardrail & Safety Layer (COMPLETE)

- `GuardrailPanel.tsx` — expanded view with confidence bars
- `GuardrailCompact.tsx` — single-line summary
- Guardrail event detection in `event-processor.ts`
- Unit tests: Part of `interactions-token-guard.test.ts`

  0.4. Feature C — Memory & State Evolution (COMPLETE)

- `MemoryDiff.tsx` — 238 lines, git-style diff rendering
- `DiffLine.tsx` — renders added/changed/removed/unchanged keys with color coding
- Context diff logic in `event-processor.ts`
- Unit tests: `interactions-memory-diff.test.ts` (2.6KB)

  0.5. Feature D — Parallel Execution Visualization (COMPLETE)

- `SwimLaneTimeline.tsx` — 247 lines, parallel tool call swim lanes with dependency arrows
- Parallel detection logic in `event-processor.ts` (analyzes overlapping time ranges)
- Unit tests: `interactions-parallel-detect.test.ts` (2.1KB)

  0.6. Feature F — Flow & DSL Awareness (COMPLETE)

- `FlowBreadcrumb.tsx` — flow step breadcrumb for scripted agents
- `MiniFlowGraph.tsx` — mini flow graph visualization
- `GatherConfidence.tsx` — per-field gather confidence with source highlighting
- Unit tests: `interactions-flow-dsl.test.ts` (2.9KB)

  0.7. Integration & Polish (COMPLETE)

- `InteractionsTab.tsx` — 168 lines, root component wired into DebugTabs
- `useInteractionCount()` hook for badge count
- `ErrorBoundary.tsx` — 67 lines, catches errors, displays fallback UI
- Lifecycle banners (agent enter/exit, delegate, gather) rendered as thin dividers
- Performance optimizations (switchMap limit to 100, conditional rendering)

**Files Touched**: 27 .tsx component files, 4 logic modules, 6 unit test files in `apps/studio/src/components/observatory/interactions/` and `apps/studio/src/__tests__/`

**Exit Criteria** (Already Met):

- [x] All 27 components render without errors
- [x] 6 unit tests pass (interactions-event-processor, token-guard, memory-diff, parallel-detect, flow-dsl, contract)
- [x] `pnpm build --filter=apps/studio` succeeds with 0 errors
- [x] Feature wired into DebugTabs, accessible via Observatory → Interactions tab
- [x] Manual dogfooding validates all Features A-F work in production

**Test Strategy** (Already Done):

- Unit: Event processor, token calculation, memory diff, parallel detection, flow DSL, type contracts
- Integration: ❌ NOT IMPLEMENTED (Phase 2)
- E2E: ❌ NOT IMPLEMENTED (Phase 4)

**Rollback**: Not applicable (feature already in production).

---

### Phase 1: Test Infrastructure & Fixtures

**Goal**: Create realistic test fixtures and helper utilities for integration and E2E tests.

**Tasks**:

1.1. Create trace event fixture factory

- File: `apps/studio/src/__tests__/fixtures/trace-events.ts`
- Functions: `createTraceEvent()`, `createLLMCallEvent()`, `createToolCallEvent()`, `createUserMessageEvent()`, `createGuardrailEvent()`
- **CRITICAL**: Token data MUST be in `data.usage.{inputTokens,outputTokens}`, NOT in `metadata`
- Include fallback fields: `data.tokensIn`, `data.promptTokens` for backward compatibility
- Export fixture builder with fluent API for test readability

  1.2. Create integration test helpers

- File: `apps/studio/src/__tests__/helpers/test-utils.ts`
- Functions: `createMockObservatoryStore()`, `waitForProcessing()`, `assertInteractionCount()`
- Helpers for common assertions (token totals, interaction grouping, agent path structure)

  1.3. Write unit test for fixture factory validation

- File: `apps/studio/src/__tests__/fixtures/trace-events.test.ts`
- Test: `createLLMCallEvent()` produces event with data.usage.inputTokens (not metadata)
- Test: `processEventsToInteractions([createUserMessageEvent(), createLLMCallEvent()])` returns 1 interaction
- Assert: No errors, token extraction works (non-zero totals)
- Verify fixture structure matches event-processor.ts extractStepData logic (lines 200-300)

**Files Touched**:

- `apps/studio/src/__tests__/fixtures/trace-events.ts` — new file
- `apps/studio/src/__tests__/helpers/test-utils.ts` — new file

**Exit Criteria**:

- [ ] Fixture factory creates trace events with correct schema (data.usage.inputTokens)
- [ ] `processEventsToInteractions(fixtureEvents)` returns valid interactions without errors
- [ ] Token extraction works: `buildSummary()` calculates non-zero token totals from fixtures
- [ ] Helper utilities build successfully: `pnpm build --filter=apps/studio` succeeds

**Test Strategy**:

- Unit: Test fixture factory itself — validate generated events have required fields
- Integration: Use fixtures in Phase 2 integration tests

**Rollback**: Delete new fixture files, revert `package.json` if dependencies added.

---

### Phase 2: Integration Tests (Priority Scenarios)

**Goal**: Implement minimum 3 integration tests (INT-1, INT-2, INT-6) for BETA promotion.

**Tasks**:

2.1. INT-1: Event Processor Groups Events into Interactions

- File: `apps/studio/src/__tests__/interactions-integration.test.ts`
- Test: Create fixtures with 3 user messages, 6 LLM calls, 4 tool calls
- Assert: `processEventsToInteractions()` returns 3 interactions
- Assert: Each interaction has correct steps (user_input, llm_call, tool_call, agent_response)
- Assert: Pure-init interactions (no user/agent steps) are filtered out

  2.2. INT-2: Token Calculation Aggregates Across Interactions

- Test: Create fixtures with token data in data.usage (100 in, 50 out per LLM call, 3 calls)
- Assert: Session-level totals = 300 in, 150 out
- Assert: Per-interaction totals aggregate correctly
- Assert: Cost calculation uses correct token totals (if pricing data available)

  2.3. INT-6: Agent Path Construction

- Test: Create fixtures with agent_enter, agent_exit, delegate events
- Assert: `buildAgentPath()` returns correct agent sequence
- Assert: Agent switches detected at correct interaction boundaries
- Assert: Agent mode (reasoning/scripted) tracked correctly

**Files Touched**:

- `apps/studio/src/__tests__/interactions-integration.test.ts` — new file (300-400 LOC)
- `apps/studio/src/__tests__/fixtures/trace-events.ts` — may need additional fixture builders

**Exit Criteria**:

- [ ] All 3 integration tests pass: `pnpm test --filter=apps/studio interactions-integration`
- [ ] Tests use realistic fixtures (no mocked ObservatoryStore or event-processor)
- [ ] Tests verify service boundary: fixtures → event-processor → interactions output
- [ ] Code coverage for event-processor.ts increases to 85%+
- [ ] `pnpm build && pnpm test` passes with no regressions

**Test Strategy**:

- Integration: Logic-level service boundary. Fixtures → event-processor → assertions on output. Tests the event processing service boundary, not API/DB/WebSocket boundaries.
- Real event processor, real fixtures, no mocks of codebase components
- **No database** — integration tests use in-memory fixtures only (not MongoMemoryServer, not real MongoDB). Pure logic tests (event processing), not API/DB integration.
- Not API-level (no HTTP requests), not DB-level (no Mongoose models), not WebSocket-level (no real-time events)

**Rollback**: Delete `interactions-integration.test.ts`, revert any fixture changes that break existing unit tests.

---

### Phase 3: E2E Test Infrastructure Setup

**Goal**: Set up Playwright, test database seeding, and auth helpers for E2E tests.

**Tasks**:

3.1. Verify Playwright infrastructure (already exists)

- **Playwright already installed** — in `apps/studio/package.json` dev dependencies
- **Playwright config already exists** — `apps/studio/playwright.config.ts` with testDir: './e2e', retries: 2 in CI, trace: 'on-first-retry', screenshot: 'only-on-failure'
- **npm script already exists** — `"test:e2e": "playwright test"` in package.json
- **No changes needed** — existing config already suitable for Interactions Tab E2E tests
- Verify: Run `pnpm playwright --version --filter=apps/studio` to confirm installation

  3.2. Create test database seeding scripts

- File: `apps/studio/e2e/helpers/test-db.ts`
- Functions: `seedTestSession()`, `seedTraceEvents()`, `clearTestData()`
- **CRITICAL**: Seed sessions with `tenantId`, `projectId`, `userId` for isolation tests
- Seed trace events in MongoDB with correct schema (data.usage.inputTokens)
- Use MongoDB connection from env vars (TEST_MONGODB_URI)
- **Note**: E2E tests use **real MongoDB** (not MongoMemoryServer like unit tests)
- **Rationale**: E2E tests exercise full system (Studio + MongoDB + auth), not isolated logic

  3.3. Extend existing authentication helpers (if needed)

- File: `apps/studio/e2e/helpers/auth.ts` — **ALREADY EXISTS**
- **Reuse existing functions**:
  - `loginViaDevApi(page, { email: 'interactions-tab@e2e-smoke.test', name: 'Interactions E2E' })`
  - `getDevAccessToken(page, { email, baseUrl })` — returns JWT token for API calls
- **Test isolation pattern**: Use `@e2e-smoke.test` email domain (existing pattern)
- **Auth flow**: POST `/api/auth/dev-login` → injects cookies → navigates to landing path
- **Only extend if needed**: If tenant/project context helpers missing, add wrapper functions

  3.4. Create E2E test fixtures

- File: `apps/studio/e2e/fixtures/sessions.ts`
- Export: `testSessionWithInteractions` — session + 10+ trace events with LLM calls, tool calls, guardrails
- Export: `crossTenantSession` — session from different tenant (for SEC-1 test)
- Export: `crossProjectSession` — session from different project (for SEC-2 test)

  3.5. Smoke test: Verify Playwright can launch Studio

- Test: `apps/studio/e2e/smoke.spec.ts`
- Steps: Start Studio on test port, navigate to http://localhost:5173, verify page loads
- Assert: Page title includes "Studio", no console errors

**Files Touched**:

- `apps/studio/package.json` — verify Playwright dependency (already exists)
- `apps/studio/playwright.config.ts` — verify config (already exists, no changes needed)
- `apps/studio/e2e/helpers/test-db.ts` — new file
- `apps/studio/e2e/helpers/auth.ts` — extend if needed (file already exists)
- `apps/studio/e2e/fixtures/sessions.ts` — new file
- `apps/studio/e2e/smoke.spec.ts` — new file (smoke test)

**Exit Criteria**:

- [x] Playwright already installed: `pnpm playwright --version` succeeds
- [x] Playwright config already exists: `playwright.config.ts` with correct settings
- [ ] Smoke test passes: `pnpm test:e2e smoke` launches browser, navigates to Studio, page loads
- [ ] Test DB seeding works: `seedTestSession()` creates session in MongoDB, `clearTestData()` removes it
- [ ] Test DB cleanup works: afterEach hook calls `clearTestData()`, verifies no orphaned sessions
- [ ] Option: `KEEP_TEST_DATA=1` env var skips cleanup for debugging
- [ ] Auth helpers work: `loginViaDevApi()` logs in test user, `getDevAccessToken()` returns valid JWT token
- [ ] E2E fixtures have correct structure: `testSessionWithInteractions` includes 10+ trace events with data.usage

**Test Strategy**:

- E2E infrastructure: Smoke test verifies Playwright → Studio → MongoDB → Auth flow works end-to-end
- No mocks: Real Studio server, real MongoDB, real auth middleware
- Isolation: Test DB uses separate database name (e.g., `abl-studio-test`)

**Rollback**: Remove Playwright from package.json, delete `e2e/` directory, revert npm scripts.

---

### Phase 4: E2E Tests (Priority Scenarios)

**Goal**: Implement minimum 3 E2E tests (E2E-1, SEC-1, SEC-2) for BETA promotion.

**Tasks**:

4.1. E2E-1: Load Session and View Interactions Timeline

- File: `apps/studio/e2e/interactions-tab.spec.ts`
- Preconditions: Seed test session with 10+ interactions via `seedTestSession()`
- Steps:
  1. Navigate to Studio UI (http://localhost:5173)
  2. Login as test user (tenant_test_001, project_test_001, user_test_001)
  3. Select test session from session list
  4. Click Observatory → Interactions tab
  5. Verify session header displays correct stats (interaction count, token total, cost)
  6. Click first interaction card to expand
  7. Verify steps are rendered (user input, LLM call, tool call, agent response)
  8. Verify token badge shows non-zero values
  9. Verify memory diff section exists
- Expected: Interactions tab loads without errors, all interactions listed chronologically, session header shows aggregate stats

  4.2. SEC-1: Cross-Tenant Isolation

- Test: Seed session from tenant_test_002, attempt to load from tenant_test_001 context
- Steps:
  1. Login as user from tenant_test_001
  2. Navigate to /sessions/{sessionIdFromTenant002}
  3. Verify: Returns 404 (not 403 — don't leak existence)
  4. Verify: Interactions tab never renders (session not found)
- Expected: Cross-tenant access returns 404, no data leakage

  4.3. SEC-2: Cross-Project Isolation

- Test: Seed session from project_test_002 (same tenant), attempt to load from project_test_001 context
- Steps:
  1. Login as user with access to project_test_001 only
  2. Navigate to /sessions/{sessionIdFromProject002}
  3. Verify: Returns 404
- Expected: Cross-project access returns 404

**Files Touched**:

- `apps/studio/e2e/interactions-tab.spec.ts` — new file (400-500 LOC)
- `apps/studio/e2e/helpers/test-db.ts` — may need additional seeding functions
- `apps/studio/e2e/fixtures/sessions.ts` — may need cross-tenant/project fixtures

**Exit Criteria**:

- [ ] All 3 E2E tests pass: `pnpm test:e2e interactions-tab`
- [ ] Tests exercise real system: Studio server running, MongoDB connected, auth middleware active
- [ ] Tests use HTTP API only (no direct DB queries, no mocked stores)
- [ ] Isolation tests verify 404 (not 403) for cross-tenant/project access
- [ ] Screenshots captured on failure for debugging
- [ ] `pnpm test:e2e` passes all E2E tests without flakiness (retry successful on first run)

**Test Strategy**:

- E2E: Real browser automation via Playwright, real Studio server, real MongoDB, real auth flow
- No mocks: Exercise full middleware chain (auth, rate limiting, tenant isolation, validation)
- Structured content: Test data includes arrays (interactions), objects (session summary), not just plain strings
- Isolation checks: Verify 404 responses, no data leakage

**Rollback**: Delete `e2e/interactions-tab.spec.ts`, revert any test-db or fixture changes that break smoke test.

---

### Phase 5: BETA Promotion & Documentation

**Goal**: Resolve GAP-001, complete PR review, update docs, promote to BETA status.

**Tasks**:

5.1. Resolve GAP-001 in feature spec

- File: `docs/features/interactions-tab.md` §16 Gaps table
- Change GAP-001 status from "Open" to "Resolved"
- Update severity from "High" to N/A (remove from table or mark resolved)
- Add resolution note: "Integration tests (INT-1, INT-2, INT-6) and E2E tests (E2E-1, SEC-1, SEC-2) implemented in Phase 2 and Phase 4"

  5.2. Update test spec with actual test files

- File: `docs/testing/interactions-tab.md` §8 Test File Mapping
- Add rows for:
  - `interactions-integration.test.ts` — integration — Covers INT-1, INT-2, INT-6
  - `e2e/interactions-tab.spec.ts` — e2e — Covers E2E-1, SEC-1, SEC-2
- Update status from PLANNED → PARTIAL (6 unit, 3 integration, 3 E2E = 12 tests total)

  5.3. Update testing README

- File: `docs/testing/README.md`
- Change Interactions Tab status from PLANNED → PARTIAL
- Note: "Unit + Integration + E2E (minimum for BETA), remaining scenarios deferred"

  5.4. PR Review (5 rounds via pr-reviewer agent)

- Run: Spawn pr-reviewer agent with base SHA (before test implementation) and head SHA (after Phase 4)
- Address: All CRITICAL and HIGH findings from reviewer
- Log: Document all 5 rounds in `docs/sdlc-logs/interactions-tab/pr-review-rounds.md`
- Iterate: Fix findings, re-submit for next round

  5.5. Promote feature status to BETA

- File: `docs/features/interactions-tab.md` §1 Introduction/Overview metadata
- Change status from ALPHA → BETA
- Add note: "Promoted to BETA after implementing minimum test coverage (3 integration + 3 E2E tests) and completing 5 PR review rounds"

  5.6. Update feature README

- File: `docs/features/README.md`
- Update Interactions Tab status from ALPHA → BETA in feature table

**Files Touched**:

- `docs/features/interactions-tab.md` — update §1 status, §16 GAP-001
- `docs/testing/interactions-tab.md` — update §8 test file mapping, status
- `docs/testing/README.md` — update Interactions Tab status
- `docs/features/README.md` — update feature table
- `docs/sdlc-logs/interactions-tab/pr-review-rounds.md` — new file (PR review log)

**Exit Criteria**:

- [ ] GAP-001 resolved in feature spec
- [ ] Test file mapping updated with actual test files
- [ ] PR review completed (5 rounds, all CRITICAL/HIGH findings addressed)
- [ ] Feature status updated to BETA in all docs
- [ ] `pnpm build && pnpm test` passes with no regressions (all unit + integration + E2E tests pass)
- [ ] No new CRITICAL gaps introduced during test implementation

**Test Strategy**:

- PR review: pr-reviewer agent validates test quality, HLD compliance, production readiness
- No test implementation in this phase (tests already done in Phases 2 and 4)

**Rollback**: Revert doc changes, keep ALPHA status, log blockers for future BETA attempt.

---

## 4. Wiring Checklist

**CRITICAL**: Every new component must be wired into its callers. This section prevents the #1 agent failure mode: writing code that nothing calls.

**Phase 0 (Existing Implementation — Already Wired)**:

- [x] InteractionsTab wired into DebugTabs (`apps/studio/src/components/observatory/DebugTabs.tsx`)
- [x] Event processor imported and used in InteractionsTab.tsx
- [x] All 27 components imported and rendered in parent components (InteractionCard, SessionHeader, etc.)
- [x] Types exported from `types.ts` and imported by components
- [x] Constants exported from `constants.ts` and imported by event-processor and components
- [x] Error boundary wraps InteractionsTabContent

**Phase 1 (Test Fixtures — Wiring Required)**:

- [ ] Fixture factory exported from `fixtures/trace-events.ts`
- [ ] Test helpers exported from `helpers/test-utils.ts`
- [ ] Fixtures imported in Phase 2 integration tests

**Phase 2 (Integration Tests — Wiring Required)**:

- [ ] Integration test file discovered by test runner (named `*.test.ts` in `__tests__/`)
- [ ] Test imports fixtures from `fixtures/trace-events.ts`
- [ ] Test imports event processor from `event-processor.ts` (not mocked)

**Phase 3 (E2E Infrastructure — Wiring Required)**:

- [ ] Playwright config discovered by `pnpm test:e2e` command
- [ ] Test DB helpers exported from `e2e/helpers/test-db.ts`
- [ ] Auth helpers exported from `e2e/helpers/auth.ts`
- [ ] E2E fixtures exported from `e2e/fixtures/sessions.ts`
- [ ] Smoke test imports helpers and fixtures

**Phase 4 (E2E Tests — Wiring Required)**:

- [ ] E2E test file discovered by Playwright (named `*.spec.ts` in `e2e/`)
- [ ] E2E test imports test-db helpers for seeding
- [ ] E2E test imports auth helpers for login
- [ ] E2E test imports session fixtures for test data

**Phase 5 (Documentation — No Wiring Required)**:

- [ ] N/A (documentation updates only)

---

## 5. Cross-Phase Concerns

### Database Migrations

**None**. Interactions tab reads existing trace events from MongoDB. No schema changes required.

**Test DB**: E2E tests use separate database (`abl-studio-test`) with same schema. Seeding scripts create test sessions and trace events.

### Feature Flags

**None**. Feature enabled by default for all Studio users. No phased rollout needed (internal tooling).

**If rollback needed**: Revert Studio deployment, no feature flag to toggle.

### Configuration Changes

**New Environment Variables** (for E2E tests only):

- `TEST_MONGODB_URI` — MongoDB connection string for test database (e.g., `mongodb://localhost:27017/abl-studio-test`)
- `TEST_STUDIO_PORT` — Port for Studio test server (e.g., `5174`)
- `TEST_AUTH_SECRET` — JWT secret for test auth tokens

**No production config changes**. Feature uses existing Studio configuration.

---

## 6. Acceptance Criteria (Whole Feature)

**BETA Promotion Criteria** (from AUTHORING_GUIDE.md):

- [ ] E2E tests passing — minimum 3 scenarios from test spec (E2E-1, SEC-1, SEC-2)
- [ ] Integration tests passing — minimum 3 scenarios from test spec (INT-1, INT-2, INT-6)
- [ ] Unit tests cover core logic paths (already done: 6 unit tests, 70-80% coverage)
- [ ] All CRITICAL gaps from feature spec §16 resolved (GAP-001 resolved)
- [ ] HIGH gaps either resolved or have documented workarounds (no HIGH gaps besides GAP-001)
- [ ] PR review completed (5 rounds of pr-reviewer)
- [ ] Feature spec, test spec, and testing README updated
- [ ] No regressions in existing test suites (`pnpm build && pnpm test` passes)

**Additional Acceptance Criteria**:

- [ ] Test fixtures use correct trace event schema (data.usage.inputTokens, not metadata)
- [ ] E2E tests exercise real system (no mocked Studio server, no mocked MongoDB)
- [ ] Integration tests test real service boundaries (no mocked event-processor)
- [ ] Isolation tests verify 404 (not 403) for cross-tenant/project access
- [ ] All 12 tests pass consistently (6 unit + 3 integration + 3 E2E, no flakiness)

---

## 7. Open Questions

1. **Playwright vs Cypress**: Test spec mentions Playwright. Is this decision final, or should we evaluate Cypress for better Studio integration?

2. **Test DB seeding strategy**: Should E2E tests seed data inline (in test files) or use shared seed scripts in `/tools/test-seeds/`?

3. **WebSocket mocking for real-time tests**: Should E2E tests mock WebSocket for real-time update scenarios (E2E-2), or connect to a real Runtime instance?

4. **Remaining integration scenarios**: After Phase 2 (3 integration tests), should we implement INT-3 through INT-8 immediately, or defer to post-BETA?

5. **Remaining E2E scenarios**: After Phase 4 (3 E2E tests), should we implement E2E-2 through E2E-5 immediately, or defer to post-BETA?

6. **Test data cleanup**: Should E2E tests clean up test data after each run (delete sessions/traces), or keep test data for debugging?

7. **CI integration**: Should E2E tests run in GitHub Actions CI, or only locally due to MongoDB/Studio dependencies?

---

## 8. References

- **Feature Spec**: `docs/features/interactions-tab.md`
- **HLD**: `docs/specs/interactions-tab.hld.md`
- **Test Spec**: `docs/testing/interactions-tab.md`
- **Test-Spec Log**: `docs/sdlc-logs/interactions-tab/test-spec.log.md` (Path to BETA section)
- **BETA Criteria**: `docs/features/AUTHORING_GUIDE.md` (ALPHA → BETA transition)
- **Design Doc**: `/Users/sainathbhima/Downloads/2026-03-30-turns-tab-design.md` (original wireframes)
- **Implementation**: `apps/studio/src/components/observatory/interactions/` (27 components, 6 unit tests)

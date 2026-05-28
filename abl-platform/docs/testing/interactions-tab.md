# Testing Guide: Interactions Tab

**Feature Doc**: `../features/interactions-tab.md`
**Status**: **PARTIAL** (minimum coverage for BETA: 6 unit + 11 integration + 7 E2E = 24 tests)
**Coverage Level**: Unit (6 tests) + Integration (11 tests) + E2E (7 tests) — Remaining scenarios deferred
**Last Updated**: 2026-04-05

---

## 1. Feature Metadata

**Feature**: Interactions Tab
**Feature Area(s)**: Observability, Agent Lifecycle
**Package(s)**: `apps/studio`
**Status**: ALPHA
**Testing Priority**: High (core observability feature)

---

## 2. Current State

**Unit Tests**: 6 test files covering core logic:

- `interactions-event-processor.test.ts` (12KB) — event processing, interaction grouping, parallel detection
- `interactions-token-guard.test.ts` (6KB) — token calculation, cost aggregation, guardrail summary
- `interactions-memory-diff.test.ts` (2.6KB) — memory diff categorization
- `interactions-parallel-detect.test.ts` (2.1KB) — parallel execution detection
- `interactions-flow-dsl.test.ts` (2.9KB) — flow step status, breadcrumb rendering
- `interactions-contract.test.ts` (1.9KB) — type contract validation

**Integration Tests**: None

**E2E Tests**: None

**Manual Testing**: Feature validated through manual dogfooding during development

---

## 3. Coverage Matrix

| Functional Requirement                                             | Unit | Integration | E2E | Manual | Status     | Test File / Note                       |
| ------------------------------------------------------------------ | ---- | ----------- | --- | ------ | ---------- | -------------------------------------- |
| FR-1: Process events into chronological interactions               | ✅   | ❌          | ❌  | ✅     | PASS       | `interactions-event-processor.test.ts` |
| FR-2: Calculate and display token usage/cost per call/interaction  | ✅   | ❌          | ❌  | ✅     | PASS       | `interactions-token-guard.test.ts`     |
| FR-3: Display context window utilization with color thresholds     | ❌   | ❌          | ❌  | ✅     | NOT TESTED | Manual testing only                    |
| FR-4: Show guardrail check results inline with confidence bars     | ✅   | ❌          | ❌  | ✅     | PASS       | `interactions-token-guard.test.ts`     |
| FR-5: Display memory state changes as git-style diffs              | ✅   | ❌          | ❌  | ✅     | PASS       | `interactions-memory-diff.test.ts`     |
| FR-6: Detect and render parallel tool execution as swim lanes      | ✅   | ❌          | ❌  | ✅     | PASS       | `interactions-parallel-detect.test.ts` |
| FR-7: Display flow breadcrumb and mini flow graph (scripted)       | ✅   | ❌          | ❌  | ✅     | PASS       | `interactions-flow-dsl.test.ts`        |
| FR-8: Show variable resolution and transition condition eval       | ✅   | ❌          | ❌  | ✅     | PASS       | `interactions-flow-dsl.test.ts`        |
| FR-9: Display per-field gather confidence with source highlighting | ❌   | ❌          | ❌  | ✅     | NOT TESTED | Manual testing only                    |
| FR-10: Support real-time WebSocket updates                         | ❌   | ❌          | ❌  | ✅     | NOT TESTED | Requires WebSocket test harness        |
| FR-11: Load and display historical traces from database            | ❌   | ❌          | ❌  | ✅     | NOT TESTED | Requires test DB with fixture sessions |
| FR-12: Handle 100+ interactions without UI degradation             | ❌   | ❌          | ❌  | ✅     | NOT TESTED | Performance test with large session    |
| FR-13: Render lifecycle banners between steps                      | ❌   | ❌          | ❌  | ✅     | NOT TESTED | Manual testing only                    |
| FR-14: Display agent switch banners on agent transitions           | ❌   | ❌          | ❌  | ✅     | NOT TESTED | Manual testing only                    |
| FR-15: Show session header with aggregate stats                    | ❌   | ❌          | ❌  | ✅     | NOT TESTED | Manual testing only                    |

---

## 4. E2E Test Scenarios

### E2E-1: Load Session and View Interactions Timeline

**Preconditions**:

- Studio running with authenticated user
- Test session with 10+ interactions exists in database
- Session includes LLM calls, tool calls, guardrail checks, memory mutations

**Steps**:

1. Navigate to Studio UI
2. Select test session from session list
3. Open Observatory debug panel
4. Switch to Interactions tab
5. Verify session header displays correct stats (interaction count, token total, cost, guardrail summary)
6. Click first interaction card to expand
7. Verify steps are rendered (user input, LLM call, tool call, agent response)
8. Verify token badge shows correct values
9. Verify memory diff section shows state changes

**Auth Context**:

- Tenant: `tenant_test_001`
- Project: `project_test_001`
- User: `user_test_001` (with Observatory access permissions)

**Expected Result**:

- Interactions tab loads without errors
- All interactions are listed in chronological order
- Session header shows aggregate stats
- Expanding interaction card reveals step timeline
- Token badges show non-zero values
- Memory diff shows added/changed/unchanged keys

**Isolation Check**:

- Attempt to load session from `tenant_test_002` → Returns 404 (not 403)

**Status**: NOT TESTED (requires E2E test harness)

---

### E2E-2: Real-Time Interaction Updates via WebSocket

**Preconditions**:

- Studio running with authenticated user
- Runtime connected via WebSocket
- New session started

**Steps**:

1. Open Observatory debug panel, switch to Interactions tab
2. Send a user message to the agent via conversation UI
3. Verify Interactions tab appends new interaction card in real-time as agent processes
4. Verify new interaction card shows "loading" state while agent is thinking
5. Verify interaction card updates with final status (ok/warning/error) when agent completes
6. Verify token badge updates after LLM call completes
7. Verify memory diff section updates after state mutation

**Expected Result**:

- New interaction appears immediately after user message sent
- Interaction card updates in real-time as trace events arrive
- Token badges update after LLM call
- Memory diff section updates after state mutation
- No UI flickering or state desync

**Status**: NOT TESTED (requires WebSocket test harness)

---

### E2E-3: Parallel Tool Execution Visualization

**Preconditions**:

- Studio running with authenticated user
- Test session with parallel tool calls exists (e.g., 3 tools with overlapping time ranges)

**Steps**:

1. Load test session, open Interactions tab
2. Expand interaction card containing parallel tool calls
3. Verify swim lane timeline renders with 3 lanes
4. Verify each lane shows tool name, duration, and status (✓ or ✗)
5. Verify timeline ruler shows time ticks (0ms, 200ms, 400ms, etc.)
6. Verify dependency arrows show if one tool waits for another
7. Verify time savings calculation displays (e.g., "Sequential: 1,010ms → Parallel: 600ms · Saved 410ms (41% faster)")

**Expected Result**:

- Swim lane timeline renders correctly
- All 3 tool calls are visible in separate lanes
- Timeline ruler shows correct time scale
- Dependency arrows indicate wait periods
- Time savings calculation is accurate

**Status**: NOT TESTED (requires test session with parallel tools)

---

### E2E-4: Flow Graph and Variable Resolution (Scripted Agent)

**Preconditions**:

- Studio running with authenticated user
- Test session with scripted agent exists (e.g., support-agent with gather flow)

**Steps**:

1. Load test session with scripted agent, open Interactions tab
2. Expand interaction card for scripted agent
3. Verify flow breadcrumb renders at top of interaction (e.g., [greeting ✓] → [collect_issue ✓] → [lookup_order])
4. Verify current step is highlighted
5. Click on a flow graph node to jump to that step's trace events
6. Scroll down to variable resolution section
7. Verify DSL variables (e.g., `{{orderId}}`) show resolved values and source attribution

**Expected Result**:

- Flow breadcrumb renders with correct step states (visited, current, upcoming, error)
- Mini flow graph shows node states with colors (green: visited, amber: current, gray: upcoming, red: error)
- Variable resolution section shows all template variables with resolved values
- Source attribution indicates which tool or context key provided the value

**Status**: NOT TESTED (requires test session with scripted agent)

---

### E2E-5: Guardrail Check Results Display

**Preconditions**:

- Studio running with authenticated user
- Test session with guardrail checks exists (input and output guardrails)
- At least one guardrail check has warning or failure status

**Steps**:

1. Load test session, open Interactions tab
2. Expand interaction card with guardrail checks
3. Verify Input Guardrail step appears after User Input step
4. Verify guardrail panel shows check types (PII Scan, Prompt Injection, Content Policy, Sentiment)
5. Verify each check has confidence bar (0-100%)
6. Verify pass/warn/fail badges are color-coded (green, amber, red)
7. Click "▶ View raw guardrail response" to expand raw JSON
8. Verify Output Guardrail step appears before Agent Response step
9. Verify output guardrail panel shows similar check results

**Expected Result**:

- Input and output guardrail steps render in correct order
- Guardrail panels show all check types with confidence bars
- Pass/warn/fail badges are color-coded correctly
- Raw JSON expands when clicked
- Compact view is used for all-pass cases, expanded view for warnings/failures

**Status**: NOT TESTED (requires test session with guardrail checks)

---

## 5. Integration Test Scenarios

### INT-1: Event Processor Groups Events into Interactions

**Scope**: Test that `processEventsToInteractions()` correctly groups raw trace events into interaction objects.

**Setup**:

- Mock trace event array with 3 user messages and associated llm_call, tool_call, agent_response events
- Call `processEventsToInteractions(events)`

**Expected Result**:

- Returns 3 interactions
- Each interaction contains all events between one user message and the next
- Interaction IDs are sequential
- Agent names are correctly assigned

**Status**: NOT TESTED (covered by unit test, needs integration test with full event schema)

---

### INT-2: Token Calculation Aggregates Across Interactions

**Scope**: Test that token aggregation logic correctly sums input/output tokens and calculates cost.

**Setup**:

- Mock trace events with 2 llm_call events in one interaction, 1 llm_call in another
- Each llm_call has `metadata.inputTokens`, `outputTokens`, `model`
- Call token aggregation logic

**Expected Result**:

- Session-level token total is sum of all 3 calls
- Interaction-level token totals are correct
- Cost calculation uses correct model pricing
- Context window utilization is calculated correctly

**Status**: NOT TESTED (covered by unit test, needs integration test with model pricing service)

---

### INT-3: Memory Diff Categorizes State Changes

**Scope**: Test that memory diff logic correctly categorizes state changes as added, changed, removed, unchanged.

**Setup**:

- Mock context state before and after interaction
- Before: `{ customerId: "usr_123", balance: 100 }`
- After: `{ customerId: "usr_123", balance: 150, lastQuery: "balance" }`
- Call memory diff logic

**Expected Result**:

- `customerId` categorized as UNCHANGED
- `balance` categorized as CHANGED (100 → 150)
- `lastQuery` categorized as ADDED

**Status**: NOT TESTED (covered by unit test, needs integration test with full context schema)

---

### INT-4: Parallel Detection Identifies Overlapping Tool Calls

**Scope**: Test that parallel detection logic correctly identifies overlapping tool calls.

**Setup**:

- Mock 3 tool_call events within one interaction
- Tool A: startTime=0, endTime=300
- Tool B: startTime=100, endTime=400 (overlaps with A)
- Tool C: startTime=350, endTime=600 (overlaps with B)
- Call parallel detection logic

**Expected Result**:

- Parallel execution detected
- All 3 tools grouped into one parallel execution step
- Time savings calculation shows sequential time (300 + 400 + 600 = 1300ms) vs parallel time (600ms)

**Status**: NOT TESTED (covered by unit test, needs integration test with full tool call schema)

---

### INT-5: Flow Step Status Derivation for Scripted Agents

**Scope**: Test that flow step status is correctly derived from flow_step_enter, flow_step_exit, flow_transition events.

**Setup**:

- Mock flow events for scripted agent with 3 steps (greeting, collect_issue, lookup_order)
- Events: flow_step_enter(greeting), flow_step_exit(greeting), flow_step_enter(collect_issue)
- Call flow status derivation logic

**Expected Result**:

- Greeting step: status = VISITED (green)
- Collect_issue step: status = CURRENT (amber)
- Lookup_order step: status = UPCOMING (gray)

**Status**: NOT TESTED (covered by unit test, needs integration test with full flow event schema)

---

## 6. Security & Isolation Test Scenarios

### SEC-1: Cross-Tenant Isolation

**Preconditions**:

- Two tenants exist: Tenant A, Tenant B
- User A belongs to Tenant A
- Session S1 belongs to Tenant A
- Session S2 belongs to Tenant B

**Steps**:

1. Authenticate as User A
2. Load Session S1 in Studio
3. Open Interactions tab
4. Verify Session S1 interactions are visible
5. Attempt to load Session S2 (Tenant B) by manipulating URL or API call
6. Verify access is denied with 404 error (not 403, to avoid leaking existence)

**Expected Result**:

- User A can view Session S1 interactions
- User A cannot view Session S2 interactions
- Cross-tenant access returns 404, not 403

**Status**: NOT TESTED (inherited from Observatory store isolation, needs explicit test)

---

### SEC-2: Cross-Project Isolation

**Preconditions**:

- User A has access to Project P1
- User A does NOT have access to Project P2
- Session S1 belongs to Project P1
- Session S2 belongs to Project P2 (same tenant as P1)

**Steps**:

1. Authenticate as User A
2. Load Session S1 in Studio
3. Open Interactions tab
4. Verify Session S1 interactions are visible
5. Attempt to load Session S2 (Project P2) by manipulating URL or API call
6. Verify access is denied with 404 error

**Expected Result**:

- User A can view Session S1 interactions
- User A cannot view Session S2 interactions
- Cross-project access returns 404, not 403

**Status**: NOT TESTED (inherited from Observatory store isolation, needs explicit test)

---

### SEC-3: User-Owned Session Isolation

**Preconditions**:

- User A and User B belong to same tenant and project
- Session S1 is owned by User A
- Session S2 is owned by User B

**Steps**:

1. Authenticate as User A
2. Load Session S1 in Studio
3. Open Interactions tab
4. Verify Session S1 interactions are visible
5. Attempt to load Session S2 (owned by User B) by manipulating URL or API call
6. Verify access is denied with 404 error (unless User A has admin permissions)

**Expected Result**:

- User A can view Session S1 interactions (owns it)
- User A cannot view Session S2 interactions (does not own it, not admin)
- Cross-user access returns 404, not 403

**Status**: NOT TESTED (inherited from Observatory store isolation, needs explicit test)

---

## 7. Performance Test Scenarios

### PERF-1: Session with 100 Interactions

**Scope**: Verify UI remains responsive with 100 interactions.

**Setup**:

- Create test session with 100 user messages and associated events
- Load session in Studio, open Interactions tab

**Expected Result**:

- Interactions tab loads in < 2 seconds
- Scrolling is smooth (60fps)
- Expanding interaction cards is instant (< 100ms)
- No memory leaks (heap size stable after scrolling)

**Status**: NOT TESTED

---

### PERF-2: Session with 500 Interactions

**Scope**: Verify UI degrades gracefully with 500 interactions.

**Setup**:

- Create test session with 500 user messages and associated events
- Load session in Studio, open Interactions tab

**Expected Result**:

- Interactions tab loads in < 5 seconds
- Scrolling may lag slightly but remains usable
- Expanding interaction cards is < 500ms
- Memory usage is < 500MB

**Status**: NOT TESTED (future optimization: virtualization required)

---

### PERF-3: Real-Time Updates with 10 Events/Second

**Scope**: Verify UI remains responsive with high-frequency event stream.

**Setup**:

- Simulate agent session emitting 10 trace events per second
- Open Interactions tab during session

**Expected Result**:

- Interactions tab updates in real-time without flickering
- UI remains responsive (interactions can still be expanded/collapsed)
- No dropped events (all trace events are processed)

**Status**: NOT TESTED (future optimization: batching or throttling required)

---

## 8. Edge Case Test Scenarios

### EDGE-1: Session with No Interactions

**Setup**:

- Load empty session (no user messages, no events)
- Open Interactions tab

**Expected Result**:

- Empty state message: "No interactions recorded"
- No errors in console

**Status**: NOT TESTED

---

### EDGE-2: Session with Missing Token Data

**Setup**:

- Create test session with llm_call events missing `metadata.inputTokens` and `outputTokens`
- Load session, open Interactions tab

**Expected Result**:

- Token badges show "N/A" or "0 tokens"
- No errors in console
- Other step data renders correctly

**Status**: NOT TESTED

---

### EDGE-3: Session with Missing Guardrail Events

**Setup**:

- Create test session with no guardrail\_\* events
- Load session, open Interactions tab

**Expected Result**:

- Guardrail sections are omitted from interaction steps
- No errors in console
- Other step data renders correctly

**Status**: NOT TESTED

---

### EDGE-4: Session with Nested Object Changes in Memory

**Setup**:

- Create test session where memory state change is a nested object (e.g., `user.profile.name`)
- Load session, open Interactions tab, expand memory diff

**Expected Result**:

- Memory diff shows only top-level key change (limitation GAP-009)
- Nested changes are not visualized
- No errors in console

**Status**: NOT TESTED (known limitation)

---

## 9. Regression Test Scenarios

### REG-1: Switching Between Tabs Preserves State

**Setup**:

- Load session, open Interactions tab
- Expand 3 interaction cards
- Switch to Traces tab
- Switch back to Interactions tab

**Expected Result**:

- Previously expanded interaction cards remain expanded
- Scroll position is preserved
- No duplicate interactions rendered

**Status**: NOT TESTED

---

### REG-2: Refreshing Page Reloads Session Correctly

**Setup**:

- Load session, open Interactions tab
- Refresh browser page
- Verify Interactions tab reloads

**Expected Result**:

- Interactions tab reloads with same session
- All interactions are rendered correctly
- No errors in console

**Status**: NOT TESTED

---

## 10. Test Data Requirements

To support the E2E and integration test scenarios above, the following test data is required:

1. **Basic session**: 10 interactions, each with user_message, llm_call, tool_call, agent_response events
2. **Parallel session**: 1+ interactions with 3+ tool_call events with overlapping time ranges
3. **Scripted agent session**: 1+ interactions with flow*step_enter, flow_step_exit, flow_transition, gather*\* events
4. **Guardrail session**: 1+ interactions with guardrail_input_check and guardrail_output_check events, including pass/warn/fail cases
5. **Large session**: 100+ interactions for performance testing
6. **Very large session**: 500+ interactions for stress testing
7. **Edge case sessions**: Empty session, session with missing token data, session with missing guardrail events

---

## 11. Manual Testing Checklist

Until automated E2E tests are implemented, use this manual checklist for pre-release validation:

- [ ] Load a session with 50+ interactions and verify UI performance (smooth scrolling, instant expansion)
- [ ] Verify token badges show correct values for GPT-4, Claude, and Gemini models (cross-check with API logs)
- [ ] Verify guardrail panels show pass/warn/fail status with confidence bars (test with known guardrail failures)
- [ ] Verify memory diffs show correct added/changed/removed/unchanged keys (test with known state mutations)
- [ ] Verify swim lane timelines render parallel tool calls with dependency arrows (test with parallel execution agent)
- [ ] Verify flow breadcrumbs and mini graphs render for scripted agents (test with gather flow agent)
- [ ] Verify real-time updates append new interactions as agent responds (send message and watch tab update)
- [ ] Verify lifecycle banners (agent enter/exit, delegate, gather) render at correct positions
- [ ] Verify agent switch banners render when agent changes between interactions
- [ ] Verify session header shows correct aggregate stats (cross-check totals with raw event counts)
- [ ] Test cross-tenant isolation (attempt to load another tenant's session, verify 404)
- [ ] Test cross-project isolation (attempt to load another project's session, verify 404)
- [ ] Test error boundary (trigger JS error in event processor, verify graceful fallback UI)

---

## 12. Testing Priorities

**P0 (Blocking release)**:

- E2E-1: Load session and view interactions timeline
- E2E-2: Real-time interaction updates via WebSocket
- SEC-1, SEC-2, SEC-3: Cross-tenant, cross-project, user-owned isolation

**P1 (High priority)**:

- E2E-3: Parallel tool execution visualization
- E2E-4: Flow graph and variable resolution (scripted agent)
- E2E-5: Guardrail check results display
- PERF-1: Session with 100 interactions

**P2 (Medium priority)**:

- INT-1 through INT-5: Integration tests for event processor, token calc, memory diff, parallel detect, flow status
- PERF-2: Session with 500 interactions (with virtualization)
- EDGE-1 through EDGE-4: Edge case scenarios

**P3 (Nice to have)**:

- PERF-3: Real-time updates with 10 events/second (with batching/throttling)
- REG-1, REG-2: Regression scenarios

---

## 13. Known Test Gaps

1. **No WebSocket test harness**: Real-time update tests (E2E-2) require a WebSocket mock or test server.
2. **No test database fixtures**: Historical trace loading (E2E-1) requires pre-populated test sessions in MongoDB.
3. **No E2E test infrastructure**: No Playwright or Cypress setup for Studio UI tests.
4. **No model pricing service mock**: Token cost calculation tests require mocking the model pricing service.
5. **No performance profiling automation**: Performance tests (PERF-1, PERF-2) require automated heap snapshots and fps measurement.

---

## 14. Next Steps

1. **Set up E2E test infrastructure**: Add Playwright to Studio test suite (see `docs/testing/toolkit-guide.md`)
2. **Create test database fixtures**: Add seed scripts for test sessions with diverse event types
3. **Write E2E tests for P0 scenarios**: E2E-1, E2E-2, SEC-1, SEC-2, SEC-3
4. **Write integration tests for P1 scenarios**: INT-1 through INT-5
5. **Add WebSocket test harness**: Mock WebSocket server for real-time update testing
6. **Add performance profiling**: Automated heap snapshots and fps measurement for PERF-1, PERF-2
7. **Transition status from PLANNED to IN PROGRESS** once first E2E test is written

---

## 15. Test File Mapping

| Test File                                        | Type        | Scenarios Covered   | Status      |
| ------------------------------------------------ | ----------- | ------------------- | ----------- |
| `src/__tests__/interactions-integration.test.ts` | Integration | INT-1, INT-2, INT-6 | ✅ 11 tests |
| `e2e/interactions-tab.spec.ts`                   | E2E         | E2E-1, SEC-1, SEC-2 | ✅ 7 tests  |
| `src/__tests__/fixtures/trace-events.test.ts`    | Unit        | Fixture validation  | ✅ 18 tests |

**Summary**: 6 unit tests (existing) + 11 integration tests (Phase 2) + 7 E2E tests (Phase 4) = **24 tests total**

**Status**: **PARTIAL** — Minimum test coverage for BETA achieved. Remaining scenarios (INT-3, INT-4, INT-5, E2E-2, EDGE-\*, PERF-\*) deferred to future iterations.

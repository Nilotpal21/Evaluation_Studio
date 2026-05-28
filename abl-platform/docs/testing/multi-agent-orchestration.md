# Feature Test Guide: Multi-Agent Orchestration

**Feature**: Local handoff, delegation, fan-out/gather, completion decisioning, and multi-intent routing
**Owner**: Platform team
**Branch**: develop
**Related Feature Doc**: [docs/features/multi-agent-orchestration.md](../features/multi-agent-orchestration.md)
**First tested**: 2026-03-18
**Last updated**: 2026-04-09
**Overall status**: STABLE (unit/integration), PARTIAL (deterministic HTTP E2E on critical paths)

---

## Current State (as of 2026-04-09)

The orchestration surface has strong coverage at all tiers: 50 test files spanning unit, integration, and E2E. Four E2E suites now exercise orchestration through real runtime infrastructure: `multi-agent-orchestration.e2e.test.ts` (full lifecycle including handoff/return/PASS/MAP, thread management, fan-out, and delegation chains), `routing-phase5.e2e.test.ts` (`RETURN:true` round-trip, guided multi-intent parallel, mixed async fan-out), `child-routing-authority.e2e.test.ts` (child authority isolation), and the env-gated TravelDesk supervisor flow. The `packages/execution` package has dedicated test suites for child-session factories, fan-out barrier contracts, and Redis barrier implementation.

This guide is intentionally scoped to orchestration logic. Remote A2A protocol coverage is still tracked in [docs/testing/a2a-integration.md](./a2a-integration.md), and human-agent delivery is tracked in [docs/testing/agent-transfer.md](./agent-transfer.md). This guide now also tracks the runtime-level callback/resume contract for mixed local/remote orchestration because that regression crosses the orchestration boundary even when the underlying wire protocol is A2A.

### Quick Health Dashboard

| Area                             | Status  | Last Verified | Notes                                                                                  |
| -------------------------------- | ------- | ------------- | -------------------------------------------------------------------------------------- |
| Local handoff                    | PASS    | 2026-04-09    | `RETURN:true` round-trip covered via two independent E2E suites                        |
| Delegation                       | PASS    | 2026-04-09    | Guards, timeout, mapping, `ON_FAILURE`, depth, and delegation chains all covered       |
| Fan-out / gather                 | PASS    | 2026-04-09    | Mixed local + remote async callback/resume, parallel dispatch, and barrier contracts   |
| Completion decisioning           | PASS    | 2026-04-09    | Return-to-parent completion path asserted in live session state and trace events       |
| Handoff guardrails               | PASS    | 2026-04-09    | LLM-eval guardrail behavior covered; handoff-rails pipeline tested                     |
| Multi-intent strategy            | PASS    | 2026-04-09    | Guided parallel plan covered via HTTP E2E; other strategies remain unit/int only       |
| Live supervisor E2E              | PASS    | 2026-04-09    | 4 E2E suites (3 deterministic, 1 env-gated) cover critical orchestration paths         |
| Remote handoff / remote delegate | PARTIAL | 2026-04-09    | Unit coverage via `routing-remote-handoff.test.ts`; protocol matrix stays in A2A guide |

---

## Coverage Matrix

| FR   | Description                                            | Unit | Integration | E2E     | Manual | Status                                                                    |
| ---- | ------------------------------------------------------ | ---- | ----------- | ------- | ------ | ------------------------------------------------------------------------- |
| FR-1 | Coordination rules: handoff, delegate, fan-out, return | PASS | PASS        | PASS    | N/A    | Covered (deterministic + scripted E2E in `multi-agent-orchestration.e2e`) |
| FR-2 | Context passing, history strategy, return mapping      | PASS | PASS        | PARTIAL | N/A    | PASS/MAP covered in E2E; history strategies remain GAP-003                |
| FR-3 | Guardrails, cycle detection, timeout, self-handoff     | PASS | PASS        | PARTIAL | N/A    | Child authority E2E covers cycle; guardrail E2E remains open              |
| FR-4 | Multi-intent dispatch strategies                       | PASS | PASS        | PARTIAL | N/A    | Guided parallel E2E; other strategies remain unit/int only                |
| FR-5 | Traceable decision/lifecycle events                    | PASS | PASS        | PARTIAL | N/A    | Covered                                                                   |
| FR-6 | Fan-out concurrency bounding and session guard         | PASS | PASS        | PARTIAL | N/A    | Fan-out E2E in orchestration suite; semaphore bounding open               |
| FR-7 | Remote handoff/delegation via A2A                      | PASS | See A2A     | See A2A | N/A    | Unit via `routing-remote-handoff.test.ts`; protocol in A2A guide          |

---

## E2E Test Scenarios (MANDATORY — minimum 5)

> **Implemented today**: `apps/runtime/src/__tests__/e2e/routing-phase5.e2e.test.ts` covers a narrower but real HTTP slice for `RETURN:true` handoff round-trip, guided multi-intent execution, and mixed local + remote async fan-out callback/resume. The scenarios below still describe the broader target matrix, so several remain only partially covered.

### E2E-1: Supervisor Handoff with RETURN and Context Passing

> **Status (2026-04-09)**: Covered by two E2E suites. `multi-agent-orchestration.e2e.test.ts` validates handoff/return/PASS/MAP/thread management with structural assertions. `routing-phase5.e2e.test.ts` validates `RETURN:true` round-trip via public HTTP. PASS-field propagation is asserted; history strategy variants remain open (GAP-003).

**Preconditions**: Runtime server started on random port. Tenant, project, and deployment created via API. Two scripted agents deployed: `supervisor` with `HANDOFF TO: specialist RETURN: true CONTEXT: { PASS: [customer_id] }`, and `specialist` with `GATHER` + `COMPLETE`.

**Steps**:

1. `POST /api/v1/sdk/init` — Create SDK session with tenant credentials.
2. `POST /api/v1/sdk/chat` — Send message triggering supervisor's handoff condition.
3. Assert response contains specialist's initial prompt (thread switch occurred).
4. `POST /api/v1/sdk/chat` — Provide specialist's required gather field.
5. Assert response contains specialist's completion message.
6. `GET /api/projects/:projectId/sessions/:sessionId` — Verify session has 2+ threads; specialist thread status is `completed`; supervisor thread status transitioned from `waiting` back to `active`; PASS fields (`customer_id`) present in specialist thread's `handoffContext`.

**Expected Result**: Supervisor hands off to specialist, specialist completes, control returns to supervisor. PASS fields correctly propagated. Return mapping applied.

**Auth Context**: Tenant A, Project P1, User U1 (SDK session token).

**Isolation Check**: Repeat step 6 with Tenant B credentials — returns 404.

### E2E-2: Delegate Execution with INPUT/RETURNS Mapping and ON_FAILURE

**Preconditions**: Runtime server started. Agents deployed: `parent_agent` with `DELEGATE AGENT: lookup_agent PURPOSE: "Fetch status" INPUT: { id: customer_id } RETURNS: { status: account_status } ON_FAILURE: continue`, and `lookup_agent` that completes with a `status` result.

**Steps**:

1. `POST /api/v1/sdk/init` — Create session.
2. `POST /api/v1/sdk/chat` — Send message that triggers delegate condition.
3. Assert response includes delegate result merged into parent's data store.
4. `GET /api/projects/:projectId/sessions/:sessionId` — Verify `delegateStack` is empty (delegate completed), parent thread has `account_status` in `data.values`.
5. Repeat with a deployment where `lookup_agent` times out — verify parent receives `ON_FAILURE: continue` behavior (parent continues without result, no error bubble).

**Expected Result**: Delegate executes as subroutine, maps results back to parent via `RETURNS`, cleans up delegate stack. Timeout path exercises `ON_FAILURE: continue`.

**Auth Context**: Tenant A, Project P1, User U1.

**Isolation Check**: Cross-project session access returns 404.

### E2E-3: Fan-Out with Multiple Agents and Bounded Concurrency

> **Status (2026-04-09)**: Fan-out dispatch is covered by `multi-agent-orchestration.e2e.test.ts` (parallel dispatch to multiple specialists) and `routing-phase5.e2e.test.ts` (mixed local + remote async callback/resume). Semaphore bounding and same-session guard assertions remain unimplemented.

**Preconditions**: Runtime server started. Supervisor agent deployed with fan-out configuration targeting 3 sub-agents. `CountingSemaphore` capacity set to 2 (via config override).

**Steps**:

1. `POST /api/v1/sdk/init` — Create session.
2. `POST /api/v1/sdk/chat` — Send message triggering fan-out dispatch.
3. Assert fan-out executes (response includes aggregated results from all 3 sub-agents).
4. `GET /api/projects/:projectId/sessions/:sessionId` — Verify all fan-out threads completed, no orphaned threads in `waiting` or `active` state.
5. `GET /api/projects/:projectId/sessions/:sessionId/traces` — Verify `fan_out_start`, `fan_out_task_start` (x3), and `fan_out_complete` trace events emitted with correct task counts.

**Expected Result**: Fan-out respects semaphore capacity (max 2 concurrent), all 3 tasks complete, results aggregated, cleanup releases guards.

**Auth Context**: Tenant A, Project P1, User U1.

**Isolation Check**: Concurrent fan-out from same session is rejected by `_activeFanOutSessions` guard.

### E2E-4: Cycle Detection and Self-Handoff Rejection

**Preconditions**: Runtime server started. Three agents deployed: `A`, `B`, `C`. `A` hands off to `B`, `B` hands off to `C`, `C` attempts to hand off back to `A`.

**Steps**:

1. `POST /api/v1/sdk/init` — Create session with entry agent `A`.
2. `POST /api/v1/sdk/chat` — Trigger A -> B handoff.
3. `POST /api/v1/sdk/chat` — Trigger B -> C handoff.
4. `POST /api/v1/sdk/chat` — Trigger C -> A handoff attempt.
5. Assert response contains cycle detection error: `"Handoff cycle detected: A → B → C → A"`.
6. `POST /api/v1/sdk/chat` — Trigger agent attempting self-handoff.
7. Assert response contains self-handoff rejection: `"Cannot hand off to yourself"`.

**Expected Result**: Cycle detection via `handoffStack` blocks A -> B -> C -> A cycle. Self-handoff blocked with clear error.

**Auth Context**: Tenant A, Project P1, User U1.

**Isolation Check**: N/A (safety invariant test).

### E2E-5: Multi-Intent Dispatch with Primary Queue Strategy

> **Status (2026-04-09)**: A guided `parallel` supervisor variant is implemented via public HTTP. `primary_queue`, `sequential`, and `disambiguate` remain planned E2E expansions.

**Preconditions**: Runtime server started. Supervisor agent deployed with `intent_handling: { multi_intent: { enabled: true, strategy: primary_queue, max_intents: 3 } }`. Sub-agents `billing` and `shipping` deployed.

**Steps**:

1. `POST /api/v1/sdk/init` — Create session.
2. `POST /api/v1/sdk/chat` — Send multi-intent message: "I need to check my bill and track my shipment".
3. Assert primary intent (`billing`) is routed first.
4. Complete billing agent's flow.
5. Assert queued intent (`shipping`) is surfaced after primary completion.
6. `GET /api/projects/:projectId/sessions/:sessionId` — Verify `intentQueue` was populated and then drained.
7. `GET /api/projects/:projectId/sessions/:sessionId/traces` — Verify `decision` trace event with `kind: multi_intent` and strategy `primary_queue`.

**Expected Result**: Primary intent handled first, alternative intent queued via `intent-queue.ts`, surfaced after primary completion.

**Auth Context**: Tenant A, Project P1, User U1.

**Isolation Check**: Cross-tenant session access returns 404.

### E2E-6: Handoff Guardrail Blocks Transfer

**Preconditions**: Runtime server started. Supervisor agent deployed with handoff guardrail (`kind: handoff`) that blocks transfers containing sensitive keywords. Specialist agent deployed.

**Steps**:

1. `POST /api/v1/sdk/init` — Create session.
2. `POST /api/v1/sdk/chat` — Trigger handoff with context containing blocked content.
3. Assert response contains guardrail violation message (handoff blocked).
4. `GET /api/projects/:projectId/sessions/:sessionId/traces` — Verify `guardrail_handoff_blocked` trace event emitted.
5. `POST /api/v1/sdk/chat` — Trigger handoff with clean context.
6. Assert handoff succeeds (specialist responds).

**Expected Result**: Guardrail blocks handoff with sensitive context. Clean context passes guardrail and handoff proceeds.

**Auth Context**: Tenant A, Project P1, User U1.

**Isolation Check**: Guardrail evaluation uses tenant-scoped providers via `ensureTenantProvidersLoaded`.

### E2E-7: Completion Condition Evaluation and Return-to-Parent

**Preconditions**: Runtime server started. Supervisor with `RETURN: true` handoff to child agent. Child agent has `COMPLETION: CONDITIONS: - WHEN: task_done == true RESPOND: "Task complete"`.

**Steps**:

1. `POST /api/v1/sdk/init` — Create session.
2. `POST /api/v1/sdk/chat` — Trigger handoff to child.
3. `POST /api/v1/sdk/chat` — Provide input that sets `task_done = true`.
4. Assert response contains "Task complete" (completion condition matched).
5. `GET /api/projects/:projectId/sessions/:sessionId` — Verify child thread status is `completed`, parent thread resumed to `active`, `threadStack` is empty.
6. `GET /api/projects/:projectId/sessions/:sessionId/traces` — Verify `completion_check`, `return_to_parent`, and `thread_return` trace events emitted.

**Expected Result**: Completion condition triggers, child returns to parent, parent resumes.

**Auth Context**: Tenant A, Project P1, User U1.

**Isolation Check**: Session detail for wrong projectId returns 404.

---

## Integration Test Scenarios (MANDATORY — minimum 5)

### INT-1: Thread Creation and PASS Field Propagation

**Boundary**: `RoutingExecutor.handleHandoff()` + `types.ts` thread helpers + `RuntimeSession`

**Setup**: In-memory session with supervisor IR containing `HANDOFF` config with `PASS: [customer_id, issue_type]`. Mock agent registry with target agent entry.

**Steps**:

1. Populate parent thread `data.values` with `{ customer_id: "C123", issue_type: "billing" }`.
2. Call `handleHandoff(session, { target: "specialist", context: {} })`.
3. Verify new thread created in `session.threads` with `agentName: "specialist"`.
4. Verify `handoffContext` contains `customer_id: "C123"` and `issue_type: "billing"`.
5. Verify parent thread status is `waiting` (when `return: true`) or `completed` (when `return: false`).

**Expected Result**: Thread created, PASS fields propagated, parent thread status correct.

**Failure Mode**: If target agent is not in registry, `handleHandoff` returns `{ success: false, error: "Agent not found" }`.

### INT-2: Delegate Depth and Cycle Protection

**Boundary**: `RoutingExecutor.handleDelegate()` + `delegateStack` + `MAX_DELEGATE_DEPTH`

**Setup**: Session with `delegateStack` containing 9 entries (approaching `MAX_DELEGATE_DEPTH = 10`).

**Steps**:

1. Call `handleDelegate` with a 10th delegate target — verify it succeeds (at limit).
2. Call `handleDelegate` with an 11th — verify it fails with depth exceeded error.
3. Push `"agent_A"` onto `delegateStack`. Attempt to delegate to `"agent_A"` — verify cycle detection rejects it.

**Expected Result**: Max depth enforced at 10. Cycle detection works for delegate chains.

**Failure Mode**: Delegate beyond depth limit returns error without execution.

### INT-3: Multi-Intent Strategy Resolution

**Boundary**: `resolveStrategy()` in `multi-intent-strategy.ts`

**Setup**: Pure function testing — no server needed.

**Steps**:

1. `resolveStrategy('auto', 'supervisor', 'independent')` — returns `'parallel'`.
2. `resolveStrategy('auto', 'scripted', 'independent')` — returns `'sequential'` (downgrade).
3. `resolveStrategy('auto', 'reasoning', 'ambiguous')` — returns `'disambiguate'`.
4. `resolveStrategy('parallel', 'scripted', 'independent')` — returns `'sequential'` (downgrade).
5. `resolveStrategy('primary_queue', 'scripted', 'dependent')` — returns `'primary_queue'` (pass-through).

**Expected Result**: Strategy resolution follows documented rules for agent type and intent relationship.

**Failure Mode**: N/A — pure function.

### INT-4: History Strategy Application on Handoff

**Boundary**: `RoutingExecutor.handleHandoff()` + thread history seeding

**Setup**: Session with parent thread containing 10 conversation history entries. Handoff config with `history: last_3`.

**Steps**:

1. Call `handleHandoff` with `history: 'none'` — verify child thread starts with empty history.
2. Call `handleHandoff` with `history: 'full'` — verify child thread receives all 10 parent messages.
3. Call `handleHandoff` with `history: 'last_3'` — verify child thread receives last 3 messages.
4. Call `handleHandoff` with `history: 'summary_only'` — verify child thread receives only the SUMMARY text.
5. Call `handleHandoff` with `history: 'auto'` and no handoff summary for a scripted target — verify child thread falls back to bounded raw history instead of losing context.

**Expected Result**: Each history strategy produces the correct conversation history in the child thread.

**Failure Mode**: Missing history strategy defaults to `'auto'`, which uses summary-only transfer when safe and otherwise falls back to bounded raw history.

### INT-5: Fan-Out Concurrent Guard and Cleanup

**Boundary**: `RoutingExecutor.handleFanOut()` + `_activeFanOutSessions` + `CountingSemaphore`

**Setup**: Session with fan-out configuration targeting 3 sub-agents. Semaphore capacity = 2.

**Steps**:

1. Call `handleFanOut` — verify `_activeFanOutSessions` adds the session ID.
2. While fan-out is running, call `handleFanOut` again for same session — verify rejection (concurrent guard).
3. After fan-out completes, verify `_activeFanOutSessions` no longer contains the session ID.
4. Verify semaphore was acquired before each branch and released after (even on failure).
5. Simulate partial failure (2 succeed, 1 fails) — verify aggregate result contains both successes and the failure.

**Expected Result**: Concurrent guard prevents overlapping fan-out. Semaphore limits concurrency. Cleanup always runs.

**Failure Mode**: Fan-out with same session ID rejected with error. Semaphore timeout returns error.

### INT-6: Session Metadata Extraction on Handoff

**Boundary**: `extractSessionMetadata()` in `routing-executor.ts`

**Setup**: Parent thread `data.values` with internal keys (`_internal`), handoff tracking keys (`handoff_from`), gather field names, null values, and valid metadata.

**Steps**:

1. Call `extractSessionMetadata(parentValues, gatherFieldNames)`.
2. Verify internal keys (prefixed with `_`) are excluded.
3. Verify `handoff_from` is excluded.
4. Verify gather field names are excluded.
5. Verify null/undefined/empty string values are excluded.
6. Verify valid metadata keys are included.

**Expected Result**: Only non-internal, non-tracking, non-gather, non-empty values pass through.

**Failure Mode**: N/A — pure function.

### INT-7: Handoff Guardrail Pipeline Integration

**Boundary**: `RoutingExecutor.handleHandoff()` + `GuardrailPipeline` + `session-policy.ts`

**Setup**: Session with handoff guardrails configured. Mock guardrail pipeline.

**Steps**:

1. Configure a handoff guardrail that returns `passed: false` with a violation message.
2. Call `handleHandoff` — verify handoff is blocked with the violation message.
3. Configure a guardrail that returns `passed: true` with `modifiedContent` (redacted context).
4. Call `handleHandoff` — verify handoff proceeds with the modified context.
5. Configure a guardrail that throws an error — verify fail-open behavior (handoff proceeds).

**Expected Result**: Guardrails can block, modify, or fail-open on handoff.

**Failure Mode**: Guardrail error triggers fail-open with warning log and trace event.

---

## Unit Test Scenarios

### UNIT-1: Timeout Parsing

**Module**: `parseTimeout()` in `routing-executor.ts`
**Input**: `"10s"`, `"5m"`, `"1h"`, `"invalid"`, `undefined`
**Expected Output**: `10000`, `300000`, `3600000`, `undefined`, `undefined`

### UNIT-2: Return Mapping Application

**Module**: `applyReturnMapping()` in `routing-executor.ts`
**Input**: Child result `{ billing_resolution: "refund" }`, mapping `{ resolution: "billing_resolution" }`
**Expected Output**: Parent data updated with `{ resolution: "refund" }`

### UNIT-3: Content-to-String Extraction

**Module**: `contentToString()` in `routing-executor.ts`
**Input**: `[{ type: 'text', text: 'Hello' }, { type: 'image', url: '...' }]`
**Expected Output**: `"Hello"` (text blocks only, joined by newline)

---

## Security & Isolation Tests

- [x] Cross-tenant session access returns 404 — via session service tenant scoping
- [x] Cross-project session access returns 404 — via project-scoped routes
- [ ] Cross-user session access returns 404 for user-owned sessions
- [x] Missing auth returns 401 — via `requireAuth` middleware
- [x] Insufficient permissions returns 403 — via `requireProjectPermission`
- [x] Input validation rejects malformed handoff targets (empty string, invalid agent name)
- [x] SSRF validation on remote agent endpoint registration (`assertUrlSafeForSSRF`)

---

## Performance & Load Tests

- [ ] Fan-out with maximum semaphore capacity (10 concurrent branches) under sustained load
- [ ] Handoff chain depth at `MAX_DELEGATE_DEPTH` (10 levels) response time
- [ ] Multi-intent dispatch with `max_intents: 3` and queue drain latency

---

## Test Infrastructure

- **Required services**: MongoDB (or MongoMemoryServer for E2E harness), Redis (for execution queue and fan-out barriers)
- **Data seeding**: Agent ABL fixtures via `/api/projects/:id/project-io/import`, deployment activation via `POST /api/projects/:id/deployments`
- **Environment variables**: LLM provider credentials (for env-gated real-provider tests only)
- **CI configuration**: Deterministic E2E tests run unconditionally; live-LLM tests gated by `OPENAI_API_KEY` presence

---

## Test File Inventory

> Paths updated 2026-04-09. Tests reorganized into `routing/` and `execution/` subdirectories. `flow-handoff-threads.test.ts` was absorbed into `multi-agent-orchestration.e2e.test.ts`.

| File                                                                                 | Type        | Covers                                                                          | Status           |
| ------------------------------------------------------------------------------------ | ----------- | ------------------------------------------------------------------------------- | ---------------- |
| `apps/runtime/src/__tests__/multi-agent-orchestration.e2e.test.ts`                   | E2E         | FR-1, FR-2, FR-6 (handoff/return/PASS/MAP, threads, fan-out, delegation chains) | PASS             |
| `apps/runtime/src/__tests__/e2e/routing-phase5.e2e.test.ts`                          | E2E         | FR-1, FR-4, FR-5, FR-6                                                          | PASS             |
| `apps/runtime/src/__tests__/e2e/child-routing-authority.e2e.test.ts`                 | E2E         | FR-3 (child cannot inherit undeclared authority)                                | PASS             |
| `apps/runtime/src/__tests__/traveldesk-supervisor-ws-flow.e2e.test.ts`               | E2E         | FR-1, FR-5 (real-provider supervisor flow)                                      | PASS (env-gated) |
| `apps/runtime/src/__tests__/execution/thread-resume.test.ts`                         | Unit        | FR-1 (return-to-parent tool, resume helpers)                                    | PASS             |
| `apps/runtime/src/__tests__/execution/thread-resume-integration.test.ts`             | Integration | FR-1 (full round-trip thread resume)                                            | PASS             |
| `apps/runtime/src/__tests__/routing/routing-delegate-failures.test.ts`               | Unit        | FR-1, FR-3 (delegate guards, timeout, mapping)                                  | PASS             |
| `apps/runtime/src/__tests__/routing/delegate-safety.test.ts`                         | Unit        | FR-3 (delegate safety invariants, depth guards)                                 | PASS             |
| `apps/runtime/src/__tests__/routing/delegate-field-hints.test.ts`                    | Unit        | FR-2 (delegate field hint resolution)                                           | PASS             |
| `apps/runtime/src/__tests__/routing/routing-fanout-failures.test.ts`                 | Unit        | FR-1, FR-6 (fan-out cleanup, guard, dedupe)                                     | PASS             |
| `apps/runtime/src/__tests__/routing/fan-out-bug-fixes.test.ts`                       | Unit        | FR-6 (fan-out regression guards)                                                | PASS             |
| `apps/runtime/src/__tests__/routing/fan-out-parallel.test.ts`                        | Unit        | FR-6 (parallel fan-out dispatch)                                                | PASS             |
| `apps/runtime/src/__tests__/fan-out.test.ts`                                         | Unit        | FR-6 (core fan-out mechanics)                                                   | PASS             |
| `apps/runtime/src/__tests__/routing/routing-conditions.test.ts`                      | Unit        | FR-1, FR-5 (condition evaluation)                                               | PASS             |
| `apps/runtime/src/__tests__/routing/routing-executor-unit.test.ts`                   | Unit        | FR-1, FR-2 (parsing, mapping, complete)                                         | PASS             |
| `apps/runtime/src/__tests__/routing/routing-executor-helpers.test.ts`                | Unit        | FR-1 (routing executor helper functions)                                        | PASS             |
| `apps/runtime/src/__tests__/routing/routing-executor-metadata-propagation.test.ts`   | Unit        | FR-2 (metadata propagation across handoff boundaries)                           | PASS             |
| `apps/runtime/src/__tests__/routing/routing-executor-multi-intent.test.ts`           | Unit        | FR-4 (strategy precedence, dispatch)                                            | PASS             |
| `apps/runtime/src/__tests__/routing/routing-remote-handoff.test.ts`                  | Unit        | FR-7 (remote handoff target resolution)                                         | PASS             |
| `apps/runtime/src/__tests__/routing/multi-intent-router.test.ts`                     | Unit        | FR-4 (multi-intent plan creation)                                               | PASS             |
| `apps/runtime/src/__tests__/routing/multi-intent-integration.test.ts`                | Integration | FR-4 (shared planning and queue semantics)                                      | PASS             |
| `apps/runtime/src/__tests__/routing/multi-intent-executor-integration.test.ts`       | Integration | FR-4 (reasoning/flow/router execution parity)                                   | PASS             |
| `apps/runtime/src/__tests__/routing/multi-intent-dispatch-wiring.test.ts`            | Unit        | FR-4 (dispatch wiring and target resolution)                                    | PASS             |
| `apps/runtime/src/__tests__/routing/multi-intent-strategy.test.ts`                   | Unit        | FR-4 (strategy resolution rules)                                                | PASS             |
| `apps/runtime/src/__tests__/routing/async-fanout-coordinator.test.ts`                | Unit        | FR-6 (branch registration, continuation contract)                               | PASS             |
| `apps/runtime/src/__tests__/routing/async-fanout-execution.test.ts`                  | Integration | FR-6 (mixed local + remote async fan-out)                                       | PASS             |
| `apps/runtime/src/__tests__/routing/async-fanout-resumption.test.ts`                 | Integration | FR-6 (parent resume, duplicate callbacks, timeout)                              | PASS             |
| `apps/runtime/src/__tests__/routing/routing-capabilities.test.ts`                    | Unit        | FR-1 (IR-derived handoff/delegate authority)                                    | PASS             |
| `apps/runtime/src/__tests__/execution/agent-activation-context.test.ts`              | Unit        | FR-1 (child activation, auth, LLM/tool rewiring)                                | PASS             |
| `apps/runtime/src/__tests__/execution/reasoning-pipeline-bridge.test.ts`             | Integration | FR-4 (guided pipeline signals to multi-intent)                                  | PASS             |
| `apps/runtime/src/__tests__/execution/reasoning-pipeline-contract.test.ts`           | Integration | FR-4 (reasoning pipeline contract)                                              | PASS             |
| `apps/runtime/src/__tests__/execution/reasoning-gather-handoff.test.ts`              | Integration | FR-1 (reasoning + gather + handoff)                                             | PASS             |
| `apps/runtime/src/__tests__/execution/handoff-resume-intent.test.ts`                 | Integration | FR-1 (handoff resume with intent context)                                       | PASS             |
| `apps/runtime/src/__tests__/execution/handoff-return-propagation-regression.test.ts` | Unit        | FR-1, FR-2 (return propagation regression guard)                                | PASS             |
| `apps/runtime/src/__tests__/execution/project-config-handoff.test.ts`                | Integration | FR-1 (project config influence on handoff)                                      | PASS             |
| `apps/runtime/src/__tests__/execution/scripted-mode-handoff-fix.unit.test.ts`        | Unit        | FR-1 (scripted-mode handoff edge case)                                          | PASS             |
| `apps/runtime/src/__tests__/execution/runtime-completion.test.ts`                    | Unit        | FR-1 (completion detection)                                                     | PASS             |
| `apps/runtime/src/__tests__/execution/guardrails/handoff-rails.test.ts`              | Unit        | FR-3 (handoff guardrail evaluation pipeline)                                    | PASS             |
| `apps/runtime/src/services/execution/__tests__/handoff-guardrail-llmeval.test.ts`    | Unit        | FR-3 (guardrail block/mutate/fail-open)                                         | PASS             |
| `apps/runtime/src/__tests__/execution/pre-refactor/completion-conditions.test.ts`    | Unit        | FR-1 (completion condition evaluation)                                          | PASS             |
| `apps/runtime/src/__tests__/execution/pre-refactor/completion-delegation.test.ts`    | Unit        | FR-1 (completion delegation flow)                                               | PASS             |
| `apps/runtime/src/__tests__/execution/pre-refactor/completion-detection.test.ts`     | Unit        | FR-1 (completion detection logic)                                               | PASS             |
| `apps/runtime/src/__tests__/execution/pre-refactor/handoff-delegate-fanout.test.ts`  | Unit        | FR-1, FR-6 (handoff + delegate + fan-out combined)                              | PASS             |
| `apps/runtime/src/__tests__/execution/pre-refactor/handoff-delegation.test.ts`       | Unit        | FR-1 (handoff to delegation flow)                                               | PASS             |
| `apps/runtime/src/__tests__/on-input-multi-intent-invariant.test.ts`                 | Unit        | FR-4 (on-input multi-intent invariants)                                         | PASS             |
| `apps/runtime/src/__tests__/pipeline-routing-resolver.test.ts`                       | Unit        | FR-1 (pipeline routing resolver)                                                | PASS             |
| `packages/execution/src/__tests__/child-session.test.ts`                             | Unit        | FR-1 (child-session factories)                                                  | PASS             |
| `packages/execution/src/__tests__/fan-out-barrier-contract.test.ts`                  | Unit        | FR-6 (barrier contract, idempotent completion)                                  | PASS             |
| `packages/execution/src/__tests__/in-memory-fan-out-barrier.test.ts`                 | Unit        | FR-6 (in-memory barrier impl)                                                   | PASS             |
| `packages/execution/src/__tests__/redis-fan-out-barrier.test.ts`                     | Unit        | FR-6 (Redis barrier, duplicate-completion protection)                           | PASS             |

---

## Test File Mapping (Planned)

Current deterministic coverage is consolidated in `apps/runtime/src/__tests__/e2e/routing-phase5.e2e.test.ts`. The files below remain valid future split-outs if the suite is later decomposed by scenario.

| Test File (Planned)                                                      | Type | Covers     |
| ------------------------------------------------------------------------ | ---- | ---------- |
| `apps/runtime/src/__tests__/orchestration-handoff-return.e2e.test.ts`    | E2E  | FR-1, FR-2 |
| `apps/runtime/src/__tests__/orchestration-delegate-failure.e2e.test.ts`  | E2E  | FR-1, FR-3 |
| `apps/runtime/src/__tests__/orchestration-fanout-bounded.e2e.test.ts`    | E2E  | FR-1, FR-6 |
| `apps/runtime/src/__tests__/orchestration-cycle-detection.e2e.test.ts`   | E2E  | FR-3       |
| `apps/runtime/src/__tests__/orchestration-multi-intent.e2e.test.ts`      | E2E  | FR-4       |
| `apps/runtime/src/__tests__/orchestration-guardrail-handoff.e2e.test.ts` | E2E  | FR-3       |
| `apps/runtime/src/__tests__/orchestration-completion-return.e2e.test.ts` | E2E  | FR-1, FR-5 |

---

## Open Testing Questions

1. Should the deterministic E2E harness use scripted flow agents (no LLM) for all E2E scenarios, or should some require real provider credentials?
2. Is MongoMemoryServer sufficient for E2E test isolation, or should tests use a shared Docker MongoDB instance?
3. Should fan-out E2E tests control the semaphore capacity via test configuration to make concurrency behavior deterministic?

---

## Recommended Next Tests

1. Expand the existing handoff-return E2E to assert PASS/context propagation and history strategies.
2. Add deterministic E2E for delegate with INPUT/RETURNS and `ON_FAILURE` (E2E-2).
3. Add deterministic E2E for cycle detection and self-handoff rejection (E2E-4).
4. Add deterministic E2E for `primary_queue`, `sequential`, and `disambiguate` multi-intent strategies.
5. Add deterministic semaphore-bounded fan-out E2E with same-session guard assertions.

---

## References

- Related feature doc: [docs/features/multi-agent-orchestration.md](../features/multi-agent-orchestration.md)
- Related coverage guides: [docs/testing/a2a-integration.md](./a2a-integration.md), [docs/testing/agent-transfer.md](./agent-transfer.md)
- E2E test suite HLD: `docs/specs/multi-agent-orchestration-e2e.hld.md`

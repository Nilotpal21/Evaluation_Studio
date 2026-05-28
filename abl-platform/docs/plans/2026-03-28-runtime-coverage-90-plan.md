# LLD: Runtime Coverage 90+ Plan

**Package**: `apps/runtime`
**Status**: Proposed
**Date**: 2026-03-28

---

## Executive Summary

`apps/runtime` already has a large test surface, but the coverage gate is still extremely low at `14% lines / 12% branches / 17% functions` in [coverage-thresholds.json](../../coverage-thresholds.json). The biggest gaps are not "no tests at all"; they are:

1. The most important route and session suites are excluded from the default coverage lane.
2. The largest runtime files are orchestration-heavy monoliths, so a lot of behavior is still unmeasured.
3. Existing tests are unevenly distributed: many narrow regressions exist, but several end-to-end contracts are not encoded as durable scenario matrices.

The goal of this plan is to get `apps/runtime` to **honest** `90%+` coverage by testing expected product behavior, isolation guarantees, and trace contracts. The goal is **not** to game coverage with file exclusions or implementation-shaped tests.

---

## Non-Negotiables

### 1. Behavior-first testing

Tests must assert product contracts:

- status codes
- response shapes
- session state transitions
- trace emission
- persistence side effects
- tenant/project/user concealment rules

Do **not** optimize for private method coverage or "function X was called once" unless the call itself is the contract.

### 2. No hot-file exclusions

Do not exclude these files from coverage just to move the number:

- `src/server.ts`
- `src/routes/chat.ts`
- `src/routes/sessions.ts`
- `src/services/runtime-executor.ts`
- `src/services/execution/flow-step-executor.ts`
- `src/services/execution/routing-executor.ts`
- `src/services/execution/reasoning-executor.ts`
- `src/websocket/handler.ts`
- `src/websocket/sdk-handler.ts`

### 3. Stable coverage lane

The coverage gate must be based on deterministic suites only. Live LLM tests, live voice tests, and intentionally flaky resource-heavy tests can stay outside the gate, but the gate itself must include the route and contract tests that define runtime behavior.

### 4. Black-box when possible

For HTTP and WebSocket behavior, prefer real Express/WebSocket harnesses over internal mocks. For E2E, follow the existing repo rule: no mocking codebase components, no direct DB assertions when the API can express the contract.

### 5. Ratchet only after proving stability

Coverage thresholds should rise only after the new lane is green in CI and locally for at least one full pass of `build -> test:coverage -> coverage:check`.

---

## Current Snapshot

### Current runtime gate

| Metric    | Current Gate |
| --------- | ------------ |
| Lines     | 14%          |
| Branches  | 12%          |
| Functions | 17%          |

Source: [coverage-thresholds.json](../../coverage-thresholds.json)

### Current coverage collection

The runtime coverage config includes `src/**/*.ts` and excludes only `src/__tests__/**`, which is good. The bigger issue is that the default test lane omits several important suites from the run itself in [apps/runtime/vitest.config.ts](../../apps/runtime/vitest.config.ts).

Excluded from the default lane today:

- `session-service.test.ts`
- `session-ttl-dynamic.test.ts`
- `chat-routes.test.ts`
- `session-routes.test.ts`
- `user-isolation.integration.test.ts`
- `llm-queue-distributed.test.ts`
- `redis-connection-cleanup.test.ts`

The integration config also segregates some of those suites in [apps/runtime/vitest.integration.config.ts](../../apps/runtime/vitest.integration.config.ts), which means runtime's most important contract tests do not naturally contribute to the default coverage gate.

### Largest runtime hotspots

| File                                           |  LOC | Existing coverage posture                                                                    |
| ---------------------------------------------- | ---: | -------------------------------------------------------------------------------------------- |
| `src/services/execution/flow-step-executor.ts` | 5002 | Several narrow regression tests, but no complete node/branch contract matrix                 |
| `src/services/execution/routing-executor.ts`   | 4571 | Good targeted suites exist, but branch matrix is incomplete                                  |
| `src/websocket/handler.ts`                     | 3956 | Some tests exist, but reconnect, backpressure, auth, and close semantics are fragmented      |
| `src/websocket/sdk-handler.ts`                 | 3576 | SDK behavior is partially covered, but continuity/auth/error contracts are not fully encoded |
| `src/services/runtime-executor.ts`             | 3344 | Core tests exist, but session lifecycle and persistence/tracing matrices are incomplete      |
| `src/services/execution/reasoning-executor.ts` | 3236 | Guard and streaming tests exist, but tool-loop and fallback matrices remain thin             |
| `src/routes/sessions.ts`                       | 2909 | Contract suite exists now, but should be split and expanded by responsibility                |
| `src/server.ts`                                | 2250 | Mostly indirect coverage; startup/shutdown/registration contracts are still under-specified  |
| `src/routes/chat.ts`                           | 1618 | Route contract tests exist, but should be deepened around continuity, quotas, and metrics    |

---

## Coverage Architecture

### Phase 0: Build a Coverage Lane That Measures the Right Things

Before raising thresholds, add a dedicated runtime coverage lane that runs deterministic contract suites even if they are excluded from the default fast lane.

### Proposed scripts

Add these runtime scripts:

- `test:coverage:stable`
- `test:coverage:contracts`
- `coverage:runtime:check`

### Proposed lane design

| Lane                      | Purpose                     | Includes                                                                                                                                                     | Excludes                                      |
| ------------------------- | --------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------ | --------------------------------------------- |
| `test:coverage:stable`    | Main coverage gate          | Stable unit + contract + route + session suites                                                                                                              | Live LLM, live voice, known benchmark scripts |
| `test:coverage:contracts` | High-value serial contracts | `chat-routes`, `session-routes`, `user-isolation.integration`, `session-service`, `session-ttl-dynamic`, `llm-queue-distributed`, `redis-connection-cleanup` | Live-only suites                              |
| `test:e2e`                | Non-gating confidence       | Real API/WS/E2E suites                                                                                                                                       | None                                          |

### Coverage reporting requirements

- Single runtime coverage summary written to `apps/runtime/coverage/coverage-summary.json`
- Coverage gate runs after `pnpm --filter @agent-platform/runtime build`
- Threshold enforcement continues to use `pnpm coverage:check`
- Do not merge in live-only suites to inflate the number

---

## Workstream A: Route and API Contract Coverage

This workstream should land first because it gives the highest confidence with the least implementation coupling.

### Target files and suites

| Runtime File             | Existing Suites                                                         | New or Expanded Suites                                                                                                                                                        |
| ------------------------ | ----------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `src/routes/chat.ts`     | `chat-routes.test.ts`, `chat-session-ownership.test.ts`                 | `chat-routes.resume-access.test.ts`, `chat-routes.deployment-resolution.test.ts`, `chat-routes.quota-and-rate-limit.test.ts`, `chat-routes.metrics-and-traces.test.ts`        |
| `src/routes/sessions.ts` | `session-routes.test.ts`, `sessions-authz.test.ts`, trace helper suites | `session-routes.list-detail-contract.test.ts`, `session-routes.trace-contract.test.ts`, `session-routes.mutations-contract.test.ts`, `session-routes.export-contract.test.ts` |
| `src/server.ts`          | `health-endpoint.test.ts`, indirect harness coverage                    | `server-bootstrap.test.ts`, `server-shutdown.test.ts`, `server-route-registration.test.ts`, `server-health-readiness-contract.test.ts`                                        |

### Contracts to encode

For chat:

- validation failures
- project not found / concealment
- runtime unavailable
- deployment retired / resolver failures
- new session creation
- resumed session ownership
- quota rejection
- per-session message rate limiting
- trace and metrics side effects

For sessions:

- list filters, pagination, ghost-session filtering
- session detail resolution by DB id and runtime id
- cross-project concealment
- trace hydration and dedupe
- reset, delete, close, and export behavior
- no fallback to unauthorized live sessions

For server:

- startup ordering
- route registration presence
- health/readiness status behavior
- shutdown idempotency
- cleanup hooks always running on shutdown

---

## Workstream B: Runtime Executor Contract Matrix

This is the biggest leverage point for truthful coverage because `runtime-executor.ts` orchestrates the main turn lifecycle.

### Target files and suites

| Runtime File                       | Existing Suites                                                                                       | New or Expanded Suites                                                                                                                                                                                                                 |
| ---------------------------------- | ----------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `src/services/runtime-executor.ts` | `runtime-executor.test.ts`, `runtime-executor-error-paths.test.ts`, `flow-execution-coverage.test.ts` | `runtime-executor-session-lifecycle.test.ts`, `runtime-executor-trace-contract.test.ts`, `runtime-executor-persistence-contract.test.ts`, `runtime-executor-distributed-resume.test.ts`, `runtime-executor-handoff-escalation.test.ts` |

### Contracts to encode

- create/load/resume/end session
- already-complete session behavior
- handoff and escalation actions
- tool-call propagation
- trace event emission
- persistence and cleanup hooks
- distributed resume and continuity rules
- failure surfaces returned to callers

---

## Workstream C: Decision Engine Coverage

This workstream is where branch coverage climbs the fastest.

### Target files and suites

| Runtime File                                   | Existing Suites                                                                                                                                                                                   | New or Expanded Suites                                                                                                                                                                                        |
| ---------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `src/services/execution/routing-executor.ts`   | `routing-executor-unit.test.ts`, `routing-executor-multi-intent.test.ts`, `routing-executor-metadata-propagation.test.ts`, `routing-executor-helpers.test.ts`                                     | `routing-executor-threshold-contract.test.ts`, `routing-executor-decision-contract.test.ts`, `routing-executor-guardrails.test.ts`, `routing-executor-failure-recovery.test.ts`                               |
| `src/services/execution/reasoning-executor.ts` | `reasoning-executor-guards.test.ts`, `reasoning-executor-streaming.test.ts`, `reasoning-executor-reason-fallback.test.ts`                                                                         | `reasoning-executor-tool-loop.test.ts`, `reasoning-executor-thinking-budget.test.ts`, `reasoning-executor-provider-fallback.test.ts`, `reasoning-executor-error-surface.test.ts`                              |
| `src/services/execution/flow-step-executor.ts` | `flow-step-await-attachment.test.ts`, `flow-step-thought-emission.test.ts`, `flow-step-thoughts-integration.test.ts`, `flow-step-infrastructure-regression.test.ts`, pre-refactor flow-step tests | `flow-step-executor-gather.test.ts`, `flow-step-executor-branching.test.ts`, `flow-step-executor-side-effects.test.ts`, `flow-step-executor-error-contract.test.ts`, `flow-step-executor-node-matrix.test.ts` |

### Contracts to encode

- confidence thresholds and fallback routing
- multi-intent decisions
- reasoning on/off guards
- tool-loop retries and stop conditions
- gather progression and missing-field prompts
- flow node transitions
- error-to-trace consistency

---

## Workstream D: WebSocket and SDK Contract Coverage

This workstream should treat WebSocket behavior as a transport contract, not an implementation detail.

### Target files and suites

| Runtime File                   | Existing Suites                                                                                                                      | New or Expanded Suites                                                                                                                                                                |
| ------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `src/websocket/handler.ts`     | `websocket-handler.test.ts`, `websocket-events.test.ts`, `websocket/handler-flush.test.ts`, `websocket/ws-trace-propagation.test.ts` | `websocket-handler-connectivity.contract.test.ts`, `websocket-handler-backpressure.test.ts`, `websocket-handler-close-semantics.test.ts`, `websocket-handler-resume-contract.test.ts` |
| `src/websocket/sdk-handler.ts` | SDK auth and runtime E2E tests, plus existing SDK route tests                                                                        | `sdk-handler-auth.contract.test.ts`, `sdk-handler-session-continuity.test.ts`, `sdk-handler-invalid-payload.test.ts`, `sdk-handler-rate-limit.test.ts`                                |

### Contracts to encode

- valid and invalid auth
- reconnect and continuity behavior
- close code semantics
- backpressure / flush behavior
- malformed payload rejection
- trace propagation across WebSocket flows

---

## Workstream E: Isolation and Trace Invariants

This workstream gives high branch coverage with low brittleness.

### Target areas

- RBAC middleware and concealment
- session ownership resolution
- trace response filtering and pagination
- ClickHouse row dedupe and synthesized IDs
- trace event type mapping
- queue/distributed cleanup contracts

### Suggested suites

- expand `middleware-rbac.test.ts`
- expand `session-ownership-authz.test.ts`
- expand `trace-response.test.ts`
- expand `services/clickhouse-session-trace-events.test.ts`
- add `trace-query-session-resolution.test.ts`
- add `session-continuity-ownership.contract.test.ts`

---

## Workstream F: Voice and Secondary Hotspots

This workstream is necessary to clear the last 10-15 points without cheating the denominator.

### Target files

- `src/services/voice/korevg/korevg-session.ts`
- `src/services/voice/korevg/korevg-router.ts`
- `src/services/tool-oauth-service.ts`
- `src/routes/tenant-models.ts`
- `src/routes/channel-connections.ts`

### Suggested suites

- `korevg-session-contract.test.ts`
- `korevg-router-contract.test.ts`
- expand `tool-oauth-service.test.ts`
- expand tenant model and channel connection contract suites with route-harness tests

These should stay deterministic. Live telephony or live provider tests remain non-gating.

---

## Threshold Ratchet Plan

Raise coverage in stages. Do **not** jump directly from `14/12/17` to `90/90/90`.

| PR       | Main Deliverable                                               | Lines | Branches | Functions |
| -------- | -------------------------------------------------------------- | ----: | -------: | --------: |
| Baseline | Current state                                                  |    14 |       12 |        17 |
| PR-1     | Coverage lane + stable contract suites wired into measurement  |    25 |       20 |        25 |
| PR-2     | Chat, sessions, server contract expansion                      |    40 |       35 |        40 |
| PR-3     | Runtime executor lifecycle + persistence + tracing contracts   |    55 |       45 |        55 |
| PR-4     | Routing, reasoning, and flow-step branch matrices              |    70 |       60 |        70 |
| PR-5     | WebSocket + SDK + isolation invariants                         |    82 |       72 |        82 |
| PR-6     | Voice + secondary hotspots + server shutdown/bootstrap cleanup |    90 |       85 |        90 |
| PR-7     | Branch gap closeout across hot files                           |    90 |       90 |        90 |

### Why branches lag

Branch coverage should rise last because it is the hardest metric to improve honestly. Raising branch thresholds too early creates pressure to write implementation-shaped tests instead of filling real scenario matrices.

---

## PR Breakdown

### PR-1: Coverage Plumbing and Stable Lane

### Scope

- add `vitest.coverage.config.ts` or equivalent runtime stable coverage config
- add runtime coverage scripts
- make route-heavy deterministic suites part of the coverage lane
- keep live-only tests out of the gate

### Acceptance criteria

- runtime coverage summary is reproducible locally
- `coverage-summary.json` is populated for runtime
- no new flaky behavior in CI

### PR-2: Route Contracts

### Scope

- expand `chat-routes.test.ts`
- expand `session-routes.test.ts`
- add `server-*` contract suites

### Acceptance criteria

- all HTTP status branches for chat and sessions are covered
- startup/shutdown/readiness contracts are encoded

### PR-3: Runtime Executor

### Scope

- session lifecycle
- resume semantics
- persistence hooks
- trace contracts
- escalation/handoff

### Acceptance criteria

- no major `runtime-executor.ts` branch left uncovered without a documented reason

### PR-4: Decision Engines

### Scope

- routing executor
- reasoning executor
- flow-step executor branch matrices

### Acceptance criteria

- threshold and fallback logic are scenario-tested rather than spy-tested

### PR-5: WebSocket and Isolation

### Scope

- websocket handler and sdk handler contracts
- ownership and concealment invariants
- distributed queue cleanup

### Acceptance criteria

- reconnect/close/backpressure/auth paths are encoded as contracts

### PR-6: Secondary Hotspots

### Scope

- voice deterministic paths
- oauth service
- tenant-models
- channel-connections
- remaining server/shutdown edges

### Acceptance criteria

- runtime lines/functions reach 90+

### PR-7: Branch Closeout

### Scope

- finish scenario matrices for remaining red branches
- remove any temporary skips or TODO tests

### Acceptance criteria

- runtime reaches `90/90/90`

---

## First PR Recommendation

If we start immediately, the first PR should do only four things:

1. create the stable runtime coverage lane
2. move `chat-routes`, `session-routes`, `user-isolation.integration`, `session-service`, `session-ttl-dynamic`, `llm-queue-distributed`, and `redis-connection-cleanup` into that lane
3. add missing chat/session/server contract cases needed to make the lane representative
4. ratchet runtime from `14/12/17` to `25/20/25`

That first PR gives us a trustworthy measuring stick before we start chasing the remaining percentage.

---

## Success Criteria

This plan is complete only when all of the following are true:

- `apps/runtime` passes `90%+` lines, branches, and functions
- coverage is gathered from deterministic, behavior-first tests
- route and executor contracts fail when behavior regresses, even if implementation changes
- hot files are covered rather than excluded
- CI uses the same stable coverage lane developers run locally

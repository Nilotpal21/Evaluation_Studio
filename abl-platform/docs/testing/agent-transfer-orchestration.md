# Feature Test Guide: Agent Transfer & Multi-Agent Orchestration

**Feature**: Coordination family overview — local handoff, delegation, fan-out/gather, escalation, A2A remote handoff, and human-agent transfer
**Owner**: Platform team
**Branch**: develop
**Related Feature Doc**: [docs/features/agent-transfer-orchestration.md](../features/agent-transfer-orchestration.md)
**First tested**: 2026-03-18
**Last updated**: 2026-03-21
**Overall status**: STABLE (core paths), PARTIAL (remote/async edge cases)

---

## Current State (as of 2026-03-21)

The coordination family has strong deterministic coverage across three primary surfaces:

- `apps/runtime` for orchestration behavior and escalation edge cases
- `packages/agent-transfer` for human-agent transfer lifecycle and recovery
- `packages/a2a` for remote agent protocol handling

The core local handoff, remote handoff failure paths, escalation behavior, transfer-session lifecycle, and A2A protocol primitives are well covered. The remaining risk is concentrated in the same places the split feature docs call out: async orchestration edges, cross-tenant live A2A verification, thread-resume/return-path proof, and broader provider-live coverage outside the primary Kore path.

This is a hub-level coverage guide. Detailed testing evidence for specific modules lives in:

- [docs/testing/a2a-integration.md](./a2a-integration.md)
- [docs/testing/agent-transfer.md](./agent-transfer.md)
- [docs/testing/multi-agent-orchestration.md](./multi-agent-orchestration.md)
- [docs/testing/multi-agent-session-management.md](./multi-agent-session-management.md)

### Quick Health Dashboard

| Area                           | Status     | Last Verified | Notes                                                                        |
| ------------------------------ | ---------- | ------------- | ---------------------------------------------------------------------------- |
| Local handoff (thread-based)   | PASS       | 2026-03-18    | Core routing and escalation paths covered                                    |
| Remote handoff (A2A sync)      | PASS       | 2026-03-18    | `routing-remote-handoff.test.ts` covers timeout, auth, parent restore, etc.  |
| Remote handoff (A2A streaming) | PASS       | 2026-03-18    | Covered through degraded sync+forward path                                   |
| Remote handoff (A2A async)     | PARTIAL    | 2026-03-18    | Suspension/callback registration covered; resume/poll fallback still lighter |
| Delegation                     | PASS       | 2026-03-18    | Timeout, cycle detection, mapping, failure handling                          |
| Fan-out / gather               | PASS       | 2026-03-18    | Parallel execution and semaphore behavior covered                            |
| Escalation                     | PASS       | 2026-03-18    | 12 negative edge cases plus transfer integration                             |
| Completion conditions          | PASS       | 2026-03-18    | Condition evaluation, STORE, and return behavior covered                     |
| Handoff guardrails             | PASS       | 2026-03-18    | Guardrail block/modify/fail-open behavior covered                            |
| Human agent transfer (Kore)    | PASS       | 2026-03-18    | Full integration plus env-gated E2E smoke                                    |
| A2A inbound/outbound core      | PASS       | 2026-03-18    | 35 E2E tests documented in split A2A guide                                   |
| Cross-tenant A2A live proof    | NOT TESTED | —             | Test file exists but was not executed                                        |
| Thread resume                  | NOT TESTED | —             | Waiting-thread resume is not directly proved                                 |
| Auth propagation chain         | NOT TESTED | —             | Builders exist, but no end-to-end chain test                                 |

---

## Hub Scope

This guide tracks the family-level confidence picture only. Ownership boundaries are:

- Multi-Agent Orchestration: routing logic, handoff, delegate, fan-out, completion
- Multi-Agent Session Management: threads, active agent, return paths, session continuity
- Agent Transfer: human-agent transfer lifecycle after escalation
- A2A Integration: remote agent protocol surface

When the detailed docs disagree with this hub, the dedicated feature-specific testing guide is the source of truth.

---

## Test Coverage Map

### Local Handoff (Thread-Based)

- [x] Handoff creates a new thread with the correct target agent context
- [x] EXPECT_RETURN handoff pushes parent context for return
- [x] Permanent handoff can complete the parent branch
- [x] Self-handoff and cycle-detection guards exist
- [x] Invalid target-agent and missing-routing cases are rejected
- [x] PASS/SUMMARY context behavior is covered indirectly through routing logic
- [ ] Resume of a previously waiting thread is not directly proved
- [ ] History-strategy variants (`auto`, `full`, `last_n`, `summary_only`) are not directly covered as dedicated end-to-end cases
- [ ] ON_RETURN structured mapping is not directly covered end-to-end
- [ ] Handoff timeout enforcement is not directly proven as a standalone scenario

### Remote Handoff (A2A)

- [x] Sync remote handoff completes for both task and message responses
- [x] Timeout, failure, input-required, and network-error cases restore the parent safely
- [x] Auth forwarding to remote agents is covered
- [x] History-strategy control for remote handoff is covered
- [x] Best-effort cancel on remote handoff failure is covered
- [x] EXPECT_RETURN merge from remote response is covered
- [x] Auto-registration of remote agents from DSL config is covered
- [x] Streaming remote handoff behavior is covered through the current degraded sync+forward path
- [x] Async handoff suspension and callback registration are covered
- [x] Sync completion of async-typed requests is covered
- [ ] Async push-notification resume is not directly covered
- [ ] Async poll fallback is not directly covered
- [ ] Remote agent-card discovery fallback is not directly covered

### Delegation

- [x] Delegate cycle detection and depth limits are protected
- [x] INPUT and RETURNS mapping paths are covered through runtime logic
- [x] USE_RESULT and ON_FAILURE policies (`continue`, `escalate`, `respond`) are covered
- [x] Delegate timeout and cooperative cancellation paths are covered
- [ ] Parent LLM-client re-wiring after delegate return is not directly covered
- [ ] Remote delegate via A2A is not directly covered

### Fan-Out / Gather

- [x] Parallel agent/tool execution paths are covered
- [x] Semaphore-controlled concurrency exists and is covered
- [x] Concurrent fan-out guard behavior exists and is covered
- [x] Deduplication, self-target filtering, and missing-agent handling are covered
- [x] Child session creation/cleanup and result formatting are covered
- [ ] Async fan-out barrier coordination is not directly proved
- [ ] Remote fan-out branches via A2A are not directly proved
- [ ] Partial-failure continue policy is not directly proved end-to-end
- [ ] Timeout propagation across mixed fan-out branches is not directly proved

### Escalation

- [x] Empty/missing reason validation is covered
- [x] Invalid priority normalization is covered
- [x] Double escalation, escalation after completion, and missing-IR-config cases are covered
- [x] Context leakage, injection, and session-consistency edge cases are covered
- [x] Escalation blocks further AI turns once transfer occurs
- [x] Kore SmartAssist transfer integration is covered in dedicated transfer tests
- [ ] Voice-header-specific escalation routing is not directly covered
- [ ] Post-agent action behavior (`return` vs `end`) is not yet proven end-to-end

### Completion

- [x] Completion condition evaluation exists and is covered
- [x] STORE support is covered
- [x] Thread return after completion is covered
- [x] Completion-message interpolation is covered
- [x] Voice and rich-content interpolation are covered
- [ ] Multiple-condition first-match semantics are not directly covered
- [ ] Silent completion is not directly covered

### Handoff Guardrails

- [x] Guardrails can block a handoff
- [x] Guardrails can modify handoff context (for example PII redaction)
- [x] Guardrail evaluation currently fails open on internal error
- [ ] Combined DSL and session-policy guardrail behavior is not directly covered

### Human Agent Transfer (Kore SmartAssist)

- [x] Transfer session create/claim/end lifecycle is covered
- [x] Voice transfer flow is covered
- [x] Backward compatibility is covered
- [x] Kore adapter wiring and SmartAssist protocol handling are covered
- [x] Auth refresh, rate limiting, SSRF guard, log redaction, and tenant isolation are covered
- [x] Recovery, timeout scheduling, durable events, graceful shutdown, and leader election are covered
- [x] Metrics, trace events, health checks, history formatting, and logger behavior are covered
- [ ] Provider-live coverage remains mostly limited to the Kore smoke path

### A2A Protocol

- [x] A2A sync task dispatch is covered
- [x] Async task dispatch is covered
- [x] Agent-card discovery is covered
- [x] JSON-RPC HTTP handlers are covered
- [x] Runtime-to-A2A adapter behavior is covered
- [x] SSRF validation, tracing interception, Redis task store, lazy task store, and push-notification delivery are covered
- [x] Task lifecycle, streaming, session resolution, tenant isolation, and connection-card integration are covered
- [ ] Cross-tenant A2A live E2E remains not run

### Multi-Intent Dispatch

- [ ] `primary_queue` strategy is not covered end-to-end
- [ ] `disambiguate` strategy is not covered end-to-end
- [ ] `parallel` strategy is not covered end-to-end
- [ ] `sequential` strategy is not covered end-to-end

### Helper Functions

- [x] Session metadata extraction, timeout parsing, delegate input/return mapping, failure handling, fan-out deduplication, result formatting, and history-strategy resolution are all exercised through runtime logic and supporting tests

---

## Test File Inventory

### Runtime (`apps/runtime/src/__tests__/`)

| File                                                             | Type | Scenarios                                                                   | Status |
| ---------------------------------------------------------------- | ---- | --------------------------------------------------------------------------- | ------ |
| `routing-remote-handoff.test.ts`                                 | Unit | Remote handoff sync/streaming/async, timeout, auth, history, parent restore | PASS   |
| `escalation-negative.test.ts`                                    | Unit | Escalation edge cases and failure paths                                     | PASS   |
| `services/execution/__tests__/handoff-guardrail-llmeval.test.ts` | Unit | Guardrail block/modify/fail-open behavior                                   | PASS   |

### Agent Transfer (`packages/agent-transfer/src/__tests__/`)

| File                                       | Type        | Scenarios                           | Status |
| ------------------------------------------ | ----------- | ----------------------------------- | ------ |
| `e2e/kore-e2e.test.ts`                     | E2E         | Full Kore SmartAssist transfer flow | PASS   |
| `integration/kore-transfer-flow.test.ts`   | Integration | Kore transfer lifecycle             | PASS   |
| `integration/session-lifecycle.test.ts`    | Integration | Transfer-session create/claim/end   | PASS   |
| `integration/voice-transfer.test.ts`       | Integration | Voice-specific transfer flow        | PASS   |
| `integration/backward-compat.test.ts`      | Integration | API backward compatibility          | PASS   |
| `unit/auth-refresh.test.ts`                | Unit        | Auth refresh                        | PASS   |
| `unit/concurrency.test.ts`                 | Unit        | Concurrent session operations       | PASS   |
| `unit/config-reloader.test.ts`             | Unit        | Config reload via Redis pub/sub     | PASS   |
| `unit/csat-handler.test.ts`                | Unit        | CSAT event handling                 | PASS   |
| `unit/dead-letter-store.test.ts`           | Unit        | Failed event storage and replay     | PASS   |
| `unit/disposition-handler.test.ts`         | Unit        | Agent disposition handling          | PASS   |
| `unit/durable-events.test.ts`              | Unit        | Durable event queue                 | PASS   |
| `unit/edge-cases.test.ts`                  | Unit        | Edge-case handling                  | PASS   |
| `unit/error-resilience.test.ts`            | Unit        | Error recovery and resilience       | PASS   |
| `unit/event-handler-attachments.test.ts`   | Unit        | Attachment processing               | PASS   |
| `unit/extend-ttl-channel-hint.test.ts`     | Unit        | Channel-based TTL extension         | PASS   |
| `unit/fallback-executor.test.ts`           | Unit        | Adapter fallback execution          | PASS   |
| `unit/graceful-shutdown.test.ts`           | Unit        | Shutdown sequencing                 | PASS   |
| `unit/helpers.test.ts`                     | Unit        | Utility helpers                     | PASS   |
| `unit/history-formatter.test.ts`           | Unit        | Conversation-history formatting     | PASS   |
| `unit/input-validation.test.ts`            | Unit        | Input validation                    | PASS   |
| `unit/leader-election-toctou.test.ts`      | Unit        | Leader-election race protection     | PASS   |
| `unit/log-redactor.test.ts`                | Unit        | PII log redaction                   | PASS   |
| `unit/parse-session-hash.test.ts`          | Unit        | Session-hash parsing                | PASS   |
| `unit/rate-limiter.test.ts`                | Unit        | Rate-limit enforcement              | PASS   |
| `unit/recovery-sscan-pipeline.test.ts`     | Unit        | Recovery scan pipeline              | PASS   |
| `unit/session-store-polish.test.ts`        | Unit        | Session-store refinements           | PASS   |
| `unit/session-timeout-scheduler.test.ts`   | Unit        | Timeout scheduling                  | PASS   |
| `unit/session-update-toctou.test.ts`       | Unit        | Session-update race protection      | PASS   |
| `unit/shutdown.test.ts`                    | Unit        | Shutdown procedures                 | PASS   |
| `unit/smartassist-update-transfer.test.ts` | Unit        | SmartAssist transfer updates        | PASS   |
| `unit/ssrf-guard.test.ts`                  | Unit        | SSRF protection                     | PASS   |
| `unit/tenant-isolation.test.ts`            | Unit        | Tenant-scoped data isolation        | PASS   |
| `unit/tenant-scoped-sessions.test.ts`      | Unit        | Tenant-scoped session access        | PASS   |
| `unit/trace-events.test.ts`                | Unit        | Transfer trace-event emission       | PASS   |
| `unit/trace-store-adapter.test.ts`         | Unit        | Trace-store adapter integration     | PASS   |
| `unit/transfer-logger.test.ts`             | Unit        | Structured transfer logging         | PASS   |
| `event-mapping-fixes.test.ts`              | Unit        | Event mapping corrections           | PASS   |
| `health.test.ts`                           | Unit        | Health endpoint coverage            | PASS   |
| `kore-adapter-key-fixes.test.ts`           | Unit        | Kore adapter key handling           | PASS   |
| `kore-adapter-wiring.test.ts`              | Unit        | Kore adapter dependency injection   | PASS   |
| `metrics.test.ts`                          | Unit        | Metrics collection                  | PASS   |
| `security-hardening.test.ts`               | Unit        | Security hardening                  | PASS   |
| `session-lua-fixes.test.ts`                | Unit        | Redis Lua script fixes              | PASS   |
| `smartassist-client-protocol.test.ts`      | Unit        | SmartAssist protocol handling       | PASS   |

### A2A (`packages/a2a/src/__tests__/`)

| File                                   | Type        | Scenarios                      | Status  |
| -------------------------------------- | ----------- | ------------------------------ | ------- |
| `send-task.test.ts`                    | Unit        | Sync task dispatch             | PASS    |
| `send-task-async.test.ts`              | Unit        | Async task dispatch            | PASS    |
| `discover-agent.test.ts`               | Unit        | Agent-card discovery           | PASS    |
| `express-handlers.test.ts`             | Unit        | JSON-RPC handlers              | PASS    |
| `agent-executor-adapter.test.ts`       | Unit        | Runtime-to-A2A adapter         | PASS    |
| `ssrf-interceptor.test.ts`             | Unit        | SSRF validation                | PASS    |
| `traced-client.test.ts`                | Unit        | Tracing interceptor            | PASS    |
| `redis-task-store.test.ts`             | Unit        | Redis task store               | PASS    |
| `lazy-task-store.test.ts`              | Unit        | Lazy task-store initialization | PASS    |
| `ports.test.ts`                        | Unit        | Port contract validation       | PASS    |
| `outbound-capabilities.test.ts`        | Unit        | Outbound capability detection  | PASS    |
| `push-notification-delivery.test.ts`   | Unit        | Push-notification delivery     | PASS    |
| `task-lifecycle-integration.test.ts`   | Integration | Task lifecycle                 | PASS    |
| `streaming-integration.test.ts`        | Integration | SSE streaming lifecycle        | PASS    |
| `session-resolver-integration.test.ts` | Integration | Session resolution             | PASS    |
| `tenant-isolation-integration.test.ts` | Integration | Cross-tenant data isolation    | PASS    |
| `connection-card-integration.test.ts`  | Integration | Connection-card behavior       | PASS    |
| `cross-tenant-e2e.test.ts`             | E2E         | Cross-tenant isolation         | NOT RUN |

---

## Known Bugs & Issues

| ID      | Description                                                                                                        | Severity | Found      | Status |
| ------- | ------------------------------------------------------------------------------------------------------------------ | -------- | ---------- | ------ |
| BUG-001 | SSE streaming for remote A2A handoffs uses a degraded sync+forward path because of an SDK generator-teardown issue | Medium   | 2026-03-18 | Open   |

---

## Recommended Next Tests

1. Add a thread-resume integration test that proves a waiting thread is resumed instead of replaced.
2. Add an ON_RETURN mapping end-to-end scenario through a supervisor → specialist → supervisor flow.
3. Add direct end-to-end coverage for `auto`, `full`, `last_n`, and `summary_only` history strategies.
4. Add async fan-out barrier coverage for mixed local and remote branches.
5. Add multi-intent dispatch end-to-end coverage for `primary_queue`, `disambiguate`, `parallel`, and `sequential`.
6. Add auth-propagation chain verification across deeper delegation paths.
7. Execute the existing cross-tenant A2A E2E file with real second-tenant credentials.

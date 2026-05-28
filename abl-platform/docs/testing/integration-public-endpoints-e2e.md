# Feature Test Guide: Integration Public Endpoints E2E

**Feature**: k6 load testing of public-facing endpoints (agent conversation, multi-agent orchestration, channel messaging) via staging ingress
**Owner**: Platform team
**Branch**: develop
**First tested**: 2026-03-22
**Last updated**: 2026-03-22
**Overall status**: IN PROGRESS

---

## Current State (as of 2026-03-22)

Bootstrap successfully creates tenants, agents, and multi-agent setups on staging. KB document upload fails (500 from search-ai). Agent conversation and multi-agent delegation work well at low concurrency — single-turn avg 291ms, multi-turn avg 313ms, supervisor routing avg 334ms. WebSocket multi-agent sessions are 100% reliable. High-concurrency scenarios are blocked by two issues: (1) JWT refresh token rotation invalidates tokens across k6 VUs, and (2) staging rate limiter returns 429 at ~5-10 req/s per endpoint. SSE streaming works perfectly across all channel-message scenarios.

### Quick Health Dashboard

| Area                            | Status  | Last Verified | Notes                                           |
| ------------------------------- | ------- | ------------- | ----------------------------------------------- |
| Bootstrap (tenant/agent)        | PASS    | 2026-03-22    | All agents created successfully                 |
| Bootstrap (KB/documents)        | FAIL    | 2026-03-22    | Document upload 500 from search-ai              |
| Agent Conversation (low VU)     | PASS    | 2026-03-22    | single_turn + multi_turn excellent latency      |
| Agent Conversation (high VU)    | FAIL    | 2026-03-22    | Token expiry + no dev-login on staging          |
| Multi-Agent Delegation (low VU) | PARTIAL | 2026-03-22    | 26% success due to 429 rate limits              |
| Multi-Agent WebSocket           | PASS    | 2026-03-22    | 100% success, avg 385ms/turn                    |
| Channel Message Streaming       | PASS    | 2026-03-22    | 100% SSE success, avg 314ms delivery            |
| Channel Agent Chat              | FAIL    | 2026-03-22    | All agent chat calls fail (no LLM model config) |
| Conversation Lifecycle          | FAIL    | 2026-03-22    | 429 rate limit immediately                      |
| Search Query E2E                | —       | Not tested    | Blocked by KB upload failure                    |
| KB Ingestion E2E                | —       | Not tested    | Blocked by KB upload failure                    |

---

## Test Coverage Map

### Bootstrap

- [x] Tenant creation/reuse — `Iteration 1 (2026-03-22) PASS`
- [x] Project creation/reuse — `Iteration 1 (2026-03-22) PASS`
- [x] Single agent creation + DSL save — `Iteration 1 (2026-03-22) PASS`
- [x] Multi-agent creation (supervisor + 3 children) — `Iteration 1 (2026-03-22) PASS`
- [x] KB + source creation — `Iteration 1 (2026-03-22) PASS`
- [ ] Document upload — `Iteration 1 (2026-03-22) FAIL (500)`
- [ ] Index verification — `Not tested (blocked)`
- [ ] Conversation seeding — `Not tested (blocked)`

### Agent Conversation E2E

- [x] Single-turn chat via SSE — `Iteration 1 (2026-03-22) PASS avg=302ms p95=377ms`
- [x] Multi-turn conversation (5 turns, context maintained) — `Iteration 1 (2026-03-22) PASS avg=313ms p95=349ms`
- [x] Trace verification after chat — `Iteration 1 (2026-03-22) PASS`
- [ ] Concurrent conversations (ramp to 50 VUs) — `Iteration 1 (2026-03-22) FAIL (401 token expiry)`
- [ ] Token auto-refresh under load — `Iteration 1 (2026-03-22) FAIL (rotation breaks multi-VU)`

### Multi-Agent Orchestration E2E

- [x] Single delegation (supervisor → child) — `Iteration 1 (2026-03-22) PARTIAL (26% success, 429 rate limit)`
- [x] Multi-delegation (supervisor → multiple children) — `Iteration 1 (2026-03-22) PARTIAL (26% success, 429 rate limit)`
- [x] WebSocket multi-turn multi-agent — `Iteration 1 (2026-03-22) PASS 100% success`
- [ ] Concurrent supervisor routing — `Iteration 1 (2026-03-22) FAIL (429 rate limit)`

### Channel Message E2E

- [x] Single message via SSE stream — `Iteration 1 (2026-03-22) PASS (streaming) avg=341ms`
- [x] Burst messages (50 VUs) — `Iteration 1 (2026-03-22) PASS (streaming) avg=298ms`
- [x] Streaming ingestion (10 req/s) — `Iteration 1 (2026-03-22) PASS avg=312ms`
- [ ] Agent chat via channel — `Iteration 1 (2026-03-22) FAIL (all 599 attempts failed)`
- [ ] Conversation lifecycle (open/message/close) — `Iteration 1 (2026-03-22) FAIL (429)`

### Search Query E2E

- [ ] Direct search — `Not tested (blocked by KB upload)`
- [ ] Agent context search — `Not tested`
- [ ] Search with rerank — `Not tested`
- [ ] High concurrency search — `Not tested`

### KB Ingestion E2E

- [ ] Full ingestion pipeline — `Not tested (blocked by KB upload)`

---

## Open Gaps

- **GAP-001**: KB document upload returns 500 on staging
  - **Severity**: High
  - **Reason**: Search-AI service likely has docling/preprocessing dependency issue on staging
  - **Impact**: Blocks search-query-e2e and kb-ingestion-e2e tests

- **GAP-002**: JWT refresh token rotation breaks multi-VU load tests
  - **Severity**: High
  - **Reason**: First VU to refresh rotates the token, invalidating it for all other VUs. Dev-login disabled on staging.
  - **Impact**: Any test >15 min or with late-starting scenarios fails with 401

- **GAP-003**: Staging rate limiter blocks concurrent test scenarios
  - **Severity**: Medium
  - **Reason**: Rate limiter returns 429 at ~5-10 req/s per endpoint
  - **Impact**: High-concurrency scenarios (concurrent_conversations, concurrent delegation) fail

- **GAP-004**: Agent chat fails in channel-message test
  - **Severity**: Medium
  - **Reason**: Benchmark agent likely has no LLM model/credentials configured on staging
  - **Impact**: Channel agent chat and conversation lifecycle scenarios fail

---

## Pending / Future Work

- [ ] Re-test after KB document upload is fixed
- [ ] Run search-query-e2e once indexes are populated
- [ ] Run kb-ingestion-e2e pipeline test
- [ ] Test with higher tier (m, l) once rate limit and auth issues resolved
- [ ] Run on k6 Cloud with private load zones
- [ ] Configure benchmark agent with LLM model on staging
- [ ] Test cross-tenant isolation via load tests

---

## Enhancement Ideas

- **ENH-001** (Iteration 1): Add shared token store in k6 (experimental SharedArray or Redis) to solve refresh token rotation across VUs
- **ENH-002** (Iteration 1): Add 429 backoff/retry in k6 scripts to handle rate limiting gracefully
- **ENH-003** (Iteration 1): Consider service account / API key auth for load tests (bypasses JWT TTL issue)
- **ENH-004** (Iteration 1): Rate limiter should have a load-test bypass header or higher limits for staging

---

## Iteration Log

### Iteration 1 — 2026-03-22

**Scope**: Bootstrap, agent-conversation-e2e, multi-agent-orchestration, channel-message-e2e
**Branch**: develop
**Duration**: ~45min
**Tested by**: Claude Code (agent)

#### Results

| #   | Test                           | Scenario            | Expected                | Actual                                        | Status  |
| --- | ------------------------------ | ------------------- | ----------------------- | --------------------------------------------- | ------- |
| 1   | Bootstrap tenant/project       | —                   | Reuse existing          | Reused `019d1395-138f-756a-80d4-a8a78abba1e2` | PASS    |
| 2   | Bootstrap single agent         | —                   | Agent created           | `benchmark_agent` created                     | PASS    |
| 3   | Bootstrap multi-agent          | —                   | Supervisor + 3 children | All created successfully                      | PASS    |
| 4   | Bootstrap KB docs              | —                   | 3 docs uploaded         | 0/3 uploaded (500 error)                      | FAIL    |
| 5   | Agent single_turn              | 10 req/s, 3m        | p95<5s, >90% success    | avg=302ms p95=377ms, ~100%                    | PASS    |
| 6   | Agent multi_turn               | 10 VUs x 10 iters   | p95<8s, >90% success    | avg=313ms p95=349ms, ~100%                    | PASS    |
| 7   | Agent concurrent               | ramp 5→50 VUs, 8m   | p95<5s, >90% success    | All 401 after token expiry                    | FAIL    |
| 8   | Multi-agent single_delegation  | 3 VUs, 2m           | >80% success            | 26% (429 rate limit)                          | PARTIAL |
| 9   | Multi-agent ws_multi_turn      | 2 VUs, 3 iters each | >70% success            | 100%, avg=385ms/turn                          | PASS    |
| 10  | Multi-agent concurrent         | ramp to 30 VUs      | >80% success            | ~0% (429 rate limit)                          | FAIL    |
| 11  | Channel streaming              | 10 req/s, 2m        | p95<8s                  | avg=312ms p95=405ms, 100%                     | PASS    |
| 12  | Channel burst                  | up to 50 VUs        | p95<10s                 | avg=298ms p95=365ms, 100%                     | PASS    |
| 13  | Channel agent chat             | —                   | Agent responds          | All 599 attempts failed                       | FAIL    |
| 14  | Channel conversation_lifecycle | 5 VUs               | Open/msg/close          | 429 rate limit immediately                    | FAIL    |

#### Latency Summary (successful requests only)

| Endpoint                    | avg   | p50   | p95   | p99   |
| --------------------------- | ----- | ----- | ----- | ----- |
| Agent conversation (single) | 302ms | 291ms | 377ms | 634ms |
| Agent conversation (multi)  | 313ms | 301ms | 349ms | 653ms |
| Supervisor routing          | 334ms | 296ms | 544ms | —     |
| WebSocket per-turn          | 385ms | 334ms | 608ms | —     |
| Channel message delivery    | 314ms | 285ms | 419ms | —     |
| Channel streaming           | 313ms | 292ms | 405ms | 839ms |

#### Gaps Found

- GAP-001: KB document upload 500
- GAP-002: JWT refresh token rotation
- GAP-003: Staging rate limiter
- GAP-004: Agent chat fails (no LLM config)

---

## Test Environment

Runtime: agents-staging.kore.ai/api (public ingress)
Studio: agents-staging.kore.ai (public ingress)
Search-AI: agents-staging.kore.ai/api/search-ai (public ingress)
Tenant: 019cfc00-3836-71bc-ab60-500c33bf37ab
Project: 019d1395-138f-756a-80d4-a8a78abba1e2
Auth: JWT via Studio refresh endpoint (15-min TTL)
k6 version: v1.6.1
Tier: s (small — 10 VUs baseline)

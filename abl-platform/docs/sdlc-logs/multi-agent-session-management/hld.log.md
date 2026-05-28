# HLD Log — Multi-Agent Session Management

## Phase: HLD

### Timestamp: 2026-03-23

### Oracle Decisions

**Architecture & Data Flow:**

- ANSWERED: Preferred pattern is enhanced thread model (Option B) — extends existing `AgentThreadData` rather than introducing new services
- ANSWERED: Data flow is synchronous request-path for locks/handoffs, fire-and-forget for participation graph and cold storage
- INFERRED: Expected scale: 1000s of concurrent sessions, ~1-5 handoffs per session, <10 fan-out branches per session
- ANSWERED: Follows existing codebase patterns: Redis Lua scripts for atomics, `SessionStore` interface for abstraction, `tenantIsolationPlugin` for MongoDB scoping

**Integration & Dependencies:**

- ANSWERED: Depends on Redis 7.2+, MongoDB 7.0+, `@abl/compiler` HandoffConfig, `@agent-platform/execution`
- ANSWERED: No new external dependencies
- ANSWERED: API contract: additive nullable `participationGraph` field on session response, new graph endpoint
- ANSWERED: No breaking changes

**Risk & Migration:**

- DECIDED: Biggest risk is concurrent handoff corruption during thread lock transition. Mitigated by feature flag and fallback to session-level lock.
- ANSWERED: No data migration — existing sessions treated as single-thread namespace when V2 enabled
- ANSWERED: Rollback: disable feature flag, restart. No data migration needed for rollback.
- ANSWERED: Feature flag `MULTI_AGENT_SESSION_V2` for phased rollout

### Alternatives Evaluated

1. **Session-Per-Agent (Option A)** — Rejected: session sprawl, breaks WebSocket binding, breaks thread model
2. **Enhanced Thread Model (Option B)** — Selected: minimal changes, backward compatible, additive
3. **Event-Sourced Sessions (Option C)** — Rejected: prohibitive migration cost, no existing event-sourcing infra

### Audit Summary

**Round 1:** All 12 architectural concerns addressed. Diagrams present (system context, component, data flow, sequence). Two genuine alternatives plus one aspirational option. Data model and API design sections complete.

**Round 2:** Focused review on data model — verified Redis key layout matches existing patterns in `RedisSessionStore`. Verified participation graph index matches existing compound index patterns on Session model. API error envelope matches platform standard.

**Round 3:** Cross-phase consistency check — every FR from feature spec has a clear design decision in the HLD. Test strategy (concern #12) references the test spec's 7 E2E + 7 integration + 8 unit scenarios. Open questions refined with concrete recommendations.

### Files Created

- `docs/specs/multi-agent-session-management.hld.md`
- `docs/sdlc-logs/multi-agent-session-management/hld.log.md`

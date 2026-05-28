# SDLC Log: Circuit Breaker — Phase 3: HLD

**Date:** 2026-03-22
**Phase:** High-Level Design
**Feature:** Circuit Breaker (#44)

## Summary

Generated HLD addressing all 12 architectural concerns. The design leverages the existing `@agent-platform/circuit-breaker` Redis-backed package (already implemented with Lua scripts for atomic transitions) and integrates it into 3 runtime call boundaries: LLM providers, HTTP tools, and MCP servers.

## Key Design Decisions

1. **Singleton registry pattern** — `CircuitBreakerRegistry` created once per pod with shared Redis connection
2. **LLM fallback chain** — Primary provider -> Fallback provider -> Structured error (never unhandled)
3. **Tool service key derivation** — Hostname of tool endpoint (e.g., `api.weather.com`) to share circuit state across tools pointing to same service
4. **Feature flag** — `CIRCUIT_BREAKER_ENABLED` env var for safe rollout/rollback
5. **Redis fallback** — On Redis unavailability, degrade to allow-all (no protection but no cascade)

## Alternatives Evaluated

| Alternative                | Decision     | Reason                                                                          |
| -------------------------- | ------------ | ------------------------------------------------------------------------------- |
| In-memory breakers per pod | REJECTED     | No cross-pod consistency, state lost on restart, thundering herd                |
| Service mesh (Istio/Envoy) | REJECTED     | No tenant isolation, no app-level fallback, not currently deployed              |
| Hybrid Redis+in-memory     | NOT SELECTED | Valid optimization but adds cognitive load; Redis handles high cardinality well |

## 12 Concerns Addressed

1. Security: Tenant-scoped keys, auth middleware, audit trail
2. Performance: < 5ms overhead, O(1) Lua scripts, connection reuse
3. Scalability: Redis-backed, bounded key cardinality, sorted set pruning
4. Reliability: Redis fallback, atomic transitions, half-open probe limiting
5. Data Model: Redis-only, 5 keys per breaker, TTL-bounded
6. Observability: Logging, TraceEvents, health API
7. Error Handling: CircuitOpenError extends AppError, structured responses
8. Tenant Isolation: tenantId in every key prefix
9. Compliance: No PII in Redis, TTL enforcement, audit trail
10. Testing: 8 E2E + 7 integration scenarios
11. Backward Compatibility: Additive change, existing error handlers work
12. Deployment: No new infra, feature flag, no migration needed

## New Files Identified

- `apps/runtime/src/services/circuit-breaker-singleton.ts` — Registry singleton
- `apps/runtime/src/routes/circuit-breaker-health.ts` — Health API route
- `apps/runtime/src/routes/admin/circuit-breaker-reset.ts` — Admin reset route

## Modified Files Identified

- `apps/runtime/src/services/llm/session-llm-client.ts` — Wrap LLM calls
- `apps/runtime/src/services/execution/*-tool-executor.ts` — Wrap HTTP tool calls
- `apps/runtime/src/services/mcp/*-mcp-provider.ts` — Wrap MCP calls
- `apps/runtime/package.json` — Add `@agent-platform/circuit-breaker` dependency

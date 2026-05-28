# SDLC Log: Circuit Breaker — Phase 4: LLD

**Date:** 2026-03-22
**Phase:** Low-Level Design / Implementation Plan
**Feature:** Circuit Breaker (#44)

## Summary

Generated phased implementation plan with 7 phases, exit criteria per phase, and a wiring checklist.

## Phase Count: 7

| Phase | Name                        | Description                                    | Est. Effort |
| ----- | --------------------------- | ---------------------------------------------- | ----------- |
| 1     | Foundation & Singleton      | Registry singleton, feature flag, Redis wiring | S           |
| 2     | LLM Provider Integration    | SessionLLMClient wrapping, provider fallback   | M           |
| 3     | HTTP Tool Integration       | Tool execution wrapping, DSL config override   | M           |
| 4     | MCP Server Integration      | MCP provider wrapping                          | S           |
| 5     | Health & Admin API          | REST endpoints for monitoring and reset        | M           |
| 6     | Observability & TraceEvents | Event-to-TraceEvent bridge                     | S           |
| 7     | Tests & Verification        | E2E + integration test implementation          | L           |

## File Change Summary

- **New files:** 9 (singleton, bridge, routes, 6 test files)
- **Modified files:** 8-10 (SessionLLMClient, tool executor, MCP providers, routes, Dockerfile, package.json)

## Key Implementation Decisions

1. **Null-safe registry access** — `getCircuitBreakerRegistry()` returns `null` when disabled or Redis unavailable; all callers check for null before wrapping
2. **Tool service key from hostname** — Tools pointing to the same host share circuit state; utility function `deriveToolServiceKey()` extracts hostname
3. **Feature flag default: true** — Circuit breaker is on by default; `CIRCUIT_BREAKER_ENABLED=false` disables
4. **DSL override via tenant override** — `circuit_breaker:` block maps to `setTenantOverride()` for per-tool thresholds
5. **Streaming LLM calls** — Circuit breaker wraps at the outermost layer, not interleaved with streaming logic

## Wiring Checklist Items: 10

All integration points documented with source → target mapping and verification checkbox.

## Gaps & Risks Noted

- SearchAI connector integration (FR-CB-4) deferred — not in Phase 1-7, requires separate SearchAI-focused implementation
- Pipeline breaker consolidation (FR-CB-14) deferred to P2
- Studio UI health indicator (FR-CB-15) deferred to P2
- Vercel AI SDK streaming requires careful wrapping to avoid interfering with SSE chunking

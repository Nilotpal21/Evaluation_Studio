# SDLC Log: Circuit Breaker — Phase 1: Feature Spec

**Date:** 2026-03-22
**Phase:** Feature Spec
**Feature:** Circuit Breaker (#44)

## Summary

Generated feature specification for the circuit breaker resilience patterns feature. The spec covers integration of the existing `@agent-platform/circuit-breaker` Redis-backed package into the platform's critical external call paths.

## Key Findings

1. **Four independent CB implementations exist** — `@agent-platform/circuit-breaker` (Redis, unused in runtime), pipeline in-memory, eval in-memory, git in-memory
2. **Critical gap:** `SessionLLMClient` (the primary LLM call path) has NO circuit breaker protection
3. **DSL already parses `circuit_breaker:` config** but runtime does NOT consume it
4. **The Redis-backed package is production-ready** with Lua-script atomic transitions, hierarchical levels, event system, and per-tenant overrides
5. **`ErrorCodes.CIRCUIT_OPEN` already defined** in `packages/shared-kernel/src/errors.ts`

## Functional Requirements Count

- **P0:** 6 (FR-CB-1, FR-CB-2, FR-CB-5, FR-CB-6, FR-CB-7, FR-CB-13)
- **P1:** 5 (FR-CB-3, FR-CB-4, FR-CB-8, FR-CB-9, FR-CB-10, FR-CB-11)
- **P2:** 3 (FR-CB-12, FR-CB-14, FR-CB-15)
- **Total:** 15

## Codebase References

- `packages/circuit-breaker/src/` — Redis-backed CB package (ready to use)
- `apps/runtime/src/services/llm/session-llm-client.ts` — LLM call path (no CB)
- `apps/runtime/src/services/pipeline/circuit-breaker.ts` — In-memory pipeline CB
- `packages/pipeline-engine/src/pipeline/services/eval/eval-circuit-breakers.ts` — Eval CB
- `packages/project-io/src/git/git-circuit-breaker.ts` — Git CB
- `packages/shared/src/tools/dsl-property-parser.ts:396` — DSL circuit_breaker parsing
- `packages/shared-kernel/src/types/project-tool-form.ts:70` — CircuitBreaker form type
- `packages/shared-kernel/src/errors.ts:58` — CIRCUIT_OPEN error code

## Audit Findings

Self-audit performed. No CRITICAL findings. The spec is grounded in actual code analysis, not hypothetical architecture.

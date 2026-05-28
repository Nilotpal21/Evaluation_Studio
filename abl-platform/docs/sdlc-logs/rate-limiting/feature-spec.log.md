# SDLC Log: Rate Limiting — Feature Spec (Phase 1)

**Date**: 2026-03-22
**Phase**: Feature Spec
**Artifact**: `docs/features/rate-limiting.md`

## Decision Log

| #   | Question                                                             | Classification | Resolution                                                                                                                                                                                                       |
| --- | -------------------------------------------------------------------- | -------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 1   | What limiter surfaces exist across the platform?                     | ANSWERED       | Six surfaces found: Runtime, SearchAI, Studio (2), Connectors, Evals, Agent Transfer. Verified via code search.                                                                                                  |
| 2   | What algorithms are used per surface?                                | ANSWERED       | Runtime: sorted-set sliding window. SearchAI: fixed-window INCR. Studio: sorted-set + in-process sliding. Connectors: token bucket. Evals: in-memory counters. Agent Transfer: sorted-set with conditional ZADD. |
| 3   | What Redis key patterns are used?                                    | ANSWERED       | `rl:{id}:{op}`, `search-ai:rl:{key}`, `rl:studio:{key}`, `at_ratelimit:{tenantId}`, `sessions:active:{tenantId}`. Verified in source.                                                                            |
| 4   | Should Studio's two implementations be merged?                       | AMBIGUOUS      | Left as open question. Both are actively used by different route handlers with different requirements.                                                                                                           |
| 5   | Should eval throttling use Redis for multi-worker fairness?          | AMBIGUOUS      | Left as open question. Current design is intentionally local to pipeline-engine process.                                                                                                                         |
| 6   | What is the default behavior when Redis is unavailable?              | ANSWERED       | Runtime/SearchAI/Studio: fall back to in-memory with bounded maps. Agent Transfer: no fallback (requires Redis).                                                                                                 |
| 7   | What tier-based limits exist?                                        | ANSWERED       | Runtime: via TenantConfigService plan resolution. Evals: hard-coded TIER_LIMITS (free/team/business/enterprise).                                                                                                 |
| 8   | Is agent-transfer rate limiter covered in the existing feature spec? | DECIDED        | Added to the spec. Previous version only covered 5 surfaces; agent-transfer is a 6th distinct implementation.                                                                                                    |

## Files Created/Modified

- `docs/features/rate-limiting.md` — Complete rewrite with all 18 template sections
- `docs/sdlc-logs/rate-limiting/feature-spec.log.md` — This file

## Code Files Examined

- `apps/runtime/src/middleware/rate-limiter.ts` — 567 LOC, full middleware + session management
- `apps/runtime/src/services/resilience/hybrid-rate-limiter.ts` — 154 LOC, Redis+memory orchestrator
- `apps/runtime/src/services/resilience/redis-rate-limiter.ts` — 165 LOC, Lua sliding window
- `apps/search-ai/src/middleware/rate-limit.ts` — 253 LOC, fixed-window with Lua
- `apps/studio/src/lib/rate-limit.ts` — 139 LOC, Redis sliding window + fallback
- `apps/studio/src/lib/rate-limiter.ts` — 158 LOC, in-process sliding window
- `packages/connectors/base/src/client/rate-limiter.ts` — 134 LOC, token bucket
- `packages/pipeline-engine/src/pipeline/services/eval/eval-rate-limiter.ts` — 249 LOC, tier-based
- `packages/agent-transfer/src/security/rate-limiter.ts` — 78 LOC, Redis sorted-set
- `packages/config/src/schemas/rate-limit.schema.ts` — 11 LOC, Zod schema
- `apps/runtime/src/websocket/sdk-handler.ts` — WSConnectionRateLimiter class
- `apps/runtime/src/observability/metrics.ts` — OTEL metrics definitions

## Review Summary

**Round 1 — Completeness**: All 18 sections filled. 5 user stories (minimum 3). 8 functional requirements (minimum 4). 5 related features in integration matrix. Non-functional concerns address tenant, project, and user isolation. 5 open questions.

**Round 2 — Cross-Phase Consistency**: FR numbering consistent. Scope boundaries match non-goals. User stories align with functional requirements. All implementation file paths verified in codebase.

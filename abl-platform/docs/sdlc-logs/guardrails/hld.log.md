# SDLC Log: Guardrails HLD

**Phase**: 3 - High-Level Design
**Date**: 2026-03-22
**Status**: Complete

---

## Clarifying Questions & Resolutions

### Architecture & Data Flow

1. **Q: What is the preferred architecture pattern?**
   - Classification: ANSWERED
   - Source: `packages/compiler/src/platform/guardrails/pipeline.ts` (tiered orchestration)
   - Answer: 3-tier pipeline with port adapter pattern. Compiler owns evaluation logic; runtime provides infrastructure.

2. **Q: How does data flow through the system?**
   - Classification: ANSWERED
   - Source: `pipeline-factory.ts`, `streaming-evaluator.ts`, execution integration tests
   - Answer: Request path: input validation -> LLM reasoning -> output validation. Event-driven: trace events emitted per check. Streaming: sentence-boundary buffered evaluation.

3. **Q: What is the deployment topology?**
   - Classification: INFERRED
   - Source: Pipeline factory uses lazy singletons and in-memory Maps
   - Answer: Single-pod deployment with shared in-memory state. Provider registries are pod-local with DB-backed refresh. Redis provides cross-pod cache and cost tracking.

### Integration & Dependencies

4. **Q: Which existing services does this depend on?**
   - Classification: ANSWERED
   - Source: Import analysis of pipeline-factory.ts, policy-resolver.ts
   - Answer: Redis (cache + cost), MongoDB (policies + providers), Auth profiles (credential resolution), Session LLM client (Tier 3), Trace store (observability).

5. **Q: Breaking changes to existing APIs?**
   - Classification: ANSWERED
   - Source: Route registration in runtime index
   - Answer: No breaking changes. Guardrails adds new routes behind feature gate. Execution integration uses opt-in pipeline calls.

### Risk & Migration

6. **Q: What is the biggest technical risk?**
   - Classification: DECIDED
   - Answer: E2E testing gap. The provider x kind matrix has 84% untested combinations. False positive rates for model-based providers cannot be validated without E2E tests.

7. **Q: Rollback strategy?**
   - Classification: ANSWERED
   - Source: `requireFeature('guardrails')`, `GUARDRAILS_ENABLED` env var, policy `status` field
   - Answer: Three levels: (1) env var kills pipeline evaluation, (2) feature gate disables routes, (3) policy status allows per-policy deactivation.

## 12 Concerns Verification

All 12 architectural concerns addressed:

- [x] 1. Tenant Isolation (tenantIsolationPlugin, per-tenant registries, 404 on cross-tenant)
- [x] 2. Data Access Pattern (direct Mongoose, 5-min TTL cache, Redis for eval cache)
- [x] 3. API Contract (REST with error envelope, project-scoped policies, tenant-scoped providers)
- [x] 4. Security Surface (auth + rate limit + feature gate, encrypted credentials, SSRF, HMAC)
- [x] 5. Error Model (fail-open default, configurable fail-closed, trace events for errors)
- [x] 6. Failure Modes (circuit breaker, cache fail-open, cost tracker fail-open, webhook retry)
- [x] 7. Idempotency (content-addressable cache, atomic INCRBY, at-least-once webhook)
- [x] 8. Observability (15 trace event types covering full pipeline lifecycle)
- [x] 9. Performance Budget (Tier 1 <5ms, Tier 2 <500ms, Tier 3 <5s, early termination)
- [x] 10. Migration Path (extensible adapter enum, no schema migration for new providers)
- [x] 11. Rollback Plan (3 levels: env var, feature gate, policy status)
- [x] 12. Test Strategy (unit + integration + compiler E2E passing; runtime E2E gaps documented)

## Alternatives Considered

3 alternatives analyzed:

- [x] A: Single-tier LLM (rejected: too slow/expensive)
- [x] B: 3-tier pipeline with early termination (chosen)
- [x] C: External guardrail service (rejected: data sovereignty, vendor lock-in)

## Key Findings

- Port adapter pattern is the key architectural decision enabling testability
- 3-tier architecture handles 80%+ of evaluations at Tier 1 (zero cost)
- Per-tenant provider registry is essential for Core Invariant #1
- 7 upstream dependencies identified with risk assessment
- 5 downstream dependents identified with impact assessment
- 8 design decisions documented with rationale and rejected alternatives

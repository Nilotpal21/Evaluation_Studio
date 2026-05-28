# Test Spec Phase Log — Arch Trace Explorer

**Skill**: `/test-spec`
**Ticket**: ABLP-162
**Feature**: arch-trace-explorer
**Feature Spec**: `docs/features/arch-trace-explorer.md` (committed c84400894)
**Date**: 2026-04-15
**Owner**: Platform team

---

## Oracle Decisions

The product-oracle was invoked with 18 clarifying questions (5 Test Scope, 5 E2E, 5 Integration, 3 Infrastructure). All 18 answered — **0 AMBIGUOUS** — so no user escalation required.

### Summary by Classification

- **ANSWERED**: 11 (evidence in feature spec or existing patterns)
- **INFERRED**: 1 (TSP-5 regression-worthy predecessor failures)
- **DECIDED**: 6 (platform default applied with documented rationale)
- **AMBIGUOUS**: 0

### Key DECIDED items (rationale captured)

| ID  | Decision                                                                           | Rationale                                                                          | Risk   |
| --- | ---------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------- | ------ |
| D-1 | Auth matrix: 2 permission variants E2E; 6 variants integration                     | E2E cost high; 404-vs-403 nuance covered by `withRouteHandler` middleware ordering | Low    |
| D-2 | Full Arch AI flow: 1 E2E (E2E-1) + `_seed` for the rest                            | Predecessor `_seed` pattern proven canonical; avoids 5+ slow/flaky real-LLM E2Es   | Medium |
| D-3 | Seeding: `POST /api/arch-ai/traces/_seed` guarded by `NODE_ENV=test` + admin role  | Direct precedent at `/api/arch-ai/audit-logs/_seed/route.ts`                       | Low    |
| D-4 | No load tests for v1; span cap tested at integration tier                          | Predecessor never implemented PERF; 2K span cap is correctness, not throughput     | Low    |
| D-5 | No concurrent-flush test (single-writer invariant); error-vs-end race is unit-only | Testing architecturally-impossible states produces false failure modes             | Low    |
| D-6 | Add unit test: redaction-boundary-throws isolation (not in skeleton)               | Redaction failure must not break emission — feature spec §12 promises this         | Low    |
| D-7 | Add INT-8 (phase-transition instrumentation), INT-9 (span cap + poll cap)          | Closes predecessor gaps; covers FR-22 end-to-end                                   | Low    |
| D-8 | Use two E2E tiers: vitest in-process for API scenarios + Playwright browser for UI | Both tiers canonical in repo; fit different assertion classes                      | Low    |

### Regression additions from TSP-5 (INFERRED from predecessor gaps)

Four failure modes from `arch-audit-logs` ALPHA state are now explicit regression tests:

1. `onStepFinish` wired through BOTH onboarding and build `streamText()` call sites (predecessor only wired onboarding) → INT-7
2. `transitionPhase()` instrumentation test (predecessor deferred phase-transition) → new INT-8
3. Tenant-delete cascade explicit integration test (predecessor deferred this entirely) → INT-10
4. All 5 span levels present from real message-route flow (not just directionally) → E2E-1 explicit assertion

### Cross-references

- Seeding endpoint pattern: `apps/studio/src/app/api/arch-ai/audit-logs/_seed/route.ts`
- Mongo test harness: `packages/database/src/__tests__/helpers/setup-mongo.ts`
- Playwright helpers: `apps/studio/e2e/helpers/index.ts`
- Vitest in-process E2E pattern: `apps/studio/src/__tests__/e2e/arch-ai-sessions.e2e.test.ts`
- Route handler middleware ordering: `apps/studio/src/lib/route-handler.ts`

---

## Phase Checkpoints

- [x] Phase 1: Feature spec read fresh from disk (`docs/features/arch-trace-explorer.md`)
- [x] Phase 2: Oracle answered 18 questions, 0 escalated
- [x] Phase 2: Oracle decisions logged here
- [x] Phase 3: Test spec generated (6 E2E, 11 integration, 13 unit scenarios; 23/23 FRs covered)
- [x] Phase 4: Cross-references updated (testing README B06 row: 11 integration, PLANNED 04-15)
- [x] Phase 4b: Audit Round 1 — NEEDS_REVISION with 0 CRITICAL, 3 HIGH, 4 MEDIUM findings
- [x] Phase 4b: Audit Round 2 — **APPROVED**. All R1 findings resolved.
- [ ] Phase 5: Committed with `[ABLP-162] docs(studio): add arch-trace-explorer test spec`

---

## Audit Round 1 Findings (Resolved)

| ID       | Level  | Finding                                                                                            | Fix Applied                                                                                                                               |
| -------- | ------ | -------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------- |
| HIGH-1   | HIGH   | `@agent-platform/database/testing` subpath export does not exist                                   | §3 rewritten to use local `MongoMemoryServer` boot-and-skip pattern; subpath export deferred to LLD                                       |
| HIGH-2   | HIGH   | INT-3 referenced an `updateStatus` sub-action not declared in `_seed` endpoint schema              | §7 seed endpoint body expanded into discriminated union with four actions (`seedSpans`, `updateStatus`, `bubbleError`, `reset`)           |
| HIGH-3   | HIGH   | INT-4 punted `startTime` derivation rule back to "spec must define"                                | Pinned rule in INT-4: `startTime = endTime − durationMs` if `durationMs` present, else `endTime`. Firm expectation for HLD/LLD to honour. |
| MEDIUM-5 | MEDIUM | No explicit 401 unauthenticated assertion in INT-1                                                 | Added INT-1 step 0: unauthenticated → 401                                                                                                 |
| MEDIUM-6 | MEDIUM | `permissions: 'arch:traces:read'` passed as string literal, not `StudioPermission` constant        | Added compile-time anchor asserting `StudioPermission.ARCH_TRACES_READ === 'arch:traces:read'` in INT-1 setup                             |
| MEDIUM-7 | MEDIUM | INT-3 used absolute revision numbers (5, 10, 20, 21) that cannot be pre-assigned by `$inc` counter | Rewrote using relative ordering (`r_before`, `r0 < r1 < r2 < r3`) so test reads by relative revisions, not fixed values                   |
| MEDIUM-4 | MEDIUM | Test spec §8 lists 18 files; feature spec §10 lists 10 (drift)                                     | Added post-impl-sync reconciliation note after §8 table                                                                                   |

---

## Audit Round 2 — Non-blocking Notes for LLD

These three items are not test-spec defects — they are code-reference inaccuracies that the LLD phase should resolve:

1. `apps/studio/src/__tests__/helpers/sessions.ts` is referenced as a reusable helper but does not exist today; LLD Phase 6.7 / 7.5 must create it.
2. `GET /api/arch-ai/sessions/:id/status` (referenced in E2E-2 step 3) does not exist — the base `GET /api/arch-ai/sessions/:id` returns status. Minor path correction at implementation time.
3. `VercelLLMStreamClient` (referenced in INT-7 boundary label) does not exist as a class today — feature spec §7 uses the name aspirationally. LLD must decide: extract a dedicated client class or instrument inline `streamText()` calls in `apps/studio/src/app/api/arch-ai/message/route.ts`.

**Net**: the test spec is internally consistent with the feature spec; any LLD deviation will surface as a design decision, not a test-spec defect.

# SDLC Log: ABL Spec-Implementation Parity — Test Spec Phase

**Date**: 2026-03-25
**Phase**: Test Spec (Phase 2 of SDLC)
**Artifact**: `docs/testing/abl-spec-impl-parity.md`

---

## Oracle Decisions

15 clarifying questions asked. Oracle answered all 15 — zero AMBIGUOUS.

### ANSWERED (from docs/code)

| Q#  | Question                            | Classification | Answer Summary                                                                                                                                 |
| --- | ----------------------------------- | -------------- | ---------------------------------------------------------------------------------------------------------------------------------------------- |
| Q1  | Highest risk FRs?                   | ANSWERED       | FR-1 (ESCALATE) highest, FR-3 (HOOKS) and FR-8 (ON_ERROR) high, FR-4 (PROFILES) and FR-5 (Voice) medium                                        |
| Q3  | Current test baseline?              | ANSWERED       | FR-1: 88 unit tests, FR-4: 123, FR-5: 200+, FR-7: 150+. FR-2: 0, FR-3: 3 (ON_START only), FR-6: 15, FR-8: 0 (8 TODO stubs)                     |
| Q4  | External deps for mocking?          | ANSWERED       | REAL: Express, escalation-bridge, transfer-tool-executor, agent-transfer, MongoDB, Redis. MOCK via DI: ITSM APIs, TTS providers, LLM providers |
| Q5  | Test infrastructure?                | ANSWERED       | Vitest 4.x, runtime-api-harness, MongoMemoryServer, redis-server-harness, 4 config tiers (default/integration/flaky/smoke)                     |
| Q6  | Critical E2E journeys?              | ANSWERED       | 8 journeys: escalation lifecycle, ITSM ticket, hooks per-turn, profile tool mod, ON_ERROR recovery, voice IR, action handlers, gather attach   |
| Q9  | Data seeding?                       | INFERRED       | DSL-based: compileToResolvedAgent() with ABL strings. 7 fixture types needed (escalation, hooks, profile, voice, action, attachment, error)    |
| Q11 | Service boundaries for integration? | ANSWERED       | 7 boundaries: EscalationBridge→TransferToolExecutor, ErrorHandler→RuntimeExecutor, ProfileResolver→ReasoningExecutor, Hook→ToolBinding, etc.   |
| Q12 | Webhook/event-driven flows?         | ANSWERED       | 4 flows: ITSM webhook delivery, agent-transfer events, escalation EventBus, hook tool call results                                             |

### INFERRED

| Q#  | Question                        | Classification | Answer Summary                                                                                                        |
| --- | ------------------------------- | -------------- | --------------------------------------------------------------------------------------------------------------------- |
| Q2  | Known edge cases/failure modes? | INFERRED       | 5 documented: escalation negatives (12 patterns), no agent-transfer fallback, profile tool gap, ON_ERROR stubs, race  |
| Q7  | Auth/permission combos?         | INFERRED       | 5 combos: cross-tenant 404, project permission for resolution, session ownership, hook tool tenant scoping, ITSM auth |
| Q8  | Cross-feature interactions?     | INFERRED       | 6 interactions: PROFILES+Voice, ESCALATE+HOOKS, HOOKS+ON_ERROR, PROFILES+ESCALATE, ACTION+GATHER, ON_ERROR+ESCALATE   |
| Q13 | Isolation beyond cross-tenant?  | INFERRED       | 7 scenarios: cross-project, HumanTask query scoping, session ownership, hook tenant context, ITSM connector scoping   |
| Q14 | Race conditions/concurrency?    | INFERRED       | 6 scenarios: double escalation TOCTOU, escalation+message, resolution while processing, concurrent hooks, etc.        |
| Q15 | Error/failure paths?            | INFERRED       | 12 failure paths: agent-transfer down, adapter not found, ITSM timeout/error, hook tool not found/error/timeout, etc. |

### DECIDED

| Q#  | Question                | Classification | Decision                                                                                         | Rationale                                                        |
| --- | ----------------------- | -------------- | ------------------------------------------------------------------------------------------------ | ---------------------------------------------------------------- |
| Q10 | Performance/load tests? | DECIDED        | Include 4 targeted scenarios (hooks latency, concurrent escalation, hook timeout, profile scale) | Feature spec calls out hooks latency; full load testing deferred |

---

## Test Spec Summary

| Metric             | Count              |
| ------------------ | ------------------ |
| E2E scenarios      | 16                 |
| Integration        | 12                 |
| Unit               | 10                 |
| Security/Isolation | 15 checklist items |
| Performance        | 4                  |
| Cross-feature      | 6                  |
| Open questions     | 5                  |

---

## Audit Round 1 (2026-03-25)

**Verdict**: NEEDS_REVISION — 2 CRITICAL, 3 HIGH, 2 MEDIUM

**CRITICAL findings (resolved):**

1. TS-10: E2E-9 and INT-7 grounded in fabricated VoiceConfigIR fields (`provider`, `voice_id`, `speed` don't exist yet) — added implementation prerequisite notes
2. TS-3: `connector_action` field doesn't exist on `EscalationConfig` IR — added implementation prerequisite notes to E2E-2, E2E-3, INT-10

**HIGH findings (resolved):**

1. TS-5: No cross-user isolation scenario — added E2E-16
2. TS-7: E2E-12 missing auth context and trace assertions — added
3. TS-6: MongoMemoryServer in E2E-1 preconditions misleading — clarified as "Runtime API harness"

**MEDIUM findings (resolved):**

1. TS-8: INT-12 depends on FR-1 for `then: "escalate"` — added dependency note
2. TS-9: Cross-feature scenarios not mapped to test files — added file paths

## Audit Round 2 (2026-03-25)

**Verdict**: APPROVED — 0 CRITICAL, 1 HIGH, 1 MEDIUM

**HIGH finding (resolved):**

1. TS-10: `max_file_size` should be `max_file_size_bytes` per actual IR type — corrected in test spec

**MEDIUM finding (noted, non-blocking):**

1. TS-8: INT-3 DEFAULT handler type convention — documented for implementer clarity during HLD

All round 1 fixes verified correct.

---

## Files Created/Updated

- `docs/testing/abl-spec-impl-parity.md` — Comprehensive test spec (replaced placeholder)
- `docs/sdlc-logs/abl-spec-impl-parity/test-spec.log.md` — This file

---

## Next Phase

Run `/hld abl-spec-impl-parity` to generate the High-Level Design document.

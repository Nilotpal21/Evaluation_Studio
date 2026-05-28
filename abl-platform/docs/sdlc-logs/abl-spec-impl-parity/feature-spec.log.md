# SDLC Log: ABL Spec-Implementation Parity — Feature Spec Phase

**Date**: 2026-03-24
**Phase**: Feature Spec (Phase 1 of SDLC)
**Artifact**: `docs/features/abl-spec-impl-parity.md`

---

## Oracle Decisions

15 clarifying questions asked. Oracle answered 13, 2 escalated as AMBIGUOUS.

### ANSWERED (from docs/code)

| Q#  | Question                       | Classification | Answer Summary                                                                                                                                                                       |
| --- | ------------------------------ | -------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| Q1  | Complete list of spec gaps?    | ANSWERED       | 3 items removed (already wired: guardrails, ON_ERROR retry, DELEGATE resume). 4 new gaps added (HOOKS, TEMPLATES, BEHAVIOR_PROFILES, agent-level ON_ERROR). 10 confirmed gaps total. |
| Q4  | Intentionally deferred items?  | ANSWERED       | grant_memory (Roadmap), breakpoints, trace export/playback, extensions — all intentional. ESCALATE echo mode is pragmatic intermediate, not permanent.                               |
| Q9  | Backward compatibility?        | ANSWERED       | 3 items need care: ESCALATE pause (gate on on_human_complete), HOOKS (validate tool refs at compile), TEMPLATES (behavior change from literal to resolved).                          |
| Q10 | Must-have vs nice-to-have?     | ANSWERED       | Must: ESCALATE, HOOKS, TEMPLATES, ON_ERROR, STATUS.md. Should: Voice IR, BEHAVIOR_PROFILES, ACTION_HANDLERS, GATHER attachments. Nice: doc cleanup, grant_memory.                    |
| Q11 | Packages affected?             | ANSWERED       | apps/runtime is PRIMARY for all gaps. Parser/compiler already complete.                                                                                                              |
| Q12 | Guardrail wiring hook point?   | ANSWERED       | Gap is CLOSED. Guardrails fully wired at 5 checkpoints. STATUS.md stale.                                                                                                             |
| Q14 | Tool type validator expansion? | ANSWERED       | No — connector/workflow/searchai have dedicated executor paths.                                                                                                                      |
| Q15 | Data model changes?            | INFERRED       | Only ESCALATE: HumanTask needs resolution fields, Session needs "escalated" status.                                                                                                  |

### INFERRED

| Q#  | Question          | Classification | Answer Summary                                                                                                             |
| --- | ----------------- | -------------- | -------------------------------------------------------------------------------------------------------------------------- |
| Q6  | Primary personas? | INFERRED       | 1) Agent developers (PRIMARY — false confidence), 2) Platform operators (SECONDARY — stale docs), 3) End users (INDIRECT). |

### DECIDED (oracle judgment)

| Q#  | Question                       | Classification | Decision                                                | Rationale                                                             |
| --- | ------------------------------ | -------------- | ------------------------------------------------------- | --------------------------------------------------------------------- |
| Q2  | Fix all gaps at once?          | DECIDED        | Phase into 3 tiers (Must Fix / Should Fix / Defer)      | 10 gaps too large for one effort                                      |
| Q3  | Fix spec or code?              | DECIDED        | Bidirectional sync                                      | STATUS.md is stale (fix docs), HOOKS not wired (fix code)             |
| Q7  | "Production wired" definition? | DECIDED        | Execute + E2E + traces                                  | Matches CLAUDE.md mandates                                            |
| Q8  | Studio UI blocking?            | DECIDED        | No — generic trace viewers surface events automatically | Existing SpanTree/EventTimeline                                       |
| Q13 | ESCALATE MVP scope?            | DECIDED        | API + agent-transfer + ITSM webhook                     | User confirmed: wire with agent-transfer + connector actions for ITSM |

### AMBIGUOUS → User Resolved

| Q#        | Question         | User Answer                                                                       |
| --------- | ---------------- | --------------------------------------------------------------------------------- |
| Q5 (A-1)  | Timeline driver? | Tech-debt cleanup, no deadline                                                    |
| Q13 (A-2) | ESCALATE scope?  | Wire with agent-transfer module + connector actions for ITSM (ServiceNow/Zendesk) |

---

## Key Corrections from Oracle

The initial investigation (pre-oracle) identified 10 gaps. The oracle corrected this:

**Removed (already wired, STATUS.md is stale):**

1. Guardrails — `createGuardrailPipeline()` called in reasoning-executor.ts, flow-step-executor.ts, routing-executor.ts
2. ON_ERROR retry — `executeWithRetry()` in error-handler-router.ts with backoff
3. DELEGATE with resume — `mapDelegateReturns()` and `__return_to_parent__` in routing-executor.ts

**Added (newly identified gaps):**

1. HOOKS lifecycle — IR types exist, zero runtime execution
2. TEMPLATES named resolution — RESPOND: TEMPLATE(name) not resolved
3. BEHAVIOR_PROFILES tool/voice overrides — WHEN evaluates but overrides not applied
4. Agent-level ON_ERROR — non-tool errors (invalid_input, validation_error, unknown_error)

---

## Files Created

- `docs/features/abl-spec-impl-parity.md` — Feature spec (PLANNED)
- `docs/testing/abl-spec-impl-parity.md` — Testing guide placeholder (PLANNED)
- `docs/sdlc-logs/abl-spec-impl-parity/feature-spec.log.md` — This file

---

## Open Questions (carried forward)

1. ESCALATE timeout behavior (auto-resume vs indefinite pause)
2. HOOKS ordering with guardrails (before or after input guardrails?)
3. TEMPLATES and LLM context (include resolved text in LLM context?)
4. BEHAVIOR_PROFILES TOOLS_ADD type safety (complete definition or reference?)
5. ACTION_HANDLERS IR type (exists or needs creation?)

---

## Audit Round 1 (2026-03-24)

**Verdict**: NEEDS_REVISION — 4 CRITICAL, 5 HIGH, 3 MEDIUM

**CRITICAL findings (all resolved):**

1. TEMPLATES compile-time resolution — removed from gap list entirely
2. 3 fabricated IR type names — corrected to EscalationConfig, HooksConfig/HookAction, Record<string,string>
3. HumanTask data model fabricated — rewritten with actual IHumanTaskSource/IHumanTaskResponse
4. Session "escalated" status already exists — delivery plan says "verify" not "add"

**HIGH findings (all resolved):**

1. FR-2 ITSM is new scope — acknowledged explicitly
2. FR-1 conflates existing/new — restructured
3. FR-4 template fallback untestable — FR removed
4. Data model indexes wrong — corrected to actual indexes
5. ABL Language relationship type — changed to "depends on"

## Audit Round 2 (2026-03-25)

**Verdict**: NEEDS_REVISION — 1 CRITICAL, 3 HIGH, 2 MEDIUM

**CRITICAL finding (resolved):**

1. VoiceConfigIR fields fabricated — `provider`, `voice_id`, `speed` do NOT exist on the type (only ssml, instructions, plain_text). FR-5 rewritten as compiler+runtime gap. Delivery plan updated with compiler subtask.

**HIGH findings (all resolved):**

1. OnHumanComplete is `{ condition: string; action: string }`, not a rich executable block — FR-1 clarified
2. HookAction has no `critical` field — noted as potential IR extension, decision deferred to HLD
3. GAP-003 refined — profile merge happens (`buildEffectiveConfig` at profile-resolver.ts:294), but reasoning-executor only consumes `additionalConstraints` (line 1020), not merged tool set

**MEDIUM findings (resolved):**

1. Delivery plan lacks sequencing — added dependency/parallelism note
2. User story numbering skips 5 — renumbered 1-9

## Next Phase

Run `/test-spec abl-spec-impl-parity` to generate the comprehensive test specification.

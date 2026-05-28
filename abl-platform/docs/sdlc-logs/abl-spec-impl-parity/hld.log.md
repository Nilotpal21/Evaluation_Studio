# SDLC Log: ABL Spec-Implementation Parity — HLD Phase

**Date**: 2026-03-25
**Phase**: HLD (Phase 3 of SDLC)
**Artifact**: `docs/specs/abl-spec-impl-parity.hld.md`

---

## Oracle Decisions

15 clarifying questions asked (5 per section). Oracle answered all 15 — zero AMBIGUOUS.

### Architecture & Data Flow (ANSWERED/DECIDED)

| Q#  | Question                                         | Classification | Answer Summary                                                                                                      |
| --- | ------------------------------------------------ | -------------- | ------------------------------------------------------------------------------------------------------------------- |
| Q1  | Preferred architecture for escalation dual-path? | DECIDED        | routing-executor orchestrates transfer inline, escalation-bridge handles async HumanTask. Reuse existing modules.   |
| Q2  | Where does connector_action live in IR?          | DECIDED        | New `connector_action?: string` field on `EscalationConfig`. Connector resolved from packages/connectors by name.   |
| Q3  | Hook execution model — inline or queue?          | DECIDED        | Inline, synchronous within request lifecycle. Reuse ToolBindingExecutor for CALL. Timeout-isolated via AbortSignal. |
| Q4  | Feature flag vs IR-gated activation?             | DECIDED        | IR-gated activation — no feature flags. Each feature self-gates on IR field presence. Shadow mode proven wasteful.  |
| Q5  | HookAction critical field — add to IR?           | DECIDED        | Add `critical?: boolean` to HookAction, default false. Non-critical hooks log warning and continue.                 |

### Integration & Dependencies (ANSWERED/INFERRED)

| Q#  | Question                                   | Classification | Answer Summary                                                                                                            |
| --- | ------------------------------------------ | -------------- | ------------------------------------------------------------------------------------------------------------------------- |
| Q6  | Which agent-transfer tools for ESCALATE?   | ANSWERED       | `transfer_to_agent` and `set_queue` via TransferToolExecutor. Other 6 tools (ivr, deflect) not relevant for escalation.   |
| Q7  | Connector action dispatch path?            | ANSWERED       | Existing connector infrastructure (packages/connectors). Fire connector action with context_for_human as payload.         |
| Q8  | Profile resolver per-turn vs session-init? | INFERRED       | Per-turn re-evaluation needed. prompt-builder.ts:646 already consumes \_effectiveConfig.tools. Gap is per-turn re-eval.   |
| Q9  | Compiler changes needed?                   | ANSWERED       | VoiceConfigIR extension (3 fields), ACTION_HANDLERS block compilation (to existing ActionHandlerIR), HookAction critical. |
| Q10 | OnHumanComplete extensibility?             | DECIDED        | Keep minimal: { condition: string; action: string }. Action maps to known values. Extend later if needed.                 |

### Risk & Migration (ANSWERED/INFERRED)

| Q#  | Question                | Classification | Answer Summary                                                                                                           |
| --- | ----------------------- | -------------- | ------------------------------------------------------------------------------------------------------------------------ |
| Q11 | Biggest technical risk? | INFERRED       | Session pause/resume for escalation. Must survive pod restarts. Follow await-attachment resumption-service pattern.      |
| Q12 | Data migration needed?  | ANSWERED       | No migration. HumanTask 3 new optional fields (MongoDB schema-less). VoiceConfigIR new optional fields. All additive.    |
| Q13 | Rollback strategy?      | INFERRED       | Per-feature revert. IR-gated means old runtime ignores new IR fields. Each FR independently deployable/revertable.       |
| Q14 | Breaking changes?       | ANSWERED       | None. All new behavior is additive and IR-gated. Existing agents see zero behavior change.                               |
| Q15 | Deployment order?       | INFERRED       | Compiler first (new IR fields), then runtime (consumes new fields). Reverse order safe too (runtime ignores unknown IR). |

---

## Architecture Explorer Findings

8 key runtime files analyzed with specific line numbers:

1. **escalation-bridge.ts** (91 lines): EventBus subscription, HumanTask creation with idempotency, fire-and-forget pattern
2. **reasoning-executor.ts** (3,114 lines): Main reasoning loop at line 1074, hook injection points at ~1070 and ~1240, tool dispatch at line 2154
3. **error-handler-router.ts** (203 lines): resolveErrorHandler at line 45, executeWithRetry at line 163
4. **flow-step-executor.ts** (4,632 lines): GATHER at line 3702, action handlers at lines 2379-2460
5. **korevg-session.ts** (2,707 lines): Constructor at lines 377-399, default elevenlabs vendor
6. **profile-resolver.ts** (469 lines): buildEffectiveConfig at line 294, tool merge at lines 373-375
7. **transfer-tool-executor.ts** (211 lines): 8 transfer tools, adapter pattern
8. **sessions.ts** (2,566 lines): Routes under /api/projects/:projectId/sessions

---

## Key Design Decisions

1. **Option A (Incremental wiring)** chosen over Option B (Lifecycle orchestrator) and Option C (Feature flags). Guardrail wiring pattern proven successful.
2. **3 new modules**: hook-executor.ts, resolution-handler.ts, voice-config-resolver.ts
3. **IR extensions**: VoiceConfigIR (+3 fields), HookAction (+critical), EscalationConfig (+connector_action)
4. **2 new API endpoints**: escalation resolution and status
5. **8 trace event types** for observability
6. **IR-gated activation** for all features — no feature flags

---

## Audit Round 1 (2026-03-25)

**Verdict**: NEEDS_REVISION — 3 CRITICAL, 4 HIGH, 3 MEDIUM

**CRITICAL findings (all resolved):**

1. HD-6: FR-8 ON_ERROR gap mischaracterized — agent-level error handler chain already exists in error-handler-router.ts. Real gap is wiring non-tool error sites. Section 10.4 rewritten.
2. HD-4: VoiceConfigIR resolver referenced fabricated `ir.execution?.voice` path — ExecutionConfig has no voice field. Decided to add `voice?: VoiceConfigIR` to ExecutionConfig. Section 10.3 + 10.5 updated.
3. HD-2: EscalationConfig `on_human_complete` shown as optional but is required. Missing `EscalationRouting` field. Fixed with correct types and field mapping.

**HIGH findings (all resolved):**

1. HD-6: API path inconsistency — HLD correct (`/api/projects/:projectId/sessions/...`), feature/test spec incorrect. Cross-phase note added.
2. HD-4: EscalationRouting → agent-transfer parameter mapping missing — added to data flow section.
3. HD-5: `session:resolve` permission doesn't exist — changed to `session:execute` (existing).
4. HD-7: Rate limiting for hook tool calls — added impact analysis.

## Audit Round 2 (2026-03-25)

**Verdict**: NEEDS_REVISION — 0 CRITICAL, 2 HIGH, 3 MEDIUM

**HIGH findings (all resolved):**

1. HD-4: IR-gated activation table used fabricated `ir.on_error` — corrected to `ir.error_handling.handlers.some(...)`.
2. HD-2: ON_ERROR action list omitted `backtrack` — added with `backtrack_to` explanation.

**MEDIUM findings (addressed):**

1. HD-4: HookAction `critical` consistency — verified HLD is internally consistent (feature spec has stale language).
2. HD-5: Key implementation file for ITSM — entry is in feature spec, not HLD.
3. HD-10: Open questions mixed decisions and open items — split into subsections.

## Audit Round 3 (2026-03-25)

**Verdict**: APPROVED — 0 CRITICAL, 0 HIGH, 1 MEDIUM

**MEDIUM finding (noted, non-blocking):**

1. XP-4: Feature spec delivery plan item 3.3 conflates handler body fields with `then` directive values. Flagged for LLD/post-impl-sync correction.

All round 1 + round 2 fixes verified correct. HLD ready for LLD phase.

---

## Files Created/Updated

- `docs/specs/abl-spec-impl-parity.hld.md` — HLD document
- `docs/sdlc-logs/abl-spec-impl-parity/hld.log.md` — This file

---

## Next Phase

After 3 audit rounds, run `/lld abl-spec-impl-parity` to generate the Low-Level Design document.

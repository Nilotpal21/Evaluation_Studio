# SDLC Log: ABL Spec-Implementation Parity — LLD Phase

**Date**: 2026-03-25
**Phase**: LLD (Phase 4 of SDLC)
**Artifact**: `docs/plans/2026-03-25-abl-spec-impl-parity-impl-plan.md`

---

## Oracle Decisions

15 clarifying questions asked (5 per section). Oracle answered all 15 — zero AMBIGUOUS.

### Implementation Strategy (ANSWERED/INFERRED)

| Q#  | Question                          | Classification | Answer Summary                                                                                                                                                 |
| --- | --------------------------------- | -------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Q1  | Preferred implementation order?   | ANSWERED       | Compiler IR first (types foundation), then runtime features in dependency order: ESCALATE → HOOKS+ON_ERROR → Profile+Voice → ActionHandlers+Attachments → Docs |
| Q2  | Existing patterns to follow?      | ANSWERED       | Guardrail wiring pattern (pure function, called from executors, trace events, IR-gated). Resumption-service pattern for escalation pause/resume.               |
| Q3  | Feature flag vs IR-gated rollout? | ANSWERED       | IR-gated activation — decided in HLD. Each feature self-gates on IR field presence.                                                                            |
| Q4  | Phase 1 scope vs later phases?    | INFERRED       | Phase 1 = all IR schema + compiler extensions. Runtime wiring in subsequent phases by feature grouping.                                                        |
| Q5  | Hard deadlines?                   | ANSWERED       | No deadline — tech-debt cleanup. Quality over speed.                                                                                                           |

### Technical Details (ANSWERED/INFERRED)

| Q#  | Question                                   | Classification | Answer Summary                                                                                                                                                 |
| --- | ------------------------------------------ | -------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Q6  | Which files need modification vs creation? | ANSWERED       | 10 new files (hook-executor, resolution-handler, voice-config-resolver, itsm-connector, 6 test files). 14 modified files.                                      |
| Q7  | Test-first or test-after?                  | INFERRED       | Test-after per phase — each phase has E2E exit criteria. compileToResolvedAgent() for seeding, startRuntimeServerHarness() for E2E.                            |
| Q8  | Type definitions that need to change?      | ANSWERED       | VoiceConfigIR +3 fields, VoiceConfigAST +3 fields, ExecutionConfig +voice, HookAction +critical, EscalationConfig +connector_action, HumanTask +3 ITSM fields. |
| Q9  | Database migration strategy?               | ANSWERED       | No migration. MongoDB schema-less — all new fields are optional/additive. HumanTask gets 3 new optional ITSM fields.                                           |
| Q10 | Performance-sensitive paths?               | INFERRED       | Hook execution inline in request lifecycle (timeout-isolated). Profile per-turn re-eval adds ~2ms. Voice resolver is session-init only.                        |

### Risk & Dependencies (ANSWERED/INFERRED)

| Q#  | Question                             | Classification | Answer Summary                                                                                                  |
| --- | ------------------------------------ | -------------- | --------------------------------------------------------------------------------------------------------------- |
| Q11 | Ongoing changes that could conflict? | ANSWERED       | attachments-gap-closure (Phase 3/4 on develop branch) — GATHER attachment work must coordinate with FR-7.       |
| Q12 | Biggest implementation risk?         | INFERRED       | Escalation session pause/resume — must survive pod restarts. Mitigated by following resumption-service pattern. |
| Q13 | Team dependencies?                   | INFERRED       | No external team deps. All code within monorepo packages accessible to single implementer.                      |
| Q14 | Monitoring/alerting before rollout?  | INFERRED       | 8 trace event types defined in HLD. Existing TraceStore infrastructure. No new alerting infra needed.           |
| Q15 | Definition of done?                  | ANSWERED       | All 9 FRs "production wired" — runtime execution verified via E2E, trace events emitted, ABL_SPEC.md updated.   |

---

## Explorer Findings

Architecture explorer analyzed 12 key files with specific line numbers:

1. **schema.ts** — VoiceConfigIR (line 23), ExecutionConfig (line 390), EscalationConfig (line 1241), HookAction (line 1345)
2. **compiler.ts** — compileVoiceConfig (line 1688), compileActionHandlers (line 1746), compileHooks (line 2363), ExecutionConfig compilation (line 516)
3. **reasoning-executor.ts** — resolveErrorHandler called ONLY for tool_error (line 2796), outer catch has no error handler (line 3010)
4. **error-handler-router.ts** — 3-step chain exists (step → agent → default), ErrorHandler.then includes backtrack
5. **profile-resolver.ts** — assembleProfileContext (line 155), buildEffectiveConfig (line 294), tool merge (line 373)
6. **runtime-executor.ts** — Profile resolution at session init only (line 751)
7. **flow-step-executor.ts** — Action handler dispatch (line 2379), GATHER (line 3702)
8. **escalation-bridge.ts** — EventBus subscription (line 89), HumanTask creation (line 32)
9. **korevg-session.ts** — KorevgSessionConfig (line 231), defaults elevenlabs (line 377)
10. **sessions.ts** — Uses `:id` param (line 100), middleware chain
11. **resumption-service.ts** — Class-based DI, distributed locks, atomic claim pattern
12. **await-attachment-executor.ts** — pendingAwaitAttachment on thread, waitingForInput signal

---

## Key Design Decisions

1. **6 implementation phases** — Compiler → ESCALATE → HOOKS+ON_ERROR → Profile+Voice → ActionHandlers+Attachments → Docs
2. **10 new files**, 14 modified files across compiler, runtime, core, database packages
3. **Guardrail wiring pattern** reused for hooks + ON_ERROR (pure function, executor call sites, trace events)
4. **Resumption-service pattern** reused for escalation session pause/resume
5. **IR-gated activation** — no feature flags, each feature self-gates on IR field presence
6. **Per-turn profile re-evaluation** — add re-eval call in reasoning-executor before each LLM turn
7. **VoiceConfigIR extension** — 3 new fields (provider, voice_id, speed) + VoiceConfigAST extension in core
8. **E2E via startRuntimeServerHarness()** — real servers, full middleware, compileToResolvedAgent() seeding

---

## Audit Rounds

### Round 1 (2026-03-25) — NEEDS_CHANGES

**Focus**: Architecture compliance — isolation, auth, stateless, traceability
**Auditor**: lld-reviewer
**Verdict**: NEEDS_CHANGES — 2 CRITICAL, 4 HIGH, 5 MEDIUM

**CRITICAL findings (resolved):**

1. F-01: Task 2.3 modified wrong file — escalation-bridge.ts is EventBus-only with no session access. Agent-transfer wiring already exists in routing-executor.ts:handleEscalate() (lines 2487-2560). → Moved all session mutation, ITSM, pause logic to routing-executor.ts. Bridge keeps HumanTask creation only.
2. F-02: All IR path references used `ir.escalation` — actual path is `ir.coordination.escalation` (confirmed routing-executor.ts:2413). → Fixed all IR path references throughout LLD.

**HIGH findings (resolved):**

1. F-03: Resolution handler query missing `projectId` → Added `projectId` to filter for defense-in-depth.
2. F-04: Session pause mechanism unspecified (what prevents next message?) → Added SuspendedExecution pattern (follows await-attachment) + turn-entry check in runtime-executor.ts:executeMessage().
3. F-05: Subsumed by F-01 — session mutation removed from escalation-bridge.ts.
4. F-07: LockPort.acquire() signature wrong (positional vs options object) → Fixed to match actual interface: `acquire(key, { keyPrefix, ttlMs, retryAttempts, retryDelayMs })`.

**MEDIUM findings (addressed):**

1. F-06: Route insertion point unspecified → Added "after existing /:id/close route block".
2. F-08: Index should be compound → Changed to `{ 'source.sessionId': 1, tenantId: 1 }`.
3. F-09: Trace event types not registered in trace-event-types.ts → Added wiring checklist item to register all 8 types.
4. F-10: ITSM connector resolution vague → Specified ConnectorRegistry.get() + context_for_human payload + HumanTask update.
5. F-11: `escalation.enableItsmWebhook` config conflicts with IR-gating → Removed config toggle, added note about IR-gated activation.

**Verified OK:** Auth pattern, Zod validation, error envelope, cross-tenant 404, stateless distributed, IR-gated activation, E2E in exit criteria, rollback strategies, wiring checklist, tenant isolation plugin, guardrails pattern reuse.

### Round 2 (2026-03-25) — NEEDS_CHANGES

**Focus**: Pattern consistency — matches existing code, no reinvention
**Auditor**: lld-reviewer
**Verdict**: NEEDS_CHANGES — 0 CRITICAL, 4 HIGH, 6 MEDIUM, 1 LOW

**HIGH findings (resolved):**

1. F-12: handleEscalate() is synchronous but LLD adds async operations → Added explicit signature change to async + caller/test updates.
2. F-13: SuspensionStore has no `findBySessionId(id, type)` method → Fixed to `findBySession(sessionId)` then filter by continuation type.
3. F-14: ConnectorRegistry.get() returns metadata, not executor → Fixed to use `createConnectorToolExecutorAdapter()` pattern (same as ToolBindingExecutor for connectors).
4. F-15: E2E tests should use `startRuntimeApiHarness()` not `startRuntimeServerHarness()` → Changed all 7 test task references with explicit route mounting pattern.

**MEDIUM findings (addressed):**

1. F-16: AbortController redundant with tool timeout → Clarified: overall hook timeout guards sequence, tool executor handles per-tool timeout.
2. F-17: Voice resolver needs agentIR access path specified → Added `runtimeSession.agentIR` source, merge priority, and `_effectiveConfig` availability caveat.
3. F-18: turnCount not verified to increment per turn → Added verification + increment in task 4.1.
4. F-19: New escalation/ directory needs barrel export → Added to wiring checklist.
5. F-20: compileToResolvedAgent import path unspecified → Added exact import statement to test task 2.6.
6. F-21: ON_ERROR DSL compiler verification missing from Phase 1 → Added unit test to Phase 1 exit criteria.

**LOW finding (addressed):** F-22: llm-wiring.ts line reference corrected to actual wiring lines.

**Verified OK from round 1:** All round 1 fixes confirmed correct (IR paths, LockPort signature, resolution query projectId, SuspendedExecution pattern).

### Round 3 (2026-03-25) — NEEDS_CHANGES

**Focus**: Completeness — every FR covered, file paths verified, signatures checked
**Auditor**: lld-reviewer
**Verdict**: NEEDS_CHANGES — 1 CRITICAL, 5 HIGH, 5 MEDIUM, 1 LOW

**CRITICAL finding (resolved):**

1. F-23: `SuspendedContinuation` and `SuspensionReason` in `packages/execution` have no 'escalation' variant → Added task 1.13 to add 'escalation' variants to both types. Without this, Phase 2 suspension save won't compile.

**HIGH findings (resolved):**

1. F-24/F-25/F-30: Open questions 1-2 left implementation ambiguous → Converted to definitive tasks: 1.8 (ExecutionConfigAST voice), 1.9 (parser verification), 1.10 (HookAction critical in AST), 1.11 (action_handlers in AST + IR).
2. F-26: `critical?` missing from AST HookAction → Added to task 1.10 with compiler mapping.
3. F-27: Trace event types not registered per phase → Added registration sub-tasks (2.5b, 3.5b, 4.4b, 5.2b) for `TRACE_TO_PLATFORM_TYPE` map.
4. F-28: Compound index description inconsistent → Fixed all references to `{ 'source.sessionId': 1, tenantId: 1 }`.

**MEDIUM findings (noted):** Additional specificity improvements, all addressed inline.

**Verified OK:** All 9 FRs have tasks + E2E criteria, file paths exist, function signatures match, line numbers correct, phase ordering valid, wiring checklist comprehensive.

### Round 4 (2026-03-25) — NEEDS_REVISION

**Focus**: Cross-phase consistency — LLD implements HLD, covers test spec scenarios
**Auditor**: phase-auditor
**Verdict**: NEEDS_REVISION — 0 CRITICAL, 3 HIGH, 4 MEDIUM

**HIGH findings (resolved):**

1. XP-2: Integration test tasks entirely absent from LLD phases → Added 7 integration test files to New Files table and integration test tasks to Phases 2-5 covering all 12 INT scenarios.
2. XP-1: E2E-15 (permission 403) and E2E-16 (cross-user 404) not covered → Added exit criteria and test cases to Phase 2.
3. XP-4: Permission string contradiction (test spec `escalation:resolve` vs LLD `session:execute`) → Documented as cross-document correction for /post-impl-sync.

**MEDIUM findings (addressed):**

1. Trace event name divergence → Documented in Cross-Document Corrections section.
2. HLD deviation on escalation-bridge.ts vs routing-executor.ts → Added "HLD Deviations" subsection with 3 documented deviations.
3. Index deviation documented in HLD Deviations section.
4. Feature spec ITSM config toggle → Added to Cross-Document Corrections.

**Verified OK:** All 9 FRs fully covered, LLD implements all HLD decisions, "production wired" criterion flows through every phase, API paths correct, no contradictions between HLD/LLD.

### Round 5 (2026-03-25) — APPROVED

**Focus**: Final sweep — task independence, wiring checklist, domain rules
**Auditor**: lld-reviewer
**Verdict**: APPROVED — 0 CRITICAL, 0 HIGH, 3 MEDIUM

**MEDIUM findings (addressed):**

1. `suspensionStore.save()` → corrected to `suspensionStore.create()` with full SuspendedExecution object fields listed.
2. `RuntimeSession.turnCount` not defined → noted in Phase 4 to add `turnCount?: number` to RuntimeSession, added `types.ts` to Files Touched.
3. `trace-event-types.ts` missing from Files Touched in Phases 2-5 → added to all 4 phases.

**Notes from auditor:**

- `resolveErrorHandler` already imported at reasoning-executor.ts:2802 — implementers should not duplicate existing wiring.
- `compileHookAction()` at compiler.ts:2342 uses inline type literal — both inline literal AND AST interface need `critical` field.
- Existing `escalation` trace type (trace-event-types.ts:11) distinct from new `escalation_triggered` — no naming collision.

All round 1-4 fixes verified intact. Document ready for implementation.

---

## Summary

| Round     | Auditor       | Verdict        | CRITICAL | HIGH   | MEDIUM | LOW   |
| --------- | ------------- | -------------- | -------- | ------ | ------ | ----- |
| 1         | lld-reviewer  | NEEDS_CHANGES  | 2        | 4      | 5      | 0     |
| 2         | lld-reviewer  | NEEDS_CHANGES  | 0        | 4      | 6      | 1     |
| 3         | lld-reviewer  | NEEDS_CHANGES  | 1        | 5      | 5      | 1     |
| 4         | phase-auditor | NEEDS_REVISION | 0        | 3      | 4      | 0     |
| 5         | lld-reviewer  | APPROVED       | 0        | 0      | 3      | 0     |
| **Total** | —             | —              | **3**    | **16** | **23** | **2** |

All 3 CRITICAL and 16 HIGH findings resolved. 23 MEDIUM addressed. 2 LOW addressed. LLD approved for implementation.

---

## Files Created/Updated

- `docs/plans/2026-03-25-abl-spec-impl-parity-impl-plan.md` — LLD + implementation plan
- `docs/sdlc-logs/abl-spec-impl-parity/lld.log.md` — This file

---

## Next Phase

Run `/implement abl-spec-impl-parity` to begin phased implementation.

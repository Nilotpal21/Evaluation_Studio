# HLD Phase Log — Guardrails Sensitive Data Block

**Date**: 2026-05-15
**Branch**: `discuss/guardrails-pii-consolidation`
**Owner**: Girish (PM)
**Phase**: 3 (HLD)
**Inputs**:

- Feature spec at `docs/features/sub-features/guardrails-sensitive-data-block.md` (45 FRs)
- Test spec at `docs/testing/sub-features/guardrails-sensitive-data-block.md` (77+ scenarios)
- Clarifying questions log at `docs/sdlc-logs/guardrails-sensitive-data-block/clarifying-questions.md` (12 prior decisions + Q-HLD-A1)
- Phase-1 SDLC log + Phase-2 SDLC log
- HLD playbook at `docs/sdlc/hld-playbook.md`

**Output**: Canonical HLD at `docs/specs/guardrails-sensitive-data-block.hld.md`.

---

## 1. Pre-Authoring Reconnaissance

### Explorer pass — architecture map of existing guardrails subsystem

Spawned a dedicated explorer agent (Phase 0 reconnaissance) to map the existing guardrails architecture before HLD authoring. Output covered:

- **A. Runtime guardrails services** — 9 service files mapped with 1-line responsibilities; complete route table for `guardrail-policies.ts` (6 routes); both mount points verified (`/api/projects/:projectId/guardrail-policies` and `/api/guardrail-policies`).
- **B. Compiler pipeline** — 18 files in `packages/compiler/src/platform/guardrails/`; `pipeline.ts execute()` flow at L481-488; `PipelinePolicy` shape at L334-387; `failMode` extraction at L598.
- **C. PII recognizer registry** — 9 pack files inventoried; registry has NO `list()` / `getEntityCatalog()` API today (decision point for HLD).
- **D. Studio form architecture** — `RuleData` interface at `RuleCard.tsx` L22-34; `FORM_SUPPORTED_RULE_KEYS` set at L120-131; `passthroughRules` mechanism documented.
- **E. Trace event subsystem** — `GUARDRAIL_TRACE_EVENT_TYPES` registry has 14 event types; **no `guardrail.evaluation.block` event exists** (feature spec used a colloquial name); actual events are `guardrail_input_blocked` and `guardrail_output_blocked` with NO `ruleCategory` field today.
- **F. Settings/PII Protection screen** — `PIIProtectionTab.tsx` location confirmed; banner insertion slot identified.
- **G. Test infrastructure** — `RuntimeApiHarness`, `pii-e2e-helpers.ts`, `startMockLLM()` verified.
- **H. Permissions catalog** — **Codebase uses `guardrail:read` / `guardrail:write` only**; the `guardrail-policy:*` strings appearing in feature spec / test spec drafts are audit-log action names, NOT RBAC permissions. **Significant finding** — triggered the Q-HLD-A1 user decision.

### Oracle pass — design-decision questions

Single oracle pass with 15 design-decision questions across 4 areas (Architecture, Integration, Risk, Activation). Results:

- **14 questions resolved** via ANSWERED / INFERRED / DECIDED
- **1 question escalated** to user (Q-HLD-A1 — permission model for activate route)

#### Resolved decisions

| #               | Decision                                                                                             | Rationale                                                                                                                                      |
| --------------- | ---------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------- |
| D-1 (Q-HLD-1)   | Static entity metadata in pack files + `catalog.ts` pure-function aggregator (not registry `list()`) | Lower coupling; catalog is stable metadata, not mutable runtime state; testable pure function.                                                 |
| D-2 (Q-HLD-2)   | Post-detection entity filter inside `BuiltinPIIProvider.evaluate()`                                  | Entity granularity is provider-specific; filter needs per-entity detection results before score collapse.                                      |
| D-3 (Q-HLD-3)   | Single `findOneAndUpdate` for auto-deactivation atomicity (no transaction/lock)                      | Single-document MongoDB updates are atomic; INT-4 validates the invariant.                                                                     |
| D-4 (Q-HLD-4)   | `validateRule()` at `packages/shared/src/validation/guardrail-rule-validation.ts`                    | Confirmed per FR-8.2 + precedent file `pii-pack-names.ts`.                                                                                     |
| D-5 (Q-HLD-5)   | New file `apps/runtime/src/routes/pii-entities.ts`                                                   | `guardrail-policies.ts` is already 1488 lines; different data source / permission / cache profile; precedent `pii-patterns.ts`.                |
| D-6 (Q-HLD-6)   | Add `presetKey?: string` to existing block event data (clean cutover, no dual-emit)                  | No analytics dashboards filter by guardrail rule category today; `has_pii` references in QueryExplorerTab are Settings surface, not guardrail. |
| D-7 (Q-HLD-7)   | Add `allowedEntityTypes?: string[]` to `GuardrailEvalRequest.context`                                | Consistent with existing context bag pattern; provider-agnostic shape; 4-hop chain documented for reachability.                                |
| D-8 (Q-HLD-8)   | Studio API proxy template: `apps/studio/src/api/softphone.ts` / `runtime-agents.ts` pattern          | Simple `apiFetch` + SWR hook with `revalidateOnFocus: false`.                                                                                  |
| D-9 (Q-HLD-9)   | False-negative entity filter is the highest-risk failure mode                                        | Invisible compliance violation; policy appears active but enforcement is absent. Mitigations documented in §4 concern #6.                      |
| D-10 (Q-HLD-10) | No test fixture cleanup needed                                                                       | Grep of `apps/runtime/src/__tests__/` for `pii_protection` returned zero matches.                                                              |
| D-11 (Q-HLD-12) | No migration script needed                                                                           | All new fields optional; activation gate uses strict equality (`rule.enabled === true`); pre-launch posture.                                   |
| D-12 (Q-HLD-13) | Mount point: `apps/runtime/src/server.ts` adjacent to L1250 (`pii-patterns` mount)                   | Same domain; same permission model.                                                                                                            |
| D-13 (Q-HLD-14) | Four-hop reachability chain documented                                                               | Schema → Pipeline factory → Tier-2 evaluator → Provider. E2E-1 is the proof.                                                                   |
| D-14 (Q-HLD-15) | Three production-reachability signals                                                                | HTTP response `autoDeactivated: true`, trace event, GET on policy. Monitoring: alert if zero events in 30 days.                                |

#### Escalated to user

**Q-HLD-A1**: Permission model for activate route — keep `guardrail:write` or split `guardrail:activate`?

**User answer** (2026-05-15): _"I am open to keep it as is today i.e. `guardrail:write`, but I want to be open for extension tomorrow the way you mentioned about the maker-checker process."_

Captured in `clarifying-questions.md` Batch 3. Encoded in HLD §4 concern #4 as a "Future extension hook" with a 6-step additive runbook. Cascaded doc corrections applied:

- Feature spec §12 permission string: `guardrail-policy:update` → `guardrail:read`/`guardrail:write` (with reference to HLD §4 concern #4 for deferred split)
- Test spec INT-11: permission matrix reauthored with real strings; case 3 reframed as future test (F-1, deferred)
- Phase-1 SDLC log §1 C5: clarified that `guardrail-policy:*` are audit-log action names, not permissions

---

## 2. Files Created / Modified

| Path                                                                     | Action | Purpose                                                               |
| ------------------------------------------------------------------------ | ------ | --------------------------------------------------------------------- |
| `docs/specs/guardrails-sensitive-data-block.hld.md`                      | CREATE | Canonical HLD — 10 sections, 12 architectural concerns addressed      |
| `docs/sdlc-logs/guardrails-sensitive-data-block/hld.log.md`              | CREATE | This file                                                             |
| `docs/sdlc-logs/guardrails-sensitive-data-block/clarifying-questions.md` | EXTEND | Add Batch 3 (Q-HLD-A1 user decision) + summary table entry            |
| `docs/features/sub-features/guardrails-sensitive-data-block.md`          | MODIFY | §12 permission string correction                                      |
| `docs/testing/sub-features/guardrails-sensitive-data-block.md`           | MODIFY | INT-11 permission matrix corrected to real strings + future-test note |
| `docs/sdlc-logs/guardrails-sensitive-data-block/feature-spec.log.md`     | MODIFY | §1 C5 permission decision corrected with clarifying note              |

---

## 3. Review Findings

### Round 1 (Full Audit) — verdict: NEEDS_REVISION (3 HIGH + 5 MEDIUM + 2 LOW; all applied)

| Finding                                                                                                                                                                                                      | Severity | Gate           | Fix Applied                                                                                                                                                                                     |
| ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | -------- | -------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| F-1: Trace event names use dot-notation (`guardrail.activation.blocked`, `guardrail.auto_deactivation`) but the existing `GUARDRAIL_TRACE_EVENT_TYPES` registry uses underscore convention for all 18 events | HIGH     | G4 Concern #8  | Replaced throughout HLD; cascaded to feature spec FR-7.5 + §12 + §13 Delivery Plan + §14 Success Metrics + §C.3 Threat model; cascaded to test spec coverage matrix + INT-7 + E2E-2/4/14        |
| F-2: Metrics section uses phantom event `guardrail.evaluation.block` (doesn't exist)                                                                                                                         | HIGH     | G5/G4          | Replaced with `guardrail_input_blocked + guardrail_output_blocked` filtered by `presetKey: 'sensitive_data_block'`. Cascaded to feature spec §12 + §14 + §C.3, test spec E2E-1 + E2E-14 + INT-6 |
| F-3: Catalog endpoint error spec mixes 403 (permission) with 404 (cross-project) without clarifying middleware ordering                                                                                      | HIGH     | G4 Concern #3  | Added explicit middleware-ordering note: 403 only when user IS member of project but lacks `pii-pattern:read`; cross-project returns 404 per Core Invariant 1                                   |
| F-4: Test count clarification                                                                                                                                                                                | MEDIUM   | G4 Concern #12 | Verified correct; no change to HLD; flagged for post-impl-sync to update feature spec §17 test file table                                                                                       |
| F-5: `IGuardrailRule` L35-50 reference                                                                                                                                                                       | MEDIUM   | G5             | Verified accurate; no change                                                                                                                                                                    |
| F-6: `normalizeRules()` L538-543 reference                                                                                                                                                                   | MEDIUM   | G5             | Verified accurate; no change                                                                                                                                                                    |
| F-7: HLD should flag feature spec's phantom `guardrail.evaluation.block` for cross-phase correction                                                                                                          | MEDIUM   | G6             | Added Cross-phase corrections subsection to §9; also cascaded the actual corrections in this same round                                                                                         |
| F-8: Mongoose `enabled` default behavior not explicit in §4 Concern #10                                                                                                                                      | MEDIUM   | G4             | Added explicit `enabled` Mongoose default `false` clarification with activation-gate strict-equality note                                                                                       |
| F-9: `packages/shared` location verification                                                                                                                                                                 | LOW      | G4/XP-5        | Verified consistent; no change                                                                                                                                                                  |
| F-10: Alternative B rejection rationale wording                                                                                                                                                              | LOW      | G2             | Tightened to focus on "zero immediate value" rationale rather than "delays this CR"                                                                                                             |

**Cascaded corrections applied to upstream specs in same round** (per F-1, F-2, F-7):

- Feature spec FR-7.5: trace event names → underscore convention
- Feature spec §12 Observability event inventory: 3 events → 2 NEW + 2 EXTENDED (with explanatory note about the conflation history)
- Feature spec §13 Delivery Plan step 3.4: event names corrected
- Feature spec §14 Success Metrics: block-event rate uses real event names with presetKey filter
- Feature spec §C.3 Threat #7 (telemetry leak): real event names
- Test spec coverage matrix FR-7.5 row: event names corrected
- Test spec E2E-1, E2E-2, E2E-4, E2E-14: event names corrected with line refs to reasoning-executor.ts
- Test spec INT-7: event names corrected

### Round 2 (Deep Dive) — verdict: PASS (1 HIGH + 3 MEDIUM + 2 LOW; all applied)

All 7 deep-dive gates (D1 data model, D2 API design, D3 error model, D4 failure modes, D5 performance, D6 wiring/reachability, D7 R1 regression check) passed cleanly. The single HIGH and 5 polish items were applied.

| Finding                                                                                                                                                                                                                                                                                      | Severity | Gate | Fix Applied                                                                                                                                                                                                        |
| -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | -------- | ---- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| F-1 (R2): §3.3 step 5 and §3.6 hop 2 misattributed the IR mapping function to `pipeline-factory.ts` — actual location is `toSyntheticGuardrail()` at `apps/runtime/src/services/guardrails/policy-resolver.ts` L126-152. Intermediate `PolicyRule` type at L11-27 also needs the new fields. | HIGH     | D6   | Rewrote both hop descriptions with correct file/function/line refs + acknowledged `PolicyRule` intermediate type extension                                                                                         |
| F-2 (R2): "18 events at L160-189" — actual count is 20 events at L167-188                                                                                                                                                                                                                    | MEDIUM   | D7   | Corrected both occurrences (§4 Concern #8 + §9 cross-phase corrections)                                                                                                                                            |
| F-3 (R2): 4 residual stale `guardrail-policy:*` permission strings in test spec at L97 (auth context default), L170 (E2E-2 auth), L343 (E2E-11 preconditions), L916 (§7 security bullet)                                                                                                     | MEDIUM   | XP-4 | All 4 corrected to use real `guardrail:read` / `guardrail:write` / `pii-pattern:read` strings + future-extension note                                                                                              |
| F-4 (R2): `entities[]` array bounds (≤50, ≤64 chars per ID) stated but no enforcement location assigned                                                                                                                                                                                      | MEDIUM   | D1   | Assigned to `validateRule()` in `packages/shared/src/validation/guardrail-rule-validation.ts` (already covers `entities.length > 0`; extend for ≤50 + per-ID ≤64)                                                  |
| F-5 (R2): `UNAUTHORIZED` error code referenced in catalog endpoint section but not in §4 Concern #3 enumeration                                                                                                                                                                              | LOW      | D3   | Reorganized the universal error envelope's code list into "route-specific" + "platform/middleware-inherited" groups; UNAUTHORIZED now listed alongside TENANT_ACCESS_DENIED + NOT_FOUND + INSUFFICIENT_PERMISSIONS |
| F-6 (R2): 30-day-zero auto-deactivation alert is ambiguous (could mean broken code OR benign user behavior)                                                                                                                                                                                  | LOW      | D6   | Added caveat acknowledging the ambiguity + noted deferral to post-launch operational readiness                                                                                                                     |

### Round 3 (Cross-Phase Consistency) — verdict: **PASS** (0 CRITICAL + 0 HIGH + 1 MEDIUM + 1 LOW; all applied)

All 7 cross-phase gates (X1 FR coverage, X2 test-strategy alignment, X3 no contradictions, X4 critical-feature gate reflection, X5 wireframe consistency, X6 handoff readiness, X7 R1+R2 regression) passed cleanly. Two residual fixes applied:

| Finding                                                                                                                                                                  | Severity | Gate | Fix Applied                                                                                                                                   |
| ------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | -------- | ---- | --------------------------------------------------------------------------------------------------------------------------------------------- |
| M-1 (R3): §5 "Modified IR type: Guardrail" still attributed entity propagation to `pipeline-factory.ts` — R2 fix corrected §3.3 and §3.6 but missed this third reference | MEDIUM   | X7   | Updated §5 to reference `toSyntheticGuardrail()` in `policy-resolver.ts` L126-152; clarified `pipeline-factory.ts` only loads + delegates     |
| L-1 (R3): System-context diagram box at L98 lists `pipeline-factory` without delegation clarifier                                                                        | LOW      | X7   | Added `(loads+delegates)` clarifier next to `pipeline-factory` and `(toSynthGuardrail — IR mapping)` next to `policy-resolver` in the diagram |

### 3-Round HLD Audit Journey Summary

| Round | Focus                   | Findings                                                                         | Verdict                      |
| ----- | ----------------------- | -------------------------------------------------------------------------------- | ---------------------------- |
| R1    | Full Audit              | 3 HIGH (dot-notation events, phantom event, 403/404 ordering) + 5 MEDIUM + 2 LOW | NEEDS_REVISION → 10/10 fixed |
| R2    | Deep Dive               | 1 HIGH (policy-resolver misattribution) + 3 MEDIUM + 2 LOW                       | PASS (after 6/6 fixed)       |
| R3    | Cross-Phase Consistency | 0 HIGH + 1 MEDIUM (R2 cascade residual) + 1 LOW                                  | **PASS** (after 2/2 fixed)   |

Progressive convergence: **10 → 6 → 2 findings**. All CRITICALs and HIGHs resolved across the journey.

---

## 4. Phase Handoff Packet

### What's in scope

Full HLD as documented in `docs/specs/guardrails-sensitive-data-block.hld.md` (10 sections, all 12 architectural concerns addressed). Per HLD §13 references, the full v1 delivery spans ~10 dev-days, no phasing.

### Inputs to next phase (LLD)

- Canonical HLD at `docs/specs/guardrails-sensitive-data-block.hld.md`
- This phase log
- Feature spec at `docs/features/sub-features/guardrails-sensitive-data-block.md` (with R1+R2 cascaded corrections)
- Test spec at `docs/testing/sub-features/guardrails-sensitive-data-block.md` (with R1+R2 cascaded corrections)
- 13 user decisions log at `docs/sdlc-logs/guardrails-sensitive-data-block/clarifying-questions.md`
- Phase-1 SDLC log + Phase-2 SDLC log
- ADR at `docs/architecture/2026-05-14-guardrails-pii-separation-adr.md`
- 12-screen wireframes at `docs/features/sub-features/guardrails-sensitive-data-block.wireframes.html`

### Risks to surface for LLD

- **R-1 (HIGHEST, from oracle D-9)**: False-negative entity filter is the worst-case failure mode. Silent compliance violation. Mitigations: strict `Array.includes` / `Set.has` for entity ID matching, no `==` / `startsWith`. Test INT-2's 8-case matrix is the primary safety net.
- **R-2**: Auto-deactivation transactional correctness. Single-doc atomic update is the design; INT-4's `Promise.all` race-condition test is the proof.
- **R-3**: `failMode: 'open'` schema default flip. Pre-launch posture means no migration, but the LLD must verify no existing test fixtures rely on the old `'closed'` default.
- **R-4**: 4-hop reachability chain for entity-filter (Schema → policy-resolver → tier2-evaluator → BuiltinPIIProvider). All 4 hops must land. E2E-1 step 4 is the production reachability proof.
- **R-5**: Trace-event field-propagation. Adding `presetKey?: string` to `guardrail_input_blocked` / `guardrail_output_blocked` event data is a cross-boundary field change. `field-propagation-lint` will flag — expected behavior.

### Open questions for LLD phase (5 LLD-scoped + 3 external)

**LLD-scoped** (HLD §9):

1. HTTP status code for guardrail block response (likely 200 with `blocked:true` per existing `reasoning-executor.ts` L1925-1928 pattern)
2. Faulty-recognizer fixture mechanism (no `vi.mock` of platform components)
3. Trace store query API for test assertions (test-only `GET /api/__test__/trace-events` vs DI emitter subscription)
4. Auto-deactivation Undo HTTP shape (sugar route vs PUT+activate sequence)
5. Tenant-scoped route path verification (E2E-9 — `/api/guardrail-policies` mount accepts `scope: { type: 'tenant' }`)

**External dependencies** (also in HLD §9): 6. Compliance sign-off on `failMode: 'open'` voice default (HIPAA / 911-adjacent) — blocks code commit on FR-6.7 7. Compliance audit-logging for block events (GAP-002) — beyond trace events; post-v1 8. Future third-party PII provider UI (Microsoft Presidio, AWS Comprehend Medical)

### Code locations identified (LLD inputs)

- `apps/runtime/src/routes/guardrail-policies.ts` L96-106 (`requireRouteScopePermission`), L515-563 (`normalizeRules`), L1132 (PUT), L1339 (POST activate), L1352 (future `guardrail:activate` flip point)
- `apps/runtime/src/services/guardrails/policy-resolver.ts` L11-27 (`PolicyRule` — needs new fields), L126-152 (`toSyntheticGuardrail()` — IR mapping site for `entities`)
- `apps/runtime/src/services/execution/reasoning-executor.ts` L1904 (`guardrail_input_blocked` emission), L3485 (`guardrail_output_blocked`)
- `apps/runtime/src/server.ts` L1248-1250 (mount points; new `pii-entities` mount goes here)
- `packages/database/src/models/guardrail-policy.model.ts` L35-50 (`IGuardrailRule`), L150-154 (`kind` enum — UNCHANGED), L194 (`failMode` default — FLIP from `'closed'` to `'open'`), L270-282 (indexes — UNCHANGED)
- `packages/compiler/src/platform/guardrails/pipeline.ts` L598 (failMode read)
- `packages/compiler/src/platform/guardrails/providers/builtin-pii.ts` L23-42 (`BuiltinPIIProvider.evaluate()` — entity filter insertion point)
- `packages/compiler/src/platform/guardrails/tier2-evaluator.ts` L172-179 (request construction — `allowedEntityTypes` insertion)
- `packages/compiler/src/platform/ir/schema.ts` L1603-1637 (`Guardrail` interface — gains `entities?: string[]`)
- `packages/compiler/src/platform/security/recognizer-packs/` (8 packs — each gains `ENTITIES` export; new `catalog.ts` aggregator)
- `packages/shared/src/validation/pii-pack-names.ts` (precedent for new `guardrail-rule-validation.ts`)
- `packages/shared-auth/src/rbac/role-permissions.ts` (PERMISSION_REGISTRY — NO change in v1; deferred `guardrail:activate`)
- `packages/shared-kernel/src/constants/trace-event-registry.ts` L167-188 (GUARDRAIL_TRACE_EVENT_TYPES — adds `guardrail_activation_blocked` + `guardrail_auto_deactivation`)

### Test IDs identified

- 14 executable E2E + 1 cross-ref (E2E-1 through E2E-15; E2E-13 = INT-4 cross-ref)
- 11 integration (INT-1 through INT-11; INT-11 = RBAC matrix in extended `policy-rbac.integration.test.ts`)
- ~34 unit cases for `validateRule()` (5 `test.each` groups)
- 10 component scenarios (CT-1, CT-1b, CT-2 through CT-9)
- 1 Studio Playwright comprehensive (E2E-10)
- 4 cleanup-script tests (CL-1 through CL-4)
- **Total**: 77+ scenarios across **25 test files**

### Quality gates passed

- Feature Spec phase: Round 1–5 PASS (5 rounds; CLAUDE.md minimum 5 for feature spec)
- Test Spec phase: Round 1–2 PASS (2 rounds; CLAUDE.md minimum 2 for test spec)
- HLD phase: Round 1–3 PASS (3 rounds; CLAUDE.md minimum 3 for HLD)
- All 9 §C.3 threats have ≥1 automated test scenario
- All 5 §C.2 fail-closed contract rows have coverage
- All 45 FRs traceable to HLD design + test scenarios
- All 13 user decisions encoded in artifacts

### Status

**READY FOR LLD PHASE (Phase 4)**.

Per CLAUDE.md SDLC pipeline, LLD requires **8 audit rounds** (highest-risk gate). Compaction recommended after this packet is committed; resume in a fresh context window for LLD.

---

## 6. Package Learnings (deferred to implementation)

Per CLAUDE.md SDLC workflow, package `agents.md` updates are deferred to post-implementation. Packages that will receive learnings:

- `apps/runtime/agents.md` — `policy-resolver.ts` IR mapping site; new entity-filter pattern in `BuiltinPIIProvider`; `pii-entities` route convention
- `apps/studio/agents.md` — new SDB component patterns (EntityMultiselect, DecisionMatrixModal, FailModeSelector); WCAG APG dialog test precedent; 90-day-TTL banner pattern
- `packages/shared/agents.md` — `validateRule()` per-checkType validation pattern
- `packages/database/agents.md` — additive schema field pattern (`entities?`, `enabled?`, `presetKey?`, `actionMessage?`); `failMode` default flip
- `packages/compiler/agents.md` — `getEntityCatalog()` aggregator pattern; provider-level entity filter insertion

---

## 7. Cross-Cutting Insights (for `docs/sdlc-logs/agents.md`)

- **Phase 0 explorer-agent reconnaissance is force-multiplying.** The HLD phase invested ~30 min in an explorer pass to map the existing guardrails architecture. The pass discovered three significant phantoms (`guardrail.evaluation.block` event, `guardrail-policy:*` permissions, IR mapping function location) that would have surfaced as LLD-phase rework otherwise. Future HLDs should always front-load this exploration.
- **Auditors catch their own work.** R3 caught a residual `pipeline-factory.ts` reference in §5 that R2's fix missed in §3.3 + §3.6. Cross-phase audit rounds correctly verify that fixes propagate completely, not just where the initial finding pointed.
- **Cross-phase cascade is unavoidable for SDLC artifacts.** When R1 corrects a name or convention in the HLD, the cascade to feature spec + test spec needs to happen in the same commit batch, otherwise the artifacts drift. R1 cascaded trace event names + phantom permissions; R2 cascaded 4 residual permission strings; R3 caught 1 missed cross-reference.
- **User decision deferral is healthy.** Q-HLD-A1 (`guardrail:activate` permission split) was explicitly deferred to maker-checker introduction with a 6-step runbook. This is preferable to over-engineering pre-launch. The runbook makes the deferred work cheap to land when needed.
- **Audit verdict progression is a quality signal.** R1: 10 findings → R2: 6 findings → R3: 2 findings. Each round caught fewer + lower-severity issues. This convergence pattern matches the "ralph-loop" expectation in CLAUDE.md and validates the 3-round HLD minimum.

---

## 5. State Summary for /compact (resume point)

**Phase status**: HLD Round 1 PASS (after fixes) → Round 2 PASS (after fixes) → **Round 3 PAUSED for /compact**. Round 3 is the final cross-phase consistency check; on PASS the HLD phase completes and the pipeline advances to LLD (Phase 4 — 8 audit rounds, highest-risk gate).

**Working tree state (no commits yet — per user direction)**:

- `docs/specs/guardrails-sensitive-data-block.hld.md` — canonical HLD, 10 sections, 12 architectural concerns addressed, R1+R2 PASS
- `docs/features/sub-features/guardrails-sensitive-data-block.md` — Phase 1 artifact + R1/R2 cascade fixes (event names + permissions)
- `docs/testing/sub-features/guardrails-sensitive-data-block.md` — Phase 2 artifact + R1/R2 cascade fixes
- `docs/sdlc-logs/guardrails-sensitive-data-block/clarifying-questions.md` — 13 user decisions logged (12 Phase 1+2, 1 HLD Batch 3 = Q-HLD-A1 permission bundling)
- `docs/sdlc-logs/guardrails-sensitive-data-block/feature-spec.log.md` — Phase 1 log (5 audit rounds PASS)
- `docs/sdlc-logs/guardrails-sensitive-data-block/test-spec.log.md` — Phase 2 log (2 audit rounds PASS)
- `docs/sdlc-logs/guardrails-sensitive-data-block/hld.log.md` — this file (Round 1+2 PASS, Round 3 pending)
- `docs/architecture/2026-05-14-guardrails-pii-separation-adr.md` — pre-Phase-1 ADR
- `docs/features/sub-features/guardrails-sensitive-data-block.prd.md` — superseded PRD
- `docs/features/sub-features/guardrails-sensitive-data-block.wireframes.html` — 12-screen wireframes

**Decisions ratified by user**:

1. Q-HLD-A1 (2026-05-15): Keep `guardrail:write` bundled today; HLD §4 concern #4 documents the additive 6-step runbook for splitting to `guardrail:activate` when maker-checker workflow lands.

**Open HLD Open Questions (deferred to LLD)**:

1. HTTP status code for guardrail block response (likely 200 with `blocked:true` body per existing `reasoning-executor.ts` pattern)
2. Faulty-recognizer fixture mechanism (no `vi.mock` of platform components)
3. Trace store query API for test assertions
4. Auto-deactivation Undo HTTP shape (sugar route vs PUT+activate sequence)
5. Tenant-scoped route path verification (E2E-9)
6. Compliance sign-off on `failMode: 'open'` voice default (§15 of feature spec / GAP-002)
7. Future third-party PII provider UI

**Resume after /compact**:

1. Run Round 3 (Cross-Phase Consistency) audit via `phase-auditor` agent
2. Apply Round 3 findings if any
3. Fill the Phase Handoff Packet (this file §4)
4. Advance to Phase 4 (LLD) or stop per user preference

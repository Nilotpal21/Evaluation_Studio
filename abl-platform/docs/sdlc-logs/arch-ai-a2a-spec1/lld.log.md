# SDLC Log: arch-ai A2A Spec 1 — LLD

- **Phase:** LLD (Phase 4 of SDLC pipeline)
- **Date:** 2026-05-05
- **Tracking:** ABLP-162
- **Design doc:** `docs/superpowers/specs/2026-05-05-arch-ai-a2a-spec1-design.md`
- **LLD doc:** `docs/plans/2026-05-05-arch-ai-a2a-spec1-impl-plan.md`

## Note on prerequisite docs

This feature took the brainstorm route, producing one combined design doc rather than separate feature-spec / HLD / test-spec. The design doc covers all three concerns (motivation/goals, architecture/components, testing strategy) and serves as input to this LLD.

## Product Oracle — 15 questions answered, 0 escalations

### Section A: Implementation Strategy

| #   | Question               | Classification | Decision                                                                                                                                                 |
| --- | ---------------------- | -------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------- |
| A1  | Phase decomposition    | DECIDED        | 5 phases (D-2): permissions+types → backend auth-aware test → executor+UI → adaptiveness → indicators+prompts+docs                                       |
| A2  | Feature flag           | DECIDED        | No flag (D-3); RBAC + intent-pattern gating + additive-only changes substitute                                                                           |
| A3  | TDD vs test-after      | DECIDED        | Test-after with pure-function unit tests written first per phase (D-4)                                                                                   |
| A4  | Hard deadlines         | ANSWERED       | None; v5 spine non-blocking (doc-only amendment)                                                                                                         |
| A5  | Scope cut if pressured | DECIDED        | `integration-methodologist.ts` prompt edit is most disposable (design §5.10 explicitly defers); next: Studio `construct-catalog.ts` (throwaway after v5) |

### Section B: Technical Details

| #   | Question                             | Classification | Decision                                                                                                                                                                                       |
| --- | ------------------------------------ | -------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| B1  | `validateUrl` import                 | ANSWERED       | Actual symbol is `validateUrlForSSRF`; also `assertUrlSafeForSSRF`, `getDevSSRFOptions`. Path `@agent-platform/shared-kernel/security`. **Design path was wrong**                              |
| B2  | `consumeFlowSecrets` path            | ANSWERED       | `apps/studio/src/lib/arch-ai/tools/secret-store.ts`. Mirror `mcp-server-ops.ts:3` import. **Design path was wrong** (said `arch-ai/secret-store.ts`)                                           |
| B3  | `useArchUIStore.currentSpecialist`   | ANSWERED       | Exists at `apps/studio/src/lib/arch-ai/ui/store.ts:23-29, 93-126`. Shape: `{name, icon} \| null`                                                                                               |
| B4  | `emitCard` mechanism                 | ANSWERED       | Callback param to `buildInProjectTools` (line 1085); flows through SSE `artifact_updated` event; dispatcher case at `event-dispatcher.ts:1502-1515`; rendered via `kbCards[]` on `ChatMessage` |
| B5  | `cards/generated/` authoring         | ANSWERED       | Auto-generated from MDX (`pnpm abl:docs:generate`). **D-1**: extend MDX source rather than hand-author                                                                                         |
| B6  | `createA2AClientWithAuth` shape      | ANSWERED       | Exported from `@agent-platform/a2a` barrel. `OutboundAuthConfig {type: 'bearer'\|'api_key', value, header?}` confirmed                                                                         |
| B7  | `discover_preview` AgentCard parsing | INFERRED       | **D-11**: validate JSON response with inline Zod subset schema; do NOT import `@a2a-js/sdk` AgentCard. Treat as untrusted input                                                                |
| B8  | `routing_decision` event mechanism   | INFERRED       | **D-6**: `JournalEntry { type: 'decision', kind: 'routing_decision' }` via existing `journal/journal-service.ts` writer (verify reachable from content-router during implementation)           |
| B9  | `ChatStatusMessage` component        | ANSWERED       | `ChatStatusMessages` (plural) exists. **D-10**: add `appendStatusMessage` action + `statusMessages: StatusMessage[]` list to `useArchUIStore` (currently single-slot)                          |
| B10 | `SpecialistChip` existence           | ANSWERED       | Doesn't exist. **D-9**: extract `ICON_MAP` + `ROLE_STYLES` from `SpecialistBadge.tsx` into shared style module; build `SpecialistChip` as compact variant                                      |

### Section C: Risk & Dependencies

| #   | Question            | Classification | Decision                                                                                                                                                                                 |
| --- | ------------------- | -------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| C1  | WIP file conflicts  | ANSWERED       | Original gitStatus snapshot stale. Current uncommitted: only MCP provider tests (unrelated). 14 ABLP-162 commits ahead of `develop` already include the files prompt called out as "WIP" |
| C2  | Branch parent       | ANSWERED       | `zarch/newtools` from `develop` at `24e2355728`. **D-7**: design's `zarch/improvements` reference is stale — LLD targets `develop` from `zarch/newtools`                                 |
| C3  | v5 blocking         | ANSWERED       | Not blocking (doc-only amendment); v5 in design state                                                                                                                                    |
| C4  | Auth-aware rollback | ANSWERED       | Hotfix-able. **D-8**: add `EXTERNAL_AGENT_TEST_AUTH` env-var override at runtime route as belt-and-suspenders                                                                            |
| C5  | Definition of done  | DECIDED        | **D-5**: Gate 1 (`pnpm build && pnpm test`) + Gate 2 (5 E2E + auth round-trip) + Gate 3 (manual PM2 chat acceptance with logs/screenshots in this folder)                                |

## Decisions (D-1 through D-11)

All decisions feed directly into the LLD's Section 1 Decision Log.

## Stale-info corrections (carried into LLD)

- Branch is `zarch/newtools`, not `zarch/improvements` (per design doc line 5)
- `validateUrl` is `validateUrlForSSRF`
- `consumeFlowSecrets` is at `tools/secret-store.ts`
- `appendStatusMessage` does NOT exist; needs adding
- `SpecialistChip` does NOT exist; needs creating
- L2 cards are MDX-generated, not hand-authored

## Audit log

Audits 1-8 to be appended below as they run.

### Round 1: lld-reviewer (architecture compliance)

**Verdict:** NEEDS_REVISION → fixes applied → ready for R2
**Findings:** 2 CRITICAL, 3 HIGH, 7 MEDIUM, 4 LOW
**Memory file:** `.claude/agent-memory-local/lld-reviewer/arch-ai-a2a-spec1-r1-review.md`

**CRITICAL fixes applied:**

| #   | Finding                                                                                                                                                                          | Resolution                                                                                                                                                                                 |
| --- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| C-1 | `routing_decision` as JournalEntry architecturally broken — content-router has no session/tenant context, JournalContent is closed 5-kind union, raw input would leak cross-user | D-6 revised: emit as TurnTraceRecorder span event (`engine/trace-recorder.ts`); drop `userInputSnippet` to avoid PII leak; remove Phase 1 task 1.7 (no JournalEntry type extension needed) |
| C-2 | `testExternalAgentConnection` 5th-arg shape — `encryptedAuthConfig` stores `{value, header?}` only (no `type`); type comes from `config.authType` separate field                 | Phase 2 task 2.2 expanded: route composes `{type: config.authType, value: parsed.value, header: parsed.header}` from two model fields                                                      |

**HIGH fixes applied:**

| #   | Finding                                                                                                  | Resolution                                                                                                                                                         |
| --- | -------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| H-1 | `external_agent_card` would be silently dropped by `isKbCardMessage` type guard                          | Task 3.9 expanded: extend `isKbCardMessage` to accept new variant; task 3.10 confirms generic `kbCards: Array<{type: string; ...}>` shape OK                       |
| H-2 | Dual `ToolName` types in arch-ai — `types/tools.ts` union vs `tools/adapters/classification.ts` keyof    | Phase 1 task 1.8: add inline comment in `tools.ts` requiring every union entry have a kind in `classification.ts`; existing tasks already keep both aligned        |
| H-3 | `EXTERNAL_AGENT_TEST_AUTH` documentation incomplete — no env.example entry, no log.warn on rollback path | Phase 2 task 2.2 expanded: emit `log.warn` when env-var is `'false'`; document in `apps/runtime/.env.example`; moved from §5.3 follow-up to Phase 2 exit criterion |

**MEDIUM fixes applied (key ones):**

| #   | Finding                                                               | Resolution                                                                                                                                                                           |
| --- | --------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| M-1 | Auth-aware test may flip pre-existing agents to `'failed'`            | §5.2 added migration consideration; operators communicated; optional one-time non-failing audit out of scope                                                                         |
| M-2 | MDX-to-card generator path for NEW filename unverified                | Phase 4 task 4.4 expanded: pre-flight read of `tools/abl-docs/generate.ts` to confirm new-card emission rule; fallback to hand-authored card with TODO if generator only regenerates |
| M-5 | `discover_preview` no payload-size cap                                | Phase 3 task 3.2: add 256KB cap on fetch response body                                                                                                                               |
| M-6 | Per-phase commit-scope guard arithmetic not explicit                  | Open Q #7 added with exact per-phase file/package counts                                                                                                                             |
| M-7 | `validateUrlForSSRF` prod behavior with `getDevSSRFOptions()` unclear | Phase 3 task 3.2: confirm prod-safe options when `NODE_ENV=production`                                                                                                               |

**MEDIUM/LOW deferred to R2:**

- M-3 `crypto.randomUUID()` vs `cryptoRandomId()` consistency
- M-4 Permission convention asymmetry (external*agent:* vs mcp*server:tool:*)
- LOW-1 Zod regex in tool description for LLM
- LOW-2 No metric `external_agent_test_connection_total`
- LOW-3 Gate 3 fixture verification
- LOW-4 v5 amendment outside package-scope arithmetic note

### Round 2: lld-reviewer (pattern consistency)

**Verdict:** NEEDS_REVISION → fixes applied → ready for R3
**Findings:** 5 CRITICAL, 4 HIGH, 7 MEDIUM, 4 LOW
**Memory file:** `.claude/agent-memory-local/lld-reviewer/arch-ai-a2a-spec1-r2-review.md`

**CRITICAL fixes applied:**

| #   | Finding                                                                                                                                 | Resolution                                                                                                                                                                                                                |
| --- | --------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| C-1 | `card-router.ts` schema wrong — uses synchronous static imports + `CardEntry { id, content, patterns }`, NOT `load: () => import()`     | Phase 4 task 4.5 rewritten with correct schema (static import + push to CARD_REGISTRY)                                                                                                                                    |
| C-2 | Wrong file for "card emission rule" — emission is in `tools/abl-docs/card-mapping.ts:CARD_MAPPINGS`, not `generate.ts`                  | New Phase 4 task 4.4a added with explicit `CardMappingEntry` shape                                                                                                                                                        |
| C-3 | Missing `CARD_FILE_COVERAGE` entry in `_mapping.ts` for L3 dedup                                                                        | New Phase 4 task 4.4b added                                                                                                                                                                                               |
| C-4 | `routing_decision` TraceRecorder swap (R1) didn't solve architectural blocker — TraceRecorder also requires session/tenant/user context | D-6 RE-REVISED: lift emission to caller (`coordinator-bridge.ts` `resolveTurnPlan`); change `routeByContent` signature to return `RoutingDecision`; corrected method to `traceRecorder.event({spanId, name, attributes})` |
| C-5 | `ExternalAgentConfigView` is private to runtime route — Studio executor + UI card can't import                                          | New Phase 1 task 1.10 added: move type to `packages/shared/src/types/external-agent.ts` and export                                                                                                                        |

**HIGH fixes applied:**

| #   | Finding                                                                                                                                         | Resolution                                                                                                |
| --- | ----------------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------- |
| H-1 | `ICON_MAP`/`ROLE_STYLES` keyed by ICON name not specialist; SpecialistChip needs `{name, icon}` not `{specialist}`                              | Phase 5 task 5.3 + 5.4 rewritten — props mirror SpecialistBadge `{name, icon}`; ArchHeroStrip passes both |
| H-2 | ExternalAgentCard misses `'use client'`, `memo`, `clsx`, prop name `event` not `data`, type-package location, i18n strategy                     | Phase 3 task 3.8 rewritten with explicit pattern alignment                                                |
| H-3 | `update.variant` discriminator union must be extended at source-of-truth (likely `packages/arch-ai/src/types/events.ts`), not just inline guard | Phase 3 task 3.9 rewritten — 3-layer extension (source union + inline guard + dispatcher case)            |
| H-4 | Phase 5 task 5.6 dispatch-from-setState is racy — existing pattern uses two-step (compute outside, dispatch via getState() AFTER setState)      | Task 5.6 rewritten with non-racy 3-step pattern + `cryptoRandomId()` over `crypto.randomUUID()`           |

**MEDIUM fixes applied:**

| #   | Finding                                                                    | Resolution                                                                                                                            |
| --- | -------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------- |
| M-1 | D-6 DECIDED vs Open Q #1 PROVISIONAL contradiction                         | Open Q #1 marked RESOLVED; D-6 has full answer in 2nd revision                                                                        |
| M-4 | Pre-existing dual-ToolName drift — 6 tools missing from classification map | New Phase 1 task 1.9 added: backfill `variable_ops`, `integration_ops`, `agent_ops`, `deployment_ops`, `testing_ops`, `analytics_ops` |
| M-5 | D-1 invariant contradicted by hand-authored fallback in task 4.4           | Task 4.4 hand-authored fallback removed; D-1 invariant honored — emission via card-mapping is the only path                           |
| M-6 | §1.4 traceability bullet stale                                             | Updated — references TraceRecorder span event, not JournalEntry                                                                       |
| M-7 | Wiring checklist references removed task 1.7                               | Updated to point at correct emission path + new signature requirements                                                                |

**MEDIUM/LOW deferred to R3-R5:**

- M-2 line ref offsets (~30 lines) — minor, "near line X" wording acceptable
- M-3 `crypto.randomUUID()` vs `cryptoRandomId()` — addressed inline in task 5.6 fix
- M-7 (R1) `validateUrlForSSRF` prod behavior verification — implementation-time check
- LOW items — defer to R5 final sweep

**R1 fixes verified by R2:**

- ✅ R1 CRITICAL-2 (encryptedAuthConfig composition) — verified correct against runtime route line 224
- ✅ R1 HIGH-3 (EXTERNAL_AGENT_TEST_AUTH log.warn + .env.example) — verified
- ✅ R1 HIGH-1 (isKbCardMessage extension) — partial; R2 expanded to 3-layer extension
- ❌ R1 CRITICAL-1 (routing_decision JournalEntry → TraceRecorder swap) — re-broken; R2 corrected with caller-side emission

### Round 3: lld-reviewer (completeness)

**Verdict:** NEEDS_REVISION → fixes applied → ready for R4
**Findings:** 4 CRITICAL, 3 HIGH, 5 MEDIUM, 3 LOW
**Memory file:** `.claude/agent-memory-local/lld-reviewer/arch-ai-a2a-spec1-r3-review.md`

**CRITICAL fixes applied:**

| #   | Finding                                                                                                            | Resolution                                                                                                                                                                                                                |
| --- | ------------------------------------------------------------------------------------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| C-1 | `coordinator-bridge.ts` wrong path — file is at `packages/arch-ai/src/engine/coordinator-bridge.ts`, not in studio | Replace_all of path across LLD                                                                                                                                                                                            |
| C-2 | R2 `resolveTurnPlan` emission also broken — recorder constructed AFTER `resolveTurnPlan` returns, inside `runTurn` | D-6 third revision: 4-layer plumbing — routeByContent returns RoutingDecision → TurnPlan.routing → RunTurnInput.routing → engine emits at turn-start using existing `emitGateCheckTrace` pattern (turn-engine.ts:520-539) |
| C-3 | RouteRule shape mismatch — interface is `{patterns: RegExp[], specialist}` (plural), not `{pattern, specialist}`   | Phase 4 task 4.1 rewritten with two options (extend existing rule's patterns array, or new rule with patterns array); pattern.source capture clarified as inner-loop variable                                             |
| C-4 | `events.ts` doesn't exist — actual file is `sse-events.ts`                                                         | Phase 3 task 3.8 corrected with proper file path + Schema export pattern                                                                                                                                                  |

**HIGH fixes applied:**

| #   | Finding                                                                                | Resolution                                                          |
| --- | -------------------------------------------------------------------------------------- | ------------------------------------------------------------------- |
| H-1 | ArchHeroStrip has zero state subscriptions — explicit imports + atomic-selector needed | Phase 5 task 5.4 expanded with import list + selector + render code |
| H-2 | `cryptoRandomId` is local helper in event-dispatcher.ts:1100, not project-wide         | Task 5.6 wording corrected — call directly within same file         |
| H-3 | Phase 4 task 4.4a depends on 4.3 (MDX anchors must exist first)                        | Explicit dependency note + non-empty content exit criterion added   |

**MEDIUM fixes applied:**

| #   | Finding                                                              | Resolution                                                |
| --- | -------------------------------------------------------------------- | --------------------------------------------------------- |
| M-2 | `getPageContextSpecialistBias` is conditional branches not key-value | Phase 4 task 4.7 rewritten with branch-insertion guidance |
| M-3 | Open Q #2 stale post-R2 (split into 4.4a/b/c)                        | Will mark resolved in next pass                           |

**LOW fixes applied:**

| #   | Finding                                               | Resolution                  |
| --- | ----------------------------------------------------- | --------------------------- |
| L-1 | v5 amendment said §3 — actual is §4.2 around line 182 | Phase 5 task 5.13 corrected |

**Deferred to R4-R5:**

- M-1 (2 unmapped E2E scenarios from design §4.3 fallback table) — likely R4 cross-phase consistency
- M-4 (Gate 1 baseline definition) — R4 or R5
- M-5 (§1.4 traceability bullet stale post-CRITICAL-2 fix) — already addressed in earlier pass; verify R5
- L-2 (bidirectional dual-ToolName drift — kb_crawl, kb_schema not in union)
- L-3 (Phase 2 file count vs .env.example)

**R1/R2 fixes verified by R3:**

- ✅ Permission constants paths
- ✅ encryptedAuthConfig composition (runtime route line 224 confirms)
- ✅ EXTERNAL_AGENT_TEST_AUTH log.warn + .env.example
- ✅ card-router.ts schema (static import + CardEntry)
- ✅ ExternalAgentConfigView export plan
- ✅ SpecialistChip props {name, icon}
- ✅ update.variant discriminator extension at sse-events.ts:220-233
- ✅ Racy setState fix (3-step pattern)
- ✅ All 7 design goals + all 13 §5 components map to LLD tasks
- ✅ Test counts match design §8 exactly

### Round 4: phase-auditor (cross-phase consistency)

**Verdict:** NEEDS_REVISION → fixes applied → ready for R5
**Findings:** 4 CRITICAL, 4 HIGH, 6 MEDIUM, 1 LOW
**Memory file:** `.claude/agent-memory-local/phase-auditor/arch-ai-a2a-spec1-r4-review.md` (per agent convention)

**CRITICAL fixes applied:**

| #   | Finding                                                                                                                       | Resolution                                                                                                                                                                                                                 |
| --- | ----------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| C-1 | D-6 third-revision propagation incomplete — 8 stale "journal entry" / "coordinator-bridge resolveTurnPlan" references in body | Sweep: replaced "journal entry" → "trace span event"; coordinator-bridge resolveTurnPlan emission → turn-engine.ts runTurn() ~line 297; deleted journal/types.ts row from §2.2; updated §1.3, §1.4, §2.2, §3, §4, §5.4, §6 |
| C-2 | Studio call site that constructs RunTurnInput from TurnPlan never named — outside arch-ai package                             | Phase 4 task 4.2 added sub-task (c.5): locate Studio site (`process-message.ts` or `process-in-project.ts`) via grep, forward `turnPlan.routing → RunTurnInput.routing`; added wiring-checklist item                       |

**HIGH fixes applied:**

| #   | Finding                                                                    | Resolution                                                                  |
| --- | -------------------------------------------------------------------------- | --------------------------------------------------------------------------- |
| H-1 | TestExternalAgentConnectionDeps fabricated — actual is TestConnectionDeps  | §1.2 type 6 corrected                                                       |
| H-2 | INT-7 to INT-11 collides with existing INT-7 in test file                  | Renumbered to EXT-1 through EXT-5 (executor-scoped)                         |
| H-3 | "5 route files" inherited from design — only 3 exist with 6 `as any` casts | Sweep replace_all: "5 route files" → "3 route files (6 as-any casts total)" |
| H-4 | D-6 narrative vs body emission location drift                              | Resolved by C-1 sweep — single source of truth: turn-engine.ts              |

**MEDIUM fixes applied:**

| #   | Finding                                                                                                                          | Resolution                                                         |
| --- | -------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------ |
| M-1 | "Section 3" v5 amendment — actual is §4.2 around line 182                                                                        | Multi-site replace: §2.2, §4 wiring checklist, task 5.13           |
| M-6 | Phase 4 file count Open Q #7 vs §3 Phase 4 list — task 4.4a (card-mapping.ts) and 4.4b (\_mapping.ts) missing from Files Touched | Phase 4 Files Touched list expanded to 12 files; Open Q #7 updated |

**Deferred to R5:**

- M-2 (pattern-insertion placement ambiguity in task 4.1)
- M-3 (line-range cosmetic drift task 1.4)
- M-4 (auth round-trip line 362-372 verification)
- M-5 (Gate 1 test-count vs design §8 — env-gate fallback adds +1)
- LOW-1 (logger key still references content-router for routing logs)

**Cross-phase consistency check (verified strong):**

- ✅ All 7 design goals → mapped to specific Gate exit criteria
- ✅ Phase ordering — independence verified (each phase's exit criteria checkable at end-of-phase)
- ✅ Test counts match design §8 baseline
- ✅ No Spec 2/3 territory creep into Spec 1

**Pattern observation (per auditor's R5 guidance note):**

- This is the 7th audit at LLD R4 with the same R(n) fix-scope-leak pattern: when R(n) revises a decision, the fix lands in the decision row + most recently edited body sections, but misses sibling sites referencing the prior revision.
- R5 should mechanically grep the OLD revision identifiers ("journal entry", "JournalEntry", "from caller", "resolveTurnPlan emission") and verify each occurrence is now using the NEW identifier ("trace span event", "turn-engine runTurn"). Rule: never trust that an R(n) decision-row fix has propagated.

### Round 5: lld-reviewer (final sweep)

**Verdict:** NEEDS_REVISION → fixes applied → ready for parallel R6-R8
**Findings:** 0 CRITICAL, 4 HIGH, 4 MEDIUM, 2 LOW (all tail-site stragglers from R3/R4 sweeps; pattern predicted by R4 phase-auditor)
**Memory file:** `.claude/agent-memory-local/lld-reviewer/arch-ai-a2a-spec1-r5-review.md`

**HIGH fixes applied:**

| #   | Finding                                                                           | Resolution                                                   |
| --- | --------------------------------------------------------------------------------- | ------------------------------------------------------------ |
| H-1 | Task 1.2 body still said "5 external-agents route files"                          | Fixed to "3 route files (6 casts total)"                     |
| H-2 | Phase 4 Exit Criterion line 631 still said "journal entry routing_decision"       | Fixed to "trace span event emitted at engine turn-start"     |
| H-3 | Task 3.9 step 1 still suggested non-existent `events.ts`                          | Fixed to direct `sse-events.ts` reference                    |
| H-4 | Open Q #1 narrative still said emission lives in resolveTurnPlan (R2 v2 location) | Updated to RESOLVED in R3 with full third-revision narrative |

**MEDIUM fixes applied:**

| #   | Finding                                                       | Resolution                                                    |
| --- | ------------------------------------------------------------- | ------------------------------------------------------------- |
| M-1 | §1.3 listed `packages/arch-ai/src/journal` as in-scope        | Annotated "(NOT MODIFIED in Spec 1; listed for context only)" |
| M-2 | Open Q #2 referenced obsolete "task 4.4"                      | Marked RESOLVED in R2 (split into 4.4a/b)                     |
| M-3 | §2.2 header said "(~22)" but actual count is 27               | Header updated to "(27)"                                      |
| M-4 | §2.4 Test Files table missing `tool-result-shape.test.ts` row | Row added (4th unit test)                                     |

**LOW fixes applied:**

| #   | Finding                                         | Resolution                                                            |
| --- | ----------------------------------------------- | --------------------------------------------------------------------- |
| L-1 | §2.1 New Files header said "(5)" but list has 6 | Header updated to "(6)"                                               |
| L-2 | Open Q #7 commit-scope phase 4 packages         | Updated to "3-4 packages" with workspace-membership verification note |

**No new architectural concerns.** All findings were tail-site text-replacement stragglers that R3/R4 sweeps missed.

**Pattern observation (carried forward):** when a decision row gets revised, replace_all sweeps catch the high-traffic body sections but miss tail sites — Open Questions, Exit Criteria, §1.3 secondary references, header counts. R5 found 4 such stragglers. **Lesson for future LLD audits:** R5-final-sweep should be mechanical grep + count alignment, not architectural review.

**LLD is now internally consistent.** Ready for R6-R8 parallel external audits (platform / industry / OSS).

### Round 6: platform audit (general-purpose, local files)

**Verdict:** NEEDS_REVISION → all CRITICAL + HIGH + key MEDIUM fixes applied
**Findings:** 4 CRITICAL, 4 HIGH, 6 MEDIUM, 3 LOW

**CRITICAL fixes applied:**

| #   | Finding                                                                                                                                                                | Resolution                                                                                                                             |
| --- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------- |
| C-1 | Wrong path `tools/guards.ts` (4 sites) — actual is `apps/studio/src/lib/arch-ai/guards.ts` (no `tools/`)                                                               | replace_all sweep                                                                                                                      |
| C-2 | Page name `'external_agents'` (underscore) — actual sidebar id is `'external-agents'` (hyphen). Bias would never trigger.                                              | replace_all `external_agents` → `external-agents` for page-name occurrences                                                            |
| C-3 | Studio call-site enumeration incomplete — 3 sites for runTurn (`message-handler.ts:1721`, `process-in-project.ts:774`, `process-message.ts:680`); LLD only mentioned 2 | Phase 4 task 4.2(c.5) enumerates all 3 explicitly                                                                                      |
| C-4 | Wrong import path `@agent-platform/shared/types/external-agent` — NOT an exported subpath                                                                              | Phase 1 task 1.10 corrected to use `@agent-platform/shared/repos` re-export (matches existing `NormalizedExternalAgentConfig` pattern) |

**HIGH fixes applied:**

| #   | Finding                                                                                                                                            | Resolution                                                                                                     |
| --- | -------------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------- |
| H-1 | CREATE handler's async background test-connection at line 229-238 also needs auth update; otherwise unauth-auth status flip on first explicit Test | Phase 2 task 2.2 expanded — TWO call sites (explicit POST + CREATE async) both apply same composition          |
| H-2 | SSRF pattern divergence — runtime uses `SsrfEndpointValidator` from `@agent-platform/a2a`, LLD proposed `validateUrlForSSRF` directly              | Phase 3 task 3.2 corrected to use `SsrfEndpointValidator` (matches runtime canonical pattern)                  |
| H-3 | Test-file copies of `ExternalAgentConfigView` will silently diverge                                                                                | Phase 1 task 1.10 expanded to migrate 2 test-file copies                                                       |
| H-4 | `routing: RoutingDecision` required will break test fixtures instantiating `RunTurnInput`                                                          | Phase 4 task 4.2(c.5) recommends optional `routing?:` with default `null` + lint to enforce production callers |

**MEDIUM fixes applied:**

| #   | Finding                                                                                                                                                                         | Resolution                                                                                            |
| --- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------- |
| M-1 | Card-event Zod uses `z.unknown()` — loses contract validation; other card events strongly-typed                                                                                 | Phase 3 task 3.8 corrected — strongly-typed payload schema mirroring `ExternalAgentConfigView` fields |
| M-2 | Trace event name should be a constant in `event-names.ts`                                                                                                                       | Phase 4 task 4.2(d) — add `EVENT_ROUTING_DECISION` constant                                           |
| M-3 | "mirrors emitGateCheckTrace" inaccurate — `emitGateCheckTrace` uses startSpan/endSpan (child span); inline event is the right pattern (e.g. EVENT_BUDGET_EXHAUSTED at line 622) | Citation corrected                                                                                    |
| M-4 | `FALLBACK_STYLE` extraction missing from specialist-style.ts plan                                                                                                               | Phase 5 task 5.1 — extract all 3 (ICON_MAP + ROLE_STYLES + FALLBACK_STYLE)                            |
| M-6 | `Authorization: Bearer ${ctx.authToken}` header missing from apiFetch description                                                                                               | Phase 3 task 3.1 corrected                                                                            |

**LOW deferred:**

- L-1 task 1.7 numbering gap (cosmetic)
- L-2 §2.1 caption text consistency (cosmetic)
- L-3 5th routing pattern overly broad (defer for tightening)

**M-5 (cosmetic line-range drift) noted as accumulating but acceptable per R5.**

**Key finding for future LLD audits:**
Auditor noted the "fix-scope-leak pattern" R5 identified is still active — R6 found 4 sites with wrong `tools/guards.ts` path that all 5 prior rounds missed. Recommendation: R5 should explicitly include path-existence verification (`ls` on every file path in the LLD), not just diff against decision-row updates. Carried forward to package agents.md learnings.

### Round 7: industry research audit (general-purpose, web)

**Verdict:** Findings integrated → fixes applied
**Findings:** 3 RISK / 4 GAP / 3 IMPROVEMENT (sourced from A2A spec, OWASP, OTel semconv, LangGraph, Aembit/PKCE)

**Applied to LLD:**

| #             | Finding                                                                            | Resolution                                                                                                                                                                             |
| ------------- | ---------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| RISK-2        | SSRF gaps — DNS rebinding, redirect-follow, IPv6 not in unit tests                 | Phase 3 task 3.11 expanded — `url-ssrf-validator.test.ts` adds 3 explicit test cases; if `validateUrlForSSRF` doesn't cover, escalate to shared-kernel improvement + defensive wrapper |
| RISK-3        | flowId scoping invariants (tenant/user/session, single-use, cross-tool partition)  | Phase 3 task 3.1 expanded — explicit invariants documented; new EXT-6 integration test asserts cross-session/tool reuse rejected                                                       |
| IMPROVEMENT-4 | OTel — `specialist` should be a turn-span attribute (alongside event) for sampling | Phase 4 task 4.2(d) adds `trace.setAttribute(turnSpanId, 'arch.specialist', input.routing.specialist)` after the event emission                                                        |

**Deferred to Spec 3 (documented in new §8 of LLD):**

| #             | Finding                                                         | Defer rationale                                               |
| ------------- | --------------------------------------------------------------- | ------------------------------------------------------------- |
| GAP-1         | Agent-card ETag/If-None-Match caching                           | Minor perf only; SDK may handle internally                    |
| GAP-5         | HANDOFF synthesizer pinning card.version                        | Topology resilience belongs with Spec 2 + Spec 3              |
| IMPROVEMENT-6 | GetExtendedAgentCard mechanism                                  | Belongs with Spec 3 OAuth wiring                              |
| GAP-8         | E2E for card-version drift, partial-handoff, contextId-mismatch | Spec 3 resilience suite                                       |
| RISK-7        | Phase 3-only window (tool exposed before L2 card)               | Recommendation to ship Phase 3+4 as one PR added to LLD risks |

**Sources cited (URLs in LLD §8):**

- A2A Protocol Specification (a2a-protocol.org)
- OWASP SSRF Prevention Cheat Sheet
- OpenTelemetry Trace Semantic Conventions
- LangGraph Multi-Agent Swarm
- Aembit MCP/OAuth/PKCE blog

### Round 8: OSS library audit (general-purpose, web)

**Verdict:** Findings integrated → one improvement applied; rest noted as already-covered or unnecessary
**Findings:** 1 actionable (HIGH simplification opportunity)

**Applied to LLD:**

| #   | Finding                                                                                                               | Resolution                                                                                                                                                                                                                                                                |
| --- | --------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 1   | Phase 3 task 3.2 hand-writes fetch + JSON parse; `@a2a-js/sdk` exposes `DefaultAgentCardResolver.resolve()` port-free | Task 3.2 rewritten: compose `validateUrlForSSRF` + `DefaultAgentCardResolver.resolve()` + Zod safety-net + 256KB cap. Saves ~30-50 LOC, inherits SDK redirect/content-type handling. Alternative: inject platform's `discoverAgent` use case with simple stubs (~25 LOC). |

**Verified (no action):**

- `request-filtering-agent` / `ssrf-req-filter` — duplicates platform's `safe-fetch.ts` (already in scope). AVOID.
- `wink-nlp` / `compromise` / `natural` (intent classification) — overkill for 5 regexes. AVOID for Spec 1; consider for Spec 2/3 if routing surface grows.
- `json-schema-to-zod` — adds dependency for fixed 9-field subset. AVOID; keep hand-written D-11 Zod.
- `@a2a-js/sdk` Apache-2.0 — already in scope, commercial-SaaS-compatible.

**Sources cited:**

- @a2a-js/sdk on npm (Apache-2.0, official a2aproject)
- Agent2Agent (A2A) Protocol Specification
- Multiple OSS library npm/GitHub URLs

# SDLC Log: Quick Actions & Commands — Feature Spec

**Feature**: B57 — Quick Actions, Slash Commands & Data References
**Phase**: Feature Spec (Phase 1 of SDLC)
**Date**: 2026-04-06
**Branch**: `Archv03_chat_multimodel`

---

## Oracle Decisions

All 15 clarifying questions answered autonomously — 0 AMBIGUOUS items escalated.

### Scope & Problem

| #   | Question                                    | Classification | Decision                                                                 |
| --- | ------------------------------------------- | -------------- | ------------------------------------------------------------------------ |
| Q1  | Scope: all 5 phases or B57.1+B57.2?         | DECIDED        | B57.1 (slash commands) + B57.2 (@mentions) only. B57.3-5 future.         |
| Q2  | Both onboarding and in-project modes?       | DECIDED        | Yes, with phase-filtered command list (matches PHASE_TOOL_MAP pattern).  |
| Q3  | Reuse cmdk/CommandPalette or separate?      | DECIDED        | Separate inline dropdown. Different interaction model (inline vs modal). |
| Q4  | @mention scope: all entities or agent+tool? | DECIDED        | @agent and @tool only for B57.2. Full entities in B57.4.                 |
| Q5  | Frontend-only or backend-routed commands?   | ANSWERED       | Hybrid. Simple = frontend-only. Complex = backend `type: 'command'`.     |

### User Stories & Requirements

| #   | Question                                            | Classification | Decision                                          |
| --- | --------------------------------------------------- | -------------- | ------------------------------------------------- |
| Q6  | Primary persona?                                    | ANSWERED       | Agent designer/developer.                         |
| Q7  | Cmd+K integration?                                  | DECIDED        | Deferred to B28 (Keyboard Shortcuts).             |
| Q8  | Mentions: inject via pageContext or separate field? | DECIDED        | Separate `mentions` field in MessageRequest.      |
| Q9  | Specialist routing commands?                        | ANSWERED       | Yes: /ask-architect, /ask-governance, /ask-voice. |
| Q10 | Static or dynamic command list?                     | DECIDED        | Dynamic with `when` predicates per mode/phase.    |

### Technical & Architecture

| #   | Question                                        | Classification | Decision                                                |
| --- | ----------------------------------------------- | -------------- | ------------------------------------------------------- |
| Q11 | Add `type: 'command'` variant?                  | DECIDED        | Yes, 6th variant in MessageRequestSchema.               |
| Q12 | Client-side or server-side mention resolution?  | DECIDED        | Client-side (matches B02 pattern).                      |
| Q13 | Which stores for mention data?                  | ANSWERED       | arch-ai-store (filePanelFiles) + project store.         |
| Q14 | Dropdown: cursor-anchored or fixed above input? | DECIDED        | Fixed panel above input (Slack-style).                  |
| Q15 | Major feature or sub-feature?                   | ANSWERED       | Major feature: docs/features/quick-actions-commands.md. |

---

## Files Created

- `docs/features/quick-actions-commands.md` — Feature spec
- `docs/testing/quick-actions-commands.md` — Testing guide placeholder
- `docs/sdlc-logs/quick-actions-commands/feature-spec.log.md` — This file

---

## Audit Round 1 of 2

**Auditor**: phase-auditor
**Date**: 2026-04-06
**Verdict**: NEEDS_REVISION

### CRITICAL (must fix before next phase)

#### [FS-6/XP-3] Isolation requirements are descriptive, not prescriptive (Section 12)

**Location**: `docs/features/quick-actions-commands.md` lines 339-344

The isolation table states sessions "are tenant-scoped" and commands "inherit the session's tenantId" -- this describes the current architecture but does not state enforceable requirements. Per CLAUDE.md Core Invariants and TEMPLATE.md section 12, the spec must state:

- Every backend command handler query MUST include `tenantId` in the filter.
- Every project-scoped command (compile, health, topology) MUST include `projectId` in the filter.
- Cross-tenant command execution MUST return 404 (not 403).
- Cross-project command execution MUST return 404 (not 403).
- @mention resolution MUST NOT resolve entities from other projects or tenants.

The current phrasing ("commands inherit the session's tenantId") is an implementation observation, not a testable requirement. An implementer could read this and skip adding explicit `tenantId` filters because "the session already has it."

**Fix**: Rewrite the Isolation & Multitenancy table rows to use "MUST" language with explicit filter/404 requirements. Model after TEMPLATE.md section 12 which specifies "cross-project access must return 404" and "cross-tenant access must return 404."

#### [FS-2] Specialist-direct command routing claims are imprecise (Section 7, FR-6, line 102)

**Location**: `docs/features/quick-actions-commands.md` lines 96, 102, 197-198

FR-6 lists `/ask-architect`, `/ask-governance` as specialist-direct commands, and the backlog (B57 line 47) also lists `/ask-voice`. However, the actual specialist IDs in `packages/arch-ai/src/types/constants.ts` are:

- ONBOARDING specialists: `onboarding`, `multi-agent-architect`, `abl-construct-expert`, `governance`, `channel-voice`, `entity-collection`, `integration-methodologist`, `observability-analyst`, `testing-eval`
- IN_PROJECT specialists: `project-architect`, `diagnostician`, `analyst`, `quality-engineer`, `platform-guide`

The spec does not clarify the mapping between command names and specialist IDs. `/ask-architect` could mean `multi-agent-architect` (ONBOARDING) or `project-architect` (IN_PROJECT). The spec must ground these claims by specifying exactly which specialist ID each `/ask-*` command routes to, and whether the mapping is mode-dependent.

**Fix**: Add a command-to-specialist-ID mapping table in section 7 (Technical Considerations). For each `/ask-*` command, state the target specialist ID and whether it varies by mode. Example: `/ask-architect` -> `project-architect` in IN_PROJECT mode, `multi-agent-architect` in ONBOARDING mode.

### HIGH (should fix)

#### [FS-3] FR-9 "inject into specialist system prompt" is not testable as stated (line 96)

**Location**: `docs/features/quick-actions-commands.md` line 96

FR-9 says the backend must "inject resolved mention data into the specialist's system prompt as a `## Referenced Entities` section." The current prompt system (`packages/arch-ai/src/prompts/index.ts` line 94) only has `## Current Context`. FR-9 should specify:

- Where `## Referenced Entities` appears relative to `## Current Context` (before, after, or replacing).
- What the section format looks like (agent name, agent content, tool schemas?).
- Maximum token budget for injected mention data (relates to Open Question #3 but should have a concrete default).

Without this, the requirement is not testable -- how does a tester verify the section was injected correctly?

**Fix**: Add a concrete format example for `## Referenced Entities` in section 7 (Technical Considerations), and rewrite FR-9 to reference the format. Specify ordering: `## Current Context` first, then `## Referenced Entities`.

#### [FS-8] Delivery plan Phase 2 task 8 (E2E Testing) is misplaced (lines 423-428)

**Location**: `docs/features/quick-actions-commands.md` lines 423-428

Task 8 "End-to-End Testing" is listed as part of "Phase 2: @Mentions" but its subtasks include testing slash commands (8.1: `/compile billing_agent`, 8.3: invalid command, 8.4: phase-filtered commands). E2E testing for slash commands should be in Phase 1, and E2E testing for mentions should be in Phase 2. The current structure implies slash command testing is deferred until Phase 2 is complete.

**Fix**: Split task 8 into two tasks:

- Phase 1, task 4 (or new task 5): E2E tests for slash commands (subtasks 8.1, 8.3, 8.4).
- Phase 2, task 8: E2E tests for @mentions (subtasks 8.2, 8.5).

#### [FS-7] Data model section lacks detail on command dispatch mapping (Section 9, lines 271-272)

**Location**: `docs/features/quick-actions-commands.md` line 272

The data model says "command dispatch: `type: 'command'` messages map to tool invocations via a server-side command-to-tool mapping." This is vague. The spec should define:

- Where the command-to-tool mapping lives (in-memory constant? config file? database?).
- The mapping structure (command string -> tool name + default args).
- Whether the mapping is extensible at runtime.

This directly affects implementation decisions (data model vs. code constant) and should be specified.

**Fix**: Add a command-to-tool mapping definition in section 9 (Data Model) or section 7 (Technical Considerations). Example: `{ 'compile': { tool: 'compile_abl', defaultArgs: {} }, 'health': { tool: 'health_check', defaultArgs: {} } }`.

#### [FS-10] Testing section E2E scenarios lack auth context (Section 17, lines 470-481)

**Location**: `docs/features/quick-actions-commands.md` lines 470-481

The testing coverage table (section 17) lists 10 scenarios but none specify auth context (tenant, project, user). Per CLAUDE.md E2E standards, every scenario must specify who is making the request. Additionally, the E2E scenarios in the testing guide (`docs/testing/quick-actions-commands.md` lines 51-110) also omit auth context on most scenarios -- only E2E-2 mentions "session metadata" but does not specify tenant/project/user.

Neither the feature spec testing table nor the testing guide include isolation test scenarios (cross-tenant 404, cross-project 404).

**Fix**:

1. Add auth context column to the testing table in section 17 (or note that auth context is specified in the testing guide).
2. Add at least 2 isolation scenarios to the testing guide: (a) cross-tenant command returns 404, (b) cross-project @mention resolution returns empty.

#### [XP-5] No `packages/arch-ai/agents.md` exists

**Location**: N/A -- file does not exist

The feature spec lists `packages/arch-ai` as a primary package, but no `agents.md` exists in that package. Per SDLC pipeline rules, agents must read `agents.md` before modifying code and write learnings after. `apps/studio/agents.md` exists and was read -- it has no relevant B57 learnings yet (expected for PLANNED status).

**Fix**: Create `packages/arch-ai/agents.md` with the standard header (can be empty of entries). This is a prerequisite for the implementation phase.

### MEDIUM (recommended)

#### [FS-9] Testing guide INT-3 uses "mock agent data" language (testing guide line 130)

**Location**: `docs/testing/quick-actions-commands.md` line 130

INT-3 says "Set up Zustand store with mock agent data." For integration tests testing the mention resolver hook, this is acceptable (it's testing the hook's logic, not the backend). However, the language should clarify this is test fixture data seeded into the Zustand store, not a `vi.mock()` of the store itself. Per CLAUDE.md E2E standards, integration tests should not mock codebase components.

**Fix**: Rephrase to "Seed Zustand store with test fixture agent data" to avoid ambiguity with vi.mock patterns.

#### [FS-1] Section 8 "How to Consume" API table has only 1 endpoint (line 246)

**Location**: `docs/features/quick-actions-commands.md` lines 245-248

The API table shows only `POST /api/arch-ai/message`. While this is technically the only modified endpoint, the section should note whether a new endpoint is needed for command discovery (e.g., `GET /api/arch-ai/commands?mode=IN_PROJECT&phase=BUILD`) or if command registry is purely client-side. This affects whether the backend has a new API surface.

**Fix**: Add a note clarifying that command registry is client-side only (if that's the intent), or add the command discovery endpoint if one is planned.

### Cross-Phase Consistency

- [XP-1] PASS -- Feature spec references backlog B57 correctly (line 493). FRs trace to backlog vision sections 1-2.
- [XP-1] PASS -- Related feature specs (arch-ai-assistant, page-context-awareness, live-thinking-visibility) are referenced with correct relationship types.
- [XP-2] PASS -- The spec provides sufficient detail for the test spec phase: 15 FRs, clear execution flows, schema extensions.
- [XP-3] PASS -- No scope creep beyond B57.1 + B57.2. B57.3-5 explicitly excluded as non-goals.
- [XP-4] PASS -- Terminology is consistent: "slash commands," "@mentions," "command dropdown," "mention chips" used uniformly.
- [XP-4] MINOR NOTE -- The backlog uses "context" for mention data (`attach resolved data as context field`), while the spec uses "mentions" field. This is a deliberate design decision (Q8 in oracle decisions), not an inconsistency.
- [XP-5] WARN -- `packages/arch-ai/agents.md` does not exist. `apps/studio/agents.md` was read and has no B57-relevant learnings (acceptable for PLANNED status).

### Verified

- [x] FS-1 Template completeness -- all 18 sections present and addressed
- [x] FS-2 Code grounding (partial) -- `MessageRequestSchema` has exactly 5 variants, "6th" claim is accurate; `filePanelFiles` confirmed in `arch-ai-store.ts:76`; `ArchMode`/`ArchPhase` types confirmed in `constants.ts:6-8`; `buildPageContext` confirmed in `useArchChat.ts:767`; `ActivityEmitter` confirmed in `streaming/activity-emitter.ts`; `CommandPalette.tsx` confirmed to exist
- [x] FS-3 Requirement quality -- 15 FRs, all use "The system must..." language, all are testable
- [x] FS-4 User stories -- 7 stories, each with persona (agent designer) + capability + benefit
- [x] FS-5 Integration matrix -- 4 related features with relationship types specified
- [x] FS-8 Delivery plan -- 8 parent tasks with numbered subtasks (1.1-1.4, 2.1-2.4, 3.1-3.4, 4.1-4.3, 5.1-5.4, 6.1-6.3, 7.1-7.3, 8.1-8.5)
- [x] FS-9 Testing section -- links to testing guide, coverage table present
- [x] FS-10 Scope clarity -- goals and non-goals clearly separated with backlog item references
- [x] Open questions -- 5 genuine open questions present
- [x] Gaps section -- 5 gaps with severity and status

### Notes for Next Round

- Focus areas for re-audit after fixes:
  1. Section 12 isolation table -- verify MUST language and 404 requirements added
  2. Specialist-direct command routing mapping -- verify grounded in actual specialist IDs
  3. FR-9 referenced entities format -- verify concrete format specified
  4. Delivery plan task 8 split -- verify E2E tests aligned to correct phases
  5. Testing guide auth context and isolation scenarios -- verify added

---

## Audit Round 2 of 2

**Auditor**: phase-auditor
**Date**: 2026-04-06
**Verdict**: APPROVED

### Round 1 Fix Verification

All 9 round 1 fixes confirmed applied:

1. **Section 12 isolation table** (was CRITICAL FS-6): FIXED. Lines 404-408 now use MUST language with explicit filter requirements and 404 behavior for project, tenant, and user isolation. "Cross-project command execution MUST return 404 (not 403)" -- exactly what was requested.

2. **Command-to-specialist mapping** (was CRITICAL FS-2): FIXED. Lines 219-227 add a clear table mapping `/ask-architect`, `/ask-governance`, `/ask-voice` to specialist IDs per mode. References `constants.ts` lines 12-22 and 24-30, which match the actual code.

3. **FR-9 format and ordering** (was HIGH FS-3): FIXED. FR-9 at line 96 now specifies: `## Referenced Entities` section, placed AFTER `## Current Context`, one `### <type>: <name>` sub-heading per mention, 4000-token budget. Section 7 (lines 187-215) provides a concrete format example.

4. **Delivery plan E2E split** (was HIGH FS-8): FIXED. Phase 1 now has task 5 (lines 468-473) with slash command E2E tests. Phase 2 has task 9 (lines 493-498) with mention E2E tests.

5. **COMMAND_TOOL_MAP constant** (was HIGH FS-7): FIXED. Lines 233-241 define the mapping with tool names and default args.

6. **Testing isolation scenarios** (was HIGH FS-10): FIXED. Scenarios #11 and #12 added to the feature spec testing table (lines 552-553). Testing guide has INT-7 (cross-tenant 404) and INT-8 (cross-project empty resolution).

7. **packages/arch-ai/agents.md** (was HIGH XP-5): FIXED. File exists with 5 relevant learnings about MessageRequestSchema, specialist IDs, page context pattern, prompt injection point, and phase-gated tools.

8. **API table clarification** (was MEDIUM FS-1): FIXED. Lines 310-311 note "Command discovery is entirely client-side -- no new API endpoint needed."

9. **"mock agent data" language** (was MEDIUM FS-9): FIXED. Testing guide INT-3 (line 130) now says "Set up Zustand store with test fixture agent data."

### New Findings from Round 2

### HIGH (should fix, does not block)

#### [FS-2] COMMAND_TOOL_MAP references two non-existent tools: `show_diff` and `fix_agent`

**Location**: `docs/features/quick-actions-commands.md` lines 239-240

The COMMAND_TOOL_MAP in section 7 maps:

- `diff` -> `{ tool: 'show_diff' }`
- `fix` -> `{ tool: 'fix_agent' }`

Neither `show_diff` nor `fix_agent` exists in the codebase. The canonical tool list in `packages/arch-ai/src/types/tools.ts` (lines 10-26) defines 16 tools, and neither is among them. `compile_abl` and `health_check` are valid, but the other two are invented.

This does not block the feature spec phase because the implementation phase can simply omit these two commands. However, claiming them as tool mappings is misleading.

**Fix**: Either (a) remove `diff` and `fix` from the COMMAND_TOOL_MAP and note them as future/planned tools, or (b) mark them as "requires new tool implementation" in the delivery plan with an explicit subtask.

#### [FS-2] `/ask-voice` to `platform-guide` mapping is semantically questionable

**Location**: `docs/features/quick-actions-commands.md` line 225

The command-to-specialist mapping maps `/ask-voice` to `platform-guide` in IN_PROJECT mode. In ONBOARDING, `channel-voice` is the "Channel & Voice Expert" -- a domain-specific specialist. In IN_PROJECT, `platform-guide` is a general "Platform Guide" with no voice/channel specialization. A user typing `/ask-voice` in IN_PROJECT mode would expect a voice-domain expert, not a generic platform guide.

This mapping is grounded in the actual IN_PROJECT specialist IDs (there is no voice-specific IN_PROJECT specialist), but the semantic mismatch should be documented in Open Questions or Gaps as a UX concern.

**Fix**: Add a note to Open Questions or GAP table: "IN_PROJECT mode has no voice-specific specialist. `/ask-voice` falls back to `platform-guide`. Consider whether to add an IN_PROJECT voice specialist or display a message explaining the fallback."

#### [FS-2] `SpecialistId` type in `tools.ts` only covers ONBOARDING specialists

**Location**: `docs/features/quick-actions-commands.md` lines 219-227 (mapping table)

The spec's command-to-specialist mapping references IN_PROJECT specialist IDs (`project-architect`, `quality-engineer`, `platform-guide`). However, `SpecialistId` in `packages/arch-ai/src/types/tools.ts` line 8 is typed as `(typeof SPECIALIST_IDS)[number]` which ONLY includes ONBOARDING specialists. IN_PROJECT specialists use `InProjectSpecialistId` from `constants.ts` line 32.

The `composeInProjectPrompt` function accepts `SpecialistId` (ONBOARDING type) despite being used with IN_PROJECT IDs -- this is an existing type discrepancy in the codebase. The spec should note that implementing `/ask-*` commands for IN_PROJECT mode will require either using `AnySpecialistId` (the union type at `constants.ts` line 35) or accepting that TypeScript will flag a type mismatch.

**Fix**: Add a technical note in section 7 (Technical Considerations) near the command-to-specialist mapping: "Note: `SpecialistId` type covers ONBOARDING only. IN_PROJECT specialist IDs use `InProjectSpecialistId`. Command routing should use `AnySpecialistId` (the union of both) to support mode-dependent dispatch."

### MEDIUM (recommended)

#### [FS-9] Testing guide E2E scenarios still lack explicit auth context

**Location**: `docs/testing/quick-actions-commands.md` lines 51-110

E2E-1 through E2E-7 still do not specify auth context (tenantId, projectId, userId) in their preconditions or steps. E2E-1 says "Active Arch session in BUILD phase" but does not specify tenant/project/user. The feature spec's coverage table (section 17) added auth context only to scenario #1 ("auth: tenant+project") but the testing guide did not receive the same treatment.

Per CLAUDE.md E2E standards: "every E2E scenario must specify who is making the request." The isolation scenarios (INT-7, INT-8) do specify multi-tenant context, but the happy-path E2E scenarios do not.

This is MEDIUM (not HIGH) because the testing guide is PLANNED status and scenarios will be fully fleshed out during the test-spec phase. But adding "Auth: tenant T1, project P1, user U1" to each precondition would make the test spec phase smoother.

**Fix**: Add an auth context line to each E2E scenario's Preconditions. Example for E2E-1: "**Auth context**: Tenant T1, Project P1, User U1 (agent designer role)."

#### [FS-9] Testing guide INT-6 specifies auth but E2E scenarios do not

**Location**: `docs/testing/quick-actions-commands.md` lines 147-149 vs 51-110

INT-6 (Backend Command Handler) correctly specifies "(with auth: tenantId + projectId + userId)" in its approach. This creates an inconsistency where integration tests are more rigorous about auth context than E2E tests. E2E tests are the higher-fidelity tests and should have at least as much auth context specification.

**Fix**: Same as above -- add auth context to E2E preconditions.

### Cross-Phase Consistency

- [XP-1] PASS -- All FRs trace to backlog B57. Command-to-specialist mapping traces to `constants.ts`. COMMAND_TOOL_MAP traces to `tools.ts` (with exceptions noted in FS-2 above).
- [XP-2] PASS -- Spec provides sufficient detail for test-spec phase: 15 FRs, concrete schema examples, format examples, execution flow, and a testing guide with 7 E2E + 8 integration scenarios.
- [XP-3] PASS -- No new scope beyond B57.1 + B57.2. B57.3-5 remain excluded.
- [XP-4] PASS -- Terminology consistent across feature spec and testing guide. "slash commands," "@mentions," "command dropdown," "mention chips" used uniformly.
- [XP-5] PASS -- `packages/arch-ai/agents.md` now exists with 5 learnings. The `SpecialistId` vs `InProjectSpecialistId` type issue is a new finding not yet in agents.md (noted in HIGH finding above).

### Verified (all round 1 + round 2 checks)

- [x] FS-1 Template completeness -- all 18 sections addressed
- [x] FS-2 Code grounding -- `MessageRequestSchema` 5 variants confirmed, `filePanelFiles` at `arch-ai-store.ts:76`, `SPECIALIST_IDS` and `IN_PROJECT_SPECIALIST_IDS` confirmed at `constants.ts:12-30`, `compile_abl` and `health_check` confirmed in `tools.ts`. Two invented tools flagged as HIGH.
- [x] FS-3 Requirement quality -- 15 FRs, all "The system must..." language, all testable
- [x] FS-4 User stories -- 7 stories, each with persona + capability + benefit
- [x] FS-5 Integration matrix -- 4 related features with relationship types
- [x] FS-6 Non-functional concerns -- tenant/project/user isolation with MUST language and 404 requirements
- [x] FS-7 Data model -- no new collections (correct for this feature), COMMAND_TOOL_MAP defined, mention resolution stores identified
- [x] FS-8 Delivery plan -- 9 parent tasks with numbered subtasks, E2E tests aligned to phases
- [x] FS-9 Testing section -- links to testing guide, coverage table with 12 scenarios
- [x] FS-10 Scope clarity -- goals and non-goals clearly separated

### Verdict Rationale

APPROVED. All CRITICAL findings from round 1 were resolved. The 3 HIGH findings from round 2 are genuine but do not block the test-spec phase:

1. Invented tool names (`show_diff`, `fix_agent`) will surface during implementation when tools don't exist
2. The `/ask-voice` -> `platform-guide` semantic mismatch is a UX question, not a structural issue
3. The `SpecialistId` type gap is an existing codebase issue that will be caught by TypeScript during implementation

The 2 MEDIUM findings about auth context in E2E scenarios will be naturally addressed during the test-spec phase.

No further audit rounds needed. Artifact is ready for test-spec phase.

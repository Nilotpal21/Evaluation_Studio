# LLD: Arch AI IN_PROJECT Generalist Router

**Feature Spec**: `docs/features/sub-features/arch-ai-generalist-router.md`
**HLD**: `docs/specs/arch-ai-generalist-router.hld.md`
**Test Spec**: `docs/testing/sub-features/arch-ai-generalist-router.md`
**Status**: DONE
**Date**: 2026-04-15

---

## 1. Design Decisions

### Decision Log

| #   | Decision                                                                                      | Rationale                                                                                                                                                                                                                                                                                                                                                                | Alternatives Rejected                                                 |
| --- | --------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | --------------------------------------------------------------------- |
| D-1 | Domain cards are separate files (not inline in card-router.ts)                                | Follows existing pattern — all 26 construct cards are separate files in `knowledge/cards/`. Keeps card-router.ts as a registry, not a content dump.                                                                                                                                                                                                                      | Inline card content in CARD_REGISTRY entries                          |
| D-2 | Domain card content strips persona framing, preserves tool guidance and workflows             | Persona ("You are the X") belongs in the specialist prompt layer, not in knowledge cards. Tool guidance ("USE validate_agent FIRST") is actionable knowledge that helps the LLM select the right tool.                                                                                                                                                                   | Strip everything; keep persona in cards                               |
| D-3 | `composeInProjectPrompt` keeps its `specialist` parameter but ignores it for prompt selection | Preserves backward-compatible call signature from `route.ts` and test files. Internally uses `GENERALIST_PROMPT` regardless of the specialist value passed. Avoids cascade of call-site changes in route.ts and test files. **Overrides feature spec delivery plan task 3.3 which said "remove specialist parameter" — removal deferred to a follow-up cleanup commit.** | Remove parameter entirely (breaks call sites); add overload (complex) |
| D-4 | Generalist prompt is a new file, not a modification of abl-construct-expert.ts                | `abl-construct-expert.ts` is still used by ONBOARDING's BUILD phase. Modifying it would affect both code paths. A new `in-project-generalist.ts` file is the clean separation.                                                                                                                                                                                           | Modify abl-construct-expert.ts; branch inside the file                |
| D-5 | Content-router.ts is NOT modified — IN_PROJECT path in route.ts simply stops calling it       | `routeByContent()` is still needed for ONBOARDING mode (the ONBOARDING path in `route.ts:~L5040` does not use it directly, but it is exported and tested). Deleting it or modifying it risks ONBOARDING regressions.                                                                                                                                                     | Delete routeByContent; modify it to return constant for IN_PROJECT    |
| D-6 | Token budget increase is a constant change, not a parameter                                   | `MAX_KNOWLEDGE_TOKENS` is a module-level constant in `card-router.ts:51`. Making it a parameter would change the `selectKnowledgeCards` signature and all call sites. A constant change is sufficient for now; parameterization can come later if needed.                                                                                                                | Make it a function parameter; add environment variable                |

### Key Interfaces & Types

```typescript
// No new interfaces. Existing interfaces reused:

// card-router.ts — existing, no change
interface CardEntry {
  id: string;
  content: string;
  patterns: RegExp[];
}

// card-router.ts — existing, no change
interface CardSelection {
  selectedIds: string[];
  skippedIds: string[];
  content: string;
  estimatedTokens: number;
}

// prompts/index.ts — signature preserved (D-3)
function composeInProjectPrompt(
  specialist: AnySpecialistId, // kept for compat, ignored internally
  pageContext?: PageContext,
  userMessage?: string,
  specDocument?: Record<string, unknown>,
  projectMemorySection?: string | null,
  learningsSection?: string | null,
): string;
```

### Module Boundaries

| Module                                               | Responsibility                                     | Depends On                          |
| ---------------------------------------------------- | -------------------------------------------------- | ----------------------------------- |
| `knowledge/cards/*.ts` (8 new files)                 | Export domain card content strings                 | Nothing (pure constants)            |
| `knowledge/card-router.ts`                           | Register new cards, select by intent               | New card files, existing card files |
| `knowledge/index.ts`                                 | Re-export new card constants                       | New card files                      |
| `prompts/specialists/in-project-generalist.ts` (new) | Export generalist base prompt                      | Nothing (pure constant)             |
| `prompts/index.ts`                                   | Use generalist prompt instead of specialist lookup | New generalist prompt, card-router  |
| `route.ts` (IN_PROJECT path)                         | Skip routeByContent, use constant specialist       | prompts/index.ts                    |

---

## 2. File-Level Change Map

### New Files

| File                                                                 | Purpose                                                                    | LOC Estimate |
| -------------------------------------------------------------------- | -------------------------------------------------------------------------- | ------------ |
| `packages/arch-ai/src/knowledge/cards/diagnostics-workflow.ts`       | Domain card — diagnostician tool guidance + workflows                      | ~60          |
| `packages/arch-ai/src/knowledge/cards/analytics-workflow.ts`         | Domain card — analyst tool guidance + data patterns                        | ~50          |
| `packages/arch-ai/src/knowledge/cards/observer-workflow.ts`          | Domain card — observer layers + briefing patterns                          | ~50          |
| `packages/arch-ai/src/knowledge/cards/tool-integration-workflow.ts`  | Domain card — tool binding types + auth configuration                      | ~60          |
| `packages/arch-ai/src/knowledge/cards/topology-design-workflow.ts`   | Domain card — topology patterns + handoff types (IN_PROJECT portions only) | ~40          |
| `packages/arch-ai/src/knowledge/cards/channel-voice-workflow.ts`     | Domain card — channel config + voice prompts                               | ~30          |
| `packages/arch-ai/src/knowledge/cards/entity-collection-workflow.ts` | Domain card — gather design + validation patterns                          | ~30          |
| `packages/arch-ai/src/knowledge/cards/testing-eval-workflow.ts`      | Domain card — test scenario taxonomy + eval criteria                       | ~40          |
| `packages/arch-ai/src/prompts/specialists/in-project-generalist.ts`  | Generalist base prompt for IN_PROJECT mode                                 | ~80          |

### Modified Files

| File                                                                      | Change Description                                                                                                                                                           | Risk                                 |
| ------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------ |
| `packages/arch-ai/src/knowledge/card-router.ts`                           | Add 8 imports + 8 CardEntry items to CARD_REGISTRY; change `MAX_KNOWLEDGE_TOKENS` from 4000 to 6000                                                                          | Low — additive                       |
| `packages/arch-ai/src/knowledge/index.ts`                                 | Add 8 re-exports for new domain card constants                                                                                                                               | Low — additive                       |
| `packages/arch-ai/src/prompts/index.ts`                                   | Import generalist prompt; use it instead of `SPECIALIST_PROMPTS[specialist]` in `composeInProjectPrompt`                                                                     | Medium — behavioral change           |
| `apps/studio/src/app/api/arch-ai/message/route.ts`                        | Remove `routeByContent()` call from IN_PROJECT path (~L4088-4113); simplify tool_answer path; update SSE badge to "Arch AI"; hardcode specialist to `'abl-construct-expert'` | Medium — large file, surgical change |
| `packages/arch-ai/src/types/in-project-specialists.ts`                    | Simplify display map (optional — can be deferred)                                                                                                                            | Low                                  |
| `packages/arch-ai/src/__tests__/golden-corpus/scenarios.ts`               | Add 8 domain card scenarios                                                                                                                                                  | Low — additive                       |
| `packages/arch-ai/src/__tests__/golden-corpus/knowledge-coverage.test.ts` | Update token budget assertion (4000 → 6000); add domain card coverage assertion                                                                                              | Low                                  |
| `packages/arch-ai/src/__tests__/prompts.test.ts`                          | Update `composeInProjectPrompt` tests for generalist behavior                                                                                                                | Low                                  |

### Deleted Files

None. All existing files preserved for ONBOARDING compatibility.

---

## 3. Implementation Phases

### Phase 1: Domain Knowledge Cards

**Goal**: Create 8 domain knowledge cards from specialist prompts and register them in the card-router.

**Tasks**:

1.1. Read each specialist prompt file (`diagnostician.ts`, `analyst.ts`, `observer.ts`, `integration-methodologist.ts`, `multi-agent-architect.ts`, `channel-voice.ts`, `entity-collection.ts`, `testing-eval.ts`). For each, extract:

- Tool guidance sections ("Your Tools", numbered tool list with usage hints)
- Domain workflows ("Diagnostic Workflow", "Analysis Workflow", etc.)
- Behavioral rules ("How to Behave", "Key Rules")
- Strip persona framing ("You are the X") — that belongs to the generalist prompt or is omitted

  1.2. Create 8 card files in `packages/arch-ai/src/knowledge/cards/`:

- `diagnostics-workflow.ts` — exported as `DIAGNOSTICS_WORKFLOW_CARD`
- `analytics-workflow.ts` — exported as `ANALYTICS_WORKFLOW_CARD`
- `observer-workflow.ts` — exported as `OBSERVER_WORKFLOW_CARD`
- `tool-integration-workflow.ts` — exported as `TOOL_INTEGRATION_WORKFLOW_CARD`
- `topology-design-workflow.ts` — exported as `TOPOLOGY_DESIGN_WORKFLOW_CARD`
- `channel-voice-workflow.ts` — exported as `CHANNEL_VOICE_WORKFLOW_CARD`
- `entity-collection-workflow.ts` — exported as `ENTITY_COLLECTION_WORKFLOW_CARD`
- `testing-eval-workflow.ts` — exported as `TESTING_EVAL_WORKFLOW_CARD`

  1.3. Add imports and 8 `CardEntry` items to `CARD_REGISTRY` in `card-router.ts`. Append after existing construct cards. Trigger patterns derived from `content-router.ts` ROUTE_RULES for each specialist, plus relevant patterns from specialist prompt keywords.

  1.4. Change `MAX_KNOWLEDGE_TOKENS` from `4000` to `6000` in `card-router.ts:51`.

  1.5. Add 8 re-exports to `knowledge/index.ts`.

  1.6. Add 8 golden corpus scenarios to `scenarios.ts` — one per domain card. Each scenario specifies `expectedCards` including the domain card ID.

  1.7. Update `knowledge-coverage.test.ts`:

- Change token budget assertion from `4000` to `6000`
- Add domain card IDs to the "all card IDs covered" assertion

**Files Touched**:

- `packages/arch-ai/src/knowledge/cards/diagnostics-workflow.ts` — NEW
- `packages/arch-ai/src/knowledge/cards/analytics-workflow.ts` — NEW
- `packages/arch-ai/src/knowledge/cards/observer-workflow.ts` — NEW
- `packages/arch-ai/src/knowledge/cards/tool-integration-workflow.ts` — NEW
- `packages/arch-ai/src/knowledge/cards/topology-design-workflow.ts` — NEW
- `packages/arch-ai/src/knowledge/cards/channel-voice-workflow.ts` — NEW
- `packages/arch-ai/src/knowledge/cards/entity-collection-workflow.ts` — NEW
- `packages/arch-ai/src/knowledge/cards/testing-eval-workflow.ts` — NEW
- `packages/arch-ai/src/knowledge/card-router.ts` — MODIFY (imports, registry entries, constant)
- `packages/arch-ai/src/knowledge/index.ts` — MODIFY (re-exports)
- `packages/arch-ai/src/__tests__/golden-corpus/scenarios.ts` — MODIFY (8 new scenarios)
- `packages/arch-ai/src/__tests__/golden-corpus/knowledge-coverage.test.ts` — MODIFY (budget, coverage)

**Exit Criteria**:

- [ ] `pnpm build --filter=@agent-platform/arch-ai` succeeds with 0 errors
- [ ] All 8 domain cards export non-empty string constants
- [ ] `selectKnowledgeCards("validate my agents")` includes `'diagnostics-workflow'` in `selectedIds`
- [ ] `selectKnowledgeCards("show me performance metrics")` includes `'analytics-workflow'`
- [ ] `selectKnowledgeCards("configure OAuth")` includes `'tool-integration-workflow'`
- [ ] All 8 golden corpus domain scenarios pass (card selection + prompt content)
- [ ] Existing 30+ golden corpus scenarios still pass (no regression)
- [ ] Token budget test passes at 6000 threshold

**Test Strategy**:

- Unit: `selectKnowledgeCards()` with domain-specific messages → assert correct card IDs
- Integration: Golden corpus scenarios → assert card content appears in composed prompt

**Rollback**: Delete the 8 new card files. Revert `card-router.ts` (remove imports, registry entries, restore constant). Revert `index.ts` and test files.

---

### Phase 2: Generalist Prompt + Composition Change

**Goal**: Create the generalist prompt and update `composeInProjectPrompt` to use it instead of specialist lookup.

**Tasks**:

2.1. Create `packages/arch-ai/src/prompts/specialists/in-project-generalist.ts`:

- Export `IN_PROJECT_GENERALIST_PROMPT` as a template literal string
- Content derived from `ABL_CONSTRUCT_EXPERT_PROMPT` but:
  - Generic identity: "You are Arch AI, the project assistant" (not "You are the ABL Construct Expert")
  - Keep: Tool overview (brief list of all 25 tools with one-line descriptions)
  - Keep: Agent modification workflow (mandatory steps — this is the core IN_PROJECT workflow)
  - Keep: Key rules (propose before apply, sections vs updatedCode, etc.)
  - Strip: ABL syntax reference (already in construct cards; too large for base prompt)
  - Strip: Domain-specific tool lists (now in domain cards)
- Target size: ~800-1200 tokens

  2.2. Update `composeInProjectPrompt()` in `prompts/index.ts`:

- Import `IN_PROJECT_GENERALIST_PROMPT`
- Replace `SPECIALIST_PROMPTS[specialist]` lookup with `IN_PROJECT_GENERALIST_PROMPT` constant
- Keep the `specialist` parameter in the signature (D-3 — backward compat)
- Add JSDoc deprecation note on the `specialist` parameter

  2.3. Update `prompts.test.ts`:

- `composeInProjectPrompt('diagnostician')` should NOT contain "You are the Diagnostician"
- `composeInProjectPrompt('abl-construct-expert')` should contain "Arch AI" (or equivalent generalist identity)
- Different specialist IDs should produce the SAME base prompt (only cards differ based on userMessage)
- Existing `composeSystemPrompt` tests (ONBOARDING) must still pass unchanged

**Files Touched**:

- `packages/arch-ai/src/prompts/specialists/in-project-generalist.ts` — NEW
- `packages/arch-ai/src/prompts/index.ts` — MODIFY (import + composition change)
- `packages/arch-ai/src/__tests__/prompts.test.ts` — MODIFY (update assertions)

**Exit Criteria**:

- [ ] `pnpm build --filter=@agent-platform/arch-ai` succeeds with 0 errors
- [ ] `composeInProjectPrompt('diagnostician', undefined, 'validate agents')` does NOT contain "You are the Diagnostician"
- [ ] `composeInProjectPrompt('abl-construct-expert', undefined, 'hello')` contains generalist identity string
- [ ] `composeInProjectPrompt('diagnostician', undefined, 'validate agents')` contains diagnostics card content (from Phase 1 cards)
- [ ] `composeSystemPrompt('onboarding', 'INTERVIEW')` still contains ONBOARDING specialist prompt (regression check)
- [ ] All existing golden corpus prompt content tests still pass
- [ ] `prompts.test.ts` updated tests pass

**Test Strategy**:

- Unit: `composeInProjectPrompt()` with various specialist IDs → assert generalist identity, no specialist persona
- Integration: Golden corpus prompt content tests → assert domain knowledge present via cards

**Rollback**: Delete `in-project-generalist.ts`. Revert `prompts/index.ts` to use `SPECIALIST_PROMPTS[specialist]`. Revert test changes.

---

### Phase 3: Route Handler Update

**Goal**: Remove specialist routing from the IN_PROJECT message path in `route.ts`. Update SSE badge and tool_answer handling.

**Tasks**:

3.1. In `route.ts` IN_PROJECT path (~L4087-4116):

- Remove the `routeByContent` import usage for IN_PROJECT
- Remove the specialist selection logic: `specialist = route(userText)`
- Hardcode: `const specialist: AnySpecialistId = 'abl-construct-expert'`
- Remove the `tool_answer` specialist pinning logic (the `if (msg.type === 'tool_answer')` block that reads `freshSession.metadata.activeSpecialist`)
- Keep `setActiveSpecialist(ctx, session.id, specialist)` — it now always writes `'abl-construct-expert'`

  3.2. Update SSE specialist badge emission (~L4210-4211):

- Replace `const display = SPECIALIST_DISPLAY[specialist]` with a constant: `const display = { name: 'Arch AI', icon: 'brain' }`
- The `SPECIALIST_DISPLAY` import for IN_PROJECT can be cleaned up but isn't required

  3.3. For `tool_answer` resume: the `userText` variable (used for card selection) should be the last real user message from the session history, not the tool answer text. Check if the existing code already handles this — if `msg.type === 'tool_answer'`, `userText` is currently set to `msg.answer` (which is "true"/"false"). Change to: extract the last `message`-type text from `session.metadata.messages` for card selection.

  3.4. Run `npx prettier --write apps/studio/src/app/api/arch-ai/message/route.ts`

**Files Touched**:

- `apps/studio/src/app/api/arch-ai/message/route.ts` — MODIFY (~L4087-4216)

**Exit Criteria**:

- [ ] `pnpm build --filter=apps/studio` succeeds with 0 errors
- [ ] IN_PROJECT message path no longer calls `routeByContent()`
- [ ] SSE specialist event emits `{ name: "Arch AI", icon: "brain" }` for all IN_PROJECT messages
- [ ] `tool_answer` resume does not re-route based on answer text
- [ ] `activeSpecialist` is set to `'abl-construct-expert'` for all IN_PROJECT turns
- [ ] ONBOARDING path in route.ts is untouched — still uses phase machine and specialist routing

**Test Strategy**:

- Integration: POST to message endpoint with different message types → verify SSE events
- Manual: Send messages in Studio chat panel → verify "Arch AI" badge, cross-domain workflow works

**Rollback**: Revert `route.ts` changes. The specialist routing code is restored. Phase 1 and Phase 2 changes remain harmless (cards and generalist prompt exist but aren't used by the reverted routing path).

---

### Phase 4: Test Migration and Validation

**Goal**: Update all existing tests to reflect the new architecture. Add new domain card selection tests.

**Tasks**:

4.1. Update `content-router.test.ts`:

- Keep all existing tests (they test `routeByContent()` which is preserved for ONBOARDING)
- Add a comment block: "These tests validate ONBOARDING routing. IN_PROJECT uses knowledge cards — see domain-card-selection.test.ts"

  4.2. Add new test file `packages/arch-ai/src/__tests__/domain-card-selection.test.ts`:

- Test each domain card is selected for representative messages (INT-1 from test spec)
- Test multi-intent messages load multiple domain cards (UT-3)
- Test boolean tool answers ("true", "false") do NOT trigger domain cards (UT-6)
- Test budget enforcement at 6000 tokens (UT-7)

  4.3. Update `prompts.test.ts` (if not already done in Phase 2):

- Assert `composeInProjectPrompt` with different specialists produces same base identity
- Assert no specialist persona strings leak
- Verify ONBOARDING `composeSystemPrompt` tests unchanged

  4.4. Run full test suite: `pnpm build && pnpm test --filter=@agent-platform/arch-ai`

**Files Touched**:

- `packages/arch-ai/src/__tests__/content-router.test.ts` — MODIFY (add comment)
- `packages/arch-ai/src/__tests__/domain-card-selection.test.ts` — NEW
- `packages/arch-ai/src/__tests__/prompts.test.ts` — MODIFY (if needed)

**Exit Criteria**:

- [ ] All existing tests in `packages/arch-ai` pass (0 failures)
- [ ] New `domain-card-selection.test.ts` passes with 8+ test cases
- [ ] `pnpm build` succeeds across the monorepo
- [ ] `pnpm test --filter=@agent-platform/arch-ai` passes with 0 failures
- [ ] Golden corpus coverage summary shows all 34 card IDs (26 construct + 8 domain) covered

**Test Strategy**:

- Unit: domain-card-selection.test.ts covers UT-3, UT-4, UT-6, UT-7
- Integration: golden corpus covers INT-1, INT-5
- Regression: content-router.test.ts unchanged for ONBOARDING (INT-4)

**Rollback**: Delete `domain-card-selection.test.ts`. Revert test file modifications.

---

## 4. Wiring Checklist

- [x] New card constants exported from `knowledge/index.ts` — Phase 1, task 1.5
- [x] New card entries registered in `CARD_REGISTRY` in `card-router.ts` — Phase 1, task 1.3
- [x] New generalist prompt imported in `prompts/index.ts` — Phase 2, task 2.2
- [x] `composeInProjectPrompt` uses generalist prompt — Phase 2, task 2.2
- [ ] ~~New routes registered~~ — N/A, no new routes
- [ ] ~~New models added to database~~ — N/A, no new models
- [x] New types exported from package index — N/A, no new types (existing types reused)
- [ ] ~~New middleware~~ — N/A
- [ ] ~~New workers~~ — N/A
- [ ] ~~UI components~~ — N/A, no UI changes
- [ ] ~~OpenAPI spec~~ — N/A, no new endpoints

---

## 5. Cross-Phase Concerns

### Database Migrations

None. No schema changes. `activeSpecialist` field reused with different values.

### Feature Flags

None. Internal architecture change — no user-facing toggle needed.

### Configuration Changes

| Change                             | File                                               | Value  |
| ---------------------------------- | -------------------------------------------------- | ------ |
| `MAX_KNOWLEDGE_TOKENS` 4000 → 6000 | `packages/arch-ai/src/knowledge/card-router.ts:51` | `6000` |

---

## 6. Acceptance Criteria (Whole Feature)

- [ ] All 4 phases complete with exit criteria met
- [ ] `pnpm build` succeeds across the monorepo (0 errors)
- [ ] `pnpm test --filter=@agent-platform/arch-ai` passes (0 failures)
- [ ] All 38+ golden corpus scenarios pass (30 existing + 8 new domain)
- [ ] IN_PROJECT messages emit SSE `specialist: { name: "Arch AI" }` — not variable specialist names
- [ ] `composeInProjectPrompt` produces generalist prompt for all specialist IDs
- [ ] `routeByContent()` still works (ONBOARDING regression)
- [ ] `tool_answer` resume uses conversation context for cards, not answer text
- [ ] Feature spec §17 coverage matrix updated with actual test file paths
- [ ] No regressions in existing content-router or prompt tests

---

## 7. Open Questions

1. **Generalist prompt ABL syntax**: The `ABL_CONSTRUCT_EXPERT_PROMPT` includes the full ABL syntax reference (`ABL_CONSTRUCT_EXPERT_SYNTAX`), which is ~800 tokens. Should the generalist prompt include this, or rely on construct-level cards (which already cover specific syntax topics like flow-steps, CEL, templates)?

   **Recommendation**: Omit the full syntax from the generalist prompt. The card system already provides syntax knowledge when relevant keywords trigger construct cards. Including it in the base prompt wastes ~800 tokens on every turn.

2. **tool_answer userText source**: Task 3.3 says to extract the last user message from session history for card selection during tool_answer resume. The session stores up to 200 messages. Should we use the last `type: 'message'` entry, or the message that triggered the current pending interaction?

   **Recommendation**: Use the message that triggered the pending interaction — it's the most relevant context for card selection. This may require storing the original userText in `pendingInteraction` metadata.

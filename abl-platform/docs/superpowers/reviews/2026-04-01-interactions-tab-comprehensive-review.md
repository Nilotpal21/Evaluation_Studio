# Interactions Tab — Comprehensive Review

> **Scope:** Entire Interactions tab in Observatory debug panel (28 files, ~3,200 LOC)
> **Branch:** `KI0326/feature/debug-log-interactions`
> **Date:** 2026-04-01
> **Reviewer:** Automated 5-aspect analysis (Architecture, Gaps, Code Quality, UX, SDLC)

---

## 1. Executive Summary

The Interactions tab transforms ~80 flat runtime trace events into a structured, turn-by-turn debug narrative with 14 step types, lifecycle banners, session resolution, and rich sub-components (token grids, memory diffs, swim lanes, guardrail panels, flow breadcrumbs). The architecture is clean — a single `event-processor.ts` pipeline with pure functions, well-separated types, and focused React components using design tokens consistently.

**Key strengths:** Strong separation of concerns, contract test preventing drift, rich step-specific visualizations, good accessibility basics (aria-labels, keyboard), consistent design token usage.

**Key concerns:** No unit tests for the core event processor, 14 `as string` casts indicating a type system gap, InteractionStep.tsx at 776 lines, voice events all dumped into generic 'decision', no feature spec/HLD/test spec per SDLC requirements.

---

## 2. Architecture & Design Review

### Strengths

- **Clean data pipeline**: `ExtendedTraceEvent[] → processEventsToInteractions() → ProcessedInteractions` — single entry point, pure functions, no side effects
- **Discriminated union timeline**: `InteractionCard.tsx:121-141` — elegant `TimelineItem = { kind: 'step' } | { kind: 'banner' }` interleaving with timestamp sort
- **Cross-package contract**: `RUNTIME_EVENT_TYPES` in shared-kernel + contract test ensures studio/runtime stay in sync
- **Separation**: Types (`types.ts`), constants (`constants.ts`), processing (`event-processor.ts`), and rendering (components) are cleanly separated
- **ErrorBoundary**: Wraps entire tab with recovery button and error details
- **Performance guards**: `event-processor.ts:65-69` warns at >500 events, `event-processor.ts:97-101` warns at >100ms processing

### Findings

#### HIGH — `as string` casts indicate type system gap

**Files:** `event-processor.ts:112,237,389,423,424,429,435,439,443` (14 instances)

Event types like `correction_invalidation`, `dsl_on_input`, `constraint_backtrack` etc. are valid runtime events but aren't in `ExtendedTraceEvent.type` union. The casts work but bypass TypeScript's exhaustiveness checking.

**Fix:** Add missing event types to `TraceEventType` union in `apps/studio/src/types/` or create a broader `RuntimeEventType` union re-exported from shared-kernel.

#### HIGH — `InteractionCard.tsx:112-173` IIFE in render

The timeline interleaving logic runs inside an immediately-invoked function expression in JSX. This re-executes on every render (no memoization). For interactions with many steps+banners, this is wasteful.

**Fix:** Extract to a `useMemo` call.

#### MEDIUM — `event-processor.ts` groupByUserMessage can create 0-step interactions

`groupByUserMessage` creates groups, then `buildInteraction` produces interactions, then a filter removes "pure-init" ones. A simpler approach would skip empty groups during grouping.

#### MEDIUM — `enrichResponseContent` index tracking is fragile

`InteractionsTab.tsx:131-166` — The `assistantIdx` counter assumes 1:1 correspondence between interaction response steps and assistant messages. Multi-response interactions or missed messages will cause index drift.

#### LOW — Duplicate `formatDuration` functions

`InteractionStep.tsx:757`, `InteractionCard.tsx:182`, `SessionHeader.tsx:89`, `SessionResolutionFooter.tsx:53` — Four identical copies. Should be a shared utility.

---

## 3. Completeness & Gap Analysis

### Coverage Matrix

| Category          | Event Count | Mapping      | Labels | Rendering                           | Data Extraction |
| ----------------- | ----------- | ------------ | ------ | ----------------------------------- | --------------- |
| User Input        | 1           | ✅           | ✅     | ✅                                  | ✅              |
| LLM               | 1           | ✅           | ✅     | ✅ (TokenGrid)                      | ✅              |
| Tool Call         | 3           | ✅           | ✅     | ✅ (ToolCallContent)                | ✅              |
| Flow              | 3           | ✅           | ✅     | ✅ (TransitionEval, FlowBreadcrumb) | ✅              |
| Gather/Extraction | 12          | ✅           | ✅     | ✅ (GatherConfidence)               | ✅              |
| Decisions         | 13          | ✅           | ✅     | ✅ (DecisionContent)                | ✅              |
| Agent Response    | 3           | ✅           | ✅     | ✅                                  | ✅              |
| Errors/Warnings   | 5           | ✅           | ✅     | ✅                                  | ✅              |
| Hooks/Actions     | 2           | ✅           | ✅     | ⚠️ (maps to tool_call)              | Partial         |
| Escalation        | 3           | ✅           | ✅     | ⚠️ (maps to decision)               | Partial         |
| **Voice**         | **10**      | ✅           | ✅     | **⚠️ (all map to decision)**        | **Minimal**     |
| Memory            | 11          | ✅           | ✅     | ✅ (MemoryDiff)                     | ✅              |
| Lifecycle         | 5           | ✅ (banners) | ✅     | ✅ (LifecycleBanner)                | ✅              |
| Session           | 4           | ✅ (footer)  | ✅     | ✅ (SessionResolutionFooter)        | ✅              |
| Guardrails        | 17          | ✅           | ✅     | ✅ (GuardrailPanel/Compact)         | ✅              |
| Parallel          | 6           | ✅           | ✅     | ✅ (SwimLaneTimeline)               | ✅              |

### Gaps Found

#### HIGH — Voice events (10) all render as generic decisions

`constants.ts:145-155` — All voice events (`voice_session_start`, `voice_stt`, `voice_tts`, `voice_barge_in`, etc.) map to `'decision'` step type. They show as "Decision" cards with no voice-specific visualization. The `extractStepData` decision case doesn't extract voice-specific fields (`transcription`, `audioUrl`, `duration`, `language`, `provider`).

**Impact:** Voice debugging experience is poor — developers can't see STT transcriptions, TTS output, barge-in timing, or ASR quality scores.

**Fix:** Either create a `voice` step type with dedicated rendering, or add voice-specific sub-type detection in `DecisionContent`.

#### HIGH — `behavior_profile_applied` mapped to decision

`constants.ts:155` — This event represents a configuration action, not a decision. It carries profile data (`profileName`, `settings`, `overrides`) but renders as a generic decision card.

**Fix:** Map to `tool_call` (like other hook/action events) or create a dedicated step type.

#### MEDIUM — `hook_executed` and `action_handler_executed` lose context

`constants.ts:136-137` — Mapped to `tool_call`, but `extractStepData` tool_call case extracts `tool`, `input`, `result`, `status`. Hook events carry different fields: `hookName`, `hookType`, `trigger`, `duration`. These are silently lost.

**Fix:** Add hook-specific field extraction in `extractStepData` tool_call case or `mergeStepData`.

#### MEDIUM — Contract test doesn't cover EVENT_LABELS drift

`trace-event-contract.test.ts` — Verifies every RUNTIME_EVENT_TYPES entry has a mapping in EVENT_TO_STEP/LIFECYCLE/SESSION. But doesn't verify EVENT_LABELS has labels for all mapped events. A new event could be added to EVENT_TO_STEP without a label.

**Fix:** Add a fourth test: every key in EVENT_TO_STEP must exist in EVENT_LABELS.

#### MEDIUM — Traces tab EVENT_TYPE_LABELS has events not in Interactions EVENT_LABELS

`observatory-event-presentation.ts` has: `session_start`, `session_end`, `gather_extraction`, `tool_result`, `guardrail_check`, `guardrail_violation`, `guardrail_warning`. Some of these are mapped in EVENT_TO_STEP but may not have labels in Interactions tab.

#### LOW — `parallel_tools` step type has no event source in RUNTIME_EVENT_TYPES

`fan_out_start`, `fan_out_task_start`, etc. are in EVENT_TO_STEP but NOT in RUNTIME_EVENT_TYPES. The contract test doesn't catch this because it only checks the reverse direction.

---

## 4. Code Quality & Patterns Review

### File-by-File Summary

| File                          | Lines | Assessment                                    |
| ----------------------------- | ----- | --------------------------------------------- |
| `types.ts`                    | 113   | ✅ Clean, well-typed                          |
| `constants.ts`                | 395   | ✅ Well-organized, complete                   |
| `event-processor.ts`          | 619   | ⚠️ Good logic, but 14 `as string` casts       |
| `InteractionsTab.tsx`         | 167   | ✅ Clean root component                       |
| `InteractionCard.tsx`         | 186   | ⚠️ IIFE in render should be memoized          |
| `InteractionStep.tsx`         | 776   | ⚠️ Large — 4 internal components, could split |
| `SessionHeader.tsx`           | 94    | ✅ Clean                                      |
| `SessionResolutionFooter.tsx` | 105   | ✅ Clean                                      |
| `LifecycleBanner.tsx`         | 60    | ✅ Clean                                      |
| `AgentSwitchBanner.tsx`       | 36    | ✅ Clean                                      |
| `ErrorBoundary.tsx`           | 67    | ✅ Good, has recovery UI                      |
| `StepBadge.tsx`               | 36    | ✅ Clean                                      |
| `TokenGrid.tsx`               | 124   | ✅ Good accessibility (aria-labels)           |
| `TokenBadge.tsx`              | 64    | ✅ Clean, exported pure function              |
| `ContextWindowBar.tsx`        | 50    | ✅ Clean                                      |
| `MemoryDiff.tsx`              | 240   | ✅ Excellent — exported pure function + JSDoc |
| `DiffLine.tsx`                | 112   | ✅ Clean                                      |
| `GatherConfidence.tsx`        | 272   | ✅ Good field extraction logic                |
| `GuardrailPanel.tsx`          | 200   | ✅ Good, exported pure function               |
| `GuardrailCompact.tsx`        | 64    | ✅ Clean                                      |
| `SwimLaneTimeline.tsx`        | 237   | ✅ Good — parallel detection + swim lane viz  |
| `RetryBadge.tsx`              | 72    | ✅ Clean                                      |
| `FlowBreadcrumb.tsx`          | 174   | ✅ Good, exported pure function               |
| `MiniFlowGraph.tsx`           | 124   | ✅ Clean                                      |
| `VariableResolution.tsx`      | 91    | ✅ Clean                                      |
| `TransitionEvaluation.tsx`    | 130   | ✅ Clean                                      |
| `index.ts`                    | 38    | ✅ Comprehensive barrel                       |

### Good Patterns (Keep)

1. **Exported pure functions** — `computeMemoryDiff`, `extractGuardrailChecks`, `detectParallelTools`, `extractFlowSteps`, `aggregateTokens` are all testable without React
2. **Design token consistency** — Every component uses `getIntentStyles()` or `getBadgeIntentStyles()` from `@agent-platform/design-tokens`
3. **Progressive disclosure** — Expand/collapse on decisions, tool calls, memory reads, raw events
4. **JSDoc on public functions** — `computeMemoryDiff`, `extractGuardrailChecks`, `detectParallelTools` all have full JSDoc with examples
5. **Config objects** — `STEP_CONFIG`, `BANNER_CONFIG`, `DIFF_CONFIG`, `NODE_CONFIG`, `STATE_CONFIG` centralize visual config
6. **Semantic ARIA** — `InteractionCard` button has `aria-expanded` + `aria-label`, TokenGrid has `aria-label`, MemoryDiff has `aria-expanded`

### Anti-Patterns (Fix)

#### HIGH — InteractionStep.tsx at 776 lines with 4 internal components

Contains: `InteractionStep`, `RawEventsPanel`, `RawEventBlock`, `DecisionContent`, `ToolCallContent`, plus utilities. The Decision and ToolCall components are 200+ lines each with their own state.

**Fix:** Extract `DecisionContent` → `DecisionStep.tsx` and `ToolCallContent` → `ToolCallStep.tsx`.

#### MEDIUM — `Record<string, unknown>` for step data

`InteractionStep.data` is `Record<string, unknown>`. Every consumer does `step.data.foo as SomeType`. This is type-unsafe.

**Fix:** Use discriminated union: `{ type: 'llm_call'; data: LLMCallData } | { type: 'tool_call'; data: ToolCallData } | ...`

#### MEDIUM — Event array index as React key

`RawEventsPanel` at `InteractionStep.tsx:111` uses `key={i}` for events. If events reorder, React will misidentify them.

**Fix:** Use `key={evt.id}`.

#### LOW — `console.error` in ErrorBoundary

`ErrorBoundary.tsx:31` — `console.error('[InteractionsTab] Error boundary caught:', error, errorInfo)`. Per CLAUDE.md, server code should use `createLogger`. However, this is client-side React code where `console.error` is acceptable in error boundaries.

#### LOW — Unused `styles.text` check in LifecycleBanner

`LifecycleBanner.tsx:50` — `className={clsx('flex items-center gap-2 h-6 my-1', styles.text ? '' : '')}` — the ternary always resolves to `''`. Dead code.

---

## 5. UX & Interaction Design Review

### Strengths

1. **Turn-by-turn narrative** — Groups events by user message, creating natural conversation flow
2. **Status at a glance** — Color-coded dots (green/amber/red) on each interaction card
3. **Progressive disclosure** — Default collapsed, first interaction expanded, details on click
4. **Token visibility** — Token count + cost visible in interaction header without expanding
5. **Memory diff** — Git-style diff view (added/changed/removed) is developer-friendly
6. **Flow breadcrumb** — Scripted agent flow steps with visited/active/upcoming states
7. **Parallel tool viz** — Swim lane timeline with time savings calculation
8. **Copy cURL** — Tool call step has "Copy as cURL" for easy replay

### Findings

#### HIGH — Voice events show as generic "Decision" cards

10 voice events render with generic decision UI — no voice-specific information. A developer debugging voice issues would see "Voice Session Started" as a decision label with no transcription, audio quality, or timing data.

#### HIGH — No search/filter capability

With 80+ event types producing many steps, developers can't filter by step type, search for specific content, or jump to errors. The Traces tab has filtering; Interactions doesn't.

#### MEDIUM — Agent switch banner placement

`InteractionsTab.tsx:84` — Agent switch banners appear BEFORE the interaction card. With many interactions, it's unclear which interaction the switch relates to. Consider integrating into the card header.

#### MEDIUM — No "jump to error" affordance

When a session has errors, users must scroll through all interactions to find them. A quick-link or red badge in the session header would help.

#### MEDIUM — Decision content can be overwhelming

`DecisionContent` shows: label, outcome badge, guardrail kind, from→target, agent, trigger details, condition, field, violation, reason, then dynamic extra metadata. For complex decisions, this is a wall of small text.

**Fix:** Group related fields, add visual hierarchy (headers for "Routing", "Guardrail", "Condition" sections).

#### LOW — Empty state could be more helpful

`InteractionsTab.tsx:64-70` — "No interactions recorded / Start a conversation to see the timeline" — doesn't suggest checking if tracing is enabled or if the session has events in the Traces tab.

---

## 6. SDLC & Testing Compliance Audit

### SDLC Artifact Checklist

| Phase               | Artifact                           | Status         | Location                                                             |
| ------------------- | ---------------------------------- | -------------- | -------------------------------------------------------------------- |
| Design Spec         | Event mapping contract design      | ✅             | `docs/superpowers/specs/2026-04-01-event-mapping-contract-design.md` |
| Implementation Plan | Event mapping contract plan        | ✅             | `docs/superpowers/plans/2026-04-01-event-mapping-contract.md`        |
| Feature Spec        | Full interactions tab feature spec | ❌ MISSING     | —                                                                    |
| Test Spec           | Test scenarios document            | ❌ MISSING     | —                                                                    |
| HLD                 | High-level design                  | ❌ MISSING     | —                                                                    |
| LLD                 | Low-level design                   | ❌ MISSING     | —                                                                    |
| Post-Impl Sync      | Doc sync after implementation      | ❌ NOT RUN     | —                                                                    |
| Feature Status      | PLANNED→ALPHA→BETA→STABLE          | ❌ NOT TRACKED | —                                                                    |

### Test Coverage Assessment

#### Existing Tests

| Test File                              | Coverage                                 |
| -------------------------------------- | ---------------------------------------- |
| `interactions-event-processor.test.ts` | Core event→step processing               |
| `interactions-memory-diff.test.ts`     | computeMemoryDiff                        |
| `interactions-token-guard.test.ts`     | Token aggregation + guardrail extraction |
| `interactions-parallel-detect.test.ts` | detectParallelTools                      |
| `interactions-flow-dsl.test.ts`        | extractFlowSteps                         |
| `trace-event-contract.test.ts`         | Cross-package registry sync              |

#### Missing Tests (CRITICAL per CLAUDE.md)

Per CLAUDE.md: "minimum 5 E2E + 5 integration test scenarios per feature"

- **0 E2E tests** — No browser-level tests for the Interactions tab rendering
- **0 integration tests** — No tests for InteractionsTab component with real observatory store
- **0 component render tests** — No tests for InteractionCard, InteractionStep, SessionHeader, etc.
- **No tests for enrichResponseContent** — Fragile index-tracking logic untested
- **No tests for groupByUserMessage** — Edge cases (no user messages, multiple consecutive) untested
- **No EVENT_LABELS coverage test** — Contract test doesn't verify labels

#### Required Test Scenarios (E2E)

1. Load session with trace events → verify interactions render with correct step counts
2. Click interaction card → verify expand/collapse with animation
3. Session with errors → verify red status dots and error step rendering
4. Multi-agent session → verify agent switch banners appear
5. Session with voice events → verify they render (even as decisions)

#### Required Test Scenarios (Integration)

1. processEventsToInteractions with real multi-turn event data → verify grouping
2. enrichResponseContent with edge cases (empty messages, multiple responses)
3. groupByUserMessage with pre-user events (welcome message scenario)
4. classifyStepsAndBanners with lifecycle events mixed with step events
5. buildResolution with various session_resolution outcomes

### Commit History Audit

Recent commits on this branch follow good discipline:

- ✅ One concern per commit (each of 13 tasks is its own commit)
- ✅ Commit message format: `[ABLP-2] type(scope): description`
- ✅ Feature commits are additive (no deletions of existing exports)
- ⚠️ All commits use `ABLP-2` — this may be a blanket ticket rather than feature-specific

---

## 7. Prioritized Action Items

### CRITICAL (Must Fix)

1. **Add E2E tests** — Minimum 5 browser tests per CLAUDE.md SDLC requirements
2. **Add integration tests** — Minimum 5 component integration tests
3. **Fix `as string` casts** — Add missing event types to `TraceEventType` union or use shared-kernel `RuntimeEventType`

### HIGH (Should Fix)

4. **Voice step type** — Create dedicated voice step type or voice-specific rendering in decision
5. **Contract test for EVENT_LABELS** — Add test verifying every EVENT_TO_STEP key has a label
6. **Memoize timeline interleaving** — `InteractionCard.tsx:112-173` IIFE → useMemo
7. **Split InteractionStep.tsx** — Extract DecisionContent and ToolCallContent to own files
8. **Hook/action data extraction** — Add hook-specific fields to extractStepData

### MEDIUM (Should Address)

9. **Typed step data** — Replace `Record<string, unknown>` with discriminated union per step type
10. **Search/filter capability** — Add step type filter and text search
11. **Jump to error** — Quick navigation to error interactions from session header
12. **`enrichResponseContent` robustness** — Handle multi-response and index drift edge cases
13. **Extract shared `formatDuration`** — Deduplicate across 4 files
14. **Add fan_out events to RUNTIME_EVENT_TYPES** — Currently in EVENT_TO_STEP but not in registry
15. **Create feature spec** — `docs/features/interactions-tab.md` per SDLC requirements
16. **Run /post-impl-sync** — Update all SDLC docs to reflect implementation

### LOW (Nice to Have)

17. **Fix React key in RawEventsPanel** — Use `evt.id` instead of array index
18. **Remove dead code** — `LifecycleBanner.tsx:50` empty ternary
19. **Better empty state** — Suggest checking trace enablement
20. **Decision content grouping** — Visual hierarchy for complex decisions
21. **`behavior_profile_applied` mapping** — Move from decision to tool_call or dedicated type

# Observatory Session Debugger Redesign — High-Level Design

**Date**: 2026-03-22
**Status**: Proposed
**Feature Doc**: `docs/features/sub-features/observatory-session-debugger.md`
**LLD**: `docs/specs/observatory-session-debugger-redesign.lld.md`
**Implementation Plan**: `docs/plans/2026-03-22-observatory-session-debugger-redesign-plan.md`

---

## What

Redesign the Studio Observatory session debugger around one observability domain model for live and replayed traces. The redesign covers the Traces tab, span tree, waterfall summary, detail panel, and the selection bridge points used by the session detail experience.

This is not a cosmetic cleanup. It is an architectural redesign to remove the verified causes of flakiness:

1. duplicated event ownership across `observatory-store` and `trace-store`
2. overloaded selection IDs spread across `ui-store`, `observatory-store`, and `trace-store`
3. duplicated cost/token derivation in multiple components
4. heuristic span lifecycle closure for flow steps
5. view components deriving their own trees and summaries instead of consuming one shared view model

---

## Why Now

The boundary groundwork is now in place:

- `apps/studio/src/utils/trace-event-adapter.ts` preserves canonical top-level IDs
- `apps/studio/src/utils/live-trace-event-ingestion.ts` gives live WebSocket ingestion an explicit seam
- the Studio split test runner keeps pure Observatory logic/store suites out of the flaky full browser harness

That means the current risk is no longer the raw trace payload shape. The remaining instability is almost entirely Studio-side state ownership and rendering architecture.

---

## Verified Current Problems

| Problem                                   | Verified Current Cause                                                                             | User Impact                                           |
| ----------------------------------------- | -------------------------------------------------------------------------------------------------- | ----------------------------------------------------- |
| Dual detail views for one span selection  | `SpanTree` renders inline detail while `DebugTabs` also opens `NodeDetailPanel`                    | split focus, reduced viewport, clipped content        |
| Triplicate cost/token computation         | `SpanTree`, `DebugTabs`, and `NodeDetailPanel` each aggregate metrics differently                  | mismatched totals between views                       |
| Selection state split across three stores | `ui-store.selectedTraceNodeId`, `observatory-store.selectedEventId`, `trace-store.selectedEventId` | wrong detail targets, dead state, hard-to-reason bugs |
| Dual event stores with divergent behavior | `trace-store` and `observatory-store` both receive live events but normalize/filter differently    | live-vs-replay drift and duplicate ownership          |
| Fragile `flow_step_exit` handling         | global `getActiveSpan()` + `name.includes(stepName)`                                               | wrong span closes under concurrency or repeated names |
| `WaterfallPanel` summary/tree mismatch    | panel receives summaries, but `SpanTree` ignores them and reads store directly                     | totals do not match visible rows                      |
| Keyboard nav ignores collapse state       | tree flattens all descendants, visible or not                                                      | ghost selection under collapsed nodes                 |
| Stale span tree memoization               | `useMemo(() => getSpanTree(), [getSpanTree])` memoizes on a stable function reference              | stale parent/child hierarchy                          |
| In-place normalization mutation           | decision normalization mutates `event.data` by reference                                           | cross-consumer shape drift                            |

Root cause: **there is no single source of truth for Observatory state or derived view models**.

---

## Architecture Goals

1. **Single ownership**: one feature store owns Observatory events, spans, selection, and expand/collapse state.
2. **Normalize once**: trace normalization happens at the ingestion edge and produces immutable event objects.
3. **Deterministic lifecycle**: span start/end behavior is driven by exact registries, not string matching or global stack heuristics.
4. **Selectors own derivation**: tree shape, metrics, and detail view models are derived centrally, not inside components.
5. **Presentational rendering**: components render props and dispatch actions, but stop re-implementing domain logic.
6. **Incremental migration**: the redesign ships behind compatibility facades rather than a one-shot rewrite.

---

## Proposed Architecture

### 1. Observatory Feature Module

Create a dedicated Studio feature module:

```text
apps/studio/src/features/observatory/
  model.ts
  normalization.ts
  span-registry.ts
  metrics.ts
  selectors.ts
  store.ts
  actions.ts
  index.ts
```

Legacy entry points remain during migration:

- `apps/studio/src/store/observatory-store.ts`
- `apps/studio/src/store/trace-store.ts`
- `apps/studio/src/store/ui-store.ts`
- `apps/studio/src/utils/trace-event-adapter.ts`
- `apps/studio/src/utils/live-trace-event-ingestion.ts`

Those files should become thin compatibility layers or re-exports until consumers are fully migrated.

### 2. State Ownership

#### Observatory Feature Store Owns

- normalized events
- ordered event IDs
- spans and parent/child references
- active agent span stacks
- active step span stacks
- Observatory-specific selection
- expanded span IDs
- derived execution graph backing state, if still required

#### Other Stores Do Not Own

- duplicate copies of Observatory events
- generic `selectedTraceNodeId`
- redundant `selectedEventId` fields that have no live UI consumer

### 3. Explicit Selection Model

The redesign should stop pretending one opaque string can represent every selected entity in the session debugger.

Target shape:

```ts
interface ObservatorySelectionState {
  activeSpanId: string | null;
  activeEventId: string | null;
  activeExecutionNodeId: string | null;
}
```

This is intentionally not a single overloaded ID. The problem is scattered ownership, not the existence of more than one well-scoped selection field.

### 4. Deterministic Span Registry

Replace `getActiveSpan()` heuristics with explicit stacks:

```ts
activeAgentSpanIdsByAgent: Map<string, string[]>;
activeStepSpanIdsByAgentStep: Map<string, string[]>;
```

Key behavior:

- `agent_enter` pushes onto the agent's active span stack
- `agent_exit` closes the exact current span for that agent
- `flow_step_enter` pushes onto the `(agentName, stepName)` stack
- `flow_step_exit` pops the exact current span for that `(agentName, stepName)` key

This supports repeated step names, nested flows, and concurrent agents without substring matching.

### 5. Shared Selectors

Selectors become the only place where the debugger derives:

- span tree
- visible span tree
- visible span IDs for keyboard navigation
- session summary metrics
- selected span detail metrics
- selected event detail models

Cost and token totals are defined once:

- `cost`: sum of `llm_call` cost only
- `tokens`: sum of `llm_call` prompt/completion tokens only
- non-LLM events may still expose raw event payloads, but do not change LLM metrics

### 6. Pure UI Composition

Target component roles:

| Component                            | Target Role                                                           |
| ------------------------------------ | --------------------------------------------------------------------- |
| `DebugTabs`                          | container that wires selectors into the Traces tab                    |
| `WaterfallPanel`                     | presentational summary + tree shell; no store reads                   |
| `SpanTree`                           | presentational tree; no inline details, no store reads                |
| `NodeDetailPanel`                    | canonical detail surface for selected span/event                      |
| `OverviewTab` / `AgentExecutionTree` | explicit execution-node selection and optional "jump to span" actions |

### 7. Data Flow

```text
Live WS trace_event / replay payload
  -> boundary normalizer (immutable)
  -> observatory feature actions
  -> observatory feature store
  -> selectors
  -> TracesTab / SpanTree / NodeDetailPanel / Overview bridge
```

No component should rebuild trace-domain facts from raw span events on its own.

---

## Key Decisions

| #   | Decision                         | Chose                                                    | Over                                                           | Because                                                        |
| --- | -------------------------------- | -------------------------------------------------------- | -------------------------------------------------------------- | -------------------------------------------------------------- |
| D-1 | One Observatory feature store    | single ownership                                         | duplicated `trace-store` + `observatory-store` event ownership | duplicated event state is the root of live-vs-replay drift     |
| D-2 | Explicit selection slots         | `activeSpanId`, `activeEventId`, `activeExecutionNodeId` | one overloaded raw ID                                          | one field cannot safely represent three entity domains         |
| D-3 | Deterministic span stacks        | map of stacks by agent / agent+step                      | global `getActiveSpan()` + substring matching                  | concurrency and repeated step names require exact scope        |
| D-4 | Shared selectors for metrics     | one selector layer                                       | per-component aggregation                                      | metric drift between tree, summary, and panel is a product bug |
| D-5 | Single detail surface            | keep `NodeDetailPanel`                                   | dual inline + docked detail views                              | one selection should produce one inspection surface            |
| D-6 | Visible-only keyboard navigation | flatten visible nodes only                               | flatten full tree regardless of collapse                       | hidden selections break usability and trust                    |
| D-7 | Incremental strangler migration  | compatibility facades first                              | one-shot rewrite                                               | lower risk, easier verification, smaller PRs                   |
| D-8 | Immutable boundary normalization | clone and normalize once                                 | mutating raw payload objects in stores                         | mutation bleeds across consumers and makes debugging stateful  |

---

## Migration Strategy

### Phase A: Groundwork (already landed)

- canonical trace-event adapter
- live trace ingestion seam
- split test runner for pure Observatory suites

### Phase B: Feature Module Foundation

- introduce `src/features/observatory/`
- move normalization, selection, registry, and selectors behind the feature boundary
- keep legacy stores as compatibility facades

### Phase C: UI Cutover

- cut `DebugTabs`, `WaterfallPanel`, `SpanTree`, and `NodeDetailPanel` over to selectors
- remove inline tree detail rendering
- move keyboard navigation to visible-node selectors

### Phase D: Cleanup

- remove duplicated event ownership from `trace-store`
- remove selection ownership from `ui-store`
- delete dead `selectedEventId` paths and redundant metric helpers

---

## Acceptance Criteria

1. A live trace payload and its replayed equivalent produce the same span tree and summary metrics.
2. `flow_step_exit` closes the correct span even with concurrent agents and repeated step names.
3. The Traces tab shows exactly one detail surface for a span selection.
4. Summary bar totals, tree row totals, and detail panel totals match for the same fixture.
5. Arrow-key navigation never selects a span hidden under a collapsed ancestor.
6. Observatory events are owned by one feature store only.

---

## Risks & Mitigations

| Risk                                                                         | Impact | Mitigation                                                                                               |
| ---------------------------------------------------------------------------- | ------ | -------------------------------------------------------------------------------------------------------- |
| Partial migration leaves old and new stores both writable                    | High   | keep compatibility facades read-through where possible; stop dual writes early                           |
| UI refactor accidentally changes debugger behavior while fixing architecture | Medium | add fixture-based selector parity tests before component cutover                                         |
| Step-span registry assumptions break on unusual runtime payloads             | Medium | keep deterministic fallback rules documented and tested; consider future step-instance IDs               |
| Browser component tests become flaky again                                   | Medium | keep pure logic/store coverage in node/light configs and reserve full DOM runs for targeted interactions |

---

## Out of Scope

- redesigning unrelated Observatory tabs such as Voice or IR beyond the selection/state plumbing they depend on
- changing Runtime's trace emission vocabulary in the same effort
- backfilling or migrating historical ClickHouse trace payloads

---

## References

- `apps/studio/src/store/observatory-store.ts`
- `apps/studio/src/store/trace-store.ts`
- `apps/studio/src/store/ui-store.ts`
- `apps/studio/src/components/observatory/SpanTree.tsx`
- `apps/studio/src/components/observatory/DebugTabs.tsx`
- `apps/studio/src/components/observatory/WaterfallPanel.tsx`
- `apps/studio/src/utils/trace-event-adapter.ts`
- `apps/studio/src/utils/live-trace-event-ingestion.ts`

# Observatory Session Debugger Redesign — Low-Level Design

**HLD Reference**: `docs/specs/observatory-session-debugger-redesign.hld.md`
**Feature Doc**: `docs/features/sub-features/observatory-session-debugger.md`
**Date**: 2026-03-22

---

## Phase 1: Feature Module Foundation

### Task O-1: Create the Observatory feature module

**Package**: `apps/studio`

#### Files to Create

| File                                              | Purpose                                                   |
| ------------------------------------------------- | --------------------------------------------------------- |
| `apps/studio/src/features/observatory/model.ts`   | Canonical Studio-side Observatory types and state shape   |
| `apps/studio/src/features/observatory/store.ts`   | Single-source feature store                               |
| `apps/studio/src/features/observatory/actions.ts` | Pure action helpers for event ingestion and state updates |
| `apps/studio/src/features/observatory/index.ts`   | Barrel exports                                            |

#### State Shape

```ts
interface ObservatoryFeatureState {
  eventsById: Map<string, ExtendedTraceEvent>;
  orderedEventIds: string[];
  spansById: Map<string, Span>;
  selection: {
    activeSpanId: string | null;
    activeEventId: string | null;
    activeExecutionNodeId: string | null;
  };
  expandedSpanIds: Set<string>;
  activeAgentSpanIdsByAgent: Map<string, string[]>;
  activeStepSpanIdsByAgentStep: Map<string, string[]>;
}
```

#### Acceptance Criteria

- one feature store can ingest events, clear session state, and expose selection without touching `ui-store`
- `orderedEventIds` and `eventsById` remain in sync after add/clear operations
- `clearSession` resets spans, events, selection, and active indexes together

---

### Task O-2: Move normalization behind the feature boundary

#### Files to Create / Modify

| File                                                    | What Changes                                                       |
| ------------------------------------------------------- | ------------------------------------------------------------------ |
| `apps/studio/src/features/observatory/normalization.ts` | New home for immutable event normalization                         |
| `apps/studio/src/utils/trace-event-adapter.ts`          | Re-export or thin wrapper to the feature module                    |
| `apps/studio/src/utils/live-trace-event-ingestion.ts`   | Delegate into feature actions                                      |
| `apps/studio/src/utils/replay-trace-events.ts`          | Delegate into feature actions                                      |
| `apps/studio/src/contexts/WebSocketContext.tsx`         | Continue calling the live ingestion seam, not inline normalization |

#### Rules

- normalize once
- clone `data`
- prefer canonical top-level fields first
- keep deterministic fallback IDs
- never mutate `rawEvent.data` in place

#### Acceptance Criteria

- live and replay inputs use the same normalizer
- decision normalization returns new payload objects rather than mutating caller-owned objects
- existing canonical-ID tests keep passing

---

## Phase 2: Deterministic Span Registry

### Task O-3: Extract exact span lifecycle helpers

#### Files to Create / Modify

| File                                                                 | What Changes                                                |
| -------------------------------------------------------------------- | ----------------------------------------------------------- |
| `apps/studio/src/features/observatory/span-registry.ts`              | New pure helpers for span start/end and event attachment    |
| `apps/studio/src/store/observatory-store.ts`                         | Compatibility facade or delegating wrapper during migration |
| `apps/studio/src/store/__tests__/observatory-span-lifecycle.test.ts` | Expand to registry-specific invariants                      |

#### APIs

```ts
function beginAgentSpan(
  state: ObservatoryFeatureState,
  event: ExtendedTraceEvent,
): ObservatoryFeatureState;
function endAgentSpan(
  state: ObservatoryFeatureState,
  event: ExtendedTraceEvent,
): ObservatoryFeatureState;
function beginStepSpan(
  state: ObservatoryFeatureState,
  event: ExtendedTraceEvent,
): ObservatoryFeatureState;
function endStepSpan(
  state: ObservatoryFeatureState,
  event: ExtendedTraceEvent,
): ObservatoryFeatureState;
function attachEventToCurrentSpan(
  state: ObservatoryFeatureState,
  event: ExtendedTraceEvent,
): ObservatoryFeatureState;
```

#### Registry Keys

```ts
const agentKey = agentName;
const stepKey = `${agentName}::${stepName}`;
```

`Map<string, string[]>` is intentionally used instead of `Map<string, string>` so repeated step names and nested entry/exit patterns remain valid.

#### Acceptance Criteria

- `flow_step_exit` never calls a global "latest running span" helper
- repeated step names within one agent pop the most recent matching step span only
- concurrent agents cannot close each other's spans

---

## Phase 3: Shared Selectors And Metrics

### Task O-4: Centralize derived view models

#### Files to Create / Modify

| File                                                         | What Changes                                                   |
| ------------------------------------------------------------ | -------------------------------------------------------------- |
| `apps/studio/src/features/observatory/metrics.ts`            | Shared LLM metric aggregation                                  |
| `apps/studio/src/features/observatory/selectors.ts`          | Shared tree, visible tree, summary, and detail selectors       |
| `apps/studio/src/components/observatory/NodeDetailPanel.tsx` | Stop recomputing LLM metrics inline                            |
| `apps/studio/src/components/observatory/DebugTabs.tsx`       | Stop rebuilding span summaries inline                          |
| `apps/studio/src/components/observatory/SpanTree.tsx`        | Stop computing cost/tokens per component helper                |
| `apps/studio/src/components/observatory/WaterfallPanel.tsx`  | Accept view models instead of recomputing from local summaries |

#### Selector Contracts

```ts
function selectSpanTree(state: ObservatoryFeatureState): SpanTreeNode[];
function selectVisibleSpanTree(state: ObservatoryFeatureState): SpanTreeNode[];
function selectVisibleSpanIds(state: ObservatoryFeatureState): string[];
function selectSessionSummaryMetrics(state: ObservatoryFeatureState): {
  totalCost: number;
  totalTokens: number;
  totalDuration: number;
  errorCount: number;
  spanCount: number;
};
function selectSelectedSpanViewModel(state: ObservatoryFeatureState): SelectedSpanViewModel | null;
```

#### Metric Rules

- `cost` comes only from `llm_call` events
- `promptTokens` and `completionTokens` come only from `llm_call` events
- non-LLM events do not affect LLM totals even if they happen to carry numeric `cost` or token-like payload fields

#### Acceptance Criteria

- summary bar totals, tree row totals, and detail panel totals all come from the same selector outputs
- `WaterfallPanel` no longer passes a summary structure that `SpanTree` ignores

---

## Phase 4: UI Cutover

### Task O-5: Convert Traces tab to master-detail behavior

#### Files to Modify

| File                                                         | What Changes                                        |
| ------------------------------------------------------------ | --------------------------------------------------- |
| `apps/studio/src/components/observatory/DebugTabs.tsx`       | Treat Traces tab as container over shared selectors |
| `apps/studio/src/components/observatory/SpanTree.tsx`        | Remove inline details; render rows only             |
| `apps/studio/src/components/observatory/WaterfallPanel.tsx`  | Render summary + tree from passed view model        |
| `apps/studio/src/components/observatory/NodeDetailPanel.tsx` | Remain canonical detail surface                     |

#### Interaction Changes

- selecting a span opens only `NodeDetailPanel`
- collapsing a node hides descendant rows and descendant keyboard targets
- if a selected descendant becomes hidden, selection re-homes to the nearest visible ancestor or clears

#### Acceptance Criteria

- one span selection renders one detail surface
- tree height no longer shrinks because of an inline duplicate detail block
- keyboard selection remains visible

---

### Task O-6: Separate execution-tree selection from span selection

#### Files to Modify

| File                                                        | What Changes                                                        |
| ----------------------------------------------------------- | ------------------------------------------------------------------- |
| `apps/studio/src/components/session/SessionDetailPage.tsx`  | Stop routing execution-tree selection through `selectedTraceNodeId` |
| `apps/studio/src/components/session/OverviewTab.tsx`        | Read explicit execution-node selection                              |
| `apps/studio/src/components/session/AgentExecutionTree.tsx` | Stop calling `selectSpan(node.id)` for non-span nodes               |
| `apps/studio/src/store/ui-store.ts`                         | Remove `selectedTraceNodeId` ownership after consumers migrate      |

#### Acceptance Criteria

- selecting an execution node does not try to open a span unless there is an explicit "jump to span" action
- blank or mismatched detail panels caused by synthetic execution-tree IDs disappear

---

## Phase 5: Cleanup And Compatibility Removal

### Task O-7: Retire duplicated legacy state

#### Files to Modify

| File                                                 | What Changes                                                    |
| ---------------------------------------------------- | --------------------------------------------------------------- |
| `apps/studio/src/store/trace-store.ts`               | Remove event ownership or delete store after migration          |
| `apps/studio/src/store/observatory-store.ts`         | Reduce to re-export/facade or remove legacy code paths          |
| `apps/studio/src/store/ui-store.ts`                  | Keep only generic shell state                                   |
| `apps/studio/src/__tests__/remaining-stores.test.ts` | Update for new ownership model                                  |
| `apps/studio/src/__tests__/trace-store.test.ts`      | Remove or rewrite assertions tied to duplicated event ownership |

#### Acceptance Criteria

- Observatory event data exists in one store only
- no store retains dead `selectedEventId` state without a consumer
- no component reads Observatory events from `trace-store`

---

## Test Plan Attachments

### New Test Files

| File                                                                           | Purpose                          |
| ------------------------------------------------------------------------------ | -------------------------------- |
| `apps/studio/src/features/observatory/__tests__/selection-state.test.ts`       | explicit selection ownership     |
| `apps/studio/src/features/observatory/__tests__/span-registry.test.ts`         | exact lifecycle behavior         |
| `apps/studio/src/features/observatory/__tests__/metric-selectors.test.ts`      | selector parity                  |
| `apps/studio/src/components/observatory/__tests__/span-tree-keyboard.test.tsx` | visible-only keyboard navigation |
| `apps/studio/src/components/observatory/__tests__/traces-tab-layout.test.tsx`  | single detail surface behavior   |

### Existing Tests To Keep Green

- `apps/studio/src/__tests__/trace-event-adapter.test.ts`
- `apps/studio/src/__tests__/live-trace-event-ingestion.test.ts`
- `apps/studio/src/__tests__/observatory-span-end.test.ts`
- `apps/studio/src/store/__tests__/observatory-span-lifecycle.test.ts`
- `apps/studio/src/__tests__/e2e/observatory-trace-flow.test.ts`

---

## Implementation Notes

- keep the current `trace-event-adapter.ts` and `live-trace-event-ingestion.ts` seams as the migration anchor
- prefer re-export adapters before deleting old files so imports can migrate incrementally
- do not land the selector layer and UI cutover in the same PR as the initial feature-store foundation unless the diff remains easy to verify

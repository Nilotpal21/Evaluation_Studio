# Observatory Session Debugger Redesign — Implementation Plan

> REQUIRED: Run `pnpm build --filter=@agent-platform/studio` before Observatory tests, and run `npx prettier --write <files>` on all changed files before finishing a task.

**Goal:** Replace the current flaky Observatory UI/state plumbing with one Studio observability feature module that owns normalized events, deterministic span lifecycle, explicit selection, shared selectors, and one canonical detail surface.

**Architecture:** Single Observatory feature store. Immutable trace normalization at the boundary. Deterministic span registries keyed by agent and agent+step. Shared selectors for tree, summary, and detail view models. Presentational Traces-tab components that stop recomputing domain logic.

**Tech Stack:** TypeScript, React, Zustand, Vitest, Next.js

**Design Docs:**

- `docs/features/sub-features/observatory-session-debugger.md`
- `docs/specs/observatory-session-debugger-redesign.hld.md`
- `docs/specs/observatory-session-debugger-redesign.lld.md`

---

## Groundwork Already Complete

- [x] Add canonical trace-event adapter at `apps/studio/src/utils/trace-event-adapter.ts`
- [x] Extract live ingestion seam at `apps/studio/src/utils/live-trace-event-ingestion.ts`
- [x] Route replay and live ingestion through the shared adapter
- [x] Split the Studio default test runner so pure Observatory logic/store suites do not depend on the flaky full browser harness
- [x] Verify current groundwork with 41 passing Observatory-path tests

These tasks should not be reimplemented. The redesign should build on them.

---

## Phase 1: Feature Store Foundation

### Task 1: Create `src/features/observatory/`

- [ ] Create `apps/studio/src/features/observatory/model.ts`
- [ ] Create `apps/studio/src/features/observatory/store.ts`
- [ ] Create `apps/studio/src/features/observatory/actions.ts`
- [ ] Create `apps/studio/src/features/observatory/index.ts`
- [ ] Define one feature state shape for events, spans, selection, expanded nodes, and active span indexes
- [ ] Add `clearSession` and explicit selection actions

**Exit criteria**

- one feature store can ingest normalized events and reset cleanly
- `ui-store` is no longer required for Observatory-owned selection in new code

### Task 2: Add compatibility facades

- [ ] Turn `apps/studio/src/store/observatory-store.ts` into a delegating wrapper or compatibility facade
- [ ] Turn `apps/studio/src/utils/trace-event-adapter.ts` into a thin export of the feature normalizer if needed
- [ ] Keep `apps/studio/src/utils/live-trace-event-ingestion.ts` as the stable external seam

**Exit criteria**

- existing imports still work while new feature code lands
- no new code writes Observatory events directly into multiple stores

---

## Phase 2: Deterministic Span Lifecycle

### Task 3: Replace heuristic span matching

- [ ] Create `apps/studio/src/features/observatory/span-registry.ts`
- [ ] Implement `activeAgentSpanIdsByAgent: Map<string, string[]>`
- [ ] Implement `activeStepSpanIdsByAgentStep: Map<string, string[]>`
- [ ] Route `agent_enter` / `agent_exit` through exact agent registries
- [ ] Route `flow_step_enter` / `flow_step_exit` through exact `(agentName, stepName)` registries
- [ ] Remove any new dependence on `getActiveSpan()` for step exits

**Exit criteria**

- repeated step names close the correct spans
- concurrent agents cannot close each other's spans
- direct span attachment favors the most specific matching running span without fallback auto-spans unless explicitly required

### Task 4: Eliminate mutation during normalization

- [ ] Move decision normalization to pure helper functions that return cloned payloads
- [ ] Remove in-place mutation of `event.data` inside legacy store logic
- [ ] Add regression coverage for caller-owned `rawEvent.data` remaining unchanged

**Exit criteria**

- Observatory normalization never mutates caller-owned objects

---

## Phase 3: Selector Layer

### Task 5: Centralize tree and metric derivation

- [ ] Create `apps/studio/src/features/observatory/metrics.ts`
- [ ] Create `apps/studio/src/features/observatory/selectors.ts`
- [ ] Define `selectSpanTree`
- [ ] Define `selectVisibleSpanTree`
- [ ] Define `selectVisibleSpanIds`
- [ ] Define `selectSessionSummaryMetrics`
- [ ] Define `selectSelectedSpanViewModel`

**Rules**

- `cost` means LLM cost only
- token totals come from `llm_call` usage only
- selectors, not components, own these rules

**Exit criteria**

- tree summary, panel summary, and selected span detail all come from the same selector outputs
- no component aggregates cost/tokens inline from raw span events

### Task 6: Split selection by domain, not by store

- [ ] Implement explicit selection slots for spans, events, and execution-tree nodes
- [ ] Remove new writes to `ui-store.selectedTraceNodeId`
- [ ] Remove dead `selectedEventId` ownership from duplicated stores

**Exit criteria**

- span selection, event selection, and execution-node selection are explicit and non-overloaded

---

## Phase 4: UI Cutover

### Task 7: Convert Traces tab to a true master-detail layout

- [ ] Update `apps/studio/src/components/observatory/DebugTabs.tsx` to consume selector outputs
- [ ] Update `apps/studio/src/components/observatory/WaterfallPanel.tsx` to accept tree + summary props
- [ ] Update `apps/studio/src/components/observatory/SpanTree.tsx` to render rows only
- [ ] Keep `apps/studio/src/components/observatory/NodeDetailPanel.tsx` as the single detail surface

**Exit criteria**

- one span selection renders one detail surface
- `WaterfallPanel` summary matches the visible span rows

### Task 8: Fix keyboard navigation and collapse behavior

- [ ] Use `selectVisibleSpanIds` for arrow navigation
- [ ] Re-home or clear selection when a collapse action hides the selected descendant
- [ ] Add targeted keyboard interaction tests

**Exit criteria**

- no hidden/ghost selections remain after collapse

### Task 9: Decouple session overview selection from span selection

- [ ] Update `SessionDetailPage.tsx`, `OverviewTab.tsx`, and `AgentExecutionTree.tsx`
- [ ] Remove the `selectSpan(node.id)` misuse for synthetic execution-tree nodes
- [ ] Add explicit "jump to span" behavior only where a real span mapping exists

**Exit criteria**

- selecting an execution node no longer opens blank or unrelated span detail

---

## Phase 5: Cleanup

### Task 10: Remove legacy duplicated ownership

- [ ] Remove Observatory event ownership from `apps/studio/src/store/trace-store.ts`
- [ ] Remove `selectedTraceNodeId` from `apps/studio/src/store/ui-store.ts`
- [ ] Remove dead `selectedEventId` fields that no UI reads
- [ ] Delete or simplify redundant helper functions in `SpanTree.tsx`, `DebugTabs.tsx`, and `NodeDetailPanel.tsx`
- [ ] Rename `ContextTab` if it remains a section rather than a real tab

**Exit criteria**

- Observatory event/state ownership is easy to explain in one paragraph
- dead state and dead helper paths are removed, not merely ignored

---

## Required Test Checklist

- [ ] `pnpm build --filter=@agent-platform/studio`
- [ ] `pnpm --filter @agent-platform/studio test -- --run src/__tests__/trace-event-adapter.test.ts src/__tests__/live-trace-event-ingestion.test.ts src/__tests__/observatory-span-end.test.ts`
- [ ] `pnpm -C apps/studio exec vitest run --config vitest.node.config.ts src/store/__tests__/observatory-span-lifecycle.test.ts`
- [ ] `pnpm -C apps/studio exec vitest run --config vitest.node.config.ts src/__tests__/e2e/observatory-trace-flow.test.ts`
- [ ] new selector and span-registry suites
- [ ] new component tests for single detail surface and visible-only keyboard navigation
- [ ] manual smoke in Studio with live and replayed versions of the same session fixture

---

## Manual Verification Checklist

- [ ] Select a span in the Traces tab and confirm only one detail surface appears
- [ ] Collapse a parent span and confirm arrow navigation never lands on hidden descendants
- [ ] Replay a session with repeated step names and confirm step spans close correctly
- [ ] Run a concurrent multi-agent session and confirm no cross-agent span closure
- [ ] Compare summary totals against selected span detail for a known LLM-heavy fixture
- [ ] Select execution-tree nodes in Overview and confirm they do not masquerade as span IDs

---

## Sequencing Notes

- Do not combine Phase 1 through Phase 5 into one PR.
- The safest merge order is:
  1. feature store foundation
  2. span registry
  3. selectors
  4. Traces tab cutover
  5. session overview selection cleanup
  6. legacy store removal

- Each phase should leave the app buildable and the current Observatory-path tests green.

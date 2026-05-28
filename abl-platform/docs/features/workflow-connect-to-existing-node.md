# Feature: Connect to Existing Node (Add Step)

**Doc Type**: SUB-FEATURE
**Parent Feature**: [Workflows & Human Tasks](./workflows.md)
**Status**: PLANNED
**Feature Area(s)**: `agent lifecycle`, `customer experience`
**Package(s)**: `apps/studio` (UI-only)
**Owner(s)**: Studio / Workflow team
**Last Updated**: 2026-05-19

---

## 1. Introduction / Overview

### Problem Statement

The workflow canvas's **Add Step** modal (`HandlePlusMenu`) lets users add a brand-new node off any source handle, but does not let them route that handle to a node that **already exists** on the canvas. As a result, users who want a convergence pattern — for example, both branches of a `Condition` ending at the same `End`, or both branches of an `Integration` `on_success` / `on_failure` joining at a shared follow-up `Function` — must drag-to-connect from the source handle to the existing target handle manually.

That drag-to-connect path works, but it has friction:

- It requires the user to discover that the small handle on the side of a node is draggable. New users frequently miss this affordance and instead duplicate the rest of the flow under both branches.
- For dense graphs, drag-to-connect to a distant node means panning the canvas with one hand while holding the drag — easy to misfire and drop the edge on the wrong target.
- The Add Step modal is the discoverable entry point for "what comes next here?" — but it only offers half the answer ("new node"), not the other half ("an existing node").

### Goal Statement

Make routing a handle to an existing downstream node a first-class, discoverable action inside the same `HandlePlusMenu` modal that users already open to add a new step. The picker must surface only eligible target nodes (no cycles, no Loop-boundary crossings) and must reuse the existing `onConnect` store action so all current validation (duplicate-edge check, fan-out cap, cycle detection, scope rules) applies uniformly.

### Summary

A new bottom-most section ("Connect to existing") is added to the `HandlePlusMenu` modal. The section renders a compact, searchable list of every existing canvas node that is a legal target from the current source handle. Selecting a row creates an edge via the existing `onConnect` action and closes the modal. No new DSL, schema, store action, validator, or engine code is introduced. The downstream `MergerNodeConfig` UI auto-engages on the target when its in-degree becomes ≥2, providing the convergence UX cue without any changes to this code path.

---

## 2. Scope

### Goals

- Add a "Connect to existing" section as the **last** section of `HandlePlusMenu`, below the current type-based categories (Flow Control, Actions, AI & Agents, Tools, Human).
- List only **eligible** target nodes (filtering rules in §6).
- Provide **inline search** that matches against the node label and the node type (e.g. searching "agent" surfaces all Agent nodes by type, and a node labelled "Agent Triage" by label).
- Reuse the **existing `onConnect` store action** so cycle prevention, fan-out caps, duplicate-edge prevention, and scope (Loop boundary) enforcement are inherited automatically.
- The resulting edge looks **identical** to a normal sequential edge — no new visual variant.
- Convergence UX (multi-input warnings, required-predecessor checklist) is delivered by the existing `MergerNodeConfig` panel, which auto-engages on any node whose in-degree reaches ≥2.

### Non-Goals (Out of Scope)

- **No new edge visual style.** No dashed lines, no colour change, no "join" label.
- **No drag-to-connect changes.** The existing handle-drag interaction continues to work exactly as it does today.
- **No new node type.** No `GoTo`, `Jump`, `Join`, or `Merge` node is introduced — convergence is already expressible as two edges pointing at the same node.
- **No engine, executor, validator, or schema changes.** The DAG executor (`apps/workflow-engine/src/executors/dag-executor.ts`) and the canvas-to-steps converter already handle multi-in-edge nodes correctly. Verified via the existing `system-parallel-graph.test.ts` E2E-1, E2E-2, E2E-3 cases.
- **No changes to `MergerNodeConfig`.** It already renders when a node has ≥2 incoming `on_success` edges and writes `config.requiredPredecessors`; the new feature simply causes it to engage more often.
- **No support for cross-Loop-boundary connections.** A node inside a Loop body cannot connect to a node outside that body, or vice versa. The existing `onConnect` scope rule already enforces this; the picker hides ineligible targets so users don't see options that will be rejected.

---

## 3. User Stories

1. As a workflow author, I want to converge two `Condition` branches onto the same downstream `End` node from within the Add Step modal, so that I don't have to duplicate the post-condition flow under both branches.
2. As a workflow author building a fan-in pattern (parallel branches that join at a shared follow-up step), I want to discover the "connect to existing node" affordance in the same modal I already use to add new steps, so that I don't have to learn the drag-to-connect interaction first.
3. As a workflow author with a large canvas (20+ nodes), I want to search the list of existing nodes by label and type, so that I can find the join target without scrolling through every node.
4. As a workflow author, I want the picker to hide targets that would create a cycle or cross a Loop boundary, so that I never see an option that the canvas will then reject.

---

## 4. Functional Requirements

1. **FR-1: New section in the modal.** `HandlePlusMenu` must render a section titled **"Connect to existing"** as the last section, below all existing type-based categories.
2. **FR-2: Compact row layout.** Each eligible target node is rendered as one row containing: a small node-type icon (left), the node label (primary text), and the node type (subtitle / secondary text). One row per node. The layout is denser than the existing category cards.
3. **FR-3: Inline search.** A search input above the list filters rows in real time. Match is case-insensitive against both label and node-type (e.g. searching `"agent"` matches both nodes of type `agent` and a node labelled `"Refund Agent"`).
4. **FR-4: Eligibility filter.** The list shows only nodes that satisfy **all** of the following:
   - Node is **not** the source node itself.
   - There is **no** existing edge from the current source handle to this target node (no duplicate).
   - There is **no** path from the candidate target back to the source — i.e. selecting it would not create a cycle.
   - The candidate target is in the **same Loop scope** as the source (Loop boundary not crossed).
5. **FR-5: Click-to-connect.** Selecting a row calls the existing store action `useWorkflowCanvasStore.getState().onConnect({ source, sourceHandle, target, targetHandle })` with the source from the menu's invocation context and the target id from the selected row. The modal closes on success.
6. **FR-6: Empty state.** When zero nodes pass the eligibility filter (e.g. on a brand-new workflow with just `Start`), the section renders a one-line empty-state message instead of an empty list. The section is **always rendered** (never hidden), so users learn the affordance exists.
7. **FR-7: No new edge style.** The resulting edge is rendered with the existing default edge component and styling. No `kind`, `variant`, or `label` field is added to the `WorkflowEdge` schema.
8. **FR-8: Convergence UX is delegated.** When the target node's in-degree becomes ≥2, the existing `MergerNodeConfig` UI engages automatically on that target node's config panel. This feature does not modify `MergerNodeConfig`.
9. **FR-9: Accessibility.** The new section, search input, and rows must be keyboard-navigable. Search input gets focus when the user reaches the section via `Tab`. Rows are reachable via arrow keys; `Enter` selects.
10. **FR-10: No engine changes.** No code under `apps/workflow-engine/` or `packages/shared/src/types/workflow-schemas.ts` is modified.

---

## 5. UX Design

```
┌────────────────────────────────────────────┐
│ Add Step                              ✕    │
│                                            │
│  FLOW CONTROL                              │
│  ┌──────────┐ ┌──────────┐ ┌──────────┐    │
│  │ Condition│ │ Loop     │ │ Delay    │    │
│  └──────────┘ └──────────┘ └──────────┘    │
│  ┌──────────┐                              │
│  │ End      │                              │
│  └──────────┘                              │
│                                            │
│  ACTIONS                                   │
│  …                                         │
│                                            │
│  AI & AGENTS                               │
│  …                                         │
│                                            │
│  TOOLS                                     │
│  …                                         │
│                                            │
│  HUMAN                                     │
│  …                                         │
│                                            │
│  ─────────────────────────────────────     │
│                                            │
│  CONNECT TO EXISTING                       │
│  ┌──────────────────────────────────────┐  │
│  │ Search nodes…                       🔍│  │
│  └──────────────────────────────────────┘  │
│  ┌──────────────────────────────────────┐  │
│  │ 🤖  Refund Agent                     │  │
│  │     Agent                            │  │
│  └──────────────────────────────────────┘  │
│  ┌──────────────────────────────────────┐  │
│  │ ⏹  End                               │  │
│  │     End                              │  │
│  └──────────────────────────────────────┘  │
│  ┌──────────────────────────────────────┐  │
│  │ ƒ  Format Response                   │  │
│  │     Function                         │  │
│  └──────────────────────────────────────┘  │
└────────────────────────────────────────────┘
```

### Empty state

When no eligible nodes exist:

```
  CONNECT TO EXISTING
  ┌──────────────────────────────────────┐
  │ Search nodes…                       🔍│
  └──────────────────────────────────────┘

  No connectable nodes yet. Add a new step first
  or build out the flow before joining branches.
```

---

## 6. Technical Approach

### 6.1 Why this is UI-only

The codebase audit (see §10 references) confirmed end-to-end DAG support already exists:

| Layer                               | Status                                                                                                                       |
| ----------------------------------- | ---------------------------------------------------------------------------------------------------------------------------- |
| Schema (`WorkflowDefinitionSchema`) | `nodes[]` + `edges[]` adjacency list — multi-in-edges natively supported.                                                    |
| Client store (`onConnect`)          | Cycle prevention, fan-out cap, duplicate prevention, scope (Loop boundary) enforcement — all already present.                |
| Canvas renderer (`@xyflow/react`)   | Non-tree edges already renderable. Each non-start node already accepts unlimited incoming edges on its single target handle. |
| Engine (`dag-executor.ts`)          | Barrier-based fan-in, skip-cascade — covered by E2E-1, E2E-2, E2E-3.                                                         |
| Convergence UX (`MergerNodeConfig`) | Auto-engages on any node with in-degree ≥2.                                                                                  |

The only gap is **discoverability** — there is no in-modal entry point for the operation "make this handle point at an existing node." This feature closes that gap with a new section of the modal.

### 6.2 Components touched

**Modified:**

- `apps/studio/src/components/workflows/canvas/nodes/HandlePlusMenu.tsx` — add a new section after the existing categories render loop. The section internally renders: a section header, a search `Input`, and a list of `ConnectToExistingRow` components, one per eligible target.

**New (likely):**

- `apps/studio/src/components/workflows/canvas/nodes/ConnectToExistingSection.tsx` (or kept inline if it stays small) — encapsulates the search input + eligibility-filtered list + empty state.
- `apps/studio/src/store/workflow-canvas-helpers.ts` — add `getEligibleConnectTargets(state, sourceNodeId, sourceHandle): WorkflowCanvasNode[]`, a pure function that returns the filtered list per FR-4.

**Untouched:**

- `apps/studio/src/store/workflow-canvas-store.ts` — `onConnect` is reused as-is.
- `MergerNodeConfig.tsx` — auto-engages on in-degree ≥2; no code change.
- All workflow-engine code.
- All schema files.

### 6.3 Eligibility computation (FR-4)

`getEligibleConnectTargets` runs on the canvas store state and returns a `WorkflowCanvasNode[]`:

```ts
function getEligibleConnectTargets(
  state: WorkflowCanvasState,
  sourceNodeId: string,
  sourceHandle: string,
): WorkflowCanvasNode[] {
  const sourceScope = getNodeScope(state, sourceNodeId); // top-level | inside Loop X
  return state.nodes.filter((candidate) => {
    if (candidate.id === sourceNodeId) return false; // not self
    if (hasEdge(state, sourceNodeId, sourceHandle, candidate.id)) return false; // not already connected
    if (wouldCreateCycle(state, sourceNodeId, candidate.id)) return false; // reuses existing helper
    if (getNodeScope(state, candidate.id) !== sourceScope) return false; // same Loop scope
    return true;
  });
}
```

- `wouldCreateCycle` already exists at `workflow-canvas-helpers.ts:40-80` — reused as-is.
- `getNodeScope` is the scope-derivation helper that `onConnect` already uses internally for its scope check — extracted (or imported) so the picker and the store action evaluate eligibility the same way.

If any node returned by `getEligibleConnectTargets` is selected and the user clicks it, calling `onConnect` will succeed — the picker and `onConnect` use the exact same predicate, so the picker can never present an option that the store will then reject.

### 6.4 Wiring

```ts
// inside ConnectToExistingSection
const handlePick = (targetNodeId: string) => {
  useWorkflowCanvasStore.getState().onConnect({
    source: sourceNodeId,
    sourceHandle,
    target: targetNodeId,
    targetHandle: null, // single target handle per node
  });
  onClose(); // close the HandlePlusMenu
};
```

No new mutations, no new store actions, no new types.

### 6.5 Search

Local component state (`useState<string>`). Filter is a single `.filter()` over the already-eligible list (which is itself the result of `getEligibleConnectTargets`). No debouncing needed — list size is bounded by canvas size (typically <100 nodes) and the filter is O(n) per keystroke.

Match field: `(node.label || '') + ' ' + node.type`, case-insensitive `includes`.

---

## 7. Edge Cases

| #   | Case                                                                                 | Behaviour                                                                                                                                                                                                                                                                                                      |
| --- | ------------------------------------------------------------------------------------ | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 1   | Workflow has only `Start`                                                            | Section renders empty state per FR-6.                                                                                                                                                                                                                                                                          |
| 2   | Source handle already has a fan-out of 10 (the cap)                                  | Picker still renders the eligible list, but `onConnect` will reject the connection (existing behaviour). To avoid a confusing dead click, we should also hide the section header in this state and show an inline notice ("Fan-out limit reached for this handle"). **Defer to LLD** — straightforward to add. |
| 3   | User opens the modal, then someone (multi-user editing) deletes the candidate node   | When the user clicks, `onConnect` will fail because the target node no longer exists. The store action already handles this defensively; we surface a toast or quietly no-op. **Defer to LLD.**                                                                                                                |
| 4   | Selected target is `End`                                                             | Allowed. `End` is a normal node with a target handle. Convergence onto a shared `End` is the primary use case.                                                                                                                                                                                                 |
| 5   | Source is inside a Loop body, candidate is the Loop's own footer / outside           | Hidden by the same-loop-scope filter.                                                                                                                                                                                                                                                                          |
| 6   | Source is inside `Condition.true` subtree, candidate is in `Condition.false` subtree | Allowed (per Q1 (a)). The DAG engine handles cross-branch convergence correctly — confirmed by E2E-3 (skip propagation through join barrier).                                                                                                                                                                  |
| 7   | User types a search string that matches zero nodes                                   | The eligible-list area renders a one-line "No matches" notice; the search input remains focused.                                                                                                                                                                                                               |

---

## 8. Test Plan

> **Canonical test spec**: [`docs/testing/sub-features/workflow-connect-to-existing-node.md`](../testing/sub-features/workflow-connect-to-existing-node.md) — read that doc for the full coverage matrix, scenario detail, and acceptance criteria. The summary below is preserved for context; the linked test spec supersedes it on any conflict.

### 8.1 Existing coverage (no new tests needed for these — already passing)

- DAG engine fan-in: `apps/workflow-engine/src/__tests__/system-parallel-graph.test.ts` — E2E-1 (diamond), E2E-2 (branch failure), E2E-3 (skip propagation).
- Cycle detection: covered by store-level tests on `onConnect`.
- `MergerNodeConfig` auto-engagement: `apps/studio/src/__tests__/canvas-fanout.test.tsx`.

### 8.2 New tests for this feature

**Unit (pure functions):**

1. `getEligibleConnectTargets` returns empty when only `Start` exists.
2. `getEligibleConnectTargets` excludes the source node itself.
3. `getEligibleConnectTargets` excludes nodes already connected from the given source handle.
4. `getEligibleConnectTargets` excludes ancestors (would create cycle).
5. `getEligibleConnectTargets` excludes nodes in a different Loop scope.
6. `getEligibleConnectTargets` includes `End`, `Agent`, `Function`, `Integration` when they pass the filter.
7. `getEligibleConnectTargets` includes a node in the sibling branch of a `Condition` (cross-branch is allowed).

**Component (React Testing Library):**

8. `ConnectToExistingSection` renders the empty-state message when there are no eligible targets.
9. Section renders one row per eligible target, with label as primary text and node-type as subtitle.
10. Typing in the search input filters rows by label.
11. Typing in the search input filters rows by node type.
12. Clicking a row dispatches `onConnect` with the correct payload and closes the modal.
13. Keyboard navigation: `Tab` reaches search → arrow keys move row focus → `Enter` selects.

**E2E (Playwright, under `apps/studio/e2e/workflows/`):**

14. Diamond-convergence flow: from a workflow with `Start → Condition`, both branches use the picker to connect to a shared `End`. Verify the resulting DAG saves correctly, executes, and renders without errors. Read `apps/studio/e2e/workflows/agents.md` first per `apps/studio/e2e/workflows/CLAUDE.md`.

---

## 9. Out of Scope / Follow-ups

- **Cross-Loop-boundary connections.** The existing scope rule forbids this; if a future use case demands it (e.g. early-exit from a loop body to an outside join), it needs its own design — likely involves new engine semantics, not just a UI change.
- **Edge label / metadata on convergence edges.** Today all edges are anonymous. If users want to label join edges ("from refund branch", "from retry branch") for readability, that needs a separate feature (new `WorkflowEdge.label` UI surface + schema check).
- **Bulk join.** Selecting multiple existing nodes at once to connect to. Not in scope; add only if user feedback demands it.
- **Picker access from drag-to-connect.** Today drag-to-connect already works; this feature is purely a modal-driven entry point. A unified picker that overlays the canvas when dragging is a separate UX bet.

---

## 10. References

### Code locations (verified during the C8/C9 audit)

| Concern                                            | File                                                                      | Lines     |
| -------------------------------------------------- | ------------------------------------------------------------------------- | --------- |
| `WorkflowDefinitionSchema` (DAG-style)             | `packages/shared/src/types/workflow-schemas.ts`                           | 392-401   |
| `WorkflowEdge` interface                           | `packages/shared-kernel/src/types/workflow-types.ts`                      | 206-213   |
| `onConnect` store action                           | `apps/studio/src/store/workflow-canvas-store.ts`                          | 790-822   |
| `wouldCreateCycle` helper                          | `apps/studio/src/store/workflow-canvas-helpers.ts`                        | 40-80     |
| `HandlePlusMenu` component (target of this change) | `apps/studio/src/components/workflows/canvas/nodes/HandlePlusMenu.tsx`    | 112-310   |
| `MergerNodeConfig` (auto-engages on in-degree ≥2)  | `apps/studio/src/components/workflows/canvas/config/MergerNodeConfig.tsx` | 1-89      |
| DAG executor (engine)                              | `apps/workflow-engine/src/executors/dag-executor.ts`                      | 93-268    |
| Canvas-to-steps cycle check (Kahn's)               | `apps/workflow-engine/src/handlers/canvas-to-steps.ts`                    | 684-708   |
| System E2E for fan-in (existing coverage)          | `apps/workflow-engine/src/__tests__/system-parallel-graph.test.ts`        | E2E-1/2/3 |

### Related specs

- [Workflows & Human Tasks](./workflows.md) — parent feature.
- [Workflow Integration Node](./workflow-integration-node.md) — sibling sub-feature.

---

## 11. Implementation Checklist

- [ ] Add `getEligibleConnectTargets` to `apps/studio/src/store/workflow-canvas-helpers.ts` (pure function).
- [ ] Add `ConnectToExistingSection.tsx` next to `HandlePlusMenu.tsx`.
- [ ] Modify `HandlePlusMenu.tsx` to render the new section after the existing category render loop.
- [ ] Wire the click handler to call `useWorkflowCanvasStore.getState().onConnect(...)`.
- [ ] Add unit tests for `getEligibleConnectTargets`.
- [ ] Add component tests for `ConnectToExistingSection`.
- [ ] Add E2E test (diamond convergence) under `apps/studio/e2e/workflows/` after reading that folder's `agents.md`.
- [ ] Run `pnpm build --filter=@agent-platform/studio` — confirm clean.
- [ ] Run `npx prettier --write` on all changed files before commit.
- [ ] Commit one focused change with a real JIRA key: `[ABLP-<ticket>] feat(studio): connect to existing node in Add Step modal`.
- [ ] Map the SHA back to JIRA after commit.
- [ ] Run `/post-impl-sync workflows` to sync this feature spec and the parent `workflows.md`.

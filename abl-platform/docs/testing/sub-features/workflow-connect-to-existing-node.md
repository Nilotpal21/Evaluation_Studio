# Test Specification: Connect to Existing Node (Add Step)

**Feature Spec**: [`docs/features/workflow-connect-to-existing-node.md`](../../features/workflow-connect-to-existing-node.md)
**HLD**: TBD (pipeline phase 3 — `docs/specs/workflow-connect-to-existing-node.hld.md`)
**LLD**: TBD (pipeline phase 4 — `docs/plans/workflow-connect-to-existing-node.md`)
**Status**: PLANNED
**Last Updated**: 2026-05-19

---

## 1. Coverage Matrix

| FR    | Description                                                                                       | Unit | Integration | E2E | Manual | Status  |
| ----- | ------------------------------------------------------------------------------------------------- | ---- | ----------- | --- | ------ | ------- |
| FR-1  | New "Connect to existing" section at the bottom of `HandlePlusMenu`                               | ❌   | ✅          | ✅  | ❌     | PLANNED |
| FR-2  | Compact row layout (icon + label-primary + type-subtitle)                                         | ❌   | ✅          | ❌  | ❌     | PLANNED |
| FR-3  | Inline search filtering by label and node type                                                    | ❌   | ✅          | ✅  | ❌     | PLANNED |
| FR-4  | Eligibility filter (not self, not duplicate, not ancestor, same Loop scope)                       | ✅   | ✅          | ✅  | ❌     | PLANNED |
| FR-5  | Click-to-connect dispatches `onConnect` with correct payload and closes modal                     | ❌   | ✅          | ✅  | ❌     | PLANNED |
| FR-6  | Empty-state message when zero eligible targets                                                    | ❌   | ✅          | ✅  | ❌     | PLANNED |
| FR-7  | Resulting edge uses the existing default edge style (no new variant)                              | ❌   | ✅          | ❌  | ✅     | PLANNED |
| FR-8  | `MergerNodeConfig` auto-engages when target's in-degree becomes ≥2                                | ❌   | ✅          | ❌  | ❌     | PLANNED |
| FR-9  | Keyboard accessibility — Tab to search, arrow keys through rows, Enter selects                    | ❌   | ✅          | ❌  | ❌     | PLANNED |
| FR-10 | No code under `apps/workflow-engine/` or `packages/shared/src/types/workflow-schemas.ts` modified | ❌   | ❌          | ❌  | ✅     | PLANNED |

**Coverage rationale:**

- FR-7 (no new edge style) is verified via manual visual review during PR + a static integration assertion that the resulting edge's `data` payload contains no new fields. No E2E pixel check.
- FR-10 (no engine changes) is verified via PR diff scope (`git diff --stat` boundaries) — a hook (`commit-scope-guard.sh`) already enforces packages-touched. Manual review confirms.
- FR-1 (section placement) is covered E2E to catch render-order regressions; FR-2 (row layout) is component-only because it's a static styling concern best verified in RTL.

---

## 2. E2E Test Scenarios (MANDATORY — minimum 5)

> All E2E scenarios live in `apps/studio/e2e/workflows/workflow-canvas-uat.spec.ts` per the Test Tiers rule in `apps/studio/e2e/workflows/agents.md`. Do **not** create a new spec file. All scenarios use:
>
> - Real Studio (`localhost:5173`) + Runtime (`localhost:3112`) + MongoDB (`localhost:27018`) + Redis (`localhost:6380`). **Restate / Workflow Engine NOT required** (per D-1 — no execution).
> - `loginAndSetup` helper for auth (single dev user; same auth context as other canvas tests).
> - Zustand store via `page.evaluate` for prerequisite graph setup; the `HandlePlusMenu` is used only when the picker is the actual interaction under test.
> - No mocks, no direct DB writes, no stubbed servers.

### E2E-1: Diamond Convergence onto Shared End (primary user journey)

- **Preconditions**: Authenticated user on the canvas of a freshly created workflow. Canvas state set via Zustand store: `Start → Condition` plus a separate `End` node placed downstream (not yet connected to either branch).
- **Steps**:
  1. Click the `[data-testid="handle-plus-on_success_if_0"]` button on the Condition node (true branch).
  2. Wait for `[data-testid="handle-plus-menu"]` to be visible.
  3. Scroll within the menu to the `[data-testid="connect-to-existing-section"]` section.
  4. Click the row `[data-testid="connect-to-existing-row-<endNodeId>"]`.
  5. Assert the menu closes and a new edge appears from Condition (if_0) → End.
  6. Click the `[data-testid="handle-plus-on_success_else"]` button on the Condition node (else branch).
  7. In the now-reopened menu, click the row for the same End node.
  8. Assert the menu closes and a second edge appears from Condition (else) → End.
  9. Save the workflow (`saveWorkflow` helper).
  10. Reload the page and `waitForCanvasReady`.
  11. Read the Zustand store; assert the End node has exactly 2 incoming edges from the Condition node's two handles.
- **Expected Result**: Diamond shape preserved across save/reload. Two edges land on the shared End node with `source=conditionId`, `target=endId`, `sourceHandle ∈ {on_success_if_0, on_success_else}`.
- **Auth Context**: dev tenant + dev project + dev user (`loginAndSetup`).
- **Covers**: FR-1, FR-5, FR-7 (default edge style preserved across reload).

### E2E-2: Mid-flow Fan-in onto Existing Agent Node

- **Preconditions**: Canvas state set via store: `Start → API → Agent → End`. A second API node (`API-2`) is placed sibling-style (no edges in yet, output-only).
- **Steps**:
  1. From `API-2`'s `on_success` handle, open the HandlePlusMenu.
  2. In the "Connect to existing" section, search for `"Agent"`.
  3. Assert the Agent node row appears in the filtered list.
  4. Click the Agent node row.
  5. Assert the menu closes; a new edge appears from `API-2.on_success` → `Agent`.
  6. Save and reload.
  7. Assert the Agent node now has in-degree 2 in the Zustand store.
  8. Click the Agent node to open its config panel.
  9. Assert `[data-testid="merger-node-config"]` is visible (FR-8: `MergerNodeConfig` auto-engaged).
- **Expected Result**: Fan-in succeeds; `MergerNodeConfig` engages automatically; convergence UX is delivered without any code change to `MergerNodeConfig`.
- **Auth Context**: dev tenant + dev project + dev user.
- **Covers**: FR-3 (search), FR-5, FR-8.

### E2E-3: Empty-State on a Fresh Canvas (only Start exists)

- **Preconditions**: Brand-new workflow created via UI (`createWorkflowViaUI`). Canvas contains only the auto-inserted Start node.
- **Steps**:
  1. Click the `[data-testid="handle-plus-on_success"]` button on the Start node.
  2. Wait for `[data-testid="handle-plus-menu"]`.
  3. Locate the `[data-testid="connect-to-existing-section"]` section.
  4. Assert the empty-state message `[data-testid="connect-to-existing-empty"]` is visible.
  5. Assert no `[data-testid^="connect-to-existing-row-"]` rows are rendered.
- **Expected Result**: Section is always rendered (FR-6); empty-state message replaces the list when zero candidates are eligible.
- **Auth Context**: dev tenant + dev project + dev user.
- **Covers**: FR-1 (section always present), FR-6.

### E2E-4: Search Filter — by Label AND by Type

- **Preconditions**: Canvas state set via store with 4 typed/labelled nodes downstream of Start:
  - `Function` labelled `"Format Response"`
  - `Function` labelled `"Compute Tax"`
  - `Agent` labelled `"Refund Agent"`
  - `End` (default label `"End"`)
- **Steps**:
  1. Open the HandlePlusMenu from Start's `on_success` handle.
  2. Wait for the "Connect to existing" section to render with all 4 rows.
  3. Type `"format"` into `[data-testid="connect-to-existing-search"]`.
  4. Assert only the `"Format Response"` row is visible (label match).
  5. Clear the input.
  6. Type `"function"` (case-insensitive).
  7. Assert both `"Format Response"` and `"Compute Tax"` rows are visible (type match).
  8. Clear the input.
  9. Type `"agent"`.
  10. Assert the `"Refund Agent"` row is visible (matches both label substring and node type).
  11. Type a random string `"xyz123nomatch"`.
  12. Assert no rows are visible and a "No matches" indicator (`[data-testid="connect-to-existing-no-matches"]`) is shown.
- **Expected Result**: Search is case-insensitive and matches against `label + type` per FR-3. The "no matches" state is a sub-case of the empty list, distinct from FR-6's "no eligible candidates" state.
- **Auth Context**: dev tenant + dev project + dev user.
- **Covers**: FR-3.
- **Error/empty-input analog**: This scenario serves as the "search-with-invalid-input" analog to the form-error-path requirement. The feature has no form submission and no API call, so the standard 4xx-error-surfaced-in-UI gate does not directly apply (see §5 below). The "no matches" assertion is the closest semantic equivalent.

### E2E-5: Eligibility Hides Cycle, Already-Connected, and Cross-Loop Targets

- **Preconditions**: Canvas state set via store with the following topology:
  - `Start → A → B → C → End` (linear chain)
  - A `Loop` node sibling-style (separate scope), containing a node `LoopChild` inside its body.
  - One pre-existing edge `A.on_success → B` (already connected — FR-4 duplicate rule).
- **Steps**:
  1. Open the HandlePlusMenu from `A`'s `on_success` handle.
  2. Locate the "Connect to existing" section.
  3. Read all visible `connect-to-existing-row-*` testids.
  4. Assert the following nodes are **NOT** in the row list:
     - `A` itself (not self — FR-4)
     - `B` (already connected from this handle — FR-4 duplicate)
     - `Start` (would create cycle: B → C → End, but `wouldCreateCycle(A, Start)` returns true because Start → A path exists — FR-4 cycle)
     - `LoopChild` (different Loop scope — FR-4 scope rule)
     - The `Loop` node itself if `A` is outside the loop body (different scope per design — confirm in LLD via the same predicate `onConnect` uses).
  5. Assert the following nodes ARE in the row list:
     - `C` (downstream, no cycle, same top-level scope)
     - `End` (downstream, no cycle, same top-level scope)
- **Expected Result**: Picker shows only candidates that `onConnect` would accept. Selecting any visible row succeeds; the user never sees an option that the store will reject.
- **Auth Context**: dev tenant + dev project + dev user.
- **Covers**: FR-4.

### E2E-6 (deferred, future): Multi-User Editing Race

> **Status**: Deferred to LLD phase per feature spec §7 edge case #3. The defensive behavior (toast vs silent no-op when the candidate node is deleted between menu-open and click) is not yet specified. This row exists so the test spec auditor sees the gap and the test author knows to amend this section after LLD.

- **Trigger to land**: LLD phase decides the behaviour.
- **Likely test shape**: Open the menu; in a separate `page.evaluate`, delete the candidate node from the Zustand store; click the (now-stale) row; assert the documented defensive behaviour (toast / no-op / surfaced inline error). To be defined.

---

## 3. Integration Test Scenarios (MANDATORY — minimum 5)

> All integration tests use React Testing Library + a real Zustand store (no mocks of platform components — same pattern as `apps/studio/src/__tests__/canvas-fanout.test.tsx`). File path: `apps/studio/src/__tests__/connect-to-existing.integration.test.tsx` (new).

### INT-1: ConnectToExistingSection Renders the Eligibility-Filtered List

- **Boundary**: `ConnectToExistingSection` component ↔ live Zustand store `useWorkflowCanvasStore` ↔ helper `getEligibleConnectTargets`.
- **Setup**: `useWorkflowCanvasStore.setState({ nodes: [start, condition, agent, end], edges: [start→condition] })`. Mount `<ConnectToExistingSection sourceNodeId={conditionId} sourceHandle="on_success_if_0" onClose={onClose} />`.
- **Steps**:
  1. Render the component.
  2. Read all rows by `connect-to-existing-row-*` testid.
- **Expected Result**: Exactly 2 rows render (Agent + End). No row for Start (would create cycle), no row for Condition (self).
- **Failure Mode**: If `getEligibleConnectTargets` returns the wrong set, the row count is wrong — the test fails with a specific diff between expected and observed nodes.

### INT-2: Clicking a Row Dispatches `onConnect` and Closes the Modal

- **Boundary**: `ConnectToExistingSection` ↔ real Zustand store action `onConnect`.
- **Setup**: Same store state as INT-1. Spy on `onClose`. Read the current edge list before interacting.
- **Steps**:
  1. Click the row for the Agent node.
  2. Assert `onClose` was called exactly once.
  3. Read the post-click store edge list.
- **Expected Result**: A new edge exists with `{source: conditionId, sourceHandle: "on_success_if_0", target: agentId}`. Other store fields unchanged.
- **Failure Mode**: If the click handler passes wrong IDs or wrong handle, the edge is mis-wired; assertion catches it.

### INT-3: Eligibility-Filter / `onConnect` Predicate Parity (the core FR-4 invariant)

- **Boundary**: `getEligibleConnectTargets` ↔ `isValidWorkflowConnection` + `onConnect`'s pre-conditions.
- **Setup**: Build 6 representative graph fixtures, each one a small graph with mixed eligible/ineligible candidates:
  - F1: Single Start (no candidates).
  - F2: Linear chain Start→A→B→End (from A: candidates B, End; not Start).
  - F3: Diamond half-built Start→Condition with End placed (candidates End; not Start, not Condition).
  - F4: Source handle already at fan-out cap of 10.
  - F5: Source inside a Loop body, several outside-loop candidates.
  - F6: Pre-existing edge from source handle to one candidate (should be excluded as duplicate).
- **Steps**:
  1. For each fixture, compute `eligible = getEligibleConnectTargets(state, sourceId, sourceHandle)`.
  2. For each node `n` in `state.nodes` (except source), build the **composite predicate** from the three sequential guards that `onConnect` applies (per `workflow-canvas-store.ts:790-822`):
     - (a) **Duplicate-edge check** — no existing edge in `state.edges` with `source === sourceId && sourceHandle === sourceHandle && target === n.id`.
     - (b) **Fan-out cap** — source handle has fewer than `MAX_FAN_OUT` (10) outgoing edges.
     - (c) **`isValidWorkflowConnection(state.edges, state.nodes, {source: sourceId, sourceHandle, target: n.id, targetHandle: null})`** — handles scope (parentId / Loop boundary) AND cycle detection (per `workflow-canvas-helpers.ts:86-128`).
       A candidate passes iff **all three** guards return true. Build set `wouldAccept`.
  3. Assert `eligible === wouldAccept` (same set, by node id). The parity must hold across all 6 fixtures — fixtures F4 (fan-out cap) and F6 (duplicate) specifically exercise guards (b) and (a) that are NOT part of `isValidWorkflowConnection`, so calling `isValidWorkflowConnection` alone would make the parity test vacuous for those fixtures.
- **Expected Result**: Exact set equality across all 6 fixtures. This is the canonical "picker never shows what the store would reject" invariant test.
- **Failure Mode**: Drift between the picker's predicate and the store's predicate — the strongest possible signal of an FR-4 regression.

### INT-4: Search Filter — Reactive Behaviour and Empty Results

- **Boundary**: `ConnectToExistingSection` search input ↔ filtered row list.
- **Setup**: Store with 5 eligible nodes (Function "Format", Function "Compute", Agent "Refund", End, Tool "Send Email").
- **Steps**:
  1. Render. Assert 5 rows visible.
  2. `userEvent.type(searchInput, "format")` — assert 1 row visible (Function "Format").
  3. `userEvent.clear(searchInput)` — assert 5 rows visible again.
  4. `userEvent.type(searchInput, "AGENT")` — assert 1 row visible (case-insensitive label/type match).
  5. `userEvent.type(searchInput, "{Backspace>5}xyz")` — rapid edit, then a no-match string — assert 0 rows AND `[data-testid="connect-to-existing-no-matches"]` is rendered.
- **Expected Result**: The filter is synchronous and reactive; rapid typing does not produce inconsistent UI states (per D-7).
- **Failure Mode**: A stale `useState` reference or a memoisation bug surfaces as stuck filter state.

### INT-5: Keyboard Navigation — Tab to Search, Arrow Keys, Enter

- **Boundary**: `ConnectToExistingSection` keyboard handlers ↔ row focus management.
- **Setup**: Store with 3 eligible nodes. Mount inside a HandlePlusMenu wrapper so the section is reachable by Tab from the modal's first focusable element.
- **Steps**:
  1. Press Tab repeatedly until focus lands on `[data-testid="connect-to-existing-search"]`. Assert focus state.
  2. Press ArrowDown — assert focus moves to the first row.
  3. Press ArrowDown twice more — assert focus moves through rows 2 and 3.
  4. Press ArrowUp — assert focus moves back to row 2.
  5. Press Enter — assert the click handler fires for row 2 (same as if clicked).
- **Expected Result**: Per FR-9. Behaviour matches a standard listbox keyboard pattern.
- **Failure Mode**: Missing `onKeyDown` handler or wrong `tabIndex` — focus traps or skips rows.

### INT-6: `MergerNodeConfig` Auto-Engages After Picker Creates Second Incoming Edge

- **Boundary**: `ConnectToExistingSection` → `onConnect` → store state → `MergerNodeConfig` render condition.
- **Setup**: Store state where a target Function node already has 1 incoming edge. Mount both `ConnectToExistingSection` (sourced from a different node) AND the target node's config panel containing `<MergerNodeConfig nodeId={functionId} />` in the same render tree.
- **Steps**:
  1. Assert `MergerNodeConfig` is **not** visible (in-degree 1).
  2. Click the row for the Function in the picker.
  3. Re-render (auto via Zustand subscription).
  4. Assert `MergerNodeConfig` is now visible (in-degree 2 → predecessor list renders).
- **Expected Result**: Convergence UX engages without any code change in this feature.
- **Failure Mode**: If `MergerNodeConfig`'s in-degree threshold drifts away from "≥2", the test catches it. Also catches a Zustand subscription / re-render bug in the new picker code.

---

## 4. Unit Test Scenarios

> Pure-function tests on `getEligibleConnectTargets`. File path: `apps/studio/src/store/__tests__/get-eligible-connect-targets.test.ts` (new). All inputs are plain `WorkflowCanvasState` literals — no React, no Zustand, no mocks.

### UT-1: Empty Workflow (only Start)

- **Module**: `getEligibleConnectTargets`
- **Input**: `state = { nodes: [start], edges: [] }`, sourceNodeId = start.id, sourceHandle = `on_success`
- **Expected Output**: `[]`

### UT-2: Excludes the Source Node Itself

- **Input**: `state = { nodes: [start, agent], edges: [start→agent] }`, sourceNodeId = agent.id, sourceHandle = `on_success`
- **Expected Output**: `[]` (start would create a cycle, agent is self).

### UT-3: Excludes Nodes Already Connected from This Source Handle

- **Input**: `state = { nodes: [start, agent, end], edges: [start→agent (on_success), agent→end (on_success)] }`, sourceNodeId = agent.id, sourceHandle = `on_success`
- **Expected Output**: `[]` (end is already connected from agent.on_success; start is upstream).

### UT-4: Excludes Nodes Already Connected from a Different Source Handle of the Same Source (must be allowed if a DIFFERENT handle)

- **Input**: A Condition node with two outgoing handles. Edge from `on_success_if_0` to End exists; querying targets for `on_success_else`.
- **Expected Output**: End is INCLUDED (the duplicate rule is **per-handle**, not per-source-node). This ensures the diamond pattern works — both Condition branches must be able to connect to the same End.

### UT-5: Excludes Ancestors (Would Create Cycle)

- **Input**: Linear chain `Start → A → B → C`. sourceNodeId = C.id, sourceHandle = `on_success`.
- **Expected Output**: Empty array — A, B are ancestors (cycle), Start is an ancestor (cycle), C is self.

### UT-6: Excludes Nodes in a Different Loop Scope

- **Input**: Top-level chain `Start → A`. A Loop node with body containing `LoopChild`. sourceNodeId = A.id (top-level scope).
- **Expected Output**: `[]` if Loop has no top-level downstream nodes — `LoopChild` is in a different scope (different `parentId`), the Loop node itself is excluded too per the LLD's chosen interpretation of `getNodeScope` (see Open Question 3 in §9).
- **Predicate reference**: The scope check uses `node.parentId` comparison, matching `isValidWorkflowConnection` at `workflow-canvas-helpers.ts:96-125`. The named helper `getNodeScope` referenced in the feature spec §6.3 may or may not be extracted during implementation — what matters is that the unit test asserts against the **same predicate `onConnect` uses**, namely: a candidate is in a different scope iff `candidate.parentId !== sourceNode.parentId`. The unit test should call whichever exported function the LLD chose (named helper or inline comparison), and the test name should reference the property (`parentId` equality), not the helper name.

### UT-7: Includes End, Agent, Function, Integration When They Pass the Filter

- **Input**: `Start → A` with downstream End, Agent, Function, Integration nodes placed (sibling, not yet connected to A). sourceNodeId = A.id, sourceHandle = `on_success`.
- **Expected Output**: All 4 downstream nodes are eligible. Sorted in canvas insertion order (LLD will pin the sort).

### UT-8: Cross-Branch Convergence is Allowed (Q1 (a))

- **Input**: `Start → Condition` with `Condition.on_success_if_0 → X`, `Condition.on_success_else → Y`. sourceNodeId = X.id (inside if_0 branch), sourceHandle = `on_success`.
- **Expected Output**: Y is INCLUDED (cross-branch allowed per design Q1 (a)). The engine handles it correctly per `system-parallel-graph.test.ts` E2E-3.

### UT-9: Fan-out Cap on Source Handle (10 outgoing edges)

- **Input**: Source node `A` already has 10 outgoing edges on `on_success`. 5 more eligible candidate nodes exist downstream.
- **Expected Output**: `[]` — when the cap is reached, no further connections are possible from this handle, so the eligibility list is empty. (D-6 defers fan-out-cap UX to LLD; the unit test asserts the underlying filter behaviour regardless.)

### UT-10: Stable Sort Order (Deterministic Output)

- **Input**: Identical state literal called twice.
- **Expected Output**: `getEligibleConnectTargets(...)` returns the same node order both times.

---

## 5. Security & Isolation Tests

This feature has **no new authentication, authorisation, tenant-scoping, or data surface**. The standard checklist is therefore evaluated as N/A with explicit rationale:

| Check                                                | Status  | Rationale                                                                                                                                                                                         |
| ---------------------------------------------------- | ------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Cross-tenant access returns 404                      | N/A     | Feature is UI-only. The canvas already filters by tenant + project at load time (existing controls). No new endpoint to cross-tenant attack.                                                      |
| Cross-project access returns 404                     | N/A     | Same as above.                                                                                                                                                                                    |
| Cross-user access returns 404                        | N/A     | Workflows are project-owned, not user-owned. No user-scoped resource introduced.                                                                                                                  |
| Missing auth returns 401                             | N/A     | No new HTTP route.                                                                                                                                                                                |
| Insufficient permissions returns 403                 | N/A     | No new permission. Editing the canvas already requires `workflows:write` (existing).                                                                                                              |
| Input validation rejects malformed data              | COVERED | The search input accepts any string and renders as text content (React escaping prevents XSS). The `onConnect` action validates IDs by `z.string().min(1)` (existing). No new validation surface. |
| Form-error E2E (4xx surfaced in UI)                  | N/A     | Feature has no form submission and no API call. The "no matches" empty state in E2E-4 is the analog for "invalid input does not crash UI."                                                        |
| Wiring-verification E2E (Studio API → runtime chain) | N/A     | No new Studio API route. The "UI → store → render" path is exercised end-to-end by E2E-1 and INT-3.                                                                                               |

**Defensive notes:**

- The search input renders user-controlled text — verified safe by React's default text-node escaping. No `dangerouslySetInnerHTML`. Component test INT-4 confirms the rendered string is the literal input (no markup interpretation).
- The eligibility filter operates only on Zustand state already in memory. No data crossing a trust boundary.
- The new testids must not include user-controlled data in non-deterministic positions. Row testids use the node id (UUID generated by `crypto.randomUUID()` per `workflow-canvas-store.ts:865,979`), not the user-provided label. Verified in INT-1.

---

## 6. Performance & Load Tests

Not required for this feature. Rationale:

- The eligibility list is bounded by canvas size (typically < 100 nodes; pragmatic upper bound ~500).
- `getEligibleConnectTargets` is O(n × cycle-check-cost) where cycle check is itself O(V + E). For a 100-node graph, this is sub-millisecond.
- Search filter is a single synchronous `.filter()` on the eligibility list — O(n) per keystroke, no debounce needed (D-7).

If a future regression suggests perf concerns (e.g. user reports of laggy typing on large canvases), add a benchmark test with a 500-node fixture before assuming the algorithm needs optimising.

---

## 7. Test Infrastructure

### Required Services

| Tier        | Services                                                     | Why                                                                             |
| ----------- | ------------------------------------------------------------ | ------------------------------------------------------------------------------- |
| Unit        | None                                                         | Pure functions; vitest + plain `WorkflowCanvasState` literals.                  |
| Integration | None (jsdom only)                                            | React Testing Library + real Zustand store, same as `canvas-fanout.test.tsx`.   |
| E2E         | Studio (5173), Runtime (3112), MongoDB (27018), Redis (6380) | Standard canvas-test stack. **Restate / Workflow Engine NOT required** per D-1. |

### Data Seeding

- **E2E**: HTTP-only via `createWorkflowViaUI` helper, then Zustand store via `page.evaluate` for graph topology (per `agents.md` Writing Rule #2). No direct MongoDB writes.
- **Integration**: `useWorkflowCanvasStore.setState({...})` with literal node/edge arrays.
- **Unit**: Plain object literals passed to `getEligibleConnectTargets`. No setup needed.

### Environment Variables

Standard `apps/studio/.env.local` (already required for canvas E2E):

- `JWT_SECRET=dev-jwt-secret-that-is-at-least-32chars`
- `MONGODB_URL`, `REDIS_URL` per `agents.md` Prerequisites table.

### CI Configuration

- Unit + integration tests run as part of `pnpm test --filter=@agent-platform/studio` (existing).
- E2E tests run via the existing Playwright job; the new scenarios extend `workflow-canvas-uat.spec.ts` and inherit the same CI gate. No new pipeline stages.

### Testid Registry (must be added during implementation)

Add to `apps/studio/e2e/workflows/agents.md` Testid registry table under a new "Connect-to-existing" row:

| Area                | Testids                                                                                                                                                                                                       |
| ------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Connect-to-existing | `connect-to-existing-section`, `connect-to-existing-search`, `connect-to-existing-row-{nodeId}`, `connect-to-existing-empty`, `connect-to-existing-no-matches`, `merger-node-config` (if not already present) |

---

## 8. Test File Mapping

| Test File                                                                                     | Type        | Covers                                                               | Status  |
| --------------------------------------------------------------------------------------------- | ----------- | -------------------------------------------------------------------- | ------- |
| `apps/studio/src/store/__tests__/get-eligible-connect-targets.test.ts` (new)                  | unit        | FR-4 (UT-1 through UT-10)                                            | PLANNED |
| `apps/studio/src/__tests__/connect-to-existing.integration.test.tsx` (new)                    | integration | FR-1, FR-2, FR-3, FR-4, FR-5, FR-6, FR-8, FR-9 (INT-1 through INT-6) | PLANNED |
| `apps/studio/e2e/workflows/workflow-canvas-uat.spec.ts` (extend; do NOT create new spec file) | e2e         | FR-1, FR-3, FR-4, FR-5, FR-6, FR-7 (E2E-1 through E2E-5)             | PLANNED |
| `apps/studio/e2e/workflows/agents.md` (testid registry + coverage tracker update)             | docs        | Infrastructure                                                       | PLANNED |

### Out of Scope for This Spec (existing coverage — do not duplicate)

| Concern                                          | Already Covered By                                                           |
| ------------------------------------------------ | ---------------------------------------------------------------------------- |
| DAG engine fan-in (barrier, skip-cascade)        | `apps/workflow-engine/src/__tests__/system-parallel-graph.test.ts` E2E-1/2/3 |
| `onConnect` fan-out cap, cycle, duplicate guards | `apps/studio/src/__tests__/canvas-fanout.test.tsx` UT-1 through UT-7         |
| `wouldCreateCycle` correctness                   | Indirect via `canvas-fanout.test.tsx` UT-4/4b/4c                             |
| `MergerNodeConfig` rendering                     | `canvas-fanout.test.tsx` UT-6/UT-7                                           |

---

## 9. Open Testing Questions

1. **Multi-user editing race** (E2E-6, feature spec §7 edge case #3) — defensive behaviour undecided. **Resolves at**: LLD phase. **Action**: amend §2 with the E2E-6 body and a corresponding integration scenario once the LLD documents the chosen behaviour (toast vs no-op vs inline error).

2. **Fan-out cap edge-case UX** (feature spec §7 edge case #2) — when the source handle is already at 10 outgoing edges, the section should likely hide the row list and show "Fan-out limit reached." UT-9 covers the underlying filter behaviour; the UX scenario is **resolved at**: LLD phase.

3. **Loop node eligibility when source is outside the loop** (UT-6) — does `getNodeScope` consider the Loop _node_ itself as "outside-the-body" or "inside-the-body" when computing eligibility for a source that lives outside the loop? Both interpretations are defensible. **Resolves at**: LLD phase, with the test updated to match the predicate used by `onConnect`.

4. **Sort order of the row list** (UT-7 / UT-10) — by canvas insertion order? By topological distance from source? By alphabetical label? Default is canvas insertion order (deterministic, requires no extra computation). **Resolves at**: LLD phase.

5. **Note (not a blocking question)**: INT-3 runs all 6 fixtures by default. If integration-test runtime budget becomes a concern in CI, mark fixtures F4 (fan-out cap) and F6 (duplicate) as `test.concurrent` to parallelise — they are independent and have the lowest setup cost.

---

## Change Log

| Date       | Change                                                                                                               | Author          |
| ---------- | -------------------------------------------------------------------------------------------------------------------- | --------------- |
| 2026-05-19 | Initial test spec drafted. Oracle decisions D-1 through D-8 incorporated. 5 E2E + 6 integration + 10 unit scenarios. | test-spec skill |

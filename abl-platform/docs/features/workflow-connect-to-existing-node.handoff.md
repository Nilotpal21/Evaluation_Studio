# Connect to Existing Node — Developer Handoff

**Status:** Implementation complete on `develop` (uncommitted). Ready for review + commit.
**Surface:** Workflow canvas → "Add Step" modal (`HandlePlusMenu`)
**Companion docs:**
[Feature spec](./workflow-connect-to-existing-node.md) · [Test spec](../testing/sub-features/workflow-connect-to-existing-node.md)
**Complete diff:** [`workflow-connect-to-existing-node.patch`](./workflow-connect-to-existing-node.patch) (1,871 lines covering every modified + new file)
**Scope:** UI-only. **No engine, schema, validator, store-action, or API changes.**

---

## 0. Replicate the exact changes

Two options, depending on whether you want to apply the diff verbatim or read + retype.

### Option A — Apply the patch (recommended)

The patch file at `docs/features/workflow-connect-to-existing-node.patch` contains the complete set of file changes (4 modified + 4 new + 2 doc tweaks). From a clean checkout of `develop` (or whatever base branch you want to land this on):

```bash
# Sanity check first — see what would change, nothing modified yet
git apply --check docs/features/workflow-connect-to-existing-node.patch

# Apply it
git apply docs/features/workflow-connect-to-existing-node.patch

# Format (the patch already contains prettier-formatted output, but
# safety net in case your local prettier config differs)
npx prettier --write \
  apps/studio/src/store/workflow-canvas-helpers.ts \
  apps/studio/src/store/workflow-canvas-store.ts \
  apps/studio/src/components/workflows/canvas/nodes/HandlePlusMenu.tsx \
  apps/studio/src/components/workflows/canvas/nodes/ConnectToExistingSection.tsx \
  apps/studio/src/components/workflows/canvas/nodes/handlePlusMenuIcons.ts \
  apps/studio/src/store/__tests__/get-eligible-connect-targets.test.ts \
  apps/studio/src/__tests__/connect-to-existing.integration.test.tsx

# Verify
cd apps/studio
pnpm exec tsc --noEmit
pnpm exec vitest run \
  src/store/__tests__/get-eligible-connect-targets.test.ts \
  src/__tests__/connect-to-existing.integration.test.tsx
```

If `git apply --check` reports conflicts (e.g. someone else edited `HandlePlusMenu.tsx` in your base), use `git apply --3way` for the smart merge, or fall back to Option B and re-author the changes manually using §5 below as the blueprint.

### Option B — Re-author manually

Read §2 for the file map, §3 for the architectural rationale, §5 for the critical inline code snippets, then write the code yourself. Slower but useful if you need to adapt the change to a different base or substantially refactor while reapplying.

---

## 1. What this ships

The "Add Step" modal that opens from every node handle now has **two tabs**:

| Tab              | Purpose                                                                                                                                                                                                                                                                                                               |
| ---------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **Add new**      | Existing behaviour, restructured — categorised node-type picker (Flow Control, Actions, AI & Agents, Tools, Human) plus a new inline search input. Selecting a card creates a brand-new node off the source handle.                                                                                                   |
| **Add existing** | New surface — lets the user route the current handle to a node that already exists on the canvas. Eligible candidates are grouped into sections by node type (END, AGENT, FUNCTION, …) and laid out in the same 3-column card grid as Add new. Selecting a card creates the edge via the existing `onConnect` action. |

Both tabs share the same icon-based tab bar (`<Tabs>` component, same as the workflow detail page header) and a shared search input style.

### Why it's UI-only

The underlying workflow DSL is already a full DAG — `nodes[] + edges[]` (adjacency list) with no tree constraint. Multi-in-edges, fan-in, cycle detection, scope (Loop-boundary) enforcement, and the convergence-UX panel (`MergerNodeConfig`) all already exist end-to-end. The only gap was discoverability — there was no in-modal entry point for "route this handle to an existing node." This feature closes that gap.

End-to-end DAG support is verified by `apps/workflow-engine/src/__tests__/system-parallel-graph.test.ts` (E2E-1 diamond, E2E-2 branch failure, E2E-3 skip propagation). Do **not** add engine-side fan-in tests for this feature.

---

## 2. Files changed / created

### Production code

| File                                                                             | Change                                                                                                   | Why                                                                                                                                                                                                                                                              |
| -------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `apps/studio/src/store/workflow-canvas-store.ts`                                 | Export `MAX_FAN_OUT` (line 33)                                                                           | Helper needs the same constant; previously private to the store.                                                                                                                                                                                                 |
| `apps/studio/src/store/workflow-canvas-helpers.ts`                               | Add `getEligibleConnectTargets<TData>` — generic pure function                                           | Single source of truth for picker eligibility. Composes the three guards `onConnect` applies: duplicate-edge check, fan-out cap, `isValidWorkflowConnection`. Plus unconditional exclusions: source-self, `start`, `loop_start`, `loop_end`.                     |
| `apps/studio/src/components/workflows/canvas/nodes/handlePlusMenuIcons.ts`       | New file. Exports `STEP_ICON_MAP`, `CATEGORY_ORDER`, `MENU_NODE_TYPES`                                   | Shared constants so HandlePlusMenu (Add new tab) and ConnectToExistingSection (Add existing tab) can't drift on icon mapping or category/type ordering.                                                                                                          |
| `apps/studio/src/components/workflows/canvas/nodes/HandlePlusMenu.tsx`           | Tab state + `<Tabs>` bar + per-tab search input + filtered group rendering. Reset both queries on close. | Wraps the existing categorised grid in a tab; mounts `<ConnectToExistingSection>` in the other tab.                                                                                                                                                              |
| `apps/studio/src/components/workflows/canvas/nodes/ConnectToExistingSection.tsx` | New file. Renders the Add-existing tab content.                                                          | Eligible nodes grouped by `nodeType`, ordered per `CATEGORY_ORDER → MENU_NODE_TYPES`. Cards in `grid-cols-3` matching Add new. Each card has `title` + `aria-label` for the full label so truncated names surface on hover. Keyboard nav via Arrow keys + Enter. |

### Tests

| File                                                                   | Type                                   | Coverage                                                                                                                                                                                                                                                                                                                                                                                                                                    |
| ---------------------------------------------------------------------- | -------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `apps/studio/src/store/__tests__/get-eligible-connect-targets.test.ts` | Unit                                   | 11 tests covering eligibility rules (self, ancestor/cycle, scope, fan-out cap, cross-branch convergence, alphabetical sort, deterministic order).                                                                                                                                                                                                                                                                                           |
| `apps/studio/src/__tests__/connect-to-existing.integration.test.tsx`   | Integration (RTL + real Zustand store) | 11 tests covering: section rendering, click-to-connect payload, predicate parity across 6 graph fixtures, search filter (label/type/case-insensitive/no-matches), keyboard nav, MergerNodeConfig auto-engagement.                                                                                                                                                                                                                           |
| `apps/studio/e2e/workflows/workflow-canvas-uat.spec.ts`                | E2E (Playwright)                       | Added `UAT-11` describe block with 5 scenarios (empty state, diamond convergence, mid-flow fan-in + MergerNodeConfig, search filter, eligibility-hides). **Note:** these were written against the original "section at bottom" UX. After the tab refactor they need a one-line `await page.locator('[data-testid="add-step-tab-existing"]').click();` insertion before each picker assertion. Not blocking the unit + integration coverage. |
| `apps/studio/e2e/connect-to-existing-smoke.spec.ts`                    | One-off smoke                          | Bootstraps a project via API + opens the picker in a fresh workflow. Used to capture visual screenshots during iteration. Safe to delete once full UAT-11 tests are running green.                                                                                                                                                                                                                                                          |

### Docs

| File                                                                | Status                                                                                                                                                                                                                                                                         |
| ------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `docs/features/workflow-connect-to-existing-node.md`                | Feature spec (original — written before the tabbed UX iterations; some §5 UX sketches show the old "section at bottom" pattern. The §6 technical approach and §4 functional requirements still apply; the §5 UX diagrams should be considered superseded by this handoff doc.) |
| `docs/testing/sub-features/workflow-connect-to-existing-node.md`    | Test spec — passed phase-auditor rounds 1 and 2.                                                                                                                                                                                                                               |
| `docs/testing/sub-features/README.md`                               | Index updated with the new sub-feature row.                                                                                                                                                                                                                                    |
| `docs/sdlc-logs/workflow-connect-to-existing-node/test-spec.log.md` | Oracle decision log (D-1 through D-8).                                                                                                                                                                                                                                         |
| `docs/features/workflow-connect-to-existing-node.handoff.md`        | **This document.**                                                                                                                                                                                                                                                             |

### Testid registry

Added to `apps/studio/e2e/workflows/agents.md` testid registry:

| Area                | Testids                                                                                                                                                                                                                                                                                                           |
| ------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Connect-to-existing | `add-step-tab-new`, `add-step-tab-existing`, `add-new-search`, `add-new-no-matches`, `connect-to-existing-section`, `connect-to-existing-search`, `connect-to-existing-row-{nodeId}`, `connect-to-existing-group-{nodeType}`, `connect-to-existing-empty`, `connect-to-existing-no-matches`, `merger-node-config` |

---

## 3. Architectural decisions worth knowing

### 3.1 Predicate parity (the crown jewel)

`getEligibleConnectTargets` in `workflow-canvas-helpers.ts` and `onConnect` in `workflow-canvas-store.ts:790-822` must accept/reject the exact same `(source, sourceHandle, target)` triples. If they drift, the picker shows options the store rejects (or hides options the store would accept) — both are silent failures from the user's POV.

The composite predicate has three sequential guards:

1. **Duplicate-edge check** — no existing edge with same `(source, sourceHandle, target)`.
2. **Fan-out cap** — source handle has fewer than `MAX_FAN_OUT` (10) outgoing edges.
3. **`isValidWorkflowConnection`** — scope (parentId / Loop boundary) and cycle detection.

`getEligibleConnectTargets` composes all three plus four unconditional exclusions:

- `candidate.id === sourceNodeId` (self)
- `candidate.nodeType === 'start'` (workflow entry, never an edge target)
- `candidate.nodeType === 'loop_start'` (internal socket, see §3.2)
- `candidate.nodeType === 'loop_end'` (internal socket)

**Test guard:** `INT-3` in `connect-to-existing.integration.test.tsx` runs `test.each` across 6 graph fixtures (F1 single Start, F2 linear chain, F3 diamond half-built, F4 fan-out cap, F5 inside-Loop source, F6 pre-existing duplicate) asserting set equality between `getEligibleConnectTargets` output and the manually-composed onConnect predicate. **Do not weaken this test.**

### 3.2 Loop container → `loop_start` remap

The canvas data model splits a loop into three nodes: a top-level `loop` container plus two child sockets `loop_start` and `loop_end` (with `parentId = loop.id`). Engine-wise the legal way to wire an outer node into a loop is to target `loop_start` — that's the `isOuterToLoopStart` carve-out at `workflow-canvas-helpers.ts:102`.

In the picker we hide `loop_start` and `loop_end` (users shouldn't see the internal sockets) and show only the `loop` container. When the user clicks a `loop` card, the click handler in `ConnectToExistingSection.tsx` resolves the loop's internal `loop_start` child and passes _that_ id to `onConnect`. The end-user UX is "I picked Loop"; the engine receives the correct entry socket.

If a loop container has no `loop_start` child (defensive — the store auto-creates one), we fall back to the loop id and `onConnect` rejects it cleanly.

### 3.3 Tab UI uses the shared `<Tabs>` component

`HandlePlusMenu` uses `apps/studio/src/components/ui/Tabs.tsx` — the same component the workflow detail page header uses. Icon + label + animated underline (Framer Motion `layoutId="add-step-tab-indicator"`). Keyboard nav (Arrow keys, Home/End) is inherited. Don't reimplement.

### 3.4 Modal sizing

`HandlePlusMenu.tsx` wraps both tabs' contents in a `<div className="min-h-[480px]">` so the modal does NOT shrink when the user switches from "Add new" (tall categorised grid) to "Add existing" with an empty state (just one line of copy). Both tabs render at the same physical size.

### 3.5 Sticky tab bar / search header was tried and reverted

A previous iteration made the tab bar + search input `sticky top-0` so they stayed visible while scrolling. Reverted at the user's request — current behavior is the header scrolls with the content. Don't re-introduce sticky without product input.

### 3.6 Tooltips on cards

Each card uses native `title` + `aria-label` attributes set to the full node label. When a long label truncates inside the card (`text-sm font-medium truncate`), the browser shows the full name on hover. Lightweight, accessible, no `<TooltipProvider>` wrap needed. The Radix `<Tooltip>` component exists at `apps/studio/src/components/ui/Tooltip.tsx` but requires provider mounting — overkill for this case.

### 3.7 `MergerNodeConfig` auto-engages — do not touch it

When a node's in-degree reaches ≥2, the existing `MergerNodeConfig` panel auto-renders in that node's config panel and lets the user mark required predecessors. This feature does NOT modify `MergerNodeConfig` — it just causes the panel to engage more often (every picker-created edge that lands on an already-incoming-edge'd node). Convergence UX is delivered for free.

---

## 4. Testing status

### Passes locally

```
Test Files  3 passed (3)
     Tests  33 passed (33)
```

- `apps/studio/src/store/__tests__/get-eligible-connect-targets.test.ts` — 11/11
- `apps/studio/src/__tests__/connect-to-existing.integration.test.tsx` — 11/11
- `apps/studio/src/__tests__/canvas-fanout.test.tsx` — 11/11 (pre-existing, verifying no regression from the `MAX_FAN_OUT` export change)

### Typecheck

`pnpm exec tsc --noEmit` clean across `@agent-platform/studio`.

### Smoke check (Playwright)

`apps/studio/e2e/connect-to-existing-smoke.spec.ts` passes against a live dev environment. Captures screenshots at `apps/studio/e2e/screenshots/smoke-*.png`. This file is a one-off; delete after UAT-11 specs are running.

### Not yet running

- **UAT-11.1 through UAT-11.5** in `workflow-canvas-uat.spec.ts` were written for the original "section at bottom" UX (before the tabbed refactor). They need one line each — clicking `[data-testid="add-step-tab-existing"]` after opening the menu — before they'll pass.

### Test-spec items deferred

Two scenarios are deliberately deferred per feature spec §7:

1. **Multi-user editing race** — candidate deleted between menu-open and click. Defensive behaviour (toast vs silent no-op) is not yet decided.
2. **Fan-out cap edge-case UX** — source handle already at 10 outgoing edges when modal opens. Should the section hide and show "Fan-out limit reached"? Not decided.

Both surfaces are caught defensively by `onConnect`'s existing guards (the picker just sees an empty eligibility list once cap is reached; the duplicate/race rejection is silent), so neither is a blocker for ship.

---

## 5. Critical code snippets (for review without opening the patch)

> The full diff is in the patch file; the four blocks below are the
> ones that matter for understanding the design. Everything else is
> mostly rendering/layout glue.

### 6.1 The eligibility helper (`workflow-canvas-helpers.ts`)

```ts
export function getEligibleConnectTargets<TData extends { nodeType: NodeType }>(
  nodes: Node<TData>[],
  edges: Edge[],
  sourceNodeId: string,
  sourceHandle: string,
  maxFanOut: number,
): Node<TData>[] {
  const fanOutCount = edges.filter(
    (e) => e.source === sourceNodeId && e.sourceHandle === sourceHandle,
  ).length;
  if (fanOutCount >= maxFanOut) return [];

  return nodes.filter((candidate) => {
    if (candidate.id === sourceNodeId) return false;
    if (candidate.data.nodeType === 'start') return false;
    if (candidate.data.nodeType === 'loop_start') return false;
    if (candidate.data.nodeType === 'loop_end') return false;

    const isDuplicate = edges.some(
      (e) =>
        e.source === sourceNodeId && e.sourceHandle === sourceHandle && e.target === candidate.id,
    );
    if (isDuplicate) return false;

    return isValidWorkflowConnection(edges, nodes, {
      source: sourceNodeId,
      sourceHandle,
      target: candidate.id,
      targetHandle: null,
    });
  });
}
```

### 6.2 Click handler with loop → loop_start remap (`ConnectToExistingSection.tsx`)

```tsx
const handlePick = useCallback(
  (targetNodeId: string) => {
    // Loop containers are picked by the user, but the actual engine
    // target is the loop's internal `loop_start` socket — the validator's
    // outer→loop_start carve-out allows it. Resolve the container to its
    // loop_start child here so the picker UX hides the implementation
    // detail completely.
    const picked = nodes.find((n) => n.id === targetNodeId);
    let resolvedTarget = targetNodeId;
    if (picked?.data.nodeType === 'loop') {
      const loopStart = nodes.find(
        (n) => n.parentId === picked.id && n.data.nodeType === 'loop_start',
      );
      if (loopStart) resolvedTarget = loopStart.id;
    }

    onConnect({
      source: sourceNodeId,
      sourceHandle,
      target: resolvedTarget,
      targetHandle: null,
    });
    onClose();
  },
  [onConnect, sourceNodeId, sourceHandle, onClose, nodes],
);
```

### 6.3 Type-section grouping for the Add-existing card grid (`ConnectToExistingSection.tsx`)

```tsx
const groupedSections = useMemo(() => {
  const groups = new Map<NodeType, WorkflowFlowNode[]>();
  for (const node of filtered) {
    const t = node.data.nodeType as NodeType;
    const list = groups.get(t);
    if (list) list.push(node);
    else groups.set(t, [node]);
  }

  // Order types per the Add-new tab's canonical layout:
  // CATEGORY_ORDER outer loop, MENU_NODE_TYPES inner loop.
  const ordered: { type: NodeType; nodes: WorkflowFlowNode[] }[] = [];
  const seen = new Set<NodeType>();
  for (const cat of CATEGORY_ORDER) {
    for (const t of MENU_NODE_TYPES) {
      if (NODE_CATEGORY_MAP[t] === cat && groups.has(t) && !seen.has(t)) {
        ordered.push({ type: t, nodes: groups.get(t)! });
        seen.add(t);
      }
    }
  }
  // Safety net: unknown types still surface, just at the bottom.
  for (const [t, list] of groups) {
    if (!seen.has(t)) ordered.push({ type: t, nodes: list });
  }
  return ordered;
}, [filtered]);
```

### 6.4 Tab bar wiring (`HandlePlusMenu.tsx`)

```tsx
<Tabs
  tabs={[
    {
      id: 'new',
      label: 'Add new',
      icon: <PlusSquare className="w-4 h-4" />,
      testid: 'add-step-tab-new',
    },
    {
      id: 'existing',
      label: 'Add existing',
      icon: <Link2 className="w-4 h-4" />,
      testid: 'add-step-tab-existing',
    },
  ]}
  activeTab={tab}
  onTabChange={(id) => setTab(id as 'new' | 'existing')}
  layoutId="add-step-tab-indicator"
/>
```

### 6.5 Predicate-parity test fixture (`connect-to-existing.integration.test.tsx`)

The single most valuable test in the suite — asserts that `getEligibleConnectTargets` and the composite `onConnect` predicate accept/reject the exact same node set across 6 graph fixtures. If they drift, the picker either shows options the store rejects or hides options the store would accept. **Do not weaken this test.**

```tsx
function composeOnConnectPredicate(
  nodes: WorkflowFlowNode[],
  edges: WorkflowFlowEdge[],
  source: string,
  sourceHandle: string,
): Set<string> {
  const fanOutCount = edges.filter(
    (e) => e.source === source && e.sourceHandle === sourceHandle,
  ).length;
  if (fanOutCount >= MAX_FAN_OUT) return new Set();

  const accepted = new Set<string>();
  for (const n of nodes) {
    if (n.id === source) continue;
    const isDuplicate = edges.some(
      (e) => e.source === source && e.sourceHandle === sourceHandle && e.target === n.id,
    );
    if (isDuplicate) continue;
    const valid = isValidWorkflowConnection(edges, nodes, {
      source,
      sourceHandle,
      target: n.id,
      targetHandle: null,
    });
    if (valid) accepted.add(n.id);
  }
  return accepted;
}

test.each(fixtures)('parity holds for $name', (fx) => {
  const eligible = getEligibleConnectTargets(
    fx.nodes,
    fx.edges,
    fx.source,
    fx.sourceHandle,
    MAX_FAN_OUT,
  );
  const eligibleIds = new Set(eligible.map((n) => n.id));
  const wouldAccept = composeOnConnectPredicate(fx.nodes, fx.edges, fx.source, fx.sourceHandle);
  expect(eligibleIds).toEqual(wouldAccept);
});
```

---

## 6. Manual verification

```bash
# 1. Ensure the standard dev stack is up
pnpm --filter @agent-platform/studio dev          # 5173
pnpm --filter @agent-platform/runtime dev         # 3112
# (MongoDB / Redis via Docker per the standard setup)

# 2. In Studio:
#    - Open or create a workflow with at least one node beyond Start
#    - Click the "+" on any node's output handle
#    - Verify the tab bar appears: "Add new" | "Add existing"
#    - Default tab: Add new (categorised cards visible)
#    - Click "Add existing" — should show eligible nodes grouped by type
#    - Type in the search — both tabs filter their own content
#    - Click a card in either tab; modal closes and the edge appears
#    - For a Loop container card: edge lands on the loop's internal entry socket
#    - Verify a target node with in-degree ≥2 shows MergerNodeConfig in its config panel

# 3. Run unit + integration tests
cd apps/studio
pnpm exec vitest run src/store/__tests__/get-eligible-connect-targets.test.ts \
                     src/__tests__/connect-to-existing.integration.test.tsx \
                     src/__tests__/canvas-fanout.test.tsx

# 4. Typecheck
pnpm exec tsc --noEmit
```

---

## 7. Known follow-ups (not blocking ship)

| #   | Item                                                                                                                                                                          | Effort                           |
| --- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------- |
| F1  | Update `UAT-11.1`–`UAT-11.5` in `workflow-canvas-uat.spec.ts` to click `add-step-tab-existing` before picker assertions                                                       | < 1 hour                         |
| F2  | LLD decision on multi-user race + fan-out-cap UX → amend test spec §2 E2E-6 with concrete steps                                                                               | Product input needed             |
| F3  | Decide on sort order WITHIN a type group — currently alphabetical by label (UT-10 asserts deterministic). Could switch to canvas insertion order if user feedback prefers it. | Trivial code change once decided |
| F4  | Delete `apps/studio/e2e/connect-to-existing-smoke.spec.ts` once UAT-11 specs are running green                                                                                | < 5 min                          |
| F5  | Consider a brighter visual cue when search returns "no matches" in either tab                                                                                                 | Design call                      |

---

## 8. Commit

The change is uncommitted. When ready, suggested commit message:

```
[ABLP-<ticket>] feat(studio): connect to existing node in Add Step modal
```

- Use a real JIRA ticket key — never invent one. Reuse an existing canvas/workflow ticket or create one fresh.
- Run `npx prettier --write` on all changed files before committing (the pre-commit hook auto-formats staged files but agents should still run prettier explicitly).
- Commit scope is borderline — verify with `git diff --stat` that file count is ≤ 40 and package count is ≤ 3 (per root `CLAUDE.md` commit-scope guard). Current diff sits at ~10 production files + 3 test files + 4 doc files = within bounds.
- After commit, map SHA back to the JIRA ticket: `pnpm jira:update -- ABLP-<ticket> --comment "Implemented in <sha>"`.

For full-pipeline closure, also run:

```
/post-impl-sync workflow-connect-to-existing-node
```

to sync the feature spec status (PLANNED → ALPHA), the testing index, and the parent `workflows.md` references.

---

## 9. Why I rejected the alternative approaches you might be tempted to try

- **Merging `loop` + `loop_start` into one node.** Doable, but costs a custom React Flow renderer that handles container + interior-socket roles simultaneously, plus new edge metadata (`kind: 'body' | 'continue'`) to disambiguate enter-vs-pass-through edges. Schema/executor/validator/serializer all touched. Not a UI-only change.
- **Showing already-connected nodes muted with a checkmark instead of hiding them.** The current rule (hide what `onConnect` would reject) keeps the picker→onConnect parity invariant cheap to test. Surfacing-with-state requires the picker to model rejection reasons, which complicates UT-3 and the parity test.
- **Replacing native `title` with the Radix `<Tooltip>` component.** Requires mounting `<TooltipProvider>` somewhere up the tree. Marginal UX gain over native `title` for the truncation case. Not worth the wiring.
- **Sticky tab bar + search header.** Tried, reverted at user request. Keep the header in-flow.

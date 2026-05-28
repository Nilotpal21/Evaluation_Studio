# Test Specification: Workflow Canvas Context Suggestions

**Feature Spec**: `docs/features/sub-features/workflow-canvas-context-suggestions.md`
**HLD**: `docs/specs/workflow-canvas-context-suggestions.hld.md`
**LLD**: N/A (not yet authored)
**Status**: IN PROGRESS
**Package(s)**: `apps/studio`
**Last Updated**: 2026-05-04

---

## 1. Coverage Matrix

| FR         | Description                                                                  | Unit       | Integration | E2E        | Manual | Status  |
| ---------- | ---------------------------------------------------------------------------- | ---------- | ----------- | ---------- | ------ | ------- |
| FR-1       | All expression-bearing inputs in all node configs use ExpressionInput        | —          | ✅ planned  | ✅ planned | ✓ done | PARTIAL |
| FR-2       | ContextExplorer displays 6 categories with correct expression paths          | ✅ planned | ✅ planned  | ✅ planned | ✓ done | PARTIAL |
| FR-3       | Step key uses canvas label, not UUID                                         | ✅ planned | ✅ planned  | ✅ planned | ✓ done | PARTIAL |
| FR-4       | `{{` auto-opens explorer; insert without brace-doubling                      | ✅ planned | ✅ planned  | ✅ planned | ✓ done | PARTIAL |
| FR-5       | Search filters all categories; Escape closes without inserting               | ✅ planned | —           | ✅ planned | ✓ done | PARTIAL |
| FR-6       | useWorkflowExpressionContext BFS traversal correctness                       | ✅ planned | ✅ planned  | —          | ✓ done | PARTIAL |
| FR-7       | All 6 categories always rendered; empty category shows "No fields available" | ✅ planned | ✅ planned  | ✅ planned | ✓ done | PARTIAL |
| FR-5 error | Escape / outside-click closes without insertion                              | ✅ planned | —           | ✅ planned | ✓ done | PARTIAL |
| GAP-006    | Node rename stale-reference (no test until cascade implemented)              | —          | —           | —          | —      | BLOCKED |

---

## 2. E2E Test Scenarios

> All E2E tests use Playwright. Start the Studio dev server before running. No mocks of existing components. No direct DB access. Interact only through the browser and the real dev-login API.
>
> **Note**: E2E-2, E2E-3, E2E-6 exercise runtime expression resolution and are cross-feature validation against the workflow engine expression resolver (parent feature). They verify that Studio-generated expression paths are valid at runtime, not just syntactically correct in the config.

### E2E-1: `{{` auto-trigger → select trigger payload expression → no brace-doubling

- **Preconditions**: Dev server running. Workflow exists with a Start node declaring `inputVariable: message (string)`, connected to a TextToText node. Open the workflow canvas.
- **Steps**:
  1. Click the TextToText node → ConfigPanel opens with Human Prompt textarea.
  2. Click into the Human Prompt textarea.
  3. Type `Hello ` then type `{{`.
  4. Assert: ContextExplorer popover appears automatically.
  5. Assert: Trigger category is pre-expanded, showing `trigger.payload.message` leaf.
  6. Click `trigger.payload.message` leaf.
  7. Assert: Human Prompt value is `Hello {{trigger.payload.message}}` — no doubled `{{{{`.
  8. Assert: ContextExplorer popover has closed.
  9. Assert: Human Prompt value does NOT contain `{{{{` anywhere (brace-doubling regression guard).
- **Expected Result**: Explorer auto-opens on `{{`; selection inserts at cursor replacing the pending `{{`; result is exactly `Hello {{trigger.payload.message}}` with no doubled braces.
- **Auth Context**: dev-login as `workflow-canvas@e2e-smoke.test`; first project.
- **Isolation Check**: Canvas store state is scoped to the open workflow only; no other workflow data visible.
- **Test File**: `apps/studio/e2e/workflows/expression-authoring.spec.ts`

### E2E-2: `{⋮}` button on API node URL → upstream step label (not UUID) → runtime resolution

- **Preconditions**: Workflow with Start node → **Function node** (canvas label `FnUrl0001`, code: `return { output: "https://httpbin.org/get" }`) → API node. Use a Function node (not Agent/TextToText) to guarantee deterministic output without LLM credentials. Open canvas.
- **Steps**:
  1. Click the API node → ConfigPanel opens.
  2. Click the `{⋮}` icon button on the URL field.
  3. Assert: ContextExplorer opens.
  4. Expand the Nodes category.
  5. Assert: Entry labelled `FnUrl0001` is visible (not a UUID like `node-abc123`).
  6. Click `FnUrl0001` → expand → click `output` leaf.
  7. Assert: URL field value is `{{steps.FnUrl0001.output}}`.
  8. Save workflow. Execute workflow.
  9. Assert: Workflow execution debug panel shows the API node's resolved URL is `https://httpbin.org/get` (not `undefined`). The Function node's output resolved correctly via the label-based step key.
- **Expected Result**: Expression path uses canvas label `FnUrl0001`; resolves to the function's return value at runtime, confirming the step-key bug fix is end-to-end correct.
- **Auth Context**: dev-login; first project.
- **Isolation Check**: N/A (client-side expression; runtime execution is in the project scope).
- **Test File**: `apps/studio/e2e/workflows/expression-authoring.spec.ts`

### E2E-3: Condition node field with upstream step output → execute → condition evaluates

- **Preconditions**: Workflow with Start → **Function node** (canvas label `FnStatus0001`, code: `return { output: "Request approved" }`) → Condition node. Use a Function node for deterministic output (TextToText requires LLM credentials and is non-deterministic). Open canvas.
- **Steps**:
  1. Click Condition node → ConfigPanel opens.
  2. Click `{⋮}` on the Field input.
  3. ContextExplorer opens → Nodes category → expand `FnStatus0001` → click `output`.
  4. Assert: Field value is `{{steps.FnStatus0001.output}}`.
  5. Set Operator to `contains`. Set Value to `approved`.
  6. Save workflow. Execute.
  7. Assert: Condition evaluates to `true` (the "true" branch executes in the debug panel).
- **Expected Result**: Label-based expression resolves against the Function node's output; condition branch correctly taken.
- **Auth Context**: dev-login; first project.
- **Test File**: `apps/studio/e2e/workflows/expression-authoring.spec.ts`

### E2E-4: All 6 categories visible in ContextExplorer regardless of workflow topology

- **Preconditions**: Workflow with only a Start node (no other nodes). Open canvas.
- **Steps**:
  1. Click Start node's connected API stub node if present, or add a TextToText node and click it.
  2. Click `{⋮}` on any input field.
  3. Assert: ContextExplorer is visible.
  4. Assert: The following 6 category headers are present: **Trigger**, **Nodes**, **Context**, **Memory**, **Agent Session**, **Agent Context**.
  5. Click `Nodes` category header to expand.
  6. Assert: "No fields available" message is shown (no upstream nodes).
  7. Click `Trigger` to expand.
  8. Assert: "No fields available" (no Start inputVariables configured).
  9. Click `Context` to expand.
  10. Assert: Leaves include `{{workflow.id}}`, `{{workflow.name}}`, `{{workflow.executionId}}`, `{{tenant.tenantId}}`, `{{tenant.projectId}}`.
  11. Click `Memory` to expand. Assert: Shows `{{memory.workflow}}`, `{{memory.project}}`, `{{memory.user}}`.
- **Expected Result**: All 6 categories render regardless of workflow topology; empty categories show "No fields available" rather than being hidden.
- **Auth Context**: dev-login; first project.
- **Test File**: `apps/studio/e2e/workflows/expression-authoring.spec.ts`

### E2E-5: Escape closes ContextExplorer without inserting; outside-click closes without inserting

- **Preconditions**: Workflow with any node. Open canvas.
- **Steps** (Escape path):
  1. Click node → ConfigPanel → click `{⋮}` on an input field.
  2. Assert: ContextExplorer is open.
  3. Press `Escape`.
  4. Assert: ContextExplorer is closed.
  5. Assert: Input field value is unchanged (no expression was inserted).
- **Steps** (outside-click path):
  1. Click `{⋮}` again to re-open ContextExplorer.
  2. Click outside the ContextExplorer panel (on the canvas background).
  3. Assert: ContextExplorer is closed.
  4. Assert: Input field value is unchanged.
- **Expected Result**: Both Escape and outside-click dismiss the explorer without side effects.
- **Auth Context**: dev-login; first project.
- **Test File**: `apps/studio/e2e/workflows/expression-authoring.spec.ts`

### E2E-6: Loop source from upstream Function node output → runtime array iteration

- **Preconditions**: Workflow with **Function node** (canvas label `FnList0001`, code: `return { output: ["a", "b", "c"] }`) → Loop node. A Function node is used instead of an API node to avoid external HTTP dependency in CI. Open canvas.
- **Steps**:
  1. Click Loop node → Source field → click `{⋮}`.
  2. ContextExplorer → Nodes → `FnList0001` → `output` → click.
  3. Assert: Source field is `{{steps.FnList0001.output}}`.
  4. Save. Execute workflow.
  5. Assert: Debug panel shows the Loop node iterating 3 times (items `"a"`, `"b"`, `"c"`).
- **Expected Result**: Loop source resolves to a 3-element array via the Function node; loop iterates correctly with label-based expression.
- **Note**: If an API node variant is needed for production realism, configure the URL to `https://httpbin.org/get` and parse the JSON response in a subsequent Function node before passing to the Loop source.
- **Auth Context**: dev-login; first project.
- **Test File**: `apps/studio/e2e/workflows/expression-authoring.spec.ts`

### E2E-ERR-1: Canvas with no upstream nodes → Nodes category shows "No fields available"

- **Preconditions**: Workflow with a single TextToText node (no edges into it).
- **Steps**:
  1. Click TextToText node → `{⋮}` on Human Prompt.
  2. ContextExplorer opens → expand Nodes category.
  3. Assert: "No fields available" message is visible inside the Nodes category.
  4. Assert: Explorer does NOT crash, show an error, or show a blank panel.
- **Expected Result**: Graceful empty state for the Nodes category when BFS yields no upstream nodes.
- **Auth Context**: dev-login; first project.
- **Test File**: `apps/studio/e2e/workflows/expression-authoring.spec.ts`

### E2E-ERR-2: Canvas with no Start node → Trigger category shows "No fields available"

- **Preconditions**: Workflow canvas with a TextToText node but no Start node (or Start node not connected).
- **Steps**:
  1. Click TextToText node → `{⋮}` on Human Prompt.
  2. ContextExplorer opens → expand Trigger category.
  3. Assert: "No fields available" (no start node found by hook).
  4. Assert: Other categories (Context, Memory, Agent Session, Agent Context) still render with their static fields.
- **Expected Result**: Missing Start node does not crash the explorer; Trigger category gracefully shows empty state while static categories remain functional.
- **Auth Context**: dev-login; first project.
- **Test File**: `apps/studio/e2e/workflows/expression-authoring.spec.ts`

---

## 3. Integration Test Scenarios

> Integration tests use Vitest + React Testing Library with a real Zustand store (pre-populated via `useWorkflowCanvasStore.setState()`). No `vi.mock()` of platform components. Only external services (not applicable here) may be mocked.

### INT-1: `useWorkflowExpressionContext` — BFS traversal finds all upstream nodes

- **Boundary**: `useWorkflowExpressionContext` hook ↔ `useWorkflowCanvasStore` (real store)
- **Setup**: Pre-populate store: Start → NodeA → NodeB → NodeC (current). Nodes: Start (nodeType=start), NodeA (label='AgentAlpha'), NodeB (label='TextBeta'), NodeC (label='Condition0001') as the target. Edges: Start→NodeA, NodeA→NodeB, NodeB→NodeC.
- **Steps**: Call `renderHook(() => useWorkflowExpressionContext('NodeC-id'), { wrapper })`.
- **Expected Result**: `previousSteps` = [AgentAlpha, TextBeta]; `AgentAlpha.id === 'AgentAlpha'`; `TextBeta.id === 'TextBeta'`; Start node NOT included.
- **Failure Mode**: BFS bug → missing upstream step → expression not available in UI.
- **Test File**: `apps/studio/src/components/workflows/canvas/hooks/__tests__/useWorkflowExpressionContext.test.ts`

### INT-2: Step key uses canvas label, not node UUID

- **Boundary**: `useWorkflowExpressionContext` hook ↔ canvas store
- **Setup**: Store with one upstream node: `{ id: 'uuid-9f3a', data: { label: 'Agent0001', nodeType: 'agent' } }`. Edge: uuid-9f3a → current-node-id.
- **Steps**: `renderHook(() => useWorkflowExpressionContext('current-node-id'))`.
- **Expected Result**: `previousSteps[0].id === 'Agent0001'` (NOT `'uuid-9f3a'`).
- **Failure Mode**: UUID regression → `steps.uuid-9f3a.output` never resolves at runtime.
- **Test File**: `apps/studio/src/components/workflows/canvas/hooks/__tests__/useWorkflowExpressionContext.test.ts`

### INT-3: `triggerPayload` derived from Start node `inputVariables`

- **Boundary**: `useWorkflowExpressionContext` hook ↔ canvas store (Start node config)
- **Setup**: Start node with `data.config.inputVariables = [{ name: 'email', type: 'string' }, { name: 'amount', type: 'number' }]`.
- **Steps**: `renderHook(() => useWorkflowExpressionContext('any-non-start-id'))`.
- **Expected Result**: `triggerPayload === { email: 'string', amount: 'number' }`.
- **Failure Mode**: Missing trigger fields → Trigger category empty for real variables.
- **Test File**: `apps/studio/src/components/workflows/canvas/hooks/__tests__/useWorkflowExpressionContext.test.ts`

### INT-4: ContextExplorer — Memory, Agent Session, Agent Context categories render correct paths

- **Boundary**: `ContextExplorer` component rendering with empty props
- **Setup**: Render `<ContextExplorer triggerPayload={{}} previousSteps={[]} onSelect={vi.fn()} />`. Expand Memory category.
- **Steps**: Assert rendered leaves have exact expression values.
- **Expected Result**:
  - Memory: `{{memory.workflow}}`, `{{memory.project}}`, `{{memory.user}}`
  - Agent Session: `{{agentSession.sessionId}}`, `{{agentSession.agentName}}`, `{{agentSession.channel}}`, `{{agentSession.source}}`, `{{agentSession.endUserId}}`, `{{agentSession.locale}}`, `{{agentSession.startedAt}}`, `{{agentSession.lastActivityAt}}`
  - Agent Context `caller`: `{{agentContext.caller.type}}`, `{{agentContext.caller.id}}`
  - Agent Context `invocation`: `{{agentContext.invocation.tool}}`, `{{agentContext.invocation.args}}`
  - Agent Context leaf: `{{agentContext.messageMetadata}}`
  - Agent Context `attachments[0]`: `{{agentContext.attachments[0].id}}`, `{{agentContext.attachments[0].name}}`, `{{agentContext.attachments[0].mimeType}}`, `{{agentContext.attachments[0].sizeBytes}}`
  - Context: `{{workflow.id}}`, `{{workflow.name}}`, `{{workflow.executionId}}`, `{{tenant.tenantId}}`, `{{tenant.projectId}}`
- **Test File**: `apps/studio/src/components/workflows/steps/__tests__/ContextExplorer.test.tsx`

### INT-5: ExpressionInput — brace-doubling prevention when `{{` already typed

- **Boundary**: `ExpressionInput` component cursor logic
- **Setup**: Render `<ExpressionInput value="hello {{" onChange={...} triggerPayload={{}} previousSteps={[]} />` with cursor at end (position 9).
- **Steps**: Simulate user selecting expression `{{trigger.payload.x}}` from ContextExplorer (call `onSelect('{{trigger.payload.x}}')` on the ExpressionInput with cursor at position 9).
- **Expected Result**: `onChange` called with `"hello {{trigger.payload.x}}"` — the pending `{{` at positions 6-7 is replaced, NOT doubled to `"hello {{{{trigger.payload.x}}"`.
- **Test File**: `apps/studio/src/components/workflows/canvas/config/__tests__/ApiNodeConfig.expression.test.tsx`

### INT-6: Node with undefined/empty label — fallback behavior

- **Boundary**: `useWorkflowExpressionContext` hook ↔ canvas store (malformed node data)
- **Setup**: Store with upstream node `{ id: 'uuid-123', data: { label: undefined, nodeType: 'agent' } }`. Edge: uuid-123 → current-id.
- **Steps**: `renderHook(() => useWorkflowExpressionContext('current-id'))`.
- **Expected Result**: `previousSteps[0].id` is `undefined` (documenting the unguarded edge case per oracle Q15). The test MUST NOT silently pass with `'uuid-123'`. This test documents the current behavior and serves as a regression trap when a defensive fallback is added.
- **Note**: When a guard (`id: n.data.label ?? n.id`) is added, update this test to assert `previousSteps[0].id === 'uuid-123'`.
- **Test File**: `apps/studio/src/components/workflows/canvas/hooks/__tests__/useWorkflowExpressionContext.test.ts`

### INT-7: ExpressionInput + ContextExplorer composition — open, search, select, close

- **Boundary**: ExpressionInput (parent) ↔ ContextExplorer (child) state management
- **Setup**: Render `<ExpressionInput value="" onChange={onChange} triggerPayload={{ url: 'string' }} previousSteps={[{ id: 'ApiNode', name: 'ApiNode' }]} />`.
- **Steps**:
  1. Click the `{⋮}` button → assert ContextExplorer is visible in DOM.
  2. Type `api` in the search input → assert Nodes category shows `ApiNode`, Trigger hidden.
  3. Click `ApiNode` leaf (the `{{steps.ApiNode.output}}` leaf) → assert ContextExplorer closes.
  4. Assert `onChange` was called with `'{{steps.ApiNode.output}}'`.
- **Test File**: `apps/studio/src/components/workflows/canvas/config/__tests__/ApiNodeConfig.expression.test.tsx`

### INT-8: BFS — diamond merge does not produce duplicate steps

- **Boundary**: `useWorkflowExpressionContext` hook ↔ canvas store (diamond topology)
- **Setup**: Nodes A→C and B→C, both A and B also connected to current. Start → A → C → current; Start → B → C → current (diamond via C).
- **Steps**: `renderHook(() => useWorkflowExpressionContext('current-id'))`.
- **Expected Result**: `previousSteps` contains A, B, C each exactly once. Length = 3.
- **Test File**: `apps/studio/src/components/workflows/canvas/hooks/__tests__/useWorkflowExpressionContext.test.ts`

---

## 4. Unit Test Scenarios

### UT-1: BFS returns empty array for node with no incoming edges

- **Module**: `useWorkflowExpressionContext`
- **Input**: Store with 3 nodes, no edges connecting to the current node.
- **Expected Output**: `previousSteps === []`

### UT-2: `triggerPayload` returns `{}` when Start node has no inputVariables

- **Module**: `useWorkflowExpressionContext`
- **Input**: Start node with `data.config = {}`.
- **Expected Output**: `triggerPayload === {}`

### UT-3: `triggerPayload` returns `{}` when inputVariables is null or non-array

- **Module**: `useWorkflowExpressionContext`
- **Inputs**: `inputVariables = null`, `inputVariables = "string"`, `inputVariables = 42`
- **Expected Output**: `{}` for all inputs (non-array guard)

### UT-4: ContextExplorer search — query filters label and expression simultaneously

- **Module**: `ContextExplorer` (via filterNodes helper)
- **Input**: Query `"tenant"`, nodes include `{ label: 'Tenant ID', expression: '{{tenant.tenantId}}' }` and `{ label: 'Project ID', expression: '{{tenant.projectId}}' }` and `{ label: 'Workflow ID', expression: '{{workflow.id}}' }`.
- **Expected Output**: Both tenant nodes returned; Workflow ID excluded.

### UT-5: ContextExplorer search — returns empty array for no-match query

- **Module**: `ContextExplorer`
- **Input**: Query `"xyznonexistent"`
- **Expected Output**: All filtered arrays empty; "No matching expressions found" message shown.

### UT-6: ExpressionInput — `hasPendingBraces` detection

- **Module**: `ExpressionInput` (cursor logic)
- **Input**: value = `"prefix {{"`, cursor at position 10 (end).
- **Expected Output**: `hasPendingBraces === true`; insert start = 8 (cursor - 2).

### UT-7: ExpressionInput — insert at cursor without pending braces

- **Module**: `ExpressionInput`
- **Input**: value = `"before "`, cursor at 7; select expression `{{steps.X.output}}`.
- **Expected Output**: `"before {{steps.X.output}}"` — expression appended at cursor, no brace stripping.

### UT-8: ExpressionInput — insert replaces pending `{{` when hasPendingBraces

- **Module**: `ExpressionInput`
- **Input**: value = `"before {{"`, cursor at 10; select expression `{{steps.X.output}}`.
- **Expected Output**: `"before {{steps.X.output}}"` — the `{{` at positions 7-8 replaced, NOT `"before {{{{steps.X.output}}"`.

---

## 5. Security & Isolation Tests

This feature is purely client-side (no API calls, no DB access, no server-side component). Standard server-level security tests do not apply. The following client-side isolation checks apply:

| Check                                          | Test Approach                                                                                                                          | Notes                                                                                                                      |
| ---------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------- |
| Canvas store scoped to current project         | Verify `useWorkflowExpressionContext` only reads nodes/edges from the Zustand store (which is populated for the current workflow only) | The isolation is provided by Studio's auth middleware and the workflow page loader; no cross-project data enters the store |
| No PII in design-time schema                   | Assert `triggerPayload` contains only variable _names_ and _declared types_, not runtime values                                        | Design-time only; actual values never pass through the Studio canvas                                                       |
| Expression paths are plain strings             | Assert that `onSelect` callbacks receive plain strings like `{{trigger.payload.x}}` — no code execution, no eval                       | Expressions are evaluated server-side by `expression-resolver.ts` under the existing security boundary                     |
| ContextExplorer does not make network requests | Assert no `fetch` / XHR calls are made when ContextExplorer opens or searches                                                          | Static schema constants only; verified by code review (no fetch in component source)                                       |

---

## 6. Performance Tests

Not applicable for ALPHA. The feature's performance characteristics are:

- `useMemo` on both `triggerPayload` and `previousSteps` — recomputes only when `nodes`/`edges` change.
- BFS traversal is O(N+E); canvases are bounded (<200 nodes). No perf test needed.
- ContextExplorer search filters synchronously over a bounded in-memory tree; no debounce needed.

Re-evaluate if workflow canvas grows beyond 200 nodes (unlikely based on current product constraints).

---

## 7. Test Infrastructure

### Required Services

| Scenario Type                                  | Services Required                                          |
| ---------------------------------------------- | ---------------------------------------------------------- |
| Unit tests (UT-\*)                             | None — Vitest + happy-dom, no services                     |
| Integration tests (INT-\*)                     | None — Vitest + React Testing Library + real Zustand store |
| E2E tests (E2E-\*) canvas-only                 | Studio dev server on port 5173 (Next.js)                   |
| E2E tests (E2E-2, E2E-3, E2E-6) with execution | Studio (5173) + Runtime (3112) + MongoDB + workflow-engine |

### Test Runner

- **Unit + Integration**: Vitest 4.x, `environment: 'happy-dom'`, `@testing-library/react` v16, `@testing-library/user-event`
- **E2E**: Playwright (headless Chromium), `apps/studio/e2e/workflows/`

### Data Seeding

- **Unit/Integration**: Use `useWorkflowCanvasStore.setState({ nodes: [...], edges: [...] })` in `beforeEach`. Reset store in `afterEach` via `useWorkflowCanvasStore.setState(initialState)` to prevent state leakage between tests.
- **E2E (workflow creation)**: Create test workflow via the Studio UI (navigate to Workflows → New Workflow). Use `loginAndSetup()` from `apps/studio/e2e/workflows/helpers.ts`.
- **E2E (node/edge setup within canvas)**: Per `apps/studio/e2e/workflows/agents.md` guidance, canvas node positioning is fragile via pointer interaction. Prefer programmatic setup via the Zustand store (`page.evaluate(() => useWorkflowCanvasStore.getState().addNode(...))`) for adding nodes and edges to the canvas before the test assertion steps. Only interact with the config panel (clicks on nodes, `{⋮}` buttons, ContextExplorer) via Playwright page interactions.

### Prerequisites: `__tests__` Directory Creation

The unit/integration test files reference `__tests__/` directories that do not yet exist. Create them as part of test implementation:

- `apps/studio/src/components/workflows/canvas/hooks/__tests__/`
- `apps/studio/src/components/workflows/steps/__tests__/`
- `apps/studio/src/components/workflows/canvas/config/__tests__/`

### Required `data-testid` Additions

These must be added to components before E2E tests can run. None exist currently (GAP from oracle Q9):

| Component         | Element                 | Proposed data-testid                      |
| ----------------- | ----------------------- | ----------------------------------------- |
| `ExpressionInput` | Container div           | `expression-input`                        |
| `ExpressionInput` | `{⋮}` open button       | `expression-explorer-btn`                 |
| `ContextExplorer` | Root container div      | `context-explorer`                        |
| `ContextExplorer` | Search input            | `context-explorer-search`                 |
| `ContextExplorer` | Category section button | `context-explorer-category-{categoryKey}` |
| `ContextExplorer` | Leaf insert button      | `context-explorer-leaf-{expressionKey}`   |

### Environment Variables

None required beyond the standard Studio dev environment.

### CI Configuration

Add `expression-authoring.spec.ts` to the Playwright workflow run. Unit/integration tests are picked up automatically by Vitest since they match `**/__tests__/**/*.test.ts`.

---

## 8. Test File Mapping

| Test File                                                                                          | Type               | Covers                                                          |
| -------------------------------------------------------------------------------------------------- | ------------------ | --------------------------------------------------------------- |
| `apps/studio/src/components/workflows/canvas/hooks/__tests__/useWorkflowExpressionContext.test.ts` | unit + integration | FR-3, FR-6, INT-1, INT-2, INT-3, INT-6, INT-8, UT-1, UT-2, UT-3 |
| `apps/studio/src/components/workflows/steps/__tests__/ContextExplorer.test.tsx`                    | unit + integration | FR-2, FR-5, FR-7, INT-4, UT-4, UT-5                             |
| `apps/studio/src/components/workflows/canvas/config/__tests__/ApiNodeConfig.expression.test.tsx`   | unit + integration | FR-1, FR-4, INT-5, INT-7, UT-6, UT-7, UT-8                      |
| `apps/studio/e2e/workflows/expression-authoring.spec.ts`                                           | e2e                | FR-1 through FR-7, E2E-1 through E2E-6, E2E-ERR-1, E2E-ERR-2    |

---

## 9. Open Testing Questions

1. **data-testids for E2E**: None exist on ExpressionInput or ContextExplorer. These must be added before E2E tests can use reliable selectors. The table in §7 lists the proposed testids. This is a prerequisite for all E2E tests.

2. **Zustand store population pattern**: No existing unit test in `apps/studio` demonstrates the `useWorkflowCanvasStore.setState()` pattern without `vi.mock`. The first test to implement INT-1 will establish this pattern. Check `apps/studio/src/__tests__/setup.tsx` to see if any store reset/cleanup is already configured between tests.

3. **E2E execution tier prerequisite**: E2E-2, E2E-3, and E2E-6 require executing a full workflow against the runtime (Port 3112). These tests should be tagged `@requires-engine` in the spec file so they can be skipped in CI environments where the runtime is not running.

4. **ExpressionInput cursor testing in happy-dom**: Cursor position (`selectionStart`, `selectionEnd`) manipulation in `<textarea>` elements may behave differently in happy-dom vs browser. If INT-5 and UT-6/7/8 are unreliable, escalate to Playwright integration-mode tests instead.

5. **GAP-006 test placeholder**: Once the rename-cascade feature is implemented in `useWorkflowCanvasStore`, add a test: "rename node after authoring expression → assert expression is updated automatically". Currently BLOCKED.

---

## Known Gaps

- **GAP-005** (High): No automated tests exist yet. All scenarios above are PLANNED.
- **GAP-001** (High): `outputSchema` always `undefined` — sub-field traversal for steps not testable until schema registry exists.
- **GAP-006** (High): Node rename does not propagate to existing expressions — `{{steps.<old-label>.output}}` becomes stale after a rename. No test can be written until the rename-cascade is implemented.
- **data-testids missing**: ExpressionInput and ContextExplorer have no `data-testid` attributes. Must be added before E2E tests can run reliably (see §7 Required data-testid Additions).

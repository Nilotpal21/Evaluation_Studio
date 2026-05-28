# Test Spec: Project Canvas (#46)

> **Status**: PLANNED
> **Feature ID**: #46
> **Feature Spec**: `docs/features/project-canvas.md`
> **Last Updated**: 2026-03-22

---

## 1. Test Strategy

The Project Canvas feature is a **Studio-only, client-side** feature with no new backend API endpoints. Testing focuses on:

- **E2E tests**: Verify the full user journey through the real Studio HTTP API and browser interactions.
- **Integration tests**: Verify component composition, store interactions, and SWR data flow without mocking codebase components.
- **Unit tests**: Verify pure utility functions (view mode persistence, KPI computation, status derivation).

### Test Boundaries

| Layer       | What to Test                                                                   | What NOT to Mock                      |
| ----------- | ------------------------------------------------------------------------------ | ------------------------------------- |
| E2E         | Full page rendering, navigation, view toggle, agent interactions via HTTP API  | Any codebase component                |
| Integration | Component composition, store updates, SWR cache behavior                       | Zustand stores, SWR, React components |
| Unit        | Pure functions: status derivation, KPI formatting, responsive breakpoint logic | N/A (no dependencies)                 |

### External Dependencies (May Be Mocked)

| Dependency                     | Mock Strategy                                           |
| ------------------------------ | ------------------------------------------------------- |
| Runtime API (topology, agents) | Test server with real Express middleware on random port |
| Deployment API                 | Test server returning controlled deployment data        |
| next-intl translations         | Real translation files (test locale)                    |

---

## 2. E2E Test Scenarios

All E2E tests interact via HTTP API only. No `vi.mock()`, no direct DB access, no stubbed servers.

### E2E-1: Canvas Page Renders with Agents

**Objective**: Verify the unified canvas page loads and displays agent topology for a project with agents.

**Preconditions**:

- Project exists with at least 3 agents (one supervisor, two workers)
- Agents have handoff/delegate relationships
- At least one agent has an active deployment

**Steps**:

1. Start Studio server on random port with real middleware chain
2. Authenticate via API login endpoint
3. Navigate to `GET /projects/{projectId}` (canvas page)
4. Wait for topology rendering (ReactFlow container present in DOM)
5. Assert: KPI bar shows correct agent count (3)
6. Assert: Canvas renders 3 agent nodes
7. Assert: Edges visible between related agents
8. Assert: Deployed agent node has green status indicator
9. Assert: Draft agents have gray status indicator

**Expected Result**: Canvas page renders topology with correct node count, edge relationships, and health indicators.

### E2E-2: View Mode Toggle Persistence

**Objective**: Verify canvas/list toggle works and persists across page navigation.

**Preconditions**:

- Project exists with agents

**Steps**:

1. Navigate to project canvas page (default view)
2. Click list view toggle button
3. Assert: Agent list renders (card grid visible, canvas hidden)
4. Navigate away to sessions page
5. Navigate back to project canvas page
6. Assert: List view is still active (persisted in localStorage)
7. Click canvas view toggle button
8. Assert: Canvas renders again
9. Refresh the page
10. Assert: Canvas view is active (persisted)

**Expected Result**: View mode preference survives navigation and page refresh.

### E2E-3: Empty Project Onboarding

**Objective**: Verify empty project shows appropriate onboarding state.

**Preconditions**:

- Project exists with zero agents

**Steps**:

1. Navigate to project canvas page
2. Assert: Empty state illustration visible
3. Assert: "Create First Agent" button visible
4. Assert: "Import Agents" button visible
5. Click "Create First Agent"
6. Assert: CreateAgentDialog opens
7. Close dialog
8. Click "Import Agents"
9. Assert: ImportDialog opens

**Expected Result**: Empty project shows CTA buttons that open the correct dialogs.

### E2E-4: Agent Node Interaction

**Objective**: Verify clicking agent nodes opens detail slider and updates URL hash.

**Preconditions**:

- Project with at least 2 agents

**Steps**:

1. Navigate to project canvas page
2. Click on an agent node
3. Assert: AgentEditorSlider opens with correct agent name
4. Assert: URL hash updates to `#agent/{agentName}`
5. Close the slider
6. Assert: URL hash is cleared
7. Navigate directly to `#agent/{agentName}` via URL
8. Assert: Slider opens automatically for that agent

**Expected Result**: Agent node click opens slider; URL hash enables deep linking.

### E2E-5: KPI Bar Navigation

**Objective**: Verify KPI metric clicks navigate to corresponding detail pages.

**Preconditions**:

- Project with agents and sessions

**Steps**:

1. Navigate to project canvas page
2. Assert: KPI bar shows agent count, session count, deployment count
3. Click the sessions KPI metric
4. Assert: Navigation occurs to sessions list page
5. Navigate back to canvas page
6. Click the agents KPI metric
7. Assert: Navigation occurs to agents list page
8. Navigate back to canvas page
9. Click the deployments KPI metric
10. Assert: Navigation occurs to deployments page

**Expected Result**: Each KPI metric is clickable and navigates to the correct detail page.

### E2E-6: Responsive Fallback to List View

**Objective**: Verify mobile viewport automatically switches to list view.

**Preconditions**:

- Project with agents

**Steps**:

1. Set viewport to desktop width (1280px)
2. Navigate to project canvas page
3. Assert: Canvas is visible
4. Resize viewport to mobile width (375px)
5. Assert: Canvas is hidden, list view is shown automatically
6. Resize viewport back to desktop width
7. Assert: Canvas is visible again

**Expected Result**: Canvas hides on narrow viewports; list view renders as fallback.

### E2E-7: Context Menu Actions

**Objective**: Verify right-click context menu on agent nodes provides quick actions.

**Preconditions**:

- Project with agents, at least one deployed

**Steps**:

1. Navigate to project canvas page
2. Right-click on an agent node
3. Assert: Context menu appears with "Edit DSL", "Open Chat", "View Sessions", "Deploy"
4. Click "Open Chat"
5. Assert: Navigation to chat page with agent pre-selected
6. Navigate back to canvas
7. Right-click on agent without DSL (skeleton)
8. Assert: "Open Chat" and "Deploy" are grayed out

**Expected Result**: Context menu shows appropriate actions based on agent state.

---

## 3. Integration Test Scenarios

Integration tests verify component composition with real stores and SWR, but use controlled API responses via test servers.

### INT-1: KPI Bar Data Aggregation

**Objective**: Verify KPI bar correctly aggregates data from multiple SWR endpoints.

**Setup**:

- Render `ProjectCanvasPage` with SWR provider
- Mock API server returns: 5 agents, 12 sessions, 2 active deployments, 1 compile error

**Assertions**:

- Agent count metric shows "5"
- Session count metric shows "12"
- Deployment count metric shows "2 / 5"
- Error indicator shows "1 error"
- All metric values update when SWR re-fetches (mutate triggers)

### INT-2: View Mode Store Integration

**Objective**: Verify canvas-store view mode preference integrates correctly with component rendering.

**Setup**:

- Render `ProjectCanvasPage` with real Zustand store
- Set initial view mode to 'canvas' in store

**Assertions**:

- Canvas component renders (ReactFlow container present)
- Toggle to 'list' mode updates store
- List component renders (agent card grid present)
- Canvas component unmounts (ReactFlow container absent)
- Store value persists (read from localStorage)

### INT-3: Agent Status Derivation

**Objective**: Verify agent node status is correctly derived from deployment and topology data.

**Setup**:

- Render canvas with agents in different states:
  - Agent A: has active production deployment -> 'deployed'
  - Agent B: no deployment, no errors -> 'draft'
  - Agent C: compile error in topology response -> 'error'

**Assertions**:

- Agent A node has `data-status="deployed"` attribute
- Agent B node has `data-status="draft"` attribute
- Agent C node has `data-status="error"` attribute
- Status badge colors match: green/gray/red

### INT-4: Navigation Store Wiring

**Objective**: Verify ProjectCanvasPage integrates correctly with navigation store for routing.

**Setup**:

- Render AppShell with navigation store set to `{ area: 'project', page: 'canvas', projectId: 'test-123' }`

**Assertions**:

- ProjectCanvasPage component renders (not ProjectOverviewPage)
- Sidebar shows "Canvas" nav item as active
- Breadcrumb shows project name > Canvas
- Navigating to 'overview' page renders ProjectOverviewPage instead

### INT-5: SWR Cache Sharing Between Views

**Objective**: Verify canvas and list views share the same SWR cache (no double-fetching).

**Setup**:

- Render `ProjectCanvasPage` in canvas mode
- SWR fetches agents, topology, deployments
- Toggle to list mode

**Assertions**:

- No additional SWR fetch calls (cache hit)
- Agent data is identical in both views
- Mutating agent data updates both views

### INT-6: Collapsible KPI Bar State

**Objective**: Verify KPI bar collapse/expand state persists and works correctly.

**Setup**:

- Render `ProjectCanvasPage` with KPI bar visible (default)

**Assertions**:

- KPI bar renders with metrics visible
- Click collapse chevron: KPI bar animates to collapsed state
- Canvas area expands to fill available space
- Refresh/re-render: KPI bar remains collapsed (persisted)
- Click expand chevron: KPI bar animates back

### INT-7: Resource Badges on Agent Nodes

**Objective**: Verify agent nodes display correct resource badge counts.

**Setup**:

- Render canvas with agents
- Agent A has 3 tools and 1 knowledge base linked
- Agent B has 0 tools and 0 knowledge bases

**Assertions**:

- Agent A node shows "3 tools, 1 KB" badge
- Agent B node shows no resource badge (clean node)
- Clicking Agent A's badge shows popover with tool names
- Popover closes on click outside

---

## 4. Unit Test Scenarios

### UNIT-1: View Mode Persistence Helper

```
describe('viewModePersistence', () => {
  it('returns "canvas" when no stored preference')
  it('returns stored preference when set')
  it('persists new preference to localStorage')
  it('falls back to "list" on mobile viewport')
})
```

### UNIT-2: Agent Status Derivation

```
describe('deriveAgentStatus', () => {
  it('returns "deployed" when agent has active production deployment')
  it('returns "deployed" when agent has active staging deployment')
  it('returns "error" when agent name is in error set')
  it('returns "draft" when agent has no deployment and no errors')
  it('prioritizes "error" over "deployed" when both conditions exist')
})
```

### UNIT-3: KPI Metric Formatting

```
describe('formatKpiValue', () => {
  it('formats numbers < 1000 as-is')
  it('formats numbers >= 1000 with K suffix')
  it('formats numbers >= 1M with M suffix')
  it('shows em-dash for null/undefined values')
  it('formats deployment ratio as "X / Y"')
})
```

### UNIT-4: Responsive Breakpoint Logic

```
describe('shouldShowCanvas', () => {
  it('returns true for viewport >= 768px')
  it('returns false for viewport < 768px')
  it('returns false when user preference is "list"')
  it('returns true when user preference is "canvas" and viewport >= 768px')
})
```

---

## 5. Coverage Matrix

| Functional Req              | E2E   | Integration | Unit   | Coverage    |
| --------------------------- | ----- | ----------- | ------ | ----------- |
| FR-01 Unified page          | E2E-1 | INT-4       | -      | Full        |
| FR-02 Health status overlay | E2E-1 | INT-3       | UNIT-2 | Full        |
| FR-03 KPI metric bar        | E2E-5 | INT-1       | UNIT-3 | Full        |
| FR-04 View mode toggle      | E2E-2 | INT-2       | UNIT-1 | Full        |
| FR-05 Resource badges       | -     | INT-7       | -      | Integration |
| FR-06 Context menu          | E2E-7 | -           | -      | E2E         |
| FR-07 Empty onboarding      | E2E-3 | -           | -      | E2E         |
| FR-08 Slider + deep link    | E2E-4 | -           | -      | E2E         |
| FR-09 Keyboard shortcuts    | E2E-2 | -           | -      | Partial     |
| FR-10 Responsive layout     | E2E-6 | -           | UNIT-4 | Full        |
| FR-11 Loading skeleton      | -     | INT-1       | -      | Integration |
| FR-12 Import/Export         | E2E-3 | -           | -      | E2E         |
| FR-13 SWR data fetching     | E2E-1 | INT-5       | -      | Full        |
| FR-14 Navigation store      | -     | INT-4       | -      | Integration |
| FR-15 Sidebar nav item      | -     | INT-4       | -      | Integration |

---

## 6. Test Environment Requirements

| Requirement             | Details                                       |
| ----------------------- | --------------------------------------------- |
| Studio dev server       | Real Next.js server on random port            |
| Runtime API mock server | Express on random port, full middleware       |
| Browser automation      | Playwright (existing setup in `apps/studio/`) |
| Test data seeding       | Via POST API endpoints (never direct DB)      |
| Translation files       | Real next-intl locale files                   |
| Viewport testing        | Playwright viewport resizing                  |

---

## 7. Edge Cases & Error Scenarios

| Scenario                           | Test             | Expected Behavior                                                   |
| ---------------------------------- | ---------------- | ------------------------------------------------------------------- |
| Topology API returns 500           | E2E fallback     | Show error state with retry button, KPI bar still renders           |
| Agent has no DSL content           | INT-3            | Node renders with "no DSL" indicator, context menu actions limited  |
| 0 agents, 0 sessions               | E2E-3            | Empty onboarding state                                              |
| 50+ agents (large project)         | Performance test | Canvas renders within 2s, `onlyRenderVisibleElements` active        |
| SWR cache stale                    | INT-5            | Background re-fetch triggers UI update without flicker              |
| localStorage unavailable           | UNIT-1           | Falls back to default view mode ('canvas')                          |
| Network offline after initial load | E2E              | Canvas continues to display cached data, KPIs show stale indicators |

---

## 8. Performance Test Criteria

| Metric                          | Target   | Measurement                   |
| ------------------------------- | -------- | ----------------------------- |
| Canvas first render (5 agents)  | < 500ms  | Performance API marks         |
| Canvas first render (50 agents) | < 2000ms | Performance API marks         |
| View mode toggle                | < 100ms  | No re-fetch, instant DOM swap |
| KPI bar render                  | < 200ms  | Parallel SWR fetch            |
| Node click to slider open       | < 300ms  | Animation start               |

# High-Level Design: Project Canvas (#46)

> **Status**: PLANNED
> **Feature Spec**: `docs/features/project-canvas.md`
> **Test Spec**: `docs/testing/project-canvas.md`
> **Last Updated**: 2026-03-22

---

## 1. Architecture Overview

The Project Canvas feature introduces a unified visual project landing page in Studio that combines the existing `ProjectCanvas` (ReactFlow topology), a KPI summary bar, and a list/canvas view toggle. It is a **client-side only** feature within `apps/studio/` requiring no new backend API endpoints.

### Component Architecture

```
AppShell (routing)
  |
  +-- ProjectCanvasPage (new — orchestrator)
  |     |
  |     +-- CanvasKpiBar (new — collapsible metric summary)
  |     |     +-- MetricCard (existing UI component) x N
  |     |
  |     +-- ViewModeToggle (new — canvas/list switch)
  |     |
  |     +-- [canvas mode]
  |     |     +-- ProjectCanvas (existing — enhanced with status overlays)
  |     |           +-- AgentNode (existing — enhanced with status badge + resource badges)
  |     |           +-- AgentEditorSlider (existing)
  |     |           +-- ConnectionTypePicker (existing)
  |     |           +-- AgentContextMenu (new — right-click actions)
  |     |
  |     +-- [list mode]
  |     |     +-- AgentListView (extracted from AgentListPage)
  |     |
  |     +-- [empty state]
  |           +-- CanvasEmptyState (new — CTA buttons)
  |
  +-- ProjectOverviewPage (existing — unchanged, accessible via sidebar)
```

### Data Flow

```
SWR Cache (shared)
  |
  +-- /api/projects/{id}/agents --> agents[]
  +-- /api/projects/{id}/topology --> topology (nodes, edges, summaries)
  +-- deployments fetcher --> deployments[]
  +-- /api/projects/{id}/tools --> tools[]
  +-- /api/projects/{id}/workflows --> workflows[]
  +-- /api/search-ai/knowledge-bases --> knowledgeBases[]
  +-- useSessionList(projectId) --> sessions[]
  |
  v
ProjectCanvasPage
  |
  +-- Derives: agentCount, sessionCount, deploymentCount, errorCount
  +-- Derives: agentStatuses (deployed/draft/error per agent)
  +-- Derives: resourceCounts per agent (tools, KBs)
  +-- Passes to: CanvasKpiBar, ProjectCanvas, AgentListView
```

---

## 2. Twelve Architectural Concerns

### 2.1 Security

**Impact**: LOW — No new API endpoints. All data access uses existing authenticated SWR endpoints scoped to the current project (`/api/projects/{projectId}/...`).

**Approach**:

- Reuse existing SWR fetchers with auth headers (already wired via `apiFetch`)
- No new sensitive data exposure — same data as ProjectOverviewPage and AgentListPage
- Context menu actions navigate via existing routes (no new permission checks needed)

### 2.2 Tenant & Project Isolation

**Impact**: LOW — No direct API calls. All existing fetchers include `projectId` scoping.

**Approach**:

- Canvas state in Zustand store is keyed by `projectId` (existing pattern in `canvas-store.ts`)
- View mode preference is global (not per-project), stored in localStorage with a non-project-specific key
- No cross-project data leakage possible since SWR keys include `projectId`

### 2.3 Performance

**Impact**: MEDIUM — Canvas rendering for large projects (50+ agents) is the primary concern.

**Approach**:

- **Existing optimization**: `onlyRenderVisibleElements` when `topology.nodes.length > 15` (already in ProjectCanvas)
- **Parallel SWR fetches**: KPI data (agents, deployments, sessions) fetches in parallel, canvas does not block on KPI completion
- **View toggle is instant**: Both canvas and list components receive the same SWR-cached data; no re-fetch on toggle
- **Lazy rendering**: List view uses virtualization for 50+ agents (existing pattern in AgentListPage)
- **ELK layout caching**: Layout computed once, positions persisted in canvas-store (existing)

**Target**: P95 canvas render < 2000ms for 50 agents.

### 2.4 Scalability

**Impact**: LOW — Client-side only, no new server load.

**Approach**:

- SWR deduplication ensures multiple components sharing the same key don't duplicate API calls
- Canvas viewport state bounded to 50 projects max (existing `canvas-store` eviction)
- No new WebSocket subscriptions

### 2.5 Reliability & Error Handling

**Impact**: MEDIUM — Must gracefully handle partial data failures.

**Approach**:

- **Topology API failure**: Show error state with retry button; KPI bar still renders from agent/deployment data
- **Deployment API failure**: KPI bar shows "—" for deployment count; canvas nodes show 'draft' status
- **Session API failure**: KPI bar shows "—" for session count; canvas unaffected
- **SWR error boundaries**: Each SWR hook handles its own error state independently
- Follows existing error pattern: `{ success: false, error: { code, message } }`

### 2.6 Observability

**Impact**: LOW — Frontend only, existing browser telemetry.

**Approach**:

- Performance marks for canvas render time (`performance.mark('canvas-page-render-start')`)
- Analytics events: `canvas_view_loaded`, `view_mode_toggled`, `kpi_clicked`, `context_menu_action`
- Console warnings for unexpected topology data shapes (development only)

### 2.7 Data Model

**Impact**: NONE — No new database models. All data comes from existing API responses.

**New client-side state**:

```typescript
// Addition to canvas-store or new preference-store
interface CanvasPagePreferences {
  viewMode: 'canvas' | 'list'; // persisted to localStorage
  kpiBarCollapsed: boolean; // persisted to localStorage
}
```

**Derived state** (computed per render, not persisted):

```typescript
interface AgentCanvasStatus {
  agentName: string;
  status: 'deployed' | 'draft' | 'error';
  deploymentEnv?: 'production' | 'staging' | 'development';
  toolCount: number;
  kbCount: number;
}
```

### 2.8 API Design

**Impact**: NONE — No new API endpoints. All data sourced from existing endpoints:

| Data            | Endpoint                                            | Existing? |
| --------------- | --------------------------------------------------- | --------- |
| Agents          | `GET /api/projects/{id}/agents`                     | Yes       |
| Topology        | `GET /api/projects/{id}/agents` (topology response) | Yes       |
| Deployments     | Runtime deployments API via `fetchDeployments()`    | Yes       |
| Tools           | `GET /api/projects/{id}/tools`                      | Yes       |
| Workflows       | `GET /api/projects/{id}/workflows`                  | Yes       |
| Knowledge Bases | `GET /api/search-ai/knowledge-bases?projectId={id}` | Yes       |
| Sessions        | `useSessionList(projectId)` hook                    | Yes       |

### 2.9 Accessibility

**Impact**: HIGH — Canvas interactions must be keyboard-accessible.

**Approach**:

- **View mode toggle**: Standard button with `aria-pressed` state, keyboard operable
- **KPI metrics**: Clickable cards with `role="link"`, `aria-label` describing metric and navigation target
- **Canvas nodes**: Existing ReactFlow keyboard navigation (Tab to focus, Enter to select)
- **Context menu**: `role="menu"` with `role="menuitem"`, keyboard arrow navigation, Escape to close
- **Collapsible KPI bar**: `aria-expanded` attribute, toggle button with descriptive label
- **Screen reader**: Announce view mode changes, KPI updates via `aria-live` region

### 2.10 Internationalization

**Impact**: MEDIUM — All new user-facing strings must be translated.

**Approach**:

- Add new i18n namespace `canvas` under existing next-intl setup
- Keys: `canvas.heading`, `canvas.view_canvas`, `canvas.view_list`, `canvas.kpi_agents`, `canvas.kpi_sessions`, `canvas.kpi_deployments`, `canvas.kpi_errors`, `canvas.empty_title`, `canvas.empty_description`, `canvas.empty_create`, `canvas.empty_import`, `canvas.context_edit`, `canvas.context_chat`, `canvas.context_sessions`, `canvas.context_deploy`
- Estimated: ~20 new translation keys
- Follows existing pattern: `useTranslations('canvas')`

### 2.11 Testing

**Impact**: HIGH — Full test matrix defined in test spec.

**Summary from test spec**:

- 7 E2E scenarios (Playwright, real servers, no mocks)
- 7 integration scenarios (real stores, SWR, controlled API)
- 4 unit test suites (pure functions)
- 15/15 functional requirements covered
- See `docs/testing/project-canvas.md` for full details

### 2.12 Deployment & Feature Flags

**Impact**: LOW — Client-side only, no phased rollout needed.

**Approach**:

- **No feature flag needed**: The canvas page is additive (overview page unchanged)
- **Sidebar navigation**: New "Canvas" item added below "Overview" in ProjectSidebar
- **Default view**: Overview remains the default project landing page; Canvas is opt-in via sidebar
- **Rollback**: Remove sidebar item and route mapping (zero risk)

---

## 3. Alternatives Considered

### Alternative A: Replace ProjectOverviewPage Entirely

**Description**: Make the canvas page the only project landing page, removing the overview dashboard.

**Pros**:

- Simpler navigation (one fewer page)
- Forces adoption of visual topology

**Cons**:

- Breaks existing user workflows who prefer list-based dashboards
- Canvas is impractical on mobile
- KPI-focused users lose their optimized view

**Decision**: REJECTED — The overview page serves a distinct user need (metrics-focused view). Canvas is additive.

### Alternative B: Embed Canvas in Existing Overview Page

**Description**: Add a collapsible canvas section within `ProjectOverviewPage` instead of creating a new page.

**Pros**:

- No new navigation item
- Users discover canvas organically
- Single page with all information

**Cons**:

- Page becomes too long/complex (metrics + full canvas + agent list + activity)
- Canvas needs full viewport height to be useful; sharing with other content defeats the purpose
- Harder to implement view mode toggle within an existing complex component

**Decision**: REJECTED — Canvas needs full viewport dedication. A separate page with its own compact KPI bar provides a better experience.

### Alternative C: Tab-Based Switching Within AgentListPage

**Description**: Add a "Canvas | List | Overview" tab bar at the top of `AgentListPage`, integrating KPIs as a third tab.

**Pros**:

- Reuses existing AgentListPage infrastructure
- Already has canvas toggle
- Fewer new components

**Cons**:

- AgentListPage is already 500+ lines; adding KPI logic increases complexity
- Overview tab would duplicate ProjectOverviewPage content
- Navigation semantics unclear (sidebar shows "Agents" but page renders overview)

**Decision**: REJECTED — Cleaner to have a dedicated page with clear purpose.

---

## 4. Component Design Details

### 4.1 ProjectCanvasPage

The orchestrator component that manages view state and data aggregation.

**Responsibilities**:

- Fetch all required data via SWR hooks
- Derive KPI values and agent statuses
- Render KPI bar, view toggle, and either canvas or list view
- Handle empty project state
- Manage import/export dialog state

**File location**: `apps/studio/src/components/canvas/ProjectCanvasPage.tsx`

### 4.2 CanvasKpiBar

Compact horizontal bar showing 4-5 KPI metrics with click-to-navigate.

**Props**:

```typescript
interface CanvasKpiBarProps {
  agentCount: number;
  sessionCount: number | null;
  deploymentRatio: string; // "2 / 5"
  errorCount: number;
  collapsed: boolean;
  onToggleCollapse: () => void;
  onMetricClick: (metric: 'agents' | 'sessions' | 'deployments' | 'errors') => void;
}
```

**File location**: `apps/studio/src/components/canvas/CanvasKpiBar.tsx`

### 4.3 ViewModeToggle

Two-button segmented control for canvas/list switching.

**Props**:

```typescript
interface ViewModeToggleProps {
  mode: 'canvas' | 'list';
  onModeChange: (mode: 'canvas' | 'list') => void;
}
```

**File location**: `apps/studio/src/components/canvas/ViewModeToggle.tsx`

### 4.4 AgentContextMenu

Right-click context menu for agent nodes.

**Props**:

```typescript
interface AgentContextMenuProps {
  agentName: string;
  hasDsl: boolean;
  isDeployed: boolean;
  position: { x: number; y: number };
  onAction: (action: 'edit' | 'chat' | 'sessions' | 'deploy') => void;
  onClose: () => void;
}
```

**File location**: `apps/studio/src/components/canvas/AgentContextMenu.tsx`

### 4.5 CanvasEmptyState

Empty project onboarding with create/import CTAs.

**File location**: `apps/studio/src/components/canvas/CanvasEmptyState.tsx`

---

## 5. Navigation & Routing Changes

### Navigation Store

Add `'canvas'` to `ProjectPage` type:

```typescript
export type ProjectPage =
  | 'overview'
  | 'canvas' // NEW
  | 'agents';
// ... rest unchanged
```

### AppShell Routing

Add route case for `page === 'canvas'` rendering `ProjectCanvasPage`.

### ProjectSidebar

Add navigation item:

```typescript
{ id: 'canvas', Icon: Network, key: 'sidebar.canvas' }
```

Positioned after "Overview" and before "Agents" in the sidebar.

---

## 6. State Management

### New Zustand Slice (canvas-page-store)

```typescript
interface CanvasPageState {
  viewMode: 'canvas' | 'list';
  kpiBarCollapsed: boolean;
  setViewMode: (mode: 'canvas' | 'list') => void;
  setKpiBarCollapsed: (collapsed: boolean) => void;
}
```

Uses `persist` middleware with `localStorage` key `'canvas-page-preferences'`.

**Alternative considered**: Extend existing `canvas-store.ts`. Rejected because `canvas-store` manages viewport/selection/data for the ReactFlow canvas itself, not page-level preferences. Separation of concerns keeps stores focused.

---

## 7. Migration & Backward Compatibility

- **No breaking changes**: ProjectOverviewPage and AgentListPage remain unchanged
- **No data migration**: All data from existing API endpoints
- **Sidebar addition**: New "Canvas" item appears for all users
- **Default behavior**: Overview remains the default project landing page
- **Rollback**: Remove the sidebar item, route mapping, and new components. Zero risk.

---

## 8. Dependency Graph

```
ProjectCanvasPage (new)
  ├── CanvasKpiBar (new)
  │   └── MetricCard (existing, apps/studio/src/components/ui/MetricCard.tsx)
  ├── ViewModeToggle (new)
  ├── ProjectCanvas (existing, enhanced)
  │   ├── AgentNode (existing, enhanced with status/resource badges)
  │   ├── AgentEditorSlider (existing)
  │   └── AgentContextMenu (new)
  ├── AgentListView (extracted from AgentListPage)
  ├── CanvasEmptyState (new)
  ├── ExportDialog (existing)
  ├── ImportDialog (existing)
  └── Zustand stores:
      ├── canvas-store (existing)
      ├── canvas-page-store (new)
      └── navigation-store (existing, extended)
```

**New files**: 5 components + 1 store + 1 i18n file = 7 files
**Modified files**: 3 (AppShell routing, ProjectSidebar nav, navigation-store type)
**Existing files reused as-is**: 8+

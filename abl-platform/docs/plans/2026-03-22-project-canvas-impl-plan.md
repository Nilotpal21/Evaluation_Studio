# Low-Level Design & Implementation Plan: Project Canvas (#46)

> **Status**: PLANNED
> **Feature Spec**: `docs/features/project-canvas.md`
> **Test Spec**: `docs/testing/project-canvas.md`
> **HLD**: `docs/specs/project-canvas.hld.md`
> **Last Updated**: 2026-03-22

---

## 1. Implementation Phases

This implementation is organized into 5 phases, ordered by dependency and risk.

### Phase 1: Foundation — Store, Types, Navigation Wiring

**Objective**: Establish the store, types, navigation route, and sidebar entry so the page is reachable.

**Files to Create**:

| File                                                     | Description                                           |
| -------------------------------------------------------- | ----------------------------------------------------- |
| `apps/studio/src/store/canvas-page-store.ts`             | Zustand store for view mode + KPI bar collapsed state |
| `apps/studio/src/components/canvas/types-canvas-page.ts` | Types for AgentCanvasStatus, KPI props, view mode     |

**Files to Modify**:

| File                                                       | Change                                     |
| ---------------------------------------------------------- | ------------------------------------------ |
| `apps/studio/src/store/navigation-store.ts`                | Add `'canvas'` to `ProjectPage` union type |
| `apps/studio/src/components/navigation/ProjectSidebar.tsx` | Add "Canvas" nav item after "Overview"     |
| `apps/studio/src/components/navigation/AppShell.tsx`       | Add route case for `page === 'canvas'`     |

**Detailed Changes**:

#### 1.1 canvas-page-store.ts

```typescript
import { create } from 'zustand';
import { persist } from 'zustand/middleware';

interface CanvasPageState {
  viewMode: 'canvas' | 'list';
  kpiBarCollapsed: boolean;
  setViewMode: (mode: 'canvas' | 'list') => void;
  setKpiBarCollapsed: (collapsed: boolean) => void;
}

export const useCanvasPageStore = create<CanvasPageState>()(
  persist(
    (set) => ({
      viewMode: 'canvas',
      kpiBarCollapsed: false,
      setViewMode: (viewMode) => set({ viewMode }),
      setKpiBarCollapsed: (kpiBarCollapsed) => set({ kpiBarCollapsed }),
    }),
    {
      name: 'canvas-page-preferences',
      partialize: (state) => ({
        viewMode: state.viewMode,
        kpiBarCollapsed: state.kpiBarCollapsed,
      }),
    },
  ),
);
```

#### 1.2 types-canvas-page.ts

```typescript
export type ViewMode = 'canvas' | 'list';

export type AgentStatus = 'deployed' | 'draft' | 'error';

export interface AgentCanvasStatus {
  agentName: string;
  status: AgentStatus;
  deploymentEnv?: 'production' | 'staging' | 'development';
  toolCount: number;
  kbCount: number;
}

export interface CanvasKpiData {
  agentCount: number;
  sessionCount: number | null;
  activeDeployments: number;
  totalAgents: number;
  errorCount: number;
}
```

#### 1.3 navigation-store.ts

Add `'canvas'` after `'overview'` in the `ProjectPage` type union.

#### 1.4 ProjectSidebar.tsx

Add nav item:

```typescript
{ id: 'canvas' as ProjectPage, Icon: Network, key: 'sidebar.canvas' }
```

Position: after "Overview", before "Agents".

#### 1.5 AppShell.tsx

Add import and route case:

```typescript
import { ProjectCanvasPage } from '../canvas/ProjectCanvasPage';
// In renderPage():
case 'canvas': return <ProjectCanvasPage />;
```

**Exit Criteria**:

- [ ] `canvas-page-store.ts` exists and exports `useCanvasPageStore`
- [ ] Navigation to `/projects/{id}/canvas` renders a placeholder component
- [ ] "Canvas" item appears in ProjectSidebar between Overview and Agents
- [ ] `ProjectPage` type includes `'canvas'`
- [ ] `pnpm build --filter=studio` passes
- [ ] No regressions in existing navigation (overview, agents pages still work)

---

### Phase 2: Core Page — ProjectCanvasPage + CanvasKpiBar + ViewModeToggle

**Objective**: Build the main orchestrator page with KPI bar and canvas/list toggle.

**Files to Create**:

| File                                                      | Description                   |
| --------------------------------------------------------- | ----------------------------- |
| `apps/studio/src/components/canvas/ProjectCanvasPage.tsx` | Main orchestrator component   |
| `apps/studio/src/components/canvas/CanvasKpiBar.tsx`      | Collapsible KPI metric bar    |
| `apps/studio/src/components/canvas/ViewModeToggle.tsx`    | Canvas/List segmented control |
| `apps/studio/src/components/canvas/CanvasEmptyState.tsx`  | Empty project CTA             |

**Detailed Changes**:

#### 2.1 ProjectCanvasPage.tsx

**Responsibilities**:

- SWR data fetching: agents, topology, deployments, tools, workflows, KBs, sessions
- Derive KPI values from SWR data
- Derive agent statuses from deployments + topology errors
- Render: loading skeleton, empty state, or KPI bar + view content
- Manage import/export dialog state

**Data Fetching Pattern** (mirrors ProjectOverviewPage):

```typescript
// Agents
const { data: agentData, isLoading: agentsLoading } = useSWR<RuntimeAgentListResponse>(
  projectId ? `/api/projects/${projectId}/agents` : null,
);

// Topology
const { data: topologyData } = useSWR<TopologyResponse>(
  projectId ? `/api/projects/${projectId}/agents?topology=true` : null,
);

// Deployments (custom fetcher)
const { data: deployData } = useSWR(projectId ? ['deployments', projectId] : null, () =>
  fetchDeployments(projectId!),
);

// Tools count
const { data: toolsData } = useSWR(
  projectId ? `/api/projects/${encodeURIComponent(projectId)}/tools` : null,
);

// Sessions
const { sessions } = useSessionList(projectId);
```

**Layout Structure**:

```
<div className="h-full flex flex-col">
  <PageHeader title={t('heading')} actions={viewToggle + importExport} />
  <CanvasKpiBar ... />
  <div className="flex-1 relative">
    {viewMode === 'canvas' ? <ProjectCanvas ... /> : <AgentListView ... />}
  </div>
</div>
```

**Phase Detection** (reuses ProjectOverviewPage pattern):

```typescript
type PagePhase = 'loading' | 'empty' | 'ready';
const phase: PagePhase = agentsLoading ? 'loading' : agents.length === 0 ? 'empty' : 'ready';
```

#### 2.2 CanvasKpiBar.tsx

**Structure**: Horizontal bar with 4 MetricCard components + collapse toggle.

```typescript
interface CanvasKpiBarProps {
  agentCount: number;
  sessionCount: number | null;
  deploymentRatio: string;
  errorCount: number;
  collapsed: boolean;
  onToggleCollapse: () => void;
  onMetricClick: (metric: 'agents' | 'sessions' | 'deployments' | 'errors') => void;
}
```

**Layout**: Uses existing `MetricCard` component in a `grid grid-cols-2 sm:grid-cols-4` layout. Collapse animation via Framer Motion `AnimatePresence` with height transition.

#### 2.3 ViewModeToggle.tsx

**Structure**: Two-button segmented control.

```typescript
interface ViewModeToggleProps {
  mode: 'canvas' | 'list';
  onModeChange: (mode: 'canvas' | 'list') => void;
}
```

Uses `LayoutGrid` (list) and `Network` (canvas) Lucide icons. Active state uses `bg-accent-subtle text-accent` with `aria-pressed`.

#### 2.4 CanvasEmptyState.tsx

Reuses `EmptyState` component with canvas-specific copy and CTAs:

- "Create First Agent" -> triggers CreateAgentDialog
- "Import Agents" -> triggers ImportDialog

**Exit Criteria**:

- [ ] ProjectCanvasPage renders with real data (agents, KPIs)
- [ ] KPI bar shows correct aggregate metrics
- [ ] KPI bar collapse/expand works with animation
- [ ] View mode toggle switches between canvas and list
- [ ] View mode persists in localStorage across navigation
- [ ] Empty state shows for projects with no agents
- [ ] Loading skeleton renders during data fetch
- [ ] Mobile viewport (< 768px) forces list view
- [ ] `pnpm build --filter=studio` passes
- [ ] No regressions in ProjectOverviewPage or AgentListPage

---

### Phase 3: Agent Node Enhancements — Status Badges + Resource Indicators

**Objective**: Enhance existing AgentNode with health status and resource badges.

**Files to Modify**:

| File                                                    | Change                                               |
| ------------------------------------------------------- | ---------------------------------------------------- |
| `apps/studio/src/components/canvas/nodes/AgentNode.tsx` | Add status indicator and resource badge              |
| `apps/studio/src/components/canvas/types.ts`            | Extend AgentNodeData with status and resource fields |

**Detailed Changes**:

#### 3.1 AgentNode.tsx Enhancements

Add to node data interface:

```typescript
interface AgentNodeData {
  // ... existing fields
  status?: 'deployed' | 'draft' | 'error';
  deploymentEnv?: string;
  toolCount?: number;
  kbCount?: number;
}
```

**Status Indicator**: Small colored dot (8x8px) in the top-right corner of the node:

- `deployed`: `bg-success` (green)
- `draft`: `bg-foreground-subtle/30` (gray)
- `error`: `bg-error` (red)

**Resource Badge**: Compact text below the node name:

```
[wrench icon] 3  [book icon] 1
```

Only shown when semantic zoom level is 'detail' (zoomed in enough).

#### 3.2 Data Plumbing in ProjectCanvasPage

Before passing topology to ProjectCanvas, enrich node data:

```typescript
const enrichedTopology = useMemo(() => {
  const agentStatuses = deriveAgentStatuses(agents, deployments, topologyErrors);
  return {
    ...topology,
    nodes: topology.nodes.map((node) => ({
      ...node,
      status: agentStatuses.get(node.name)?.status ?? 'draft',
      toolCount: agentToolCounts.get(node.name) ?? 0,
      kbCount: agentKbCounts.get(node.name) ?? 0,
    })),
  };
}, [topology, agents, deployments, topologyErrors]);
```

**Exit Criteria**:

- [ ] Deployed agent nodes show green status dot
- [ ] Draft agent nodes show gray status dot
- [ ] Error agent nodes show red status dot
- [ ] Resource badges show correct tool/KB counts
- [ ] Badges hidden at low zoom levels (semantic zoom)
- [ ] No visual regression in existing canvas usage (AgentListPage canvas toggle)
- [ ] `pnpm build --filter=studio` passes

---

### Phase 4: Context Menu + Keyboard Shortcuts

**Objective**: Add right-click context menu for agent nodes and keyboard shortcuts.

**Files to Create**:

| File                                                     | Description                        |
| -------------------------------------------------------- | ---------------------------------- |
| `apps/studio/src/components/canvas/AgentContextMenu.tsx` | Right-click context menu component |

**Files to Modify**:

| File                                                      | Change                        |
| --------------------------------------------------------- | ----------------------------- |
| `apps/studio/src/components/canvas/ProjectCanvasPage.tsx` | Wire context menu events      |
| `apps/studio/src/components/canvas/ProjectCanvas.tsx`     | Add onNodeContextMenu handler |

**Detailed Changes**:

#### 4.1 AgentContextMenu.tsx

Portal-rendered floating menu using absolute positioning:

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

**Menu Items**:
| Icon | Label | Action | Disabled When |
|------|-------|--------|--------------|
| Code | Edit DSL | Navigate to agent editor | Never |
| MessageSquare | Open Chat | Navigate to chat | No DSL |
| BarChart3 | View Sessions | Navigate to sessions filtered by agent | Never |
| Rocket | Deploy | Navigate to deployments | No DSL |

**Keyboard**: Arrow up/down to navigate, Enter to select, Escape to close.
**Accessibility**: `role="menu"`, `role="menuitem"`, `aria-disabled` for grayed items.

#### 4.2 Keyboard Shortcuts

Add to ProjectCanvasPage's keyboard handler:

| Key                | Action                         | Guard        |
| ------------------ | ------------------------------ | ------------ |
| `Cmd/Ctrl+Shift+V` | Toggle view mode               | Global       |
| `E`                | Open editor for selected agent | Not in input |
| `C`                | Open chat for selected agent   | Not in input |

**Exit Criteria**:

- [ ] Right-click on agent node shows context menu
- [ ] Menu items navigate correctly
- [ ] Disabled items (no DSL) are grayed out and non-interactive
- [ ] Keyboard navigation works (arrows, Enter, Escape)
- [ ] Cmd+Shift+V toggles view mode
- [ ] E/C shortcuts work for selected agent
- [ ] Menu closes on click outside
- [ ] `pnpm build --filter=studio` passes

---

### Phase 5: i18n, Polish, Tests

**Objective**: Add translations, finalize responsive behavior, write tests.

**Files to Create**:

| File                                                     | Description              |
| -------------------------------------------------------- | ------------------------ |
| i18n messages file for 'canvas' namespace                | ~20 translation keys     |
| `apps/studio/src/__tests__/project-canvas-page.test.tsx` | Unit + integration tests |

**Files to Modify**:

| File                           | Change                              |
| ------------------------------ | ----------------------------------- |
| `apps/studio/messages/en.json` | Add 'canvas' namespace translations |

**Detailed Changes**:

#### 5.1 i18n Keys

```json
{
  "canvas": {
    "heading": "Project Canvas",
    "view_canvas": "Canvas",
    "view_list": "List",
    "kpi_agents": "Agents",
    "kpi_sessions": "Sessions",
    "kpi_deployments": "Deployed",
    "kpi_errors": "Errors",
    "kpi_collapse": "Collapse metrics",
    "kpi_expand": "Expand metrics",
    "empty_title": "No agents yet",
    "empty_description": "Create your first agent or import an existing project to get started.",
    "empty_create": "Create First Agent",
    "empty_import": "Import Agents",
    "context_edit": "Edit DSL",
    "context_chat": "Open Chat",
    "context_sessions": "View Sessions",
    "context_deploy": "Deploy",
    "shortcut_toggle_view": "Toggle view mode",
    "loading": "Loading project canvas..."
  }
}
```

#### 5.2 Tests

**Unit tests** (in `project-canvas-page.test.tsx`):

- `deriveAgentStatuses()` — all status combinations
- `formatKpiValue()` — number formatting
- `shouldShowCanvas()` — responsive breakpoint logic

**Integration tests** (component rendering with real stores):

- KPI bar data aggregation
- View mode toggle + persistence
- Empty state rendering
- Navigation wiring

#### 5.3 Responsive Polish

- KPI bar: `grid grid-cols-2 sm:grid-cols-4` (stacks on mobile)
- Canvas: hidden below 768px, list view forced
- Context menu: position-aware (flips when near viewport edge)

**Exit Criteria**:

- [ ] All ~20 i18n keys present in en.json
- [ ] All strings in components use `useTranslations('canvas')`
- [ ] Unit tests pass for pure functions
- [ ] Integration tests pass for component composition
- [ ] Responsive layout works on mobile (375px), tablet (768px), desktop (1280px)
- [ ] Dark/light theme renders correctly
- [ ] `pnpm build --filter=studio` passes
- [ ] `pnpm test --filter=studio` passes

---

## 2. Utility Functions

### deriveAgentStatuses

```typescript
function deriveAgentStatuses(
  agents: RuntimeAgent[],
  deployments: Deployment[],
  errorAgentNames: Set<string>,
): Map<string, AgentCanvasStatus> {
  const deployedNames = new Map<string, string>(); // name -> env
  for (const d of deployments) {
    if (d.status === 'active') {
      deployedNames.set(d.entryAgentName, d.environment);
    }
  }

  const result = new Map<string, AgentCanvasStatus>();
  for (const agent of agents) {
    let status: AgentStatus = 'draft';
    let deploymentEnv: string | undefined;

    if (errorAgentNames.has(agent.name)) {
      status = 'error';
    } else if (deployedNames.has(agent.name)) {
      status = 'deployed';
      deploymentEnv = deployedNames.get(agent.name);
    }

    result.set(agent.name, {
      agentName: agent.name,
      status,
      deploymentEnv: deploymentEnv as AgentCanvasStatus['deploymentEnv'],
      toolCount: 0, // populated separately
      kbCount: 0, // populated separately
    });
  }
  return result;
}
```

### formatKpiValue

Reuse `formatNumber()` from `ProjectOverviewPage` (extract to shared utility):

```typescript
function formatKpiValue(n: number | null): string {
  if (n === null || n === undefined) return '\u2014';
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(1)}M`;
  if (n >= 1_000) return `${(n / 1_000).toFixed(1)}K`;
  return String(n);
}
```

---

## 3. File Inventory

### New Files (7)

| #   | File                                                      | Phase | Lines (est) |
| --- | --------------------------------------------------------- | ----- | ----------- |
| 1   | `apps/studio/src/store/canvas-page-store.ts`              | P1    | ~30         |
| 2   | `apps/studio/src/components/canvas/types-canvas-page.ts`  | P1    | ~30         |
| 3   | `apps/studio/src/components/canvas/ProjectCanvasPage.tsx` | P2    | ~250        |
| 4   | `apps/studio/src/components/canvas/CanvasKpiBar.tsx`      | P2    | ~100        |
| 5   | `apps/studio/src/components/canvas/ViewModeToggle.tsx`    | P2    | ~50         |
| 6   | `apps/studio/src/components/canvas/CanvasEmptyState.tsx`  | P2    | ~60         |
| 7   | `apps/studio/src/components/canvas/AgentContextMenu.tsx`  | P4    | ~120        |

**Total new lines**: ~640

### Modified Files (5)

| #   | File                                                       | Phase | Change                             |
| --- | ---------------------------------------------------------- | ----- | ---------------------------------- |
| 1   | `apps/studio/src/store/navigation-store.ts`                | P1    | Add `'canvas'` to ProjectPage type |
| 2   | `apps/studio/src/components/navigation/ProjectSidebar.tsx` | P1    | Add canvas nav item                |
| 3   | `apps/studio/src/components/navigation/AppShell.tsx`       | P1    | Add canvas route case              |
| 4   | `apps/studio/src/components/canvas/nodes/AgentNode.tsx`    | P3    | Status badge + resource badges     |
| 5   | `apps/studio/messages/en.json`                             | P5    | Add 'canvas' namespace             |

### Test Files (1)

| #   | File                                                     | Phase | Lines (est) |
| --- | -------------------------------------------------------- | ----- | ----------- |
| 1   | `apps/studio/src/__tests__/project-canvas-page.test.tsx` | P5    | ~200        |

---

## 4. Risk Assessment

| Risk                                         | Phase | Mitigation                                                                  |
| -------------------------------------------- | ----- | --------------------------------------------------------------------------- |
| AgentNode enhancement breaks existing canvas | P3    | Optional data fields with defaults; existing callers unaffected             |
| Large topology performance regression        | P2    | Reuse existing `onlyRenderVisibleElements`; measure with 50-agent test data |
| SWR cache key collision                      | P2    | Same keys as existing pages = cache sharing (feature, not bug)              |
| Context menu z-index conflict with canvas    | P4    | Render via portal; z-index above ReactFlow layers                           |
| View mode flicker on hydration               | P2    | Zustand persist with `skipHydration: false`; SSR renders null               |

---

## 5. Dependency Order

```
Phase 1 (Foundation)
  |
  v
Phase 2 (Core Page) -----> Phase 3 (Node Enhancements)
  |                              |
  v                              v
Phase 4 (Context Menu + KB Shortcuts)
  |
  v
Phase 5 (i18n, Polish, Tests)
```

Phase 3 can run in parallel with Phase 2 (AgentNode changes are independent of the page orchestrator). Phase 4 depends on both Phase 2 (page context) and Phase 3 (node data). Phase 5 depends on all prior phases.

---

## 6. Wiring Checklist

Critical integration points that MUST be verified:

- [ ] **AppShell routing**: `page === 'canvas'` renders `ProjectCanvasPage` (not a 404)
- [ ] **Sidebar highlight**: Canvas nav item shows active state when on canvas page
- [ ] **Breadcrumb**: Shows "Project Name > Canvas" when on canvas page
- [ ] **URL parsing**: `navigation-store.ts` `parseUrl()` correctly parses `/projects/{id}/canvas`
- [ ] **SWR keys**: All fetchers use same keys as existing pages (cache sharing)
- [ ] **Canvas store**: `canvas-page-store` is separate from `canvas-store` (no naming collision)
- [ ] **AgentNode data**: Status/resource fields are optional, defaulting to 'draft'/0/0
- [ ] **Context menu portal**: Renders outside ReactFlow container to avoid z-index issues
- [ ] **Keyboard shortcut guard**: Shortcuts don't fire when typing in inputs/textareas
- [ ] **Mobile breakpoint**: `matchMedia('(min-width: 768px)')` used consistently for responsive logic
- [ ] **Import/Export**: Dialogs work from canvas page (same as overview page)
- [ ] **Deep link**: `#agent/{name}` hash fragment works on canvas page

---

## 7. Implementation Estimates

| Phase                      | Effort          | Dependencies               |
| -------------------------- | --------------- | -------------------------- |
| Phase 1: Foundation        | 1-2 hours       | None                       |
| Phase 2: Core Page         | 3-4 hours       | Phase 1                    |
| Phase 3: Node Enhancements | 2-3 hours       | Phase 1 (parallel with P2) |
| Phase 4: Context Menu      | 2-3 hours       | Phase 2, Phase 3           |
| Phase 5: i18n + Tests      | 2-3 hours       | Phase 4                    |
| **Total**                  | **10-15 hours** |                            |

# Feature Spec: Project Canvas (#46)

> **Status**: PLANNED
> **Feature ID**: #46
> **Scope**: `apps/studio`
> **Last Updated**: 2026-03-22

---

## 1. Problem Statement

When users navigate to a project in Studio, the current experience is split across two disconnected views:

1. **ProjectOverviewPage** (`components/overview/ProjectOverviewPage.tsx`) — an adaptive dashboard showing metrics, agent lists, deployments, activity timeline, and quick actions. It adapts based on project phase (empty/building/live).
2. **AgentListPage** (`components/agents/AgentListPage.tsx`) — a mini-topology + agent card grid with filtering, with an optional full ProjectCanvas view toggle.
3. **ProjectCanvas** (`components/canvas/ProjectCanvas.tsx`) — a ReactFlow-based visual topology of agents showing handoff/delegate relationships, with drag-and-drop positioning, edge editing, deep linking, and semantic zoom.

The **problem** is that these three views are disconnected: a user must navigate between sidebar items to get both the visual topology understanding AND the operational metrics/quick-actions. The "Project Canvas" feature unifies these into a single, cohesive **visual project overview** that serves as the primary project landing page.

### Pain Points

- **Context switching**: Users jump between overview (metrics) and agents (topology) to understand project health.
- **No visual health at a glance**: The overview page lists agents as text rows without any visual relationship context.
- **Canvas is buried**: The full ProjectCanvas is only accessible via a toggle on the agents page, not as a first-class project view.
- **No resource integration**: Tools, knowledge bases, workflows, and connections are only discoverable through separate sidebar navigation, never shown in spatial context.
- **No health overlays**: The canvas shows static topology but no runtime health signals (error rates, latencies, deployment status).

### Impact

- Increased time-to-insight for project managers and developers
- Reduced adoption of the visual canvas (users don't discover it)
- No single pane of glass for project health

---

## 2. Goals & Non-Goals

### Goals

1. **G1**: Provide a unified visual project landing page that combines topology visualization with operational metrics.
2. **G2**: Surface agent health status (deployed, draft, error) directly on canvas nodes.
3. **G3**: Show project-level KPI summary (agents, sessions, deployments, errors) above or alongside the canvas.
4. **G4**: Enable quick navigation to any project resource (agent detail, chat, deployments, tools) directly from the canvas.
5. **G5**: Support both "canvas-first" (visual) and "list-first" (tabular) view preferences with persistent toggle.
6. **G6**: Integrate resource indicators (tools, knowledge bases, workflows) as contextual badges or satellite nodes on the canvas.

### Non-Goals

- **NG1**: Real-time streaming metrics on the canvas (deferred to Insights Dashboard).
- **NG2**: Drag-and-drop agent creation from the canvas (existing CreateAgentDialog workflow is sufficient).
- **NG3**: Visual workflow/pipeline editor (separate feature — pipelines have their own editor).
- **NG4**: Multi-project comparison view.
- **NG5**: Canvas export to image/PDF.

---

## 3. User Stories

### US-1: Visual Project Health at a Glance

> **As a** project manager,
> **I want to** see the agent topology with health overlays when I open a project,
> **So that** I can immediately identify which agents are deployed, in draft, or erroring.

**Acceptance Criteria:**

- AC-1.1: Canvas nodes display a status indicator (green=deployed, gray=draft, red=error).
- AC-1.2: Node tooltip or side panel shows deployment environment and last activity.
- AC-1.3: The canvas is the default view when navigating to a project (replaces current overview for users who opt in).

### US-2: Project KPI Summary

> **As a** developer,
> **I want to** see aggregate project metrics (total agents, sessions, deployments, error count) alongside the canvas,
> **So that** I can assess project health without navigating to separate pages.

**Acceptance Criteria:**

- AC-2.1: A compact KPI bar renders above the canvas with: agent count, session count, active deployments, compile errors.
- AC-2.2: KPI values link to their respective detail pages (clicking sessions navigates to sessions list).
- AC-2.3: KPIs update when SWR re-fetches data without full page reload.

### US-3: View Mode Toggle

> **As a** user,
> **I want to** switch between canvas view and list view,
> **So that** I can use whichever format I find most productive.

**Acceptance Criteria:**

- AC-3.1: A toggle button in the page header switches between "Canvas" and "List" views.
- AC-3.2: The selected view is persisted in local storage and restored on next visit.
- AC-3.3: Keyboard shortcut (Cmd/Ctrl+Shift+V) toggles view mode.

### US-4: Resource Integration

> **As a** developer,
> **I want to** see which tools and knowledge bases are connected to each agent on the canvas,
> **So that** I can understand the full agent configuration at a glance.

**Acceptance Criteria:**

- AC-4.1: Agent nodes show a compact resource badge row (e.g., "3 tools, 1 KB").
- AC-4.2: Clicking a resource badge opens a popover listing the specific resources.
- AC-4.3: Resource data is fetched via existing SWR endpoints (no new API required).

### US-5: Quick Actions from Canvas

> **As a** developer,
> **I want to** right-click an agent node to access common actions (open editor, chat, deploy),
> **So that** I can take action without navigating through the sidebar.

**Acceptance Criteria:**

- AC-5.1: Right-click on an agent node shows a context menu with: Edit DSL, Open Chat, View Sessions, Deploy.
- AC-5.2: Context menu actions navigate to the correct page with the agent pre-selected.
- AC-5.3: Keyboard shortcut 'E' opens editor for selected agent, 'C' opens chat.

### US-6: Empty Project Onboarding

> **As a** new user with an empty project,
> **I want to** see helpful onboarding content on the canvas page,
> **So that** I know how to get started.

**Acceptance Criteria:**

- AC-6.1: Empty project shows a centered CTA with illustration, matching the existing ProjectOverviewPage empty state.
- AC-6.2: "Create First Agent" button triggers the CreateAgentDialog.
- AC-6.3: "Import Agents" button triggers the ImportDialog.

### US-7: Contextual Agent Detail

> **As a** developer,
> **I want to** click an agent on the canvas and see its details in a slide-over panel,
> **So that** I can inspect configuration without leaving the canvas context.

**Acceptance Criteria:**

- AC-7.1: Clicking an agent node opens the existing AgentEditorSlider.
- AC-7.2: The slider shows agent DSL, goal, tools, and relationship summary.
- AC-7.3: URL updates with hash fragment (#agent/{name}) for deep linking (existing behavior preserved).

---

## 4. Functional Requirements

| ID    | Requirement                                                                           | Priority      | User Story       |
| ----- | ------------------------------------------------------------------------------------- | ------------- | ---------------- |
| FR-01 | Unified ProjectCanvasPage component combining KPI bar + canvas + list toggle          | P0            | US-1, US-2, US-3 |
| FR-02 | Agent node health status overlay (deployed/draft/error states)                        | P0            | US-1             |
| FR-03 | Compact KPI metric bar with agent count, session count, deployment count, error count | P0            | US-2             |
| FR-04 | View mode toggle (canvas/list) with localStorage persistence                          | P0            | US-3             |
| FR-05 | Resource badges on agent nodes (tools count, KB count)                                | P1            | US-4             |
| FR-06 | Agent node context menu (right-click) with Edit, Chat, Sessions, Deploy actions       | P1            | US-5             |
| FR-07 | Empty project onboarding state with CTA buttons                                       | P0            | US-6             |
| FR-08 | AgentEditorSlider integration with deep-link hash                                     | P0 (existing) | US-7             |
| FR-09 | Keyboard shortcuts for view toggle and agent actions                                  | P1            | US-3, US-5       |
| FR-10 | Responsive layout: KPI bar stacks vertically on mobile, canvas gets full width        | P1            | US-2             |
| FR-11 | Loading skeleton matching canvas + KPI layout                                         | P0            | US-2             |
| FR-12 | Import/Export dialogs accessible from canvas page header                              | P1            | US-6             |
| FR-13 | SWR-based data fetching: agents, topology, deployments, tools, sessions               | P0            | US-2, US-4       |
| FR-14 | Navigation store integration: register as new ProjectPage or replace 'overview'       | P0            | US-1             |
| FR-15 | Sidebar navigation item for canvas view                                               | P0            | US-1             |

---

## 5. Non-Functional Requirements

| ID     | Requirement                                                           | Target                   |
| ------ | --------------------------------------------------------------------- | ------------------------ |
| NFR-01 | Canvas renders < 2s for projects with up to 50 agents                 | P95 < 2000ms             |
| NFR-02 | View mode toggle is instant (no re-fetch)                             | < 100ms                  |
| NFR-03 | KPI bar renders without blocking canvas layout                        | Parallel fetch           |
| NFR-04 | Accessible: all interactive elements keyboard-navigable, ARIA labels  | WCAG 2.1 AA              |
| NFR-05 | Internationalized: all user-facing strings via next-intl              | 100% coverage            |
| NFR-06 | Dark/light theme support using existing CSS variables                 | Both themes              |
| NFR-07 | Memory: canvas viewport state bounded (existing canvas-store pattern) | Max 50 projects in store |

---

## 6. Dependencies

| Dependency                      | Type        | Status                                |
| ------------------------------- | ----------- | ------------------------------------- |
| `@xyflow/react` (ReactFlow)     | NPM package | Already installed                     |
| `ProjectCanvas` component       | Internal    | Exists in `components/canvas/`        |
| `ProjectOverviewPage` component | Internal    | Exists in `components/overview/`      |
| `AgentListPage` component       | Internal    | Exists in `components/agents/`        |
| `canvas-store` (Zustand)        | Internal    | Exists in `store/canvas-store.ts`     |
| `navigation-store`              | Internal    | Exists in `store/navigation-store.ts` |
| `runtime-agents` API            | Internal    | Exists in `api/runtime-agents.ts`     |
| `deployments` API               | Internal    | Exists in `api/deployments.ts`        |
| `usage` API                     | Internal    | Exists in `api/usage.ts`              |
| `AgentEditorSlider`             | Internal    | Exists in `components/agent-editor/`  |
| `ConnectionTypePicker`          | Internal    | Exists in `components/canvas/`        |

---

## 7. Open Questions

| #    | Question                                                                                      | Status  | Resolution                                                                                                               |
| ---- | --------------------------------------------------------------------------------------------- | ------- | ------------------------------------------------------------------------------------------------------------------------ |
| OQ-1 | Should the canvas view replace the current overview page or be a separate page?               | DECIDED | New page that can be set as default via preference. Overview page remains for users who prefer the list-based dashboard. |
| OQ-2 | Should resources (tools, KBs) appear as separate satellite nodes or as badges on agent nodes? | DECIDED | Badges on agent nodes (less visual clutter, already complex topology). Satellite nodes deferred to future iteration.     |
| OQ-3 | Should the KPI bar be collapsible to maximize canvas space?                                   | DECIDED | Yes, collapsible with a chevron toggle. State persisted in localStorage.                                                 |
| OQ-4 | How should the context menu handle agents with no DSL (skeleton agents)?                      | DECIDED | Show reduced menu (only "Edit" and "Delete"), gray out Chat/Deploy.                                                      |
| OQ-5 | Should we support canvas view on mobile/tablet?                                               | DECIDED | Canvas renders on tablet (iPad) but on mobile (<768px) falls back to list view automatically.                            |

---

## 8. Success Metrics

| Metric                                    | Baseline                             | Target                  | Measurement                        |
| ----------------------------------------- | ------------------------------------ | ----------------------- | ---------------------------------- |
| Time to first meaningful interaction      | 4.2s (overview + navigate to agents) | < 2.5s (single page)    | Instrumented via performance marks |
| Canvas adoption rate                      | ~15% (toggle on agents page)         | > 50% (default landing) | Analytics event tracking           |
| Page views before first deployment action | 3.1 avg                              | < 2 avg                 | Navigation analytics               |

---

## 9. Risks & Mitigations

| Risk                                                       | Likelihood | Impact | Mitigation                                                               |
| ---------------------------------------------------------- | ---------- | ------ | ------------------------------------------------------------------------ |
| Performance degradation with large topologies (50+ agents) | Medium     | High   | Existing `onlyRenderVisibleElements` optimization, lazy node rendering   |
| User confusion with two "overview" options                 | Medium     | Medium | Clear naming: "Canvas" vs "Dashboard", guided first-time tooltip         |
| Canvas re-layout flicker on data refresh                   | Low        | Medium | Existing persisted node positions prevent re-layout; incremental updates |
| Accessibility gaps in canvas interactions                  | Medium     | High   | Comprehensive ARIA labeling, keyboard navigation for all actions         |

---

## 10. Feature Status Lifecycle

| Stage   | Criteria                                                             | Status  |
| ------- | -------------------------------------------------------------------- | ------- |
| PLANNED | Feature spec approved, test spec exists                              | Current |
| ALPHA   | Core canvas page + KPI bar + view toggle implemented                 | Pending |
| BETA    | Resource badges, context menu, keyboard shortcuts, E2E tests passing | Pending |
| STABLE  | 30-day production usage, no P0/P1 bugs, performance targets met      | Pending |

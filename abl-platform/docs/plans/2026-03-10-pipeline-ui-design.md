# Pipeline Configuration UI — Design Document

**Date:** 2026-03-10
**Status:** Approved
**Scope:** Analytics pipelines only (from `packages/pipeline-engine`), both builtin and custom

## Overview

Add a new "Pipelines" section under the Insights navigation group in Studio. This provides a unified interface to:

1. **Configure builtin analytics pipelines** (sentiment, intent, quality, hallucination, etc.) — enable/disable, set parameters, manage triggers and sampling rates
2. **Create and edit custom pipelines** via a visual graph editor (React Flow canvas with drag-and-drop nodes)

## Navigation & Routing

- **Sidebar:** Add `'pipelines'` to the Insights group in `ProjectSidebar.tsx`, using the `Cpu` icon
- **Routes:**
  - `/projects/:projectId/pipelines` — list page (two tabs)
  - `/projects/:projectId/pipelines/:pipelineType` — builtin config page (e.g., `sentiment_analysis`)
  - `/projects/:projectId/pipelines/:pipelineId` — custom pipeline graph editor
- **Navigation store:** Add `'pipelines'` to `ProjectPage` type, add to Insights group's `pages` array
- **AppShell:** `page === 'pipelines'` + no `subPage` → `PipelinesListPage`; with `subPage` → detail/editor page

## Pipelines List Page

### Layout

Standard page header + tabbed content area (SegmentedControl with two tabs).

**Header:**

- Title: "Pipelines"
- Description: "Configure analytics pipelines and build custom processing workflows"

### Builtin Tab

Card grid showing all 10+ builtin pipelines.

Each card displays:

- Name (e.g., "Sentiment Analysis")
- Description (from pipeline definition)
- Enabled/disabled badge (green/gray)
- Active trigger count (e.g., "2 triggers")
- Last processed time (relative, e.g., "3 min ago")

Click navigates to builtin config page. No create/delete — these are platform-managed.

### Custom Tab

Card grid showing user-created pipelines.

Each card displays:

- Name
- Description
- Status badge (draft/active/archived)
- Node count
- Created by
- Last modified (relative)
- Three-dot menu: Clone, Archive, Delete (with confirmation)

"Create Pipeline" button in top-right. Empty state when no custom pipelines exist.

Click navigates to graph editor page.

### Data Fetching

- Builtin list: `GET /api/projects/:projectId/pipeline-config` (new list-all endpoint)
- Custom list: `GET /api/pipelines?projectId=...&status=active`

## Builtin Pipeline Config Page

**Route:** `/projects/:projectId/pipelines/:pipelineType`

### Layout

Standard detail page pattern (matching `ToolDetailPage`).

**Header:**

- Back button → returns to pipelines list
- Pipeline name (e.g., "Sentiment Analysis")
- "Builtin" badge
- Enable/disable toggle (`PATCH .../toggle`)
- Save / Discard buttons (dirty state detection)

### Configuration Section

Dynamic form rendered from `configSchema.fields` returned by `GET .../schema`:

- Each `ConfigField` has `key`, `type` (string/number/boolean/enum), `label`, `description`, `default`, `required`, `validation`
- Renders appropriate input: text, number, slider, toggle, select dropdown
- Current values from `GET .../pipeline-config/:type`
- Save calls `PUT .../pipeline-config/:type`

### Triggers Section

List of supported triggers from pipeline definition:

- Label (e.g., "Session Ended — Batch")
- Type badge (kafka/schedule/manual)
- Kafka topic or schedule expression
- Active/inactive toggle
- Sampling rate slider (0-100%)
- Persisted via config API's `activeTriggers` + `triggerConfigs` fields

### State

Local component state for form dirty tracking (same pattern as `ModelConfigTab`). SWR for data fetching.

## Custom Pipeline Graph Editor

**Route:** `/projects/:projectId/pipelines/:pipelineId`

Full-page editor, three-panel layout (matching `ProjectCanvas` pattern). Auto-collapses sidebar on entry.

### Left Panel — Node Palette (240px, collapsible)

- Search input at top
- Nodes grouped by category accordion: Data, Logic, Integration, Compute, Action
- Each node type shows: icon, label, brief description
- Drag from palette onto canvas to add node
- Node types fetched from `GET /api/pipelines/nodes`

### Center — React Flow Canvas

- `@xyflow/react` with custom node and edge components
- **PipelineNode component:** Rounded card showing node label, activity type badge, config summary, input/output handles
- **PipelineEdge component:** Animated edges with optional condition labels (similar to `RelationshipEdge`)
- ELK auto-layout on first load and via toolbar button
- Canvas controls toolbar (top-right): Auto-layout, Zoom in/out, Fit to view (reuse `CanvasControls` pattern)
- Click node → opens right config panel
- Click edge → popover with condition edit / delete (reuse `EdgePopover` pattern)
- Drag handle-to-handle → creates edge with optional condition dialog
- Delete key removes selected node/edge

### Right Panel — Node Config (320px, slide-over)

- Opens when a node is selected on canvas
- Header: Node label (editable), activity type
- Dynamic config form rendered from `NodeTypeDefinition.configSchema`
- Timeout, retries, onFailure settings
- Transition conditions for outgoing edges
- Close button returns to canvas-only view

### Top Bar

- Pipeline name (editable inline)
- Status badge (draft/active/archived)
- Validate button → `POST /api/pipelines/validate`
- Save button → `PATCH /api/pipelines/:id`
- Activate / Deactivate button → `POST /api/pipelines/:id/activate`

### State

Zustand store (`pipeline-editor-store.ts`) managing: pipeline definition (nodes, edges, metadata), selected node/edge IDs, panel open/close states, dirty tracking, validation results.

**Creating new:** "Create Pipeline" from list page → `POST /api/pipelines` creates draft → redirects to editor with new ID.

## API Surface

### Existing Endpoints Used

| Action                 | Endpoint                                                |
| ---------------------- | ------------------------------------------------------- |
| Get builtin config     | `GET /api/projects/:pid/pipeline-config/:type`          |
| Save builtin config    | `PUT /api/projects/:pid/pipeline-config/:type`          |
| Toggle builtin         | `PATCH /api/projects/:pid/pipeline-config/:type/toggle` |
| Get config schema      | `GET /api/projects/:pid/pipeline-config/:type/schema`   |
| Get triggers           | `GET /api/projects/:pid/pipeline-config/:type/triggers` |
| List custom pipelines  | `GET /api/pipelines?projectId=...`                      |
| Create custom pipeline | `POST /api/pipelines`                                   |
| Get custom pipeline    | `GET /api/pipelines/:id`                                |
| Update custom pipeline | `PATCH /api/pipelines/:id`                              |
| Activate/Deactivate    | `POST /api/pipelines/:id/activate`                      |
| Clone                  | `POST /api/pipelines/:id/clone`                         |
| Get node types         | `GET /api/pipelines/nodes`                              |

### New Endpoint Needed

**`GET /api/projects/:pid/pipeline-config`** (no `:type` param) — returns all builtin pipeline configs for the project. Iterates the 13 known `pipelineType` values, resolves config for each, returns array with definition metadata (name, description, configSchema) merged in.

## File Structure

```
apps/studio/src/
  components/pipelines/
    PipelinesListPage.tsx        — List page with tabs
    BuiltinPipelinesList.tsx     — Builtin tab card grid
    CustomPipelinesList.tsx      — Custom tab card grid
    PipelineCard.tsx             — Shared card component
    PipelineConfigPage.tsx       — Builtin config detail
    ConfigSchemaForm.tsx         — Dynamic form from configSchema
    TriggerManager.tsx           — Trigger list with toggles/sampling
    PipelineEditorPage.tsx       — Graph editor container
    NodePalette.tsx              — Left sidebar with draggable nodes
    PipelineGraphCanvas.tsx      — React Flow canvas
    PipelineNodeComponent.tsx    — Custom node renderer
    PipelineEdgeComponent.tsx    — Custom edge renderer
    NodeConfigPanel.tsx          — Right slide-over config panel
    PipelineEditorToolbar.tsx    — Top bar (name, save, validate)
  store/
    pipeline-list-store.ts       — Active tab, search/filter state
    pipeline-editor-store.ts     — Graph editor state
apps/runtime/src/routes/
    pipeline-config.ts           — Add list-all route
```

## Design Decisions

1. **Two tabs over mixed list** — Scales as builtin catalog grows to 20+; avoids noisy mixed list
2. **Insights group** — Pipelines feed analytics, natural fit alongside dashboards
3. **React Flow + ELK** — Reuses existing `@xyflow/react` + `elkjs` stack from `ProjectCanvas`
4. **Zustand + SWR** — Matches platform state management pattern (Zustand for UI, SWR for server)
5. **Dynamic config forms** — Both builtin `configSchema` and custom `NodeTypeDefinition.configSchema` use the same `ConfigField` type, so one `ConfigSchemaForm` component serves both
6. **Auto-collapse sidebar** — Same behavior as `AgentEditorPage` to maximize editor space

## Deferred (Future)

- Backfill controls (trigger retroactive processing, progress tracking)
- Config history (version timeline with diffs)
- Pipeline execution monitoring (run status, recent errors, processing stats)
- Pipeline templates (pre-built custom pipeline starting points)

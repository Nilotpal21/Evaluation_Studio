# Pipeline Configuration UI — Implementation Plan

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** Add a "Pipelines" section under Insights in Studio to configure builtin analytics pipelines and create/edit custom pipelines via a visual graph editor.

**Architecture:** Two-tab list page (Builtin/Custom) with drill-down into either a form-based config page (builtin) or a full-page React Flow graph editor (custom). Reuses existing `@xyflow/react` + `elkjs` stack from `ProjectCanvas`. SWR for data fetching, Zustand for UI state.

**Tech Stack:** Next.js, React, TypeScript, @xyflow/react, elkjs, Zustand, SWR, Tailwind CSS, Radix UI, next-intl, Lucide icons

**Design Doc:** `docs/plans/2026-03-10-pipeline-ui-design.md`

---

## Task 1: Add List-All Pipeline Config Endpoint

**Files:**

- Modify: `apps/runtime/src/routes/pipeline-config.ts`
- Modify: `packages/pipeline-engine/src/pipeline/services/pipeline-config.service.ts`
- Reference: `packages/pipeline-engine/src/pipeline/definitions/` (all builtin definitions)

**Step 1: Add `listAllConfigs` method to PipelineConfigService**

In `packages/pipeline-engine/src/pipeline/services/pipeline-config.service.ts`, add after the existing `resolveConfig` method:

```typescript
async listAllConfigs(
  tenantId: string,
  projectId?: string,
): Promise<Array<{
  pipelineType: string;
  name: string;
  description: string;
  enabled: boolean;
  version: number;
  activeTriggers: string[];
  lastProcessedAt: Date | null;
  configSchema: { fields: ConfigField[] } | undefined;
  supportedTriggers: TriggerEntry[] | undefined;
}>> {
  const results = [];
  for (const pipelineType of VALID_PIPELINE_TYPES) {
    const definition = getBuiltinDefinition(pipelineType);
    const config = await this.resolveConfig(tenantId, pipelineType, projectId, definition);
    results.push({
      pipelineType,
      name: definition?.name ?? pipelineType,
      description: definition?.description ?? '',
      enabled: config?.enabled ?? false,
      version: config?.version ?? 0,
      activeTriggers: config?.activeTriggers ?? definition?.defaultTriggerIds ?? [],
      lastProcessedAt: config?.lastProcessedAt ?? null,
      configSchema: definition?.configSchema,
      supportedTriggers: definition?.supportedTriggers,
    });
  }
  return results;
}
```

Note: You MUST read `pipeline-config.service.ts` to verify the exact import for `VALID_PIPELINE_TYPES` and `getBuiltinDefinition`. These may be named differently — check the definitions index file at `packages/pipeline-engine/src/pipeline/definitions/index.ts` for the actual export names and how types map to definitions.

**Step 2: Add GET `/` route in pipeline-config.ts**

In `apps/runtime/src/routes/pipeline-config.ts`, add BEFORE the `/:pipelineType` route (so it doesn't get matched as a type):

```typescript
openapi.route(
  'get',
  '/',
  {
    summary: 'List all pipeline configurations',
    description: 'Returns all builtin pipeline configs with their definitions for the project',
    response: z.object({
      success: z.boolean(),
      data: z.array(
        z.object({
          pipelineType: z.string(),
          name: z.string(),
          description: z.string(),
          enabled: z.boolean(),
          version: z.number(),
          activeTriggers: z.array(z.string()),
          lastProcessedAt: z.string().nullable(),
        }),
      ),
    }),
  },
  async (req, res) => {
    if (!(await requireProjectPermission(req, res, 'session:read'))) return;
    const { projectId } = req.params;
    const tenantId = req.tenantContext!.tenantId;

    try {
      const configs = await configService.listAllConfigs(tenantId, projectId);
      res.json({ success: true, data: configs });
    } catch (err) {
      log.error('Failed to list pipeline configs', {
        tenantId,
        projectId,
        error: err instanceof Error ? err.message : String(err),
      });
      res.status(500).json({ success: false, error: 'Failed to list pipeline configurations' });
    }
  },
);
```

**Step 3: Build and verify**

Run: `pnpm build --filter=@abl/pipeline-engine --filter=@abl/runtime`
Expected: Build succeeds with no type errors

**Step 4: Commit**

```bash
npx prettier --write apps/runtime/src/routes/pipeline-config.ts packages/pipeline-engine/src/pipeline/services/pipeline-config.service.ts
git add apps/runtime/src/routes/pipeline-config.ts packages/pipeline-engine/src/pipeline/services/pipeline-config.service.ts
git commit -m "feat(runtime): add list-all pipeline config endpoint"
```

---

## Task 2: Add Navigation & Routing

**Files:**

- Modify: `apps/studio/src/store/navigation-store.ts`
- Modify: `apps/studio/src/components/navigation/ProjectSidebar.tsx`
- Modify: `apps/studio/src/components/navigation/AppShell.tsx`

**Step 1: Add `'pipelines'` to ProjectPage type**

In `apps/studio/src/store/navigation-store.ts`, add `'pipelines'` to the `ProjectPage` union type (after `'voice-analytics'`):

```typescript
  | 'voice-analytics'
  | 'pipelines' // NEW — analytics pipeline configuration
  | 'alerts'
```

**Step 2: Add pipelines to Insights group in ProjectSidebar**

In `apps/studio/src/components/navigation/ProjectSidebar.tsx`:

1. Add `GitGraph` to the lucide-react imports (or use `Cpu` which is already imported — read the file to confirm which pipeline-relevant icon is available)

2. In the `insights` nav group, add pipelines to the `pages` array and `items` array:

```typescript
{
  id: 'insights',
  Icon: TrendingUp,
  key: 'insights_group',
  defaultPage: 'dashboard',
  pages: [
    'dashboard',
    'agent-performance',
    'quality-monitor',
    'customer-insights',
    'voice-analytics',
    'pipelines',  // ADD
  ],
  items: [
    { id: 'dashboard', Icon: TrendingUp, key: 'insights_dashboard' },
    { id: 'agent-performance', Icon: Activity, key: 'agent_performance' },
    { id: 'quality-monitor', Icon: Eye, key: 'quality_monitor' },
    { id: 'customer-insights', Icon: Sparkles, key: 'customer_insights' },
    { id: 'voice-analytics', Icon: Phone, key: 'voice_analytics' },
    { id: 'pipelines', Icon: Cpu, key: 'pipelines' },  // ADD
  ],
},
```

**Step 3: Add routing in AppShell**

In `apps/studio/src/components/navigation/AppShell.tsx`:

1. Add import at the top (lazy-load since it will contain React Flow):

```typescript
const PipelinesListPage = dynamic(
  () => import('../pipelines/PipelinesListPage').then((m) => ({ default: m.PipelinesListPage })),
  { ssr: false, loading: () => <div className="h-64 animate-pulse bg-background-muted rounded" /> },
);
const PipelineConfigPage = dynamic(
  () => import('../pipelines/PipelineConfigPage').then((m) => ({ default: m.PipelineConfigPage })),
  { ssr: false, loading: () => <div className="h-64 animate-pulse bg-background-muted rounded" /> },
);
const PipelineEditorPage = dynamic(
  () => import('../pipelines/PipelineEditorPage').then((m) => ({ default: m.PipelineEditorPage })),
  { ssr: false, loading: () => <div className="h-64 animate-pulse bg-background-muted rounded" /> },
);
```

2. Add case in `renderContent` switch, after the `'voice-analytics'` case:

```typescript
case 'pipelines':
  if (subPage) {
    // Determine if builtin (pipelineType like 'sentiment_analysis') or custom (UUID)
    // Builtin types use underscores, custom IDs are UUIDs
    const isBuiltinType = !subPage.includes('-') || subPage.includes('_');
    if (isBuiltinType) {
      return <PipelineConfigPage />;
    }
    return <PipelineEditorPage />;
  }
  return <PipelinesListPage />;
```

Note: READ the actual VALID_PIPELINE_TYPES set from `apps/runtime/src/routes/pipeline-config.ts` to determine the exact format of builtin type strings. The heuristic above may need adjustment — a cleaner approach is to maintain a shared constant or check against a known list.

**Step 4: Create stub components so the build passes**

Create three stub files so the dynamic imports resolve:

`apps/studio/src/components/pipelines/PipelinesListPage.tsx`:

```typescript
export function PipelinesListPage() {
  return <div className="p-6">Pipelines List — Coming Soon</div>;
}
```

`apps/studio/src/components/pipelines/PipelineConfigPage.tsx`:

```typescript
export function PipelineConfigPage() {
  return <div className="p-6">Pipeline Config — Coming Soon</div>;
}
```

`apps/studio/src/components/pipelines/PipelineEditorPage.tsx`:

```typescript
export function PipelineEditorPage() {
  return <div className="p-6">Pipeline Editor — Coming Soon</div>;
}
```

**Step 5: Add i18n key**

In `packages/i18n/locales/en/studio.json`, find the `"nav"` section and add:

```json
"pipelines": "Pipelines"
```

alongside the other nav keys like `"insights_dashboard"`, `"voice_analytics"`, etc.

**Step 6: Build and verify**

Run: `pnpm build --filter=studio`
Expected: Build succeeds. Navigate to `/projects/:id/pipelines` shows stub page.

**Step 7: Commit**

```bash
npx prettier --write apps/studio/src/store/navigation-store.ts apps/studio/src/components/navigation/ProjectSidebar.tsx apps/studio/src/components/navigation/AppShell.tsx apps/studio/src/components/pipelines/PipelinesListPage.tsx apps/studio/src/components/pipelines/PipelineConfigPage.tsx apps/studio/src/components/pipelines/PipelineEditorPage.tsx
git add apps/studio/src/store/navigation-store.ts apps/studio/src/components/navigation/ProjectSidebar.tsx apps/studio/src/components/navigation/AppShell.tsx apps/studio/src/components/pipelines/ packages/i18n/locales/en/studio.json
git commit -m "feat(studio): add pipelines to insights navigation and routing"
```

---

## Task 3: Create Zustand Stores

**Files:**

- Create: `apps/studio/src/store/pipeline-list-store.ts`
- Create: `apps/studio/src/store/pipeline-editor-store.ts`

**Step 1: Create pipeline-list-store**

```typescript
import { create } from 'zustand';

export type PipelineListTab = 'builtin' | 'custom';

interface PipelineListState {
  activeTab: PipelineListTab;
  searchQuery: string;

  setActiveTab: (tab: PipelineListTab) => void;
  setSearchQuery: (query: string) => void;
}

export const usePipelineListStore = create<PipelineListState>((set) => ({
  activeTab: 'builtin',
  searchQuery: '',

  setActiveTab: (activeTab) => set({ activeTab, searchQuery: '' }),
  setSearchQuery: (searchQuery) => set({ searchQuery }),
}));
```

**Step 2: Create pipeline-editor-store**

```typescript
import { create } from 'zustand';
import type { Node, Edge } from '@xyflow/react';

interface ValidationResult {
  valid: boolean;
  errors: Array<{ nodeId?: string; message: string }>;
  warnings: Array<{ nodeId?: string; message: string }>;
}

interface PipelineEditorState {
  // Pipeline metadata
  pipelineId: string | null;
  pipelineName: string;
  pipelineStatus: 'draft' | 'active' | 'archived';

  // Graph state
  nodes: Node[];
  edges: Edge[];

  // Selection
  selectedNodeId: string | null;
  selectedEdgeId: string | null;

  // Panel state
  nodePaletteOpen: boolean;
  nodeConfigPanelOpen: boolean;

  // Dirty tracking
  isDirty: boolean;
  lastSavedAt: Date | null;

  // Validation
  validationResult: ValidationResult | null;

  // Actions
  setPipeline: (
    id: string,
    name: string,
    status: 'draft' | 'active' | 'archived',
    nodes: Node[],
    edges: Edge[],
  ) => void;
  setNodes: (nodes: Node[]) => void;
  setEdges: (edges: Edge[]) => void;
  addNode: (node: Node) => void;
  removeNode: (nodeId: string) => void;
  updateNodeData: (nodeId: string, data: Record<string, unknown>) => void;
  selectNode: (nodeId: string | null) => void;
  selectEdge: (edgeId: string | null) => void;
  setNodePaletteOpen: (open: boolean) => void;
  setNodeConfigPanelOpen: (open: boolean) => void;
  setPipelineName: (name: string) => void;
  setValidationResult: (result: ValidationResult | null) => void;
  markSaved: () => void;
  reset: () => void;
}

export const usePipelineEditorStore = create<PipelineEditorState>((set) => ({
  pipelineId: null,
  pipelineName: '',
  pipelineStatus: 'draft',
  nodes: [],
  edges: [],
  selectedNodeId: null,
  selectedEdgeId: null,
  nodePaletteOpen: true,
  nodeConfigPanelOpen: false,
  isDirty: false,
  lastSavedAt: null,
  validationResult: null,

  setPipeline: (id, name, status, nodes, edges) =>
    set({
      pipelineId: id,
      pipelineName: name,
      pipelineStatus: status,
      nodes,
      edges,
      isDirty: false,
    }),
  setNodes: (nodes) => set({ nodes, isDirty: true }),
  setEdges: (edges) => set({ edges, isDirty: true }),
  addNode: (node) => set((s) => ({ nodes: [...s.nodes, node], isDirty: true })),
  removeNode: (nodeId) =>
    set((s) => ({
      nodes: s.nodes.filter((n) => n.id !== nodeId),
      edges: s.edges.filter((e) => e.source !== nodeId && e.target !== nodeId),
      selectedNodeId: s.selectedNodeId === nodeId ? null : s.selectedNodeId,
      nodeConfigPanelOpen: s.selectedNodeId === nodeId ? false : s.nodeConfigPanelOpen,
      isDirty: true,
    })),
  updateNodeData: (nodeId, data) =>
    set((s) => ({
      nodes: s.nodes.map((n) => (n.id === nodeId ? { ...n, data: { ...n.data, ...data } } : n)),
      isDirty: true,
    })),
  selectNode: (nodeId) =>
    set({ selectedNodeId: nodeId, selectedEdgeId: null, nodeConfigPanelOpen: nodeId !== null }),
  selectEdge: (edgeId) =>
    set({ selectedEdgeId: edgeId, selectedNodeId: null, nodeConfigPanelOpen: false }),
  setNodePaletteOpen: (nodePaletteOpen) => set({ nodePaletteOpen }),
  setNodeConfigPanelOpen: (nodeConfigPanelOpen) => set({ nodeConfigPanelOpen }),
  setPipelineName: (pipelineName) => set({ pipelineName, isDirty: true }),
  setValidationResult: (validationResult) => set({ validationResult }),
  markSaved: () => set({ isDirty: false, lastSavedAt: new Date() }),
  reset: () =>
    set({
      pipelineId: null,
      pipelineName: '',
      pipelineStatus: 'draft',
      nodes: [],
      edges: [],
      selectedNodeId: null,
      selectedEdgeId: null,
      nodePaletteOpen: true,
      nodeConfigPanelOpen: false,
      isDirty: false,
      lastSavedAt: null,
      validationResult: null,
    }),
}));
```

**Step 3: Build and verify**

Run: `pnpm build --filter=studio`
Expected: No type errors

**Step 4: Commit**

```bash
npx prettier --write apps/studio/src/store/pipeline-list-store.ts apps/studio/src/store/pipeline-editor-store.ts
git add apps/studio/src/store/pipeline-list-store.ts apps/studio/src/store/pipeline-editor-store.ts
git commit -m "feat(studio): add zustand stores for pipeline list and editor"
```

---

## Task 4: Add i18n Strings

**Files:**

- Modify: `packages/i18n/locales/en/studio.json`

**Step 1: Add pipelines namespace**

Read the file first to find the correct location. Add a `"pipelines"` key at the same level as other page namespaces (like `"tools"`, `"sessions"`, etc.):

```json
"pipelines": {
  "title": "Pipelines",
  "description": "Configure analytics pipelines and build custom processing workflows",
  "tab_builtin": "Built-in",
  "tab_custom": "Custom",
  "search_placeholder": "Search pipelines...",
  "enabled": "Enabled",
  "disabled": "Disabled",
  "triggers_count": "{count} triggers",
  "last_processed": "Last processed {time}",
  "never_processed": "Never processed",
  "no_builtin_pipelines": "No matching pipelines",
  "no_custom_pipelines": "No custom pipelines yet",
  "no_custom_pipelines_desc": "Create a custom pipeline to build your own analytics processing workflow",
  "create_pipeline": "Create Pipeline",
  "status_draft": "Draft",
  "status_active": "Active",
  "status_archived": "Archived",
  "nodes_count": "{count} nodes",
  "clone": "Clone",
  "archive": "Archive",
  "delete": "Delete",
  "delete_confirm_title": "Delete Pipeline",
  "delete_confirm_desc": "Are you sure you want to delete this pipeline? This action cannot be undone.",
  "config": {
    "title": "Configuration",
    "builtin_badge": "Built-in",
    "save": "Save",
    "discard": "Discard",
    "saving": "Saving...",
    "saved": "Configuration saved",
    "save_error": "Failed to save configuration",
    "triggers_title": "Triggers",
    "trigger_active": "Active",
    "trigger_inactive": "Inactive",
    "trigger_type_kafka": "Kafka",
    "trigger_type_schedule": "Schedule",
    "trigger_type_manual": "Manual",
    "sampling_rate": "Sampling Rate",
    "back_to_list": "Back to Pipelines"
  },
  "editor": {
    "untitled": "Untitled Pipeline",
    "save": "Save",
    "validate": "Validate",
    "activate": "Activate",
    "deactivate": "Deactivate",
    "validation_passed": "Validation passed",
    "validation_failed": "Validation failed",
    "node_palette": "Node Palette",
    "search_nodes": "Search nodes...",
    "node_config": "Node Configuration",
    "no_node_selected": "Select a node to configure",
    "timeout": "Timeout (ms)",
    "retries": "Retries",
    "on_failure": "On Failure",
    "on_failure_stop": "Stop",
    "on_failure_skip": "Skip",
    "on_failure_continue": "Continue",
    "condition": "Condition",
    "category_data": "Data",
    "category_logic": "Logic",
    "category_integration": "Integration",
    "category_compute": "Compute",
    "category_action": "Action",
    "auto_layout": "Auto Layout",
    "fit_view": "Fit View"
  }
}
```

**Step 2: Build and verify**

Run: `pnpm build --filter=@abl/i18n`
Expected: Build succeeds

**Step 3: Commit**

```bash
npx prettier --write packages/i18n/locales/en/studio.json
git add packages/i18n/locales/en/studio.json
git commit -m "feat(i18n): add pipeline UI translation strings"
```

---

## Task 5: PipelineCard Component

**Files:**

- Create: `apps/studio/src/components/pipelines/PipelineCard.tsx`

**Step 1: Build the shared card component**

This component renders both builtin and custom pipeline cards. Read `apps/studio/src/components/ui/Card.tsx` and `apps/studio/src/components/ui/Badge.tsx` first to verify their prop signatures.

```typescript
import { clsx } from 'clsx';
import { useTranslations } from 'next-intl';
import { Cpu, MoreVertical } from 'lucide-react';
import { Badge } from '../ui/Badge';
import { Card } from '../ui/Card';

interface BuiltinPipelineCardProps {
  type: 'builtin';
  name: string;
  description: string;
  pipelineType: string;
  enabled: boolean;
  activeTriggerCount: number;
  lastProcessedAt: string | null;
  onClick: () => void;
}

interface CustomPipelineCardProps {
  type: 'custom';
  name: string;
  description: string;
  pipelineId: string;
  status: 'draft' | 'active' | 'archived';
  nodeCount: number;
  createdBy: string;
  updatedAt: string;
  onClick: () => void;
  onClone?: () => void;
  onArchive?: () => void;
  onDelete?: () => void;
}

export type PipelineCardProps = BuiltinPipelineCardProps | CustomPipelineCardProps;

export function PipelineCard(props: PipelineCardProps) {
  const t = useTranslations('pipelines');
  // Implementation: render Card with name, description, badges, metadata
  // Use Badge for status/enabled indicators
  // For custom cards, add three-dot dropdown menu (MoreVertical) with Clone/Archive/Delete
  // See ToolsListPage card rendering pattern for reference
}
```

Note: BEFORE implementing, READ `Card.tsx` and `Badge.tsx` to verify actual prop names. Also read a few cards from `ToolsListPage.tsx` or `AgentListPage.tsx` for the exact card layout pattern used in this codebase.

**Step 2: Build and verify**

Run: `pnpm build --filter=studio`

**Step 3: Commit**

```bash
npx prettier --write apps/studio/src/components/pipelines/PipelineCard.tsx
git add apps/studio/src/components/pipelines/PipelineCard.tsx
git commit -m "feat(studio): add PipelineCard component"
```

---

## Task 6: Builtin Pipelines List

**Files:**

- Create: `apps/studio/src/components/pipelines/BuiltinPipelinesList.tsx`

**Step 1: Build the builtin tab content**

Uses SWR to fetch all builtin pipeline configs, renders a grid of `PipelineCard` components.

```typescript
import useSWR from 'swr';
import { useTranslations } from 'next-intl';
import { useNavigationStore } from '../../store/navigation-store';
import { useProjectStore } from '../../store/project-store';
import { usePipelineListStore } from '../../store/pipeline-list-store';
import { PipelineCard } from './PipelineCard';
import { Skeleton } from '../ui/Skeleton';
import { EmptyState } from '../ui/EmptyState';

export function BuiltinPipelinesList() {
  const t = useTranslations('pipelines');
  const projectId = useNavigationStore((s) => s.projectId);
  const navigate = useNavigationStore((s) => s.navigate);
  const searchQuery = usePipelineListStore((s) => s.searchQuery);

  // Fetch from runtime API via Studio proxy
  // The Studio proxy forwards /api/projects/:pid/pipeline-config to runtime
  // READ apps/studio/src/app/api/ directory to find if a proxy already exists
  // or if you need to create one at apps/studio/src/app/api/projects/[projectId]/pipeline-config/route.ts
  const { data, error, isLoading } = useSWR(
    projectId ? `/api/projects/${projectId}/pipeline-config` : null,
  );

  // Filter by search query
  // Render loading skeletons, error state, or card grid
  // onClick navigates to /projects/:projectId/pipelines/:pipelineType
}
```

Note: CHECK how other pages call the runtime API. Studio may proxy requests to runtime (port 3112). Look at how `InsightsDashboardPage` or other Insights pages fetch data to find the correct API path pattern.

**Step 2: Build and verify**

Run: `pnpm build --filter=studio`

**Step 3: Commit**

```bash
npx prettier --write apps/studio/src/components/pipelines/BuiltinPipelinesList.tsx
git add apps/studio/src/components/pipelines/BuiltinPipelinesList.tsx
git commit -m "feat(studio): add BuiltinPipelinesList component"
```

---

## Task 7: Custom Pipelines List

**Files:**

- Create: `apps/studio/src/components/pipelines/CustomPipelinesList.tsx`

**Step 1: Build the custom tab content**

Uses SWR to fetch custom pipelines, renders grid + Create button + empty state.

```typescript
import useSWR from 'swr';
import { useTranslations } from 'next-intl';
import { Plus } from 'lucide-react';
import { useNavigationStore } from '../../store/navigation-store';
import { usePipelineListStore } from '../../store/pipeline-list-store';
import { PipelineCard } from './PipelineCard';
import { Button } from '../ui/Button';
import { EmptyState } from '../ui/EmptyState';

export function CustomPipelinesList() {
  const t = useTranslations('pipelines');
  const projectId = useNavigationStore((s) => s.projectId);
  const navigate = useNavigationStore((s) => s.navigate);
  const searchQuery = usePipelineListStore((s) => s.searchQuery);

  // Fetch custom pipelines from Studio API
  const { data, error, isLoading, mutate } = useSWR(
    projectId ? `/api/pipelines?projectId=${projectId}` : null,
  );

  const handleCreate = async () => {
    // POST /api/pipelines to create draft
    // Navigate to /projects/:projectId/pipelines/:newId
  };

  const handleClone = async (pipelineId: string) => {
    // POST /api/pipelines/:id/clone
    // mutate() to refresh list
  };

  const handleDelete = async (pipelineId: string) => {
    // DELETE /api/pipelines/:id (or archive)
    // mutate() to refresh list
  };

  // Render: Create button + card grid or empty state
}
```

Note: READ `apps/studio/src/app/api/pipelines/route.ts` to verify the exact query parameter format. The GET handler accepts `projectId` and `status` query params.

**Step 2: Build and verify**

Run: `pnpm build --filter=studio`

**Step 3: Commit**

```bash
npx prettier --write apps/studio/src/components/pipelines/CustomPipelinesList.tsx
git add apps/studio/src/components/pipelines/CustomPipelinesList.tsx
git commit -m "feat(studio): add CustomPipelinesList component"
```

---

## Task 8: PipelinesListPage (Main Page)

**Files:**

- Modify: `apps/studio/src/components/pipelines/PipelinesListPage.tsx` (replace stub)

**Step 1: Implement the list page with tabs**

Read `apps/studio/src/components/tools/ToolsListPage.tsx` for the exact pattern, especially how `SegmentedControl` or tab switching is implemented.

```typescript
import { useTranslations } from 'next-intl';
import { usePipelineListStore } from '../../store/pipeline-list-store';
import { BuiltinPipelinesList } from './BuiltinPipelinesList';
import { CustomPipelinesList } from './CustomPipelinesList';
// Import SegmentedControl or tab component — READ existing code to find the actual component

export function PipelinesListPage() {
  const t = useTranslations('pipelines');
  const activeTab = usePipelineListStore((s) => s.activeTab);
  const setActiveTab = usePipelineListStore((s) => s.setActiveTab);
  const searchQuery = usePipelineListStore((s) => s.searchQuery);
  const setSearchQuery = usePipelineListStore((s) => s.setSearchQuery);

  return (
    <div className="flex-1 flex flex-col p-6 gap-6">
      {/* Header */}
      <div>
        <h1 className="text-2xl font-semibold text-foreground">{t('title')}</h1>
        <p className="text-sm text-muted mt-1">{t('description')}</p>
      </div>

      {/* Tabs + Search */}
      <div className="flex items-center justify-between gap-4">
        {/* Tab switcher — use SegmentedControl or Tabs component */}
        {/* Search input */}
      </div>

      {/* Tab content */}
      {activeTab === 'builtin' ? <BuiltinPipelinesList /> : <CustomPipelinesList />}
    </div>
  );
}
```

**Step 2: Build and verify**

Run: `pnpm build --filter=studio`

**Step 3: Commit**

```bash
npx prettier --write apps/studio/src/components/pipelines/PipelinesListPage.tsx
git add apps/studio/src/components/pipelines/PipelinesListPage.tsx
git commit -m "feat(studio): implement PipelinesListPage with builtin/custom tabs"
```

---

## Task 9: ConfigSchemaForm (Dynamic Form Renderer)

**Files:**

- Create: `apps/studio/src/components/pipelines/ConfigSchemaForm.tsx`

**Step 1: Build the dynamic form component**

This is a key reusable component that renders form fields from a `ConfigField[]` array. Used by both the builtin config page and the node config panel in the graph editor.

Read `packages/pipeline-engine/src/pipeline/types.ts` to verify the exact `ConfigField` interface.

```typescript
import { useTranslations } from 'next-intl';
// Import form components — READ existing form patterns to find Input, Select, Checkbox/Toggle, Slider
// from components/ui/

interface ConfigField {
  name: string;
  type: 'string' | 'number' | 'boolean' | 'enum' | 'array' | 'object';
  required: boolean;
  default?: unknown;
  description: string;
  validation?: { min?: number; max?: number };
  values?: string[]; // for enum type
}

interface ConfigSchemaFormProps {
  fields: ConfigField[];
  values: Record<string, unknown>;
  onChange: (key: string, value: unknown) => void;
  disabled?: boolean;
}

export function ConfigSchemaForm({ fields, values, onChange, disabled }: ConfigSchemaFormProps) {
  // For each field, render the appropriate input based on field.type:
  // - 'string' → Input (text)
  // - 'number' → Input (number) with min/max from validation
  // - 'boolean' → Toggle/Switch
  // - 'enum' → Select with field.values as options
  // - 'array' → multi-select or tag input (stretch goal)
  // - 'object' → nested form (stretch goal)
  //
  // Each field wrapped in a label group showing field.name + field.description
  // Show required indicator if field.required
  // Use field.default as placeholder when values[field.name] is undefined
}
```

Note: READ `apps/studio/src/components/ui/` directory to find the exact Input, Select, Toggle/Switch components available. Verify prop signatures before using them.

**Step 2: Build and verify**

Run: `pnpm build --filter=studio`

**Step 3: Commit**

```bash
npx prettier --write apps/studio/src/components/pipelines/ConfigSchemaForm.tsx
git add apps/studio/src/components/pipelines/ConfigSchemaForm.tsx
git commit -m "feat(studio): add ConfigSchemaForm dynamic form renderer"
```

---

## Task 10: TriggerManager Component

**Files:**

- Create: `apps/studio/src/components/pipelines/TriggerManager.tsx`

**Step 1: Build the trigger management component**

Displays the list of supported triggers with toggles and sampling rate controls.

```typescript
import { useTranslations } from 'next-intl';
// Import Toggle, Badge, Slider — READ component/ui/ for exact components

interface TriggerEntry {
  id: string;
  type: 'kafka' | 'schedule' | 'manual';
  kafkaTopic?: string;
  schedule?: string;
  label: string;
  description: string;
}

interface TriggerConfig {
  samplingRate?: number;
}

interface TriggerManagerProps {
  triggers: TriggerEntry[];
  activeTriggerIds: string[];
  triggerConfigs: Record<string, TriggerConfig>;
  onToggleTrigger: (triggerId: string, active: boolean) => void;
  onSamplingRateChange: (triggerId: string, rate: number) => void;
  disabled?: boolean;
}

export function TriggerManager({
  triggers,
  activeTriggerIds,
  triggerConfigs,
  onToggleTrigger,
  onSamplingRateChange,
  disabled,
}: TriggerManagerProps) {
  const t = useTranslations('pipelines.config');

  // Render each trigger as a row:
  // - Toggle (active/inactive)
  // - Label + description
  // - Type badge (Kafka/Schedule/Manual)
  // - Topic/schedule info (muted text)
  // - Sampling rate slider (0-100%) — only shown when active
}
```

**Step 2: Build and verify**

Run: `pnpm build --filter=studio`

**Step 3: Commit**

```bash
npx prettier --write apps/studio/src/components/pipelines/TriggerManager.tsx
git add apps/studio/src/components/pipelines/TriggerManager.tsx
git commit -m "feat(studio): add TriggerManager component"
```

---

## Task 11: PipelineConfigPage (Builtin Detail)

**Files:**

- Modify: `apps/studio/src/components/pipelines/PipelineConfigPage.tsx` (replace stub)

**Step 1: Implement the builtin config page**

Read `apps/studio/src/components/tools/ToolDetailPage.tsx` for the detail page pattern (back button, header, save/discard, dirty tracking).

```typescript
import { useState, useMemo } from 'react';
import useSWR from 'swr';
import { useTranslations } from 'next-intl';
import { ArrowLeft } from 'lucide-react';
import { useNavigationStore } from '../../store/navigation-store';
import { apiFetch } from '../../lib/api-client';
import { ConfigSchemaForm } from './ConfigSchemaForm';
import { TriggerManager } from './TriggerManager';
import { Badge } from '../ui/Badge';
// Import Button, Toggle — verify from ui/

export function PipelineConfigPage() {
  const t = useTranslations('pipelines.config');
  const projectId = useNavigationStore((s) => s.projectId);
  const subPage = useNavigationStore((s) => s.subPage); // pipelineType
  const navigate = useNavigationStore((s) => s.navigate);

  // Fetch config: GET /api/projects/:pid/pipeline-config/:type
  // Fetch schema: GET /api/projects/:pid/pipeline-config/:type/schema
  // Fetch triggers: GET /api/projects/:pid/pipeline-config/:type/triggers

  // Local state for draft config values
  // Dirty detection via useMemo comparing draft to fetched values

  // Save handler: PUT /api/projects/:pid/pipeline-config/:type
  // Toggle handler: PATCH /api/projects/:pid/pipeline-config/:type/toggle

  // Layout:
  // - Back button → navigate to /projects/:projectId/pipelines
  // - Header with pipeline name, Builtin badge, enable/disable toggle
  // - Save/Discard buttons (visible when dirty)
  // - Configuration section (ConfigSchemaForm)
  // - Triggers section (TriggerManager)
}
```

Note: Verify how `apiFetch` works by reading `apps/studio/src/lib/api-client.ts`. Also check whether the runtime API endpoints need to be proxied through Studio's Next.js API routes or can be called directly.

**Step 2: Build and verify**

Run: `pnpm build --filter=studio`

**Step 3: Commit**

```bash
npx prettier --write apps/studio/src/components/pipelines/PipelineConfigPage.tsx
git add apps/studio/src/components/pipelines/PipelineConfigPage.tsx
git commit -m "feat(studio): implement PipelineConfigPage for builtin pipeline configuration"
```

---

## Task 12: Node Palette (Graph Editor Left Panel)

**Files:**

- Create: `apps/studio/src/components/pipelines/NodePalette.tsx`

**Step 1: Build the node palette sidebar**

Fetches node types from `GET /api/pipelines/nodes`, groups by category, supports search and drag-to-canvas.

```typescript
import { useState, useMemo } from 'react';
import useSWR from 'swr';
import { useTranslations } from 'next-intl';
import { Search, ChevronDown, ChevronRight, GripVertical } from 'lucide-react';
import { clsx } from 'clsx';
import { usePipelineEditorStore } from '../../store/pipeline-editor-store';

// Node type from the API
interface NodeTypeDefinition {
  _id: string; // activity type ID
  label: string;
  description: string;
  category: 'data' | 'logic' | 'integration' | 'compute' | 'action';
  icon?: string;
  configSchema: Array<{ name: string; type: string; description: string }>;
}

interface NodePaletteProps {
  projectId: string;
}

export function NodePalette({ projectId }: NodePaletteProps) {
  const t = useTranslations('pipelines.editor');

  // Fetch node types: GET /api/pipelines/nodes
  // Group by category
  // Filter by search query
  // Each node type is draggable — use onDragStart to set transfer data

  // On drag start:
  // event.dataTransfer.setData('application/pipeline-node', JSON.stringify(nodeType));
  // event.dataTransfer.effectAllowed = 'move';

  // Layout:
  // - Search input at top
  // - Category accordions (collapsible)
  // - Each node type: icon + label + description (truncated)
  // - Drag handle (GripVertical) on hover
}
```

Note: READ `apps/studio/src/app/api/pipelines/nodes/route.ts` to verify the exact response shape for node types. Also check the `NodeTypeDefinition` schema at `packages/pipeline-engine/src/schemas/node-type-definition.schema.ts`.

**Step 2: Build and verify**

Run: `pnpm build --filter=studio`

**Step 3: Commit**

```bash
npx prettier --write apps/studio/src/components/pipelines/NodePalette.tsx
git add apps/studio/src/components/pipelines/NodePalette.tsx
git commit -m "feat(studio): add NodePalette component for graph editor"
```

---

## Task 13: PipelineNodeComponent (Custom React Flow Node)

**Files:**

- Create: `apps/studio/src/components/pipelines/PipelineNodeComponent.tsx`

**Step 1: Build the custom React Flow node**

Follow the pattern from `apps/studio/src/components/canvas/nodes/AgentNode.tsx`. Read it first to match the styling approach.

```typescript
import { memo } from 'react';
import { Handle, Position, type NodeProps } from '@xyflow/react';
import { clsx } from 'clsx';
import { Badge } from '../ui/Badge';

interface PipelineNodeData {
  label: string;
  activityType: string;
  category: 'data' | 'logic' | 'integration' | 'compute' | 'action';
  configSummary?: string;
  isSelected?: boolean;
  hasError?: boolean;
  errorMessage?: string;
  [key: string]: unknown;
}

export const PipelineNodeComponent = memo(function PipelineNodeComponent({
  data,
  selected,
}: NodeProps) {
  const nodeData = data as PipelineNodeData;

  // Category color map
  const categoryColors = {
    data: 'border-blue-500/50 bg-blue-500/5',
    logic: 'border-purple-500/50 bg-purple-500/5',
    integration: 'border-green-500/50 bg-green-500/5',
    compute: 'border-orange-500/50 bg-orange-500/5',
    action: 'border-red-500/50 bg-red-500/5',
  };

  // Render:
  // - Top Handle (target, Position.Top)
  // - Card with: label, category badge, activity type, config summary
  // - Error indicator if hasError
  // - Bottom Handle (source, Position.Bottom)
  // - Selected state: ring-2 ring-accent
});
```

**Step 2: Build and verify**

Run: `pnpm build --filter=studio`

**Step 3: Commit**

```bash
npx prettier --write apps/studio/src/components/pipelines/PipelineNodeComponent.tsx
git add apps/studio/src/components/pipelines/PipelineNodeComponent.tsx
git commit -m "feat(studio): add PipelineNodeComponent for graph editor"
```

---

## Task 14: PipelineEdgeComponent (Custom React Flow Edge)

**Files:**

- Create: `apps/studio/src/components/pipelines/PipelineEdgeComponent.tsx`

**Step 1: Build the custom edge component**

Follow the pattern from `apps/studio/src/components/canvas/RelationshipEdge.tsx`. Read it first.

```typescript
import { memo } from 'react';
import { BaseEdge, EdgeLabelRenderer, getSmoothStepPath, type EdgeProps } from '@xyflow/react';

interface PipelineEdgeData {
  condition?: string;
  label?: string;
  [key: string]: unknown;
}

export const PipelineEdgeComponent = memo(function PipelineEdgeComponent(props: EdgeProps) {
  const { sourceX, sourceY, targetX, targetY, sourcePosition, targetPosition, data, selected } =
    props;
  const edgeData = data as PipelineEdgeData | undefined;

  const [edgePath, labelX, labelY] = getSmoothStepPath({
    sourceX,
    sourceY,
    targetX,
    targetY,
    sourcePosition,
    targetPosition,
    borderRadius: 20,
  });

  // Render:
  // - BaseEdge with animated stroke
  // - EdgeLabelRenderer with condition label (if exists)
  // - Selected state: thicker stroke, accent color
  // - Hover state: increased opacity
});
```

**Step 2: Build and verify**

Run: `pnpm build --filter=studio`

**Step 3: Commit**

```bash
npx prettier --write apps/studio/src/components/pipelines/PipelineEdgeComponent.tsx
git add apps/studio/src/components/pipelines/PipelineEdgeComponent.tsx
git commit -m "feat(studio): add PipelineEdgeComponent for graph editor"
```

---

## Task 15: NodeConfigPanel (Right Slide-Over)

**Files:**

- Create: `apps/studio/src/components/pipelines/NodeConfigPanel.tsx`

**Step 1: Build the node configuration panel**

Opens when a node is selected. Shows editable config form + node settings.

```typescript
import { useTranslations } from 'next-intl';
import { X } from 'lucide-react';
import { motion, AnimatePresence } from 'framer-motion';
import { usePipelineEditorStore } from '../../store/pipeline-editor-store';
import { ConfigSchemaForm } from './ConfigSchemaForm';
// Import Input, Select, Button — verify from ui/

interface NodeConfigPanelProps {
  nodeTypes: Record<
    string,
    {
      configSchema: Array<{
        name: string;
        type: string;
        required: boolean;
        default?: unknown;
        description: string;
        validation?: { min?: number; max?: number };
        values?: string[];
      }>;
    }
  >;
}

export function NodeConfigPanel({ nodeTypes }: NodeConfigPanelProps) {
  const t = useTranslations('pipelines.editor');
  const selectedNodeId = usePipelineEditorStore((s) => s.selectedNodeId);
  const nodes = usePipelineEditorStore((s) => s.nodes);
  const updateNodeData = usePipelineEditorStore((s) => s.updateNodeData);
  const isOpen = usePipelineEditorStore((s) => s.nodeConfigPanelOpen);
  const setOpen = usePipelineEditorStore((s) => s.setNodeConfigPanelOpen);

  const selectedNode = nodes.find((n) => n.id === selectedNodeId);

  // Layout (slide-over from right, 320px wide, animated):
  // - Header: Node label (editable Input) + close button
  // - Activity type badge
  // - Config section: ConfigSchemaForm rendered from nodeTypes[activityType].configSchema
  // - Settings section: Timeout, Retries, On Failure (select: stop/skip/continue)
  // - Transitions section: List outgoing edges with condition editing
}
```

Note: READ `apps/studio/src/components/search-ai/pipelines/StageConfigPanel.tsx` for the existing slide-over pattern used for pipeline stage configuration. Match its animation and layout approach.

**Step 2: Build and verify**

Run: `pnpm build --filter=studio`

**Step 3: Commit**

```bash
npx prettier --write apps/studio/src/components/pipelines/NodeConfigPanel.tsx
git add apps/studio/src/components/pipelines/NodeConfigPanel.tsx
git commit -m "feat(studio): add NodeConfigPanel slide-over for graph editor"
```

---

## Task 16: PipelineEditorToolbar

**Files:**

- Create: `apps/studio/src/components/pipelines/PipelineEditorToolbar.tsx`

**Step 1: Build the editor top bar**

```typescript
import { useTranslations } from 'next-intl';
import { ArrowLeft, Check, AlertTriangle } from 'lucide-react';
import { useNavigationStore } from '../../store/navigation-store';
import { usePipelineEditorStore } from '../../store/pipeline-editor-store';
import { Badge } from '../ui/Badge';
// Import Button, Input — verify from ui/

export function PipelineEditorToolbar() {
  const t = useTranslations('pipelines.editor');
  const navigate = useNavigationStore((s) => s.navigate);
  const projectId = useNavigationStore((s) => s.projectId);
  const { pipelineName, pipelineStatus, isDirty, validationResult, setPipelineName } =
    usePipelineEditorStore();

  // Layout:
  // - Back button → /projects/:projectId/pipelines
  // - Pipeline name (inline editable)
  // - Status badge (draft/active/archived)
  // - Validation indicator (green check or yellow warning with error count)
  // - Spacer
  // - Validate button
  // - Save button (disabled when !isDirty)
  // - Activate/Deactivate button
}
```

**Step 2: Build and verify**

Run: `pnpm build --filter=studio`

**Step 3: Commit**

```bash
npx prettier --write apps/studio/src/components/pipelines/PipelineEditorToolbar.tsx
git add apps/studio/src/components/pipelines/PipelineEditorToolbar.tsx
git commit -m "feat(studio): add PipelineEditorToolbar component"
```

---

## Task 17: PipelineGraphCanvas (React Flow Canvas)

**Files:**

- Create: `apps/studio/src/components/pipelines/PipelineGraphCanvas.tsx`

**Step 1: Build the React Flow canvas**

Read `apps/studio/src/components/canvas/ProjectCanvas.tsx` for the exact React Flow setup pattern (imports, ReactFlowProvider, nodeTypes/edgeTypes registration, event handlers).

```typescript
import { useCallback, useMemo, useRef } from 'react';
import {
  ReactFlow,
  ReactFlowProvider,
  Background,
  Controls,
  MiniMap,
  useReactFlow,
  type OnNodesChange,
  type OnEdgesChange,
  type OnConnect,
  type Node,
  applyNodeChanges,
  applyEdgeChanges,
  addEdge,
} from '@xyflow/react';
import '@xyflow/react/dist/style.css';
import { usePipelineEditorStore } from '../../store/pipeline-editor-store';
import { PipelineNodeComponent } from './PipelineNodeComponent';
import { PipelineEdgeComponent } from './PipelineEdgeComponent';

const nodeTypes = {
  pipelineNode: PipelineNodeComponent,
};

const edgeTypes = {
  pipelineEdge: PipelineEdgeComponent,
};

function PipelineGraphCanvasInner() {
  const reactFlowWrapper = useRef<HTMLDivElement>(null);
  const { screenToFlowPosition } = useReactFlow();
  const nodes = usePipelineEditorStore((s) => s.nodes);
  const edges = usePipelineEditorStore((s) => s.edges);
  const setNodes = usePipelineEditorStore((s) => s.setNodes);
  const setEdges = usePipelineEditorStore((s) => s.setEdges);
  const selectNode = usePipelineEditorStore((s) => s.selectNode);
  const selectEdge = usePipelineEditorStore((s) => s.selectEdge);

  const onNodesChange: OnNodesChange = useCallback(
    (changes) => setNodes(applyNodeChanges(changes, nodes)),
    [nodes, setNodes],
  );

  const onEdgesChange: OnEdgesChange = useCallback(
    (changes) => setEdges(applyEdgeChanges(changes, edges)),
    [edges, setEdges],
  );

  const onConnect: OnConnect = useCallback(
    (params) => setEdges(addEdge({ ...params, type: 'pipelineEdge' }, edges)),
    [edges, setEdges],
  );

  // Handle drop from NodePalette
  const onDragOver = useCallback((event: React.DragEvent) => {
    event.preventDefault();
    event.dataTransfer.dropEffect = 'move';
  }, []);

  const onDrop = useCallback(
    (event: React.DragEvent) => {
      event.preventDefault();
      const nodeTypeData = event.dataTransfer.getData('application/pipeline-node');
      if (!nodeTypeData) return;

      const nodeType = JSON.parse(nodeTypeData);
      const position = screenToFlowPosition({ x: event.clientX, y: event.clientY });

      const newNode: Node = {
        id: `node-${Date.now()}`,
        type: 'pipelineNode',
        position,
        data: {
          label: nodeType.label,
          activityType: nodeType._id,
          category: nodeType.category,
          config: {},
        },
      };

      usePipelineEditorStore.getState().addNode(newNode);
    },
    [screenToFlowPosition],
  );

  const onNodeClick = useCallback((_: React.MouseEvent, node: Node) => {
    selectNode(node.id);
  }, [selectNode]);

  const onEdgeClick = useCallback((_: React.MouseEvent, edge: { id: string }) => {
    selectEdge(edge.id);
  }, [selectEdge]);

  const onPaneClick = useCallback(() => {
    selectNode(null);
    selectEdge(null);
  }, [selectNode, selectEdge]);

  // Delete key handler
  // Read ProjectCanvas for the exact key handling pattern

  return (
    <div ref={reactFlowWrapper} className="flex-1 h-full">
      <ReactFlow
        nodes={nodes}
        edges={edges}
        nodeTypes={nodeTypes}
        edgeTypes={edgeTypes}
        onNodesChange={onNodesChange}
        onEdgesChange={onEdgesChange}
        onConnect={onConnect}
        onDragOver={onDragOver}
        onDrop={onDrop}
        onNodeClick={onNodeClick}
        onEdgeClick={onEdgeClick}
        onPaneClick={onPaneClick}
        fitView
        deleteKeyCode="Delete"
        className="bg-background"
      >
        <Background />
        <Controls />
        <MiniMap />
      </ReactFlow>
    </div>
  );
}

export function PipelineGraphCanvas() {
  return (
    <ReactFlowProvider>
      <PipelineGraphCanvasInner />
    </ReactFlowProvider>
  );
}
```

**Step 2: Build and verify**

Run: `pnpm build --filter=studio`

**Step 3: Commit**

```bash
npx prettier --write apps/studio/src/components/pipelines/PipelineGraphCanvas.tsx
git add apps/studio/src/components/pipelines/PipelineGraphCanvas.tsx
git commit -m "feat(studio): add PipelineGraphCanvas with React Flow"
```

---

## Task 18: PipelineEditorPage (Full Page Container)

**Files:**

- Modify: `apps/studio/src/components/pipelines/PipelineEditorPage.tsx` (replace stub)

**Step 1: Implement the graph editor page**

This is the container that composes NodePalette + PipelineGraphCanvas + NodeConfigPanel + PipelineEditorToolbar.

```typescript
import { useEffect } from 'react';
import useSWR from 'swr';
import { useTranslations } from 'next-intl';
import { useNavigationStore } from '../../store/navigation-store';
import { usePipelineEditorStore } from '../../store/pipeline-editor-store';
import { apiFetch } from '../../lib/api-client';
import { PipelineEditorToolbar } from './PipelineEditorToolbar';
import { NodePalette } from './NodePalette';
import { PipelineGraphCanvas } from './PipelineGraphCanvas';
import { NodeConfigPanel } from './NodeConfigPanel';
import { AnimatePresence } from 'framer-motion';

export function PipelineEditorPage() {
  const t = useTranslations('pipelines.editor');
  const projectId = useNavigationStore((s) => s.projectId);
  const subPage = useNavigationStore((s) => s.subPage); // pipelineId
  const { setPipeline, reset, nodePaletteOpen, nodeConfigPanelOpen } = usePipelineEditorStore();

  // Fetch pipeline definition
  const { data: pipeline, error } = useSWR(
    subPage && subPage !== 'new' ? `/api/pipelines/${subPage}` : null,
  );

  // Fetch node types for config panel
  const { data: nodeTypesData } = useSWR('/api/pipelines/nodes');

  // Hydrate store on data load
  useEffect(() => {
    if (pipeline) {
      // Convert PipelineDefinition nodes/edges to React Flow format
      // setPipeline(...)
    }
    return () => reset();
  }, [pipeline]);

  // Handle "new" — create draft pipeline and redirect
  useEffect(() => {
    if (subPage === 'new' && projectId) {
      // POST /api/pipelines to create draft
      // Navigate to /projects/:projectId/pipelines/:newId
    }
  }, [subPage, projectId]);

  // Save handler
  const handleSave = async () => {
    // Convert React Flow nodes/edges back to PipelineDefinition format
    // PATCH /api/pipelines/:id
    // markSaved()
  };

  // Validate handler
  const handleValidate = async () => {
    // POST /api/pipelines/validate or inline validation
    // setValidationResult(...)
  };

  // Activate/Deactivate handler
  const handleToggleActive = async () => {
    // POST /api/pipelines/:id/activate or /deactivate
  };

  // Keyboard shortcut: Cmd+S to save
  useEffect(() => {
    const handler = (e: KeyboardEvent) => {
      if ((e.metaKey || e.ctrlKey) && e.key === 's') {
        e.preventDefault();
        handleSave();
      }
    };
    window.addEventListener('keydown', handler);
    return () => window.removeEventListener('keydown', handler);
  }, []);

  // Layout:
  // ┌──────────────────────────────────────────────────┐
  // │ PipelineEditorToolbar                             │
  // ├──────────┬─────────────────────────┬─────────────┤
  // │ NodePal  │ PipelineGraphCanvas     │ NodeConfig  │
  // │ (240px)  │ (flex-1)                │ (320px)     │
  // │          │                          │             │
  // └──────────┴─────────────────────────┴─────────────┘

  return (
    <div className="flex flex-col h-full">
      <PipelineEditorToolbar />
      <div className="flex-1 flex overflow-hidden">
        <AnimatePresence>
          {nodePaletteOpen && <NodePalette projectId={projectId!} />}
        </AnimatePresence>
        <PipelineGraphCanvas />
        <AnimatePresence>
          {nodeConfigPanelOpen && (
            <NodeConfigPanel nodeTypes={nodeTypesData?.nodeTypes ?? {}} />
          )}
        </AnimatePresence>
      </div>
    </div>
  );
}
```

Note: You MUST read the actual pipeline definition structure to understand how to convert between `PipelineNode[]` (backend) and React Flow `Node[]` (frontend). Key differences:

- Backend `PipelineNode` has `transitions: NodeTransition[]` → convert to React Flow `Edge[]`
- Backend `PipelineNode` has `position?: { x, y }` → map to React Flow `position`
- When saving, reverse the conversion

**Step 2: Build and verify**

Run: `pnpm build --filter=studio`

**Step 3: Commit**

```bash
npx prettier --write apps/studio/src/components/pipelines/PipelineEditorPage.tsx
git add apps/studio/src/components/pipelines/PipelineEditorPage.tsx
git commit -m "feat(studio): implement PipelineEditorPage graph editor container"
```

---

## Task 19: Auto-Layout Integration

**Files:**

- Create: `apps/studio/src/components/pipelines/usePipelineAutoLayout.ts`

**Step 1: Build the ELK auto-layout hook**

Follow the pattern from `apps/studio/src/components/canvas/useAutoLayout.ts`. Read it first.

```typescript
import { useCallback } from 'react';
import ELK from 'elkjs/lib/elk.bundled';
import type { Node, Edge } from '@xyflow/react';
import { usePipelineEditorStore } from '../../store/pipeline-editor-store';

const elk = new ELK();

const ELK_OPTIONS = {
  'elk.algorithm': 'layered',
  'elk.direction': 'DOWN',
  'elk.spacing.nodeNode': '80',
  'elk.layered.spacing.nodeNodeBetweenLayers': '120',
  'elk.layered.crossingMinimization.strategy': 'LAYER_SWEEP',
};

const NODE_WIDTH = 220;
const NODE_HEIGHT = 100;

export function usePipelineAutoLayout() {
  const setNodes = usePipelineEditorStore((s) => s.setNodes);

  const autoLayout = useCallback(
    async (nodes: Node[], edges: Edge[]) => {
      if (nodes.length === 0) return;

      const elkGraph = {
        id: 'root',
        layoutOptions: ELK_OPTIONS,
        children: nodes.map((n) => ({
          id: n.id,
          width: NODE_WIDTH,
          height: NODE_HEIGHT,
        })),
        edges: edges.map((e) => ({
          id: e.id,
          sources: [e.source],
          targets: [e.target],
        })),
      };

      const layout = await elk.layout(elkGraph);

      const layoutedNodes = nodes.map((node) => {
        const elkNode = layout.children?.find((n) => n.id === node.id);
        return {
          ...node,
          position: {
            x: elkNode?.x ?? node.position.x,
            y: elkNode?.y ?? node.position.y,
          },
        };
      });

      setNodes(layoutedNodes);
    },
    [setNodes],
  );

  return { autoLayout };
}
```

**Step 2: Build and verify**

Run: `pnpm build --filter=studio`

**Step 3: Commit**

```bash
npx prettier --write apps/studio/src/components/pipelines/usePipelineAutoLayout.ts
git add apps/studio/src/components/pipelines/usePipelineAutoLayout.ts
git commit -m "feat(studio): add ELK auto-layout hook for pipeline graph editor"
```

---

## Task 20: Studio API Proxy for Runtime Pipeline Config

**Files:**

- Create: `apps/studio/src/app/api/projects/[projectId]/pipeline-config/route.ts`
- Create: `apps/studio/src/app/api/projects/[projectId]/pipeline-config/[pipelineType]/route.ts`

The builtin pipeline config APIs live on the runtime server (port 3112). Studio needs proxy routes to forward these requests (same pattern as other runtime API proxies).

**Step 1: Check existing proxy pattern**

READ `apps/studio/src/app/api/` directory to find how other runtime API calls are proxied. Look for patterns like `fetch(RUNTIME_URL + ...)` or middleware that forwards requests to runtime.

Alternatively, check if `apiFetch` in `apps/studio/src/lib/api-client.ts` can call runtime directly.

**Step 2: Create proxy routes**

Follow whatever pattern exists. If no proxy exists and the client calls runtime directly, skip this task.

If proxies are needed, create:

`apps/studio/src/app/api/projects/[projectId]/pipeline-config/route.ts`:

```typescript
// Proxy GET /api/projects/:projectId/pipeline-config → Runtime
// Forward auth headers, return response
```

`apps/studio/src/app/api/projects/[projectId]/pipeline-config/[pipelineType]/route.ts`:

```typescript
// Proxy GET/PUT/PATCH → Runtime
// Forward auth headers, return response
```

Add similar proxies for `/schema`, `/triggers`, `/toggle` sub-routes.

**Step 3: Build and verify**

Run: `pnpm build --filter=studio`

**Step 4: Commit**

```bash
npx prettier --write apps/studio/src/app/api/projects/\[projectId\]/pipeline-config/
git add apps/studio/src/app/api/projects/\[projectId\]/pipeline-config/
git commit -m "feat(studio): add API proxy routes for runtime pipeline config"
```

---

## Task 21: Integration Testing & Polish

**Step 1: End-to-end build verification**

Run: `pnpm build`
Expected: Full monorepo build succeeds

**Step 2: Manual testing checklist**

- [ ] Navigate to Insights → Pipelines in sidebar
- [ ] Builtin tab shows all 10+ pipelines with correct names and status
- [ ] Click a builtin pipeline → config page loads with schema-driven form
- [ ] Toggle enable/disable works
- [ ] Modify config values → Save/Discard appear → Save persists
- [ ] Trigger toggles and sampling rate changes work
- [ ] Back button returns to list
- [ ] Custom tab shows empty state with Create button
- [ ] Create Pipeline → redirects to graph editor
- [ ] Node palette shows node types grouped by category
- [ ] Search filters node types
- [ ] Drag node from palette to canvas → node appears
- [ ] Connect two nodes → edge appears
- [ ] Click node → config panel opens with correct schema
- [ ] Modify node config → dirty state tracked
- [ ] Cmd+S saves pipeline
- [ ] Auto-layout arranges nodes properly
- [ ] Validate button checks pipeline structure
- [ ] Back button returns to list with pipeline visible

**Step 3: Fix any issues found during testing**

**Step 4: Final commit**

```bash
git add -A
git commit -m "feat(studio): pipeline configuration UI - integration fixes"
```

---

## Summary

| Task | Component                    | Dependencies         |
| ---- | ---------------------------- | -------------------- |
| 1    | Backend: list-all endpoint   | None                 |
| 2    | Navigation & routing + stubs | None                 |
| 3    | Zustand stores               | None                 |
| 4    | i18n strings                 | None                 |
| 5    | PipelineCard                 | None                 |
| 6    | BuiltinPipelinesList         | Tasks 1, 5           |
| 7    | CustomPipelinesList          | Task 5               |
| 8    | PipelinesListPage            | Tasks 2, 3, 6, 7     |
| 9    | ConfigSchemaForm             | None                 |
| 10   | TriggerManager               | None                 |
| 11   | PipelineConfigPage           | Tasks 2, 9, 10       |
| 12   | NodePalette                  | Task 3               |
| 13   | PipelineNodeComponent        | None                 |
| 14   | PipelineEdgeComponent        | None                 |
| 15   | NodeConfigPanel              | Tasks 3, 9           |
| 16   | PipelineEditorToolbar        | Task 3               |
| 17   | PipelineGraphCanvas          | Tasks 3, 13, 14      |
| 18   | PipelineEditorPage           | Tasks 12, 15, 16, 17 |
| 19   | Auto-layout hook             | None                 |
| 20   | Studio API proxy             | Task 1               |
| 21   | Integration testing          | All                  |

**Parallelizable groups:**

- Tasks 1-4 can all run in parallel (no dependencies)
- Tasks 5, 9, 10, 12, 13, 14, 16, 19 can run in parallel (leaf components)
- Tasks 6, 7 depend on 5
- Task 8 depends on 6, 7
- Tasks 11, 15 depend on 9
- Task 17 depends on 13, 14
- Task 18 depends on 12, 15, 16, 17
- Task 21 depends on everything

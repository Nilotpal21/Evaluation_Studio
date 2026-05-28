# Knowledge Base Page-Level Layout Audit (Revised)

> Design-system-aligned revision of the original KB page layout audit.
> Every recommendation in this document has been verified against the actual
> component source code, design tokens, and typography scale in the Studio codebase.
>
> Context: Pages are migrating from horizontal tabs (inside a constrained content
> area) to individual full-width pages behind a dual-sidebar pattern (icon strip
> 56px + nav sidebar 240px = 296px, leaving ~1104px on a 1400px viewport).

---

## 1. Design System Compliance Checklist

Before implementing any recommendation in this document, verify compliance with
every constraint below. Any deviation must be documented and approved.

### Layout Shells

| Constraint            | Rule                                                                                          | Source                                  |
| --------------------- | --------------------------------------------------------------------------------------------- | --------------------------------------- |
| List pages            | Use `ListPageShell` (24px page padding, 16px card padding, 12px item gap)                     | `components/ui/ListPageShell.tsx`       |
| Detail/settings pages | Use `DetailPageShell` (32px page padding, 24px card padding, 16px item gap, 32px section gap) | `components/ui/DetailPageShell.tsx`     |
| Content max-width     | `max-w-5xl mx-auto` (default) or `max-w-6xl mx-auto` -- never remove max-width                | `DetailPageShell` `maxWidthClasses` map |
| Canvas exception      | Pipeline and Knowledge Graph canvas pages may use `maxWidth="full"` on `DetailPageShell`      | Existing PipelineEditorV2 pattern       |

### Typography Scale (from `lib/typography.ts`)

| Role                             | Class                                                            | Constant                        |
| -------------------------------- | ---------------------------------------------------------------- | ------------------------------- |
| Page titles                      | `text-xl font-semibold` (20px)                                   | `TYPE_SCALE.pageTitle`          |
| Section headers                  | `text-lg font-semibold` (18px)                                   | --                              |
| Section headings (content areas) | `text-sm font-semibold text-foreground uppercase tracking-wider` | matches `Section` title pattern |
| Labels / section labels          | `text-xs font-medium uppercase tracking-wider text-muted`        | `SECTION_LABEL_CLASS`           |
| Body text                        | `text-sm` (14px)                                                 | `TYPE_SCALE.body`               |
| Hints / metadata                 | `text-xs text-muted`                                             | `TYPE_SCALE.label`              |
| KPI values                       | `text-2xl font-semibold` (24px)                                  | `TYPE_SCALE.kpi`                |

### Color System

| Constraint           | Rule                                                                                              |
| -------------------- | ------------------------------------------------------------------------------------------------- |
| No hardcoded palette | Never `bg-blue-500`, `text-red-400` etc. Use semantic tokens only                                 |
| Status badges        | `bg-{variant}-subtle text-{variant}` via `Badge` component with `variant` prop                    |
| Purple = AI only     | `variant="purple"` on `Badge`, `bg-purple-subtle text-purple` -- reserved for LLM/AI features     |
| Accent is monochrome | Never `bg-accent text-foreground` (invisible). Use `bg-accent text-accent-foreground`             |
| Status resolution    | Use `statusIntent()` from `@agent-platform/design-tokens` to map status strings to `BadgeVariant` |
| Elevation            | `background` < `background-subtle` < `background-muted` < `background-elevated`                   |

### Components (Reuse Only)

| Component                                                                          | Props to know                                                                                      | When to use                               |
| ---------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------- | ----------------------------------------- |
| `Badge`                                                                            | `variant`, `dot`, `pulse`, `appearance` (`subtle`/`outlined`)                                      | All status indicators                     |
| `MetricCard`                                                                       | `label`, `value`, `trend`, `context`, `icon`                                                       | Stats display with count-up animation     |
| `MiniSparkline`                                                                    | --                                                                                                 | Trend visualization in metric cards       |
| `Section`                                                                          | `title`, `description`, `icon`, `collapsible`, `variant` (`default`/`elevated`/`flat`), `helpText` | Content grouping with card border         |
| `SectionGroup`                                                                     | `spacing` (`sm`/`md`/`lg`)                                                                         | Vertical section stacking                 |
| `Card`                                                                             | `hoverable`, `padding` (`none`/`sm`/`md`/`lg`), `onClick`                                          | Clickable content cards                   |
| `ActivityTimeline`                                                                 | `items` (id, icon, description, timestamp), `maxItems`                                             | Activity feeds                            |
| `StatusDot`                                                                        | --                                                                                                 | Inline status indicators                  |
| `DataTable`                                                                        | `columns` (Column[]), data, sorting, selection                                                     | Tabular data                              |
| `FilterSelect`                                                                     | `value`, `onChange`, `options`                                                                     | Filter toolbars (never native `<select>`) |
| `EmptyState`                                                                       | `icon`, `title`, `description`, `action`                                                           | Zero states with CTA                      |
| `ErrorBoundary`                                                                    | `fallback`, `onError`                                                                              | Error wrapping with retry                 |
| `Skeleton`, `SkeletonText`, `SkeletonCard`, `SkeletonTable`, `SkeletonFormSection` | various                                                                                            | Loading states                            |
| `SlidePanel`                                                                       | `width`, `nonBlocking`, `noPadding`                                                                | Slide-over panels                         |
| `Tabs`                                                                             | `tabs` (id, label, icon, count), `layoutId`                                                        | Horizontal tab bars                       |
| `SegmentedControl`                                                                 | `options`, `value`, `size`                                                                         | 2-3 option pill toggles                   |
| `PageHeader`                                                                       | `title`, `description`, `actions`, `beforeActions`                                                 | Title + description + actions bar         |
| `Pagination`                                                                       | `page`, `totalPages`, `onPageChange`                                                               | Page controls                             |
| `InfoCard`                                                                         | `variant` (`info`/`warning`/`success`/`error`), `title`, `message`                                 | Contextual banners                        |
| `Progress`                                                                         | `value` (0-100)                                                                                    | Progress bars                             |
| `Toggle`                                                                           | `checked`, `onChange`, `label`, `description`                                                      | On/off switches                           |
| `Tooltip`                                                                          | --                                                                                                 | Hover tooltips                            |
| `ConfirmDialog`                                                                    | `title`, `description`, `confirmLabel`, `variant` (`danger`)                                       | Destructive confirmations                 |

### Animations (from `lib/animation.ts`)

| Preset            | Use case                                                                         | Config                      |
| ----------------- | -------------------------------------------------------------------------------- | --------------------------- |
| `springs.snappy`  | Tabs, layout indicators                                                          | stiffness: 500, damping: 30 |
| `springs.default` | Modals, pill switchers                                                           | stiffness: 400, damping: 30 |
| `springs.gentle`  | Sidebars, panels, drawers                                                        | stiffness: 300, damping: 30 |
| `springs.soft`    | Staggered node entrances                                                         | stiffness: 200, damping: 20 |
| Utility classes   | `.card-hover`, `.animate-fade-in-up`, `.stagger-children`, `.transition-default` | CSS-based                   |

### Error / Loading / Empty Standard

Every page MUST implement all three states:

- **Loading**: `Skeleton` layout matching the page structure (use `SkeletonTable`, `SkeletonCard`, `SkeletonFormSection` as appropriate)
- **Error**: `ErrorBoundary` wrapper with retry capability
- **Empty**: `EmptyState` component with contextual icon, messaging, and CTA button

### Accessibility

- Focus rings: `.focus-ring` class or `focus-visible:ring-2 focus-visible:ring-border-focus`
- All status indicators: text alternatives (not color-only) -- `Badge` with text label satisfies this
- ARIA labels on all interactive elements
- Respect `prefers-reduced-motion`
- Keyboard navigation for all interactive elements
- No native `<select>` -- use `Select` or `FilterSelect`

### i18n

- No bare English strings in JSX -- all text through `t()` from `useTranslations()`

---

## 2. Per-Page Audit

### Viewport Math

With the dual-sidebar pattern:

- Icon strip: 56px
- Nav sidebar: 240px (expanded)
- Content area: viewport - 296px
- At 1400px viewport: **1104px** content width
- `max-w-5xl` = 1024px, `max-w-6xl` = 1152px
- Effective content inside max-width + padding (32px each side): ~960px (5xl) or ~1088px (6xl)

---

### Page 1: Overview

**Purpose**: KB dashboard/landing page. Shows stats, needs attention, activity,
quick actions. Setup wizard when 0 docs.

#### 1. Shell

**Use `DetailPageShell`** with `maxWidth="lg"` (max-w-5xl).

Rationale: This is a dashboard/detail page, not a list page. It displays
heterogeneous content (metrics, alerts, activity, source summary) in sections,
not a homogeneous list. The `DetailPageShell` provides the comfortable spacing
(32px page padding, 24px card padding) appropriate for a dashboard.

The `DetailPageShell` `backTo` prop is unnecessary here since the sidebar
already provides navigation back to the KB list.

#### 2. Density

**Comfortable** (`.page-comfortable`). Dashboard pages need breathing room
between sections to establish visual hierarchy.

#### 3. Layout

```
+------------------------------------------------------------------+
| PageHeader                                                        |
|   text-xl font-semibold: "KB Name"                                |
|   text-sm text-muted: "description"         [Rebuild] [Preview]  |
+------------------------------------------------------------------+
|                                                                    |
|  SECTION_LABEL_CLASS: "OVERVIEW"                                  |
|  +------------------+------------------+------------------+       |
|  | MetricCard       | MetricCard       | MetricCard       |       |
|  | Sources: 5       | Documents: 1,234 | Chunks: 8,901   |       |
|  | trend + context  | trend + context  | trend + context  |       |
|  +------------------+------------------+------------------+       |
|                                                                    |
|  +-------------------------------+-------------------------------+ |
|  | Section: "Needs Attention"    | Section: "Recent Activity"    | |
|  | collapsible=false             | collapsible=false             | |
|  |                               |                               | |
|  | NeedsAttentionCard content    | ActivityTimeline items        | |
|  | (issues or "All clear" state) | maxItems=8                    | |
|  |                               |                               | |
|  +-------------------------------+-------------------------------+ |
|                                                                    |
|  SECTION_LABEL_CLASS: "YOUR SOURCES"          [View All ->]       |
|  +------------------------------+-------------------------------+ |
|  | SourceCard (compact row)     | SourceCard (compact row)      | |
|  +------------------------------+-------------------------------+ |
|  | SourceCard (compact row)     | SourceCard (compact row)      | |
|  +------------------------------+-------------------------------+ |
|                                                                    |
+------------------------------------------------------------------+
```

#### 4. Component Reuse

- `DetailPageShell` -- page wrapper with `maxWidth="lg"`
- `PageHeader` -- title bar (KB name + description + action buttons)
- `MetricCard` -- 3 stat cards (Sources, Documents, Chunks) with `trend` and `context` props
- `Section` -- for "Needs Attention" and "Recent Activity" sections, `variant="default"`
- `ActivityTimeline` -- for the activity feed (existing component, `maxItems={8}`)
- `Card` -- for compact source rows with `hoverable={true}` and `padding="sm"`
- `Badge` -- for source status indicators
- `EmptyState` -- for the setup wizard state (0 docs)
- `InfoCard` -- for "All clear" state in NeedsAttention (variant `success`)

#### 5. Typography

- KB name: `text-xl font-semibold text-foreground` (via `PageHeader`)
- KB description: `text-sm text-muted` (via `PageHeader`)
- Section labels: `SECTION_LABEL_CLASS` (`text-xs font-medium uppercase tracking-wider text-muted`)
- Metric card labels: `SECTION_LABEL_CLASS` (already used by `MetricCard` via import)
- Metric values: `text-2xl font-semibold text-foreground` (via `MetricCard` with `METRIC_NUMBER_CLASS`)
- Trend text: `text-xs font-medium` (via `MetricCard`)
- Activity descriptions: `text-sm text-foreground` (via `ActivityTimeline`)
- Activity timestamps: `text-xs text-subtle` (via `ActivityTimeline`)

#### 6. Status Indicators

- KB status: `Badge` with `variant` from `statusIntent(knowledgeBase.status)` mapped to `BadgeVariant`, `dot={true}`
- Active statuses (indexing, creating, rebuilding): add `pulse={true}` to indicate in-progress
- Source health: `Badge` with `variant` from `statusIntent(source.status)`, `appearance="outlined"` (quieter in dense list)
- NeedsAttention severity: use `severityIntent()` to map issue severity to badge variant

#### 7. AI Model Sections

No AI model config on this page. No purple tokens needed.

#### 8. Loading / Error / Empty

- **Loading**: 3x `Skeleton` cards in a `grid-cols-3` (height `h-24 rounded-xl`) for metrics, then 2x `SkeletonCard` in `grid-cols-2` for attention/activity, then 4x `Skeleton` rows (`h-12 rounded-lg`) for sources
- **Error**: Wrap entire page in `ErrorBoundary`. Fallback shows warning icon + "Failed to load overview" + retry button
- **Empty (0 docs)**: Render `SetupGuide` component (existing). Uses `EmptyState` with file upload icon, "Get started" title, "Upload documents or connect a source" description, and primary CTA button

#### 9. Specific Improvements

1. **Replace emoji section headers with Lucide icons.** Current `OperationsDashboard` uses "📊" and "🗂️" in section headers. Replace with nothing -- the `SECTION_LABEL_CLASS` pattern uses plain uppercase text without icons, matching `MetricCard`'s own label style
2. **Replace custom `StatCard` with `MetricCard`.** The existing `StatCard` in `OperationsDashboard` duplicates what `MetricCard` already provides (label, value, icon, trend, context). Use `MetricCard` with the `trend` prop for breakdown data instead of the custom breakdown section
3. **Switch source cards from vertical stack to 2-col grid.** Use `grid grid-cols-1 lg:grid-cols-2 gap-4` to prevent the sources list from becoming excessively long
4. **Use `Section` component for NeedsAttention/Activity grouping.** Currently these are bare `Card` wrappers. Using `Section` with `title` prop provides consistent header styling
5. **Replace bare "View All ->" text links with proper navigation.** The current `text-primary hover:underline` pattern is not a design system token. Use `text-accent hover:text-accent transition-default` or a `Button` with `variant="ghost"` and `size="sm"`

#### 10. What NOT to Do

- Do NOT remove `max-w-5xl` to make content span full width. The dashboard needs max-width to maintain readable line lengths
- Do NOT create a custom `StatCard` component -- use the existing `MetricCard`
- Do NOT use hardcoded colors for the "All clear" state (e.g., `bg-green-50`). Use `InfoCard` with `variant="success"` or `Badge` with `variant="success"`
- Do NOT add sparkline micro-charts without using the existing `MiniSparkline` component
- Do NOT use `text-primary` -- this is not a design system token. Use `text-accent` for interactive text

---

### Page 2: Sources

**Purpose**: Source management. Card or table view of sources. Health summary.
Add source flow. Bulk actions.

#### 1. Shell

**Use `ListPageShell`** with built-in search, filters, and pagination.

Rationale: This is a list page -- it displays a homogeneous collection of source
items with search, filter, and CRUD operations. `ListPageShell` provides the
compact spacing (24px page padding) and built-in toolbar infrastructure.

#### 2. Density

**Compact** (`.page-compact`). Sources are data-dense list items that benefit
from tighter spacing to show more items above the fold.

#### 3. Layout

```
+------------------------------------------------------------------+
| ListPageShell                                                     |
|   title: "Sources"                                                |
|   description: "Manage data sources"   [Add Source] (primaryAction)|
|                                                                    |
|   searchPlaceholder: "Search sources..."                          |
|   filters: [Type: All/Manual/Connector]  [Status: All/Active/...]  |
+------------------------------------------------------------------+
|                                                                    |
|  SegmentedControl: [Card View | Table View]                       |
|                                                                    |
|  --- Card View (when sources <= 6 or user prefers) ---            |
|  +------------------+------------------+------------------+       |
|  | Card: Source A   | Card: Source B   | Card: Source C   |       |
|  | Badge: Active    | Badge: Syncing   | Badge: Error     |       |
|  | 234 docs         | 12 docs          | 0 docs           |       |
|  | [Upload] [...]   | [View] [...]     | [Fix] [...]      |       |
|  +------------------+------------------+------------------+       |
|  | Card: Source D   | Card: + Add      |                  |       |
|  |                  | (dashed border)  |                  |       |
|  +------------------+------------------+------------------+       |
|                                                                    |
|  --- Table View (when sources > 6 or user prefers) ---            |
|  DataTable: columns=[Name, Type, Status, Documents, Last Synced, ]|
|  +-------+--------+----------+---------+-----------+------+      |
|  | Name  | Type   | Status   | Docs    | Last Sync | ...  |      |
|  +-------+--------+----------+---------+-----------+------+      |
|  | ...   | ...    | ...      | ...     | ...       | ...  |      |
|  +-------+--------+----------+---------+-----------+------+      |
|                                                                    |
|  Pagination (if > pageSize)                                       |
+------------------------------------------------------------------+
```

#### 4. Component Reuse

- `ListPageShell` -- page wrapper with search and filter support
- `SegmentedControl` -- card/table view toggle with `size="sm"`
- `Card` -- source cards with `hoverable={true}`, `padding="md"`
- `DataTable` -- table view with sortable columns
- `Badge` -- source status, `variant` from `statusIntent(source.status)`, `dot={true}`
- `FilterSelect` -- type and status filters (via `ListPageShell.filters`)
- `EmptyState` -- no sources state
- `Pagination` -- via `ListPageShell.pagination`
- `ConfirmDialog` -- delete source confirmation
- `Button` -- "Add Source" primary action

#### 5. Typography

- Page title: `text-xl font-semibold` (via `ListPageShell` > `PageHeader`)
- Source name in card: `text-sm font-medium text-foreground`
- Source type label: `text-xs text-muted`
- Document count: `text-sm font-semibold text-foreground font-mono`
- Last synced: `text-xs text-muted`
- Table headers: `text-xs font-medium uppercase tracking-wider text-muted` (via `DataTable` column headers)

#### 6. Status Indicators

- Source status: `Badge` with `variant` from `statusIntent(source.status)`, `dot={true}`
- Active + syncing states: add `pulse={true}` on Badge for `syncing`, `crawling` statuses
- Use `appearance="subtle"` for card view (visually prominent), `appearance="outlined"` for table view (quieter in dense rows)
- Source type: `Badge` with `variant="default"` (neutral)

#### 7. AI Model Sections

No AI model config on this page. No purple tokens needed.

#### 8. Loading / Error / Empty

- **Loading**: Card view: 6x `SkeletonCard` in `grid-cols-3`. Table view: `SkeletonTable` with `rows={8}` `cols={5}`
- **Error**: `ErrorBoundary` wrapping the content area. "Failed to load sources" + retry
- **Empty**: `EmptyState` with `Database` icon, "No sources yet", "Connect a data source or upload files to get started", action: `<Button>Add Source</Button>`

#### 9. Specific Improvements

1. **Let user view preference always win over auto-switch.** Currently the view auto-switches at 7+ sources, overriding stored preference. Store in localStorage (already done with `VIEW_MODE_STORAGE_KEY`) and never auto-override
2. **Use `ListPageShell` filter infrastructure.** Currently `DataSection` builds its own filter bar from scratch. Migrate to use `ListPageShell`'s `filters` prop for type/status filters, which provides consistent styling with other list pages
3. **Add `appearance="outlined"` to status badges in table view.** Table rows are dense; subtle badges are too visually heavy. The `Badge` component's `appearance="outlined"` gives a quieter presence at `text-xs`
4. **Replace bare "View All ->" text with `Button variant="ghost" size="sm"`.** Consistent with design system button treatments

#### 10. What NOT to Do

- Do NOT render source cards full-width (no grid). Always use `grid-cols-2 lg:grid-cols-3`
- Do NOT use a native `<select>` for type filtering -- use `FilterSelect`
- Do NOT create custom filter chip components -- use the badge-style filter pills already in `DataSection` (they follow the pattern: `rounded-full border border-default bg-background-elevated px-3 py-1 text-xs font-medium`)
- Do NOT hardcode source type colors (e.g., SharePoint = blue). Use `connectorIntent(source.name)` from design tokens for deterministic color assignment

---

### Page 3: Documents

**Purpose**: Document table with source filtering. Pipeline status per document.
Bulk actions. Expand row for chunks.

#### 1. Shell

**Use `ListPageShell`** with search, filters, and pagination.

Rationale: This is the primary data table page. It needs the compact spacing,
built-in search bar, filter support, and pagination that `ListPageShell` provides.

#### 2. Density

**Compact** (`.page-compact`). Document tables can have hundreds of rows.
Every pixel of vertical space matters.

#### 3. Layout

```
+------------------------------------------------------------------+
| ListPageShell                                                     |
|   title: "Documents"                                              |
|   description: "N documents across M sources"                    |
|   primaryAction: [Upload Files]                                   |
|                                                                    |
|   searchPlaceholder: "Search documents..."                        |
|   filters: [Source: All/...] [Status: All/Indexed/Processing/...]  |
+------------------------------------------------------------------+
|                                                                    |
|  Active filter badges (when filters applied):                     |
|  [Status: indexed x] [Source: SharePoint x]  Clear all            |
|                                                                    |
|  DataTable                                                        |
|  +------+--------+----------+--------+--------+--------+------+  |
|  |  [ ] | Name   | Source   | Status | Chunks | Size   | ...  |  |
|  +------+--------+----------+--------+--------+--------+------+  |
|  |  [ ] | doc.pdf| SP Files | Badge  | 12     | 1.2 MB | ...  |  |
|  |      | > expand for chunk preview                    |      |  |
|  +------+--------+----------+--------+--------+--------+------+  |
|  |  [ ] | ...    | ...      | ...    | ...    | ...    | ...  |  |
|  +------+--------+----------+--------+--------+--------+------+  |
|                                                                    |
|  Bulk action bar (when items selected):                           |
|  [N selected]  [Reprocess] [Delete]                               |
|                                                                    |
|  Pagination                                                       |
+------------------------------------------------------------------+
```

#### 4. Component Reuse

- `ListPageShell` -- page wrapper
- `DataTable` -- document table with expandable rows, sortable columns, row selection
- `Badge` -- document status with `variant` from `statusIntent(doc.status)`, `dot={true}`
- `FilterSelect` -- source and status filters
- `Pagination` -- via `ListPageShell.pagination`
- `EmptyState` -- no documents for current filter
- `ConfirmDialog` -- bulk delete confirmation
- `Tooltip` -- hover over truncated document names

#### 5. Typography

- Page title: `text-xl font-semibold` (via `ListPageShell` > `PageHeader`)
- Document name: `text-sm font-medium text-foreground` with `truncate`
- Source name: `text-xs text-muted`
- Chunk count / size: `text-sm text-foreground font-mono`
- Table headers: `text-xs font-medium uppercase tracking-wider text-muted`
- Filter badge text: `text-xs font-medium text-foreground`
- Expanded chunk preview: `text-xs text-muted` for content, `font-mono` for chunk IDs

#### 6. Status Indicators

- Document status: `Badge` with `variant` from `statusIntent(doc.status)`:
  - `indexed` -> `success`
  - `processing`, `extracting`, `enriching`, `embedding` -> `info` with `pulse={true}`
  - `error`, `failed` -> `error`
  - `pending` -> `warning`
- Use `appearance="outlined"` in the table for visual quietness
- Bulk status bar (when items selected): render as a sticky `div` with `bg-accent-subtle border border-accent` (not `bg-blue-50`)

#### 7. AI Model Sections

No AI model config on this page. No purple tokens needed.

#### 8. Loading / Error / Empty

- **Loading**: `SkeletonTable` with `rows={10}` `cols={6}` inside the content area
- **Error**: `ErrorBoundary` wrapping the table. "Failed to load documents" + retry
- **Empty (no docs at all)**: `EmptyState` with `FileText` icon, "No documents yet", "Upload files or connect a source to get started", action: `<Button>Upload Files</Button>`
- **Empty (filtered, no results)**: `EmptyState` with `Search` icon, "No documents match your filters", "Try adjusting your search or filters", action: `<Button variant="secondary" onClick={clearFilters}>Clear Filters</Button>`

#### 9. Specific Improvements

1. **Right-align numeric columns.** Chunk count and file size columns should use `text-right` alignment in `DataTable` column definition. This follows data table best practices and existing patterns in other Studio tables
2. **Add sticky table header.** For tables with 10+ rows, add `sticky top-0 z-10 bg-background` to the thead element so column headers remain visible during scroll
3. **Replace bare text "Clear all filters" with `Button variant="ghost" size="sm"`.** Currently uses raw `text-muted hover:text-foreground` styling
4. **Use `appearance="outlined"` for status badges in table rows.** Reduces visual noise in dense data

#### 10. What NOT to Do

- Do NOT render the document table without max-width constraints. Keep `ListPageShell`'s default `px-6` padding
- Do NOT create a custom expandable row component -- use `DataTable`'s row expansion capability
- Do NOT use color-only status indicators -- every status badge must include text (already satisfied by `Badge` with text children)
- Do NOT hardcode processing status colors -- use `statusIntent()` from design tokens

---

### Page 4: Pipeline

**Purpose**: Pipeline editor (ReactFlow canvas). Full-screen editor. Summary card
when not in editor mode. Embedding model config (AI). Vision/multimodal toggles (AI).

#### 1. Shell

**Use `DetailPageShell`** with `maxWidth="full"` for the canvas editor mode.
When showing a summary/non-editor view, use `maxWidth="lg"`.

Rationale: The pipeline editor is a canvas-based tool that needs full viewport
width for the ReactFlow graph. This is the documented exception to the max-width
constraint. The `DetailPageShell` still provides the page wrapper structure.

#### 2. Density

**Comfortable** for the summary view. **Full-bleed** for the canvas editor
(no density class -- canvas manages its own spacing).

#### 3. Layout

```
--- Summary View (before entering editor) ---
+------------------------------------------------------------------+
| DetailPageShell maxWidth="lg"                                     |
|   title: "Pipeline"                                               |
|   actions: [Edit Pipeline]                                        |
+------------------------------------------------------------------+
|                                                                    |
|  Section: "Pipeline Overview"                                     |
|  +--------------------------------------------------------------+ |
|  | Pipeline name, version, last modified                         | |
|  | Badge: status (draft/deployed/error)                          | |
|  | Stage count summary: "5 stages, 2 custom"                    | |
|  +--------------------------------------------------------------+ |
|                                                                    |
|  Section: "Embedding Model" (AI)                                  |
|  +--------------------------------------------------------------+ |
|  | border-l-2 border-purple (left accent for AI section)         | |
|  | Badge variant="purple": "AI-Powered"                          | |
|  | Provider: BGE-M3  |  Dimensions: 1024  |  Status: Active     | |
|  | [Change Model]                                                | |
|  +--------------------------------------------------------------+ |
|                                                                    |
|  Section: "Vision & Multimodal" (AI)                              |
|  +--------------------------------------------------------------+ |
|  | border-l-2 border-purple                                      | |
|  | Toggle: Enable vision processing                              | |
|  | Toggle: Enable multimodal embedding                           | |
|  +--------------------------------------------------------------+ |
|                                                                    |
+------------------------------------------------------------------+

--- Canvas Editor View ---
+------------------------------------------------------------------+
| PipelineToolbar (sticky top)                                      |
|   [< Back] Pipeline Name  [Save] [Deploy]  UnsavedIndicator      |
+------------------------------------------------------------------+
|                                                                    |
|  +-------------------------------------------+------------------+ |
|  | PipelineCanvasV2 (ReactFlow)              | DetailPanel      | |
|  | Full-bleed canvas                          | width: 420px     | |
|  | Swim lanes for stages                      | Stage config     | |
|  |                                            | Provider select  | |
|  |                                            |                  | |
|  |                                            |                  | |
|  +-------------------------------------------+------------------+ |
|                                                                    |
+------------------------------------------------------------------+
```

#### 4. Component Reuse

- `DetailPageShell` -- page wrapper with `maxWidth="full"` for canvas, `maxWidth="lg"` for summary
- `Section` -- for Pipeline Overview, Embedding Model, Vision config sections
- `Badge` -- pipeline status, `variant` from `statusIntent(pipeline.status)`; AI labels with `variant="purple"`
- `Toggle` -- vision and multimodal toggles
- `Card` -- provider info card in summary view
- `Button` -- Edit Pipeline, Save, Deploy, Change Model actions
- `ErrorBoundary` -- wrapping the canvas editor
- `InfoCard` -- for migration warnings (e.g., "Changing embedding model will require re-indexing")

#### 5. Typography

- Pipeline name: `text-xl font-semibold` (via `DetailPageShell` title)
- Section titles: `text-sm font-semibold text-foreground` (via `Section` title)
- Stage labels in canvas: `text-xs font-medium`
- Provider/model info: `text-sm text-foreground`
- Metadata (version, last modified): `text-xs text-muted`

#### 6. Status Indicators

- Pipeline status: `Badge` with `variant` from `statusIntent(pipeline.status)`, `dot={true}`
- Unsaved changes: `UnsavedIndicator` component (existing) -- uses `Badge` with `variant="warning"` and `dot={true}` `pulse={true}`
- Deployment status: `Badge` with `variant="success"` for deployed, `variant="warning"` for draft

#### 7. AI Model Sections

**Embedding Model** and **Vision/Multimodal** sections use purple tokens:

- Section border: `border-l-2 border-purple` on the `Section` component wrapper
- AI label badge: `<Badge variant="purple">AI-Powered</Badge>`
- Model provider card: standard `Card` -- no purple background, just the left border accent
- Do NOT use `bg-purple-subtle` as a section background -- it is too loud. Use the left border accent only

#### 8. Loading / Error / Empty

- **Loading (summary)**: `SkeletonFormSection` with `sections={3}` for the three config sections
- **Loading (canvas)**: `PipelineSkeleton` (existing component with fake nodes and edges)
- **Error**: `ErrorBoundary` wrapping the entire editor. Shows `AlertCircle` icon + "Failed to load pipeline editor" + retry
- **Empty (no pipeline)**: `EmptyPipelineState` (existing). Uses `EmptyState` with pipeline icon, "No pipeline configured", CTA to create

#### 9. Specific Improvements

1. **Use `Section` component for embedding model config.** Currently `EmbeddingModelSection` builds its own card wrapper. Wrap the content in `<Section title="Embedding Model" icon={<Box />}>` for consistent header styling
2. **Add left border accent for AI sections.** Wrap AI config sections in a `<div className="border-l-2 border-purple">` to visually distinguish AI-powered configuration from standard settings. This uses the purple semantic token appropriately
3. **Replace `ChevronDown` expand/collapse with `Section collapsible={true}`.** The `EmbeddingModelSection` has a custom expand/collapse implementation. Use the `Section` component's built-in `collapsible` prop instead

#### 10. What NOT to Do

- Do NOT constrain the canvas with `max-w-5xl`. Canvas pages use `maxWidth="full"`
- Do NOT use `bg-purple-subtle` as a full section background. Purple backgrounds are reserved for badge fills. Use `border-l-2 border-purple` for section accents
- Do NOT mix CSS keyframes with Framer Motion on the pipeline canvas nodes. Use `springs.soft` for staggered node entrances
- Do NOT create custom skeleton components for the canvas -- use the existing `PipelineSkeleton`

---

### Page 5: Fields

**Purpose**: Field mappings. My Fields / Suggested / Unmapped tabs.
Expandable rows with connector sources. Field mapping suggestion model config (AI).

#### 1. Shell

**Use `DetailPageShell`** with `maxWidth="lg"` (max-w-5xl).

Rationale: Fields is a detail page with tabbed content (My Fields / Suggested /
Unmapped). The tabs within the page content use the `Tabs` component. The
`DetailPageShell` provides the comfortable spacing for the mixed content of
tables, expandable groups, and configuration forms.

#### 2. Density

**Comfortable** (`.page-comfortable`) for the overall page. The field mapping
tables within each tab use compact row spacing internally.

#### 3. Layout

```
+------------------------------------------------------------------+
| DetailPageShell maxWidth="lg"                                     |
|   title: "Fields"                                                 |
|   actions: [Add Field]                                            |
+------------------------------------------------------------------+
|                                                                    |
|  Tabs: [My Fields (24)] [Suggested (8)] [Unmapped (12)]          |
|  ─────────────────────────────────────────────────────            |
|                                                                    |
|  --- My Fields Tab ---                                            |
|  SegmentedControl: [By Field | By Connector]  size="sm"          |
|                                                                    |
|  Expandable group: "Priority Level"  Badge: "3 sources"          |
|  +--------------------------------------------------------------+ |
|  | > SharePoint: priority  Badge: 95%  [Edit] [Vocab] [Remove]  | |
|  | > Jira: priority_level  Badge: 87%  [Edit] [Vocab] [Remove]  | |
|  | > Manual: urgency       Badge: 72%  [Edit] [Vocab] [Remove]  | |
|  +--------------------------------------------------------------+ |
|                                                                    |
|  Expandable group: "Status"  Badge: "2 sources"                  |
|  +--------------------------------------------------------------+ |
|  | ...                                                           | |
|  +--------------------------------------------------------------+ |
|                                                                    |
|  --- Suggested Tab ---                                            |
|  Sticky bulk action bar (when high-confidence suggestions exist): |
|  +--------------------------------------------------------------+ |
|  | bg-success-subtle: "5 high-confidence ready"  [Accept All]    | |
|  +--------------------------------------------------------------+ |
|                                                                    |
|  Suggestion rows sorted by confidence:                            |
|  +--------------------------------------------------------------+ |
|  | > source_path -> Canonical Field  Badge: 0.92 High           | |
|  |   Badge: "Direct copy"   text-xs text-subtle: connector name | |
|  |   [Accept] [Reject]                                          | |
|  +--------------------------------------------------------------+ |
|                                                                    |
|  --- Unmapped Tab ---                                             |
|  Per-connector sections with Load/Refresh:                        |
|  +--------------------------------------------------------------+ |
|  | Source Name  "12 unmapped of 45"  [Load]                      | |
|  | field rows with [Map] action                                  | |
|  +--------------------------------------------------------------+ |
|                                                                    |
|  Section: "Field Mapping Model" (AI)                              |
|  +--------------------------------------------------------------+ |
|  | border-l-2 border-purple                                      | |
|  | Badge variant="purple": "AI-Suggested"                        | |
|  | Model used for field suggestions: GPT-4o                      | |
|  | [Configure Model]                                             | |
|  +--------------------------------------------------------------+ |
|                                                                    |
+------------------------------------------------------------------+
```

#### 4. Component Reuse

- `DetailPageShell` -- page wrapper
- `Tabs` -- My Fields / Suggested / Unmapped with `count` prop for badge numbers
- `SegmentedControl` -- By Field / By Connector toggle, `size="sm"`
- `Badge` -- confidence levels (`variant` from `confidenceVariant()`), status, counts
- `DataTable` -- for flat table view of mappings
- `EmptyState` -- "No mapped fields yet" / "All suggestions reviewed"
- `Button` -- Add Field, Accept All, Accept, Reject actions
- `Dialog` -- Add/Edit field dialog, Edit mapping dialog
- `ConfirmDialog` -- Remove mapping confirmation
- `Toggle` -- Field capability toggles (filterable, sortable, aggregatable)
- `Select` -- Type selection in field form (NOT native `<select>`)
- `Input` -- Field name, label, description inputs

#### 5. Typography

- Page title: `text-xl font-semibold` (via `DetailPageShell`)
- Group headers (field names): `text-sm font-medium text-foreground`
- Source paths: `font-mono text-xs text-foreground`
- Connector names: `text-xs text-muted` (in group rows) or `text-xs text-subtle` (in suggestion details)
- Confidence values: `font-mono font-semibold` (inside `Badge`)
- Tab counts: via `Tabs` `count` prop (renders in the existing pill style)

#### 6. Status Indicators

- Confidence levels: `Badge` with variant from existing `confidenceVariant()`:
  - > = 0.8: `variant="success"` (High)
  - > = 0.5: `variant="warning"` (Medium)
  - < 0.5: `variant="error"` (Low)
- Mapping status: `Badge variant="default"` for transform type labels
- Custom field indicator: `Badge variant="warning"` text "Custom"
- Suggestion row left borders: `border-l-2` with color from confidence level (already implemented in `confidenceRowStyle()`)

#### 7. AI Model Sections

Field mapping suggestions are AI-powered. Display at the bottom of the page:

- `Section` with `title="Field Mapping Model"`, wrapped in `<div className="border-l-2 border-purple">`
- `Badge variant="purple"` with text "AI-Suggested"
- Model info in `text-sm text-foreground`
- Do NOT color the entire section background purple

#### 8. Loading / Error / Empty

- **Loading**: `SkeletonTable` with `rows={6}` `cols={4}` for each tab content area
- **Error**: `ErrorBoundary` wrapping the tabbed content
- **Empty (My Fields)**: `EmptyState` with `Check` icon, "No mapped fields yet", "Review suggestions in the 'Suggested' tab to start mapping fields"
- **Empty (Suggested)**: `EmptyState` with `Check` icon, "All suggestions reviewed", "Check 'Unmapped Fields' for any remaining fields"
- **Empty (Unmapped)**: `EmptyState` with `Check` icon, "All fields are mapped"

#### 9. Specific Improvements

1. **Replace custom `bg-surface-secondary` / `bg-surface` classes.** The `FieldsTab` uses non-standard surface tokens (`bg-surface-secondary`, `bg-surface`). Replace with standard elevation tokens: `bg-background-muted` for inactive toggle background, `bg-background-elevated` for active
2. **Use `SegmentedControl` for By Field / By Connector toggle.** Currently uses custom button-based toggle with `bg-surface-secondary`. Replace with the existing `SegmentedControl` component at `size="sm"`
3. **Wrap expandable field groups in `Section` component.** Currently uses raw `div` with `rounded-xl border border-default bg-surface`. Use `Section` with `variant="default"` for consistent card styling

#### 10. What NOT to Do

- Do NOT use `bg-surface` or `bg-surface-secondary` -- these are not standard design tokens. Use `bg-background-elevated` and `bg-background-muted`
- Do NOT create custom pill toggles -- use `SegmentedControl`
- Do NOT hardcode confidence colors -- always go through `confidenceVariant()` to `Badge variant`
- Do NOT use bare `<input>` elements -- use the `Input` component which provides consistent styling

---

### Page 6: Vocabulary

**Purpose**: Vocabulary terms table. Search, filter, CRUD. Vocabulary generation
model config (AI).

#### 1. Shell

**Use `ListPageShell`** with search, filters, and pagination.

Rationale: This is a data table page for vocabulary entries with search,
filter, pagination, and CRUD. Same pattern as Sources and Documents.

#### 2. Density

**Compact** (`.page-compact`). Vocabulary entries are table rows with
potentially hundreds of terms.

#### 3. Layout

```
+------------------------------------------------------------------+
| ListPageShell                                                     |
|   title: "Vocabulary"                                             |
|   description: "Domain-specific terms for better search accuracy" |
|   primaryAction: [Add Term]                                       |
|   secondaryActions: [Test] [Generate]                             |
|                                                                    |
|   searchPlaceholder: "Search vocabulary..."                       |
|   filters: [Status: Active/Inactive/All] [Source: Auto/Manual/All]|
+------------------------------------------------------------------+
|                                                                    |
|  DataTable                                                        |
|  +------+----------+----------+---------+--------+------+------+  |
|  | Term | Synonyms | Category | Status  | Source | Used | ...  |  |
|  +------+----------+----------+---------+--------+------+------+  |
|  | ...  | ...      | ...      | Badge   | Badge  | ...  | ...  |  |
|  +------+----------+----------+---------+--------+------+------+  |
|                                                                    |
|  Pagination (50 per page)                                         |
|                                                                    |
|  Section: "Vocabulary Generation" (AI)                            |
|  +--------------------------------------------------------------+ |
|  | border-l-2 border-purple                                      | |
|  | Badge variant="purple": "AI-Generated"                        | |
|  | Auto-generated from document analysis                         | |
|  | [Configure Model] [Generate Now]                              | |
|  +--------------------------------------------------------------+ |
|                                                                    |
+------------------------------------------------------------------+
```

#### 4. Component Reuse

- `ListPageShell` -- page wrapper with search, filters, pagination
- `DataTable` -- vocabulary entries table with sorting
- `Badge` -- status (active/inactive), source (auto/manual)
- `FilterSelect` -- status and source filters
- `Pagination` -- via `ListPageShell.pagination`
- `EmptyState` -- no vocabulary entries
- `Dialog` -- create/edit vocabulary entry form
- `ConfirmDialog` -- delete entry confirmation
- `Toggle` -- enable/disable entry inline
- `Button` -- Add Term, Test, Generate actions
- `DropdownMenu` -- per-row actions (Edit, Delete, Toggle)
- `Section` -- AI config section

#### 5. Typography

- Page title: `text-xl font-semibold` (via `ListPageShell`)
- Term text: `text-sm font-medium text-foreground`
- Synonyms: `text-xs text-muted` (comma-separated)
- Category: `text-xs text-muted`
- Table headers: `text-xs font-medium uppercase tracking-wider text-muted`

#### 6. Status Indicators

- Entry status: `Toggle` inline for active/inactive + `Badge` with `variant="success"` (active) or `variant="default"` (inactive)
- Source badge: `Badge variant="purple"` for auto-generated, `Badge variant="default"` for manual
- Use `appearance="outlined"` in table rows for visual quietness

#### 7. AI Model Sections

Vocabulary generation is AI-powered:

- `Section` wrapped in `<div className="border-l-2 border-purple">` at the bottom of the page
- `Badge variant="purple"` with text "AI-Generated"
- Do NOT use purple background on the entire section

#### 8. Loading / Error / Empty

- **Loading**: `SkeletonTable` with `rows={8}` `cols={6}`
- **Error**: `ErrorBoundary` wrapping the table content
- **Empty**: `EmptyState` with `BookOpen` icon, "No vocabulary terms", "Add terms manually or generate them from your documents", action: `<Button>Add Term</Button>`

#### 9. Specific Improvements

1. **Use `ListPageShell` filter infrastructure.** Currently `VocabularyTab` builds its own search and filter UI from scratch. Migrate to `ListPageShell` which provides consistent search input, filter chips, and pagination
2. **Replace custom `MoreVertical` dropdown with `DropdownMenu`.** Already using `DropdownMenu` -- verify it uses `DropdownMenuItem` (not custom div-based items)
3. **Add `appearance="outlined"` to status badges in table rows.** Vocabulary tables are dense; subtle badges create visual noise

#### 10. What NOT to Do

- Do NOT build a custom search input -- use `ListPageShell`'s built-in `onSearchChange`
- Do NOT use `Filter` icon for the filter button -- `FilterSelect` component handles this
- Do NOT color vocabulary auto-generated rows with a purple background -- use `Badge variant="purple"` for the source indicator only

---

### Page 7: Knowledge Graph

**Purpose**: KG with onboarding states, taxonomy management, graph visualization,
statistics, attributes. KG extraction model config (AI). Canvas page.

#### 1. Shell

**Use `DetailPageShell`** with `maxWidth="full"` for the graph visualization canvas.
When showing onboarding or non-canvas states, use `maxWidth="lg"`.

Rationale: The Knowledge Graph page has two modes: onboarding (cards/forms, needs
max-width) and exploration (force-directed graph canvas, needs full-bleed). The
`DetailPageShell` supports both via the `maxWidth` prop.

#### 2. Density

**Comfortable** for onboarding states. **Full-bleed** for the graph canvas.

#### 3. Layout

```
--- Onboarding State (no KG configured) ---
+------------------------------------------------------------------+
| DetailPageShell maxWidth="lg"                                     |
|   title: "Knowledge Graph"                                        |
+------------------------------------------------------------------+
|                                                                    |
|  KGOnboardingCard (or KGNotDeployedCard)                          |
|  +--------------------------------------------------------------+ |
|  | Section: "Knowledge Graph"                                    | |
|  | icon: Network                                                 | |
|  | Value proposition + setup CTA                                 | |
|  | [Enable Knowledge Graph]                                      | |
|  +--------------------------------------------------------------+ |
|                                                                    |
+------------------------------------------------------------------+

--- Active State (KG enabled + taxonomy) ---
+------------------------------------------------------------------+
| DetailPageShell maxWidth="full"                                   |
|   title: "Knowledge Graph"                                        |
|   actions: [Run Enrichment] [...]                                 |
+------------------------------------------------------------------+
|                                                                    |
|  SegmentedControl: [Graph | Tree | Stats | Attributes]            |
|                                                                    |
|  --- Graph View ---                                               |
|  +-------------------------------------------+------------------+ |
|  | KGForceGraph (canvas)                     | Node Detail      | |
|  | Full-bleed force-directed graph           | SlidePanel 320px | |
|  | Node click populates detail               | nonBlocking      | |
|  |                                            | Entity info      | |
|  |                                            | Relationships    | |
|  +-------------------------------------------+------------------+ |
|                                                                    |
|  --- Tree View ---                                                |
|  KGTaxonomyTree (expandable tree)                                |
|                                                                    |
|  --- Stats View ---                                               |
|  MetricCard grid: Entities, Relationships, Classifications        |
|  DataTable: entity type distribution                              |
|                                                                    |
|  --- Attributes View ---                                          |
|  AttributeManagerSection                                          |
|                                                                    |
|  Section: "KG Extraction Model" (AI)                              |
|  +--------------------------------------------------------------+ |
|  | border-l-2 border-purple                                      | |
|  | Badge variant="purple": "AI-Extracted"                        | |
|  | Model config for entity/relationship extraction               | |
|  | [Configure Model]                                             | |
|  +--------------------------------------------------------------+ |
|                                                                    |
+------------------------------------------------------------------+
```

#### 4. Component Reuse

- `DetailPageShell` -- page wrapper with dynamic `maxWidth`
- `SegmentedControl` -- Graph/Tree/Stats/Attributes view toggle
- `Section` -- for onboarding card, stats sections, AI config
- `Card` -- onboarding value proposition
- `Badge` -- entity type indicators, KG status
- `MetricCard` -- stats view (Entities, Relationships, etc.)
- `DataTable` -- entity distribution table in stats view
- `SlidePanel` -- node detail panel with `nonBlocking={true}`, `width="md"`
- `EmptyState` -- KG not enabled state
- `Toggle` -- KG enable/disable
- `InfoCard` -- warnings about enrichment requirements

#### 5. Typography

- Page title: `text-xl font-semibold`
- Entity names in graph: `text-xs font-medium` (node labels)
- Relationship labels: `text-xs text-muted`
- Stats values: `text-2xl font-semibold font-mono` (via `MetricCard`)
- Taxonomy tree items: `text-sm text-foreground`

#### 6. Status Indicators

- KG overall status: `Badge` with `variant` from `statusIntent()`, `dot={true}`
- Enrichment status: `Badge variant="info" pulse={true}` for running enrichments
- Entity type badges: `Badge variant="default"` with entity type name

#### 7. AI Model Sections

KG extraction is AI-powered:

- `Section` wrapped in `<div className="border-l-2 border-purple">`
- `Badge variant="purple"` with text "AI-Extracted"
- Model selection for entity and relationship extraction
- Do NOT use purple backgrounds on graph nodes -- nodes use standard `bg-background-elevated` with `border-default`

#### 8. Loading / Error / Empty

- **Loading (graph)**: `SkeletonGraph` (existing component with fake nodes and edges)
- **Loading (stats)**: 3x `Skeleton` cards (`h-24 rounded-xl`) + `SkeletonTable`
- **Error**: `ErrorBoundary` wrapping the entire KG section
- **Empty (KG not enabled)**: `KGOnboardingCard` (existing) with value proposition and enable CTA
- **Empty (KG not deployed)**: `KGNotDeployedCard` (existing) with infrastructure message
- **Empty (no taxonomy)**: `KGTaxonomySetupCard` (existing) with taxonomy creation CTA

#### 9. Specific Improvements

1. **Use `SlidePanel` with `nonBlocking={true}` for graph node detail.** Currently the node detail might use a modal. The graph should remain interactive while viewing node details -- `nonBlocking` mode allows this
2. **Use `springs.soft` for graph node entrance animations.** The force-directed graph nodes should stagger in using `springs.soft` (stiffness: 200, damping: 20) for an organic feel
3. **Respect `prefers-reduced-motion`.** Graph animations should check `window.matchMedia('(prefers-reduced-motion: reduce)')` and disable spring animations if the user prefers reduced motion

#### 10. What NOT to Do

- Do NOT constrain the graph canvas with `max-w-5xl`. Use `maxWidth="full"` on `DetailPageShell`
- Do NOT use CSS keyframes for graph node animations -- use Framer Motion springs
- Do NOT use hardcoded colors for entity type nodes. Use `connectorIntent(entityType)` for deterministic color assignment from the design token palette
- Do NOT create a custom toggle for KG enable/disable -- use the existing `Toggle` component

---

### Page 8: Search & Test

**Purpose**: Query playground, diagnostics, debug, history/compare.
Query LLM config (AI).

#### 1. Shell

**Use `DetailPageShell`** with `maxWidth="xl"` (max-w-6xl).

Rationale: The search playground has a two-column layout (query + results on the
left, diagnostics on the right) that benefits from wider content. Using `xl`
(max-w-6xl = 1152px) gives enough room for the split-pane layout while still
maintaining readable widths in each column.

#### 2. Density

**Comfortable** (`.page-comfortable`). The query input and results need
breathing room. Diagnostics in the side panel can be compact internally.

#### 3. Layout

```
+------------------------------------------------------------------+
| DetailPageShell maxWidth="xl"                                     |
|   title: "Search & Test"                                          |
|   actions: [History] [Compare]                                    |
+------------------------------------------------------------------+
|                                                                    |
|  +--------------------------------------+------------------------+|
|  | Query Playground (2/3)               | Diagnostics (1/3)      ||
|  |                                      |                        ||
|  | [Search input with submit]           | Section: "Query Info"  ||
|  |                                      | Model: GPT-4o          ||
|  | Results list:                        | Latency: 234ms         ||
|  | +----------------------------------+ | Tokens: 1,234          ||
|  | | Result 1: title, excerpt, score  | |                        ||
|  | | Badge: relevance score           | | Section: "Resolution"  ||
|  | +----------------------------------+ | ResolutionChain        ||
|  | | Result 2: ...                    | | stage-by-stage trace   ||
|  | +----------------------------------+ |                        ||
|  | | Result 3: ...                    | | Section: "Scores"      ||
|  | +----------------------------------+ | ScoreBreakdown         ||
|  |                                      |                        ||
|  +--------------------------------------+------------------------+|
|                                                                    |
|  Section: "Query LLM" (AI)                                       |
|  +--------------------------------------------------------------+ |
|  | border-l-2 border-purple                                      | |
|  | Badge variant="purple": "AI-Enhanced"                         | |
|  | Connected model: GPT-4o                                       | |
|  | [Configure Model]                                             | |
|  +--------------------------------------------------------------+ |
|                                                                    |
+------------------------------------------------------------------+
```

#### 4. Component Reuse

- `DetailPageShell` -- page wrapper with `maxWidth="xl"`
- `Section` -- for query info, resolution chain, score breakdown, AI config
- `Card` -- search result items with `hoverable={true}`
- `Badge` -- relevance scores, query status, AI label
- `Button` -- submit query, history, compare
- `Input` -- search query input
- `Tabs` -- for History / Compare sub-views
- `DataTable` -- query history table
- `SlidePanel` -- for expanded diagnostics or history detail
- `InfoCard` -- "No LLM connected" warning

#### 5. Typography

- Page title: `text-xl font-semibold`
- Query input: `text-sm` in standard `Input` component
- Result titles: `text-sm font-medium text-foreground`
- Result excerpts: `text-xs text-muted` with `line-clamp-2`
- Relevance scores: `font-mono text-xs font-semibold` inside `Badge`
- Latency / token counts: `text-xs text-muted` with `font-mono` for values
- Resolution chain stages: `text-xs font-medium text-foreground` for stage names
- Debug details: `text-xs text-muted font-mono`

#### 6. Status Indicators

- Query execution: `Badge variant="info" pulse={true}` while query is running
- Query success: `Badge variant="success"` with latency
- Query error: `Badge variant="error"` with error message
- Model connection: `Badge variant="success" dot={true}` when connected, `Badge variant="warning" dot={true}` when not configured
- Stage status in resolution chain: use `pipelineStageIntent(stage.type)` for color mapping

#### 7. AI Model Sections

Query LLM configuration is AI-powered:

- `Section` wrapped in `<div className="border-l-2 border-purple">`
- `Badge variant="purple"` with text "AI-Enhanced"
- Connected model name displayed in `text-sm text-foreground`
- [Configure Model] button opens model selection dialog

#### 8. Loading / Error / Empty

- **Loading (initial)**: `SkeletonFormSection sections={1}` for query input + 3x `Skeleton h-20 rounded-xl` for result placeholders + `SkeletonCard` for diagnostics panel
- **Error**: `ErrorBoundary` wrapping the query section
- **Empty (no query run)**: Show `EmptyState` in the results area with `Search` icon, "Run a query to see results", "Enter a search query above and press Enter"
- **Empty (no results)**: `EmptyState` with `Search` icon, "No results found", "Try different search terms or check your pipeline configuration"
- **Empty (no LLM connected)**: `InfoCard variant="warning"` with message "No LLM model connected. Query enhancement and answer generation require a connected model."

#### 9. Specific Improvements

1. **Use `DetailPageShell maxWidth="xl"` for wider split-pane.** The current layout renders inside a constrained tab content area. With a dedicated page and `max-w-6xl`, the 2/3 + 1/3 split gives ~725px for results and ~363px for diagnostics -- adequate for both
2. **Show latency inline with results, not as a separate section.** After query execution, display `text-xs text-muted` latency and token count inline next to the result count (e.g., "5 results in 234ms, 1,234 tokens")
3. **Use `pipelineStageIntent()` for resolution chain stage colors.** Currently the resolution chain may use hardcoded colors per stage type. Use the centralized stage intent mapping from design tokens

#### 10. What NOT to Do

- Do NOT open diagnostics in a modal -- use the inline split-pane layout or `SlidePanel nonBlocking`
- Do NOT hardcode stage colors in the resolution chain -- use `pipelineStageIntent()`
- Do NOT use `bg-blue-*` for the query input focus state -- use `focus:border-border-focus focus:ring-1 focus:ring-border-focus` (already in the `Input` component)
- Do NOT create a custom query history table -- use `DataTable`

---

### Page 9: Settings

**Purpose**: General (name, desc), Index info (read-only), API & SDK,
Model usage summary (read-only), Danger zone.

#### 1. Shell

**Use `DetailPageShell`** with `maxWidth="md"` (max-w-4xl).

Rationale: Settings pages are form-heavy with single-column content. A narrower
max-width (max-w-4xl = 896px) keeps form fields at readable widths and prevents
labels from being too far from inputs. This matches settings page patterns across
the Studio app.

#### 2. Density

**Comfortable** (`.page-comfortable`). Settings pages need generous spacing
between sections and form fields for clarity.

#### 3. Layout

```
+------------------------------------------------------------------+
| DetailPageShell maxWidth="md"                                     |
|   title: "Settings"                                               |
+------------------------------------------------------------------+
|                                                                    |
|  Section: "General"                                               |
|  +--------------------------------------------------------------+ |
|  | Input: Name                                                   | |
|  | Textarea: Description                                        | |
|  | [Save Changes] (shown only when dirty)                       | |
|  +--------------------------------------------------------------+ |
|                                                                    |
|  Section: "Index Configuration" (read-only)                      |
|  +--------------------------------------------------------------+ |
|  | Label: Index ID         Value: idx_abc123                     | |
|  | Label: Created          Value: 2026-04-15                     | |
|  | Label: Embedding Model  Value: BGE-M3 (1024d)                | |
|  | Label: Document Count   Value: 1,234                         | |
|  +--------------------------------------------------------------+ |
|                                                                    |
|  Section: "API & SDK"                                             |
|  +--------------------------------------------------------------+ |
|  | Label: KB Tool Name     Value: search_kb_my_kb  [Copy]       | |
|  | Label: API Endpoint     Value: /api/search/...  [Copy]       | |
|  | Code snippet (read-only)                                      | |
|  +--------------------------------------------------------------+ |
|                                                                    |
|  Section: "Model Usage" (read-only, AI)                          |
|  +--------------------------------------------------------------+ |
|  | border-l-2 border-purple                                      | |
|  | Summary of models used across pipeline, KG, query             | |
|  | MetricCard grid: Embeddings, Query, KG Extraction             | |
|  +--------------------------------------------------------------+ |
|                                                                    |
|  Section: "Danger Zone"                                           |
|  +--------------------------------------------------------------+ |
|  | bg-error-subtle/30 border border-error/20 rounded-lg         | |
|  | [Rebuild Index]  [Delete Knowledge Base]                      | |
|  +--------------------------------------------------------------+ |
|                                                                    |
+------------------------------------------------------------------+
```

#### 4. Component Reuse

- `DetailPageShell` -- page wrapper with `maxWidth="md"`
- `Section` -- for General, Index Config, API & SDK, Model Usage, Danger Zone
- `SectionGroup` -- wrapping all sections with `spacing="lg"` for 32px gaps
- `Input` -- name input
- `Textarea` -- description input
- `Button` -- Save Changes, Rebuild Index, Delete KB
- `Badge` -- status indicators in index config
- `MetricCard` -- model usage summary cards
- `ConfirmDialog` -- delete and rebuild confirmations (with `variant="danger"`)
- `Tooltip` -- hover explanations for read-only fields
- `InfoCard` -- "Danger Zone" warning banner (variant `error`)

#### 5. Typography

- Page title: `text-xl font-semibold`
- Section titles: via `Section` component (`text-sm font-semibold text-foreground`)
- Form labels: `text-sm font-medium text-foreground` (via `Input` label prop)
- Read-only labels: `SECTION_LABEL_CLASS` (`text-xs font-medium uppercase tracking-wider text-muted`)
- Read-only values: `text-sm text-foreground`
- Code snippets: `font-mono text-xs text-foreground bg-background-muted rounded-lg p-3`
- Danger zone text: `text-sm text-error`

#### 6. Status Indicators

- Index status: `Badge` with `variant` from `statusIntent()`, `dot={true}`
- Model connection status: `Badge variant="success" dot={true}` for connected models
- Save state: `Button` shows loading spinner via `loading` prop during save

#### 7. AI Model Sections

Model usage summary (read-only):

- `Section` wrapped in `<div className="border-l-2 border-purple">`
- `Badge variant="purple"` header
- Grid of `MetricCard` components showing usage per model type (Embeddings, Query LLM, KG Extraction)
- Read-only -- no configuration here, just a summary. Links to individual config pages via the sidebar

#### 8. Loading / Error / Empty

- **Loading**: `SkeletonFormSection` with `sections={5}` (one per settings section)
- **Error**: `ErrorBoundary` wrapping all sections
- **Empty**: N/A -- settings always exist for a created KB

#### 9. Specific Improvements

1. **Migrate from `SlidePanel` to dedicated page.** Settings is currently rendered in a `SlidePanel` (`SettingsPanel.tsx`). In the new sidebar structure, it becomes a full page using `DetailPageShell maxWidth="md"`. This provides more room for the danger zone, model usage summary, and API documentation
2. **Use `SectionGroup spacing="lg"` for consistent section gaps.** Currently the `SettingsPanel` uses `space-y-8` with manual `<div className="border-t border-default" />` dividers. `SectionGroup` with `spacing="lg"` provides 24px gaps, and the `Section` component's border provides visual separation without manual dividers
3. **Style Danger Zone with `Section` variant.** Use `<Section variant="flat">` with additional `className="border border-error/20"` for the danger zone to distinguish it from normal sections while staying within the component system
4. **Add read-only field display pattern.** For Index Configuration read-only fields, use a consistent label-value layout: `<div className="flex justify-between py-2 border-b border-default/50"><span className={SECTION_LABEL_CLASS}>{label}</span><span className="text-sm text-foreground font-mono">{value}</span></div>`

#### 10. What NOT to Do

- Do NOT use `bg-red-50` for the danger zone -- use `bg-error-subtle` (or `bg-error-subtle/30` for a subtler wash)
- Do NOT use `max-w-5xl` or wider for settings -- `max-w-4xl` prevents form fields from becoming unreasonably wide
- Do NOT add full model configuration on this page -- model config belongs on the individual feature pages (Pipeline, Fields, KG, Search). Settings shows a read-only summary only
- Do NOT create custom divider elements between sections -- `Section` component borders and `SectionGroup` spacing handle this

---

## 3. Component Reuse Inventory

Summary of which existing components are used across the 9 pages:

| Component           | Pages Used On                                                        | Notes                       |
| ------------------- | -------------------------------------------------------------------- | --------------------------- |
| `DetailPageShell`   | Overview, Pipeline, Fields, KG, Search & Test, Settings              | Most pages are detail pages |
| `ListPageShell`     | Sources, Documents, Vocabulary                                       | List/table pages            |
| `PageHeader`        | All (via shells)                                                     | Title + actions             |
| `Section`           | Overview, Pipeline, Fields, KG, Search & Test, Settings              | Content grouping            |
| `SectionGroup`      | Settings                                                             | Section stacking            |
| `MetricCard`        | Overview, KG (stats), Settings (model usage)                         | Stats display               |
| `Badge`             | All 9 pages                                                          | Status, counts, AI labels   |
| `Card`              | Overview, Sources, Search & Test                                     | Clickable content cards     |
| `DataTable`         | Sources, Documents, Fields, Vocabulary, KG (stats), Search (history) | Tabular data                |
| `ActivityTimeline`  | Overview                                                             | Activity feed               |
| `EmptyState`        | All 9 pages                                                          | Zero states                 |
| `ErrorBoundary`     | All 9 pages                                                          | Error wrapping              |
| `Skeleton` variants | All 9 pages                                                          | Loading states              |
| `Tabs`              | Fields                                                               | Sub-tab navigation          |
| `SegmentedControl`  | Sources, Fields, KG                                                  | View toggles                |
| `FilterSelect`      | Sources, Documents, Vocabulary                                       | Filter toolbars             |
| `Toggle`            | Pipeline, Fields, KG, Vocabulary                                     | On/off switches             |
| `Button`            | All 9 pages                                                          | Actions                     |
| `Input`             | Documents, Fields, Vocabulary, Settings, Search                      | Text inputs                 |
| `Select`            | Fields                                                               | Type selection              |
| `Dialog`            | Fields, Vocabulary                                                   | Forms                       |
| `ConfirmDialog`     | Sources, Documents, Fields, Vocabulary, Settings                     | Destructive actions         |
| `SlidePanel`        | KG (node detail)                                                     | Detail panels               |
| `Pagination`        | Sources, Documents, Vocabulary                                       | Page controls               |
| `InfoCard`          | Overview, Pipeline, Search & Test                                    | Contextual banners          |
| `Progress`          | Pipeline (migration)                                                 | Progress bars               |
| `Tooltip`           | Documents, Settings                                                  | Hover explanations          |
| `DropdownMenu`      | Sources, Vocabulary                                                  | Per-row actions             |

**Components NOT needed** (do not create):

- No custom stat/metric card -- use `MetricCard`
- No custom toggle -- use `Toggle`
- No custom empty state -- use `EmptyState`
- No custom skeleton -- use existing `Skeleton` variants
- No custom filter -- use `FilterSelect`
- No custom select -- use `Select` or `FilterSelect`

---

## 4. Cross-Cutting Improvements

### 4.1 Status Badge Consistency

**Current state**: Each page maps statuses to badge variants independently (e.g.,
`KBHeader` has its own `statusVariant` map, `OperationsDashboard` interprets
statuses inline).

**Recommendation**: Use `statusIntent()` from `@agent-platform/design-tokens`
everywhere. The centralized map already handles all KB-relevant statuses
(active -> success, creating/indexing -> info, error -> error, etc.). This
eliminates duplicate status-to-color logic across components.

### 4.2 AI Section Visual Pattern

**Current state**: AI model configuration sections are scattered across pages
with inconsistent styling -- some use purple badges, some use custom card
wrappers, some have no visual distinction.

**Recommendation**: Standardize on one pattern for all AI config sections:

```tsx
<div className="border-l-2 border-purple">
  <Section title="Section Name" icon={<Box className="w-4 h-4" />}>
    <Badge variant="purple" className="mb-3">
      AI-Powered
    </Badge>
    {/* Section content */}
  </Section>
</div>
```

This uses:

- `border-l-2 border-purple`: subtle left accent (not a full purple background)
- `Badge variant="purple"`: label indicating AI involvement
- Standard `Section` component for consistent card styling

### 4.3 Section Headers

**Current state**: `OperationsDashboard` uses emoji in section headers. Other pages
use inconsistent patterns for section labels.

**Recommendation**: All section headers outside `Section` component cards should use
`SECTION_LABEL_CLASS` from `lib/typography.ts`:

```
text-xs font-medium uppercase tracking-wider text-muted
```

No emojis. No custom sizes. Section titles inside `Section` cards use the
component's built-in `text-sm font-semibold text-foreground` pattern.

### 4.4 Interactive Text Links

**Current state**: Various patterns for text links: `text-primary hover:underline`,
`text-accent hover:underline`, bare `text-muted hover:text-foreground`.

**Recommendation**: Standardize on two patterns:

- **Inline navigation links**: `text-accent hover:text-accent/80 transition-default`
- **Action links**: Use `Button variant="ghost" size="sm"` instead of bare text

`text-primary` is not a design system token. Do not use it.

### 4.5 Loading State Architecture

**Current state**: Some pages have loading skeletons, some show spinners, some
show nothing during initial load.

**Recommendation**: Every page must follow this pattern:

```tsx
<ErrorBoundary>
  {isLoading ? (
    <PageSpecificSkeleton />   // Matches page layout structure
  ) : error ? (
    <ErrorFallback onRetry={refetch} />
  ) : data.length === 0 ? (
    <EmptyState ... />
  ) : (
    <PageContent />
  )}
</ErrorBoundary>
```

Use the existing skeleton components:

- `SkeletonTable` for table pages
- `SkeletonCard` for card-based pages
- `SkeletonFormSection` for settings/form pages
- `SkeletonGraph` for canvas pages

### 4.6 Elevation Consistency

**Current state**: Various elevation levels used inconsistently. Some cards use
`bg-background-elevated`, others use `bg-surface` (non-standard).

**Recommendation**: Standardize on the 4-level elevation system:

| Level        | Token                    | Use                                                   |
| ------------ | ------------------------ | ----------------------------------------------------- |
| 0 (page)     | `bg-background`          | Page background                                       |
| 1 (subtle)   | `bg-background-subtle`   | Input backgrounds, hover states                       |
| 2 (muted)    | `bg-background-muted`    | Inactive toggles, skeleton fills, section backgrounds |
| 3 (elevated) | `bg-background-elevated` | Cards, panels, modals, dropdowns                      |

Do NOT use `bg-surface` or `bg-surface-secondary` -- these are not standard tokens.

---

## 5. Priority Matrix

### P0 -- Must Do for Migration

These are blocking issues that must be resolved before pages can function
correctly in the new sidebar layout.

| ID   | Page                   | Issue                                               | Resolution                                                                                           |
| ---- | ---------------------- | --------------------------------------------------- | ---------------------------------------------------------------------------------------------------- |
| P0-1 | All                    | Each page needs a layout shell assignment           | Use `DetailPageShell` or `ListPageShell` as specified in each page audit                             |
| P0-2 | All                    | Loading/Error/Empty states must exist on every page | Implement the three-state pattern with existing `Skeleton`, `ErrorBoundary`, `EmptyState` components |
| P0-3 | Settings               | Settings currently in `SlidePanel`, needs full page | Migrate to `DetailPageShell maxWidth="md"` with all sections                                         |
| P0-4 | Sources, Documents     | Currently rendered as sub-views of `DataSection`    | Extract into independent pages with their own `ListPageShell` wrappers                               |
| P0-5 | Fields, Vocabulary, KG | Currently sub-sections of `IntelligenceSection`     | Extract into independent pages with their own shell wrappers                                         |
| P0-6 | Overview               | Currently `HomeSection` with 3-state machine        | Refactor to be the main Overview page with `DetailPageShell maxWidth="lg"`                           |

### P1 -- Should Do for Quality

These improvements significantly improve design system compliance and visual
consistency.

| ID    | Page               | Issue                                        | Resolution                                                                   |
| ----- | ------------------ | -------------------------------------------- | ---------------------------------------------------------------------------- |
| P1-1  | Overview           | Emoji in section headers                     | Remove emojis, use `SECTION_LABEL_CLASS`                                     |
| P1-2  | Overview           | Custom `StatCard` duplicates `MetricCard`    | Replace with `MetricCard` component                                          |
| P1-3  | Fields             | Non-standard `bg-surface` tokens             | Replace with `bg-background-elevated` and `bg-background-muted`              |
| P1-4  | Fields             | Custom pill toggle for By Field/By Connector | Replace with `SegmentedControl size="sm"`                                    |
| P1-5  | All                | Inconsistent status badge mapping            | Use `statusIntent()` from design tokens everywhere                           |
| P1-6  | All AI sections    | Inconsistent AI section styling              | Standardize on `border-l-2 border-purple` + `Badge variant="purple"` pattern |
| P1-7  | Sources, Documents | `text-primary` usage for links               | Replace with `text-accent` or `Button variant="ghost"`                       |
| P1-8  | Documents          | No sticky table header                       | Add `sticky top-0` to DataTable thead                                        |
| P1-9  | Documents          | Numeric columns left-aligned                 | Right-align chunk count and file size columns                                |
| P1-10 | Sources            | View auto-switch overrides user preference   | Let localStorage preference always win                                       |

### P2 -- Nice to Have

These are polish improvements that enhance the experience but are not
blocking.

| ID    | Page          | Issue                                           | Resolution                                                                      |
| ----- | ------------- | ----------------------------------------------- | ------------------------------------------------------------------------------- |
| P2-1  | Overview      | Sources in vertical stack                       | Switch to `grid-cols-2` for source cards                                        |
| P2-2  | Sources       | No card hover CTA                               | Add arrow icon that appears on card hover                                       |
| P2-3  | All tables    | No outlined badge variant in dense rows         | Use `Badge appearance="outlined"` for table row status                          |
| P2-4  | Pipeline      | Custom expand/collapse in EmbeddingModelSection | Use `Section collapsible={true}`                                                |
| P2-5  | KG            | Graph node entrance animation                   | Use `springs.soft` from `animation.ts`                                          |
| P2-6  | Search & Test | Latency shown separately from results           | Display inline after result count                                               |
| P2-7  | Settings      | Manual dividers between sections                | Use `SectionGroup spacing="lg"`                                                 |
| P2-8  | Vocabulary    | Custom search/filter UI                         | Migrate to `ListPageShell` built-in search                                      |
| P2-9  | KG            | Node detail in modal                            | Switch to `SlidePanel nonBlocking`                                              |
| P2-10 | All           | Inconsistent focus ring styles                  | Audit and standardize on `focus-visible:ring-2 focus-visible:ring-border-focus` |

---

## Appendix: Quick Reference Card

For developers implementing these pages, here is the complete decision tree:

```
Is the page a list of homogeneous items with search/filter/pagination?
  YES -> ListPageShell (Sources, Documents, Vocabulary)
  NO  -> DetailPageShell
           Is it a canvas/editor?
             YES -> maxWidth="full" (Pipeline canvas, KG graph)
             NO  -> Is it a settings/form page?
                      YES -> maxWidth="md" (Settings)
                      NO  -> Is it a split-pane page?
                               YES -> maxWidth="xl" (Search & Test)
                               NO  -> maxWidth="lg" (Overview, Fields)

Does the section contain AI/LLM configuration?
  YES -> Wrap in <div className="border-l-2 border-purple">
         Add <Badge variant="purple">AI-Powered</Badge>
  NO  -> Standard Section styling

What badge appearance to use?
  Card view / hero context  -> appearance="subtle" (default)
  Table row / dense list    -> appearance="outlined"
  Status with activity      -> dot={true}, pulse={true} for in-progress

How to map status to badge variant?
  Import { statusIntent } from '@agent-platform/design-tokens'
  <Badge variant={statusIntent(status) as BadgeVariant}>
```

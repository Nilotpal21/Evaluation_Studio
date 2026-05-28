# Design System Standardization

**Date:** 2026-03-06
**Branch:** feature/frontend-arch-improvements
**Ticket:** ABLP-42

## Goal

Standardize the ABL Platform frontend (Studio + Admin) into a polished, symmetrical design system. Keep the existing violet theme identity, incrementally adopt shadcn/ui primitives, and enforce Supabase-inspired layout consistency (page shells, spacing, navigation labels) across every page. Add Playwright visual regression tests as a safety net.

## Decisions

| Decision           | Choice                           | Rationale                                                      |
| ------------------ | -------------------------------- | -------------------------------------------------------------- |
| Color theme        | Keep violet accent (252 56% 60%) | Distinctive brand identity, already well-implemented           |
| Layout patterns    | Supabase-inspired page shells    | Consistent search/filter/action bar placement across all pages |
| shadcn/ui strategy | Incremental adoption (Option B)  | Keep working custom components, add missing primitives         |
| Sidebar            | Polish current drill-down        | Add section labels, standardize item height/active state       |
| Spacing            | Adaptive density                 | Comfortable for forms/dashboards, compact for tables/lists     |
| Playwright         | Visual regression baseline       | Screenshot every page before/after changes                     |

## Section 1: Design System Foundation

### shadcn/ui Integration

Install shadcn/ui with `components.json` mapped to our existing CSS variable system:

- Map `--primary` to `--accent`, `--secondary` to `--background-muted`, `--muted` to `--foreground-muted`
- New shadcn components to add: Form, Sheet, Accordion, Combobox, Command, Popover, Separator, ScrollArea
- Keep custom: Button, Sidebar, PageHeader, Dialog, Tabs, Badge, DataTable, EmptyState

### Typography Standardization

| Element       | Style                                                     |
| ------------- | --------------------------------------------------------- |
| Page title    | `text-2xl font-semibold tracking-tight` (24px)            |
| Section title | `text-lg font-medium` (18px)                              |
| Body          | `text-sm` (14px)                                          |
| Meta/labels   | `text-xs font-medium text-muted uppercase tracking-wider` |
| Monospace     | `text-xs font-mono`                                       |

### Adaptive Spacing Tokens

| Context                                   | Page padding | Card padding | Item gap | Section gap |
| ----------------------------------------- | ------------ | ------------ | -------- | ----------- |
| Comfortable (forms, settings, dashboards) | 24px         | 16px         | 12px     | 24px        |
| Compact (tables, lists, agent editor)     | 16px         | 12px         | 8px      | 16px        |

Both use the existing 4px grid. Applied via utility classes: `page-comfortable` / `page-compact`.

## Section 2: Standard Page Shells

Two layout wrappers that every page uses. No page renders its own header/search/pagination.

### ListPageShell (agents, sessions, tools, workflows, knowledge bases, connections, deployments)

```
PageHeader (title left, primary action right)
Description text
--- border ---
Search | Filters | Sort | View toggle
--- content ---
Table / Card grid
--- footer ---
Pagination (sticky)
```

- Compact spacing (16px page padding)
- Search always leftmost, view toggle rightmost
- Empty state centered when no results

### DetailPageShell (overview, dashboard, settings, agent detail)

```
Back button | Title | Search (optional) | Actions
Tab bar (when applicable, no gap below header)
--- content ---
Forms / Cards / Panels
```

- Comfortable spacing (24px page padding)
- Back button when navigating from a list
- Search only when relevant

### Component API

```tsx
<ListPageShell
  title="Agents"
  description="Manage your AI agents"
  primaryAction={{ label: "New Agent", onClick: ... }}
  searchPlaceholder="Search agents..."
  filters={[...]}
  pagination={...}
>
  {children}
</ListPageShell>

<DetailPageShell
  title="Customer Support Agent"
  backTo={{ label: "Agents", onClick: ... }}
  tabs={[...]}
  actions={[...]}
>
  {children}
</DetailPageShell>
```

## Section 3: Sidebar Polish

Keep current drill-down architecture. Polish spacing and visual hierarchy.

### Changes

- Add section labels: BUILD, RESOURCES, MORE using `text-xs font-medium uppercase tracking-wider text-subtle` with `px-2 pt-4 pb-1`
- Standardize nav item height to 34px (py-[6px] + text-sm + icon)
- Active state: keep `bg-accent-subtle text-accent`, add 2px left border accent indicator
- Collapsed state: center icons, tooltip on hover
- Project switcher: add search input when >5 projects
- AdminSidebar: match ProjectSidebar width (240px), add matching section labels (TEAM, AI CONFIGURATION, ACCOUNT)

### No structural changes

Drill-down navigation, slide animations, and collapse behavior stay as-is.

## Section 4: Agent Editor / Agent Settings Fix

### Bug fixes

- `AgentModelTab.tsx` ~line 449: Responses API disabled state — add missing `pointer-events-none`
- `AgentModelTab.tsx` ~line 503: Streaming disabled state — add missing `pointer-events-none`

### Layout standardization

- Wrap agent editor in `DetailPageShell` with back-to-agents navigation
- Add section group labels to AgentEditorMenu: IDENTITY, BEHAVIOR, FLOW, LIFECYCLE
- Match sidebar item height (34px) and active state (accent-subtle + left border)
- Section content: comfortable spacing (24px padding), 16px gap between form fields
- Standardize all section editors with shadcn Form for consistent label/input/error/help-text pattern

### Form field pattern

```
Label Name              <- text-sm font-medium text-foreground
[Input field         ]  <- full width, 36px height (md), 32px (sm)
Help text               <- text-xs text-subtle, 4px top margin
                        <- 16px gap to next field
```

## Section 5: Playwright Visual Regression

### Structure

```
apps/studio/e2e/visual-regression/
  visual-baseline.spec.ts
  screenshots/
    baseline/{dark,light}/    <- committed to git
    current/{dark,light}/     <- gitignored
```

### Coverage (22 pages)

- Projects: Dashboard
- Build: Overview, Agent list, Agent detail, Agent editor (identity), Workflows list
- Resources: Tools list, Tool detail, Knowledge bases, Connections
- Operate: Sessions list, Session detail, Deployments, Alerts
- Insights: Dashboard
- Govern: Guardrails, Governance
- Settings: Project settings, Agent model tab
- Admin: Members, Models, Billing

### Configuration

- Viewports: 1440x900 (desktop) + 375x812 (mobile)
- Themes: dark + light
- Tolerance: `maxDiffPixelRatio: 0.01`
- Run manually, not in CI initially
- Update baselines: `pnpm playwright test visual-regression --update-snapshots`

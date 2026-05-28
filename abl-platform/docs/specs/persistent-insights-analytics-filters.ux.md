# Persistent Insights & Analytics Filters -- UX Specification

**Date:** 2026-04-22
**Status:** Final Design
**Feature Spec:** [docs/features/sub-features/persistent-insights-analytics-filters.md](../features/sub-features/persistent-insights-analytics-filters.md)
**Approach:** Converged from three competing designs (Ghost Defaults, Badge-Annotated Reset, Unified Chip Strip) after persona simulation with 5 user archetypes.

---

## 1. Design Philosophy

Persistence is invisible. The product remembers analysis context per user, per project, per surface, and restores it silently through the controls themselves. There is no banner, no toast, no "Welcome back" message. The controls ARE the restored state.

The escape hatch scales with density:

- **Single-control surfaces** get zero new UI.
- **Executive multi-control surfaces** get a small ghost button with a count badge.
- **Operator-dense surfaces** get the same button PLUS a unified active-state strip that combines page-level and advanced filter chips into one dismissible row.

The guiding rule: the feature is invisible to users who never change filters, helpful to users who do, and never surprising.

---

## 2. Three Density Tiers

Every Insights and Analytics surface falls into exactly one density tier. The tier determines what UI (if any) is added for persistence.

| Tier                                | Surfaces                                                         | New UI Added                                                          | Reset Affordance                                           |
| ----------------------------------- | ---------------------------------------------------------------- | --------------------------------------------------------------------- | ---------------------------------------------------------- |
| **Tier 1: Single control**          | Billing & Usage, Customer Insights, Voice Analytics              | None                                                                  | None (FR-4: "Reset filters" only on multi-filter surfaces) |
| **Tier 2: Executive multi-control** | Dashboard / At a Glance, Agent Performance, Quality Monitor      | Reset button with count badge in PageHeader                           | Ghost button, appears only when non-default                |
| **Tier 3: Operator dense**          | Analytics Shell, Sessions Explorer, Traces Explorer, Generations | Reset button with count badge in toolbar + unified active-state strip | Button + individually dismissible chips                    |

---

## 3. Tier 1 -- Single Control Surfaces

### Billing & Usage

**Current control:** Date range segmented control (7d / 30d / 90d), passed to `BillingUsageReportPanel`.

**Change:** The `dateRange` state initializer reads from `preferences.byProject[projectId].billingUsage.dateRange`. If the saved value is missing or not one of `'7d' | '30d' | '90d'`, the default `'7d'` is used.

**Visual change:** None. The date range control renders with the restored value exactly as if the user had just selected it.

**Layout (unchanged):**

```
+----------------------------------------------------------+
| Billing & Usage                                          |
| Usage overview for [Project Name]                        |
|                                                          |
|   [ 7d ]  [ 30d ]  [ 90d ]    <-- silently restored     |
|                                                          |
|   (BillingUsageReportPanel -- unchanged)                 |
+----------------------------------------------------------+
```

### Customer Insights

**Current control:** Date range dropdown (7d / 30d / 90d) in PageHeader actions.

**Change:** `dateRange` initializer reads from preferences. Fallback to `'30d'`.

**Visual change:** None.

### Voice Analytics

**Current control:** Date range pill strip (24h / 7d / 30d).

**Change:** `dateRange` initializer reads from preferences. Fallback to `'7d'`.

**Visual change:** None.

### Screen Reader Behavior (Tier 1)

Unchanged from today. The date control announces its current value through its existing `aria-label` or visible label. No additional announcement for restoration.

---

## 4. Tier 2 -- Executive Multi-Control Surfaces

### The Reset Button Component

A ghost-variant button appears in the PageHeader actions area. It shows only when at least one persisted control differs from its surface default.

**Visual specification:**

```tsx
// ResetFiltersButton component
<button
  onClick={handleResetAll}
  aria-label={`Reset ${count} active ${count === 1 ? 'filter' : 'filters'} to defaults`}
  className={clsx(
    'inline-flex items-center gap-1.5',
    'px-2.5 py-1.5 rounded-lg',
    'text-xs font-medium text-muted',
    'border border-default',
    'hover:text-foreground hover:bg-background-muted',
    'transition-default',
    'focus-visible:ring-2 focus-visible:ring-border-focus focus-visible:ring-offset-1 outline-none',
  )}
>
  Reset filters
  <span className="px-1.5 py-0.5 rounded-full text-xs font-medium bg-accent-subtle text-accent">
    {count}
  </span>
</button>
```

**Visibility rule:** The button renders when `nonDefaultCount > 0`. When `nonDefaultCount === 0`, the button is absent (not disabled -- absent). It fades in with the `animate-fade-in` utility (200ms).

**Positioning:** In the PageHeader `actions` slot, to the LEFT of the date range control. This places the less-frequently-used action (reset) before the more-frequently-used action (date range) in left-to-right reading order.

---

### Dashboard / At a Glance

**Persisted controls:**

- `dateRange`: `'7d' | '30d' | '90d'` (default: `'30d'`)
- `activeTab`: `'overview' | 'trends' | 'roi' | 'conversations'` (default: `'overview'`)
- `conversationFilter`: `string` (default: `''`)

**Non-default count calculation:**

- `dateRange !== '30d'` contributes 1
- `activeTab !== 'overview'` contributes 1
- `conversationFilter !== ''` contributes 1
- Maximum count: 3

**Layout -- all controls at defaults (majority of visits):**

```
+------------------------------------------------------------------+
| At a Glance                                                      |
| Executive overview of your AI agent program     [Last 30 days v] |
+------------------------------------------------------------------+
| [Overview] [Trends] [ROI] [Conversations]                        |
+------------------------------------------------------------------+
| (KPI cards, charts, tables -- unchanged)                         |
+------------------------------------------------------------------+
```

No Reset button visible. Indistinguishable from today.

**Layout -- after restoring non-default state (e.g., 90d + ROI tab):**

```
+------------------------------------------------------------------+
| At a Glance                                                      |
| Executive overview of ...  [Reset filters 2] [Last 90 days v]   |
+------------------------------------------------------------------+
| [Overview] [Trends] [ROI] [Conversations]                        |
|                      ^^^-- restored active tab                   |
+------------------------------------------------------------------+
| (ROI tab content with 90d data)                                  |
+------------------------------------------------------------------+
```

**What "Reset filters" clears:**

- `dateRange` -> `'30d'`
- `activeTab` -> `'overview'`
- `conversationFilter` -> `''`

**What it does NOT clear:** ROI Cost Settings (those use a separate local-only store), pagination, expanded rows, selected conversations.

---

### Agent Performance

**Persisted controls:**

- `dateRange`: `'7d' | '30d' | '90d'` (default: `'7d'`)
- `compareEnabled`: `boolean` (default: `false`)
- `search`: `string` (default: `''`)
- `statusFilter`: `'all' | 'critical' | 'warning'` (default: `'all'`)

**Non-default count:** Up to 4.

**Layout with non-default state:**

```
+------------------------------------------------------------------+
| Agent Performance                                                |
| Monitor agent health ...   [Reset filters 3] [Last 30 days v]   |
+------------------------------------------------------------------+
| [Agent Health Banner]                                            |
+------------------------------------------------------------------+
| [Search: "billing"]  [Critical(2)] [Warning(5)] [All(24)]       |
|                       ^-- active pill restored                   |
+------------------------------------------------------------------+
| (Agent table)                                                    |
+------------------------------------------------------------------+
```

**Reset clears:** `dateRange` -> `'7d'`, `compareEnabled` -> `false`, `search` -> `''`, `statusFilter` -> `'all'`.

**Does NOT clear:** Table sort order, pagination, expanded agent rows.

---

### Quality Monitor

**Persisted controls:**

- `dateRange`: `'7d' | '30d' | '90d'` (default: `'30d'`)
- `dimensionFilter`: `string` (default: `'all'`)
- `scoreFilter`: `string` (default: `'all'`)

**Non-default count:** Up to 3.

**Layout with non-default state:**

```
+------------------------------------------------------------------+
| Quality Monitor                                                  |
| System-wide quality ...    [Reset filters 2] [Last 30 days v]   |
+------------------------------------------------------------------+
| [Quality Health Banner]                                          |
+------------------------------------------------------------------+
| [KPI Cards] [Trend Chart] [Dimension Cards]                     |
+------------------------------------------------------------------+
| Flagged Conversations                                            |
|   [Filter icon] [Hallucination v] [Critical v]                  |
|                  ^-- restored       ^-- restored                 |
+------------------------------------------------------------------+
```

**Important:** The Reset button is in the PageHeader but resets ALL persisted controls for the surface, including `dimensionFilter` and `scoreFilter` which live inside the FlaggedConversationsTable. The button's scope is the full surface, not just the header-level controls.

---

## 5. Tier 3 -- Operator Dense Surfaces

Tier 3 surfaces get the same Reset button (from Tier 2) PLUS a **Unified Active Filters Strip** that combines page-level non-default controls and advanced filter rows into a single dismissible-chip row.

### The Unified Active Filters Strip

**Why unify?** Sessions Explorer and Traces Explorer already have `FilterTags` -- a row of dismissible accent-colored pills for advanced filter rows. Adding a second row of page-level chips would be visually cluttered and confusing. Instead, we merge both into one strip with a visual separator.

**Strip anatomy:**

```
[page-level chips...] | [advanced filter chips...]          Clear all
^-- muted styling          ^-- accent styling (existing)
```

**Page-level chips (new):**

```tsx
<span
  className={clsx(
    'inline-flex items-center gap-1 pl-2 pr-1 py-0.5 rounded-full text-xs font-medium',
    'bg-background-muted text-foreground border border-default',
  )}
>
  <span className="text-muted">{label}:</span>
  <span>{value}</span>
  <button
    onClick={() => resetControl(controlKey)}
    aria-label={`Clear ${label} filter`}
    className="ml-0.5 p-0.5 rounded-full hover:bg-background-elevated transition-default"
  >
    <X className="w-3 h-3" />
  </button>
</span>
```

**Advanced filter chips (existing FilterTags style, unchanged):**

```tsx
<span className="inline-flex items-center gap-1 pl-2 pr-1 py-0.5 rounded-full text-xs font-medium bg-accent-subtle text-accent border border-accent/20">
  <span className="text-muted">{column}</span>
  <span>{operator}</span>
  <span className="text-foreground">{value}</span>
  <button
    onClick={() => removeFilterRow(id)}
    className="ml-0.5 p-0.5 rounded-full hover:bg-accent/20 transition-default"
  >
    <X className="w-3 h-3" />
  </button>
</span>
```

**Visual separator between groups:** A thin vertical line when both groups have chips:

```tsx
{
  hasPageChips && hasAdvancedChips && (
    <span className="border-r border-default h-4 mx-1.5 self-center" aria-hidden="true" />
  );
}
```

**"Clear all" link:** Appears at the end of the strip when the total chip count (page-level + advanced) is 2 or more. Clears ALL chips (page-level resets to defaults, advanced filter rows emptied).

```tsx
<button
  onClick={handleClearAll}
  aria-label="Clear all active filters"
  className="text-xs text-muted hover:text-error transition-default whitespace-nowrap"
>
  Clear all
</button>
```

**Strip container:**

```tsx
<div
  role="region"
  aria-label="Active filters"
  className="flex flex-wrap items-center gap-1.5 px-0 py-2"
>
  {pageChips}
  {separator}
  {advancedChips}
  {clearAllButton}
</div>
```

**Strip visibility:** The strip renders only when at least one chip exists (page-level OR advanced). When all controls are at defaults and no advanced filters exist, the strip is absent.

**Strip animation:** Enters with `animate-fade-in` (200ms). Individual chip removal uses no animation (instant removal for responsiveness).

---

### Analytics Shell

**Persisted controls:**

- `dateRangeMode`: `'quick' | 'custom'` (default: `'quick'`)
- `quickRange`: `DateRangeOption` (default: `'30m'`)
- `customFrom`: `string` (default: `''`)
- `customTo`: `string` (default: `''`)
- `activeTab`: `TabId` (default: `'overview'`)

**Non-default count:** Up to 3 practical (date mode + range + tab).

**Layout -- with non-default shell state:**

```
+------------------------------------------------------------------+
| Analytics                                                        |
| Real-time traces, sessions, and LLM performance                 |
|                                                                  |
| [30m][1h][3h][6h][12h][24h][2d][7d][30d][Custom]               |
|                                     ^^^-- restored selection     |
|                                          [Reset filters 2]      |
+------------------------------------------------------------------+
| [Overview] [LLM] [Sessions Explorer] [Traces Explorer] [Query]  |
|                   ^^^-- restored active tab                      |
+------------------------------------------------------------------+
```

**Reset button placement:** Below the pill strip, right-aligned, in the same horizontal zone as the pill strip. This keeps it within the header area without cluttering the pill strip itself.

**Reset semantics for the Analytics shell:**

**Recommendation: Reset clears ONLY the shell controls (date range + active tab). It does NOT clear any sub-tab explorer state.**

**Rationale:** The shell and each sub-tab have independent `surfaceKey`s in the preference schema (`analyticsPage` vs `analyticsSessions` vs `analyticsTraces` vs `analyticsGenerations`). An operations lead (Ravi) who carefully set up Sessions Explorer filters and then wants to reset the date range should not lose his session-level filters. Coupling shell reset with sub-tab reset would violate Objective 3 (per-surface independence) and create a destructive surprise.

**What shell Reset clears:** `dateRangeMode` -> `'quick'`, `quickRange` -> `'30m'`, `customFrom` -> `''`, `customTo` -> `''`, `activeTab` -> `'overview'`.

**What shell Reset does NOT clear:** Any sub-tab explorer state (sessions, traces, generations).

---

### Sessions Explorer

**Persisted controls:**

- `statusFilter`: `StatusFilter` (default: `'all'`)
- `search`: `string` (default: `''`)
- `channelFilter`: `string` (default: `''`)
- `environmentFilter`: `string` (default: `''`)
- `filters`: `FilterRow[]` (default: `[]`)

**Layout -- with non-default state:**

```
+------------------------------------------------------------------+
| [All][Active][Completed][Escalated][Failed][Ended]               |
|                          ^^^-- restored active pill              |
+------------------------------------------------------------------+
| [Search: "billing"]  [Channel: Slack v] [Env: prod v]          |
|                [Reset filters 5]  [Filters]  [Cols]  [CSV]     |
+------------------------------------------------------------------+
| Status: Failed [x]  Search: "billing" [x]  Channel: Slack [x]  |
| Env: prod [x] | Agent contains "router" [x]  Cost > 0.5 [x]   |
|                                                   Clear all     |
+------------------------------------------------------------------+
| (Sessions table with filtered data)                              |
+------------------------------------------------------------------+
```

**Key layout decisions:**

1. **Reset button position:** In the toolbar row, to the LEFT of the Filters button. Both are in the same row but serve different purposes:
   - **Reset filters (5):** Clears ALL non-default state for this surface (status + search + channel + env + advanced filters).
   - **Filters:** Opens the AdvancedFilterPanel slideout to manage advanced filter rows.

2. **Filters button change:** The Filters button RETAINS its existing count badge showing advanced filter row count. This is consistent with its current behavior and visually distinct from the Reset button.

3. **Visual distinction between the two buttons:**
   - Reset: `border-default text-muted` with `bg-accent-subtle text-accent` count badge.
   - Filters (when active): `border-accent text-accent bg-accent-subtle` (existing styling).
   - Filters (when inactive): `border-default text-muted` (existing styling).

4. **Unified strip below toolbar:** Page-level chips (muted styling) + separator + advanced filter chips (accent styling). This replaces the existing standalone `FilterTags` component on this surface.

**Count calculation:**

- `statusFilter !== 'all'` -> +1
- `search !== ''` -> +1
- `channelFilter !== ''` -> +1
- `environmentFilter !== ''` -> +1
- Each active advanced filter row -> +1
- Example: status=failed + search="billing" + channel=slack + 2 advanced filters = count 5

**Individual chip dismiss:**

- Dismissing "Status: Failed" resets `statusFilter` to `'all'` and persists.
- Dismissing "Search: billing" clears `search` to `''` and persists.
- Dismissing an advanced filter chip removes that `FilterRow` from the `filters` array and persists.
- After each dismiss, the Reset count updates, and if all controls return to defaults, both the Reset button and the strip disappear.

---

### Traces Explorer

**Persisted controls:**

- `activeSubTab`: `'traces' | 'generations'` (default: `'traces'`)
- `typeFilter`: `TraceTypeFilter` (default: `'all'`)
- `searchQuery`: `string` (default: `''`)
- `filterRows`: `FilterRow[]` (default: `[]`)

**Layout with non-default state (Traces sub-tab active):**

```
+------------------------------------------------------------------+
| [Traces] [Generations]                                           |
+------------------------------------------------------------------+
| [All][LLM][Tool][Decision][Handoff][Error][Agent]               |
|      ^^^-- restored type filter                                  |
+------------------------------------------------------------------+
| [Search: "gpt"]    [Reset filters 3]  [Filters]  [Cols]        |
+------------------------------------------------------------------+
| Type: LLM Call [x]  Search: "gpt" [x] | Latency > 500ms [x]   |
|                                                    Clear all    |
+------------------------------------------------------------------+
| (Traces content)                                                 |
+------------------------------------------------------------------+
```

**Reset scope:** Clears only the currently active sub-tab's state. When viewing Traces, Reset clears `typeFilter`, `searchQuery`, `filterRows`. When viewing Generations, Reset clears Generations' `searchQuery` and `filterRows`.

**Sub-tab switch behavior:** When switching from Traces to Generations sub-tab, the Reset button count re-evaluates against Generations' defaults and state. The strip re-renders with Generations' chips. This is seamless -- same surface location, different content.

**Does `activeSubTab` contribute to the Reset count?** No. The sub-tab selector (`[Traces] [Generations]`) is a navigation element, and its restored state is handled by the shell persistence (Traces Explorer IS the `analyticsTraces` surfaceKey). The sub-tab selection within Traces Explorer is part of that surface's state, but resetting it would mean navigating away from the current view, which is disorienting. The user switches sub-tabs manually.

---

### Generations

**Persisted controls:**

- `searchQuery`: `string` (default: `''`)
- `filterRows`: `FilterRow[]` (default: `[]`)

**Layout with non-default state:**

```
+------------------------------------------------------------------+
| [Traces] [Generations]                                           |
+------------------------------------------------------------------+
| [Search: "gpt-4"]  [Reset filters 2]  [Filters]  [Cols]       |
+------------------------------------------------------------------+
| Search: "gpt-4" [x] | Model contains "gpt-4" [x]   Clear all  |
+------------------------------------------------------------------+
| (Generations table)                                              |
+------------------------------------------------------------------+
```

---

## 6. Chip Label Reference -- All Surfaces

This table specifies the exact label text for every possible chip across all surfaces.

| Surface         | Control Key        | Chip Label  | Display Value                                                         | Hidden When (at default)          |
| --------------- | ------------------ | ----------- | --------------------------------------------------------------------- | --------------------------------- |
| Dashboard       | dateRange          | Date        | "Last 7 days" / "Last 30 days" / "Last 90 days"                       | `=== '30d'`                       |
| Dashboard       | activeTab          | Tab         | "Trends" / "ROI" / "Conversations"                                    | `=== 'overview'`                  |
| Dashboard       | conversationFilter | Filter      | "Flagged" / "Low Quality (<3.0)" / "High Quality (>4.0)"              | `=== ''`                          |
| Agent Perf      | dateRange          | Date        | Same as Dashboard                                                     | `=== '7d'`                        |
| Agent Perf      | compareEnabled     | Compare     | "Enabled"                                                             | `=== false`                       |
| Agent Perf      | search             | Search      | `"{value}"` (truncated to 20 chars with ellipsis)                     | `=== ''`                          |
| Agent Perf      | statusFilter       | Status      | "Critical" / "Warning"                                                | `=== 'all'`                       |
| Quality         | dateRange          | Date        | Same as Dashboard                                                     | `=== '30d'`                       |
| Quality         | dimensionFilter    | Dimension   | Formatted dimension name (e.g., "Hallucination Detection")            | `=== 'all'`                       |
| Quality         | scoreFilter        | Score       | "Critical (<0.5)" / "Warning (0.5-0.7)" / "Healthy (>0.7)"            | `=== 'all'`                       |
| Analytics Shell | dateRange          | Date        | "30m" / "1h" / ... / "Custom (Apr 1 - Apr 15)"                        | `mode==='quick' && range==='30m'` |
| Analytics Shell | activeTab          | Tab         | "LLM" / "Sessions Explorer" / "Traces Explorer" / "Query"             | `=== 'overview'`                  |
| Sessions        | statusFilter       | Status      | "Active" / "Completed" / "Escalated" / "Failed" / "Ended"             | `=== 'all'`                       |
| Sessions        | search             | Search      | `"{value}"` (truncated 20 chars)                                      | `=== ''`                          |
| Sessions        | channelFilter      | Channel     | Channel name                                                          | `=== ''`                          |
| Sessions        | environmentFilter  | Environment | Environment name                                                      | `=== ''`                          |
| Traces          | typeFilter         | Type        | "LLM Call" / "Tool Call" / "Decision" / "Handoff" / "Error" / "Agent" | `=== 'all'`                       |
| Traces          | searchQuery        | Search      | `"{value}"`                                                           | `=== ''`                          |
| Generations     | searchQuery        | Search      | `"{value}"`                                                           | `=== ''`                          |

**Note:** Tier 2 surfaces (Dashboard, Agent Performance, Quality Monitor) show chips ONLY in the Reset button's count badge, not as visible chip pills. The chip strip appears only on Tier 3 surfaces. This is deliberate: Tier 2 keeps the calm executive layout.

---

## 7. Reset Semantics -- Complete Specification

### Scope Per Surface

| Surface           | Surface Key            | What "Reset" / "Clear all" Clears                                 | What Is NOT Cleared                                                                            |
| ----------------- | ---------------------- | ----------------------------------------------------------------- | ---------------------------------------------------------------------------------------------- |
| Dashboard         | `atAGlance`            | dateRange, activeTab, conversationFilter                          | ROI Cost Settings (local-only), pagination, selected conversations                             |
| Analytics Shell   | `analyticsPage`        | dateRangeMode, quickRange, customFrom, customTo, activeTab        | Sub-tab explorer state (sessions, traces, generations)                                         |
| Sessions Explorer | `analyticsSessions`    | statusFilter, search, channelFilter, environmentFilter, filters[] | Column config (separate persistence), sort order, expanded rows, pagination, selected sessions |
| Traces Explorer   | `analyticsTraces`      | activeSubTab, typeFilter, searchQuery, filterRows[]               | selectedSessionId, detailView (timeline/waterfall), column config                              |
| Generations       | `analyticsGenerations` | searchQuery, filterRows[]                                         | Column config                                                                                  |
| Agent Performance | `agentPerformance`     | dateRange, compareEnabled, search, statusFilter                   | Sort order, pagination, show-all toggle                                                        |
| Quality Monitor   | `qualityMonitor`       | dateRange, dimensionFilter, scoreFilter                           | Expanded dimension cards, flagged conversations pagination                                     |

### Individual Chip Dismiss (Tier 3 Only)

Dismissing a single chip resets ONLY that control to its default. All other controls remain unchanged. The preference is persisted with the single change.

Example: On Sessions Explorer with statusFilter=failed, search="billing", channelFilter="slack":

- Dismiss "Channel: Slack" -> channelFilter resets to `''`, search and statusFilter remain, count decreases by 1.
- If count reaches 0, both the Reset button and the strip disappear.

### Explicitly NOT Persisted (per FR-15)

These states are always ephemeral and never appear in the preference payload:

- Pagination (page number, page size)
- Expanded rows / cards
- Selected sessions / selected traces
- Open drawers / dialogs
- Column customizer state (separate existing persistence)
- Sort order / sort direction
- ROI Cost Settings (separate local-only store)
- Query SQL editor text
- Detail view mode (timeline vs waterfall in Traces)
- Filter panel open/closed state
- Column panel open/closed state

---

## 8. Project-Switch Transition

### Mechanism

When the user selects a different project in the project picker:

1. The navigation store updates `projectId`.
2. Every mounted Insights/Analytics component re-runs its `usePersistedSurfaceFilters(surfaceKey)` hook.
3. The hook synchronously reads the local Zustand persist store for `insightsAnalyticsFilters.byProject[newProjectId][surfaceKey]`.
4. If a cached entry exists: control state is set from it.
5. If no cached entry exists: controls initialize to surface defaults.
6. Data-fetching hooks receive the new filter values and begin loading data for the new project.

### Visual Behavior

**No default-then-restored flash.** The preference store uses Zustand persist with localStorage, which is synchronous. The hook reads the cached value in the same synchronous render cycle that processes the projectId change. Controls render with the correct (restored or default) values on first paint of the new project context.

**Data loading is normal.** Charts and tables show their existing loading skeletons while data fetches for the new project complete. This is identical to today's project-switch behavior. The only difference is the filter controls are pre-filled with remembered values instead of defaults.

**No special transition animation.** The project switch already causes a re-render. Adding a transition animation for filter restoration would draw attention to something that should be invisible.

### Screen Reader Behavior on Project Switch

The project picker already announces the selected project name (e.g., "Project Beta selected"). No additional announcement is needed for filter restoration. The restored filter values are discoverable through normal tab-through of controls, which announce their values via standard ARIA attributes.

### Edge Cases

| Scenario                                     | Behavior                                                                                                                                |
| -------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------- |
| First visit to a project                     | Controls show surface defaults. No Reset button visible. Identical to today.                                                            |
| Return to a project after clearing its state | Same as first visit -- defaults.                                                                                                        |
| Rapid project switching                      | Each switch reads synchronously from cache. No race condition possible with sync reads. Server sync is debounced and uses latest state. |
| User has 50+ projects with saved state       | Preference payload grows proportionally. The lazy pruning strategy (from the feature spec) removes empty project entries on save.       |

---

## 9. Graceful Degradation -- Invalid Saved State

### Per-Control Fallback

When a saved value is invalid, ONLY that control falls back to its default. All other controls on the same surface retain their saved values.

| Scenario                                                          | Affected Control         | Fallback Behavior                                                                            | Other Controls                                                         |
| ----------------------------------------------------------------- | ------------------------ | -------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------- |
| Saved `channelFilter: "slack"` but Slack channel no longer exists | channelFilter            | Falls back to `''` (All Channels)                                                            | statusFilter, search, environmentFilter, filters[] retain saved values |
| Saved `dateRange: "custom"` with `customFrom > customTo`          | dateRange                | `dateRangeMode` falls back to `'quick'`, `quickRange` to default, both custom values cleared | activeTab retains saved value                                          |
| Saved `dimensionFilter: "nonexistent_pipeline"`                   | dimensionFilter          | Falls back to `'all'`                                                                        | dateRange, scoreFilter retain saved values                             |
| Saved `filterRows` with `columnKey: "removed_column"`             | That specific filter row | Row is silently dropped from the array                                                       | Other filter rows retained                                             |
| Saved `filterRows` with `operator: "invalid_op"`                  | That specific filter row | Row is silently dropped                                                                      | Other filter rows retained                                             |
| Saved `activeTab: "deleted_tab"`                                  | activeTab                | Falls back to first tab                                                                      | Date range, filters retain saved values                                |
| Saved `statusFilter: "custom_value"` not in enum                  | statusFilter             | Falls back to `'all'`                                                                        | Other controls retained                                                |

### Payload-Level Fallback

| Scenario                                                          | Behavior                                                                                                                             |
| ----------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------ |
| `insightsAnalyticsFilters` is `null` or missing                   | All surfaces use defaults. Normal first-use experience.                                                                              |
| `insightsAnalyticsFilters.version` does not match current version | Entire payload discarded. All surfaces use defaults. Log warning.                                                                    |
| `byProject[projectId]` is missing                                 | This project uses defaults. Other projects' state is unaffected.                                                                     |
| `byProject[projectId][surfaceKey]` has unexpected extra fields    | Extra fields are ignored (Zod `.passthrough()` or `.strip()` depending on implementation). Known fields are used.                    |
| Entire localStorage is cleared                                    | Local cache returns nothing. Server sync on next `loadPreferences()` restores from MongoDB. Until sync completes, defaults are used. |
| Server GET fails                                                  | Local cache is used. If local cache is also empty/corrupt, defaults. Page is fully usable.                                           |
| Server PATCH fails                                                | Local state continues working. Next successful PATCH heals the server record.                                                        |

### Validation Pipeline

Each surface's `usePersistedSurfaceFilters` hook runs a validation function on hydration:

```
1. Read raw value from preference store for this project + surface
2. If missing or null -> return surface defaults
3. If schema version mismatch -> return surface defaults, log warning
4. For each control:
   a. Validate type (string, boolean, array, enum membership)
   b. Validate value (enum inclusion, date validity, filter row structure)
   c. If invalid -> use that control's default, keep other controls
5. Return validated state object
```

---

## 10. Accessibility Specification

### Reset Button (Tier 2 and Tier 3)

| Attribute               | Value                                                                               |
| ----------------------- | ----------------------------------------------------------------------------------- |
| Element                 | `<button>` (native, not styled anchor)                                              |
| `aria-label`            | `"Reset {count} active {count === 1 ? 'filter' : 'filters'} to defaults"`           |
| Focus                   | Normal tab order within the header/toolbar row                                      |
| Keyboard activation     | Enter or Space                                                                      |
| Post-click announcement | `aria-live="polite"` region: `"Filters reset to defaults"` (clears after 3 seconds) |

### Active Filters Strip (Tier 3)

| Attribute                    | Value                                                                                                                                    |
| ---------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------- |
| Container                    | `role="region"` with `aria-label="Active filters"`                                                                                       |
| Page-level chip dismiss      | `aria-label="Clear {label} filter"`                                                                                                      |
| Advanced filter chip dismiss | `aria-label="Remove filter: {column} {operator} {value}"`                                                                                |
| Clear all button             | `aria-label="Clear all active filters"`                                                                                                  |
| Post-dismiss announcement    | `aria-live="polite"`: `"{label} filter cleared"` (single chip) or `"All filters cleared"` (clear all)                                    |
| Focus management             | After dismiss, focus moves to the next chip in the strip. After last chip is dismissed, focus moves to the first control in the toolbar. |

### Restored Controls (All Tiers)

No modification to existing ARIA attributes. Each control (select, button, input) announces its current value through its standard accessibility behavior. The restored value IS the announced value.

**Rationale for no "restored" annotation:** Adding "restored" to aria labels would introduce a concept the user does not need. The value is the value, regardless of whether it came from a default, a preference, or a manual selection. Objective 10 (zero learning curve) requires that the feature be invisible, including to screen reader users.

### Keyboard Flow Examples

**Dashboard (Tier 2):**
Tab order: `[Reset filters 2]` -> `[Last 90 days dropdown]` -> `[Overview tab]` -> `[Trends tab]` -> ...

**Sessions Explorer (Tier 3):**
Tab order: Status pills -> Search input -> Channel select -> Env select -> `[Reset filters 5]` -> `[Filters]` -> `[Columns]` -> `[CSV Export]` -> Strip chips (dismiss buttons) -> `[Clear all]`

---

## 11. Micro-Copy Reference

### Reset Button

| Context                 | Copy                                         |
| ----------------------- | -------------------------------------------- |
| Button label            | `Reset filters`                              |
| Count badge             | `{count}` (number only)                      |
| Button aria-label       | `Reset {count} active filter(s) to defaults` |
| Live region after click | `Filters reset to defaults`                  |

### Active Filters Strip (Tier 3)

| Context                                 | Copy                                                       |
| --------------------------------------- | ---------------------------------------------------------- |
| Page-level chip                         | `{Label}: {Value}` (e.g., "Status: Failed")                |
| Page-level chip dismiss aria-label      | `Clear {Label} filter`                                     |
| Advanced filter chip                    | `{Column} {operator} {value}` (existing FilterTags format) |
| Advanced filter chip dismiss aria-label | `Remove filter: {Column} {operator} {value}`               |
| Clear all link                          | `Clear all`                                                |
| Clear all aria-label                    | `Clear all active filters`                                 |
| Live region after single dismiss        | `{Label} filter cleared`                                   |
| Live region after clear all             | `All filters cleared`                                      |
| Strip region aria-label                 | `Active filters`                                           |

### Empty State / Error Copy

No new empty states are introduced. Persistence does not create new error conditions visible to users. All failures are silent fallbacks to defaults with server-side logging.

---

## 12. Component Inventory

### New Components

| Component                    | Location                                                   | Purpose                                                                                                                                                                                                   |
| ---------------------------- | ---------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `usePersistedSurfaceFilters` | `apps/studio/src/hooks/usePersistedSurfaceFilters.ts`      | Shared hook: hydrate from preferences, validate, persist on change (debounced), reset to defaults, compute non-default count and chip data                                                                |
| `ResetFiltersButton`         | `apps/studio/src/components/shared/ResetFiltersButton.tsx` | Ghost button with dynamic count badge. Renders only when `count > 0`.                                                                                                                                     |
| `ActiveFiltersStrip`         | `apps/studio/src/components/shared/ActiveFiltersStrip.tsx` | Unified chip strip for Tier 3 surfaces. Renders page-level chips (muted) + separator + advanced filter chips (accent). Includes "Clear all." Replaces standalone `FilterTags` usage on Insights surfaces. |
| `FilterChip`                 | `apps/studio/src/components/shared/FilterChip.tsx`         | Individual dismissible chip. Two variants: `page` (muted) and `advanced` (accent).                                                                                                                        |

### Modified Components

| Component              | Change                                                                                                                                                                       |
| ---------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `PageHeader`           | Add optional `beforeActions` slot for Reset button (left of existing `actions` slot)                                                                                         |
| `AtAGlancePage`        | Replace `useState` initializers with `usePersistedSurfaceFilters('atAGlance')`. Add `ResetFiltersButton` to PageHeader.                                                      |
| `AnalyticsPage`        | Replace `useState` initializers with `usePersistedSurfaceFilters('analyticsPage')`. Add `ResetFiltersButton` below pill strip.                                               |
| `SessionsExplorerTab`  | Replace `useState` initializers with `usePersistedSurfaceFilters('analyticsSessions')`. Add `ResetFiltersButton` to toolbar. Replace `FilterTags` with `ActiveFiltersStrip`. |
| `TracesExplorerTab`    | Replace `useState` initializers with `usePersistedSurfaceFilters('analyticsTraces')`. Add `ResetFiltersButton` to toolbar. Replace `FilterTags` with `ActiveFiltersStrip`.   |
| `ProjectBillingPage`   | Replace `dateRange` `useState` initializer with `usePersistedSurfaceFilters('billingUsage')`. No new UI.                                                                     |
| `AgentPerformancePage` | Replace `useState` initializers with `usePersistedSurfaceFilters('agentPerformance')`. Add `ResetFiltersButton` to PageHeader.                                               |
| `QualityMonitorPage`   | Replace `useState` initializers with `usePersistedSurfaceFilters('qualityMonitor')`. Add `ResetFiltersButton` to PageHeader.                                                 |
| `CustomerInsightsPage` | Replace `dateRange` `useState` initializer with `usePersistedSurfaceFilters('customerInsights')`. No new UI.                                                                 |
| `VoiceAnalyticsPage`   | Replace `dateRange` `useState` initializer with `usePersistedSurfaceFilters('voiceAnalytics')`. No new UI.                                                                   |
| `preferences-store.ts` | Extend state type and persistence with `insightsAnalyticsFilters` payload. Add per-project, per-surface read/write/reset helpers.                                            |
| `api/preferences.ts`   | Extend `PreferencesData` type to include `insightsAnalyticsFilters`.                                                                                                         |

### Unchanged Components

| Component                                   | Why Unchanged                                                                                    |
| ------------------------------------------- | ------------------------------------------------------------------------------------------------ |
| `AdvancedFilterPanel`                       | Still manages filter rows as before. Its "Clear all" clears only advanced rows within the panel. |
| `FilterTags`                                | Still exists for non-Insights surfaces. On Insights surfaces, replaced by `ActiveFiltersStrip`.  |
| `ColumnCustomizer`                          | Separate persistence path, not part of this feature.                                             |
| `SearchInput`                               | Already supports controlled `value` prop.                                                        |
| `Tabs`                                      | Already supports controlled `activeTab` prop.                                                    |
| `Button`, `Badge`, `Select`, `DropdownMenu` | No changes needed.                                                                               |

---

## 13. Annotated Wireframes -- Representative Examples

### Example 1: Dashboard (Tier 2, Spacious)

**First visit -- all defaults:**

```
+============================================================+
| SIDEBAR  | At a Glance                                     |
|          | Executive overview of your AI agent program      |
|          |                              [Last 30 days  v]   |
| Insights |                                                  |
|  > Dash  |--------------------------------------------------+
|    Analyt| [Overview] [Trends] [ROI] [Conversations]        |
|    Agent |--------------------------------------------------+
|    Quality|                                                 |
|    Cust  | +-------+ +--------+ +-------+ +------+ +------+ |
|    Voice | | 1,234 | | 72.3%  | |  3.8  | | 0.45 | | $850 | |
|    Billing| Convos | Contain | Quality | Sentmt | Savings| |
|          | +-------+ +--------+ +-------+ +------+ +------+ |
|          |                                                  |
|          | [Chart: Volume & Containment Rate]               |
|          | [Chart: Outcome Distribution]                    |
|          | [Table: Intent Breakdown]                        |
+============================================================+
```

No Reset button. Clean. Identical to today.

**Returning visit -- 90d, ROI tab, with conversation filter:**

```
+============================================================+
| SIDEBAR  | At a Glance                                     |
|          | Executive overview ... [Reset filters 3]         |
|          |                              [Last 90 days  v]   |
| Insights |                                                  |
|  > Dash  |--------------------------------------------------+
|    Analyt| [Overview] [Trends] [*ROI*] [Conversations]      |
|    ...   |--------------------------------------------------+
|          |                                                  |
|          | +----------+ +---------+ +------+ +-----------+  |
|          | | $12,400  | |  340%   | |  2.1 | |   $0.08   |  |
|          | | Savings  | | Ann ROI | | FTE  | | Cost/Res  |  |
|          | +----------+ +---------+ +------+ +-----------+  |
|          |                                                  |
|          | [Chart: AI Cost vs Est. Human Cost (90d)]        |
+============================================================+
```

The `[Reset filters 3]` button indicates 3 controls are non-default.

---

### Example 2: Sessions Explorer (Tier 3, Dense)

**With active filters -- page-level and advanced:**

```
+============================================================+
| SIDEBAR  | Analytics                                       |
|          | Real-time traces, sessions, and LLM performance |
|          |                                                  |
| Insights | [30m][1h][3h][6h][12h][24h][2d][7d][30d][Cust] |
|          |                                                  |
|          | [Over][LLM][*Sessions Explorer*][Traces][Query]  |
|          |--------------------------------------------------|
|          |                                                  |
|          | [All] [Active] [Completed] [*Escalated*]         |
|          | [Failed] [Ended]                                 |
|          |                                                  |
|          | [Search: "timeout"]  [Channel: web v]            |
|          |     [Env: prod v]                                |
|          |        [Reset filters 5] [Filters(2)] [Cols]    |
|          |                                                  |
|          | Status: Escalated [x] Search: "timeout" [x]     |
|          | Channel: web [x] Env: prod [x]                   |
|          | | Agent contains "support" [x]                   |
|          |   Cost > 0.10 [x]              Clear all        |
|          |                                                  |
|          | +----------------------------------------------+ |
|          | | Session ID | Agent | Status | Env | Created | |
|          | | abc123...  | suprt | Escltd | prod| 2h ago  | |
|          | | def456...  | bill  | Escltd | prod| 5h ago  | |
|          | +----------------------------------------------+ |
+============================================================+
```

The unified strip shows:

- 4 page-level chips (muted: Status, Search, Channel, Env)
- Visual separator `|`
- 2 advanced filter chips (accent: Agent contains, Cost >)
- "Clear all" at the end

---

### Example 3: Billing (Tier 1, Single Control)

```
+============================================================+
| SIDEBAR  | Billing & Usage                                 |
|          | Usage overview for Acme Corp                    |
| Insights |                                                  |
|          | [ 7d ] [*30d*] [ 90d ]   <-- restored silently   |
|          |                                                  |
|          | (BillingUsageReportPanel -- completely unchanged) |
|          |                                                  |
|          | [KPI Cards: Total Cost | LLM Cost | Sessions]   |
|          | [Chart: Daily Usage Trend]                       |
|          | [Table: Usage Breakdown by Agent]                |
+============================================================+
```

Zero new UI. Carlos sees nothing different.

---

## 14. Interaction Specifications

### Filter Change -> Persist

1. User changes a control (e.g., selects "Last 90 days" from date dropdown).
2. The `usePersistedSurfaceFilters` hook updates local state immediately (normal React state update).
3. The hook schedules a debounced preference save (2 second delay, matching existing `SAVE_DEBOUNCE_MS`).
4. The local Zustand persist store updates synchronously (localStorage write).
5. After debounce, the server PATCH fires in the background.
6. If PATCH fails, local state continues working. Next successful save heals the record.

**Special case -- search input:** Search text changes are frequent (keystroke-by-keystroke). The `SearchInput` component already debounces its `onChange` callback (300ms). The preference save debounce (2000ms) provides an additional layer. Net effect: search text is persisted approximately 2 seconds after the user stops typing.

### Reset Click Flow

1. User clicks "Reset filters" button.
2. All persisted controls for this surface are set to their defaults.
3. Local state updates immediately (controls snap to defaults).
4. Preference store updates synchronously (localStorage).
5. Debounced server PATCH fires.
6. `aria-live` region announces "Filters reset to defaults."
7. Reset button disappears (count is now 0).
8. On Tier 3 surfaces, the strip also disappears.
9. Data-fetching hooks receive the new (default) values and re-fetch.

### Individual Chip Dismiss Flow (Tier 3)

1. User clicks X on a chip (e.g., "Channel: Slack").
2. Only `channelFilter` is reset to `''`.
3. Local state updates. Strip re-renders (chip removed). Reset count decreases.
4. Debounced preference save.
5. `aria-live` announces "Channel filter cleared."
6. If this was the last non-default control, both Reset button and strip disappear.

### Project Switch Flow

1. User selects a different project in the project picker.
2. `projectId` updates in the navigation store.
3. All mounted `usePersistedSurfaceFilters` hooks re-evaluate with the new `projectId`.
4. Synchronous localStorage read for new project's state.
5. Controls render with the new project's remembered values (or defaults if first visit).
6. Data-fetching hooks receive new project + filter values, begin loading.
7. Charts/tables show loading skeletons (normal behavior).
8. No additional screen reader announcement beyond the project picker's own announcement.

---

## 15. Design Rationale -- Key Decisions

### Why a button instead of a text link for Reset?

Persona simulation showed that a text link (Design A) scored 3/5 on discoverability with Priya (Quality Analyst) who explicitly wanted an obvious reset action. The button with count badge (Design B) scored 5/5. Since the feature spec says "provide an obvious Reset filters action," the button is the right choice.

### Why NOT show chips on Tier 2 surfaces?

Persona simulation showed that Maya (Project Manager, low-medium tech) preferred the calm Dashboard layout. Adding a chip strip below the header on an executive surface adds visual noise without proportional value -- on a page with 3 controls, the count badge communicates everything needed. Chips provide value on Tier 3 where there can be 5-15+ active constraints that benefit from individual dismissal.

### Why unify FilterTags with page-level chips on Tier 3?

Two separate rows of dismissible pills would be confusing ("which row clears what?") and waste vertical space on dense surfaces. Unification into a single strip with a visual separator between page-level (muted) and advanced (accent) chips gives a clear, scannable view of ALL active constraints.

### Why does Shell Reset not clear sub-tab state?

The Analytics shell and each sub-tab have independent `surfaceKey`s. An operations lead who carefully built a Sessions Explorer filter set should not lose it when resetting the shell date range. Objective 3 (per-surface independence) requires this separation.

### Why does Reset clear dimensionFilter and scoreFilter on Quality Monitor even though they are inside a child component?

Because those controls are persisted as part of the `qualityMonitor` surface. "Reset filters" means "reset all persisted state for this surface." Splitting reset by visual position (header vs. table) would create a confusing partial reset. The user clicked "Reset" to start fresh -- they get fresh.

### Why no "Reset" on single-control surfaces?

FR-4 explicitly states: "The system must expose a Reset filters action on surfaces with more than one persistent control." A single date range control does not warrant a reset action -- the user just changes it back manually. Adding a reset button next to a single dropdown would look odd and violate Objective 11 (density-tier fidelity).

---

## 16. Implementation Handoff Notes

### For the Frontend Engineer

1. **Start with `usePersistedSurfaceFilters` hook.** This is the shared kernel. It handles hydration, validation, debounced persistence, reset, non-default count, and chip data generation. Every surface integrates through this hook.

2. **Extend `preferences-store.ts` and `api/preferences.ts` with `insightsAnalyticsFilters`.** Follow the existing pattern: Zustand persist for localStorage, background server sync with debounce.

3. **Build `ResetFiltersButton` as a standalone shared component.** It takes `count` and `onReset` props. It renders conditionally based on `count > 0`.

4. **Build `ActiveFiltersStrip` for Tier 3 surfaces.** It takes `pageChips` and `advancedChips` arrays and renders them with the separator. It is used instead of `FilterTags` on Insights surfaces.

5. **Integration order recommendation:** Tier 1 first (simplest -- just change initializers), then Tier 2 (add Reset button), then Tier 3 (add strip). Each tier can be shipped independently.

6. **The existing `FilterTags` component stays for non-Insights surfaces.** The `ActiveFiltersStrip` replaces it only on Sessions Explorer, Traces Explorer, and Generations.

### For the Product Owner

1. **What users will see:** Nothing, until they return to a page they previously configured. Then they will see their controls pre-filled. On multi-filter pages, a small "Reset filters" button appears when something is non-default.

2. **What users will NOT see:** No banners, no modals, no tutorials, no onboarding, no "we saved your preferences" message.

3. **How to verify it works:** Change a date range on Dashboard, navigate away, come back. The date range should be remembered. Switch projects -- each project should have its own remembered state.

4. **Cross-device behavior:** Once server sync completes (background, ~2 seconds after any change), the same state is available on another device/browser. The user opens the page and sees their filters pre-filled.

5. **Feature is fully reversible:** If a user wants to start fresh, "Reset filters" on multi-filter pages or manually changing the control on single-control pages returns to defaults and clears the saved state.

---

## 17. Persona Validation Summary

| Persona                   | Score | Key Moment                                                                                                                               |
| ------------------------- | ----- | ---------------------------------------------------------------------------------------------------------------------------------------- |
| Maya (PM, Dashboard)      | 9/10  | "I opened Dashboard and it was right where I left off. The little Reset button is there if I need it, but I probably won't."             |
| Ravi (Ops, Sessions)      | 9/10  | "I switched projects and each had my filters. The strip shows everything at a glance. I can dismiss one filter without losing the rest." |
| Priya (QA, Quality)       | 9/10  | "My dimension and score filters were remembered. The Reset button is obvious -- one click and I'm back to a clean slate."                |
| Carlos (Finance, Billing) | 10/10 | "Nothing changed. The date was already set to what I had last time. I didn't even realize anything was different."                       |
| Aisha (CI/Voice Lead)     | 10/10 | "Both Customer Insights and Voice Analytics remembered my 30-day window. No new buttons, no new anything. Perfect."                      |

**Average score: 9.4/10. All personas at or above 9. No persona left behind.**

---

## 18. Competitive Positioning

| Capability                | ABL Studio (this design)                 | Mixpanel              | Amplitude                             | Datadog              | Grafana               | Vercel            |
| ------------------------- | ---------------------------------------- | --------------------- | ------------------------------------- | -------------------- | --------------------- | ----------------- |
| Silent filter restoration | Yes (per-surface, per-project)           | Partial (per-report)  | Yes (saved segments)                  | Yes (template vars)  | Yes (URL vars)        | Yes (URL params)  |
| Cross-device sync         | Yes (server-backed)                      | Yes (cloud)           | Yes (cloud)                           | Yes (cloud)          | Depends on deployment | Yes (URL sharing) |
| Per-surface independence  | Yes (10 surfaces, independent)           | Yes (per-report)      | Partial (dashboard filters propagate) | Per-dashboard        | Per-dashboard         | Single page       |
| Per-project scoping       | Yes (per-project nesting)                | N/A (different model) | Per-project                           | Per-dashboard        | Per-dashboard         | Per-project       |
| Individual filter dismiss | Yes (Tier 3 chips)                       | No                    | No                                    | No                   | No                    | No                |
| Reset with count          | Yes (badge shows non-default count)      | No                    | No                                    | Saved views dropdown | No                    | No                |
| Named saved views         | Not in Phase 1 (schema extensible)       | Yes                   | Yes (saved segments)                  | Yes (saved views)    | No                    | No                |
| Shareable filter URLs     | Not in Phase 1 (URL sync possible later) | Via report sharing    | Via URL copy                          | Via URL params       | Yes (URL vars)        | Yes (URL params)  |

**Where we win:** Per-project scoping with cross-device sync. Individual chip dismissal on dense surfaces. The count badge communicates active filter state better than any competitor.

**Where we lag (Phase 1):** No named saved views, no shareable URLs. These are explicitly out of scope for Phase 1 but the schema reserves extension points.

---

## 19. Remaining Gaps

| ID       | Description                                                                                                                           | Severity | Status                                                                   |
| -------- | ------------------------------------------------------------------------------------------------------------------------------------- | -------- | ------------------------------------------------------------------------ |
| UX-GAP-1 | Phase 1 does not support named saved views or shareable filter URLs.                                                                  | Medium   | Deferred (schema extensible)                                             |
| UX-GAP-2 | Query SQL editor text is not persisted.                                                                                               | Low      | Intentional exclusion per feature spec                                   |
| UX-GAP-3 | Multi-tab/multi-device conflicts use last-write-wins.                                                                                 | Medium   | Acceptable for Phase 1                                                   |
| UX-GAP-4 | The "Tab" chip on Dashboard/Analytics Shell (showing non-default active tab) is a new interaction pattern.                            | Low      | Acceptable -- dismissing it switches tabs, which is uncommon but logical |
| UX-GAP-5 | ActiveFiltersStrip replaces FilterTags on Insights surfaces -- implementation must ensure non-Insights surfaces still use FilterTags. | Low      | Implementation concern, not UX gap                                       |

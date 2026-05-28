# Persistent Insights & Analytics Filters -- Design C: Unified Active-State Strip

**Date:** 2026-04-22
**Pattern:** Chip strip with per-control dismissal, unified with existing FilterTags
**Philosophy:** Every non-default control is visible as a dismissible chip. At a glance, you know exactly what's been set and can dismiss any single control individually. On dense pages, this UNIFIES with the existing FilterTags into a single combined strip rather than two separate rows.

---

## 1. Core Principle

Silent restoration, same as A and B. But the escape hatch gives the most granular control: each non-default value appears as a chip that can be dismissed individually. "Clear all" appears when 2+ chips are shown. On Tier 3 pages, the chip strip MERGES with the existing FilterTags, creating a single unified row of all active constraints -- page-level controls and advanced filter rows together.

---

## 2. Density Tier Specifications

### Tier 1 -- Single Control (Billing, Customer Insights, Voice Analytics)

**Zero new UI.** Identical to Design A and B. Silent restore. No chips. No strip.

A single-control surface with its only control at default has no chips. With a non-default date range, there is still no chip strip because FR-4 says Reset applies only to multi-filter surfaces. The date picker is the reset: the user changes it back manually.

---

### Tier 2 -- Executive Multi-Control (Dashboard, Agent Performance, Quality Monitor)

**A thin chip strip appears between the PageHeader and the content area, ONLY when at least one control is non-default.**

#### Dashboard / At a Glance

**All defaults (first visit or after reset):**

```
+------------------------------------------------------------------+
| At a Glance                                                      |
| Executive overview of your AI agent program     [Last 30 days v] |
+------------------------------------------------------------------+
| [Overview] [Trends] [ROI] [Conversations]                        |
+------------------------------------------------------------------+
| (KPI cards, charts)                                              |
+------------------------------------------------------------------+
```

No strip. Clean. Maya sees zero change.

**After Maya changes date range to 90d and switches to Trends tab, then revisits:**

```
+------------------------------------------------------------------+
| At a Glance                                                      |
| Executive overview of your AI agent program     [Last 90 days v] |
+------------------------------------------------------------------+
| Date: Last 90 days [x]  Tab: Trends [x]         Clear all       |
+------------------------------------------------------------------+
| [Overview] [Trends] [ROI] [Conversations]                        |
+------------------------------------------------------------------+
| (Trends charts with 90d data)                                    |
+------------------------------------------------------------------+
```

**Chip strip specification:**

Each chip:

```tsx
<span className="inline-flex items-center gap-1 pl-2 pr-1 py-0.5 rounded-full text-xs font-medium bg-background-muted text-foreground border border-default">
  <span className="text-muted">{controlLabel}:</span>
  <span>{displayValue}</span>
  <button
    onClick={() => resetSingleControl(controlKey)}
    className="ml-0.5 p-0.5 rounded-full hover:bg-background-elevated transition-default"
    aria-label={`Clear ${controlLabel} filter`}
  >
    <X className="w-3 h-3" />
  </button>
</span>
```

**Chip styling rationale:** Uses `bg-background-muted text-foreground border-default` -- deliberately MORE SUBTLE than the existing FilterTags which use `bg-accent-subtle text-accent border-accent/20`. This creates a visual hierarchy:

- Page-level control chips: neutral, muted background
- Advanced filter chips (FilterTags): accent-colored, slightly more prominent

This distinction matters in Tier 3 where both appear in the same row.

**"Clear all" link:**

- Appears at the end of the strip when 2+ chips are present.
- With only 1 chip, no "Clear all" -- the single chip's X suffices.
- Copy: `Clear all`
- Styling: `text-xs text-muted hover:text-error transition-default`

**Strip positioning:** Below PageHeader, above Tabs. Uses `px-6 py-2` padding to match the page's horizontal rhythm. Separated from content by the normal page spacing.

**Strip visibility animation:** `animate-fade-in-up` (fade + translateY from 4px). Strip collapses with `animate-fade-out` when last chip is dismissed.

#### Agent Performance

**Non-default state example:**

```
+------------------------------------------------------------------+
| Agent Performance                                                |
| Monitor agent health and quality                 [Last 30 days v]|
+------------------------------------------------------------------+
| Date: Last 30 days [x]  Status: Critical [x]                    |
| Search: "billing" [x]                            Clear all       |
+------------------------------------------------------------------+
| [Agent Health Banner]                                            |
+------------------------------------------------------------------+
```

**Chip generation:**
| Control | Chip Label | Display Value | Shows When |
|---------|-----------|---------------|------------|
| dateRange | Date | "Last 30 days" / "Last 90 days" | `!== '7d'` |
| compareEnabled | Compare | "Enabled" | `=== true` |
| search | Search | `"{search}"` (truncated to 20 chars) | `!== ''` |
| statusFilter | Status | "Critical" / "Warning" | `!== 'all'` |

#### Quality Monitor

**Non-default state example:**

```
+------------------------------------------------------------------+
| Quality Monitor                                                  |
| System-wide quality dashboard                    [Last 30 days v]|
+------------------------------------------------------------------+
| Date: Last 30 days [x]  Dimension: Hallucination [x]            |
| Score: Critical [x]                               Clear all     |
+------------------------------------------------------------------+
| [Quality Health Banner]                                          |
+------------------------------------------------------------------+
```

**Chip generation:**
| Control | Chip Label | Display Value | Shows When |
|---------|-----------|---------------|------------|
| dateRange | Date | Label from DATE_RANGE_LABELS | `!== '30d'` |
| dimensionFilter | Dimension | Formatted dimension name | `!== 'all'` |
| scoreFilter | Score | "Critical" / "Warning" / "Healthy" | `!== 'all'` |

---

### Tier 3 -- Operator Dense (Analytics Shell + Sessions Explorer + Traces Explorer + Generations)

**This is where Design C makes its most distinctive choice: UNIFICATION.**

On Tier 3 surfaces, the chip strip MERGES with the existing FilterTags into a single combined row. All non-default constraints -- page-level controls AND advanced filter rows -- appear as chips in one horizontal strip.

**Why unify?** Two separate rows of dismissible chips (one for page-level, one for advanced) would be:

1. Visually cluttered (two rows of similar-looking pills)
2. Confusing (which row clears what?)
3. Wasteful of vertical space on dense pages

**How the unified strip works:**

Page-level chips use muted styling. Advanced filter chips use accent styling (existing FilterTags design). Both appear in the same row, with page-level chips FIRST, followed by advanced filter chips, followed by "Clear all."

```
[Status: Failed][x] [Search: "billing"][x] [Channel: Slack][x] | Agent contains "router"[x] Cost > 0.5[x] | Clear all
^--- muted bg, page-level controls ---^   ^--- accent bg, advanced filters (existing FilterTags style) ---^
```

The `|` separator is visual only -- a subtle 1px border-right divider between the two groups. This is not a UI element, just a thin vertical line (`border-r border-default h-4 mx-1.5`).

#### Analytics Shell

```
+------------------------------------------------------------------+
| Analytics                                                        |
| Real-time traces, sessions, and LLM performance                 |
|                                                                  |
| [30m][1h][3h][6h][12h][24h][2d][7d][30d][Custom]               |
+------------------------------------------------------------------+
| Date: Custom (Apr 1 - Apr 15) [x]  Tab: Sessions [x]  Clear all|
+------------------------------------------------------------------+
| [Overview] [LLM] [Sessions Explorer] [Traces Explorer] [Query]  |
+------------------------------------------------------------------+
```

Shell-level chips appear between the pill strip and the tab bar.

**Reset semantics:** "Clear all" in the shell strip clears ONLY shell state. Sub-tab state is unaffected.

**Why shell state shows chips for tab selection:** If the user's restored tab is "Sessions Explorer" instead of the default "Overview," showing a chip for it communicates "you're here because of a preference, not because it's the landing tab." This is subtle transparency without a banner. Dismissing the tab chip switches to the default tab.

#### Sessions Explorer -- Unified Strip

**Before unification (what it looks like today with advanced filters active):**

```
[Toolbar: search, channel, env, Filters(3), Cols, CSV]
[FilterTags: Agent contains "router" | Cost > 0.5 | Tokens > 1000]
```

**After unification (Design C):**

```
+------------------------------------------------------------------+
| [All][Active][Completed][Escalated][Failed][Ended]               |
+------------------------------------------------------------------+
| [Search sessions...]  [Channel v] [Env v]  [Filters]  [Cols]   |
+------------------------------------------------------------------+
| Status: Failed [x]  Search: "billing" [x]  Channel: Slack [x]  |
| | Agent contains "router" [x]  Cost > 0.5 [x]       Clear all  |
+------------------------------------------------------------------+
| (Sessions table)                                                 |
+------------------------------------------------------------------+
```

**Key changes from today:**

1. The FilterTags row is replaced by the unified strip.
2. Page-level non-default controls (status, search, channel, env) appear as muted chips at the start.
3. Advanced filter rows appear as accent chips after the divider.
4. "Clear all" at the end clears EVERYTHING for this surface.
5. The "Filters" button no longer shows a count badge (the count is visible in the chips themselves). It just shows "Filters" and opens the panel.

**Wait -- removing the Filters button count badge is a regression!**

No. The count is now MORE visible: each advanced filter is a visible chip in the strip. The badge was a compressed representation; the chips are an expanded one. Removing the badge simplifies the toolbar and moves the information to the unified strip where it's more actionable (each chip is individually dismissible).

However, if NO advanced filters are active and NO page-level controls are non-default, the strip is absent entirely. The Filters button reverts to its baseline look (`border-default text-muted`).

#### Traces Explorer -- Unified Strip

```
+------------------------------------------------------------------+
| [Traces] [Generations]                                           |
+------------------------------------------------------------------+
| [All][LLM][Tool][Decision][Handoff][Error][Agent]               |
+------------------------------------------------------------------+
| [Search traces...]                    [Filters]  [Cols]         |
+------------------------------------------------------------------+
| Type: LLM Call [x]  Search: "gpt" [x] | Latency > 500ms [x]   |
|                                                     Clear all   |
+------------------------------------------------------------------+
```

Same unified strip. Type filter and search as muted chips. Advanced filter rows as accent chips.

**Sub-tab scope:** When the user switches from Traces to Generations, the strip re-renders with Generations' non-default state. The strip content is always scoped to the active sub-tab.

#### Generations -- Unified Strip

```
+------------------------------------------------------------------+
| [Traces] [Generations]                                           |
+------------------------------------------------------------------+
| [Search generations...]               [Filters]  [Cols]        |
+------------------------------------------------------------------+
| Search: "gpt-4" [x] | Model contains "gpt-4" [x]   Clear all  |
+------------------------------------------------------------------+
```

---

## 3. Chip Label Specifications -- All Surfaces

| Surface         | Control             | Chip Label  | Display Value                              | Default (chip hidden when)        |
| --------------- | ------------------- | ----------- | ------------------------------------------ | --------------------------------- |
| Dashboard       | dateRange           | Date        | "Last 7 days" etc.                         | `=== '30d'`                       |
| Dashboard       | activeTab           | Tab         | "Trends" / "ROI" / "Conversations"         | `=== 'overview'`                  |
| Dashboard       | conversationFilter  | Filter      | "Flagged" / "Low Quality" / "High Quality" | `=== ''`                          |
| Analytics Shell | dateRangeMode+range | Date        | "30m" / "Custom (Apr 1-15)"                | `mode==='quick' && range==='30m'` |
| Analytics Shell | activeTab           | Tab         | "LLM" / "Sessions" etc.                    | `=== 'overview'`                  |
| Sessions        | statusFilter        | Status      | "Active" / "Completed" etc.                | `=== 'all'`                       |
| Sessions        | search              | Search      | `"value"` (truncated 20 chars)             | `=== ''`                          |
| Sessions        | channelFilter       | Channel     | Channel name                               | `=== ''`                          |
| Sessions        | environmentFilter   | Environment | Environment name                           | `=== ''`                          |
| Traces          | activeSubTab        | View        | "Generations"                              | `=== 'traces'`                    |
| Traces          | typeFilter          | Type        | "LLM Call" etc.                            | `=== 'all'`                       |
| Traces          | searchQuery         | Search      | `"value"`                                  | `=== ''`                          |
| Generations     | searchQuery         | Search      | `"value"`                                  | `=== ''`                          |
| Agent Perf      | dateRange           | Date        | Label text                                 | `=== '7d'`                        |
| Agent Perf      | compareEnabled      | Compare     | "Enabled"                                  | `=== false`                       |
| Agent Perf      | search              | Search      | `"value"`                                  | `=== ''`                          |
| Agent Perf      | statusFilter        | Status      | "Critical" / "Warning"                     | `=== 'all'`                       |
| Quality         | dateRange           | Date        | Label text                                 | `=== '30d'`                       |
| Quality         | dimensionFilter     | Dimension   | Formatted name                             | `=== 'all'`                       |
| Quality         | scoreFilter         | Score       | "Critical" / "Warning" / "Healthy"         | `=== 'all'`                       |

---

## 4. Reset Semantics -- Full Specification

| Surface           | "Clear all" Scope    | What It Clears                                                    | What It Does NOT Clear          |
| ----------------- | -------------------- | ----------------------------------------------------------------- | ------------------------------- |
| Dashboard         | All dashboard state  | dateRange, activeTab, conversationFilter                          | ROI settings, pagination        |
| Analytics Shell   | Shell only           | dateRangeMode, quickRange, customRange, activeTab                 | Sub-tab state                   |
| Sessions Explorer | Sessions only        | statusFilter, search, channelFilter, environmentFilter, filters[] | Column config, sort, pagination |
| Traces Explorer   | Active sub-tab only  | typeFilter/searchQuery/filterRows (or generations equivalent)     | Other sub-tab, column config    |
| Generations       | Generations only     | searchQuery, filterRows[]                                         | Traces state, column config     |
| Agent Performance | All agent perf state | dateRange, compareEnabled, search, statusFilter                   | Sort, pagination                |
| Quality Monitor   | All quality state    | dateRange, dimensionFilter, scoreFilter                           | Expanded cards, pagination      |

**Individual chip dismissal:** Clicking X on a chip resets ONLY that control to its default and persists the change. All other controls remain unchanged.

---

## 5. Project-Switch Transition

**Identical to Design A and B.** Synchronous localStorage read, no flash.

**Additional for Design C:** The chip strip re-evaluates on project switch. If the new project has all defaults, the strip is absent. If the new project has non-default state, the strip appears with the appropriate chips. The transition is the standard `animate-fade-in-up`.

---

## 6. Graceful Degradation

**Per-control fallback, same as A and B.**

**Chip-specific consideration:** If a saved value is invalid and falls back to default, no chip appears for it. The strip only shows chips for values that are actually non-default after validation.

---

## 7. Accessibility Specification

**Chip strip:**

- Each chip is a `<span>` containing a dismiss `<button>`.
- Dismiss button: `aria-label="Clear {controlLabel} filter"`.
- "Clear all" button: `aria-label="Clear all active filters"`.
- Focus order: chips are tab-navigable. First chip's dismiss button -> next chip's dismiss -> ... -> "Clear all" button.

**Screen reader flow:**
When entering the strip region, a screen reader hears:
"Active filters region. Status: Failed, button Clear Status filter. Search: billing, button Clear Search filter. Agent contains router, button Clear Agent filter. Button Clear all active filters."

**Strip ARIA:**

```tsx
<div role="region" aria-label="Active filters" className="...">
  {chips}
  {clearAllButton}
</div>
```

**On chip dismiss:** `aria-live="polite"` announces "{controlLabel} filter cleared."
**On clear all:** `aria-live="polite"` announces "All filters cleared."

---

## 8. Micro-copy Reference

| Element                  | Copy                          | Styling                                                                                          |
| ------------------------ | ----------------------------- | ------------------------------------------------------------------------------------------------ |
| Page-level chip          | `{Label}: {Value}`            | `bg-background-muted text-foreground border-default rounded-full text-xs`                        |
| Advanced filter chip     | `{Column} {operator} {value}` | `bg-accent-subtle text-accent border-accent/20 rounded-full text-xs` (existing FilterTags style) |
| Chip dismiss             | X icon                        | `w-3 h-3`, hover bg                                                                              |
| Clear all                | `Clear all`                   | `text-xs text-muted hover:text-error`                                                            |
| Chip dismiss aria-label  | `Clear {Label} filter`        | On button                                                                                        |
| Clear all aria-label     | `Clear all active filters`    | On button                                                                                        |
| Live region on dismiss   | `{Label} filter cleared`      | `aria-live="polite"`                                                                             |
| Live region on clear all | `All filters cleared`         | `aria-live="polite"`                                                                             |
| Strip region             | --                            | `role="region" aria-label="Active filters"`                                                      |

---

## 9. Component-Level Mapping

| Existing Component                | Change Required                                             |
| --------------------------------- | ----------------------------------------------------------- |
| `PageHeader`                      | No change (strip is below PageHeader, not inside it)        |
| `AdvancedFilterPanel`             | No change to panel itself                                   |
| `FilterTags`                      | REPLACED by unified `ActiveFiltersStrip` on Tier 3 surfaces |
| `Tabs`                            | No change                                                   |
| New: `usePersistedSurfaceFilters` | Hydrate/validate/persist/reset + `nonDefaultChips[]`        |
| New: `ActiveFiltersStrip`         | Unified chip strip with page-level + advanced filter chips  |
| New: `FilterChip`                 | Individual dismissible chip component                       |

**FilterTags replacement note:** The existing `FilterTags` component is used only in Sessions Explorer and Traces Explorer. On those surfaces, it gets replaced by `ActiveFiltersStrip` which renders both page-level and advanced chips. On surfaces that don't have advanced filters, `ActiveFiltersStrip` renders only page-level chips. The `AdvancedFilterPanel` slideout continues to work exactly as before -- it manages the `filterRows` state. The strip just renders them differently (unified with page-level chips).

---

## 10. Self-Review

### Objective Scorecard

| #   | Objective                  | Score (1-5) | Notes                                                                                                                                 |
| --- | -------------------------- | ----------- | ------------------------------------------------------------------------------------------------------------------------------------- |
| 1   | Invisible restoration      | 4           | Controls pre-filled AND chips appear -- the chips are a visible indicator of non-default state                                        |
| 2   | Instant feel               | 5           | Sync localStorage read                                                                                                                |
| 3   | Per-surface independence   | 5           | Independent surfaceKeys                                                                                                               |
| 4   | Per-project isolation      | 5           | byProject nesting                                                                                                                     |
| 5   | Obvious escape hatch       | 5           | Per-chip dismiss + Clear all -- most granular reset                                                                                   |
| 6   | Graceful degradation       | 5           | Per-control fallback                                                                                                                  |
| 7   | Density-appropriate        | 4           | Tier 2 adds a visible strip. Tier 3 unifies well but adds vertical space                                                              |
| 8   | Accessibility              | 5           | ARIA region, per-chip dismiss labels, live region                                                                                     |
| 9   | No cross-surface confusion | 5           | Chips explicitly label what's set on this surface                                                                                     |
| 10  | Zero learning curve        | 3           | Chips are a new UI element. Users who never changed anything see nothing, but users who did see a row of pills they didn't put there. |
| 11  | Density-tier fidelity      | 5           | Tier 1 has zero new UI                                                                                                                |

### Known Weaknesses

1. **"Invisible" vs. "visible summary" tension (Objective 1, scored 4/5, Objective 10, scored 3/5):** The chip strip actively surfaces restored state. A user who changed their date range last week and returns today sees a "Date: Last 90 days [x]" chip they didn't expect. This might feel like the product is "telling them" about persistence -- exactly what the feature spec says to avoid ("no restoration banner"). Counter-argument: the chip is not a banner about restoration. It's a summary of active state. Many analytics tools (Linear, Datadog) show active filters as chips.

2. **FilterTags replacement scope (new component):** Replacing FilterTags with ActiveFiltersStrip means the Tier 3 change is slightly larger in implementation scope. However, the replacement is additive (ActiveFiltersStrip renders existing FilterTags-style chips plus page-level chips) and the old FilterTags component can remain for non-Insights surfaces.

3. **Tab chip is debatable:** Showing a chip for the active tab when it differs from default (e.g., "Tab: Trends [x]") might be surprising. The tab is already visually selected in the tab bar. Dismissing the tab chip would switch tabs, which is an unusual interaction. Alternative: exclude tab selection from chip generation. This is a judgment call.

---

## 11. Review Status

Self-review complete. 1 MEDIUM gap: tension between invisible restoration and visible chip strip. 1 LOW gap: tab chip interaction model. No CRITICAL gaps.

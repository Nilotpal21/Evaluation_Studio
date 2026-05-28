# Persistent Insights & Analytics Filters -- Design B: Active Filter Count

**Date:** 2026-04-22
**Pattern:** Badge-annotated reset button in a fixed header position
**Philosophy:** Restoration is silent, but the escape hatch is prominent. A small ghost button with a count badge tells you at a glance how many controls are non-default, and one click resets them all. The button lives in the same visual language as the existing "Filters (3)" pattern in Sessions Explorer.

---

## 1. Core Principle

Silent restoration (controls pre-filled, no banner). But the reset affordance is a proper button -- not a text link -- with a count badge. This makes it more discoverable than Design A while remaining lightweight. The count badge is the key differentiator: it quantifies "how far am I from defaults?" at a glance.

---

## 2. Density Tier Specifications

### Tier 1 -- Single Control (Billing, Customer Insights, Voice Analytics)

**Zero new UI.** Identical to Design A Tier 1. Silent restore of date range. No reset button. No badge. No new elements.

```
Billing & Usage:        [ 7d ]  [ 30d ]  [ 90d ]     <-- restored silently
Customer Insights:      [Last 30 days v]              <-- restored silently
Voice Analytics:        [ 24h ] [ 7d ] [ 30d ]        <-- restored silently
```

Nothing to add. Carlos and Aisha see zero change.

---

### Tier 2 -- Executive Multi-Control (Dashboard, Agent Performance, Quality Monitor)

**Silent restoration plus a ghost-variant button with count badge in the PageHeader actions area.**

#### Dashboard / At a Glance

```
+------------------------------------------------------------------+
| At a Glance                                                      |
| Executive overview of your AI agent program                      |
|                          [Reset filters 2]  [Last 30 days v]    |
+------------------------------------------------------------------+
| [Overview] [Trends] [ROI] [Conversations]                        |
+------------------------------------------------------------------+
```

**Reset button specification:**

```tsx
<Button
  variant="ghost"
  size="sm"
  onClick={handleReset}
  aria-label={`Reset ${nonDefaultCount} filters to defaults`}
  className={clsx(
    'text-xs text-muted hover:text-foreground',
    'border border-default hover:bg-background-muted',
    'transition-default',
  )}
>
  Reset filters
  <span className="ml-1.5 px-1.5 py-0.5 text-xs rounded-full bg-accent-subtle text-accent font-medium">
    {nonDefaultCount}
  </span>
</Button>
```

**Button positioning:** Left of the date range dropdown in the PageHeader actions area. This places it in the same visual zone as other page-level actions.

**Visibility rule:** The button renders ONLY when `nonDefaultCount > 0`. When all controls match defaults, the button is absent. It fades in/out with `animate-fade-in` (200ms).

**Count calculation for Dashboard:**

- `dateRange !== '30d'` = +1
- `activeTab !== 'overview'` = +1
- `conversationFilter !== ''` = +1
- Maximum count: 3

**What clicking Reset does:** Sets `dateRange` to `'30d'`, `activeTab` to `'overview'`, `conversationFilter` to `''`. Persists the default state (clears saved surface state).

#### Agent Performance

```
+------------------------------------------------------------------+
| Agent Performance                                                |
| Monitor agent health and quality                                 |
|                     [Reset filters 3]  [Last 7 days v]          |
+------------------------------------------------------------------+
| [Agent Health Banner]                                            |
+------------------------------------------------------------------+
| [Search agents...] [Critical(2)] [Warning(5)] [All(24)]         |
+------------------------------------------------------------------+
```

**Count calculation:**

- `dateRange !== '7d'` = +1
- `compareEnabled !== false` = +1
- `search !== ''` = +1
- `statusFilter !== 'all'` = +1
- Maximum count: 4

#### Quality Monitor

```
+------------------------------------------------------------------+
| Quality Monitor                                                  |
| System-wide quality dashboard                                    |
|                     [Reset filters 2]  [Last 30 days v]         |
+------------------------------------------------------------------+
```

**Count calculation:**

- `dateRange !== '30d'` = +1
- `dimensionFilter !== 'all'` = +1
- `scoreFilter !== 'all'` = +1
- Maximum count: 3

Reset clears ALL persisted controls for the surface, including the `dimensionFilter` and `scoreFilter` inside the FlaggedConversationsTable. The button is in the header but its scope covers the entire surface.

---

### Tier 3 -- Operator Dense (Analytics Shell + Sessions Explorer + Traces Explorer + Generations)

This is where Design B's badge-button pattern must coexist with the existing "Filters (N)" button and FilterTags.

**Key design decision: the Reset button and the Filters button serve different scopes and must not be confused.**

- "Filters (3)" button: Opens the AdvancedFilterPanel slideout. Its count badge shows the number of advanced filter rows.
- "Reset filters (5)" button: Resets ALL persisted state for this surface to defaults. Its count includes ALL non-default controls (status pills + search + channel + environment + advanced filters).

The two buttons must be visually distinct and spatially separated.

#### Analytics Shell

```
+------------------------------------------------------------------+
| Analytics                                                        |
| Real-time traces, sessions, and LLM performance                 |
|                                                                  |
| [30m][1h][3h][6h][12h][24h][2d][7d][30d][Custom]               |
|                                          [Reset filters 2]      |
+------------------------------------------------------------------+
| [Overview] [LLM] [Sessions Explorer] [Traces Explorer] [Query]  |
+------------------------------------------------------------------+
```

**Shell placement:** Reset button appears below the pill strip, right-aligned, only when shell state differs from defaults. It is visually in the header zone, above the tab bar.

**Reset semantics:** Resets ONLY shell controls (`dateRangeMode`, `quickRange`, `customFrom`, `customTo`, `activeTab`). Does NOT touch sub-tab explorer state.

**Rationale:** The shell and sub-tabs have independent surfaceKeys. An operations lead (Ravi) switching the date range should not lose his Sessions Explorer search and filters. This matches Objective 3 (per-surface independence).

#### Sessions Explorer

```
+------------------------------------------------------------------+
| [All][Active][Completed][Escalated][Failed][Ended]               |
+------------------------------------------------------------------+
| [Search sessions...]  [Channel v] [Env v]                       |
|                    [Reset filters 4]  [Filters(3)]  [Cols] [CSV]|
+------------------------------------------------------------------+
| [FilterTags: Agent contains "billing" | Cost > 0.5 | ...]      |
+------------------------------------------------------------------+
```

**Placement decision:** The Reset button sits in the toolbar row, to the LEFT of the Filters button. This groups reset-related actions together but keeps them in distinct positions.

**Visual distinction:**

- **Reset filters (4):** Ghost variant, `border-default`, muted text, accent badge.
- **Filters (3):** When active: `border-accent text-accent bg-accent-subtle` (existing styling). When inactive: `border-default text-muted`.

The Reset button always uses muted styling (ghost). The Filters button uses accent styling when it has active rows. This visual contrast prevents confusion: one is "clear everything," the other is "manage advanced filters."

**Count calculation for Sessions Explorer:**

- `statusFilter !== 'all'` = +1
- `search !== ''` = +1
- `channelFilter !== ''` = +1
- `environmentFilter !== ''` = +1
- `filters.length` = +N (each advanced filter row counts as 1)
- Example: status=failed + search="billing" + 3 advanced filters = count 5

**What Reset does:** Clears statusFilter, search, channelFilter, environmentFilter, AND all advanced filter rows to []. Persists the cleared state.

**Relationship to FilterTags "Clear all":** FilterTags "Clear all" only clears advanced filter rows. Reset clears everything. If the user clicks FilterTags "Clear all" first, the Reset count decreases but may still show (e.g., count 2 if status and search are still non-default).

#### Traces Explorer

```
+------------------------------------------------------------------+
| [Traces] [Generations]                                           |
+------------------------------------------------------------------+
| [All][LLM][Tool][Decision][Handoff][Error][Agent]               |
+------------------------------------------------------------------+
| [Search traces...]  [Reset filters 3]  [Filters(2)]  [Cols]    |
+------------------------------------------------------------------+
| [FilterTags: Latency > 500ms | Agent = "router" ]              |
+------------------------------------------------------------------+
```

Same pattern. Reset covers the active sub-tab's persisted state only.

**Traces count:** `activeSubTab !== 'traces'` + `typeFilter !== 'all'` + `searchQuery !== ''` + `filterRows.length`.

**When user switches to Generations sub-tab:** The Reset button re-evaluates against Generations' defaults and surfaces. Different count, same button position.

#### Generations

```
+------------------------------------------------------------------+
| [Traces] [Generations]                                           |
+------------------------------------------------------------------+
| [Search generations...]  [Reset filters 2]  [Filters(1)] [Cols]|
+------------------------------------------------------------------+
| [FilterTags: Model contains "gpt-4"]                            |
+------------------------------------------------------------------+
```

**Generations count:** `searchQuery !== ''` + `filterRows.length`.

---

## 3. Reset Semantics -- Full Specification

| Surface           | What "Reset" Clears                                               | Badge Max Count | What It Does NOT Clear                         |
| ----------------- | ----------------------------------------------------------------- | --------------- | ---------------------------------------------- |
| Dashboard         | dateRange, activeTab, conversationFilter                          | 3               | ROI settings, pagination                       |
| Analytics Shell   | dateRangeMode, quickRange, customFrom, customTo, activeTab        | 5               | Sub-tab explorer state                         |
| Sessions Explorer | statusFilter, search, channelFilter, environmentFilter, filters[] | ~15+            | Column config, sort, expanded rows, pagination |
| Traces Explorer   | activeSubTab, typeFilter, searchQuery, filterRows[]               | ~10+            | selectedSessionId, detailView, column config   |
| Generations       | searchQuery, filterRows[]                                         | ~10+            | Column config                                  |
| Agent Performance | dateRange, compareEnabled, search, statusFilter                   | 4               | Sort state, pagination                         |
| Quality Monitor   | dateRange, dimensionFilter, scoreFilter                           | 3               | Expanded cards, pagination                     |

---

## 4. Project-Switch Transition

**Identical to Design A.** Synchronous localStorage read before first render. No flash. Data loading skeletons are normal.

**Additional Detail for Design B:** The Reset button's count re-evaluates on project switch. If the new project has no saved state, the button is absent (all defaults). If the new project has saved state, the button appears with the appropriate count.

**Screen reader:** No announcement for filter restoration on project switch. The project picker announces the new project name. Filter values are discoverable through normal tab-through of controls.

---

## 5. Graceful Degradation

**Identical to Design A.** Per-control fallback.

**Additional consideration for count badge:** If a saved `channelFilter` value is invalid and falls back to default, it does NOT contribute to the non-default count. The count always reflects the actual current state vs. defaults, not the saved state vs. defaults.

---

## 6. Accessibility Specification

**Reset button:**

- Element: `<button>` (native button, not styled anchor).
- `aria-label="Reset {count} filters to defaults"` (dynamic count).
- Focus: Receives focus in normal tab order within the toolbar/header row.
- When clicked: `aria-live="polite"` region announces "Filters reset to defaults."

**Count badge:**

- The badge text is part of the button's accessible name via `aria-label` (not just visual).
- Screen reader: "Reset 3 filters to defaults" (the number is in the label, not just the badge).

**Distinction from Filters button:**

- Filters button: `aria-label="Open filters panel, {count} active"`.
- Reset button: `aria-label="Reset {count} filters to defaults"`.
- A screen reader user encountering both in sequence hears: "Reset 4 filters to defaults, button" then "Open filters panel, 3 active, button" -- clearly different actions.

---

## 7. Micro-copy Reference

| Element              | Copy                                           | Styling                                                                              |
| -------------------- | ---------------------------------------------- | ------------------------------------------------------------------------------------ |
| Reset button label   | `Reset filters`                                | `text-xs text-muted` inside ghost Button                                             |
| Reset count badge    | `{count}`                                      | `ml-1.5 px-1.5 py-0.5 text-xs rounded-full bg-accent-subtle text-accent font-medium` |
| Reset aria-label     | `Reset {count} filters to defaults`            | Dynamic                                                                              |
| Live region on reset | `Filters reset to defaults`                    | `aria-live="polite"`, clears after 3s                                                |
| Reset tooltip        | None needed (button label is self-explanatory) | --                                                                                   |

---

## 8. Component-Level Mapping

| Existing Component                     | Change Required                                    |
| -------------------------------------- | -------------------------------------------------- |
| `PageHeader`                           | Add optional `resetAction` slot in actions area    |
| `AdvancedFilterPanel`                  | No change                                          |
| `FilterTags`                           | No change                                          |
| `Tabs`                                 | No change                                          |
| `Button`                               | No change (ghost variant already exists)           |
| New: `usePersistedSurfaceFilters` hook | Hydrate/validate/persist/reset + `nonDefaultCount` |
| New: `ResetFiltersButton`              | Ghost button with dynamic count badge              |

---

## 9. Self-Review

### Objective Scorecard

| #   | Objective                  | Score (1-5) | Notes                                                                                       |
| --- | -------------------------- | ----------- | ------------------------------------------------------------------------------------------- |
| 1   | Invisible restoration      | 5           | Controls pre-filled, badge only shows for non-defaults                                      |
| 2   | Instant feel               | 5           | Sync localStorage read                                                                      |
| 3   | Per-surface independence   | 5           | Independent surfaceKeys, shell vs sub-tab separation                                        |
| 4   | Per-project isolation      | 5           | byProject nesting                                                                           |
| 5   | Obvious escape hatch       | 5           | Badge-annotated button is clearly a button with purpose                                     |
| 6   | Graceful degradation       | 5           | Per-control fallback, count reflects actual state                                           |
| 7   | Density-appropriate        | 4           | Tier 2 is clean. Tier 3 has two badge-bearing buttons (Reset + Filters) which could confuse |
| 8   | Accessibility              | 5           | Dynamic aria-label with count, distinct from Filters button                                 |
| 9   | No cross-surface confusion | 5           | Surface-scoped                                                                              |
| 10  | Zero learning curve        | 4           | The count badge adds a new concept ("non-default count") that doesn't exist today           |
| 11  | Density-tier fidelity      | 5           | Tier 1 has zero new UI                                                                      |

### Known Weakness

**Tier 3 badge collision (Objective 7, scored 4/5):** Sessions Explorer will have TWO badge-bearing buttons in the toolbar: "Reset filters (5)" and "Filters (3)". The numbers mean different things (total non-default vs. advanced rows). Users might confuse them. Mitigation: spatial separation (Reset left, Filters right) and different visual treatments (ghost muted vs. accent when active).

**New concept introduction (Objective 10, scored 4/5):** The count badge is meaningful but introduces a "how many filters are active" concept that doesn't exist today. Maya (low-medium tech) might not immediately understand what "3" means. However, the button text "Reset filters" is self-explanatory even without understanding the count.

---

## 10. Review Status

Self-review complete. 1 MEDIUM gap: Tier 3 dual-badge potential confusion. No CRITICAL gaps.

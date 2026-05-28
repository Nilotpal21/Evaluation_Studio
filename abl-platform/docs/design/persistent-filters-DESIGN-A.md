# Persistent Insights & Analytics Filters -- Design A: Ghost Defaults

**Date:** 2026-04-22
**Pattern:** Controls-only restore with inline text-link reset
**Philosophy:** The page remembers like muscle memory -- it does not talk about it. Restored values live inside existing controls with zero new visual elements beyond a quiet text-link that appears only when something differs from defaults.

---

## 1. Core Principle

Persistence is invisible. There is no UI for persistence -- there is only the absence of the annoyance of having to re-enter filters. The controls themselves ARE the restored-state indicator. The only new visual element is a small, muted text link ("Reset filters") that appears conditionally on multi-filter surfaces.

---

## 2. Density Tier Specifications

### Tier 1 -- Single Control (Billing, Customer Insights, Voice Analytics)

**Zero new UI.** The date range control is silently initialized from the saved preference instead of from the hardcoded default.

**Billing & Usage:**
The `dateRange` state initializes from `preferences.byProject[projectId].billingUsage.dateRange` instead of the hardcoded `'7d'`. If the saved value is invalid or missing, `'7d'` remains the default. No Reset action. No visual change whatsoever.

```
+----------------------------------------------------------+
| Billing & Usage                                          |
| Usage overview for [Project Name]                        |
|                                                          |
|   [ 7d ]  [ 30d ]  [ 90d ]    <-- restored silently     |
|                                                          |
|   (existing BillingUsageReportPanel unchanged)           |
+----------------------------------------------------------+
```

**Customer Insights:**
Identical pattern. `dateRange` initializes from saved preference. Dropdown in PageHeader actions slot shows the restored value. Zero new UI.

**Voice Analytics:**
Identical pattern. Pill strip initializes with restored `dateRange`. Zero new UI.

**Screen reader behavior:** Unchanged. The date control announces its current value as it always does. No additional announcement about restoration.

---

### Tier 2 -- Executive Multi-Control (Dashboard, Agent Performance, Quality Monitor)

**Silent restoration of all controls.** Plus: a single inline text-link "Reset filters" that appears to the right of the date range control (in the PageHeader actions area) ONLY when at least one persisted control differs from its surface default.

#### Dashboard / At a Glance

**Layout (annotated):**

```
+------------------------------------------------------------------+
| At a Glance                                                      |
| Executive overview of your AI agent program                      |
|                                       [Last 30 days v] Reset     |
+------------------------------------------------------------------+
| [Overview] [Trends] [ROI] [Conversations]                        |
|              ^-- restored tab                                    |
+------------------------------------------------------------------+
| (KPI cards, charts, etc.)                                        |
+------------------------------------------------------------------+
```

**Behavior details:**

- `dateRange`, `activeTab`, and `conversationFilter` all initialize from preferences.
- The "Reset" text-link appears in `text-xs text-muted hover:text-foreground` styling, positioned after the date range dropdown in the PageHeader actions area, separated by a `gap-2`.
- "Reset" appears ONLY when: `dateRange !== '30d'` OR `activeTab !== 'overview'` OR `conversationFilter !== ''`.
- Clicking "Reset" sets all three to defaults (`'30d'`, `'overview'`, `''`) and persists the defaults (clearing the saved state for this surface).
- "Reset" animates in with `animate-fade-in` (200ms) and out on the same timing.

**Exact copy:**

- Reset link text: `Reset`
- Tooltip (on hover): `Reset all filters to defaults`
- aria-label: `Reset all filters to defaults`

**Screen reader announcement:** When Reset is clicked, the page controls update. The live region should announce: "Filters reset to defaults." (via an `aria-live="polite"` region that receives the text on reset, then clears after 3 seconds.)

#### Agent Performance

```
+------------------------------------------------------------------+
| Agent Performance                                                |
| Monitor agent health and quality                                 |
|                                       [Last 7 days v] Reset     |
+------------------------------------------------------------------+
| [Agent Health Banner]                                            |
+------------------------------------------------------------------+
| [Search agents...] [Critical(2)] [Warning(5)] [All(24)]         |
+------------------------------------------------------------------+
```

- `dateRange`, `compareEnabled`, `search`, and `statusFilter` all restore from preferences.
- "Reset" appears when any of: `dateRange !== '7d'` OR `compareEnabled !== false` OR `search !== ''` OR `statusFilter !== 'all'`.
- Same PageHeader actions positioning as Dashboard.

#### Quality Monitor

```
+------------------------------------------------------------------+
| Quality Monitor                                                  |
| System-wide quality dashboard                                    |
|                                       [Last 30 days v] Reset    |
+------------------------------------------------------------------+
| [Quality Health Banner]                                          |
+------------------------------------------------------------------+
| [KPI Cards] [Quality Trend Chart] [Dimension Cards]             |
+------------------------------------------------------------------+
| Flagged Conversations                                            |
|   [Filter icon] [All Reasons v] [All Scores v]                  |
+------------------------------------------------------------------+
```

- `dateRange` restores in PageHeader. `dimensionFilter` and `scoreFilter` restore inside the FlaggedConversationsTable.
- "Reset" in PageHeader resets `dateRange` to `'30d'`, and also resets `dimensionFilter` to `'all'` and `scoreFilter` to `'all'`.
- This means Reset covers ALL persisted controls for the surface, not just the header-level ones.

---

### Tier 3 -- Operator Dense (Analytics Shell + Sessions Explorer + Traces Explorer + Generations)

This is the critical tier. The existing toolbar is already dense with status pills, SearchInput, channel/environment selects, a "Filters (N)" button, and FilterTags pills. Design A's approach: keep the text-link pattern but position it precisely to avoid collision.

#### Analytics Shell

```
+------------------------------------------------------------------+
| Analytics                                                        |
| Real-time traces, sessions, and LLM performance                 |
|                                                                  |
|   [30m][1h][3h][6h][12h][24h][2d][7d][30d][Custom]  Reset      |
+------------------------------------------------------------------+
| [Overview] [LLM] [Sessions Explorer] [Traces Explorer] [Query]  |
+------------------------------------------------------------------+
```

- Shell state (`dateRange`, `activeTab`, custom range values) restores from `analyticsPage` surface.
- "Reset" text-link appears after the pill strip, right-aligned, only when shell state differs from defaults.
- **Reset semantics for the shell:** Resets ONLY the shell controls: `dateRangeMode` back to `'quick'`, `quickRange` back to `'30m'`, `customFrom`/`customTo` cleared, `activeTab` back to `'overview'`. Does NOT touch the active sub-tab's own persisted state. Rationale: The shell and sub-tabs have independent surfaceKeys. Ravi may want to reset the date range but keep his Sessions Explorer filters. Coupling them would violate per-surface independence (Objective 3).

#### Sessions Explorer (sub-tab of Analytics)

```
+------------------------------------------------------------------+
| [All][Active][Completed][Escalated][Failed][Ended]  Reset       |
+------------------------------------------------------------------+
| [Search sessions...]  [Channel v] [Env v] [Filters(3)] [Cols]  |
+------------------------------------------------------------------+
| [FilterTags: Agent contains "billing" | Cost > 0.5 | ...]      |
+------------------------------------------------------------------+
| (Sessions table)                                                 |
+------------------------------------------------------------------+
```

- All persisted state (`statusFilter`, `search`, `channelFilter`, `environmentFilter`, `filters`) restores from `analyticsSessions` surface.
- "Reset" text-link appears at the end of the status pill strip row, right-aligned.
- "Reset" resets ALL persisted Sessions Explorer state: `statusFilter` to `'all'`, `search` to `''`, `channelFilter` to `''`, `environmentFilter` to `''`, `filters` to `[]`.
- The existing "Filters (3)" button and FilterTags continue to work as they do today -- they manage advanced filter rows. Reset clears EVERYTHING including those advanced rows.
- **No collision with FilterTags "Clear all":** FilterTags already has its own "Clear all" link that only clears advanced filter rows. "Reset" in the status-pill row clears everything. They serve different scopes. FilterTags "Clear all" is a subset of "Reset."

**Visibility rule:** "Reset" appears when ANY of: `statusFilter !== 'all'` OR `search !== ''` OR `channelFilter !== ''` OR `environmentFilter !== ''` OR `filters.length > 0`.

#### Traces Explorer

```
+------------------------------------------------------------------+
| [Traces] [Generations]                               Reset      |
+------------------------------------------------------------------+
| [All][LLM][Tool][Decision][Handoff][Error][Agent]               |
+------------------------------------------------------------------+
| [Search traces...]  [Filters(2)]  [Columns]                     |
+------------------------------------------------------------------+
| [FilterTags: Latency > 500ms | Agent = "router" ]              |
+------------------------------------------------------------------+
```

- Traces sub-tab state (`activeSubTab`, `typeFilter`, `searchQuery`, `filterRows`) restores from `analyticsTraces`.
- "Reset" at the end of the sub-tab row, right-aligned.
- Resets only Traces-surface state. Does not touch Generations.

#### Generations

```
+------------------------------------------------------------------+
| [Traces] [Generations]                               Reset      |
+------------------------------------------------------------------+
| [Search generations...]  [Filters(1)]  [Columns]               |
+------------------------------------------------------------------+
| [FilterTags: Model contains "gpt-4"]                            |
+------------------------------------------------------------------+
```

- Generations state (`searchQuery`, `filterRows`) restores from `analyticsGenerations`.
- "Reset" at the sub-tab row, right-aligned.
- Resets only Generations state.

**Key Tier 3 decision: Traces and Generations share a sub-tab switcher. The Reset link in their shared sub-tab row resets the CURRENTLY ACTIVE sub-tab's state, not the other one.** Visual cue: when the user switches from Traces to Generations, Reset visibility re-evaluates against Generations' defaults.

---

## 3. Reset Semantics -- Full Specification

| Surface           | What "Reset" Clears                                               | What It Does NOT Clear                               |
| ----------------- | ----------------------------------------------------------------- | ---------------------------------------------------- |
| Dashboard         | dateRange, activeTab, conversationFilter                          | ROI settings (local-only), pagination                |
| Analytics Shell   | dateRangeMode, quickRange, customFrom, customTo, activeTab        | Sub-tab explorer state                               |
| Sessions Explorer | statusFilter, search, channelFilter, environmentFilter, filters[] | Column config, sort state, expanded rows, pagination |
| Traces Explorer   | activeSubTab, typeFilter, searchQuery, filterRows[]               | selectedSessionId, detailView, column config         |
| Generations       | searchQuery, filterRows[]                                         | Column config                                        |
| Agent Performance | dateRange, compareEnabled, search, statusFilter                   | Sort state, pagination                               |
| Quality Monitor   | dateRange, dimensionFilter, scoreFilter                           | Expanded dimension cards, pagination                 |

---

## 4. Project-Switch Transition

**Mechanism:** When the user selects a different project in the project picker:

1. The navigation store updates `projectId`.
2. Every mounted Insights/Analytics component re-runs its `usePersistedSurfaceFilters` hook, which:
   a. Synchronously reads the local preference cache for the new `projectId`.
   b. If a cached entry exists for this project+surface, control state is set from it **before the first render of the new project's data**.
   c. If no cached entry exists, controls initialize to surface defaults.
3. Data fetching hooks (e.g., `useAtAGlance(dateRange)`) receive the new values and begin fetching.

**Visual behavior:**

- **No default-then-restored flash.** The local cache read is synchronous (Zustand persist uses localStorage which is sync). Controls render with the correct values on first paint.
- **Data loading is normal.** Charts and tables show loading skeletons while data fetches complete -- this is identical to today's behavior when navigating to a new project. The difference is that the controls are pre-filled with remembered values instead of defaults.
- **No special transition animation.** The project switch already triggers a re-render with loading skeletons for data. Filter controls simply render with the restored (or default) values.

**Screen reader announcement:** The project picker already announces the selected project name. No additional announcement is needed for filter restoration -- the controls announce their values through their existing aria attributes when the user tabs to them.

**Edge case -- first visit to a project:** Controls show surface defaults. This is indistinguishable from today's behavior. The user interacts normally, and preferences begin persisting.

---

## 5. Graceful Degradation

**Per-control fallback, not per-surface:**

| Scenario                                                     | Behavior                                                                            |
| ------------------------------------------------------------ | ----------------------------------------------------------------------------------- |
| Saved `channelFilter: "slack"` but Slack no longer available | `channelFilter` falls back to `''` (All). Other controls retain their saved values. |
| Saved `dateRange: "90d"` but surface only supports 7d/30d    | `dateRange` falls back to surface default.                                          |
| Saved `customFrom > customTo`                                | Both custom values cleared, `showCustomRange` set to `false`, quick range restored. |
| Saved `filterRows` with unknown column key                   | That specific row is dropped. Other rows retained.                                  |
| Saved `activeTab: "nonexistent"`                             | `activeTab` falls back to first tab.                                                |
| Entire preference payload is malformed JSON                  | Entire surface falls back to defaults. Log warning.                                 |
| Server preference GET fails                                  | Local cache is used. If local cache is also corrupt, fall to defaults.              |
| Server preference PATCH fails                                | Local state continues working. Next successful PATCH heals the record.              |

---

## 6. Accessibility Specification

**Reset link:**

- Element: `<button>` (not `<a>`) for keyboard activation.
- `aria-label="Reset all filters to defaults"`
- Receives focus in normal tab order after the last control in the header/toolbar row.
- When clicked, an `aria-live="polite"` region announces: "Filters reset to defaults."

**Restored controls:**

- No change to existing aria attributes. Each control (select, button, input) already announces its value.
- A screen reader user tabbing through the controls will hear the restored values through normal control announcements.

**No `aria-label` modifications for restored state.** The values ARE the communication. Adding "restored" to aria labels would violate Objective 10 (zero learning curve) by introducing a concept the user doesn't need.

---

## 7. Micro-copy Reference

| Element                | Copy                            | Styling                                                                      |
| ---------------------- | ------------------------------- | ---------------------------------------------------------------------------- |
| Reset text-link        | `Reset`                         | `text-xs text-muted hover:text-foreground cursor-pointer transition-default` |
| Reset tooltip          | `Reset all filters to defaults` | Standard tooltip                                                             |
| Reset aria-label       | `Reset all filters to defaults` | On `<button>` element                                                        |
| Live region on reset   | `Filters reset to defaults`     | `aria-live="polite"`, clears after 3s                                        |
| No empty states needed | --                              | Persistence doesn't create new empty states                                  |

---

## 8. Component-Level Mapping

| Existing Component                     | Change Required                                     |
| -------------------------------------- | --------------------------------------------------- |
| `PageHeader`                           | Add optional `resetAction` slot in actions area     |
| `AdvancedFilterPanel`                  | No change (FilterTags "Clear all" stays as-is)      |
| `FilterTags`                           | No change                                           |
| `Tabs`                                 | No change (restored tab is just the initial value)  |
| `DropdownMenu`                         | No change                                           |
| `SearchInput`                          | No change (initial value prop already supported)    |
| `Select`                               | No change                                           |
| New: `usePersistedSurfaceFilters` hook | Provides hydrate/validate/persist/reset per surface |
| New: `ResetFiltersLink`                | Tiny component: conditional text-link with aria     |

---

## 9. Self-Review

### Objective Scorecard

| #   | Objective                  | Score (1-5) | Notes                                                                             |
| --- | -------------------------- | ----------- | --------------------------------------------------------------------------------- |
| 1   | Invisible restoration      | 5           | Controls pre-filled, nothing else visible                                         |
| 2   | Instant feel               | 5           | Sync localStorage read, no async dependency for initial render                    |
| 3   | Per-surface independence   | 5           | Each surface has its own surfaceKey                                               |
| 4   | Per-project isolation      | 5           | byProject[projectId] nesting                                                      |
| 5   | Obvious escape hatch       | 3           | Text-link is subtle -- might not be discovered easily                             |
| 6   | Graceful degradation       | 5           | Per-control fallback specified                                                    |
| 7   | Density-appropriate        | 5           | Single text-link adds near-zero visual weight                                     |
| 8   | Accessibility              | 4           | Functional but Reset link discoverability for keyboard users depends on tab order |
| 9   | No cross-surface confusion | 5           | Controls are surface-owned                                                        |
| 10  | Zero learning curve        | 5           | Nothing new to learn                                                              |
| 11  | Density-tier fidelity      | 5           | Tier 1 has zero new UI                                                            |

### Known Weakness

The primary weakness of Design A is **Reset discoverability (Objective 5, scored 3/5)**. A muted text-link can be overlooked, especially by Priya (medium tech) who explicitly wants "a simple Reset filters action." The text link is quiet by design, but perhaps too quiet. This is the fundamental trade-off of the Ghost Defaults pattern: maximum invisibility means the escape hatch is also quieter.

---

## 10. Review Status

Self-review complete. 1 MEDIUM gap: Reset link discoverability. No CRITICAL gaps.

# Studio UI/UX Fix Plan

**Date:** 2026-04-25 (updated with Phase D + Phase E themes)
**Based on:** `docs/audits/2026-04-25-studio-ui-ux-audit-findings.md` (Phases A-E)
**Constraint:** Each PR must touch 40 files max, 3 packages max, feature commits must be additive.

---

## Theme 1: Inconsistent Time/Date Range Picker (4 variants across 8 surfaces)

**Severity:** P1 (should-fix)
**Effort:** M (3-5 days)
**Affected surfaces:** Dashboard, Analytics, Billing, Voice Analytics, Quality Monitor, Customer Insights, Agent Performance, Sessions

### Problem

Four distinct time-range picker controls exist across the Insights group (Phase E found a FIFTH):

1. `DropdownMenu` with "7d / 30d / 90d" and calendar icon (Dashboard, QM, Customer Insights)
2. `SegmentedControl` with 10 options "30m...30d + Custom" (Analytics)
3. Inline pill buttons "7 days / 30 days / 90 days" (Billing)
4. `SegmentedControl` with 3 options "24h / 7d / 30d" (Voice Analytics)
5. Missing entirely (Agent Performance)
6. **NEW (Phase E):** `DropdownMenu` with 7 options "Last 24h / 48h / This week / 7 days / This month / 30 days / All time" (Sessions) -- different option set from all others

This creates cognitive load when switching between Insights sub-pages.

### Recommended approach

1. Create a shared `<InsightsDateRangeControl>` component that standardizes the control.
2. Use the `DropdownMenu` pattern (Calendar icon + text + chevron) as the standard for "day-level" ranges (7d/30d/90d).
3. For surfaces that need sub-day granularity (Analytics), use SegmentedControl but with a consistent style that visually "belongs" to the same family.
4. Add the control to Agent Performance (currently missing).

### Affected files

- `apps/studio/src/components/insights/AtAGlancePage.tsx` (date range section, ~line 620-640)
- `apps/studio/src/components/insights/InsightsDashboardPage.tsx` (date range section, ~line 80-120)
- `apps/studio/src/components/insights/QualityMonitorPage.tsx` (date range section, ~line 550-560)
- `apps/studio/src/components/insights/CustomerInsightsPage.tsx` (date range section, ~line 460-470)
- `apps/studio/src/components/insights/AgentPerformancePage.tsx` (add date range control)
- `apps/studio/src/components/insights/VoiceAnalyticsPage.tsx` (replace SegmentedControl with standard)
- `apps/studio/src/components/billing/BillingUsagePage.tsx` (replace inline pills)
- NEW: `apps/studio/src/components/insights/shared/InsightsDateRangeControl.tsx`

### PR sequencing

- **PR 1:** Create `InsightsDateRangeControl` shared component + refactor Dashboard and Quality Monitor to use it (these already use the Dropdown pattern -- minimal visual change). ~8 files, 1 package.
- **PR 2:** Refactor Customer Insights, Agent Performance, Voice Analytics, and Billing to use the shared component. ~6 files, 1 package.

### Acceptance criteria

- All Insights sub-pages use the same date range control component.
- Visual appearance is identical across surfaces for the same range set.
- Analytics retains sub-day options but through the shared component with a `granularity` prop.
- Agent Performance has a working date range picker.

### Risk of regression

LOW -- primarily refactoring local component state into a shared component. Filter persistence hooks already exist via `usePersistedSurfaceFilters`.

---

## Theme 2: Inconsistent Zero/Empty Value Display Across KPI Cards

**Severity:** P1 (should-fix)
**Effort:** S (1-2 days)
**Affected surfaces:** Overview, Dashboard, Quality Monitor, Voice Analytics, Customer Insights

### Problem

Zero/empty values are displayed inconsistently:

- "0" (numeric zero)
- "--" (em-dash placeholder)
- "N/A" (not available)
- "0.0%" (zero percent)
- "$0" (zero dollars)
- "0 / 1" (fraction)

This makes it impossible for users to distinguish "no data" from "value is zero."

### Recommended approach

1. Establish a convention in the `InsightKPICard` or `MetricCard` component:
   - **Value is zero:** Display "0", "0%", "$0" (with unit).
   - **No data available:** Display "--" (consistent em-dash, no unit).
   - **Not applicable:** Display "N/A" (no unit).
2. Update all KPI card usages to pass a `status: 'value' | 'no-data' | 'na'` prop.
3. Remove the "N/A ms" and "N/A %" patterns from Voice Analytics.

### Affected files

- `apps/studio/src/components/insights/shared/InsightKPICard.tsx` (add status prop)
- `apps/studio/src/components/insights/AtAGlancePage.tsx` (KPI rendering)
- `apps/studio/src/components/insights/QualityMonitorPage.tsx` (KPI rendering)
- `apps/studio/src/components/insights/CustomerInsightsPage.tsx` (KPI rendering)
- `apps/studio/src/components/insights/VoiceAnalyticsPage.tsx` (KPI rendering, fix "N/A ms")
- `apps/studio/src/components/overview/ProjectOverview.tsx` (KPI cards)

### PR sequencing

- **PR 3:** Single PR: update `InsightKPICard` + all consumers. ~8 files, 1 package.

### Acceptance criteria

- All KPI cards use consistent display format for zero vs no-data vs N/A.
- Units are hidden when value is N/A or no-data.
- Overview KPIs show "0" for numeric zero, "--" for missing data.

### Risk of regression

LOW -- cosmetic change to display strings, no backend changes.

---

## Theme 3: Error/Degraded State Display Inconsistency

**Severity:** P1 (should-fix)
**Effort:** S (1-2 days)
**Affected surfaces:** Dashboard, Quality Monitor, Customer Insights, Voice Analytics, Deployments, Knowledge Bases

### Problem

Three different patterns for displaying error/degraded states:

1. Full-width inline pink banner (Insights pages)
2. Bottom-right toast (Deployments)
3. Centered empty state with error icon (Knowledge Bases)

Also, error message tone varies:

- "Failed to load some analytics data. Showing available metrics." (reassuring)
- "Failed to load voice analytics data. Please try again later." (unhelpful)
- "R: Request failed (non-JSON response)" (internal leak)

### Recommended approach

1. Standardize on the inline banner pattern for degraded-but-functional states.
2. Use toast for transient errors (failed action, timeout).
3. Use centered error empty-state for complete failures (service unreachable).
4. Create a shared `<DegradedStateBanner>` component.
5. Sanitize Knowledge Bases error to hide "non-JSON response" detail.
6. Standardize error copy to: "Some data couldn't be loaded. Showing available [metrics/information]."

### Affected files

- NEW: `apps/studio/src/components/shared/DegradedStateBanner.tsx`
- `apps/studio/src/components/insights/VoiceAnalyticsPage.tsx` (error message fix)
- `apps/studio/src/components/search-ai/KnowledgeBasesPage.tsx` (error message sanitization)
- `apps/studio/src/components/deployments/DeploymentsPage.tsx` (error pattern)

### PR sequencing

- **PR 4:** Create `DegradedStateBanner` + fix Voice Analytics and Knowledge Bases error messages. ~5 files, 1 package.

### Acceptance criteria

- All degraded states use the same banner component.
- Error messages never expose internal implementation details.
- Error copy follows consistent tone.

### Risk of regression

LOW -- UI-only changes. Error state logic unchanged.

---

## Theme 4: Hardcoded Tailwind Palette Colors (14 violations)

**Severity:** P2 (polish)
**Effort:** S (1 day)
**Affected files:** 5 component files

### Problem

14 instances of hardcoded Tailwind palette colors (`bg-red-500`, `text-yellow-300`, etc.) that bypass the design-token system. These will not respond to theme changes and violate the `@agent-platform/design-tokens` mandate.

### Recommended approach

1. Replace each hardcoded color with the appropriate semantic token:
   - `text-yellow-300/400` in SourceViewer -> `text-warning` or theme-aware syntax colors
   - `bg-red-500` -> `bg-error`
   - `bg-blue-500` -> `bg-info`
   - `bg-green-500` -> `bg-success`
   - `text-purple-500` -> `text-purple`
   - `bg-indigo-500` -> `bg-accent-subtle` or `bg-purple-subtle`
2. For SourceViewer (syntax highlighting), consider using a dedicated syntax color token set or keeping these as intentional exceptions for code display.

### Affected files

- `apps/studio/src/components/abl/SourceViewer.tsx` (5 instances, lines 125, 157, 165, 173, 181)
- `apps/studio/src/components/search-ai/QueryPlaygroundTab.tsx` (4 instances, lines 63-66)
- `apps/studio/src/components/workflows/canvas/panels/ExecutionDebugPanel.tsx` (3 instances, lines 58-62, 227)
- `apps/studio/src/components/admin/MembersPage.tsx` (1 instance, line 731)
- `apps/studio/src/components/arch-shared/ArchGradientMark.tsx` (1 instance, line 40)

### PR sequencing

- **PR 5:** Single PR replacing all 14 instances. ~5 files, 1 package.

### Acceptance criteria

- Zero hardcoded Tailwind palette colors in Studio components (excluding test files).
- Existing `design-token-lint.sh` hook passes cleanly.
- Visual appearance is unchanged or improved.

### Risk of regression

LOW -- color mapping only. Test visually.

---

## Theme 5: Missing/Stub Pages

**Severity:** P1 (should-fix)
**Effort:** M (2-3 days)
**Affected surfaces:** Org Settings, Connections page title

### Problem

1. **Org Settings** (`/settings/organization`) is a stub page showing only "Settings / User settings." with no sidebar, navigation, or content. It's reachable from the top-right gear icon.
2. **Connections** page is missing its page title -- "29 available" appears where a title should be.

### Recommended approach

1. **Org Settings:** Build out a proper settings page using the existing Settings page pattern (sidebar with sections, tabbed content). At minimum, should show: profile info, theme toggle, notification preferences. If no org-level settings are ready, replace with a proper "User Settings" page that at minimum includes display name, email, theme, and notification preferences.
2. **Connections:** Add a page title "Integrations" (matching sidebar label) with standard `<PageHeader>` component above the tabs.

### Affected files

- `apps/studio/src/app/settings/organization/page.tsx` (rewrite)
- `apps/studio/src/components/settings/OrgSettingsPage.tsx` (new or existing)
- `apps/studio/src/components/connections/ConnectionsPage.tsx` (add PageHeader)

### PR sequencing

- **PR 6:** Fix Connections page title. ~2 files, 1 package.
- **PR 7:** Build proper Org Settings page. ~3-5 files, 1 package.

### Acceptance criteria

- Connections page has a title "Integrations" matching its sidebar label.
- Org Settings is a functional page with proper navigation structure.
- Both pages pass the 9-dimension rubric at score 3+.

### Risk of regression

LOW for Connections (additive). MEDIUM for Org Settings (new page structure).

---

## Theme 6: KPI Card Label Density at 1280px Viewport

**Severity:** P2 (polish)
**Effort:** S (1 day)
**Affected surfaces:** Dashboard, Quality Monitor, Voice Analytics (any surface with 5-6 KPI cards in a row)

### Problem

At 1280px laptop viewport, 6 KPI cards in a row cause label wrapping. Labels like "CONTAINMENT RATE" and "ESCALATION RATE" wrap to 2 lines in ALL-CAPS at 12px, creating uneven card heights and reducing scannability.

### Recommended approach

1. Add a responsive breakpoint: at < 1400px, switch from 6-column to 3x2 grid for KPI rows with 6 cards.
2. Alternatively, remove ALL-CAPS from KPI labels (use Title Case) to reduce character width.
3. Consider increasing min-card-width from ~180px to ~200px.

### Affected files

- `apps/studio/src/components/insights/AtAGlancePage.tsx` (KPI grid layout)
- `apps/studio/src/components/insights/QualityMonitorPage.tsx` (KPI grid layout)
- `apps/studio/src/components/insights/VoiceAnalyticsPage.tsx` (KPI grid layout)
- `apps/studio/src/components/insights/shared/InsightKPICard.tsx` (responsive container)

### PR sequencing

- **PR 8:** Add responsive breakpoint to KPI card grids. ~4 files, 1 package.

### Acceptance criteria

- At 1280px, no KPI label wraps to 2 lines.
- At 1440px and above, layout is unchanged.
- Card heights are uniform within each row.

### Risk of regression

LOW -- CSS-only change with responsive breakpoint.

---

## Theme 7: Chat Session List UX Issues

**Severity:** P2 (polish)
**Effort:** S (1-2 days)
**Affected surfaces:** Agent Chat

### Problem

1. Session IDs shown as raw short UUIDs ("d45bc2b7") -- meaningless to users.
2. "1 msgs" grammatical error.
3. Session list panel is fixed-width (270px), doesn't respond to viewport.
4. "Agent Reasoning 0 tools" metadata in header looks like tabs but isn't interactive.

### Recommended approach

1. Show session timestamp as primary identifier ("Today 11:10 AM") with agent name as secondary.
2. Fix "1 msgs" -> "1 msg" (singular/plural).
3. Make session panel width responsive: 220px at 1280, 270px at 1440, 300px at 1920.
4. Restyle "Agent Reasoning 0 tools" as plain metadata text, not pseudo-tab elements.

### Affected files

- `apps/studio/src/components/chat/SessionList.tsx` (display format)
- `apps/studio/src/components/chat/ChatHeader.tsx` (metadata styling)
- `apps/studio/src/components/chat/ChatLayout.tsx` (panel width)

### PR sequencing

- **PR 9:** Fix session display, grammar, metadata styling. ~4 files, 1 package.

### Acceptance criteria

- Sessions show human-readable timestamps as primary identifier.
- No grammatical errors in message counts.
- Panel width responds to viewport.
- Header metadata is visually distinct from navigation elements.

### Risk of regression

LOW -- display-only changes.

---

## Theme 8: Agent Editor Toolbar and "Flow" Badge Color

**Severity:** P2 (polish)
**Effort:** S (1 day)
**Affected surfaces:** Agent Editor

### Problem

1. "Flow" badge in agent editor header uses a purple/magenta color not clearly mapped to a design token.
2. Toolbar has 5 buttons with 4 different visual styles (outline, ghost, red text, ghost-with-icon).
3. "AI Assist" button lacks visual prominence despite being a key feature.
4. LIMITATIONS helper text at 90+ characters per line exceeds 75ch target.

### Recommended approach

1. Map "Flow" badge to `text-info` / `bg-info-subtle` (or `text-purple` / `bg-purple-subtle` if it's an AI/automation concept).
2. Standardize toolbar to use consistent button variants: primary (Save), ghost (all others), destructive (Delete).
3. Make "AI Assist" more prominent -- add `bg-accent-subtle` background or a sparkle animation.
4. Add `max-w-prose` (~65ch) to helper text paragraphs.

### Affected files

- `apps/studio/src/components/agent-editor/AgentEditorHeader.tsx` (toolbar buttons, badge)
- `apps/studio/src/components/agent-editor/sections/GoalPersonaSection.tsx` (helper text width)

### PR sequencing

- **PR 10:** Single PR for all agent editor polish. ~3 files, 1 package.

### Acceptance criteria

- "Flow" badge uses a design-token semantic color.
- Toolbar buttons use at most 2 visual styles (ghost + primary).
- "AI Assist" has visual prominence.
- No text line exceeds 75ch.

### Risk of regression

LOW -- visual-only changes.

---

## Theme 9: Deployment Environment Card Colors

**Severity:** P2 (polish)
**Effort:** S (0.5 days)
**Affected surfaces:** Deployments

### Problem

Environment cards (Development, Staging, Production) use what appear to be custom pastel background colors (light cyan, light yellow, light green) that don't map to the design-token `--{intent}-subtle` values.

### Recommended approach

1. Map environment background colors to semantic tokens:
   - Development -> `bg-info-subtle` (cyan subtle)
   - Staging -> `bg-warning-subtle` (amber subtle)
   - Production -> `bg-success-subtle` (green subtle)
2. Verify contrast of text on these backgrounds.

### Affected files

- `apps/studio/src/components/deployments/EnvironmentCard.tsx` (or equivalent)

### PR sequencing

- **PR 11:** Single PR. ~2 files, 1 package.

### Acceptance criteria

- All environment card backgrounds use design-token `*-subtle` values.
- Text passes WCAG AA contrast on all backgrounds.
- Visual appearance is similar to current (same semantic meaning, just token-backed).

### Risk of regression

LOW -- color token swap.

---

## Theme 10: Evaluations Step Descriptions Double Em-Dash

**Severity:** P2 (polish)
**Effort:** S (0.5 days)
**Affected surfaces:** Evaluations

### Problem

Step descriptions show "Create Personas -- -- simulated users" with double em-dashes that appear to be rendering artifacts.

### Recommended approach

Check the data source for step descriptions. Likely a copy/paste issue or a template literal with extra separator. Fix to single em-dash or use a colon separator.

### Affected files

- `apps/studio/src/components/evals/EvalRunsTab.tsx` (or the component rendering the manual setup steps)

### PR sequencing

- **PR 12:** Single PR. ~1 file, 1 package.

### Acceptance criteria

- Step descriptions render with proper punctuation.
- No double em-dashes or rendering artifacts.

### Risk of regression

NONE -- copy fix.

---

## Summary: PR Sequencing and Effort

| PR  | Theme | Severity | Effort | Files | Packages | Description                                   |
| --- | ----- | -------- | ------ | ----- | -------- | --------------------------------------------- |
| 1   | 1     | P1       | M      | ~8    | 1        | Shared date range control (Dashboard, QM)     |
| 2   | 1     | P1       | S      | ~6    | 1        | Date range control (remaining Insights pages) |
| 3   | 2     | P1       | S      | ~8    | 1        | Zero/empty value display standardization      |
| 4   | 3     | P1       | S      | ~5    | 1        | Degraded state banner + error message cleanup |
| 5   | 4     | P2       | S      | ~5    | 1        | Hardcoded color token replacements            |
| 6   | 5a    | P1       | S      | ~2    | 1        | Connections page title fix                    |
| 7   | 5b    | P1       | M      | ~5    | 1        | Org Settings page buildout                    |
| 8   | 6     | P2       | S      | ~4    | 1        | KPI card responsive breakpoint                |
| 9   | 7     | P2       | S      | ~4    | 1        | Chat session list UX fixes                    |
| 10  | 8     | P2       | S      | ~3    | 1        | Agent editor toolbar polish                   |
| 11  | 9     | P2       | S      | ~2    | 1        | Deployment card color tokens                  |
| 12  | 10    | P2       | S      | ~1    | 1        | Evals double em-dash fix                      |

### Total estimated effort

- **P1 themes (1-5):** ~10-13 developer-days across 7 PRs
- **P2 themes (6-10):** ~5-6 developer-days across 5 PRs
- **Grand total:** ~15-19 developer-days across 12 PRs

### Recommended priority order

1. PR 6 (Connections title fix) -- trivial, immediate win
2. PR 12 (Evals em-dash) -- trivial, immediate win
3. PR 4 (Error message cleanup) -- user-facing quality
4. PR 3 (Zero/empty value display) -- user-facing consistency
5. PR 1+2 (Date range control) -- largest consistency win
6. PR 5 (Color token enforcement) -- design system compliance
7. PR 7 (Org Settings) -- feature gap
8. PR 8-11 (Polish PRs) -- incremental improvements

---

---

## Phase D Themes (Populated-State Findings)

### Theme 11: Standardize Loading States (7 patterns -> 1-2 patterns)

**Severity:** P0 (must-fix)
**Effort:** L (5-8 days)
**Affected surfaces:** Agent Editor, Agent Detail, Tool Detail, Session Detail, Workflow Detail, Inbox, Insights Dashboard, Settings (Members, API Keys, Models, Runtime Config, Config Vars)
**Cross-cutting findings:** DC-1

### Problem

Phase D discovered SEVEN distinct loading patterns across 28 surfaces:

1. Plain spinner, no context (8 pages)
2. Skeleton rectangular blocks (Workflow Detail)
3. Skeleton card shapes (Inbox)
4. Skeleton + resolved content mix (Insights Dashboard)
5. "Loading session..." text + spinner (Session Detail)
6. Partial page load with title + tabs + spinner (API Keys)
7. "Compiling..." yellow badge (Agent Editor, Tool Detail)

Users navigating through the app encounter a different loading pattern on nearly every page. This is the highest-impact consistency issue found in Phase D.

### Recommended approach

1. Define TWO standard loading patterns:
   - **Skeleton loader:** For list/grid/card pages where the layout structure is predictable. Use shimmer animation. Apply to: Agents List, Tools, Sessions, Inbox, Insights KPIs, Settings content areas.
   - **Contextual spinner:** For pages where the content structure is dynamic (Agent Editor, Workflow Detail). Must include: page title (from route params), breadcrumb, and a descriptive message ("Loading agent broker_entry_gateway...").
2. Create shared `<PageLoadingSkeleton variant="table|cards|kpi-row|form" />` component.
3. Create shared `<ContextualLoadingState title={string} description={string} />` component.
4. Add a 10-second timeout with fallback: "Still loading... [Retry] [Go back]" for all loading states.
5. Ensure the "Compiling..." badge is promoted to the contextual spinner when it represents the primary page action.

### Affected files

- NEW: `apps/studio/src/components/shared/PageLoadingSkeleton.tsx`
- NEW: `apps/studio/src/components/shared/ContextualLoadingState.tsx`
- `apps/studio/src/components/agents/AgentEditorPage.tsx` (replace spinner with contextual loader)
- `apps/studio/src/components/agents/AgentDetailOverviewPage.tsx` (replace spinner)
- `apps/studio/src/components/tools/ToolDetailPage.tsx` (replace spinner)
- `apps/studio/src/components/sessions/SessionDetailPage.tsx` (replace "Loading session..." with contextual loader)
- `apps/studio/src/components/workflows/WorkflowDetailPage.tsx` (replace skeleton with standard skeleton)
- `apps/studio/src/components/inbox/InboxPage.tsx` (replace skeleton cards with standard skeleton)
- `apps/studio/src/components/settings/MembersPage.tsx` (replace spinner with skeleton)
- `apps/studio/src/components/settings/ApiKeysPage.tsx` (replace spinner with skeleton)
- `apps/studio/src/components/settings/ModelsPage.tsx` (replace spinner with skeleton)
- `apps/studio/src/components/settings/RuntimeConfigPage.tsx` (replace spinner with skeleton)
- `apps/studio/src/components/settings/ConfigVariablesPage.tsx` (replace spinner with skeleton)

### PR sequencing

- **PR 13:** Create `PageLoadingSkeleton` and `ContextualLoadingState` shared components with variant support. ~3 files, 1 package.
- **PR 14:** Apply skeleton loader to Settings pages (Members, API Keys, Models, Runtime Config, Config Vars). ~6 files, 1 package.
- **PR 15:** Apply contextual loader to detail pages (Agent Editor, Agent Detail, Tool Detail, Session Detail, Workflow Detail). ~6 files, 1 package.
- **PR 16:** Apply skeleton loader to Inbox and Insights Dashboard KPIs. Add timeout/retry to all loading states. ~4 files, 1 package.

### Acceptance criteria

- [ ] All pages use one of the two standard loading patterns
- [ ] Every loading state shows contextual information (what is loading)
- [ ] 10-second timeout with retry/back affordance on all loading states
- [ ] Skeleton loaders have shimmer animation
- [ ] No bare spinners remain

---

### Theme 12: Unify Zero/Empty Value Display (4 patterns -> 1)

**Severity:** P0 (must-fix)
**Effort:** M (3-5 days)
**Affected surfaces:** Overview KPIs, Customer Insights, Voice Analytics, Quality Monitor
**Cross-cutting findings:** DC-2, extends Phase A finding F-PH-1

### Problem

FOUR different representations of "no data" or "zero value" exist:

1. **"0"** -- numeric zero (Customer Insights counts)
2. **"--"** (em-dash) -- Overview KPIs, Customer Insights rates
3. **"N/A"** -- Voice Analytics KPIs
4. **"0.00"** -- Quality Monitor scores

All appear within the Insights navigation group, sometimes on the same page (Customer Insights: "0" and "--" side by side).

### Recommended approach

1. Define a semantic convention:
   - **"0"** for counts and sums where zero is a meaningful value (0 sessions, 0 conversations)
   - **"--"** for rates, averages, and computed metrics where no data exists to compute from
   - **Never "N/A"** -- use "--" with a tooltip "No data available" instead
   - **Never "0.00" for N/A** -- show "--" when no evaluations have occurred
2. Create a shared `<MetricValue value={number|null} type="count"|"rate"|"score" unit?={string} />` component that enforces this convention.
3. When `value` is `null` or `undefined`, display "--" with an aria-label and tooltip.
4. When `value` is `0` and `type` is `"count"`, display "0".
5. When `value` is `0` and `type` is `"rate"` or `"score"` and no underlying data exists, display "--".
6. Hide unit suffixes ("ms", "%") when value is "--".

### Affected files

- NEW: `apps/studio/src/components/shared/MetricValue.tsx`
- `apps/studio/src/components/insights/InsightsDashboardPage.tsx` (KPI cards)
- `apps/studio/src/components/insights/CustomerInsightsPage.tsx` (KPI cards)
- `apps/studio/src/components/insights/VoiceAnalyticsPage.tsx` (KPI cards -- replace "N/A")
- `apps/studio/src/components/insights/QualityMonitorPage.tsx` (score cards -- replace "0.00" with "--")
- `apps/studio/src/components/overview/ProjectOverview.tsx` (KPI cards)

### PR sequencing

- **PR 17:** Create `MetricValue` shared component + apply to Overview and Insights Dashboard KPIs. ~4 files, 1 package.
- **PR 18:** Apply to Customer Insights, Voice Analytics, Quality Monitor. ~4 files, 1 package.

### Acceptance criteria

- [ ] All zero/empty values use the shared `MetricValue` component
- [ ] Counts show "0", rates/scores show "--" when no data
- [ ] Unit suffixes hidden when value is "--"
- [ ] Tooltips on "--" explain "No data available"
- [ ] No "N/A" or "0.00" (for N/A) values remain

---

### Theme 13: Fix Settings Project Context Loss

**Severity:** P1 (should-fix)
**Effort:** S (1-2 days)
**Affected surfaces:** Settings Members, API Keys, Models, Runtime Config, Config Variables
**Cross-cutting findings:** DC-3

### Problem

When navigating from Build/Operate/Insights sections (where the project selector shows "Saludsa Production") to Settings, the project selector reverts to "Select Project". This causes:

- Users lose visual confirmation of which project they are configuring
- Settings pages may fail to load data due to missing project context
- The persistent spinners on settings pages may be caused by this context loss

### Recommended approach

1. Investigate the navigation store behavior when transitioning to Settings routes
2. Ensure `projectId` is preserved in the URL when navigating to Settings (route should be `/projects/{projectId}/settings/members` not `/settings/members`)
3. If Settings uses a different route structure, ensure the project store state persists across the transition
4. Add a guard: if Settings page loads without project context, show "Select a project to view settings" with a project picker, not a bare spinner

### Affected files

- `apps/studio/src/store/navigation-store.ts` (URL parsing for settings routes)
- `apps/studio/src/components/navigation/AppShell.tsx` (settings routing)
- `apps/studio/src/components/settings/SettingsLayout.tsx` (project context check)

### PR sequencing

- **PR 19:** Fix project context preservation when navigating to Settings. ~4 files, 1 package.

### Acceptance criteria

- [ ] Settings pages show the active project name in the project selector
- [ ] Settings pages load data for the active project
- [ ] If no project is selected, a clear message and picker are shown instead of a spinner

---

### Theme 14: Sanitize User-Facing Error Messages

**Severity:** P1 (should-fix)
**Effort:** S (1-2 days)
**Affected surfaces:** Knowledge Bases (Search AI), Customer Insights
**Cross-cutting findings:** DC-4

### Problem

Two surfaces expose internal error formats to users:

- Knowledge Bases: "AppError: Request failed (non-JSON response)" -- leaks error class name and transport-level detail
- Customer Insights: "Failed to load some analytics data. Showing available metrics." -- better, but vague about what failed

### Recommended approach

1. Knowledge Bases: Replace "AppError: Request failed (non-JSON response)" with "Unable to load knowledge bases. The service may be temporarily unavailable." Add "Show technical details" expandable for developers.
2. Customer Insights: Enhance to specify which data failed (e.g., "Sentiment and trend data are temporarily unavailable. Showing available metrics.").
3. Audit all SWR error handlers for similar internal error format leakage.

### Affected files

- `apps/studio/src/components/search-ai/KnowledgeBasesPage.tsx` (error state rendering)
- `apps/studio/src/components/insights/CustomerInsightsPage.tsx` (error banner text)
- `apps/studio/src/lib/api-client.ts` (check if error sanitization happens at the fetch level)

### PR sequencing

- **PR 20:** Sanitize error messages on Knowledge Bases and Customer Insights pages. ~3 files, 1 package.

### Acceptance criteria

- [ ] No internal error class names ("AppError", "TypeError") shown to users
- [ ] Error messages are actionable and explain what to do
- [ ] Developer-facing detail is in an expandable section or console only

---

### Theme 15: Fix Session Detail Double-Colon Bug

**Severity:** P2 (nice-to-fix)
**Effort:** XS (< 1 day)
**Affected surfaces:** Session Detail
**Cross-cutting findings:** DC-5

### Problem

Session Detail header shows "Traces:: 0" and "Session Cost:: --" with double colons. This is a string interpolation bug.

### Recommended approach

Find the string template that produces the double colon and fix the separator.

### Affected files

- `apps/studio/src/components/sessions/SessionDetailPage.tsx` (header metadata rendering)

### PR sequencing

- **PR 21:** Fix double-colon formatting in Session Detail header. ~1 file, 1 package.

### Acceptance criteria

- [ ] "Traces: 0" (single colon)
- [ ] "Session Cost: --" (single colon)

---

### Theme 16: Fix Agents List Blank Gray Area

**Severity:** P1 (should-fix)
**Effort:** S (1-2 days)
**Affected surfaces:** Agents List
**Cross-cutting findings:** F-D-AL-1

### Problem

A ~400px tall blank gray area appears between the filter bar and the topology warning banner on the Agents List page. This appears to be a canvas/topology visualization area that failed to render or is empty when no topology data is available.

### Recommended approach

1. If the gray area is a canvas view: add an empty-state inside it (e.g., "Topology view is empty -- fix compilation errors to see agent relationships") or collapse it to zero height when empty.
2. If the gray area is a layout bug: remove the empty container or set its `min-height` to 0.
3. Ensure the "List" view (which is the active view in the capture) does not reserve space for the "Canvas" view.

### Affected files

- `apps/studio/src/components/agents/AgentsListPage.tsx` (canvas/topology container)

### PR sequencing

- **PR 22:** Collapse empty canvas area on Agents List page. ~2 files, 1 package.

### Acceptance criteria

- [ ] No blank gray area visible in List view mode
- [ ] Canvas view shows content or empty state when switched to

---

### Theme 17: Standardize Agent Name Display

**Severity:** P2 (nice-to-fix)
**Effort:** S (1-2 days)
**Affected surfaces:** Agents List, Project Home, Deployments, Tools
**Cross-cutting findings:** F-D-AL-2, F-D-AL-4, F-D-PH-3, F-D-TL-1

### Problem

Agent and tool names display as raw identifiers: "broker_entry_gateway", "contract_data_assistant", "close_zendesk_ticket". These are underscore-separated, lowercase identifiers that are harder to read than formatted names. Additionally, agent name truncation breaks mid-word: "contract data assist..."

### Recommended approach

1. Create a shared `formatDisplayName(identifier: string)` utility that converts identifiers to readable names: "broker_entry_gateway" -> "Broker Entry Gateway", "close_zendesk_ticket" -> "Close Zendesk Ticket".
2. Apply to agent cards, tool cards, deployment agent pills, and overview agent lists.
3. Fix truncation to use `word-break: break-word` or a custom truncation function that cuts at word boundaries.
4. Preserve the raw identifier in a tooltip or secondary label for technical users.

### Affected files

- NEW: `apps/studio/src/lib/format-display-name.ts`
- `apps/studio/src/components/agents/AgentCard.tsx` (agent name display)
- `apps/studio/src/components/tools/ToolCard.tsx` (tool name display)
- `apps/studio/src/components/deployments/DeploymentCard.tsx` (agent pill display)

### PR sequencing

- **PR 23:** Create `formatDisplayName` utility + apply to Agent and Tool cards. ~5 files, 1 package.

### Acceptance criteria

- [ ] Agent names display as "Broker Entry Gateway" not "broker_entry_gateway"
- [ ] Tool names display as "Close Zendesk Ticket" not "close_zendesk_ticket"
- [ ] Raw identifier available in tooltip
- [ ] Truncation respects word boundaries

---

### Theme 18: Fix Sidebar Collapse Inconsistency

**Severity:** P2 (nice-to-fix)
**Effort:** XS (< 1 day)
**Affected surfaces:** Agent Editor, Agent Detail Overview
**Cross-cutting findings:** DC-6

### Problem

Most pages show the full labeled sidebar. Agent Editor and Agent Detail Overview collapse the sidebar to icon-only mode unexpectedly. Users navigating from Agents List (full sidebar) to Agent Editor (collapsed sidebar) experience an unexplained layout shift.

### Recommended approach

1. Investigate why the agent editor forces sidebar collapse.
2. If it is intentional (to maximize editor space), add a visible toggle and persist user preference.
3. If unintentional, ensure sidebar state is preserved across navigation.

### Affected files

- `apps/studio/src/components/navigation/SidebarLayout.tsx` (sidebar collapse logic)
- `apps/studio/src/store/navigation-store.ts` (sidebar state)

### PR sequencing

- **PR 24:** Fix sidebar collapse consistency for Agent Editor routes. ~2 files, 1 package.

### Acceptance criteria

- [ ] Sidebar collapse state is consistent or explicitly controlled by the user
- [ ] No unexplained layout shifts when navigating between pages

---

## Updated Execution Summary (Including Phase D Themes)

### Full theme list

| #   | Theme | Priority | Effort | Days | PRs | Description                                                   |
| --- | ----- | -------- | ------ | ---- | --- | ------------------------------------------------------------- |
| 1   | 1     | P1       | M      | ~5   | 2   | Inconsistent time/date range picker                           |
| 2   | 2     | P1       | S      | ~2   | 1   | Error message formatting inconsistency                        |
| 3   | 3     | P1       | S      | ~2   | 1   | Zero/empty value display (Phase A scope)                      |
| 4   | 4     | P1       | S      | ~1   | 1   | Error state technical leakage                                 |
| 5   | 5     | P1       | M      | ~3   | 2   | Hardcoded Tailwind palette colors                             |
| 6   | 6     | P2       | XS     | ~0.5 | 1   | Connections page missing title                                |
| 7   | 7     | P1       | S      | ~1   | 1   | Org Settings stub page                                        |
| 8   | 8     | P2       | S      | ~2   | 1   | Insights Dashboard KPI cards                                  |
| 9   | 9     | P2       | S      | ~2   | 1   | Sessions table column width                                   |
| 10  | 10    | P2       | S      | ~2   | 1   | Agent editor toolbar polish                                   |
| 11  | 11    | **P0**   | **L**  | ~8   | 4   | **Standardize loading states (Phase D)**                      |
| 12  | 12    | **P0**   | **M**  | ~5   | 2   | **Unify zero/empty value display (Phase D, extends Theme 3)** |
| 13  | 13    | **P1**   | **S**  | ~2   | 1   | **Fix Settings project context loss (Phase D)**               |
| 14  | 14    | **P1**   | **S**  | ~2   | 1   | **Sanitize user-facing error messages (Phase D)**             |
| 15  | 15    | **P2**   | **XS** | ~0.5 | 1   | **Fix Session Detail double-colon bug (Phase D)**             |
| 16  | 16    | **P1**   | **S**  | ~2   | 1   | **Fix Agents List blank gray area (Phase D)**                 |
| 17  | 17    | **P2**   | **S**  | ~2   | 1   | **Standardize agent name display (Phase D)**                  |
| 18  | 18    | **P2**   | **XS** | ~0.5 | 1   | **Fix sidebar collapse inconsistency (Phase D)**              |

### Updated total estimated effort

- **P0 themes (11-12):** ~13 developer-days across 6 PRs
- **P1 themes (1-5, 7, 13-14, 16):** ~18 developer-days across 10 PRs
- **P2 themes (6, 8-10, 15, 17-18):** ~9.5 developer-days across 7 PRs
- **Grand total:** ~40.5 developer-days across 23 PRs

### Updated recommended priority order

1. PR 21 (Session Detail double-colon) -- trivial, immediate win
2. PR 22 (Agents List blank area) -- high-visibility fix
3. PR 13 (Loading state shared components) -- foundation for Theme 11
4. PR 14-16 (Apply loading state standardization) -- biggest quality win
5. PR 17-18 (MetricValue component + apply) -- second biggest consistency win
6. PR 19 (Settings project context) -- fixes root cause of Settings spinners
7. PR 20 (Error message sanitization) -- user-facing quality
8. PR 6 (Connections title fix) -- trivial, immediate win
9. PR 23 (Agent name display) -- readability improvement
10. PR 24 (Sidebar collapse) -- layout consistency
11. Remaining Phase A-C PRs (1-5, 7-12)

---

## Phase E Themes (Session-Heavy Surface Findings)

### Theme 19: Fix Analytics Default Time Range Mismatch (CRITICAL)

**Severity:** P0 (must-fix)
**Effort:** S (1-2 days)
**Affected surfaces:** Analytics (Overview, Sessions Explorer, Traces Explorer, Generations)
**Cross-cutting findings:** EC-1, EC-6
**Reinforces:** Theme 1 (time range picker inconsistency)

### Problem

The Analytics page defaults to a "30m" time range via its SegmentedControl. Every other Insights page defaults to "Last 30 days" or "Last 7 days." With real session data (50 sessions, most older than 30 minutes), the Analytics page shows "No analytics data yet" or "No sessions found" -- making users think the feature is broken.

This is the highest-impact UX bug found in Phase E. It creates a false impression of an empty/broken feature.

### Recommended approach

1. Change Analytics default time range from "30m" to "7d" to match the Sessions list default.
2. Alternatively, implement smart defaulting: if the last 30m has no data, auto-expand to the smallest range that has data (1h, 3h, 6h, etc.) and show a note: "Showing last 7 days (no data in the last 30 minutes)."
3. Fix the empty-state message from "No analytics data yet" to "No data in the selected time range. Try expanding the time range or selecting a longer period."
4. Ensure Sessions Explorer empty state says "No sessions found" (not "Sessions will appear here once conversations start" when sessions DO exist in a wider range).

### Affected files

- `apps/studio/src/components/analytics/AnalyticsPage.tsx` (default time range)
- `apps/studio/src/components/analytics/SessionsExplorerTab.tsx` (empty state message)
- `apps/studio/src/components/analytics/TracesExplorerTab.tsx` (empty state message -- "No sessions found" should be "No traces found")
- `apps/studio/src/components/analytics/OverviewTab.tsx` (empty state message)

### PR sequencing

- **PR 25:** Fix Analytics default time range and empty-state messages. ~4 files, 1 package.

### Acceptance criteria

- [ ] Analytics default time range shows data when other Insights pages show data
- [ ] Empty-state messages distinguish "no data in range" from "no data exists"
- [ ] Traces Explorer says "No traces found" not "No sessions found"

---

### Theme 20: Humanize Session Identifiers

**Severity:** P0 (must-fix)
**Effort:** M (3-5 days)
**Affected surfaces:** Sessions List, Session Detail, Session Sidebar (Agent Chat), Analytics Sessions Explorer
**Cross-cutting findings:** EC-2, extends Phase A findings F-SE-2 and F-AC-1

### Problem

Sessions are identified everywhere by raw SDK-prefixed UUIDs: `s-sdk_9272d0b8-4884-...`. With 50 sessions all from the same "supervisor" agent, users cannot distinguish sessions. The Session ID column is the widest in the table but provides the least useful information.

### Recommended approach

1. Replace the Session ID primary display with a human-readable composite: `{agentName} - {relativeTime}` (e.g., "supervisor - Apr 17 3:25 PM").
2. Show the session ID in a secondary position (tooltip or expandable row detail).
3. In the Sessions table: rename "Session ID" column to "Session" and display `{agentName}\n{shortTimestamp}` in a two-line cell.
4. In Session Detail: replace the UUID page title with `{agentName} Session` and show timestamps as the primary metadata.
5. In Agent Chat session sidebar: show `{timestamp}` as primary and `{messageCount} messages` as secondary.

### Affected files

- `apps/studio/src/components/session/SessionsListPage.tsx` (table column rendering)
- `apps/studio/src/components/session/SessionDetailPage.tsx` (page header)
- `apps/studio/src/components/chat/SessionSidebar.tsx` (session list items)
- `apps/studio/src/components/analytics/SessionsExplorerTab.tsx` (table rendering)

### PR sequencing

- **PR 26:** Humanize session identifiers in Sessions List and Session Detail. ~4 files, 1 package.
- **PR 27:** Apply to Agent Chat sidebar and Analytics Sessions Explorer. ~3 files, 1 package.

### Acceptance criteria

- [ ] Sessions are identifiable by agent name + timestamp, not UUID
- [ ] Full UUID accessible via tooltip or detail view
- [ ] Session list rows are visually distinguishable from each other

---

### Theme 21: Fix Error Badge Zero-Count Semantics

**Severity:** P1 (should-fix)
**Effort:** XS (< 1 day)
**Affected surfaces:** Session Detail
**Cross-cutting findings:** EC-3

### Problem

The Session Detail tab bar shows "Errors 0" with a red circle badge. Zero errors is the success state, but red universally signals danger. Every user viewing session details sees a false alarm.

### Recommended approach

1. When error count is 0: show no badge, or show a green/gray badge with "0".
2. When error count > 0: show a red badge with the count (current behavior for non-zero is correct).
3. Apply same logic to the Traces badge -- if traces count is 0 on a session with no traces, use neutral color.

### Affected files

- `apps/studio/src/components/session/SessionDetailPage.tsx` (tab bar badge rendering)
- `apps/studio/src/components/session/MetricsBar.tsx` (metrics bar badge colors)

### PR sequencing

- **PR 28:** Fix error badge zero-count color semantics. ~2 files, 1 package.

### Acceptance criteria

- [ ] "Errors 0" uses no badge or neutral/green badge
- [ ] "Errors N" (N > 0) uses red badge
- [ ] Badge color matches semantic meaning across all tab badges

---

### Theme 22: Add Metric Scale Context to KPI Cards

**Severity:** P1 (should-fix)
**Effort:** S (1-2 days)
**Affected surfaces:** Customer Insights, Quality Monitor, Session Detail metrics
**Cross-cutting findings:** EC-4

### Problem

"AVG SENTIMENT: 0.10" and "OVERALL QUALITY: 0.59" are dimensionless numbers with no scale reference. "FRUSTRATION RATE: 72.1%" is high but displayed neutrally with no visual urgency. Users cannot interpret these values without context.

### Recommended approach

1. Add scale denominators to score-type KPIs: "0.59 / 1.0" or "59%" next to the raw score.
2. Add semantic coloring to rate-type KPIs: FRUSTRATION RATE > 50% should use `text-error` or `text-warning` color.
3. Add a micro progress bar or color gradient bar below score KPIs to visualize where the value falls on the scale.
4. For AVG SENTIMENT: clarify the range (add "/1.0" suffix or a [-1, 1] scale indicator).

### Affected files

- `apps/studio/src/components/insights/CustomerInsightsPage.tsx` (KPI card rendering)
- `apps/studio/src/components/insights/QualityMonitorPage.tsx` (score card rendering)
- `apps/studio/src/components/session/MetricsBar.tsx` (session cost display -- round to 2 decimal places)

### PR sequencing

- **PR 29:** Add scale context to Customer Insights and Quality Monitor KPIs. ~3 files, 1 package.

### Acceptance criteria

- [ ] All score/rate KPIs show their scale (denominator or percentage)
- [ ] High frustration rates use warning/error color
- [ ] Session cost rounds to reasonable precision ($0.27, not $0.273015)

---

### Theme 23: Collapse Repeated Operations in Session Execution Tree

**Severity:** P2 (nice-to-fix)
**Effort:** S (1-2 days)
**Affected surfaces:** Session Detail
**Cross-cutting findings:** F-E-SD-4

### Problem

The agent execution tree shows `constraint_check: pass` repeated 7+ times vertically, creating visual noise. In a session with many constraint checks, the tree becomes unreadable.

### Recommended approach

1. Group consecutive identical operations: "constraint_check: pass (x7)" in a collapsed node.
2. Allow expand to see individual items.
3. Apply same grouping to any repeated operation type (e.g., multiple identical LLM calls).

### Affected files

- `apps/studio/src/components/session/AgentExecutionTree.tsx` (tree rendering logic)

### PR sequencing

- **PR 30:** Group repeated operations in execution tree. ~2 files, 1 package.

### Acceptance criteria

- [ ] Repeated consecutive operations are grouped with count
- [ ] Expand/collapse to see individual operations
- [ ] Tree is readable at 20+ operations

---

### Theme 24: Surface Session Cost in List View

**Severity:** P2 (nice-to-fix)
**Effort:** XS (< 1 day)
**Affected surfaces:** Sessions List
**Cross-cutting findings:** EC-5, extends Phase D finding F-SE-1

### Problem

The Sessions list has a "Cost" column showing "--" for all rows, despite Session Detail showing actual cost data ($0.273015). The column wastes horizontal space with no value.

### Recommended approach

1. Propagate session cost from the detail data to the list view.
2. Format as "$0.27" (2 decimal places) in the list, full precision in the detail.
3. If cost data is genuinely unavailable at list time (async calculation), show a spinner or "calculating..." instead of "--".

### Affected files

- `apps/studio/src/components/session/SessionsListPage.tsx` (cost column rendering)

### PR sequencing

- **PR 31:** Surface session cost in list view. ~1 file, 1 package.

### Acceptance criteria

- [ ] Cost column shows actual costs where data exists
- [ ] Cost values formatted to 2 decimal places

---

## Updated Execution Summary (Including Phase D + Phase E Themes)

### Full theme list

| #   | Theme | Priority | Effort | Days | PRs | Description                                                   |
| --- | ----- | -------- | ------ | ---- | --- | ------------------------------------------------------------- |
| 1   | 1     | P1       | M      | ~5   | 2   | Inconsistent time/date range picker                           |
| 2   | 2     | P1       | S      | ~2   | 1   | Error message formatting inconsistency                        |
| 3   | 3     | P1       | S      | ~2   | 1   | Zero/empty value display (Phase A scope)                      |
| 4   | 4     | P1       | S      | ~1   | 1   | Error state technical leakage                                 |
| 5   | 5     | P1       | M      | ~3   | 2   | Hardcoded Tailwind palette colors                             |
| 6   | 6     | P2       | XS     | ~0.5 | 1   | Connections page missing title                                |
| 7   | 7     | P1       | S      | ~1   | 1   | Org Settings stub page                                        |
| 8   | 8     | P2       | S      | ~2   | 1   | Insights Dashboard KPI cards                                  |
| 9   | 9     | P2       | S      | ~2   | 1   | Sessions table column width                                   |
| 10  | 10    | P2       | S      | ~2   | 1   | Agent editor toolbar polish                                   |
| 11  | 11    | **P0**   | **L**  | ~8   | 4   | **Standardize loading states (Phase D)**                      |
| 12  | 12    | **P0**   | **M**  | ~5   | 2   | **Unify zero/empty value display (Phase D, extends Theme 3)** |
| 13  | 13    | **P1**   | **S**  | ~2   | 1   | **Fix Settings project context loss (Phase D)**               |
| 14  | 14    | **P1**   | **S**  | ~2   | 1   | **Sanitize user-facing error messages (Phase D)**             |
| 15  | 15    | **P2**   | **XS** | ~0.5 | 1   | **Fix Session Detail double-colon bug (Phase D)**             |
| 16  | 16    | **P1**   | **S**  | ~2   | 1   | **Fix Agents List blank gray area (Phase D)**                 |
| 17  | 17    | **P2**   | **S**  | ~2   | 1   | **Standardize agent name display (Phase D)**                  |
| 18  | 18    | **P2**   | **XS** | ~0.5 | 1   | **Fix sidebar collapse inconsistency (Phase D)**              |
| 19  | 19    | **P0**   | **S**  | ~2   | 1   | **Fix Analytics time range mismatch (Phase E)**               |
| 20  | 20    | **P0**   | **M**  | ~4   | 2   | **Humanize session identifiers (Phase E)**                    |
| 21  | 21    | **P1**   | **XS** | ~0.5 | 1   | **Fix error badge zero-count semantics (Phase E)**            |
| 22  | 22    | **P1**   | **S**  | ~2   | 1   | **Add metric scale context to KPI cards (Phase E)**           |
| 23  | 23    | **P2**   | **S**  | ~2   | 1   | **Collapse repeated operations in exec tree (Phase E)**       |
| 24  | 24    | **P2**   | **XS** | ~0.5 | 1   | **Surface session cost in list view (Phase E)**               |

### Updated total estimated effort

- **P0 themes (11-12, 19-20):** ~19 developer-days across 9 PRs
- **P1 themes (1-5, 7, 13-14, 16, 21-22):** ~21 developer-days across 12 PRs
- **P2 themes (6, 8-10, 15, 17-18, 23-24):** ~12 developer-days across 10 PRs
- **Grand total:** ~52 developer-days across 31 PRs

### Updated recommended priority order

1. PR 25 (Analytics time range mismatch) -- **highest-impact Phase E fix**, users think Analytics is broken
2. PR 21 (Session Detail double-colon -- already in backlog) -- trivial, immediate win
3. PR 22 (Agents List blank area -- already in backlog) -- high-visibility fix
4. PR 13 (Loading state shared components) -- foundation for Theme 11
5. PR 14-16 (Apply loading state standardization) -- biggest quality win
6. PR 26-27 (Humanize session identifiers) -- Session UX from "unusable" to "usable"
7. PR 28 (Error badge zero-count) -- false alarm removal
8. PR 17-18 (MetricValue component + apply) -- second biggest consistency win
9. PR 29 (Metric scale context) -- metric interpretability
10. PR 19 (Settings project context) -- fixes root cause of Settings spinners
11. PR 20 (Error message sanitization) -- user-facing quality
12. PR 6 (Connections title fix) -- trivial, immediate win
13. PR 23 (Agent name display) -- readability improvement
14. PR 30 (Execution tree grouping) -- session detail polish
15. PR 31 (Session cost in list) -- data completeness
16. PR 24 (Sidebar collapse) -- layout consistency
17. Remaining Phase A-C PRs (1-5, 7-12)

---

## Findings NOT Requiring Code Changes

These observations are noted but do not justify fix work:

1. **Light mode only audited.** Dark mode was not tested. The token system is designed for both themes, so token-backed components should work. Recommend a follow-up dark-mode audit.
2. **Empty states are well-designed.** Most surfaces have clear, helpful empty-state copy with CTAs. This is a strength. The Evals page empty state is exemplary and should be the template.
3. **Sidebar navigation is consistent.** The drill-down group pattern (Insights, Operate, Govern, Settings) is well-implemented with back arrows and section headers.
4. **Typography scale is consistent.** Page titles, subtitles, body text, and metadata all follow the design-system type scale.
5. **Spacing is generally excellent.** The 4/8/12/16/24/32 spacing scale is well-adhered to across surfaces.
6. **Deployments page is well-designed.** The environment-card pattern with color coding (cyan/gray/rose) and agent version pills is one of the strongest surfaces. Consider it a reference implementation.
7. **Customer Insights partial-failure pattern is good.** The graceful degradation (show what we can + error banner) should be standardized across all data-loading pages.
8. **Auth Profiles filter pattern is exemplary.** Search + multi-dropdown filters + empty state with clear CTA is the best-structured settings page.
9. **Phase D Session Detail double-colon bug (F-D-SD-1) confirmed FIXED in Phase E.** The metrics bar now shows "Traces: 147" and "Session Cost: $0.273015" with single colons.
10. **Customer Insights with real data is the strongest populated Insights page.** Intent Distribution horizontal bar charts, Sentiment Trajectory, and 4 KPI cards with real values are well-designed. The 2-column chart layout is a reference implementation.
11. **Quality Monitor Dimension Details pattern is well-designed.** Expandable rows with status badges (Warning/Healthy) and drill-down chevrons provide a good progressive disclosure pattern.
12. **Session Detail three-panel layout is functionally sound.** The conversation tree (left), messages (center), and detail panel (right) architecture supports deep debugging. The information architecture (7 tabs) is comprehensive even if cramped at 1440px.
13. **Voice Analytics surface cannot be validated** without a voice-enabled project. Apple Care is text-only. Voice UX issues from Phase A (F-VA-1, F-VA-2) persist but are confirmed empty-state-only bugs.
14. **Analytics Generations sub-tab toolbar is exemplary.** Search + Filters + Columns + Export buttons shown even in empty state is excellent UX -- it sets user expectations and is ready for first data.

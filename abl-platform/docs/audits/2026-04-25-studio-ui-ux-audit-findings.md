# Studio UI/UX Audit Findings

**Date:** 2026-04-25
**Auditor:** Claude Opus 4.6 (automated)
**Scope:** 33 Studio surfaces across Phase A (P0), Phase B (P1), Phase C (P2) + 28 populated-state surfaces in Phase D + 9 session-heavy surfaces in Phase E
**Screenshots (A-C):** `.codex-artifacts/studio-video-evidence/studio-ui-audit-capture-modwqsoe-h851op/screenshots/`
**Screenshots (D):** `.codex-artifacts/studio-video-evidence/populated-state-capture-modzk7f9-bmc52i/screenshots/`
**Screenshots (E):** `.codex-artifacts/studio-video-evidence/phase-e-agents-dev-capture-moe1192v-v7bgk0/screenshots/`
**Theme:** Light mode (default)
**Design system reference:** `packages/design-tokens/` + `apps/studio/src/app/globals.css`

## Capture Summary

| Phase | Surfaces | Viewports | Screenshots | Captured | Failed |
| ----- | -------- | --------- | ----------- | -------- | ------ |
| A     | 18       | 3         | 54          | 54       | 0      |
| B     | 9        | 1         | 9           | 9        | 0      |
| C     | 5        | 1         | 5           | 5        | 0      |
| D     | 28       | 1         | 29          | 29       | 0      |
| E     | 9        | 1         | 23          | 23       | 0      |
| Total | 69       | -         | 120         | 120      | 0      |

## Rubric Scoring Key

| Score | Meaning                    |
| ----- | -------------------------- |
| 4     | Excellent, no issues found |
| 3     | Minor polish opportunity   |
| 2     | Noticeable issue           |
| 1     | Clear regression           |
| 0     | Blocker                    |

---

## Phase A: P0 Surface Findings

### 1. Projects Dashboard

**Screenshot:** `projects-dashboard--default--1440x900.png`

| Dimension           | Score | Notes                                                                                                                                                     |
| ------------------- | ----- | --------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Color usage         | 4     | Clean monochrome accent on "+ New Project" button. Card uses `bg-background-elevated` (white) correctly.                                                  |
| Alignment           | 3     | Search bar and card left-align to content grid. Project card icon/text baseline slightly off (icon 48px circle vs 14px text).                             |
| Window/panel sizing | 3     | Content area maxes at ~900px on 1440 viewport, leaving ~400px whitespace right. At 1920 even more wasteful. Cards could form a responsive grid.           |
| Overcrowded text    | 4     | Minimal text, no crowding. Project name truncates with ellipsis appropriately.                                                                            |
| Spacing             | 3     | 24px padding from sidebar. Gap between search bar and card grid is ~16px, could benefit from more vertical separation (24px).                             |
| Legibility          | 4     | All text passes WCAG AA. Page title uses `--foreground` (dark). Metadata uses `--foreground-muted` with adequate contrast on `--background` (light gray). |
| Text hints          | 3     | "Search projects..." placeholder is clear. No keyboard shortcut hint text beyond the CMD+K badge. No tooltip on the settings gear icon.                   |
| Consistency         | 4     | Matches other list pages (agents, workflows) in header/search/card layout.                                                                                |
| Modern UI theme     | 3     | Clean light-on-gray Vercel pattern. Minor: project card has a divider line between title and metadata that feels visually heavy for the card density.     |

**Key findings:**

- F-PD-1: Content area is narrow relative to viewport; does not fill 1920 screens effectively.
- F-PD-2: No empty-state illustration or call-to-action when only 1 project exists (just a lonely card).

---

### 2. Project Home (Overview)

**Screenshot:** `project-home--default--1440x900.png`

| Dimension           | Score | Notes                                                                                                                                                         |
| ------------------- | ----- | ------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Color usage         | 3     | KPI cards (AGENTS/SESSIONS/DEPLOYED) use white cards on gray page correctly. "DEPLOYED" card has a light teal/cyan left-border accent -- appropriate for info |
| Alignment           | 4     | Three KPI cards evenly distributed. Sidebar labels, icons, nav items are grid-aligned.                                                                        |
| Window/panel sizing | 3     | Quick Actions section and Agents list are in a 2-column layout that fills well at 1440. At 1280, still fine. At 1920 slightly sparse.                         |
| Overcrowded text    | 4     | Clean separation between KPI labels and values.                                                                                                               |
| Spacing             | 4     | Good 24px section gaps. Card padding consistent.                                                                                                              |
| Legibility          | 4     | KPI labels in all-caps `text-xs` `text-foreground-muted` -- good contrast.                                                                                    |
| Text hints          | 3     | "SESSIONS" shows em-dash for zero -- acceptable but not ideal. Could show "0" like AGENTS does.                                                               |
| Consistency         | 3     | SESSIONS displays "--" while AGENTS displays "1" and DEPLOYED displays "0 / 1" -- three different zero-value representations on one screen.                   |
| Modern UI theme     | 4     | Import/Export buttons in header, clean card pattern. Quick Actions cards with icon + description.                                                             |

**Key findings:**

- F-PH-1: Inconsistent zero-value display: "0", "--", "0 / 1" across three adjacent KPI cards.
- F-PH-2: Agent name in the list shows as raw identifier "studio video evidence agent modwtgjm 0j5013" -- no friendly display name pattern.

---

### 3. Agents List

**Screenshot:** `agents-list--default--1440x900.png`

| Dimension           | Score | Notes                                                                                                                                |
| ------------------- | ----- | ------------------------------------------------------------------------------------------------------------------------------------ |
| Color usage         | 4     | "Draft" status uses muted gray dot, "Flow" and "Start" badges use neutral/muted styling. No color misuse.                            |
| Alignment           | 3     | Agent card icon, name, badges are left-aligned. "Draft" is right-aligned. Slight vertical misalignment between badges and name text. |
| Window/panel sizing | 3     | Cards only fill ~400px of the ~1200px content area. Single-column card layout wastes space when few agents exist.                    |
| Overcrowded text    | 3     | Agent name truncates with "..." but the card is wide enough to show more. Truncation happens at ~20 chars; card width is ~350px.     |
| Spacing             | 4     | Consistent padding. Filter bar (search + dropdowns) is well-spaced.                                                                  |
| Legibility          | 4     | All text legible. Subtitle "Studio Video Evidence..." at `text-sm text-foreground-muted` passes AA.                                  |
| Text hints          | 3     | "Search agents..." placeholder. Filter dropdowns "All Status" / "All Types" are clear. No result count next to search.               |
| Consistency         | 4     | Layout matches workflows, tools list patterns.                                                                                       |
| Modern UI theme     | 4     | Card hover states, badge styling consistent with design system.                                                                      |

**Key findings:**

- F-AL-1: Agent name truncation is aggressive -- 20-char truncation on a ~350px card could show 30+ chars.
- F-AL-2: Badge variant: "Flow" uses outline style, "Start" uses filled dark background -- inconsistent badge styling in same row.

---

### 4. Agent Editor

**Screenshot:** `agent-editor--default--1440x900.png`

| Dimension           | Score | Notes                                                                                                                                                                  |
| ------------------- | ----- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Color usage         | 3     | "Flow" badge in header uses a purple/magenta color that is not a standard design-token semantic color (appears to be `text-purple` but background is non-token).       |
| Alignment           | 3     | Left panel uses icon-only rail + expandable section nav. Section labels (IDENTITY, CAPABILITIES, etc.) align well. Main content area has good field alignment.         |
| Window/panel sizing | 3     | Main content area is wide (~900px) but Goal/Persona textareas only take ~650px -- constrained by `max-w` unnecessarily. Left panel is ~240px which is good.            |
| Overcrowded text    | 3     | Section header "AGENT IDENTITY" uses all-caps `text-xs` which is fine, but "LIMITATIONS" subtitle text is long (one line at ~650px) and could wrap awkwardly at 1280.  |
| Spacing             | 4     | Field labels (GOAL, PERSONA, LIMITATIONS) have consistent 24px vertical gaps. Input padding is consistent.                                                             |
| Legibility          | 4     | Field labels in all-caps muted foreground, textarea content in regular foreground. Good contrast.                                                                      |
| Text hints          | 3     | "Add a limitation..." placeholder is helpful. "No limitations defined" italic text is useful but could have a CTA.                                                     |
| Consistency         | 3     | "Delete" button in the header toolbar uses red text (`text-error`) -- correct for destructive action. But toolbar has mixed button styles: ghost + outline + red text. |
| Modern UI theme     | 3     | Dual sidebar (icon rail + detail panel) is a good pattern. "AI Assist" button in the top-right corner could be more prominent.                                         |

**Key findings:**

- F-AE-1: "Flow" badge in header bar uses a raw purple/magenta color without clear semantic token backing.
- F-AE-2: Toolbar button styles are inconsistent: "Chat with Agent" (outline), "History" (ghost), "DSL" (ghost), "Delete" (red text), "Save" (ghost).
- F-AE-3: "AI Assist" button positioned far right above main content; easy to miss, no visual weight to match its importance.
- F-AE-4: Helper text under LIMITATIONS "Prompt-level boundaries for refusals..." wraps to ~90ch line at 1440px -- exceeds 75ch target.

---

### 5. Agent Chat

**Screenshot:** `agent-chat--default--1440x900.png`

| Dimension           | Score | Notes                                                                                                                                  |
| ------------------- | ----- | -------------------------------------------------------------------------------------------------------------------------------------- |
| Color usage         | 3     | Session list uses gray background for selected item. Green dot for active session. Chat bubble uses `bg-background-muted`.             |
| Alignment           | 4     | Chat area is centered. Session list panel, chat header, message area, input bar all well-aligned.                                      |
| Window/panel sizing | 3     | Session list panel is ~270px. At 1280, chat area gets compressed. At 1920, session list stays 270px but chat area has excessive space. |
| Overcrowded text    | 2     | Session IDs shown as raw UUIDs ("d45bc2b7", "98a8b2b0") -- cryptic to users. "1 msgs" is grammatically incorrect (should be "1 msg").  |
| Spacing             | 3     | Session list items have 8px vertical gap which is tight. Message input area has good padding.                                          |
| Legibility          | 4     | Message text is readable. Chat header agent name in regular weight, metadata in muted text.                                            |
| Text hints          | 3     | "Send a message..." placeholder is clear. Session list lacks any help text about what sessions are.                                    |
| Consistency         | 3     | Chat header shows "Agent Reasoning 0 tools" as tab-like labels -- but these are not clickable tabs, they're metadata.                  |
| Modern UI theme     | 3     | Clean chat pattern. Attachment button and send button are well-placed. Session list could use hover states.                            |

**Key findings:**

- F-AC-1: Session IDs displayed as raw short UUIDs -- no human-readable names or timestamps as primary identifier.
- F-AC-2: "1 msgs" grammatical error -- should be "1 msg" or "1 message".
- F-AC-3: "Agent Reasoning 0 tools" metadata in header renders as pseudo-tabs but are not interactive elements.
- F-AC-4: Session list panel width is fixed, does not respond to viewport changes.

---

### 6. Insights Dashboard (At a Glance)

**Screenshot:** `insights-dashboard--default--1440x900.png`

| Dimension           | Score | Notes                                                                                                                                                                          |
| ------------------- | ----- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| Color usage         | 2     | Error banner uses `bg-error-subtle` (pink/red background) with `text-error` (red text). This is semantically correct but occupies full content width for a non-blocking error. |
| Alignment           | 3     | 6 KPI cards in a row. At 1440, they fit but labels like "CONTAINMENT RATE" wrap to 2 lines while "CONVERSATIONS" fits on 1 line -- uneven card heights.                        |
| Window/panel sizing | 3     | At 1280 (laptop), KPI card labels get cramped -- "ESCALATION RATE" wraps aggressively.                                                                                         |
| Overcrowded text    | 2     | KPI labels in ALL-CAPS are hard to scan at `text-xs` size. "CONTAINMENT RATE" at 12px all-caps is dense. The info icon (circle-i) next to labels adds more visual noise.       |
| Spacing             | 3     | KPI cards have 12px gaps between them. Could benefit from 16px. Vertical spacing between error banner and KPI row is adequate.                                                 |
| Legibility          | 3     | KPI values use large bold text (good). Labels in all-caps `text-xs text-foreground-muted` -- contrast is adequate but readability is poor due to all-caps at 12px.             |
| Text hints          | 3     | Error message "Failed to load some analytics data. Showing available metrics." is clear and reassuring.                                                                        |
| Consistency         | 2     | Date range selector is a dropdown ("Last 30 days") -- differs from Analytics which uses a SegmentedControl ("30m 1h 3h..."). Different control for the same concept.           |
| Modern UI theme     | 3     | Tab bar (Overview/Trends/ROI/Conversations) is clean. KPI cards match design system. Error banner style is consistent.                                                         |

**Key findings:**

- F-ID-1: **Date range selector inconsistency** -- Dropdown here, SegmentedControl on Analytics, SegmentedControl on Voice Analytics, SegmentedControl on Billing. Four different time-picker patterns across Insights sub-pages.
- F-ID-2: KPI labels in ALL-CAPS at 12px are difficult to scan quickly. Mixed label lengths cause uneven card heights.
- F-ID-3: 6 KPI cards in a row at 1280px viewport causes text wrapping; should consider responsive breakpoint to 2x3 grid.
- F-ID-4: Error banner takes full content width for a degraded-but-functional state -- could be a toast or inline notice.

---

### 7. Analytics

**Screenshot:** `insights-analytics--default--1440x900.png`

| Dimension           | Score | Notes                                                                                                                                                                        |
| ------------------- | ----- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Color usage         | 4     | SegmentedControl uses `bg-accent` for selected, clean neutral for unselected. Empty state icon is muted gray.                                                                |
| Alignment           | 4     | Tab bar and segmented control are well-aligned. Empty state is centered.                                                                                                     |
| Window/panel sizing | 4     | Tab bar fills width well. Empty state centers appropriately across viewports.                                                                                                |
| Overcrowded text    | 4     | Minimal text in empty state. Tab labels are concise.                                                                                                                         |
| Spacing             | 4     | Good spacing between header, controls, tabs, and content area.                                                                                                               |
| Legibility          | 4     | All text passes AA. Subtitle text is clear.                                                                                                                                  |
| Text hints          | 4     | "No analytics data yet" with supportive description is a good empty-state pattern.                                                                                           |
| Consistency         | 2     | Time range uses SegmentedControl with granular options (30m/1h/3h/6h/12h/24h/2d/7d/30d/Custom) while other Insights pages use dropdown with 7d/30d/90d. Incompatible ranges. |
| Modern UI theme     | 4     | Clean SegmentedControl, good tab design.                                                                                                                                     |

**Key findings:**

- F-AN-1: Time range picker is radically different from sibling Insights pages -- SegmentedControl with 10 options vs. Dropdown with 3 options.
- F-AN-2: Time ranges offered are incompatible: Analytics offers 30m-30d, while Dashboard/Quality/Customer Insights offer 7d/30d/90d.

---

### 8. Billing & Usage

**Screenshot:** `insights-billing--default--1440x900.png`

| Dimension           | Score | Notes                                                                                                                            |
| ------------------- | ----- | -------------------------------------------------------------------------------------------------------------------------------- |
| Color usage         | 4     | Clean neutral palette. Selected time range uses filled dark pill.                                                                |
| Alignment           | 4     | Section headers and content well-aligned.                                                                                        |
| Window/panel sizing | 3     | Content area is relatively empty. Could benefit from a summary panel or info callout.                                            |
| Overcrowded text    | 4     | Minimal text, no crowding.                                                                                                       |
| Spacing             | 4     | Consistent spacing between header, time controls, and content.                                                                   |
| Legibility          | 4     | All text readable.                                                                                                               |
| Text hints          | 3     | "Published billing-unit usage reporting for Studio Video Evidence..." exposes internal project ID in subtitle.                   |
| Consistency         | 2     | Time range uses a THIRD pattern: inline pill buttons ("7 days", "30 days", "90 days") -- not a SegmentedControl, not a Dropdown. |
| Modern UI theme     | 3     | Clean but sparse. Empty state has icon but no illustration.                                                                      |

**Key findings:**

- F-BU-1: Time range uses plain pill buttons -- a third distinct control variant alongside DropdownMenu and SegmentedControl.
- F-BU-2: Subtitle exposes internal project slug "modwtgjm-0j5013" to user -- should use project display name only.

---

### 9. Agent Performance

**Screenshot:** `insights-agent-performance--default--1440x900.png`

| Dimension           | Score | Notes                                                                           |
| ------------------- | ----- | ------------------------------------------------------------------------------- |
| Color usage         | 4     | Clean, no color issues in empty state.                                          |
| Alignment           | 4     | Center-aligned empty state text.                                                |
| Window/panel sizing | 3     | Empty state leaves vast whitespace. No page-level header actions.               |
| Overcrowded text    | 4     | Minimal text.                                                                   |
| Spacing             | 3     | No date range selector like sibling pages. Missing the standard filter bar.     |
| Legibility          | 4     | Text readable.                                                                  |
| Text hints          | 3     | "Enable analytics pipelines in Settings" -- helpful but could be a direct link. |
| Consistency         | 2     | No date range selector at all -- every other Insights sub-page has one.         |
| Modern UI theme     | 3     | Plain empty state without illustration.                                         |

**Key findings:**

- F-AP-1: Missing date range selector that every sibling Insights page has.
- F-AP-2: "Enable analytics pipelines in Settings" should be a clickable link, not plain text.

---

### 10. Quality Monitor

**Screenshot:** `insights-quality-monitor--default--1440x900.png`

| Dimension           | Score | Notes                                                                                                                                                      |
| ------------------- | ----- | ---------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Color usage         | 3     | "Quality Health" banner has a red-to-pink gradient that is strong and attention-grabbing. "5 Critical" in red, "0 Healthy" in green -- correct semantics.  |
| Alignment           | 4     | KPI cards are evenly distributed. Quality Health banner well-aligned.                                                                                      |
| Window/panel sizing | 4     | 5 KPI cards fit well at 1440. Content fills the area.                                                                                                      |
| Overcrowded text    | 3     | KPI labels "OVERALL QUALITY", "HALLUCINATION RATE" etc. in ALL-CAPS 12px are dense but manageable because card widths are adequate.                        |
| Spacing             | 4     | Good vertical rhythm between error banner, quality health, KPIs, and trend chart.                                                                          |
| Legibility          | 3     | Quality Health banner has a gradient background that slightly reduces text contrast. "Score 0.00" in red may not meet AA on the gradient.                  |
| Text hints          | 4     | "lower is better", "higher is better", "guardrail pass" under each KPI -- excellent contextual hints.                                                      |
| Consistency         | 3     | Date range uses Dropdown (matching Dashboard), good. Error banner matches Dashboard pattern.                                                               |
| Modern UI theme     | 3     | Quality Health gradient banner is visually distinctive but heavy. The red gradient on a health overview page creates anxiety even for "showing available." |

**Key findings:**

- F-QM-1: Quality Health gradient banner has potential contrast issue with "Score 0.00" text on gradient background.
- F-QM-2: "5 Critical" count shown when there are actually 5 dimensions, not 5 critical issues -- confusing labeling.

---

### 11. Customer Insights

**Screenshot:** `insights-customer-insights--default--1440x900.png`

| Dimension           | Score | Notes                                                                          |
| ------------------- | ----- | ------------------------------------------------------------------------------ |
| Color usage         | 4     | Clean KPI cards. Error banner consistent with Dashboard.                       |
| Alignment           | 4     | 4 KPI cards and 2-column chart layout well-aligned.                            |
| Window/panel sizing | 4     | Good use of space with side-by-side chart panels.                              |
| Overcrowded text    | 4     | KPI labels are shorter here (TOTAL CONVERSATIONS, etc.).                       |
| Spacing             | 4     | Consistent padding and gaps.                                                   |
| Legibility          | 4     | All text readable.                                                             |
| Text hints          | 4     | "Run conversations with pipelines enabled to generate data" -- clear guidance. |
| Consistency         | 4     | Follows Dashboard pattern: Dropdown date range + error banner + KPI cards.     |
| Modern UI theme     | 4     | Clean 2-column layout for chart areas.                                         |

**Key findings:** No significant issues. This is one of the most consistent Insights sub-pages.

---

### 12. Voice Analytics

**Screenshot:** `insights-voice-analytics--default--1440x900.png`

| Dimension           | Score | Notes                                                                                                                                                             |
| ------------------- | ----- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Color usage         | 4     | Error banner in pink/red, KPI cards clean.                                                                                                                        |
| Alignment           | 4     | 6 KPI cards evenly distributed.                                                                                                                                   |
| Window/panel sizing | 4     | Good layout at 1440.                                                                                                                                              |
| Overcrowded text    | 3     | "N/A" values with units ("N/A ms", "N/A %") look odd -- should omit unit when value is N/A.                                                                       |
| Spacing             | 4     | Consistent.                                                                                                                                                       |
| Legibility          | 4     | Readable.                                                                                                                                                         |
| Text hints          | 3     | Error: "Failed to load voice analytics data. Please try again later." -- different tone from sibling pages.                                                       |
| Consistency         | 2     | Time range uses a FOURTH pattern: SegmentedControl with 3 options ("24h", "7d", "30d") -- different values than Analytics SegmentedControl or Dashboard Dropdown. |
| Modern UI theme     | 3     | Clean empty state with phone icon.                                                                                                                                |

**Key findings:**

- F-VA-1: "N/A ms" and "N/A %" display units alongside N/A values -- units should be hidden when value is N/A.
- F-VA-2: Time range uses yet another variant: SegmentedControl with "24h/7d/30d" (different from Analytics' 30m-30d segmented control and Dashboard's 7d/30d/90d dropdown).
- F-VA-3: Error message tone ("Please try again later") differs from sibling pages ("Showing available metrics").

---

### 13. Settings -- Members

**Screenshot:** `settings-members--default--1440x900.png`

| Dimension           | Score | Notes                                                                                               |
| ------------------- | ----- | --------------------------------------------------------------------------------------------------- |
| Color usage         | 4     | Clean table with "admin" role badge in neutral styling. Avatar uses gray circle.                    |
| Alignment           | 4     | Table columns well-aligned. Section headers in sidebar (GENERAL, INTEGRATIONS, etc.) are clean.     |
| Window/panel sizing | 3     | Table takes full content width. "Actions" column is empty but still takes space.                    |
| Overcrowded text    | 3     | Email "studio-video-evidence-modwtgjm-0j5013@e2e-smoke.test" is very long -- truncation would help. |
| Spacing             | 4     | Sidebar sections use consistent spacing with section headers.                                       |
| Legibility          | 4     | All text readable. Table headers in muted text, data in regular foreground.                         |
| Text hints          | 4     | "View and manage who has access to this project." subtitle is clear.                                |
| Consistency         | 4     | Settings sidebar sections match the navigation model well.                                          |
| Modern UI theme     | 4     | Clean table with minimal chrome. "+ Add Member" button in accent color.                             |

**Key findings:**

- F-SM-1: Long email addresses can overflow table cell at narrow viewports -- needs truncation or word-break.

---

### 14. Settings -- API Keys

**Screenshot:** `settings-api-keys--default--1440x900.png`

| Dimension           | Score | Notes                                            |
| ------------------- | ----- | ------------------------------------------------ |
| Color usage         | 4     | Clean. "+ Create Key" button in outline style.   |
| Alignment           | 4     | Tab bar, empty state centered.                   |
| Window/panel sizing | 4     | Good.                                            |
| Overcrowded text    | 4     | Minimal.                                         |
| Spacing             | 4     | Consistent.                                      |
| Legibility          | 4     | All text readable.                               |
| Text hints          | 4     | Good empty-state copy with clear CTA.            |
| Consistency         | 4     | Tabs (SDK Keys / Platform Keys) follow standard. |
| Modern UI theme     | 4     | Clean.                                           |

**Key findings:** No significant issues. Solid surface.

---

### 15. Settings -- Models

**Screenshot:** `settings-models--default--1440x900.png`

| Dimension           | Score | Notes                                                                                                                                       |
| ------------------- | ----- | ------------------------------------------------------------------------------------------------------------------------------------------- |
| Color usage         | 3     | "Configure Workspace" link uses cyan/teal color -- matches `--info` token but is unusual for an action link alongside a filled dark button. |
| Alignment           | 4     | Empty state well-centered.                                                                                                                  |
| Window/panel sizing | 4     | Good.                                                                                                                                       |
| Overcrowded text    | 4     | Clean.                                                                                                                                      |
| Spacing             | 4     | Consistent.                                                                                                                                 |
| Legibility          | 4     | Good.                                                                                                                                       |
| Text hints          | 4     | "The first model you add becomes the default" -- helpful context.                                                                           |
| Consistency         | 3     | Link color (cyan) differs from other clickable links in the app.                                                                            |
| Modern UI theme     | 4     | Clean empty state.                                                                                                                          |

**Key findings:**

- F-MO-1: "Configure Workspace" link uses `text-info` (cyan) while most other links use `text-accent` or are underlined. Inconsistent link styling.

---

### 16. Sessions

**Screenshot:** `sessions--default--1440x900.png`

| Dimension           | Score | Notes                                                                                                                                  |
| ------------------- | ----- | -------------------------------------------------------------------------------------------------------------------------------------- |
| Color usage         | 4     | Clean table. Agent name badges use neutral `bg-background-muted` styling.                                                              |
| Alignment           | 4     | Table columns well-aligned with sort indicator on "Created At".                                                                        |
| Window/panel sizing | 3     | "Cost" column shows "--" for all rows -- empty column wastes horizontal space.                                                         |
| Overcrowded text    | 3     | Session IDs truncated to "s-567a051e-be48-49d2..." -- reasonable. Agent name badge uses monospace-like text that is dense.             |
| Spacing             | 4     | Table row padding consistent.                                                                                                          |
| Legibility          | 4     | All text readable. Monospace agent name badge is legible at `text-xs`.                                                                 |
| Text hints          | 3     | "3 sessions" count is top-right. "Review session logs and trace details" subtitle is helpful. Tab labels (Conversations/Traces) clear. |
| Consistency         | 4     | Table layout matches other data tables in the app.                                                                                     |
| Modern UI theme     | 4     | Clean data table with subtle borders.                                                                                                  |

**Key findings:**

- F-SE-1: "Cost" column is always "--" with no data -- empty column should be hidden or deprioritized.
- F-SE-2: Agent name displayed as full identifier "studio_video_evidence_agent_modwtgjm_0j5013" in a code-like badge -- not user-friendly.

---

### 17. Inbox

**Screenshot:** `inbox--default--1440x900.png`

| Dimension           | Score | Notes                                                                 |
| ------------------- | ----- | --------------------------------------------------------------------- |
| Color usage         | 4     | Filter buttons use standard SegmentedControl styling.                 |
| Alignment           | 4     | Filter bar and empty state centered.                                  |
| Window/panel sizing | 4     | Good.                                                                 |
| Overcrowded text    | 4     | Minimal.                                                              |
| Spacing             | 4     | Consistent.                                                           |
| Legibility          | 4     | All text readable.                                                    |
| Text hints          | 4     | "No pending workflow tasks. Tasks will appear here when..." -- clear. |
| Consistency         | 4     | Good filter bar with context types and checkbox.                      |
| Modern UI theme     | 4     | Clean.                                                                |

**Key findings:** No significant issues. Clean surface.

---

### 18. Deployments

**Screenshot:** `deployments--default--1440x900.png`

| Dimension           | Score | Notes                                                                                                                                                                                                                                                                   |
| ------------------- | ----- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Color usage         | 2     | Environment cards use distinct background colors: Development=light blue/cyan, Staging=light yellow/amber, Production=light green/teal. These appear to use raw color values, NOT the design-token `--success-subtle` / `--warning-subtle` / `--info-subtle` semantics. |
| Alignment           | 4     | Cards are full-width, stacked vertically. Well-aligned.                                                                                                                                                                                                                 |
| Window/panel sizing | 4     | Full-width cards fill the content area well.                                                                                                                                                                                                                            |
| Overcrowded text    | 4     | Clean card layouts.                                                                                                                                                                                                                                                     |
| Spacing             | 4     | Consistent 16px gaps between environment cards.                                                                                                                                                                                                                         |
| Legibility          | 3     | Card text on colored backgrounds could have contrast issues. Black text on light cyan/yellow/green is likely fine but borderline at some shades.                                                                                                                        |
| Text hints          | 3     | "Variables defined here apply to all environments unless overridden" -- good. Toast "Failed to load deployments" shows at bottom.                                                                                                                                       |
| Consistency         | 3     | Each environment card has a "Deploy Now" button in filled dark style -- good. But "Variables" accordion chevron is inconsistent with other accordions in the app.                                                                                                       |
| Modern UI theme     | 3     | The colored environment cards are visually distinctive but the pastel colors feel like raw Tailwind palette, not semantic tokens.                                                                                                                                       |

**Key findings:**

- F-DE-1: Environment card background colors appear to bypass design-token semantic palette -- light cyan, yellow, green are not mapped to `--info-subtle`, `--warning-subtle`, `--success-subtle` respectively.
- F-DE-2: Toast error "Failed to load deployments" appears as bottom-right toast while inline error banners are used on Insights pages -- inconsistent error display pattern.
- F-DE-3: "Base (Default)" card uses `fallback` badge -- jargon for non-technical users.

---

## Phase B: P1 Surface Findings

### 19. Workflows

**Screenshot:** `workflows--default--1440x900.png`

| Dimension           | Score | Notes                                                                                                                         |
| ------------------- | ----- | ----------------------------------------------------------------------------------------------------------------------------- |
| Color usage         | 4     | Clean.                                                                                                                        |
| Alignment           | 4     | Search bar and empty state aligned.                                                                                           |
| Window/panel sizing | 4     | Good.                                                                                                                         |
| Overcrowded text    | 4     | Minimal.                                                                                                                      |
| Spacing             | 4     | Consistent.                                                                                                                   |
| Legibility          | 4     | Readable.                                                                                                                     |
| Text hints          | 4     | "Create your first workflow to automate multi-step processes with triggers, approvals, and notifications." -- excellent copy. |
| Consistency         | 4     | Follows standard list page pattern.                                                                                           |
| Modern UI theme     | 4     | Clean.                                                                                                                        |

**Key findings:** Solid surface, no issues.

---

### 20. Tools

**Screenshot:** `tools--default--1440x900.png`

| Dimension           | Score | Notes                                                          |
| ------------------- | ----- | -------------------------------------------------------------- |
| Color usage         | 4     | Clean.                                                         |
| Alignment           | 4     | Tab bar with counts well-aligned.                              |
| Window/panel sizing | 4     | Good.                                                          |
| Overcrowded text    | 4     | Minimal.                                                       |
| Spacing             | 4     | Consistent.                                                    |
| Legibility          | 4     | Readable.                                                      |
| Text hints          | 4     | "Create your first tool to get started." -- clear.             |
| Consistency         | 4     | Standard pattern.                                              |
| Modern UI theme     | 4     | Clean. Tab badges showing "0" count use muted neutral styling. |

**Key findings:** Solid surface.

---

### 21. Knowledge Bases (search-ai)

**Screenshot:** `search-ai--default--1440x900.png`

| Dimension           | Score | Notes                                                                                                                                                                              |
| ------------------- | ----- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Color usage         | 3     | Warning icon in empty state error is a triangle/exclamation -- uses appropriate semantic color.                                                                                    |
| Alignment           | 4     | Good.                                                                                                                                                                              |
| Window/panel sizing | 4     | Good.                                                                                                                                                                              |
| Overcrowded text    | 4     | Minimal.                                                                                                                                                                           |
| Spacing             | 4     | Consistent.                                                                                                                                                                        |
| Legibility          | 4     | Readable.                                                                                                                                                                          |
| Text hints          | 2     | Error message "R: Request failed (non-JSON response)" exposes internal error context. User should see "Unable to load knowledge bases. The Knowledge Base service may be offline." |
| Consistency         | 4     | Standard list page pattern with search + filters.                                                                                                                                  |
| Modern UI theme     | 4     | Clean.                                                                                                                                                                             |

**Key findings:**

- F-KB-1: Error message "R: Request failed (non-JSON response)" leaks internal implementation detail to user.

---

### 22. Evaluations

**Screenshot:** `evals--default--1440x900.png`

| Dimension           | Score | Notes                                                                                                                                        |
| ------------------- | ----- | -------------------------------------------------------------------------------------------------------------------------------------------- |
| Color usage         | 3     | "Create Personas" and other links use cyan color consistent with `--info` token. Step numbers use gray circles with white text.              |
| Alignment           | 4     | Tab bar well-aligned. Manual setup steps are numbered cleanly.                                                                               |
| Window/panel sizing | 4     | Good.                                                                                                                                        |
| Overcrowded text    | 3     | Step descriptions use em-dash separators ("Create Personas -- -- simulated users") with double em-dashes that look like rendering artifacts. |
| Spacing             | 4     | Consistent.                                                                                                                                  |
| Legibility          | 4     | Readable.                                                                                                                                    |
| Text hints          | 4     | Excellent guided setup with numbered steps and descriptions. "Quick Eval" button with description.                                           |
| Consistency         | 3     | Link color is cyan, consistent with Settings Models link. But inconsistent with other link patterns that don't use colored text.             |
| Modern UI theme     | 4     | Tab bar with icons is polished. "Pipeline Health" banner is a nice touch.                                                                    |

**Key findings:**

- F-EV-1: Double em-dash ("-- --") in step descriptions appears to be a rendering issue. Should be single em-dash.

---

### 23. Connections (Integrations)

**Screenshot:** `connections--default--1440x900.png`

| Dimension           | Score | Notes                                                                                                                                  |
| ------------------- | ----- | -------------------------------------------------------------------------------------------------------------------------------------- |
| Color usage         | 4     | Clean.                                                                                                                                 |
| Alignment           | 3     | "29 available" text is top-left above tabs, but has no visual hierarchy -- it looks like orphaned metadata.                            |
| Window/panel sizing | 4     | Good.                                                                                                                                  |
| Overcrowded text    | 4     | Minimal.                                                                                                                               |
| Spacing             | 3     | "29 available" floats above the page without clear association to the tab system. Missing page title "Connections" or "Integrations".  |
| Legibility          | 4     | Readable.                                                                                                                              |
| Text hints          | 4     | "No connections yet -- browse the connector catalog to get started." -- clear.                                                         |
| Consistency         | 2     | No page title! Every other page has a title ("Tools", "Workflows", "Sessions"). This page just shows "29 available" as the first text. |
| Modern UI theme     | 3     | Clean but missing page header.                                                                                                         |

**Key findings:**

- F-CO-1: Missing page title -- "29 available" appears where title should be. Sidebar shows "Integrations" but content area has no heading.

---

### 24. Guardrails

**Screenshot:** `guardrails-config--default--1440x900.png`

| Dimension           | Score | Notes                                                    |
| ------------------- | ----- | -------------------------------------------------------- |
| Color usage         | 4     | Clean.                                                   |
| Alignment           | 4     | Good.                                                    |
| Window/panel sizing | 4     | Good.                                                    |
| Overcrowded text    | 4     | Minimal.                                                 |
| Spacing             | 4     | Consistent.                                              |
| Legibility          | 4     | Readable.                                                |
| Text hints          | 4     | Excellent empty-state copy about project-level policies. |
| Consistency         | 4     | Standard tabbed layout.                                  |
| Modern UI theme     | 4     | Clean.                                                   |

**Key findings:** Solid surface.

---

### 25. Org Settings

**Screenshot:** `org-settings--default--1440x900.png`

| Dimension           | Score | Notes                                                                                                                             |
| ------------------- | ----- | --------------------------------------------------------------------------------------------------------------------------------- |
| Color usage         | 3     | Bare, almost empty page.                                                                                                          |
| Alignment           | 4     | Centered spinner/icon and text.                                                                                                   |
| Window/panel sizing | 2     | Page shows only a spinner icon, "Settings", and "User settings." text. No sidebar, no content. Appears to be a minimal stub page. |
| Overcrowded text    | 4     | Minimal.                                                                                                                          |
| Spacing             | 3     | Centered but no structure.                                                                                                        |
| Legibility          | 4     | Readable.                                                                                                                         |
| Text hints          | 1     | "User settings." is the only copy -- no explanation of what settings are available, no navigation to sections.                    |
| Consistency         | 1     | Completely different pattern from every other page in the app. No sidebar, no tabs, no content structure.                         |
| Modern UI theme     | 1     | Appears to be a placeholder or stub page. Not a functional settings surface.                                                      |

**Key findings:**

- F-OS-1: Org settings page is a stub -- shows only "Settings / User settings." with no functional content. Missing sidebar, navigation, and actual settings controls.

---

## Phase C: P2 Surface Findings (default viewport only)

Captured but brief review:

- **Templates**: Standard list page, clean, no issues.
- **Governance**: Standard list page, clean, no issues.
- **Module Dependencies**: Standard list page, clean, no issues.
- **Org API Keys**: Captured but follows same pattern as project-level API Keys -- solid.

---

## Cross-Surface Observations

### O-1: Four different time/date range picker patterns across Insights

| Surface                 | Control Type        | Options                                        | Visual Pattern                       |
| ----------------------- | ------------------- | ---------------------------------------------- | ------------------------------------ |
| Dashboard (At a Glance) | DropdownMenu        | 7d, 30d, 90d                                   | Calendar icon + text + chevron       |
| Analytics               | SegmentedControl    | 30m, 1h, 3h, 6h, 12h, 24h, 2d, 7d, 30d, Custom | Horizontal pill group                |
| Billing & Usage         | Inline pill buttons | 7 days, 30 days, 90 days                       | Unstyled pills with filled selection |
| Voice Analytics         | SegmentedControl    | 24h, 7d, 30d                                   | Horizontal pill group                |
| Quality Monitor         | DropdownMenu        | 7d, 30d, 90d                                   | Calendar icon + text + chevron       |
| Customer Insights       | DropdownMenu        | 7d, 30d, 90d                                   | Calendar icon + text + chevron       |
| Agent Performance       | None                | --                                             | No date range control                |
| Sessions                | DropdownMenu        | Last 7 days                                    | Calendar icon + text + chevron       |

### O-2: Inconsistent zero/empty value display

| Surface                 | Value Display           |
| ----------------------- | ----------------------- |
| Overview KPI "AGENTS"   | "1"                     |
| Overview KPI "SESSIONS" | "--" (em-dash)          |
| Overview KPI "DEPLOYED" | "0 / 1" (fraction)      |
| Quality Monitor KPIs    | "0.00"                  |
| Voice Analytics KPIs    | "N/A"                   |
| Customer Insights KPIs  | "0" and "--" mixed      |
| Dashboard KPIs          | "0", "0.0%", "--", "$0" |

### O-3: Error/degraded state display inconsistency

| Pattern                              | Used On                                                        |
| ------------------------------------ | -------------------------------------------------------------- |
| Inline full-width pink banner        | Dashboard, Quality Monitor, Customer Insights, Voice Analytics |
| Bottom-right toast                   | Deployments                                                    |
| Centered empty state with error icon | Knowledge Bases                                                |
| No error (just empty state)          | Agent Performance, Billing                                     |

### O-4: Hardcoded Tailwind palette colors (14 instances)

Files with violations of the `@agent-platform/design-tokens` mandate:

- `SourceViewer.tsx` (5 instances: `text-yellow-300`, `text-yellow-400`, `text-orange-400`, `text-cyan-400`, `text-pink-400`)
- `QueryPlaygroundTab.tsx` (4 instances: `bg-red-500`, `bg-blue-500`, `bg-green-500`, `bg-yellow-500`)
- `ExecutionDebugPanel.tsx` (3 instances: `bg-yellow-500/10`, `text-yellow-500`, `text-green-500`)
- `MembersPage.tsx` (1 instance: `text-purple-500`)
- `ArchGradientMark.tsx` (1 instance: `bg-indigo-500/[0.08]`)

### O-5: Missing page title on Connections page

The Integrations/Connections page has no page title in the content area. "29 available" appears where a title should be.

### O-6: Org Settings is a stub page

The `/settings/organization` route renders a minimal "Settings / User settings." placeholder with no navigation or content.

---

## Viewport Responsiveness Summary (1280 vs 1440 vs 1920)

| Surface            | 1280                 | 1440 | 1920                 | Notes                                               |
| ------------------ | -------------------- | ---- | -------------------- | --------------------------------------------------- |
| Projects Dashboard | OK                   | OK   | Sparse               | Content area narrow; 1920 has ~500px unused         |
| Insights Dashboard | Cramped KPIs         | OK   | OK                   | 6 KPI cards cause label wrapping at 1280            |
| Agent Editor       | Textarea shrinks     | OK   | Wasted space         | Textarea width fixed, doesn't expand                |
| Agent Chat         | Session panel crowds | OK   | Chat area oversized  | Session list stays fixed 270px at all sizes         |
| Sessions table     | Columns crowd        | OK   | Excessive whitespace | Agent name badge clips at 1280                      |
| Settings sidebar   | 16 items scrollable  | OK   | OK                   | Sidebar is scrollable at all sizes which is correct |

---

## Phase D: Populated-State Findings

**Project:** Saludsa Production (`proj-saludsa-production`)
**Project stats:** 18 agents, 44 tools, 1 active deployment (dev), 0 workflows, 0 sessions
**Viewport:** 1440x900
**Capture tool:** `populated-state-capture` scenario via `studio-video-evidence` harness
**Note:** Phase D re-captures P0 surfaces against a real populated project and adds 5 detail-level surfaces. Findings here focus on issues that ONLY manifest with real data present -- name truncation, number formatting, status pills, loading states, error handling.

### Phase D Capture Inventory

| Surface                     | Screenshot                                 | Data Present          | Status     |
| --------------------------- | ------------------------------------------ | --------------------- | ---------- |
| Project Home (Overview)     | `project-home-populated.png`               | 18 agents, 44 tools   | Populated  |
| Agents List                 | `agents-list-populated.png`                | 18 agent cards        | Populated  |
| Agent Editor                | `agent-editor-populated.png`               | Loading spinner       | Stuck load |
| Agent Detail Overview       | `agent-detail-overview-populated.png`      | Loading spinner       | Stuck load |
| Sessions                    | `sessions-populated.png`                   | Empty (0 sessions)    | Empty      |
| Session Detail              | `session-detail-populated.png`             | Loading spinner       | Stuck load |
| Deployments                 | `deployments-populated.png`                | 1 active, 18 agents   | Populated  |
| Deployment Channel Detail   | `deployment-channel-detail-populated.png`  | Same as deployments   | Populated  |
| Workflows                   | `workflows-populated.png`                  | Empty state           | Empty      |
| Workflow Detail             | `workflow-detail-populated.png`            | Skeleton loading      | Stuck load |
| Tools                       | `tools-populated.png`                      | 44 tools              | Populated  |
| Tool Detail                 | `tool-detail-populated.png`                | Loading spinner       | Stuck load |
| Knowledge Bases (Search AI) | `search-ai-populated.png`                  | Error state           | Error      |
| Evals                       | `evals-populated.png`                      | Empty (guided setup)  | Empty      |
| Inbox                       | `inbox-populated.png`                      | Skeleton placeholders | Loading    |
| Insights Dashboard          | `insights-dashboard-populated.png`         | KPI skeleton + empty  | Partial    |
| Insights Analytics          | `insights-analytics-populated.png`         | Empty content area    | Empty      |
| Insights Billing            | `insights-billing-populated.png`           | Empty state           | Empty      |
| Insights Agent Performance  | `insights-agent-performance-populated.png` | Empty state           | Empty      |
| Insights Quality Monitor    | `insights-quality-monitor-populated.png`   | Score cards (0.40)    | Partial    |
| Insights Customer Insights  | `insights-customer-insights-populated.png` | Error banner + empty  | Error      |
| Insights Voice Analytics    | `insights-voice-analytics-populated.png`   | N/A values            | Empty      |
| Settings Members            | `settings-members-populated.png`           | Loading spinner       | Stuck load |
| Settings API Keys           | `settings-api-keys-populated.png`          | Loading spinner       | Stuck load |
| Settings Models             | `settings-models-populated.png`            | Loading spinner       | Stuck load |
| Settings Runtime Config     | `settings-runtime-config-populated.png`    | Loading spinner       | Stuck load |
| Settings Config Variables   | `settings-config-vars-populated.png`       | Loading spinner       | Stuck load |
| Settings Auth Profiles      | `settings-auth-profiles-populated.png`     | Empty state           | Empty      |

---

### D-1. Project Home (Overview) -- Populated

**Screenshot:** `project-home-populated.png`

| Dimension           | Score | Notes                                                                                                                                             |
| ------------------- | ----- | ------------------------------------------------------------------------------------------------------------------------------------------------- |
| Color usage         | 3     | KPI cards on white background are fine. The "DEPLOYED 1/18" card has a cyan border accent that is the only color variance and reads well.         |
| Alignment           | 4     | KPI row is evenly spaced. Agent list items align with bullet-icon pattern. Right sidebar (RESOURCES, ACTIVE DEPLOYMENTS, QUICK ACTIONS) is clean. |
| Window/panel sizing | 3     | Two-column layout fills the viewport well. Agent list in left column scrolls past fold with 18 agents -- no pagination control.                   |
| Overcrowded text    | 3     | Agent names are readable. "samy supervisor" and "broker entry gateway" display well. Long list scrolls off-screen without visual cue.             |
| Spacing             | 4     | 48px rows for agent items are consistent. Section headers (AGENTS, RESOURCES, etc.) have proper 16px spacing.                                     |
| Legibility          | 4     | Section headers in uppercase `text-xs` muted style. Agent names in regular weight.                                                                |
| Text hints          | 2     | KPI cards show "--" for SESSIONS, MESSAGES, TOKENS, EST. COST -- same inconsistency noted in Phase A (F-PH-1). No tooltip explaining the dash.    |
| Consistency         | 2     | The "1 Issue" red badge in bottom-left appears intermittently. KPI zero-value representation still inconsistent ("--" vs "1 / 18").               |
| Modern UI theme     | 4     | Clean layout with proper card elevation. Quick Actions section uses large clickable cards with icons.                                             |

**Key findings:**

- F-D-PH-1: **KPI zero-value inconsistency persists with data.** Even with 18 agents and 44 tools, SESSIONS/MESSAGES/TOKENS/EST. COST all show "--". The DEPLOYED card shows "1 / 18" with a fraction format. This is 4 different zero-representations on one page: "--", "44 Tools" (text), "samy_supervisor" (name), "1 / 18" (fraction).
- F-D-PH-2: **Agent list has no scroll indicator.** With 18 agents, the list scrolls past the fold but there is no visible scrollbar, scroll shadow, or "show more" affordance. Users may not realize more agents exist below.
- F-D-PH-3: **Agent names use raw identifiers.** Names like "pca xpr transfer", "coverage certificates" are the internal identifiers, not friendly display names. This is the source data, not a UI bug, but the UI could capitalize first letters or provide display-name aliasing.
- F-D-PH-4: **"1 Issue" red notification badge** appears in bottom-left overlapping sidebar collapse button. Source is the Next.js HMR/compilation status bar. In production this would not appear, but during dev it obscures the sidebar collapse affordance.

---

### D-2. Agents List -- Populated

**Screenshot:** `agents-list-populated.png`

| Dimension           | Score | Notes                                                                                                                                                                                              |
| ------------------- | ----- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Color usage         | 3     | Agent cards use white bg on light gray page. Status badges: "Draft" (gray), "Supervisor" (gray pill), "Reasoning" (orange/amber pill), "Flow" (gray), "Mixed" (gray). Only "Reasoning" uses color. |
| Alignment           | 3     | 3-column card grid is properly aligned. Topology warning banner spans full width above cards. The large gray area between the filter bar and warning banner is unexplained empty space.            |
| Window/panel sizing | 2     | ~60% of the visible area is a blank gray rectangle between the search/filter bar and the topology warning. This appears to be a canvas/topology view area that rendered empty.                     |
| Overcrowded text    | 3     | Agent descriptions truncate with "..." appropriately (e.g., "Route user messages to the correct specialist agent. Never answer users directly. Enforce identit...").                               |
| Spacing             | 3     | Card grid gap is consistent (~16px). Session count and timestamp are in card footer. The "2d ago" timestamps are well-placed.                                                                      |
| Legibility          | 4     | Agent names at 16px weight are readable. Description text at ~14px muted color is clear. Badge pills have adequate contrast.                                                                       |
| Text hints          | 3     | "0 sessions" with a chain-link icon for tools. Timestamps show "2d ago" relative format. No absolute time on hover tooltip.                                                                        |
| Consistency         | 2     | The topology warning banner "Topology incomplete -- 14 agents failed to compile (14 errors)" is a full-width orange/red banner. It appears as a persistent error that dominates the page.          |
| Modern UI theme     | 3     | Card pattern is modern. Status pills are compact. But the large empty gray area and prominent error banner reduce visual quality.                                                                  |

**Key findings:**

- F-D-AL-1: **Massive blank gray area** (~400px tall) between filter bar and topology warning banner. This appears to be a canvas/topology visualization area that failed to render or is empty. It wastes prime viewport real estate and makes the page look broken.
- F-D-AL-2: **Agent name truncation** observed: "contract data assist..." truncates mid-word. The truncation ellipsis breaks the name at a poor point. Should use CSS `word-break` or min-width to ensure complete word display or at least truncate at a word boundary.
- F-D-AL-3: **Topology error banner is persistent and loud.** "Topology incomplete -- 14 agents failed to compile (14 errors)" in orange text dominates the page. For 14/18 agents failing compilation, this is correct severity, but the banner has no dismiss/collapse affordance and no "show details" expand.
- F-D-AL-4: **Status badge colors are inconsistent.** "Draft" is gray, "Supervisor" is gray, "Reasoning" is orange/amber, "Flow" is gray, "Mixed" is gray. Only "Reasoning" gets color treatment, making it unclear if these are types or statuses.

---

### D-3. Agent Editor -- Populated (Loading State)

**Screenshot:** `agent-editor-populated.png`

| Dimension           | Score | Notes                                                                                                          |
| ------------------- | ----- | -------------------------------------------------------------------------------------------------------------- |
| Color usage         | 2     | Entire page is white/light gray with a centered spinner. No visual hierarchy.                                  |
| Alignment           | 3     | Sidebar icons are vertically aligned. Spinner is centered.                                                     |
| Window/panel sizing | 1     | Full content area shows nothing but a spinner. Sidebar is collapsed to icon-only mode, losing all labels.      |
| Overcrowded text    | 4     | No text visible (nothing loaded).                                                                              |
| Spacing             | 3     | Icon sidebar has consistent spacing.                                                                           |
| Legibility          | 2     | "Compiling..." badge at bottom-left is barely readable in small muted text.                                    |
| Text hints          | 1     | No indication WHAT is loading, for WHICH agent, or how long it will take. Just a generic spinner.              |
| Consistency         | 2     | Sidebar switches to icon-only mode here but shows labels on other pages. Inconsistent sidebar expansion state. |
| Modern UI theme     | 2     | Bare spinner with no skeleton, no progress indication, no contextual messaging.                                |

**Key findings:**

- F-D-AE-1: **Agent editor shows infinite loading spinner** with zero contextual information. No agent name, no progress bar, no skeleton. Users cannot tell if the page is loading content, compiling DSL, or stuck in an error state.
- F-D-AE-2: **Sidebar collapses to icon-only mode** when navigating to the agent editor. This is inconsistent with all other pages that show the full labeled sidebar. The collapsed sidebar loses critical navigation context.
- F-D-AE-3: **"Compiling..." yellow dot badge** at bottom-left is the only status indicator. It is tiny, low-contrast, and positioned at the extreme bottom-left corner where users rarely look. Should be promoted to a visible banner or inline progress indicator.

---

### D-4. Agent Detail Overview -- Populated (Loading State)

**Screenshot:** `agent-detail-overview-populated.png`

Same issues as D-3 (agent editor). Identical spinner-only state with collapsed sidebar. No agent name visible. No skeleton.

**Additional finding:**

- F-D-ADO-1: This is a separate route from the editor but renders identically when stuck loading. Users have no way to distinguish "agent overview" from "agent editor" from the loading screen alone.

---

### D-5. Sessions List -- Populated (Empty Time Range)

**Screenshot:** `sessions-populated.png`

| Dimension           | Score | Notes                                                                                                                    |
| ------------------- | ----- | ------------------------------------------------------------------------------------------------------------------------ |
| Color usage         | 4     | Clean white table with gray column headers. "Last 7 days" dropdown with calendar icon is consistent.                     |
| Alignment           | 4     | Table headers (Session ID, Agent, Created At, Traces, Duration, Messages, Cost) are evenly distributed.                  |
| Window/panel sizing | 3     | Table fills the content area well. Empty state text is vertically centered.                                              |
| Overcrowded text    | 4     | No crowding.                                                                                                             |
| Spacing             | 4     | Table column widths appear reasonable. Header row has proper padding.                                                    |
| Legibility          | 4     | "0 sessions" in top-right is clear. Empty-state message is readable.                                                     |
| Text hints          | 3     | "No sessions found for the selected time range." is helpful but no suggestion to expand the range.                       |
| Consistency         | 3     | Tabs "Conversations" and "Traces" are underline-style. "Created At" has a sort indicator (chevron). Good table patterns. |
| Modern UI theme     | 3     | Clean table layout. Minor: empty state has no illustration, just plain text.                                             |

**Key findings:**

- F-D-SL-1: **Sort indicator present on "Created At"** only. No visual cue on other columns about whether they are sortable. Users may not discover multi-column sort.
- F-D-SL-2: **Empty-state copy could be more actionable.** "No sessions found for the selected time range." is informative but doesn't suggest action. Could add: "Try expanding the time range or testing an agent to generate sessions."
- F-D-SL-3: **"0 sessions" counter** in top-right is plain text. Inconsistent with other count displays (e.g., agents list shows "18 agents" in a subtitle).

---

### D-6. Session Detail -- Populated (Loading State)

**Screenshot:** `session-detail-populated.png`

| Dimension           | Score | Notes                                                                                                                 |
| ------------------- | ----- | --------------------------------------------------------------------------------------------------------------------- |
| Color usage         | 3     | White content area with "Loading session..." text. Header shows session ID and metadata.                              |
| Alignment           | 3     | Session ID in header, "Back to Sessions" link at left, "Traces: 0" and "Session Cost: --" at right.                   |
| Window/panel sizing | 2     | Massive empty white area with a centered spinner. No skeleton layout.                                                 |
| Overcrowded text    | 4     | No text crowding.                                                                                                     |
| Spacing             | 3     | Header metadata spacing is clean.                                                                                     |
| Legibility          | 2     | Session ID displayed as raw UUID fragment "s-8a376dd9-9299-4227" -- not user-friendly.                                |
| Text hints          | 1     | "Traces:: 0" has a double colon typo. "Session Cost:: --" also has double colon. "Loading session..." is generic.     |
| Consistency         | 1     | Double-colon formatting ("Traces:: 0", "Session Cost:: --") is a clear bug. The "--" sub-label for agent name is raw. |
| Modern UI theme     | 2     | Plain spinner with "Loading session..." text. No skeleton. No contextual info about what will appear.                 |

**Key findings:**

- F-D-SD-1: **Double-colon formatting bug.** "Traces:: 0" and "Session Cost:: --" both have double colons. This is a string template bug (likely `Traces: ${separator} ${value}` where separator is ":" again).
- F-D-SD-2: **Session ID as page title** is not user-friendly. "s-8a376dd9-9299-4227" is a truncated UUID. Should show agent name, timestamp, or a more descriptive header.
- F-D-SD-3: **"--" sub-label** appears below the session ID as the agent name placeholder. When the session has no agent name resolved, it shows raw "--" with no label.
- F-D-SD-4: **Spinner stuck on "Loading session..."** -- same pattern as agent editor. No timeout, no retry, no skeleton.

---

### D-7. Deployments -- Populated

**Screenshot:** `deployments-populated.png`

| Dimension           | Score | Notes                                                                                                                                   |
| ------------------- | ----- | --------------------------------------------------------------------------------------------------------------------------------------- |
| Color usage         | 4     | Environment cards use distinct tint backgrounds: Development (cyan/light blue), Staging (gray), Production (warm/light red/pink).       |
| Alignment           | 4     | Cards stack vertically. Agent version pills flow in a tag-cloud layout within the Development card.                                     |
| Window/panel sizing | 3     | Cards fill the content area well. At 18 agents, the tag-cloud of version pills wraps to 4 rows, which is dense but manageable.          |
| Overcrowded text    | 3     | Agent version pills "broker_entry_gateway@0.1.0" are small but readable. With 18 agents, the pill cloud is visually dense.              |
| Spacing             | 4     | Section spacing between environment cards is generous (~24px). Pill spacing is consistent.                                              |
| Legibility          | 4     | "Development Active" green badge is clear. "deploy-s active" green pill at deployment level. Agent pills in monospace-like font.        |
| Text hints          | 3     | "18 agents" and "2d ago" are helpful. "Promote" and "Retire" actions are labeled. "Deploy Now" buttons are clear.                       |
| Consistency         | 4     | Three environment cards follow the same structure (header + deployment info + variables accordion). Colors distinguish severity levels. |
| Modern UI theme     | 4     | Card-based layout with color-coded environments is a strong pattern. Action buttons (Promote, Retire, Deploy Now) are well-placed.      |

**Key findings:**

- F-D-DP-1: **Agent version pills are dense at scale.** With 18 agents, the pill cloud in the Development card takes 4 rows. At 50+ agents, this would become unwieldy. Consider a collapsible/expandable pattern (e.g., "18 agents" summary that expands to show pills).
- F-D-DP-2: **"Base (Default) fallback" label** in the top section is unclear. The word "fallback" is in a gray badge but its meaning (this is the fallback environment config) is not obvious without documentation.
- F-D-DP-3: **Tabs (Environments, Channels, API Keys)** provide good page-level organization. This is one of the better-structured populated pages.

---

### D-8. Workflows -- Populated (Empty State)

**Screenshot:** `workflows-populated.png`

Empty state. "No workflows yet" with illustration and "+ New Workflow" CTA. Well-designed empty state with clear description text.

No data-specific findings. Empty state is appropriate and well-designed.

---

### D-9. Workflow Detail -- Populated (Skeleton Loading)

**Screenshot:** `workflow-detail-populated.png`

| Dimension           | Score | Notes                                                                                                                   |
| ------------------- | ----- | ----------------------------------------------------------------------------------------------------------------------- |
| Color usage         | 2     | Gray skeleton blocks on white. The skeleton pattern is uniform gray with no animation visible in the static screenshot. |
| Alignment           | 3     | Skeleton blocks suggest a header row, content rows, and a detail section. Layout structure is implied.                  |
| Window/panel sizing | 3     | Skeleton fills the content area proportionally.                                                                         |
| Overcrowded text    | 4     | No text visible.                                                                                                        |
| Spacing             | 3     | Skeleton blocks have consistent gaps.                                                                                   |
| Legibility          | 2     | "/" character appears in the header area, suggesting a breadcrumb that failed to render fully.                          |
| Text hints          | 1     | No contextual information about what is loading. Only gray blocks.                                                      |
| Consistency         | 2     | This is the only page that uses skeleton loading blocks. Others use spinners. Inconsistent loading patterns.            |
| Modern UI theme     | 3     | Skeleton loading is more modern than a spinner, but the lack of animation (pulse/shimmer) makes it look broken.         |

**Key findings:**

- F-D-WD-1: **Skeleton loading pattern is used here but nowhere else.** Other pages (agent editor, session detail, settings pages) all use spinners. This inconsistency suggests the skeleton pattern was added for workflows specifically but not standardized.
- F-D-WD-2: **Orphan "/" breadcrumb** appears in the header, suggesting the page tried to render a breadcrumb (e.g., "Workflows / {name}") but the name failed to load.
- F-D-WD-3: **No fallback timeout.** If the skeleton persists, users have no recourse -- no retry button, no error message.

---

### D-10. Tools List -- Populated

**Screenshot:** `tools-populated.png`

| Dimension           | Score | Notes                                                                                                                                             |
| ------------------- | ----- | ------------------------------------------------------------------------------------------------------------------------------------------------- |
| Color usage         | 3     | Tool type badges use green ("@HTTP") consistently. Tab bar (HTTP Tools, Knowledge Base, Workflows, MCP Servers) uses underline style.             |
| Alignment           | 4     | Two-column grid of tool cards. Each card has name, description, version, and tag.                                                                 |
| Window/panel sizing | 3     | 44 tools visible with scrolling. Grid fills the viewport well. The tab-based categorization (HTTP Tools: 38, Knowledge Base: 0, etc.) is helpful. |
| Overcrowded text    | 2     | Tool descriptions are multi-line and dense. Cards like "close_zendesk_ticket" have 3 lines of description text that competes with the name.       |
| Spacing             | 3     | Cards have consistent internal padding. Grid gap is ~16px.                                                                                        |
| Legibility          | 3     | Tool names in underscore_case ("close_zendesk_ticket", "validate_user_id") are readable but not ideal for scanning.                               |
| Text hints          | 3     | Version numbers "v1.0" are shown in muted text. "@HTTP" badge indicates tool type. Source path is shown in small text.                            |
| Consistency         | 3     | Tab-based categorization with counts is a good pattern. Card layout is consistent.                                                                |
| Modern UI theme     | 3     | Card grid is clean. Tab bar with counts is modern. Dense information layout is appropriate for a tools inventory page.                            |

**Key findings:**

- F-D-TL-1: **Tool names in underscore_case** are the raw identifiers. Not a UI bug, but for tools like "close_zendesk_ticket" and "validate_out_of_hours", the underscore-separated names are harder to scan than Title Case or spaced names.
- F-D-TL-2: **Tool descriptions compete with names.** Some cards have 3 lines of description that overwhelm the tool name. Consider truncating descriptions to 1-2 lines with "show more."
- F-D-TL-3: **Tab counts are helpful.** "HTTP Tools 38", "Knowledge Base", "Workflows", "MCP Servers" with counts in the tab headers is a strong pattern for quick inventory overview.
- F-D-TL-4: **No search/filter visible in this capture.** The tools page should have a search bar (visible in the empty state) but it may have scrolled out of view with 44 tools.

---

### D-11. Tool Detail -- Populated (Loading State)

**Screenshot:** `tool-detail-populated.png`

Identical spinner pattern to agent editor. Full-page loading spinner with "Compiling..." badge. No tool name, no skeleton.

Same findings as F-D-AE-1 through F-D-AE-3 apply.

---

### D-12. Knowledge Bases (Search AI) -- Error State

**Screenshot:** `search-ai-populated.png`

| Dimension           | Score | Notes                                                                                                                     |
| ------------------- | ----- | ------------------------------------------------------------------------------------------------------------------------- |
| Color usage         | 3     | Error state uses a warning triangle icon in amber/gray. "Retry" button is outlined/default style.                         |
| Alignment           | 4     | Error content is vertically and horizontally centered. Header, search bar, and filter row are properly aligned.           |
| Window/panel sizing | 3     | Error state fills center of content area appropriately.                                                                   |
| Overcrowded text    | 4     | Minimal text in error state.                                                                                              |
| Spacing             | 4     | Error icon, message, detail, and retry button have proper vertical spacing.                                               |
| Legibility          | 4     | "Failed to load knowledge bases" in bold. "AppError: Request failed (non-JSON response)" in muted detail.                 |
| Text hints          | 2     | "AppError: Request failed (non-JSON response)" is a technical error message exposed to users. Should be sanitized.        |
| Consistency         | 3     | Error state pattern (icon + title + detail + retry) is well-structured. But the detail message leaks internal error type. |
| Modern UI theme     | 3     | Centered error with retry is a standard pattern. Warning icon is appropriate.                                             |

**Key findings:**

- F-D-KB-1: **Technical error message exposed to users.** "AppError: Request failed (non-JSON response)" is an internal error format. Users should see "Unable to load knowledge bases. Please try again." The technical detail should go to the browser console or a "show details" expandable.
- F-D-KB-2: **Error is likely due to SearchAI service being down.** The SearchAI runtime (port 3004/3005) may not be running. The UI correctly shows a retry button, but doesn't indicate the root cause (backend service unavailable).

---

### D-13. Evals -- Populated (Empty State)

**Screenshot:** `evals-populated.png`

| Dimension           | Score | Notes                                                                                                                                    |
| ------------------- | ----- | ---------------------------------------------------------------------------------------------------------------------------------------- |
| Color usage         | 4     | Clean white background. "Quick Eval" button in black is the primary CTA. Numbered steps with cyan links.                                 |
| Alignment           | 4     | Centered content with play icon. Tab bar (Personas, Scenarios, Evaluators, Eval Sets, Runs) is evenly distributed.                       |
| Window/panel sizing | 3     | Content is narrow-centered. The "Pipeline Health" bar at top fills width. Main CTA area is vertically centered.                          |
| Overcrowded text    | 4     | Clean, spacious layout.                                                                                                                  |
| Spacing             | 4     | Generous spacing between the "Quick Eval" CTA and the "Or set up manually" card. Numbered steps have clear line spacing.                 |
| Legibility          | 4     | All text is readable. Links are cyan with clear labels.                                                                                  |
| Text hints          | 4     | Excellent guided setup copy: "AI-generates personas, scenarios & evaluators, then runs automatically."                                   |
| Consistency         | 3     | Tab bar uses underline style consistent with other pages. "Pipeline Health" bar with "Test Configuration" button is unique to this page. |
| Modern UI theme     | 4     | The guided setup flow with numbered steps and dual CTA (quick eval + manual setup) is excellent UX.                                      |

**Key findings:**

- F-D-EV-1: **Evals empty state is exemplary.** This is the best-designed empty state in the app. Clear dual-path onboarding (Quick Eval vs Manual), numbered steps, descriptive copy. Other empty states should follow this pattern.
- F-D-EV-2: **"Pipeline Health" bar** at top with "Test Configuration" button provides persistent status visibility. Good pattern for operational pages.

---

### D-14. Inbox -- Populated (Skeleton Loading)

**Screenshot:** `inbox-populated.png`

| Dimension           | Score | Notes                                                                                                                                                   |
| ------------------- | ----- | ------------------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------- |
| Color usage         | 3     | Skeleton blocks in light gray on white cards. Tab bar (Workflow, Agent                                                                                  | All, Approvals, Data Entry) uses pill/badge style. |
| Alignment           | 4     | Cards stack vertically with consistent width. Filter tabs are left-aligned.                                                                             |
| Window/panel sizing | 3     | 4 skeleton cards visible. Cards fill content width.                                                                                                     |
| Overcrowded text    | 4     | No text visible (skeleton state).                                                                                                                       |
| Spacing             | 4     | Card gap is consistent (~16px). Card internal padding matches.                                                                                          |
| Legibility          | 2     | "Include completed" checkbox at top-right is small and easy to miss.                                                                                    |
| Text hints          | 2     | Skeleton blocks give no indication of what data will appear. No shimmer animation visible in static capture.                                            |
| Consistency         | 2     | This is the second page with skeleton loading (after workflow detail). But the skeleton pattern differs -- these are card shapes vs rectangular blocks. |
| Modern UI theme     | 3     | Card-based skeleton with filter tabs is modern. But stuck skeleton suggests loading failure rather than progress.                                       |

**Key findings:**

- F-D-IN-1: **Inbox skeleton cards appear permanently.** The 4 gray skeleton cards may indicate actual items loading or a permanent loading state. Without shimmer animation or a timeout/error fallback, users cannot distinguish "still loading" from "broken."
- F-D-IN-2: **Filter tab pattern (Workflow | Agent + All | Approvals | Data Entry)** is unique to Inbox. The two-tier filter (source type + item type) is a good pattern but the visual hierarchy between the two groups is unclear -- both use the same pill/badge style.

---

### D-15. Insights Dashboard -- Populated (Partial Data)

**Screenshot:** `insights-dashboard-populated.png`

| Dimension           | Score | Notes                                                                                                                         |
| ------------------- | ----- | ----------------------------------------------------------------------------------------------------------------------------- |
| Color usage         | 3     | KPI skeleton blocks at top in light gray. "Last 30 days" dropdown with calendar icon.                                         |
| Alignment           | 4     | KPI cards in a row at top. Chart sections stacked below with proper margins.                                                  |
| Window/panel sizing | 3     | Two large chart sections ("Conversation Volume & Containment Rate" and "Outcome Distribution") fill content area.             |
| Overcrowded text    | 4     | Clean layout with section headers and empty-state messages.                                                                   |
| Spacing             | 4     | 24px gap between sections. Chart areas have generous internal padding.                                                        |
| Legibility          | 4     | Section headers are bold. Empty-state messages are centered and readable.                                                     |
| Text hints          | 3     | "No timeseries data available yet. Run conversations with pipelines enabled to generate data." is helpful and actionable.     |
| Consistency         | 3     | KPI cards at top are still in skeleton state (gray blocks) while the chart areas show empty-state text. Mixed loading states. |
| Modern UI theme     | 3     | Tab bar (Overview, Trends, ROI, Conversations) is clean. Empty states with explanatory text are well-designed.                |

**Key findings:**

- F-D-ID-1: **Mixed loading states.** KPI cards at the top remain as gray skeleton blocks while chart sections below have resolved to empty states with messages. This creates a visual inconsistency where part of the page looks "still loading" and part looks "no data."
- F-D-ID-2: **Empty-state copy is actionable.** "Run conversations with pipelines enabled to generate data" tells users exactly what to do. This is a good pattern.

---

### D-16. Insights Quality Monitor -- Populated (Partial Data)

**Screenshot:** `insights-quality-monitor-populated.png`

| Dimension           | Score | Notes                                                                                                                                                       |
| ------------------- | ----- | ----------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Color usage         | 3     | "Quality Health" banner uses a gradient (pink-to-rose) with "Score 0.40" in white. "3 Critical" (red dot), "2 Healthy" (green dot).                         |
| Alignment           | 4     | Score cards (OVERALL QUALITY, HALLUCINATION RATE, etc.) in a 5-column grid. Dimension Details list below.                                                   |
| Window/panel sizing | 3     | Score cards fill width well. Dimension Details cards are full-width rows with proper spacing.                                                               |
| Overcrowded text    | 3     | 5 KPI cards with labels, values, and sub-labels are dense but readable. "CONTEXT PRESERVATION" label is long in its card.                                   |
| Spacing             | 4     | KPI cards have consistent padding. Dimension Details rows have proper vertical spacing.                                                                     |
| Legibility          | 4     | Score values ("0.40", "0.00") in large bold font. Sub-labels ("lower is better", "guardrail pass") in muted small text.                                     |
| Text hints          | 4     | Info icons (i) next to each KPI label provide tooltip affordance. Sub-labels explain metric direction ("lower is better").                                  |
| Consistency         | 3     | "Critical" (red pill) and "Healthy" (green pill) badges on dimension rows are clear. Score of "0.00" in teal text is confusing -- 0.00 could be bad or N/A. |
| Modern UI theme     | 4     | Quality Health gradient banner is visually striking. Score card layout with info tooltips is polished.                                                      |

**Key findings:**

- F-D-QM-1: **Score "0.00" is ambiguous.** Hallucination Rate "0.00 lower is better" and Knowledge Gaps "0.00 lower is better" -- does 0.00 mean "no data" or "perfect score"? With "0 evaluated" shown on Overall Quality, these are likely N/A values displayed as 0.00, which is misleading.
- F-D-QM-2: **Quality Evaluation dimension shows "Critical" with Score 0.00 in teal text.** The teal color for 0.00 suggests a neutral or good value, but the "Critical" badge suggests a problem. Color-coding should match severity.
- F-D-QM-3: **Hallucination Detection shows "Healthy" with Score 0.00.** This is logically correct (0 hallucinations = healthy) but only if data was actually evaluated. With "0 evaluated" at the top, this is a false positive -- showing "Healthy" when no evaluation occurred.

---

### D-17. Insights Customer Insights -- Error State

**Screenshot:** `insights-customer-insights-populated.png`

| Dimension           | Score | Notes                                                                                                                                 |
| ------------------- | ----- | ------------------------------------------------------------------------------------------------------------------------------------- |
| Color usage         | 3     | Error banner in pink/rose background with red text. KPI cards below in white.                                                         |
| Alignment           | 4     | Error banner spans full width. KPI cards (4-column grid) and chart sections are well-aligned.                                         |
| Window/panel sizing | 3     | Page shows partial content -- KPIs loaded (showing 0 and "--") while charts show empty states.                                        |
| Overcrowded text    | 4     | Clean layout despite error state.                                                                                                     |
| Spacing             | 4     | Good spacing between sections.                                                                                                        |
| Legibility          | 4     | Error message is readable. KPI labels are clear.                                                                                      |
| Text hints          | 2     | "Failed to load some analytics data. Showing available metrics." is a good partial-failure message but doesn't say WHICH data failed. |
| Consistency         | 2     | KPIs show "0" for counts and "--" for AVG SENTIMENT and FRUSTRATION RATE. Same "--" vs "0" inconsistency from Phase A.                |
| Modern UI theme     | 3     | Partial-failure pattern (show what we can + error banner) is good UX. Better than a full-page error.                                  |

**Key findings:**

- F-D-CI-1: **Partial-failure pattern is well-implemented.** The page gracefully degrades: shows available metrics + error banner for failed ones. This is good error handling and should be the standard pattern.
- F-D-CI-2: **Error banner doesn't specify which data failed.** "Failed to load some analytics data" is vague. Should specify: "Sentiment and trend data unavailable" or similar.
- F-D-CI-3: **"--" vs "0" inconsistency.** AVG SENTIMENT shows "--" while TOTAL CONVERSATIONS shows "0". Both represent "no data" but display differently.

---

### D-18. Insights Voice Analytics -- Empty State

**Screenshot:** `insights-voice-analytics-populated.png`

| Dimension           | Score | Notes                                                                                                                 |
| ------------------- | ----- | --------------------------------------------------------------------------------------------------------------------- |
| Color usage         | 3     | KPI cards show "N/A" with unit suffixes ("ms", "%"). Clean layout.                                                    |
| Alignment           | 4     | 6 KPI cards in a row. Phone icon centered in empty-state area below.                                                  |
| Window/panel sizing | 3     | Page has 6 KPI cards + one empty-state card. Significant whitespace below.                                            |
| Overcrowded text    | 4     | Clean and spacious.                                                                                                   |
| Spacing             | 4     | Consistent card spacing and padding.                                                                                  |
| Legibility          | 3     | "N/A" values are readable but the unit suffixes ("ms", "%") appear after "N/A" which reads oddly ("N/A ms", "N/A %"). |
| Text hints          | 3     | "Voice metrics will appear here once voice sessions are completed." is clear and actionable.                          |
| Consistency         | 2     | Zero/empty values displayed as "N/A" here, "--" on Customer Insights, "0" on Customer Insights counts. Third pattern. |
| Modern UI theme     | 3     | KPI card layout with phone icon empty state is clean. Time selector (24h, 7d, 30d) is consistent segment control.     |

**Key findings:**

- F-D-VA-1: **"N/A" is a THIRD zero-value pattern.** Projects Overview uses "--", Customer Insights uses "0", Voice Analytics uses "N/A". These should all use the same convention.
- F-D-VA-2: **"N/A ms" and "N/A %" are awkward.** When the value is N/A, the unit suffix should be hidden. "N/A" alone is sufficient.

---

### D-19. Settings Pages -- Populated (Multiple Loading States)

**Screenshots:** `settings-members-populated.png`, `settings-api-keys-populated.png`, `settings-models-populated.png`, `settings-runtime-config-populated.png`, `settings-config-vars-populated.png`

All 5 settings pages captured show the same pattern: a centered loading spinner with no contextual content.

| Dimension           | Score | Notes                                                                                                                |
| ------------------- | ----- | -------------------------------------------------------------------------------------------------------------------- |
| Color usage         | 2     | Bare spinner on white. Settings sidebar in left pane is the only visual element.                                     |
| Alignment           | 3     | Settings sidebar is well-structured with section groups (GENERAL, INTEGRATIONS, AGENT BEHAVIOR, SECURITY, ADVANCED). |
| Window/panel sizing | 1     | Entire content area is empty except a spinner. 80%+ of viewport is blank.                                            |
| Overcrowded text    | 4     | No text.                                                                                                             |
| Spacing             | 3     | Sidebar section grouping is well-spaced.                                                                             |
| Legibility          | 3     | Sidebar labels are readable. Section headers (GENERAL, INTEGRATIONS, etc.) are in uppercase muted style.             |
| Text hints          | 1     | No indication what is loading or why. No page title visible in the content area for Members and Models.              |
| Consistency         | 2     | Settings pages lost the project context -- project selector shows "Select Project" instead of "Saludsa Production".  |
| Modern UI theme     | 2     | Bare spinner pattern is outdated. Should use skeleton loaders matching the eventual content layout.                  |

**Key findings:**

- F-D-SP-1: **Settings pages lose project context.** The project selector in the sidebar reverts to "Select Project" (visible in Members, API Keys, Models captures). This means settings navigation disconnects from the active project, which could cause confusion about which project's settings are being viewed.
- F-D-SP-2: **API Keys page has loaded content structure.** Unlike other settings pages, the API Keys page shows its title "API Keys" with description and tab bar (SDK Keys, Platform Keys) before the spinner. This partial-load pattern is better than the pure-spinner pattern of Members/Models.
- F-D-SP-3: **Settings sidebar has 16+ items across 5 groups.** The sidebar is comprehensive (Members, API Keys, Models, Runtime Config, Config Variables, Localization, Git, Auth Profiles, Agent Transfer, PII Protection, Public API Access, Attachments, Omnichannel, Modules, Trace Dimensions, Advanced). This is a well-organized settings page structure.
- F-D-SP-4: **Persistent loading spinners across all settings.** All 5 settings pages show spinners. This suggests the settings data fetching is slow or the page load timing in the capture was too fast. In either case, the user experience is 5 consecutive spinners when navigating settings.

---

### D-20. Settings Auth Profiles -- Populated (Empty State)

**Screenshot:** `settings-auth-profiles-populated.png`

| Dimension           | Score | Notes                                                                                                              |
| ------------------- | ----- | ------------------------------------------------------------------------------------------------------------------ |
| Color usage         | 4     | Clean layout with filter dropdowns. "+ Add Profile" button in dark fill.                                           |
| Alignment           | 4     | Search bar, filter row (All Types, All Statuses, All Environments, All Sources), and empty state are well-aligned. |
| Window/panel sizing | 3     | Filter row with 4 dropdowns + refresh button fills the width well. Empty state centered below.                     |
| Overcrowded text    | 4     | No crowding.                                                                                                       |
| Spacing             | 4     | Good spacing between filter row and empty state.                                                                   |
| Legibility          | 4     | "No auth profiles found" with "Create one to connect to external services" is clear.                               |
| Text hints          | 4     | Good empty-state copy with clear CTA.                                                                              |
| Consistency         | 4     | Tabs (All Profiles, Integrations) and filter row are consistent patterns.                                          |
| Modern UI theme     | 4     | Clean filter-bar pattern with dropdown selectors is modern. Key icon in empty state is appropriate.                |

**Key findings:**

- F-D-AP-1: **Auth Profiles is one of the best-designed settings pages.** It has proper page title, description, tabs, search, multi-filter dropdowns, and a clear empty state. This should be the template for other settings pages.

---

## Phase D Cross-Cutting Findings

### DC-1: Loading State Inconsistency (CRITICAL)

Seven different loading patterns observed across 28 surfaces:

1. **Plain spinner, no context** -- Agent Editor, Agent Detail, Tool Detail, Session Detail, Settings Members, Models, Runtime Config, Config Vars (8 pages)
2. **Skeleton blocks (rectangular)** -- Workflow Detail (1 page)
3. **Skeleton cards (card-shaped)** -- Inbox (1 page)
4. **Skeleton + resolved content** -- Insights Dashboard KPIs (1 page)
5. **"Loading session..." text + spinner** -- Session Detail (1 page)
6. **Partial page load (title + tabs + spinner)** -- API Keys (1 page)
7. **"Compiling..." yellow badge** -- Agent Editor, Tool Detail (2 pages)

This is the single most impactful consistency issue found in Phase D. A user navigating through the app encounters a different loading pattern on nearly every page.

### DC-2: Zero/Empty Value Display -- FOUR Patterns (CRITICAL)

Phase A found 3 patterns. Phase D found a 4th:

1. **"0"** -- numeric zero (Customer Insights TOTAL CONVERSATIONS, Voice Analytics TOTAL CALLS)
2. **"--"** (em-dash) -- Overview KPIs (SESSIONS, MESSAGES, TOKENS, EST. COST), Customer Insights (AVG SENTIMENT, FRUSTRATION RATE)
3. **"N/A"** -- Voice Analytics KPIs (AVG MOS, ASR QUALITY, E2E LATENCY, BARGE-IN RATE, DTMF FALLBACK)
4. **"0.00"** -- Quality Monitor scores (HALLUCINATION RATE, KNOWLEDGE GAPS, SAFETY SCORE, CONTEXT PRESERVATION)

These FOUR representations of "no data" or "zero" appear across the same navigation group (Insights), creating cognitive dissonance.

### DC-3: Project Context Loss in Settings (HIGH)

When navigating from Insights/Build/Operate sections (where the project selector shows "Saludsa Production") to Settings, the project selector reverts to "Select Project". This means:

- Users lose visual confirmation of which project they are configuring
- Settings pages may fail to load data because they lack project context
- The persistent spinner on settings pages may be CAUSED by this project context loss

### DC-4: Error Message Sanitization Gap (HIGH)

Two surfaces expose internal error formats:

- Knowledge Bases: "AppError: Request failed (non-JSON response)"
- Customer Insights: "Failed to load some analytics data" (better but still vague)

The Knowledge Bases error violates the "User-Facing Runtime Error Sanitization" mandate in CLAUDE.md.

### DC-5: Double-Colon Formatting Bug (MEDIUM)

Session Detail shows "Traces:: 0" and "Session Cost:: --" with double colons. This is a string interpolation bug.

### DC-6: Sidebar Collapse Inconsistency (MEDIUM)

Most pages show the full labeled sidebar. Agent Editor and Agent Detail Overview collapse the sidebar to icon-only mode. Users navigating from Agents List (full sidebar) to Agent Editor (collapsed sidebar) experience an unexplained layout shift.

### DC-7: Agent Name Truncation (MEDIUM)

Agent cards truncate names mid-word: "contract data assist..." The truncation point breaks readability. CSS `text-overflow: ellipsis` with `white-space: nowrap` cuts at character boundaries rather than word boundaries.

---

## Phase D Scoring Summary

| Surface                      | Color | Align | Sizing | Text | Space | Legib | Hints | Consist | Modern | Avg  |
| ---------------------------- | ----- | ----- | ------ | ---- | ----- | ----- | ----- | ------- | ------ | ---- |
| Project Home (populated)     | 3     | 4     | 3      | 3    | 4     | 4     | 2     | 2       | 4      | 3.22 |
| Agents List (populated)      | 3     | 3     | 2      | 3    | 3     | 4     | 3     | 2       | 3      | 2.89 |
| Agent Editor (loading)       | 2     | 3     | 1      | 4    | 3     | 2     | 1     | 2       | 2      | 2.22 |
| Agent Detail (loading)       | 2     | 3     | 1      | 4    | 3     | 2     | 1     | 2       | 2      | 2.22 |
| Sessions (empty range)       | 4     | 4     | 3      | 4    | 4     | 4     | 3     | 3       | 3      | 3.56 |
| Session Detail (loading)     | 3     | 3     | 2      | 4    | 3     | 2     | 1     | 1       | 2      | 2.33 |
| Deployments (populated)      | 4     | 4     | 3      | 3    | 4     | 4     | 3     | 4       | 4      | 3.67 |
| Deployment Channel Detail    | 4     | 4     | 3      | 3    | 4     | 4     | 3     | 4       | 4      | 3.67 |
| Workflows (empty)            | 4     | 4     | 3      | 4    | 4     | 4     | 4     | 3       | 4      | 3.78 |
| Workflow Detail (skeleton)   | 2     | 3     | 3      | 4    | 3     | 2     | 1     | 2       | 3      | 2.56 |
| Tools (populated)            | 3     | 4     | 3      | 2    | 3     | 3     | 3     | 3       | 3      | 3.00 |
| Tool Detail (loading)        | 2     | 3     | 1      | 4    | 3     | 2     | 1     | 2       | 2      | 2.22 |
| Knowledge Bases (error)      | 3     | 4     | 3      | 4    | 4     | 4     | 2     | 3       | 3      | 3.33 |
| Evals (empty)                | 4     | 4     | 3      | 4    | 4     | 4     | 4     | 3       | 4      | 3.78 |
| Inbox (skeleton)             | 3     | 4     | 3      | 4    | 4     | 2     | 2     | 2       | 3      | 3.00 |
| Insights Dashboard (partial) | 3     | 4     | 3      | 4    | 4     | 4     | 3     | 3       | 3      | 3.44 |
| Quality Monitor (partial)    | 3     | 4     | 3      | 3    | 4     | 4     | 4     | 3       | 4      | 3.56 |
| Customer Insights (error)    | 3     | 4     | 3      | 4    | 4     | 4     | 2     | 2       | 3      | 3.22 |
| Voice Analytics (empty)      | 3     | 4     | 3      | 4    | 4     | 3     | 3     | 2       | 3      | 3.22 |
| Settings (5 pages, loading)  | 2     | 3     | 1      | 4    | 3     | 3     | 1     | 2       | 2      | 2.33 |
| Auth Profiles (empty)        | 4     | 4     | 3      | 4    | 4     | 4     | 4     | 4       | 4      | 3.89 |

**Phase D Overall Average: 3.07 / 4.00**

**Worst-scoring surfaces (below 2.5):**

- Agent Editor (2.22) -- bare spinner, collapsed sidebar, no context
- Agent Detail Overview (2.22) -- identical to agent editor
- Tool Detail (2.22) -- bare spinner, no context
- Session Detail (2.33) -- double-colon bug, loading stuck, raw UUID title
- Settings pages (2.33) -- bare spinners, project context loss

**Best-scoring surfaces (above 3.5):**

- Auth Profiles (3.89) -- exemplary empty state with filters
- Evals (3.78) -- excellent guided onboarding
- Workflows (3.78) -- clean empty state
- Deployments (3.67) -- well-structured with environment color-coding
- Sessions (3.56) -- clean table layout with proper headers

---

## Phase E: agents-dev Session-Heavy Surface Findings

**Environment:** `https://agents-dev.kore.ai`
**Project:** Apple Customer Care (`proj-apple-care`)
**Tenant:** `tenant-dev-001`
**Project stats:** 6 agents, 50 sessions (620 messages), 1.1M tokens, 21 tools, 1 knowledge base, 1 workflow, 1 active deployment (dev)
**Viewport:** 1440x900
**Capture tool:** `phase-e-agents-dev-capture` scenario via `studio-video-evidence` harness
**Note:** Phase E fills the session-heavy gap from Phase D (Saludsa Production had 0 sessions). Captures are against a real production-like project with 50 sessions, real traces, quality evaluations, and customer insights data.

### Phase E Capture Inventory

| Surface                 | Screenshots                                                                       | Data Present                      | Status    |
| ----------------------- | --------------------------------------------------------------------------------- | --------------------------------- | --------- |
| Sessions List           | `sessions--default.png`, `sessions--interaction.png`, `sessions--issue.png`       | 2 sessions (7-day filter)         | Populated |
| Session Detail          | `session-detail--default.png`, `session-detail--interaction.png`, `--issue.png`   | 23 messages, 147 traces           | Rich      |
| Analytics (Overview)    | `insights-analytics--default.png`                                                 | Empty (time range 30m)            | Empty     |
| Analytics (Sessions)    | `insights-analytics--interaction.png`, `analytics-sessions-explorer--default.png` | Empty (time range 30m)            | Empty     |
| Analytics (Traces)      | `insights-analytics--issue.png`, `analytics-traces-explorer--default.png`         | Empty (time range 30m)            | Empty     |
| Analytics (Generations) | `analytics-generations--default.png`                                              | Empty (time range 30m)            | Empty     |
| Quality Monitor         | `insights-quality-monitor--default.png`, `--interaction.png`, `--issue.png`       | 70 evaluated, Score 0.59          | Populated |
| Customer Insights       | `insights-customer-insights--default.png`, `--interaction.png`, `--issue.png`     | 86 convos, 12 intents, 72.1% frus | Rich      |
| Voice Analytics         | `insights-voice-analytics--default.png`, `--interaction.png`, `--issue.png`       | 0 calls, N/A values               | Empty     |

---

### E-1. Sessions List -- Populated (Real Data)

**Screenshots:** `sessions--default.png`, `sessions--interaction.png`, `sessions--issue.png`

| Dimension           | Score | Notes                                                                                                                                                                      |
| ------------------- | ----- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Color usage         | 4     | Clean table. "supervisor" agent badge uses neutral `bg-background-muted` styling. No color misuse.                                                                         |
| Alignment           | 4     | Table columns (Session ID, Agent, Created At, Traces, Duration, Messages, Cost) are evenly distributed. Sort chevron on "Created At" is clear.                             |
| Window/panel sizing | 3     | Table fills content area well. With only 2 rows visible (7-day filter), vast whitespace below. No pagination needed but no indication that more data exists outside range. |
| Overcrowded text    | 2     | Session IDs displayed as `s-sdk_9272d0b8-4884-...` -- raw SDK-prefixed UUIDs truncated with "...". Extremely unfriendly. 40+ characters visible before truncation.         |
| Spacing             | 4     | Table row padding is consistent. Header row has proper padding. Filter bar to table gap is appropriate.                                                                    |
| Legibility          | 3     | Duration shows "120m 52s" and "120m 14s" -- the minute+second format is readable but "120m" is an unusual presentation; "2h 0m" would be more natural.                     |
| Text hints          | 3     | "2 sessions" count in top-right is clear. "Review session logs and trace details" subtitle is helpful. Time filter dropdown (Last 7 days) is well-labeled.                 |
| Consistency         | 3     | Time filter dropdown has 7 options (Last 24 hours through All time) -- a FIFTH variant of time range control not seen in Phase A-D. More granular than others.             |
| Modern UI theme     | 4     | Clean data table with subtle borders and hover row highlighting.                                                                                                           |

**Key findings:**

- F-E-SL-1: **Session ID format is extremely unfriendly.** Displayed as `s-sdk_9272d0b8-4884-...` -- a 40+ character SDK-prefixed UUID truncated with ellipsis. No agent name, no timestamp, no human-readable identifier as the primary column. Users cannot distinguish sessions visually.
- F-E-SL-2: **Duration format "120m 52s" is unconventional.** Should be "2h 0m 52s" or "2:00:52" for durations exceeding 60 minutes. "120m" is mathematically correct but cognitively expensive.
- F-E-SL-3: **Cost column shows "--" for both rows.** With real sessions that consumed 54,603 tokens at $0.273015, the cost data EXISTS in the session detail view but is not surfaced in the list. The column adds no value.
- F-E-SL-4: **Time filter dropdown is a FIFTH variant** (Last 24h / 48h / This week / 7 days / This month / 30 days / All time). This is more granular than any other Insights page and uses a different option set. Reinforces Theme 1.
- F-E-SL-5: **Only 2 of 50 sessions visible in 7-day window.** The project has 50 sessions total, but the default "Last 7 days" shows only 2. No indication that older sessions exist. "All time" option exists but users may not think to try it.

---

### E-2. Session Detail -- Populated (Rich Data)

**Screenshots:** `session-detail--default.png`, `session-detail--interaction.png`, `session-detail--issue.png`

| Dimension           | Score | Notes                                                                                                                                                                                                     |
| ------------------- | ----- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Color usage         | 3     | Red error count badge ("0") is misleading -- 0 errors displayed in a red badge suggests critical status. Green dollar sign for cost and green token icon are appropriate.                                 |
| Alignment           | 3     | Three-panel layout: left conversation list, center conversation messages, right detail panel. Panels are well-proportioned (~20% / 35% / 45%).                                                            |
| Window/panel sizing | 2     | Right detail panel is dense with SESSION OVERVIEW, TIMESTAMPS, MODELS USED, TOKEN BREAKDOWN sections. The conversation panel center is narrow for message content. At 1440px this feels tight.            |
| Overcrowded text    | 2     | Metrics bar shows: Cost $0.273015 / Tokens 54,603 / Latency 1m 20s / Finished date -- this is dense with 6+ data points in one row. Token breakdown table (Tokens In: 49,894 / Out: 4,709) uses raw nums. |
| Spacing             | 3     | Conversation tree uses indentation well (supervisor > LLM call > decision > handoff > constraint_check). Tab bar (Overview/Traces/Errors/Data/Conversation/Performance/IR) is crammed with 7+ tabs.       |
| Legibility          | 3     | Agent execution tree uses `constraint_check: pass` repeated 7+ times vertically -- hard to scan. "LLM > claude-haiku-4-5-2025..." is truncated model name.                                                |
| Text hints          | 2     | Tab badges: "Traces 11" (blue), "Errors 0" (red) -- an error count of 0 in a red badge is semantically wrong. Should be green or no badge. "No model resolution data available" is unhelpful jargon.      |
| Consistency         | 2     | Session header shows `s-sdk_17b642e5-4d09-` as page title with "supervisor" subtitle. Same UUID-as-title problem from the list view. Tabs use numbered badges but colors don't match semantics.           |
| Modern UI theme     | 3     | Three-panel layout with collapsible execution tree is a solid pattern. Tab system provides good information architecture. Dense but functional.                                                           |

**Key findings:**

- F-E-SD-1: **"Errors 0" in a red badge is semantically inverted.** The Errors tab shows a red circle badge with "0". Red universally signals danger/error. Zero errors is the success state and should use green, gray, or no badge. This causes false alarm anxiety in users scanning the tab bar.
- F-E-SD-2: **Token numbers lack formatting.** "Tokens In: 49,894" and "Total Tokens: 54,603" show comma-separated thousands (good), but "LLM Calls: 21" in the same block uses no separator. The metrics bar shows "$0.273015" with 6 decimal places -- should round to "$0.27" or "$0.273".
- F-E-SD-3: **Tab bar has 7+ tabs crammed at 1440px.** Overview, Traces (11), Errors (0), Data, Conversation, Performance, IR -- 7 tabs with badges. At 1280px, these will overflow or wrap. Tab labels are abbreviated ("IR" is jargon for non-technical users).
- F-E-SD-4: **Agent execution tree repeats "constraint_check: pass" 7 times.** The left panel shows a tree with the same operation repeated vertically, creating visual noise. Repeated constraint checks should be collapsed/grouped (e.g., "7 constraint checks: all passed").
- F-E-SD-5: **Model name truncated to "claude-haiku-4-5-2025..."** in both the execution tree and MODELS USED section. The full model identifier includes a hash suffix ("28251001") that is not useful to users. Display should be "Claude Haiku 4.5" with the full ID in a tooltip.
- F-E-SD-6: **"No model resolution data available for this session."** at the bottom of the right panel is confusing. It appears after the TOKEN BREAKDOWN section, implying something is wrong when the token data clearly loaded. Either hide this message when token data is present, or clarify what "model resolution data" means.
- F-E-SD-7: **Phase D double-colon bug (F-D-SD-1) appears FIXED.** The metrics bar now shows "Traces: 147" and "Session Cost: $0.273015" with single colons. This validates the fix from Phase D.

---

### E-3. Analytics -- Overview, Sessions Explorer, Traces Explorer, Generations

**Screenshots:** `insights-analytics--default.png`, `insights-analytics--interaction.png`, `insights-analytics--issue.png`, `analytics-sessions-explorer--default.png`, `analytics-traces-explorer--default.png`, `analytics-generations--default.png`

| Dimension           | Score | Notes                                                                                                                                                                                                                 |
| ------------------- | ----- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Color usage         | 4     | SegmentedControl uses `bg-accent` for selected (30m). Sub-tabs use underline style. Empty state icons in muted gray.                                                                                                  |
| Alignment           | 4     | Top-level tabs (Overview, LLM Performance, Sessions Explorer, Traces Explorer, Query) and sub-tabs (Traces, Generations) are well-aligned.                                                                            |
| Window/panel sizing | 4     | Empty states center appropriately.                                                                                                                                                                                    |
| Overcrowded text    | 4     | Minimal text in empty states.                                                                                                                                                                                         |
| Spacing             | 4     | Consistent spacing between header, controls, tabs, and content areas.                                                                                                                                                 |
| Legibility          | 4     | All text passes AA. Empty state messages are clear.                                                                                                                                                                   |
| Text hints          | 2     | "No sessions found / Sessions will appear here once conversations start." is WRONG -- the project has 50 sessions. The empty state is because the 30m time window has no data.                                        |
| Consistency         | 2     | Analytics default time range is "30m" while Sessions list defaults to "Last 7 days" and Insights pages default to "Last 30 days". A user arriving from Sessions list sees data; switching to Analytics shows nothing. |
| Modern UI theme     | 4     | Clean SegmentedControl, good sub-tab nesting, search + Filters + Columns + Export toolbar in Generations is excellent.                                                                                                |

**Key findings:**

- F-E-AN-1: **CRITICAL: Analytics shows "No sessions found" despite 50 sessions existing.** The default "30m" time range means the Analytics page appears empty even when the project has rich data. Users arriving from the Sessions list (which shows sessions) to Analytics (which shows nothing) will think the feature is broken. The default time range should match the data's actual recency, or the empty state should say "No data in the last 30 minutes. Try expanding the time range."
- F-E-AN-2: **Analytics Traces Explorer says "No sessions found"** when it should say "No traces found". The empty state message is wrong for the Traces context -- it conflates sessions with traces.
- F-E-AN-3: **Sessions Explorer and Traces Explorer have different empty-state messages.** Sessions: "No sessions found / Sessions will appear here once conversations start." Traces: "No sessions found / Trace exploration will be available once sessions are created." These are inconsistent and the traces message uses "sessions" instead of "traces".
- F-E-AN-4: **Generations sub-tab has a proper search + filter toolbar** (Search, Filters, Columns, Export buttons) even in the empty state. This is good -- it sets user expectations for the table that will appear. Sessions Explorer and Traces Explorer lack this toolbar in the empty state.
- F-E-AN-5: **Generations tab is under "Traces Explorer" top-level tab,** not its own top-level tab. This nesting (Traces Explorer > Traces | Generations) is non-obvious. A user looking for LLM generations might not think to look under "Traces Explorer."

---

### E-4. Quality Monitor -- Populated (Real Evaluation Data)

**Screenshots:** `insights-quality-monitor--default.png`, `insights-quality-monitor--interaction.png`, `insights-quality-monitor--issue.png`

| Dimension           | Score | Notes                                                                                                                                                                                    |
| ------------------- | ----- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Color usage         | 3     | Quality Health banner uses gradient (pink-to-rose). "2 Critical" red dot, "1 Warning" amber dot, "2 Healthy" green dot -- correct semantic colors. Score 0.59 in white text on gradient. |
| Alignment           | 4     | 5 KPI cards in a row evenly distributed. Dimension Details cards are full-width rows below.                                                                                              |
| Window/panel sizing | 3     | KPI cards fill width well. Quality Trend section is empty ("No trend data available yet") taking significant vertical space.                                                             |
| Overcrowded text    | 3     | "CONTEXT PRESERVATION" label at 5 KPI cards width is borderline. All-caps at 12px for long labels.                                                                                       |
| Spacing             | 4     | Consistent 16px card gaps. Dimension Details rows have proper vertical spacing.                                                                                                          |
| Legibility          | 3     | Score 0.59 in white on the gradient banner has adequate contrast but is not ideal. Warning score (0.63) in teal text on white is fine.                                                   |
| Text hints          | 4     | Info icons next to each KPI label. Sub-labels ("lower is better", "guardrail pass", "higher is better") are excellent contextual hints. "70 evaluated" under OVERALL QUALITY.            |
| Consistency         | 3     | Dimension badges: "Warning" (amber), "Healthy" (green) use correct status colors. Quality Evaluation has a warning triangle icon with "21" count.                                        |
| Modern UI theme     | 4     | Gradient health banner is visually striking. Dimension Details with expandable chevrons is a good drill-down pattern.                                                                    |

**Key findings:**

- F-E-QM-1: **Phase D ambiguity (F-D-QM-1) PARTIALLY resolved.** With 70 evaluations, OVERALL QUALITY shows 0.59 (meaningful value) and HALLUCINATION RATE shows 0.00 (meaningful zero -- no hallucinations detected). However, KNOWLEDGE GAPS 0.00, SAFETY SCORE 0.00, and CONTEXT PRESERVATION 0.00 are still ambiguous -- are these perfect scores or unpopulated dimensions? No "X evaluated" sub-label on individual KPIs to disambiguate.
- F-E-QM-2: **"2 Critical / 1 Warning / 2 Healthy" in the Health banner counts DIMENSIONS, not issues.** This is clearer now with 70 evaluations than in Phase D (where 0 evaluations made "5 Critical" confusing). But the label "2 Critical" still reads as "2 critical problems" rather than "2 dimensions in critical state". Suggest: "2 dimensions critical".
- F-E-QM-3: **Quality Evaluation dimension shows "Warning" badge with "21" count and score 0.63.** The count "21" appears with a warning triangle icon but its meaning is unclear -- is it 21 flagged evaluations? 21 issues? No label explains the number.
- F-E-QM-4: **"No trend data available yet" empty area** occupies significant vertical space between KPI cards and Dimension Details. With 70 evaluations, trend data should exist unless pipelines are misconfigured. The empty state should indicate why trend data is missing when evaluation data exists.
- F-E-QM-5: **Quality Monitor uses "Last 30 days" dropdown** -- same pattern as Dashboard and Customer Insights. This is GOOD consistency compared to Analytics (SegmentedControl) and Sessions (different dropdown options).

---

### E-5. Customer Insights -- Populated (Rich Sentiment and Intent Data)

**Screenshots:** `insights-customer-insights--default.png`, `insights-customer-insights--interaction.png`, `insights-customer-insights--issue.png`

| Dimension           | Score | Notes                                                                                                                                                                                          |
| ------------------- | ----- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Color usage         | 4     | Intent Distribution uses distinct colors per intent (dark gray, teal, amber, purple, blue, red, orange, olive). Sentiment Trajectory uses green (improving), gray (stable), amber (declining). |
| Alignment           | 4     | 4 KPI cards in a row. 2-column layout for Intent Distribution (left) and Sentiment Trajectory (right). Well-balanced.                                                                          |
| Window/panel sizing | 4     | Charts fill their containers well. The 2-column layout uses space effectively at 1440px.                                                                                                       |
| Overcrowded text    | 3     | "Subscription Manage..." label is truncated in the Intent Distribution chart. Full label is likely "Subscription Management" -- truncation happens at chart label width.                       |
| Spacing             | 4     | Generous spacing between KPI row and chart panels. Internal chart padding is consistent.                                                                                                       |
| Legibility          | 3     | "AVG SENTIMENT: 0.10" is a small number with unclear scale. Is 0.10 out of 1.0 (bad) or out of 5.0 (terrible)? No scale indicator or contextual coloring.                                      |
| Text hints          | 3     | "86 conversations - 12 intents detected - 72.1% frustration" in the Customer Sentiment banner is excellent summary text. "Based on 86 conversations with sentiment data" is clear.             |
| Consistency         | 3     | Horizontal bar charts for Intent Distribution are clean. But color assignment appears non-semantic (random) -- "Device Troubleshooting" is dark gray, "Setup Activation" is teal.              |
| Modern UI theme     | 4     | Customer Sentiment gradient banner (matching Quality Health pattern) is a strong design element. Chart typography is clean.                                                                    |

**Key findings:**

- F-E-CI-1: **"AVG SENTIMENT: 0.10" lacks scale context.** The value 0.10 is meaningless without knowing the range. Is it [-1, 1] (slightly positive)? [0, 1] (very low)? [0, 5] (terrible)? No unit, no color indicator, no scale bar. Customer Insights KPIs MUST include a contextual scale hint (e.g., "0.10 / 1.0" or a color gradient bar).
- F-E-CI-2: **"FRUSTRATION RATE: 72.1%" is displayed neutrally.** A 72.1% frustration rate is an alarming metric that should trigger visual urgency (red tint, warning icon). It is displayed in the same neutral black text as "TOTAL CONVERSATIONS: 86". Semantically important metrics should use color to convey severity.
- F-E-CI-3: **"Subscription Manage..." label truncation** in Intent Distribution. The bar chart label area is too narrow for longer intent names. Should use word-wrapping or hover tooltip for full name.
- F-E-CI-4: **Intent Distribution colors are non-semantic.** Colors appear randomly assigned (dark for "Device Troubleshooting", teal for "Setup Activation", amber for "Subscription Billing"). While categorical coloring is fine, the specific palette choices don't appear to use design-token semantic colors.
- F-E-CI-5: **Sentiment Trajectory chart: "Declining: 0 / 0%"** with a tiny amber sliver. The chart shows 24 improving, 62 stable, 0 declining. The "0" bar has a visible tiny amber mark that looks like a rendering artifact. Zero values in bar charts should show no bar, not a minimum-width bar.
- F-E-CI-6: **Phase D finding F-D-CI-3 ("--" vs "0" inconsistency) is RESOLVED.** All four KPIs now show actual numeric values (86, 12, 0.10, 72.1%). No "--" or "N/A" values. This confirms the issue was data-dependent, not a UI bug.
- F-E-CI-7: **"Trends Over Time" section visible at page bottom** but appears empty or loading. Needs scroll to see full content.

---

### E-6. Voice Analytics -- Empty (No Voice Data)

**Screenshots:** `insights-voice-analytics--default.png`, `insights-voice-analytics--interaction.png`, `insights-voice-analytics--issue.png`

| Dimension           | Score | Notes                                                                                                                       |
| ------------------- | ----- | --------------------------------------------------------------------------------------------------------------------------- |
| Color usage         | 3     | KPI cards show "N/A" values. Clean neutral palette. No misuse.                                                              |
| Alignment           | 4     | 6 KPI cards in a row. Empty state centered below.                                                                           |
| Window/panel sizing | 3     | Page has 6 KPI cards + one empty-state card. Significant whitespace below.                                                  |
| Overcrowded text    | 4     | Clean and spacious.                                                                                                         |
| Spacing             | 4     | Consistent card spacing.                                                                                                    |
| Legibility          | 3     | "N/A" values with unit suffixes ("ms", "%") still present. Phase A finding F-VA-1 persists.                                 |
| Text hints          | 4     | "No voice data available / Voice metrics will appear here once voice sessions are completed." is clear.                     |
| Consistency         | 2     | "N/A ms" and "N/A %" still display units alongside N/A. Phase D finding F-D-VA-2 persists. "TOTAL CALLS: 0" vs "N/A" mixed. |
| Modern UI theme     | 3     | SegmentedControl (24h, 7d, 30d) is consistent with Phase A observation. Phone icon empty state is clean.                    |

**Key findings:**

- F-E-VA-1: **Phase A findings F-VA-1 and F-VA-2 persist.** "N/A ms" and "N/A %" still show unit suffixes after N/A values. "TOTAL CALLS" shows "0" while all other KPIs show "N/A" -- same zero/empty value inconsistency.
- F-E-VA-2: **Voice Analytics has no voice data** on agents-dev (expected -- Apple Care is text-based). This surface cannot be validated for populated-state issues in this project. Would need a voice-enabled project.

---

### Phase E Cross-Cutting Findings

### EC-1: Analytics Time Range Mismatch Causes False Empty States (CRITICAL)

The Analytics page defaults to "30m" time range. Sessions page defaults to "Last 7 days." Customer Insights and Quality Monitor default to "Last 30 days." A user who sees 50 sessions on the Overview page, 2 sessions on the Sessions list, and populated Quality Monitor data will navigate to Analytics and see "No analytics data yet" -- because the default 30m window is empty.

This is the most confusing cross-surface issue found in Phase E. It makes the Analytics page appear broken for any project where sessions are older than 30 minutes.

**Impact:** Users will abandon the Analytics feature thinking it does not work, when the data actually exists.

### EC-2: Session ID as Primary Identifier (CRITICAL)

Both the Sessions list and Session Detail page use raw SDK-prefixed UUIDs (`s-sdk_17b642e5-4d09-`) as the primary session identifier. With 50 sessions, all from the same "supervisor" agent, users have no way to distinguish sessions except by Created At timestamp. The Session ID column is the widest column in the table but provides the least useful information.

### EC-3: Error Badge Zero-Count Semantics (HIGH)

The Session Detail tab bar shows "Errors 0" with a red badge. Zero errors is a positive state. The red color creates a false alarm. This pattern would be replicated across all sessions, affecting every user who views session details.

### EC-4: Metric Scale Context Missing (HIGH)

"AVG SENTIMENT: 0.10" and "OVERALL QUALITY: 0.59" are dimensionless numbers with no scale reference. Users cannot interpret these values without knowing the range (0-1? 0-5? -1 to 1?). Every metric KPI card should include either a scale bar, a color gradient, or a denominator (e.g., "0.59 / 1.00").

### EC-5: Session Cost Data Exists but Not Surfaced in List (MEDIUM)

Session Detail shows "$0.273015" cost. The Sessions list shows "--" in the Cost column. The data exists but is not propagated to the list view, making the Cost column permanently empty and wasteful.

### EC-6: Analytics and Operate Sessions Are Separate Data Stores (MEDIUM)

Operate > Sessions shows 2 sessions in the last 7 days. Analytics > Sessions Explorer shows 0 sessions in the last 30 minutes. These read from different data stores or use different time filtering. A user expects "Sessions" to mean the same thing everywhere. The disconnect suggests either a pipeline gap (sessions not being ingested into the analytics store) or a severe UX confusion from different default time ranges.

---

### Phase E Scoring Summary

| Surface                             | Color | Align | Sizing | Text | Space | Legib | Hints | Consist | Modern | Avg  |
| ----------------------------------- | ----- | ----- | ------ | ---- | ----- | ----- | ----- | ------- | ------ | ---- |
| Sessions List (populated)           | 4     | 4     | 3      | 2    | 4     | 3     | 3     | 3       | 4      | 3.33 |
| Session Detail (rich)               | 3     | 3     | 2      | 2    | 3     | 3     | 2     | 2       | 3      | 2.56 |
| Analytics Overview (empty)          | 4     | 4     | 4      | 4    | 4     | 4     | 2     | 2       | 4      | 3.56 |
| Analytics Sessions Explorer (empty) | 4     | 4     | 4      | 4    | 4     | 4     | 2     | 2       | 4      | 3.56 |
| Analytics Traces Explorer (empty)   | 4     | 4     | 4      | 4    | 4     | 4     | 2     | 2       | 4      | 3.56 |
| Analytics Generations (empty)       | 4     | 4     | 4      | 4    | 4     | 4     | 3     | 3       | 4      | 3.78 |
| Quality Monitor (populated)         | 3     | 4     | 3      | 3    | 4     | 3     | 4     | 3       | 4      | 3.44 |
| Customer Insights (rich)            | 4     | 4     | 4      | 3    | 4     | 3     | 3     | 3       | 4      | 3.56 |
| Voice Analytics (empty)             | 3     | 4     | 3      | 4    | 4     | 3     | 4     | 2       | 3      | 3.33 |

**Phase E Overall Average: 3.41 / 4.00**

**Key observation:** Phase E surfaces score higher than Phase D (3.41 vs 3.07) because the session-heavy pages have better-designed layouts than the loading-stuck pages. The main issues are data-interpretation problems (scale context, error badge semantics) and time-range mismatches, not structural layout problems.

**Worst-scoring surface:**

- Session Detail (2.56) -- error badge semantics, overcrowded metrics, truncated model names, repeated constraint checks

**Best-scoring surfaces:**

- Analytics Generations (3.78) -- excellent toolbar design even in empty state
- Analytics sub-tabs (3.56) -- clean empty states with clear guidance

---

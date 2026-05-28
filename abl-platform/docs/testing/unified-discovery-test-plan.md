# Unified Discovery Panel — Test Plan

**Feature**: Stage 2 UX Redesign — Unified Discovery Panel (ABLP-71)
**Branch**: `develop`
**Date**: 2026-05-04
**Status**: DRAFT — awaiting review

---

## Scope

This test plan covers the UnifiedDiscoveryPanel implementation, which replaced the two-panel
BrowserDiscoveryInline + ExplorePanel architecture with a single auto-chaining component.

### What Changed (3 commits)

1. **i18n renames** — removed "Browser Discovery", "HTTP Discovery", "Hybrid", "HTTP only",
   "Browser only" from all user-facing strings
2. **UnifiedDiscoveryPanel** — new 516-line component with auto-chain, activity log,
   progressive collapse, LED indicator, TC1 escalation
3. **State2Analysis integration** — replaced 3 panel mounts with 1, removed dead code

### What to Test

| Area                                                | Priority | Type                   |
| --------------------------------------------------- | -------- | ---------------------- |
| Auto-chain decision tree (4 branches)               | P0       | Unit-extractable logic |
| Phase transitions (scanning → searching → complete) | P0       | Integration / E2E      |
| i18n terminology (no leaked internal terms)         | P0       | Static + visual        |
| State2Analysis integration (single panel mount)     | P0       | E2E                    |
| Activity log persistence across phases              | P1       | E2E                    |
| Progressive collapse animations                     | P1       | Visual / E2E           |
| TC1 escalation (searching → scanning)               | P1       | E2E                    |
| LED indicator + reduced-motion                      | P2       | Visual / Accessibility |
| Time estimate display                               | P2       | E2E                    |
| Rendering labels in State3Configure                 | P2       | Visual                 |
| Strategy reasoning strings                          | P2       | Visual                 |

---

## Test Strategy

### Layer 1: Static Analysis (no services needed)

**S1: i18n Terminology Audit**

| #    | Check                                  | Command                                                               | Expected    |
| ---- | -------------------------------------- | --------------------------------------------------------------------- | ----------- |
| S1.1 | No "Browser Discovery" in user strings | `grep -i "browser.discovery" packages/i18n/locales/en/studio.json`    | 0 matches   |
| S1.2 | No "HTTP Discovery" in user strings    | `grep -i "http.discovery" packages/i18n/locales/en/studio.json`       | 0 matches   |
| S1.3 | No "browser mode" in user strings      | `grep -i "browser.mode" packages/i18n/locales/en/studio.json`         | 0 matches   |
| S1.4 | No "HTTP only" in rendering labels     | `grep -i '"HTTP only"' packages/i18n/locales/en/studio.json`          | 0 matches   |
| S1.5 | No "Browser only" in rendering labels  | `grep -i '"Browser only"' packages/i18n/locales/en/studio.json`       | 0 matches   |
| S1.6 | No "Hybrid" in rendering labels        | `grep '"Hybrid' packages/i18n/locales/en/studio.json`                 | 0 matches   |
| S1.7 | All new discovery keys exist           | Verify 23 `discovery_*` keys present                                  | All present |
| S1.8 | Choice card keys removed               | `grep "browser_complete_choice" packages/i18n/locales/en/studio.json` | 0 matches   |

**S2: Dead Code Verification**

| #    | Check                                            | Command                                                | Expected  |
| ---- | ------------------------------------------------ | ------------------------------------------------------ | --------- |
| S2.1 | No `showBrowserCompleteChoice` in State2Analysis | `grep showBrowserCompleteChoice ...State2Analysis.tsx` | 0 matches |
| S2.2 | No direct BrowserDiscoveryInline import          | `grep "BrowserDiscoveryInline" ...State2Analysis.tsx`  | 0 matches |
| S2.3 | No direct ExplorePanel import                    | `grep "ExplorePanel" ...State2Analysis.tsx`            | 0 matches |
| S2.4 | No DiscoveryTimeline import                      | `grep "DiscoveryTimeline" ...State2Analysis.tsx`       | 0 matches |
| S2.5 | UnifiedDiscoveryPanel is imported                | `grep "UnifiedDiscoveryPanel" ...State2Analysis.tsx`   | Found     |
| S2.6 | Build succeeds                                   | `pnpm build --filter=studio`                           | 0 errors  |

**S3: Type Safety**

| #    | Check                                         | Expected                                                                   |
| ---- | --------------------------------------------- | -------------------------------------------------------------------------- |
| S3.1 | `PipelinePhase` includes `'running'`          | `'idle' \| 'browser-running' \| 'http-running' \| 'running' \| 'complete'` |
| S3.2 | `UnifiedDiscoveryPhase` type exists           | `'scanning' \| 'searching' \| 'complete'`                                  |
| S3.3 | `ActivityEntry` interface exists              | id, timestamp, level, message, messageParams, phase                        |
| S3.4 | `AutoChainResult` interface exists            | chain: boolean, logKey: string                                             |
| S3.5 | `UnifiedDiscoveryPanelProps` interface exists | All 17 props defined                                                       |

### Layer 2: Auto-Chain Logic (extractable pure function)

The `evaluateAutoChain` function (UnifiedDiscoveryPanel.tsx:122-144) implements a 4-branch
decision tree. This is pure logic that can be tested by observing component behavior.

**AC: Auto-Chain Decision Branches**

| #    | Scenario                                      | browserDiscoveredUrls | sampleUrls | stats                               | Expected    | logKey                            |
| ---- | --------------------------------------------- | --------------------- | ---------- | ----------------------------------- | ----------- | --------------------------------- |
| AC.1 | Browser found URLs                            | `['url1', 'url2']`    | `['s1']`   | `{pagesFound: 10}`                  | chain=true  | `discovery_chain_verified`        |
| AC.2 | No browser URLs, projected nodes, has samples | `[]`                  | `['s1']`   | `{pagesFound: 20, pagesMatched: 5}` | chain=true  | `discovery_chain_projected`       |
| AC.3 | No URLs, no projected, >10 pages visited      | `[]`                  | `['s1']`   | `{pagesVisited: 15}`                | chain=false | `discovery_chain_skip_sufficient` |
| AC.4 | No URLs, few pages, has samples (fallback)    | `[]`                  | `['s1']`   | `{pagesVisited: 3}`                 | chain=true  | `discovery_chain_broader`         |
| AC.5 | No URLs, no samples, few pages                | `[]`                  | `[]`       | `{pagesVisited: 3}`                 | chain=false | `discovery_chain_skip_nothing`    |

---

### Layer 3: E2E Visual Tests (services required)

**Services**: Studio (5173), SearchAI (3005), crawler-mcp-server, MongoDB, Redis

**Test URLs**:

- **Guided Discovery (thin sitemap)**: `https://epson.com/Support/Printers/sh/s1`
  - Sample URLs:
    - `https://epson.com/Support/Printers/All-In-Ones/ET-Series/Epson-ET-2600/s/SPT_C11CF46201#questions`
    - `https://epson.com/Support/Printers/All-In-Ones/WorkForce-Series/Epson-WorkForce-Pro-WF-4630/s/SPT_C11CD10201#manuals`
    - `https://epson.com/Support/Printers/All-In-Ones/ET-Series/Epson-ET-2400/s/SPT_C11CJ67201#questions`
- **Sitemap Strategy (rich sitemap)**: `https://docs.kore.ai/`

---

#### E1: Happy Path — Full Auto-Chain (Scanning → Searching → Complete)

**User objective**: A KB admin enters a URL with a thin sitemap, selects Guided strategy,
starts discovery, and watches the system automatically scan navigation then search for
more pages without any manual choice card or mode selection.

**Test site**: `https://epson.com/Support/Printers/sh/s1` — thin sitemap (6 pages), triggers
Guided Discovery recommendation. Sample URLs: 3 Epson product support pages (ET-2600, WF-4630, ET-2400).

**Code references**:

- Strategy selection: `State2Analysis.tsx:1189-1198` (StrategySelector mount)
- Pipeline start: `State2Analysis.tsx:556-560` (handleStartPipeline → setPipelinePhase('running'))
- Panel mount: `State2Analysis.tsx:1439-1461` (UnifiedDiscoveryPanel mount)
- Auto-chain: `UnifiedDiscoveryPanel.tsx:122-144` (evaluateAutoChain)
- Phase labels: i18n keys `discovery_scanning_nav`, `discovery_searching_pages`, `discovery_complete`

| Step | User Objective                              | What User Should See                                                                                                                                                                                                                        | Why It Matters                                                                                                                                                  |
| ---- | ------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 1    | Open the crawl flow and enter the Epson URL | Paste `https://epson.com/Support/Printers/sh/s1` into the URL input and submit. Wait for profiling to complete.                                                                                                                             | Precondition — profiling must succeed to get sections and strategy recommendation. Epson has only 6 sitemap pages, so Guided will be recommended.               |
| 2    | Observe strategy recommendation             | Two strategy cards appear. "Guided" card has a recommendation badge. Reasoning text says something like "Sitemap coverage is limited — discovery will find more content." No text says "browser discovery".                                 | **Regression**: Old text said "browser discovery will find more content" — verify the rename landed.                                                            |
| 3    | Select the Guided strategy                  | Click the Guided card. Below it, a sample URL input area appears with a "Start Discovery" button (Compass icon).                                                                                                                            | This is the entry point to the unified pipeline — it must NOT show separate "Browser" / "HTTP" buttons.                                                         |
| 4    | Enter sample URLs and start discovery       | Enter the 3 Epson sample URLs: `ET-2600#questions`, `WF-4630#manuals`, `ET-2400#questions`. Click "Start Discovery".                                                                                                                        | `handleStartPipeline` sets `pipelinePhase='running'`, which mounts UnifiedDiscoveryPanel. These 3 URLs give the system good seed patterns for HTTP search.      |
| 5    | Observe Phase 1: Scanning                   | A pulsing LED dot appears next to "Scanning site navigation". Below it, the browser discovery sub-panel shows (nav tree, progress, link extraction). No separate "Browser Discovery" title.                                                 | **Key change**: The scanning UI is embedded inside the unified panel, not a standalone BrowserDiscoveryInline overlay. The LED replaces the old animated badge. |
| 6    | Watch navigation scanning progress          | The browser navigates the site. A nav tree builds. Links are extracted. Live stats update (pages visited, links found). The activity log below shows timestamped entries.                                                                   | During this phase, `handleBrowserSectionsDiscovered` accumulates URLs into `browserDiscoveredUrls[]` state.                                                     |
| 7    | Wait for scanning to finish                 | Browser scanning completes. The activity log shows a milestone: "Scanned navigation — N pages, M sections (Xs)". Then immediately, an auto-chain decision message appears.                                                                  | **Critical**: No choice card. No "Continue to HTTP?" prompt. The decision is automatic (evaluateAutoChain).                                                     |
| 8    | Observe auto-chain decision                 | If browser found URLs (typical for Epson): log shows "Searching for more pages using N discovered links". Phase transitions to "Searching for more pages".                                                                                  | Branch 1 of evaluateAutoChain fires. The user sees seamless transition — no interaction required.                                                               |
| 9    | Observe Phase 2: Searching                  | The scanning summary collapses into a single line with ✅: "Scanned navigation — N pages, M sections (Xs)". Below it, a new LED pulses next to "Searching for more pages". The ExplorePanel UI appears (HTTP recursive discovery progress). | **Progressive collapse**: Completed phases collapse to summary lines. Active phase is prominent.                                                                |
| 10   | Watch page searching progress               | HTTP discovery finds matching pages. Progress updates (found/matched counts). Sections are created and appear in the left-side checklist. The activity log continues — entries from Phase 1 are STILL visible.                              | **Activity log persistence**: Entries from scanning phase must survive the transition to searching phase. They share a single `activityLog[]` state.            |
| 11   | Wait for searching to finish                | HTTP discovery completes. Activity log shows: "Searched for more pages — +N pages, M new sections (Xs)". Phase transitions to "Discovery complete".                                                                                         | `handleExploreLayerComplete` adds stats, logs summary, sets phase='complete'.                                                                                   |
| 12   | Observe completion state                    | Both phases show ✅ summaries. A "Finish" button and close (✕) button appear. No LED indicator. The complete phase header shows ✅ "Discovery complete".                                                                                    | **Final state**: User sees a clear summary of what was discovered and can proceed.                                                                              |
| 13   | Click "Finish"                              | The discovery panel disappears. Sections are visible in the section checklist. Pipeline phase = 'complete'. The "Continue" button to Step 3 is available.                                                                                   | `onComplete` fires → parent `setPipelinePhase('complete')`. Sections were already added incrementally via `onSectionsDiscovered`.                               |

---

#### E2: Skip Chain — Scanning → Complete (No HTTP Needed)

**User objective**: The system scans navigation and determines HTTP discovery isn't needed
(browser visited many pages, found no seeding URLs). Discovery completes in one phase.

**Note**: This scenario is harder to trigger with Epson (it usually finds URLs). May need
a site where browser scanning is thorough but doesn't produce section URLs. Alternatively,
can be observed if the browser visits >10 pages but all are under existing sitemap sections.

**Code references**:

- Skip decision: `UnifiedDiscoveryPanel.tsx:133-135` (Branch 3: pagesVisited > 10 → skip)
- Skip log key: i18n `discovery_chain_skip_sufficient` = "Navigation scan covered {count} pages — skipping link search"

| Step | User Objective                                               | What User Should See                                                                                                          | Why It Matters                                                                      |
| ---- | ------------------------------------------------------------ | ----------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------- |
| 1    | Start discovery on a site where browser scanning is thorough | Enter a URL and start Guided discovery. The browser phase runs and visits many pages (>10).                                   | To trigger Branch 3, browser must visit >10 pages without discovering section URLs. |
| 2    | Wait for scanning to complete                                | Scanning finishes. Activity log shows nav summary. Then: "Navigation scan covered N pages — skipping link search".            | **Auto-skip**: System decided HTTP search isn't needed. No searching phase mounts.  |
| 3    | Observe that searching never starts                          | Phase goes directly from scanning to complete. No "Searching for more pages" label ever appears. No ExplorePanel ever mounts. | **State machine shortcut**: scanning → complete (bypassing searching).              |
| 4    | Observe completion state                                     | Only ONE ✅ summary line (scanning). "Discovery complete" header with ✅. "Finish" and close buttons.                         | No searching summary because searching never ran.                                   |
| 5    | Click "Finish"                                               | Panel closes. Whatever sections browser found are in the checklist.                                                           | Even with a skip, any sections from browser scanning are preserved.                 |

---

#### E3: TC1 Escalation — HTTP Found Nothing → Back to Scanning

**User objective**: HTTP search starts but finds zero matching pages. The system automatically
triggers a browser re-scan (TC1 escalation) instead of showing a dead-end to the user.

**Code references**:

- TC1 trigger: `ExplorePanel.tsx:1032-1087` (when `progress.matched === 0`, shows TC1 card)
- TC1 escalation: `ExplorePanel.tsx:1060-1061` (calls `onEscalateToBrowser`)
- Handler: `UnifiedDiscoveryPanel.tsx:251-255` (handleEscalateToBrowser → setPhase('scanning'))

| Step | User Objective                                                   | What User Should See                                                                                                                                  | Why It Matters                                                                                                                                                          |
| ---- | ---------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 1    | Start discovery that will chain to HTTP                          | Scanning completes, auto-chain decides to search. ExplorePanel mounts.                                                                                | Need the searching phase active for TC1 to trigger.                                                                                                                     |
| 2    | HTTP finds zero matching pages                                   | ExplorePanel shows a warning card: "No matching pages found" / "Searching deeper for content." with a "Start discovery" button.                       | TC1 detection: `progress.matched === 0` in ExplorePanel. i18n keys: `no_matches_title` = "No matching pages found", `no_matches_desc` = "Searching deeper for content." |
| 3    | User clicks "Start discovery" in TC1 card (or it auto-escalates) | ExplorePanel fires `onEscalateToBrowser`. Phase transitions BACK to scanning. BrowserDiscoveryInline re-mounts.                                       | **Reverse transition**: searching → scanning. Activity log adds "Scanning site navigation" milestone.                                                                   |
| 4    | Observe the browser re-scanning                                  | Fresh browser scanning starts. The old searching entries are STILL in the activity log (not cleared). A new "Scanning site navigation" entry appears. | **Log continuity**: The log doesn't reset — it accumulates across all phase transitions including back-transitions.                                                     |
| 5    | Wait for re-scan to complete                                     | Browser finishes again. Auto-chain evaluates again. Flow continues normally.                                                                          | The second scan may find different URLs, potentially enabling a more successful HTTP search this time.                                                                  |

**Note**: TC1 is hard to trigger reliably because it requires HTTP to find 0 matching pages
for the sample URL pattern. Testing with a URL whose pattern doesn't match common page
structures may work, or use manual exploration to observe the behavior.

---

#### E4: Activity Log — Cross-Phase Persistence and Detail Toggle

**User objective**: Verify the activity log maintains a continuous history across all phase
transitions and the detail toggle works correctly.

**Code references**:

- Log state: `UnifiedDiscoveryPanel.tsx:73` (`activityLog` state — single array, never cleared)
- Milestone filtering: `UnifiedDiscoveryPanel.tsx:292-295` (visibleActivity filters by level)
- Detail toggle: `UnifiedDiscoveryPanel.tsx:478-493` (showDetails button)
- i18n: `discovery_show_details` = "Show details", `discovery_hide_details` = "Hide details"

| Step | User Objective                            | What User Should See                                                                                                                    | Why It Matters                                                                                                  |
| ---- | ----------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------- |
| 1    | Start discovery, let scanning begin       | Activity log area appears. First entries appear with timestamps (HH:MM:SS format) and messages.                                         | Log renders as scrollable area (`max-h-28 overflow-y-auto`).                                                    |
| 2    | Observe default log level                 | Only milestone and warning entries are visible. Detail-level entries are hidden.                                                        | Default state: `showDetails=false`. Filter: `level === 'milestone' \|\| level === 'warning'`.                   |
| 3    | Click "Show details" toggle button        | A ▼ chevron flips to ▲. Label changes to "Hide details". More entries appear (detail-level entries now visible).                        | `showDetails` toggles to true. All entries in `activityLog` become visible.                                     |
| 4    | Click "Hide details"                      | Chevron flips back. Label returns to "Show details". Detail entries disappear, only milestones/warnings remain.                         | Toggle reverts cleanly.                                                                                         |
| 5    | Let scanning complete and searching start | The activity log now has entries from BOTH phases. Scanning milestones (nav summary, chain decision) are followed by searching entries. | **Single log state**: `activityLog[]` is one array across all phases. Phase transitions don't clear it.         |
| 6    | Scroll through the log                    | All entries from scanning are still accessible by scrolling up. Newest entries at the bottom.                                           | Scrollable container preserves history. Warning entries show in a different color (text-warning vs text-muted). |
| 7    | Let searching complete                    | Final entries appear. Log shows complete history from start to finish.                                                                  | Complete audit trail across all phases.                                                                         |

---

#### E5: Progressive Collapse — Summary Lines Replace Active Panels

**User objective**: As each phase completes, it collapses into a concise one-line summary
with a green ✅ icon, keeping the UI clean.

**Code references**:

- Summary computation: `UnifiedDiscoveryPanel.tsx:318-347` (completedSummaries memo)
- Summary rendering: `UnifiedDiscoveryPanel.tsx:354-368` (AnimatePresence + motion.div)
- Summary text i18n: `discovery_nav_summary` = "Scanned navigation — {pages} pages, {sections} sections ({time})"
- Summary text i18n: `discovery_search_summary` = "Searched for more pages — +{pages} pages, {sections} new sections ({time})"
- Animation: `springs.gentle` from `@/lib/animation`

| Step | User Objective                       | What User Should See                                                                                                                                                               | Why It Matters                                                                                                                                                             |
| ---- | ------------------------------------ | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 1    | During scanning phase                | NO summary lines at top. Only the active phase label with LED. Below it, the BrowserDiscoveryInline panel.                                                                         | `completedSummaries` is empty when phase='scanning' and no stats yet.                                                                                                      |
| 2    | Scanning completes, searching starts | A new summary line animates in at the top: ✅ (green CheckCircle2) + "Scanned navigation — N pages, M sections (Xs)". The scanning panel is GONE — replaced by ExplorePanel below. | Animation: `initial={{ opacity: 0, height: 0 }}` → `animate={{ opacity: 1, height: 'auto' }}`. The summary text comes from `phaseStats.find(s => s.method === 'browser')`. |
| 3    | During searching phase               | One summary line (scanning ✅) at top. Active LED + "Searching for more pages" below. ExplorePanel below that.                                                                     | Two-tier layout: completed summaries + active phase + sub-component.                                                                                                       |
| 4    | Searching completes                  | SECOND summary line animates in: ✅ + "Searched for more pages — +N pages, M new sections (Xs)". Both lines visible. LED disappears. ✅ "Discovery complete" header appears.       | Now `completedSummaries` has 2 entries. Stats come from `phaseStats.find(s => s.method === 'explore')`.                                                                    |
| 5    | Observe final layout                 | Two ✅ lines, then "Discovery complete" with ✅, then activity log, then "Finish" / close buttons. Clean, concise.                                                                 | The full discovery history is compressed into 2 summary lines + scrollable log.                                                                                            |

---

#### E6: Browser Close/Stop During Scanning

**User objective**: User stops or closes browser scanning before it completes naturally.
Verify the system handles this gracefully — evaluates auto-chain with empty stats.

**Code references**:

- Browser close handler: `UnifiedDiscoveryPanel.tsx:413-423` (onClose → creates emptyStats → calls handleBrowserLayerComplete)
- Empty stats: `{ method: 'browser', pagesFound: 0, pagesMatched: 0, sectionsCreated: 0, durationMs: elapsed }`
- With sampleUrls → Branch 4 (chain=true, `discovery_chain_broader`)
- Without sampleUrls → Branch 5 (chain=false, `discovery_chain_skip_nothing`)

| Step | User Objective                                  | What User Should See                                                                                                                                    | Why It Matters                                                                                                  |
| ---- | ----------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------- |
| 1    | Start discovery                                 | Scanning begins. LED pulses. BrowserDiscoveryInline renders.                                                                                            | Normal start.                                                                                                   |
| 2    | Stop/close the browser panel before it finishes | Click the ✕ close button on the BrowserDiscoveryInline panel (visible when status !== 'running', or via stop → close).                                  | BrowserDiscoveryInline has a close button at top-right (line 441-447).                                          |
| 3    | Observe what happens (WITH sample URLs)         | Activity log shows: "Scanned navigation — 0 pages, 0 sections (Ns)". Then "Searching for more pages using sample URLs". Phase transitions to searching. | Empty stats + sampleUrls.length > 0 → Branch 4 fires. System recovers gracefully by using sample URLs for HTTP. |
| 4    | Observe what happens (WITHOUT sample URLs)      | Activity log shows: "Scanned navigation — 0 pages, 0 sections (Ns)". Then "Discovery complete — no additional pages to search". Phase goes to complete. | Empty stats + no sampleUrls → Branch 5. System can't do anything useful, so it completes.                       |
| 5    | Verify no crash or stuck state                  | Panel shows either searching phase or complete phase. No infinite loading. No error.                                                                    | Graceful degradation — closing mid-scan is a valid user action.                                                 |

---

#### E7: Sidebar "Discover More Pages" Trigger

**User objective**: After initial analysis (with Sitemap strategy or after pipeline completes),
user finds a link in the right sidebar to start discovery. Verify it works and shows correct text.

**Code references**:

- Sidebar trigger: `State2Analysis.tsx:1700-1711`
- Condition: `pipelinePhase === 'idle' && !discoveryStats.some(s => s.method === 'browser')`
- Button text: i18n `discovery_try_browser` = "Discover more pages"
- Icon: `Compass` (not Monitor or Globe)
- Action: `setPipelinePhase('running')` (line 1704)

| Step | User Objective                            | What User Should See                                                                                                                                               | Why It Matters                                                                                                                     |
| ---- | ----------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------ | ---------------------------------------------------------------------------------------------------------------------------------- |
| 1    | Complete URL profiling with a sitemap     | Enter a URL that has a good sitemap (or any URL). Wait for analysis to complete. Sections appear. In the right sidebar, under "Discovery Summary", there's a link. | The sidebar trigger only shows when `pipelinePhase==='idle'` and no browser discovery has run yet.                                 |
| 2    | Find the discovery trigger in the sidebar | A small link with Compass icon (⊕-like) and text "Discover more pages".                                                                                            | **Renamed**: Old text was "Try browser discovery" — now it's "Discover more pages". Uses Compass icon, NOT Monitor.                |
| 3    | Click "Discover more pages"               | The UnifiedDiscoveryPanel mounts. Phase 1 scanning starts. The link disappears (pipelinePhase is no longer 'idle').                                                | Single click → full unified pipeline. No intermediate step. No "choose browser or HTTP" dialog.                                    |
| 4    | Wait for discovery to complete            | Discovery runs through scanning → searching → complete. Sidebar link does NOT reappear (because `discoveryStats` now has a browser entry).                         | Guard: `!discoveryStats.some(s => s.method === 'browser')` — once browser has run, the trigger hides permanently for this session. |

---

#### E8: ExplorePanel Close During Searching Phase

**User objective**: User closes the HTTP search panel during the searching phase. Verify
the system transitions cleanly to complete without crashing.

**Code references**:

- ExplorePanel close: `UnifiedDiscoveryPanel.tsx:441-443` (onClose → setPhase('complete'))

| Step | User Objective           | What User Should See                                                                                                                         | Why It Matters                                                                                            |
| ---- | ------------------------ | -------------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------- |
| 1    | Get to searching phase   | Start discovery. Let scanning complete. Auto-chain decides to search. ExplorePanel renders.                                                  | Need searching phase active.                                                                              |
| 2    | Close the ExplorePanel   | Click the close/stop button within ExplorePanel.                                                                                             | ExplorePanel has a close button (line 651 of ExplorePanel.tsx).                                           |
| 3    | Observe phase transition | Phase transitions to 'complete'. Scanning ✅ summary shows. But NO searching ✅ summary (because searching didn't complete — it was closed). | Close → setPhase('complete'). No `handleExploreLayerComplete` fires, so no explore stats in `phaseStats`. |
| 4    | Observe activity log     | Entries from scanning phase are still visible. No entries from searching phase (it was aborted). No error entries.                           | Log is preserved. The close is clean — no error state.                                                    |
| 5    | Click "Finish" or close  | Panel closes normally. Whatever sections were found during scanning are preserved.                                                           | Graceful early exit — user gets partial results.                                                          |

---

#### E9: Minimize/Expand Toggle During Discovery

**User objective**: While discovery is running, user can collapse the panel to save screen
space and expand it back.

**Code references**:

- Minimize toggle: `State2Analysis.tsx:1414-1436`
- Condition: `pipelinePhase === 'running'`
- Collapsed view shows URL count: `liveProgress.pagesVisited + " URLs"`
- i18n: `discovery_expand` = "Expand discovery", `discovery_collapse` = "Collapse discovery"

| Step | User Objective                         | What User Should See                                                                                                                                       | Why It Matters                                                                   |
| ---- | -------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------- |
| 1    | Start discovery                        | Scanning begins. Full panel visible. A "Collapse discovery" toggle (▲ chevron) appears above the panel.                                                    | Minimize toggle only shows when `pipelinePhase === 'running'`.                   |
| 2    | Click "Collapse discovery"             | The UnifiedDiscoveryPanel disappears (it's guarded by `!isMinimized`). Only the toggle remains, now showing ▼ "Expand discovery" + a live URL count badge. | SSE streams continue in background — discovery isn't stopped, just hidden.       |
| 3    | Click "Expand discovery"               | The full panel reappears with current state. Phase may have advanced. Activity log shows all entries from when it was minimized.                           | Panel re-mounts with current state — phase transitions happened while minimized. |
| 4    | Let discovery complete while minimized | Minimize, wait for completion. When expanded, see the complete state with summaries and "Finish" button.                                                   | Discovery completes independently of visibility.                                 |

---

#### E10: Edit Samples After Discovery Completes

**User objective**: After discovery completes, user wants to change sample URLs and re-run
discovery. Verify the reset flow works.

**Code references**:

- Edit samples button: `State2Analysis.tsx:1369-1376` (shown when `pipelinePhase === 'complete'`)
- Confirm dialog: `State2Analysis.tsx:1377-1393`
- Reset action: `setPipelinePhase('idle')`, `setDiscoveryStats([])`
- i18n: `pipeline_edit_samples`, `edit_samples_confirm`, `edit_samples_yes`, `edit_samples_no`

| Step | User Objective                       | What User Should See                                                                                                                    | Why It Matters                                                                  |
| ---- | ------------------------------------ | --------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------- |
| 1    | Complete a discovery run             | Full scanning → searching → complete flow. Pipeline phase = 'complete'.                                                                 | Precondition.                                                                   |
| 2    | Find "Edit" link next to sample URLs | Above the discovery area, the sample URL chips are shown. An "Edit" link appears on the right.                                          | Only visible when `pipelinePhase === 'complete'` and `!showEditSamplesConfirm`. |
| 3    | Click "Edit"                         | A confirmation message appears: "This will restart discovery. Continue?" with "Yes" and "No" options.                                   | Safety net — editing samples requires re-running discovery.                     |
| 4    | Click "Yes"                          | Pipeline phase resets to 'idle'. Discovery stats clear. The sample URL input reappears. User can change URLs and start discovery again. | Full reset — user can iterate on sample URLs.                                   |
| 5    | Click "No"                           | Confirmation dismisses. Nothing changes. Discovery results preserved.                                                                   | Cancel path — no side effects.                                                  |

---

### Layer 4: i18n Visual Verification (services required)

#### E11: Sitemap Strategy Path — No Discovery Needed

**User objective**: A KB admin enters a URL with a rich sitemap (`docs.kore.ai`). The system
recommends the Sitemap strategy. User selects it and proceeds directly to section review
without any discovery phase. Verify the discovery panel doesn't appear.

**Test site**: `https://docs.kore.ai/` — rich sitemap with many pages and sections.

**Code references**:

- Strategy selection: `State2Analysis.tsx:1189-1198`
- Sidebar trigger condition: `State2Analysis.tsx:1701` (`pipelinePhase === 'idle' && !discoveryStats.some(...)`)

| Step | User Objective                         | What User Should See                                                                                                                                  | Why It Matters                                                                      |
| ---- | -------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------- |
| 1    | Open crawl flow and enter docs.kore.ai | Paste `https://docs.kore.ai/` and submit. Wait for profiling.                                                                                         | docs.kore.ai has a comprehensive sitemap — should produce many sections.            |
| 2    | Observe strategy recommendation        | Two cards. "Sitemap" card has recommendation badge. Reasoning: "Detected N sections with good coverage." No mention of "browser discovery" or "HTTP". | **Regression**: Old text said "no browser discovery needed" — verify rename.        |
| 3    | Select Sitemap strategy                | Click the Sitemap card. Sections appear in the checklist. No sample URL input. No "Start Discovery" button.                                           | Sitemap strategy goes straight to section review — no discovery pipeline.           |
| 4    | Verify no discovery panel appears      | No LED indicator. No "Scanning site navigation". No UnifiedDiscoveryPanel.                                                                            | `pipelinePhase` stays `'idle'`. No `handleStartPipeline` called.                    |
| 5    | Check sidebar for discovery trigger    | In right sidebar, "Discover more pages" link should be visible (Compass icon).                                                                        | User CAN start discovery if they want more, but it's optional for sitemap strategy. |
| 6    | Proceed to Configure step              | Click Continue. Rendering mode options: "Adaptive", "Standard", "Full rendering".                                                                     | Confirms i18n renames also work when reaching Configure via Sitemap path.           |

---

### Layer 4: i18n Visual Verification (services required)

#### V1: Rendering Labels in Configure Step

**User objective**: When user reaches Step 3 (Configure), the rendering mode dropdown shows
user-friendly labels, not internal terms.

**Code references**:

- Rendering options: `State3Configure.tsx:168-175` (uses `t('rendering_hybrid')`, `t('rendering_http')`, `t('rendering_browser')`)
- i18n values: `rendering_hybrid` = "Adaptive", `rendering_http` = "Standard", `rendering_browser` = "Full rendering"

| Step | User Objective                   | What User Should See                                                      | Why It Matters                                                               |
| ---- | -------------------------------- | ------------------------------------------------------------------------- | ---------------------------------------------------------------------------- |
| 1    | Get to Configure step            | Complete analysis, select sections, click Continue.                       | Need to reach Step 3.                                                        |
| 2    | Find the rendering mode selector | In the configure panel, find the rendering mode dropdown or radio group.  | It shows 3 options.                                                          |
| 3    | Read the rendering options       | "Adaptive", "Standard", "Full rendering"                                  | **NOT** "Hybrid", "HTTP only", "Browser only". These are the renamed values. |
| 4    | Check sidebar summary            | If visible in sidebar, should show "Adaptive" (or whichever is selected). | Sidebar uses `t(\`rendering\_${config.rendering}\`)` — same i18n keys.       |

#### V2: Strategy Reasoning Strings

**User objective**: Strategy cards explain WHY each strategy is recommended using user-facing
language, not implementation details.

**Code references**:

- i18n: `strategy_reason_sitemap_recommended` = "Detected {sections} sections with good coverage"
- i18n: `strategy_reason_guided_recommended` = "Sitemap coverage is limited — discovery will find more content"
- i18n: `strategy_reason_guided_no_sitemap` = "No sitemap found — the system will navigate the site to discover pages"
- i18n: `strategy_reason_guided_not_recommended` = "Use if sitemap is missing pages or you want to explore further"

| Step | User Objective                      | What User Should See                                                                                 | Why It Matters                                                                    |
| ---- | ----------------------------------- | ---------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------- |
| 1    | Open Epson URL (thin sitemap)       | Enter `https://epson.com/Support/Printers/sh/s1`. Wait for strategy cards.                           | Thin sitemap → Guided recommended.                                                |
| 2    | Read Guided card reasoning (Epson)  | "Sitemap coverage is limited — discovery will find more content" or similar. No "browser discovery". | Old text leaked "browser discovery will find more content".                       |
| 3    | Read Sitemap card reasoning (Epson) | "Sitemap found but coverage is limited — discovery may find more" or similar.                        | Old text said "no browser discovery needed".                                      |
| 4    | Open docs.kore.ai (rich sitemap)    | Enter `https://docs.kore.ai/`. Wait for strategy cards.                                              | Rich sitemap → Sitemap recommended.                                               |
| 5    | Read Sitemap card reasoning (Kore)  | "Detected N sections with good coverage." No "browser" or "HTTP" mention.                            | Verifies renamed text on the recommended path too.                                |
| 6    | Read Guided card reasoning (Kore)   | "Use if sitemap is missing pages or you want to explore further."                                    | **Old text said**: "you want to explore dynamically". Now says "explore further". |

#### V3: Discovery Panel Phase Labels

**User objective**: During discovery, the phase labels use neutral, user-friendly terminology.

| Step | User Objective                         | What User Should See                               | Why It Matters                                         |
| ---- | -------------------------------------- | -------------------------------------------------- | ------------------------------------------------------ |
| 1    | Start discovery, observe Phase 1 label | "Scanning site navigation"                         | NOT "Browser Discovery" or "Browser running".          |
| 2    | Wait for Phase 2 label                 | "Searching for more pages"                         | NOT "HTTP Discovery" or "HTTP running".                |
| 3    | Wait for completion label              | "Discovery complete"                               | Clear completion message.                              |
| 4    | Activity log toggle labels             | "Show details" / "Hide details"                    | Simple, descriptive.                                   |
| 5    | Action buttons                         | "Finish" button + close (✕) icon with "Close" text | "Finish" is the primary action, "Close" is the escape. |

---

### Layer 5: Accessibility

#### A1: Reduced Motion Support

**User objective**: Users with `prefers-reduced-motion: reduce` see a static indicator
instead of a pulsing animation.

**Code references**:

- Motion check: `UnifiedDiscoveryPanel.tsx:93-96` (`window.matchMedia`)
- Normal LED: pulsing `animate-ping` + solid dot (lines 376-379)
- Reduced motion LED: static `Circle` icon (line 374)
- Fallback text: "(Running)" — i18n `discovery_phase_running` (lines 382-384)

| Step | User Objective                       | What User Should See                                                                                                                                       | Why It Matters                                                                                     |
| ---- | ------------------------------------ | ---------------------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------- |
| 1    | Enable reduced-motion in OS settings | macOS: System Settings → Accessibility → Display → Reduce motion.                                                                                          | Sets `prefers-reduced-motion: reduce`.                                                             |
| 2    | Start discovery                      | Phase label shows with a STATIC circle icon (no ping animation). Next to it, "(Running)" text appears in muted style.                                      | The pulsing LED can be distracting or trigger vestibular issues. Fallback is purely informational. |
| 3    | Verify framer-motion still works     | Phase transitions still happen (content changes). But `springs.gentle` animations may be more subtle depending on framer-motion's reduced-motion behavior. | We only control our custom LED. Framer-motion's spring transitions are separate.                   |

---

## Files to Clean Up

These files were created for the pre-redesign flow or to capture evidence of the UX
problems that the redesign now fixes. They should be deleted:

| File                                                       | Reason                                               |
| ---------------------------------------------------------- | ---------------------------------------------------- |
| `docs/testing/crawl-flow-e2e-test-cases.md`                | Pre-redesign: 338 test cases for old two-panel flow  |
| `docs/testing/crawl-flow-selector-map.md`                  | Pre-redesign: selectors have changed                 |
| `docs/testing/crawl-flow-discovery.md`                     | Pre-redesign: discovery test guide superseded        |
| `docs/testing/reports/crawl-flow/`                         | Pre-redesign: stale HTML dashboard                   |
| `apps/studio/e2e/searchai/crawl-flow-capabilities.spec.ts` | Pre-redesign: 75KB spec testing old choice-card flow |
| `apps/studio/e2e/searchai/crawl-ux-problems.spec.ts`       | Evidence capture for problems P1-P4 — now fixed      |
| `apps/studio/e2e/searchai/crawl-ux-verify.spec.ts`         | Verification of findings F1-F7 — now resolved        |
| `apps/studio/e2e/searchai/helpers/crawl-test-capture.ts`   | Helper for old capture pattern                       |
| `apps/studio/e2e/screenshots/crawl-flow/`                  | Stale screenshots                                    |
| `apps/studio/e2e/screenshots/crawl-ux-problems/`           | Stale problem evidence                               |
| `apps/studio/e2e/screenshots/crawl-ux-verify/`             | Stale verification screenshots                       |

---

## Test Authoring Approach — Explore-First

Tests are authored in 3 phases: **Setup → Explore → Codify**. We never write automation
without first seeing the real UI and understanding the actual DOM.

### Exploration Order

Explore scenarios in this order — simplest first, building context for complex ones:

| Round | Scenarios                              | Why This Order                                                                                                                     |
| ----- | -------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------- |
| 1     | E11 (Sitemap path)                     | Simplest — no discovery, validates strategy cards + i18n. Also validates common setup steps.                                       |
| 2     | E1 (Happy path)                        | Core flow — longest, but most informative. Captures all phase transitions and timing data.                                         |
| 3     | E7 (Sidebar trigger)                   | Tests an alternate entry point into the same unified pipeline.                                                                     |
| 4     | E4, E5, E9 (Log / Collapse / Minimize) | Overlay behaviors — can be observed as sub-checks during E1 replay.                                                                |
| 5     | E6, E8 (Close mid-phase)               | Destructive actions — may need state reset after each.                                                                             |
| 6     | E10 (Edit samples)                     | Depends on a completed discovery — run after E1 completes.                                                                         |
| 7     | E2, E3 (Skip chain / TC1)              | Hard to trigger reliably — may require specific test sites or manual intervention. Accept as manual-only if no site triggers them. |

### Phase A: Common Setup (runs once, cached across tests)

These steps are shared by ALL test scenarios. Run first, cache the auth token and
navigation state.

| Step | What                           | How                                                                                                                                                                                                            | Notes                                                                                                                                         |
| ---- | ------------------------------ | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------- |
| A0   | Verify services are healthy    | `curl http://localhost:5173` (Studio), `curl http://localhost:3005/health` (SearchAI), verify crawler-mcp-server process.                                                                                      | **Do this first.** If any service is down, Phase B will waste time debugging "why is profiling hanging?"                                      |
| A1   | Dev login                      | `POST /api/auth/dev-login` with `{email: 'bharat@kore.ai', name: 'Bharat'}` → get `accessToken` + `refreshToken`                                                                                               | Set as cookies. Token is reusable across tests within same browser context.                                                                   |
| A2   | Cache auth cookies             | Store `access_token` and `refresh_token` cookies on the Studio domain.                                                                                                                                         | Use Playwright's `storageState` to save/restore auth across tests.                                                                            |
| A3   | Reuse the known project        | Navigate directly to `/projects/019d76ac-e426-720b-93c4-fea0f132dc21`.                                                                                                                                         | **Always reuse** — discovery tests don't mutate project state destructively. If project doesn't exist, create "test app" and note the new ID. |
| A4   | Reuse the known knowledge base | Navigate to KB "testing" at known ID `019d8f2f-4f88-76cc-92e2-8641d4740a6f`.                                                                                                                                   | **Always reuse** — same rationale. If KB doesn't exist, create "testing" and note new ID.                                                     |
| A5   | Navigate to KB Data tab        | Go to `/projects/{projectId}/search-ai/{kbId}/data`.                                                                                                                                                           | Direct URL navigation — faster than clicking through sidebar.                                                                                 |
| A6   | Open Web Crawler source        | Click "Add Source" → find "Web Crawler" → click "Connect".                                                                                                                                                     | CrawlFlowV5 SlidePanel opens. URL input is focused.                                                                                           |
| A7   | Reset crawl source state       | If a previous run left the flow in a non-idle state (sections loaded, `pipelinePhase='complete'`), close the slide panel and re-open "Web Crawler" for a clean state. Or delete the crawl source and recreate. | **Critical for E10** (Edit Samples) which depends on completed state — but all other scenarios need a clean idle state.                       |

### Phase B: Explore (per-scenario, Playwright headed mode)

For each test scenario, run headed Playwright to SEE what the user sees:

```bash
cd apps/studio
npx playwright test --headed --debug
```

| Step | What                        | How                                                                                                                                                                                                                                                           | Output                                                                                                               |
| ---- | --------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------- |
| B1   | Navigate to the test state  | Use Phase A setup, then enter the test URL and wait for profiling.                                                                                                                                                                                            | Observe what appears on screen.                                                                                      |
| B2   | Inspect DOM elements        | Use Playwright inspector (`page.pause()`) or browser DevTools. Hover over elements to find actual selectors.                                                                                                                                                  | Write down: what CSS classes, data-testid, text content, ARIA roles are actually present.                            |
| B3   | Note actual text            | Read the exact strings shown on screen. Compare with i18n keys from the test plan.                                                                                                                                                                            | Verify the renamed strings actually render correctly.                                                                |
| B4   | Trace the user flow         | Click through the scenario step by step. Screenshot each state. Note timing (how long does profiling take? scanning? searching?).                                                                                                                             | Build a real selector map based on what exists, not what we think exists.                                            |
| B5   | Measure timing              | Record specific durations: (1) URL profiling — seconds from submit to strategy cards; (2) browser scanning — seconds from start to complete; (3) HTTP searching — seconds from chain to complete; (4) total E1 duration. These determine test timeout values. | Example: if E1 takes 3 minutes, test timeout must be `{ timeout: 240_000 }`.                                         |
| B6   | Watch network / SSE streams | Open browser DevTools → Network tab. Note: (1) which SSE endpoint BrowserDiscoveryInline connects to; (2) which SSE endpoint ExplorePanel connects to; (3) what HTTP calls `handleStartPipeline` triggers.                                                    | SSE URLs and response shapes are needed for `page.waitForResponse()` conditions in Phase C.                          |
| B7   | Check edge cases            | What happens if you click fast? What if you navigate away? What if you close mid-scan?                                                                                                                                                                        | Note any unexpected behavior.                                                                                        |
| B8   | Record selectors            | For each assertion in the test plan, find the actual working selector.                                                                                                                                                                                        | Example: "Finish" button might be `page.getByRole('button', { name: 'Finish' })` or might need a different approach. |

### Phase C: Codify (write automation from verified observations)

Only after Phase B produces verified selectors and behavior:

| Step | What                                     | Notes                                                                                                                                                                                                                                                                                                   |
| ---- | ---------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| C0   | File structure                           | Single spec file: `apps/studio/e2e/searchai/unified-discovery.spec.ts` with `test.describe` blocks per scenario group (E1-E3 discovery flows, E4-E5 UI behaviors, E6-E8 close/abort, E9-E10 controls, E11+V visual). Shared helpers in `apps/studio/e2e/searchai/helpers/unified-discovery-helpers.ts`. |
| C1   | Write test setup using Phase A helpers   | Extract `login()`, `navigateToCrawlFlow()`, `resetCrawlSource()` as shared helpers.                                                                                                                                                                                                                     |
| C2   | Write assertions using Phase B selectors | Use exact selectors discovered during exploration. No guessing.                                                                                                                                                                                                                                         |
| C3   | Add event-based waits                    | **Primary**: `waitForSelector`, `waitForResponse` (for SSE/API events discovered in B6). **Secondary**: timing-based safety timeouts from B5 measurements (e.g., `{ timeout: 120_000 }`). **Never**: fixed `page.waitForTimeout(5000)` — always flaky.                                                  |
| C4   | Screenshot at each checkpoint            | `page.screenshot()` at key states for visual regression baseline.                                                                                                                                                                                                                                       |
| C5   | Run headless                             | Verify tests pass in headless mode too.                                                                                                                                                                                                                                                                 |
| C6   | Verify serial execution                  | These tests MUST run serially (`fullyParallel: false`). Discovery creates sections in the KB — two parallel tests on the same KB would interfere. Add `test.describe.configure({ mode: 'serial' })` to the spec.                                                                                        |

### Negative Regression Check

During Phase B exploration of E1, also verify this negative assertion (add as a sub-check):

- **No old choice card appears**: At no point during the full E1 flow should a "Continue to HTTP discovery?" choice card, a "Browser Discovery" label, or separate Browser/HTTP mode buttons appear. This catches regressions where old code gets re-imported. The static checks (S2.1-S2.4) cover the code, but this E2E check catches runtime regressions.

### Hard-to-Trigger Scenarios: E2 and E3

These scenarios depend on specific site behavior that may not be reliably reproducible:

| Scenario            | Challenge                                                                                    | Fallback Options                                                                                                                                                                                                                                                    |
| ------------------- | -------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| E2 (Skip chain)     | Needs browser to visit >10 pages without discovering section URLs. Epson usually finds URLs. | (1) During Phase B, try several URLs and note which triggers Branch 3. (2) Hybrid approach: start E6 (close browser after >10 pages visited) — creates emptyStats with high visitCount, which also triggers skip. (3) Accept as manual-only if no site triggers it. |
| E3 (TC1 escalation) | Needs HTTP search to find 0 matching pages for the sample URL pattern.                       | (1) During Phase B, try URLs with very unique patterns unlikely to match crawled pages. (2) Accept as manual-only. (3) Note: the TC1 card rendering is also verified by static code review of ExplorePanel.tsx:1032-1087.                                           |

### Why This Order Matters

```
❌ Wrong: Read code → guess selectors → write test → debug why it fails
✅ Right: See UI → note selectors → understand behavior → write test that works
```

The test plan above defines WHAT to verify (user objectives, expected text, code references).
Phases B and C discover HOW to verify it (actual selectors, timing, DOM structure).

---

## Success Criteria

| Criteria             | Metric                                                          |
| -------------------- | --------------------------------------------------------------- |
| i18n clean           | 0 instances of leaked internal terminology (S1.1-S1.8 all pass) |
| Build clean          | `pnpm build --filter=studio` — 0 errors                         |
| Happy path           | E1 completes end-to-end without errors                          |
| Skip path            | E2 transitions directly to complete                             |
| Activity log         | E4 — entries persist across phase transitions                   |
| Progressive collapse | E5 — ✅ summary lines appear for completed phases               |
| Graceful close       | E6, E8 — closing mid-phase doesn't crash                        |
| Sidebar trigger      | E7 — correct text and icon, starts unified pipeline             |
| Sitemap path         | E11 — docs.kore.ai: no discovery, straight to sections          |
| Rendering labels     | V1 — "Adaptive", "Standard", "Full rendering"                   |
| Strategy text        | V2 — no "browser discovery" in reasoning                        |
| Accessibility        | A1 — reduced-motion shows static indicator                      |

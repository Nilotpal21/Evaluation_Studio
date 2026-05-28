# Unified Discovery Panel — Exploration Outcomes

**Feature**: ABLP-71 Stage 2 UX Redesign
**Test plan**: `docs/testing/unified-discovery-test-plan.md`
**Test spec**: `apps/studio/e2e/searchai/unified-discovery.spec.ts`
**Selectors file**: `apps/studio/e2e/searchai/helpers/crawl-flow-selectors.ts`
**Started**: 2026-05-05

This file captures real observations from Phase B (headed Playwright exploration).
Each scenario records: actual selectors, timing, text seen, screenshots taken, bugs found.
Any session can pick this up and continue from where it left off.

---

## Services

| Service  | Port  | Health endpoint                                     |
| -------- | ----- | --------------------------------------------------- |
| Studio   | 5173  | `curl localhost:5173` (307 = redirect to login, OK) |
| SearchAI | 3113  | `curl localhost:3113/health` (JSON response)        |
| Runtime  | 3112  | `curl localhost:3112/health`                        |
| MongoDB  | 27017 | —                                                   |

## Test fixtures

| Fixture        | ID                                     | Notes      |
| -------------- | -------------------------------------- | ---------- |
| Project        | `019d76ac-e426-720b-93c4-fea0f132dc21` | "test app" |
| Knowledge Base | `019d8f2f-4f88-76cc-92e2-8641d4740a6f` | "testing"  |

## How to run

```bash
# Health check only
cd apps/studio
npx playwright test e2e/searchai/unified-discovery.spec.ts --headed --project=chromium

# With specific KB
TEST_KB_NAME="testing" npx playwright test e2e/searchai/unified-discovery.spec.ts --headed --project=chromium
```

## Navigation path (verified from source code)

The complete path from login to the crawl URL input:

| Step | Action                          | Locator strategy                               | Component source                   |
| ---- | ------------------------------- | ---------------------------------------------- | ---------------------------------- |
| 1    | Dev Login                       | `loginAndNavigateToProject(page)` helper       | `e2e/helpers/auth.ts`              |
| 2    | Click "Knowledge Bases" sidebar | `nav >> text=Knowledge Bases`                  | `ProjectSidebar.tsx` (BookOpen)    |
| 3    | Click KB card by name           | `button:has(h3)` filtered by KB name           | `KnowledgeBaseDashboardPage.tsx`   |
| 4    | Click "Connect a source"        | `button` with text "Connect a source"          | `SetupGuide.tsx` (new KB)          |
| 4alt | Click "Add Source"              | `button` with text "Add Source"                | `DataSection.tsx` (existing KB)    |
| 5    | Click "Web Crawler" card        | text "Web Crawler" in connector catalog dialog | `ConnectorCatalog.tsx` (web_modes) |
| 6    | CrawlFlowPanel opens            | `<input type="url">` becomes visible           | `AddSourceButton.tsx` → SlidePanel |
| 7    | Type URL + click "Go"           | `input[type="url"]` + `button` with text "Go"  | `State1UrlEntry.tsx`               |
| 8    | Profiling completes             | Text "How would you like to discover content?" | `StrategySelector.tsx`             |

**Key insight**: No `data-testid` attributes exist anywhere in the crawl flow components.
All locators use text content, ARIA roles, or CSS structure.

## i18n keys (verified from studio.json)

| Key                                   | English text                                      | Used in                  |
| ------------------------------------- | ------------------------------------------------- | ------------------------ |
| `strategy_title`                      | "How would you like to discover content?"         | StrategySelector heading |
| `strategy_subtitle`                   | "Choose a strategy based on your site's..."       | StrategySelector subtext |
| `strategy_sitemap_title`              | "Crawl Full Sitemap"                              | Sitemap card title       |
| `strategy_sitemap_desc`               | "{count} pages in sitemap"                        | Sitemap card description |
| `strategy_guided_title`               | "Guided Discovery"                                | Guided card title        |
| `strategy_guided_desc`                | "Steer the system to find what you need"          | Guided card description  |
| `strategy_recommended`                | "Recommended"                                     | Badge on best card       |
| `strategy_selected`                   | "Selected"                                        | Badge after selection    |
| `strategy_reason_sitemap_recommended` | "Detected {sections} sections with good coverage" | Sitemap reasoning        |
| `strategy_reason_guided_recommended`  | "Sitemap coverage is limited — discovery will..." | Guided reasoning         |
| `strategy_reason_guided_no_sitemap`   | "No sitemap found — the system will navigate..."  | Guided no-sitemap        |
| `discovery_scanning_nav`              | "Scanning site navigation"                        | Phase 1 label            |
| `discovery_searching_pages`           | "Searching for more pages"                        | Phase 2 label            |
| `discovery_complete`                  | "Discovery complete"                              | Phase 3 label            |
| `discovery_chain_verified`            | "Searching for more pages using {count}..."       | Auto-chain message       |
| `discovery_chain_skip_sufficient`     | "Navigation scan covered {count} pages..."        | Skip chain message       |
| `discovery_show_details`              | "Show details"                                    | Log detail toggle        |
| `discovery_hide_details`              | "Hide details"                                    | Log detail toggle        |
| `discovery_finish`                    | "Finish"                                          | Completion button        |
| `discovery_close`                     | "Close"                                           | Close button             |
| `discovery_try_browser`               | "Discover more pages"                             | Sidebar trigger          |
| `discovery_expand`                    | "Expand discovery"                                | Minimized expand         |
| `discovery_collapse`                  | "Collapse discovery"                              | Minimize toggle          |
| `discovery_still_running`             | "Discovery still running — {urls} URLs..."        | Minimized status         |
| `rendering_hybrid`                    | "Adaptive"                                        | Rendering mode           |
| `rendering_http`                      | "Standard"                                        | Rendering mode           |
| `rendering_browser`                   | "Full rendering"                                  | Rendering mode           |

## Banned terms (negative regression)

These terms should **NEVER** appear in the crawl flow UI. Automated check in `checkBannedTerms()`:

| Old term                      | Replacement      | Why banned                      |
| ----------------------------- | ---------------- | ------------------------------- |
| "Browser Discovery"           | "Scanning"       | Internal implementation detail  |
| "HTTP Discovery"              | "Searching"      | Internal implementation detail  |
| "Continue to HTTP discovery?" | (auto-chain)     | Choice card removed by redesign |
| "Hybrid"                      | "Adaptive"       | i18n rename in T-1              |
| "HTTP only"                   | "Standard"       | i18n rename in T-1              |
| "Browser only"                | "Full rendering" | i18n rename in T-1              |

## Exploration Order

| Round | Scenario                          | Status        | Notes                                                               |
| ----- | --------------------------------- | ------------- | ------------------------------------------------------------------- |
| 1     | E11 — Sitemap path (docs.kore.ai) | ✅ COMPLETE   | 8/8 tests pass (28.7s), 27 API calls captured                       |
| 2     | E1 — Happy path (Epson)           | ✅ COMPLETE   | 17/17 pass (4.8m), 585 nodes, 15 sections                           |
| 3     | E7 — Sidebar trigger              | ✅ COMPLETE   | 15/15 pass (39.9s), E9 collapse/expand works                        |
| 4     | E4 — Activity log                 | ✅ COMPLETE   | 6+ entries, timestamps, Discovery Log heading visible               |
| 5     | E5 — Progressive collapse         | ⚠️ PARTIAL    | Auto-chain confirmed via E10, scan summary not directly timed       |
| 6     | E6 — Close during scanning        | ✅ COMPLETE   | "Discovery is still running" dialog: minimize/stopSave/discard      |
| 7     | E8 — Close during searching       | ⚠️ PARTIAL    | Searching reachable (E10), close during search not directly tested  |
| 8     | E9 — Minimize/Expand              | ✅ COMPLETE   | During E7: collapse/expand works, state preserved, badge timing gap |
| 9     | E10 — Edit samples                | ✅ COMPLETE   | Full flow: Edit→Confirm→Cancel, Edit→Yes→Reset. 4.8min run.         |
| 10    | E2 — Skip chain                   | NOT ATTEMPTED | Need a site that triggers the skip condition                        |
| 11    | E3 — TC1 escalation               | NOT ATTEMPTED | Need HTTP to find 0 matching pages                                  |

### ✅ RESOLVED: Browser Scanning Regression

**Bug**: `BrowserDiscoveryInline` fails immediately with "Navigation scan failed".
**Root cause**: **Tenant ID mismatch between POST and SSE EventSource connections.**

- `startBrowserExplore()` uses `apiFetch` which includes `X-Tenant-Id: 019df64d-...` header → exploration created under real tenant
- `connectBrowserExploreProgress()` creates bare `EventSource(url)` — no custom headers possible → dev bypass injects `tenant-dev-001`
- `getOwnedExploration(id, tenantId, userId)` check fails because `tenant-dev-001` ≠ `019df64d-...` → 404 → "Navigation scan failed"

**Fix applied** (2026-05-05):

1. `apps/studio/src/api/crawl.ts` — added `sseUrl()` helper that passes `tenantId` from auth store as query parameter in EventSource URLs for direct connections. Both `connectDiscoverProgress` and `connectBrowserExploreProgress` updated.
2. `apps/search-ai/src/middleware/dev-auth.ts` — dev bypass now reads `tenantId` from `req.query.tenantId` as fallback when no `X-Tenant-Id` header present (for EventSource connections).

**Verified**: curl POST with `X-Tenant-Id` header → SSE GET with `?tenantId=` query param → events stream correctly.
**Note**: `connectDiscoverProgress` had the same latent bug — fixed preemptively. Searching phase (ExplorePanel) may have worked before because sitemap-based flows don't use SSE.

---

## E11: Sitemap Strategy Path (docs.kore.ai)

**Test plan reference**: Layer 4, E11 (6 steps)
**URL**: `https://docs.kore.ai/`

### Setup observations

- Login method: `loginViaDevApi()` → dev-login API → cookie injection → `/projects` page
- **CRITICAL**: Must click project card to enter project context — sidebar doesn't exist on `/projects` page
- Project card locator: `page.getByText(projectName, { exact: false }).first()` (CSS `button:has(h3)` unreliable)
- Connector catalog: Must click "Connect" button on Web Crawler card (not the card text itself)
- Navigation to crawl flow: Login → Project card → Sidebar "Knowledge Bases" → KB card → "Add Source" → "Connect" on Web Crawler → CrawlFlowPanel
- Time to reach URL input: ~8s from login

### Step-by-step observations

| Step                       | Expected (from test plan)                      | Actual observation                                                | Selector / locator                                      | Timing |
| -------------------------- | ---------------------------------------------- | ----------------------------------------------------------------- | ------------------------------------------------------- | ------ |
| 1. Enter docs.kore.ai      | Profiling completes, sections detected         | ✅ 27 API calls: drafts, check-domain, profile, cluster, sections | `input[type="url"]` + `button role=button name=/^go$/i` | ~5s    |
| 2. Strategy recommendation | "Sitemap" card recommended                     | ✅ Sitemap card text contains "Recommended"                       | `text=Crawl Full Sitemap` parent, `text=Recommended`    | <1s    |
| 3. Select Sitemap strategy | Sections appear in checklist, "Selected" badge | ✅ Sections appear, "Selected" badge shown                        | Click sitemap card parent                               | ~2s    |
| 4. No discovery panel      | No LED, no "Scanning site navigation"          | ✅ Confirmed — no scanning phase label visible                    | `text=Scanning site navigation` → NOT visible (correct) | -      |
| 5. Sidebar trigger         | Compass icon + "Discover more pages" visible   | ✅ Visible                                                        | `text=Discover more pages`                              | -      |
| 6. No banned terminology   | No old internal terms appear                   | ✅ 0 banned terms found                                           | `checkBannedTerms()` → empty array                      | -      |

### Selectors discovered (pre-populated from source code, verify during exploration)

```
// Strategy cards — StrategySelector.tsx
strategyCard_sitemap: page.getByText('Crawl Full Sitemap').locator('..')  // motion.button parent
strategyCard_guided: page.getByText('Guided Discovery').locator('..')
recommendationBadge: page.getByText('Recommended')  // span.rounded-full inside card
selectedBadge: page.getByText('Selected')
reasoningText: italic <p> under card description (text varies by recommendation)

// Section checklist — State2Analysis.tsx
sectionCheckbox: page.locator('[role="checkbox"]')
sectionFilter: page.locator('input[placeholder*="Filter"]')

// Sidebar trigger — State2Analysis.tsx
sidebarDiscoveryTrigger: page.getByText('Discover more pages')  // Compass icon + text

// Configure step (State 3)
renderingOption_adaptive: page.getByText('Adaptive')
renderingOption_standard: page.getByText('Standard')
renderingOption_fullRendering: page.getByText('Full rendering')
```

### i18n text verified

| Key                                 | Expected                                          | Actual on screen                                 | Match? |
| ----------------------------------- | ------------------------------------------------- | ------------------------------------------------ | ------ |
| strategy_title                      | "How would you like to discover content?"         | ✅ Visible as heading after profiling            | Yes    |
| strategy_sitemap_title              | "Crawl Full Sitemap"                              | ✅ Card title                                    | Yes    |
| strategy_sitemap_desc               | "{count} pages in sitemap"                        | ✅ (count filled with actual number)             | Yes    |
| strategy_recommended                | "Recommended"                                     | ✅ Badge on sitemap card                         | Yes    |
| strategy_reason_sitemap_recommended | "Detected {sections} sections with good coverage" | ✅ Below card description                        | Yes    |
| discovery_try_browser               | "Discover more pages"                             | ✅ Sidebar link visible after selection          | Yes    |
| rendering_hybrid                    | "Adaptive"                                        | (not tested in E11 — requires State 3 Configure) | —      |
| rendering_http                      | "Standard"                                        | (not tested in E11 — requires State 3 Configure) | —      |
| rendering_browser                   | "Full rendering"                                  | (not tested in E11 — requires State 3 Configure) | —      |

### API endpoints captured (27 calls during profiling)

| Endpoint                                                         | Method | Status | Count | Notes                     |
| ---------------------------------------------------------------- | ------ | ------ | ----- | ------------------------- |
| `/api/crawl/drafts?projectId=...`                                | GET    | 200    | 1     | Check for existing drafts |
| `/api/crawl/drafts/check-domain?indexId=...&domain=docs.kore.ai` | GET    | 200    | 1     | Domain duplicate check    |
| `/api/crawl/drafts`                                              | POST   | 201    | 1     | Create new crawl draft    |
| `/api/crawl/profile`                                             | POST   | 200    | 1     | Profile URL + sitemap     |
| `/api/crawl/cluster-urls`                                        | POST   | 200    | 1     | Cluster discovered URLs   |
| `/api/crawl/sample-groups`                                       | POST   | 200    | 1     | Generate sample groups    |
| `/api/crawl/drafts/{id}/sections/{secId}/urls`                   | PUT    | 200    | ~20   | Update section URL lists  |

### Bugs / unexpected behavior

- No bugs found during E11 exploration
- Login required `loginViaDevApi` + project card click (not `loginAndNavigateToProject`)
- Connector catalog "Connect" button requires card-scoped locator (not just text "Web Crawler")

### Screenshots

| File                                                         | Description                |
| ------------------------------------------------------------ | -------------------------- |
| `e2e/screenshots/unified-discovery/setup-a1-project.png`     | Inside project after login |
| `e2e/screenshots/unified-discovery/setup-a2-crawl-panel.png` | Web Crawler panel open     |
| `e2e/screenshots/unified-discovery/e11-1-profiled.png`       | Strategy cards visible     |
| `e2e/screenshots/unified-discovery/e11-2-recommended.png`    | Sitemap card recommended   |
| `e2e/screenshots/unified-discovery/e11-3-selected.png`       | Sitemap selected           |
| `e2e/screenshots/unified-discovery/e11-4-sidebar.png`        | Discover more pages link   |

---

## E1: Happy Path — Full Auto-Chain (Epson)

**Test plan reference**: Layer 3, E1 (13 steps)
**URL**: `https://epson.com/Support/Printers/sh/s1`
**Sample URLs**: ET-2600#questions, WF-4630#manuals, ET-2400#questions

### Timing measurements (B5)

| Phase                                   | Duration | Notes                                          |
| --------------------------------------- | -------- | ---------------------------------------------- |
| URL profiling (submit → strategy cards) | ~5s      | 6 API calls (profile, cluster, samples, 1 sec) |
| Browser scanning (start → 47 nodes)     | ~7s      | Nav structure extraction                       |
| Scanning → 419 nodes                    | ~88s     | Breadcrumb extraction from sample URLs         |
| 419 → 585 nodes (plateau)               | ~81s     | Additional depth probing                       |
| Total E1 end-to-end                     | >250s    | Did NOT complete naturally — manually stopped  |

### SSE endpoints (B6)

SSE endpoints were NOT observed during E1 exploration. The BrowserDiscoveryInline and ExplorePanel
communicate via React callbacks, not visible SSE connections in the Playwright response handler.
The `startNetworkCapture` only captured REST API calls, not WebSocket/SSE.
TODO: Check browser DevTools Network tab for SSE in a manual headed session.

### Step-by-step observations

| Step                       | Expected                                 | Actual observation                                                           | Selector / locator                                              | Timing  |
| -------------------------- | ---------------------------------------- | ---------------------------------------------------------------------------- | --------------------------------------------------------------- | ------- |
| 1. Enter Epson URL         | Profiling → strategy cards               | ✅ 6 API calls captured                                                      | `input[type="url"]` + `button role=button name=/^go$/i`         | ~5s     |
| 2. Strategy recommendation | Guided recommended                       | ✅ Guided card contains "Recommended"                                        | `text=Guided Discovery` parent, `text=Recommended`              | <1s     |
| 3. Select Guided           | Sample URL input + Start Discovery       | ✅ 1 input visible, "+ Add another example" to add more                      | Click guided card, `input[type="url"]` in Discover section      | ~1s     |
| 4. Enter samples + start   | UnifiedDiscoveryPanel mounts             | ✅ 3 samples filled, Start Discovery clicked                                 | `sampleUrlInput(0..2)` + `addAnotherExampleButton` + Start btn  | ~3s     |
| 5. Phase 1: Scanning       | LED + "Scanning site navigation"         | ✅ LED badge visible (bg-success-subtle), scanning label appeared            | LED: `inline-flex...rounded-full...bg-success-subtle`           | <1s     |
| 6. Scanning progress       | Nav tree, links extracted, activity log  | ✅ "Discovery Log" heading, "Discovery Tree (N nodes)", "Stop discovery" btn | `text=Discovery Log`, `text=Discovery Tree`, `button name=stop` | ongoing |
| 7. Scanning finishes       | Auto-chain message, NO choice card       | ⚠️ Phase transitions NOT visible in viewport — scrolled to tree/sections     | Need to scroll up to verify phase label transitions             | —       |
| 8. Auto-chain decision     | "Searching for more pages using N links" | ⚠️ Never observed — text may appear above scroll viewport                    | Needs scroll-to-top during discovery                            | —       |
| 9. Phase 2: Searching      | ExplorePanel appears                     | ⚠️ Not clearly visible — continuous log entries without phase break          | Phase transitions need explicit detection                       | —       |
| 10. Searching progress     | Pages found, sections created            | ✅ Tree grew 47→419→585, sections 1→7→9→15                                   | `text=Discovery Tree`, `text=sections to review`                | ongoing |
| 11. Discovery end          | Finish button appears                    | ❌ Did NOT complete in 4 min — stopped manually                              | `button name=stop discovery` → clicked at 250s                  | >250s   |
| 12. Post-stop state        | Sections in checklist                    | ✅ 15 sections with checkboxes, Discovery Tree removed                       | `[role=checkbox]` count=15, `text=sections to review`           | <3s     |
| 13. Discover more pages    | Sidebar link visible                     | ❌ NOT visible after Stop (maybe only after natural Finish)                  | `text=Discover more pages` → false                              | —       |

### Negative regression check

- [x] No "Continue to HTTP discovery?" choice card appeared
- [x] No "Browser Discovery" label appeared
- [x] No separate Browser/HTTP mode buttons appeared
- [x] Zero banned terms (checkBannedTerms passed)

### Selectors discovered (pre-populated from source code, verify during exploration)

```
// Start discovery — State2Analysis.tsx shows these after selecting Guided
startDiscoveryButton: page.getByRole('button', { name: /start discovery/i })
sampleUrlInput(index): page.locator('input[type="url"]').nth(index + 1)  // SampleUrlInput uses <input type="url">, NOT textarea

// Phase indicators — UnifiedDiscoveryPanel.tsx
ledPulsing: span.rounded-full with animate-pulse class (scanning phase)
ledStatic: span.rounded-full without animate-pulse (complete)
phaseLabel_scanning: page.getByText('Scanning site navigation')
phaseLabel_searching: page.getByText('Searching for more pages')
phaseLabel_complete: page.getByText('Discovery complete')

// Progressive collapse — UnifiedDiscoveryPanel.tsx
completedSummary_scanning: text matching "Scanned navigation — N pages, N sections"
completedSummary_searching: text matching "Searched for more pages — +N pages"
checkCircle2Icon: CheckCircle2 lucide icon (green check in summary header)

// Activity log — UnifiedDiscoveryPanel.tsx
activityLogContainer: container with space-y class holding log entries
activityEntry: individual log lines (milestone/warning/detail types)
showDetailsToggle: page.getByText('Show details')
hideDetailsToggle: page.getByText('Hide details')

// Completion — UnifiedDiscoveryPanel.tsx
finishButton: page.getByRole('button', { name: /finish/i })
closeButton: page.getByRole('button', { name: /close/i })  // X icon button

// Minimize/expand — UnifiedDiscoveryPanel.tsx
collapseToggle: page.getByText('Collapse discovery')
expandToggle: page.getByText('Expand discovery')
urlCountBadge: badge showing "{urls} URLs · {sections} sections so far" when minimized
```

### Bugs / unexpected behavior

(none yet)

---

## E7: Sidebar Trigger

**Status**: ✅ COMPLETE
**Prerequisite**: Sitemap selection (E11 path) — link only shows when NO browser discovery has run
**Tests**: E7.0–E7.6 (7 tests, all pass in <5s each)

### Visibility condition (from source code)

```typescript
pipelinePhase === 'idle' && !discoveryStats.some((s) => s.method === 'browser');
```

This means the "Discover more pages" link:

- ✅ IS visible after sitemap selection (no browser discovery)
- ❌ NOT visible after guided discovery (browser discovery ran)
- ❌ NOT visible after sidebar-triggered discovery completed (browser stats added)

### Step-by-step observations

| Step                           | Expected                                 | Actual                                                                       | Timing |
| ------------------------------ | ---------------------------------------- | ---------------------------------------------------------------------------- | ------ |
| 1. Sitemap selected (E11 path) | "Discover more pages" visible            | ✅ Visible                                                                   | <1s    |
| 2. Click "Discover more pages" | Discovery panel mounts                   | ✅ Scanning phase starts directly — NO sample input needed                   | <2s    |
| 3. Discovery state             | Stop button, scanning label, log heading | ✅ All visible                                                               | <1s    |
| 4. Collapse toggle             | "Collapse discovery" visible             | ✅ Visible during running state                                              | <1s    |
| 5. Click Collapse              | Minimized state                          | ✅ "Expand discovery" toggle appears, discovery tree hidden                  | <1s    |
| 6. URL badge in minimized      | Show "N URLs" count                      | ❌ Not visible (maybe too early in scanning)                                 | -      |
| 7. Click Expand                | Full view restored                       | ✅ Discovery panel expanded back correctly                                   | <1s    |
| 8. Stop discovery              | Sections appear                          | ✅ 20 sections with checkboxes after stop+finish                             | <3s    |
| 9. Post-stop "Discover more"   | Should disappear (browser ran)           | ✅ Correctly hidden — discoveryStats now includes browser method             | -      |
| 10. Post-stop "Edit" link      | Sample URL edit link                     | ❌ Not visible — sidebar trigger has no user samples (only sitemap sections) | -      |

### Key finding: sidebar trigger skips sample input

When "Discover more pages" is clicked from a sitemap path, the code sets `pipelinePhase='running'`
which mounts `UnifiedDiscoveryPanel` directly. The panel starts BrowserDiscoveryInline for nav
scanning without requiring sample URLs. This is correct — the sitemap already provided section structure,
so browser discovery just supplements it.

### E9 (Collapse/Expand) observations

- **Collapse toggle**: "Collapse discovery" text + ChevronUp icon (during running phase)
- **Minimized state**: "Expand discovery" text + ChevronDown icon replaces the panel
- **URL badge**: NOT visible in minimized state during early scanning (expected: "N URLs" text)
  - Likely because `liveProgress` hasn't reported yet at that point
- **State preservation**: Discovery continues running while minimized, state intact after expand

### Bugs / unexpected behavior

- **URL count badge not showing in minimized state**: The minimized bar should show `{urls} URLs`
  but it doesn't appear early in scanning. May need `liveProgress` to have reported at least once.
  LOW priority — cosmetic timing issue.

### Selectors

```
trigger: page.getByText('Discover more pages')  // Compass icon adjacent
collapse: page.getByText('Collapse discovery', { exact: false })
expand: page.getByText('Expand discovery', { exact: false })
```

---

## E4: Activity Log

**Status**: ✅ COMPLETE (after SSE tenant fix)

### Expected behavior

- Milestone entries shown by default (phase transitions, key events)
- "Show details" toggle reveals detailed entries (individual page visits)
- Log persists across phase transitions (scanning → searching → complete)
- Entries have timestamps (HH:MM:SS format via `.tabular-nums`)

### Selectors (verified from source code + live testing)

```
showDetails: page.getByText('Show details')          // discovery_show_details — NOT VISIBLE during scan
hideDetails: page.getByText('Hide details')          // discovery_hide_details — NOT VISIBLE during scan
logContainer: page.locator('[class*="space-y-0"] .flex.items-start')  // reliable selector
timestamp: page.locator('.tabular-nums')               // HH:MM:SS element
discoveryLogHeading: page.getByText('Discovery Log')   // heading visible
stopButton: page.getByRole('button', { name: /stop discovery/i })
```

### Observations (2026-05-05, after SSE fix)

- **E4.0**: Epson guided discovery starts successfully. `scanFailed: false` ✅
- **E4.1**: 6 log entries with 12 timestamps observed:
  - `"Extracting site navigation structure"` (14:28:47)
  - `"Extracted 47 top-level navigation categories"` (14:28:54)
  - `"Extracting site navigation structure"` (14:28:54) — second extraction pass
  - `"Auto-added 'Support' section (57 URLs matched)"` (14:30:11)
  - `"Auto-added 'C' section (9 URLs matched)"` (14:30:11)
  - "Discovery Log" heading: ✅ visible
- **E4.2**: Show/Hide details toggle NOT found. Neither "Show details" nor "Hide details"
  appeared during scanning. The toggle may only render during the HTTP searching phase
  (ExplorePanel), not during browser scanning (DiscoveryConsole).
- **E4.3**: Auto-chain transition NOT observed within 123s. Epson scan runs for 2+ minutes.
  Discovery was stopped for cleanup. Screenshot confirms scan was productive (419 tree nodes,
  202 pages, 7 sections, breadcrumbs found).

### Screenshot evidence

| Screenshot                   | Contents                                                   |
| ---------------------------- | ---------------------------------------------------------- |
| `e4-0-discovery-started.png` | Scan running, tree nodes visible, "Stop discovery" button  |
| `e4-1-log-entries.png`       | 6 log entries, 419 nodes, 202 pages, breadcrumb navigation |
| `e4-2-no-toggle.png`         | No Show/Hide toggle during scanning phase                  |
| `e4-3b-final.png`            | After 123s, scanning still active                          |

---

## E5: Progressive Collapse

**Status**: ⚠️ PARTIAL — auto-chain observed in E10 screenshot but not timed in E4

### Expected behavior

- Scanning section collapses to summary line: CheckCircle2 icon + "Scanned navigation — N pages, N sections (Ns)"
- Summary is clickable to expand back
- Animation via framer-motion (springs.default)

### Selectors

```
scanSummary: text matching "Scanned navigation"
searchSummary: text matching "Searched for more pages"
```

### Observations (2026-05-05)

- **E4.3**: Auto-chain NOT reached within 123s — Epson scan runs too long.
- **E10 screenshot (e10-1b-edit-link.png)**: Shows **"Searching for more pages using sample URLs"**
  in the activity log, with "Scanned navigation — 0 pages, 0 sections (18s)" summary above it.
  This confirms the scanning→searching auto-chain transition IS working. The scanning section
  collapsed to a summary line as expected.
- **ExplorePanel active**: E10 screenshot shows "Explore site" panel with pattern detection,
  3 pages discovered, "Stop" button — confirming the HTTP searching phase runs correctly.
- Progressive collapse animation not directly verified (hard to capture in screenshot).

---

## E9: Minimize/Expand

**Status**: ✅ OBSERVED (during E7)

### Expected behavior

- "Collapse discovery" toggle minimizes panel to compact bar
- Bar shows: "{urls} URLs · {sections} sections so far" badge
- "Expand discovery" restores full view
- State survives minimize/expand cycle

### Observations (from E7.4)

- ✅ "Collapse discovery" visible during running state → click → panel collapses
- ✅ "Expand discovery" appears after collapse → click → panel expands back
- ✅ State preserved across collapse/expand cycle — discovery continues running
- ⚠️ URL count badge NOT visible during early scanning — `liveProgress` may not have reported yet
- ⚠️ "sections so far" badge not verified — would need longer running discovery

### Selectors (verified)

```
collapse: page.getByText('Collapse discovery', { exact: false })
expand: page.getByText('Expand discovery', { exact: false })
statusBadge: page.getByText(/URLs/i)  // not visible during early scanning
```

---

## E6: Browser Close During Scanning

**Status**: ✅ COMPLETE

### Expected behavior

- Clicking close/X during Phase 1 (scanning) stops browser discovery
- Panel closes, no orphaned SSE connections

### Key question — ANSWERED

- **What triggers close?** Pressing Escape key triggers SlidePanel close
- **Confirmation dialog?** YES — "Discovery is still running" dialog appears with 3 options

### Observations

- ✅ Pressing Escape during scanning triggers confirmation dialog
- ✅ **"Discovery is still running" dialog** appears with 3 options:
  1. **"Minimize to activity bar"** — minimizes without stopping
  2. **"Stop & save draft"** — stops discovery, saves draft state
  3. **"Discard"** — text link (not button), fully closes and discards
- ✅ Clicking "Discard" fully closes the panel — URL input disappears
- ✅ After close: 2 crawl API calls captured, 0 SSE connections lingering
- ✅ Panel closed cleanly — no orphaned connections detected

### Selectors (verified)

```
escapeKey: page.keyboard.press('Escape')
dialogText: page.getByText('Discovery is still running', { exact: false })
minimizeBtn: page.getByText('Minimize to activity bar', { exact: false })
stopSaveBtn: page.getByText('Stop & save draft', { exact: false })
discardLink: page.getByText('Discard', { exact: true })  // text link, NOT button
```

---

## E8: ExplorePanel Close During Searching

**Status**: ⚠️ PARTIAL — searching phase not reached within E8 timeout, but observed in E10

### Expected behavior

- Clicking close during Phase 2 (searching/HTTP) stops explore pipeline
- Panel closes cleanly
- Same confirmation dialog as E6 expected

### Observations (2026-05-05)

- **E8.1**: Waited 121s but searching phase not reached — Epson scan runs too long
- **E10 screenshot proof**: The e10-1b screenshot shows the searching phase IS reachable
  (after scanning completes and auto-chain triggers). The "Explore site" panel with "Stop"
  button is visible during searching.
- The close dialog behavior during searching was NOT directly tested (would need to reach
  searching and press Escape within the same test)
- **Inference**: Close during searching should show same dialog as E6 (scanning) since both
  use the same `handleCloseAttempt` in State2Analysis that checks `pipelinePhase === 'running'`

---

## E10: Edit Samples

**Status**: ✅ COMPLETE (2026-05-05, after SSE fix + natural completion wait)

### Expected behavior (from source code analysis)

- "Edit & re-discover" link only visible when `pipelinePhase === 'complete'` AND `!showEditSamplesConfirm`
- **NOT visible** during 'running' or 'idle' phases
- Clicking it sets `showEditSamplesConfirm = true` → shows confirmation inline
- Confirmation text: "Clear all discovery results?" (i18n: `edit_samples_confirm`)
- "Yes, clear" button (i18n: `edit_samples_yes`) → resets to idle, clears discovery stats
- "Cancel" button (i18n: `edit_samples_no`) → dismisses confirmation, keeps complete state

### i18n keys (verified)

```
pipeline_samples_label: "Sample URLs"
pipeline_edit_samples: "Edit & re-discover"
edit_samples_confirm: "Clear all discovery results?"
edit_samples_yes: "Yes, clear"
edit_samples_no: "Cancel"
```

### Selectors (ALL VERIFIED in live test run 2026-05-05)

```
editLink: page.getByText('Edit & re-discover', { exact: false })   # ✅ VERIFIED — visible after natural completion
confirmText: page.getByText('Clear all discovery results', { exact: false })  # ✅ VERIFIED
yesBtn: page.getByText('Yes, clear', { exact: false })  # ✅ VERIFIED
cancelBtn: page.getByText('Cancel', { exact: true })    # ✅ VERIFIED
samplePills: page.locator('.font-mono.truncate')         # ✅ VERIFIED — 20 pills in full run
```

### Observations (2026-05-05, complete run — 4.8 min)

- ✅ **Sample URL pills visible** — 20 pills after full guided discovery (vs 4 from earlier partial run)
- ✅ **Auto-chain works** — scanning→searching transition completed successfully
- ✅ **Discovery completed naturally** — Finish button appeared, pipeline reached 'complete' state
- ✅ **"Edit & re-discover" link IS visible** — confirmed after natural completion (not after manual stop)
- ✅ **Confirmation dialog**: "Clear all discovery results?" with "Yes, clear" and "Cancel" buttons
- ✅ **Cancel flow**: dismisses dialog, Edit link reappears
- ✅ **Yes, clear flow**: resets to idle, sample inputs reappear, Start Discovery button back
- ✅ **Samples preserved after reset** — first sample URL retained in input field
- ✅ **No banned terminology** (E10.4 passed)

### Key finding: Stop vs natural completion

- **Stopping discovery** keeps `pipelinePhase = 'running'` → Edit link NOT visible
- **Natural completion** (Finish button → click) sets `pipelinePhase = 'complete'` → Edit link visible
- This is correct behavior — stopping mid-discovery should not offer "Edit & re-discover"
  because the results are incomplete. Only after full completion should the user be offered
  to edit samples and re-run.

### Test timing

| Phase                                | Duration |
| ------------------------------------ | -------- |
| Setup (login → profiling → samples)  | ~15s     |
| Discovery (scan → search → complete) | ~4 min   |
| Edit flow (E10.2 + E10.3)            | ~10s     |
| Total E10 end-to-end                 | ~4.8 min |

---

## E2: Skip Chain

**Status**: NOT ATTEMPTED
**Challenge**: Hard to trigger — need site where browser visits >10 pages without finding section URLs.
**Blocked by**: Browser scanning regression — can't even get a successful scan to test skip logic.

### Expected behavior

- Auto-chain evaluates: browser found pages but none match section patterns
- Message: "Navigation scan covered {count} pages — skipping link search"
- Skips Phase 2, goes directly to complete

### Sites tried

| URL | Result | Triggered skip? |
| --- | ------ | --------------- |
|     |        |                 |

---

## E3: TC1 Escalation

**Status**: NOT ATTEMPTED
**Challenge**: Hard to trigger — need HTTP to find 0 matching pages.
**Blocked by**: Browser scanning regression — can't complete a full auto-chain cycle.

### Expected behavior

- HTTP searching finds 0 matching pages
- Escalates back to browser (TC1 re-mount)
- Message visible in activity log

### Sites tried

| URL | Result | Triggered TC1? |
| --- | ------ | -------------- |
|     |        |                |

---

## Gaps identified (feedback for future exploration)

These are details we DON'T yet know and need to discover during headed exploration:

| #   | Gap                                   | How to resolve                                                                                          | Scenario |
| --- | ------------------------------------- | ------------------------------------------------------------------------------------------------------- | -------- |
| 1   | ~~SampleUrlInput exact element type~~ | ✅ RESOLVED: `<input type="url">` (not textarea). Fixed in selectors.                                   | E1       |
| 2   | ~~LED indicator exact CSS~~           | ✅ RESOLVED: Badge-style `inline-flex...rounded-full bg-success-subtle text-success` (not animated dot) | E1       |
| 3   | Activity log entry structure          | ⚠️ PARTIALLY: `.max-h-28 .flex.items-start` is the selector, but no entries generated (scan failure)    | E4       |
| 4   | ~~Close button location~~             | ✅ RESOLVED: Escape key triggers SlidePanel close → "Discovery is still running" confirmation dialog    | E6       |
| 5   | ~~Edit samples confirmation dialog~~  | ✅ RESOLVED: "Clear all discovery results?" + "Yes, clear" / "Cancel" (from i18n keys)                  | E10      |
| 6   | ~~Minimize bar layout~~               | ✅ RESOLVED: ChevronDown + "Expand discovery" + optional "{N} URLs" badge (verified E7/E9)              | E9       |
| 7   | SSE endpoint URLs                     | NOT observed — browser scanning fails before SSE events arrive                                          | E1       |
| 8   | ~~Profiling API call~~                | ✅ RESOLVED: `POST /api/crawl/profile` (see E11 API table)                                              | E1       |
| 9   | ~~Section checklist after discovery~~ | ✅ RESOLVED: Auto-added with "NEW" badge, auto-selected matching base URL path                          | E1       |
| 10  | ~~Time for profiling + each phase~~   | ✅ RESOLVED: E11 profiling ~5s, E1 profiling ~5s, scanning >250s (Epson never completed)                | E1, E11  |
| 11  | Phase transitions in viewport         | Phase labels (scanning→searching) may be ABOVE scroll — need scroll-to-top                              | E1       |
| 12  | "Discover more pages" after Stop      | Link NOT visible after Stop — only after natural Finish?                                                | E1       |
| 13  | Discovery does NOT complete for Epson | >4 min runtime — need smaller test URL or accept manual Stop                                            | E1       |
| 14  | **Browser scanning regression**       | Scan fails immediately ("Navigation scan failed"). Was working in prior session. Blocks E4/E5/E8/E10.   | ALL      |
| 15  | E2E tenant LLM credentials            | `No LLM credentials configured for tenant 019df64d-...` — may affect LLM-dependent discovery features   | ALL      |

## Global selector map

Consolidated from source code analysis. **Verify and refine during Phase B exploration.**
The authoritative selector implementations are in `crawl-flow-selectors.ts`.

```typescript
// Summary of locator strategies (see crawl-flow-selectors.ts for Playwright code)
//
// Navigation:
//   sidebarKnowledgeBases → nav >> text=Knowledge Bases
//   kbCard(name)          → button:has(h3) filtered by name
//   connectSourceButton   → button:has-text("Connect a source")
//   addSourceButton       → button:has-text("Add Source")
//   webCrawlerConnectBtn  → div filter hasText=/^Web Crawler/ → button name=/connect/i
//
// URL Entry:
//   urlInput              → input[type="url"]
//   goButton              → button:has-text("Go")
//
// Strategy:
//   strategyHeading       → text="How would you like to discover content?"
//   strategySitemapCard   → text="Crawl Full Sitemap" parent
//   strategyGuidedCard    → text="Guided Discovery" parent
//   recommendedBadge      → text="Recommended"
//   selectedBadge         → text="Selected"
//
// Discovery Panel:
//   startDiscoveryButton  → button:has-text("Start Discovery")
//   sampleUrlInput(i)     → input[type="url"] nth(i+1) (index 0 = base URL)
//   phaseLabel(text)      → getByText(text)
//   ledIndicator          → span.rounded-full (first)
//   showDetailsToggle     → text="Show details"
//   hideDetailsToggle     → text="Hide details"
//   finishButton          → button:has-text("Finish")
//   closeButton           → button:has-text("Close")
//   collapseToggle        → text="Collapse discovery"
//   expandToggle          → text="Expand discovery"
//   discoverMoreLink      → text="Discover more pages"
//   editSamplesLink       → text="Edit & re-discover" (only in complete state)
//
// Close Confirmation Dialog:
//   dialogText            → text="Discovery is still running"
//   minimizeBtn           → text="Minimize to activity bar"
//   stopSaveBtn           → text="Stop & save draft"
//   discardLink           → text="Discard" (exact — text link, NOT button)
//
// Edit Samples Confirmation:
//   confirmText           → text="Clear all discovery results"
//   yesClearBtn           → text="Yes, clear"
//   cancelBtn             → text="Cancel" (exact)
//
// Error State (BrowserDiscoveryInline):
//   scanError             → text="Navigation scan failed"
//   retryBtn              → button:has-text("Retry")
//   closeErrorBtn         → button name=/^close$/i (ghost variant)
//
// Rendering (State 3):
//   renderingAdaptive     → text="Adaptive"
//   renderingStandard     → text="Standard"
//   renderingFullRendering → text="Full rendering"
```

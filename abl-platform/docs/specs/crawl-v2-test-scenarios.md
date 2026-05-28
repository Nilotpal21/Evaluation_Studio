# Crawl V2 — User Journey Test Scenarios

## Purpose

End-to-end test scenarios for Playwright tests covering the V2 crawl flow (State 2 → 3 → 4).
Each scenario traces a complete user journey and specifies what to assert at every step.
Scenarios are ordered by priority — implement top-down.

**Test infrastructure:** `apps/studio/e2e/searchai/` using existing patterns from:

- `crawl-configure-progress.spec.ts` — existing serial test suite (S0→S1→S2→C1..→P1..P4)
- `helpers/crawl-flow-selectors.ts` — verified locators (zero data-testid, text/role-based)
- `helpers/service-health.ts` — ServiceHealthChecker for S0 setup
- `helpers/auth.ts` — `loginViaDevApi()`, `getToken()`

**Test conventions (match existing):**

- `test.describe.configure({ mode: 'serial' })` — each test builds on previous state
- `test.setTimeout(600_000)` — 10-min timeout for crawl operations
- `crawlScreenshot(page, scenario, step, note)` — screenshot at every assertion point
- `startNetworkCapture(page)` — capture API calls for payload verification
- `@e2e-real` — no mocks, real services, real HTTP API

**Existing selectors available** (from `crawl-flow-selectors.ts`):

| Selector                                      | Returns                                            |
| --------------------------------------------- | -------------------------------------------------- |
| `urlInput(page)`                              | URL input field                                    |
| `submitUrlAndWaitForProfiling(page, url)`     | Full URL submit + wait for strategy cards          |
| `strategySitemapCard(page)`                   | "Crawl Full Sitemap" card                          |
| `sectionCheckboxes(page)`                     | All `[role="checkbox"]` in section list            |
| `openWebCrawlerPanel(page)`                   | Opens crawler panel (handles both new/existing KB) |
| `crawlScreenshot(page, scenario, step, note)` | Screenshot with consistent naming                  |
| `startNetworkCapture(page)`                   | Capture SSE + API calls                            |

**New selectors needed for V2** (to be added to `crawl-flow-selectors.ts`):

| Selector                                  | Purpose                                      |
| ----------------------------------------- | -------------------------------------------- |
| `crawlSummaryPanel(page)`                 | Read-only summary at top of State 3 (V2 new) |
| `sectionStrategyLabel(page, sectionName)` | "HTTP" / "Playwright" label per section      |
| `configureSettingSlider(page, name)`      | Crawl speed slider                           |
| `configureSettingToggle(page, name)`      | Robots.txt, Dedup toggles                    |
| `startCrawlButton(page)`                  | "Start Crawl" button in State 3              |
| `progressBar(page)`                       | Main progress bar in State 4                 |
| `sectionFillRates(page)`                  | Per-section progress bars                    |
| `qualityBreakdown(page)`                  | Good/Thin/Failed counters                    |
| `skippedUrlsSection(page)`                | "N URLs skipped" collapsible                 |
| `cancelButton(page)`                      | Cancel button in State 4                     |
| `activityBarItem(page, domain)`           | Activity bar entry for a domain              |
| `activityBarResumeButton(page)`           | Resume button in activity bar                |

---

## Journey 1: Happy Path — Full Crawl Lifecycle

**Objective coverage:** O1, O2, O3, O5 (navigate away), O7 (single tenant)

### Scenario 1.1: Sitemap site → Select sections → Configure → Start → Progress → Complete

```
GIVEN  a KB exists and services are healthy
WHEN   user enters a sitemap-enabled URL (e.g., docs.kore.ai)

State 2 (Analysis):
  THEN  profiling completes (site badge shows sitemap detected)
  THEN  sections appear with checkboxes, page counts, and strategy labels
  THEN  at least one section shows "HTTP" or "Playwright" rendering strategy
  THEN  total page count matches sum of selected sections
  ASSERT  section.pageCount > 0 for each visible section
  ASSERT  page count displayed matches the cluster-urls response count

State 2 → 3 transition:
  WHEN  user clicks "Continue to Config" (or equivalent CTA)
  THEN  State 3 loads with read-only crawl summary at top
  ASSERT  summary shows correct section names, page counts, and strategy labels
  ASSERT  NO new source was created (verify via API: GET /sources count unchanged)
  ASSERT  draft flowState is 'configured' (verify via GET /crawl-drafts/:id)

State 3 (Configure):
  THEN  scope/maxPages/maxDepth controls are NOT visible (D7 — removed)
  THEN  rendering dropdown defaults to "Auto-detected"
  THEN  crawl settings visible: Speed slider, Robots.txt toggle, Cleanup, Dedup, Cookies
  WHEN  user adjusts settings:
    - Set crawl delay to 2000ms
    - Toggle robots.txt to "Respect"
    - Set cleanup to "Aggressive"
  WHEN  user clicks "Start Crawl"

State 3 → 4 transition:
  ASSERT  exactly ONE source created (verify via API: GET /sources count = previous + 1)
  ASSERT  source type is 'web' (not 'web_crawl')
  ASSERT  POST /batch was called with:
    - urls array length matches total selected pages
    - sectionMapping includes per-section strategy ('http' or 'browser')
    - crawlSettings.crawlDelay === 2000
    - crawlSettings.respectRobotsTxt === true
    - crawlSettings.cleanupLevel === 'aggressive'
  ASSERT  draft flowState is 'submitted'
  ASSERT  draft has crawlJobId set

State 4 (Progress):
  THEN  progress bar appears and starts moving (> 0% within 10 seconds)
  THEN  "Crawled" counter increments
  THEN  section fill rates show per-section progress bars
  THEN  quality breakdown (Good/Thin/Failed) updates live
  THEN  ETA is displayed and recalculates

Completion:
  THEN  progress reaches 100%
  THEN  completion summary shows: total crawled, failed count, quality breakdown
  THEN  "View Results" button is visible
  ASSERT  CrawlJob.status === 'completed' (verify via API)
  ASSERT  SearchDocuments exist for the source (GET /sources/:id/documents count > 0)
  ASSERT  draft flowState is 'completed'
```

### Scenario 1.2: URL count fidelity — crawled count matches selected count (D13)

```
GIVEN  a sitemap site with > 20 URLs in at least one section
WHEN   user completes full flow (State 2 → 3 → 4 → complete)

ASSERT  number of URLs sent in POST /batch === sum of selected section pageCounts
ASSERT  CrawlJob.urls.total (from API) === sum of selected section pageCounts
ASSERT  CrawlJob.urls.total !== 10 (proves we're not sending just examples)
NOTE    This is the D13 regression test — the URL count illusion fix
```

### Scenario 1.3: Per-section rendering strategy preserved (D12)

```
GIVEN  a site where discovery detects mixed strategies (some sections HTTP, some Playwright)
WHEN   user completes flow to State 4

ASSERT  POST /batch sectionMapping contains at least one entry with strategy: 'http'
        and at least one with strategy: 'browser' (if site requires both)
ASSERT  progress events include data.method field showing 'http' or 'browser'
NOTE    If no mixed site available, verify sectionMapping[].strategy field exists
        and matches what was shown in State 2/3 summary
```

---

## Journey 2: Cancel During Crawl

**Objective coverage:** O5 (cancel), O6 (partial results)

### Scenario 2.1: Cancel mid-crawl — partial results preserved

```
GIVEN  a crawl is running (State 4, progress > 0%)
WHEN   user clicks [Cancel]
THEN   confirmation dialog appears: "Cancel crawl? Pages already processed will remain searchable."
WHEN   user confirms cancel

THEN   crawl stops within 10 seconds (progress bar stops advancing)
THEN   UI transitions to cancelled state:
       "Crawl Cancelled. N pages processed."
ASSERT  CrawlJob.status === 'cancelled' (via API)
ASSERT  CrawlJob.urls.crawled > 0 (partial results exist)
ASSERT  SearchDocuments created for completed pages (count > 0)
ASSERT  "View Results" or "Re-crawl Remaining" button visible
```

### Scenario 2.2: Cancel while still queued (no pages processed)

```
GIVEN  user just clicked "Start Crawl" (State 4, progress === 0%, job queued)
WHEN   user immediately clicks [Cancel]

THEN   confirmation dialog appears
WHEN   user confirms cancel
THEN   UI shows cancelled state with 0 pages processed
ASSERT  CrawlJob.status === 'cancelled'
ASSERT  CrawlJob.urls.crawled === 0
```

---

## Journey 3: Minimize & Resume

**Objective coverage:** O5 (minimize, navigate away, resume)

### Scenario 3.1: Minimize to activity bar → Resume

```
GIVEN  a crawl is running (State 4, progress visible)
WHEN   user clicks the back button [←]
THEN   dialog appears: "Crawl is still running"
       Options: [Minimize to activity bar] [Cancel crawl] [Stay]
WHEN   user clicks "Minimize to activity bar"

THEN   crawl panel closes
THEN   activity bar appears at bottom/side with:
       - Domain name (e.g., "example.com")
       - Progress indicator (e.g., "45/210 (21%)")
       - [Resume] button
ASSERT  crawl continues server-side (CrawlJob.status === 'crawling' via API)

WHEN   user clicks [Resume] on activity bar
THEN   crawl panel reopens at State 4 with:
       - Current progress (not reset to 0)
       - Section fill rates at current values
       - WebSocket reconnected (progress continues to update)
```

### Scenario 3.2: Navigate away → Return → Activity bar hydration (D4)

```
GIVEN  a crawl is running (State 4 or minimized to activity bar)
WHEN   user navigates to a completely different page (e.g., Settings)
THEN   crawl continues server-side

WHEN   user navigates back to the KB detail page
THEN   activity bar shows the running crawl (hydrated from server via GET /crawl-drafts/active)
ASSERT  activity bar displays domain, progress percentage
ASSERT  [Resume] button works and reopens crawl at State 4

WHEN   user refreshes the page (F5)
THEN   activity bar still shows the running crawl (survives page refresh)
ASSERT  Zustand store was hydrated from server, not from memory
```

### Scenario 3.3: KB banner for active crawl

```
GIVEN  a crawl is running in the background
WHEN   user navigates to the KB detail page (sources list)
THEN   a banner appears at the top:
       "Crawl in progress: example.com — 180/226 pages" [View Progress]
WHEN   user clicks [View Progress]
THEN   crawl panel opens at State 4 with live progress
```

---

## Journey 4: WebSocket Reliability

**Objective coverage:** O4 (WS auth, dev mode, fallback)

### Scenario 4.1: WebSocket receives events with auth token

```
GIVEN  user is authenticated and starts a crawl
WHEN   crawl transitions to State 4

ASSERT  WebSocket URL contains ?token= parameter (network tab inspection)
ASSERT  WS connection establishes successfully (readyState === OPEN)
ASSERT  at least one progress event received within 10 seconds of crawl start
ASSERT  events have correct shape: { type, jobId, timestamp, data }
```

### Scenario 4.2: WebSocket fallback to polling

```
GIVEN  WebSocket is blocked or fails to connect
       (simulate by intercepting WS upgrade with page.route)
WHEN   user starts a crawl

THEN   UI shows indication: "Live updates unavailable — refreshing every 10s"
THEN   progress still updates (via REST polling)
ASSERT  GET /api/crawl/status?jobId=X is called periodically
ASSERT  progress bar eventually reaches completion
```

---

## Journey 5: Settings Wiring Verification (D7)

**Objective coverage:** O2 (honor configuration)

### Scenario 5.1: All 6 settings reach the backend

```
GIVEN  user is at State 3 (Configure)
WHEN   user sets ALL configurable settings to non-default values:
  - Rendering: "Force HTTP" (override auto-detected)
  - Speed: 3000ms (drag slider)
  - Robots.txt: "Ignore" (toggle off)
  - Patterns: "Reset" (don't reuse handlers)
  - Cleanup: "Aggressive"
  - Dedup: Off
  - Cookies: "Ignore"
WHEN   user clicks "Start Crawl"

ASSERT  POST /batch payload contains:
  crawlSettings.crawlDelay === 3000
  crawlSettings.respectRobotsTxt === false
  crawlSettings.cleanupLevel === 'aggressive'
  crawlSettings.deduplicate === false
  crawlSettings.cookieConsent === false
  crawlSettings.reuseHandlers === false
NOTE    Capture network request in Playwright to verify payload
```

### Scenario 5.2: Removed settings do NOT appear in UI

```
GIVEN  user is at State 3 (Configure)
ASSERT  no "Scope" selector visible (Limited/Full/Custom)
ASSERT  no "Max Pages" input visible
ASSERT  no "Max Depth" slider visible
ASSERT  page count is read-only in the crawl summary (not editable)
```

---

## Journey 6: Robots.txt Enforcement

**Objective coverage:** O2 (robots.txt)

### Scenario 6.1: Blocked URLs show as skipped (not failed)

```
GIVEN  a site with robots.txt that disallows some paths
GIVEN  user has "Respect robots.txt" enabled in State 3
WHEN   crawl runs and encounters blocked URLs

THEN   "Skipped" section appears in State 4 UI
THEN   skipped URLs show reason: "robots.txt"
ASSERT  skipped URLs are NOT counted in the "Failed" counter
ASSERT  progress events include type: 'url_skipped' with skipReason: 'robots_txt'
ASSERT  total = crawled + skipped + failed (accounting is correct)
```

---

## Journey 7: Error Recovery

**Objective coverage:** O6 (never lose work)

### Scenario 7.1: Network error on individual URL — crawl continues

```
GIVEN  a crawl is running with 20+ URLs
WHEN   some URLs are unreachable (404, 500, timeout)

THEN   crawl does NOT stop
THEN   failed count increments for each failed URL
THEN   progress continues past failed URLs
THEN   completion summary shows: "N pages crawled • M failed"
ASSERT  CrawlJob.urls.failed > 0
ASSERT  CrawlJob.urls.crawled > CrawlJob.urls.failed (some succeeded)
ASSERT  SearchDocuments exist for successful pages
```

### Scenario 7.2: Browser disconnect mid-crawl — crawl survives

```
GIVEN  a crawl is running (State 4, progress > 20%)
WHEN   user closes the browser tab

THEN   (in a new tab) navigate to KB detail page
THEN   activity bar or banner shows the crawl still running
ASSERT  CrawlJob.status is 'crawling' or 'ingesting' (not failed)
WHEN   crawl completes
ASSERT  CrawlJob.status === 'completed'
ASSERT  all selected pages were processed
```

---

## Journey 8: Re-Crawl

**Objective coverage:** O8 (re-crawl, dedup, stale detection)

### Scenario 8.1: Re-crawl same site — dedup works

```
GIVEN  a completed crawl exists for a site (e.g., 50 pages)
WHEN   user initiates a new crawl for the same site

State 3 shows re-crawl context:
  THEN  banner: "Last crawled: X ago (50 pages, N successful, M failed)"
  THEN  [Re-crawl All] and [Re-crawl Failed Only] options visible

WHEN   user clicks "Re-crawl All" and completes the crawl
THEN   completion summary shows change detection:
       "N new, M updated, K removed, J unchanged"
ASSERT  CrawlJob.comparison is populated (via API)
ASSERT  no duplicate SearchDocuments (count unchanged for unchanged content)
```

### Scenario 8.2: Re-crawl Failed Only

```
GIVEN  a completed crawl with some failed URLs (CrawlJob.urls.errors[].length > 0)
WHEN   user clicks "Re-crawl Failed Only"

THEN   crawl starts with ONLY the previously failed URLs
ASSERT  POST /batch urls count === number of previously failed URLs
ASSERT  total in progress === number of previously failed URLs
THEN   completion shows how many were recovered
```

---

## Journey 9: Multi-Section Mixed Strategy

**Objective coverage:** O1 (honor discovery), O2 (rendering mode)

### Scenario 9.1: Sections with different rendering strategies

```
GIVEN  a JS-heavy site where discovery detects mixed strategies
       (some sections HTTP, some need Playwright)
WHEN   user completes full flow

State 2:
  ASSERT  sections show strategy labels (e.g., "HTTP" / "Playwright")

State 3:
  ASSERT  read-only summary shows per-section strategy:
          "/products: 142 pages (HTTP)"
          "/support: 68 pages (Playwright)"

State 4:
  ASSERT  progress events show data.method matching the section's strategy
  ASSERT  HTTP sections emit method: 'http' events
  ASSERT  Playwright sections emit method: 'browser' events
```

---

## Journey 10: Draft Lifecycle & Source Integrity

**Objective coverage:** D3 (no orphan source), D10 (draft completion), D13 (bucket URLs)

### Scenario 10.1: No orphan sources

```
GIVEN  user is about to transition from State 2 → State 3
WHEN   user clicks "Continue to Config"

ASSERT  GET /sources count is unchanged (no source created at State 2 → 3)

WHEN   user clicks "Start Crawl" in State 3
ASSERT  GET /sources count increased by exactly 1
ASSERT  new source has sourceType === 'web' (not 'web_crawl')
```

### Scenario 10.2: Draft flowState lifecycle

```
Track draft via GET /crawl-drafts/:id at each state:

State 1 (URL entry):     flowState === 'profiling'
State 2 (Analysis):      flowState === 'sections_ready'
State 2 → 3 transition:  flowState === 'configured'
State 3 → 4 (Start):     flowState === 'submitted', crawlJobId is set
Crawl complete:           flowState === 'completed'
```

### Scenario 10.3: Full URLs in buckets (D13)

```
GIVEN  user is at State 2 and sections have loaded
WHEN   sections show pageCount > 10 for at least one section

ASSERT  GET /crawl-drafts/:draftId/sections/:sectionId/urls returns:
        urls.length >= section.pageCount (all URLs stored, not just 10 examples)
NOTE    This verifies the cluster-urls endpoint is storing full URL lists
```

---

## Journey 11: Handler Template Reuse (D14)

**Objective coverage:** O1 (handler reuse)

### Scenario 11.1: Bulk crawl uses discovery handler templates

```
GIVEN  discovery ran intelligence analysis on sample pages (handler templates created)
WHEN   bulk crawl processes pages structurally similar to samples

ASSERT  some progress events show extraction happened without LLM calls
        (handler reuse = 0 LLM cost)
NOTE    Verify via CrawlJob or metering data — LLM cost should be $0 for bulk path
NOTE    This is hard to assert in Playwright — may need API-level verification
        by checking handler_templates collection has entries for the domain
```

---

## Journey 12: Edge Cases & Stress

### Scenario 12.1: Double-click Start Crawl

```
GIVEN  user is at State 3
WHEN   user double-clicks "Start Crawl" rapidly

ASSERT  only ONE CrawlJob is created (not two)
ASSERT  only ONE source is created
ASSERT  button is disabled after first click (loading state)
```

### Scenario 12.2: Very small crawl (1-3 pages)

```
GIVEN  a site with only 1-3 pages (small sitemap or manual URL)
WHEN   user completes full flow

THEN   flow works identically to large crawl
THEN   progress goes from 0% to 100% quickly
ASSERT  all pages processed
ASSERT  completion summary shows correct counts
```

### Scenario 12.3: Select/deselect sections

```
GIVEN  State 2 shows multiple sections with checkboxes
WHEN   user deselects all sections
THEN   "Start Crawl" / "Continue" button is disabled (no pages selected)

WHEN   user selects only 1 section
THEN   total page count updates to that section's count
ASSERT  POST /batch only includes URLs from the selected section
```

### Scenario 12.4: Edit Sections (back from State 3 to State 2)

```
GIVEN  user is at State 3 (Configure)
WHEN   user clicks "Edit Sections" link
THEN   UI returns to State 2 with sections preserved
WHEN   user changes section selection and continues back to State 3
THEN   crawl summary updates to reflect new selection
ASSERT  page counts match the new selection
```

---

## Journey 13: Concurrent Crawls (SaaS Readiness)

**Objective coverage:** O7 (multi-tenant, fair scheduling)

### Scenario 13.1: Two crawls from same tenant

```
GIVEN  tenant has no active crawls
WHEN   user starts a crawl for Site A in KB-1
AND    user starts a crawl for Site B in KB-2 (different browser tab)

THEN   both crawls run concurrently (both show progress)
ASSERT  both CrawlJobs have status 'crawling'
ASSERT  both eventually complete
ASSERT  neither blocks the other
```

---

## Test Infrastructure Notes

### Test File Structure (match existing pattern)

```typescript
/**
 * Crawl V2 — {Journey Name} E2E Tests
 *
 * @e2e-real — No mocks, no direct DB access.
 */
import { test, expect, type Page, type BrowserContext } from '@playwright/test';
import { loginViaDevApi, getToken } from '../helpers/auth';
import { env } from '../helpers/env';
import { ServiceHealthChecker } from './helpers/service-health';
import {
  openWebCrawlerPanel,
  submitUrlAndWaitForProfiling,
  strategySitemapCard,
  sectionCheckboxes,
  crawlScreenshot,
  startNetworkCapture,
} from './helpers/crawl-flow-selectors';

const KB_NAME = process.env.TEST_KB_NAME || 'testing';
const PROJECT_ID = process.env.TEST_PROJECT_ID || '019df6d4-c039-70ec-ad14-40ec8c38f44d';

let context: BrowserContext;
let page: Page;
let token: string;

test.describe.configure({ mode: 'serial' });
test.setTimeout(600_000);
```

### Network Capture for Payload Verification

Use `page.waitForRequest()` to capture and verify POST /batch payload:

```typescript
test('settings wiring: all crawlSettings reach backend', async () => {
  // Set non-default values in State 3 UI...

  // Capture the batch request BEFORE clicking Start Crawl
  const batchRequest = page.waitForRequest(
    (req) => req.url().includes('/api/search-ai/crawl/batch') && req.method() === 'POST',
  );

  // Click Start Crawl
  await page.getByRole('button', { name: /start crawl/i }).click();

  const req = await batchRequest;
  const body = req.postDataJSON();

  // D13: Full URLs, not just 10 examples
  expect(body.urls.length).toBeGreaterThan(10);

  // D12: Per-section strategy
  expect(body.sectionMapping[0]).toHaveProperty('strategy');

  // D7: All settings wired
  expect(body.crawlSettings.crawlDelay).toBe(2000);
  expect(body.crawlSettings.respectRobotsTxt).toBe(true);
  expect(body.crawlSettings.cleanupLevel).toBe('aggressive');

  await crawlScreenshot(page, 'settings', 'batch-verified', 'POST /batch payload OK');
});
```

### WebSocket Event Capture

```typescript
// Capture WS messages for event shape verification
const wsMessages: Array<Record<string, unknown>> = [];
page.on('websocket', (ws) => {
  ws.on('framereceived', (frame) => {
    try {
      wsMessages.push(JSON.parse(frame.payload as string));
    } catch {}
  });
});

// Wait for specific event types
await expect
  .poll(() => wsMessages.filter((m) => m.type === 'url_fetched').length)
  .toBeGreaterThan(0);

// Verify event shape
const urlFetched = wsMessages.find((m) => m.type === 'url_fetched');
expect(urlFetched).toHaveProperty('data.section'); // V2 new
expect(urlFetched).toHaveProperty('data.method'); // V2 new
expect(urlFetched).toHaveProperty('data.statusCode'); // V2 new

// Verify WS URL has token (D2 fix)
page.on('websocket', (ws) => {
  expect(ws.url()).toContain('token=');
});
```

### API Verification via Direct HTTP (match existing S0/S1 pattern)

```typescript
// Use getToken() for auth, then verify via API
test('CrawlJob reaches completed status', async () => {
  const jobResponse = await page.request.get(`http://localhost:3113/api/crawl/jobs/${jobId}`, {
    headers: { Authorization: `Bearer ${token}` },
  });
  const job = await jobResponse.json();
  expect(job.data.status).toBe('completed');
  expect(job.data.urls.crawled).toBeGreaterThan(0);
});

// Verify source count (D3 — no orphan)
test('exactly one source created', async () => {
  const sourcesAfter = await page.request.get(
    `http://localhost:3113/api/indexes/${indexId}/sources`,
    { headers: { Authorization: `Bearer ${token}` } },
  );
  const data = await sourcesAfter.json();
  expect(data.data.length).toBe(sourceCountBefore + 1);
  expect(data.data.at(-1).sourceType).toBe('web'); // Not 'web_crawl'
});
```

### Test Data Recommendations

| Site                                  | Use For                                | Why                                                                 |
| ------------------------------------- | -------------------------------------- | ------------------------------------------------------------------- |
| `docs.kore.ai`                        | Happy path, sitemap tests              | Fast sitemap, consistent structure. Already used in existing tests. |
| A small static site (2-5 pages)       | Edge case small crawl, fast completion | Quick round-trip, easy to verify all pages processed                |
| A site with `robots.txt` restrictions | Robots.txt enforcement (Journey 6)     | Verifiable blocked paths                                            |
| A JS-heavy site with mixed sections   | Per-section strategy (Journey 9)       | Tests D12 HTTP vs Playwright routing                                |

### Progress Polling Pattern (match existing P3)

```typescript
// Existing pattern from crawl-configure-progress.spec.ts:
// Poll every 15s, take screenshots, extract progress via regex
const readings: string[] = [];
for (let i = 0; i < 24; i++) {
  const bodyText = await page
    .locator('main')
    .textContent()
    .catch(() => '');
  const match = (bodyText ?? '').match(/(\d+)\s*\/\s*(\d+)/);
  readings.push(match ? `${match[1]}/${match[2]}` : 'no data');

  await crawlScreenshot(page, 'progress', `t${i * 15}s`, `Progress at ${i * 15}s`);

  const lower = (bodyText ?? '').toLowerCase();
  if (lower.includes('complete') || lower.includes('failed')) break;
  await page.waitForTimeout(15_000);
}
```

---

## Priority Order for Implementation

| Priority | Scenarios                      | Why First                                            |
| -------- | ------------------------------ | ---------------------------------------------------- |
| P0       | 1.1, 1.2, 5.1, 5.2, 10.1       | Core happy path + critical regressions (D13, D7, D3) |
| P1       | 2.1, 3.1, 3.2, 4.1             | User actions + WS reliability                        |
| P2       | 1.3, 6.1, 7.1, 8.1, 9.1        | Feature completeness                                 |
| P3       | 2.2, 3.3, 7.2, 8.2, 10.2, 10.3 | Edge cases + lifecycle verification                  |
| P4       | 4.2, 11.1, 12.x, 13.1          | Stress tests + hard-to-test scenarios                |

---

## LLD Review Checklist

This section serves as an acceptance gate for the LLD. After all LLD reviewers approve,
verify each item below against the final LLD.

### Data Flow Completeness (from end-to-end trace)

| Path                             | What to Verify                                                                    |
| -------------------------------- | --------------------------------------------------------------------------------- |
| cluster-urls → buckets           | LLD specifies `draftId` param addition, full URL storage, bucket document schema  |
| mapGroupsToSections → strategy   | LLD adds `strategy` field to `CrawlSection` and `ICrawlDraftSection`              |
| handleStartCrawl → buckets-first | LLD inverts priority: `getSectionUrls()` primary, `section.pages` fallback        |
| handleStartCrawl → crawlSettings | LLD wires all 6 missing settings into `submitBatchCrawl` payload                  |
| batch route → BullMQ job data    | LLD forwards `sectionMapping` + `crawlSettings` + `draftId` in job data           |
| worker → sectionMapping          | LLD reads sectionMapping from job data (or CrawlJob MongoDB) for per-URL strategy |
| worker → HandlerReuser           | LLD seeds from MongoDB via `store.findByDomain()` at job start (D14)              |
| worker → progress events         | LLD emits `data.{section, method, statusCode, duration}` per event                |
| cancel → Redis + BullMQ          | LLD sets `crawl:cancel:{jobId}` + removes BullMQ job                              |
| completion → draft update        | LLD updates `CrawlDraft.flowState → 'completed'` in worker's finally block        |
| activity bar → hydration         | LLD calls `GET /api/crawl-drafts/active` on mount                                 |
| resume → state restoration       | LLD reads draft + CrawlJob, opens at correct State 4 sub-state                    |
| stale detection → soft delete    | LLD sets `staleAt`, adds TTL index, excludes from search query filter             |

### Cross-Task Contracts

| Producer Task               | Consumer Task                    | Contract to Verify                                       |
| --------------------------- | -------------------------------- | -------------------------------------------------------- |
| T-0 (buckets)               | T-5 (State 3 + handleStartCrawl) | `getSectionUrls()` returns full URL list                 |
| T-0 (buckets)               | T-1 (worker)                     | URLs in batch request match bucket contents              |
| T-1 (worker events)         | T-4 (WS + progress UI)           | `useCrawlProgress` handles `data.section`, `data.method` |
| T-2 (batch route)           | T-1 (worker)                     | `sectionMapping` is in BullMQ job data                   |
| T-3 (robots + rate limiter) | T-1 (worker)                     | Worker imports `isUrlAllowed()` and `DomainRateLimiter`  |
| T-5 (strategy field)        | T-2 (batch route)                | `sectionMapping[].strategy` accepted by Zod validation   |
| T-6 (activity bar)          | T-2 (active drafts endpoint)     | `GET /api/crawl-drafts/active` returns correct shape     |
| T-7 (re-crawl)              | T-1 (worker)                     | `CrawlJob.comparison` populated after re-crawl           |

### Objective Coverage Matrix

| Objective              | Primary Tasks | Test Scenarios          | LLD Must Cover                                  |
| ---------------------- | ------------- | ----------------------- | ----------------------------------------------- |
| O1: Honor discovery    | T-0, T-1, T-5 | 1.1, 1.2, 1.3, 10.3     | URL fidelity, section mapping, handler reuse    |
| O2: Honor config       | T-3, T-5      | 5.1, 5.2, 6.1           | All 6 settings wired, robots.txt enforcement    |
| O3: Real-time progress | T-1, T-4      | 1.1, 4.1                | Event fields, section fills, ETA                |
| O4: WS reliability     | T-4           | 4.1, 4.2                | Token auth, dev mode direct, polling fallback   |
| O5: User actions       | T-1, T-2, T-6 | 2.1, 2.2, 3.1, 3.2, 3.3 | Cancel, minimize, resume, KB banner             |
| O6: Never lose work    | T-1           | 7.1, 7.2                | Crash recovery, partial results, checkpoint     |
| O7: SaaS-ready         | T-1, T-8      | 13.1                    | Semaphore, rate limiter, TTL, fair scheduling   |
| O8: Re-crawl           | T-7           | 8.1, 8.2                | Dedup, comparison, stale detection, failed-only |
| O9: Remove Go          | T-9           | —                       | Build passes, no dead refs                      |

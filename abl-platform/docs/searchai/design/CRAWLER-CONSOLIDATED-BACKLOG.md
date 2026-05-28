# Crawler Discovery — Consolidated Backlog (Validated)

> **Purpose:** Single source of truth for all pending crawler work. Every item validated against
> the actual codebase on 2026-04-21. Re-validated 2026-04-22 against design docs (UNIFIED §13, §14, §24, §24b),
> memory files (4 UX feedback items, depth probing design, impl plan), and product context
> (production-facing, customer demos, active customers).
>
> **Date:** 2026-04-22 (rev 2)
> **Status:** VALIDATED — pending Bharat's review

---

## Validation Summary

We started with 73 items from 4 docs + 3 memory files. After codebase validation:

- **22 items removed** — already implemented or inaccurate claims
- **5 items downgraded** — partially done, scope reduced
- **46 items confirmed** as genuinely pending work
- **5 items added** in rev 2 — file/document discovery, extraction preview, site compatibility check, error transparency, crawl results dashboard (were missing from original backlog)

Key findings from validation:

- **5 of 9 "P0 blockers" were INVALID** — extraction cascade, quality scoring, auth on discover endpoints, crawl button, and intelligence panel are all already working
- **7 of 21 UX items were already done** — depth probing settings, breadcrumb display, activity status, clickable URLs, flow stepper, draft persistence, section grouping
- **2 tech debt items were invalid** — priority queue exists (PriorityFrontier), MCP orphan leak has SIGTERM handlers
- **UX-9 (mid-discovery intervention) was severely under-described** — UNIFIED §24b designed 7 intervention types, 3-zone layout, 5 tree node states, 7 new SSE events, and 6 new components. Backlog had a one-liner. Now expanded into sub-items.
- **EQ-4 (PDF/document crawling) was severely under-scoped** — `SKIP_EXTENSIONS` silently drops ALL non-HTML links (.pdf, .docx, .xlsx, .pptx, .zip). User never sees files were found. Docling supports all these formats but only receives HTML from crawler. Now expanded with transparency requirements.
- **GAP-1 was wrong** — said sample URLs should move to Step 1 (State1UrlEntry). Correct fix: make existing inputs in Step 2 prominent with better fonts and messaging. User confirmed.

---

## P0 — Real Blockers (4 remaining)

All validated as genuinely unaddressed in the codebase.

| #    | Title                    | Description                                                                                                                                                                                                                                                                                                                     | Evidence                                                                                                |
| ---- | ------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------- |
| P0-1 | MCP server no auth       | Anyone reaching :3100 can execute browser automation, arbitrary JS, trigger crawls. Zero auth middleware in `crawler-mcp-server/src/server.ts`.                                                                                                                                                                                 | No `requireAuth`, no token validation, no API key checks on `/api/explore`, `/api/explore-deep`, `/mcp` |
| P0-2 | MCP no rate limiting     | Per-request `McpServer` creation (lines 642-646 of server.ts). No throttling. Resource exhaustion vector.                                                                                                                                                                                                                       | Grep for `rateLimit` or `throttle` = 0 matches                                                          |
| P0-3 | `execute_javascript` RCE | `page.evaluate(args.code)` with zero validation in `tools/javascript.ts`. Combined with P0-1, anyone can execute arbitrary JS.                                                                                                                                                                                                  | No sandbox, allowlist, blocklist, or guard                                                              |
| P0-4 | Quality-driven retry     | Extraction cascade picks best result but does NOT trigger re-crawl if all layers produce thin content. Returns `accepted: false` with no feedback to crawler. Two layers needed: (a) auto-retry with browser rendering as fallback in the pipeline, (b) UX-A8 for user-driven re-crawl of remaining thin pages post-completion. | No `retry.*quality` matches in search-ai. Cascade logs warning but pipeline continues.                  |

### Removed from P0 (were invalid)

| Old #    | Claim                                 | Why Removed                                                                                                                                                                                                                                |
| -------- | ------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| ~~P0-1~~ | Readability.js = raw innerText dump   | **INVALID**: 3-layer extraction cascade exists (`extraction-cascade.ts`) — Readability → Semantic HTML → Body fallback. Each layer strips nav/footer/aside. Body fallback is NOT raw innerText.                                            |
| ~~P0-2~~ | QualityGate = naive char-length >2000 | **INVALID**: Composite scoring formula: 0.4×contentGate + 0.35×(1-boilerplateRatio) + 0.25×contentGate. Boilerplate ratio measures nav/footer/aside text vs total. Plus full `QualityMetricsService` (noise, structure, metadata scoring). |
| ~~P0-7~~ | Discover/browser endpoints no auth    | **INVALID**: `server.ts` line 201 applies `authMiddleware` to all `/api` routes. Each endpoint in `crawl-browser-discover.ts` checks `req.tenantContext` and returns 401. Tenant isolation via `getOwnedExploration()`.                    |
| ~~P0-8~~ | CrawlIntelligencePanel raw HTML       | **INVALID**: Displays `analysisResult.body` as text in `<p>` tag (React auto-escapes). No `dangerouslySetInnerHTML`. Body is extracted text, not raw HTML.                                                                                 |
| ~~P0-9~~ | handleStartCrawl not wired            | **INVALID**: Fully implemented in `CrawlFlowV5.tsx` lines 502-602. Creates source via `addSource()`, submits batch crawl via `submitBatchCrawl()`, updates draft with job ID.                                                              |

---

## Bugs (Open — 2)

| #     | Title                                | Description                                                                                                               | Priority |
| ----- | ------------------------------------ | ------------------------------------------------------------------------------------------------------------------------- | -------- |
| BUG-1 | "Could not save draft" 500 error     | Reported in testing session, root cause unknown. Needs investigation or removal if not reproducible.                      | MEDIUM   |
| BUG-2 | Frontend auto-save on config changes | Config changes not auto-saved to draft (draft save on state transitions works). Only matters on browser crash mid-config. | LOW      |

---

## UX Improvements

### Already Done (removed from backlog)

| Old #     | Title                            | Evidence                                                                                                                                        |
| --------- | -------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------- |
| ~~UX-1~~  | Depth probing settings in UI     | `State2Analysis.tsx` lines 121-136: toggle, maxPages slider (5-50), maxDepth, sampleSize. Passed to `BrowserDiscoveryInline`.                   |
| ~~UX-3~~  | Breadcrumb chain display         | `BrowserDiscoveryInline.tsx` lines 388-397: shows strategy + breadcrumb text chain                                                              |
| ~~UX-4~~  | Natural language activity status | `BrowserDiscoveryInline.tsx` line 392: `progress.currentAction` + per-phase labels                                                              |
| ~~UX-6~~  | Clickable sample URL chips       | `State2Analysis.tsx` lines 631-654: `<a href target="_blank">` with ExternalLink icon                                                           |
| ~~UX-7~~  | Flow stepper                     | `FlowStepper.tsx`: 4-step persistent breadcrumb nav, used in `CrawlFlowV5.tsx`                                                                  |
| ~~UX-13~~ | Draft persistence                | Full CRUD: `createCrawlDraft`, `updateCrawlDraft`, `getCrawlDraft`. Auto-save on state transitions. Resume from drafts in `State1UrlEntry.tsx`. |
| ~~UX-14~~ | Section tree grouping            | `State2Analysis.tsx` lines 675-790: path-prefix groups, collapsible, group-level checkboxes                                                     |

### Pending — Transparency & User Control (the core UX vision)

> **Design principle** (from UNIFIED "Next Objective"): Every piece of information shown to the user
> should answer: (1) What is the system doing? (2) What can I do about it? The system should feel like
> pair-navigation — the system drives, the user reads the map and gives directions.

#### UX-5: Sample URL Input Prominence + Messaging — P1

**Problem observed:** Sample URL input box is hidden until user acts, font sizes are too small (`text-[10px]` hint, `text-xs` inputs), and descriptions don't explain why samples help the backend find the right data.

**Designed solution** (UNIFIED §24b Zone 1):

- Show 1 sample input by default (not hidden behind an action)
- Heading becomes "Find specific content" (action-oriented, not "Discover more content")
- Copy explains WHY: "Paste 1-3 example pages. We'll navigate the site to find all similar pages."
- Font hierarchy: heading 18px, description 14px, input 16px (currently 10-12px)
- Inputs become read-only clickable chips during discovery with "Edit" to pause and modify
- Advanced settings collapsed but visually present

**Files:** State2Analysis.tsx, ExplorePanel.tsx, studio.json (i18n keys: `sample_urls_hint`, `explore_prompt_desc`, `context_paste_samples`, `find_more_content`)

#### UX-8: Discovery Audit Trail — P1

**Problem observed:** After discovery completes, user can't see how pages were found or which methods worked.

**Designed solution** (UNIFIED §14):

- Expandable audit trail table: Method | Found | Matched | Validated | Sections
- Shows each discovery layer: Sitemap, HTTP pass 1, Browser, API interception, HTTP pass 2 (FAQs), HTTP pass 2 (manuals)
- User can re-run individual phases ("try HTTP again with deeper crawl")
- Critical for demos: customers will ask "how did you find those pages?"

**Files:** New `DiscoveryAuditTrail.tsx` component, reuses DiscoveryTimeline data

#### UX-9: Mid-Discovery Intervention — P1 (was P2, upgraded)

**Problem observed:** Once discovery starts, user can only "Stop & use results" — a binary all-or-nothing choice. On large sites (10K+ pages), discovery is not short. User sees it going wrong direction but can't course-correct without losing progress.

**Designed solution** (UNIFIED §24b "Mid-Discovery Intervention Model" + §24 per-phase transparency):

7 intervention types at different granularities:

| #     | Intervention                    | When Available                    | Effect                                                                                                                                                                                                                                        | SSE/API Needed                                 |
| ----- | ------------------------------- | --------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------- |
| UX-9a | **Stop & use results**          | Always during discovery           | Immediate stop, use everything found so far                                                                                                                                                                                                   | Already exists (stop button)                   |
| UX-9b | **Run in background**           | During any phase                  | Discovery continues, panel collapses to banner, user configures existing sections. Banner: "Discovery running... 89 links found [View details] [Stop]". On completion: "Discovery complete — 340 new pages in 3 sections [Review] [Auto-add]" | No new API — just UI state change              |
| UX-9c | **Add sample URL**              | During any phase                  | New sample queued, visited when current phase completes                                                                                                                                                                                       | POST to add sample while SSE running           |
| UX-9d | **Edit samples** (pause/resume) | During any phase                  | Discovery pauses, user edits, resumes with new samples. Inputs switch from read-only chips back to editable. Confirmation: "This will restart discovery with your changes."                                                                   | POST to pause + POST to resume with new params |
| UX-9e | **Explore branch**              | When tree has unexplored nodes    | Visits specific hub page, adds results to tree                                                                                                                                                                                                | POST with target URL                           |
| UX-9f | **Skip branch**                 | When tree has unexplored nodes    | Excludes branch from results (greyed out, can undo)                                                                                                                                                                                           | Client-side only                               |
| UX-9g | **Explore all at level**        | When multiple unexplored siblings | Batch-visit all siblings at same depth                                                                                                                                                                                                        | POST with depth + parent                       |

**Per-phase transparency** (from UNIFIED §24 + memory depth_probing_design):

| Phase            | What User Sees                                                                                                                                                                  | Interventions Available                                                                                                    |
| ---------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------- |
| Visit Sample     | "Visiting your sample page..." with URL, breadcrumb chain (clickable), page classification (hub/leaf), link count                                                               | Skip this sample, add another sample                                                                                       |
| Breadcrumb Climb | Live tree visualization, running totals (visited/verified/projected), current action ("Visiting All-In-Ones hub — 8 series found"), yield rate (productive/declining/exhausted) | Explore/skip tree nodes, explore all at level, go deeper into specific branch, stop & use results, adjust settings mid-run |
| Seed Exploration | Click progress, new-link-per-click rate, diminishing returns indicator                                                                                                          | Skip seed scan, force-continue past diminishing returns                                                                    |
| Projection       | URL pattern found, projection count, confidence breakdown (verified vs projected vs inferred)                                                                                   | "Visit more to verify", "Too broad — tighten", "Looks right — proceed"                                                     |

**New SSE events needed** (from UNIFIED §24b):

| Event               | Data                                         | When                                     |
| ------------------- | -------------------------------------------- | ---------------------------------------- |
| `breadcrumb-found`  | `{ chain: [{text, href, depth}] }`           | After visiting sample URL                |
| `hub-discovered`    | `{ url, name, childCount, depth, source }`   | After visiting a hub page                |
| `node-visiting`     | `{ url, depth }`                             | When starting to visit a new page        |
| `node-complete`     | `{ url, role, linksFound, childNodes[] }`    | After extracting links from visited page |
| `node-failed`       | `{ url, error, retryable }`                  | When a page visit fails                  |
| `projection-update` | `{ totalVerified, totalProjected, byDepth }` | After projection recalculation           |
| `yield-update`      | `{ rate, trend }`                            | Periodically during exploration          |

**New components** (from UNIFIED §24b):

| Component               | Description                                                                                                                  |
| ----------------------- | ---------------------------------------------------------------------------------------------------------------------------- |
| `DiscoveryPanel.tsx`    | Replaces BrowserDiscoveryInline — 3-zone layout (intent input, activity, tree)                                               |
| `DiscoveryTree.tsx`     | Interactive tree with node states (✅ visited, ○ discovered, 🔄 visiting, ⊘ skipped, ⚠️ failed), expand/skip/explore actions |
| `DiscoveryActivity.tsx` | Current-action display with natural language status, rate indicators, yield estimation                                       |
| `SampleUrlInput.tsx`    | Extracted from State2Analysis — prominent input with validation, clickable chips, guidance copy                              |

**Comms approach** (from TD-7): POST-alongside-SSE. SSE streams events server→client. Client sends interventions via POST to separate endpoints. No WebSocket needed.

#### UX-2: Discovery Tree (interactive) — P1

**Problem observed:** Current grouped list is flat. No hierarchical tree with depth, parent-child relationships, or drill-down. For demos, visual hierarchy IS the product story — shows the crawler is "smart."

**Designed solution** (UNIFIED §24b Zone 3):

Tree node states:
| Icon | Meaning | Action |
|------|---------|--------|
| ✅ | Visited — links extracted, count shown | Expand to see child nodes |
| ○ | Discovered but not visited | [Explore] visits it, [Skip] ignores it |
| 🔄 | Currently being visited | Spinner, auto-expands when done |
| ⊘ | Skipped by user | Greyed out, can undo |
| ⚠️ | Visit failed (404, timeout) | Shows error, can retry |

Per node: name (from URL segment), source ("visited hub" / "projected" / "from breadcrumb"), count (links/pages), confidence (verified/projected).

Interaction: click name → expand/collapse, [Explore ▶] → visit URL + extract links, [Skip ✕] → exclude, [Explore all ▶▶] → batch-visit all siblings.

Footer: "Use these results" → proceed to sections, "Explore more..." → pick branches.

**Files:** New `DiscoveryTree.tsx`, types in `types.ts` (`DiscoveryTreeNode`, etc.)

**Note:** Start with indented tree + counts first. Full D3/SVG visualization is optional later.

#### UX-15: Smart default section selection — P1

**Problem observed:** All sections selected by default overwhelms users with 50+ sections.

**Solution:** Show top ~10 high-confidence sections expanded (by match count + depth). Rest collapsed under "Show N more sections." User opts in rather than system guessing. Not a "smart pre-select" — a "smart default view."

#### UX-17: Secondary pattern confirmation — P1

**Problem observed:** When a second URL pattern is detected (e.g., FAQs alongside product pages), it's handled silently.

**Solution:** Dialog: "We also found FAQ pages (estimated 4,200). Include them?" with preview. Only implementable after ALG-4 (secondary pattern detection) exists. **Blocked by ALG-4.**

### Pending — Medium Value

| #     | Title                      | Description                                                                                                                                                                                                                                         | Priority |
| ----- | -------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | -------- |
| UX-10 | CSS scope selector         | Scope discovery to specific DOM region. Very few users know CSS selectors. Platform-aware extraction (EQ-1) is the better fix for most cases.                                                                                                       | P3       |
| UX-12 | Discovery result caching   | Two levels (from UNIFIED §24b): (1) Draft-level — persist discoveryTree, stats, samples, phase to CrawlDraft for resume. (2) Site-level — backend cache by hash(seedUrl+samples+config), 24h TTL. UI: "Using cached results from 3h ago. [Refresh]" | P2       |
| UX-16 | Section merge              | User-initiated merge of two sections into one. Include/exclude and rename already work.                                                                                                                                                             | P2       |
| UX-18 | API exhaustion progress UI | Progress display for API exhaustion phase. **Blocked by ALG-1.**                                                                                                                                                                                    | P2       |
| UX-19 | HTTP fan-out progress UI   | Fan-out already has SSE events. May be partially shown in DiscoveryTimeline already. Verify before building.                                                                                                                                        | P2       |
| UX-20 | UX unification             | Three separate flows coexist: CrawlFlowV5, CrawlJobForm, BulkImportForm. CrawlerTab still uses old CrawlJobForm. This is a major refactor, not a UX item — should be a separate initiative.                                                         | P1       |

---

## File/Document Discovery & Processing (NEW — was under-scoped as EQ-4)

> **Problem:** The crawler silently throws away every non-HTML link it finds. `SKIP_EXTENSIONS` in
> `link-extractor.ts` drops .pdf, .doc, .docx, .xls, .xlsx, .ppt, .pptx, .zip, and more.
> Users never see files were found. On real customer websites, PDFs (product manuals, datasheets,
> whitepapers), Word docs, and spreadsheets are common. Docling already supports PDF/DOCX/PPTX/images
> but only receives HTML from the crawler pipeline.
>
> **Why this matters:** Customer demos on sites with PDF manuals (like Epson) currently miss all
> downloadable content. The system looks incomplete.

| #     | Title                           | Description                                                                                                                                                                               | Priority |
| ----- | ------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | -------- |
| DOC-1 | File discovery visibility       | During discovery, separately count and display discovered file links by type: "Found 47 pages and 12 PDFs, 3 Word docs". Currently silently dropped by `SKIP_EXTENSIONS`.                 | P1       |
| DOC-2 | User choice per file type       | Checkboxes: "Include PDFs (12 found)", "Include Word docs (3 found)", "Include spreadsheets (0 found)". User decides what to crawl.                                                       | P1       |
| DOC-3 | File download + Docling routing | Download binary files during crawl. Create SearchDocument with actual MIME type (currently hardcoded `text/html`). Route through Docling (PDF/DOCX/PPTX) or structured handler (CSV/XLS). | P1       |
| DOC-4 | File processing progress        | "Processing 12 PDFs via Docling..." with per-file status. Separate from page crawl progress.                                                                                              | P2       |
| DOC-5 | File type badges on sections    | Sections show file type composition: "[47 pages] [12 PDFs] [3 docs]" so user sees what's in each section.                                                                                 | P2       |

**Implementation notes:**

- `link-extractor.ts` `SKIP_EXTENSIONS`: don't remove — instead, collect file links separately and pass them through as `discoveredFiles[]`
- `crawler-ingestion.ts` line 449: change hardcoded `contentType: 'text/html'` to actual MIME detection
- `document-routing.ts` already maps MIME types to extraction routes — just needs to receive non-HTML content from crawler
- Docling Python service supports: PDF, DOCX, PPTX, HTML, Markdown, PNG, JPEG, TIFF, BMP, WEBP
- **Not supported by Docling:** DOC, PPT (legacy Office), CSV, JSON, XML — these need separate handlers or LibreOffice conversion

---

## Missing UX Items (NEW — not in any previous backlog)

| #     | Title                                | Problem                                                                                                                                               | Proposed Solution                                                                                                                                                                                             | Priority |
| ----- | ------------------------------------ | ----------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | -------- |
| NEW-1 | Extraction preview before full crawl | User commits to crawling 1000 pages without seeing what the extracted content looks like. Demo risk: extraction quality unknown until crawl finishes. | After discovery, show extraction preview for 2-3 sample pages: "Here's what we'll extract — looks good?" User can switch to browser rendering if extraction is poor. Reuses existing `extraction-cascade.ts`. | P1       |
| NEW-2 | Error transparency per URL           | When URLs fail during crawl (timeout, 403, JS-required), user sees only a failed count. Not actionable.                                               | Per-URL failure reason in Step 4 progress: "15 pages need browser rendering", "8 pages returned 403", "3 pages timed out." Actionable: "Re-crawl 15 JS pages with browser? [Yes]"                             | P1       |
| NEW-3 | Site compatibility check             | Before crawling 1000 pages, no probe of whether the site works with HTTP or needs browser mode. Demo failure risk.                                    | Before full crawl, probe 3-5 representative pages: "This site uses JavaScript rendering — browser mode recommended" or "This site blocks automated requests — configure delays." Reuses existing profiling.   | P1       |
| NEW-4 | Crawl results dashboard              | After crawl completes, panel closes. User goes to CrawlerTab which is a different context. No continuity.                                             | "View Results" button in Step 4 completion state. Show summary: pages crawled, quality distribution, sections filled, any failures. Link to full results in CrawlerTab.                                       | P1       |
| NEW-5 | Robots.txt transparency              | Currently zero robots.txt handling (H-3). Even before full compliance is built, user should know if a site restricts crawling.                        | During site probe (NEW-3), check robots.txt. Show: "This site restricts crawling on /admin/, /api/. We'll respect that." Transparency about what the crawler will and won't touch.                            | P1       |

---

## Algorithm

### Completed

| #                | Title                                                                                                |
| ---------------- | ---------------------------------------------------------------------------------------------------- |
| Pattern Scoring  | Multi-pattern scoring with degenerate detection (`200fa0d34`)                                        |
| API Interception | Playwright page.route() captures XHR/fetch (`eaf8d8b5c`)                                             |
| Breadcrumb-Climb | 5 extraction strategies, diminishing returns, hub projection (`9ee342f07`, `22706da45`, `58fb1e199`) |

### Pending

| #     | Title                           | Description                                                                                                                                                                   | Priority |
| ----- | ------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | -------- |
| ALG-1 | API Exhaustion                  | Response body capture, catalog classification, browser-proxied pagination following                                                                                           | P2       |
| ALG-2 | Vocabulary Extraction           | Cascading dropdown walker, vocabulary tree, FAQ category detection. Niche — only for sites like Epson with JS-rendered category nav. Breadcrumb-climb covers the common case. | P3       |
| ALG-3 | Site Probe + Strategy Selection | 7-signal profiler, decision tree, execution orchestrator. Depends on ALG-1 + ALG-2. Premature — not enough site data for a reliable decision tree.                            | P3       |
| ALG-4 | Secondary pattern detection     | Detect secondary URL patterns from links on matched pages. Blocks UX-17.                                                                                                      | P2       |
| ALG-5 | HEAD validation batch           | Validate projected/discovered URLs via HTTP HEAD before including in sections                                                                                                 | P2       |
| ALG-6 | Projected URL validation        | Template-based projection URLs may 404. Recommendation: DOM-only projection as default.                                                                                       | P1       |
| ALG-7 | Page classifier tuning          | JS-heavy hub pages (Epson categories) classified as `leaf` not `hub`. May need "classify after JS execution" not just DOM signals.                                            | P2       |

---

## Production Hardening

| #   | Title                                 | Description                                                                                                                                                                                                                            | Priority | Validation                                    |
| --- | ------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | -------- | --------------------------------------------- |
| H-1 | BullMQ for discover crawl             | Intelligence crawl already uses BullMQ. **Discover crawl** runs in-process (`crawl-discover.ts` line 28: "In-memory crawl state, sufficient for single instance").                                                                     | P1       | **VALID** — only discover crawl is in-process |
| H-2 | Redis state for discover crawl        | Discover crawl state is `Map<string, CrawlState>` in memory (line 58). Code comment: "For multi-pod: move to Redis hash." Bundle with H-1.                                                                                             | P1       | **VALID**                                     |
| H-3 | Per-domain rate limiting + robots.txt | Zero matches for robots.txt, crawl-delay in search-ai. Only `batchDelay=200ms` between batches. No per-domain concurrency. **Also a legal/compliance concern**, not just hardening. Robots.txt transparency (NEW-5) is the first step. | **P0**   | **VALID**                                     |
| H-4 | Per-tenant fair sharing               | No max concurrent crawls per tenant                                                                                                                                                                                                    | P1       | **VALID**                                     |
| H-5 | Fan-out depth bound                   | "Search deeper" can recurse without bound. Simple max-depth check.                                                                                                                                                                     | LOW      | **VALID**                                     |

### Removed from Hardening

| Old #   | Claim                   | Why Removed                                                                                                                                                                    |
| ------- | ----------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| ~~H-6~~ | MCP orphan process leak | **INVALID**: `server.ts` lines 296-315 has `setupShutdown()` with SIGTERM/SIGINT handlers. `close()` properly shuts down HTTP transport, server, MCP server, and browser pool. |

---

## Extraction Quality

| #    | Title                       | Description                                                                                                                                                                                                                                                                               | Priority | Validation                                      |
| ---- | --------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | -------- | ----------------------------------------------- |
| EQ-1 | Platform-aware extraction   | PlatformDetector does NOT exist in search-ai. Extraction is generic 3-layer cascade. `siteType` param accepted but only passed to Readability — no platform-specific selectors. Consider user-provided CSS content selector per source as simpler alternative to full platform detection. | P1       | **VALID**                                       |
| EQ-2 | Structured content handlers | No special handling for tables, code blocks, FAQ accordions. All flattened to text. Tables should become markdown tables, code should be code blocks.                                                                                                                                     | P1       | **VALID**                                       |
| EQ-3 | Image/media extraction      | Split into two: (a) alt text extraction — trivial, add to extraction cascade. (b) Image-to-text — requires OCR pipeline, defer.                                                                                                                                                           | P2 / P3  | **VALID**                                       |
| EQ-4 | PDF/document crawling       | **Expanded into DOC-1 through DOC-5 above.** Crawler silently drops all non-HTML links. Docling ready but never receives non-HTML from crawler.                                                                                                                                           | P1       | **VALID** — see File/Document Discovery section |
| EQ-5 | Scheduled re-crawl          | Scheduler has connector sync jobs but no crawl re-run or change detection. Premature — users haven't requested this yet.                                                                                                                                                                  | P3       | **VALID**                                       |

---

## Security

| #      | Title                               | Description                                                                                                                         | Priority | Validation                                  |
| ------ | ----------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------- | -------- | ------------------------------------------- |
| SEC-1  | MCP no auth                         | = P0-1. Consider: if MCP is only called by search-ai internally, bind to localhost + shared secret instead of full auth middleware. | **P0**   | **VALID**                                   |
| SEC-2  | MCP no rate limiting                | = P0-2. Fix root cause (singleton/pooled McpServer) in addition to rate limiting.                                                   | **P0**   | **VALID**                                   |
| SEC-3  | MCP shared browser pool             | `sessionId = 'default'` in server.ts line 109 for ALL MCP tools. REST `/api/explore` uses unique IDs so only MCP tools affected.    | MEDIUM   | **VALID**                                   |
| SEC-4  | `execute_javascript` RCE            | = P0-3. Consider removing `execute_javascript` entirely — replace with fixed named operations (click, scroll, extract).             | **P0**   | **VALID**                                   |
| SEC-5  | Unbounded `activeSubscriptions` Map | Map self-cleans on WS close, but no cap for orphaned entries on unclean disconnect                                                  | LOW      | **PARTIAL** — mitigated by cleanup on close |
| SEC-6  | MCP binds 0.0.0.0                   | `server.ts` line 347 and 705: binds all interfaces                                                                                  | LOW      | **VALID**                                   |
| SEC-7  | JWT in WebSocket URL                | `useIntelligenceProgress.ts` line 152: token in query param. Standard WS limitation.                                                | MEDIUM   | **VALID**                                   |
| SEC-8  | Redis connection per WS subscriber  | No connection pool/cap                                                                                                              | LOW      | Not validated — low priority                |
| SEC-9  | Token in WS error messages          | Failed WS may expose token                                                                                                          | LOW      | Not validated — low priority                |
| SEC-10 | Direct jsonwebtoken in progress.ts  | `progress.ts` line 12: `import jwt from 'jsonwebtoken'`, line 148: `jwt.verify()`. Violates centralized auth rule.                  | LOW      | **VALID**                                   |

---

## Wireframe Settings (Not Implemented)

| #    | Setting            | Wireframe Control           | Current State                                                                                                    |
| ---- | ------------------ | --------------------------- | ---------------------------------------------------------------------------------------------------------------- |
| WS-1 | Request speed      | Slider: Polite → Aggressive | PARTIAL (concurrency exists, no per-request delay)                                                               |
| WS-2 | AI model selection | Dropdown                    | NOT IMPLEMENTED — needs definition: which model for which purpose (extraction? quality scoring?)                 |
| WS-3 | AI budget          | Slider: 0-100 pages         | NOT IMPLEMENTED (type exists, not enforced). Consider: budget in $ or tokens is more meaningful than page count. |
| WS-4 | Content cleanup    | Toggle: Keep/Clean          | NOT IMPLEMENTED — needs definition: what cleanup beyond extraction cascade?                                      |
| WS-5 | Duplicate content  | Toggle: Enable/Disable      | NOT IMPLEMENTED (no content dedup — no SimHash or similar)                                                       |
| WS-6 | Cookie consent     | Toggle: Auto-dismiss        | NOT IMPLEMENTED (no module). Cookie banners block content extraction on many sites. Libraries exist.             |

---

## Tech Debt

| #    | Title                          | Description                                                                                                                                                                           | Validation                                 |
| ---- | ------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------ |
| TD-1 | SSE bypasses Next.js proxy     | By design — documented in `crawl.ts` lines 709-721. NextResponse.rewrite buffers SSE. In production, ingress routes directly. SSE connections carry no auth (EventSource limitation). | **VALID** — by design, but auth gap on SSE |
| TD-3 | URL dedup incomplete           | Trailing slash, query param ordering, fragment stripping inconsistent. No content SimHash.                                                                                            | Not fully validated                        |
| TD-4 | Extraction cascade layers      | Designed as 5-layer (JSON-LD → Platform → Readability → Semantic → Body) but only 3 layers implemented                                                                                | **VALID**                                  |
| TD-5 | Test spec missing              | No test spec for browser-guided URL generation                                                                                                                                        | **VALID**                                  |
| TD-6 | Slug heuristic false positives | Pattern matcher may false-positive on non-product URLs                                                                                                                                | Not fully validated                        |
| TD-7 | WebSocket vs SSE decision      | **Resolved:** POST-alongside-SSE for UX-9 interventions. No WebSocket needed.                                                                                                         | Resolved                                   |

### Removed from Tech Debt

| Old #    | Claim                         | Why Removed                                                                                                                                                 |
| -------- | ----------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------- |
| ~~TD-2~~ | No priority queue in frontier | **INVALID**: `priority-frontier.ts` implements `PriorityFrontier` with score-based sorted array, binary search insertion, max size (10K), max depth limits. |

---

## "Discover Everything" Mode (Needs Design)

| #      | Title                          | Description                                              | Priority |
| ------ | ------------------------------ | -------------------------------------------------------- | -------- |
| AUTO-1 | Background full-site discovery | Auto-discover all sections without user interaction      | P2       |
| AUTO-2 | Auto-section creation          | Automatically create sections from discovered URL groups | P2       |
| AUTO-3 | Auto-crawl trigger             | Start crawling immediately after discovery completes     | P2       |

---

## Validated Summary

| Category                 | P0        | P1    | P2  | P3/Low | Total |
| ------------------------ | --------- | ----- | --- | ------ | ----- |
| P0 Blockers              | **4**     | —     | —   | —      | 4     |
| Bugs                     | —         | —     | 2   | —      | 2     |
| UX — Transparency        | —         | 6     | 3   | 1      | 10    |
| UX — Intervention (§24b) | —         | 7 sub | —   | —      | 7     |
| UX — Discovery Tree      | —         | 1     | —   | —      | 1     |
| UX — Other               | —         | 2     | 3   | —      | 5     |
| File/Doc Discovery       | —         | 3     | 2   | —      | 5     |
| Missing UX (NEW)         | —         | 5     | —   | —      | 5     |
| Algorithm                | —         | 1     | 3   | 2      | 6     |
| Production Hardening     | 1         | 3     | —   | 1      | 5     |
| Extraction Quality       | —         | 2     | 1   | 2      | 5     |
| Security                 | 3 (in P0) | —     | 3   | 4      | 7     |
| Wireframe Settings       | —         | —     | 6   | —      | 6     |
| Tech Debt                | —         | —     | 3   | 2      | 5     |
| Auto Mode                | —         | —     | 3   | —      | 3     |

---

## UX Flow Additions — Complete the End-to-End Crawl Experience

> **Context:** The 4-step flow (URL Entry → Analysis → Configure → Crawl) exists but Step 4 is
> a dead end — the panel closes after "Start Crawl" with no monitoring. Most building blocks
> already exist. These are **additions** to the current flow, not a rewrite.

### Current gaps in the flow

| Gap    | Where            | Problem                                                                                            |
| ------ | ---------------- | -------------------------------------------------------------------------------------------------- |
| GAP-1  | Step 2           | Sample URL inputs exist but are hidden, tiny fonts, unclear copy about why they matter             |
| GAP-2  | Step 1→2         | Going back from Step 2 to Step 1 destroys all analysis results                                     |
| GAP-3  | Step 2           | No way to add URLs manually (paste a list)                                                         |
| GAP-4  | Step 3           | "Custom" scope has no number input to set page limit                                               |
| GAP-5  | Step 3           | No cost estimate or impact preview before starting                                                 |
| GAP-6  | Step 4           | `crawling` and `done` states defined in types.ts but never used — panel closes                     |
| GAP-7  | Step 4           | CrawlJobProgress exists separately in CrawlerTab but is disconnected from CrawlFlowV5              |
| GAP-8  | Post-crawl       | No "re-crawl thin content" action after completion                                                 |
| GAP-9  | Step 2 (NEW)     | No extraction preview — user can't see what content will look like before committing to full crawl |
| GAP-10 | Step 4 (NEW)     | Failures show count only, not per-URL reason. Not actionable.                                      |
| GAP-11 | Pre-crawl (NEW)  | No site compatibility check — user doesn't know if site needs browser mode until crawl fails       |
| GAP-12 | Step 2 (NEW)     | Files (PDFs, docs) silently dropped during discovery — user never sees them                        |
| GAP-13 | Post-crawl (NEW) | Panel closes after crawl. No continuity — user sent to CrawlerTab separately.                      |

### Implementation items (additions to existing components)

| #      | Addition                                | Existing Code to Reuse                                                          | What to Add                                                                                                                                                                                                                                                                               | Files                                             | Effort |
| ------ | --------------------------------------- | ------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------- | ------ |
| UX-A1  | Sample URL input prominence + messaging | Inputs exist in State2Analysis (line 848-876) and ExplorePanel (line 672-715)   | (1) Show 1 sample input by default instead of hidden, (2) bump font sizes: heading 18px, description 14px, input 16px, (3) rewrite i18n strings to explain that samples guide pattern matching + breadcrumb climbing, (4) read-only clickable chips during discovery with "Edit" to pause | State2Analysis.tsx, ExplorePanel.tsx, studio.json | Small  |
| UX-A2  | Step 4: Crawl progress in-panel         | `useCrawlProgress` + `useMultiPageProgress` hooks, `CrawlJobProgress` component | New `State4Crawl.tsx` that embeds progress inside the flow panel. Show: per-URL status, extraction strategy used, quality score per page, per-section progress bars. Live cost/time: "423 of 1,047 pages — 12 min remaining"                                                              | State4Crawl.tsx (new)                             | Medium |
| UX-A3  | Wire `crawling`/`done` states           | States already defined in types.ts                                              | After `submitBatchCrawl`, set `flowState='crawling'` instead of `onComplete`                                                                                                                                                                                                              | CrawlFlowV5.tsx                                   | Small  |
| UX-A4  | Non-destructive back Step 2→1           | Draft persistence already saves state                                           | Preserve sections/profile when going back; "Re-discover" merges new into existing                                                                                                                                                                                                         | CrawlFlowV5.tsx                                   | Small  |
| UX-A5  | Manual URL paste in Step 2              | Section creation logic exists                                                   | Textarea + "Add as section" button                                                                                                                                                                                                                                                        | State2Analysis.tsx                                | Small  |
| UX-A6  | Custom scope number input               | Scope radio cards exist                                                         | `<input type="number">` when Custom selected                                                                                                                                                                                                                                              | State3Configure.tsx                               | Small  |
| UX-A7  | Minimize to background                  | Nothing                                                                         | Small floating banner showing crawl progress when panel minimized. Banner: "Discovery running... 89 links [View details] [Stop]". Completion: "340 new pages in 3 sections [Review] [Auto-add]"                                                                                           | CrawlMiniBanner.tsx (new)                         | Medium |
| UX-A8  | Re-crawl thin pages                     | `submitBatchCrawl` already works                                                | Post-completion button that filters thin-quality pages and re-submits with browser strategy                                                                                                                                                                                               | State4Crawl.tsx                                   | Medium |
| UX-A9  | Cost estimate + impact preview          | Model/page count available in Step 3                                            | Display estimated cost, time, and page count. Update live during crawl. Needs investigation: do we have per-page cost data? If not, show time + page count only.                                                                                                                          | State3Configure.tsx                               | Small  |
| UX-A10 | Close panel → save draft dialog         | Draft auto-save exists                                                          | Confirmation: "Save as draft?" when closing mid-flow. Verify if draft auto-save on state transitions already covers this.                                                                                                                                                                 | CrawlFlowV5.tsx                                   | Small  |
| UX-A11 | Extraction preview (NEW)                | `extraction-cascade.ts`                                                         | After discovery, show extracted content for 2-3 sample pages: "Here's what we'll extract — looks good?" Option to switch to browser rendering.                                                                                                                                            | State2Analysis.tsx                                | Medium |
| UX-A12 | Error transparency per URL (NEW)        | `CrawlJobProgress` has per-URL tracking                                         | In Step 4, show failure reason per URL: "15 pages need browser rendering", "8 returned 403". Actionable: "Re-crawl 15 JS pages with browser? [Yes]"                                                                                                                                       | State4Crawl.tsx                                   | Medium |
| UX-A13 | Site compatibility check (NEW)          | Profiling already exists                                                        | Before full crawl, probe 3-5 pages: "This site uses JS rendering — browser mode recommended" or "This site blocks automated requests — configure delays." Check robots.txt too.                                                                                                           | State3Configure.tsx or pre-crawl step             | Medium |
| UX-A14 | File discovery display (NEW)            | `link-extractor.ts` SKIP_EXTENSIONS                                             | During discovery, show: "Found 47 pages and 12 PDFs, 3 Word docs". Checkboxes per file type.                                                                                                                                                                                              | State2Analysis.tsx, link-extractor.ts             | Medium |
| UX-A15 | Crawl results summary (NEW)             | `CrawlJobProgress` completion data                                              | Step 4 completion: pages crawled, quality distribution, sections filled, failures, "View Results" link to CrawlerTab.                                                                                                                                                                     | State4Crawl.tsx                                   | Small  |

### Transparency at every step

| Step         | What User Sees Now            | What to Add                                                                                                                                                                       |
| ------------ | ----------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 1. Discover  | URL input + drafts            | Prominent sample input with clear messaging; activity log during discovery (reuse DiscoveryTimeline); file discovery counts                                                       |
| 2. Review    | Sections + discovery pipeline | Discovery audit trail (methods, counts, what worked); extraction preview for sample pages; file type breakdown per section; "Re-discover" non-destructive; manual URL paste       |
| 3. Configure | Scope + settings              | Cost/time estimate; site compatibility check ("JS rendering recommended"); robots.txt notice; file type selection                                                                 |
| 4. Crawl     | **Panel closes**              | Per-URL status with failure reasons, quality scores, section progress bars, extraction strategy per page, stop/minimize, completion summary with re-crawl option + "View Results" |

### Intervention points

| Point                   | Trigger                | User Can...                                                                         |
| ----------------------- | ---------------------- | ----------------------------------------------------------------------------------- |
| Discovery running       | Step 2                 | Stop, add sample, edit samples (pause/resume), run in background                    |
| Discovery tree growing  | Step 2                 | Explore branch, skip branch, explore all at level                                   |
| Discovery stalled       | Diminishing returns    | System auto-stops; user can force-continue                                          |
| Extraction preview poor | Step 2 after discovery | Switch to browser rendering                                                         |
| Sections reviewed       | Step 2                 | Include/exclude, rename, add URLs manually, re-discover, include/exclude file types |
| Site incompatible       | Step 3 pre-crawl check | Switch to browser mode, configure delays                                            |
| Scope too large         | Step 3 cost estimate   | Reduce scope, exclude sections                                                      |
| Crawl running           | Step 4                 | Stop, minimize to background                                                        |
| URLs failing            | Step 4 mid-crawl       | Re-crawl failed URLs with browser rendering                                         |
| Thin content            | Step 4 completion      | Re-crawl thin pages with browser rendering                                          |

### Non-destructive navigation

| From → To         | Behavior                    | Data Preserved?                                |
| ----------------- | --------------------------- | ---------------------------------------------- |
| Step 2 → Step 1   | "Re-discover" button        | YES — sections preserved, new discovery merges |
| Step 3 → Step 2   | "Back" button               | YES — already works                            |
| Step 4 → anywhere | Must stop or minimize first | N/A                                            |
| Close panel       | "Save as draft?" dialog     | Draft saved                                    |

### Backlog items addressed by these additions

| Backlog Item                           | How Addressed                                                                          |
| -------------------------------------- | -------------------------------------------------------------------------------------- |
| UX-5 Sample URL prominence + messaging | UX-A1: show by default, fix font sizes, rewrite copy, read-only chips during discovery |
| UX-8 Discovery audit trail             | Audit trail in Step 2 (DiscoveryTimeline + methods table)                              |
| UX-9 Mid-discovery intervention        | UX-9a through UX-9g: 7 intervention types across all phases via POST-alongside-SSE     |
| UX-2 Discovery Tree                    | Interactive tree with 5 node states, explore/skip/explore-all controls                 |
| UX-11 "Run in background"              | UX-9b + UX-A7: minimize to banner during discovery and crawl                           |
| UX-15 Smart section defaults           | Show top ~10 sections expanded, rest collapsed under "Show N more"                     |
| P0-4 Quality-driven retry              | Auto-retry in pipeline (P0-4) + user-driven re-crawl (UX-A8)                           |
| EQ-4 PDF/document crawling             | DOC-1 through DOC-5 + UX-A14: file discovery display                                   |
| H-3 Robots.txt                         | NEW-5 + UX-A13: robots.txt transparency during site compatibility check                |

---

## Recommended Priority Order

### Batch 1: Complete the flow end-to-end (P0-ish, ~3 days)

UX-A2 + UX-A3 + UX-A15 (Step 4 crawl progress in-panel + completion summary). This is the biggest gap — the user currently loses all visibility after clicking "Start Crawl". Reuses existing `useCrawlProgress` and `useMultiPageProgress` hooks.

### Batch 2: MCP Security (P0, ~2 days)

P0-1, P0-2, P0-3 (auth + rate limit + JS sandbox on crawler-mcp-server). Consider: localhost binding + shared secret for internal-only service. Remove `execute_javascript` tool entirely.

### Batch 3: Transparency + user control (P1, ~1 week)

UX-A1 (sample URL prominence), UX-9a-9g (mid-discovery intervention — the full 3-zone redesign with tree, activity, intent zones), UX-A11 (extraction preview), UX-A13 (site compatibility check). This is the core product differentiator for demos.

### Batch 4: File/document discovery (P1, ~3 days)

DOC-1, DOC-2, DOC-3, UX-A14. Show discovered files, let user choose, route through Docling.

### Batch 5: Flow polish (P1, ~2 days)

UX-A4 (non-destructive back), UX-A5 (manual URL paste), UX-A6 (custom scope input), UX-A12 (error transparency per URL).

### Batch 6: Post-crawl actions (P1, ~2 days)

UX-A7 (minimize), UX-A8 (re-crawl thin), UX-A10 (save draft on close).

### Batch 7: Extraction Quality (P1, ~3 days)

P0-4 (auto quality retry in pipeline), EQ-1 (platform-aware or user CSS selector), EQ-2 (structured content).

### Batch 8: Production Hardening (P1, ~1 week)

H-1 + H-2 (BullMQ + Redis for discover crawl), H-3 (robots.txt compliance + rate limiting).

### Batch 9: Algorithm (P2, ~2 weeks)

ALG-1, ALG-4, ALG-5, ALG-6.

### Deferred

ALG-2, ALG-3 (niche/premature), wireframe settings (need definition for WS-2, WS-4), auto mode, scheduled re-crawl, UX unification (separate initiative).

---

## New Items (added 2026-04-22)

| #      | Title                                                 | Priority | Description                                                                                                                                                                                                                                                                                                                   | Evidence                                                                                                               |
| ------ | ----------------------------------------------------- | -------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------- |
| PATH-1 | Single active crawl path — delete previous before new | P1       | Crawling cannot have multiple active paths for the same source. When a user starts a new crawl, the previous crawl path must be deleted first. Only one primary path should exist at a time. Currently there is no enforcement — a user can submit multiple crawl jobs that create overlapping sources/paths without cleanup. | User-reported: "the crawling can't have multiple path the previous path needs to be deleted, this is the primary path" |

## New Items (added 2026-04-24)

| #       | Title                               | Priority      | Description                                                                                                                                                                                                                                                                                                                                                                                            | Evidence                                                                                              | Design Ref              |
| ------- | ----------------------------------- | ------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | ----------------------------------------------------------------------------------------------------- | ----------------------- |
| STRAT-1 | "Crawl Full Sitemap" strategy path  | P1            | When user selects "Crawl Full Sitemap" from the upfront strategy selector (D7), skip discovery entirely and proceed directly to Step 3 Configure with all sitemap sections pre-selected. Disabled when no sitemap exists. Existing flow already supports this — just wire the strategy card to `handleContinue()` without opening browser discovery. Estimated time shown based on sitemap page count. | Live testing 2026-04-24: discovery adds no value for sites with complete sitemaps (e.g., epson.com)   | DISCOVERY-PANEL §22.3 A |
| STRAT-2 | "Discover Everything" strategy path | P2 (deferred) | When user selects "Discover Everything" from the upfront strategy selector (D7), start browser discovery in auto-add mode with `crawlAsYouDiscover.mode = 'crawl-all'`. **Blocked on**: defining auto-discovery principles, HTTP vs browser discovery roles, automatic stopping criteria. Shown as "Coming Soon" in strategy selector UI.                                                              | Live testing 2026-04-24: users with thin sitemaps want "just find everything" without manual steering | DISCOVERY-PANEL §22.3 B |

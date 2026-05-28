# LLD: Browser-Guided URL Generation — Adaptive Multi-Signal Discovery

**Feature Spec**: `docs/features/web-crawling.md`
**Design Doc**: `docs/searchai/design/BROWSER-GUIDED-URL-GENERATION.md`
**Test Spec**: (pending — recommend `/test-spec`)
**Status**: APPROVED (5 audit rounds complete)
**Date**: 2026-04-21

---

## 1. Design Decisions

### Decision Log

| #    | Decision                                                                                                            | Rationale                                                                                                                                            | Alternatives Rejected                                                           |
| ---- | ------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------- |
| D-1  | DOM region classifier lives in `crawler-mcp-server/src/explore/`                                                    | Requires live Playwright `Page`, no other consumers                                                                                                  | Shared package (over-engineering), search-ai (wrong process)                    |
| D-2  | `linkFilter` kept as deprecated optional, `sampleUrls` added alongside                                              | CLAUDE.md export removal guard — additive only for feat commits                                                                                      | Breaking change (removes linkFilter), dual-mode (complex)                       |
| D-3  | Pattern scoring stays in search-ai, not moved to crawler-mcp-server                                                 | Browser discovers all links, search-ai scores them. Clean separation                                                                                 | Moving pattern-matcher to shared pkg (premature abstraction)                    |
| D-4  | No feature flag — entire crawling is PLANNED status (pre-release)                                                   | Unnecessary ceremony for pre-release code                                                                                                            | Feature flag (adds conditional paths with no audience)                          |
| D-5  | DOM classifier uses `page.evaluate()` (single IPC call)                                                             | Consistent with existing `findExpandables` and `extractPageLinks` pattern                                                                            | Playwright locator API (N IPC calls), external library                          |
| D-6  | Phase 1 only in this plan — phases 2-4 are separate LLDs                                                            | Phase 1 is independently valuable and testable. Phases 2-4 have different risk profiles                                                              | Mono-plan (too large, violates max-40-files commit discipline)                  |
| D-7  | Extract pure functions from navigation-explorer before modifying                                                    | Test-before strategy: pure classifier is testable without Playwright                                                                                 | Test-after (loses safety net), mock Playwright (violates test rules)            |
| D-8  | `classifyDomRegions` returns priority-sorted regions with expandable counts                                         | Sufficient for content-first click ordering. No need for full spatial layout model                                                                   | Bounding-box intersection model (complex, fragile), ML classifier (no LLM rule) |
| D-9  | Sidebar width threshold: 25% (design doc says 20%)                                                                  | 25% better captures wider sidebars (Stripe docs sidebar is ~22% of viewport). Tunable constant, validated in Phase 5                                 | 20% (design doc value — may miss wider sidebars)                                |
| D-10 | `DomRegion` type extends design doc with `source`, `viewportArea`, `role: 'unknown'`                                | `source` enables debugging (landmark vs spatial), `viewportArea` aids future priority tuning, `'unknown'` is the fallback for unclassifiable regions | Strict design doc type (less debuggable, no fallback)                           |
| D-11 | `DiscoveredLink.patternScore` and `.tier` deferred — scoring happens server-side in Phase 4, not on the link object | Pattern scoring uses `pattern-matcher.ts` in search-ai, not in crawler-mcp-server. Links scored after return, not during extraction                  | Scoring in crawler-mcp-server (wrong process, requires moving pattern-matcher)  |

### Key Interfaces & Types

```typescript
// ─── New: DOM Region Classification ─────────────────────────────

/** A classified region of the page DOM */
export interface DomRegion {
  /** CSS selector for the region root element */
  selector: string;
  /** Semantic role of this region */
  role: 'content-main' | 'nav-header' | 'nav-sidebar' | 'footer' | 'aside' | 'unknown';
  /** How the role was determined */
  source: 'landmark' | 'spatial' | 'heuristic';
  /** Number of expandable elements within this region */
  expandableCount: number;
  /** Number of <a href> links within this region */
  linkCount: number;
  /** Bounding rect as % of viewport (for spatial classification) */
  viewportArea: number;
}

/** Priority order for region-first clicking */
export const REGION_CLICK_PRIORITY: Record<DomRegion['role'], number> = {
  'content-main': 0, // Click first
  'nav-sidebar': 1, // Click second (sidebar often has useful nav)
  aside: 2, // Click third
  unknown: 3, // Click fourth
  'nav-header': 4, // Click last (usually site-wide chrome)
  footer: 5, // Skip unless budget remains
};

// ─── Extended: NavigationExploreConfig ───────────────────────────

export interface NavigationExploreConfig {
  url: string;
  maxDepth: number;
  maxExpansions: number;
  expandableSelectors?: string[];
  /** @deprecated Use sampleUrls for multi-pattern scoring instead */
  linkFilter?: string;
  /** Sample URLs for pattern scoring — replaces linkFilter */
  sampleUrls?: string[];
  timeout: number;
}

// ─── Extended: ExploreResult ────────────────────────────────────

export interface ExploreResult {
  links: DiscoveredLink[];
  tree: ExpandableNode[];
  stats: {
    totalClicks: number;
    totalLinks: number;
    totalExpandables: number;
    durationMs: number;
    /** NEW: Click budget allocation by region */
    clicksByRegion?: Record<string, number>;
  };
  /** NEW: DOM regions detected on the page */
  regions?: DomRegion[];
}

// ─── Extended: DiscoveredLink ───────────────────────────────────

export interface DiscoveredLink {
  href: string;
  text: string;
  context?: string;
  /** NEW: Which DOM region this link was found in */
  region?: DomRegion['role'];
}
```

### Module Boundaries

| Module                                | Responsibility                                        | Depends On                                               |
| ------------------------------------- | ----------------------------------------------------- | -------------------------------------------------------- |
| `dom-region-classifier.ts` (NEW)      | Classify DOM into semantic regions via page.evaluate  | Playwright Page                                          |
| `navigation-explorer.ts` (MODIFY)     | Orchestrate region-first expansion, collect all links | dom-region-classifier, findExpandables, extractPageLinks |
| `crawl-browser-discover.ts` (MODIFY)  | Accept `sampleUrls` param, forward to MCP server      | Express, fetch                                           |
| `BrowserDiscoveryInline.tsx` (MODIFY) | Pass `sampleUrls` instead of `linkFilter`             | crawl API client                                         |
| `crawl.ts` API client (MODIFY)        | Add `sampleUrls` to `startBrowserExplore` request     | apiFetch                                                 |
| `server.ts` (MODIFY)                  | Forward `sampleUrls` through to `exploreNavigation`   | NavigationExploreConfig                                  |

---

## 2. File-Level Change Map

### New Files

| File                                                                          | Purpose                                           | LOC Estimate |
| ----------------------------------------------------------------------------- | ------------------------------------------------- | ------------ |
| `apps/crawler-mcp-server/src/explore/dom-region-classifier.ts`                | Pure classification logic + page.evaluate bridge  | ~180         |
| `apps/crawler-mcp-server/src/explore/__tests__/dom-region-classifier.test.ts` | Unit tests for pure classification function       | ~200         |
| `apps/crawler-mcp-server/src/explore/__tests__/navigation-explorer.test.ts`   | Unit tests for region-prioritized expansion logic | ~150         |

### Modified Files

| File                                                                         | Change Description                                                                                                                                                                                                                                  | Risk                                           |
| ---------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------- |
| `apps/crawler-mcp-server/src/explore/navigation-explorer.ts`                 | (1) Import and call `classifyDomRegions` before expansion. (2) Sort expandables by region priority. (3) Remove `linkFilter` regex from `extractPageLinks` — return all links. (4) Add `sampleUrls` to config. (5) Track clicks-per-region in stats. | **High** — core algorithm, zero existing tests |
| `apps/crawler-mcp-server/src/server.ts`                                      | Forward `sampleUrls` from request body to `NavigationExploreConfig`                                                                                                                                                                                 | Low                                            |
| `apps/search-ai/src/routes/crawl-browser-discover.ts`                        | (1) Accept `sampleUrls` in POST body. (2) Forward to crawler-mcp-server. (3) Keep `linkFilter` as deprecated fallback.                                                                                                                              | Low                                            |
| `apps/studio/src/components/search-ai/crawl-flow/BrowserDiscoveryInline.tsx` | (1) Pass `sampleUrls` instead of deriving `linkFilter` via `deriveLinkFilter()`. (2) Remove `deriveLinkFilter` call.                                                                                                                                | Med — large component                          |
| `apps/studio/src/components/search-ai/crawl-flow/ExplorePanel.tsx`           | Replace `linkFilter` derivation (~line 522) with `sampleUrls` in `startBrowserExplore` call (~line 534). Second call site for browser explore.                                                                                                      | Low                                            |
| `apps/studio/src/api/crawl.ts`                                               | Add `sampleUrls?: string[]` to `startBrowserExplore` request type                                                                                                                                                                                   | Low                                            |

### Deleted Files

None — all changes are additive.

---

## 3. Implementation Phases

### Phase 1: DOM Region Classifier (pure function + tests)

**Goal**: Create a testable DOM region classification module with unit tests, before touching the explorer.

**Tasks**:

1.1. Create `apps/crawler-mcp-server/src/explore/dom-region-classifier.ts`:

- Export `classifyRegions(rawElements: RawDomElement[]): DomRegion[]` — **pure function**, no Playwright dependency
- Export `classifyDomRegions(page: Page): Promise<DomRegion[]>` — thin bridge that calls `page.evaluate` to extract raw DOM data, then calls the pure function
- **Pattern note**: Unlike `api-interceptor.ts` which uses an attach/detach lifecycle pattern (for ongoing interception), this is a one-shot classify call — no handle needed. The structural pattern is: pure function + thin page.evaluate bridge.
- **CRITICAL**: The `page.evaluate` call MUST use string-based IIFE format (not function references) — same pattern as `findExpandables` in navigation-explorer.ts (line 371). tsx wraps function declarations with `__name()` which doesn't exist in the browser context. Example: `page.evaluate('(function() { ... })()')`.
- The page.evaluate script extracts: landmark elements (`<nav>`, `<main>`, `<aside>`, `<header>`, `<footer>`, `[role="navigation"]`, `[role="main"]`, `[role="complementary"]`), their bounding rects, expandable counts, and link counts
- Named constants for spatial fallback thresholds: `HEADER_HEIGHT_PX = 80`, `SIDEBAR_WIDTH_PCT = 25`, `FOOTER_HEIGHT_PX = 80`
- Spatial fallbacks: top `HEADER_HEIGHT_PX` → header, left `SIDEBAR_WIDTH_PCT`% full-height → sidebar, bottom `FOOTER_HEIGHT_PX` → footer, center → content
- Cap DOM element scan at `MAX_DOM_ELEMENTS_SCAN = 5000` to prevent performance degradation on large DOMs
- Use the local `createLogger` from `server.ts` (stderr-based, consistent with MCP stdio transport). NOT `@abl/compiler/platform` which uses pino/stdout and would interfere with MCP's stdio transport.
- Return regions sorted by `REGION_CLICK_PRIORITY`

  1.2. Create `apps/crawler-mcp-server/src/explore/__tests__/dom-region-classifier.test.ts`:

- **Test location note**: Placing under `src/explore/__tests__/` (co-located with source), not `src/__tests__/`. The existing `src/__tests__/http-transport.test.ts` is an integration-level HTTP test; these are pure-function unit tests co-located with the explore module for discoverability. This establishes a new convention for explore module tests.
- Test the pure `classifyRegions()` function with mock DOM data (no Playwright needed)
- Cases: semantic HTML with landmarks, no landmarks (spatial fallback), mixed, single-region page
- Test priority sorting
- Test expandable/link counting per region

  1.3. Run `pnpm build --filter=crawler-mcp-server` to verify types compile.

**Files Touched**:

- `apps/crawler-mcp-server/src/explore/dom-region-classifier.ts` — NEW
- `apps/crawler-mcp-server/src/explore/__tests__/dom-region-classifier.test.ts` — NEW

**Exit Criteria**:

- [ ] `classifyRegions` correctly classifies 4+ test cases (landmark, spatial, mixed, single-region)
- [ ] Priority sort places `content-main` before `nav-header`
- [ ] `pnpm build --filter=crawler-mcp-server` succeeds with 0 errors
- [ ] `pnpm vitest run apps/crawler-mcp-server/src/explore/__tests__/dom-region-classifier.test.ts` — all tests pass

**Test Strategy**:

- Unit: Pure function `classifyRegions` tested with synthetic DOM element arrays (zero Playwright dependency)
- No integration test needed — the bridge function is a thin `page.evaluate` wrapper tested in Phase 2

**Rollback**: Delete the two new files. No existing code touched.

---

### Phase 2: Region-First Expansion in Navigation Explorer

**Goal**: Modify `exploreExpandables` to click content-region expandables first, skip low-priority regions when budget is tight.

**Tasks**:

2.1. Modify `navigation-explorer.ts`:

- Import `classifyDomRegions` from `dom-region-classifier.ts`
- In `exploreNavigation()`, after `dismissOverlays()` and before `extractPageLinks()`, call `classifyDomRegions(page)` to get sorted regions
- Store regions on the result object (`result.regions = regions`)
- Add `clicksByRegion` stats tracking (per-region click counter)

  2.2. Refactor `exploreExpandables()` to accept a `regions: DomRegion[]` parameter:

- Extract a pure helper `sortExpandablesByRegion(expandables: ExpandableCandidate[], regions: DomRegion[]): ExpandableCandidate[]` that:
  - For each expandable, determine its containing region by checking if its selector is a descendant of a region selector (using string prefix match or `element.closest()` in a page.evaluate)
  - Sort by `REGION_CLICK_PRIORITY[region.role]` ascending (content-main=0 first, footer=5 last)
  - Within the same region, preserve DOM order
- For each region (in priority order): find expandables **within that region** by prefixing the region's selector
- The `findExpandables` function already returns candidates with selectors — filter candidates whose selector starts with (or is contained within) the region's selector
- Fallback: if regions is empty or classification failed, use current behavior (all expandables, DOM order)
- Track which region each click belongs to in `clicksByRegion`

  2.3. Modify `extractPageLinks` to tag each link with its region:

- Add `region?: DomRegion['role']` field to `DiscoveredLink`
- During extraction, check if the link's ancestor matches a region selector
- Keep this lightweight — single `page.evaluate` that checks `element.closest()` for each region selector

  2.4. Create `apps/crawler-mcp-server/src/explore/__tests__/navigation-explorer.test.ts`:

- Test the region-prioritized expansion ordering logic (extract as pure helper if needed)
- Test that content-main expandables are clicked before nav-header expandables
- Test fallback when no regions detected

  2.5. Run `pnpm build --filter=crawler-mcp-server` and `pnpm vitest run apps/crawler-mcp-server`.

**Files Touched**:

- `apps/crawler-mcp-server/src/explore/navigation-explorer.ts` — MODIFY
- `apps/crawler-mcp-server/src/explore/__tests__/navigation-explorer.test.ts` — NEW

**Exit Criteria**:

- [ ] `exploreNavigation` calls `classifyDomRegions` and stores regions on result
- [ ] Expandables are clicked in region-priority order (content-main first)
- [ ] `clicksByRegion` stats correctly tallied
- [ ] Fallback to DOM-order when no regions detected
- [ ] `DiscoveredLink.region` populated for all links
- [ ] `pnpm build --filter=crawler-mcp-server` succeeds
- [ ] All tests pass

**Test Strategy**:

- Unit: Region-prioritized ordering helper (pure function)
- Note: Full Playwright integration testing deferred to Phase 5 (manual validation against Epson + Stripe)

**Rollback**: Revert navigation-explorer.ts changes. Classifier module from Phase 1 remains (no harm — unused but valid).

---

### Phase 3: Remove linkFilter, Add sampleUrls to API Chain

**Depends on**: Phase 2 (both modify `navigation-explorer.ts` — Phase 2 adds region-first expansion, Phase 3 removes linkFilter. Sequential to avoid merge conflicts.)

**Goal**: Replace the hard regex `linkFilter` with `sampleUrls` passthrough across the full API chain (Studio → search-ai → crawler-mcp-server). Add Zod validation to all POST endpoints.

**Tasks**:

3.1. Modify `apps/crawler-mcp-server/src/explore/navigation-explorer.ts`:

- In `extractPageLinks()`: remove the `regex` filter block (lines 477-482). Return ALL links, deduplicated by href only.
- Add `sampleUrls?: string[]` to `NavigationExploreConfig` (keep `linkFilter` as deprecated optional for backward compat)
- No scoring in crawler-mcp-server — all links returned, scoring done in search-ai

  3.2. Modify `apps/crawler-mcp-server/src/server.ts`:

- In the `/api/explore` POST handler (~line 358), add Zod validation for the request body:
  ```typescript
  const ExploreRequestSchema = z.object({
    url: z.string().url(),
    maxDepth: z.number().int().min(1).max(10).optional(),
    maxExpansions: z.number().int().min(1).max(1000).optional(),
    expandableSelectors: z.array(z.string()).max(20).optional(),
    linkFilter: z.string().max(500).optional(),
    sampleUrls: z.array(z.string().url()).max(50).optional(),
    timeout: z.number().int().min(1000).max(60000).optional(),
  });
  ```
- Validate with `.safeParse(req.body)`, return 400 with structured error on failure
- **Pattern note**: `server.ts` already imports `zod` for MCP tool registration. Replace the existing manual URL validation block (~lines 361-378) with the Zod schema to avoid having both manual and Zod validation in the same handler.
- Forward `sampleUrls` to `NavigationExploreConfig`

  3.3. Modify `apps/search-ai/src/routes/crawl-browser-discover.ts` at three precise locations:

- **Location 1 (~line 130)**: Add Zod validation for the POST body:
  ```typescript
  const BrowserExploreRequestSchema = z.object({
    url: z.string().url(),
    maxDepth: z.number().int().min(1).max(10).optional(),
    maxExpansions: z.number().int().min(1).max(1000).optional(),
    linkFilter: z.string().max(500).optional(),
    sampleUrls: z.array(z.string().url()).max(50).optional(),
  });
  ```
  Validate with `.safeParse(req.body)`, return 400 with `{ success: false, error: { code: 'VALIDATION_ERROR', message } }` on failure.
- **Location 2 (~line 169)**: Update `connectToExplorer(state, ...)` call to include `sampleUrls`:
  `connectToExplorer(state, { url, maxDepth, maxExpansions, linkFilter, sampleUrls })`
- **Location 3 (~line 320)**: Add `sampleUrls?: string[]` to the inline config type: `config: { url: string; maxDepth?: number; maxExpansions?: number; linkFilter?: string; sampleUrls?: string[] }`. The existing `JSON.stringify(config)` on line 326 will automatically include sampleUrls in the POST body — no additional forwarding logic needed.
- Keep accepting `linkFilter` for backward compat but prefer `sampleUrls`
- **Pattern note**: This introduces Zod validation into `crawl-browser-discover.ts`, which currently uses manual type assertions (`req.body as {...}`). This is intentional — migrating to the platform-standard Zod pattern. Do NOT retroactively convert the existing manual checks in `crawl-discover.ts` in this PR (separate refactor).

  3.4. Modify `apps/studio/src/api/crawl.ts`:

- Add `sampleUrls?: string[]` to the `startBrowserExplore` request type

  3.5. Modify `apps/studio/src/components/search-ai/crawl-flow/BrowserDiscoveryInline.tsx`:

- Replace `deriveLinkFilter(sampleUrls)` call with passing `sampleUrls` directly
- Change `startBrowserExplore({ url, maxDepth, maxExpansions, linkFilter })` → `startBrowserExplore({ url, maxDepth, maxExpansions, sampleUrls })`
- Keep `deriveLinkFilter` function in file (may be used elsewhere — verify with grep first)

  3.5b. Modify `apps/studio/src/components/search-ai/crawl-flow/ExplorePanel.tsx` (~line 521-534):

- This is the **second call site** for `startBrowserExplore` — ExplorePanel derives `linkFilter` from `pattern.pathPrefix` (~line 522) and passes it to `startBrowserExplore` (~line 534)
- Replace with passing `sampleUrls` directly (same pattern as BrowserDiscoveryInline)
- Without this, ExplorePanel's browser explore flow would still use the old regex filtering path

  3.6. Update types in proxy layer to include new fields:

- `apps/search-ai/src/routes/crawl-browser-discover.ts` (~line 71): Add `region?: string` to the `links` array element type: `links: Array<{ href: string; text: string; context?: string; region?: string }>`
- `apps/search-ai/src/routes/crawl-browser-discover.ts` (~line 73-78): Add `clicksByRegion?: Record<string, number>` to `BrowserExploreResult.stats` and `regions?: Array<{ selector: string; role: string; expandableCount: number; linkCount: number }>` to the top-level result
- These are optional fields, backward-compatible — existing code ignores them

  3.7. Run `pnpm build --filter=crawler-mcp-server --filter=search-ai --filter=studio`.

**Files Touched**:

- `apps/crawler-mcp-server/src/explore/navigation-explorer.ts` — MODIFY (remove regex filter)
- `apps/crawler-mcp-server/src/server.ts` — MODIFY (Zod validation + forward sampleUrls)
- `apps/search-ai/src/routes/crawl-browser-discover.ts` — MODIFY (Zod validation + accept sampleUrls + type updates)
- `apps/studio/src/api/crawl.ts` — MODIFY (add sampleUrls to type)
- `apps/studio/src/components/search-ai/crawl-flow/BrowserDiscoveryInline.tsx` — MODIFY (pass sampleUrls)
- `apps/studio/src/components/search-ai/crawl-flow/ExplorePanel.tsx` — MODIFY (replace linkFilter with sampleUrls at second call site)

**Exit Criteria**:

- [ ] `extractPageLinks` returns ALL links (no regex filtering)
- [ ] `sampleUrls` flows from Studio → search-ai → crawler-mcp-server (both BrowserDiscoveryInline AND ExplorePanel call sites)
- [ ] `linkFilter` still accepted (deprecated) but `sampleUrls` takes precedence
- [ ] Zod validation on both POST endpoints (crawl-browser-discover.ts, server.ts)
- [ ] `pnpm build` succeeds for all 3 apps
- [ ] No broken imports or type errors

**Test Strategy**:

- Build verification (type check is the primary gate for API chain changes)
- Manual E2E in Phase 5

**Rollback**: Revert all 5 files. linkFilter behavior returns.

---

### Phase 4: Pattern Scoring + Section Creation from Unfiltered Links

**Depends on**: Phase 3 (both modify BrowserDiscoveryInline.tsx and crawl.ts API client — sequential to avoid conflicts.)

**Goal**: When browser discovery returns ALL links (no linkFilter), score them using `pattern-matcher.ts` and create sections with hot/warm/cold tiers. This is the key P1 fix — links aren't discarded, they're scored and categorized.

**Design doc alignment**: This phase implements the "Replace linkFilter with multi-pattern scoring" requirement from Section 9 and the `linkFilter Replacement` pseudocode from Section 10 of the design doc. The `pattern-matcher.ts` module already provides `learnPattern()` and `scoreUrl()` with hot/warm/cold classification — this phase wires them into the browser discovery result path.

**Tasks**:

4.1. Extend `POST /api/search-ai/crawl/cluster-urls` to include pattern scoring:

- Add `sampleUrls: z.array(z.string().url()).max(50).optional()` to the `clusterUrlsSchema` (at `apps/search-ai/src/routes/crawl.ts:~1361`)
- When `sampleUrls` is present: call `learnPattern(sampleUrls)` from `pattern-matcher.ts`, then `scoreUrl(url, pattern)` for each URL in the input
- Include `score` (0-100) and `tier` ('hot'|'warm'|'cold') in the grouped results per URL group
- When `sampleUrls` is absent: existing clustering behavior unchanged (backward-compatible)

  4.2. Modify `apps/studio/src/components/search-ai/crawl-flow/BrowserDiscoveryInline.tsx`:

- After receiving browser discovery `complete` event with all links:
- Pass `sampleUrls` alongside link URLs to the scoring/clustering call
- For section creation, include ALL links — hot links marked `included: true`, warm marked `included: true`, cold marked `included: false` (collapsed by default in UI)
- The existing `onSectionsDiscovered` callback already handles section merging in State2Analysis
- Remove any remaining references to `deriveLinkFilter` if unused
- **Volume note**: With linkFilter removed, ALL links (potentially 200-500+) are sent to clustering/scoring. Verify the endpoint handles this volume without degradation.

  4.3. Verify that `State2Analysis.tsx` correctly receives and displays sections from browser discovery that include previously-filtered links (e.g., FAQ links from Epson). Hot/warm sections should be expanded, cold sections collapsed.

  4.4. Run `pnpm build --filter=search-ai --filter=studio`.

**Files Touched**:

- `apps/search-ai/src/routes/crawl.ts` or new route — MODIFY (add pattern scoring to cluster-urls or new endpoint)
- `apps/studio/src/components/search-ai/crawl-flow/BrowserDiscoveryInline.tsx` — MODIFY
- `apps/studio/src/api/crawl.ts` — MODIFY (if new endpoint or param added to clusterUrls)

**Exit Criteria**:

- [ ] `sampleUrls` consumed by `learnPattern()` + `scoreUrl()` from `pattern-matcher.ts`
- [ ] Each browser-discovered link has a score (0-100) and tier (hot/warm/cold)
- [ ] Sections created from browser discovery include previously-filtered URL patterns (FAQ links, etc.)
- [ ] Hot/warm sections included by default, cold sections collapsed
- [ ] `pnpm build` succeeds for search-ai and studio
- [ ] UI renders without console errors (visual regression verified in Phase 5)

**Test Strategy**:

- Build verification
- Manual E2E in Phase 5 (verify scoring produces expected tiers for Epson FAQ links)

**Rollback**: Revert BrowserDiscoveryInline.tsx and route changes. Links return to unscored clustering.

---

### Phase 5: Manual Validation — Epson + Stripe

**Goal**: Validate the full pipeline on the two canonical failure sites. Document results.

**Tasks**:

5.1. Start all services (Studio, SearchAI, crawler-mcp-server, Docker infra).

5.2. Test against Epson support page (`epson.com/Support/sl/s`):

- Enter sample URL: `https://epson.com/Support/Printers/Inkjet/EcoTank/Epson-ET-2400/s/SPT_C11CJ67201`
- Verify: DOM regions detected (content vs nav-header)
- Verify: Content-region expandables clicked BEFORE nav mega-menu
- Verify: More than 0 useful links returned (vs. previous 0)
- Verify: FAQ links (`/faq/...`) are included in results (not filtered)
- Document: total clicks used, links found, regions detected

  5.3. Test against Stripe docs (`stripe.com/docs`):

- Enter sample URL: `https://docs.stripe.com/payments/payment-intents`
- Verify: Sidebar expandables prioritized over page-chrome expandables
- Verify: Links returned include sidebar navigation targets
- Document: total clicks used, links found, regions detected

  5.4. Verify `sampleUrls` flows through the full chain:

- Check crawler-mcp-server logs to confirm `sampleUrls` arrives in `/api/explore` request body
- Check search-ai logs to confirm `sampleUrls` is forwarded in `connectToExplorer`

  5.5. Document results in `docs/searchai/design/BROWSER-GUIDED-VALIDATION.md`.

**Files Touched**:

- `docs/searchai/design/BROWSER-GUIDED-VALIDATION.md` — NEW (validation results)

**Exit Criteria**:

- [ ] Epson: content-region clicks > nav-header clicks (budget not wasted on mega-menu)
- [ ] Epson: at least 1 FAQ link in results (previously 0 due to linkFilter)
- [ ] Stripe: sidebar expandables clicked (visible in click-by-region stats)
- [ ] Both: no regressions — browser discovery SSE streaming works end-to-end
- [ ] Stripe: link count >= previous baseline (regression check — must not lose links that were found before)
- [ ] `sampleUrls` confirmed in crawler-mcp-server request logs (API chain verification)
- [ ] Validation document written with quantified results

**Test Strategy**:

- Manual E2E against live sites
- Results documented for reproducibility

**Rollback**: N/A — this phase is validation only, no code changes.

---

## 4. Wiring Checklist

- [x] `dom-region-classifier.ts` — imported by `navigation-explorer.ts` (Phase 2, task 2.1)
- [x] `classifyDomRegions` — called in `exploreNavigation()` before expansion loop (Phase 2, task 2.1)
- [x] `DomRegion` type — exported from `dom-region-classifier.ts`, used by `NavigationExploreConfig` and `ExploreResult`
- [x] `sampleUrls` field — added to `NavigationExploreConfig` (Phase 3, task 3.1)
- [x] `sampleUrls` forwarded — server.ts extracts from body → config (Phase 3, task 3.2)
- [x] `sampleUrls` forwarded — crawl-browser-discover.ts accepts → forwards to MCP server (Phase 3, task 3.3)
- [x] `sampleUrls` forwarded — crawl.ts API client includes in request (Phase 3, task 3.4)
- [x] `sampleUrls` passed — BrowserDiscoveryInline passes instead of linkFilter (Phase 3, task 3.5)
- [x] `sampleUrls` passed — ExplorePanel passes instead of linkFilter at second call site (Phase 3, task 3.5b)
- [x] `regions` on ExploreResult — populated by exploreNavigation (Phase 2, task 2.1)
- [x] `clicksByRegion` on ExploreResult.stats — tracked per-region (Phase 2, task 2.1)
- [x] Test files — created in `__tests__/` directory alongside source (Phases 1-2)
- [ ] No new models, middleware, workers, or routes needed
- [ ] No new env vars or config keys needed
- [ ] No database migrations needed

---

## 5. Cross-Phase Concerns

### Database Migrations

None — all changes are in-memory algorithm improvements. No database models affected.

### Feature Flags

None — crawling feature is PLANNED status (pre-release). No production traffic.

### Configuration Changes

None — no new env vars. `CRAWLER_MCP_URL` already exists for the crawler-mcp-server connection.

### SSE Protocol

No changes to SSE event types in Phase 1. The `ExploreResult` gains optional fields (`regions`, `clicksByRegion`) which are backward-compatible (existing consumers ignore unknown fields).

### Package Dependencies

No new npm packages. `dom-region-classifier.ts` uses only Playwright's `Page` type (already a dependency of crawler-mcp-server).

---

## 6. Acceptance Criteria (Whole Feature — Phase 1 Scope)

- [ ] All phases (1-5) complete with exit criteria met
- [ ] DOM region classifier correctly identifies content vs. nav vs. footer regions on test HTML
- [ ] Navigation explorer clicks content-region expandables before nav-header expandables
- [ ] `linkFilter` regex removed from link extraction — all links returned
- [ ] `sampleUrls` accepted at all API boundaries (Studio → search-ai → crawler-mcp-server)
- [ ] Browser discovery on Epson returns non-zero useful links (previous: 0)
- [ ] Browser discovery on Stripe prioritizes sidebar expandables
- [ ] No regressions in existing crawl flow (sitemap, HTTP discover, fan-out)
- [ ] `pnpm build` succeeds for all affected packages (crawler-mcp-server, search-ai, studio)
- [ ] Unit tests pass for `dom-region-classifier` and region-prioritized expansion
- [ ] Feature spec updated with implementation details (`/post-impl-sync`)

---

## 7. Open Questions

1. **Spatial fallback thresholds**: The 80px header / 25% sidebar heuristics are educated guesses. Phase 5 validation will determine if these need tuning. If Epson/Stripe misclassify, adjust thresholds before committing.

2. **Region containment for expandable filtering**: The approach of filtering expandables by ancestor-matching to region selectors may not work if expandables are in deeply nested containers that don't have a single root matching the region selector. Fallback: if no expandables match any region, use all expandables (current behavior).

3. **Performance of `classifyDomRegions`**: The single `page.evaluate` call should be fast (<50ms) but on DOMs with 10,000+ elements, the ancestor-checking loop could be slow. Cap the element scan at 5,000 elements.

---

## 8. Future Phases (Not in Scope)

These are separate LLDs to be created after Phase 1 is validated:

| Phase   | Feature                                                                                    | Prerequisite           |
| ------- | ------------------------------------------------------------------------------------------ | ---------------------- |
| Phase 2 | API Exhaustion — response body capture, catalog classification, browser-proxied pagination | Phase 1 validated      |
| Phase 3 | Vocabulary Extraction — cascading dropdown walker, vocabulary tree builder                 | Phase 1 + 2 validated  |
| Phase 4 | Probe + Strategy Selection — 7-signal site profiler, decision function, orchestrator       | Phases 1-3 implemented |

See `docs/searchai/design/BROWSER-GUIDED-URL-GENERATION.md` sections 6-7 for full design.

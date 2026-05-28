# LLD: Crawler UX Phase 3 — Explainability, Extraction Preview, Iterative Discovery

**Feature Spec**: `docs/features/web-crawling.md`
**HLD**: `docs/specs/web-crawling.hld.md`
**Test Spec**: `docs/testing/web-crawling.md`
**Design Doc**: `docs/searchai/design/DISCOVERY-PANEL-DESIGN.md`
**Previous LLDs**: `docs/plans/2026-04-23-crawler-discovery-panel-impl-plan.md` (Phase 1 — DONE), `docs/plans/2026-04-26-crawler-ux-phase2-impl-plan.md` (Phase 2 — DRAFT)
**Status**: APPROVED
**Date**: 2026-04-27

---

## 0. Context — What This LLD Covers

Phase 1 LLD built the core Discovery Panel. Phase 2 LLD adds strategy selection, full interventions, scope rules, resume flow, and conflict resolution polish. This Phase 3 LLD addresses the **remaining HIGH objective gaps** identified in the cross-objective review:

| Feature                           | Design Doc Section                            | Objectives Served                                 |
| --------------------------------- | --------------------------------------------- | ------------------------------------------------- |
| Explainability for auto-decisions | §6.8 (auto-add), §6.7 (console feedback), §23 | UJ-13 (understand why)                            |
| Extraction preview                | §17 backlog UX-A11, G10                       | UJ-14 (verify before committing)                  |
| Iterative discovery loop          | §11, §6.9.2, §16.2                            | G8 (multiple runs), UJ-15 (selected vs available) |

### What Already Exists

| Component                        | Status | Notes                                                                                       |
| -------------------------------- | ------ | ------------------------------------------------------------------------------------------- |
| ConsoleEntry with `data` field   | Built  | Has url, linkCount, yieldRate, sectionName, urlCount — no `reason`                          |
| Auto-add logic in DiscoveryPanel | Built  | Fires `auto-add` console entry but no "because X" reason                                    |
| DecisionCard with `reason` field | Built  | Cards have i18n reason — but auto-decisions don't explain themselves                        |
| ReadabilityService               | Built  | `cleanHTML(rawHTML, url, siteType)` → `ReadabilityResult` with metadata                     |
| SSRF protection                  | Built  | `isURLAllowed()` + `validateAndFetchURL()` in `apps/search-ai/src/utils/ssrf-protection.ts` |
| DiscoveryIteration type          | Built  | `id, seedUrl, sampleUrls, newUrlsDiscovered, pagesVisited, durationMs, timestamp`           |
| "Discover More" suggestion UI    | Built  | Banner at DiscoveryPanel.tsx:518, fires `explore-all-nav` action                            |
| shouldSuggestMoreDiscovery()     | Built  | Returns boolean based on navCoverageRatio and objectives                                    |
| CrawlDraftDiscoveryState         | Built  | Includes `iterations: DiscoveryIteration[]`                                                 |
| DiscoveredUrlSet (Map-based)     | Built  | O(1) dedup, confidence upgrades, serialize/deserialize                                      |
| CoverageSummary with iterations  | Built  | `IterationRow` component rendering past iterations                                          |

### What's Missing (this LLD)

| Gap                             | Current State                                  | Needed                                                                  |
| ------------------------------- | ---------------------------------------------- | ----------------------------------------------------------------------- |
| Auto-decision reasons           | Console says "Auto-added ET-Series"            | i18n reason: `reason_auto_add` with `{count, pattern, verified}` params |
| Scope exclusion reasons         | Silent exclusion                               | "Skipped /support/ — parent of sample, discovery hub only"              |
| Strategy recommendation reason  | Badge on card, no explanation                  | Tooltip: "Recommended: sitemap has 847 pages"                           |
| Extraction preview              | No way to preview content before crawl         | Backend endpoint + inline preview in Step 3                             |
| Cross-iteration context         | New SSE starts fresh, no memory of prior runs  | POST body with visitedUrls + exploredBranches                           |
| Iteration trigger tracking      | DiscoveryIteration has no `trigger` field      | Add trigger for history display                                         |
| "Discover More" with new sample | Only explore-all-nav, no targeted re-discovery | Support explicit URL input + add-to-scope expansion                     |
| Selected vs available counter   | Coverage shows categories, not counts          | "47 of ~300 selected" counter (UJ-15)                                   |

---

## 1. Design Decisions

### Decision Log

| #   | Decision                                                                     | Rationale                                                                                                                                                                                                                                                                                                                                                                                                | Alternatives Rejected                                                                                     |
| --- | ---------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------- |
| D-1 | Add `reason` to ConsoleEntry.data, not new entry type                        | Explainability enriches existing entry types (auto-add, decision, yield, action). Adding a new type fragments the console.                                                                                                                                                                                                                                                                               | New ConsoleEntryType 'explain' (creates parallel entries instead of enriching)                            |
| D-2 | Preview via Node.js fetch + ReadabilityService, not Playwright               | Preview must be fast (<2s). ReadabilityService works on raw HTML. JS-rendered pages show "requires browser rendering" fallback.                                                                                                                                                                                                                                                                          | Playwright preview (slow, resource-heavy for a quick look), Go worker (adds cross-service complexity)     |
| D-3 | Preview as inline expandable in Step 3, not modal                            | Matches existing crawl-flow expand/collapse patterns. User can preview multiple sections side-by-side. Max 3 concurrent.                                                                                                                                                                                                                                                                                 | Modal (blocks interaction), Slide-over (blocks section list)                                              |
| D-4 | Iterative "Discover More" starts new SSE with POST body context              | Frontend holds accumulated state. Passing visitedUrls via POST body keeps it stateless on the backend.                                                                                                                                                                                                                                                                                                   | Redis-backed context (adds infrastructure), Query params (URL length limits)                              |
| D-5 | "Discover More" does NOT auto-expand scope                                   | explore-all-nav explores unexplored nav branches — these aren't user samples. Only explicit add-sample (user enters URL) auto-expands scope via deriveScope.                                                                                                                                                                                                                                             | Auto-expand on every discovery run (violates scope-flows-down principle)                                  |
| D-6 | Backend sends structured reason DATA; frontend formats via reason-utils      | depth-prober emits structured data in progress events (matchCount, pattern, verifiedCount, trend, rate). Frontend `reason-utils.ts` formats these into human-readable + i18n strings. Backend never sends English prose — only structured fields.                                                                                                                                                        | Frontend-only reasons (can't explain auto-add criteria), Backend English strings (not i18n-compatible)    |
| D-7 | Preview endpoint rate-limited at 10/min/tenant via middleware                | Preview fetches external URLs — tighter limit than general API. No in-memory concurrent limit (violates stateless-distributed). Rate-limit middleware is sufficient.                                                                                                                                                                                                                                     | In-memory concurrent counter (pod-local, violates G25), no limit (dangerous)                              |
| D-8 | `DiscoveryIteration.trigger` uses granular enum, not design doc §16.2 values | Design doc §16.2 defines `'auto' \| 'explore-branch' \| 'objective' \| 'manual'`. LLD uses `'initial' \| 'explore-branch' \| 'explore-all' \| 'add-sample' \| 'explore-all-nav'` — more granular, maps to actual UI actions. Mapping: `auto` → `initial`, `objective` → dropped (no separate concept), `manual` → split into `add-sample`/`explore-all`/`explore-all-nav` for iteration history display. | Design doc enum verbatim (too coarse for history display — can't distinguish explore-all from add-sample) |

### Key Interfaces & Types

```typescript
// ── Explainability: Extend ConsoleEntry.data ──────────
interface ConsoleEntryData {
  // ... existing fields ...
  /** i18n key for structured reason (flat key, e.g., 'reason_auto_add') */
  reasonKey?: string;
  /** Interpolation params for reasonKey */
  reasonParams?: Record<string, string | number>;
  // NOTE: No `reason?: string` — all reasons go through i18n via reasonKey/reasonParams
}

// ── Extraction Preview ──────────────────────────────────
/** Request to preview extraction for a URL */
interface PreviewRequest {
  url: string;
  /** CrawlDraft's base URL — preview must match this origin */
  baseUrl: string;
}

/** Response from extraction preview endpoint */
interface PreviewResponse {
  success: boolean;
  data?: {
    url: string;
    title: string;
    /** First ~2000 chars of cleaned text */
    excerpt: string;
    /** Full cleaned HTML (truncated to 50KB) */
    cleanedHtml: string;
    wordCount: number;
    imageCount: number;
    /** Readability metadata */
    metadata: {
      contentLength: number;
      sizeReduction: number;
      cleaned: boolean;
    };
    /** Whether JS rendering would produce different content */
    jsRenderingAdvised: boolean;
  };
  error?: { code: string; message: string };
}

// ── Iterative Discovery: Extend DiscoveryIteration ──────
interface DiscoveryIteration {
  // ... existing fields ...
  /** What triggered this iteration */
  trigger: 'initial' | 'explore-branch' | 'explore-all' | 'add-sample' | 'explore-all-nav';
}

// ── Iterative Discovery: Context for new SSE run ────────
interface DiscoveryResumeContext {
  /** URLs already visited in prior runs — depth-prober skips these */
  visitedUrls: string[];
  /** Branches already explored — for iteration history */
  exploredBranches: string[];
  /** Iteration count so far */
  iterationCount: number;
}

// ── UJ-15: Selected vs Available Counter ────────────────
interface SelectionSummary {
  selectedCount: number;
  availableCount: number;
  // No displayText — render via i18n: t('iterate_counter', { selected: 47, available: 300 })
}
```

### Module Boundaries

| Module                       | Responsibility                                                           | Depends On                                |
| ---------------------------- | ------------------------------------------------------------------------ | ----------------------------------------- |
| `reason-utils.ts`            | NEW — Generate reason strings from progress events and auto-add criteria | ConsoleEntry, auto-add criteria from §6.8 |
| `crawl-preview.ts` (route)   | NEW — Preview endpoint: fetch + Readability + response                   | ReadabilityService, SSRF protection       |
| `PreviewPanel.tsx`           | NEW — Inline expandable preview in Step 3                                | Preview API client                        |
| `DiscoveryPanel.tsx`         | EXTEND — Iteration context, "Discover More" with samples                 | DiscoveryIteration, scope-utils           |
| `BrowserDiscoveryInline.tsx` | EXTEND — Pass resume context to new SSE runs                             | DiscoveryResumeContext                    |
| `CoverageSummary.tsx`        | EXTEND — Selected vs available counter, iteration history                | SelectionSummary                          |
| `DiscoveryConsole.tsx`       | EXTEND — Render reason strings from enriched entries                     | ConsoleEntry.data.reason                  |
| `depth-prober.ts`            | EXTEND — Emit reason strings in progress events                          | Auto-add criteria, yield data             |

---

## 2. File-Level Change Map

### New Files

| File                                                                                       | Purpose                                                                                | LOC Estimate |
| ------------------------------------------------------------------------------------------ | -------------------------------------------------------------------------------------- | ------------ |
| `apps/studio/src/components/search-ai/crawl-flow/discovery/reason-utils.ts`                | Generate reason strings from auto-add criteria, scope rules, yield data                | ~100         |
| `apps/studio/src/components/search-ai/crawl-flow/discovery/__tests__/reason-utils.test.ts` | Unit tests for reason generation                                                       | ~80          |
| `apps/search-ai/src/routes/crawl-preview.ts`                                               | Preview endpoint: POST /api/crawl/preview — fetch URL, run Readability, return preview | ~150         |
| `apps/search-ai/src/routes/__tests__/crawl-preview.test.ts`                                | Unit tests for preview route (SSRF, rate limiting, ReadabilityService)                 | ~120         |
| `apps/studio/src/components/search-ai/crawl-flow/PreviewPanel.tsx`                         | Inline expandable extraction preview for Step 3 configure                              | ~200         |

### Modified Files

| File                                                                                                                 | Change Description                                                                                                                                                                                                                                                              | Risk   |
| -------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------ |
| `apps/studio/src/components/search-ai/crawl-flow/types.ts`                                                           | Extend `ConsoleEntry.data` with `reasonKey/reasonParams`. Add `trigger` to `DiscoveryIteration`. Add `SelectionSummary`, `PreviewResponse`, `DiscoveryResumeContext` types.                                                                                                     | Low    |
| `apps/studio/src/components/search-ai/crawl-flow/DiscoveryConsole.tsx`                                               | Render `t(entry.data.reasonKey, entry.data.reasonParams)` below the main message when present. Subtle `text-muted` styling.                                                                                                                                                     | Low    |
| `apps/studio/src/components/search-ai/crawl-flow/discovery/console-utils.ts`                                         | Extend `progressToConsoleEntries` to detect state changes, call `reason-utils` to populate `reasonKey/reasonParams`.                                                                                                                                                            | Low    |
| `apps/crawler-mcp-server/src/explore/depth-prober.ts`                                                                | **Phase 1**: Add structured reason data fields to progress object (`autoAddReason`, `yieldReason`, `lastSkipReason`). **Phase 4**: Accept `previouslyVisitedUrls`, pre-populate `visitedUrls` Set, add `resumedFrom` field. Phase 1 changes are independent of Phase 4 changes. | Medium |
| `apps/studio/src/components/search-ai/crawl-flow/DiscoveryPanel.tsx`                                                 | Pass `DiscoveryResumeContext` when starting new iteration. Track `trigger` on DiscoveryIteration creation. Selected vs available counter.                                                                                                                                       | Medium |
| `apps/studio/src/components/search-ai/crawl-flow/BrowserDiscoveryInline.tsx`                                         | Accept `resumeContext` prop via extended `BrowserDiscoveryInlineProps`. Pass visitedUrls + exploredBranches in startBrowserExplore POST body.                                                                                                                                   | Medium |
| `apps/studio/src/api/crawl.ts`                                                                                       | Add `previewExtraction()` API client function (two-step `apiFetch` + `handleResponse`). Extend `startBrowserExplore()` params with `resumeContext`.                                                                                                                             | Low    |
| `apps/search-ai/src/routes/crawl-browser-discover.ts`                                                                | Accept `resumeContext` in start-explore POST body. Extend `connectToExplorer` config type. Forward to MCP.                                                                                                                                                                      | Low    |
| `apps/search-ai/src/routes/crawl-drafts.ts`                                                                          | Add `discoveryState` field to `updateDraftSchema` Zod (iterations with trigger). **3-layer sync**.                                                                                                                                                                              | Medium |
| `apps/crawler-mcp-server/src/server.ts` (line ~521, inline `/api/explore-deep` handler + `ExploreDeepRequestSchema`) | Extract `resumeContext` from request body (add to `ExploreDeepRequestSchema` Zod), pass `previouslyVisitedUrls` to depth-prober.                                                                                                                                                | Low    |
| `apps/studio/src/components/search-ai/crawl-flow/CoverageSummary.tsx`                                                | Add selected vs available counter. Enhance iteration history with trigger display.                                                                                                                                                                                              | Low    |
| `apps/studio/src/components/search-ai/crawl-flow/State3Configure.tsx`                                                | Import and render `PreviewPanel` for each section. Pass preview API function.                                                                                                                                                                                                   | Low    |
| `apps/search-ai/src/server.ts`                                                                                       | Register crawl-preview route.                                                                                                                                                                                                                                                   | Low    |
| `packages/i18n/locales/en/studio.json`                                                                               | ~25 new flat i18n keys (`reason_*`, `preview_*`, `iterate_*`).                                                                                                                                                                                                                  | Low    |
| `apps/studio/src/components/search-ai/crawl-flow/discovery/index.ts`                                                 | Export reason-utils.                                                                                                                                                                                                                                                            | Low    |

### Deleted Files

None.

---

## 3. Implementation Phases

### Phase 1: Explainability — Reason Strings (UJ-13) — ~1.5 days

**Goal**: Every auto-decision shows a human-readable "why" in the console.

**Tasks**:

1.1. Extend `ConsoleEntry.data` in `types.ts`:

- Add `reasonKey?: string` — i18n key for structured reason (flat key, e.g., `reason_auto_add`)
- Add `reasonParams?: Record<string, string | number>` — interpolation params
- **Note:** No `ConsoleEntry.data.reason?: string` — all reasons go through `reasonKey`/`reasonParams` via i18n.
- **Deviation (YieldStatus migration):** Existing `YieldStatus.reason: string` should be migrated to `YieldStatus.reasonKey` + `YieldStatus.reasonParams` in a **separate refactor commit** (not bundled with Phase 1 feature work). This is a minor interface cleanup that reduces blast radius when split out. Document as a prerequisite refactor before Phase 1 starts.

  1.2. Create `discovery/reason-utils.ts` (~100 LOC):

Returns `{ key: string, params: Record<string, string | number> }` — same shape as `generateContextualPrompt()` in `decision-utils.ts`. **Never returns English prose** — i18n JSON has the templates.

```typescript
interface ReasonResult {
  key: string; // i18n key under search_ai.crawl_flow (flat, no nesting)
  params: Record<string, string | number>;
}

/** Reason for auto-add section */
function autoAddReason(matchCount: number, pattern: string, verifiedCount: number): ReasonResult;
// → { key: 'reason_auto_add', params: { count: 12, pattern: '/printers/et-series/*', verified: 2 } }
// i18n: "reason_auto_add": "{count} URLs match {pattern} pattern ({verified} verified)"

/** Reason for scope exclusion */
function scopeExclusionReason(relationship: 'parent' | 'sibling' | 'excluded'): ReasonResult;
// → { key: 'reason_scope_parent', params: {} }
// i18n: "reason_scope_parent": "Parent of sample URL — used for discovery navigation only"

/** Reason for strategy recommendation */
function strategyRecommendationReason(
  hasSitemap: boolean,
  sitemapCount: number,
  jsRequired: boolean,
): ReasonResult;
// → { key: 'reason_strategy_sitemap', params: { count: 847 } }
// i18n: "reason_strategy_sitemap": "Recommended: sitemap has {count} pages covering most content"

/** Reason for yield signal */
function yieldReason(
  trend: 'productive' | 'declining' | 'stalled',
  rate: number,
  peakRate: number,
): ReasonResult;
// → { key: 'reason_yield_declining', params: { rate: 1, peak: 8 } }
// i18n: "reason_yield_declining": "Discovery rate dropped from {peak} to {rate} per page visited"

/** Reason for duplicate skip */
function duplicateSkipReason(normalizedUrl: string, originalUrl: string): ReasonResult;
// → { key: 'reason_duplicate_skip', params: { url: '/page' } }
// i18n: "reason_duplicate_skip": "Duplicate of {url} (tracking params removed)"
```

1.3. Create `discovery/__tests__/reason-utils.test.ts` (~80 LOC):

- Test all 5 reason generators return correct `{ key, params }` shape
- Test edge cases: zero counts, empty patterns, missing data → verify key/params still valid
- Verify returned keys match the flat naming convention (`reason_auto_add`, not `reasons.auto_add`)

  1.4. Extend `depth-prober.ts` progress object with **structured reason data** (NOT typed events — depth-prober uses continuous progress snapshots via `emitProgress()`, not discrete event types):

- Add new optional fields to the progress object emitted by `emitProgress()`:
  ```typescript
  // Added to the existing progress state object:
  autoAddReason?: { matchCount: number; pattern: string; verifiedCount: number };
  yieldReason?: { trend: 'productive' | 'declining' | 'stalled'; currentRate: number; peakRate: number };
  lastSkipReason?: { skipType: 'duplicate' | 'visited' | 'out-of-scope'; normalizedUrl: string };
  ```
- Frontend `progressToConsoleEntries` detects state changes by comparing current vs previous progress snapshot (existing pattern), then calls `reason-utils` to format `{ key, params }`
- **Note:** Auto-add logic currently lives in `DiscoveryPanel.tsx` frontend, NOT in depth-prober. Task 1.4 adds the structured data TO depth-prober progress (match counts, patterns) so the frontend can generate reasons. The auto-add DECISION remains in the frontend.

  1.5. Extend `console-utils.ts` `progressToConsoleEntries`:

- When detecting auto-add from progress snapshot (new section appeared): call `autoAddReason()` → attach `{ reasonKey, reasonParams }` to `ConsoleEntry.data`
- When detecting yield change: call `yieldReason()` → attach `{ reasonKey, reasonParams }`. **Note:** Migrate existing `YieldStatus.reason` string to use the same `{ key, params }` pattern for consistency (document in task that `YieldStatus.reason` becomes `YieldStatus.reasonKey` + `YieldStatus.reasonParams`).
- For scope-related entries: call `scopeExclusionReason()` → attach `{ reasonKey, reasonParams }`
- **Pattern**: depth-prober sends structured data fields in its progress object (matchCount, pattern, trend, etc.). `progressToConsoleEntries` detects state changes by comparing current vs previous progress snapshot, then calls reason-utils to generate `{ key, params }`.

  1.6. Extend `DiscoveryConsole.tsx` rendering:

- In `ConsoleEntryRow`: if `entry.data?.reasonKey` exists, render `t(entry.data.reasonKey, entry.data.reasonParams)` below the main message
- Styling: `text-xs text-muted mt-0.5 ml-6` (indented, subtle, secondary)
- No fallback to `entry.data.reason` string — all reasons go through i18n

  1.7. Add i18n keys (~10 keys) as flat keys under `search_ai.crawl_flow` (matching existing convention — e.g., `reason_auto_add`, `reason_scope_parent`, `reason_yield_declining`, NOT nested `reasons.auto_add`)

**Files Touched**:

- `apps/studio/src/components/search-ai/crawl-flow/types.ts` — extend ConsoleEntry.data
- `apps/studio/src/components/search-ai/crawl-flow/discovery/reason-utils.ts` — NEW
- `apps/studio/src/components/search-ai/crawl-flow/discovery/__tests__/reason-utils.test.ts` — NEW
- `apps/studio/src/components/search-ai/crawl-flow/discovery/index.ts` — export reason-utils
- `apps/crawler-mcp-server/src/explore/depth-prober.ts` — add reason to progress events
- `apps/studio/src/components/search-ai/crawl-flow/discovery/console-utils.ts` — extract/compute reasons
- `apps/studio/src/components/search-ai/crawl-flow/DiscoveryConsole.tsx` — render reasons
- `packages/i18n/locales/en/studio.json` — reason keys

**Exit Criteria**:

- [ ] Auto-add console entries show reason: "12 URLs match /printers/et-series/\* pattern (2 verified)"
- [ ] Scope exclusion shows reason: "Parent of sample — discovery hub only"
- [ ] Yield signals show reason: "Rate dropped from 8 to 1 per page"
- [ ] All reason-utils tests pass: `pnpm test --filter=studio -- reason-utils`
- [ ] Reasons render as subtle secondary text below console entries
- [ ] `pnpm build --filter=studio` succeeds with 0 errors
- [ ] `pnpm build --filter=crawler-mcp-server` succeeds with 0 errors

**Test Strategy**:

- Unit: reason-utils.test.ts — all 5 generators, edge cases (target: 15+ tests)
- Unit: console-utils.test.ts — verify reason extraction from progress events (extend existing suite)
- Manual: Run discovery on a real site, verify reasons appear in console

**Rollback**: Revert types.ts data extension, delete reason-utils, revert console-utils and DiscoveryConsole changes.

---

### Phase 2: Extraction Preview Backend — ~1.5 days

**Goal**: New API endpoint that fetches a URL, runs Readability extraction, and returns a preview without ingesting.

**Tasks**:

2.1. Create `apps/search-ai/src/routes/crawl-preview.ts` (~150 LOC):

```typescript
// POST /api/crawl/preview
// Body: { url: string, baseUrl: string }
// Response: PreviewResponse

const previewSchema = z.object({
  url: z.string().url(),
  baseUrl: z.string().url(),
});

// Handler:
// 1. const log = createLogger('crawl-preview')
// 2. Validate request body (Zod)
// 3. Origin check: new URL(url).origin === new URL(baseUrl).origin → 400 if mismatch
// 4. Ownership check: verify req.user has a CrawlDraft with matching baseUrl origin
//    (prevents using preview as open SSRF proxy — user can only preview
//     URLs on domains they've already started drafting)
// 5. Fetch URL using validateAndFetchURL(url) from ssrf-protection.ts
//    Returns HTML string directly (not Response). Handles:
//    - SSRF validation (protocol, IP, DNS resolution)
//    - Timeout (10s default — acceptable for preview)
//    - Size limit (5MB default — acceptable for preview)
//    NOTE: Do NOT also call isURLAllowed() — validateAndFetchURL already does SSRF checks internally
// 6. Run ReadabilityService.cleanHTML(html, url)
//    Note: siteType param intentionally omitted — preview is a quick look,
//    not a full extraction. siteType refinement happens during actual crawl.
// 7. Handle ReadabilityResult.success === false → return error response
// 8. Compute wordCount: split cleaned text on whitespace, count
//    Compute imageCount: count <img> tags in cleaned HTML
//    (ReadabilityMetadata has neither — must compute from output)
// 9. Detect JS rendering: if cleaned text length < 100 chars and raw HTML > 10KB, set jsRenderingAdvised
// 10. Truncate cleanedHtml to 50KB
// 11. Log: log.info('Preview extracted', { url, wordCount, durationMs })
// 12. Return PreviewResponse
```

2.2. Add rate limiting:

- 10 requests/min per tenant via `searchAiRateLimit()` middleware (keys on `tenantId`). If per-user granularity is needed later, use `express-rate-limit` with custom `keyGenerator: (req) => req.user.userId`. For now, per-tenant is sufficient since preview is low-frequency.
- No per-tenant concurrent limit (in-memory counters are pod-local and violate stateless-distributed principle; rate-limit middleware is sufficient)
- Return 429 with `{ success: false, error: { code: 'RATE_LIMITED', message: 'Preview rate limit exceeded' } }`

  2.3. Register route in `apps/search-ai/src/server.ts`:

- Import crawlPreviewRouter
- Mount at `/api/crawl/preview`
- Apply auth middleware (`requireAuth`)

  2.4. Create `apps/search-ai/src/routes/__tests__/crawl-preview.test.ts` (~120 LOC):

- Test SSRF rejection (private IPs return 400)
- Test origin mismatch rejection (preview URL must match baseUrl origin)
- Test successful extraction (mock HTTP response, verify ReadabilityResult shape)
- Test timeout handling (slow server returns 504)
- Test JS rendering detection (minimal cleaned content → jsRenderingAdvised: true)
- Test oversized response (>2MB returns 413)

  2.5. Add `previewExtraction()` to `apps/studio/src/api/crawl.ts`:

```typescript
export async function previewExtraction(
  url: string,
  baseUrl: string,
): Promise<PreviewResponse['data']> {
  // Two-step pattern: apiFetch returns raw Response, handleResponse parses + unwraps .data
  // Matches every other POST function in crawl.ts (e.g., profileSite, startBrowserExplore)
  const response = await apiFetch(crawlUrl('/preview'), {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ url, baseUrl }),
  });
  const result = await handleResponse<PreviewResponse>(response);
  return result.data; // Unwrap envelope — callers get the data directly
}
```

2.6. Add i18n keys (~5 keys) as flat keys under `search_ai.crawl_flow` (e.g., `preview_error`, `preview_rate_limited`)

**Files Touched**:

- `apps/search-ai/src/routes/crawl-preview.ts` — NEW
- `apps/search-ai/src/routes/__tests__/crawl-preview.test.ts` — NEW
- `apps/search-ai/src/server.ts` — register route
- `apps/studio/src/api/crawl.ts` — add previewExtraction client
- `packages/i18n/locales/en/studio.json` — preview keys

**Exit Criteria**:

- [ ] `POST /api/crawl/preview` returns cleaned content for a valid URL
- [ ] SSRF: private IPs (127.0.0.1, 10.x, 169.254.x) throw ValidationError from `validateAndFetchURL` → return 400
- [ ] Origin mismatch: preview URL with different domain than baseUrl returns 400
- [ ] Ownership: user without a CrawlDraft matching baseUrl origin gets 404 (CrawlDraft exists from profiling/analysis step — always before Step 3 preview)
- [ ] Timeout: slow URLs return 504 within ~10s (`validateAndFetchURL` FETCH_TIMEOUT)
- [ ] Rate limit: 11th request within 1 minute returns 429
- [ ] JS rendering: minimal cleaned content sets `jsRenderingAdvised: true`
- [ ] Logger emits preview completion: `log.info('Preview extracted', { url, wordCount, durationMs })`
- [ ] All preview tests pass
- [ ] `pnpm build --filter=search-ai` succeeds with 0 errors
- [ ] Route registered and reachable at `/api/crawl/preview`

**Test Strategy**:

- Unit: crawl-preview.test.ts — SSRF (via validateAndFetchURL), origin, ownership check, timeout, extraction, oversized, logger output (target: 10+ tests)
- Manual: curl the endpoint with a real URL, verify response shape

**Rollback**: Delete crawl-preview.ts and test, revert server.ts route registration.

---

### Phase 3: Extraction Preview Frontend — ~1.5 days

**Goal**: User can preview extraction results for any section in Step 3 configure.

**Tasks**:

3.1. Create `PreviewPanel.tsx` (~200 LOC):

- Props: `url: string`, `baseUrl: string`, `onClose: () => void`
- On mount: call `previewExtraction(url, baseUrl)`
- Loading state: skeleton shimmer
- Success state:
  - Title (bold, `text-foreground`)
  - Excerpt (first ~500 chars, `text-muted`)
  - Stats bar: "1,247 words · 3 images · 62% noise removed"
  - "This is what will be indexed" subtle label
- Error state: error message with retry button
- JS rendering advisory: "This page uses JavaScript. Browser rendering may produce different content."
- Close button (X) in top-right
- Max width: matches section list width. Expandable within the section row.

  3.2. Wire into `State3Configure.tsx`:

- Each section row gets a "Preview" icon button (Eye icon, 16px)
- Clicking opens `PreviewPanel` below the section row (inline expandable)
- Track open previews in state: `openPreviews: Set<string>` (section IDs)
- Max 3 simultaneous previews — if user opens 4th, close the oldest
- Preview uses a sample URL from the section (first verified URL, or first URL if none verified)

  3.3. Add preview stats to section row:

- After first preview loads for a section, cache the stats (wordCount, imageCount)
- Show as subtle badge on the section row: "~1.2K words"
- Cache client-side per URL — no re-fetch on re-expand

  3.4. Add i18n keys (~10 keys) as flat keys under `search_ai.crawl_flow` (e.g., `preview_title`, `preview_stats_words`, `preview_js_advisory`)

**Files Touched**:

- `apps/studio/src/components/search-ai/crawl-flow/PreviewPanel.tsx` — NEW
- `apps/studio/src/components/search-ai/crawl-flow/State3Configure.tsx` — wire preview button + panel
- `packages/i18n/locales/en/studio.json` — preview UI keys

**Exit Criteria**:

- [ ] Each section row shows a "Preview" button
- [ ] Clicking Preview shows inline extraction preview below the row
- [ ] Preview shows title, excerpt, stats (word count, image count, noise reduction)
- [ ] JS rendering advisory appears when `jsRenderingAdvised: true`
- [ ] Max 3 open preview panels in UI enforced (client-side UX limit — closes oldest when 4th opened)
- [ ] Loading skeleton shows during fetch
- [ ] Error state shows with retry button
- [ ] Preview stats cached client-side (no re-fetch on re-expand)
- [ ] `pnpm build --filter=studio` succeeds with 0 errors

**Test Strategy**:

- Unit: PreviewPanel renders loading/success/error states correctly
- Manual: Open Step 3 with sections, click Preview, verify extraction content displays
- Manual: Open 4 previews, verify oldest closes

**Rollback**: Delete PreviewPanel.tsx, revert State3Configure.tsx changes.

---

### Phase 4: Iterative Discovery — Backend Context — ~1.5 days

**Goal**: depth-prober accepts context from prior runs and skips already-visited URLs.

**Tasks**:

4.1. Add `DiscoveryResumeContext` type to shared types (or inline in the API):

```typescript
interface DiscoveryResumeContext {
  visitedUrls: string[]; // URLs visited in prior iterations
  exploredBranches: string[]; // Nav branches already explored
  iterationCount: number; // How many iterations have run
}
```

4.2. **Add `discoveryState` to `updateDraftSchema`** in `apps/search-ai/src/routes/crawl-drafts.ts`:

- **CRITICAL**: `updateDraftSchema` (line 77-85) currently has NO `discoveryState` field. Discovery state cannot persist through the update-draft API — frontend state is lost on page refresh.
- Add `discoveryState` to the Zod schema:
  ```typescript
  discoveryState: z.object({
    iterations: z.array(z.object({
      id: z.string().min(1),
      seedUrl: z.string().min(1).optional(),
      sampleUrls: z.array(z.string().min(1)).optional(),
      newUrlsDiscovered: z.number().int().min(0).optional(),
      pagesVisited: z.number().int().min(0).optional(),
      durationMs: z.number().int().min(0).optional(),
      timestamp: z.string().optional(),
      trigger: z.enum(['initial', 'explore-branch', 'explore-all', 'add-sample', 'explore-all-nav']).optional(),
    })).max(100).optional(),
  }).passthrough().optional(),  // passthrough for future fields
  ```
- This also satisfies the 3-layer sync for `DiscoveryIteration.trigger`:
  - **Layer 1**: Frontend type in `types.ts`
  - **Layer 2**: API client inline type in `crawl.ts` (lines ~1016-1024)
  - **Layer 3**: This Zod schema
- Update the Mongoose model if it has a strict schema for the draft (verify at implementation time)

  4.3. Extend `startBrowserExplore` POST body in `apps/search-ai/src/routes/crawl-browser-discover.ts`:

- Add optional `resumeContext` field to the start-explore Zod schema:
  ```typescript
  resumeContext: z.object({
    visitedUrls: z.array(z.string().min(1)).max(15000).optional(),
    exploredBranches: z.array(z.string().min(1).max(2048)).max(500).optional(),
    iterationCount: z.number().int().min(0).max(100).optional(),
  }).optional();
  ```
- Forward `resumeContext` to `connectToExplorer` config

  4.4. **Extend `connectToExplorer` config type** in `crawl-browser-discover.ts` (line ~393):

- The config parameter type must include `resumeContext`:
  ```typescript
  config: {
    url: string;
    maxDepth?: number;
    maxExpansions?: number;
    linkFilter?: string;
    sampleUrls?: string[];
    depthProbing?: { enabled?: boolean; maxPageVisits?: number; maxDepth?: number; sampleSize?: number };
    resumeContext?: { visitedUrls?: string[]; exploredBranches?: string[]; iterationCount?: number };
  }
  ```
- `connectToExplorer` forwards config verbatim via `JSON.stringify(config)` to `/api/explore-deep`

  4.5. **Extend crawler-mcp-server `/api/explore-deep` handler**:

- Extract `resumeContext` from request body
- Pass `resumeContext.visitedUrls` as `previouslyVisitedUrls` to depth-prober
- This completes the full forwarding chain: frontend → search-ai → crawler-mcp-server → depth-prober

  4.6. Extend depth-prober to accept `previouslyVisitedUrls`:

- If `previouslyVisitedUrls` provided, pre-populate `visitedUrls` Set
- These URLs are skipped during exploration — depth-prober won't revisit them
- Log: `log.info('Resumed with previously visited URLs', { count: N, iterationCount: M })`
- Add to progress object: `resumedFrom?: { previousUrlCount: number; iterationCount: number }` (snapshot field, not typed event)

  4.7. Extend `DiscoveryIteration` in `types.ts` — 3-layer sync covered by task 4.2

  4.8. Extend `startBrowserExplore()` in `apps/studio/src/api/crawl.ts`:

- Add optional `resumeContext?: DiscoveryResumeContext` param
- Include in POST body when provided

**Files Touched**:

- `apps/studio/src/components/search-ai/crawl-flow/types.ts` — add DiscoveryResumeContext, extend DiscoveryIteration with trigger
- `apps/search-ai/src/routes/crawl-drafts.ts` — add discoveryState to updateDraftSchema (with iterations[].trigger)
- `apps/search-ai/src/routes/crawl-browser-discover.ts` — extend start Zod schema + connectToExplorer config type
- `apps/crawler-mcp-server/src/explore/depth-prober.ts` — accept previouslyVisitedUrls, pre-populate visitedUrls
- `apps/crawler-mcp-server/src/routes/explore-deep.ts` (or equivalent) — extract resumeContext, pass to depth-prober
- `apps/studio/src/api/crawl.ts` — extend startBrowserExplore params

**Exit Criteria**:

- [ ] `startBrowserExplore` with `resumeContext.visitedUrls = [url1, url2]` causes depth-prober to skip url1 and url2
- [ ] depth-prober logs "Resumed with N previously visited URLs"
- [ ] Progress object includes `resumedFrom` field with correct counts
- [ ] Zod schema rejects `visitedUrls` arrays >15,000 entries
- [ ] `discoveryState` persists through update-draft API (iterations + trigger survive round-trip)
- [ ] `connectToExplorer` config type includes `resumeContext`
- [ ] Full forwarding chain verified: frontend → search-ai → crawler-mcp-server → depth-prober
- [ ] `pnpm build --filter=search-ai` succeeds with 0 errors
- [ ] `pnpm build --filter=crawler-mcp-server` succeeds with 0 errors
- [ ] `pnpm build --filter=studio` succeeds with 0 errors

**Test Strategy**:

- Unit: depth-prober with previouslyVisitedUrls — verify skipped URLs
- Integration: Start explore with resumeContext, verify no re-visits
- Manual: Run discovery twice, second run skips first run's URLs

**Rollback**: Revert Zod schema extension, depth-prober param, API client changes.

---

### Phase 5: Iterative Discovery — Frontend Flow — ~2 days

**Goal**: User can run multiple discovery iterations, each building on previous results.

**Tasks**:

5.1. Extend "Discover More" UI in `DiscoveryPanel.tsx`:

- Current: simple banner at line 518 with one button
- New: richer suggestion panel with:
  - Coverage summary: "Explored 4 of 12 nav branches. 65% coverage."
  - Two actions:
    - **"Explore Remaining"** — explore-all-nav on unexplored branches (existing behavior)
    - **"Add URL & Discover"** — text input for new URL + "Go" button. Adds as sample, expands scope via `deriveScope`, starts new SSE with resume context.
  - Iteration history: collapsible list of past iterations with trigger, seed, new URL count, duration

    5.2. Extend `BrowserDiscoveryInline.tsx` to pass resume context:

- When `onAction` receives `explore-all-nav` or `add-sample-and-discover`:
  - Collect `visitedUrls` from DiscoveredUrlSet (all URLs seen so far)
  - Collect `exploredBranches` from tree (branches with status 'visited' or 'complete')
  - Build `DiscoveryResumeContext`
  - Call `startBrowserExplore()` with `resumeContext`
  - Increment iteration count
- For `add-sample-and-discover`:
  - First: add URL to sampleUrls array → re-derive scope → scope expands
  - Then: start new SSE with resume context + new sample
  - Track `trigger: 'add-sample'` on the new DiscoveryIteration

    5.3. Extend `DiscoveryPanel.tsx` iteration tracking:

- When creating DiscoveryIteration: set `trigger` based on the action that started it
  - Initial SSE run: `trigger: 'initial'`
  - "Explore Remaining": `trigger: 'explore-all-nav'`
  - "Add URL & Discover": `trigger: 'add-sample'`
  - Within-SSE explore-branch: `trigger: 'explore-branch'`
- Save iterations to `CrawlDraftDiscoveryState` on each discovery completion

  5.4. Extend `CoverageSummary.tsx`:

- **Selected vs available counter** (UJ-15):
  - Count selected: sections with `included: true` × their URL count
  - Count available: total URLs in DiscoveredUrlSet
  - Display: "47 of ~300 pages selected" with progress bar
- **Iteration history enhancement**:
  - Show trigger icon per iteration (compass for initial, arrow for explore-branch, plus for add-sample, grid for explore-all-nav)
  - Show aggregate: "3 iterations · 791 unique URLs · 16 pages visited"

    5.5. Merge results across iterations:

- When new SSE run completes, merge into existing state:
  - `DiscoveredUrlSet.add()` for each new URL (dedup built in)
  - `upsertNode()` for tree nodes (merge built in)
  - Coverage recomputed from accumulated state
- Console entry: "Iteration 2 complete: 200 new URLs from /support/scanners (3 pages visited)"

  5.6. Add i18n keys (~10 keys) as flat keys under `search_ai.crawl_flow` (e.g., `iterate_explore_remaining`, `iterate_add_url`, `iterate_counter`)

**Files Touched**:

- `apps/studio/src/components/search-ai/crawl-flow/DiscoveryPanel.tsx` — richer "Discover More" UI, iteration tracking with trigger, merge logic
- `apps/studio/src/components/search-ai/crawl-flow/BrowserDiscoveryInline.tsx` — build and pass resumeContext
- `apps/studio/src/components/search-ai/crawl-flow/CoverageSummary.tsx` — selected vs available counter, iteration history enhancement
- `packages/i18n/locales/en/studio.json` — iterate keys

**Exit Criteria**:

- [ ] After discovery completes, "Discover More" panel shows coverage summary and two action options
- [ ] "Explore Remaining" starts new SSE that skips previously visited URLs
- [ ] "Add URL & Discover" accepts URL input, expands scope, starts new SSE with resume context
- [ ] Second iteration merges results into existing tree (no duplicates)
- [ ] DiscoveryIteration records include correct `trigger` value
- [ ] Selected vs available counter shows "47 of ~300 pages selected"
- [ ] Iteration history displays with trigger icons and aggregate stats
- [ ] Console entry summarizes each completed iteration
- [ ] State persists to CrawlDraftDiscoveryState across iterations
- [ ] `pnpm build --filter=studio` succeeds with 0 errors

**Test Strategy**:

- Unit: DiscoveryResumeContext building from DiscoveredUrlSet and tree state
- Unit: SelectionSummary computation (selected vs available)
- Unit: Iteration trigger assignment for each action type
- Manual: Run discovery, click "Explore Remaining", verify second run skips first run's URLs
- Manual: Add new URL via "Add URL & Discover", verify scope expands and new area explored
- Manual: Verify iteration history shows all iterations with correct triggers

**Rollback**: Revert DiscoveryPanel, BrowserDiscoveryInline, CoverageSummary changes.

---

## 4. Wiring Checklist

- [ ] `reason-utils.ts` exported from `discovery/index.ts` barrel
- [ ] `ConsoleEntry.data.reasonKey`/`reasonParams` rendered by `DiscoveryConsole.tsx` via `t(reasonKey, reasonParams)`
- [ ] `reasonKey`/`reasonParams` populated by `console-utils.ts` from progress snapshot comparison + `reason-utils.ts`
- [ ] depth-prober progress object includes `autoAddReason`/`yieldReason`/`lastSkipReason` structured fields
- [ ] `DiscoveryIteration.trigger` synced across all 3 layers: `types.ts`, `crawl.ts` inline type, `crawl-drafts.ts` Zod schema
- [ ] `crawl-preview` route registered in `server.ts` with auth middleware
- [ ] `previewExtraction()` exported from `api/crawl.ts`
- [ ] `PreviewPanel` imported and rendered by `State3Configure.tsx`
- [ ] `DiscoveryResumeContext` passed from `BrowserDiscoveryInline` → `startBrowserExplore` → `crawl-browser-discover` → MCP → depth-prober
- [ ] `DiscoveryIteration.trigger` set correctly for all iteration start actions
- [ ] Selected vs available counter rendered in `CoverageSummary.tsx`
- [ ] Iteration history with trigger icons rendered in `CoverageSummary.tsx`
- [ ] All new i18n keys used with `useTranslations('search_ai.crawl_flow')`
- [ ] `DiscoveryResumeContext`, `SelectionSummary`, `PreviewResponse` types exported from `types.ts`
- [ ] `discoveryState` field added to `updateDraftSchema` in `crawl-drafts.ts` — iterations persist through API
- [ ] `connectToExplorer` config type extended with `resumeContext` in `crawl-browser-discover.ts`
- [ ] `/api/explore-deep` handler extracts `resumeContext` and passes `previouslyVisitedUrls` to depth-prober
- [ ] `BrowserDiscoveryInlineProps` extended with `resumeContext` prop

---

## 5. Cross-Phase Concerns

### Database Migrations

None. Preview endpoint is stateless. Iteration data stored in existing schemaless `discoveryState` field.

### Feature Flags

None. All features are additive — existing flows unchanged.

### Configuration Changes

No new env vars. Preview rate limit (10/min/tenant) via existing `searchAiRateLimit()` middleware. No custom constants needed.

### Design Tokens

- Reason text: `text-muted` (secondary, subtle)
- Preview panel: `bg-background-subtle`, `border-default`, `text-foreground`
- Preview stats: `text-muted`
- JS rendering advisory: `text-warning`, `bg-warning/10`
- Iteration trigger icons: `text-muted`
- Selected counter progress bar: `bg-accent`

### i18n

~25 new flat keys under `search_ai.crawl_flow` (matching existing convention — no nesting):

- `reason_*` (~10 keys) — `reason_auto_add`, `reason_scope_parent`, `reason_scope_sibling`, `reason_yield_productive`, `reason_yield_declining`, `reason_yield_stalled`, `reason_duplicate_skip`, `reason_strategy_sitemap`, `reason_strategy_discover`, `reason_strategy_guided`
- `preview_*` (~8 keys) — `preview_title`, `preview_stats_words`, `preview_stats_images`, `preview_stats_noise`, `preview_js_advisory`, `preview_error`, `preview_loading`, `preview_indexed_label`
- `iterate_*` (~7 keys) — `iterate_coverage_summary`, `iterate_explore_remaining`, `iterate_add_url`, `iterate_history_aggregate`, `iterate_counter`, `iterate_complete`, `iterate_trigger_label`

### Deferred Items (Not in Scope)

- **§6.9.1 "Next Actions" queue display**: Deferred across all 3 LLD phases. Requires backend `nextTargets` field in depth-prober progress — the structured `autoAddReason`/`yieldReason` fields added in Phase 1 of this LLD lay groundwork, but the actual queue display requires additional backend changes. Track as a future enhancement.
- **TraceEvent emission for interventions** (G26 audit trail): Deferred from Phase 2 LLD, remains deferred.
- **I-10 Edit Samples UI**: Deferred from Phase 2 LLD (dispatch wiring built, editor UI deferred).

### Test Spec Gap

The test spec (`docs/testing/web-crawling.md`) was last updated 2026-04-23 and has no scenarios for Phase 3 features (reason strings, preview endpoint, iterative SSE). Run `/post-impl-sync` after implementation to add coverage scenarios (at minimum: INT-preview-ssrf, INT-preview-readability, E2E-iterative-discovery).

### Merge Priority Rules (Iterative Discovery)

When merging results across iterations (Phase 5 task 5.5):

- **User-explicit states take precedence**: If user marked a node as `skipped` in iteration 1, re-discovery in iteration 2 does NOT override the skip — unless the user explicitly triggered re-exploration of that branch.
- **System-discovered states are additive**: New URLs/nodes are added, existing nodes get confidence upgrades, but never state downgrades.
- This is consistent with UJ-11 (reverse any previous decision) — the user's decisions are the contract.

### Security

- Preview endpoint: SSRF protection via `validateAndFetchURL()` (handles protocol/IP/DNS checks internally) + origin match against `baseUrl`
- Preview endpoint: ownership check — user must have a CrawlDraft with matching baseUrl (prevents open SSRF proxy)
- Preview endpoint: rate limit 10/min/tenant via `searchAiRateLimit()` middleware (no in-memory concurrent limit — stateless-distributed)
- Preview endpoint: 10s fetch timeout, 5MB max response (`validateAndFetchURL` defaults)
- Preview endpoint: logger via `createLogger('crawl-preview')` for audit trail
- Resume context: `visitedUrls` capped at 15,000 entries, `exploredBranches` elements max 2048 chars (Zod validation, `z.string().min(1)` not `.url()`)

---

## 6. Acceptance Criteria (Whole Feature)

- [ ] All 5 phases complete with exit criteria met
- [ ] **UJ-13**: Auto-add sections show "because X" reason in console
- [ ] **UJ-13**: Scope exclusions explain why (parent, sibling, excluded)
- [ ] **UJ-13**: Yield signals explain rate changes
- [ ] **UJ-14/G10**: Preview endpoint returns extraction result for valid URL
- [ ] **UJ-14/G10**: Step 3 shows inline preview with title, excerpt, stats
- [ ] **UJ-14/G10**: SSRF protection blocks private IPs
- [ ] **G8**: Second discovery iteration skips previously visited URLs
- [ ] **G8**: "Add URL & Discover" expands scope and starts targeted iteration
- [ ] **G8**: Iteration history shows all runs with triggers and stats
- [ ] **UJ-15**: Selected vs available counter shows correct ratio
- [ ] All components use design tokens (no hardcoded colors)
- [ ] All user-facing strings use i18n
- [ ] `pnpm build` succeeds across all affected packages
- [ ] No regressions in existing tests (190+ unit tests pass)
- [ ] reason-utils tests pass (15+ new tests)
- [ ] crawl-preview tests pass (8+ new tests)

### Objective Mapping

| Objective                        | Phase(s)   | How Verified                                  |
| -------------------------------- | ---------- | --------------------------------------------- |
| UJ-13 (understand why)           | Phase 1    | Reasons in console for auto-add, scope, yield |
| UJ-14 (verify before committing) | Phase 2, 3 | Preview endpoint + inline panel in Step 3     |
| UJ-15 (selected vs available)    | Phase 5    | Counter in CoverageSummary                    |
| G8 (iterative discovery)         | Phase 4, 5 | Multi-run with resume context, merge results  |
| G10 (extraction preview)         | Phase 2, 3 | Same as UJ-14                                 |

---

## 7. Open Questions

1. **Preview for JS-rendered pages**: Should we offer a "Render with browser" button that uses Playwright for a more accurate preview?
   - DECIDED: Not in this LLD. Show advisory text "This page uses JavaScript. Browser rendering may produce different content." Future enhancement via Playwright preview.

2. **Reason verbosity toggle**: Should there be a "Show reasons" toggle in the console, or always show?
   - DECIDED: Always show. Reasons are subtle (text-muted, indented) and don't clutter. Users wanting less noise can collapse console sections.

3. **Preview caching on server**: Should search-ai cache preview results?
   - DECIDED: No server cache. Client-side cache per URL is sufficient. Preview is on-demand and infrequent. Server cache adds complexity + stale content risk.

4. **Max iterations**: Should there be a limit on how many discovery iterations a user can run?
   - DECIDED: Soft limit of 10 iterations with a warning: "You've run 10 discovery iterations. Consider proceeding to crawl." No hard cap — user always wins (G3).

5. **Resume context size**: With 15K URL limit in `visitedUrls`, a POST body could be ~1MB. Is this acceptable?
   - DECIDED: Yes. Express default body limit is typically 1MB+. Add explicit `express.json({ limit: '2mb' })` on the start-explore route if needed. The 15K cap keeps it well under limits.

6. **"Discover More" scope behavior confirmed**: `explore-all-nav` does NOT auto-expand scope. Only explicit `add-sample` (via "Add URL & Discover" input) adds the URL as a sample and expands scope via `deriveScope()`. This is consistent with the scope-flows-down rule and was validated with the user.

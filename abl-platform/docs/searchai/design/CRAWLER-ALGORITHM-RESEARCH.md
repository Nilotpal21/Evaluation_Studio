# Crawl Intelligence -- Algorithm Research & Design Rationale

This document explains the reasoning behind each of the 12 algorithms (A1--A12)
in the crawl intelligence system. For each algorithm: the problem it solves,
the alternatives that were evaluated, which was recommended and why, what was
actually implemented, and key design decisions.

Source material: `docs/specs/crawl-intelligence-algorithms.md` (1,372-line
algorithm catalogue), `docs/specs/crawl-intelligence-gap-analysis.md`, HLD
documents V6/V7/V8.

---

## Algorithm Index

| ID  | Name                    | Problem                                     | Implemented Class                   | File                                                                                    | Version |
| --- | ----------------------- | ------------------------------------------- | ----------------------------------- | --------------------------------------------------------------------------------------- | ------- |
| A1  | Site Type Detection     | Static, SPA, or hybrid?                     | `FastProfiler`                      | `packages/crawler/src/profiler/fast-profiler.ts`                                        | V1      |
| A2  | Platform Identification | What CMS/framework/ecommerce platform?      | `PlatformDetector`                  | `packages/crawler/src/intelligence/algorithms/platform-detector.ts`                     | V8      |
| A3  | URL Pattern Clustering  | Group URLs into structural families         | `UrlClusterer`                      | `packages/crawler/src/intelligence/algorithms/url-clusterer.ts`                         | V6      |
| A4  | Template Fingerprinting | Are two pages from the same template?       | `TemplateFingerprinter`             | `packages/crawler/src/intelligence/algorithms/template-fingerprinter.ts`                | V3      |
| A5  | Pagination Discovery    | How does this listing page paginate?        | `PaginationDetector`                | `packages/crawler/src/intelligence/algorithms/pagination-detector.ts`                   | V6      |
| A6  | Link Relevance Scoring  | Which discovered links are worth following? | `LinkScorer`                        | `packages/crawler/src/intelligence/algorithms/link-scorer.ts`                           | V6      |
| A7  | Content Quality Gate    | Did the crawl capture real content?         | `QualityGate`                       | `packages/crawler/src/intelligence/algorithms/quality-gate.ts`                          | V6      |
| A8  | Interactive Detection   | Does this page hide content behind JS?      | `InteractiveDetector`               | `packages/crawler/src/intelligence/algorithms/interactive-detector.ts`                  | V7      |
| A9  | Intent Decomposition    | Break "crawl everything" into sub-tasks     | `IntentDecomposer`                  | `packages/crawler/src/intelligence/algorithms/intent-decomposer.ts`                     | V7      |
| A10 | Sitemapless Discovery   | Find all URLs when no sitemap exists        | `DiscoveryChain`                    | `packages/crawler/src/intelligence/algorithms/discovery-chain.ts`                       | V8      |
| A11 | Escalation Prediction   | Predict if a page needs browser/LLM         | `FailureScorer`                     | `packages/crawler/src/intelligence/algorithms/failure-scorer.ts`                        | V6      |
| A12 | Template Learning       | Learn extraction rules, apply at scale      | `JsonLdExtractor` + `HandlerReuser` | `packages/crawler/src/intelligence/algorithms/jsonld-extractor.ts`, `handler-reuser.ts` | V3/V7   |

All algorithm classes live under `packages/crawler/src/intelligence/algorithms/`.
Supporting classes: `HttpAdapter` (SSRF-protected HTTP fetch), `MongoHandlerStore`
(persistent handler templates).

---

## A1: Site Type Detection

### Problem

Given a single URL (typically homepage), determine whether the site serves
content as static HTML, a single-page application (SPA), or a server-side
rendered hybrid. This decides whether HTTP fetch is sufficient or a headless
browser is required.

### Alternatives Evaluated

| Alt  | Algorithm                        | Pros                                   | Cons                                 |
| ---- | -------------------------------- | -------------------------------------- | ------------------------------------ |
| A1-a | DOM Marker Cascade               | Fast (<1ms), zero FP on known markers  | Blind to unknown frameworks          |
| A1-b | Content Delta (HTTP vs rendered) | Ground truth for JS dependency         | Requires browser launch (2-5s)       |
| A1-c | Script Analysis                  | Catches unknown frameworks, no browser | JS-heavy static sites false-positive |
| A1-d | HTTP Header Signals              | No HTML parsing needed                 | Many sites strip headers             |

### Recommendation & Rationale

**A1-a (DOM markers) as primary + A1-c (script analysis) as fallback.**
DOM markers are fast, high-precision, and cover the known framework universe
(Next.js, Nuxt, React, Vue, Angular). Script analysis catches the long tail
of unknown frameworks without requiring a browser. A1-b (content delta) is
reserved for the quality gate (A7) post-crawl, not the detection step.

### Implementation

**Class:** `FastProfiler.detectSiteType()` in `packages/crawler/src/profiler/fast-profiler.ts`

Implements A1-a only: DOM markers check for `__NEXT_DATA__`, `#root`,
`[data-v-]`, and semantic HTML tags. First match wins.

### Key Decisions

- A1-c (script analysis fallback) was deferred as LOW priority. Known
  frameworks cover 90%+ of real sites.
- The detection runs during the profiling step before any crawl begins,
  so latency matters more than coverage of edge cases.

---

## A2: Platform Identification

### Problem

Identify the specific platform (Shopify, WordPress, Magento, Next.js, etc.)
powering a website. Knowing the platform unlocks shortcut strategies: known URL
structures, hidden APIs, predictable pagination patterns.

### Alternatives Evaluated

| Alt  | Algorithm                   | Pros                                    | Cons                               |
| ---- | --------------------------- | --------------------------------------- | ---------------------------------- |
| A2-a | Wappalyzer-style pattern DB | High accuracy, catches ecommerce        | Pattern DB needs maintenance       |
| A2-b | API Probing                 | Definitive proof, discovers usable APIs | 3-5 extra HTTP calls, may trip WAF |
| A2-c | DNS/Certificate             | Works before any HTTP request           | Custom domains hide platform       |
| A2-d | LLM Classification          | Handles novel platforms                 | Slow, expensive, overkill          |

### Recommendation & Rationale

**A2-a (pattern DB) + A2-b (API probing for ecommerce only).** Platform
identification is a solved classification problem -- no LLM needed. The pattern
DB provides fast detection. API probing for Shopify, WordPress, and Magento is
justified because discovered APIs become crawl shortcuts (e.g., Shopify
`/products.json` returns all products without page-by-page crawling).

Platform shortcut table:

| Platform    | Shortcut Available                                 |
| ----------- | -------------------------------------------------- |
| Shopify     | `/products.json`, `/collections/{h}/products.json` |
| WordPress   | `/wp-json/wp/v2/posts?per_page=100`                |
| WooCommerce | `/wp-json/wc/v3/products` (if public)              |
| Magento 2   | `/rest/V1/products?searchCriteria[pageSize]=50`    |
| Next.js     | `/_next/data/{buildId}/{path}.json`                |
| Gatsby      | `/page-data/{path}/page-data.json`                 |

### Implementation

**Class:** `PlatformDetector` in `packages/crawler/src/intelligence/algorithms/platform-detector.ts`

Multi-signal detection with a database of 12+ platform patterns. Each platform
has an array of signals (meta tags, script sources, HTML comments, CSS selectors,
HTTP headers, cookies). Confidence scoring uses `max(matched_confidences)` --
a single high-confidence signal is sufficient (e.g., `x-shopify-stage` header
= 0.99 confidence).

Replaces the primitive `detectFramework()` which used `html.includes('react')`
and was known to false-positive on page text mentioning "react".

API probing for ecommerce platforms is included. Discovered API endpoints are
returned as `apiEndpoints[]` for use by A10 (sitemapless discovery).

### Key Decisions

- **Replace, not extend.** The old `detectFramework()` had fundamental issues
  (substring matching on page content). Clean replacement with backward-compatible
  return type.
- **`max()` not `sum()` for confidence.** A single definitive signal (meta tag,
  header) is sufficient. Summing weak signals could produce false positives.
- **SSRF protection.** All API probing HTTP requests go through `HttpAdapter`
  which validates hostnames against private/loopback IP ranges.
- **No `html.includes()`.** Only DOM selector checks to prevent false positives
  from page text content.

---

## A3: URL Pattern Clustering

### Problem

Given a flat list of URLs (from sitemap, link extraction, or CDX), group them
into structural families where each family shares a URL template (e.g.,
`/products/{slug}` x 847, `/blog/{year}/{slug}` x 203). This replaces sending
10K raw URLs to the LLM.

### Alternatives Evaluated

| Alt  | Algorithm                    | Pros                                   | Cons                               |
| ---- | ---------------------------- | -------------------------------------- | ---------------------------------- |
| A3-a | Path Segment Frequency       | O(n), no training, works on any site   | Fails on flat URLs (?id=123)       |
| A3-b | Hierarchical Trie Clustering | Captures multi-level patterns          | O(n log n), complex implementation |
| A3-c | Regex Induction              | Precise patterns with type hints       | NP-hard in general                 |
| A3-d | LLM Pattern Inference        | Handles any structure, semantic labels | Cannot process 10K URLs, expensive |

### Recommendation & Rationale

**A3-a (frequency analysis) as primary + A3-b (trie) for multi-level patterns +
A3-d (LLM) only to label discovered groups.** The key insight is that the LLM
should label groups, not find them. Frequency analysis is O(n) and
deterministic. The trie structure naturally handles multi-level patterns like
`/blog/{year}/{slug}`.

### Implementation

**Class:** `UrlClusterer` in `packages/crawler/src/intelligence/algorithms/url-clusterer.ts`

Combined A3-a + A3-b approach: builds a trie from URL path segments, collapses
high-fanout nodes into `{slug}` wildcards using frequency analysis, then groups
URLs by their resulting pattern. Returns `UrlGroup[]` with pattern, count, and
example URLs.

Configuration: `minGroupSize` (default 2), `maxGroups` (default 20),
`maxUrls` (default 5000).

### Key Decisions

- **Trie-based, not pure frequency.** The trie naturally discovers multi-level
  patterns (`/blog/{year}/{slug}`) that flat frequency analysis misses.
- **Category-aware collapsing.** A threshold prevents collapsing category nodes
  (e.g., `/products/`, `/docs/`) into wildcards when they have few children
  but many descendant URLs.
- **Separate API endpoint.** URL clustering is exposed as
  `POST /crawl/cluster-urls`, not inlined in the profile endpoint, because
  it requires fetching the sitemap (500ms-3s) and would delay the profile
  response.
- **A3-d (LLM labeling) was deferred.** Groups are labeled by their pattern
  string, not by semantic intent. LLM labeling would add latency and cost for
  marginal benefit.

---

## A4: Page Template Fingerprinting

### Problem

Given two HTML pages, determine if they were generated from the same template
(same CMS template, same React component, same server-side layout). If yes,
extraction rules learned from one apply to all.

### Alternatives Evaluated

| Alt  | Algorithm                    | Pros                                | Cons                                 |
| ---- | ---------------------------- | ----------------------------------- | ------------------------------------ |
| A4-a | SimHash on DOM Tag Sequence  | O(n) compute, O(1) compare          | Ignores content structure            |
| A4-b | CSS Class Set Jaccard        | Very fast, captures styling         | Tailwind makes all pages similar     |
| A4-c | Tree Edit Distance           | Most accurate structural comparison | O(n^2) worst case, too slow at scale |
| A4-d | Visual Fingerprint (pHash)   | Catches visual template differences | Requires browser render              |
| A4-e | Hybrid SimHash + CSS Jaccard | More robust than either alone       | Needs weight tuning                  |

### Recommendation & Rationale

**A4-a (SimHash) for clustering at scale + A4-e (hybrid) for high-confidence
matching + A4-c (tree edit distance) only for cluster verification.** SimHash
provides O(1) comparison with Hamming distance, making it practical for
comparing every page against a library of known templates.

### Implementation

**Class:** `TemplateFingerprinter` in `packages/crawler/src/intelligence/algorithms/template-fingerprinter.ts`

Implements A4-a: 64-bit SimHash over DOM tag-path sequences.

Algorithm:

1. Parse HTML with cheerio, strip noise elements (scripts, styles, ads, cookies)
2. Extract ordered tag-path sequence via depth-first pre-order walk (max depth 15)
3. Compute 64-bit SimHash using FNV-1a hashing over tag-path features
4. Compare: Hamming distance <= 3 = same template

Constants: `MAX_TAG_PATH_DEPTH = 15`, `MAX_TAG_PATHS = 10000`,
`MAX_HTML_SIZE = 5MB`, `SAME_TEMPLATE_THRESHOLD = 3`.

**Class:** `HandlerReuser` in `packages/crawler/src/intelligence/algorithms/handler-reuser.ts`

Uses `TemplateFingerprinter` to match incoming pages against a library of known
handlers. On match (Hamming <= 3), skips Phase 2 (UNDERSTAND) and Phase 3
(BUILD HANDLER), saving 2 LLM calls per reused page. Library is bounded:
`MAX_LIBRARY_SIZE = 1000`, `TTL = 1 hour` (sliding window).

### Key Decisions

- **A4-e (hybrid) was deferred** as LOW priority. Tailwind-heavy sites would
  make CSS Jaccard unreliable anyway.
- **Sliding-window TTL** on handler entries. Frequently-matched templates stay
  alive as long as they are actively reused, rather than expiring at a fixed
  time from creation.
- **Quality measurement** via `measureQuality()` (Jaccard similarity + field
  completeness) was built but initially not wired for confidence decay.

---

## A5: Pagination Discovery

### Problem

Given a listing/category page, detect how it paginates and how many pages
exist. Required for complete URL discovery on paginated sites.

### Alternatives Evaluated

| Alt  | Algorithm              | Pros                               | Cons                                 |
| ---- | ---------------------- | ---------------------------------- | ------------------------------------ |
| A5-a | Link Pattern Detection | Fast, reliable for server-rendered | Misses JS-only pagination            |
| A5-b | Binary Search Probe    | Finds total in O(log n) requests   | Only works with URL-based pagination |
| A5-c | API Interception       | Catches all pagination types       | Requires browser, complex            |
| A5-d | Item Count Text        | Exact count without probing        | Format varies widely                 |
| A5-e | LLM Page Analysis      | Handles any pagination style       | Expensive, non-deterministic         |

### Recommendation & Rationale

**A5-a (link pattern) + A5-d (item count) combined.** Link pattern detection
covers 80% of sites (query params, path segments, rel=next, .pagination CSS
classes). Item count text extraction provides total page estimates when
available. Binary probe (A5-b) as fallback when link pattern is found but max
page is unknown.

### Implementation

**Class:** `PaginationDetector` in `packages/crawler/src/intelligence/algorithms/pagination-detector.ts`

Implements A5-a + A5-d with dom-based detection. Detection strategies in
priority order:

1. `rel="next"` link tags (highest confidence, spec-defined)
2. Query parameter patterns (`?page=N`)
3. Path segment patterns (`/page/N`)
4. DOM patterns (`.pagination` class with page links)
5. Item count text ("Showing 1-20 of 342")

Returns `PaginationResult` with type, pattern, currentPage, totalPages,
nextUrl, allPageUrls, and confidence score.

Configuration: `maxPages` default 100 (prevents generating thousands of URLs).

Provides both `detect(url, html, links)` and `detectWithDom($, url, links)`
overloads (V7 cheerio optimization).

### Key Decisions

- **Max 100 pages cap** prevents runaway URL generation for sites with enormous
  pagination.
- **Priority ordering** ensures the most reliable detection method is used
  first. `rel="next"` is spec-defined and highest confidence.
- **A5-b (binary probe) and A5-c (API interception) were deferred.**

---

## A6: Link Relevance Scoring

### Problem

Given a page with 50-200 outbound links and a user intent, decide which links
are worth following. Pure BFS wastes 80%+ of crawl budget on irrelevant pages
(terms, privacy, blog, unrelated sections).

### Alternatives Evaluated

| Alt  | Algorithm            | Pros                            | Cons                                |
| ---- | -------------------- | ------------------------------- | ----------------------------------- |
| A6-a | URL Pattern Match    | O(1) per link, deterministic    | Requires A3 patterns first          |
| A6-b | Anchor Text TF-IDF   | Works without URL patterns      | Anchor text often generic           |
| A6-c | Link Context Scoring | Structural signals are reliable | Not all sites use semantic HTML     |
| A6-d | Batch LLM Scoring    | Semantic understanding          | 1 LLM call per crawled page         |
| A6-e | HITS Hub/Authority   | Discovers structure emergently  | Needs 50+ pages, cold start problem |

### Recommendation & Rationale

**A6-a (URL pattern match) + A6-c (link context) combined.** Fast,
deterministic, no LLM cost. A6-d (batch LLM) only at frontier expansion
points when entering a new site section for the first time.

### Implementation

**Class:** `LinkScorer` in `packages/crawler/src/intelligence/algorithms/link-scorer.ts`

Score formula: `0.4 * patternMatch + 0.3 * structuralBonus + 0.3 * textRelevance`

Four scoring signals:

1. **Pattern match** (A6-a): Score link URL against UrlClusterer groups
2. **Structural context** (A6-c): DOM position analysis (nav/article/footer)
3. **Text relevance**: Anchor text quality assessment
4. **Utility page penalty**: Hard-zero for login, privacy, terms, etc.

Utility pages are hard-zeroed regardless of other signals. Configurable
`relevanceThreshold` (default 0.4). Accepts optional `UrlGroup[]` from A3.

Provides both `scoreLinks()` and `scoreLinksWithDom($, links, url)` overloads.

### Key Decisions

- **Hard-zero for utility pages.** Login, signup, privacy, terms pages never
  contain indexable content. No scoring nuance needed.
- **A6-d (batch LLM) was deferred** to avoid per-page LLM cost.
- **A6-e (HITS) was deferred** as impractical until enough pages are crawled.

---

## A7: Content Quality Gate

### Problem

After crawling a page, determine whether the extracted content is real and
complete or a thin shell (SPA skeleton, cookie wall, anti-bot challenge, login
gate). This was identified as the CRITICAL gap -- bad content was silently
entering the search index.

### Alternatives Evaluated

| Alt  | Algorithm                       | Pros                           | Cons                               |
| ---- | ------------------------------- | ------------------------------ | ---------------------------------- |
| A7-a | Content Length Threshold        | Trivial to implement           | Some legitimate pages are short    |
| A7-b | Boilerplate Ratio               | Detects nav-heavy "full" pages | Requires DOM parsing               |
| A7-c | Hidden Content Score            | Detects accordion/tab problem  | Framework-specific selectors       |
| A7-d | Cross-Page Variance             | Catches SPA shells             | Needs multiple pages from template |
| A7-e | Content Delta (HTTP vs browser) | Ground truth                   | Requires browser for samples       |

### Recommendation & Rationale

**Multi-signal score combining A7-a + A7-b + A7-c.** Content length is the
strongest predictor (catches empty SPAs). Boilerplate ratio catches pages that
"look full" but are all navigation. Hidden content indicator detects collapsed
accordions and tabs. The composite score with thresholds provides a
quality/escalation decision without any LLM calls.

### Implementation

**Class:** `QualityGate` in `packages/crawler/src/intelligence/algorithms/quality-gate.ts`

Score formula:

```
score = 0.4 * contentLengthScore + 0.35 * (1 - boilerplateRatio) + 0.25 * (1 - hiddenRatio)
```

Quality buckets: `score >= 0.7` = rich, `0.3 <= score < 0.7` = standard,
`score < 0.3` = thin.

If `shouldBlock` is true (score < blockThreshold), the page is skipped for
ingestion and a `intelligence_page_blocked` WebSocket event is emitted to
Studio with the reason and quality score.

Configurable thresholds: `minContentLength` (500), `maxBoilerplateRatio` (0.7),
`maxHiddenRatio` (0.5), `blockThreshold` (0.3).

Returns detailed `QualitySignal[]` for transparency.

### Key Decisions

- **Weight rationale:** Content length (0.4) is the strongest predictor.
  Boilerplate ratio (0.35) catches nav-heavy pages. Hidden content (0.25) is
  the weakest because some hidden content is legitimate (screen-reader text,
  collapsible sections).
- **Block threshold 0.3** is configurable per tenant but defaults conservatively.
- **Wired in the worker for both HTTP and Playwright paths.** Every page passes
  through the quality gate before ingestion, regardless of fetch method.
- **This was the #1 priority** (CRITICAL gap). V6 shipped this first.

---

## A8: Interactive Element Detection

### Problem

Detect whether a page contains content hidden behind JavaScript interactions
(accordions, tabs, modals, lazy-load, infinite scroll). This determines whether
simple HTTP extraction is sufficient or browser interaction is required.

### Alternatives Evaluated

| Alt  | Algorithm                | Pros                                | Cons                            |
| ---- | ------------------------ | ----------------------------------- | ------------------------------- |
| A8-a | CSS Selector Library     | Fast (cheerio), precise             | Framework-specific, maintenance |
| A8-b | ARIA Role Analysis       | Framework-agnostic, standards-based | Not all sites use proper ARIA   |
| A8-c | Event Listener Detection | Catches all interactive patterns    | Requires browser + DevTools     |
| A8-d | Visibility Delta         | Works on raw HTML                   | CSS classes not resolved        |

### Recommendation & Rationale

**A8-a (CSS selector library) + A8-b (ARIA roles) combined.** Both work on raw
HTML via cheerio -- no browser needed. Returns structured detection results that
feed into A7 (quality gate) and A11 (escalation prediction).

### Implementation

**Class:** `InteractiveDetector` in `packages/crawler/src/intelligence/algorithms/interactive-detector.ts`

Implements A8-a + A8-b with a static CSS selector library covering 7 element
types, each with 3-6 selectors:

- **Accordions:** `[data-bs-toggle="collapse"]`, `.accordion`, `details:not([open])`
- **Tabs:** `[role=tab]`, `[role=tabpanel]`, `.nav-tabs`, `[aria-selected]`
- **Carousels:** `.carousel`, `[data-bs-ride="carousel"]`
- **Lazy images:** `[data-src]`, `[loading=lazy]`, `.lazyload`
- **Infinite scroll:** `[data-infinite]`, `.infinite-scroll`
- **Modals:** `[data-bs-toggle="modal"]`, `[role=dialog]`, `dialog`
- **Dropdowns:** `.dropdown`, `[data-bs-toggle="dropdown"]`

Each element type has a per-type confidence score. The aggregate confidence is
the max across all detected element types. `needsPlaywright` is true when
confidence exceeds `minConfidence` (default 0.5).

### Key Decisions

- **Static constant selector library.** No runtime growth, fully bounded at
  compile time. Covers Bootstrap, ARIA standards, and common web patterns.
- **Feeds A11 but does not independently change routing.** Interactive detection
  provides signals that the FailureScorer (A11) uses as part of its decision.
- **Replaced keyword search.** The V1-V5 approach searched for "accordion",
  "collapse", "tab" in raw page text, producing false positives from content
  that merely mentions these words.

---

## A9: Intent Decomposition

### Problem

A user says "crawl all products and categories from example.com." This is
really multiple distinct extraction tasks with different page types, different
extraction schemas, and different strategies. Decompose into executable
sub-intents.

### Alternatives Evaluated

| Alt  | Algorithm                       | Pros                             | Cons                           |
| ---- | ------------------------------- | -------------------------------- | ------------------------------ |
| A9-a | URL Group to Intent (bottom-up) | Grounded in real site structure  | Requires URL inventory first   |
| A9-b | LLM Plan Generation (top-down)  | Works before URL discovery       | May hallucinate sub-intents    |
| A9-c | Hybrid (top-down + validate)    | Best of both                     | More complex, 2 LLM calls      |
| A9-d | Platform Template (shortcut)    | Zero LLM cost, proven strategies | Only works for known platforms |

### Recommendation & Rationale

**A9-d (platform shortcut) when platform known, A9-a (bottom-up) when URL
inventory available, A9-c (hybrid) for unknown sites.** Never use A9-b alone --
always validate against real site structure. The LLM is good at reasoning about
intent but prone to hallucinating sub-intents that do not match the actual site.

### Implementation

**Class:** `IntentDecomposer` in `packages/crawler/src/intelligence/algorithms/intent-decomposer.ts`

Algorithm:

1. Pre-cluster sitemap URLs by path prefix (first 2 segments)
2. Build compact prompt with cluster summaries (max 100 groups)
3. Single LLM call to decompose intent into sub-intents
4. Validate + filter response against actual sitemap URLs

Returns `SubIntent[]` with intent description, URL pattern, estimated URLs,
confidence, and reasoning.

Uses exactly 1 LLM call per decomposition. Input sanitization caps intent
length at 1000 characters.

Wired in the worker pre-loop: if intent and discovered URLs are available,
decomposition runs once to prioritize URL processing order.

### Key Decisions

- **Bottom-up approach (A9-a) is primary.** URL groups from A3 anchor the
  decomposition in real site structure.
- **Single LLM call.** Compact cluster summaries keep the prompt under 8K
  tokens even for sites with 100+ URL groups.
- **A9-d (platform shortcuts) was deferred** pending A2 platform detection
  completion.

---

## A10: Sitemapless Discovery

### Problem

Find all relevant URLs on a website that has no sitemap.xml, no robots.txt
Sitemap directive, and no known platform API. A significant portion of real
sites either lack sitemaps or have incomplete ones.

### Alternatives Evaluated

| Alt   | Algorithm                | Pros                                 | Cons                               |
| ----- | ------------------------ | ------------------------------------ | ---------------------------------- |
| A10-a | Breadth-First Spider     | Complete discovery given enough time | Visits everything, no filtering    |
| A10-b | Navigation-First BFS     | Follows site hierarchy               | Misses unlinked pages              |
| A10-c | CDX Bootstrap            | Discovers orphan/historical URLs     | Data may be stale, slow            |
| A10-d | Platform API             | Complete, structured, fast           | Only for known platforms           |
| A10-e | Site Search Exploitation | Discovers unlisted items             | Rate limiting risk, ethical issues |
| A10-f | Footer/Auxiliary Mining  | Quick wins, often comprehensive      | Not all sites have these           |

### Recommendation & Rationale

**Fallback chain (try in order, stop when sufficient):**

1. A10-d: Platform API (if A2 detected Shopify/WP)
2. A10-f: Footer + HTML sitemap mining
3. A10-b: Navigation-first BFS
4. A10-c: CDX bootstrap (Wayback Machine)
5. A10-a: Full BFS (last resort only)

Never start with full BFS. Always try structured approaches first.

### Implementation

**Class:** `DiscoveryChain` in `packages/crawler/src/intelligence/algorithms/discovery-chain.ts`

5-step fallback chain:

1. **Platform API** -- Uses `PlatformDetector` API endpoints (Shopify `/products.json`, WordPress `/wp-json/...`)
2. **Footer mining** -- Scans footer links + common sitemap page paths (`/site-map`, `/sitemap`, `/all-products`, `/pages`)
3. **Nav-BFS** -- Follows `<nav>` links up to 10 section pages
4. **CDX bootstrap** -- Queries `web.archive.org` historical URLs (10s timeout)
5. **Entry page links** -- All same-hostname links from homepage

All HTTP requests go through `HttpAdapter` (SSRF protected). Stops early when
`minUrls` (default 20) reached. Caps total at `maxUrls` (default 5000).

Returns `DiscoveryResult` with URLs, the method that produced the most results,
and a full audit trail of all steps tried with timing.

### Key Decisions

- **Early stopping.** Once enough URLs are found, skip remaining steps.
  Shopify API can return 1000+ URLs -- no need for nav-BFS after that.
- **CDX is optional + async.** Wayback Machine can be slow (5-30s). Run with
  10s timeout, non-blocking. If it fails, continue without it.
- **All HTTP via HttpAdapter.** SSRF protection is mandatory for all new
  fetches. No raw axios calls.
- **A10-a (full BFS) was deferred** as last resort with high cost.

---

## A11: Escalation Prediction

### Problem

Before running a full crawl, predict whether a given URL (or URL group) will
need browser rendering and/or LLM intelligence. This avoids wasting Playwright
cost (10-50x slower than HTTP) on pages that could be fetched statically.

### Alternatives Evaluated

| Alt   | Algorithm             | Pros                       | Cons                               |
| ----- | --------------------- | -------------------------- | ---------------------------------- |
| A11-a | Site-Level Rule       | Simple, fast               | Same strategy for ALL pages        |
| A11-b | Per-Group Prediction  | Per-group granularity      | 3 x num_groups extra HTTP fetches  |
| A11-c | Multi-Signal Score    | Holistic, uses all signals | Weight tuning needs empirical data |
| A11-d | Post-Crawl Escalation | No false predictions       | Double-crawl cost for some pages   |

### Recommendation & Rationale

**A11-b (per-group sample) + A11-d (post-crawl fallback).** Two safety nets:
pre-crawl prediction samples 3 pages per URL group and predicts the strategy
for the whole group. Post-crawl quality gate (A7) catches mispredictions.

### Implementation

**Class:** `FailureScorer` in `packages/crawler/src/intelligence/algorithms/failure-scorer.ts`

Heuristic scoring (0-100 scale) with weighted signals:

Positive signals (indicate need for escalation):

- `short_text` (weight 25): Text content < 200 chars
- `no_links` (weight 15): Zero internal links extracted
- `empty_mount_point` (weight 20): Empty `#root`/`#app` div
- `high_markup_ratio` (weight 15): HTML to text ratio > 10:1
- `noscript_content` (weight 10): Has `<noscript>` content
- `framework_marker` (weight 10): SPA framework markers in HTML

Anti-signals (indicate SSR, reduce score):

- `ssr_next_data`: `__NEXT_DATA__` present
- `ssr_content_rich`: Substantial text despite framework markers
- `structured_data`: JSON-LD or microdata present
- `meta_generator`: Meta generator tag present

`shouldEscalate` = score >= threshold (default 50).

**Worker integration:** In the per-page loop, when no pre-crawl group strategy
exists, the worker fetches via HTTP first, runs FailureScorer on the result,
and only escalates to Playwright if the score exceeds the threshold.

### Key Decisions

- **HTTP-first with fallback.** If HTTP fetch or handler reuse fails, fall back
  to Playwright for that page. Correctness is never sacrificed.
- **Per-page scoring when no group strategies.** When the pre-crawl sampling
  step has not run, the worker evaluates each page individually.
- **Anti-signals prevent over-escalation.** SSR frameworks (Next.js, Nuxt)
  look like SPAs in the HTML markers but actually have real content.

---

## A12: Template Learning

### Problem

Given 847 product pages that share the same template, avoid running the full
4-phase LLM intelligence loop on each. Learn extraction rules from a small
sample and apply mechanically to the rest.

### Alternatives Evaluated

| Alt   | Algorithm                      | Pros                          | Cons                                 |
| ----- | ------------------------------ | ----------------------------- | ------------------------------------ |
| A12-a | Single-Example Handler         | Minimum LLM cost (1/group)    | Atypical example breaks everything   |
| A12-b | Multi-Example Consensus        | Robust, handles variations    | 3-5x LLM cost (still 170x cheaper)   |
| A12-c | Template Cluster + Per-Cluster | Handles multiple templates    | Requires fetching all pages first    |
| A12-d | Progressive Learning           | Minimal upfront cost          | First batch may have higher failures |
| A12-e | Schema.org JSON-LD Shortcut    | Zero LLM cost, perfect output | Not all sites have JSON-LD           |

### Recommendation & Rationale

**A12-e (JSON-LD) -> A12-c (cluster) -> A12-d (progressive).** Layered:

1. If JSON-LD structured data exists, extract directly -- zero LLM cost
2. If not, fingerprint + cluster, then multi-example consensus per cluster
3. Progressive fallback for outliers

Cost model for 847 products with 2 template clusters:

| Step                    | LLM Calls | HTTP    |
| ----------------------- | --------- | ------- |
| Fingerprint all pages   | 0         | 847     |
| Cluster into 2 groups   | 0         | 0       |
| 3 examples x 2 clusters | 6         | 0       |
| Consensus merge         | 0         | 6       |
| Batch extract 841 pages | 0         | 0       |
| Outlier fallback (~10)  | 10        | 0       |
| **Total**               | **16**    | **853** |
| vs Naive (1 LLM/page)   | 847       | 847     |

98% reduction in LLM calls.

### Implementation

Two classes implement different layers:

**Class:** `JsonLdExtractor` in `packages/crawler/src/intelligence/algorithms/jsonld-extractor.ts`

Implements A12-e: extracts structured data from `<script type="application/ld+json">`
blocks. Supports target types: Product, Article, Recipe, Event, FAQPage, HowTo.
When enough fields are extracted from a target type (>= `minFieldsForSkip`,
default 3), `canSkipLlm` is set to true.

**Class:** `HandlerReuser` in `packages/crawler/src/intelligence/algorithms/handler-reuser.ts`

Implements A12-d (progressive learning): maintains a library of handlers keyed
by SimHash fingerprint. When a new page matches an existing handler (Hamming
distance <= 3), the handler is reused -- skipping 2 LLM calls. Library is
bounded (max 1000 entries, 1-hour sliding-window TTL).

**Worker integration:** In the per-page loop, JSON-LD extraction runs first.
If `canSkipLlm` is true, the page bypasses the entire intelligence loop.
Otherwise, handler reuse is attempted via SimHash matching. Only if both fail
does the full MAP -> UNDERSTAND -> BUILD HANDLER -> REPLAY loop execute.

### Key Decisions

- **JSON-LD as fast-path before handler reuse.** This is zero LLM cost and
  produces perfectly structured output for well-annotated pages (e-commerce,
  news articles, events).
- **A12-b (multi-example consensus) and A12-c (cross-job cluster learning)
  were deferred.** Current implementation does single-example handler reuse
  within a job (A12-d), not multi-example consensus across jobs.
- **Specificity ordering for JSON-LD.** When multiple JSON-LD blocks exist,
  the most content-specific type is preferred (Product/Article over
  Organization/WebSite/BreadcrumbList).

---

## Composition -- How Algorithms Work Together

The 12 algorithms form a dependency graph. Upstream algorithms produce signals
consumed by downstream algorithms.

```
ALGORITHM DEPENDENCY GRAPH
==========================

  A1 (Site Type)
  A2 (Platform ID) ----+
                       |
                       v
  A10 (Sitemapless) ---+      A2 feeds A10 (platform -> API shortcuts)
      uses A5 (Pagination)    A10 uses A5 for nav-BFS pagination
                       |
                       v
                  A3 (URL Clustering)
                       |
                       v
                  A9 (Intent Decompose)   A3 feeds A9 (groups -> sub-intents)
                       |                  A3 feeds A6 (groups -> pattern match)
                       v                  A3 feeds A11 (groups -> per-group sampling)
           +-- A11 (Escalation Predict)
           |        |
           |        +-- uses A7 (Quality Gate)
           |        +-- uses A8 (Interactive Detection)
           |        |
           v        v
      A12 (Template Learning)
           uses A4 (Fingerprint)
```

Data flow through the pipeline:

```
Phase 0: RECONNAISSANCE (< 5s, 0 LLM calls)
  A1 -> siteType
  A2 -> platform, apiEndpoints
  sitemap fetch -> urls[]
  robots.txt -> disallow[]

Phase 0.5: URL INVENTORY (depends on sitemap availability)
  if sitemap: use sitemap URLs
  else: A10 discovery chain -> urls[]
  A3: cluster urls[] -> UrlGroup[]

Phase 1: INTENT DECOMPOSITION (1 LLM call)
  A9: intent + UrlGroup[] -> SubIntent[]
  Filter out groups not matching user intent

Phase 2: PER-GROUP STRATEGY SELECTION (0 LLM calls)
  For each sub-intent:
    A11: sample 3 pages via HTTP
    A7 + A8: evaluate samples
    -> verdict: HTTP sufficient | needs browser | needs intelligence

Phase 3: EXECUTE PER STRATEGY
  HTTP path:     batch fetch + cheerio extract + A7 gate
  Template path: A12-e JSON-LD | A4 fingerprint + A12-d reuse | full LLM loop
  Intelligence:  MCP + Playwright + LLM (MAP -> UNDERSTAND -> BUILD -> REPLAY)

Phase 4: QUALITY GATE + ESCALATION
  A7: quality gate on ALL extracted content
  A11-d: post-crawl escalation for mispredictions
```

### Key Composition Insight

LLM is used for REASONING (intent, understanding, handler generation).
Algorithms handle SCALE (clustering, fingerprinting, extraction, routing).
Total LLM calls for the full pipeline: approximately 5-30 (vs N per page in
the naive approach).

---

## Research References

- **Wappalyzer** -- Open-source technology detection (A2 pattern DB inspiration).
  https://github.com/wappalyzer/wappalyzer
- **SimHash** -- Charikar (2002), "Similarity Estimation Techniques from Rounding
  Algorithms." Used for A4 template fingerprinting. Locality-sensitive hashing
  for near-duplicate detection.
- **FNV-1a** -- Fowler-Noll-Vo hash function used in SimHash computation for
  individual feature hashing. Fast, well-distributed for string inputs.
- **Colly** -- Go web scraping framework used by `crawler-go-worker` for bulk
  HTTP crawling. https://github.com/gocolly/colly
- **Cheerio** -- Fast, flexible HTML parsing for Node.js. Used by all 12
  algorithms for DOM inspection without a browser.
  https://github.com/cheeriojs/cheerio
- **Schema.org / JSON-LD** -- W3C structured data standard used by A12-e for
  zero-LLM extraction. https://schema.org
- **HITS Algorithm** -- Kleinberg (1999), "Authoritative Sources in a
  Hyperlinked Environment." Evaluated for A6 but deferred due to cold-start
  problem. Hub/authority scoring requires 50+ crawled pages.
- **Zhang-Shasha** -- Tree edit distance algorithm evaluated for A4-c.
  O(n^2) complexity made it impractical for scale.
- **Wayback Machine CDX API** -- Internet Archive's URL index used by A10-c for
  historical URL discovery. https://web.archive.org/cdx/search/cdx

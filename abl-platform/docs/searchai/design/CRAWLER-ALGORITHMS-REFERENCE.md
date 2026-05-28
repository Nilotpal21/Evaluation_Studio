# Crawler Algorithms — Implementation Reference (A1–A12)

> **Purpose:** Detailed reference for each of the 12 crawl intelligence
> algorithms. For each: the problem, alternatives evaluated, chosen solution,
> actual implementation details verified against source code, and key constants.
>
> **Companion document:** [CRAWLER-SYSTEM-ARCHITECTURE.md](./CRAWLER-SYSTEM-ARCHITECTURE.md)
> covers the overall system design, pipelines, and data flows.
>
> **Source directory:** `packages/crawler/src/intelligence/algorithms/`
>
> **Last verified against code:** 2026-03-30

---

## Algorithm Index

| ID  | Name                    | Problem                          | Class                               | File                                                  | LLM?       | Version |
| --- | ----------------------- | -------------------------------- | ----------------------------------- | ----------------------------------------------------- | ---------- | ------- |
| A1  | Site Type Detection     | Static, SPA, or hybrid?          | `FastProfiler`                      | `profiler/fast-profiler.ts`                           | No         | V1      |
| A2  | Platform Identification | What CMS/framework?              | `PlatformDetector`                  | `algorithms/platform-detector.ts`                     | No         | V8      |
| A3  | URL Pattern Clustering  | Group URLs by template           | `UrlClusterer`                      | `algorithms/url-clusterer.ts`                         | No         | V6      |
| A4  | Template Fingerprinting | Same template?                   | `TemplateFingerprinter`             | `algorithms/template-fingerprinter.ts`                | No         | V3      |
| A5  | Pagination Discovery    | How does this page paginate?     | `PaginationDetector`                | `algorithms/pagination-detector.ts`                   | No         | V6      |
| A6  | Link Relevance Scoring  | Which links are worth following? | `LinkScorer`                        | `algorithms/link-scorer.ts`                           | No         | V6      |
| A7  | Content Quality Gate    | Is this real content?            | `QualityGate`                       | `algorithms/quality-gate.ts`                          | No         | V6      |
| A8  | Interactive Detection   | Content behind JS?               | `InteractiveDetector`               | `algorithms/interactive-detector.ts`                  | No         | V7      |
| A9  | Intent Decomposition    | Break intent into sub-tasks      | `IntentDecomposer`                  | `algorithms/intent-decomposer.ts`                     | **1 call** | V7      |
| A10 | Sitemapless Discovery   | Find URLs without sitemap        | `DiscoveryChain`                    | `algorithms/discovery-chain.ts`                       | No         | V8      |
| A11 | Escalation Prediction   | HTTP vs Playwright?              | `FailureScorer`                     | `algorithms/failure-scorer.ts`                        | No         | V6      |
| A12 | Template Learning       | Learn rules, apply at scale      | `JsonLdExtractor` + `HandlerReuser` | `algorithms/jsonld-extractor.ts`, `handler-reuser.ts` | No         | V3/V7   |

**Total LLM calls across all algorithms: 1** (A9 only). Everything else is
pure heuristic — cheerio DOM parsing, regex, SimHash, trie structures, signal
scoring.

---

## Dependency Graph

```
A1 (Site Type) ─────────────────────────────────────┐
A2 (Platform ID) ───┐                               │
                     │                               │
                     ▼                               │
A10 (Discovery) ────►uses A5 (Pagination)           │
    uses A2 API endpoints                            │
                     │                               │
                     ▼                               │
               A3 (URL Clustering)                   │
                     │                               │
              ┌──────┼──────┐                        │
              ▼      ▼      ▼                        │
         A9 (Intent) A6 (Link) A11 (Escalation)     │
                            │      │                 │
                            │   uses A7 (Quality)    │
                            │   uses A8 (Interactive)│
                            │      │                 │
                            ▼      ▼                 │
                     A12 (Template Learning)          │
                        uses A4 (Fingerprint)         │
```

---

## A1: Site Type Detection

### Problem

Determine whether a site is static HTML, SPA, or hybrid — deciding if HTTP
fetch is sufficient or a headless browser is needed.

### Alternatives Evaluated

| Alt  | Algorithm                        | Pros                                  | Cons                                 | Chosen?         |
| ---- | -------------------------------- | ------------------------------------- | ------------------------------------ | --------------- |
| A1-a | DOM Marker Cascade               | Fast (<1ms), zero FP on known markers | Blind to unknown frameworks          | **Primary** ✓   |
| A1-b | Content Delta (HTTP vs rendered) | Ground truth for JS dependency        | Requires browser launch (2–5s)       | Reserved for A7 |
| A1-c | Script Analysis                  | Catches unknown frameworks            | JS-heavy static sites false-positive | Deferred (LOW)  |
| A1-d | HTTP Header Signals              | No HTML parsing needed                | Many sites strip headers             | Not used        |

### Implementation

**Class:** `FastProfiler.detectSiteType()` in `profiler/fast-profiler.ts`

Implements A1-a only:

- SSR markers (`__NEXT_DATA__`, `__NUXT__`) + substantial content → `hybrid`
- SPA framework markers without content → `spa`
- Semantic HTML (`<article>`, `<main>`) + few scripts (`scriptTags < 5`) → `static`
- Content present in HTML (`hasContentInHTML`) + no SPA framework + few scripts (`scriptTags < 10`) → `static`
- Otherwise → `unknown`

### Key Decision

A1-c (script analysis fallback) deferred. Known framework markers cover 90%+ of
real sites, and detection runs during profiling where latency matters.

---

## A2: Platform Identification

### Problem

Identify the CMS/framework (Shopify, WordPress, etc.) powering a site.
Unlocks shortcut strategies: known URL structures, hidden APIs, predictable
pagination.

### Alternatives Evaluated

| Alt  | Algorithm                    | Chosen?         |
| ---- | ---------------------------- | --------------- |
| A2-a | Wappalyzer-style pattern DB  | **Primary** ✓   |
| A2-b | API Probing (ecommerce only) | **Secondary** ✓ |
| A2-c | DNS/Certificate              | Not used        |
| A2-d | LLM Classification           | Not used        |

### Implementation

**Class:** `PlatformDetector` in `algorithms/platform-detector.ts` (571 lines)

**Constructor:** `PlatformDetector(config?: { minConfidence: 0.3, enableApiProbing: true, apiProbeTimeout: 5000 })`

**12 platforms detected:**
Shopify, WordPress, WooCommerce, Magento, Next.js, Nuxt, Gatsby, React, Vue,
Angular, Squarespace, Wix

**Signal types per platform:** meta-tag, script-src, html-comment, selector,
header, cookie

**Confidence calculation:** `max(matched_confidences)` — single highest signal
wins. Not additive (prevents false positives from multiple weak signals).

**Platform inheritance:** Child platform (WooCommerce, confidence 0.8)
suppresses parent (WordPress) when both match.

**API probing (A2-b):** For ecommerce platforms, HTTP requests to known API
endpoints. Success = confidence 0.95. All probes via `HttpAdapter` (SSRF
protected).

**Platform shortcut table (feeds A10):**

| Platform    | API Endpoint                                    | Returns                      |
| ----------- | ----------------------------------------------- | ---------------------------- |
| Shopify     | `/products.json`                                | `{ products: [{ handle }] }` |
| WordPress   | `/wp-json/wp/v2/posts?per_page=100`             | `[{ link }]`                 |
| WooCommerce | `/wp-json/wc/v3/products`                       | Product list                 |
| Magento 2   | `/rest/V1/products?searchCriteria[pageSize]=50` | Product catalog              |
| Next.js     | `/_next/data/{buildId}/{path}.json`             | Page data                    |
| Gatsby      | `/page-data/{path}/page-data.json`              | Page data                    |

### Key Decision

Replaced legacy `detectFramework()` which used `html.includes('react')` —
false-positived on page text mentioning "react". New implementation uses DOM
selectors only.

---

## A3: URL Pattern Clustering

### Problem

Group a flat list of URLs (from sitemap, link extraction, or CDX) into
structural families. Replaces sending 10K raw URLs to the LLM.

### Alternatives Evaluated

| Alt  | Algorithm                    | Chosen?                  |
| ---- | ---------------------------- | ------------------------ |
| A3-a | Path Segment Frequency       | Combined with A3-b ✓     |
| A3-b | Hierarchical Trie Clustering | **Primary** ✓            |
| A3-c | Regex Induction              | Not used (NP-hard)       |
| A3-d | LLM Pattern Inference        | Deferred (labeling only) |

### Implementation

**Class:** `UrlClusterer` in `algorithms/url-clusterer.ts` (403 lines)

**Constructor:** `UrlClusterer(config?: { minGroupSize: 2, maxGroups: 20, maxUrls: 5000 })`

**Algorithm:**

1. Parse URLs into path segments
2. Build trie from all path segments, leaves store original URLs
3. Collapse high-fanout nodes into `{slug}` wildcards:
   - Only when group size ≥ minGroupSize AND avgUrlsPerChild ≤ 2
   - Prevents collapsing category names (`/products/`, `/docs/`) into `{slug}`
4. Walk trie to extract pattern → URL mappings
5. Sort by count descending, cap at maxGroups
6. Excess + small groups → ungrouped

**Returns:** `UrlClusterResult { groups: UrlGroup[], ungrouped: string[], stats }`

**`UrlGroup`:** `{ pattern: string, count: number, examples: string[], depth: number }`
This is the canonical type used by A6 (LinkScorer) and A9 (IntentDecomposer).

### Key Decision

Trie-based (not pure frequency) because it naturally discovers multi-level
patterns like `/blog/{year}/{slug}` that flat analysis misses.

---

## A4: Template Fingerprinting

### Problem

Determine if two HTML pages were generated from the same template. If yes,
extraction rules learned from one apply to all — skipping 2 LLM calls per
reused page.

### Alternatives Evaluated

| Alt  | Algorithm                   | Chosen?                         |
| ---- | --------------------------- | ------------------------------- |
| A4-a | SimHash on DOM Tag Sequence | **Primary** ✓                   |
| A4-b | CSS Class Set Jaccard       | Deferred (Tailwind breaks this) |
| A4-c | Tree Edit Distance          | Cluster verification only       |
| A4-d | Visual Fingerprint (pHash)  | Not used (needs browser)        |
| A4-e | Hybrid SimHash + CSS        | Deferred (LOW)                  |

### Implementation

**Class:** `TemplateFingerprinter` in `algorithms/template-fingerprinter.ts` (550 lines)

**Constructor:** `TemplateFingerprinter(config?: { stripTags, stripClassPatterns, maxDepth })`

**Algorithm:**

1. Parse HTML with cheerio
2. Guard: >5MB truncated, >50K DOM nodes → size-based fallback fingerprint
3. Normalize DOM: strip scripts/styles/noscript/iframe/svg, strip ad/cookie/
   banner elements by class pattern regex
4. Depth-first pre-order walk → extract ordered tag-path sequence
   (e.g., `html>body>div>main>h1`), max depth 15, max 10,000 paths
5. Compute 64-bit SimHash using FNV-1a hashing over tag-path features
6. Compare: **Hamming distance ≤ 3 = same template**

**Key Constants:**

```
FNV_OFFSET_BASIS = 14695981039346656037n
FNV_PRIME        = 1099511628211n
SAME_TEMPLATE_THRESHOLD = 3  (Hamming distance)
MAX_TAG_PATH_DEPTH = 15
MAX_HTML_SIZE = 5MB
MAX_TAG_PATHS = 10,000
MAX_DOM_NODES = 50,000
```

**Static methods:** `hammingDistance()`, `simhash()`, `fnv1a64()`,
`toSerializable()`, `fromSerializable()`

**Clustering:** Single-linkage clustering with Hamming threshold. Centroid =
member with minimum total Hamming distance to all others.

### Key Decision

Sliding-window TTL on handler entries (in `HandlerReuser`). Frequently-matched
templates stay alive as long as they are actively reused.

---

## A5: Pagination Discovery

### Problem

Detect how a listing page paginates and how many pages exist. Required for
complete URL discovery.

### Alternatives Evaluated

| Alt  | Algorithm              | Chosen?         |
| ---- | ---------------------- | --------------- |
| A5-a | Link Pattern Detection | **Primary** ✓   |
| A5-b | Binary Search Probe    | Deferred        |
| A5-c | API Interception       | Deferred        |
| A5-d | Item Count Text        | **Secondary** ✓ |
| A5-e | LLM Page Analysis      | Not used        |

### Implementation

**Class:** `PaginationDetector` in `algorithms/pagination-detector.ts` (491 lines)

**Constructor:** `PaginationDetector(config?: { maxPages: 100 })`

**4 detection strategies + 1 enrichment step (priority order):**

1. `rel="next"` link tags — confidence 0.95 (W3C spec-defined)
2. Query parameter `?page=N` — confidence 0.85
3. Path segment `/page/N` — confidence 0.80 (WordPress-style)
4. DOM `.pagination` class with numbered links — confidence 0.70
5. Item count text ("Showing 1–20 of 342") — enrichment step that augments
   `totalPages` on the best candidate (not an independent detection strategy)

After detection, generates all page URLs, capped at maxPages (100).

**Overloads:** `detect(url, html, links)` and `detectWithDom($, url, links)`
(V7 cheerio optimization).

---

## A6: Link Relevance Scoring

### Problem

Given 50–200 outbound links and a user intent, decide which are worth
following. Pure BFS wastes 80%+ budget on irrelevant pages.

### Alternatives Evaluated

| Alt  | Algorithm            | Chosen?         |
| ---- | -------------------- | --------------- |
| A6-a | URL Pattern Match    | **Primary** ✓   |
| A6-b | Anchor Text TF-IDF   | Not used        |
| A6-c | Link Context Scoring | **Secondary** ✓ |
| A6-d | Batch LLM Scoring    | Deferred        |
| A6-e | HITS Hub/Authority   | Deferred        |

### Implementation

**Class:** `LinkScorer` in `algorithms/link-scorer.ts` (427 lines)

**Constructor:** `LinkScorer(config?: { relevanceThreshold: 0.4, urlGroups?: UrlGroup[] })`

**Composite score formula:**

```
score = 0.4 × patternMatch + 0.3 × structuralBonus + 0.3 × textRelevance
```

**Four scoring signals:**

1. **Pattern match (A6-a, weight 0.4):** Score URL against UrlClusterer groups.
   Match to known group: 0.6–1.0 (scaled by group popularity). No match: 0.2.
   No groups available: 0.5 (neutral).

2. **Structural context (A6-c, weight 0.3):** DOM position analysis via
   cheerio. Boosts: article/main (+0.8), section (+0.4). Penalties: nav (-0.8),
   footer (-0.6), aside (-0.4), header (-0.3). Normalized to [0, 1].

3. **Text relevance (weight 0.3):** Anchor text quality. Generic ("click here",
   "read more"): 0.2. 4+ words: 1.0. 2+ words: 0.7. 10+ chars: 0.5.

4. **Utility page penalty:** Hard-zero for: login, signin, signup, register,
   privacy, terms, contact, cookie, legal, logout, forgot-password,
   reset-password, unsubscribe, 404, 500. No scoring nuance — always 0.

**Overloads:** `scoreLinks()` and `scoreLinksWithDom()`.

---

## A7: Content Quality Gate

### Problem

After crawling, determine if extracted content is real or a thin shell (SPA
skeleton, cookie wall, login gate). This was the **#1 CRITICAL gap** — bad
content silently entered the search index. V6 shipped this first.

### Alternatives Evaluated

| Alt  | Algorithm                       | Chosen?    |
| ---- | ------------------------------- | ---------- |
| A7-a | Content Length Threshold        | Combined ✓ |
| A7-b | Boilerplate Ratio               | Combined ✓ |
| A7-c | Hidden Content Score            | Combined ✓ |
| A7-d | Cross-Page Variance             | Not used   |
| A7-e | Content Delta (HTTP vs browser) | Not used   |

### Implementation

**Class:** `QualityGate` in `algorithms/quality-gate.ts` (349 lines)

**Constructor:** `QualityGate(config?: { minContentLength: 500, maxBoilerplateRatio: 0.7, maxHiddenRatio: 0.5, blockThreshold: 0.3 })`

**Score formula (intentional LLD deviation — prevents empty pages scoring 0.6):**

```
contentGate = min(1.0, textLength / 1000)

score = 0.40 × contentGate
      + 0.35 × (1 - boilerplateRatio) × contentGate
      + 0.25 × (1 - hiddenRatio) × contentGate
```

**Boilerplate detection:** Text inside `nav, footer, aside,
[role="navigation"], [role="banner"], [role="contentinfo"]` as fraction of
total text.

**Hidden content detection:** Elements matching `[aria-hidden="true"],
[style*="display:none"], .sr-only, .visually-hidden` as fraction of total
elements.

**Quality buckets:**

- `score ≥ 0.7` → **rich**
- `0.3 ≤ score < 0.7` → **standard**
- `score < 0.3` → **thin** → `shouldBlock = true`

**Wired in worker:** Every page passes through the quality gate before
ingestion, regardless of fetch method (HTTP or Playwright).

### Key Decision

`contentGate` acts as a multiplier — an empty page (0 text) cannot be rescued
by low boilerplate ratio. This is an intentional deviation from the original
LLD spec.

---

## A8: Interactive Element Detection

### Problem

Detect content hidden behind JS interactions (accordions, tabs, modals, lazy
load). Determines if browser interaction is required.

### Alternatives Evaluated

| Alt  | Algorithm                | Chosen?                  |
| ---- | ------------------------ | ------------------------ |
| A8-a | CSS Selector Library     | **Primary** ✓            |
| A8-b | ARIA Role Analysis       | **Secondary** ✓          |
| A8-c | Event Listener Detection | Not used (needs browser) |
| A8-d | Visibility Delta         | Not used                 |

### Implementation

**Class:** `InteractiveDetector` in `algorithms/interactive-detector.ts` (181 lines)

**Constructor:** `InteractiveDetector(config?: { minConfidence: 0.5 })`

**Static CSS selector library (7 element types):**

| Type            | Confidence | Example Selectors                                                  |
| --------------- | ---------- | ------------------------------------------------------------------ |
| Accordion       | 0.9        | `[data-bs-toggle="collapse"]`, `.accordion`, `details:not([open])` |
| Tabs            | 0.9        | `[role="tab"]`, `[role="tabpanel"]`, `.nav-tabs`                   |
| Carousel        | 0.7        | `.carousel`, `.swiper`, `.slick-slide`                             |
| Lazy images     | 0.6        | `img[data-src]`, `img[loading="lazy"]`, `.lazyload`                |
| Infinite scroll | 0.8        | `[data-infinite-scroll]`, `.infinite-scroll-component`             |
| Modal           | 0.5        | `[role="dialog"]`, `.modal`, `[aria-modal="true"]`                 |
| Dropdown        | 0.4        | `[aria-haspopup="true"]`, `.dropdown-menu`                         |

**Result:** `needsPlaywright = max(confidence across detected types) > minConfidence`

Feeds into A11 (FailureScorer) as a signal. Does NOT independently change
routing — A11 makes the final decision.

### Key Decision

Replaced V1–V5 keyword search (searching for "accordion", "collapse", "tab" in
page text) with DOM selector matching. Eliminated false positives from content
that merely mentions these words.

---

## A9: Intent Decomposition

### Problem

Break "crawl all products and categories" into executable sub-intents with
different page types, extraction schemas, and strategies.

### Alternatives Evaluated

| Alt  | Algorithm                       | Chosen?          |
| ---- | ------------------------------- | ---------------- |
| A9-a | URL Group to Intent (bottom-up) | **Primary** ✓    |
| A9-b | LLM Plan Generation (top-down)  | Not used alone   |
| A9-c | Hybrid (top-down + validate)    | Part of approach |
| A9-d | Platform Template (shortcut)    | Deferred         |

### Implementation

**Class:** `IntentDecomposer` in `algorithms/intent-decomposer.ts` (462 lines)

**Constructor:** `IntentDecomposer(llmClient, config?: { maxUrls: 500, samplesPerCluster: 5, minClusterSize: 3, maxResponseTokens: 2000 })`

**Algorithm (exactly 1 LLM call):**

1. Pre-cluster sitemap URLs by first 2 path segments
2. If > 100 clusters, merge smallest into "/other"
3. Filter clusters < minClusterSize (3)
4. Build compact prompt with cluster summaries + sanitized intent (max 1000
   chars)
5. Single LLM call with JSON-only system prompt
6. Parse response: strip markdown fences, extract JSON
7. Validate: filter sub-intents where `urlPattern` doesn't match any actual URL
   (glob-to-regex conversion)
8. Calculate URL coverage percentage

**Returns:** `DecompositionResult { subIntents: SubIntent[], reasoning, coverage, llmCallCount: 1 }`

**`SubIntent`:** `{ intent, urlPattern, estimatedUrls, confidence, reasoning }`

### Key Decision

Bottom-up approach (A9-a) is primary. URL groups from A3 anchor the
decomposition in real site structure, preventing LLM hallucination of
sub-intents that don't match the actual site. `minClusterSize` changed from
LLD default of 2 to 3 (documented deviation — clusters of 2 are typically
one-off pages).

---

## A10: Sitemapless URL Discovery

### Problem

Find all relevant URLs when no sitemap.xml exists. A significant portion of
real sites lack sitemaps or have incomplete ones.

### Alternatives Evaluated & Chosen Approach

**5-step fallback chain (try in order, stop when sufficient):**

| Step | Algorithm                              | Chosen?  | When                      |
| ---- | -------------------------------------- | -------- | ------------------------- |
| 1    | A10-d: Platform API                    | ✓        | If A2 detected Shopify/WP |
| 2    | A10-f: Footer + HTML sitemap mining    | ✓        | Always                    |
| 3    | A10-b: Navigation-first BFS            | ✓        | Always                    |
| 4    | A10-c: CDX Bootstrap (Wayback Machine) | ✓        | Optional, 10s timeout     |
| 5    | Entry page links                       | ✓        | Fallback                  |
| —    | A10-a: Full BFS                        | Deferred | Last resort, high cost    |
| —    | A10-e: Site Search Exploitation        | Not used | Ethical concerns          |

### Implementation

**Class:** `DiscoveryChain` in `algorithms/discovery-chain.ts` (527 lines)

**Constructor:** `DiscoveryChain(adapter: HttpAdapter, config?: { minUrls: 20, maxUrls: 5000, stepTimeout: 10000, enableCdx: true, cdxTimeout: 10000 })`

**Step details:**

**Step 1 — Platform API:**
Uses `PlatformDetector` API endpoints. Supports:

- Shopify: `GET /products.json` → `{ products: [{ handle }] }` → `/products/{handle}`
- WordPress: `GET /wp-json/wp/v2/posts` → `[{ link }]`
- Generic: looks for `link`, `url`, `href` fields in JSON responses

**Step 2 — Footer mining:**

- Extract `<footer>` links (same hostname)
- Probe common paths: `/site-map`, `/sitemap`, `/all-products`, `/pages`

**Step 3 — Nav-BFS:**

- Extract `<nav>` links
- Follow up to 10 section pages
- Collect same-hostname links from each

**Step 4 — CDX Bootstrap:**

- Query: `https://web.archive.org/cdx/search/cdx?url={hostname}/*&output=json&collapse=urlkey&limit=500`
- Parse JSON array, extract original URLs (index 2 from each row)
- 10-second timeout, non-blocking (failure does not halt chain)

**Step 5 — Entry page links:**
All same-hostname `<a href>` links from homepage (broadest fallback).

**Early stopping:** Once `minUrls` (20) reached, remaining steps skipped.
Shopify API can return 1000+ URLs — no need for nav-BFS after that.

**Returns:** `DiscoveryResult { urls[], primaryMethod, steps: DiscoveryStep[], totalTime }`

Each step includes `{ name, urlsFound, duration, error? }` for audit trail.

---

## A11: Escalation Prediction

### Problem

Before crawling, predict if a URL needs browser rendering or if HTTP is
sufficient. Avoids wasting Playwright cost (10–50x slower) on static pages.

### Alternatives Evaluated

| Alt   | Algorithm             | Chosen?                             |
| ----- | --------------------- | ----------------------------------- |
| A11-a | Site-Level Rule       | Not used                            |
| A11-b | Per-Group Prediction  | **Primary** ✓ (pre-crawl sampling)  |
| A11-c | Multi-Signal Score    | Part of approach                    |
| A11-d | Post-Crawl Escalation | **Secondary** ✓ (safety net via A7) |

### Implementation

**Class:** `FailureScorer` in `algorithms/failure-scorer.ts` (506 lines)

**Constructor:** `FailureScorer(config?: { escalationThreshold: 50, weights?: Partial<...> })`

**Scoring (0–100 scale):**

**Positive signals (need escalation):**

| Signal              | Weight | Condition                                        |
| ------------------- | ------ | ------------------------------------------------ |
| `short_text`        | 25     | Text < 200 chars                                 |
| `empty_mount_point` | 30     | `div#root/#app/__next` with innerHTML < 50 chars |
| `no_links`          | 15     | Zero links                                       |
| `high_markup_ratio` | 15     | HTML/text ratio > 50:1                           |
| `noscript_content`  | 10     | `<noscript>` text > 50 chars                     |
| `framework_marker`  | 10     | `__NEXT_DATA__`, `__NUXT__`, or `__GATSBY`       |

**Anti-signals (no escalation):**

| Signal             | Weight | Condition                                                                          |
| ------------------ | ------ | ---------------------------------------------------------------------------------- |
| `ssr_next_data`    | -20    | `__NEXT_DATA__` + text > 500 chars                                                 |
| `ssr_content_rich` | -15    | Text > 1000 chars + links > 5                                                      |
| `structured_data`  | -10    | JSON-LD present                                                                    |
| `meta_generator`   | -10    | Known generator meta (next.js, gatsby, hugo, jekyll, nuxt, wordpress, ghost, etc.) |

**Decision:** `shouldEscalate = score ≥ 50`

**Worker integration:** Two modes:

1. **Pre-crawl sampling:** Sample 3 pages per URL group, score each, assign
   group strategy (http/playwright).
2. **Per-page fallback:** When no group strategy exists, HTTP-first then
   FailureScorer. If score ≥ 50, escalate to Playwright for that page.

### Key Decision

Anti-signals prevent over-escalation of SSR frameworks. Next.js, Nuxt, etc.
look like SPAs in HTML markers but have real content when server-rendered.

---

## A12: Template Learning

### Problem

Given 847 product pages sharing one template, avoid running the full 4-phase
LLM loop on each. Learn extraction rules from a sample, apply mechanically to
the rest.

### Alternatives & Layered Approach

```
Layer 1: A12-e JSON-LD Shortcut  → 0 LLM calls (if structured data exists)
Layer 2: A4 + A12-d Fingerprint + Handler Reuse → 0 LLM calls (template match)
Layer 3: Full intelligence loop  → 2–4 LLM calls (first page per template)
```

### Implementation — Layer 1: JSON-LD Extractor

**Class:** `JsonLdExtractor` in `algorithms/jsonld-extractor.ts` (251 lines)

**Constructor:** `JsonLdExtractor(config?: { minFieldsForSkip: 3, targetTypes: ['Product', 'Article', 'Recipe', 'Event', 'FAQPage', 'HowTo'] })`

**Algorithm:**

1. Parse all `<script type="application/ld+json">` blocks
2. Handle arrays and `@graph` structures recursively
3. Select primary type by specificity score:
   - Product/Article/Recipe: 10
   - Event/FAQPage/HowTo: 9
   - WebSite/WebPage: 2
   - Organization/BreadcrumbList: 1
4. Extract fields per type from predefined field maps
5. `canSkipLlm = isTargetType && fieldCount ≥ 3`
6. Confidence = fieldCount / maxFieldsForType (capped at 1.0)

**Field maps:**
| Type | Fields |
|------|--------|
| Product | name, price, description, image, sku, brand |
| Article | headline, author, datePublished, description |
| Recipe | name, ingredients, instructions |
| Event | name, startDate, location, description |
| FAQPage | mainEntity |
| HowTo | name, step |

### Implementation — Layer 2: Handler Reuser

**Class:** `HandlerReuser` in `algorithms/handler-reuser.ts` (489 lines)

**Constructor:** `HandlerReuser(fingerprinter: TemplateFingerprinter, config?: { maxLibrarySize: 1000, ttl: 3600000 })`

**Algorithm:**

1. **Register:** Store handler keyed by templateId (hex prefix of fingerprint).
   Evict expired entries first, then LRU if full.
2. **Match:** Fingerprint incoming HTML, iterate non-expired entries, find best
   match with Hamming distance ≤ 3. Update `lastAccessedAt` on hit (sliding
   TTL).
3. **Reuse:** On match, skip Phase 2 (UNDERSTAND) and Phase 3 (BUILD HANDLER) →
   saves 2 LLM calls per reused page.

**Bounded collection (CLAUDE.md compliant):**

- Max size: 1,000 entries
- TTL: 1 hour (sliding window on `lastAccessedAt`)
- Eviction: expired first, then LRU

**Quality measurement:** `measureQuality(extracted, expected)`:

```
quality = 0.4 × completeness + 0.6 × accuracy
completeness = fraction of expected fields present
accuracy = 0.3 × titleMatch + 0.7 × bodyJaccard
```

### Worker Integration

In the per-page loop, the extraction path follows this priority:

```
1. JSON-LD available + canSkipLlm?     → JSON-LD path (0 LLM)
2. HandlerReuser.tryReuse(html) match?  → Reuse path (0 LLM)
3. LLM budget remaining?               → Full loop (2–4 LLM)
4. Budget exhausted?                    → Skip
```

### Cost Model (847 products, 2 templates)

| Step                             | LLM Calls  | HTTP Calls |
| -------------------------------- | ---------- | ---------- |
| Fingerprint all pages            | 0          | 847        |
| Cluster into 2 groups            | 0          | 0          |
| First page per group (full loop) | 4–8        | 0          |
| Handler reuse (remaining)        | 0          | 0          |
| JSON-LD shortcut (subset)        | 0          | 0          |
| Outlier fallback (~10)           | ~10        | 0          |
| **Total**                        | **~14–18** | **847**    |
| vs. Naive (1 LLM/page)           | **847**    | **847**    |

**~98% reduction in LLM calls.**

---

## Shared Infrastructure

### HttpAdapter (SSRF-Protected HTTP)

**Class:** `HttpAdapter` in `algorithms/http-adapter.ts` (368 lines)

**Constructor:** `HttpAdapter(config?: { timeout: 15000, userAgent: 'ABL-Crawler/1.0', maxRedirects: 5, maxContentLength: 10MB, allowPrivateIPs: false })`

**SSRF protection flow:**

1. If hostname is an IP → check directly
2. Otherwise → `dns.promises.lookup()` → check resolved IP
3. Reject private/loopback: 127.x, 10.x, 192.168.x, 172.16–31.x, 169.254.x,
   100.64–127.x, 0.0.0.0, ::1, fc/fd00::, fe80::, ::ffff: mapped
4. Use resolved IP for actual request (prevents DNS rebinding TOCTOU)

**HTML parsing:** cheerio-based. Extracts title, text (strips scripts/styles),
links (resolved to absolute), metadata (meta tags).

### Shared Types

**File:** `algorithms/types.ts`

`CrawlResult` mirrors the Go struct exactly:

```typescript
{ url, statusCode, title, html, text, links: CrawlResultLink[],
  metadata: Record<string,string>, crawledAt, duration, success,
  error?, contentLength, contentType, depth }
```

`CrawlResultLink`: `{ text, href, title?, rel?, target? }`

### Design Patterns Across All Algorithms

1. **Config-with-defaults:** Every class takes `Partial<Config>`, merges with
   `DEFAULT_CONFIG`
2. **Cheerio DOM sharing:** Most classes offer `method(html)` and
   `methodWithDom($)` variants to avoid redundant HTML parsing
3. **Signal-based scoring:** platform-detector, link-scorer, quality-gate,
   failure-scorer all use named signal arrays aggregated into composite scores
4. **Zero LLM by default:** 13 of 14 files are pure heuristic
5. **Bounded in-memory structures:** handler-reuser: max 1000, TTL 1hr, LRU

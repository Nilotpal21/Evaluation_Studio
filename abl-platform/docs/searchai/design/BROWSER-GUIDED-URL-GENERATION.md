# Browser-Guided URL Generation — Algorithm Design

> **Purpose:** Generic algorithm for using browser-based discovery to understand
> site structure and generate complete URL sets, rather than exhaustively clicking
> every element on every page.
>
> **Date:** 2026-04-21
>
> **Status:** Brainstorm — 4 competing approaches evaluated, recommendation at end

---

## Table of Contents

1. [Problem Statement](#1-problem-statement)
2. [Root Cause Analysis](#2-root-cause-analysis)
3. [Design Constraints](#3-design-constraints)
4. [Approach A: Structure-First Discovery](#4-approach-a-structure-first-discovery)
5. [Approach B: Schema-Guided Crawl](#5-approach-b-schema-guided-crawl)
6. [Approach C: API-First with Browser Fallback](#6-approach-c-api-first-with-browser-fallback)
7. [Approach D: Adaptive Multi-Signal Discovery](#7-approach-d-adaptive-multi-signal-discovery)
8. [Comparative Evaluation](#8-comparative-evaluation)
9. [Recommendation](#9-recommendation)
10. [Algorithm Specification](#10-algorithm-specification)
11. [What Changes in the Current System](#11-what-changes-in-the-current-system)

---

## 1. Problem Statement

The browser discovery component (navigation-explorer.ts) uses Playwright to
render pages, click expandable elements, and extract links. It fails on real
sites for three compounding reasons:

**P1: Single linkFilter is too narrow.** The user provides sample URLs like
`/Support/Printers/...`. We derive a regex and discard all links at other paths
(like `/faq/{}`). The filter throws away structurally related content.

**P2: DFS with DOM-order wastes click budget.** Nav menus at the top of the DOM
consume 300 clicks before content-area expandables are reached. The algorithm
treats all expandable elements as equally valuable.

**P3: No structural generalization.** The browser sees a category tree
(Printers > Inkjet > EcoTank > Model X) but does not understand it is a
category-to-product hierarchy. It cannot generalize "I explored one path through
the tree, so I know all paths exist."

The result on epson.com: 300 clicks, 241 links found, 0 useful links after
filtering. The HTTP crawler — which cannot see JS-rendered content — found
more useful pages.

---

## 2. Root Cause Analysis

The fundamental issue is a **category error in goals**. The current algorithm
treats browser discovery as "link harvesting" — click things, collect hrefs.
But the real goal is **structure discovery** — understand how the site organizes
its content, then derive the complete URL set from that understanding.

The difference:

| Link Harvesting (current)  | Structure Discovery (needed)             |
| -------------------------- | ---------------------------------------- |
| Click all expandables      | Click enough to understand the pattern   |
| Collect every href         | Collect the category vocabulary          |
| Filter by URL regex        | Score by structural position             |
| More clicks = more results | Fewer, smarter clicks = complete results |

**Analogy:** You do not read every page of a phone book to find all dentists.
You read the table of contents to understand the organization, look up "D" for
Dentists, then read that section. The current algorithm reads every page.

### Why the current system fails per-site

**Epson (cascading dropdowns, 1000+ products):**

- Hub page has 3-level dropdown: Type > Series > Model
- Clicking "Type" reveals 8 types. Clicking a type reveals 5-15 series.
  Clicking a series reveals 3-30 models. Each model links to a support page.
- Current algorithm: clicks 300 things in DOM order (nav menu first), exhausts
  budget before reaching content dropdowns
- Needed: click each dropdown once per level, extract the vocabulary (8 types,
  ~50 series, ~1000 models), generate URLs from the cross product

**Stripe docs (sidebar nav, 500 pages):**

- All pages are at /docs/\*, sidebar has hierarchical sections
- HTTP crawler can find most of these (static links)
- Browser needed only for collapsed sidebar sections
- Current algorithm works partially but wastes clicks on non-sidebar expandables

**FAQ site with accordions (10 categories x 20 questions):**

- All Q&A on one page behind accordion folds
- Links inside accordions point to individual FAQ pages
- Current algorithm works here because all content is on one page
- But linkFilter discards FAQ links that do not match sample URL pattern

**University site (departments > faculty > publications):**

- Multi-level hierarchy, often mix of static and JS pages
- Department listing is static, faculty listing may be JS-filtered
- Publications are often behind a search/filter widget
- Current algorithm has no concept of "this is a filter widget vs. nav tree"

**E-commerce (category > subcategory > product):**

- Very similar to Epson but with pagination
- Category pages have 50+ products, paginated across 20 pages
- Current algorithm does not understand pagination
- API interception helps here but is not connected to URL generation

---

## 3. Design Constraints

These are non-negotiable for any approach:

1. **Generic** — must work on arbitrary sites without site-specific rules
2. **Budget-bounded** — limited browser clicks (configurable, default 300)
3. **User-guided but not user-dependent** — sample URLs help but should not be
   the only signal
4. **Correct** — never generate URLs that do not exist (no 404 inventory)
5. **Progressive** — report useful results incrementally, not all-or-nothing
6. **Composable** — must integrate with existing HTTP crawler, API interceptor,
   and pattern matcher
7. **No LLM** — algorithm must be deterministic and fast (LLM optional for
   labeling, not for structure detection)

---

## 4. Approach A: Structure-First Discovery

### Core Idea

Instead of harvesting links, discover the **site's information architecture**
first, then enumerate URLs from it. The browser's job is to build a structural
model of the page, not to collect hrefs.

### Algorithm

```
PHASE 1: PAGE ANALYSIS (0 clicks, ~2 seconds)
  1. Render page with Playwright
  2. Build a "semantic DOM" — annotate each element with:
     - role (nav, content, sidebar, footer, header, form, widget)
     - interactivity type (expandable, dropdown, tab, pagination, filter, link)
     - estimated content cardinality (how many items does this section have?)
     - structural depth (how nested is this in the page hierarchy?)
  3. Identify "content regions" vs "chrome regions"
     - Chrome: nav bars, footers, headers, breadcrumbs (shared across pages)
     - Content: main area, article bodies, product listings, FAQ sections

PHASE 2: INTERACTION PLANNING (0 clicks, ~100ms)
  4. For each interactive element in content regions, classify:
     - VOCABULARY_SOURCE: reveals a list of categories/items (dropdowns, facets)
     - CONTENT_REVEALER: reveals hidden content (accordions, tabs)
     - PAGINATION: loads more of the same (next page, load more, infinite scroll)
     - NAVIGATION: takes you to another page (links, buttons)
     - FILTER: narrows existing content (search, date pickers)
  5. Build a click plan:
     - VOCABULARY_SOURCEs first (highest value per click)
     - CONTENT_REVEALERs second (if content region has them)
     - PAGINATION last (handled by fan-out)
     - Skip chrome regions entirely

PHASE 3: VOCABULARY EXTRACTION (N clicks, where N = tree depth x branching)
  6. For each VOCABULARY_SOURCE (e.g., cascading dropdown):
     a. Click to open the first level → extract all option labels
     b. For EACH option at this level, click it → extract labels at next level
     c. Repeat until leaf level (where options become links to actual pages)
  7. Record the full vocabulary tree:
     {
       "Type": ["Inkjet", "Laser", "All-In-One", ...],
       "Series": { "Inkjet": ["EcoTank", "WorkForce", ...], ... },
       "Model": { "EcoTank": ["ET-2400", "ET-2800", ...], ... }
     }

PHASE 4: URL TEMPLATE DISCOVERY (1-3 clicks to leaf pages)
  8. Navigate one complete path through the tree to a leaf page
  9. Extract the URL pattern from the leaf page URL
  10. Cross-reference with sample URLs to validate template
  11. Derive the URL template:
      /Support/Printers/{type}/{series}/{model}/s/SPT_{sku}

PHASE 5: URL GENERATION (0 clicks)
  12. For each leaf in the vocabulary tree:
      - Substitute into URL template
      - OR: the leaf itself is an <a href> — use the href directly
  13. Validate a random sample (HTTP HEAD, check for 200)
  14. Report: "Found 1,247 product support pages across 8 types"

PHASE 6: CONTENT REVEALER EXPANSION (remaining click budget)
  15. If click budget remains, expand CONTENT_REVEALERs to find
      additional link patterns (FAQ links, related content)
  16. For each new pattern found, repeat Phase 4-5
```

### Click Budget Analysis for Test Sites

| Site                       | Phase 3 Clicks                | Phase 4 Clicks | Phase 6 Clicks   | Total | URLs Found |
| -------------------------- | ----------------------------- | -------------- | ---------------- | ----- | ---------- |
| Epson (1000+ products)     | ~80 (8 types x 10 series avg) | 3              | ~50              | ~133  | ~1000      |
| Stripe docs (500 pages)    | ~20 (sidebar sections)        | 2              | ~30              | ~52   | ~500       |
| FAQ site (200 Q&A)         | ~10 (categories)              | 1              | ~30 (accordions) | ~41   | ~200       |
| University (depts/faculty) | ~15 (departments)             | 2              | ~30              | ~47   | varies     |
| E-commerce (paginated)     | ~40 (categories)              | 2              | ~20              | ~62   | ~1000+     |

### Strengths

- Extremely click-efficient (vocabulary extraction is multiplicative)
- Produces a structural model that humans can verify ("we found 8 printer types")
- Works well for hierarchical sites (most sites)
- Natural stopping criterion (vocabulary fully enumerated)

### Weaknesses

- Relies heavily on correct classification of interactive elements
- "Semantic DOM" annotation is hard — what is a VOCABULARY_SOURCE vs a FILTER?
- Cascading dropdowns where option selection triggers async loads are tricky
  to distinguish from simple show/hide
- Does not work for flat sites with no hierarchy (e.g., a single page with
  300 links in a grid)
- URL template derivation assumes URLs are predictable from vocabulary — fails
  for sites where URLs contain opaque IDs (SKU codes not derivable from names)

### Critical Risk: Opaque IDs

Epson URLs contain SKU codes like `SPT_C11CL65201` that are not derivable from
the product name "Epson ET-1913". The vocabulary tree gives you product names,
but you cannot construct the URL without the SKU.

**Mitigation:** At the leaf level of the vocabulary tree, the option is usually
an `<a>` tag or triggers a page load that produces a URL. The algorithm does not
need to _construct_ URLs — it needs to _collect_ the hrefs at the leaf level.
Phase 5 step 12 handles this: "the leaf itself is an `<a href>` — use the href
directly."

---

## 5. Approach B: Schema-Guided Crawl

### Core Idea

Use structured data already embedded in the page (JSON-LD, OpenGraph, meta tags,
breadcrumbs, sitemaps referenced in HTML) to understand the site's content model.
The browser is used to render pages that need JS, but the intelligence comes from
reading the page's own metadata.

### Algorithm

```
PHASE 1: METADATA HARVEST (1 page render, 0 clicks)
  1. Render the seed page with Playwright
  2. Extract all structured data:
     - JSON-LD (@type, name, url, breadcrumbList, itemListElement)
     - OpenGraph tags (og:type, og:url)
     - <meta> tags (description, keywords)
     - <link rel="canonical">, <link rel="alternate">
     - Breadcrumb trails (both HTML and JSON-LD)
     - <nav> landmarks with <a> links
     - Internal sitemaps referenced in HTML or <link>
  3. From breadcrumbs, derive the site hierarchy:
     Home > Support > Printers > All-In-Ones > ET Series > Model
     → 6 levels, current page is at level 6
  4. From JSON-LD, identify the content type:
     @type: "Product" → this is a product page
     @type: "FAQPage" → this is an FAQ
     @type: "BreadcrumbList" → navigate up to find category pages

PHASE 2: HIERARCHY TRAVERSAL (N page renders, 0 clicks per page)
  5. From the breadcrumb, navigate UP to parent pages:
     /Support/Printers/All-In-Ones/ → render → extract all links in content region
  6. At each parent level:
     - Extract links that point to child pages (matching the URL depth pattern)
     - Extract structured data (JSON-LD with itemListElement = full catalog!)
     - If JSON-LD contains an ItemList → catalog is DONE for this level
  7. Continue up to the highest useful level (stop at site root or when
     links become cross-cutting navigation)

PHASE 3: LATERAL ENUMERATION (N page renders for sibling categories)
  8. At each category level, follow links to sibling categories:
     All-In-Ones is one type. Links to "Single-Function", "Wide-Format", etc.
  9. For each sibling category page:
     - Extract child links
     - If JSON-LD has ItemList → catalog for this category is done
     - If not → need browser click-through (fall back to Approach A for this branch)

PHASE 4: VALIDATION
  10. For generated URLs, HEAD-check a sample
  11. Report with confidence levels based on data source:
      - JSON-LD catalog: HIGH confidence (authoritative)
      - Breadcrumb-derived: MEDIUM (structure confirmed, URLs from links)
      - Click-derived: LOWER (structure inferred, URLs from DOM)
```

### Click Budget Analysis

| Site        | Pages Rendered       | Clicks           | URLs Found | Notes                                 |
| ----------- | -------------------- | ---------------- | ---------- | ------------------------------------- |
| Epson       | ~15 (category pages) | 0-20             | ~1000      | Depends on JSON-LD presence           |
| Stripe docs | ~5 (section roots)   | 0                | ~500       | Stripe has great structured data      |
| FAQ site    | ~1                   | ~10 (accordions) | ~200       | FAQ pages often have FAQPage JSON-LD  |
| University  | ~10 (dept pages)     | ~20              | varies     | Universities rarely have good JSON-LD |
| E-commerce  | ~10 (category pages) | 0                | ~1000+     | E-commerce has excellent JSON-LD      |

### Strengths

- Zero-click discovery when structured data is present
- Uses the site's own understanding of its content (most authoritative source)
- Works exceptionally well for e-commerce (Product schema is universal)
- Breadcrumb traversal is simple and robust

### Weaknesses

- **Fatal flaw: many sites lack structured data.** JSON-LD adoption is ~40% of
  the web overall, but much lower for support sites, university sites, internal
  tools
- Epson's support hub has minimal JSON-LD — the product catalog is behind JS
  dropdowns, not in page metadata
- Falls back to "render parent pages and extract links" which is just HTTP
  crawling with extra steps
- Breadcrumb traversal assumes breadcrumbs accurately reflect the hierarchy
  (often they do not — some sites have decorative breadcrumbs)

### When This Approach Wins

Sites where it excels: e-commerce (Shopify, WooCommerce), recipe sites,
news sites, any site optimized for Google rich results. These sites WANT
to be crawled and provide excellent structured data.

Sites where it fails: internal corporate sites, support portals, government
sites, university sites, forums — exactly the sites that need browser discovery
the most.

---

## 6. Approach C: API-First with Browser Fallback

### Core Idea

The most efficient way to enumerate a site's content is to find its data API
and query it directly. Most modern sites (even "static" ones) have a backend
API that the frontend calls. The browser's job is to trigger enough interactions
to reveal the API endpoints, then we switch to direct API calls.

### Algorithm

```
PHASE 1: API DISCOVERY (render + minimal clicks)
  1. Render page with Playwright, API interceptor attached
  2. Click the first level of interactive elements in content regions
  3. Observe API calls triggered by interactions:
     - GET /api/products?type=inkjet → product listing endpoint
     - GET /api/categories → category tree endpoint
     - POST /api/search with body {filters: ...} → search endpoint
  4. Classify discovered APIs:
     - CATALOG: returns a list of items (most valuable)
     - DETAIL: returns a single item's detail
     - SEARCH: accepts query/filter params, returns matching items
     - TREE: returns a hierarchical structure (category tree)

PHASE 2: CATALOG EXHAUSTION (0 browser clicks, N API calls)
  5. For each CATALOG/TREE API:
     a. Call it with broadest possible params (no filters)
     b. If paginated, follow pagination to get all items
     c. Extract URLs from response items (url, href, slug, permalink fields)
  6. For SEARCH APIs:
     a. Try empty-query search (some APIs return all results)
     b. If that fails, use vocabulary from Phase 1 clicks as search terms
  7. The API response often contains the canonical URL for each item:
     { "name": "ET-2400", "url": "/Support/Printers/.../ET-2400/s/SPT_..." }
     → No URL construction needed — the API gives you the URL

PHASE 3: COVERAGE VALIDATION
  8. Compare API-derived URLs against sample URLs
  9. If samples are not covered → the API does not serve this content type
     → fall back to Approach A (structure-first) for uncovered patterns
  10. HEAD-check a sample of API-derived URLs

PHASE 4: GAP FILLING (remaining click budget)
  11. For content types not covered by APIs:
     - Use remaining browser budget for targeted expansion
     - Focus on content regions that triggered no API calls
     - These are likely static HTML (no JS rendering needed)
```

### Click Budget Analysis

| Site        | API Discovery Clicks        | API Calls               | Browser Fallback | Total Clicks | URLs Found |
| ----------- | --------------------------- | ----------------------- | ---------------- | ------------ | ---------- |
| Epson       | ~15 (trigger dropdown APIs) | ~20 (paginate catalog)  | ~30 (FAQ links)  | ~45          | ~1000      |
| Stripe docs | ~5                          | ~3 (docs API)           | 0                | ~5           | ~500       |
| FAQ site    | ~5                          | ~2 (if API exists)      | ~20 (accordions) | ~25          | ~200       |
| University  | ~10                         | ~5                      | ~40              | ~50          | varies     |
| E-commerce  | ~10                         | ~30 (paginate products) | 0                | ~10          | ~1000+     |

### Strengths

- When an API exists, this is the most complete and efficient approach
- APIs return structured data — no HTML parsing, no DOM ambiguity
- APIs often include metadata (titles, descriptions) alongside URLs
- Pagination handling is trivial with API calls vs. browser pagination
- Already partially implemented (api-interceptor.ts exists)

### Weaknesses

- Many sites do not have discoverable APIs (static sites, SSR without client-side
  data fetching)
- API responses may require authentication or CORS restrictions may block
  direct calls
- The API discovered during browser interaction may not be callable from our
  server (CORS, cookies, CSRF tokens)
- Figuring out how to call the API with "broadest params" is non-trivial —
  what query returns all products vs. just the current category?
- API response format varies wildly — extracting URLs from arbitrary JSON
  requires heuristics

### Critical Risk: Non-Replayable APIs

The API interceptor captures calls the browser makes. But calling those APIs
from our server (not the browser) may fail because:

- CORS blocks cross-origin requests
- The API requires session cookies set by the page
- CSRF tokens are embedded in the page and validated server-side

**Mitigation:** Use the browser itself to make the API calls (via
`page.evaluate(fetch(...))`) rather than calling from our server. This preserves
cookies, CORS context, and CSRF tokens. The browser becomes an API client proxy.

---

## 7. Approach D: Adaptive Multi-Signal Discovery

### Core Idea

Do not commit to a single strategy. Instead, run a fast "probe" phase that
detects which signals are available on this specific site, then dynamically
compose the best strategy from available signals.

This is not just "try everything" — it is a decision tree that spends the
minimum budget to determine the site's architecture, then allocates the remaining
budget to the most productive discovery method.

### Algorithm

```
PHASE 1: SITE PROBE (1 render + ~10 clicks, ~5 seconds)
  ┌─────────────────────────────────────────────────────┐
  │ PARALLEL EXTRACTION (zero clicks):                   │
  │                                                      │
  │ Signal 1: Structured Data                            │
  │   - JSON-LD, OpenGraph, meta, breadcrumbs            │
  │   - Result: schema_richness score (0-1)              │
  │                                                      │
  │ Signal 2: Navigation Structure                       │
  │   - <nav> landmarks, sidebar, header nav             │
  │   - Count expandable elements by region              │
  │   - Result: nav_structure classification             │
  │     (flat / hierarchical / mega-menu / sidebar)      │
  │                                                      │
  │ Signal 3: Content Region Analysis                    │
  │   - Identify main content area                       │
  │   - Classify interactive elements in content region  │
  │   - Result: content_interactivity profile            │
  │     (static / accordion / dropdown / tabs / widget)  │
  │                                                      │
  │ Signal 4: URL Pattern Analysis                       │
  │   - All visible <a href> links on the page           │
  │   - Cluster by URL structure                         │
  │   - Result: url_clusters with cardinality estimates  │
  │                                                      │
  │ Signal 5: Page Metadata                              │
  │   - Sitemap references, robots.txt hints             │
  │   - Pagination indicators (page 1 of N, "next" link) │
  │   - Result: pagination_model, sitemap_coverage       │
  └─────────────────────────────────────────────────────┘

  ┌─────────────────────────────────────────────────────┐
  │ TARGETED CLICKS (~10 clicks):                        │
  │                                                      │
  │ Click the first expandable in EACH content region    │
  │ (not all expandables — just one per region)          │
  │                                                      │
  │ Signal 6: API Interception                           │
  │   - Did the clicks trigger API calls?                │
  │   - Result: api_available (boolean), api_patterns    │
  │                                                      │
  │ Signal 7: Expansion Behavior                         │
  │   - Did clicks reveal: a list? sub-expandables?      │
  │     new page content? nothing?                       │
  │   - Result: expansion_type per region                │
  │     (vocabulary / content / navigation / dead)       │
  └─────────────────────────────────────────────────────┘

PHASE 2: STRATEGY SELECTION (0 clicks, ~10ms)

  The probe yields a SITE PROFILE with 7 signals. A decision function
  selects the optimal strategy:

  IF api_available AND api_patterns.hasCatalog:
    → PRIMARY: API Exhaustion (Approach C)
    → FALLBACK: Structure Discovery for non-API content

  ELSE IF schema_richness > 0.6:
    → PRIMARY: Schema-Guided Crawl (Approach B)
    → FALLBACK: Structure Discovery for pages without schema

  ELSE IF content_interactivity is (dropdown OR accordion) AND
          expansion_type is vocabulary:
    → PRIMARY: Structure-First Discovery (Approach A)
    → FALLBACK: HTTP fan-out for leaf pages

  ELSE IF nav_structure is hierarchical OR sidebar:
    → PRIMARY: Navigate sidebar/nav tree (modified Approach A)
    → FALLBACK: HTTP crawl from discovered section roots

  ELSE:
    → PRIMARY: Smart Click Budget (improved current approach)
    → Use content-region prioritization to avoid wasting clicks on chrome

PHASE 3: EXECUTE PRIMARY STRATEGY (bulk of click budget)
  Run the selected strategy. Each strategy has its own click budget
  allocation and stopping criteria.

PHASE 4: FALLBACK / GAP FILL (remaining budget)
  If primary strategy missed content types that samples indicate exist:
  - Run the fallback strategy
  - Focus only on the gap (do not re-discover already-found URLs)

PHASE 5: MERGE AND REPORT
  Combine URLs from all strategies. For each URL:
  - Source (API, schema, vocabulary tree, link harvest)
  - Confidence (HIGH = API/schema, MEDIUM = structure, LOW = harvest)
  - Pattern match score against user samples
  Group into sections. Report with transparency about which strategy
  was used and why.
```

### Decision Tree Visualization

```
                          SITE PROBE
                              │
                    ┌─────────┴─────────┐
                    │                   │
              API Available?      Schema Rich?
                    │                   │
               ┌────┴────┐         ┌───┴───┐
               │         │         │       │
              Yes        No      >0.6    <0.6
               │         │         │       │
        API Exhaust.     │    Schema     Content
                         │    Guided    Interactive?
                         │               │
                    ┌────┴────────┐  ┌───┴───┐
                    │             │  │       │
              Vocab Source?   Nav Tree? │    │
                    │             │  Yes     No
                   Yes           Yes │       │
                    │             │  │    Smart Click
              Structure      Sidebar  │    Budget
              First          Traverse │
                                 Structure
                                 First
```

### Click Budget Analysis

| Site        | Probe Clicks | Strategy Selected                   | Strategy Clicks | Total | URLs Found |
| ----------- | ------------ | ----------------------------------- | --------------- | ----- | ---------- |
| Epson       | 10           | API Exhaust (dropdown triggers API) | 35              | 45    | ~1000      |
| Stripe docs | 5            | Schema-Guided (rich JSON-LD)        | 10              | 15    | ~500       |
| FAQ site    | 8            | Structure-First (accordions)        | 30              | 38    | ~200       |
| University  | 10           | Sidebar Traverse                    | 40              | 50    | varies     |
| E-commerce  | 8            | API Exhaust (product API)           | 15              | 23    | ~1000+     |

### Strengths

- Adapts to the site rather than forcing one strategy
- Probe phase is cheap (10 clicks) and highly informative
- Falls back gracefully when primary strategy misses content
- Transparent — can tell the user "We detected an API and used it" or
  "No API found, exploring the navigation tree"

### Weaknesses

- Most complex to implement
- The strategy selection decision function needs tuning
- Probe phase may misclassify site characteristics
- Combining results from multiple strategies requires deduplication

---

## 8. Comparative Evaluation

### Against Test Sites

| Site              | A: Structure-First                          | B: Schema-Guided                     | C: API-First                      | D: Adaptive                             |
| ----------------- | ------------------------------------------- | ------------------------------------ | --------------------------------- | --------------------------------------- |
| Epson (dropdowns) | Good (vocabulary extraction fits perfectly) | Poor (no JSON-LD on support hub)     | Excellent (dropdown triggers API) | Excellent (detects API, uses it)        |
| Stripe docs       | Moderate (sidebar nav is simple)            | Excellent (rich schema)              | Good (docs API exists)            | Excellent (detects schema, uses it)     |
| FAQ accordions    | Good (content revealers)                    | Moderate (FAQPage schema if present) | Poor (no API usually)             | Good (detects accordions, uses A)       |
| University        | Moderate (varied structure)                 | Poor (no schema usually)             | Poor (no API usually)             | Moderate (falls back to best available) |
| E-commerce        | Good (category tree)                        | Excellent (Product schema)           | Excellent (product API)           | Excellent (detects API or schema)       |

### Against Design Constraints

| Constraint        | A                                    | B                                  | C                                | D                          |
| ----------------- | ------------------------------------ | ---------------------------------- | -------------------------------- | -------------------------- |
| Generic           | Good — works on hierarchy sites      | Poor — needs schema                | Moderate — needs API             | Good — adapts              |
| Budget-bounded    | Excellent — vocabulary is efficient  | Excellent — few clicks             | Excellent — few clicks           | Excellent                  |
| User-guided       | Moderate — samples validate template | Moderate — samples validate schema | Good — samples validate API URLs | Good                       |
| Correct (no 404s) | Good — leaf hrefs are real           | Good — schema URLs are real        | Good — API URLs are real         | Good                       |
| Progressive       | Moderate — vocabulary before URLs    | Poor — all-or-nothing per category | Good — API returns batches       | Good                       |
| Composable        | Good                                 | Good                               | Good                             | Best — designed to compose |
| No LLM            | Yes                                  | Yes                                | Yes                              | Yes                        |

### Implementation Effort

| Approach           | New Code                                                                  | Reuse Existing                                       | Complexity | Estimated Effort |
| ------------------ | ------------------------------------------------------------------------- | ---------------------------------------------------- | ---------- | ---------------- |
| A: Structure-First | Semantic DOM analyzer, vocabulary extractor, click planner                | navigation-explorer.ts (partial), pattern-matcher.ts | High       | 3-4 weeks        |
| B: Schema-Guided   | JSON-LD extractor (exists in A12), breadcrumb parser, hierarchy traverser | jsonld-extractor.ts, pattern-matcher.ts              | Medium     | 2 weeks          |
| C: API-First       | API classifier, browser-proxied API caller, response URL extractor        | api-interceptor.ts (major reuse)                     | Medium     | 2-3 weeks        |
| D: Adaptive        | Site profiler, strategy selector, all of A/B/C                            | All above                                            | High       | 5-6 weeks        |

---

## 9. Recommendation

**Build Approach D (Adaptive) incrementally, by implementing A, B, and C as
composable modules, then adding the probe + strategy selection layer.**

The implementation order matters:

### Phase 1: Smart Click Budgeting (immediate value, 1 week)

Do not implement a full new approach. Fix the two worst problems in the
current navigation-explorer.ts:

**Fix P2: Content-region-first clicking.**

Before clicking anything, classify DOM regions:

```typescript
interface DomRegion {
  selector: string;
  role: 'nav-header' | 'nav-sidebar' | 'content-main' | 'footer' | 'aside';
  expandableCount: number;
  linkCount: number;
  area: number; // bounding rect area as % of viewport
}
```

Sort regions: `content-main` first, then `nav-sidebar`, then others.
Skip `nav-header` and `footer` entirely (or give them last priority).

This alone would have prevented the Epson failure — the 300 clicks would have
gone to content dropdowns first, not the mega-menu.

**Fix P1: Replace linkFilter with multi-pattern scoring.**

Instead of a single regex filter that discards non-matching links, collect ALL
links and score them against the sample pattern. Keep links with score > 0 but
tag them by tier (hot/warm/cold). Return all three tiers separately.

The existing `pattern-matcher.ts` already does this scoring. The bug is in
`extractPageLinks` in navigation-explorer.ts line 477 — it applies a hard
regex filter. Remove the filter, apply pattern scoring downstream.

### Phase 2: API Exhaustion (Approach C, 2 weeks)

The API interceptor already exists and captures API calls during browser
exploration. Extend it:

1. **Response body capture** — currently captures URL/method/status but not
   response bodies. Need bodies to extract URLs from API responses.

2. **Catalog detection** — classify intercepted APIs as catalog/detail/search
   based on response structure:
   - Array of objects with `url`/`href`/`slug` fields → CATALOG
   - Single object → DETAIL
   - Object with `results`/`items`/`data` array + `total`/`count` → PAGINATED CATALOG

3. **Browser-proxied pagination** — for paginated catalog APIs, use
   `page.evaluate(fetch(...))` to paginate through all results while staying
   in the browser's cookie/auth context.

4. **URL extraction from JSON** — recursively search API response objects for
   fields that look like URLs or path segments. Heuristic: any string value
   that starts with `/` or `http` and is not a static asset path.

### Phase 3: Vocabulary Extraction (Approach A core, 2 weeks)

This is the key structural innovation. When the probe detects cascading
dropdowns or multi-level nav trees:

1. **Dropdown walker** — specialized interaction that opens each level of a
   cascading dropdown and extracts the option list at each level. Not the same
   as "click all expandables" — it is a breadth-first enumeration of dropdown
   options.

2. **Vocabulary tree builder** — organizes extracted options into a tree
   structure with cardinality at each level.

3. **Leaf URL collection** — at the leaf level, collect the actual href from
   each option (not construct it from the vocabulary).

### Phase 4: Probe + Strategy Selection (Approach D shell, 1 week)

With A, B (JSON-LD already in A12), and C implemented as modules, add:

1. **Site probe** — render page, run all signal extractors in parallel, produce
   a site profile with 7 signals.

2. **Strategy selector** — decision function that picks the best primary
   strategy based on the profile.

3. **Execution orchestrator** — runs primary strategy, checks coverage against
   samples, runs fallback if needed, merges results.

---

## 10. Algorithm Specification

This section specifies the target-state algorithm after all phases are
implemented.

### Data Structures

```typescript
/** Site profile from the probe phase */
interface SiteProfile {
  /** JSON-LD, OpenGraph, breadcrumbs — 0.0 to 1.0 */
  schemaRichness: number;
  /** Classified navigation structure */
  navStructure: 'flat' | 'hierarchical' | 'mega-menu' | 'sidebar' | 'none';
  /** Interactive elements in content region */
  contentInteractivity: InteractivityProfile;
  /** URL clusters found in visible links */
  urlClusters: UrlCluster[];
  /** API calls detected during probe clicks */
  apiSignals: ApiSignal[];
  /** Expansion behavior observed during probe */
  expansionBehavior: ExpansionBehavior[];
  /** Pagination model if detected */
  paginationModel: PaginationModel | null;
}

interface InteractivityProfile {
  /** Type of interactive elements found */
  types: Array<'dropdown' | 'accordion' | 'tabs' | 'filter' | 'pagination' | 'none'>;
  /** Total expandable elements in content region */
  expandableCount: number;
  /** Estimated cardinality (items behind expandables) */
  estimatedItems: number;
}

interface UrlCluster {
  /** URL template for this cluster (e.g., /Support/Printers/{}/{}/{}/s/{}) */
  template: string;
  /** Number of URLs matching this template found so far */
  count: number;
  /** Estimated total based on site signals */
  estimatedTotal: number | null;
  /** Match score against user's sample URLs */
  sampleMatchScore: number;
}

interface ApiSignal {
  /** The API pattern detected */
  pattern: ApiPattern; // from existing api-interceptor.ts
  /** Classification */
  type: 'catalog' | 'detail' | 'search' | 'tree' | 'unknown';
  /** Whether response contained URL-like fields */
  hasUrlFields: boolean;
  /** Whether pagination was detected */
  isPaginated: boolean;
}

interface ExpansionBehavior {
  /** Which DOM region this expandable is in */
  region: 'content' | 'nav' | 'sidebar';
  /** What clicking it revealed */
  revealed: 'list' | 'sub-expandables' | 'content' | 'nothing';
  /** If list: how many items in the list */
  itemCount: number;
  /** If list: do items have hrefs? */
  itemsAreLinks: boolean;
}

/** Discovery strategy chosen by the selector */
type DiscoveryStrategy =
  | { type: 'api-exhaustion'; apis: ApiSignal[] }
  | { type: 'schema-guided'; schemaType: string }
  | { type: 'vocabulary-extraction'; regions: ExpansionBehavior[] }
  | { type: 'sidebar-traverse'; navSelector: string }
  | { type: 'smart-click-budget'; regions: DomRegion[] };

/** Result of the complete discovery process */
interface BrowserDiscoveryResult {
  /** All discovered URLs */
  urls: DiscoveredUrl[];
  /** The strategy that was used and why */
  strategyUsed: DiscoveryStrategy;
  /** Site profile from probe */
  siteProfile: SiteProfile;
  /** Vocabulary tree if vocabulary extraction was used */
  vocabularyTree: VocabularyNode[] | null;
  /** API patterns if API exhaustion was used */
  apiPatterns: ApiPattern[] | null;
  /** Click budget utilization */
  clickBudget: { used: number; total: number; phase: string };
  /** Coverage assessment against user samples */
  coverage: { samplesMatched: number; samplesTotal: number };
}

interface DiscoveredUrl {
  url: string;
  /** How this URL was discovered */
  source: 'api' | 'schema' | 'vocabulary-leaf' | 'link-harvest' | 'http-crawl';
  /** Confidence that this URL exists and has content */
  confidence: 'high' | 'medium' | 'low';
  /** Score against user's sample pattern */
  patternScore: number;
  /** Title if available from source */
  title: string | null;
  /** Position in vocabulary tree if applicable */
  vocabularyPath: string[] | null;
}

interface VocabularyNode {
  label: string;
  level: number;
  children: VocabularyNode[];
  /** URL at this node (for leaf nodes) */
  url: string | null;
  /** Number of leaf URLs under this subtree */
  leafCount: number;
}
```

### DOM Region Classification

The region classifier runs once before any clicks. It uses spatial analysis
and semantic HTML to identify regions:

```
ALGORITHM: classifyDomRegions(page)
  1. Find all landmark elements: <nav>, <main>, <aside>, <header>, <footer>,
     [role="navigation"], [role="main"], [role="complementary"]
  2. For elements without landmarks, use spatial heuristics:
     - Top 80px of viewport → likely header/nav
     - Left 20% of viewport, full height → likely sidebar
     - Bottom 80px → likely footer
     - Remaining center area → likely content
  3. For each region, count:
     - Expandable elements (aria-expanded, details, etc.)
     - Links (<a href>)
     - Interactive widgets (select, input, button not in forms)
  4. Return regions sorted by: content > sidebar > nav > footer
```

### Vocabulary Extraction (Cascading Dropdown Walker)

This is the most novel algorithm component. It handles the Epson case:

```
ALGORITHM: extractVocabulary(page, region, maxBudget)

  INPUT: A DOM region containing cascading interactive elements
  OUTPUT: VocabularyNode tree with leaf URLs

  1. DETECT LEVELS
     Find the first interactive element in the region.
     Click it. Observe what appears:
     a) A list of options (text items, possibly clickable)
     b) Sub-expandables
     c) A new dropdown/select that was previously disabled/hidden

     This tells us the first level's behavior.

  2. ENUMERATE LEVEL 1
     Extract all options at this level:
     - For <select>: read all <option> elements
     - For dropdown/listbox: read all [role="option"] or list items
     - For accordion: read all section headers
     Record: labels[], and whether each has a sub-level trigger

  3. SAMPLE ONE PATH TO LEAF
     Pick the first option at level 1. Click it.
     Does a new level appear? If yes, extract its options.
     Continue clicking first options until reaching a leaf
     (a leaf = clicking produces a page link, not more options).

     Record the depth: e.g., 3 levels for Epson (Type > Series > Model).
     Record the leaf URL pattern.

  4. ENUMERATE REMAINING BRANCHES (breadth-first)
     Go back to level 1. For EACH option:
       a. Click it
       b. At level 2, extract all options
       c. For EACH level-2 option:
          - Click it
          - At level 3 (leaf), extract all option labels + their hrefs
       d. Reset to level 1 (click the current option again to collapse,
          or navigate back if needed)

     Click budget per branch: depth clicks per branch.
     Total clicks: sum(level1_options * level2_options * depth)

     OPTIMIZATION: If level 2 options are the same across multiple
     level 1 options (e.g., printer series are the same regardless of
     type), detect this after 2 level-1 options and skip redundant
     enumeration.

  5. BUILD TREE
     Return VocabularyNode tree with all labels and leaf URLs.

  BUDGET GUARD:
     If estimated total clicks (level1 * level2 * depth) exceeds budget:
     - Enumerate level 1 fully (cheap)
     - Sample level 2 for 3 level-1 options (detect if level 2 varies)
     - If level 2 varies: enumerate all level-1 x level-2 combinations
       but only sample level 3 for a subset, then use URL template to
       predict remaining leaf URLs
     - If level 2 is constant: enumerate level 2 once, then enumerate
       level 3 for each level-1 option
```

### Strategy Selection Decision Function

```
ALGORITHM: selectStrategy(profile: SiteProfile)

  # Priority 1: API available with catalog endpoint
  IF any apiSignal has type='catalog' AND hasUrlFields:
    RETURN { type: 'api-exhaustion', apis: catalogApis }

  # Priority 2: Rich structured data
  IF profile.schemaRichness > 0.6:
    RETURN { type: 'schema-guided', schemaType: dominantSchemaType }

  # Priority 3: Vocabulary-style interactivity
  IF any expansionBehavior has revealed='list' AND itemCount > 3:
    IF that behavior's region is 'content':
      RETURN { type: 'vocabulary-extraction', regions: vocabularyRegions }

  # Priority 4: Hierarchical navigation
  IF profile.navStructure in ('hierarchical', 'sidebar'):
    RETURN { type: 'sidebar-traverse', navSelector: sidebarSelector }

  # Priority 5: Default — smart budget allocation
  RETURN { type: 'smart-click-budget', regions: contentFirstRegions }
```

### linkFilter Replacement

The current linkFilter is a hard regex gate. Replace with scoring:

```
CURRENT (broken):
  if (regex && !regex.test(link.href)) continue;  // DISCARD

NEW (multi-pattern scoring):
  const score = scoreUrl(link.href, learnedPattern);
  link.patternScore = score.score;
  link.tier = score.tier;
  // KEEP ALL links. Filter/group by tier in the UI.
  // hot (>=80): primary results
  // warm (40-79): "related content" section
  // cold (<40): "other links found" (collapsed by default)
```

This is a one-line change in navigation-explorer.ts that fixes P1 immediately.

---

## 11. What Changes in the Current System

### Immediate (Phase 1 — this sprint)

| File                        | Change                                                                                         | Why                                            |
| --------------------------- | ---------------------------------------------------------------------------------------------- | ---------------------------------------------- |
| `navigation-explorer.ts`    | Remove `linkFilter` regex in `extractPageLinks`. Return all links.                             | Fixes P1: filter is too narrow                 |
| `navigation-explorer.ts`    | Add `classifyDomRegions()` before `exploreExpandables()`. Sort expandables by region priority. | Fixes P2: content before chrome                |
| `crawl-browser-discover.ts` | Accept `sampleUrls` instead of `linkFilter`. Pass to downstream for scoring.                   | Aligns browser discover API with HTTP discover |
| `pattern-matcher.ts`        | No change — scoring already works.                                                             | Already correct                                |

### Phase 2 (API Exhaustion)

| File                     | Change                                                                                      | Why                        |
| ------------------------ | ------------------------------------------------------------------------------------------- | -------------------------- |
| `api-interceptor.ts`     | Add response body capture (opt-in, with size limit). Add catalog classification.            | Enables API-first strategy |
| New: `api-exhaustion.ts` | Browser-proxied API pagination. URL extraction from JSON responses.                         | Core of Approach C         |
| `navigation-explorer.ts` | After probe clicks, check if API exhaustion can cover the content. If yes, switch strategy. | Strategy selection         |

### Phase 3 (Vocabulary Extraction)

| File                           | Change                                                                | Why                 |
| ------------------------------ | --------------------------------------------------------------------- | ------------------- |
| New: `vocabulary-extractor.ts` | Cascading dropdown walker. Vocabulary tree builder.                   | Core of Approach A  |
| `navigation-explorer.ts`       | Integrate vocabulary extraction as an alternative to blind expansion. | Structure discovery |

### Phase 4 (Adaptive Strategy)

| File                        | Change                                                         | Why                     |
| --------------------------- | -------------------------------------------------------------- | ----------------------- |
| New: `site-profiler.ts`     | 7-signal probe. Site profile builder.                          | Probe phase             |
| New: `strategy-selector.ts` | Decision function. Strategy composition.                       | Strategy selection      |
| `navigation-explorer.ts`    | Refactor into orchestrator that delegates to strategy modules. | Composable architecture |

### What We Do NOT Change

- `discover-crawler.ts` — HTTP recursive crawler stays as-is. It is a separate
  layer that runs before/after browser discovery.
- `pattern-matcher.ts` — Scoring logic stays. It becomes the shared scoring
  layer used by all strategies.
- `api-interceptor.ts` — Core interception stays. We extend it, not replace it.
- The escalation chain (HTTP > Browser > API > Fan-out) stays. We improve what
  the browser layer does, not when it runs.

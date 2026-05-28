# Discovery Phase — Algorithm & UX Specification

## What

The discovery phase reverse-engineers a website's link structure from a single target URL.
It finds all ancestor links and sibling links, analyses samples to classify HTTP vs browser
rendering, and stores all links found during traversal. The output is a live-growing tree
of discovered URLs that the user can selectively crawl.

## Input

- One primary URL (entered by user in State 1)
- 1–3 sample URLs (pages the user wants to crawl — helps the system understand target content)
- Max level limit: 8 (system default, bounds automatic traversal in both directions)

## Output

- Live-growing tree of discovered URLs organized by URL-path hierarchy
- Each URL tagged with: HTTP or browser rendering requirement
- Activity log showing what the system is doing in real-time
- Selection mechanism with checkboxes, pattern matching, and quick-select groups

---

## Algorithm

### Phase 0: Nav Extraction (instant, from primary URL)

- Visit the primary URL with Playwright
- Extract site navigation structure from header, footer, mega-menus using CSS selectors
- Nav structure is used on the **seed selection screen** to help user pick starting points
- Nav extraction runs ONCE during site profiling, before discovery starts
- After seed selection, nav has served its purpose — not shown during BFS discovery

### Phase 1a: Visit Primary URL + All Sample URLs

- Fetch each page (start with Playwright, classify HTTP/browser using existing algorithms)
- Extract breadcrumbs from each page (5 strategies: schema-org, aria, css-class, heuristic, separator)
- Capture ALL same-domain `<a href>` links from each page
- Add to URL map with deduplication
- These links are the CHILDREN of user-given URLs

### Phase 1b: Visit Children of User-Given URLs (depth-1)

- For every link discovered in Phase 1a (children of primary URL + sample URLs)
- Visit each child page
- Capture ALL same-domain links from each child (these are grandchildren)
- Classify each page as HTTP or browser
- Deduplicate into URL map
- Tree grows live during this phase
- **Children of user-given URLs are the highest priority** because the user intentionally gave those URLs

Example:

```
User gives: epson.com/Support/Printers
Phase 1a visits /Printers → finds: /All-In-Ones, /Single-Function, /Wide-Format
Phase 1b visits /All-In-Ones → finds: /ET-Series, /WorkForce, /Expression
Phase 1b visits /Single-Function → finds: /EcoTank, /Expression-Photo
Phase 1b visits /Wide-Format → finds: /SureColor-T, /SureColor-P
```

### Phase 2: Climb UP (breadcrumb-guided, best-effort)

- Use breadcrumbs collected from ALL sample URLs in Phase 1a
- Visit each ancestor page (**shallowest first** — climb from closest-to-root downward)
- At each ancestor, capture ALL same-domain links
- Discovers siblings (e.g., Scanners, Projectors found from /Support page)
- **Dynamic breadcrumb queue**: when visiting a hub page reveals new breadcrumbs (from
  pages linked on that hub), those are merged into the climb queue and re-sorted
  shallowest-first. This means the climb adapts as it discovers more of the hierarchy.
- Stop when: 404, no more breadcrumbs, hit max level limit (8)
- Best-effort — may not reach root, and that's OK

#### Breadcrumb Extraction (5 strategies, priority order)

Extracted from each visited page using `breadcrumb-extractor.ts`. Strategies tried
in order — first match wins:

| #   | Strategy       | How it works                                                                                              |
| --- | -------------- | --------------------------------------------------------------------------------------------------------- |
| 1   | **Schema.org** | Looks for `<script type="application/ld+json">` with `@type: BreadcrumbList` — most reliable when present |
| 2   | **ARIA nav**   | Finds `<nav aria-label="breadcrumb">` or `<ol role="breadcrumb">` — extracts `<a>` elements in order      |
| 3   | **CSS class**  | Matches elements with class names containing `breadcrumb` — walks child `<a>` tags                        |
| 4   | **Heuristic**  | Looks for `<nav>` or `<div>` containing only `<a>` tags separated by common separators (>, /, →, ›)       |
| 5   | **Separator**  | Scans text content for separator patterns between link-like text nodes — last resort                      |

Returns ordered crumbs (shallowest to deepest) with URLs. Strategy name is recorded
for debugging.

#### URL Path Truncation Fallback

When NO breadcrumbs are found on any sample page (common on SPAs or pages without
breadcrumb markup):

1. Take the URL path: `/Support/Printers/All-In-Ones/ET-Series/ET-2850`
2. Strip last segment: `/Support/Printers/All-In-Ones/ET-Series`
3. Fetch that URL — if it redirects, follow the redirect to find the real hub
4. If 200: add to climb queue, extract links from that page
5. If 404: strip another segment and try again
6. Repeat until hit root `/` or max 8 levels

**Known gotcha (Epson):** Some sites use URL suffixes like `/sh/s1` (e.g.,
`/Support/Printers/All-In-Ones/sh/s1`) that don't correspond to real parent pages.
Truncating `/sh/s1` → `/sh` → 404. The redirect-following step is critical here —
the site may redirect `/Support/Printers/All-In-Ones` to `/Support/Printers/All-In-Ones/sh/s1`,
revealing the actual hub URL.

#### Pattern Divergence / Bridge Pages

When a site's base URL path prefix differs from its content URL prefix (e.g.,
homepage links go to `/products/*` but product pages link back to `/support/*`),
standard BFS stays within the discovered prefix and misses the other branch.

Mitigation: Detect cross-prefix links during BFS. When a visited page's outgoing
links go to a different URL prefix than the page itself, treat those as **bridge pages**
and add them to the BFS queue regardless of prefix filter. This prevents missing
entire site sections that are only reachable via cross-prefix navigation.

### Phase 3: BFS Depth-1 (automatic expansion of remaining URLs)

- For every URL discovered during Phase 2 (from climbing) that hasn't been visited
- Visit page, capture all same-domain links, classify HTTP/browser
- Deduplicate into URL map
- Tree grows live
- **Diminishing returns detection** (existing `yield-tracker.ts`):
  - Track new-URL yield per hub page visited
  - Peak yield threshold: **5% of peak** (if peak was 40 new URLs, stop when a page yields < 2)
  - Absolute floor: **1 new URL** (never stop if still finding at least 1 new URL)
  - Consecutive low-yield limit: **3** (3 consecutive pages below threshold = stop this branch)
  - Min pages before yield check: **3** (don't evaluate yield on first few pages)
  - Adaptive sample count: `Math.min(Math.ceil(Math.log2(linkCount)), 8)` — scales with hub size
- Stop when: all depth-1 pages visited OR diminishing returns triggered on all active branches

### Phase 4: User-Driven Expansion ("Discover More")

- User can click "Discover More" on ANY node — leaf or branch — with **no level limit**
- Max level 8 is only for the system's automatic phases (1–3)
- If the node is unvisited: visit it first, capture links
- Then visit its unvisited children (BFS depth-1)
- Visited/unvisited state is **stateful** and persists across actions
- Tree expands live with each visit

---

## Deduplication

- **Key:** Normalized URL
  - Lowercase the hostname
  - Remove fragment (#...)
  - Remove trailing slash (except root /)
  - Sort query parameters alphabetically
  - Remove tracking params (utm\_\*, fbclid, etc.)
- **Tree position:** Determined by URL path hierarchy (not by where the link was found)
- **Metadata per URL:** `foundOn: [list of pages that linked to this URL]`
- If same URL found from multiple pages, `foundOn` grows — no duplicate tree nodes

### Tree Building (from flat URL map)

1. Sort all URLs by path depth (shortest first)
2. For each URL, find closest ancestor in the map by walking up URL path segments
3. Attach as child of closest ancestor
4. Result: URL-path-based hierarchy with `foundOn` metadata

### `findClosestAncestor` logic:

```
segments = url.pathname.split('/')
for i = segments.length - 1 down to 1:
  candidatePath = segments[0..i].join('/')
  candidateUrl = origin + candidatePath
  if urlMap.has(candidateUrl):
    return candidateUrl
return rootUrl
```

---

## Data Model

### Per discovered URL:

```typescript
interface DiscoveredPage {
  url: string; // normalized absolute URL
  foundOn: string[]; // pages that linked to this URL
  renderMethod: 'http' | 'browser' | 'unknown';
  visited: boolean; // has this page been fetched?
  status: 'discovered' | 'visiting' | 'visited' | 'error';
  childUrls: string[]; // links found ON this page (if visited)
}
```

### Node statuses:

- `discovered` — URL exists but page not yet fetched
- `visiting` — currently being fetched
- `visited` — fetched, all links captured
- `error` — fetch failed (404, timeout, etc.)

---

## UX Properties

| Property      | Behavior                                                                                |
| ------------- | --------------------------------------------------------------------------------------- |
| Live feed     | Tree grows in real-time as pages are visited                                            |
| Transparency  | Activity log visible — what it's fetching, what it found, decisions made                |
| Stop button   | User can stop anytime, keeps all partial results                                        |
| Discover More | Per-node manual expansion via BFS depth-1, no level limit                               |
| Rendering     | Start with Playwright, classify using existing algorithms (see below)                   |
| Filter        | Same domain by default (user can adjust)                                                |
| Max levels    | 8 for automatic phases; unlimited for user-driven expansion                             |
| Scale         | HTTP + Playwright hybrid — HTTP for most pages (fast), Playwright only when JS required |

---

## HTTP vs Browser Classification (existing `page-classifier.ts`)

During BFS, each visited page is classified as HTTP-renderable or browser-required.
The existing classifier uses these signals:

| Signal                     | Indicator                                                          | Weight |
| -------------------------- | ------------------------------------------------------------------ | ------ |
| **Link homogeneity**       | >40% of links share a common prefix → structured hub (likely HTTP) | High   |
| **Content density**        | High prose-to-HTML ratio (>40%) → content page (likely HTTP)       | High   |
| **DOM repetition**         | Repeated `<div>` patterns → templated listing (likely HTTP)        | Medium |
| **Min hub links**          | ≥5 same-domain links → hub page                                    | Medium |
| **JS framework detection** | React/Angular/Vue markers in DOM → needs Playwright                | High   |
| **Dynamic content**        | `<noscript>` tags, lazy-load attributes → needs Playwright         | Medium |

Classification runs silently — user sees the result (📡 HTTP / 🖥 browser) on each
tree node but not the classification process.

---

## Nav Extraction Known Limitations

The current nav extractor (`nav-extractor.ts`) uses a recursive DOM walker
targeting `<ul>/<li>` nesting patterns plus mega-menu hover extraction. Known gaps:

| Gap                     | Example                                  | Impact                                       |
| ----------------------- | ---------------------------------------- | -------------------------------------------- |
| **Heading-grouped nav** | `<div>/<h3>/<a>` patterns (Epson footer) | Misses footer nav sections entirely          |
| **CSS-only dropdowns**  | `:hover` menus without JS interaction    | May miss nested items if hover not simulated |
| **Shadow DOM nav**      | Web components with encapsulated nav     | Not traversed by standard selectors          |

These are implementation-level concerns deferred to Build 2/3 — the algorithm
itself is agnostic to nav extraction method. Missing nav items don't break discovery;
they just mean fewer seed options on the seed selection screen. The user can always
provide target URLs manually.

---

## Complete UX Experience (State-by-State)

### State 1: URL Entry

User enters the website URL and optional authentication.

```
┌──────────────────────────────────────────────────────────────────┐
│                                                                  │
│  🔗 Enter your website URL                                       │
│                                                                  │
│  ┌────────────────────────────────────────────────────┐  ┌────┐  │
│  │ epson.com/Support/Printers                         │  │ Go │  │
│  └────────────────────────────────────────────────────┘  └────┘  │
│                                                                  │
│  ▸ Authentication (optional)                                     │
│    Public | Bearer Token | Basic Auth | Custom Headers | Cookies │
│                                                                  │
│  ▸ Saved Drafts                                                  │
│    Epson Support (draft, 2 days ago)  [Resume] [Delete]          │
│                                                                  │
│  How it works:                                                   │
│    1. Analyse → 2. Learn → 3. Reuse → 4. Improve                │
│                                                                  │
└──────────────────────────────────────────────────────────────────┘
```

**User action:** Types URL → clicks Go
**System does:** Validates URL → profiles site (platform, JS requirement, sitemap detection, nav extraction) → transitions to State 2

---

### State 2a: Mode Selection

System has already profiled the site. Shows three modes with real data from profiling.
If no sitemap found, Sitemap card indicates that. If no nav structure found, Discovery
card adjusts messaging. Direct URLs card mentions sitemap availability if detected.

```
┌──────────────────────────────────────────────────────────────────────┐
│  ✓ Site profiled: epson.com                                          │
│  Platform: Custom │ JS Required: Yes │ Sitemap: Found (1,247 URLs)  │
│                                                                      │
│  How would you like to find pages to crawl?                          │
│                                                                      │
│  ┌────────────────────────────────────────────────────────────────┐  │
│  │  📋 Sitemap                                                    │  │
│  │                                                                │  │
│  │  We found a sitemap with 1,247 URLs across 14 sections.       │  │
│  │  System will cluster and organize them for you to select.      │  │
│  │                                                                │  │
│  │  Best for: Sites with comprehensive sitemaps.                  │  │
│  │                                                    [ Select ] │  │
│  └────────────────────────────────────────────────────────────────┘  │
│                                                                      │
│  ┌────────────────────────────────────────────────────────────────┐  │
│  │  🔍 Discovery                                                  │  │
│  │                                                                │  │
│  │  We found this site's navigation:                              │  │
│  │    ▸ Printers (All-In-Ones, Single Function, Wide Format)      │  │
│  │    ▸ Scanners                                                  │  │
│  │    ▸ Projectors                                                │  │
│  │    ▸ Ink & Toner                                               │  │
│  │                                                                │  │
│  │  Select sections to explore, or provide target page URLs.      │  │
│  │  System will visit pages, discover links, and classify them.   │  │
│  │                                                                │  │
│  │  Best for: Sites with incomplete sitemaps or JS-heavy content. │  │
│  │                                                    [ Select ] │  │
│  └────────────────────────────────────────────────────────────────┘  │
│                                                                      │
│  ┌────────────────────────────────────────────────────────────────┐  │
│  │  📝 Direct URLs                                                │  │
│  │                                                                │  │
│  │  Already know which pages to crawl? Paste your URLs directly.  │  │
│  │  You can also add URLs from the sitemap (1,247 available).     │  │
│  │                                                                │  │
│  │  Best for: When you have a specific list ready.                │  │
│  │                                                    [ Select ] │  │
│  └────────────────────────────────────────────────────────────────┘  │
│                                                                      │
└──────────────────────────────────────────────────────────────────────┘
```

---

### State 2b — PATH A: Sitemap Mode

Existing flow — system clusters sitemap URLs into sections, user selects groups.
Not redesigned here.

---

### State 2b — PATH B: Discovery Mode — Seed Selection

Nav structure (already extracted during profiling) is shown as selectable checkboxes.
User can also provide target page URLs. Both serve as seed URLs for the same BFS algorithm.

```
┌──────────────────────────────────────────────────────────────────────┐
│  🔍 Discovery: Choose starting points                                │
│                                                                      │
│  Select from site navigation:                                        │
│                                                                      │
│  ☑ Printers                                                         │
│    ☐ All-In-Ones                                                    │
│    ☐ Single Function                                                │
│    ☐ Wide Format                                                    │
│  ☑ Scanners                                                         │
│  ☐ Projectors                                                       │
│  ☐ Ink & Toner                                                      │
│                                                                      │
│  ─────────────────── or ───────────────────                          │
│                                                                      │
│  Provide target page URLs:                                           │
│                                                                      │
│  ┌──────────────────────────────────────────────────────────────┐    │
│  │ epson.com/Support/.../ET-2850/s/SPT_C11CJ63201              │    │
│  └──────────────────────────────────────────────────────────────┘    │
│  ┌──────────────────────────────────────────────────────────────┐    │
│  │ epson.com/Support/.../WF-2960/s/SPT_C11CK60201              │    │
│  └──────────────────────────────────────────────────────────────┘    │
│  ┌──────────────────────────────────────────────────────────────┐    │
│  │                                                              │    │
│  └──────────────────────────────────────────────────────────────┘    │
│                                                                      │
│  Starting from: 2 nav sections + 2 target URLs                      │
│                                                                      │
│  The system will visit these pages, discover all linked pages,       │
│  climb to find parents, and classify each as HTTP or browser.        │
│                                                                      │
│                                          [ Start Discovery ]         │
└──────────────────────────────────────────────────────────────────────┘
```

**User action:** Checks nav sections + enters sample URLs → clicks Start Discovery

---

### State 2c — PATH B: Discovery Running (live feed)

Single tree view with activity log. No separate nav panel — nav was used for seed
selection and has served its purpose. Tree grows in real-time as algorithm runs.

```
┌──────────────────────────────────────────────────────────────────────┐
│  Discovering...  ⏱ 18s  │  Visited: 14  │  Found: 192    [ ⏹ Stop ]│
├──────────────────────────────────────────────────────────────────────┤
│                                                                      │
│  Starting from: Printers, Scanners, ET-2850, WF-2960 (4 seeds)     │
│                                                                      │
│  Support/                              🌐 visited     14 links       │
│  ├── Printers/                         🌐 visited     67 links       │
│  │   ├── All-In-Ones/                  🌐 visited     45 links       │
│  │   │   ├── ET Series/               🌐 visited     24 links       │
│  │   │   │   ├── ET-2850              🌐 visited     23 links  🖥    │
│  │   │   │   ├── ET-4850              ○  discovered            🖥    │
│  │   │   │   ├── ET-2800              ○  discovered            📡    │
│  │   │   │   └── ET-16650             ○  discovered            📡    │
│  │   │   ├── WorkForce Series/        🌐 visited     19 links       │
│  │   │   │   ├── WF-2960              🌐 visited     19 links  🖥    │
│  │   │   │   ├── WF-7840              ○  discovered            🖥    │
│  │   │   │   └── WF-3823              ○  discovered                  │
│  │   │   └── Expression Series/       ○  discovered                  │
│  │   ├── Single-Function/             🌐 visited     31 links       │
│  │   │   ├── EcoTank Series/          🌐 visited     15 links       │
│  │   │   └── Expression Photo/        ○  discovered                  │
│  │   └── Wide-Format/                 ○  discovered                  │
│  ├── Scanners/                        🌐 visiting...                 │
│  │   ├── Flatbed/                     ○  discovered                  │
│  │   ├── Document Scanners/           ○  discovered                  │
│  │   └── Portable Scanners/           ○  discovered                  │
│  ├── Projectors/                      ○  discovered                  │
│  └── Label-Printers/                  ○  discovered                  │
│                                                                      │
│  Legend: 🌐 visited  ○ discovered  🖥 browser  📡 http               │
│                                                                      │
│  [ Discover More ] click any node to explore deeper                  │
│                                                                      │
├──────────────────────────────────────────────────────────────────────┤
│  ACTIVITY LOG                                                        │
│                                                                      │
│  [12:01:01] Starting from 4 seeds: Printers, Scanners, ET-2850,     │
│             WF-2960                                                  │
│  [12:01:02] Phase 0: Extracting nav from primary URL (done)          │
│  [12:01:02] Phase 1a: Visiting primary URL /Support/Printers         │
│  [12:01:03] Found 67 same-domain links                               │
│  [12:01:03] Phase 1a: Visiting sample epson.com/.../ET-2850          │
│  [12:01:04] Breadcrumb: Support > Printers > All-In-Ones > ET > 2850│
│  [12:01:05] Phase 1a: Visiting sample epson.com/.../WF-2960          │
│  [12:01:05] Breadcrumb: Support > Printers > All-In-Ones > WF > 2960│
│  [12:01:06] Phase 1b: Visiting children of primary URL               │
│  [12:01:06] /All-In-Ones — 45 links (12 new)                        │
│  [12:01:07] /Single-Function — 31 links (8 new)                     │
│  [12:01:08] Phase 2: Climbing breadcrumbs to /Support                │
│  [12:01:09] /Support — 91 links, found siblings: Projectors, ...    │
│  [12:01:10] Phase 3: BFS expanding unvisited URLs                    │
│  [12:01:11] /ET-Series — 24 links, 18 new                           │
│  [12:01:12] /WorkForce-Series — 19 links, 14 new                    │
│  [12:01:14] Classified /ET-2850: needs Playwright (dynamic content)  │
│  [12:01:15] Classified /ET-2800: HTTP OK (static page)               │
│  [12:01:18] ▶ Visiting seed 2: /Support/Scanners...                  │
└──────────────────────────────────────────────────────────────────────┘
```

---

### State 2d — PATH B: User clicks "Discover More"

User clicks any node — the tree expands live from that node.

```
│  User clicks [ Discover More ] on "Expression Series/"              │
│                                                                      │
│  ...                                                                 │
│  │   │   └── Expression Series/       🌐 visiting...                │
│  │   │       ├── XP-4200              ○  discovered           📡    │
│  │   │       ├── XP-7100              ○  discovered           📡    │
│  │   │       └── XP-970               ○  discovered           🖥    │
│  ...                                                                 │
│                                                                      │
├──────────────────────────────────────────────────────────────────────┤
│  [12:02:31] User: Discover More on Expression Series                 │
│  [12:02:32] Visiting /Expression-Series — 18 links, 3 new           │
│  [12:02:32] Classified: HTTP OK                                      │
│  [12:02:33] Depth-1: Visiting /XP-4200 — 12 links, 2 new           │
│  [12:02:33] Depth-1: Visiting /XP-7100 — 9 links, 1 new            │
└──────────────────────────────────────────────────────────────────────┘
```

---

### State 2e — PATH B: Discovery Complete — Selection & Configure

When discovery finishes (or user is satisfied), the tree becomes the selection and
configuration interface. No separate "Configure" screen — the tree IS the configuration.

Auto-selection: visited branches auto-selected, unvisited branches unchecked.
User can override with checkboxes, quick-select patterns, or custom glob patterns.

```
┌──────────────────────────────────────────────────────────────────────┐
│  ✓ Discovery complete  │  Visited: 22  │  Found: 247  │  ⏱ 34s     │
│                                                                      │
│  Select pages to crawl:                              🔍 Filter URLs  │
│  ┌──────────────────────────────────────────────────────────────┐    │
│  │ Search: /ET-Series/*                                        │    │
│  └──────────────────────────────────────────────────────────────┘    │
│                                                                      │
│  [ Select All ]  [ Select Visited Only ]  [ Clear All ]             │
│                                                                      │
│  ☑ Support/                               🌐   14 links             │
│  ├── ☑ Printers/                          🌐   67 links             │
│  │   ├── ☑ All-In-Ones/                   🌐   45 links             │
│  │   │   ├── ☑ ET Series/                 🌐   24 links    ✓ 4 URLs │
│  │   │   │   ├── ☑ ET-2850               🌐   23 links    🖥        │
│  │   │   │   ├── ☑ ET-4850               ○               🖥        │
│  │   │   │   ├── ☑ ET-2800               ○               📡        │
│  │   │   │   └── ☑ ET-16650              ○               📡        │
│  │   │   ├── ☑ WorkForce Series/          🌐   19 links    ✓ 3 URLs │
│  │   │   │   ├── ☑ WF-2960               🌐   19 links    🖥        │
│  │   │   │   ├── ☑ WF-7840               ○               🖥        │
│  │   │   │   └── ☑ WF-3823               ○                         │
│  │   │   └── ☐ Expression Series/         🌐   18 links    · 3 URLs │
│  │   │       ├── ☐ XP-4200               ○               📡        │
│  │   │       ├── ☐ XP-7100               ○               📡        │
│  │   │       └── ☐ XP-970                ○               🖥        │
│  │   ├── ☑ Single-Function/              🌐   31 links             │
│  │   │   ├── ☑ EcoTank Series/           🌐   15 links    ✓ 2 URLs │
│  │   │   └── ☐ Expression Photo/         ○                         │
│  │   └── ☐ Wide-Format/                  ○    not visited           │
│  ├── ☑ Scanners/                         🌐   28 links             │
│  │   ├── ☑ Flatbed/                      🌐   12 links    ✓ 2 URLs │
│  │   ├── ☑ Document Scanners/            🌐    9 links    ✓ 1 URL  │
│  │   └── ☐ Portable Scanners/            ○    not visited           │
│  ├── ☐ Projectors/                       ○    not visited           │
│  └── ☐ Label-Printers/                   ○    not visited           │
│                                                                      │
│  ─── Quick Select Patterns ─────────────────────────────────────    │
│                                                                      │
│  System detected these URL patterns:                                 │
│                                                                      │
│  ☑ /Support/Printers/All-In-Ones/**         67 URLs   (visited ✓)  │
│  ☑ /Support/Printers/Single-Function/**     31 URLs   (visited ✓)  │
│  ☐ /Support/Printers/Wide-Format/**         12 URLs   (not visited)│
│  ☑ /Support/Scanners/**                     28 URLs   (visited ✓)  │
│  ☐ /Support/Projectors/**                   11 URLs   (not visited)│
│  ☐ /Support/Label-Printers/**                8 URLs   (not visited)│
│                                                                      │
│  Or enter custom pattern:                                            │
│  ┌────────────────────────────────────┐                              │
│  │ e.g. /Support/**/ET-*             │  [ Apply ]                   │
│  └────────────────────────────────────┘                              │
│                                                                      │
│  ───────────────────────────────────────────────────────────────     │
│                                                                      │
│  Selected: 189 URLs  │  HTTP: 112  │  Browser: 67  │  Unknown: 10  │
│  Estimated time: ~12 min                                             │
│                                                                      │
│  [ Discover More ] on unvisited     [ ◀ Back ]  [ Start Crawl ▸ ]  │
│                                                                      │
└──────────────────────────────────────────────────────────────────────┘
```

### Selection features:

| Feature                           | How it works                                                                       |
| --------------------------------- | ---------------------------------------------------------------------------------- |
| Checkbox per node                 | Check/uncheck any branch — cascades to children                                    |
| Select All / Visited Only / Clear | Bulk actions                                                                       |
| Quick Select Patterns             | System clusters discovered URLs into patterns — user checks/unchecks entire groups |
| Custom pattern                    | User types a glob pattern → matches highlight and get selected                     |
| Filter/Search                     | Type to filter the tree — shows only matching nodes                                |
| Auto-selection default            | Visited branches auto-selected; unvisited branches unchecked                       |
| Discover More                     | Still available — user can explore more before committing to crawl                 |

### Auto-selection logic:

- Visited nodes → auto-selected (system explored them, user likely wants them)
- Discovered but unvisited nodes under visited parents → auto-selected (children of explored areas)
- Unvisited branches (e.g., Projectors, Wide-Format) → not selected (user didn't explore these)
- User can override any of this with checkboxes

---

### State 2b — PATH C: Direct URLs

User pastes URLs directly. Can also add from sitemap if one was found during profiling.

```
┌──────────────────────────────────────────────────────────────────────┐
│  📝 Direct URLs: Provide pages to crawl                              │
│                                                                      │
│  Paste your URLs (one per line):                                     │
│  ┌──────────────────────────────────────────────────────────────┐    │
│  │ https://epson.com/Support/Printers/All-In-Ones/ET-Series/   │    │
│  │ Epson-ET-2850/s/SPT_C11CJ63201                              │    │
│  │ https://epson.com/Support/Printers/All-In-Ones/ET-Series/   │    │
│  │ Epson-ET-4850/s/SPT_C11CJ21201                              │    │
│  │ https://epson.com/Support/Printers/All-In-Ones/WorkForce-   │    │
│  │ Series/Epson-WorkForce-WF-2960/s/SPT_C11CK60201             │    │
│  │ https://epson.com/Support/Scanners/Flatbed/Epson-            │    │
│  │ Perfection-V600/s/SPT_B11B198011                             │    │
│  │                                                              │    │
│  └──────────────────────────────────────────────────────────────┘    │
│  4 URLs entered                                                      │
│                                                                      │
│  ───────────────────────────────────────────────────────────────     │
│                                                                      │
│  Add from sitemap (1,247 URLs available):     [ + Add from Sitemap ] │
│                                                                      │
│  ───────────────────────────────────────────────────────────────     │
│                                                                      │
│  Total: 4 URLs                                                       │
│                                                                      │
│                                         [ Continue ▸ ]               │
└──────────────────────────────────────────────────────────────────────┘
```

**User action:** Clicks "+ Add from Sitemap" — sitemap sections expand inline:

```
┌──────────────────────────────────────────────────────────────────────┐
│  📝 Direct URLs: Provide pages to crawl                              │
│                                                                      │
│  Paste your URLs (one per line):                                     │
│  ┌──────────────────────────────────────────────────────────────┐    │
│  │ https://epson.com/.../ET-2850/s/SPT_C11CJ63201              │    │
│  │ https://epson.com/.../ET-4850/s/SPT_C11CJ21201              │    │
│  │ https://epson.com/.../WF-2960/s/SPT_C11CK60201              │    │
│  │ https://epson.com/.../V600/s/SPT_B11B198011                  │    │
│  └──────────────────────────────────────────────────────────────┘    │
│  4 URLs entered                                                      │
│                                                                      │
│  ─── Add from Sitemap ──────────────────────────── [ - Collapse ] ──│
│                                                                      │
│  ☑ /Support/Printers/All-In-Ones/**       142 URLs                  │
│  ☑ /Support/Printers/Single-Function/**    89 URLs                  │
│  ☐ /Support/Printers/Wide-Format/**        34 URLs                  │
│  ☐ /Support/Scanners/**                    67 URLs                  │
│  ☐ /Support/Projectors/**                  58 URLs                  │
│  ☐ /Support/Label-Printers/**              23 URLs                  │
│  ☐ /Ink-and-Toner/**                       45 URLs                  │
│  ☐ /Support/Point-of-Sale/**               12 URLs                  │
│  ☐ /deals/**                                8 URLs                  │
│  ☐ /rebates/**                              5 URLs                  │
│  ☐ /about/**                               14 URLs                  │
│  ☐ Other                                  750 URLs                  │
│                                                                      │
│  Selected: 231 URLs from sitemap                     [ Add Selected ]│
│                                                                      │
│  ───────────────────────────────────────────────────────────────     │
│                                                                      │
│  Total: 4 pasted + 231 from sitemap = 235 URLs                      │
│                                                                      │
│                                         [ Continue ▸ ]               │
└──────────────────────────────────────────────────────────────────────┘
```

**User action:** Selects sitemap sections → clicks Continue
**System does:** Classifies URLs as HTTP/browser (silently, during transition) → shows Configure

---

### State 3: Configure (all paths converge)

All three paths arrive here with a list of URLs + HTTP/browser classification.
Source breakdown shows where URLs came from depending on which path was taken.

```
┌──────────────────────────────────────────────────────────────────────┐
│  Configure Crawl                                                     │
│                                                                      │
│  235 URLs ready to crawl:                                            │
│                                                                      │
│  Source breakdown:                                                    │
│  • 4 pasted directly                                                │
│  • 231 from sitemap                                                 │
│                                                                      │
│  Rendering:                                                          │
│  • HTTP: 158 URLs (67%) — fast batch                                │
│  • Browser: 77 URLs (33%) — Playwright                              │
│                                                                      │
│  ☑ /Support/Printers/All-In-Ones/**       142 URLs    Mixed         │
│  ☑ /Support/Printers/Single-Function/**    89 URLs    HTTP          │
│  ☑ Pasted URLs                               4 URLs    Mixed         │
│                                                                      │
│  Estimated time: ~15 min                                             │
│                                                                      │
│                                    [ ◀ Back ]  [ Start Crawl ▸ ]    │
└──────────────────────────────────────────────────────────────────────┘
```

**Note for Discovery path:** Selection already happened on the discovery tree (State 2e).
State 3 shows a summary confirmation with the option to adjust before crawling.

---

### State 4: Crawling (all paths converge)

```
┌──────────────────────────────────────────────────────────────────────┐
│  Crawling... 235 URLs                                                │
│                                                                      │
│  ████████████████████░░░░░░░░░░  148/235 (63%)  ⏱ 6m 22s           │
│                                                                      │
│  HTTP:      ██████████████████████  134/158  (85%)  — batch          │
│  Browser:   ████████░░░░░░░░░░░░░   14/77   (18%)  — Playwright     │
│                                                                      │
│  ✓ Completed: 148  │  ✗ Failed: 3  │  ◉ In progress: 4             │
│                                                                      │
│  Current: epson.com/Support/.../WF-7840/FAQs                        │
│  Last: 4 content blocks, 3.1KB text extracted                        │
│                                                                      │
│                                                        [ ⏹ Stop ]   │
└──────────────────────────────────────────────────────────────────────┘
```

---

## Flow Summary

```
                            STATE 1
                         URL Entry + Go
                              │
                              ▼
                        Site Profiling
                   (nav extract + sitemap check)
                              │
                              ▼
                         STATE 2a
                      Mode Selection
                    ┌───────┼───────┐
                    │       │       │
                    ▼       ▼       ▼
              Sitemap   Discovery  Direct URLs
                │         │          │
                │         ▼          ▼
                │    Seed Select   Paste URLs
                │    (nav + URLs)  + Add from Sitemap
                │         │          │
                │         ▼          │
                │    Live BFS        │
                │    + Discover More │
                │         │          │
                │         ▼          │
                │    Select on Tree  │
                │    + Patterns      │
                │         │          │
                ▼         ▼          ▼
                ┌─────────────────────┐
                │      STATE 3        │
                │    Configure        │
                │  (confirm + adjust) │
                └─────────┬───────────┘
                          │
                          ▼
                ┌─────────────────────┐
                │      STATE 4        │
                │     Crawling        │
                │  (HTTP + Browser)   │
                └─────────────────────┘
```

---

## Storage Architecture — Generic + Tenant-Specific

Discovery data is **crawling metadata about the website**, not about the tenant. A site's
link structure, nav menu, and rendering requirements are properties of the site, not of
who is crawling it. This enables reuse across tenants, users, and knowledge bases.

### Two Storage Layers

```
┌─────────────────────────────────────────────────────────────────┐
│  GENERIC LAYER (per domain)                                     │
│  Key: normalized domain (e.g., "epson.com")                     │
│                                                                 │
│  • Nav structure (header, footer, mega-menu)                    │
│  • All discovered URLs (union of all tenants' explorations)     │
│  • URL-path tree hierarchy                                      │
│  • HTTP/browser classification per URL                          │
│  • Breadcrumb chains                                            │
│  • Site profile (platform, JS required, estimated size)         │
│  • Sitemap URLs (if found)                                      │
│  • Auth requirement flags ("this page needs auth" — NOT creds)  │
│  • foundOn metadata (which pages link to which)                 │
│                                                                 │
│  Grows as ANY tenant explores new branches.                     │
│  No tenant-private data in this layer.                          │
└─────────────────────────────────────────────────────────────────┘

┌─────────────────────────────────────────────────────────────────┐
│  TENANT LAYER (per tenant + domain + source)                    │
│  Key: tenantId + domain + sourceId                              │
│                                                                 │
│  • Which branches this tenant explored                          │
│  • Which URLs this tenant selected for crawling                 │
│  • Authentication credentials (tenant-owned, never shared)      │
│  • Crawl configuration (schedule, settings)                     │
│  • Selection patterns applied                                   │
│  • Source-specific overrides                                     │
│                                                                 │
│  Standard tenant isolation rules apply.                         │
└─────────────────────────────────────────────────────────────────┘
```

### Why this doesn't violate tenant isolation

Discovery data is public website metadata — equivalent to DNS records, sitemap.xml
content, or page link structure. No tenant's private data exists in the generic layer.
The tenant-specific layer (auth credentials, URL selections, crawl config) is where
isolation applies and `tenantId` scoping is enforced.

### Read Logic

```
RETURNING USER (tenant has existing source for this domain):
  → Read tenant-specific layer first (their branches, their selections)
  → Also read generic layer (may have new branches from other tenants' exploration)
  → Merge: tenant's explored branches + generic's broader coverage

NEW SOURCE (tenant's first time with this domain):
  → Read generic layer (start from what others already discovered)
  → User sees existing discovery tree instantly — no re-discovery needed
  → User selects URLs → creates tenant-specific source config
```

### Write Logic

```
EVERY DISCOVERY writes to BOTH layers:
  1. Generic: add newly discovered URLs, update classifications, merge into tree
  2. Tenant: record which branches this tenant explored, their selections

Example:
  Tenant A explores Printers deeply     → Generic gains deep Printers tree
  Tenant B explores Scanners deeply     → Generic gains deep Scanners tree
  Tenant C enters epson.com for first time
    → Generic has both Printers + Scanners fully explored
    → Tenant C gets the full picture instantly, selects what they need
```

### Recrawl & Rediscover

Today's recrawl is "start a new crawl with the same URLs pre-filled" — no discovery
reuse, no link to previous jobs. With the new storage model:

```
RECRAWL (same URLs):
  → Reuses selected URLs from tenant's source config
  → No re-discovery needed
  → Submits directly to crawl pipeline

REDISCOVER (refresh):
  → User triggers manually (like a retry)
  → Re-runs BFS discovery on the domain
  → Updates generic layer with fresh data
  → All tenants benefit from refreshed data
  → User re-selects URLs after rediscovery if needed
```

Rediscover handles cache/freshness — no automatic staleness timers or "last discovered
X days ago" messaging. The user decides when to refresh.

---

## What This Does NOT Cover (separate concerns)

- Content extraction during crawl (State 4 internals)
- Authentication flow details (State 1 expansion)
- Crawl retry/error handling during State 4
- Post-crawl KB integration
- Generic layer database schema (to be designed during implementation)

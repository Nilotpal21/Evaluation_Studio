# Discovery Tree V2 — Design Proposal

## Problem Statement

The current tree ignores the crawl graph (`foundOn`, `childUrls`, breadcrumbs) and builds purely from URL pathname hierarchy. This produces flat trees where cross-path pages (FAQs reached from product pages) become orphans. The web is a graph; we need a graph-informed tree.

## Industry Findings (from research)

1. **Two parallel trees** — every serious tool (Screaming Frog, Sitebulb, Lumar) offers both URL-path tree and crawl-path tree. They answer different questions.
2. **Multi-parent solved by picking one** — no tool shows multiple parents in tree. Cross-links shown separately (flat table, badge count).
3. **Virtual intermediate nodes are universal** — synthetic folder nodes for path segments that don't resolve to pages. Essential for grouping.
4. **Nobody filters nav links (but should)** — nav links flatten crawl trees to depth 1-2. Filtering reveals deeper content structure.
5. **Breadcrumbs are the best hierarchy signal** — Screaming Frog's own research says breadcrumbs reflect "business logic" while URL paths reflect "historical/technical constraints."
6. **Metrics-per-folder scales** — Ahrefs/Lumar aggregate metrics per folder, scale to any size. Per-page trees cap at ~10k.

## Hierarchy Signal Priority

```
1. Breadcrumbs (highest fidelity — author's intended hierarchy)
2. Non-global crawl parent (foundOn from content page — real content relationship)
3. URL path segments (always available — deterministic fallback)
4. Root (orphan fallback)
```

**Why crawl-path ranks above URL-path:** URL paths reflect technical/historical server
structure, not content relationships (Screaming Frog's own research confirms this).
A FAQ page at `/support/faq/123` linked from `/printers/et-2400` should parent under
the printer page — that's the real content relationship. URL-path would place it under
`/support/faq/`, which is the same broken result we have today.

**Why only non-global crawl parent:** If a page's `foundOn` is a global link (nav/footer,
appearing on >30% of visited pages), the discovery parent is essentially random — whichever
page was crawled first. Global links fall through to URL-path parent instead.

**Primary parent selection when multiple foundOn entries exist:** Prefer the foundOn page
closest in URL-path to the child (combines both signals — content relationship + structural
proximity).

## Proposed Architecture

### Layer 1: Graph Storage (persistent)

The crawl graph is the source of truth. Persisted incrementally on every snapshot.

```typescript
// Per-page data — persisted to MongoDB on every tree-snapshot
interface DiscoveredPage {
  // === Identity ===
  url: string;

  // === Graph relationships (how this page connects to others) ===
  foundOn: string[]; // all pages that link to this URL
  childUrls: string[]; // all pages this URL links to

  // === Provenance (how and when this page was found) ===
  discoverySource: 'primary' | 'seed' | 'nav' | 'breadcrumb-climb' | 'bfs' | 'user-command';
  discoveredAt?: number; // timestamp of first discovery

  // === Labels (human-friendly names, priority order for display) ===
  title?: string; // from <title> tag (available after visit)
  breadcrumbLabel?: string; // text from breadcrumb chain (e.g., "ET-2400 FAQs")
  linkText?: string; // anchor text from the page that linked here
  // fallback: humanized URL slug (computed at render time, not stored)

  // === Classification (what kind of page is this) ===
  pageRole?: 'hub' | 'leaf' | 'mixed';
  renderMethod: 'http' | 'browser' | 'unknown';
  visited: boolean;
  status: 'discovered' | 'visiting' | 'visited' | 'error';
  errorMessage?: string;

  // === Breadcrumb hierarchy (author's intended structure) ===
  breadcrumbChain?: string[]; // ordered breadcrumb URLs if extracted

  // === Computed (derived from graph, recomputed on each snapshot) ===
  linkFrequency?: number; // how many visited pages link to this
  isGlobalLink?: boolean; // linkFrequency > 30% of total visited pages
}
```

**Persistence strategy:** The entire `discoveredPages` map is persisted to MongoDB on
every `tree-snapshot` event (not just at the end). This ensures:

- Graph relationships survive early stop / crash / SSE disconnection
- The tree can be reconstructed identically from persisted data on page reload
- Label metadata (title, breadcrumbLabel, linkText) accumulates incrementally as pages are visited

Persistence change: on each `tree-snapshot` event, persist both `treeHierarchy` AND `discoveredPages` (the flat graph) to MongoDB. Not just the tree.

### Layer 2: Tree View Algorithm (computed from graph)

The tree is a VIEW of the graph. Multiple views are possible.

**Default view: Hybrid tree**

For each URL, select parent using this priority:

1. **Breadcrumb parent** — if breadcrumb chain extracted, parent = previous crumb
2. **Non-global crawl parent (foundOn)** — a content page that links to this URL (not nav/footer). If multiple foundOn entries, prefer the one closest in URL-path to the child
3. **URL-path parent** — deterministic fallback based on path prefix matching
4. **Root** — orphan fallback

Global links (appearing on >30% of visited pages) skip step 2 — their foundOn is meaningless (random first-crawled page). They always use URL-path parent.

Virtual intermediate nodes synthesized for URL path segments without a real page.

**Secondary view: Crawl tree (toggle)**

Parent = first `foundOn` entry (discovery order). Shows actual reachability. Deeper, less stable.

### Layer 3: Frontend Tree Rendering

TreeNode enriched with provenance:

```typescript
interface TreeNode {
  url: string;
  label: string;
  children: TreeNode[];
  depth: number;
  visited: boolean;
  renderMethod: 'http' | 'browser' | 'unknown';
  pageRole?: 'hub' | 'leaf' | 'mixed';
  status: 'discovered' | 'visiting' | 'visited' | 'error';
  // NEW
  foundOn: string[]; // all parents (for cross-ref display)
  discoverySource: string; // how this was found
  isGlobalLink: boolean; // nav/footer link
  isVirtual: boolean; // synthetic folder node
  childPageCount: number; // for folder-level aggregation
}
```

### Node Label Strategy

The label is what the user sees in the tree. It must be a friendly, recognizable name — not a raw URL slug.

**Current problem:** Unvisited pages have no `<title>`, so they show raw slugs like `SPT_C11CJ67201~faq-00004ba-shared` or `sh_s1`. Most tree nodes are unvisited during discovery.

**Label priority (pick first available):**

```
1. Page title         — from <title> tag (available only for visited pages)
2. Breadcrumb text    — the label from the breadcrumb chain (e.g., "ET-2400 FAQs")
3. Link text          — anchor text from the page that linked to this URL
                        (e.g., <a href="/faq/123">Frequently Asked Questions</a>)
4. Humanized slug     — URL slug with cleanup: split on [-_~], title-case,
                        strip IDs/hashes (e.g., "faq-00004ba-shared" → "FAQ")
5. Raw path segment   — last resort, decoded URI component
```

**Why link text matters:** During discovery, we visit a parent page and extract its links. Each link has both a `href` and the **anchor text** the author chose. This is the most natural label for unvisited pages — it's what a human would see on the linking page.

**Implementation:** `DiscoveredPage` gains a `linkText?: string` field, populated from the first non-generic anchor text found (skip "click here", "read more", single characters). `buildTree()` uses the priority chain above.

**Virtual folder nodes:** Label = humanized path segment (e.g., `/printers/` → "Printers"). Shown with folder icon + child page count.

UI additions:

- Badge: "linked from 5 pages" (click to see list)
- Badge: "Global" for nav/footer links
- Folder icon + page count for virtual intermediate nodes
- Toggle: "Hybrid" (default, graph-informed) / "Crawl Path" (pure foundOn) / "URL Structure" (pure pathname)
- Tooltip on label: shows full URL (so user can always verify the actual page)

## Implementation Plan

### Step 1: Persist the graph (foundation)

**What:** On each `tree-snapshot`, persist `discoveredPages` (the flat `allUrls` map) alongside `treeHierarchy` in MongoDB.

**Why:** Graph data currently only persists via `result` event at the very end. If discovery stops/crashes, relationships are lost. The new tree algorithm depends on this data — it must survive restarts.

**Schema change:** Add `discoveredPages: DiscoveredPage[]` to `SiteDiscovery` model.

**Validation:** After discovery, reload the page. The tree should rebuild identically from persisted data.

### Step 2: Build the hybrid tree algorithm

**What:** Replace `buildTree()` with a graph-informed algorithm:

1. Compute `linkFrequency` and `isGlobalLink` for each URL
2. For each URL, select parent using priority chain (breadcrumb > non-global foundOn > URL-path > root)
3. Synthesize virtual intermediate nodes for path gaps
4. Enrich TreeNode with `foundOn`, `discoverySource`, `isGlobalLink`, `isVirtual`

**Validation:** Unit test with real epson.com data. FAQ pages should nest under the printer page that linked to them. Header/footer links should stay in URL-path positions.

### Step 3: Frontend rendering

**What:** Update frontend to display enriched TreeNode:

- Cross-reference badges
- Global link indicators
- Virtual folder nodes with aggregated counts
- Wire `onExploreNode` to `exploreBranch()`

**Validation:** Test on 3 sites — epson.com (cross-path links), a blog (clean URLs), a docs site (breadcrumbs).

### Step 4: Crawl-path toggle (secondary view)

**What:** Add view toggle in tree header. Crawl-path tree uses `foundOn[0]` as parent.

**Validation:** Compare URL-path and crawl-path trees for the same site — they should show meaningfully different hierarchies.

## Unified Discovery Model

### Principle: Discovery is the activity. Sources feed into it.

The tree is the single unified view. All URL sources feed into it:

```
Sources:                          Unified Tree:
  Primary page links ──────┐
  Seed/sample URLs ─────────┤
  BFS crawl ────────────────┤──→  One tree. One selection UI.
  Breadcrumb climb ─────────┤     Every node shows its source.
  User command ─────────────┤     User explores from any node.
  Sitemap (explicit add) ──┘
```

### Strategy Selection Flow

```
Step 2: Strategy Selection
  ├── "Sitemap"           → flat section UI (existing, unchanged by V2)
  └── "Guided Discovery"  → BFS tree (V2)
                                │
                    "Add from Sitemap" button in tree header
                    (explicit, user-initiated — NOT auto-loaded)
```

**Why not auto-load sitemap?** The user explicitly chose "Guided Discovery" over
"Sitemap" at Step 2. Auto-loading sitemap URLs would contradict their choice.
Instead, sitemap is available as an explicit "boost" — user clicks "Add from Sitemap",
sees a preview ("Sitemap has 4,200 URLs. Add to discovery tree?"), and confirms.

### "Add from Sitemap" Flow

1. User clicks "Add from Sitemap" button in tree header (available during or after discovery)
2. Frontend calls existing sitemap parsing API (no backend changes needed)
3. Preview shown: URL count, top-level path groups, estimated tree impact
4. User confirms → sitemap URLs merge into `allUrls` map with `discoverySource: 'sitemap'`
5. Tree rebuilds — sitemap URLs appear as nodes with "Sitemap" badge
6. Smart exclusion patterns (/login, /cart, /api/) applied at import → `included: false` by default
7. User can click "Explore Branch" on any sitemap-sourced node → BFS visits it, enriches it

### Selection → Crawl Flow (unified)

After V2, both paths end the same way:

```
Tree (with checkboxes) → treeToSections() → CrawlSection[] → State 3 Configure → Crawl

treeToSections() handles:
  - Virtual folder selected → aggregate all children as one section
  - Individual page selected → standalone section
  - Mixed sources (sitemap + bfs) → source tracked per section
  - Exclude patterns → nodes with included:false skipped
```

The "Sitemap" strategy path is untouched — it keeps its flat section UI.
Only "Guided Discovery" gets the unified tree with "Add from Sitemap" option.

## Out of Scope (this iteration)

- Full graph visualization (Gephi-style force-directed)
- Metrics-per-folder aggregation (Ahrefs/Lumar pattern)
- Per-page inlinks table (Screaming Frog "Inlinks" tab)
- Content-links-only toggle (filter out nav links from crawl tree)
- Auto-loading sitemap into discovery (user must explicitly add)
- Changing the "Sitemap" strategy path (flat section UI stays as-is)

## User Scenarios

### Scenario A — Live Discovery

User enters a URL and watches discovery run in real time.

**Happy path:**

1. User enters `epson.com/Support/Printers/sh/s1` and 3 sample URLs (FAQ pages)
2. Phase 0 starts — user sees "Loading primary page…" activity within 2-3s (H-5 fixed — no 100s dead zone)
3. Primary page loads — tree shows root node with discovered children, organized by hybrid hierarchy
4. Phase 1a visits seed/sample URLs — FAQ pages appear nested under the printer product page that links to them (not flat under root — C-1 fixed)
5. Tree updates every 5s during ALL phases including 1a/1b/2 (M-6 fixed)
6. User sees badges: "seed" on sample URLs, "HTTP"/"Browser" render method, page role icons (M-13, M-10 fixed)
7. User notices a branch they want explored deeper → clicks "Explore Branch" → BFS explores it (C-2 fixed)
8. Global nav links (/Store, /Ink, /Support) are badged "Global" and dimmed — they don't pollute the tree (H-3 fixed)
9. Phase 1b visits at most 50 URLs per seed, doesn't run away (M-4 fixed)
10. If discovery takes too long, 10-minute timeout stops it cleanly (M-5 fixed)

**Error paths:**

- Playwright context destroyed mid-page → that page marked as error, discovery continues (already fixed)
- SSE connection drops → frontend shows "reconnecting…" with last-known tree state preserved
- User clicks Stop → graph persisted up to that point, tree loads correctly on reload
- Single page failure → discovery continues with remaining URLs (already fixed)

**What the user should NEVER see:**

- "s1" as the only tree node for 100 seconds (H-5)
- FAQ pages flat under root with no relationship to the printer page (C-1)
- "Explore Branch" button that does nothing (C-2)
- Discovery killed by a single page failure (already fixed)
- Discovery running forever with no timeout (M-5)
- Tree only updating at end of phase, not during (M-6)

### Scenario B — Selection

Discovery complete. User reviews the tree and selects what to crawl.

**Happy path:**

1. Tree shows complete hierarchy: `Support > Printers > All-In-Ones > ET-Series > ET-2400 > [FAQ pages]`
2. Virtual folder nodes show page counts: "All-In-Ones (47 pages)" — with folder icon and checkbox
3. User expands a branch, sees individual pages with friendly labels (title > breadcrumb > link text > humanized slug — M-2 fixed)
4. User checks a virtual folder → all children selected. Estimated plan updates: "47 pages, ~12s"
5. Cross-referenced pages show "linked from 3 pages" badge (click to see list — M-3 fixed)
6. Global nav links are clearly badged "Global" — user knows not to select "/Store" (H-3 fixed)
7. Sample URLs are highlighted with "seed" badge (M-10 fixed)
8. Error nodes show full error message on tooltip hover (M-12 fixed)
9. User hovers any label → tooltip shows full URL for verification
10. User can toggle between "Hybrid" / "Crawl Path" / "URL Structure" views
11. User clicks "Configure Crawl" → `treeToSections()` converts selected tree to `CrawlSection[]` → State 3

**What the user should NEVER see:**

- 200 pages flat under root because URL paths don't match (C-1)
- FAQ page titles showing as `SPT_C11CJ67201~faq-00004ba-shared` (M-2)
- No way to understand why a page is in the tree (M-3)
- pageRole data collected but invisible (M-13)
- Virtual folder with no checkbox (can't select a whole branch)
- childUrls count hidden when available (L-8)

### Scenario C — Recrawl (return visit)

User returns days later to recrawl specific pages or add new sections.

**Happy path:**

1. User navigates to the Knowledge Base → Web Crawl page
2. Previous discovery tree loads from MongoDB — same hierarchy they saw during live discovery
3. The tree is built from persisted graph data (`discoveredPages`), not just `treeHierarchy` (H-4 fixed)
4. All metadata preserved: foundOn, discoverySource, linkText, breadcrumbLabel, pageRole (H-1 fixed)
5. User navigates: `Support > Printers > ET-2400 > FAQs` — this is a stable address
6. User selects just the FAQ section for recrawl → only those pages are re-fetched
7. If the site structure changed, user can re-run discovery — new tree reflects new structure

**What the user should NEVER see:**

- A different tree hierarchy than what they saw during live discovery (H-4 — graph data lost)
- Missing pages because `discoveredUrls` wasn't persisted (discovery was stopped early)
- Broken tree because `foundOn`/`childUrls` weren't saved (H-1)
- Labels reverting to URL slugs because linkText/breadcrumbLabel weren't persisted

### Scenario D — Add from Sitemap (NEW)

User is in Guided Discovery and wants to augment the tree with sitemap data.

**Happy path:**

1. User chose "Guided Discovery" at Step 2. BFS is running (or complete).
2. User clicks "Add from Sitemap" button in tree header
3. Preview dialog shows: "Sitemap has 4,200 URLs across 12 top-level paths. Add to discovery tree?"
4. User confirms → sitemap URLs merge into tree with "Sitemap" badge on each node
5. Smart exclusion patterns auto-applied: /login, /cart, /api/ nodes default to `included: false`
6. Sitemap nodes appear as discovered (unvisited) — humanized slug labels
7. User expands a sitemap branch → sees folder structure with page counts
8. User clicks "Explore Branch" on a sitemap folder → BFS visits those pages → labels upgrade to titles, pageRole detected, children discovered
9. After exploration, sitemap-sourced pages now have full metadata like any BFS-discovered page

**What the user should NEVER see:**

- Sitemap URLs auto-loaded without user asking for it
- Sitemap URLs replacing the discovery tree (they MERGE into it)
- Duplicate nodes when sitemap URL was already BFS-discovered (dedup by normalized URL)
- No indication of which nodes came from sitemap vs BFS
- Excluded patterns (/login, /cart) pre-selected for crawling

### Scenario E — Selection to Crawl Handoff (NEW)

User has finished discovery (with or without sitemap augmentation) and proceeds to crawl.

**Happy path:**

1. User has selected nodes in the tree (mix of virtual folders, individual pages, different sources)
2. User clicks "Configure Crawl" button in tree footer
3. `treeToSections()` converts tree to `CrawlSection[]`:
   - Selected virtual folder "All-In-Ones" → one section with pattern `/Support/Printers/All-In-Ones/*`, 47 pages
   - Selected individual page → standalone section
   - Source tracked per section: `'sitemap'`, `'explored'`, `'auto'`
   - Strategy per section: `'http'` or `'browser'` based on `renderMethod`
4. State 3 (Configure) shows the sections with familiar UI (existing, unchanged)
5. User reviews and starts crawl → only selected URLs are fetched

**What the user should NEVER see:**

- Virtual folder selected but its children not included in crawl
- Section with 0 pages (empty selection)
- Loss of rendering strategy (browser page crawled as HTTP)
- Duplicate URLs across sections
- Section names showing URL slugs instead of friendly names

## Bugs Addressed Per Layer

### Layer 1: Graph Storage — 1 bug

| Bug | Severity | What                                          |
| --- | -------- | --------------------------------------------- |
| H-4 | HIGH     | `discoveredUrls` lost on non-clean completion |

### Layer 2: Tree Algorithm — 9 bugs

| Bug | Severity | What                                         |
| --- | -------- | -------------------------------------------- |
| C-1 | CRITICAL | Web graph forced into single-parent tree     |
| C-2 | CRITICAL | `explore-branch` commands silently discarded |
| H-1 | HIGH     | `foundOn` data dropped in serialization      |
| H-3 | HIGH     | Common/global URLs not differentiated        |
| H-5 | HIGH     | 60-100s dead zone Phase 0                    |
| H-6 | HIGH     | Full tree rebuild O(n log n) every snapshot  |
| M-1 | MEDIUM   | Breadcrumbs not used for tree building       |
| M-2 | MEDIUM   | URL slug labels (virtual folder nodes help)  |
| M-4 | MEDIUM   | Phase 1b unbounded — no per-phase budget     |
| M-5 | MEDIUM   | No overall discovery timeout                 |
| M-6 | MEDIUM   | No tree snapshots during Phase 1a/1b/2       |

### Layer 3: Frontend Rendering — 6 bugs

| Bug  | Severity | What                                        |
| ---- | -------- | ------------------------------------------- |
| M-3  | MEDIUM   | No "why was this page found?" in tree nodes |
| M-7  | MEDIUM   | `onExploreNode` dead in BFS mode            |
| M-13 | MEDIUM   | `pageRole` available but not rendered       |
| M-10 | MEDIUM   | Sample URLs not highlighted in tree         |
| M-12 | MEDIUM   | Error messages truncated, no tooltip        |
| L-8  | LOW      | `childUrls` count not displayed             |

### Layer 4: Crawl-Path Toggle — new feature, no existing bugs

### Layer 5: Unified Selection — new features

| Feature                  | What                                                     |
| ------------------------ | -------------------------------------------------------- |
| Virtual folder checkbox  | Select folder → select all children                      |
| treeToSections() update  | Handle virtual folders, aggregate children into sections |
| "Add from Sitemap"       | Explicit button to merge sitemap URLs into discovery     |
| Smart exclusion defaults | /login, /cart, /api/ auto-excluded at import             |

## Bugs NOT Addressed (separate work)

| Bug     | Severity | What                                     | Why deferred                                      |
| ------- | -------- | ---------------------------------------- | ------------------------------------------------- |
| H-2     | HIGH     | Nav structure never integrated           | Nav extraction broken (H-7). Fix extraction first |
| H-7     | HIGH     | `__name` bug in nav-extractor            | esbuild/Playwright issue, separate fix            |
| H-8     | HIGH     | SSE reconnection always fails            | SSE infrastructure, not tree-related              |
| M-8/M-9 | MEDIUM   | `undo-skip`/`add-sample` not implemented | Command handling, separate                        |
| M-11    | MEDIUM   | Sitemap nav may not restore page         | Nav-extractor resilience, separate                |

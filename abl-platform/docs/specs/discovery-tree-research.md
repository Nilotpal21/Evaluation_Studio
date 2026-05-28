# Discovery Tree Research: How Crawl Tools Solve Graph-to-Tree

> Research into how existing web crawling and site audit tools represent a web crawl graph
> (multi-parent, cross-links) as a navigable tree for users.
>
> Date: 2026-05-11

---

## Executive Summary

Every crawl tool faces the same fundamental problem: a website is a **directed graph** (pages link
to many others, pages are linked from many parents), but users need a **tree** to navigate and
understand structure. The industry has converged on **two parallel tree projections** offered
side-by-side, not a single "correct" tree:

| Projection                              | Hierarchy Signal                              | Strengths                                                     | Weaknesses                                                         |
| --------------------------------------- | --------------------------------------------- | ------------------------------------------------------------- | ------------------------------------------------------------------ |
| **URL-path (directory) tree**           | URL path segments (`/blog/2024/post`)         | Stable, deterministic, matches user mental model of "folders" | Ignores actual link structure; flat URL schemes produce flat trees |
| **Crawl-path (BFS shortest-path) tree** | First-discovered shortest link path from seed | Reflects how bots/users actually reach pages                  | Non-deterministic (depends on crawl order); changes between crawls |

No mainstream tool attempts to show the **full link graph as a tree** — they all reduce it.
A few tools add a third signal (**breadcrumbs / structured data**) as an override for business-
defined hierarchy that diverges from both URL paths and crawl paths.

---

## Tool-by-Tool Analysis

### 1. Screaming Frog SEO Spider

**Primary hierarchy signals:**

- **Directory Tree**: Pure URL-path decomposition. Splits each URL into protocol → hostname →
  path segments. Each segment becomes a node. Hierarchy = nesting of path components.
- **Crawl Tree**: BFS shortest-path from the start URL. Shows the single shortest link-hop path
  to each page. Hierarchical by crawl depth (link distance from seed).
- **Breadcrumb reconstruction** (advanced): Custom extraction of on-page breadcrumbs + Python
  script to build a tree from breadcrumb trails. Screaming Frog's own blog describes this as
  producing a "more accurate representation of a site's true structure" than either URL paths
  or crawl paths alone, because breadcrumbs reflect "business logic & information architecture."

**Multi-parent handling:**

- Crawl tree shows **only one path per page** — the shortest. If multiple links exist at the
  same minimum depth, the **first-crawled link wins**. Cross-links and secondary parents are
  simply not shown in the tree view.
- No badge, annotation, or count of alternative parents. Users must switch to the "Inlinks" tab
  (flat table) to see all parents.

**Global/nav links:**

- No differentiation. Navigation links, footer links, and content links are all treated
  identically. Because nav links appear on every page, they tend to make crawl depth very
  shallow (most pages are depth 1-2), which compresses the crawl tree into a flat star.

**Virtual intermediate nodes:**

- **Yes**, in directory tree mode. Path segments that don't correspond to a real URL still appear
  as nodes to group children. Example: `/author/` may not resolve as a page, but it appears as
  a grouping node containing `/author/alice/`, `/author/bob/`, etc.

**Scale:** Visualizations cap at ~10k nodes in-browser; users can right-click → "Focus" to
expand a subtree (loading another 10k).

**Key insight from Screaming Frog's own analysis:** "URL structures may reflect historical or
technical constraints rather than current category logic." This is the core argument for
breadcrumb-based hierarchy over URL-path hierarchy.

---

### 2. Sitebulb

**Primary hierarchy signals:**

- **Crawl Tree / Crawl Map**: Parent = the page where the URL was **first discovered** during
  crawl. This is similar to BFS but specifically tracks discovery order, not shortest path.
- **Directory Tree / Directory Map**: Pure URL-path decomposition, same as Screaming Frog.

**Multi-parent handling:**

- Explicitly documented: "only includes the **first discovered link location**." Secondary
  parents are discarded in the visualization. The crawl map "is not a link map" — it is a
  discovery tree.
- No cross-link annotations or badges.

**Global/nav links:**

- Not differentiated. Same flattening problem as Screaming Frog.

**Virtual intermediate nodes:**

- **Yes**, in Directory Map mode. Documentation confirms: "can include nodes that do not resolve
  (or 'exist' as real URLs) but are necessary for the directory grouping."

**Visualization formats:**

- **Force-directed graph** (crawl map): Nodes spread by physics simulation. Good for spotting
  clusters, orphans, pagination chains. Not a tree — shows structure but not hierarchy.
- **Tree layout** (crawl tree / directory tree): Strict hierarchical branching. Can become
  unreadable on large sites.
- Color-coding by crawl depth (deeper = different color).

**Key insight:** Sitebulb treats crawl map and tree as complementary — the map reveals clusters
and structural anomalies; the tree reveals depth and hierarchy. Users toggle between them.

---

### 3. Ahrefs Site Audit / Site Explorer

**Primary hierarchy signal:**

- **Pure URL-path decomposition**. The "Site Structure" and "Structure Explorer" reports show
  subdomains and subfolders in a tree, with metrics aggregated per folder.
- **No crawl-path tree.** Ahrefs does not offer a crawl-order or BFS-based tree view.

**Multi-parent handling:**

- Not applicable — since the tree is URL-path-based, each URL has exactly one parent (its
  containing folder). There is no concept of "discovery parent."
- Inlink data is available separately in other reports.

**Global/nav links:**

- Not relevant to the URL-path tree. Internal linking metrics exist elsewhere but do not
  influence the tree structure.

**Virtual intermediate nodes:**

- **Yes, implicitly.** Clicking a folder expands subfolders. Folders that exist only as path
  prefixes (no index page) still appear as grouping nodes.

**Unique strength:**

- Aggregated metrics per folder: HTTP status distribution, organic traffic, referring domains,
  link depth. This makes the tree useful for **section-level analysis** (e.g., "which subfolder
  drives the most traffic?") rather than per-page inspection.
- Works **without running a crawl** — built from Ahrefs' global index.

---

### 4. Google Search Console

**Primary hierarchy signal:**

- GSC does **not provide a tree visualization** of site structure. It offers:
  - **Sitemaps** — user-submitted XML sitemaps (flat list, optional priority hints).
  - **URL Inspection** — per-URL crawl/index status.
  - **Crawl Stats** — aggregate request counts by response code, file type, Googlebot type.
- Google's own documentation states it "generally doesn't look at the structure of URLs to work
  out the structure of a site" — it uses **internal linking, breadcrumbs schema,
  SiteNavigationElement schema, and sitemap priority** as signals.

**Third-party extensions:**

- "Advanced GSC Visualizer" (Chrome extension) adds folder-based hierarchy exploration on top
  of GSC data, grouping by URL path segments.

**Key insight for our design:** Google's multi-signal approach (links + breadcrumbs + schema +
sitemaps, with URL structure as a weak signal) is the most sophisticated model. It suggests
that a good tree should **fuse multiple signals** rather than relying on any single one.

---

### 5. Lumar (formerly DeepCrawl)

**Primary hierarchy signal:**

- **Site Explorer**: Pure URL-path tree. "Each path in the URL, starting with `/` or parameters
  starting with `?` or `&`, creates a new entry in the tree, and all the URLs located under the
  same path are grouped together."
- Lumar explicitly acknowledges the limitation: "a URL structure doesn't necessarily represent
  the site's architecture, which is primarily defined by internal linking."

**Multi-parent handling:**

- Not shown in the tree. The URL-path tree inherently has single parents.
- Internal linking metrics are overlaid as aggregates (average inlinks/outlinks per section)
  rather than as parent-child edges.

**Global/nav links:**

- Not differentiated, but the **Internal Linking mode** shows average followed links in/out per
  section, which can surface sections that are over-linked (likely due to global nav) vs.
  under-linked.

**Virtual intermediate nodes:**

- Documentation unclear, but the path-splitting algorithm implies intermediate path segments
  become grouping nodes.

**Multiple overlay modes** (same tree, different metrics):
| Mode | Metrics | When available |
|---|---|---|
| Default | Fetch time, word count, general | Always |
| Internal Linking | Avg links in/out, followed/nofollowed | Always |
| Engagement | Bounce rate, time on page | With analytics integration |
| Backlinking | Linking domains, backlinks per page | With backlink data |

---

### 6. PowerMapper

**Primary hierarchy signal:**

- Crawl-path based. Builds a tree from the link graph discovered during crawling.
- Offers multiple layout styles: org-chart tree, expanding table-of-contents, page cloud
  (force-directed clusters around parent), isometric 3D.

**Multi-parent handling:**

- Not documented in detail. Likely single-parent (first-discovered) given the tree layouts.

**Unique feature:**

- Visual thumbnails of each page rendered inline in the tree, making it more of a "visual
  sitemap" than a structural analysis tool.

---

### 7. Academic / Algorithmic Background

**BFS Shortest-Path Tree (SPT):**

- The standard algorithm behind crawl trees. In an unweighted graph, BFS produces the shortest-
  path spanning tree where each node's depth = minimum link distance from root.
- Research confirms: "the structure of unweighted networks is best preserved by an algorithm
  using breadth-first search node traversal" — BFS spanning trees preserve inter-node distances
  better than DFS or random spanning trees.
- For web graphs, BFS-SPT is the natural choice because link hops are the meaningful distance
  metric.

**Web bow-tie structure (Broder et al.):**

- The web graph has a characteristic "bow-tie" shape: a giant strongly-connected component
  (GSCC) with IN (pages that link to GSCC but aren't linked back) and OUT (pages linked from
  GSCC but don't link back) regions.
- Navigation links create the GSCC — they are the dense, bidirectional core. Content links tend
  to be unidirectional and sparser.
- Implication: filtering out nav links would break the GSCC and reveal the sparser, more
  tree-like content structure underneath.

**Gephi / Network Analysis:**

- Gephi is the standard open-source tool for full graph visualization. Supports edge filtering
  by weight, type, reciprocity. Force-directed layouts (ForceAtlas2).
- SEO practitioners export Screaming Frog crawl data into Gephi when they need the full graph
  view (not just a tree). Gephi handles cross-links natively but doesn't produce trees.

---

## Comparison Matrix

| Feature                        | Screaming Frog              | Sitebulb                   | Ahrefs                         | Google SC               | Lumar                          | PowerMapper        |
| ------------------------------ | --------------------------- | -------------------------- | ------------------------------ | ----------------------- | ------------------------------ | ------------------ |
| **URL-path tree**              | Yes                         | Yes                        | Yes (primary)                  | No (3rd-party ext.)     | Yes (primary)                  | No                 |
| **Crawl-path tree**            | Yes (BFS shortest)          | Yes (first-discovered)     | No                             | No                      | No                             | Yes                |
| **Breadcrumb/schema tree**     | Yes (custom extraction)     | No                         | No                             | Signals used internally | No                             | No                 |
| **Full graph view**            | Force-directed diagram      | Force-directed crawl map   | No                             | No                      | No                             | Page cloud         |
| **Multi-parent shown**         | No (first path only)        | No (first discovery only)  | N/A (URL tree)                 | N/A                     | N/A (URL tree)                 | No                 |
| **Virtual intermediate nodes** | Yes                         | Yes                        | Yes                            | N/A                     | Implied                        | Unknown            |
| **Nav/footer link filtering**  | No                          | No                         | No                             | N/A                     | No                             | No                 |
| **Metrics per node**           | Status, depth, indexability | Status, depth, color-coded | Traffic, backlinks, status     | Index status only       | Fetch time, links, engagement  | Thumbnails         |
| **Scale limit**                | ~10k nodes in-browser       | Large sites get messy      | Unlimited (folder aggregation) | N/A                     | Unlimited (folder aggregation) | Small-medium sites |

---

## Key Takeaways for Our Design

### 1. Offer Two Trees, Not One

Every serious tool offers **both** a URL-path tree and a crawl-path tree. They answer different
questions:

- **URL-path tree**: "What is the site's folder structure?" — stable, deterministic, good for
  section-level analysis and content organization.
- **Crawl-path tree**: "How did the crawler actually reach pages?" — reveals actual reachability,
  orphan pages, deep-buried content.

**Recommendation:** Build the URL-path tree as the **primary/default** view (stable, fast to
compute, matches user expectations). Offer crawl-path tree as a secondary "Crawl View" toggle.

### 2. The Multi-Parent Problem is "Solved" by Ignoring It

No tool shows multiple parents in the tree. They all pick one parent (first-discovered or
URL-path) and discard the rest. Cross-links and secondary parents are visible only in separate
flat-table or graph views.

**Recommendation:** Same approach. Show one canonical parent per page in the tree. Add an
"Inlinks" detail panel or badge count (e.g., "linked from 5 pages") so users know cross-links
exist without cluttering the tree.

### 3. Virtual Intermediate Nodes are Essential

Both Screaming Frog and Sitebulb create **synthetic grouping nodes** for URL path segments that
don't correspond to real pages. This is critical for usability — without them, hundreds of pages
would be flat children of the root.

**Recommendation:** Always create virtual directory nodes from URL path segments. Display them
with a folder icon and aggregate child metrics.

### 4. Nobody Filters Navigation Links (But They Should)

No mainstream tool differentiates navigation links from content links in the tree. This causes
the crawl tree to be artificially shallow (everything is depth 1-2 because of global nav). The
academic bow-tie research suggests filtering nav links would reveal a more meaningful content
structure.

**Recommendation:** This is an opportunity for differentiation. If we can identify nav/footer
links (links that appear on >N% of pages), we could offer a "Content Links Only" toggle that
produces a deeper, more meaningful crawl tree.

### 5. Breadcrumbs Provide the Best Hierarchy Signal

Screaming Frog's own research concludes that breadcrumb-based hierarchy is more accurate than
both URL paths and crawl paths for representing the site's intended structure. URL paths reflect
"historical or technical constraints," while breadcrumbs reflect "business logic & information
architecture."

**Recommendation:** If breadcrumb data is available (via structured data or DOM extraction),
use it as the **primary** hierarchy signal, with URL-path as fallback. This gives us a third,
more accurate tree: the "Logical Structure" tree.

### 6. Metrics-per-Folder is a Killer Feature

Ahrefs and Lumar's strength is aggregating metrics (traffic, status codes, link counts) at the
folder level. This turns the tree from a navigation aid into an analytical tool.

**Recommendation:** Show aggregate metrics on virtual directory nodes: page count, status
distribution, average extraction quality, crawl coverage percentage.

### 7. Scale Requires Folder-Level Aggregation

Tools that try to show every page in the tree (Screaming Frog, Sitebulb) hit UX walls at
~10k nodes. Tools that show folder-level aggregation (Ahrefs, Lumar) scale to any size.

**Recommendation:** Default to collapsed folder view with counts. Expand on click. Never try to
render the full page-level tree at once.

---

## Hierarchy Signal Priority (Recommended for Our Design)

```
1. Breadcrumbs / structured data  (if available — highest fidelity)
2. URL path segments              (always available — deterministic fallback)
3. Crawl-path BFS shortest path   (secondary view — shows actual reachability)
4. Sitemap structure              (if provided — author's intended structure)
```

Each signal can produce a different tree from the same graph. The UI should let users switch
between them, with URL-path as the default.

---

## Sources

- [Screaming Frog — Site Architecture & Crawl Visualisations Guide](https://www.screamingfrog.co.uk/seo-spider/tutorials/site-architecture-crawl-visualisations/)
- [Screaming Frog — How to Use Visualisation Tools](https://www.screamingfrog.co.uk/blog/how-to-use-screaming-frog-visualisations/)
- [Screaming Frog — Reconstructing Site Architecture Using Breadcrumbs](https://www.screamingfrog.co.uk/blog/reconstructing-site-architecture-using-breadcrumbs/)
- [Sitebulb — Site Visualisations Documentation](https://support.sitebulb.com/en/articles/9887437-site-visualisations)
- [Sitebulb — Crawl Maps Product Page](https://sitebulb.com/product/crawl-maps/)
- [Ahrefs — Structure Explorer](https://ahrefs.com/academy/how-to-use-ahrefs/site-audit/structure-explorer)
- [Ahrefs — Site Structure Report](https://ahrefs.com/academy/how-to-use-ahrefs/site-explorer/site-structure)
- [Lumar — Site Explorer Feature](https://www.lumar.io/blog/company-news/site-explorer-in-deepcrawl-2/)
- [Google Search Console — Crawl Stats Report](https://support.google.com/webmasters/answer/9679690)
- [PowerMapper — Website Structure Visualization](https://www.powermapper.com/products/mapper/maps/website-structure/)
- [Wikipedia — Shortest-path tree](https://en.wikipedia.org/wiki/Shortest-path_tree)
- [Springer — Local bow-tie structure of the web](https://link.springer.com/article/10.1007/s41109-019-0127-2)
- [Gephi — The Open Graph Viz Platform](https://gephi.org/)

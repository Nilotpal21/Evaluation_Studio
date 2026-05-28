# Discovery Tree V2 — High-Level Design

> **Ticket**: ABLP-71
> **Proposal**: `docs/specs/discovery-tree-v2-proposal.md`
> **Research**: `docs/specs/discovery-tree-research.md`
> **Audit**: `.claude/agent-memory-local/architect/project_discovery_engine_audit.md`
> **Date**: 2026-05-11

---

## Scope Lock

Every review round (HLD, LLD, implementation, PR review) MUST verify this checklist.
Nothing gets added or dropped without explicit user approval.

### Bugs IN Scope (19 items)

| ID   | Sev      | What                                          | Layer   |
| ---- | -------- | --------------------------------------------- | ------- |
| C-1  | CRITICAL | Web graph forced into single-parent tree      | Layer 2 |
| C-2  | CRITICAL | `explore-branch` commands silently discarded  | Layer 2 |
| H-1  | HIGH     | `foundOn` data dropped in serialization       | Layer 2 |
| H-3  | HIGH     | Common/global URLs not differentiated         | Layer 2 |
| H-4  | HIGH     | `discoveredUrls` lost on non-clean completion | Layer 1 |
| H-5  | HIGH     | 60-100s dead zone Phase 0                     | Layer 2 |
| H-6  | HIGH     | Full tree rebuild O(n log n) every snapshot   | Layer 2 |
| M-1  | MEDIUM   | Breadcrumbs not used for tree building        | Layer 2 |
| M-2  | MEDIUM   | URL slug labels — no friendly names           | Layer 2 |
| M-3  | MEDIUM   | No "why was this page found?" in tree nodes   | Layer 3 |
| M-4  | MEDIUM   | Phase 1b unbounded — no per-phase budget      | Layer 2 |
| M-5  | MEDIUM   | No overall discovery timeout                  | Layer 2 |
| M-6  | MEDIUM   | No tree snapshots during Phase 1a/1b/2        | Layer 2 |
| M-7  | MEDIUM   | `onExploreNode` dead in BFS mode              | Layer 3 |
| M-10 | MEDIUM   | Sample URLs not highlighted in tree           | Layer 3 |
| M-12 | MEDIUM   | Error messages truncated, no tooltip          | Layer 3 |
| M-13 | MEDIUM   | `pageRole` available but not rendered         | Layer 3 |
| L-8  | LOW      | `childUrls` count not displayed               | Layer 3 |
| NEW  | —        | Crawl-path toggle (secondary view)            | Layer 4 |

### Features IN Scope (from design discussion) — 12 core + 4 Layer 5

| Feature                    | Description                                                         | Layer |
| -------------------------- | ------------------------------------------------------------------- | ----- |
| Graph persistence          | Persist `discoveredPages` on every snapshot, not just final result  | 1     |
| Hybrid tree algorithm      | Breadcrumb > non-global foundOn > URL-path > root priority          | 2     |
| Virtual intermediate nodes | Synthesize folder nodes for path gaps                               | 2     |
| Global link detection      | Identify nav/footer links (>30% of visited pages)                   | 2     |
| Label priority chain       | title > breadcrumbLabel > linkText > humanized slug > raw segment   | 2     |
| Link text capture          | New `linkText` field on DiscoveredPage from anchor text             | 2     |
| Discovery source tracking  | New `discoverySource` field tracking which phase found each URL     | 2     |
| Enriched TreeNode          | foundOn, discoverySource, isGlobalLink, isVirtual, childPageCount   | 3     |
| Frontend provenance        | Badges for foundOn count, Global, discovery source, pageRole        | 3     |
| Tree view toggle           | Hybrid (default) / Crawl Path / URL Structure                       | 3     |
| Phase budgets              | Per-phase budget for 1b; overall discovery timeout                  | 2     |
| Phase 0 activity           | Sub-phase messages during Playwright loading (eliminates dead zone) | 2     |
| Virtual folder checkbox    | Select folder = select all children (recursive)                     | 5     |
| `treeToSections()` update  | Handle V2 tree shape: virtual folders → aggregated sections         | 5     |
| "Add from Sitemap" button  | Explicit, user-initiated post-discovery merge on frontend           | 5     |
| Smart exclusion defaults   | /login, /cart, /api/ auto-excluded at sitemap import                | 5     |

### Wiring Gaps (discovered during end-to-end audit — must fix in V2)

These are existing wiring issues that V2's new tree shape (virtual folders, mixed sources) would
either expose or worsen. Each is assigned to a task for LLD tracking.

| ID   | Sev      | Gap                                                    | Root Cause                                                                         | Task |
| ---- | -------- | ------------------------------------------------------ | ---------------------------------------------------------------------------------- | ---- |
| G-1  | CRITICAL | Virtual folder checkbox hidden                         | `UnifiedTreeNodeRow` requires `status: 'explored'` for checkbox — virtual = hidden | T-5  |
| G-2  | CRITICAL | Selection not recursive                                | `toggleNodeIncluded` called without `recursive: true` — folder check ≠ child check | T-5  |
| G-3  | CRITICAL | `treeToSections()` skips virtual folders               | Requires `status: 'explored'` + `pageCount > 0` — virtual folders fail both        | T-7  |
| G-4  | CRITICAL | `nodeToSection()` can't aggregate children             | Reads `node.pages` directly — virtual folder has no pages, children do             | T-7  |
| G-5  | CRITICAL | Discovery sections have no draft bucket URLs           | `handleSectionsChange` never calls `persistSectionUrls` for discovery path         | T-7  |
| G-6  | MEDIUM   | UrlGroup shape mismatch (API vs merge function)        | `mergeSitemapGroups` expects `{urls}`, cluster-urls returns `{examples}`           | T-7  |
| G-7  | MEDIUM   | Three different URL normalizers                        | `url-set.ts`, `pattern-matcher.ts`, `url-normalizer.ts` behave differently         | T-7  |
| G-8  | MEDIUM   | No smart exclusion patterns exist                      | No `/login`, `/cart`, `/api/` filter anywhere in codebase                          | T-7  |
| G-9  | MEDIUM   | `computeTreeStats` double-counts with virtual folders  | Sums `pageCount` per included node — virtual + children = 2×                       | T-5  |
| G-10 | MEDIUM   | sectionId instability across re-renders                | `treeToSections` assigns sequential `sec-{index}` — changes on tree mutation       | T-7  |
| G-11 | LOW      | Dead code `handleConfigureCrawl` in State2Analysis     | L774 defined but never called — orphaned from refactor                             | T-5  |
| G-12 | LOW      | `derivePattern` produces label-slugs for virtual nodes | Pattern `/all-in-ones/*` ≠ real URL `/Support/Printers/All-In-Ones/*`              | T-7  |

### Bugs NOT in Scope (deferred — verified with user)

| ID      | Sev    | What                                     | Why deferred                           |
| ------- | ------ | ---------------------------------------- | -------------------------------------- |
| H-2     | HIGH   | Nav structure never integrated           | Nav extraction broken (H-7). Fix first |
| H-7     | HIGH   | `__name` bug in nav-extractor            | esbuild/Playwright, separate fix       |
| H-8     | HIGH   | SSE reconnection always fails            | SSE infra, not tree-related            |
| M-8/M-9 | MEDIUM | `undo-skip`/`add-sample` not implemented | Command handling, separate             |
| M-11    | MEDIUM | Sitemap nav may not restore page         | Nav-extractor resilience, separate     |

### Build 3 Items NOT in Scope (remain for future)

| Feature               | Description                                     |
| --------------------- | ----------------------------------------------- |
| Direct URLs mode      | Paste textarea + "Add from Sitemap" expansion   |
| Quick-select patterns | System-detected URL patterns with checkboxes    |
| Custom glob filter    | User types pattern, matches highlight           |
| Recrawl workflow      | Reuse selected URLs from tenant's source config |
| Rediscover workflow   | Re-run BFS, update generic layer                |
| E2E tests             | Complete flow tests for discovery               |

---

## What

Replace the URL-pathname-only `buildTree()` with a **graph-informed hybrid tree algorithm**
that uses crawl relationships (`foundOn`, `childUrls`, breadcrumbs) to produce meaningful
hierarchies. Persist the crawl graph incrementally so it survives stops/crashes. Enrich
frontend tree nodes with provenance data so users understand why each page is in the tree.

### Why

The current tree ignores 75% of the data we collect. A FAQ page linked from 5 printer pages
appears under one arbitrary URL-path parent. Cross-path pages become orphans. Navigation links
pollute the root. Users see URL slugs instead of page titles. The tree is rebuilt identically
whether we have graph data or not — making the graph collection pointless.

After testing on epson.com, we found 39 problems (2 CRITICAL, 8 HIGH, 13 MEDIUM, 8 LOW).
This V2 addresses 19 of them — all that relate to graph storage, tree algorithm, and frontend
rendering. The remaining 5 are deferred due to independent root causes (nav extraction, SSE
infra, command handling).

---

## Architecture Approach

### Packages Changed

| Package                   | Changes                                                                                                                                                                                                  | Scope                   |
| ------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------- |
| `packages/database`       | Extend `ITreeNode` with V2 fields. Add `discoverySource`, `linkText`, `breadcrumbLabel` to `IDiscoveredPage`                                                                                             | Schema                  |
| `apps/crawler-mcp-server` | Replace `buildTree()` with hybrid algorithm. Add `discoverySource`/`linkText` capture. Fix C-2 (explore-branch). Add phase budgets (M-4/M-5). Add mid-phase snapshots (M-6). Add Phase 0 activity (H-5). | Engine + algorithm      |
| `apps/search-ai`          | Persist `discoveredPages` on every snapshot (not just final result). Forward enriched tree-snapshot events.                                                                                              | Persistence + SSE proxy |
| `apps/studio`             | Extend `UnifiedTreeNode` + `BackendTreeNode` with V2 fields. Update tree-merge conversion. Render badges, tooltips, view toggle. Wire explore-branch.                                                    | Frontend rendering      |

### Data Flow

```
BACKEND (crawler-mcp-server / bfs-discovery.ts)
  ┌──────────────────────────────────────────────────────────────┐
  │  allUrls: Map<string, DiscoveredPage>                        │
  │    NOW includes: discoverySource, linkText, breadcrumbLabel  │
  │                                                               │
  │  buildHybridTree(allUrls, primaryUrl, breadcrumbChains)      │
  │    1. Compute linkFrequency + isGlobalLink for each URL      │
  │    2. For each URL, select parent:                           │
  │       breadcrumb > non-global foundOn > URL-path > root      │
  │    3. Synthesize virtual intermediate nodes for path gaps     │
  │    4. Resolve labels: title > breadcrumb > linkText > slug   │
  │    5. Enrich nodes: foundOn, discoverySource, isGlobalLink,  │
  │       isVirtual, childPageCount                              │
  │                                                               │
  │  emitTreeSnapshot() now includes:                            │
  │    tree: TreeNode[]          (enriched)                      │
  │    discoveredPages: [url, DiscoveredPage][]  (the graph)     │
  │                                                               │
  │  Phase budgets:                                               │
  │    Phase 1b: max 50 URLs per seed (M-4)                      │
  │    Overall: 10 min timeout (M-5)                              │
  │    Phase 0: sub-phase activity messages (H-5)                │
  │                                                               │
  │  explore-branch: checkStop() now acts on                     │
  │    exploreBranchUrls return from processCommands() (C-2)     │
  │                                                               │
  │  Mid-phase snapshots: timer runs during ALL phases (M-6)     │
  └─────────────────────┬────────────────────────────────────────┘
                        │ SSE stream
                        ▼
PROXY (search-ai / discovery.ts)
  ┌──────────────────────────────────────────────────────────────┐
  │  On tree-snapshot:                                           │
  │    Persist treeHierarchy (enriched TreeNode[])               │
  │    Persist discoveredPages (graph data) ← NEW (H-4)         │
  │    Persist totalPagesVisited, totalUrlsFound                 │
  │  Forward full event to frontend                              │
  └─────────────────────┬────────────────────────────────────────┘
                        │ SSE stream
                        ▼
FRONTEND (studio)
  ┌──────────────────────────────────────────────────────────────┐
  │  tree-merge.ts: treeSnapshotToUnifiedTree()                  │
  │    Maps V2 fields: foundOn, discoverySource, isGlobalLink,   │
  │    isVirtual, childPageCount → UnifiedTreeNode               │
  │                                                               │
  │  UnifiedTreeNodeRow.tsx:                                      │
  │    - foundOn badge: "linked from N pages" (click to expand)  │
  │    - Global badge for nav/footer links                       │
  │    - discoverySource badge (seed, bfs, breadcrumb-climb)     │
  │    - pageRole icon (hub/leaf/mixed) (M-13)                   │
  │    - Sample URL highlight (M-10)                             │
  │    - Error tooltip with full message (M-12)                  │
  │    - Folder icon + child count for virtual nodes             │
  │    - URL tooltip on label hover                              │
  │    - Virtual folder checkbox → select all children (Layer 5) │
  │                                                               │
  │  UnifiedTreeHeader.tsx:                                       │
  │    - View toggle: Hybrid / Crawl Path / URL Structure        │
  │    - "Add from Sitemap" button (Layer 5)                     │
  │                                                               │
  │  AddFromSitemapButton.tsx (NEW — Layer 5):                   │
  │    - Calls clusterUrls() API (existing, no backend change)   │
  │    - Preview dialog: URL count, path groups, impact          │
  │    - On confirm: merge into allUrls, discoverySource='sitemap│
  │    - Smart exclusion: /login, /cart, /api/ → included=false  │
  │                                                               │
  │  tree-to-sections.ts: treeToSections() (UPDATED — Layer 5)  │
  │    - Virtual folder selected → aggregate children as section │
  │    - Track source per section (sitemap, explored, auto)      │
  │    - Exclude patterns → nodes with included:false skipped    │
  │                                                               │
  │  sitemap-merge.ts (NEW — Layer 5):                           │
  │    - mergeSitemapIntoTree(): dedup by normalized URL          │
  │    - applyExclusionPatterns(): mark excluded nodes            │
  │    - sitemapPreview(): count, path groups, overlap stats     │
  │                                                               │
  │  UnifiedDiscoveryPanel.tsx:                                   │
  │    - Wire onExploreNode to explore-branch command (M-7)      │
  └──────────────────────────────────────────────────────────────┘
```

### Key Integration Points

1. **crawler-mcp-server → search-ai**: `tree-snapshot` SSE event gains `discoveredPages` field (array of `[url, DiscoveredPage]` tuples). search-ai must persist this alongside tree.
2. **Backend TreeNode type → Frontend BackendTreeNode**: Both must gain V2 fields. `tree-merge.ts` `BackendTreeNode` is a local duplicate — must be updated in sync.
3. **SiteDiscovery model**: Schema additive change — new fields on `ITreeNode` and `IDiscoveredPage` get defaults. No migration needed for existing docs.
4. **explore-branch command flow**: Frontend sends command → search-ai forwards → crawler-mcp command queue → `checkStop()` must now return `exploreBranchUrls` to the BFS main loop.
5. **BSON 16MB limit**: `discoveredPages` for large sites (50K URLs × foundOn[]) could approach limits. Guard: truncate `foundOn` to first 10 entries per page; skip graph persist if serialized size > 12MB.
6. **"Add from Sitemap" → existing API**: Frontend calls `clusterUrls()` (search-ai). No new backend endpoint needed. The merge happens entirely on the frontend — sitemap URLs are added to the in-memory `allUrls` map and tree rebuilds.
7. **treeToSections() → CrawlSection[]**: Updated to handle virtual folder nodes (aggregate all children as one section) and track source per section. Must remain backward-compatible with existing State 3 (Configure) UI.

---

## Decisions & Tradeoffs

### D-1: Hybrid tree as default (not URL-path)

**Chose**: Breadcrumb > non-global foundOn > URL-path priority.
**Over**: URL-path first (current), or crawl-path first (Screaming Frog).
**Because**: URL-path produces the same broken tree we have today for cross-path pages.
Pure crawl-path is unstable (depends on discovery order) and polluted by global links.
The hybrid approach uses the strongest available signal while filtering noise.

### D-2: Persist graph on every snapshot (not just final result)

**Chose**: Include `discoveredPages` in every `tree-snapshot` SSE event and persist to MongoDB.
**Over**: Persisting only on `result` event (current), or persisting to a separate collection.
**Because**: Graph data currently lost on stop/crash (H-4). The tree algorithm depends on
this data — without it, reload produces a different tree. Same collection avoids extra queries.
BSON limit guarded by truncation + size check.

### D-3: Virtual intermediate nodes for path gaps

**Chose**: Synthesize folder nodes when `/a/b/c` exists but `/a/b` doesn't.
**Over**: Attaching directly to the nearest real ancestor (current behavior).
**Because**: Without virtual nodes, hundreds of pages become flat children of root.
Every industry tool does this. Folder nodes enable meaningful aggregation.

### D-4: linkText from anchor text as third label priority

**Chose**: Capture anchor text during link extraction. Use as label when title and breadcrumb are unavailable.
**Over**: Only using title (visited pages) or URL slug (unvisited pages).
**Because**: Most tree nodes are unvisited during discovery. Link text is the most natural label
for unvisited pages — it's what the site author wrote for their users. Eliminates ugly slugs
like `SPT_C11CJ67201~faq-00004ba-shared`.

### D-5: Add H-5/M-4/M-5 to V2 scope

**Chose**: Include Phase 0 activity messages, Phase 1b budget, and overall timeout.
**Over**: Deferring to separate work.
**Because**: V2 already modifies Phase 0 (discoverySource tracking) and phase orchestration
(mid-phase snapshots). These are natural extensions with minimal extra effort. Phase 0 dead
zone was observed during manual testing. Unbounded Phase 1b can visit hundreds of URLs.

### D-6: Three-way view toggle (not just two)

**Chose**: Hybrid (default) / Crawl Path / URL Structure toggle.
**Over**: Just Hybrid + Crawl Path, or just Hybrid + URL Structure.
**Because**: Users may want the pure URL structure view for sites with clean hierarchies.
The three views answer different questions: "best guess" / "how crawler reached it" /
"what's the URL folder structure." Minimal extra code — same data, different parent selection.

### D-7: foundOn truncation for BSON safety

**Chose**: Truncate `foundOn` arrays to 10 entries per page for persistence.
**Over**: No limit (risk 16MB), or separate collection.
**Because**: A page linked from 500 navigation pages doesn't need all 500 stored — the first 10
plus `linkFrequency` count is sufficient. Keeps the graph within BSON limits even at 50K URLs.
Full `foundOn` available in-memory during live discovery; only persistence is truncated.

### D-8: Post-discovery sitemap merge on frontend (not mid-engine)

**Chose**: "Add from Sitemap" merges sitemap URLs into the tree on the frontend AFTER BFS
completes (or during selection). No engine changes needed.
**Over**: Mid-discovery command injection (new `add-sitemap-urls` command type in BFS engine).
**Because**: The user explicitly chose "Guided Discovery" over "Sitemap" at Step 2 — auto-loading
sitemap contradicts their choice. The sitemap button is an explicit "boost" the user controls.
Frontend merge keeps engine scope bounded. Mid-discovery injection deferred to Build 3 (with M-8/M-9).

**Flow**: User clicks "Add from Sitemap" → frontend calls existing `clusterUrls()` API → preview
dialog ("4,200 URLs across 12 paths") → user confirms → URLs merge into `allUrls` map with
`discoverySource: 'sitemap'` → tree rebuilds → smart exclusion patterns applied → nodes default
to `included: false` for /login, /cart, /api/ patterns.

---

## UX Design (approved)

### Tree Header — Toolbar Row Layout

New toolbar row below search, containing view toggle (3-way tabs) and "Add from Sitemap" button.

```
┌──────────────────────────────────────────────────────┐
│ 🧭 Discovery Tree  [247 nodes]                       │
│                          [⊞ Expand] [⊟ Collapse]     │
│                          [☑ All]    [☐ None]          │
│ [🔍 Search nodes...                            ✕]    │
│ ┌──────────────────────────────────────────────┐     │
│ │ View: [Hybrid ▼] [Crawl Path] [URL Path]    │     │
│ │                    [📋 Add from Sitemap]     │     │
│ └──────────────────────────────────────────────┘     │
│ Samples: epson.com/faq, epson.com/et-2400            │
│ 45 explored · 12 auto · 190 unexplored               │
└──────────────────────────────────────────────────────┘
```

### Tree Node Rows — V2 Badges + Virtual Folders

```
│  ▸ 📂 [☑] Printers          [47 pg] [🔗3] [HTTP]  🧭
│    ▾ 📁 [☑] All-In-Ones     [12 pg] [seed] [HTTP]  🧭
│      │ 📄 [☑] ET-2400 FAQs  [3 pg]  [bfs]  [🌐]  🔗
│      │ 📄 [☑] ET-2720 Setup [2 pg]  [bfs]  [HTTP] 🔗
│      │ 📄 [ ] Support Home          [Global] [HTTP]
│    ▾ 📁‹v› [☐] Ink & Toner  [23 pg]     ← virtual folder
│      │ 📄     /ink/et-2400   [sitemap]       ← from sitemap
│      │ 📄     /ink/et-2720   [sitemap]

LEGEND:
  📁‹v›    = Virtual folder (synthesized, no real URL)
  [☑]      = Recursive: checking folder checks all children
  [🔗3]    = "linked from 3 pages" (click to expand)
  [seed]   = discoverySource badge
  [Global] = nav/footer link (dimmed)
  [sitemap]= added via "Add from Sitemap"
```

### "Add from Sitemap" Dialog

```
┌─────────────────────────────────────────────┐
│        Add URLs from Sitemap                │
│─────────────────────────────────────────────│
│  Sitemap found: 4,200 URLs                  │
│                                             │
│  Top-level paths:                           │
│  ┌─────────────────────────────────────┐    │
│  │ /support/     1,240 URLs            │    │
│  │ /products/      890 URLs            │    │
│  │ /docs/          650 URLs            │    │
│  │ ... 7 more paths                    │    │
│  └─────────────────────────────────────┘    │
│                                             │
│  Auto-exclude (uncheck to include):         │
│  [☑] /login, /logout     (12 URLs)         │
│  [☑] /cart, /checkout    (45 URLs)         │
│  [☑] /api/               (320 URLs)        │
│  [☑] /admin/             (8 URLs)          │
│                                             │
│  Already in tree: 180 URLs (will skip)      │
│  New URLs to add: 3,635                     │
│                                             │
│  [Cancel]              [Add 3,635 URLs]     │
└─────────────────────────────────────────────┘
```

### Footer — Virtual Folder Awareness

```
┌──────────────────────────────────────────────────────┐
│ 3 folders + 2 pages selected · 127 pages in scope    │
│ Sources: 89 explored · 38 from sitemap               │
│                        [Continue with 5 sections →]   │
└──────────────────────────────────────────────────────┘
```

No double-counting: virtual folder `pageCount = 0`, only children's leaf pages counted.

---

## Task Decomposition

| Task | Package(s)                               | Independent?   | Est. Files | Description                                                                                   |
| ---- | ---------------------------------------- | -------------- | ---------- | --------------------------------------------------------------------------------------------- |
| T-1  | `packages/database`                      | Yes            | 1          | Extend `ITreeNode` + `IDiscoveredPage` schemas with V2 fields                                 |
| T-2  | `apps/crawler-mcp-server`                | Yes            | 2-3        | Hybrid tree algorithm + label priority + virtual nodes                                        |
| T-3  | `apps/crawler-mcp-server`                | Yes            | 1-2        | Engine fixes: C-2, M-6, H-5, M-4, M-5, discoverySource, linkText capture                      |
| T-4  | `apps/search-ai`                         | After T-1      | 1          | Persist `discoveredPages` on every snapshot (H-4)                                             |
| T-5  | `apps/studio`                            | After T-1, T-2 | 5-6        | Frontend: types, tree-merge, node rendering, badges, toggle, virtual folder checkbox          |
| T-6  | `apps/crawler-mcp-server`, `apps/studio` | After T-2, T-5 | 1-2        | Wire explore-branch end-to-end (C-2 + M-7)                                                    |
| T-7  | `apps/studio`                            | After T-5      | 2-3        | Layer 5: "Add from Sitemap" button, sitemap merge, smart exclusion, `treeToSections()` update |
| T-8  | All                                      | After all      | 2-3        | Unit tests: hybrid tree algorithm, tree-merge, treeToSections, sitemap merge                  |

### Dependency Graph

```
T-1 (schema)          ──────────────────► can start immediately
T-2 (hybrid algorithm)──────────────────► can start immediately
T-3 (engine fixes)    ──────────────────► ST-3.1–3.13 can start immediately; ST-3.14 needs T-2

T-4 (graph persist)   ──────────────────► needs T-1
T-5 (frontend core)   ──────────────────► needs T-1, T-2

T-6 (explore-branch)  ──────────────────► needs T-2 (backend), T-5 (frontend)
T-7 (Layer 5: sitemap+selection) ────────► needs T-5 (tree types + merge)

T-8 (tests)           ──────────────────► needs T-2, T-5, T-7

Wave 1: T-1, T-2, T-3 ST-3.1–3.13 (parallel — zero file overlap)
Wave 2: T-3 ST-3.14, T-4, T-5 (parallel — bfs-discovery vs search-ai vs studio, zero overlap)
Wave 3: T-6, T-7 (parallel — explore-branch vs Layer 5, zero file overlap)
Wave 4: T-8 (tests — after all implementation)
```

### File Ownership Per Task (zero overlap enforced)

| Task | Files owned (exclusive)                                                                                                                                                                                                                                                                                                                                   |
| ---- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| T-1  | `packages/database/src/models/site-discovery.model.ts`                                                                                                                                                                                                                                                                                                    |
| T-2  | `apps/crawler-mcp-server/src/explore/hybrid-tree-builder.ts` (NEW), `apps/crawler-mcp-server/src/explore/url-normalizer.ts`                                                                                                                                                                                                                               |
| T-3  | `apps/crawler-mcp-server/src/explore/bfs-discovery.ts`                                                                                                                                                                                                                                                                                                    |
| T-4  | `apps/search-ai/src/routes/discovery.ts`                                                                                                                                                                                                                                                                                                                  |
| T-5  | `apps/studio/src/components/search-ai/crawl-flow/discovery/unified-tree-types.ts`, `tree-merge.ts`, `UnifiedTreeNodeRow.tsx`, `UnifiedTreeHeader.tsx`, `UnifiedTree.tsx`, `apps/studio/src/api/discovery.ts`, `apps/studio/src/components/search-ai/crawl-flow/State2Analysis.tsx` (G-11 dead code only)                                                  |
| T-6  | `apps/studio/src/components/search-ai/crawl-flow/UnifiedDiscoveryPanel.tsx`, `apps/crawler-mcp-server/src/server.ts` (command endpoint only)                                                                                                                                                                                                              |
| T-7  | `apps/studio/src/components/search-ai/crawl-flow/discovery/sitemap-merge.ts` (NEW), `apps/studio/src/components/search-ai/crawl-flow/discovery/tree-to-sections.ts`, `apps/studio/src/components/search-ai/crawl-flow/discovery/AddFromSitemapButton.tsx` (NEW), `apps/studio/src/components/search-ai/crawl-flow/CrawlFlowV5.tsx` (G-5 draft bucket fix) |
| T-8  | `apps/crawler-mcp-server/src/explore/__tests__/hybrid-tree-builder.test.ts` (NEW), `apps/studio/src/components/search-ai/crawl-flow/discovery/__tests__/tree-merge.test.ts` (NEW), `apps/studio/src/components/search-ai/crawl-flow/discovery/__tests__/tree-to-sections.test.ts` (NEW)                                                                   |

---

## Out of Scope

### Deferred Bugs (separate root causes)

| ID      | What                                     | Why                                    |
| ------- | ---------------------------------------- | -------------------------------------- |
| H-2     | Nav structure never integrated           | Nav extraction broken (H-7). Fix first |
| H-7     | `__name` bug in nav-extractor            | esbuild/Playwright, separate fix       |
| H-8     | SSE reconnection always fails            | SSE infra, not tree-related            |
| M-8/M-9 | `undo-skip`/`add-sample` not implemented | Command handling, separate             |
| M-11    | Sitemap nav may not restore page         | Nav-extractor resilience, separate     |

### Deferred Features (Build 3+)

| Feature               | Why deferred                                                       |
| --------------------- | ------------------------------------------------------------------ |
| Direct URLs mode      | Independent UX feature — paste URLs without discovery              |
| Quick-select patterns | Needs URL pattern detection — independent of tree data model       |
| Custom glob filter    | UX feature on top of tree — independent                            |
| Recrawl workflow      | V2 builds the foundation (graph persistence). Workflow is separate |
| Rediscover workflow   | V2 builds the foundation. "Re-run BFS" workflow is separate        |
| E2E tests             | Should follow after manual verification of V2                      |
| Graph visualization   | Gephi-style force-directed — future                                |
| Metrics-per-folder    | Ahrefs/Lumar pattern — future                                      |
| Sitemap-based view    | Third tree view — future                                           |
| Inlinks table         | Screaming Frog "Inlinks" tab — future                              |

### User Scenarios (from proposal)

Five validated scenarios that define acceptance:

- **Scenario A — Live Discovery**: User watches tree grow in real time with graph-informed hierarchy, friendly labels, and Phase 0 activity feedback
- **Scenario B — Selection**: User navigates enriched tree with virtual folders, provenance badges, global link indicators, and view toggle
- **Scenario C — Recrawl**: User returns later and sees identical tree from persisted graph data
- **Scenario D — Add from Sitemap**: User clicks explicit button to merge sitemap URLs into discovery tree (post-discovery, frontend merge, with preview + smart exclusion)
- **Scenario E — Selection to Crawl Handoff**: `treeToSections()` converts V2 tree (virtual folders, mixed sources) into `CrawlSection[]` for State 3

Full scenario details in `docs/specs/discovery-tree-v2-proposal.md` §User Scenarios.

---

## Risk Mitigations

| Risk                                  | Mitigation                                                                             |
| ------------------------------------- | -------------------------------------------------------------------------------------- |
| BSON 16MB limit with large graph      | Truncate `foundOn` to 10 per page. Skip graph persist if >12MB                         |
| Tree snapshot size increase with V2   | Keep `MAX_TIMER_SNAPSHOT_URLS = 10_000` guard. V2 fields add ~20 bytes/node            |
| Two competing frontend tree types     | V2 extends `UnifiedTreeNode` only. Old `DiscoveryTreeNode` untouched (Build 3 cleanup) |
| Performance of hybrid algorithm       | O(n) single pass: one Map lookup per URL. No sort needed unlike current O(n log n)     |
| `foundOn` overloaded with source info | New `discoverySource` field cleanly separates provenance from graph                    |
| Phase 1b runaway                      | Budget: max 50 URLs per seed. Emits warning when budget hit                            |
| Overall discovery timeout             | 10 min hard cap. Emits `complete` event with `stoppedBy: 'timeout'`                    |
| Large sitemap merge (4K+ URLs)        | Preview dialog shows count + impact before merge. Smart exclusion reduces noise        |
| `treeToSections()` backward compat    | Virtual folder aggregation is additive. Non-virtual nodes convert identically to v1    |
| Sitemap-BFS URL overlap               | Dedup by normalized URL. BFS-discovered pages keep their richer metadata over sitemap  |

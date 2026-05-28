# Discovery Tree V2 — Low-Level Design

> **HLD**: `docs/specs/discovery-tree-v2.hld.md`
> **Proposal**: `docs/specs/discovery-tree-v2-proposal.md`
> **Ticket**: ABLP-71
> **Date**: 2026-05-11

---

## Task T-1: Schema Extensions (`packages/database`)

### Files to Modify

- `packages/database/src/models/site-discovery.model.ts` — add V2 fields to `IDiscoveredPage`, `ITreeNode`, and Mongoose schemas

### Detailed Changes

#### 1. Extend `IDiscoveredPage` (line 12-23)

Add after `lastVisitedAt` (line 22):

```typescript
// === V2 provenance ===
discoverySource?: 'primary' | 'seed' | 'nav' | 'breadcrumb-climb' | 'bfs' | 'user-command' | 'sitemap';
linkText?: string;         // anchor text from the linking page
breadcrumbLabel?: string;  // label from breadcrumb chain
discoveredAt?: number;     // timestamp of first discovery

// === V2 computed (recomputed on each snapshot) ===
linkFrequency?: number;    // how many visited pages link to this
isGlobalLink?: boolean;    // linkFrequency > 30% of total visited
```

#### 2. Extend `discoveredPageSchema` (line 71-93)

Add corresponding Mongoose schema fields after `lastVisitedAt` (line 91):

```typescript
discoverySource: { type: String, enum: ['primary', 'seed', 'nav', 'breadcrumb-climb', 'bfs', 'user-command', 'sitemap'] },
linkText: { type: String },
breadcrumbLabel: { type: String },
discoveredAt: { type: Number },
linkFrequency: { type: Number },
isGlobalLink: { type: Boolean },
```

#### 3. Extend `ITreeNode` (line 25-34)

Add after `status` (line 33):

```typescript
// === V2 enrichment ===
foundOn?: string[];         // cross-reference parents (truncated to 10 for persistence)
discoverySource?: string;   // how this page was found
isGlobalLink?: boolean;     // nav/footer link
isVirtual?: boolean;        // synthesized folder node (no real URL)
childPageCount?: number;    // total leaf pages under this node
errorMessage?: string;      // full error message (M-12)
```

#### 4. Extend `treeNodeSchema` (line 95-115)

Add after `status` field (line 112):

```typescript
foundOn: { type: [String], default: undefined },
discoverySource: { type: String },
isGlobalLink: { type: Boolean },
isVirtual: { type: Boolean },
childPageCount: { type: Number },
errorMessage: { type: String },
```

#### 5. No changes to `ISiteDiscovery` interface

The `discoveredUrls: IDiscoveredPage[]` field (line 55) already stores the graph. V2 enriches what's stored per page (via `IDiscoveredPage` additions) and enriches what's stored per tree node (via `ITreeNode` additions). No new top-level fields needed on the document.

### Subtasks

1. **ST-1.1**: Add V2 fields to `IDiscoveredPage` interface and `discoveredPageSchema`
2. **ST-1.2**: Add V2 fields to `ITreeNode` interface and `treeNodeSchema`
3. **ST-1.3**: Update barrel exports in `packages/database/src/models/index.ts` (line 712-719) — ensure new type unions are re-exported
4. **ST-1.4**: Run `pnpm build --filter=@agent-platform/database` to verify types compile
5. **ST-1.5**: Update `packages/database/agents.md` with V2 schema changes

### Acceptance Criteria

- AC-1: `IDiscoveredPage` has 7 new optional fields: `discoverySource`, `linkText`, `breadcrumbLabel`, `discoveredAt`, `linkFrequency`, `isGlobalLink`
  - Verify: `pnpm build --filter=@agent-platform/database`
  - Expected: Clean build, no type errors
- AC-2: `ITreeNode` has 6 new optional fields: `foundOn`, `discoverySource`, `isGlobalLink`, `isVirtual`, `childPageCount`, `errorMessage`
  - Verify: `pnpm build --filter=@agent-platform/database`
  - Expected: Clean build
- AC-3: Existing documents with no V2 fields still load — all new fields are optional with no required defaults that would fail
  - Verify: Mongoose `.lean()` queries return `undefined` for missing fields (not errors)

---

## Task T-2: Hybrid Tree Algorithm (`apps/crawler-mcp-server`)

### Files to Create

- `apps/crawler-mcp-server/src/explore/hybrid-tree-builder.ts` — new file, pure function

### Files to Modify

- `apps/crawler-mcp-server/src/explore/url-normalizer.ts` — add `humanizeSlug()` helper

### Function Signatures

#### `hybrid-tree-builder.ts`

```typescript
import type { DiscoveredPage, TreeNode } from './bfs-discovery';

export type TreeViewMode = 'hybrid' | 'crawl-path' | 'url-path';

export interface HybridTreeOptions {
  viewMode: TreeViewMode;
  globalLinkThreshold?: number; // default 0.3 (30%)
}

/**
 * Build a tree from the crawl graph using the hybrid algorithm.
 * Pure function — no side effects.
 *
 * Algorithm:
 *   1. Compute linkFrequency + isGlobalLink for each URL
 *   2. For each URL, select parent based on viewMode:
 *      - hybrid: breadcrumb > non-global foundOn > URL-path > root
 *      - crawl-path: first foundOn > root
 *      - url-path: URL pathname hierarchy (current behavior)
 *   3. Synthesize virtual intermediate nodes for path gaps
 *   4. Resolve labels: title > breadcrumbLabel > linkText > humanizedSlug > rawSegment
 *   5. Enrich nodes with V2 fields
 */
export function buildHybridTree(
  allUrls: Map<string, DiscoveredPage>,
  primaryUrl: string,
  breadcrumbChains: Array<{ sourceUrl: string; crumbs: Array<{ text: string; href: string }> }>,
  options?: HybridTreeOptions,
): TreeNode[];

/**
 * Compute linkFrequency and isGlobalLink for every URL in the graph.
 * linkFrequency = number of *visited* pages that link to this URL.
 * isGlobalLink = linkFrequency > threshold * totalVisitedPages.
 */
export function computeGlobalLinks(
  allUrls: Map<string, DiscoveredPage>,
  threshold?: number,
): Map<string, { linkFrequency: number; isGlobalLink: boolean }>;

/**
 * Select parent for a URL using the hybrid priority chain.
 * Returns the parent URL or null (root).
 */
export function selectParent(
  url: string,
  page: DiscoveredPage,
  globalLinks: Map<string, { linkFrequency: number; isGlobalLink: boolean }>,
  allUrls: Map<string, DiscoveredPage>,
  breadcrumbParentMap: Map<string, string>,
  viewMode: TreeViewMode,
): string | null;

/**
 * Resolve label for a tree node using the priority chain:
 * title > breadcrumbLabel > linkText > humanizedSlug > rawSegment
 */
export function resolveLabel(
  url: string,
  page: DiscoveredPage | undefined,
  isVirtual: boolean,
): string;
```

#### `url-normalizer.ts` — add

```typescript
/**
 * Convert a URL slug to a human-friendly label.
 * - Split on [-_~.]
 * - Title-case each word
 * - Strip numeric-only segments and common ID patterns
 * - Collapse whitespace
 *
 * Examples:
 *   "all-in-ones" → "All In Ones"
 *   "SPT_C11CJ67201~faq-00004ba-shared" → "FAQ"
 *   "et-2400" → "ET 2400"
 */
export function humanizeSlug(slug: string): string;
```

### Algorithm Detail

```
buildHybridTree(allUrls, primaryUrl, breadcrumbChains, options):

  1. PRE-COMPUTE
     - totalVisited = count URLs where visited === true
     - globalLinks = computeGlobalLinks(allUrls, threshold)
     - breadcrumbParentMap: Map<childUrl, parentUrl> from breadcrumbChains
       For each chain [A, B, C]: B→A, C→B

  2. SELECT PARENTS — O(n) single pass
     parentMap: Map<childUrl, parentUrl>
     for each [url, page] in allUrls:
       parent = selectParent(url, page, globalLinks, allUrls, breadcrumbParentMap, viewMode)
       if parent: parentMap.set(url, parent)

  3. DETECT VIRTUAL NODES — O(n)
     For each URL with no parent in parentMap:
       Walk URL path segments upward until finding an existing URL
       If gap exists (e.g., /a/b/c exists but /a/b doesn't):
         Create virtual node for /a/b
         Add to virtualNodes map
         Set parentMap: /a/b/c → /a/b, /a/b → closest existing ancestor

  4. BUILD NODE MAP — O(n)
     nodeMap: Map<url, TreeNode>
     For each URL + virtual node:
       label = resolveLabel(url, page, isVirtual)
       Create TreeNode with all V2 fields:
         foundOn, discoverySource, isGlobalLink, isVirtual, childPageCount, errorMessage

  5. ASSEMBLE TREE — O(n)
     For each URL in parentMap:
       nodeMap[parentUrl].children.push(nodeMap[childUrl])
     roots = URLs not in parentMap (primary always first root)

  6. COMPUTE childPageCount — O(n) bottom-up pass
     For each node post-order:
       childPageCount = sum of children's (pageCount or childPageCount)

  return roots
```

### selectParent logic by viewMode

```
hybrid:
  1. breadcrumbParentMap[url] → if exists, return it
  2. page.foundOn → filter out global links → pick closest by URL-path distance
  3. URL-path ancestor → walk path segments upward, find first existing URL
  4. null (root)

crawl-path:
  1. page.foundOn[0] → first discovery parent (raw crawl order)
  2. null (root)

url-path:
  1. URL-path ancestor → walk path segments upward (current buildTree behavior)
  2. null (root)
```

### Subtasks

1. **ST-2.1**: Create `hybrid-tree-builder.ts` with `computeGlobalLinks()` — pure function, no imports beyond local types
2. **ST-2.2**: Implement `selectParent()` for all three view modes
3. **ST-2.3**: Implement virtual node synthesis (detect path gaps, create nodes)
4. **ST-2.4**: Implement `resolveLabel()` with full priority chain
5. **ST-2.5**: Implement `buildHybridTree()` — main orchestrator
6. **ST-2.6**: Add `humanizeSlug()` to `url-normalizer.ts`
7. **ST-2.7**: Run `pnpm build --filter=crawler-mcp-server`

### Acceptance Criteria

- AC-1: `buildHybridTree` with `viewMode: 'hybrid'` places FAQ page under its linking printer page (not under `/support/faq/` path)
- AC-2: Global links (>30% linkFrequency) use URL-path parent, not foundOn
- AC-3: Virtual nodes created for path gaps (e.g., `/products/` when only `/products/shoes` exists)
- AC-4: Labels follow priority chain — visited pages show title, unvisited show linkText or humanized slug
- AC-5: `viewMode: 'url-path'` produces identical output to current `buildTree()` (backward compat)
- AC-6: `viewMode: 'crawl-path'` uses foundOn[0] as parent
- AC-7: `childPageCount` correctly computed bottom-up
- AC-8: `humanizeSlug('SPT_C11CJ67201~faq-00004ba-shared')` produces `"FAQ"` or similar clean label

---

## Task T-3: Engine Fixes (`apps/crawler-mcp-server`)

### Files to Modify

- `apps/crawler-mcp-server/src/explore/bfs-discovery.ts` — fixes for C-2, M-6, H-5, M-4, M-5, discoverySource tracking, linkText capture

### Detailed Changes

#### Fix C-2: explore-branch commands silently discarded

**Current** (line 692-710): `checkStop()` calls `processCommands()` but discards `exploreBranchUrls` return.

**Fix**: `checkStop()` must return `exploreBranchUrls` to the caller. The BFS main loops (Phase 1b, Phase 3) must check this return and enqueue the URLs for immediate visit.

```typescript
// BEFORE (line 698-700):
const { shouldStop } = await processCommands();
if (shouldStop) { ... }

// AFTER:
const { shouldStop, exploreBranchUrls } = await processCommands();
if (shouldStop) { ... }
return { stopped: false, exploreBranchUrls };
```

Callers of `checkStop()` in phases must handle `exploreBranchUrls`:

```typescript
const { stopped, exploreBranchUrls } = await checkStop();
if (stopped) break;
if (exploreBranchUrls.length > 0) {
  // Add to front of visit queue for immediate processing
  visitQueue.unshift(...exploreBranchUrls);
}
```

#### Fix M-6: No tree snapshots during Phase 1a/1b/2

**Current** (line 1136-1142): Snapshot timer only starts at beginning of Phase 3.

**Fix**: Start snapshot timer BEFORE Phase 1a (after Phase 0 completes). Move timer setup from Phase 3 entry to post-Phase 0:

```typescript
// After Phase 0, before Phase 1a:
startSnapshotTimer(); // was only called at Phase 3 start
```

Also emit a snapshot at Phase 0 completion (after primary page is visited).

#### Fix H-5: 60-100s dead zone Phase 0

**Current**: Phase 0 (nav extraction with Playwright) emits no activity. Users see a static "discovering" state for up to 100s.

**Fix**: Add `activity` event emissions during Phase 0 sub-steps:

```typescript
// At start of Phase 0:
emit('activity', { message: 'Loading primary page...' });

// After page load:
emit('activity', { message: 'Analyzing page structure...' });

// After nav extraction:
emit('activity', { message: `Found ${navLinks} navigation links` });

// After breadcrumb extraction:
emit('activity', { message: `Extracted ${breadcrumbs} breadcrumb chains` });

// After render method detection:
emit('activity', {
  message: `Page requires ${renderMethod === 'browser' ? 'JavaScript' : 'HTTP only'}`,
});
```

The `BfsActivityLogEvent` type already exists (line 57-63).

#### Fix M-4: Phase 1b unbounded

**Current** (line 949-993): Phase 1b visits ALL depth-1 children of seeds with no limit.

**Fix**: Add per-seed budget constant and enforce:

```typescript
const PHASE_1B_MAX_PER_SEED = 50;

// In Phase 1b loop, track per-seed count:
let seedBudget = 0;
for (const childUrl of childrenToVisit) {
  if (seedBudget >= PHASE_1B_MAX_PER_SEED) {
    emit('activity', {
      message: `Phase 1b budget reached for seed (${PHASE_1B_MAX_PER_SEED} URLs)`,
    });
    break;
  }
  // ... visit
  seedBudget++;
}
```

#### Fix M-5: No overall discovery timeout

**Current**: No timeout — discovery runs until all phases complete or user stops.

**Fix**: Add overall timeout at the top of `runBfsDiscovery`:

```typescript
const OVERALL_TIMEOUT_MS = 10 * 60 * 1000; // 10 minutes
const discoveryStartTime = Date.now();

// In checkStop(), add timeout check:
if (Date.now() - discoveryStartTime > OVERALL_TIMEOUT_MS) {
  emit('activity', { message: 'Discovery timeout reached (10 minutes)' });
  return { stopped: true, exploreBranchUrls: [] };
}
```

On timeout, emit `complete` event with `stoppedBy: 'timeout'`.

**Type union update required in 4 locations:**

1. `bfs-discovery.ts:100` — `BfsCompleteEvent.stoppedBy` — add `| 'timeout'`
2. `bfs-discovery.ts:126` — `BfsDiscoveryResult.stats.stoppedBy` — add `| 'timeout'`
3. `bfs-discovery.ts:629` — local variable assignment — handle `'timeout'` value
4. `apps/studio/src/api/discovery.ts:132` — frontend `BfsCompleteEvent.stoppedBy` — add `| 'timeout'`

#### discoverySource tracking

**Current**: `foundOn` is overloaded — `['seed']`, `['breadcrumb-climb']`, `['user-command']` are stored as foundOn entries.

**Fix**: Add `discoverySource` to `DiscoveredPage` interface (line 130-140). Set it at each discovery point:

| Discovery point             | Line(s)   | discoverySource value |
| --------------------------- | --------- | --------------------- |
| Primary page                | 755-894   | `'primary'`           |
| Seed/sample URLs (Phase 1a) | 900-943   | `'seed'`              |
| Phase 1b expansion          | 949-993   | `'bfs'`               |
| Breadcrumb climb (Phase 2)  | 996-1088  | `'breadcrumb-climb'`  |
| Phase 3 BFS                 | 1090-1199 | `'bfs'`               |
| Navigation links (Phase 0)  | 828-841   | `'nav'`               |
| explore-all command         | 553       | `'user-command'`      |
| explore-branch              | 532       | `'user-command'`      |

Stop overloading `foundOn` — `foundOn` should only contain real page URLs.

#### linkText capture

**Current**: Link extraction (navigation-explorer.ts `extractPageLinks`) returns `{ href, text }` tuples. The `text` is used for `title` on new discovery (line 330: `title: link.text || undefined`), but is lost once the page is visited (title overwritten by `page.title()`).

**Fix**: Add `linkText` field to `DiscoveredPage`. Store `link.text` as `linkText` (not title) during link discovery:

```typescript
// Line 330 area — when discovering new URL from link:
const newPage: DiscoveredPage = {
  url: normalizedHref,
  foundOn: [normalizedCurrentUrl],
  childUrls: [],
  renderMethod: 'unknown',
  visited: false,
  status: 'discovered',
  discoverySource: currentPhaseSource,
  linkText: link.text || undefined, // NEW — anchor text
  // title remains undefined until visited
};
```

### Subtasks

1. **ST-3.1**: Add `discoverySource`, `linkText`, `breadcrumbLabel`, `discoveredAt`, `linkFrequency`, `isGlobalLink` to `DiscoveredPage` interface
2. **ST-3.2**: Fix C-2 — `checkStop()` returns `exploreBranchUrls`, callers handle them
3. **ST-3.3**: Fix M-6 — start snapshot timer after Phase 0
4. **ST-3.4**: Fix H-5 — add `activity` event emissions during Phase 0
5. **ST-3.5**: Fix M-4 — add `PHASE_1B_MAX_PER_SEED = 50` budget
6. **ST-3.6**: Fix M-5 — add `OVERALL_TIMEOUT_MS = 10 * 60 * 1000` timeout check in `checkStop()`
7. **ST-3.7**: Implement `discoverySource` tracking at all discovery points
8. **ST-3.8**: Implement `linkText` capture during link extraction
9. **ST-3.9**: Stop overloading `foundOn` — clean up `['seed']`, `['breadcrumb-climb']`, `['user-command']` entries
10. **ST-3.10**: Add `discoveredPages?: Array<[string, DiscoveredPage]>` to `BfsTreeSnapshotEvent` type (line 72-78). Include populated field in `tree-snapshot` SSE event payload.
11. **ST-3.11**: Update `stoppedBy` type union to `'exhausted' | 'user-stop' | 'yield-limit' | 'url-cap' | 'timeout'` in `BfsCompleteEvent` (line 100) and `BfsDiscoveryResult.stats` (line 126)
12. **ST-3.12**: Update all **8** `checkStop()` call sites (lines 896, 916, 945, 975, 992, 1057, 1086, 1146) to match new return type `{ stopped, exploreBranchUrls }`. **Per-phase policy**: Only Phase 1b (line 975) and Phase 3 (line 1146) should enqueue `exploreBranchUrls` into the visit queue. Phase 0 (line 896), Phase 1a (line 916, 945), and Phase 2 breadcrumb-climb (line 1057, 1086) should destructure but discard `exploreBranchUrls` (these phases have fixed visit targets).
13. **ST-3.13**: Run `pnpm build --filter=crawler-mcp-server`
14. ⚠️ **ST-3.14 (Wave 2, after T-2)**: Wire `buildHybridTree` into `emitTreeSnapshot()` and `buildResult()` (replacing `buildTree` calls at lines 656 and 1231). Pass `breadcrumbChains` accumulated during discovery. **This subtask executes in Wave 2 after T-2 completes — NOT in Wave 1.** The implementer for T-3 Wave 1 work completes ST-3.1 through ST-3.13. ST-3.14 is picked up as a follow-on in Wave 2.

### Acceptance Criteria

- AC-1: (C-2) Sending `explore-branch` command during discovery enqueues URLs for immediate visit
- AC-2: (M-6) Tree snapshots emitted every 5s during ALL phases, not just Phase 3
- AC-3: (H-5) Activity log messages emitted during Phase 0 within 3s of start
- AC-4: (M-4) Phase 1b visits at most 50 URLs per seed
- AC-5: (M-5) Discovery stops after 10 minutes with `stoppedBy: 'timeout'`
- AC-6: Every `DiscoveredPage` has a valid `discoverySource` — no overloaded `foundOn` entries
- AC-7: `linkText` populated from anchor text for newly discovered URLs
- AC-8: `tree-snapshot` events include `discoveredPages` field

---

## Task T-4: Graph Persistence (`apps/search-ai`)

### Files to Modify

- `apps/search-ai/src/routes/discovery.ts` — persist `discoveredPages` on every snapshot

### Detailed Changes

#### Extend `persistTreeSnapshot` (line 171-198)

**Current** (line 171-198): Signature is `(domain, tree, totalUrls, totalVisited)`. Persists only `treeHierarchy`, `totalPagesVisited`, `totalUrlsFound`.

**Fix**: Add 5th parameter for discoveredPages. Update signature AND call site:

```typescript
// Updated signature (line 171):
async function persistTreeSnapshot(
  domain: string,
  tree: unknown[],
  totalUrls: number,
  totalVisited: number,
  discoveredPages?: Array<[string, unknown]>,  // V2: graph data
): Promise<void> {

// In the $set object, conditionally include discoveredUrls:
const $set: Record<string, unknown> = {
  treeHierarchy: tree,
  totalPagesVisited: totalVisited,
  totalUrlsFound: totalUrls,
  lastDiscoveryAt: new Date(),
};

// V2: persist graph data on every snapshot (H-4)
if (discoveredPages && discoveredPages.length > 0) {
  const truncated = truncateFoundOnForPersistence(discoveredPages);
  if (truncated !== null) {  // null = skip (too large)
    $set.discoveredUrls = truncated;
  }
}
```

**Update BOTH call sites:**

1. Line 471 (`tree-snapshot` handler) — pass `discoveredPages` from the SSE event payload
2. Line 521 (`complete` handler) — pass `discoveredPages` from the result event payload

Both must be updated or the graph data is lost on discovery completion.

#### BSON size guard

```typescript
/**
 * Truncate foundOn arrays to 10 entries per page for BSON safety.
 * Skip entire graph persist if serialized size > 12MB.
 */
function truncateFoundOnForPersistence(
  pages: Array<[string, IDiscoveredPage]>,
): IDiscoveredPage[] | null {
  const MAX_FOUND_ON = 10;
  const MAX_BSON_BYTES = 12 * 1024 * 1024;

  const truncated = pages.map(([url, page]) => ({
    ...page,
    url,
    foundOn: page.foundOn?.slice(0, MAX_FOUND_ON) ?? [],
    childUrls: page.childUrls?.slice(0, MAX_FOUND_ON) ?? [],
  }));

  // Quick size estimate: JSON length is a reasonable proxy for BSON size
  const estimatedSize = JSON.stringify(truncated).length;
  if (estimatedSize > MAX_BSON_BYTES) {
    log.warn('Skipping graph persist — estimated size exceeds 12MB', {
      estimatedSize,
      pageCount: truncated.length,
    });
    return null; // Skip — return null to preserve previous data (NOT empty array which erases it)
  }

  return truncated;
}
```

#### Forward enriched event to frontend

The SSE proxy (lines 306-640) currently forwards events verbatim. V2 adds `discoveredPages` to the `tree-snapshot` event. Ensure the proxy does NOT strip this field.

Check line 400-420 area — if the proxy destructures and re-serializes, ensure `discoveredPages` is included. If it forwards the raw SSE string, no change needed.

### Subtasks

1. **ST-4.1**: Add `truncateFoundOnForPersistence()` helper function
2. **ST-4.2**: Update `persistTreeSnapshot` signature (add 5th param `discoveredPages`) and update BOTH call sites: line 471 (`tree-snapshot` handler) AND line 521 (`complete` handler). Note: the MongoDB field is `discoveredUrls` (existing schema name) while the SSE event field is `discoveredPages` (V2 name) — this naming mismatch is intentional to avoid a schema migration.
3. **ST-4.3**: Verify SSE proxy forwards `discoveredPages` field (no stripping)
4. **ST-4.4**: Run `pnpm build --filter=search-ai`

### Acceptance Criteria

- AC-1: After a mid-discovery tree-snapshot, `SiteDiscovery.discoveredUrls` contains the graph data
- AC-2: `foundOn` arrays truncated to 10 entries per page in MongoDB
- AC-3: Graph data >12MB is skipped with warning log (tree still persists)
- AC-4: Page reload after stop reconstructs the same tree from persisted graph

#### Scenario C (Recrawl) — graph reload path

On page return (user navigates back to a domain that has prior discovery), the existing flow loads `SiteDiscovery.treeHierarchy` via `GET /discovery/:domain` (search-ai discovery.ts). The V2 tree stored in `treeHierarchy` already contains all enriched fields (foundOn, discoverySource, isVirtual, etc.) because `buildHybridTree` produces enriched `TreeNode[]` that get persisted verbatim. The frontend's `treeSnapshotToUnifiedTree` converts these back to `UnifiedTreeNode[]` — same code path as live discovery. **No additional implementation needed** for Scenario C: the persisted tree IS the V2 tree. The `discoveredPages` graph data is also available in `discoveredUrls` for future re-discovery operations (Build 3).

---

## Task T-5: Frontend Core (`apps/studio`)

### Files to Modify

- `apps/studio/src/components/search-ai/crawl-flow/discovery/unified-tree-types.ts` — extend types + fix stats
- `apps/studio/src/components/search-ai/crawl-flow/discovery/tree-merge.ts` — extend `BackendTreeNode`, update conversion, fix toggle
- `apps/studio/src/components/search-ai/crawl-flow/discovery/UnifiedTreeNodeRow.tsx` — V2 badges, virtual folder checkbox
- `apps/studio/src/components/search-ai/crawl-flow/discovery/UnifiedTreeHeader.tsx` — view toggle toolbar
- `apps/studio/src/components/search-ai/crawl-flow/discovery/UnifiedTree.tsx` — recursive toggle, V2 footer stats
- `apps/studio/src/api/discovery.ts` — extend `BfsTreeSnapshotEvent` + `BfsCompleteEvent` types
- `apps/studio/src/components/search-ai/crawl-flow/State2Analysis.tsx` — remove dead `handleConfigureCrawl` (G-11)

### Detailed Changes

#### 1. `unified-tree-types.ts`

**Extend `UnifiedTreeNode`** (line 26-61) — add after `foundOn`:

```typescript
discoverySource?: string;    // 'primary' | 'seed' | 'bfs' | 'breadcrumb-climb' | 'nav' | 'user-command' | 'sitemap'
isGlobalLink?: boolean;      // nav/footer link
isVirtual?: boolean;         // synthesized folder node
childPageCount?: number;     // leaf pages under this node
linkFrequency?: number;      // foundOn count
pageRole?: 'hub' | 'leaf' | 'mixed'; // M-13: page classification from backend
```

**Extend `UnifiedNodeSource`** (line 17-23) — add `'bfs-discovered'` already exists. Add to the type:

```typescript
export type UnifiedNodeSource =
  | 'nav-header'
  | 'nav-footer'
  | 'nav-mega-menu'
  | 'sitemap'
  | 'http-explored'
  | 'bfs-discovered'
  | 'virtual'; // NEW — for synthesized folder nodes
```

**Extend `UnifiedTreeStats`** (line 64-74) — add:

```typescript
virtualFolders: number; // count of virtual folder nodes selected
sitemapPages: number; // pages from sitemap source
exploredPages: number; // pages from BFS/explored source
```

**Fix `computeTreeStats`** (line 79-111) — fix G-9 double-counting:

```typescript
// Only count pages at leaf level or non-virtual nodes
// Virtual folder pageCount = 0, children counted separately
if (node.included && !node.isVirtual) {
  stats.includedPages += node.pageCount ?? 0;
}
if (node.isVirtual && node.included) {
  stats.virtualFolders++;
}
// Track source breakdown
if (node.included && node.source === 'sitemap') {
  stats.sitemapPages += node.pageCount ?? 0;
} else if (node.included && !node.isVirtual) {
  stats.exploredPages += node.pageCount ?? 0;
}
```

#### 2. `tree-merge.ts`

**Extend `BackendTreeNode`** (line 380-389) — add V2 fields:

```typescript
interface BackendTreeNode {
  url: string;
  label: string;
  children: BackendTreeNode[];
  depth: number;
  visited: boolean;
  renderMethod: 'http' | 'browser' | 'unknown';
  pageRole?: 'hub' | 'leaf' | 'mixed';
  status: 'discovered' | 'visiting' | 'visited' | 'error';
  // V2
  foundOn?: string[];
  discoverySource?: string;
  isGlobalLink?: boolean;
  isVirtual?: boolean;
  childPageCount?: number;
  errorMessage?: string;
}
```

**Update `treeSnapshotToUnifiedTree`** (line 405-451) — map V2 fields:

In the `convertNode` function, add after existing field mappings:

```typescript
foundOn: backendNode.foundOn,
discoverySource: backendNode.discoverySource,
isGlobalLink: backendNode.isGlobalLink ?? false,
isVirtual: backendNode.isVirtual ?? false,
childPageCount: backendNode.childPageCount,
source: backendNode.isVirtual ? 'virtual' : (backendNode.discoverySource === 'sitemap' ? 'sitemap' : 'bfs-discovered'),
```

**Fix `toggleNodeIncluded`** (line 322-340) — make virtual folders always recursive:

```typescript
export function toggleNodeIncluded(
  tree: UnifiedTreeNode[],
  nodeId: string,
  included: boolean,
  recursive: boolean = false,
): UnifiedTreeNode[] {
  return tree.map(function updateNode(node): UnifiedTreeNode {
    if (node.id === nodeId) {
      // G-2 fix: virtual folders are ALWAYS recursive
      const effectiveRecursive = recursive || node.isVirtual === true;
      if (effectiveRecursive) {
        return setSubtreeIncluded({ ...node }, included);
      }
      return { ...node, included, children: node.children.map(updateNode) };
    }
    return { ...node, children: node.children.map(updateNode) };
  });
}
```

#### 3. `UnifiedTreeNodeRow.tsx`

**Fix G-1: Virtual folder checkbox hidden** (line 75-78):

```typescript
// BEFORE:
const showCheckbox =
  mode === 'select' &&
  (node.status === 'explored' || node.status === 'auto-matched') &&
  !isExcluded;

// AFTER — also show checkbox for virtual folders:
const showCheckbox =
  mode === 'select' &&
  (node.status === 'explored' || node.status === 'auto-matched' || node.isVirtual) &&
  !isExcluded;
```

**Add V2 badges** — after the existing badges section (around line 228):

```typescript
{/* V2: discoverySource badge */}
{node.discoverySource && node.discoverySource !== 'bfs' && (
  <Badge variant="default" appearance="outlined" className="text-[10px] shrink-0">
    {node.discoverySource}
  </Badge>
)}

{/* V2: Global link badge */}
{node.isGlobalLink && (
  <Badge variant="warning" appearance="outlined" className="text-[10px] shrink-0">
    Global
  </Badge>
)}

{/* V2: linkFrequency badge (linked from N pages) */}
{(node.linkFrequency ?? 0) > 1 && !node.isGlobalLink && (
  <Tooltip content={`Linked from ${node.linkFrequency} pages${node.foundOn?.length ? ': ' + node.foundOn.slice(0, 5).join(', ') : ''}`}>
    <span>
      <Badge variant="info" appearance="outlined" className="text-[10px] shrink-0">
        🔗{node.linkFrequency}
      </Badge>
    </span>
  </Tooltip>
)}

{/* V2: Virtual folder indicator */}
{node.isVirtual && (
  <Badge variant="default" className="text-[10px] shrink-0 italic">
    virtual
  </Badge>
)}
```

**Update folder icon for virtual nodes** (line 136-146):

```typescript
{hasChildren ? (
  isCollapsed ? (
    <Folder className={clsx('w-4 h-4', node.isVirtual ? 'text-foreground-meta' : 'text-warning')} />
  ) : (
    <FolderOpen className={clsx('w-4 h-4', node.isVirtual ? 'text-foreground-meta' : 'text-warning')} />
  )
) : (
  <FileText className="w-4 h-4 text-foreground-meta" />
)}
```

**Fix M-12: Error tooltip with full message** (line 246-264):

```typescript
{isError && (
  <Tooltip content={node.errorMessage ?? 'Failed'}>
    <span className="flex items-center gap-1 shrink-0">
      <span className="text-xs text-error truncate max-w-[150px]">
        {node.errorMessage ?? 'Failed'}
      </span>
      {/* ... retry button unchanged */}
    </span>
  </Tooltip>
)}
```

#### 4. `UnifiedTreeHeader.tsx`

**Add props** (line 32-46):

```typescript
export interface UnifiedTreeHeaderProps {
  // ... existing props
  /** Current tree view mode */
  viewMode?: TreeViewMode;
  /** Callback when view mode changes */
  onViewModeChange?: (mode: TreeViewMode) => void;
  /** Whether sitemap is available for this domain */
  hasSitemap?: boolean;
  /** Callback when "Add from Sitemap" is clicked */
  onAddFromSitemap?: () => void;
}
```

**Add toolbar row** — after the search input, before the samples context bar:

```typescript
{/* V2: View toggle + Add from Sitemap toolbar */}
{mode === 'select' && (
  <div className="flex items-center justify-between mt-2 p-2 bg-background-muted/50 rounded-md">
    <div className="flex items-center gap-1">
      <span className="text-xs text-foreground-meta mr-1">View:</span>
      {(['hybrid', 'crawl-path', 'url-path'] as const).map((m) => (
        <Button
          key={m}
          variant={viewMode === m ? 'primary' : 'ghost'}
          size="xs"
          onClick={() => onViewModeChange?.(m)}
        >
          {m === 'hybrid' ? 'Hybrid' : m === 'crawl-path' ? 'Crawl Path' : 'URL Path'}
        </Button>
      ))}
    </div>
    {hasSitemap && onAddFromSitemap && (
      <Button variant="ghost" size="xs" onClick={onAddFromSitemap}>
        📋 Add from Sitemap
      </Button>
    )}
  </div>
)}
```

#### 5. `UnifiedTree.tsx`

**Fix G-2: Make toggle recursive for virtual folders** (line 280-285):

```typescript
const handleToggleIncluded = useCallback(
  (nodeId: string, included: boolean) => {
    // toggleNodeIncluded now auto-detects virtual folders and goes recursive
    onTreeChange(toggleNodeIncluded(tree, nodeId, included));
  },
  [tree, onTreeChange],
);
```

(No change needed here — the fix is in `toggleNodeIncluded` in tree-merge.ts above)

**Update footer for V2** (line 382-417):

```typescript
{mode === 'select' && (
  <>
    <div className="text-xs text-foreground-meta" data-testid="unified-tree-footer-stats">
      {stats.virtualFolders > 0 ? (
        <>
          <span className="font-medium text-foreground">{stats.virtualFolders}</span> folders
          {' + '}
          <span className="font-medium text-foreground">{stats.includedNodes - stats.virtualFolders}</span> pages selected
        </>
      ) : (
        <>
          <span className="font-medium text-foreground">{stats.includedNodes}</span> sections selected
        </>
      )}
      {' · '}
      <span className="font-medium text-foreground">{stats.includedPages}</span> pages in scope
      {stats.sitemapPages > 0 && (
        <>
          <br />
          <span className="text-foreground-meta">
            Sources: {stats.exploredPages} explored · {stats.sitemapPages} from sitemap
          </span>
        </>
      )}
    </div>
    <Button
      variant="primary"
      size="sm"
      disabled={stats.includedNodes === 0 || isExploring}
      loading={isExploring}
      onClick={onConfigureCrawl}
      data-testid="configure-crawl-btn"
    >
      Continue with {stats.includedNodes} sections
    </Button>
  </>
)}
```

#### 6. `api/discovery.ts`

Extend `BfsTreeSnapshotEvent` to include `discoveredPages`:

```typescript
interface BfsTreeSnapshotEvent {
  type: 'tree-snapshot';
  tree: BackendTreeNode[];
  discoveredPages?: Array<[string, DiscoveredPage]>; // V2: graph data
  totalUrls: number;
  totalVisited: number;
  timestamp: number;
}
```

### Subtasks

1. **ST-5.1**: Extend `UnifiedTreeNode`, `UnifiedNodeSource`, `UnifiedTreeStats` types
2. **ST-5.2**: Extend `BackendTreeNode`, update `treeSnapshotToUnifiedTree` to map V2 fields
3. **ST-5.3**: Fix `computeTreeStats` for virtual folder double-counting (G-9)
4. **ST-5.4**: Fix `toggleNodeIncluded` for auto-recursive virtual folders (G-2)
5. **ST-5.5**: Fix `showCheckbox` in `UnifiedTreeNodeRow` for virtual folders (G-1)
6. **ST-5.6**: Add V2 badges: discoverySource, Global, linkFrequency, virtual
7. **ST-5.7**: Add view toggle toolbar to `UnifiedTreeHeader`
8. **ST-5.8**: Update footer stats in `UnifiedTree` for V2 breakdown
9. **ST-5.9**: Extend `BfsTreeSnapshotEvent` in `api/discovery.ts`
10. **ST-5.10**: Clean up dead code `handleConfigureCrawl` in State2Analysis.tsx (G-11)
11. **ST-5.11**: Add `| 'timeout'` to `BfsCompleteEvent.stoppedBy` in `api/discovery.ts:132` (mirrors T-3 backend change)
12. **ST-5.12**: Map `pageRole` from `BackendTreeNode` to `UnifiedTreeNode` in `treeSnapshotToUnifiedTree`. Add pageRole badge in `UnifiedTreeNodeRow` (M-13): show hub/leaf/mixed icon next to node label.
13. **ST-5.13**: Add `childPageCount` display on folder nodes — show `[N pg]` badge (L-8)
14. **ST-5.14**: Run `pnpm build --filter=studio`

### Acceptance Criteria

- AC-1: Virtual folder nodes show checkbox in select mode (G-1 fixed)
- AC-2: Checking a virtual folder recursively selects all children (G-2 fixed)
- AC-3: Footer shows "N folders + M pages selected" when virtual folders present
- AC-4: No double-counting in page totals (G-9 fixed)
- AC-5: V2 badges render: discoverySource, Global, linkFrequency, virtual
- AC-6: View toggle switches between Hybrid/Crawl Path/URL Path
- AC-7: Error nodes show full message on tooltip hover (M-12)
- AC-8: Backend V2 tree fields map correctly to frontend `UnifiedTreeNode`

---

## Task T-6: Explore-Branch Wiring (`apps/crawler-mcp-server` + `apps/studio`)

### Files to Modify

- `apps/studio/src/components/search-ai/crawl-flow/UnifiedDiscoveryPanel.tsx` — wire `onExploreNode` to backend command
- `apps/crawler-mcp-server/src/server.ts` — verify command endpoint accepts explore-branch

### Detailed Changes

#### `UnifiedDiscoveryPanel.tsx`

**Current** (line 164-180): `handleExploreNode` calls `markNodeExploring` on the tree but does NOT send a command to the backend. The explore-branch command is never dispatched.

**Fix**: Wire the existing `discoverMore()` from `@/api/discovery` (line 247) into the handler. Uses existing `markNodeExploring` (tree-merge.ts:233) and `markNodeError` (tree-merge.ts:254):

```typescript
import { discoverMore } from '@/api/discovery';
import { markNodeExploring, markNodeError } from './discovery/tree-merge';

const handleExploreNode = useCallback(
  async (nodeId: string, nodeUrl: string) => {
    // Mark node as exploring in tree
    onTreeChange(markNodeExploring(tree, nodeId, `explore-${nodeId}`));

    // Send explore-branch command to backend via existing API
    try {
      await discoverMore(sourceId, { type: 'explore-branch', url: nodeUrl });
    } catch (err) {
      // Revert on failure
      onTreeChange(markNodeError(tree, nodeId, 'Failed to start exploration'));
    }
  },
  [tree, onTreeChange, sourceId],
);
```

The backend endpoint `POST /discovery/:id/discover-more` (search-ai discovery.ts:645) already accepts `explore-branch` type via its Zod schema (line 62).

#### `apps/crawler-mcp-server/src/server.ts`

Verify the command endpoint exists and accepts `explore-branch` type. The command queue in `command-queue.ts` already handles this type (line 532 of bfs-discovery.ts). Just verify the HTTP endpoint forwards it.

### Subtasks

1. **ST-6.1**: Wire `handleExploreNode` in `UnifiedDiscoveryPanel.tsx` to call existing `discoverMore()` from `@/api/discovery` (line 247) with `{ type: 'explore-branch', url: nodeUrl }`. No new API functions needed — `api/discovery.ts` is owned by T-5 for type changes only.
2. **ST-6.2**: Verify backend `POST /discovery/:id/discover-more` accepts `explore-branch` type (Zod schema at search-ai discovery.ts:62)
3. **ST-6.3**: Run `pnpm build --filter=studio`

### Acceptance Criteria

- AC-1: Clicking "Explore Branch" on a node sends explore-branch command to backend
- AC-2: Node shows exploring spinner while backend visits URLs
- AC-3: Tree updates when backend emits next snapshot with new pages under the branch
- AC-4: Error handling — node reverts to error state if command fails

---

## Task T-7: Layer 5 — Sitemap + Selection (`apps/studio`)

### Files to Create

- `apps/studio/src/components/search-ai/crawl-flow/discovery/sitemap-merge.ts` — sitemap merge utilities
- `apps/studio/src/components/search-ai/crawl-flow/discovery/AddFromSitemapButton.tsx` — dialog component

### Files to Modify

- `apps/studio/src/components/search-ai/crawl-flow/discovery/tree-to-sections.ts` — handle virtual folders (G-3, G-4, G-12)
- `apps/studio/src/components/search-ai/crawl-flow/CrawlFlowV5.tsx` — persist discovery section URLs to draft buckets (G-5)

### Detailed Changes

#### 1. `sitemap-merge.ts` (NEW)

```typescript
import type { UnifiedTreeNode } from './unified-tree-types';
import { normalizeDiscoveryUrl } from './url-set';

/** Common URL patterns to auto-exclude at sitemap import */
export const EXCLUSION_PATTERNS = [
  /^\/(login|logout|signin|signout|register|signup)\b/i,
  /^\/(cart|checkout|basket|order)\b/i,
  /^\/api\//i,
  /^\/(admin|dashboard|cms)\b/i,
  /^\/(account|profile|settings|preferences)\b/i,
  /^\/(search|results)\b/i,
];

export interface SitemapMergePreview {
  totalSitemapUrls: number;
  newUrls: number; // not already in tree
  overlapUrls: number; // already in tree
  excludedUrls: number; // matched exclusion patterns
  pathGroups: Array<{ path: string; count: number }>;
}

/**
 * Preview what "Add from Sitemap" would do — without modifying the tree.
 */
export function previewSitemapMerge(
  tree: UnifiedTreeNode[],
  sitemapUrls: string[],
): SitemapMergePreview;

/**
 * Merge sitemap URLs into the tree. Returns a new tree.
 * - Dedup by normalizeDiscoveryUrl
 * - Apply exclusion patterns → included=false
 * - New nodes get source='sitemap', discoverySource='sitemap'
 */
export function mergeSitemapUrlsIntoTree(
  tree: UnifiedTreeNode[],
  sitemapUrls: string[],
  baseUrl: string,
): UnifiedTreeNode[];

/**
 * Check if a URL matches any exclusion pattern.
 */
export function matchesExclusionPattern(url: string): boolean;
```

This uses `normalizeDiscoveryUrl` from `url-set.ts` (G-7 fix — standardize on one normalizer).

#### 2. `AddFromSitemapButton.tsx` (NEW)

Dialog component that:

1. On button click, calls `clusterUrls()` API to fetch sitemap data (or reuses `sections` prop if already loaded)
2. Shows preview: URL count, top-level path groups, auto-exclude toggles
3. On confirm, calls `mergeSitemapUrlsIntoTree()` and propagates via `onTreeChange`

```typescript
export interface AddFromSitemapButtonProps {
  primaryUrl: string;
  tree: UnifiedTreeNode[];
  onTreeChange: (tree: UnifiedTreeNode[]) => void;
  /** Pre-loaded sitemap sections from profiling pipeline (optional — avoids re-fetch) */
  existingSections?: CrawlSection[];
  hasSitemap: boolean;
}
```

The dialog uses the approved UX from the HLD:

- Path group list with URL counts
- Auto-exclude checkboxes (togglable)
- Overlap/new URL counts
- "Add N URLs" / "Cancel" buttons

#### 3. `tree-to-sections.ts` — fixes G-3, G-4, G-10, G-12

**Fix G-3: treeToSections skips virtual folders** (line 33-34):

```typescript
// BEFORE:
if (node.included) {
  if (node.status === 'explored' && (node.pageCount ?? 0) > 0) {
    sections.push(nodeToSection(node, sectionIndex++));
  }

// AFTER — handle virtual folders by aggregating children:
if (node.included) {
  if (node.isVirtual) {
    // G-3/G-4: Virtual folder → aggregate all descendant pages into one section
    const aggregated = aggregateVirtualFolder(node);
    if (aggregated.pages.length > 0) {
      sections.push(virtualFolderToSection(node, aggregated, sectionIndex++));
    }
  } else if (node.source === 'sitemap') {
    // Sitemap nodes have no 'explored' status — they're user-imported, always eligible
    sections.push(nodeToSection(node, sectionIndex++));
  } else if ((node.status === 'explored' || node.status === 'auto-matched') && (node.pageCount ?? 0) > 0) {
    sections.push(nodeToSection(node, sectionIndex++));
  }
```

**New helper `aggregateVirtualFolder`**:

```typescript
function aggregateVirtualFolder(node: UnifiedTreeNode): {
  pages: Array<{ url: string; title: string }>;
  pattern: string;
  strategy: 'http' | 'browser';
} {
  const pages: Array<{ url: string; title: string }> = [];
  const strategies = new Set<string>();

  function collectPages(n: UnifiedTreeNode) {
    if (n.pages) pages.push(...n.pages);
    if (n.renderMethod) strategies.add(n.renderMethod);
    n.children.forEach(collectPages);
  }
  node.children.forEach(collectPages);

  // G-12 fix: derive pattern from actual child URLs, not label
  const commonPrefix = findCommonUrlPrefix(pages.map((p) => p.url));
  const pattern = commonPrefix
    ? `${commonPrefix}/*`
    : `/${node.label.toLowerCase().replace(/\s+/g, '-')}/*`;
  const strategy = strategies.has('browser') ? 'browser' : 'http';

  // ...
}

/**
 * Find the longest common URL path prefix from a list of URLs.
 * Returns the common path prefix or empty string if none.
 *
 * Example: ['/products/shoes/a', '/products/shoes/b'] → '/products/shoes'
 */
function findCommonUrlPrefix(urls: string[]): string {
  if (urls.length === 0) return '';
  const paths = urls.map((u) => {
    try {
      return new URL(u).pathname;
    } catch {
      return u;
    }
  });
  const segments = paths.map((p) => p.split('/').filter(Boolean));
  if (segments.length === 0) return '';
  const first = segments[0];
  let commonLength = 0;
  for (let i = 0; i < first.length; i++) {
    if (segments.every((s) => s[i] === first[i])) {
      commonLength = i + 1;
    } else {
      break;
    }
  }
  return commonLength > 0 ? '/' + first.slice(0, commonLength).join('/') : '';

  return { pages, pattern, strategy };
}
```

**Fix G-10: sectionId instability** — use content-based ID:

```typescript
// BEFORE:
sectionId: `sec-${index}`,

// AFTER — stable ID from URL or label (use generateNodeId which wraps simpleHash):
import { generateNodeId } from './unified-tree-types';
sectionId: generateNodeId(node.url || node.label, node.label),
```

Note: `simpleHash` is module-private in `unified-tree-types.ts`. Use the exported `generateNodeId(url, label)` wrapper instead.

#### 4. `CrawlFlowV5.tsx` — fix G-5

**Fix G-5: Discovery sections have no draft bucket URLs** (around line 587):

In `handleSectionsChange` (or in `handleContinue` before state transition), persist discovery section URLs to draft buckets:

```typescript
// In handleSectionsChange or handleContinue:
if (sections.some((s) => s.pages && s.pages.length > 0)) {
  // Persist section URLs to draft buckets for later retrieval
  persistSectionUrls(draftId, sections);
}
```

Verify `persistSectionUrls` (line 278-297) is called for discovery-path sections, not just sitemap-path sections.

### Subtasks

1. **ST-7.1**: Create `sitemap-merge.ts` with `EXCLUSION_PATTERNS`, `previewSitemapMerge`, `mergeSitemapUrlsIntoTree`, `matchesExclusionPattern`
2. **ST-7.2**: Create `AddFromSitemapButton.tsx` dialog component
3. **ST-7.3**: Fix G-3/G-4: Add `aggregateVirtualFolder` + `virtualFolderToSection` to `tree-to-sections.ts`
4. **ST-7.4**: Fix G-12: Derive pattern from child URLs, not label
5. **ST-7.5**: Fix G-10: Use content-based sectionId hash
6. **ST-7.6**: Fix G-5: Persist discovery section URLs to draft buckets in `CrawlFlowV5.tsx`
7. **ST-7.7**: Wire `AddFromSitemapButton` into `UnifiedTreeHeader` (via props from `UnifiedDiscoveryPanel`)
8. **ST-7.8**: Wire `AddFromSitemapButton` into `UnifiedDiscoveryPanel` — pass `existingSections` from State2Analysis
9. **ST-7.9**: G-7 fix (frontend only) — use `normalizeDiscoveryUrl` from `url-set.ts` in `sitemap-merge.ts` for all URL dedup/comparison. Backend normalizers unchanged (deferred to Build 3).
10. **ST-7.10**: G-6 fix — In `mergeSitemapUrlsIntoTree`, when consuming cluster-urls API response, adapt `UrlGroup` shape (`{examples: string[], count}` from `api/crawl.ts`) to the internal tree format. The adapter extracts URLs from `examples` and `count` fields.
11. **ST-7.11**: D-8 SSE conflict mitigation — When discovery is still active (SSE stream open) and user merges sitemap URLs, the frontend must preserve sitemap-merged nodes across incoming `tree-snapshot` events. In `treeSnapshotToUnifiedTree`, detect and re-merge any nodes with `source === 'sitemap'` that aren't present in the new backend snapshot. Store sitemap-merged URLs in a `Set<string>` on the panel state so they survive SSE updates. Disable "Add from Sitemap" button while discovery is actively running (show tooltip: "Complete discovery first, then add sitemap URLs") — this is the simplest safe approach.
12. **ST-7.12**: Handle sitemap node status in `treeToSections` — sitemap-sourced nodes have `status: undefined` (not 'explored'). The filter must accept `source === 'sitemap'` as an alternative eligibility criterion (see fix in tree-to-sections.ts section above).
13. **ST-7.13**: Run `pnpm build --filter=studio`

### Acceptance Criteria

- AC-1: "Add from Sitemap" dialog shows URL count, path groups, exclusion toggles
- AC-2: Confirming merge adds sitemap nodes to tree with `[sitemap]` badge
- AC-3: Duplicate URLs (already in tree) are skipped
- AC-4: Exclusion patterns (/login, /cart, /api/) default to `included: false`
- AC-5: Virtual folder selected → `treeToSections` produces one section with all descendant pages
- AC-6: Section pattern derived from child URLs, not label (G-12 fixed)
- AC-7: Discovery sections have URLs persisted to draft buckets (G-5 fixed)
- AC-8: sectionId stable across re-renders (G-10 fixed)
- AC-9: UrlGroup adapter correctly maps `{examples, count}` to tree-compatible format (G-6 fixed)
- AC-10: "Add from Sitemap" button disabled during active discovery with tooltip explanation
- AC-11: Sitemap-sourced nodes included in `treeToSections` output (status filter handles sitemap source)

---

## Task T-8: Unit Tests

### Files to Create

- `apps/crawler-mcp-server/src/explore/__tests__/hybrid-tree-builder.test.ts`
- `apps/studio/src/components/search-ai/crawl-flow/discovery/__tests__/tree-merge.test.ts`
- `apps/studio/src/components/search-ai/crawl-flow/discovery/__tests__/tree-to-sections.test.ts`
- `apps/studio/src/components/search-ai/crawl-flow/discovery/__tests__/sitemap-merge.test.ts`

### Test Cases

#### `hybrid-tree-builder.test.ts`

| Test                                | What it validates                                         |
| ----------------------------------- | --------------------------------------------------------- |
| Hybrid mode: FAQ under printer page | C-1 fix — cross-path page placed by foundOn, not URL path |
| Global link detection               | H-3 — links on >30% pages marked isGlobalLink             |
| Global links use URL-path parent    | Global links fall through foundOn to URL-path             |
| Virtual node synthesis              | Gap at `/a/b` when only `/a/b/c` exists                   |
| Label priority chain                | title > breadcrumbLabel > linkText > humanizedSlug        |
| `humanizeSlug` edge cases           | ID stripping, title-casing, complex patterns              |
| childPageCount bottom-up            | Correctly sums leaf pages                                 |
| crawl-path mode                     | Uses foundOn[0] as parent                                 |
| url-path mode                       | Matches current buildTree behavior                        |
| Primary URL always first root       | Never orphaned                                            |
| Empty allUrls                       | Returns empty array                                       |
| Single URL                          | Returns single-node tree                                  |
| Breadcrumb parent takes priority    | When breadcrumb chain exists, overrides foundOn           |

#### `tree-merge.test.ts`

| Test                                          | What it validates                                                 |
| --------------------------------------------- | ----------------------------------------------------------------- |
| `treeSnapshotToUnifiedTree` maps V2 fields    | foundOn, discoverySource, isGlobalLink, isVirtual, childPageCount |
| `toggleNodeIncluded` recursive for virtual    | Checking virtual folder selects all children                      |
| `toggleNodeIncluded` non-recursive for normal | Normal node toggle doesn't affect children                        |
| `mergeSitemapGroups` dedup                    | Existing URLs not duplicated                                      |
| BackendTreeNode with V2 fields                | New fields pass through conversion                                |

#### `tree-to-sections.test.ts`

| Test                                | What it validates                                    |
| ----------------------------------- | ---------------------------------------------------- |
| Virtual folder → aggregated section | G-3/G-4: descendant pages collected into one section |
| Virtual folder with no pages        | Produces no section (graceful)                       |
| Pattern from child URLs, not label  | G-12: common prefix extraction                       |
| Stable sectionId                    | G-10: same tree → same IDs                           |
| Normal explored node → section      | Existing behavior preserved                          |
| Unexplored included node → warning  | Not a section, produces warning                      |
| Mixed sources tracked               | Section source reflects content source               |
| Sitemap node included in sections   | `source === 'sitemap'` nodes pass filter             |

#### `sitemap-merge.test.ts`

| Test                           | What it validates                                     |
| ------------------------------ | ----------------------------------------------------- |
| Dedup: existing URLs skipped   | URLs already in tree are not duplicated               |
| Exclusion patterns match       | /login, /cart, /api/ patterns marked `included:false` |
| Empty sitemap input            | Returns tree unchanged                                |
| Overlap count in preview       | `previewSitemapMerge` reports correct counts          |
| Path group aggregation         | Groups URLs by top-level path segment                 |
| findCommonUrlPrefix edge cases | Empty, single URL, no common prefix                   |

### Subtasks

1. **ST-8.1**: Write hybrid-tree-builder tests (13 test cases)
2. **ST-8.2**: Write tree-merge V2 tests (5 test cases)
3. **ST-8.3**: Write tree-to-sections tests (8 test cases)
4. **ST-8.4**: Write sitemap-merge tests (6 test cases)
5. **ST-8.5**: Run all tests: `pnpm test:report --filter=crawler-mcp-server --filter=studio`

### Acceptance Criteria

- AC-1: All 32 test cases pass
- AC-2: Tests cover all 5 CRITICAL gaps (G-1 through G-5)
- AC-3: No `vi.mock` of platform components

---

## Scope Lock Verification

Every review round must check:

### Bugs IN Scope (19) — task assignment

| Bug  | Task(s)  | How addressed                                                       |
| ---- | -------- | ------------------------------------------------------------------- |
| C-1  | T-2      | Hybrid tree uses foundOn for parent selection                       |
| C-2  | T-3, T-6 | checkStop returns exploreBranchUrls; frontend wires command         |
| H-1  | T-3, T-4 | discoveredPages persisted on every snapshot                         |
| H-3  | T-2      | computeGlobalLinks identifies nav/footer links                      |
| H-4  | T-4      | persistTreeSnapshot includes discoveredUrls                         |
| H-5  | T-3      | Phase 0 activity-log emissions                                      |
| H-6  | T-2      | O(n) hybrid algorithm vs O(n log n) current                         |
| M-1  | T-2      | Breadcrumb parent is highest priority in hybrid mode                |
| M-2  | T-2      | Label priority chain: title > breadcrumb > linkText > humanizedSlug |
| M-3  | T-5      | discoverySource + foundOn badges on tree nodes                      |
| M-4  | T-3      | PHASE_1B_MAX_PER_SEED = 50                                          |
| M-5  | T-3      | OVERALL_TIMEOUT_MS = 10 min                                         |
| M-6  | T-3      | Snapshot timer starts after Phase 0                                 |
| M-7  | T-6      | onExploreNode wired to explore-branch command                       |
| M-10 | T-5      | Sample URLs show "seed" badge (discoverySource)                     |
| M-12 | T-5      | Error tooltip with full message                                     |
| M-13 | T-5      | pageRole already in UnifiedTreeNode, now rendered                   |
| L-8  | T-5      | childPageCount displayed on folder nodes                            |
| NEW  | T-5      | Three-way view toggle                                               |

### Features IN Scope (16) — task assignment

| Feature                    | Task(s)  |
| -------------------------- | -------- |
| Graph persistence          | T-4      |
| Hybrid tree algorithm      | T-2      |
| Virtual intermediate nodes | T-2      |
| Global link detection      | T-2      |
| Label priority chain       | T-2      |
| Link text capture          | T-3      |
| Discovery source tracking  | T-3      |
| Enriched TreeNode          | T-2, T-5 |
| Frontend provenance        | T-5      |
| Tree view toggle           | T-5      |
| Phase budgets              | T-3      |
| Phase 0 activity           | T-3      |
| Virtual folder checkbox    | T-5      |
| treeToSections() update    | T-7      |
| "Add from Sitemap" button  | T-7      |
| Smart exclusion defaults   | T-7      |

### Wiring Gaps (12) — task assignment

| Gap  | Task | Status                                          |
| ---- | ---- | ----------------------------------------------- |
| G-1  | T-5  | Fix in showCheckbox                             |
| G-2  | T-5  | Fix in toggleNodeIncluded                       |
| G-3  | T-7  | Fix in treeToSections                           |
| G-4  | T-7  | Fix with aggregateVirtualFolder                 |
| G-5  | T-7  | Fix in CrawlFlowV5 handleSectionsChange         |
| G-6  | T-7  | Fix with UrlGroup adapter in sitemap-merge      |
| G-7  | T-7  | Fix by using normalizeDiscoveryUrl consistently |
| G-8  | T-7  | Fix with EXCLUSION_PATTERNS                     |
| G-9  | T-5  | Fix in computeTreeStats                         |
| G-10 | T-7  | Fix with content-based sectionId                |
| G-11 | T-5  | Remove dead code                                |
| G-12 | T-7  | Fix with findCommonUrlPrefix                    |

---

## Wave Execution Plan

```
Wave 1 (parallel):
  T-1 → packages/database (schema only, ~1 file)
  T-2 → crawler-mcp-server/explore/hybrid-tree-builder.ts (NEW, pure function)
  T-3 (ST-3.1–ST-3.13 only) → crawler-mcp-server/explore/bfs-discovery.ts (engine fixes)
  ⚠️ T-3 ST-3.14 (wire buildHybridTree) deferred to Wave 2 — depends on T-2
  Zero file overlap ✓

Wave 2 (parallel):
  T-3 ST-3.14 → crawler-mcp-server/explore/bfs-discovery.ts (wire hybrid tree — after T-2)
  T-4 → search-ai/routes/discovery.ts (graph persistence)
  T-5 → studio/discovery/* (frontend types, merge, rendering)
  Zero file overlap ✓ (ST-3.14 touches bfs-discovery.ts; T-4 touches search-ai; T-5 touches studio)

Wave 3 (parallel):
  T-6 → studio/UnifiedDiscoveryPanel.tsx + crawler-mcp/server.ts (explore-branch wiring)
  T-7 → studio/discovery/sitemap-merge.ts (NEW), tree-to-sections.ts, AddFromSitemapButton.tsx (NEW), CrawlFlowV5.tsx
  Zero file overlap ✓

Wave 4 (sequential):
  T-8 → tests across all packages
```

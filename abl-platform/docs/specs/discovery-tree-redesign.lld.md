# Discovery Tree Redesign — Low-Level Design

## Task T-1: Backend Tree Engine (crawler-mcp-server)

### Files to Modify

- `apps/crawler-mcp-server/src/explore/url-normalizer.ts` — fix `normalizeUrl` to strip `www.`, fix `isSameDomain` for www equivalence
- `apps/crawler-mcp-server/src/explore/bfs-discovery.ts` — rewrite `findClosestAncestor` and `buildTree` with O(1) pathname Map; new SSE events (`tree-snapshot`, `progress`); remove incremental `parentUrl` computation; enrich TreeNode; add periodic tree rebuild timer
- `apps/crawler-mcp-server/src/server.ts` — replace double-throttle with new event model; remove `result` event serialization

### Function Signatures

#### url-normalizer.ts

```typescript
// MODIFIED — add www stripping (line ~47, inside try block)
export function normalizeUrl(raw: string): string;
// Add after hostname lowercase (existing line 45):
//   url.hostname = url.hostname.replace(/^www\./, '');

// MODIFIED — strip www before comparison
export function isSameDomain(url: string, baseUrl: string): boolean;
// Change: both hostnames get .replace(/^www\./, '') before comparison
```

#### bfs-discovery.ts

```typescript
// NEW — replace findClosestAncestor (lines 437-467)
// O(d) with pathname Map instead of O(n×d) with linear scan
function findClosestAncestor(pathname: string, pathToUrlMap: Map<string, string>): string | null;
// Algorithm:
//   1. Split pathname into segments
//   2. Walk from longest prefix down to "/"
//   3. For each prefix, check pathToUrlMap.get(prefix)
//   4. Return first match, or null (caller uses rootUrl as fallback)

// NEW — utility to extract pathname from normalized URL
function getPathname(url: string): string;
// Returns lowercase pathname without trailing slash (except root "/")

// NEW — utility to compute path depth
function getPathDepth(url: string): number;
// Returns pathname.split('/').filter(Boolean).length

// MODIFIED — rewrite buildTree (lines 474-520)
function buildTree(allUrls: Map<string, DiscoveredPage>, primaryUrl: string): TreeNode[];
// Algorithm:
//   1. Build pathToUrlMap: Map<pathname, normalizedUrl> from allUrls.keys()
//   2. Sort URLs by getPathDepth ascending (shallowest first)
//   3. Create nodeMap: Map<normalizedUrl, TreeNode>
//   4. For each URL (depth order):
//      a. Create enriched TreeNode {url, label, children:[], depth, visited, renderMethod, pageRole, status}
//      b. If url === normalizedPrimary → push to roots[0]
//      c. Else: findClosestAncestor(getPathname(url), pathToUrlMap)
//         - If found → attach as child of nodeMap.get(ancestorUrl)
//         - If not found → attach as child of root (normalizedPrimary), NOT orphan root
//   5. Return roots

// NEW — enriched TreeNode type
export interface TreeNode {
  url: string;
  label: string;
  children: TreeNode[];
  depth: number;
  visited: boolean;
  renderMethod: 'http' | 'browser' | 'unknown';
  pageRole?: 'hub' | 'leaf' | 'mixed';
  status: 'discovered' | 'visiting' | 'visited' | 'error';
  // Note: buildTree maps DiscoveredPage.status directly. 'visiting' is transient
  // (page actively being crawled at snapshot time). Frontend maps 'visiting' → 'exploring'.
}

// NEW — replaces BfsTreeUpdateEvent
export interface BfsTreeSnapshotEvent {
  type: 'tree-snapshot';
  tree: TreeNode[];
  totalUrls: number;
  totalVisited: number;
  timestamp: number;
}

// NEW — lightweight progress counter (replaces tree-update for counters)
export interface BfsProgressCounterEvent {
  type: 'progress';
  totalUrls: number;
  totalVisited: number;
  timestamp: number;
}

// MODIFIED — BfsCompleteEvent adds tree field
export interface BfsCompleteEvent {
  type: 'complete';
  totalUrls: number;
  totalVisited: number;
  totalPhasesRun: number;
  durationMs: number;
  stoppedBy: 'exhausted' | 'user-stop' | 'yield-limit' | 'url-cap';
  tree: TreeNode[]; // NEW — final canonical tree
  timestamp: number;
}

// MODIFIED — BfsProgressEvent union
export type BfsProgressEvent =
  | BfsPhaseEvent
  | BfsTreeSnapshotEvent // NEW — replaces BfsTreeUpdateEvent
  | BfsProgressCounterEvent // NEW — lightweight counters
  | BfsActivityLogEvent
  | BfsCompleteEvent
  | BfsErrorEvent;
// REMOVED: BfsUrlDiscoveredEvent, BfsTreeUpdateEvent, BfsPageVisitEvent
// Note: page-visit events are NO LONGER emitted. Visit tracking is handled
// via the progress counter (totalVisited) and the tree snapshot (node.visited flag).

// NEW — replaces emitTreeUpdate helper (inside runBfsDiscovery closure)
function emitTreeSnapshot(): void;
// Calls buildTree(allUrls, primaryUrl), emits tree-snapshot event
// Called on: phase transitions, every 5s timer, and at complete

// NEW — replaces throttled tree-update for counters
function emitProgress(): void;
// Throttled 300ms. Emits {type:'progress', totalUrls, totalVisited}
```

### Subtasks (execution order)

1. **ST-1.1**: Fix `normalizeUrl` and `isSameDomain` in `url-normalizer.ts`
   - Add `url.hostname = url.hostname.replace(/^www\./, '');` after line 45 (hostname lowercase)
   - In `isSameDomain`: strip www from both hostnames before comparison
   - Update tests in `url-normalizer.test.ts`

2. **ST-1.2**: Add utility functions to `bfs-discovery.ts`
   - `getPathname(url: string): string` — extracts lowercase pathname, strips trailing slash
   - `getPathDepth(url: string): number` — replaces 8 duplicated IIFE+try/catch blocks
   - Replace all inline depth computations with `getPathDepth`

3. **ST-1.3**: Rewrite `findClosestAncestor` in `bfs-discovery.ts`
   - Change signature to `(pathname: string, pathToUrlMap: Map<string, string>): string | null`
   - Walk path segments from longest prefix to "/" using Map.get — O(d) per call
   - Loop condition: `i >= 0` (not `i > 0`) — allows root "/" matching

4. **ST-1.4**: Rewrite `buildTree` in `bfs-discovery.ts`
   - Build `pathToUrlMap: Map<pathname, url>` from allUrls keys
   - Sort by `getPathDepth` ascending
   - Create enriched `TreeNode` with `visited`, `renderMethod`, `pageRole`, `status` from `allUrls.get(url)`
   - Orphans attach to root (never become spurious roots)

5. **ST-1.5**: New SSE event types and emission model
   - Define `BfsTreeSnapshotEvent`, `BfsProgressCounterEvent`
   - Add `tree` field to `BfsCompleteEvent`
   - Remove `BfsTreeUpdateEvent`, `BfsUrlDiscoveredEvent`, AND `BfsPageVisitEvent` from union
   - Remove all `page-visit` event emissions from `visitPage` (lines 259, 394, 417)
   - Replace `emitTreeUpdate` helper with `emitTreeSnapshot` (calls `buildTree`, emits full tree)
   - Add `emitProgress` helper (throttled 300ms, counters only)
   - Add named constant: `const TREE_SNAPSHOT_INTERVAL_MS = 5_000;`
   - Add `setInterval` for periodic `emitTreeSnapshot` during BFS phases
   - **Timer lifecycle**: Declare `let snapshotInterval: ReturnType<typeof setInterval> | null = null;` at closure scope (alongside `allUrls`, line ~653). Start after Phase 0 completes. Clear in ALL exit paths:
     - `buildResult()` (normal completion)
     - `shouldStop()` returning true (user stop / yield limit / url cap)
     - Catch block of `runBfsDiscovery` (thrown error)
     - Add `clearInterval(snapshotInterval)` to the existing `finally` block
   - **Size guard**: Add `const MAX_TIMER_SNAPSHOT_URLS = 10_000;` — above this threshold, periodic timer snapshots are skipped (only phase-transition snapshots emit). Also skip if `allUrls.size` hasn't changed since last snapshot.

6. **ST-1.6**: Remove incremental `parentUrl` computation from `visitPage`
   - In `visitPage` (line ~248): remove `findClosestAncestor` call, remove `newNodes` accumulation
   - Return only `{ links, newLinks, role }` (not `newNodes`)
   - In Phase 0 (line ~820): remove `phase0NewNodes` accumulation, remove `findClosestAncestor` calls
   - After each `visitAndTrack` call: call `emitProgress()` instead of `emitTreeUpdate(newNodes)`
   - At each phase transition: call `emitTreeSnapshot()`

7. **ST-1.7**: Remove `url-discovered` event emission
   - Delete the `onEvent({ type: 'url-discovered', ... })` call from `visitPage` (line ~358)

8. **ST-1.8**: Update `buildResult` to include tree in complete event
   - `BfsCompleteEvent` now includes `tree: TreeNode[]`
   - `BfsDiscoveryResult` KEEPS `treeHierarchy`, `navStructure`, `discoveredUrls`, `breadcrumbChains` fields
   - These are consumed by `search-ai/routes/discovery.ts` `persistFinalResult` for full SiteDiscovery persistence
   - The `complete` event carries only the tree (for frontend); the full result is returned from `runBfsDiscovery` for server-side persistence

9. **ST-1.9**: Fix server.ts SSE endpoint
   - Remove the double-throttle on `tree-update` and `page-visit` (lines 776-780)
   - Replace with: always forward all events (engine handles its own throttling)
   - KEEP `result` event serialization (lines 788-798) — carries non-tree fields (navStructure, discoveredUrls, siteProfile, sitemapUrls, breadcrumbChains) for proxy-side persistence. This event is NOT in the frontend union — it's intercepted by search-ai proxy only.
   - Forward `tree-snapshot`, `progress`, `phase`, `activity`, `complete`, `error`, `result` events

10. **ST-1.10**: Update BFS engine tests
    - Update `apps/crawler-mcp-server/src/explore/__tests__/bfs-discovery.test.ts`
    - The test collects `BfsProgressEvent` — update assertions for new event types
    - Add test: `buildTree` produces correct hierarchy from mock URL map
    - Add test: `findClosestAncestor` with pathname Map returns correct ancestors
    - Add test: `tree-snapshot` events emitted at phase transitions
    - Add test: `progress` events are throttled at 300ms

11. **ST-1.11**: Performance fix — `bfsQueue.includes()` → Set
    - Replace `bfsQueue: string[]` with `bfsQueueSet: Set<string>` at lines 1164, 1222
    - Use `bfsQueueSet.has(childUrl)` instead of `bfsQueue.includes(childUrl)` — O(1) vs O(n)
    - Keep `bfsQueue` array for ordered iteration, add `bfsQueueSet` for dedup checks
    - This fixes P-4 from the architect review

### Acceptance Criteria

- AC-1.1: `normalizeUrl('https://www.epson.com/path')` returns `'https://epson.com/path'`
  - Verify: existing + new tests in `url-normalizer.test.ts`
- AC-1.2: `isSameDomain('https://www.epson.com', 'https://epson.com')` returns `true`
  - Verify: new test case
- AC-1.3: `buildTree` produces nested hierarchy from flat URL map (not flat tree)
  - Verify: new unit test with mock URL map
- AC-1.4: `buildTree` at 1000 URLs completes in <50ms (O(n×d) not O(n²))
  - Verify: new performance test
- AC-1.5: No `tree-update` or `url-discovered` events emitted
  - Verify: grep for removed event types
- AC-1.6: `tree-snapshot` events emitted on phase transitions and every 5s
  - Verify: integration test checking event sequence
- AC-1.7: `complete` event includes `tree: TreeNode[]`
  - Verify: type check + integration test
- AC-1.8: `bfsQueue` dedup uses Set — no `includes()` calls on the queue array
  - Verify: grep for `.includes(` in bfs-discovery.ts returns zero queue-related results
- AC-1.9: `result` SSE event still emitted by server.ts with full non-tree data
  - Verify: `sendSSE('result', ...)` call exists in server.ts

---

## Task T-2: Schema Enrichment (packages/database)

### Files to Modify

- `packages/database/src/models/site-discovery.model.ts` — enrich `ITreeNode` interface and Mongoose schema

### Function Signatures

```typescript
// MODIFIED — enriched ITreeNode (lines 25-30)
export interface ITreeNode {
  url: string;
  label: string;
  children: ITreeNode[];
  depth: number;
  visited: boolean; // NEW
  renderMethod: 'http' | 'browser' | 'unknown'; // NEW
  pageRole?: 'hub' | 'leaf' | 'mixed'; // NEW
  status: 'discovered' | 'visiting' | 'visited' | 'error'; // NEW — includes 'visiting' for live snapshots
}
```

### Subtasks (execution order)

1. **ST-2.1**: Update `ITreeNode` interface
   - Add `visited: boolean`, `renderMethod`, `pageRole?`, `status` fields
   - Status includes `'visiting'` to match backend `DiscoveredPage.status` — pages actively being crawled at snapshot time have this status

2. **ST-2.2**: Update Mongoose `TreeNodeSchema`
   - Add corresponding schema fields with defaults: `visited: { type: Boolean, default: false }`, `renderMethod: { type: String, default: 'unknown' }`, `status: { type: String, enum: ['discovered', 'visiting', 'visited', 'error'], default: 'discovered' }`
   - `pageRole` is optional — no default needed

3. **ST-2.3**: Build the package
   - `pnpm build --filter=@agent-platform/database`
   - Verify no type errors

### Acceptance Criteria

- AC-2.1: `ITreeNode` type includes all 4 new fields
  - Verify: `pnpm build --filter=@agent-platform/database`
- AC-2.2: Existing `SiteDiscovery` documents with old `treeHierarchy` still load (additive fields with defaults)
  - Verify: Mongoose schema defaults apply on read

---

## Task T-3: SSE Proxy Update (search-ai)

### Files to Modify

- `apps/search-ai/src/routes/discovery.ts` — update SSE proxy to forward new events, persist tree on `tree-snapshot`, remove old event handling

### Architecture Note: SiteDiscovery Tenant Sharing

`SiteDiscovery` is intentionally tenant-shared — keyed by `domain` only, no `tenantId`. Last-write-wins. Concurrent discoveries of the same domain by different tenants overwrite each other's tree. Tenant-specific data (selections, seeds, status) is tracked in `TenantDiscovery` (scoped by `tenantId`). This is an existing design decision pre-dating this redesign.

### Function Signatures

```typescript
// MODIFIED — persistTreeSnapshot for incremental tree persistence
async function persistTreeSnapshot(
  domain: string,
  tree: ITreeNode[],
  totalUrls: number,
  totalVisited: number,
): Promise<void>;
// Upserts SiteDiscovery: $set treeHierarchy, totalPagesVisited, totalUrlsFound, lastDiscoveryAt

// KEPT — persistFinalResult still needed for full SiteDiscovery persistence
// The `result` SSE event is KEPT as a server-only event (not in BfsProgressEvent
// union — emitted by server.ts AFTER the BFS engine completes, from the return value).
// It carries: navStructure, discoveredUrls, siteProfile, sitemapUrls, breadcrumbChains.
// The search-ai proxy intercepts this event (existing code at line 488) and calls
// persistFinalResult. Frontend does NOT listen for `result` — it's a persistence-only event.
async function persistFinalResult(
  domain: string,
  resultData: Record<string, unknown>,
): Promise<void>;

// MODIFIED — readLoop event handling (lines 415-499)
// New event types to handle:
//   tree-snapshot → persist tree to SiteDiscovery (fire-and-forget)
//   progress → update TenantDiscovery.crawlConfig.lastStats
//   complete → persist final tree + trigger full result persistence
//   phase, activity → forward only (no persistence)
// Removed event types:
//   tree-update → no longer exists
//   page-visit → no longer emitted by backend
//   url-discovered → no longer exists
//   result → no longer emitted as SSE; full result comes as HTTP response body
```

### Subtasks (execution order)

1. **ST-3.1**: Add `persistTreeSnapshot` function
   - Extracts tree from `tree-snapshot` event data
   - Upserts `SiteDiscovery` by domain: `$set { treeHierarchy, totalPagesVisited, totalUrlsFound, lastDiscoveryAt }`
   - Fire-and-forget with error logging

2. **ST-3.2**: Update SSE event forwarding in `readLoop`
   - Forward all events verbatim to client (no filtering needed — engine controls what to send)
   - On `tree-snapshot`: call `persistTreeSnapshot()` with parsed tree data
   - On `progress`: update `TenantDiscovery.crawlConfig.lastStats` (existing Tier-1 logic, but keyed on `progress` event instead of `tree-update`)
   - On `complete`: call `persistTreeSnapshot()` with final tree from event, mark `TenantDiscovery.status = 'completed'`
   - KEEP `result` SSE event handling (lines 488-498): `persistFinalResult` call persists navStructure, discoveredUrls, siteProfile, sitemapUrls, breadcrumbChains
   - Remove: Tier-2 `$push` accumulation for individual pages (lines 465-485) — replaced by tree snapshots + final result event
   - On `error`: mark `TenantDiscovery.status = 'error'`. The last `tree-snapshot` persisted is the recovery point. Document: "On error, the most recent tree-snapshot in SiteDiscovery is the best available tree."

3. **ST-3.3**: Verify `result` event persistence path is intact
   - The `result` event is still emitted by server.ts after `runBfsDiscovery` completes (existing code at lines 788-798)
   - It is NOT added to the frontend `BfsSSEEvent` union — it's a proxy-only event
   - `persistFinalResult` is KEPT and continues to handle it
   - Only the server.ts throttle and tree-related SSE changes affect this path

### Acceptance Criteria

- AC-3.1: `tree-snapshot` events forwarded to client AND tree persisted to SiteDiscovery
  - Verify: manual test — check MongoDB after discovery
- AC-3.2: `complete` event triggers final tree persist and status update
  - Verify: `TenantDiscovery.status === 'completed'` after discovery
- AC-3.3: `result` event handling KEPT — `persistFinalResult` persists navStructure, discoveredUrls, siteProfile, sitemapUrls, breadcrumbChains
  - Verify: `persistFinalResult` still called on `result` event in discovery.ts
- AC-3.4: On error, `TenantDiscovery.status = 'error'` and last tree-snapshot is recovery point
  - Verify: error event handler updates status

---

## Task T-4: Frontend Rendering (studio)

### Files to Modify

- `apps/studio/src/api/discovery.ts` — update `BfsSSEEvent` union with new event types
- `apps/studio/src/hooks/useDiscovery.ts` — handle `tree-snapshot` and `progress` events; remove `tree-update`, `page-visit`, `url-discovered` handlers
- `apps/studio/src/components/search-ai/crawl-flow/UnifiedDiscoveryPanel.tsx` — replace incremental merge with snapshot receiver; remove `mergeBfsTreeUpdate`, `mergeBfsPageVisit`, `autoMatchNodes` imports; mode-aware UX
- `apps/studio/src/components/search-ai/crawl-flow/discovery/tree-merge.ts` — remove `mergeBfsTreeUpdate`, `mergeBfsPageVisit`, `bfsTreeToUnifiedTree` (dead code); keep `toggleNodeIncluded`, `flattenUnifiedTree`; add `treeSnapshotToUnifiedTree` converter
- `apps/studio/src/components/search-ai/crawl-flow/discovery/unified-tree-types.ts` — use URL as node ID (remove `simpleHash`)
- `apps/studio/src/components/search-ai/crawl-flow/discovery/UnifiedTreeHeader.tsx` — mode-aware stats (live vs select)

### Function Signatures

#### api/discovery.ts

```typescript
// NEW — replaces BfsTreeUpdateEvent
export interface BfsTreeSnapshotEvent {
  type: 'tree-snapshot';
  tree: Array<{
    url: string;
    label: string;
    children: BfsTreeSnapshotEvent['tree'];
    depth: number;
    visited: boolean;
    renderMethod: 'http' | 'browser' | 'unknown';
    pageRole?: 'hub' | 'leaf' | 'mixed';
    status: 'discovered' | 'visiting' | 'visited' | 'error';
  }>;
  totalUrls: number;
  totalVisited: number;
  timestamp: number;
}

// NEW
export interface BfsProgressCounterEvent {
  type: 'progress';
  totalUrls: number;
  totalVisited: number;
  timestamp: number;
}

// MODIFIED — BfsCompleteEvent adds tree
export interface BfsCompleteEvent {
  // ... existing fields ...
  tree: BfsTreeSnapshotEvent['tree']; // NEW
}

// MODIFIED — union
export type BfsSSEEvent =
  | BfsPhaseEvent
  | BfsTreeSnapshotEvent // NEW (replaces BfsTreeUpdateEvent)
  | BfsProgressCounterEvent // NEW
  | BfsActivityEvent
  | BfsCompleteEvent
  | BfsErrorEvent;
// REMOVED: BfsPageVisitEvent, BfsUrlDiscoveredEvent, BfsTreeUpdateEvent
// Note: BfsPageVisitEvent type definition kept for backward compat but removed from union.
// No listener registered for 'page-visit' — events won't arrive from new backend.
```

#### useDiscovery.ts

```typescript
// MODIFIED — options interface
export interface UseDiscoveryOptions {
  onTreeSnapshot?: (event: BfsTreeSnapshotEvent) => void; // NEW (replaces onTreeUpdate)
  onProgress?: (event: BfsProgressCounterEvent) => void; // NEW
  onPhaseChange?: (event: BfsPhaseEvent) => void;
  onActivity?: (event: BfsActivityEvent) => void;
  onComplete?: (event: BfsCompleteEvent) => void;
  onError?: (event: BfsErrorEvent) => void;
  onEvent?: (event: BfsSSEEvent) => void;
  maxRetries?: number;
}
// REMOVED: onTreeUpdate, onPageVisit

// MODIFIED — SSE_EVENT_TYPES
const SSE_EVENT_TYPES = [
  'phase',
  'tree-snapshot', // NEW (replaces tree-update)
  'progress', // NEW
  'activity',
  'complete',
  'error',
] as const;
// REMOVED: 'page-visit', 'url-discovered', 'tree-update'
```

#### tree-merge.ts

```typescript
// NEW — converts backend TreeNode[] to UnifiedTreeNode[]
export function treeSnapshotToUnifiedTree(
  backendTree: BfsTreeSnapshotEvent['tree'], // Uses recursive type from api/discovery.ts
  sampleUrls: string[],
): UnifiedTreeNode[];
// Algorithm:
//   1. Recursively convert backend TreeNode to UnifiedTreeNode
//   2. Set node.id = normalizedUrl (not simpleHash)
//   3. Map backend status to UnifiedNodeStatus:
//      'visited' → 'explored', 'visiting' → 'exploring', 'discovered' → 'unexplored', 'error' → 'error'
//   4. Auto-match against sampleUrls (check if any sample URL path starts with node path)
//   5. Set included = true for visited/auto-matched nodes
//   6. Return UnifiedTreeNode[]

// REMOVED: mergeBfsTreeUpdate, mergeBfsPageVisit, bfsTreeToUnifiedTree, findNodeByUrl
// KEPT: toggleNodeIncluded, flattenUnifiedTree, setSubtreeIncluded, autoMatchNodes
// Note: autoMatchNodes is KEPT as an export (used by non-BFS code paths) but
// removed from UnifiedDiscoveryPanel.tsx imports (auto-matching is now done
// inside treeSnapshotToUnifiedTree). simpleHash and generateNodeId are KEPT
// for non-BFS callers (navNodesToTree, mergeSitemapGroups, mergeExploreResult).
// Only treeSnapshotToUnifiedTree uses URL directly as node ID.
```

#### unified-tree-types.ts

```typescript
// NO CHANGES — simpleHash and generateNodeId are KEPT for non-BFS callers.
// Only treeSnapshotToUnifiedTree (in tree-merge.ts) uses URL as node ID.
// This avoids breaking navNodesToTree, mergeSitemapGroups, mergeExploreResult.
```

#### UnifiedTreeHeader.tsx

```typescript
// MODIFIED — mode-aware stats rendering
// Live mode: show "{totalUrls} discovered · {visitedCount} visited · {sampleUrls.length} targets"
// Select mode: show existing explored/auto-matched/unexplored stats + sections/pages
// Live mode: hide Select All / Deselect All buttons (already done)
// Live mode: hide Sample URLs context bar (irrelevant during live)
// Live mode: hide "sections · pages" count (irrelevant during live)
```

### Subtasks (execution order)

1. **ST-4.1**: Update SSE types in `api/discovery.ts`
   - Add `BfsTreeSnapshotEvent`, `BfsProgressCounterEvent`
   - Add `tree` field to `BfsCompleteEvent`
   - Update `BfsSSEEvent` union — remove old types, add new types
   - Remove `BfsTreeUpdateEvent`, `BfsUrlDiscoveredEvent` from union
   - Keep `BfsPageVisitEvent` type definition (for backward compat) but remove from `BfsSSEEvent` union

2. **ST-4.2**: Update `useDiscovery.ts`
   - Update `UseDiscoveryOptions`: replace `onTreeUpdate`/`onPageVisit` with `onTreeSnapshot`/`onProgress`
   - Update `SSE_EVENT_TYPES` array
   - Update `handleParsedEvent` switch:
     - `case 'tree-snapshot'`: update progress counters + call `onTreeSnapshot`
     - `case 'progress'`: update progress counters + call `onProgress`
     - `case 'complete'`: add `tree` handling, call `onComplete`
     - Remove: `case 'tree-update'`, `case 'page-visit'`, `case 'url-discovered'`

3. **ST-4.3**: Add `treeSnapshotToUnifiedTree` to `tree-merge.ts`
   - Recursive converter: backend `TreeNode[]` → `UnifiedTreeNode[]`
   - Node ID = URL (not simpleHash)
   - Auto-match logic inline (compare pathname prefixes against sampleUrls)
   - Status mapping: backend `visited`→`explored`, `visiting`→`exploring`, `discovered`→`unexplored`, `error`→`error`
   - Set `source: 'bfs-discovered'` on all converted nodes
   - Remove dead functions: `mergeBfsTreeUpdate`, `mergeBfsPageVisit`, `bfsTreeToUnifiedTree`, `findNodeByUrl`
   - Keep: `autoMatchNodes` (used by non-BFS paths), `simpleHash`/`generateNodeId` (used by non-BFS paths)

4. **ST-4.4**: Verify `bfsTreeToUnifiedTree` has no remaining callers
   - `grep -r bfsTreeToUnifiedTree` should return zero results outside tree-merge.ts
   - `simpleHash` and `generateNodeId` are KEPT (non-BFS callers exist)

5. **ST-4.5**: Update `UnifiedDiscoveryPanel.tsx`
   - Replace `onTreeUpdate` handler with `onTreeSnapshot`:
     ```typescript
     onTreeSnapshot: (event) => {
       const unified = treeSnapshotToUnifiedTree(event.tree, sampleUrls);
       onTreeChange(unified);
     },
     ```
   - Add `onProgress` handler (optional — for live stats if needed beyond what tree-snapshot provides)
   - Remove: `treeRef` stale-closure pattern (no longer needed — snapshot replaces entire tree)
   - Remove: `mergeBfsTreeUpdate`, `mergeBfsPageVisit`, `autoMatchNodes` imports
   - Pass `onComplete` to handle final tree:
     ```typescript
     onComplete: (event) => {
       if (event.tree) {
         const unified = treeSnapshotToUnifiedTree(event.tree, sampleUrls);
         onTreeChange(unified);
       }
       addActivity('milestone', 'discovery_complete_summary', {...});
     },
     ```

6. **ST-4.6**: Mode-aware UnifiedTreeHeader
   - Live mode stats: `"{totalUrls} discovered · {visitedCount} visited"`
   - Select mode stats: existing explored/auto-matched/unexplored + sections/pages
   - Live mode: hide sample URLs bar, hide "sections · pages" count
   - Already correct: Select All / Deselect All hidden in live mode (line 93)

### Acceptance Criteria

- AC-4.1: `tree-snapshot` event replaces entire tree in UI — no incremental merge
  - Verify: set breakpoint in `onTreeSnapshot`, confirm tree is replaced not merged
- AC-4.2: Tree shows proper hierarchy (nested, not flat) during live BFS
  - Verify: manual test with real site — tree should show nested paths
- AC-4.3: BFS tree nodes use URL as ID (non-BFS paths still use simpleHash — this is correct)
  - Verify: `treeSnapshotToUnifiedTree` sets `id = url` not `id = generateNodeId(url)`
- AC-4.4: No `structuredClone` in BFS tree update path (treeSnapshotToUnifiedTree)
  - Verify: `treeSnapshotToUnifiedTree` does not call `structuredClone`
  - Note: `structuredClone` in `mergeSitemapGroups` (non-BFS) is kept — this is correct
- AC-4.5: Live mode header shows discovery-relevant stats (not selection stats)
  - Verify: screenshot during live BFS
- AC-4.6: Build passes — `pnpm build --filter=@agent-platform/studio`
  - Verify: clean build

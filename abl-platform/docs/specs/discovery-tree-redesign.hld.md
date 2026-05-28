# Discovery Tree Redesign — High-Level Design

## What

Redesign the BFS discovery tree from an incremental SSE-built UI artifact into a **backend-owned persistent address book**. The tree represents the hierarchical structure of a website — each path (e.g., `Support > Printers > All-In-Ones > ET-2850`) is a stable address that can be used to navigate to and recrawl a specific page. The backend builds the tree from the complete URL map on phase transitions, sends periodic snapshots to the frontend, and persists the canonical tree in MongoDB (`SiteDiscovery.treeHierarchy`).

### Why

The current implementation has fundamental architectural bugs:

1. **Flat tree** — `findClosestAncestor` computes parentUrl incrementally on partial data with origin mismatch (www vs non-www), producing flat trees
2. **Lost nodes** — server.ts double-throttle silently drops `tree-update` events with newNodes
3. **O(n²) performance** — `findClosestAncestor` does linear scan of all URLs per new URL; `structuredClone` of entire tree every 300ms on frontend
4. **Redundant computation** — tree built on both backend AND frontend, producing different results
5. **No persistence path** — `result` SSE event (the only way tree reaches MongoDB) has no frontend listener; tree survives only if search-ai proxy intercepts it

## Architecture Approach

### Packages Changed

| Package                   | Changes                                                                                                                                                       | Scope                   |
| ------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------- |
| `apps/crawler-mcp-server` | Fix `buildTree()`, `findClosestAncestor()`, `normalizeUrl()`. New SSE event model (`tree-snapshot` + `progress`). Remove incremental `parentUrl` computation. | Backend tree engine     |
| `apps/search-ai`          | Update SSE proxy to forward new event types. Persist tree snapshots incrementally.                                                                            | SSE proxy + persistence |
| `apps/studio`             | Replace incremental tree merge with snapshot receiver. Mode-aware UX. Remove dead code.                                                                       | Frontend rendering      |
| `packages/database`       | Enrich `ITreeNode` with `visited`, `renderMethod`, `pageRole`, `status` fields.                                                                               | Schema                  |

### Data Flow

```
BACKEND (crawler-mcp-server / bfs-discovery.ts)
  ┌─────────────────────────────────────────────────┐
  │  allUrls: Map<string, DiscoveredPage>           │  ← flat map, grows during BFS
  │                                                  │
  │  buildTree(allUrls, primaryUrl)                  │  ← called on phase transitions
  │    1. Sort URLs by path depth (shallowest first) │     + every 5s timer
  │    2. For each URL:                              │
  │       - pathMap.get(parentPath) → O(1) lookup    │
  │       - Attach as child of closest ancestor      │
  │       - Fallback: attach to root (never null)    │
  │    3. Enrich nodes: visited, renderMethod, etc.  │
  │                                                  │
  │  treeHierarchy: TreeNode[]  ← rebuilt result     │
  │                                                  │
  │  SSE events:                                     │
  │    progress  → {totalUrls, totalVisited}  300ms  │
  │    tree-snapshot → {tree: TreeNode[]}  on phase  │
  │                    transitions + every 5s        │
  │    phase     → {phase, label}                    │
  │    activity  → {message, level}                  │
  │    complete  → {stats, tree: TreeNode[]}         │
  └──────────────────┬──────────────────────────────┘
                     │ SSE stream
                     ▼
PROXY (search-ai / discovery.ts route)
  ┌─────────────────────────────────────────────────┐
  │  Forwards all events to Studio                   │
  │  On tree-snapshot: persist to SiteDiscovery      │
  │    (incremental — not just at end)               │
  │  On complete: final persist + status update      │
  └──────────────────┬──────────────────────────────┘
                     │ SSE stream
                     ▼
FRONTEND (studio)
  ┌─────────────────────────────────────────────────┐
  │  useDiscovery hook:                              │
  │    tree-snapshot → replace tree state            │
  │    progress     → update counters                │
  │    complete     → set mode='select'              │
  │                                                  │
  │  UnifiedTree:                                    │
  │    Renders tree with @tanstack/react-virtual     │
  │    Mode-aware header/footer (live vs select)     │
  │    Node ID = normalized URL (no hash collision)  │
  │                                                  │
  │  NO tree construction logic                      │
  └─────────────────────────────────────────────────┘
```

### SSE Event Model (Simplified)

| Event           | Data                        | When                         | Purpose            |
| --------------- | --------------------------- | ---------------------------- | ------------------ |
| `phase`         | `{phase, label}`            | Phase start                  | Status indicator   |
| `progress`      | `{totalUrls, totalVisited}` | Throttled 300ms              | Live counters      |
| `tree-snapshot` | `{tree: TreeNode[]}`        | Phase transitions + every 5s | Complete tree      |
| `activity`      | `{message, level}`          | As needed                    | Activity log       |
| `complete`      | `{stats, tree: TreeNode[]}` | End                          | Final tree + stats |

**Removed events**: `tree-update` (with incremental newNodes), `page-visit`, `url-discovered`, `result` (megabyte serialization)

### ITreeNode Enhancement

```typescript
interface ITreeNode {
  url: string; // the address
  label: string; // display name
  children: ITreeNode[]; // sub-addresses
  depth: number; // tree depth
  visited: boolean; // was this page crawled?
  renderMethod: 'http' | 'browser' | 'unknown'; // how to reach it
  pageRole?: 'hub' | 'leaf' | 'mixed'; // what kind of page
  status: 'discovered' | 'visited' | 'error'; // current state
}
```

### Key Integration Points

1. **search-ai SSE proxy** (`discovery.ts` routes): Must forward `tree-snapshot` and `progress` events; must handle removal of `tree-update`/`page-visit`/`url-discovered`. Persist `treeHierarchy` on each `tree-snapshot` (not just at end).
2. **Frontend type alignment**: `BfsSSEEvent` union in `api/discovery.ts` must match new event types. `DiscoveryTreeResponse` type mismatch with server response needs fixing.
3. **SiteDiscovery model**: Schema change for enriched `ITreeNode` — additive (no migration needed, existing docs get defaults).

## Decisions & Tradeoffs

- **Decision 1**: Backend owns tree construction → chose over frontend-builds-tree because tree must be persisted as a stable address book. Frontend-built trees would diverge between sessions.

- **Decision 2**: Periodic `tree-snapshot` (complete tree) → chose over incremental `tree-update` (newNodes + parentUrl) because:
  - Ancestors discovered in later phases (Phase 2 breadcrumb climb) naturally reparent earlier nodes
  - No stale-closure bugs on frontend (B-3)
  - No structuredClone/findNodeByUrl overhead (P-1, P-2)
  - SSE reconnect gets full tree automatically (no permanent holes from A-3)
  - Tradeoff: ~50-100KB per snapshot at 50k URLs with label+url+depth — acceptable at 5s intervals

- **Decision 3**: `findClosestAncestor` uses pathname-only `Map<path, url>` → chose over full-origin comparison because `normalizeUrl` and `extractDomain` treat www differently. Pathname comparison is origin-agnostic and O(1) per lookup.

- **Decision 4**: Fallback to root URL (not null) when no ancestor found → matches spec pseudocode. Prevents orphan roots that disconnect the tree.

- **Decision 5**: Persist tree on every `tree-snapshot` (not just at end) → protects against stream drops. If SSE disconnects before `complete`, the last snapshot is still in MongoDB.

- **Decision 6**: Use normalized URL as node ID (not `simpleHash`) → eliminates 29% collision risk at 50k URLs (B-4). URL is already unique.

## Task Decomposition

| Task | Package(s)                | Independent?   | Est. Files | Description                                                                                                                                                                                                       |
| ---- | ------------------------- | -------------- | ---------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| T-1  | `apps/crawler-mcp-server` | Yes            | 3-4        | Fix `buildTree()` algorithm: pathname Map for O(1), root fallback, enrich nodes. Fix `normalizeUrl` www. New `tree-snapshot` + `progress` events. Remove incremental parentUrl.                                   |
| T-2  | `packages/database`       | Yes            | 1          | Enrich `ITreeNode` schema with visited, renderMethod, pageRole, status fields.                                                                                                                                    |
| T-3  | `apps/search-ai`          | After T-1, T-2 | 1-2        | Update SSE proxy to forward new event types. Persist tree on each `tree-snapshot`. Remove old event handling.                                                                                                     |
| T-4  | `apps/studio`             | After T-1, T-2 | 5-6        | Replace incremental merge with snapshot receiver. Mode-aware header/footer. Remove dead code (`mergeBfsTreeUpdate`, `mergeBfsPageVisit`, `bfsTreeToUnifiedTree`, `autoMatchNodes` per-event). Use URL as node ID. |

## Out of Scope

- **Recrawl by tree address** — future feature. We persist the tree as an address book now; the "navigate tree → recrawl single page" workflow is a separate feature.
- **Subdomain handling** — `isSameDomain` correctly excludes subdomains. Supporting `support.epson.com` as part of `epson.com` is a separate discovery scope feature.
- **Virtual/intermediate nodes** — if `/a/b/c` exists but `/a/b` doesn't, `/a/b/c` attaches to `/a` (or root). Synthesizing placeholder nodes for `/a/b` is deferred.
- **Phase 3 BFS ordering** (A-1) — the queue append vs re-sort issue. Fixing this changes discovery behavior, not tree construction. Separate ticket.
- **`selectedUrls` → crawl job wiring** — the bridge from discovery selection to crawl execution is not wired. Separate feature.

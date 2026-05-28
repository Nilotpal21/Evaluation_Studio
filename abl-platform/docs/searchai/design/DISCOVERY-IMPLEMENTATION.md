# Discovery Phase — Implementation Plan

**Scope document:** `docs/searchai/design/DISCOVERY-ALGORITHM.md`
**This document:** Critical path, build order, what to keep/delete/create, learnings from old code.

---

## Approach

Build the critical pieces and full wiring first. Get the skeleton working end-to-end,
then fill in. Delete old code and tests that are no longer needed. Write fresh tests
only for the critical pieces.

Three builds:

| Build                        | What                                                                | HLD/LLD?  | Test?                            |
| ---------------------------- | ------------------------------------------------------------------- | --------- | -------------------------------- |
| **Build 1: Engine + Wiring** | BFS engine, storage models, API routes, SSE progress                | HLD + LLD | Integration tests for BFS engine |
| **Build 2: UI End-to-End**   | Mode selection, seed selection, live tree, selection, crawl handoff | LLD only  | Manual test one full flow        |
| **Build 3: Polish + Extras** | Direct URLs mode, patterns, recrawl/rediscover, cleanup             | No        | As needed                        |

---

## Build 1: Engine + Wiring (HLD + LLD required)

The foundation — everything else depends on it.

### Create

| File                                                   | Purpose                                   |
| ------------------------------------------------------ | ----------------------------------------- |
| `apps/crawler-mcp-server/src/explore/bfs-discovery.ts` | Core BFS engine — Phase 0→1a→1b→2→3→4     |
| `apps/search-ai/src/models/site-discovery.model.ts`    | Generic storage (per domain, no tenantId) |
| `apps/search-ai/src/models/tenant-discovery.model.ts`  | Tenant-specific selections + config       |
| `apps/search-ai/src/routes/discovery.ts`               | New API routes for discovery lifecycle    |

### Modify

No existing files are modified in Build 1.

> **Note:** `depth-prober.ts` is NOT modified in Build 1 (per HLD decision D-6).
> The BFS engine is a separate module that coexists with depth-prober.

> **Note:** `progress.ts` is NOT modified in Build 1. BFS uses a separate SSE
> transport: crawler-mcp-server streams SSE → search-ai proxies to client. This
> avoids coupling BFS events to the existing WebSocket/Redis pub-sub progress
> infrastructure. Build 2 decides the frontend transport: either consume the SSE
> stream directly (via `@microsoft/fetch-event-source` for auth header support)
> or publish BFS events through progress.ts for WebSocket delivery.

### API Routes

```
POST /discovery/start         — start BFS from seeds (nav sections + target URLs)
POST /discovery/discover-more  — expand a specific node (user-driven Phase 4)
POST /discovery/stop           — stop running discovery, keep partial results
GET  /discovery/:id/stream     — SSE live progress (tree updates + activity log)
GET  /discovery/:id/tree       — get current tree state
POST /discovery/:id/select     — save tenant's URL selections
GET  /discovery/domain/:domain — get generic discovery data for a domain (if exists)
```

### Storage Schema

```typescript
// Generic layer — per domain, shared across tenants
interface SiteDiscovery {
  domain: string; // normalized domain (e.g., "epson.com")
  navStructure: NavNode[]; // extracted nav menu
  discoveredUrls: Map<string, DiscoveredPage>; // all URLs found
  treeHierarchy: TreeNode[]; // URL-path tree
  siteProfile: SiteProfile; // platform, JS required, estimated size
  sitemapUrls?: string[]; // if sitemap found
  createdAt: Date;
  updatedAt: Date;
}

// Tenant layer — per tenant + domain + source
interface TenantDiscovery {
  tenantId: string;
  domain: string;
  sourceId?: string;
  exploredBranches: string[]; // URLs this tenant explored via "Discover More"
  selectedUrls: string[]; // URLs selected for crawling
  selectionPatterns: string[]; // quick-select patterns applied
  seedsUsed: string[]; // nav sections + target URLs used as seeds
  createdAt: Date;
  updatedAt: Date;
}
```

### BFS Engine Design

The engine reuses existing modules where possible:

```
bfs-discovery.ts (NEW — orchestrator)
  ├── nav-extractor.ts          (KEEP — Phase 0)
  ├── breadcrumb-extractor.ts   (KEEP — Phase 2 climb, 5 strategies)
  ├── navigation-explorer.ts    (KEEP — page visit + link extraction)
  ├── page-classifier.ts        (KEEP — HTTP/browser classification)
  ├── yield-tracker.ts          (KEEP — diminishing returns for Phase 3)
  ├── api-interceptor.ts        (KEEP — API discovery during visits)
  ├── command-queue.ts          (KEEP — user interventions)
  └── url-normalizer.ts         (NEW — single normalize function used everywhere)
```

---

## Build 2: UI End-to-End (LLD only)

Wire the frontend to Build 1's APIs.

### Create

| File                                                                     | Purpose                                            |
| ------------------------------------------------------------------------ | -------------------------------------------------- |
| `apps/studio/src/components/search-ai/crawl-flow/ModeSelection.tsx`      | Three mode cards (Sitemap, Discovery, Direct URLs) |
| `apps/studio/src/components/search-ai/crawl-flow/SeedSelection.tsx`      | Nav checkboxes + target URL inputs                 |
| `apps/studio/src/components/search-ai/crawl-flow/LiveDiscoveryTree.tsx`  | Real-time tree during BFS + activity log           |
| `apps/studio/src/components/search-ai/crawl-flow/DiscoverySelection.tsx` | Tree with checkboxes + patterns for URL selection  |
| `apps/studio/src/hooks/useDiscovery.ts`                                  | Discovery API + SSE hook                           |
| `apps/studio/src/api/discovery.ts`                                       | API client functions                               |

### Modify

| File              | Changes                                    |
| ----------------- | ------------------------------------------ |
| `CrawlFlowV5.tsx` | New state machine with mode selection step |
| `types.ts`        | New types for discovery data model         |

### Delete (after Build 2 replaces them)

| File                                     | Reason                                        |
| ---------------------------------------- | --------------------------------------------- |
| `ExplorePanel.tsx` (1,222 lines)         | Replaced by LiveDiscoveryTree + SeedSelection |
| `DiscoveryPanel.tsx` (1,018 lines)       | Replaced by LiveDiscoveryTree                 |
| `BrowserDiscoveryInline.tsx` (587 lines) | Replaced by useDiscovery hook                 |
| `DiscoveryTree.tsx` (812 lines)          | Replaced by DiscoverySelection                |
| `UnifiedDiscoveryPanel.tsx` (456 lines)  | Replaced by LiveDiscoveryTree                 |
| `discovery/tree-utils.ts` (552 lines)    | Old DiscoveryTreeNode utilities — replaced    |
| Old tests for all above                  | No longer relevant                            |

### Keep & Modify

| File                               | What changes                                                    |
| ---------------------------------- | --------------------------------------------------------------- |
| `discovery/unified-tree-types.ts`  | Add new fields: `visited`, `foundOn`, `renderMethod`            |
| `discovery/tree-merge.ts`          | Adapt for new data model (remove auto-matched, add BFS sources) |
| `discovery/tree-to-sections.ts`    | Adapt for new tree → crawl handoff                              |
| `discovery/UnifiedTreeNodeRow.tsx` | Add checkbox, status badges for new statuses                    |
| `discovery/UnifiedTree.tsx`        | Wire to new selection features                                  |
| `discovery/UnifiedTreeHeader.tsx`  | Add filter, search, bulk select actions                         |

---

## Build 3: Polish + Extras (no HLD/LLD)

| Feature               | Description                                     |
| --------------------- | ----------------------------------------------- |
| Direct URLs mode      | Paste textarea + "Add from Sitemap" expansion   |
| Quick-select patterns | System-detected URL patterns with checkboxes    |
| Custom glob filter    | User types pattern, matches highlight           |
| Recrawl               | Reuse selected URLs from tenant's source config |
| Rediscover            | Re-run BFS, update generic layer                |
| Fresh E2E tests       | Complete flow tests                             |
| Old code cleanup      | Remove any remaining unused code                |

---

## Learnings from Old Code (carry forward)

### Critical Patterns to Reuse

| Pattern                                     | Source                     | Why it matters                                     |
| ------------------------------------------- | -------------------------- | -------------------------------------------------- |
| SSE throttle at 300ms                       | crawl-discover.ts          | Prevents flooding clients                          |
| `res.flush()` after SSE write               | crawl-discover.ts          | Required for compression middleware                |
| `X-Accel-Buffering: no` header              | crawl-discover.ts          | Disables nginx proxy buffering                     |
| SSE reconnect with exponential backoff      | BrowserDiscoveryInline.tsx | MAX_RETRIES=3, delay=min(1000\*2^n, 8000)          |
| Terminal event flag for SSE                 | BrowserDiscoveryInline.tsx | Prevents reconnect after `complete`                |
| Ref-based callbacks for SSE handlers        | BrowserDiscoveryInline.tsx | Prevents stale closures                            |
| String-based `page.evaluate()`              | navigation-explorer.ts     | tsx `__name` injection breaks function args        |
| `finally` + `.catch()` for browser sessions | depth-prober.ts            | Session close failures must never crash            |
| MutationObserver with settle timer          | navigation-explorer.ts     | DOM_SETTLE=600ms, TIMEOUT=2000ms                   |
| Mouse move to (0,0) after mega-menu hover   | nav-extractor.ts           | Close dropdown before next extraction              |
| Case-insensitive label matching             | nav-extractor.ts           | Breadcrumb/nav merge dedup                         |
| Pattern divergence bridge pages             | discover-crawler.ts        | Cross-prefix navigation when base≠content URL      |
| Peak-relative yield threshold               | yield-tracker.ts           | 5% of peak, floor of 1, 3 consecutive low          |
| Adaptive sample count (log2)                | yield-tracker.ts           | Scales with hub link count, caps at 8              |
| Progressive navigation retry                | navigation-explorer.ts     | networkidle→domcontentloaded→commit                |
| Cookie/overlay dismissal selectors          | navigation-explorer.ts     | 10 CSS selectors for banners                       |
| Auth header redaction in interceptor        | api-interceptor.ts         | `authorization` + `x-api-key` → [REDACTED]         |
| Incremental prefix tracking                 | DiscoveryPanel.tsx         | O(k) per event vs O(n) full tree walk              |
| Auto-save every 30s                         | DiscoveryPanel.tsx         | Persist discovery state during exploration         |
| Draft bucket persistence                    | CrawlFlowV5.tsx            | Section URLs in separate docs (MongoDB size limit) |
| Exclude patterns for section selection      | CrawlFlowV5.tsx            | /login, /cart, /api/, /search, etc.                |

### Critical Gotchas

| Gotcha                                        | Impact                                                            | Mitigation                                                                         |
| --------------------------------------------- | ----------------------------------------------------------------- | ---------------------------------------------------------------------------------- |
| SSE EventSource cannot send Auth headers      | Tenant isolation on SSE needs query params or cookies             | Use `?token=` or session cookie                                                    |
| tsx `__name()` injection in `page.evaluate()` | Browser crashes — `__name` doesn't exist in browser               | Always use string-based evaluation                                                 |
| `res.flush()` missing on SSE                  | Events buffer until compression frame fills                       | Call `flush()` after every SSE write                                               |
| `normalizeUrl()` must be consistent           | Different normalization = duplicate URLs in tree                  | Use ONE normalization function everywhere                                          |
| `structuredClone()` needs Node 17+            | Fails on older runtimes                                           | Verify Node version or use JSON parse/stringify                                    |
| Route handler "already handled" errors        | Another handler or navigation handled the route                   | Silently catch in API interceptor                                                  |
| `page.unroute()` on closed page               | Throws — page may already be navigated away                       | Wrap in `.catch()`                                                                 |
| Sitemap page extraction leaves page navigated | Must navigate back to original page after                         | Handle navigation-back failure gracefully                                          |
| URL path truncation 404s on `/sh/s1` suffixes | Epson uses non-standard path segments — truncation hits dead ends | Always follow redirects during truncation; the real hub may be the redirect target |
| Heading-grouped nav (`<div>/<h3>/<a>`)        | Current DOM walker only handles `<ul>/<li>` nesting               | Extend nav-extractor to detect heading-grouped patterns (Build 1 scope)            |

### Constants Master List (tuned values from production)

```typescript
// SSE & Progress
const BROADCAST_INTERVAL_MS = 300;
const MAX_SSE_RETRIES = 3;
const MAX_CONSOLE_ENTRIES = 200;
const AUTO_SAVE_INTERVAL_MS = 30_000;

// Crawl limits
const MAX_CRAWLS = 50;
const CRAWL_TTL_MS = 30 * 60 * 1000;
const MAX_CONCURRENT_PER_TENANT = 5;
const MAX_ALL_LINKS = 50_000;
const MAX_EXPLORE_ALL_URLS = 20;

// Page navigation
const PAGE_NAV_TIMEOUT = 15_000;
const DOM_SETTLE_MS = 600;
const MUTATION_TIMEOUT_MS = 2_000;
const MEGA_MENU_HOVER_TIMEOUT = 1_500;

// Nav extraction
const MAX_LINKS_PER_REGION = 200;
const MAX_BREADCRUMB_MERGE_NODES = 500;
const MAX_LABEL_LENGTH = 100;
const MAX_MEGA_MENU_ITEMS = 15;

// Yield tracking
const PEAK_YIELD_THRESHOLD = 0.05;
const CONSECUTIVE_LOW_YIELD_LIMIT = 3;
const MIN_PAGES_BEFORE_YIELD_CHECK = 3;
const ABSOLUTE_LOW_YIELD = 1;

// Classification
const MIN_HUB_LINKS = 5;
const HUB_PREFIX_RATIO = 0.4;
const LEAF_PROSE_RATIO = 0.4;

// API interception
const MAX_INTERCEPTED_CALLS = 500;
const MAX_API_PATTERNS = 100;

// UI
const AUTO_COLLAPSE_THRESHOLD = 30;
const AUTO_ADD_MIN_URLS = 5;
const AUTO_ADD_MIN_VERIFIED = 2;

// Pattern scoring
const CRAWL_THRESHOLD = 30;

// Section selection excludes
const EXCLUDE_PATTERNS = [
  '/login',
  '/signin',
  '/signup',
  '/register',
  '/cart',
  '/checkout',
  '/account',
  '/api/',
  '/graphql',
  '/search',
  '/404',
  '/500',
];
```

---

## What Exists vs What's New

```
KEEP (reuse directly):
  nav-extractor.ts          — Phase 0 nav extraction
  breadcrumb-extractor.ts   — 5-strategy breadcrumb extraction
  page-classifier.ts        — hub/leaf classification
  yield-tracker.ts          — diminishing returns detection
  navigation-explorer.ts    — Playwright page visit + link extraction
  api-interceptor.ts        — passive XHR/Fetch interception
  command-queue.ts          — user intervention queue

KEEP + MODIFY:
  depth-prober.ts           — wire BFS engine as alternative
  progress.ts               — new SSE event types
  unified-tree-types.ts     — new fields for BFS model
  tree-merge.ts             — adapt for new data model
  tree-to-sections.ts       — adapt for tree → crawl handoff
  UnifiedTreeNodeRow.tsx    — checkbox, new status badges
  UnifiedTree.tsx           — wire selection features
  UnifiedTreeHeader.tsx     — filter, search, bulk actions
  CrawlFlowV5.tsx           — new state machine with mode selection
  types.ts                  — new types

BUILD NEW:
  bfs-discovery.ts          — core BFS engine
  site-discovery.model.ts   — generic storage
  tenant-discovery.model.ts — tenant selections
  discovery.ts (routes)     — API endpoints
  ModeSelection.tsx         — three mode cards
  SeedSelection.tsx         — nav + URL inputs
  LiveDiscoveryTree.tsx     — real-time BFS tree + log
  DiscoverySelection.tsx    — tree with selection
  useDiscovery.ts           — hook for API + SSE
  discovery.ts (api client) — frontend API functions

DELETE (after Build 2):
  discover-crawler.ts       — replaced by bfs-discovery.ts
  crawl-discover.ts         — replaced by discovery.ts routes
  ExplorePanel.tsx          — replaced by SeedSelection + LiveDiscoveryTree
  DiscoveryPanel.tsx        — replaced by LiveDiscoveryTree
  BrowserDiscoveryInline.tsx — replaced by useDiscovery hook
  DiscoveryTree.tsx         — replaced by DiscoverySelection
  UnifiedDiscoveryPanel.tsx — replaced by LiveDiscoveryTree
  tree-utils.ts             — old DiscoveryTreeNode utils
  + all tests for deleted files
```

---

## Dependency Order

```
Build 1 (backend):
  1. Storage models (site-discovery, tenant-discovery)
  2. BFS engine (bfs-discovery.ts) — uses existing modules
  3. API routes (discovery.ts) — uses engine + storage
  4. SSE progress wiring — uses existing progress infrastructure

Build 2 (frontend):
  1. API client (discovery.ts) + types
  2. useDiscovery hook (SSE + API)
  3. ModeSelection → SeedSelection → LiveDiscoveryTree → DiscoverySelection
  4. Wire into CrawlFlowV5 state machine
  5. Delete old components

Build 3 (polish):
  1. Direct URLs mode
  2. Quick-select patterns
  3. Recrawl/Rediscover
  4. E2E tests
```

# Discovery Build 1 — Low-Level Design

## Overview

This LLD covers the 6 implementation tasks for Discovery Build 1 (Engine + Wiring).
Each task specifies exact files, interfaces, pseudocode, and acceptance criteria.

**Upstream documents:**

- HLD: `docs/specs/discovery-build1.hld.md`
- Algorithm spec: `docs/searchai/design/DISCOVERY-ALGORITHM.md`
- Implementation plan: `docs/searchai/design/DISCOVERY-IMPLEMENTATION.md`

---

## Task T-0: Delete Old Discovery Code

### Files to Delete

| File                                                       | Reason                                                      |
| ---------------------------------------------------------- | ----------------------------------------------------------- |
| `apps/search-ai/src/routes/crawl-discover.ts`              | Old discovery routes with in-memory state — replaced by T-4 |
| `apps/search-ai/src/routes/crawl-browser-discover.ts`      | SSE proxy with in-memory state — replaced by T-4            |
| `apps/search-ai/src/services/crawler/discover-crawler.ts`  | HTTP recursive crawl service — replaced by T-2              |
| `apps/search-ai/src/services/crawler/priority-frontier.ts` | Priority URL queue — BFS engine has its own traversal       |

**Note:** No files to delete in `apps/crawler-mcp-server/` — the HLD originally listed
`src/explore/discover-crawler.ts` but that file does not exist. The `depth-prober.ts`
module is kept as-is.

### Files to Modify

| File                                      | What Changes                                                                          |
| ----------------------------------------- | ------------------------------------------------------------------------------------- |
| `apps/search-ai/src/server.ts` (line 34)  | Remove `import crawlDiscoverRouter from './routes/crawl-discover.js';`                |
| `apps/search-ai/src/server.ts` (line 38)  | Remove `import crawlBrowserDiscoverRouter from './routes/crawl-browser-discover.js';` |
| `apps/search-ai/src/server.ts` (line 255) | Remove `app.use('/api/crawl', crawlDiscoverRouter);`                                  |
| `apps/search-ai/src/server.ts` (line 256) | Remove `app.use('/api/crawl', crawlBrowserDiscoverRouter);`                           |

### Subtasks (execution order)

1. **ST-0.1**: Verify no other files import from the 4 files being deleted. Run `rg 'crawl-discover|crawl-browser-discover|discover-crawler|priority-frontier' apps/search-ai/src --type ts` and review each hit.
2. **ST-0.2**: Delete the 4 files.
3. **ST-0.3**: Remove imports and `app.use()` lines from `apps/search-ai/src/server.ts`.
4. **ST-0.4**: Run `pnpm build --filter=search-ai` to confirm no broken imports remain.

### Acceptance Criteria

- AC-1: Given the 4 files are deleted, When `pnpm build --filter=search-ai` runs, Then it completes with zero errors.
  - Verify: `pnpm build --filter=search-ai`
  - Expected: Exit code 0
- AC-2: Given server.ts is modified, When grepping for old imports, Then zero matches.
  - Verify: `rg 'crawl-discover|crawl-browser-discover' apps/search-ai/src/server.ts`
  - Expected: No output
- AC-3: Given the old routes are removed, When `GET /api/crawl/discover/...` or `POST /api/crawl/browser-discover/...` are called, Then they return 404 (no route matched).

---

## Task T-1: Storage Models

### Files to Create

| File                                                     | Purpose                         |
| -------------------------------------------------------- | ------------------------------- |
| `packages/database/src/models/site-discovery.model.ts`   | Generic storage per domain      |
| `packages/database/src/models/tenant-discovery.model.ts` | Per-tenant discovery selections |

### Files to Modify

| File                                    | What Changes                            |
| --------------------------------------- | --------------------------------------- |
| `packages/database/src/models/index.ts` | Add barrel exports for both new models  |
| `apps/search-ai/src/db/index.ts`        | Register both models with ModelRegistry |

### SiteDiscovery Model

No `tenantId` — this is generic per-domain data shared across tenants.
Stored in the `searchaicontent` database (operational crawl metadata).

```typescript
// packages/database/src/models/site-discovery.model.ts

import mongoose, { Schema, model } from 'mongoose';
import { uuidv7 } from '../mongo/base-document.js';

export interface IDiscoveredPage {
  url: string;
  foundOn: string[];
  renderMethod: 'http' | 'browser' | 'unknown';
  visited: boolean;
  status: 'discovered' | 'visiting' | 'visited' | 'error';
  childUrls: string[];
  title?: string;
  pageRole?: 'hub' | 'leaf' | 'mixed';
  errorMessage?: string;
  lastVisitedAt?: Date;
}

export interface ITreeNode {
  url: string;
  label: string;
  children: ITreeNode[];
  depth: number;
}

export interface ISiteProfile {
  platform?: string;
  jsRequired: boolean;
  estimatedPageCount?: number;
  sitemapFound: boolean;
  sitemapUrlCount?: number;
}

export interface ISiteDiscovery {
  _id: string;
  domain: string; // normalized domain, e.g. "epson.com"
  navStructure: Array<{
    label: string;
    href?: string;
    depth: number;
    children: unknown[]; // recursive NavNode shape — Schema.Types.Mixed in Mongoose
    source: string;
    estimatedChildren?: number;
  }>;
  discoveredUrls: IDiscoveredPage[];
  treeHierarchy: ITreeNode[];
  siteProfile: ISiteProfile;
  sitemapUrls: string[];
  breadcrumbChains: Array<{
    sourceUrl: string;
    crumbs: Array<{ text: string; href: string; depth: number }>;
    strategy: string;
  }>;
  lastDiscoveryAt: Date;
  totalPagesVisited: number;
  totalUrlsFound: number;
  createdAt: Date;
  updatedAt: Date;
}

const discoveredPageSchema = new Schema<IDiscoveredPage>(
  {
    url: { type: String, required: true },
    foundOn: [{ type: String }],
    renderMethod: {
      type: String,
      enum: ['http', 'browser', 'unknown'],
      default: 'unknown',
    },
    visited: { type: Boolean, default: false },
    status: {
      type: String,
      enum: ['discovered', 'visiting', 'visited', 'error'],
      default: 'discovered',
    },
    childUrls: [{ type: String }],
    title: String,
    pageRole: { type: String, enum: ['hub', 'leaf', 'mixed'] },
    errorMessage: String,
    lastVisitedAt: Date,
  },
  { _id: false },
);

const treeNodeSchema = new Schema(
  {
    url: { type: String, required: true },
    label: { type: String, required: true },
    children: [{ type: Schema.Types.Mixed }], // recursive
    depth: { type: Number, required: true },
  },
  { _id: false },
);

const siteProfileSchema = new Schema<ISiteProfile>(
  {
    platform: String,
    jsRequired: { type: Boolean, default: false },
    estimatedPageCount: Number,
    sitemapFound: { type: Boolean, default: false },
    sitemapUrlCount: Number,
  },
  { _id: false },
);

const breadcrumbChainSchema = new Schema(
  {
    sourceUrl: { type: String, required: true },
    crumbs: [
      {
        text: { type: String, required: true },
        href: { type: String, required: true },
        depth: { type: Number, required: true },
      },
    ],
    strategy: { type: String, required: true },
  },
  { _id: false },
);

export const siteDiscoverySchema = new Schema<ISiteDiscovery>(
  {
    _id: { type: String, default: uuidv7 },
    domain: { type: String, required: true },
    navStructure: [{ type: Schema.Types.Mixed }],
    discoveredUrls: [discoveredPageSchema],
    treeHierarchy: [treeNodeSchema],
    siteProfile: { type: siteProfileSchema, default: () => ({}) },
    sitemapUrls: [{ type: String }],
    breadcrumbChains: [breadcrumbChainSchema],
    lastDiscoveryAt: { type: Date, default: Date.now },
    totalPagesVisited: { type: Number, default: 0 },
    totalUrlsFound: { type: Number, default: 0 },
  },
  { timestamps: true },
);

// Indexes
siteDiscoverySchema.index({ domain: 1 }, { unique: true });
siteDiscoverySchema.index({ updatedAt: 1 });

// HMR guard (standard ESM pattern — matches crawl-job.model.ts)
export const SiteDiscovery =
  (mongoose.models.SiteDiscovery as mongoose.Model<ISiteDiscovery>) ||
  model<ISiteDiscovery>('SiteDiscovery', siteDiscoverySchema);
```

**Key decisions:**

- `discoveredUrls` is an **array** (not a Map) because MongoDB cannot store ES6 Maps.
  Lookups by URL use `Array.find()` or a `$elemMatch` query. The in-memory BFS engine
  uses a `Map<string, DiscoveredPage>` internally, then serializes to array for persistence.
- No `tenantId` field — domain is the unique key.
- `breadcrumbChains` stores per-source-URL crumb paths with strategy for debugging.
- `navStructure` uses `Schema.Types.Mixed` for recursive NavNode children.
- `_v` field not in schema (Mongoose auto-adds `__v`).

### TenantDiscovery Model

Per tenant + domain + source. Stored in `searchaicontent`.
Applies `tenantIsolationPlugin` for automatic tenant filtering.

```typescript
// packages/database/src/models/tenant-discovery.model.ts

import mongoose, { Schema, model } from 'mongoose';
import { uuidv7 } from '../mongo/base-document.js';
import { tenantIsolationPlugin } from '../mongo/plugins/tenant-isolation.plugin.js';

export interface ITenantDiscovery {
  _id: string;
  tenantId: string;
  domain: string;
  sourceId?: string; // optional crawl source reference
  discoveryId: string; // links back to a specific BFS run
  exploredBranches: string[]; // URLs explored via "Discover More"
  selectedUrls: string[]; // URLs selected for crawling
  selectionPatterns: string[]; // quick-select glob patterns applied
  seedsUsed: Array<{
    type: 'nav-section' | 'target-url';
    url: string;
    label?: string;
  }>;
  crawlConfig?: {
    maxDepth?: number;
    renderMethod?: 'http' | 'browser' | 'auto';
    excludePatterns?: string[];
    includePatterns?: string[];
  };
  status: 'active' | 'completed' | 'abandoned';
  createdAt: Date;
  updatedAt: Date;
}

export const tenantDiscoverySchema = new Schema<ITenantDiscovery>(
  {
    _id: { type: String, default: uuidv7 },
    tenantId: { type: String, required: true },
    domain: { type: String, required: true },
    sourceId: String,
    discoveryId: { type: String, required: true },
    exploredBranches: [{ type: String }],
    selectedUrls: [{ type: String }],
    selectionPatterns: [{ type: String }],
    seedsUsed: [
      {
        type: { type: String, enum: ['nav-section', 'target-url'], required: true },
        url: { type: String, required: true },
        label: String,
      },
    ],
    crawlConfig: {
      maxDepth: Number,
      renderMethod: { type: String, enum: ['http', 'browser', 'auto'] },
      excludePatterns: [String],
      includePatterns: [String],
    },
    status: {
      type: String,
      enum: ['active', 'completed', 'abandoned'],
      default: 'active',
    },
  },
  { timestamps: true },
);

// Indexes
tenantDiscoverySchema.index(
  { tenantId: 1, domain: 1, sourceId: 1 },
  { unique: true, sparse: true },
);
tenantDiscoverySchema.index({ tenantId: 1, status: 1 });
tenantDiscoverySchema.index({ discoveryId: 1 });

// Tenant isolation
tenantDiscoverySchema.plugin(tenantIsolationPlugin);

// HMR guard (standard ESM pattern — matches crawl-job.model.ts)
export const TenantDiscovery =
  (mongoose.models.TenantDiscovery as mongoose.Model<ITenantDiscovery>) ||
  model<ITenantDiscovery>('TenantDiscovery', tenantDiscoverySchema);
```

### Barrel Export

Add to `packages/database/src/models/index.ts`:

```typescript
export {
  SiteDiscovery,
  siteDiscoverySchema,
  type ISiteDiscovery,
  type IDiscoveredPage,
  type ITreeNode,
  type ISiteProfile,
} from './site-discovery.model.js';

export {
  TenantDiscovery,
  tenantDiscoverySchema,
  type ITenantDiscovery,
} from './tenant-discovery.model.js';
```

### ModelRegistry Registration

Add to `apps/search-ai/src/db/index.ts` in the `Promise.all([...])` block,
after the existing CrawlPattern registration:

```typescript
import('@agent-platform/database/models').then((mod) => {
  if ((mod as any).SiteDiscovery?.schema && !ModelRegistry.hasModel('SiteDiscovery')) {
    ModelRegistry.registerModelDefinition(
      'SiteDiscovery',
      (mod as any).SiteDiscovery.schema,
      'searchaicontent',
    );
  }
}),
import('@agent-platform/database/models').then((mod) => {
  if ((mod as any).TenantDiscovery?.schema && !ModelRegistry.hasModel('TenantDiscovery')) {
    ModelRegistry.registerModelDefinition(
      'TenantDiscovery',
      (mod as any).TenantDiscovery.schema,
      'searchaicontent',
    );
  }
}),
```

### Subtasks (execution order)

1. **ST-1.1**: Create `packages/database/src/models/site-discovery.model.ts` with schema above.
2. **ST-1.2**: Create `packages/database/src/models/tenant-discovery.model.ts` with schema above.
3. **ST-1.3**: Add barrel exports to `packages/database/src/models/index.ts`.
4. **ST-1.4**: Add ModelRegistry registrations to `apps/search-ai/src/db/index.ts`.
5. **ST-1.5**: Run `pnpm build --filter=@agent-platform/database` to verify.
6. **ST-1.6**: Run `pnpm build --filter=search-ai` to verify registrations compile.

### Acceptance Criteria

- AC-1: Given both models are created, When `pnpm build --filter=@agent-platform/database` runs, Then exit code 0.
- AC-2: Given barrel exports are added, When importing `{ SiteDiscovery, TenantDiscovery }` from `@agent-platform/database/models`, Then both resolve.
- AC-3: Given SiteDiscovery schema has `{ domain: 1 }` unique index, When two documents with the same domain are inserted, Then the second insert throws a duplicate key error.
- AC-4: Given TenantDiscovery has `tenantIsolationPlugin`, When a query runs with `tenantId` in context, Then results are automatically filtered by tenant.

---

## Task T-2: URL Normalizer + BFS Engine

This is the largest task. Two files: `url-normalizer.ts` (shared utility) and
`bfs-discovery.ts` (core orchestrator).

### Files to Create

| File                                                    | Purpose                            |
| ------------------------------------------------------- | ---------------------------------- |
| `apps/crawler-mcp-server/src/explore/url-normalizer.ts` | Single canonical URL normalization |
| `apps/crawler-mcp-server/src/explore/bfs-discovery.ts`  | Core BFS discovery engine          |

### T-2a: URL Normalizer

#### Location

`apps/crawler-mcp-server/src/explore/url-normalizer.ts`

#### Problem

Two incompatible `normalizeUrl` functions exist:

1. **`pattern-matcher.ts` (search-ai)**: Strips tracking params (`utm_*`, `fbclid`, `gclid`, `ref`), lowercases host, removes fragment and trailing slash. Returns `string | null`.
2. **`depth-prober.ts` (crawler-mcp-server)**: Sorts query params, removes fragment and trailing slash. Returns `string` (passthrough on error). Does NOT strip tracking params.

Deduplication breaks if normalization differs between the two.

#### Unified Function

```typescript
// apps/crawler-mcp-server/src/explore/url-normalizer.ts

/**
 * Tracking parameters to strip during normalization.
 * These add no semantic value and create false duplicates.
 */
const TRACKING_PARAMS = [
  'utm_source',
  'utm_medium',
  'utm_campaign',
  'utm_content',
  'utm_term',
  'ref',
  'fbclid',
  'gclid',
  'dclid',
  'msclkid',
  'twclid',
  'mc_cid',
  'mc_eid',
] as const;

/**
 * Normalize a URL for deduplication.
 *
 * Combines behaviors from both existing implementations:
 * - Strips tracking params (from pattern-matcher.ts)
 * - Sorts remaining params (from depth-prober.ts)
 * - Lowercases hostname
 * - Removes fragment
 * - Removes trailing slash (except root "/")
 * - Adds protocol if missing (defaults to https)
 *
 * Always returns a string (never null). On parse failure, returns
 * the input string unchanged.
 */
export function normalizeUrl(raw: string): string {
  try {
    const withProtocol = raw.startsWith('http') ? raw : `https://${raw}`;
    const url = new URL(withProtocol);

    // 1. Remove fragment
    url.hash = '';

    // 2. Lowercase hostname (URL constructor already does this, but be explicit)
    url.hostname = url.hostname.toLowerCase();

    // 3. Strip tracking params
    for (const param of TRACKING_PARAMS) {
      url.searchParams.delete(param);
    }

    // 4. Sort remaining params alphabetically
    url.searchParams.sort();

    // 5. Remove trailing slash (except root "/")
    if (url.pathname.length > 1 && url.pathname.endsWith('/')) {
      url.pathname = url.pathname.slice(0, -1);
    }

    return url.toString();
  } catch {
    return raw;
  }
}

/**
 * Check if a URL is same-domain as the base URL.
 * Compares lowercased hostnames only.
 */
export function isSameDomain(url: string, baseUrl: string): boolean {
  try {
    const a = new URL(url);
    const b = new URL(baseUrl);
    return a.hostname.toLowerCase() === b.hostname.toLowerCase();
  } catch {
    return false;
  }
}

/**
 * Extract the normalized domain from a URL.
 * Returns lowercase hostname without "www." prefix.
 */
export function extractDomain(url: string): string {
  try {
    const parsed = new URL(url.startsWith('http') ? url : `https://${url}`);
    return parsed.hostname.toLowerCase().replace(/^www\./, '');
  } catch {
    return url.toLowerCase();
  }
}

/**
 * Derive a readable label from a URL path.
 * Returns the last path segment, decoded.
 */
export function urlToLabel(url: string): string {
  try {
    const path = new URL(url).pathname;
    return decodeURIComponent(path.split('/').filter(Boolean).pop() || path);
  } catch {
    return url;
  }
}
```

**Design notes:**

- Returns `string` (never `null`) — on parse failure, returns input unchanged. This
  matches depth-prober's behavior and avoids null checks at every call site.
- `TRACKING_PARAMS` is a superset of pattern-matcher's list, adding `dclid`, `msclkid`,
  `twclid`, `mc_cid`, `mc_eid` for broader coverage.
- `extractDomain()` strips `www.` prefix so `www.epson.com` and `epson.com` match.
- `urlToLabel()` extracted from depth-prober.ts — reused by BFS engine for tree labels.

### T-2b: BFS Discovery Engine

#### Location

`apps/crawler-mcp-server/src/explore/bfs-discovery.ts`

#### Configuration Interface

```typescript
export interface BfsDiscoveryConfig {
  /** Unique ID for this discovery run */
  discoveryId: string;

  /** Primary URL (website root or section root) */
  primaryUrl: string;

  /** Sample/target URLs provided by the user */
  sampleUrls: string[];

  /** Max depth levels for automatic phases (1-3). Default: 8 */
  maxDepth: number;

  /** Page navigation timeout in ms. Default: 15000 */
  pageTimeout: number;

  /** Max total URLs tracked in allUrls map. Default: 50000 */
  maxAllLinks: number;
}
```

#### Default Config Constants

```typescript
const DEFAULT_MAX_DEPTH = 8;
const DEFAULT_PAGE_TIMEOUT = 15_000;
const DEFAULT_MAX_ALL_LINKS = 50_000;
const PROGRESS_THROTTLE_MS = 300;
const MAX_EXPLORE_ALL_URLS = 20;
```

#### Progress Event Interface

These events are streamed via SSE to the caller.

```typescript
/** Union of all SSE event types */
export type BfsProgressEvent =
  | BfsPhaseEvent
  | BfsPageVisitEvent
  | BfsUrlDiscoveredEvent
  | BfsTreeUpdateEvent
  | BfsActivityLogEvent
  | BfsCompleteEvent
  | BfsErrorEvent;

export interface BfsPhaseEvent {
  type: 'phase';
  phase: 0 | '1a' | '1b' | 2 | 3; // Phase 4 is command-driven (explore-branch/explore-all), not a discrete phase
  label: string;
  timestamp: number;
}

export interface BfsPageVisitEvent {
  type: 'page-visit';
  url: string;
  status: 'visiting' | 'visited' | 'error';
  linksFound: number;
  newLinksFound: number;
  pageRole?: 'hub' | 'leaf' | 'mixed';
  renderMethod?: 'http' | 'browser' | 'unknown';
  errorMessage?: string;
  timestamp: number;
}

export interface BfsUrlDiscoveredEvent {
  type: 'url-discovered';
  url: string;
  foundOn: string;
  timestamp: number;
}

export interface BfsTreeUpdateEvent {
  type: 'tree-update';
  totalUrls: number;
  totalVisited: number;
  /** Incremental tree diff — only new nodes since last update */
  newNodes: Array<{
    url: string;
    label: string;
    parentUrl: string | null;
    depth: number;
  }>;
  timestamp: number;
}

export interface BfsActivityLogEvent {
  type: 'activity';
  message: string;
  level: 'info' | 'warn' | 'detail';
  timestamp: number;
}

export interface BfsCompleteEvent {
  type: 'complete';
  totalUrls: number;
  totalVisited: number;
  totalPhasesRun: number;
  durationMs: number;
  stoppedBy: 'exhausted' | 'user-stop' | 'yield-limit' | 'url-cap';
  timestamp: number;
}

export interface BfsErrorEvent {
  type: 'error';
  message: string;
  phase?: string;
  timestamp: number;
}
```

#### Result Interface

Returned at the end of the SSE stream as the `complete` event payload,
and also as the function return value.

```typescript
export interface BfsDiscoveryResult {
  discoveryId: string;
  domain: string;
  /** All discovered URLs as a flat map (url -> metadata) */
  discoveredUrls: Map<string, DiscoveredPage>;
  /** Tree built from URL paths */
  treeHierarchy: TreeNode[];
  /** Nav structure from Phase 0 */
  navStructure: NavNode[];
  /** Breadcrumb chains collected during Phases 1a/2 */
  breadcrumbChains: Array<{
    sourceUrl: string;
    crumbs: Breadcrumb[];
    strategy: string;
  }>;
  /** Statistics */
  stats: {
    totalUrls: number;
    totalVisited: number;
    totalPhases: number;
    durationMs: number;
    stoppedBy: 'exhausted' | 'user-stop' | 'yield-limit' | 'url-cap';
  };
}

/** Per-URL metadata tracked during BFS */
export interface DiscoveredPage {
  url: string;
  foundOn: string[];
  renderMethod: 'http' | 'browser' | 'unknown';
  visited: boolean;
  status: 'discovered' | 'visiting' | 'visited' | 'error';
  childUrls: string[];
  title?: string;
  pageRole?: PageRole;
  errorMessage?: string;
}

/** Tree node built from URL path hierarchy */
export interface TreeNode {
  url: string;
  label: string;
  children: TreeNode[];
  depth: number;
}
```

#### Core Function Signature

```typescript
/**
 * Run BFS discovery from seed URLs.
 *
 * @param config - Discovery configuration
 * @param browserPool - Playwright browser pool for page management
 * @param onEvent - Callback for SSE progress events
 * @param shouldStop - Signal function: returns true when the caller wants to stop
 * @returns Complete discovery result
 */
export async function runBfsDiscovery(
  config: BfsDiscoveryConfig,
  browserPool: BrowserPool,
  onEvent: (event: BfsProgressEvent) => void,
  shouldStop: () => boolean,
): Promise<BfsDiscoveryResult>;
```

#### Internal State

```typescript
// Inside runBfsDiscovery():

/** All discovered URLs — the single source of truth for deduplication */
const allUrls = new Map<string, DiscoveredPage>(); // capped at MAX_ALL_LINKS

/** Breadcrumb chains collected from visited pages */
const breadcrumbChains: Array<{
  sourceUrl: string;
  crumbs: Breadcrumb[];
  strategy: string;
}> = [];

/** Nav structure from Phase 0 */
let navStructure: NavNode[] = [];

/** Track visited count for stats */
let visitedCount = 0;

/** Start time for duration */
const startTime = Date.now();

/** Session ID for browser pool */
const sessionId = `bfs-${config.discoveryId}`;

/** Base URL parsed for domain filtering */
const baseUrl = new URL(config.primaryUrl);
const baseDomain = extractDomain(config.primaryUrl);
```

#### Phase-by-Phase Pseudocode

##### Phase 0: Nav Extraction

```
emit phase event: { phase: 0, label: 'Extracting site navigation' }
emit activity: 'Phase 0: Extracting nav from primary URL'

page = await browserPool.getPage(sessionId)

TRY:
  await navigateWithRetry(page, config.primaryUrl, config.pageTimeout, progress)
  await dismissOverlays(page)
  navResult = await extractSiteNavigation(page, config.primaryUrl)
  navStructure = navResult.nodes

  emit activity: `Found ${navStructure.length} top-level nav sections`

  // Also collect links from the primary URL page (it's already loaded)
  primaryLinks = await extractPageLinks(page)
  sameDomainLinks = primaryLinks.filter(link => isSameDomain(link.href, config.primaryUrl))

  // Register primary URL as visited
  addOrUpdateUrl(allUrls, config.primaryUrl, {
    visited: true,
    status: 'visited',
    foundOn: [],
    childUrls: sameDomainLinks.map(l => normalizeUrl(l.href)),
    renderMethod: 'unknown',
  })

  // Register all same-domain links as discovered
  for (link of sameDomainLinks):
    normalizedHref = normalizeUrl(link.href)
    if not allUrls.has(normalizedHref) AND allUrls.size < MAX_ALL_LINKS:
      addOrUpdateUrl(allUrls, normalizedHref, {
        visited: false,
        status: 'discovered',
        foundOn: [config.primaryUrl],
        childUrls: [],
        renderMethod: 'unknown',
      })

  visitedCount++
  emit tree-update

CATCH err:
  emit error: `Phase 0 failed: ${err.message}`
  // Non-fatal — continue to Phase 1a without nav
```

##### Phase 1a: Visit Sample URLs

```
emit phase event: { phase: '1a', label: 'Visiting seed URLs' }

seeds = [config.primaryUrl, ...config.sampleUrls]
// Primary was already visited in Phase 0, skip it
seedsToVisit = seeds.filter(s => normalizeUrl(s) !== normalizeUrl(config.primaryUrl))

for (seedUrl of seedsToVisit):
  if shouldStop(): break
  checkCommandQueue(config.discoveryId)

  normalizedSeed = normalizeUrl(seedUrl)
  emit activity: `Phase 1a: Visiting seed ${urlToLabel(seedUrl)}`

  TRY:
    await navigateWithRetry(page, seedUrl, config.pageTimeout, progress)
    await dismissOverlays(page)

    // Extract links
    links = await extractPageLinks(page)
    sameDomainLinks = links.filter(l => isSameDomain(l.href, config.primaryUrl))

    // Extract breadcrumbs
    bcResult = await extractBreadcrumbs(page)
    if bcResult.crumbs.length > 0:
      breadcrumbChains.push({
        sourceUrl: seedUrl,
        crumbs: bcResult.crumbs,
        strategy: bcResult.strategy,
      })
      emit activity: `Breadcrumb: ${bcResult.crumbs.map(c => c.text).join(' > ')}`

    // Classify page
    metrics = await collectPageMetrics(page)
    role = classifyPage(metrics)

    // Update allUrls
    renderMethod = await detectRenderMethod(page)

    addOrUpdateUrl(allUrls, normalizedSeed, {
      visited: true,
      status: 'visited',
      foundOn: existing?.foundOn || [],
      childUrls: sameDomainLinks.map(l => normalizeUrl(l.href)),
      pageRole: role,
      renderMethod,
    })

    // Register discovered links
    newCount = 0
    for (link of sameDomainLinks):
      nh = normalizeUrl(link.href)
      if not allUrls.has(nh) AND allUrls.size < MAX_ALL_LINKS:
        addOrUpdateUrl(allUrls, nh, discovered-defaults)
        newCount++
      else if allUrls.has(nh):
        appendFoundOn(allUrls, nh, normalizedSeed)

    visitedCount++
    emit page-visit: { url: seedUrl, linksFound: sameDomainLinks.length, newLinksFound: newCount, pageRole: role }
    emit tree-update (throttled)

  CATCH err:
    markError(allUrls, normalizedSeed, err.message)
    emit page-visit: { url: seedUrl, status: 'error', errorMessage: err.message }
```

##### Phase 1b: Visit Children of Seeds

```
emit phase event: { phase: '1b', label: 'Visiting children of seed URLs' }

// Collect child URLs from all seeds (already visited in 1a)
childUrlsToVisit = []
for (seed of seeds):
  entry = allUrls.get(normalizeUrl(seed))
  if entry AND entry.childUrls:
    for (childUrl of entry.childUrls):
      if not allUrls.get(childUrl)?.visited:
        childUrlsToVisit.push(childUrl)

// Deduplicate
childUrlsToVisit = [...new Set(childUrlsToVisit)]

for (childUrl of childUrlsToVisit):
  if shouldStop(): break
  checkCommandQueue(config.discoveryId)
  if allUrls.get(childUrl)?.visited: continue // may have been visited by another path

  emit activity: `Phase 1b: Visiting ${urlToLabel(childUrl)}`

  visitPage(page, childUrl, allUrls, breadcrumbChains, config, onEvent)
  // visitPage is a helper that does navigate + extractLinks + extractBreadcrumbs
  // + classifyPage + updateAllUrls + emit events
  // (factored out because it's reused in Phase 2, 3, and 4)
```

##### Phase 2: Climb UP (Breadcrumb-Guided)

```
emit phase event: { phase: 2, label: 'Climbing breadcrumbs to find parents' }

// Collect ALL breadcrumb ancestor URLs, sorted shallowest-first
ancestorUrls = new Map<string, number>()  // url -> depth

for (chain of breadcrumbChains):
  for (crumb of chain.crumbs):
    normalizedCrumb = normalizeUrl(crumb.href)
    if not ancestorUrls.has(normalizedCrumb) OR crumb.depth < ancestorUrls.get(normalizedCrumb):
      ancestorUrls.set(normalizedCrumb, crumb.depth)

// Sort by depth (shallowest first)
sortedAncestors = [...ancestorUrls.entries()]
  .sort((a, b) => a[1] - b[1])
  .map(([url]) => url)

// Visit unvisited ancestors
for (ancestorUrl of sortedAncestors):
  if shouldStop(): break
  checkCommandQueue(config.discoveryId)
  if allUrls.get(ancestorUrl)?.visited: continue

  emit activity: `Phase 2: Climbing to ${urlToLabel(ancestorUrl)}`

  visitPage(page, ancestorUrl, allUrls, breadcrumbChains, config, onEvent)

  // Dynamic breadcrumb queue: if this page's links lead to pages with new
  // breadcrumbs, those will be discovered when we visit them. But we don't
  // visit all links in Phase 2 — just the breadcrumb ancestors. New
  // breadcrumbs from Phase 2 pages are merged back into the queue.
  //
  // Check if visiting this page revealed new breadcrumb chains:
  newChains = breadcrumbChains that were added during visitPage
  for (newChain of newChains):
    for (crumb of newChain.crumbs):
      normalizedCrumb = normalizeUrl(crumb.href)
      if not sortedAncestors.includes(normalizedCrumb)
         AND not allUrls.get(normalizedCrumb)?.visited:
        // Insert into queue, re-sort by depth
        sortedAncestors.push(normalizedCrumb)
        // Re-sort is O(n) but queue is small (breadcrumb depth << 100)

// Fallback: URL path truncation (when no breadcrumbs were found)
if breadcrumbChains.length === 0:
  emit activity: 'No breadcrumbs found — trying URL path truncation'
  for (seedUrl of config.sampleUrls):
    segments = new URL(seedUrl).pathname.split('/').filter(Boolean)
    // Walk up from deepest to shallowest
    for i = segments.length - 1 downto 1:
      truncatedPath = '/' + segments.slice(0, i).join('/')
      truncatedUrl = new URL(seedUrl).origin + truncatedPath
      normalizedTruncated = normalizeUrl(truncatedUrl)

      if allUrls.get(normalizedTruncated)?.visited: break // found a known ancestor

      emit activity: `Trying truncated path: ${truncatedPath}`
      TRY:
        await navigateWithRetry(page, truncatedUrl, config.pageTimeout, progress)
        // Check for redirect — the redirect target is the real hub
        actualUrl = normalizeUrl(page.url())
        if actualUrl !== normalizedTruncated:
          emit activity: `Redirected to ${urlToLabel(actualUrl)}`

        visitPage(page, actualUrl, allUrls, breadcrumbChains, config, onEvent)
      CATCH:
        emit activity: `${truncatedPath} returned error — skipping`
        continue // try shorter path
```

##### Phase 3: BFS Depth-1 Expansion

**Bridge page handling:** The BFS engine filters URLs by domain only (via
`isSameDomain()`), not by URL path prefix. This means cross-prefix links are
discovered naturally during Phases 1-2. For example, if `/products/printers`
links to `/support/printers/setup`, the `/support/*` URL is added to `allUrls`
and appears in the tree immediately.

However, the yield tracker runs across ALL unvisited URLs as a single pool. If
many same-prefix URLs produce diminishing returns, Phase 3 may stop before
reaching cross-prefix URLs sitting later in the iteration list. This is
acceptable because:

1. Cross-prefix URLs are already **discovered** and visible in the tree
2. The user can expand them manually via "Discover More" (Phase 4, no depth limit)
3. A future improvement could group Phase 3 by URL prefix and run yield tracking
   per-group, but this adds complexity without clear necessity for Build 1

```
emit phase event: { phase: 3, label: 'BFS expanding unvisited URLs' }

// Collect unvisited URLs that were discovered during Phases 1-2
yieldTracker = createYieldTracker()

// Sort unvisited URLs to interleave different prefixes — this gives cross-prefix
// URLs a better chance of being visited before yield tracking stops Phase 3.
// Simple heuristic: sort by URL path depth (shallowest first), then alphabetically.
// Shallow URLs are more likely to be hubs (high yield), keeping the tracker happy.
unvisitedUrls = [...allUrls.entries()]
  .filter(([_, page]) => !page.visited && page.status !== 'error')
  .map(([url]) => url)
  .sort((a, b) => {
    const aDepth = new URL(a).pathname.split('/').filter(Boolean).length;
    const bDepth = new URL(b).pathname.split('/').filter(Boolean).length;
    return aDepth - bDepth || a.localeCompare(b);
  })

for (url of unvisitedUrls):
  if shouldStop(): break
  checkCommandQueue(config.discoveryId)
  if allUrls.get(url)?.visited: continue // may have been visited via command queue

  // Check depth — count path segments relative to primary URL
  depth = countPathDepth(url, config.primaryUrl)
  if depth > config.maxDepth: continue

  emit activity: `Phase 3: Visiting ${urlToLabel(url)}`

  beforeSize = allUrls.size
  visitPage(page, url, allUrls, breadcrumbChains, config, onEvent)
  afterSize = allUrls.size

  newLinksOnPage = afterSize - beforeSize
  trackPageVisit(yieldTracker, newLinksOnPage)

  decision = shouldContinue(yieldTracker)
  if NOT decision.continue:
    emit activity: `Stopping Phase 3: ${decision.reason} (trend: ${decision.trend})`
    break

  // Check URL cap
  if allUrls.size >= config.maxAllLinks:
    emit activity: `URL cap reached (${config.maxAllLinks})`
    break
```

##### Command Queue Checking (between every page visit)

```
function checkCommandQueue(discoveryId):
  while true:
    command = getNextCommand(discoveryId)
    if not command: break

    switch command.type:
      case 'stop':
        // Set shouldStop flag — next loop iteration will check
        return 'stop'

      case 'explore-branch':
        // Phase 4 expansion — visit the target URL + its children
        targetUrl = command.payload?.url
        if targetUrl:
          emit activity: `User: Discover More on ${urlToLabel(targetUrl)}`
          visitPage(page, targetUrl, ...)
          // Then visit its unvisited children (depth-1)
          entry = allUrls.get(normalizeUrl(targetUrl))
          if entry?.childUrls:
            for child of entry.childUrls.slice(0, MAX_EXPLORE_ALL_URLS):
              if not allUrls.get(child)?.visited:
                visitPage(page, child, ...)

      case 'explore-all':
        // Visit up to MAX_EXPLORE_ALL_URLS unvisited children of the target
        targetUrl = command.payload?.url
        if targetUrl:
          entry = allUrls.get(normalizeUrl(targetUrl))
          if entry?.childUrls:
            toExplore = entry.childUrls
              .filter(c => !allUrls.get(c)?.visited)
              .slice(0, MAX_EXPLORE_ALL_URLS)
            for child of toExplore:
              visitPage(page, child, ...)

      case 'skip-branch':
        // Mark as skipped — no action needed, just don't visit
        emit activity: `User: Skipping ${command.payload?.url}`

      default:
        // Unknown command — log and continue
```

##### Helper: detectRenderMethod

Determines whether a page can be fetched with simple HTTP or requires a real browser.
This function runs AFTER the page is already loaded in Playwright — it inspects the
rendered DOM for signals that indicate JavaScript dependency.

```typescript
/**
 * Detect whether a page requires browser rendering or can be fetched via HTTP.
 *
 * Runs a single page.evaluate() that checks multiple signals:
 * - JS framework markers (React, Angular, Vue, Next.js, Nuxt)
 * - <noscript> tags with significant content (fallback for no-JS)
 * - Empty <body> before hydration (SPA shell pattern)
 * - Client-side routing markers (data-reactroot, ng-app, __NEXT_DATA__)
 * - Dynamic content attributes (data-src, loading="lazy" on non-images)
 *
 * Returns 'http' if the page appears to be static HTML with content.
 * Returns 'browser' if JS framework signals are detected.
 *
 * This is a heuristic — false positives (marking static pages as 'browser')
 * are acceptable. False negatives (marking JS pages as 'http') cause broken
 * extraction downstream, so the heuristic biases toward 'browser' on ambiguity.
 */
async function detectRenderMethod(page: Page): Promise<'http' | 'browser'> {
  try {
    const signals = await page.evaluate(`(() => {
      const html = document.documentElement.innerHTML;

      // 1. JS framework markers in the DOM
      const hasReact = !!document.querySelector('[data-reactroot]') ||
                       !!document.getElementById('__next') ||
                       !!document.querySelector('[data-reactid]');
      const hasAngular = !!document.querySelector('[ng-app]') ||
                         !!document.querySelector('[ng-version]') ||
                         html.includes('ng-binding');
      const hasVue = !!document.querySelector('[data-v-]') ||
                     !!document.getElementById('__nuxt');

      // 2. SPA shell detection — body has very little text content
      //    relative to HTML size (JS fills content after hydration)
      const bodyText = document.body?.innerText?.trim() || '';
      const bodyHtml = document.body?.innerHTML || '';
      const textToHtmlRatio = bodyHtml.length > 0
        ? bodyText.length / bodyHtml.length
        : 1;
      const isSpaShell = textToHtmlRatio < 0.05 && bodyHtml.length > 500;

      // 3. Noscript with meaningful content
      const noscripts = document.querySelectorAll('noscript');
      const hasSignificantNoscript = Array.from(noscripts).some(
        ns => (ns.textContent?.length || 0) > 50
      );

      // 4. Next.js / Nuxt data scripts
      const hasNextData = !!document.getElementById('__NEXT_DATA__');
      const hasNuxtData = !!document.getElementById('__NUXT_DATA__') ||
                          !!window.__NUXT__;

      return {
        hasReact, hasAngular, hasVue,
        isSpaShell, hasSignificantNoscript,
        hasNextData, hasNuxtData,
      };
    })()`);

    // Any framework signal → browser required
    if (
      signals.hasReact ||
      signals.hasAngular ||
      signals.hasVue ||
      signals.isSpaShell ||
      signals.hasSignificantNoscript ||
      signals.hasNextData ||
      signals.hasNuxtData
    ) {
      return 'browser';
    }

    return 'http';
  } catch {
    // If evaluation fails, assume browser needed (safe default)
    return 'browser';
  }
}
```

**Design notes:**

- Uses string-based `page.evaluate()` (not a function reference) to avoid the tsx
  `__name()` injection gotcha documented in the implementation plan.
- Biases toward `'browser'` on ambiguity — false positives waste resources but don't
  break extraction. False negatives break extraction.
- Runs once per page visit, adds ~5-10ms overhead (single DOM query, no network).
- Does NOT use `collectPageMetrics()` from page-classifier.ts — that function measures
  link density and prose ratio for hub/leaf classification, which is a different concern.

##### Helper: visitPage

```
async function visitPage(
  page: Page,
  url: string,
  allUrls: Map<string, DiscoveredPage>,
  breadcrumbChains: Array<...>,
  config: BfsDiscoveryConfig,
  onEvent: (event: BfsProgressEvent) => void,
): Promise<void> {

  const normalizedUrl = normalizeUrl(url);
  const existing = allUrls.get(normalizedUrl);

  // Mark as visiting
  addOrUpdateUrl(allUrls, normalizedUrl, { ...existing, status: 'visiting', visited: false });
  onEvent({ type: 'page-visit', url, status: 'visiting', linksFound: 0, newLinksFound: 0, timestamp: Date.now() });

  try {
    await navigateWithRetry(page, url, config.pageTimeout, dummyProgress);
    await dismissOverlays(page);

    // Extract links
    const links = await extractPageLinks(page);
    const sameDomainLinks = links.filter(l => isSameDomain(l.href, config.primaryUrl));

    // Extract breadcrumbs
    const bcResult = await extractBreadcrumbs(page);
    if (bcResult.crumbs.length > 0) {
      breadcrumbChains.push({ sourceUrl: url, crumbs: bcResult.crumbs, strategy: bcResult.strategy });
    }

    // Classify page role (hub/leaf/mixed) and render method (http/browser)
    const metrics = await collectPageMetrics(page);
    const role = classifyPage(metrics);
    const renderMethod = await detectRenderMethod(page);

    // Update the entry
    const childUrls = sameDomainLinks.map(l => normalizeUrl(l.href));
    addOrUpdateUrl(allUrls, normalizedUrl, {
      visited: true,
      status: 'visited',
      foundOn: existing?.foundOn || [],
      childUrls,
      pageRole: role,
      renderMethod,
    });

    // Register new links
    let newCount = 0;
    for (const link of sameDomainLinks) {
      const nh = normalizeUrl(link.href);
      if (!allUrls.has(nh) && allUrls.size < config.maxAllLinks) {
        addOrUpdateUrl(allUrls, nh, {
          url: nh,
          visited: false,
          status: 'discovered',
          foundOn: [normalizedUrl],
          childUrls: [],
          renderMethod: 'unknown',
        });
        newCount++;
      } else if (allUrls.has(nh)) {
        appendFoundOn(allUrls, nh, normalizedUrl);
      }
    }

    onEvent({
      type: 'page-visit',
      url,
      status: 'visited',
      linksFound: sameDomainLinks.length,
      newLinksFound: newCount,
      pageRole: role,
      renderMethod,
      timestamp: Date.now(),
    });

  } catch (err: unknown) {
    const message = err instanceof Error ? err.message : String(err);
    addOrUpdateUrl(allUrls, normalizedUrl, {
      ...existing,
      visited: true,
      status: 'error',
      errorMessage: message,
    });
    onEvent({
      type: 'page-visit',
      url,
      status: 'error',
      linksFound: 0,
      newLinksFound: 0,
      errorMessage: message,
      timestamp: Date.now(),
    });
  }
}
```

##### Helper: buildTree (from flat URL map)

```
function buildTree(allUrls: Map<string, DiscoveredPage>, primaryUrl: string): TreeNode[] {
  // 1. Sort all URLs by path depth (shortest first)
  const sorted = [...allUrls.keys()].sort((a, b) => {
    const aDepth = new URL(a).pathname.split('/').filter(Boolean).length;
    const bDepth = new URL(b).pathname.split('/').filter(Boolean).length;
    return aDepth - bDepth;
  });

  // 2. Build tree by finding closest ancestor for each URL
  const nodeMap = new Map<string, TreeNode>();
  const roots: TreeNode[] = [];

  for (const url of sorted) {
    const node: TreeNode = {
      url,
      label: urlToLabel(url),
      children: [],
      depth: new URL(url).pathname.split('/').filter(Boolean).length,
    };
    nodeMap.set(url, node);

    const parentUrl = findClosestAncestor(url, nodeMap);
    if (parentUrl) {
      nodeMap.get(parentUrl)!.children.push(node);
    } else {
      roots.push(node);
    }
  }

  return roots;
}

function findClosestAncestor(
  url: string,
  nodeMap: Map<string, TreeNode>,
): string | null {
  try {
    const parsed = new URL(url);
    const segments = parsed.pathname.split('/').filter(Boolean);

    // Walk up from second-to-last segment to root
    for (let i = segments.length - 1; i >= 1; i--) {
      const candidatePath = '/' + segments.slice(0, i).join('/');
      const candidateUrl = normalizeUrl(parsed.origin + candidatePath);
      if (nodeMap.has(candidateUrl)) {
        return candidateUrl;
      }
    }

    // Try the root URL
    const rootUrl = normalizeUrl(parsed.origin + '/');
    if (nodeMap.has(rootUrl) && rootUrl !== normalizeUrl(url)) {
      return rootUrl;
    }
  } catch {
    // ignore
  }
  return null;
}
```

##### Main Orchestrator Flow

```
export async function runBfsDiscovery(
  config: BfsDiscoveryConfig,
  browserPool: BrowserPool,
  onEvent: (event: BfsProgressEvent) => void,
  shouldStop: () => boolean,
): Promise<BfsDiscoveryResult> {

  const allUrls = new Map<string, DiscoveredPage>();
  const breadcrumbChains = [];
  let navStructure: NavNode[] = [];
  const sessionId = `bfs-${config.discoveryId}`;
  const startTime = Date.now();
  let stoppedBy: 'exhausted' | 'user-stop' | 'yield-limit' | 'url-cap' = 'exhausted';

  // Throttled event emitter
  let lastTreeUpdateTime = 0;
  const throttledTreeUpdate = () => {
    const now = Date.now();
    if (now - lastTreeUpdateTime < PROGRESS_THROTTLE_MS) return;
    lastTreeUpdateTime = now;
    // emit tree-update with current stats
    onEvent({
      type: 'tree-update',
      totalUrls: allUrls.size,
      totalVisited: countVisited(allUrls),
      newNodes: [], // incremental diff (implementation detail)
      timestamp: now,
    });
  };

  const page = await browserPool.getPage(sessionId);

  // Attach API interceptor at session level — passive XHR/Fetch monitoring
  const apiHandle = await attachApiInterceptor(page, baseDomain).catch(() => null);

  try {
    // Phase 0: Nav Extraction
    // ... (see Phase 0 pseudocode above)

    if (shouldStop()) { stoppedBy = 'user-stop'; return buildResult(); }

    // Phase 1a: Visit Sample URLs
    // ... (see Phase 1a pseudocode above)

    if (shouldStop()) { stoppedBy = 'user-stop'; return buildResult(); }

    // Phase 1b: Visit Children of Seeds
    // ... (see Phase 1b pseudocode above)

    if (shouldStop()) { stoppedBy = 'user-stop'; return buildResult(); }

    // Phase 2: Climb Breadcrumbs
    // ... (see Phase 2 pseudocode above)

    if (shouldStop()) { stoppedBy = 'user-stop'; return buildResult(); }

    // Phase 3: BFS Depth-1 Expansion
    // ... (see Phase 3 pseudocode above)
    // stoppedBy set to 'yield-limit' or 'url-cap' if applicable

    // Build final result
    return buildResult();

  } finally {
    // Detach API interceptor before closing session
    if (apiHandle) {
      await apiHandle.detach().catch(() => {});
    }
    await browserPool.closeSession(sessionId).catch((err: unknown) => {
      // Log but don't propagate cleanup errors
      // Note: crawler-mcp-server uses console.error as its logging mechanism
      // (confirmed in agents.md — no createLogger in this package)
      console.error('[bfs-discovery] Session cleanup failed:', err instanceof Error ? err.message : String(err));
    });
  }

  function buildResult(): BfsDiscoveryResult {
    const tree = buildTree(allUrls, config.primaryUrl);
    const domain = extractDomain(config.primaryUrl);

    onEvent({
      type: 'complete',
      totalUrls: allUrls.size,
      totalVisited: countVisited(allUrls),
      totalPhasesRun: /* track which phases completed */,
      durationMs: Date.now() - startTime,
      stoppedBy,
      timestamp: Date.now(),
    });

    return {
      discoveryId: config.discoveryId,
      domain,
      discoveredUrls: allUrls,
      treeHierarchy: tree,
      navStructure,
      breadcrumbChains,
      stats: {
        totalUrls: allUrls.size,
        totalVisited: countVisited(allUrls),
        totalPhases: /* track */,
        durationMs: Date.now() - startTime,
        stoppedBy,
      },
    };
  }
}
```

#### Module Dependencies

```
bfs-discovery.ts imports:
  ├── ./url-normalizer.ts          (normalizeUrl, isSameDomain, extractDomain, urlToLabel)
  ├── ./nav-extractor.ts           (extractSiteNavigation, NavNode, NavExtractionResult)
  ├── ./breadcrumb-extractor.ts    (extractBreadcrumbs, Breadcrumb, BreadcrumbResult)
  ├── ./navigation-explorer.ts     (navigateWithRetry, extractPageLinks, dismissOverlays,
  │                                 DiscoveredLink, ExploreProgress)
  ├── ./page-classifier.ts         (classifyPage, collectPageMetrics, PageRole)
  ├── ./yield-tracker.ts           (createYieldTracker, trackPageVisit, shouldContinue,
  │                                 YieldTracker, YieldDecision)
  ├── ./command-queue.ts           (getNextCommand, Intervention)
  └── ../browser/pool.ts           (BrowserPool)
```

**Verified signatures (from source):**

| Function                   | File                       | Signature                                                                                                                   |
| -------------------------- | -------------------------- | --------------------------------------------------------------------------------------------------------------------------- |
| `extractSiteNavigation`    | nav-extractor.ts           | `(page: Page, baseUrl: string) => Promise<NavExtractionResult>`                                                             |
| `extractBreadcrumbs`       | breadcrumb-extractor.ts    | `(page: Page) => Promise<BreadcrumbResult>`                                                                                 |
| `navigateWithRetry`        | navigation-explorer.ts:221 | `(page: Page, url: string, baseTimeout: number, progress: ExploreProgress, onProgress?: ProgressCallback) => Promise<void>` |
| `extractPageLinks`         | navigation-explorer.ts:627 | `(page: Page) => Promise<DiscoveredLink[]>`                                                                                 |
| `dismissOverlays`          | navigation-explorer.ts:711 | `(page: Page) => Promise<void>`                                                                                             |
| `classifyPage`             | page-classifier.ts:71      | `(metrics: PageMetrics) => PageRole`                                                                                        |
| `collectPageMetrics`       | page-classifier.ts:148     | `(page: Page) => Promise<PageMetrics>`                                                                                      |
| `createYieldTracker`       | yield-tracker.ts:52        | `() => YieldTracker`                                                                                                        |
| `trackPageVisit`           | yield-tracker.ts:67        | `(tracker: YieldTracker, newLinksOnPage: number) => void`                                                                   |
| `shouldContinue`           | yield-tracker.ts:91        | `(tracker: YieldTracker) => YieldDecision`                                                                                  |
| `getNextCommand`           | command-queue.ts:65        | `(exploreId: string) => Intervention \| undefined`                                                                          |
| `attachApiInterceptor`     | api-interceptor.ts:136     | `(page: Page, domain: string) => Promise<ApiInterceptorHandle>`                                                             |
| `browserPool.getPage`      | browser/pool.ts:54         | `(sessionId: string) => Promise<Page>`                                                                                      |
| `browserPool.closeSession` | browser/pool.ts            | `(sessionId: string) => Promise<void>`                                                                                      |

**Note on `navigateWithRetry`:** The function requires an `ExploreProgress` object and
optional callback. The BFS engine creates a minimal dummy progress object for this:

```typescript
const dummyProgress: ExploreProgress = {
  phase: 'rendering',
  expandablesFound: 0,
  expandablesClicked: 0,
  linksFound: 0,
  depth: 0,
  tree: [],
};
```

### Subtasks (execution order)

1. **ST-2.1**: Create `url-normalizer.ts` with all 4 exported functions.
2. **ST-2.2**: Create `bfs-discovery.ts` scaffold — types, interfaces, `runBfsDiscovery` function signature, `visitPage` helper, `buildTree` helper.
3. **ST-2.3**: Implement Phase 0 (nav extraction, primary URL link extraction).
4. **ST-2.4**: Implement Phase 1a (seed URL visiting with breadcrumb extraction).
5. **ST-2.5**: Implement Phase 1b (children of seeds).
6. **ST-2.6**: Implement Phase 2 (breadcrumb climbing + truncation fallback).
7. **ST-2.7**: Implement Phase 3 (BFS depth-1 with yield tracking).
8. **ST-2.8**: Implement command queue checking between phases.
9. **ST-2.9**: Implement `buildTree` and final result assembly.
10. **ST-2.10**: Run `pnpm build --filter=crawler-mcp-server` after each sub-step.

### Acceptance Criteria

- AC-1: Given `normalizeUrl('https://EXAMPLE.COM/path/?utm_source=x&b=2&a=1#frag')`, When called, Then returns `'https://example.com/path?a=1&b=2'`.
- AC-2: Given `normalizeUrl('example.com/path/')`, When called, Then returns `'https://example.com/path'` (adds protocol, strips trailing slash).
- AC-3: Given `normalizeUrl('not a url %%%')`, When called, Then returns `'not a url %%%'` (passthrough on error).
- AC-4: Given `isSameDomain('https://epson.com/printers', 'https://epson.com/scanners')`, When called, Then returns `true`.
- AC-5: Given `extractDomain('https://www.epson.com/path')`, When called, Then returns `'epson.com'`.
- AC-6: Given `runBfsDiscovery()` is called with a primary URL and 2 sample URLs, When it completes, Then the result contains all URLs discovered across all 4 phases.
- AC-7: Given `runBfsDiscovery()` is called and `shouldStop()` returns true after Phase 1a, When checked, Then the function returns partial results with `stoppedBy: 'user-stop'`.
- AC-8: Given a yield tracker signals `continue: false` during Phase 3, When checked, Then Phase 3 stops and `stoppedBy: 'yield-limit'`.
- AC-9: Given a `'stop'` command is enqueued via command queue, When checked between page visits, Then the engine stops.
- AC-10: Given `buildTree()` receives a flat map of URLs, When called, Then it produces a tree where each node's children have the node's URL as a path prefix.

---

## Task T-3: BFS REST Endpoint

### Files to Modify

| File                                    | What Changes                                         |
| --------------------------------------- | ---------------------------------------------------- |
| `apps/crawler-mcp-server/src/server.ts` | Add import for `bfs-discovery.ts`, add 2 REST routes |

### Route: POST /api/bfs-discover

#### Request Schema (Zod)

```typescript
const BfsDiscoverRequestSchema = z.object({
  discoveryId: z.string().min(1),
  primaryUrl: z.string().url(),
  sampleUrls: z.array(z.string().url()).max(10).default([]),
  maxDepth: z.number().int().min(1).max(20).optional(),
  pageTimeout: z.number().int().min(5000).max(60000).optional(),
});
```

#### Response: SSE Stream

Same pattern as existing `POST /api/explore` (lines 356-482 of server.ts):

```typescript
app.post('/api/bfs-discover', async (req, res) => {
  const parsed = BfsDiscoverRequestSchema.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({
      success: false,
      error: { code: 'VALIDATION_ERROR', message: parsed.error.message },
    });
    return;
  }

  const { discoveryId, primaryUrl, sampleUrls, maxDepth, pageTimeout } = parsed.data;

  const config: BfsDiscoveryConfig = {
    discoveryId,
    primaryUrl,
    sampleUrls,
    maxDepth: maxDepth ?? 8,
    pageTimeout: pageTimeout ?? 15_000,
    maxAllLinks: 50_000,
  };

  // SSE headers (same pattern as /api/explore)
  res.setHeader('Content-Type', 'text/event-stream');
  res.setHeader('Cache-Control', 'no-cache');
  res.setHeader('Connection', 'keep-alive');
  res.setHeader('X-Accel-Buffering', 'no');
  res.status(200);
  res.flushHeaders();
  req.socket.setNoDelay(true);

  let stopped = false;
  res.on('close', () => {
    stopped = true;
  });

  const sendSSE = (event: string, data: unknown) => {
    if (stopped) return;
    try {
      res.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);
      // crawler-mcp-server does NOT use compression middleware, so flush() is
      // not needed here. setNoDelay(true) + flushHeaders() handles it.
      // NOTE: search-ai's proxy endpoint (T-4) DOES need flush() because
      // search-ai uses compression({ threshold: 1024 }).
    } catch {
      stopped = true;
    }
  };

  // Throttle progress events
  let lastProgressTime = 0;

  try {
    log.info('Starting BFS discovery', { discoveryId, primaryUrl });

    const result = await runBfsDiscovery(
      config,
      this.browserPool,
      (event: BfsProgressEvent) => {
        const now = Date.now();
        // Always send phase, complete, error events immediately
        // Throttle tree-update and page-visit events
        if (event.type === 'tree-update' || event.type === 'page-visit') {
          if (now - lastProgressTime < PROGRESS_THROTTLE_MS) return;
          lastProgressTime = now;
        }
        sendSSE(event.type, event);
      },
      () => stopped,
    );

    // Send final complete with full discovered URL list
    // (The Map is serialized as an array of [url, metadata] pairs)
    sendSSE('result', {
      discoveryId: result.discoveryId,
      domain: result.domain,
      discoveredUrls: [...result.discoveredUrls.entries()],
      treeHierarchy: result.treeHierarchy,
      navStructure: result.navStructure,
      breadcrumbChains: result.breadcrumbChains,
      stats: result.stats,
    });

    log.info('BFS discovery completed', {
      discoveryId,
      totalUrls: result.stats.totalUrls,
      totalVisited: result.stats.totalVisited,
      durationMs: result.stats.durationMs,
    });
  } catch (err: unknown) {
    const message = err instanceof Error ? err.message : String(err);
    log.error('BFS discovery failed', { discoveryId, error: message });
    sendSSE('error', { type: 'error', message, timestamp: Date.now() });
  } finally {
    if (!stopped) {
      res.end();
    }
  }
});
```

### Route: POST /api/bfs-discover/:id/command

Enqueues an intervention command for a running BFS discovery.

```typescript
const BfsCommandRequestSchema = z.object({
  type: z.enum(['stop', 'explore-branch', 'explore-all', 'skip-branch', 'undo-skip']),
  payload: z
    .object({
      url: z.string().url().optional(),
      urls: z.array(z.string().url()).max(50).optional(),
      maxDepth: z.number().int().min(1).max(20).optional(),
    })
    .optional(),
});

app.post('/api/bfs-discover/:id/command', (req, res) => {
  const parsed = BfsCommandRequestSchema.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({
      success: false,
      error: { code: 'VALIDATION_ERROR', message: parsed.error.message },
    });
    return;
  }

  const discoveryId = req.params.id;
  const command: Intervention = {
    ...parsed.data,
    receivedAt: Date.now(),
  };

  const queued = enqueueCommand(discoveryId, command);
  if (!queued) {
    res.status(429).json({
      success: false,
      error: { code: 'QUEUE_FULL', message: 'Command queue is full' },
    });
    return;
  }

  res.json({ success: true, data: { queued: true } });
});
```

### Subtasks (execution order)

1. **ST-3.1**: Add `import { runBfsDiscovery, ... } from './explore/bfs-discovery.js';` to server.ts.
2. **ST-3.2**: Add Zod schemas for both endpoints.
3. **ST-3.3**: Implement `POST /api/bfs-discover` with SSE streaming.
4. **ST-3.4**: Implement `POST /api/bfs-discover/:id/command`.
5. **ST-3.5**: Run `pnpm build --filter=crawler-mcp-server`.

### Acceptance Criteria

- AC-1: Given a valid POST to `/api/bfs-discover`, When the engine runs, Then SSE events stream with `Content-Type: text/event-stream` and `X-Accel-Buffering: no`.
- AC-2: Given an invalid request body (missing `primaryUrl`), When POSTed, Then returns 400 with `VALIDATION_ERROR`.
- AC-3: Given a running discovery, When `POST /api/bfs-discover/:id/command` sends `{ type: 'stop' }`, Then the command is enqueued and returns `{ success: true }`.
- AC-4: Given the command queue is full (50 commands), When another command is sent, Then returns 429 with `QUEUE_FULL`.
- AC-5: Given the SSE stream completes, When the last event is sent, Then it is a `result` event containing the full discovery result.

---

## Task T-4: Discovery API Routes (search-ai)

### Files to Create

| File                                     | Purpose                    |
| ---------------------------------------- | -------------------------- |
| `apps/search-ai/src/routes/discovery.ts` | All 7 discovery API routes |

### Files to Modify

| File                           | What Changes                                          |
| ------------------------------ | ----------------------------------------------------- |
| `apps/search-ai/src/server.ts` | Add import + `app.use('/api/crawl', discoveryRouter)` |

### Route Definitions

All routes are mounted under `/api/crawl/discovery/...` via the crawl router pattern.
Auth is inherited from the `/api` mount (same as other crawl routes).

#### Zod Schemas

```typescript
import { z } from 'zod';
import { createLogger } from '@abl/compiler/platform';

const log = createLogger('discovery');

/** Validates :id path params — all endpoints that take discoveryId */
const DiscoveryIdParamSchema = z.object({
  id: z.string().min(1),
});

const StartDiscoverySchema = z.object({
  primaryUrl: z.string().url(),
  sampleUrls: z.array(z.string().url()).max(10).default([]),
  seeds: z
    .array(
      z.object({
        type: z.enum(['nav-section', 'target-url']),
        url: z.string().url(),
        label: z.string().max(200).optional(),
      }),
    )
    .min(1)
    .max(20),
  maxDepth: z.number().int().min(1).max(20).optional(),
  sourceId: z.string().min(1).optional(),
});

const SelectUrlsSchema = z.object({
  selectedUrls: z.array(z.string().url()).max(50_000),
  selectionPatterns: z.array(z.string().max(500)).max(100).optional(),
});

const DiscoverMoreSchema = z.object({
  type: z.enum(['explore-branch', 'explore-all']),
  url: z.string().url(),
});

const DomainParamSchema = z.object({
  domain: z.string().min(1).max(253),
});
```

#### SSE Auth Strategy

The `GET /discovery/:id/stream` endpoint uses SSE (EventSource). EventSource cannot
send custom `Authorization` headers. Auth options:

1. **Query param token** (`?token=<jwt>`) — existing pattern in the codebase (used by
   `crawl-browser-discover.ts`). The route validates the token from `req.query.token`
   using the same auth middleware.
2. **Cookie-based auth** — if the frontend sets an HttpOnly session cookie.

**Decision:** Use `?token=` query param (option 1) — matches existing pattern. The route
extracts the token from `req.query.token` and validates via `requireAuth` or equivalent.
All other endpoints (POST/GET with JSON) use standard `Authorization` header.

#### SSRF Validation

Carry forward `isPrivateOrUnsafeUrl()` from `crawl-browser-discover.ts` (lines 592-620).
Extract into a shared utility or inline in discovery.ts.

```typescript
/**
 * SSRF protection — block requests to private/internal networks.
 * Carried forward from crawl-browser-discover.ts (lines 592-620)
 * with additional cloud metadata endpoint coverage.
 */
function isPrivateOrUnsafeUrl(urlStr: string): boolean {
  try {
    const parsed = new URL(urlStr);
    // Only HTTP/HTTPS allowed
    if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') return true;
    // Block non-standard ports that are commonly internal
    const port = parsed.port ? parseInt(parsed.port, 10) : null;
    if (port !== null && port !== 80 && port !== 443 && port < 1024) return true;

    const hostname = parsed.hostname.toLowerCase();

    // Block loopback
    if (hostname === 'localhost' || hostname === '127.0.0.1' || hostname === '::1') return true;
    if (hostname === '0.0.0.0') return true;
    if (/^127\./.test(hostname)) return true; // entire 127.0.0.0/8 range

    // Block link-local
    if (hostname.startsWith('169.254.')) return true;

    // Block private IPv4 ranges (RFC 1918)
    if (hostname.startsWith('10.')) return true;
    if (hostname.startsWith('192.168.')) return true;
    if (/^172\.(1[6-9]|2\d|3[01])\./.test(hostname)) return true;

    // Block cloud metadata endpoints
    if (hostname === 'metadata.google.internal') return true;
    if (hostname === '169.254.169.254') return true; // AWS/GCP/Azure metadata
    if (hostname === 'metadata.internal') return true;

    // Block IPv6 private ranges
    if (hostname.startsWith('[fc') || hostname.startsWith('[fd')) return true; // ULA
    if (hostname.startsWith('[fe80:')) return true; // link-local

    return false;
  } catch {
    return true; // Invalid URL = unsafe
  }
}
```

#### Endpoint 1: POST /discovery/start

Start a BFS discovery run.

```typescript
router.post('/discovery/start', async (req, res) => {
  const parsed = StartDiscoverySchema.safeParse(req.body);
  if (!parsed.success) {
    return res.status(400).json({
      success: false,
      error: { code: 'VALIDATION_ERROR', message: parsed.error.message },
    });
  }

  const { primaryUrl, sampleUrls, seeds, maxDepth, sourceId } = parsed.data;
  const tenantId = req.tenantContext!.tenantId;

  // SSRF validation
  const allUrls = [primaryUrl, ...sampleUrls, ...seeds.map((s) => s.url)];
  const blockedUrl = allUrls.find(isPrivateOrUnsafeUrl);
  if (blockedUrl) {
    return res.status(400).json({
      success: false,
      error: {
        code: 'SSRF_BLOCKED',
        message: `URL targets a private or reserved address: ${blockedUrl}`,
      },
    });
  }

  const domain = extractDomain(primaryUrl);
  const discoveryId = uuidv7();

  // 1. Upsert SiteDiscovery (generic layer — no tenantId)
  const SiteDiscoveryModel = getModel('SiteDiscovery');
  await SiteDiscoveryModel.findOneAndUpdate(
    { domain },
    {
      $setOnInsert: { domain },
      $set: { lastDiscoveryAt: new Date() },
    },
    { upsert: true, new: true },
  );

  // 2. Create TenantDiscovery record
  const TenantDiscoveryModel = getModel('TenantDiscovery');
  const tenantDiscovery = await TenantDiscoveryModel.findOneAndUpdate(
    { tenantId, domain, sourceId: sourceId || null },
    {
      $set: {
        discoveryId,
        seedsUsed: seeds,
        status: 'active',
      },
      $setOnInsert: {
        tenantId,
        domain,
        sourceId: sourceId || undefined,
        exploredBranches: [],
        selectedUrls: [],
        selectionPatterns: [],
      },
    },
    { upsert: true, new: true },
  );

  // 3. Return streamUrl — the actual BFS engine starts when the client
  //    connects to GET /discovery/:id/stream (which POSTs to crawler-mcp-server).
  //    This follows the same pattern as crawl-browser-discover.ts where the SSE
  //    proxy endpoint initiates the upstream connection.

  res.json({
    success: true,
    data: {
      discoveryId,
      tenantDiscoveryId: tenantDiscovery._id,
      domain,
      streamUrl: `/api/crawl/discovery/${discoveryId}/stream`,
    },
  });
});
```

#### Endpoint 2: GET /discovery/:id/stream (SSE proxy)

Start the BFS engine on crawler-mcp-server (if not already running) and proxy SSE events
to the client. Also persists progress stats to MongoDB. This endpoint is the trigger
point — POST /start only creates DB records.

**Idempotency:** Uses an in-memory `Map<string, boolean>` to track active discoveries.
If a client reconnects while a discovery is already running, return 409 Conflict.

```typescript
// Module-level in-memory active tracking (single-instance, acceptable for Build 1)
const activeDiscoveries = new Map<string, boolean>(); // discoveryId -> running

router.get('/discovery/:id/stream', async (req, res) => {
  const paramsParsed = DiscoveryIdParamSchema.safeParse(req.params);
  if (!paramsParsed.success) {
    return res.status(400).json({
      success: false,
      error: { code: 'VALIDATION_ERROR', message: paramsParsed.error.message },
    });
  }
  const discoveryId = paramsParsed.data.id;
  const tenantId = req.tenantContext!.tenantId;

  // Verify tenant owns this discovery
  const TenantDiscoveryModel = getModel('TenantDiscovery');
  const td = await TenantDiscoveryModel.findOne({ discoveryId, tenantId });
  if (!td) {
    return res.status(404).json({
      success: false,
      error: { code: 'NOT_FOUND', message: 'Discovery not found' },
    });
  }

  // Idempotency guard — prevent duplicate BFS runs for same discoveryId
  if (activeDiscoveries.get(discoveryId)) {
    return res.status(409).json({
      success: false,
      error: { code: 'ALREADY_RUNNING', message: 'Discovery is already streaming' },
    });
  }

  // Check if already completed
  if (td.status === 'completed') {
    return res.status(409).json({
      success: false,
      error: {
        code: 'ALREADY_COMPLETED',
        message: 'Discovery already completed. Use GET /tree for results.',
      },
    });
  }

  activeDiscoveries.set(discoveryId, true);

  // SSE headers
  res.setHeader('Content-Type', 'text/event-stream');
  res.setHeader('Cache-Control', 'no-cache');
  res.setHeader('Connection', 'keep-alive');
  res.setHeader('X-Accel-Buffering', 'no');
  res.status(200);
  res.flushHeaders();
  req.socket.setNoDelay(true);

  let stopped = false;
  res.on('close', () => {
    stopped = true;
  });

  // Forward SSE from crawler-mcp-server
  const crawlerMcpUrl = process.env.CRAWLER_MCP_URL || 'http://localhost:3100';

  try {
    const response = await fetch(`${crawlerMcpUrl}/api/bfs-discover`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        discoveryId,
        primaryUrl: td.seedsUsed[0]?.url, // primary from seeds
        sampleUrls: td.seedsUsed.filter((s) => s.type === 'target-url').map((s) => s.url),
        maxDepth: td.crawlConfig?.maxDepth,
      }),
    });

    if (!response.ok || !response.body) {
      const text = await response.text().catch(() => 'Unknown error');
      res.write(`event: error\ndata: ${JSON.stringify({ message: text })}\n\n`);
      res.end();
      return;
    }

    // Two-tier persistence strategy:
    //
    // Tier 1 (every 10 events or 5s): Persist aggregate stats only.
    //   → Fast, lightweight. Lets GET /tree return approximate progress.
    //
    // Tier 2 (every 30s): Persist FULL discovery state via persistFinalResult.
    //   → Crash-resilient. If connection drops, the tree/URLs survive.
    //   → Follows the "Never Lose Work" principle (O6) and matches the old
    //     code's auto-save-every-30s pattern from DiscoveryPanel.tsx.
    //
    // On completion: persistFinalResult runs one final time with authoritative data.

    const PERSIST_BATCH_SIZE = 10;
    const PERSIST_INTERVAL_MS = 5_000;
    const AUTO_SAVE_INTERVAL_MS = 30_000;
    let pendingUrls: Array<Record<string, unknown>> = [];
    let lastPersistTime = Date.now();
    let lastAutoSaveTime = Date.now();
    let latestTotalUrls = 0;
    let latestTotalVisited = 0;
    const accumulatedVisitedPages: Array<Record<string, unknown>> = [];

    const persistBatch = async () => {
      if (pendingUrls.length === 0) return;
      pendingUrls.splice(0); // clear the batch
      try {
        const SiteDiscoveryModel = getModel('SiteDiscovery');
        await SiteDiscoveryModel.findOneAndUpdate(
          { domain: td.domain },
          {
            $set: {
              totalUrlsFound: latestTotalUrls,
              totalPagesVisited: latestTotalVisited,
            },
          },
        );
      } catch (err: unknown) {
        // Log but don't crash SSE stream
        log.error('Persist batch failed', {
          error: err instanceof Error ? err.message : String(err),
        });
      }
    };

    // Read SSE stream from crawler-mcp-server
    const reader = response.body.getReader();
    const decoder = new TextDecoder();
    let buffer = '';

    while (!stopped) {
      const { done, value } = await reader.read();
      if (done) break;

      buffer += decoder.decode(value, { stream: true });

      // Parse SSE events from buffer
      const events = parseSSEBuffer(buffer);
      buffer = events.remaining;

      for (const event of events.parsed) {
        // Forward to client (flush required — search-ai uses compression middleware)
        if (!stopped) {
          res.write(`event: ${event.type}\ndata: ${event.data}\n\n`);
          if (typeof (res as any).flush === 'function') {
            (res as any).flush();
          }
        }

        // Track stats for interim persistence
        if (event.type === 'page-visit') {
          pendingUrls.push(JSON.parse(event.data));
          latestTotalVisited++;
        }
        if (event.type === 'tree-update') {
          const data = JSON.parse(event.data);
          latestTotalUrls = data.totalUrls ?? latestTotalUrls;
        }

        // Tier 1: Persist stats every N events or 5s
        if (
          pendingUrls.length >= PERSIST_BATCH_SIZE ||
          Date.now() - lastPersistTime >= PERSIST_INTERVAL_MS
        ) {
          await persistBatch();
          lastPersistTime = Date.now();
        }

        // Accumulate visited pages for Tier 2 auto-save.
        // The proxy builds a running list of visited URLs from page-visit events.
        // This is NOT the authoritative data (the engine's Map is) but is sufficient
        // for crash recovery — the user gets back approximate state instead of nothing.
        if (event.type === 'page-visit') {
          const pvData = JSON.parse(event.data);
          if (pvData.status === 'visited') {
            accumulatedVisitedPages.push({
              url: pvData.url,
              renderMethod: pvData.renderMethod || 'unknown',
              visited: true,
              status: 'visited',
              foundOn: [],
              childUrls: [],
              pageRole: pvData.pageRole,
            });
          }
        }

        // Tier 2: Full-state auto-save every 30s (crash resilience).
        // Persists the accumulated visited pages so GET /tree can return
        // approximate data even if the stream drops before completion.
        // On completion, persistFinalResult overwrites with authoritative data.
        if (
          Date.now() - lastAutoSaveTime >= AUTO_SAVE_INTERVAL_MS &&
          accumulatedVisitedPages.length > 0
        ) {
          try {
            const SiteDiscoveryModel = getModel('SiteDiscovery');
            await SiteDiscoveryModel.findOneAndUpdate(
              { domain: td.domain },
              {
                $set: {
                  discoveredUrls: accumulatedVisitedPages,
                  totalUrlsFound: latestTotalUrls,
                  totalPagesVisited: latestTotalVisited,
                  lastDiscoveryAt: new Date(),
                },
              },
            );
            lastAutoSaveTime = Date.now();
            log.info('Auto-saved discovery state', { discoveryId, totalUrls: latestTotalUrls });
          } catch (err: unknown) {
            log.error('Auto-save failed', {
              error: err instanceof Error ? err.message : String(err),
            });
          }
        }

        // On complete/result: persist final authoritative state
        if (event.type === 'result') {
          await persistBatch();
          const resultData = JSON.parse(event.data);
          await persistFinalResult(td.domain, resultData);
        }
      }
    }

    // Flush remaining
    await persistBatch();
  } catch (err: unknown) {
    const message = err instanceof Error ? err.message : String(err);
    log.error('SSE proxy failed', { discoveryId, error: message });
    if (!stopped) {
      res.write(`event: error\ndata: ${JSON.stringify({ message })}\n\n`);
      if (typeof (res as any).flush === 'function') {
        (res as any).flush();
      }
    }
  } finally {
    activeDiscoveries.delete(discoveryId);
    // Update status to completed
    try {
      await TenantDiscoveryModel.findOneAndUpdate(
        { discoveryId, tenantId },
        { $set: { status: 'completed' } },
      );
    } catch {
      // Best-effort status update
    }
    if (!stopped) {
      res.end();
    }
  }
});
```

**SSE buffer parser helper:**

```typescript
interface ParsedSSEEvent {
  type: string;
  data: string;
}

function parseSSEBuffer(buffer: string): {
  parsed: ParsedSSEEvent[];
  remaining: string;
} {
  const parsed: ParsedSSEEvent[] = [];
  const blocks = buffer.split('\n\n');
  const remaining = blocks.pop() || ''; // last incomplete block

  for (const block of blocks) {
    if (!block.trim()) continue;
    let type = 'message';
    let data = '';
    for (const line of block.split('\n')) {
      if (line.startsWith('event: ')) type = line.slice(7);
      else if (line.startsWith('data: ')) data = line.slice(6);
    }
    if (data) parsed.push({ type, data });
  }

  return { parsed, remaining };
}
```

**Final result persistence helper:**

```typescript
async function persistFinalResult(
  domain: string,
  resultData: Record<string, unknown>,
): Promise<void> {
  try {
    const SiteDiscoveryModel = getModel('SiteDiscovery');

    // Convert discoveredUrls from [url, metadata] pairs to array
    const rawUrls = resultData.discoveredUrls as
      | Array<[string, Record<string, unknown>]>
      | undefined;
    const discoveredUrls = Array.isArray(rawUrls)
      ? rawUrls.map(([url, meta]) => ({
          url,
          ...meta,
        }))
      : [];

    await SiteDiscoveryModel.findOneAndUpdate(
      { domain },
      {
        $set: {
          discoveredUrls,
          treeHierarchy: resultData.treeHierarchy || [],
          navStructure: resultData.navStructure || [],
          breadcrumbChains: resultData.breadcrumbChains || [],
          totalUrlsFound: resultData.stats?.totalUrls || 0,
          totalPagesVisited: resultData.stats?.totalVisited || 0,
          lastDiscoveryAt: new Date(),
        },
      },
    );
  } catch (err: unknown) {
    log.error('Final persist failed', {
      domain,
      error: err instanceof Error ? err.message : String(err),
    });
  }
}
```

#### Endpoint 3: POST /discovery/:id/discover-more

Forward discover-more commands to crawler-mcp-server.

```typescript
router.post('/discovery/:id/discover-more', async (req, res) => {
  const paramsParsed = DiscoveryIdParamSchema.safeParse(req.params);
  if (!paramsParsed.success) {
    return res.status(400).json({
      success: false,
      error: { code: 'VALIDATION_ERROR', message: paramsParsed.error.message },
    });
  }
  const discoveryId = paramsParsed.data.id;
  const tenantId = req.tenantContext!.tenantId;
  const parsed = DiscoverMoreSchema.safeParse(req.body);
  if (!parsed.success) {
    return res.status(400).json({
      success: false,
      error: { code: 'VALIDATION_ERROR', message: parsed.error.message },
    });
  }

  // SSRF check
  if (isPrivateOrUnsafeUrl(parsed.data.url)) {
    return res.status(400).json({
      success: false,
      error: { code: 'SSRF_BLOCKED', message: 'URL targets a private or reserved address' },
    });
  }

  // Verify tenant owns this discovery
  const TenantDiscoveryModel = getModel('TenantDiscovery');
  const td = await TenantDiscoveryModel.findOne({ discoveryId, tenantId });
  if (!td) {
    return res.status(404).json({
      success: false,
      error: { code: 'NOT_FOUND', message: 'Discovery not found' },
    });
  }

  // Forward to crawler-mcp-server command queue
  const crawlerMcpUrl = process.env.CRAWLER_MCP_URL || 'http://localhost:3100';
  const cmdResponse = await fetch(`${crawlerMcpUrl}/api/bfs-discover/${discoveryId}/command`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      type: parsed.data.type,
      payload: { url: parsed.data.url },
    }),
  });

  if (!cmdResponse.ok) {
    const errBody = await cmdResponse.json().catch(() => ({}));
    return res.status(cmdResponse.status).json({
      success: false,
      error: errBody.error || { code: 'UPSTREAM_ERROR', message: 'Failed to forward command' },
    });
  }

  // Track explored branch in tenant discovery
  await TenantDiscoveryModel.findOneAndUpdate(
    { discoveryId, tenantId },
    { $addToSet: { exploredBranches: parsed.data.url } },
  );

  res.json({ success: true, data: { queued: true } });
});
```

#### Endpoint 4: POST /discovery/:id/stop

```typescript
router.post('/discovery/:id/stop', async (req, res) => {
  const paramsParsed = DiscoveryIdParamSchema.safeParse(req.params);
  if (!paramsParsed.success) {
    return res.status(400).json({
      success: false,
      error: { code: 'VALIDATION_ERROR', message: paramsParsed.error.message },
    });
  }
  const discoveryId = paramsParsed.data.id;
  const tenantId = req.tenantContext!.tenantId;

  const TenantDiscoveryModel = getModel('TenantDiscovery');
  const td = await TenantDiscoveryModel.findOne({ discoveryId, tenantId });
  if (!td) {
    return res.status(404).json({
      success: false,
      error: { code: 'NOT_FOUND', message: 'Discovery not found' },
    });
  }

  // Forward stop command
  const crawlerMcpUrl = process.env.CRAWLER_MCP_URL || 'http://localhost:3100';
  await fetch(`${crawlerMcpUrl}/api/bfs-discover/${discoveryId}/command`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ type: 'stop' }),
  });

  res.json({ success: true, data: { stopped: true } });
});
```

#### Endpoint 5: GET /discovery/:id/tree

```typescript
router.get('/discovery/:id/tree', async (req, res) => {
  const paramsParsed = DiscoveryIdParamSchema.safeParse(req.params);
  if (!paramsParsed.success) {
    return res.status(400).json({
      success: false,
      error: { code: 'VALIDATION_ERROR', message: paramsParsed.error.message },
    });
  }
  const discoveryId = paramsParsed.data.id;
  const tenantId = req.tenantContext!.tenantId;

  // Get tenant discovery
  const TenantDiscoveryModel = getModel('TenantDiscovery');
  const td = await TenantDiscoveryModel.findOne({ discoveryId, tenantId });
  if (!td) {
    return res.status(404).json({
      success: false,
      error: { code: 'NOT_FOUND', message: 'Discovery not found' },
    });
  }

  // Get site discovery (generic layer)
  const SiteDiscoveryModel = getModel('SiteDiscovery');
  const sd = await SiteDiscoveryModel.findOne({ domain: td.domain });

  res.json({
    success: true,
    data: {
      discoveryId,
      domain: td.domain,
      treeHierarchy: sd?.treeHierarchy || [],
      navStructure: sd?.navStructure || [],
      discoveredUrls: sd?.discoveredUrls || [],
      selectedUrls: td.selectedUrls,
      exploredBranches: td.exploredBranches,
      stats: {
        totalUrls: sd?.totalUrlsFound || 0,
        totalVisited: sd?.totalPagesVisited || 0,
      },
    },
  });
});
```

#### Endpoint 6: POST /discovery/:id/select

```typescript
router.post('/discovery/:id/select', async (req, res) => {
  const paramsParsed = DiscoveryIdParamSchema.safeParse(req.params);
  if (!paramsParsed.success) {
    return res.status(400).json({
      success: false,
      error: { code: 'VALIDATION_ERROR', message: paramsParsed.error.message },
    });
  }
  const discoveryId = paramsParsed.data.id;
  const tenantId = req.tenantContext!.tenantId;
  const parsed = SelectUrlsSchema.safeParse(req.body);
  if (!parsed.success) {
    return res.status(400).json({
      success: false,
      error: { code: 'VALIDATION_ERROR', message: parsed.error.message },
    });
  }

  const TenantDiscoveryModel = getModel('TenantDiscovery');
  const td = await TenantDiscoveryModel.findOneAndUpdate(
    { discoveryId, tenantId },
    {
      $set: {
        selectedUrls: parsed.data.selectedUrls,
        selectionPatterns: parsed.data.selectionPatterns || [],
      },
    },
    { new: true },
  );

  if (!td) {
    return res.status(404).json({
      success: false,
      error: { code: 'NOT_FOUND', message: 'Discovery not found' },
    });
  }

  res.json({
    success: true,
    data: {
      selectedCount: td.selectedUrls.length,
      patternCount: td.selectionPatterns.length,
    },
  });
});
```

#### Endpoint 7: GET /discovery/domain/:domain

Returns generic SiteDiscovery data for a domain (if any previous tenant discovered it).

```typescript
router.get('/discovery/domain/:domain', async (req, res) => {
  const parsed = DomainParamSchema.safeParse(req.params);
  if (!parsed.success) {
    return res.status(400).json({
      success: false,
      error: { code: 'VALIDATION_ERROR', message: parsed.error.message },
    });
  }

  const SiteDiscoveryModel = getModel('SiteDiscovery');
  const sd = await SiteDiscoveryModel.findOne({ domain: parsed.data.domain });

  if (!sd) {
    return res.status(404).json({
      success: false,
      error: { code: 'NOT_FOUND', message: 'No discovery data for this domain' },
    });
  }

  res.json({
    success: true,
    data: {
      domain: sd.domain,
      navStructure: sd.navStructure,
      treeHierarchy: sd.treeHierarchy,
      siteProfile: sd.siteProfile,
      totalUrlsFound: sd.totalUrlsFound,
      totalPagesVisited: sd.totalPagesVisited,
      lastDiscoveryAt: sd.lastDiscoveryAt,
    },
  });
});
```

### Route Registration

Add to `apps/search-ai/src/server.ts`:

```typescript
// Import
import discoveryRouter from './routes/discovery.js';

// Mount (after crawlBrowserDiscoverRouter removal, before crawlDraftsRouter)
app.use('/api/crawl', discoveryRouter);
```

**Route ordering note:** The `GET /discovery/domain/:domain` endpoint uses a static
path prefix (`domain/`) so it will not collide with `GET /discovery/:id/tree` or
`GET /discovery/:id/stream`. Express matches top-down, and `domain` is a literal
segment vs `:id` which is parameterized. Both patterns coexist because Express
resolves the first matching route — `domain` is a fixed string that matches before
`:id` for requests to `/discovery/domain/...`.

### Subtasks (execution order)

1. **ST-4.1**: Create `apps/search-ai/src/routes/discovery.ts` with router scaffold and Zod schemas.
2. **ST-4.2**: Implement `isPrivateOrUnsafeUrl()` (extract from old code).
3. **ST-4.3**: Implement `POST /discovery/start`.
4. **ST-4.4**: Implement `GET /discovery/:id/stream` with SSE proxy and batched persistence.
5. **ST-4.5**: Implement `POST /discovery/:id/discover-more`.
6. **ST-4.6**: Implement `POST /discovery/:id/stop`.
7. **ST-4.7**: Implement `GET /discovery/:id/tree`.
8. **ST-4.8**: Implement `POST /discovery/:id/select`.
9. **ST-4.9**: Implement `GET /discovery/domain/:domain`.
10. **ST-4.10**: Add import and mount in `server.ts`.
11. **ST-4.11**: Run `pnpm build --filter=search-ai`.

### Acceptance Criteria

- AC-1: Given a valid `POST /api/crawl/discovery/start` with seeds, When called with auth, Then returns `{ success: true, data: { discoveryId, streamUrl } }` and creates both SiteDiscovery and TenantDiscovery docs.
- AC-2: Given a private URL in seeds (e.g., `http://localhost:8080`), When `POST /discovery/start`, Then returns 400 with `SSRF_BLOCKED`.
- AC-3: Given a running discovery, When `GET /discovery/:id/stream` is called, Then SSE events are proxied from crawler-mcp-server with `Content-Type: text/event-stream`.
- AC-4: Given SSE events are streaming, When 10 `page-visit` events accumulate, Then they are batch-persisted to SiteDiscovery.discoveredUrls.
- AC-5: Given a discovery belongs to tenant A, When tenant B calls `GET /discovery/:id/tree`, Then returns 404.
- AC-6: Given `POST /discovery/:id/select` with 100 URLs, When called, Then TenantDiscovery.selectedUrls is updated with exactly those 100 URLs.
- AC-7: Given a domain was previously discovered, When `GET /discovery/domain/epson.com`, Then returns the generic SiteDiscovery data (navStructure, treeHierarchy, stats).
- AC-8: Given `POST /discovery/:id/discover-more` with a URL, When called, Then the URL is forwarded to crawler-mcp-server command queue AND added to TenantDiscovery.exploredBranches.

---

## Task T-5: BFS Engine Tests

### Files to Create

| File                                                                   | Purpose                                   |
| ---------------------------------------------------------------------- | ----------------------------------------- |
| `apps/crawler-mcp-server/src/explore/__tests__/url-normalizer.test.ts` | Pure function tests for URL normalization |
| `apps/crawler-mcp-server/src/explore/__tests__/bfs-discovery.test.ts`  | Integration tests for BFS engine          |

### T-5a: URL Normalizer Tests

Parameterized pure-function tests. No mocks needed.

```typescript
// url-normalizer.test.ts

import { describe, it, expect } from 'vitest';
import { normalizeUrl, isSameDomain, extractDomain, urlToLabel } from '../url-normalizer.js';

describe('normalizeUrl', () => {
  // Parameterized test cases
  const cases: Array<[string, string, string]> = [
    // [description, input, expected]
    ['lowercases hostname', 'https://EXAMPLE.COM/Path', 'https://example.com/Path'],
    ['removes fragment', 'https://example.com/page#section', 'https://example.com/page'],
    ['removes trailing slash', 'https://example.com/path/', 'https://example.com/path'],
    ['keeps root slash', 'https://example.com/', 'https://example.com/'],
    ['strips utm_source', 'https://example.com/page?utm_source=google', 'https://example.com/page'],
    ['strips utm_medium', 'https://example.com/page?utm_medium=cpc', 'https://example.com/page'],
    [
      'strips utm_campaign',
      'https://example.com/page?utm_campaign=spring',
      'https://example.com/page',
    ],
    ['strips fbclid', 'https://example.com/page?fbclid=abc123', 'https://example.com/page'],
    ['strips gclid', 'https://example.com/page?gclid=xyz789', 'https://example.com/page'],
    ['strips msclkid', 'https://example.com/page?msclkid=ms123', 'https://example.com/page'],
    [
      'keeps non-tracking params',
      'https://example.com/page?category=printers&page=2',
      'https://example.com/page?category=printers&page=2',
    ],
    [
      'sorts query params',
      'https://example.com/page?z=1&a=2&m=3',
      'https://example.com/page?a=2&m=3&z=1',
    ],
    [
      'strips tracking but keeps others sorted',
      'https://example.com/page?utm_source=x&b=2&a=1',
      'https://example.com/page?a=1&b=2',
    ],
    ['adds https protocol', 'example.com/path', 'https://example.com/path'],
    ['handles http protocol', 'http://example.com/path', 'http://example.com/path'],
    [
      'combined: trailing slash + fragment + tracking',
      'https://EXAMPLE.COM/path/?utm_source=x#top',
      'https://example.com/path',
    ],
    ['passthrough on invalid URL', 'not a url %%%', 'not a url %%%'],
    ['handles empty string', '', ''],
    ['handles URL with port', 'https://example.com:8080/path', 'https://example.com:8080/path'],
    ['handles URL with encoded chars', 'https://example.com/p%61th', 'https://example.com/path'],
  ];

  it.each(cases)('%s', (_desc, input, expected) => {
    expect(normalizeUrl(input)).toBe(expected);
  });

  it('produces identical output for URLs that differ only by tracking params', () => {
    const a = normalizeUrl('https://epson.com/printers?utm_source=google&page=1');
    const b = normalizeUrl('https://epson.com/printers?utm_campaign=spring&page=1');
    expect(a).toBe(b);
  });

  it('produces different output for URLs with different meaningful params', () => {
    const a = normalizeUrl('https://epson.com/printers?page=1');
    const b = normalizeUrl('https://epson.com/printers?page=2');
    expect(a).not.toBe(b);
  });
});

describe('isSameDomain', () => {
  it('returns true for same domain', () => {
    expect(isSameDomain('https://epson.com/printers', 'https://epson.com/scanners')).toBe(true);
  });

  it('returns true regardless of case', () => {
    expect(isSameDomain('https://EPSON.COM/printers', 'https://epson.com/scanners')).toBe(true);
  });

  it('returns false for different domains', () => {
    expect(isSameDomain('https://epson.com/printers', 'https://canon.com/printers')).toBe(false);
  });

  it('returns false for subdomain vs root', () => {
    expect(isSameDomain('https://support.epson.com/page', 'https://epson.com/page')).toBe(false);
  });

  it('returns false for invalid URLs', () => {
    expect(isSameDomain('not-a-url', 'https://epson.com')).toBe(false);
  });
});

describe('extractDomain', () => {
  it('extracts domain from full URL', () => {
    expect(extractDomain('https://www.epson.com/path')).toBe('epson.com');
  });

  it('strips www prefix', () => {
    expect(extractDomain('https://www.example.com')).toBe('example.com');
  });

  it('handles URL without www', () => {
    expect(extractDomain('https://example.com')).toBe('example.com');
  });

  it('handles bare domain input', () => {
    expect(extractDomain('example.com')).toBe('example.com');
  });
});

describe('urlToLabel', () => {
  it('returns last path segment', () => {
    expect(urlToLabel('https://epson.com/Support/Printers/All-In-Ones')).toBe('All-In-Ones');
  });

  it('decodes URI components', () => {
    expect(urlToLabel('https://example.com/path/%E4%B8%AD%E6%96%87')).toContain('中文');
  });

  it('returns "/" for root URL', () => {
    expect(urlToLabel('https://example.com/')).toBe('/');
  });

  it('returns input on invalid URL', () => {
    expect(urlToLabel('not-a-url')).toBe('not-a-url');
  });
});
```

### T-5b: BFS Engine Integration Tests

Tests the BFS engine with real module interactions but mocked Playwright `Page`.
Only Playwright's `Page` is mocked (external dependency) — all internal modules
(nav-extractor, breadcrumb-extractor, etc.) run as-is since they use
`page.evaluate()` which we mock to return controlled data.

**Note:** Per codebase rules, we do NOT mock internal modules (`vi.mock` of relative
imports is forbidden). Instead, we create a mock `Page` object that returns controlled
data from `evaluate()`, `goto()`, etc. This exercises the real module code.

```typescript
// bfs-discovery.test.ts

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import {
  runBfsDiscovery,
  type BfsDiscoveryConfig,
  type BfsProgressEvent,
} from '../bfs-discovery.js';
import type { BrowserPool } from '../../browser/pool.js';

// Create a mock Page that returns controlled data
function createMockPage(
  pageData: Map<string, { links: Array<{ href: string; text: string }>; breadcrumbs?: any }>,
) {
  let currentUrl = '';
  return {
    goto: vi.fn(async (url: string) => {
      currentUrl = url;
    }),
    url: () => currentUrl,
    evaluate: vi.fn(async (script: string) => {
      // Return links for extractPageLinks
      const data = pageData.get(currentUrl);
      if (script.includes('querySelectorAll')) {
        return data?.links || [];
      }
      // Return empty for other evaluations (nav extraction, metrics, etc.)
      return [];
    }),
    waitForTimeout: vi.fn(async () => {}),
    $$eval: vi.fn(async () => []),
    $: vi.fn(async () => null),
    $$: vi.fn(async () => []),
    click: vi.fn(async () => {}),
    locator: vi.fn(() => ({
      click: vi.fn(async () => {}),
      isVisible: vi.fn(async () => false),
    })),
  };
}

function createMockBrowserPool(mockPage: any): BrowserPool {
  return {
    getPage: vi.fn(async () => mockPage),
    closeSession: vi.fn(async () => {}),
    initialize: vi.fn(async () => {}),
  } as unknown as BrowserPool;
}

describe('runBfsDiscovery', () => {
  it('emits phase events in order 0 -> 1a -> 1b -> 2 -> 3', async () => {
    const pageData = new Map([
      ['https://example.com/', { links: [{ href: 'https://example.com/about', text: 'About' }] }],
      [
        'https://example.com/sample',
        { links: [{ href: 'https://example.com/contact', text: 'Contact' }] },
      ],
      ['https://example.com/about', { links: [] }],
      ['https://example.com/contact', { links: [] }],
    ]);
    const mockPage = createMockPage(pageData);
    const pool = createMockBrowserPool(mockPage);

    const events: BfsProgressEvent[] = [];
    const config: BfsDiscoveryConfig = {
      discoveryId: 'test-1',
      primaryUrl: 'https://example.com/',
      sampleUrls: ['https://example.com/sample'],
      maxDepth: 8,
      pageTimeout: 5000,
      maxAllLinks: 1000,
    };

    await runBfsDiscovery(
      config,
      pool,
      (e) => events.push(e),
      () => false,
    );

    const phaseEvents = events.filter((e) => e.type === 'phase');
    const phases = phaseEvents.map((e) => (e as any).phase);
    expect(phases).toEqual([0, '1a', '1b', 2, 3]);
  });

  it('stops when shouldStop returns true', async () => {
    const pageData = new Map([['https://example.com/', { links: [] }]]);
    const mockPage = createMockPage(pageData);
    const pool = createMockBrowserPool(mockPage);

    const events: BfsProgressEvent[] = [];
    let stopAfterPhase0 = false;

    await runBfsDiscovery(
      {
        discoveryId: 'test-2',
        primaryUrl: 'https://example.com/',
        sampleUrls: [],
        maxDepth: 8,
        pageTimeout: 5000,
        maxAllLinks: 1000,
      },
      pool,
      (e) => {
        events.push(e);
        if (e.type === 'phase' && (e as any).phase === '1a') stopAfterPhase0 = true;
      },
      () => stopAfterPhase0,
    );

    const result = events.find((e) => e.type === 'complete') as any;
    expect(result?.stoppedBy).toBe('user-stop');
  });

  it('closes browser session in finally block', async () => {
    const pageData = new Map([['https://example.com/', { links: [] }]]);
    const mockPage = createMockPage(pageData);
    const pool = createMockBrowserPool(mockPage);

    await runBfsDiscovery(
      {
        discoveryId: 'test-3',
        primaryUrl: 'https://example.com/',
        sampleUrls: [],
        maxDepth: 8,
        pageTimeout: 5000,
        maxAllLinks: 1000,
      },
      pool,
      () => {},
      () => false,
    );

    expect(pool.closeSession).toHaveBeenCalledWith('bfs-test-3');
  });

  it('caps URLs at maxAllLinks', async () => {
    // Create a page that returns 100 links — with maxAllLinks=50, should cap
    const links = Array.from({ length: 100 }, (_, i) => ({
      href: `https://example.com/page-${i}`,
      text: `Page ${i}`,
    }));
    const pageData = new Map([['https://example.com/', { links }]]);
    const mockPage = createMockPage(pageData);
    const pool = createMockBrowserPool(mockPage);

    const events: BfsProgressEvent[] = [];
    await runBfsDiscovery(
      {
        discoveryId: 'test-4',
        primaryUrl: 'https://example.com/',
        sampleUrls: [],
        maxDepth: 8,
        pageTimeout: 5000,
        maxAllLinks: 50,
      },
      pool,
      (e) => events.push(e),
      () => false,
    );

    const result = events.find((e) => e.type === 'complete') as any;
    expect(result?.totalUrls).toBeLessThanOrEqual(50);
  });
});
```

### Subtasks (execution order)

1. **ST-5.1**: Create `url-normalizer.test.ts` with all parameterized cases.
2. **ST-5.2**: Run `pnpm test --filter=crawler-mcp-server -- url-normalizer` and verify all pass.
3. **ST-5.3**: Create `bfs-discovery.test.ts` with integration tests.
4. **ST-5.4**: Run `pnpm test --filter=crawler-mcp-server -- bfs-discovery` and verify all pass.

### Acceptance Criteria

- AC-1: Given `url-normalizer.test.ts` runs, When all 20+ test cases execute, Then all pass.
- AC-2: Given `bfs-discovery.test.ts` runs, When phase ordering test executes, Then phases appear in order 0 -> 1a -> 1b -> 2 -> 3.
- AC-3: Given the stop-signal test, When `shouldStop` returns true, Then `stoppedBy` is `'user-stop'`.
- AC-4: Given the URL cap test, When `maxAllLinks=50` and 100 links are found, Then total URLs is <= 50.
- AC-5: Given the cleanup test, When the engine completes, Then `browserPool.closeSession` was called.

---

## Cross-Task Dependencies & Execution Order

```
Wave 0: T-0 (delete old code)            — can start immediately
Wave 1: T-1 (models) + T-2 (engine)      — parallel, independent
Wave 2: T-3 (REST endpoint) + T-5 (tests) — both need T-2
Wave 3: T-4 (API routes)                  — needs T-1 + T-3
```

## Known Gaps (deferred to Build 2/3)

These are intentional omissions in Build 1, documented to prevent re-flagging:

| Gap                                     | What                                                                                                                                | Why Deferred                                                                                                                                   | Build              |
| --------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------- | ------------------ |
| `siteProfile` never populated by BFS    | `ISiteProfile` fields (`platform`, `jsRequired`, `estimatedPageCount`) remain at defaults                                           | Site profiling is done by `depth-prober.ts` during State 1→2 transition, not by BFS discovery. Separate concerns.                              | N/A (depth-prober) |
| `activeDiscoveries` is in-memory        | Single-instance idempotency guard — doesn't survive pod restarts                                                                    | Acceptable for Build 1 (single-instance). Build 3 can add Redis-backed tracking.                                                               | Build 3            |
| No concurrent-run protection per domain | Two tenants can run BFS on the same domain simultaneously                                                                           | Would need a distributed lock (Redis `SET NX PX`). Build 1 scope is single-tenant testing.                                                     | Build 3            |
| `progress.ts` not modified              | BFS uses separate SSE transport (crawler-mcp → search-ai proxy) instead of existing WebSocket/Redis pub-sub progress infrastructure | Simpler architecture for Build 1. Build 2 decides frontend transport. Implementation plan updated to reflect this.                             | Build 2            |
| Heading-grouped nav patterns            | Nav extractor only handles `<ul>/<li>` patterns, not `<div>/<h3>/<a>`                                                               | Nav-extractor is reused as-is (HLD: reuse existing modules). Missing nav items don't break discovery. Algorithm spec updated to say Build 2/3. | Build 2/3          |

### Resolved in This LLD (previously listed as gaps)

| Former Gap                        | Resolution                                                                                                                                                                                                                                                         |
| --------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `renderMethod` always `'unknown'` | **Fixed**: New `detectRenderMethod(page)` function added to `visitPage` helper. Uses DOM signals (JS framework markers, noscript tags, SPA shell detection) to classify each visited page as `'http'` or `'browser'`.                                              |
| No crash-resilient persistence    | **Fixed**: Tier 2 auto-save every 30s persists accumulated visited pages to SiteDiscovery. If connection drops before `persistFinalResult`, approximate state survives.                                                                                            |
| Bridge pages not handled          | **Fixed**: Design note added to Phase 3 explaining that domain-only filtering already discovers cross-prefix URLs. Phase 3 iteration order changed to sort by depth (shallowest first) to give cross-prefix hub pages a better chance before yield tracking stops. |

## Constants Reference (tuned values carried forward)

| Constant                       | Value | Source                       |
| ------------------------------ | ----- | ---------------------------- |
| `PROGRESS_THROTTLE_MS`         | 300   | Implementation plan          |
| `DEFAULT_MAX_DEPTH`            | 8     | Algorithm spec               |
| `DEFAULT_PAGE_TIMEOUT`         | 15000 | Implementation plan          |
| `MAX_ALL_LINKS`                | 50000 | depth-prober.ts:70           |
| `MAX_EXPLORE_ALL_URLS`         | 20    | depth-prober.ts:67           |
| `PEAK_YIELD_THRESHOLD`         | 0.05  | yield-tracker.ts:39          |
| `CONSECUTIVE_LOW_YIELD_LIMIT`  | 3     | yield-tracker.ts:42          |
| `MIN_PAGES_BEFORE_YIELD_CHECK` | 3     | yield-tracker.ts:45          |
| `ABSOLUTE_LOW_YIELD`           | 1     | yield-tracker.ts:48          |
| `PERSIST_BATCH_SIZE`           | 10    | New (batched MongoDB writes) |
| `PERSIST_INTERVAL_MS`          | 5000  | New (max age before flush)   |
| `AUTO_SAVE_INTERVAL_MS`        | 30000 | Implementation plan (P12)    |
| `MAX_QUEUED_COMMANDS`          | 50    | command-queue.ts:29          |

## Files Summary

| Task      | Create                 | Modify                    | Delete |
| --------- | ---------------------- | ------------------------- | ------ |
| T-0       | 0                      | 1 (server.ts)             | 4      |
| T-1       | 2 (models)             | 2 (index.ts, db/index.ts) | 0      |
| T-2       | 2 (normalizer, engine) | 0                         | 0      |
| T-3       | 0                      | 1 (server.ts)             | 0      |
| T-4       | 1 (discovery.ts)       | 1 (server.ts)             | 0      |
| T-5       | 2 (test files)         | 0                         | 0      |
| **Total** | **7**                  | **5**                     | **4**  |

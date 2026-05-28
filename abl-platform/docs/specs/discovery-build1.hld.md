# Discovery Build 1: Engine + Wiring — High-Level Design

## What

Build the backend foundation for the new BFS discovery engine. This replaces the
current in-memory, single-process discovery system with a structured BFS engine
backed by MongoDB persistence and proper SSE streaming. The engine reverse-engineers
a website's link structure from seed URLs using breadcrumb-guided climbing, depth-1
BFS expansion, and diminishing-returns stopping — all feeding a live-growing tree.

**Scope**: BFS engine, storage models (SiteDiscovery + TenantDiscovery), API routes,
SSE progress streaming. Backend only — no UI changes in this build.

**Approach**: Delete old discovery code first, then build fresh. Reuse existing
Playwright-based modules (nav-extractor, breadcrumb-extractor, navigation-explorer,
page-classifier, yield-tracker, api-interceptor, command-queue) as-is — they are
well-tested patterns. Build the new orchestrator and wiring from scratch.

## Architecture Approach

### Packages that Change

| Package                   | What Changes                                                                                                                                                                                                                                                                     |
| ------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `apps/crawler-mcp-server` | New `bfs-discovery.ts` engine + `url-normalizer.ts` utility. Delete `discover-crawler.ts` (replaced). Wire new REST endpoint in `server.ts`.                                                                                                                                     |
| `apps/search-ai`          | New `site-discovery.model.ts` + `tenant-discovery.model.ts` in `packages/database`. New `discovery.ts` routes. Delete `crawl-discover.ts` routes (replaced). Delete `crawl-browser-discover.ts` proxy (replaced). Register models in `db/index.ts`. Mount routes in `server.ts`. |
| `packages/database`       | New model files + barrel exports                                                                                                                                                                                                                                                 |

### What to Delete (before building)

These files are the old discovery system. They use in-memory state, have no persistence,
and implement a different algorithm. Delete them to start clean.

**crawler-mcp-server:**
| File | Lines | Why Delete |
|---|---|---|
| `src/explore/discover-crawler.ts` | 365 | HTTP recursive discovery — replaced by BFS engine |

**search-ai:**
| File | Lines | Why Delete |
|---|---|---|
| `src/routes/crawl-discover.ts` | 908 | Old discovery routes with in-memory state — replaced by new discovery.ts |
| `src/routes/crawl-browser-discover.ts` | ~600 | SSE proxy with in-memory state — replaced by direct BFS streaming |
| `src/services/crawler/discover-crawler.ts` | ~365 | HTTP recursive crawl service — replaced by BFS engine |
| `src/services/crawler/priority-frontier.ts` | ~200 | Priority URL queue — BFS engine has its own traversal |

**Note:** `depth-prober.ts` is NOT deleted — it remains as the existing profiling/exploration
tool. The BFS engine is a separate new module that coexists with it during Build 1,
then Build 2 wires the UI to use BFS for discovery mode.

### Data Flow

```
Studio Frontend (Build 2)
         │
         ▼
┌─────────────────────────────────────────────────────┐
│  search-ai (port 3005)                              │
│                                                      │
│  POST /api/crawl/discovery/start                     │
│    → Validate seeds (nav sections + target URLs)     │
│    → Create/update SiteDiscovery doc                 │
│    → Create TenantDiscovery doc                      │
│    → Forward to crawler-mcp-server                   │
│    → Return discoveryId + SSE stream URL             │
│                                                      │
│  GET /api/crawl/discovery/:id/stream (SSE)           │
│    → Proxy SSE from crawler-mcp-server               │
│    → Persist discovered URLs to SiteDiscovery        │
│    → Broadcast to connected SSE clients              │
│                                                      │
│  POST /api/crawl/discovery/:id/discover-more         │
│    → Forward to crawler-mcp-server command queue      │
│                                                      │
│  POST /api/crawl/discovery/:id/stop                  │
│    → Forward stop command                             │
│    → Persist partial results to SiteDiscovery         │
│                                                      │
│  GET /api/crawl/discovery/:id/tree                   │
│    → Read SiteDiscovery + TenantDiscovery             │
│    → Merge and return tree                            │
│                                                      │
│  POST /api/crawl/discovery/:id/select                │
│    → Save selections to TenantDiscovery               │
│                                                      │
│  GET /api/crawl/discovery/domain/:domain             │
│    → Return generic SiteDiscovery for reuse           │
│                                                      │
└─────────────────────┬───────────────────────────────┘
                      │ HTTP POST + SSE stream
                      ▼
┌─────────────────────────────────────────────────────┐
│  crawler-mcp-server (port 3100)                     │
│                                                      │
│  POST /api/bfs-discover                              │
│    → Create BrowserPool session                      │
│    → Run BFS phases: 0→1a→1b→2→3                    │
│    → Stream SSE progress events                      │
│    → Poll command queue between page visits           │
│    → Return complete result on finish                │
│                                                      │
│  POST /api/bfs-discover/:id/command                  │
│    → Enqueue intervention (discover-more, stop, etc) │
│                                                      │
│  Reuses: nav-extractor, breadcrumb-extractor,        │
│  navigation-explorer, page-classifier, yield-tracker,│
│  api-interceptor, command-queue, BrowserPool          │
│                                                      │
└─────────────────────────────────────────────────────┘
                      │
                      ▼
┌─────────────────────────────────────────────────────┐
│  MongoDB                                             │
│                                                      │
│  site_discoveries (generic, per domain)              │
│    → navStructure, discoveredUrls, treeHierarchy,    │
│      siteProfile, sitemapUrls, breadcrumbChains      │
│                                                      │
│  tenant_discoveries (per tenant+domain+source)       │
│    → tenantId, exploredBranches, selectedUrls,       │
│      selectionPatterns, seedsUsed, crawlConfig       │
│                                                      │
└─────────────────────────────────────────────────────┘
```

### Key Integration Points

1. **crawler-mcp-server → search-ai**: HTTP POST with SSE streaming response (existing pattern from `depth-prober` → `crawl-browser-discover`)
2. **search-ai → MongoDB**: New models via ModelRegistry (`getModel`/`getLazyModel`)
3. **SSE auth**: EventSource cannot send headers — use `?token=` query param (existing pattern)
4. **URL normalization**: Single `normalizeUrl()` function shared between BFS engine and routes — resolves current inconsistency between two different implementations
5. **SSRF protection**: Validate URLs in search-ai routes before forwarding to crawler-mcp-server (existing pattern in `crawl-browser-discover.ts`)

## Decisions & Tradeoffs

### D-1: Delete old code first, build fresh

**Chose**: Delete `crawl-discover.ts`, `crawl-browser-discover.ts`, `discover-crawler.ts`, `priority-frontier.ts` before building.
**Over**: Patching existing code or building alongside.
**Because**: Incremental patching kept revealing gaps (user feedback). Old code uses in-memory state, different algorithm, different event shapes. Clean slate with learnings carried forward.

### D-2: MongoDB persistence vs in-memory state

**Chose**: MongoDB models (SiteDiscovery + TenantDiscovery) for discovery state.
**Over**: In-memory Maps with TTL (current pattern), Redis hashes.
**Because**: Discovery data is long-lived (generic layer reused across tenants), survives pod restarts, enables the dual-layer storage design. In-memory Maps are documented as single-instance debt. Redis is too transient for site-level discovery data.

### D-3: Generic + Tenant dual-layer storage

**Chose**: SiteDiscovery (per domain, no tenantId) + TenantDiscovery (per tenant+domain+source).
**Over**: Single model with tenantId on everything.
**Because**: Discovery metadata (nav structure, URL tree, classifications) is public website data, not tenant-private. Sharing enables "Tenant C sees what Tenant A and B already discovered." Tenant layer stores selections, credentials, config — proper isolation.

### D-4: BFS engine in crawler-mcp-server, persistence in search-ai

**Chose**: Engine runs in crawler-mcp-server (has Playwright), search-ai handles persistence + auth.
**Over**: Moving everything to one service.
**Because**: Follows existing architecture — crawler-mcp-server owns browser automation, search-ai owns data + auth. Cross-process via HTTP + SSE (proven pattern). No auth in crawler-mcp-server (by design).

### D-5: Single canonical normalizeUrl function

**Chose**: New `url-normalizer.ts` in crawler-mcp-server with consistent behavior.
**Over**: Using either existing implementation (both have gaps).
**Because**: Two incompatible `normalizeUrl` exist — `pattern-matcher.ts` strips tracking params but returns `string|null`, `depth-prober.ts` sorts params but doesn't strip tracking. Deduplication breaks if normalization differs. One function, used everywhere.

### D-6: Keep depth-prober.ts intact

**Chose**: Keep `depth-prober.ts` as-is — BFS engine is a separate new module.
**Over**: Modifying depth-prober to support BFS mode.
**Because**: depth-prober serves site profiling (State 1→2 transition). BFS engine serves discovery (State 2c). Different purposes, different lifecycles. Modifying a 1,700-line working module risks regressions.

## Task Decomposition

| Task | Package(s)                    | Independent?  | Est. Files | Description                                                                                                                                                                   |
| ---- | ----------------------------- | ------------- | ---------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| T-0  | search-ai, crawler-mcp-server | Yes           | 5-6 delete | **Delete old discovery code** — remove crawl-discover.ts, crawl-browser-discover.ts, discover-crawler.ts, priority-frontier.ts, update server.ts route mounts, update imports |
| T-1  | packages/database, search-ai  | Yes           | 4-5        | **Storage models** — SiteDiscovery + TenantDiscovery Mongoose models, barrel exports, ModelRegistry registration                                                              |
| T-2  | crawler-mcp-server            | Yes           | 3-4        | **URL normalizer + BFS engine** — url-normalizer.ts (shared), bfs-discovery.ts (core orchestrator using existing modules)                                                     |
| T-3  | crawler-mcp-server            | No (T-2)      | 1-2        | **BFS REST endpoint** — New `/api/bfs-discover` + `/api/bfs-discover/:id/command` routes in server.ts with SSE streaming                                                      |
| T-4  | search-ai                     | No (T-1, T-3) | 3-4        | **Discovery API routes** — New discovery.ts route file with all 7 endpoints, SSE proxy, SSRF validation, model persistence                                                    |
| T-5  | crawler-mcp-server            | No (T-2)      | 2-3        | **BFS engine integration tests** — Pure function tests for URL normalizer, integration tests for BFS phases with mocked Playwright                                            |

### Dependency Graph

```
T-0 (delete old) ──────────────────────────────►  can start immediately
T-1 (storage models) ─────────────────────────►  can start immediately
T-2 (normalizer + BFS engine) ────────────────►  can start immediately
T-3 (BFS REST endpoint) ─────────────────────►  needs T-2
T-4 (discovery API routes) ──────────────────►  needs T-1 + T-3
T-5 (tests) ─────────────────────────────────►  needs T-2

Wave 0: T-0 (delete)
Wave 1: T-1, T-2 (parallel)
Wave 2: T-3, T-5 (parallel, both need T-2)
Wave 3: T-4 (needs T-1 + T-3)
```

## Out of Scope

- **Frontend UI** — Build 2 (ModeSelection, SeedSelection, LiveDiscoveryTree, etc.)
- **Direct URLs mode** — Build 3
- **Quick-select patterns** — Build 3
- **Recrawl / Rediscover** — Build 3
- **E2E tests** — Build 3 (integration tests only in Build 1)
- **Old frontend components** (ExplorePanel, DiscoveryPanel, BrowserDiscoveryInline, etc.) — deleted in Build 2 when replaced
- **depth-prober.ts changes** — kept as-is, not modified
- **Crawlee evaluation** — separate investigation, not blocking Build 1

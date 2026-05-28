# Draft Elimination — High-Level Design

## What

Eliminate the `CrawlDraft` model entirely so that `SearchSource` becomes the single entity from the moment a user enters a URL. Small, permanent config (profile, sections, settings, auth) lives inline on the source via a typed `crawlConfig` subdocument. Large transient wizard state (discovery tree, discovered URLs, nav structure) lives in a separate `SourceConfigState` collection. Section URLs continue in a separate bucket collection (`SourceUrlBucket`). This fixes three confirmed data loss bugs (auth config, crawl config, groupStrategies never persisted), eliminates the two-entity problem (2 sources + 1 draft per domain), removes ~1,800 lines of dead-weight code with zero test coverage, and unblocks the 3-Step Crawl Flow (Phase 2) and Unified Source Page (Phase 3).

**Scope:** Web crawl sources only. Connector, file upload, database, and API source flows are unchanged.

---

## Dual-Database Architecture

search-ai uses two separate MongoDB connections:

| Database       | Connection     | Mongoose Affinity   | Purpose                                 |
| -------------- | -------------- | ------------------- | --------------------------------------- |
| `abl_platform` | `platformConn` | `'platform'`        | Tenant, user, project, KB, draft models |
| `search_ai`    | `contentConn`  | `'searchaicontent'` | Sources, documents, chunks, crawl jobs  |

**Current draft models (cross-database!):**

- `CrawlDraft` → `platform` (abl_platform) — registered in `db/index.ts:217`
- `CrawlDraftUrlBucket` → `searchaicontent` (search_ai) — registered in `db/index.ts:222`
- `SearchSource` → `searchaicontent` (search_ai) — self-registered in model file

**New models database affinity:**

| New Model           | Database          | Reason                                                   |
| ------------------- | ----------------- | -------------------------------------------------------- |
| `SourceConfigState` | `searchaicontent` | Co-locate with `SearchSource` for cascade delete + joins |
| `SourceUrlBucket`   | `searchaicontent` | Same as current `CrawlDraftUrlBucket` — URL data         |

Both new models go on `searchaicontent` alongside `SearchSource`. This fixes the current anti-pattern where `CrawlDraft` (platform) references `CrawlDraftUrlBucket` (content) across databases with no transaction support.

---

## Schema Definitions

### SearchSource.crawlConfig (inline subdocument, ~16KB max)

Added to `SearchSource` for `sourceType: 'web'` only. `null` for all other source types.

```typescript
// packages/database/src/models/search-source.model.ts — new subdocument
crawlConfig: {
  // Wizard position (replaces CrawlDraft.flowState)
  wizardStep: 'profiling' | 'sections_ready' | 'configured' | null,

  // Strategy (replaces CrawlDraft.strategy)
  strategy: 'guided-discovery' | 'crawl-sitemap' | 'direct-urls' | null,

  // Site profile (replaces CrawlDraft.profile) — ~300 bytes
  profile: {
    domain: string,
    siteType: string | null,
    hasSitemap: boolean,
    sitemapPageCount: number | null,
    jsRequired: boolean,
    estimatedSize: number | null,
    avgResponseTime: number | null,
    platform: string | null,
  } | null,

  // Sections (replaces CrawlDraft.sections) — ~15KB for 50 sections
  sections: [{
    sectionId: string,
    pattern: string,
    name: string,
    source: 'sitemap' | 'explored' | 'auto' | 'direct',
    depth: number,
    pageCount: number,
    included: boolean,
    estimatedTime: number | null,
    warnings: string[],
    strategy: 'http' | 'browser',
    sitemapFile: string | null,
    sitemapOrigin: string | null,
  }] | null,

  // Crawl settings (NEW — FIXES data loss bug) — ~200 bytes
  settings: {
    scope: 'limited' | 'full',
    rendering: 'http' | 'browser' | 'hybrid',
    maxPages: number,           // max 100,000
    maxDepth: number,           // max 20
    requestDelay: number,       // 200-30,000 ms
    cleanup: 'aggressive' | 'standard' | 'none',
    respectRobotsTxt: boolean,
    deduplicate: boolean,
    cookieConsent: boolean,
    reuseHandlers: boolean,
  } | null,

  // Auth config (NEW — FIXES data loss bug) — ~200 bytes
  auth: {
    method: 'none' | 'basic' | 'bearer' | 'headers' | 'cookies',
    basicUsername: string | null,
    basicPassword: string | null,
    bearerToken: string | null,
    customHeaders: Array<{ key: string; value: string }> | null,
    cookieString: string | null,
  } | null,

  // Per-section rendering recommendations (NEW — FIXES data loss bug)
  groupStrategies: [{
    pattern: string,
    method: 'http' | 'playwright',
    reason: string | null,
  }] | null,

  // OCC version (replaces CrawlDraft.version)
  configVersion: number,          // default 1, incremented on each PATCH

  // Link to crawl job after submission
  crawlJobId: string | null,

  // TTL for abandoned configuring sources — set 30 days from creation, cleared on crawl start
  configExpiresAt: Date | null,
}
```

**Indexes on SearchSource:**

- `status: 'configuring'` queries use `{ indexId: 1, status: 1 }` existing index
- **NEW TTL index:** `{ 'crawlConfig.configExpiresAt': 1 }` with `expireAfterSeconds: 0` — auto-deletes abandoned configuring sources after 30 days

### SourceConfigState (separate collection — transient wizard blob)

```typescript
// packages/database/src/models/source-config-state.model.ts — NEW
interface ISourceConfigState {
  _id: string; // uuidv7
  tenantId: string; // required
  sourceId: string; // FK to SearchSource._id
  projectId: string; // for cross-user active queries

  // Discovery state — up to 5MB (Zod-capped, uses .passthrough())
  discoveryState: {
    tree: any; // DiscoveryTreeNode[] — recursive, up to 50K nodes
    discoveredUrls: any; // Array<{href, text, confidence, depth}> — up to 50K
    objectives: any; // DiscoveryObjective[]
    navStructure: any; // NavExtractionResult | null
    iterations: any; // DiscoveryIteration[] — max 100
    coverage: any; // CoverageAnalysis | null
    scope?: any; // DiscoveryScope
    _treeVersion?: number;
    savedAt: number; // epoch ms
  } | null;

  // Discovery engine status
  discoveryStatus: 'idle' | 'running' | 'complete' | 'stopped';

  createdBy: string; // user who owns this wizard session

  configExpiresAt: Date | null; // copied from parent source — TTL auto-cleanup
  createdAt: Date; // timestamps
  updatedAt: Date;
}

// Collection: source_config_states
// Database: searchaicontent (search_ai)
// Plugins: tenantIsolationPlugin

// Indexes:
// 1. { sourceId: 1 } — unique — 1:1 relationship, fast lookup + cascade
// 2. { tenantId: 1, projectId: 1, discoveryStatus: 1 } — active discoveries cross-user
// 3. { configExpiresAt: 1, expireAfterSeconds: 0 } — TTL: auto-delete when parent source expires
```

**TTL consistency:** All three collections (SearchSource, SourceConfigState, SourceUrlBucket) use the same `configExpiresAt` timestamp (copied from the parent source at creation). This guarantees they expire together — no orphans from independent TTL timers. Cleared when crawl starts (data also explicitly deleted by worker).

### SourceUrlBucket (separate collection — chunked URL storage)

```typescript
// packages/database/src/models/source-url-bucket.model.ts — NEW (re-keyed from CrawlDraftUrlBucket)
interface ISourceUrlBucket {
  _id: string; // uuidv7
  tenantId: string; // required
  sourceId: string; // FK to SearchSource._id (was: draftId)
  sectionId: string; // which section (sec-0, sec-1, sec-ungrouped, sec-direct-*)
  bucketIndex: number; // 0, 1, 2... for pagination
  urls: IBucketUrl[]; // max URL_BUCKET_SIZE (500) per bucket
  urlCount: number; // denormalized count
  configExpiresAt: Date | null; // copied from parent source — TTL auto-cleanup
  createdAt: Date;
}

interface IBucketUrl {
  url: string;
  title: string | null;
  score: number | null;
  depth: number;
}

// Collection: source_url_buckets
// Database: searchaicontent (search_ai)
// Plugins: tenantIsolationPlugin
// Constant: URL_BUCKET_SIZE = 500

// Indexes:
// 1. { tenantId: 1, sourceId: 1, sectionId: 1, bucketIndex: 1 } — unique — primary lookup
// 2. { sourceId: 1 } — cascade delete
// 3. { configExpiresAt: 1, expireAfterSeconds: 0 } — TTL: auto-delete when parent source expires
```

**TTL safety for URL buckets:** `configExpiresAt` is copied from the parent source at bucket creation time. If the parent source is TTL-deleted (abandoned configuring source), the URL buckets auto-delete at the same time — no orphans. Cleared when crawl starts (buckets are also explicitly deleted by the worker).

### SourceStatus Enum Change

```typescript
// packages/search-ai-sdk/src/constants.ts
export const SourceStatus = {
  CONFIGURING: 'configuring', // NEW — replaces undeclared 'draft'
  PENDING: 'pending',
  SYNCING: 'syncing',
  ACTIVE: 'active',
  ERROR: 'error',
  DISABLED: 'disabled',
} as const;
```

---

## Complete Reference Inventory — What Changes Where

### Layer 1: Models (packages/database)

| File                                     | Action     | Lines   | Change                                                                                                                                                         |
| ---------------------------------------- | ---------- | ------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `models/crawl-draft.model.ts`            | **DELETE** | 1-193   | Entire file. Types: `ICrawlDraft`, `ICrawlDraftSection`, `ICrawlDraftProfile`, `ICrawlDraftConfig`, `CrawlDraftFlowState`                                      |
| `models/crawl-draft-url-bucket.model.ts` | **DELETE** | 1-91    | Entire file. Types: `ICrawlDraftUrlBucket`, `IBucketUrl`, `URL_BUCKET_SIZE`                                                                                    |
| `models/search-source.model.ts`          | **MODIFY** | schema  | Add `crawlConfig` subdocument schema. No new indexes needed.                                                                                                   |
| `models/source-config-state.model.ts`    | **CREATE** | —       | New model: `ISourceConfigState`. Self-registers as `searchaicontent`.                                                                                          |
| `models/source-url-bucket.model.ts`      | **CREATE** | —       | New model: `ISourceUrlBucket`, `IBucketUrl`, `URL_BUCKET_SIZE`. Self-registers as `searchaicontent`.                                                           |
| `models/index.ts`                        | **MODIFY** | 719-731 | Remove CrawlDraft + CrawlDraftUrlBucket exports. Add SourceConfigState + SourceUrlBucket exports. Re-export `IBucketUrl`, `URL_BUCKET_SIZE` from new location. |
| `index.ts` (barrel)                      | **MODIFY** | 315-328 | Same re-export changes as models/index.ts                                                                                                                      |

### Layer 2: Model Registration (apps/search-ai)

| File          | Action     | Lines   | Change                                                                                                                                                                                                                                                                                                        |
| ------------- | ---------- | ------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `db/index.ts` | **MODIFY** | 217-228 | Remove `CrawlDraft` (platform) + `CrawlDraftUrlBucket` (searchaicontent) registrations. Add `SourceConfigState` (searchaicontent) + `SourceUrlBucket` (searchaicontent). Note: if new models self-register (like SearchSource does), no manual registration needed — just ensure import triggers side-effect. |

### Layer 3: Backend Routes (apps/search-ai)

| File                     | Action     | Lines                                                    | Change                                                                                                                                             |
| ------------------------ | ---------- | -------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------- |
| `routes/crawl-drafts.ts` | **DELETE** | 1-887                                                    | Entire file (7 endpoints, 887 lines). All functionality moves to `sources.ts`.                                                                     |
| `server.ts`              | **MODIFY** | 36, 263                                                  | Remove `import crawlDraftsRouter` and `app.use('/api/crawl', crawlDraftsRouter)`                                                                   |
| `routes/sources.ts`      | **MODIFY** | add endpoints                                            | Add 5 new endpoints (see API section below). Enhance existing POST for web source creation.                                                        |
| `routes/crawl.ts`        | **MODIFY** | 304, 357-358, 830, 1654-1655, 1714-1823, 1857, 1996-2004 | Replace `draftId` → `sourceId` in batch route. Rewrite `storeBucketUrlsForGroups` to use `SourceUrlBucket`. Update `clusterUrlsSchema` field name. |

### Layer 4: Worker (apps/search-ai)

| File                           | Action     | Lines            | Change                                                                                                                                                                                                                                                 |
| ------------------------------ | ---------- | ---------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `workers/bulk-crawl-worker.ts` | **MODIFY** | 24, 339, 703-714 | Remove `ICrawlDraft` import. Remove `draftId` destructure from job data. Remove draft `flowState: 'completed'` update. Add: delete `SourceConfigState` + `SourceUrlBucket` for sourceId on crawl start. Set `crawlConfig.wizardStep = null` on source. |
| `workers/shared.ts`            | **MODIFY** | 644-661          | Remove `draftId?: string` from `BulkCrawlJobData` interface                                                                                                                                                                                            |

### Layer 5: Frontend API Client (apps/studio)

| File           | Action     | Lines    | Change                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                          |
| -------------- | ---------- | -------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `api/crawl.ts` | **MODIFY** | 850-1169 | **Delete 10 functions**: `createCrawlDraft`, `listCrawlDrafts`, `getCrawlDraft`, `updateCrawlDraft`, `deleteCrawlDraft`, `putSectionUrls`, `getSectionUrls`, `getActiveDrafts`, `getDraftStatus`, `checkDomain`. **Delete 8 interfaces**: `CrawlDraftSection`, `CrawlDraftProfile`, `CrawlDraftConfig`, `CrawlDraftFlowState`, `CrawlDraftDiscoveryState`, `CrawlDraft`, `ActiveDraft`, `DraftStatus`, `DomainCheckResult`, `BucketUrl`. **Add new functions**: `updateCrawlConfig(sourceId, indexId, data)`, `getDiscoveryState(sourceId, indexId)`, `updateDiscoveryState(sourceId, indexId, data)`, `putSourceSectionUrls(sourceId, indexId, sectionId, urls)`, `getSourceSectionUrls(sourceId, indexId, sectionId, opts)`. Also update `submitBatchCrawl` to drop `draftId` param. No `checkSourceDomain` — domain uniqueness not enforced. |

### Layer 6: Frontend Stores (apps/studio)

| File                        | Action     | Lines | Change                                                                                       |
| --------------------------- | ---------- | ----- | -------------------------------------------------------------------------------------------- |
| `store/crawl-flow-store.ts` | **MODIFY** | 14-26 | Rename `draftId` → `sourceId`. `open(sourceId?)`, `close()`                                  |
| `store/discovery-store.ts`  | **MODIFY** | 12-67 | Rename all `draftId` → `sourceId` in `BackgroundedDiscovery` interface and all store methods |

### Layer 7: Frontend Components (apps/studio)

| File                                  | Action     | Lines Affected                | Change                                                                                                                                                                                                                                                                                                                                                                                                                                                              |
| ------------------------------------- | ---------- | ----------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `crawl-flow/CrawlFlowV5.tsx`          | **MODIFY** | ~90 references                | Replace all `draftId` state → `sourceId`. Replace `createCrawlDraft` → enhanced `addSource` (POST source with `configuring`). Replace `updateCrawlDraft` → `updateCrawlConfig` + `updateDiscoveryState`. Replace `getCrawlDraft` → `getSource`. Replace `putSectionUrls`/`getSectionUrls` → `putSourceSectionUrls`/`getSourceSectionUrls`. Remove `addSource()` call at submit time (source already exists). Persist auth + crawl config on every save (bug fixes). |
| `crawl-flow/State1UrlEntry.tsx`       | **MODIFY** | 34, 127-172, 233, 479         | Replace `listCrawlDrafts` → list sources with `status=configuring`. Replace `deleteCrawlDraft` → delete source. Replace `flowState` label → `wizardStep` label.                                                                                                                                                                                                                                                                                                     |
| `crawl-flow/State2Analysis.tsx`       | **MODIFY** | 34, 47, 328, 378-405, 454-455 | Replace `updateCrawlDraft` discovery state save → `updateDiscoveryState`. Replace strategy save → `updateCrawlConfig`. Replace `draftId` prop → `sourceId`. Replace `CrawlDraftDiscoveryState` type.                                                                                                                                                                                                                                                                |
| `crawl-flow/State4Crawl.tsx`          | **MODIFY** | 823                           | Remove/update `draftId` reference in progress data                                                                                                                                                                                                                                                                                                                                                                                                                  |
| `crawl-flow/DiscoveryActivityBar.tsx` | **DELETE** | 1-258                         | Entire file. Replaced by configuring source rows in SourcesTable.                                                                                                                                                                                                                                                                                                                                                                                                   |
| `crawl-flow/types.ts`                 | **MODIFY** | 68, 109, 210, 771-789         | Rename `draftId` → `sourceId` in props. Remove `CrawlDraftDiscoveryState` (moved to api/crawl.ts). Rename `BackgroundedDiscovery.draftId` → `sourceId`.                                                                                                                                                                                                                                                                                                             |
| `layout/KBDetailLayout.tsx`           | **MODIFY** | 33, 42                        | Remove `DiscoveryActivityBar` import and render                                                                                                                                                                                                                                                                                                                                                                                                                     |
| `KnowledgeBaseDetailPage.tsx`         | **MODIFY** | 29, 100                       | Rename `crawlFlowDraftId` → `crawlFlowSourceId`. Read from updated store.                                                                                                                                                                                                                                                                                                                                                                                           |
| `pages/KBSourcesPage.tsx`             | **MODIFY** | 38, 73                        | Rename `resumeDraftId` → `resumeSourceId`                                                                                                                                                                                                                                                                                                                                                                                                                           |
| `data/DataSection.tsx`                | **MODIFY** | 74, 180                       | Rename `resumeDraftId` → `resumeSourceId`                                                                                                                                                                                                                                                                                                                                                                                                                           |
| `data/AddSourceButton.tsx`            | **MODIFY** | 39-40, 97, 150-155            | Rename `resumeDraftId` → `resumeSourceId`. Update `openCrawlFlow(sourceId)`.                                                                                                                                                                                                                                                                                                                                                                                        |
| `data/SourcesTable.tsx`               | **MODIFY** | 38, 46, 313-315               | Handle `status === 'configuring'` (new) + `status === 'draft'` (legacy: show "delete and start fresh"). Remove `sourceConfig.draftId` read — click configuring row passes `source._id` directly. Rename `onResumeDraft` → `onResumeSource`.                                                                                                                                                                                                                         |

### Layer 8: SDK Constants

| File                             | Action     | Lines | Change                                             |
| -------------------------------- | ---------- | ----- | -------------------------------------------------- |
| `search-ai-sdk/src/constants.ts` | **MODIFY** | 49-56 | Add `CONFIGURING: 'configuring'` to `SourceStatus` |

**Total: 2 files deleted, 2 files created, ~24 files modified**

---

## New API Surface

### Routes on sources.ts (under `/api/indexes/:indexId/sources`)

| #   | Method | Path                                                   | Replaces                             | Body/Query                                                                                                                                                | Response                              |
| --- | ------ | ------------------------------------------------------ | ------------------------------------ | --------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------- |
| 1   | POST   | `/:indexId/sources`                                    | `POST /drafts` (enhanced)            | `{ name, sourceType: 'web', sourceConfig: { url } }` → creates with `status: 'configuring'`, `crawlConfig: { wizardStep: 'profiling', configVersion: 1 }` | `{ source }`                          |
| 2   | PATCH  | `/:indexId/sources/:sourceId/crawl-config`             | `PATCH /drafts/:id`                  | `{ configVersion, profile?, sections?, settings?, auth?, strategy?, wizardStep?, groupStrategies?, crawlJobId? }` — OCC on configVersion                  | `{ source }`                          |
| 3   | PUT    | `/:indexId/sources/:sourceId/discovery-state`          | Part of `PATCH /drafts/:id`          | `{ discoveryState, discoveryStatus? }` — 5MB Zod cap, .passthrough()                                                                                      | `{ success }`                         |
| 4   | GET    | `/:indexId/sources/:sourceId/discovery-state`          | Part of `GET /drafts/:id`            | —                                                                                                                                                         | `{ discoveryState, discoveryStatus }` |
| 5   | PUT    | `/:indexId/sources/:sourceId/sections/:sectionId/urls` | `PUT /drafts/:id/sections/:sid/urls` | `{ urls: IBucketUrl[] }` (max 10,000)                                                                                                                     | `{ urlCount, buckets }`               |
| 6   | GET    | `/:indexId/sources/:sourceId/sections/:sectionId/urls` | `GET /drafts/:id/sections/:sid/urls` | `?offset=0&limit=100`                                                                                                                                     | `{ urls, total, hasMore }`            |

**No domain-check endpoint.** Users can always create new sources, even for the same domain. Duplicate management is handled by the user via the sources table (visible, deletable). This avoids multi-user conflict resolution complexity and allows legitimate use cases (e.g., different URL paths from the same domain with different settings).

**Ownership guard on write endpoints:**

Endpoints 2, 3, 5 (PATCH/PUT that modify wizard state) check `source.createdBy === req.userId`. Non-owners get `403 Forbidden`. This enforces the read-only behavior for non-owners described in UX spec Journey 6. GET endpoints (4, 6) remain open — any project member can view.

**SourceConfigState creation:** Lazy — created on first `PUT /discovery-state` (endpoint 3), NOT at source creation time. Sitemap-only and direct-URL crawls may never create a `SourceConfigState` row (no discovery phase needed).

**Route ordering on sources.ts** (static before parameterized — Express matches top-down):

```
GET    /:indexId/sources/summary          ← existing (already first)
GET    /:indexId/sources                  ← existing list
POST   /:indexId/sources                  ← existing create (enhanced)
GET    /:indexId/sources/:sourceId        ← existing get
DELETE /:indexId/sources/:sourceId        ← existing delete (enhanced with cascade)
PATCH  /:indexId/sources/:sourceId/crawl-config    ← NEW (createdBy guard)
PUT    /:indexId/sources/:sourceId/discovery-state  ← NEW (createdBy guard, lazy creates SourceConfigState)
GET    /:indexId/sources/:sourceId/discovery-state  ← NEW (read-only, no guard)
PUT    /:indexId/sources/:sourceId/sections/:sectionId/urls  ← NEW (createdBy guard)
GET    /:indexId/sources/:sourceId/sections/:sectionId/urls  ← NEW (read-only, no guard)
```

### Changes to crawl.ts

| #   | Method | Path                      | Change                                                                                                                                                |
| --- | ------ | ------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------- |
| 1   | POST   | `/api/crawl/batch`        | Remove `draftId`. Accept `configuring` or `active` sources. Configuring → pending transition. Active stays active (recrawl). Clear `configExpiresAt`. |
| 2   | POST   | `/api/crawl/cluster-urls` | Rename `draftId` → `sourceId` in schema + `storeBucketUrlsForGroups`. Write to `SourceUrlBucket` instead of `CrawlDraftUrlBucket`.                    |

---

## Flow Diffs: Current → New (All Three Modes)

### Mode 1: Guided Discovery

```
STEP         CURRENT (Draft)                          NEW (Source)                              DIFF
─────────────────────────────────────────────────────────────────────────────────────────────────────────
URL Submit   POST /drafts → creates CrawlDraft       POST /indexes/:id/sources → creates       Replace: draft creation → source creation
             + side-effect SearchSource(draft)        SearchSource(configuring)                  Remove: side-effect source creation
             → draftId returned                       → sourceId returned                        Note: SourceConfigState created lazily
                                                                                                 on first discovery-state PUT, not here

Profile      POST /crawl/profile → stateless          SAME — no change                          No diff
Save         PATCH /drafts/:id {profile}              PATCH /:id/sources/:sid/crawl-config      Replace: draft PATCH → source crawl-config PATCH
                                                      {configVersion, profile}

Cluster      POST /crawl/cluster-urls {draftId}       POST /crawl/cluster-urls {sourceId}       Replace: draftId → sourceId
             → storeBucketUrlsForGroups writes         → storeBucketUrlsForGroups writes         Replace: CrawlDraftUrlBucket → SourceUrlBucket
             to CrawlDraftUrlBucket                    to SourceUrlBucket

Sections     PATCH /drafts/:id {sections,              PATCH /:id/sources/:sid/crawl-config     Replace: draft PATCH → crawl-config PATCH
save         flowState: 'sections_ready'}              {configVersion, sections,
                                                       wizardStep: 'sections_ready'}

Strategy     PATCH /drafts/:id {strategy}              PATCH /:id/sources/:sid/crawl-config     Replace: draft PATCH → crawl-config PATCH
save                                                   {configVersion, strategy}

Discovery    PATCH /drafts/:id {discoveryState}        PUT /:id/sources/:sid/discovery-state    Replace: draft PATCH → dedicated discovery endpoint
auto-save    (5s debounce, inline on draft)            {discoveryState} → writes to             Move: from inline draft field to SourceConfigState
                                                       SourceConfigState collection

Section      PATCH /drafts/:id {sections}              PATCH /:id/sources/:sid/crawl-config     Replace: draft PATCH → crawl-config PATCH
toggle                                                 {configVersion, sections}

Direct       PATCH /drafts/:id {flowState:             PATCH /:id/sources/:sid/crawl-config     Replace: draft PATCH → crawl-config PATCH
crawl        'configured'}                             {configVersion, wizardStep: 'configured',
             → handleStartCrawl                        settings: {...}, auth: {...}}             Add: settings + auth persisted (BUG FIX)
                                                       → handleStartCrawl

Settings     PATCH /drafts/:id {flowState:             PATCH /:id/sources/:sid/crawl-config     Replace: draft PATCH → crawl-config PATCH
path         'configured'}                             {configVersion, wizardStep: 'configured',
             → State3Configure → handleStartCrawl      settings: {...}, auth: {...}}             Add: settings + auth persisted (BUG FIX)
                                                       → State3Configure → handleStartCrawl

URL gather   GET /drafts/:id/sections/:sid/urls        GET /:id/sources/:sid/sections/:sid/urls Replace: draft URL endpoint → source URL endpoint
(submit)     (paginated 100/request from buckets)      (same pagination from SourceUrlBucket)

Create       POST /indexes/:id/sources {name,          SKIP — source already exists              Remove: duplicate source creation
source       sourceType: 'web'} → NEW source

Submit       POST /crawl/batch {draftId, urls, ...}    POST /crawl/batch {urls, ...}            Remove: draftId from payload
             → BullMQ job with draftId                 → BullMQ job without draftId              Status: configuring → pending
                                                       → Source status: configuring → pending

Mark         PATCH /drafts/:id {flowState:             PATCH /:id/sources/:sid/crawl-config     Replace: draft PATCH → crawl-config PATCH
submitted    'submitted', crawlJobId}                  {configVersion, wizardStep: null,          Change: wizardStep → null (not 'submitted')
                                                       crawlJobId}

Worker       CrawlDraft.findOneAndUpdate               DELETE SourceConfigState {sourceId}       Replace: draft update → cleanup transient data
completion   {flowState: 'completed'}                  DELETE SourceUrlBucket {sourceId}
             (best-effort, may fail)                   Source.crawlConfig.wizardStep stays null
```

### Mode 2: Sitemap Crawl

Identical to Mode 1 except:

- User selects `strategy: 'crawl-sitemap'` instead of `'guided-discovery'`
- No discovery tree auto-saves (SourceConfigState may remain empty/minimal)
- Profile's `sitemapDiscovery.allUrls` passed directly to `cluster-urls`
- All other steps identical

### Mode 3: Direct URLs

```
STEP         CURRENT (Draft)                          NEW (Source)                              DIFF
─────────────────────────────────────────────────────────────────────────────────────────────────────────
URL Submit   Same as Mode 1                           Same as Mode 1                           Same

Profile      Same as Mode 1                           Same as Mode 1                           Same

Strategy     PATCH /drafts/:id {strategy:              PATCH /:id/sources/:sid/crawl-config     Replace: draft PATCH → crawl-config PATCH
select       'direct-urls'}                            {configVersion, strategy: 'direct-urls'}

User pastes  React state only — no API call            React state only — no API call            No diff
URLs

Direct       PATCH /drafts/:id {strategy,              PATCH /:id/sources/:sid/crawl-config     Replace: draft PATCH → crawl-config PATCH
crawl        flowState: 'configured',                  {configVersion, strategy,
             sections: [{source: 'direct'}]}           wizardStep: 'configured',
                                                       sections: [{source: 'direct'}],
             PUT /drafts/:id/sections/:sid/urls         settings: {...}, auth: {...}}            Add: settings + auth (BUG FIX)
             → CrawlDraftUrlBucket                     PUT /:id/sources/:sid/sections/:sid/urls
                                                       → SourceUrlBucket                        Replace: draft bucket → source bucket

Submit       Same as Mode 1                           Same as Mode 1 (minus source creation)   Remove: duplicate source creation
```

**Key diff for Direct URLs:** The dual URL storage paths are preserved:

- Sitemap/auto sections: URLs stored server-side by `storeBucketUrlsForGroups()` during `cluster-urls` → writes to `SourceUrlBucket` (was `CrawlDraftUrlBucket`)
- Direct sections: URLs stored by frontend via `putSourceSectionUrls()` → writes to `SourceUrlBucket` (was `putSectionUrls` → `CrawlDraftUrlBucket`)

### Mode 4: Recrawl (Active Source)

```
STEP         CURRENT (Draft)                          NEW (Source)                              DIFF
─────────────────────────────────────────────────────────────────────────────────────────────────────────
Open wizard  User clicks "Recrawl" on active source   Same trigger                              No diff
             → opens empty CrawlFlowV5                → opens CrawlFlowV5 pre-filled from
                                                       source.crawlConfig (settings, auth,
                                                       sections)                                 Add: pre-fill from persisted config

Edit         React state only — no persistence         PATCH /:id/sources/:sid/crawl-config     Add: settings + auth persisted (BUG FIX)
settings     (settings always reset to defaults)       {configVersion, settings, auth}

Submit       POST /crawl/batch {urls, ...}             POST /crawl/batch {urls, ...}            No status transition (stays active)
             → creates NEW source (duplicate!)          → same source, new CrawlJob               Remove: duplicate source creation
             → original source abandoned                → source status stays 'active'

Worker       Same as Mode 1                            SourceConfigState.deleteOne (if exists)   Minimal cleanup — no config state for
cleanup                                                SourceUrlBucket.deleteMany (if exists)     most recrawls (no discovery phase)
```

**Key difference from new crawl:** Source stays `active`. No `configuring → pending` transition. No `configExpiresAt`. Settings pre-filled from `crawlConfig` instead of defaults. This fixes the current bug where recrawl settings always reset.

---

## i18n Keys

11 user-facing strings introduced or changed by this feature. All keys under `studio.json` crawl flow namespace:

| Key                         | Text                                                                     | Context                                |
| --------------------------- | ------------------------------------------------------------------------ | -------------------------------------- |
| `source_status_configuring` | "Configuring"                                                            | Status badge in SourcesTable           |
| `source_configuring_step`   | "Step {step} of 3"                                                       | Detail text for configuring source row |
| `wizard_save_close`         | "Save & Close"                                                           | Close wizard dialog                    |
| `wizard_delete_source`      | "Delete Source"                                                          | Close wizard dialog                    |
| `wizard_resume_discovery`   | "Resume discovery?"                                                      | Resume banner option                   |
| `wizard_start_fresh`        | "Start fresh"                                                            | Resume banner + domain re-entry        |
| `wizard_skip_configure`     | "Skip to configure"                                                      | Resume banner option                   |
| `source_legacy_draft`       | "This source was started with an older version. Delete and start fresh." | Legacy draft-status sources            |
| `wizard_resume`             | "Resume"                                                                 | Actions menu for configuring source    |
| `source_configuring_delete` | "Delete"                                                                 | Actions menu for configuring source    |
| `wizard_recrawl`            | "Recrawl"                                                                | Domain re-entry + active source action |

**Note:** Remove existing draft-specific keys at `studio.json` lines 9051-9064 (`draft_saving`, `draft_saved`, `saved_drafts`, `draft_resume`, etc.) as part of T-8 cleanup.

---

## Type Unification

### CrawlDraftDiscoveryState → SourceDiscoveryState

Two divergent definitions today (`api/crawl.ts:890` and `types.ts:771`). Unified as `SourceDiscoveryState`:

- Use the rich imported types from `types.ts` version (`DiscoveryTreeNode`, `DiscoveryObjective`, etc.)
- Include `scope?: DiscoveryScope` and `_treeVersion?: number` (present in types.ts, missing from api/crawl.ts)
- Single definition in `types.ts`, imported by API client
- Backend Zod schema uses `.passthrough()` (no change — already does)

### CrawlSection vs CrawlDraftSection → unified CrawlSection

Two types with divergent fields:

| Field            | CrawlSection (types.ts)           | CrawlDraftSection (api/crawl.ts) | Unified                             |
| ---------------- | --------------------------------- | -------------------------------- | ----------------------------------- |
| `sectionId`      | optional                          | required                         | required                            |
| `estimatedTime`  | `string`                          | `number`                         | `number` (matches DB)               |
| `source`         | optional                          | required                         | required                            |
| `examples`       | `string[]` (UI-only)              | absent                           | keep (UI enrichment, not persisted) |
| `pages`          | `Array<{url,title}>` (UI-only)    | absent                           | keep (UI enrichment, not persisted) |
| `fileTypeCounts` | `Record<string,number>` (UI-only) | absent                           | keep (UI enrichment, not persisted) |
| `sitemapFile`    | present                           | present                          | keep                                |
| `sitemapOrigin`  | present                           | present                          | keep                                |

Single `CrawlSection` type in `types.ts`. DB schema matches required fields. UI-only fields (`examples`, `pages`, `fileTypeCounts`) are local enrichments not sent to backend.

### CrawlConfig scope enum divergence

- Frontend `CrawlConfig.scope`: `'limited' | 'full' | 'custom'`
- DB `ICrawlDraftConfig.scope`: `'full' | 'selected_sections'`

Unified as: `'limited' | 'full' | 'custom'` (frontend values). Backend Zod validation updated. `'selected_sections'` was a draft-era value not used by the new system.

---

## Decisions & Tradeoffs

### D-1: Typed `crawlConfig` subdocument (not schemaless bag)

**Chose:** Typed Mongoose subdocument with explicit fields on `SearchSource`
**Over:** Using existing `sourceConfig: Schema.Types.Mixed` bag
**Because:** `sourceConfig` has 8 different shapes across source types, no validation, gets stripped on project export/import. A typed subdocument gives us schema validation, IDE autocomplete, and won't break on `toJSON()`. The subdocument only applies to `sourceType: 'web'` sources.

### D-2: Separate `SourceUrlBucket` collection (not inline URLs)

**Chose:** Separate collection with 500 URLs per bucket document
**Over:** Storing URLs inline on the source document
**Because:** Sitemaps routinely hit 50K+ URLs. At ~200 bytes per URL entry, 50K URLs = ~10MB, exceeding the 16MB BSON limit. The existing bucket pattern works well; we just re-key from `draftId → sourceId`.

### D-3: `configuring` as a new SourceStatus enum value

**Chose:** Add `CONFIGURING` to `SourceStatus` in `packages/search-ai-sdk/src/constants.ts`
**Over:** Reusing `pending` with a discriminator field
**Because:** `pending` means "crawl submitted, waiting to start" — semantically different from "user is in the wizard." A declared enum value prevents the current problem where `'draft'` is used undeclared and silently excluded from enum-based queries.

### D-4: No migration — let existing drafts TTL-expire

**Chose:** No data migration for existing `crawl_drafts` documents
**Over:** Writing a migration to convert drafts to configuring sources
**Because:** Drafts have a 30-day TTL (`expiresAt` index). There are few active drafts at any time. The old draft routes are removed, so old drafts simply expire. The old `'draft'`-status sources are harmless (not returned by enum-based queries anyway).

### D-5: Discovery state in separate collection (not inline on source)

**Chose:** Separate `SourceConfigState` collection with `sourceId` FK
**Over:** Storing `discoveryState` inline as `Schema.Types.Mixed` on `crawlConfig`
**Because:** The `discoveryState` blob can reach 5MB (Zod-capped). It contains `discoveredUrls` (up to 50K entries × ~120 bytes = ~6MB uncapped), a recursive `tree` (50K+ nodes × ~150 bytes = ~7.5MB), plus `navStructure`, `coverage`, and `objectives`. SearchSource is permanent and frequently-queried — a 5MB blob would slow list queries and have no TTL safety net. Separate collection keeps source documents ~16KB max while supporting full resume. TTL index on `SourceConfigState` auto-cleans abandoned wizards after 30 days.

### D-6: Backend URL extraction at submit time — deferred

**Chose:** Keep frontend URL extraction for now (paginated `getSectionUrls`)
**Over:** Moving URL extraction to backend
**Because:** The frontend already has this working. Backend optimization (1 DB query vs 500 HTTP calls for 50K URLs) can be done later without schema changes.

### D-7: Configuring sources visible cross-user (read-only)

**Chose:** All project members can see configuring sources in the sources table
**Over:** Creator-only visibility
**Because:** Current activity bar already shows drafts cross-user. Other users see read-only; clicking shows read-only view.

### D-8: Auth credentials — application-layer encryption deferred

**Chose:** Store auth tokens/cookies as plaintext in `crawlConfig.auth` initially
**Over:** Application-layer encryption before storage
**Because:** MongoDB encryption at rest is already configured. App-layer encryption adds complexity. The auth fields don't exist today — storing plaintext is strictly better than not storing.

### D-9: Both new models on `searchaicontent` (not platform)

**Chose:** `SourceConfigState` and `SourceUrlBucket` both on `searchaicontent` (search_ai database)
**Over:** Putting `SourceConfigState` on `platform` (matching current CrawlDraft)
**Because:** SearchSource lives on `searchaicontent`. Co-locating all three related collections on the same database enables cascade-delete queries within one connection (no cross-database coordination). The current anti-pattern of CrawlDraft (platform) + CrawlDraftUrlBucket (searchaicontent) causes orphan cleanup issues when drafts TTL-expire.

---

## Source Status Lifecycle (State Machine)

This section resolves BLOCKER B-1: "Nobody transitions source status." Every transition has a single owner.

```
                           ┌─────────────┐
                           │ configuring │ ← Created by POST /sources (Step 1: URL entry)
                           └──────┬──────┘
                                  │ Batch endpoint: POST /crawl/batch
                                  │ (source.status = 'pending', wizardStep = null)
                                  ▼
                           ┌─────────────┐
                           │   pending   │ ← Crawl submitted, job queued
                           └──────┬──────┘
                                  │ Existing ingestion pipeline:
                                  │ base-sync-coordinator sets 'syncing' on first doc
                                  ▼
                           ┌─────────────┐
                     ┌────►│   active    │ ← Has documents (set by sync coordinator)
                     │     └──────┬──────┘
                     │            │
               success│           │ Recrawl: user opens wizard, edits settings,
                     │            │ submits new crawl → stays active, new CrawlJob created
                     │            │ (batch endpoint accepts 'active' for recrawl)
                     │            ▼
                     │     ┌─────────────┐
                     │     │active+crawl │ ← Display: "Crawling" (derived from active CrawlJob)
                     │     │ (same row)  │   Source status stays 'active' in DB
                     │     └─────────────┘
                     │
                     │     ┌─────────────┐
                     │     │    error     │ ← Sync/ingestion failed
                     └─────┤             │   (set by sync coordinator on fatal failure)
                           └─────────────┘
```

**Status is one-directional** — `active` never goes back to `configuring`. Recrawl keeps the source `active` (it has documents). The "crawling" display state is derived from an active CrawlJob, not a status field.

**Who transitions what:**

| Transition                  | Owner                             | Where in Code                                      |
| --------------------------- | --------------------------------- | -------------------------------------------------- |
| `→ configuring`             | Enhanced `POST /:indexId/sources` | `sources.ts` — new source creation for web type    |
| `configuring → pending`     | `POST /crawl/batch`               | `crawl.ts` — at submit time, before BullMQ enqueue |
| `active → active` (recrawl) | `POST /crawl/batch`               | `crawl.ts` — new CrawlJob, status stays active     |
| `pending → syncing`         | Existing sync coordinator         | `base-sync-coordinator.ts` — existing behavior     |
| `syncing → active`          | Existing sync coordinator         | `base-sync-coordinator.ts` — existing behavior     |
| `syncing → error`           | Existing sync coordinator         | `base-sync-coordinator.ts` — existing behavior     |
| `configuring → (deleted)`   | User clicks Delete                | `DELETE /:indexId/sources/:sourceId`               |
| `configuring → (expired)`   | TTL cleanup (see below)           | `configExpiresAt` TTL index on SearchSource        |

**Note:** `crawling` is NOT a source status — it's a frontend-derived display state from checking whether the source has a non-terminal CrawlJob. This avoids adding another status that the backend would need to set/unset.

### Batch Endpoint Status Transition (B-1 Fix)

The `POST /crawl/batch` endpoint currently creates a new source. In the new system, the source already exists. The batch endpoint must:

1. Accept sources with `status === 'configuring'` (new crawl) OR `status === 'active'` (recrawl)
2. For configuring: update `source.status = 'pending'`, clear `crawlConfig.configExpiresAt`
3. For active: status stays `active` (source already has documents)
4. For both: set `crawlConfig.wizardStep = null`
5. Enqueue BullMQ job (without `draftId`)
6. Reject if status is `pending`, `syncing`, or `error` (crawl already in progress or broken)

### Recrawl Flow (J5) — Active Source Re-crawl

When an active source is recrawled:

1. User clicks "Recrawl" on an active source → wizard opens pre-filled from `crawlConfig` (settings, auth, sections)
2. User adjusts settings → `PATCH /crawl-config` updates `crawlConfig` on the active source (no status change)
3. User clicks "Start Crawl" → `POST /crawl/batch` accepts `active` source
4. Source stays `active` throughout — it still has documents
5. New CrawlJob created, old documents gradually replaced
6. Frontend shows "Crawling" badge (derived from active CrawlJob)
7. No `SourceConfigState` needed for recrawl (no discovery phase)

**Key difference from new crawl:** No `configuring → pending` transition. No `configExpiresAt`. No `SourceConfigState` creation.

### Worker Post-Crawl Actions (B-2 Fix)

The worker currently updates `CrawlDraft.flowState = 'completed'` (best-effort). This is replaced by:

1. `SourceConfigState.deleteOne({ sourceId })` — remove discovery blob (if exists)
2. `SourceUrlBucket.deleteMany({ sourceId })` — remove URL buckets (if exist)
3. Clear `crawlConfig.configExpiresAt` on source (if set) — prevent TTL deletion of now-active source

The worker does NOT manage `pending → active` — that's handled by the existing ingestion/sync pipeline.

**Note:** There is NO `crawlConfig.discoveryState` field on the source schema — discovery state lives entirely in `SourceConfigState` (separate collection, per D-5). The worker deletes the `SourceConfigState` document, not an inline field.

---

## Resume Flow — Field-by-Field Mapping (C-1 Fix)

When a user resumes a configuring source, the wizard reconstructs from `source.crawlConfig` + `SourceConfigState`:

| CrawlDraft Field       | New Location                        | Loaded By                               | Notes                                                                                                     |
| ---------------------- | ----------------------------------- | --------------------------------------- | --------------------------------------------------------------------------------------------------------- |
| `flowState`            | `crawlConfig.wizardStep`            | `GET /sources/:id`                      | Maps: profiling→profiling, sections_ready→sections_ready, configured→configured, submitted/completed→null |
| `profile`              | `crawlConfig.profile`               | `GET /sources/:id`                      | Same structure, inline ~300 bytes                                                                         |
| `sections`             | `crawlConfig.sections`              | `GET /sources/:id`                      | Same structure, inline ~15KB max                                                                          |
| `strategy`             | `crawlConfig.strategy`              | `GET /sources/:id`                      | Same string literal                                                                                       |
| `config`               | `crawlConfig.settings`              | `GET /sources/:id`                      | **NEW** — never persisted before (bug fix)                                                                |
| `discoveryState`       | `SourceConfigState.discoveryState`  | `GET /:id/sources/:sid/discovery-state` | Separate collection, up to 5MB                                                                            |
| `discoveryStatus`      | `SourceConfigState.discoveryStatus` | Same as above                           | Inline on SourceConfigState                                                                               |
| `version`              | `crawlConfig.configVersion`         | `GET /sources/:id`                      | OCC — same semantics                                                                                      |
| `sourceId`             | Source `_id` (IS the source)        | —                                       | No longer a FK — it IS the entity                                                                         |
| `crawlJobId`           | `crawlConfig.crawlJobId`            | `GET /sources/:id`                      | Same string, nullable                                                                                     |
| `url`                  | `sourceConfig.url`                  | `GET /sources/:id`                      | Already on source                                                                                         |
| `expiresAt`            | `crawlConfig.configExpiresAt`       | —                                       | TTL for abandoned configuring sources                                                                     |
| Auth config            | `crawlConfig.auth`                  | `GET /sources/:id`                      | **NEW** — never persisted before (bug fix)                                                                |
| Per-section strategies | `crawlConfig.groupStrategies`       | `GET /sources/:id`                      | **NEW** — never persisted before (bug fix)                                                                |

**Resume sequence in CrawlFlowV5.tsx (replaces lines 624-710):**

```
1. GET /sources/:sourceId → source with crawlConfig
2. IF source.status !== 'configuring' → show read-only view
3. Restore: wizardStep, profile, sections, strategy, settings, auth, groupStrategies from crawlConfig
4. IF strategy === 'guided-discovery' → GET /sources/:sourceId/discovery-state → SourceConfigState
5. Restore: discoveryState, discoveryStatus from SourceConfigState
6. Show resume banner: "Resume discovery?" | "Start fresh" | "Skip to configure"
```

---

## Cascade Delete & Cleanup (H-1, H-5 Fix)

### Source DELETE Cascade

When `DELETE /:indexId/sources/:sourceId` is called, the existing handler cascades to `SearchDocument` + `SearchChunk` + index counter decrements. Add:

```
Existing:  SearchDocument.deleteMany({sourceId})
           SearchChunk.deleteMany({sourceId})
           Index.sourceCount -= 1
New:       SourceConfigState.deleteOne({sourceId})     ← ADD
           SourceUrlBucket.deleteMany({sourceId})      ← ADD
```

### Worker Crawl-Start Cleanup

When the batch crawl starts (worker picks up job), transient wizard data is cleaned:

```
SourceConfigState.deleteOne({sourceId})     — discovery blob no longer needed
SourceUrlBucket.deleteMany({sourceId})      — URLs already extracted into job data
crawlConfig.wizardStep = null               — source is no longer configuring
crawlConfig.configExpiresAt = null          — prevent TTL deletion of now-active source
```

### Abandoned Configuring Source Cleanup (H-5)

Sources that stay `configuring` forever (user abandons wizard) need cleanup. Two mechanisms:

1. **SourceConfigState** has a 30-day TTL index on `updatedAt` — blob auto-deletes.
2. **SearchSource** with `status: 'configuring'` — add `crawlConfig.configExpiresAt: Date` (set 30 days from creation, cleared when crawl starts). MongoDB TTL index: `{ 'crawlConfig.configExpiresAt': 1, expireAfterSeconds: 0 }`. This auto-deletes abandoned configuring sources after 30 days, matching current CrawlDraft behavior.

**Add to SearchSource indexes:**

```typescript
// TTL index — auto-delete abandoned configuring sources
{ 'crawlConfig.configExpiresAt': 1 }, { expireAfterSeconds: 0, partialFilterExpression: { status: 'configuring' } }
```

---

## Legacy Draft-Status Source Handling (C-3 Fix)

Existing sources with `status: 'draft'` (created by old draft system's side-effect) need graceful handling:

**Strategy:** Frontend compatibility layer (no migration needed).

1. `SourcesTable.tsx` — treat `status === 'draft'` same as `status === 'configuring'` visually
2. On click: these sources have NO `crawlConfig` → show message: "This source was started with an older version. Delete and start fresh."
3. Actions: Delete only (no resume — no data to resume from)
4. These sources were never in the `SourceStatus` enum, so backend queries already exclude them. They appear only if the sources list query doesn't filter by status (which it doesn't currently).

**Natural decay:** When users delete them or the KB is cleaned up, they disappear. No migration script needed.

---

## sourceCount Handling (H-2 Fix)

**Decision:** Configuring sources count toward `sourceCount`.

**Rationale:** Configuring sources are real, visible entities in the sources table. Users expect the count to match what they see. The existing `POST /sources` already increments `sourceCount` — we preserve this behavior.

**Change:** The batch endpoint (`POST /crawl/batch`) no longer creates a new source (and no longer increments count). The count was already incremented at source creation time. No double-counting.

---

## OCC (Optimistic Concurrency Control) Mechanism (H-4 Fix)

The `PATCH /:indexId/sources/:sourceId/crawl-config` endpoint uses `configVersion` for OCC:

```typescript
// PATCH handler pseudocode
const { configVersion, ...updates } = req.body;

const result = await SearchSource.findOneAndUpdate(
  {
    _id: sourceId,
    tenantId,
    indexId,
    'crawlConfig.configVersion': configVersion, // OCC check
  },
  {
    $set: {
      /* updates to crawlConfig.* */
    },
    $inc: { 'crawlConfig.configVersion': 1 }, // Atomic increment
  },
  { new: true },
);

if (!result) {
  return res.status(409).json({
    success: false,
    error: { code: 'VERSION_CONFLICT', message: 'Source was modified by another session' },
  });
}
```

Client must always send `configVersion` from its last read. 409 Conflict = stale client, must re-fetch and retry.

---

## Task Decomposition

Per the sequential workflow: one task at a time, mini-LLD → implement → review → next task.

| Task | Package(s)                                    | Depends On | Est. Files | Description                                                                                                                                                                                                          |
| ---- | --------------------------------------------- | ---------- | ---------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| T-1  | `packages/database`, `packages/search-ai-sdk` | —          | 6-7        | **Data model**: Create `SourceUrlBucket` + `SourceConfigState` models, add `crawlConfig` subdocument (incl. `configExpiresAt`) to `SearchSource` with TTL index, add `CONFIGURING` to `SourceStatus`, update exports |
| T-2  | `apps/search-ai`                              | T-1        | 4-5        | **Backend routes**: Add `PATCH crawl-config` + `PUT/GET discovery-state` + URL bucket endpoints to `sources.ts`, register new models in DB                                                                           |
| T-3  | `apps/search-ai`                              | T-1        | 2-3        | **Crawl pipeline**: Update `crawl.ts` batch route to drop `draftId` + transition `configuring→pending`, update `storeBucketUrlsForGroups` to use `SourceUrlBucket`, update `shared.ts` types                         |
| T-4  | `apps/search-ai`                              | T-3        | 1-2        | **Worker cleanup**: Remove draft update from `bulk-crawl-worker.ts`, add post-crawl cleanup (delete `SourceConfigState` + `SourceUrlBucket`, set `crawlConfig.wizardStep = null`, clear `configExpiresAt`)           |
| T-5  | `apps/studio`                                 | T-2        | 4-5        | **Frontend API + stores**: Replace draft API functions with source + discovery-state operations in `crawl.ts`, update `crawl-flow-store` and `discovery-store` from `draftId` to `sourceId`                          |
| T-6  | `apps/studio`                                 | T-5        | 5-6        | **Wizard components**: Update `CrawlFlowV5.tsx`, `State1UrlEntry.tsx`, `State2Analysis.tsx` to use source operations. Persist auth + crawl config (bug fixes). Discovery state save → new endpoint                   |
| T-7  | `apps/studio`                                 | T-5        | 3-4        | **Table + wiring**: Update `SourcesTable.tsx` (configuring status + legacy `draft` handling), `AddSourceButton.tsx`, `DataSection.tsx`, `KnowledgeBaseDetailPage.tsx` for source-based resume                        |
| T-8  | `apps/studio`, `apps/search-ai`               | T-6, T-7   | 2-3        | **Cleanup**: Delete `DiscoveryActivityBar.tsx`, delete `CrawlDraft` + `CrawlDraftUrlBucket` models, delete `crawl-drafts.ts`, remove dead exports and imports                                                        |

**Execution order:** T-1 → T-2 → T-3 → T-4 → T-5 → T-6 → T-7 → T-8

### Per-Task Execution Workflow

Each task follows this 6-step cycle:

```
1. Mini-LLD        — Detailed design: files, signatures, subtasks, acceptance criteria
2. Integration     — (T-2 onwards) Map all touchpoints with previous + next tasks
   Touchpoint        Verify contracts match. Check for duplicates, timing, missed wiring.
   Review
3. Implement       — Write code. Build verify after each file.
4. Review          — Three checks:
   a. Code review    — correctness, types, patterns
   b. Goal verify    — which UX spec journeys + HLD "Must Not Regress" rows
                       does this task satisfy? Which bugs does it fix?
   c. Integration    — document for NEXT task: actual signatures created,
      notes            deviations from HLD, gotchas found during implementation
5. Commit          — One focused commit per task
6. → Next task     — Reads integration notes from previous task before starting
```

**Integration Touchpoint Review checklist (applied from T-2 onwards):**

- What did the previous task produce? (read its commit + integration notes)
- What does THIS task consume from it? (verify actual types/exports/endpoints)
- What will the NEXT task need from THIS task? (pre-validate the contract)
- Are there OTHER existing components that touch the same data? (map them all)
- Any timing/ordering dependencies? (e.g., route registration order, model init)
- Any duplicate data paths being created? (e.g., two ways to save the same field)

**Goal Verification checklist (applied to every task):**

- Which UX spec journeys (J1–J6) does this task enable or advance?
- Which HLD "Must Not Regress" rows does this task satisfy?
- Which data loss bugs (auth config, crawl config, groupStrategies) does this task fix?
- Any deviations from HLD? (document in integration notes for next task)

### Final Integration Touchpoint Review (after T-8)

After all tasks complete, a full end-to-end integration review:

1. **Cross-task contract verification** — T-1 model types match T-2 route handlers match T-5 API client match T-6 component calls. Trace one field (e.g., `crawlConfig.auth`) from model definition → route handler → API function → React component → user interaction.
2. **All 3 crawl modes** — Guided Discovery, Sitemap Crawl, Direct URLs. Trace each mode's data flow through the new code. Verify no step references deleted draft entities.
3. **All 6 UX spec journeys** — J1 (happy path), J2 (close + resume), J3 (same domain re-entry), J4 (crash recovery), J5 (recrawl existing), J6 (multi-user). Verify each journey has complete code paths.
4. **All HLD "Must Not Regress" rows** — every row has working code + verification method.
5. **Dead reference scan** — grep for `draftId`, `CrawlDraft`, `crawl-drafts`, `draft` status literals. Zero references outside of legacy handling in SourcesTable.
6. **Report** — PASS (all clear) or GAPS FOUND (with fix plan before PR).

### Per-Task Integration Notes Template

Each task's review step produces integration notes appended to `docs/specs/draft-elimination.changes.md`:

```markdown
## T-{N}: {Name} — Integration Notes

### Produced (for next task)

- Exported types: `TypeA`, `TypeB` from `path/to/file`
- Endpoints: `PATCH /sources/:id/crawl-config` (actual signature)
- Deviations from HLD: none / {what changed and why}

### Consumed (from previous task)

- Used `ISourceConfigState` from T-1 — verified compatible
- Used `crawlConfig` subdocument shape — matches T-1 schema

### Gotchas for next task

- {anything surprising discovered during implementation}

### Goal Status

- UX Journeys advanced: J1 (steps 1-2), J2 (partial — resume endpoint ready)
- Must Not Regress satisfied: rows 1, 5, 11
- Bugs fixed: auth config persistence (partial — backend ready, frontend in T-6)
```

## Must Not Regress

| Behavior                                                                     | How to verify                                                 | Modes                     |
| ---------------------------------------------------------------------------- | ------------------------------------------------------------- | ------------------------- |
| Resume mid-discovery — close wizard, come back, tree state restored          | Journey 2: SourceConfigState.discoveryState loaded on resume  | Guided Discovery          |
| Resume mid-sitemap — close wizard, come back, sections + URL counts restored | Source.crawlConfig.sections + SourceUrlBucket counts          | Sitemap                   |
| Resume direct URLs — close wizard, come back, pasted URLs available          | Source.crawlConfig.sections + SourceUrlBucket content         | Direct URLs               |
| No blocking on same-domain — users can always create new sources             | No domain-check gate; duplicates managed in sources table     | All                       |
| Section URL persistence — 50K+ URLs stored and retrievable                   | SourceUrlBucket write + paginated read                        | Sitemap, Guided Discovery |
| Crawl submission — sections, settings, URLs all reach the worker             | `submitBatchCrawl` → BullMQ job data without draftId          | All                       |
| Auth config persisted and sent to crawl                                      | crawlConfig.auth saved, read at submit time                   | All (BUG FIX)             |
| Crawl settings persisted and restored on resume                              | crawlConfig.settings saved and loaded                         | All (BUG FIX)             |
| Source status transitions — configuring → pending → active                   | No duplicate source creation; same source transitions         | All                       |
| Cross-user visibility — other users see configuring sources                  | Sources table query includes `configuring` status             | All                       |
| OCC — concurrent edits don't silently overwrite                              | configVersion check on crawl-config PATCH                     | All                       |
| Transient data cleanup — discovery blob + URL buckets removed on crawl       | Worker deletes SourceConfigState + SourceUrlBucket            | All                       |
| Abandoned wizard cleanup — 30-day TTL on SourceConfigState                   | TTL index on updatedAt                                        | All                       |
| Abandoned source cleanup — 30-day TTL on configuring sources                 | TTL index on `crawlConfig.configExpiresAt`                    | All                       |
| Cascade delete — source deletion removes config state + URL buckets          | DELETE handler includes SourceConfigState + SourceUrlBucket   | All                       |
| Legacy draft sources — visible with "delete and start fresh" message         | SourcesTable handles `status === 'draft'` gracefully          | All                       |
| No duplicate source creation — batch endpoint updates existing source        | Batch endpoint: `configuring → pending` (not `POST /sources`) | All                       |
| sourceCount accurate — no phantom counts from configuring sources            | Count incremented at creation (1 source = 1 count)            | All                       |

## Out of Scope

- **3-Step Crawl Flow** (Phase 2, ABLP-71) — blocked on this, implemented after
- **Unified Source Page** (Phase 3) — blocked on Phase 2
- **Backend URL extraction optimization** — frontend pagination works, optimize later
- **Application-layer encryption for auth credentials** — security hardening pass
- **Migration of existing drafts** — TTL-expire naturally
- **Connector/file-upload/database/API source changes** — web crawl only
- **Discovery algorithm changes** — discovery engine unchanged, only state storage location moves
- **DiscoveryActivityBar rebuild** — deleted in T-8; configuring source rows in SourcesTable serve as the replacement in this phase (cross-user visibility via status column). Pulsing badges deferred to Unified Source Page (Phase 3)

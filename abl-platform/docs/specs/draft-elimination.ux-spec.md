# Draft Elimination — UX & Architecture Specification

## What

Eliminate the `CrawlDraft` model entirely. The `SearchSource` becomes the single entity from the moment a user enters a URL. All wizard state, crawl config, auth config, and discovery state persist on the source — not on a separate draft document.

**Why:**

- Today the system creates TWO entities for ONE thing: a draft AND a source (with undeclared `'draft'` status)
- On "Start Crawl", a THIRD entity appears: another source created at submit time
- Orphaned sources and drafts accumulate with no cleanup
- Auth config is **never persisted** — silent data loss (user configures auth, it has no effect)
- Crawl config is **never persisted** — resets to defaults on resume
- Draft system has **zero test coverage**
- `'draft'` status is not in the SourceStatus enum — silently excluded from any enum-based query
- "Could not save draft" error visible in production on completed crawl screens

**Scope:** Web crawl sources only. Connectors, file upload, database, and API source flows are unchanged.

---

## Current System (What We're Replacing)

### Two-Entity Problem

```
User enters URL
  → POST /drafts → CrawlDraft created (crawl_drafts collection)
  → ALSO creates SearchSource with status: 'draft' (search_sources collection)
  → Wizard saves all config to DRAFT, not to source
  → On "Start Crawl" (CrawlFlowV5 line 939):
    → ANOTHER SearchSource created via addSource()
    → Now: 2 sources + 1 draft for 1 domain
  → After crawl completes:
    → Worker sets draft.flowState = 'completed' (best-effort, may fail if TTL expired)
    → Original 'draft' source is never cleaned up
```

### Draft Model (193 lines — to be deleted)

```typescript
// CrawlDraft fields
url: string                           // Target URL
projectId, tenantId, indexId          // Ownership
createdBy: string                     // User who created
flowState: 'profiling' | 'sections_ready' | 'configured' | 'submitted' | 'completed'
profile: { hasSitemap, sitemapPageCount, hasJsRendering, suggestedStrategy, ... }
sections: [{ pattern, name, pageCount, included, strategy, source }]
discoveryState: Mixed                 // Tree, objectives, coverage — up to 5MB blob
discoveryStatus: 'idle' | 'running' | 'complete' | 'stopped'
strategy: string | null               // 'guided-discovery' | 'crawl-sitemap' | 'direct-urls'
config: { scope, rendering, maxPages, maxDepth, requestDelay, cleanup, ... }
sourceId: string | null               // Link to associated source
crawlJobId: string | null             // Set after submission
version: number                       // OCC
expiresAt: Date                       // TTL (30 days)
```

### URL Bucket Model (91 lines — to be deleted)

```typescript
// CrawlDraftUrlBucket — chunked URL storage (500 per bucket)
draftId: string                       // Parent draft
sectionId: string                     // Which section
bucketIndex: number                   // 0, 1, 2... for pagination
urls: [{ url, title?, source? }]      // Max 500 per bucket
```

### 9 Save Points in Current Wizard

| #   | Trigger                   | Saved To            | What                                        |
| --- | ------------------------- | ------------------- | ------------------------------------------- |
| 1   | Profile complete          | Draft               | `profile` object                            |
| 2   | Clustering completes      | Draft               | `sections[]`, `flowState: 'sections_ready'` |
| 3   | Custom sitemap re-cluster | Draft               | `sections[]`                                |
| 4   | Section toggle by user    | Draft               | `sections[]`                                |
| 5   | "Continue" to Configure   | Draft + URL buckets | `flowState: 'configured'`, section URLs     |
| 6   | Crawl submitted           | Draft               | `flowState: 'submitted'`, `crawlJobId`      |
| 7   | Direct crawl shortcut     | Draft + URL buckets | Same as 5+6 combined                        |
| 8   | Strategy selection        | Draft               | `strategy` string                           |
| 9   | Discovery tree auto-save  | Draft               | `discoveryState` (debounced 5s)             |

### Data Loss Bugs (Fixed by This Spec)

| Bug                                | Impact                                                                                                                                                                   | Root Cause         |
| ---------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | ------------------ |
| **Auth config never persisted**    | User configures auth tokens/cookies in Step 1, but `authConfig` is local React state only. Never saved to draft. Never sent to `submitBatchCrawl`. Auth has zero effect. | Missing save point |
| **Crawl config never persisted**   | Max pages, request delay, rendering mode, cleanup level — all lost on resume. Always resets to defaults.                                                                 | Missing save point |
| **groupStrategies lost on resume** | Per-section rendering recommendations from `sampleGroups()` not restored                                                                                                 | Not saved to draft |

---

## New System (Source-Only Model)

### Core Principle

**One entity, one lifecycle.** The source is created when the user enters a URL and persists forever. All wizard state lives on the source via a typed `crawlConfig` subdocument.

### Source Lifecycle

```
configuring → pending → active
                      → error

Where:
  configuring  = User is in the crawl wizard (replaces 'draft' status)
  pending      = Crawl submitted, waiting to start (existing)
  active       = Has documents (existing — set on first doc ingested)
  error        = Sync/ingestion failed (existing)
```

**Note:** `crawling` is NOT a source status. It's a frontend-derived display state from checking whether the source has a non-terminal CrawlJob. This avoids adding another status that the backend would need to set/unset correctly.

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

### Source Model — New `crawlConfig` Subdocument

Added to `SearchSource` model for `sourceType: 'web'` sources only:

```typescript
// New typed subdocument on SearchSource
crawlConfig: {
  // Wizard state (replaces CrawlDraft.flowState)
  wizardStep: 'profiling' | 'sections_ready' | 'configured' | null,

  // Site profile (replaces CrawlDraft.profile)
  profile: {
    hasSitemap: boolean,
    sitemapPageCount: number | null,
    hasJsRendering: boolean,
    suggestedStrategy: string | null,
    technologies: string[],
    robotsAllowed: boolean,
    // ... other profile fields from ICrawlDraftProfile
  } | null,

  // Sections (replaces CrawlDraft.sections)
  sections: [{
    pattern: string,
    name: string,
    pageCount: number,
    included: boolean,
    strategy: 'http' | 'browser',
    source: string,          // 'sitemap' | 'discovery' | 'direct'
  }] | null,

  // Strategy (replaces CrawlDraft.strategy)
  strategy: 'guided-discovery' | 'crawl-sitemap' | 'direct-urls' | null,

  // Discovery state (replaces CrawlDraft.discoveryState)
  // Stored as Mixed — large blob, cleaned up after crawl starts
  discoveryState: {
    tree: any,
    objectives: any,
    coverage: any,
    iterations: any,
    savedAt: Date,
  } | null,

  // Discovery status (replaces CrawlDraft.discoveryStatus)
  discoveryStatus: 'idle' | 'running' | 'complete' | 'stopped' | null,

  // Crawl settings (NEW — FIXES data loss bug, never persisted today)
  settings: {
    scope: 'limited' | 'full',
    rendering: 'http' | 'browser' | 'hybrid',
    maxPages: number,
    maxDepth: number,
    requestDelay: number,
    cleanup: 'aggressive' | 'moderate' | 'light',
    robotsTxt: boolean,
    deduplicate: boolean,
    cookieConsent: boolean,
    reuseHandlers: boolean,
  } | null,

  // Auth config (NEW — FIXES data loss bug, never persisted today)
  auth: {
    method: 'none' | 'bearer' | 'cookie' | 'custom-header',
    token: string | null,       // Encrypted at rest
    headers: Record<string, string> | null,
    cookies: string | null,     // Encrypted at rest
  } | null,

  // OCC version (replaces CrawlDraft.version)
  configVersion: number,
}
```

**Cleanup rule:** After crawl starts (source transitions `configuring → pending`), large blobs are cleaned:

- `discoveryState` → set to `null` (tree data no longer needed)
- `profile` → keep summary only (used by Settings tab in Unified Source Page)
- `sections` → keep (used by recrawl pre-fill)
- `settings` → keep (used by recrawl pre-fill and Settings tab)
- `auth` → keep (used by recrawl — credentials needed for re-authentication)

### URL Storage — Re-keyed Buckets

```typescript
// Rename: CrawlDraftUrlBucket → SourceUrlBucket
// Key change: draftId → sourceId
sourceId: string,         // Was: draftId
sectionId: string,        // Same
bucketIndex: number,      // Same
urls: [{ url, title?, source? }],  // Same
```

- Cleanup: delete all buckets when crawl starts (URLs extracted at submit time)
- Cleanup: delete all buckets when source deleted
- Same 500-per-bucket chunking pattern

---

## New API Surface

### Routes Replaced

| Old (Draft)                          | New (Source)                                         | Method | Purpose                                 |
| ------------------------------------ | ---------------------------------------------------- | ------ | --------------------------------------- |
| `POST /drafts`                       | `POST /sources` (existing, enhanced)                 | POST   | Create source with `configuring` status |
| `PATCH /drafts/:draftId`             | `PATCH /sources/:sourceId/crawl-config`              | PATCH  | Update crawlConfig (OCC)                |
| `GET /drafts/:draftId`               | `GET /sources/:sourceId` (existing)                  | GET    | Get source with crawlConfig             |
| `GET /drafts`                        | `GET /sources?status=configuring` (existing, filter) | GET    | List configuring sources                |
| `DELETE /drafts/:draftId`            | `DELETE /sources/:sourceId` (existing)               | DELETE | Delete source + cascades                |
| `GET /drafts/active`                 | `GET /sources?status=configuring&indexId=X`          | GET    | Active configurations                   |
| `GET /drafts/check-domain`           | `GET /sources/check-domain`                          | GET    | Duplicate domain check                  |
| `PUT /drafts/:id/sections/:sid/urls` | `PUT /sources/:id/sections/:sid/urls`                | PUT    | Bulk URL write                          |
| `GET /drafts/:id/sections/:sid/urls` | `GET /sources/:id/sections/:sid/urls`                | GET    | Paginated URL read                      |
| `GET /drafts/:draftId/status`        | Not needed                                           | —      | Replaced by source polling              |

**Net: 10 draft endpoints → 2 new endpoints + existing source CRUD**

New endpoints needed:

1. `PATCH /sources/:sourceId/crawl-config` — update crawlConfig with OCC
2. `GET /sources/check-domain?domain=X&indexId=Y` — check if domain already exists

URL bucket endpoints move from draft namespace to source namespace: 3. `PUT /sources/:sourceId/sections/:sectionId/urls` — bulk URL write 4. `GET /sources/:sourceId/sections/:sectionId/urls` — paginated URL read

---

## Complete Page: Sources Table with Configuring Sources

```
┌─────────────────────────────────────────────────────────────────────────┐
│  Sources                                                  [Add Source]  │
│  ┌──────┬──────────────────────┬──────────────────────────────┬───────┐│
│  │Status│ Source               │ Details                      │Actions││
│  ├──────┼──────────────────────┼──────────────────────────────┼───────┤│
│  │  ◐   │ epson.com            │ Configuring · Step 2 of 3   │  ⋮    ││ ← new status
│  │  ✓   │ docs.example.com     │ Active · 42 pages · 2d ago  │  ⋮    ││
│  │  ○   │ api.example.com      │ Pending                     │  ⋮    ││
│  └──────┴──────────────────────┴──────────────────────────────┴───────┘│
│                                                                         │
│  Click configuring source → reopens wizard at saved step               │
└─────────────────────────────────────────────────────────────────────────┘
```

**Configuring source row:**

- Status: ◐ (half-circle, unique icon) in subtle color
- Details: "Configuring · Step N of 3" — derived from `crawlConfig.wizardStep`
- Actions menu: Resume, Delete
- Click row → opens wizard, resumes from `crawlConfig`

---

## User Journeys

### Journey 1: Happy Path — New Crawl

```
Step 1: Enter URL
  User types "epson.com" → clicks Go
  → POST /sources creates source:
    { sourceType: 'web', status: 'configuring',
      crawlConfig: { wizardStep: 'profiling' },
      sourceConfig: { url: 'https://epson.com' } }
  → Source appears in sources table: "◐ epson.com · Configuring"
  → Profiling begins

Step 2: Profile + Discovery/Sitemap
  Profile completes → PATCH /sources/:id/crawl-config:
    { profile: { hasSitemap: true, ... }, wizardStep: 'profiling' }

  User picks Guided Discovery → strategy saved:
    { strategy: 'guided-discovery' }

  Discovery tree builds → auto-saved (debounced 5s):
    { discoveryState: { tree, objectives, coverage, savedAt } }

  Clustering completes → sections saved:
    { sections: [...], wizardStep: 'sections_ready' }

  User toggles sections → sections updated (same endpoint)

Step 3: Configure (optional) or Direct Crawl
  Option A: User clicks "⚡ Crawl N Pages" (direct)
    → Crawl settings saved: { settings: { ...defaults }, wizardStep: 'configured' }
    → Auth saved: { auth: { method: 'none' } }
    → Section URLs persisted to SourceUrlBuckets
    → submitBatchCrawl called → source status: configuring → pending
    → CrawlJob created, crawl begins

  Option B: User clicks "⚙ Settings" → Configure page
    → User adjusts settings, auth
    → Settings saved: { settings: { maxPages: 500, ... } }
    → Auth saved: { auth: { method: 'bearer', token: 'abc...' } }
    → Clicks "Start Crawl" → same submission flow as Option A

Step 4: Crawl runs
  → Source status: pending → active (on first doc ingested)
  → crawlConfig.discoveryState set to null (cleanup)
  → SourceUrlBuckets deleted (URLs extracted at submit time)
  → crawlConfig.wizardStep set to null (no longer configuring)
```

### Journey 2: Close Mid-Discovery → Resume Later

```
User is on Step 2, discovery 60% done
  → Clicks X (close wizard)
  → Dialog: "Save & Close" | "Delete Source"

"Save & Close":
  → Source stays at status: 'configuring'
  → Discovery state already auto-saved (debounced)
  → Wizard closes
  → Sources table shows: "◐ epson.com · Configuring · Step 2 of 3"

Later, user clicks the configuring source row:
  → Wizard reopens
  → Loads crawlConfig from source
  → Restores: URL, profile, sections, strategy, discoveryState
  → Also restores: auth config, crawl settings (FIXED — was lost before)
  → Resume banner: "Resume discovery?" | "Start fresh" | "Skip to configure"
  → User picks resume → discovery continues from saved state

"Delete Source":
  → Source deleted immediately
  → SourceUrlBuckets cascade-deleted
  → Clean — no orphans
```

### Journey 3: Same Domain Re-entry

```
User types "epson.com" → clicks Go
  → GET /sources/check-domain?domain=epson.com&indexId=X

If configuring source exists:
  → Dialog: "You have an unfinished configuration for epson.com. Resume?"
  → "Resume" → opens wizard with saved state (Journey 2 resume)
  → "Start Fresh" → deletes old source, creates new one

If active source exists:
  → Dialog: "epson.com already exists with 187 pages. Recrawl with new settings?"
  → "Recrawl" → opens wizard pre-filled from existing crawlConfig
  → "Cancel" → stays on URL entry

Never creates duplicate sources for the same domain in the same KB.
```

### Journey 4: Browser Crash → Recovery

```
User is mid-discovery, browser crashes
  → Source persists at status: 'configuring'
  → crawlConfig has last auto-saved state (within 5s)
  → User returns to KB → sees "◐ epson.com · Configuring" in sources table
  → Clicks → wizard reopens from saved state
  → No separate draft needed — source IS the state
```

### Journey 5: Recrawl Existing Source

```
User has active source → clicks "Recrawl"
  → Wizard opens pre-filled from existing crawlConfig:
    - URL from sourceConfig.url
    - Settings from crawlConfig.settings
    - Auth from crawlConfig.auth (FIXED — was lost before)
    - Sections from crawlConfig.sections (if still present)
  → User adjusts settings
  → Clicks "Start Crawl"
  → Same source, new CrawlJob
  → Source stays 'active' throughout (already has documents)
```

### Journey 6: Multiple Users, Same KB

```
User A configures epson.com → source created with createdBy: userA
  → User B sees "◐ epson.com · Configuring" in sources table
  → User B clicks it → read-only view (not their source)
  → User B types "epson.com" → domain check finds User A's source
  → Message: "User A is configuring this domain"
```

---

## Files Changed

### Deleted (~1,800 lines removed)

| File                                                                       | Lines | What                                               |
| -------------------------------------------------------------------------- | ----- | -------------------------------------------------- |
| `packages/database/src/models/crawl-draft.model.ts`                        | 193   | Draft model                                        |
| `packages/database/src/models/crawl-draft-url-bucket.model.ts`             | 91    | URL bucket model                                   |
| `apps/search-ai/src/routes/crawl-drafts.ts`                                | 887   | Draft CRUD routes                                  |
| `apps/studio/src/components/search-ai/crawl-flow/DiscoveryActivityBar.tsx` | ~200  | Activity bar (also removed by Unified Source Page) |
| Draft API functions in `apps/studio/src/api/crawl.ts`                      | ~320  | 9 draft API functions                              |
| Draft types in `apps/studio/src/components/search-ai/crawl-flow/types.ts`  | ~100  | Draft-related types                                |

### Modified

| File                                                                     | Change                                                                                                    |
| ------------------------------------------------------------------------ | --------------------------------------------------------------------------------------------------------- |
| **`packages/database/src/models/search-source.model.ts`**                | Add `crawlConfig` subdocument schema                                                                      |
| **`packages/database/src/models/index.ts`**                              | Remove CrawlDraft exports, add SourceUrlBucket                                                            |
| **`packages/database/src/index.ts`**                                     | Same re-export cleanup                                                                                    |
| **`packages/search-ai-sdk/src/constants.ts`**                            | Add `CONFIGURING` to SourceStatus                                                                         |
| **`apps/search-ai/src/db/index.ts`**                                     | Remove CrawlDraft ModelRegistry, add SourceUrlBucket                                                      |
| **`apps/search-ai/src/server.ts`**                                       | Remove crawl-drafts route mount                                                                           |
| **`apps/search-ai/src/routes/sources.ts`**                               | Enhanced POST for web sources, add PATCH crawl-config, domain-check, URL bucket endpoints                 |
| **`apps/search-ai/src/routes/crawl.ts`**                                 | `handleStartCrawl`: read from source.crawlConfig instead of draft. Remove `draftId` from BulkCrawlJobData |
| **`apps/search-ai/src/workers/bulk-crawl-worker.ts`**                    | Remove draft completion update (lines 704-714). Clean up crawlConfig.discoveryState on source             |
| **`apps/search-ai/src/workers/shared.ts`**                               | Remove `draftId` from BulkCrawlJobData                                                                    |
| **`apps/studio/src/api/crawl.ts`**                                       | Replace draft functions with source crawl-config functions                                                |
| **`apps/studio/src/components/search-ai/crawl-flow/CrawlFlowV5.tsx`**    | Replace all draft ops with source ops. Persist auth + crawl config (bug fixes)                            |
| **`apps/studio/src/components/search-ai/crawl-flow/State1UrlEntry.tsx`** | List configuring sources instead of drafts                                                                |
| **`apps/studio/src/components/search-ai/crawl-flow/State2Analysis.tsx`** | Save to source instead of draft                                                                           |
| **`apps/studio/src/components/search-ai/crawl-flow/types.ts`**           | Replace draft types with source crawl-config types                                                        |
| **`apps/studio/src/components/search-ai/data/SourcesTable.tsx`**         | Show 'configuring' status, resume flow                                                                    |
| **`apps/studio/src/components/search-ai/data/AddSourceButton.tsx`**      | Domain check uses source query                                                                            |

### Created

| File                                                      | What                                              |
| --------------------------------------------------------- | ------------------------------------------------- |
| `packages/database/src/models/source-url-bucket.model.ts` | Re-keyed URL bucket (sourceId instead of draftId) |

---

## What This Enables for Unified Source Page

| Unified Source Page Need       | Draft System                                | Source-Only System                                |
| ------------------------------ | ------------------------------------------- | ------------------------------------------------- |
| Clean source statuses          | ❌ 'draft' undeclared, 'crawling' never set | ✅ 'configuring' declared, display states derived |
| Settings tab shows config      | ❌ Config on draft, not source              | ✅ crawlConfig on source — direct read            |
| Recrawl pre-fills settings     | ❌ Settings never persisted                 | ✅ crawlConfig.settings preserved                 |
| Recrawl pre-fills auth         | ❌ Auth never persisted                     | ✅ crawlConfig.auth preserved                     |
| Activity bar removed           | ⚠️ Must remove separately                   | ✅ Already removed                                |
| Sources table shows all states | ❌ 'draft' sources may not appear           | ✅ 'configuring' is a proper enum value           |
| One source per domain          | ❌ Duplicates possible                      | ✅ Enforced by domain check                       |

---

## Open Questions

1. **Discovery state size** — the `discoveryState` blob can reach 5MB. Is inline on the source OK, or should we use a separate collection with a `sourceId` foreign key? (Leaning toward inline since it's cleaned up after crawl starts.)
2. **Auth credential encryption** — the `auth.token` and `auth.cookies` fields contain secrets. Should we encrypt at the application layer before storing, or rely on MongoDB encryption at rest?
3. **Configuring source visibility** — should other users in the same project see configuring sources, or only the creator? (Current draft system shows active drafts cross-user via the activity bar.)

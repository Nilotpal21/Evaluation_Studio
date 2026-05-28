# Draft Elimination — User Journeys (User + System Steps)

This document traces every user journey with both **user actions** and **system reactions**, verified against the HLD at `docs/specs/draft-elimination.hld.md` and the UX spec at `docs/specs/draft-elimination.ux-spec.md`.

---

## Journey 1: Happy Path — New Guided Discovery Crawl

### Step 1: URL Entry

| #   | Actor  | Action                                                                                                                                             | System Response                                                                                                                                                                                                                                                                                  |
| --- | ------ | -------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| 1   | User   | Opens KB → clicks "Add Source" → selects "Web Crawl"                                                                                               | Frontend opens CrawlFlowV5 wizard at Step 1                                                                                                                                                                                                                                                      |
| 2   | User   | Types "epson.com" → clicks Go                                                                                                                      | —                                                                                                                                                                                                                                                                                                |
| 3   | System | `POST /:indexId/sources` `{ name: 'epson.com', sourceType: 'web', sourceConfig: { url: 'https://epson.com' } }`                                    | Backend creates SearchSource: `status: 'configuring'`, `crawlConfig: { wizardStep: 'profiling', configVersion: 1, configExpiresAt: now+30d }`. Returns `sourceId`. Source appears in SourcesTable as "◐ epson.com · Configuring · Step 1 of 3". No domain uniqueness check — duplicates allowed. |
| 4   | System | `POST /crawl/profile { url: 'https://epson.com' }`                                                                                                 | Stateless profiling endpoint. Returns site profile: hasSitemap, jsRequired, estimatedSize, platform, etc.                                                                                                                                                                                        |
| 5   | System | `PATCH /:indexId/sources/:sourceId/crawl-config` `{ configVersion: 1, profile: { domain: 'epson.com', hasSitemap: true, jsRequired: true, ... } }` | Backend saves profile on source. `configVersion` incremented to 2.                                                                                                                                                                                                                               |

### Step 2: Discovery + Analysis

| #   | Actor  | Action                                                                                                                 | System Response                                                                                                                                                                                                                                                  |
| --- | ------ | ---------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 6   | User   | Selects "Guided Discovery" strategy                                                                                    | —                                                                                                                                                                                                                                                                |
| 7   | System | `PATCH /:indexId/sources/:sourceId/crawl-config` `{ configVersion: 2, strategy: 'guided-discovery' }`                  | Strategy saved. configVersion → 3.                                                                                                                                                                                                                               |
| 8   | System | Discovery engine starts (BFS tree building)                                                                            | Frontend manages discovery via crawler-mcp-server. Tree builds in real-time in UI.                                                                                                                                                                               |
| 9   | System | Auto-save discovery state (debounced 5s)                                                                               | `PUT /:indexId/sources/:sourceId/discovery-state` `{ discoveryState: { tree, discoveredUrls, objectives, navStructure, iterations, coverage, savedAt }, discoveryStatus: 'running' }` → Creates `SourceConfigState` row (lazy creation on first PUT). Up to 5MB. |
| 10  | User   | Watches tree build, adds objectives, explores nodes                                                                    | Discovery auto-saves continue every 5s to SourceConfigState                                                                                                                                                                                                      |
| 11  | System | Discovery completes                                                                                                    | `PUT /:indexId/sources/:sourceId/discovery-state` with `discoveryStatus: 'complete'`                                                                                                                                                                             |
| 12  | System | `POST /crawl/cluster-urls { sourceId, urls, ... }`                                                                     | Backend clusters URLs into sections. `storeBucketUrlsForGroups()` writes to `SourceUrlBucket` (keyed by sourceId). Returns section groups.                                                                                                                       |
| 13  | System | `PATCH /:indexId/sources/:sourceId/crawl-config` `{ configVersion: 3, sections: [...], wizardStep: 'sections_ready' }` | Sections + wizardStep saved. configVersion → 4.                                                                                                                                                                                                                  |
| 14  | User   | Reviews sections, toggles include/exclude                                                                              | —                                                                                                                                                                                                                                                                |
| 15  | System | `PATCH /:indexId/sources/:sourceId/crawl-config` `{ configVersion: 4, sections: [...updated...] }`                     | Updated sections saved. configVersion → 5.                                                                                                                                                                                                                       |

### Step 3: Configure (optional) + Submit

| #   | Actor  | Action                                                                                                                                                                                                                                                                                                                  | System Response                                                                                                                                                                       |
| --- | ------ | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 16a | User   | **Option A:** Clicks "⚡ Crawl N Pages" (direct crawl)                                                                                                                                                                                                                                                                  | Uses default settings                                                                                                                                                                 |
| 16b | User   | **Option B:** Clicks "⚙ Settings" → adjusts crawl settings + auth                                                                                                                                                                                                                                                       | —                                                                                                                                                                                     |
| 17  | System | `PATCH /:indexId/sources/:sourceId/crawl-config` `{ configVersion: 5, wizardStep: 'configured', settings: { scope: 'limited', rendering: 'hybrid', maxPages: 500, maxDepth: 10, requestDelay: 1000, cleanup: 'standard', respectRobotsTxt: true, deduplicate: true, cookieConsent: false }, auth: { method: 'none' } }` | Settings + auth persisted (**BUG FIX** — never saved before). configVersion → 6.                                                                                                      |
| 18  | System | Frontend gathers URLs from buckets: `GET /:indexId/sources/:sourceId/sections/:sectionId/urls?offset=0&limit=100` (paginated)                                                                                                                                                                                           | Reads URLs from SourceUrlBucket. May require multiple requests for large sitemaps.                                                                                                    |
| 19  | System | `POST /crawl/batch { urls: [...], sourceId, indexId, ... }` (no draftId)                                                                                                                                                                                                                                                | Backend: (a) Verifies `source.status === 'configuring'`. (b) Updates `source.status = 'pending'`, `crawlConfig.wizardStep = null`, clears `configExpiresAt`. (c) Enqueues BullMQ job. |
| 20  | System | `PATCH /:indexId/sources/:sourceId/crawl-config` `{ configVersion: 6, wizardStep: null, crawlJobId: 'job-123' }`                                                                                                                                                                                                        | Job ID linked to source. configVersion → 7.                                                                                                                                           |
| 21  | User   | Sees crawl progress (Step 4 / State4Crawl)                                                                                                                                                                                                                                                                              | Frontend polls CrawlJob status. Source status in DB: `pending`. Display shows "Crawling".                                                                                             |

### Step 4: Crawl Runs + Completion

| #   | Actor  | Action                                    | System Response                                                                                                                                                             |
| --- | ------ | ----------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 22  | System | Worker picks up BullMQ job                | Worker starts crawling pages. Existing sync pipeline manages `pending → syncing → active` transitions.                                                                      |
| 23  | System | First document ingested                   | Sync coordinator sets `source.status = 'syncing'` (existing behavior)                                                                                                       |
| 24  | System | Documents processed successfully          | Sync coordinator sets `source.status = 'active'` (existing behavior)                                                                                                        |
| 25  | System | Worker post-crawl cleanup                 | `SourceConfigState.deleteOne({ sourceId })` — remove discovery blob. `SourceUrlBucket.deleteMany({ sourceId })` — remove URL buckets. Clear `configExpiresAt` if still set. |
| 26  | User   | Sees "Active · 187 pages" in SourcesTable | Crawl complete. Source is permanent. crawlConfig.settings and auth persist for future recrawl.                                                                              |

---

## Journey 2: Close Mid-Discovery → Resume Later

### Close

| #   | Actor  | Action                                         | System Response                                                                                                                                                         |
| --- | ------ | ---------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 1   | User   | Is on Step 2, discovery 60% done               | Discovery state auto-saved within last 5s to SourceConfigState                                                                                                          |
| 2   | User   | Clicks X (close wizard)                        | —                                                                                                                                                                       |
| 3   | System | Shows dialog: "Save & Close" / "Delete Source" | —                                                                                                                                                                       |
| 4a  | User   | **Clicks "Save & Close"**                      | Source stays `status: 'configuring'`. Discovery state already auto-saved. Wizard closes.                                                                                |
| 4b  | User   | **Clicks "Delete Source"**                     | `DELETE /:indexId/sources/:sourceId` → cascades: SourceConfigState deleted, SourceUrlBucket deleted, source deleted, index.sourceCount decremented. Clean — no orphans. |
| 5   | System | SourcesTable refreshes                         | Shows "◐ epson.com · Configuring · Step 2 of 3" (from `crawlConfig.wizardStep: 'sections_ready'` or `'profiling'`)                                                      |

### Resume

| #   | Actor  | Action                                                                         | System Response                                                                                                                              |
| --- | ------ | ------------------------------------------------------------------------------ | -------------------------------------------------------------------------------------------------------------------------------------------- |
| 6   | User   | Later, returns to KB → sees configuring source row                             | Source visible in SourcesTable with configuring badge                                                                                        |
| 7   | User   | Clicks the configuring source row                                              | —                                                                                                                                            |
| 8   | System | `GET /:indexId/sources/:sourceId`                                              | Loads source with `crawlConfig` (wizardStep, profile, sections, strategy, settings, auth, groupStrategies, configVersion)                    |
| 9   | System | Checks `source.createdBy === currentUser`                                      | If YES: opens editable wizard. If NO: opens read-only view (Journey 6).                                                                      |
| 10  | System | `GET /:indexId/sources/:sourceId/discovery-state`                              | Loads `SourceConfigState` with discovery tree, discovered URLs, objectives, coverage, iterations. Up to 5MB.                                 |
| 11  | System | Wizard opens at saved step                                                     | Restores: URL (from sourceConfig.url), profile, sections, strategy, settings, auth from crawlConfig. Discovery state from SourceConfigState. |
| 12  | System | Shows resume banner: "Resume discovery?" / "Start fresh" / "Skip to configure" | —                                                                                                                                            |
| 13a | User   | **Clicks "Resume discovery"**                                                  | Discovery engine resumes from saved state. Auto-saves continue.                                                                              |
| 13b | User   | **Clicks "Start fresh"**                                                       | Clears discovery state. Starts profiling again from URL.                                                                                     |
| 13c | User   | **Clicks "Skip to configure"**                                                 | Jumps to Step 3 with current sections.                                                                                                       |

---

## Journey 3: Browser Crash → Recovery

| #   | Actor  | Action                                                         | System Response                                                                                                                        |
| --- | ------ | -------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------- |
| 1   | User   | Is mid-discovery, browser crashes                              | Last auto-save was within 5s                                                                                                           |
| 2   | System | Source persists at `status: 'configuring'`                     | crawlConfig has last-saved wizard state. SourceConfigState has last-saved discovery state. SourceUrlBucket has any saved section URLs. |
| 3   | User   | Reopens browser → navigates to KB                              | —                                                                                                                                      |
| 4   | User   | Sees "◐ epson.com · Configuring · Step 2 of 3" in SourcesTable | —                                                                                                                                      |
| 5   | User   | Clicks the row                                                 | Same as Journey 2 resume (steps 8-13)                                                                                                  |
| 6   | System | Data loss: at most 5 seconds of discovery progress             | Everything else intact — profile, sections, strategy, settings, auth all persisted.                                                    |

---

## Journey 4: Recrawl Existing Active Source

| #   | Actor  | Action                                                                                                                                                     | System Response                                                                                                                                                                                            |
| --- | ------ | ---------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 1   | User   | Has active source "epson.com" with 187 pages                                                                                                               | —                                                                                                                                                                                                          |
| 2   | User   | Clicks "Recrawl" action on source row                                                                                                                      | —                                                                                                                                                                                                          |
| 3   | System | Wizard opens pre-filled from `source.crawlConfig`                                                                                                          | Restores: settings (maxPages, rendering, cleanup, etc.), auth (method, token, headers), sections (from last crawl). **BUG FIX:** Settings and auth were never persisted before — always reset to defaults. |
| 4   | User   | Adjusts settings (e.g., maxPages: 1000, adds auth token)                                                                                                   | —                                                                                                                                                                                                          |
| 5   | System | `PATCH /:indexId/sources/:sourceId/crawl-config` `{ configVersion, settings: { maxPages: 1000, ... }, auth: { method: 'bearer', bearerToken: 'abc...' } }` | Settings + auth updated on active source. **Source status stays `active`** — no transition to configuring.                                                                                                 |
| 6   | User   | Clicks "Start Crawl"                                                                                                                                       | —                                                                                                                                                                                                          |
| 7   | System | Frontend gathers URLs from sections (if URL buckets exist) or uses existing section URLs                                                                   | —                                                                                                                                                                                                          |
| 8   | System | `POST /crawl/batch { urls, sourceId, indexId, ... }`                                                                                                       | Backend: (a) Verifies `source.status === 'active'` (recrawl path). (b) Status stays `active`. (c) `wizardStep = null`. (d) New CrawlJob enqueued.                                                          |
| 9   | System | New CrawlJob runs                                                                                                                                          | Frontend shows "Crawling" badge (derived from active CrawlJob). Old documents gradually replaced by new ones.                                                                                              |
| 10  | System | Worker post-crawl cleanup                                                                                                                                  | Deletes any SourceConfigState/SourceUrlBucket (unlikely for recrawl — no discovery phase).                                                                                                                 |
| 11  | User   | Sees "Active · 312 pages" (updated count)                                                                                                                  | Recrawl complete. crawlConfig retains updated settings + auth for future recrawls.                                                                                                                         |

**Key difference from Journey 1:** Source never leaves `active`. No `configuring` phase. No `configExpiresAt`. Settings pre-filled instead of defaults.

---

## Journey 5: Multiple Users, Same KB

| #   | Actor  | Action                                                          | System Response                                                                                                                         |
| --- | ------ | --------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------- |
| 1   | User A | Configures "epson.com" → source created with `createdBy: userA` | Source visible to all project members in SourcesTable                                                                                   |
| 2   | User B | Sees "◐ epson.com · Configuring · Step 2 of 3" in SourcesTable  | —                                                                                                                                       |
| 3   | User B | Clicks the configuring source row                               | —                                                                                                                                       |
| 4   | System | `GET /:indexId/sources/:sourceId`                               | Source loaded. `source.createdBy !== userB` detected.                                                                                   |
| 5   | System | Opens **read-only** wizard view                                 | User B can see profile, sections, discovery tree, settings — but all controls are disabled. No save/edit capability.                    |
| 6   | User B | Tries to type "epson.com" in URL entry                          | No domain check — a new source is created for User B. Both users can have independent configurations for the same domain.               |
| 7   | System | PATCH/PUT endpoints reject User B on User A's source            | `PATCH /crawl-config`, `PUT /discovery-state`, `PUT /sections/urls` all check `source.createdBy === req.userId`. Return 403 for User B. |

---

## Journey 6: Abandoned Wizard → TTL Cleanup

| #   | Actor  | Action                                            | System Response                                                                                                                                             |
| --- | ------ | ------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 1   | User   | Creates source, starts configuring, never returns | Source at `status: 'configuring'`, `crawlConfig.configExpiresAt: now+30d`                                                                                   |
| 2   | System | 30 days pass                                      | —                                                                                                                                                           |
| 3   | System | MongoDB TTL index fires on `configExpiresAt`      | SearchSource document auto-deleted                                                                                                                          |
| 4   | System | MongoDB TTL index fires on SourceConfigState      | SourceConfigState document auto-deleted (same `configExpiresAt` timestamp)                                                                                  |
| 5   | System | MongoDB TTL index fires on SourceUrlBucket        | SourceUrlBucket documents auto-deleted (same `configExpiresAt` timestamp)                                                                                   |
| 6   | System | No orphans remain                                 | All three collections cleaned up consistently. index.sourceCount NOT decremented (TTL deletes bypass application logic — acceptable for abandoned sources). |

**Note:** `index.sourceCount` may become stale by 1 for abandoned sources. This is acceptable — the count is a denormalized hint, not an authoritative total. A background reconciliation job can fix it periodically if needed.

---

## Journey 7: Legacy Draft-Status Source

| #   | Actor  | Action                                                                                  | System Response                                                                               |
| --- | ------ | --------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------- |
| 1   | System | Pre-existing source with `status: 'draft'` (created by old draft system)                | No `crawlConfig` on this source. `sourceConfig.draftId` points to expired/deleted CrawlDraft. |
| 2   | User   | Sees source row in SourcesTable                                                         | Frontend maps `'draft'` to configuring visual treatment (same ◐ icon, muted style)            |
| 3   | User   | Clicks the row                                                                          | —                                                                                             |
| 4   | System | Checks for `crawlConfig` on source                                                      | `crawlConfig` is null/undefined — this is a legacy source                                     |
| 5   | System | Shows message: "This source was started with an older version. Delete and start fresh." | Only action available: Delete                                                                 |
| 6   | User   | Clicks "Delete"                                                                         | `DELETE /:indexId/sources/:sourceId` → source deleted, sourceCount decremented. Clean.        |

**Natural decay:** No migration needed. Users encounter these rarely and can delete them. Old CrawlDraft documents expire via their own 30-day TTL independently.

---

## Cross-Journey Verification Matrix

| Must Not Regress Row         | J1            | J2           | J3        | J4          | J5              | J6          | J7        |
| ---------------------------- | ------------- | ------------ | --------- | ----------- | --------------- | ----------- | --------- |
| Resume mid-discovery         | —             | ✅ Step 10   | ✅ Step 5 | —           | —               | —           | —         |
| Resume mid-sitemap           | —             | ✅ Same flow | ✅ Same   | —           | —               | —           | —         |
| Resume direct URLs           | —             | ✅ Same flow | ✅ Same   | —           | —               | —           | —         |
| No blocking on same-domain   | ✅ Step 3     | —            | —         | —           | —               | —           | —         |
| Section URL persistence      | ✅ Step 12,18 | —            | —         | —           | —               | —           | —         |
| Crawl submission             | ✅ Step 19    | —            | —         | ✅ Step 8   | —               | —           | —         |
| Auth config persisted        | ✅ Step 17    | ✅ Step 11   | ✅ Step 6 | ✅ Step 3,5 | —               | —           | —         |
| Crawl settings persisted     | ✅ Step 17    | ✅ Step 11   | ✅ Step 6 | ✅ Step 3,5 | —               | —           | —         |
| Status transitions           | ✅ Step 19-24 | —            | —         | ✅ Step 8   | —               | ✅ Step 3   | —         |
| Cross-user visibility        | —             | —            | —         | —           | ✅ All          | —           | —         |
| OCC                          | ✅ All PATCH  | ✅ All PATCH | —         | ✅ Step 5   | ✅ Step 8 (403) | —           | —         |
| Transient data cleanup       | ✅ Step 25    | ✅ Step 4b   | —         | ✅ Step 10  | —               | ✅ Step 3-5 | —         |
| Abandoned cleanup (TTL)      | —             | —            | —         | —           | —               | ✅ All      | —         |
| Cascade delete               | —             | ✅ Step 4b   | —         | —           | —               | —           | ✅ Step 6 |
| Legacy draft sources         | —             | —            | —         | —           | —               | —           | ✅ All    |
| No duplicate source creation | ✅ Step 19    | —            | —         | ✅ Step 8   | —               | —           | —         |
| sourceCount accurate         | ✅ Step 3,26  | ✅ Step 4b   | —         | —           | —               | ⚠️ Note     | ✅ Step 6 |

**⚠️ J6 sourceCount:** TTL deletes don't decrement sourceCount. Acceptable for rare abandoned sources.

---

## Gaps Found During Journey Verification

None. All "Must Not Regress" rows have at least one journey covering them. All journeys have complete user + system steps with no dead ends or undefined states.

### UX Spec Journey Comparison

| UX Spec Journey                  | This Doc Journey                | Delta                                                                                                                                                                         |
| -------------------------------- | ------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| J1: Happy Path — New Crawl       | Journey 1                       | **Added:** system steps (API calls, status transitions, configVersion tracking, SourceConfigState lazy creation). **Removed:** domain check step — always creates new source. |
| J2: Close Mid-Discovery → Resume | Journey 2                       | **Added:** createdBy check (step 9), cascade delete details (step 4b), resume banner options                                                                                  |
| J3: Same Domain Re-entry         | **REMOVED** — no domain check   | Domain uniqueness not enforced. Users manage duplicates via sources table. Simplifies implementation significantly.                                                           |
| J4: Browser Crash → Recovery     | Journey 3                       | **Added:** data loss quantification (max 5s), exact restoration sequence                                                                                                      |
| J5: Recrawl Existing Source      | Journey 4                       | **Added:** batch endpoint accepts active status, no status transition, worker cleanup (minimal), pre-fill from persisted config                                               |
| J6: Multiple Users, Same KB      | Journey 5                       | **Added:** 403 enforcement on PATCH/PUT endpoints, read-only wizard view                                                                                                      |
| (not in UX spec)                 | Journey 6: Abandoned Wizard TTL | **NEW:** TTL cleanup across all 3 collections, sourceCount stale note                                                                                                         |
| (not in UX spec)                 | Journey 7: Legacy Draft Source  | **NEW:** graceful handling of pre-existing draft-status sources                                                                                                               |

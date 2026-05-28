# SharePoint Connector — Complete System Deep Dive

**Date:** 2026-03-22
**Purpose:** End-to-end architecture, capability matrix, and gap analysis for the SharePoint enterprise connector system.

---

## 1. CAPABILITY MATRIX

| Capability                                 | Status             | Evidence                                                                                    |
| ------------------------------------------ | ------------------ | ------------------------------------------------------------------------------------------- |
| Connector CRUD (create/read/update/delete) | ✅ WORKING         | `connectors.ts` routes, `connector.service.ts` CRUD functions                               |
| OAuth Device Code Flow                     | ✅ WORKING         | `connector.service.ts:409-435`, `MicrosoftOAuthProvider.requestDeviceCode()`                |
| OAuth Authorization Code Flow              | ✅ WORKING         | `connector.service.ts:438-471`, state/CSRF validation, code exchange                        |
| OAuth Client Credentials Flow              | ✅ WORKING         | `connector.service.ts:474-510`, app-only token acquisition                                  |
| Auth status polling                        | ✅ WORKING         | `connector.service.ts:518-616`, polls device code, checks expiry                            |
| OAuth token revocation                     | ✅ WORKING         | `connector.service.ts:683-698`                                                              |
| Resource discovery (sites, drives)         | ✅ WORKING         | `connector-discovery-worker.ts`, `SharePointConnector`, `quick-setup-orchestrator.ts`       |
| Discovery profiling (file types, sizes)    | ✅ WORKING         | `connector-discovery-worker.ts` mode `discover_and_profile`                                 |
| Recommendation generation                  | ✅ WORKING         | `RecommendationEngineService`, `connector-discovery.ts:419-454`                             |
| Quick setup (discover+recommend)           | ✅ WORKING         | `connector-discovery.ts:551-608`, `quick-setup-orchestrator.ts`                             |
| Recommendation acceptance                  | ✅ WORKING         | `connector-discovery.ts:496-541`, `acceptRecommendation()`                                  |
| Site selection (include/exclude)           | ✅ WORKING         | `connector-discovery.ts:308-410`, validates against discovery                               |
| Full sync (document enumeration)           | ✅ WORKING         | `connector-sync-worker.ts`, `SharePointConnector`, `full-sync-coordinator.ts`               |
| Delta sync (incremental via tokens)        | ✅ WORKING         | `connector-sync-worker.ts`, `delta-sync-coordinator.ts`, `delta-token-manager.ts`           |
| Sync progress tracking                     | ✅ WORKING         | `connector-sync-worker.ts:352` uses `job.updateProgress(100)`                               |
| Sync pause/resume/stop/restart             | ✅ WORKING         | `connector.service.ts` pause/resume/stop/restart functions, `CancellationChecker`           |
| Ingestion pipeline trigger after sync      | ✅ WORKING         | `connector-sync-worker.ts:373-398` enqueues to `QUEUE_INGESTION`                            |
| Docling extraction for PDFs                | ✅ WORKING         | `connector-sync-worker.ts:292` enqueues to `QUEUE_DOCLING_EXTRACTION`                       |
| Filter configuration (file types, paths)   | ✅ WORKING         | Routes at `connectors.ts:161-215`, `SharePointFilterEngine`                                 |
| Filter templates (predefined sets)         | ✅ WORKING         | `connectors.ts:175-185`, `connector.service.ts` `getFilterTemplates()`                      |
| Filter preview (dry-run)                   | ✅ WORKING         | `connectors.ts:204-215`, `connector.service.ts` `previewFilters()`                          |
| Permission crawling                        | ✅ WORKING         | `connector-permission-crawl-worker.ts`, `SharePointPermissionCrawler`                       |
| Permission mode management                 | ✅ WORKING         | `connectors.ts:365-376`, modes: full/simplified/disabled                                    |
| Delta token management                     | ✅ WORKING         | `connectors.ts:310-336`, list/reset per drive                                               |
| Distributed locking                        | ✅ WORKING         | `connector-sync-worker.ts` uses `DistributedLockManager`                                    |
| Sync checkpoint (crash recovery)           | ✅ WORKING         | `SyncCheckpoint` model, `connector-sync-worker.ts:401-407`                                  |
| Webhook subscription creation              | ⚠️ STUBBED         | `SharePointWebhookManager` exists in package, routes not mounted                            |
| Webhook notification receiving             | ❌ DEAD CODE       | `routes/webhooks.ts` exists but never imported in `server.ts`                               |
| Webhook notification processing            | ❌ DEAD CODE       | `webhook-notification-worker.ts` exists but never started in `workers/index.ts`             |
| Webhook subscription renewal               | ⚠️ STUBBED         | `scheduler/webhook-renewal.ts` uses `accessToken: 'mock-token'`                             |
| Webhook subscription cleanup               | ⚠️ STUBBED         | Same file, same mock token issue                                                            |
| Delta sync scheduler (hourly auto)         | ⚠️ STUB            | `scheduler/connector-delta-sync.ts` only updates timestamps, never enqueues real sync       |
| Scheduler startup                          | ❌ DEAD CODE       | `startScheduledJobs()` never called from `server.ts`                                        |
| Auto-pause on consecutive failures         | ❌ NOT IMPLEMENTED | `errorState.isPaused` field exists but no auto-pause logic                                  |
| Vector store cleanup on delete             | ❌ NOT IMPLEMENTED | `deleteConnector()` deletes source+connector but not vector embeddings                      |
| Permission-based query filtering           | ❓ UNVERIFIED      | `PermissionGraphService` (Neo4j) initialized but integration with search query not verified |

---

## 2. COMPLETE USER FLOW (end-to-end)

### Step 1: User opens Knowledge Base and navigates to Data tab

- **Screen:** KB Detail Page → Data tab → `SourcesTable` + `AddSourceButton`
- Shows list of existing sources + "Add Source" button
- Fetches connectors via `fetchEnterpriseConnectors(indexId)` → Next.js proxy → `GET /api/indexes/:indexId/connectors`

### Step 2: User clicks "Add Source" → selects SharePoint

- **Screen:** `AddSourceButton` opens type picker dialog → user clicks SharePoint tile
- Opens `EnterpriseConnectorWizard` as dialog

### Step 3: Configure (Wizard Step 1)

- User selects auth method (Device Code / Auth Code / Client Credentials)
- User enters Azure AD Client ID, Tenant ID, and optionally Client Secret
- Fields validated (GUID format for tenantId)
- On submit: `POST /api/indexes/:indexId/connectors` → creates `ConnectorConfig` + `SearchSource` in DB

### Step 4: Authenticate (Wizard Step 2)

- Wizard calls `POST /api/connectors/:connectorId/auth/initiate`
- **Device Code:** Shows user code + link to microsoft.com/devicelogin. Polls `GET /api/connectors/:connectorId/auth/status` every 3s
- **Auth Code:** Opens popup to Microsoft login. Callback exchanges code for tokens via `POST /api/connectors/auth/callback`
- **Client Credentials:** Immediate token acquisition, no user interaction
- Token stored as `EndUserOAuthToken` (AES-256-GCM encrypted), linked to connector via `oauthTokenId`

### Step 5: Setup Path Selection (Wizard Step 3)

- User chooses "Quick Setup" or "Custom Setup"
- **Quick Setup:** `POST /api/connectors/:connectorId/quick-setup` → discover + profile + recommend in one step
- **Custom Setup:** `POST /api/connectors/:connectorId/discover` → discovery only

### Step 6: Discovery Progress (Wizard Step 4)

- Wizard polls `GET /api/connectors/:connectorId/discovery` every 4s
- `connector-discovery` BullMQ worker:
  1. Discovers sites via `graphClient.getSites()`, drives via `graphClient.getDrives(siteId)`
  2. Profiles content (file types, sizes, update frequency)
  3. Stores in `ConnectorDiscovery` model (7-day TTL)
  4. If `quick_setup`: auto-generates `ConnectorRecommendation` via `RecommendationEngineService`

### Step 7: Review & Accept (Wizard Step 5)

- Shows discovered sites, recommendation scores (Activity 30% + Size 20% + Content 20% - Sensitivity 30%)
- User can customize site selection: `POST /api/connectors/:connectorId/select-sites`
- `POST /api/connectors/:connectorId/recommendations/:id/accept`:
  - Builds `filterConfig` from recommendation (sites, content types)
  - Applies to `ConnectorConfig` with `configurationSource: 'quick_setup'`
  - Optionally triggers full sync + schema discovery

### Step 8: Sync Execution (background)

- `connector-sync-worker` (BullMQ, concurrency 1):
  1. Acquires distributed lock `sync-lock:{indexId}:{connectorId}` (1h TTL)
  2. Loads OAuth token, creates `SharePointConnector`
  3. Runs full sync: enumerate sites → drives → files via `getDriveItemsStream()` (streaming BFS)
  4. Per document: filter → create `SearchDocument` → download content → upload to S3/local
  5. After ALL docs processed: enqueues ONE bulk `QUEUE_INGESTION` job
  6. For PDFs during sync: also enqueues to `QUEUE_DOCLING_EXTRACTION`
  7. Establishes per-drive delta tokens for future incremental syncs
  8. Saves checkpoint every 100 docs (crash recovery)

### Step 9: Ingestion Pipeline (standard, shared with all sources)

- `ingestion-worker` → `extraction-worker`/`docling-extraction-worker` → `page-processing-worker` → `canonical-mapper-worker` → `enrichment-worker` → `embedding-worker`
- Chunking: 3 strategies (token-based, markdown-aware, page-based)
- Embedding: BGE-M3/OpenAI/Cohere → vector store (OpenSearch/Qdrant/PGVector)
- Documents become searchable

### Step 10: Ongoing Management

- `ConnectorDetailPanel` (slide-over): sync status, errors, filter config, permissions
- User can start/stop/pause/resume sync, trigger delta sync manually
- Can modify filter config (file types, folder paths, templates)
- Can re-authenticate if token expires

### UX Quality Notes

- ✅ Wizard flow is well-structured with clear step progression
- ✅ Device code polling with visual feedback
- ✅ Quick setup reduces configuration to one click
- ⚠️ No real-time sync progress in UI (must poll `/sync/status`)
- ⚠️ Delta sync must be triggered manually (scheduler never runs)
- ❌ No visual indicator of indexed vs total documents
- ❌ No webhook-based real-time updates when SharePoint content changes

---

## 3. ARCHITECTURE DIAGRAM

```
STUDIO (Next.js :5173)                  SEARCH-AI (Express :3005)
========================                ========================

AddSourceButton                         GET  /api/indexes/:id/connectors
EnterpriseConnectorWizard               POST /api/indexes/:id/connectors
  |                                     POST /api/connectors/:id/auth/initiate
  |  (Next.js API proxy routes)         GET  /api/connectors/:id/auth/status
  |  apps/studio/src/app/api/           POST /api/connectors/:id/auth/callback
  |  search-ai/connectors/...           POST /api/connectors/:id/discover
  |  ↓ proxyToSearchEngine()            GET  /api/connectors/:id/discovery
  |  ↓ http://localhost:3005/api/...    POST /api/connectors/:id/quick-setup
  v                                     POST /api/connectors/:id/recommendations
ConnectorDetailPanel                    POST /api/connectors/:id/recommendations/:id/accept
ConnectorFilterSection                  POST /api/connectors/:id/sync/start|stop|pause|resume
SiteSelector                            GET  /api/connectors/:id/sync/status
ConnectorDocumentsDialog                POST /api/connectors/:id/sync/delta
                                        POST /api/connectors/:id/permissions/crawl
                                        POST /api/connectors/:id/filters/preview

        SearchAI Service Layer
        ======================
        connector.service.ts ──> connector.repository.ts ──> ConnectorConfig (MongoDB)
                                                              EndUserOAuthToken
                                                              SearchSource
        quick-setup-orchestrator.ts ──> ConnectorDiscovery
        recommendation-engine.service.ts ──> ConnectorRecommendation

        BullMQ Workers (Redis)
        ======================
        connector-discovery  ─┬─> SharePointConnector.discoverResources()
                              └─> RecommendationEngineService (if quick_setup)
        connector-sync       ─┬─> SharePointConnector.fullSync() / deltaSync()
                              ├─> Creates SearchDocument records
                              ├─> Enqueues QUEUE_DOCLING_EXTRACTION (PDFs)
                              └─> Enqueues QUEUE_INGESTION (all docs)
        connector-permission-crawl ──> SharePointPermissionCrawler ──> Neo4j

        Standard Ingestion Pipeline
        ===========================
        ingestion → extraction → docling-extraction → page-processing
            → canonical-mapper → enrichment → embedding → (vector store)

        NOT RUNNING (dead code)
        =======================
        webhook-notification-worker  (exists, not started)
        webhooks.ts routes           (exists, not mounted)
        scheduler/index.ts           (exists, never called)

        SharePoint Package (packages/connectors/sharepoint/)
        ====================================================
        GraphClient           → Microsoft Graph API v1.0
        MicrosoftOAuthProvider → Azure AD OAuth v2.0 endpoints
        FullSyncCoordinator   → Drive enumeration, file download, delta token establish
        DeltaSyncCoordinator  → Per-drive delta token tracking, incremental sync
        DeltaTokenManager     → Per-drive delta token persistence (MongoDB)
        SharePointFilterEngine → OData pre-fetch + local post-fetch evaluation
        SharePointPermissionCrawler → ACL crawling to Neo4j graph
        SharePointResourceDiscovery → Site/drive discovery + content profiling
        SharePointWebhookManager → Subscription lifecycle (NOT WIRED TO SERVER)
```

---

## 4. QUEUE & NOTIFICATION TOPOLOGY

### Active Queues (connector-related, started in workers/index.ts)

| Queue Name                   | Trigger                                             | Worker                                 | Concurrency | Status  |
| ---------------------------- | --------------------------------------------------- | -------------------------------------- | ----------- | ------- |
| `connector-discovery`        | `POST /connectors/:id/discover` or quick-setup      | `connector-discovery-worker.ts`        | 2           | RUNNING |
| `connector-sync`             | `POST /connectors/:id/sync/start` or recommendation | `connector-sync-worker.ts`             | 1           | RUNNING |
| `connector-permission-crawl` | `POST /connectors/:id/permissions/crawl`            | `connector-permission-crawl-worker.ts` | 2           | RUNNING |

### Downstream Queues (triggered by connector-sync after completion)

| Queue Name           | Trigger                          | Worker                         | Status  |
| -------------------- | -------------------------------- | ------------------------------ | ------- |
| `ingestion`          | After sync completes with docs>0 | `ingestion-worker.ts`          | RUNNING |
| `docling-extraction` | For PDF files during sync        | `docling-extraction-worker.ts` | RUNNING |

### Dead/Stubbed Queues

| Queue Name                     | Would-be Trigger             | Worker                            | Status                                          |
| ------------------------------ | ---------------------------- | --------------------------------- | ----------------------------------------------- |
| `webhook-notification`         | `POST /api/webhooks/...`     | `webhook-notification-worker.ts`  | NOT STARTED — worker not in startWorkers()      |
| `scheduled-delta-sync`         | Cron `0 * * * *` (hourly)    | Inline in scheduler/index.ts      | NEVER STARTED — startScheduledJobs() not called |
| `scheduled-delta-cleanup`      | Cron `0 3 * * 0` (Sun 3AM)   | Inline in scheduler/index.ts      | NEVER STARTED                                   |
| `scheduled-webhook-renewal`    | Cron `0 */12 * * *` (12h)    | Inline in scheduler/index.ts      | NEVER STARTED + uses mock token                 |
| `scheduled-webhook-cleanup`    | Cron `0 2 * * *` (daily 2AM) | Inline in scheduler/index.ts      | NEVER STARTED + uses mock token                 |
| `permission-recrawl-scheduler` | Cron `0 2 * * 0` (Sun 2AM)   | `permission-recrawl-scheduler.ts` | NEVER STARTED — setup never called              |

### Notification Channels

| Channel                         | Transport                 | Purpose                        | Status                                          |
| ------------------------------- | ------------------------- | ------------------------------ | ----------------------------------------------- |
| `progress:{jobId}`              | Redis pub/sub → WebSocket | Real-time sync progress to UI  | EXISTS but connector sync doesn't publish to it |
| `connector-sync:{jobId}:cancel` | Redis pub/sub             | Fast cancellation signal (<5s) | WORKING                                         |
| `errorState.isPaused` (DB)      | MongoDB poll (30s)        | Fallback pause detection       | WORKING                                         |

---

## 5. KNOWN GAPS & BROKEN FEATURES

### Critical (affects core functionality)

1. **Scheduler never started** — `startScheduledJobs()` in `scheduler/index.ts` is never called from `server.ts`. ALL scheduled jobs are dead code at runtime.

2. **Delta sync scheduler is a stub** — Even if started, `triggerStaleDeltaSyncs()` only updates `syncState.lastDeltaSyncAt` timestamp. Does NOT enqueue sync jobs. Comment: "For now, we'll just update the timestamp."

3. **Webhook routes not mounted** — `routes/webhooks.ts` exists (handles Microsoft Graph notifications) but is never imported in `server.ts`. SharePoint cannot send real-time change notifications.

4. **Webhook notification worker not started** — `webhook-notification-worker.ts` exists with deduplication logic and delta sync triggering, but is NOT in `startWorkers()`.

### High (stubbed functionality)

5. **Webhook renewal uses mock token** — `scheduler/webhook-renewal.ts` lines 67-68: `new GraphClient({ accessToken: 'mock-token' })`. Renewals would fail with auth errors.

6. **No auto-pause on failures** — `errorState.consecutiveFailures` is incremented but never checked against a threshold. Connectors can fail indefinitely.

7. **No vector store cleanup on delete** — `deleteConnector()` deletes `ConnectorConfig` + `SearchSource` but orphaned vectors remain in the vector store forever. MongoDB index `{ isDeleted: 1, deletedAt: 1 }` was created for a cleanup job that was never built.

8. **Connector deletion doesn't clean up webhooks** — `deleteConnector()` does NOT call `unsubscribeAll()` on WebhookManager. Orphaned subscriptions linger until daily cleanup.

### Medium (UX gaps)

9. **No real-time sync progress in UI** — WebSocket system exists but connector sync doesn't publish to it. UI must poll `/sync/status`.

10. **Permission recrawl scheduler not wired** — `setupPermissionRecrawlScheduler()` exists but is never called.

11. **`console.log` in server code** — `connector-delta-sync.ts`, `webhook-renewal.ts`, `base-sync-coordinator.ts` use raw console instead of `createLogger()`.

12. **Hardcoded developer path** — `base-sync-coordinator.ts` line 67: `/home/mounikavemula/kore/abl-platform/logs/sync-debug.log`.

13. **IMPLEMENTATION_STATUS.md claims 100% complete** — Lists 18/18 tasks done while scheduler, webhooks, and auto-pause are non-functional.

---

## 6. THREE SEPARATE "CONNECTOR" SYSTEMS

The ABL Platform has three entirely distinct systems that all use the word "connector":

### A. SearchAI Enterprise Connectors (THIS DOCUMENT)

- **Purpose:** Ingest documents from enterprise data sources (SharePoint, Jira, Confluence, etc.) into the search index
- **Location:** `packages/connectors/sharepoint/`, `packages/connectors/base/`, `apps/search-ai/src/services/connector.service.ts`
- **Models:** `ConnectorConfig`, `ConnectorDiscovery`, `ConnectorRecommendation`, `EndUserOAuthToken`, `DriveDeltaToken`, `SyncCheckpoint`, `WebhookSubscriptionConnector`
- **UX:** `EnterpriseConnectorWizard`, `ConnectorDetailPanel`, `AddSourceButton`
- **Auth:** OAuth device code, authorization code, client credentials (Microsoft-specific)

### B. Agent Tool Connections (`packages/connectors/src/`)

- **Purpose:** Enable AI agents to use external tools (Slack, GitHub, HTTP, etc.) during conversations
- **Package:** `@agent-platform/connectors` — wraps 26 ActivePieces connector pieces
- **Key files:** `connector-tool-executor.ts`, `workflow-tool-executor.ts`, `registry.ts`, `connection-service.ts`
- **UX:** `apps/studio/src/components/connections/` (ConnectionsPage, CatalogCard, OAuthFlowDialog)
- **Auth:** Generic OAuth2 via `ConnectionResolver` with distributed lock refresh

### C. Admin Channel Connections

- **Purpose:** Connect messaging channels (Teams, WhatsApp, Voice, Email) for end-user communication
- **Location:** `apps/studio/src/components/admin/ConnectorsPage.tsx`
- **UX:** Channel Connections + SDK Channels tabs in workspace admin

**These three systems share NO code.** Different models, different auth flows, different UX, different purposes.

---

## 7. UX COMPARISON: SharePoint vs Knowledge Base

| Aspect                 | Knowledge Base (File/URL)               | SharePoint Connector                                           |
| ---------------------- | --------------------------------------- | -------------------------------------------------------------- |
| Setup steps            | 1 (drag-drop files or paste URL)        | 5 (configure + auth + path + discovery + review)               |
| Auth required          | None                                    | OAuth with Azure AD (requires App Registration)                |
| Time to first document | Seconds                                 | Minutes (auth + discovery + sync)                              |
| Progress feedback      | Real-time progress bar via WebSocket    | Polling-based sync status only                                 |
| Ongoing updates        | Manual re-upload or re-crawl            | Manual delta sync (scheduler broken)                           |
| Error handling         | Toast notifications                     | Detailed error state in ConnectorDetailPanel                   |
| Filter configuration   | N/A (you upload what you want)          | Rich: file types, folder paths, templates, preview             |
| Permission management  | N/A                                     | Full/simplified/disabled modes with crawling                   |
| UI components          | ~3 (upload zone, source list, doc list) | ~7 (wizard, detail panel, filters, site selector, docs dialog) |
| i18n coverage          | Full                                    | Full                                                           |

### Where SharePoint UX falls short:

1. **No real-time sync progress** — KB upload has a progress bar; connector sync requires polling
2. **Complex initial setup** — 5 wizard steps vs drag-and-drop
3. **Delta sync not automated** — No working scheduler for incremental updates
4. **No webhook push updates** — Content changes in SharePoint trigger nothing
5. **Discovery step feels slow** — No cancel/back during long discovery
6. **No delegated authentication** — App developer knows the config but may not have OAuth permissions. Security team has permissions but doesn't know the app. Device Code flow technically allows sharing a code, but there's no UX for delegation (no "invite someone to authenticate" flow, no tracking of who authenticated, no re-delegation for token refresh).

---

## 8. SIMPLIFICATION OPPORTUNITIES

### Dead code removal

1. Remove `ConnectorsTab.tsx` — 647 lines, never imported (replaced by `SourcesTable` + `AddSourceButton`)
2. Clean up or fix `routes/webhooks.ts` — Either mount it in `server.ts` or remove
3. Clean up or fix `webhook-notification-worker.ts` — Either start it or remove

### Quick wins (fix what exists)

4. **Wire the scheduler** — Add `startScheduledJobs()` call to `server.ts` after workers start
5. **Fix delta sync scheduler** — Replace timestamp-only update with actual `connector-sync` queue enqueue (~10 lines)
6. **Fix webhook renewal token** — Replace `'mock-token'` with real `EndUserOAuthToken` lookup
7. **Add auto-pause** — Check `consecutiveFailures >= 5` → set `isPaused = true` in connector-sync-worker error handler

### Backend capabilities NOT exposed in UI

8. **Filter preview** — API exists (`POST /filters/preview`) but no "preview what would be synced" button in UI
9. **Delta token management** — API exists (`GET/DELETE /delta-tokens`) but no UI to view/reset per-drive tokens
10. **Permission recrawl** — API exists (`POST /permissions/recrawl`) but no UI trigger

### UX streamlining

11. **Combine wizard steps** — "Setup Path" (quick vs custom) could be a toggle, not a full step
12. **Add WebSocket sync progress** — Wire `SyncProgressPublisher` to the existing WebSocket progress system
13. **Stream discovery results** — Instead of polling every 4s, show sites as they're discovered
14. **Unified source experience** — SharePoint source should feel like other sources (file, URL) in the Data tab, not a completely different wizard
15. **Delegated auth flow** — "Invite someone to authenticate" — developer configures, shares link, security team authenticates. Track who authenticated, support re-delegation on token refresh

---

## 9. FILE INVENTORY

### Frontend (Studio)

| File                                                                 | Purpose                                 |
| -------------------------------------------------------------------- | --------------------------------------- |
| `apps/studio/src/components/search-ai/EnterpriseConnectorWizard.tsx` | 5-step wizard (760+ lines)              |
| `apps/studio/src/components/search-ai/ConnectorDetailPanel.tsx`      | Slide-over management panel (765 lines) |
| `apps/studio/src/components/search-ai/ConnectorFilterSection.tsx`    | Filter configuration UI (691 lines)     |
| `apps/studio/src/components/search-ai/ConnectorDocumentsDialog.tsx`  | View synced documents (343 lines)       |
| `apps/studio/src/components/search-ai/SyncProgress.tsx`              | WebSocket sync progress (352 lines)     |
| `apps/studio/src/components/search-ai/SiteSelector.tsx`              | Site selection UI (295 lines)           |
| `apps/studio/src/components/search-ai/ConnectorsTab.tsx`             | **DEAD CODE** — never imported          |
| `apps/studio/src/components/search-ai/data/AddSourceButton.tsx`      | Source type picker + enterprise entry   |
| `apps/studio/src/components/search-ai/data/SourcesTable.tsx`         | Sources list in Data tab                |
| `apps/studio/src/api/search-ai.ts`                                   | API client (lines 2066-2399)            |
| `apps/studio/src/api/connector-extensions.ts`                        | Phase 3 extensions (stop, sites, WS)    |
| `apps/studio/src/hooks/useDiscoveredSites.ts`                        | SWR hooks for discovery                 |

### API Proxy (Next.js Routes)

| File                                                                                                            | Purpose                |
| --------------------------------------------------------------------------------------------------------------- | ---------------------- |
| `apps/studio/src/app/api/search-ai/indexes/[id]/connectors/route.ts`                                            | List/create connectors |
| `apps/studio/src/app/api/search-ai/connectors/[connectorId]/auth/initiate/route.ts`                             | Initiate auth          |
| `apps/studio/src/app/api/search-ai/connectors/[connectorId]/auth/status/route.ts`                               | Auth polling           |
| `apps/studio/src/app/api/search-ai/connectors/[connectorId]/discover/route.ts`                                  | Trigger discovery      |
| `apps/studio/src/app/api/search-ai/connectors/[connectorId]/discovery/route.ts`                                 | Get discovery results  |
| `apps/studio/src/app/api/search-ai/connectors/[connectorId]/quick-setup/route.ts`                               | Quick setup            |
| `apps/studio/src/app/api/search-ai/connectors/[connectorId]/recommendations/route.ts`                           | Get recommendations    |
| `apps/studio/src/app/api/search-ai/connectors/[connectorId]/recommendations/[recommendationId]/accept/route.ts` | Accept recommendation  |
| `apps/studio/src/app/api/search-ai/connectors/[connectorId]/sync/start/route.ts`                                | Start sync             |
| `apps/studio/src/app/api/search-ai/connectors/[connectorId]/sync/status/route.ts`                               | Sync status            |
| `apps/studio/src/app/api/connectors/auth/callback/route.ts`                                                     | OAuth callback         |
| `apps/studio/src/lib/search-ai-proxy.ts`                                                                        | Proxy utility          |

### Backend Routes (SearchAI)

| File                                               | Purpose                      | Lines |
| -------------------------------------------------- | ---------------------------- | ----- |
| `apps/search-ai/src/routes/connectors.ts`          | CRUD + auth + filters + sync | 403   |
| `apps/search-ai/src/routes/connector-discovery.ts` | Discovery + recommendations  | 611   |
| `apps/search-ai/src/routes/webhooks.ts`            | **DEAD CODE** — not mounted  | 180   |

### Services

| File                                                                          | Purpose                       | Lines |
| ----------------------------------------------------------------------------- | ----------------------------- | ----- |
| `apps/search-ai/src/services/connector.service.ts`                            | All connector business logic  | 1331  |
| `apps/search-ai/src/services/setup/quick-setup-orchestrator.ts`               | Discovery → recommend → apply | 265   |
| `apps/search-ai/src/services/recommendation/recommendation-engine.service.ts` | Scoring heuristics            | 443   |
| `apps/search-ai/src/repos/connector.repository.ts`                            | Data access layer             | 195   |

### Workers

| File                                                              | Purpose             | Started? |
| ----------------------------------------------------------------- | ------------------- | -------- |
| `apps/search-ai/src/workers/connector-discovery-worker.ts`        | Async discovery     | ✅ YES   |
| `apps/search-ai/src/workers/connector-sync-worker.ts`             | Full/delta sync     | ✅ YES   |
| `apps/search-ai/src/workers/connector-permission-crawl-worker.ts` | Permission crawling | ✅ YES   |
| `apps/search-ai/src/workers/webhook-notification-worker.ts`       | Graph notifications | ❌ NO    |
| `apps/search-ai/src/workers/index.ts`                             | Worker orchestrator | N/A      |

### Schedulers

| File                                                           | Purpose                | Running? |
| -------------------------------------------------------------- | ---------------------- | -------- |
| `apps/search-ai/src/scheduler/index.ts`                        | Scheduler orchestrator | ❌ NO    |
| `apps/search-ai/src/scheduler/connector-delta-sync.ts`         | Delta sync (STUB)      | ❌ NO    |
| `apps/search-ai/src/scheduler/webhook-renewal.ts`              | Webhook renewal (STUB) | ❌ NO    |
| `apps/search-ai/src/scheduler/permission-recrawl-scheduler.ts` | Permission recrawl     | ❌ NO    |

### SharePoint Connector Package

| File                                                                              | Purpose                    |
| --------------------------------------------------------------------------------- | -------------------------- |
| `packages/connectors/sharepoint/src/sharepoint-connector.ts`                      | Main connector class       |
| `packages/connectors/sharepoint/src/client/graph-client.ts`                       | Microsoft Graph API client |
| `packages/connectors/sharepoint/src/client/graph-types.ts`                        | Graph API types            |
| `packages/connectors/sharepoint/src/auth/microsoft-oauth-provider.ts`             | 3 OAuth flows + refresh    |
| `packages/connectors/sharepoint/src/sync/full-sync-coordinator.ts`                | Full sync orchestration    |
| `packages/connectors/sharepoint/src/sync/delta-sync-coordinator.ts`               | Delta sync orchestration   |
| `packages/connectors/sharepoint/src/sync/delta-token-manager.ts`                  | Per-drive delta tokens     |
| `packages/connectors/sharepoint/src/filters/sharepoint-filter-engine.ts`          | Filter evaluation          |
| `packages/connectors/sharepoint/src/filters/odata-translator.ts`                  | OData query translation    |
| `packages/connectors/sharepoint/src/permissions/sharepoint-permission-crawler.ts` | ACL crawling               |
| `packages/connectors/sharepoint/src/discovery/sharepoint-resource-discovery.ts`   | Site/drive discovery       |
| `packages/connectors/sharepoint/src/webhooks/webhook-manager.ts`                  | Subscription lifecycle     |

### Connector Base Package

| File                                                                    | Purpose                 |
| ----------------------------------------------------------------------- | ----------------------- |
| `packages/connectors/base/src/interfaces/connector.interface.ts`        | `IConnector` contract   |
| `packages/connectors/base/src/interfaces/sync-coordinator.interface.ts` | `ISyncCoordinator`      |
| `packages/connectors/base/src/sync/base-sync-coordinator.ts`            | Template method pattern |
| `packages/connectors/base/src/auth/token-manager.ts`                    | Token lifecycle         |
| `packages/connectors/base/src/cancellation/cancellation-checker.ts`     | Hybrid cancel detection |
| `packages/connectors/base/src/client/http-client.ts`                    | Base HTTP + rate limit  |
| `packages/connectors/base/src/filters/filter-templates.ts`              | Predefined filter sets  |
| `packages/connectors/base/src/filters/advanced-filter-evaluator.ts`     | Complex filter engine   |

### Models (Database)

| File                                                                   | Purpose                      | Registered?   |
| ---------------------------------------------------------------------- | ---------------------------- | ------------- |
| `packages/database/src/models/connector-config.model.ts`               | ConnectorConfig              | ✅ Yes        |
| `packages/database/src/models/connector-discovery.model.ts`            | ConnectorDiscovery           | ✅ Yes        |
| `packages/database/src/models/connector-recommendation.model.ts`       | ConnectorRecommendation      | ✅ Yes        |
| `packages/database/src/models/connector-connection.model.ts`           | ConnectorConnection          | ❌ No         |
| `packages/database/src/models/connector-schema.model.ts`               | ConnectorSchema              | ✅ (db/index) |
| `packages/database/src/models/connector-kv-store.model.ts`             | ConnectorKVStore             | ❌ No         |
| `packages/database/src/models/end-user-oauth-token.model.ts`           | EndUserOAuthToken            | ✅ Yes        |
| `packages/database/src/models/field-mapping.model.ts`                  | FieldMapping                 | ✅ (db/index) |
| `packages/database/src/models/canonical-schema.model.ts`               | CanonicalSchema              | ✅ (db/index) |
| `packages/database/src/models/discovered-schema.model.ts`              | DiscoveredSchema             | ✅ Yes        |
| `packages/database/src/models/drive-delta-token.model.ts`              | DriveDeltaToken              | ✅ (db/index) |
| `packages/database/src/models/sync-checkpoint.model.ts`                | SyncCheckpoint               | ✅ (db/index) |
| `packages/database/src/models/webhook-subscription-connector.model.ts` | WebhookSubscriptionConnector | ❌ No         |
| `packages/database/src/models/schema-change-log.model.ts`              | SchemaChangeLog              | ❌ No         |
| `packages/database/src/models/trigger-registration.model.ts`           | TriggerRegistration          | ❌ No         |

---

## 10. CAPABILITY HEAT MAP — "Can the Backend Answer This?"

Results from 4 rounds of capability testing (30 enterprise questions). Each question was verified against actual code.

### Legend

- 🟢 = Data exists AND shown in UI
- 🟡 = Data exists in backend but NOT in UI (or partial)
- 🔴 = Data does NOT exist anywhere
- ⚪ = Exists in code but dead/stubbed

### Round 1: Content Analytics

| Question               | Graph API                 | Discovery                  | Post-Sync DB                       | UI                      | Verdict                                 |
| ---------------------- | ------------------------- | -------------------------- | ---------------------------------- | ----------------------- | --------------------------------------- |
| Total file count       | ✅                        | Sampled (100/drive)        | `syncState.totalDocuments`         | 🟡 Post-sync only       | 🟡 No pre-sync count                    |
| File type distribution | ✅ `mimeType`             | `fileTypeDistribution` ✅  | `contentType` per doc              | 🔴 Not shown            | 🟡 Data exists, no aggregation endpoint |
| Folder count & depth   | ✅ `folder.childCount`    | 🔴 Skipped                 | 🔴 Not tracked                     | 🔴                      | 🔴 Not tracked anywhere                 |
| Files per site/drive   | ✅                        | Sampled per drive          | `sourceMetadata.driveId`           | 🔴                      | 🟡 Data in DB, no endpoint              |
| Total content size     | ✅ `size`                 | `totalSizeBytes` (sampled) | `contentSizeBytes` per doc         | 🟡 Wizard estimate only | 🟡 No aggregate endpoint                |
| Recently changed files | ✅ `lastModifiedDateTime` | `dateRange`                | Not as queryable field             | 🔴                      | 🟡 Source date not indexed              |
| Processable file types | N/A                       | N/A                        | `FileExtensionRegistry` (27 types) | 🟡 Wizard shows 7 of 27 | 🟡 No API endpoint for registry         |

**Key gap:** Discovery is sample-based (100 files/drive) and expires in 7 days. `Drive.quota` field not in our Graph types (would give totals without traversal). No MongoDB aggregation endpoints.

### Round 2: Sync Monitoring

| Question                                 | Real-Time                            | Persisted DB                       | API Endpoint                     | UI                    | Verdict                                   |
| ---------------------------------------- | ------------------------------------ | ---------------------------------- | -------------------------------- | --------------------- | ----------------------------------------- |
| Live progress + ETA                      | ✅ WebSocket `SyncProgressPublisher` | `SyncCheckpoint`                   | `GET /sync/status` (stale)       | 🟢 `SyncProgress.tsx` | 🟢 Working but REST endpoint stale        |
| What failed + why                        | N/A                                  | `SearchDocument.processingError`   | `GET /admin/errors`              | 🟡 Last error only    | 🟡 No per-connector failed doc list       |
| Last sync timestamp                      | N/A                                  | `syncState.lastFullSyncAt`         | `GET /sync/status`               | 🟢                    | 🟢                                        |
| Sync duration                            | ✅ in `SyncResult`                   | 🔴 NOT persisted                   | 🔴                               | 🔴                    | 🔴 Duration lost after 24h BullMQ cleanup |
| Status breakdown (indexed/pending/error) | N/A                                  | `SearchDocument.status` queryable  | `GET /admin/metrics` (per-index) | 🟡 Sync counts only   | 🟡 No per-connector breakdown             |
| Per-site/drive sync status               | N/A                                  | `DriveDeltaToken` per-drive        | `GET /delta-tokens`              | 🔴                    | 🟡 Endpoint exists, no UI                 |
| Delta changes list                       | Ephemeral in worker                  | 🔴 No changelog                    | 🔴                               | 🔴                    | 🔴 Changes not recorded                   |
| Sync history/timeline                    | N/A                                  | 🔴 No `SyncRun` model              | 🔴                               | 🔴                    | 🔴 Only latest sync stored                |
| Bottleneck identification                | `docs/min` rate                      | `JobExecution` per-stage durations | 🔴 No aggregation                | 🔴                    | 🟡 Data exists, no analysis               |

**Key gap:** No `SyncRun` history model. Duration not persisted. No per-connector document status breakdown. `JobExecution` has per-stage timing but no aggregation endpoint.

### Round 3: Security & Permissions

| Question                              | Backend Data                         | API Endpoint            | UI  | Verdict                         |
| ------------------------------------- | ------------------------------------ | ----------------------- | --- | ------------------------------- |
| Per-document ACL visibility           | ✅ Neo4j `getFlattenedPermissions()` | 🔴 No endpoint          | 🔴  | 🟡 Data exists, not exposed     |
| External/public sharing detection     | ✅ `publicEverywhere` flag in Neo4j  | 🔴 No query endpoint    | 🔴  | 🟡 Data exists, not exposed     |
| Group membership visibility           | ✅ Neo4j `MEMBER_OF` relationships   | 🔴 No admin query       | 🔴  | 🟡 Partial (nested groups TODO) |
| Security-trimmed search               | ✅ Full pipeline: crawl→index→query  | Automatic (transparent) | N/A | 🟢 Working end-to-end           |
| Token health (expiry, refresh status) | ✅ `EndUserOAuthToken` fields        | 🔴 No health endpoint   | 🔴  | 🟡 Data in DB, not surfaced     |
| Auth audit trail                      | 🔴 `onAuthEvent` is empty stub       | 🔴                      | 🔴  | 🔴 No auth events logged        |
| Permission change tracking            | 🔴 Neo4j overwrites (no history)     | 🔴                      | 🔴  | 🔴 No changelog                 |
| OAuth scope visibility                | ✅ `EndUserOAuthToken.scope`         | 🔴 Not exposed          | 🔴  | 🟡 Data in DB, not surfaced     |

**Key gap:** Security-trimmed search works, but admin visibility is zero. Auth audit is an empty stub. Neo4j fails open during indexing (security risk). No permission change tracking.

### Round 4: Search Quality & Indexing

| Question                              | Backend Data               | API Endpoint                    | UI                           | Verdict                                  |
| ------------------------------------- | -------------------------- | ------------------------------- | ---------------------------- | ---------------------------------------- |
| Coverage % (indexed/total at source)  | Only ingested count        | `GET /health-summary` (partial) | 🟡                           | 🟡 No source-side total                  |
| Failed files + specific error reasons | ✅ `processingError` field | `GET /admin/errors` ✅          | 🟡 Error count, not messages | 🟡 Error message not in doc UI           |
| Chunks per document                   | ✅ `chunkCount`            | ✅ Documents API                | 🟢 ChunkExplorer             | 🟢 Well implemented                      |
| Embedding freshness                   | `updatedAt` only           | 🔴 No staleness endpoint        | 🔴                           | 🔴 No freshness metric                   |
| Unsupported format tracking           | In error messages          | 🔴 No content type report       | 🔴                           | 🔴 No format breakdown                   |
| Chunk preview                         | ✅ Chunks API              | ✅ `GET /documents/:id/chunks`  | 🟢 3-view ChunkExplorer      | 🟢 Excellent                             |
| Sync completeness verification        | Sync counts only           | `GET /health-summary`           | 🟡                           | 🟡 No "source total vs ingested"         |
| Single document re-index              | Error retry only           | `POST /admin/errors/:id/retry`  | 🔴 No UI                     | 🟡 Only error state, no healthy re-index |

**Key gap:** No source-side total (can't compute true coverage). Error messages not shown per-doc in UI. No embedding staleness metric. ChunkExplorer is the standout feature.

---

## 11. CONSOLIDATED GAP ANALYSIS — What to Build

### Tier 1: High-Impact, Data Already Exists (Wire Up)

These need an API endpoint + UI component. The MongoDB/Neo4j data is already there.

| #   | Feature                                 | Data Source                                             | Effort                                |
| --- | --------------------------------------- | ------------------------------------------------------- | ------------------------------------- |
| 1   | File type distribution chart            | `SearchDocument.contentType` aggregation                | S — one `$group` endpoint + bar chart |
| 2   | Per-connector document status breakdown | `SearchDocument.status` grouped by `connectorId`        | S — one aggregation endpoint          |
| 3   | Per-site/drive document counts          | `SearchDocument.sourceMetadata.driveId` aggregation     | S — one aggregation endpoint          |
| 4   | Token health dashboard                  | `EndUserOAuthToken.expiresAt/refreshedAt/lastUsedAt`    | S — read existing fields              |
| 5   | OAuth scope display                     | `EndUserOAuthToken.scope`                               | XS — display existing field           |
| 6   | Per-document error messages in doc list | `SearchDocument.processingError`                        | XS — add field to existing response   |
| 7   | Failed doc list per connector           | `SearchDocument.find({ connectorId, status: 'error' })` | S — filtered query                    |
| 8   | Delta token/per-drive status UI         | `GET /connectors/:id/delta-tokens` (endpoint exists!)   | S — UI only                           |
| 9   | ACL viewer (who has access to what)     | Neo4j `getFlattenedPermissions()`                       | M — new endpoint + UI                 |
| 10  | External sharing report                 | Neo4j `publicEverywhere` query                          | S — one Cypher query + UI             |
| 11  | Filter preview button                   | `POST /filters/preview` (endpoint exists!)              | XS — UI button only                   |
| 12  | Permission recrawl trigger              | `POST /permissions/recrawl` (endpoint exists!)          | XS — UI button only                   |

### Tier 2: Medium-Impact, Needs New Data Collection

| #   | Feature                                | What to Build                                                            | Effort |
| --- | -------------------------------------- | ------------------------------------------------------------------------ | ------ |
| 13  | Sync history/timeline                  | New `SyncRun` model + populate from worker                               | M      |
| 14  | Sync duration tracking                 | Persist `durationMs` from `SyncResult` to `ConnectorConfig` or `SyncRun` | S      |
| 15  | Delta changes changelog                | Record adds/modifies/deletes per sync run                                | M      |
| 16  | Content size aggregation               | Add `totalSizeBytes` to `syncState` + aggregate endpoint                 | S      |
| 17  | Source-side total count                | Add `Drive.quota` to Graph types OR count during discovery               | S      |
| 18  | Embedding freshness metric             | Add `embeddedAt` to `SearchChunk` + staleness query                      | S      |
| 19  | Content type report (supported vs not) | `FileExtensionRegistry` API endpoint + match against discovered types    | S      |
| 20  | Delegated auth flow                    | Shareable auth link + "invite to authenticate" UX                        | L      |

### Tier 3: High-Impact, Needs Infrastructure

| #   | Feature                            | What to Build                                                      | Effort            |
| --- | ---------------------------------- | ------------------------------------------------------------------ | ----------------- |
| 21  | Auth audit trail                   | Implement `onAuthEvent` handler → audit log model                  | M                 |
| 22  | Permission change tracking         | Neo4j change capture or before/after diff                          | L                 |
| 23  | Bottleneck analysis                | `JobExecution` per-stage aggregation + visualization               | M                 |
| 24  | Wire scheduler system              | Call `startScheduledJobs()` + fix delta sync stub + fix mock token | M                 |
| 25  | Auto-pause on consecutive failures | Threshold check in worker error handler                            | S                 |
| 26  | Vector store cleanup job           | Scheduled job for `isDeleted: true` → vector store delete          | M                 |
| 27  | Folder structure analytics         | Track folders during sync traversal                                | M                 |
| 28  | Fail-closed on Neo4j down          | Change default from `publicEveryone: true` to `false`              | XS (but breaking) |

### Score Card

| Category                    | Questions | 🟢 Full     | 🟡 Partial   | 🔴 None      |
| --------------------------- | --------- | ----------- | ------------ | ------------ |
| Content Analytics (R1)      | 7         | 0           | 5            | 2            |
| Sync Monitoring (R2)        | 9         | 2           | 4            | 3            |
| Security & Permissions (R3) | 8         | 1           | 4            | 3            |
| Search Quality (R4)         | 8         | 2           | 4            | 2            |
| **TOTAL**                   | **32**    | **5 (16%)** | **17 (53%)** | **10 (31%)** |

**Bottom line:** We can fully answer only **5 of 32** enterprise questions today. But **17 more** have data in the backend that just needs wiring up. Only **10** need new data collection or infrastructure.

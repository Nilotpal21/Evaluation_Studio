# The SharePoint Connector — A Complete Story

> This document walks you through the SharePoint connector the way a new team member would experience it: one scene at a time, building from the simplest concept to the deepest complexity. By the end, you'll understand not just _what_ the code does, but _why_ every decision was made the way it was.

---

## The Problem We're Solving

Enterprises store thousands of documents in SharePoint — policies, reports, engineering specs, sales decks. When someone needs to _find_ something, SharePoint's native search is mediocre. Our platform builds a much better search experience: semantic understanding, canonical field mapping, LLM-powered query rewriting.

But first, we need to get those documents _out_ of SharePoint and _into_ our pipeline.

That sounds simple. It isn't.

SharePoint is not a file system. It's a hierarchy — **tenant → sites → document libraries (drives) → folders → files** — protected by Microsoft's OAuth system, throttled by rate limits, and constantly changing as people add, edit, and delete documents. A connector that works for 50 documents must also work for 500,000 documents without running out of memory, crashing mid-sync, or missing a permission change that leaks confidential data to the wrong user.

This document tells the story of how we handle all of that.

---

## Scene 1: Connecting to SharePoint

**The moment a user decides to bring their SharePoint data into the platform.**

### What the user sees

In Studio, the user creates a new data source and picks "SharePoint." They're asked for:

- Their **Azure tenant ID** (identifies their Microsoft organization)
- A **client ID** (the Azure AD app registration we use to talk to Microsoft)

Then they click "Authenticate." A window opens asking them to sign in with their Microsoft account and approve our app's access.

### What happens underneath

The authentication flow begins in the connector service (`apps/search-ai/src/services/connector.service.ts`). We support three OAuth 2.0 grant types, each for a different scenario:

**Authorization Code Flow** — the most common. The user clicks a link, signs into Microsoft, and gets redirected back to us with a one-time code. Our backend exchanges that code for an access token and a refresh token. This is what powers the Studio wizard.

**Device Code Flow** — for headless environments (CLI tools, servers with no browser). We give the user a short code and a URL. They visit the URL on any device, enter the code, and approve. Meanwhile, our backend polls Microsoft every few seconds asking "did they approve yet?" This follows RFC 8628.

**Client Credentials Flow** — app-only access with no user involved. Used for service accounts that need tenant-wide access without a human in the loop.

All three flows go through `MicrosoftOAuthProvider` (`packages/connectors/sharepoint/src/auth/microsoft-oauth-provider.ts`), which handles the HTTP calls to `login.microsoftonline.com`.

### Why three flows?

Because enterprises have different constraints. A developer setting up a connector from the UI uses authorization code. An ops team scripting connector setup in CI uses device code. A managed service account uses client credentials. Supporting all three means we never block an enterprise from connecting.

### Token storage and security

When Microsoft gives us tokens, we **never** store them in plaintext. The `EndUserOAuthToken` model (`packages/database/src/models/end-user-oauth-token.model.ts`) encrypts both the access token and refresh token using a Mongoose pre-save hook before they touch the database. Fields:

- `encryptedAccessToken` — the short-lived token (1 hour) used for API calls
- `encryptedRefreshToken` — the long-lived token used to get new access tokens
- `expiresAt` — when the access token expires
- `revokedAt` — set when the user disconnects (soft revoke, never hard delete, for audit trail)
- `consentedAt` — when the user first approved

The token is linked to the connector via `ConnectorConfig.oauthTokenId`. Every query to this model is scoped by `tenantId` — one tenant can never see another tenant's tokens.

### Automatic token refresh

Access tokens expire every hour. We don't want syncs to fail because of that. The `TokenManager` (`packages/connectors/base/src/auth/token-manager.ts`) wraps every Graph API call with a check: "is the token expiring within the next 5 minutes?" If yes, it silently refreshes the token using the stored refresh token, updates the database, and continues. The caller never knows it happened.

### Session management during auth

While the user is in the middle of authenticating (they've started the flow but haven't approved yet), we store session state in Redis with a 10-15 minute TTL:

```
Key:    oauth:device:{connectorId}
Value:  { deviceCode, userCode, verificationUri, expiresAt, scopes, state }
TTL:    900 seconds
```

The frontend polls `GET /connectors/:connectorId/auth/status` every few seconds. When the user approves, the next poll finds the completed tokens, stores them, cleans up the Redis session, and returns `status: 'completed'`.

### Scope escalation by feature

Not all connectors need the same permissions. We request only what's needed:

| Feature                            | Scopes Required                                                 |
| ---------------------------------- | --------------------------------------------------------------- |
| Read documents                     | `Sites.Read.All`, `offline_access`                              |
| Simplified permissions             | `Sites.FullControl.All`, `offline_access`                       |
| Full permissions (group expansion) | `Sites.FullControl.All`, `Directory.Read.All`, `offline_access` |

`offline_access` gives us the refresh token. Without it, we'd lose access after one hour.

---

## Scene 2: Discovering What's Inside

**Before syncing anything, we need to know what we're dealing with.**

A SharePoint tenant can have hundreds of sites with thousands of document libraries containing millions of files. Syncing everything would be wasteful. Discovery lets the user (or an AI recommendation engine) decide _what_ to sync.

### The discovery flow

When the user triggers discovery (`POST /connectors/:connectorId/discover`), a job is queued on the `connector-discovery` BullMQ queue. The worker (`apps/search-ai/src/workers/connector-discovery-worker.ts`) initializes the connector and calls its `IResourceDiscovery` interface.

The `SharePointResourceDiscovery` class (`packages/connectors/sharepoint/src/discovery/sharepoint-resource-discovery.ts`) does two things:

**1. Enumerate resources** — It calls `graphClient.getSites()` to list all SharePoint sites the user can access, then for each site calls `graphClient.getDrives(siteId)` to list document libraries. Each becomes a `DiscoveredResource` with a parent-child relationship (drives belong to sites).

**2. Profile content** (optional) — For each drive, it samples up to 100 items and computes a content profile:

- File type distribution (how many .docx vs .pdf vs .pptx)
- Date range (oldest and newest modification)
- Average file size
- Update frequency (calculated from date distribution)
- Sensitivity indicators (detects common PII patterns in filenames)

This data feeds into the **recommendation engine**, which scores each resource and suggests which sites/libraries to sync, what sync schedule to use, and which permission mode to enable. The user can accept, tweak, or reject the recommendations.

### Quick setup: one click from zero to syncing

For users who don't want to think about configuration, `POST /connectors/:connectorId/quick-setup` runs the entire chain in one shot: discover → profile → generate recommendations → accept → start first sync. The AI picks sensible defaults based on what it finds.

### Why discovery matters

Without discovery, the user would have to manually type in site URLs and library names. With discovery, they see a tree of everything available, with data-driven scores showing which sources are most valuable. This reduces setup time from hours to minutes and prevents the common mistake of syncing a 50GB archive of obsolete files.

Discovery results and recommendations are stored with a **7-day TTL** (`ConnectorDiscovery` and `ConnectorRecommendation` models). They auto-expire because SharePoint changes constantly — stale recommendations are worse than no recommendations.

---

## Scene 3: The First Full Sync

**This is the heart of the connector — the moment documents start flowing from SharePoint into our search index.**

### Triggering the sync

The user clicks "Start Sync" in Studio, which calls `POST /connectors/:connectorId/sync/start?syncType=full`. The service layer (`connector.service.ts`) does three validations:

1. The OAuth token exists and isn't revoked
2. No other sync is already running for this connector
3. The connector config is valid

Then it adds a job to the `connector-sync` BullMQ queue and returns a `jobId` for the frontend to poll progress.

### The worker takes over

The sync worker (`apps/search-ai/src/workers/connector-sync-worker.ts`) picks up the job and begins a careful sequence:

**Step 1: Acquire a distributed lock.**

```
Lock key:  sync-lock:{indexId}:{connectorId}
TTL:       1 hour
Strategy:  Fail-fast (don't wait)
```

This prevents two workers from syncing the same connector simultaneously. In a multi-pod deployment, without this lock, two pods could process the same SharePoint and create duplicate documents. The lock uses Redis `SET NX PX` — atomic, distributed, with automatic expiry if the worker crashes.

**Step 2: Initialize the connector.**

The worker creates a `SharePointConnector` instance (`packages/connectors/sharepoint/src/sharepoint-connector.ts`) and calls `initialize()`, which sets up the entire chain: OAuth provider → token manager → Graph client (with rate limiting) → filter engine → sync coordinators.

**Step 3: Run the sync.**

The worker calls `connector.performFullSync(checkpoint)`, which delegates to the `SharePointFullSyncCoordinator` (`packages/connectors/sharepoint/src/sync/full-sync-coordinator.ts`).

### The template method pattern

All sync coordinators — SharePoint, Jira, Confluence, anything we build next — follow the same algorithm defined in `BaseSyncCoordinator` (`packages/connectors/base/src/sync/base-sync-coordinator.ts`). The base class defines the skeleton:

```
1. Create or load a checkpoint
2. Mark the source as "syncing"
3. Call fetchDocuments()          ← connector-specific
4. For each document:
   a. Apply filters
   b. Create SearchDocument record (with deduplication)
   c. Call downloadDocument()     ← connector-specific
   d. Upload to storage (S3 or local)
   e. Check for pause every 10 docs
   f. Save checkpoint every 100 docs
5. Crawl permissions (if enabled)  ← connector-specific
6. Mark the source as "active"
7. Queue ingestion pipeline
```

The SharePoint coordinator fills in the connector-specific parts. The base class handles everything else — progress tracking, checkpointing, pause/resume, error isolation. This is the textbook Gang of Four Template Method pattern, and it's why adding a new connector doesn't mean reimplementing sync orchestration.

### How SharePoint enumerates documents

The `fetchDocuments()` implementation follows SharePoint's natural hierarchy:

```
For each site (filtered by scope config):
  For each document library in that site (filtered by name patterns):
    Stream all files in that library (recursively, in batches of 100)
    After finishing the library: establish a delta token for next time
```

**Why streaming matters.** A single document library can contain 100,000+ files. Loading them all into memory would crash the process. Instead, `graphClient.getDriveItemsStream()` uses an async generator that yields batches of 100 items. The coordinator processes each batch, then moves to the next. Memory usage stays flat regardless of library size.

**Why we establish delta tokens during full sync.** After enumerating a library, we call `graphClient.getDeltaItems(driveId, undefined)` — passing `undefined` as the token. Microsoft responds with the current state plus a `@odata.deltaLink`. We save that link in the `DriveDeltaToken` collection. Next time, we can ask "what changed since this link?" instead of re-enumerating everything. This is what makes delta sync possible (Scene 4).

### Filtering: what gets synced and what doesn't

Not every file should be synced. The `SharePointFilterEngine` (`packages/connectors/sharepoint/src/filters/sharepoint-filter-engine.ts`) provides multi-level filtering:

**Level 1: Scope filtering** (cheapest, applied during enumeration)

- `siteMode`: 'all' | 'selected' | 'excluded' — which sites to include
- `libraryMode`: 'all' | 'selected' | 'excluded' — which libraries to include
- Supports both exact IDs and glob patterns (e.g., `*-archive` to exclude archive sites)

**Level 2: Document filtering** (applied per document)

- File extension include/exclude lists
- Folder path patterns (e.g., exclude `/Archive/**`)
- File size ranges
- Date ranges (modified after X)

Scope filtering is applied early — we don't even enumerate drives for excluded sites. This avoids wasting Graph API calls on content we'll skip anyway.

### Deduplication

Every document gets a `contentHash` computed from `SHA256(documentId + modifiedAt)`. If a document with the same hash already exists in the database, we update it instead of creating a duplicate. This makes full sync idempotent — running it twice produces the same result, not double the documents.

### Document storage

After downloading a file's content via `graphClient.getDriveItemContent(driveId, itemId)`, we upload it to either:

- **S3** (production): `s3://{bucket}/{tenantId}/{sourceId}/{docId}/{filename}`
- **Local filesystem** (development): `./uploads/{tenantId}/{sourceId}/{docId}/{filename}`

The storage URL is saved on the `SearchDocument` record so the ingestion pipeline knows where to find the raw file.

### What the SearchDocument record looks like

Each synced file becomes a `SearchDocument` in the `searchaicontent` MongoDB database:

```
{
  tenantId, indexId, sourceId,
  contentHash: "sha256:...",
  originalReference: "https://contoso.sharepoint.com/sites/...",
  contentType: "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
  contentSizeBytes: 245760,
  sourceUrl: "s3://bucket/tenant/source/doc/report.docx",
  sourceMetadata: {
    sharepoint: {
      siteId, siteName, siteUrl,
      driveId, driveName, driveUrl,
      itemId, itemName, itemWebUrl,
      createdBy, lastModifiedBy,
      parentPath, quickXorHash
    }
  },
  status: "pending",   // waiting for ingestion
  isDeleted: false
}
```

The `sourceMetadata.sharepoint` block preserves every piece of Microsoft metadata. This is critical — it's how delta sync knows which items to update, how permission crawling knows which items to check, and how the UI can show "this document came from the Engineering site, Specs library."

### Progress reporting

While the sync runs, the frontend polls `GET /connectors/:connectorId/sync/status`. The service reads `ConnectorConfig.syncState` and returns:

```json
{
  "status": "syncing",
  "progress": { "percentage": 42, "processed": 4200, "total": 10000, "failed": 3 },
  "syncState": { "syncInProgress": true, "currentJobId": "full-sync:abc:1710000000" }
}
```

The percentage comes from checkpoint updates (every 100 documents) combined with estimated totals from the enumeration phase.

---

## Scene 4: Staying in Sync — Delta Queries and Webhooks

**The first full sync might take hours for a large tenant. After that, we need to stay current without re-crawling everything.**

### Delta sync: only what changed

Microsoft Graph provides a delta query mechanism. When we call `/drives/{driveId}/root/delta?token={savedToken}`, Microsoft returns _only_ the items that changed since the token was issued — new files, modified files, and deleted files. For a tenant with 100,000 documents where 50 changed since yesterday, delta sync processes 50 items instead of 100,000. That's a ~2000x reduction.

The `DeltaSyncCoordinator` (`packages/connectors/sharepoint/src/sync/delta-sync-coordinator.ts`) follows the same site → drive loop as full sync, but instead of enumerating all items, it:

1. Loads the stored delta token for each drive from `DriveDeltaToken`
2. Calls `graphClient.getDeltaItems(driveId, deltaToken)`
3. Processes the response:
   - Items with `@removed` flag → soft-delete the SearchDocument (`isDeleted: true, deletedAt: now`)
   - Everything else → create or update the SearchDocument
4. Saves the new delta token for next time

**Why per-drive tokens?** Microsoft issues delta tokens per drive, not per site or per tenant. If one drive fails, the others aren't affected. We can retry the failed drive independently without re-syncing everything.

**What if there's no delta token?** The coordinator skips that drive and logs a warning. Delta tokens are only established during full sync (Scene 3). If a drive was added after the last full sync, it won't have a token yet. The admin can either run another full sync or reset the connector.

### Webhooks: real-time notifications

Polling for changes (even with delta tokens) means there's always a delay between when a document changes and when we notice. Microsoft Graph webhooks eliminate that delay.

The `WebhookManager` (`packages/connectors/sharepoint/src/webhooks/webhook-manager.ts`) subscribes to change notifications for each drive:

```
POST https://graph.microsoft.com/v1.0/subscriptions
{
  changeType: "updated",
  notificationUrl: "https://our-app.com/api/webhooks/connectors/{connectorId}/sharepoint",
  resource: "/drives/{driveId}/root",
  expirationDateTime: "2024-03-11T12:00:00Z",
  clientState: "{encrypted-secret}"
}
```

When a document changes in SharePoint, Microsoft sends a notification to our URL. We validate the `clientState` (to prevent spoofed notifications), extract the `driveId`, and queue a delta sync job for just that drive.

**24-hour expiry.** Microsoft webhook subscriptions expire after 24 hours maximum. A background job runs hourly to renew subscriptions before they expire. If renewal fails 3 times consecutively, the subscription is marked as `failed` and falls back to scheduled polling.

**The real-time chain:**

```
User edits document in SharePoint
  → Microsoft sends webhook notification
    → Our app validates and extracts driveId
      → Queues delta sync job for that drive
        → Delta sync processes just the changed items
          → Ingestion pipeline updates the search index
            → Next search query returns the updated content
```

This gives near-real-time freshness — typically under 5 minutes from edit to searchable.

---

## Scene 5: Permissions — Who Can See What

**This is where the complexity jumps. Getting documents is one thing. Ensuring that search results respect SharePoint's access controls is a fundamentally harder problem.**

### Why permissions matter

Imagine a company where the HR team has salary spreadsheets in SharePoint. Without permission filtering, any employee searching for "salary" would see those documents in search results. That's a data breach. Our platform must enforce the same access controls that SharePoint does, at query time.

### The permission graph (Neo4j)

We model permissions as a graph because that's what they are. SharePoint permissions involve:

- **Users** who have direct access to documents
- **Groups** that contain users (and can contain other groups, recursively)
- **Public links** that make documents accessible to everyone

This is a natural graph problem. We use Neo4j to store it.

**Nodes:**

```
User    { tenantId, email, idpUserId, displayName, domain, status }
Group   { tenantId, groupId, source, displayName, email }
Document { tenantId, documentId, sourceId, name, path, publicInDomain, publicEveryone }
Domain  { tenantId, domain, verified }
```

**Relationships:**

```
User    -[:HAS_PERMISSION {role, source}]->  Document   (direct access)
Group   -[:HAS_PERMISSION {role, source}]->  Document   (group access)
User    -[:MEMBER_OF {source}]->             Group      (membership)
Group   -[:MEMBER_OF {source}]->             Group      (nested groups)
Document -[:PUBLIC_IN]->                      Domain     (domain-wide access)
```

### Two crawl modes

The `SharePointPermissionCrawler` (`packages/connectors/sharepoint/src/permissions/sharepoint-permission-crawler.ts`) supports two modes because there's a fundamental tradeoff between accuracy and speed:

**Full mode (100% accuracy, slow):** For every document, we fetch its permissions from SharePoint. For every group permission, we recursively resolve all group members by calling `graphClient.getGroupMembers(groupId)`. Groups can contain other groups (Azure AD supports this), so we follow the chain. This gives us the complete picture — every individual user who can access every document — but it's expensive. For a tenant with 1,000 groups, this could mean thousands of extra API calls.

**Simplified mode (95% accuracy, fast):** We fetch document permissions and store group IDs without resolving their members. At query time, we check if the user belongs to any of those groups. This skips the expensive group member resolution but misses edge cases like nested group chains that the user is part of through an intermediate group.

**Why 95% and not 100%?** Simplified mode misses deeply nested group memberships (e.g., User → Group A → Group B → Group C → Document). For most organizations, permission structures are flat enough that this covers 95%+ of cases. The 5% gap matters for highly regulated environments, where full mode is worth the extra API calls.

### How permission crawling works

During or after sync, for each document:

1. **Fetch permissions** from SharePoint: `graphClient.getItemPermissions(driveId, itemId)`
2. **Create/update the Document node** in Neo4j with `publicInDomain` and `publicEveryone` flags
3. **Process each permission entry:**
   - User permission → create User node + `HAS_PERMISSION` edge
   - Group permission → create Group node + `HAS_PERMISSION` edge
   - (Full mode only) Resolve group members → create User nodes + `MEMBER_OF` edges
   - Public link → set `publicEveryone = true` on the Document node

Permission crawling is deliberately **decoupled from sync**. If the permission crawl fails (Microsoft throttling, Neo4j down), the sync still completes successfully. Documents are searchable but temporarily without permission filtering. The admin can re-trigger the crawl later via `POST /connectors/:connectorId/permissions/recrawl`.

### Query-time permission filtering

When a user searches, the permission filter middleware (`apps/search-ai/src/middleware/permission-filter.middleware.ts`) intercepts the request and resolves which documents the user can access. It queries Neo4j with four paths:

```
Path 1: Direct permission      User -[:HAS_PERMISSION]-> Document
Path 2: Group membership        User -[:MEMBER_OF*1..20]-> Group -[:HAS_PERMISSION]-> Document
Path 3: Domain-scoped public    Document -[:PUBLIC_IN]-> Domain WHERE user.domain = domain
Path 4: Public everywhere       Document.publicEveryone = true
```

The `*1..20` in Path 2 handles recursive group nesting up to 20 levels deep (with cycle detection). The result is a set of document IDs that gets cached in Redis for 5 minutes.

The search query is then filtered to only return documents in that set. The user never sees documents they can't access in SharePoint.

**Performance target:** <50ms for the permission query, even with millions of documents. Neo4j's graph traversal is inherently fast for this — it's the exact use case graph databases were designed for.

---

## Scene 6: When Things Go Wrong — Pause, Resume, and Recovery

**Enterprise syncs are long-running operations. They will be interrupted. The system must handle this gracefully.**

### Checkpoint-based pause/resume

When the user clicks "Pause" in Studio, the service sets `ConnectorConfig.errorState.isPaused = true` in the database. The sync coordinator checks this flag every 10 documents. When it sees the pause, it saves the current state to a `SyncCheckpoint`:

```
{
  connectorId, syncType: "full",
  state: {
    currentSiteUrl: "https://contoso.sharepoint.com/sites/Engineering",
    currentLibraryId: "drive-abc-123",
    nextLink: "https://graph.microsoft.com/v1.0/drives/drive-abc/root/children?$skiptoken=...",
    processedCount: 4200
  },
  progress: { percentage: 42, documentsPerSecond: 12.5, eta: "2024-03-10T15:30:00Z" }
}
```

Notice `nextLink` — this is the OData pagination token from Microsoft's API. When the user resumes, we don't start from the beginning of that library. We pick up from the exact page of results where we stopped.

**Why every 10 documents?** Checking more frequently adds overhead. Less frequently risks losing too much progress on pause. 10 is a balance — at typical sync speeds (10-50 docs/sec), this means at most a half-second delay between the user clicking pause and the sync actually stopping.

**Why checkpoints every 100 documents?** Writing to MongoDB on every document would slow the sync. Every 100 strikes a balance between progress granularity and write overhead. If the worker crashes between checkpoints, we lose at most 100 documents of progress — they'll be re-processed on resume (and deduplicated by contentHash).

### Handling worker crashes

If the worker process dies (OOM, SIGKILL, pod eviction), the distributed lock auto-expires after 1 hour. The next worker to process the job finds the last checkpoint and resumes. Documents already processed are in the database — deduplication prevents duplicates.

The worker also handles `SIGTERM` gracefully. On shutdown:

1. Stop accepting new jobs
2. Let the current sync reach its next checkpoint (up to 100 docs)
3. Save checkpoint
4. Release the distributed lock
5. Exit cleanly

### Error isolation

Individual document failures don't fail the entire sync. If downloading one file throws a 404 (deleted between enumeration and download), the coordinator logs the error, increments `failedDocuments`, and moves to the next document. The sync result reports both `documentsProcessed` and `documentsFailed`.

Permission crawl failures are also isolated — the sync still succeeds, and the admin is notified that permissions need a re-crawl.

### Restart from scratch

If something is fundamentally broken (corrupted checkpoint, bad delta tokens), the admin can call `POST /connectors/:connectorId/sync/restart`. This deletes all checkpoints, resets counters, and starts a fresh full sync as if the connector was just created.

---

## Scene 7: The Microsoft Graph API Layer

**Everything the connector does goes through Microsoft Graph. This layer handles the reality of talking to an external API at scale.**

### Rate limiting

Microsoft Graph enforces rate limits — approximately 10,000 requests per 10 minutes per app. Exceeding this returns `429 Too Many Requests`.

The `RateLimiter` (`packages/connectors/base/src/client/rate-limiter.ts`) implements a token bucket algorithm. Tokens replenish at a configured rate (~16.67/second). Before each API call, the client acquires a token. If none are available, it waits. This prevents us from ever hitting Microsoft's limit in the first place — proactive rate limiting instead of reactive retry.

### Retry with exponential backoff

Even with rate limiting, transient failures happen. The `HttpClient` (`packages/connectors/base/src/client/http-client.ts`) retries on:

- `429` — throttled (with `Retry-After` header if present)
- `500`, `502`, `503`, `504` — server errors

Backoff schedule: 1s → 2s → 4s, up to 30s max, for 3 attempts total. This handles Azure's occasional hiccups without overwhelming the service.

### The GraphClient API surface

`GraphClient` (`packages/connectors/sharepoint/src/client/graph-client.ts`) wraps every Microsoft Graph endpoint we use:

| Method                                    | What it does                | When it's called                |
| ----------------------------------------- | --------------------------- | ------------------------------- |
| `getSites()`                              | List all tenant sites       | Discovery, full sync            |
| `getDrives(siteId)`                       | List document libraries     | Discovery, full sync            |
| `getDriveItemsStream(driveId, batchSize)` | Stream files in batches     | Full sync                       |
| `getDeltaItems(driveId, token?)`          | Get changes since token     | Delta sync, token establishment |
| `getDriveItemContent(driveId, itemId)`    | Download a file             | Document processing             |
| `getItemPermissions(driveId, itemId)`     | Get file permissions        | Permission crawling             |
| `getGroupMembers(groupId)`                | Resolve group membership    | Full permission crawl           |
| `subscribeToDriveChanges(...)`            | Create webhook subscription | Webhook setup                   |

**Fallback for site enumeration.** The primary method (`/sites?search=*`) occasionally fails with 500 errors on large tenants. The client automatically falls back to `/sites/root` + `/sites/root/sites` — slower but more reliable.

---

## Scene 8: The Architecture Underneath

**Now that you understand the flow, let's look at the structural decisions that make it all possible.**

### The connector plugin system

The SharePoint connector is a standalone npm package (`@agent-platform/connector-sharepoint`) that implements the `IConnector` interface. This interface is the contract between any connector and the platform:

```typescript
interface IConnector {
  readonly connectorType: string;
  readonly config: IConnectorConfig;

  initialize(): Promise<void>;
  validateConfig(): Promise<ValidationResult>;
  testConnection(): Promise<ConnectionTestResult>;

  performFullSync(checkpoint?): Promise<SyncResult>;
  performDeltaSync(): Promise<SyncResult>;
  pauseSync(jobId: string): Promise<void>;
  resumeSync(jobId: string): Promise<void>;

  crawlPermissions(mode): Promise<PermissionCrawlResult>;

  setupWebhook?(notificationUrl): Promise<WebhookSubscription>;
  handleWebhookNotification?(payload): Promise<void>;
  getResourceDiscovery?(): IResourceDiscovery;
}
```

Building a new connector (Jira, Confluence, Google Drive) means implementing this interface and plugging into the existing sync worker, queue system, and UI. The base infrastructure — HTTP client, rate limiter, token manager, sync coordinator — is shared.

### Dual-database pattern

The platform uses two MongoDB databases:

- **platform** — tenant configs, OAuth tokens, connector configs, discovery results, recommendations
- **searchaicontent** — SearchDocuments, SearchSources, SearchChunks, delta tokens, checkpoints

Why two? Isolation. The platform database holds configuration that rarely changes. The searchaicontent database holds high-volume document data that gets written to constantly during sync. Separating them means a heavy sync doesn't degrade config reads, and database-level access controls can be different.

The connector receives models for both databases via dependency injection (`SyncCoordinatorModels`). It never imports models directly — the worker provides them.

### Dependency injection for models

```typescript
// The worker injects models from both databases:
const connector = new SharePointConnector(
  config.toObject(),
  EndUserOAuthToken, // from platform DB
  {
    SearchDocument, // from searchaicontent DB
    SearchSource, // from searchaicontent DB
    SyncCheckpoint, // from searchaicontent DB
    ConnectorConfig, // from platform DB
    DriveDeltaToken, // from searchaicontent DB
  },
);
```

This keeps the connector package database-agnostic. It works with whatever models are given to it. Testing is easier — you can inject mocked models.

### BullMQ queue architecture

Three dedicated queues handle connector work:

| Queue                        | Purpose                   | Concurrency                     |
| ---------------------------- | ------------------------- | ------------------------------- |
| `connector-sync`             | Full and delta sync jobs  | 1 per connector (lock-enforced) |
| `connector-discovery`        | Discovery and profiling   | 1 per connector (lock-enforced) |
| `connector-permission-crawl` | Permission graph building | 1 per connector                 |

Each queue has its own worker process. Jobs are identified with composite IDs like `full-sync:{connectorId}:{timestamp}` to prevent duplicates. The distributed lock ensures only one sync runs per connector, even across multiple pods.

### Data model relationships

```
SearchIndex (1) ──── (many) SearchSource ──── (1) ConnectorConfig
                                                      │
                                                      ├── oauthTokenId → EndUserOAuthToken
                                                      ├── filterConfig (embedded)
                                                      ├── permissionConfig (embedded)
                                                      └── syncState (embedded)

SearchSource ──── (many) SearchDocument
                              │
                              ├── sourceMetadata.sharepoint.* (SharePoint-specific fields)
                              ├── sourceUrl (S3 or local path to raw file)
                              └── isDeleted (for delta sync soft deletion)

ConnectorConfig ──── (many) DriveDeltaToken (one per drive per connector)
ConnectorConfig ──── (many) SyncCheckpoint (active sync only, deleted on completion)
ConnectorConfig ──── (many) ConnectorDiscovery (7-day TTL)
ConnectorConfig ──── (many) ConnectorRecommendation (7-day TTL)
```

Every query on every model is scoped by `tenantId`. We use `findOne({ _id, tenantId })`, never `findById()`. Cross-tenant access returns 404 (not 403) to avoid leaking the existence of resources.

---

## Scene 9: The Complete Journey — From Click to Search Result

**Let's trace a single document through the entire system.**

Alice works at Contoso. She uploads `Q1-Report.docx` to the Engineering site's "Specs" library in SharePoint. She shares it with the Engineering group.

**T+0 minutes:** Alice uploads the document to SharePoint.

**T+1 minute:** Microsoft sends a webhook notification to our app. The webhook manager validates the `clientState`, identifies the drive, and queues a delta sync job.

**T+2 minutes:** The delta sync worker picks up the job. It loads the delta token for the Specs drive and calls `getDeltaItems()`. Microsoft returns one changed item: `Q1-Report.docx`.

**T+2.5 minutes:** The coordinator creates a `SearchDocument` record with `status: 'pending'`, downloads the file content via `getDriveItemContent()`, and uploads it to S3.

**T+3 minutes:** The permission crawler fetches the document's permissions from SharePoint. It finds: Engineering group has read access. In simplified mode, it creates:

- `(:Group {groupId: 'sharepoint:eng-group-1'}) -[:HAS_PERMISSION {role: 'read'}]-> (:Document {documentId: 'doc-xyz'})`

**T+4 minutes:** The ingestion pipeline (separate from the connector) picks up the document: Docling extracts text, the embedding model creates vectors, and OpenSearch indexes everything.

**T+5 minutes:** Bob, an engineer at Contoso, searches for "quarterly report." The permission middleware queries Neo4j:

- Bob is a member of the Engineering group
- The Engineering group has `HAS_PERMISSION` to `doc-xyz`
- `doc-xyz` is in Bob's accessible document set

The search returns `Q1-Report.docx` in the results. Bob clicks through to read it.

**Meanwhile:** Charlie from Sales searches for the same thing. Neo4j finds no path from Charlie to `doc-xyz`. The document doesn't appear in his results. SharePoint's permission model is preserved.

---

## Scene 10: The File Map

**For when you need to find the actual code.**

### SharePoint connector package (`packages/connectors/sharepoint/src/`)

| File                                           | Role in the story                                                     |
| ---------------------------------------------- | --------------------------------------------------------------------- |
| `sharepoint-connector.ts`                      | The main character — implements `IConnector`, orchestrates everything |
| `auth/microsoft-oauth-provider.ts`             | Scene 1 — handles all three OAuth flows with Microsoft                |
| `client/graph-client.ts`                       | Scene 7 — every API call to Microsoft Graph goes through here         |
| `client/graph-types.ts`                        | TypeScript types for Microsoft Graph responses                        |
| `sync/full-sync-coordinator.ts`                | Scene 3 — the big crawl, site→drive→item enumeration                  |
| `sync/delta-sync-coordinator.ts`               | Scene 4 — incremental sync using delta tokens                         |
| `sync/delta-token-manager.ts`                  | Scene 4 — CRUD for per-drive delta tokens                             |
| `filters/sharepoint-filter-engine.ts`          | Scene 3 — multi-level filtering (scope, extension, path, size)        |
| `filters/odata-translator.ts`                  | Translates filter config to OData query parameters                    |
| `permissions/sharepoint-permission-crawler.ts` | Scene 5 — crawls permissions, writes to Neo4j                         |
| `discovery/sharepoint-resource-discovery.ts`   | Scene 2 — enumerates sites/drives, profiles content                   |
| `webhooks/webhook-manager.ts`                  | Scene 4 — manages Microsoft Graph webhook subscriptions               |

### Base connector infrastructure (`packages/connectors/base/src/`)

| File                                | What it provides                           |
| ----------------------------------- | ------------------------------------------ |
| `sync/base-sync-coordinator.ts`     | Template method pattern for all sync flows |
| `client/http-client.ts`             | HTTP client with retry and token refresh   |
| `client/rate-limiter.ts`            | Token bucket rate limiting                 |
| `auth/token-manager.ts`             | Automatic OAuth token refresh              |
| `interfaces/connector.interface.ts` | The `IConnector` contract                  |

### Platform layer (`apps/search-ai/src/`)

| File                                           | What it does                                            |
| ---------------------------------------------- | ------------------------------------------------------- |
| `routes/connectors.ts`                         | REST API for connector CRUD, auth, sync, permissions    |
| `routes/connector-discovery.ts`                | REST API for discovery and recommendations              |
| `services/connector.service.ts`                | Business logic — sync orchestration, auth flows, status |
| `repos/connector.repository.ts`                | Data access — all tenant-scoped queries                 |
| `workers/connector-sync-worker.ts`             | BullMQ worker — lock, init, sync, ingest                |
| `workers/connector-discovery-worker.ts`        | BullMQ worker — discover, profile, recommend            |
| `workers/connector-permission-crawl-worker.ts` | BullMQ worker — permission graph building               |
| `middleware/permission-filter.middleware.ts`   | Query-time permission enforcement                       |
| `services/permission-filter.service.ts`        | Neo4j queries + Redis caching for access resolution     |

### Database models (`packages/database/src/models/`)

| Model                               | Database        | Scene                                                |
| ----------------------------------- | --------------- | ---------------------------------------------------- |
| `connector-config.model.ts`         | platform        | Scenes 1-6 — the connector's configuration and state |
| `end-user-oauth-token.model.ts`     | platform        | Scene 1 — encrypted OAuth tokens                     |
| `search-source.model.ts`            | searchaicontent | Scene 3 — the data source record                     |
| `search-document.model.ts`          | searchaicontent | Scenes 3-4 — individual synced documents             |
| `sync-checkpoint.model.ts`          | searchaicontent | Scene 6 — pause/resume state                         |
| `drive-delta-token.model.ts`        | searchaicontent | Scene 4 — per-drive delta tokens                     |
| `connector-discovery.model.ts`      | platform        | Scene 2 — discovered resources (7-day TTL)           |
| `connector-recommendation.model.ts` | platform        | Scene 2 — AI recommendations (7-day TTL)             |

---

## Scene 11: Building a Claude Skill on This

**This section is specifically for creating Claude Code skills that work with the connector.**

### Key patterns a skill must know

1. **Tenant isolation is non-negotiable.** Every database query must include `tenantId`. Use `findOne({ _id, tenantId })`, never `findById()`. Cross-tenant access returns 404.

2. **The dual-database split.** Configuration lives in `platform` DB. Document data lives in `searchaicontent` DB. Models are injected, not imported directly. Use `getLazyModel<ISearchDocument>('SearchDocument')` for typed access.

3. **The sync is queue-based.** Never call `connector.performFullSync()` directly from an API route. Always queue a job and let the worker handle it. The worker manages locks, checkpoints, and error recovery.

4. **The template method pattern.** To add a new connector, extend `BaseSyncCoordinator` and implement `fetchDocuments()`, `downloadDocument()`, and `crawlPermissionsBatch()`. The base class handles everything else.

5. **Delta tokens are per-drive.** Not per-site, not per-tenant. Each SharePoint drive has its own independent delta token. Full sync establishes them; delta sync consumes and refreshes them.

6. **Permission crawling is optional and decoupled.** It runs after sync, can fail independently, and can be re-triggered manually. The three modes (full/simplified/disabled) trade accuracy for speed.

7. **Filtering happens at two levels.** Scope filtering during enumeration (cheap, skips entire sites/libraries). Document filtering during processing (per-document, checks extension/path/size/date).

8. **Rate limiting is proactive.** The token bucket rate limiter prevents us from hitting Microsoft's limits. Retry with exponential backoff handles the occasional slip.

### Anti-patterns to avoid

| Don't do this                                          | Do this instead                                   | Why                                                                |
| ------------------------------------------------------ | ------------------------------------------------- | ------------------------------------------------------------------ |
| `findById(connectorId)`                                | `findOne({ _id: connectorId, tenantId })`         | Tenant isolation                                                   |
| `getModel('SearchDocument')`                           | `getLazyModel<ISearchDocument>('SearchDocument')` | Type safety — untyped model causes `.lean()` to return union types |
| `console.log()` in server code                         | `createLogger('module').info()`                   | Structured logging with trace context                              |
| `await connector.performFullSync()` in a route handler | Queue a job via BullMQ                            | Locks, checkpoints, crash recovery                                 |
| Loading all drive items into memory                    | Use `getDriveItemsStream()` async generator       | Memory safety for large libraries                                  |
| Hard-deleting documents on delta sync                  | Set `isDeleted: true, deletedAt: now`             | Audit trail, undo capability                                       |
| Failing the entire sync if one document errors         | Log, increment `failedDocuments`, continue        | Error isolation                                                    |
| Failing the sync if permission crawl errors            | Let sync succeed, report crawl failure separately | Decoupled concerns                                                 |

### REST API quick reference

```
# Authentication
POST   /connectors/:id/auth/initiate     → Start OAuth flow
GET    /connectors/:id/auth/status        → Poll OAuth status
POST   /connectors/:id/auth/callback      → Handle redirect
POST   /connectors/:id/auth/revoke        → Revoke token

# Discovery
POST   /connectors/:id/discover           → Start discovery
GET    /connectors/:id/discovery           → Get results
POST   /connectors/:id/recommendations    → Generate recommendations
POST   /connectors/:id/quick-setup        → One-click setup

# Sync
POST   /connectors/:id/sync/start         → Start full or delta sync
POST   /connectors/:id/sync/pause         → Pause active sync
POST   /connectors/:id/sync/resume        → Resume from checkpoint
POST   /connectors/:id/sync/restart       → Start fresh
GET    /connectors/:id/sync/status         → Get progress
GET    /connectors/:id/delta-tokens        → List per-drive tokens
DELETE /connectors/:id/delta-tokens/:driveId → Reset a token

# Permissions
POST   /connectors/:id/permissions/crawl   → Start permission crawl
GET    /connectors/:id/permissions/status   → Get crawl progress
PUT    /connectors/:id/permissions/mode     → Update mode
POST   /connectors/:id/permissions/recrawl  → Manual recrawl

# Filters
GET    /connectors/:id/filters/validate    → Validate config
POST   /connectors/:id/filters/preview     → Preview impact
POST   /connectors/:id/filters/apply-template → Apply template
```

---

## Epilogue: What's Next

This connector is production-grade but not finished. Here are the highest-impact improvements:

**Parallel drive sync.** Today we process drives sequentially within a site. Processing them in parallel (with per-drive concurrency control) could cut full sync time by 3-5x for tenants with many libraries.

**Streaming ingestion.** Currently, sync completes first, then ingestion starts. Streaming documents to the ingestion pipeline as they're downloaded would reduce time-to-searchable from "sync time + ingestion time" to "max(sync time, ingestion time)."

**Smart scheduling.** Using content profiles from discovery to set per-drive sync schedules. Active libraries (many recent changes) get hourly delta syncs. Dormant libraries get daily. This reduces API usage without sacrificing freshness where it matters.

**Permission change detection.** Today, permissions are re-crawled on a schedule or manually. Detecting permission changes via delta queries or a dedicated permission webhook would provide near-real-time access control updates.

**Content-aware filtering.** Instead of just file extensions and paths, using the first N bytes of a document to classify it (legal document, engineering spec, marketing asset) and filter based on content relevance to the search index's purpose.

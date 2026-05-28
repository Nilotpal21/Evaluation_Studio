# SharePoint Connector — Class & Sequence Diagrams

> A visual companion to [SHAREPOINT-CONNECTOR-COMPLETE-REFERENCE.md](./SHAREPOINT-CONNECTOR-COMPLETE-REFERENCE.md).
> Every diagram here maps to a scene in that document. Read the story first, then use these diagrams as a quick-reference map.

---

## 1. Class Hierarchy — The Big Picture

This is the inheritance and composition tree for the entire connector system.

```
+-----------------------------------------------------------------------+
|                        <<interface>>                                   |
|                         IConnector                                     |
|-----------------------------------------------------------------------|
| + connectorType: string                                               |
| + config: IConnectorConfig                                            |
|-----------------------------------------------------------------------|
| + initialize(): Promise<void>                                         |
| + validateConfig(): Promise<ValidationResult>                         |
| + testConnection(): Promise<ConnectionTestResult>                     |
| + performFullSync(checkpoint?): Promise<SyncResult>                   |
| + performDeltaSync(): Promise<SyncResult>                             |
| + pauseSync(jobId): Promise<void>                                     |
| + resumeSync(jobId): Promise<void>                                    |
| + crawlPermissions(mode): Promise<PermissionCrawlResult>              |
| + setupWebhook?(url): Promise<WebhookSubscription>                    |
| + handleWebhookNotification?(payload): Promise<void>                  |
| + getResourceDiscovery?(): IResourceDiscovery                         |
+-----------------------------------------------------------------------+
                              ^
                              | implements
                              |
+-----------------------------------------------------------------------+
|                     SharePointConnector                                |
|-----------------------------------------------------------------------|
| - oauthProvider: MicrosoftOAuthProvider                                |
| - tokenManager: TokenManager                                          |
| - graphClient: GraphClient                                            |
| - filterEngine: SharePointFilterEngine                                |
| - fullSyncCoordinator: SharePointFullSyncCoordinator                  |
| - deltaSyncCoordinator: SharePointDeltaSyncCoordinator                |
|-----------------------------------------------------------------------|
| + initialize()                                                        |
| + validateConfig()                                                    |
| + testConnection()                                                    |
| + performFullSync(checkpoint?)  --> fullSyncCoordinator.performSync() |
| + performDeltaSync()            --> deltaSyncCoordinator.performSync() |
| + crawlPermissions(mode)                                              |
| + getResourceDiscovery()        --> new SharePointResourceDiscovery() |
+-----------------------------------------------------------------------+
         |          |            |              |                |
         | creates  | creates    | creates      | creates       | creates
         v          v            v              v               v
  +-----------+ +--------+ +-----------+ +-------------+ +--------------+
  | Microsoft | | Token  | | Graph     | | SharePoint  | | SharePoint   |
  | OAuth     | | Manager| | Client    | | FilterEngine| | FullSync     |
  | Provider  | |        | |           | |             | | Coordinator  |
  +-----------+ +--------+ +-----------+ +-------------+ +--------------+
```

---

## 2. Authentication Classes (Scene 1)

How the three OAuth flows are structured.

```
+-----------------------------------+       +-----------------------------------+
|     <<interface>> IOAuthProvider   |       |          TokenManager             |
|-----------------------------------|       |-----------------------------------|
| + providerName: string            |       | - provider: IOAuthProvider        |
|-----------------------------------|       | - tenantId: string                |
| + requestDeviceCode(scopes)       |       | - userId: string                  |
| + exchangeDeviceCode(code)        |       | - tokenModel: Model<IOAuthToken>  |
| + getAuthorizationUrl(request)    |       | - refreshBufferMinutes: 5         |
| + exchangeAuthorizationCode(...)  |       |-----------------------------------|
| + acquireClientCredentialsToken() |       | + storeTokens(tokens, userId)     |
| + refreshToken(refreshToken)      |       | + getAccessToken()                |
| + revokeToken(token)              |  used | + revokeToken()                   |
| + validateToken(accessToken)      | <---- | + validateToken()                 |
| + needsRefresh(expiresAt, buffer) |  by   | - loadToken()                     |
+-----------------------------------+       | - refreshToken(token)             |
              ^                             +-----------------------------------+
              | implements                            |
              |                                       | provides tokens to
+-----------------------------------+                 v
|     MicrosoftOAuthProvider        |       +-----------------------------------+
|-----------------------------------|       |          GraphClient              |
| - clientId: string                |       | (see HTTP layer below)            |
| - tenantId: string                |       +-----------------------------------+
| - authority: string               |
|-----------------------------------|
| + requestDeviceCode(scopes)       |  Three OAuth 2.0 flows:
| + exchangeDeviceCode(deviceCode)  |  1. Authorization Code (web UI)
| + getAuthorizationUrl(request)    |  2. Device Code (headless / CLI)
| + exchangeAuthorizationCode(...)  |  3. Client Credentials (app-only)
| + acquireClientCredentialsToken() |
| + refreshToken(refreshToken)      |
| + needsRefresh(expiresAt, 5min)   |
| - extractUserIdFromIdToken(jwt)   |
+-----------------------------------+

Token Storage (EndUserOAuthToken model):
+-----------------------------------------------+
| encryptedAccessToken  | AES-encrypted          |
| encryptedRefreshToken | AES-encrypted          |
| expiresAt             | Date (1hr from issue)  |
| revokedAt             | Date | null            |
| consentedAt           | Date                   |
| tenantId              | always scoped          |
+-----------------------------------------------+
```

---

## 3. HTTP & Rate Limiting Layer (Scene 7)

Every API call flows through this stack.

```
+---------------------------------------------------+
|                    GraphClient                     |
|                 extends HttpClient                 |
|---------------------------------------------------|
| Site ops:  getSites(), getSiteByUrl(), searchSites |
| Drive ops: getDrives(), getDrive()                 |
| Items:     getDriveItemsStream() [async generator] |
|            getDriveItemContent()                   |
| Delta:     getDeltaItems(driveId, token?)          |
| Perms:     getItemPermissions(), getGroupMembers() |
| Webhooks:  subscribeToDriveChanges()               |
+---------------------------------------------------+
                      |
                      | extends
                      v
+---------------------------------------------------+
|                    HttpClient                      |
|---------------------------------------------------|
| - rateLimiter: RateLimiter                         |
| - retryHandler: RetryHandler                       |
| - tokenProvider: () => Promise<string>             |
|---------------------------------------------------|
| + get<T>(path, options)                            |
| + post<T>(path, options)                           |
| + put<T>(path, options)                            |
| + delete<T>(path, options)                         |
| - request<T>() -- orchestrates below:              |
+---------------------------------------------------+
         |                         |
         v                         v
+-------------------+    +-------------------------+
|    RateLimiter    |    |     RetryHandler        |
|-------------------|    |-------------------------|
| - tokens: number  |    | Retries on:             |
| - maxTokens       |    |   429 (throttled)       |
| - refillRate/sec  |    |   500, 502, 503, 504   |
|-------------------|    | Backoff:                |
| + acquire(cost)   |    |   1s -> 2s -> 4s        |
| + tryAcquire()    |    |   max 30s, 3 attempts   |
| + reset()         |    +-------------------------+
| - refill()        |
+-------------------+
  Token bucket:
  ~16.67 tokens/sec
  (10K per 10 min)

Request flow:
  GraphClient.getSites()
      |
      v
  HttpClient.get("/sites?search=*")
      |
      v
  RateLimiter.acquire()  -- wait if bucket empty
      |
      v
  TokenManager.getAccessToken()  -- refresh if <5min left
      |
      v
  fetch(url, headers)
      |
      +-- success --> parse JSON --> return
      |
      +-- 429/5xx --> RetryHandler --> backoff --> retry
```

---

## 4. Sync Coordinator Hierarchy (Scene 3 & 4)

The Template Method pattern that powers all sync flows.

```
+------------------------------------------------------------------+
|              <<abstract>> BaseSyncCoordinator                     |
|                   implements ISyncCoordinator                     |
|------------------------------------------------------------------|
| # config: IConnectorConfig                                       |
| # filterEngine: IFilterEngine                                    |
| # models: SyncCoordinatorModels                                  |
|------------------------------------------------------------------|
| + performSync(syncType, checkpoint?, progressCb)  [TEMPLATE]     |
|   |                                                              |
|   |  1. Create or load checkpoint                                |
|   |  2. Mark source as "syncing"                                 |
|   |  3. Call fetchDocuments()        <<abstract>>                 |
|   |  4. For each document:                                       |
|   |     a. filterEngine.evaluate()                               |
|   |     b. createSearchDocument()    [dedup by contentHash]      |
|   |     c. downloadDocument()        <<abstract>>                |
|   |     d. uploadToStorage()                                     |
|   |     e. Check pause every 10 docs                             |
|   |     f. Save checkpoint every 100 docs                        |
|   |  5. crawlPermissionsBatch()      <<abstract>>                |
|   |  6. Mark source as "active"                                  |
|   |  7. Queue ingestion pipeline                                 |
|                                                                  |
| + createSearchDocument(doc)  -- SHA256(docId+modifiedAt) dedup   |
| + uploadToStorage(buffer, doc, id)                               |
| + saveCheckpoint(checkpoint)                                     |
| + loadCheckpoint(connectorId)                                    |
|                                                                  |
| <<abstract>> fetchDocuments(checkpoint): SourceDocument[]         |
| <<abstract>> downloadDocument(doc): Buffer                       |
| <<abstract>> crawlPermissionsBatch(docs): void                   |
| <<abstract>> getDeltaToken(): string | null                      |
+------------------------------------------------------------------+
                    ^                          ^
                    | extends                  | extends
                    |                          |
+--------------------------------+  +----------------------------------+
| SharePointFullSyncCoordinator  |  | SharePointDeltaSyncCoordinator   |
|--------------------------------|  |----------------------------------|
| - graphClient: GraphClient     |  | - graphClient: GraphClient       |
| - deltaTokenManager            |  | - deltaTokenManager              |
|--------------------------------|  |----------------------------------|
| fetchDocuments():              |  | fetchDocuments():                |
|   for each site (filtered):   |  |   for each site (filtered):     |
|     for each drive (filtered):|  |     for each drive:             |
|       stream items in batches |  |       load delta token          |
|       of 100 (async generator)|  |       getDeltaItems(token)      |
|       establish delta token   |  |       handle @removed -> soft   |
|                               |  |         delete (isDeleted=true) |
| downloadDocument():           |  |       save new delta token      |
|   graphClient                 |  |                                  |
|     .getDriveItemContent()    |  | downloadDocument():              |
|                               |  |   graphClient                    |
| crawlPermissionsBatch():      |  |     .getDriveItemContent()       |
|   -> PermissionCrawler        |  |                                  |
|                               |  | crawlPermissionsBatch():         |
| - getSitesFiltered()          |  |   -> PermissionCrawler           |
| - getDrivesFiltered(site)     |  |                                  |
| - getItemsRecursive()         |  | - markDocumentsDeleted(itemIds)  |
| - mapToSourceDocument()       |  | - getSitesFiltered()             |
+--------------------------------+  | - getDrivesFiltered(site)        |
                                    +----------------------------------+

SyncCoordinatorModels (injected by worker):
+--------------------+-----------------+
| SearchDocument     | searchaicontent |
| SearchSource       | searchaicontent |
| SyncCheckpoint     | searchaicontent |
| ConnectorConfig    | platform        |
| DriveDeltaToken    | searchaicontent |
+--------------------+-----------------+
```

---

## 5. Filter Engine (Scene 3)

Two-level filtering: scope (cheap, during enumeration) and document (per-item).

```
+----------------------------------------------+
|        <<abstract>> BaseFilterEngine          |
|----------------------------------------------|
| # config: FilterConfig                       |
|----------------------------------------------|
| + evaluate(doc): FilterResult                |
| # evaluateScope(doc): {passed, reason}       |
| + evaluateExtension(doc): {passed, reason}   |
| + evaluateSize(doc): {passed, reason}        |
| + evaluateDate(doc): {passed, reason}        |
| + evaluatePath(doc): {passed, reason}        |
| # validateScope(errors, warnings)            |
+----------------------------------------------+
                    ^
                    | extends
                    |
+----------------------------------------------+
|         SharePointFilterEngine                |
|----------------------------------------------|
| - spScope: SharePointScopeConfig             |
| - compiledSitePatterns: RegExp[]             |
| - compiledLibraryPatterns: RegExp[]          |
|----------------------------------------------|
| + getSharePointScope()                       |
| + shouldIncludeSite(siteId, siteUrl)         |
| + shouldIncludeLibrary(libraryName)          |
| # evaluateScope(doc) -- override             |
| # validateScope() -- override                |
+----------------------------------------------+

SharePointScopeConfig:
+-------------------------+-------------------------------------+
| siteMode                | 'all' | 'selected' | 'excluded'    |
| siteIds                 | string[]                            |
| sitePatterns            | string[] (glob, e.g. *-archive)     |
| libraryMode             | 'all' | 'selected' | 'excluded'    |
| libraryNames            | string[]                            |
| libraryPatterns         | string[]                            |
| folderPaths             | FolderPathConfig                    |
+-------------------------+-------------------------------------+

Filter evaluation order (cheapest first):
  Level 1: Scope    -- skip entire sites/libraries (no API calls wasted)
  Level 2: Document -- per-item checks:
     extension  -->  include/exclude lists
     path       -->  folder pattern matching
     size       -->  min/max byte range
     date       -->  modified-after threshold
```

---

## 6. Permission System (Scene 5)

The crawler, the graph, and the query-time filter.

```
+-------------------------------------------+
|     SharePointPermissionCrawler           |
|-------------------------------------------|
| - graphClient: GraphClient                |
| - permissionService: PermissionGraphSvc   |
| - config: PermissionCrawlConfig           |
|   { mode, tenantId, sourceId, neo4j }     |
|-------------------------------------------|
| + crawlDocuments(docs[]): CrawlResult     |
| + close()                                 |
| - crawlDocument(doc)                      |
| - processPermission(doc, perm)            |
| - resolveGroupMembers(groupId, docId)     |
|   [full mode only, recursive]             |
| - mapRoles(roles) -> read|write|owner     |
+-------------------------------------------+
         |
         | writes to Neo4j via
         v
+-------------------------------------------+
|       PermissionGraphService              |
|-------------------------------------------|
| + upsertUser(user)                        |
| + upsertGroup(group)                      |
| + upsertDocument(doc)                     |
| + upsertDomain(domain)                    |
| + createPermission(from, to, role)        |
| + createMembership(user/group, group)     |
| + createPublicIn(doc, domain)             |
+-------------------------------------------+

Neo4j Graph Model:

  (User)---[:HAS_PERMISSION {role}]--->(Document)
    |                                      ^
    |                                      |
    +--[:MEMBER_OF]-->(Group)--[:HAS_PERMISSION {role}]--+
                        |
                        +--[:MEMBER_OF]-->(Group)  [recursive, up to 20 levels]

  (Document)---[:PUBLIC_IN]--->(Domain)

  (Document) { publicEveryone: true }  [anonymous access]


Query-Time Permission Filter (4 paths):

  User searches "quarterly report"
         |
         v
  PermissionFilterMiddleware
         |
         v
  Neo4j query (cached in Redis, 5-min TTL):
  +-----------------------------------------------------------+
  | Path 1: User -[:HAS_PERMISSION]-> Document                |
  |         (direct access)                                    |
  |                                                            |
  | Path 2: User -[:MEMBER_OF*1..20]-> Group                  |
  |           -[:HAS_PERMISSION]-> Document                    |
  |         (group access, recursive with cycle detection)     |
  |                                                            |
  | Path 3: Document -[:PUBLIC_IN]-> Domain                    |
  |           WHERE user.domain = domain.domain                |
  |         (domain-scoped public access)                      |
  |                                                            |
  | Path 4: Document.publicEveryone = true                     |
  |         (public to everyone)                               |
  +-----------------------------------------------------------+
         |
         v
  Allowed document IDs --> filter search results
```

---

## 7. Discovery & Recommendations (Scene 2)

```
+---------------------------------------------+
|    <<abstract>> BaseResourceDiscovery        |
|---------------------------------------------|
| + connectorType: string                     |
| + discoverResources(cb): DiscoveredResource[]|
| + profileContent(id, sample): ContentProfile |
+---------------------------------------------+
                   ^
                   | extends
                   |
+---------------------------------------------+
|      SharePointResourceDiscovery            |
|---------------------------------------------|
| - graphClient: GraphClient                  |
|---------------------------------------------|
| + discoverResources(progressCb):            |
|     getSites() -> for each site:            |
|       getDrives(siteId) -> flat list with   |
|       parent-child linkage                  |
|                                             |
| + profileContent(driveId, sampleSize=100):  |
|     sample items from drive, compute:       |
|     - fileTypeDistribution                  |
|     - dateRange (earliest, latest)          |
|     - averageDocumentSizeBytes              |
|     - updateFrequency                       |
|     - sensitivityIndicators                 |
+---------------------------------------------+

DiscoveredResource:                   ContentProfile:
+------------------+--------+        +-----------------------------+
| id               | string |        | resourceId                  |
| name             | string |        | totalDocuments               |
| displayName      | string |        | totalSizeBytes               |
| url              | string |        | fileTypeDistribution         |
| resourceType     | site   |        |   { ".docx": 120, ".pdf": 45 }
|                  | drive  |        | dateRange { earliest, latest }
| parentId         | null   |        | averageDocumentSizeBytes     |
|   (site) or      | siteId |        | updateFrequency              |
|   (drive)        |        |        | sensitivityIndicators[]      |
| metadata         | {}     |        +-----------------------------+
+------------------+--------+

Quick Setup Flow:
  POST /quick-setup
       |
       v
  discover --> profile --> recommend --> accept --> start sync
  (all in one request, AI picks defaults)
```

---

## 8. Delta Token Management (Scene 4)

```
+---------------------------------------------------+
|               DeltaTokenManager                    |
|---------------------------------------------------|
| - tenantId: string                                |
| - connectorId: string                             |
| - model: Model<IDriveDeltaToken>                  |
|---------------------------------------------------|
| + getToken(driveId): string | null                |
| + saveToken(driveId, deltaLink, itemsProcessed?)  |
| + resetToken(driveId)                             |
| + getAllTokens(): Map<driveId, deltaLink>          |
| + getAllTokenRecords(): IDriveDeltaToken[]         |
| + resetAllTokens()                                |
| + getStaleTokens(olderThanHours=48)               |
| + getTokenStats(): {total, items, oldest, newest} |
+---------------------------------------------------+

DriveDeltaToken record (one per drive per connector):
+----------------------------+------------------------------------------+
| tenantId                   | tenant isolation                         |
| connectorId                | which connector owns this                |
| driveId                    | the SharePoint drive                     |
| deltaLink                  | Microsoft's opaque delta URL             |
| lastSyncAt                 | when this token was last refreshed       |
| itemsProcessedSinceToken   | count for monitoring                     |
+----------------------------+------------------------------------------+

Token lifecycle:

  Full Sync                          Delta Sync
  =========                          ==========
  enumerate all items in drive       load token for drive
       |                                  |
       v                                  v
  getDeltaItems(driveId, undefined)  getDeltaItems(driveId, token)
       |                                  |
       v                                  v
  Microsoft returns current state    Microsoft returns only changes
  + @odata.deltaLink                 + new @odata.deltaLink
       |                                  |
       v                                  v
  saveToken(driveId, deltaLink)      saveToken(driveId, newDeltaLink)
  [ESTABLISHED]                      [REFRESHED]
```

---

## 9. Webhook System (Scene 4)

```
+----------------------------------------------+
|        SharePointWebhookManager              |
|----------------------------------------------|
| - graphClient: GraphClient                   |
| - encryptionService: EncryptionService       |
| - config: { connectorId, tenantId, baseUrl } |
|----------------------------------------------|
| + subscribeToAllDrives(driveIds[])           |
| + renewSubscriptions(hoursBeforeExpiry=24)   |
| + unsubscribeAll()                           |
| + validateClientState(encrypted, provided)   |
| + getActiveSubscriptions()                   |
| + getSubscriptionForDrive(driveId)           |
| - subscribeToDrive(driveId)                  |
| - renewSubscription(subscription)            |
+----------------------------------------------+

Subscription lifecycle:

  subscribeToDrive(driveId)
       |
       v
  Generate encrypted clientState
       |
       v
  POST graph.microsoft.com/v1.0/subscriptions
    { changeType: "updated",
      notificationUrl: "https://app/api/webhooks/connectors/{id}/sharepoint",
      resource: "/drives/{driveId}/root",
      expirationDateTime: +24hrs,
      clientState: encrypted }
       |
       v
  Store subscription in DB
       |
       v
  Hourly renewal job checks expiry
       |
       +-- expiring soon? --> renewSubscription()
       +-- renewal failed 3x? --> mark failed, fallback to polling
```

---

## 10. Worker & Service Orchestration (Scene 8)

How the platform layer connects everything together.

```
+-------------------------------------------------------------------+
|                       ConnectorService                             |
|-------------------------------------------------------------------|
| CRUD:   listConnectors, createConnector, getConnector, delete...  |
| Auth:   initiateAuth, getAuthStatus, authCallback, revokeAuth     |
| Sync:   startSync, pauseSync, resumeSync, restartSync, getStatus  |
| Delta:  triggerDeltaSync, listDeltaTokens, resetDeltaToken        |
| Perms:  startPermissionCrawl, getPermissionStatus, updateMode     |
| Filter: validateFilters, previewFilters, applyFilterTemplate      |
+-------------------------------------------------------------------+
       |                    |                       |
       | queues job         | queues job            | queues job
       v                    v                       v
+----------------+  +------------------+  +----------------------+
| connector-sync |  | connector-       |  | connector-permission |
| BullMQ queue   |  | discovery queue  |  | -crawl queue         |
+----------------+  +------------------+  +----------------------+
       |                    |                       |
       v                    v                       v
+----------------+  +------------------+  +----------------------+
| ConnectorSync  |  | ConnectorDiscov  |  | ConnectorPermission  |
| Worker         |  | eryWorker        |  | CrawlWorker          |
+----------------+  +------------------+  +----------------------+

ConnectorSyncWorker internals:

  processConnectorSyncJob(job)
       |
       v
  1. Load ConnectorConfig + SearchSource
       |
       v
  2. Acquire distributed lock
     Redis SET NX PX (key: sync-lock:{indexId}:{connectorId}, TTL: 1hr)
       |
       +-- lock failed? --> exit (another worker is syncing)
       |
       v
  3. Load checkpoint (if resuming)
       |
       v
  4. Update syncState to in-progress
       |
       v
  5. Create SharePointConnector(config, tokenModel, models, doclingQueue)
       |
       v
  6. connector.performFullSync(checkpoint)
     OR connector.performDeltaSync()
       |
       +-- paused? --> save state, exit
       |
       v
  7. Update syncState with results
       |
       v
  8. Queue ingestion job (QUEUE_INGESTION)
       |
       v
  9. Clean up checkpoint, release lock
```

---

## 11. Sequence: Full Sync End-to-End (Scene 3)

A complete trace from "Start Sync" to "documents ready for ingestion."

```
User          Studio UI        ConnectorService     BullMQ Queue      SyncWorker
 |                |                   |                  |                 |
 | click "Sync"   |                   |                  |                 |
 |--------------->|                   |                  |                 |
 |                | POST /sync/start  |                  |                 |
 |                |------------------>|                   |                 |
 |                |                   | validate token    |                 |
 |                |                   | check no active   |                 |
 |                |                   | sync running      |                 |
 |                |                   |                   |                 |
 |                |                   | add job           |                 |
 |                |                   |------------------>|                 |
 |                |                   |                   |                 |
 |                | { jobId }         |                   |                 |
 |                |<------------------|                   |                 |
 |                |                   |                   | pick up job     |
 |                |                   |                   |---------------->|
 |                |                   |                   |                 |
 :                :                   :                   :    WORKER FLOW  :
 :                :                   :                   :                 :
 |                |                   |                   |    1. Acquire   |
 |                |                   |                   |    Redis lock   |
 |                |                   |                   |                 |
 |                |                   |                   |    2. Create    |
 |                |                   |                   |    SharePoint   |
 |                |                   |                   |    Connector    |
 |                |                   |                   |                 |
 |                |                   |                   |    3. initialize|
 |                |                   |                   |    OAuth+Graph  |
 |                |                   |                   |    +Filter+Sync |
 |                |                   |                   |                 |
```

```
SyncWorker     SharePointConnector    FullSyncCoordinator    GraphClient
    |                  |                      |                   |
    | performFullSync  |                      |                   |
    |----------------->|                      |                   |
    |                  | performSync('full')  |                   |
    |                  |--------------------->|                   |
    |                  |                      |                   |
    |                  |                      | getSites()        |
    |                  |                      |------------------>|
    |                  |                      |                   | GET /sites?search=*
    |                  |                      |   sites[]         |
    |                  |                      |<------------------|
    |                  |                      |                   |
    |                  |                      | for each site:    |
    |                  |                      |   shouldInclude   |
    |                  |                      |   Site()?         |
    |                  |                      |                   |
    |                  |                      |   getDrives()     |
    |                  |                      |------------------>|
    |                  |                      |   drives[]        | GET /sites/{id}/drives
    |                  |                      |<------------------|
    |                  |                      |                   |
    |                  |                      | for each drive:   |
    |                  |                      |   shouldInclude   |
    |                  |                      |   Library()?      |
    |                  |                      |                   |
    |                  |                      | getDriveItems     |
    |                  |                      | Stream(100)       |
    |                  |                      |------------------>|
    |                  |                      |   yield batch[100]| GET /drives/{id}/root/children
    |                  |                      |<------------------|
    |                  |                      |                   |
    |                  |                      | for each item:    |
    |                  |                      |   filter(ext,     |
    |                  |                      |    size, path)    |
    |                  |                      |   createSearch    |
    |                  |                      |    Document()     |
    |                  |                      |     [dedup by     |
    |                  |                      |      SHA256]      |
    |                  |                      |                   |
    |                  |                      |   download        |
    |                  |                      |   Document()      |
    |                  |                      |------------------>|
    |                  |                      |   <Buffer>        | GET /drives/{d}/items/{i}/content
    |                  |                      |<------------------|
    |                  |                      |                   |
    |                  |                      |   uploadTo        |
    |                  |                      |   Storage(S3)     |
    |                  |                      |                   |
    |                  |                      |   every 10 docs:  |
    |                  |                      |     check pause   |
    |                  |                      |   every 100 docs: |
    |                  |                      |     save          |
    |                  |                      |     checkpoint    |
    |                  |                      |                   |
    |                  |                      | after drive done: |
    |                  |                      | getDeltaItems     |
    |                  |                      | (driveId, null)   |
    |                  |                      |   --> establish    |
    |                  |                      |   delta token     |
    |                  |                      |                   |
    |                  |   SyncResult         |                   |
    |                  |<---------------------|                   |
    |   SyncResult     |                      |                   |
    |<-----------------|                      |                   |
    |                                                             |
    | queue ingestion job                                         |
    | update syncState                                            |
    | release lock                                                |
```

---

## 12. Sequence: Delta Sync (Scene 4)

The incremental path — only changed documents.

```
Trigger              SyncWorker     DeltaSyncCoordinator   DeltaTokenMgr    GraphClient
  |                      |                  |                   |                |
  | (webhook or          |                  |                   |                |
  |  scheduled job)      |                  |                   |                |
  |--------------------->|                  |                   |                |
  |                      | acquire lock     |                   |                |
  |                      | init connector   |                   |                |
  |                      |                  |                   |                |
  |                      | performDeltaSync |                   |                |
  |                      |----------------->|                   |                |
  |                      |                  |                   |                |
  |                      |                  | for each drive:   |                |
  |                      |                  |   getToken(driveId)|               |
  |                      |                  |------------------>|                |
  |                      |                  |   "delta_abc..."  |                |
  |                      |                  |<------------------|                |
  |                      |                  |                   |                |
  |                      |                  |   getDeltaItems   |                |
  |                      |                  |   (driveId, token)|                |
  |                      |                  |---------------------------------->|
  |                      |                  |   { changes[], newDeltaLink }     |
  |                      |                  |<----------------------------------|
  |                      |                  |                   |                |
  |                      |                  | for each change:  |                |
  |                      |                  |   @removed?       |                |
  |                      |                  |     --> soft delete|                |
  |                      |                  |     (isDeleted=t) |                |
  |                      |                  |   else:           |                |
  |                      |                  |     --> create/    |                |
  |                      |                  |     update doc    |                |
  |                      |                  |     --> download   |                |
  |                      |                  |     --> upload     |                |
  |                      |                  |                   |                |
  |                      |                  |   saveToken       |                |
  |                      |                  |   (driveId, new)  |                |
  |                      |                  |------------------>|                |
  |                      |                  |                   | upsert in DB   |
  |                      |                  |                   |                |
  |                      |   SyncResult     |                   |                |
  |                      |<-----------------|                   |                |
```

---

## 13. Sequence: Webhook Real-Time Chain (Scene 4)

From user editing a file to search results updating.

```
Alice          SharePoint       Microsoft       Our App            SyncWorker
(user)                          Graph           (webhook endpoint)
  |                |                |                |                 |
  | edit doc       |                |                |                 |
  |--------------->|                |                |                 |
  |                | change event   |                |                 |
  |                |--------------->|                |                 |
  |                |                |                |                 |
  |                |                | POST /api/webhooks/connectors    |
  |                |                | /{connectorId}/sharepoint        |
  |                |                |--------------->|                 |
  |                |                |                |                 |
  |                |                |                | validate        |
  |                |                |                | clientState     |
  |                |                |                | (decrypt +      |
  |                |                |                |  compare)       |
  |                |                |                |                 |
  |                |                |                | extract driveId |
  |                |                |                |                 |
  |                |                |                | queue delta     |
  |                |                |                | sync job        |
  |                |                |                |---------------->|
  |                |                |                |                 |
  |                |                |                | 202 Accepted    |
  |                |                |<---------------|                 |
  |                |                |                |                 |
  |                |                |                |      [delta sync runs]
  |                |                |                |      [as shown above]
  |                |                |                |                 |
  |                |                |                |      queue ingestion
  |                |                |                |                 |
  :    ~5 minutes total from edit to searchable     :                 :
```

---

## 14. Sequence: Permission Crawl & Query-Time Filtering (Scene 5)

```
CRAWL PHASE (after sync):

SyncWorker     PermissionCrawler    GraphClient         Neo4j
    |                 |                  |                 |
    | crawlDocuments  |                  |                 |
    | (documents[])   |                  |                 |
    |---------------->|                  |                 |
    |                 |                  |                 |
    |                 | for each doc:    |                 |
    |                 |   getItem        |                 |
    |                 |   Permissions()  |                 |
    |                 |----------------->|                 |
    |                 |   perms[]        |                 |
    |                 |<-----------------|                 |
    |                 |                  |                 |
    |                 | upsert Document node              |
    |                 |---------------------------------->|
    |                 |                  |                 |
    |                 | for each perm:   |                 |
    |                 |   user? -->      |                 |
    |                 |     upsert User  |                 |
    |                 |     + HAS_PERM   |                 |
    |                 |   group? -->     |                 |
    |                 |     upsert Group |                 |
    |                 |     + HAS_PERM   |                 |
    |                 |     [full mode]: |                 |
    |                 |       getGroup   |                 |
    |                 |       Members()  |                 |
    |                 |     ------------>|                 |
    |                 |       members[]  |                 |
    |                 |     <------------|                 |
    |                 |       upsert     |                 |
    |                 |       Users +    |                 |
    |                 |       MEMBER_OF  |                 |
    |                 |   public? -->    |                 |
    |                 |     set public   |                 |
    |                 |     Everyone=t   |                 |
    |                 |                  |     all writes  |
    |                 |---------------------------------->|
    |  CrawlResult    |                  |                 |
    |<----------------|                  |                 |


QUERY PHASE (at search time):

Bob             SearchAPI       PermissionFilter     Neo4j         Redis
(user)              |                 |                |              |
 | search           |                 |                |              |
 | "quarterly"      |                 |                |              |
 |----------------->|                 |                |              |
 |                  | check cache     |                |              |
 |                  |------------------------------------------------>|
 |                  |                 |                |    miss       |
 |                  |<------------------------------------------------|
 |                  |                 |                |              |
 |                  | resolve perms   |                |              |
 |                  |---------------->|                |              |
 |                  |                 | 4-path query   |              |
 |                  |                 |--------------->|              |
 |                  |                 |  docIds[]      |              |
 |                  |                 |<---------------|              |
 |                  |                 |                |              |
 |                  |                 | cache 5min     |              |
 |                  |                 |------------------------------>|
 |                  |                 |                |              |
 |                  | allowed docIds  |                |              |
 |                  |<----------------|                |              |
 |                  |                                  |              |
 |                  | search OpenSearch                |              |
 |                  | with docId filter                |              |
 |                  |                                  |              |
 |  results         |                                  |              |
 |  (only docs Bob  |                                  |              |
 |   can access)    |                                  |              |
 |<-----------------|                                  |              |
```

---

## 15. Sequence: Pause, Resume & Crash Recovery (Scene 6)

```
PAUSE:

User         Studio UI      ConnectorService     Database        SyncWorker
 |               |                |                  |                |
 | click Pause   |                |                  |                |
 |-------------->|                |                  |                |
 |               | POST /pause    |                  |                |
 |               |--------------->|                  |                |
 |               |                | set isPaused=t   |                |
 |               |                |----------------->|                |
 |               |                |                  |                |
 :               :                :                  :   [processing] :
 :               :                :                  :                :
 |               |                |                  |   every 10     |
 |               |                |                  |   docs: check  |
 |               |                |                  |   isPaused     |
 |               |                |                  |       |        |
 |               |                |                  |   isPaused!    |
 |               |                |                  |                |
 |               |                |                  |   save         |
 |               |                |                  |   checkpoint:  |
 |               |                |                  |   { currentSite|
 |               |                |                  |     currentLib |
 |               |                |                  |     nextLink   |
 |               |                |                  |     processed  |
 |               |                |                  |     Count }    |
 |               |                |                  |<---------------|
 |               |                |                  |                |
 |               |                |                  |   release lock |
 |               |                |                  |   return       |
 |               |                |                  |   {paused:true}|


RESUME:

User         Studio UI      ConnectorService     BullMQ          SyncWorker
 |               |                |                 |                |
 | click Resume  |                |                 |                |
 |-------------->|                |                  |                |
 |               | POST /resume   |                  |                |
 |               |--------------->|                  |                |
 |               |                | set isPaused=f   |                |
 |               |                | queue job with   |                |
 |               |                | resumeFrom       |                |
 |               |                | Checkpoint=true  |                |
 |               |                |----------------->|                |
 |               |                |                  | pick up job    |
 |               |                |                  |--------------->|
 |               |                |                  |                |
 |               |                |                  |   load last    |
 |               |                |                  |   checkpoint   |
 |               |                |                  |                |
 |               |                |                  |   resume from  |
 |               |                |                  |   nextLink     |
 |               |                |                  |   (exact OData |
 |               |                |                  |   page where   |
 |               |                |                  |   we stopped)  |
 |               |                |                  |                |
 |               |                |                  |   continue     |
 |               |                |                  |   processing   |


CRASH RECOVERY:

  Worker crashes (OOM / SIGKILL / pod eviction)
       |
       v
  Redis lock auto-expires (1 hour TTL)
       |
       v
  BullMQ retries the job
       |
       v
  New worker picks it up
       |
       v
  Loads last checkpoint (saved every 100 docs)
       |
       v
  Resumes from checkpoint
       |
       v
  Already-processed docs deduplicated by contentHash
  (at most 100 docs re-processed)


  SIGTERM (graceful shutdown):
    1. Stop accepting new jobs
    2. Let current sync reach next checkpoint (up to 100 docs)
    3. Save checkpoint
    4. Release Redis lock
    5. Exit cleanly
```

---

## 16. Data Model Relationships

```
                          platform DB                    searchaicontent DB
                    +---------------------+         +------------------------+
                    |                     |         |                        |
+------------+      |  +---------------+  |         |  +------------------+  |
| SearchIndex|------+->| SearchSource  |--+---------+->| SearchDocument   |  |
| (1)        |      |  | (1 per conn.) |  |         |  | (many per source)|  |
+------------+      |  +-------+-------+  |         |  +------------------+  |
                    |          |           |         |                        |
                    |          v           |         |                        |
                    |  +---------------+   |         |  +------------------+  |
                    |  |ConnectorConfig|   |         |  | SyncCheckpoint   |  |
                    |  +-------+-------+   |         |  | (active sync     |  |
                    |          |           |         |  |  only)           |  |
                    |          |           |         |  +------------------+  |
                    |          |           |         |                        |
                    |     +----+----+      |         |  +------------------+  |
                    |     |         |      |         |  | DriveDeltaToken  |  |
                    |     v         v      |         |  | (1 per drive)    |  |
                    | +---------+ +-----+  |         |  +------------------+  |
                    | |EndUser  | |filter|  |         |                        |
                    | |OAuth    | |Config|  |         +------------------------+
                    | |Token    | |(emb.)|  |
                    | +---------+ +-----+  |
                    |     |                |
                    |     v                |
                    | +---------+          |
                    | |ConnDisc.|  7-day   |
                    | |overy   |  TTL     |
                    | +---------+          |
                    |     |                |
                    |     v                |
                    | +---------+          |
                    | |ConnRec. |  7-day   |
                    | |ommend.  |  TTL     |
                    | +---------+          |
                    +---------------------+

ConnectorConfig (embedded subdocs):
+---------------------------------------------+
| syncState:                                   |
|   syncInProgress, currentJobId,              |
|   lastFullSyncAt, lastDeltaSyncAt,           |
|   documentsProcessed, documentsFailed        |
|----------------------------------------------|
| filterConfig:                                |
|   scope (site/library modes + patterns)      |
|   extensions, paths, sizes, dates            |
|----------------------------------------------|
| permissionConfig:                            |
|   mode: full | simplified | disabled         |
|   neo4jConfig                                |
|----------------------------------------------|
| connectionConfig:                            |
|   tenantUrl, tenantId, clientId              |
|----------------------------------------------|
| oauthTokenId --> EndUserOAuthToken._id       |
+---------------------------------------------+
```

---

## 17. Complete Journey — One Document Through the System (Scene 9)

```
Alice uploads Q1-Report.docx to SharePoint
                |
                v
T+0   SharePoint stores the file in Engineering > Specs library
                |
                v
T+1   Microsoft Graph sends webhook to our app
                |
                v
      WebhookManager.validateClientState() --> OK
      Extract driveId from notification
                |
                v
      Queue delta sync job for this drive
                |
                v
T+2   SyncWorker picks up job
      Acquire Redis lock (sync-lock:{indexId}:{connectorId})
      Load delta token for Specs drive
                |
                v
      GraphClient.getDeltaItems(specsDriveId, token)
      Microsoft returns: [ { Q1-Report.docx, created } ]
                |
                v
T+2.5 FullSyncCoordinator:
      createSearchDocument() --> SHA256(itemId + modifiedAt) --> contentHash
      downloadDocument() --> GraphClient.getDriveItemContent()
      uploadToStorage() --> S3: s3://bucket/tenant/source/doc/Q1-Report.docx
      SearchDocument.status = "pending"
                |
                v
T+3   PermissionCrawler:
      GraphClient.getItemPermissions(driveId, itemId)
      Returns: [ { Engineering group: read } ]
                |
                v
      Neo4j writes:
        (:Group {groupId:'eng-group'}) -[:HAS_PERMISSION {role:'read'}]-> (:Document {docId})
                |
                v
T+4   Ingestion pipeline picks up pending document:
      Docling extracts text
      Embedding model creates vectors
      OpenSearch indexes everything
      SearchDocument.status = "indexed"
                |
                v
T+5   Bob (engineer, member of Engineering group) searches "quarterly report"
                |
                v
      PermissionFilterMiddleware:
        Neo4j query --> Bob -[:MEMBER_OF]-> Engineering -[:HAS_PERMISSION]-> doc
        Result: doc IS accessible
        Cache in Redis (5-min TTL)
                |
                v
      OpenSearch returns Q1-Report.docx in results
      Bob sees the document. Success.
                |
                |
      Meanwhile: Charlie (Sales) searches same thing
                |
                v
      PermissionFilterMiddleware:
        Neo4j query --> no path from Charlie to doc
        Result: doc NOT accessible
                |
                v
      Charlie sees nothing. SharePoint permissions preserved.
```

---

## How to Read These Diagrams

- **Class diagrams** use `+` for public, `-` for private, `#` for protected
- **`<<abstract>>`** marks methods that subclasses must implement
- **`<<interface>>`** marks contracts with no implementation
- **Sequence diagrams** read top-to-bottom as time flows
- **Solid arrows** (`-->`) are synchronous calls
- **Dashed arrows** are responses
- **`[text in brackets]`** are notes or conditions
- All file paths match those in the [File Map (Scene 10)](./SHAREPOINT-CONNECTOR-COMPLETE-REFERENCE.md#scene-10-the-file-map)

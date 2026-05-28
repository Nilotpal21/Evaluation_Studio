# SearchAI Connectors Framework

**Purpose**: Comprehensive guide for building, reviewing, and maintaining enterprise data connectors in the SearchAI platform.

**Use this skill for**:

- Onboarding engineers to connector architecture
- Reviewing connector implementations with `search-ai-architect`
- Developing new connectors with `search-ai-development`
- Field mapping and schema validation
- Catching missing patterns or anti-patterns

---

## 1. Architecture Overview

### 1.1 Package Structure

```
packages/connectors/
├── base/                          # @agent-platform/connectors-base
│   ├── interfaces/                # Core contracts (IConnector, ISyncCoordinator, etc.)
│   ├── auth/                      # OAuth Device Code Flow, TokenManager
│   ├── client/                    # RateLimiter, RetryHandler, HttpClient
│   ├── sync/                      # BaseSyncCoordinator (template method pattern)
│   ├── filters/                   # BaseFilterEngine
│   └── discovery/                 # BaseResourceDiscovery
│
├── sharepoint/                    # @agent-platform/connector-sharepoint
│   ├── auth/                      # MicrosoftOAuthProvider
│   ├── client/                    # GraphClient (Microsoft Graph API)
│   ├── sync/                      # FullSyncCoordinator, DeltaSyncCoordinator
│   ├── filters/                   # SharePointFilterEngine
│   ├── permissions/               # SharePointPermissionCrawler
│   ├── discovery/                 # SharePointResourceDiscovery
│   └── webhooks/                  # SharePointWebhookManager
│
└── [future: jira, confluence, hubspot, servicenow, salesforce]
```

### 1.2 Design Principles

1. **Reusability**: Base package provides 90% of functionality. Connectors only implement provider-specific logic.
2. **Consistency**: All connectors implement `IConnector` with identical API surface.
3. **Extensibility**: Template method pattern allows easy customization.
4. **Independence**: Each connector is a separate npm package with independent versioning.
5. **Security First**: Permissions verified at query time, credentials encrypted at rest.
6. **Observable**: Complete visibility into sync status, failures, and metrics.

---

## 2. Core Interfaces

### 2.1 IConnector (Main Contract)

**Location**: `packages/connectors/base/src/interfaces/connector.interface.ts`

```typescript
interface IConnector {
  connectorType: string;
  config: IConnectorConfig;

  // Lifecycle
  initialize(): Promise<void>;
  validateConfig(): Promise<ValidationResult>;
  testConnection(): Promise<ConnectionTestResult>;

  // Sync Operations
  performFullSync(): Promise<SyncResult>;
  performDeltaSync(): Promise<SyncResult>;
  pauseSync(jobId: string): Promise<void>;
  resumeSync(jobId: string): Promise<void>;

  // Permissions
  crawlPermissions(mode: 'full' | 'simplified' | 'disabled'): Promise<PermissionCrawlResult>;

  // Optional: Webhooks
  setupWebhook?(notificationUrl: string): Promise<WebhookSubscription>;
  handleWebhookNotification?(payload: any): Promise<void>;

  // Optional: Resource Discovery
  getResourceDiscovery?(): IResourceDiscovery;
}
```

**Key Methods**:

- `initialize()` - Sets up OAuth, HTTP clients, sync coordinators
- `performFullSync()` - Complete enumeration of all documents
- `performDeltaSync()` - Incremental changes only (uses delta tokens)
- `crawlPermissions()` - Fetches per-document permissions for query-time filtering

### 2.2 ISyncCoordinator

**Location**: `packages/connectors/base/src/interfaces/sync-coordinator.interface.ts`

```typescript
interface ISyncCoordinator {
  performSync(syncType: 'full' | 'delta', checkpoint?, progressCallback?): Promise<SyncResult>;
  fetchDocuments(checkpoint: ISyncCheckpoint | null): Promise<SourceDocument[]>;
  getDeltaToken(): Promise<string | null>;
  saveCheckpoint(checkpoint: ISyncCheckpoint): Promise<void>;
  loadCheckpoint(connectorId: string): Promise<ISyncCheckpoint | null>;
}
```

**Template Method Pattern**: `BaseSyncCoordinator` provides:

- Checkpoint management
- Progress tracking
- SearchDocument creation
- Ingestion pipeline triggering
- Error handling

**Connector implements**:

- `fetchDocuments()` - Provider-specific data fetching
- `getDeltaToken()` - Returns stored delta token

### 2.3 IFilterEngine

**Location**: `packages/connectors/base/src/interfaces/filter-engine.interface.ts`

```typescript
interface IFilterEngine {
  config: FilterConfig;
  evaluate(document: SourceDocument): FilterEvaluationResult;
  validate(): { valid: boolean; errors: Array<{ field: string; message: string }> };
  getStatistics(): { totalEvaluations; included; excluded; exclusionReasons };
}
```

**BaseFilterEngine provides**:

- Date filters (modifiedSince, modifiedBefore, createdSince, createdBefore)
- Size filters (minSizeBytes, maxSizeBytes)
- Content type filters
- Include/exclude mode logic
- Statistics tracking

**Connector implements**:

- `evaluateCustomFilters()` - Provider-specific filters (e.g., site URLs, project keys)

### 2.4 IPermissionCrawler

**Location**: `packages/connectors/base/src/interfaces/permission-crawler.interface.ts`

```typescript
interface IPermissionCrawler {
  mode: 'full' | 'simplified' | 'disabled';
  crawlDocument(documentId: string, sourceMetadata: any): Promise<NormalizedPermission>;
  crawlBatch(documentIds: string[], options?): Promise<DocumentPermissionData[]>;
  getExpectedAccuracy(): number;
  getRequiredScopes(): string[];
}
```

**Permission Modes**:

- **Full** (100% accurate): Requires full OAuth scopes (e.g., `Sites.FullControl.All`)
- **Simplified** (95% accurate): Uses read-only scopes, infers permissions
- **Disabled**: Skip permission crawling entirely (all docs visible to all users)

### 2.5 IResourceDiscovery

**Location**: `packages/connectors/base/src/interfaces/resource-discovery.interface.ts`

```typescript
interface IResourceDiscovery {
  connectorType: string;
  discoverResources(progressCallback?): Promise<DiscoveredResource[]>;
  profileContent(resourceId: string, sampleSize?): Promise<ContentProfile>;
}
```

**Purpose**: Auto-discovery of sites, libraries, spaces, projects before sync.

**Returns**:

- **DiscoveredResource**: Hierarchy of resources (sites → drives → libraries)
- **ContentProfile**: File type distribution, size stats, date ranges, sensitivity indicators

---

## 3. Database Models

### 3.1 ConnectorConfig

**Location**: `packages/database/src/models/connector-config.model.ts`

**Schema**:

```typescript
{
  _id: string;                     // UUIDv7
  tenantId: string;                // Tenant isolation
  sourceId: string;                // References SearchSource._id
  connectorType: 'sharepoint' | 'jira' | 'confluence' | ...;

  // Authentication
  oauthTokenId: string | null;     // References EndUserOAuthToken._id
  connectionConfig: {
    tenantUrl?: string;            // Base URL (e.g., https://contoso.sharepoint.com)
    clientId?: string;             // OAuth client ID
    scopes?: string[];             // Required OAuth scopes
    [key: string]: any;            // Provider-specific config
  };

  // Sync State
  syncState: {
    lastFullSyncAt: Date | null;
    lastDeltaSyncAt: Date | null;
    deltaToken: string | null;     // For incremental sync
    checkpointData: any | null;    // For pause/resume
    totalDocuments: number;
    processedDocuments: number;
    failedDocuments: number;
    currentJobId: string | null;
    syncInProgress: boolean;
    lastSyncError: string | null;
  };

  // Filters
  filterConfig: {
    mode: 'include' | 'exclude';
    siteUrls: string[];            // SharePoint-specific
    libraryNames: string[];
    contentTypes: string[];
    modifiedSince: Date | null;
  };

  // Permissions
  permissionConfig: {
    mode: 'full' | 'simplified' | 'disabled';
    crawlSchedule: string | null;  // Cron expression
    lastCrawlAt: Date | null;
    currentJobId: string | null;
    crawlInProgress: boolean;
    documentsProcessed: number;
    averageAccuracy: number;
    lastCrawlError: string | null;
  };

  // Error Tracking
  errorState: {
    consecutiveFailures: number;
    lastErrorAt: Date | null;
    lastErrorMessage: string | null;
    isPaused: boolean;
    pausedAt: Date | null;
    pauseReason: string | null;
  };

  // Setup Metadata
  configurationSource: 'manual' | 'quick_setup' | 'imported';
  discoveryId: string | null;
  recommendationId: string | null;
  autoConfiguredAt: Date | null;
}
```

**Indexes**:

- `{ tenantId: 1, sourceId: 1 }` (unique)
- `{ tenantId: 1, connectorType: 1 }`
- `{ 'errorState.isPaused': 1, oauthTokenId: 1 }`

### 3.2 SearchDocument

**Location**: `packages/database/src/models/search-document.model.ts`

**Schema**:

```typescript
{
  _id: string;
  tenantId: string;
  indexId: string;
  sourceId: string;
  connectorId: string | null;      // Links to ConnectorConfig._id
  contentHash: string;             // SHA-256 for deduplication
  originalReference: string | null;
  contentType: string | null;      // MIME type
  contentSizeBytes: number;
  sourceUrl: string | null;
  extractedText: string | null;
  language: string | null;
  entities: Array<{type, value, confidence}>;
  summary: string | null;
  sourceMetadata: any | null;      // Provider-specific metadata
  classification?: IDocumentClassification;
  entityInstances?: IEntityInstance[];
  metadata: { kgState?: IDocumentKGState; [key: string]: any };
  status: string;
  processingError: string | null;
  chunkCount: number;
  pageCount?: number;
  isDeleted: boolean;              // Soft delete for delta sync
  deletedAt: Date | null;
}
```

**sourceMetadata Field Mapping** (examples):

**SharePoint**:

```typescript
sourceMetadata: {
  sharepoint: {
    siteId: string;
    siteUrl: string;
    siteName: string;
    driveId: string;
    driveName: string;
    itemId: string;
    webUrl: string;
    createdBy: {
      (displayName, email);
    }
    lastModifiedBy: {
      (displayName, email);
    }
    parentReference: {
      (driveId, id, path);
    }
  }
}
```

**Jira** (future):

```typescript
sourceMetadata: {
  jira: {
    issueKey: string;
    projectKey: string;
    issueType: string;
    status: string;
    priority: string;
    assignee: { displayName, accountId };
    reporter: { displayName, accountId };
    labels: string[];
    components: string[];
  }
}
```

### 3.3 SourceDocument (Pre-Normalization)

**Location**: `packages/connectors/base/src/interfaces/sync-coordinator.interface.ts`

```typescript
interface SourceDocument {
  id: string; // Unique ID in source system
  name: string; // Document name/title
  url: string; // Direct URL to document
  contentType: string; // MIME type
  sizeBytes: number;
  modifiedAt: Date;
  createdAt: Date;
  content: Buffer | null; // Raw content (if inline) or null (if needs fetch)
  metadata: Record<string, any>; // Connector-specific metadata
}
```

**Mapping Flow**:

```
Provider-Specific Data → SourceDocument → SearchDocument → SearchChunk
```

---

## 4. OAuth & Authentication

### 4.1 Device Code Flow (RFC 8628)

**Why Device Code Flow?**

- CLI-friendly (no redirect URLs)
- Works in headless environments
- Secure (user authenticates in browser)

**Flow**:

```
1. App requests device code → { deviceCode, userCode, verificationUri, interval }
2. User visits verificationUri and enters userCode
3. App polls token endpoint every `interval` seconds
4. On success: { accessToken, refreshToken, expiresIn, scope }
```

**Implementation**: `DeviceCodeFlowAuthenticator` (base package)

```typescript
const provider = new MicrosoftOAuthProvider({ clientId, tenantId });
const authenticator = new DeviceCodeFlowAuthenticator(provider);

const tokens = await authenticator.authenticate(['Sites.Read.All'], (deviceCode) => {
  console.log(`Visit: ${deviceCode.verificationUri}`);
  console.log(`Enter code: ${deviceCode.userCode}`);
});

// tokens: { accessToken, refreshToken, expiresIn, scope }
```

### 4.2 TokenManager

**Location**: `packages/connectors/base/src/auth/token-manager.ts`

**Purpose**: Automatic token refresh before expiry (5-minute buffer).

```typescript
const tokenManager = new TokenManager(oauthProvider, tenantId, userId, EndUserOAuthTokenModel);

// Always returns valid token (refreshes if needed)
const accessToken = await tokenManager.getAccessToken();
```

**Storage**: `EndUserOAuthToken` model (encrypted at rest).

### 4.3 OAuth Provider Interface

```typescript
interface IOAuthProvider {
  providerName: string;
  clientId: string;
  requestDeviceCode(scopes: string[]): Promise<DeviceCodeResponse>;
  exchangeDeviceCode(deviceCode: string): Promise<OAuthTokens>;
  refreshToken(refreshToken: string): Promise<TokenRefreshResult>;
  revokeToken(token: string): Promise<void>;
  validateToken(token: string): Promise<TokenValidationResult>;
}
```

**Implementations**:

- `MicrosoftOAuthProvider` (SharePoint)
- `AtlassianOAuthProvider` (Jira, Confluence) - future
- `GoogleOAuthProvider` (Drive, Gmail) - future

---

## 5. HTTP Client & Rate Limiting

### 5.1 RateLimiter (Token Bucket Algorithm)

**Location**: `packages/connectors/base/src/client/rate-limiter.ts`

```typescript
const rateLimiter = new RateLimiter(
  10000, // maxTokens (capacity)
  16.67, // refillRate (tokens per second)
);

// Acquires 1 token (waits if bucket empty)
await rateLimiter.acquire();

// Acquires 5 tokens
await rateLimiter.acquire(5);
```

**Microsoft Graph Example**:

- Limit: 10,000 requests per 10 minutes
- Rate: 10000 / 600 = ~16.67 req/sec

### 5.2 RetryHandler (Exponential Backoff)

**Location**: `packages/connectors/base/src/client/retry-handler.ts`

```typescript
const retryHandler = new RetryHandler({
  maxAttempts: 3,
  initialDelayMs: 1000,
  maxDelayMs: 30000,
  backoffMultiplier: 2,
  retryableStatusCodes: [408, 429, 500, 502, 503, 504],
});

const result = await retryHandler.execute(async () => {
  return await apiClient.get('/resource');
});
```

**Retry-After Header**: Respects `Retry-After` on 429 responses.

### 5.3 HttpClient (Base Class)

**Location**: `packages/connectors/base/src/client/http-client.ts`

```typescript
class GraphClient extends HttpClient {
  constructor(config: GraphClientConfig) {
    super({
      baseUrl: 'https://graph.microsoft.com/v1.0',
      defaultHeaders: { Authorization: `Bearer ${token}` },
      rateLimiter: new RateLimiter(10000, 16.67),
      timeoutMs: 30000,
      retryOptions: { maxAttempts: 3, ... },
      tokenProvider: () => tokenManager.getAccessToken()  // Auto-refresh
    });
  }
}
```

**Methods**: `get()`, `post()`, `put()`, `patch()`, `delete()`

---

## 6. Sync Coordinators

### 6.1 BaseSyncCoordinator (Template Method)

**Location**: `packages/connectors/base/src/sync/base-sync-coordinator.ts`

**Skeleton Algorithm**:

```typescript
async performSync(syncType: 'full' | 'delta') {
  // 1. Load checkpoint (if resuming)
  const checkpoint = await this.loadCheckpoint(this.config._id);

  // 2. Fetch documents (CONNECTOR IMPLEMENTS)
  const documents = await this.fetchDocuments(checkpoint);

  // 3. Apply filters
  for (const doc of documents) {
    const result = this.filterEngine.evaluate(doc);
    if (!result.include) continue;

    // 4. Create SearchDocument
    const searchDoc = await this.createSearchDocument(doc);

    // 5. Trigger ingestion pipeline
    await this.triggerIngestion(searchDoc);

    // 6. Save checkpoint (every 100 docs)
    if (processedCount % 100 === 0) {
      await this.saveCheckpoint(checkpoint);
    }
  }

  // 7. Update sync state
  await this.updateConnectorSyncState({
    lastFullSyncAt: new Date(),
    totalDocuments: documents.length,
    processedDocuments: successCount,
    failedDocuments: errorCount
  });
}
```

**Connector Implements**:

```typescript
protected async fetchDocuments(checkpoint: ISyncCheckpoint | null): Promise<SourceDocument[]> {
  // Provider-specific logic:
  // - SharePoint: enumerate sites → drives → items
  // - Jira: enumerate projects → issues → comments
  // - Confluence: enumerate spaces → pages → attachments
  return documents;
}

protected async getDeltaToken(): Promise<string | null> {
  return this.config.syncState.deltaToken || null;
}
```

### 6.2 Checkpoint Structure

```typescript
interface ISyncCheckpoint {
  _id: string;
  tenantId: string;
  connectorId: string;
  syncType: 'full' | 'delta';
  state: {
    currentSiteUrl?: string; // SharePoint
    currentLibraryId?: string; // SharePoint
    currentProjectKey?: string; // Jira
    processedCount: number;
    lastProcessedId?: string;
    [key: string]: any; // Provider-specific state
  };
  createdAt: Date;
  updatedAt: Date;
}
```

### 6.3 Full Sync vs Delta Sync

**Full Sync**:

- Enumerates ALL documents from scratch
- No delta token required
- Use for: initial sync, recovery from errors
- Slower but complete

**Delta Sync**:

- Fetches only changes since last sync
- Requires delta token from provider
- Use for: scheduled incremental updates
- Faster but depends on provider support

**Delta Token Storage**:

- **SharePoint**: Per-drive delta tokens in `DriveDeltaToken` model
- **Jira**: Single delta cursor in `ConnectorConfig.syncState.deltaToken`

---

## 7. Filter Engines

### 7.1 BaseFilterEngine

**Location**: `packages/connectors/base/src/filters/base-filter-engine.ts`

**Built-in Filters**:

- **Date**: modifiedSince, modifiedBefore, createdSince, createdBefore
- **Size**: minSizeBytes, maxSizeBytes
- **Content Type**: MIME type matching
- **Mode**: include vs exclude logic

**Usage**:

```typescript
const filterEngine = new BaseFilterEngine({
  mode: 'include',
  modifiedSince: new Date('2024-01-01'),
  contentTypes: [
    'application/pdf',
    'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
  ],
  minSizeBytes: 1024,
  maxSizeBytes: 10485760, // 10MB
});

const result = filterEngine.evaluate(document);
// result: { include: true/false, reason?: string, appliedFilters: ['modifiedSince', 'contentType'] }
```

### 7.2 Connector-Specific Filters

**SharePointFilterEngine**:

```typescript
class SharePointFilterEngine extends BaseFilterEngine {
  protected evaluateCustomFilters(document: SourceDocument) {
    // Site URL filter
    if (this.config.siteUrls?.length > 0) {
      const siteUrl = document.metadata.sharepoint.siteUrl;
      const matches = this.config.siteUrls.some((url) => siteUrl.includes(url));
      if (!matches && this.config.mode === 'include') {
        return { matches: false, reason: 'Site URL not in include list' };
      }
    }

    // Library name filter
    if (this.config.libraryNames?.length > 0) {
      const libraryName = document.metadata.sharepoint.driveName;
      const matches = this.config.libraryNames.some((name) => libraryName.includes(name));
      if (!matches && this.config.mode === 'include') {
        return { matches: false, reason: 'Library not in include list' };
      }
    }

    // SharePoint content type filter
    if (this.config.sharePointContentTypes?.length > 0) {
      const spContentType = this.getSharePointContentType(document.contentType);
      const matches = this.config.sharePointContentTypes.includes(spContentType);
      if (!matches && this.config.mode === 'include') {
        return { matches: false, reason: 'Content type not in include list' };
      }
    }

    return { matches: true, filters: ['siteUrl', 'libraryName', 'sharePointContentType'] };
  }
}
```

### 7.3 Filter Validation

```typescript
validate(): { valid: boolean; errors: Array<{field: string, message: string}> } {
  const errors = [];

  // Validate site URLs
  for (const url of this.config.siteUrls) {
    try {
      new URL(url);
    } catch {
      errors.push({ field: 'siteUrls', message: `Invalid URL: ${url}` });
    }
  }

  // Validate date ranges
  if (this.config.modifiedSince && this.config.modifiedBefore) {
    if (this.config.modifiedSince > this.config.modifiedBefore) {
      errors.push({ field: 'modifiedSince', message: 'modifiedSince must be before modifiedBefore' });
    }
  }

  return { valid: errors.length === 0, errors };
}
```

---

## 8. Permission Crawling

### 8.1 Permission Modes

**Full Mode** (100% accurate):

- Fetches exact permissions from source API
- Requires elevated OAuth scopes (e.g., `Sites.FullControl.All`)
- Resolves group memberships
- Slower but complete

**Simplified Mode** (95% accurate):

- Uses read-only OAuth scopes (e.g., `Sites.Read.All`)
- Infers permissions from parent containers
- Faster but may miss edge cases

**Disabled Mode**:

- Skips permission crawling entirely
- All documents visible to all tenant users
- Use for: public data, testing, trusted environments

### 8.2 NormalizedPermission Structure

```typescript
interface NormalizedPermission {
  users: Array<{
    userId: string; // Email or account ID
    displayName: string;
    permissions: string[]; // ['read', 'write', 'delete', 'share']
  }>;
  groups: Array<{
    groupId: string;
    displayName: string;
    permissions: string[];
  }>;
  everyone: boolean; // Public access flag
}
```

### 8.3 Neo4j Permission Graph

**Purpose**: Query-time permission filtering

**Nodes**:

- `User` (userId, displayName, email)
- `Group` (groupId, displayName)
- `Document` (documentId, sourceId, tenantId)

**Relationships**:

- `(User)-[:MEMBER_OF]->(Group)`
- `(User)-[:HAS_PERMISSION {permissions: ['read']}]->(Document)`
- `(Group)-[:HAS_PERMISSION {permissions: ['read', 'write']}]->(Document)`

**Query** (at search time):

```cypher
MATCH (u:User {userId: $currentUserId})-[:HAS_PERMISSION]->(d:Document {documentId: $docId})
RETURN d

UNION

MATCH (u:User {userId: $currentUserId})-[:MEMBER_OF]->(g:Group)-[:HAS_PERMISSION]->(d:Document {documentId: $docId})
RETURN d
```

### 8.4 Permission Crawler Implementation

```typescript
class SharePointPermissionCrawler implements IPermissionCrawler {
  async crawlDocument(documentId: string, sourceMetadata: any): Promise<NormalizedPermission> {
    const { driveId, itemId } = sourceMetadata.sharepoint;

    if (this.mode === 'full') {
      // Fetch exact permissions from Graph API
      const permissions = await this.graphClient.getItemPermissions(driveId, itemId);
      return this.normalizePermissions(permissions);
    } else {
      // Simplified: inherit from drive
      const drivePermissions = await this.graphClient.getDrivePermissions(driveId);
      return this.normalizePermissions(drivePermissions);
    }
  }

  private normalizePermissions(rawPermissions: any[]): NormalizedPermission {
    const users = [];
    const groups = [];
    let everyone = false;

    for (const perm of rawPermissions) {
      if (perm.grantedToIdentitiesV2) {
        for (const identity of perm.grantedToIdentitiesV2) {
          if (identity.user) {
            users.push({
              userId: identity.user.email || identity.user.id,
              displayName: identity.user.displayName,
              permissions: this.mapRoles(perm.roles),
            });
          } else if (identity.group) {
            groups.push({
              groupId: identity.group.id,
              displayName: identity.group.displayName,
              permissions: this.mapRoles(perm.roles),
            });
          }
        }
      }

      if (perm.link?.scope === 'anonymous') {
        everyone = true;
      }
    }

    return { users, groups, everyone };
  }
}
```

---

## 9. API Endpoints

### 9.1 Connector Management

**Studio Proxy** (frontend calls these):

```
POST   /api/search-ai/indexes/:indexId/connectors
GET    /api/search-ai/indexes/:indexId/connectors
GET    /api/search-ai/indexes/:indexId/connectors/:id
PUT    /api/search-ai/indexes/:indexId/connectors/:id
DELETE /api/search-ai/indexes/:indexId/connectors/:id
```

**SearchAI Service** (backend implementation):

```
POST   /api/connectors
GET    /api/connectors?tenantId=X&sourceId=Y
GET    /api/connectors/:id
PUT    /api/connectors/:id
DELETE /api/connectors/:id
```

### 9.2 Authentication

```
POST /api/search-ai/connectors/:connectorId/auth/initiate
→ Returns: { deviceCode, userCode, verificationUri, interval, expiresIn }

GET /api/search-ai/connectors/:connectorId/auth/status
→ Returns: { status: 'pending' | 'completed' | 'expired', userId?, error? }
```

**Flow**:

1. Frontend calls `/auth/initiate`
2. Displays QR code + user code to user
3. Polls `/auth/status` every 5 seconds
4. Backend polls OAuth provider
5. On success: creates `EndUserOAuthToken`, links to `ConnectorConfig`

### 9.3 Sync Operations

```
POST /api/search-ai/connectors/:connectorId/sync/start
→ Body: { syncType: 'full' | 'delta' }
→ Returns: { jobId, status: 'started' }

GET /api/search-ai/connectors/:connectorId/sync/status
→ Returns: {
    status: 'idle' | 'syncing' | 'paused' | 'failed',
    progress: { processedCount, totalCount?, percentComplete },
    rate: { docsPerSecond, estimatedCompletionTime },
    lastSync: { type: 'full' | 'delta', completedAt, result }
  }
```

### 9.4 Resource Discovery

```
POST /api/search-ai/connectors/:connectorId/discover
→ Returns: {
    resources: DiscoveredResource[],   // Sites, drives, spaces, projects
    totalResources: number
  }

POST /api/search-ai/connectors/:connectorId/discovery/profile
→ Body: { resourceId, sampleSize?: 100 }
→ Returns: ContentProfile {
    totalDocuments, totalSizeBytes,
    fileTypeDistribution: { 'pdf': 120, 'docx': 45 },
    dateRange: { earliest, latest },
    averageDocumentSizeBytes,
    updateFrequency: 'daily' | 'weekly' | 'monthly' | 'rarely',
    sensitivityIndicators: ['confidential', 'pii'],
    sampleDocumentCount
  }
```

### 9.5 Quick Setup & Recommendations

```
POST /api/search-ai/connectors/:connectorId/quick-setup
→ Auto-discovers resources and generates filter recommendations
→ Returns: { discoveryId, recommendations: ConnectorRecommendation[] }

POST /api/search-ai/connectors/:connectorId/recommendations/:recommendationId/accept
→ Applies recommended filters to connector
```

---

## 10. Building a New Connector

### 10.1 Step-by-Step Guide

**1. Create Package**:

```bash
cd packages/connectors
mkdir my-connector
cd my-connector
pnpm init
```

**2. Implement OAuth Provider**:

```typescript
// src/auth/my-oauth-provider.ts
export class MyOAuthProvider implements IOAuthProvider {
  readonly providerName = 'my_service';
  readonly clientId: string;

  async requestDeviceCode(scopes: string[]): Promise<DeviceCodeResponse> {
    // Provider-specific device code request
    const response = await fetch('https://oauth.myservice.com/device/code', {
      method: 'POST',
      body: new URLSearchParams({ client_id: this.clientId, scope: scopes.join(' ') })
    });
    const data = await response.json();
    return { deviceCode: data.device_code, userCode: data.user_code, ... };
  }

  async exchangeDeviceCode(deviceCode: string): Promise<OAuthTokens> { ... }
  async refreshToken(refreshToken: string): Promise<TokenRefreshResult> { ... }
}
```

**3. Implement API Client**:

```typescript
// src/client/my-api-client.ts
export class MyAPIClient extends HttpClient {
  constructor(config: { accessToken: string }) {
    super({
      baseUrl: 'https://api.myservice.com/v1',
      defaultHeaders: { Authorization: `Bearer ${config.accessToken}` },
      rateLimiter: new RateLimiter(300, 5), // 300 req per minute
      timeoutMs: 30000,
      retryOptions: { maxAttempts: 3 },
    });
  }

  async getProjects(): Promise<Project[]> {
    const response = await this.get('/projects');
    return response.data.projects;
  }

  async getIssues(projectId: string): Promise<Issue[]> {
    const response = await this.get(`/projects/${projectId}/issues`);
    return response.data.issues;
  }
}
```

**4. Implement Sync Coordinator**:

```typescript
// src/sync/my-full-sync-coordinator.ts
export class MyFullSyncCoordinator extends BaseSyncCoordinator {
  private apiClient: MyAPIClient;

  async fetchDocuments(checkpoint: ISyncCheckpoint | null): Promise<SourceDocument[]> {
    const documents: SourceDocument[] = [];

    // Enumerate hierarchy: projects → issues → comments
    const projects = await this.apiClient.getProjects();

    for (const project of projects) {
      const issues = await this.apiClient.getIssues(project.id);

      for (const issue of issues) {
        documents.push(this.mapToSourceDocument(project, issue));
      }
    }

    return documents;
  }

  async getDeltaToken(): Promise<string | null> {
    return this.config.syncState.deltaToken || null;
  }

  private mapToSourceDocument(project: Project, issue: Issue): SourceDocument {
    return {
      id: issue.id,
      name: issue.title,
      url: issue.webUrl,
      contentType: 'application/json',
      sizeBytes: JSON.stringify(issue).length,
      modifiedAt: new Date(issue.updatedAt),
      createdAt: new Date(issue.createdAt),
      content: null, // Will be fetched separately
      metadata: {
        myservice: {
          projectId: project.id,
          projectKey: project.key,
          issueType: issue.type,
          status: issue.status,
          assignee: issue.assignee,
        },
      },
    };
  }
}
```

**5. Implement Filter Engine (Optional)**:

```typescript
// src/filters/my-filter-engine.ts
export class MyFilterEngine extends BaseFilterEngine {
  protected evaluateCustomFilters(document: SourceDocument) {
    const metadata = document.metadata.myservice;

    // Project key filter
    if (this.config.custom?.projectKeys) {
      const matches = this.config.custom.projectKeys.includes(metadata.projectKey);
      if (!matches && this.config.mode === 'include') {
        return { matches: false, reason: 'Project not in include list' };
      }
    }

    // Issue type filter
    if (this.config.custom?.issueTypes) {
      const matches = this.config.custom.issueTypes.includes(metadata.issueType);
      if (!matches && this.config.mode === 'include') {
        return { matches: false, reason: 'Issue type not in include list' };
      }
    }

    return { matches: true, filters: ['projectKey', 'issueType'] };
  }
}
```

**6. Implement Main Connector**:

```typescript
// src/my-connector.ts
export class MyConnector implements IConnector {
  readonly connectorType = 'my_service';
  readonly config: IConnectorConfig;

  private oauthProvider: MyOAuthProvider | null = null;
  private apiClient: MyAPIClient | null = null;
  private fullSyncCoordinator: MyFullSyncCoordinator | null = null;

  constructor(config: IConnectorConfig, tokenModel: Model<IEndUserOAuthToken>, syncModels: SyncCoordinatorModels) {
    this.config = config;
    this.tokenModel = tokenModel;
    this.syncModels = syncModels;
  }

  async initialize(): Promise<void> {
    // Validate config
    const validation = await this.validateConfig();
    if (!validation.valid) throw new Error('Invalid config');

    // Initialize OAuth provider
    this.oauthProvider = new MyOAuthProvider({ clientId: this.config.connectionConfig.clientId });

    // Load OAuth token
    const oauthToken = await this.tokenModel.findOne({ _id: this.config.oauthTokenId });
    if (!oauthToken) throw new Error('OAuth token not found');

    // Initialize token manager
    const tokenManager = new TokenManager(this.oauthProvider, this.config.tenantId, oauthToken.userId, this.tokenModel);

    // Initialize API client
    this.apiClient = new MyAPIClient({ tokenManager });

    // Initialize sync coordinator
    const filterEngine = new MyFilterEngine(this.config.filterConfig);
    this.fullSyncCoordinator = new MyFullSyncCoordinator(this.config, filterEngine, this.apiClient, this.syncModels);
  }

  async validateConfig(): Promise<ValidationResult> { ... }
  async testConnection(): Promise<ConnectionTestResult> { ... }
  async performFullSync(): Promise<SyncResult> { ... }
  async performDeltaSync(): Promise<SyncResult> { ... }
  async crawlPermissions(mode): Promise<PermissionCrawlResult> { ... }
}
```

**7. Export Public API**:

```typescript
// src/index.ts
export { MyConnector } from './my-connector.js';
export { MyOAuthProvider } from './auth/my-oauth-provider.js';
export { MyAPIClient } from './client/my-api-client.js';
export { MyFullSyncCoordinator } from './sync/my-full-sync-coordinator.js';
export { MyFilterEngine } from './filters/my-filter-engine.js';
```

**8. Add to Registry**:

```typescript
// packages/connectors/src/registry.ts
import { MyConnector } from '@agent-platform/connector-myservice';

export const CONNECTOR_REGISTRY: Record<string, ConnectorFactory> = {
  sharepoint: (config, models) =>
    new SharePointConnector(config, models.EndUserOAuthToken, models.sync),
  my_service: (config, models) => new MyConnector(config, models.EndUserOAuthToken, models.sync),
};
```

---

## 11. Field Mapping Reference

### 11.1 SharePoint → SearchDocument

```typescript
{
  _id: uuidv7(),
  tenantId: connectorConfig.tenantId,
  indexId: connectorConfig.sourceId,  // SearchSource maps to SearchIndex
  sourceId: connectorConfig.sourceId,
  connectorId: connectorConfig._id,
  contentHash: sha256(driveItem.content),
  originalReference: driveItem.name,
  contentType: driveItem.file.mimeType,
  contentSizeBytes: driveItem.size,
  sourceUrl: driveItem.webUrl,
  extractedText: null,  // Filled by ingestion pipeline
  language: null,       // Filled by ingestion pipeline
  sourceMetadata: {
    sharepoint: {
      siteId: site.id,
      siteUrl: site.webUrl,
      siteName: site.displayName,
      driveId: drive.id,
      driveName: drive.name,
      itemId: driveItem.id,
      webUrl: driveItem.webUrl,
      createdBy: { displayName: driveItem.createdBy.user.displayName, email: driveItem.createdBy.user.email },
      lastModifiedBy: { displayName: driveItem.lastModifiedBy.user.displayName, email: driveItem.lastModifiedBy.user.email },
      parentReference: { driveId: driveItem.parentReference.driveId, id: driveItem.parentReference.id, path: driveItem.parentReference.path }
    }
  },
  status: 'pending',
  processingError: null,
  chunkCount: 0,
  isDeleted: false,
  deletedAt: null,
  createdAt: new Date(driveItem.createdDateTime),
  updatedAt: new Date(driveItem.lastModifiedDateTime)
}
```

### 11.2 Jira → SearchDocument (Future)

```typescript
{
  sourceMetadata: {
    jira: {
      issueKey: issue.key,              // "PROJ-123"
      projectId: issue.fields.project.id,
      projectKey: issue.fields.project.key,
      projectName: issue.fields.project.name,
      issueType: issue.fields.issuetype.name,  // "Bug", "Story", "Task"
      status: issue.fields.status.name,
      priority: issue.fields.priority.name,
      assignee: { displayName, accountId, email },
      reporter: { displayName, accountId, email },
      labels: issue.fields.labels,
      components: issue.fields.components.map(c => c.name),
      resolution: issue.fields.resolution?.name,
      dueDate: issue.fields.duedate,
      customFields: { ... }             // Custom field values
    }
  }
}
```

### 11.3 Confluence → SearchDocument (Future)

```typescript
{
  sourceMetadata: {
    confluence: {
      pageId: page.id,
      spaceKey: page.space.key,
      spaceName: page.space.name,
      title: page.title,
      type: page.type,                  // "page" | "blogpost"
      status: page.status,              // "current" | "archived"
      version: page.version.number,
      ancestors: page.ancestors.map(a => ({ id: a.id, title: a.title })),
      labels: page.metadata.labels.results.map(l => l.name),
      attachments: page.children.attachment.results.map(a => ({ id: a.id, title: a.title, mediaType: a.extensions.mediaType }))
    }
  }
}
```

---

## 12. Review Checklist

### 12.1 Architecture Review

- [ ] Implements `IConnector` interface completely
- [ ] Extends `BaseSyncCoordinator` with template method pattern
- [ ] Implements `IOAuthProvider` for authentication
- [ ] Uses `HttpClient` with rate limiting and retry
- [ ] Proper tenant isolation (`tenantId` in all queries)
- [ ] No `console.log` - uses `createLogger('module')`
- [ ] All errors logged with context
- [ ] No `any` types without justification
- [ ] Provider-neutral field names in public APIs

### 12.2 Sync Coordinator Review

- [ ] `fetchDocuments()` handles pagination
- [ ] `getDeltaToken()` returns stored token
- [ ] Checkpoint saving every N documents
- [ ] Filter evaluation before document creation
- [ ] sourceMetadata contains all provider-specific fields
- [ ] SourceDocument → SearchDocument mapping complete
- [ ] Content hash computed correctly (SHA-256)
- [ ] Handles deleted items (sets `isDeleted: true`)
- [ ] Progress tracking with `progressCallback`
- [ ] Error handling with partial failure support

### 12.3 Filter Engine Review

- [ ] Extends `BaseFilterEngine`
- [ ] Implements `evaluateCustomFilters()` for provider-specific filters
- [ ] Validates filter config in `validate()` method
- [ ] Returns meaningful exclusion reasons
- [ ] Supports both include and exclude modes
- [ ] Filter statistics tracked correctly

### 12.4 Permission Crawler Review

- [ ] Implements `IPermissionCrawler` interface
- [ ] Supports full, simplified, and disabled modes
- [ ] Normalizes permissions to `NormalizedPermission` structure
- [ ] Handles group memberships correctly
- [ ] Detects public/anonymous access (`everyone: true`)
- [ ] Requires appropriate OAuth scopes documented
- [ ] Integrates with Neo4j `PermissionGraphService`
- [ ] Batch processing for efficiency

### 12.5 OAuth Provider Review

- [ ] Implements `IOAuthProvider` interface
- [ ] Device code flow endpoints correct
- [ ] Token exchange handles polling errors (`authorization_pending`, `slow_down`)
- [ ] Token refresh with exponential backoff
- [ ] Token validation implemented
- [ ] Token revocation implemented
- [ ] Error messages user-friendly

### 12.6 Field Mapping Review

- [ ] All provider-specific metadata in `sourceMetadata.<connector>`
- [ ] No domain-specific field names in `SearchDocument` root
- [ ] Dates converted to ISO 8601 format
- [ ] URLs are absolute (not relative)
- [ ] MIME types normalized
- [ ] File sizes in bytes (not KB/MB)
- [ ] User identities include email + displayName
- [ ] Parent hierarchy preserved in metadata

---

## 13. Common Patterns

### 13.1 Pagination

**Cursor-based (Microsoft Graph)**:

```typescript
let nextLink: string | undefined = '/sites?$top=100';
while (nextLink) {
  const response = await this.graphClient.get(nextLink);
  sites.push(...response.data.value);
  nextLink = response.data['@odata.nextLink']; // null when done
}
```

**Offset-based (Jira)**:

```typescript
let startAt = 0;
const maxResults = 100;
while (true) {
  const response = await this.jiraClient.get(`/search?startAt=${startAt}&maxResults=${maxResults}`);
  issues.push(...response.data.issues);
  if (response.data.issues.length < maxResults) break;
  startAt += maxResults;
}
```

### 13.2 Hierarchical Enumeration

```typescript
// SharePoint: Sites → Drives → Items
for (const site of await this.getSites()) {
  for (const drive of await this.getDrives(site.id)) {
    for (const item of await this.getDriveItems(drive.id)) {
      documents.push(this.mapToSourceDocument(site, drive, item));
    }
  }
}

// Jira: Projects → Issues → Comments
for (const project of await this.getProjects()) {
  for (const issue of await this.getIssues(project.id)) {
    documents.push(this.mapToSourceDocument(project, issue));

    // Optional: index comments as separate documents
    for (const comment of await this.getComments(issue.id)) {
      documents.push(this.mapCommentToSourceDocument(project, issue, comment));
    }
  }
}
```

### 13.3 Delta Sync Pattern

```typescript
async performDeltaSync(): Promise<SyncResult> {
  const deltaToken = await this.getDeltaToken();
  if (!deltaToken) {
    throw new Error('No delta token found. Run full sync first.');
  }

  const changes = await this.apiClient.getDelta(deltaToken);

  for (const change of changes.items) {
    if (change.deleted) {
      // Mark as deleted
      await this.models.SearchDocument.findOneAndUpdate(
        { tenantId: this.config.tenantId, 'sourceMetadata.myservice.itemId': change.id },
        { isDeleted: true, deletedAt: new Date() }
      );
    } else {
      // Create or update
      const sourceDoc = this.mapToSourceDocument(change);
      await this.createOrUpdateSearchDocument(sourceDoc);
    }
  }

  // Save new delta token
  await this.config.updateOne({ 'syncState.deltaToken': changes.deltaLink });

  return { success: true, syncType: 'delta', documentsProcessed: changes.items.length };
}
```

---

## 14. Anti-Patterns

### 14.1 ❌ Direct Database Queries Without Tenant Isolation

```typescript
// WRONG
const doc = await SearchDocument.findById(documentId);

// CORRECT
const doc = await SearchDocument.findOne({ _id: documentId, tenantId: currentTenantId });
```

### 14.2 ❌ Using console.log for Logging

```typescript
// WRONG
console.log('Starting sync...');

// CORRECT
const logger = createLogger('my-connector');
logger.info('Starting sync', { connectorId: this.config._id, syncType: 'full' });
```

### 14.3 ❌ Swallowing Errors

```typescript
// WRONG
try {
  await this.processDocument(doc);
} catch {}

// CORRECT
try {
  await this.processDocument(doc);
} catch (error) {
  logger.error('Failed to process document', {
    documentId: doc.id,
    error: error instanceof Error ? error.message : String(error),
  });
  throw error; // Or handle appropriately
}
```

### 14.4 ❌ Hardcoded Rate Limits

```typescript
// WRONG
await sleep(1000); // Always wait 1 second

// CORRECT
const rateLimiter = new RateLimiter(maxRequests, requestsPerSecond);
await rateLimiter.acquire();
```

### 14.5 ❌ Missing sourceMetadata Namespace

```typescript
// WRONG
sourceMetadata: {
  projectKey: 'PROJ',
  issueType: 'Bug'
}

// CORRECT
sourceMetadata: {
  jira: {
    projectKey: 'PROJ',
    issueType: 'Bug'
  }
}
```

### 14.6 ❌ Not Handling Pagination

```typescript
// WRONG
const items = await this.apiClient.getItems(); // Only returns first page

// CORRECT
const items = [];
let nextLink = '/items?$top=100';
while (nextLink) {
  const response = await this.apiClient.get(nextLink);
  items.push(...response.data.value);
  nextLink = response.data['@odata.nextLink'];
}
```

---

## 15. Testing Guidelines

### 15.1 Unit Tests

**What to test**:

- Filter evaluation logic
- Permission normalization
- Field mapping (SourceDocument → SearchDocument)
- OAuth token refresh logic
- Rate limiter behavior
- Retry handler with mock failures

**Example**:

```typescript
describe('SharePointFilterEngine', () => {
  it('should exclude documents not in site URL include list', () => {
    const filter = new SharePointFilterEngine({
      mode: 'include',
      siteUrls: ['https://contoso.sharepoint.com/sites/engineering'],
    });

    const doc: SourceDocument = {
      metadata: { sharepoint: { siteUrl: 'https://contoso.sharepoint.com/sites/marketing' } },
    };

    const result = filter.evaluate(doc);
    expect(result.include).toBe(false);
    expect(result.reason).toContain('Site URL not in include list');
  });
});
```

### 15.2 Integration Tests

**What to test**:

- OAuth device code flow (with test tenant)
- Full sync end-to-end (with small test dataset)
- Delta sync correctness
- Permission crawling accuracy

**Mocking**:

- Use `nock` or `msw` to mock HTTP responses
- Mock MongoDB with `mongodb-memory-server`
- Mock Neo4j with `neo4j-driver` test harness

### 15.3 E2E Tests

**What to test**:

- Complete sync workflow (auth → discover → sync → search)
- Permission filtering at query time
- Webhook delivery and processing
- Pause/resume functionality

---

## 16. Troubleshooting

### 16.1 Sync Stuck at 0%

**Diagnosis**:

- Check OAuth token validity: `GET /api/connectors/:id/auth/status`
- Check filters aren't excluding everything
- Check connector state: `errorState.isPaused`

**Fix**:

- Re-authenticate: `POST /api/connectors/:id/auth/initiate`
- Review filter config
- Unpause: `PATCH /api/connectors/:id { errorState: { isPaused: false } }`

### 16.2 High Failure Rate

**Diagnosis**:

- Check rate limit errors (429 responses)
- Check network connectivity
- Check document permissions (403 responses)

**Fix**:

- Increase rate limit backoff
- Verify OAuth scopes
- Enable retry logging

### 16.3 Slow Sync Performance

**Diagnosis**:

- Too many sites/libraries
- Large document sizes
- Network latency

**Fix**:

- Add aggressive filters (site URLs, libraries)
- Increase batch size
- Consider delta sync after initial full sync

### 16.4 Permission Filtering Not Working

**Diagnosis**:

- Permission crawl mode is `disabled`
- Neo4j connection issues
- User identity mismatch

**Fix**:

- Enable permission crawling: `PATCH /api/connectors/:id { permissionConfig: { mode: 'simplified' } }`
- Verify Neo4j connection
- Check user email mapping

---

## 17. Performance Optimization

### 17.1 Batch Operations

```typescript
// WRONG: Process documents one-by-one
for (const doc of documents) {
  await this.createSearchDocument(doc);
}

// CORRECT: Batch insert
await this.models.SearchDocument.insertMany(
  documents.map((doc) => this.mapToSearchDocument(doc)),
  { ordered: false }, // Continue on errors
);
```

### 17.2 Parallel Enumeration

```typescript
// WRONG: Sequential enumeration
for (const site of sites) {
  const drives = await this.getDrives(site.id);
  for (const drive of drives) {
    const items = await this.getDriveItems(drive.id);
    documents.push(...items);
  }
}

// CORRECT: Parallel enumeration (with concurrency limit)
const pLimit = (await import('p-limit')).default;
const limit = pLimit(10); // Max 10 concurrent requests

await Promise.all(
  sites.map((site) =>
    limit(async () => {
      const drives = await this.getDrives(site.id);
      await Promise.all(
        drives.map((drive) =>
          limit(async () => {
            const items = await this.getDriveItems(drive.id);
            documents.push(...items);
          }),
        ),
      );
    }),
  ),
);
```

### 17.3 Checkpoint Frequency

```typescript
// Save checkpoint every 100 documents (balance between crash recovery and performance)
if (processedCount % 100 === 0) {
  await this.saveCheckpoint(checkpoint);
}
```

---

## 18. Security Considerations

### 18.1 OAuth Token Storage

- Tokens encrypted at rest (MongoDB field-level encryption)
- Never log tokens
- Rotate tokens on suspicious activity
- Revoke tokens on user logout

### 18.2 Permission Verification

- Never trust client-provided permissions
- Always verify at query time against Neo4j graph
- Permissions return 404 (not 403) to avoid leaking existence

### 18.3 Content Access

- All API calls use user's OAuth token (delegated permissions)
- No service account with tenant-wide access
- Respect source system's permission model

---

## 19. Key Takeaways

1. **Always extend base classes** - Don't reimplement OAuth, rate limiting, sync logic
2. **Tenant isolation is critical** - Every query must include `tenantId`
3. **sourceMetadata namespacing** - Use `sourceMetadata.<connector>` for provider-specific fields
4. **Permission verification at query time** - Sync permissions to Neo4j, verify during search
5. **Checkpoint frequently** - Every 100 documents for pause/resume
6. **Use template method pattern** - Override `fetchDocuments()` and `getDeltaToken()` only
7. **Validate filter config** - Return clear errors on invalid filters
8. **Log everything** - Use structured logging with context
9. **Test end-to-end** - Unit tests alone aren't enough for connectors

---

**Next Steps**: See the [SharePoint Connector — A Complete Story](/docs/searchai/design/SHAREPOINT-CONNECTOR-COMPLETE-REFERENCE.md) for SharePoint-specific details, and the [Class & Sequence Diagrams](/docs/searchai/design/SHAREPOINT-CONNECTOR-DIAGRAMS.md) for visual architecture reference.

# Enterprise Connectors

Reusable connector infrastructure for enterprise data sources (SharePoint, Jira, Confluence, etc.).

## Architecture

### Package Structure

```
packages/connectors/
├── base/                    # Shared infrastructure
│   ├── interfaces/          # Core interfaces (IConnector, ISyncCoordinator, etc.)
│   ├── auth/                # OAuth Device Code Flow, TokenManager
│   ├── client/              # RateLimiter, RetryHandler, HttpClient
│   ├── sync/                # BaseSyncCoordinator
│   └── filters/             # BaseFilterEngine
│
└── sharepoint/              # SharePoint connector
    ├── auth/                # MicrosoftOAuthProvider
    ├── client/              # GraphClient (Microsoft Graph API)
    ├── sync/                # SharePointFullSyncCoordinator
    ├── filters/             # SharePointFilterEngine
    └── permissions/         # Permission crawlers (Phase 2)
```

### Design Principles

1. **Reusability**: Base package provides 90% of functionality. New connectors only implement provider-specific logic.
2. **Consistency**: All connectors implement `IConnector` interface with identical API.
3. **Extensibility**: Abstract base classes use template method pattern for easy customization.
4. **Independence**: Each connector is a separate npm package with independent versioning.

## Base Infrastructure

### Interfaces

- **IConnector**: Main connector interface (initialize, validateConfig, testConnection, sync, permissions)
- **ISyncCoordinator**: Sync orchestration interface (performSync, fetchDocuments, saveCheckpoint)
- **IFilterEngine**: Filter evaluation interface (evaluate, validate, getStatistics)
- **IPermissionCrawler**: Permission crawling interface (crawlDocument, crawlBatch, getRequiredScopes)
- **IOAuthProvider**: OAuth provider abstraction (requestDeviceCode, exchangeDeviceCode, refreshToken)

### Authentication

- **DeviceCodeFlowAuthenticator**: RFC 8628 OAuth Device Code Flow
  - Works with any OAuth provider (Microsoft, Atlassian, Google, etc.)
  - Displays user code + verification URL
  - Polls for token completion
  - Handles errors (access_denied, expired_token, slow_down)

- **TokenManager**: Token lifecycle management
  - Stores tokens in `EndUserOAuthToken` model (encrypted at rest)
  - Automatic refresh before expiry (5-minute buffer)
  - Token validation and revocation

### HTTP Client

- **RateLimiter**: Token bucket algorithm
  - Configurable limits and refill rate
  - Async token acquisition
  - Thread-safe

- **RetryHandler**: Exponential backoff with jitter
  - Respects `Retry-After` header (429 responses)
  - Configurable max attempts and backoff multiplier
  - Retryable status codes: 408, 429, 500, 502, 503, 504

- **HttpClient**: Combines rate limiting + retry logic
  - Standard HTTP methods (GET, POST, PUT, PATCH, DELETE)
  - Request timeouts
  - Automatic JSON parsing

### Sync

- **BaseSyncCoordinator**: Template method pattern for sync operations
  - Implements common sync logic (checkpoint management, progress tracking)
  - Concrete connectors override `fetchDocuments()` and `getDeltaToken()`
  - Creates `SearchDocument` records
  - Triggers ingestion pipeline

### Filters

- **BaseFilterEngine**: Common filter evaluation
  - Date filters (modifiedSince, modifiedBefore, createdSince, createdBefore)
  - Size filters (minSizeBytes, maxSizeBytes)
  - Content type filters
  - Include/exclude modes
  - Statistics tracking (total evaluations, included/excluded counts, exclusion reasons)

## SharePoint Connector

### Components

- **MicrosoftOAuthProvider**: Azure AD OAuth implementation
  - Device code flow endpoints
  - Token exchange and refresh
  - Token validation

- **GraphClient**: Microsoft Graph API wrapper
  - Site operations (getSites, getSiteByUrl, searchSites)
  - Drive operations (getDrives, getDrive)
  - Item operations (getDriveItems, getDriveItemsRecursive, getDriveItemContent)
  - Delta sync (getDeltaItems)
  - Permissions (getItemPermissions, getDrivePermissions, getGroupMembers)
  - Webhooks (subscribeToDriveChanges, renewSubscription)
  - Rate limiting: 10K requests per 10 minutes (~16.67 req/sec)

- **SharePointFullSyncCoordinator**: Full sync implementation
  - Enumerates sites → drives → items
  - Applies filters (site URLs, library names, content types)
  - Maps to `SourceDocument` format
  - Supports checkpoint/resume

- **SharePointDeltaSyncCoordinator**: Incremental sync (Phase 2)
  - Uses Microsoft Graph delta queries
  - Only fetches changes since last sync
  - Stores delta token for next sync

- **SharePointFilterEngine**: SharePoint-specific filters
  - Site URL filtering (include/exclude specific sites)
  - Library name filtering
  - SharePoint content type filtering (Document, Page, Image, Video, Audio)
  - Extends BaseFilterEngine with custom validation

## Usage

### Creating a Connector

```typescript
import { SharePointConnector } from '@agent-platform/connector-sharepoint';
import { ConnectorConfig } from '@agent-platform/database';

// 1. Create ConnectorConfig in database
const config = await ConnectorConfig.create({
  tenantId: 'tenant-123',
  sourceId: 'source-456',
  connectorType: 'sharepoint',
  connectionConfig: {
    tenantUrl: 'https://contoso.sharepoint.com',
    clientId: 'azure-app-client-id',
    scopes: ['Sites.Read.All', 'Files.Read.All'],
  },
  filterConfig: {
    mode: 'include',
    siteUrls: ['https://contoso.sharepoint.com/sites/engineering'],
    libraryNames: ['Documents'],
    contentTypes: ['Document', 'Page'],
  },
});

// 2. Initialize connector
const connector = new SharePointConnector(config);
await connector.initialize();

// 3. Test connection
const testResult = await connector.testConnection();
console.log(testResult);

// 4. Perform full sync
const syncResult = await connector.performFullSync();
console.log(syncResult);
```

### CLI Commands

```bash
# Create connector
kore-platform-cli connector create sharepoint "Engineering SharePoint" --index-id idx_123

# Authenticate (OAuth Device Flow)
kore-platform-cli connector auth conn_abc123

# Configure filters
kore-platform-cli connector filter set conn_abc123 \
  --sites "https://contoso.sharepoint.com/sites/engineering" \
  --libraries "Documents,Shared Documents" \
  --content-types "Document,Page" \
  --mode include

# Set permission mode
kore-platform-cli connector permission mode conn_abc123 --mode simplified

# Start sync
kore-platform-cli connector sync:start conn_abc123

# Check sync status
kore-platform-cli connector sync:status conn_abc123

# Pause/resume sync
kore-platform-cli connector sync:pause conn_abc123
kore-platform-cli connector sync:resume conn_abc123

# Delete connector
kore-platform-cli connector delete conn_abc123 --force
```

### API Endpoints

```http
# Connector Management
POST   /api/indexes/:indexId/connectors              # Create connector
GET    /api/indexes/:indexId/connectors              # List connectors
GET    /api/indexes/:indexId/connectors/:id          # Get details
PUT    /api/indexes/:indexId/connectors/:id          # Update config
DELETE /api/indexes/:indexId/connectors/:id          # Delete

# Authentication
POST   /api/connectors/:id/auth/initiate             # Start device code flow
GET    /api/connectors/:id/auth/status               # Poll for token

# Sync
POST   /api/connectors/:id/sync/start                # Start sync
GET    /api/connectors/:id/sync/status               # Get status
```

## Building New Connectors

### Step 1: OAuth Provider

Implement `IOAuthProvider` interface:

```typescript
export class AtlassianOAuthProvider implements IOAuthProvider {
  readonly providerName = 'atlassian_jira';
  readonly clientId: string;

  async requestDeviceCode(scopes: string[]): Promise<DeviceCodeResponse> {
    // Atlassian-specific device code request
  }

  async exchangeDeviceCode(deviceCode: string): Promise<OAuthTokens> {
    // Atlassian-specific token exchange
  }

  async refreshToken(refreshToken: string): Promise<TokenRefreshResult> {
    // Atlassian-specific token refresh
  }

  // ... other methods
}
```

### Step 2: API Client

Extend `HttpClient`:

```typescript
export class JiraClient extends HttpClient {
  constructor(config: { accessToken: string }) {
    super({
      baseUrl: 'https://api.atlassian.com',
      defaultHeaders: {
        Authorization: `Bearer ${config.accessToken}`,
      },
      rateLimiter: new RateLimiter(300, 5), // 300 req per minute
    });
  }

  async getProjects(): Promise<Project[]> {
    const response = await this.get('/ex/jira/latest/project');
    return response.data;
  }

  // ... other methods
}
```

### Step 3: Sync Coordinator

Extend `BaseSyncCoordinator`:

```typescript
export class JiraFullSyncCoordinator extends BaseSyncCoordinator {
  private jiraClient: JiraClient;

  async fetchDocuments(checkpoint: ISyncCheckpoint | null): Promise<SourceDocument[]> {
    const documents: SourceDocument[] = [];
    const projects = await this.jiraClient.getProjects();

    for (const project of projects) {
      const issues = await this.jiraClient.getIssues(project.id);
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
      name: issue.summary,
      url: issue.self,
      contentType: 'application/json',
      sizeBytes: JSON.stringify(issue).length,
      modifiedAt: new Date(issue.updated),
      createdAt: new Date(issue.created),
      content: null,
      metadata: { jira: { projectKey: project.key, issueKey: issue.key } },
    };
  }
}
```

### Step 4: Filter Engine (Optional)

Extend `BaseFilterEngine` if you need connector-specific filters:

```typescript
export class JiraFilterEngine extends BaseFilterEngine {
  protected evaluateCustomFilters(document: SourceDocument): {
    matches: boolean;
    filters: string[];
    reason?: string;
  } {
    const jiraMetadata = document.metadata?.jira;
    if (!jiraMetadata) {
      return { matches: false, filters: [], reason: 'Missing Jira metadata' };
    }

    // Project key filter
    if (this.config.custom?.projectKeys) {
      const projectKeys = this.config.custom.projectKeys as string[];
      if (!projectKeys.includes(jiraMetadata.projectKey)) {
        return { matches: false, filters: [], reason: 'Project not in filter list' };
      }
    }

    return { matches: true, filters: ['projectKey'] };
  }
}
```

### Step 5: Main Connector

Implement `IConnector` interface:

```typescript
export class JiraConnector implements IConnector {
  readonly connectorType = 'jira';
  readonly config: IConnectorConfig;

  async initialize(): Promise<void> {
    // Initialize OAuth provider, token manager, API client, sync coordinators
  }

  async validateConfig(): Promise<ValidationResult> {
    // Validate configuration
  }

  async testConnection(): Promise<ConnectionTestResult> {
    // Test API connection
  }

  async performFullSync(): Promise<SyncResult> {
    return await this.fullSyncCoordinator.performSync('full');
  }

  // ... other methods
}
```

## Phase 2 Features (Not Yet Implemented)

- **Delta Sync**: Incremental sync using provider-specific delta queries
- **Permission Crawling**: Full and simplified modes
- **Webhooks**: Real-time updates via webhooks
- **Pause/Resume**: Checkpoint-based sync interruption
- **Attachment Deduplication**: Content-based deduplication across sources
- **Data Reconciliation**: Handle deletions and updates

## Testing

```bash
# Run unit tests
cd packages/connectors/base
pnpm test

cd packages/connectors/sharepoint
pnpm test

# Run integration tests (requires SharePoint tenant)
cd packages/connectors/sharepoint
pnpm test:integration

# Run E2E tests
cd apps/search-ai
pnpm test:e2e
```

## Contributing

When adding a new connector:

1. Create package: `packages/connectors/<name>/`
2. Implement `IOAuthProvider` for the data source
3. Create API client extending `HttpClient`
4. Implement sync coordinator extending `BaseSyncCoordinator`
5. (Optional) Create filter engine extending `BaseFilterEngine`
6. Implement main connector class implementing `IConnector`
7. Add CLI commands to `kore-platform-cli`
8. Add API routes to `apps/search-ai`
9. Write tests (unit, integration, E2E)
10. Update this README

## License

Proprietary - Kore.ai Inc.

# @agent-platform/connector-sharepoint

SharePoint Online connector for the SearchAI platform. Syncs documents, pages, and metadata from SharePoint sites via Microsoft Graph API.

## Installation

```bash
pnpm add @agent-platform/connector-sharepoint
```

## Features

- **Microsoft Graph API Integration** - Uses Graph API for all SharePoint operations
- **OAuth 2.0 Device Code Flow** - Secure, CLI-friendly authentication
- **Full Sync** - Complete site → library → document enumeration
- **Flexible Filtering** - Filter by sites, libraries, content types
- **Rate Limiting** - Automatic throttling (10K requests per 10 minutes)
- **Error Recovery** - Exponential backoff and automatic retry
- **Progress Tracking** - Real-time sync status and ETA

## Quick Start

```typescript
import { SharePointConnector } from '@agent-platform/connector-sharepoint';
import { ConnectorConfig } from '@agent-platform/database';

// 1. Create connector configuration
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
    sharePointContentTypes: ['Document', 'Page'],
  },
});

// 2. Initialize connector
const connector = new SharePointConnector(config);
await connector.initialize();

// 3. Authenticate (OAuth Device Flow)
// This typically happens via CLI:
// kore-platform-cli connector auth conn_xyz789

// 4. Start sync
const result = await connector.performFullSync();
console.log(`Synced ${result.documentsCreated} documents`);
```

## Azure AD Setup

### Required Permissions

**For Content Sync:**

- `Sites.Read.All` (Delegated) - Read sites and libraries
- `Files.Read.All` (Delegated) - Read files and metadata

**For Permissions (Phase 2):**

- `Sites.FullControl.All` (Delegated) - Read item permissions
- `Directory.Read.All` (Delegated) - Resolve group memberships

### App Registration

1. Go to [Azure Portal](https://portal.azure.com) → Azure AD → App registrations
2. Click "New registration"
3. Name: "SearchAI SharePoint Connector"
4. Supported account types: "Multitenant"
5. Redirect URI: `https://login.microsoftonline.com/common/oauth2/nativeclient`
6. After creation, note the **Application (client) ID**
7. Go to "API permissions" → Add permissions → Microsoft Graph
8. Add delegated permissions listed above
9. Click "Grant admin consent"

## Components

### MicrosoftOAuthProvider

Implements OAuth 2.0 for Microsoft Azure AD.

```typescript
import { MicrosoftOAuthProvider } from '@agent-platform/connector-sharepoint';

const provider = new MicrosoftOAuthProvider({
  clientId: 'your-azure-app-client-id',
  tenantId: 'organizations', // or specific tenant ID
});

// Used internally by DeviceCodeFlowAuthenticator
```

### GraphClient

Microsoft Graph API wrapper with rate limiting and retry logic.

```typescript
import { GraphClient } from '@agent-platform/connector-sharepoint';

const client = new GraphClient({ accessToken: 'your-access-token' });

// Get sites
const sites = await client.getSites();

// Get drives (libraries) in a site
const drives = await client.getDrives(siteId);

// Get items in a drive
const items = await client.getDriveItems(driveId);

// Get item content
const content = await client.getDriveItemContent(driveId, itemId);
```

**Rate Limiting:**

- Automatically limits to 10,000 requests per 10 minutes
- Uses token bucket algorithm (~16.67 req/sec)
- Respects `Retry-After` headers on 429 responses

### SharePointFullSyncCoordinator

Orchestrates full document synchronization.

```typescript
import { SharePointFullSyncCoordinator } from '@agent-platform/connector-sharepoint';

const coordinator = new SharePointFullSyncCoordinator(config, filterEngine, graphClient);

// Performs: enumerate sites → drives → items → create SearchDocuments
const result = await coordinator.performSync('full');
```

**Process:**

1. Get all accessible SharePoint sites
2. For each site: get drives (libraries)
3. For each drive: paginate items
4. Apply filters (site URL, library name, content type)
5. Create `SearchDocument` records
6. Trigger ingestion pipeline

### SharePointFilterEngine

Filters documents during sync.

```typescript
import { SharePointFilterEngine } from '@agent-platform/connector-sharepoint';

const filterEngine = new SharePointFilterEngine({
  mode: 'include',
  siteUrls: ['https://contoso.sharepoint.com/sites/engineering'],
  libraryNames: ['Documents', 'Shared Documents'],
  sharePointContentTypes: ['Document', 'Page'],
  modifiedSince: new Date('2024-01-01'),
});

const result = filterEngine.evaluate(document);
// result.include: true/false
// result.reason: "Site URL not in whitelist" (if excluded)
// result.appliedFilters: ["siteUrl", "libraryName"]
```

**Filter Types:**

- **Site URL**: Include/exclude specific sites
- **Library Name**: Filter by document library names
- **Content Type**: Document, Page, Picture, Video, etc.
- **Modified Date**: Only sync recently modified (Phase 2)

## CLI Usage

```bash
# Create connector
kore-platform-cli connector create sharepoint "Company SharePoint" \
  --index-id index_abc123

# Authenticate
kore-platform-cli connector auth conn_xyz789
# Visit: https://microsoft.com/devicelogin
# Enter code: ABCD-1234

# Set filters
kore-platform-cli connector filter set conn_xyz789 \
  --sites "https://contoso.sharepoint.com/sites/engineering" \
  --libraries "Documents" \
  --content-types "Document,Page"

# Start sync
kore-platform-cli connector sync start conn_xyz789

# Check status
kore-platform-cli connector sync status conn_xyz789
# Output:
# Status: syncing
# Progress: 1,234 / 5,000 (24.7%)
# Rate: 15 docs/sec
# ETA: 4m 10s
```

## API Endpoints

```http
# Create connector
POST /api/indexes/:indexId/connectors
{
  "name": "Company SharePoint",
  "connectorType": "sharepoint",
  "connectionConfig": {
    "tenantUrl": "https://contoso.sharepoint.com",
    "clientId": "azure-app-client-id",
    "scopes": ["Sites.Read.All", "Files.Read.All"]
  }
}

# Initiate authentication
POST /api/connectors/:connectorId/auth/initiate

# Check auth status
GET /api/connectors/:connectorId/auth/status

# Start sync
POST /api/connectors/:connectorId/sync/start
{
  "syncType": "full"
}

# Get sync status
GET /api/connectors/:connectorId/sync/status
```

## Configuration

### Connection Config

```typescript
{
  tenantUrl: string;      // https://contoso.sharepoint.com
  clientId: string;       // Azure AD app client ID
  scopes: string[];       // OAuth scopes
}
```

### Filter Config

```typescript
{
  mode: 'include' | 'exclude';
  siteUrls?: string[];                // Site URL patterns
  libraryNames?: string[];            // Library name patterns
  sharePointContentTypes?: string[];  // Content types
  modifiedSince?: Date;               // Only recent docs (Phase 2)
}
```

### Sync State

Tracked automatically during sync:

```typescript
{
  lastFullSyncAt: Date | null;
  lastDeltaSyncAt: Date | null;
  deltaToken: string | null;
  totalDocuments: number;
  processedDocuments: number;
  failedDocuments: number;
}
```

## Performance

**Typical Sync Rates:**

- ~10-20 docs/sec (varies by document size, network, filters)
- 1,000 docs: ~1-2 minutes
- 10,000 docs: ~10-20 minutes
- 100,000 docs: ~2-3 hours

**Optimization Tips:**

1. Use aggressive filters (site, library, content type)
2. Start with small test sync (1 site)
3. Schedule full syncs during off-peak hours
4. Use simplified permission mode (5x faster - Phase 2)

## Error Handling

**Common Errors:**

1. **Authentication Failed**: Re-run `kore-platform-cli connector auth`
2. **Rate Limit (429)**: Automatic retry with exponential backoff
3. **Token Expired**: Automatic refresh (tokens valid 90 days)
4. **Site Not Found**: Verify site URL and user access
5. **Insufficient Permissions**: Grant admin consent in Azure AD

**Error States:**

```typescript
{
  consecutiveFailures: number; // Increments on each failure
  lastErrorAt: Date | null;
  lastErrorMessage: string | null;
  isPaused: boolean; // User-initiated pause
  pausedAt: Date | null;
  pauseReason: string | null;
}
```

## Testing

```bash
# Run unit tests
pnpm test

# Run integration tests (requires mocks)
pnpm test:integration

# Run E2E tests (requires real SharePoint tenant)
pnpm test:e2e
```

**Test Coverage:**

- Unit tests: 73/73 passing ✅
- Integration tests: 25 tests (runtime mocking issues - needs fix)
- E2E tests: 20/20 passing ✅

## Phase 2 Features Status

### ✅ Implemented (80% Complete)

- **Delta Sync**: ✅ Fully implemented with per-drive delta tokens
  - Uses Microsoft Graph delta query API
  - Per-drive token management (DriveDeltaToken model)
  - Automatic fallback to full sync on token expiry
  - See: [DELTA-SYNC-EXPLAINED.md](./docs/DELTA-SYNC-EXPLAINED.md)

- **Webhooks**: ✅ Fully implemented with real-time notifications
  - Webhook subscription management (create, renew, delete)
  - Background renewal job (24-hour expiry)
  - Encrypted clientState validation
  - Batch notification processing
  - 30-second debouncing to prevent sync churn
  - Webhook receiver with deduplication

- **Permission Crawling**: ✅ Fully implemented
  - Full mode: 100% accurate, requires Sites.FullControl.All
  - Simplified mode: 95% accurate, uses Sites.Read.All
  - Disabled mode: Skip permission crawling
  - Integrates with Neo4j PermissionGraphService
  - Per-document permission tracking

### 🚧 Partially Implemented

- **Pause/Resume**: ⚠️ Infrastructure exists but not wired to workers
  - ConnectorConfig.errorState.isPaused flag exists
  - Workers check paused state
  - Need: UI controls, manual pause/resume API endpoints
  - See: Task #32

### 📋 Not Yet Implemented

- **Advanced Filters**:
  - Exclude mode (only include mode exists)
  - Date range filters (modifiedSince/modifiedBefore)
  - Regex patterns for file names
  - Content-based filters

## Troubleshooting

### Debug Mode

Enable verbose logging:

```typescript
const client = new GraphClient({
  accessToken: token,
  debug: true, // Logs all HTTP requests/responses
});
```

### Check Sync Logs

```bash
# CLI logs
cat ~/.kore-platform-cli/logs/connectors.log | tail -100

# API logs (stdout)
docker logs search-ai-api | grep connectorId=conn_xyz789
```

### Common Issues

**Sync stuck at 0%:**

- Check authentication status
- Verify filters don't exclude everything
- Check SharePoint site access

**High failure rate:**

- Check document permissions
- Verify network connectivity
- Look for large files (>100MB)

**Slow sync:**

- Too many sites/libraries
- Large document sizes
- Network latency
- Consider adding filters

## Documentation

- **User Guide**: `./docs/USER-GUIDE.md`
- **Architecture**: `./docs/ARCHITECTURE.md`
- **Task Tracker**: `./docs/TASK-TRACKER.md`
- **Base Package**: `/packages/connectors/base/README.md`

## Support

For issues or questions:

1. Check troubleshooting section above
2. Review user guide documentation
3. Create issue in project tracker

## License

Proprietary - Internal use only

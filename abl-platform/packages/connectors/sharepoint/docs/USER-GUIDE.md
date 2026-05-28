# SharePoint Connector User Guide

## Table of Contents

- [Overview](#overview)
- [Prerequisites](#prerequisites)
- [Quick Start](#quick-start)
- [Azure AD Setup](#azure-ad-setup)
- [Authentication](#authentication)
- [CLI Reference](#cli-reference)
- [API Reference](#api-reference)
- [Filter Configuration](#filter-configuration)
- [Permission Modes](#permission-modes)
- [Sync Operations](#sync-operations)
- [Monitoring & Troubleshooting](#monitoring--troubleshooting)
- [Best Practices](#best-practices)

---

## Overview

The SharePoint connector enables enterprise search across SharePoint Online content. It uses Microsoft Graph API to sync documents, pages, and metadata from SharePoint sites into your search index.

### Key Features

- **OAuth 2.0 Device Code Flow** - Secure, user-friendly authentication
- **Full Sync** - Complete document enumeration with pagination
- **Flexible Filtering** - Site, library, and content-type filters
- **Rate Limiting** - Automatic throttling (10K requests per 10 minutes)
- **Error Recovery** - Automatic retry with exponential backoff
- **Real-time Status** - Progress tracking during sync operations

### Architecture

```
SharePoint Online
    ↓
Microsoft Graph API
    ↓
SharePoint Connector (OAuth + Sync)
    ↓
SearchDocument Collection (MongoDB)
    ↓
Ingestion Pipeline (Extract → Enrich → Embed)
    ↓
Search Index (OpenSearch)
```

---

## Prerequisites

### 1. Azure AD Application

You need an Azure AD app registration with the following:

- **Application (client) ID**
- **Tenant ID** (or use "organizations" for multi-tenant)
- **Supported account types**: Accounts in any organizational directory (multi-tenant)
- **Platform**: Mobile and desktop applications
- **Redirect URI**: `https://login.microsoftonline.com/common/oauth2/nativeclient`

### 2. Required Permissions

**For Content Sync Only:**

- `Sites.Read.All` - Read sites and document libraries
- `Files.Read.All` - Read files and their metadata

**For Permission Crawling (Phase 2):**

- `Sites.FullControl.All` - Read permissions for items
- `Directory.Read.All` - Resolve group memberships (full mode only)

### 3. Admin Consent

Some permissions require admin consent:

1. Go to Azure Portal → Azure AD → App registrations → Your app
2. Navigate to "API permissions"
3. Click "Grant admin consent for [your organization]"

### 4. Environment Access

- **Search AI API**: Running and accessible
- **MongoDB**: Accessible from the API
- **Redis**: For rate limiting (optional but recommended)
- **CLI Tool**: Installed (`npm install -g @agent-platform/cli`)

---

## Quick Start

### 5-Minute Setup

```bash
# 1. Install CLI (if not already installed)
npm install -g @agent-platform/cli

# 2. Authenticate with platform
kore-platform-cli login

# 3. Create a search index (if you don't have one)
kore-platform-cli index create "My Enterprise Search"

# 4. Create SharePoint connector
kore-platform-cli connector create sharepoint "Company SharePoint" \
  --index-id index_abc123

# 5. Authenticate with SharePoint
kore-platform-cli connector auth conn_xyz789

# Follow the prompts:
# - Visit: https://microsoft.com/devicelogin
# - Enter code: ABCD-1234
# - Sign in with your Microsoft account
# - Grant permissions

# 6. Configure filters (optional)
kore-platform-cli connector filter set conn_xyz789 \
  --sites "https://contoso.sharepoint.com/sites/engineering" \
  --content-types "Document,Page"

# 7. Start sync
kore-platform-cli connector sync start conn_xyz789

# 8. Monitor progress
kore-platform-cli connector sync status conn_xyz789
```

**Result**: Documents from your SharePoint site are now indexed and searchable!

---

## Azure AD Setup

### Step-by-Step Guide

#### 1. Register Application

1. Navigate to [Azure Portal](https://portal.azure.com)
2. Go to **Azure Active Directory** → **App registrations**
3. Click **New registration**
4. Fill in:
   - **Name**: "SearchAI SharePoint Connector"
   - **Supported account types**: "Accounts in any organizational directory (Any Azure AD directory - Multitenant)"
   - **Redirect URI**: Select "Public client/native (mobile & desktop)" and enter: `https://login.microsoftonline.com/common/oauth2/nativeclient`
5. Click **Register**

#### 2. Copy Application Details

After registration, note:

- **Application (client) ID**: e.g., `12345678-1234-1234-1234-123456789abc`
- **Directory (tenant) ID**: e.g., `87654321-4321-4321-4321-cba987654321` (or use "organizations")

#### 3. Configure API Permissions

1. Navigate to **API permissions**
2. Click **Add a permission**
3. Select **Microsoft Graph**
4. Choose **Delegated permissions**
5. Add these permissions:
   - `Sites.Read.All`
   - `Files.Read.All`
6. Click **Add permissions**
7. Click **Grant admin consent for [organization]** (requires admin)

#### 4. Enable Public Client Flow

1. Navigate to **Authentication**
2. Under "Advanced settings" → "Allow public client flows"
3. Set to **Yes**
4. Click **Save**

### Multi-Tenant vs. Single-Tenant

**Multi-tenant (recommended for SaaS):**

- Tenant ID: `organizations` or `common`
- Users from any Azure AD can authenticate
- Each user authenticates with their own tenant

**Single-tenant:**

- Use your specific tenant ID
- Only users from your organization can authenticate

---

## Authentication

### OAuth 2.0 Device Code Flow

The connector uses the Device Code Flow (RFC 8628) for secure, CLI-friendly authentication.

#### Flow Diagram

```
User → CLI → Connector API → Microsoft Identity
  ↓         ↓
  ↓    Device Code
  ↓         ↓
Browser ← User Code
  ↓
Microsoft Login
  ↓
Authorize
  ↓
Connector ← Access Token + Refresh Token
  ↓
MongoDB (encrypted)
```

#### CLI Authentication

```bash
# Initiate authentication
kore-platform-cli connector auth conn_xyz789

# Output:
# ┌────────────────────────────────────────────┐
# │  Open this URL in your browser:            │
# │  https://microsoft.com/devicelogin         │
# │                                            │
# │  Enter code: ABCD-1234                     │
# └────────────────────────────────────────────┘
# ⏳ Waiting for authorization...
```

**Steps:**

1. Open the URL in any browser
2. Enter the displayed code
3. Sign in with your Microsoft account
4. Review and accept permissions
5. CLI confirms: ✅ Successfully authenticated!

#### Token Storage

- **Location**: MongoDB `EndUserOAuthToken` collection
- **Encryption**: Tokens encrypted at rest using tenant-scoped DEKs
- **Refresh**: Automatic refresh before expiry (5-minute buffer)
- **Expiry**: Access tokens last 1 hour, refresh tokens last 90 days

#### Check Authentication Status

```bash
# Via CLI
kore-platform-cli connector list --index-id index_abc123

# Via API
curl -X GET "http://localhost:3000/api/connectors/conn_xyz789/auth/status" \
  -H "Authorization: Bearer YOUR_JWT_TOKEN"

# Response:
{
  "authenticated": true,
  "expiresAt": "2026-02-24T10:30:00Z",
  "scopes": ["Sites.Read.All", "Files.Read.All"]
}
```

#### Revoke Authentication

```bash
# Via CLI
kore-platform-cli connector delete conn_xyz789

# Via API
DELETE /api/indexes/index_abc123/connectors/conn_xyz789
```

This deletes the connector and revokes stored tokens.

---

## CLI Reference

### Connector Management

#### Create Connector

```bash
kore-platform-cli connector create <type> <name> --index-id <id>

# Example:
kore-platform-cli connector create sharepoint "Company SharePoint" \
  --index-id index_abc123

# Output:
# ✅ Connector created: conn_xyz789
# 📋 Source: src_def456
# 🔐 Next step: kore-platform-cli connector auth conn_xyz789
```

**Options:**

- `<type>`: Connector type (currently only `sharepoint`)
- `<name>`: Display name for the connector
- `--index-id`: ID of the search index to attach to

#### List Connectors

```bash
kore-platform-cli connector list --index-id <id>

# Example:
kore-platform-cli connector list --index-id index_abc123

# Output:
# ┌─────────────────────────────────────────────────────────────────────┐
# │ ID            Type        Name                 Auth    Last Sync    │
# ├─────────────────────────────────────────────────────────────────────┤
# │ conn_xyz789   sharepoint  Company SharePoint   ✅      2 hours ago  │
# │ conn_abc123   sharepoint  Marketing SP         ❌      Never        │
# └─────────────────────────────────────────────────────────────────────┘
```

#### Delete Connector

```bash
kore-platform-cli connector delete <connector-id>

# Example:
kore-platform-cli connector delete conn_xyz789

# Confirmation:
# ⚠️  This will delete the connector and all associated data.
# Continue? (y/N): y
# ✅ Connector deleted
```

### Authentication Commands

#### Initiate Auth

```bash
kore-platform-cli connector auth <connector-id>

# Example:
kore-platform-cli connector auth conn_xyz789
```

### Filter Commands

#### Set Filters

```bash
kore-platform-cli connector filter set <connector-id> [options]

# Example: Filter by sites
kore-platform-cli connector filter set conn_xyz789 \
  --sites "https://contoso.sharepoint.com/sites/engineering,https://contoso.sharepoint.com/sites/sales"

# Example: Filter by content types
kore-platform-cli connector filter set conn_xyz789 \
  --content-types "Document,Page"

# Example: Filter by libraries
kore-platform-cli connector filter set conn_xyz789 \
  --libraries "Documents,Shared Documents"

# Example: Combine filters
kore-platform-cli connector filter set conn_xyz789 \
  --sites "https://contoso.sharepoint.com/sites/engineering" \
  --libraries "Documents" \
  --content-types "Document"
```

**Options:**

- `--sites`: Comma-separated list of site URLs
- `--libraries`: Comma-separated list of library names
- `--content-types`: Comma-separated list of content types

#### Clear Filters

```bash
kore-platform-cli connector filter clear <connector-id>

# Example:
kore-platform-cli connector filter clear conn_xyz789

# ✅ Filters cleared. Connector will sync all accessible content.
```

### Sync Commands

#### Start Sync

```bash
kore-platform-cli connector sync start <connector-id>

# Example:
kore-platform-cli connector sync start conn_xyz789

# Output:
# 🚀 Starting full sync for conn_xyz789
# ✅ Sync started
# 📊 Monitor progress: kore-platform-cli connector sync status conn_xyz789
```

#### Check Sync Status

```bash
kore-platform-cli connector sync status <connector-id>

# Example:
kore-platform-cli connector sync status conn_xyz789

# Output:
# Status: syncing
# Progress: 1,234 / 5,000 documents (24.7%)
# Rate: 15 docs/sec
# Elapsed: 1m 22s
# ETA: 4m 10s
# Errors: 3
```

#### Pause Sync

```bash
kore-platform-cli connector sync pause <connector-id>

# Example:
kore-platform-cli connector sync pause conn_xyz789

# Output:
# ⏸️  Sync paused
# 💾 Progress saved at document 1,234
```

#### Resume Sync

```bash
kore-platform-cli connector sync resume <connector-id>

# Example:
kore-platform-cli connector sync resume conn_xyz789

# Output:
# ▶️  Resuming sync from document 1,234
# ✅ Sync resumed
```

### Permission Commands (Phase 2)

#### Set Permission Mode

```bash
kore-platform-cli connector permission mode <connector-id> --mode <mode>

# Example: Full mode (100% accurate, slower)
kore-platform-cli connector permission mode conn_xyz789 --mode full

# Example: Simplified mode (95% accurate, 5x faster)
kore-platform-cli connector permission mode conn_xyz789 --mode simplified

# Example: Disabled mode (public access)
kore-platform-cli connector permission mode conn_xyz789 --mode disabled
```

**Modes:**

- `full`: 100% accurate, ~200-500ms per document
- `simplified`: 95% accurate, ~50ms per document (5x faster)
- `disabled`: No permission tracking, public access assumed

---

## API Reference

### Base URL

```
http://localhost:3000/api
```

### Authentication

All API requests require JWT authentication:

```bash
Authorization: Bearer YOUR_JWT_TOKEN
```

### Endpoints

#### Create Connector

```http
POST /indexes/:indexId/connectors
```

**Request Body:**

```json
{
  "name": "Company SharePoint",
  "connectorType": "sharepoint",
  "connectionConfig": {
    "tenantUrl": "https://contoso.sharepoint.com",
    "clientId": "12345678-1234-1234-1234-123456789abc",
    "scopes": ["Sites.Read.All", "Files.Read.All"]
  }
}
```

**Response:**

```json
{
  "connector": {
    "_id": "conn_xyz789",
    "tenantId": "tenant_123",
    "sourceId": "src_def456",
    "connectorType": "sharepoint",
    "oauthTokenId": null,
    "connectionConfig": {
      "tenantUrl": "https://contoso.sharepoint.com",
      "clientId": "12345678-1234-1234-1234-123456789abc",
      "scopes": ["Sites.Read.All", "Files.Read.All"]
    },
    "syncState": {
      "lastFullSyncAt": null,
      "lastDeltaSyncAt": null,
      "deltaToken": null,
      "totalDocuments": 0,
      "processedDocuments": 0,
      "failedDocuments": 0
    },
    "filterConfig": {
      "mode": "include",
      "siteUrls": [],
      "libraryNames": [],
      "contentTypes": [],
      "modifiedSince": null
    },
    "createdAt": "2026-02-23T19:00:00Z",
    "updatedAt": "2026-02-23T19:00:00Z"
  },
  "source": {
    "_id": "src_def456",
    "name": "Company SharePoint"
  }
}
```

**curl Example:**

```bash
curl -X POST "http://localhost:3000/api/indexes/index_abc123/connectors" \
  -H "Content-Type: application/json" \
  -H "Authorization: Bearer YOUR_JWT_TOKEN" \
  -d '{
    "name": "Company SharePoint",
    "connectorType": "sharepoint",
    "connectionConfig": {
      "tenantUrl": "https://contoso.sharepoint.com",
      "clientId": "12345678-1234-1234-1234-123456789abc",
      "scopes": ["Sites.Read.All", "Files.Read.All"]
    }
  }'
```

#### List Connectors

```http
GET /indexes/:indexId/connectors
```

**Response:**

```json
{
  "connectors": [
    {
      "_id": "conn_xyz789",
      "connectorType": "sharepoint",
      "name": "Company SharePoint",
      "authenticated": true,
      "lastSyncAt": "2026-02-23T18:00:00Z",
      "documentCount": 5432
    }
  ],
  "total": 1
}
```

**curl Example:**

```bash
curl -X GET "http://localhost:3000/api/indexes/index_abc123/connectors" \
  -H "Authorization: Bearer YOUR_JWT_TOKEN"
```

#### Get Connector Details

```http
GET /indexes/:indexId/connectors/:connectorId
```

**curl Example:**

```bash
curl -X GET "http://localhost:3000/api/indexes/index_abc123/connectors/conn_xyz789" \
  -H "Authorization: Bearer YOUR_JWT_TOKEN"
```

#### Update Connector

```http
PUT /indexes/:indexId/connectors/:connectorId
```

**Request Body (update filters):**

```json
{
  "filterConfig": {
    "mode": "include",
    "siteUrls": ["https://contoso.sharepoint.com/sites/engineering"],
    "libraryNames": ["Documents"],
    "contentTypes": ["Document", "Page"],
    "modifiedSince": null
  }
}
```

**curl Example:**

```bash
curl -X PUT "http://localhost:3000/api/indexes/index_abc123/connectors/conn_xyz789" \
  -H "Content-Type: application/json" \
  -H "Authorization: Bearer YOUR_JWT_TOKEN" \
  -d '{
    "filterConfig": {
      "mode": "include",
      "siteUrls": ["https://contoso.sharepoint.com/sites/engineering"],
      "contentTypes": ["Document", "Page"]
    }
  }'
```

#### Delete Connector

```http
DELETE /indexes/:indexId/connectors/:connectorId
```

**Response:**

```json
{
  "deleted": true,
  "connectorId": "conn_xyz789"
}
```

**curl Example:**

```bash
curl -X DELETE "http://localhost:3000/api/indexes/index_abc123/connectors/conn_xyz789" \
  -H "Authorization: Bearer YOUR_JWT_TOKEN"
```

#### Initiate Authentication

```http
POST /connectors/:connectorId/auth/initiate
```

**Response:**

```json
{
  "deviceCode": "device-test-123",
  "userCode": "ABCD-1234",
  "verificationUri": "https://microsoft.com/devicelogin",
  "interval": 5,
  "expiresIn": 900,
  "message": "Visit https://microsoft.com/devicelogin and enter code: ABCD-1234"
}
```

**curl Example:**

```bash
curl -X POST "http://localhost:3000/api/connectors/conn_xyz789/auth/initiate" \
  -H "Authorization: Bearer YOUR_JWT_TOKEN"
```

#### Check Authentication Status

```http
GET /connectors/:connectorId/auth/status
```

**Response:**

```json
{
  "authenticated": true,
  "expiresAt": "2026-02-24T10:30:00Z",
  "scopes": ["Sites.Read.All", "Files.Read.All"]
}
```

**curl Example:**

```bash
curl -X GET "http://localhost:3000/api/connectors/conn_xyz789/auth/status" \
  -H "Authorization: Bearer YOUR_JWT_TOKEN"
```

#### Start Sync

```http
POST /connectors/:connectorId/sync/start
```

**Request Body:**

```json
{
  "syncType": "full"
}
```

**Response:**

```json
{
  "syncStarted": true,
  "syncType": "full",
  "message": "full sync started",
  "startedAt": "2026-02-23T19:30:00Z"
}
```

**curl Example:**

```bash
curl -X POST "http://localhost:3000/api/connectors/conn_xyz789/sync/start" \
  -H "Content-Type: application/json" \
  -H "Authorization: Bearer YOUR_JWT_TOKEN" \
  -d '{"syncType": "full"}'
```

#### Get Sync Status

```http
GET /connectors/:connectorId/sync/status
```

**Response:**

```json
{
  "status": "syncing",
  "syncState": {
    "totalDocuments": 5000,
    "processedDocuments": 1250,
    "failedDocuments": 5
  },
  "errorState": {
    "consecutiveFailures": 0,
    "isPaused": false
  },
  "progress": {
    "percentage": 25,
    "processed": 1250,
    "total": 5000,
    "failed": 5
  }
}
```

**curl Example:**

```bash
curl -X GET "http://localhost:3000/api/connectors/conn_xyz789/sync/status" \
  -H "Authorization: Bearer YOUR_JWT_TOKEN"
```

#### Pause Sync

```http
POST /connectors/:connectorId/sync/pause
```

**Request Body:**

```json
{
  "reason": "Maintenance window"
}
```

**curl Example:**

```bash
curl -X POST "http://localhost:3000/api/connectors/conn_xyz789/sync/pause" \
  -H "Content-Type: application/json" \
  -H "Authorization: Bearer YOUR_JWT_TOKEN" \
  -d '{"reason": "Maintenance window"}'
```

#### Resume Sync

```http
POST /connectors/:connectorId/sync/resume
```

**curl Example:**

```bash
curl -X POST "http://localhost:3000/api/connectors/conn_xyz789/sync/resume" \
  -H "Authorization: Bearer YOUR_JWT_TOKEN"
```

---

## Filter Configuration

Filters control which documents are synced from SharePoint.

### Filter Modes

#### Include Mode (Whitelist)

Sync ONLY documents that match the filters.

```bash
kore-platform-cli connector filter set conn_xyz789 \
  --mode include \
  --sites "https://contoso.sharepoint.com/sites/engineering"
```

**Use cases:**

- Sync specific departments only
- Limit to approved content sites
- Test with small dataset first

#### Exclude Mode (Blacklist) - Phase 2

Sync ALL documents EXCEPT those matching the filters.

```bash
kore-platform-cli connector filter set conn_xyz789 \
  --mode exclude \
  --sites "https://contoso.sharepoint.com/sites/archived"
```

**Use cases:**

- Exclude archived content
- Skip test/development sites
- Omit sensitive departments

### Filter Types

#### 1. Site URL Filter

Filter by SharePoint site URLs.

**CLI Example:**

```bash
kore-platform-cli connector filter set conn_xyz789 \
  --sites "https://contoso.sharepoint.com/sites/engineering,https://contoso.sharepoint.com/sites/sales"
```

**API Example:**

```json
{
  "filterConfig": {
    "mode": "include",
    "siteUrls": [
      "https://contoso.sharepoint.com/sites/engineering",
      "https://contoso.sharepoint.com/sites/sales"
    ]
  }
}
```

**Matching Logic:**

- Case-insensitive substring match
- `"/sites/engineering"` matches `"https://contoso.sharepoint.com/sites/engineering/subsite"`

#### 2. Library Name Filter

Filter by document library names.

**CLI Example:**

```bash
kore-platform-cli connector filter set conn_xyz789 \
  --libraries "Documents,Shared Documents,Project Files"
```

**API Example:**

```json
{
  "filterConfig": {
    "mode": "include",
    "libraryNames": ["Documents", "Shared Documents", "Project Files"]
  }
}
```

**Matching Logic:**

- Case-insensitive substring match
- `"Documents"` matches `"Documents"`, `"Team Documents"`, etc.

#### 3. Content Type Filter

Filter by SharePoint content types.

**CLI Example:**

```bash
kore-platform-cli connector filter set conn_xyz789 \
  --content-types "Document,Page"
```

**API Example:**

```json
{
  "filterConfig": {
    "mode": "include",
    "contentTypes": ["Document", "Page"]
  }
}
```

**Common Content Types:**

- `Document` - Word docs, PDFs, text files
- `Page` - SharePoint wiki pages
- `Picture` - Images
- `Video` - Video files
- `Link` - Links to external resources

#### 4. Modified Date Filter - Phase 2

Filter by last modified date.

**CLI Example:**

```bash
kore-platform-cli connector filter set conn_xyz789 \
  --modified-since "2024-01-01"
```

**API Example:**

```json
{
  "filterConfig": {
    "modifiedSince": "2024-01-01T00:00:00Z"
  }
}
```

**Use cases:**

- Sync only recent documents
- Incremental backfill strategy
- Exclude old archived content

### Combined Filters

All filters use AND logic - documents must match ALL criteria.

**Example: Engineering site, Documents library, Document content type**

```bash
kore-platform-cli connector filter set conn_xyz789 \
  --sites "https://contoso.sharepoint.com/sites/engineering" \
  --libraries "Documents" \
  --content-types "Document"
```

**Result**: Only Word docs, PDFs, etc. from the "Documents" library in the engineering site.

### Clear Filters

Remove all filters to sync everything:

```bash
kore-platform-cli connector filter clear conn_xyz789
```

⚠️ **Warning**: This will sync ALL accessible content, which could be thousands of documents.

---

## Permission Modes

**Note**: Permission crawling is a Phase 2 feature. Currently, all documents are indexed with public access.

### Overview

Permission modes control how document-level access control is tracked and enforced at query time.

### Mode Comparison

| Mode       | Accuracy | Speed per Doc | OAuth Scopes Required                     | Query Overhead |
| ---------- | -------- | ------------- | ----------------------------------------- | -------------- |
| Disabled   | N/A      | 0ms           | Sites.Read.All                            | 0ms            |
| Simplified | 95%      | ~50ms         | Sites.FullControl.All                     | <5ms           |
| Full       | 100%     | ~200-500ms    | Sites.FullControl.All, Directory.Read.All | <10ms          |

### Disabled Mode (Current)

**Behavior**: All documents indexed with public access. No permission checks at query time.

```bash
kore-platform-cli connector permission mode conn_xyz789 --mode disabled
```

**When to use:**

- Content is public within your organization
- Performance is critical
- You have app-level authorization

**Limitations:**

- No user-level access control
- All users see all indexed documents

### Simplified Mode (Phase 2)

**Behavior**: Library-level permissions as baseline, item-level only if `hasUniquePermissions: true`.

```bash
kore-platform-cli connector permission mode conn_xyz789 --mode simplified
```

**When to use:**

- Most documents inherit library permissions
- ~95% accuracy acceptable
- 5x faster than full mode

**How it works:**

1. Get library-level permissions (users + groups)
2. For each document:
   - Check `hasUniquePermissions` flag
   - If true: fetch item-level permissions
   - If false: use library permissions
3. Resolve groups 1 level deep only

**Limitations:**

- Nested group memberships not fully resolved
- May include false positives (user sees doc they shouldn't)
- ~5% accuracy loss

### Full Mode (Phase 2)

**Behavior**: Item-level permissions for every document, recursive group resolution.

```bash
kore-platform-cli connector permission mode conn_xyz789 --mode full
```

**When to use:**

- 100% accuracy required
- Sensitive/regulated content
- Complex permission hierarchies

**How it works:**

1. For each document, call Microsoft Graph `/permissions` endpoint
2. Get direct users and groups
3. Recursively resolve all group memberships
4. Store normalized ACL in `DocumentPermission` collection

**Considerations:**

- 4-10x slower than simplified mode
- Requires `Directory.Read.All` scope (admin consent)
- More API calls (rate limiting impact)

### Query-Time Filtering

When permission mode is enabled (Phase 2):

```javascript
// User query: "engineering documentation"
// System adds permission filter:
{
  "bool": {
    "must": [
      { "match": { "content": "engineering documentation" } }
    ],
    "filter": [
      {
        "bool": {
          "should": [
            { "term": { "permissions.everyone": true } },
            { "term": { "permissions.users.userId": "user@contoso.com" } },
            { "terms": { "permissions.groups.groupId": ["group1", "group2"] } }
          ]
        }
      }
    ]
  }
}
```

**Performance**: <10ms overhead per query (cached group memberships).

---

## Sync Operations

### Full Sync

Enumerates all sites, libraries, and documents from scratch.

**When to use:**

- Initial sync
- After filter changes
- After data corruption

**Process:**

1. Get all accessible SharePoint sites
2. For each site: get all drives (libraries)
3. For each drive: paginate through all items
4. Apply filters (site URL, library name, content type)
5. For each matching item:
   - Create/update `SearchDocument` record
   - Trigger ingestion pipeline
   - Update sync state

**Typical Performance:**

- ~10-20 docs/sec (depends on document size, network, filters)
- 1,000 docs: ~1-2 minutes
- 10,000 docs: ~10-20 minutes
- 100,000 docs: ~2-3 hours

**CLI:**

```bash
kore-platform-cli connector sync start conn_xyz789
```

**API:**

```bash
curl -X POST "http://localhost:3000/api/connectors/conn_xyz789/sync/start" \
  -H "Content-Type: application/json" \
  -H "Authorization: Bearer YOUR_JWT_TOKEN" \
  -d '{"syncType": "full"}'
```

### Delta Sync (Phase 2)

Syncs only changed documents since last sync.

**When to use:**

- After initial full sync
- Scheduled incremental updates
- 10x faster for small changesets

**Process:**

1. Load delta token from previous sync
2. Call Microsoft Graph `/delta` endpoint
3. Process changes:
   - New documents: Create `SearchDocument` + trigger ingestion
   - Modified documents: Update + re-trigger ingestion
   - Deleted documents: Remove from index
4. Save new delta token

**CLI:**

```bash
kore-platform-cli connector sync start conn_xyz789 --type delta
```

### Monitoring Sync Progress

**CLI (real-time):**

```bash
kore-platform-cli connector sync status conn_xyz789

# Output updates every 2 seconds:
# Status: syncing
# Progress: 1,234 / 5,000 documents (24.7%)
# Rate: 15 docs/sec
# Elapsed: 1m 22s
# ETA: 4m 10s
# Errors: 3
```

**API:**

```bash
curl -X GET "http://localhost:3000/api/connectors/conn_xyz789/sync/status" \
  -H "Authorization: Bearer YOUR_JWT_TOKEN"
```

**Response:**

```json
{
  "status": "syncing",
  "syncState": {
    "totalDocuments": 5000,
    "processedDocuments": 1250,
    "failedDocuments": 5
  },
  "progress": {
    "percentage": 25,
    "processed": 1250,
    "total": 5000,
    "failed": 5,
    "rate": 15
  }
}
```

### Pause and Resume (Phase 2)

**Pause:**

```bash
kore-platform-cli connector sync pause conn_xyz789
```

- Saves checkpoint (current position in pagination)
- Stops processing new documents
- Sets `errorState.isPaused = true`

**Resume:**

```bash
kore-platform-cli connector sync resume conn_xyz789
```

- Loads checkpoint from last save
- Continues from exact position
- No duplicate documents

**Use cases:**

- Maintenance windows
- Rate limit exceeded
- Resource constraints

---

## Monitoring & Troubleshooting

### Sync Status Codes

| Status      | Description                       | Action                  |
| ----------- | --------------------------------- | ----------------------- |
| `pending`   | Connector created, not synced yet | Start sync              |
| `syncing`   | Sync in progress                  | Monitor progress        |
| `completed` | Sync finished successfully        | Check indexed documents |
| `failed`    | Sync failed with errors           | Check error logs        |
| `paused`    | Sync paused by user               | Resume when ready       |

### Common Errors

#### 1. Authentication Failed

**Error:**

```
Error: Not authenticated. Run: kore-platform-cli connector auth conn_xyz789
```

**Cause**: No OAuth token stored or token expired.

**Solution:**

```bash
kore-platform-cli connector auth conn_xyz789
```

#### 2. Insufficient Permissions

**Error:**

```
Error: Access denied. Required scope: Sites.Read.All
```

**Cause**: Azure AD app missing required permissions or admin consent not granted.

**Solution:**

1. Go to Azure Portal → App registrations → Your app
2. Navigate to "API permissions"
3. Add missing permissions
4. Click "Grant admin consent"
5. Re-authenticate: `kore-platform-cli connector auth conn_xyz789`

#### 3. Rate Limit Exceeded

**Error:**

```
Error: Rate limit exceeded (429 Too Many Requests)
```

**Cause**: Microsoft Graph API rate limit hit (10,000 requests per 10 minutes per tenant).

**Solution:**

- Connector automatically retries with exponential backoff
- If persistent: reduce concurrent syncs or increase delay between requests
- Check for other applications using the same tenant

#### 4. Token Expired

**Error:**

```
Error: Token expired. Please re-authenticate.
```

**Cause**: Refresh token expired (90-day lifetime).

**Solution:**

```bash
kore-platform-cli connector auth conn_xyz789
```

**Prevention**: Schedule re-authentication every 60 days.

#### 5. Site Not Found

**Error:**

```
Error: Site not found: https://contoso.sharepoint.com/sites/missing
```

**Cause**: Site URL filter includes non-existent site or user doesn't have access.

**Solution:**

- Verify site URL is correct (case-sensitive)
- Ensure authenticated user has access to the site
- Check site hasn't been deleted or renamed

#### 6. Document Download Failed

**Error:**

```
Warning: Failed to download document: doc_123 (File too large)
```

**Cause**: Document exceeds size limit or download timeout.

**Solution:**

- Check document size (default limit: 100MB)
- Increase timeout in connector config
- Exclude large files with size filter (Phase 2)

**Note**: Sync continues for other documents. Failed documents tracked in `syncState.failedDocuments`.

### Logging

**CLI Logs:**

- Saved to: `~/.kore-platform-cli/logs/connectors.log`
- Format: JSON structured logging
- Levels: ERROR, WARN, INFO, DEBUG

**API Logs:**

- Location: Application stdout/stderr
- Format: JSON structured logging
- Includes: connector ID, tenant ID, operation, duration, error details

**Example log entry:**

```json
{
  "level": "info",
  "timestamp": "2026-02-23T19:30:00Z",
  "connectorId": "conn_xyz789",
  "tenantId": "tenant_123",
  "operation": "sync:document",
  "documentId": "doc_456",
  "duration": 145,
  "message": "Document synced successfully"
}
```

### Performance Optimization

**Tips:**

1. **Use filters aggressively** - Reduce total document count
2. **Start with small test sync** - Test filters before full sync
3. **Schedule syncs during off-peak hours** - Avoid rate limits
4. **Monitor failed documents** - Fix issues incrementally
5. **Use simplified permission mode** - 5x faster than full (Phase 2)

### Health Checks

**Connector health:**

```bash
curl -X GET "http://localhost:3000/api/connectors/conn_xyz789" \
  -H "Authorization: Bearer YOUR_JWT_TOKEN"
```

Check:

- `errorState.consecutiveFailures` - Should be 0
- `errorState.isPaused` - Should be false
- `oauthTokenId` - Should not be null
- `syncState.lastFullSyncAt` - Should be recent

**Database health:**

```javascript
// Check SearchDocument count
db.search_documents.countDocuments({ sourceId: 'src_def456' });

// Check for failed documents
db.search_documents.countDocuments({
  sourceId: 'src_def456',
  status: 'failed',
});
```

---

## Best Practices

### Security

1. **Store credentials securely**
   - Never commit client IDs, tenant IDs, or tokens to version control
   - Use environment variables or secrets manager
   - Rotate tokens regularly (every 60 days)

2. **Principle of least privilege**
   - Only request required OAuth scopes
   - Use separate Azure AD apps for dev/staging/prod
   - Audit who has admin consent capability

3. **Monitor access**
   - Review connector audit logs regularly
   - Alert on authentication failures
   - Track which users create connectors

### Performance

1. **Filter early and often**
   - Apply site/library filters to reduce data volume
   - Test with small dataset first (1 site, 1 library)
   - Expand filters incrementally

2. **Schedule strategically**
   - Run full syncs during off-peak hours
   - Use delta sync for frequent updates (Phase 2)
   - Stagger multiple connector syncs

3. **Monitor resource usage**
   - Track sync duration over time
   - Watch for increasing failed document counts
   - Alert on sync failures

### Maintenance

1. **Regular health checks**
   - Weekly: Check sync status and error counts
   - Monthly: Re-authenticate if tokens near expiry
   - Quarterly: Review and update filters

2. **Capacity planning**
   - Estimate document growth rate
   - Plan for storage (MongoDB + OpenSearch)
   - Scale infrastructure before hitting limits

3. **Disaster recovery**
   - Document connector configuration
   - Backup MongoDB collections (ConnectorConfig, SearchDocument)
   - Test restore procedures

### Data Quality

1. **Validate after sync**
   - Spot-check random documents in search results
   - Verify metadata accuracy
   - Test edge cases (special characters, large files)

2. **Handle failures gracefully**
   - Review failed documents weekly
   - Fix underlying issues (permissions, size limits)
   - Re-run sync to retry failures

3. **Keep filters updated**
   - Remove access to deleted/archived sites
   - Add new sites as they're created
   - Adjust content type filters as needed

---

## Support

### Resources

- **Architecture Doc**: `packages/connectors/sharepoint/docs/ARCHITECTURE.md`
- **API Reference**: `docs/searchai/API-REFERENCE.md`
- **Task Tracker**: `packages/connectors/sharepoint/docs/TASK-TRACKER.md`
- **Code**: `packages/connectors/sharepoint/`

### Reporting Issues

1. Collect diagnostic info:

   ```bash
   # Connector details
   kore-platform-cli connector list --index-id index_abc123

   # Sync status
   kore-platform-cli connector sync status conn_xyz789

   # Logs
   cat ~/.kore-platform-cli/logs/connectors.log | tail -100
   ```

2. Create issue with:
   - Connector ID
   - Error message
   - Steps to reproduce
   - Expected vs. actual behavior

### FAQ

**Q: How long does initial sync take?**
A: ~10-20 docs/sec. 1,000 docs = 1-2 min, 10,000 docs = 10-20 min, 100,000 docs = 2-3 hours.

**Q: Can I sync multiple SharePoint tenants?**
A: Yes, create separate connectors for each tenant, each with its own OAuth authentication.

**Q: What happens if sync is interrupted?**
A: Phase 2 adds checkpoint/resume. Phase 1: restart sync from beginning.

**Q: How often should I run syncs?**
A: Initial full sync, then delta sync every 1-4 hours (Phase 2). Adjust based on content update frequency.

**Q: Are deleted documents removed from the index?**
A: Phase 2 adds delta sync with deletion detection. Phase 1: manual cleanup needed.

**Q: Can I sync on-premises SharePoint?**
A: No, currently only SharePoint Online via Microsoft Graph API.

**Q: What's the maximum document size?**
A: Default 100MB. Configurable, but larger files impact performance.

**Q: Do I need admin consent for all permissions?**
A: Yes, delegated permissions require tenant admin consent in Azure AD.

---

## Appendix

### OAuth Scopes Reference

| Scope                 | Type      | Consent | Description                        |
| --------------------- | --------- | ------- | ---------------------------------- |
| Sites.Read.All        | Delegated | Admin   | Read sites and libraries           |
| Files.Read.All        | Delegated | Admin   | Read files and metadata            |
| Sites.FullControl.All | Delegated | Admin   | Read permissions (Phase 2)         |
| Directory.Read.All    | Delegated | Admin   | Resolve group membership (Phase 2) |

### Content Type Reference

Common SharePoint content types:

- `Document` - Word, Excel, PowerPoint, PDF
- `Page` - Wiki pages, modern pages
- `Picture` - JPG, PNG, GIF
- `Video` - MP4, AVI, WMV
- `Audio` - MP3, WAV
- `Link` - External links
- `Folder` - Directories (not synced)
- `OneNote` - OneNote notebooks
- `Task` - Task items
- `Event` - Calendar events

### Rate Limits

**Microsoft Graph API:**

- 10,000 requests per 10 minutes per tenant
- Connector automatically throttles to ~16.67 req/sec
- Shared across all applications using the same tenant

**Search AI API:**

- No hard limits on connector operations
- MongoDB connection pool: 100 connections
- Redis cache: 10GB default

### Database Schema

**ConnectorConfig Collection:**

```javascript
{
  _id: "conn_xyz789",
  tenantId: "tenant_123",
  sourceId: "src_def456",
  connectorType: "sharepoint",
  oauthTokenId: "token_ghi789",
  connectionConfig: {
    tenantUrl: "https://contoso.sharepoint.com",
    clientId: "12345678-1234-...",
    scopes: ["Sites.Read.All", "Files.Read.All"]
  },
  syncState: {
    lastFullSyncAt: Date,
    lastDeltaSyncAt: Date,
    deltaToken: String,
    totalDocuments: Number,
    processedDocuments: Number,
    failedDocuments: Number
  },
  filterConfig: {
    mode: "include",
    siteUrls: Array<String>,
    libraryNames: Array<String>,
    contentTypes: Array<String>,
    modifiedSince: Date
  },
  permissionConfig: {
    mode: "disabled",
    crawlSchedule: String,
    lastCrawlAt: Date
  },
  errorState: {
    consecutiveFailures: Number,
    lastErrorAt: Date,
    lastErrorMessage: String,
    isPaused: Boolean
  }
}
```

---

**Version**: 1.0.0 (Phase 1 MVP)
**Last Updated**: 2026-02-23
**Next Update**: Phase 2 (delta sync, webhooks, permissions)

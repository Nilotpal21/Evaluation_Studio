# SharePoint Connector - Manual E2E Test Plan

**Test Date**: **\*\***\_**\*\***
**Tester**: **\*\***\_**\*\***
**Environment**: **\*\***\_**\*\***
**SharePoint Tenant**: **\*\***\_**\*\***

---

## Prerequisites Checklist

Before starting tests, ensure you have:

- [ ] Access to a SharePoint Online tenant (with test content)
- [ ] Azure AD admin access (to create app registration)
- [ ] Search AI platform running locally or on dev environment
- [ ] MongoDB and Redis accessible
- [ ] CLI tool installed: `kore-platform-cli`
- [ ] Valid JWT token for API access (if testing via API)

---

## Test Environment Setup

### Step 1: Verify Platform Running

```bash
# Check if Search AI API is running
curl http://localhost:3000/health

# Expected: {"status": "ok"}
```

**Result**: ⬜ PASS / ⬜ FAIL
**Notes**: **\*\***\_\_\_**\*\***

---

### Step 2: Verify CLI Installed

```bash
# Check CLI version
kore-platform-cli --version

# Should show version number
```

**Result**: ⬜ PASS / ⬜ FAIL
**Notes**: **\*\***\_\_\_**\*\***

---

### Step 3: Authenticate with Platform

```bash
# Login to platform
kore-platform-cli login

# Follow prompts to authenticate
```

**Result**: ⬜ PASS / ⬜ FAIL
**Notes**: **\*\***\_\_\_**\*\***

---

## Azure AD Setup (One-Time)

### Step 4: Create Azure AD App Registration

**Instructions:**

1. Go to https://portal.azure.com
2. Navigate to: **Azure Active Directory** → **App registrations**
3. Click **New registration**
4. Fill in:
   - **Name**: `SearchAI SharePoint Connector Test`
   - **Supported account types**: `Accounts in any organizational directory (Multitenant)`
   - **Redirect URI**:
     - Platform: `Public client/native (mobile & desktop)`
     - URI: `https://login.microsoftonline.com/common/oauth2/nativeclient`
5. Click **Register**

**Record Application Details:**

- Application (client) ID: `_________________________`
- Directory (tenant) ID: `_________________________` (or use "organizations")

**Result**: ⬜ PASS / ⬜ FAIL
**Screenshot**: `azure-app-registration.png`

---

### Step 5: Configure API Permissions

**Instructions:**

1. In your app, go to **API permissions**
2. Click **Add a permission** → **Microsoft Graph** → **Delegated permissions**
3. Add these permissions:
   - [ ] `Sites.Read.All`
   - [ ] `Files.Read.All`
4. Click **Add permissions**
5. Click **Grant admin consent for [organization]**
6. Confirm admin consent granted (green checkmarks)

**Result**: ⬜ PASS / ⬜ FAIL
**Screenshot**: `azure-permissions-granted.png`

---

### Step 6: Enable Public Client Flow

**Instructions:**

1. Navigate to **Authentication**
2. Scroll to **Advanced settings** → **Allow public client flows**
3. Set to **Yes**
4. Click **Save**

**Result**: ⬜ PASS / ⬜ FAIL

---

## Test Scenario 1: Create Search Index

### Step 7: Create Index (if needed)

```bash
# Create a test index
kore-platform-cli index create "SharePoint Connector Test"

# Record the index ID
```

**Index ID**: `_________________________`

**Result**: ⬜ PASS / ⬜ FAIL
**Notes**: **\*\***\_\_\_**\*\***

---

## Test Scenario 2: Create Connector

### Step 8: Create SharePoint Connector

```bash
# Create connector (replace with your index ID)
kore-platform-cli connector create sharepoint "Test SharePoint Connector" \
  --index-id YOUR_INDEX_ID

# Record the connector ID from output
```

**Connector ID**: `_________________________`
**Source ID**: `_________________________`

**Expected Output:**

```
✅ Connector created: conn_xyz789
📋 Source: src_def456
🔐 Next step: kore-platform-cli connector auth conn_xyz789
```

**Result**: ⬜ PASS / ⬜ FAIL
**Screenshot**: `connector-created.png`
**Notes**: **\*\***\_\_\_**\*\***

---

### Step 9: Verify Connector in Database

```bash
# Check MongoDB
# Connect to MongoDB and run:
db.connector_configs.findOne({_id: "YOUR_CONNECTOR_ID"})

# Should show connector document with:
# - connectorType: "sharepoint"
# - oauthTokenId: null (not authenticated yet)
# - filterConfig: default values
```

**Result**: ⬜ PASS / ⬜ FAIL
**Notes**: **\*\***\_\_\_**\*\***

---

## Test Scenario 3: OAuth Authentication

### Step 10: Initiate Authentication

```bash
# Start OAuth Device Code Flow (replace with your connector ID)
kore-platform-cli connector auth YOUR_CONNECTOR_ID

# CLI will display:
# ┌────────────────────────────────────────────┐
# │  Open this URL in your browser:            │
# │  https://microsoft.com/devicelogin         │
# │                                            │
# │  Enter code: ABCD-1234                     │
# └────────────────────────────────────────────┘
# ⏳ Waiting for authorization...
```

**Device Code Displayed**: `_________________________`
**Verification URL**: `_________________________`

**Result (Code Display)**: ⬜ PASS / ⬜ FAIL
**Screenshot**: `device-code-display.png`

---

### Step 11: Complete Authentication in Browser

**Instructions:**

1. Open the verification URL in a browser
2. Enter the device code displayed
3. Sign in with your SharePoint account
4. Review and accept the requested permissions:
   - Read sites and document libraries
   - Read files and their metadata
5. Wait for confirmation page: "You have signed in to the SearchAI SharePoint Connector Test application"

**Authentication Time**: **\_\_\_** seconds

**Result**: ⬜ PASS / ⬜ FAIL
**Screenshot**: `browser-auth-complete.png`

---

### Step 12: Verify CLI Confirmation

**Expected Output:**

```
✅ Successfully authenticated!
🔑 Token stored and encrypted
⏰ Token valid until: 2026-02-24 10:30:00
```

**Result**: ⬜ PASS / ⬜ FAIL
**Screenshot**: `cli-auth-success.png`

---

### Step 13: Verify Token in Database

```bash
# Check MongoDB for OAuth token
db.end_user_oauth_tokens.findOne({connectorId: "YOUR_CONNECTOR_ID"})

# Should show:
# - encryptedAccessToken: (encrypted string)
# - encryptedRefreshToken: (encrypted string)
# - expiresAt: (future date)
# - scope: "Sites.Read.All Files.Read.All"

# Verify connector updated
db.connector_configs.findOne({_id: "YOUR_CONNECTOR_ID"})

# Should now have:
# - oauthTokenId: (token ID reference)
```

**Result**: ⬜ PASS / ⬜ FAIL
**Notes**: **\*\***\_\_\_**\*\***

---

### Step 14: Check Authentication Status

```bash
# Verify authentication via CLI
kore-platform-cli connector list --index-id YOUR_INDEX_ID

# Should show connector with "✅" in Auth column
```

**Result**: ⬜ PASS / ⬜ FAIL
**Screenshot**: `connector-list-authenticated.png`

---

## Test Scenario 4: Filter Configuration

### Step 15: Set Site URL Filter

```bash
# Configure to sync only specific site (replace with your site URL)
kore-platform-cli connector filter set YOUR_CONNECTOR_ID \
  --sites "https://YOUR-TENANT.sharepoint.com/sites/YOUR-SITE"

# Expected output:
# ✅ Filters updated
# 📋 Mode: include
# 🌐 Sites: https://YOUR-TENANT.sharepoint.com/sites/YOUR-SITE
```

**Site URL Used**: `_________________________`

**Result**: ⬜ PASS / ⬜ FAIL
**Screenshot**: `filter-site-set.png`

---

### Step 16: Add Content Type Filter

```bash
# Add content type filter
kore-platform-cli connector filter set YOUR_CONNECTOR_ID \
  --sites "https://YOUR-TENANT.sharepoint.com/sites/YOUR-SITE" \
  --content-types "Document,Page"

# Expected output:
# ✅ Filters updated
# 📋 Content Types: Document, Page
```

**Result**: ⬜ PASS / ⬜ FAIL
**Notes**: **\*\***\_\_\_**\*\***

---

### Step 17: Verify Filters in Database

```bash
# Check MongoDB
db.connector_configs.findOne({_id: "YOUR_CONNECTOR_ID"})

# Verify filterConfig:
# {
#   mode: "include",
#   siteUrls: ["https://..."],
#   contentTypes: ["Document", "Page"],
#   libraryNames: [],
#   modifiedSince: null
# }
```

**Result**: ⬜ PASS / ⬜ FAIL
**Notes**: **\*\***\_\_\_**\*\***

---

## Test Scenario 5: Full Sync Operation

### Step 18: Start Full Sync

```bash
# Start sync
kore-platform-cli connector sync start YOUR_CONNECTOR_ID

# Expected output:
# 🚀 Starting full sync for conn_xyz789
# ✅ Sync started
# 📊 Monitor progress: kore-platform-cli connector sync status YOUR_CONNECTOR_ID
```

**Sync Start Time**: `_________________________`

**Result**: ⬜ PASS / ⬜ FAIL
**Screenshot**: `sync-started.png`

---

### Step 19: Monitor Sync Progress (5 checks)

**Check every 30 seconds:**

```bash
# Check sync status
kore-platform-cli connector sync status YOUR_CONNECTOR_ID
```

**Check 1** (30s):

- Status: `_____________`
- Progress: `_______ / _______ (_______%)`
- Rate: `_______ docs/sec`
- Errors: `_______`

**Check 2** (1m):

- Status: `_____________`
- Progress: `_______ / _______ (_______%)`
- Rate: `_______ docs/sec`
- Errors: `_______`

**Check 3** (1m 30s):

- Status: `_____________`
- Progress: `_______ / _______ (_______%)`
- Rate: `_______ docs/sec`
- Errors: `_______`

**Check 4** (2m):

- Status: `_____________`
- Progress: `_______ / _______ (_______%)`
- Rate: `_______ docs/sec`
- Errors: `_______`

**Check 5** (Final):

- Status: `_____________`
- Progress: `_______ / _______ (_______%)`
- Rate: `_______ docs/sec`
- Errors: `_______`

**Result**: ⬜ PASS / ⬜ FAIL
**Screenshot**: `sync-progress.png`

---

### Step 20: Wait for Sync Completion

**Sync Completion Time**: `_________________________`
**Total Duration**: `_______ minutes`
**Total Documents**: `_______`
**Failed Documents**: `_______`
**Average Rate**: `_______ docs/sec`

**Result**: ⬜ PASS / ⬜ FAIL
**Screenshot**: `sync-completed.png`

---

### Step 21: Verify Documents in Database

```bash
# Check SearchDocument collection
db.search_documents.countDocuments({
  sourceId: "YOUR_SOURCE_ID",
  tenantId: "YOUR_TENANT_ID"
})

# Should match total documents synced
```

**Document Count in DB**: `_______`
**Matches Sync Count**: ⬜ YES / ⬜ NO

**Sample Document Check:**

```bash
# Get one document
db.search_documents.findOne({sourceId: "YOUR_SOURCE_ID"})

# Verify fields:
# - originalReference: (SharePoint item URL)
# - contentHash: (hash string)
# - status: "pending" or "indexed"
# - sourceMetadata.sharepoint: {siteUrl, driveId, itemId, itemName}
```

**Result**: ⬜ PASS / ⬜ FAIL
**Notes**: **\*\***\_\_\_**\*\***

---

### Step 22: Check Ingestion Jobs

```bash
# Check BullMQ ingestion queue (if accessible)
# Look for jobs with connector's sourceId

# Or check application logs for ingestion jobs triggered
tail -f /path/to/search-ai-api.log | grep "ingest:.*YOUR_SOURCE_ID"
```

**Jobs Created**: ⬜ YES / ⬜ NO
**Job Count**: `_______`

**Result**: ⬜ PASS / ⬜ FAIL
**Notes**: **\*\***\_\_\_**\*\***

---

## Test Scenario 6: Verify Indexed Content

### Step 23: Check OpenSearch Index

```bash
# Query OpenSearch for indexed documents
curl -X GET "http://localhost:9200/search-vectors-v1/_search" \
  -H "Content-Type: application/json" \
  -d '{
    "query": {
      "term": {
        "metadata.sys.sourceId": "YOUR_SOURCE_ID"
      }
    },
    "size": 10
  }'

# Count total indexed
curl -X GET "http://localhost:9200/search-vectors-v1/_count" \
  -H "Content-Type: application/json" \
  -d '{
    "query": {
      "term": {
        "metadata.sys.sourceId": "YOUR_SOURCE_ID"
      }
    }
  }'
```

**Indexed Document Count**: `_______`
**Embeddings Present**: ⬜ YES / ⬜ NO

**Result**: ⬜ PASS / ⬜ FAIL
**Notes**: **\*\***\_\_\_**\*\***

---

### Step 24: Test Search Query

```bash
# Search for content from SharePoint
curl -X POST "http://localhost:3000/api/indexes/YOUR_INDEX_ID/search" \
  -H "Content-Type: application/json" \
  -H "Authorization: Bearer YOUR_JWT_TOKEN" \
  -d '{
    "query": "YOUR_SEARCH_TERM",
    "limit": 10
  }'

# Should return results from SharePoint documents
```

**Search Term Used**: `_________________________`
**Results Returned**: `_______`
**SharePoint Documents in Results**: `_______`

**Result**: ⬜ PASS / ⬜ FAIL
**Screenshot**: `search-results.png`

---

### Step 25: Verify Metadata

**Check one result for SharePoint metadata:**

```json
{
  "content": "...",
  "metadata": {
    "sourceMetadata": {
      "sharepoint": {
        "siteUrl": "...",
        "siteName": "...",
        "driveId": "...",
        "driveName": "...",
        "itemId": "...",
        "itemName": "...",
        "itemWebUrl": "...",
        "createdBy": "...",
        "lastModifiedBy": "..."
      }
    }
  }
}
```

**Metadata Present**: ⬜ YES / ⬜ NO
**Fields Complete**: ⬜ YES / ⬜ NO

**Result**: ⬜ PASS / ⬜ FAIL

---

## Test Scenario 7: Error Handling

### Step 26: Test Invalid Authentication

```bash
# Delete OAuth token from database
db.end_user_oauth_tokens.deleteOne({connectorId: "YOUR_CONNECTOR_ID"})

# Update connector to remove oauthTokenId
db.connector_configs.updateOne(
  {_id: "YOUR_CONNECTOR_ID"},
  {$set: {oauthTokenId: null}}
)

# Try to start sync (should fail)
kore-platform-cli connector sync start YOUR_CONNECTOR_ID

# Expected error:
# ❌ Error: Connector not authenticated
# 🔐 Run: kore-platform-cli connector auth YOUR_CONNECTOR_ID
```

**Error Displayed**: ⬜ YES / ⬜ NO
**Error Message Helpful**: ⬜ YES / ⬜ NO

**Result**: ⬜ PASS / ⬜ FAIL
**Screenshot**: `error-no-auth.png`

---

### Step 27: Re-authenticate

```bash
# Re-authenticate connector
kore-platform-cli connector auth YOUR_CONNECTOR_ID

# Complete auth flow again
```

**Re-authentication Successful**: ⬜ YES / ⬜ NO

**Result**: ⬜ PASS / ⬜ FAIL

---

### Step 28: Test Invalid Filter

```bash
# Set filter with non-existent site
kore-platform-cli connector filter set YOUR_CONNECTOR_ID \
  --sites "https://YOUR-TENANT.sharepoint.com/sites/NONEXISTENT"

# Start sync
kore-platform-cli connector sync start YOUR_CONNECTOR_ID

# Check status after 1 minute
kore-platform-cli connector sync status YOUR_CONNECTOR_ID

# Should show:
# - Status: completed (or failed)
# - Total documents: 0 (or very few)
```

**Sync Completed with 0 Docs**: ⬜ YES / ⬜ NO
**Appropriate Handling**: ⬜ YES / ⬜ NO

**Result**: ⬜ PASS / ⬜ FAIL
**Notes**: **\*\***\_\_\_**\*\***

---

## Test Scenario 8: Connector Management

### Step 29: Update Connector Filters

```bash
# Reset to valid site
kore-platform-cli connector filter set YOUR_CONNECTOR_ID \
  --sites "https://YOUR-TENANT.sharepoint.com/sites/YOUR-SITE" \
  --libraries "Documents" \
  --content-types "Document"

# Verify update
kore-platform-cli connector list --index-id YOUR_INDEX_ID
```

**Result**: ⬜ PASS / ⬜ FAIL

---

### Step 30: Clear Filters

```bash
# Clear all filters
kore-platform-cli connector filter clear YOUR_CONNECTOR_ID

# Should show:
# ✅ Filters cleared. Connector will sync all accessible content.
```

**Result**: ⬜ PASS / ⬜ FAIL

---

### Step 31: List All Connectors

```bash
# List connectors for index
kore-platform-cli connector list --index-id YOUR_INDEX_ID

# Should show table with:
# - Connector ID
# - Type (sharepoint)
# - Name
# - Auth status (✅)
# - Last sync time
# - Document count
```

**Table Displayed Correctly**: ⬜ YES / ⬜ NO

**Result**: ⬜ PASS / ⬜ FAIL
**Screenshot**: `connector-list-final.png`

---

## Test Scenario 9: Cleanup

### Step 32: Delete Connector

```bash
# Delete connector
kore-platform-cli connector delete YOUR_CONNECTOR_ID

# Confirmation prompt:
# ⚠️  This will delete the connector and all associated data.
# Continue? (y/N): y

# Expected output:
# ✅ Connector deleted
```

**Result**: ⬜ PASS / ⬜ FAIL
**Screenshot**: `connector-deleted.png`

---

### Step 33: Verify Deletion in Database

```bash
# Check connector deleted
db.connector_configs.findOne({_id: "YOUR_CONNECTOR_ID"})
# Should return: null

# Check OAuth token deleted
db.end_user_oauth_tokens.findOne({connectorId: "YOUR_CONNECTOR_ID"})
# Should return: null

# Note: SearchDocument records may remain (by design for history)
db.search_documents.countDocuments({sourceId: "YOUR_SOURCE_ID"})
```

**Connector Deleted**: ⬜ YES / ⬜ NO
**OAuth Token Deleted**: ⬜ YES / ⬜ NO

**Result**: ⬜ PASS / ⬜ FAIL

---

## Performance Metrics

### Sync Performance

| Metric                 | Value               |
| ---------------------- | ------------------- |
| Total Documents Synced | **\_\_\_**          |
| Total Sync Time        | **\_\_\_** minutes  |
| Average Rate           | **\_\_\_** docs/sec |
| Peak Rate              | **\_\_\_** docs/sec |
| Failed Documents       | **\_\_\_**          |
| Failure Rate           | **\_\_\_**%         |

### API Performance

| Operation        | Response Time      |
| ---------------- | ------------------ |
| Create Connector | **\_\_\_** ms      |
| Initiate Auth    | **\_\_\_** ms      |
| Token Exchange   | **\_\_\_** seconds |
| Start Sync       | **\_\_\_** ms      |
| Get Sync Status  | **\_\_\_** ms      |
| Delete Connector | **\_\_\_** ms      |

---

## Issues Found

### Issue 1

**Description**: \***\*\*\*\*\*\*\***\_\***\*\*\*\*\*\*\***
**Severity**: ⬜ Critical / ⬜ High / ⬜ Medium / ⬜ Low
**Steps to Reproduce**:

1. ***
2. ***
3. ***

**Expected Behavior**: \***\*\*\*\*\*\*\***\_\***\*\*\*\*\*\*\***
**Actual Behavior**: \***\*\*\*\*\*\*\***\_\***\*\*\*\*\*\*\***
**Screenshot**: \***\*\*\*\*\*\*\***\_\***\*\*\*\*\*\*\***

---

### Issue 2

**Description**: \***\*\*\*\*\*\*\***\_\***\*\*\*\*\*\*\***
**Severity**: ⬜ Critical / ⬜ High / ⬜ Medium / ⬜ Low
**Steps to Reproduce**:

1. ***
2. ***
3. ***

**Expected Behavior**: \***\*\*\*\*\*\*\***\_\***\*\*\*\*\*\*\***
**Actual Behavior**: \***\*\*\*\*\*\*\***\_\***\*\*\*\*\*\*\***
**Screenshot**: \***\*\*\*\*\*\*\***\_\***\*\*\*\*\*\*\***

---

### Issue 3

**Description**: \***\*\*\*\*\*\*\***\_\***\*\*\*\*\*\*\***
**Severity**: ⬜ Critical / ⬜ High / ⬜ Medium / ⬜ Low
**Steps to Reproduce**:

1. ***
2. ***
3. ***

**Expected Behavior**: \***\*\*\*\*\*\*\***\_\***\*\*\*\*\*\*\***
**Actual Behavior**: \***\*\*\*\*\*\*\***\_\***\*\*\*\*\*\*\***
**Screenshot**: \***\*\*\*\*\*\*\***\_\***\*\*\*\*\*\*\***

---

## Observations

### Positive Findings

- ***
- ***
- ***

### Areas for Improvement

- ***
- ***
- ***

### UX Notes

- ***
- ***
- ***

---

## Test Summary

**Total Test Steps**: 33
**Passed**: **\_\_\_**
**Failed**: **\_\_\_**
**Blocked**: **\_\_\_**
**Pass Rate**: **\_\_\_**%

**Overall Result**: ⬜ PASS / ⬜ FAIL / ⬜ CONDITIONAL PASS

**Recommendation**:
⬜ Ready for Production
⬜ Ready with Minor Fixes
⬜ Requires Major Fixes
⬜ Not Ready

**Sign-off**:

- Tester: \***\*\*\*\*\*\*\***\_\***\*\*\*\*\*\*\*** Date: **\*\***\_**\*\***
- Reviewer: \***\*\*\*\*\*\*\***\_\***\*\*\*\*\*\*\*** Date: **\*\***\_**\*\***

---

## Appendix: Test Data

### SharePoint Site Details

- Site URL: \***\*\*\*\*\*\*\***\_\***\*\*\*\*\*\*\***
- Site Name: \***\*\*\*\*\*\*\***\_\***\*\*\*\*\*\*\***
- Document Count: \***\*\*\*\*\*\*\***\_\***\*\*\*\*\*\*\***
- Library Name: \***\*\*\*\*\*\*\***\_\***\*\*\*\*\*\*\***

### Platform Details

- Environment: \***\*\*\*\*\*\*\***\_\***\*\*\*\*\*\*\***
- MongoDB Version: \***\*\*\*\*\*\*\***\_\***\*\*\*\*\*\*\***
- Redis Version: \***\*\*\*\*\*\*\***\_\***\*\*\*\*\*\*\***
- OpenSearch Version: \***\*\*\*\*\*\*\***\_\***\*\*\*\*\*\*\***
- Node.js Version: \***\*\*\*\*\*\*\***\_\***\*\*\*\*\*\*\***

### Azure AD App Details

- Application Name: \***\*\*\*\*\*\*\***\_\***\*\*\*\*\*\*\***
- Client ID: \***\*\*\*\*\*\*\***\_\***\*\*\*\*\*\*\***
- Tenant ID: \***\*\*\*\*\*\*\***\_\***\*\*\*\*\*\*\***
- Permissions Granted: \***\*\*\*\*\*\*\***\_\***\*\*\*\*\*\*\***

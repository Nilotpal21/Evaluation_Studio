# SharePoint Delta Sync - Complete Flow Explanation

## Overview

Delta sync is an **incremental synchronization** mechanism that only fetches changes since the last sync, instead of re-fetching all documents. It uses Microsoft Graph's delta query API which returns a `deltaToken` that represents a point-in-time snapshot.

**Key Concepts:**

- **Delta Token**: A string that represents "all changes up to this point"
- **Per-Drive Tokens**: Each SharePoint drive (document library) has its own token
- **Change Types**: `created`, `updated`, `deleted` (identified by `@removed` flag)
- **Real-time Triggers**: Webhook notifications automatically trigger delta sync

---

## Architecture Components

```
┌─────────────────────────────────────────────────────────────────────┐
│                     Delta Sync Architecture                          │
├─────────────────────────────────────────────────────────────────────┤
│                                                                      │
│  ┌──────────────┐        ┌──────────────────┐       ┌────────────┐ │
│  │   Trigger    │───────>│  Delta Sync      │──────>│   Graph    │ │
│  │ (Webhook or  │        │  Coordinator     │       │    API     │ │
│  │   Manual)    │        └──────────────────┘       └────────────┘ │
│  └──────────────┘                 │                        │        │
│                                   │                        │        │
│                          ┌────────▼────────┐      ┌────────▼──────┐ │
│                          │ DeltaTokenManager│      │ Delta Query   │ │
│                          │  (per drive)     │      │ (changes only)│ │
│                          └──────────────────┘      └───────────────┘ │
│                                   │                                  │
│                          ┌────────▼────────┐                        │
│                          │  SearchDocument │                        │
│                          │   (MongoDB)     │                        │
│                          └─────────────────┘                        │
└─────────────────────────────────────────────────────────────────────┘
```

---

## Stage-by-Stage Flow

### Stage 1: Initial Full Sync

**Scenario**: First time connecting to SharePoint

```
User Action:
├─ Creates connector: "Company SharePoint"
├─ Authenticates via OAuth (Device Code Flow)
├─ Sets filters: sites=["Engineering"], libraries=["Documents"]
└─ Clicks "Start Sync"

System Flow:
1. FullSyncCoordinator.performSync()
2. Enumerate sites matching filter (getSites())
3. For each site, enumerate drives/libraries (getDrives())
4. For each drive, paginate ALL items (getDriveItems())
   ├─ Batch 1: items 0-200
   ├─ Batch 2: items 200-400
   └─ ... until @odata.nextLink is null
5. For each item:
   ├─ Apply filters (content type, modified date, etc.)
   ├─ Create SearchDocument in MongoDB
   └─ Enqueue for ingestion pipeline
6. Store initial delta token for each drive:
   ├─ driveId: "b!xyz123..."
   ├─ deltaToken: "aW5pdGlhbC10b2tlbi0xMjM..."
   └─ lastSyncAt: 2026-02-25T10:30:00Z

Result:
├─ 1,234 documents synced
├─ 3 delta tokens stored (one per drive)
└─ Status: "completed"
```

**Database State After Initial Sync:**

```javascript
// DriveDeltaToken collection
{
  tenantId: "tenant-123",
  connectorId: "conn-xyz",
  driveId: "b!xyz123...",
  deltaToken: "aW5pdGlhbC10b2tlbi0xMjM...",
  lastSyncAt: ISODate("2026-02-25T10:30:00Z"),
  itemsProcessed: 1234,
  errorCount: 0
}

// SearchDocument collection
{
  _id: "doc-456",
  tenantId: "tenant-123",
  sourceId: "source-789",
  connectorId: "conn-xyz",
  title: "Q1 Report.docx",
  url: "https://contoso.sharepoint.com/.../Q1%20Report.docx",
  metadata: {
    driveId: "b!xyz123...",
    itemId: "01ABCDEF...",
    createdAt: ISODate("2026-01-15T09:00:00Z"),
    modifiedAt: ISODate("2026-02-20T14:30:00Z")
  }
}
```

---

### Stage 2: Delta Sync (No Changes)

**Scenario**: User triggers manual sync 1 hour later, no changes in SharePoint

```
User Action:
└─ Clicks "Sync Now" (or webhook fires with no actual changes)

System Flow:
1. DeltaSyncCoordinator.performSync()
2. Load delta tokens from database:
   ├─ Drive 1: deltaToken="aW5pdGlhbC10b2tlbi0xMjM..."
   ├─ Drive 2: deltaToken="aW5pdGlhbC10b2tlbi00NTY..."
   └─ Drive 3: deltaToken="aW5pdGlhbC10b2tlbi03ODk..."
3. For each drive, call Graph API delta endpoint:
   GET /drives/{driveId}/root/delta?token={deltaToken}
4. Graph returns:
   {
     "value": [],  // Empty - no changes!
     "@odata.deltaLink": "...?token={newDeltaToken}"
   }
5. Update delta token (even though no changes):
   ├─ deltaToken: "bmV3LXRva2VuLTEyMzQ..."
   └─ lastSyncAt: 2026-02-25T11:30:00Z
6. No documents created/updated/deleted

Result:
├─ 0 changes processed
├─ 3 delta tokens updated
└─ Status: "completed" (in <1 second)
```

**Key Point**: Delta tokens are **always updated** even when there are no changes. This advances the "checkpoint" so future syncs start from the new position.

---

### Stage 3: User Adds One Document

**Scenario**: User uploads "Q2 Forecast.xlsx" to SharePoint

```
Timeline:
T+0s:  User uploads file in SharePoint
T+2s:  Microsoft Graph sends webhook notification
T+2s:  Webhook receiver validates clientState, enqueues worker job
T+3s:  Worker processes notification, checks debouncing
T+3s:  Worker enqueues delta sync job
T+5s:  Delta sync worker picks up job

Delta Sync Flow:
1. Load delta tokens for connector
2. For each drive, call delta endpoint with token
3. Graph returns changes:
   {
     "value": [
       {
         "id": "01QWERTY...",
         "name": "Q2 Forecast.xlsx",
         "createdDateTime": "2026-02-25T12:00:00Z",
         "lastModifiedDateTime": "2026-02-25T12:00:00Z",
         "size": 45678,
         "file": { "mimeType": "application/vnd.ms-excel" }
         // No @removed flag = created/updated
       }
     ],
     "@odata.deltaLink": "...?token={newDeltaToken}"
   }
4. Process the change:
   ├─ Check if document exists in MongoDB (by itemId)
   ├─ Document doesn't exist → CREATE
   ├─ Apply filters (passes: .xlsx, modified today)
   ├─ Create SearchDocument
   └─ Enqueue for ingestion
5. Update delta token:
   ├─ deltaToken: "YWZ0ZXItdXBsb2FkLTEyMzQ..."
   └─ lastSyncAt: 2026-02-25T12:00:05Z

Result:
├─ 1 document created
├─ 1 delta token updated
└─ User sees new file in search within 10-30 seconds
```

---

### Stage 4: User Modifies Existing Document

**Scenario**: User edits "Q1 Report.docx" (changes content)

```
Timeline:
T+0s:  User saves changes in SharePoint
T+2s:  Webhook notification
T+5s:  Delta sync triggered

Delta Sync Flow:
1. Graph delta query returns:
   {
     "value": [
       {
         "id": "01ABCDEF...",  // Same itemId as existing doc
         "name": "Q1 Report.docx",
         "lastModifiedDateTime": "2026-02-25T13:45:00Z",  // Updated!
         "size": 67890,  // Changed size
         "file": { ... }
         // No @removed flag
       }
     ],
     "@odata.deltaLink": "...?token={newDeltaToken}"
   }
2. Process the change:
   ├─ Check if document exists (by itemId: "01ABCDEF...")
   ├─ Document exists in MongoDB → UPDATE
   ├─ Update SearchDocument fields:
   │   ├─ metadata.modifiedAt = "2026-02-25T13:45:00Z"
   │   ├─ metadata.size = 67890
   │   └─ lastModifiedAt = now()
   ├─ Enqueue for re-ingestion (content changed)
   └─ Existing embeddings will be replaced
3. Update delta token

Result:
├─ 1 document updated
├─ Content re-indexed
└─ User sees updated content in search
```

---

### Stage 5: User Deletes Document

**Scenario**: User deletes "Old Report.docx" from SharePoint

```
Timeline:
T+0s:  User deletes file
T+2s:  Webhook notification
T+5s:  Delta sync triggered

Delta Sync Flow:
1. Graph delta query returns:
   {
     "value": [
       {
         "id": "01DELETED...",
         "@removed": {
           "reason": "deleted"
         }
         // @removed flag indicates deletion
       }
     ],
     "@odata.deltaLink": "...?token={newDeltaToken}"
   }
2. Process the deletion:
   ├─ Detect @removed flag
   ├─ Find SearchDocument by itemId
   ├─ Delete from MongoDB:
   │   SearchDocument.findOneAndDelete({
   │     connectorId: "conn-xyz",
   │     "metadata.itemId": "01DELETED..."
   │   })
   ├─ Delete from vector store (if ingested)
   └─ Delete from Neo4j permission graph
3. Update delta token

Result:
├─ 1 document deleted
└─ File removed from search results
```

---

### Stage 6: Bulk Upload (10 Files)

**Scenario**: User bulk uploads 10 files to SharePoint folder

```
Timeline:
T+0s:   User drags 10 files into SharePoint
T+2s:   Graph sends webhook notification (batch)
T+2s:   Webhook receiver gets 10 notifications
T+2s:   Batch processing: validate all 10, enqueue 1 batch job
T+3s:   Worker processes batch, deduplicates, enqueues 1 delta sync
T+5s:   Delta sync triggered (30s debounce active)

Delta Sync Flow:
1. Graph delta query returns:
   {
     "value": [
       { "id": "01FILE1...", "name": "File1.pdf", ... },
       { "id": "01FILE2...", "name": "File2.pdf", ... },
       { "id": "01FILE3...", "name": "File3.pdf", ... },
       // ... 10 items total
     ],
     "@odata.deltaLink": "...?token={newDeltaToken}"
   }
2. Process each change:
   ├─ Loop through 10 items
   ├─ For each: create SearchDocument
   └─ Enqueue all 10 for ingestion
3. Update delta token (once, after processing all)

Result:
├─ 10 documents created in single sync
├─ 1 delta token update
└─ All 10 files searchable within 30-60 seconds

Key Optimization:
├─ 10 webhook notifications → 1 batch job
├─ 1 delta sync job (debouncing prevents multiple syncs)
└─ 1 delta token fetch (gets all 10 changes at once)
```

---

### Stage 7: User Adds Second Folder/Library

**Scenario**: User updates filters to include "Marketing" library

```
User Action:
├─ Goes to connector settings
├─ Updates filter: libraries=["Documents", "Marketing"]
└─ Clicks "Save & Re-sync"

System Flow:
1. **Full sync is triggered** (not delta sync!)
   Why? New library = no delta token exists for it
2. FullSyncCoordinator.performSync()
3. Enumerate drives, find 2 libraries:
   ├─ "Documents" (already synced) → Skip full scan, use delta
   └─ "Marketing" (new) → Full scan required
4. For "Marketing" drive:
   ├─ Paginate ALL items (no delta token)
   ├─ Create SearchDocuments for all items
   └─ Store initial delta token
5. For "Documents" drive:
   ├─ Use existing delta token
   ├─ Fetch only changes since last sync
   └─ Update delta token

Result:
├─ "Marketing" library: 456 new documents (full scan)
├─ "Documents" library: 3 new documents (delta)
├─ Total: 459 documents synced
└─ Now have 4 delta tokens (was 3, added 1 for Marketing)

Database State After:
// New delta token for Marketing drive
{
  tenantId: "tenant-123",
  connectorId: "conn-xyz",
  driveId: "b!marketing123...",
  deltaToken: "bmFya2V0aW5nLXRva2VuLTEyMzQ...",
  lastSyncAt: ISODate("2026-02-25T14:00:00Z"),
  itemsProcessed: 456
}

// Existing tokens updated
{
  driveId: "b!xyz123...",
  deltaToken: "dXBkYXRlZC10b2tlbi01Njc...",
  lastSyncAt: ISODate("2026-02-25T14:00:00Z"),
  itemsProcessed: 1237  // 1234 + 3 changes
}
```

**Important**: When filter changes (new library added), the system is smart:

- **New drives**: Full sync (no token exists)
- **Existing drives**: Delta sync (token exists)
- **Removed drives**: Tokens deleted, documents optionally purged

---

### Stage 8: Token Expiration & Recovery

**Scenario**: Delta token expires (Microsoft expires tokens after 7 days of no use)

```
Timeline:
T+0s:   Delta sync triggered after 8 days of inactivity
T+2s:   Graph API returns 410 Gone error

Delta Sync Flow:
1. Call Graph delta endpoint with old token
2. Graph returns:
   {
     "error": {
       "code": "resyncRequired",
       "message": "Sync token has expired or is invalid"
     }
   }
   HTTP 410 Gone
3. Coordinator catches error, detects token expiry
4. **Automatic fallback to full sync for that drive:**
   ├─ Delete expired token from database
   ├─ Full scan of drive (re-fetch all items)
   ├─ Reconcile with existing documents:
   │   ├─ Update if item still exists
   │   └─ Delete if item no longer returned
   └─ Store new delta token
5. Continue with other drives normally

Result:
├─ 1 drive: Full resync (1,234 items checked, 23 changes found)
├─ Other drives: Delta sync as normal
└─ New delta token stored
```

**Recovery Strategies:**

| Error                         | Recovery Action                            |
| ----------------------------- | ------------------------------------------ |
| 410 Gone (token expired)      | Fallback to full sync, store new token     |
| 404 Not Found (drive deleted) | Remove token, optionally purge documents   |
| 429 Rate Limited              | Retry with exponential backoff             |
| 401 Unauthorized              | Refresh OAuth token, retry                 |
| 5xx Server Error              | Retry with backoff, alert after 3 failures |

---

### Stage 9: Real-Time Sync (Webhook-Triggered)

**Scenario**: User uploads file, webhook triggers instant sync

```
Real-Time Flow (within 5-10 seconds):

T+0s:  User saves "Contract.pdf" in SharePoint
T+0.5s: SharePoint internal processing
T+1s:  Microsoft Graph generates change notification
T+1.5s: Graph sends HTTPS POST to webhook receiver:
        POST /api/webhooks/connectors/conn-xyz/sharepoint
        {
          "value": [{
            "subscriptionId": "sub-123",
            "clientState": "encrypted-secret-456",
            "changeType": "updated",
            "resource": "drives/b!xyz123.../items/01CONTRACT..."
          }]
        }
T+2s:  Webhook receiver:
       ├─ Validates clientState (decrypt, compare)
       ├─ Extracts driveId from resource
       ├─ Batches with any other concurrent notifications
       └─ Enqueues worker job
T+3s:  Worker picks up job:
       ├─ Deduplicates (checks Redis cache)
       ├─ Loads connector (checks not paused)
       ├─ Checks debouncing (30s window)
       └─ Enqueues delta sync job
T+5s:  Delta sync coordinator:
       ├─ Loads delta token
       ├─ Calls Graph delta endpoint
       ├─ Processes change (create/update SearchDocument)
       └─ Updates delta token
T+10s: Ingestion pipeline:
       ├─ Downloads file content
       ├─ Extracts text (PDF → text)
       ├─ Generates embeddings
       └─ Stores in vector database
T+15s: File searchable!

Result:
├─ User uploads file at 10:00:00
├─ File appears in search at 10:00:15
└─ Real-time sync: <15 second latency
```

**Webhook Subscription Management:**

```javascript
// Subscriptions stored in DB
{
  tenantId: "tenant-123",
  connectorId: "conn-xyz",
  driveId: "b!xyz123...",
  subscriptionId: "sub-from-graph-api",
  notificationUrl: "https://api.company.com/webhooks/...",
  encryptedClientState: "encrypted...",
  expiresAt: ISODate("2026-02-26T10:00:00Z"),  // 24-hour expiry
  status: "active",
  lastRenewalAt: ISODate("2026-02-25T10:00:00Z"),
  renewalFailures: 0
}
```

**Background Job: Subscription Renewal**

- Runs every 12 hours
- Finds subscriptions expiring within 24 hours
- Renews via Graph API (extends expiry by 24 hours)
- Updates database with new expiry time
- If renewal fails 3 times: subscription marked `failed`

---

### Stage 10: Multiple Connectors (Same Tenant)

**Scenario**: Company has "US SharePoint" and "EU SharePoint" connectors

```
Configuration:
├─ Connector 1: "US SharePoint"
│   ├─ Sites: ["https://contoso-us.sharepoint.com/..."]
│   ├─ Delta tokens: 3 drives
│   └─ Webhook subscriptions: 3
├─ Connector 2: "EU SharePoint"
│   ├─ Sites: ["https://contoso-eu.sharepoint.com/..."]
│   ├─ Delta tokens: 5 drives
│   └─ Webhook subscriptions: 5

Delta Sync Behavior:
├─ Each connector has independent delta tokens
├─ Each connector has independent webhook subscriptions
├─ Tokens stored with connectorId + driveId (unique per connector)
├─ Webhook notifications routed by connectorId in URL
└─ Both can sync simultaneously (different workers)

Example Database State:
// US Connector tokens
{ connectorId: "conn-us", driveId: "drive-1", deltaToken: "us-token-1" }
{ connectorId: "conn-us", driveId: "drive-2", deltaToken: "us-token-2" }

// EU Connector tokens
{ connectorId: "conn-eu", driveId: "drive-3", deltaToken: "eu-token-1" }
{ connectorId: "conn-eu", driveId: "drive-4", deltaToken: "eu-token-2" }

Both can sync at the same time without conflicts!
```

---

## Performance Characteristics

### Full Sync vs Delta Sync

| Metric                  | Full Sync          | Delta Sync           |
| ----------------------- | ------------------ | -------------------- |
| **API Calls**           | N/200 (pagination) | 1 per drive          |
| **Items Returned**      | All (10,000+)      | Only changes (0-100) |
| **Duration (10K docs)** | 5-10 minutes       | 1-5 seconds          |
| **Database Writes**     | 10,000             | 0-100                |
| **Network Transfer**    | ~50-100MB          | ~10-100KB            |
| **Rate Limit Impact**   | High (100+ calls)  | Low (1 call)         |

### Delta Sync Latency Budget

```
Webhook Notification:    0s    ────────┐
Receiver Processing:    +2s            │
Worker Queue Delay:     +1s            │ User Action → Search
Delta Sync Execution:   +2s            │
Ingestion Pipeline:    +10s            │
Vector Store Index:     +3s            │
                       ─────           │
Total Latency:         ~18s    ────────┘

Optimized (cached):    ~10s
Worst case (retry):    ~60s
```

---

## Error Handling & Edge Cases

### Case 1: Concurrent Modifications

**Problem**: User modifies same file 3 times in 10 seconds

**Solution**:

1. First webhook triggers delta sync
2. Debouncing (30s) prevents subsequent syncs
3. After 30s, next sync fetches **all accumulated changes**
4. Delta token advances past all 3 modifications
5. Only final state is indexed (not intermediate states)

**Result**: Efficient - 3 changes = 1 sync instead of 3 syncs

---

### Case 2: Webhook Delivery Failure

**Problem**: Webhook notification lost due to network issue

**Fallback**:

1. Scheduled sync runs every 6 hours (configurable)
2. Scheduled sync uses delta tokens (not full sync)
3. Catches any changes missed by webhooks
4. No data loss, just delayed sync (6 hours max)

**Best Practice**: Schedule delta sync every 1-6 hours as safety net

---

### Case 3: Token Mismatch

**Problem**: Delta token stored for drive A, but used for drive B

**Prevention**:

```javascript
// Tokens stored with composite key
{
  tenantId + connectorId + driveId: deltaToken
}

// Lookup ensures correct token for correct drive
const token = await DriveDeltaToken.findOne({
  tenantId,
  connectorId,
  driveId  // ← Must match!
});
```

**Result**: Impossible to use wrong token for wrong drive

---

### Case 4: Partial Sync Failure

**Problem**: Delta sync processes 50 items, crashes at item 51

**Recovery**:

1. Delta token **not updated** (transaction-like behavior)
2. Next sync retries from same token
3. Re-processes items 1-50 (idempotent operations)
4. Continues from item 51
5. Only updates token after complete success

**Idempotency**:

```javascript
// Upsert operation (create or update)
SearchDocument.findOneAndUpdate(
  { connectorId, 'metadata.itemId': itemId },
  { $set: { title, url, metadata } },
  { upsert: true },
);
```

Re-processing same item twice has no side effects!

---

## Monitoring & Observability

### Key Metrics

```javascript
// Delta Sync Metrics
{
  connectorId: "conn-xyz",
  syncType: "delta",
  durationMs: 1234,
  itemsProcessed: 23,
  itemsCreated: 5,
  itemsUpdated: 15,
  itemsDeleted: 3,
  itemsSkipped: 0,
  errorsEncountered: 0,
  timestamp: ISODate("2026-02-25T15:00:00Z")
}

// Per-Drive Metrics
{
  driveId: "b!xyz123...",
  lastSyncAt: ISODate("2026-02-25T15:00:00Z"),
  itemsProcessed: 1257,  // Cumulative
  errorCount: 0,
  averageLatencyMs: 1200
}

// Webhook Metrics
{
  notificationsReceived: 145,
  notificationsValidated: 143,
  notificationsRejected: 2,  // Invalid clientState
  batchesProcessed: 12,
  averageBatchSize: 12,
  deltaSyncsTriggered: 8,  // Debouncing prevented 4
  debounceSkips: 4
}
```

---

## Troubleshooting

### Symptom: Changes not appearing

**Diagnosis**:

1. Check webhook subscription status:
   ```bash
   db.webhooksubscriptionconnectors.find({ connectorId: "conn-xyz" })
   ```
2. Check delta tokens exist:
   ```bash
   db.drivedeltattokens.find({ connectorId: "conn-xyz" })
   ```
3. Check last sync time:
   ```bash
   db.connectorconfigs.findOne({ _id: "conn-xyz" }).syncState.lastDeltaSyncAt
   ```
4. Manually trigger delta sync:
   ```bash
   POST /api/connectors/conn-xyz/sync/start
   { "syncType": "delta" }
   ```

**Common Causes**:

- Webhook subscription expired (check `expiresAt`)
- Connector paused (`errorState.isPaused = true`)
- Delta token expired (check `lastSyncAt` > 7 days)
- Debouncing active (wait 30 seconds, try again)

---

### Symptom: Slow delta sync

**Diagnosis**:

1. Check items returned by delta query:
   ```javascript
   // Should be small (0-100)
   deltaResponse.value.length;
   ```
2. If large (>1000), token may be stale
3. Check token age:
   ```javascript
   now() - token.lastSyncAt;
   ```
4. If > 7 days, full resync may be needed

**Solution**: Trigger full sync to get fresh tokens

---

## Best Practices

### 1. Webhook-First, Scheduled Fallback

```javascript
// Primary: Real-time webhooks (instant sync)
webhook.on('notification', () => triggerDeltaSync());

// Fallback: Scheduled delta sync every 6 hours
cron.schedule('0 */6 * * *', () => triggerDeltaSync());
```

### 2. Monitor Token Age

```javascript
// Alert if token not updated in 7 days
if (token.lastSyncAt < Date.now() - 7 * 86400 * 1000) {
  alert('Delta token may be stale, trigger sync');
}
```

### 3. Debounce Aggressively

```javascript
// 30-second window is optimal
// Prevents sync churn during bulk operations
// Still provides <1 minute latency
const DEBOUNCE_WINDOW_MS = 30000;
```

### 4. Batch Webhook Notifications

```javascript
// Process 10 notifications → 1 batch job
// Reduces overhead 10x
// Implemented in webhook receiver
```

### 5. Graceful Degradation

```javascript
// If webhook fails → scheduled sync catches it
// If delta fails → full sync fallback
// If sync fails → pause connector, alert admin
```

---

## Comparison: SharePoint vs Other Sources

| Feature           | SharePoint (Graph API) | Jira                     | Confluence            |
| ----------------- | ---------------------- | ------------------------ | --------------------- |
| Delta Query API   | ✅ Native              | ✅ JQL `updated >= date` | ✅ CQL `lastModified` |
| Delta Token       | ✅ Opaque string       | ❌ Use timestamp         | ❌ Use timestamp      |
| Webhooks          | ✅ Native              | ✅ Native                | ✅ Native             |
| Per-Object Tokens | ✅ Per drive           | ❌ Global                | ❌ Per space          |
| Token Expiry      | 7 days                 | N/A                      | N/A                   |
| Real-time Latency | <15s                   | <30s                     | <30s                  |

**Key Difference**: SharePoint's delta tokens are **opaque** - you can't parse them or construct them. This is both a strength (Microsoft handles complexity) and a weakness (can't debug token issues).

---

## References

- [Microsoft Graph Delta Query](https://learn.microsoft.com/en-us/graph/delta-query-overview)
- [Track Changes for a Drive](https://learn.microsoft.com/en-us/graph/api/driveitem-delta)
- [Change Notifications](https://learn.microsoft.com/en-us/graph/webhooks)
- SharePoint Connector Implementation: `packages/connectors/sharepoint/src/sync/delta-sync-coordinator.ts`
- Delta Token Manager: `packages/connectors/sharepoint/src/delta/delta-token-manager.ts`

---

**Version**: 1.0.0
**Last Updated**: 2026-02-25
**Author**: SharePoint Connector Team

# Search AI Admin API Reference

Administrative endpoints for managing OpenSearch index rotation, capacity monitoring, and archival.

**Base URL:** `/api/admin`

**Authentication:** Admin role required (TODO: wire auth middleware)

---

## Endpoints

### 1. Manual Shared Index Rotation

Force rotation of the active shared index, regardless of capacity threshold.

**Endpoint:** `POST /api/admin/indexes/rotate-shared`

**Request:**

```http
POST /api/admin/indexes/rotate-shared HTTP/1.1
Content-Type: application/json
```

**Response (200 OK):**

```json
{
  "success": true,
  "data": {
    "oldIndex": "search-vectors-v1",
    "newIndex": "search-vectors-v2",
    "oldVersion": 1,
    "newVersion": 2,
    "capacityPercent": 0.45
  }
}
```

**Response (400 Bad Request):**

```json
{
  "success": false,
  "error": {
    "code": "NO_ACTIVE_INDEX",
    "message": "No active shared index found"
  }
}
```

**Use Cases:**

- Proactive rotation before expected load spike
- Maintenance window rotation
- Testing rotation logic

**Example:**

```bash
curl -X POST http://localhost:3005/api/admin/indexes/rotate-shared \
  -H "Content-Type: application/json"
```

---

### 2. Shared Index Status

Get current status of all shared indices, including capacity, version, and app count.

**Endpoint:** `GET /api/admin/indexes/shared/status`

**Request:**

```http
GET /api/admin/indexes/shared/status HTTP/1.1
```

**Response (200 OK):**

```json
{
  "success": true,
  "data": {
    "trackers": [
      {
        "indexName": "search-vectors-v2",
        "version": 2,
        "status": "active",
        "vectorCount": 3500000,
        "capacityPercent": 0.35,
        "maxVectors": 10000000,
        "maxSizeGB": 50,
        "estimatedSizeGB": 14.0,
        "appCount": 87,
        "createdAt": "2026-02-20T10:30:00Z",
        "lastSyncedAt": "2026-02-21T08:15:00Z"
      },
      {
        "indexName": "search-vectors-v1",
        "version": 1,
        "status": "full",
        "vectorCount": 7050000,
        "capacityPercent": 0.705,
        "maxVectors": 10000000,
        "maxSizeGB": 50,
        "estimatedSizeGB": 28.2,
        "appCount": 150,
        "createdAt": "2026-01-15T00:00:00Z",
        "lastSyncedAt": "2026-02-21T08:10:00Z"
      }
    ],
    "activeIndex": {
      "indexName": "search-vectors-v2",
      "version": 2,
      "capacityPercent": 0.35,
      "appCount": 87
    },
    "fullIndices": [
      {
        "indexName": "search-vectors-v1",
        "version": 1,
        "capacityPercent": 0.705,
        "appCount": 150
      }
    ]
  }
}
```

**Use Cases:**

- Monitoring dashboard
- Capacity planning
- Alert threshold checks
- Verify rotation occurred

**Example:**

```bash
curl http://localhost:3005/api/admin/indexes/shared/status | jq
```

**Monitoring Script:**

```bash
#!/bin/bash
# Alert if active index > 80% capacity

STATUS=$(curl -s http://localhost:3005/api/admin/indexes/shared/status)
CAPACITY=$(echo $STATUS | jq '.data.activeIndex.capacityPercent')

if (( $(echo "$CAPACITY > 0.8" | bc -l) )); then
  echo "WARNING: Active index at ${CAPACITY}% capacity"
  # Send alert to monitoring system
fi
```

---

### 3. Archive Shared Index

Archive a full shared index and optionally delete from OpenSearch.

**Endpoint:** `POST /api/admin/indexes/shared/archive/:version`

**Path Parameters:**

- `version` (integer) - Shared index version to archive

**Request Body:**

```json
{
  "deleteFromOpenSearch": true
}
```

**Request:**

```http
POST /api/admin/indexes/shared/archive/1 HTTP/1.1
Content-Type: application/json

{
  "deleteFromOpenSearch": true
}
```

**Response (200 OK):**

```json
{
  "success": true,
  "data": {
    "indexName": "search-vectors-v1",
    "version": 1,
    "deletedFromOpenSearch": true
  }
}
```

**Response (400 Bad Request - Cannot Archive Active):**

```json
{
  "success": false,
  "error": {
    "code": "CANNOT_ARCHIVE_ACTIVE",
    "message": "Cannot archive active index. Rotate first."
  }
}
```

**Response (400 Bad Request - Apps Still Using):**

```json
{
  "success": false,
  "error": {
    "code": "INDEX_IN_USE",
    "message": "Cannot archive index with appCount > 0. 150 apps still using this index."
  }
}
```

**Response (404 Not Found):**

```json
{
  "success": false,
  "error": {
    "code": "INDEX_NOT_FOUND",
    "message": "Shared index version 5 not found"
  }
}
```

**Use Cases:**

- Cleanup old indices after app migration
- Cost optimization (delete unused indices)
- Archival workflow after tenant offboarding

**Constraints:**

- ❌ Cannot archive active index (must rotate first)
- ❌ Cannot archive if `appCount > 0` (apps still using it)

**Example (Archive without deletion):**

```bash
curl -X POST http://localhost:3005/api/admin/indexes/shared/archive/1 \
  -H "Content-Type: application/json" \
  -d '{"deleteFromOpenSearch": false}'
```

**Example (Archive and delete):**

```bash
curl -X POST http://localhost:3005/api/admin/indexes/shared/archive/1 \
  -H "Content-Type: application/json" \
  -d '{"deleteFromOpenSearch": true}'
```

---

## Security Considerations

### Current State

⚠️ **WARNING:** Admin routes currently have `TODO` comments for permission checks.

```typescript
// TODO: Add admin permission check when auth is wired
// requirePermission(req, 'admin:indexes:rotate');
```

### Before Production

**Required:**

1. Add authentication middleware to `/api/admin/*` routes
2. Implement `requirePermission('admin:indexes:*')` checks
3. Log all admin actions with caller identity to audit store
4. Rate limit admin endpoints (prevent abuse)

**Permissions:**

- `admin:indexes:rotate` - Manual rotation
- `admin:indexes:read` - Status monitoring
- `admin:indexes:archive` - Archive indices

---

## Error Codes

| Code                    | HTTP Status | Description                                    |
| ----------------------- | ----------- | ---------------------------------------------- |
| `NO_ACTIVE_INDEX`       | 400         | No active shared index found (rotation failed) |
| `CANNOT_ARCHIVE_ACTIVE` | 400         | Attempted to archive active index              |
| `INDEX_IN_USE`          | 400         | Index has appCount > 0, cannot archive         |
| `INDEX_NOT_FOUND`       | 404         | Shared index version not found                 |
| `INTERNAL_ERROR`        | 500         | Unexpected server error                        |

---

## Operational Workflows

### Proactive Rotation Before Load Spike

If you expect a large influx of new apps (e.g., batch onboarding):

```bash
# 1. Check current capacity
curl http://localhost:3005/api/admin/indexes/shared/status | jq '.data.activeIndex'

# 2. If close to threshold, rotate early
curl -X POST http://localhost:3005/api/admin/indexes/rotate-shared

# 3. Verify new active index created
curl http://localhost:3005/api/admin/indexes/shared/status | jq '.data.activeIndex'
```

### Archive Old Index After Migration

After migrating apps from old shared index to dedicated indices:

```bash
# 1. Check if index is empty
curl http://localhost:3005/api/admin/indexes/shared/status | jq '.data.trackers[] | select(.version == 1)'

# 2. If appCount = 0, archive
curl -X POST http://localhost:3005/api/admin/indexes/shared/archive/1 \
  -H "Content-Type: application/json" \
  -d '{"deleteFromOpenSearch": true}'
```

### Monitoring & Alerting

**Prometheus Metrics (Future):**

```
# HELP opensearch_shared_index_capacity_percent Active shared index capacity
# TYPE opensearch_shared_index_capacity_percent gauge
opensearch_shared_index_capacity_percent{version="2"} 0.35

# HELP opensearch_shared_index_app_count Apps per shared index
# TYPE opensearch_shared_index_app_count gauge
opensearch_shared_index_app_count{version="2",status="active"} 87
opensearch_shared_index_app_count{version="1",status="full"} 150
```

**Alert Rules:**

```yaml
groups:
  - name: opensearch_capacity
    rules:
      - alert: SharedIndexHighCapacity
        expr: opensearch_shared_index_capacity_percent > 0.8
        for: 5m
        annotations:
          summary: 'Shared index at {{ $value }}% capacity'

      - alert: SharedIndexCriticalCapacity
        expr: opensearch_shared_index_capacity_percent > 0.9
        for: 1m
        annotations:
          summary: 'CRITICAL: Shared index at {{ $value }}% capacity'
```

---

## Cost Estimation

### Storage per Shared Index

- **10M vectors × 4KB = 40GB raw**
- **With compression (~40%): 24GB**
- **With replica: 48GB total**

### Rotation Frequency

- **Small deployment:** 1-2 rotations per year
- **Medium deployment:** 3-4 rotations per year
- **Large deployment:** 6-12 rotations per year

### Cost per Rotation

- **Old index:** Remains in OpenSearch (apps still using)
- **New index:** Created empty (grows over time)
- **Archival:** Once old index has `appCount = 0`, can delete to save cost

---

## See Also

- [ATLAS-KG-ARCHITECTURE.md](./ATLAS-KG-ARCHITECTURE.md) - System architecture overview
- [OPENSEARCH-FIELD-SCHEMA-REFERENCE.md](./design/OPENSEARCH-FIELD-SCHEMA-REFERENCE.md) - Field mappings and queries
- [RFC-002-OpenSearch-Index-Strategy.md](../rfcs/RFC-002-OpenSearch-Index-Strategy.md) - Original design RFC

---

## Implementation Details

**Admin Routes:** `apps/search-ai/src/routes/admin.ts`

**Index Registry:** `packages/search-ai-internal/src/vector-store/index-registry.ts`

**Functions:**

- `forceRotateSharedIndex()` - Manual rotation
- `getActiveSharedIndex()` - Get active tracker
- `syncSharedIndexStats()` - Sync capacity from OpenSearch

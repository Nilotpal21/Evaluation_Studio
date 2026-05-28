# Error Tracking and Retry System

The search-ai pipeline includes comprehensive error tracking and automatic retry mechanisms for transient failures.

## Overview

The error tracking system provides:

1. **Automatic Retry**: Transient failures (network timeouts, rate limits) are automatically retried 3 times with exponential backoff
2. **Error Aggregation**: All pipeline errors are logged to document records and queryable via REST API
3. **Manual Retry**: Failed documents can be manually retried through the admin API
4. **Error Analytics**: Aggregate error statistics by index, error type, and time window

## Automatic Retry Configuration

All pipeline workers use standard retry options for transient failures:

- **Attempts**: 3 retries
- **Backoff**: Exponential, starting at 5 seconds
- **Delays**: 5s, 10s, 20s (exponential progression)

### Standard Retry Options

Workers use the shared `createRetryOptions()` helper from `src/workers/shared.ts`:

```typescript
import { createRetryOptions } from './shared.js';

// Enqueue job with standard retry (3 attempts, 5s initial delay)
await embeddingQueue.add('embed-chunks', jobData, createRetryOptions());

// Custom retry (2 attempts, 10s initial delay)
await enrichmentQueue.add('enrich-doc', jobData, createRetryOptions(2, 10_000));
```

### Workers with Retry Logic

All pipeline workers implement retry for downstream job enqueueing:

**Phase 1: Ingestion & Extraction**

- `ingestion-worker` → retries extraction job creation
- `extraction-worker` → retries page processing job creation
- `docling-extraction-worker` → retries downstream worker job creation

**Phase 2: Page Processing**

- `page-processing-worker` → retries noise detection, canonical map, question synthesis job creation

**Phase 3: Visual Enrichment**

- `visual-enrichment-worker` → retries document-level enrichment job creation

**Phase 4: Parallel Workers**

- `enrichment-worker` → retries embedding job creation
- `knowledge-graph-worker` → retries downstream job creation
- `embedding-worker` → retries index update operations

## Error Logging

Errors are logged at multiple levels:

### 1. Document-Level Errors

When a document fails processing, the error is stored in the `SearchDocument` model:

```typescript
document.status = DocumentStatus.ERROR;
document.processingError = error.message;
document.updatedAt = new Date();
await document.save();
```

Fields:

- `status`: Set to `ERROR` (from `DocumentStatus` enum)
- `processingError`: Full error message including stack trace
- `updatedAt`: Timestamp of when the error occurred

### 2. Console Logging

All workers use standard logging helpers from `shared.ts`:

```typescript
import { workerLog, workerError } from './shared.js';

// Info logging
workerLog('enrichment', 'Processing document', { documentId, chunkCount });

// Error logging
workerError('enrichment', 'Failed to enrich document', error);
```

Error logs include:

- Worker name
- Error message
- Stack trace (if available)
- Contextual metadata (document ID, index ID, etc.)

## Error Aggregation API

Query and analyze pipeline errors through the admin API.

### Base URL

All error tracking endpoints are under:

```
http://localhost:3100/api/admin/errors
```

### Endpoints

#### 1. Query Errors

```
GET /api/admin/errors
```

Query documents with processing errors. Supports filtering and pagination.

**Query Parameters:**

| Parameter | Type     | Description             | Default |
| --------- | -------- | ----------------------- | ------- |
| `indexId` | string   | Filter by index ID      | -       |
| `since`   | ISO 8601 | Start time              | -       |
| `until`   | ISO 8601 | End time                | -       |
| `limit`   | number   | Max results (max: 1000) | 100     |
| `offset`  | number   | Skip results            | 0       |

**Response:**

```json
{
  "success": true,
  "errors": [
    {
      "documentId": "65f1234567890abcdef12345",
      "indexId": "index-123",
      "tenantId": "tenant-456",
      "status": "error",
      "error": "Failed to extract content: Connection timeout",
      "timestamp": "2026-02-24T10:30:00.000Z",
      "metadata": {
        "source": "document.pdf",
        "crawlJobId": "job-789"
      }
    }
  ],
  "total": 42,
  "limit": 100,
  "offset": 0
}
```

**Examples:**

```bash
# Get all errors from last hour
curl "http://localhost:3100/api/admin/errors?since=2026-02-24T09:00:00Z"

# Get errors for specific index
curl "http://localhost:3100/api/admin/errors?indexId=index-123&limit=50"

# Paginate through errors
curl "http://localhost:3100/api/admin/errors?offset=100&limit=100"
```

#### 2. Error Statistics

```
GET /api/admin/errors/stats
```

Get aggregated error statistics by index, error type, and time window.

**Query Parameters:**

| Parameter | Type     | Description        | Default      |
| --------- | -------- | ------------------ | ------------ |
| `indexId` | string   | Filter by index ID | -            |
| `since`   | ISO 8601 | Start time         | 24 hours ago |
| `until`   | ISO 8601 | End time           | now          |

**Response:**

```json
{
  "success": true,
  "stats": {
    "total": 42,
    "byIndex": {
      "index-123": 30,
      "index-456": 12
    },
    "byErrorType": {
      "Failed to extract content: Connection timeout": 15,
      "Network error: ECONNREFUSED": 10,
      "Rate limit exceeded": 8,
      "Invalid PDF format": 9
    },
    "recentErrors": [
      {
        "documentId": "65f1234567890abcdef12345",
        "indexId": "index-123",
        "error": "Failed to extract content: Connection timeout",
        "timestamp": "2026-02-24T10:30:00.000Z"
      }
    ]
  },
  "timeWindow": {
    "since": "2026-02-23T10:30:00.000Z",
    "until": "2026-02-24T10:30:00.000Z"
  }
}
```

**Examples:**

```bash
# Get error stats for last 24 hours (default)
curl "http://localhost:3100/api/admin/errors/stats"

# Get error stats for specific time window
curl "http://localhost:3100/api/admin/errors/stats?since=2026-02-20T00:00:00Z&until=2026-02-24T00:00:00Z"

# Get error stats for specific index
curl "http://localhost:3100/api/admin/errors/stats?indexId=index-123"
```

#### 3. Retry Failed Document

```
POST /api/admin/errors/:documentId/retry
```

Manually retry a failed document by resetting its status to PENDING.

**Response:**

```json
{
  "success": true,
  "documentId": "65f1234567890abcdef12345",
  "previousStatus": "error",
  "newStatus": "pending",
  "message": "Document reset to PENDING for retry"
}
```

**Error Responses:**

```json
// Document not found
{
  "success": false,
  "error": {
    "code": "DOCUMENT_NOT_FOUND",
    "message": "Document 65f1234567890abcdef12345 not found"
  }
}

// Document not in ERROR status
{
  "success": false,
  "error": {
    "code": "DOCUMENT_NOT_FAILED",
    "message": "Document 65f1234567890abcdef12345 is not in ERROR status (current: indexed)"
  }
}
```

**Examples:**

```bash
# Retry a failed document
curl -X POST "http://localhost:3100/api/admin/errors/65f1234567890abcdef12345/retry"

# With auth header (when auth is enabled)
curl -X POST "http://localhost:3100/api/admin/errors/65f1234567890abcdef12345/retry" \
  -H "Authorization: Bearer <token>"
```

## Common Error Types

### 1. Transient Errors (Retryable)

These errors are automatically retried 3 times:

- **Network timeouts**: `Connection timeout`, `ETIMEDOUT`, `ECONNRESET`
- **Rate limits**: `429 Too Many Requests`, `Rate limit exceeded`
- **Service unavailable**: `503 Service Unavailable`, `ECONNREFUSED`
- **Temporary failures**: `Temporary failure`, `Try again`

### 2. Permanent Errors (Not Retryable)

These errors fail immediately without retry:

- **Invalid data**: `Invalid PDF format`, `Corrupt file`, `Unsupported format`
- **Authentication errors**: `401 Unauthorized`, `403 Forbidden`
- **Resource not found**: `404 Not Found`, `File not found`
- **Bad request**: `400 Bad Request`, `Invalid parameter`

## Troubleshooting

### High Error Rate

If error stats show high error counts:

1. **Check error types**: Use `/api/admin/errors/stats` to see which errors are most common
2. **Check queue health**: Use Bull Board UI (`/api/admin/queues/ui`) to inspect failed jobs
3. **Review worker logs**: Check console logs for detailed error messages
4. **Check external services**: Verify network connectivity, API keys, service status

### Bulk Retry

To retry multiple failed documents:

1. Query failed documents:

   ```bash
   curl "http://localhost:3100/api/admin/errors?indexId=index-123&limit=1000" > errors.json
   ```

2. Extract document IDs and retry in batch:
   ```bash
   jq -r '.errors[].documentId' errors.json | while read docId; do
     curl -X POST "http://localhost:3100/api/admin/errors/$docId/retry"
   done
   ```

### Monitoring Error Trends

Set up periodic monitoring to track error trends:

```bash
#!/bin/bash
# error-monitoring.sh - Run every hour via cron

STATS=$(curl -s "http://localhost:3100/api/admin/errors/stats")
TOTAL=$(echo $STATS | jq '.stats.total')
CRITICAL_THRESHOLD=100

if [ $TOTAL -gt $CRITICAL_THRESHOLD ]; then
  echo "ALERT: High error count detected: $TOTAL errors in last 24h"
  # Send alert to Slack, PagerDuty, etc.
fi
```

## Best Practices

1. **Monitor error stats regularly**: Set up dashboards or alerts for error trends
2. **Investigate recurring errors**: Use error aggregation to identify systemic issues
3. **Tune retry parameters**: Adjust attempts and delays based on error patterns
4. **Implement circuit breakers**: For repeated failures to external services
5. **Clean up old errors**: Archive or delete error documents after resolution

## Configuration

Retry configuration can be customized per worker:

```typescript
// Default retry options (3 attempts, 5s initial delay)
createRetryOptions();

// Custom attempts
createRetryOptions(5); // 5 attempts, 5s initial delay

// Custom delay
createRetryOptions(3, 10_000); // 3 attempts, 10s initial delay

// No retry (for testing or non-transient operations)
{
} // No retry options
```

## Related Documentation

- [Queue Monitoring](./QUEUE-MONITORING.md) - Bull Board UI and queue health monitoring
- [Worker Architecture](./WORKERS.md) - Pipeline worker design and flow
- [Status Transitions](./docs/rfcs/RFC-001-MASTER-TASK-LIST.md) - Document status lifecycle

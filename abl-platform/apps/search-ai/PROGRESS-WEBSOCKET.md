# Real-Time Progress WebSocket API

WebSocket endpoint for streaming live crawl job progress updates.

## Endpoint

```
WS /api/admin/progress/subscribe?jobId={crawlJobId}
```

## Features

- ✅ Real-time progress streaming for crawl jobs
- ✅ Redis pub/sub for multi-pod scalability
- ✅ Automatic reconnection support
- ✅ Progress percentage and ETA calculation
- ✅ Error event streaming
- ✅ Per-job subscription isolation

---

## Connection

### WebSocket URL

```javascript
const ws = new WebSocket('ws://localhost:3005/api/admin/progress/subscribe?jobId=job-123');
```

### Query Parameters

| Parameter | Required | Description                  |
| --------- | -------- | ---------------------------- |
| `jobId`   | Yes      | Crawl job ID to subscribe to |

### Connection Events

**Connected:**

```json
{
  "type": "connected",
  "jobId": "job-123",
  "timestamp": "2026-02-24T01:00:00.000Z"
}
```

**Error:**

```json
{
  "type": "error",
  "error": {
    "code": "MISSING_JOB_ID",
    "message": "Query parameter jobId is required"
  }
}
```

---

## Event Types

### 1. Job Started

Emitted when crawl job begins processing.

```json
{
  "type": "job_started",
  "jobId": "job-123",
  "timestamp": "2026-02-24T01:00:00.000Z",
  "data": {
    "progress": {
      "total": 100,
      "completed": 0,
      "failed": 0,
      "percentage": 0
    }
  }
}
```

### 2. URL Fetched

Emitted when a URL is successfully fetched from the crawler.

```json
{
  "type": "url_fetched",
  "jobId": "job-123",
  "timestamp": "2026-02-24T01:00:05.000Z",
  "data": {
    "url": "https://example.com/page1",
    "progress": {
      "total": 100,
      "completed": 1,
      "failed": 0,
      "percentage": 1
    }
  }
}
```

### 3. Document Processed

Emitted when a document is extracted, enriched, and saved to MongoDB.

```json
{
  "type": "document_processed",
  "jobId": "job-123",
  "timestamp": "2026-02-24T01:00:10.000Z",
  "data": {
    "documentId": "doc-456",
    "url": "https://example.com/page1",
    "progress": {
      "total": 100,
      "completed": 5,
      "failed": 0,
      "percentage": 5
    }
  }
}
```

### 4. Chunk Created

Emitted when a document chunk is created and embedded.

```json
{
  "type": "chunk_created",
  "jobId": "job-123",
  "timestamp": "2026-02-24T01:00:15.000Z",
  "data": {
    "chunkId": "chunk-789",
    "documentId": "doc-456",
    "progress": {
      "total": 100,
      "completed": 10,
      "failed": 0,
      "percentage": 10
    }
  }
}
```

### 5. Job Completed

Emitted when all URLs have been processed and the job is complete.

```json
{
  "type": "job_completed",
  "jobId": "job-123",
  "timestamp": "2026-02-24T01:10:00.000Z",
  "data": {
    "progress": {
      "total": 100,
      "completed": 95,
      "failed": 5,
      "percentage": 100
    }
  }
}
```

### 6. Error

Emitted when an error occurs during processing.

```json
{
  "type": "error",
  "jobId": "job-123",
  "timestamp": "2026-02-24T01:00:20.000Z",
  "data": {
    "url": "https://example.com/broken",
    "error": {
      "message": "Failed to fetch URL: 404 Not Found",
      "code": "FETCH_ERROR"
    },
    "progress": {
      "total": 100,
      "completed": 10,
      "failed": 1,
      "percentage": 10
    }
  }
}
```

---

## Client Example (JavaScript)

```javascript
const jobId = 'job-123';
const ws = new WebSocket(`ws://localhost:3005/api/admin/progress/subscribe?jobId=${jobId}`);

ws.onopen = () => {
  console.log('WebSocket connected');
};

ws.onmessage = (event) => {
  const message = JSON.parse(event.data);

  switch (message.type) {
    case 'connected':
      console.log('Subscribed to job:', message.jobId);
      break;

    case 'url_fetched':
      console.log(`Fetched ${message.data.url} (${message.data.progress.percentage}%)`);
      break;

    case 'document_processed':
      console.log(`Processed document ${message.data.documentId}`);
      break;

    case 'chunk_created':
      console.log(`Created chunk ${message.data.chunkId}`);
      break;

    case 'job_completed':
      console.log('Job completed!', message.data.progress);
      ws.close();
      break;

    case 'error':
      console.error('Error:', message.data.error);
      break;

    default:
      console.log('Unknown event type:', message.type);
  }
};

ws.onerror = (error) => {
  console.error('WebSocket error:', error);
};

ws.onclose = (event) => {
  console.log('WebSocket closed:', event.code, event.reason);
};
```

---

## Client Example (React)

```typescript
import { useEffect, useState } from 'react';

interface ProgressData {
  total: number;
  completed: number;
  failed: number;
  percentage: number;
}

function useCrawlProgress(jobId: string) {
  const [progress, setProgress] = useState<ProgressData | null>(null);
  const [status, setStatus] = useState<'connecting' | 'connected' | 'disconnected'>('connecting');
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    const ws = new WebSocket(`ws://localhost:3005/api/admin/progress/subscribe?jobId=${jobId}`);

    ws.onopen = () => {
      setStatus('connected');
    };

    ws.onmessage = (event) => {
      const message = JSON.parse(event.data);

      if (message.data?.progress) {
        setProgress(message.data.progress);
      }

      if (message.type === 'error') {
        setError(message.data.error.message);
      }

      if (message.type === 'job_completed') {
        ws.close();
      }
    };

    ws.onerror = () => {
      setStatus('disconnected');
      setError('Connection error');
    };

    ws.onclose = () => {
      setStatus('disconnected');
    };

    return () => {
      ws.close();
    };
  }, [jobId]);

  return { progress, status, error };
}

// Usage:
function CrawlMonitor({ jobId }: { jobId: string }) {
  const { progress, status, error } = useCrawlProgress(jobId);

  if (status === 'connecting') return <div>Connecting...</div>;
  if (error) return <div>Error: {error}</div>;
  if (!progress) return <div>Waiting for updates...</div>;

  return (
    <div>
      <div>Progress: {progress.percentage}%</div>
      <div>Completed: {progress.completed}/{progress.total}</div>
      <div>Failed: {progress.failed}</div>
      <progress value={progress.percentage} max={100} />
    </div>
  );
}
```

---

## Publishing Events (Server-Side)

Workers can publish progress events using the `publishProgressEvent` helper:

```typescript
import { publishProgressEvent } from './routes/progress.js';

// In a worker:
await publishProgressEvent({
  type: 'document_processed',
  jobId: job.data.jobId,
  timestamp: new Date().toISOString(),
  data: {
    documentId: document._id.toString(),
    url: document.url,
    progress: {
      total: 100,
      completed: processedCount,
      failed: failedCount,
      percentage: Math.round((processedCount / 100) * 100),
    },
  },
});
```

---

## Architecture

### Redis Pub/Sub

- Each job has a dedicated Redis channel: `progress:{jobId}`
- Workers publish events to this channel
- WebSocket server subscribes to the channel and forwards to clients
- Supports multiple pods (horizontally scalable)

### Connection Lifecycle

1. Client connects to WebSocket endpoint with `jobId` query parameter
2. Server validates `jobId` and creates Redis subscriber
3. Server subscribes to `progress:{jobId}` Redis channel
4. Server sends `connected` event to client
5. Workers publish progress events to Redis channel
6. Server forwards events to all connected clients for that job
7. Client disconnects → Redis subscriber is cleaned up

### Keepalive

- Server sends WebSocket `ping` every 30 seconds
- Client should respond with `pong` (automatic in most libraries)
- Connection closed if client doesn't respond to pings

---

## Error Codes

| Code                    | Description                          |
| ----------------------- | ------------------------------------ |
| `MISSING_JOB_ID`        | jobId query parameter not provided   |
| `REDIS_SUBSCRIBE_ERROR` | Failed to subscribe to Redis channel |
| `FETCH_ERROR`           | Failed to fetch URL from crawler     |
| `PROCESSING_ERROR`      | Error during document processing     |
| `EMBEDDING_ERROR`       | Error during chunk embedding         |

---

## Testing

Run tests with:

```bash
pnpm test src/routes/__tests__/progress.test.ts
```

Tests cover:

- Connection without jobId (rejected)
- Successful connection with jobId
- Receiving published events
- Multiple concurrent connections
- Job completion events
- Error events

---

## Monitoring

Check active WebSocket connections:

```bash
curl http://localhost:3005/api/admin/queues/health
```

Response includes:

```json
{
  "websocket": {
    "activeSubscriptions": 5
  }
}
```

---

## Future Enhancements

- [ ] Authentication/authorization for WebSocket connections
- [ ] ETA calculation based on processing rate
- [ ] Reconnection with event replay (last N events from Redis)
- [ ] Rate limiting per client
- [ ] Compression for large event payloads
- [ ] Metrics per job (throughput, latency, error rate)

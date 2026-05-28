# Queue Monitoring

The search-ai service includes comprehensive queue monitoring capabilities through both programmatic APIs and a visual UI.

## Bull Board UI

Bull Board provides a web-based UI for inspecting BullMQ queues in real-time.

### Accessing the UI

The Bull Board UI is mounted at:

```
http://localhost:3100/api/admin/queues/ui
```

### Features

- **Real-time Queue Stats**: View waiting, active, completed, failed, and delayed job counts for all queues
- **Job Inspection**: Click into individual jobs to see their data, progress, logs, and stacktraces
- **Job Management**: Retry failed jobs, promote delayed jobs, or clean completed jobs
- **Queue-by-Queue View**: Monitor each queue separately with dedicated tabs

### Monitored Queues

Bull Board tracks all search-ai pipeline queues:

**Phase 1: Ingestion & Extraction**

- `search-ingestion` - Document ingestion
- `search-extraction` - Content extraction
- `search-docling-extraction` - Docling-based extraction

**Phase 2: Page Processing & Text Analysis**

- `search-page-processing` - Page-level processing
- `search-noise-detection` - Noise/boilerplate removal
- `search-canonical-map` - Canonical metadata mapping
- `search-question-synthesis` - Question generation

**Phase 3: Visual Enrichment**

- `search-visual-enrichment` - Visual content enrichment

**Phase 4: Parallel Workers**

- `search-enrichment` - Document enrichment
- `search-knowledge-graph` - Knowledge graph extraction
- `search-embedding` - Vector embedding generation

**Optional Workers**

- `search-tree-building` - Tree structure building
- `search-multimodal` - Multimodal processing
- `search-scope-classification` - Scope classification
- `search-cleanup` - Cleanup operations

## Programmatic APIs

In addition to the UI, you can query queue stats and health programmatically.

### Get Queue Stats

```
GET /api/admin/queues/stats
```

Returns current counts for all queues (waiting, active, completed, failed, delayed).

**Response:**

```json
{
  "success": true,
  "timestamp": "2026-02-24T00:15:00.000Z",
  "queues": [
    {
      "queueName": "search-ingestion",
      "waiting": 10,
      "active": 5,
      "completed": 100,
      "failed": 2,
      "delayed": 0,
      "total": 117,
      "timestamp": "2026-02-24T00:15:00.000Z"
    },
    ...
  ]
}
```

### Get Queue Health

```
GET /api/admin/queues/health
```

Returns health assessment (healthy, degraded, critical) based on queue backlog and failure rate.

**Response:**

```json
{
  "success": true,
  "timestamp": "2026-02-24T00:15:00.000Z",
  "summary": {
    "total": 15,
    "healthy": 13,
    "degraded": 2,
    "critical": 0,
    "overallStatus": "degraded"
  },
  "queues": [
    {
      "queueName": "search-ingestion",
      "status": "healthy",
      "waiting": 10,
      "active": 5,
      "failed": 2,
      "issues": [],
      "timestamp": "2026-02-24T00:15:00.000Z"
    },
    ...
  ]
}
```

### Trigger On-Demand Monitoring

```
POST /api/admin/queues/monitor
```

Logs current queue stats and health to the console.

**Response:**

```json
{
  "success": true,
  "message": "Queue monitoring logged to console",
  "timestamp": "2026-02-24T00:15:00.000Z"
}
```

## Health Thresholds

Queue health is assessed based on these thresholds:

- **Healthy**:
  - Waiting < 100 jobs
  - Failed < 10 jobs

- **Degraded**:
  - Waiting >= 100 and < 1000 jobs
  - Failed >= 10 and < 50 jobs

- **Critical**:
  - Waiting >= 1000 jobs
  - Failed >= 50 jobs

## Troubleshooting

### Queue Backlog

If a queue shows high waiting counts:

1. Check Bull Board UI to inspect queued jobs
2. Verify workers are running (`docker logs` or process logs)
3. Check Redis connectivity
4. Scale workers if needed (increase concurrency or add replicas)

### Failed Jobs

For jobs in failed state:

1. Click into failed jobs in Bull Board to see error stacktraces
2. Check if errors are transient (network, rate limits) or permanent (bad data)
3. Use Bull Board to retry failed jobs after fixing underlying issues
4. Consider implementing automatic retry logic with exponential backoff

### Queue Stalled

If jobs are stuck in active state:

1. Check if workers are still alive
2. Verify worker logs for crashes or hangs
3. Restart workers if needed
4. Bull Board can manually move stalled jobs back to waiting state

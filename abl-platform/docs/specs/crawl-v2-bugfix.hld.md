# Crawl V2 Progress Bug Fixes — High-Level Design

## What

Fix 7 confirmed bugs in the Crawl V2 progress pipeline that cause the UI to display "0/0/0 completed" even when the backend successfully crawls all pages. The root cause is a data shape mismatch between what the bulk-crawl worker publishes and what the frontend reads, compounded by missing REST fallback, incorrect event types, and URL pagination gaps.

## Bug Inventory

| #   | Bug                                                                                     | Severity | Root File(s)                                              |
| --- | --------------------------------------------------------------------------------------- | -------- | --------------------------------------------------------- |
| 1   | Worker always emits `job_completed` event type regardless of finalStatus                | HIGH     | `bulk-crawl-worker.ts:752`                                |
| 2   | Data shape mismatch: worker sends `data.summary.*` but frontend reads `data.progress.*` | CRITICAL | `bulk-crawl-worker.ts:752-772`, `State4Crawl.tsx:309-313` |
| 3   | `useMultiPageProgress` ignores bulk events (`url_fetched`, `job_completed`)             | LOW      | `useMultiPageProgress.ts:78-90`                           |
| 4   | `getSectionUrls` capped at 100/request, frontend doesn't paginate                       | MEDIUM   | `crawl-drafts.ts:815`, `CrawlFlowV5.tsx:643`              |
| 5   | WebSocket doesn't work through Next.js dev proxy                                        | MEDIUM   | `proxy.ts:316-320`                                        |
| 6   | No event replay on WS connect — late joiner sees stale state                            | MEDIUM   | `progress.ts:304-311`                                     |
| 7   | REST polling fallback just retries WS, never polls REST                                 | HIGH     | `State4Crawl.tsx:359-381`                                 |

## Architecture Approach

### Packages Changed

- `apps/search-ai` — Worker event emission fixes (T-1), REST status endpoint (T-5), WS event replay (T-4)
- `apps/studio` — Frontend progress hook fixes (T-2), URL pagination (T-3), REST polling (T-5), dev proxy (T-6)

### Data Flow (Fixed)

```
Worker (bulk-crawl-worker.ts)
  │
  ├─ url_fetched {data: {url, progress: {total, completed, failed, percentage}}}  ← T-1: ADD progress
  ├─ url_skipped {data: {url, skipReason, progress: {...}}}                       ← T-1: ADD progress
  ├─ job_completed {data: {progress: {...}, summary: {...}}}                      ← T-1: ADD progress, KEEP summary
  └─ job_failed {data: {error, progress: {...}}}                                  ← T-1: USE job_failed for zero-crawled AND cancelled
  │
  ▼ Redis pub/sub channel: progress:{jobId}
  │
  ├─► WebSocket Server (progress.ts)
  │     ├─ On connect: send cached last event from Redis               ← T-4: Event replay
  │     └─ Forward all events to connected clients
  │
  └─► REST Status (GET /api/crawl/status?jobId=)                      ← T-5: Already exists
        └─ Returns CrawlJob {status, urls.crawled, urls.failed}
  │
  ▼ Browser
  │
  ├─ useCrawlProgress hook
  │    ├─ Accumulates events, tracks lastEvent
  │    └─ NEW: derives pagesCompleted/pagesFailed/pagesTotal from      ← T-2: Process bulk events
  │         lastEvent.data.progress (now present in all bulk events)
  │
  ├─ State4Crawl.tsx
  │    ├─ Reads progress from crawlProgress.lastEvent.data.progress    ← T-2: Now populated
  │    ├─ isDone: job_completed || job_failed                          ← T-2: Handle all terminal types
  │    ├─ Section fill: derive from url_fetched events per-section     ← T-2: Track per-section
  │    └─ REST fallback: poll GET /api/crawl/status every 10s          ← T-5: Real REST polling
  │
  └─ CrawlFlowV5.tsx
       └─ getSectionUrls: paginate through all buckets                 ← T-3: Pagination loop
```

### Key Integration Points

1. **Worker → ProgressEvent shape**: Worker must include `data.progress` on every `url_fetched` and terminal event
2. **Worker → Event type accuracy**: `job_failed` when no pages crawled OR cancelled (with error code distinguishing cause)
3. **WS Server → Redis cache**: Store last event per job in Redis for replay on reconnect
4. **Frontend → REST fallback**: Use existing `GET /api/crawl/status` endpoint when WS is unavailable
5. **Frontend → URL pagination**: Loop `getSectionUrls` with offset/limit until all URLs collected

## Decisions & Tradeoffs

- **Decision 1**: Fix worker to include `data.progress` rather than changing frontend to read `data.summary` — because `data.progress` is the established contract used by all other progress consumers (connectors, intelligence crawl), and the `ProgressEvent` interface already defines it.

- **Decision 2**: Keep `useMultiPageProgress` intelligence-only (don't add bulk events) — it was designed for per-page LLM analysis tracking. Bulk crawl progress is better served by `useCrawlProgress` which already receives all events. BUG 3 is LOW severity and by-design.

- **Decision 3**: Use Redis `SET` with TTL for event replay cache rather than MongoDB — events are ephemeral progress data, Redis is already the transport layer, and we only need the last event per job (not full history). TTL of 1 hour matches the cancel signal TTL.

- **Decision 4**: Use existing `GET /api/crawl/status` for REST polling rather than creating a new endpoint — it already returns `state`, `progress`, and terminal status from MongoDB. Just need to enhance the frontend to use it.

- **Decision 5**: Add incremental `data.progress` to each `url_fetched` event (running totals) — allows the frontend to show live progress without needing to accumulate events itself. The worker already tracks `crawledCount`/`failedCount`/`skippedCount`.

- **Decision 6**: For BUG 5 (dev proxy), add a direct-connect fallback URL to search-ai port (3005) when WS upgrade fails on the dev server — this is a DX improvement only, production uses NGINX which handles WS upgrades natively.

## Task Decomposition

| Task | Package(s)         | Independent? | Est. Files | Description                                                       |
| ---- | ------------------ | ------------ | ---------- | ----------------------------------------------------------------- |
| T-1  | search-ai          | Yes          | 2          | Fix worker event types and add `data.progress` to all bulk events |
| T-2  | studio             | No (T-1)     | 2          | Fix State4Crawl progress reading and terminal state detection     |
| T-3  | studio             | Yes          | 2          | Add pagination loop for `getSectionUrls` in CrawlFlowV5           |
| T-4  | search-ai          | Yes          | 1          | Add event replay cache in WS server for late joiners              |
| T-5  | studio             | No (T-1)     | 2          | Add real REST polling fallback using GET /api/crawl/status        |
| T-6  | studio             | Yes          | 1          | Add direct-connect WS URL for dev mode                            |
| T-7  | search-ai + studio | No (T-1,T-2) | 3-4        | Unit + integration tests for all fixes                            |

### Wave Structure

```
Wave 1 (parallel): T-1 (worker fixes), T-3 (URL pagination), T-4 (event replay), T-6 (dev proxy)
Wave 2 (sequential, depends on T-1): T-2 (frontend progress), T-5 (REST fallback)
Wave 3 (depends on all): T-7 (tests)
```

## Out of Scope

- Rewriting `useMultiPageProgress` to handle bulk events (BUG 3 is by-design, LOW)
- Adding per-URL progress to the REST status endpoint (WS handles real-time, REST is fallback)
- Fixing the dual WebSocket connection pattern (optimization, not a bug)
- Production WS proxy issues (NGINX handles this correctly)

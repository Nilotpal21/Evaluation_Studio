# Crawl V2 Progress Bug Fixes — Low-Level Design

## Task T-1: Fix Worker Event Types and Add `data.progress` (search-ai)

### Files to Modify

- `apps/search-ai/src/workers/bulk-crawl-worker.ts` — Fix event types and add `data.progress` to all emitted events

### Subtasks

1. **ST-1.1**: Add `data.progress` to each `url_fetched` (success) event at line 592.
   Add running totals:

   ```typescript
   progress: {
     total: urls.length,
     completed: crawledCount,
     failed: failedCount,
     percentage: urls.length > 0 ? Math.round((crawledCount / urls.length) * 100) : 0,
   },
   ```

2. **ST-1.2**: Add `data.progress` to each `url_fetched` (failure) event at line 614.
   Same shape with current running totals.

3. **ST-1.3**: Move `url_skipped` emission from `processUrl()` (line 217) to the main loop (after line 573 where `result.skipped` is checked). This puts it in scope of `crawledCount`/`failedCount`/`skippedCount` running totals. Add `data.progress`:

   ```typescript
   if (result.skipped) {
     skippedCount++;
     await publishProgressEvent({
       type: 'url_skipped',
       jobId,
       timestamp: new Date().toISOString(),
       data: {
         url,
         skipReason: result.skipReason ?? 'robots.txt',
         progress: {
           total: urls.length,
           completed: crawledCount,
           failed: failedCount,
           percentage: urls.length > 0 ? Math.round((crawledCount / urls.length) * 100) : 0,
         },
       },
     });
     continue;
   }
   ```

   Remove the `publishProgressEvent` call from `processUrl()` at line 217-222 since it's now handled in the main loop.

4. **ST-1.4**: Fix terminal event at line 752. Change from always `job_completed` to:

   ```typescript
   const terminalType = cancelled
     ? 'job_failed'
     : crawledCount > 0
       ? 'job_completed'
       : 'job_failed';
   ```

   Add `data.progress` alongside existing `data.summary`:

   ```typescript
   await publishProgressEvent({
     type: terminalType,
     jobId,
     timestamp: new Date().toISOString(),
     data: {
       progress: {
         total: urls.length,
         completed: crawledCount,
         failed: failedCount,
         percentage: urls.length > 0 ? Math.round((crawledCount / urls.length) * 100) : 0,
       },
       ...(cancelled ? { error: { message: 'Crawl cancelled by user', code: 'CANCELLED' } } : {}),
       ...(crawledCount === 0 && !cancelled
         ? { error: { message: 'No pages could be crawled', code: 'ZERO_PAGES' } }
         : {}),
       summary: {
         totalPages: urls.length,
         completed: crawledCount,
         failed: failedCount,
         skipped: skippedCount,
         httpPages,
         browserPages,
       },
       sections: Array.from(sectionCounts.entries()).map(([sectionId, counts]) => ({
         sectionId,
         name: sectionMapping.find((s) => s.sectionId === sectionId)?.name ?? sectionId,
         count: counts.completed,
       })),
       comparison: comparison ?? undefined,
     },
   });
   ```

5. **ST-1.5**: Add `data.progress` to `job_started` event at line 446 (initial zeros):
   ```typescript
   progress: { total: urls.length, completed: 0, failed: 0, percentage: 0 },
   ```

### Acceptance Criteria

- AC-1.1: `url_fetched` events include `data.progress` with running totals
- AC-1.2: Terminal event type is `job_failed` when `crawledCount === 0` or cancelled
- AC-1.3: Terminal event type is `job_completed` only when `crawledCount > 0` and not cancelled
- AC-1.4: `job_started` includes `data.progress` with zeros
- AC-1.5: `url_skipped` events include `data.progress` with running totals

---

## Task T-2: Fix State4Crawl Progress Reading and Terminal Detection (studio)

### Files to Modify

- `apps/studio/src/components/search-ai/crawl-flow/State4Crawl.tsx` — Fix section fills, add sticky terminal state, add REST progress merge
- `apps/studio/src/hooks/useCrawlProgress.ts` — Add `sections` and `summary` to `CrawlProgressEvent` data type

### Subtasks

1. **ST-2.1**: Progress derivation at line 309 already reads `crawlProgress.lastEvent?.data?.progress`. After T-1, this path will be populated. No code change needed for the read path — T-1 fixes the data source.

2. **ST-2.2**: The `isDone`/`isFailed` checks at lines 316-324 are already correct. After T-1, cancelled jobs emit `job_failed` so they'll show as failed (correct UX). No change needed.

3. **ST-2.3**: Fix section fill rates. Replace the `sectionFill` useMemo at lines 390-410 (keep the existing fallback at lines 399-408 for sections from props):

   ```typescript
   const sectionFill = useMemo(() => {
     // Priority 1: intelligence group progress (for intelligence crawls)
     const fills: Array<{ name: string; completed: number; total: number }> = [];
     for (const [group, progress] of Object.entries(multiPage.groupProgress)) {
       fills.push({ name: group, completed: progress.completed, total: progress.total });
     }
     if (fills.length > 0) return fills;

     // Priority 2: derive from bulk crawl job_completed event's sections data
     const completedEvent = crawlProgress.events.find((e) => e.type === 'job_completed');
     if (completedEvent?.data?.sections && Array.isArray(completedEvent.data.sections)) {
       for (const s of completedEvent.data.sections) {
         const sec = s as { sectionId: string; name: string; count: number };
         const matchingSection = sections.find(
           (section) => (section.sectionId ?? '') === sec.sectionId,
         );
         fills.push({
           name: sec.name,
           completed: sec.count,
           total: matchingSection?.pageCount ?? sec.count,
         });
       }
       if (fills.length > 0) return fills;
     }

     // Priority 3: fallback — sections from props with progress from overall counts
     for (const section of sections.filter((s) => s.included)) {
       fills.push({
         name: section.name,
         completed: sections.length === 1 ? completedCount : 0,
         total: section.pageCount,
       });
     }
     return fills;
   }, [multiPage.groupProgress, crawlProgress.events, sections, completedCount]);
   ```

4. **ST-2.4**: Fix `lastEvent` race condition. Add sticky refs to prevent terminal state from being overwritten by late events:

   ```typescript
   const isDoneRef = useRef(false);
   const isFailedRef = useRef(false);

   const isDone =
     multiPage.isComplete ||
     crawlProgress.lastEvent?.type === 'job_completed' ||
     crawlProgress.lastEvent?.type === 'intelligence_crawl_complete';

   const isFailed =
     multiPage.isFailed ||
     crawlProgress.lastEvent?.type === 'job_failed' ||
     crawlProgress.lastEvent?.type === 'intelligence_crawl_failed';

   // Latch — once terminal, stay terminal
   if (isDone) isDoneRef.current = true;
   if (isFailed) isFailedRef.current = true;
   const effectiveIsDone = isDoneRef.current;
   const effectiveIsFailed = isFailedRef.current;
   ```

   Use `effectiveIsDone` / `effectiveIsFailed` throughout the component (in useEffect deps, JSX conditionals, cancel/back button visibility).

5. **ST-2.5**: Update `CrawlProgressEvent` type in `useCrawlProgress.ts` to include bulk-crawl fields in the data type. Add to the existing `data?` interface:
   ```typescript
   data?: {
     // ... existing fields (url, documentId, chunkId, progress, reason, error) ...
     sections?: Array<{ sectionId: string; name: string; count: number }>;
     summary?: Record<string, unknown>;
     skipReason?: string;
   };
   ```

### Acceptance Criteria

- AC-2.1: Progress bar shows actual crawled/failed/total counts during bulk crawl
- AC-2.2: Completion state is sticky — once done, stays done even if late events arrive
- AC-2.3: Section fill rates populate from `job_completed` event's `sections` data
- AC-2.4: Failed/cancelled crawls show as failed, not completed

---

## Task T-3: Add Pagination Loop for getSectionUrls (studio)

### Files to Modify

- `apps/studio/src/components/search-ai/crawl-flow/CrawlFlowV5.tsx` — Replace single `getSectionUrls` call with pagination loop in `handleStartCrawl`

### Subtasks

1. **ST-3.1**: Replace the bucket fetch block at lines 641-650 only (preserve the fallback at lines 652-659). Change from:
   ```typescript
   // Try bucket first — contains full URL list from clustering
   if (draftId) {
     try {
       const bucketResult = await getSectionUrls(draftId, sid, { limit: 50000 });
       if (bucketResult.urls.length > 0) {
         sectionUrls.push(...bucketResult.urls.map((u) => u.url));
       }
     } catch {
       // Bucket read failed — fall through to local state
     }
   }
   ```
   To:
   ```typescript
   // Try bucket first — contains full URL list from clustering
   // Paginate: server caps at 100 per request (see crawl-drafts.ts:815)
   if (draftId) {
     try {
       const BUCKET_PAGE_SIZE = 100; // Server max: Math.min(100, requested)
       let offset = 0;
       let hasMore = true;
       while (hasMore) {
         const bucketResult = await getSectionUrls(draftId, sid, {
           offset,
           limit: BUCKET_PAGE_SIZE,
         });
         if (bucketResult.urls.length > 0) {
           sectionUrls.push(...bucketResult.urls.map((u) => u.url));
         }
         offset += bucketResult.urls.length;
         hasMore =
           bucketResult.urls.length === BUCKET_PAGE_SIZE && offset < bucketResult.pagination.total;
       }
     } catch {
       // Bucket read failed — fall through to local state
     }
   }
   ```
   The existing fallback at lines 652-659 (section.pages, section.examples) is preserved unchanged.

### Acceptance Criteria

- AC-3.1: Sections with >100 URLs have all URLs collected (not capped at 100)
- AC-3.2: Pagination stops when all URLs are fetched (not infinite loop)
- AC-3.3: Failure on any page falls back to local state gracefully

---

## Task T-4: Add Event Replay Cache in WS Server (search-ai)

### Files to Modify

- `apps/search-ai/src/routes/progress.ts` — Cache last event per job in Redis, replay on WS connect

### Subtasks

1. **ST-4.1**: In `publishProgressEvent()` (line 411), after publishing to the channel, also cache the event in Redis with a 1-hour TTL using `setex` (codebase convention — not `.set('EX')`):

   ```typescript
   // Cache last event for replay to late-connecting clients
   const cacheKey = `progress:last:${event.jobId}`;
   await publisher.setex(cacheKey, 3600, message);
   ```

2. **ST-4.2**: In the WebSocket `connection` handler (line 262), after subscribing to the Redis channel and sending the `connected` message (line 304-311), replay the cached last event. The subscriber is in subscribe mode and cannot issue `GET`, so use the singleton publisher (`getProgressPublisher`) which is in normal mode:
   ```typescript
   // Replay last event for late joiners (use publisher — subscriber is in subscribe mode)
   try {
     const pub = getProgressPublisher();
     const cachedEvent = await pub.get(`progress:last:${jobId}`);
     if (cachedEvent && ws.readyState === WebSocket.OPEN) {
       ws.send(cachedEvent);
     }
   } catch (err) {
     logger.warn('Failed to replay cached event', {
       jobId,
       error: err instanceof Error ? err.message : String(err),
     });
   }
   ```
   Place this immediately after the `ws.send(JSON.stringify({ type: 'connected', ... }))` at line 304.

### Acceptance Criteria

- AC-4.1: Late-connecting WS client receives the most recent event immediately after `connected`
- AC-4.2: Cache expires after 1 hour (matches cancel signal TTL)
- AC-4.3: Cache miss (no prior events) does not cause error

---

## Task T-5: Add Real REST Polling Fallback (studio + search-ai)

### Files to Modify

- `apps/search-ai/src/routes/crawl.ts` — Enhance `/status` endpoint to include crawled/failed counts
- `apps/studio/src/components/search-ai/crawl-flow/State4Crawl.tsx` — Replace WS retry with actual REST polling. Add `import { getCrawlStatus } from '@/api/crawl';`
- `apps/studio/src/api/crawl.ts` — Update `getCrawlStatus` return type

### Subtasks

1. **ST-5.1**: Enhance GET `/api/crawl/status` response (crawl.ts line 2095) to include crawled/failed from CrawlJob. Note: existing field `urls` returns total original count. Add `crawled` and `failed` alongside:

   ```typescript
   const response = {
     success: true,
     jobId: crawlJob._id,
     state: bullState ?? crawlJob.status,
     progress: bullProgress ?? 0,
     urls: crawlJob.urls?.original?.length ?? 0, // existing — total count
     crawled: crawlJob.urls?.crawled ?? 0, // NEW
     failed: crawlJob.urls?.failed ?? 0, // NEW
     strategy: crawlJob.strategy,
     processedOn: bullProcessedOn ?? crawlJob.timeline?.startedAt?.getTime?.() ?? null,
     finishedOn: bullFinishedOn ?? crawlJob.timeline?.completedAt?.getTime?.() ?? null,
     returnvalue:
       bullReturnValue ?? (crawlJob.status === 'completed' ? crawlJob.results : undefined),
     failedReason:
       bullFailedReason ??
       (crawlJob.status === 'failed' ? crawlJob.processingErrors?.[0]?.message : undefined),
   };
   ```

2. **ST-5.2**: Update `getCrawlStatus` client type in `apps/studio/src/api/crawl.ts` line 321:

   ```typescript
   export async function getCrawlStatus(jobId: string): Promise<{
     success: boolean;
     jobId: string;
     state: string;
     progress: number | object;
     urls: number; // total original count
     crawled?: number; // NEW
     failed?: number; // NEW
   }>;
   ```

3. **ST-5.3**: Replace the REST polling fallback in State4Crawl (lines 359-381). Reuse existing `POLL_INTERVAL` constant at line 348. Add `import { getCrawlStatus } from '@/api/crawl';` at the top. Replace the `crawlProgress.connect()` retry with actual REST polling:

   ```typescript
   useEffect(() => {
     if (wsConnected || effectiveIsDone || effectiveIsFailed) {
       if (pollIntervalRef.current) {
         clearInterval(pollIntervalRef.current);
         pollIntervalRef.current = null;
       }
       return;
     }

     const poll = async () => {
       try {
         const status = await getCrawlStatus(jobId);
         const total = status.urls ?? totalPages;
         setRestProgress({
           total,
           completed: status.crawled ?? 0,
           failed: status.failed ?? 0,
           percentage: total > 0 ? Math.round(((status.crawled ?? 0) / total) * 100) : 0,
           isDone: status.state === 'completed',
           isFailed: status.state === 'failed' || status.state === 'cancelled',
         });
       } catch {
         // REST poll failed — ignore, will retry next interval
       }
     };

     poll(); // Immediate first poll
     pollIntervalRef.current = setInterval(poll, POLL_INTERVAL);

     return () => {
       if (pollIntervalRef.current) {
         clearInterval(pollIntervalRef.current);
         pollIntervalRef.current = null;
       }
     };
   }, [wsConnected, effectiveIsDone, effectiveIsFailed, jobId, totalPages]);
   ```

4. **ST-5.4**: Add `restProgress` state and merge with WS progress:

   ```typescript
   const [restProgress, setRestProgress] = useState<{
     total: number;
     completed: number;
     failed: number;
     percentage: number;
     isDone: boolean;
     isFailed: boolean;
   } | null>(null);
   ```

   Merge into progress derivation (WS takes priority via `??`):

   ```typescript
   const progressData =
     crawlProgress.lastEvent?.data?.progress ??
     (restProgress
       ? {
           total: restProgress.total,
           completed: restProgress.completed,
           failed: restProgress.failed,
           percentage: restProgress.percentage,
         }
       : null);
   ```

   Merge into isDone/isFailed (before the sticky refs):

   ```typescript
   const isDone =
     multiPage.isComplete ||
     crawlProgress.lastEvent?.type === 'job_completed' ||
     crawlProgress.lastEvent?.type === 'intelligence_crawl_complete' ||
     restProgress?.isDone === true;

   const isFailed =
     multiPage.isFailed ||
     crawlProgress.lastEvent?.type === 'job_failed' ||
     crawlProgress.lastEvent?.type === 'intelligence_crawl_failed' ||
     restProgress?.isFailed === true;
   ```

### Acceptance Criteria

- AC-5.1: When WS is unavailable, REST polling shows crawl progress every 10s
- AC-5.2: REST polling detects terminal states (completed/failed/cancelled)
- AC-5.3: REST polling stops once terminal state is reached (via sticky refs)
- AC-5.4: Progress switches seamlessly between WS and REST sources

---

## Task T-6: Add Direct-Connect WS URL for Dev Mode (studio)

### Files to Modify

- `apps/studio/src/hooks/useCrawlProgress.ts` — Add dev-mode direct connect
- `apps/studio/src/hooks/useMultiPageProgress.ts` — Same change

### Subtasks

1. **ST-6.1**: In `useCrawlProgress.ts` line 157, use the existing `NEXT_PUBLIC_SEARCH_AI_WS_URL` env var (already used by `connector-extensions.ts:172` for the same purpose):

   ```typescript
   const devWsUrl = process.env.NEXT_PUBLIC_SEARCH_AI_WS_URL;
   const wsUrl = devWsUrl
     ? `${devWsUrl}?jobId=${jobId}&token=${accessToken}`
     : `${wsProtocol}//${host}/api/search-ai/admin/progress/subscribe?jobId=${jobId}&token=${accessToken}`;
   ```

   This follows the established pattern from `connector-extensions.ts:172` where `NEXT_PUBLIC_SEARCH_AI_WS_URL` defaults to `ws://localhost:3005/api/admin/progress/subscribe` in dev.

2. **ST-6.2**: Same change in `useMultiPageProgress.ts` line 353. The URL there also needs `&type=crawler`:
   ```typescript
   const devWsUrl = process.env.NEXT_PUBLIC_SEARCH_AI_WS_URL;
   const wsUrl = devWsUrl
     ? `${devWsUrl}?jobId=${jobId}&type=crawler&token=${accessToken}`
     : `${wsProtocol}//${host}/api/search-ai/admin/progress/subscribe?jobId=${jobId}&type=crawler&token=${accessToken}`;
   ```

### Acceptance Criteria

- AC-6.1: When `NEXT_PUBLIC_SEARCH_AI_WS_URL` is set, WS connects directly (bypasses Next.js proxy)
- AC-6.2: When unset, WS uses same-origin URL (production behavior, no change)

---

## Task T-7: Tests for All Fixes (search-ai + studio)

### Files to Create

- `apps/search-ai/src/workers/__tests__/bulk-crawl-events.test.ts` — Unit tests for event emission shape
- `apps/search-ai/src/routes/__tests__/crawl-status-enhanced.test.ts` — Test enhanced /status response
- `apps/search-ai/src/routes/__tests__/progress-replay.test.ts` — Test event replay cache

### Subtasks

1. **ST-7.1**: Create `bulk-crawl-events.test.ts`. Extract the event-publishing logic into testable helpers OR test by mocking `publishProgressEvent` and verifying call args. Test:
   - `url_fetched` success events include `data.progress` with correct running totals
   - `url_fetched` failure events include `data.progress`
   - `url_skipped` events include `data.progress` with running totals
   - Terminal event is `job_completed` when `crawledCount > 0` and not cancelled
   - Terminal event is `job_failed` when `crawledCount === 0`
   - Terminal event is `job_failed` with error code `CANCELLED` when cancelled
   - Terminal event is `job_failed` with error code `ZERO_PAGES` when 0 crawled and not cancelled
   - `job_started` includes `data.progress` with zeros
   - All events include `data.progress.percentage` as integer 0-100

2. **ST-7.2**: Create `crawl-status-enhanced.test.ts` using the E2E pattern from `apps/search-ai/src/routes/__tests__/crawl-dashboard.test.ts` (DI queue factory, test MongoDB). Test:
   - GET `/status` includes `crawled` and `failed` fields
   - Values match CrawlJob document
   - Tenant isolation enforced (cross-tenant returns 404)

3. **ST-7.3**: Create `progress-replay.test.ts`. Test:
   - `publishProgressEvent` caches last event in Redis with `setex`
   - Cache key is `progress:last:{jobId}`
   - New WS connection receives cached event after `connected` message
   - Cache miss (no prior events) does not cause error or extra WS message
   - Multiple events — only last event is cached (overwrite, not append)

### Acceptance Criteria

- AC-7.1: All new tests pass
- AC-7.2: Existing tests still pass (no regressions)
- AC-7.3: Tests cover all 7 bug fix paths

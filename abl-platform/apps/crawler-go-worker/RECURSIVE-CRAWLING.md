# Recursive Crawling

## Overview

The crawler worker now supports **recursive crawling with link following**. This allows the crawler to automatically discover and crawl linked pages starting from seed URLs.

## Features

### Strategy Configuration

Recursive crawling is controlled via the `strategy` field in the crawl job:

```json
{
  "jobId": "job-123",
  "batchId": "batch-456",
  "urls": ["https://docs.example.com/"],
  "tenantId": "tenant-1",
  "indexId": "idx-1",
  "sourceId": "src-1",
  "strategy": {
    "followLinks": true,
    "maxPages": 100,
    "maxDepth": 3,
    "sameDomainOnly": true
  }
}
```

### Strategy Options

| Field            | Type    | Default         | Description                       |
| ---------------- | ------- | --------------- | --------------------------------- |
| `followLinks`    | boolean | `false`         | Enable recursive crawling         |
| `maxPages`       | integer | `0` (unlimited) | Maximum pages to crawl            |
| `maxDepth`       | integer | `0` (unlimited) | Maximum link depth from seed URLs |
| `sameDomainOnly` | boolean | `true`          | Only follow links on same domain  |

### Depth Tracking

Each crawled page includes a `depth` field:

- **Depth 0**: Seed URLs provided in the job
- **Depth 1**: Pages linked from seed URLs
- **Depth 2**: Pages linked from depth 1 pages
- etc.

```json
{
  "url": "https://docs.example.com/api/users",
  "depth": 2,
  "success": true,
  "links": [...]
}
```

### URL Normalization

URLs are normalized before crawling to prevent duplicates:

- Fragments removed (`#section`)
- Scheme lowercased (`HTTPS` → `https`)
- Host lowercased (`Example.COM` → `example.com`)

### Same-Domain Filtering

When `sameDomainOnly: true` (default), only links with the same host are followed:

**Seed**: `https://docs.example.com/`

- ✅ `https://docs.example.com/api/` (same domain)
- ✅ `https://docs.example.com/tutorials/` (same domain)
- ❌ `https://external.com/` (different domain)
- ❌ `https://blog.example.com/` (different subdomain)

### Discovered Links

Links that are found but **not crawled** (due to limits or filters) are returned in the batch result:

```json
{
  "jobId": "job-123",
  "results": [...],  // Crawled pages
  "discoveredLinks": [
    "https://docs.example.com/advanced/",
    "https://docs.example.com/reference/",
    "https://external.com/related/"
  ]
}
```

These can be used for:

- Future crawl jobs
- Analytics (link graph)
- Discovering new content

---

## Implementation

### Architecture

```
Seed URLs (depth 0)
    │
    ├─ Worker pool (10 goroutines)
    │   ├─ Crawl URL
    │   ├─ Extract links
    │   └─ Queue discovered links
    │
    ├─ Visited tracking (thread-safe map)
    ├─ Page count limiting (maxPages)
    ├─ Depth limiting (maxDepth)
    └─ Same-domain filtering
```

### Key Files

- **`pkg/types/job.go`**: `CrawlStrategy` type definition
- **`internal/crawler/colly.go`**: `CrawlRecursive()` implementation
- **`internal/processor/processor.go`**: Strategy-aware job processing

### Worker Pool

- 10 concurrent goroutines crawl pages in parallel
- Channel-based queue for discovered links (buffered 1000)
- Thread-safe visited tracking with RWMutex
- Graceful shutdown when queue drains

---

## Usage Examples

### Example 1: Crawl Documentation Site (Max 50 Pages)

```json
{
  "urls": ["https://docs.kore.ai/"],
  "strategy": {
    "followLinks": true,
    "maxPages": 50,
    "maxDepth": 3,
    "sameDomainOnly": true
  }
}
```

**Result**: Crawls up to 50 pages from docs.kore.ai, following links up to 3 levels deep.

### Example 2: Crawl Blog (Max 100 Pages, Deep Crawl)

```json
{
  "urls": ["https://blog.example.com/"],
  "strategy": {
    "followLinks": true,
    "maxPages": 100,
    "maxDepth": 5,
    "sameDomainOnly": true
  }
}
```

**Result**: Crawls up to 100 blog pages, following links up to 5 levels deep.

### Example 3: Single Page (No Link Following)

```json
{
  "urls": ["https://example.com/page.html"],
  "strategy": null
}
```

**Result**: Crawls only the specified URL (legacy behavior).

### Example 4: Cross-Domain Crawl (Allow External Links)

```json
{
  "urls": ["https://example.com/"],
  "strategy": {
    "followLinks": true,
    "maxPages": 20,
    "maxDepth": 2,
    "sameDomainOnly": false
  }
}
```

**Result**: Crawls up to 20 pages, following external links up to 2 levels deep.

---

## Performance Characteristics

### Concurrency

- **Worker pool**: 10 goroutines
- **Colly parallelism**: 100 concurrent requests (configurable)
- **Rate limiting**: 100ms delay between requests (configurable)

### Memory Usage

- **Visited map**: ~100 bytes per URL × N URLs
- **Queue buffer**: 1000 URLs × ~200 bytes = ~200KB
- **Results array**: Full crawl results for all pages

**Estimate**: 1000-page crawl ≈ 100KB visited + 200KB queue + crawl results

### Stopping Conditions

Crawling stops when:

1. **maxPages reached**: Page count limit hit
2. **maxDepth reached**: No more links within depth limit
3. **Queue empty**: All discovered links processed
4. **Timeout**: Worker timeout (30s per page)

---

## Configuration

### Environment Variables

| Variable             | Default | Description                               |
| -------------------- | ------- | ----------------------------------------- |
| `MAX_DEPTH`          | `5`     | Global max depth (overridden by strategy) |
| `PARALLELISM`        | `100`   | Colly parallelism (requests/sec)          |
| `DELAY_BETWEEN`      | `100ms` | Delay between requests                    |
| `REQUEST_TIMEOUT`    | `30s`   | Timeout per request                       |
| `RESPECT_ROBOTS_TXT` | `true`  | Respect robots.txt                        |

### Defaults

If no strategy is provided:

- `followLinks`: `false` (no recursive crawling)
- `maxPages`: `0` (unlimited)
- `maxDepth`: `0` (unlimited)
- `sameDomainOnly`: `true`

---

## Monitoring

### Logs

```
Processing batch batch-456 with 1 URLs
Using recursive crawl with strategy: maxPages=50, maxDepth=3, sameDomainOnly=true
Batch batch-456 completed: 47 successful, 3 failed, 15 discovered links, duration: 12340ms
```

### Progress Updates

Published to Redis pub/sub channel `crawl:{jobId}:progress`:

```json
{
  "jobId": "job-123",
  "batchId": "batch-456",
  "processed": 47,
  "total": 47,
  "successful": 47,
  "failed": 0,
  "updatedAt": "2026-02-24T12:00:00Z"
}
```

### Batch Results

```json
{
  "jobId": "job-123",
  "results": [
    /* 47 crawled pages */
  ],
  "totalUrls": 47,
  "successful": 47,
  "failed": 0,
  "discoveredLinks": [
    /* 15 uncrawled links */
  ],
  "duration": 12340
}
```

---

## Future Enhancements

- [ ] **Pattern matching**: Crawl only URLs matching regex pattern
- [ ] **Exclude patterns**: Skip URLs matching exclude pattern
- [ ] **Priority queue**: Crawl high-priority pages first
- [ ] **Incremental crawling**: Resume from previous crawl state
- [ ] **Politeness delays**: Per-domain rate limiting
- [ ] **Link scoring**: Prioritize pages by link density/depth
- [ ] **Crawl budget**: Stop after N bytes or N requests
- [ ] **Robots.txt caching**: Cache robots.txt per domain

---

## Testing

To test recursive crawling:

```bash
# Build worker
cd apps/crawler-go-worker
go build -o bin/worker cmd/worker/main.go

# Submit crawl job via Search-AI API with strategy
curl -X POST http://localhost:3005/api/crawl/batch \
  -H "Content-Type: application/json" \
  -d '{
    "indexId": "idx-1",
    "sourceId": "src-1",
    "urls": ["https://docs.example.com/"],
    "strategy": {
      "followLinks": true,
      "maxPages": 10,
      "maxDepth": 2,
      "sameDomainOnly": true
    }
  }'
```

---

## Migration Notes

### Backward Compatibility

✅ **No breaking changes**. Existing jobs without `strategy` field continue to work as before (single-page crawling).

### Upgrade Path

1. Deploy updated Go worker
2. Update Search-AI API to send `strategy` field in crawl jobs
3. Update UI to expose recursive crawling options
4. Monitor crawl jobs for performance and correctness

---

## Known Limitations

1. **No JavaScript rendering**: Colly does not execute JavaScript. For SPAs, use browser-based crawling.
2. **No session/auth**: Worker does not handle login or authentication.
3. **No form submissions**: Worker only follows `<a href>` links.
4. **No crawl politeness**: Fixed global delay, no per-domain politeness.
5. **No distributed crawling**: Worker is single-threaded per job (within worker pool).

---

## Related Documentation

- [Crawler Architecture](../../../docs/searchai/crawling/ARCHITECTURE.md)
- [Crawl Strategy API](../../../docs/searchai/crawling/CRAWL-STRATEGY.md)
- [FastProfiler](../../../packages/crawler/README.md)

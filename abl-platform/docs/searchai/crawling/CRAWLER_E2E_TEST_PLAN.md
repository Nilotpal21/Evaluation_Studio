# Crawler E2E Test Plan

## Prerequisites

### Services Required

- Runtime (port 3112)
- SearchAI (port 3113)
- Studio (port 5173)
- Redis (port 6379)
- MongoDB (port 27017)
- Go Crawler Worker (Docker)

### Start Services

```bash
pnpm run abl-services start runtime studio search-ai
docker-compose up crawler-go-worker
```

### Test Data Setup

```bash
# Create test tenant and user
curl -X POST http://localhost:3112/api/tenants \
  -H "Content-Type: application/json" \
  -d '{"name": "test-crawl-tenant"}'

# Create test knowledge base with web crawler source
# Note: Use Studio UI or API to create KB and get indexId/sourceId
```

---

## E2E Test Scenarios

### Scenario 1: Happy Path - Single Page Crawl

```
1. Navigate to Studio -> Knowledge Base -> Web Crawler tab
2. Enter URL: https://example.com
3. Wait for auto-profile (skeleton -> preview card)
4. Select "Just this page"
5. Click "Start Crawl"
6. Verify: Switches to Progress tab
7. Verify: WebSocket connects ("Live" badge)
8. Verify: Phase cards update (crawling -> documents -> chunks -> indexed)
9. Verify: Progress bar reaches 100%
10. Verify: Completion banner with "View Crawled Pages" button
11. Click "View Crawled Pages"
12. Verify: CrawledPagesView shows 1 page with success status
```

### Scenario 2: Full Site Crawl with Strategy

```
1. Enter URL: https://docs.example.com
2. Wait for profile
3. Select "Entire site"
4. Select strategy: "Sitemap"
5. Set Max Pages: 10
6. Click "Start Crawl"
7. Verify: Job starts, progress shows multiple URLs
8. Wait for completion
9. Verify: Multiple pages in CrawledPagesView
```

### Scenario 3: Cancel Running Crawl

```
1. Start a large crawl (e.g., full site with 1000 pages)
2. While crawling, click "Cancel" button
3. Confirm cancellation dialog
4. Verify: Status changes to "Cancelled"
5. Verify: Cancel button disappears
6. Verify: "Start New Crawl" button available
```

### Scenario 4: SSRF Protection

```
1. Enter URL: http://127.0.0.1
2. Click "Start Crawl"
3. Verify: 400 error with SSRF_PROTECTION message
4. Enter URL: http://169.254.169.254/latest/meta-data/
5. Click "Start Crawl"
6. Verify: 400 error with SSRF_PROTECTION message
7. Enter URL: http://10.0.0.1
8. Verify: Blocked
```

### Scenario 5: History Search and Filter

```
1. Submit 3+ crawl jobs (1 completed, 1 failed, 1 cancelled)
2. Navigate to History tab
3. Verify: All 3 jobs listed
4. Click "Failed" filter button
5. Verify: Only failed job shown
6. Click "All" filter button
7. Type part of URL in search box
8. Verify: Only matching job shown
9. Click completed job row
10. Verify: Switches to Progress tab showing that job
```

### Scenario 6: Preference Auto-Start

```
1. Submit a crawl for docs.example.com
2. After completion, save preference with auto-decide enabled
3. Navigate to New Crawl tab
4. Enter URL: https://docs.example.com/new-page
5. Verify: Preference banner appears
6. Verify: 3-second countdown starts
7. Wait for countdown to complete
8. Verify: Job auto-starts without clicking submit
```

### Scenario 7: Question Prompt Flow

```
1. Enter URL for unfamiliar/complex site
2. Click "Start Crawl"
3. If backend returns needsUserInput=true:
   a. Verify: QuestionPrompt replaces form
   b. Answer all questions
   c. Click "Start Crawl"
   d. Verify: Job starts
4. If backend auto-decides (high confidence):
   a. Verify: Job starts immediately
```

---

## API Contract Tests

### Profile Site

```bash
curl -X POST http://localhost:3113/api/crawl/profile \
  -H "Authorization: Bearer $TOKEN" \
  -H "Content-Type: application/json" \
  -d '{"url": "https://example.com"}'
# Expected: 200 with { domain, siteType, estimatedSize, metadata }
```

### Submit Batch Crawl

```bash
curl -X POST http://localhost:3113/api/crawl/batch \
  -H "Authorization: Bearer $TOKEN" \
  -H "Content-Type: application/json" \
  -d '{
    "urls": ["https://example.com"],
    "indexId": "INDEX_ID",
    "sourceId": "SOURCE_ID",
    "strategy": "smart"
  }'
# Expected: 200 with { success, jobId, batchId, status: "queued" }
```

### Cancel Job

```bash
curl -X POST http://localhost:3113/api/crawl/jobs/JOB_ID/cancel \
  -H "Authorization: Bearer $TOKEN"
# Expected: 200 with { success, jobId, status: "cancelled" }
```

### Get Dashboard

```bash
curl http://localhost:3113/api/crawl/dashboard/JOB_ID \
  -H "Authorization: Bearer $TOKEN"
# Expected: 200 with { phase, crawl, ingestion, extraction, indexing, timeline }
```

### Get Crawled Pages

```bash
curl "http://localhost:3113/api/crawl/pages/JOB_ID?limit=20&offset=0&status=all" \
  -H "Authorization: Bearer $TOKEN"
# Expected: 200 with { pages[], total, pagination }
```

### SSRF Protection Test

```bash
curl -X POST http://localhost:3113/api/crawl/batch \
  -H "Authorization: Bearer $TOKEN" \
  -H "Content-Type: application/json" \
  -d '{"urls": ["http://169.254.169.254/latest/meta-data/"], "indexId": "X", "sourceId": "Y"}'
# Expected: 400 with { error: "SSRF_PROTECTION" }
```

### Health Check

```bash
curl http://localhost:3113/api/health
# Expected: 200 with { status: "ok", crawler: { queue: "static-crawl", status: "available" } }
```

---

## Security Tests

| Test              | Command                                             | Expected            |
| ----------------- | --------------------------------------------------- | ------------------- |
| SSRF - localhost  | `curl ... -d '{"urls":["http://127.0.0.1"]}'`       | 400 SSRF_PROTECTION |
| SSRF - private IP | `curl ... -d '{"urls":["http://10.0.0.1"]}'`        | 400 SSRF_PROTECTION |
| SSRF - metadata   | `curl ... -d '{"urls":["http://169.254.169.254"]}'` | 400 SSRF_PROTECTION |
| Tenant isolation  | Cancel job from different tenant                    | 404 (not 403)       |
| No auth           | Request without Bearer token                        | 401                 |
| Invalid job ID    | Cancel non-existent job                             | 404                 |

---

## Performance Tests

### Load Test Plan

```
1. Submit 100 concurrent single-page crawl jobs
2. Measure: Queue throughput, worker processing time, memory usage
3. Target: <5s queue latency, <30s per page crawl, <512MB worker memory
```

### Stress Test Plan

```
1. Submit crawl with 10,000 URLs
2. Monitor: Go worker memory, Redis queue depth, MongoDB write throughput
3. Verify: No OOM, no goroutine leaks, circuit breaker triggers appropriately
```

---

## Monitoring Validation

```bash
# Check structured logging (no console.error in production)
grep -r "console\.error\|console\.log" apps/search-ai/src/routes/crawl*.ts
# Expected: No matches

# Check health endpoint
curl http://localhost:3113/api/health
# Expected: 200 OK with crawler status

# Check queue stats
curl http://localhost:3113/api/crawl/dashboard/ACTIVE_JOB_ID
# Expected: Queue depth, worker count, processing rates
```

---

## Regression Checklist

After each deployment, verify:

- [ ] New Crawl form loads and auto-profiles
- [ ] Strategy tooltips display correctly
- [ ] Public URL notice visible
- [ ] Crawl submission succeeds for valid URLs
- [ ] SSRF blocks private/internal URLs
- [ ] Progress tab shows real-time updates
- [ ] Cancel button works for active jobs
- [ ] ETA displays after 5% progress
- [ ] Event log accumulates and toggles
- [ ] Completion actions (View Pages, New Crawl) work
- [ ] History search and filter functional
- [ ] Re-crawl button navigates to form
- [ ] CrawledPagesView loads with stats
- [ ] CSV export downloads file
- [ ] View doc link navigates correctly
- [ ] Preferences list/edit/delete work
- [ ] Health check includes crawler status
- [ ] No console.error in server logs

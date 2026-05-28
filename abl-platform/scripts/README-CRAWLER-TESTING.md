# Crawler Testing Scripts - RFC-001

Quick reference for running end-user crawler tests as specified in [RFC-001](../docs/rfcs/RFC-001-CRAWLER-END-USER-TESTING.md).

## Quick Start

### Test a Single Site (e.g., docs.kore.ai)

```bash
# Basic usage
./scripts/test-crawl-site.sh \
  "https://docs.kore.ai/gettingstarted/" \
  "docs.kore.ai" \
  5 \
  1

# Arguments:
# $1: Start URL
# $2: Site name (used for result files)
# $3: Max pages to crawl
# $4: Max depth
```

### Test Multiple Sites (Bulk)

```bash
# Run all 14 test sites from RFC-001
./scripts/test-crawl-bulk.sh

# This will:
# - Test 14 diverse websites
# - Save results to ./test-results/
# - Take ~30-60 minutes
```

### Analyze Results

```bash
# Generate aggregate report
./scripts/analyze-test-results.sh

# Output:
# - Individual test results
# - Aggregate metrics
# - Target validation
# - Summary file in ./test-results/
```

## Prerequisites

1. **Services Running**

   ```bash
   # Start Redis
   redis-server

   # Start MongoDB
   mongod

   # Start Search-AI service
   cd apps/search-ai && pnpm dev

   # Start Go crawler worker
   cd apps/crawler-go-worker && go run main.go
   ```

2. **Environment Variables** (optional)
   ```bash
   export API_BASE="http://localhost:3001"
   export TENANT_ID="tenant-1"
   export PROJECT_ID="project-1"
   ```

## Test Workflow

```
1. Run Tests
   └─> test-crawl-site.sh (single) OR test-crawl-bulk.sh (multiple)
       ├─> Creates KB + Index + Source
       ├─> Submits crawl job
       ├─> Monitors progress
       ├─> Collects quality metrics
       └─> Saves results to ./test-results/

2. Analyze Results
   └─> analyze-test-results.sh
       ├─> Aggregates all test data
       ├─> Validates against targets
       └─> Generates summary report

3. Manual Review
   └─> Review cleaned HTML files
   └─> Fill out RFC-001 test template
   └─> Document issues and improvements
```

## Output Files

```
test-results/
├── docs.kore.ai-test-1234567890.json       # Test metadata + metrics
├── docs.kore.ai-test-1234567890-documents.json  # Full document data
├── python.org-test-1234567891.json
├── python.org-test-1234567891-documents.json
├── ...
└── summary-20250223-153000.txt             # Aggregate report
```

## Understanding Results

### Test Result JSON Structure

```json
{
  "testId": "test-1234567890-docs-kore-ai",
  "site": "docs.kore.ai",
  "startUrl": "https://docs.kore.ai/gettingstarted/",
  "testedAt": "2025-02-23T10:00:00Z",
  "status": "completed",

  "ids": {
    "kbId": "...",
    "indexId": "...",
    "sourceId": "...",
    "jobId": "...",
    "batchId": "..."
  },

  "crawl": {
    "status": "completed",
    "duration": 45,
    "decision": { "strategy": "static", ... }
  },

  "ingestion": {
    "duration": 120,
    "documentsCreated": 5,
    "documentsFailed": 0
  },

  "quality": {
    "avgOverallScore": 87.5,
    "avgNoiseReduction": 48.2,
    "avgContentPreservation": 94.1,
    "avgStructurePreservation": 92.0,
    "avgMetadataExtraction": 85.0,
    "distribution": {
      "excellent": 3,
      "good": 2,
      "fair": 0,
      "poor": 0
    }
  },

  "size": {
    "avgRawBytes": 42000,
    "avgCleanedBytes": 8400,
    "avgReduction": 80.0
  },

  "extraction": {
    "totalChunks": 75,
    "avgChunksPerDoc": 15.0
  }
}
```

### Key Metrics Explained

| Metric                    | Good   | Acceptable | Poor | What It Means                       |
| ------------------------- | ------ | ---------- | ---- | ----------------------------------- |
| **Overall Quality Score** | 85+    | 70-84      | <70  | Weighted average of all metrics     |
| **Noise Reduction**       | 40-60% | 30-40%     | <30% | % of HTML removed (ads, nav, etc.)  |
| **Content Preservation**  | 95%+   | 90-94%     | <90% | % of main content kept              |
| **Success Rate**          | 90%+   | 85-89%     | <85% | % of documents successfully indexed |
| **Avg Chunks/Doc**        | 10-20  | 20-30      | >30  | Chunking efficiency                 |

## Troubleshooting

### Test Hangs or Times Out

```bash
# Check services are running
curl http://localhost:3001/health

# Check BullMQ queues
redis-cli
> LLEN bull:static-crawl:waiting
> LLEN bull:content-processing:waiting

# Check worker logs
docker logs -f search-ai-service | grep -E "crawler-ingestion|docling"
```

### Quality Scores Too Low

Possible causes:

1. **Low noise reduction** - Site has clean HTML already
2. **Low content preservation** - Readability too aggressive, losing content
3. **Low structure** - Headings not properly tagged
4. **Low metadata** - Missing title/author in source HTML

Review cleaned HTML manually:

```bash
# Find document ID
curl "http://localhost:3001/api/indexes/$INDEX_ID/documents" \
  -H "x-tenant-id: $TENANT_ID" | jq '.documents[0]._id'

# Get metadata with URLs
curl "http://localhost:3001/api/crawler/ingest/status/$DOCUMENT_ID" \
  -H "x-tenant-id: $TENANT_ID" | jq '.metadata'

# Download cleaned HTML
# (URL in metadata.sourceUrl)
```

### Crawl Fails Immediately

Check:

1. URL is accessible: `curl -I <url>`
2. Site allows crawlers: Check robots.txt
3. Site requires JS: May need SPA handling
4. Rate limiting: Add delays or change user agent

## Test Sites (RFC-001)

### Category A: Documentation (Expected: High Quality)

- ✅ docs.kore.ai - Target use case
- ✅ docs.python.org - Complex structure
- ✅ developer.mozilla.org - Large scale
- ✅ react.dev - Modern docs

### Category B: News/Blogs (Expected: Medium Quality)

- ✅ techcrunch.com - Heavy ads
- ✅ medium.com - Paywalls
- ✅ arstechnica.com - Mix of content/ads
- ✅ blog.cloudflare.com - Technical blogs

### Category C: E-commerce (Expected: Variable)

- ✅ stripe.com - API docs
- ✅ shopify.dev - Developer docs

### Category D: SPA/Dynamic (Expected: Challenges)

- ⚠️ notion.so - Heavy client-side rendering
- ⚠️ figma.com - Dynamic loading

### Category E: Edge Cases (Expected: Variable)

- ✅ wikipedia.org - Large pages, many links
- ✅ stackoverflow.com - Q&A structure

## RFC-001 Test Template

After running tests, fill out:

```
docs/rfcs/RFC-001-CRAWLER-END-USER-TESTING.md
  └─> "Test Execution Template" section
```

Record:

1. Setup (IDs, dates, tester)
2. Expected vs. actual behavior
3. Issues found (severity, impact, reproducibility)
4. Screenshots of original vs. cleaned content
5. Recommendations for improvements

## Next Steps After Testing

1. **Review Results** - Check if targets met
2. **Identify Gaps** - Document failures and pain points
3. **Prioritize Improvements** - Create follow-up RFCs
4. **Implement P0 Fixes** - Critical issues first
5. **Re-test** - Validate fixes work

Expected follow-up RFCs:

- RFC-002: Real-time progress streaming
- RFC-003: JavaScript rendering support
- RFC-004: Error tracking and retry
- RFC-005: Authentication support
- RFC-006: Smart rate limiting

## Quick Reference

```bash
# Single test
./scripts/test-crawl-site.sh "https://docs.kore.ai/" "docs.kore.ai" 5 1

# Bulk test (all sites)
./scripts/test-crawl-bulk.sh

# Analyze
./scripts/analyze-test-results.sh

# View result
cat test-results/docs.kore.ai-test-*.json | jq

# View summary
cat test-results/summary-*.txt
```

## Support

See also:

- [RFC-001](../docs/rfcs/RFC-001-CRAWLER-END-USER-TESTING.md) - Full testing specification
- [CRAWL_MONITORING_GUIDE.md](../CRAWL_MONITORING_GUIDE.md) - Monitoring APIs
- [docs/crawler/](../docs/crawler/) - Architecture documentation

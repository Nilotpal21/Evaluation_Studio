# RFC-001 Quick Verification Commands

**Time Required**: 30 minutes
**Goal**: Verify if RFC-001 issues are resolved

---

## Setup (5 minutes)

```bash
# 1. Start services
docker-compose up -d  # MongoDB, Redis, OpenSearch, ClickHouse

# 2. Start BGE-M3 embedding service
cd services/bge-m3-service
docker-compose up -d

# 3. Start Search-AI
pnpm --filter @agent-platform/search-ai dev

# Wait 10 seconds for workers to initialize
```

---

## Test 1: Verify Chunking Works (10 minutes)

**RFC-001 Issue #3**: Chunking produces 0 chunks
**Expected**: 10-50 chunks per page

```bash
# Check workers are running
curl http://localhost:3113/api/admin/queues

# Expected: See "page-processing" queue listed

# Start a crawl
curl -X POST http://localhost:3113/api/crawl/batch \
  -H "Content-Type: application/json" \
  -d '{
    "urls": ["https://example.com"],
    "tenantId": "test-tenant-001",
    "indexId": "test-index-001",
    "sourceId": "test-source-001"
  }' | jq '.'

# Save the jobId from response

# Wait 30 seconds for pipeline to complete
sleep 30

# Check chunks were created
mongosh abl_platform << 'MONGO'
use search_ai
db.searchChunks.count({ tenantId: "test-tenant-001" })
MONGO

# Expected: Count > 0 (e.g., 10-50)
# If 0: Task #20 needs debugging
# If > 0: Task #20 is COMPLETE ✅
```

---

## Test 2: Verify Content Preservation (10 minutes)

**RFC-001 Issue #2**: Only 8% content preserved
**Expected**: 90%+ for documentation sites

```bash
# Test with docs.kore.ai (documentation site)
curl -X POST http://localhost:3113/api/crawl/batch \
  -H "Content-Type: application/json" \
  -d '{
    "urls": ["https://docs.kore.ai/xo/getting-started/what-is-bots/"],
    "tenantId": "test-tenant-002",
    "indexId": "test-index-002",
    "sourceId": "test-source-002"
  }' | jq '.'

# Wait 30 seconds
sleep 30

# Check Readability metadata
mongosh abl_platform << 'MONGO'
use search_ai
db.searchDocuments.findOne(
  {
    tenantId: "test-tenant-002",
    url: { $regex: /docs.kore.ai/ }
  },
  {
    "ingestion.readabilityMetadata": 1,
    url: 1
  }
)
MONGO

# Check the output:
# {
#   ingestion: {
#     readabilityMetadata: {
#       cleaned: false,           # ✅ Should be false (docs site detected)
#       sizeReduction: 25,        # ✅ Should be ~20-30% (scripts/styles only)
#       originalSize: 50000,
#       cleanedSize: 37500        # ✅ Should be ~70-80% of original
#     }
#   }
# }

# If cleaned=false and sizeReduction<40%: Task #19 is COMPLETE ✅
# If cleaned=true or sizeReduction>80%: Task #19 needs debugging
```

---

## Test 3: Verify Multi-Page Discovery (5 minutes)

**RFC-001 Issue #6**: Only 1 page crawled (should be 5+)
**Expected**: Sitemap expansion works

```bash
# Test sitemap expansion
curl -X POST http://localhost:3113/api/crawl/batch \
  -H "Content-Type: application/json" \
  -d '{
    "urls": ["https://docs.kore.ai/"],
    "strategy": "sitemap",
    "limits": { "maxPages": 5 },
    "tenantId": "test-tenant-003",
    "indexId": "test-index-003",
    "sourceId": "test-source-003"
  }' | jq '.'

# Check response immediately (no wait needed)
# Expected output:
# {
#   "success": true,
#   "urlExpansion": {
#     "expanded": true,              # ✅ Should be true
#     "source": "sitemap",           # ✅ Should be "sitemap"
#     "originalCount": 1,
#     "expandedCount": 5             # ✅ Should be 5
#   },
#   "jobId": "...",
#   "urls": 5                        # ✅ Should be 5, not 1
# }

# If expanded=true and expandedCount=5: Tasks #24, #25, #27 are COMPLETE ✅
# If expanded=false: Check FastProfiler.extractSitemapUrls()
```

---

## Results Interpretation

### Scenario A: All 3 Tests Pass ✅

**Conclusion**: RFC-001 issues are RESOLVED!

**Next Steps**:

1. Update RFC-001-MASTER-TASK-LIST.md to mark tasks as complete
2. Focus on autonomous intelligence (DecisionTimeline UI)
3. No need for 2-3 week fix effort

---

### Scenario B: Test 1 Fails (Chunking)

**Symptom**: `db.searchChunks.count()` returns 0

**Debug Steps**:

```bash
# Check if page-processing worker is running
curl http://localhost:3113/api/admin/queues | jq '.queues[] | select(.name=="page-processing")'

# Check worker logs
cd apps/search-ai
pnpm dev 2>&1 | grep -i "page-processing\|chunk"

# Check if documents reached page-processing stage
mongosh abl_platform << 'MONGO'
use search_ai
db.searchDocuments.findOne({ tenantId: "test-tenant-001" }, { status: 1, error: 1 })
MONGO

# If status != "processing" or "completed": Earlier stage failed
# If status = "completed" but no chunks: page-processing worker issue
```

**Estimated Fix**: 2-3 hours (not 2-3 days)

---

### Scenario C: Test 2 Fails (Content Preservation)

**Symptom**: `sizeReduction` > 80% or `cleaned` = true for docs site

**Debug Steps**:

```bash
# Test isDocsSite detection
node << 'EOF'
const url = "https://docs.kore.ai/getting-started/";
const hostname = new URL(url).hostname;
const isDoc = /^docs?\./i.test(hostname);
console.log({ hostname, isDoc });
// Expected: { hostname: 'docs.kore.ai', isDoc: true }
EOF

# If isDoc = false: Add docs.kore.ai to doc patterns
# If isDoc = true: Check why minimalClean wasn't used
```

**Estimated Fix**: 1-2 hours (config tweak)

---

### Scenario D: Test 3 Fails (Multi-Page Discovery)

**Symptom**: `expanded` = false or `expandedCount` = 1

**Debug Steps**:

```bash
# Test sitemap extraction directly
node << 'EOF'
const { FastProfiler } = await import('./packages/crawler/dist/profiler/fast-profiler.js');
const profiler = new FastProfiler();
const urls = await profiler.extractSitemapUrls('https://docs.kore.ai/', 5);
console.log({ count: urls.length, urls: urls.slice(0, 5) });
EOF

# Expected: count = 5, urls = array of 5 URLs
# If count = 0: Sitemap parsing issue
# If count > 0 but API returns expanded=false: Integration issue
```

**Estimated Fix**: 30 minutes (likely just integration wiring)

---

## Time Estimates

| Scenario          | Estimated Fix Time                            |
| ----------------- | --------------------------------------------- |
| All tests pass    | 0 hours ✅                                    |
| Only Test 1 fails | 2-3 hours                                     |
| Only Test 2 fails | 1-2 hours                                     |
| Only Test 3 fails | 30 minutes                                    |
| All tests fail    | 1 day (still better than RFC-001's 2-3 weeks) |

---

## Full Diagnostic Report

After running all tests, generate a report:

```bash
cat > /tmp/test-results.txt << 'EOF'
RFC-001 VERIFICATION RESULTS
============================

Test 1 (Chunking): [PASS/FAIL]
- Chunks created: [NUMBER]
- Status: [COMPLETE / NEEDS_DEBUG]

Test 2 (Content Preservation): [PASS/FAIL]
- sizeReduction: [PERCENTAGE]%
- cleaned: [true/false]
- Status: [COMPLETE / NEEDS_DEBUG]

Test 3 (Multi-Page Discovery): [PASS/FAIL]
- URLs expanded: [true/false]
- Expanded count: [NUMBER]
- Status: [COMPLETE / NEEDS_DEBUG]

OVERALL STATUS: [ALL_PASS / SOME_FAILURES]
EOF

cat /tmp/test-results.txt
```

---

## Next Steps After Verification

### If All Pass:

1. Update RFC-001 status document
2. Focus on autonomous intelligence UI (DecisionTimeline)
3. No urgent pipeline fixes needed

### If Some Fail:

1. Debug specific failures using steps above
2. Estimated total fix time: 2-4 hours (not weeks)
3. Most issues likely configuration, not architecture

---

## Support

- **Full Report**: See `RFC-001-TASK-VALIDATION-REPORT.md`
- **Task List**: See `docs/rfcs/RFC-001-MASTER-TASK-LIST.md`
- **Architecture**: See `docs/searchai/crawling/SEARCHAI_CRAWLER_ARCHITECTURE.md`

# RFC-001 Crawler Test Results - docs.kore.ai

**Test Date**: 2026-02-23
**Test ID**: test-1771847359-docs-kore-ai
**Site**: docs.kore.ai
**Duration**: 335 minutes
**Status**: ⚠️ COMPLETED WITH CRITICAL ISSUES

## Executive Summary

The RFC-001 end-user crawler test successfully ran against docs.kore.ai and uncovered **6 critical issues** in the crawler-to-ingestion-to-search pipeline. While the crawler successfully fetched HTML content, the downstream processing pipeline has severe quality and functionality problems that make the search system unusable in its current state. Additionally, the crawler only processed 1 page instead of the expected 5 due to missing sitemap URL extraction and link following capabilities.

## Test Configuration

| Parameter      | Value                 |
| -------------- | --------------------- |
| Start URL      | https://docs.kore.ai/ |
| Max Pages      | 5                     |
| Max Depth      | 1                     |
| Queue Strategy | bulk                  |
| Test Duration  | 335 minutes           |

## Test Results

### Metrics Summary

| Metric                | Result       | Target       | Status      |
| --------------------- | ------------ | ------------ | ----------- |
| Documents Created     | 1            | 1-5          | ✅ PASS     |
| Overall Quality Score | 50/100       | 80+          | ❌ FAIL     |
| Noise Reduction       | 98%          | 40-60%       | ⚠️ TOO HIGH |
| Content Preservation  | 8%           | 90%+         | ❌ FAIL     |
| Chunking              | 0 chunks     | 10-50 chunks | ❌ FAIL     |
| Success Rate          | 0%           | 85%+         | ❌ FAIL     |
| Ingestion Time        | 300+ seconds | <60 seconds  | ⚠️ SLOW     |

### Stage-by-Stage Results

#### Stage 1: Crawl (✅ SUCCESS)

- Go Worker successfully crawled 1 URL
- HTML content extracted (24,168 bytes)
- Metadata extracted (title, meta tags)
- **Duration**: 6 seconds

#### Stage 2: Ingestion (⚠️ PARTIAL)

- Document created in MongoDB
- Stuck in "Pending" status for 300+ seconds
- Eventually processed but never reached "Indexed" status
- **Duration**: 300+ seconds (timeout)

#### Stage 3: Processing (❌ FAILURE)

- Readability noise removal: **TOO AGGRESSIVE**
  - Input: 24,168 bytes
  - Output: 551 bytes
  - Removed: 98% (should be 40-60%)
- Content preservation: **8%** (should be 90%+)
- Quality score: **50/100** (should be 80+)

#### Stage 4: Chunking (❌ FAILURE)

- **0 chunks created**
- Should have 10-50 chunks for a typical documentation page
- This blocks the entire search functionality

#### Stage 5: Indexing (❌ FAILURE)

- Document never reached "Indexed" status
- Remained in "Pending" throughout test
- Success rate: 0%

## Critical Issues Discovered

### Issue #6: Sitemap Detection Without URL Extraction (❌ OPEN)

**Severity**: HIGH (P1)
**Component**: Search-AI Crawl API, @abl/crawler FastProfiler, Go Crawler Worker
**Status**: ❌ OPEN

**Description**:
Only **1 page was crawled** despite the site having a comprehensive sitemap.xml and test configuration specifying `maxPages: 5`. The profiler detects sitemap existence but doesn't extract URLs from it, and the Go Worker doesn't follow links.

**Evidence**:

- Site has sitemap: https://docs.kore.ai/sitemap.xml ✅
- Sitemap detected by FastProfiler: `hasSitemap: true` ✅
- Sitemap URLs extracted: ❌ NO
- Test config: `maxPages: 5, followLinks: true`
- Actual pages crawled: 1 ❌

**Root Causes**:

1. **FastProfiler**: Detects sitemap but only uses it for size estimation, doesn't extract URLs
2. **Search-AI Crawl API**: Doesn't expand URL list from sitemap before job submission
3. **Go Worker**: Only processes exact URLs provided, doesn't follow links from pages
4. **Options Ignored**: `maxPages`, `maxDepth`, `followLinks` options passed but never used

**Impact**:

- Multi-page crawling non-functional without pre-built URL lists
- Documentation sites with hundreds of pages require manual URL entry
- Quality metrics based on single page, not representative of site
- Test coverage: 20% (1 page instead of 5)

**Recommended Actions**:

1. Implement sitemap URL extraction in FastProfiler (Task #24)
2. Add sitemap URL expansion to Search-AI crawl API (Task #25)
3. Implement link following in Go Worker for sites without sitemaps (Task #26)
4. Re-test docs.kore.ai with fixes applied (Task #27)

**Related Documentation**: `docs/rfcs/RFC-001-ISSUE-6-SITEMAP-AND-LINK-FOLLOWING.md`

---

### Issue #1: HTML Extraction Disabled by Default (FIXED ✅)

**Severity**: CRITICAL (P0)
**Component**: Go Crawler Worker
**Status**: ✅ FIXED

**Description**:
The Go Worker's `EXTRACT_HTML` configuration defaulted to `false`, causing the crawler to fetch pages but not extract HTML content. The ingestion worker received empty HTML, causing all documents to be skipped with "No HTML content" error.

**Root Cause**:

```go
// apps/crawler-go-worker/internal/config/config.go:77
ExtractHTML: getEnvBool("EXTRACT_HTML", false),  // ❌ Defaults to false
```

**Fix Applied**:
Set environment variable `EXTRACT_HTML=true` when starting the Go Worker.

**Permanent Fix Needed**:
Change default to `true` or make it a required configuration with validation.

**Impact**:

- Without this fix: 0 documents ingested (100% failure rate)
- With this fix: HTML content flows through pipeline

---

### Issue #2: Readability Removes Too Much Content (❌ OPEN)

**Severity**: CRITICAL (P0)
**Component**: Search-AI Ingestion Pipeline (Readability integration)
**Status**: ❌ OPEN

**Description**:
The Mozilla Readability algorithm is configured too aggressively, removing 92% of legitimate content along with noise. Only 8% of content is preserved, far below the 90%+ target.

**Metrics**:

- Raw HTML size: 24,168 bytes
- Cleaned HTML size: 551 bytes
- Reduction: 98% (should be 40-60%)
- Content Preservation: 8% (should be 90%+)

**Expected Behavior**:
Readability should remove navigation, ads, footers, and sidebar content while preserving the main article/documentation content. For a documentation site like docs.kore.ai, this should retain 90%+ of the meaningful content.

**Actual Behavior**:
Readability is stripping nearly all content, likely treating the main documentation body as "noise" or failing to identify the correct content region.

**Impact**:

- Search results will be incomplete and misleading
- Important documentation content is lost
- Users cannot find information that exists on the original page

**Recommended Actions**:

1. Review Readability configuration parameters
2. Test with different Readability presets (strict vs. lenient)
3. Consider per-domain configuration for documentation sites
4. Add content preservation validation before committing to index
5. Store both raw and cleaned HTML for comparison and debugging

---

### Issue #3: Chunking Pipeline Not Working (❌ OPEN)

**Severity**: CRITICAL (P0)
**Component**: Search-AI Chunking Pipeline
**Status**: ❌ OPEN

**Description**:
The chunking pipeline produced **0 chunks** despite the document being processed. Without chunks, the search functionality is completely blocked - there's nothing to search against.

**Expected Behavior**:
A typical documentation page should produce 10-50 chunks depending on content length and structure.

**Actual Behavior**:
0 chunks created.

**Possible Root Causes**:

1. Chunking worker not running or misconfigured
2. Chunking algorithm failing silently on the cleaned HTML
3. Content too short (551 bytes) after aggressive noise removal
4. Chunking job not enqueued properly
5. Worker error not being logged

**Impact**:

- **Search completely non-functional** - no searchable content exists
- No vector embeddings generated
- No semantic search possible

**Recommended Actions**:

1. Check if chunking worker is running: `GET /api/admin/workers`
2. Review chunking worker logs for errors
3. Check BullMQ queue status for chunking jobs
4. Add minimum content length validation before chunking
5. Add explicit error logging in chunking worker
6. Test chunking with sample cleaned HTML (551 bytes)

---

### Issue #4: Documents Stuck in Pending State (❌ OPEN)

**Severity**: HIGH (P1)
**Component**: Search-AI Ingestion State Machine
**Status**: ❌ OPEN

**Description**:
Documents remained in "Pending" status for over 5 minutes (300+ seconds) instead of transitioning to "Processing" → "Indexed" within seconds. This indicates a pipeline bottleneck or state transition failure.

**Timeline**:

- 0s: Crawl completed, document created (status: "pending")
- 5s-300s: Document stuck in "pending" (no status changes)
- 300s: Test timeout, document still "pending"
- Later: Document eventually processed but never reached "indexed"

**Expected Behavior**:

- Document should transition to "Processing" within 5-10 seconds
- Should reach "Indexed" status within 30-60 seconds

**Possible Root Causes**:

1. Ingestion worker not picking up jobs from queue
2. Worker processing but not updating document status
3. Pipeline stage failing silently without error reporting
4. Redis queue misconfiguration or connection issues
5. MongoDB update failures not being logged

**Impact**:

- Poor user experience (no progress visibility)
- Unclear whether crawl succeeded or failed
- Tests appear to fail even when content is eventually processed

**Recommended Actions**:

1. Add state transition logging to all pipeline stages
2. Monitor BullMQ queues: `GET /api/admin/queues`
3. Check ingestion worker logs for processing activity
4. Add timeout handling with explicit error states
5. Implement progress tracking and status updates
6. Add webhook/SSE for real-time status updates

---

### Issue #5: Zero Documents Reach Indexed Status (❌ OPEN)

**Severity**: CRITICAL (P0)
**Component**: Search-AI Indexing Pipeline
**Status**: ❌ OPEN

**Description**:
No documents successfully reached "Indexed" status, resulting in a 0% success rate. Documents either remain stuck in "Pending" or fail silently without reaching the final indexed state.

**Metrics**:

- Total Documents: 1
- Pending: 1
- Processing: 0
- Indexed: 0
- Failed: 0
- **Success Rate: 0%** (Target: 85%+)

**Expected Behavior**:
At least 85% of successfully crawled pages should reach "Indexed" status and be searchable.

**Actual Behavior**:
0% success rate - no documents are searchable.

**Possible Root Causes**:

1. Chunking failure blocks indexing (see Issue #3)
2. Embedding worker not running or failing silently
3. OpenSearch/vector store not accessible
4. Document validation failing after chunking
5. Race condition in status updates

**Impact**:

- **Search completely non-functional**
- Users cannot find any crawled content
- ROI on crawler investment is zero

**Recommended Actions**:

1. Trace complete pipeline for single document end-to-end
2. Add validation and error logging at each stage
3. Ensure all workers are running: ingestion → chunking → embedding → indexing
4. Check OpenSearch connectivity and index creation
5. Add success/failure counters and metrics
6. Implement retry logic for transient failures

---

## Additional Findings

### Performance Issues

1. **Ingestion Timeout (300s)**
   - Documents took 300+ seconds to process
   - Expected: <60 seconds for single-page ingestion
   - Likely caused by worker misconfiguration or resource contention

2. **No Progress Visibility**
   - Test script had to poll every 5 seconds for status
   - No real-time progress updates
   - Poor developer and end-user experience

### Monitoring Gaps Confirmed

The RFC-001 test confirmed all 8 monitoring gaps previously identified:

1. ✅ **Real-Time Progress** - NO WebSocket/SSE for crawl progress
2. ✅ **Centralized Dashboard** - NO single endpoint for job status
3. ✅ **Queue Monitoring** - NO Bull Board or queue visibility
4. ✅ **Error Tracking** - Errors fail silently, no aggregation
5. ✅ **Quality Metrics API** - NO way to query aggregated quality scores
6. ✅ **Crawl History** - NO audit trail or historical comparisons
7. ✅ **Content Comparison** - Cannot view raw vs. cleaned HTML side-by-side
8. ✅ **Worker Health** - NO visibility into worker status

## Recommendations

### Immediate Actions (P0 - Week 1)

1. **Fix Issue #2: Content Preservation**
   - Review Readability configuration
   - Add content preservation validation
   - Test with lenient Readability settings
   - Target: 90%+ preservation for documentation sites

2. **Fix Issue #3: Chunking**
   - Debug why chunking pipeline produces 0 chunks
   - Ensure chunking worker is running and configured
   - Add chunking error logging
   - Target: 10-50 chunks per documentation page

3. **Fix Issue #5: Indexing**
   - Trace complete pipeline end-to-end
   - Ensure all workers operational
   - Add status transition logging
   - Target: 85%+ documents reach "Indexed" status

### High Priority (P1 - Week 2)

4. **Fix Issue #4: Pending State**
   - Add state transition logging
   - Implement timeout handling
   - Add progress tracking
   - Target: <60s from crawl to indexed

5. **Implement Centralized Dashboard** (Task #13)
   - Single API endpoint for job status
   - Real-time progress updates
   - Error aggregation and reporting

6. **Implement Bull Board** (Task #14)
   - Queue visibility and monitoring
   - Job status tracking
   - Worker health monitoring

### Medium Priority (P2 - Week 3-4)

7. **Implement Real-Time Progress** (Task #16)
   - WebSocket or SSE for progress updates
   - Event-driven status changes
   - Better developer and user experience

8. **Quality Metrics Aggregation** (Task #17)
   - API endpoint for quality metrics across jobs
   - Historical comparison and trending
   - Quality score validation gates

## Test Files Generated

- **Results JSON**: `./test-results/docs.kore.ai-test-1771847359-docs-kore-ai.json`
- **Documents JSON**: `./test-results/docs.kore.ai-test-1771847359-docs-kore-ai-documents.json`
- **Test Logs**: `/tmp/crawler-test-output.log`

## Next Steps

### Immediate Actions

1. ✅ **Review Complete Master Plan**: See `RFC-001-MASTER-TASK-LIST.md` for:
   - All 7 issues documented
   - 15 tasks prioritized across 4 tiers
   - 4-week implementation timeline
   - Critical decisions needed
   - Resource requirements

2. ✅ **Schedule Kickoff Meeting**: Review and get decisions on:
   - **Task #28 (Strategy API)**: Strategy naming, defaults, fallback behavior
   - **Task #19 (Content)**: Readability configuration approach, quality gates
   - **Task #20 (Chunking)**: Root cause investigation plan, acceptance criteria
   - Resource allocation and parallel work opportunities

3. **Start Week 1 (Critical Blockers)**:
   - Task #20: Fix chunking pipeline (0 → 10-50 chunks)
   - Task #19: Fix content preservation (8% → 90%+)
   - Task #21: Fix indexing pipeline (0% → 85%+ success rate)

4. **Start Week 2 (Multi-Page Discovery)**:
   - Task #28: Design crawl strategy API (UX redesign)
   - Task #24: Implement sitemap URL extraction
   - Task #25: Add sitemap expansion to API
   - Task #27: Re-test docs.kore.ai with fixes

### Related Documentation

- **📋 MASTER PLAN**: `RFC-001-MASTER-TASK-LIST.md` - Complete implementation roadmap
- **Issue Details**:
  - Issue #6: `RFC-001-ISSUE-6-SITEMAP-AND-LINK-FOLLOWING.md`
  - Issue #7: `RFC-001-ISSUE-7-CRAWL-STRATEGY-UX.md` (NEW)
- **Monitoring**: `CRAWL_MONITORING_GUIDE.md`
- **Test Scripts**: `scripts/test-crawl-*.sh`

## Conclusion

The RFC-001 crawler test successfully validated the end-to-end crawling pipeline and uncovered **6 critical issues** that prevent the search system from functioning:

1. **Issue #1** (FIXED): HTML extraction disabled by default
2. **Issue #2** (CRITICAL): Content preservation only 8% (should be 90%+)
3. **Issue #3** (CRITICAL): Chunking produces 0 chunks (blocks search)
4. **Issue #4** (HIGH): Documents stuck in pending state for 300+ seconds
5. **Issue #5** (CRITICAL): 0% success rate, no documents reach indexed status
6. **Issue #6** (HIGH): Only 1 page crawled instead of 5 due to missing sitemap URL extraction

While the Go Worker crawling is working correctly (after fixing HTML extraction), the downstream ingestion, processing, and indexing pipeline has severe quality and functionality problems. Additionally, the crawler lacks multi-page discovery capabilities, limiting it to single-URL fetching.

**Key Takeaway**: This test demonstrates the value of end-user testing. Without this RFC-001 test, these issues would have remained hidden until production deployment, causing significant user-facing failures.

**Current Status**: ⚠️ CRAWLER PARTIALLY FUNCTIONAL (single-page only), INGESTION BROKEN
**Recommended Action**: HOLD production deployment until Issues #2, #3, #5, and #6 are resolved.

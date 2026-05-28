# RFC-001 Master Implementation Plan - All Issues and Tasks

**Date**: 2026-02-23
**Status**: Ready for Review and Discussion
**Total Issues**: 7 (1 fixed, 6 open)
**Total Tasks**: 15 tasks across 4 priority tiers

## Executive Summary

RFC-001 crawler testing uncovered **7 critical issues** across crawler discovery, ingestion pipeline, and user experience. This document provides a **complete implementation roadmap** with tasks ordered by priority, dependencies, and business impact.

### Issue Categories

| Category                  | Issues                                          | Status | Impact               |
| ------------------------- | ----------------------------------------------- | ------ | -------------------- |
| **Crawler Configuration** | #7 (Strategy UX)                                | Open   | HIGH - Architectural |
| **Content Discovery**     | #6 (Sitemap/Links)                              | Open   | HIGH - Functional    |
| **Content Processing**    | #2 (Preservation), #3 (Chunking), #5 (Indexing) | Open   | CRITICAL - Blocking  |
| **Pipeline Performance**  | #4 (Pending State)                              | Open   | HIGH - UX            |
| **Worker Configuration**  | #1 (HTML Extraction)                            | Fixed  | -                    |

### Success Metrics (After All Fixes)

| Metric               | Current | Target | Status      |
| -------------------- | ------- | ------ | ----------- |
| Pages Discovered     | 1       | 5+     | ❌ Issue #6 |
| Content Preservation | 8%      | 90%+   | ❌ Issue #2 |
| Chunks Created       | 0       | 10-50  | ❌ Issue #3 |
| Documents Indexed    | 0%      | 85%+   | ❌ Issue #5 |
| Processing Time      | 300s    | <60s   | ❌ Issue #4 |
| Config Clarity       | Complex | Simple | ❌ Issue #7 |

---

## 📋 Complete Issue Breakdown

### Issue #1: HTML Extraction Disabled by Default ✅ FIXED

- **Component**: Go Crawler Worker
- **Severity**: CRITICAL (P0)
- **Status**: ✅ Temporary fix applied
- **Impact**: Without fix, 100% of pages skipped (no HTML content)
- **Remaining**: Task #23 (permanent fix)

### Issue #2: Content Preservation 8% (Should be 90%+) ❌ CRITICAL

- **Component**: Search-AI Readability Integration
- **Severity**: CRITICAL (P0)
- **Impact**: 92% of content lost, search results incomplete
- **Root Cause**: Readability configured too aggressively
- **Task**: #19

### Issue #3: Chunking Produces 0 Chunks ❌ CRITICAL

- **Component**: Search-AI Chunking Pipeline
- **Severity**: CRITICAL (P0)
- **Impact**: Search completely non-functional (no searchable content)
- **Root Cause**: Chunking worker not running or failing silently
- **Task**: #20

### Issue #4: Documents Stuck in Pending (300+ seconds) ❌ HIGH

- **Component**: Search-AI Ingestion State Machine
- **Severity**: HIGH (P1)
- **Impact**: Poor UX, no progress visibility
- **Root Cause**: State transitions not happening, no status updates
- **Task**: #22

### Issue #5: 0% Success Rate (No Documents Indexed) ❌ CRITICAL

- **Component**: Search-AI Indexing Pipeline
- **Severity**: CRITICAL (P0)
- **Impact**: Search completely non-functional
- **Root Cause**: Likely blocked by Issue #3 (chunking failure)
- **Task**: #21

### Issue #6: Only 1 Page Crawled (Should be 5+) ❌ HIGH

- **Component**: Crawler Discovery (Sitemap + Links)
- **Severity**: HIGH (P1)
- **Impact**: Multi-page crawling non-functional
- **Root Cause**:
  - Sitemap detected but URLs not extracted
  - Link following not implemented
  - maxPages/maxDepth options ignored
- **Tasks**: #24, #25, #26, #27

### Issue #7: Confusing Crawl Configuration ❌ HIGH

- **Component**: Crawler API/UX Design
- **Severity**: HIGH (P1 - Architectural)
- **Impact**: Users don't understand maxPages/maxDepth parameters
- **Root Cause**: Technical parameters exposed instead of user-friendly strategies
- **Tasks**: #28

---

## 🎯 Master Task List - Recommended Implementation Order

### ═══════════════════════════════════════════════════════

### TIER 1: CRITICAL BLOCKERS (Week 1-2) - Search Must Work

### ═══════════════════════════════════════════════════════

These tasks are **blocking production deployment**. Search is completely non-functional without them.

---

#### Task #20: Fix Chunking Pipeline (0 → 10-50 chunks)

**Priority**: P0 - CRITICAL BLOCKER
**Component**: Search-AI Chunking Worker
**Estimated Effort**: 2-3 days
**Depends On**: None
**Blocks**: Task #21 (indexing depends on chunks)

**Problem**:

- Chunking worker produces 0 chunks
- Without chunks, there's nothing to search
- Search functionality completely blocked

**Investigation Needed**:

1. Is chunking worker running? Check `/api/admin/workers`
2. Are chunking jobs being enqueued? Check BullMQ queue
3. Is worker processing but failing? Check worker logs
4. Is content too short (551 bytes) after Readability?
5. Is chunking algorithm failing on cleaned HTML?

**Acceptance Criteria**:

- ✅ Chunking worker running and processing jobs
- ✅ 10-50 chunks created per documentation page
- ✅ Chunks stored in database with embeddings
- ✅ Error logging for chunking failures
- ✅ Minimum content length validation

**Why P0**: Search is completely non-functional without chunks. This blocks everything downstream.

**Discussion Points**:

1. Should we have minimum content length requirement before chunking?
2. What's the fallback if chunking fails? Skip document? Retry? Alert?
3. Should chunking be synchronous (blocking) or async (background)?

---

#### Task #19: Fix Content Preservation (8% → 90%+)

**Priority**: P0 - CRITICAL BLOCKER
**Component**: Search-AI Readability Integration
**Estimated Effort**: 3-4 days
**Depends On**: None
**Related**: Task #20 (chunking may be affected by content length)

**Problem**:

- Readability removes 92% of content (keeps only 551 bytes from 24KB)
- Search results incomplete and misleading
- Important documentation content lost

**Investigation Needed**:

1. Review current Readability configuration
2. Test with different Readability presets (strict → lenient)
3. Check if docs.kore.ai has unusual HTML structure
4. Compare with manual content extraction
5. Consider per-domain Readability tuning

**Options to Test**:

```javascript
// Option 1: Lenient Readability settings
const readability = new Readability(document, {
  charThreshold: 25, // Lower threshold (default: 500)
  classesToPreserve: ['content', 'docs', 'article'],
  keepClasses: true, // Preserve semantic classes
});

// Option 2: Custom extractors for documentation sites
if (isDocs(url)) {
  // Use docs-specific content extraction
  content = extractDocsContent(html);
} else {
  content = readability.parse().content;
}

// Option 3: Store both raw + cleaned, let user choose
document.rawHtml = html;
document.cleanedHtml = readability.parse().content;
```

**Acceptance Criteria**:

- ✅ Content preservation >= 90% for documentation sites
- ✅ Noise reduction 40-60% (not 98%)
- ✅ Quality score >= 80/100
- ✅ Main article/docs content fully preserved
- ✅ Navigation/ads/footers properly removed

**Why P0**: Current 8% preservation makes search results incomplete. Critical for quality.

**Discussion Points**:

1. Should we have different Readability configs per site type (docs vs news vs blog)?
2. Should we store both raw + cleaned HTML for comparison/debugging?
3. What's acceptable noise vs content ratio? (Current: 98% noise, 2% content)
4. Should content preservation be a quality gate before indexing?

---

#### Task #21: Fix Document Indexing (0% → 85%+ success rate)

**Priority**: P0 - CRITICAL BLOCKER
**Component**: Search-AI Indexing Pipeline
**Estimated Effort**: 3-5 days
**Depends On**: Task #20 (chunking), Task #19 (content quality)
**Blocks**: None (final stage)

**Problem**:

- 0% of documents reach "Indexed" status
- Documents stuck in "Pending" forever
- Search completely non-functional

**Investigation Needed**:

1. Trace complete pipeline for single document end-to-end
2. Check if embedding worker is running
3. Check OpenSearch connectivity and index creation
4. Review status transition logic for bugs
5. Check for race conditions in status updates

**Pipeline Stages to Verify**:

```
Crawled → Ingested → Cleaned → Chunked → Embedded → Indexed
   ✅        ✅         ❌         ❌         ❌        ❌

Each ✅ or ❌ needs validation
```

**Acceptance Criteria**:

- ✅ >= 85% of crawled documents reach "Indexed" status
- ✅ Clear error reporting for failures (with details)
- ✅ Documents searchable within 60 seconds of crawl
- ✅ Status transitions logged at each stage
- ✅ Failed documents show clear error reason

**Why P0**: This is the final gate - without indexing, all previous work is useless.

**Discussion Points**:

1. Should there be a "Failed" status distinct from "Pending"?
2. What's acceptable success rate? 85%? 90%? 95%?
3. Should failed documents be retryable?
4. How to handle partial failures (some chunks indexed, some failed)?

---

### ═══════════════════════════════════════════════════════

### TIER 2: HIGH PRIORITY - Multi-Page Discovery (Week 2-3)

### ═══════════════════════════════════════════════════════

These tasks enable **multi-page crawling** - critical for real-world use but not blocking if single-page works.

---

#### Task #28: Design and Implement Crawl Strategy API

**Priority**: P1 - HIGH (Architectural)
**Component**: Search-AI Crawl API
**Estimated Effort**: 3-4 days
**Depends On**: None (but should be done before #24/#25)
**Blocks**: Task #24, #25 (strategy informs implementation)
**New**: Added based on Issue #7

**Problem**:

- Current API uses confusing technical parameters (maxPages, maxDepth, followLinks)
- Users don't understand what values to set
- Parameters interact in non-obvious ways
- Implementation details exposed to users

**Proposed Solution**:
Replace technical parameters with user-friendly **crawl strategies**:

```typescript
// NEW: Strategy-based API
{
  "urls": ["https://docs.kore.ai/"],
  "strategy": "smart",  // single-page | sitemap | smart | limited | full-site
  "limits": {
    "maxPages": 100,
    "maxDurationMinutes": 30
  }
}

// OLD: Technical parameters (deprecated)
{
  "urls": ["https://docs.kore.ai/"],
  "options": {
    "maxPages": 50,
    "maxDepth": 3,
    "followLinks": true,
    "useSitemap": true
  }
}
```

**Strategy Definitions**:

1. **`single-page`**: Crawl only provided URLs (no discovery)
2. **`sitemap`**: Use sitemap.xml (error if not found, or fallback)
3. **`smart`** (default): Auto-detect (sitemap if exists, else links)
4. **`limited`**: Crawl N pages using best method
5. **`full-site`**: Crawl everything (requires safety limits)

**Implementation Steps**:

1. **Design API contract** (1 day):
   - Define strategy enum and behavior
   - Design fallback mechanism
   - Define required vs optional limits
   - Backward compatibility plan

2. **Update API endpoint** (1 day):
   - Accept `strategy` field
   - Map old `options` to strategies (backward compat)
   - Validate strategy-specific requirements
   - Return strategy in response

3. **Implement strategy resolver** (1 day):
   - Convert strategy → internal crawl parameters
   - Handle fallback strategies
   - Apply safety limits per strategy

4. **Update documentation** (0.5 days):
   - API docs with strategy examples
   - Migration guide for old API
   - Strategy selection guide

**Acceptance Criteria**:

- ✅ All 5 strategies implemented and tested
- ✅ Old API still works (backward compatible)
- ✅ Strategy behavior clearly documented
- ✅ User testing shows improved clarity

**Why P1-High**: This is architectural - affects how all discovery features are designed. Should be done BEFORE implementing sitemap/link following to avoid rework.

**Discussion Points** (CRITICAL - NEEDS DECISIONS):

1. **Strategy Naming**:
   - `"smart"` vs `"auto"` vs `"intelligent"` for default?
   - `"full-site"` vs `"complete"` vs `"everything"`?
   - User-friendly vs technically accurate?

2. **Default Behavior**:
   - Should API require explicit strategy, or default to `"smart"`?
   - Impact on existing integrations?

3. **Fallback Mechanism**:
   - `strategy: "sitemap"` but no sitemap → fail or fallback to links?
   - Automatic fallback or require explicit `fallbackStrategy`?
   - How to notify user when fallback happens?

4. **Safety Limits**:
   - Should `"smart"` have implicit limits (e.g., 1000 pages)?
   - Or require explicit limits?
   - How to prevent accidental huge crawls?

5. **Pricing Tiers**:
   - Should different strategies have different costs?
   - `"full-site"` clearly more expensive than `"single-page"`
   - Limit strategies per user plan?

6. **Backward Compatibility Timeline**:
   - Support old API indefinitely?
   - Deprecate after 3 months? 6 months?
   - Breaking change vs dual versioning (v1/v2)?

**Why This Task is Critical**:

- Affects API contract (public interface)
- Informs implementation of all discovery features
- Major UX improvement
- Architectural decision that's hard to change later

---

#### Task #24: Implement Sitemap URL Extraction in FastProfiler

**Priority**: P1 - HIGH
**Component**: @abl/crawler FastProfiler
**Estimated Effort**: 1-2 days
**Depends On**: Task #28 (strategy design)
**Blocks**: Task #25 (API needs this method)

**Problem**:

- FastProfiler detects sitemap exists (boolean)
- Doesn't extract actual URLs from sitemap
- Only uses sitemap for size estimation

**Required Implementation**:

```typescript
class FastProfiler {
  // NEW method
  async extractSitemapUrls(
    url: string,
    options?: {
      maxUrls?: number;
      priorityThreshold?: number; // Only URLs with priority >= X
      modifiedSince?: Date; // Only URLs modified after date
    },
  ): Promise<string[]> {
    // 1. Fetch sitemap.xml
    // 2. Check if it's sitemap index (<sitemapindex>)
    //    - If yes: recursively fetch child sitemaps
    // 3. Parse XML and extract <loc> elements
    // 4. Sort by <priority> (high first) and <lastmod> (recent first)
    // 5. Return up to maxUrls
  }
}
```

**Handle Sitemap Index** (like docs.kore.ai):

```xml
<!-- https://docs.kore.ai/sitemap.xml -->
<sitemapindex>
  <sitemap>
    <loc>https://docs.kore.ai/page-sitemap.xml</loc>
  </sitemap>
  <sitemap>
    <loc>https://docs.kore.ai/addl-sitemap.xml</loc>
  </sitemap>
</sitemapindex>

<!-- Recursive fetch → merge URLs from all child sitemaps -->
```

**Acceptance Criteria**:

- ✅ Extracts URLs from simple sitemap
- ✅ Handles sitemap indexes recursively
- ✅ Respects maxUrls limit
- ✅ Sorts by priority and lastmod
- ✅ Timeout handling (5s per sitemap)
- ✅ Error handling for malformed XML
- ✅ 100% test coverage

**Why P1**: Enables efficient multi-page crawling for 90% of sites (most have sitemaps).

**Discussion Points**:

1. Should we cache sitemap URLs? (sitemaps change infrequently)
2. How to handle very large sitemaps (100K+ URLs)?
3. Should we respect `<changefreq>` for re-crawl scheduling?

---

#### Task #25: Add Sitemap URL Expansion to Crawl API

**Priority**: P1 - HIGH
**Component**: Search-AI Crawl Routes
**Estimated Effort**: 1 day
**Depends On**: Task #24 (needs extractSitemapUrls method), Task #28 (strategy design)
**Blocks**: Task #27 (re-test needs this)

**Problem**:

- API only uses URLs provided in request body
- Doesn't expand from sitemap even when detected
- User must manually build URL lists

**Required Implementation**:

```typescript
// In POST /api/crawl/batch

// After profiling
const profile = await profiler.profile(targetUrl);

// NEW: Strategy-based URL expansion
if (strategy === 'sitemap' || strategy === 'smart') {
  if (profile.metadata.hasSitemap) {
    const sitemapUrls = await profiler.extractSitemapUrls(targetUrl, {
      maxUrls: limits.maxPages || 50,
    });

    if (sitemapUrls.length > 0) {
      console.log(`[crawl] Expanded URLs: ${urls.length} → ${sitemapUrls.length}`);
      urls = sitemapUrls;
      expansionMethod = 'sitemap';
    } else if (strategy === 'sitemap') {
      // Required sitemap but none found
      if (fallbackStrategy) {
        strategy = fallbackStrategy;
      } else {
        return error('No sitemap found');
      }
    }
  } else if (strategy === 'sitemap' && !fallbackStrategy) {
    return error('No sitemap found and no fallback specified');
  }
}

// Response includes expansion info
res.json({
  jobId,
  urls: urls.length,
  urlsExpanded: true,
  expansionMethod: 'sitemap', // or 'links' or 'none'
  strategy: 'smart',
});
```

**Acceptance Criteria**:

- ✅ Single URL + sitemap → URLs expanded automatically
- ✅ Multiple URLs → No expansion (already have URLs)
- ✅ No sitemap + strategy="smart" → Graceful handling
- ✅ strategy="sitemap" + no sitemap → Error or fallback
- ✅ maxPages properly limits expanded URLs
- ✅ Response indicates expansion method

**Why P1**: Completes sitemap support - discovery + expansion together.

**Discussion Points**:

1. Should expansion happen on every request, or cache sitemap URLs?
2. What if sitemap has 10K URLs but maxPages=100? Which 100?
3. Should we deduplicate if user provides URLs also in sitemap?

---

#### Task #27: Re-test docs.kore.ai with Sitemap Support

**Priority**: P1 - HIGH (Validation)
**Component**: End-to-End Testing
**Estimated Effort**: 2-3 hours
**Depends On**: Task #24, Task #25, Task #28
**Blocks**: None (validation only)

**Purpose**: Validate that sitemap support resolves Issue #6

**Test Execution**:

```bash
# Same test as initial RFC-001
./scripts/test-crawl-site.sh "https://docs.kore.ai/" "docs.kore.ai" 5 1

# With new strategy API
curl -X POST http://localhost:3001/api/crawl/batch \
  -H "Content-Type: application/json" \
  -d '{
    "urls": ["https://docs.kore.ai/"],
    "strategy": "sitemap",
    "limits": { "maxPages": 5 },
    "tenantId": "tenant-1",
    "indexId": "...",
    "sourceId": "..."
  }'
```

**Expected Results**:

| Metric            | Initial Test | After Sitemap | Change           |
| ----------------- | ------------ | ------------- | ---------------- |
| URLs Provided     | 1            | 1             | -                |
| URLs Expanded     | 0            | 5             | ✅ +5            |
| Pages Crawled     | 1            | 5             | ✅ +400%         |
| Sitemap Detected  | Yes          | Yes           | -                |
| Sitemap URLs Used | No           | Yes           | ✅ Fixed         |
| Page Types        | 1 (homepage) | 5 (varied)    | ✅ Better sample |

**Acceptance Criteria**:

- ✅ 5 pages crawled (up from 1)
- ✅ Sitemap expansion logged
- ✅ Quality metrics more representative
- ✅ Test duration <2 minutes
- ✅ No regressions in other issues

**Why P1**: Validates that multi-page discovery works before moving to next features.

---

### ═══════════════════════════════════════════════════════

### TIER 3: MEDIUM PRIORITY - Pipeline UX (Week 3-4)

### ═══════════════════════════════════════════════════════

These improve **user experience** but aren't blocking if core functionality works.

---

#### Task #22: Fix Document State Transitions (300s → <60s)

**Priority**: P2 - MEDIUM
**Component**: Search-AI Ingestion State Machine
**Estimated Effort**: 2-3 days
**Depends On**: Task #19, #20, #21 (root cause may be in those)
**Blocks**: None

**Problem**:

- Documents stuck in "Pending" for 300+ seconds
- Should transition Pending → Processing → Indexed within 60s
- No progress visibility, unclear if working or stuck

**Investigation Needed**:

1. Add logging to every state transition
2. Monitor BullMQ queue depths
3. Check if workers are picking up jobs
4. Verify MongoDB status updates are happening
5. Check for race conditions in status updates

**Acceptance Criteria**:

- ✅ Documents reach "Indexed" within 60 seconds
- ✅ State transitions logged at each stage
- ✅ Clear progress visibility
- ✅ Timeout handling (explicit "Failed" after 2 min)

**Why P2**: Functional impact is low if documents eventually process, but UX is poor.

**Discussion Points**:

1. Should we have granular states (Pending → Cleaning → Chunking → Embedding → Indexing)?
2. Should state updates be synchronous (blocking) or async (eventual consistency)?

---

#### Task #13: Implement Centralized Crawl Dashboard API

**Priority**: P2 - MEDIUM
**Component**: Search-AI Admin API
**Estimated Effort**: 1-2 days
**Depends On**: None
**Blocks**: None

**Problem**:

- No single endpoint to get complete crawl job status
- Must query multiple endpoints for full picture
- Poor monitoring experience

**Proposed Endpoint**:

```typescript
GET /api/crawl/dashboard/{jobId}

Response:
{
  job: {
    id: "...",
    status: "processing",
    startedAt: "...",
    completedAt: null,
    duration: 45000,  // ms
    strategy: "smart",
    urls: {
      total: 5,
      crawled: 5,
      succeeded: 5,
      failed: 0
    }
  },
  crawl: {
    pagesProcessed: 5,
    avgResponseTime: 350,
    errors: []
  },
  ingestion: {
    documentsCreated: 5,
    pending: 0,
    processing: 2,
    indexed: 3,
    failed: 0
  },
  quality: {
    avgQualityScore: 85,
    avgNoiseReduction: 55,
    avgContentPreservation: 92,
    avgChunksPerDoc: 25
  }
}
```

**Acceptance Criteria**:

- ✅ Single API call returns complete status
- ✅ Real-time metrics (updated every 5s)
- ✅ Error aggregation and details

**Why P2**: Nice to have for monitoring, but test scripts can poll individual endpoints.

---

#### Task #14: Implement BullMQ Queue Monitoring (Bull Board)

**Priority**: P2 - MEDIUM
**Component**: Search-AI Admin Dashboard
**Estimated Effort**: 1 day
**Depends On**: None
**Blocks**: None

**Problem**:

- No visibility into queue depths, processing rates, failures
- Can't debug why jobs are stuck

**Proposed Solution**:
Add Bull Board UI at `/admin/queues`

**Acceptance Criteria**:

- ✅ Bull Board UI accessible
- ✅ Shows all queues (static-crawl, content-processing, etc.)
- ✅ Job details, retry counts, error logs

**Why P2**: Developer/ops tool, not user-facing.

---

#### Task #15: Implement Error Tracking and Retry System

**Priority**: P2 - MEDIUM
**Component**: Search-AI Pipeline Workers
**Estimated Effort**: 2-3 days
**Depends On**: Task #19, #20, #21 (need to fix errors first)
**Blocks**: None

**Problem**:

- Errors fail silently, no aggregation
- No automatic retry for transient failures

**Acceptance Criteria**:

- ✅ All errors logged with context
- ✅ Automatic retry for transient failures (3x)
- ✅ Error aggregation API endpoint

**Why P2**: Important for production stability, but not blocking initial deployment.

---

### ═══════════════════════════════════════════════════════

### TIER 4: LOW PRIORITY - Advanced Features (Week 5+)

### ═══════════════════════════════════════════════════════

These are **nice-to-have** features that can wait until core functionality is solid.

---

#### Task #26: Implement Link Following in Go Worker

**Priority**: P3 - LOW
**Component**: Go Crawler Worker
**Estimated Effort**: 3-5 days
**Depends On**: Task #28 (strategy design)
**Blocks**: None

**Problem**:

- Go Worker only crawls provided URLs
- Can't discover pages on sites without sitemaps

**Why P3-Low**:

- Most documentation sites have sitemaps (Task #24/#25 covers 90% of cases)
- Link following is complex and risky (infinite loops, external links, etc.)
- Can be added later without affecting existing functionality

**Acceptance Criteria**:

- ✅ followLinks option actually follows links
- ✅ maxPages and maxDepth enforced
- ✅ URL deduplication
- ✅ Same-domain filtering

**Discussion Points**:

1. Should this be in Go Worker or orchestrated from Search-AI?
2. BFS vs DFS traversal strategy?

---

#### Task #16: Implement Real-Time Progress WebSocket/SSE

**Priority**: P3 - LOW
**Component**: Search-AI API
**Estimated Effort**: 2-3 days
**Depends On**: None
**Blocks**: None

**Problem**:

- No real-time progress updates
- Test scripts must poll every 5 seconds

**Why P3**: Nice UX improvement but polling works fine.

---

#### Task #17: Implement Quality Metrics Aggregation API

**Priority**: P3 - LOW
**Component**: Search-AI Analytics
**Estimated Effort**: 1-2 days
**Depends On**: Task #19, #20 (need quality data first)
**Blocks**: None

**Problem**:

- No API to get aggregated quality metrics across jobs
- Can't track quality trends over time

**Why P3**: Analytics feature, not critical for core functionality.

---

#### Task #18: Implement Crawl History and Audit Trail

**Priority**: P3 - LOW
**Component**: Search-AI Database
**Estimated Effort**: 2-3 days
**Depends On**: None
**Blocks**: None

**Problem**:

- No historical record of crawls
- Can't compare quality over time

**Why P3**: Audit/compliance feature, can be added later.

---

#### Task #23: Permanent Fix for EXTRACT_HTML Default

**Priority**: P3 - LOW
**Component**: Go Crawler Worker Config
**Estimated Effort**: 1-2 hours
**Depends On**: None
**Blocks**: None

**Problem**:

- Temporary fix applied (env var)
- Should change default to true in code

**Why P3**: Already working with temp fix, low risk.

---

## 📊 Implementation Timeline

### Recommended Sprint Schedule

```
WEEK 1: Critical Blockers (Search Must Work)
├─ Mon-Tue:   Task #20 (Chunking) ████████░░
├─ Wed-Thu:   Task #19 (Content Preservation) ████████░░
└─ Fri:       Task #21 (Indexing) start █████░░░░░

WEEK 2: Finish Blockers + Start Discovery
├─ Mon-Tue:   Task #21 (Indexing) finish ████████░░
├─ Wed:       Task #28 (Strategy Design) ██████████
├─ Thu:       Task #24 (Sitemap Extraction) ████████░░
└─ Fri:       Task #25 (API Expansion) ██████████

WEEK 3: Validation + Pipeline UX
├─ Mon:       Task #27 (Re-test) ██████████
├─ Tue-Wed:   Task #22 (State Transitions) ████████░░
├─ Thu:       Task #13 (Dashboard API) ██████████
└─ Fri:       Task #14 (Bull Board) ██████████

WEEK 4: Stabilization + Advanced
├─ Mon-Tue:   Task #15 (Error Tracking) ████████░░
├─ Wed-Fri:   Buffer for issues / tech debt
└─ Planning for Task #26 (Link Following)

WEEK 5+: Advanced Features (as needed)
└─ Tasks #16, #17, #18, #26 (prioritize based on feedback)
```

### Parallel Work Opportunities

**Week 1-2**: Two parallel tracks possible

- Track A (Backend): Tasks #19, #20, #21 (Search pipeline)
- Track B (Crawler): Tasks #28, #24, #25 (Discovery)

**Week 3**: Sequential (validation depends on previous work)

---

## 🎬 Go/No-Go Decision Points

### Checkpoint 1 (End of Week 1): Search Functionality

**Can we index and search a single document?**

- ✅ Chunking works (Task #20)
- ✅ Content preservation >= 80% (Task #19)
- ✅ Documents reach indexed status (Task #21)
- **Decision**: GO → Continue to multi-page. NO-GO → Extend Week 1.

### Checkpoint 2 (End of Week 2): Multi-Page Discovery

**Can we crawl multiple pages from a site?**

- ✅ Sitemap URL extraction works (Task #24)
- ✅ API expands URLs correctly (Task #25)
- ✅ Strategy API implemented (Task #28)
- **Decision**: GO → Start validation. NO-GO → Extend Week 2.

### Checkpoint 3 (End of Week 3): Production Readiness

**Is the system ready for limited production use?**

- ✅ Re-test shows 5+ pages crawled with good quality (Task #27)
- ✅ State transitions work smoothly (Task #22)
- ✅ Monitoring in place (Tasks #13, #14)
- **Decision**: GO → Limited production release. NO-GO → Extend Week 3.

---

## 💰 Resource Requirements

### Team Composition (Recommended)

**Week 1-2 (Critical Phase)**:

- 2x Backend Engineers (Search-AI pipeline)
- 1x Backend Engineer (Crawler/Go Worker)
- 1x QA Engineer (Testing)
- 0.5x DevOps (Monitoring setup)

**Week 3-4 (Validation & Polish)**:

- 1x Backend Engineer
- 1x QA Engineer
- 0.5x DevOps

**Total Effort**: ~6-8 engineer-weeks for Tier 1-3 tasks

---

## ⚠️ Risks and Mitigations

### Risk 1: Chunking Root Cause Unknown

**Risk**: Task #20 investigation may reveal deeper issues
**Impact**: HIGH - Blocks everything
**Mitigation**: Start investigation immediately (Day 1), escalate if stuck after 1 day

### Risk 2: Readability Not Tunable

**Risk**: Task #19 - Readability may not be fixable with config
**Impact**: HIGH - Search quality suffers
**Mitigation**: Have backup plan (custom content extractors per site type)

### Risk 3: Strategy API Design Disagreement

**Risk**: Task #28 - Team doesn't agree on strategy names/behavior
**Impact**: MEDIUM - Delays discovery features
**Mitigation**: Schedule design review meeting (Week 1), get PM/UX input

### Risk 4: Sitemap Complexity Underestimated

**Risk**: Task #24 - Real-world sitemaps more complex than expected
**Impact**: MEDIUM - Multi-page crawling delayed
**Mitigation**: Test against 5-10 real sites early, adjust estimates

### Risk 5: Dependencies Between Issues

**Risk**: Issues may be more interconnected than expected
**Impact**: MEDIUM - Sequential work takes longer
**Mitigation**: Daily standups, quick escalation if blockers found

---

## 📝 Open Questions for Team Discussion

### Architecture Questions

1. **Crawl Strategy Design** (Task #28):
   - Strategy naming conventions?
   - Default strategy behavior?
   - Fallback mechanism design?
   - Backward compatibility timeline?
   - **Decision Needed By**: Before starting Task #24

2. **Content Processing Philosophy** (Task #19):
   - One Readability config for all sites, or per-site-type?
   - Store raw + cleaned HTML, or just cleaned?
   - Content preservation as quality gate?
   - **Decision Needed By**: Week 1 Day 1

3. **State Machine Design** (Task #22):
   - Granular states vs simple states?
   - Synchronous vs async status updates?
   - Timeout and retry policies?
   - **Decision Needed By**: Week 3

### Product Questions

1. **Success Criteria**:
   - What's acceptable content preservation? 90%? 95%?
   - What's acceptable indexing success rate? 85%? 95%?
   - What's acceptable processing time? 60s? 120s?
   - **Decision Needed By**: Week 1 Day 1

2. **Pricing Implications**:
   - Should different crawl strategies have different costs?
   - Limits per pricing tier?
   - How to handle full-site crawls (potentially expensive)?
   - **Decision Needed By**: Before Task #28

3. **User Experience**:
   - Should strategy be required or have smart default?
   - How to communicate fallback strategies to users?
   - Error messages and user guidance?
   - **Decision Needed By**: Week 2

---

## ✅ Success Criteria (Overall)

### Functional Requirements

- ✅ Single-page crawl works with 90%+ content preservation
- ✅ Multi-page crawl discovers 5+ pages from sitemap
- ✅ Chunking produces 10-50 chunks per page
- ✅ 85%+ of documents reach indexed status
- ✅ Documents indexed within 60 seconds
- ✅ Strategy-based API is clear and intuitive

### Quality Metrics

- ✅ Content preservation: 90%+ for documentation sites
- ✅ Noise reduction: 40-60% (not 98%)
- ✅ Overall quality score: 80+/100
- ✅ Success rate: 85%+ documents indexed

### User Experience

- ✅ Crawl strategy selection is intuitive
- ✅ Progress visibility (real-time or polling)
- ✅ Clear error messages
- ✅ Documentation with examples

### Performance

- ✅ Single page: <10 seconds
- ✅ 5 pages: <60 seconds
- ✅ Sitemap parsing: <5 seconds for 1000 URLs

---

## 📚 Related Documentation

- `RFC-001-TEST-RESULTS.md` - Initial test findings (all 7 issues)
- `RFC-001-ISSUE-6-SITEMAP-AND-LINK-FOLLOWING.md` - Multi-page discovery
- `RFC-001-ISSUE-7-CRAWL-STRATEGY-UX.md` - Strategy design (NEW)
- `CRAWL_MONITORING_GUIDE.md` - Current monitoring capabilities
- Test scripts: `scripts/test-crawl-*.sh`

---

## Conclusion

This master plan provides a **complete roadmap** from current state (broken pipeline) to production-ready crawler with intelligent multi-page discovery.

**Key Priorities**:

1. **Week 1-2**: Fix search pipeline (Tasks #19, #20, #21) - CRITICAL
2. **Week 2-3**: Enable multi-page discovery (Tasks #28, #24, #25) - HIGH
3. **Week 3-4**: Polish UX and monitoring (Tasks #22, #13, #14) - MEDIUM
4. **Week 5+**: Advanced features as needed (Tasks #16-18, #26) - LOW

**Critical Dependencies**:

- Task #28 (Strategy Design) should be done BEFORE #24/#25 (implementation)
- Task #20 (Chunking) blocks Task #21 (Indexing)
- All Tier 1 tasks block production deployment

**Next Step**: Schedule kickoff meeting to review, get decisions on open questions, and assign tasks.

# RFC-001 Issue #6: Sitemap Detection and Link Following Not Implemented

**Severity**: HIGH (P1)
**Components**: Search-AI Crawl API, @abl/crawler FastProfiler, Go Crawler Worker
**Date**: 2026-02-23

## Executive Summary

The RFC-001 crawler test for docs.kore.ai revealed that only **1 page was crawled** despite:

- Site having a comprehensive sitemap.xml with multiple URLs
- Test configuration specifying `maxPages: 5` and `maxDepth: 1`
- Option `followLinks: true` being set

**Root Cause**: The crawler has **partial sitemap detection** but **no URL extraction**, and the Go Worker **does not follow links** from crawled pages.

## Expected vs Actual Behavior

### Expected (Based on Test Configuration)

```bash
Start URL: https://docs.kore.ai/
Max Pages: 5
Max Depth: 1
Follow Links: true
```

**Expected Behavior:**

1. Detect sitemap at https://docs.kore.ai/sitemap.xml ✅ (detection works)
2. Extract URLs from sitemap ❌ (not implemented)
3. OR follow links from the homepage to discover additional pages ❌ (not implemented)
4. Crawl up to 5 pages total respecting maxDepth ❌ (option ignored)

### Actual Behavior

- Only **1 page crawled**: https://docs.kore.ai/
- Sitemap detected but URLs not extracted
- Links not followed despite `followLinks: true`
- `maxPages` and `maxDepth` options passed but ignored

## Technical Analysis

### 1. Sitemap Detection Exists (Partial)

**Location**: `packages/crawler/src/profiler/fast-profiler.ts`

The FastProfiler DOES detect sitemaps:

```typescript
// Line 54: Sitemap check
const [html, robotsTxt, sitemapExists] = await Promise.all([
  this.fetchHTML(url, timeout),
  this.fetchRobotsTxt(url),
  this.checkSitemap(url),  // ✅ Detects sitemap existence
]);

// Line 287-296: Sitemap detection
private async checkSitemap(url: string): Promise<boolean> {
  try {
    const sitemapUrl = new URL('/sitemap.xml', url).toString();
    await axios.head(sitemapUrl, {
      timeout: 3000,
      headers: { 'User-Agent': this.userAgent },
    });
    return true;  // ✅ Returns true if sitemap exists
  } catch {
    return false;
  }
}

// Line 303-316: Sitemap parsing for SIZE ESTIMATION ONLY
private async estimateSizeFromSitemap(url: string): Promise<number> {
  try {
    const sitemapUrl = new URL('/sitemap.xml', url).toString();
    const response = await axios.get(sitemapUrl, {
      timeout: 5000,
      headers: { 'User-Agent': this.userAgent },
    });
    const $ = cheerio.load(response.data, { xmlMode: true });
    const urlCount = $('url, sitemap').length;
    return urlCount || 50;  // ⚠️ Only counts URLs, doesn't extract them
  } catch {
    return 50;
  }
}
```

**What's Missing:**

- ❌ No method to extract actual URLs from sitemap
- ❌ No support for sitemap index (docs.kore.ai has `/sitemap.xml` pointing to `/page-sitemap.xml`)
- ❌ No recursive sitemap parsing for sitemap indexes
- ❌ URLs from sitemap not returned to caller

### 2. Go Worker Only Processes Provided URLs

**Location**: `apps/crawler-go-worker/internal/processor/processor.go`

```go
// Line 30-36: ProcessJob only crawls URLs from job
func (p *Processor) ProcessJob(job types.CrawlJob) (types.BatchResult, error) {
    log.Printf("Processing batch %s with %d URLs", job.BatchID, len(job.URLs))

    startTime := time.Now()

    // ❌ Only crawls exact URLs provided, doesn't discover more
    results := p.crawler.CrawlBatch(job.URLs)

    // ... rest of processing
}
```

**What's Missing:**

- ❌ No link extraction from crawled pages
- ❌ No URL queue expansion based on discovered links
- ❌ `maxPages` and `maxDepth` from job options are received but ignored
- ❌ `followLinks` option received but not used

### 3. Crawl API Passes Through Options Without Using Them

**Location**: `apps/search-ai/src/routes/crawl.ts`

```typescript
// Line 318-337: Job submission
const job = await queue.add('crawl-batch', {
  urls, // ⚠️ Only the URLs from request body
  options: {
    maxDepth: options.maxDepth ?? 3, // ❌ Passed but not used
    followLinks: options.followLinks ?? true, // ❌ Passed but not used
    extractMetadata: options.extractMetadata ?? true,
    maxPages: options.maxPages ?? 50, // ❌ Passed but not used
    // ...
  },
  // ...
});
```

**What's Missing:**

- ❌ No URL expansion before job submission
- ❌ Sitemap URLs not fetched and added to job
- ❌ No pre-crawl URL discovery phase
- ❌ Options passed to Go Worker but never used

## Real-World Site Analysis: docs.kore.ai

### Sitemap Structure

```bash
# Root sitemap (sitemap index)
https://docs.kore.ai/sitemap.xml
  ├── https://docs.kore.ai/addl-sitemap.xml
  └── https://docs.kore.ai/page-sitemap.xml

# Page sitemap contains actual URLs
https://docs.kore.ai/page-sitemap.xml
  ├── https://docs.kore.ai/
  ├── https://docs.kore.ai/register/
  ├── https://docs.kore.ai/edit-profile/
  ├── https://docs.kore.ai/log-in/
  └── ... (many more pages)
```

### What Should Have Happened

**With Sitemap URL Extraction:**

1. Detect sitemap at `/sitemap.xml`
2. Parse sitemap index → find `/page-sitemap.xml`
3. Parse page sitemap → extract 5 URLs (respecting maxPages)
4. Submit all 5 URLs to Go Worker
5. **Result: 5 pages crawled** ✅

**With Link Following (alternative approach):**

1. Crawl homepage: https://docs.kore.ai/
2. Extract links from homepage
3. Queue up to 4 more URLs (maxPages - 1) at depth 1
4. Crawl discovered URLs
5. **Result: 5 pages crawled** ✅

### What Actually Happened

1. Only 1 URL provided: `["https://docs.kore.ai/"]`
2. Sitemap detected (hasSitemap: true) but URLs not extracted
3. Homepage crawled successfully
4. Links extracted but not followed
5. **Result: 1 page crawled** ❌

## Impact Assessment

### Functional Impact

- **HIGH**: Crawler cannot discover content beyond explicitly provided URLs
- Documentation sites with hundreds/thousands of pages require manual URL entry
- Multi-page crawl jobs are non-functional without pre-built URL lists
- `maxPages`, `maxDepth`, and `followLinks` options are misleading (accepted but ignored)

### User Experience Impact

- **MEDIUM**: Users expect "crawl this site" to mean "discover and crawl pages", not "crawl only this exact URL"
- Sitemap-based crawling is standard crawler behavior - users will expect it
- Need to manually build URL lists defeats the purpose of a crawler

### RFC-001 Test Impact

- Test specified crawling up to 5 pages from docs.kore.ai
- Only 1 page crawled means we tested 20% of intended coverage
- Quality metrics (8% content preservation, 0 chunks) are based on single-page sample
- May not represent quality across diverse page types

## Proposed Solutions

### Solution 1: Sitemap URL Extraction (Recommended)

**Pros:**

- Most efficient for well-structured sites
- No extra HTTP requests (sitemap lists all URLs)
- Respects site structure and prioritization
- Standard approach for documentation sites

**Cons:**

- Requires sitemap presence (though most modern sites have them)
- Need to handle sitemap indexes and recursive parsing

**Implementation:**

1. Add `extractSitemapUrls()` method to FastProfiler
2. Parse sitemap XML and return array of URLs
3. Handle sitemap indexes (recursively fetch child sitemaps)
4. Respect `<priority>` and `<lastmod>` for URL ordering
5. Add sitemap URLs to job URL list before submission

**Estimated Effort**: 1-2 days

### Solution 2: Link Following in Go Worker

**Pros:**

- Works for sites without sitemaps
- Discovers dynamic content
- Respects crawl depth and breadth-first/depth-first strategies

**Cons:**

- More HTTP requests (need to fetch pages to find links)
- Complex state management (visited URLs, queue, depth tracking)
- Potential for exponential URL explosion without good filtering

**Implementation:**

1. Add link extraction and queuing to Colly crawler
2. Implement BFS/DFS traversal with maxDepth respect
3. Add URL deduplication and filtering
4. Respect maxPages limit across all discovered URLs
5. Update job status as URLs are discovered

**Estimated Effort**: 3-5 days

### Solution 3: Hybrid Approach (Best Long-Term)

**Pros:**

- Best of both worlds: efficient sitemap crawling + link following for discovery
- Handles all site types
- Most feature-complete

**Cons:**

- Most complex to implement
- Requires coordination between both approaches

**Implementation:**

1. Implement Solution 1 (sitemap extraction) first
2. If sitemap doesn't cover all pages, fall back to link following
3. Use sitemap as seed URLs, then follow links for deeper discovery
4. Combine and deduplicate URLs from both sources

**Estimated Effort**: 5-7 days

## Recommended Implementation Order

### Phase 1: Sitemap URL Extraction (Week 1) - HIGH PRIORITY

- Task #24: Implement sitemap URL extraction in FastProfiler
- Task #25: Add sitemap URL expansion to Search-AI crawl API
- Task #26: Test with docs.kore.ai and other documentation sites

### Phase 2: Link Following (Week 2-3) - MEDIUM PRIORITY

- Task #27: Implement link following in Go Worker
- Task #28: Add maxPages and maxDepth enforcement
- Task #29: Add URL filtering and deduplication

### Phase 3: Hybrid Optimization (Week 4) - LOW PRIORITY

- Task #30: Combine sitemap + link following strategies
- Task #31: Add crawl strategy selection based on site profile

## Test Plan

### Sitemap Extraction Tests

1. **Simple Sitemap**: Single sitemap.xml with <10 URLs
2. **Sitemap Index**: Multiple sitemaps (like docs.kore.ai)
3. **Large Sitemap**: 1000+ URLs, test maxPages limiting
4. **Nested Sitemap**: 3-level sitemap hierarchy
5. **No Sitemap**: Fall back gracefully

### Link Following Tests

1. **Single Page**: No links, should return 1 page
2. **Depth 1**: Homepage with 10 links, maxPages=5
3. **Depth 2**: Multi-level site structure
4. **Circular Links**: Handle revisited URLs
5. **External Links**: Filter out external domains

### Integration Tests

1. **docs.kore.ai**: Sitemap-based crawl, expect 5 pages
2. **docs.python.org**: Large sitemap, test maxPages=100
3. **developer.mozilla.org**: Hybrid crawl (sitemap + links)
4. **Blog site**: Link following without sitemap
5. **SPA**: Test with JS-rendered content

## Success Criteria

### Functional Requirements

- ✅ Sitemap detection returns array of URLs (not just boolean)
- ✅ Sitemap index parsing (recursive)
- ✅ maxPages option enforced (stops at limit)
- ✅ maxDepth option enforced (no URLs beyond depth)
- ✅ followLinks option actually follows links
- ✅ URL deduplication works correctly

### Quality Metrics (Re-test docs.kore.ai)

- ✅ 5 pages crawled (up from 1)
- ✅ Diverse page types tested (homepage, docs pages, guides)
- ✅ Quality metrics more representative
- ✅ Chunking tested across multiple page types

### Performance Targets

- Sitemap parsing: <2 seconds for 1000 URLs
- Link following: <5 seconds per page
- Total crawl time: <30 seconds for 5 pages

## Related Issues

- **Issue #2** (Content Preservation): May be affected by page type diversity
- **Issue #3** (Chunking): Need multiple pages to validate chunking across content types
- **Issue #4** (Pending State): Multi-page crawls will stress ingestion pipeline

## Conclusion

The crawler currently has **partial sitemap detection** but lacks the critical URL extraction functionality that makes it useful. The Go Worker is designed as a **batch URL fetcher**, not a **recursive crawler**, which limits its utility for real-world crawling scenarios.

**Immediate Action Required**: Implement sitemap URL extraction (Solution 1) to unblock multi-page crawling for documentation sites - the primary use case identified in RFC-001.

**Current Status**: ⚠️ SINGLE-PAGE CRAWLER ONLY
**Target Status**: ✅ MULTI-PAGE CRAWLER WITH SITEMAP SUPPORT
**Recommended Timeline**: 1-2 weeks (Phase 1 + Phase 2)

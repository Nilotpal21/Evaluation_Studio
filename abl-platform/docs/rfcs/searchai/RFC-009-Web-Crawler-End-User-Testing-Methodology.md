# RFC-001: Crawler End-User Testing & Quality Validation

**Status:** Draft
**Author:** Platform Team
**Created:** 2025-02-23
**Updated:** 2025-02-23

## Summary

Conduct comprehensive end-user testing of the web crawler to validate quality, identify gaps, and measure improvements from the Readability + Quality Metrics integration. Test against diverse real-world websites to ensure production readiness.

## Motivation

The crawler has undergone significant improvements:

- Mozilla Readability integration (noise removal)
- Dual HTML storage (raw + cleaned)
- Quality metrics service
- 3-stage adaptive chunking

Before deploying to production, we need to validate these improvements work correctly across different website types and identify remaining gaps from an end-user perspective.

## Goals

1. **Validate Quality Improvements**: Measure actual vs. expected improvements in noise reduction and content preservation
2. **Identify Edge Cases**: Find website types where the crawler struggles
3. **Measure User Experience**: Track transparency, failure detection, and error recovery
4. **Prioritize Improvements**: Create data-driven roadmap for next iteration

## Non-Goals

- Performance benchmarking (covered separately)
- Load testing (covered separately)
- Security testing (covered separately)

---

## Test Methodology

### Test Categories

#### Category A: Documentation Sites (High Priority)

Well-structured technical documentation with consistent layouts.

**Test Sites:**

1. **docs.kore.ai** - Target use case
2. **docs.python.org** - Complex nested structure
3. **developer.mozilla.org** - Large scale, rich content
4. **reactjs.org/docs** - Modern SPA patterns

**Expected Behavior:**

- High quality scores (85-95)
- Excellent content preservation (>95%)
- Good noise reduction (40-60%)
- Accurate heading/structure extraction

#### Category B: News/Blog Sites (Medium Priority)

Content-heavy sites with ads, navigation, sidebars.

**Test Sites:**

1. **techcrunch.com/article** - Heavy ads, tracking scripts
2. **medium.com/article** - Paywalls, popups
3. **arstechnica.com** - Mix of content and ads
4. **blog.cloudflare.com** - Technical blogs

**Expected Behavior:**

- Moderate quality scores (70-85)
- Heavy noise reduction (60-80%)
- Content preservation challenges due to paywalls
- Many nav/aside/footer elements removed

#### Category C: E-commerce Sites (Medium Priority)

Product pages with reviews, specifications, images.

**Test Sites:**

1. **amazon.com/product** - Complex product pages
2. **shopify.com/blog** - Mix of content and commerce
3. **stripe.com/docs** - API documentation with code samples

**Expected Behavior:**

- Variable quality scores (60-80)
- Structured data extraction challenges
- Image-heavy content
- Tables and specifications preserved

#### Category D: SPA/Dynamic Sites (High Priority)

JavaScript-heavy sites requiring rendering.

**Test Sites:**

1. **app.asana.com** - Full SPA
2. **notion.so** - Dynamic content loading
3. **figma.com/community** - Heavy client-side rendering

**Expected Behavior:**

- JS detection working correctly
- Profiler identifies SPA patterns
- May require user prompts for strategy
- Lower success rate without proper JS handling

#### Category E: Edge Cases (Low Priority)

Sites with unusual structures or challenges.

**Test Sites:**

1. **wikipedia.org** - Large pages, many internal links
2. **stackoverflow.com/questions** - Q&A structure
3. **github.com/repo** - Code repositories
4. **reddit.com/r/topic** - Forum structure

**Expected Behavior:**

- Variable quality depending on structure
- Pagination handling
- Code block preservation
- Comment thread handling

---

## Test Execution Plan

### Phase 1: Automated Testing (Week 1)

Use the provided test script for each website:

```bash
#!/bin/bash
# Extended test script for RFC-001

# Test configuration
declare -A TEST_SITES=(
  # Category A: Documentation
  ["docs.kore.ai"]="https://docs.kore.ai/gettingstarted/"
  ["docs.python.org"]="https://docs.python.org/3/tutorial/"
  ["developer.mozilla.org"]="https://developer.mozilla.org/en-US/docs/Web/JavaScript"
  ["reactjs.org"]="https://react.dev/learn"

  # Category B: News/Blog
  ["techcrunch.com"]="https://techcrunch.com/2024/01/01/sample-article/"
  ["medium.com"]="https://medium.com/topic/technology"
  ["arstechnica.com"]="https://arstechnica.com/gadgets/"
  ["blog.cloudflare.com"]="https://blog.cloudflare.com/workers-ai/"

  # Category C: E-commerce
  ["stripe.com"]="https://stripe.com/docs/api"
  ["shopify.com"]="https://www.shopify.com/blog"

  # Category D: SPA/Dynamic
  ["notion.so"]="https://www.notion.so/product"
  ["figma.com"]="https://www.figma.com/community"

  # Category E: Edge Cases
  ["wikipedia.org"]="https://en.wikipedia.org/wiki/Web_crawler"
  ["stackoverflow.com"]="https://stackoverflow.com/questions/tagged/web-scraping"
)

# Test parameters
MAX_PAGES=5          # Limit to 5 pages per test
MAX_DEPTH=1          # Single level only
TIMEOUT=300          # 5 minute timeout per site

# Run tests
for site in "${!TEST_SITES[@]}"; do
  echo "=== Testing: $site ==="
  ./scripts/test-crawl-site.sh "${TEST_SITES[$site]}" "$site" "$MAX_PAGES" "$MAX_DEPTH"
  echo ""
done
```

### Phase 2: Manual Validation (Week 1)

For each test, manually review:

1. **Content Quality**
   - Open original URL and cleaned HTML side-by-side
   - Verify main content is preserved
   - Verify ads/navigation/footers are removed
   - Check for any incorrectly removed content

2. **Metadata Accuracy**
   - Compare extracted title vs. actual title
   - Verify author extraction (if available)
   - Check excerpt relevance

3. **Structure Preservation**
   - Verify headings hierarchy is correct
   - Check tables are intact
   - Verify code blocks are preserved
   - Validate image alt text

4. **User Experience**
   - Note how long until first feedback (job queued)
   - Track visibility into progress
   - Document any confusing states
   - Record error messages encountered

### Phase 3: Data Analysis (Week 2)

Aggregate metrics across all tests:

```sql
-- Example queries for analysis

-- Quality distribution by category
SELECT
  category,
  AVG(quality_score) as avg_quality,
  AVG(noise_reduction) as avg_noise,
  AVG(content_preservation) as avg_preservation,
  COUNT(*) as total_docs
FROM test_results
GROUP BY category;

-- Failure analysis
SELECT
  site,
  error_phase,
  error_message,
  COUNT(*) as occurrences
FROM test_errors
GROUP BY site, error_phase, error_message
ORDER BY occurrences DESC;

-- Performance metrics
SELECT
  category,
  AVG(crawl_time_ms) as avg_crawl,
  AVG(ingestion_time_ms) as avg_ingestion,
  AVG(extraction_time_ms) as avg_extraction
FROM test_results
GROUP BY category;
```

---

## Success Criteria

### Quality Metrics

| Metric                   | Target | Minimum Acceptable |
| ------------------------ | ------ | ------------------ |
| Overall Quality Score    | 80+    | 70+                |
| Noise Reduction          | 40-60% | 30%+               |
| Content Preservation     | 95%+   | 90%+               |
| Heading Preservation     | 90%+   | 85%+               |
| Metadata Extraction Rate | 80%+   | 70%+               |

### Reliability Metrics

| Metric                     | Target | Minimum Acceptable |
| -------------------------- | ------ | ------------------ |
| Successful Crawl Rate      | 95%+   | 90%+               |
| Successful Ingestion Rate  | 98%+   | 95%+               |
| Successful Extraction Rate | 99%+   | 97%+               |
| End-to-End Success Rate    | 90%+   | 85%+               |

### User Experience Metrics

| Metric                    | Target    | Minimum Acceptable |
| ------------------------- | --------- | ------------------ |
| Time to First Feedback    | <5s       | <10s               |
| Progress Update Frequency | Real-time | 5s polling         |
| Error Message Clarity     | 90% clear | 80% clear          |
| Recovery Path Documented  | 100%      | 90%                |

---

## Test Execution Template

For each website test, document:

### Test Case: [Website Name]

**URL:** https://example.com/page
**Category:** Documentation / News / E-commerce / SPA / Edge Case
**Date:** YYYY-MM-DD
**Tester:** Name

#### Setup

- Tenant ID: `___`
- Index ID: `___`
- Source ID: `___`
- Job ID: `___`
- Batch ID: `___`

#### Expected Behavior

- Quality score: \_\_\_
- Noise reduction: \_\_\_
- Key content to preserve: \_\_\_
- Known challenges: \_\_\_

#### Test Results

**1. Crawl Phase**

- ✅/❌ Job created successfully
- ✅/❌ URLs discovered: **_ (expected: _**)
- ✅/❌ JS detection worked (if SPA)
- ⏱️ Crawl time: \_\_\_
- 🐛 Issues: \_\_\_

**2. Ingestion Phase**

- ✅/❌ Documents created: **_ (expected: _**)
- ✅/❌ Readability succeeded
- 📊 Quality metrics:
  - Overall score: **_ (target: _**)
  - Noise reduction: **_% (target: _**)
  - Content preservation: **_% (target: _**)
  - Structure preservation: **_% (target: _**)
- ⏱️ Ingestion time: \_\_\_
- 🐛 Issues: \_\_\_

**3. Extraction Phase**

- ✅/❌ Docling extraction succeeded
- ✅/❌ Chunks created: **_ (expected: _**)
- ✅/❌ Pages extracted: \_\_\_
- ⏱️ Extraction time: \_\_\_
- 🐛 Issues: \_\_\_

**4. Manual Content Review**

- ✅/❌ Main content preserved correctly
- ✅/❌ Ads/navigation removed
- ✅/❌ Headings hierarchy correct
- ✅/❌ Tables/code blocks intact
- ✅/❌ Metadata accurate (title, author)
- 📝 Notes: \_\_\_

**5. User Experience**

- ✅/❌ Clear feedback at each step
- ✅/❌ Progress visible
- ✅/❌ Errors actionable
- ✅/❌ Results easy to verify
- 📝 Confusion points: \_\_\_

#### Screenshots

- [ ] Original page
- [ ] Cleaned HTML
- [ ] Quality metrics dashboard
- [ ] Error states (if any)

#### Raw Data

```json
{
  "jobId": "...",
  "batchId": "...",
  "stats": {
    "urlsCrawled": 5,
    "documentsCreated": 5,
    "totalChunks": 60
  },
  "qualityMetrics": {
    "overall": 85,
    "noiseReduction": 45,
    "contentPreservation": 96
  }
}
```

#### Issues Found

1. **Issue:** Description
   - **Severity:** Critical / High / Medium / Low
   - **Reproducible:** Yes / No
   - **Impact:** User/System
   - **Workaround:** Yes/No

#### Recommendations

- Improvement 1
- Improvement 2

---

## Expected Findings & Improvements

Based on the current implementation, we anticipate finding:

### High-Confidence Findings

#### ✅ Strengths (Expected to Work Well)

1. **Documentation sites** - High quality scores due to clean HTML
2. **Readability integration** - Effective noise removal for news/blog sites
3. **Dual storage** - Raw HTML available for debugging/comparison
4. **Quality metrics** - Comprehensive measurement framework
5. **Content deduplication** - Hash-based duplicate detection works

#### ❌ Weaknesses (Expected Gaps)

**1. Limited Progress Visibility**

- **Finding**: Users blind to what's happening during crawl
- **Impact**: HIGH - Poor UX for long crawls
- **Evidence**: No real-time updates, must poll APIs
- **Improvement**: Implement WebSocket progress streaming (RFC-002)

**2. SPA Handling**

- **Finding**: Sites requiring JS rendering may fail
- **Impact**: HIGH - Common pattern in modern web
- **Evidence**: Go crawler uses static HTTP, no browser rendering
- **Improvement**: Integrate Playwright/Puppeteer for JS sites (RFC-003)

**3. Error Recovery**

- **Finding**: Failures are silent or cryptic
- **Impact**: MEDIUM - Users don't know what went wrong
- **Evidence**: Errors logged but not surfaced to user
- **Improvement**: Centralized error tracking + retry system (RFC-004)

**4. Paywall/Auth Content**

- **Finding**: Protected content returns login pages
- **Impact**: MEDIUM - Common for premium content
- **Evidence**: Crawler has no auth mechanism
- **Improvement**: Add authentication support (RFC-005)

**5. Rate Limiting**

- **Finding**: Aggressive crawling may hit rate limits
- **Impact**: MEDIUM - Causes crawl failures
- **Evidence**: No rate limit detection or backoff
- **Improvement**: Smart rate limiting with 429 handling (RFC-006)

**6. Link Discovery**

- **Finding**: Crawler may miss important pages
- **Impact**: MEDIUM - Incomplete coverage
- **Evidence**: Basic link extraction, no sitemap support
- **Improvement**: Sitemap parsing + smart link following (RFC-007)

**7. Large Pages**

- **Finding**: Pages >5MB may timeout or fail
- **Impact**: LOW - Rare but happens
- **Evidence**: No size limits or streaming
- **Improvement**: Add content size limits + streaming (RFC-008)

**8. Robots.txt Compliance**

- **Finding**: May crawl disallowed pages
- **Impact**: LOW - Ethical/legal concern
- **Evidence**: No robots.txt parser
- **Improvement**: Add robots.txt support (RFC-009)

### Quality Improvement Targets

Based on baseline metrics, we expect:

| Metric               | Before Readability | After Readability | Improvement         |
| -------------------- | ------------------ | ----------------- | ------------------- |
| Noise Reduction      | 0-10%              | 40-60%            | +40-50%             |
| Content Preservation | 100% (raw)         | 90-95%            | -5-10% (acceptable) |
| Document Size        | 42KB avg           | 8KB avg           | -81%                |
| Chunks per Doc       | 80 avg             | 15 avg            | -81%                |
| Quality Score        | N/A                | 85 avg            | New metric          |

### Site-Specific Expectations

#### Documentation Sites (Category A)

- ✅ **Expected Success**: 95%+ crawl success rate
- ✅ **Quality**: 85-95 overall score
- ⚠️ **Challenge**: Large nested structures (depth limits)
- ⚠️ **Challenge**: Code samples (preserve formatting)

#### News/Blog Sites (Category B)

- ✅ **Expected Success**: 85%+ crawl success rate
- ✅ **Quality**: 75-85 overall score
- ⚠️ **Challenge**: Heavy ads (good noise reduction)
- ⚠️ **Challenge**: Paywalls (auth needed)

#### E-commerce Sites (Category C)

- ⚠️ **Expected Success**: 70%+ crawl success rate
- ⚠️ **Quality**: 65-75 overall score
- ⚠️ **Challenge**: Product images (metadata extraction)
- ⚠️ **Challenge**: Reviews/specs (structured data)

#### SPA/Dynamic Sites (Category D)

- ❌ **Expected Success**: 40-60% crawl success rate
- ❌ **Quality**: Variable (50-80)
- ❌ **Challenge**: JS required for content
- ❌ **Challenge**: Client-side routing

#### Edge Cases (Category E)

- ⚠️ **Expected Success**: 60-80% crawl success rate
- ⚠️ **Quality**: Variable (60-85)
- ⚠️ **Challenge**: Unusual structures
- ⚠️ **Challenge**: Pagination

---

## Test Data Collection

### Automated Metrics (Per Test)

```typescript
interface TestResult {
  // Test metadata
  testId: string;
  site: string;
  category: 'documentation' | 'news' | 'ecommerce' | 'spa' | 'edge';
  startUrl: string;
  testedAt: Date;
  tester: string;

  // Crawl phase
  crawl: {
    jobId: string;
    batchId: string;
    status: 'completed' | 'failed' | 'timeout';
    urlsQueued: number;
    urlsCrawled: number;
    urlsFailed: number;
    duration: number; // milliseconds
    errors: Array<{ url: string; error: string }>;
  };

  // Ingestion phase
  ingestion: {
    documentsCreated: number;
    documentsFailed: number;
    duration: number;
    errors: Array<{ url: string; error: string }>;
  };

  // Extraction phase
  extraction: {
    documentsProcessed: number;
    documentsFailed: number;
    totalChunks: number;
    totalPages: number;
    duration: number;
    errors: Array<{ documentId: string; error: string }>;
  };

  // Quality metrics (aggregated)
  quality: {
    avgOverallScore: number;
    avgNoiseReduction: number;
    avgContentPreservation: number;
    avgStructurePreservation: number;
    avgMetadataExtraction: number;
    distribution: {
      excellent: number; // 90+
      good: number; // 70-89
      fair: number; // 50-69
      poor: number; // <50
    };
  };

  // Size metrics (aggregated)
  size: {
    avgRawBytes: number;
    avgCleanedBytes: number;
    avgReduction: number; // percentage
    totalSaved: number; // bytes
  };

  // Manual review (scored 1-5)
  manualReview: {
    contentAccuracy: number;
    noiseRemoval: number;
    structurePreservation: number;
    metadataAccuracy: number;
    overallUsability: number;
    notes: string;
  };

  // User experience (scored 1-5)
  ux: {
    feedbackClarity: number;
    progressVisibility: number;
    errorHandling: number;
    resultVerification: number;
    notes: string;
  };
}
```

### Storage

Store results in MongoDB for analysis:

```typescript
// Test results collection
collection: 'crawler_test_results'

// Indexes
{
  testId: 1,
  site: 1,
  category: 1,
  testedAt: -1
}
```

---

## Analysis & Reporting

### Weekly Test Report Template

```markdown
# Crawler Test Report - Week [N]

**Period:** YYYY-MM-DD to YYYY-MM-DD
**Sites Tested:** 14
**Total Crawls:** 14
**Total Documents:** 487

## Executive Summary

- Overall success rate: 87% (target: 90%)
- Average quality score: 82 (target: 80+)
- Critical issues found: 3
- High-priority improvements: 5

## Results by Category

### Documentation Sites (4 tested)

- ✅ Success rate: 95%
- ✅ Avg quality: 89
- ✅ Exceeds targets

### News/Blog Sites (4 tested)

- ✅ Success rate: 85%
- ✅ Avg quality: 78
- ⚠️ Paywall challenges

### E-commerce Sites (2 tested)

- ⚠️ Success rate: 75%
- ⚠️ Avg quality: 71
- ⚠️ Below targets

### SPA/Dynamic Sites (2 tested)

- ❌ Success rate: 50%
- ❌ Avg quality: 65
- ❌ JS rendering required

### Edge Cases (2 tested)

- ⚠️ Success rate: 75%
- ✅ Avg quality: 80
- ⚠️ Variable results

## Key Findings

### Critical Issues

1. [Issue] - Impact: [High/Medium/Low]
   - Sites affected: X
   - Workaround: Yes/No
   - ETA for fix: X weeks

### Quality Improvements Validated

1. Noise reduction: +45% average (target: +40%)
2. Size reduction: -79% average (target: -80%)
3. Chunks per doc: 18 avg (target: 15)

### Quality Regressions Found

1. Content preservation: 92% (target: 95%)
   - Issue: Readability too aggressive on some sites
   - Recommendation: Tune thresholds

## User Experience Findings

### Pain Points

1. No progress visibility - 100% of tests
2. Error messages unclear - 60% of failures
3. Retry process unclear - 80% of failures

### Positive Feedback

1. Quality metrics helpful - 90% of tests
2. Raw HTML access useful - 100% of failures
3. Fast feedback on success - 95% of tests

## Recommendations

### P0 (Critical)

1. [Improvement] - ETA: X weeks
2. [Improvement] - ETA: X weeks

### P1 (High)

1. [Improvement] - ETA: X weeks

### P2 (Medium)

1. [Improvement] - ETA: X weeks

## Next Steps

1. Address P0 issues
2. Re-test failed sites
3. Expand test coverage to X more sites
```

---

## Implementation Plan

### Week 1: Test Execution

- **Day 1-2**: Setup test infrastructure, create test script variations
- **Day 3-5**: Run automated tests on all 14 sites
- **Day 6-7**: Manual content review and UX evaluation

### Week 2: Analysis & Reporting

- **Day 1-2**: Aggregate metrics, generate visualizations
- **Day 3-4**: Write findings report, prioritize improvements
- **Day 5**: Review session with team, approve RFC-002+ for improvements

### Week 3: Quick Fixes

- **Day 1-5**: Implement P0 critical fixes

### Week 4: Re-testing

- **Day 1-3**: Re-run tests on sites that failed
- **Day 4-5**: Final report and sign-off

---

## Acceptance Criteria

This RFC is complete when:

1. ✅ All 14 sites tested (at least 1 per category)
2. ✅ Manual review completed for each test
3. ✅ Test results stored in MongoDB
4. ✅ Analysis report published
5. ✅ Findings reviewed with team
6. ✅ Follow-up RFCs created for major improvements
7. ✅ P0 issues have fix timeline
8. ✅ Success criteria met or documented exceptions

---

## Follow-Up RFCs (Expected)

Based on anticipated findings:

- **RFC-002**: Real-Time Crawler Progress Streaming (WebSocket/SSE)
- **RFC-003**: JavaScript Rendering Support (Playwright Integration)
- **RFC-004**: Centralized Error Tracking and Retry System
- **RFC-005**: Authentication Support for Protected Content
- **RFC-006**: Smart Rate Limiting and Backoff
- **RFC-007**: Advanced Link Discovery (Sitemap, Smart Following)
- **RFC-008**: Large Page Handling (Size Limits, Streaming)
- **RFC-009**: Robots.txt Compliance

---

## Resources

### Test Scripts

- `scripts/test-crawl-kore-docs.sh` - Single site test
- `scripts/test-crawl-bulk.sh` - Bulk test runner (TBD)
- `scripts/analyze-test-results.ts` - Results aggregation (TBD)

### Documentation

- `CRAWL_MONITORING_GUIDE.md` - API reference and monitoring
- `docs/crawler/ARCHITECTURE.md` - System design
- `docs/crawler/TESTING.md` - Test strategy (this RFC)

### Dashboards

- Grafana: `http://localhost:3000/d/crawler` (TBD)
- Bull Board: `http://localhost:3001/admin/queues` (TBD)

---

## Questions & Risks

### Open Questions

1. What's the acceptable failure rate for SPA sites? (50%? 70%?)
2. Should we support authentication? (API keys, OAuth, session cookies?)
3. What's the max page size we should support? (5MB? 10MB?)
4. Should we respect robots.txt? (Yes for public crawls, no for user-initiated?)

### Risks

1. **Risk**: Some sites may block crawler user-agent
   - **Mitigation**: Use realistic user agent, rotate if needed

2. **Risk**: Testing may impact rate limits on target sites
   - **Mitigation**: Limit to 5 pages per test, add delays

3. **Risk**: Results may vary based on time of day (dynamic content)
   - **Mitigation**: Run tests at consistent times, document variations

4. **Risk**: Manual review is subjective
   - **Mitigation**: Use scoring rubric, multiple reviewers

---

## Sign-Off

- [ ] Engineering Lead
- [ ] Product Manager
- [ ] QA Lead
- [ ] DevOps Lead

---

## Appendix: Quick Start

```bash
# 1. Create test script
./scripts/test-crawl-site.sh \
  "https://docs.kore.ai/gettingstarted/" \
  "docs.kore.ai" \
  5 \
  1

# 2. Review results
cat test-results/docs.kore.ai.json | jq

# 3. Manual review
open "http://localhost:3001/api/indexes/$INDEX_ID/documents"

# 4. Record findings
vim test-results/docs.kore.ai-review.md
```

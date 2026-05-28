# SDLC Log: USP Crawl-Centric Pages Tab — HLD

**Phase**: HLD
**Date**: 2026-05-17
**Revised**: 2026-05-18 — Option A → Option B for write throughput at scale
**Artifact**: `docs/specs/usp-crawl-pages-tab.hld.md`

## Oracle Decisions

13 clarifying questions asked. All resolved without user escalation.

| #   | Question                             | Classification | Decision                                                                                                                          |
| --- | ------------------------------------ | -------------- | --------------------------------------------------------------------------------------------------------------------------------- |
| Q1  | Error persistence inline vs batched  | ANSWERED       | Inline fire-and-forget — spec says "never block the crawl pipeline"                                                               |
| Q2  | Service layer extraction for /pages  | DECIDED        | No — CrawlJob already loaded for tenant check, merge is one field read                                                            |
| Q3  | Dashboard errorBreakdown computation | DECIDED        | CrawlError.aggregate by type — uses compound index, constant-time (9 types)                                                       |
| Q4  | Concurrent write contention          | ANSWERED       | None — CrawlError.insertOne per failure, independent documents, zero contention                                                   |
| Q5  | Error classifier package placement   | DECIDED        | packages/crawler — domain logic near error source, matches FailureScorer precedent                                                |
| Q6  | SSE event type field dependency      | ANSWERED       | Workers already depend on @abl/crawler; adding classifier is lightweight. SSE events keep type field for real-time classification |
| Q7  | HttpAdapter statusCode availability  | ANSWERED       | Yes — HttpFetchResult.statusCode exists but not propagated by bulk worker processUrl                                              |
| Q8  | Schema migration                     | ANSWERED       | No migration — CrawlError collection auto-created on first write. CrawlJob unchanged.                                             |
| Q9  | SWR cache key breakage               | ANSWERED       | No — cache key based on inputs, not response shape; additive fields ignored by old frontend                                       |
| Q10 | Old jobs missing error details       | DECIDED        | Acceptable — frontend infers from totalFailed > 0 && crawlErrors.length === 0; 90-day TTL                                         |
| Q11 | Write throughput at scale            | USER_FEEDBACK  | User rejected Option A ($push to CrawlJob.urls.errors[]) — document-level write hotspot at 50K URLs. Switched to Option B.        |
| Q12 | Rollback strategy                    | DECIDED        | No feature flag — additive response; revert backend commit + drop collection restores old shape                                   |
| Q13 | qualityMetrics performance budget    | DECIDED        | 5s budget, non-blocking post-completion, follows existing comparison-metrics pattern                                              |

## Key Design Decisions

1. **Option B chosen**: Dedicated `CrawlError` collection — one document per failed/blocked URL. Zero write contention. Same query for active and completed crawls.
2. **Option A rejected**: `$push/$slice` to `CrawlJob.urls.errors[]` creates document-level write hotspot at scale (15K $push ops on 1-2MB doc for 50K crawl with 30% failure rate)
3. **Structural separation**: pages[] and crawlErrors[] as separate arrays replaces original `origin` field concept from FR-4
4. **Error classifier in packages/crawler**: Near error source, both workers already import @abl/crawler
5. **Status filter redesign**: `all/fetched/failed/blocked` replaces `success/failed/all`; errors independently paginated
6. **qualityDistribution dual source**: Stored metrics for completed jobs, real-time aggregation for active crawls
7. **method enum**: `'http' | 'playwright'` (not `'browser'`) — maps strategy 'browser' to stored value 'playwright'
8. **Error pagination**: Independent pagination for errors (`errorLimit/errorOffset`), default 100 per page
9. **Unified read path**: Same `CrawlError.find({crawlJobId})` query works for active and completed crawls — no dual-path logic

## Audit Results (v1 — Option A)

### Round 1 — Phase Auditor

- **Verdict**: NEEDS_REVISION (2 CRITICAL)
- CRITICAL-1: `origin` field in FR-4 not defined in HLD → **FIXED**: Added structural separation design note, updated FR-4
- CRITICAL-2: `qualityScore` in HLD but not FR-9 → **FIXED**: Added qualityScore to FR-9

### Round 2 — Phase Auditor (Data Model + API Deep Dive)

- **Verdict**: NEEDS_REVISION (1 CRITICAL, 4 HIGH)
- CRITICAL: Test spec INT-9 used `origin: 'crawl'` and `indexStatus` → **FIXED**: Aligned with structural separation
- HIGH-1: `method` field write-side gap → **FIXED**: Added sourceMetadata write-side section to HLD
- HIGH-2: Status filter values ambiguous → **FIXED**: Added explicit filter value table
- HIGH-3: qualityDistribution data source ambiguous → **FIXED**: Conditional source (stored vs aggregation)
- HIGH-4: `status=failed` semantics → **FIXED**: Clarified crawlErrors always returned

### Round 3 — Phase Auditor (Final Cross-Phase Consistency)

- **Verdict**: APPROVED
- HIGH-1: method enum `'browser'` vs `'playwright'` → **FIXED**: Changed to `'http' | 'playwright'`
- HIGH-2: Feature spec T-8.1 still referenced `origin` → **FIXED**: Updated to structural separation
- HIGH-3: WebSocket vs SSE terminology drift → **FIXED**: Normalized to SSE across feature spec

## Audit Results (v2 — Option B, revised HLD)

### Round 4 — Phase Auditor (Cross-Phase Consistency Check)

- **Verdict**: NEEDS_REVISION (cross-phase only — HLD design approved)
- CRITICAL: Feature spec + test spec had 37 locations still referencing rejected Option A ($push, $slice, urls.errors[], errorsTruncated, 1000 cap)
- **FIXED**: Updated all 37 locations across feature spec and test spec to reference CrawlError collection

### Round 5 — Phase Auditor (Deep Re-Audit)

- **Verdict**: APPROVED
- HIGH-1: `qualityScore` missing from feature spec CrawledPage interface → **FIXED**: Added `qualityScore?: number`
- HIGH-2: E2E-3 missing qualityScore assertions → **FIXED**: Added qualityScore to preconditions and assertions

### Round 6 — Phase Auditor (Final Sweep)

- **Verdict**: APPROVED — clean pass
- All three documents consistently use CrawlError collection, structural separation, SSE, `'http' | 'playwright'`, qualityScore

## Cross-Document Alignment

All three documents (feature spec, test spec, HLD) now consistently use:

- CrawlError collection (not CrawlJob.urls.errors[])
- Structural separation (pages[] vs crawlErrors[]) — no `origin` field
- Independent pagination for pages and errors (errorPagination)
- `status` field (not `crawlStatus`/`indexStatus`)
- SSE (not WebSocket) for real-time events
- `'http' | 'playwright'` for method enum
- `qualityScore` included in FR-9, CrawledPage interface, and E2E-3 assertions
- T-0 (CrawlError model) added to task decomposition

## Next Phase

Run `/lld usp-crawl-pages-tab` to create the Low-Level Design.

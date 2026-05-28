# SDLC Log: USP Crawl-Centric Pages Tab — Feature Spec

**Phase**: Feature Spec
**Date**: 2026-05-17
**Artifact**: `docs/features/sub-features/usp-crawl-pages-tab.md`

## Oracle Decisions

12 clarifying questions asked. All resolved without user escalation.

| #   | Question                        | Classification | Decision                                                                                             |
| --- | ------------------------------- | -------------- | ---------------------------------------------------------------------------------------------------- |
| Q1  | Spec placement                  | DECIDED        | `docs/features/sub-features/` — 58 existing sub-features establish convention                        |
| Q2  | Backend changes in scope?       | ANSWERED       | Yes — urls.errors[] schema exists but never written; prerequisite for error grouping                 |
| Q3  | New data structure?             | DECIDED        | No — merge SearchDocuments + CrawlJob.urls.errors[] via API                                          |
| Q4  | Error cap                       | DECIDED        | 1,000 entries with errorsTruncated flag; urls.failed counter stays accurate                          |
| Q5  | Strategy-specific columns?      | DECIDED        | No — unified column set; strategy differences via method column + tooltips                           |
| Q6  | Remediation guidance?           | ANSWERED       | Yes — UX spec already specifies this in States A/D wireframes                                        |
| Q7  | Journey priorities              | DECIDED        | P0: J1 (overview), J2 (errors), J4 (per-URL), J6 (live). P1: J3 (quality), J5 (re-crawl), J7 (retry) |
| Q8  | Indexed = what?                 | ANSWERED       | Full pipeline completion (status=indexed), not just SearchDocument creation                          |
| Q9  | Failed URL data source          | DECIDED        | Option A: populate existing CrawlJob.urls.errors[] + merge in API                                    |
| Q10 | Real-time failed URLs?          | ANSWERED       | Yes — UX spec State A wireframe shows failed rows during active crawl                                |
| Q11 | DashboardResponse changes?      | DECIDED        | Add errorBreakdown and qualityDistribution server-side (client-side fragile)                         |
| Q12 | Quality distribution placement? | ANSWERED       | Part of status strip — QualityBar already exists in USPStatusStrip.tsx                               |

## Files Created

- `docs/features/sub-features/usp-crawl-pages-tab.md` — feature spec
- `docs/testing/sub-features/usp-crawl-pages-tab.md` — testing guide placeholder
- `docs/sdlc-logs/usp-crawl-pages-tab/feature-spec.log.md` — this log

## Key Exploration Findings (Pre-Spec)

1. **CrawlJob.urls.errors[]** schema exists (model L28-33) but is NEVER populated by either worker
2. **CrawlJob.results.qualityMetrics** schema exists (model L79-84) but is NEVER computed
3. **SearchDocument.sourceMetadata** contains quality, handlerReused data but /pages API omits it
4. **Failed URLs are ephemeral** — emitted via SSE then permanently lost
5. **method field** (http/playwright) not persisted — only in SSE events
6. Two crawl workers (bulk + intelligence) have different error handling but both discard per-URL details

## Open Questions

1. Error message sanitization depth (internal hostnames)
2. Dynamic error cap based on crawl size
3. qualityMetrics computation timing for large crawls
4. Performance impact of adding method to sourceMetadata
5. SSRF protection error classification path

## Audit Results

### Pass 1 — Phase Auditor (Spec Quality)

- Verdict: NEEDS_REVISION (2 CRITICAL, 5 HIGH)
- CRITICAL-1: handlerReused not stored in sourceMetadata — **FALSE POSITIVE** (verified: metadata passthrough via sanitizeMetadata)
- CRITICAL-2: qualityScore/quality paths wrong — **FALSE POSITIVE** (verified: stored via bulk worker metadata)
- 5 HIGH findings noted, addressed in pass 2

### Pass 2 — Phase Auditor (Cross-Phase)

- Verdict: APPROVED
- 5 HIGH findings addressed:
  - Intelligence worker missing qualityScore/quality → fixed in spec (T-3.4 added)
  - FR-12 SSE event types → specified in FR text
  - FR-4 pagination model → clarified in FR text
  - T-3 underspecified → expanded with line references
  - DashboardResponse incomplete → full type shape shown

### Pass 3 — Platform Audit

- Verdict: NEEDS_REVISION (2 HIGH, 6 MEDIUM)
- All HIGH fixed:
  - Error envelope inconsistency → spec updated with standard envelope requirement
  - 500 error response leakage → sanitization requirement added to Security section
- MEDIUM fixes applied:
  - Existing ErrorGroupingPanel categorizeError() → T-9 now removes it
  - QualityMetricsService reference → added to implementation files
  - Pagination hasMore → preserved in response type
  - SSRF verification → added to open questions
  - Auth typing → T-4.5 added
  - Project scope filter → documented as pre-existing gap

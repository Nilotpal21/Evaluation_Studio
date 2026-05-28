# SDLC Log: USP Crawl-Centric Pages Tab — LLD

**Phase**: LLD
**Date**: 2026-05-18
**Artifact**: `docs/plans/2026-05-18-usp-crawl-pages-tab-impl-plan.md`

## Oracle Decisions

15 clarifying questions asked. All resolved without user escalation.

| #   | Question                                 | Classification | Decision                                                                                                 |
| --- | ---------------------------------------- | -------------- | -------------------------------------------------------------------------------------------------------- |
| Q1  | Implementation order (Wave 1→2→3)        | ANSWERED       | Follow HLD waves exactly: T-0→T-1→T-2→T-3→T-4→T-5→T-6→T-7→T-8→T-9                                        |
| Q2  | Hybrid sequential vs parallel            | INFERRED       | Sequential per-task per user's workflow preference — no parallel forks                                   |
| Q3  | CrawlError model pattern                 | ANSWERED       | Same as CrawlJob: mongoose Schema + tenantIsolationPlugin + uuidv7                                       |
| Q4  | Fire-and-forget pattern                  | DECIDED        | try/catch that logs and continues — matches worker error handling convention                             |
| Q5  | getModels vs getLazyModel                | DECIDED        | getModels for /pages, getLazyModel for workers and dashboard — matches each call site's existing pattern |
| Q6  | ProcessUrlResult statusCode              | DECIDED        | Add statusCode?: number, propagate from HttpFetchResult.statusCode                                       |
| Q7  | Intelligence worker statusCode           | DECIDED        | Use cachedHttpResult?.statusCode in catch block — undefined for Playwright paths                         |
| Q8  | CrawlError in getModels                  | ANSWERED       | Same as Q5                                                                                               |
| Q9  | Dashboard getLazyModel                   | ANSWERED       | Same as Q5                                                                                               |
| Q10 | Frontend envelope handling               | DECIDED        | API function unwraps envelope; frontend type matches unwrapped shape                                     |
| Q11 | Batch vs individual inserts              | DECIDED        | Individual insertOne — WINDOW_SIZE=5 is trivial for MongoDB; batching adds complexity                    |
| Q12 | Intelligence worker per-page persistence | DECIDED        | Per-page CrawlError persistence — matches existing per-page counter update pattern                       |
| Q13 | Old categorizeError removal              | DECIDED        | Remove entirely — dead code after backend provides type field                                            |
| Q14 | ErrorGroupingPanel data sources          | ANSWERED       | Separate sections: crawlErrors[] (crawl) and pages.filter(error) (pipeline) — no merging                 |
| Q15 | qualityMetrics caching in dashboard      | ANSWERED       | Always aggregate for qualityDistribution; use stored qualityMetrics for avgQualityScore when available   |

## Audit Results

### Round 1 — Architecture Compliance (lld-reviewer)

- **Verdict**: NEEDS_CHANGES (0 CRITICAL, 4 HIGH, 5 MEDIUM)
- H-1: /pages error responses use bare string, not structured `{ code, message }` → **FIXED**: Added step 1.4.8 (now 1.4.9a)
- H-2: statusCode not in ProcessUrlResult → Already covered by D-5, confirmed
- H-3: No Zod validation for new query params → **FIXED**: Added PagesQuerySchema in step 1.4.2
- H-4: TTL semantic mismatch between CrawlError and CrawlJob → **FIXED**: Documented as accepted tradeoff
- M-1: create() vs insertOne() terminology → **FIXED**: Aligned to create()
- M-2: `$avg: '$chunks'` returns null → **FIXED**: Deferred avgChunksPerDoc
- M-3: cachedHttpResult scope edge case → **FIXED**: Added scope note
- M-4: contentPreservation not in sourceMetadata → **FIXED**: Deferred avgContentPreservation
- M-5: 500 handler leaks error.message → **FIXED**: Covered by step 1.4.9a

### Round 2 — Pattern Consistency (lld-reviewer)

- **Verdict**: NEEDS_CHANGES (4 HIGH, 5 MEDIUM)
- H-1: Missing ModelRegistry registration for CrawlError → **FIXED**: Added step 1.0.3 with registration code
- H-2: Missing errors/index.ts barrel file → **FIXED**: Added step 1.1.3, updated file tables
- H-3: getModels vs getLazyModel contradiction → **FIXED**: Clarified D-4 rationale
- H-4: getCrawledPages unwrap code not explicit → **FIXED**: Added explicit unwrap implementation
- M-1: D-10 FailureScorer claim misleading → **FIXED**: Reworded to "location precedent"
- M-2: crawlErrorQuery uses `any` → **FIXED**: Typed query object
- M-3: .option({ maxTimeMS }) verification → Logged, non-blocking
- M-4: ErrorGroupingPanel i18n namespace → Logged for T-9 implementation
- M-5: T-4/T-6 temporal dependency → Noted, non-blocking

### Round 3 — Completeness (lld-reviewer)

- **Verdict**: NEEDS_CHANGES (3 HIGH, 5 MEDIUM)
- H-1: Missing ProgressEvent interface update for errorType → **FIXED**: Added step 1.2.6 with progress.ts modification
- H-2: DashboardResponse frontend type never updated → **FIXED**: Added step 1.6.2 for DashboardResponse type
- H-3: Test strategy references wrong INT numbers → **FIXED**: Corrected all INT-N and E2E-N references
- M-1: i18n path has spurious `src/` prefix → **FIXED**: Corrected to `packages/i18n/locales/en/studio.json`
- M-2: progress.ts missing from Modified Files table → **FIXED**: Added row
- M-3: T-7 crawl.ts dependency not in Files Touched → **FIXED**: Consolidated into T-6
- M-4: Frontend exit criteria not measurable → Logged, build checks are present
- All 14 FRs confirmed mapped to LLD tasks ✅

### Round 4 — Cross-Phase Consistency (phase-auditor)

- **Verdict**: NEEDS_REVISION (2 CRITICAL, 3 HIGH, 2 MEDIUM)
- CRITICAL-1: `status=blocked` returns ALL crawlErrors, not just blocked types → **FIXED**: Added `$in` filter for blocked types
- CRITICAL-2: Missing jobId path parameter validation for 400 → **FIXED**: Added step 1.4.8 with mongoose.isValidObjectId
- HIGH-1: SSE field name `errorType` vs HLD `type` → **FIXED**: Documented naming decision with rationale
- HIGH-2: qualityMetrics step has contradictory line references → **FIXED**: Reworded step 1.2.10 header
- HIGH-3: E2E-7 and E2E-8 not referenced in test strategies → **FIXED**: Added to T-4 and T-2 test strategies
- M-1: qualityDistribution HLD optimization deviation undocumented → **FIXED**: Added deviation note
- M-2: Step numbering collision in T-6 → **FIXED**: Renumbered to 1.6.4

### Round 5 — Final Sweep (lld-reviewer)

- **Verdict**: APPROVED (2 MEDIUM, 2 LOW)
- M-1: ErrorGroupingPanel data source wiring ambiguous → **FIXED**: Specified option (b) — render as child of CrawledPagesView
- M-2: Step 1.2.11 batch URL tracking unresolved → Logged, implementer will resolve
- L-1: Duplicate step number → **FIXED**: Renumbered
- L-2: Open question #4 already resolved → **FIXED**: Marked as resolved
- All CRITICAL/HIGH from prior rounds confirmed fixed ✅

### Round 6 — Platform Audit (general-purpose agent)

- **Verdict**: NEEDS_REVISION (1 CRITICAL, 3 HIGH, 4 MEDIUM, 1 LOW)
- CRITICAL: `mongoose.isValidObjectId(jobId)` rejects UUIDv7 IDs (CrawlJob uses String \_id, not ObjectId) → **FIXED**: Replaced with minimal empty-string guard; CrawlJob.findOne handles invalid IDs via 404
- HIGH-1: ModelRegistry registration used wrong call signature (object form vs 3-arg form) → **FIXED**: Updated step 1.0.3 to match exact CrawlJob pattern at L165-168
- HIGH-2: "Fire-and-forget" naming contradicts `await` usage → **FIXED**: Renamed to "best-effort non-blocking" in D-2 and all code comments; documented rationale for `await` (durability)
- HIGH-3: `as any` cast in blocked-status filter → **FIXED**: Changed query type to `FilterQuery<ICrawlError>`
- M-1: Dashboard variable name `batchId` ambiguity → Logged, non-blocking
- M-2: Error message leaking in 6 other crawl.ts handlers → Logged as pre-existing tech debt
- M-3: Sanitizer may mangle user's target URL → Logged, non-blocking (acceptable edge case)
- M-4: Missing ProgressEvent.data.errorType in wiring checklist → **FIXED**: Added to wiring checklist
- L-1: CrawlError \_id field not explicitly shown in schema → Logged, covered by "same pattern as CrawlJob" instruction
- All CRITICAL/HIGH fixed ✅

### Round 7 — Industry Research Expert Audit (general-purpose agent)

- **Verdict**: 12 findings (4 IMPROVEMENT, 4 RISK, 4 GAP)
- IMPROVEMENT-1: Rename "fire-and-forget" to "best-effort non-blocking" → **FIXED** (merged with Round 6 fix)
- IMPROVEMENT-2: Missing HTTP 429 as distinct error type → Logged as Open Question #5 for follow-up
- IMPROVEMENT-3: Enforce atomic deploy for breaking envelope change → Already documented in Section 5 ("deploy together in Wave 3")
- IMPROVEMENT-4: T-1 unit tests should gate T-2 start → **FIXED**: Added prerequisite to T-2
- RISK-1: SSE events lack `id:` field for reconnection → Logged as Open Question #6 (acceptable gap)
- RISK-2: Mongoose autoIndex may spike DB load → **FIXED**: Added verification note to Database Migrations section
- RISK-3: maxTimeMS 5000 too aggressive for large jobs → Logged as Open Question #7
- RISK-4: T-0 exit criteria unverifiable without runtime → Logged, smoke test implicit in T-2 integration
- GAP-1: No per-insert timeout for MongoDB connectivity blips → Logged, try/catch handles failure; 30s stall is edge case
- GAP-2: Historical jobs show 0 errors but have urls.failed > 0 → **FIXED**: Added step 1.9.3 with contextual message
- GAP-3: No TTL index verification test → Logged for implementer to add as schema assertion
- GAP-4: No concurrent failure persistence test → Logged for implementer to extend E2E-8

### Round 8 — OSS Library Audit (general-purpose agent)

- **Verdict**: APPROVED — no OSS adoption recommended
- All proposed implementations (error classifier, sanitizer, aggregation queries) are domain-specific logic. No general-purpose OSS library exists for crawl error taxonomy or SearchAI-specific quality metrics.
- Mongoose (already in use) handles all MongoDB operations. No new dependencies needed.

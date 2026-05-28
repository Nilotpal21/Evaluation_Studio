# LLD Audit Log: Crawler UX Objectives (O1-O8 + Multi-User)

**Artifact**: `docs/plans/2026-05-01-crawler-ux-objectives-impl-plan.md`
**Date**: 2026-05-01
**Rounds**: 8 (5 sequential + 3 parallel)

---

## Round 1: Architecture Compliance (lld-reviewer)

**Verdict**: NEEDS_REVISION → APPROVED after fixes

| Severity | Finding                                                                      | Resolution                                                    |
| -------- | ---------------------------------------------------------------------------- | ------------------------------------------------------------- |
| CRITICAL | C-1: Express route ordering — `GET /drafts/active` captured by `:draftId`    | Added "CRITICAL: Register BEFORE" notes to tasks 2.8, 2.10    |
| CRITICAL | C-2: Missing Zod validation on 3 new endpoints + robots endpoint             | Added exact Zod schemas to all 4 endpoints                    |
| CRITICAL | C-3: `'auto'` enum cascading — Mongoose validation error on section creation | Specified 5 locations needing update (later expanded to 6)    |
| HIGH     | H-1: `GET /drafts/active` returns 5MB discoveryState                         | Added `.select()` projection, compound index, staleness check |
| HIGH     | H-4: Wrong file for SKIP_EXTENSIONS (design doc said discover-crawler.ts)    | Corrected to `link-extractor.ts:40`                           |

## Round 2: Pattern Consistency (lld-reviewer)

**Verdict**: NEEDS_REVISION → APPROVED after fixes

| Severity | Finding                                                                  | Resolution                         |
| -------- | ------------------------------------------------------------------------ | ---------------------------------- |
| MEDIUM   | M-1: ConfirmDialog only supports 2 actions, close needs 3                | Changed to base `Dialog` component |
| LOW      | L-3: 5th location for 'auto' enum at `apps/studio/src/api/crawl.ts:1035` | Added to atomic update list        |

## Round 3: Completeness (lld-reviewer)

**Verdict**: APPROVED

All FRs from feature spec mapped to tasks. File paths verified. No gaps found.

## Round 4: Cross-Phase Consistency (phase-auditor)

**Verdict**: NEEDS_REVISION → APPROVED after fixes

| Severity | Finding                                                   | Resolution                                                         |
| -------- | --------------------------------------------------------- | ------------------------------------------------------------------ |
| CRITICAL | C-1: Missing yield-drop suggestion from design doc        | Added task 2.17 hooking into existing `suggestMoreDiscovery` state |
| CRITICAL | C-2: Missing Step 3 mini-bar when discovery still running | Added task 2.18 with `discoveryRunning` and `discoveryStats` props |
| HIGH     | H-1: `documentUrls` missing from batch endpoint           | Added to task 4.11                                                 |
| HIGH     | H-2: Manual preview URL override missing                  | Added dropdown to task 3.2                                         |
| HIGH     | H-3: Panel-switch confirmation missing                    | Added task 2.19                                                    |

## Round 5: Final Sweep (lld-reviewer)

**Verdict**: APPROVED

| Severity | Finding                                                           | Resolution                                                   |
| -------- | ----------------------------------------------------------------- | ------------------------------------------------------------ |
| MEDIUM   | M-1: AddSourceButton path clarified as `data/AddSourceButton.tsx` | Updated in files touched                                     |
| MEDIUM   | M-2: SWR cache invalidation — `onRefreshSources()` doesn't exist  | Fixed to `mutate()` on SWR key or `onSourceCreated` callback |

## Round 6: Platform Audit (general-purpose agent)

**Verdict**: NEEDS_REVISION → APPROVED after fixes

| Severity | Finding                                                                                         | Resolution                                                                                                     |
| -------- | ----------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------- |
| CRITICAL | C-1: Cross-user draft API gap — [Resume] hits 404 via existing endpoint with `createdBy` filter | Documented cross-user access model: [Resume] for own drafts, [View] for others via lightweight status endpoint |
| CRITICAL | C-2: i18n namespace `search_ai.crawl` doesn't exist — codebase uses `search_ai.crawl_flow`      | Fixed to `search_ai.crawl_flow`                                                                                |
| HIGH     | H-3: 6th location for `'auto'` enum — Zod in `crawl-drafts.ts:37`                               | Added to task 2.7b, total now 6 locations                                                                      |
| HIGH     | H-4: Route registration needs exact insertion point                                             | Added "between line ~278 and ~282" to tasks 2.8 and 2.10                                                       |
| HIGH     | H-5: Missing response envelope + SSRF on discovered sitemapUrls                                 | Added `{ success, data }` envelope and sitemapUrl SSRF check                                                   |
| MEDIUM   | M-7: `analyzeRobotsTxt` in 2,876-line route file                                                | Moved to `services/crawler/robots-analyzer.ts`                                                                 |
| MEDIUM   | M-8: Barrel re-exports verified correct                                                         | No change needed                                                                                               |
| MEDIUM   | M-9: Missing trace event on auto-Source creation                                                | Added audit event to task 2.20                                                                                 |

## Round 7: Industry Research Expert (general-purpose agent, WebSearch)

**Verdict**: 12 findings integrated

| Severity | Finding                                                       | Resolution                                                      |
| -------- | ------------------------------------------------------------- | --------------------------------------------------------------- |
| HIGH     | SSE browser connection limit (6 per domain on HTTP/1.1)       | Added ALPHA mitigation: cap SSE to 2, activity bar uses polling |
| HIGH     | SSRF defense-in-depth insufficient with single hostname check | Enhanced task 4.7 with DNS resolution check, timeout, size cap  |
| HIGH     | [Resume] fails across pods (in-memory state)                  | Added ALPHA workaround with explicit "cannot resume" message    |
| MEDIUM   | Crawl-delay interpretation ambiguity                          | Clarified as Yandex convention (most conservative)              |
| MEDIUM   | SSE heartbeat needed for proxy/LB timeout                     | Added `SSE_HEARTBEAT_INTERVAL_MS` (15s) constant                |
| MEDIUM   | Named constants for all magic numbers                         | Added constants table to Section 5                              |

## Round 8: OSS Library Audit (general-purpose agent, WebSearch)

**Verdict**: APPROVED — zero changes needed

- `robots-parser` (MIT, 1.5M downloads/week, RFC 9309): validated as only new dependency
- All other utilities are 5-25 line pure functions fitting existing files
- No existing monorepo alternative for robots parsing confirmed via `grep`
- Zustand already in monorepo — no new dependency for store

---

## Summary

- **Total findings**: 38 across 8 rounds
- **CRITICAL**: 7 found, 7 resolved
- **HIGH**: 10 found, 10 resolved
- **MEDIUM**: 15 found, 15 resolved (some logged as non-blocking)
- **LOW**: 2 found, 2 resolved
- **New dependency**: 1 (`robots-parser`)
- **New files**: 4 (3 Studio components + 1 service)
- **Final status**: APPROVED

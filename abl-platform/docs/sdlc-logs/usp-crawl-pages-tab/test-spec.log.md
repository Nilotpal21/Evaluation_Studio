# SDLC Log: USP Crawl-Centric Pages Tab — Test Spec

**Phase**: Test Spec
**Date**: 2026-05-17
**Artifact**: `docs/testing/sub-features/usp-crawl-pages-tab.md`

## Oracle Decisions

No product-oracle spawned — all clarifying questions were resolved from the feature spec and prior conversation context (feature spec oracle had already resolved 12 questions covering scope, data sources, error taxonomy, and API design).

## Files Created/Updated

- `docs/testing/sub-features/usp-crawl-pages-tab.md` — full test spec (CREATED)
- `docs/testing/sub-features/README.md` — index entry added (prior session)
- `docs/features/sub-features/usp-crawl-pages-tab.md` — §17 updated with test spec reference

## Test Spec Summary

| Category    | Count  | Scenarios       |
| ----------- | ------ | --------------- |
| E2E         | 8      | E2E-1 to E2E-8  |
| Integration | 10     | INT-1 to INT-10 |
| Unit        | 7      | UT-1 to UT-7    |
| Performance | 2      | PERF-1, PERF-2  |
| **Total**   | **27** |                 |

Coverage: All 14 FRs + error/failure path variants (FR-1E, FR-2E, FR-3E, FR-4E, FR-4P, FR-4V) in coverage matrix.

## Audit Results

### Round 1 — Phase Auditor

- **Verdict**: NEEDS_REVISION (3 CRITICAL, 5 HIGH)
- **CRITICAL-1**: E2E data seeding used `CrawlJob.create()` (direct DB) → **FIXED**: E2E now seeds via real crawls against fixture URLs
- **CRITICAL-2**: FR-12 (SSE real-time) had zero automated coverage → **FIXED**: Added INT-10 + E2E-8
- **CRITICAL-3**: FR-5/6/7 (UI-backend contract) had no integration tests → **FIXED**: Added INT-8, INT-9
- **HIGH-1**: Duplicate FR-4E key in coverage matrix → **FIXED**: Renamed to FR-4P
- **HIGH-2**: Missing E2E for invalid jobId error path → **FIXED**: Added E2E-7
- **HIGH-3**: Missing isolation checks on E2E-3, E2E-4 → **FIXED**: Added notes
- **HIGH-4**: No cross-project isolation forward plan → **FIXED**: Added to Security section
- **HIGH-5**: Auth context lacks project scope → Logged as non-blocking (CrawlJob has no projectId — GAP-001)

### Round 2 — Phase Auditor (Fresh Eyes)

- **Verdict**: APPROVED
- **HIGH-1**: WebSocket vs SSE terminology → **FIXED**: Normalized to SSE
- **HIGH-2**: Dashboard endpoint missing isolation scenario → **FIXED**: Added isolation check to E2E-4
- **HIGH-3**: INT-8 referenced fields not in spec → **FIXED**: Aligned with structural separation approach
- **HIGH-4**: Field name misalignment (crawlStatus/indexStatus vs status) → **NOTED**: To be finalized in HLD/LLD
- **HIGH-5**: E2E-3/E2E-4 missing isolation notes → **FIXED**
- 3 MEDIUM findings logged as non-blocking (i18n path convention, fixture server decision, E2E-6 truncation practicality)

## Next Phase

Run `/hld usp-crawl-pages-tab` to create the High-Level Design.

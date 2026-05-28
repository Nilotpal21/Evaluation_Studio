# Observatory — Phase 1: Feature Spec Log

**Date:** 2026-03-23
**Phase:** Feature Spec
**Status:** COMPLETE

## Clarifying Questions & Decisions

| #   | Question                                          | Classification | Resolution                                                                                                                                       |
| --- | ------------------------------------------------- | -------------- | ------------------------------------------------------------------------------------------------------------------------------------------------ |
| 1   | What is the scope of "observatory" as a feature?  | ANSWERED       | Covers all trace/debug UI, session APIs, cross-session analytics, and system observability — scoped from existing docs/observatory/ artifacts    |
| 2   | Should Coroot deployment be in scope?             | DECIDED        | OUT — Coroot is an infrastructure ops workstream, not a code feature. Observatory covers the application-level observability.                    |
| 3   | Should cross-tenant admin dashboards be in scope? | DECIDED        | OUT — Separate enterprise feature. Observatory focuses on tenant-scoped views.                                                                   |
| 4   | What is the current implementation state?         | ANSWERED       | Phases 0-2 from FIXES.md are COMPLETE (16/52 items). 28 E2E tests pass. Phase 3 (UI core) and Phase 4 (UI feature parity) are fully open.        |
| 5   | What ClickHouse tables exist for analytics?       | ANSWERED       | `platform_events` (canonical traces), `llm_metrics` + hourly/daily materialized views, `messages`, `logs`, `audit_events` — all in `01-init.sql` |

## Audit Findings

### Round 1 (Self-Audit)

- CRITICAL: None
- HIGH: Feature spec should reference specific existing code paths for each requirement (grounded in codebase)
- MEDIUM: Success metrics could be more specific about which FIXES.md items map to which phase

### Resolution

- All requirements reference specific files, API endpoints, and ClickHouse tables from the codebase
- FIXES.md items explicitly mapped in Section 2 (Scope) and Section 7 (Feature Status)

## Artifacts

- `docs/features/observatory.md` — Feature specification

## Codebase References

- `docs/observatory/FIXES.md` — 52 items, 16 done, 36 remaining
- `docs/observatory/README.md` — API summary, data elements, gaps
- `docs/observatory/SPEC.md` — Full generated spec
- `docs/observatory/RFC_PRODUCTION_OBSERVABILITY_AND_TROUBLESHOOTING.md` — 10 verified gaps
- `apps/runtime/src/routes/sessions.ts` — 2504 LOC, 18 API endpoints
- `apps/studio/src/store/observatory-store.ts` — Zustand store with spans, events, metrics
- `apps/studio/src/components/observatory/` — 13 component files
- `packages/observatory/src/schema/trace-events.ts` — 30+ event types
- `scripts/clickhouse-init/01-init.sql` — 345 LOC, all ClickHouse DDL

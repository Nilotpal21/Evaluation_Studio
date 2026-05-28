# Phase 4: LLD + Implementation Plan — project-import-export

> **Date:** 2026-03-23
> **Status:** COMPLETE

## Summary

Generated Low-Level Design with 5 implementation phases, exit criteria per phase, wiring checklist, dependency graph, effort estimation, and risk mitigation. Total estimated effort: 12-19 days.

## Key Findings

- **Core library is complete** -- all 38 FRs implemented at the package level.
- **Route layer is the primary gap**: REST API uses v1 orchestrators only; v2 (layered export/import with staged import) needs wiring.
- **E2E test gap is critical**: 0 real HTTP tests. The existing mocked route test provides no confidence in the real system.
- **Observability gap**: No TraceEvent emission for import/export. Additive work, low risk.
- **Studio readiness**: API client + SWR hooks are the final enabler for UI work.

## Implementation Phases

| Phase | Description                           | Duration | Risk   |
| ----- | ------------------------------------- | -------- | ------ |
| 1     | Route v2 Wiring + Import DB Adapter   | 3-5 days | HIGH   |
| 2     | E2E Test Suite (12 scenarios)         | 3-5 days | HIGH   |
| 3     | Integration Test Suite (10 scenarios) | 2-3 days | MEDIUM |
| 4     | Observability + Audit Integration     | 2-3 days | LOW    |
| 5     | Studio API Client + Documentation     | 2-3 days | LOW    |

**Total:** 12-19 days
**Critical path:** Phase 1 -> Phase 2 -> Phase 4 -> Phase 5

## New Files

- 7 new files across runtime services, E2E tests, integration tests, and Studio client
- 4 modified files (route, feature spec, test spec, HLD)

## Wiring Checklist

8 items verified: DB adapters, assembler factory, route registration, middleware chain, Studio client, SWR hooks, TraceEvent types.

## Files Changed

- Created: `docs/plans/2026-03-23-project-import-export-impl-plan.md`
- Created: `docs/sdlc-logs/project-import-export/phase-4-lld.md`

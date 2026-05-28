# SDLC Log: ROI Tracking -- Phase 4: LLD

**Date**: 2026-03-23
**Phase**: LLD (Implementation Plan)
**Artifact**: `docs/plans/2026-03-23-roi-tracking-impl-plan.md`

## Decisions Log

| ID  | Question                                                                  | Classification | Decision                                                                                                                       |
| --- | ------------------------------------------------------------------------- | -------------- | ------------------------------------------------------------------------------------------------------------------------------ |
| D1  | Phase ordering -- can phases run in parallel?                             | DECIDED        | Phases 1-2 are independent. Phase 3 depends on 1+2. Phase 4 depends on 1+3. Phases 5-6 depend on 2+3. Phase 7 depends on all.  |
| D2  | Where does the ROI service live?                                          | DECIDED        | `apps/runtime/src/services/roi-service.ts` -- close to route layer, imports from pipeline-engine                               |
| D3  | Should we use ClickHouse direct or go through the existing metrics store? | DECIDED        | Use existing `ClickHouseMetricsStore` pattern from tenant-usage route where possible; add new methods for ROI-specific queries |
| D4  | Feature flag gating approach?                                             | DECIDED        | `FEATURE_ROI_TRACKING !== 'false'` -- opt-out rather than opt-in, since this is additive                                       |
| D5  | Recharts dependency for Studio?                                           | DECIDED        | Check if already installed; if not, add it (standard charting lib for React)                                                   |
| D6  | Redis cache key hashing?                                                  | DECIDED        | `roi:summary:${tenantId}:${projectId}:${md5(from+to)}` -- time range included in key                                           |

## Implementation Summary

- **7 phases**, **16 new files**, **9 modified files**
- **Estimated LOE: 32 hours**
- Phase 1: Schema + events (2h)
- Phase 2: Cost config CRUD API (3h)
- Phase 3: ROI service + APIs (6h)
- Phase 4: Budget alerting (2h)
- Phase 5: Studio dashboard (8h)
- Phase 6: Cost config settings UI (3h)
- Phase 7: Tests (8h)

## Wiring Verification Points

18 wiring checkpoints identified in the plan, covering:

- Schema backward compatibility
- Event barrel exports
- Route mounting with feature flags
- Static-before-parameterized route ordering
- Studio proxy passthrough
- Navigation + page routing
- Isolation in all data layers (MongoDB, ClickHouse, Redis)
- Standard error envelopes

## Audit Round 1

- Verified all code references match actual file paths in codebase
- Verified route patterns follow existing conventions (tenant-usage, pipeline-analytics)
- Verified Zod schema uses `z.string().min(1)` pattern (no `.cuid()` etc.)
- Verified auth middleware usage matches platform conventions
- Verified error envelopes match standard `{ success, error: { code, message } }`
- No `console.log` in any code -- all use `createLogger`
- No `findById` -- all use `findOne({ tenantId, projectId })`

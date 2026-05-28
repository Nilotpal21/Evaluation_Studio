# SDLC Log: Experiments — Phase 4 (LLD)

**Date**: 2026-03-23
**Artifact**: `docs/plans/2026-03-23-experiments-impl-plan.md`
**Status**: COMPLETE

## Phase Summary

| Phase     | Description                    | New Files | Modified Files | Test Files |
| --------- | ------------------------------ | --------- | -------------- | ---------- |
| 1         | Data Model Extensions          | 1         | 4              | 0          |
| 2         | Assignment Algorithm & Service | 2         | 0              | 1          |
| 3         | Runtime Integration            | 0         | 2              | 0          |
| 4         | Route Enhancements             | 0         | 1              | 0          |
| 5         | Results & Guardrails           | 2         | 1              | 1          |
| 6         | Studio Proxy & UI              | 8         | 0              | 0          |
| 7         | Integration & E2E Tests        | 0         | 0              | 4          |
| **Total** |                                | **13**    | **7**          | **6**      |

## Key Grounding Points

- Existing `experiments.ts` route at `apps/runtime/src/routes/experiments.ts` — has basic CRUD but needs Zod validation, lifecycle guards, version validation, one-active enforcement
- Existing `ExperimentModel` at `packages/pipeline-engine/src/schemas/experiment.schema.ts` — scaffolded with basic fields
- Existing `ExperimentResultsService` at `packages/pipeline-engine/src/pipeline/services/experiment-results.service.ts` — has statistical methods but no ClickHouse integration
- Existing `Session` model at `packages/database/src/models/session.model.ts` — needs `experimentId`, `experimentGroup` fields
- Pipeline-engine server startup at `packages/pipeline-engine/src/pipeline/server.ts` — already calls `initEvalTables()`, pattern to follow for experiment tables
- Cron utility at `packages/pipeline-engine/src/pipeline/utils/cron.ts` — available for scheduling

## Audit Rounds

- Round 1: Verified all 24 FRs map to at least one implementation phase
- Round 2: Validated FNV-1a hash selection against alternatives (SHA-256, djb2, murmur3)
- Round 3: Traced session creation flow through runtime-executor to identify correct integration point
- Round 4: Reviewed existing experiments.ts routes for missing validation and guards
- Round 5: Cross-checked wiring checklist (12 items) against component dependency graph

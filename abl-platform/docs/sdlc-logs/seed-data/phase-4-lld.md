# SDLC Log: Seed Data -- Phase 4 (LLD)

**Date:** 2026-03-23
**Phase:** LLD + Implementation Plan
**Artifact:** `docs/plans/2026-03-23-seed-data-impl-plan.md`

## Summary

Generated 4-phase implementation plan with concrete tasks, file lists, and exit criteria. Phases align with priority tiers from the feature spec (P0 shared layer, P1 orchestrator, P2 API extension, P0-P1 tests).

## Phase Breakdown

| Phase | Focus                                | Tasks   | Priority |
| ----- | ------------------------------------ | ------- | -------- |
| 1     | Shared upsert layer + Zod validators | 4 tasks | P0       |
| 2     | Seed orchestrator with CLI flags     | 4 tasks | P1       |
| 3     | Runtime API extension                | 3 tasks | P2       |
| 4     | Test coverage                        | 4 tasks | P0-P1    |

## Key Implementation Notes

- `upsertOne()` must handle the `_id` immutability pattern correctly (current `seed-mongo.ts` version is the reference)
- Zod validators must use `z.string().min(1)` for all ID fields per platform rules
- `seed-travel-workflows.ts` needs deterministic IDs (`wf-<slug>-<name>`) to fix idempotency
- Category files can be extracted incrementally (one at a time, verify `seed:all` still works)
- Orchestrator uses topological sort for dependency resolution

## Risks Logged

1. Refactoring breaks `seed:all` in CI (mitigate: integration tests before merge)
2. Zod validation may reject valid but loosely-typed existing data (mitigate: validate against current data)
3. Category extraction may subtly change behavior (mitigate: record count comparison tests)

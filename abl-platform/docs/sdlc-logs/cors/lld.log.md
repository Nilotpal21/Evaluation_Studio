# SDLC Log: CORS LLD

**Feature**: CORS Configuration
**Phase**: LLD
**Date**: 2026-03-23

---

## Oracle Decisions

### Implementation Strategy

| #   | Question              | Answer                                                                                                 | Classification       |
| --- | --------------------- | ------------------------------------------------------------------------------------------------------ | -------------------- |
| 1   | Implementation order? | Config first (Phase 1), then runtime middleware (Phase 2), then tests (Phase 3-4), then docs (Phase 5) | DECIDED              |
| 2   | Existing patterns?    | `startRuntimeServerHarness` for E2E tests; `mapEnvToConfig` tests for unit tests                       | ANSWERED (from code) |
| 3   | Feature flag needed?  | No -- change is safe because operators control `CORS_ORIGINS` env var                                  | DECIDED              |
| 4   | Phase 1 scope?        | Config schema and env mapping only -- no runtime behavior change                                       | DECIDED              |

### Technical Details

| #   | Question                  | Answer                                                                               | Classification       |
| --- | ------------------------- | ------------------------------------------------------------------------------------ | -------------------- |
| 5   | Specific files to modify? | `cors.schema.ts`, `env-mapping.ts`, `server.ts` (3 modified files), 2 new test files | ANSWERED (from code) |
| 6   | Testing strategy?         | Test-after for Phase 1-2 (config changes are low risk); dedicated test phases (3-4)  | DECIDED              |
| 7   | Type changes?             | `CORSConfig` type extended with `maxAge: number` -- backwards compatible             | ANSWERED (from code) |

### Risk & Dependencies

| #   | Question             | Answer                                                                                                      | Classification |
| --- | -------------------- | ----------------------------------------------------------------------------------------------------------- | -------------- |
| 8   | Conflicting changes? | None -- CORS middleware is isolated, no concurrent work on `server.ts` CORS block                           | INFERRED       |
| 9   | Biggest risk?        | Production multi-origin change could expose Runtime to unexpected origins if `CORS_ORIGINS` was set broadly | INFERRED       |
| 10  | Definition of done?  | All 3 feature spec gaps closed, 8+ integration tests, 6+ E2E tests                                          | DECIDED        |

## Audit Findings

### Round 1 (Architecture compliance)

- All phases independently deployable
- No tenant isolation changes needed (CORS is deployment-scoped)
- Stateless middleware -- no distributed state concerns
- Config changes are backwards compatible (new fields have defaults)

### Round 2 (Pattern consistency)

- Test files follow existing `*.integration.test.ts` and `*.e2e.test.ts` naming
- Uses `startRuntimeServerHarness` pattern from SDK tests
- Config changes follow existing `CORSConfigSchema` extension pattern

### Round 3 (Completeness)

- All 6 FRs from feature spec traceable to implementation tasks
- File paths verified against actual codebase
- LOC estimates realistic for scope

### Round 4 (Cross-phase consistency)

- LLD implements HLD recommendation (Option B improvements)
- Test scenarios from test spec (E2E-1 to E2E-7, INT-1 to INT-7) mapped to implementation phases
- Feature spec gaps (GAP-001, GAP-002, GAP-003) each have a closing task

### Round 5 (Final sweep)

- Wiring checklist complete -- all new components connected to consumers
- No TODO stubs in any phase
- Rollback strategy for each phase is clear and non-destructive
- MEDIUM: Open question about `server.frontendUrl` deprecation -- logged, not blocking

## Files Created

- `docs/plans/2026-03-23-cors-impl-plan.md`
- `docs/sdlc-logs/cors/lld.log.md` -- this file

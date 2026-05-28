# SDLC Log: Sizing Calculator -- Phase 4 LLD

**Date:** 2026-03-22
**Phase:** LLD & Implementation Plan
**Feature:** sizing-calculator (#42)

## LLD Summary

### 5 Implementation Phases

| Phase                  | Scope                              | Files         | LOC | Exit Criteria                |
| ---------------------- | ---------------------------------- | ------------- | --- | ---------------------------- |
| 1: API Core            | Calculate, Export, Tiers endpoints | 5 new + 2 mod | 325 | E2E-1,3,4,5,8 pass           |
| 2: Profile Persistence | CRUD + MongoDB + isolation         | 5 new + 2 mod | 420 | E2E-7 pass, cross-tenant 404 |
| 3: Compare & Breakdown | Comparison + TierBreakdown         | 1 new + 5 mod | 60  | E2E-2,6 pass                 |
| 4: Studio UI           | Questionnaire, topology, charts    | 10 new        | 930 | Manual UI review             |
| 5: Cost & Export       | Cost estimation + Terraform        | 6 new + 4 mod | 525 | Unit tests pass              |

### Key Architecture Patterns Used

1. **Router/Controller/Service/Repo layering** -- consistent with admin service patterns
2. **Zod validation at boundary** -- request schemas for all endpoints
3. **Platform error envelope** -- `{ success, data/error: { code, message } }`
4. **Tenant isolation** -- `findOne({ _id, tenantId, projectId })`, never `findById()`
5. **Structured logging** -- `createLogger('sizing')` throughout
6. **Pure engine** -- sizing-calculator package has zero I/O dependencies

### Dependency Graph

- Phase 1 -> Phase 2 -> Phase 3 -> {Phase 4, Phase 5} (4 and 5 parallelizable)

### Total Estimated Effort

- 27 files created, 13 files modified
- ~2,260 lines of new code
- 8 E2E tests, 8 integration tests mapped to specific phases

### Wiring Checklists

Each phase includes a concrete wiring checklist to prevent the known failure mode where agents write components but forget to register/import/wire them into callers.

### Cross-Phase Concerns

- Error handling pattern documented for all phases
- Testing allocation mapped: which test specs apply to which phase
- Pre-commit checklist: prettier, build, test, manual verification

# SDLC Log: Structured Data -- Phase 4 (LLD)

**Date:** 2026-03-22
**Phase:** LLD & Implementation Plan
**Artifact:** `docs/plans/2026-03-22-structured-data-impl-plan.md`

## Summary

Generated 6-phase implementation plan to close the 7 gaps identified in feature spec.

## Phase Breakdown

| Phase     | Name                     | Tasks  | Est. Effort |
| --------- | ------------------------ | ------ | ----------- |
| 1         | Observability & Security | 4      | 1 day       |
| 2         | Table Management API     | 2      | 1 day       |
| 3         | Text-to-SQL Execution    | 2      | 2 days      |
| 4         | Query REST API           | 2      | 1 day       |
| 5         | Cascade Delete           | 2      | 1 day       |
| 6         | E2E Test Suite           | 3      | 2 days      |
| **Total** |                          | **15** | **8 days**  |

## Key Implementation Decisions

1. **SQL validation**: Wrap user SQL with mandatory tenant/index filters instead of trusting string-contains check
2. **Text-to-SQL**: Use ClickHouse-specific JSON functions (`JSONExtractString`, `JSONExtractFloat64`) in LLM prompt
3. **Cascade delete**: 4-store cleanup sequence (ClickHouse data, metadata, MongoDB chunks, path index)
4. **Query API**: Single POST endpoint with intent classification + execution in one request
5. **E2E tests**: 7 E2E + 8 integration, all using real infrastructure, zero mocks

## Dependencies

- Phase 1 independent
- Phase 2 and 3 can run in parallel
- Phase 4 depends on Phase 3
- Phase 5 depends on Phase 2
- Phase 6 depends on all others

## Wiring Checklist

6 items: new routes, text-to-sql integration, health check, cascade delete, audit logging

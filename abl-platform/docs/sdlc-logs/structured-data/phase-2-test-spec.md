# SDLC Log: Structured Data -- Phase 2 (Test Spec)

**Date:** 2026-03-22
**Phase:** Test Spec
**Artifact:** `docs/testing/structured-data.md`

## Summary

Generated comprehensive test spec with 7 E2E and 8 integration test scenarios.

## Key Findings

- **7 E2E scenarios**: CSV lifecycle, JSON ingestion, Excel ingestion, tenant isolation, analysis expiration, query routing, error handling
- **8 integration scenarios**: ClickHouse CRUD, Redis cache, schema accuracy, worker pipeline, path extraction, table discovery, query classification, chunking
- **Coverage matrix**: All 9 FR groups covered by at least 2 tiers of testing
- **7 test data fixtures** defined for various formats and edge cases
- **Critical gap**: Existing `ingest-api.test.ts` uses vi.mock() extensively -- violates E2E standards. New E2E tests must use real infrastructure.

## Audit Notes

- Minimum 5 E2E scenarios met (7 provided)
- Minimum 5 integration scenarios met (8 provided)
- No vi.mock() in E2E scenarios
- All E2E tests interact via HTTP API only
- Infrastructure requirements documented

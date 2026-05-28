# SDLC Log: Seed Data -- Phase 2 (Test Spec)

**Date:** 2026-03-23
**Phase:** Test Spec
**Artifact:** `docs/testing/seed-data.md`

## Summary

Generated test spec covering 10 E2E scenarios, 15 integration scenarios, and 34 unit tests. All E2E tests follow the platform mandate: real servers, HTTP API only, no mocks, no direct DB access.

## Coverage Rationale

- **E2E tests** target the full seed pipeline (CLI to DB to API) and the runtime `/api/seed-data` endpoint
- **Integration tests** target the shared upsert layer, Zod validators, and individual seed categories against MongoMemoryServer
- **Unit tests** target pure functions: DSL extraction, tool name validation, PromptCatalog flattening, hash computation

## Key Test Gaps Identified

1. `seed-travel-workflows.ts` has no tests and is not idempotent (generates random UUIDs)
2. Runtime seed-data route has no existing tests
3. No test verifies that `--fresh` is blocked in production
4. No test verifies cross-tenant isolation during multi-tenant seeding

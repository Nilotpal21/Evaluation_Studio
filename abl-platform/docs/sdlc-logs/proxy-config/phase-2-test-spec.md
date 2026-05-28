# SDLC Log: proxy-config -- Phase 2 (Test Spec)

**Date**: 2026-03-23
**Artifact**: `docs/testing/proxy-config.md`

## Summary

Generated test spec documenting existing test coverage and required E2E/integration test scenarios. Found 34+ existing unit tests (14 ProxyResolver + 20 RBAC authz) but zero E2E tests.

## Existing Coverage

- ProxyResolver: 20 unit tests covering pattern matching, auth injection, SSRF, certs, priority, bypass
- RBAC authorization: 20 tests across OWNER, ADMIN, OPERATOR, MEMBER, VIEWER, unauthenticated
- ProxyConfigService: caching behavior tests

## Required New Tests

- 7 E2E test scenarios (CRUD lifecycle, tenant isolation, RBAC, SSRF, duplicates, encryption, runtime integration)
- 7 integration test scenarios (repo CRUD, service caching, Zod validation, encryption round-trip, audit logging, pagination, tool executor integration)

## Key Gaps

- G-1: No E2E tests (HIGH) -- all tests mock repos/middleware
- G-2: No Studio UI (MEDIUM) -- out of scope for now
- G-3: Cache unbounded (MEDIUM) -- needs max size + eviction
- G-6: LLM calls not proxied (MEDIUM) -- separate enhancement

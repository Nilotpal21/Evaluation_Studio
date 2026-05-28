# SDLC Log: Web Crawling -- Phase 4 (LLD)

> **Date:** 2026-03-23
> **Phase:** LLD + Implementation Plan
> **Artifact:** `docs/plans/2026-03-23-web-crawling-impl-plan.md`

## Summary

Generated 5-phase implementation plan focused on closing integration gaps rather than new implementation (since most code already exists).

## Key Implementation Findings

1. **Phase 1 (Auth Hardening) is the most critical**: The crawl-history tenant isolation vulnerability must be fixed before any E2E testing can validate security.

2. **E2E test infrastructure requires local test HTTP server**: Cannot test crawling against real websites in CI. A local Express server serving static pages is needed.

3. **Go worker availability in test environment is uncertain**: E2E tests may need to simulate Go worker output by directly enqueuing to the content-processing queue.

4. **5 phases are all short tasks**: Unlike a greenfield feature, this plan is mostly about testing and hardening existing code. Each phase is 1-2 days of work.

## Phase Sizing

| Phase                               | Estimated Effort | Risk                          |
| ----------------------------------- | ---------------- | ----------------------------- |
| Phase 1: Auth & Isolation Hardening | 0.5 days         | LOW (straightforward fix)     |
| Phase 2: E2E Test Infrastructure    | 1 day            | MEDIUM (test server design)   |
| Phase 3: E2E Test Suite (P0)        | 1.5 days         | MEDIUM (Go worker dependency) |
| Phase 4: Integration Test Suite     | 1 day            | LOW (service-level tests)     |
| Phase 5: E2E Test Suite (P1)        | 1 day            | LOW (incremental)             |
| **Total**                           | **5 days**       |                               |

## Wiring Gaps Identified

| Gap                                               | Phase   |
| ------------------------------------------------- | ------- |
| crawl-history reads tenantId from query params    | Phase 1 |
| Auth middleware wiring on crawl routes unverified | Phase 1 |
| Go worker -> Node.js BullMQ handoff untested      | Phase 4 |
| Circuit breaker Redis persistence untested        | Phase 4 |
| SSRF DNS rebinding protection untested            | Phase 4 |

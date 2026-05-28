# SDLC Log: Web Crawling -- Phase 2 (Test Spec)

> **Date:** 2026-03-23
> **Phase:** Test Spec
> **Artifact:** `docs/testing/web-crawling.md`

## Summary

Generated test spec with 10 E2E scenarios and 12 integration test scenarios.

## Key Findings

1. **Existing unit test coverage is strong**: 130+ profiler tests, 129 decision tests, plus unit tests for crawl-cancel, crawl-dashboard, crawl-history, crawl-security, crawl-url-expansion, and crawl-completion-tracking.

2. **Zero E2E tests**: Despite extensive unit tests, there are no tests that exercise the real HTTP API with auth middleware, rate limiting, and tenant isolation. This is the highest-risk gap.

3. **Go worker handoff is untested**: The BullMQ queue contract between Go worker (`static-crawl` queue) and Node.js CrawlerIngestionWorker (`content-processing` queue) has never been integration-tested.

4. **WebSocket progress streaming untested**: The real-time progress feature uses Redis pub/sub + WebSocket but has no test coverage for client connections or event delivery.

## Coverage Gaps (ordered by risk)

| Gap                                            | Risk Level |
| ---------------------------------------------- | ---------- |
| No E2E tests through real HTTP API             | CRITICAL   |
| No Go worker -> Node.js queue integration test | HIGH       |
| No multi-tenant isolation E2E test             | HIGH       |
| No WebSocket progress test                     | MEDIUM     |
| No circuit breaker Redis integration test      | MEDIUM     |
| No content deduplication E2E test              | MEDIUM     |

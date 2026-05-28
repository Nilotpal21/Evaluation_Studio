# SDLC Log: Web Crawling -- Phase 1 (Feature Spec)

> **Date:** 2026-03-23
> **Phase:** Feature Spec
> **Artifact:** `docs/features/web-crawling.md`

## Summary

Generated feature spec for web crawling based on deep codebase analysis.

## Key Findings

1. **Extensive existing implementation**: Unlike a greenfield feature, web crawling already has substantial code across 4 packages/services:
   - `packages/crawler/` -- Intelligence layer (profiler, decision engine, disclosure, strategy) with 259+ unit tests
   - `apps/crawler-go-worker/` -- Go worker with Colly, SSRF validation, BullMQ consumer
   - `apps/crawler-mcp-server/` -- 11 MCP tools for browser automation
   - `apps/search-ai/` -- Routes, ingestion worker, ingestion service, circuit breaker, progress WebSocket

2. **Primary gaps are integration, not implementation**:
   - No E2E tests through real HTTP API
   - No Studio UI for web crawling
   - Tenant isolation gap in crawl-history routes (reads tenantId from query params)
   - Go worker to Node.js handoff untested in production

3. **Crawl-history tenant isolation vulnerability**: `crawl-history.ts` reads `tenantId` from `req.query` instead of `req.tenantContext`, allowing cross-tenant data access.

## Decisions

| Decision                                         | Classification                 |
| ------------------------------------------------ | ------------------------------ |
| Feature is PLANNED, not ALPHA (no E2E tests yet) | DECIDED                        |
| Go + Playwright dual-track approach              | ANSWERED (already implemented) |
| Scheduled crawls deferred to v2                  | DECIDED                        |
| Auth-gated site crawling deferred to v2          | DECIDED                        |

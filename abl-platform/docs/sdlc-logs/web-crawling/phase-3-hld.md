# SDLC Log: Web Crawling -- Phase 3 (HLD)

> **Date:** 2026-03-23
> **Phase:** HLD
> **Artifact:** `docs/specs/web-crawling.hld.md`

## Summary

Generated HLD addressing all 12 architectural concerns based on actual codebase review.

## Key Architecture Findings

1. **3-layer architecture is sound**: Intelligence (packages/crawler) -> Execution (Go/MCP) -> Ingestion (SearchAI pipeline) is well-separated with clear BullMQ queue boundaries.

2. **Tenant isolation gap in crawl-history**: The GET /jobs route reads tenantId from query params, creating a cross-tenant data access vulnerability. This is the only security gap found.

3. **No new infrastructure required**: All components use existing Redis, MongoDB, BullMQ, and S3/filesystem infrastructure.

4. **Two BullMQ queues form the backbone**: `static-crawl` (SearchAI -> Go Worker) and `content-processing` (Go Worker -> CrawlerIngestionWorker) are the critical handoff points.

5. **SSRF protection is defense-in-depth**: URL validation + DNS resolution + Go worker validation provides 3 layers of protection.

## Architectural Concerns Assessment

| Concern            | Status                                                                       |
| ------------------ | ---------------------------------------------------------------------------- |
| Resource Isolation | GAP in crawl-history (query param tenantId)                                  |
| Auth & AuthZ       | Implemented but needs verification                                           |
| Data Model         | Comprehensive (CrawlJob, CrawlHistory, CrawlAuditEvent, UserCrawlPreference) |
| Error Handling     | Well-structured with circuit breaker and retry logic                         |
| Performance        | Go worker 10k req/s, profiling < 5s                                          |
| Observability      | Structured logging, progress events, audit trail                             |
| Security           | SSRF multi-layer defense, rate limiting, input validation                    |
| Scalability        | Horizontal via BullMQ + stateless routes                                     |
| Reliability        | BullMQ persistence, retry, circuit breaker                                   |
| Compliance         | Audit events, robots.txt respect, tenant isolation                           |
| Backward Compat    | Legacy options API supported                                                 |
| Deployment         | Docker images for Go worker and MCP server                                   |

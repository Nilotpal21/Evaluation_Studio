# SDLC Log: Structured Data -- Phase 3 (HLD)

**Date:** 2026-03-22
**Phase:** HLD
**Artifact:** `docs/specs/structured-data.hld.md`

## Summary

Generated HLD addressing all 12 architectural concerns with 4 alternatives evaluated.

## 12 Architectural Concerns Addressed

1. **Resource Isolation**: ClickHouse ORDER BY includes tenant_id; parameterized queries; route-level index ownership checks
2. **Auth & Authz**: Platform authMiddleware; index ownership validation; cache tenant verification
3. **Data Model**: ClickHouse (table*metadata, structured_data*{id}, json_path_index), MongoDB (SearchChunk), Redis (analysis cache)
4. **Performance**: Metadata-only chunking (99% savings), bulk ClickHouse insert, async BullMQ processing, gzip compression
5. **Error Handling**: 3-retry exponential backoff, job failure tracking, cache miss handling
6. **Observability**: Structured logging with context (gap: uses console.log not platform logger, no TraceEvents)
7. **Security**: Parameterized queries, MIME type filter, file size limit (gap: weak SQL validation, no table name sanitization)
8. **Deployment**: ClickHouse + Redis + MongoDB required; auto-schema creation; no migration framework
9. **Backward Compatibility**: Additive endpoints only; no existing API or data changes
10. **Configuration**: CLICKHOUSE_URL, REDIS_URL env vars; no feature flags currently
11. **Compliance**: 1-hour TTL for cache, no permanent file storage (gaps: no cascade delete, no audit trail, no PII detection)
12. **Testing**: 13 unit test files exist; gap in E2E tests (existing tests use mocks)

## Alternatives Evaluated

1. PostgreSQL (rejected: 10-100x slower for analytics)
2. DuckDB (rejected: no multi-tenant shared access across pods)
3. Single-phase ingestion (rejected: 10% schema error rate)
4. Row-level chunking (rejected: 99%+ cost increase)

## Critical Gaps Identified

- `executeQuery()` SQL validation is weak (string-contains check)
- No circuit breaker for ClickHouse
- No cascade delete (ClickHouse table + MongoDB chunk)
- console.log instead of platform logger
- No audit logging
- No ClickHouse migration framework

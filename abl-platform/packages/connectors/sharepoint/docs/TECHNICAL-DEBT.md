# SharePoint Connector Technical Debt Audit

**Date**: 2026-02-25
**Status**: Awaiting Review
**Scope**: Comprehensive audit of scaling, testing, documentation, and code quality issues

---

## Executive Summary

Comprehensive technical debt audit revealed **2 CRITICAL**, **9 HIGH**, and **7 MEDIUM** priority issues across scaling, testing, observability, and documentation. The system is production-ready for moderate workloads but requires fixes for:

1. **Memory exhaustion** with 100K+ documents
2. **Distributed locking** for multi-pod deployments
3. **Test coverage** for workers and E2E flows
4. **Observability** (structured logging, metrics)
5. **Performance** (N+1 queries, hardcoded limits)

Total estimated effort: **25-30 days** for all HIGH priority items.

---

## Priority Classification

| Priority     | Count | Description                                                      |
| ------------ | ----- | ---------------------------------------------------------------- |
| **CRITICAL** | 2     | Data integrity or OOM issues; blocks production at scale         |
| **HIGH**     | 9     | Significant impact on reliability, observability, or performance |
| **MEDIUM**   | 7     | Important for operations; can be deferred short-term             |
| **LOW**      | 10+   | Code quality improvements; minimal impact                        |

---

## CRITICAL Priority Issues (2)

### Task #43: Implement streaming for getDriveItemsRecursive

- **Problem**: Loads all 100K+ items into memory → OOM kills
- **File**: `packages/connectors/sharepoint/src/client/graph-client.ts:144-168`
- **Impact**: Cannot sync large SharePoint sites (>50K items)
- **Solution**: Async generator pattern for streaming
- **Effort**: 1 day
- **Status**: Pending

### Task #44: Implement distributed sync lock

- **Problem**: Multiple pods can sync same connector → duplicates, race conditions
- **File**: `apps/search-ai/src/workers/connector-sync-worker.ts:181`
- **Impact**: Data integrity issues in Kubernetes deployments
- **Solution**: Redis-based distributed lock
- **Effort**: 1 day
- **Status**: Pending

---

## HIGH Priority Issues (9)

### Task #45: Replace hardcoded rate limits with configurable quotas

- **Problem**: Hardcoded 10K requests/10min; no per-tenant tuning
- **File**: `packages/connectors/sharepoint/src/client/graph-client.ts:38`
- **Impact**: Rate limit errors under high load
- **Solution**: Config-driven rate limits with Retry-After header support
- **Effort**: 2 days
- **Status**: Pending

### Task #46: Add unit tests for connector-sync-worker

- **Problem**: Core worker untested (pause/resume/restart, error recovery)
- **Missing**: `apps/search-ai/src/__tests__/connector-sync-worker.test.ts`
- **Impact**: No test coverage for critical workflows
- **Solution**: Comprehensive unit test suite
- **Effort**: 2 days
- **Status**: Pending

### Task #47: Replace console.log with structured logging

- **Problem**: 50+ console.log calls; no trace IDs, no structured events
- **Files**: All sync coordinators and workers
- **Impact**: Cannot debug multi-pod operations or track syncs
- **Solution**: Structured logger with trace events
- **Effort**: 2-3 days
- **Status**: Pending

### Task #48: Implement load testing suite

- **Problem**: No performance benchmarks or SLOs defined
- **Missing**: Load tests for 10K, 100K, 500K item syncs
- **Impact**: Cannot validate system handles production scale
- **Solution**: Comprehensive load test suite
- **Effort**: 3-4 days
- **Status**: Pending

### Task #49: Optimize permission crawl (N+1 problem)

- **Problem**: One API call per document → 100K calls for 100K docs
- **File**: `packages/connectors/sharepoint/src/permissions/sharepoint-permission-crawler.ts:94-104`
- **Impact**: Permission crawl takes hours; bottleneck
- **Solution**: Batch API requests or hierarchical inheritance
- **Effort**: 2-3 days
- **Status**: Pending

### Task #50: Move deviceCodeSessions to Redis

- **Problem**: In-memory Map; pod restart loses all active OAuth flows
- **File**: `apps/search-ai/src/routes/connectors.ts:48`
- **Impact**: Users lose auth progress on pod restart
- **Solution**: Redis-backed session store with TTL
- **Effort**: 1 day
- **Status**: Pending

### Task #53: Add unit tests for webhook-notification-worker

- **Problem**: Webhook worker untested (dedup, debounce, batching)
- **Missing**: `apps/search-ai/src/__tests__/webhook-notification-worker.test.ts`
- **Impact**: Webhook logic untested
- **Solution**: Comprehensive unit test suite
- **Effort**: 2 days
- **Status**: Pending

### Task #54: Add E2E tests for pause/resume/restart

- **Problem**: Critical workflows untested end-to-end
- **Missing**: E2E test scenarios from API to database
- **Impact**: Pause/resume correctness not validated
- **Solution**: E2E test suite with real database and workers
- **Effort**: 2-3 days
- **Status**: Pending

### Task #56: Add overall sync timeout and graceful termination

- **Problem**: No sync-level timeout; hung API calls block forever
- **File**: `packages/connectors/sharepoint/src/sync/full-sync-coordinator.ts`
- **Impact**: Syncs can hang indefinitely
- **Solution**: Configurable timeout with checkpoint save
- **Effort**: 1-2 days
- **Status**: Pending

---

## MEDIUM Priority Issues (7)

### Task #42: Update connector documentation for pause/resume/restart

- **Problem**: New features not documented
- **Files**: USER-GUIDE.md, ARCHITECTURE.md, API.md
- **Effort**: 1 day
- **Status**: Pending

### Task #51: Extract hardcoded limits to configuration

- **Problem**: 8+ magic numbers hardcoded (timeouts, batch sizes, etc.)
- **Files**: Multiple coordinators and workers
- **Solution**: Add performanceConfig field to ConnectorConfig model
- **Effort**: 2 days
- **Status**: Pending

### Task #52: Complete connector documentation

- **Problem**: Missing API docs, runbooks, troubleshooting guides
- **Files**: API.md, PRODUCTION-DEPLOYMENT.md, new RUNBOOKS.md
- **Effort**: 3-4 days
- **Status**: Pending

### Task #55: Implement resource cleanup on connector deletion

- **Problem**: Orphaned webhooks, checkpoints, delta tokens after deletion
- **File**: `apps/search-ai/src/routes/connectors.ts:252-291`
- **Solution**: Cascade delete all related resources
- **Effort**: 1 day
- **Status**: Pending

### Additional MEDIUM Issues (not yet tasked):

- No configurable page size in Graph API calls
- Document content fetched synchronously (no batching)
- No queue depth monitoring for backpressure
- Code duplication (filter logic, mapToSourceDocument)

---

## LOW Priority Issues (10+)

### Code Quality

- Dead code (deprecated getDeltaToken method)
- Type safety issues (loose typing on permission objects)
- TODO comments in production code (nested groups, webhook setup)
- Console.warn for errors that should propagate
- No structured error types (all `error: any`)

### Resource Cleanup

- Stale checkpoint records not cleaned up
- No request/trace ID for log correlation

### Documentation

- Missing OpenAPI/Swagger spec
- Error codes not documented
- No debug-level logs

---

## Task Dependency Graph

```
CRITICAL (blocks everything)
├─ Task #43: Streaming (required for 100K+ docs)
└─ Task #44: Distributed lock (required for multi-pod)

HIGH (blocks production readiness)
├─ Task #45: Configurable rate limits
├─ Task #46: Worker unit tests
├─ Task #47: Structured logging
├─ Task #48: Load testing
├─ Task #49: Permission crawl optimization
├─ Task #50: Redis device code sessions
├─ Task #53: Webhook worker tests
├─ Task #54: E2E pause/resume tests
└─ Task #56: Sync timeout

MEDIUM (improves operations)
├─ Task #42: Pause/resume docs
├─ Task #51: Extract hardcoded limits
├─ Task #52: Complete documentation
└─ Task #55: Resource cleanup
```

---

## Recommended Implementation Order

### Phase 1: Critical (Week 1)

1. **Task #43**: Streaming for memory safety
2. **Task #44**: Distributed lock for multi-pod

### Phase 2: Scaling & Observability (Week 2-3)

3. **Task #45**: Configurable rate limits
4. **Task #47**: Structured logging + trace events
5. **Task #50**: Redis device code sessions
6. **Task #56**: Sync timeout

### Phase 3: Performance (Week 3-4)

7. **Task #49**: Permission crawl optimization
8. **Task #51**: Extract hardcoded limits

### Phase 4: Testing (Week 4-5)

9. **Task #46**: Worker unit tests
10. **Task #53**: Webhook worker tests
11. **Task #54**: E2E tests
12. **Task #48**: Load testing

### Phase 5: Polish (Week 5-6)

13. **Task #42**: Pause/resume docs
14. **Task #52**: Complete documentation
15. **Task #55**: Resource cleanup

---

## Metrics & Success Criteria

### Performance SLOs (to be validated by Task #48)

- **10K items**: <10 minutes, <2GB RAM, >20 items/sec
- **100K items**: <60 minutes, <2GB RAM, >30 items/sec
- **500K items**: <5 hours, no memory growth

### Test Coverage Targets

- Worker unit tests: 80%+ coverage
- E2E test coverage: All critical workflows
- Load test scenarios: 5+ validated

### Observability Requirements

- All sync operations emit structured trace events
- Request correlation IDs in all logs
- Metrics dashboard for sync health

---

## Open Questions for Review

1. **Priority agreement**: Do we agree CRITICAL > HIGH priority order?
2. **Effort estimates**: Are 1-4 day estimates realistic for your team?
3. **Phase sequencing**: Should we do testing before optimization, or vice versa?
4. **Immediate action**: Which task should we start with TODAY?
5. **Resource allocation**: How many engineers can work on this in parallel?

---

## Next Steps

1. **Review this document** - Confirm priorities and effort estimates
2. **Select Phase 1 tasks** - Start with Critical issues (#43, #44)
3. **Create subtasks** - Break down into smaller implementation steps
4. **Assign owners** - Distribute work across team
5. **Set milestones** - Define completion dates per phase
6. **Track progress** - Weekly check-ins on task completion

---

**Document Status**: Draft - Awaiting User Review
**Last Updated**: 2026-02-25
**Next Review**: After user feedback on priorities

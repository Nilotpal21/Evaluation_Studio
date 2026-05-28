# High-Level Design: Connector Discovery

- **Feature ID**: #39
- **Status**: ALPHA
- **Author**: SearchAI Team
- **Created**: 2026-03-22
- **Last Updated**: 2026-03-22
- **Feature Spec**: `docs/features/connector-discovery.md`
- **Test Spec**: `docs/testing/connector-discovery.md`

---

## 1. Executive Summary

The Connector Discovery feature automates the exploration of enterprise data sources connected via the ABL platform's connector framework. When a user connects a data source (e.g., SharePoint, Jira, Salesforce), discovery enumerates all accessible resources, profiles their content, and generates intelligent recommendations for sync configuration. This reduces connector setup from 20+ minutes of manual configuration to under 60 seconds.

The architecture follows a **Template Method pattern** for connector-specific discovery, a **deterministic scoring engine** for recommendations, and **BullMQ** for asynchronous processing with **distributed locking** for concurrency control.

## 2. Architecture Overview

```
+─────────────────────────────────────────────────────────────────────────+
│                           Studio UI Layer                               │
│  EnterpriseConnectorWizard.tsx                                          │
│  [Configure] → [Auth] → [Setup Path] → [Discovery Progress] → [Review] │
+────────────────────────────────┬────────────────────────────────────────+
                                 │ HTTP (Polling)
                                 ▼
+─────────────────────────────────────────────────────────────────────────+
│                        SearchAI API Layer                                │
│  connector-discovery.ts (7 endpoints)                                    │
│  POST /discover  GET /discovery  POST /recommendations                   │
│  POST /recommendations/:id/accept  POST /quick-setup                    │
+────────────────────────────────┬────────────────────────────────────────+
                                 │
                                 ▼
+─────────────────────────────────────────────────────────────────────────+
│                       Service Layer                                      │
│  quick-setup-orchestrator.ts                                             │
│  ┌──────────────────┐  ┌────────────────────────────────┐               │
│  │ triggerDiscovery  │  │ generateRecommendations         │               │
│  │ acceptRecommend.  │  │ RecommendationEngineService     │               │
│  └────────┬─────────┘  └────────────────────────────────┘               │
│           │                                                              │
│           ▼                                                              │
│  +─────────────────────────────────────────────────────────+            │
│  │              BullMQ Queue Layer                           │            │
│  │  QUEUE: connector-discovery                               │            │
│  │  Concurrency: 2  |  Lock TTL: 10 min                     │            │
│  +────────────────────────┬──────────────────────────────────+            │
│                           │                                              │
│                           ▼                                              │
│  +─────────────────────────────────────────────────────────+            │
│  │          Connector Discovery Worker                       │            │
│  │  ┌──────────────────────────────────────────────┐        │            │
│  │  │ 1. Acquire distributed lock (Redis SET NX PX) │        │            │
│  │  │ 2. Load connector config                       │        │            │
│  │  │ 3. Initialize connector                        │        │            │
│  │  │ 4. IResourceDiscovery.discoverResources()      │        │            │
│  │  │ 5. IResourceDiscovery.profileContent()         │        │            │
│  │  │ 6. Save to ConnectorDiscovery (MongoDB)        │        │            │
│  │  │ 7. Generate recommendations (quick_setup)      │        │            │
│  │  │ 8. Release lock                                │        │            │
│  │  └──────────────────────────────────────────────┘        │            │
│  +─────────────────────────────────────────────────────────+            │
+─────────────────────────────────────────────────────────────────────────+
                                 │
                                 ▼
+─────────────────────────────────────────────────────────────────────────+
│                     Connector Layer                                       │
│  packages/connectors/base                                                │
│  ┌──────────────────────┐  ┌────────────────────────────┐               │
│  │ IResourceDiscovery   │  │ BaseResourceDiscovery       │               │
│  │ - discoverResources  │  │ - detectSensitivity         │               │
│  │ - profileContent     │  │ - calculateUpdateFrequency  │               │
│  └──────────┬───────────┘  │ - buildResourceTree         │               │
│             │              └────────────────────────────┘               │
│             ▼                                                            │
│  ┌─────────────────────────────────────────────────────┐                │
│  │ SharePointResourceDiscovery                          │                │
│  │ - GraphClient.getSites()                             │                │
│  │ - GraphClient.getDrives(siteId)                      │                │
│  │ - GraphClient.getDriveItemsStream(driveId, sample)   │                │
│  └─────────────────────────────────────────────────────┘                │
+─────────────────────────────────────────────────────────────────────────+
                                 │
                                 ▼
+─────────────────────────────────────────────────────────────────────────+
│                    Persistence Layer                                      │
│  MongoDB (platform DB)                 Redis                             │
│  ┌──────────────────────┐             ┌─────────────────────────┐       │
│  │ ConnectorDiscovery   │             │ discovery-lock:<id>      │       │
│  │ ConnectorRecommend.  │             │ BullMQ queues            │       │
│  │ ConnectorConfig      │             └─────────────────────────┘       │
│  │ ConnectorSchema      │                                                │
│  └──────────────────────┘                                                │
+─────────────────────────────────────────────────────────────────────────+
```

## 3. Design Decisions

### DD-1: Deterministic Scoring (No LLM)

**Decision**: The recommendation engine uses purely deterministic algorithms -- weighted scoring with named constants -- rather than LLM-based analysis.

**Rationale**:

- Reproducible: same input always produces same recommendation
- Fast: synchronous execution in <100ms
- No LLM cost or latency
- Auditable: scoring factors are fully explainable
- Testable: unit tests can verify exact scores

**Alternative Considered**: LLM-based content analysis for richer recommendations. Deferred to future enhancement because deterministic scoring covers the 80% case and avoids LLM dependency complexity.

### DD-2: BullMQ Worker (Not Inline Execution)

**Decision**: Discovery runs asynchronously via BullMQ worker, not inline in the HTTP request handler.

**Rationale**:

- Discovery can take 5+ minutes for large tenants
- HTTP timeout would kill inline execution
- BullMQ provides: retry, progress tracking, job persistence, graceful shutdown
- Workers scale independently from the API server

**Alternative Considered**: Inline execution with HTTP streaming. Rejected because it doesn't survive server restarts and complicates load balancer configuration.

### DD-3: Distributed Lock (Not Job Deduplication)

**Decision**: Use Redis distributed lock (`SET NX PX`) to prevent concurrent discovery, rather than BullMQ's built-in job deduplication.

**Rationale**:

- Explicit control over lock TTL and renewal
- BullMQ dedup is based on jobId, which would require deterministic job IDs
- Lock provides clear error semantics ("discovery already in progress")
- Same pattern used across the platform (platform invariant #3)

**Alternative Considered**: BullMQ unique job IDs. Rejected because it conflates job scheduling with concurrency control and provides less clear error messaging.

### DD-4: Embedded Arrays (Not Separate Collections)

**Decision**: DiscoveredResource[] and ContentProfile[] are embedded in the ConnectorDiscovery document, not stored in separate collections.

**Rationale**:

- Discovery results are always read/written as a unit
- No need for individual resource queries
- Simpler data model and fewer queries
- TTL applies to the entire discovery record atomically

**Alternative Considered**: Separate `discovered_resources` collection with references. Would be needed if discovery exceeds MongoDB's 16MB document limit, but for current scale (hundreds of resources, not thousands) embedded is simpler.

### DD-5: Template Method Pattern for Connector Discovery

**Decision**: `BaseResourceDiscovery` abstract class with `discoverResources()` and `profileContent()` as abstract methods, shared helpers as concrete methods.

**Rationale**:

- Same pattern as `BaseSyncCoordinator` (consistency)
- Shared logic: sensitivity detection, update frequency calculation, tree building
- New connectors only implement the abstract methods
- Type-safe contract via `IResourceDiscovery` interface

**Alternative Considered**: Strategy pattern with function composition. Rejected for consistency with existing sync coordinator pattern.

## 4. Twelve Architectural Concerns

### 4.1 Resource Isolation

- **Tenant**: Every query includes `tenantId`. Routes use `req.tenantContext!.tenantId`. Models have `tenantIsolationPlugin`.
- **Connector**: Discovery and recommendation records are scoped to `connectorId + tenantId`.
- **Cross-tenant**: Returns 404 (not 403) for non-existent or unauthorized resources.
- **Worker**: Uses `withTenantContext()` wrapper for all DB operations.

### 4.2 Authentication & Authorization

- Routes depend on `req.tenantContext` populated by upstream auth middleware.
- Connector must have `oauthTokenId` before discovery can proceed.
- No additional permission checks beyond tenant scope (all tenant users can discover).
- **Gap**: No project-level isolation. Discovery is connector-scoped, and connectors are currently tenant-scoped (not project-scoped). If connectors move under projects, discovery routes need `requireProjectPermission()`.

### 4.3 Data Integrity

- Discovery status transitions are sequential: pending -> discovering -> profiling -> completed | failed.
- Recommendation status transitions: generated -> accepted | rejected.
- Distributed lock ensures only one discovery per connector at a time.
- TTL index ensures stale discovery records are automatically cleaned up.
- Failed discovery sets error field and releases lock.

### 4.4 Performance

- Discovery is async (no HTTP timeout risk).
- Recommendation generation is synchronous (<100ms for typical inputs).
- Content profiling is bounded by `sampleSize` (default 100 docs per drive).
- BullMQ concurrency of 2 limits resource usage per worker.
- Progress reporting uses BullMQ's built-in progress mechanism.

### 4.5 Scalability

- Workers can be horizontally scaled (multiple pods with same queue).
- Distributed lock prevents thundering herd on same connector.
- Discovery for different connectors runs in parallel.
- MongoDB indexes optimize lookup patterns: `(tenantId, connectorId)`.

### 4.6 Reliability

- BullMQ provides automatic retry on worker crashes.
- Distributed lock auto-expires after 10 minutes (prevents deadlocks).
- Partial failures (access-denied sites) are recorded but don't fail the entire discovery.
- SIGTERM handler enables graceful shutdown of worker.
- `removeOnComplete` and `removeOnFail` prevent BullMQ job accumulation.

### 4.7 Observability

- Worker uses `workerLog` and `workerError` helpers for structured logging.
- Duration tracking per discovery run.
- Progress reporting (0-100%) for UI polling.
- **Gap**: Uses `console.error` in route handlers instead of `createLogger`. Should be migrated.
- **Gap**: No TraceEvent emission for discovery operations. Should emit trace events for integration with the observatory.

### 4.8 Security

- OAuth tokens are never logged or included in discovery results.
- Discovery results contain only resource metadata (names, URLs, file type counts).
- Sensitivity detection flags but does not access document content.
- All API responses use standard error envelope (no stack traces).
- **Gap**: No request body validation via Zod schemas. Route handlers manually validate mode but don't validate other body fields.

### 4.9 Compliance

- Discovery records have 7-day TTL (data minimization).
- No PII is stored in discovery results (only aggregate statistics).
- Sensitivity indicators flag potential compliance concerns without accessing content.
- Recommendation audit trail: `userDecision` records action, overrides, and timestamp.

### 4.10 Extensibility

- `IResourceDiscovery` interface allows adding new connector types.
- `BaseResourceDiscovery` provides shared helpers for new implementations.
- `RecommendationEngineService` scoring weights are named constants (configurable).
- Worker's connector switch statement needs extension per new connector type.
- **Gap**: Worker uses hard-coded `switch (connectorType)` with only `sharepoint`. Should use a connector registry pattern.

### 4.11 Testing

- Unit tests exist but heavily mocked (low behavioral coverage).
- E2E and integration tests defined in test spec.
- Recommendation engine is pure function (easiest to test).
- Worker requires BullMQ + Redis + MongoDB for meaningful tests.
- See `docs/testing/connector-discovery.md` for full test plan.

### 4.12 Deployment

- No new services; all components run within existing SearchAI process.
- Worker is started alongside other workers in `apps/search-ai/src/workers/index.ts`.
- MongoDB model registered via `ModelRegistry` for dual-database support.
- Redis is shared with other BullMQ workers.
- No new environment variables required.

## 5. Alternatives Considered

### Alternative A: Inline Discovery with Streaming Response

**Approach**: Execute discovery inline in the HTTP handler and stream results via Server-Sent Events.

**Pros**:

- Real-time progress without polling
- Simpler architecture (no BullMQ, no distributed lock)
- Fewer infrastructure dependencies

**Cons**:

- HTTP timeout kills long-running discoveries
- Doesn't survive server restarts
- Load balancer timeout configuration complexity
- No retry on failure
- Not consistent with platform's async work pattern

**Decision**: Rejected. BullMQ worker is the established pattern for async work in this platform.

### Alternative B: LLM-Enhanced Recommendations

**Approach**: Use an LLM to analyze sample document content and generate richer recommendations (e.g., suggest content categories, detect document quality).

**Pros**:

- Richer, more context-aware recommendations
- Could suggest canonical schema mappings
- Could detect document quality issues

**Cons**:

- LLM latency (seconds, not milliseconds)
- LLM cost per discovery
- Non-deterministic (harder to test)
- Requires LLM credential availability

**Decision**: Deferred to future enhancement. Deterministic scoring covers the 80% case. LLM enhancement can be layered on top as an optional mode.

### Alternative C: Separate Microservice for Discovery

**Approach**: Extract discovery into its own microservice with dedicated scaling.

**Pros**:

- Independent scaling of discovery workload
- Isolated failure domain
- Could support multiple languages for connector implementations

**Cons**:

- Additional deployment complexity
- Cross-service communication overhead
- MongoDB dual-connection pattern already handles database access
- Discovery workload is bursty (mostly idle), not warranting dedicated infra

**Decision**: Rejected. Discovery runs within the existing SearchAI process. If discovery becomes a bottleneck, the BullMQ worker can be extracted into a separate deployment without code changes.

## 6. Known Gaps and Technical Debt

| ID   | Gap                                       | Severity | Remediation                                                   |
| ---- | ----------------------------------------- | -------- | ------------------------------------------------------------- |
| G-1  | Only SharePoint discovery implemented     | HIGH     | Implement IResourceDiscovery for Jira, Confluence, Salesforce |
| G-2  | Hard-coded connector switch in worker     | MEDIUM   | Replace with connector registry factory pattern               |
| G-3  | console.error in route handlers           | MEDIUM   | Replace with createLogger('connector-discovery')              |
| G-4  | No Zod request body validation            | MEDIUM   | Add Zod schemas for all POST endpoint bodies                  |
| G-5  | No TraceEvent emission                    | MEDIUM   | Emit discovery trace events for observatory                   |
| G-6  | No project-level isolation                | LOW      | Add projectId scoping if connectors become project-scoped     |
| G-7  | 16MB MongoDB document limit               | LOW      | Monitor; implement chunked storage if needed                  |
| G-8  | No discovery re-run scheduling            | LOW      | Add periodic re-discovery for resource inventory freshness    |
| G-9  | Polling instead of WebSocket for progress | LOW      | Add WebSocket progress channel for real-time UI updates       |
| G-10 | No lock TTL renewal for long discoveries  | MEDIUM   | Implement periodic lock renewal for tenants with 1000+ sites  |

## 7. Cross-Cutting Concerns

### Error Handling

All route handlers use try/catch with standard error envelope:

```json
{ "success": false, "error": { "code": "ERROR_CODE", "message": "description" } }
```

Worker errors transition discovery to `failed` status and release the distributed lock.

### Logging

Current: mix of `console.error` (routes) and `workerLog/workerError` (worker).
Target: All logging via `createLogger('connector-discovery')`.

### Monitoring

- BullMQ dashboard shows queue depth, processing time, failure rate
- MongoDB query for discovery success/failure ratios
- Discovery duration histograms (P50, P95, P99)

## 8. Changelog

| Date       | Version | Change                                  |
| ---------- | ------- | --------------------------------------- |
| 2026-03-22 | 1.0     | Initial HLD generated via SDLC pipeline |

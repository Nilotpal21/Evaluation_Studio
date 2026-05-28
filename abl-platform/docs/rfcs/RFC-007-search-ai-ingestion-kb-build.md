# RFC-007: Search AI Ingestion and KB Build

- Status: Draft (5-level deep functional specification)
- Feature ID: F007
- Focus: Search AI ingestion and KB build pipelines
- Covered files in feature map: 653
- Source mapping: `docs/specs/feature-map.json`

## 1. Level 1: Business Capability Definition

This feature delivers **Search AI ingestion and KB build pipelines** as a first-class platform capability.

### 1.1 Capability Boundaries

- In-scope top-level domains:
  - apps (489 files)
  - services (117 files)
  - packages (47 files)
- Out-of-scope: functionality owned by adjacent split features unless explicitly mapped in this feature.

## 2. Level 2: Domain and Subdomain Decomposition

| Domain (L2)                    | File Count | Purpose                                                                 |
| ------------------------------ | ---------: | ----------------------------------------------------------------------- |
| apps/search-ai                 |        348 | Operational subdomain contributing to Search AI Ingestion and KB Build. |
| apps/studio                    |         81 | Operational subdomain contributing to Search AI Ingestion and KB Build. |
| services/preprocessing-service |         57 | Operational subdomain contributing to Search AI Ingestion and KB Build. |
| apps/multimodal-service        |         55 | Operational subdomain contributing to Search AI Ingestion and KB Build. |
| services/docling-service       |         52 | Operational subdomain contributing to Search AI Ingestion and KB Build. |
| packages/search-ai-internal    |         38 | Operational subdomain contributing to Search AI Ingestion and KB Build. |
| packages/database              |          9 | Operational subdomain contributing to Search AI Ingestion and KB Build. |
| services/bge-m3-service        |          8 | Operational subdomain contributing to Search AI Ingestion and KB Build. |
| apps/nlu-sidecar               |          5 | Operational subdomain contributing to Search AI Ingestion and KB Build. |

## 3. Level 3: Functional Flow Decomposition

### 3.1 Primary Flows

- Flow 1: Source ingest to indexed document
- Flow 2: Structured data ingest finalize
- Flow 3: Knowledge graph enrichment

### 3.2 API and Route Surface

- App-route endpoints discovered: 49
  - /api/search-ai/connectors/[connectorId]/auth/initiate
  - /api/search-ai/connectors/[connectorId]/auth/status
  - /api/search-ai/connectors/[connectorId]/discover
  - /api/search-ai/connectors/[connectorId]/discovery
  - /api/search-ai/connectors/[connectorId]/quick-setup
  - /api/search-ai/connectors/[connectorId]/recommendations/[recommendationId]/accept
  - /api/search-ai/connectors/[connectorId]/recommendations
  - /api/search-ai/connectors/[connectorId]/sync/start
  - /api/search-ai/connectors/[connectorId]/sync/status
  - /api/search-ai/indexes/[id]/connectors
  - /api/search-ai/indexes/[id]/kg-configuration-status
  - /api/search-ai/indexes/[id]/kg-configure-model
  - /api/search-ai/indexes/[id]/kg-enrich/documents
  - /api/search-ai/indexes/[id]/kg-enrich/entities
  - /api/search-ai/indexes/[id]/kg-enrich/graph
  - /api/search-ai/indexes/[id]/kg-enrich
  - /api/search-ai/indexes/[id]/kg-enrich/stats
  - /api/search-ai/indexes/[id]/kg-taxonomy/domains/[domainId]
  - /api/search-ai/indexes/[id]/kg-taxonomy/domains/generate
  - /api/search-ai/indexes/[id]/kg-taxonomy/domains
  - /api/search-ai/indexes/[id]/kg-taxonomy/generate-profile
  - /api/search-ai/indexes/[id]/kg-taxonomy
  - /api/search-ai/indexes/[id]/kg-taxonomy/setup/[jobId]
  - /api/search-ai/indexes/[id]/kg-taxonomy/setup
  - /api/search-ai/indexes/[id]/kg-toggle
  - /api/search-ai/indexes/[id]/rebuild
  - /api/search-ai/indexes/[id]
  - /api/search-ai/indexes/[id]/sources/[sourceId]/documents
  - /api/search-ai/indexes/[id]/sources/[sourceId]
  - /api/search-ai/indexes/[id]/sources/[sourceId]/status
  - /api/search-ai/indexes/[id]/sources
  - /api/search-ai/indexes/[id]/vocabulary/[entryId]
  - /api/search-ai/indexes/[id]/vocabulary/bulk
  - /api/search-ai/indexes/[id]/vocabulary
  - /api/search-ai/indexes/[id]/vocabulary/suggest
  - /api/search-ai/indexes/[id]/vocabulary/test
  - /api/search-ai/indexes/kg-taxonomy/domains/[domainId]
  - /api/search-ai/indexes/kg-taxonomy/domains
  - /api/search-ai/indexes
  - /api/search-ai/knowledge-bases/[id]/rebuild
  - /api/search-ai/knowledge-bases/[id]
  - /api/search-ai/knowledge-bases
  - /api/search-ai/mappings/[id]/confirm
  - /api/search-ai/mappings/[id]/reject
  - /api/search-ai/mappings/[id]/test
  - /api/search-ai/mappings
  - /api/search-ai/mappings/suggest
  - /api/search-ai/schemas/[id]
  - /api/search-ai/schemas/connectors/[connectorId]

- Router method inventory (module-level):
  - apps/multimodal-service/src/routes/admin.ts
    - GET /config/:tenantId
    - PUT /config/:tenantId
  - apps/multimodal-service/src/routes/attachments.ts
    - POST /
    - GET /session/:sessionId
    - DELETE /session/:sessionId
    - GET /:attachmentId
    - GET /:attachmentId/url
    - DELETE /:attachmentId
    - GET /:attachmentId/status
  - apps/search-ai/src/routes/admin.ts
    - POST /indexes/rotate-shared
    - GET /indexes/shared/status
    - POST /indexes/shared/archive/:version
  - apps/search-ai/src/routes/chunks.ts
    - GET /:indexId/documents/:documentId/chunks
    - GET /:indexId/chunks/:chunkId
  - apps/search-ai/src/routes/connector-discovery.ts
    - POST /connectors/:connectorId/discover
    - GET /connectors/:connectorId/discovery
    - GET /connectors/:connectorId/discovery/:discoveryId
    - POST /connectors/:connectorId/recommendations
    - GET /connectors/:connectorId/recommendations
    - POST /connectors/:connectorId/recommendations/:recommendationId/accept
    - POST /connectors/:connectorId/quick-setup
  - apps/search-ai/src/routes/connectors.ts
    - GET /:indexId/connectors
    - POST /:indexId/connectors
    - GET /:indexId/connectors/:connectorId
    - PUT /:indexId/connectors/:connectorId
    - DELETE /:indexId/connectors/:connectorId
    - POST /connectors/:connectorId/auth/initiate
    - GET /connectors/:connectorId/auth/status
    - POST /connectors/:connectorId/auth/callback
  - apps/search-ai/src/routes/crawl-history.ts
    - GET /jobs
    - GET /jobs/:jobId
    - GET /history/:jobId
    - GET /jobs/:jobId/compare
    - GET /audit/:jobId
    - POST /audit/event
  - apps/search-ai/src/routes/crawl.ts
    - POST /batch
    - POST /batch/respond
    - GET /preview-urls
    - POST /profile
    - GET /status
    - GET /dashboard/:jobId
    - GET /history
    - GET /preferences
  - apps/search-ai/src/routes/crawler-ingestion.ts
    - POST /ingest/crawled-content
    - GET /ingest/status/:documentId
  - apps/search-ai/src/routes/document-upload.ts
    - POST /:indexId/sources/:sourceId/documents
    - GET /:indexId/documents/:documentId
  - apps/search-ai/src/routes/documents.ts
    - GET /:indexId/documents
    - DELETE /:indexId/documents/:documentId
  - apps/search-ai/src/routes/errors.ts
    - GET /
    - GET /stats
    - POST /:documentId/retry
  - apps/search-ai/src/routes/health.ts
    - GET /
  - apps/search-ai/src/routes/indexes.ts
    - GET /
    - POST /
    - GET /:indexId
    - PATCH /:indexId
    - GET /:indexId/llm-config
    - PATCH /:indexId/llm-config
    - DELETE /:indexId
    - POST /:indexId/rebuild
  - apps/search-ai/src/routes/jobs.ts
    - GET /
    - POST /
    - GET /:jobId
  - apps/search-ai/src/routes/kg-enrichment.ts
    - POST /:indexId/kg-enrich
    - GET /:indexId/kg-enrich/jobs/:jobId
    - GET /:indexId/kg-enrich/jobs
    - GET /:indexId/kg-enrich/stats
    - GET /:indexId/kg-enrich/documents
    - GET /:indexId/kg-enrich/entities
    - GET /:indexId/kg-enrich/graph
  - apps/search-ai/src/routes/kg-taxonomy.ts
    - GET /:indexId/kg-configuration-status
    - POST /:indexId/kg-configure-model
    - GET /kg-taxonomy/domains
    - GET /kg-taxonomy/domains/:domainId
    - POST /:indexId/kg-taxonomy/generate-profile
    - POST /:indexId/kg-taxonomy/domains/generate
    - POST /:indexId/kg-taxonomy/domains
    - GET /:indexId/kg-taxonomy/domains
  - apps/search-ai/src/routes/knowledge-bases.ts
    - GET /
    - POST /
    - GET /:kbId
    - PATCH /:kbId
    - DELETE /:kbId
    - POST /:kbId/rebuild
  - apps/search-ai/src/routes/mappings.ts
    - GET /
    - POST /suggest
    - POST /:mappingId/confirm
    - POST /:mappingId/reject
    - POST /:mappingId/test
    - GET /review
    - POST /batch-update
    - GET /stats/:canonicalSchemaId
  - apps/search-ai/src/routes/metrics.ts
    - GET /job/:jobId
    - GET /aggregate
  - apps/search-ai/src/routes/queue-monitoring.ts
    - GET /stats
    - GET /health
    - POST /monitor
  - apps/search-ai/src/routes/schemas.ts
    - POST /connectors/:connectorId/discover
    - GET /connectors/:connectorId
    - GET /connectors/:connectorId/versions
    - GET /connectors/:connectorId/changes
    - GET /:knowledgeBaseId
    - PATCH /:knowledgeBaseId
  - apps/search-ai/src/routes/search.ts
    - POST /search
    - POST /search/hybrid
    - GET /search/debug
  - apps/search-ai/src/routes/sources.ts
    - GET /:indexId/sources
    - POST /:indexId/sources
    - DELETE /:indexId/sources/:sourceId
    - GET /:indexId/sources/:sourceId/status
  - ... +3 additional route modules with methods

## 4. Level 4: Implementation Detail (Code Artifacts)

### 4.1 Module Inventory

| Implementation Slice           | Count | Representative Artifacts                                                                                                                                                                                                |
| ------------------------------ | ----: | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| UI Components                  |    32 | apps/studio/src/components/search-ai/ConnectorDetailPanel.tsx<br/>apps/studio/src/components/search-ai/ConnectorsTab.tsx<br/>apps/studio/src/components/search-ai/CrawlJobForm.tsx                                      |
| Services                       |    92 | apps/multimodal-service/src/services/**tests**/attachment-search-producer.test.ts<br/>apps/multimodal-service/src/services/attachment-search-producer.ts<br/>apps/multimodal-service/src/services/multimodal-service.ts |
| Routes / Route Modules         |    92 | apps/multimodal-service/src/routes/admin.ts<br/>apps/multimodal-service/src/routes/attachments.ts<br/>apps/search-ai/src/**tests**/routes/connectors-auth.test.ts                                                       |
| Data Models                    |     9 | packages/database/src/models/document-page.model.ts<br/>packages/database/src/models/domain-vocabulary.model.ts<br/>packages/database/src/models/drive-delta-token.model.ts                                             |
| Workers / Executors / Pipeline |    51 | apps/search-ai/docs/chunking/14-worker-pipeline-detailed.md<br/>apps/search-ai/src/**tests**/pipeline-timing-integration.test.ts<br/>apps/search-ai/src/**tests**/search-ai-workers.test.ts                             |
| Tests                          |   130 | apps/multimodal-service/src/**tests**/attachment-rate-limit.test.ts<br/>apps/multimodal-service/src/**tests**/attachment-routes.test.ts<br/>apps/multimodal-service/src/**tests**/multimodal-service.test.ts            |

### 4.2 Detailed Implementation Paths

- apps/search-ai/src
- apps/studio/src
- apps/search-ai/docs
- apps/multimodal-service/src
- packages/search-ai-internal/src
- services/preprocessing-service/tests
- apps/multimodal-service/src/routes/admin.ts
- apps/multimodal-service/src/routes/attachments.ts
- apps/search-ai/src/**tests**/routes/connectors-auth.test.ts
- apps/search-ai/src/**tests**/routes/connectors-delta-sync.test.ts
- apps/search-ai/src/**tests**/routes/connectors-sync.test.ts
- apps/search-ai/src/**tests**/routes/crawl-batch.test.ts
- apps/multimodal-service/src/services/**tests**/attachment-search-producer.test.ts
- apps/multimodal-service/src/services/attachment-search-producer.ts
- apps/multimodal-service/src/services/multimodal-service.ts
- apps/multimodal-service/src/services/queues.ts
- apps/multimodal-service/src/services/tenant-config-service.ts
- apps/search-ai/src/services/**tests**/audit-logger.test.ts
- packages/database/src/models/document-page.model.ts
- packages/database/src/models/domain-vocabulary.model.ts
- packages/database/src/models/drive-delta-token.model.ts
- packages/database/src/models/fact.model.ts
- packages/database/src/models/field-mapping.model.ts
- packages/database/src/models/shared-index-tracker.model.ts

## 5. Level 5: Verification, Controls, and Acceptance Depth

### 5.1 Verification Assets

- Test artifacts in scope: 130
  - apps/multimodal-service/src/**tests**/attachment-rate-limit.test.ts
  - apps/multimodal-service/src/**tests**/attachment-routes.test.ts
  - apps/multimodal-service/src/**tests**/multimodal-service.test.ts
  - apps/multimodal-service/src/jobs/**tests**/cleanup-job.test.ts
  - apps/multimodal-service/src/jobs/**tests**/expiry-sweep-job.test.ts
  - apps/multimodal-service/src/jobs/**tests**/index-job.test.ts
  - apps/multimodal-service/src/jobs/**tests**/process-job.test.ts
  - apps/multimodal-service/src/jobs/**tests**/scan-job.test.ts
  - apps/multimodal-service/src/jobs/**tests**/validate-job.test.ts
  - apps/multimodal-service/src/processing/**tests**/document-parser-tika.test.ts
  - apps/multimodal-service/src/processing/**tests**/image-processor.test.ts
  - apps/multimodal-service/src/processing/**tests**/transcriber-whisper.test.ts
  - apps/multimodal-service/src/processing/**tests**/video-processor-ffmpeg.test.ts
  - apps/multimodal-service/src/security/**tests**/clamav-scanner.test.ts
  - apps/multimodal-service/src/security/**tests**/mime-validator.test.ts
  - apps/multimodal-service/src/security/**tests**/ssrf-validator.test.ts
  - apps/multimodal-service/src/security/**tests**/upload-rate-limiter.test.ts
  - apps/multimodal-service/src/services/**tests**/attachment-search-producer.test.ts
  - apps/multimodal-service/src/storage/**tests**/local-storage.test.ts
  - apps/multimodal-service/src/storage/**tests**/s3-storage.test.ts
  - apps/multimodal-service/src/storage/**tests**/storage-factory.test.ts
  - apps/search-ai/src/**tests**/connector-permission-crawl-worker.test.ts
  - apps/search-ai/src/**tests**/connector-sync-worker.test.ts
  - apps/search-ai/src/**tests**/document-permissions-api.test.ts
  - apps/search-ai/src/**tests**/e2e/connectors.e2e.test.ts
  - apps/search-ai/src/**tests**/fixtures/benchmark-org-profiles/README.md
  - apps/search-ai/src/**tests**/fixtures/benchmark-org-profiles/boeing.json
  - apps/search-ai/src/**tests**/fixtures/benchmark-org-profiles/caterpillar.json
  - apps/search-ai/src/**tests**/fixtures/benchmark-org-profiles/chevron.json
  - apps/search-ai/src/**tests**/fixtures/benchmark-org-profiles/exxonmobil.json
  - apps/search-ai/src/**tests**/fixtures/benchmark-org-profiles/fidelity.json
  - apps/search-ai/src/**tests**/fixtures/benchmark-org-profiles/kaiser-permanente.json
  - apps/search-ai/src/**tests**/fixtures/benchmark-org-profiles/mayo-clinic.json
  - apps/search-ai/src/**tests**/fixtures/benchmark-org-profiles/salesforce.json
  - apps/search-ai/src/**tests**/fixtures/benchmark-org-profiles/servicenow.json
  - apps/search-ai/src/**tests**/fixtures/benchmark-org-profiles/target.json
  - apps/search-ai/src/**tests**/fixtures/benchmark-org-profiles/validate-all.test.ts
  - apps/search-ai/src/**tests**/fixtures/benchmark-org-profiles/vanguard.json
  - apps/search-ai/src/**tests**/fixtures/benchmark-org-profiles/walmart.json
  - apps/search-ai/src/**tests**/helpers/setup-mongo.ts
  - ... +90 additional test files

### 5.2 5-Level Scenario Chains (Explicit)

#### Scenario 1: Source ingest to indexed document

- Level 1 (Outcome): Deliver Search AI Ingestion and KB Build business value.
- Level 2 (Domain): Execute within mapped subdomains (apps/search-ai, apps/studio, services/preprocessing-service).
- Level 3 (Flow): Realize workflow stage "Source ingest to indexed document" through route/service orchestration.
- Level 4 (Implementation): Use artifacts such as apps/search-ai/src, apps/studio/src, apps/search-ai/docs.
- Level 5 (Verification): Validate with tests and controls from apps/multimodal-service/src/**tests**/attachment-rate-limit.test.ts, apps/multimodal-service/src/**tests**/attachment-routes.test.ts, apps/multimodal-service/src/**tests**/multimodal-service.test.ts.

#### Scenario 2: Structured data ingest finalize

- Level 1 (Outcome): Deliver Search AI Ingestion and KB Build business value.
- Level 2 (Domain): Execute within mapped subdomains (apps/search-ai, apps/studio, services/preprocessing-service).
- Level 3 (Flow): Realize workflow stage "Structured data ingest finalize" through route/service orchestration.
- Level 4 (Implementation): Use artifacts such as apps/search-ai/docs, apps/multimodal-service/src, packages/search-ai-internal/src.
- Level 5 (Verification): Validate with tests and controls from apps/multimodal-service/src/**tests**/multimodal-service.test.ts, apps/multimodal-service/src/jobs/**tests**/cleanup-job.test.ts, apps/multimodal-service/src/jobs/**tests**/expiry-sweep-job.test.ts.

#### Scenario 3: Knowledge graph enrichment

- Level 1 (Outcome): Deliver Search AI Ingestion and KB Build business value.
- Level 2 (Domain): Execute within mapped subdomains (apps/search-ai, apps/studio, services/preprocessing-service).
- Level 3 (Flow): Realize workflow stage "Knowledge graph enrichment" through route/service orchestration.
- Level 4 (Implementation): Use artifacts such as packages/search-ai-internal/src, services/preprocessing-service/tests, apps/multimodal-service/src/routes/admin.ts.
- Level 5 (Verification): Validate with tests and controls from apps/multimodal-service/src/jobs/**tests**/expiry-sweep-job.test.ts, apps/multimodal-service/src/jobs/**tests**/index-job.test.ts, apps/multimodal-service/src/jobs/**tests**/process-job.test.ts.

### 5.3 Acceptance Criteria (Deep)

- AC-001: All mapped code paths for F007 are represented in this feature's decomposition.
- AC-002: Each primary flow has route/module/test traceability.
- AC-003: Security and boundary assumptions are explicit for this feature.
- AC-004: Adjacent-feature ownership boundaries are preserved by feature-map mapping rules.

## 6. Security, Compliance, and Risk Controls

- Identity and tenancy boundaries are enforced through mapped auth/middleware routes where present.
- Sensitive data handling is constrained to mapped secure services/models in this feature boundary.
- Operational risks are mitigated through mapped tests, validation scripts, and route error handling.

## 7. Traceability

- Feature map: `docs/specs/feature-map.json`
- Coverage summary: `docs/specs/CODE_COVERAGE_SUMMARY.md`
- File matrix: `docs/specs/CODE_COVERAGE_MATRIX.csv`

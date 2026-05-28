# RFC-008: Knowledgebase Invocation Runtime

- Status: Draft (5-level deep functional specification)
- Feature ID: F008
- Focus: Knowledgebase invocation and query-time retrieval runtime
- Covered files in feature map: 100
- Source mapping: `docs/specs/feature-map.json`

## 1. Level 1: Business Capability Definition

This feature delivers **Knowledgebase invocation and query-time retrieval runtime** as a first-class platform capability.

### 1.1 Capability Boundaries

- In-scope top-level domains:
  - apps (86 files)
  - packages (14 files)
- Out-of-scope: functionality owned by adjacent split features unless explicitly mapped in this feature.

## 2. Level 2: Domain and Subdomain Decomposition

| Domain (L2)            | File Count | Purpose                                                                 |
| ---------------------- | ---------: | ----------------------------------------------------------------------- |
| apps/search-ai-runtime |         75 | Operational subdomain contributing to Knowledgebase Invocation Runtime. |
| packages/search-ai-sdk |         13 | Operational subdomain contributing to Knowledgebase Invocation Runtime. |
| apps/studio            |          6 | Operational subdomain contributing to Knowledgebase Invocation Runtime. |
| apps/runtime           |          5 | Operational subdomain contributing to Knowledgebase Invocation Runtime. |
| packages/database      |          1 | Operational subdomain contributing to Knowledgebase Invocation Runtime. |

## 3. Level 3: Functional Flow Decomposition

### 3.1 Primary Flows

- Flow 1: Authenticated query invocation
- Flow 2: Permission-aware retrieval
- Flow 3: IDP sync and cache invalidation

### 3.2 API and Route Surface

- App-route endpoints discovered: 6
  - /api/search-ai-runtime/search/[indexId]/aggregate
  - /api/search-ai-runtime/search/[indexId]/query
  - /api/search-ai-runtime/search/[indexId]/resolve
  - /api/search-ai-runtime/search/[indexId]/similar
  - /api/search-ai-runtime/search/[indexId]/structured
  - /api/search-ai-runtime/search/[indexId]/suggest

- Router method inventory (module-level):
  - apps/search-ai-runtime/src/routes/aggregate.ts
    - POST /:indexId/aggregate
  - apps/search-ai-runtime/src/routes/health.ts
    - GET /
  - apps/search-ai-runtime/src/routes/idp-sync.ts
    - POST /trigger
    - GET /status
    - POST /invalidate-cache
  - apps/search-ai-runtime/src/routes/query.ts
    - POST /:indexId/query
  - apps/search-ai-runtime/src/routes/resolve.ts
    - POST /:indexId/resolve
  - apps/search-ai-runtime/src/routes/similar.ts
    - POST /:indexId/similar
  - apps/search-ai-runtime/src/routes/structured.ts
    - POST /:indexId/structured
  - apps/search-ai-runtime/src/routes/suggest.ts
    - POST /:indexId/suggest

## 4. Level 4: Implementation Detail (Code Artifacts)

### 4.1 Module Inventory

| Implementation Slice           | Count | Representative Artifacts                                                                                                                                                                                                   |
| ------------------------------ | ----: | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| UI Components                  |     0 | N/A                                                                                                                                                                                                                        |
| Services                       |    34 | apps/runtime/src/services/search-ai/**tests**/search-ai-tool-executor.test.ts<br/>apps/runtime/src/services/search-ai/index.ts<br/>apps/runtime/src/services/search-ai/search-ai-circuit-breaker.ts                        |
| Routes / Route Modules         |    15 | apps/search-ai-runtime/src/routes/aggregate.ts<br/>apps/search-ai-runtime/src/routes/health.ts<br/>apps/search-ai-runtime/src/routes/idp-sync.ts                                                                           |
| Data Models                    |     1 | packages/database/src/models/knowledge-base.model.ts                                                                                                                                                                       |
| Workers / Executors / Pipeline |     3 | apps/search-ai-runtime/src/**tests**/helpers/test-indexing-pipeline.ts<br/>apps/search-ai-runtime/src/**tests**/query-pipeline.test.ts<br/>apps/search-ai-runtime/src/services/query/query-pipeline.ts                     |
| Tests                          |    20 | apps/runtime/src/services/search-ai/**tests**/search-ai-tool-executor.test.ts<br/>apps/search-ai-runtime/src/**tests**/cost-calculator.test.ts<br/>apps/search-ai-runtime/src/**tests**/helpers/deterministic-embedding.ts |

### 4.2 Detailed Implementation Paths

- apps/search-ai-runtime/src
- packages/search-ai-sdk/src
- apps/search-ai-runtime/docs
- apps/studio/src
- apps/runtime/src
- apps/search-ai-runtime/ARCHITECTURE_REVIEW.md
- apps/search-ai-runtime/src/routes/aggregate.ts
- apps/search-ai-runtime/src/routes/health.ts
- apps/search-ai-runtime/src/routes/idp-sync.ts
- apps/search-ai-runtime/src/routes/metrics.ts
- apps/search-ai-runtime/src/routes/query.ts
- apps/search-ai-runtime/src/routes/resolve.ts
- apps/runtime/src/services/search-ai/**tests**/search-ai-tool-executor.test.ts
- apps/runtime/src/services/search-ai/index.ts
- apps/runtime/src/services/search-ai/search-ai-circuit-breaker.ts
- apps/runtime/src/services/search-ai/search-ai-tool-executor.ts
- apps/runtime/src/services/search-ai/search-ai-tool-handler.ts
- apps/search-ai-runtime/src/services/cache/group-membership-cache.ts
- packages/database/src/models/knowledge-base.model.ts

## 5. Level 5: Verification, Controls, and Acceptance Depth

### 5.1 Verification Assets

- Test artifacts in scope: 20
  - apps/runtime/src/services/search-ai/**tests**/search-ai-tool-executor.test.ts
  - apps/search-ai-runtime/src/**tests**/cost-calculator.test.ts
  - apps/search-ai-runtime/src/**tests**/helpers/deterministic-embedding.ts
  - apps/search-ai-runtime/src/**tests**/helpers/in-memory-vector-store.ts
  - apps/search-ai-runtime/src/**tests**/helpers/setup-mongo.ts
  - apps/search-ai-runtime/src/**tests**/helpers/test-documents.ts
  - apps/search-ai-runtime/src/**tests**/helpers/test-indexing-pipeline.ts
  - apps/search-ai-runtime/src/**tests**/query-cache.test.ts
  - apps/search-ai-runtime/src/**tests**/query-metrics.test.ts
  - apps/search-ai-runtime/src/**tests**/query-pipeline.test.ts
  - apps/search-ai-runtime/src/**tests**/reranker-factory.test.ts
  - apps/search-ai-runtime/src/**tests**/search-ai-runtime-e2e.test.ts
  - apps/search-ai-runtime/src/**tests**/structured-logger.test.ts
  - apps/search-ai-runtime/src/**tests**/vocabulary-resolver.test.ts
  - apps/search-ai-runtime/src/services/preprocessing/**tests**/preprocessing-client.test.ts
  - apps/search-ai-runtime/src/services/rerank/**tests**/batch-processor.test.ts
  - apps/search-ai-runtime/src/services/rerank/**tests**/batch-queue.test.ts
  - apps/search-ai-runtime/src/services/rerank/**tests**/batch-tuner.test.ts
  - apps/search-ai-runtime/src/services/rerank/**tests**/batched-reranker-factory.test.ts
  - apps/search-ai-runtime/src/services/rerank/**tests**/request-cache.test.ts

### 5.2 5-Level Scenario Chains (Explicit)

#### Scenario 1: Authenticated query invocation

- Level 1 (Outcome): Deliver Knowledgebase Invocation Runtime business value.
- Level 2 (Domain): Execute within mapped subdomains (apps/search-ai-runtime, packages/search-ai-sdk, apps/studio).
- Level 3 (Flow): Realize workflow stage "Authenticated query invocation" through route/service orchestration.
- Level 4 (Implementation): Use artifacts such as apps/search-ai-runtime/src, packages/search-ai-sdk/src, apps/search-ai-runtime/docs.
- Level 5 (Verification): Validate with tests and controls from apps/runtime/src/services/search-ai/**tests**/search-ai-tool-executor.test.ts, apps/search-ai-runtime/src/**tests**/cost-calculator.test.ts, apps/search-ai-runtime/src/**tests**/helpers/deterministic-embedding.ts.

#### Scenario 2: Permission-aware retrieval

- Level 1 (Outcome): Deliver Knowledgebase Invocation Runtime business value.
- Level 2 (Domain): Execute within mapped subdomains (apps/search-ai-runtime, packages/search-ai-sdk, apps/studio).
- Level 3 (Flow): Realize workflow stage "Permission-aware retrieval" through route/service orchestration.
- Level 4 (Implementation): Use artifacts such as apps/search-ai-runtime/docs, apps/studio/src, apps/runtime/src.
- Level 5 (Verification): Validate with tests and controls from apps/search-ai-runtime/src/**tests**/helpers/deterministic-embedding.ts, apps/search-ai-runtime/src/**tests**/helpers/in-memory-vector-store.ts, apps/search-ai-runtime/src/**tests**/helpers/setup-mongo.ts.

#### Scenario 3: IDP sync and cache invalidation

- Level 1 (Outcome): Deliver Knowledgebase Invocation Runtime business value.
- Level 2 (Domain): Execute within mapped subdomains (apps/search-ai-runtime, packages/search-ai-sdk, apps/studio).
- Level 3 (Flow): Realize workflow stage "IDP sync and cache invalidation" through route/service orchestration.
- Level 4 (Implementation): Use artifacts such as apps/runtime/src, apps/search-ai-runtime/ARCHITECTURE_REVIEW.md, apps/search-ai-runtime/src/routes/aggregate.ts.
- Level 5 (Verification): Validate with tests and controls from apps/search-ai-runtime/src/**tests**/helpers/setup-mongo.ts, apps/search-ai-runtime/src/**tests**/helpers/test-documents.ts, apps/search-ai-runtime/src/**tests**/helpers/test-indexing-pipeline.ts.

### 5.3 Acceptance Criteria (Deep)

- AC-001: All mapped code paths for F008 are represented in this feature's decomposition.
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

# RFC-024: Crawler Intelligence and Browser Automation

- Status: Draft (5-level deep functional specification)
- Feature ID: F024
- Focus: Crawler intelligence and browser automation
- Covered files in feature map: 102
- Source mapping: `docs/specs/feature-map.json`

## 1. Level 1: Business Capability Definition

This feature delivers **Crawler intelligence and browser automation** as a first-class platform capability.

### 1.1 Capability Boundaries

- In-scope top-level domains:
  - apps (53 files)
  - packages (44 files)
  - test-browser-crawl-e2e.ts (1 files)
  - test-bulk-crawl-e2e.ts (1 files)
  - test-crawler-api.sh (1 files)
  - test-e2e-crawl.js (1 files)
  - test-mcp-crawler-integration.ts (1 files)
- Out-of-scope: functionality owned by adjacent split features unless explicitly mapped in this feature.

## 2. Level 2: Domain and Subdomain Decomposition

| Domain (L2)                     | File Count | Purpose                                                                            |
| ------------------------------- | ---------: | ---------------------------------------------------------------------------------- |
| packages/crawler                |         44 | Operational subdomain contributing to Crawler Intelligence and Browser Automation. |
| apps/crawler-go-worker          |         32 | Operational subdomain contributing to Crawler Intelligence and Browser Automation. |
| apps/crawler-mcp-server         |         21 | Operational subdomain contributing to Crawler Intelligence and Browser Automation. |
| test-browser-crawl-e2e.ts       |          1 | Operational subdomain contributing to Crawler Intelligence and Browser Automation. |
| test-bulk-crawl-e2e.ts          |          1 | Operational subdomain contributing to Crawler Intelligence and Browser Automation. |
| test-crawler-api.sh             |          1 | Operational subdomain contributing to Crawler Intelligence and Browser Automation. |
| test-e2e-crawl.js               |          1 | Operational subdomain contributing to Crawler Intelligence and Browser Automation. |
| test-mcp-crawler-integration.ts |          1 | Operational subdomain contributing to Crawler Intelligence and Browser Automation. |

## 3. Level 3: Functional Flow Decomposition

### 3.1 Primary Flows

- Flow 1: Crawl strategy decision flow
- Flow 2: Browser automation MCP execution
- Flow 3: Transparency event emission

### 3.2 API and Route Surface

- No app-route style endpoints directly matched in this feature scope.

## 4. Level 4: Implementation Detail (Code Artifacts)

### 4.1 Module Inventory

| Implementation Slice           | Count | Representative Artifacts                                                                                                                                                                               |
| ------------------------------ | ----: | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| UI Components                  |     0 | N/A                                                                                                                                                                                                    |
| Services                       |     0 | N/A                                                                                                                                                                                                    |
| Routes / Route Modules         |     0 | N/A                                                                                                                                                                                                    |
| Data Models                    |     0 | N/A                                                                                                                                                                                                    |
| Workers / Executors / Pipeline |     0 | N/A                                                                                                                                                                                                    |
| Tests                          |    17 | packages/crawler/src/**tests**/decision/decision-engine.test.ts<br/>packages/crawler/src/**tests**/decision/interfaces.test.ts<br/>packages/crawler/src/**tests**/decision/tenant-policy-store.test.ts |

### 4.2 Detailed Implementation Paths

- packages/crawler/src
- apps/crawler-mcp-server/src
- apps/crawler-go-worker/scripts
- apps/crawler-go-worker/internal
- apps/crawler-go-worker/.dockerignore
- apps/crawler-go-worker/.env.example

## 5. Level 5: Verification, Controls, and Acceptance Depth

### 5.1 Verification Assets

- Test artifacts in scope: 17
  - packages/crawler/src/**tests**/decision/decision-engine.test.ts
  - packages/crawler/src/**tests**/decision/interfaces.test.ts
  - packages/crawler/src/**tests**/decision/tenant-policy-store.test.ts
  - packages/crawler/src/**tests**/decision/user-preference-store.test.ts
  - packages/crawler/src/**tests**/disclosure/prompt-evaluator.test.ts
  - packages/crawler/src/**tests**/disclosure/question-generator.test.ts
  - packages/crawler/src/**tests**/disclosure/response-processor.test.ts
  - packages/crawler/src/**tests**/pattern-store/mongo-pattern-store.test.ts
  - packages/crawler/src/**tests**/profiler/cached-profiler.test.ts
  - packages/crawler/src/**tests**/profiler/fast-profiler.test.ts
  - packages/crawler/src/**tests**/profiler/interfaces.test.ts
  - packages/crawler/src/**tests**/profiler/profiler-factory.test.ts
  - packages/crawler/src/**tests**/transparency/event-model.test.ts
  - packages/crawler/src/**tests**/transparency/transparency-service.test.ts
  - packages/crawler/src/**tests**/transparency/websocket-feed.test.ts
  - packages/crawler/src/profiler/**tests**/sitemap-extraction.test.ts
  - packages/crawler/src/strategy/**tests**/resolver.test.ts

### 5.2 5-Level Scenario Chains (Explicit)

#### Scenario 1: Crawl strategy decision flow

- Level 1 (Outcome): Deliver Crawler Intelligence and Browser Automation business value.
- Level 2 (Domain): Execute within mapped subdomains (packages/crawler, apps/crawler-go-worker, apps/crawler-mcp-server).
- Level 3 (Flow): Realize workflow stage "Crawl strategy decision flow" through route/service orchestration.
- Level 4 (Implementation): Use artifacts such as packages/crawler/src, apps/crawler-mcp-server/src, apps/crawler-go-worker/scripts.
- Level 5 (Verification): Validate with tests and controls from packages/crawler/src/**tests**/decision/decision-engine.test.ts, packages/crawler/src/**tests**/decision/interfaces.test.ts, packages/crawler/src/**tests**/decision/tenant-policy-store.test.ts.

#### Scenario 2: Browser automation MCP execution

- Level 1 (Outcome): Deliver Crawler Intelligence and Browser Automation business value.
- Level 2 (Domain): Execute within mapped subdomains (packages/crawler, apps/crawler-go-worker, apps/crawler-mcp-server).
- Level 3 (Flow): Realize workflow stage "Browser automation MCP execution" through route/service orchestration.
- Level 4 (Implementation): Use artifacts such as apps/crawler-go-worker/scripts, apps/crawler-go-worker/internal, apps/crawler-go-worker/.dockerignore.
- Level 5 (Verification): Validate with tests and controls from packages/crawler/src/**tests**/decision/tenant-policy-store.test.ts, packages/crawler/src/**tests**/decision/user-preference-store.test.ts, packages/crawler/src/**tests**/disclosure/prompt-evaluator.test.ts.

#### Scenario 3: Transparency event emission

- Level 1 (Outcome): Deliver Crawler Intelligence and Browser Automation business value.
- Level 2 (Domain): Execute within mapped subdomains (packages/crawler, apps/crawler-go-worker, apps/crawler-mcp-server).
- Level 3 (Flow): Realize workflow stage "Transparency event emission" through route/service orchestration.
- Level 4 (Implementation): Use artifacts such as apps/crawler-go-worker/.dockerignore, apps/crawler-go-worker/.env.example.
- Level 5 (Verification): Validate with tests and controls from packages/crawler/src/**tests**/disclosure/prompt-evaluator.test.ts, packages/crawler/src/**tests**/disclosure/question-generator.test.ts, packages/crawler/src/**tests**/disclosure/response-processor.test.ts.

### 5.3 Acceptance Criteria (Deep)

- AC-001: All mapped code paths for F024 are represented in this feature's decomposition.
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

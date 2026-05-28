# RFC-020: Data Platform and Persistence

- Status: Draft (5-level deep functional specification)
- Feature ID: F020
- Focus: Shared persistence and data model backbone
- Covered files in feature map: 222
- Source mapping: `docs/specs/feature-map.json`

## 1. Level 1: Business Capability Definition

This feature delivers **Shared persistence and data model backbone** as a first-class platform capability.

### 1.1 Capability Boundaries

- In-scope top-level domains:
  - packages (222 files)
- Out-of-scope: functionality owned by adjacent split features unless explicitly mapped in this feature.

## 2. Level 2: Domain and Subdomain Decomposition

| Domain (L2)       | File Count | Purpose                                                              |
| ----------------- | ---------: | -------------------------------------------------------------------- |
| packages/database |        222 | Operational subdomain contributing to Data Platform and Persistence. |

## 3. Level 3: Functional Flow Decomposition

### 3.1 Primary Flows

- Flow 1: Model registration and access
- Flow 2: Cross-service schema consumption
- Flow 3: Migration/seed lifecycle

### 3.2 API and Route Surface

- No app-route style endpoints directly matched in this feature scope.

## 4. Level 4: Implementation Detail (Code Artifacts)

### 4.1 Module Inventory

| Implementation Slice           | Count | Representative Artifacts                                                                                                                                                                 |
| ------------------------------ | ----: | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| UI Components                  |     0 | N/A                                                                                                                                                                                      |
| Services                       |     0 | N/A                                                                                                                                                                                      |
| Routes / Route Modules         |     0 | N/A                                                                                                                                                                                      |
| Data Models                    |   126 | packages/database/src/models/agent-lock.model.ts<br/>packages/database/src/models/agent-model-config.model.ts<br/>packages/database/src/models/agent-ownership.model.ts                  |
| Workers / Executors / Pipeline |     0 | N/A                                                                                                                                                                                      |
| Tests                          |    30 | packages/database/src/**tests**/arch-workspace-config.test.ts<br/>packages/database/src/**tests**/attachment-model.test.ts<br/>packages/database/src/**tests**/clickhouse-writer.test.ts |

### 4.2 Detailed Implementation Paths

- packages/database/src
- packages/database/prisma
- packages/database/package.json
- packages/database/seed-mongo.ts
- packages/database/tsconfig.json
- packages/database/vitest.config.ts
- packages/database/src/models/agent-lock.model.ts
- packages/database/src/models/agent-model-config.model.ts
- packages/database/src/models/agent-ownership.model.ts
- packages/database/src/models/agent-version.model.ts
- packages/database/src/models/alert-config.model.ts
- packages/database/src/models/api-key.model.ts

## 5. Level 5: Verification, Controls, and Acceptance Depth

### 5.1 Verification Assets

- Test artifacts in scope: 30
  - packages/database/src/**tests**/arch-workspace-config.test.ts
  - packages/database/src/**tests**/attachment-model.test.ts
  - packages/database/src/**tests**/clickhouse-writer.test.ts
  - packages/database/src/**tests**/encryption-plugin-kms.test.ts
  - packages/database/src/**tests**/encryption-plugin-v3.test.ts
  - packages/database/src/**tests**/helpers/setup-mongo.ts
  - packages/database/src/**tests**/kms-providers.test.ts
  - packages/database/src/**tests**/local-kms-provider.test.ts
  - packages/database/src/**tests**/message-model-attachments.test.ts
  - packages/database/src/**tests**/model-auth.test.ts
  - packages/database/src/**tests**/model-billing.test.ts
  - packages/database/src/**tests**/model-collaboration.test.ts
  - packages/database/src/**tests**/model-connector-connection.test.ts
  - packages/database/src/**tests**/model-connector-kv-store.test.ts
  - packages/database/src/**tests**/model-misc.test.ts
  - packages/database/src/**tests**/model-project.test.ts
  - packages/database/src/**tests**/model-search.test.ts
  - packages/database/src/**tests**/model-security.test.ts
  - packages/database/src/**tests**/model-session.test.ts
  - packages/database/src/**tests**/model-trigger-registration.test.ts
  - packages/database/src/**tests**/model-workflow-execution.test.ts
  - packages/database/src/**tests**/model-workflow.test.ts
  - packages/database/src/**tests**/mongo-base.test.ts
  - packages/database/src/**tests**/mongo-cascade.test.ts
  - packages/database/src/**tests**/mongo-error-handler.test.ts
  - packages/database/src/**tests**/mongo-helpers.test.ts
  - packages/database/src/**tests**/mongo-plugins.test.ts
  - packages/database/src/**tests**/pii-audit-log.test.ts
  - packages/database/src/**tests**/pool-monitoring.test.ts
  - packages/database/src/**tests**/project-runtime-config-nlu-provider.test.ts

### 5.2 5-Level Scenario Chains (Explicit)

#### Scenario 1: Model registration and access

- Level 1 (Outcome): Deliver Data Platform and Persistence business value.
- Level 2 (Domain): Execute within mapped subdomains (packages/database).
- Level 3 (Flow): Realize workflow stage "Model registration and access" through route/service orchestration.
- Level 4 (Implementation): Use artifacts such as packages/database/src, packages/database/prisma, packages/database/package.json.
- Level 5 (Verification): Validate with tests and controls from packages/database/src/**tests**/arch-workspace-config.test.ts, packages/database/src/**tests**/attachment-model.test.ts, packages/database/src/**tests**/clickhouse-writer.test.ts.

#### Scenario 2: Cross-service schema consumption

- Level 1 (Outcome): Deliver Data Platform and Persistence business value.
- Level 2 (Domain): Execute within mapped subdomains (packages/database).
- Level 3 (Flow): Realize workflow stage "Cross-service schema consumption" through route/service orchestration.
- Level 4 (Implementation): Use artifacts such as packages/database/package.json, packages/database/seed-mongo.ts, packages/database/tsconfig.json.
- Level 5 (Verification): Validate with tests and controls from packages/database/src/**tests**/clickhouse-writer.test.ts, packages/database/src/**tests**/encryption-plugin-kms.test.ts, packages/database/src/**tests**/encryption-plugin-v3.test.ts.

#### Scenario 3: Migration/seed lifecycle

- Level 1 (Outcome): Deliver Data Platform and Persistence business value.
- Level 2 (Domain): Execute within mapped subdomains (packages/database).
- Level 3 (Flow): Realize workflow stage "Migration/seed lifecycle" through route/service orchestration.
- Level 4 (Implementation): Use artifacts such as packages/database/tsconfig.json, packages/database/vitest.config.ts, packages/database/src/models/agent-lock.model.ts.
- Level 5 (Verification): Validate with tests and controls from packages/database/src/**tests**/encryption-plugin-v3.test.ts, packages/database/src/**tests**/helpers/setup-mongo.ts, packages/database/src/**tests**/kms-providers.test.ts.

### 5.3 Acceptance Criteria (Deep)

- AC-001: All mapped code paths for F020 are represented in this feature's decomposition.
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

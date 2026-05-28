# RFC-014: Agent Transfer and A2A

- Status: Draft (5-level deep functional specification)
- Feature ID: F014
- Focus: Agent transfer and A2A execution patterns
- Covered files in feature map: 120
- Source mapping: `docs/specs/feature-map.json`

## 1. Level 1: Business Capability Definition

This feature delivers **Agent transfer and A2A execution patterns** as a first-class platform capability.

### 1.1 Capability Boundaries

- In-scope top-level domains:
  - packages (117 files)
  - apps (3 files)
- Out-of-scope: functionality owned by adjacent split features unless explicitly mapped in this feature.

## 2. Level 2: Domain and Subdomain Decomposition

| Domain (L2)             | File Count | Purpose                                                       |
| ----------------------- | ---------: | ------------------------------------------------------------- |
| packages/agent-transfer |         97 | Operational subdomain contributing to Agent Transfer and A2A. |
| packages/a2a            |         19 | Operational subdomain contributing to Agent Transfer and A2A. |
| apps/runtime            |          3 | Operational subdomain contributing to Agent Transfer and A2A. |
| packages/database       |          1 | Operational subdomain contributing to Agent Transfer and A2A. |

## 3. Level 3: Functional Flow Decomposition

### 3.1 Primary Flows

- Flow 1: Transfer webhook ingestion
- Flow 2: Agent handoff execution
- Flow 3: A2A context propagation

### 3.2 API and Route Surface

- No app-route style endpoints directly matched in this feature scope.

- Router method inventory (module-level):
  - apps/runtime/src/routes/agent-transfer-webhooks.ts
    - POST /:provider

## 4. Level 4: Implementation Detail (Code Artifacts)

### 4.1 Module Inventory

| Implementation Slice           | Count | Representative Artifacts                                                                                                                                                |
| ------------------------------ | ----: | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| UI Components                  |     0 | N/A                                                                                                                                                                     |
| Services                       |     2 | apps/runtime/src/services/agent-transfer/index.ts<br/>apps/runtime/src/services/agent-transfer/message-bridge.ts                                                        |
| Routes / Route Modules         |     1 | apps/runtime/src/routes/agent-transfer-webhooks.ts                                                                                                                      |
| Data Models                    |     1 | packages/database/src/models/tenant-transfer.model.ts                                                                                                                   |
| Workers / Executors / Pipeline |     2 | packages/a2a/src/**tests**/express-handlers.test.ts<br/>packages/a2a/src/infrastructure/express-handlers.ts                                                             |
| Tests                          |    41 | packages/a2a/src/**tests**/agent-executor-adapter.test.ts<br/>packages/a2a/src/**tests**/discover-agent.test.ts<br/>packages/a2a/src/**tests**/express-handlers.test.ts |

### 4.2 Detailed Implementation Paths

- packages/agent-transfer/src
- packages/a2a/src
- apps/runtime/src
- packages/a2a/package.json
- packages/a2a/tsconfig.json
- packages/a2a/vitest.config.ts
- apps/runtime/src/routes/agent-transfer-webhooks.ts
- apps/runtime/src/services/agent-transfer/index.ts
- apps/runtime/src/services/agent-transfer/message-bridge.ts
- packages/database/src/models/tenant-transfer.model.ts

## 5. Level 5: Verification, Controls, and Acceptance Depth

### 5.1 Verification Assets

- Test artifacts in scope: 41
  - packages/a2a/src/**tests**/agent-executor-adapter.test.ts
  - packages/a2a/src/**tests**/discover-agent.test.ts
  - packages/a2a/src/**tests**/express-handlers.test.ts
  - packages/a2a/src/**tests**/ports.test.ts
  - packages/a2a/src/**tests**/send-task.test.ts
  - packages/a2a/src/**tests**/ssrf-interceptor.test.ts
  - packages/a2a/src/**tests**/traced-client.test.ts
  - packages/agent-transfer/src/**tests**/health.test.ts
  - packages/agent-transfer/src/**tests**/helpers/fixtures.ts
  - packages/agent-transfer/src/**tests**/helpers/index.ts
  - packages/agent-transfer/src/**tests**/helpers/mock-adapter.ts
  - packages/agent-transfer/src/**tests**/helpers/mock-redis.ts
  - packages/agent-transfer/src/**tests**/helpers/mock-smartassist.ts
  - packages/agent-transfer/src/**tests**/integration/backward-compat.test.ts
  - packages/agent-transfer/src/**tests**/integration/kore-transfer-flow.test.ts
  - packages/agent-transfer/src/**tests**/integration/session-lifecycle.test.ts
  - packages/agent-transfer/src/**tests**/metrics.test.ts
  - packages/agent-transfer/src/**tests**/unit/concurrency.test.ts
  - packages/agent-transfer/src/**tests**/unit/config-reloader.test.ts
  - packages/agent-transfer/src/**tests**/unit/csat-handler.test.ts
  - packages/agent-transfer/src/**tests**/unit/dead-letter-store.test.ts
  - packages/agent-transfer/src/**tests**/unit/disposition-handler.test.ts
  - packages/agent-transfer/src/**tests**/unit/durable-events.test.ts
  - packages/agent-transfer/src/**tests**/unit/edge-cases.test.ts
  - packages/agent-transfer/src/**tests**/unit/error-resilience.test.ts
  - packages/agent-transfer/src/**tests**/unit/fallback-executor.test.ts
  - packages/agent-transfer/src/**tests**/unit/graceful-shutdown.test.ts
  - packages/agent-transfer/src/**tests**/unit/helpers.test.ts
  - packages/agent-transfer/src/**tests**/unit/history-formatter.test.ts
  - packages/agent-transfer/src/**tests**/unit/input-validation.test.ts
  - packages/agent-transfer/src/**tests**/unit/log-redactor.test.ts
  - packages/agent-transfer/src/**tests**/unit/parse-session-hash.test.ts
  - packages/agent-transfer/src/**tests**/unit/rate-limiter.test.ts
  - packages/agent-transfer/src/**tests**/unit/session-timeout-scheduler.test.ts
  - packages/agent-transfer/src/**tests**/unit/shutdown.test.ts
  - packages/agent-transfer/src/**tests**/unit/smartassist-update-transfer.test.ts
  - packages/agent-transfer/src/**tests**/unit/ssrf-guard.test.ts
  - packages/agent-transfer/src/**tests**/unit/tenant-isolation.test.ts
  - packages/agent-transfer/src/**tests**/unit/trace-events.test.ts
  - packages/agent-transfer/src/**tests**/unit/trace-store-adapter.test.ts
  - ... +1 additional test files

### 5.2 5-Level Scenario Chains (Explicit)

#### Scenario 1: Transfer webhook ingestion

- Level 1 (Outcome): Deliver Agent Transfer and A2A business value.
- Level 2 (Domain): Execute within mapped subdomains (packages/agent-transfer, packages/a2a, apps/runtime).
- Level 3 (Flow): Realize workflow stage "Transfer webhook ingestion" through route/service orchestration.
- Level 4 (Implementation): Use artifacts such as packages/agent-transfer/src, packages/a2a/src, apps/runtime/src.
- Level 5 (Verification): Validate with tests and controls from packages/a2a/src/**tests**/agent-executor-adapter.test.ts, packages/a2a/src/**tests**/discover-agent.test.ts, packages/a2a/src/**tests**/express-handlers.test.ts.

#### Scenario 2: Agent handoff execution

- Level 1 (Outcome): Deliver Agent Transfer and A2A business value.
- Level 2 (Domain): Execute within mapped subdomains (packages/agent-transfer, packages/a2a, apps/runtime).
- Level 3 (Flow): Realize workflow stage "Agent handoff execution" through route/service orchestration.
- Level 4 (Implementation): Use artifacts such as apps/runtime/src, packages/a2a/package.json, packages/a2a/tsconfig.json.
- Level 5 (Verification): Validate with tests and controls from packages/a2a/src/**tests**/express-handlers.test.ts, packages/a2a/src/**tests**/ports.test.ts, packages/a2a/src/**tests**/send-task.test.ts.

#### Scenario 3: A2A context propagation

- Level 1 (Outcome): Deliver Agent Transfer and A2A business value.
- Level 2 (Domain): Execute within mapped subdomains (packages/agent-transfer, packages/a2a, apps/runtime).
- Level 3 (Flow): Realize workflow stage "A2A context propagation" through route/service orchestration.
- Level 4 (Implementation): Use artifacts such as packages/a2a/tsconfig.json, packages/a2a/vitest.config.ts, apps/runtime/src/routes/agent-transfer-webhooks.ts.
- Level 5 (Verification): Validate with tests and controls from packages/a2a/src/**tests**/send-task.test.ts, packages/a2a/src/**tests**/ssrf-interceptor.test.ts, packages/a2a/src/**tests**/traced-client.test.ts.

### 5.3 Acceptance Criteria (Deep)

- AC-001: All mapped code paths for F014 are represented in this feature's decomposition.
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

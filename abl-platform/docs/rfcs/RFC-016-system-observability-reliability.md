# RFC-016: System Observability and Reliability

- Status: Draft (5-level deep functional specification)
- Feature ID: F016
- Focus: System observability, reliability, and analytics operations
- Covered files in feature map: 167
- Source mapping: `docs/specs/feature-map.json`

## 1. Level 1: Business Capability Definition

This feature delivers **System observability, reliability, and analytics operations** as a first-class platform capability.

### 1.1 Capability Boundaries

- In-scope top-level domains:
  - packages (114 files)
  - apps (53 files)
- Out-of-scope: functionality owned by adjacent split features unless explicitly mapped in this feature.

## 2. Level 2: Domain and Subdomain Decomposition

| Domain (L2)              | File Count | Purpose                                                                     |
| ------------------------ | ---------: | --------------------------------------------------------------------------- |
| packages/eventstore      |         95 | Operational subdomain contributing to System Observability and Reliability. |
| apps/runtime             |         31 | Operational subdomain contributing to System Observability and Reliability. |
| apps/studio              |         22 | Operational subdomain contributing to System Observability and Reliability. |
| packages/circuit-breaker |         14 | Operational subdomain contributing to System Observability and Reliability. |
| packages/database        |          5 | Operational subdomain contributing to System Observability and Reliability. |

## 3. Level 3: Functional Flow Decomposition

### 3.1 Primary Flows

- Flow 1: Analytics computation and query
- Flow 2: Alert rule evaluation
- Flow 3: Reliability incident recovery flow

### 3.2 API and Route Surface

- App-route endpoints discovered: 13
  - /api/admin/alerts/[id]
  - /api/admin/alerts
  - /api/audit
  - /api/pipelines/[pipelineId]/activate
  - /api/pipelines/[pipelineId]/clone
  - /api/pipelines/[pipelineId]/deactivate
  - /api/pipelines/[pipelineId]
  - /api/pipelines/[pipelineId]/runs
  - /api/pipelines/activities
  - /api/pipelines
  - /api/pipelines/runs/[runId]/cancel
  - /api/pipelines/runs/[runId]
  - /api/runtime/analytics

- Router method inventory (module-level):
  - apps/runtime/src/routes/alert-config.ts
    - GET /
    - POST /
    - PATCH /:id
    - DELETE /:id

## 4. Level 4: Implementation Detail (Code Artifacts)

### 4.1 Module Inventory

| Implementation Slice           | Count | Representative Artifacts                                                                                                                                                                          |
| ------------------------------ | ----: | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| UI Components                  |     9 | apps/studio/src/components/alerts/AlertsPage.tsx<br/>apps/studio/src/components/analytics/AnalyticsPage.tsx<br/>apps/studio/src/components/analytics/LLMPerformanceTab.tsx                        |
| Services                       |    20 | apps/runtime/src/services/diagnostics/diagnostic-patterns.ts<br/>apps/runtime/src/services/event-bus/dead-letter-writer.ts<br/>apps/runtime/src/services/event-bus/event-bus.ts                   |
| Routes / Route Modules         |    24 | apps/runtime/src/routes/alert-config.ts<br/>apps/runtime/src/routes/alerts.ts<br/>apps/runtime/src/routes/analytics.ts                                                                            |
| Data Models                    |     5 | packages/database/src/models/alert-config.model.ts<br/>packages/database/src/models/audit-log.model.ts<br/>packages/database/src/models/llm-usage-metric.model.ts                                 |
| Workers / Executors / Pipeline |    17 | apps/runtime/src/routes/pipeline-analytics.ts<br/>apps/runtime/src/routes/pipeline-config.ts<br/>apps/runtime/src/services/pipeline/circuit-breaker.ts                                            |
| Tests                          |    19 | packages/circuit-breaker/src/**tests**/helpers/mock-redis.ts<br/>packages/circuit-breaker/src/**tests**/redis-circuit-breaker.test.ts<br/>packages/circuit-breaker/src/**tests**/registry.test.ts |

### 4.2 Detailed Implementation Paths

- packages/eventstore/src
- apps/runtime/src
- apps/studio/src
- packages/circuit-breaker/src
- packages/database/src
- packages/circuit-breaker/package.json
- apps/runtime/src/routes/alert-config.ts
- apps/runtime/src/routes/alerts.ts
- apps/runtime/src/routes/analytics.ts
- apps/runtime/src/routes/custom-events.ts
- apps/runtime/src/routes/experiments.ts
- apps/runtime/src/routes/external-events.ts
- apps/runtime/src/services/diagnostics/diagnostic-patterns.ts
- apps/runtime/src/services/event-bus/dead-letter-writer.ts
- apps/runtime/src/services/event-bus/event-bus.ts
- apps/runtime/src/services/event-bus/index.ts
- apps/runtime/src/services/event-bus/kafka-subscriber.ts
- apps/runtime/src/services/event-bus/subscription-registry.ts
- packages/database/src/models/alert-config.model.ts
- packages/database/src/models/audit-log.model.ts
- packages/database/src/models/llm-usage-metric.model.ts
- packages/database/src/models/org-profile-metric.model.ts
- packages/database/src/models/usage-period.model.ts

## 5. Level 5: Verification, Controls, and Acceptance Depth

### 5.1 Verification Assets

- Test artifacts in scope: 19
  - packages/circuit-breaker/src/**tests**/helpers/mock-redis.ts
  - packages/circuit-breaker/src/**tests**/redis-circuit-breaker.test.ts
  - packages/circuit-breaker/src/**tests**/registry.test.ts
  - packages/eventstore/src/**tests**/alerting-scheduler.test.ts
  - packages/eventstore/src/**tests**/alerting-threshold.test.ts
  - packages/eventstore/src/**tests**/evaluation-code-scorer.test.ts
  - packages/eventstore/src/**tests**/evaluation-dispatcher.test.ts
  - packages/eventstore/src/**tests**/evaluation-llm-judge.test.ts
  - packages/eventstore/src/**tests**/event-categories.test.ts
  - packages/eventstore/src/**tests**/event-emitter.test.ts
  - packages/eventstore/src/**tests**/event-registry.test.ts
  - packages/eventstore/src/**tests**/factory.test.ts
  - packages/eventstore/src/**tests**/helpers.ts
  - packages/eventstore/src/**tests**/query-service.test.ts
  - packages/eventstore/src/**tests**/queue-contract.test.ts
  - packages/eventstore/src/**tests**/retention-gdpr.test.ts
  - packages/eventstore/src/**tests**/store-contract.test.ts
  - packages/eventstore/src/**tests**/trace-bridge.test.ts
  - packages/eventstore/src/**tests**/webhook-forwarder.test.ts

### 5.2 5-Level Scenario Chains (Explicit)

#### Scenario 1: Analytics computation and query

- Level 1 (Outcome): Deliver System Observability and Reliability business value.
- Level 2 (Domain): Execute within mapped subdomains (packages/eventstore, apps/runtime, apps/studio).
- Level 3 (Flow): Realize workflow stage "Analytics computation and query" through route/service orchestration.
- Level 4 (Implementation): Use artifacts such as packages/eventstore/src, apps/runtime/src, apps/studio/src.
- Level 5 (Verification): Validate with tests and controls from packages/circuit-breaker/src/**tests**/helpers/mock-redis.ts, packages/circuit-breaker/src/**tests**/redis-circuit-breaker.test.ts, packages/circuit-breaker/src/**tests**/registry.test.ts.

#### Scenario 2: Alert rule evaluation

- Level 1 (Outcome): Deliver System Observability and Reliability business value.
- Level 2 (Domain): Execute within mapped subdomains (packages/eventstore, apps/runtime, apps/studio).
- Level 3 (Flow): Realize workflow stage "Alert rule evaluation" through route/service orchestration.
- Level 4 (Implementation): Use artifacts such as apps/studio/src, packages/circuit-breaker/src, packages/database/src.
- Level 5 (Verification): Validate with tests and controls from packages/circuit-breaker/src/**tests**/registry.test.ts, packages/eventstore/src/**tests**/alerting-scheduler.test.ts, packages/eventstore/src/**tests**/alerting-threshold.test.ts.

#### Scenario 3: Reliability incident recovery flow

- Level 1 (Outcome): Deliver System Observability and Reliability business value.
- Level 2 (Domain): Execute within mapped subdomains (packages/eventstore, apps/runtime, apps/studio).
- Level 3 (Flow): Realize workflow stage "Reliability incident recovery flow" through route/service orchestration.
- Level 4 (Implementation): Use artifacts such as packages/database/src, packages/circuit-breaker/package.json, apps/runtime/src/routes/alert-config.ts.
- Level 5 (Verification): Validate with tests and controls from packages/eventstore/src/**tests**/alerting-threshold.test.ts, packages/eventstore/src/**tests**/evaluation-code-scorer.test.ts, packages/eventstore/src/**tests**/evaluation-dispatcher.test.ts.

### 5.3 Acceptance Criteria (Deep)

- AC-001: All mapped code paths for F016 are represented in this feature's decomposition.
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

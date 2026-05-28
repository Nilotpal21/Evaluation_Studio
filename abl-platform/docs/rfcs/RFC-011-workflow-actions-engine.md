# RFC-011: Workflow Actions Engine

- Status: Draft (5-level deep functional specification)
- Feature ID: F011
- Focus: Workflow action execution and orchestration engine
- Covered files in feature map: 245
- Source mapping: `docs/specs/feature-map.json`

## 1. Level 1: Business Capability Definition

This feature delivers **Workflow action execution and orchestration engine** as a first-class platform capability.

### 1.1 Capability Boundaries

- In-scope top-level domains:
  - packages (135 files)
  - apps (110 files)
- Out-of-scope: functionality owned by adjacent split features unless explicitly mapped in this feature.

## 2. Level 2: Domain and Subdomain Decomposition

| Domain (L2)              | File Count | Purpose                                                        |
| ------------------------ | ---------: | -------------------------------------------------------------- |
| packages/pipeline-engine |        134 | Operational subdomain contributing to Workflow Actions Engine. |
| apps/workflow-engine     |         82 | Operational subdomain contributing to Workflow Actions Engine. |
| apps/studio              |         28 | Operational subdomain contributing to Workflow Actions Engine. |
| packages/database        |          1 | Operational subdomain contributing to Workflow Actions Engine. |

## 3. Level 3: Functional Flow Decomposition

### 3.1 Primary Flows

- Flow 1: Workflow execute and step dispatch
- Flow 2: Async callback continuation
- Flow 3: Execution cancellation path

### 3.2 API and Route Surface

- App-route endpoints discovered: 12
  - /api/projects/[id]/workflows/[workflowId]/execute
  - /api/projects/[id]/workflows/[workflowId]/executions/[executionId]
  - /api/projects/[id]/workflows/[workflowId]/executions/[executionId]/steps/[stepId]/approve
  - /api/projects/[id]/workflows/[workflowId]/executions
  - /api/projects/[id]/workflows/[workflowId]/notifications/[ruleId]
  - /api/projects/[id]/workflows/[workflowId]/notifications
  - /api/projects/[id]/workflows/[workflowId]
  - /api/projects/[id]/workflows/connectors
  - /api/projects/[id]/workflows
  - /api/projects/[id]/workflows/triggers/[triggerId]/pause
  - /api/projects/[id]/workflows/triggers/[triggerId]/resume
  - /api/projects/[id]/workflows/triggers

- Router method inventory (module-level):
  - apps/workflow-engine/src/routes/connections.ts
    - GET /
    - POST /
    - GET /:connectionId
    - PUT /:connectionId
    - DELETE /:connectionId
    - POST /oauth/callback
    - POST /:connectionId/test
  - apps/workflow-engine/src/routes/connectors.ts
    - GET /
    - GET /:connectorName
  - apps/workflow-engine/src/routes/human-task-resolution.ts
    - POST /executions/:executionId/steps/:stepId/resolve
  - apps/workflow-engine/src/routes/notification-rules.ts
    - GET /
    - POST /
    - PUT /:ruleId
    - DELETE /:ruleId
    - POST /:ruleId/test
  - apps/workflow-engine/src/routes/triggers.ts
    - GET /
    - POST /
    - DELETE /:registrationId
    - POST /:registrationId/pause
    - POST /:registrationId/resume
    - POST /:registrationId/fire
  - apps/workflow-engine/src/routes/workflow-approvals.ts
    - GET /
    - POST /:workflowId/executions/:executionId/steps/:stepId/approve
  - apps/workflow-engine/src/routes/workflow-callbacks.ts
    - POST /:executionId/:stepId
  - apps/workflow-engine/src/routes/workflow-executions.ts
    - GET /
    - GET /:executionId
    - POST /execute
    - POST /:executionId/cancel

## 4. Level 4: Implementation Detail (Code Artifacts)

### 4.1 Module Inventory

| Implementation Slice           | Count | Representative Artifacts                                                                                                                                                                                                                                                                                   |
| ------------------------------ | ----: | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| UI Components                  |    16 | apps/studio/src/components/workflows/CreateWorkflowModal.tsx<br/>apps/studio/src/components/workflows/InboxPage.tsx<br/>apps/studio/src/components/workflows/WorkflowCard.tsx                                                                                                                              |
| Services                       |    55 | apps/workflow-engine/src/services/connection-tester.ts<br/>apps/workflow-engine/src/services/database.ts<br/>apps/workflow-engine/src/services/redis-kv-store.ts                                                                                                                                           |
| Routes / Route Modules         |    21 | apps/studio/src/app/api/projects/[id]/workflows/[workflowId]/execute/route.ts<br/>apps/studio/src/app/api/projects/[id]/workflows/[workflowId]/executions/[executionId]/route.ts<br/>apps/studio/src/app/api/projects/[id]/workflows/[workflowId]/executions/[executionId]/steps/[stepId]/approve/route.ts |
| Data Models                    |     1 | packages/database/src/models/workflow.model.ts                                                                                                                                                                                                                                                             |
| Workers / Executors / Pipeline |   148 | apps/workflow-engine/src/executors/agent-invocation-executor.ts<br/>apps/workflow-engine/src/executors/approval-executor.ts<br/>apps/workflow-engine/src/executors/async-webhook-executor.ts                                                                                                               |
| Tests                          |    70 | apps/workflow-engine/src/**tests**/agent-invocation-executor.test.ts<br/>apps/workflow-engine/src/**tests**/approval-executor.test.ts<br/>apps/workflow-engine/src/**tests**/async-webhook-executor.test.ts                                                                                                |

### 4.2 Detailed Implementation Paths

- packages/pipeline-engine/src
- apps/workflow-engine/src
- apps/studio/src
- packages/pipeline-engine/docker
- apps/workflow-engine/Dockerfile
- apps/workflow-engine/package.json
- apps/studio/src/app/api/projects/[id]/workflows/[workflowId]/execute/route.ts
- apps/studio/src/app/api/projects/[id]/workflows/[workflowId]/executions/[executionId]/route.ts
- apps/studio/src/app/api/projects/[id]/workflows/[workflowId]/executions/[executionId]/steps/[stepId]/approve/route.ts
- apps/studio/src/app/api/projects/[id]/workflows/[workflowId]/executions/route.ts
- apps/studio/src/app/api/projects/[id]/workflows/[workflowId]/notifications/[ruleId]/route.ts
- apps/studio/src/app/api/projects/[id]/workflows/[workflowId]/notifications/route.ts
- apps/workflow-engine/src/services/connection-tester.ts
- apps/workflow-engine/src/services/database.ts
- apps/workflow-engine/src/services/redis-kv-store.ts
- apps/workflow-engine/src/services/redis.ts
- apps/workflow-engine/src/services/restate-client.ts
- apps/workflow-engine/src/services/restate-endpoint.ts
- packages/database/src/models/workflow.model.ts

## 5. Level 5: Verification, Controls, and Acceptance Depth

### 5.1 Verification Assets

- Test artifacts in scope: 70
  - apps/workflow-engine/src/**tests**/agent-invocation-executor.test.ts
  - apps/workflow-engine/src/**tests**/approval-executor.test.ts
  - apps/workflow-engine/src/**tests**/async-webhook-executor.test.ts
  - apps/workflow-engine/src/**tests**/callback-url.test.ts
  - apps/workflow-engine/src/**tests**/condition-executor.test.ts
  - apps/workflow-engine/src/**tests**/connection-tester.test.ts
  - apps/workflow-engine/src/**tests**/connections-routes.test.ts
  - apps/workflow-engine/src/**tests**/connector-action-executor.test.ts
  - apps/workflow-engine/src/**tests**/connectors-routes.test.ts
  - apps/workflow-engine/src/**tests**/delay-executor.test.ts
  - apps/workflow-engine/src/**tests**/execution-store.test.ts
  - apps/workflow-engine/src/**tests**/expression-resolver.test.ts
  - apps/workflow-engine/src/**tests**/graceful-shutdown.test.ts
  - apps/workflow-engine/src/**tests**/helpers/setup-mongo.ts
  - apps/workflow-engine/src/**tests**/http-executor.test.ts
  - apps/workflow-engine/src/**tests**/index-wiring.test.ts
  - apps/workflow-engine/src/**tests**/loop-executor.test.ts
  - apps/workflow-engine/src/**tests**/notification-dispatcher.test.ts
  - apps/workflow-engine/src/**tests**/notification-rules.test.ts
  - apps/workflow-engine/src/**tests**/otel-trace-bridge.test.ts
  - apps/workflow-engine/src/**tests**/parallel-executor.test.ts
  - apps/workflow-engine/src/**tests**/redis-publisher.test.ts
  - apps/workflow-engine/src/**tests**/route-integration.test.ts
  - apps/workflow-engine/src/**tests**/step-dispatcher.test.ts
  - apps/workflow-engine/src/**tests**/system-handler.test.ts
  - apps/workflow-engine/src/**tests**/system-persistence.test.ts
  - apps/workflow-engine/src/**tests**/tool-call-executor.test.ts
  - apps/workflow-engine/src/**tests**/transform-executor.test.ts
  - apps/workflow-engine/src/**tests**/trigger-engine.test.ts
  - apps/workflow-engine/src/**tests**/workflow-approvals.test.ts
  - apps/workflow-engine/src/**tests**/workflow-callbacks.test.ts
  - apps/workflow-engine/src/**tests**/workflow-executions-routes.test.ts
  - apps/workflow-engine/src/**tests**/workflow-handler-suspension.test.ts
  - apps/workflow-engine/src/**tests**/workflow-handler.test.ts
  - apps/workflow-engine/src/**tests**/workflow-integration.test.ts
  - packages/pipeline-engine/src/**tests**/activity-router.test.ts
  - packages/pipeline-engine/src/**tests**/activity-services.test.ts
  - packages/pipeline-engine/src/**tests**/alert-evaluator.test.ts
  - packages/pipeline-engine/src/**tests**/analytics-cache.test.ts
  - packages/pipeline-engine/src/**tests**/backfill.test.ts
  - ... +30 additional test files

### 5.2 5-Level Scenario Chains (Explicit)

#### Scenario 1: Workflow execute and step dispatch

- Level 1 (Outcome): Deliver Workflow Actions Engine business value.
- Level 2 (Domain): Execute within mapped subdomains (packages/pipeline-engine, apps/workflow-engine, apps/studio).
- Level 3 (Flow): Realize workflow stage "Workflow execute and step dispatch" through route/service orchestration.
- Level 4 (Implementation): Use artifacts such as packages/pipeline-engine/src, apps/workflow-engine/src, apps/studio/src.
- Level 5 (Verification): Validate with tests and controls from apps/workflow-engine/src/**tests**/agent-invocation-executor.test.ts, apps/workflow-engine/src/**tests**/approval-executor.test.ts, apps/workflow-engine/src/**tests**/async-webhook-executor.test.ts.

#### Scenario 2: Async callback continuation

- Level 1 (Outcome): Deliver Workflow Actions Engine business value.
- Level 2 (Domain): Execute within mapped subdomains (packages/pipeline-engine, apps/workflow-engine, apps/studio).
- Level 3 (Flow): Realize workflow stage "Async callback continuation" through route/service orchestration.
- Level 4 (Implementation): Use artifacts such as apps/studio/src, packages/pipeline-engine/docker, apps/workflow-engine/Dockerfile.
- Level 5 (Verification): Validate with tests and controls from apps/workflow-engine/src/**tests**/async-webhook-executor.test.ts, apps/workflow-engine/src/**tests**/callback-url.test.ts, apps/workflow-engine/src/**tests**/condition-executor.test.ts.

#### Scenario 3: Execution cancellation path

- Level 1 (Outcome): Deliver Workflow Actions Engine business value.
- Level 2 (Domain): Execute within mapped subdomains (packages/pipeline-engine, apps/workflow-engine, apps/studio).
- Level 3 (Flow): Realize workflow stage "Execution cancellation path" through route/service orchestration.
- Level 4 (Implementation): Use artifacts such as apps/workflow-engine/Dockerfile, apps/workflow-engine/package.json, apps/studio/src/app/api/projects/[id]/workflows/[workflowId]/execute/route.ts.
- Level 5 (Verification): Validate with tests and controls from apps/workflow-engine/src/**tests**/condition-executor.test.ts, apps/workflow-engine/src/**tests**/connection-tester.test.ts, apps/workflow-engine/src/**tests**/connections-routes.test.ts.

### 5.3 Acceptance Criteria (Deep)

- AC-001: All mapped code paths for F011 are represented in this feature's decomposition.
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

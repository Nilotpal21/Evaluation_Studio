# RFC-012: Workflow HITL Triggers and Approvals

- Status: Draft (5-level deep functional specification)
- Feature ID: F012
- Focus: Human-in-the-loop workflows, approvals, triggers, and notifications
- Covered files in feature map: 19
- Source mapping: `docs/specs/feature-map.json`

## 1. Level 1: Business Capability Definition

This feature delivers **Human-in-the-loop workflows, approvals, triggers, and notifications** as a first-class platform capability.

### 1.1 Capability Boundaries

- In-scope top-level domains:
  - apps (17 files)
  - packages (2 files)
- Out-of-scope: functionality owned by adjacent split features unless explicitly mapped in this feature.

## 2. Level 2: Domain and Subdomain Decomposition

| Domain (L2)          | File Count | Purpose                                                                     |
| -------------------- | ---------: | --------------------------------------------------------------------------- |
| apps/studio          |         10 | Operational subdomain contributing to Workflow HITL Triggers and Approvals. |
| apps/workflow-engine |          7 | Operational subdomain contributing to Workflow HITL Triggers and Approvals. |
| packages/database    |          2 | Operational subdomain contributing to Workflow HITL Triggers and Approvals. |

## 3. Level 3: Functional Flow Decomposition

### 3.1 Primary Flows

- Flow 1: Trigger fire to human approval
- Flow 2: Human task assignment and resolve
- Flow 3: Notification-driven intervention

### 3.2 API and Route Surface

- App-route endpoints discovered: 10
  - /api/projects/[id]/approvals
  - /api/projects/[id]/human-tasks/[taskId]/assign
  - /api/projects/[id]/human-tasks/[taskId]/claim
  - /api/projects/[id]/human-tasks/[taskId]/resolve
  - /api/projects/[id]/human-tasks/[taskId]
  - /api/projects/[id]/human-tasks
  - /api/projects/[id]/workflows/[workflowId]/executions/[executionId]/steps/[stepId]/approve
  - /api/projects/[id]/workflows/triggers/[triggerId]/pause
  - /api/projects/[id]/workflows/triggers/[triggerId]/resume
  - /api/projects/[id]/workflows/triggers

- Router method inventory (module-level):
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

## 4. Level 4: Implementation Detail (Code Artifacts)

### 4.1 Module Inventory

| Implementation Slice           | Count | Representative Artifacts                                                                                                                                                                                              |
| ------------------------------ | ----: | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| UI Components                  |     0 | N/A                                                                                                                                                                                                                   |
| Services                       |     2 | apps/workflow-engine/src/services/trigger-engine.ts<br/>apps/workflow-engine/src/services/trigger-scheduler.ts                                                                                                        |
| Routes / Route Modules         |    14 | apps/studio/src/app/api/projects/[id]/approvals/route.ts<br/>apps/studio/src/app/api/projects/[id]/human-tasks/[taskId]/assign/route.ts<br/>apps/studio/src/app/api/projects/[id]/human-tasks/[taskId]/claim/route.ts |
| Data Models                    |     2 | packages/database/src/models/human-task.model.ts<br/>packages/database/src/models/trigger-registration.model.ts                                                                                                       |
| Workers / Executors / Pipeline |     0 | N/A                                                                                                                                                                                                                   |
| Tests                          |     0 | N/A                                                                                                                                                                                                                   |

### 4.2 Detailed Implementation Paths

- apps/studio/src
- apps/workflow-engine/src
- packages/database/src
- apps/studio/src/app/api/projects/[id]/approvals/route.ts
- apps/studio/src/app/api/projects/[id]/human-tasks/[taskId]/assign/route.ts
- apps/studio/src/app/api/projects/[id]/human-tasks/[taskId]/claim/route.ts
- apps/studio/src/app/api/projects/[id]/human-tasks/[taskId]/resolve/route.ts
- apps/studio/src/app/api/projects/[id]/human-tasks/[taskId]/route.ts
- apps/studio/src/app/api/projects/[id]/human-tasks/route.ts
- apps/workflow-engine/src/services/trigger-engine.ts
- apps/workflow-engine/src/services/trigger-scheduler.ts
- packages/database/src/models/human-task.model.ts
- packages/database/src/models/trigger-registration.model.ts

## 5. Level 5: Verification, Controls, and Acceptance Depth

### 5.1 Verification Assets

- No direct test files mapped in this feature scope; rely on integration/adjacent suite validation.

### 5.2 5-Level Scenario Chains (Explicit)

#### Scenario 1: Trigger fire to human approval

- Level 1 (Outcome): Deliver Workflow HITL Triggers and Approvals business value.
- Level 2 (Domain): Execute within mapped subdomains (apps/studio, apps/workflow-engine, packages/database).
- Level 3 (Flow): Realize workflow stage "Trigger fire to human approval" through route/service orchestration.
- Level 4 (Implementation): Use artifacts such as apps/studio/src, apps/workflow-engine/src, packages/database/src.
- Level 5 (Verification): Validate with tests and controls from feature test suites and acceptance checks.

#### Scenario 2: Human task assignment and resolve

- Level 1 (Outcome): Deliver Workflow HITL Triggers and Approvals business value.
- Level 2 (Domain): Execute within mapped subdomains (apps/studio, apps/workflow-engine, packages/database).
- Level 3 (Flow): Realize workflow stage "Human task assignment and resolve" through route/service orchestration.
- Level 4 (Implementation): Use artifacts such as packages/database/src, apps/studio/src/app/api/projects/[id]/approvals/route.ts, apps/studio/src/app/api/projects/[id]/human-tasks/[taskId]/assign/route.ts.
- Level 5 (Verification): Validate with tests and controls from feature test suites and acceptance checks.

#### Scenario 3: Notification-driven intervention

- Level 1 (Outcome): Deliver Workflow HITL Triggers and Approvals business value.
- Level 2 (Domain): Execute within mapped subdomains (apps/studio, apps/workflow-engine, packages/database).
- Level 3 (Flow): Realize workflow stage "Notification-driven intervention" through route/service orchestration.
- Level 4 (Implementation): Use artifacts such as apps/studio/src/app/api/projects/[id]/human-tasks/[taskId]/assign/route.ts, apps/studio/src/app/api/projects/[id]/human-tasks/[taskId]/claim/route.ts, apps/studio/src/app/api/projects/[id]/human-tasks/[taskId]/resolve/route.ts.
- Level 5 (Verification): Validate with tests and controls from feature test suites and acceptance checks.

### 5.3 Acceptance Criteria (Deep)

- AC-001: All mapped code paths for F012 are represented in this feature's decomposition.
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

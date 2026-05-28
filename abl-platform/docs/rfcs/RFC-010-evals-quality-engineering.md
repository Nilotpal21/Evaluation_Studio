# RFC-010: Evals and Quality Engineering

- Status: Draft (5-level deep functional specification)
- Feature ID: F010
- Focus: Evals, quality scoring, and scenario/persona testing
- Covered files in feature map: 67
- Source mapping: `docs/specs/feature-map.json`

## 1. Level 1: Business Capability Definition

This feature delivers **Evals, quality scoring, and scenario/persona testing** as a first-class platform capability.

### 1.1 Capability Boundaries

- In-scope top-level domains:
  - apps (46 files)
  - packages (21 files)
- Out-of-scope: functionality owned by adjacent split features unless explicitly mapped in this feature.

## 2. Level 2: Domain and Subdomain Decomposition

| Domain (L2)              | File Count | Purpose                                                              |
| ------------------------ | ---------: | -------------------------------------------------------------------- |
| apps/studio              |         46 | Operational subdomain contributing to Evals and Quality Engineering. |
| packages/pipeline-engine |         21 | Operational subdomain contributing to Evals and Quality Engineering. |

## 3. Level 3: Functional Flow Decomposition

### 3.1 Primary Flows

- Flow 1: Eval preflight to run start
- Flow 2: Scenario/persona simulation
- Flow 3: Result compare and heatmap review

### 3.2 API and Route Surface

- App-route endpoints discovered: 21
  - /api/projects/[id]/evals/evaluators/[evaluatorId]
  - /api/projects/[id]/evals/evaluators
  - /api/projects/[id]/evals/evaluators/templates
  - /api/projects/[id]/evals/generate/personas
  - /api/projects/[id]/evals/generate/scenarios
  - /api/projects/[id]/evals/personas/[personaId]
  - /api/projects/[id]/evals/personas
  - /api/projects/[id]/evals/personas/templates
  - /api/projects/[id]/evals/preflight
  - /api/projects/[id]/evals/quick
  - /api/projects/[id]/evals/runs/[runId]/cancel
  - /api/projects/[id]/evals/runs/[runId]/heatmap
  - /api/projects/[id]/evals/runs/[runId]
  - /api/projects/[id]/evals/runs/[runId]/start
  - /api/projects/[id]/evals/runs/[runId]/status
  - /api/projects/[id]/evals/runs/compare
  - /api/projects/[id]/evals/runs
  - /api/projects/[id]/evals/scenarios/[scenarioId]
  - /api/projects/[id]/evals/scenarios
  - /api/projects/[id]/evals/sets/[setId]
  - /api/projects/[id]/evals/sets

## 4. Level 4: Implementation Detail (Code Artifacts)

### 4.1 Module Inventory

| Implementation Slice           | Count | Representative Artifacts                                                                                                                                                                                                        |
| ------------------------------ | ----: | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| UI Components                  |    25 | apps/studio/src/components/evals/EvalPreflightPanel.tsx<br/>apps/studio/src/components/evals/EvalsPage.tsx<br/>apps/studio/src/components/evals/comparison/RunComparison.tsx                                                    |
| Services                       |    17 | packages/pipeline-engine/src/pipeline/services/eval/aggregate-eval-run.service.ts<br/>packages/pipeline-engine/src/pipeline/services/eval/eval-alerts.ts<br/>packages/pipeline-engine/src/pipeline/services/eval/eval-auth.ts   |
| Routes / Route Modules         |    21 | apps/studio/src/app/api/projects/[id]/evals/evaluators/[evaluatorId]/route.ts<br/>apps/studio/src/app/api/projects/[id]/evals/evaluators/route.ts<br/>apps/studio/src/app/api/projects/[id]/evals/evaluators/templates/route.ts |
| Data Models                    |     0 | N/A                                                                                                                                                                                                                             |
| Workers / Executors / Pipeline |    21 | packages/pipeline-engine/src/pipeline/definitions/eval-pipeline.ts<br/>packages/pipeline-engine/src/pipeline/handlers/eval-run.workflow.ts<br/>packages/pipeline-engine/src/pipeline/prompts/evaluation.prompts.ts              |
| Tests                          |     0 | N/A                                                                                                                                                                                                                             |

### 4.2 Detailed Implementation Paths

- apps/studio/src
- packages/pipeline-engine/src
- apps/studio/src/app/api/projects/[id]/evals/evaluators/[evaluatorId]/route.ts
- apps/studio/src/app/api/projects/[id]/evals/evaluators/route.ts
- apps/studio/src/app/api/projects/[id]/evals/evaluators/templates/route.ts
- apps/studio/src/app/api/projects/[id]/evals/generate/personas/route.ts
- apps/studio/src/app/api/projects/[id]/evals/generate/scenarios/route.ts
- apps/studio/src/app/api/projects/[id]/evals/personas/[personaId]/route.ts
- packages/pipeline-engine/src/pipeline/services/eval/aggregate-eval-run.service.ts
- packages/pipeline-engine/src/pipeline/services/eval/eval-alerts.ts
- packages/pipeline-engine/src/pipeline/services/eval/eval-auth.ts
- packages/pipeline-engine/src/pipeline/services/eval/eval-circuit-breakers.ts
- packages/pipeline-engine/src/pipeline/services/eval/eval-clickhouse-writers.ts
- packages/pipeline-engine/src/pipeline/services/eval/eval-compression.ts

## 5. Level 5: Verification, Controls, and Acceptance Depth

### 5.1 Verification Assets

- No direct test files mapped in this feature scope; rely on integration/adjacent suite validation.

### 5.2 5-Level Scenario Chains (Explicit)

#### Scenario 1: Eval preflight to run start

- Level 1 (Outcome): Deliver Evals and Quality Engineering business value.
- Level 2 (Domain): Execute within mapped subdomains (apps/studio, packages/pipeline-engine).
- Level 3 (Flow): Realize workflow stage "Eval preflight to run start" through route/service orchestration.
- Level 4 (Implementation): Use artifacts such as apps/studio/src, packages/pipeline-engine/src, apps/studio/src/app/api/projects/[id]/evals/evaluators/[evaluatorId]/route.ts.
- Level 5 (Verification): Validate with tests and controls from feature test suites and acceptance checks.

#### Scenario 2: Scenario/persona simulation

- Level 1 (Outcome): Deliver Evals and Quality Engineering business value.
- Level 2 (Domain): Execute within mapped subdomains (apps/studio, packages/pipeline-engine).
- Level 3 (Flow): Realize workflow stage "Scenario/persona simulation" through route/service orchestration.
- Level 4 (Implementation): Use artifacts such as apps/studio/src/app/api/projects/[id]/evals/evaluators/[evaluatorId]/route.ts, apps/studio/src/app/api/projects/[id]/evals/evaluators/route.ts, apps/studio/src/app/api/projects/[id]/evals/evaluators/templates/route.ts.
- Level 5 (Verification): Validate with tests and controls from feature test suites and acceptance checks.

#### Scenario 3: Result compare and heatmap review

- Level 1 (Outcome): Deliver Evals and Quality Engineering business value.
- Level 2 (Domain): Execute within mapped subdomains (apps/studio, packages/pipeline-engine).
- Level 3 (Flow): Realize workflow stage "Result compare and heatmap review" through route/service orchestration.
- Level 4 (Implementation): Use artifacts such as apps/studio/src/app/api/projects/[id]/evals/evaluators/templates/route.ts, apps/studio/src/app/api/projects/[id]/evals/generate/personas/route.ts, apps/studio/src/app/api/projects/[id]/evals/generate/scenarios/route.ts.
- Level 5 (Verification): Validate with tests and controls from feature test suites and acceptance checks.

### 5.3 Acceptance Criteria (Deep)

- AC-001: All mapped code paths for F010 are represented in this feature's decomposition.
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

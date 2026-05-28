# RFC-015: Agent Observability

- Status: Draft (5-level deep functional specification)
- Feature ID: F015
- Focus: Agent-level observability, traces, and debugging
- Covered files in feature map: 48
- Source mapping: `docs/specs/feature-map.json`

## 1. Level 1: Business Capability Definition

This feature delivers **Agent-level observability, traces, and debugging** as a first-class platform capability.

### 1.1 Capability Boundaries

- In-scope top-level domains:
  - apps (34 files)
  - packages (14 files)
- Out-of-scope: functionality owned by adjacent split features unless explicitly mapped in this feature.

## 2. Level 2: Domain and Subdomain Decomposition

| Domain (L2)          | File Count | Purpose                                                    |
| -------------------- | ---------: | ---------------------------------------------------------- |
| apps/studio          |         23 | Operational subdomain contributing to Agent Observability. |
| packages/observatory |         13 | Operational subdomain contributing to Agent Observability. |
| apps/runtime         |          6 | Operational subdomain contributing to Agent Observability. |
| apps/observatory-cli |          5 | Operational subdomain contributing to Agent Observability. |
| packages/database    |          1 | Operational subdomain contributing to Agent Observability. |

## 3. Level 3: Functional Flow Decomposition

### 3.1 Primary Flows

- Flow 1: Trace capture and retrieval
- Flow 2: Agent debugging with spans
- Flow 3: Archive retrieval workflow

### 3.2 API and Route Surface

- App-route endpoints discovered: 6
  - /api/archives/[id]/download
  - /api/archives/[id]
  - /api/archives/audit-export
  - /api/archives
  - /api/archives/sessions
  - /api/archives/traces

## 4. Level 4: Implementation Detail (Code Artifacts)

### 4.1 Module Inventory

| Implementation Slice           | Count | Representative Artifacts                                                                                                                                                            |
| ------------------------------ | ----: | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| UI Components                  |    17 | apps/studio/src/components/observatory/AgentFlowGraph.tsx<br/>apps/studio/src/components/observatory/ConstraintMonitor.tsx<br/>apps/studio/src/components/observatory/DebugTabs.tsx |
| Services                       |     1 | apps/runtime/src/services/trace/redis-trace-store.ts                                                                                                                                |
| Routes / Route Modules         |     6 | apps/studio/src/app/api/archives/[id]/download/route.ts<br/>apps/studio/src/app/api/archives/[id]/route.ts<br/>apps/studio/src/app/api/archives/audit-export/route.ts               |
| Data Models                    |     1 | packages/database/src/models/debug-token.model.ts                                                                                                                                   |
| Workers / Executors / Pipeline |     0 | N/A                                                                                                                                                                                 |
| Tests                          |     1 | packages/observatory/src/**tests**/trace-events-attachments.test.ts                                                                                                                 |

### 4.2 Detailed Implementation Paths

- apps/studio/src
- packages/observatory/src
- apps/runtime/src
- apps/observatory-cli/src
- apps/observatory-cli/package.json
- apps/observatory-cli/tsconfig.json
- apps/studio/src/app/api/archives/[id]/download/route.ts
- apps/studio/src/app/api/archives/[id]/route.ts
- apps/studio/src/app/api/archives/audit-export/route.ts
- apps/studio/src/app/api/archives/route.ts
- apps/studio/src/app/api/archives/sessions/route.ts
- apps/studio/src/app/api/archives/traces/route.ts
- apps/runtime/src/services/trace/redis-trace-store.ts
- packages/database/src/models/debug-token.model.ts

## 5. Level 5: Verification, Controls, and Acceptance Depth

### 5.1 Verification Assets

- Test artifacts in scope: 1
  - packages/observatory/src/**tests**/trace-events-attachments.test.ts

### 5.2 5-Level Scenario Chains (Explicit)

#### Scenario 1: Trace capture and retrieval

- Level 1 (Outcome): Deliver Agent Observability business value.
- Level 2 (Domain): Execute within mapped subdomains (apps/studio, packages/observatory, apps/runtime).
- Level 3 (Flow): Realize workflow stage "Trace capture and retrieval" through route/service orchestration.
- Level 4 (Implementation): Use artifacts such as apps/studio/src, packages/observatory/src, apps/runtime/src.
- Level 5 (Verification): Validate with tests and controls from packages/observatory/src/**tests**/trace-events-attachments.test.ts.

#### Scenario 2: Agent debugging with spans

- Level 1 (Outcome): Deliver Agent Observability business value.
- Level 2 (Domain): Execute within mapped subdomains (apps/studio, packages/observatory, apps/runtime).
- Level 3 (Flow): Realize workflow stage "Agent debugging with spans" through route/service orchestration.
- Level 4 (Implementation): Use artifacts such as apps/runtime/src, apps/observatory-cli/src, apps/observatory-cli/package.json.
- Level 5 (Verification): Validate with tests and controls from feature test suites and acceptance checks.

#### Scenario 3: Archive retrieval workflow

- Level 1 (Outcome): Deliver Agent Observability business value.
- Level 2 (Domain): Execute within mapped subdomains (apps/studio, packages/observatory, apps/runtime).
- Level 3 (Flow): Realize workflow stage "Archive retrieval workflow" through route/service orchestration.
- Level 4 (Implementation): Use artifacts such as apps/observatory-cli/package.json, apps/observatory-cli/tsconfig.json, apps/studio/src/app/api/archives/[id]/download/route.ts.
- Level 5 (Verification): Validate with tests and controls from feature test suites and acceptance checks.

### 5.3 Acceptance Criteria (Deep)

- AC-001: All mapped code paths for F015 are represented in this feature's decomposition.
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

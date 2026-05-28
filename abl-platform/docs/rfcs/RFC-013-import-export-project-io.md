# RFC-013: Import Export and Project IO

- Status: Draft (5-level deep functional specification)
- Feature ID: F013
- Focus: Project import/export, packaging, and git synchronization
- Covered files in feature map: 126
- Source mapping: `docs/specs/feature-map.json`

## 1. Level 1: Business Capability Definition

This feature delivers **Project import/export, packaging, and git synchronization** as a first-class platform capability.

### 1.1 Capability Boundaries

- In-scope top-level domains:
  - packages (111 files)
  - apps (15 files)
- Out-of-scope: functionality owned by adjacent split features unless explicitly mapped in this feature.

## 2. Level 2: Domain and Subdomain Decomposition

| Domain (L2)                | File Count | Purpose                                                             |
| -------------------------- | ---------: | ------------------------------------------------------------------- |
| packages/project-io        |        107 | Operational subdomain contributing to Import Export and Project IO. |
| apps/studio                |         15 | Operational subdomain contributing to Import Export and Project IO. |
| packages/kore-platform-cli |          3 | Operational subdomain contributing to Import Export and Project IO. |
| packages/database          |          1 | Operational subdomain contributing to Import Export and Project IO. |

## 3. Level 3: Functional Flow Decomposition

### 3.1 Primary Flows

- Flow 1: Import preview to apply
- Flow 2: Export generation and async delivery
- Flow 3: Git promote/pull/push sequence

### 3.2 API and Route Surface

- App-route endpoints discovered: 15
  - /api/projects/[id]/bundle
  - /api/projects/[id]/dependencies
  - /api/projects/[id]/export/async
  - /api/projects/[id]/export/preview
  - /api/projects/[id]/export
  - /api/projects/[id]/git/history
  - /api/projects/[id]/git/promote
  - /api/projects/[id]/git/pull
  - /api/projects/[id]/git/push
  - /api/projects/[id]/git
  - /api/projects/[id]/git/status
  - /api/projects/[id]/import/apply
  - /api/projects/[id]/import/doctor
  - /api/projects/[id]/import/preview
  - /api/projects/[id]/import/status

## 4. Level 4: Implementation Detail (Code Artifacts)

### 4.1 Module Inventory

| Implementation Slice           | Count | Representative Artifacts                                                                                                                                                              |
| ------------------------------ | ----: | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| UI Components                  |     0 | N/A                                                                                                                                                                                   |
| Services                       |     0 | N/A                                                                                                                                                                                   |
| Routes / Route Modules         |    15 | apps/studio/src/app/api/projects/[id]/bundle/route.ts<br/>apps/studio/src/app/api/projects/[id]/dependencies/route.ts<br/>apps/studio/src/app/api/projects/[id]/export/async/route.ts |
| Data Models                    |     1 | packages/database/src/models/import-operation.model.ts                                                                                                                                |
| Workers / Executors / Pipeline |     0 | N/A                                                                                                                                                                                   |
| Tests                          |    50 | packages/project-io/src/**tests**/abl-differ.test.ts<br/>packages/project-io/src/**tests**/assembler-utils.test.ts<br/>packages/project-io/src/**tests**/audit-fixes.test.ts          |

### 4.2 Detailed Implementation Paths

- packages/project-io/src
- apps/studio/src
- packages/kore-platform-cli/src
- packages/database/src
- packages/project-io/package.json
- packages/project-io/tsconfig.json
- apps/studio/src/app/api/projects/[id]/bundle/route.ts
- apps/studio/src/app/api/projects/[id]/dependencies/route.ts
- apps/studio/src/app/api/projects/[id]/export/async/route.ts
- apps/studio/src/app/api/projects/[id]/export/preview/route.ts
- apps/studio/src/app/api/projects/[id]/export/route.ts
- apps/studio/src/app/api/projects/[id]/git/history/route.ts
- packages/database/src/models/import-operation.model.ts

## 5. Level 5: Verification, Controls, and Acceptance Depth

### 5.1 Verification Assets

- Test artifacts in scope: 50
  - packages/project-io/src/**tests**/abl-differ.test.ts
  - packages/project-io/src/**tests**/assembler-utils.test.ts
  - packages/project-io/src/**tests**/audit-fixes.test.ts
  - packages/project-io/src/**tests**/bitbucket-provider.test.ts
  - packages/project-io/src/**tests**/branch-manager.test.ts
  - packages/project-io/src/**tests**/channels-assembler.test.ts
  - packages/project-io/src/**tests**/circular-detector.test.ts
  - packages/project-io/src/**tests**/conflict-resolver.test.ts
  - packages/project-io/src/**tests**/connections-assembler.test.ts
  - packages/project-io/src/**tests**/core-assembler.test.ts
  - packages/project-io/src/**tests**/dependency-extractor.test.ts
  - packages/project-io/src/**tests**/dependency-graph.test.ts
  - packages/project-io/src/**tests**/env-var-scanner.test.ts
  - packages/project-io/src/**tests**/evals-assembler.test.ts
  - packages/project-io/src/**tests**/export-import-roundtrip.test.ts
  - packages/project-io/src/**tests**/export-orchestrator-v2.test.ts
  - packages/project-io/src/**tests**/export-performance.test.ts
  - packages/project-io/src/**tests**/export-profiles.test.ts
  - packages/project-io/src/**tests**/export-utils.test.ts
  - packages/project-io/src/**tests**/export-yaml.test.ts
  - packages/project-io/src/**tests**/folder-reader-v2.test.ts
  - packages/project-io/src/**tests**/git-circuit-breaker.test.ts
  - packages/project-io/src/**tests**/git-providers.test.ts
  - packages/project-io/src/**tests**/git-sync-service.test.ts
  - packages/project-io/src/**tests**/github-provider.test.ts
  - packages/project-io/src/**tests**/gitlab-provider.test.ts
  - packages/project-io/src/**tests**/guardrails-assembler.test.ts
  - packages/project-io/src/**tests**/import-crash-recovery.test.ts
  - packages/project-io/src/**tests**/import-profiles.test.ts
  - packages/project-io/src/**tests**/import-validator-v2.test.ts
  - packages/project-io/src/**tests**/import-validators.test.ts
  - packages/project-io/src/**tests**/integration/export-v2-integration.test.ts
  - packages/project-io/src/**tests**/lock-service.test.ts
  - packages/project-io/src/**tests**/lockfile-v2.test.ts
  - packages/project-io/src/**tests**/manifest-v2.test.ts
  - packages/project-io/src/**tests**/ownership-service.test.ts
  - packages/project-io/src/**tests**/permission-checker.test.ts
  - packages/project-io/src/**tests**/post-import-validator.test.ts
  - packages/project-io/src/**tests**/profile-roundtrip.test.ts
  - packages/project-io/src/**tests**/project-exporter.test.ts
  - ... +10 additional test files

### 5.2 5-Level Scenario Chains (Explicit)

#### Scenario 1: Import preview to apply

- Level 1 (Outcome): Deliver Import Export and Project IO business value.
- Level 2 (Domain): Execute within mapped subdomains (packages/project-io, apps/studio, packages/kore-platform-cli).
- Level 3 (Flow): Realize workflow stage "Import preview to apply" through route/service orchestration.
- Level 4 (Implementation): Use artifacts such as packages/project-io/src, apps/studio/src, packages/kore-platform-cli/src.
- Level 5 (Verification): Validate with tests and controls from packages/project-io/src/**tests**/abl-differ.test.ts, packages/project-io/src/**tests**/assembler-utils.test.ts, packages/project-io/src/**tests**/audit-fixes.test.ts.

#### Scenario 2: Export generation and async delivery

- Level 1 (Outcome): Deliver Import Export and Project IO business value.
- Level 2 (Domain): Execute within mapped subdomains (packages/project-io, apps/studio, packages/kore-platform-cli).
- Level 3 (Flow): Realize workflow stage "Export generation and async delivery" through route/service orchestration.
- Level 4 (Implementation): Use artifacts such as packages/kore-platform-cli/src, packages/database/src, packages/project-io/package.json.
- Level 5 (Verification): Validate with tests and controls from packages/project-io/src/**tests**/audit-fixes.test.ts, packages/project-io/src/**tests**/bitbucket-provider.test.ts, packages/project-io/src/**tests**/branch-manager.test.ts.

#### Scenario 3: Git promote/pull/push sequence

- Level 1 (Outcome): Deliver Import Export and Project IO business value.
- Level 2 (Domain): Execute within mapped subdomains (packages/project-io, apps/studio, packages/kore-platform-cli).
- Level 3 (Flow): Realize workflow stage "Git promote/pull/push sequence" through route/service orchestration.
- Level 4 (Implementation): Use artifacts such as packages/project-io/package.json, packages/project-io/tsconfig.json, apps/studio/src/app/api/projects/[id]/bundle/route.ts.
- Level 5 (Verification): Validate with tests and controls from packages/project-io/src/**tests**/branch-manager.test.ts, packages/project-io/src/**tests**/channels-assembler.test.ts, packages/project-io/src/**tests**/circular-detector.test.ts.

### 5.3 Acceptance Criteria (Deep)

- AC-001: All mapped code paths for F013 are represented in this feature's decomposition.
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

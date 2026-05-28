# RFC-004: ABL Language and Compiler

- Status: Draft (5-level deep functional specification)
- Feature ID: F004
- Focus: ABL language semantics, compiler pipeline, and diagnostics
- Covered files in feature map: 475
- Source mapping: `docs/specs/feature-map.json`

## 1. Level 1: Business Capability Definition

This feature delivers **ABL language semantics, compiler pipeline, and diagnostics** as a first-class platform capability.

### 1.1 Capability Boundaries

- In-scope top-level domains:
  - packages (462 files)
  - apps (13 files)
- Out-of-scope: functionality owned by adjacent split features unless explicitly mapped in this feature.

## 2. Level 2: Domain and Subdomain Decomposition

| Domain (L2)               | File Count | Purpose                                                          |
| ------------------------- | ---------: | ---------------------------------------------------------------- |
| packages/compiler         |        342 | Operational subdomain contributing to ABL Language and Compiler. |
| packages/core             |         47 | Operational subdomain contributing to ABL Language and Compiler. |
| packages/editor           |         29 | Operational subdomain contributing to ABL Language and Compiler. |
| packages/language-service |         20 | Operational subdomain contributing to ABL Language and Compiler. |
| apps/studio               |         13 | Operational subdomain contributing to ABL Language and Compiler. |
| packages/analyzer         |         13 | Operational subdomain contributing to ABL Language and Compiler. |
| packages/nl-parser        |         11 | Operational subdomain contributing to ABL Language and Compiler. |

## 3. Level 3: Functional Flow Decomposition

### 3.1 Primary Flows

- Flow 1: DSL parse/analyze/compile pipeline
- Flow 2: Compiler construct lowering
- Flow 3: IDE diagnostics feedback loop

### 3.2 API and Route Surface

- App-route endpoints discovered: 5
  - /api/abl/analysis
  - /api/abl/compile
  - /api/abl/diagnostics
  - /api/abl/docs
  - /api/abl/parse

## 4. Level 4: Implementation Detail (Code Artifacts)

### 4.1 Module Inventory

| Implementation Slice           | Count | Representative Artifacts                                                                                                                                                                                                    |
| ------------------------------ | ----: | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| UI Components                  |    12 | apps/studio/src/components/abl/ABLDiagnosticsPanel.tsx<br/>apps/studio/src/components/abl/ABLEditor.tsx<br/>apps/studio/src/components/abl/ABLSymbolTree.tsx                                                                |
| Services                       |     0 | N/A                                                                                                                                                                                                                         |
| Routes / Route Modules         |     5 | apps/studio/src/app/api/abl/analysis/route.ts<br/>apps/studio/src/app/api/abl/compile/route.ts<br/>apps/studio/src/app/api/abl/diagnostics/route.ts                                                                         |
| Data Models                    |     0 | N/A                                                                                                                                                                                                                         |
| Workers / Executors / Pipeline |    39 | packages/compiler/src/**tests**/guardrails/action-executors.test.ts<br/>packages/compiler/src/**tests**/guardrails/pipeline-policy-validation.test.ts<br/>packages/compiler/src/**tests**/guardrails/pipeline-types.test.ts |
| Tests                          |   195 | packages/analyzer/src/**tests**/analyzer.test.ts<br/>packages/compiler/src/**tests**/**snapshots**/codegen-unit.test.ts.snap<br/>packages/compiler/src/**tests**/**snapshots**/langgraph-generators.test.ts.snap            |

### 4.2 Detailed Implementation Paths

- packages/compiler/src
- packages/core/src
- packages/editor/src
- packages/language-service/src
- apps/studio/src
- packages/analyzer/src
- apps/studio/src/app/api/abl/analysis/route.ts
- apps/studio/src/app/api/abl/compile/route.ts
- apps/studio/src/app/api/abl/diagnostics/route.ts
- apps/studio/src/app/api/abl/docs/route.ts
- apps/studio/src/app/api/abl/parse/route.ts

## 5. Level 5: Verification, Controls, and Acceptance Depth

### 5.1 Verification Assets

- Test artifacts in scope: 195
  - packages/analyzer/src/**tests**/analyzer.test.ts
  - packages/compiler/src/**tests**/**snapshots**/codegen-unit.test.ts.snap
  - packages/compiler/src/**tests**/**snapshots**/langgraph-generators.test.ts.snap
  - packages/compiler/src/**tests**/attachments.test.ts
  - packages/compiler/src/**tests**/compiler-misc.test.ts
  - packages/compiler/src/**tests**/compiler-recall-validation.test.ts
  - packages/compiler/src/**tests**/compiler-stores-extended.test.ts
  - packages/compiler/src/**tests**/concurrency-ir.test.ts
  - packages/compiler/src/**tests**/constraint-control-flow.test.ts
  - packages/compiler/src/**tests**/constraint-validation.test.ts
  - packages/compiler/src/**tests**/constructs/audit-middleware.test.ts
  - packages/compiler/src/**tests**/constructs/builtin-functions-negative.test.ts
  - packages/compiler/src/**tests**/constructs/builtin-functions.test.ts
  - packages/compiler/src/**tests**/constructs/cel-evaluator.test.ts
  - packages/compiler/src/**tests**/constructs/cel-functions.test.ts
  - packages/compiler/src/**tests**/constructs/cel-parity.test.ts
  - packages/compiler/src/**tests**/constructs/cel-phase3-utils.test.ts
  - packages/compiler/src/**tests**/constructs/cel-phase4-detailed-dual.test.ts
  - packages/compiler/src/**tests**/constructs/constraint-dual-evaluator.test.ts
  - packages/compiler/src/**tests**/constructs/constraint-executor.test.ts
  - packages/compiler/src/**tests**/constructs/dual-evaluator-null-injection.test.ts
  - packages/compiler/src/**tests**/constructs/dual-evaluator.test.ts
  - packages/compiler/src/**tests**/constructs/evaluator.test.ts
  - packages/compiler/src/**tests**/constructs/expression-combinations.test.ts
  - packages/compiler/src/**tests**/constructs/expression-migrator.test.ts
  - packages/compiler/src/**tests**/constructs/fact-store.test.ts
  - packages/compiler/src/**tests**/constructs/grounding-validator.test.ts
  - packages/compiler/src/**tests**/constructs/gvisor-sandbox-runner.test.ts
  - packages/compiler/src/**tests**/constructs/http-tool-executor.test.ts
  - packages/compiler/src/**tests**/constructs/lambda-sandbox-runner.test.ts
  - packages/compiler/src/**tests**/constructs/mcp-tool-executor.test.ts
  - packages/compiler/src/**tests**/constructs/middleware-chain.test.ts
  - packages/compiler/src/**tests**/constructs/mock-responses.test.ts
  - packages/compiler/src/**tests**/constructs/mock-sandbox-runner.test.ts
  - packages/compiler/src/**tests**/constructs/proxy-resolver.test.ts
  - packages/compiler/src/**tests**/constructs/result-validation.test.ts
  - packages/compiler/src/**tests**/constructs/sandbox-runner-factory.test.ts
  - packages/compiler/src/**tests**/constructs/sandbox-tool-executor.test.ts
  - packages/compiler/src/**tests**/constructs/sanitizer-middleware.test.ts
  - packages/compiler/src/**tests**/constructs/semantic-hints.test.ts
  - ... +155 additional test files

### 5.2 5-Level Scenario Chains (Explicit)

#### Scenario 1: DSL parse/analyze/compile pipeline

- Level 1 (Outcome): Deliver ABL Language and Compiler business value.
- Level 2 (Domain): Execute within mapped subdomains (packages/compiler, packages/core, packages/editor).
- Level 3 (Flow): Realize workflow stage "DSL parse/analyze/compile pipeline" through route/service orchestration.
- Level 4 (Implementation): Use artifacts such as packages/compiler/src, packages/core/src, packages/editor/src.
- Level 5 (Verification): Validate with tests and controls from packages/analyzer/src/**tests**/analyzer.test.ts, packages/compiler/src/**tests**/**snapshots**/codegen-unit.test.ts.snap, packages/compiler/src/**tests**/**snapshots**/langgraph-generators.test.ts.snap.

#### Scenario 2: Compiler construct lowering

- Level 1 (Outcome): Deliver ABL Language and Compiler business value.
- Level 2 (Domain): Execute within mapped subdomains (packages/compiler, packages/core, packages/editor).
- Level 3 (Flow): Realize workflow stage "Compiler construct lowering" through route/service orchestration.
- Level 4 (Implementation): Use artifacts such as packages/editor/src, packages/language-service/src, apps/studio/src.
- Level 5 (Verification): Validate with tests and controls from packages/compiler/src/**tests**/**snapshots**/langgraph-generators.test.ts.snap, packages/compiler/src/**tests**/attachments.test.ts, packages/compiler/src/**tests**/compiler-misc.test.ts.

#### Scenario 3: IDE diagnostics feedback loop

- Level 1 (Outcome): Deliver ABL Language and Compiler business value.
- Level 2 (Domain): Execute within mapped subdomains (packages/compiler, packages/core, packages/editor).
- Level 3 (Flow): Realize workflow stage "IDE diagnostics feedback loop" through route/service orchestration.
- Level 4 (Implementation): Use artifacts such as apps/studio/src, packages/analyzer/src, apps/studio/src/app/api/abl/analysis/route.ts.
- Level 5 (Verification): Validate with tests and controls from packages/compiler/src/**tests**/compiler-misc.test.ts, packages/compiler/src/**tests**/compiler-recall-validation.test.ts, packages/compiler/src/**tests**/compiler-stores-extended.test.ts.

### 5.3 Acceptance Criteria (Deep)

- AC-001: All mapped code paths for F004 are represented in this feature's decomposition.
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

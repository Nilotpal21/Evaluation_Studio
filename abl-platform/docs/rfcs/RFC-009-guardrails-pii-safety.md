# RFC-009: Guardrails and PII Safety

- Status: Draft (5-level deep functional specification)
- Feature ID: F009
- Focus: Guardrails, PII controls, and policy enforcement
- Covered files in feature map: 65
- Source mapping: `docs/specs/feature-map.json`

## 1. Level 1: Business Capability Definition

This feature delivers **Guardrails, PII controls, and policy enforcement** as a first-class platform capability.

### 1.1 Capability Boundaries

- In-scope top-level domains:
  - packages (38 files)
  - apps (27 files)
- Out-of-scope: functionality owned by adjacent split features unless explicitly mapped in this feature.

## 2. Level 2: Domain and Subdomain Decomposition

| Domain (L2)              | File Count | Purpose                                                          |
| ------------------------ | ---------: | ---------------------------------------------------------------- |
| packages/compiler        |         23 | Operational subdomain contributing to Guardrails and PII Safety. |
| apps/runtime             |         13 | Operational subdomain contributing to Guardrails and PII Safety. |
| packages/shared          |         11 | Operational subdomain contributing to Guardrails and PII Safety. |
| apps/studio              |          9 | Operational subdomain contributing to Guardrails and PII Safety. |
| apps/search-ai           |          5 | Operational subdomain contributing to Guardrails and PII Safety. |
| packages/database        |          3 | Operational subdomain contributing to Guardrails and PII Safety. |
| packages/pipeline-engine |          1 | Operational subdomain contributing to Guardrails and PII Safety. |

## 3. Level 3: Functional Flow Decomposition

### 3.1 Primary Flows

- Flow 1: Policy update to runtime enforcement
- Flow 2: PII-sensitive content handling
- Flow 3: Safety telemetry and remediation

### 3.2 API and Route Surface

- App-route endpoints discovered: 3
  - /api/admin/guardrail-policies
  - /api/admin/guardrail-providers
  - /api/tenant-llm-policy

- Router method inventory (module-level):
  - apps/runtime/src/routes/guardrail-policies.ts
    - GET /
    - POST /
    - GET /:id
    - PUT /:id
    - POST /:id/activate
    - DELETE /:id
  - apps/runtime/src/routes/guardrail-providers.ts
    - GET /
    - POST /
    - GET /:id
    - PUT /:id
    - DELETE /:id
    - POST /:id/test

## 4. Level 4: Implementation Detail (Code Artifacts)

### 4.1 Module Inventory

| Implementation Slice           | Count | Representative Artifacts                                                                                                                                                                                                                     |
| ------------------------------ | ----: | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| UI Components                  |     6 | apps/studio/src/components/governance/GovernancePage.tsx<br/>apps/studio/src/components/guardrails/GuardrailPolicyForm.tsx<br/>apps/studio/src/components/guardrails/GuardrailYamlEditor.tsx                                                 |
| Services                       |    16 | apps/runtime/src/services/guardrails/**tests**/pipeline-factory-llmeval.test.ts<br/>apps/runtime/src/services/guardrails/cache.ts<br/>apps/runtime/src/services/guardrails/cost-tracker.ts                                                   |
| Routes / Route Modules         |     5 | apps/runtime/src/routes/guardrail-policies.ts<br/>apps/runtime/src/routes/guardrail-providers.ts<br/>apps/studio/src/app/api/admin/guardrail-policies/route.ts                                                                               |
| Data Models                    |     3 | packages/database/src/models/dek-registry.model.ts<br/>packages/database/src/models/key-version.model.ts<br/>packages/database/src/models/tenant-llm-policy.model.ts                                                                         |
| Workers / Executors / Pipeline |     5 | apps/runtime/src/services/guardrails/**tests**/pipeline-factory-llmeval.test.ts<br/>apps/runtime/src/services/guardrails/pipeline-factory.ts<br/>packages/compiler/src/platform/guardrails/action-executors.ts                               |
| Tests                          |     3 | apps/runtime/src/services/guardrails/**tests**/pipeline-factory-llmeval.test.ts<br/>packages/compiler/src/platform/guardrails/providers/**tests**/custom-http-ssrf.test.ts<br/>packages/shared/src/security/**tests**/ssrf-validator.test.ts |

### 4.2 Detailed Implementation Paths

- packages/compiler/src
- apps/runtime/src
- packages/shared/src
- apps/studio/src
- apps/search-ai/src
- packages/database/src
- apps/runtime/src/routes/guardrail-policies.ts
- apps/runtime/src/routes/guardrail-providers.ts
- apps/studio/src/app/api/admin/guardrail-policies/route.ts
- apps/studio/src/app/api/admin/guardrail-providers/route.ts
- apps/studio/src/app/api/tenant-llm-policy/route.ts
- apps/runtime/src/services/guardrails/**tests**/pipeline-factory-llmeval.test.ts
- apps/runtime/src/services/guardrails/cache.ts
- apps/runtime/src/services/guardrails/cost-tracker.ts
- apps/runtime/src/services/guardrails/pipeline-factory.ts
- apps/runtime/src/services/guardrails/policy-resolver.ts
- apps/runtime/src/services/guardrails/streaming-evaluator.ts
- packages/database/src/models/dek-registry.model.ts
- packages/database/src/models/key-version.model.ts
- packages/database/src/models/tenant-llm-policy.model.ts

## 5. Level 5: Verification, Controls, and Acceptance Depth

### 5.1 Verification Assets

- Test artifacts in scope: 3
  - apps/runtime/src/services/guardrails/**tests**/pipeline-factory-llmeval.test.ts
  - packages/compiler/src/platform/guardrails/providers/**tests**/custom-http-ssrf.test.ts
  - packages/shared/src/security/**tests**/ssrf-validator.test.ts

### 5.2 5-Level Scenario Chains (Explicit)

#### Scenario 1: Policy update to runtime enforcement

- Level 1 (Outcome): Deliver Guardrails and PII Safety business value.
- Level 2 (Domain): Execute within mapped subdomains (packages/compiler, apps/runtime, packages/shared).
- Level 3 (Flow): Realize workflow stage "Policy update to runtime enforcement" through route/service orchestration.
- Level 4 (Implementation): Use artifacts such as packages/compiler/src, apps/runtime/src, packages/shared/src.
- Level 5 (Verification): Validate with tests and controls from apps/runtime/src/services/guardrails/**tests**/pipeline-factory-llmeval.test.ts, packages/compiler/src/platform/guardrails/providers/**tests**/custom-http-ssrf.test.ts, packages/shared/src/security/**tests**/ssrf-validator.test.ts.

#### Scenario 2: PII-sensitive content handling

- Level 1 (Outcome): Deliver Guardrails and PII Safety business value.
- Level 2 (Domain): Execute within mapped subdomains (packages/compiler, apps/runtime, packages/shared).
- Level 3 (Flow): Realize workflow stage "PII-sensitive content handling" through route/service orchestration.
- Level 4 (Implementation): Use artifacts such as packages/shared/src, apps/studio/src, apps/search-ai/src.
- Level 5 (Verification): Validate with tests and controls from packages/shared/src/security/**tests**/ssrf-validator.test.ts.

#### Scenario 3: Safety telemetry and remediation

- Level 1 (Outcome): Deliver Guardrails and PII Safety business value.
- Level 2 (Domain): Execute within mapped subdomains (packages/compiler, apps/runtime, packages/shared).
- Level 3 (Flow): Realize workflow stage "Safety telemetry and remediation" through route/service orchestration.
- Level 4 (Implementation): Use artifacts such as apps/search-ai/src, packages/database/src, apps/runtime/src/routes/guardrail-policies.ts.
- Level 5 (Verification): Validate with tests and controls from feature test suites and acceptance checks.

### 5.3 Acceptance Criteria (Deep)

- AC-001: All mapped code paths for F009 are represented in this feature's decomposition.
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

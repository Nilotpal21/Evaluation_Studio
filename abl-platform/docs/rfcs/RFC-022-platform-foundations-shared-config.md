# RFC-022: Platform Foundations and Shared Config

- Status: Draft (5-level deep functional specification)
- Feature ID: F022
- Focus: Platform foundations: config, i18n, sizing, style baselines
- Covered files in feature map: 105
- Source mapping: `docs/specs/feature-map.json`

## 1. Level 1: Business Capability Definition

This feature delivers **Platform foundations: config, i18n, sizing, style baselines** as a first-class platform capability.

### 1.1 Capability Boundaries

- In-scope top-level domains:
  - packages (105 files)
- Out-of-scope: functionality owned by adjacent split features unless explicitly mapped in this feature.

## 2. Level 2: Domain and Subdomain Decomposition

| Domain (L2)                | File Count | Purpose                                                                       |
| -------------------------- | ---------: | ----------------------------------------------------------------------------- |
| packages/config            |         56 | Operational subdomain contributing to Platform Foundations and Shared Config. |
| packages/sizing-calculator |         28 | Operational subdomain contributing to Platform Foundations and Shared Config. |
| packages/i18n              |         18 | Operational subdomain contributing to Platform Foundations and Shared Config. |
| packages/tailwind-config   |          3 | Operational subdomain contributing to Platform Foundations and Shared Config. |

## 3. Level 3: Functional Flow Decomposition

### 3.1 Primary Flows

- Flow 1: Config schema validation at startup
- Flow 2: Sizing recommendation generation
- Flow 3: Shared locale/style distribution

### 3.2 API and Route Surface

- No app-route style endpoints directly matched in this feature scope.

## 4. Level 4: Implementation Detail (Code Artifacts)

### 4.1 Module Inventory

| Implementation Slice           | Count | Representative Artifacts                                                                                                                                 |
| ------------------------------ | ----: | -------------------------------------------------------------------------------------------------------------------------------------------------------- |
| UI Components                  |     0 | N/A                                                                                                                                                      |
| Services                       |     0 | N/A                                                                                                                                                      |
| Routes / Route Modules         |     0 | N/A                                                                                                                                                      |
| Data Models                    |     0 | N/A                                                                                                                                                      |
| Workers / Executors / Pipeline |     0 | N/A                                                                                                                                                      |
| Tests                          |    25 | packages/config/src/**tests**/env-mapping.test.ts<br/>packages/config/src/**tests**/environment.test.ts<br/>packages/config/src/**tests**/loader.test.ts |

### 4.2 Detailed Implementation Paths

- packages/config/src
- packages/sizing-calculator/src
- packages/i18n/src
- packages/i18n/locales
- packages/config/package.json
- packages/config/tsconfig.json

## 5. Level 5: Verification, Controls, and Acceptance Depth

### 5.1 Verification Assets

- Test artifacts in scope: 25
  - packages/config/src/**tests**/env-mapping.test.ts
  - packages/config/src/**tests**/environment.test.ts
  - packages/config/src/**tests**/loader.test.ts
  - packages/config/src/**tests**/schemas.test.ts
  - packages/config/src/**tests**/sealer.test.ts
  - packages/config/src/**tests**/tenant-config-types.test.ts
  - packages/config/src/**tests**/validation/production-checks.test.ts
  - packages/config/src/**tests**/vault/composite-provider.test.ts
  - packages/config/src/**tests**/vault/providers.test.ts
  - packages/config/src/schemas/**tests**/security.schema.test.ts
  - packages/i18n/src/**tests**/emails.test.ts
  - packages/i18n/src/**tests**/errors.test.ts
  - packages/i18n/src/**tests**/format-message.test.ts
  - packages/i18n/src/**tests**/resolve-locale.test.ts
  - packages/i18n/src/**tests**/rtl.test.ts
  - packages/sizing-calculator/src/**tests**/calculator.test.ts
  - packages/sizing-calculator/src/**tests**/compute-sizer.test.ts
  - packages/sizing-calculator/src/**tests**/datastore-sizer.test.ts
  - packages/sizing-calculator/src/**tests**/disk-growth.test.ts
  - packages/sizing-calculator/src/**tests**/helm-values.test.ts
  - packages/sizing-calculator/src/**tests**/managed-recommender.test.ts
  - packages/sizing-calculator/src/**tests**/questionnaire.schema.test.ts
  - packages/sizing-calculator/src/**tests**/service-sizer.test.ts
  - packages/sizing-calculator/src/**tests**/tier-classifier.test.ts
  - packages/sizing-calculator/src/**tests**/topology.types.test.ts

### 5.2 5-Level Scenario Chains (Explicit)

#### Scenario 1: Config schema validation at startup

- Level 1 (Outcome): Deliver Platform Foundations and Shared Config business value.
- Level 2 (Domain): Execute within mapped subdomains (packages/config, packages/sizing-calculator, packages/i18n).
- Level 3 (Flow): Realize workflow stage "Config schema validation at startup" through route/service orchestration.
- Level 4 (Implementation): Use artifacts such as packages/config/src, packages/sizing-calculator/src, packages/i18n/src.
- Level 5 (Verification): Validate with tests and controls from packages/config/src/**tests**/env-mapping.test.ts, packages/config/src/**tests**/environment.test.ts, packages/config/src/**tests**/loader.test.ts.

#### Scenario 2: Sizing recommendation generation

- Level 1 (Outcome): Deliver Platform Foundations and Shared Config business value.
- Level 2 (Domain): Execute within mapped subdomains (packages/config, packages/sizing-calculator, packages/i18n).
- Level 3 (Flow): Realize workflow stage "Sizing recommendation generation" through route/service orchestration.
- Level 4 (Implementation): Use artifacts such as packages/i18n/src, packages/i18n/locales, packages/config/package.json.
- Level 5 (Verification): Validate with tests and controls from packages/config/src/**tests**/loader.test.ts, packages/config/src/**tests**/schemas.test.ts, packages/config/src/**tests**/sealer.test.ts.

#### Scenario 3: Shared locale/style distribution

- Level 1 (Outcome): Deliver Platform Foundations and Shared Config business value.
- Level 2 (Domain): Execute within mapped subdomains (packages/config, packages/sizing-calculator, packages/i18n).
- Level 3 (Flow): Realize workflow stage "Shared locale/style distribution" through route/service orchestration.
- Level 4 (Implementation): Use artifacts such as packages/config/package.json, packages/config/tsconfig.json.
- Level 5 (Verification): Validate with tests and controls from packages/config/src/**tests**/sealer.test.ts, packages/config/src/**tests**/tenant-config-types.test.ts, packages/config/src/**tests**/validation/production-checks.test.ts.

### 5.3 Acceptance Criteria (Deep)

- AC-001: All mapped code paths for F022 are represented in this feature's decomposition.
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

# RFC-019: Admin and Governance Surfaces

- Status: Draft (5-level deep functional specification)
- Feature ID: F019
- Focus: Admin governance, tenant control, and security operations
- Covered files in feature map: 216
- Source mapping: `docs/specs/feature-map.json`

## 1. Level 1: Business Capability Definition

This feature delivers **Admin governance, tenant control, and security operations** as a first-class platform capability.

### 1.1 Capability Boundaries

- In-scope top-level domains:
  - apps (190 files)
  - packages (26 files)
- Out-of-scope: functionality owned by adjacent split features unless explicitly mapped in this feature.

## 2. Level 2: Domain and Subdomain Decomposition

| Domain (L2)       | File Count | Purpose                                                              |
| ----------------- | ---------: | -------------------------------------------------------------------- |
| apps/admin        |         92 | Operational subdomain contributing to Admin and Governance Surfaces. |
| apps/studio       |         45 | Operational subdomain contributing to Admin and Governance Surfaces. |
| apps/telco-noc    |         44 | Operational subdomain contributing to Admin and Governance Surfaces. |
| packages/admin-ui |         16 | Operational subdomain contributing to Admin and Governance Surfaces. |
| packages/database |         10 | Operational subdomain contributing to Admin and Governance Surfaces. |
| apps/runtime      |          9 | Operational subdomain contributing to Admin and Governance Surfaces. |

## 3. Level 3: Functional Flow Decomposition

### 3.1 Primary Flows

- Flow 1: Tenant policy governance update
- Flow 2: KMS/model governance path
- Flow 3: Usage/billing admin review

### 3.2 API and Route Surface

- App-route endpoints discovered: 55
  - /api/audit
  - /api/auth/dev-login
  - /api/auth/logout
  - /api/config/diff
  - /api/config
  - /api/config/validate
  - /api/deals/[id]/credits
  - /api/deals/[id]/line-items
  - /api/deals/[id]
  - /api/deals
  - /api/health
  - /api/hubspot
  - /api/resilience/[...path]
  - /api/secrets/rotation
  - /api/secrets
  - /api/system-health
  - /api/tenant-config/[tenantId]/overrides
  - /api/tenant-config/[tenantId]
  - /api/tenant-config/plans
  - /api/tenant-config
  - /api/tenant-models/[id]/connections
  - /api/tenant-models/[id]
  - /api/tenant-models
  - /api/tenants/[tenantId]/members
  - /api/tenants/[tenantId]/projects
  - /api/tenants/[tenantId]
  - /api/tenants/[tenantId]/usage
  - /api/tenants
  - /api/usage
  - /api/organizations/[orgId]/workspaces
  - /api/organizations
  - /api/platform-admin/tenant-models/[id]/connections/[connId]
  - /api/platform-admin/tenant-models/[id]/connections
  - /api/platform-admin/tenant-models/[id]/revoke
  - /api/platform-admin/tenant-models/[id]
  - /api/platform-admin/tenant-models
  - /api/tenant-credentials/[id]/impact
  - /api/tenant-credentials/[id]
  - /api/tenant-credentials
  - /api/tenant-models/[id]/connections/[connId]
  - /api/tenant-models/[id]/connections/[connId]/validate
  - /api/tenant-models/[id]/connections
  - /api/tenant-models/[id]/impact
  - /api/tenant-models/[id]
  - /api/tenant-models/[id]/toggle-inference
  - /api/tenant-models
  - /api/tenant-usage
  - /api/workspaces/[tenantId]/invitations/[invitationId]
  - /api/workspaces/[tenantId]/invitations
  - /api/workspaces/[tenantId]/members
  - ... +5 additional app-route endpoints

- Router method inventory (module-level):
  - apps/runtime/src/routes/kms-admin.ts
    - GET /config
    - PUT /config
    - POST /validate
    - GET /keys
    - POST /keys/rotate
    - GET /audit
    - GET /health
  - apps/runtime/src/routes/workspace-billing.ts
    - GET /deals
    - GET /credits
    - POST /upgrade
    - POST /credits/topup
    - GET /features

## 4. Level 4: Implementation Detail (Code Artifacts)

### 4.1 Module Inventory

| Implementation Slice           | Count | Representative Artifacts                                                                                                                                                      |
| ------------------------------ | ----: | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| UI Components                  |    77 | apps/admin/src/app/(auth)/layout.tsx<br/>apps/admin/src/app/(auth)/login/page.tsx<br/>apps/admin/src/app/(dashboard)/audit/page.tsx                                           |
| Services                       |     0 | N/A                                                                                                                                                                           |
| Routes / Route Modules         |    64 | apps/admin/src/app/api/audit/route.ts<br/>apps/admin/src/app/api/auth/dev-login/route.ts<br/>apps/admin/src/app/api/auth/logout/route.ts                                      |
| Data Models                    |    10 | packages/database/src/models/llm-credential.model.ts<br/>packages/database/src/models/materialized-kms-config.model.ts<br/>packages/database/src/models/model-config.model.ts |
| Workers / Executors / Pipeline |     1 | apps/telco-noc/src/lib/tool-handlers.ts                                                                                                                                       |
| Tests                          |     2 | apps/admin/src/**tests**/deal-lifecycle.e2e.test.ts<br/>apps/admin/src/**tests**/tenant-lifecycle.e2e.test.ts                                                                 |

### 4.2 Detailed Implementation Paths

- apps/admin/src
- apps/studio/src
- apps/telco-noc/src
- packages/admin-ui/src
- apps/admin/e2e
- packages/database/src
- apps/admin/src/app/api/audit/route.ts
- apps/admin/src/app/api/auth/dev-login/route.ts
- apps/admin/src/app/api/auth/logout/route.ts
- apps/admin/src/app/api/config/diff/route.ts
- apps/admin/src/app/api/config/route.ts
- apps/admin/src/app/api/config/validate/route.ts
- packages/database/src/models/llm-credential.model.ts
- packages/database/src/models/materialized-kms-config.model.ts
- packages/database/src/models/model-config.model.ts
- packages/database/src/models/organization.model.ts
- packages/database/src/models/project.model.ts
- packages/database/src/models/role-definition.model.ts

## 5. Level 5: Verification, Controls, and Acceptance Depth

### 5.1 Verification Assets

- Test artifacts in scope: 2
  - apps/admin/src/**tests**/deal-lifecycle.e2e.test.ts
  - apps/admin/src/**tests**/tenant-lifecycle.e2e.test.ts

### 5.2 5-Level Scenario Chains (Explicit)

#### Scenario 1: Tenant policy governance update

- Level 1 (Outcome): Deliver Admin and Governance Surfaces business value.
- Level 2 (Domain): Execute within mapped subdomains (apps/admin, apps/studio, apps/telco-noc).
- Level 3 (Flow): Realize workflow stage "Tenant policy governance update" through route/service orchestration.
- Level 4 (Implementation): Use artifacts such as apps/admin/src, apps/studio/src, apps/telco-noc/src.
- Level 5 (Verification): Validate with tests and controls from apps/admin/src/**tests**/deal-lifecycle.e2e.test.ts, apps/admin/src/**tests**/tenant-lifecycle.e2e.test.ts.

#### Scenario 2: KMS/model governance path

- Level 1 (Outcome): Deliver Admin and Governance Surfaces business value.
- Level 2 (Domain): Execute within mapped subdomains (apps/admin, apps/studio, apps/telco-noc).
- Level 3 (Flow): Realize workflow stage "KMS/model governance path" through route/service orchestration.
- Level 4 (Implementation): Use artifacts such as apps/telco-noc/src, packages/admin-ui/src, apps/admin/e2e.
- Level 5 (Verification): Validate with tests and controls from feature test suites and acceptance checks.

#### Scenario 3: Usage/billing admin review

- Level 1 (Outcome): Deliver Admin and Governance Surfaces business value.
- Level 2 (Domain): Execute within mapped subdomains (apps/admin, apps/studio, apps/telco-noc).
- Level 3 (Flow): Realize workflow stage "Usage/billing admin review" through route/service orchestration.
- Level 4 (Implementation): Use artifacts such as apps/admin/e2e, packages/database/src, apps/admin/src/app/api/audit/route.ts.
- Level 5 (Verification): Validate with tests and controls from feature test suites and acceptance checks.

### 5.3 Acceptance Criteria (Deep)

- AC-001: All mapped code paths for F019 are represented in this feature's decomposition.
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

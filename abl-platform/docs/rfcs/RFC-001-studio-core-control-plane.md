# RFC-001: Studio Core Control Plane

- Status: Draft (5-level deep functional specification)
- Feature ID: F001
- Focus: Studio project control plane and UX orchestration
- Covered files in feature map: 1252
- Source mapping: `docs/specs/feature-map.json`

## 1. Level 1: Business Capability Definition

This feature delivers **Studio project control plane and UX orchestration** as a first-class platform capability.

### 1.1 Capability Boundaries

- In-scope top-level domains:
  - apps (1252 files)
- Out-of-scope: functionality owned by adjacent split features unless explicitly mapped in this feature.

## 2. Level 2: Domain and Subdomain Decomposition

| Domain (L2)    | File Count | Purpose                                                          |
| -------------- | ---------: | ---------------------------------------------------------------- |
| apps/studio    |       1224 | Operational subdomain contributing to Studio Core Control Plane. |
| apps/spec-mock |         28 | Operational subdomain contributing to Studio Core Control Plane. |

## 3. Level 3: Functional Flow Decomposition

### 3.1 Primary Flows

- Flow 1: Project bootstrap and navigation
- Flow 2: Agent editing session
- Flow 3: Cross-feature control-plane fallback

### 3.2 API and Route Surface

- App-route endpoints discovered: 299
  - /api/abl/analysis
  - /api/abl/compile
  - /api/abl/diagnostics
  - /api/abl/docs
  - /api/abl/parse
  - /api/admin/alerts/[id]
  - /api/admin/alerts
  - /api/admin/billing
  - /api/admin/channel-connections
  - /api/admin/env-vars
  - /api/admin/guardrail-policies
  - /api/admin/guardrail-providers
  - /api/admin/kms
  - /api/admin/sdk-channels
  - /api/admin/sdk-clients
  - /api/agents/[name]
  - /api/agents/apps/[domain]
  - /api/agents/apps
  - /api/agents
  - /api/arch/chat
  - /api/arch/config
  - /api/arch/deploy-mocks
  - /api/arch/generate
  - /api/arch/models
  - /api/arch/status
  - /api/arch/validate-key
  - /api/archives/[id]/download
  - /api/archives/[id]
  - /api/archives/audit-export
  - /api/archives
  - /api/archives/sessions
  - /api/archives/traces
  - /api/audit
  - /api/auth/callback
  - /api/auth/create-workspace
  - /api/auth/dev-login
  - /api/auth/device/authorize
  - /api/auth/device/lookup
  - /api/auth/device
  - /api/auth/device/token
  - /api/auth/forgot-password
  - /api/auth/google
  - /api/auth/linkedin/callback
  - /api/auth/linkedin
  - /api/auth/login
  - /api/auth/logout
  - /api/auth/me
  - /api/auth/microsoft/callback
  - /api/auth/microsoft
  - /api/auth/refresh
  - ... +249 additional app-route endpoints

## 4. Level 4: Implementation Detail (Code Artifacts)

### 4.1 Module Inventory

| Implementation Slice           | Count | Representative Artifacts                                                                                                                                                                                  |
| ------------------------------ | ----: | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| UI Components                  |   467 | apps/spec-mock/src/app/project/agents/[agentId]/page.tsx<br/>apps/spec-mock/src/app/project/agents/page.tsx<br/>apps/spec-mock/src/app/project/architect/page.tsx                                         |
| Services                       |    34 | apps/studio/src/services/arch.service.ts<br/>apps/studio/src/services/archive/archive-service.ts<br/>apps/studio/src/services/archive/archive-types.ts                                                    |
| Routes / Route Modules         |   302 | apps/studio/src/app/api/abl/analysis/route.ts<br/>apps/studio/src/app/api/abl/compile/route.ts<br/>apps/studio/src/app/api/abl/diagnostics/route.ts                                                       |
| Data Models                    |     0 | N/A                                                                                                                                                                                                       |
| Workers / Executors / Pipeline |    10 | apps/studio/src/app/api/pipelines/[pipelineId]/activate/route.ts<br/>apps/studio/src/app/api/pipelines/[pipelineId]/clone/route.ts<br/>apps/studio/src/app/api/pipelines/[pipelineId]/deactivate/route.ts |
| Tests                          |   131 | apps/studio/src/**tests**/CrawlJobForm.test.tsx<br/>apps/studio/src/**tests**/UrlPreviewDialog.test.tsx<br/>apps/studio/src/**tests**/abl-serializers.test.ts                                             |

### 4.2 Detailed Implementation Paths

- apps/studio/src
- apps/studio/public
- apps/spec-mock/src
- apps/studio/e2e
- apps/spec-mock/next-env.d.ts
- apps/spec-mock/next.config.js
- apps/studio/src/app/api/abl/analysis/route.ts
- apps/studio/src/app/api/abl/compile/route.ts
- apps/studio/src/app/api/abl/diagnostics/route.ts
- apps/studio/src/app/api/abl/docs/route.ts
- apps/studio/src/app/api/abl/parse/route.ts
- apps/studio/src/app/api/admin/alerts/[id]/route.ts
- apps/studio/src/services/arch.service.ts
- apps/studio/src/services/archive/archive-service.ts
- apps/studio/src/services/archive/archive-types.ts
- apps/studio/src/services/archive/local-archive-store.ts
- apps/studio/src/services/archive/s3-archive-store.ts
- apps/studio/src/services/audit-service.ts

## 5. Level 5: Verification, Controls, and Acceptance Depth

### 5.1 Verification Assets

- Test artifacts in scope: 131
  - apps/studio/src/**tests**/CrawlJobForm.test.tsx
  - apps/studio/src/**tests**/UrlPreviewDialog.test.tsx
  - apps/studio/src/**tests**/abl-serializers.test.ts
  - apps/studio/src/**tests**/agent-detail-page.test.tsx
  - apps/studio/src/**tests**/agent-detail-store.test.ts
  - apps/studio/src/**tests**/agent-hooks.test.ts
  - apps/studio/src/**tests**/agent-ir-hook.test.ts
  - apps/studio/src/**tests**/agent-path-uniqueness.test.ts
  - apps/studio/src/**tests**/api-auth.test.ts
  - apps/studio/src/**tests**/api-deployment-routes.test.ts
  - apps/studio/src/**tests**/api-export-async-routes.test.ts
  - apps/studio/src/**tests**/api-export-routes.test.ts
  - apps/studio/src/**tests**/api-git-routes.test.ts
  - apps/studio/src/**tests**/api-mcp-client.test.ts
  - apps/studio/src/**tests**/api-mcp-routes.test.ts
  - apps/studio/src/**tests**/api-mfa-routes.test.ts
  - apps/studio/src/**tests**/api-misc.test.ts
  - apps/studio/src/**tests**/api-model-routes.test.ts
  - apps/studio/src/**tests**/api-org-routes.test.ts
  - apps/studio/src/**tests**/api-projects.test.ts
  - apps/studio/src/**tests**/api-proxy-routes.test.ts
  - apps/studio/src/**tests**/api-route-validation.test.ts
  - apps/studio/src/**tests**/api-sso-routes.test.ts
  - apps/studio/src/**tests**/api-tool-routes.test.ts
  - apps/studio/src/**tests**/api-tools-client.test.ts
  - apps/studio/src/**tests**/api-webhook-git-routes.test.ts
  - apps/studio/src/**tests**/api-workflow-routes.test.ts
  - apps/studio/src/**tests**/arch-components.test.tsx
  - apps/studio/src/**tests**/arch-config-api.test.ts
  - apps/studio/src/**tests**/arch-config-store.test.ts
  - apps/studio/src/**tests**/arch-context-profiles.test.ts
  - apps/studio/src/**tests**/arch-edit-context.test.ts
  - apps/studio/src/**tests**/arch-edit-ux-types.test.ts
  - apps/studio/src/**tests**/arch-generate-openapi.test.ts
  - apps/studio/src/**tests**/arch-llm.test.ts
  - apps/studio/src/**tests**/arch-onboarding-store.test.ts
  - apps/studio/src/**tests**/arch-section-chat.test.ts
  - apps/studio/src/**tests**/arch-section-wiring.test.tsx
  - apps/studio/src/**tests**/arch-settings-page.test.tsx
  - apps/studio/src/**tests**/arch-workflow.test.ts
  - ... +91 additional test files

### 5.2 5-Level Scenario Chains (Explicit)

#### Scenario 1: Project bootstrap and navigation

- Level 1 (Outcome): Deliver Studio Core Control Plane business value.
- Level 2 (Domain): Execute within mapped subdomains (apps/studio, apps/spec-mock).
- Level 3 (Flow): Realize workflow stage "Project bootstrap and navigation" through route/service orchestration.
- Level 4 (Implementation): Use artifacts such as apps/studio/src, apps/studio/public, apps/spec-mock/src.
- Level 5 (Verification): Validate with tests and controls from apps/studio/src/**tests**/CrawlJobForm.test.tsx, apps/studio/src/**tests**/UrlPreviewDialog.test.tsx, apps/studio/src/**tests**/abl-serializers.test.ts.

#### Scenario 2: Agent editing session

- Level 1 (Outcome): Deliver Studio Core Control Plane business value.
- Level 2 (Domain): Execute within mapped subdomains (apps/studio, apps/spec-mock).
- Level 3 (Flow): Realize workflow stage "Agent editing session" through route/service orchestration.
- Level 4 (Implementation): Use artifacts such as apps/spec-mock/src, apps/studio/e2e, apps/spec-mock/next-env.d.ts.
- Level 5 (Verification): Validate with tests and controls from apps/studio/src/**tests**/abl-serializers.test.ts, apps/studio/src/**tests**/agent-detail-page.test.tsx, apps/studio/src/**tests**/agent-detail-store.test.ts.

#### Scenario 3: Cross-feature control-plane fallback

- Level 1 (Outcome): Deliver Studio Core Control Plane business value.
- Level 2 (Domain): Execute within mapped subdomains (apps/studio, apps/spec-mock).
- Level 3 (Flow): Realize workflow stage "Cross-feature control-plane fallback" through route/service orchestration.
- Level 4 (Implementation): Use artifacts such as apps/spec-mock/next-env.d.ts, apps/spec-mock/next.config.js, apps/studio/src/app/api/abl/analysis/route.ts.
- Level 5 (Verification): Validate with tests and controls from apps/studio/src/**tests**/agent-detail-store.test.ts, apps/studio/src/**tests**/agent-hooks.test.ts, apps/studio/src/**tests**/agent-ir-hook.test.ts.

### 5.3 Acceptance Criteria (Deep)

- AC-001: All mapped code paths for F001 are represented in this feature's decomposition.
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

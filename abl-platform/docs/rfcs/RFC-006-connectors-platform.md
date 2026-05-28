# RFC-006: Connectors Platform

- Status: Draft (5-level deep functional specification)
- Feature ID: F006
- Focus: Connector lifecycle, auth, callback, and sync orchestration
- Covered files in feature map: 161
- Source mapping: `docs/specs/feature-map.json`

## 1. Level 1: Business Capability Definition

This feature delivers **Connector lifecycle, auth, callback, and sync orchestration** as a first-class platform capability.

### 1.1 Capability Boundaries

- In-scope top-level domains:
  - packages (119 files)
  - apps (42 files)
- Out-of-scope: functionality owned by adjacent split features unless explicitly mapped in this feature.

## 2. Level 2: Domain and Subdomain Decomposition

| Domain (L2)          | File Count | Purpose                                                    |
| -------------------- | ---------: | ---------------------------------------------------------- |
| packages/connectors  |        116 | Operational subdomain contributing to Connectors Platform. |
| apps/studio          |         20 | Operational subdomain contributing to Connectors Platform. |
| apps/runtime         |         16 | Operational subdomain contributing to Connectors Platform. |
| apps/search-ai       |          3 | Operational subdomain contributing to Connectors Platform. |
| apps/workflow-engine |          3 | Operational subdomain contributing to Connectors Platform. |
| packages/database    |          3 | Operational subdomain contributing to Connectors Platform. |

## 3. Level 3: Functional Flow Decomposition

### 3.1 Primary Flows

- Flow 1: Connector setup and authentication
- Flow 2: Connector sync trigger flow
- Flow 3: Workflow connection test path

### 3.2 API and Route Surface

- App-route endpoints discovered: 15
  - /api/projects/[id]/connections/[connectionId]
  - /api/projects/[id]/connections/[connectionId]/test
  - /api/projects/[id]/connections/oauth/callback
  - /api/projects/[id]/connections
  - /api/projects/[id]/connectors
  - /api/projects/[id]/workflows/connectors
  - /api/search-ai/connectors/[connectorId]/auth/initiate
  - /api/search-ai/connectors/[connectorId]/auth/status
  - /api/search-ai/connectors/[connectorId]/discover
  - /api/search-ai/connectors/[connectorId]/discovery
  - /api/search-ai/connectors/[connectorId]/quick-setup
  - /api/search-ai/connectors/[connectorId]/recommendations/[recommendationId]/accept
  - /api/search-ai/connectors/[connectorId]/recommendations
  - /api/search-ai/connectors/[connectorId]/sync/start
  - /api/search-ai/connectors/[connectorId]/sync/status

- Router method inventory (module-level):
  - apps/runtime/src/routes/channel-connections.ts
    - POST /
    - GET /
    - GET /sbc-address
    - GET /:id
    - PATCH /:id
    - DELETE /:id
  - apps/search-ai/src/routes/connector-discovery.ts
    - POST /connectors/:connectorId/discover
    - GET /connectors/:connectorId/discovery
    - GET /connectors/:connectorId/discovery/:discoveryId
    - POST /connectors/:connectorId/recommendations
    - GET /connectors/:connectorId/recommendations
    - POST /connectors/:connectorId/recommendations/:recommendationId/accept
    - POST /connectors/:connectorId/quick-setup
  - apps/search-ai/src/routes/connectors.ts
    - GET /:indexId/connectors
    - POST /:indexId/connectors
    - GET /:indexId/connectors/:connectorId
    - PUT /:indexId/connectors/:connectorId
    - DELETE /:indexId/connectors/:connectorId
    - POST /connectors/:connectorId/auth/initiate
    - GET /connectors/:connectorId/auth/status
    - POST /connectors/:connectorId/auth/callback
  - apps/search-ai/src/routes/webhooks.ts
    - GET /connectors/:connectorId/sharepoint
    - POST /connectors/:connectorId/sharepoint
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

## 4. Level 4: Implementation Detail (Code Artifacts)

### 4.1 Module Inventory

| Implementation Slice           | Count | Representative Artifacts                                                                                                                                                                                                                                                   |
| ------------------------------ | ----: | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| UI Components                  |     5 | apps/studio/src/components/connections/ConnectionCard.tsx<br/>apps/studio/src/components/connections/ConnectionCreatePage.tsx<br/>apps/studio/src/components/connections/ConnectionDetailPage.tsx                                                                          |
| Services                       |    18 | apps/runtime/src/services/channel-oauth/**tests**/channel-oauth-service.test.ts<br/>apps/runtime/src/services/channel-oauth/channel-oauth-provider.ts<br/>apps/runtime/src/services/channel-oauth/channel-oauth-service.ts                                                 |
| Routes / Route Modules         |    22 | apps/runtime/src/routes/channel-connections.ts<br/>apps/runtime/src/routes/channel-oauth.ts<br/>apps/search-ai/src/routes/connector-discovery.ts                                                                                                                           |
| Data Models                    |     3 | packages/database/src/models/channel-connection.model.ts<br/>packages/database/src/models/end-user-oauth-token.model.ts<br/>packages/database/src/models/webhook-subscription.model.ts                                                                                     |
| Workers / Executors / Pipeline |     0 | N/A                                                                                                                                                                                                                                                                        |
| Tests                          |    34 | apps/runtime/src/services/channel-oauth/**tests**/channel-oauth-service.test.ts<br/>apps/runtime/src/services/channel-oauth/providers/**tests**/meta-oauth-provider.test.ts<br/>apps/runtime/src/services/channel-oauth/providers/**tests**/msteams-oauth-provider.test.ts |

### 4.2 Detailed Implementation Paths

- packages/connectors/src
- packages/connectors/sharepoint
- packages/connectors/base
- apps/studio/src
- apps/runtime/src
- apps/search-ai/src
- apps/runtime/src/routes/channel-connections.ts
- apps/runtime/src/routes/channel-oauth.ts
- apps/search-ai/src/routes/connector-discovery.ts
- apps/search-ai/src/routes/connectors.ts
- apps/search-ai/src/routes/webhooks.ts
- apps/studio/src/app/api/projects/[id]/connections/[connectionId]/route.ts
- apps/runtime/src/services/channel-oauth/**tests**/channel-oauth-service.test.ts
- apps/runtime/src/services/channel-oauth/channel-oauth-provider.ts
- apps/runtime/src/services/channel-oauth/channel-oauth-service.ts
- apps/runtime/src/services/channel-oauth/index.ts
- apps/runtime/src/services/channel-oauth/providers/**tests**/meta-oauth-provider.test.ts
- apps/runtime/src/services/channel-oauth/providers/**tests**/msteams-oauth-provider.test.ts
- packages/database/src/models/channel-connection.model.ts
- packages/database/src/models/end-user-oauth-token.model.ts
- packages/database/src/models/webhook-subscription.model.ts

## 5. Level 5: Verification, Controls, and Acceptance Depth

### 5.1 Verification Assets

- Test artifacts in scope: 34
  - apps/runtime/src/services/channel-oauth/**tests**/channel-oauth-service.test.ts
  - apps/runtime/src/services/channel-oauth/providers/**tests**/meta-oauth-provider.test.ts
  - apps/runtime/src/services/channel-oauth/providers/**tests**/msteams-oauth-provider.test.ts
  - apps/runtime/src/services/channel-oauth/providers/**tests**/slack-oauth-provider.test.ts
  - packages/connectors/base/src/**tests**/base-filter-engine.test.ts
  - packages/connectors/base/src/**tests**/base-resource-discovery.test.ts
  - packages/connectors/base/src/**tests**/device-code-flow.test.ts
  - packages/connectors/base/src/**tests**/rate-limiter.test.ts
  - packages/connectors/base/src/**tests**/retry-handler.test.ts
  - packages/connectors/base/src/**tests**/token-manager.test.ts.skip
  - packages/connectors/sharepoint/src/**tests**/delta-sync-coordinator.test.ts
  - packages/connectors/sharepoint/src/**tests**/full-sync-coordinator.test.ts
  - packages/connectors/sharepoint/src/**tests**/graph-client.test.ts
  - packages/connectors/sharepoint/src/**tests**/helpers/mock-graph-client.ts
  - packages/connectors/sharepoint/src/**tests**/integration/oauth-flow.integration.test.ts
  - packages/connectors/sharepoint/src/**tests**/integration/sync-flow.integration.test.ts
  - packages/connectors/sharepoint/src/**tests**/microsoft-oauth-provider.test.ts
  - packages/connectors/sharepoint/src/**tests**/sharepoint-filter-engine.test.ts
  - packages/connectors/sharepoint/src/**tests**/sharepoint-permission-crawler.test.ts
  - packages/connectors/sharepoint/src/**tests**/sharepoint-resource-discovery.test.ts
  - packages/connectors/sharepoint/src/**tests**/sync-permission-integration.test.ts
  - packages/connectors/src/**tests**/activepieces-importer.test.ts
  - packages/connectors/src/**tests**/connection-resolver.test.ts
  - packages/connectors/src/**tests**/connection-service.test.ts
  - packages/connectors/src/**tests**/connector-tool-executor.test.ts
  - packages/connectors/src/**tests**/cron-scheduler.test.ts
  - packages/connectors/src/**tests**/nango-importer.test.ts
  - packages/connectors/src/**tests**/polling-scheduler.test.ts
  - packages/connectors/src/**tests**/properties.test.ts
  - packages/connectors/src/**tests**/registry.test.ts
  - packages/connectors/src/**tests**/trigger-engine.test.ts
  - packages/connectors/src/**tests**/types.test.ts
  - packages/connectors/src/**tests**/webhook-handler.test.ts
  - packages/connectors/src/**tests**/workflow-tool-executor.test.ts

### 5.2 5-Level Scenario Chains (Explicit)

#### Scenario 1: Connector setup and authentication

- Level 1 (Outcome): Deliver Connectors Platform business value.
- Level 2 (Domain): Execute within mapped subdomains (packages/connectors, apps/studio, apps/runtime).
- Level 3 (Flow): Realize workflow stage "Connector setup and authentication" through route/service orchestration.
- Level 4 (Implementation): Use artifacts such as packages/connectors/src, packages/connectors/sharepoint, packages/connectors/base.
- Level 5 (Verification): Validate with tests and controls from apps/runtime/src/services/channel-oauth/**tests**/channel-oauth-service.test.ts, apps/runtime/src/services/channel-oauth/providers/**tests**/meta-oauth-provider.test.ts, apps/runtime/src/services/channel-oauth/providers/**tests**/msteams-oauth-provider.test.ts.

#### Scenario 2: Connector sync trigger flow

- Level 1 (Outcome): Deliver Connectors Platform business value.
- Level 2 (Domain): Execute within mapped subdomains (packages/connectors, apps/studio, apps/runtime).
- Level 3 (Flow): Realize workflow stage "Connector sync trigger flow" through route/service orchestration.
- Level 4 (Implementation): Use artifacts such as packages/connectors/base, apps/studio/src, apps/runtime/src.
- Level 5 (Verification): Validate with tests and controls from apps/runtime/src/services/channel-oauth/providers/**tests**/msteams-oauth-provider.test.ts, apps/runtime/src/services/channel-oauth/providers/**tests**/slack-oauth-provider.test.ts, packages/connectors/base/src/**tests**/base-filter-engine.test.ts.

#### Scenario 3: Workflow connection test path

- Level 1 (Outcome): Deliver Connectors Platform business value.
- Level 2 (Domain): Execute within mapped subdomains (packages/connectors, apps/studio, apps/runtime).
- Level 3 (Flow): Realize workflow stage "Workflow connection test path" through route/service orchestration.
- Level 4 (Implementation): Use artifacts such as apps/runtime/src, apps/search-ai/src, apps/runtime/src/routes/channel-connections.ts.
- Level 5 (Verification): Validate with tests and controls from packages/connectors/base/src/**tests**/base-filter-engine.test.ts, packages/connectors/base/src/**tests**/base-resource-discovery.test.ts, packages/connectors/base/src/**tests**/device-code-flow.test.ts.

### 5.3 Acceptance Criteria (Deep)

- AC-001: All mapped code paths for F006 are represented in this feature's decomposition.
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

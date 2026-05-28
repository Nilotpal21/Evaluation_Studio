# RFC-017: Developer Tooling MCP LSP CLI

- Status: Draft (5-level deep functional specification)
- Feature ID: F017
- Focus: Developer tooling: MCP, CLI, LSP, VSCode, OpenAPI, SDKs
- Covered files in feature map: 279
- Source mapping: `docs/specs/feature-map.json`

## 1. Level 1: Business Capability Definition

This feature delivers **Developer tooling: MCP, CLI, LSP, VSCode, OpenAPI, SDKs** as a first-class platform capability.

### 1.1 Capability Boundaries

- In-scope top-level domains:
  - packages (165 files)
  - examples (110 files)
  - apps (4 files)
- Out-of-scope: functionality owned by adjacent split features unless explicitly mapped in this feature.

## 2. Level 2: Domain and Subdomain Decomposition

| Domain (L2)                | File Count | Purpose                                                              |
| -------------------------- | ---------: | -------------------------------------------------------------------- |
| packages/kore-platform-cli |         49 | Operational subdomain contributing to Developer Tooling MCP LSP CLI. |
| packages/mcp-debug         |         42 | Operational subdomain contributing to Developer Tooling MCP LSP CLI. |
| packages/web-sdk           |         35 | Operational subdomain contributing to Developer Tooling MCP LSP CLI. |
| examples/saludsa-imported  |         22 | Operational subdomain contributing to Developer Tooling MCP LSP CLI. |
| examples/travel            |         14 | Operational subdomain contributing to Developer Tooling MCP LSP CLI. |
| packages/openapi           |         13 | Operational subdomain contributing to Developer Tooling MCP LSP CLI. |
| packages/abl-lsp-server    |         12 | Operational subdomain contributing to Developer Tooling MCP LSP CLI. |
| packages/abl-vscode        |          9 | Operational subdomain contributing to Developer Tooling MCP LSP CLI. |
| examples/flow-test         |          8 | Operational subdomain contributing to Developer Tooling MCP LSP CLI. |
| examples/saludsa           |          8 | Operational subdomain contributing to Developer Tooling MCP LSP CLI. |
| examples/telco             |          8 | Operational subdomain contributing to Developer Tooling MCP LSP CLI. |
| examples/retail            |          7 | Operational subdomain contributing to Developer Tooling MCP LSP CLI. |

## 3. Level 3: Functional Flow Decomposition

### 3.1 Primary Flows

- Flow 1: CLI project operation flow
- Flow 2: MCP debug tool session
- Flow 3: LSP/IDE assist cycle

### 3.2 API and Route Surface

- App-route endpoints discovered: 2
  - /api/openapi
  - /api/openapi/spec.json

## 4. Level 4: Implementation Detail (Code Artifacts)

### 4.1 Module Inventory

| Implementation Slice           | Count | Representative Artifacts                                                                                                                                                                            |
| ------------------------------ | ----: | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| UI Components                  |     2 | apps/studio/src/app/docs/abl/page.tsx<br/>apps/studio/src/components/docs/ABLDocsPage.tsx                                                                                                           |
| Services                       |     0 | N/A                                                                                                                                                                                                 |
| Routes / Route Modules         |     2 | apps/studio/src/app/api/openapi/route.ts<br/>apps/studio/src/app/api/openapi/spec.json/route.ts                                                                                                     |
| Data Models                    |     5 | packages/database/src/models/api-key.model.ts<br/>packages/database/src/models/device-auth-request.model.ts<br/>packages/database/src/models/public-api-key.model.ts                                |
| Workers / Executors / Pipeline |     0 | N/A                                                                                                                                                                                                 |
| Tests                          |    18 | packages/abl-lsp-server/src/**tests**/adapters.test.ts<br/>packages/abl-lsp-server/src/**tests**/workspace-scanner.test.ts<br/>packages/kore-platform-cli/src/**tests**/commands/connectors.test.ts |

### 4.2 Detailed Implementation Paths

- packages/kore-platform-cli/src
- packages/mcp-debug/src
- packages/web-sdk/src
- examples/saludsa-imported/agents
- packages/openapi/src
- examples/travel/agents
- apps/studio/src/app/api/openapi/route.ts
- apps/studio/src/app/api/openapi/spec.json/route.ts
- packages/database/src/models/api-key.model.ts
- packages/database/src/models/device-auth-request.model.ts
- packages/database/src/models/public-api-key.model.ts
- packages/database/src/models/sdk-channel.model.ts
- packages/database/src/models/widget-config.model.ts

## 5. Level 5: Verification, Controls, and Acceptance Depth

### 5.1 Verification Assets

- Test artifacts in scope: 18
  - packages/abl-lsp-server/src/**tests**/adapters.test.ts
  - packages/abl-lsp-server/src/**tests**/workspace-scanner.test.ts
  - packages/kore-platform-cli/src/**tests**/commands/connectors.test.ts
  - packages/kore-platform-cli/src/**tests**/e2e/remote-platform.e2e.test.ts
  - packages/kore-platform-cli/src/**tests**/mcp/architect.test.ts
  - packages/kore-platform-cli/src/**tests**/mcp/import.test.ts
  - packages/kore-platform-cli/src/**tests**/mcp/server.test.ts
  - packages/kore-platform-cli/src/**tests**/mcp/validate.test.ts
  - packages/mcp-debug/src/**tests**/analysis.test.ts
  - packages/mcp-debug/src/**tests**/auth-client.test.ts
  - packages/mcp-debug/src/**tests**/connect.test.ts
  - packages/mcp-debug/src/**tests**/credentials.test.ts
  - packages/mcp-debug/src/**tests**/decisions.test.ts
  - packages/mcp-debug/src/**tests**/docs.test.ts
  - packages/mcp-debug/src/**tests**/fetch.test.ts
  - packages/mcp-debug/src/**tests**/http-client.test.ts
  - packages/mcp-debug/src/**tests**/url.test.ts
  - packages/web-sdk/src/**tests**/rich-content-sdk.test.ts

### 5.2 5-Level Scenario Chains (Explicit)

#### Scenario 1: CLI project operation flow

- Level 1 (Outcome): Deliver Developer Tooling MCP LSP CLI business value.
- Level 2 (Domain): Execute within mapped subdomains (packages/kore-platform-cli, packages/mcp-debug, packages/web-sdk).
- Level 3 (Flow): Realize workflow stage "CLI project operation flow" through route/service orchestration.
- Level 4 (Implementation): Use artifacts such as packages/kore-platform-cli/src, packages/mcp-debug/src, packages/web-sdk/src.
- Level 5 (Verification): Validate with tests and controls from packages/abl-lsp-server/src/**tests**/adapters.test.ts, packages/abl-lsp-server/src/**tests**/workspace-scanner.test.ts, packages/kore-platform-cli/src/**tests**/commands/connectors.test.ts.

#### Scenario 2: MCP debug tool session

- Level 1 (Outcome): Deliver Developer Tooling MCP LSP CLI business value.
- Level 2 (Domain): Execute within mapped subdomains (packages/kore-platform-cli, packages/mcp-debug, packages/web-sdk).
- Level 3 (Flow): Realize workflow stage "MCP debug tool session" through route/service orchestration.
- Level 4 (Implementation): Use artifacts such as packages/web-sdk/src, examples/saludsa-imported/agents, packages/openapi/src.
- Level 5 (Verification): Validate with tests and controls from packages/kore-platform-cli/src/**tests**/commands/connectors.test.ts, packages/kore-platform-cli/src/**tests**/e2e/remote-platform.e2e.test.ts, packages/kore-platform-cli/src/**tests**/mcp/architect.test.ts.

#### Scenario 3: LSP/IDE assist cycle

- Level 1 (Outcome): Deliver Developer Tooling MCP LSP CLI business value.
- Level 2 (Domain): Execute within mapped subdomains (packages/kore-platform-cli, packages/mcp-debug, packages/web-sdk).
- Level 3 (Flow): Realize workflow stage "LSP/IDE assist cycle" through route/service orchestration.
- Level 4 (Implementation): Use artifacts such as packages/openapi/src, examples/travel/agents, apps/studio/src/app/api/openapi/route.ts.
- Level 5 (Verification): Validate with tests and controls from packages/kore-platform-cli/src/**tests**/mcp/architect.test.ts, packages/kore-platform-cli/src/**tests**/mcp/import.test.ts, packages/kore-platform-cli/src/**tests**/mcp/server.test.ts.

### 5.3 Acceptance Criteria (Deep)

- AC-001: All mapped code paths for F017 are represented in this feature's decomposition.
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

# RFC-005: Agent Tools Platform

- Status: Draft (5-level deep functional specification)
- Feature ID: F005
- Focus: Tool authoring, MCP server management, and runtime tool contracts
- Covered files in feature map: 72
- Source mapping: `docs/specs/feature-map.json`

## 1. Level 1: Business Capability Definition

This feature delivers **Tool authoring, MCP server management, and runtime tool contracts** as a first-class platform capability.

### 1.1 Capability Boundaries

- In-scope top-level domains:
  - apps (61 files)
  - packages (11 files)
- Out-of-scope: functionality owned by adjacent split features unless explicitly mapped in this feature.

## 2. Level 2: Domain and Subdomain Decomposition

| Domain (L2)       | File Count | Purpose                                                     |
| ----------------- | ---------: | ----------------------------------------------------------- |
| apps/studio       |         55 | Operational subdomain contributing to Agent Tools Platform. |
| packages/shared   |          7 | Operational subdomain contributing to Agent Tools Platform. |
| apps/runtime      |          6 | Operational subdomain contributing to Agent Tools Platform. |
| packages/database |          3 | Operational subdomain contributing to Agent Tools Platform. |
| packages/compiler |          1 | Operational subdomain contributing to Agent Tools Platform. |

## 3. Level 3: Functional Flow Decomposition

### 3.1 Primary Flows

- Flow 1: Tool definition to runtime execution
- Flow 2: MCP tool discovery and test
- Flow 3: Tool secret resolution path

### 3.2 API and Route Surface

- App-route endpoints discovered: 13
  - /api/projects/[id]/mcp-servers/[serverId]
  - /api/projects/[id]/mcp-servers/[serverId]/test-connection
  - /api/projects/[id]/mcp-servers/[serverId]/tools/[toolName]/test
  - /api/projects/[id]/mcp-servers/[serverId]/tools/discover/preview
  - /api/projects/[id]/mcp-servers/[serverId]/tools/discover
  - /api/projects/[id]/mcp-servers/[serverId]/tools
  - /api/projects/[id]/mcp-servers
  - /api/projects/[id]/tools/[toolId]/duplicate
  - /api/projects/[id]/tools/[toolId]/export
  - /api/projects/[id]/tools/[toolId]
  - /api/projects/[id]/tools/[toolId]/test
  - /api/projects/[id]/tools/import
  - /api/projects/[id]/tools

## 4. Level 4: Implementation Detail (Code Artifacts)

### 4.1 Module Inventory

| Implementation Slice           | Count | Representative Artifacts                                                                                                                                                                                             |
| ------------------------------ | ----: | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| UI Components                  |    42 | apps/studio/src/components/mcp-servers/McpServerCard.tsx<br/>apps/studio/src/components/mcp-servers/McpServerCreateDialog.tsx<br/>apps/studio/src/components/mcp-servers/McpServerDetailPage.tsx                     |
| Services                       |     2 | apps/runtime/src/services/mcp/inline-mcp-provider.ts<br/>apps/runtime/src/services/mcp/runtime-mcp-provider.ts                                                                                                       |
| Routes / Route Modules         |    14 | apps/runtime/src/routes/tool-secrets.ts<br/>apps/studio/src/app/api/projects/[id]/mcp-servers/[serverId]/route.ts<br/>apps/studio/src/app/api/projects/[id]/mcp-servers/[serverId]/test-connection/route.ts          |
| Data Models                    |     3 | packages/database/src/models/mcp-server-config.model.ts<br/>packages/database/src/models/project-tool.model.ts<br/>packages/database/src/models/tool-secret.model.ts                                                 |
| Workers / Executors / Pipeline |     0 | N/A                                                                                                                                                                                                                  |
| Tests                          |     6 | apps/runtime/src/tools/**tests**/attachment-tool-executor.test.ts<br/>apps/studio/src/components/tools/**tests**/DynamicToolInputForm.test.tsx<br/>apps/studio/src/components/tools/**tests**/HttpConfigForm.test.ts |

### 4.2 Detailed Implementation Paths

- apps/studio/src
- packages/shared/src
- apps/runtime/src
- packages/database/src
- packages/compiler/src
- apps/runtime/src/routes/tool-secrets.ts
- apps/studio/src/app/api/projects/[id]/mcp-servers/[serverId]/route.ts
- apps/studio/src/app/api/projects/[id]/mcp-servers/[serverId]/test-connection/route.ts
- apps/studio/src/app/api/projects/[id]/mcp-servers/[serverId]/tools/[toolName]/test/route.ts
- apps/studio/src/app/api/projects/[id]/mcp-servers/[serverId]/tools/discover/preview/route.ts
- apps/studio/src/app/api/projects/[id]/mcp-servers/[serverId]/tools/discover/route.ts
- apps/runtime/src/services/mcp/inline-mcp-provider.ts
- apps/runtime/src/services/mcp/runtime-mcp-provider.ts
- packages/database/src/models/mcp-server-config.model.ts
- packages/database/src/models/project-tool.model.ts
- packages/database/src/models/tool-secret.model.ts

## 5. Level 5: Verification, Controls, and Acceptance Depth

### 5.1 Verification Assets

- Test artifacts in scope: 6
  - apps/runtime/src/tools/**tests**/attachment-tool-executor.test.ts
  - apps/studio/src/components/tools/**tests**/DynamicToolInputForm.test.tsx
  - apps/studio/src/components/tools/**tests**/HttpConfigForm.test.ts
  - apps/studio/src/components/tools/**tests**/McpConfigForm.test.ts
  - apps/studio/src/components/tools/**tests**/SandboxConfigForm.test.ts
  - apps/studio/src/components/tools/**tests**/tool-utils.test.ts

### 5.2 5-Level Scenario Chains (Explicit)

#### Scenario 1: Tool definition to runtime execution

- Level 1 (Outcome): Deliver Agent Tools Platform business value.
- Level 2 (Domain): Execute within mapped subdomains (apps/studio, packages/shared, apps/runtime).
- Level 3 (Flow): Realize workflow stage "Tool definition to runtime execution" through route/service orchestration.
- Level 4 (Implementation): Use artifacts such as apps/studio/src, packages/shared/src, apps/runtime/src.
- Level 5 (Verification): Validate with tests and controls from apps/runtime/src/tools/**tests**/attachment-tool-executor.test.ts, apps/studio/src/components/tools/**tests**/DynamicToolInputForm.test.tsx, apps/studio/src/components/tools/**tests**/HttpConfigForm.test.ts.

#### Scenario 2: MCP tool discovery and test

- Level 1 (Outcome): Deliver Agent Tools Platform business value.
- Level 2 (Domain): Execute within mapped subdomains (apps/studio, packages/shared, apps/runtime).
- Level 3 (Flow): Realize workflow stage "MCP tool discovery and test" through route/service orchestration.
- Level 4 (Implementation): Use artifacts such as apps/runtime/src, packages/database/src, packages/compiler/src.
- Level 5 (Verification): Validate with tests and controls from apps/studio/src/components/tools/**tests**/HttpConfigForm.test.ts, apps/studio/src/components/tools/**tests**/McpConfigForm.test.ts, apps/studio/src/components/tools/**tests**/SandboxConfigForm.test.ts.

#### Scenario 3: Tool secret resolution path

- Level 1 (Outcome): Deliver Agent Tools Platform business value.
- Level 2 (Domain): Execute within mapped subdomains (apps/studio, packages/shared, apps/runtime).
- Level 3 (Flow): Realize workflow stage "Tool secret resolution path" through route/service orchestration.
- Level 4 (Implementation): Use artifacts such as packages/compiler/src, apps/runtime/src/routes/tool-secrets.ts, apps/studio/src/app/api/projects/[id]/mcp-servers/[serverId]/route.ts.
- Level 5 (Verification): Validate with tests and controls from apps/studio/src/components/tools/**tests**/SandboxConfigForm.test.ts, apps/studio/src/components/tools/**tests**/tool-utils.test.ts.

### 5.3 Acceptance Criteria (Deep)

- AC-001: All mapped code paths for F005 are represented in this feature's decomposition.
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

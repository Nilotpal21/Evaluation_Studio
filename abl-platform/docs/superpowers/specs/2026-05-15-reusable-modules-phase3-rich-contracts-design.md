# Reusable Modules — Phase 3: Rich Contracts, Detail Pages & Tool Testing

**Status:** DRAFT
**Date:** 2026-05-15
**Parent Feature:** [Reusable Agent Modules](../../features/reusable-agent-modules.md) (BETA)
**Depends on:** Phase 2.5 (consumption fix & UX completion)
**Scope:** Enrich module contracts with full metadata, reuse existing detail pages in read-only mode, enable tool testing for imported tools
**Owner:** Platform team

---

## 1. Problem Statement

Phase 2.5 delivered functional imported module support across all UI surfaces. However, the detail panels show minimal information because the contract snapshot only stores `{ name, description? }` for agents and `{ name, toolType }` for tools. Users cannot:

- See what tools an imported agent uses, what it hands off to, or its execution mode
- See imported tool parameters, return types, endpoint patterns, or auth requirements
- Test imported tools to verify they work with the consumer project's credentials
- View imported agents/tools in the same rich detail layout as local ones

## 2. Goals

- Enrich the module release contract at publish time with full agent and tool metadata
- Render imported agents and tools using the **same detail pages** as local assets, in read-only mode
- Enable tool testing for imported tools against the live module release with consumer credentials
- No new detail page components — reuse `AgentDetailPage`/`AgentEditorPage` and `ToolDetailPage` with a `readOnly` flag

## 3. Non-Goals

- Data-field mapping DSL (deferred)
- Namespace binding UX (deferred)
- Tenant-admin curated catalog (deferred)
- Cross-tenant module sharing
- Editing imported module assets from the consumer project

---

## 4. Enriched Contract Schema

### 4.1 Current Contract Shape

```typescript
type ModuleReleaseContract = {
  providedAgents: Array<{ name: string; description?: string }>;
  providedTools: Array<{ name: string; toolType: string }>;
  requiredConfigKeys: Array<{ key: string; isSecret: boolean }>;
  requiredEnvVars: Array<{ name: string }>;
  requiredSecrets?: Array<{ key: string; referencedBy: string[]; toolName?: string }>;
  requiredAuthProfiles: Array<{ name: string; referencedBy: string[] }>;
  requiredConnectors: Array<{ name: string }>;
  requiredMcpServers: Array<{ name: string }>;
  warnings: string[];
};
```

### 4.2 Enriched Contract Shape

```typescript
type ModuleReleaseContract = {
  providedAgents: Array<{
    name: string;
    description?: string;
    // NEW fields
    mode?: string; // 'reasoning' | 'flow' | 'hybrid' | 'scripted'
    tools?: string[]; // tool names this agent uses
    handoffTargets?: string[]; // agent names this agent hands off to
    delegateTargets?: string[]; // agent names this agent delegates to
    hasGather?: boolean; // whether the agent has gather fields
    hasFlow?: boolean; // whether the agent has deterministic flow steps
  }>;

  providedTools: Array<{
    name: string;
    toolType: string;
    // NEW fields
    description?: string;
    parameters?: Array<{
      name: string;
      type: string;
      required: boolean;
      description?: string;
    }>;
    returnType?: string;
    endpoint?: string; // URL pattern with {{env.*}} templates preserved
    method?: string; // HTTP method (GET, POST, etc.)
    authProfileRef?: string; // required auth profile name
    requiredEnvVars?: string[]; // env vars specifically needed by this tool
  }>;

  // Existing fields unchanged
  providedBehaviorProfiles?: Array<{ name: string }>;
  requiredConfigKeys: Array<{ key: string; description?: string; isSecret: boolean }>;
  requiredEnvVars: Array<{ name: string; description?: string }>;
  requiredSecrets?: Array<{
    key: string;
    description?: string;
    referencedBy: string[];
    toolName?: string;
  }>;
  requiredAuthProfiles: Array<{ name: string; referencedBy: string[] }>;
  requiredConnectors: Array<{ name: string }>;
  requiredMcpServers: Array<{ name: string }>;
  warnings: string[];
};
```

### 4.3 Backward Compatibility

New fields are all optional. Existing releases with the old contract shape continue to work — the UI renders "Not available" for missing fields. New releases published after this change include the enriched data.

### 4.4 Contract Extraction Changes

**File:** `packages/project-io/src/module-release/module-contract.ts`

The `extractModuleReleaseContract()` function already receives compiled IR for each agent and parsed tool definitions. The changes:

**For agents:** After compilation, read from each agent's IR:

- `mode` from `AgentIR.execution.mode`
- `tools` from `AgentIR.tools[].name`
- `handoffTargets` from `AgentIR.coordination.handoffs[].to`
- `delegateTargets` from `AgentIR.coordination.delegates[].agent`
- `hasGather` from `AgentIR.gather.fields.length > 0`
- `hasFlow` from `AgentIR.flow !== undefined`

**For tools:** Read from the tool definition (DSL-parsed or materialized):

- `description` from tool DSL `description:` field
- `parameters` from parsed signature line (already available via `parseSignatureLine`)
- `returnType` from parsed signature
- `endpoint` from `http_binding.url` (preserving `{{env.*}}` templates)
- `method` from `http_binding.method`
- `authProfileRef` from `auth_profile_ref`
- `requiredEnvVars` by scanning the tool DSL for `{{env.KEY}}` patterns

---

## 5. Read-Only Detail Pages

### 5.1 Approach

Reuse the existing `AgentEditorPage` (or `AgentDetailPage`) and `ToolDetailPage` components by adding a `readOnly` mode. When an imported agent or tool is opened, the same page renders with:

- All form inputs disabled / non-editable
- Edit, delete, duplicate, save, discard buttons hidden
- A provenance banner at the top showing module name, alias, version
- Data loaded from the module release artifact instead of `ProjectAgent`/`ProjectTool` collections

### 5.2 Navigation Routes

**Imported agent detail:**

```
/projects/:projectId/agents/imported/:alias/:agentName
```

Example: `/projects/abc/agents/imported/benefits/coverage_agent`

**Imported tool detail:**

```
/projects/:projectId/tools/imported/:alias/:toolName
```

Example: `/projects/abc/tools/imported/benefits/check_coverage`

### 5.3 Data Loading

When navigating to an imported agent/tool route:

1. Parse `alias` and `agentName`/`toolName` from the URL
2. Load the `ProjectModuleDependency` by `alias` for the current project
3. Load the `ModuleRelease` by `dependency.resolvedReleaseId`
4. For agents: extract the agent's DSL from `release.artifact.agents[agentName]`, compile to IR
5. For tools: extract the tool definition from `release.artifact.tools[toolName]`
6. Pass the data to the existing detail page component with `readOnly={true}`

### 5.4 Agent Detail in Read-Only Mode

**Changes to `AgentEditorPage` / `AgentDetailPage`:**

- Add `readOnly?: boolean` prop
- Add `moduleProvenance?: { alias: string; moduleProjectName: string; version: string }` prop
- When `readOnly`:
  - Render a provenance banner: "📦 Imported from {moduleName} ({alias}) v{version} · Read-only"
  - All section editors render with inputs disabled
  - Hide: Save/Discard buttons, Delete button, Version management
  - Keep: "Chat with Agent" button (works via working-copy resolution from Phase 2.5)
  - Keep: DSL tab (read-only code view)
  - Keep: All collapsible sections (Identity, Tools, Gather, Flow, Constraints, Coordination, Behavior, Lifecycle, Execution) — all populated from the compiled IR

### 5.5 Tool Detail in Read-Only Mode

**Changes to `ToolDetailPage`:**

- Add `readOnly?: boolean` prop
- Add `moduleProvenance?: { alias: string; moduleProjectName: string; version: string }` prop
- When `readOnly`:
  - Render provenance banner
  - Configuration tab: form rendered with all inputs disabled
  - Testing tab: **still functional** — "Run Test" button works (see Section 6)
  - Hide: Save/Discard, Edit name, Delete, Duplicate, Export
  - Keep: Copy Name button, Testing tab

### 5.6 AppShell Routing

Add route handling in `AppShell.tsx`:

```typescript
// Imported agent detail
if (page === 'agents' && subPage?.startsWith('imported/')) {
  const [, alias, agentName] = subPage.split('/');
  return <ImportedAgentDetailLoader alias={alias} agentName={agentName} projectId={projectId} />;
}

// Imported tool detail
if (page === 'tools' && subPage?.startsWith('imported/')) {
  const [, alias, toolName] = subPage.split('/');
  return <ImportedToolDetailLoader alias={alias} toolName={toolName} projectId={projectId} />;
}
```

The loader components (`ImportedAgentDetailLoader`, `ImportedToolDetailLoader`) handle:

- Loading dependency and release data
- Compiling agent DSL / extracting tool definition
- Passing data to the existing detail page with `readOnly={true}`

---

## 6. Tool Testing for Imported Tools

### 6.1 Test Flow

1. User opens imported tool detail → Testing tab
2. Clicks "Run Test"
3. `TestToolDialog` opens with auto-generated input form (from enriched contract parameters)
4. User fills in test input (or uses auto-generated dummy data)
5. Clicks "Execute"
6. API resolves tool binding from module release, applies consumer auth/env, executes
7. Response shown in the same result display (output, request/response inspector, errors)

### 6.2 API Endpoint

```
POST /api/projects/:projectId/module-tools/:dependencyId/:toolName/test
Body: { input: Record<string, unknown> }
Response: ToolTestResult (same shape as local tool test)
```

### 6.3 Server-Side Resolution

**New service method in `apps/studio/src/services/tool-test-service.ts`:**

```typescript
async function testImportedModuleTool(params: {
  projectId: string;
  tenantId: string;
  dependencyId: string;
  toolName: string;
  input: Record<string, unknown>;
  userId: string;
}): Promise<ToolTestResult> {
  // 1. Load dependency → release
  const dependency = await ProjectModuleDependency.findOne({
    _id: params.dependencyId,
    projectId: params.projectId,
    tenantId: params.tenantId,
  });
  const release = await ModuleRelease.findOne({ _id: dependency.resolvedReleaseId });

  // 2. Extract tool definition from release artifact
  const toolData = release.artifact.tools[params.toolName];
  const toolDefinition = toolData.definition ?? materializeFromDSL(toolData);

  // 3. Resolve consumer bindings
  //    - Auth profiles from consumer project
  //    - Env vars from consumer project
  //    - Config overrides from dependency.configOverrides
  const resolvedBinding = await resolveToolBinding({
    toolDefinition,
    projectId: params.projectId,
    tenantId: params.tenantId,
    configOverrides: dependency.configOverrides,
  });

  // 4. Execute using existing tool test infrastructure
  return executeToolTest(resolvedBinding, params.input);
}
```

### 6.4 Input Schema Generation

The enriched contract provides tool parameters. The existing `buildInputSchemaFromTool()` function is extended to accept the contract parameter format:

```typescript
function buildInputSchemaFromContractTool(contractTool: EnrichedProvidedTool): JSONSchema {
  return {
    type: 'object',
    properties: Object.fromEntries(
      (contractTool.parameters ?? []).map((p) => [
        p.name,
        { type: p.type, description: p.description },
      ]),
    ),
    required: (contractTool.parameters ?? []).filter((p) => p.required).map((p) => p.name),
  };
}
```

---

## 7. Updated useImportedSymbols Hook

The hook types are updated to include the enriched fields:

```typescript
export interface ImportedAgent {
  name: string;
  alias: string;
  moduleProjectName: string;
  dependencyId: string;
  description?: string;
  resolvedVersion?: string;
  // NEW from enriched contract
  mode?: string;
  tools?: string[];
  handoffTargets?: string[];
  delegateTargets?: string[];
  hasGather?: boolean;
  hasFlow?: boolean;
}

export interface ImportedTool {
  name: string;
  alias: string;
  moduleProjectName: string;
  dependencyId: string;
  description?: string;
  toolType?: string;
  resolvedVersion?: string;
  // NEW from enriched contract
  parameters?: Array<{ name: string; type: string; required: boolean; description?: string }>;
  returnType?: string;
  endpoint?: string;
  method?: string;
  authProfileRef?: string;
  requiredEnvVars?: string[];
}
```

---

## 8. Affected Files

### Contract Enrichment

| File                                                        | Change                                              |
| ----------------------------------------------------------- | --------------------------------------------------- |
| `packages/database/src/models/module-release.model.ts`      | Extend `ModuleReleaseContract` type with new fields |
| `packages/project-io/src/module-release/module-contract.ts` | Extract enriched metadata from IR and tool DSL      |
| `packages/project-io/src/__tests__/module-contract.test.ts` | Test enriched extraction                            |

### Read-Only Detail Pages

| File                                                              | Change                                                     |
| ----------------------------------------------------------------- | ---------------------------------------------------------- |
| `apps/studio/src/components/agents/AgentEditorPage.tsx`           | Add `readOnly` prop, disable editing when set              |
| `apps/studio/src/components/agents/AgentDetailPage.tsx`           | Add `readOnly` prop, provenance banner                     |
| `apps/studio/src/components/tools/ToolDetailPage.tsx`             | Add `readOnly` prop, provenance banner, keep Testing tab   |
| `apps/studio/src/components/agents/ImportedAgentDetailLoader.tsx` | New: loads release data, renders AgentEditorPage read-only |
| `apps/studio/src/components/tools/ImportedToolDetailLoader.tsx`   | New: loads release data, renders ToolDetailPage read-only  |
| `apps/studio/src/components/navigation/AppShell.tsx`              | Route imported agent/tool detail paths                     |
| `apps/studio/src/components/agents/AgentListPage.tsx`             | Card onClick navigates to imported detail route            |
| `apps/studio/src/components/tools/ToolsListPage.tsx`              | Card onClick navigates to imported detail route            |

### All Section Editors (read-only support)

Each section editor in `apps/studio/src/components/agent-editor/sections/` and `apps/studio/src/components/agent-detail/` needs to respect a `readOnly` prop:

| File                                            | Change                                         |
| ----------------------------------------------- | ---------------------------------------------- |
| `agent-editor/sections/ToolsEditor.tsx`         | Disable tool add/remove/edit when readOnly     |
| `agent-editor/sections/HandoffsEditor.tsx`      | Disable handoff add/remove/edit when readOnly  |
| `agent-editor/sections/DelegatesEditor.tsx`     | Disable delegate add/remove/edit when readOnly |
| `agent-editor/sections/GatherEditor.tsx`        | Disable field editing when readOnly            |
| `agent-editor/sections/FlowEditor.tsx`          | Disable step editing when readOnly             |
| `agent-editor/sections/OnStartEditor.tsx`       | Disable editing when readOnly                  |
| `agent-editor/sections/CompletionEditor.tsx`    | Disable editing when readOnly                  |
| `agent-editor/sections/ErrorHandlingEditor.tsx` | Disable editing when readOnly                  |
| `agent-editor/sections/EscalationEditor.tsx`    | Disable editing when readOnly                  |
| `agent-editor/sections/BehaviorEditor.tsx`      | Disable editing when readOnly                  |
| `agent-detail/ToolsSection.tsx`                 | Disable when readOnly                          |
| `agent-detail/CoordinationSection.tsx`          | Disable when readOnly                          |
| `tools/sections/HttpConfigForm.tsx`             | Disable when readOnly                          |
| `tools/sections/SandboxConfigForm.tsx`          | Disable when readOnly                          |
| `tools/sections/McpConfigForm.tsx`              | Disable when readOnly                          |

### Tool Testing

| File                                                                                         | Change                                                    |
| -------------------------------------------------------------------------------------------- | --------------------------------------------------------- |
| `apps/studio/src/app/api/projects/[id]/module-tools/[dependencyId]/[toolName]/test/route.ts` | New: test endpoint for imported tools                     |
| `apps/studio/src/services/tool-test-service.ts`                                              | Add `testImportedModuleTool()` method                     |
| `apps/studio/src/components/tools/tool-utils.ts`                                             | Extend `buildInputSchemaFromTool` for contract parameters |

### Hook & Types

| File                                          | Change                                  |
| --------------------------------------------- | --------------------------------------- |
| `apps/studio/src/hooks/useImportedSymbols.ts` | Extend interfaces with enriched fields  |
| `apps/studio/src/api/modules.ts`              | Update types to match enriched contract |

---

## 9. Implementation Priority

| Priority | Item                                      | Rationale                                 |
| -------- | ----------------------------------------- | ----------------------------------------- |
| P0       | Contract enrichment (4.4)                 | Everything else depends on this data      |
| P0       | DB type update (4.2)                      | Schema must match before contract builder |
| P1       | Read-only mode on detail pages (5.4, 5.5) | Core UX improvement                       |
| P1       | Data loaders + routing (5.6)              | Navigation to imported detail             |
| P1       | Section editor readOnly props             | All sections need this for detail pages   |
| P1       | Tool testing API + service (6.2, 6.3)     | Key user workflow                         |
| P2       | Input schema from contract (6.4)          | Better test UX                            |
| P2       | Updated hook types (7)                    | Enriched data in cards/lists              |
| P3       | Card updates to show mode/tool count      | Polish                                    |

---

## 10. Open Questions

| #   | Question                                                                                               | Default If Unanswered            |
| --- | ------------------------------------------------------------------------------------------------------ | -------------------------------- |
| 1   | Should "Chat with Agent" work for imported agents in read-only detail?                                 | Yes, via working-copy resolution |
| 2   | Should tool testing show a warning that results may differ from deployed behavior?                     | Yes, subtle info banner          |
| 3   | Should the tool test use the consumer's default variable namespace or the module's stripped namespace? | Consumer's default namespace     |
| 4   | Maximum parameter count before the test input form switches to JSON-only mode?                         | 20 parameters                    |

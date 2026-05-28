# Reusable Modules Phase 3 — Rich Contracts, Detail Pages & Tool Testing Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Enrich module contracts with full metadata at publish time, reuse existing detail pages in read-only mode for imported agents/tools, and enable tool testing for imported module tools.

**Architecture:** Three layers: (1) Contract enrichment at publish-time extracts agent mode/tools/handoffs and tool parameters/endpoint/auth from compiled IR. (2) Read-only detail pages reuse AgentDetailPage and ToolDetailPage with a readOnly prop, loaded from module release artifacts via new loader components. (3) Tool testing resolves imported tool bindings from release artifacts and executes with consumer credentials.

**Tech Stack:** TypeScript, Mongoose (database types), React/Next.js (Studio), Vitest (tests)

**Spec:** `docs/superpowers/specs/2026-05-15-reusable-modules-phase3-rich-contracts-design.md`

---

## Task 1: Extend ModuleReleaseContract Type

**Goal:** Add new optional metadata fields to the `ModuleReleaseContract` type for both `providedAgents` and `providedTools`, maintaining full backward compatibility.

**Files to modify:**

- `packages/database/src/models/module-release.model.ts`

**Steps:**

- [ ] Read `packages/database/src/models/module-release.model.ts` to confirm current `ModuleReleaseContract` shape
- [ ] Extend `providedAgents` array element type with new optional fields:
  ```typescript
  providedAgents: Array<{
    name: string;
    description?: string;
    // NEW
    mode?: string;
    tools?: string[];
    handoffTargets?: string[];
    delegateTargets?: string[];
    hasGather?: boolean;
    hasFlow?: boolean;
  }>;
  ```
- [ ] Extend `providedTools` array element type with new optional fields:
  ```typescript
  providedTools: Array<{
    name: string;
    toolType: string;
    // NEW
    description?: string;
    parameters?: Array<{
      name: string;
      type: string;
      required: boolean;
      description?: string;
    }>;
    returnType?: string;
    endpoint?: string;
    method?: string;
    authProfileRef?: string;
    requiredEnvVars?: string[];
  }>;
  ```
- [ ] Verify all new fields are optional (no breaking changes to existing releases)
- [ ] Run `pnpm build --filter=@agent-platform/database` to confirm type compatibility
- [ ] Run `npx prettier --write packages/database/src/models/module-release.model.ts`

**Tests:**

- [ ] Create `packages/database/src/__tests__/module-release-contract-compat.test.ts`
- [ ] Test that an object matching the OLD shape still satisfies `ModuleReleaseContract` (assign to typed variable, no TS errors)
- [ ] Test that an object with ALL new fields satisfies `ModuleReleaseContract`
- [ ] Test that an object with a MIX of old and new fields satisfies `ModuleReleaseContract`
- [ ] Run `pnpm test --filter=@agent-platform/database`

**Commit:** `[ABLP-1051] feat(database): extend ModuleReleaseContract with enriched agent and tool metadata fields`

---

## Task 2: Enrich Contract Extraction

**Goal:** Extend `extractModuleContract()` to populate the new metadata fields from compiled IR and tool definitions.

**Files to modify:**

- `packages/project-io/src/module-release/module-contract.ts`

**Steps:**

- [ ] Read `packages/project-io/src/module-release/module-contract.ts` — current `ContractAgentInput` and `ContractToolInput` interfaces, `extractModuleContract` function
- [ ] Extend `ContractAgentInput` with an optional `compiledIR` field:
  ```typescript
  export interface ContractAgentInput {
    name: string;
    description?: string | null;
    dslContent: string;
    compiledIR?: Record<string, unknown>; // NEW — compiled AgentIR
  }
  ```
- [ ] Extend `ContractToolInput` with an optional `definition` field:
  ```typescript
  export interface ContractToolInput {
    name: string;
    toolType: string;
    dslContent: string;
    definition?: Record<string, unknown>; // NEW — materialized tool definition
  }
  ```
- [ ] In the `providedAgents` mapping (line ~185), when `compiledIR` is present, extract:
  - `mode` from `compiledIR.execution?.mode` (cast as `Record<string, unknown>`)
  - `tools` from `compiledIR.tools` (extract `name` from each tool entry in the array)
  - `handoffTargets` from `compiledIR.coordination?.handoffs` (extract `to` from each entry)
  - `delegateTargets` from `compiledIR.coordination?.delegates` (extract `agent` from each entry)
  - `hasGather` from whether `compiledIR.gather?.fields` is a non-empty array
  - `hasFlow` from whether `compiledIR.flow` is defined (not null/undefined)
- [ ] In the `providedTools` mapping (line ~194), when `definition` is present, extract:
  - `description` from `definition.description`
  - `parameters` from `definition.parameters` (map each to `{ name, type, required, description? }`)
  - `returnType` from `definition.returns?.type` as string
  - `endpoint` from `definition.http_binding?.endpoint`
  - `method` from `definition.http_binding?.method`
  - `authProfileRef` from `definition.auth_profile_ref`
  - `requiredEnvVars` by scanning dslContent for `{{env.KEY}}` patterns (reuse `extractEnvVarReferences`)
- [ ] Use safe optional chaining throughout — all IR fields may be missing
- [ ] Run `pnpm build --filter=@abl/project-io` to confirm types
- [ ] Run `npx prettier --write packages/project-io/src/module-release/module-contract.ts`

**Tests:**

- [ ] Create or extend `packages/project-io/src/__tests__/module-contract.test.ts`
- [ ] Test: agent with `compiledIR` populates `mode`, `tools`, `handoffTargets`, `delegateTargets`, `hasGather`, `hasFlow`
- [ ] Test: agent WITHOUT `compiledIR` only has `name` and `description` (backward compat)
- [ ] Test: tool with `definition` populates `description`, `parameters`, `returnType`, `endpoint`, `method`, `authProfileRef`, `requiredEnvVars`
- [ ] Test: tool WITHOUT `definition` only has `name` and `toolType` (backward compat)
- [ ] Run tests: `pnpm test --filter=@abl/project-io`

**Commit:** `[ABLP-1051] feat(project-io): enrich contract extraction with agent IR and tool definition metadata`

---

## Task 3: Pass Compiled IR to Contract Extraction

**Goal:** Wire the `buildModuleRelease` pipeline to pass compiled IR and materialized tool definitions into the contract extraction step.

**Files to modify:**

- `packages/project-io/src/module-release/build-module-release.ts`

**Steps:**

- [ ] Read `packages/project-io/src/module-release/build-module-release.ts` — focus on Step 8 (contract extraction, lines ~274-287)
- [ ] Read the `ExtractContractFn` type alias (line ~61-65) — note it currently takes `Array<{ name, description?, dslContent }>` for agents and `Array<{ name, toolType, dslContent }>` for tools
- [ ] Update `ExtractContractFn` to include the new optional fields:
  ```typescript
  export type ExtractContractFn = (
    agents: Array<{
      name: string;
      description?: string | null;
      dslContent: string;
      compiledIR?: Record<string, unknown>;
    }>,
    tools: Array<{
      name: string;
      toolType: string;
      dslContent: string;
      definition?: Record<string, unknown>;
    }>,
    profiles?: Array<{ name: string; dslContent: string }>,
  ) => ModuleReleaseContract;
  ```
- [ ] In Step 8, modify `contractAgents` to include compiled IR from the `compiledIR` map:
  ```typescript
  const contractAgents = Object.entries(input.agents).map(([name, dslContent]) => ({
    name,
    dslContent,
    ...(compiledIR[name] ? { compiledIR: compiledIR[name] } : {}),
  }));
  ```
- [ ] Modify `contractTools` to include materialized definition from `artifactTools`:
  ```typescript
  const contractTools = Object.entries(input.tools).map(([name, def]) => ({
    name,
    toolType: def.toolType,
    dslContent: def.dslContent,
    ...(artifactTools[name]?.definition ? { definition: artifactTools[name].definition } : {}),
  }));
  ```
- [ ] Run `pnpm build --filter=@abl/project-io` to confirm no type errors
- [ ] Run `npx prettier --write packages/project-io/src/module-release/build-module-release.ts`

**Tests:**

- [ ] Extend existing `build-module-release` tests to verify that the contract output now includes enriched fields when IR is available
- [ ] Verify backward compat: when `compileFn` returns minimal IR, new fields are simply absent
- [ ] Run `pnpm test --filter=@abl/project-io`

**Commit:** `[ABLP-1051] feat(project-io): pass compiled IR and tool definitions to contract extraction in build pipeline`

---

## Task 4: Update useImportedSymbols with Enriched Fields

**Goal:** Extend the `ImportedAgent` and `ImportedTool` interfaces and populate them from enriched contract snapshots.

**Files to modify:**

- `apps/studio/src/hooks/useImportedSymbols.ts`

**Steps:**

- [ ] Read `apps/studio/src/hooks/useImportedSymbols.ts` — current interfaces and mapping logic
- [ ] Read `apps/studio/src/store/module-store.ts` to understand the `dependencies` shape and `contractSnapshot` structure
- [ ] Extend `ImportedAgent` interface:
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
  ```
- [ ] Extend `ImportedTool` interface:
  ```typescript
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
- [ ] In the agent mapping loop, extract new fields from `agent` (the contract entry) using optional chaining:
  ```typescript
  agents.push({
    name: agent.name,
    alias: dep.alias,
    moduleProjectName: dep.moduleProjectName,
    dependencyId: dep.id,
    description: agent.description || undefined,
    resolvedVersion: dep.resolvedVersion || undefined,
    mode: (agent as any).mode || undefined,
    tools: (agent as any).tools || undefined,
    handoffTargets: (agent as any).handoffTargets || undefined,
    delegateTargets: (agent as any).delegateTargets || undefined,
    hasGather: (agent as any).hasGather,
    hasFlow: (agent as any).hasFlow,
  });
  ```
  Note: Cast to `any` is acceptable here because the contract snapshot is `Schema.Types.Mixed` in Mongoose. Alternatively, define a local type for the enriched contract shape.
- [ ] Similarly for tool mapping, extract `parameters`, `returnType`, `endpoint`, `method`, `authProfileRef`, `requiredEnvVars`
- [ ] Run `pnpm build --filter=studio` to confirm
- [ ] Run `npx prettier --write apps/studio/src/hooks/useImportedSymbols.ts`

**Tests:**

- [ ] The hook is tested via component integration (no separate unit test needed for a memo-only hook)
- [ ] Verify manually that existing consumers (`ImportedAgentCard`, `ImportedToolCard`, etc.) still compile

**Commit:** `[ABLP-1051] feat(studio): extend ImportedAgent and ImportedTool interfaces with enriched contract fields`

---

## Task 5: Create ImportedAgentDetailLoader

**Goal:** Create a loader component that fetches module release data, compiles agent DSL to IR, and renders the existing AgentDetailPage in read-only mode.

**Files to create:**

- `apps/studio/src/components/agents/ImportedAgentDetailLoader.tsx`

**Steps:**

- [ ] Read `apps/studio/src/components/agents/AgentDetailPage.tsx` to understand its props and data flow (uses `useAgentIR()`, `useAgentDetailStore`, `useNavigationStore`)
- [ ] Read the module store to understand how to load dependency and release data
- [ ] Read `apps/studio/src/api/modules.ts` for available API functions to fetch module release data
- [ ] Create `ImportedAgentDetailLoader.tsx` with props:
  ```typescript
  interface ImportedAgentDetailLoaderProps {
    alias: string;
    agentName: string;
    projectId: string;
  }
  ```
- [ ] Implementation:
  - Use `useModuleStore` to find dependency by alias
  - Use SWR to fetch the module release by `dependency.resolvedReleaseId`
  - Extract agent DSL from `release.artifact.agents[agentName].dslContent`
  - Extract provenance info: `{ alias, moduleProjectName: dependency.moduleProjectName, version: release.version }`
  - Render `AgentDetailPage` (or the appropriate component) with `readOnly={true}` and `moduleProvenance` props
  - Show loading skeleton while fetching
  - Show error state if dependency/release/agent not found
- [ ] Use `useTranslations` for all user-visible strings
- [ ] Run `pnpm build --filter=studio` to confirm
- [ ] Run `npx prettier --write apps/studio/src/components/agents/ImportedAgentDetailLoader.tsx`

**Note:** This task depends on Task 7 (adding `readOnly` prop to AgentDetailPage). Implementation order may need to be adjusted — create the loader first with a TODO for the readOnly integration, then wire it after Task 7.

**Commit:** `[ABLP-1051] feat(studio): create ImportedAgentDetailLoader component for read-only imported agent view`

---

## Task 6: Create ImportedToolDetailLoader

**Goal:** Create a loader component that fetches module release tool data and renders the existing ToolDetailPage in read-only mode.

**Files to create:**

- `apps/studio/src/components/tools/ImportedToolDetailLoader.tsx`

**Steps:**

- [ ] Read `apps/studio/src/components/tools/ToolDetailPage.tsx` to understand its data flow (uses `useNavigationStore` `subPage` for toolId, `fetchTool` API, `useToolStore`)
- [ ] Create `ImportedToolDetailLoader.tsx` with props:
  ```typescript
  interface ImportedToolDetailLoaderProps {
    alias: string;
    toolName: string;
    projectId: string;
  }
  ```
- [ ] Implementation:
  - Use `useModuleStore` to find dependency by alias
  - Use SWR to fetch the module release by `dependency.resolvedReleaseId`
  - Extract tool data from `release.artifact.tools[toolName]` (includes `dslContent`, `toolType`, `definition`)
  - Extract provenance info: `{ alias, moduleProjectName, version }`
  - Extract enriched contract data for the tool from `release.contract.providedTools.find(t => t.name === toolName)`
  - Render `ToolDetailPage` with `readOnly={true}` and `moduleProvenance` props
  - Pass `dependencyId` for tool testing integration (Task 9)
  - Show loading/error states
- [ ] Use `useTranslations` for all user-visible strings
- [ ] Run `pnpm build --filter=studio` to confirm
- [ ] Run `npx prettier --write apps/studio/src/components/tools/ImportedToolDetailLoader.tsx`

**Note:** Like Task 5, depends on Task 7 for the readOnly prop integration.

**Commit:** `[ABLP-1051] feat(studio): create ImportedToolDetailLoader component for read-only imported tool view`

---

## Task 7: Add readOnly Prop to Detail Pages

**Goal:** Add `readOnly` and `moduleProvenance` props to AgentDetailPage and ToolDetailPage. When `readOnly` is true, disable all editing controls and show a provenance banner.

**Files to modify:**

- `apps/studio/src/components/agents/AgentDetailPage.tsx`
- `apps/studio/src/components/tools/ToolDetailPage.tsx`

**Steps:**

### AgentDetailPage

- [ ] Read full `AgentDetailPage.tsx` to understand all interactive elements (buttons, editors, save/discard)
- [ ] Add props interface:
  ```typescript
  interface AgentDetailPageProps {
    readOnly?: boolean;
    moduleProvenance?: {
      alias: string;
      moduleProjectName: string;
      version: string;
    };
    // Any existing props (if the component currently takes no props, these are new)
  }
  ```
- [ ] Add provenance banner at the top when `moduleProvenance` is provided:
  - Use an info banner style: "Imported from {moduleProjectName} ({alias}) v{version} — Read-only"
  - Use `useTranslations('agents.imported')` for i18n
- [ ] When `readOnly`:
  - Hide Save/Discard buttons
  - Hide Delete button
  - Hide version management controls
  - Disable all section editor inputs (pass `readOnly` or `disabled` to child section components)
  - Keep "Chat with Agent" button (works via working-copy resolution)
  - Keep DSL tab in read-only code view mode
  - Keep all collapsible sections visible and populated
- [ ] Add i18n keys to `packages/i18n/locales/en/studio.json` under `agents.imported`

### ToolDetailPage

- [ ] Read full `ToolDetailPage.tsx` — currently takes no props, reads toolId from navigation store
- [ ] Since `ToolDetailPage` currently reads `toolId` from `useNavigationStore().subPage`, the readOnly mode needs an alternative data source. Options:
  - (A) Accept optional props for pre-loaded tool data + readOnly flag
  - (B) Use a shared context/store to inject the tool data before rendering
  - Recommended: option (A) — add optional props:
  ```typescript
  interface ToolDetailPageProps {
    readOnly?: boolean;
    moduleProvenance?: {
      alias: string;
      moduleProjectName: string;
      version: string;
    };
    importedToolData?: {
      name: string;
      toolType: string;
      dslContent: string;
      definition?: Record<string, unknown>;
      dependencyId: string;
    };
  }
  ```
- [ ] When `readOnly`:
  - Show provenance banner
  - Configuration tab: all form inputs disabled
  - Testing tab: STILL FUNCTIONAL (see Task 9)
  - Hide Save/Discard, Delete, Duplicate, Export, Edit name buttons
  - Keep Copy Name button
- [ ] Add i18n keys to `packages/i18n/locales/en/studio.json` under `tools.imported`
- [ ] Run `pnpm build --filter=studio` to confirm
- [ ] Run `npx prettier --write` on both files

**Tests:**

- [ ] Verify existing agent detail and tool detail pages still work normally when `readOnly` is not passed
- [ ] Verify the provenance banner renders when `moduleProvenance` is provided
- [ ] Verify all editing controls are hidden/disabled when `readOnly={true}`

**Commit:** `[ABLP-1051] feat(studio): add readOnly mode and provenance banner to AgentDetailPage and ToolDetailPage`

---

## Task 8: Wire Routing in AppShell

**Goal:** Add routes for imported agent/tool detail pages and update list page card click handlers to navigate to them.

**Files to modify:**

- `apps/studio/src/components/navigation/AppShell.tsx`
- `apps/studio/src/components/agents/AgentListPage.tsx`
- `apps/studio/src/components/tools/ToolsListPage.tsx`

**Steps:**

### AppShell routing

- [ ] Read `AppShell.tsx` `renderContent()` function — understand the `page`/`subPage`/`tab` routing pattern
- [ ] Add imports for the new loader components:
  ```typescript
  import { ImportedAgentDetailLoader } from '../agents/ImportedAgentDetailLoader';
  import { ImportedToolDetailLoader } from '../tools/ImportedToolDetailLoader';
  ```
- [ ] In the `agents` case of `renderContent()`, BEFORE the existing `subPage` handling (which falls through to AgentEditorPage), add:
  ```typescript
  // Imported agent detail: /projects/:id/agents/imported/:alias/:agentName
  if (subPage?.startsWith('imported/')) {
    const parts = subPage.split('/');
    const alias = parts[1];
    const agentName = parts[2];
    if (alias && agentName && projectId) {
      return <ImportedAgentDetailLoader alias={alias} agentName={agentName} projectId={projectId} />;
    }
  }
  ```
  This MUST come before the general `subPage` handling to avoid the imported route being caught by `AgentEditorPage`
- [ ] In the `tools` case, add BEFORE the existing `subPage` handling:
  ```typescript
  // Imported tool detail: /projects/:id/tools/imported/:alias/:toolName
  if (subPage?.startsWith('imported/')) {
    const parts = subPage.split('/');
    const alias = parts[1];
    const toolName = parts[2];
    if (alias && toolName && projectId) {
      return <ImportedToolDetailLoader alias={alias} toolName={toolName} projectId={projectId} />;
    }
  }
  ```
  This MUST come before `if (subPage === 'new')` and `if (subPage)` checks

### AgentListPage card navigation

- [ ] Read `AgentListPage.tsx` — find the `ImportedAgentCard` onClick handler (currently `() => setSelectedImportedAgent(agent)` which opens a detail panel)
- [ ] Change the onClick to navigate to the imported detail route:
  ```typescript
  onClick={() => navigate(`/projects/${projectId}/agents/imported/${agent.alias}/${agent.name}`)}
  ```
- [ ] Remove or keep the `ImportedAgentDetailPanel` as a fallback — the panel can remain for quick-peek but the card should navigate to the full detail page
- [ ] Alternatively, keep the panel open on click and add a "View Details" button in the panel that navigates

### ToolsListPage card navigation

- [ ] Read `ToolsListPage.tsx` — find the `ImportedToolCard` onClick handler (currently `() => setSelectedImportedTool(tool)`)
- [ ] Change the onClick to navigate to the imported detail route:

  ```typescript
  onClick={() => navigate(`/projects/${projectId}/tools/imported/${tool.alias}/${tool.name}`)}
  ```

- [ ] Run `pnpm build --filter=studio` to confirm
- [ ] Run `npx prettier --write` on all three files

**Tests:**

- [ ] Manually verify: clicking an imported agent card navigates to `/projects/:id/agents/imported/:alias/:name`
- [ ] Manually verify: clicking an imported tool card navigates to `/projects/:id/tools/imported/:alias/:name`
- [ ] Verify the back button from the detail page returns to the list

**Commit:** `[ABLP-1051] feat(studio): wire imported agent and tool detail routes in AppShell and update card navigation`

---

## Task 9: Tool Testing API for Imported Tools

**Goal:** Create a new API route and service method to test imported module tools using consumer project credentials.

**Files to create:**

- `apps/studio/src/app/api/projects/[id]/module-tools/[dependencyId]/[toolName]/test/route.ts`

**Files to modify:**

- `apps/studio/src/services/tool-test-service.ts`

**Steps:**

### API Route

- [ ] Read the existing tool test route at `apps/studio/src/app/api/projects/[id]/tools/[toolId]/test/route.ts` for the pattern
- [ ] Create the new route file following the same pattern:

  ```typescript
  // POST /api/projects/:id/module-tools/:dependencyId/:toolName/test
  import { z } from 'zod';
  import { executeImportedToolTest } from '@/services/tool-test-service';
  import { withRouteHandler } from '@/lib/route-handler';
  import { successJson, errorJson, ErrorCode } from '@/lib/api-response';
  import { StudioPermission } from '@/lib/permissions';

  const TestToolSchema = z.object({
    input: z.record(z.unknown()).optional(),
    timeoutMs: z.number().int().min(1000).max(300_000).optional(),
  });

  export const POST = withRouteHandler(
    {
      requireProject: true,
      permissions: StudioPermission.TOOL_EXECUTE,
      rateLimit: { limit: 10, windowMs: 60_000, scope: 'user' },
      sanitizeResponse: { redactHeaders: true, maxBodySize: 100_000 },
      bodySchema: TestToolSchema,
    },
    async ({ body, tenantId, user, params }) => {
      const result = await executeImportedToolTest({
        dependencyId: params.dependencyId,
        toolName: params.toolName,
        tenantId,
        userId: user.id,
        projectId: params.id,
        input: body.input,
        timeoutMs: body.timeoutMs,
      });

      if (result.errorCode === ErrorCode.NOT_FOUND) {
        return errorJson('Tool not found in module release', 404, ErrorCode.NOT_FOUND);
      }

      return successJson('result', result);
    },
  );
  ```

### Service Method

- [ ] Read `apps/studio/src/services/tool-test-service.ts` — understand `executeToolTest`, `buildToolDefinition`, `createSecretsProvider` patterns
- [ ] Add new exported function `executeImportedToolTest`:

  ```typescript
  export interface ImportedToolTestInput {
    dependencyId: string;
    toolName: string;
    tenantId: string;
    userId: string;
    projectId: string;
    input?: Record<string, unknown>;
    timeoutMs?: number;
  }

  export async function executeImportedToolTest(
    params: ImportedToolTestInput,
  ): Promise<ToolTestOutput> {
    // 1. Load ProjectModuleDependency by _id + projectId + tenantId
    // 2. Load ModuleRelease by dependency.resolvedReleaseId
    // 3. Extract tool from release.artifact.tools[params.toolName]
    // 4. Build ToolDefinition from tool.dslContent and tool.toolType
    //    (reuse existing buildToolDefinition helper)
    // 5. Resolve consumer project's variable namespaces (default namespace)
    // 6. Create secrets provider scoped to consumer project
    // 7. Execute using same ToolBindingExecutor pattern as executeToolTest
    // 8. Return ToolTestOutput in same format
  }
  ```

- [ ] Import the necessary models:
  ```typescript
  const { ProjectModuleDependency, ModuleRelease } =
    await import('@agent-platform/database/models');
  ```
- [ ] Use `findOne({ _id: params.dependencyId, projectId: params.projectId, tenantId: params.tenantId })` for dependency lookup (tenant isolation)
- [ ] Use `findOne({ _id: dependency.resolvedReleaseId, tenantId: params.tenantId })` for release lookup
- [ ] Reuse existing `buildToolDefinition`, `createSecretsProvider`, `ToolBindingExecutor` infrastructure
- [ ] Handle errors: dependency not found, release not found, tool not found in artifact, execution errors
- [ ] Run `pnpm build --filter=studio` to confirm
- [ ] Run `npx prettier --write` on both files

### Wire into ToolDetailPage Testing tab

- [ ] In `ToolDetailPage.tsx` (or `ImportedToolDetailLoader.tsx`), when `readOnly` is true and the Testing tab is active:
  - Use the imported tool test endpoint instead of the local tool test endpoint
  - Pass `dependencyId` and `toolName` to the test API call
  - The `TestToolDialog` and `ToolTestingSection` components should work unchanged — only the API call URL changes
- [ ] Add an API client function in `apps/studio/src/api/tools.ts` or `apps/studio/src/api/modules.ts`:
  ```typescript
  export async function testImportedTool(
    projectId: string,
    dependencyId: string,
    toolName: string,
    input?: Record<string, unknown>,
  ): Promise<{ result: ToolTestResult }> {
    // POST /api/projects/:projectId/module-tools/:dependencyId/:toolName/test
  }
  ```

**Tests:**

- [ ] Create `apps/studio/src/services/__tests__/tool-test-service-imported.test.ts`
- [ ] Test: dependency not found returns NOT_FOUND
- [ ] Test: release not found returns appropriate error
- [ ] Test: tool not found in artifact returns NOT_FOUND
- [ ] Test: successful execution returns ToolTestOutput shape
- [ ] Run `pnpm test --filter=studio`

**Commit:** `[ABLP-1051] feat(studio): add tool testing API and service for imported module tools`

---

## Dependency Graph

```
Task 1 (DB types)
  └─> Task 2 (contract extraction)
        └─> Task 3 (build pipeline wiring)

Task 4 (useImportedSymbols) — independent, can parallel with Tasks 1-3

Task 7 (readOnly props on detail pages) — independent
  └─> Task 5 (ImportedAgentDetailLoader)
  └─> Task 6 (ImportedToolDetailLoader)
        └─> Task 8 (AppShell routing + card navigation)
              └─> Task 9 (tool testing API) — depends on Tasks 6, 8

Parallel groups:
  Group A: Tasks 1 → 2 → 3 (backend contract enrichment)
  Group B: Task 4 (hook types)
  Group C: Task 7 → Tasks 5, 6 → Task 8 → Task 9 (frontend detail pages)
```

---

## Verification Checklist

After all tasks are complete:

- [ ] `pnpm build --filter=@agent-platform/database` passes
- [ ] `pnpm build --filter=@abl/project-io` passes
- [ ] `pnpm build --filter=studio` passes
- [ ] `pnpm test --filter=@agent-platform/database` passes
- [ ] `pnpm test --filter=@abl/project-io` passes
- [ ] Existing module publish flow still works (no regression)
- [ ] Navigating to an imported agent shows read-only detail page with provenance banner
- [ ] Navigating to an imported tool shows read-only detail page with Testing tab functional
- [ ] Tool testing for imported tools executes against consumer project credentials
- [ ] All new/modified files formatted with prettier

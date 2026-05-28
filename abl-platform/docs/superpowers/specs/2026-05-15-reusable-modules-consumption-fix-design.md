# Reusable Modules — Consumption Fix & UX Completion

**Status:** DRAFT
**Date:** 2026-05-15
**Parent Feature:** [Reusable Agent Modules](../../features/reusable-agent-modules.md) (BETA)
**Scope:** Phase 2.5 — fix broken runtime, fill all UI/UX gaps for consuming imported modules
**Owner:** Platform team

---

## 1. Problem Statement

Reusable Agent Modules shipped Phase 1 (core lifecycle) and Phase 2 (upgrade workflows, reverse deps, deletion guards). However, the **consumer-side experience is broken or incomplete** across three areas:

### Runtime Bugs

1. **Imported tools invisible at runtime.** `materializeModuleResolvedTools` in `runtime-executor.ts:923-959` only enriches tool stubs already present in the consumer agent's IR `tools` array. Since imported tools are read-only/use-only (no DSL stubs), they are silently dropped. The tool never reaches `ToolBindingExecutor` and the LLM never sees it.

2. **Working-copy/preview mode ignores modules.** `resolveWorkingCopy` in `deployment-resolver.ts:710-825` (Strategy 3) never calls `mergeModuleSnapshot`. Module agents and tools are completely absent in dev/preview sessions. Authors cannot test consumer agents before deploying.

3. **`variable_namespace_ids` not stripped.** `deepRewriteIR` in `module-alias-rewriter.ts:346-501` does not remove source-project namespace IDs from module tool definitions. These IDs reference namespaces that don't exist in the consumer project, breaking env var resolution for imported tools.

### UI Surfaces Missing Imported Module Support

Five major surfaces have zero awareness of imported module assets:

| Surface                  | File                              | Impact                                                                 |
| ------------------------ | --------------------------------- | ---------------------------------------------------------------------- |
| AgentListPage            | `agents/AgentListPage.tsx`        | Users can't see imported agents from the main agents page              |
| ToolsListPage            | `tools/ToolsListPage.tsx`         | Users can't see imported tools from the main tools page                |
| ToolPickerModal (new)    | `abl/pickers/ToolPickerModal.tsx` | Regression: new picker lacks support the legacy `ToolPickerDialog` has |
| ToolsSection (attach UI) | `agent-detail/ToolsSection.tsx`   | Can't attach imported tools to agents via structured UI                |
| DSL editor completions   | `abl/ABLEditor.tsx:247-401`       | No autocomplete for imported agent/tool names in Monaco                |

### UX Gaps

- No agent picker dialog for selecting imported agents as handoff/delegate targets (CoordinationSection is display-only)
- No post-import config override editing (only available during initial import)
- `ImportModuleDialog` uses native `<select>` elements (design system violation)
- Module store `loadReleases` never fetches environment promotion pointers

---

## 2. Goals

- Every imported module agent and tool is visible and usable across all relevant Studio surfaces
- Imported tools execute correctly at runtime in both deployed and working-copy/preview sessions
- Consumer authors can discover, select, and reference imported assets without manual typing
- Post-import configuration is editable without remove-and-reimport
- All surfaces use consistent read-only provenance UI patterns

## 3. Non-Goals

- Phase 3 features (data-field mapping DSL, namespace binding UX, tenant-admin curated catalog)
- Cross-tenant module sharing
- Transitive module dependencies
- New DSL import syntax
- Reusable workflows, channels, search indexes

---

## 4. Runtime Fixes

### 4.1 Inject Module Tools Into Consumer Agent IR

**File:** `apps/runtime/src/services/runtime-executor.ts` — `materializeModuleResolvedTools`

**Current behavior:** Iterates each agent's existing `tools` array and enriches tools whose name matches a key in `resolvedTools`. Tools not already in the array are ignored.

**Fix:** After the enrichment loop, scan each agent's IR for module tool references (in `flow.definitions[*].call`, `reasoning_zone.available_tools`, `tools[*].name`, and handoff context). For any referenced tool name that matches a key in `resolvedTools` but is not present in the agent's `tools` array, **inject the full tool definition** from `resolvedTools`.

Additionally, for module agents loaded from the snapshot (those with `_moduleProvenance`), inject any `resolvedTools` entry whose alias prefix matches the agent's own alias. This ensures a module agent's own tools are always wired, even if the snapshot IR had stubs.

```typescript
// After existing enrichment loop:
for (const agent of Object.values(agents)) {
  if (!agent?.tools) agent.tools = [];
  const existingNames = new Set(agent.tools.map((t) => t.name));

  // Collect referenced tool names from flow steps, reasoning zones, etc.
  const referencedTools = collectToolReferences(agent);

  for (const [toolName, resolvedTool] of Object.entries(resolvedTools)) {
    if (existingNames.has(toolName)) continue;

    // Inject if: (a) explicitly referenced, or (b) same alias as this module agent
    const agentAlias = (agent as any)._moduleProvenance?.alias;
    const toolAlias = toolName.split('__')[0];
    if (referencedTools.has(toolName) || (agentAlias && agentAlias === toolAlias)) {
      // Clone resolved tool as a full ToolDefinition (no stub merge needed — this is a fresh injection)
      agent.tools.push({ ...resolvedTool } as ToolDefinition);
      existingNames.add(toolName);
    }
  }
}
```

**Applies to:** Both deployment path (`createSessionFromResolved`) and working-copy path (after Section 4.2 merge).

### 4.2 Working-Copy Module Resolution

**File:** `apps/runtime/src/services/deployment-resolver.ts` — `resolveWorkingCopy`

**Current behavior:** Compiles consumer project agents from live DSL, resolves local project tools, returns `ResolvedAgent` with no module awareness.

**Fix:** After compiling the working copy, check for module dependencies and merge them:

```
1. Query ProjectModuleDependency.find({ projectId, tenantId })
2. For each dependency:
   a. Load ModuleRelease by resolvedReleaseId
   b. Recompile module agent DSL with consumer configOverrides
   c. Run alias rewriter (same as deployment-build-service)
   d. Merge rewritten agents into result.agents and result.compilationOutput.agents
   e. Merge rewritten tools into result.resolvedTools
3. Attach _workingCopyModuleWarning: true to result
```

**Caching:** Cache the resolved module bundle in Redis keyed by `module:wc:{projectId}:{moduleDependencyVersion}` with 60s TTL. Invalidate when any dependency is added, removed, upgraded, or config overrides change (all of which bump `Project.moduleDependencyVersion`).

**Error handling:** If module resolution fails (release not found, compilation error), log a warning and continue without modules. The session should still work for local agents — module failures should not block the entire preview. Surface the error via a `moduleDiagnostics` field on the session response.

### 4.3 Strip `variable_namespace_ids` in Alias Rewriter

**File:** `apps/runtime/src/services/modules/module-alias-rewriter.ts` — `deepRewriteIR`

Add a step that removes `variable_namespace_ids` from every tool definition in the rewritten IR:

```typescript
// In deepRewriteIR, after existing tool name rewriting:
for (const tool of agent.tools ?? []) {
  if ('variable_namespace_ids' in tool) {
    delete (tool as Record<string, unknown>).variable_namespace_ids;
  }
}
```

This enforces the Phase 1 policy: imported tools mount into the consumer project's default namespace only.

### 4.4 E2E Test Coverage

**File:** `apps/runtime/src/__tests__/tools-deployment/module-tool-execution.integration.test.ts` (new)

End-to-end test covering the full tool execution path:

1. Create module project with an HTTP tool (`lookup_plan`) that has endpoint, method, and auth profile ref
2. Publish module release
3. Create consumer project, import module with alias `benefits`
4. Consumer agent DSL references `benefits__lookup_plan` (via flow step or tool list)
5. Deploy consumer project
6. Create session, send message that triggers tool call
7. Verify: tool appears in LLM tool list, tool call executes with correct HTTP binding, response is returned
8. Repeat steps 5-7 via working-copy preview (no deployment) to verify Section 4.2

---

## 5. UI Surface Changes

### 5.1 Cross-Cutting UI Patterns

All imported assets across all surfaces use these consistent patterns:

| Pattern                | Implementation                                                                                        |
| ---------------------- | ----------------------------------------------------------------------------------------------------- |
| **Module badge**       | Purple `Package` icon + "Imported" text label                                                         |
| **Lock icon**          | `Lock` icon next to name, indicates read-only                                                         |
| **Provenance tooltip** | Hover shows: "From module: {moduleName} ({alias}) v{version}"                                         |
| **Grouped by alias**   | Assets grouped under alias heading when multiple modules imported                                     |
| **Search-inclusive**   | Imported assets included in search/filter results                                                     |
| **Display name**       | User-facing: `alias.symbolname` (dot separator). Runtime/DSL: `alias__symbolname` (double underscore) |
| **Read-only callout**  | Footer banner: "Read-only module asset. Edit in the source project."                                  |

### 5.2 AgentListPage — Imported Agents Section

**File:** `apps/studio/src/components/agents/AgentListPage.tsx`

Add a read-only "Imported Agents" section below the local agent card grid:

```
─── IMPORTED AGENTS (3) ────────────────────────
📦 benefits (Benefits Queries v1.2)
  🔒 benefits.coverage_agent — Looks up plan coverage details
  🔒 benefits.triage_agent — Routes benefits questions

📦 idv (Identity Verification v2.0)
  🔒 idv.verify_agent — Runs ID verification flow
```

**Behavior:**

- Only renders when `useImportedSymbols().agents.length > 0`
- Each row is clickable → opens `ImportedAgentDetail` flyout (Section 5.8)
- Section is collapsible, default expanded
- Included in the page's search/filter
- Agent count in page header includes imported agents: "Agents (5 local, 3 imported)"

### 5.3 ToolsListPage — Imported Tools Section

**File:** `apps/studio/src/components/tools/ToolsListPage.tsx`

Add a read-only "Imported Tools" section below the local tool tabs:

```
─── IMPORTED TOOLS (4) ─────────────────────────
📦 benefits (Benefits Queries v1.2)
  🔒 benefits.plan_lookup          HTTP
  🔒 benefits.formulary_search     HTTP
  🔒 benefits.coverage_check       HTTP

📦 idv (Identity Verification v2.0)
  🔒 idv.document_scan             HTTP
```

**Behavior:**

- Only renders when `useImportedSymbols().tools.length > 0`
- Each row is clickable → opens `ImportedToolDetail` flyout (Section 5.8)
- Section is collapsible, default expanded
- Included in search/filter
- Tool count in page header includes imported: "Tools (8 local, 4 imported)"

### 5.4 ToolPickerModal — Imported Tab

**File:** `apps/studio/src/components/abl/pickers/ToolPickerModal.tsx`

Add an "Imported" tab alongside existing All/HTTP/MCP/Sandbox/SearchAI tabs:

**Tab bar:** `[All] [HTTP] [MCP] [Sandbox] [SearchAI] [Imported]`

**Imported tab contents:**

- Tools grouped by module alias with module name and version header
- Each tool row: lock icon, `alias.toolname`, tool type badge, [+] insert button
- Preview pane on the right shows: tool description, parameters, return type, source module provenance
- Imported tools also appear in the "All" tab, visually distinguished by module badge

**Insert behavior:** Same as legacy `ToolPickerDialog` — calls `buildImportedToolReferenceSnippet(alias, name)` and passes to `onInsert`. Uses `insertSnippetIntelligently()` for section-aware placement.

**Data source:** `useImportedSymbols().tools`

### 5.5 ToolsSection — Imported Tools Group

**File:** `apps/studio/src/components/agent-detail/ToolsSection.tsx`

Add an "Imported Tools" collapsible group below the existing "Project Tools" group:

```
TOOLS (3 local, 2 imported)
├ 🔧 get_account_balance     HTTP    [Edit] [Remove]
├ 🔧 send_notification       HTTP    [Edit] [Remove]
├ 🔧 search_knowledge        SearchAI [Edit] [Remove]
│
├─ IMPORTED TOOLS ──────────────────────────
├ 📦🔒 benefits.plan_lookup       HTTP    [Add]
└ 📦🔒 benefits.formulary_search  HTTP    [Add]
```

**Behavior:**

- Shows all available imported tools from `useImportedSymbols().tools`
- [Add] attaches the imported tool reference to the agent's tool list as a read-only entry
- Once added, the tool appears in the agent's tools with module badge and a [Remove] action (detach only, not delete)
- The imported tool definition itself is never editable
- Expanding an added imported tool shows its parameters and description (read-only)

### 5.6 AgentPickerDialog (New Component)

**File:** `apps/studio/src/components/abl/pickers/AgentPickerDialog.tsx` (new)

A modal dialog for selecting agents as handoff/delegate targets.

**Trigger points:**

- CoordinationSection → "Add Handoff" → browse button on `to:` field
- CoordinationSection → "Add Delegate" → browse button on `agent:` field
- DSL editor → `/handoff` or `/delegate` slash command

**Layout:**

```
┌──────────────────────────────────────────────┐
│  Select Agent                           [X]  │
│──────────────────────────────────────────────│
│  🔍 Search agents...                         │
│──────────────────────────────────────────────│
│  PROJECT AGENTS                          (3) │
│  ┌──────────────────────────────────────────┐│
│  │ 🤖 billing_agent                        ││
│  │    Handles billing inquiries             ││
│  ├──────────────────────────────────────────┤│
│  │ 🤖 support_agent                        ││
│  │    General support triage                ││
│  ├──────────────────────────────────────────┤│
│  │ 🤖 escalation_agent                     ││
│  │    Handles escalated cases               ││
│  └──────────────────────────────────────────┘│
│                                              │
│  IMPORTED MODULES                        (2) │
│  ┌──────────────────────────────────────────┐│
│  │ 📦 benefits (Benefits Queries v1.2)      ││
│  │  ├ 🔒 benefits.coverage_agent            ││
│  │  │    Looks up plan coverage details     ││
│  │  └ 🔒 benefits.triage_agent              ││
│  │       Routes benefits questions          ││
│  ├──────────────────────────────────────────┤│
│  │ 📦 idv (Identity Verification v2.0)      ││
│  │  └ 🔒 idv.verify_agent                   ││
│  │       Runs ID verification flow          ││
│  └──────────────────────────────────────────┘│
│──────────────────────────────────────────────│
│                           [Cancel] [Select]  │
└──────────────────────────────────────────────┘
```

**Behavior:**

- Single-select — click highlights, "Select" confirms
- Local agents: robot icon, no badge
- Imported agents: lock icon, purple "Imported" badge, grouped by module alias with version
- Display name: `alias.agentname` (dot, user-facing)
- Selection returns: `alias__agentname` (double underscore, runtime form) for insertion into DSL or coordination config
- Search filters across both sections
- Data: local agents from `/api/projects/{id}/agents`, imported from `useImportedSymbols().agents`

### 5.7 DSL Editor Completions

**File:** `apps/studio/src/components/abl/ABLEditor.tsx` (lines 247-401)

**Current state:** `availableTools` fetched from `fetchTools(projectId)` (local only). `availableAgents` merged from local + external agents. No imported symbols.

**Fix:** Add imported symbols to the completion context:

```typescript
// In the completion provider setup, after existing tool/agent loading:
// Import the hook data (passed via ref or store subscription since this is in a callback)
const { agents: importedAgents, tools: importedTools } = getImportedSymbols();

availableTools.push(
  ...importedTools.map((t) => ({
    name: `${t.alias}__${t.name}`,
    type: t.toolType ?? 'http',
    description: `[Imported: ${t.moduleProjectName}] ${t.description ?? ''}`,
  })),
);

availableAgents.push(
  ...importedAgents.map((a) => ({
    name: `${a.alias}__${a.name}`,
    description: `[Imported: ${a.moduleProjectName}] ${a.description ?? ''}`,
  })),
);
```

Since `useImportedSymbols` is a React hook and the completion provider runs in a Monaco callback, the imported symbols should be read from the module store directly (via `useModuleStore.getState().dependencies`) or passed through a ref that updates when the store changes.

**Result:** Typing `ben` in a TOOLS section suggests `benefits__plan_lookup`. Typing `ben` on a `to:` line suggests `benefits__coverage_agent`. The `[Imported: ...]` prefix in the autocomplete description distinguishes module symbols from local ones.

### 5.8 Read-Only Detail Flyouts

**Files:**

- `apps/studio/src/components/modules/ImportedAgentDetail.tsx` (new)
- `apps/studio/src/components/modules/ImportedToolDetail.tsx` (new)

Slide-over panels opened when clicking an imported agent/tool from the AgentListPage, ToolsListPage, or any imported row.

**Imported Agent Detail:**

- Header: module badge + `alias.agentname` + lock icon
- Provenance card: module name, alias, version, pin type (version/environment)
- Description section
- Tools used: list of tools this agent references
- Handoffs: list of agents this agent hands off to
- Configuration: required config keys from contract
- Footer: "Read-only module asset. Edit in the source project."

**Imported Tool Detail:**

- Header: module badge + `alias.toolname` + lock icon + tool type badge
- Provenance card: module name, alias, version
- Description section
- Parameters: name, type, required/optional for each
- Returns: return type
- Required credentials: auth profiles, env vars from contract
- Footer: "Read-only module asset. Edit in the source project."

**Data source:** Derived from the dependency's `contractSnapshot` (already loaded in module store). No additional API calls needed. For richer detail (full parameter specs), the `ModuleRelease.artifact` can be fetched on-demand via `GET /api/projects/:id/module/releases/:releaseId`.

---

## 6. UX Improvements

### 6.1 EditModuleConfigDialog

**File:** `apps/studio/src/components/modules/EditModuleConfigDialog.tsx` (new)

Accessible from a gear icon on each dependency row in `ModuleDependencyList`.

**Layout:**

```
┌──────────────────────────────────────────┐
│  Edit Module Configuration          [X]  │
│──────────────────────────────────────────│
│  Module: Benefits Queries (benefits)     │
│  Version: 1.2.0                          │
│──────────────────────────────────────────│
│  REQUIRED CONFIG KEYS                    │
│  ┌──────────────────────────────────────┐│
│  │ Key               │ Value            ││
│  ├───────────────────┼──────────────────┤│
│  │ PLAN_API_BASE_URL │ https://api...   ││
│  │ DEFAULT_LANGUAGE   │ en-US           ││
│  └───────────────────┴──────────────────┘│
│                                          │
│  ADDITIONAL OVERRIDES              [+Add]│
│  ┌──────────────────────────────────────┐│
│  │ Key          │ Value           [🗑]  ││
│  ├──────────────┼─────────────────┤     ││
│  │ MAX_RESULTS  │ 50              [🗑]  ││
│  └──────────────┴─────────────────┘     ││
│                                          │
│  ⚠ Secrets cannot be set here. Use      │
│    environment variables or auth         │
│    profiles for credentials.             │
│──────────────────────────────────────────│
│                        [Cancel] [Save]   │
└──────────────────────────────────────────┘
```

**Behavior:**

- "Required Config Keys" section: shows keys from the module contract with current values from `configOverrides`. Editable.
- "Additional Overrides" section: free-form key-value pairs not in the contract. Add/remove.
- Save calls `PATCH /api/projects/:id/module-dependencies/:depId` with updated `configOverrides`
- Validation: existing config override validation (no secrets, size limits, no injection patterns)
- On save success: refreshes dependency list, bumps `moduleDependencyVersion` (invalidates working-copy cache)

### 6.2 ImportModuleDialog Design System Fix

**File:** `apps/studio/src/components/modules/ImportModuleDialog.tsx` (lines 238-256, 300-319)

Replace native `<select>` elements with `<Select>` from `components/ui/Select.tsx`. Two instances:

1. Module selection dropdown (step 1)
2. Version/environment selector (step 1)

### 6.3 Module Store Pointers Fix

**File:** `apps/studio/src/store/module-store.ts` (line 131)

`loadReleases` always sets `pointers: []`. Wire up the actual API fetch:

```typescript
// In loadReleases, after fetching releases:
const pointersResponse = await fetchModulePointers(projectId);
set({ releases, pointers: pointersResponse.pointers, releasesLoading: false });
```

This requires a new API client function `fetchModulePointers(projectId)` that calls the existing promote/pointer endpoint to read current pointer state. The PublishModuleDialog and ModuleSettingsPage will then correctly show which release is promoted to each environment.

---

## 7. Working-Copy Preview Banner

When a consumer project session is created via working-copy resolution (not a deployment), and module dependencies were merged per Section 4.2, the Studio preview UI should display a non-blocking info banner:

```
ℹ Module assets resolved from pinned dependency — deploy to freeze a stable snapshot.
```

This banner appears in the preview chat area, similar to existing "Working copy — not deployed" indicators. It communicates that:

- Module tools and agents are functional in preview
- The resolved versions are from the current dependency pins, not a frozen deployment snapshot
- Deploying will create an immutable snapshot for production stability

---

## 8. Affected Files Summary

### Runtime (apps/runtime)

| File                                                                       | Change                                                              |
| -------------------------------------------------------------------------- | ------------------------------------------------------------------- |
| `src/services/runtime-executor.ts`                                         | Fix `materializeModuleResolvedTools` to inject missing module tools |
| `src/services/deployment-resolver.ts`                                      | Add module resolution to `resolveWorkingCopy`                       |
| `src/services/modules/module-alias-rewriter.ts`                            | Strip `variable_namespace_ids` in `deepRewriteIR`                   |
| `src/__tests__/tools-deployment/module-tool-execution.integration.test.ts` | New integration test for module tool execution                      |

### Studio (apps/studio)

| File                                                  | Change                                            |
| ----------------------------------------------------- | ------------------------------------------------- |
| `src/components/agents/AgentListPage.tsx`             | Add imported agents section                       |
| `src/components/tools/ToolsListPage.tsx`              | Add imported tools section                        |
| `src/components/abl/pickers/ToolPickerModal.tsx`      | Add Imported tab with module tools                |
| `src/components/abl/pickers/AgentPickerDialog.tsx`    | New agent picker dialog                           |
| `src/components/agent-detail/ToolsSection.tsx`        | Add imported tools group                          |
| `src/components/agent-detail/CoordinationSection.tsx` | Wire AgentPickerDialog to handoff/delegate fields |
| `src/components/abl/ABLEditor.tsx`                    | Add imported symbols to completion context        |
| `src/components/modules/ImportedAgentDetail.tsx`      | New read-only agent detail flyout                 |
| `src/components/modules/ImportedToolDetail.tsx`       | New read-only tool detail flyout                  |
| `src/components/modules/EditModuleConfigDialog.tsx`   | New config override editor                        |
| `src/components/modules/ModuleDependencyList.tsx`     | Add gear icon for config editing                  |
| `src/components/modules/ImportModuleDialog.tsx`       | Replace native `<select>` with `<Select>`         |
| `src/store/module-store.ts`                           | Fix pointer loading in `loadReleases`             |
| `src/api/modules.ts`                                  | Add `fetchModulePointers` client function         |

### Tests

| File                                                                                    | Type        |
| --------------------------------------------------------------------------------------- | ----------- |
| `apps/runtime/src/__tests__/tools-deployment/module-tool-execution.integration.test.ts` | Integration |
| `apps/runtime/src/__tests__/tools-deployment/module-working-copy.e2e.test.ts`           | E2E         |
| `apps/studio/src/__tests__/components/agent-picker-dialog.test.tsx`                     | Unit        |
| `apps/studio/src/__tests__/components/tool-picker-modal-imported.test.tsx`              | Unit        |
| `apps/studio/src/__tests__/components/agent-list-imported.test.tsx`                     | Unit        |
| `apps/studio/src/__tests__/components/tools-list-imported.test.tsx`                     | Unit        |
| `apps/studio/src/__tests__/components/tools-section-imported.test.tsx`                  | Unit        |
| `apps/studio/src/__tests__/components/edit-module-config.test.tsx`                      | Unit        |
| `apps/studio/src/__tests__/components/imported-agent-detail.test.tsx`                   | Unit        |
| `apps/studio/src/__tests__/components/imported-tool-detail.test.tsx`                    | Unit        |

---

## 9. Implementation Priority

Ordered by impact and dependency:

| Priority | Item                                           | Rationale                                        |
| -------- | ---------------------------------------------- | ------------------------------------------------ |
| P0       | 4.1 Inject module tools into consumer agent IR | Core bug — tools invisible without this          |
| P0       | 4.3 Strip `variable_namespace_ids`             | Core bug — env vars broken without this          |
| P0       | 4.2 Working-copy module resolution             | Authors can't test before deploying              |
| P1       | 5.6 AgentPickerDialog                          | Unblocks practical use of imported agents        |
| P1       | 5.4 ToolPickerModal imported tab               | Regression fix — new picker lacks legacy feature |
| P1       | 5.5 ToolsSection imported tools group          | Unblocks structured tool attachment              |
| P1       | 5.7 DSL editor completions                     | Major discoverability gap                        |
| P2       | 5.2 AgentListPage imported section             | Visibility/discoverability                       |
| P2       | 5.3 ToolsListPage imported section             | Visibility/discoverability                       |
| P2       | 5.8 Read-only detail flyouts                   | Rich inspection of imported assets               |
| P2       | 6.1 EditModuleConfigDialog                     | Post-import config editing                       |
| P3       | 6.2 ImportModuleDialog design system fix       | Polish                                           |
| P3       | 6.3 Module store pointers fix                  | Polish                                           |
| P3       | 7 Working-copy preview banner                  | Polish                                           |

---

## 10. Open Questions

| #   | Question                                                                                                                                                                  | Default If Unanswered                     |
| --- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------- |
| 1   | Should the AgentPickerDialog also be available inline in the DSL editor (e.g., via a gutter icon on `to:` lines), or only through CoordinationSection and slash commands? | CoordinationSection + slash commands only |
| 2   | When working-copy module resolution fails (release deleted, compilation error), should the preview session fail entirely or proceed without modules?                      | Proceed without modules, show diagnostic  |
| 3   | Should imported tools in ToolsSection auto-expand to show parameters, or stay collapsed?                                                                                  | Collapsed, expandable on click            |
| 4   | Maximum number of imported symbols before the AgentListPage/ToolsListPage sections switch to paginated display?                                                           | 50 symbols, then paginate                 |

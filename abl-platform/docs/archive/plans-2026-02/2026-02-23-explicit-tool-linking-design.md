# Explicit Tool Linking in ABL — `USE TOOL` Design

**Date:** 2026-02-23
**Status:** Draft
**Branch:** tools-enhancements

---

## Problem Statement

Tools enter an agent from three sources today:

| Source              | DSL Syntax                                  | Resolution                                                                             |
| ------------------- | ------------------------------------------- | -------------------------------------------------------------------------------------- |
| Inline definition   | `name(params) -> return` with properties    | Compiled directly into IR                                                              |
| File import         | `FROM "./path.tools.abl" USE: name1, name2` | Resolved from `.tools.abl` file at compile time                                        |
| DB tools (implicit) | _None — silently auto-injected_             | `loadProjectToolsAsIR()` merges ALL project DB tools at compile time, deduping by name |

**Problems with implicit DB tool injection:**

1. Agent authors cannot see which DB tools their agent uses — tools appear invisibly
2. No way to pin a specific tool version — always resolves to latest published
3. No explicit declaration means no compile-time validation of tool availability
4. All project tools are injected regardless of relevance — pollutes the agent's tool list
5. Name-based dedup is silent — a DB tool with the same name as a DSL tool is quietly dropped
6. `sourceHash` cannot detect when a DB tool changes because tools aren't part of the agent's declared surface

---

## Design: `USE TOOL` Syntax

### 1. DSL Grammar

```
TOOLS:
  # Existing: inline tool definition
  format_results(hotels: Hotel[]) -> string
    description: "Format results"

  # Existing: file import
  FROM "./tools/hotels-api.tools.abl" USE: search_hotels, get_hotel

  # New: explicit DB tool linking
  USE TOOL: get_weather                      # latest published version
  USE TOOL: calculate_risk@v2                # pinned to version name "v2"
  USE TOOL: sentiment_analyzer AS analyze    # aliased (exposed as "analyze" in agent)
  USE TOOL: send_email@v1 AS notify          # pinned + aliased
```

**Formal grammar:**

```
tool_link     ::= "USE TOOL:" WS slug version_pin? alias?
slug          ::= [a-z][a-z0-9_]*
version_pin   ::= "@" version_name
version_name  ::= [a-z0-9][a-z0-9._-]*       # matches ToolVersion.versionName pattern
alias         ::= WS "AS" WS identifier
identifier    ::= [a-z][a-z0-9_]*
```

**Constraints:**

- Slug must be lowercase alphanumeric + underscores (matches `computeSlug()` output)
- Mixed-case slugs are rejected at parse time with a clear error
- `@draft` is rejected at parse time: `"E703: Cannot pin to 'draft' — use a named version"`
- Alias must not collide with system tool names (`__handoff__`, `__delegate__`, `__escalate__`, `__complete__`)

### 2. IR Tool Name Resolution

**Decision: The slug is the IR tool name when no alias is provided.**

| Declaration                        | IR `ToolDefinition.name` | Rationale                                                   |
| ---------------------------------- | ------------------------ | ----------------------------------------------------------- |
| `USE TOOL: get_weather`            | `get_weather`            | Matches what the author wrote; usable in `CALL:` steps      |
| `USE TOOL: get_weather AS weather` | `weather`                | Alias overrides                                             |
| `USE TOOL: sentiment_analyzer@v2`  | `sentiment_analyzer`     | Slug, not `Tool.name` (which might be "Sentiment Analyzer") |

This means `CALL: get_weather` in flow steps, `COMPLETE: WHEN: get_weather.result != null`, and gather references all use the slug (or alias). The DB tool's display name (`Tool.name`) is metadata only — it does not leak into the IR.

### 3. AST Changes (`@abl/core`)

New type in `packages/core/src/types/agent-based.ts`:

```typescript
/** A reference to a DB-managed tool, parsed from USE TOOL: syntax */
interface ToolLink {
  slug: string; // DB tool slug (lowercase, underscores)
  versionPin: string | null; // 'v2' from @v2, null = latest published
  alias: string | null; // 'analyze' from AS analyze, null = use slug
}
```

Extended `AgentBasedDocument`:

```typescript
interface AgentBasedDocument {
  // ... existing fields
  tools: AgentTool[]; // inline-defined tools
  toolImports?: ToolImport[]; // FROM "file" USE: ...
  toolLinks?: ToolLink[]; // USE TOOL: ... (new)
}
```

### 4. Parser Changes (`agent-based-parser.ts`)

In `parseTools()`, add a match **before** the inline tool signature match:

```
/^USE\s+TOOL:\s*([a-z][a-z0-9_]*)(?:@([a-z0-9][a-z0-9._-]*))?(?:\s+AS\s+([a-z][a-z0-9_]*))?$/
```

Captures: `slug`, optional `versionPin`, optional `alias`.

**Parse-time validations:**

- Slug must match `[a-z][a-z0-9_]*` — reject with error if not
- `@draft` rejected: `"E703: Cannot pin to 'draft' — create a named version first"`
- Duplicate slug in same agent: `"E706: Duplicate USE TOOL declaration for 'slug'"`

### 5. Compilation Architecture

**Key constraint:** `@abl/compiler` cannot depend on `@agent-platform/shared` (shared depends on compiler — reverse would create circular dependency). Therefore:

- The **compiler** never touches the DB. It receives pre-resolved tool definitions.
- **Resolution** happens in `@agent-platform/shared` (or app-level services).
- The **compiler** receives resolved tools via a new `CompilerOptions` field.

```
┌─────────────────────────────────────────────────────────┐
│  Caller (version-service / deployment-resolver / topo)  │
│                                                         │
│  1. Parse DSL → AgentBasedDocument (with toolLinks)     │
│  2. Extract toolLinks from parsed docs                  │
│  3. Call resolveToolLinks() in @agent-platform/shared   │
│  4. Pass resolved ToolDefinitionIR[] to compiler via    │
│     CompilerOptions.resolvedToolLinks                   │
│  5. Call compileABLtoIR(docs, options)                  │
│  6. Compiler merges resolved tools into agentIR.tools   │
└─────────────────────────────────────────────────────────┘
```

**New `CompilerOptions` field:**

```typescript
interface CompilerOptions {
  // ... existing fields
  /** Pre-resolved DB tool definitions from USE TOOL: declarations.
   *  Keyed by agent name → ToolDefinitionIR[].
   *  Compiler merges these into each agent's tools list. */
  resolvedToolLinks?: Map<string, ToolDefinitionIR[]>;
}
```

**Compiler behavior:**

- For each agent document, look up `options.resolvedToolLinks.get(agentName)`
- Merge the resolved tools into `agentIR.tools` alongside inline and file-imported tools
- Run dedup/collision validation (see Section 7)

### 6. Tool Resolution Algorithm (`@agent-platform/shared`)

New function in `packages/shared/src/tools/resolve-tool-links.ts`:

```typescript
interface ResolveToolLinksInput {
  tenantId: string;
  projectId: string;
  /** Grouped by agent name for multi-agent compilations */
  linksByAgent: Map<string, ToolLink[]>;
}

interface ResolvedToolLink {
  slug: string;
  alias: string | null;
  toolId: string;
  versionId: string;
  version: number;
  versionName: string;
  toolDefinitionIR: ToolDefinitionIR;
}

interface ResolveToolLinksResult {
  /** Resolved tools grouped by agent name */
  resolvedByAgent: Map<string, ResolvedToolLink[]>;
  /** Structured compile errors */
  errors: ValidationDiagnostic[];
  /** Non-fatal warnings */
  warnings: string[];
}

async function resolveToolLinks(input: ResolveToolLinksInput): Promise<ResolveToolLinksResult>;
```

**Algorithm:**

```
1. Collect all unique slugs across all agents
2. Batch lookup: Tool.find({ tenantId, projectId, slug: { $in: allSlugs } })
3. Partition links into:
   a. Floating (no version pin) — need published/highest version
   b. Pinned (with version pin) — need exact version by name
4. Batch lookup floating versions:
   - Aggregation: Tool + ToolVersion join, sort by { isPublished: -1, version: -1 }
   - Excludes draft (version > 0)
5. Batch lookup pinned versions:
   - ToolVersion.find({ $or: pins.map(p => ({ toolId: p.toolId, tenantId, versionName: p.pin })) })
   - Each condition is a compound match (not cross-product $in)
6. For MCP tools in resolved set:
   - Single query: findMcpServerConfigsByProject(tenantId, projectId)
   - Build mcpConfigMap, bake server configs inline
7. Convert each resolved pair via convertDbToolToIR(tool, version, serverConfig)
8. Apply IR name: use alias if provided, otherwise use slug
9. Return grouped by agent name
```

**Error codes (structured `ValidationDiagnostic`):**

| Code | Condition                             | Message                                                                       |
| ---- | ------------------------------------- | ----------------------------------------------------------------------------- |
| E701 | Slug not found                        | `Tool 'bad_slug' not found in project`                                        |
| E702 | Version not found                     | `Version 'v99' not found for tool 'my_tool'`                                  |
| E703 | Draft pin                             | `Cannot pin to 'draft' — use a named version`                                 |
| E704 | Alias collision with inline/file tool | `Alias 'calculate' conflicts with inline tool 'calculate'`                    |
| E705 | Slug collision with inline/file tool  | `Tool slug 'get_weather' conflicts with inline tool definition 'get_weather'` |
| E706 | Duplicate USE TOOL slug               | `Duplicate USE TOOL declaration for 'get_weather'`                            |
| E707 | Alias collision with system tool      | `Alias '__handoff__' conflicts with system tool`                              |
| E708 | No published version                  | `Tool 'get_weather' has no published version — publish a version first`       |
| E709 | Duplicate alias                       | `Alias 'notify' used by multiple USE TOOL declarations`                       |

### 7. Dedup and Collision Rules

Collision detection runs **after all three tool sources are fully resolved**:

```
Step 1: Resolve inline DSL tools → Set<name>: inlineNames
Step 2: Resolve FROM file imports → Set<name>: fileNames
Step 3: Resolve USE TOOL links  → Set<name>: dbNames (using slug or alias)

Collision checks:
  - inlineNames ∩ fileNames     → compile error (existing behavior)
  - inlineNames ∩ dbNames       → E705 (slug collision) or E704 (alias collision)
  - fileNames ∩ dbNames         → E705 or E704
  - dbNames duplicates          → E706 (duplicate slug) or E709 (duplicate alias)
  - dbNames ∩ systemToolNames   → E707
```

**Scope:** Dedup rules are **per-agent**. Two different agents in the same compilation may both `USE TOOL: shared_payments_tool` without error.

### 8. Breaking Change: Remove Implicit DB Tool Injection

**Current behavior:** `loadProjectToolsAsIR()` loads ALL project DB tools, dedupes by name against DSL tools, and merges into `compilationOutput.shared_tools`.

**New behavior:** Only tools declared via `USE TOOL:` are resolved and merged. No implicit injection.

#### Migration Plan (3 phases, feature-flag controlled)

**Phase 1 — Additive (no breaking change)**

- Add `USE TOOL:` parser support
- Add `resolveToolLinks()` function
- Add `CompilerOptions.resolvedToolLinks`
- Implicit injection still active (backward compatible)
- Feature flag: `TOOL_LINKING_MODE = 'implicit'` (default)

**Phase 2 — Deprecation warnings + auto-migration tooling**

- When implicit injection adds a DB tool, emit compile warning:
  `"W801: Tool 'get_weather' was implicitly injected. Add 'USE TOOL: get_weather' to your TOOLS section. Implicit injection will be removed in a future release."`
- Studio UI shows "Fix warnings" action per agent that auto-inserts `USE TOOL:` lines
- CLI migration command: `abl migrate-tool-links --project <id>` that:
  1. For each agent in the project, parses DSL to find existing tool names
  2. Loads all project DB tools
  3. For draft-only tools: auto-publishes as `auto-v1`
  4. Inserts `USE TOOL: <slug>` for each DB tool not already in the DSL
  5. Saves updated DSL to `ProjectAgent.dslContent`
- Feature flag: `TOOL_LINKING_MODE = 'warn'`

**Phase 3 — Remove implicit injection**

- Only activatable after Phase 2 completes for all agents in a project
- Pre-check: scan all project agents for implicit tool dependencies. Block Phase 3 if any agent would lose tools.
- Feature flag: `TOOL_LINKING_MODE = 'explicit'`
- `loadProjectToolsAsIR()` deprecated, calls redirect to `resolveToolLinks()`

**Feature flag scope:** Per-project (stored on `Project` model or `ProjectConfigVariable`). Each project migrates independently.

### 9. Version Snapshot Extension

`AgentVersion.toolVersionSnapshot` extended with `slug` and `alias`:

```typescript
toolVersionSnapshot: Array<{
  toolId: string;
  toolName: string; // Tool.name (display name, for UI)
  versionId: string;
  version: number;
  versionName: string;
  slug: string; // NEW: the slug used in USE TOOL declaration
  alias: string | null; // NEW: the alias (AS ...), null if no alias
}>;
```

This enables:

- UI can show "get_weather → Tool 'Get Weather' v2"
- Cache invalidation can trace `toolId` back to the DSL reference
- Agent version diff view can show snapshot delta (which tools changed between versions)
- Git export/import can reconstruct `USE TOOL:` lines from the snapshot

### 10. Source Hash Computation

The composite hash is computed **after** tool resolution (not from raw `toolLinks`):

```
sourceHash = SHA-256(
  dslContent +
  sorted(configVariables.entries()) +
  sorted(toolVersionSnapshot.map(t => `${t.toolId}:${t.versionId}`))
)
```

**Properties:**

- DSL change (including adding/removing `USE TOOL:` lines) → hash changes
- Tool version content change (new published version for a floating link) → hash changes (different `versionId`)
- Tool slug rename → hash does NOT change (hash uses `toolId:versionId`, not slug)
- Config variable change → hash changes

### 11. Callers That Must Be Updated

#### A. `version-service.ts` (Agent Version Creation)

Current flow:

```
parse → compile → loadProjectToolsWithVersionMap() → merge shared_tools → snapshot → hash
```

New flow:

```
parse → extract toolLinks from AST → resolveToolLinks() → compile with resolvedToolLinks → snapshot → hash
```

#### B. `deployment-resolver.ts` (Working Copy / Preview Compile)

Current flow:

```
load ProjectAgent.dslContent → parse → compile → loadProjectToolsAsIR() → merge
```

New flow:

```
load ProjectAgent.dslContent → parse → extract toolLinks → resolveToolLinks() → compile with resolvedToolLinks
```

The shared `resolveToolLinks()` function is callable from both paths.

#### C. Topology API (`/api/projects/:id/topology/route.ts`)

Current: calls `compileABLtoIR(parsedDocs)` with no DB tool resolution.

New: must extract `toolLinks` from parsed docs, call `resolveToolLinks()`, pass to compiler. If resolution fails (tools not found), topology falls back gracefully — shows agents without DB tool metadata, surfaces errors in the response.

#### D. Git Export/Import (`project-io`)

**Export:** Agent DSL with `USE TOOL:` lines is exported as-is. The `toolVersionSnapshot` from the latest active `AgentVersion` is included as metadata.

**Import:** On import into a target project:

1. Parse DSL to extract `toolLinks`
2. For each link, check if the target project has a tool with that slug
3. If found → no action needed (will resolve at compile time)
4. If not found → structured warning: `"W901: Tool 'get_weather' referenced in agent 'HotelSearch' not found in target project. Create the tool or update the USE TOOL declaration."`
5. Import proceeds (agent DSL saved). Compilation will fail until tools are created.

#### E. Runtime Backward Compatibility

Existing `AgentVersion` records compiled before migration have DB tools in `compilationOutput.shared_tools`. New records have DB tools merged into `agentIR.tools`.

**Runtime must support both formats:**

- Check for `shared_tools` on the compilation output (legacy path)
- Check for tools with `source: 'db'` marker in `agentIR.tools` (new path)
- A flag `AgentVersion.toolLinkingMode: 'implicit' | 'explicit'` disambiguates (default `'implicit'` for existing records)

### 12. Lifecycle Guards

#### A. Tool Deletion Guard

When deleting a tool, pre-check:

```
AgentVersion.find({
  'toolVersionSnapshot.toolId': toolId,
  status: { $in: ['active', 'staged', 'testing'] }
})
```

If matches found → return structured warning listing affected agent versions. Deletion requires explicit `force: true` or deactivating the affected versions first.

Baked IR in existing `AgentVersion` records is intentionally immutable — the HTTP endpoints / MCP configs continue to work even after tool deletion. But new compiles will fail.

#### B. Slug Immutability

`Tool.slug` is made **immutable after creation**. Add a pre-save hook:

```typescript
ToolSchema.pre('save', function () {
  if (!this.isNew && this.isModified('slug')) {
    throw new Error('Tool slug cannot be changed after creation');
  }
});
```

This prevents the silent DSL breakage scenario where a slug rename causes `USE TOOL: old_slug` to fail.

#### C. Stale Floating Link Detection

When the Studio UI loads an agent's overview/editor:

1. Load the latest `AgentVersion.toolVersionSnapshot`
2. For each entry with `alias: null` (floating link — no pin):
   - Check if the current published `ToolVersion` for that `toolId` still matches `versionId`
   - If different → surface in the UI: "Tool 'get_weather' was compiled with v1, but v2 is now published. Recompile to pick up changes."

This is a read-time check (no background jobs). It queries at most N tool versions where N = number of floating links.

#### D. Auto-Publish Behavior

Under the new design, auto-publish of draft-only tools during compilation is **removed**. The behavior shifts to:

- `USE TOOL: my_tool` where `my_tool` has only a draft → **compile error E708**: `"Tool 'my_tool' has no published version — publish a version first"`
- The migration tooling (Phase 2) handles auto-publishing existing draft-only tools before adding `USE TOOL:` links
- After migration, it's the tool author's responsibility to publish a version before it can be linked

### 13. Studio UI Additions

#### A. Tool Picker / Autocomplete

When the cursor is inside the `TOOLS:` section and the user types `USE TOOL:`, the editor offers autocomplete:

- Lists all project tool slugs (from `Tool.find({ tenantId, projectId })`)
- Shows tool type icon (HTTP/MCP/Sandbox) and published version name
- After selecting a slug, offers `@` version picker with available version names
- Filters out tools already declared in the current agent

#### B. "Add to Agent" from Tool Detail Page

The tool detail page adds a button: **"Use in Agent"** → opens a picker of project agents → inserts `USE TOOL: slug` into the selected agent's DSL.

#### C. Agent Version Diff View

The diff view (comparing two `AgentVersion` records) includes a `toolVersionSnapshot` delta section:

- Tools added/removed between versions
- Version changes (e.g., "get_weather: v1 → v2")
- Alias changes

#### D. Stale Tool Warning Banner

On the agent detail page, if any floating tool link is stale (published version changed since last compile), show a warning banner:

> "1 tool has a newer published version. Recompile to pick up changes."

### 14. Compile Error Catalog

All errors are structured `ValidationDiagnostic` per CLAUDE.md:

```typescript
interface ValidationDiagnostic {
  severity: 'error' | 'warning';
  code: string; // E7xx for tool linking errors, W8xx for deprecation warnings
  location: string; // "AgentName.TOOLS.USE_TOOL:slug"
  message: string; // Human-readable, actionable
}
```

| Code | Severity | Condition                                                 |
| ---- | -------- | --------------------------------------------------------- |
| E701 | error    | Tool slug not found in project                            |
| E702 | error    | Pinned version name not found for tool                    |
| E703 | error    | Pinned to 'draft' (forbidden)                             |
| E704 | error    | Alias conflicts with inline or file-imported tool name    |
| E705 | error    | Slug conflicts with inline or file-imported tool name     |
| E706 | error    | Duplicate USE TOOL declaration for same slug              |
| E707 | error    | Alias conflicts with system tool name                     |
| E708 | error    | Tool has no published version (and no version pin)        |
| E709 | error    | Same alias used by multiple USE TOOL declarations         |
| W801 | warning  | Tool was implicitly injected (deprecation — Phase 2 only) |

### 15. Files to Change

| File                                                      | Change                                                                               | Priority |
| --------------------------------------------------------- | ------------------------------------------------------------------------------------ | -------- |
| `packages/core/src/types/agent-based.ts`                  | Add `ToolLink` interface, `toolLinks` field on `AgentBasedDocument`                  | Phase 1  |
| `packages/core/src/parser/agent-based-parser.ts`          | Parse `USE TOOL:` in `parseTools()`, validate slug/version/alias                     | Phase 1  |
| `packages/shared/src/tools/resolve-tool-links.ts`         | New file: `resolveToolLinks()` batch resolver                                        | Phase 1  |
| `packages/shared/src/tools/convert-db-tool-to-ir.ts`      | Add `irName` override parameter (slug or alias)                                      | Phase 1  |
| `packages/shared/src/repos/tool-repo.ts`                  | Add `findToolsBySlugs(tenantId, projectId, slugs[])` batch lookup                    | Phase 1  |
| `packages/shared/src/repos/tool-version-repo.ts`          | Add `findVersionsByNames(tenantId, toolVersionPairs[])` batch lookup                 | Phase 1  |
| `packages/compiler/src/platform/ir/compiler.ts`           | Accept `CompilerOptions.resolvedToolLinks`, merge into agent tools, collision checks | Phase 1  |
| `packages/compiler/src/types.ts`                          | Add `resolvedToolLinks` to `CompilerOptions`                                         | Phase 1  |
| `apps/runtime/src/services/version-service.ts`            | Extract toolLinks from AST, call `resolveToolLinks()`, pass to compiler              | Phase 1  |
| `packages/database/src/models/tool.model.ts`              | Add slug immutability pre-save hook                                                  | Phase 1  |
| `apps/studio/src/app/api/projects/[id]/topology/route.ts` | Call `resolveToolLinks()` for `USE TOOL` declarations                                | Phase 1  |
| `packages/shared/src/tools/load-project-tools-as-ir.ts`   | Add deprecation path, feature flag check                                             | Phase 2  |
| `apps/runtime/src/services/version-service.ts`            | Add W801 deprecation warnings for implicit injection                                 | Phase 2  |
| `apps/studio/src/components/abl/ABLEditor.tsx`            | Slug autocomplete for `USE TOOL:`                                                    | Phase 2  |
| `apps/studio/src/components/tools/ToolDetailPage.tsx`     | "Use in Agent" button                                                                | Phase 2  |
| `apps/studio/src/components/agents/AgentOverviewTab.tsx`  | Stale tool warning banner                                                            | Phase 2  |
| `apps/studio/src/components/agents/VersionListTab.tsx`    | Tool snapshot delta in diff view                                                     | Phase 2  |
| Migration CLI script                                      | Batch `USE TOOL:` insertion + draft auto-publish                                     | Phase 2  |
| `packages/shared/src/tools/load-project-tools-as-ir.ts`   | Remove implicit injection path                                                       | Phase 3  |
| `packages/project-io/src/git/git-sync-service.ts`         | Validate `USE TOOL` slugs on import, emit W901                                       | Phase 3  |

### 16. Data Model Changes Summary

**New field on `AgentBasedDocument` (AST):**

```typescript
toolLinks?: ToolLink[]
```

**New field on `CompilerOptions`:**

```typescript
resolvedToolLinks?: Map<string, ToolDefinitionIR[]>
```

**Extended `AgentVersion.toolVersionSnapshot` entries:**

```typescript
{
  (toolId, toolName, versionId, version, versionName, slug, alias);
}
```

**New field on `AgentVersion`:**

```typescript
toolLinkingMode: 'implicit' | 'explicit'; // default 'implicit' for existing records
```

**New pre-save hook on `Tool`:**
Slug immutability after creation.

**Feature flag on `Project` (or `ProjectConfigVariable`):**

```
TOOL_LINKING_MODE: 'implicit' | 'warn' | 'explicit'
```

### 17. Security Invariants

Every DB query in the resolution pipeline must include both `tenantId` AND `projectId`:

| Operation                     | Required Filter                                                                          |
| ----------------------------- | ---------------------------------------------------------------------------------------- |
| Find tools by slugs           | `{ tenantId, projectId, slug: { $in: slugs } }`                                          |
| Find tool versions (floating) | `{ tenantId, toolId, version: { $gt: 0 } }` sorted by `{ isPublished: -1, version: -1 }` |
| Find tool versions (pinned)   | `{ $or: pins.map(p => ({ toolId: p.toolId, tenantId, versionName: p.pin })) }`           |
| Find MCP server configs       | `{ tenantId, projectId }`                                                                |
| Pre-delete tool check         | `{ 'toolVersionSnapshot.toolId': toolId }` scoped to tenant's agent versions             |

No query ever omits `tenantId`. No cross-project resolution is possible.

### 18. Performance Characteristics

| Operation            | Current (implicit)                | New (explicit)                                     |
| -------------------- | --------------------------------- | -------------------------------------------------- |
| Tool lookup          | 1 aggregation (all project tools) | 1 query (batch by slugs, typically 5-15 slugs)     |
| Version resolution   | Part of aggregation               | 1-2 queries (floating batch + pinned batch)        |
| MCP config pre-load  | 1 query (all project MCP configs) | 1 query (same — only if MCP tools in resolved set) |
| Total DB round-trips | 2-3                               | 3-4                                                |
| Tools processed      | All project tools (could be 100+) | Only declared tools (typically 5-15)               |

Net: slightly more queries but far less data processed. For projects with many tools, the explicit approach is faster because it doesn't load/convert irrelevant tools.

### 19. Open Questions

1. **Should `USE TOOL` support glob patterns?** E.g., `USE TOOL: payments_*` to link all tools matching a prefix. Deferred — can be added later without breaking changes.

2. **Should tool links support environment-scoped overrides?** E.g., `USE TOOL: send_email@v2` in production but `@v1` in staging. Currently out of scope — `Deployment.modelOverrides` exists for models but not for tools. Could be a future `Deployment.toolVersionOverrides` field.

3. **Should the DSL support `USE ALL TOOLS` as a shorthand for "inject all project tools" (current implicit behavior)?** This would provide a migration escape hatch without per-tool declarations. Deferred to Phase 2 evaluation.

---

## Implementation Plan

_Merged from `2026-02-23-explicit-tool-linking-plan.md`._

## Phase 1: Core Infrastructure (Tasks 1–8)

### Task 1: Add `ToolLink` type to AST

**Files:**

- Modify: `packages/core/src/types/agent-based.ts:425-428` (after `ToolImport`)
- Modify: `packages/core/src/types/agent-based.ts:936` (on `AgentBasedDocument`)
- Test: `packages/core/src/__tests__/tool-link-types.test.ts`

**Step 1: Write the failing test**

```typescript
// packages/core/src/__tests__/tool-link-types.test.ts
import { describe, test, expect } from 'vitest';
import type { ToolLink, AgentBasedDocument } from '../types/agent-based.js';

describe('ToolLink type', () => {
  test('ToolLink shape is correct', () => {
    const link: ToolLink = {
      slug: 'get_weather',
      versionPin: null,
      alias: null,
    };
    expect(link.slug).toBe('get_weather');
    expect(link.versionPin).toBeNull();
    expect(link.alias).toBeNull();
  });

  test('ToolLink with version pin and alias', () => {
    const link: ToolLink = {
      slug: 'calculate_risk',
      versionPin: 'v2',
      alias: 'risk_check',
    };
    expect(link.slug).toBe('calculate_risk');
    expect(link.versionPin).toBe('v2');
    expect(link.alias).toBe('risk_check');
  });

  test('AgentBasedDocument accepts toolLinks field', () => {
    const doc = {
      toolLinks: [{ slug: 'x', versionPin: null, alias: null }],
    } as Partial<AgentBasedDocument>;
    expect(doc.toolLinks).toHaveLength(1);
  });
});
```

**Step 2: Run test to verify it fails**

Run: `cd packages/core && pnpm vitest run src/__tests__/tool-link-types.test.ts`
Expected: FAIL — `ToolLink` not exported from types

**Step 3: Write minimal implementation**

In `packages/core/src/types/agent-based.ts`, after the `ToolImport` interface (line 428):

```typescript
/**
 * A reference to a DB-managed tool, parsed from USE TOOL: syntax.
 * Slug matches Tool.slug in the database (project-scoped, lowercase + underscores).
 */
export interface ToolLink {
  slug: string; // DB tool slug (lowercase, underscores only)
  versionPin: string | null; // 'v2' from @v2, null = latest published
  alias: string | null; // 'analyze' from AS analyze, null = use slug as IR name
}
```

On `AgentBasedDocument` (after `toolImports` around line 936):

```typescript
  toolLinks?: ToolLink[];
```

Export `ToolLink` from `packages/core/src/types/index.ts` if not auto-exported.

**Step 4: Run test to verify it passes**

Run: `cd packages/core && pnpm vitest run src/__tests__/tool-link-types.test.ts`
Expected: PASS

**Step 5: Commit**

```bash
git add packages/core/src/types/agent-based.ts packages/core/src/__tests__/tool-link-types.test.ts
git commit -m "feat(core): add ToolLink type to AST for USE TOOL declarations"
```

---

### Task 2: Parse `USE TOOL:` syntax in agent-based-parser

**Files:**

- Modify: `packages/core/src/parser/agent-based-parser.ts:1714-1791` (`parseTools` function)
- Modify: `packages/core/src/parser/agent-based-parser.ts:247-252` (wire `toolLinks` on doc)
- Test: `packages/core/src/__tests__/parse-tool-links.test.ts`

**Step 1: Write the failing tests**

```typescript
// packages/core/src/__tests__/parse-tool-links.test.ts
import { describe, test, expect } from 'vitest';
import { parseAgentBasedABL } from '../parser/agent-based-parser.js';

describe('USE TOOL parsing', () => {
  test('parses basic USE TOOL: slug', () => {
    const dsl = `AGENT: Test\nMODE: reasoning\nGOAL: Test\nTOOLS:\n  USE TOOL: get_weather\n`;
    const result = parseAgentBasedABL(dsl);
    expect(result.errors).toHaveLength(0);
    expect(result.document?.toolLinks).toHaveLength(1);
    expect(result.document!.toolLinks![0]).toEqual({
      slug: 'get_weather',
      versionPin: null,
      alias: null,
    });
  });

  test('parses USE TOOL with version pin', () => {
    const dsl = `AGENT: Test\nMODE: reasoning\nGOAL: Test\nTOOLS:\n  USE TOOL: calculate_risk@v2\n`;
    const result = parseAgentBasedABL(dsl);
    expect(result.errors).toHaveLength(0);
    expect(result.document!.toolLinks![0]).toEqual({
      slug: 'calculate_risk',
      versionPin: 'v2',
      alias: null,
    });
  });

  test('parses USE TOOL with alias', () => {
    const dsl = `AGENT: Test\nMODE: reasoning\nGOAL: Test\nTOOLS:\n  USE TOOL: sentiment_analyzer AS analyze\n`;
    const result = parseAgentBasedABL(dsl);
    expect(result.errors).toHaveLength(0);
    expect(result.document!.toolLinks![0]).toEqual({
      slug: 'sentiment_analyzer',
      versionPin: null,
      alias: 'analyze',
    });
  });

  test('parses USE TOOL with version pin AND alias', () => {
    const dsl = `AGENT: Test\nMODE: reasoning\nGOAL: Test\nTOOLS:\n  USE TOOL: send_email@v1 AS notify\n`;
    const result = parseAgentBasedABL(dsl);
    expect(result.errors).toHaveLength(0);
    expect(result.document!.toolLinks![0]).toEqual({
      slug: 'send_email',
      versionPin: 'v1',
      alias: 'notify',
    });
  });

  test('parses multiple USE TOOL declarations', () => {
    const dsl = `AGENT: Test\nMODE: reasoning\nGOAL: Test\nTOOLS:\n  USE TOOL: get_weather\n  USE TOOL: send_email@v1\n  USE TOOL: risk AS check_risk\n`;
    const result = parseAgentBasedABL(dsl);
    expect(result.errors).toHaveLength(0);
    expect(result.document!.toolLinks).toHaveLength(3);
  });

  test('rejects @draft version pin', () => {
    const dsl = `AGENT: Test\nMODE: reasoning\nGOAL: Test\nTOOLS:\n  USE TOOL: my_tool@draft\n`;
    const result = parseAgentBasedABL(dsl);
    expect(result.errors.length).toBeGreaterThan(0);
    expect(result.errors[0].message).toContain('draft');
  });

  test('rejects duplicate USE TOOL slugs', () => {
    const dsl = `AGENT: Test\nMODE: reasoning\nGOAL: Test\nTOOLS:\n  USE TOOL: get_weather\n  USE TOOL: get_weather\n`;
    const result = parseAgentBasedABL(dsl);
    expect(result.errors.length).toBeGreaterThan(0);
    expect(result.errors[0].message).toContain('Duplicate');
  });

  test('rejects uppercase slugs', () => {
    const dsl = `AGENT: Test\nMODE: reasoning\nGOAL: Test\nTOOLS:\n  USE TOOL: Get_Weather\n`;
    const result = parseAgentBasedABL(dsl);
    expect(result.errors.length).toBeGreaterThan(0);
    expect(result.errors[0].message).toContain('lowercase');
  });

  test('coexists with inline tools and FROM imports', () => {
    const dsl = `AGENT: Test\nMODE: reasoning\nGOAL: Test\nTOOLS:\n  FROM "./tools/api.tools.abl" USE: search\n  USE TOOL: get_weather\n  format(data: string) -> string\n    description: "Format"\n`;
    const result = parseAgentBasedABL(dsl);
    expect(result.errors).toHaveLength(0);
    expect(result.document!.toolImports).toHaveLength(1);
    expect(result.document!.toolLinks).toHaveLength(1);
    expect(result.document!.tools).toHaveLength(1);
  });
});
```

**Step 2: Run test to verify it fails**

Run: `cd packages/core && pnpm vitest run src/__tests__/parse-tool-links.test.ts`
Expected: FAIL — `USE TOOL:` lines not recognized

**Step 3: Write minimal implementation**

In `parseTools()` at `packages/core/src/parser/agent-based-parser.ts`, modify the function signature and body. After the `imports` array declaration (~line 1717), add:

```typescript
const toolLinks: import('../types/agent-based.js').ToolLink[] = [];
const seenSlugs = new Set<string>();
```

After the FROM import match block (~line 1750), before the inline tool match, add:

```typescript
// Parse USE TOOL: slug[@version] [AS alias]
const useToolMatch = trimmed.match(
  /^USE\s+TOOL:\s*([a-z][a-z0-9_]*)(?:@([a-z0-9][a-z0-9._-]*))?(?:\s+AS\s+([a-z][a-z0-9_]*))?$/,
);
if (useToolMatch) {
  const [, slug, versionPin, alias] = useToolMatch;

  // Reject @draft
  if (versionPin === 'draft') {
    state.errors.push({
      line: state.currentLine + 1,
      column: 0,
      message: `E703: Cannot pin to 'draft' — use a named version (e.g. @v1)`,
    });
    state.currentLine++;
    continue;
  }

  // Reject duplicate slugs
  if (seenSlugs.has(slug)) {
    state.errors.push({
      line: state.currentLine + 1,
      column: 0,
      message: `E706: Duplicate USE TOOL declaration for '${slug}'`,
    });
    state.currentLine++;
    continue;
  }
  seenSlugs.add(slug);

  toolLinks.push({
    slug,
    versionPin: versionPin || null,
    alias: alias || null,
  });
  state.currentLine++;
  continue;
}

// Reject USE TOOL with uppercase (common mistake)
if (/^USE\s+TOOL:/i.test(trimmed) && !useToolMatch) {
  state.errors.push({
    line: state.currentLine + 1,
    column: 0,
    message: `Tool slug must be lowercase alphanumeric with underscores (e.g. USE TOOL: my_tool)`,
  });
  state.currentLine++;
  continue;
}
```

Change the return statement (~line 1791) to:

```typescript
return { tools, imports, toolLinks };
```

In the section handler (~line 247-252), wire `toolLinks` onto the document:

```typescript
    } else if (line === 'TOOLS:') {
      const toolsResult = parseTools(state);
      doc.tools = toolsResult.tools;
      if (toolsResult.imports.length > 0) {
        doc.toolImports = toolsResult.imports;
      }
      if (toolsResult.toolLinks.length > 0) {
        doc.toolLinks = toolsResult.toolLinks;
      }
```

**Step 4: Run test to verify it passes**

Run: `cd packages/core && pnpm vitest run src/__tests__/parse-tool-links.test.ts`
Expected: PASS

**Step 5: Run existing parser tests to verify no regressions**

Run: `cd packages/core && pnpm vitest run src/__tests__/agent-based-parser.test.ts`
Expected: All existing tests PASS

**Step 6: Commit**

```bash
git add packages/core/src/parser/agent-based-parser.ts packages/core/src/__tests__/parse-tool-links.test.ts
git commit -m "feat(core): parse USE TOOL: slug[@version] [AS alias] syntax"
```

---

### Task 3: Add `resolvedToolLinks` to `CompilerOptions` and merge into agent tools

**Files:**

- Modify: `packages/compiler/src/platform/ir/compiler.ts:222-228` (CompilerOptions)
- Modify: `packages/compiler/src/platform/ir/compiler.ts:289` (tool merge in compileAgentToIR)
- Modify: `packages/compiler/src/platform/ir/compiler.ts:49-64` (system tool constants — need names for collision check)
- Test: `packages/compiler/src/__tests__/tool-link-merge.test.ts`

**Step 1: Write the failing test**

```typescript
// packages/compiler/src/__tests__/tool-link-merge.test.ts
import { describe, test, expect } from 'vitest';
import { compileABLtoIR } from '../platform/ir/compiler.js';
import { parseAgentBasedABL } from '@abl/core';

describe('resolvedToolLinks merge', () => {
  const baseDsl = `AGENT: Test\nMODE: reasoning\nGOAL: Test agent\nTOOLS:\n  USE TOOL: get_weather\n`;

  test('merges resolvedToolLinks into agent tools', () => {
    const parsed = parseAgentBasedABL(baseDsl);
    const resolvedToolLinks = new Map([
      [
        'Test',
        [
          {
            name: 'get_weather',
            description: 'Get weather data',
            parameters: [{ name: 'location', type: 'string', required: true }],
            returns: { type: 'object' },
            hints: {},
            tool_type: 'http',
            http_binding: { endpoint: '/weather', method: 'GET' },
          },
        ],
      ],
    ]);

    const output = compileABLtoIR([parsed.document!], { resolvedToolLinks });
    const agent = output.agents['Test'];
    const weatherTool = agent.tools.find((t: any) => t.name === 'get_weather');
    expect(weatherTool).toBeDefined();
    expect(weatherTool!.tool_type).toBe('http');
  });

  test('collision between USE TOOL and inline tool is a compile error', () => {
    const dsl = `AGENT: Test\nMODE: reasoning\nGOAL: Test\nTOOLS:\n  USE TOOL: format\n  format(data: string) -> string\n    description: "Format"\n`;
    const parsed = parseAgentBasedABL(dsl);
    const resolvedToolLinks = new Map([
      [
        'Test',
        [
          {
            name: 'format',
            description: 'DB format',
            parameters: [],
            returns: { type: 'string' },
            hints: {},
          },
        ],
      ],
    ]);

    const output = compileABLtoIR([parsed.document!], { resolvedToolLinks });
    // Should produce a compilation error for the collision
    expect(output.errors.length).toBeGreaterThan(0);
    expect(
      output.errors.some((e: any) => e.message.includes('E705') || e.message.includes('conflicts')),
    ).toBe(true);
  });

  test('collision between USE TOOL alias and system tool is a compile error', () => {
    const dsl = `AGENT: Test\nMODE: reasoning\nGOAL: Test\nTOOLS:\n  USE TOOL: my_tool AS __handoff__\n`;
    const parsed = parseAgentBasedABL(dsl);
    const resolvedToolLinks = new Map([
      [
        'Test',
        [
          {
            name: '__handoff__',
            description: 'Bad alias',
            parameters: [],
            returns: { type: 'string' },
            hints: {},
          },
        ],
      ],
    ]);

    const output = compileABLtoIR([parsed.document!], { resolvedToolLinks });
    expect(output.errors.length).toBeGreaterThan(0);
    expect(
      output.errors.some(
        (e: any) => e.message.includes('E707') || e.message.includes('system tool'),
      ),
    ).toBe(true);
  });
});
```

**Step 2: Run test to verify it fails**

Run: `cd packages/compiler && pnpm vitest run src/__tests__/tool-link-merge.test.ts`
Expected: FAIL — `resolvedToolLinks` not in CompilerOptions

**Step 3: Write minimal implementation**

In `packages/compiler/src/platform/ir/compiler.ts`:

Extend `CompilerOptions` (line 222-228):

```typescript
export interface CompilerOptions {
  version?: string;
  optimize_for?: 'voice' | 'digital' | 'workflow';
  include_source_maps?: boolean;
  coordination_defaults?: import('./schema.js').ProjectCoordinationDefaults;
  config_variables?: Record<string, string>;
  /** Pre-resolved DB tool definitions from USE TOOL: declarations.
   *  Keyed by agent name → ToolDefinition[]. Compiler merges these into each agent's tools. */
  resolvedToolLinks?: Map<string, import('./schema.js').ToolDefinition[]>;
}
```

At the top of file, add system tool name set after the constant imports:

```typescript
const SYSTEM_TOOL_NAMES = new Set([
  SYSTEM_TOOL_HANDOFF,
  SYSTEM_TOOL_DELEGATE,
  SYSTEM_TOOL_COMPLETE,
  SYSTEM_TOOL_ESCALATE,
]);
```

In `compileAgentToIR()`, after the `tools:` line (~line 289), add collision detection and merge:

```typescript
    tools: (() => {
      const inlineTools = [...compileTools(doc), ...compileSystemTools(doc)];
      const linkedTools = options.resolvedToolLinks?.get(doc.name) ?? [];

      // Collision detection: USE TOOL names vs inline/system tool names
      const inlineNames = new Set(inlineTools.map(t => t.name));
      const collisionErrors: import('./schema.js').CompilationError[] = [];

      for (const lt of linkedTools) {
        if (inlineNames.has(lt.name)) {
          collisionErrors.push({
            agent: doc.name,
            message: `E705: Tool slug '${lt.name}' conflicts with inline tool definition '${lt.name}'`,
            type: 'validation',
            severity: 'error',
          });
        }
        if (SYSTEM_TOOL_NAMES.has(lt.name)) {
          collisionErrors.push({
            agent: doc.name,
            message: `E707: Tool name '${lt.name}' conflicts with system tool`,
            type: 'validation',
            severity: 'error',
          });
        }
      }

      // Store collision errors to be collected by the outer loop
      // (use a side-channel since compileAgentToIR returns AgentIR, not errors)
      if (collisionErrors.length > 0) {
        (options as any).__toolLinkErrors = [
          ...((options as any).__toolLinkErrors || []),
          ...collisionErrors,
        ];
      }

      return [...inlineTools, ...linkedTools];
    })(),
```

In `compileABLtoIR()`, after the agent compilation loop (~line 108), collect tool link errors:

```typescript
// Collect tool link collision errors
const toolLinkErrors = (options as any).__toolLinkErrors || [];
compilationErrors.push(...toolLinkErrors);
delete (options as any).__toolLinkErrors;
```

**Step 4: Run test to verify it passes**

Run: `cd packages/compiler && pnpm vitest run src/__tests__/tool-link-merge.test.ts`
Expected: PASS

**Step 5: Run existing compiler tests**

Run: `cd packages/compiler && pnpm vitest run`
Expected: All existing tests PASS

**Step 6: Commit**

```bash
git add packages/compiler/src/platform/ir/compiler.ts packages/compiler/src/__tests__/tool-link-merge.test.ts
git commit -m "feat(compiler): accept resolvedToolLinks in CompilerOptions with collision detection"
```

---

### Task 4: Add batch slug lookup to tool-version-repo

**Files:**

- Modify: `packages/shared/src/repos/tool-version-repo.ts` (add `loadToolsBySlugsWithPins`)
- Modify: `packages/shared/src/repos/index.ts` (export new function)
- Test: `packages/shared/src/__tests__/tool-version-repo.test.ts` (add cases)

**Step 1: Write the failing test**

```typescript
// Add to packages/shared/src/__tests__/tool-version-repo.test.ts

describe('loadToolsBySlugsWithPins', () => {
  test('resolves floating links to published version', async () => {
    const { loadToolsBySlugsWithPins } = await import('../repos/tool-version-repo.js');
    // This test requires DB fixtures — use existing test setup pattern
    // The function should exist and accept the right signature
    expect(typeof loadToolsBySlugsWithPins).toBe('function');
  });
});
```

**Step 2: Run test to verify it fails**

Run: `cd packages/shared && pnpm vitest run src/__tests__/tool-version-repo.test.ts`
Expected: FAIL — function not exported

**Step 3: Write implementation**

In `packages/shared/src/repos/tool-version-repo.ts`, add after `loadToolsBySlugs` (~line 490):

```typescript
/**
 * Resolve tool links by slug with optional per-tool version pins.
 * Floating links (no pin) resolve to published version (fallback: highest non-draft).
 * Pinned links resolve to exact versionName match.
 *
 * Uses batch queries: 1 for slug→tool lookup, 1 for floating versions, 1 for pinned versions.
 */
export async function loadToolsBySlugsWithPins(
  tenantId: string,
  projectId: string,
  links: Array<{ slug: string; versionPin: string | null }>,
): Promise<{
  resolved: Array<{ slug: string; tool: NormalizedTool; version: NormalizedToolVersion }>;
  missingSlug: string[];
  missingVersion: Array<{ slug: string; versionPin: string }>;
}> {
  const { Tool, ToolVersion } = await import('@agent-platform/database/models');

  const allSlugs = links.map((l) => l.slug);

  // Step 1: Batch lookup tools by slug
  const tools = await Tool.find({ tenantId, projectId, slug: { $in: allSlugs } }).lean();
  const toolBySlug = new Map(tools.map((t) => [t.slug, normalizeDocument(t) as NormalizedTool]));

  const missingSlug = allSlugs.filter((s) => !toolBySlug.has(s));

  // Partition into floating and pinned
  const floatingLinks: Array<{ slug: string; toolId: string }> = [];
  const pinnedLinks: Array<{ slug: string; toolId: string; versionPin: string }> = [];

  for (const link of links) {
    const tool = toolBySlug.get(link.slug);
    if (!tool) continue;
    if (link.versionPin) {
      pinnedLinks.push({ slug: link.slug, toolId: tool.id, versionPin: link.versionPin });
    } else {
      floatingLinks.push({ slug: link.slug, toolId: tool.id });
    }
  }

  const resolved: Array<{ slug: string; tool: NormalizedTool; version: NormalizedToolVersion }> =
    [];
  const missingVersion: Array<{ slug: string; versionPin: string }> = [];

  // Step 2: Batch resolve floating links (published → highest non-draft)
  if (floatingLinks.length > 0) {
    const floatingToolIds = floatingLinks.map((l) => l.toolId);
    const floatingResults = await Tool.aggregate([
      { $match: { _id: { $in: floatingToolIds }, tenantId } },
      {
        $lookup: {
          from: 'tool_versions',
          let: { toolId: '$_id', tenantId: '$tenantId' },
          pipeline: [
            {
              $match: {
                $expr: {
                  $and: [
                    { $eq: ['$toolId', '$$toolId'] },
                    { $eq: ['$tenantId', '$$tenantId'] },
                    { $ne: ['$versionName', 'draft'] },
                  ],
                },
              },
            },
            { $sort: { isPublished: -1, version: -1 } },
            { $limit: 1 },
          ],
          as: 'latestVersion',
        },
      },
      { $unwind: { path: '$latestVersion', preserveNullAndEmptyArrays: false } },
    ]);

    for (const result of floatingResults) {
      const slug = (result as any).slug;
      const tool = toolBySlug.get(slug);
      if (tool && result.latestVersion) {
        resolved.push({
          slug,
          tool,
          version: normalizeDocument(result.latestVersion) as NormalizedToolVersion,
        });
      }
    }

    // Detect floating links with no published version
    const resolvedFloatingSlugs = new Set(floatingResults.map((r: any) => r.slug));
    for (const fl of floatingLinks) {
      if (!resolvedFloatingSlugs.has(fl.slug)) {
        missingVersion.push({ slug: fl.slug, versionPin: '(published)' });
      }
    }
  }

  // Step 3: Batch resolve pinned links via $or compound conditions
  if (pinnedLinks.length > 0) {
    const orConditions = pinnedLinks.map((p) => ({
      toolId: p.toolId,
      tenantId,
      versionName: p.versionPin,
    }));
    const pinnedVersions = await ToolVersion.find({ $or: orConditions }).lean();

    const pinnedMap = new Map(
      pinnedVersions.map((v) => [`${(v as any).toolId}:${(v as any).versionName}`, v]),
    );

    for (const pl of pinnedLinks) {
      const version = pinnedMap.get(`${pl.toolId}:${pl.versionPin}`);
      const tool = toolBySlug.get(pl.slug);
      if (version && tool) {
        resolved.push({
          slug: pl.slug,
          tool,
          version: normalizeDocument(version) as NormalizedToolVersion,
        });
      } else if (tool) {
        missingVersion.push({ slug: pl.slug, versionPin: pl.versionPin });
      }
    }
  }

  return { resolved, missingSlug, missingVersion };
}
```

Export from `packages/shared/src/repos/index.ts`:

```typescript
export { loadToolsBySlugsWithPins } from './tool-version-repo.js';
```

**Step 4: Run test to verify it passes**

Run: `cd packages/shared && pnpm vitest run src/__tests__/tool-version-repo.test.ts`
Expected: PASS

**Step 5: Commit**

```bash
git add packages/shared/src/repos/tool-version-repo.ts packages/shared/src/repos/index.ts packages/shared/src/__tests__/tool-version-repo.test.ts
git commit -m "feat(shared): add loadToolsBySlugsWithPins batch resolver for USE TOOL links"
```

---

### Task 5: Create `resolveToolLinks()` function

**Files:**

- Create: `packages/shared/src/tools/resolve-tool-links.ts`
- Modify: `packages/shared/src/tools/index.ts` (export)
- Test: `packages/shared/src/__tests__/resolve-tool-links.test.ts`

**Step 1: Write the failing test**

```typescript
// packages/shared/src/__tests__/resolve-tool-links.test.ts
import { describe, test, expect, vi, beforeEach } from 'vitest';

// We'll mock the repo layer for unit testing
vi.mock('../repos/index.js', () => ({
  loadToolsBySlugsWithPins: vi.fn(),
  findMcpServerConfigsByProject: vi.fn(),
}));

vi.mock('../tools/convert-db-tool-to-ir.js', () => ({
  convertDbToolToIR: vi.fn(),
}));

import { resolveToolLinks } from '../tools/resolve-tool-links.js';
import { loadToolsBySlugsWithPins, findMcpServerConfigsByProject } from '../repos/index.js';
import { convertDbToolToIR } from '../tools/convert-db-tool-to-ir.js';

describe('resolveToolLinks', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  test('returns empty for no links', async () => {
    const result = await resolveToolLinks({
      tenantId: 't1',
      projectId: 'p1',
      linksByAgent: new Map(),
    });
    expect(result.resolvedByAgent.size).toBe(0);
    expect(result.errors).toHaveLength(0);
  });

  test('resolves floating link to published version', async () => {
    const mockTool = { id: 'tool1', name: 'Get Weather', slug: 'get_weather', toolType: 'http' };
    const mockVersion = { id: 'v1', toolId: 'tool1', versionName: 'v1', version: 1 };
    const mockIR = {
      name: 'get_weather',
      description: 'Weather',
      parameters: [],
      returns: { type: 'object' },
      hints: {},
    };

    (loadToolsBySlugsWithPins as any).mockResolvedValue({
      resolved: [{ slug: 'get_weather', tool: mockTool, version: mockVersion }],
      missingSlug: [],
      missingVersion: [],
    });
    (findMcpServerConfigsByProject as any).mockResolvedValue([]);
    (convertDbToolToIR as any).mockReturnValue(mockIR);

    const result = await resolveToolLinks({
      tenantId: 't1',
      projectId: 'p1',
      linksByAgent: new Map([
        ['TestAgent', [{ slug: 'get_weather', versionPin: null, alias: null }]],
      ]),
    });

    expect(result.errors).toHaveLength(0);
    expect(result.resolvedByAgent.get('TestAgent')).toHaveLength(1);
    expect(result.resolvedByAgent.get('TestAgent')![0].name).toBe('get_weather');
  });

  test('returns E701 for missing slug', async () => {
    (loadToolsBySlugsWithPins as any).mockResolvedValue({
      resolved: [],
      missingSlug: ['bad_slug'],
      missingVersion: [],
    });

    const result = await resolveToolLinks({
      tenantId: 't1',
      projectId: 'p1',
      linksByAgent: new Map([['TestAgent', [{ slug: 'bad_slug', versionPin: null, alias: null }]]]),
    });

    expect(result.errors).toHaveLength(1);
    expect(result.errors[0].code).toBe('E701');
  });

  test('returns E702 for missing version pin', async () => {
    (loadToolsBySlugsWithPins as any).mockResolvedValue({
      resolved: [],
      missingSlug: [],
      missingVersion: [{ slug: 'my_tool', versionPin: 'v99' }],
    });

    const result = await resolveToolLinks({
      tenantId: 't1',
      projectId: 'p1',
      linksByAgent: new Map([['TestAgent', [{ slug: 'my_tool', versionPin: 'v99', alias: null }]]]),
    });

    expect(result.errors).toHaveLength(1);
    expect(result.errors[0].code).toBe('E702');
  });

  test('applies alias as IR tool name', async () => {
    const mockTool = {
      id: 'tool1',
      name: 'Sentiment Analyzer',
      slug: 'sentiment_analyzer',
      toolType: 'http',
    };
    const mockVersion = { id: 'v1', toolId: 'tool1', versionName: 'v1', version: 1 };
    const mockIR = {
      name: 'sentiment_analyzer',
      description: 'Analyze',
      parameters: [],
      returns: { type: 'object' },
      hints: {},
    };

    (loadToolsBySlugsWithPins as any).mockResolvedValue({
      resolved: [{ slug: 'sentiment_analyzer', tool: mockTool, version: mockVersion }],
      missingSlug: [],
      missingVersion: [],
    });
    (findMcpServerConfigsByProject as any).mockResolvedValue([]);
    (convertDbToolToIR as any).mockReturnValue({ ...mockIR });

    const result = await resolveToolLinks({
      tenantId: 't1',
      projectId: 'p1',
      linksByAgent: new Map([
        ['TestAgent', [{ slug: 'sentiment_analyzer', versionPin: null, alias: 'analyze' }]],
      ]),
    });

    expect(result.resolvedByAgent.get('TestAgent')![0].name).toBe('analyze');
  });

  test('returns E708 for tool with no published version', async () => {
    (loadToolsBySlugsWithPins as any).mockResolvedValue({
      resolved: [],
      missingSlug: [],
      missingVersion: [{ slug: 'draft_only', versionPin: '(published)' }],
    });

    const result = await resolveToolLinks({
      tenantId: 't1',
      projectId: 'p1',
      linksByAgent: new Map([
        ['TestAgent', [{ slug: 'draft_only', versionPin: null, alias: null }]],
      ]),
    });

    expect(result.errors).toHaveLength(1);
    expect(result.errors[0].code).toBe('E708');
  });
});
```

**Step 2: Run test to verify it fails**

Run: `cd packages/shared && pnpm vitest run src/__tests__/resolve-tool-links.test.ts`
Expected: FAIL — module not found

**Step 3: Write implementation**

Create `packages/shared/src/tools/resolve-tool-links.ts`:

```typescript
/**
 * Resolve Tool Links
 *
 * Batch-resolves USE TOOL: declarations from parsed ABL into ToolDefinitionIR[].
 * This is the bridge between the parser (AST toolLinks) and the compiler (resolvedToolLinks).
 *
 * Lives in @agent-platform/shared because:
 * - @abl/compiler cannot depend on shared (circular dep)
 * - Resolution requires DB access (repos)
 * - Called by version-service, deployment-resolver, topology API
 */

import { convertDbToolToIR, type ToolDefinitionIR } from './convert-db-tool-to-ir.js';
import type { NormalizedMCPServerConfig } from '../types/mcp-server.js';

// ─── Types ───────────────────────────────────────────────────────────────────

export interface ToolLink {
  slug: string;
  versionPin: string | null;
  alias: string | null;
}

export interface ResolveToolLinksInput {
  tenantId: string;
  projectId: string;
  /** Grouped by agent name for multi-agent compilations */
  linksByAgent: Map<string, ToolLink[]>;
}

export interface ValidationDiagnostic {
  severity: 'error' | 'warning';
  code: string;
  location: string;
  message: string;
}

export interface ToolLinkSnapshotEntry {
  toolId: string;
  toolName: string;
  versionId: string;
  version: number;
  versionName: string;
  slug: string;
  alias: string | null;
}

export interface ResolveToolLinksResult {
  /** Resolved IR tools grouped by agent name */
  resolvedByAgent: Map<string, ToolDefinitionIR[]>;
  /** Structured compile errors */
  errors: ValidationDiagnostic[];
  /** Non-fatal warnings */
  warnings: string[];
  /** Snapshot entries for AgentVersion.toolVersionSnapshot */
  snapshotEntries: ToolLinkSnapshotEntry[];
}

// ─── Resolver ────────────────────────────────────────────────────────────────

export async function resolveToolLinks(
  input: ResolveToolLinksInput,
): Promise<ResolveToolLinksResult> {
  const { tenantId, projectId, linksByAgent } = input;
  const errors: ValidationDiagnostic[] = [];
  const warnings: string[] = [];
  const snapshotEntries: ToolLinkSnapshotEntry[] = [];
  const resolvedByAgent = new Map<string, ToolDefinitionIR[]>();

  // Collect all unique links across all agents
  const allLinks: Array<{ slug: string; versionPin: string | null }> = [];
  const allAliases = new Map<string, { agentName: string; alias: string }>();

  for (const [agentName, links] of linksByAgent) {
    for (const link of links) {
      allLinks.push({ slug: link.slug, versionPin: link.versionPin });
      if (link.alias) {
        allAliases.set(`${agentName}:${link.alias}`, { agentName, alias: link.alias });
      }
    }
  }

  if (allLinks.length === 0) {
    return { resolvedByAgent, errors, warnings, snapshotEntries };
  }

  // Deduplicate slugs for batch query (different agents may link the same tool)
  const uniqueLinks = Array.from(
    new Map(allLinks.map((l) => [`${l.slug}@${l.versionPin ?? ''}`, l])).values(),
  );

  // Batch resolve from DB
  const { loadToolsBySlugsWithPins, findMcpServerConfigsByProject } =
    await import('../repos/index.js');

  const { resolved, missingSlug, missingVersion } = await loadToolsBySlugsWithPins(
    tenantId,
    projectId,
    uniqueLinks,
  );

  // Emit errors for missing slugs
  for (const slug of missingSlug) {
    errors.push({
      severity: 'error',
      code: 'E701',
      location: `TOOLS.USE_TOOL:${slug}`,
      message: `Tool '${slug}' not found in project`,
    });
  }

  // Emit errors for missing versions
  for (const { slug, versionPin } of missingVersion) {
    if (versionPin === '(published)') {
      errors.push({
        severity: 'error',
        code: 'E708',
        location: `TOOLS.USE_TOOL:${slug}`,
        message: `Tool '${slug}' has no published version — publish a version first`,
      });
    } else {
      errors.push({
        severity: 'error',
        code: 'E702',
        location: `TOOLS.USE_TOOL:${slug}@${versionPin}`,
        message: `Version '${versionPin}' not found for tool '${slug}'`,
      });
    }
  }

  // Pre-load MCP server configs if any resolved tool is MCP
  const hasMcpTools = resolved.some(({ tool }) => tool.toolType === 'mcp');
  let mcpConfigMap = new Map<string, NormalizedMCPServerConfig>();
  if (hasMcpTools) {
    const mcpServerConfigs = await findMcpServerConfigsByProject(tenantId, projectId);
    mcpConfigMap = new Map(
      mcpServerConfigs.map((c: NormalizedMCPServerConfig & { _id?: unknown }) => [
        c.id ?? String(c._id),
        c,
      ]),
    );
  }

  // Build slug → resolved map for quick lookup
  const resolvedBySlug = new Map(resolved.map((r) => [r.slug, r]));

  // For each agent, resolve its specific links
  for (const [agentName, links] of linksByAgent) {
    const agentTools: ToolDefinitionIR[] = [];

    for (const link of links) {
      const entry = resolvedBySlug.get(link.slug);
      if (!entry) continue; // Error already emitted above

      // Resolve MCP server config for this specific tool
      let mcpServerConfig: NormalizedMCPServerConfig | undefined;
      if (entry.tool.toolType === 'mcp') {
        let mcpCfg = entry.version.mcpConfig as Record<string, unknown> | string | null | undefined;
        if (typeof mcpCfg === 'string') {
          try {
            mcpCfg = JSON.parse(mcpCfg);
          } catch {
            mcpCfg = null;
          }
        }
        if (mcpCfg && typeof mcpCfg === 'object' && 'serverId' in mcpCfg && mcpCfg.serverId) {
          mcpServerConfig = mcpConfigMap.get(String(mcpCfg.serverId));
          if (!mcpServerConfig) {
            warnings.push(
              `Tool '${link.slug}': MCP server config '${mcpCfg.serverId}' not found — tool included but server config not baked`,
            );
          }
        }
      }

      // Convert to IR
      const irDef = convertDbToolToIR(entry.tool, entry.version, mcpServerConfig);
      if (!irDef) continue;

      // Apply IR name: alias if provided, otherwise slug (not Tool.name)
      const irName = link.alias ?? link.slug;
      irDef.name = irName;

      agentTools.push(irDef);

      // Build snapshot entry
      snapshotEntries.push({
        toolId: entry.tool.id,
        toolName: entry.tool.name,
        versionId: entry.version.id,
        version: entry.version.version,
        versionName: entry.version.versionName,
        slug: link.slug,
        alias: link.alias,
      });
    }

    resolvedByAgent.set(agentName, agentTools);
  }

  return { resolvedByAgent, errors, warnings, snapshotEntries };
}
```

Export from `packages/shared/src/tools/index.ts`:

```typescript
export { resolveToolLinks } from './resolve-tool-links.js';
export type {
  ToolLink as ToolLinkInput,
  ResolveToolLinksInput,
  ResolveToolLinksResult,
  ToolLinkSnapshotEntry,
  ValidationDiagnostic as ToolLinkDiagnostic,
} from './resolve-tool-links.js';
```

**Step 4: Run test to verify it passes**

Run: `cd packages/shared && pnpm vitest run src/__tests__/resolve-tool-links.test.ts`
Expected: PASS

**Step 5: Commit**

```bash
git add packages/shared/src/tools/resolve-tool-links.ts packages/shared/src/tools/index.ts packages/shared/src/__tests__/resolve-tool-links.test.ts
git commit -m "feat(shared): add resolveToolLinks batch resolver for USE TOOL declarations"
```

---

### Task 6: Wire resolveToolLinks into version-service

**Files:**

- Modify: `apps/runtime/src/services/version-service.ts:199-326`
- Test: Manual — existing version-service tests cover the flow

**Step 1: Read the current code to understand exact insertion points**

Read `apps/runtime/src/services/version-service.ts` lines 199-340 fully.

**Step 2: Modify version-service to use resolveToolLinks for USE TOOL declarations**

After the parse step (line 205) and before the compile step (line 213), add tool link resolution:

```typescript
// Resolve USE TOOL: links from parsed AST
let resolvedToolLinks: Map<string, any[]> | undefined;
let toolLinkSnapshot: any[] = [];
const parsedDoc = parseResult.document!;
if (parsedDoc.toolLinks && parsedDoc.toolLinks.length > 0) {
  try {
    const { resolveToolLinks } = await import('@agent-platform/shared/tools');
    const linkResult = await resolveToolLinks({
      tenantId,
      projectId,
      linksByAgent: new Map([[parsedDoc.name, parsedDoc.toolLinks]]),
    });

    // If resolution produced errors, return them as compile errors
    if (linkResult.errors.length > 0) {
      const errors = linkResult.errors.map((e) => `${e.code}: ${e.message}`);
      log.warn('Tool link resolution failed', { projectId, agentName, errors });
      return { versionId: '', version, sourceHash: '', compileErrors: errors };
    }

    if (linkResult.warnings.length > 0) {
      toolWarnings.push(...linkResult.warnings);
    }

    resolvedToolLinks = linkResult.resolvedByAgent;
    toolLinkSnapshot = linkResult.snapshotEntries;
  } catch (err) {
    log.warn('Failed to resolve tool links', { error: (err as Error).message });
    return {
      versionId: '',
      version,
      sourceHash: '',
      compileErrors: [`Failed to resolve USE TOOL declarations: ${(err as Error).message}`],
    };
  }
}
```

Modify the `compileABLtoIR` call to pass `resolvedToolLinks`:

```typescript
const compilerOpts = {
  ...compilerOptions,
  ...(resolvedToolLinks ? { resolvedToolLinks } : {}),
};
compilationOutput = compileABLtoIR([parseResult.document], compilerOpts);
```

In the tool snapshot building section (~line 309-318), merge the link snapshot:

```typescript
// Merge explicit tool link snapshot with implicit snapshot
if (toolLinkSnapshot.length > 0) {
  toolVersionSnapshot = [...(toolVersionSnapshot ?? []), ...toolLinkSnapshot];
}
```

**Step 3: Build and run existing version-service tests**

Run: `pnpm build && cd apps/runtime && pnpm vitest run`
Expected: PASS — existing tests still work (they don't use USE TOOL syntax)

**Step 4: Commit**

```bash
git add apps/runtime/src/services/version-service.ts
git commit -m "feat(runtime): wire resolveToolLinks into version-service for USE TOOL compilation"
```

---

### Task 7: Add slug immutability guard on Tool model

**Files:**

- Modify: `packages/database/src/models/tool.model.ts`
- Test: `packages/shared/src/__tests__/tool-repo.test.ts` (add case)

**Step 1: Write the failing test**

Add to `packages/shared/src/__tests__/tool-repo.test.ts`:

```typescript
describe('slug immutability', () => {
  test('rejects slug change on existing tool', async () => {
    // Setup: create a tool, then try to change its slug
    const { Tool } = await import('@agent-platform/database/models');
    const tool = await Tool.create({
      tenantId: 'test-tenant',
      projectId: 'test-project',
      name: 'Test Tool',
      slug: 'test_tool',
      toolType: 'http',
      source: 'manual',
    });

    tool.slug = 'changed_slug';
    await expect(tool.save()).rejects.toThrow(/slug cannot be changed/i);

    // Cleanup
    await Tool.deleteOne({ _id: tool._id });
  });
});
```

**Step 2: Run test to verify it fails**

Run: `cd packages/shared && pnpm vitest run src/__tests__/tool-repo.test.ts`
Expected: FAIL — slug change is currently allowed

**Step 3: Add pre-save hook**

In `packages/database/src/models/tool.model.ts`, before the index definitions (~line 54):

```typescript
// ─── Guards ──────────────────────────────────────────────────────────────

ToolSchema.pre('save', function () {
  if (!this.isNew && this.isModified('slug')) {
    throw new Error('Tool slug cannot be changed after creation');
  }
});
```

**Step 4: Run test to verify it passes**

Run: `cd packages/shared && pnpm vitest run src/__tests__/tool-repo.test.ts`
Expected: PASS

**Step 5: Commit**

```bash
git add packages/database/src/models/tool.model.ts packages/shared/src/__tests__/tool-repo.test.ts
git commit -m "fix(database): enforce slug immutability on Tool model"
```

---

### Task 8: Build and run full test suite

**Step 1: Build all packages**

Run: `pnpm build`
Expected: Clean build

**Step 2: Run all tests**

Run: `pnpm test`
Expected: All tests pass

**Step 3: Commit any build fixes**

If build revealed issues, fix and commit each individually.

---

## Phase 2: Integration & Migration (Tasks 9–12)

### Task 9: Update topology API to resolve tool links

**Files:**

- Modify: `apps/studio/src/app/api/projects/[id]/topology/route.ts`

**Step 1:** Read the topology route to understand current compile flow.

**Step 2:** After parsing documents, extract `toolLinks` and call `resolveToolLinks()`. Pass results to `compileABLtoIR()` via `resolvedToolLinks` option. Handle failures gracefully (return partial topology with warnings).

**Step 3:** Commit.

```bash
git commit -m "feat(studio): resolve USE TOOL links in topology API"
```

---

### Task 10: Add deprecation warnings for implicit DB tool injection

**Files:**

- Modify: `apps/runtime/src/services/version-service.ts`

**Step 1:** In the existing implicit injection block (lines 253-326), after merging `shared_tools`, emit a W801 warning for each DB tool that was implicitly injected and not declared via `USE TOOL`:

```typescript
// For each implicitly injected tool, warn about future removal
for (const dbTool of dbTools) {
  toolWarnings.push(
    `W801: Tool '${dbTool.name}' was implicitly injected. Add 'USE TOOL: ${dbTool.name}' to your TOOLS section.`,
  );
}
```

**Step 2:** Commit.

```bash
git commit -m "feat(runtime): emit W801 deprecation warnings for implicit DB tool injection"
```

---

### Task 11: Extend AgentVersion.toolVersionSnapshot with slug and alias

**Files:**

- Modify: `packages/database/src/models/agent-version.model.ts:25-31`
- Modify: `packages/shared/src/repos/tool-version-repo.ts` (`buildSnapshotFromPairs`)

**Step 1:** Update the `IAgentVersion` interface to include `slug` and `alias` in the snapshot array entries.

**Step 2:** Update `buildSnapshotFromPairs` to accept and include `slug` and `alias` fields.

**Step 3:** Existing snapshots without these fields remain valid (fields are optional/nullable).

**Step 4:** Commit.

```bash
git commit -m "feat(database): extend toolVersionSnapshot with slug and alias fields"
```

---

### Task 12: Add `toolLinkingMode` to AgentVersion

**Files:**

- Modify: `packages/database/src/models/agent-version.model.ts`
- Modify: `apps/runtime/src/services/version-service.ts`

**Step 1:** Add `toolLinkingMode: 'implicit' | 'explicit'` field to `IAgentVersion` schema (default: `'implicit'`).

**Step 2:** In version-service, set `toolLinkingMode: 'explicit'` when the agent has `toolLinks`, `'implicit'` otherwise.

**Step 3:** Commit.

```bash
git commit -m "feat(database): add toolLinkingMode to AgentVersion for runtime backward compat"
```

---

## Phase 3: UX & Polish (Tasks 13–15)

### Task 13: DSL editor autocomplete for USE TOOL

**Files:**

- Modify: `apps/studio/src/components/abl/ABLEditor.tsx`

Provide slug autocomplete when cursor is after `USE TOOL:`. Fetch project tools via API. Show tool type icon and published version. This is a UI-only change — no backend.

---

### Task 14: Stale tool warning on agent overview

**Files:**

- Modify: `apps/studio/src/components/agents/AgentOverviewTab.tsx`

When loading agent overview, compare `toolVersionSnapshot` against current published versions. Show banner if any floating link is stale.

---

### Task 15: Tool snapshot delta in version diff view

**Files:**

- Modify: `apps/studio/src/components/agents/VersionListTab.tsx`

When comparing two versions, include a `toolVersionSnapshot` diff section showing added/removed/changed tools.

---

## Execution Checklist

| Task | Description                               | Phase | Depends On |
| ---- | ----------------------------------------- | ----- | ---------- |
| 1    | ToolLink type on AST                      | 1     | —          |
| 2    | Parse USE TOOL syntax                     | 1     | 1          |
| 3    | CompilerOptions.resolvedToolLinks + merge | 1     | 1          |
| 4    | Batch slug lookup repo function           | 1     | —          |
| 5    | resolveToolLinks() function               | 1     | 4          |
| 6    | Wire into version-service                 | 1     | 2, 3, 5    |
| 7    | Slug immutability guard                   | 1     | —          |
| 8    | Full build + test suite                   | 1     | 1–7        |
| 9    | Topology API integration                  | 2     | 5          |
| 10   | W801 deprecation warnings                 | 2     | 6          |
| 11   | Snapshot slug/alias fields                | 2     | 5          |
| 12   | toolLinkingMode on AgentVersion           | 2     | 6          |
| 13   | DSL editor autocomplete                   | 3     | 2          |
| 14   | Stale tool warning UI                     | 3     | 11         |
| 15   | Version diff snapshot delta               | 3     | 11         |

**Independent tasks (can run in parallel):** 1+4+7, then 2+3+5 after 1+4, then 6 after all.

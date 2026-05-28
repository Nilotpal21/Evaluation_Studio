# Import Tools with Agents — Plan & Release Notes

**Ticket:** ABLP-2
**Branch:** `fix/import-tools-with-agents`
**Date:** 2026-03-12 / 2026-03-13
**Status:** Implemented

---

## Problem Statement

When importing an ABL project (agents + tools), the platform only previewed and persisted **agents**. Tool files (`.tools.abl`) were read and validated during import but never stored as `ProjectTool` documents. This meant:

1. Imported tools did not appear in the project's tool list
2. Agents referencing imported tools could not resolve them at runtime
3. The import preview showed no tool changes to the user
4. Re-importing a project showed all tools as "new" every time (no diff against existing)

Additionally, after fixing tool persistence, a secondary bug was discovered: the tool configuration tab in Studio showed **"Unable to parse tool configuration. Showing raw DSL."** for all imported tools.

---

## Root Cause Analysis

### Gap 1: Tools Never Persisted (5 missing pieces)

The import pipeline had infrastructure for tools at every layer but never connected the final write:

| Layer                    | What Existed                                                     | What Was Missing                                          |
| ------------------------ | ---------------------------------------------------------------- | --------------------------------------------------------- |
| **Folder reader**        | `toolFiles: Map<string, string>` populated                       | Nothing — worked fine                                     |
| **Validator**            | Tool dependencies validated, refs checked                        | Nothing — worked fine                                     |
| **Preview**              | `ImportPreview.changes.tools` in response type                   | Routes passed `toolFiles: new Map()` — tools always empty |
| **Applier**              | `ApplyOperation` for agents only                                 | No `ToolApplyOperation` type or function                  |
| **Route handlers**       | `getModelForCollection('project_tools')` mapped to `ProjectTool` | No code to actually call create/update/delete             |
| **Staged importer (v2)** | `StagedRecord` infrastructure with collection routing            | Only agent records built — no tool records                |
| **UI**                   | `ImportDialog` showed agent changes                              | No tool section in preview                                |

### Gap 2: Tool Config Tab Showed Raw DSL

**Root cause:** Two incompatible DSL formats.

The `.tools.abl` **file format** wraps tools in a `TOOLS:` block with shared defaults:

```
TOOLS:                                          ← file-level header
  base_url: "https://api.example.com"           ← shared defaults
  timeout: 60000

  my_tool(param: string) -> {result: string}    ← tool signature
    type: sandbox                               ← tool properties
    code: |
      return "done";
```

But `ProjectTool.dslContent` (what the UI reads) expects **single-tool DSL** starting with the signature:

```
my_tool(param: string) -> {result: string}      ← starts here
  type: sandbox
  code: |
    return "done";
```

The UI parser (`parseDslToToolForm` in `packages/shared/src/tools/parse-dsl-to-tool-form.ts`) does:

```typescript
const firstLine = dslContent.split('\n')[0]?.trim() ?? '';
const nameMatch = firstLine.match(/^(\w+)\s*\(/); // expects "toolName("
if (!name) return null; // ← returns null → fallback to raw DSL display
```

When `dslContent` stored the full file, `firstLine` was `"TOOLS:"` — which doesn't match `\w+\(`, so parsing failed silently and the UI showed the raw DSL fallback.

---

## Architecture Decisions

### Decision 1: One ProjectTool per tool, not per file

A single `.tools.abl` file can define multiple tools (e.g., the old `healthcare-api.tools.abl` had 4). We chose to create one `ProjectTool` document per individual tool, matching how the individual tool creation endpoint works. This enables:

- Per-tool visibility in the UI
- Per-tool editing
- Granular diff detection on re-import

### Decision 2: Per-tool DSL extraction, not full-file storage

Instead of storing the entire `.tools.abl` file as each tool's `dslContent`, we extract each tool's section (signature + indented properties) from the raw file. This produces DSL compatible with the existing UI parser without requiring any changes to the parser itself.

The extraction algorithm (`extractToolDslSections`) finds each tool signature line in the file, then collects all following lines with deeper indentation. Empty lines between tool properties are skipped. The result is a clean, standalone DSL string for each tool.

### Decision 3: Full 64-char SHA-256 for sourceHash

The existing `computeSourceHash()` in `project-io/export` returns a **16-char truncated** SHA-256. But `ProjectTool.sourceHash` schema validates against `/^[a-f0-9]{64}$/`. We use `createHash('sha256').update(content, 'utf8').digest('hex')` directly (full 64-char) to satisfy the schema constraint.

### Decision 4: Name-level preview, not file-level

The old preview showed file paths (`tools/healthcare-api.tools.abl`). The new preview shows individual tool names with type badges (`perform_provider_authentication [sandbox]`). This gives users clear visibility into exactly which tools will be added, modified, or removed.

---

## What Changed

### New Files

| File                                                             | Purpose                                                                             |
| ---------------------------------------------------------------- | ----------------------------------------------------------------------------------- |
| `packages/project-io/src/import/tool-extractor.ts`               | Parses `.tools.abl` files into individual `ExtractedTool` entries with per-tool DSL |
| `packages/project-io/src/__tests__/tool-extractor.test.ts`       | 11 tests covering extraction, multi-tool files, type inference, DSL isolation       |
| `packages/project-io/src/__tests__/import-applier-tools.test.ts` | 5 tests covering tool CRUD operation computation                                    |

### Modified Files

| File                                                            | Change                                                                                                                                       |
| --------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------- |
| `packages/project-io/package.json`                              | Added `@abl/core` dependency (for `parseToolFile`)                                                                                           |
| `packages/project-io/src/types.ts`                              | `ImportPreview.changes.tools` now uses `Array<{ name, toolType, sourceFile }>` instead of `string[]`                                         |
| `packages/project-io/src/import/import-applier.ts`              | Added `ToolApplyOperation`, `ToolApplyInput`, `computeToolApplyOperations()`                                                                 |
| `packages/project-io/src/import/project-importer.ts`            | Wired tool extraction + operations into `importProject()`, added `toolOperations` to `ImportResult`, added `tools` to `ExistingProjectState` |
| `packages/project-io/src/import/index.ts`                       | Exported new tool-extractor and tool-applier types                                                                                           |
| `packages/project-io/src/__tests__/project-importer.test.ts`    | Added 2 tests for tool operations in import result                                                                                           |
| `apps/studio/src/app/api/projects/[id]/import/preview/route.ts` | Loads existing tools from `ProjectTool` for accurate diffs                                                                                   |
| `apps/studio/src/app/api/projects/[id]/import/apply/route.ts`   | **v1:** Persists tools (insertMany/bulkWrite/deleteMany) with rollback. **v2:** Builds tool `StagedRecord` entries                           |
| `apps/runtime/src/routes/project-io.ts`                         | Same tool loading + persistence for runtime preview and apply routes                                                                         |
| `apps/studio/src/components/projects/ImportDialog.tsx`          | Added "Tools" section showing tool names with type badges                                                                                    |
| `apps/studio/src/api/project-io.ts`                             | Updated `ImportPreviewResponse` type for new tool shape                                                                                      |
| `packages/kore-platform-cli/src/commands/import.ts`             | Fixed type for new object-based tool arrays                                                                                                  |

---

## Implementation Details

### Chunk 1: Core Import Logic (`packages/project-io`)

#### tool-extractor.ts

The central new module. Key functions:

- **`extractToolsFromFiles(toolFiles)`** — Main entry point. For each `.tools.abl` file:
  1. Parses with `parseToolFile()` from `@abl/core` (validates syntax, extracts tool AST)
  2. Extracts per-tool DSL sections from the raw file text via `extractToolDslSections()`
  3. Infers `ProjectToolType` via `inferToolType()` (checks explicit type → binding objects → defaults to 'http')
  4. Returns `ExtractedTool[]` with per-tool `dslContent` (not full file)

- **`extractToolDslSections(content)`** — Finds each tool signature line (`toolName(params) -> return`), collects all indented lines below it, strips the base indentation. Handles:
  - Multiple tools in one file (stops at next tool's signature)
  - Empty lines between properties (skipped)
  - Code blocks with `|` pipe syntax (preserved via indentation tracking)
  - `TOOLS:` header and shared defaults (excluded from per-tool DSL)

- **`inferToolType(tool)`** — Priority: explicit `type` field → binding objects (`sandboxBinding`, `mcpBinding`, `httpBinding`) → default `'http'`

#### import-applier.ts

Added alongside existing `computeApplyOperations`:

- **`computeToolApplyOperations(input)`** — Diffs imported tools against existing tools by name + dslContent. Returns `ToolApplyOperation[]` with `'create'`, `'update'`, or `'delete'` types.

#### project-importer.ts

Wired into `importProject()`:

- Step 4b: Extract tools from `folderResult.toolFiles`
- Step 6b: Compute tool apply operations
- Step 7: Build name-level tool diffs for preview (replaces old file-level diffs)
- Return: Added `toolOperations` to `ImportResult`
- Added `tools?: Map<string, { name, dslContent }>` to `ExistingProjectState`

### Chunk 2: Route Handlers

All 4 route handlers received the same pattern of fixes:

1. **Load existing tools** — `ProjectTool.find({ projectId, tenantId })` in parallel with agent load
2. **Pass to importer** — `existingState.tools = new Map(...)` enables accurate diffs
3. **Persist tools** (apply routes only):
   - `ProjectTool.insertMany()` for creates
   - `ProjectTool.bulkWrite()` for updates
   - `ProjectTool.deleteMany()` for deletes
4. **Rollback support** — Track `createdToolIds`, delete on failure alongside agents
5. **v2 staged path** — Build `StagedRecord` with `collection: 'project_tools'`

### Chunk 3: Frontend UI

`ImportDialog.tsx` now shows a "Tools" section in the preview with:

- Tool name in bold
- Type badge (`sandbox`, `http`, `mcp`)
- Status badge (New / Modified / Deleted)
- Included in `totalChanges` count (affects Apply button state)

---

## Multi-Tool File Support

A single `.tools.abl` file with multiple tool signatures is fully supported:

```
TOOLS:
  base_url: "https://api.example.com"

  tool_a(x: string) -> object     ← extracted as separate ProjectTool
    type: http
    endpoint: "/a"

  tool_b(y: number) -> string     ← extracted as separate ProjectTool
    type: sandbox
    code: |
      return String(y);
```

This produces:

- **2 `ProjectTool` documents** (one per tool)
- **2 entries in import preview** (each with name + type)
- **2 separate `dslContent` values** (each starting with its own signature, no cross-contamination)

---

## Test Coverage

| Test File                      | Tests      | What It Covers                                                                                                                       |
| ------------------------------ | ---------- | ------------------------------------------------------------------------------------------------------------------------------------ |
| `tool-extractor.test.ts`       | 11         | Multi-tool extraction, sandbox/http/mcp type inference, per-tool DSL isolation, sourceHash format, parse error handling, empty input |
| `import-applier-tools.test.ts` | 5          | Create/update/delete/skip-unchanged/mixed operations                                                                                 |
| `project-importer.test.ts`     | 15 (2 new) | Tool operations in import result, tool names in preview                                                                              |

**Regression check:** Full project-io suite: **1004 tests pass, 57 test files, 0 failures**.

---

## Verification Results

| Check                                                                  | Result                   |
| ---------------------------------------------------------------------- | ------------------------ |
| `pnpm build --filter=@abl/core --filter=@agent-platform/project-io`    | Pass                     |
| `pnpm build --filter=@agent-platform/studio`                           | Pass                     |
| `pnpm build --filter=@agent-platform/runtime`                          | Pass                     |
| `pnpm build --filter=@agent-platform/cli`                              | Pass                     |
| `pnpm vitest run packages/project-io/` (all 57 test files)             | 1004/1004 pass           |
| `npx tsc --noEmit -p packages/project-io/tsconfig.json`                | Clean                    |
| Multi-tool file extraction (3 tools from 1 file)                       | Verified via node script |
| Example project files parse correctly (`aih4-payer/tools/*.tools.abl`) | 4 files, 0 errors        |

---

## Manual Testing Checklist

- [ ] Start runtime + studio
- [ ] Create a project with agents only
- [ ] Export the project
- [ ] Add tool files to the exported zip
- [ ] Re-import — verify preview shows individual tool names with type badges
- [ ] Apply import — verify `project_tools` collection has documents
- [ ] Open a tool — verify configuration tab renders form (not raw DSL)
- [ ] Re-import same project — verify tools show as "unchanged"
- [ ] Modify a tool file and re-import — verify tools show as "modified"
- [ ] Import a multi-tool file — verify each tool appears as separate entry

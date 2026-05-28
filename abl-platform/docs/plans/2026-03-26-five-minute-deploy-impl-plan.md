# Five-Minute Deploy — Implementation Plan

> **Date:** 2026-03-26
> **Status:** DRAFT
> **Scope:** 36 issues across 4 tiers (deploy blockers, error UX, docs, runtime)
> **Branch:** `develop`

---

## Status Matrix (Post-Session-1 Fixes)

| #     | Issue                                      | Status    | Notes                                 |
| ----- | ------------------------------------------ | --------- | ------------------------------------- |
| 1     | CLI default URL → `agents.kore.ai`         | **FIXED** | config.ts defaults updated            |
| 2     | MCP tools hardcoded `localhost`            | **FIXED** | `deriveStudioUrl()` + origin headers  |
| 3     | Auto-generate `project.json` if missing    | OPEN      | Tier 1                                |
| 4     | CLI import uses v1 Runtime routes          | **FIXED** | Rewritten for v2 Studio routes        |
| 5     | Import not idempotent                      | OPEN      | Tier 1 — desired-state reconciliation |
| 6     | No `agents list/delete` CLI                | **FIXED** | Already in `agents.ts`                |
| 7     | No `agents update` CLI                     | **FIXED** | Already in `agents.ts`                |
| 8     | No `tools create/list/delete` CLI          | OPEN      | Tier 1                                |
| 9     | Agent PATCH accepts `dslContent`           | OPEN      | Tier 4 (part of idempotent import)    |
| 10    | `ON_START` fires every turn                | OPEN      | Tier 4                                |
| 11    | Import auto-creates Tool Library entries   | OPEN      | Tier 1                                |
| 12    | Inline `BEHAVIOR_PROFILE:` destroys agent  | OPEN      | Tier 2                                |
| 13    | Surface compilation errors in API          | OPEN      | Tier 2                                |
| 14    | Full error chain in responses              | OPEN      | Tier 2                                |
| 15-21 | Documentation gaps                         | OPEN      | Tier 3                                |
| 22-28 | AI instruction updates                     | OPEN      | Tier 3                                |
| 29    | `validate` command                         | OPEN      | Tier 2 (uses preview endpoint)        |
| 30    | Import preview runs `compileABLtoIR()`     | OPEN      | Tier 2                                |
| 31    | Parser validates ESCALATE PRIORITY integer | OPEN      | Tier 2                                |
| 32    | Fuzzy-match case-sensitive keywords        | OPEN      | Tier 2                                |
| 33-36 | Extended docs                              | OPEN      | Tier 3                                |

---

## Critical Finding: v2 Staged Import Is Fundamentally Broken

**Verified on 2026-03-26.** The v2 staged import (`StagedImporter`) cannot work as designed:

| #   | Gap                                                             | Where                                       | Impact                                                             |
| --- | --------------------------------------------------------------- | ------------------------------------------- | ------------------------------------------------------------------ |
| 1   | `status` field missing from `ProjectAgent` schema               | `project-agent.model.ts`                    | Mongoose `strict: true` silently strips `status: 'staged'` on save |
| 2   | Unique index `{tenantId, projectId, name}` blocks staged insert | Same file, indexes                          | `insertMany` crashes with duplicate key when active record exists  |
| 3   | `agentPath` unique index — same problem                         | Same file                                   | Second unique index also blocks                                    |
| 4   | Same gaps on `ProjectTool` schema                               | `project-tool.model.ts`                     | No `status` field, unique indexes block                            |
| 5   | Runtime `findProjectWithAgents` doesn't filter by status        | `apps/runtime/src/repos/project-repo.ts:53` | Would pick up staged/superseded records                            |
| 6   | Studio agent listing doesn't filter by status                   | `apps/studio/.../agents/route.ts`           | Same problem                                                       |

**Decision: Abandon v2 staged import. Use direct upsert approach.**

The v1 `import-applier.ts` computes explicit `create/update/delete` operations without needing a `status` field. This:

- Works with existing schemas and indexes (no migration needed)
- Matches the "desired state" (Terraform) model the user wants
- Avoids a high-blast-radius schema change across the entire codebase
- Is simpler and more reliable

Pre-import snapshots via `exportProjectV2()` provide rollback safety, replacing the staged import's rollback mechanism.

---

## Architecture Decisions

### AD-1: Idempotent Import = Direct Upsert (Not Staged)

The import endpoint becomes a single declarative operation:

1. **Snapshot** — export current project state for rollback (`exportProjectV2()`)
2. **Parse** — extract agents, tools, manifest from uploaded files
3. **Diff** — compare imported entities against current state by `name` using `computeApplyOperations()`
4. **Apply** — direct MongoDB operations:
   - `create`: `Model.create(data)` for new entities
   - `update`: `Model.findOneAndUpdate({ projectId, tenantId, name }, { $set: data })` for existing (preserves `_id`)
   - `delete`: `Model.deleteMany({ _id: { $in: ids } })` only if `deleteUnmatched: true`
5. **Configure** — set `entryAgentName` from manifest
6. **Record** — save operation result with snapshot reference for revert

No `status` field needed. No index changes. No query changes across the codebase.

### AD-2: Pre-Import Versioning (Snapshot + Revert)

Before any import mutation:

1. Load current project state (agents, tools, settings)
2. Call `exportProjectV2()` to produce a complete file map + manifest + lockfile
3. Store compressed snapshot on the `ImportOperation` document (new `preImportSnapshot` field)
4. If import fails or user wants to revert: feed snapshot back through the import pipeline with `deleteUnmatched: true`

Snapshot retention: 30 days (TTL index on `ImportOperation.expiresAt` already exists, extend from 1hr to 30d for completed operations).

### AD-3: Tool Auto-Creation from DSL Signatures

Agent DSL `TOOLS:` sections declare full signatures. Import will:

1. Parse agent files, extract `AgentTool[]` from each agent's `TOOLS:` section
2. Deduplicate across all agents (same tool name = same tool)
3. For each tool not in the Tool Library, create a `ProjectTool` with:
   - Full type signature from DSL (name, params with types, return type)
   - `toolType: 'http'` (default placeholder)
   - `dslContent` synthesized from signature + placeholder `endpoint: "https://TODO-configure-endpoint"`
4. Return `W_TOOL_STUB` warnings for each auto-created tool

### AD-4: ON_START — Session-Level Idempotency Fix

Root cause: distributed session rehydration can reset `initialized: false`. Fix:

1. Persist `initialized` explicitly in Redis hash on every save
2. Default rehydration to `true` (sessions exist only if initialized)
3. Add `initializedAt` timestamp for debugging
4. Guard lazy-init path with Redis `SET NX` distributed lock

### AD-5: Inline BEHAVIOR_PROFILE — Context-Aware Parsing

When `BEHAVIOR_PROFILE:` appears inside an `AGENT:` document:

- Parse as inline profile definition stored on `doc.inlineBehaviorProfiles`
- Do NOT overwrite `doc.name`, `doc.meta.kind`, or skip remaining lines
- Compiler auto-attaches inline profiles to the agent

---

## Tier 1 — Unblocks 5-Minute Deploy

### Phase 1.0: Pre-Import Versioning (Snapshot + Revert)

**Packages:** `project-io`, `database`, `studio`
**Why first:** Every subsequent import change needs rollback safety.

**Files:**

| File                                                           | Change                                                      |
| -------------------------------------------------------------- | ----------------------------------------------------------- |
| `packages/database/src/models/import-operation.model.ts`       | Add `preImportSnapshot` field (compressed JSON), extend TTL |
| `packages/project-io/src/import/project-importer-v2.ts`        | Call export before mutations, store snapshot                |
| `apps/studio/src/app/api/projects/[id]/import/apply/route.ts`  | Snapshot before apply                                       |
| `apps/studio/src/app/api/projects/[id]/import/revert/route.ts` | NEW — revert to snapshot                                    |

**Implementation:**

1. **Extend `ImportOperation` model:**

   ```typescript
   preImportSnapshot: {
     type: Schema.Types.Mixed,  // { files: Record<string, string>, manifest: object }
     default: undefined,
   },
   ```

   - Change `IMPORT_OPERATION_TTL_SECONDS` from 3600 to 30 days for `status: 'completed'`
   - Keep 1hr TTL for `status: 'failed'`

2. **Snapshot before apply in the route:**
   - After loading existing agents/tools but before mutations
   - Call existing `exportProjectV2()` with current project data
   - Compress the file map with `gzip` (async, per platform principles)
   - Store on the `ImportOperation` record

3. **Revert endpoint** (`POST /api/projects/:id/import/revert`):
   - Accept `{ operationId: string }`
   - Load `ImportOperation` by ID, extract `preImportSnapshot`
   - Decompress, feed through import pipeline with `deleteUnmatched: true`
   - Creates its own snapshot (so revert-of-revert works)

**Exit criteria:**

- [ ] Every import creates a snapshot of pre-import state
- [ ] `POST /import/revert` restores the project to pre-import state
- [ ] Reverting a revert works (snapshot chain)
- [ ] Snapshots expire after 30 days

### Phase 1.1: Idempotent Import (Direct Upsert)

**Packages:** `project-io`, `studio`
**Replaces the broken v2 staged import with direct upsert operations.**

**Files:**

| File                                                            | Change                                                      |
| --------------------------------------------------------------- | ----------------------------------------------------------- |
| `packages/project-io/src/import/import-applier.ts`              | Extend with `sourceHash` comparison for unchanged detection |
| `apps/studio/src/app/api/projects/[id]/import/apply/route.ts`   | Replace staged import with direct upsert flow               |
| `apps/studio/src/app/api/projects/[id]/import/preview/route.ts` | Return create/update/delete/unchanged counts                |

**Implementation:**

1. **Extend `import-applier.ts`:**
   - Add `sourceHash` to `ApplyInput.existingAgents` to detect unchanged agents
   - Add `'unchanged'` to `ApplyOperation.type` union
   - Same for `ToolApplyInput` / `ToolApplyOperation`

2. **Rewrite apply route** (replace `StagedImporter` usage):

   ```
   // 1. Parse files (existing: stripCommonPrefix → migrateV1ToV2 → readFolderV2)
   // 2. Create snapshot (Phase 1.0)
   // 3. Load existing agents + tools
   // 4. Compute diff via computeApplyOperations()
   // 5. Execute operations directly:
   for (op of operations) {
     if (op.type === 'create')  → ProjectAgent.create({ projectId, tenantId, name, dslContent, ... })
     if (op.type === 'update')  → ProjectAgent.findOneAndUpdate({ projectId, tenantId, name }, { $set: { dslContent, sourceHash, lastEditedBy } })
     if (op.type === 'delete')  → ProjectAgent.deleteOne({ _id: existingId })  // only if deleteUnmatched
   }
   // 6. Same for tools
   // 7. Set entryAgentName from manifest
   // 8. Record operation result
   ```

3. **Accept `deleteUnmatched` flag** in request body (default `false`):
   - When `false`: agents in project but not in import are left alone
   - When `true`: agents in project but not in import are deleted

4. **Set `entryAgentName` from manifest:**
   - Read `entry_agent` from parsed manifest
   - `Project.findOneAndUpdate({ _id: projectId, tenantId }, { $set: { entryAgentName } })`

5. **Return structured result:**

   ```json
   {
     "success": true,
     "operationId": "...",
     "applied": {
       "agents": { "created": 2, "updated": 1, "deleted": 0, "unchanged": 0 },
       "tools": { "created": 3, "updated": 0, "deleted": 0, "unchanged": 0 }
     },
     "warnings": [...],
     "entryAgentName": "MainAgent"
   }
   ```

6. **Preview route** returns the same breakdown without executing:
   ```json
   {
     "success": true,
     "preview": {
       "agents": { "created": [...], "updated": [...], "deleted": [...], "unchanged": [...] },
       "tools": { "created": [...], "updated": [...], "deleted": [...], "unchanged": [...] }
     },
     "entryAgentName": "MainAgent"
   }
   ```

**Exit criteria:**

- [ ] Importing the same zip twice produces zero changes on second run (all `unchanged`)
- [ ] Importing a modified agent updates it in-place (preserves `_id`)
- [ ] `deleteUnmatched: true` removes agents not in the payload
- [ ] `entryAgentName` is set from `project.json` `entry_agent`
- [ ] Preview accurately predicts what apply will do
- [ ] No duplicate key errors (works with existing unique indexes)
- [ ] No `status` field needed on models

### Phase 1.2: Tool Auto-Creation from DSL Signatures

**Packages:** `project-io`, `studio`

**Files:**

| File                                                          | Change                                           |
| ------------------------------------------------------------- | ------------------------------------------------ |
| `packages/project-io/src/import/tool-signature-extractor.ts`  | NEW — extract tool signatures from agent DSL     |
| `packages/project-io/src/import/tool-stub-synthesizer.ts`     | NEW — synthesize ProjectTool DSL from signatures |
| `apps/studio/src/app/api/projects/[id]/import/apply/route.ts` | Auto-create missing tools during import          |

**Implementation:**

1. **Extract tool signatures from agent DSL:**
   - Parse each agent file with the existing parser
   - Collect all `AgentTool` AST nodes from `doc.tools`
   - Deduplicate across agents (same tool name = same tool; keep richest signature)

2. **Synthesize tool DSL from signatures:**

   ```typescript
   function synthesizeToolDsl(tool: AgentTool): string {
     // Build signature line: name(params) -> returnType
     const params = tool.parameters
       .map((p) => `${p.name}${p.required ? '' : '?'}: ${p.type}`)
       .join(', ');
     const returns = formatReturnType(tool.returns);
     let dsl = `${tool.name}(${params}) -> ${returns}\n`;
     dsl += `  description: "${tool.description ?? 'Auto-created from agent DSL import'}"\n`;
     dsl += `  type: ${tool.type ?? 'http'}\n`;
     dsl += `  endpoint: "https://TODO-configure-endpoint"\n`;
     dsl += `  method: POST\n`;
     // Add parameter descriptions if available
     for (const p of tool.parameters) {
       if (p.description) {
         dsl += `  params:\n    ${p.name}:\n      description: "${p.description}"\n`;
       }
     }
     return dsl;
   }
   ```

3. **Diff against existing Tool Library** in the apply route:
   - Query `ProjectTool.find({ projectId, tenantId })` for existing tools
   - Build `existingTools: Map<name, { name, dslContent }>` for `computeToolApplyOperations()`
   - Tools from DSL signatures that don't exist → `create` operations
   - Tools from DSL that already exist → leave unchanged (don't overwrite user-configured implementations)

4. **Return warnings:**
   ```json
   {
     "code": "W_TOOL_STUB",
     "tool": "get_weather",
     "message": "Auto-created tool stub — configure endpoint and auth in Tool Library"
   }
   ```

**Exit criteria:**

- [ ] Import with agents declaring 3 tools auto-creates all 3 in Tool Library
- [ ] Second import does not duplicate tools (matched by name)
- [ ] Auto-created tools have full type signatures from DSL
- [ ] Existing tools with real implementations are not overwritten
- [ ] Preview shows tool stub warnings
- [ ] `compile` after import resolves tools (no E721)

### Phase 1.3: Auto-Generate project.json Manifest

**Packages:** `project-io`

**Files:**

| File                                             | Change                       |
| ------------------------------------------------ | ---------------------------- |
| `packages/project-io/src/import/v1-migration.ts` | Generate manifest if missing |

**Implementation:**

1. In `migrateV1ToV2()`, when `project.json` is not found:
   - Scan for `agents/*.agent.{abl,yaml}` files
   - Pick first agent alphabetically as `entry_agent`
   - Generate minimal v2 manifest
   - Return as `{ status: 'GENERATED_MANIFEST', ... }` with a warning
2. The v2 orchestrator treats `GENERATED_MANIFEST` same as normal v2 pass-through

**Exit criteria:**

- [ ] Directory with just agent files imports successfully
- [ ] Generated manifest correctly lists all agents found
- [ ] Preview includes warning about auto-generated manifest

### Phase 1.4: Tools CLI Commands

**Packages:** `kore-platform-cli`

**Files:**

| File                                               | Change                                      |
| -------------------------------------------------- | ------------------------------------------- |
| `packages/kore-platform-cli/src/commands/tools.ts` | NEW — `tools list/create/get/update/delete` |
| `packages/kore-platform-cli/src/index.ts`          | Register `registerToolCommands`             |

**Implementation:**

Following the existing `agents.ts` pattern:

| Command                            | API Endpoint                             | Description                             |
| ---------------------------------- | ---------------------------------------- | --------------------------------------- |
| `tools list` / `tools ls`          | GET `/api/projects/:id/tools`            | List tools with name, type, description |
| `tools get <name>`                 | GET `/api/projects/:id/tools/:toolId`    | Show tool details + DSL                 |
| `tools create <name> <file>`       | POST `/api/projects/:id/tools`           | Create from `.tools.abl` file           |
| `tools update <name> <file>`       | PUT `/api/projects/:id/tools/:toolId`    | Update DSL content                      |
| `tools delete <name>` / `tools rm` | DELETE `/api/projects/:id/tools/:toolId` | Delete tool                             |

- Tool ID resolution: list tools, find by name, use `_id` for mutation endpoints
- Use `apiRequest` directly (same as `agents.ts`)

**Exit criteria:**

- [ ] `kore tools ls` lists all project tools
- [ ] `kore tools create weather tools/weather.tools.abl` creates a tool
- [ ] `kore tools rm weather` deletes it
- [ ] `kore tools get weather` shows full DSL content

---

## Tier 2 — Better Error Experience

### Phase 2.1: Inline BEHAVIOR_PROFILE Support

**Packages:** `core` (parser), `compiler`

**Files:**

| File                                             | Change                                                |
| ------------------------------------------------ | ----------------------------------------------------- |
| `packages/core/src/parser/agent-based-parser.ts` | Context-aware `BEHAVIOR_PROFILE:` handling (line 260) |
| `packages/core/src/types/agent-based.ts`         | Add `inlineBehaviorProfiles` field                    |
| `packages/compiler/src/platform/ir/compiler.ts`  | Compile inline profiles and auto-attach               |

**Root cause:** When `BEHAVIOR_PROFILE:` appears inside an `AGENT:` document, the parser:

1. Overwrites `doc.name` with the profile name
2. Changes `doc.meta.kind` to `'behavior_profile'`
3. Sets `state.currentLine = state.lines.length` (skips all remaining content)
4. Emits zero errors — the agent silently disappears from compilation

**Implementation:**

1. **Parser change** (line 260 in `agent-based-parser.ts`):
   - When `doc.name` is already set (inside an AGENT), treat `BEHAVIOR_PROFILE:` as inline section
   - Parse via `parseBehaviorProfile()` but do NOT overwrite name/kind/skip remaining lines
   - Store on `doc.inlineBehaviorProfiles: Array<BehaviorProfileAST & { name: string }>`

2. **Fix `parseBehaviorProfile` line consumption:**
   - Currently consumes all remaining lines — change to only consume profile-specific content
   - Return consumed line count so caller can advance correctly

3. **Compiler change:**
   - After compiling agent, check `doc.inlineBehaviorProfiles`
   - Compile each via `compileBehaviorProfile()`
   - Auto-attach to agent IR as implicit `USE`d profiles

**Exit criteria:**

- [ ] Agent file with inline `BEHAVIOR_PROFILE:` keeps agent name/kind intact
- [ ] Inline profiles are compiled and attached to agent IR
- [ ] Multiple inline profiles in one agent file work
- [ ] Standalone `BEHAVIOR_PROFILE:` files still work unchanged

### Phase 2.2: Import Preview with Full Compilation

**Packages:** `studio`

**Files:**

| File                                                            | Change                                 |
| --------------------------------------------------------------- | -------------------------------------- |
| `apps/studio/src/app/api/projects/[id]/import/preview/route.ts` | Run `compileABLtoIR()` in preview mode |

**Implementation:**

1. After diff computation, parse each agent and run `compileABLtoIR({ mode: 'preview' })`
2. Collect all diagnostics (E601 missing templates, E721 missing tools, etc.)
3. Return diagnostics alongside the preview diff
4. CLI `validate` command = `kore import --dry-run` = calls preview endpoint

**Exit criteria:**

- [ ] Preview catches E721 (missing tools) before apply
- [ ] Preview catches E601 (missing templates)
- [ ] `kore validate` displays diagnostics

### Phase 2.3: Parser Improvements

**Packages:** `core`

**Files:**

| File                                             | Change                                               |
| ------------------------------------------------ | ---------------------------------------------------- |
| `packages/core/src/parser/agent-based-parser.ts` | ESCALATE PRIORITY validation, keyword fuzzy-matching |

**Implementation:**

1. **ESCALATE PRIORITY integer validation** — emit error for non-integer values
2. **Keyword case fuzzy-matching** — in the `else` fallback (unknown section), check `line.toLowerCase()` against known keywords; suggest correct casing

**Exit criteria:**

- [ ] `ESCALATE PRIORITY: high` → parse error
- [ ] `when: condition` → warning suggesting `WHEN:`

### Phase 2.4: Full Compilation Errors in API Responses

**Packages:** `studio`

Ensure compile endpoint returns the full `ValidationDiagnostic[]` array with code, severity, message, line/column, and agent name. Small change.

---

## Tier 3 — Documentation

### Phase 3.1: DSL Documentation (#15-21, #33-36)

| #   | Topic                                                                        |
| --- | ---------------------------------------------------------------------------- |
| 15  | BEHAVIOR_PROFILE patterns (standalone vs inline, USE keyword, priority/when) |
| 16  | USE keyword cross-reference syntax                                           |
| 17  | API envelope format: `{ success, [key]: data }`                              |
| 18  | Import workflow (export → modify → import, idempotent, revert)               |
| 19  | testContext format                                                           |
| 20  | Tool Library prerequisite (DSL signatures vs implementations)                |
| 21  | Deployment checklist                                                         |
| 33  | Keyword case rule (UPPERCASE)                                                |
| 34  | ESCALATE schema (integer PRIORITY, TARGET, WHEN)                             |
| 35  | TEMPLATES cross-reference                                                    |
| 36  | Example-driven DSL reference                                                 |

### Phase 3.2: AI Instruction Updates (#22-28)

| #   | Rule                                 |
| --- | ------------------------------------ |
| 22  | DSL keywords MUST be UPPERCASE       |
| 23  | ESCALATE PRIORITY must be integer    |
| 24  | Inline BEHAVIOR_PROFILE is supported |
| 25  | Don't specify MODEL: in agent DSL    |
| 26  | ON_START fires once per session      |
| 27  | Import auto-creates tool stubs       |
| 28  | Deployment sequence                  |

---

## Tier 4 — Runtime / API Changes

### Phase 4.1: Agent PATCH Accepts dslContent

**Packages:** `studio`

Extend PATCH validation to accept `dslContent: string`. When provided, update DSL and recompute `sourceHash`. Small change.

### Phase 4.2: ON_START Session-Level Fix

**Packages:** `runtime`

**Files:**

| File                                                       | Change                                                    |
| ---------------------------------------------------------- | --------------------------------------------------------- |
| `apps/runtime/src/services/session/redis-session-store.ts` | Ensure `initialized` persisted and correctly deserialized |
| `apps/runtime/src/services/session/session-state-repo.ts`  | Same for MongoDB                                          |
| `apps/runtime/src/services/runtime-executor.ts`            | Distributed lock on lazy-init path                        |

**Root cause:** Three failure modes in distributed deployments:

1. Redis rehydration defaults `initialized` to `false` when field is missing
2. MongoDB rehydration uses `|| false` which catches `undefined`
3. Race: pod B rehydrates before pod A persists `initialized: true`

**Fix:**

1. Persist `initialized` explicitly on every session save
2. Rehydration default: `true` (if session exists, it was initialized)
3. Distributed lock: `SET session:init:{id} NX PX 30000` on lazy-init
4. Add `initializedAt` timestamp for debugging

**Exit criteria:**

- [ ] ON_START fires exactly once per session, even with multi-pod rehydration
- [ ] Missing `initialized` in Redis defaults to `true`
- [ ] Concurrent `executeMessage()` on different pods don't double-fire
- [ ] Existing ON_START tests pass

---

## Implementation Order

```
Phase 1.0  Pre-import versioning          (safety net for all subsequent import changes)
  │
Phase 1.3  Auto-generate project.json     (small, unblocks bare-dir import)
  │
Phase 1.1  Idempotent import              (core change — direct upsert, not staged)
  │
Phase 1.2  Tool auto-creation             (depends on 1.1 infrastructure)
  │
Phase 1.4  Tools CLI                      (independent, can parallel with 1.2)
  │
Phase 2.1  Inline BEHAVIOR_PROFILE        (parser, independent)
  │
Phase 2.3  Parser improvements            (parser, same area)
  │
Phase 2.2  Preview with compilation       (depends on parser fixes)
  │
Phase 2.4  Full error chain               (small, extends 2.2)
  │
Phase 4.2  ON_START fix                   (runtime, independent)
  │
Phase 4.1  Agent PATCH dslContent         (small, independent)
  │
Phase 3.x  Documentation                  (after all code changes)
```

**Parallelizable groups:**

- **Group A**: Phase 1.0 → 1.3 → 1.1 → 1.2 (import pipeline, sequential)
- **Group B**: Phase 1.4 (CLI, independent)
- **Group C**: Phase 2.1 → 2.3 → 2.2 → 2.4 (parser + preview)
- **Group D**: Phase 4.2 (runtime, independent)
- **Group E**: Phase 4.1 (API, independent)

Groups B, C, D, E can all run in parallel with Group A.

---

## Commit Strategy

| Commit | Scope                                  | Type               | Packages           |
| ------ | -------------------------------------- | ------------------ | ------------------ |
| 1.0a   | ImportOperation snapshot field         | `feat(database)`   | database           |
| 1.0b   | Snapshot + revert endpoint             | `feat(studio)`     | studio             |
| 1.3    | Auto-generate manifest                 | `feat(project-io)` | project-io         |
| 1.1a   | Extend import-applier with sourceHash  | `feat(project-io)` | project-io         |
| 1.1b   | Apply route direct upsert + entryAgent | `feat(studio)`     | studio             |
| 1.2    | Tool auto-creation in import           | `feat(project-io)` | project-io, studio |
| 1.4    | Tools CLI commands                     | `feat(cli)`        | kore-platform-cli  |
| 2.1    | Inline BEHAVIOR_PROFILE                | `feat(compiler)`   | core, compiler     |
| 2.3    | Parser ESCALATE + fuzzy-match          | `feat(compiler)`   | core               |
| 2.2    | Preview compilation + validate         | `feat(studio)`     | studio             |
| 2.4    | Full diagnostics in compile            | `fix(studio)`      | studio             |
| 4.2    | ON_START fix                           | `fix(runtime)`     | runtime            |
| 4.1    | Agent PATCH dslContent                 | `feat(studio)`     | studio             |
| 3.x    | Documentation                          | `docs(platform)`   | docs only          |

All commits follow `[ABLP-2] <type>(<scope>): <description>` format with max 40 files, max 3 packages.

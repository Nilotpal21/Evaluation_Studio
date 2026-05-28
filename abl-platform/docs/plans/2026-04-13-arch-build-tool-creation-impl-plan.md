# LLD: Arch Build Phase Tool Creation & In-Project Tool Lifecycle

**Feature Spec**: `docs/features/arch-tool-lifecycle.md`
**HLD**: `docs/superpowers/specs/2026-04-12-arch-build-tool-creation-design.md`
**Test Spec**: `docs/testing/arch-tool-lifecycle.md`
**Status**: DONE
**Date**: 2026-04-13

---

## 1. Design Decisions

### Decision Log

| #    | Decision                                                                                                     | Rationale                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                    | Alternatives Rejected                                                                                        |
| ---- | ------------------------------------------------------------------------------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | ------------------------------------------------------------------------------------------------------------ |
| D-1  | Change all `handleBuildAction` cases to return `{ continueToLLM: boolean }` in one commit                    | Single call site (route.ts:4951), 8 mechanical changes. Optional return creates ambiguous API.                                                                                                                                                                                                                                                                                                                                                                                                               | Make return optional — adds `undefined` ambiguity at call site                                               |
| D-2  | `save_tool_dsl` gated by conditional tool set, not execute guard                                             | LLM should never see tools it can't use — wastes tokens and confuses model. Follows `PHASE_TOOL_MAP` pattern.                                                                                                                                                                                                                                                                                                                                                                                                | Runtime guard in execute — tool still visible to LLM                                                         |
| D-3  | Shared service is parallel path, not a route refactor                                                        | Route handler has HTTP-specific concerns (`withRouteHandler`, body schema, response formatting). One concern per commit.                                                                                                                                                                                                                                                                                                                                                                                     | Refactor existing routes to call shared service — higher blast radius                                        |
| D-4  | Do NOT validate DSL content in `save_tool_dsl`                                                               | LLM iterates drafts across turns. Completion check is key-based. CREATE-time handles validation.                                                                                                                                                                                                                                                                                                                                                                                                             | Parse before persist — blocks iterative LLM refinement                                                       |
| D-5  | `buildFormDataFromConfig` lives in `tools-ops.ts`                                                            | LLM-specific transformation. Shared service takes typed `ProjectToolFormData`. Clean separation.                                                                                                                                                                                                                                                                                                                                                                                                             | In shared service — service shouldn't know LLM config shapes                                                 |
| D-6  | Defer `map_tool_to_agent` (FR-8)                                                                             | Not in design spec. Open question unresolved. Involves ABL modification + recompilation.                                                                                                                                                                                                                                                                                                                                                                                                                     | Include in this LLD — too much scope                                                                         |
| D-7  | Separate prompt sections for BUILD:TOOLS vs IN_PROJECT                                                       | Different tools available in each context. Prevents LLM from calling `save_tool_dsl` in IN_PROJECT or `tools_ops` in BUILD.                                                                                                                                                                                                                                                                                                                                                                                  | Single combined section — confuses tool availability                                                         |
| D-8  | Turn-limit safety valve for BUILD:TOOLS via `toolDslTurnCount`                                               | If LLM hallucinate tool names, completion check never converges. 10-turn limit with warning.                                                                                                                                                                                                                                                                                                                                                                                                                 | No limit — risk infinite loop                                                                                |
| D-9  | `save_tool_dsl` name validation uses the route.ts-local `AGENT_NAME_PATTERN` (`/^[A-Za-z_][A-Za-z0-9_]*$/`)  | Must match what `extractAllTools` produces from ABL YAML — tool names preserve casing. Two patterns exist: route.ts local allows leading `_`, shared-kernel export (`/^[a-zA-Z][a-zA-Z0-9_]*$/`) does not. Use route.ts local since `save_tool_dsl` operates in the same file scope and `extractAllTools` uses `\w+` regex which accepts both. Note: leading-underscore tool names are rare but valid in the session scope; `createProjectTool` at persist-time will enforce the stricter ProjectTool regex. | ProjectTool regex `/^[a-z][a-z0-9_]{0,62}[a-z0-9]$/` — rejects `lookupOrder`, leading `_`, single-char names |
| D-10 | `continueToLLM: true` path reuses the same SSE stream (no close, no done emission)                           | SSE writer is opened once per request in route.ts. The LLM streaming path already emits `done` at route.ts:5948 when complete. Closing and reopening would require a new HTTP response.                                                                                                                                                                                                                                                                                                                      | Close + reopen — impossible in single-response SSE model                                                     |
| D-11 | Default namespace uses inline implementation (VariableNamespace import), not `getOrCreateDefaultNamespace()` | That function exists only in `apps/runtime/` and is not importable from studio. Studio tool route uses inline `findOne + create` at route.ts:118-150.                                                                                                                                                                                                                                                                                                                                                        | Import from runtime — cross-app import not allowed                                                           |
| D-12 | SSRF `templateUrlsAllowed` bypass checks `ssrf.reason` for unresolved-variable specificity                   | A raw `{{env.X}}` regex check conflates unresolvable placeholders with actual SSRF (e.g., `http://169.254.169.254/{{env.PATH}}`). Checking `reason` ensures only the env-var-missing case is bypassed.                                                                                                                                                                                                                                                                                                       | Regex check on endpoint — too permissive, security regression                                                |

### FR Coverage Map

| FR    | Description                              | LLD Coverage                                                                                                             | Status       |
| ----- | ---------------------------------------- | ------------------------------------------------------------------------------------------------------------------------ | ------------ |
| FR-1  | Auto-persist tools at CREATE             | Phase 5 (toolDsls consumption) + existing collectInlineSeedTools                                                         | Covered      |
| FR-2  | Idempotent auto-creation                 | Phase 5 (dedup check via alreadyPersisted Set + 11000 catch)                                                             | Covered      |
| FR-3  | list_project_tools                       | Pre-existing `tools_ops.list` — wired in Phase 4                                                                         | Pre-existing |
| FR-4  | create_project_tool                      | `tools_ops.create` fixed in Phase 2, wired in Phase 4                                                                    | Covered      |
| FR-5  | update_project_tool                      | `tools_ops.update` fixed in Phase 2, wired in Phase 4                                                                    | Covered      |
| FR-6  | test_project_tool                        | Pre-existing `tools_ops.test` — delegates to `tool-test-service.ts`                                                      | Pre-existing |
| FR-7  | delete_project_tool                      | Pre-existing `tools_ops.delete` with confirmation gate                                                                   | Pre-existing |
| FR-8  | map_tool_to_agent                        | **Deferred** (D-6) — use `propose_modification` as workaround                                                            | Deferred     |
| FR-9  | TOOL_SCHEMA_MISMATCH compiler diagnostic | **Out of scope** — compiler change is a separate concern from tool lifecycle wiring                                      | Deferred     |
| FR-10 | Journal entries for tool mutations       | Audit logging in shared service. Full journal integration deferred — existing `tools-ops.ts` already logs at info level. | Partial      |
| FR-11 | BUILD:TOOLS sub-phase                    | Phase 3 (handleBuildAction + save_tool_dsl)                                                                              | Covered      |
| FR-12 | Tenant/project isolation                 | Shared service enforces tenantId/projectId on all queries                                                                | Covered      |

### Key Interfaces & Types

```typescript
// handleBuildAction return type change
interface BuildActionResult {
  continueToLLM: boolean;
}

// tool-creation-service.ts input types
interface CreateToolInput {
  tenantId: string;
  projectId: string;
  formData: ProjectToolFormData;
  createdBy: string;
  templateUrlsAllowed?: boolean;
}

interface UpdateToolInput {
  tenantId: string;
  projectId: string;
  toolId: string;
  formData: ProjectToolFormData;
  updatedBy: string;
}

interface CreateToolFromDslInput {
  tenantId: string;
  projectId: string;
  toolName: string;
  dslContent: string;
  createdBy: string;
  templateUrlsAllowed?: boolean;
}

// ToolName union additions
type ToolName = ... | 'tools_ops' | 'save_tool_dsl';
```

### Module Boundaries

| Module                           | Responsibility                                             | Depends On                                                                                                                                                                                                                   |
| -------------------------------- | ---------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `build-completion.ts`            | BuildComplete widget actions, route re-entry signal        | `@agent-platform/arch-ai` (extractAllTools), mongoose                                                                                                                                                                        |
| `tool-creation-service.ts` (NEW) | Shared tool validation pipeline (9 invariants)             | `@agent-platform/shared` (repos, `serializeToolFormToDsl`, `computeSourceHash`), `@agent-platform/shared/tools` (`parseDslToToolForm`), `@agent-platform/database/models` (VariableNamespace), feature gates, SSRF validator |
| `tools-ops.ts`                   | LLM config → ProjectToolFormData conversion, CRUD dispatch | `tool-creation-service.ts`, `@agent-platform/shared/repos`                                                                                                                                                                   |
| `route.ts` (buildBuildTools)     | `save_tool_dsl` tool definition, `tools_ops` registration  | `tools-ops.ts`, mongoose                                                                                                                                                                                                     |
| `route.ts` (CREATE handler)      | `toolDsls` consumption at project creation                 | `tool-creation-service.ts`                                                                                                                                                                                                   |

## 2. File-Level Change Map

### New Files

| File                                           | Purpose                                                         | LOC Estimate |
| ---------------------------------------------- | --------------------------------------------------------------- | ------------ |
| `apps/studio/src/lib/tool-creation-service.ts` | Shared tool creation/update service with all 9 route invariants | ~250         |

### Modified Files

| File                                                                    | Change Description                                                                                                                                                                                                                                                                                                                   | Risk                               |
| ----------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | ---------------------------------- |
| `apps/studio/src/lib/arch-ai/build-completion.ts`                       | Wire `case 'tools'`: extract tools, set buildSubPhase, return `{ continueToLLM: true }` without emitting `done` or calling `close()`. Change return type for all cases. Fix pre-existing bug: stub at line 839 doesn't call `close()`.                                                                                               | Med — 8 cases need return value    |
| `apps/studio/src/app/api/arch-ai/message/route.ts`                      | (1) Handle `continueToLLM` at call site — skip `return;`. (2) Add `save_tool_dsl` to `buildBuildTools()` with `AGENT_NAME_PATTERN` validation. (3) Register `tools_ops` in `buildInProjectTools()`. (4) Add to specialist maps. (5) Extend CREATE-time persistence for `toolDsls`. **Depends on Phase 3 completing before Phase 4.** | High — large file, 5 change points |
| `apps/studio/src/lib/arch-ai/tools/tools-ops.ts`                        | Fix `createTool` and `updateTool` to use shared service. Add `buildFormDataFromConfig` helper.                                                                                                                                                                                                                                       | Med — changes mutation path        |
| `packages/arch-ai/src/types/tools.ts`                                   | Add `tools_ops`, `save_tool_dsl` to `ToolName`. Add `tools_ops` to `IN_PROJECT_TOOLS`.                                                                                                                                                                                                                                               | Low — type additions only          |
| `packages/arch-ai/src/prompts/phases/in-project.ts`                     | Add `tools_ops` to available tools list and capabilities                                                                                                                                                                                                                                                                             | Low — prompt text only             |
| `packages/arch-ai/src/prompts/specialists/integration-methodologist.ts` | Add BUILD:TOOLS and IN_PROJECT tool CRUD sections (separate)                                                                                                                                                                                                                                                                         | Low — prompt text only             |
| `packages/arch-ai/src/prompts/specialists/abl-construct-expert.ts`      | Brief tools_ops note                                                                                                                                                                                                                                                                                                                 | Low — prompt text only             |
| `apps/studio/src/lib/arch-ai/tools/diagnose-project.ts`                 | Add T-01 through T-06 diagnostics for `focus:'tools'`                                                                                                                                                                                                                                                                                | Med — new analysis logic           |
| `apps/studio/src/__tests__/arch-ai/build-completion.test.ts`            | Update 3 existing tests for return type, add tools case test                                                                                                                                                                                                                                                                         | Low                                |
| `packages/arch-ai/src/__tests__/tools.test.ts`                          | Update `ALL_TOOLS` fixture and `IN_PROJECT_TOOLS` assertions                                                                                                                                                                                                                                                                         | Low                                |

## 3. Implementation Phases

**Phase dependency:** Phase 3 and Phase 4 both modify `route.ts` at different locations. Phase 3 must complete before Phase 4 begins. All other phases are independent.

### Phase 1: Shared Tool Creation Service

**Goal**: Extract tool creation/update validation pipeline into a reusable service that enforces all 9 route invariants.

**Tasks**:
1.1. Create `apps/studio/src/lib/tool-creation-service.ts` with `createToolViaService()` implementing all 9 invariants:

- (1) Sandbox feature gate: `isCodeToolsEnabled(tenantId)` — blocks sandbox when disabled
- (2) SSRF validation: `validateUrlWithPlaceholders(endpoint, tenantId, projectId)` — for HTTP tools. When `templateUrlsAllowed` is true, check `ssrf.reason` for unresolved-variable specificity (not just `{{env.X}}` regex) before allowing
- (3) Name uniqueness: `findProjectToolByName(tenantId, projectId, name)` — 409 on conflict
- (4) Max 500 tools: `countProjectToolsByProject(tenantId, projectId)` — blocks at limit
- (5) DSL serialization: `serializeToolFormToDsl(formData)` + `computeSourceHash(dslContent)`
- (6) Default namespace: inline `VariableNamespace.findOne({tenantId, projectId, isDefault:true})` + conditional create (matching pattern at tools/route.ts:118-150 — NOT runtime's `getOrCreateDefaultNamespace()` which is unavailable in studio)
- (7) Audit logging: `logAuditEvent(AuditActions.TOOL_CREATED)` with non-fatal `.catch(err => log.warn(...))`
- (8) Lambda trigger: async `triggerLambdaDeployment` for sandbox tools when `SANDBOX_BACKEND === 'lambda'`, with non-fatal `.catch(err => log.warn(...))`
- (9) Source hash: `computeSourceHash(dslContent)`

  1.2. Add `createToolFromDsl()` that:

- Calls `inferToolTypeFromDsl(dslContent)` to determine type from DSL patterns
- Imports `parseDslToToolForm` from `@agent-platform/shared/tools` (NOT from `@agent-platform/shared` top-level — it is only exported from the subpath)
- Attempts `parseDslToToolForm(dslContent, toolType)` — if successful, delegates to `createToolViaService()`
- Fallback for unparseable DSL: enforces ALL 9 invariants inline — (1) sandbox gate, (2) SSRF via best-effort regex endpoint extraction from raw DSL, (3) name uniqueness, (4) max 500 limit, (6) namespace via inline VariableNamespace, (7) audit logging, (8) lambda trigger, (9) source hash — before calling `createProjectTool()`. This ensures the fallback path is never a bypass around the shared contract.

  1.3. Add `updateToolViaService()` with:

- Input: `{ tenantId, projectId, toolId, formData, updatedBy }`
- SSRF validation for HTTP tools (if endpoint changed)
- `serializeToolFormToDsl()` + `computeSourceHash()`
- Audit logging: `logAuditEvent(AuditActions.TOOL_UPDATED)`
- No slug change allowed (DB schema enforces, but service should not attempt)

  1.4. Add `inferToolTypeFromDsl()`: returns `'http'` if DSL contains `type: http` or `endpoint:`, `'mcp'` if `type: mcp` or `server:`, else `'sandbox'`.

  1.5. Add `ToolServiceError` class with typed `code` field.

  1.6. `createdBy` semantics: accepts a plain string (userId or display label). Callers decide format — `tools_ops` passes `userId`, tool routes pass `formatUserLabel(user)`. Document this in JSDoc.

**Files Touched**:

- `apps/studio/src/lib/tool-creation-service.ts` — NEW (~250 LOC)

**Exit Criteria**:

- [ ] `createToolViaService()` enforces all 9 invariants
- [ ] `createToolFromDsl()` handles both parseable and unparseable DSL
- [ ] `createToolFromDsl()` fallback path enforces ALL invariants inline: (1) sandbox gate, (2) SSRF via best-effort regex endpoint extraction, (3) name uniqueness, (4) max 500 limit, (6) default namespace via inline VariableNamespace, (7) audit logging, (8) lambda trigger, (9) source hash
- [ ] `updateToolViaService()` enforces SSRF, audit, DSL serialization
- [ ] `inferToolTypeFromDsl()` correctly identifies http/mcp/sandbox from DSL patterns
- [ ] SSRF `templateUrlsAllowed` bypass checks `ssrf.reason?.startsWith('Environment variable')` (or equivalent) — NOT `{{env.X}}` regex on the URL. This ensures private-IP-with-template (e.g., `http://169.254.169.254/{{env.PATH}}`) is still blocked.
- [ ] Default namespace uses inline `VariableNamespace` import (not runtime function)
- [ ] `pnpm build --filter=studio` succeeds with 0 errors
- [ ] Unit tests: sandbox gate blocks, SSRF blocks unsafe URLs, SSRF allows template URLs only when reason is env-var-missing, name conflict error, max 500 error

**Test Strategy**:

- Unit: Test each invariant in isolation
- Unit: Test `templateUrlsAllowed` with safe-but-unresolvable URL (allow) vs. private-IP-with-template (block)
- Unit: Test `inferToolTypeFromDsl` with http/mcp/sandbox DSL samples
- Unit: Test `createToolFromDsl` fallback path enforces invariants

**Rollback**: Delete `tool-creation-service.ts` — no callers yet.

---

### Phase 2: Fix `tools_ops` DSL Serialization

**Goal**: Fix the `JSON.stringify(config)` bug in both `createTool` and `updateTool` by delegating to the shared service.

**Tasks**:
2.1. Add `buildFormDataFromConfig()` helper to `tools-ops.ts` that converts LLM config objects to `ProjectToolFormData` discriminated union (http/sandbox/mcp cases).
2.2. Refactor `createTool()` (line 107) to call `createToolViaService()` from the shared service.
2.3. Refactor `updateTool()` (line 130) to call `updateToolViaService()` from the shared service.
2.4. Catch `ToolServiceError` and return structured `{ success: false, error: { code, message } }`.

**Files Touched**:

- `apps/studio/src/lib/arch-ai/tools/tools-ops.ts` — MODIFY (lines 107-148)

**Exit Criteria**:

- [ ] `tools_ops.create` produces valid DSL (round-trips through `parseDslToToolForm()`)
- [ ] `tools_ops.update` produces valid DSL (not `JSON.stringify`)
- [ ] Both enforce SSRF, namespace, and audit via shared service
- [ ] `pnpm build --filter=studio` succeeds

**Test Strategy**:

- Unit: Create tool with HTTP config → verify DSL content parses back correctly
- Unit: Create tool with sandbox config → verify DSL includes code block
- Unit: Update tool → verify DSL updated, not JSON

**Rollback**: Revert tools-ops.ts changes — shared service remains but is unused.

---

### Phase 3: Wire `handleBuildAction('tools')` and `save_tool_dsl`

**Goal**: Wire the stubbed `case 'tools'` entry point to the BUILD:TOOLS sub-phase, and add the missing `save_tool_dsl` write path.

**Tasks**:
3.1. Change `handleBuildAction` return type from `Promise<void>` to `Promise<BuildActionResult>`. Update all 8 named cases AND the `default` case. Named cases (`create`, `back`, `review`, `modify`, `retry`, `retry_all`, `tools`, `fix_warnings`) return `{ continueToLLM: false }`. The `default` case returns `{ continueToLLM: true }` — matching its existing behavior (comment says "caller should fall through to BUILD LLM flow"). Verify `review` and `modify` cases (which don't call `close()`) still return `false`. Fix pre-existing bug: add `close()` before `return` in `case 'tools'` stub (line 839) and `case 'fix_warnings'` stub (line 869) — both emit `done` but skip `close()`, leaking the SSE stream.

3.2. Replace the `case 'tools'` stub: call `extractAllTools()`, set `buildSubPhase='TOOLS'`, `toolDsls={}`, and `toolDslTurnCount=0` in MongoDB, emit tool count via `text_delta`. Do NOT emit `done` or call `close()` — the SSE stream stays open for the LLM continuation. Return `{ continueToLLM: true }`.

3.3. Update the call site in `route.ts` (~line 4951-4977):

```typescript
const buildResult = await handleBuildAction(
  answer,
  ctx,
  session,
  results,
  emit,
  close,
  deps,
  projectName,
);
if (!buildResult.continueToLLM) {
  return; // Action handled, stream closed
}
// Fall through to LLM — MUST update local variables so the LLM path
// detects TOOLS sub-phase. Replicates the pattern at route.ts:4860-4864.
(session.metadata as unknown as Record<string, unknown>).buildSubPhase = 'TOOLS';
buildSubPhase = 'TOOLS';
specialist = 'integration-methodologist' as SpecialistId;
display = SPECIALIST_DISPLAY[specialist] ?? { name: specialist, icon: 'bot' };
// The same SSE writer is reused. buildBuildTools() will include save_tool_dsl
// because buildSubPhase is now 'TOOLS'. LLM stream emits 'done' at route.ts:5948.
```

3.4. Extend `buildBuildTools()` signature to receive `buildSubPhase: string | undefined`. When `buildSubPhase === 'TOOLS'`, include `save_tool_dsl` tool:

- `toolName` validation: use `AGENT_NAME_PATTERN` (`/^[A-Za-z_][A-Za-z0-9_]*$/`) — matches what `extractAllTools` produces. Remove redundant execute-time re-validation.
- Execute: writes `metadata.toolDsls[toolName]` via MongoDB `$set`
- Returns confirmation string with tool name and line count

  3.5. Turn-limit safety valve: add `metadata.toolDslTurnCount` field. Increment INSIDE the `if (phase === 'BUILD' && buildSubPhase === 'TOOLS')` block in the completion check (route.ts:5886, not 5850), after the `allToolsComplete` check (around line 5960). When count exceeds 10 and no new `toolDsls` entry was added in that turn, emit a warning and set `buildSubPhase='COMPLETE'` to break the loop.

  3.6. Update existing tests in `build-completion.test.ts`: add `continueToLLM: false` assertions to 3 existing tests (`create`, `retry`, `retry_all`), add new test for `case 'tools'` with `continueToLLM: true`. Update the `ALL_TOOLS` fixture in `tools.test.ts`.

**Files Touched**:

- `apps/studio/src/lib/arch-ai/build-completion.ts` — MODIFY (return type + tools case)
- `apps/studio/src/app/api/arch-ai/message/route.ts` — MODIFY (call site + buildBuildTools + save_tool_dsl + turn counter)
- `apps/studio/src/__tests__/arch-ai/build-completion.test.ts` — MODIFY (4 test changes)

**Exit Criteria**:

- [ ] `handleBuildAction('tools')` sets `buildSubPhase='TOOLS'` in MongoDB and returns `{ continueToLLM: true }`
- [ ] `handleBuildAction('tools')` does NOT emit `done` or call `close()`
- [ ] Route.ts falls through to LLM when `continueToLLM` is true (same SSE stream)
- [ ] `save_tool_dsl` validates with `AGENT_NAME_PATTERN` and writes to `metadata.toolDsls[toolName]`
- [ ] BUILD:TOOLS completion check (route.ts:5850) converges when all tools have DSLs
- [ ] Turn counter increments per LLM turn; safety valve fires at 10 stale turns
- [ ] Existing `handleBuildAction` tests pass with return value assertions
- [ ] `pnpm build --filter=studio` succeeds

**Test Strategy**:

- Unit: `handleBuildAction('tools')` with agent files containing tools → sets TOOLS sub-phase, returns `{ continueToLLM: true }`
- Unit: `handleBuildAction('tools')` with no tools → emits message, returns `{ continueToLLM: false }`
- Unit: `save_tool_dsl` writes to session metadata, accepts mixed-case names
- Unit: `save_tool_dsl` rejects names not matching `AGENT_NAME_PATTERN`
- Unit: Turn counter increments and safety valve fires
- Integration: Full BUILD → tools → save_tool_dsl → completion check converges

**Rollback**: Revert build-completion.ts and route.ts changes. Stub returns.

---

### Phase 4: Wire `tools_ops` into In-Project LLM + Prompts

**Dependency**: Phase 3 must complete first (both touch `route.ts`).

**Goal**: Register `tools_ops` as a Vercel AI tool, add to specialist maps, update prompts and type registry.

**Tasks**:
4.1. Register `tools_ops` tool in `buildInProjectTools()` with full `ToolPermissionContext`. Note: `authToken` must be inside the context object (not a separate closure variable) because `executeToolsOps` signature is `(input, ctx: ToolPermissionContext)`:

```typescript
execute: async (input) => {
  const { executeToolsOps } = await import('@/lib/arch-ai/tools/tools-ops');
  return executeToolsOps(input, {
    projectId,
    user: {
      tenantId: ctx.tenantId,
      userId: ctx.userId,
      permissions: ctx.permissions ?? [],  // Required by ToolPermissionContext
    },
    authToken,  // Inside ToolPermissionContext for runtime API calls (tool testing)
  });
},
```

4.2. Add `'tools_ops'` to `IN_PROJECT_SPECIALIST_TOOL_MAP` for `integration-methodologist` and `abl-construct-expert`.

4.3. Add `'tools_ops'` and `'save_tool_dsl'` to `ToolName` union in `packages/arch-ai/src/types/tools.ts`.

4.4. Add `'tools_ops'` to `IN_PROJECT_TOOLS` array in `packages/arch-ai/src/types/tools.ts`.

4.5. Update `in-project.ts` prompt: add `tools_ops` to available tools list and add to capabilities:

```
- Manage tool configurations (tools_ops) — create, read, update, test, delete project tools
```

4.6. Update `integration-methodologist.ts` prompt with TWO separate sections:

- `## BUILD:TOOLS Phase` — `save_tool_dsl` guidance (generate DSL, call save_tool_dsl per tool, env var placeholders)
- `## IN_PROJECT Tool Management` — `tools_ops` CRUD with workflow examples, env var conventions

  4.7. Update `abl-construct-expert.ts` prompt: add brief `## Tool Management` section.

  4.8. Update `packages/arch-ai/src/__tests__/tools.test.ts`: update `ALL_TOOLS` fixture, add assertions for `tools_ops` in `IN_PROJECT_TOOLS`.

**Files Touched**:

- `apps/studio/src/app/api/arch-ai/message/route.ts` — MODIFY (buildInProjectTools + specialist maps)
- `packages/arch-ai/src/types/tools.ts` — MODIFY
- `packages/arch-ai/src/prompts/phases/in-project.ts` — MODIFY
- `packages/arch-ai/src/prompts/specialists/integration-methodologist.ts` — MODIFY
- `packages/arch-ai/src/prompts/specialists/abl-construct-expert.ts` — MODIFY
- `packages/arch-ai/src/__tests__/tools.test.ts` — MODIFY

**Exit Criteria**:

- [ ] `tools_ops` appears in tool set for `integration-methodologist` and `abl-construct-expert`
- [ ] `tools_ops` dispatches to `executeToolsOps()` with `permissions` in context
- [ ] `ToolName` includes `'tools_ops'` and `'save_tool_dsl'`
- [ ] `IN_PROJECT_TOOLS` includes `'tools_ops'`
- [ ] `pnpm build --filter=@agent-platform/arch-ai --filter=studio` succeeds
- [ ] All tests in `tools.test.ts` pass with updated assertions

**Test Strategy**:

- Unit: Verify `tools_ops` in specialist tool maps
- Unit: Verify `ToolName` and `IN_PROJECT_TOOLS` contain new entries
- Unit: Verify `tools_ops` registration passes `permissions` correctly

**Rollback**: Revert route.ts specialist map changes and prompt files.

---

### Phase 5: CREATE-Time Persistence Enhancement

**Goal**: Ensure tools generated via BUILD:TOOLS (`toolDsls`) are persisted as `ProjectTool` records at project creation.

**Tasks**:
5.1. After the existing `collectInlineSeedTools` loop (route.ts ~line 4207, before the `catch (extractErr)` block), add a second pass that reads `metadata.toolDsls` and calls `createToolFromDsl()` from the shared service for each entry not already persisted.
5.2. Track already-persisted tool names from the `collectInlineSeedTools` pass to avoid duplicates (collect names into a `Set<string>`).
5.3. Pass `templateUrlsAllowed: true` for onboarding (env vars may not exist yet).
5.4. Log count of tools persisted from `toolDsls` vs. inline extraction.

**Files Touched**:

- `apps/studio/src/app/api/arch-ai/message/route.ts` — MODIFY (CREATE handler ~line 4207)

**Exit Criteria**:

- [ ] Tools in `toolDsls` are persisted as `ProjectTool` records after project creation
- [ ] Tools already created by `collectInlineSeedTools` are not duplicated
- [ ] Failed tool creation doesn't block project creation (non-fatal catch)
- [ ] Template URLs allowed for onboarding tools (SSRF bypass only for env-var-missing reason)
- [ ] `pnpm build --filter=studio` succeeds

**Test Strategy**:

- Integration: Create session with `toolDsls` entries → trigger CREATE → verify ProjectTool records exist
- Integration: toolDsls and inline tools overlap → verify no duplicates
- Unit: Template URL with unresolvable env var → allowed. Private IP with template → blocked.

**Rollback**: Revert the CREATE handler addition — `collectInlineSeedTools` still works.

---

### Phase 6: Enhanced Tool Diagnosis

**Goal**: Add meaningful diagnostics to `diagnose_project focus:'tools'`.

**Tasks**:
**Architecture note:** T-01 through T-06 are project-level diagnostics that require DB access (ProjectTool records, VariableNamespace lookups, agent DSL reads). The existing `runDiagnostics()` in `packages/arch-ai/src/diagnostics/` is a pure function operating on compiled IR — it cannot do DB queries. Therefore, these diagnostics are implemented directly in `diagnose-project.ts` (the tool adapter layer that already has DB access), NOT in the `runDiagnostics` engine. The boundary: `runDiagnostics` handles structural/IR analysis, `diagnose-project.ts` handles project-level cross-resource analysis.

6.1. Implement T-01 (unresolved env vars): scan tool DSL for `{{env.X}}` patterns, check against linked variable namespaces via `VariableNamespace` model.
6.2. Implement T-02 (orphan tools): compare ProjectTool records against agent TOOLS section references.
6.3. Implement T-03 (missing records): compare agent TOOLS section references against ProjectTool names.
6.4. Implement T-04 (auth heuristic): HTTP tools with `auth: none` on URLs containing `/api/` or `/v1/`.
6.5. Implement T-05 (corrupt DSL): attempt `parseDslToToolForm()` round-trip on each tool.
6.6. Implement T-06 (signature conflict): detect same tool name with different parameter lists across agents using `extractAllTools` output (which returns per-agent entries — group by `toolName`, compare `parameters` arrays). **Limitation:** `extractAllTools` returns parameter names (strings) only, not types. T-06 detects parameter count/name differences but not type mismatches for same-named parameters.

**Files Touched**:

- `apps/studio/src/lib/arch-ai/tools/diagnose-project.ts` — MODIFY (tool diagnosis section)

**Exit Criteria**:

- [ ] Each diagnostic code (T-01 through T-06) fires correctly on fixture data
- [ ] Diagnosis runs within 5 seconds for projects with up to 50 tools
- [ ] Results include structured findings with code, severity, tool name, and detail
- [ ] `pnpm build --filter=studio` succeeds

**Test Strategy**:

- Unit: Fixture with unresolved env var → T-01 warning
- Unit: Fixture with orphan tool → T-02 info
- Unit: Fixture with missing record → T-03 error
- Unit: Fixture with auth-none on API URL → T-04 warning
- Unit: Fixture with corrupt DSL → T-05 warning
- Unit: Fixture with conflicting signatures → T-06 warning

**Rollback**: Revert diagnose-project.ts changes — existing shallow diagnosis remains.

## 4. Wiring Checklist

- [ ] `tool-creation-service.ts` exported from studio lib (used by tools-ops.ts and route.ts)
- [ ] `tools_ops` registered in `buildInProjectTools()` tool object with `permissions` in context
- [ ] `tools_ops` added to `IN_PROJECT_SPECIALIST_TOOL_MAP` for integration-methodologist
- [ ] `tools_ops` added to `IN_PROJECT_SPECIALIST_TOOL_MAP` for abl-construct-expert
- [ ] `save_tool_dsl` added to `buildBuildTools()` when `buildSubPhase === 'TOOLS'`
- [ ] `save_tool_dsl` uses `AGENT_NAME_PATTERN` for name validation (not ProjectTool regex)
- [ ] `tools_ops` added to `ToolName` union type
- [ ] `save_tool_dsl` added to `ToolName` union type
- [ ] `tools_ops` added to `IN_PROJECT_TOOLS` array
- [ ] `tools_ops` listed in `in-project.ts` prompt available tools
- [ ] `tools_ops` guidance added to integration-methodologist prompt (IN_PROJECT section)
- [ ] `save_tool_dsl` guidance added to integration-methodologist prompt (BUILD:TOOLS section, separate)
- [ ] `tools_ops` note added to abl-construct-expert prompt
- [ ] CREATE-time persistence reads `toolDsls` after `collectInlineSeedTools`
- [ ] `buildBuildTools` receives `buildSubPhase` parameter
- [ ] `handleBuildAction` return type updated at call site in route.ts
- [ ] `handleBuildAction('tools')` does NOT emit `done` or call `close()` (SSE stream continues)
- [ ] Default namespace in shared service uses inline `VariableNamespace` import
- [ ] `ALL_TOOLS` fixture in `tools.test.ts` updated
- [ ] BUILD:TOOLS context injection block (route.ts:5105) remains compatible with `save_tool_dsl` — verify specContext still serves the methodologist correctly after tool set changes

## 5. Cross-Phase Concerns

### Database Migrations

None — uses existing `project_tools` collection and `arch_sessions` metadata fields. New field `toolDslTurnCount` is added to session metadata (no schema migration needed — metadata is schemaless).

### Feature Flags

None — tool creation is always active when Arch creates a project. BUILD:TOOLS sub-phase already exists in the codebase.

### Configuration Changes

No new env vars. The shared service uses existing `SANDBOX_BACKEND` env var for lambda triggers and existing SSRF validation infrastructure.

### Phase Dependency Graph

```
Phase 1 ──┬── Phase 2 (depends on Phase 1 — imports createToolViaService/updateToolViaService)
           └── Phase 5 (depends on Phase 1 — imports createToolFromDsl)

Phase 3 ──── Phase 4 (depends on Phase 3 — both modify route.ts, must be sequential)

Phase 6 ─── (independent)
```

Phase 3 is independent of Phase 1 (does not import from tool-creation-service.ts). Phase 3 touches `build-completion.ts` and `route.ts` (call site + buildBuildTools). Phase 4 also touches `route.ts` (buildInProjectTools + specialist maps), so Phase 4 must follow Phase 3. Phase 5 also modifies route.ts at a non-overlapping region (CREATE handler ~line 4207). Safe to run in parallel with Phases 3/4, but rebase carefully if implementing on separate branches. Note: `buildBuildTools` signature change in Phase 3 affects 2 call sites — the direct call at route.ts:5484 AND the call inside `buildInProjectTools` at route.ts:2143. The latter passes `undefined` for `buildSubPhase` (correct: save_tool_dsl excluded in IN_PROJECT).

## 6. Acceptance Criteria (Whole Feature)

- [ ] All phases complete with exit criteria met
- [ ] `handleBuildAction('tools')` enters BUILD:TOOLS sub-phase and triggers methodologist LLM (same SSE stream)
- [ ] `save_tool_dsl` writes to `toolDsls` with `AGENT_NAME_PATTERN` validation; completion check converges
- [ ] `tools_ops.create` and `tools_ops.update` produce valid DSL (not JSON)
- [ ] `tools_ops` accessible to integration-methodologist and abl-construct-expert in IN_PROJECT mode with correct permissions
- [ ] CREATE-time persists both inline tools and `toolDsls`-generated tools
- [ ] Shared service enforces all 9 route invariants including SSRF (with reason-specific template bypass)
- [ ] Diagnosis T-01 through T-06 fire on appropriate conditions
- [ ] No regressions in existing tests (`pnpm build && pnpm test`)
- [ ] Feature spec updated with implementation status
- [ ] FR-8 (`map_tool_to_agent`) and FR-9 (`TOOL_SCHEMA_MISMATCH`) logged as deferred

## 7. Delivery Plan Alignment

The feature spec (Section 13) defines 6 task groups. This LLD covers tasks 1, 3, and 6. Tasks 2, 4, and 5 are partially covered or deferred.

| Feature Spec Task                                         | LLD Coverage                 | Notes                                                                                                                                                                                                                                                                                                                             |
| --------------------------------------------------------- | ---------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Task 1: Tool extractor + CREATE coordinator               | Phase 1 + Phase 5            | Covered. Uses existing `extractAllTools` and `collectInlineSeedTools`.                                                                                                                                                                                                                                                            |
| Task 2: Six new Arch tool definitions in `definitions.ts` | Phase 4 (different approach) | LLD registers `tools_ops` and `save_tool_dsl` via Vercel AI `tool()` in route.ts, NOT via `LLMToolDefinition` in `definitions.ts`. The route.ts pattern is established for in-project tools. Feature spec's `definitions.ts` approach is an alternative that would require additional Zod schema work in `in-project-schemas.ts`. |
| Task 3: BUILD:TOOLS sub-phase                             | Phase 3                      | Covered. Wires existing `buildSubPhase` state machine + adds `save_tool_dsl`.                                                                                                                                                                                                                                                     |
| Task 4: Compiler schema validation                        | **Deferred (D-6, FR-9)**     | `TOOL_SCHEMA_MISMATCH` is a compiler concern separate from tool lifecycle wiring.                                                                                                                                                                                                                                                 |
| Task 5: Journal persistence                               | **Partial (FR-10)**          | Audit logging via `logAuditEvent` is included. Full journal entries (type `tool_created`/`tool_updated`/`tool_deleted` in `archjournals` with before/after diffs and specialist attribution) are deferred.                                                                                                                        |
| Task 6: Tests                                             | Distributed across phases    | Each phase includes test strategy.                                                                                                                                                                                                                                                                                                |

### Feature Spec File Path Divergence

The feature spec (Section 10) lists implementation files that diverge from this LLD:

| Feature Spec File                           | LLD Equivalent                                      | Reason                                                                                         |
| ------------------------------------------- | --------------------------------------------------- | ---------------------------------------------------------------------------------------------- |
| `tools/tool-lifecycle-ops.ts` (NEW)         | `lib/tool-creation-service.ts` (NEW)                | Shared beyond arch-ai scope; placed at lib root. Update feature spec during post-impl-sync.    |
| `handlers/in-project-tool-handler.ts` (NEW) | Direct wiring in `route.ts` `buildInProjectTools()` | Follows existing pattern; no separate handler file. Update feature spec during post-impl-sync. |

### Design Spec Override Notes

The LLD overrides stale code in the design spec. Implementers should treat the LLD as authoritative:

| Design Spec Location            | Issue                                                      | LLD Override                                                |
| ------------------------------- | ---------------------------------------------------------- | ----------------------------------------------------------- |
| Section 3, line 266             | SSRF bypass uses `{{env.X}}` regex on URL                  | D-12: Use `ssrf.reason?.startsWith('Environment variable')` |
| Section 2, save_tool_dsl schema | toolName regex rejects extracted names                     | D-9: Use `AGENT_NAME_PATTERN` from route.ts                 |
| Section 3, createToolFromDsl    | Calls `getOrCreateDefaultNamespace()`                      | D-11: Inline `VariableNamespace` import                     |
| Section 3, createToolFromDsl    | Imports `parseDslToToolForm` from `@agent-platform/shared` | Fixed: import from `@agent-platform/shared/tools`           |

## 8. Test Spec Reconciliation

**The test spec (`docs/testing/arch-tool-lifecycle.md`) uses a completely different FR numbering and tool naming from the feature spec.** This is a pre-existing documentation issue. The test spec was written with its own FR-1 through FR-15 that do not correspond to the feature spec's FR-1 through FR-12. The tool names also diverge (`manage_tool` vs `tools_ops`, `test_tool` vs `tools_ops.test`, etc.).

### Test Scenarios Enabled by This LLD

| Test Spec Scenario                          | Enabled?    | Notes                                                                          |
| ------------------------------------------- | ----------- | ------------------------------------------------------------------------------ |
| E2E-1: Full onboarding with tool generation | **Yes**     | Phase 3 (BUILD:TOOLS) + Phase 5 (CREATE persistence)                           |
| E2E-2: Tool testing in IN_PROJECT           | **Partial** | `tools_ops.test` works (pre-existing). Test spec calls it `test_tool`.         |
| E2E-3: Tool CRUD via `manage_tool`          | **Yes**     | `tools_ops` covers create/get/update/delete. Test spec calls it `manage_tool`. |
| E2E-4: OpenAPI import                       | **No**      | `import_tool_spec` is not in scope for this LLD.                               |
| E2E-5: Tool-agent mapping                   | **Partial** | `extractAllTools` provides the data. No `view_tool_mapping` tool.              |
| INT-1: generateTestInputFromDsl             | **No**      | Not in scope.                                                                  |
| INT-2: formatProjectSummary                 | **No**      | Not in scope.                                                                  |
| INT-3: Content router tool patterns         | **Yes**     | Phase 4 prompt updates will enable routing.                                    |
| INT-4: BUILD exit criteria                  | **Yes**     | Phase 3 wires completion check.                                                |
| INT-5: Constraint validator                 | **No**      | FR-9 deferred.                                                                 |

**Action item for post-impl-sync:** Update the test spec to use feature spec FR numbering and the actual tool names (`tools_ops`, `save_tool_dsl`).

## 9. Deferred Work & Open Questions

1. **Deferred FR-8**: `map_tool_to_agent` — deferred to next iteration. Workaround: `propose_modification` to add tools to agent TOOLS sections manually.
2. **Deferred FR-9**: `TOOL_SCHEMA_MISMATCH` compiler diagnostic — separate compiler concern.
3. **Deferred FR-10 (full journal)**: Full journal entries require: (a) `JournalEntry` creation with types `tool_created`, `tool_updated`, `tool_deleted` in `archjournals`, (b) before/after diff for updates, (c) specialist attribution, (d) `read_journal` surfacing. Current LLD provides audit logging only.
4. **Deferred: OpenAPI import** (`import_tool_spec`) — not in feature spec FRs. Appears only in test spec.
5. **Turn limit**: The 10-turn safety valve is a heuristic. May need adjustment.
6. **Route convergence**: Tool routes should eventually call shared service.
7. **Integration-methodologist additional tools**: May benefit from `read_journal` and `read_insights` in its tool map.

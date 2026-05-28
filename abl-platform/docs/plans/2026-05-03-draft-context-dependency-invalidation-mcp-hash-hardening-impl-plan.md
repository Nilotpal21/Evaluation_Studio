# LLD: Draft Context, Dependency Invalidation, and MCP Hash Hardening

**Status**: IN PROGRESS  
**Date**: 2026-05-03  
**Scope**: Studio persisted draft metadata parity, compile-affecting dependency invalidation, runtime working-copy MCP hash coverage

## 1. Design Decisions

### Decision Log

| ID  | Decision                                                                                              | Rationale                                                                                                                                                                |
| --- | ----------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| D-1 | Treat persisted draft readiness as a project-graph compile artifact, not a row-local parser artifact. | Stored `dslValidationStatus` must match the same dependency surface that real Studio/runtime compile paths use.                                                          |
| D-2 | Extend draft-metadata evaluation with contextual documents and per-record diagnostics.                | Prompt-library failures are agent-local, while behavior-profile documents are project-wide compile context. Both must be expressible without over-invalidating siblings. |
| D-3 | Centralize compile-affecting dependency invalidation behind small Studio helpers.                     | Config-variable/profile and MCP-server mutations should refresh project agent readiness through one explicit contract instead of ad hoc direct calls.                    |
| D-4 | Keep runtime working-copy compilation hash aligned with runtime tool resolution inputs.               | If MCP raw config participates in tool resolution, it must participate in working-copy cache invalidation.                                                               |
| D-5 | Lock each boundary with focused regression tests before implementation.                               | The failure mode here is silent staleness, so slice-local tests are the safest way to prevent backsliding.                                                               |

### Key Interfaces

```ts
interface ProjectAgentDraftRecordDiagnostics {
  errors?: string[];
  warnings?: string[];
}

interface EvaluateProjectAgentDraftMetadataInput {
  agents: readonly ProjectAgentDraftState[];
  compilerOptions?: CompilerOptions;
  contextDocuments?: readonly AgentBasedDocument[];
  contextErrors?: readonly string[];
  contextWarnings?: readonly string[];
  recordDiagnostics?: ReadonlyMap<string, ProjectAgentDraftRecordDiagnostics>;
  diagnosticSource: string;
}
```

### Module Boundaries

| Module                                                     | Responsibility                                                                                        |
| ---------------------------------------------------------- | ----------------------------------------------------------------------------------------------------- |
| `apps/studio/src/lib/abl/project-agent-draft-metadata.ts`  | Build persisted draft compile context that matches Studio/runtime dependency resolution expectations. |
| `packages/project-io/src/project-agent-draft-metadata.ts`  | Apply project-wide compile output plus per-record diagnostics to stored draft metadata.               |
| `apps/studio/src/repos/config-variable-repo.ts`            | Refresh persisted readiness after compile-affecting config-variable writes.                           |
| `apps/studio/src/app/api/projects/[id]/behavior-profiles*` | Refresh readiness after behavior-profile writes that bypass the config-variable repo.                 |
| `apps/studio/src/app/api/projects/[id]/mcp-servers*`       | Refresh readiness after MCP server create/update/delete.                                              |
| `apps/runtime/src/channels/session-resolver.ts`            | Include MCP raw config state in working-copy recompilation hash.                                      |

## 2. File-Level Change Map

### New Files

| File                                                       | Purpose                                                        |
| ---------------------------------------------------------- | -------------------------------------------------------------- |
| `apps/studio/src/lib/project-config-draft-invalidation.ts` | Shared Studio helper for config-variable/profile invalidation. |
| `apps/studio/src/lib/project-mcp-draft-invalidation.ts`    | Shared Studio helper for MCP-server invalidation.              |

### Modified Files

| File                                                                                          | Change                                                                                                    |
| --------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------- |
| `docs/plans/2026-05-03-draft-context-dependency-invalidation-mcp-hash-hardening-impl-plan.md` | This plan.                                                                                                |
| `packages/project-io/src/project-agent-draft-metadata.ts`                                     | Accept context documents and per-record diagnostics.                                                      |
| `apps/studio/src/lib/abl/project-agent-draft-metadata.ts`                                     | Resolve prompt refs, materialize behavior-profile docs, and feed both into persisted metadata evaluation. |
| `apps/studio/src/repos/config-variable-repo.ts`                                               | Refresh project draft metadata after create/update/delete.                                                |
| `apps/studio/src/app/api/projects/[id]/config-variables/[varId]/route.ts`                     | Route through repo update helper so PATCH also refreshes readiness.                                       |
| `apps/studio/src/app/api/projects/[id]/behavior-profiles/route.ts`                            | Refresh readiness after create.                                                                           |
| `apps/studio/src/app/api/projects/[id]/behavior-profiles/[profileName]/route.ts`              | Refresh readiness after update/delete.                                                                    |
| `apps/studio/src/app/api/projects/[id]/mcp-servers/route.ts`                                  | Refresh readiness after create.                                                                           |
| `apps/studio/src/app/api/projects/[id]/mcp-servers/[serverId]/route.ts`                       | Refresh readiness after update/delete.                                                                    |
| `apps/runtime/src/channels/session-resolver.ts`                                               | Hash normalized MCP raw configs alongside agents/tools/config/prompt versions.                            |
| `apps/studio/src/__tests__/project-aware-compile.test.ts`                                     | Lock prompt/profile context expectations used by the persisted metadata layer.                            |
| `apps/studio/src/__tests__/project-repo-draft-metadata.test.ts`                               | Preserve sibling-refresh semantics already in place.                                                      |
| `apps/studio/src/__tests__/api-routes/api-config-variables-edge-cases.test.ts`                | Lock config-variable invalidation on update/delete paths.                                                 |
| `apps/studio/src/__tests__/api-routes/api-behavior-profile-routes.test.ts`                    | Lock behavior-profile invalidation.                                                                       |
| `apps/studio/src/__tests__/api-routes/api-mcp-routes.test.ts`                                 | Lock MCP CRUD invalidation.                                                                               |
| `apps/runtime/src/__tests__/sessions/session-resolver-gaps.test.ts`                           | Lock working-copy refresh when MCP config changes.                                                        |

## 3. Implementation Phases

### Phase 1: Persisted Draft Context Parity

**Goal**: Persisted draft metadata sees the same prompt-library and config-backed behavior-profile context as real Studio/runtime compile paths.

**Tasks**

1. Add `contextDocuments` and per-record diagnostics support to `evaluateProjectAgentDraftMetadata`.
2. Update Studio persisted draft context builder to:
   - load config variables
   - parse behavior-profile documents from `profile:*` config vars
   - resolve prompt-library refs per draft agent
   - send prompt failures as record diagnostics instead of global errors
3. Add tests proving prompt-library ref failures and behavior-profile materialization affect stored metadata.

**Exit Criteria**

- [ ] Persisted draft metadata can mark one agent invalid for a missing prompt version without invalidating siblings.
- [ ] Agents using config-backed behavior profiles are no longer marked valid when profile materialization would fail real compile.
- [ ] `pnpm --dir apps/studio test:fast src/__tests__/project-aware-compile.test.ts` passes.
- [ ] `pnpm --filter @agent-platform/project-io test:fast src/__tests__/project-agent-draft-metadata.test.ts` passes.

### Phase 2: Studio Dependency Invalidation

**Goal**: Any compile-affecting Studio dependency mutation refreshes persisted draft readiness immediately.

**Tasks**

1. Add shared Studio invalidation helpers for config-variable/profile and MCP-server writes.
2. Refresh persisted draft metadata in config-variable repo create/update/delete.
3. Route config-variable PATCH through repo update logic.
4. Refresh after behavior-profile create/update/delete.
5. Refresh after MCP server create/update/delete.
6. Add route/repo tests for each mutation class.

**Exit Criteria**

- [ ] Config-variable create/update/delete refresh persisted draft metadata.
- [ ] Behavior-profile create/update/delete refresh persisted draft metadata.
- [ ] MCP server create/update/delete refresh persisted draft metadata.
- [ ] `pnpm --dir apps/studio test:fast src/__tests__/api-routes/api-config-variables-edge-cases.test.ts src/__tests__/api-routes/api-behavior-profile-routes.test.ts src/__tests__/api-routes/api-mcp-routes.test.ts` passes.

### Phase 3: Runtime Working-Copy MCP Hash Coverage

**Goal**: Working-copy session reuse refreshes when MCP server state changes.

**Tasks**

1. Load raw MCP server configs in the session resolver working-copy hash path.
2. Normalize/hash all runtime-resolution-relevant MCP fields.
3. Add regression tests for URL/auth/transport-driven hash changes.

**Exit Criteria**

- [ ] Changing MCP raw config changes the working-copy compilation hash.
- [ ] Existing working-copy sessions refresh when MCP configs drift.
- [ ] `pnpm --filter @agent-platform/runtime test:fast src/__tests__/sessions/session-resolver-gaps.test.ts` passes.

## 4. Wiring Checklist

- [ ] Persisted draft metadata caller passes new `contextDocuments` / `recordDiagnostics`.
- [ ] New invalidation helpers are imported by all relevant Studio routes/repos.
- [ ] Runtime session resolver fetches MCP raw configs through the shared repo barrel.
- [ ] Tests cover both direct repo writes and route-level write paths.

## 5. Acceptance Criteria

- [ ] Stored `dslValidationStatus` and `dslDiagnostics` reflect prompt-library ref failures.
- [ ] Stored `dslValidationStatus` and `dslDiagnostics` reflect config-backed behavior-profile compile context.
- [ ] Studio config-variable/profile and MCP CRUD no longer leave stale readiness rows behind.
- [ ] Runtime working-copy session reuse no longer misses MCP config drift.
- [ ] Targeted build + test commands for affected packages pass.

## 6. Risks and Rollback

- **Risk**: Over-invalidating all agents on agent-local prompt failures.
  **Mitigation**: Use per-record diagnostics instead of global context errors.
- **Risk**: Triggering excessive refreshes from non-compile-affecting writes.
  **Mitigation**: Limit new invalidation hooks to config-variable/profile and MCP server mutation paths in this slice.
- **Rollback**: Revert each phase independently; no schema migration or persisted data rewrite is required.

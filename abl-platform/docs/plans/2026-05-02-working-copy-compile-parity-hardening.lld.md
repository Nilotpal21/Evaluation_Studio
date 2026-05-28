# LLD: Working-Copy Compile Parity Hardening

**Related Feature Spec**: `docs/features/prompt-library.md`
**Related HLD**: `docs/specs/prompt-library.hld.md`
**Related Test Spec**: `docs/testing/prompt-library.md`
**Status**: DONE (implemented 2026-05-02; focused slice locks and filtered affected-package build green)
**Date**: 2026-05-02

---

## 1. Design Decisions

### Decision Log

| #   | Decision                                                                                                                                | Rationale                                                                                                                                        | Alternatives Rejected                                                                                       |
| --- | --------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------ | ----------------------------------------------------------------------------------------------------------- |
| D-1 | Introduce one canonical runtime helper for project working-copy compilation.                                                            | Fresh-compile paths currently reassemble companion inputs differently, which is how behavior profiles and prompt-library refs drift out of sync. | Patching each route/handler independently would preserve the split-brain and create new drift later.        |
| D-2 | Move prompt-library ref resolution into a shared package seam that both Runtime and Studio can call.                                    | Prompt-library refs are stored outside the DSL, so any compile path that wants parity must share the same DB-backed resolution logic.            | Keeping runtime-only resolution and re-implementing it in Studio would recreate the same bug class.         |
| D-3 | Move behavior-profile config parsing into `@agent-platform/project-io` and treat config-backed profiles as project companion documents. | Runtime and Studio both need the same “config vars -> standalone behavior-profile documents” transformation.                                     | Leaving the parser only in `apps/runtime` blocks Studio from matching runtime compile context.              |
| D-4 | Expand durable working-copy invalidation to hash all compile-affecting companion inputs.                                                | Session reuse must refresh when project config vars, behavior profiles, prompt refs, or referenced prompt versions change.                       | Hashing only project agents and tools leaves stale sessions alive after non-DSL edits.                      |
| D-5 | Studio preview should fail closed on companion-data resolution errors instead of silently compiling a narrower view.                    | A green Studio compile that cannot match runtime is worse than a visible authoring error.                                                        | Best-effort warning-only behavior for deterministic missing companion data would preserve false confidence. |

### Canonical Compile Contract

Working-copy compilation must assemble the same four input lanes everywhere:

1. Agent DSL documents from `project_agents.dslContent`
2. Project config variables for `{{config.*}}` substitution
3. Config-backed companion documents:
   - behavior profiles from `ProjectConfigVariable` keys prefixed with `profile:`
4. Agent companion metadata stored outside the DSL:
   - `ProjectAgent.systemPromptLibraryRef`
   - referenced prompt version content and `resolvedHash`

Tool binding parity remains part of the same contract:

1. Resolve tool implementations from all parsed project agent documents
2. Include MCP raw config baking
3. Include connector tool resolution in both Runtime and Studio

### Key Interfaces

```ts
interface ProjectWorkingCopyAgentSource {
  name: string;
  dslContent: string;
  systemPromptLibraryRef?: { promptId: string; versionId: string } | null;
}

interface ProjectWorkingCopyCompileParams {
  tenantId: string;
  projectId: string;
  entryAgentName: string;
  environment?: string;
  agents: ProjectWorkingCopyAgentSource[];
}

interface ProjectWorkingCopyCompileResult {
  resolved: ResolvedAgent;
  configVariables: Record<string, string>;
  warnings: string[];
}
```

### Module Boundaries

| Module                                                       | Responsibility                                                               | Depends On                                                       |
| ------------------------------------------------------------ | ---------------------------------------------------------------------------- | ---------------------------------------------------------------- |
| `packages/shared/src/prompts/*`                              | Canonical prompt-library version lookup and document injection               | `@agent-platform/database`, `@agent-platform/shared-kernel`      |
| `packages/project-io/src/*`                                  | Canonical config-backed behavior-profile document parsing                    | `@abl/core`, `@agent-platform/database`                          |
| `apps/runtime/src/services/project-working-copy-compiler.ts` | Runtime working-copy compile orchestration for agent docs + companion inputs | compiler, runtime repos, shared prompt helper, project-io helper |
| `apps/runtime/src/channels/session-resolver.ts`              | Durable invalidation hash for working-copy sessions                          | database models, prompt-library metadata                         |
| `apps/studio/src/lib/abl/project-aware-compile.ts`           | Studio compile-context assembly with runtime-parity companion inputs         | shared prompt helper, project-io helper, connector resolver      |
| `apps/studio/src/lib/connection-service.ts`                  | Studio connector tool resolver export                                        | connectors registry                                              |

---

## 2. File-Level Change Map

### New Files

| File                                                         | Purpose                                               | LOC Estimate |
| ------------------------------------------------------------ | ----------------------------------------------------- | ------------ |
| `packages/shared/src/prompts/library-ref-resolution.ts`      | Shared prompt-library ref resolution/injection helper | 90           |
| `packages/project-io/src/behavior-profile-documents.ts`      | Shared config-backed behavior-profile document parser | 70           |
| `apps/runtime/src/services/project-working-copy-compiler.ts` | Canonical runtime working-copy compile seam           | 180          |

### Modified Files

| File                                                                      | Change Description                                                    | Risk   |
| ------------------------------------------------------------------------- | --------------------------------------------------------------------- | ------ |
| `packages/shared/src/prompts/index.ts`                                    | Export prompt-library resolution helper                               | Low    |
| `packages/shared/src/index.ts`                                            | Re-export prompt helper through public package surface                | Low    |
| `packages/project-io/src/index.ts`                                        | Export behavior-profile document helper                               | Low    |
| `apps/runtime/src/services/agent-compile/library-ref-resolver.ts`         | Delegate to shared prompt helper                                      | Low    |
| `apps/runtime/src/services/behavior-profile-documents.ts`                 | Delegate to shared project-io helper                                  | Low    |
| `apps/runtime/src/services/deployment-resolver.ts`                        | Reuse canonical working-copy compiler for fallback compile            | Medium |
| `apps/runtime/src/channels/pipeline/session-factory.ts`                   | Reuse canonical working-copy compiler                                 | Medium |
| `apps/runtime/src/routes/chat.ts`                                         | Reuse canonical working-copy compiler for project fresh-compile paths | Medium |
| `apps/runtime/src/routes/internal-chat.ts`                                | Reuse canonical working-copy compiler                                 | Medium |
| `apps/runtime/src/websocket/handler.ts`                                   | Reuse canonical working-copy compiler for load/resume debug flows     | High   |
| `apps/runtime/src/services/runtime-executor.ts`                           | Reuse canonical working-copy compiler in project IR rebuild path      | Medium |
| `apps/runtime/src/channels/session-resolver.ts`                           | Hash config vars, prompt refs, and referenced prompt version state    | High   |
| `apps/studio/src/lib/connection-service.ts`                               | Export Studio connector tool resolver                                 | Medium |
| `apps/studio/src/lib/abl/project-aware-compile.ts`                        | Resolve behavior profiles, prompt refs, and all-project tool bindings | High   |
| `apps/studio/src/app/api/abl/compile/route.ts`                            | Improve project-scoped compile parity for scratch compiles            | Medium |
| `apps/studio/src/app/api/projects/[id]/agents/[agentId]/compile/route.ts` | Feed target-agent prompt-library metadata into project-aware compile  | Medium |

### Test Files

| File                                                                           | Lock Added                                                                           |
| ------------------------------------------------------------------------------ | ------------------------------------------------------------------------------------ |
| `apps/runtime/src/__tests__/project-working-copy-compiler.test.ts`             | Companion docs + prompt-library ref parity                                           |
| `apps/runtime/src/__tests__/channels/pipeline-session-factory.test.ts`         | Working-copy session compile path uses canonical helper                              |
| `apps/runtime/src/__tests__/routes/internal-chat.test.ts`                      | Internal chat fresh-compile path uses the canonical helper                           |
| `apps/runtime/src/__tests__/sessions/chat-routes.test.ts`                      | HTTP chat working-copy compile paths use the canonical helper                        |
| `apps/runtime/src/__tests__/channels/ws-handler.test.ts`                       | Web debug load/resume paths forward prompt refs into the canonical working-copy seam |
| `apps/runtime/src/__tests__/sessions/session-resolver-gaps.test.ts`            | Hash refreshes for config vars and prompt-library version edits                      |
| `apps/runtime/src/__tests__/tools-deployment/deployment-resolver.test.ts`      | Deployment fallback compile path shares the canonical tool + companion assembly      |
| `apps/studio/src/__tests__/project-aware-compile.test.ts`                      | Studio project-aware compile loads profiles, prompt refs, and all-agent tools        |
| `apps/studio/src/__tests__/api-routes/api-abl-compile-route.test.ts`           | Generic compile route passes connector-aware tool resolution + config-backed context |
| `apps/studio/src/__tests__/api-routes/api-project-agent-compile-route.test.ts` | Project agent compile route stays wired through the project-aware compile path       |

---

## 3. Implementation Phases

### Phase 1: Shared Companion Seams

**Goal**: Establish shared helpers for prompt-library resolution and behavior-profile companion documents.

**Tasks**:

1. Add `packages/shared/src/prompts/library-ref-resolution.ts`
2. Export the helper through `packages/shared`
3. Add `packages/project-io/src/behavior-profile-documents.ts`
4. Export the helper through `packages/project-io`
5. Delegate runtime-local wrappers to the shared helpers

**Exit Criteria**:

- [x] Shared prompt-library resolution helper exists behind a stable package export
- [x] Shared behavior-profile document parser exists behind a stable package export
- [x] Runtime-local wrappers now delegate through the shared seams
- [x] Targeted runtime compile-path tests exercise the new shared seams

**Test Strategy**:

- Integration: existing runtime library-ref resolver tests keep the contract green
- Unit/Integration: runtime project working-copy compiler locks added first, failing before implementation

**Rollback**: Revert new exports and restore runtime-local implementations.

---

### Phase 2: Runtime Canonical Working-Copy Compiler

**Goal**: Route all project working-copy compiles through one helper that assembles full companion inputs.

**Tasks**:

1. Add `apps/runtime/src/services/project-working-copy-compiler.ts`
2. Resolve prompt-library refs before compile and propagate `libraryRef` metadata into IR
3. Append config-backed behavior-profile documents before compile
4. Resolve tools from parsed documents with connector support
5. Migrate runtime working-copy callers:
   - deployment resolver fallback
   - channel pipeline session factory
   - HTTP chat fresh-compile paths
   - internal chat fresh-compile path
   - WebSocket debug load/resume paths
   - runtime project IR rebuild path

**Exit Criteria**:

- [x] Runtime working-copy compile helper is the canonical seam across the touched project fresh-compile callers
- [x] Working-copy compiles now include behavior profiles and prompt-library refs
- [x] `apps/runtime/src/__tests__/project-working-copy-compiler.test.ts` passes
- [x] `apps/runtime/src/__tests__/channels/pipeline-session-factory.test.ts` passes
- [x] Filtered affected-package build includes Runtime and completes cleanly

**Test Strategy**:

- Integration: real prompt-library version + behavior-profile config inputs compile into runtime IR
- Unit: pipeline session factory proves working-copy session creation uses the canonical seam

**Rollback**: Restore old per-caller `compileToResolvedAgent(...)` paths.

---

### Phase 3: Durable Working-Copy Refresh Hardening

**Goal**: Ensure durable working-copy channel sessions refresh when any compile-affecting companion input changes.

**Tasks**:

1. Expand `resolveWorkingCopyCompilationHash()` inputs to include config variables
2. Include `ProjectAgent.systemPromptLibraryRef` in the agent snapshot hash
3. Query referenced `PromptLibraryVersion` rows and include their source/status state
4. Keep the hash deterministic and sorted
5. Add regression tests for config-backed behavior-profile edits and prompt-library version edits

**Exit Criteria**:

- [x] Hash changes after config variable edits
- [x] Hash changes after prompt-library draft/version content changes for referenced agents
- [x] No false-positive refresh when compile-affecting inputs are unchanged
- [x] `apps/runtime/src/__tests__/sessions/session-resolver-gaps.test.ts` passes

**Test Strategy**:

- Unit/integration hybrid: existing session resolver gap tests extended with deterministic hash fixtures

**Rollback**: Revert hash payload expansion and associated refresh logic.

---

### Phase 4: Studio Compile Preview Parity

**Goal**: Make Studio project-aware and scratch compile surfaces assemble the same companion inputs that runtime fresh compiles use.

**Tasks**:

1. Update `buildProjectCompileContext()` to:
   - resolve target + sibling prompt-library refs
   - append config-backed behavior-profile documents
   - resolve all project tool bindings from parsed docs
   - include connector tool resolution
2. Export a Studio connector tool resolver from `connection-service.ts`
3. Verify the project agent compile route remains correctly wired through the project-aware compile helper without requiring additional production code changes
4. Update generic `/api/abl/compile` route to include config-backed documents and connector-aware tool resolution when scoped by project

**Exit Criteria**:

- [x] Studio project-aware compile includes prompt-library refs, behavior profiles, and connector-backed tools
- [x] Project-aware compile fails closed on prompt-library resolution errors
- [x] `apps/studio/src/__tests__/project-aware-compile.test.ts` passes
- [x] `apps/studio/src/__tests__/api-routes/api-abl-compile-route.test.ts` passes
- [x] `pnpm --filter @agent-platform/studio exec tsc --noEmit` passes
- [x] Filtered affected-package build includes the Studio production build and completes cleanly

**Test Strategy**:

- Unit: project-aware compile helper assertions on docs/options assembly
- Route tests: compile endpoints pass correct compiler options and surface context failures

**Rollback**: Restore prior Studio compile context assembly and connector resolution behavior.

---

## 4. Wiring Checklist

- [x] Shared prompt helper exported through `@agent-platform/shared/prompts`
- [x] Shared behavior-profile parser exported through `@agent-platform/project-io`
- [x] Runtime project working-copy callers all use the canonical helper
- [x] DeploymentResolver working-copy fallback uses the canonical helper
- [x] Session invalidation hash reads prompt-library version metadata
- [x] Studio connector resolver exported from `connection-service.ts`
- [x] Studio compile routes call the updated project-aware compile helper

---

## 5. Cross-Phase Concerns

### Feature Flags

No feature flag. This is parity hardening for existing authoring and working-copy execution surfaces, so a split rollout would preserve known drift.

### Compatibility

- `compileToResolvedAgent()` remains available for raw DSL/test harness callers
- Project working-copy callers move to the new canonical helper
- Draft prompt-library versions remain resolvable for design-time and working-copy testing, matching current version-service behavior

### Observability

- Log behavior-profile parse failures as warnings, but do not silently drop prompt-library resolution failures
- Final response should document any remaining unrelated build/test failures outside this slice

---

## 6. Acceptance Criteria

- [x] Runtime working-copy fresh-compile paths no longer lose config-backed behavior profiles
- [x] Runtime working-copy fresh-compile paths no longer ignore `systemPromptLibraryRef`
- [x] Durable working-copy channel sessions refresh after config-variable, behavior-profile, or referenced prompt-library version edits
- [x] Studio compile preview matches runtime for project-aware behavior profiles, prompt-library refs, and connector-backed tools
- [x] Focused test verification passes for the touched runtime and Studio slices
- [x] Studio typecheck for the touched compile-preview surface passes
- [x] Broader filtered build verification is clean for the affected packages

---

## 7. Assumptions

1. Working-copy execution should keep supporting prompt-library draft versions, consistent with current `VersionService` resolution behavior.
2. Studio IR preview remains based on persisted agent metadata plus optional draft DSL text; unsaved prompt-library picker state is out of scope for this hardening pass.
3. Session invalidation should treat all project config variables as compile/runtime-affecting because localization catalogs and behavior-profile docs are both derived from that collection.

---

## 8. Future-Ready Guardrails

- Any future project working-copy compile path should call `compileProjectWorkingCopy(...)` instead of reconstructing agent documents, config variables, prompt refs, or tool resolution locally.
- Compile-affecting companion metadata stored outside the DSL should be added through shared seams in `@agent-platform/shared` or `@agent-platform/project-io`, not app-local one-offs.
- Durable session invalidation must hash every compile-affecting companion lane together: DSL, config variables, prompt refs, and referenced prompt version state.
- Studio compile preview should continue sharing prompt-ref, behavior-profile, and connector tool resolution seams with runtime so “green in Studio” keeps meaning “same shape as runtime.”
- Targeted slice locks should accompany every new companion input lane so drift is caught at the seam that introduced it.

---

## 9. Verification Notes

### Focused Green Lanes

- `pnpm --filter @agent-platform/runtime exec vitest run --config vitest.config.ts src/__tests__/project-working-copy-compiler.test.ts src/__tests__/channels/pipeline-session-factory.test.ts src/__tests__/routes/internal-chat.test.ts src/__tests__/sessions/chat-routes.test.ts src/__tests__/channels/ws-handler.test.ts src/__tests__/sessions/session-resolver-gaps.test.ts src/__tests__/tools-deployment/deployment-resolver.test.ts`
- `pnpm --filter @agent-platform/studio exec vitest run --config vitest.node.config.ts src/__tests__/project-aware-compile.test.ts src/__tests__/api-routes/api-abl-compile-route.test.ts src/__tests__/api-routes/api-project-agent-compile-route.test.ts`
- `pnpm --filter @agent-platform/studio exec tsc --noEmit`

### Broader Build Lane

- `pnpm --filter @agent-platform/shared-kernel --filter @agent-platform/database --filter @agent-platform/shared --filter @agent-platform/project-io --filter @abl/core --filter @abl/compiler --filter @abl/language-service --filter @agent-platform/web-sdk --filter @agent-platform/runtime --filter @agent-platform/studio build`

# Cross-Graph Draft Readiness Invalidation Hardening

## Context

We already moved `ProjectAgent` draft readiness onto compile-backed metadata, but the remaining
staleness bugs all share the same root cause: we still refresh readiness as if a draft were
single-agent state.

That assumption breaks in five places:

- import refresh runs before tool/MCP/config/profile mutations finish
- Studio visual saves only update the edited agent row
- Studio raw DSL saves suppress project-wide recompute when they pass explicit diagnostics
- non-DSL agent mutations and deletes do not invalidate sibling readiness
- tool CRUD changes project compile context without recomputing dependent agent metadata

The system needs one stronger contract: **draft readiness is project-graph state, not row-local
state**.

## Target Contract

Every mutation that can change project-aware compilation must leave persisted
`ProjectAgent.sourceHash`, `dslValidationStatus`, and `dslDiagnostics` consistent with the
**final persisted project graph**.

Graph-affecting mutations include:

- agent create/update/delete
- agent rename and prompt-library reference changes
- project tool create/update/delete
- import-stage MCP server mutations
- import-stage config/profile/locale mutations that influence compile context

The refresh must run:

- after the final persisted dependency state is in place
- once per mutation batch where possible
- from a narrow app-level orchestration point rather than duplicated route logic

## Design Decisions

### D1. Keep one shared evaluator, widen invalidation triggers

The shared evaluator in `@agent-platform/project-io` stays the single source of truth for batch
metadata computation. We do **not** introduce another readiness calculator.

Instead, we widen the conditions under which apps call the evaluator:

- imports refresh after all compile-context mutations, not just agent stages
- Studio repo updates refresh after any compile-context-affecting agent mutation
- tool mutation entrypoints refresh after persistence succeeds

### D2. Route diagnostics and persisted metadata are separate concerns

Studio save routes may still compute targeted save-time diagnostics for user responses, but that
must not suppress the post-persist project-wide refresh.

The response contract stays:

- `/dsl`: draft-friendly, returns save-time diagnostics
- `/edit`: fail-closed, returns save-time diagnostics for the spliced content

The persistence contract changes:

- both routes must still reconcile all persisted agent rows after success

### D3. Invalidation belongs at orchestration boundaries

We should not require every caller to remember which downstream metadata fields need recomputing.

Use these orchestration boundaries:

- shared import executor lifecycle hook for import batches
- Studio project-agent repo for agent mutations
- a Studio tool-mutation helper for tool CRUD entrypoints

This keeps future write paths from reintroducing stale readiness by bypassing route-local code.

### D4. Refresh only after successful persistence

The invalidation contract is:

- write succeeds
- refresh succeeds or surfaces failure

No refresh should run for rejected or failed mutations. No caller should clear dirty state or act
as if persistence completed when the write failed.

## Slice Plan

### Slice 1: Import Final-State Refresh Ordering

**Goal**: ensure import reconciliation runs after the final dependency graph is persisted.

**Tests first**:

- lock `refresh_agent_draft_metadata` ordering after tool/MCP/profile/locale stages
- add a tool-only import test proving refresh still runs even when there are no agent operations

**Implementation**:

- move the refresh stage in `core-direct-apply.ts` to after compile-context dependency stages
- trigger refresh when any graph-affecting import operation occurred, not only agent operations

**Exit criteria**:

- tool-only imports refresh agent metadata
- mixed imports refresh after dependency persistence and before entry-agent update

### Slice 2: Studio Save Paths Reconcile the Whole Project

**Goal**: successful `/dsl` and `/edit` writes refresh all persisted agent rows.

**Tests first**:

- lock repo behavior so explicit `dslValidationStatus` no longer suppresses project-wide refresh
- update `/edit` route tests to assert persistence goes through the repo invalidation path

**Implementation**:

- make `updateProjectAgent()` refresh on compile-context-affecting DSL writes even when explicit
  diagnostics are supplied
- route `/edit` persistence through `updateProjectAgent()` instead of direct `findOneAndUpdate()`

**Exit criteria**:

- raw DSL saves refresh sibling metadata
- surgical visual saves refresh sibling metadata

### Slice 3: Non-DSL Agent Mutations and Deletes Invalidate Siblings

**Goal**: Studio agent rename/delete/prompt-library updates cannot leave stale readiness rows.

**Tests first**:

- add repo tests for rename-only refresh
- add repo tests for delete-triggered refresh

**Implementation**:

- widen `updateProjectAgent()` invalidation triggers to name / prompt-library / relevant agent
  identity changes
- refresh after `deleteProjectAgent()` succeeds

**Exit criteria**:

- rename-only and delete flows recompute surviving agent metadata

### Slice 4: Tool CRUD Invalidates Dependent Agent Readiness

**Goal**: any Studio tool create/update/delete path refreshes dependent agent metadata.

**Tests first**:

- add a focused Studio helper test that locks refresh after create/update/delete
- extend tool route tests to assert refresh happens on create/update/delete/duplicate/import

**Implementation**:

- add a small Studio tool-mutation invalidation helper
- wire all current Studio tool mutation entrypoints through it:
  - project tool routes
  - duplicate/import routes
  - `tool-creation-service`
  - Arch AI tool ops

**Exit criteria**:

- tool CRUD refreshes project agent draft metadata consistently across Studio entrypoints

## Files Expected

### Modified

- `packages/project-io/src/import/core-direct-apply.ts`
- `packages/project-io/src/__tests__/core-direct-apply.test.ts`
- `apps/studio/src/repos/project-repo.ts`
- `apps/studio/src/__tests__/project-repo-draft-metadata.test.ts`
- `apps/studio/src/app/api/projects/[id]/agents/[agentId]/edit/route.ts`
- `apps/studio/src/__tests__/api-routes/api-agent-edit-route.test.ts`
- `apps/studio/src/app/api/projects/[id]/tools/route.ts`
- `apps/studio/src/app/api/projects/[id]/tools/[toolId]/route.ts`
- `apps/studio/src/app/api/projects/[id]/tools/[toolId]/duplicate/route.ts`
- `apps/studio/src/app/api/projects/[id]/tools/import/route.ts`
- `apps/studio/src/lib/tool-creation-service.ts`
- `apps/studio/src/lib/arch-ai/tools/tools-ops.ts`
- `apps/studio/src/__tests__/api-routes/api-tool-routes.test.ts`

### New

- `apps/studio/src/lib/project-tool-draft-invalidation.ts`
- `apps/studio/src/__tests__/project-tool-draft-invalidation.test.ts`

## Verification

Focused verification after each slice:

1. `npx prettier --write <changed files>`
2. run the slice-lock tests only
3. run scoped builds/typechecks before moving on

Final verification target:

- `pnpm --filter @agent-platform/project-io test:fast src/__tests__/core-direct-apply.test.ts`
- `pnpm --dir apps/studio test:fast src/__tests__/project-repo-draft-metadata.test.ts src/__tests__/api-routes/api-agent-edit-route.test.ts src/__tests__/project-tool-draft-invalidation.test.ts src/__tests__/api-routes/api-tool-routes.test.ts`
- `pnpm --filter @agent-platform/project-io build`
- `pnpm --dir apps/studio typecheck`

## Residual Follow-On

This plan intentionally stays scoped to the five identified findings. After it lands, the next
logical follow-on is direct config-variable / behavior-profile invalidation outside import flows,
because those paths also participate in project-aware compile context.

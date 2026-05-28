# Project Agent Draft Metadata Hardening

## Context

We already hardened the main Studio DSL save paths, but several side-door `ProjectAgent.dslContent`
writers still bypass compile-backed draft readiness metadata:

- Studio import marks parse-valid but compiler-invalid drafts as `valid`.
- Runtime import writes agent drafts without `dslValidationStatus` / `dslDiagnostics`.
- Runtime `PUT /api/projects/:projectId/agents/:agentName/dsl` updates `dslContent` without
  refreshing `sourceHash` or draft readiness metadata.
- Arch AI agent edits update DSL and rename cascades without refreshing validation metadata.
- Studio repo fallback auto-generates parse-only draft metadata for raw `dslContent` writes.
- `useSectionEdit` drops pending edits when a save attempt fails.

The architectural problem is not one route at a time. It is that draft persistence does not have
one canonical contract.

## Target Contract

Every successful `ProjectAgent.dslContent` mutation must update these fields atomically enough that
subsequent readiness checks see a self-consistent draft state:

- `sourceHash`
- `dslValidationStatus`
- `dslDiagnostics`

That metadata must be computed from the **project-scoped final agent state**, not from the single
edited DSL in isolation. This is required so deletes, renames, and cross-agent reference changes
can invalidate untouched siblings immediately.

## Future-Ready Design

### 1. Shared pure evaluator in `@agent-platform/project-io`

Add a batch-oriented helper that accepts the projected project agent DSL state plus compiler
context and returns per-record metadata:

- Input:
  - persisted record name
  - draft DSL content
  - compiler options / resolved tool implementations / config variables
  - metadata source label
  - optional context load warnings/errors
- Output:
  - `sourceHash`
  - `dslValidationStatus`
  - `dslDiagnostics`
  - structured `errors` / `warnings` for callers that need route-level diagnostics

Why batch-oriented:

- imports can create, update, and delete multiple agents together
- a delete can invalidate untouched siblings
- a rename can move errors onto other records
- future bulk-edit flows should not need a new metadata path

### 2. App-specific project-state loaders

Keep database reads and environment-specific tool resolution outside the shared package:

- Studio loader:
  - current project agents
  - config variables
  - resolved tool implementations via shared resolver
- Runtime loader:
  - current project agents
  - config variables
  - resolved tool implementations via runtime resolver path

Both loaders should support projected overrides so callers can evaluate:

- one edited agent
- a rename cascade
- an import plan’s final state

### 3. Project-wide metadata refresh hooks

Add narrow refresh helpers per app that recompute metadata for all persisted agents in a project
after a DSL mutation path completes.

This gives us two layers of protection:

- direct write payloads still carry best-effort metadata for newly created/updated agents
- a final refresh reconciles untouched siblings and delete-induced breakage

### 4. Import adapter lifecycle hook

Extend the core import apply adapter with an optional post-agent-mutation hook:

- called once after create/update/delete agent stages
- recomputes project-wide draft metadata for the now-persisted final agent set

This keeps import-specific reconciliation out of route files and makes Studio/runtime imports use
the same lifecycle.

### 5. Save retry contract

`useSectionEdit` must preserve the pending batch on failure so transient errors do not silently
drop the user’s last unsaved changes.

## Implementation Slices

### Slice 1: Shared evaluator + Studio import

Goal:

- introduce the batch evaluator in `packages/project-io`
- lock compile-invalid but parse-valid metadata behavior in unit tests
- switch Studio import create/update writes to the shared evaluator
- add import post-agent refresh for final-state reconciliation

Tests first:

- new `packages/project-io` evaluator tests
- Studio import adapter tests for:
  - compiler-invalid imported draft becomes `error`
  - post-delete sibling metadata refresh runs

Exit criteria:

- Studio import no longer produces false `valid` status for compiler-invalid drafts
- deletes/imported renames can refresh untouched sibling metadata

### Slice 2: Runtime import + runtime DSL update

Goal:

- use the shared evaluator in runtime import adapter
- add runtime import post-agent refresh
- make runtime DSL update recompute full project draft metadata instead of only `dslContent`

Tests first:

- runtime import route tests for metadata on persisted writes
- runtime repo/route tests for `sourceHash`, `dslValidationStatus`, and sibling refresh after DSL update

Exit criteria:

- runtime import and runtime DSL save cannot leave stale readiness metadata behind

### Slice 3: Studio repo fallback + Arch AI mutation flows

Goal:

- replace Studio repo parse-only fallback with compile-backed projected-state metadata
- refresh metadata after Arch AI primary edits and rename cascades

Tests first:

- new Arch AI mutation persistence tests
- Studio repo tests for compile-invalid projected writes if needed

Exit criteria:

- all Studio-side raw `dslContent` writers share the same draft metadata contract

### Slice 4: Autosave retry durability

Goal:

- preserve pending section edits when `/edit` fails
- ensure the next retry flush still sends the dropped batch

Tests first:

- hook regression test proving failed save is re-queued and retried

Exit criteria:

- transient save failures cannot silently discard pending visual edits

## Verification

After each slice:

1. run the focused test file(s) that lock the slice
2. format changed files with `npx prettier --write`
3. run package/app builds before broader tests

Final verification:

- `pnpm build --filter @agent-platform/project-io --filter @agent-platform/runtime --filter @agent-platform/studio`
- focused Studio/runtime/project-io tests for the touched paths
- `pnpm --dir apps/studio typecheck`

## Follow-On

After this lands, the remaining cleanup is optional deduplication:

- move Studio `/dsl` and `/edit` route validation onto the same shared projected-state wrapper
- surface project-wide sibling draft invalidation in Studio UI with richer diagnostics
- consider background reconciliation for older projects with stale metadata

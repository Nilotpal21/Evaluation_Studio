# ABLP-612 Studio to Runtime Hidden Issues Hardening Plan

## Goal

Close the remaining end-to-end drift across Studio, database migrations, authored DSL/YAML, SDK/channel action submits, prompt-library references, and runtime draft metadata so agent routing and prompt reference behavior are deterministic across authoring, persistence, import/export, and live execution.

## Design Principles

- Server-owned identity fields stay server-owned. `ProjectAgent.agentPath` is derived from `{ projectId, name }`; clients may not create, mutate, or teach old path shapes.
- Compatibility is explicit at boundaries. Legacy request fields may be accepted only when harmless and ignored, while mutation APIs reject fields that would corrupt canonical state.
- Rich action submits have one canonical envelope: `actionId`, `value`, `renderId`, and optional `formData`.
- Blocking references must be visible in the UI that asks users to remediate them.
- Draft metadata refreshes whenever a referenced dependency changes, not only when the agent row changes.
- YAML and text ABL should converge on the ordered `do` action model for future action surfaces.

## Slice Plan

### Slice 1: Canonical ProjectAgent Path Immutability

Tests first:

- Add route regression that PATCH with `agentPath` returns `400` and does not call `updateAgent`.
- Update create-dialog and API-client tests to assert `agentPath` is no longer sent.
- Add service regression that `updateAgent({ name })` derives the canonical path and strips caller path input.

Implementation:

- Remove `agentPath` from Studio create request shape and client payload.
- Reject `agentPath` on PATCH with a validation error.
- Make `project-service.updateAgent` derive `agentPath` when `name` changes and never forward caller-supplied `agentPath`.

### Slice 2: Migration Validation Supersession

Tests first:

- Add Mongo migration validation regression proving `20260227_005.validate()` passes when the newer `{ tenantId, projectId, agentPath }` unique index exists and the old project-only index is absent.

Implementation:

- Treat the tenant-scoped index as a valid superseding state for the older migration.
- Keep failure when neither project-scoped nor tenant-scoped unique index exists, or when the global `agentPath` index remains.

### Slice 3: Action Submit FormData Parity

Tests first:

- Add React `ActionHandler` regression for `submit_id`, `submit_label`, `renderId`, required validation, and `formData`.
- Add Slack `block_actions` regression for `state.values` flattening into `actionEvent.formData`.

Implementation:

- Update React `ActionHandler` to defer input/select values to submit when `submit_id` is present.
- Include `renderId` and `formData` in submit options.
- Parse Slack `block_actions.state.values` with the same value extraction as modal submissions.

### Slice 4: Prompt Reference Visibility and Metadata Freshness

Tests first:

- Update Studio API/UI references tests to include `draftAgents`.
- Add runtime prompt-library regression that `updateVersion()` refreshes persisted runtime draft metadata.

Implementation:

- Extend Studio `fetchReferences()` type and detail page state to render active version refs and draft agent refs together, with draft refs clearly labeled.
- Refresh runtime ProjectAgent draft metadata after prompt draft updates.

### Slice 5: YAML Direct Handler Parity

Tests first:

- Add YAML parser regression for direct `set/respond/call/handoff/delegate/clear/complete/goto` fields becoming ordered `do` actions.

Implementation:

- Normalize direct YAML action-handler fields into `do[]` using the same canonical action shape as text ABL.
- Preserve legacy mirror fields for `set/respond/transition` compatibility.

## Verification

- Run focused package tests for touched areas:
  - Studio route/service/component/API tests for project agents and prompt references.
  - Database migration test for agent path validation.
  - Web SDK React component tests.
  - Runtime Slack and prompt-library tests.
  - Core YAML parser tests.
- Run scoped builds for touched packages after edits.
- Format changed files with Prettier before commit.

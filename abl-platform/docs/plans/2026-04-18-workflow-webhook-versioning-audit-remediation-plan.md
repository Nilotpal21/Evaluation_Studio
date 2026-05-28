# LLD: Workflow Webhook Versioning Audit Remediation

**Feature Spec**: [`docs/features/sub-features/workflow-webhook-versioning.md`](../features/sub-features/workflow-webhook-versioning.md)  
**HLD**: [`docs/specs/workflow-webhook-versioning.hld.md`](../specs/workflow-webhook-versioning.hld.md)  
**Testing Guide**: [`docs/testing/sub-features/workflow-webhook-versioning.md`](../testing/sub-features/workflow-webhook-versioning.md)  
**Review Rubric**: `/Users/prasannaarikala/projects/f-1/abl-platform/docs/sdlc/change-review-rubric.md`  
**Status**: DONE (implemented and validated 2026-04-18)  
**Date**: 2026-04-18  
**Owner**: Runtime Team

## 1. Review Inputs

This remediation plan addresses four post-merge review findings on the workflow webhook versioning feature:

1. Runtime short-URL execute/status paths forward an internal service token that workflow-engine unified auth does not accept.
2. Runtime execute validation still uses the workflow container `inputSchema` instead of the resolved workflow version schema.
3. Studio workflow-tool create flow auto-selects a concrete version for preview/trigger filtering but does not persist that selection into the saved binding.
4. Runtime short-URL execute path still blocks on the workflow container `status`, even though version-first execution semantics are owned by `WorkflowVersion.state`.

## 2. Rubric Concerns And Impact Areas

Primary concerns from the review rubric:

| Concern                                                   | Why It Applies Here                                                                                                                                 | Proof Required                                                                         |
| --------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------- |
| Scope, Identity & Authorization                           | The short URL is an external API-key boundary that proxies into workflow-engine. Auth must remain caller-authenticated, not service-token-repaired. | Public-boundary auth forwarding tests for execute and status poll.                     |
| Contracts & Compatibility                                 | The short URL, workflow-engine, Studio create dialog, and tool binding DSL must agree on version and schema semantics.                              | Boundary tests plus Studio config regression coverage.                                 |
| Execution & Orchestration                                 | Version resolution chooses the executable canvas and therefore the validation schema and trigger set.                                               | Execute-path tests for explicit pins, default resolution, and draft-status containers. |
| Activation, Deployment & Reachability                     | The runtime route must remain wired to the real workflow-engine auth contract, not only a local stub.                                               | Runtime E2E coverage against the mounted auth middleware + engine header assertions.   |
| Test Integrity, Regression Coverage & Behavior Validation | The motivating bugs were boundary mismatches, so fixes need public-surface tests instead of helper-only assertions.                                 | Runtime E2E coverage and Studio component/create-flow regression tests.                |

Persona lanes touched:

- **External caller**: API-key workflow execution and status polling through `/api/v1/workflows`.
- **Platform developer**: runtime route adapter, workflow-engine auth boundary, version resolver, schema validation.
- **Agent developer / Studio builder**: workflow-tool binding creation and persisted `workflowVersion` semantics.

## 3. Future-Ready Solution Decisions

### Finding 1: Engine auth token type is incompatible

**Decision**

- Stop minting internal service tokens on the short execute and status-poll paths.
- Forward the original caller auth header(s) and trace headers from runtime to workflow-engine, matching the existing project-scoped proxy contract.

**Why this is future-ready**

- Keeps runtime and workflow-engine aligned on one auth contract instead of inventing a second internal-only lane for public webhook calls.
- Preserves support for both `Authorization: Bearer abl_*` and `x-api-key` callers if the boundary expands.
- Reuses the same forwarding model already documented in `workflow-engine-proxy.ts`.

**Implementation**

- Make `handleWorkflowExecute()` accept prepared engine headers instead of minting its own token.
- Add a shared route-local header builder in `workflows-execute.ts`.
- Reuse that builder for the status-poll proxy path.

**Regression proof**

- Runtime E2E asserts workflow-engine receives the raw caller credential on execute.
- Runtime E2E asserts workflow-engine receives the raw caller credential on status poll.

### Finding 2: Version-specific schemas are not validated

**Decision**

- Resolve the effective input schema at the route adapter, alongside version resolution.
- Validate against `resolvedVersion.definition.inputSchema` when present, with fallback to the workflow container schema only when the version definition omits one.

**Why this is future-ready**

- Keeps the shared handler generic and version-agnostic while making the route adapter responsible for choosing the executable target.
- Matches the version-first runtime contract: the selected `WorkflowVersion` owns execution-time structure.
- Preserves backward compatibility for older version definitions that do not yet carry `definition.inputSchema`.

**Implementation**

- Add `inputSchema` to `WorkflowExecuteHandlerArgs`.
- Thread the effective schema from both explicit version pins and default-version resolution.

**Regression proof**

- Runtime E2E for explicit version pins with diverged container/version schemas.
- Runtime E2E for default-resolution executes with diverged container/version schemas.

### Finding 3: Auto-selected Studio version is not persisted

**Decision**

- Keep the workflow-tool **create** flow WYSIWYG: if the form auto-selects a concrete version to preview triggers and params, it persists that version into `workflowVersion`.
- Preserve existing **edit** flow behavior by making auto-persist opt-in from `ToolCreateDialog`, so already-saved auto-resolve bindings are not silently rewritten.

**Why this is future-ready**

- Aligns the saved binding with the version-specific trigger set and parameter preview the user actually sees.
- Avoids surprising edits to existing tools whose operators intentionally rely on auto-resolve semantics.
- Leaves the explicit empty-picker option available for users who want deliberate auto-resolve behavior.

**Implementation**

- Add `persistAutoSelectedVersion?: boolean` to `WorkflowConfigForm`.
- Enable it only in `ToolCreateDialog`.
- Reset/create-flow auto-persist on workflow changes and disable it after explicit user version picks.

**Regression proof**

- Studio component regression test proving create-mode auto-selection persists `workflowVersion`.
- Studio component regression test proving edit-style auto-resolve bindings remain unpinned while still previewing the current version.

### Finding 4: Legacy workflow container status gate blocks version-first executes

**Decision**

- Remove the `workflow.status === 'active'` short-route gate.
- Treat `WorkflowVersion` resolution as the source of truth for executability.

**Why this is future-ready**

- Matches the workflow-engine execute path and the shared workflow-tool binding validator, both of which already treat container status as vestigial after the version-first migration.
- Avoids divergent behavior between Studio/project-scoped execution and external short-URL execution.
- Supports legitimate cases where the container remains `draft` while a published or explicit version is still runnable.

**Implementation**

- Delete the early container-status 404 from `workflows-execute.ts`.
- Keep concealment on workflow existence and project scope unchanged.

**Regression proof**

- Runtime E2E showing a draft-status container still executes when a runnable version resolves.

## 4. File-Level Change Set

| Area                           | Files                                                                                                                               |
| ------------------------------ | ----------------------------------------------------------------------------------------------------------------------------------- |
| Runtime execute contract       | `apps/runtime/src/routes/workflow-execute-handler.ts`, `apps/runtime/src/routes/workflows-execute.ts`, `apps/runtime/src/server.ts` |
| Runtime regression tests       | `apps/runtime/src/__tests__/workflows-execute.e2e.test.ts`                                                                          |
| Studio create-flow persistence | `apps/studio/src/components/tools/WorkflowConfigForm.tsx`, `apps/studio/src/components/tools/ToolCreateDialog.tsx`                  |
| Studio regression tests        | `apps/studio/src/__tests__/components/workflow-config-form-version-persistence.test.tsx`                                            |
| Doc sync                       | workflow webhook versioning feature/HLD/testing docs plus this remediation plan                                                     |

## 5. Validation Plan

1. Run `npx prettier --write` on every changed file before commit.
2. Run targeted package builds before tests to catch type and signature regressions quickly.
3. Run targeted runtime tests for short-URL execute/status behavior.
4. Run targeted Studio tests for workflow config persistence.
5. Run repo `pnpm build` before broader test execution, per repo policy.
6. Run `./tools/run-semgrep.sh` because this change touches auth and HTTP route boundaries.
7. Commit with the existing Jira key `ABLP-2`, then push `Workflow_Tool`.

## 6. Validation Snapshot

- `pnpm --filter @agent-platform/runtime build`
- `pnpm --filter @agent-platform/studio build`
- `pnpm --filter @agent-platform/runtime exec vitest run --config vitest.e2e.config.ts src/__tests__/workflows-execute.e2e.test.ts`
- `pnpm --filter @agent-platform/studio exec vitest run src/__tests__/components/workflow-config-form-version-persistence.test.tsx`
- repo root `pnpm build`
- `./tools/run-semgrep.sh apps/runtime/src/routes/workflow-execute-handler.ts apps/runtime/src/routes/workflows-execute.ts apps/studio/src/components/tools/WorkflowConfigForm.tsx apps/studio/src/components/tools/ToolCreateDialog.tsx` → 0 findings

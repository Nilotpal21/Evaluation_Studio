# ABLP-612 Runtime Export, Identity, and Action Payload Hardening LLD

Status: IN PROGRESS
Date: 2026-05-04

## Problem

The Studio -> DB -> DSL -> runtime path still has a few split-brain contracts:

- Studio PATCH can rename agents with names that create invalid DSL/path identity.
- Some export paths can publish persisted drafts marked with compiler errors.
- Runtime action payload validation is strict for WebSocket/SDK, but channel adapters can still pass malformed `formData` into `_action`.
- `ProjectAgent.agentPath` is canonical in services, but not enforced at the model boundary.

The future-ready shape is to make each invariant live at the lowest shared boundary, with route checks as defense in depth.

## Design Decisions

1. **Agent identity is shared-kernel vocabulary.** Agent names use `AGENT_NAME_PATTERN` everywhere. Canonical paths use `buildProjectAgentPath(projectId, name)` and are derived, not client mutable.
2. **Model-level canonicalization is the last write guard.** `ProjectAgent` save/insert/update hooks derive `agentPath` from `projectId + name`. Service and import code should still set it explicitly for clarity.
3. **Export readiness belongs in `project-io`.** Studio sync export, Studio async export, Runtime project-io export, and preview should all use one helper and one error payload: `409 INVALID_AGENT_DRAFT`.
4. **Action envelopes are channel-wide runtime input.** The WebSocket validator becomes a shared channel validator. Flow execution rejects malformed `ActionEvent` payloads before `_action.formData` becomes DSL-visible, clears the bad event, preserves wait state, and emits trace details.
5. **Compatibility is narrow.** Existing legacy SDK value-as-JSON form payload support stays at SDK ingress only; steady-state action events use typed `formData`.

## Slices

### Slice 1: Identity Contract

Tests first:

- Studio PATCH rejects names with spaces, slashes, and other invalid ABL identifiers.
- `ProjectAgent` create/insertMany/findOneAndUpdate cannot persist arbitrary `agentPath`.

Implementation:

- Reuse `AGENT_NAME_PATTERN` and `AGENT_NAME_MAX_LENGTH` in the Studio PATCH route.
- Move `buildProjectAgentPath` to `shared-kernel`, re-export from `shared`, and use it from the database model.
- Add model hooks for document validation, insertMany, and identity/path updates.

Exit criteria:

- Invalid names never reach `updateAgent`.
- Direct model writes normalize the path to `projectId/name`.

### Slice 2: Export Readiness

Tests first:

- `project-io` helper reports non-empty drafts with `dslValidationStatus === "error"` and fails closed for non-empty drafts without trusted validation metadata.
- Studio async export returns `INVALID_AGENT_DRAFT` before `exportProjectV2`.
- Runtime export preview/export return `409 INVALID_AGENT_DRAFT` before graph/provisioning/export work.

Implementation:

- Add `project-agent-export-readiness` to `@agent-platform/project-io`.
- Replace Studio-local implementation with a compatibility re-export.
- Wire Runtime preview/export and Studio async job to the shared helper.

Exit criteria:

- No public export surface materializes invalid persisted draft DSL.

### Slice 3: Channel Action Payload Validation

Tests first:

- Shared action-event validator rejects array/oversized/deep/unsafe `formData`.
- Flow action dispatch rejects malformed channel action events without firing handlers.
- Existing WebSocket/SDK parser tests continue to pass through the same validator.

Implementation:

- Move the action-submit envelope validator to `services/channels/action-event-validation`.
- Keep `websocket/action-submit-envelope` as a compatibility re-export.
- Use the validator in `flow-step-executor` before building `_action`.
- Emit `action_submit_rejected` with redacted reason/details and clear only the bad action event.

Exit criteria:

- Slack/Teams/Line/Web SDK action forms either arrive as canonical `_action.formData` or fail closed with a visible retry message.

## Rollout And Rollback

- Rollout is fail-closed at export/action boundaries and canonicalizing at model writes.
- Rollback is safe because canonical paths remain compatible with current runtime lookup (`tenantId + projectId + name`).
- If channel validation is too strict for a production adapter, temporarily narrow the adapter normalization rather than weakening `_action` validation.

## Verification

- `pnpm --filter @agent-platform/shared-kernel build`
- `pnpm --filter @agent-platform/shared build`
- `pnpm --filter @agent-platform/database build`
- `pnpm --filter @agent-platform/project-io build`
- `pnpm --filter @agent-platform/runtime build`
- `pnpm --filter @agent-platform/studio build`
- Focused Vitest locks for Studio agent route, database model, project-io readiness, Studio async export, Runtime project-io routes, and flow action dispatch.

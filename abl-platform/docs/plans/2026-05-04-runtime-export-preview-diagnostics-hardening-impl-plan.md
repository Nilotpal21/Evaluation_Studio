# Runtime Export Preview Diagnostics Hardening Plan

## Context

Export readiness has already been hardened on the main Studio export, bundle, git push, and async export paths through the shared project-level readiness helper in `@agent-platform/project-io`. The remaining gaps are now concentrated in three surfaces:

1. Runtime public export preview/export still gate on agent-draft readiness only.
2. Studio export preview still does not use the shared project-level readiness contract.
3. Studio client-side export flows still discard structured blocking diagnostics (`issues`) returned by the server.

That leaves two classes of drift:

- API parity drift: runtime public export can still preview/export a working copy that Studio blocks.
- UX drift: Studio can fail closed on export but still hide the actionable runtime-config or draft diagnostics from users.

## Goals

- Make runtime public export preview/export use the exact same project-level readiness contract as Studio export.
- Make Studio export preview use the same readiness contract as Studio export execution.
- Preserve structured export-blocking diagnostics from API response to Studio dialog/toast without weakening sanitization.

## Non-Goals

- Reworking the full export preview response schema beyond readiness gating.
- Replacing existing export dialog copy or redesigning the export UI.
- Changing the canonical readiness payload shape emitted by `@agent-platform/project-io`.

## Future-Ready Design

### 1. Single export-readiness authority

All export-like entry points should depend on:

- `getProjectExportReadinessIssues(...)`
- `buildInvalidProjectExportPayload(...)`

Inputs must include the full project context used by export:

- agents
- tenantId
- projectId
- runtimeConfig

This keeps runtime config validation centralized and prevents API surfaces from drifting back to agent-only gating.

### 2. Preview and export must share the same blocking contract

Preview is not an informational-only path anymore; it is the first readiness boundary for a real exportable working copy. The same project-level readiness contract should therefore apply to:

- Runtime `GET /project-io/export/preview`
- Runtime `GET /project-io/export`
- Studio `POST /projects/:id/export/preview`
- Studio `GET /projects/:id/export`

If a project is blocked for export, preview must say so too.

### 3. Structured diagnostics must survive to the UI

The API client should preserve safe structured payloads from non-2xx responses, especially:

- `issues`
- `error.code`
- `error.message`

The thrown `AppError` remains sanitized for human-readable message surfaces, but should carry a safe structured `cause` payload so UI components can render actionable diagnostics.

### 4. UI rendering contract

The export dialog should:

- show the first actionable blocking diagnostic inline when preview fails
- fall back to generic sanitized text when no structured diagnostics exist
- surface a concise actionable toast when export fails with structured issues

This keeps the UI future-ready for additional readiness issue kinds without coupling it to a single server failure shape.

## Slice Plan

### Slice 1: Runtime public export parity

Test-first locks:

- `GET /project-io/export/preview` returns `409` when runtime config fails project-level readiness.
- `GET /project-io/export` returns `409` when runtime config fails project-level readiness.
- Export execution is not invoked on blocked runtime-config readiness.

Implementation:

- Load `ProjectRuntimeConfig` in runtime export preview/export routes.
- Replace agent-only readiness calls with `getProjectExportReadinessIssues(...)`.
- Return `buildInvalidProjectExportPayload(...)` on blocking issues.

Exit criteria:

- Runtime preview/export are parity-aligned with Studio export on runtime-config failures.

### Slice 2: Studio export preview parity

Test-first locks:

- Studio export preview returns `409` when the shared project-level readiness helper reports a runtime-config issue.
- Preview does not continue to dependency/layer preview work when blocked.

Implementation:

- Load `ProjectRuntimeConfig` in Studio export preview route.
- Call `getProjectExportReadinessIssues(...)`.
- Return `buildInvalidProjectExportPayload(...)` on blocking issues.

Exit criteria:

- Studio preview no longer claims a blocked project is exportable.

### Slice 3: Structured diagnostics preservation to UI

Test-first locks:

- `handleResponse()` preserves structured export issues on thrown `AppError`.
- `ExportDialog` renders actionable blocking diagnostics from preview failures.
- `ExportDialog` uses actionable diagnostics in export failure toasts.

Implementation:

- Extend Studio client export typings for readiness issues.
- Preserve structured safe error payloads in `AppError.cause`.
- Add lightweight extraction/formatting helpers for export readiness diagnostics.
- Update `ExportDialog` to use the structured payload when present.

Exit criteria:

- Export UI shows actionable diagnostics instead of only generic failures.

## Verification

1. `pnpm build --filter @agent-platform/project-io --filter @agent-platform/runtime --filter @agent-platform/studio`
2. `pnpm --filter @agent-platform/runtime test:fast apps/runtime/src/__tests__/project-io-routes.test.ts`
3. `pnpm --filter @agent-platform/studio test:fast apps/studio/src/__tests__/api-routes/api-export-preview-route.test.ts apps/studio/src/__tests__/components/export-dialog.test.tsx`
4. `npx prettier --write <changed-files>`

## Risks and Guards

- Risk: Preview and export can drift again if one path reverts to agent-only gating.
  Guard: Route-level regression tests for both preview and export.

- Risk: Client-side structured error handling could expose unsafe internals.
  Guard: Preserve only server-returned payload after existing sanitization logic, while continuing to use sanitized `AppError.message` as the default human-facing fallback.

- Risk: UI coupling to one error shape.
  Guard: Use extraction helpers keyed on `issues` rather than route-specific assumptions.

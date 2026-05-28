# Feature: Workflow Webhook Versioning

**Doc Type**: SUB-FEATURE
**Parent Feature**: [Workflow Triggers](./workflow-triggers.md)
**Status**: ALPHA
**Feature Area(s)**: `integrations`, `project lifecycle`, `customer experience`
**Package(s)**: `apps/runtime`, `apps/workflow-engine`, `apps/studio`, `packages/compiler`, `packages/shared`
**Owner(s)**: Runtime Team
**Testing Guide**: [../../testing/sub-features/workflow-webhook-versioning.md](../../testing/sub-features/workflow-webhook-versioning.md)
**Last Updated**: 2026-04-19

---

## 1. Introduction / Overview

### Problem Statement

Workflow versioning exists end-to-end (`WorkflowVersion` model with `active`/`inactive` state, per-version trigger registrations, activate/deactivate lifecycle — see [Workflow Versioning](./workflow-versioning.md)), and a public webhook API exists at `/api/v1/process/:workflowId` (see [Workflow Triggers](./workflow-triggers.md) FR-01). However, **webhook callers cannot reliably target a specific version**, Studio users get no visual indication of which version a webhook call will hit, and the agent-tool invocation path has no version pinning at all. Concretely:

1. **Studio Webhook Quick Start is version-blind.** `apps/studio/src/components/workflows/triggers/WebhookQuickStart.tsx:68-70` already emits the `/api/v1/workflows/:id/execute` short URL pattern in the header, but (a) that route is **not yet mounted** in `apps/runtime/src/server.ts`, and (b) the URL contains no `?version=` parameter. Meanwhile, `apps/studio/src/components/workflows/triggers/CodeSnippets.tsx:48` still emits the long proxy URL `/api/projects/:pid/workflows/:wid/executions/execute` in its curl snippets. Users who publish `v0.1.0`, `v0.2.0`, `v0.3.0` cannot tell which version their copy-pasted URL will actually run, and the two Studio surfaces disagree on URL shape.
2. **Engine default resolution is non-deterministic.** `apps/workflow-engine/src/routes/workflow-executions.ts:311` executes `findOne({state:'active'})` with **no sort** — when multiple active versions exist, MongoDB returns an indeterminate result. The runtime's `resolveDefaultVersion()` at `apps/runtime/src/services/workflow-version-service.ts:703` sorts by `publishedAt desc`, which means a late-published `v0.1.5` shadows an earlier `v0.2.0`.
3. **Public URL exposes internal structure.** The proxy URL `/api/projects/:projectId/workflows/:workflowId/executions/execute` leaks project IDs to external consumers and is substantially longer than sibling SaaS webhook conventions.
4. **Agent tool binding has no version field.** `WorkflowBindingIR` (`packages/compiler/src/platform/ir/schema.ts:891-902`) has no `workflowVersion` property; `WorkflowToolExecutor.execute()` (`apps/runtime/src/services/workflow/workflow-tool-executor.ts:128`) never sends one. Agent-invoked workflows therefore always fall through to the engine's non-deterministic default resolution.

The [Workflow Triggers](./workflow-triggers.md) spec explicitly defers this work under NG6: _"Workflow versioning integration with triggers (partially exists; full blue-green trigger routing is future work)"_.

### Goal Statement

Make workflow version the primary coordinate for every webhook call — visible in Studio, selectable per-request, deterministic in default resolution, and pin-able for agent tool bindings. External callers get a clean `/api/v1/workflows/:id/execute` URL that accepts `?version=<semver>` and `?mode=`. Studio shows a `[version] [state]` tag pair beside the workflow header that mirrors what the webhook will execute, and any URL the user copies from Studio already carries the version the user is staring at.

### Summary

This sub-feature adds five tightly coupled changes:

1. **Runtime**: a new `/api/v1/workflows/:workflowId/execute` route that mirrors the existing `/api/v1/process/:workflowId` handler, accepts `?mode=sync|async|async_push` and `?version=<semver>`, and reuses the same `x-api-key` authentication and `WorkflowApiKey` model.
2. **Runtime + Engine**: replace `publishedAt desc` and the no-sort default resolution with **semver desc** (`v0.10.0 > v0.9.0` regardless of publish time). Both `apps/runtime/src/services/workflow-version-service.ts:695` (`resolveDefaultVersion`) and `apps/workflow-engine/src/routes/workflow-executions.ts:311` (engine default branch) share the new rule.
3. **Studio**: `WorkflowDetailPage` header renders up to two badges — `[v0.2.0] [active]` or `[v0.1.5] [inactive]` with a `served via v0.2.0` caption for published versions; **only `[draft]` (single badge) when viewing the draft** because state (active/inactive) applies only to published versions — the draft is the editable working copy, not a lifecycle state. Badges propagate into `WebhookQuickStart` + `CodeSnippets`, which append `?version=<viewed>` to both the execute URL and curl snippets.
4. **Runtime proxy**: `apps/runtime/src/middleware/workflow-engine-proxy.ts:242-281` reads `?version=` in addition to the existing body-level `workflowVersion` field, keeping copy-paste friendliness.
5. **Tool binding**: `WorkflowBindingIR` gains optional `workflowVersion?: string`; `WorkflowConfigForm.tsx` (already shipped) surfaces the version dropdown, which now persists into the binding; `WorkflowToolExecutor.execute()` forwards it to the engine body. Empty/undefined = auto-resolve by semver.

---

## 2. Scope

### Goals

- G1: Ship `/api/v1/workflows/:workflowId/execute` as the single public webhook URL, replacing `/api/v1/process/:workflowId` in the Studio Quick Start panel.
- G2: Support `?version=<semver>` + `?mode=sync|async|async_push` on the short URL and on the runtime proxy URL's body (for legacy Studio paths).
- G3: Make default version resolution deterministic — **latest active non-draft by semver** — in both runtime and engine resolution paths.
- G4: Render `[version] [state]` badges beside the `Workflows / <name>` title on the Workflow Detail page; have `WebhookQuickStart` + `CodeSnippets` emit URLs that reflect the viewed version.
- G5: Add optional `workflowVersion` field to `WorkflowBindingIR` and have `WorkflowConfigForm.tsx` + `WorkflowToolExecutor` honor it end-to-end (empty = auto-resolve).
- G6: Return HTTP 404 on version pin-miss for both the semver string field and `workflowVersionId`, consistent with existing `workflow-executions.ts:297-305` behavior.

### Non-Goals (Out of Scope)

- NG1: Renaming or deprecating `/api/v1/process/:workflowId`. It stays wired; Studio simply stops surfacing it in the Quick Start panel.
- NG2: Changing the engine's internal route shape `/api/v1/projects/:pid/workflows/:wid/executions/execute`. The runtime's new short URL proxies to it; agent-tool invocations continue to call it directly.
- NG3: Blue-green traffic splitting or percentage-based version routing. This feature pins a single version per request or leaves resolution to the default rule.
- NG4: Visual diff between versions from the Webhook panel (use the existing Versions tab).
- NG5: Denormalizing a `versionSortKey` numeric field into `WorkflowVersion`. Client-side `semver.rcompare` on the small published-version set is sufficient until version counts grow.
- NG6: Migrating saved `WorkflowBindingIR` records. The new field is additive and optional; existing DSLs without it parse to `undefined` = auto-resolve.
- NG7: Webhook signing changes. Inbound API-key auth and outbound HMAC-SHA256 signing remain as specified in [Workflow Triggers](./workflow-triggers.md) FR-09.

---

## 3. User Stories

1. **US-1**: As a **Studio developer** configuring a webhook trigger, I want to see exactly which workflow version my copy-pasted URL will execute, so that I don't accidentally share a URL that runs the wrong version when I publish `v0.3.0`.

2. **US-2**: As an **external developer** integrating with a workflow, I want a short, clean public URL (`/api/v1/workflows/<id>/execute`) that doesn't leak internal project IDs, so that my webhook configuration in Stripe/GitHub/Zendesk stays compact and trustworthy.

3. **US-3**: As a **Studio developer** testing an older version (`v0.1.5`) before promoting it back to active, I want the Quick Start panel to emit a URL that pins that exact version, so that I can verify the inactive version's behavior without toggling state.

4. **US-4**: As an **agent builder**, when I bind a workflow as a tool, I want to pin a specific workflow version (or leave empty for auto-resolve), so that my agent's behavior doesn't change unpredictably when the workflow is re-published.

5. **US-5**: As a **platform operator**, I want default version resolution to be deterministic across runtime and engine services, so that `GET /api/v1/workflows/:id/execute` always hits the same version even when multiple are `state: 'active'`.

6. **US-6**: As a **Studio user** scanning the workflow list, I want to see at a glance which version is currently active and whether I'm viewing `draft` or a published version, so that I don't edit the wrong surface.

---

## 4. Functional Requirements

| ID    | Requirement                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                   | Priority | Status |
| ----- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | -------- | ------ |
| FR-1  | The system must expose `POST /api/v1/workflows/:workflowId/execute` on the Runtime service, authenticated via `x-api-key` using the existing `WorkflowApiKey` model and `tenantAuthMiddleware`.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                               | P0       | DONE   |
| FR-2  | The new route must accept query params `mode` (`sync`, `async`, `async_push`; default `sync`) and `version` (semver like `v0.2.0`, or `draft`, or absent). Absent `version` triggers default resolution (see FR-8). Note: `async_poll` is a **UI display label** in `CodeSnippets.tsx` tabs, not a server-side mode — it is syntactic sugar for `mode=async` with an accompanying poll URL shown as a second curl. The route itself accepts only 3 `mode` values.                                                                                                                                                                                                                                             | P0       | DONE   |
| FR-3  | The route handler must load the workflow by `_id`, read `workflow.projectId`, and verify `projectId ∈ ctx.projectScope` (404 conceal on mismatch). The short URL must not gate execution on the vestigial workflow-container `status`; executability is determined by resolved `WorkflowVersion` state/rules instead.                                                                                                                                                                                                                                                                                                                                                                                         | P0       | DONE   |
| FR-4  | The route must reuse `process-api.ts` handler logic via extraction into a shared pure function: input-schema validation, executionId generation (UUIDv7), sync-wait vs async fire-and-forget vs async-push branching, callbackUrl/accessToken handling. **Mode interface changes**: the new route accepts `?mode=` (query-param enum); the existing `/api/v1/process/:workflowId` continues to use body-level `isAsync: boolean` + `callbackUrl` for backward compat. The shared handler must accept a normalized `mode: 'sync'\|'async'\|'async_push'` enum argument, not the raw body shape — each route adapter normalizes its input before calling the handler.                                           | P0       | DONE   |
| FR-5  | Sync mode must wait up to `PROCESS_API_SYNC_TIMEOUT_MS` (default 30s) for completion, then auto-promote to 202 with `{ traceId, status: 'running' }` on timeout. Mirrors existing `process-api.ts:41` behavior.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                               | P0       | DONE   |
| FR-6  | The route must return 404 with `{ code: 'WORKFLOW_VERSION_NOT_FOUND' }` when `?version=` specifies a semver that doesn't match any non-deleted `WorkflowVersion` for the workflow — regardless of `state`. Matches engine behavior at `workflow-executions.ts:297-305`. **Explicit pinning bypasses the `state: 'active'` filter** — an inactive version can be executed if the caller pins it by exact semver (enables dev testing of non-active versions). The legacy `/api/v1/process/:workflowId` retains its existing `VERSION_NOT_FOUND` error code for backward compat; new callers on the short URL receive the engine-consistent `WORKFLOW_VERSION_NOT_FOUND`. Document both codes in API reference. | P0       | DONE   |
| FR-7  | The runtime proxy middleware (`apps/runtime/src/middleware/workflow-engine-proxy.ts:242-281`) must also read `?version=` from the query string, using the same value as body-level `workflowVersion` (body wins on conflict, logged as a warning).                                                                                                                                                                                                                                                                                                                                                                                                                                                            | P1       | DONE   |
| FR-8  | The system must resolve the "default" workflow version deterministically as **the highest-semver non-draft version with `state: 'active'` and `deleted: false`**, computed client-side after a filtered `find()`. Applied in both `resolveDefaultVersion()` (`workflow-version-service.ts:695`) and the engine's `/execute` default branch (`workflow-executions.ts:311`).                                                                                                                                                                                                                                                                                                                                    | P0       | DONE   |
| FR-9  | If no active non-draft version exists, the default resolver must fall back to the draft version, emitting the existing `workflow.version.resolution.miss` metric.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                             | P0       | DONE   |
| FR-10 | `WorkflowBindingIR` (`packages/compiler/src/platform/ir/schema.ts:891`) must gain an optional field `workflowVersion?: string`. The DSL schema and tool-registration validator must accept it as an additive optional field.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                  | P0       | DONE   |
| FR-11 | `WorkflowToolExecutor.execute()` (`apps/runtime/src/services/workflow/workflow-tool-executor.ts:128`) must inject `workflowVersion` into the engine POST body when `binding.workflowVersion` is set. When unset, the engine resolves via FR-8.                                                                                                                                                                                                                                                                                                                                                                                                                                                                | P0       | DONE   |
| FR-12 | `WorkflowConfigForm.tsx` (Studio Register-Workflow popup) must persist the selected version into the binding's `workflowVersion` field. In create flows, the form auto-selects the current active version for preview and persists that same concrete version so the saved binding matches the visible trigger/input preview. Users can explicitly choose "Latest active (auto-resolve)" to clear `workflowVersion` and preserve dynamic resolution.                                                                                                                                                                                                                                                          | P0       | DONE   |
| FR-13 | `WorkflowDetailPage.tsx:329-338` must render **two badges** beside the `Workflows / <name>` title: a version badge (neutral) and a state badge (`active`: success/green, `inactive`: muted/gray). Remove the current `warning` variant for `draft`.                                                                                                                                                                                                                                                                                                                                                                                                                                                           | P0       | DONE   |
| FR-14 | When the viewed version is `state: 'inactive'`, the header must display a caption line beneath the badges: `served via <highest-active-semver>` — informational only, does not affect the URL. When viewed version is active or is `draft`, no caption.                                                                                                                                                                                                                                                                                                                                                                                                                                                       | P1       | DONE   |
| FR-15 | `WebhookQuickStart.tsx:68-70` must emit the new short URL `/api/v1/workflows/:workflowId/execute?version=<viewed>` (query param reflects the currently-viewed version from the detail page). Remove the long proxy URL from this panel.                                                                                                                                                                                                                                                                                                                                                                                                                                                                       | P0       | DONE   |
| FR-16 | `CodeSnippets.tsx:48` (curl snippets) must emit the short URL in all four UI tabs (`sync`, `async`, `async_poll`, `async_push`) with `?version=<viewed>` appended. The `async_poll` tab continues to use `?mode=async` on the execute call and renders an additional poll curl for the status endpoint. The status-poll URL stays version-less (execution is already version-pinned).                                                                                                                                                                                                                                                                                                                         | P0       | DONE   |
| FR-17 | The version badge must be clickable and navigate to the Versions tab. The state badge must show a tooltip ("This version is active — it serves default webhook calls" / "This version is inactive — webhooks resolve to the latest active").                                                                                                                                                                                                                                                                                                                                                                                                                                                                  | P2       | DONE   |
| FR-18 | When the user is viewing `draft`, the URL emits `?version=draft`. When viewing an inactive version, the URL pins the viewed version (`?version=v0.1.5`) — and because explicit pinning bypasses the state filter (FR-6), the inactive version **executes successfully** so the developer can test it end-to-end without reactivating. Default resolution (without `?version=`) continues to require `state: 'active'` per FR-8. The inactive-caption line `served via <highest-active>` (FR-14) gives production context: "this URL works for you, but version-less callers hit the latest active."                                                                                                           | P1       | DONE   |
| FR-19 | Observability: the new route handler must log `version` (query param, `null` if absent) alongside `workflowId`, `executionId`, `apiKeyId` in the existing `Async execution started` / `sync completed` logs.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                  | P1       | DONE   |
| FR-20 | Documentation: update [Workflow Triggers](./workflow-triggers.md) NG6 to reference this sub-feature as the closing of the versioning gap.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                     | P1       | DONE   |
| FR-21 | The system must expose `GET /api/v1/workflows/:workflowId/executions/:executionId` as a status-poll endpoint paired with the short URL. Authenticated via `x-api-key`; returns execution status + output when complete. Implementation reuses the existing engine poll route via runtime proxy; request is version-less because the execution is already version-pinned at dispatch. Rendered in the `async_poll` UI tab (FR-16) as the second curl in the 2-curl recipe.                                                                                                                                                                                                                                     | P0       | DONE   |

---

## 5. Feature Classification & Integration Matrix

### Lifecycle / Platform Impact

| Area                       | Impact Level | Notes                                                                            |
| -------------------------- | ------------ | -------------------------------------------------------------------------------- |
| Project lifecycle          | SECONDARY    | Webhook URL now reflects project-scoped version lifecycle                        |
| Agent lifecycle            | SECONDARY    | Tool bindings gain version pinning (agent behavior is now version-deterministic) |
| Customer experience        | PRIMARY      | External developers consume the new short URL; Studio users see version tags     |
| Integrations / channels    | PRIMARY      | Public webhook URL shape changes; third-party webhook configurations simplify    |
| Observability / tracing    | SECONDARY    | Version field added to execution logs; resolution-miss metric unchanged          |
| Governance / controls      | SECONDARY    | Deterministic resolution closes a non-determinism gap                            |
| Enterprise / compliance    | NONE         | No new compliance surface                                                        |
| Admin / operator workflows | NONE         | No admin-portal changes                                                          |

### Related Feature Integration Matrix

| Related Feature                                             | Relationship Type | Why It Matters                                                                                                                   | Key Touchpoints                                                                                                      | Current State |
| ----------------------------------------------------------- | ----------------- | -------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------- | ------------- |
| [Workflow Triggers](./workflow-triggers.md)                 | extends           | Closes NG6 ("Workflow versioning integration with triggers")                                                                     | Adds new public route alongside `/api/v1/process/:workflowId`; Studio Quick Start panel                              | SHIPPED       |
| [Workflow Versioning](./workflow-versioning.md)             | extends           | Implements version-aware webhook consumption promised in the versioning feature                                                  | `resolveDefaultVersion()` semver sort; WorkflowVersion state badges; activate/deactivate side-effects on URL routing | SHIPPED       |
| [Workflow as Tool](../workflow-as-tool.md)                  | extends           | Adds `workflowVersion` field to `WorkflowBindingIR`; persists version selection through the already-shipped `WorkflowConfigForm` | `schema.ts:891`; `WorkflowConfigForm.tsx`; `WorkflowToolExecutor.execute()`                                          | SHIPPED       |
| [Workflow Async Completion](./workflow-async-completion.md) | shares data with  | Async-push callback URL + HMAC signing path unchanged; the new short URL reuses the same `triggerMetadata.callbackUrl` contract  | `apps/workflow-engine/src/services/callback-delivery-worker.ts`                                                      | SHIPPED       |
| [Deployments & Versioning](../deployments-versioning.md)    | shares data with  | `WorkflowVersion` lifecycle is owned by the deployments feature; this sub-feature consumes version metadata only                 | `state`, `deploymentId`, `publishedAt` fields on `WorkflowVersion`                                                   | BETA          |

---

## 6. Design Considerations

### UI — Workflow Detail Page Header

Replace the single `activeVersionLabel` badge at `apps/studio/src/components/workflows/WorkflowDetailPage.tsx:329-338` with two badges + optional caption:

```
Workflows / OrderFlow   [v0.2.0]  [active]
Workflows / OrderFlow   [v0.1.5]  [inactive]
                        served via v0.2.0
Workflows / OrderFlow   [draft]   [active]
```

- **Version badge**: `variant="neutral"`, label = the currently-viewed version (`v0.2.0`, `draft`, etc.). Clickable — navigates to the Versions tab.
- **State badge**: `variant="success"` for active, `variant="muted"` for inactive. Non-clickable; tooltip on hover.
- **Caption** (rendered only when viewed version is `state: 'inactive'`): subtle muted text `served via <highest-active-semver>`. When the viewed version is active or `draft`, the caption does not render.

Drop the `variant="warning"` treatment for `draft` — `draft` is a valid state, not a warning.

### UI — Webhook Quick Start Panel

Existing `WebhookQuickStart.tsx` emits a single version-less URL. Updated shape:

```
┌──────────────────────────────────────────────────────────────┐
│ Webhook Quick Start   [v0.2.0]  [active]                     │
│                                                               │
│ Webhook URL                                                   │
│ https://runtime.abl.dev/api/v1/workflows/wf_xyz/execute       │
│  ?version=v0.2.0                                       [📋]  │
│                                                               │
│ API Key  [● Active]  [Manage keys ↗]                         │
│ ak_live_8f2a...                                        [📋]  │
│                                                               │
│ [Sync] [Async] [Async+Poll] [Async+Push]                     │
└──────────────────────────────────────────────────────────────┘
```

The four-tab curl snippet panel in `CodeSnippets.tsx` emits the same short URL with `?version=<viewed>` appended. The status-poll URL within the Async+Poll tab stays version-less — `executionId` already pins the version chosen at dispatch.

### UI — Register Workflow Tool Binding Popup

`WorkflowConfigForm.tsx` already ships the version dropdown. Create flows auto-select the current active version and persist that concrete semver so the trigger list and parameter preview match what gets saved. The explicit "**Latest active (auto-resolve)**" option remains available for users who want the binding to stay unpinned and re-resolve at execution time.

---

## 7. Technical Considerations

### Semver Sort Implementation

Both `resolveDefaultVersion()` and the engine's default branch need the same logic:

```ts
const candidates = await WorkflowVersion.find({
  workflowId, tenantId, projectId,
  state: 'active',
  deleted: { $ne: true },
  version: { $ne: 'draft' },
}).lean();

// semver rcompare; '+' form is valid per-Studio version scheme
candidates.sort((a, b) => semverRcompare(a.version, b.version));
const chosen = candidates[0] ?? /* draft fallback */;
```

`semver` is currently only a transitive **devDependency** (via commitlint, istanbul, etc.) — **not available in production builds**. It must be added as a production dependency to `apps/runtime/package.json` and `apps/workflow-engine/package.json` (or a shared package they both consume — e.g., `packages/shared-kernel`). Client-side sort is safe — typical published-version count per workflow is <50 per [Workflow Versioning](./workflow-versioning.md) success metrics.

### Route Design

The short URL `/api/v1/workflows/:workflowId/execute` is a **runtime route**, not an engine route. Its handler:

1. Resolves workflow → projectId via `findWorkflowByIdAndTenant()` (reuses `process-api.ts:129`).
2. Enforces `projectScope` membership.
3. Resolves version:
   - If `?version=` present: load version by exact `(workflowId, version)` match with `deleted: false` — **without** filtering `state: 'active'` (explicit pins bypass state check per FR-6). Note: `process-api.ts:171` currently calls `findActiveWorkflowVersion()` which filters active; this feature must replace that call path with a state-agnostic lookup for explicit pins, while the default-resolution branch continues to require `state: 'active'` (FR-8).
   - If `?version=` absent: call `resolveDefaultVersion()` which applies the FR-8 semver-desc rule.
4. Chooses the effective input schema from the resolved workflow version definition (fallback: workflow container schema when the version definition omits `inputSchema`).
5. Builds `enginePayload` (same as `process-api.ts:300-307`).
6. Forwards the original caller auth header(s) (`Authorization` / `x-api-key`) plus trace headers to `/api/v1/projects/:pid/workflows/:wid/executions/execute`.

No new engine route. Engine contract unchanged — the engine already accepts explicit pins without state filtering (`workflow-executions.ts:290-305`), so the runtime's state-agnostic lookup matches engine semantics.

### URL Precedence Rules

On the runtime proxy, when both `?version=` (query) and `workflowVersion` (body) are present:

- Body wins (explicit client contract, matches `process-api.ts:166-208` existing semantics).
- Warning logged: `proxy.version.conflict` with both values.

### Engine Resolution Parity

The engine's `/execute` default branch currently does `findOne({state:'active'})` with no sort. Two changes:

1. Switch to the same `find().sort(semver)` pattern.
2. Emit the `workflow.version.resolution.miss` metric on draft fallback (new log site — runtime already emits it).

Both services reach the same version for the same workflow regardless of caller — eliminates the "runtime and engine disagree" class of bug.

---

## 8. How to Consume

### Studio UI

- **Workflow Detail page header** (`apps/studio/src/components/workflows/WorkflowDetailPage.tsx`): two badges + optional inactive-caption line beside the breadcrumb title.
- **Workflow Triggers tab → Webhook Quick Start** (`apps/studio/src/components/workflows/triggers/WebhookQuickStart.tsx`): short URL with `?version=`, version + state tags visible at panel top.
- **Register Workflow popup** (`apps/studio/src/components/tools/WorkflowConfigForm.tsx`): version dropdown (already shipped) now persists into the binding DSL.

### Surface Semantics Matrix

| Asset / Entity Type      | Source of Truth / Ownership                    | Design-Time Surface(s)                                               | Editable or Read-Only?                                                    | Consumer Reference / Binding Model                                                             | Runtime Materialization / Resolution                               | Notes / Unsupported State                             |
| ------------------------ | ---------------------------------------------- | -------------------------------------------------------------------- | ------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------- | ------------------------------------------------------------------ | ----------------------------------------------------- |
| Workflow version string  | `WorkflowVersion.version` (semver or `draft`)  | Versions tab, Detail header badge, Quick Start, `WorkflowConfigForm` | Read-only at consumption point (editable only via publish/activate flows) | `?version=<semver>` query param on webhook URL; `workflowVersion` field in `WorkflowBindingIR` | Engine resolves by `version` string filter or by default FR-8 rule | Unsupported: path-segment form `/versions/:v/execute` |
| Webhook public URL       | Runtime service                                | Quick Start panel (copy-paste), `CodeSnippets`                       | Read-only (generated)                                                     | `/api/v1/workflows/:id/execute` with query params                                              | Route handler loads workflow, scopes via `projectScope`            | Unsupported: embedded `projectId` in public URL       |
| Tool binding version pin | `WorkflowBindingIR.workflowVersion` inside DSL | `WorkflowConfigForm` dropdown                                        | Editable at design time                                                   | DSL text in `project_tools.dslContent`                                                         | `WorkflowToolExecutor` forwards in engine body                     | Empty = auto-resolve at every execution               |

### Design-Time vs Runtime Behavior

- **Design-time**: Studio surfaces (detail page, Quick Start, tool binding popup) display and author the version coordinate. The Quick Start URL is a copy-paste artifact — it does not execute during authoring.
- **Runtime**: Actual resolution happens at execution — `?version=` takes precedence, then body `workflowVersion` (proxy path), then the default FR-8 rule. The viewed version in Studio and the copy-pasted URL's `?version=` value agree, but they are both just design-time representations of a runtime choice.
- **Agent-tool runtime**: `WorkflowBindingIR.workflowVersion` (if set) is sent in the engine body. If unset, the engine resolves via FR-8. Saved bindings without the field continue to work without migration.

### API (Runtime)

| Method | Path                                                                | Purpose                                                                         |
| ------ | ------------------------------------------------------------------- | ------------------------------------------------------------------------------- |
| POST   | `/api/v1/workflows/:workflowId/execute`                             | New: short public webhook URL; supports `?mode=`, `?version=`, `x-api-key` auth |
| GET    | `/api/v1/workflows/:workflowId/executions/:executionId`             | Status poll for short URL (alias of existing proxy poll; no version param)      |
| POST   | `/api/v1/process/:workflowId`                                       | Unchanged — remains as a legacy path; not surfaced in Studio UI                 |
| POST   | `/api/projects/:projectId/workflows/:workflowId/executions/execute` | Unchanged — Studio design-time Run; internal proxy path                         |

### API (Studio)

| Method | Path                                                      | Purpose                                                                      |
| ------ | --------------------------------------------------------- | ---------------------------------------------------------------------------- |
| GET    | `/api/projects/:projectId/workflows/:workflowId/versions` | Unchanged — feeds `WorkflowDetailPage` badge + `WorkflowConfigForm` dropdown |

### Admin Portal

N/A — no admin-portal surface for this feature.

### Channel / SDK / Voice / A2A / MCP Integration

N/A — webhook URL is not channel-aware. Agent-tool binding is SDK-observable (the binding IR is part of the compiled agent), but the runtime behavior for clients is unchanged — they consume tool results identically.

---

## 9. Data Model

### Collections / Tables

No new collections. Two existing collections referenced:

```text
Collection: workflow_versions  (existing; see workflow-versioning.md)
Fields:
  - _id: string
  - workflowId: string (required, indexed)
  - tenantId: string (required, indexed)
  - projectId: string (required, indexed)
  - version: string (required; semver like 'v0.2.0' or literal 'draft')
  - state: 'active' | 'inactive' | undefined (undefined for draft)
  - deleted: boolean
  - publishedAt: Date
  - definition: { nodes, edges, envVars, inputSchema, outputSchema }
  - (no new fields added by this feature)
Indexes:
  - { tenantId: 1, projectId: 1, workflowId: 1, version: 1 }              (existing, unique)
  - { tenantId: 1, projectId: 1, workflowId: 1, state: 1, deleted: 1, publishedAt: -1 }  (existing — supports FR-8 active-version query)
  - { tenantId: 1, workflowId: 1, sourceHash: 1 }                         (existing)
```

```text
In-memory type: WorkflowBindingIR  (packages/compiler/src/platform/ir/schema.ts:891)
Fields (after this feature):
  - workflowId: string
  - workflowVersion?: string         // NEW — optional, undefined = auto-resolve
  - triggerId?: string
  - mode: 'sync' | 'async'
  - paramMapping: Record<string, string>
  - timeoutMs?: number
```

### Key Relationships

- `?version=<semver>` on the URL ↔ `WorkflowVersion.version` string match (with tenant + project + `deleted: false` filter).
- `WorkflowBindingIR.workflowVersion` (set in DSL) ↔ same `WorkflowVersion.version` string match at runtime.
- Default resolution: `WorkflowVersion.state = 'active'` + highest semver → `WorkflowExecution.workflowVersionId`.

---

## 10. Key Implementation Files

### Domain / Core Logic

| File                                                           | Purpose                                                                                                                                  |
| -------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------- |
| `apps/runtime/src/services/workflow-version-service.ts`        | `resolveDefaultVersion()` semver-desc client-side sort (FR-8); re-exports `compareSemverDesc()` from shared-kernel                       |
| `apps/runtime/src/repos/workflow-repo.ts`                      | `findWorkflowVersion()` extended with `opts?: { excludeDeleted?: boolean }` for state-agnostic pinned lookup (FR-6)                      |
| `apps/workflow-engine/src/routes/workflow-executions.ts`       | Engine semver-string pin resolver branch + default-branch semver-desc sort + resolution.miss metric (FR-8, parity)                       |
| `apps/workflow-engine/src/services/trigger-engine.ts`          | `fireWebhookTrigger()` semver-desc default resolution for legacy triggers (no pinned versionId, no deployment)                           |
| `apps/workflow-engine/src/lib/semver-compare.ts`               | Re-exports `compareSemverDesc()` from `@agent-platform/shared-kernel` (post-dedupe)                                                      |
| `packages/shared-kernel/src/utils/semver-compare.ts`           | NEW — canonical zero-dep `compareSemverDesc()` used by runtime + workflow-engine; handles pre-release per semver §11                     |
| `packages/compiler/src/platform/ir/schema.ts`                  | Add `workflowVersion?: string` to `WorkflowBindingIR` (FR-10)                                                                            |
| `packages/shared/src/tools/dsl-property-parser.ts`             | Add `workflowVersion?: string` to `WorkflowBindingLocal` + read `props.workflow_version` in parser (FR-10)                               |
| `apps/runtime/src/services/workflow/workflow-tool-executor.ts` | Forward `binding.workflowVersion` to engine body when set (FR-11)                                                                        |
| `apps/runtime/src/services/audit-helpers.ts`                   | `auditWorkflowExecuted()` helper — fire-and-forget `workflow.executed` audit record with resolved version + mode                         |
| `apps/studio/src/lib/semver-compare.ts`                        | Re-exports `compareSemverDesc` from `@agent-platform/shared-kernel` as `compareSemverDescLocal` — Studio parity for GAP-007 (2026-04-19) |

### Routes / Handlers

| File                                                   | Purpose                                                                                                                                                                                   |
| ------------------------------------------------------ | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `apps/runtime/src/routes/workflow-execute-handler.ts`  | Shared `handleWorkflowExecute()` pure function — input validation, executionId generation, sync/async branching, audit emit, `resolvedVersion`/`resolvedVersionId` response envelope      |
| `apps/runtime/src/routes/workflows-execute.ts`         | Short URL route `POST /api/v1/workflows/:id/execute` + path-segment `/versions/:v/execute` + status-poll `GET .../executions/:eid` (FR-1–6, FR-21); attaches `tenantRateLimit('request')` |
| `apps/runtime/src/server.ts`                           | Mount `workflowsExecuteRouter` at `/api/v1/workflows` behind `tenantAuthMiddleware` alongside `/api/v1/process`                                                                           |
| `apps/runtime/src/middleware/workflow-engine-proxy.ts` | Read `?version=` query; body wins on conflict with `proxy.version.conflict` warning log (FR-7)                                                                                            |
| `apps/runtime/src/middleware/rate-limiter.ts`          | `tenantRateLimit('request')` — per-tenant + per-API-key sliding window; wired onto execute routes (gap #5)                                                                                |

### UI Components

| File                                                                  | Purpose                                                                                                                                                                                                                     |
| --------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `apps/studio/src/components/workflows/WorkflowDetailPage.tsx`         | Two-badge header with `viewedVersionInfo` memo + inactive "served via" caption + FR-17 tooltip; local semver-desc sort for highest active pick                                                                              |
| `apps/studio/src/components/workflows/tabs/WorkflowTriggersTab.tsx`   | Thread `viewedVersion` + `viewedState` props into `WebhookQuickStart` via `TriggerCard`                                                                                                                                     |
| `apps/studio/src/components/workflows/triggers/WebhookQuickStart.tsx` | Append `?version=<viewed>` to endpoint URL when viewed version is set; pass `version` prop to `CodeSnippets` (FR-15)                                                                                                        |
| `apps/studio/src/components/workflows/triggers/CodeSnippets.tsx`      | `buildCurl()` switched to short URL `/api/v1/workflows/:wid/execute` in 3 modes (Sync, Async+Poll, Async Push) with `?mode=&version=` query merging (FR-16). Async-only mode dropped 2026-04-19 — superseded by Async+Poll. |
| `apps/studio/src/components/tools/WorkflowConfigForm.tsx`             | `handleVersionChange()` persists `workflowVersion` semver string on `WorkflowConfig`; empty selection clears it (FR-12)                                                                                                     |
| `apps/studio/src/components/tools/shared-types.ts`                    | Add `workflowVersion?: string` to `WorkflowConfig` interface                                                                                                                                                                |
| `packages/i18n/locales/en/studio.json`                                | 7 new keys under `workflows.versions.*` for badges, tooltips, aria labels, served-via caption                                                                                                                               |

### Jobs / Workers / Background Processes

N/A — no background-job changes.

### Tests

| File                                                                               | Type              | Coverage Focus                                                                                                           |
| ---------------------------------------------------------------------------------- | ----------------- | ------------------------------------------------------------------------------------------------------------------------ |
| `apps/runtime/src/__tests__/workflows-execute.e2e.test.ts`                         | e2e               | NEW — short URL auth, version pin (active + inactive + miss), sync + async, cross-project conceal, status-poll; 19 tests |
| `apps/runtime/src/__tests__/workflow-engine-proxy-versioning.integration.test.ts`  | integration       | NEW — `?version=` query + body precedence + conflict warning; 4 cases                                                    |
| `apps/runtime/src/__tests__/workflow-tool-executor-versioning.integration.test.ts` | integration       | NEW — executor binding with/without `workflowVersion`; engine body shape verification                                    |
| `apps/runtime/src/__tests__/workflow-tool-executor-versioning.e2e.test.ts`         | e2e               | NEW — full agent-tool-binding round-trip (register + execute + re-register without)                                      |
| `apps/runtime/src/__tests__/workflow-version-service-semver.test.ts`               | integration       | NEW — INT-3: semver-desc over publishedAt; deactivate highest; draft-fallback metric                                     |
| `apps/runtime/src/__tests__/semver-compare.test.ts`                                | unit              | NEW — runtime `compareSemverDesc` pure function (6 cases inc. draft-last, leading-v, mixed)                              |
| `apps/workflow-engine/src/__tests__/semver-compare.test.ts`                        | unit              | NEW — engine copy of comparator (identical cases, documents parity)                                                      |
| `apps/workflow-engine/src/__tests__/system-executions-semver.test.ts`              | system            | NEW — engine semver-string pin resolver + default-branch semver-desc; 7 tests                                            |
| `apps/workflow-engine/src/__tests__/system-execute-version.test.ts`                | system (keystone) | EXTEND — KEYSTONE runtime↔engine parity test: both paths agree on `v0.10.0` from shared seed                             |
| `apps/workflow-engine/src/__tests__/workflow-executions-routes.test.ts`            | unit              | EXTEND — 4 DI mock sites updated for `WorkflowVersionModel.find` addition                                                |
| `packages/shared/src/tools/__tests__/dsl-property-parser-workflow-version.test.ts` | unit              | NEW — DSL round-trip: `workflow_version: "v0.1.0"` → `WorkflowBindingLocal.workflowVersion`; 5 tests                     |
| `apps/studio/e2e/workflows/workflow-webhook-versioning.spec.ts`                    | e2e (Playwright)  | NEW — Studio badges (active/draft/inactive), Quick Start URL reflects viewed version, badge click nav; 4 tests           |

---

## 11. Configuration

### Environment Variables

| Variable                         | Default | Description                                                               |
| -------------------------------- | ------- | ------------------------------------------------------------------------- |
| `PROCESS_API_SYNC_TIMEOUT_MS`    | `30000` | Existing — reused by the new short URL's sync mode (FR-5)                 |
| `WORKFLOW_PROXY_SYNC_TIMEOUT_MS` | `30000` | Existing — unchanged; proxy path (Studio design-time) continues to use it |

No new env vars required.

### Runtime Configuration

No feature flags. The new route is additive; the header badges render based on existing `WorkflowVersion` state; the semver sort is a deterministic behavior change with no opt-out (bug fix class).

### DSL / Agent IR / Schema

`WorkflowBindingIR` (FR-10) — additive optional field:

```ts
export interface WorkflowBindingIR {
  workflowId: string;
  workflowVersion?: string; // NEW — semver like "v0.2.0", or "draft", or absent (= auto-resolve)
  triggerId?: string;
  mode: 'sync' | 'async';
  paramMapping: Record<string, string>;
  timeoutMs?: number;
}
```

DSL → IR compiler (`packages/compiler`) must accept `workflow_version: "v0.2.0"` in the tool block and map it to `workflowVersion`. Missing key remains valid (undefined).

---

## 12. Non-Functional Concerns

### Isolation & Multitenancy

| Concern           | Requirement / Expectation                                                                                                                                   |
| ----------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Project isolation | Short-URL handler loads workflow → `projectId` → verifies `ctx.projectScope.includes(projectId)` → 404 on miss (conceal). Matches `process-api.ts:144-152`. |
| Tenant isolation  | Every `find`/`findOne` on `WorkflowVersion` and `Workflow` includes `tenantId` from the authenticated principal. `x-api-key` provides tenant binding.       |
| User isolation    | Not applicable — webhook API is machine-principal; no per-user resource model. Agent tool bindings are project-scoped, inherit project isolation.           |

Cross-project webhook calls (API key's `projectScope` doesn't contain `workflow.projectId`): **404 with `WORKFLOW_NOT_FOUND`** (conceal). No leakage of existence.

### Security & Compliance

- **Authentication**: `tenantAuthMiddleware` (`server.ts:785`) resolves `WorkflowApiKey` via SHA-256 lookup. No new key type.
- **Authorization**: `hasPermission(ctx.permissions, 'workflow:execute')` — identical to `process-api.ts:105`.
- **Callback security**: Async-push callback URL validation + HMAC-SHA256 signing path unchanged.
- **Audit**: Every execution records `apiKeyId` and the resolved `workflowVersion` in `WorkflowExecution.triggerMetadata`.
- **SSRF**: Inbound webhook calls don't expose SSRF surface. Outbound callback delivery continues to use `callback-delivery-worker.ts`'s existing SSRF guard.

### Performance & Scalability

- Short-URL handler adds **one `findOne` by indexed `_id`** on top of the existing process-api path. Sub-millisecond.
- Semver-sort resolver adds a `find()` (vs existing `findOne()`). Expected candidate set is 1-50 docs; sort is O(n log n) in-memory. No measurable latency change.
- Client-side sort in Node avoids a denormalized index and avoids schema migration. If version counts exceed ~500 per workflow (unrealistic today), revisit with `versionSortKey` numeric field.
- No new cache layers. Engine's existing execution pipeline unchanged.

### Reliability & Failure Modes

- **Pin-miss**: 404 returned immediately, no retry. Engine already handles `workflowVersionId` pin-miss at `workflow-executions.ts:297-305`; extend to semver pin-miss (FR-6).
- **No active versions**: `resolveDefaultVersion()` falls back to draft with `workflow.version.resolution.miss` metric. Unchanged behavior.
- **Runtime ↔ engine version disagreement**: Eliminated by FR-8 (both apply same semver sort). This is the **primary reliability win** of the feature.
- **Deactivation race**: If a version is deactivated mid-call, the execution that already dispatched with that version continues (execution is pinned at start). New calls resolve to the next highest active. Matches current behavior.

### Observability

- **Logs**: New `version` field on `Async execution started` and sync-completed log lines (FR-19). Existing workflowId/executionId/apiKeyId fields unchanged.
- **Metrics**:
  - `workflow.version.resolution.miss` (existing) — emitted on draft fallback from both runtime and engine.
  - `proxy.version.conflict` (new) — emitted when proxy body + query both specify `workflowVersion`.
- **Traces**: `WorkflowExecution.workflowVersion` and `workflowVersionId` already captured (see [Workflow Versioning](./workflow-versioning.md)). No new trace schema.

### Data Lifecycle

- **No new persisted data**. All changes are behavior changes on existing collections (`WorkflowVersion`) and new optional IR fields (`WorkflowBindingIR`).
- **Soft-delete cascade**: Pinned bindings to a soft-deleted version return 404 at execution — caller decides whether to re-bind.
- **Backfill**: None needed. Existing saved bindings without `workflowVersion` behave identically to before.

---

## 13. Delivery Plan / Work Breakdown

1. **Runtime short URL + semver resolver**
   1.1 Extract shared `process-api.ts` handler logic into a pure function `handleWorkflowExecute(deps, { mode, input, version, callbackUrl, accessToken, apiKeyCtx })` — accepts normalized `mode` enum + `version` string, NOT raw body shape
   1.2 Add new Express route `/api/v1/workflows/:workflowId/execute` mounted alongside `/api/v1/process` in `server.ts`; query-param adapter converts `?mode=` + body `input` into handler args
   1.3 Add `semver` as production dep to `apps/runtime/package.json` + `apps/workflow-engine/package.json` (or a shared package); update `resolveDefaultVersion()` to semver-desc sort
   1.4 Update engine default branch `workflow-executions.ts:311` to use same semver-desc sort for parity; emit `workflow.version.resolution.miss` on draft fallback
   1.5 Update proxy middleware to read `?version=` query (FR-7); body wins on conflict with `proxy.version.conflict` warning log
   1.6 Introduce state-agnostic explicit-pin lookup in the new short-URL handler — replaces `findActiveWorkflowVersion()` call for explicit pins (inactive versions still execute when pinned per FR-6). Legacy `/api/v1/process/:workflowId` continues using `findActiveWorkflowVersion()` for backward compat; error code `VERSION_NOT_FOUND` retained there.

2. **Agent tool binding version support**
   2.1 Add `workflowVersion?: string` to `WorkflowBindingIR` (`schema.ts:891`)
   2.2 Update DSL compiler to pass-through `workflow_version` key → `workflowVersion`. **Compiler lockstep gotcha** (per `packages/compiler/agents.md`): new DSL properties require coordinated updates across the schema, parser, and validator — all three must land in the same commit, else the property is silently dropped.
   2.3 Update `WorkflowToolExecutor.execute()` to inject `workflowVersion` into engine body
   2.4 Update `WorkflowConfigForm.tsx` to persist selected version into binding DSL

3. **Studio detail header badges**
   3.1 Split `activeVersionLabel` memo into `{ version, state }` pair (`WorkflowDetailPage.tsx:96`)
   3.2 Render two badges + optional caption line (FR-13, FR-14)
   3.3 Wire version badge `onClick` → Versions tab; state badge tooltip (FR-17)
   3.4 Remove `warning` variant usage for `draft`

4. **Studio Webhook Quick Start + CodeSnippets**
   4.1 Add `version` + `state` props to `WebhookQuickStart`
   4.2 `WebhookQuickStart` emits short URL with `?version=<viewed>` (FR-15)
   4.3 `CodeSnippets` emits short URL in 3 modes (Sync, Async+Poll, Async Push) (FR-16) — originally shipped with 4 tabs; Async-only dropped 2026-04-19 (superseded by Async+Poll)
   4.4 Thread version from `WorkflowTriggersTab` → `WebhookQuickStart` → `CodeSnippets`

5. **Testing + Documentation**
   5.1 New E2E: `process-api-versioning.e2e.test.ts` (short URL auth, version pin, semver resolution, pin-miss 404)
   5.2 New unit/integ: `workflow-tool-executor-versioning.test.ts`
   5.3 Extend: `system-execute-version.test.ts` for engine semver parity
   5.4 New Studio E2E: `workflow-webhook-versioning.spec.ts` (header badges + Quick Start URL)
   5.5 Update `workflow-triggers.md` NG6 to cross-reference this sub-feature

6. **Observability + Cleanup**
   6.1 Add `version` field to execution-start log lines (FR-19)
   6.2 Add `proxy.version.conflict` warning on body+query conflict
   6.3 Post-impl-sync: update testing README, feature indexes, related feature specs

---

## 14. Success Metrics

| Metric                                                  | Baseline                       | Target                                                          | How Measured                                                                               |
| ------------------------------------------------------- | ------------------------------ | --------------------------------------------------------------- | ------------------------------------------------------------------------------------------ |
| Version-pinned webhook call ratio                       | 0% (no query param today)      | ≥30% of webhook calls from Studio-generated URLs within 30 days | Runtime log aggregation on `version` field presence                                        |
| Runtime ↔ engine resolution disagreement                | Indeterminate (engine no-sort) | 0 — provable by semver-sort parity test                         | E2E test `system-execute-version.test.ts` asserts same version chosen from both code paths |
| Short URL adoption vs legacy `/api/v1/process`          | 0% (not implemented)           | ≥80% of new Studio-generated URLs use short form within 60 days | Studio panel usage telemetry (log on copy event)                                           |
| Version-pinned agent tool binding ratio                 | 0% (field doesn't exist)       | ≥40% of new agent tool bindings pin a version                   | Analyze `WorkflowBindingIR` from committed DSLs                                            |
| Support tickets related to "wrong workflow version ran" | Current baseline               | −70%                                                            | Support tracker tag: `workflow-version-confusion`                                          |

---

## 15. Open Questions

1. **semver pre-release handling**: Should the resolver support pre-release semvers (e.g., `v0.2.0-beta`)? Currently the codebase uses `v{major}.{minor}.{patch}` only (`workflow-version-service.ts:508`). If pre-release is adopted later, the comparator needs review.
2. **Path-segment alternative**: Should we also support `/api/v1/workflows/:id/versions/:version/execute` as a RESTful alternative to `?version=`? Query-param is proposed; path segment could be added later without breakage.
3. **Version selector UX for external URL sharing**: Should Studio offer a "Copy versionless URL" button alongside the version-pinned one, for users who explicitly want the "always latest active" semantics? Currently the URL always pins; no versionless copy surface is planned.
4. **Default tool-binding version policy**: Should the product team express a preference for "snap-to current active at bind time" vs the proposed "always auto-resolve"? Auto-resolve is the safer default — bound agents keep up with workflow evolution.

---

## 16. Gaps, Known Issues & Limitations

| ID      | Description                                                                                                                                                                                                                                                                             | Severity | Status    |
| ------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | -------- | --------- |
| GAP-001 | Engine default-branch resolution (`workflow-executions.ts:311`) has no sort today — can return any active version. This feature fixes it; until FR-8 ships, version resolution is non-deterministic when multiple active versions exist.                                                | High     | Mitigated |
| GAP-002 | No UI control today to "pin to current active at bind time" in the Register Workflow popup — only auto-resolve vs pin-specific-semver. If users later want snapshot-at-bind-time semantics, requires follow-up.                                                                         | Low      | Open      |
| GAP-003 | `/api/v1/process/:workflowId` remains as an undocumented alias once the new short URL ships. No sunset plan. Long-term, product may want to officially deprecate or keep indefinitely as a stable API surface.                                                                          | Low      | Open      |
| GAP-004 | Legacy saved `WorkflowBindingIR` records (without `workflowVersion`) behave identically to before — no behavior regression, but users don't retroactively get version pinning unless they re-bind. Self-healing via normal re-binds.                                                    | Low      | Accepted  |
| GAP-005 | `semver` npm dependency propagation: originally kept as per-app prod dep with duplicated comparator (LD-5). Superseded by 2026-04-19 dedupe into `packages/shared-kernel` (zero-dep impl, single source of truth).                                                                      | Low      | Mitigated |
| GAP-006 | `semver.rcompare` throws on corrupt non-semver strings (e.g. `"vNotSemver"`, 4-part versions). System-generated versions are always `v{M}.{m}.{p}` so not exploitable today.                                                                                                            | Medium   | Mitigated |
| GAP-007 | Studio's local `compareSemverDescLocal` (in `WorkflowDetailPage.tsx`) stripped pre-release suffixes via `parseInt`. Superseded 2026-04-19: `apps/studio/src/lib/semver-compare.ts` now re-exports the shared-kernel comparator, so Studio, runtime, and engine all use the same parser. | Medium   | Mitigated |
| GAP-008 | `mutate` missing from `handleStepsChange` useCallback deps array in `WorkflowDetailPage.tsx:242`. Functionally safe (SWR's mutate is a stable reference) but violates `react-hooks/exhaustive-deps`. Fix for BETA.                                                                      | Low      | Open      |
| GAP-009 | `TriggerEngine.fireWebhookTrigger()` fallback executed the workflow working copy (draft) whenever a legacy trigger had no pinned `workflowVersionId` and no deployment manifest match — violated FR-8 for pre-versioning trigger registrations.                                         | High     | Mitigated |
| GAP-010 | `POST /api/v1/workflows/:id/execute` (and path-segment variant) was internet-facing with API-key auth only and no throttle. Vulnerable to quota exhaustion / abuse.                                                                                                                     | High     | Mitigated |
| GAP-011 | No audit log entry emitted on workflow execute — execution traceability lived only in structured logs. Compliance-facing surfaces had no durable record of who executed which version when.                                                                                             | Medium   | Mitigated |
| GAP-012 | Response envelope omitted `resolvedVersion`/`resolvedVersionId`. Callers that omitted `?version=` had no way to learn which version actually ran without a second API call.                                                                                                             | Medium   | Mitigated |
| GAP-013 | `compareSemverDesc` duplicated verbatim between `apps/runtime/src/services/workflow-version-service.ts` and `apps/workflow-engine/src/lib/semver-compare.ts`. Divergence risk on future edits.                                                                                          | Low      | Mitigated |

### Mitigation Notes (2026-04-18)

- **GAP-001** mitigated by Phase 5: runtime `resolveDefaultVersion()` and engine default branch both sort active versions by `compareSemverDesc()`. KEYSTONE test at `system-execute-version.test.ts` asserts parity.
- **GAP-005** mitigated by LD-5 decision: `semver ^7.7.4` added as independent production dep in both `apps/runtime/package.json` and `apps/workflow-engine/package.json`. No shared package; 8-line comparator duplicated with paired unit tests documenting parity.
- **GAP-006 / GAP-007 / GAP-008** are non-blocking MEDIUM/LOW findings deferred to BETA promotion. See `docs/sdlc-logs/workflow-webhook-versioning/implementation.log.md` for review-round provenance.

### Mitigation Notes (2026-04-19 — post-ALPHA hardening)

Follow-on commits closed five additional gaps raised by a post-ALPHA audit of this sub-feature:

- **GAP-009** (trigger-engine semver fallback): `apps/workflow-engine/src/services/trigger-engine.ts` now runs a semver-desc `find({state:'active', deleted:false, version:{$ne:'draft'}})` step between the deployment-manifest branch and the working-copy fallback. Three regression tests in `trigger-fire-resolution.test.ts` (legacy trigger picks highest semver, inactive versions excluded, soft-deleted excluded) lock the behaviour.
- **GAP-010** (rate limit): `tenantRateLimit('request')` middleware attached to `POST /:workflowId/execute` and `POST /:workflowId/versions/:version/execute` in `apps/runtime/src/routes/workflows-execute.ts`. Status-poll `GET` route intentionally unlimited. `X-RateLimit-*` headers asserted in e2e.
- **GAP-011** (audit log): new `auditWorkflowExecuted()` helper in `audit-helpers.ts`, fire-and-forget from `handleWorkflowExecute()`. Records `workflow.executed` action with `{ tenantId, projectId, executionId, mode, workflowVersion, workflowVersionId, apiKeyId }`.
- **GAP-012** (response envelope): `handleWorkflowExecute()` now spreads `resolvedVersion` + `resolvedVersionId` into every response site (202 async-start, 202 timeout auto-promote, 200 sync-completed, 200 sync-failed/cancelled) when the adapter pinned a version.
- **GAP-013** (semver dedupe): `compareSemverDesc` moved to `packages/shared-kernel/src/utils/semver-compare.ts` as a zero-dep canonical implementation; both app copies are now thin re-exports. `semver` npm dep remains in both apps only as a transitive devDependency source — the runtime path uses the shared-kernel parser.
- **GAP-006** (corrupt semver strings): shared-kernel's new parser is a regex-gated `parseSemver()` that returns `null` on invalid input, which `compareSemverDesc` treats as "invalid — sort before draft". No `TypeError` can reach callers.
- **GAP-007** (Studio local comparator pre-release handling): `apps/studio/src/lib/semver-compare.ts` now re-exports the canonical `compareSemverDesc` from `@agent-platform/shared-kernel` under the existing `compareSemverDescLocal` alias. Studio, runtime, and workflow-engine all go through the same zero-dep parser — pre-release suffixes, leading `v`, and invalid-string ordering are identical across surfaces. No remaining parser forks. Verified by the runtime + engine `semver-compare.test.ts` suites both pass after pointing at the shared-kernel re-export.

### Snippet Consolidation (2026-04-19)

Webhook invocation CodeSnippets trimmed from 4 tabs (Sync / Async / Async+Poll / Async Push) to 3 (Sync / Async+Poll / Async Push). The "Async-only" mode was a fire-and-forget variant of `?mode=async`; Async+Poll supersedes it (same POST, with a status-poll GET to complete the round-trip) and was the tab users copied. The now-orphan `workflows.triggers.async_mode` i18n key and its `buildCurl('async')` branch were removed. Playwright regression `apps/studio/e2e/workflows/workflow-trigger-api-key.spec.ts` already updated to assert the 3-tab layout.

---

## 17. Testing & Validation

### Required Test Coverage

| #   | Scenario                                                                                                                                             | Coverage Type     | Status | Test File / Note                                                                                                                  |
| --- | ---------------------------------------------------------------------------------------------------------------------------------------------------- | ----------------- | ------ | --------------------------------------------------------------------------------------------------------------------------------- |
| 1   | `POST /api/v1/workflows/:id/execute` authenticates via `x-api-key` and returns 401 without it                                                        | e2e               | PASS   | `workflows-execute.e2e.test.ts`                                                                                                   |
| 2   | `?version=v0.2.0` pins the execution to that version; `workflow_executions.workflowVersion` = `v0.2.0`                                               | e2e               | PASS   | `workflows-execute.e2e.test.ts` (inactive-pin case)                                                                               |
| 3   | `?version=<nonexistent>` returns 404 with `WORKFLOW_VERSION_NOT_FOUND`                                                                               | e2e               | PASS   | `workflows-execute.e2e.test.ts` (also covers soft-deleted version)                                                                |
| 4a  | Semver comparator pure-function: `v0.10.0 > v0.9.0`; `v1.0.0 > v0.99.99`; `draft` sorted last                                                        | unit              | PASS   | `apps/runtime/src/__tests__/semver-compare.test.ts` + `apps/workflow-engine/src/__tests__/semver-compare.test.ts` (parity copies) |
| 4b  | No `?version=` + multiple active versions published → resolver picks highest semver (`v0.10.0` over `v0.9.0` even when `v0.9.0` was published later) | integration       | PASS   | `workflow-version-service-semver.test.ts` (INT-3)                                                                                 |
| 5   | Engine default-branch parity: same workflow state, agent-tool call resolves to same version as runtime short-URL call                                | system (keystone) | PASS   | `system-execute-version.test.ts` (extended) + `system-executions-semver.test.ts`                                                  |
| 6   | `WorkflowBindingIR.workflowVersion` = `v0.1.0` → executor body includes `workflowVersion: 'v0.1.0'`; undefined → body omits the field                | integration + e2e | PASS   | `workflow-tool-executor-versioning.integration.test.ts` (INT-5) + `workflow-tool-executor-versioning.e2e.test.ts` (E2E-6)         |
| 7   | Studio `WorkflowDetailPage` renders two badges: version + state; inactive caption appears only for inactive                                          | e2e (Playwright)  | PASS   | `apps/studio/e2e/workflows/workflow-webhook-versioning.spec.ts`                                                                   |
| 8   | Studio Quick Start panel emits short URL with `?version=<viewed>` reflecting the viewed version                                                      | e2e (Playwright)  | PASS   | `apps/studio/e2e/workflows/workflow-webhook-versioning.spec.ts`                                                                   |
| 9   | Proxy route body + `?version=` conflict: body wins, warning logged                                                                                   | integration       | PASS   | `workflow-engine-proxy-versioning.integration.test.ts`                                                                            |
| 10  | Cross-project API key cannot execute workflow in another project (404 conceal)                                                                       | e2e               | PASS   | `workflows-execute.e2e.test.ts` (cross-project conceal + INT-6)                                                                   |
| 11  | DSL `workflow_version: "v0.1.0"` round-trips through parser → `WorkflowBindingLocal.workflowVersion`                                                 | unit              | PASS   | `packages/shared/src/tools/__tests__/dsl-property-parser-workflow-version.test.ts`                                                |
| 12  | Engine semver-string pin branch: body `workflowVersion: 'v0.1.0'` → resolves to that version; `v9.9.9` → 404 with static message                     | system            | PASS   | `system-executions-semver.test.ts`                                                                                                |
| 13  | Status-poll `GET /api/v1/workflows/:wid/executions/:eid` returns status + output; 401 no key; 404 cross-project (FR-21, E2E-8)                       | e2e               | PASS   | `workflows-execute.e2e.test.ts` (4 status-poll cases)                                                                             |
| 14  | Legacy trigger (no pinned versionId, no deployment) executes highest-semver active version; excludes inactive + soft-deleted candidates (GAP-009)    | integration       | PASS   | `apps/workflow-engine/src/__tests__/trigger-fire-resolution.test.ts` (3 new cases)                                                |
| 15  | Execute response envelope exposes `resolvedVersion` + `resolvedVersionId` for explicit pin AND default-resolved paths (GAP-012)                      | e2e               | PASS   | `workflows-execute.e2e.test.ts` (2 new cases — async pinned + sync default-resolved)                                              |
| 16  | Execute route emits `X-RateLimit-Limit/Remaining/Reset` headers — proves `tenantRateLimit('request')` is wired (GAP-010)                             | e2e               | PASS   | `workflows-execute.e2e.test.ts` (1 new case)                                                                                      |
| 17  | Execute writes `workflow.executed` audit log record carrying resolved version + mode + apiKeyId (GAP-011)                                            | e2e               | PASS   | `workflows-execute.e2e.test.ts` (1 new case — polls MongoDB `audit_logs` by executionId)                                          |
| 18  | CodeSnippets renders exactly 3 curl tabs (Sync, Async+Poll, Async Push) after Async-only removal (2026-04-19)                                        | e2e (Playwright)  | PASS   | `apps/studio/e2e/workflows/workflow-trigger-api-key.spec.ts` (tab-label loop updated to 3 entries)                                |
| 19  | Studio `compareSemverDescLocal` agrees with shared-kernel `compareSemverDesc` after re-export refactor (GAP-007)                                     | unit              | PASS   | Runtime + engine `semver-compare.test.ts` cover the canonical implementation; Studio call sites unchanged                         |

### Testing Notes

- Full coverage matrix and scenarios live in the companion testing guide.
- **All E2E tests must hit real runtime + engine via HTTP — no mocking of codebase components**, per CLAUDE.md Test Architecture rules.
- Studio E2E uses Playwright; runtime E2E uses Supertest against a spawned Express app with MongoMemoryServer (existing pattern in `process-api.integration.test.ts`).
- Engine semver-parity test (Scenario 5) is the keystone — without it the feature's primary reliability claim is unverified.

> Full testing details: [../../testing/sub-features/workflow-webhook-versioning.md](../../testing/sub-features/workflow-webhook-versioning.md)

---

## 18. References

- [Workflow Triggers](./workflow-triggers.md) — parent feature; NG6 explicitly defers versioning integration
- [Workflow Versioning](./workflow-versioning.md) — version lifecycle, `WorkflowVersion` model, activate/deactivate
- [Workflow as Tool](../workflow-as-tool.md) — `WorkflowBindingIR`, `WorkflowConfigForm`, agent-tool invocation path
- [Workflow Async Completion](./workflow-async-completion.md) — async-push callback contract (unchanged)
- [Deployments & Versioning](../deployments-versioning.md) — owner of `WorkflowVersion` lifecycle; this feature consumes version metadata
- Design docs: `docs/specs/workflow-triggers.hld.md`, `docs/specs/workflow-versioning.hld.md`, `docs/specs/workflow-as-tool.hld.md`
- Implementation plans: `docs/plans/2026-04-14-workflow-versioning-impl-plan.md`, `docs/plans/2026-04-13-workflow-as-tool-impl-plan.md`

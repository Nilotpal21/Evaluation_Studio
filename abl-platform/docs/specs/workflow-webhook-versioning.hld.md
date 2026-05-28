# HLD: Workflow Webhook Versioning

**Feature Spec**: [`docs/features/sub-features/workflow-webhook-versioning.md`](../features/sub-features/workflow-webhook-versioning.md)
**Test Spec**: [`docs/testing/sub-features/workflow-webhook-versioning.md`](../testing/sub-features/workflow-webhook-versioning.md)
**Parent HLDs**: [`workflow-triggers.hld.md`](workflow-triggers.hld.md), [`workflow-versioning.hld.md`](workflow-versioning.hld.md), [`workflow-as-tool.hld.md`](workflow-as-tool.hld.md)
**Status**: APPROVED (implemented 2026-04-18, feature at ALPHA; hardening + webhook-surface polish committed 2026-04-19)
**Author**: Runtime Team
**Date**: 2026-04-17
**Last Updated**: 2026-04-19

## Post-Implementation Notes (2026-04-18)

- **HLD D-4 overridden in LLD**: LLD LD-4 documented the override. New function `findWorkflowVersionByAnyState` was replaced with extending existing `findWorkflowVersion()` with `opts?: { excludeDeleted?: boolean }` — matches repo-idiomatic opts pattern used by `findWorkflowByIdAndTenant()`. HLD D-4 should be read alongside LLD LD-4.
- **LLD LD-6 (atomic 4-package lockstep) shipped as 2 commits**: `commit-scope-guard.sh` hard-blocks >3 packages. Split into Phase 3a (compiler + shared + runtime) and Phase 3b (workflow-engine). Both commits must ship together. Documented in commit messages and `packages/compiler/agents.md`.
- **KEYSTONE test in place**: `apps/workflow-engine/src/__tests__/system-execute-version.test.ts` extended with the runtime↔engine parity case. Both paths return `v0.10.0` given the same 3-active-version fixture (`v0.2.0`, `v0.9.0`, `v0.10.0`). This is the primary reliability assertion for FR-8.
- **3 MEDIUM gaps deferred to BETA**: `semver.rcompare` exception safety (GAP-006), Studio pre-release handling in `compareSemverDescLocal` (GAP-007), `mutate` dep in Studio useCallback (GAP-008). None are exploitable or block production for ALPHA.

## Post-Implementation Notes (2026-04-19 — hardening)

A post-ALPHA audit of this sub-feature surfaced 5 additional gaps; all landed as three additive commits on `feat/workflow-version` under ABLP-2:

- **LD-5 reversed (GAP-013 → mitigated)**: the "duplicated per LD-5" `compareSemverDesc` copies in `apps/runtime/src/services/workflow-version-service.ts` and `apps/workflow-engine/src/lib/semver-compare.ts` were consolidated into a zero-dep canonical implementation at `packages/shared-kernel/src/utils/semver-compare.ts`. Both apps now re-export. Rationale: Studio already had a 3rd independent copy for bundle-size reasons; drift risk across backends outweighed LD-5's deployment-simplicity argument once shared-kernel dep propagation was verified. GAP-006 (`TypeError` on corrupt input) is subsumed — the new parser is regex-gated and returns `null` on invalid input.
- **GAP-009 (trigger-engine semver fallback)**: `TriggerEngine.fireWebhookTrigger()` added a third resolution tier between deployment-manifest lookup and working-copy fallback: highest-semver active non-draft non-deleted version. Legacy trigger registrations (no pinned `workflowVersionId`, no environment/deployment) now execute the published build per FR-8 instead of the working-copy draft. Extended `workflowVersionModel` deps with an optional `.find()` method so older test stubs that only mock `findOne` continue to compile.
- **GAP-010 (rate limit)**: `tenantRateLimit('request')` middleware attached to both execute routes (`POST /:workflowId/execute` and `POST /:workflowId/versions/:version/execute`). GET status-poll is intentionally unthrottled. Applies tenant + per-API-key sliding windows from `HybridRateLimiter` (Redis primary, in-memory fallback).
- **GAP-011 (audit log)**: new `auditWorkflowExecuted()` helper in `audit-helpers.ts`, invoked fire-and-forget from `handleWorkflowExecute()` right after `executionId` is generated. Records `action: 'workflow.executed'` with resolved version + mode + apiKeyId. E2E persistence verified by polling `audit_logs` collection.
- **GAP-012 (response envelope)**: `handleWorkflowExecute()` computes a `resolvedVersionFields` object once and spreads it into every response site (202 async, 202 timeout auto-promote, 200 completed, 200 failed/cancelled). Callers that omit `?version=` now learn which version executed without a second status call.

These fixes do not change any HLD diagrams or data-flow decisions; they are purely additive on the existing surfaces. The feature remains at ALPHA — BETA promotion gates (GAP-007 Studio pre-release handling, GAP-008 SWR deps array, 48h production soak) are unchanged.

## Post-Implementation Notes (2026-04-19 — iteration 3, webhook-surface polish)

A follow-on commit on `feat/workflow-version` (`ce5c568b4e`) consolidated two workflow-webhook surfaces that the iteration-2 audit had intentionally left open:

- **GAP-007 closed (Studio comparator parity)**: iteration 2 collapsed runtime + engine `compareSemverDesc` into `@agent-platform/shared-kernel` but left `apps/studio/src/lib/semver-compare.ts` with its own parser (to keep the Studio bundle small). Verifying that shared-kernel is already imported by Studio via `@agent-platform/*` made the original bundle-size argument moot. The Studio file now re-exports the canonical `compareSemverDesc` under the existing `compareSemverDescLocal` alias, so Studio, runtime, and engine all sort by the same parser. All three original drift risks — pre-release ordering, leading `v`, invalid-string placement — are now single-source.
- **CodeSnippets tab set trimmed 4 → 3**: The "Async-only" mode tab in `apps/studio/src/components/workflows/triggers/CodeSnippets.tsx` was a fire-and-forget variant of `?mode=async` that Async+Poll supersedes. Removing it simplifies the webhook Quick Start surface without changing the underlying routes (`?mode=async` remains a valid query — the tab is just no longer surfaced as a primary option). The `workflows.triggers.async_mode` i18n key was dropped as part of the same commit; the Playwright `workflow-trigger-api-key.spec.ts` regression now asserts the 3-tab layout.

No HLD decisions overturned. §7 API Design remains accurate. §4 Component Diagram has been updated in-place to drop the `async` tab from the `WebhookQuickStart.tsx + CodeSnippets.tsx` tab list so the diagram matches the shipped 3-tab surface. Feature stays at **ALPHA**; BETA gates now reduce to GAP-008 (SWR deps array) + 48h production soak.

---

## 1. Overview / Goal

Make workflow version the primary coordinate for every webhook call — visible in Studio, selectable per-request, deterministic in default resolution, and pin-able for agent tool bindings. External callers get a clean `/api/v1/workflows/:id/execute` URL that accepts `?version=<semver>` and `?mode=`. Studio displays a `[version] [state]` tag pair beside the workflow header; any URL the user copies from the panel already carries the version the user is viewing. Default resolution is deterministic — highest-semver active non-draft — in both the runtime and engine resolution paths, so agent-tool and webhook callers always see the same version chosen.

---

## 2. Problem Statement

Workflow versioning is fully implemented (`WorkflowVersion` model with `active`/`inactive` state, per-version trigger registrations), and a public webhook API exists at `/api/v1/process/:workflowId`. But the pieces don't connect:

1. **Studio is version-blind.** `WebhookQuickStart.tsx:68-70` already emits `/api/v1/workflows/:id/execute` (short-URL shape) in the header but the route is not mounted. `CodeSnippets.tsx:48` still emits the long proxy URL. No `?version=` on either. Users publishing `v0.1.0` → `v0.2.0` → `v0.3.0` cannot tell which version their copy-paste URL runs.
2. **Default resolution is non-deterministic.** Engine's `workflow-executions.ts:311` runs `findOne({state:'active'})` with **no sort** — Mongo returns an indeterminate document. Runtime's `resolveDefaultVersion()` sorts by `publishedAt desc`, so a hotfix `v0.1.5` published today shadows `v0.2.0` published last week.
3. **Public URL leaks structure.** `/api/projects/:pid/workflows/:wid/executions/execute` exposes internal project IDs and is verbose for third-party webhook configuration fields.
4. **Agent tool bindings can't pin a version.** `WorkflowBindingIR` (`schema.ts:891`) has no `workflowVersion` field; `WorkflowToolExecutor.execute():128` never sends one. Agent behavior changes non-deterministically whenever a workflow is re-published with multiple active versions.

Parent feature `workflow-triggers` explicitly deferred this under NG6. This HLD closes that gap.

---

## 3. Alternatives Considered

### Option A: Path-segment version pinning — `/api/v1/workflows/:id/versions/:version/execute`

- **Description**: RESTful sub-resource form. Absence of version segment maps to default resolution.
- **Pros**: Readable URL; tree-expands naturally for future version-scoped operations (`/versions/:v/status`).
- **Cons**: Breaks the "one stable URL, optional pinning" UX — the `?version=` query is how the existing process API and the proxy middleware both work (`process-api.ts:166`, `workflow-engine-proxy.ts:245`). Forces Studio to render two different URL shapes depending on whether a version is pinned. Doesn't match sibling SaaS conventions (Stripe, GitHub webhooks use query params for variant routing).
- **Effort**: M

### Option B: Keep the long proxy URL, only add `?version=` support (no short URL)

- **Description**: Don't add a new route. Update `WebhookQuickStart` to emit `/api/projects/:pid/workflows/:wid/executions/execute?version=<viewed>`. Update `CodeSnippets` to unify on the same URL. Skip the short-URL work entirely.
- **Pros**: Smallest scope. No new route to maintain. No mounting-order risk in `server.ts`.
- **Cons**: Leaves internal project IDs in public webhook URLs — worse DX for external integrators. Doesn't address the conventions mismatch with sibling SaaS. US-2 (external developer) stays unaddressed.
- **Effort**: S

### Option C: New short URL with `?version=` query + semver-desc default resolution + additive binding field (Recommended)

- **Description**: Add `/api/v1/workflows/:workflowId/execute` as a new runtime route (not proxied through `workflow-engine-proxy.ts`), share handler logic with `/api/v1/process/:workflowId` via extracted helper. Keep legacy route mounted for backward compat. Fix default resolution in both runtime and engine to sort by semver desc. Add optional `workflowVersion` to `WorkflowBindingIR` + plumb through `WorkflowConfigForm` → DSL → `WorkflowToolExecutor`.
- **Pros**: Solves all four feature-spec problem bullets. No behavior change for callers that don't adopt `?version=`. The semver-sort fix corrects a documented non-determinism bug. Binding field is additive; zero migration. URL shape matches sibling SaaS webhook conventions.
- **Cons**: Two public URLs ship concurrently (`/api/v1/process` + `/api/v1/workflows`); Studio stops surfacing the legacy one but it stays wired. Compiler-lockstep risk for the new DSL property (3 locations must update together per `packages/compiler/agents.md`).
- **Effort**: M

### Recommendation: Option C

**Rationale**: Option A would fragment the URL space and force Studio to render path-segment vs query-param forms. Option B leaves the internal-ID leak and skips the agent-binding improvement that US-4 requires. Option C is the only option that addresses all four feature-spec problem bullets in a single coherent change. The two-public-URL concurrency is managed by keeping legacy as an internal compat surface (no Studio copy-paste, no docs promotion); real users converge on the short URL within 60 days per the success metric.

---

## 4. Architecture

### System Context Diagram

```text
                            External Systems
                         (Stripe, GitHub, SaaS tools,
                          custom backends, no-code)
                                  │
                   POST /api/v1/workflows/{id}/execute
                         ?mode=sync&version=v0.2.0
                         x-api-key: wfk_…
                                  │
                                  ▼
                    ┌───────────────────────────┐
                    │ Runtime (port 3112)       │
                    │                           │
                    │  /api/v1/workflows/:id/   │ ◄─── NEW ROUTE
                    │     execute               │
                    │                           │
                    │  /api/v1/process/:id      │ ◄─── LEGACY, STAYS
                    │                           │
                    │  /api/projects/:pid/…     │ ◄─── Studio design-time,
                    │                           │      internal only
                    │                           │
                    │  tenantAuthMiddleware     │
                    │  → WorkflowApiKey lookup  │
                    │  → projectScope check     │
                    │  → workflow-execute-      │
                    │    handler (shared)       │
                    │  → SyncExecutionService   │ (Redis Pub/Sub sync wait)
                    └────────┬──────────────────┘
                             │
                 Forwarded caller auth
                             │
                             ▼
                    ┌───────────────────────────┐
                    │ Workflow-Engine (9080)    │
                    │                           │
                    │  /api/v1/projects/:pid/   │
                    │   workflows/:wid/         │
                    │   executions/execute      │
                    │                           │
                    │  Zod: { workflowVersion?, │
                    │        workflowVersionId?,│
                    │        webhookMode?, … }  │
                    │                           │
                    │  Version resolution:      │
                    │  • Explicit _id pin       │ (existing, no state filter)
                    │  • Semver pin             │ (NEW — state-agnostic)
                    │  • Default: semver-desc   │ (NEW — was unsorted)
                    │  → Restate start          │
                    └───────────────────────────┘
                             │
                             ▼
                    ┌───────────────────────────┐
                    │ MongoDB (WorkflowVersion) │
                    │ Redis (Pub/Sub status)    │
                    └───────────────────────────┘

                    Agent-tool path (parallel, unchanged URL):
                    Agent → WorkflowToolExecutor →
                    POST /api/v1/projects/{pid}/workflows/{wid}/
                         executions/execute
                    body: { payload, triggerType: 'agent',
                            workflowVersion?: string }  ◄─── NEW optional
```

### Component Diagram

```text
Runtime process boundary
┌──────────────────────────────────────────────────────────────────────┐
│                                                                       │
│  Routes                             Services                          │
│  ──────                             ────────                          │
│  process-api.ts                     workflow-version-service.ts       │
│  ┌────────────────────────┐         ┌─────────────────────────────┐   │
│  │ POST /api/v1/process/  │         │ resolveDefaultVersion()     │   │
│  │   :workflowId          │         │  ▲ semver-desc (CHANGED)    │   │
│  │ body.isAsync flag      │         └─────────────────────────────┘   │
│  └──────────┬─────────────┘         sync-execution.ts                 │
│             │                       ┌─────────────────────────────┐   │
│  workflows-execute.ts  (NEW)        │ waitForCompletion()         │   │
│  ┌────────────────────────┐         │   Redis Pub/Sub subscribe   │   │
│  │ POST /api/v1/workflows/│         └─────────────────────────────┘   │
│  │   :workflowId/execute  │                                           │
│  │ ?mode, ?version         │         Repos                             │
│  └──────────┬─────────────┘         ─────                             │
│             │                       workflow-repo.ts                  │
│             │  (each ROUTE ADAPTER   ┌─────────────────────────────┐   │
│             │   calls repo for       │ findWorkflowByIdAndTenant() │   │
│             │   version resolution   │ findActiveWorkflowVersion() │◄──┐│
│             │   BEFORE shared        │ findWorkflowVersion(...,    │◄┐ ││
│             │   handler, then passes │   { excludeDeleted:true })  │ │ ││
│             │   pre-resolved ids)    └─────────────────────────────┘ │ ││
│             ▼                                                        │ ││
│  ┌─────────────────────────────┐                                     │ ││
│  │ handleWorkflowExecute()     │  (state-agnostic: new short URL) ───┘ ││
│  │ (SHARED — extracted)        │  (state-filtered: legacy process) ────┘│
│  │ • input-schema validation   │                                        │
│  │ • executionId (UUIDv7)      │                                        │
│  │ • sync/async branching      │                                      │
│  │ • callback delivery hand-   │    Middleware                        │
│  │   off                       │    ──────────                        │
│  │ • engine proxy with         │    workflow-engine-proxy.ts          │
│  │   forwarded caller auth     │    ┌─────────────────────────────┐   │
│  └─────────────────────────────┘    │ ?version= query reader      │   │
│  Agent path                         │ body-wins on conflict (NEW) │   │
│  ──────────                         └─────────────────────────────┘   │
│  workflow-tool-executor.ts                                            │
│  ┌─────────────────────────────┐    IR types                          │
│  │ execute()                   │    ─────────                         │
│  │ body.workflowVersion?       │◄── schema.ts (compiler)              │
│  │   injected when binding     │    ┌─────────────────────────────┐   │
│  │   has it set                │    │ WorkflowBindingIR.          │   │
│  └─────────────────────────────┘    │   workflowVersion?: string  │   │
│                                     │   (NEW, optional)            │   │
│                                     └─────────────────────────────┘   │
└──────────────────────────────────────────────────────────────────────┘

Workflow-Engine process boundary
┌──────────────────────────────────────────────────────────────────────┐
│  workflow-executions.ts                                               │
│  ┌─────────────────────────────────────────────────────────────┐     │
│  │ POST /api/v1/projects/:pid/workflows/:wid/executions/execute │     │
│  │ Zod accepts workflowVersion?, workflowVersionId?             │     │
│  │                                                              │     │
│  │ Resolution order:                                            │     │
│  │  1. workflowVersionId → findOne({_id}), state-agnostic       │     │
│  │     (existing behavior)                                      │     │
│  │  2. workflowVersion (semver string) → findOne({version}),    │     │
│  │     state-agnostic (NEW — was not wired into resolution)     │     │
│  │  3. Default → find({state:'active'}), semver-desc sort,      │     │
│  │     pick highest (NEW — was unsorted findOne)                │     │
│  │  4. Fall back to draft + emit resolution-miss metric         │     │
│  └─────────────────────────────────────────────────────────────┘     │
└──────────────────────────────────────────────────────────────────────┘

Studio (Next.js)
┌──────────────────────────────────────────────────────────────────────┐
│  WorkflowDetailPage.tsx                                               │
│  ┌─────────────────────────────────────────────────────────────┐     │
│  │ Header: Workflows / <name>  [version] [state]                │     │
│  │ caption: "served via <highest-active>"  (only if inactive)   │     │
│  │ viewed-version prop → Triggers tab → Quick Start            │     │
│  └─────────────────────────────────────────────────────────────┘     │
│                              │                                        │
│                              ▼                                        │
│  WebhookQuickStart.tsx + CodeSnippets.tsx                            │
│  ┌─────────────────────────────────────────────────────────────┐     │
│  │ Emits: /api/v1/workflows/{id}/execute?version=<viewed>       │     │
│  │ Tabs: sync, async_poll, async_push                           │     │
│  │ Poll status URL stays version-less                           │     │
│  └─────────────────────────────────────────────────────────────┘     │
│                                                                       │
│  WorkflowConfigForm.tsx (tool-binding popup)                         │
│  ┌─────────────────────────────────────────────────────────────┐     │
│  │ Version dropdown persists workflow_version into DSL          │     │
│  │ Create flow auto-pins the previewed active version;         │     │
│  │ explicit "Latest active (auto-resolve)" clears the field    │     │
│  └─────────────────────────────────────────────────────────────┘     │
└──────────────────────────────────────────────────────────────────────┘
```

### Data Flow — External webhook call with explicit version pin

```text
1. External client (Stripe):
   POST https://runtime.abl.dev/api/v1/workflows/wf_abc/execute
        ?mode=sync&version=v0.2.0
   Headers: x-api-key: wfk_…
   Body: { "input": { "event": "invoice.paid" } }

2. Runtime → tenantAuthMiddleware (server.ts:785 style mount):
   • SHA-256 lookup → WorkflowApiKey doc → tenantContext { tenantId, projectScope, permissions }
   • 401 if key invalid or expired

3. Runtime → workflows-execute route handler:
   • Parse ?mode → normalized enum
   • Parse ?version → "v0.2.0"
   • findWorkflowByIdAndTenant(wf_abc, tenantId) → workflow doc
   • projectScope.includes(workflow.projectId)? → 404 conceal if not
   • Version resolution:
     - Explicit pin path → findWorkflowVersion(wf_abc, "v0.2.0",
       tenantId, projectId, { excludeDeleted: true }) — state-agnostic lookup
     - If null → 404 WORKFLOW_VERSION_NOT_FOUND
   • Effective input schema = resolvedVersion.definition.inputSchema ??
     workflow.inputSchema
   • executionId = UUIDv7()

4. Runtime → handleWorkflowExecute (shared handler):
   • Build enginePayload { executionId, payload, triggerType:'webhook',
     workflowVersion:'v0.2.0', webhookMode:'sync', triggerMetadata }
   • Forward original caller auth header(s) + trace headers
   • (mode=sync) SyncExecutionService.waitForCompletion(tenantId, executionId,
     timeoutMs=30000) — subscribes to
     workflow:{tenantId}:execution:{executionId}:status BEFORE the POST

5. Runtime → Engine:
   POST http://workflow-engine:9080/api/v1/projects/{pid}/workflows/wf_abc/
        executions/execute
   Headers: Authorization: Bearer <caller-api-key-or-jwt>
   Body: enginePayload

6. Engine → workflow-executions.ts handler:
   • Auth: unified middleware validates the forwarded API key / user JWT
   • Resolution: workflowVersion present → load by semver (NEW resolver path)
   • Build canvas-to-steps snapshot from WorkflowVersion.definition
   • Restate startWorkflow(executionId, { steps, tenantId, projectId, ... })
   • Respond 202 { executionId }

7. Workflow runs to completion inside Restate → workflow-handler.ts publishes
   "completed" event to Redis channel
   workflow:{tenantId}:execution:{executionId}:status

8. Runtime → SyncExecutionService receives event → resolves waitPromise
   • Response to caller: 200 OK { status:'completed', output: {...} }
   • Or: 202 { executionId, status:'running' } on 30s timeout (auto-promote)

9. Logging: log.info('Sync execution completed', {
     workflowId, executionId, apiKeyId, version:'v0.2.0' })
```

### Data Flow — Default resolution (no `?version=`)

Steps 1-3 unchanged except:

```text
3b. Version resolution (no explicit pin):
    • resolveDefaultVersion(tenantId, projectId, wf_abc):
      - find({ workflowId, tenantId, projectId, state:'active',
               deleted:{$ne:true}, version:{$ne:'draft'} }).lean()
      - candidates.sort((a,b) => semverCompare(b.version, a.version))
      - first = highest-semver active (e.g. v0.10.0, not v0.9.0)
      - If no active: fall back to draft + emit
        workflow.version.resolution.miss metric
    • Pass resolved workflowVersion to engine in body

Engine's default branch is now idempotent-equivalent:
    • The same resolution logic runs there if called with neither
      workflowVersion nor workflowVersionId (e.g., legacy proxy paths).
    • Both code paths sort by the same semver-desc rule → runtime/engine
      agree on the chosen version.
```

### Data Flow — Agent tool invocation with pinned version

```text
1. Agent (running in runtime) invokes workflow tool:
   WorkflowToolExecutor.execute(toolName, params, timeoutMs)

2. Look up binding:
   binding = { workflowId: wf_abc, workflowVersion: 'v0.1.0',
               triggerId: '…', mode: 'async', paramMapping: {…} }

3. Build engine body:
   {
     payload: applyParamMapping(params, binding.paramMapping),
     triggerType: 'agent',
     workflowVersion: 'v0.1.0',  // NEW — forwarded from binding
     triggerMetadata: { source:'agent_tool', sessionId, agentName, triggerId }
   }

4. POST to engine's long URL (unchanged):
   http://engine:9080/api/v1/projects/{pid}/workflows/wf_abc/executions/execute

5. Engine resolves workflowVersion='v0.1.0' via NEW semver-string resolver
   branch — state-agnostic — then runs that version.

6. If binding has no workflowVersion set (legacy or explicitly auto-resolve):
   body omits the field → engine falls through to the default branch →
   semver-desc rule → runs highest active non-draft version.
```

### Async-push callback flow (unchanged)

`mode=async_push` with `callbackUrl` reuses the existing callback-delivery pipeline. The short-URL handler forwards `callbackUrl` + `accessToken` into `triggerMetadata` → engine persists on `WorkflowExecution` → on completion, `callback-delivery-worker.ts` POSTs the result with HMAC-SHA256 signing + 3-retry exponential backoff + SSRF guard. See [`docs/specs/workflow-async-completion.hld.md`](workflow-async-completion.hld.md) for the full signing and delivery contract. No changes in this HLD.

### Sequence Diagram — Sync short URL with version pin-miss

```text
Client    Runtime             Mongo             Engine
  │         │                   │                  │
  │ POST /api/v1/workflows/     │                  │
  │   wf_abc/execute            │                  │
  │   ?mode=sync&version=v9.9.9 │                  │
  ├────────▶│                   │                  │
  │         │ findWorkflowById… │                  │
  │         ├──────────────────▶│                  │
  │         │                   │ {_id, projectId} │
  │         │◀──────────────────┤                  │
  │         │ findWorkflowVers… │                  │
  │         │   ByAnyState      │                  │
  │         │   (v9.9.9)        │                  │
  │         ├──────────────────▶│                  │
  │         │                   │ null             │
  │         │◀──────────────────┤                  │
  │         │                                      │
  │ 404 WORKFLOW_VERSION_NOT_FOUND                 │
  │◀────────┤                                      │
  │         │                                      │
         (no engine call — fail fast)
```

---

## 5. The 12 Architectural Concerns

### Structural Concerns

| #   | Concern                 | Design Decision                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                          |
| --- | ----------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| 1   | **Tenant Isolation**    | Every Mongo query on `Workflow` and `WorkflowVersion` includes `tenantId` from `tenantContext`. Tenant context is derived from the authenticated principal (`WorkflowApiKey.tenantId` at key-lookup time) — never from URL. Cross-tenant lookup returns 404 with `WORKFLOW_NOT_FOUND` conceal at `process-api.ts:144`-style pattern.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                     |
| 2   | **Data Access Pattern** | Reuse existing repos in `apps/runtime/src/repos/workflow-repo.ts`. Use the existing `findWorkflowVersion()` with `opts?: { excludeDeleted?: boolean }` for state-agnostic explicit-pin lookup (`deleted: false` only) and keep `findActiveWorkflowVersion()` for the legacy `/api/v1/process` explicit-pin path (preserves backward-compat behavior). **Shared handler boundary**: version resolution runs in the route adapter BEFORE invoking the shared handler — the new short-URL adapter calls `findWorkflowVersion(..., { excludeDeleted: true })`, the legacy adapter calls `findActiveWorkflowVersion()`, then both pass a pre-resolved `{ workflowVersionId, workflowVersion, inputSchema }` bundle into the shared `handleWorkflowExecute()` helper. This keeps the shared function state-behavior-free and makes the per-route divergence explicit. No new caching layer. Client-side semver sort on default-resolution `find()` results (<50 docs typical). |
| 3   | **API Contract**        | `POST /api/v1/workflows/:workflowId/execute` — query: `mode`, `version`; body: `{ input: {}, callbackUrl?, accessToken?, executionId? }`; auth: `x-api-key`. Response envelope matches existing `process-api.ts`: `{ success, data?: { traceId, status, output? }, error?: { code, message } }`. Error codes: `WORKFLOW_NOT_FOUND`, `WORKFLOW_VERSION_NOT_FOUND`, `INVALID_MODE`, `SCHEMA_MISMATCH`, `SYNC_UNAVAILABLE`, `UPSTREAM_UNAVAILABLE`. **Mode → engine mapping** (handled in the route adapter, mirrors `process-api.ts:304-305`): `?mode=sync` → `{webhookMode:'sync'}`; `?mode=async` → `{webhookMode:'async', webhookDelivery:'poll'}`; `?mode=async_push` → `{webhookMode:'async', webhookDelivery:'push'}`. The engine's Zod schema at `workflow-executions.ts:94-95` keeps `webhookMode` and `webhookDelivery` as two separate fields.                                                                                                                   |
| 4   | **Security Surface**    | `tenantAuthMiddleware` authenticates (SHA-256 key hash lookup); handler authorizes (`workflow:execute` permission + `projectScope` membership). SSRF for async-push `callbackUrl` handled by existing `callback-delivery-worker.ts` guard. Input-schema validation enforced before engine dispatch. No new secrets. No new encryption surface.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                           |

### Behavioral Concerns

| #   | Concern           | Design Decision                                                                                                                                                                                                                                                                                                                                                                                                                                    |
| --- | ----------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 5   | **Error Model**   | 401: missing/invalid API key. 404: workflow not found OR project-scope mismatch (concealed) OR version pin-miss. 400: invalid mode / input validation failure. 502: `UPSTREAM_UNAVAILABLE` (engine unreachable). 503: `SYNC_UNAVAILABLE` (sync mode requested but Redis Pub/Sub subscriber unavailable). Structured `{ code, message }` envelope per CLAUDE.md. All error codes match the existing `process-api.ts` vocabulary for consistency.    |
| 6   | **Failure Modes** | Engine unreachable → 502 `UPSTREAM_UNAVAILABLE`. Sync timeout (30s) → auto-promote to 202 `{ status:'running' }`, caller polls. Client disconnect during sync wait → `AbortController` cancels subscription (existing pattern). Redis Pub/Sub subscribe failure → 503 `SYNC_UNAVAILABLE`. No circuit breaker — engine failures are transient and handled per-request.                                                                              |
| 7   | **Idempotency**   | Caller may supply `executionId` (UUID) for retries — new for the runtime short URL; the engine already accepts it at `workflow-executions.ts:98` (Zod schema), and `workflow-engine/agents.md` documents the boundary-validation guidance. Engine's `findOne({_id})` by executionId dedups safely — retry of same executionId either finds the prior run (complete/running) or starts fresh atomically. `?version=` pin adds no new dedup concern. |
| 8   | **Observability** | Log every execution start with `{ workflowId, executionId, apiKeyId, version, mode }`. Emit `workflow.version.resolution.miss` metric on draft fallback (both runtime and engine). New `proxy.version.conflict` warning on body+query conflict in the legacy proxy. Engine continues to record `workflowVersion` + `workflowVersionId` in `WorkflowExecution` doc. No new trace-event schema.                                                      |

### Operational Concerns

| #   | Concern                | Design Decision                                                                                                                                                                                                                                                                                                                                                                                                    |
| --- | ---------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| 9   | **Performance Budget** | Short URL handler adds one indexed `findOne({_id})` on `Workflow`. Semver resolver adds one `find({state:'active'})` with ≤50 result set + O(n log n) in-memory sort. Expected p99 latency add: <2ms. No new caches. No new queues. Sync timeout unchanged at `PROCESS_API_SYNC_TIMEOUT_MS` (30s default). Max concurrent sync: 100 (existing guard at `process-api.ts:369`).                                      |
| 10  | **Migration Path**     | Zero data migration. `WorkflowBindingIR.workflowVersion` is additive optional — existing saved DSLs parse to `undefined`. New route mounts alongside legacy `/api/v1/process`. Studio stops surfacing long proxy URL but keeps it wired. Semver-sort replaces `publishedAt` sort in runtime and adds sort to engine default branch — atomic deploy across both services required.                                  |
| 11  | **Rollback Plan**      | Three rollback levers: (1) unmount the new route in `server.ts` — purely additive, safe revert; (2) revert the semver-sort commit in both runtime and engine — restores prior non-deterministic behavior (bug reintroduced, but no data corruption); (3) per-workflow mitigation via Studio — deactivate any unwanted version. No feature flag (per feature spec §11). No per-tenant gating — sort rule is global. |
| 12  | **Test Strategy**      | E2E: real runtime Express + MongoMemoryServer + DI-injected mock engine (matches `process-api.e2e.test.ts:8` comment pattern — engine is an external service boundary). Integration: real workflow-version-service with seeded Mongo. Unit: pure semver comparator. Keystone test: runtime↔engine resolution parity (`system-execute-version.test.ts` extension). No `vi.mock` of `@agent-platform/*` or `@abl/*`. |

---

## 6. Data Model

### New Collections/Tables

None.

### Modified Collections/Tables

`WorkflowVersion` — schema unchanged. Only query patterns change.

Existing indexes at `packages/database/src/models/workflow-version.model.ts:122-134`:

```text
{ tenantId: 1, projectId: 1, workflowId: 1, version: 1 }              unique
{ tenantId: 1, projectId: 1, workflowId: 1, state: 1, deleted: 1, publishedAt: -1 }
{ tenantId: 1, workflowId: 1, sourceHash: 1 }
```

The `{tenantId, projectId, workflowId, state, deleted, publishedAt}` compound covers the new semver-resolution `find()` query. The `publishedAt: -1` suffix is unused after the sort change but kept for the legacy path during rollout.

### Modified In-Memory Types

`packages/compiler/src/platform/ir/schema.ts:891`:

```ts
export interface WorkflowBindingIR {
  workflowId: string;
  workflowVersion?: string; // NEW — semver or 'draft' or absent (= auto-resolve)
  triggerId?: string;
  mode: 'sync' | 'async';
  paramMapping: Record<string, string>;
  timeoutMs?: number;
}
```

`WorkflowBindingIR` is in-memory only; no persisted schema. `SessionService.computeIRHash()` at `session-service.ts:109` uses `JSON.stringify(ir)` — new field is naturally included. Sessions with pinned bindings get a new `configHash`; cached sessions without the field remain valid.

### Key Relationships

- `?version=<semver>` on URL ↔ `WorkflowVersion.version` exact string match + `deleted: false`.
- `WorkflowBindingIR.workflowVersion` (DSL) ↔ same `WorkflowVersion.version` match at runtime.
- Default resolution: `WorkflowVersion.state = 'active'` + `version !== 'draft'` + `deleted: false` → semver-desc → `WorkflowExecution.workflowVersion`.

---

## 7. API Design

### New Endpoints

| Method | Path                                                    | Purpose                                                                                                                                                                                                                | Auth                         |
| ------ | ------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------- |
| POST   | `/api/v1/workflows/:workflowId/execute`                 | NEW short public webhook URL. Query: `mode`, `version`. Body: `{ input, callbackUrl?, accessToken?, executionId? }`.                                                                                                   | `x-api-key` (WorkflowApiKey) |
| GET    | `/api/v1/workflows/:workflowId/executions/:executionId` | Status poll for the short URL (FR-21). Runtime route that proxies to engine's existing `/api/v1/projects/:pid/workflows/:wid/executions/:executionId`. Version-less — execution is already version-pinned at dispatch. | `x-api-key`                  |

### Modified Endpoints

| Method | Path                                                             | Change                                                                                                                                            |
| ------ | ---------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------- |
| POST   | `/api/projects/:pid/workflows/:wid/executions/execute` (proxy)   | ADDITIVE: read `?version=` from query; body-level `workflowVersion` still wins on conflict (warning log).                                         |
| POST   | engine `/api/v1/projects/:pid/workflows/:wid/executions/execute` | Resolution logic change: semver-string pin now resolves via state-agnostic semver lookup; default branch now sorts by semver desc. No new fields. |
| POST   | `/api/v1/process/:workflowId` (legacy)                           | Unchanged contract. Error code `VERSION_NOT_FOUND` retained. Studio stops surfacing in Quick Start.                                               |

### Error Responses

| HTTP | Code                         | When                                                                               |
| ---- | ---------------------------- | ---------------------------------------------------------------------------------- |
| 400  | `INVALID_MODE`               | `?mode=` not in {sync, async, async_push}                                          |
| 400  | `INVALID_EXECUTION_ID`       | `executionId` body field not a valid UUID                                          |
| 400  | `INVALID_CALLBACK_URL`       | `callbackUrl` not a valid URL (async_push)                                         |
| 400  | `MISSING_CALLBACK_URL`       | `mode=async_push` without `callbackUrl`                                            |
| 400  | `SCHEMA_MISMATCH`            | `input` fails workflow's `inputSchema`                                             |
| 401  | `API_KEY_REQUIRED`           | Missing/invalid `x-api-key`                                                        |
| 403  | `FORBIDDEN`                  | API key lacks `workflow:execute` permission                                        |
| 404  | `WORKFLOW_NOT_FOUND`         | Workflow not in tenant OR project scope mismatch (conceal)                         |
| 404  | `WORKFLOW_VERSION_NOT_FOUND` | `?version=` or `workflowVersion` pin matches no document                           |
| 502  | `UPSTREAM_UNAVAILABLE`       | Engine unreachable or returned non-2xx (matches existing `process-api.ts:341,412`) |
| 503  | `SYNC_UNAVAILABLE`           | `mode=sync` but Redis Pub/Sub subscriber unavailable                               |

---

## 8. Cross-Cutting Concerns

- **Audit Logging**: Every execution records `apiKeyId`, resolved `workflowVersion`, `workflowVersionId` in `WorkflowExecution.triggerMetadata`. Existing pattern in `workflow-engine-proxy.ts:255-263` and `process-api.ts:280-289` preserved. **Updated 2026-04-19**: `handleWorkflowExecute()` now additionally writes a durable `workflow.executed` record to the shared audit store via `auditWorkflowExecuted()` (fire-and-forget), capturing resolved version + mode + apiKeyId for compliance-facing surfaces (GAP-011).
- **Rate Limiting**: Inherits existing tenant-level rate limiting and per-tenant sync concurrency cap (100). **Updated 2026-04-19**: `tenantRateLimit('request')` middleware now attached to both POST execute routes (`/:workflowId/execute` and `/:workflowId/versions/:version/execute`) per GAP-010. Status-poll GET route intentionally unthrottled — polling clients should not burn the tenant quota.
- **Caching**: No new caches. `WorkflowVersion` lookups are direct Mongo reads (indexed). Version count per workflow stays small enough that client-side sort beats a denormalized `versionSortKey`.
- **Encryption**: In transit (TLS) and at rest (Mongo encryption) unchanged. No new secrets. `x-api-key` SHA-256 hash-at-rest (existing).

---

## 9. Dependencies

### Upstream (this feature depends on)

| Dependency                                                                                                          | Type                        | Risk                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                          |
| ------------------------------------------------------------------------------------------------------------------- | --------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `WorkflowVersion` model + activate/deactivate                                                                       | Shipped (parent sub)        | Low — stable, BETA                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                            |
| `tenantAuthMiddleware` + `WorkflowApiKey`                                                                           | Shipped                     | Low — stable                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                  |
| `SyncExecutionService` (Redis Pub/Sub)                                                                              | Shipped (workflow-triggers) | Low — battle-tested in `process-api.ts`                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                       |
| `WorkflowConfigForm.tsx` (tool-binding popup)                                                                       | Shipped (workflow-as-tool)  | Low — component already has a version dropdown (used today for trigger filtering); this feature extends it to also persist the selected version into the binding DSL                                                                                                                                                                                                                                                                                                                                                                                                                                                          |
| `semver` npm package                                                                                                | NEW prod dep                | Low — widely used, ^7.7.4 matches existing devDep transitive                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                  |
| `SessionService.computeIRHash()`                                                                                    | Shipped                     | Low — `JSON.stringify`-based hash naturally absorbs the new field                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                             |
| DSL property parser (`dsl-property-parser.ts:519,541`) + `WorkflowBindingLocal` + `resolve-tool-implementations.ts` | Shipped                     | Medium — compiler-wide lockstep spans **3 code-change sites + 1 verification site**: (1) `packages/compiler/src/platform/ir/schema.ts:891` (`WorkflowBindingIR` — add field), (2) `packages/shared/src/tools/dsl-property-parser.ts:519` (`WorkflowBindingLocal` interface — add field), (3) same file `:541` (`buildWorkflowBindingFromProps()` parser — read `workflow_version` prop), (4) `packages/shared/src/tools/resolve-tool-implementations.ts` (verify propagation — NO code change needed, already passes the whole `WorkflowBindingLocal` object at line 571). Missing any of sites 1-3 silently drops the field. |

### Downstream (depends on this feature)

| Consumer                                  | Impact                                                                                      |
| ----------------------------------------- | ------------------------------------------------------------------------------------------- |
| Studio Workflow Detail header             | Visual change (two badges + caption); existing E2Es unaffected (no URL-string assertions)   |
| Studio Webhook Quick Start + CodeSnippets | URL shape changes + `?version=` added; existing E2Es assert panel presence, not URL content |
| Agent tools bound to workflows            | Zero immediate impact (field is additive optional); future re-binds can pin                 |
| External webhook consumers                | Zero immediate impact (legacy route stays); new short URL available for voluntary adoption  |

---

## 10. Open Questions & Decisions Needed

1. **Pre-release semver support**: Should the resolver support `v0.2.0-beta`? Current `nextVersion()` at `workflow-version-service.ts:504-511` never produces them, and the semver library's `rcompare` handles them correctly if they appear. No action needed unless users manually publish pre-release identifiers (out of scope today).
2. **Path-segment URL alternative**: Could be added later as `/api/v1/workflows/:id/versions/:v/execute` without breaking the query-param form. Not scoped in this HLD.
3. **"Copy versionless URL" button in Studio**: Whether users want an explicit "always latest active" copy action alongside the version-pinned one. Punted to a follow-up based on user feedback.
4. **Per-tenant multi-active-version count**: Rollout risk analysis (Q15) needs a production query to count workflows with ≥2 active versions. Non-blocking; mitigation plan is workflow-level (deactivate unwanted version).
5. **Engine's body-level `workflowVersion` wiring today**: Engine accepts it via Zod at `workflow-executions.ts:101` but the resolution logic at `:280-324` does NOT consume the semver string (only `workflowVersionId`). This HLD introduces the semver-string resolver branch — confirm no existing consumer relies on the semver being silently ignored (unlikely, but worth grepping engine tests before implementation).

---

## 11. Decisions Made (via product-oracle)

| #   | Decision                                                                                                                                 | Rationale                                                                                                                                                                                      | Risk |
| --- | ---------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---- |
| D-1 | `semver ^7.7.4` added as prod dep to runtime + engine independently, NOT to a shared package                                             | Only two consumers; shared package causes broader install propagation; matches existing per-app dependency pattern                                                                             | Low  |
| D-2 | No per-tenant feature flag for the semver-sort behavior change                                                                           | Prior behavior is non-deterministic (bug class, not feature class); rollback = prior-build deploy or per-workflow version deactivate                                                           | Low  |
| D-3 | Shared handler lives in `apps/runtime/src/routes/process-api.ts` as an exported helper; new route imports it                             | Matches repo convention (route files own helpers); no precedent for route logic in `services/`                                                                                                 | Low  |
| D-4 | Superseded post-implementation: explicit-pin lookup reuses `findWorkflowVersion(..., { excludeDeleted: true })`, not a new repo function | Post-implementation review found the existing repo helper was already state-agnostic; extending it with an opts bag matched repo conventions better than introducing a near-duplicate function | Low  |

---

## 12. Rollout Sequencing

Because the feature bundle spans a behavior-change (semver-sort) and purely-additive work, the suggested rollout order minimizes blast radius:

1. **Stage 1 — additive runtime**: Mount `/api/v1/workflows/:workflowId/execute`; extract shared handler from `process-api.ts`; add `?version=` query support in `workflow-engine-proxy.ts`. Zero behavior change for existing callers.
2. **Stage 2 — additive compiler/binding**: Add `workflowVersion?: string` to `WorkflowBindingIR` + DSL parser + `WorkflowToolExecutor` forward. Zero behavior change for bindings without the field.
3. **Stage 3 — additive Studio**: Two-badge header, inactive caption, Quick Start short URL with `?version=`, `WorkflowConfigForm` dropdown persists. Zero backend behavior change.
4. **Stage 4 — semver-sort (atomic across services)**: Update `resolveDefaultVersion()` in runtime AND engine default branch. The engine runs in Docker (see `apps/workflow-engine/agents.md`), so the deploy requires a coordinated Docker image rebuild alongside the runtime deploy. Preferred order: engine-first (engine change is a no-op for callers that send no semver pin — safe to ship alone), then runtime follows in the same release window. Monitor `workflow.version.resolution.miss` baseline. This is the only behavior-change stage.

Stages 1-3 can ship independently; stage 4 must be atomic.

---

## 13. References

- Feature spec: [`docs/features/sub-features/workflow-webhook-versioning.md`](../features/sub-features/workflow-webhook-versioning.md)
- Test spec: [`docs/testing/sub-features/workflow-webhook-versioning.md`](../testing/sub-features/workflow-webhook-versioning.md)
- Parent HLDs:
  - [`docs/specs/workflow-triggers.hld.md`](workflow-triggers.hld.md) — source of sync/async wait pattern
  - [`docs/specs/workflow-versioning.hld.md`](workflow-versioning.hld.md) — `WorkflowVersion` model, activate/deactivate lifecycle
  - [`docs/specs/workflow-as-tool.hld.md`](workflow-as-tool.hld.md) — `WorkflowBindingIR`, `WorkflowConfigForm`
  - [`docs/specs/workflow-async-completion.hld.md`](workflow-async-completion.hld.md) — async-push callback contract
- Key code references (all verified against HEAD):
  - `apps/runtime/src/routes/process-api.ts` — existing short-ish-URL precedent, shared-handler target
  - `apps/runtime/src/services/workflow-version-service.ts:695` — `resolveDefaultVersion()` semver-sort change site
  - `apps/workflow-engine/src/routes/workflow-executions.ts:311` — engine default branch semver-sort change site
  - `apps/runtime/src/middleware/workflow-engine-proxy.ts:242-281` — `?version=` query support addition
  - `apps/runtime/src/services/workflow/workflow-tool-executor.ts:128` — agent-binding body injection site
  - `packages/compiler/src/platform/ir/schema.ts:891` — IR type additive field
  - `packages/shared/src/tools/dsl-property-parser.ts:519` — `WorkflowBindingLocal` interface (lockstep site #2)
  - `packages/shared/src/tools/dsl-property-parser.ts:541` — `buildWorkflowBindingFromProps()` parser (lockstep site #3)
  - `packages/shared/src/tools/resolve-tool-implementations.ts` — binding propagation (lockstep site #4)
  - `apps/studio/src/components/workflows/WorkflowDetailPage.tsx:329-338` — header two-badge render site
  - `apps/studio/src/components/workflows/triggers/WebhookQuickStart.tsx:68-70` — short URL already drafted; `?version=` addition site
  - `apps/studio/src/components/workflows/triggers/CodeSnippets.tsx:48` — long proxy URL → short URL migration
  - `apps/studio/src/components/tools/WorkflowConfigForm.tsx` — version-dropdown persistence site
- Compiler guidance: `packages/compiler/agents.md` — 3-location lockstep rule for new DSL properties

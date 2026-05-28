# LLD: Workflow Webhook Versioning — Implementation Plan

**Feature Spec**: [`docs/features/sub-features/workflow-webhook-versioning.md`](../features/sub-features/workflow-webhook-versioning.md)
**HLD**: [`docs/specs/workflow-webhook-versioning.hld.md`](../specs/workflow-webhook-versioning.hld.md)
**Test Spec**: [`docs/testing/sub-features/workflow-webhook-versioning.md`](../testing/sub-features/workflow-webhook-versioning.md)
**Status**: DONE (all 6 phases + 2 pr-review fix commits shipped 2026-04-18; 3 hardening commits + 1 webhook-surface polish commit shipped 2026-04-19)
**Date**: 2026-04-18
**Owner**: Runtime Team
**Implementation Log**: [`docs/sdlc-logs/workflow-webhook-versioning/implementation.log.md`](../sdlc-logs/workflow-webhook-versioning/implementation.log.md)

## Post-Implementation Notes (2026-04-18)

See implementation log for full phase-by-phase commit trail. Key deviations:

- **LD-4 override of HLD D-4**: extended existing `findWorkflowVersion()` with `opts?: { excludeDeleted?: boolean }` rather than creating a new function. HLD has been updated.
- **LD-6 shipped as 2 commits not 1**: `commit-scope-guard.sh` hard-blocks >3 packages. Phase 3a (3 packages) + Phase 3b (engine). Must ship together per `packages/compiler/agents.md`.
- **LD-9 draft badge variant deviated**: LLD suggested `variant="info"`, implementation uses `variant="success"` (same as active). Cosmetic — see pr-review Round 2 L-2.
- **Engine test name**: `system-executions-semver.test.ts` (renamed from `workflow-executions-semver.test.ts`) to match `vitest.system.config.ts` include pattern.

Review round outcomes: 5 pr-review rounds completed. 2 CRITICAL + 1 HIGH from Round 1 fixed (`c3057df3f6`), 3 MEDIUM from Round 2 fixed (`ad4e789b7e`). Rounds 3/4/5 APPROVED with only countered observations. 3 MEDIUM findings deferred to BETA (GAP-006/007/008).

## Post-Implementation Notes (2026-04-19 — audit-driven hardening)

Three additive commits on `feat/workflow-version` under ABLP-2 closed five gaps surfaced by a post-ALPHA audit of this sub-feature. Coverage delta and rationale in the feature spec §16 "Mitigation Notes (2026-04-19)" block. Commit trail:

1. `refactor(shared-kernel): dedupe compareSemverDesc across runtime and workflow-engine` — supersedes **LD-5**. Runtime and engine copies collapsed into `packages/shared-kernel/src/utils/semver-compare.ts`; LD-5's per-app-prod-dep argument yielded to dedupe once shared-kernel dep graph was verified (both apps already depend on it). New parser is zero-dep, regex-gated, and handles invalid input gracefully — subsumes **GAP-006**.
2. `fix(workflow-engine): resolve highest-semver active version for legacy webhook triggers` — closes **GAP-009**. Adds a semver-desc default resolution tier to `TriggerEngine.fireWebhookTrigger()` between deployment-manifest match and working-copy fallback. `workflowVersionModel` deps gained an optional `.find()` so existing test doubles (only mocking `findOne`) still compile.
3. `fix(runtime): harden workflow execute route — rate limit, audit, resolved version` — closes **GAP-010/011/012**. Rate-limit middleware wired onto the two POST execute paths; `auditWorkflowExecuted()` helper called fire-and-forget in the shared handler; `resolvedVersion`/`resolvedVersionId` added to every 2xx response site. Status-poll GET intentionally unthrottled.

No HLD/LLD design decisions overturned other than the LD-5 reversal noted above. Feature status remains **ALPHA**; BETA promotion gates (GAP-007, GAP-008, 48h soak) unchanged.

## Post-Implementation Notes (2026-04-19 — iteration 3, webhook-surface polish)

One additional commit on `feat/workflow-version` under ABLP-2:

- `refactor(studio): consolidate workflow webhook tools` (`ce5c568b4e`) — closes **GAP-007** and trims the CodeSnippets tab set. `apps/studio/src/lib/semver-compare.ts` now re-exports `compareSemverDesc` from `@agent-platform/shared-kernel` under the `compareSemverDescLocal` alias (Studio call sites unchanged; bundle-size argument moot because Studio already imports shared-kernel). `CodeSnippets.tsx` drops the Async-only tab — Sync, Async+Poll, and Async Push remain; `workflows.triggers.async_mode` i18n key removed; Playwright `workflow-trigger-api-key.spec.ts` updated to the 3-tab loop. No engine or runtime changes. LLD design decisions unchanged. Feature status remains **ALPHA**; BETA gates reduce to GAP-008 + 48h soak.

---

## 1. Design Decisions

### Decision Log

| #    | Decision                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                    | Rationale                                                                                                                                                                                                                                                                                                                                                                          | Alternatives Rejected                                                                                                                                                                                    |
| ---- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| LD-1 | Runtime short-URL adapter resolves the `WorkflowVersion` doc locally (via Mongo), then forwards `workflowVersionId` (the `_id`) to the engine — **not** `workflowVersion` (semver string).                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                  | Engine already resolves pinned versions by `workflowVersionId` at `apps/workflow-engine/src/routes/workflow-executions.ts:280-308` (state-agnostic, deleted-filtered). Passing `_id` decouples Phase 1 from the engine semver-string resolver work (Phase 3). Zero engine change needed to ship the new short URL.                                                                 | (a) Forward semver string only — requires engine change coupled to Phase 1; (b) Forward both — redundant; the engine picks `_id` first and ignores string.                                               |
| LD-2 | Tool-executor path (`WorkflowToolExecutor.execute()`) forwards `workflowVersion` (semver string) to engine and **requires** the engine semver-string resolver branch in the same release.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                   | Executor has no Mongo access — it POSTs to engine via `fetch()` (`apps/runtime/src/services/workflow/workflow-tool-executor.ts:115-141`). Resolving the semver → `_id` locally would add a Mongo dependency to a service boundary that today is a thin HTTP client. Cleaner to teach engine to resolve semver strings.                                                             | Executor imports `WorkflowVersionService` to resolve `_id` → adds service-boundary coupling; rejected.                                                                                                   |
| LD-3 | Shared execution handler extracted into `apps/runtime/src/routes/process-api.ts` as an exported pure function `handleWorkflowExecute(deps, args)`. New route file `apps/runtime/src/routes/workflows-execute.ts` imports it.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                | Matches repo convention — route helpers live alongside their routes (`process-api.ts:60-69`, `deployments.ts`, `projects.ts`). No existing precedent for route logic in `services/`. Pure function accepts pre-resolved `{ workflowVersionId, workflowVersion, mode, input, callbackUrl, accessToken, executionId, tenantContext, workflow, projectId }` — state-agnostic per HLD. | Move to `services/workflow-execute-service.ts` — breaks repo convention; Keep inline twice (duplication) — HLD §3 Option C explicitly rejects.                                                           |
| LD-4 | Extend the **existing** `findWorkflowVersion()` at `apps/runtime/src/repos/workflow-repo.ts:54-62` with an optional `opts?: { excludeDeleted?: boolean }` parameter for state-agnostic explicit-pin lookup. The new short-URL route calls it with `{ excludeDeleted: true }`; the existing deployment-validation caller remains unchanged (no opts). **HLD D-4 override**: HLD D-4 proposed a new `findWorkflowVersionByAnyState()` function. LLD re-review against HEAD found that `findWorkflowVersion()` is already state-agnostic at `:54-62` (no state filter, no deleted filter) — the only new filter need is soft-delete gating. Extending with `opts` matches the repo-idiomatic pattern set by `findWorkflowByIdAndTenant(..., { includeDeleted })` at `:34-45`. HLD should be updated post-impl to reflect this. | Re-review against repo conventions: existing `findWorkflowByIdAndTenant()` at `:34-45` already uses an `opts?` pattern. Adding a matching `opts` to `findWorkflowVersion()` is the more repo-idiomatic choice than creating a near-duplicate function.                                                                                                                             | (a) HLD D-4 `findWorkflowVersionByAnyState()` new function — rejected as redundant with existing any-state helper; (b) `{ includeInactive?: true }` flag on `findActiveWorkflowVersion` — also rejected. |
| LD-5 | `semver ^7.7.4` added as a **production dependency** to `apps/runtime/package.json` **and** `apps/workflow-engine/package.json` independently — not a shared package.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                       | Only two consumers. Shared-package route would require new Dockerfile `COPY` lines and broader install graph changes for ~50 LOC of comparator use. Matches per-app dep pattern for app-local utilities.                                                                                                                                                                           | `packages/shared-kernel` reexport — higher propagation + Dockerfile sync burden; rejected per HLD D-1.                                                                                                   |
| LD-6 | Compiler lockstep commit (Phase 4) is **atomic across 3 code sites**: `packages/compiler/src/platform/ir/schema.ts`, `packages/shared/src/tools/dsl-property-parser.ts` (interface + parser), plus engine semver-string resolver + executor forwarding.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                     | `packages/compiler/agents.md` rule — missing any lockstep site silently drops the DSL property. Engine and executor are in the same atomic commit because executor forwards the string that the engine now must resolve.                                                                                                                                                           | Split across commits — risks intermediate state where DSL accepts `workflow_version` but engine drops it silently.                                                                                       |
| LD-7 | Phase 5 (semver-sort) is the **only behavior-change phase** and ships as a single atomic commit touching runtime + engine simultaneously.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                   | Runtime/engine disagreement on default version is the class of bug this feature fixes. Any rollout window where one service sorts by semver and the other sorts by `publishedAt` re-introduces the same bug under a different name. Engine is Docker-deployed per `apps/workflow-engine/agents.md`, so the deploy is coordinated via the deploy-repo release window.               | Ship runtime-first then engine-first — creates exactly the disagreement we're fixing.                                                                                                                    |
| LD-8 | Each phase ships implementation **and** tests in the same phase (test-alongside). Phase 6 covers observability wiring + doc sync — not test authoring.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                      | Repo convention per recent LLDs (`docs/plans/2026-04-14-workflow-versioning-impl-plan.md`). Satisfies CLAUDE.md "E2E + Integration tests are mandatory — minimum 5 each per feature".                                                                                                                                                                                              | Test-last phase — creates "deploy untested, then test" gap; rejected.                                                                                                                                    |
| LD-9 | Draft state-badge color change (`warning` → neutral) is a Studio-only visual tweak, kept inside Phase 4 alongside the two-badge render. `WorkflowDetailPage.tsx:332` `variant === 'draft' ? 'warning' : 'accent'` ternary replaced with `variant="info"` state-neutral.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                     | Matches feature spec §6 Design Considerations — "draft is a valid state, not a warning". Visual change is atomic with the parent two-badge refactor.                                                                                                                                                                                                                               | Ship independently — adds an unrelated commit with no test surface.                                                                                                                                      |

### Key Interfaces & Types

```typescript
// apps/runtime/src/routes/process-api.ts  (NEW — extracted from existing handler)
export interface WorkflowExecuteHandlerDeps {
  syncExecution: () => SyncExecutionService | undefined;
  engineBaseUrl: string;
  jwtSecret: string;
}

export interface WorkflowExecuteHandlerArgs {
  // Identity
  workflowId: string;
  workflow: Record<string, unknown>; // pre-fetched Workflow doc (includes projectId, inputSchema)
  tenantContext: {
    tenantId: string;
    projectScope?: string[];
    permissions?: string[];
    apiKeyId?: string;
    authType: 'api_key' | 'user_jwt';
  };
  // Version resolution — pre-resolved by the route adapter
  workflowVersionId?: string; // engine pins by _id when present — injected into enginePayload (new)
  workflowVersion?: string; // audit/log + engine body passthrough (semver or 'draft')
  // Request shape — route adapter supplies a normalized external mode; the
  // handler internally derives the engine's two-field enum (webhookMode,
  // webhookDelivery) from this single value. This keeps the interface tight
  // and encapsulates the per-route normalization boundary.
  mode: 'sync' | 'async' | 'async_push';
  input: Record<string, unknown>;
  callbackUrl?: string;
  accessToken?: string;
  executionId?: string;
  // Response sink
  res: Response;
  startTime: number;
}

// Zod schemas for the new short URL route (Phase 1.3):
export const workflowsExecuteBodySchema = z
  .object({
    input: z.record(z.unknown()).optional().default({}),
    callbackUrl: z.string().url().optional(),
    accessToken: z.string().optional(),
    executionId: z.string().uuid().optional(),
  })
  .strict();

export const workflowsExecuteQuerySchema = z.object({
  mode: z.enum(['sync', 'async', 'async_push']).default('sync'),
  version: z.string().min(1).optional(),
});

export async function handleWorkflowExecute(
  deps: WorkflowExecuteHandlerDeps,
  args: WorkflowExecuteHandlerArgs,
): Promise<void>;
```

```typescript
// packages/compiler/src/platform/ir/schema.ts  (MODIFIED — additive field)
export interface WorkflowBindingIR {
  workflowId: string;
  workflowVersion?: string; // NEW — semver like 'v0.2.0', or 'draft', or absent (= auto-resolve)
  triggerId?: string;
  mode: 'sync' | 'async';
  paramMapping: Record<string, string>;
  timeoutMs?: number;
}
```

```typescript
// packages/shared/src/tools/dsl-property-parser.ts:519  (MODIFIED — additive field)
export interface WorkflowBindingLocal {
  workflowId: string;
  workflowVersion?: string; // NEW — mirrors WorkflowBindingIR
  triggerId: string;
  mode: 'sync' | 'async';
  timeoutMs?: number;
  paramMapping?: Record<string, string>;
}
```

```typescript
// apps/runtime/src/repos/workflow-repo.ts  (MODIFIED — extend existing function with opts)
/**
 * Find a workflow version — state-agnostic (does NOT filter on state).
 * Extended to support an optional `excludeDeleted` filter so webhook-execute
 * callers can pin an inactive-but-not-deleted version while deployment code
 * paths that need any record (including deleted) retain their current behavior.
 *
 * Call sites:
 *  - `deployments.ts:532` — version-manifest validation (no opts, accepts all)
 *  - `workflows-execute.ts` — explicit ?version= pin (opts.excludeDeleted: true,
 *    matches engine's deleted:{$ne:true} filter at workflow-executions.ts:295)
 * Filter: { workflowId, version, tenantId, projectId } + optional `deleted: { $ne: true }`
 */
export async function findWorkflowVersion(
  workflowId: string,
  version: string,
  tenantId: string,
  projectId: string,
  opts?: { excludeDeleted?: boolean },
): Promise<Record<string, unknown> | null>;
```

### Module Boundaries

| Module                                                                | Responsibility                                                                              | Depends On                                                    |
| --------------------------------------------------------------------- | ------------------------------------------------------------------------------------------- | ------------------------------------------------------------- |
| `apps/runtime/src/routes/process-api.ts`                              | Owns shared `handleWorkflowExecute()` + legacy `/api/v1/process/:workflowId` + status-poll. | `workflow-repo`, `workflow-version-service`, `sync-execution` |
| `apps/runtime/src/routes/workflows-execute.ts` (NEW)                  | New short-URL route adapter: `?mode=` + `?version=` query → normalized handler args.        | `process-api.ts` (imports handler), `workflow-repo`           |
| `apps/runtime/src/repos/workflow-repo.ts`                             | Mongo read helpers with fixed filter semantics.                                             | `@agent-platform/database/models`                             |
| `apps/runtime/src/services/workflow-version-service.ts`               | Default-version resolution logic (semver-desc sort).                                        | `semver` (NEW prod dep), `@agent-platform/database/models`    |
| `apps/runtime/src/middleware/workflow-engine-proxy.ts`                | Proxy to engine; reads `?version=` query (Phase 2) + body; body wins on conflict.           | —                                                             |
| `apps/runtime/src/services/workflow/workflow-tool-executor.ts`        | Forwards `binding.workflowVersion` to engine body.                                          | `packages/compiler/ir/schema`                                 |
| `apps/workflow-engine/src/routes/workflow-executions.ts`              | Adds semver-string resolver branch + semver-desc default sort.                              | `semver` (NEW prod dep)                                       |
| `packages/compiler/src/platform/ir/schema.ts`                         | `WorkflowBindingIR` type — additive `workflowVersion?: string`.                             | —                                                             |
| `packages/shared/src/tools/dsl-property-parser.ts`                    | `WorkflowBindingLocal` interface + `buildWorkflowBindingFromProps()` parser.                | `WorkflowBindingIR`                                           |
| `packages/shared/src/tools/resolve-tool-implementations.ts`           | No code change — verify-only (already passes whole binding object at `:571`).               | —                                                             |
| `apps/studio/src/components/workflows/WorkflowDetailPage.tsx`         | Header two-badge render + optional inactive caption + viewed-version prop threading.        | `Badge` component, versions SWR endpoint                      |
| `apps/studio/src/components/workflows/triggers/WebhookQuickStart.tsx` | Emits short URL with `?version=<viewed>`.                                                   | `CodeSnippets`, viewed-version prop                           |
| `apps/studio/src/components/workflows/triggers/CodeSnippets.tsx`      | `buildCurl()` switched to short URL + `?version=<viewed>` in all 4 tabs.                    | —                                                             |
| `apps/studio/src/components/tools/WorkflowConfigForm.tsx`             | Persists selected `workflow_version` into DSL.                                              | DSL writer, version list SWR                                  |

---

## 2. File-Level Change Map

### New Files

| File                                                                               | Purpose                                                                           | LOC Estimate |
| ---------------------------------------------------------------------------------- | --------------------------------------------------------------------------------- | ------------ |
| `apps/runtime/src/routes/workflows-execute.ts`                                     | New short-URL route `/api/v1/workflows/:workflowId/execute` + status-poll adapter | ~180         |
| `apps/runtime/src/__tests__/workflows-execute.e2e.test.ts`                         | E2E: short URL auth, version pin, pin-miss, cross-project conceal, status-poll    | ~380         |
| `apps/runtime/src/__tests__/workflow-version-service-semver.integration.test.ts`   | Integration: semver-desc default resolution (runtime path)                        | ~140         |
| `apps/runtime/src/__tests__/workflow-tool-executor-versioning.integration.test.ts` | Integration: `workflowVersion` forwarded to engine body; undefined → absent       | ~160         |
| `apps/runtime/src/__tests__/workflow-engine-proxy-versioning.integration.test.ts`  | Integration: `?version=` query + body precedence                                  | ~100         |
| `apps/runtime/src/__tests__/semver-compare.test.ts`                                | Unit: pure semver comparator — runtime copy                                       | ~40          |
| `apps/workflow-engine/src/__tests__/semver-compare.test.ts`                        | Unit: pure semver comparator — engine copy (parity)                               | ~40          |
| `apps/workflow-engine/src/lib/semver-compare.ts`                                   | Engine helper `compareSemverDesc()` — 8 LOC duplicate of runtime copy per LD-5    | ~15          |
| `packages/shared/src/tools/__tests__/dsl-property-parser-workflow-version.test.ts` | Unit: DSL round-trip — `workflow_version` key parses to `workflowVersion` field   | ~50          |
| `apps/runtime/src/__tests__/workflow-tool-executor-versioning.e2e.test.ts`         | E2E-6: full tool-binding round-trip (runtime + engine, DI-mocked engine)          | ~180         |
| `apps/workflow-engine/src/__tests__/workflow-executions-semver.test.ts`            | Integration: engine semver-string resolver branch (Phase 3 focus)                 | ~180         |
| `apps/studio/e2e/workflows/workflow-webhook-versioning.spec.ts`                    | Playwright: two-badge header + Quick Start URL reflects viewed version            | ~160         |

### Modified Files

| File                                                                  | Change Description                                                                                                                                                 | Risk   |
| --------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------ | ------ |
| `apps/runtime/src/routes/process-api.ts`                              | Extract `handleWorkflowExecute()` as exported pure function; existing `POST /:workflowId` becomes a thin adapter that calls it.                                    | Medium |
| `apps/runtime/src/repos/workflow-repo.ts`                             | Extend existing `findWorkflowVersion()` at `:54-62` with optional `opts?: { excludeDeleted?: boolean }` parameter. Existing `deployments.ts:532` caller unchanged. | Low    |
| `apps/runtime/src/server.ts`                                          | Mount new `/api/v1/workflows` router behind `tenantAuthMiddleware`, mirroring the `/api/v1/process` pattern at `:780-785`.                                         | Low    |
| `apps/runtime/src/middleware/workflow-engine-proxy.ts`                | Read `?version=` query at `:242-281`; body-level `workflowVersion` wins on conflict; emit `proxy.version.conflict` warning.                                        | Low    |
| `apps/runtime/src/services/workflow-version-service.ts`               | `resolveDefaultVersion()` at `:695-733` switches from `.sort({ publishedAt: -1 })` to `find()` + client-side `semver.rcompare()`.                                  | Medium |
| `apps/runtime/src/services/workflow/workflow-tool-executor.ts`        | Inject `workflowVersion` into engine body at `:128-140` when `binding.workflowVersion` is set.                                                                     | Low    |
| `apps/runtime/package.json`                                           | Add `"semver": "^7.7.4"` to `dependencies`.                                                                                                                        | Low    |
| `apps/workflow-engine/package.json`                                   | Add `"semver": "^7.7.4"` to `dependencies`.                                                                                                                        | Low    |
| `apps/workflow-engine/src/routes/workflow-executions.ts`              | Add semver-string resolver branch at `:275-324`; switch default branch `findOne({state:'active'})` to `find().sort(semver-desc)`; emit miss metric.                | High   |
| `packages/compiler/src/platform/ir/schema.ts`                         | Add `workflowVersion?: string` to `WorkflowBindingIR` at `:891-902`.                                                                                               | Low    |
| `packages/shared/src/tools/dsl-property-parser.ts`                    | Add `workflowVersion?: string` to `WorkflowBindingLocal` at `:519-525`; read `props.workflow_version` in `buildWorkflowBindingFromProps()` at `:541`.              | Low    |
| `apps/studio/src/components/workflows/WorkflowDetailPage.tsx`         | Replace `activeVersionLabel` memo (`:96-106`) with `{ version, state }` pair; render two badges + optional caption at `:329-338`.                                  | Medium |
| `apps/studio/src/components/workflows/tabs/WorkflowTriggersTab.tsx`   | Accept `viewedVersion` + `viewedState` props; thread to `WebhookQuickStart`.                                                                                       | Low    |
| `apps/studio/src/components/workflows/triggers/WebhookQuickStart.tsx` | Accept `version`, `state` props; append `?version=<viewed>` to endpoint URL at `:68-70`; thread to `CodeSnippets`.                                                 | Medium |
| `apps/studio/src/components/workflows/triggers/CodeSnippets.tsx`      | Accept `version` prop; `buildCurl()` switches base to short URL `/api/v1/workflows/:wid/execute`; append `?version=<v>` in all tabs.                               | Medium |
| `apps/studio/src/components/tools/WorkflowConfigForm.tsx`             | Persist selected `workflow_version` into binding DSL.                                                                                                              | Low    |
| `apps/workflow-engine/src/__tests__/system-execute-version.test.ts`   | **EXTEND existing file** — add runtime↔engine parity assertion (keystone E2E-4, Phase 5).                                                                          | Medium |
| `docs/features/sub-features/workflow-triggers.md`                     | Update NG6 to cross-reference this sub-feature (Phase 6 post-impl).                                                                                                | Low    |

### Deleted Files

None.

### Verify-Only Sites (no code change)

| File                                                            | Reason                                                                                                                                                 |
| --------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `packages/shared/src/tools/resolve-tool-implementations.ts:571` | `workflow_binding: resolved.workflowBinding` already passes the whole binding object — new field flows naturally. Compiler lockstep verification only. |

---

## 3. Implementation Phases

CRITICAL: Each phase is independently deployable and testable. No phase leaves the system in a broken state.

### Phase 1 — Runtime Foundation: Shared Handler + Short URL

**Goal**: Add `/api/v1/workflows/:workflowId/execute` (POST) + status-poll (GET) mounted alongside legacy `/api/v1/process/:workflowId`. Extract shared handler. Zero behavior change for existing callers.

**Tasks**:

- **1.1** Extend the existing `findWorkflowVersion()` at `apps/runtime/src/repos/workflow-repo.ts:54-62` with an optional fifth parameter `opts?: { excludeDeleted?: boolean }`. When `opts.excludeDeleted === true`, add `deleted: { $ne: true }` to the filter. The existing caller at `deployments.ts:532` passes no opts — behavior preserved. The new short-URL route will call it with `{ excludeDeleted: true }`. Keep `findActiveWorkflowVersion()` at `:69-84` unchanged (legacy explicit-pin path continues to filter by state).
- **1.2** Extract `handleWorkflowExecute(deps, args)` pure function in `apps/runtime/src/routes/process-api.ts`. **Scope of extraction**: Step 4b (input-schema validation at current `:210-273`), Step 5 (executionId + `triggerMetadata` build at `:275-289`), Step 6 (`enginePayload` build at `:294-307`), Step 7 (engine fetch + sync-wait branching + timeout auto-promote + error handling at `:309-486`). The route handler becomes an adapter that does steps 1-4a (auth, body validation, workflow fetch by id+tenant, project-scope check, workflow-status check, version resolution) then calls `handleWorkflowExecute` with a pre-resolved `args` bundle. Input validation moves INTO the handler because it needs `args.workflow.inputSchema` + `args.input` which are already in the args signature. **Mode-to-engine derivation lives inside the handler**: the handler computes `webhookMode` and `webhookDelivery` from `args.mode` via the mapping in §1 LD-3 (sync → `{webhookMode:'sync', webhookDelivery: undefined}`; async → `{webhookMode:'async', webhookDelivery:'poll'}`; async_push → `{webhookMode:'async', webhookDelivery:'push'}`) — this replaces the current inline `isAsyncPush` + ternary at `:292-305`. **New enginePayload fields**: the handler MUST inject `workflowVersionId` and `workflowVersion` into `enginePayload` from `args.*` when defined (omit when undefined — engine Zod at `:97-106` accepts both as optional). Current `process-api.ts:300-307` does NOT include these fields; the existing legacy adapter will pass both as `undefined` (preserves current behavior), and the new short-URL adapter passes the resolved values. Validate the refactor is pure behavior-preserving by running existing `process-api.e2e.test.ts` + `process-api.integration.test.ts` + `process-api-auth.e2e.test.ts` — all pre-existing assertions must pass unchanged.
- **1.3** Create `apps/runtime/src/routes/workflows-execute.ts` that exports `createWorkflowsExecuteRouter(deps)`. Import `createLogger` from `@abl/compiler/platform` and bind to `const log = createLogger('workflows-execute')` (matches `process-api.ts:14,24` convention; CLAUDE.md forbids `console.log` in server code). Two routes:
  - `POST /:workflowId/execute` — query `?mode=` + `?version=`; body `{ input?, callbackUrl?, accessToken?, executionId? }`. Adapter:
    - (a) **Auth guard** — identical to `process-api.ts:94-113` (`tenantContext.authType === 'api_key'` → 401 else; `hasPermission('workflow:execute')` → 403 else).
    - (b) **Workflow fetch + scope check** — `findWorkflowByIdAndTenant` + `tenantContext.projectScope` inclusion → 404 `WORKFLOW_NOT_FOUND` on conceal; `workflow.status === 'active'` → 404 otherwise (mirrors `process-api.ts:129-163`).
    - (c) **Body + query Zod validation** — call `workflowsExecuteBodySchema.safeParse(req.body)` and `workflowsExecuteQuerySchema.safeParse(req.query)` (schemas defined in §1). On failure: 400 `INVALID_INPUT` (body) or 400 `INVALID_MODE` (query mode mismatch — Zod enum error). Mirrors the existing `process-api.ts:116-125` pattern.
    - (d) **Mode already normalized** by Zod enum → `sync | async | async_push` (default `'sync'`). The handler receives this directly via `args.mode`; it internally derives engine two-field enum per §1 LD-3 mapping.
    - (e) **async_push guardrail** — if `mode === 'async_push'` and body `callbackUrl` missing → HTTP 400 `MISSING_CALLBACK_URL`.
    - (f) **Version resolution** — if parsed `query.version` is defined, call `findWorkflowVersion(workflowId, version, tenantId, projectId, { excludeDeleted: true })` → 404 `WORKFLOW_VERSION_NOT_FOUND` on null (state-agnostic: inactive-but-not-deleted versions execute when pinned per FR-6). Else call `getWorkflowVersionService().resolveDefaultVersion(tenantId, projectId, workflowId)` → takes the returned `.version` doc.
    - (g) **Invoke handler** — `handleWorkflowExecute(deps, { workflow, workflowVersionId: versionDoc._id, workflowVersion: versionDoc.version, mode, input, callbackUrl, accessToken, executionId, tenantContext, res, startTime })`. The handler derives `webhookMode` + `webhookDelivery` internally.
  - `GET /:workflowId/executions/:executionId` — **status poll** (FR-21). Adapter does NOT reuse `handleWorkflowExecute` (that's POST-execute only). Steps: (a) auth guard, (b) `findWorkflowByIdAndTenant` + project-scope check, (c) mint internal JWT via `mintInternalJwt(tenantContext, jwtSecret)`, (d) `fetch(${engineBaseUrl}/api/v1/projects/${projectId}/workflows/${workflowId}/executions/${executionId}, { headers: { Authorization: 'Bearer ...' }, signal: AbortSignal.timeout(ENGINE_FETCH_TIMEOUT_MS) })`, (e) passthrough engine response body with runtime-matching envelope (`{success, data}` or `{success:false, error:{code, message}}`); map engine `EXECUTION_NOT_FOUND` to the same code.
- **1.4** Mount new router in `apps/runtime/src/server.ts` next to the process-api mount (after line 785): `app.use('/api/v1/workflows', tenantAuthMiddleware, workflowsExecuteRouter);`.
- **1.5** Write `apps/runtime/src/__tests__/workflows-execute.e2e.test.ts` covering E2E-1, E2E-2, E2E-7 (legacy still works), E2E-8 (status-poll), INT-6 (cross-project conceal). Use real Express + MongoMemoryServer + DI-injected engine mock per `process-api.e2e.test.ts` pattern (see that file's header comment; engine is an external-service boundary so mocking via DI is permitted per CLAUDE.md).
- **1.6** Run `pnpm build --filter=@abl/runtime` and `pnpm test --filter=@abl/runtime` — zero new failures, zero regressions in legacy `process-api.e2e.test.ts`.

**Files Touched**:

- `apps/runtime/src/repos/workflow-repo.ts` — add `findWorkflowVersion(..., { excludeDeleted: true })()`
- `apps/runtime/src/routes/process-api.ts` — extract `handleWorkflowExecute()`
- `apps/runtime/src/routes/workflows-execute.ts` — NEW
- `apps/runtime/src/server.ts` — mount new router
- `apps/runtime/src/__tests__/workflows-execute.e2e.test.ts` — NEW

**Exit Criteria**:

- [ ] `POST /api/v1/workflows/:wid/execute?mode=sync` returns HTTP 200 + `status: 'completed'` on happy path (E2E-1).
- [ ] `POST /api/v1/workflows/:wid/execute?version=v0.1.0` on inactive `v0.1.0` returns HTTP 200 and `WorkflowExecution.workflowVersion === 'v0.1.0'` (E2E-2).
- [ ] `POST /api/v1/workflows/:wid/execute?version=v99.99.99` returns HTTP 404 with `WORKFLOW_VERSION_NOT_FOUND` (E2E-2).
- [ ] `GET /api/v1/workflows/:wid/executions/:eid` returns status+output with tenant+project isolation; 401 without key, 404 cross-project (E2E-8).
- [ ] Legacy `POST /api/v1/process/:wid` E2E suite passes with zero changes.
- [ ] `pnpm build --filter=@abl/runtime` succeeds with 0 TypeScript errors.
- [ ] `pnpm test --filter=@abl/runtime` passes with new tests.

**Test Strategy**:

- E2E: real Express + MongoMemoryServer + DI-mocked engine (external-service boundary — permitted per CLAUDE.md)
- Integration: verify `handleWorkflowExecute()` pure-function returns correct `enginePayload` shape for each `{mode, version}` input combination
- No unit mocks of `@agent-platform/*` or `@abl/*`

**Rollback**: Revert the commit. The new router is additive — unmounting `/api/v1/workflows` is an no-op for legacy callers. The extracted handler change in `process-api.ts` is behavior-preserving, so revert replaces call-through with inline logic.

---

### Phase 2 — Runtime Proxy `?version=` Query Support

**Goal**: Let the long proxy URL (`/api/projects/:pid/workflows/:wid/executions/execute`) accept `?version=` from the query string, with body-level `workflowVersion` winning on conflict. Purely additive.

**Tasks**:

- **2.1** In `apps/runtime/src/middleware/workflow-engine-proxy.ts:242-281`, add reading of `req.query.version` (type-guarded to string). Precedence: if both body `workflowVersion` and query `version` present, body wins; emit `log.warn('proxy.version.conflict', { query, body })`.
- **2.2** Add `apps/runtime/src/__tests__/workflow-engine-proxy-versioning.integration.test.ts` integration test covering INT-2 (body wins + warning log).
- **2.3** Update the existing proxy test fixture to include a test case for `?version=` only (no body) — engine receives `workflowVersion` from query.

**Files Touched**:

- `apps/runtime/src/middleware/workflow-engine-proxy.ts`
- `apps/runtime/src/__tests__/workflow-engine-proxy-versioning.integration.test.ts` — NEW

**Exit Criteria**:

- [ ] Proxy forwards `workflowVersion: 'v0.1.0'` to engine when query `?version=v0.1.0` and no body field.
- [ ] Proxy forwards body value when both present; warning log captured in test output.
- [ ] No regression in existing proxy integration tests.
- [ ] `pnpm build --filter=@abl/runtime` succeeds.

**Test Strategy**:

- Integration: spawn real Express app with proxy middleware + mocked-via-DI engine fetch; assert request body seen by engine.

**Rollback**: Revert single commit. Query-read is additive; no caller relies on the query being ignored.

---

### Phase 3 — Compiler + Tool Binding Lockstep (Atomic)

**Goal**: Add optional `workflowVersion` field to `WorkflowBindingIR`, persist via DSL parser, forward from `WorkflowToolExecutor`, teach engine to resolve semver-string pins. **Atomic commit across 4 files** to avoid silent-drop per `packages/compiler/agents.md`.

**Tasks**:

- **3.1** `packages/compiler/src/platform/ir/schema.ts:891-902`: add `workflowVersion?: string` to `WorkflowBindingIR`. Export unchanged.
- **3.2** `packages/shared/src/tools/dsl-property-parser.ts:519-525`: add `workflowVersion?: string` to `WorkflowBindingLocal` interface. At `:541-586`, update `buildWorkflowBindingFromProps()` to read `props.workflow_version` (optional string) and include it in the returned object when present.
- **3.3** `packages/shared/src/tools/resolve-tool-implementations.ts:571` — verify only (no code change). Confirm `workflow_binding: resolved.workflowBinding` already passes the new field through.
- **3.4** `apps/workflow-engine/src/routes/workflow-executions.ts:275-324`: add NEW resolver branch between `requestedVersionId` and default. If `requestedVersion` (semver string) is present and `requestedVersionId` is absent, call `deps.workflowVersionModel.findOne({ workflowId, version: requestedVersion, tenantId, projectId, deleted: { $ne: true } })`. On null, respond `404 WORKFLOW_VERSION_NOT_FOUND` with a **static message** like `'Requested workflow version not found'` — do NOT interpolate the user-supplied semver string into the error message (security guideline: no user input in error bodies). On hit, set `effectiveVersionId`/`effectiveVersion`/`versionDef` from the doc. (The existing Zod schema at `:97-106` already accepts `workflowVersion`.)
- **3.5** `apps/runtime/src/services/workflow/workflow-tool-executor.ts:128-140`: in the body builder, add `...(binding.workflowVersion ? { workflowVersion: binding.workflowVersion } : {})` as a top-level body field. Do NOT put it inside `triggerMetadata`.
- **3.6** Add `apps/runtime/src/__tests__/workflow-tool-executor-versioning.integration.test.ts` (INT-5): binding with `workflowVersion: 'v0.1.0'` → captured engine request body contains the field; undefined → field absent.
- **3.7** Add `apps/workflow-engine/src/__tests__/workflow-executions-semver.test.ts` (engine-side): semver-string pin resolves to correct version doc + 404 on miss. (The default-branch semver-sort test lives in Phase 5.)
- **3.8** Add DSL round-trip parser test at `packages/shared/src/tools/__tests__/dsl-property-parser-workflow-version.test.ts` — asserts `workflow_version: "v0.1.0"` DSL prop → `WorkflowBindingLocal.workflowVersion === 'v0.1.0'` and that missing key → `undefined`. (Semver comparator unit test lives in Phase 5 Task 5.6.)
- **3.9** Add **E2E-6 scenario** — `apps/runtime/src/__tests__/workflow-tool-executor-versioning.e2e.test.ts`: full agent-tool-binding round-trip against real MongoMemoryServer + DI-mocked engine. Seed a binding with `workflowVersion: 'v0.1.0'` via direct `WorkflowToolExecutor.registerBinding()`; call `execute()`; assert engine request body contains `workflowVersion: 'v0.1.0'`. Then re-register the binding without `workflowVersion`; call again; assert body omits the field. This covers E2E-6 (FR-10, FR-11, FR-12 end-to-end) without requiring a live Studio-save step, which is tested separately in Phase 4's Playwright suite (Task 4.8) for the DSL persistence half.

**Files Touched** (single atomic commit):

- `packages/compiler/src/platform/ir/schema.ts`
- `packages/shared/src/tools/dsl-property-parser.ts`
- `apps/workflow-engine/src/routes/workflow-executions.ts`
- `apps/runtime/src/services/workflow/workflow-tool-executor.ts`
- `apps/runtime/src/__tests__/workflow-tool-executor-versioning.integration.test.ts` — NEW
- `apps/runtime/src/__tests__/workflow-tool-executor-versioning.e2e.test.ts` — NEW (E2E-6)
- `apps/workflow-engine/src/__tests__/workflow-executions-semver.test.ts` — NEW
- `packages/shared/src/tools/__tests__/dsl-property-parser-workflow-version.test.ts` — NEW (DSL round-trip)

**Exit Criteria**:

- [ ] DSL containing `workflow_version: "v0.1.0"` round-trips through parser → `WorkflowBindingLocal.workflowVersion === 'v0.1.0'`.
- [ ] DSL without `workflow_version` → `WorkflowBindingLocal.workflowVersion === undefined`.
- [ ] `WorkflowToolExecutor.execute()` with binding `{workflowVersion: 'v0.1.0'}` → engine body `.workflowVersion === 'v0.1.0'`.
- [ ] Engine `POST .../executions/execute` body `{workflowVersion: 'v0.1.0'}` (no `workflowVersionId`) → resolves to that version doc; `workflowVersion: 'v9.9.9'` → 404 `WORKFLOW_VERSION_NOT_FOUND`.
- [ ] `pnpm build` on all affected packages succeeds (compiler, shared, runtime, workflow-engine).
- [ ] Commit-scope guard passes: 7 files, 4 packages — under 40-file limit, but **above 3-package limit → REQUIRES justification note in commit message** (compiler-lockstep atomicity per `packages/compiler/agents.md`).

**Test Strategy**:

- Integration: executor with a fake HTTP interceptor; engine semver resolver with seeded MongoMemoryServer
- No mocks of internal codebase modules

**Rollback**: Revert the single atomic commit. All changes are additive optional fields and a new engine resolver branch — reverting restores prior behavior (tool bindings without version, engine ignoring semver strings in resolution).

---

### Phase 4 — Studio UI (Badges + Short URL + Binding Form)

**Goal**: Render `[version] [state]` two-badge pair beside the workflow header; drop `warning` variant for draft; thread viewed-version through `WebhookQuickStart` + `CodeSnippets`; persist `workflow_version` in `WorkflowConfigForm`. All additive.

**Tasks**:

- **4.1** In `apps/studio/src/components/workflows/WorkflowDetailPage.tsx:96-106`, replace the `activeVersionLabel` memo returning `string | null` with a new memo returning `{ version: string; state: 'active' | 'inactive' | 'draft'; activeSemverForInactive?: string } | null`. For drafts → `{ version: 'draft', state: 'active' }` (drafts are always active per `workflow-version-service.ts:522-527`). For inactive-viewed → compute `activeSemverForInactive` from the versions list (the highest-semver active one).
- **4.2** In `WorkflowDetailPage.tsx:329-338`, render two badges + optional caption + FR-17 tooltip. Import `const t = useTranslations('workflows.versions')` (new i18n wiring — `WorkflowDetailPage` has no `useTranslations` call today; verify SSR compatibility during implementation):
  ```tsx
  <Badge
    variant="neutral"
    testid="workflow-version-badge"
    onClick={() => setTab('versions')}
    aria-label={t('versionBadgeLabel', { version: viewed.version })}
  >
    {viewed.version}
  </Badge>
  <Badge
    variant={viewed.state === 'active' ? 'success' : 'muted'}
    testid="workflow-state-badge"
    title={viewed.state === 'active' ? t('tooltip.active') : t('tooltip.inactive')}
  >
    {t(`state.${viewed.state}`)}
  </Badge>
  {viewed.state === 'inactive' && viewed.activeSemverForInactive && (
    <span className="text-xs text-muted ml-2" data-testid="served-via-caption">
      {t('servedVia', { version: viewed.activeSemverForInactive })}
    </span>
  )}
  ```
  The `title` attribute on the state badge satisfies FR-17's tooltip requirement. Drop `variant === 'draft' ? 'warning' : 'accent'` ternary entirely.
- **4.3** Thread `viewedVersion` + `viewedState` (derived from the same memo) through `WorkflowTriggersTab` → `WebhookQuickStart`. Source of truth: Studio's existing viewed-version state (canvas store or URL param; confirm via `WorkflowTriggersTab` prop inspection during implementation).
- **4.4** `apps/studio/src/components/workflows/triggers/WebhookQuickStart.tsx:68-70` **already emits the short-URL form** (`/api/v1/workflows/:id/execute`). The only change needed is appending `?version=<viewed>` when the viewed version is non-null: update the fallback branch to `${runtimeBaseUrl}/api/v1/workflows/${encodeURIComponent(workflow.id)}/execute${version ? `?version=${encodeURIComponent(version)}` : ''}`. Accept `version` + `state` props. Pass `version` prop down to `CodeSnippets`.
- **4.5** In `apps/studio/src/components/workflows/triggers/CodeSnippets.tsx`, modify `buildCurl()` at `:37-91` (currently emits the long proxy URL `${baseUrl}/api/projects/${encodedProjId}/workflows/${encodedWfId}/executions/execute` at `:48`):
  - Replace base URL with `${baseUrl}/api/v1/workflows/${encodedWfId}/execute` (drop `/api/projects/:pid/...`).
  - Accept a new `version?: string` prop on `CodeSnippets`; append `?version=<encoded>` when set, merging with existing `?mode=async` via `&` separator (query-string order: `?mode=async&version=v0.2.0`).
  - For `async_poll` tab's second curl (status poll at current `:88`), use `${baseUrl}/api/v1/workflows/${encodedWfId}/executions/{executionId}` — **NO version param** (execution is already version-pinned at dispatch).
  - **Note**: `projectId` prop (currently used in `buildCurl()` at `:46`) becomes vestigial for URL generation after this change. Keep the prop wired (it may be used for other purposes inside `CodeSnippets` today — audit during implementation) but mark the unused URL-builder path with a brief inline comment if the prop is retained elsewhere.
- **4.6** In `apps/studio/src/components/tools/WorkflowConfigForm.tsx`, wire the existing version dropdown's selected value into the DSL writer for the `workflow_version` property. Default "Latest active (auto-resolve)" → omit the property from DSL. Pinned version → write `workflow_version: "<semver>"`.
- **4.7** **i18n plan** — add new translation keys to `packages/i18n/locales/en/studio.json` (confirm exact file path during implementation):
  - `workflows.versions.state.active` → `"active"`
  - `workflows.versions.state.inactive` → `"inactive"`
  - `workflows.versions.state.draft` → `"draft"`
  - `workflows.versions.servedVia` → `"served via {version}"` (ICU MessageFormat)
  - `workflows.versions.tooltip.active` → `"This version is active — it serves default webhook calls"` (FR-17)
  - `workflows.versions.tooltip.inactive` → `"This version is inactive — webhooks without explicit pin resolve to the latest active"` (FR-17)
  - `workflows.versions.versionBadgeLabel` → `"Viewing version {version} — click to go to Versions tab"` (aria-label for the clickable version badge)
  - Badge label + tooltip wiring: `WorkflowDetailPage.tsx` has no `useTranslations` call today — introduce `const t = useTranslations('workflows.versions')` in the header block. All user-visible strings go through `t()`.
  - Visual-only tokens like `text-muted` are already semantic tokens from the design system (confirmed existing usage at `WorkflowDetailPage.tsx:323,342,345`) — no design-token replacement needed.
- **4.8** Write `apps/studio/e2e/workflows/workflow-webhook-versioning.spec.ts` Playwright test covering E2E-5 (badges + Quick Start URL + viewed-version switch). Follow `apps/studio/e2e/workflows/agents.md` rules.

**Files Touched**:

- `apps/studio/src/components/workflows/WorkflowDetailPage.tsx`
- `apps/studio/src/components/workflows/tabs/WorkflowTriggersTab.tsx`
- `apps/studio/src/components/workflows/triggers/WebhookQuickStart.tsx`
- `apps/studio/src/components/workflows/triggers/CodeSnippets.tsx`
- `apps/studio/src/components/tools/WorkflowConfigForm.tsx`
- `apps/studio/e2e/workflows/workflow-webhook-versioning.spec.ts` — NEW

**Exit Criteria**:

- [ ] Viewing an active `v0.2.0` workflow → header shows `[v0.2.0] [active]`, no caption, `data-testid="workflow-version-badge"` + `data-testid="workflow-state-badge"` both present.
- [ ] Viewing an inactive `v0.1.5` workflow → header shows `[v0.1.5] [inactive]` + caption `served via v0.2.0`.
- [ ] Viewing `draft` → header shows `[draft]` only (single badge; state pill suppressed because state applies only to published versions — superseded 2026-04-19).
- [ ] Quick Start URL includes `?version=v0.2.0` when viewing `v0.2.0`; `?version=draft` when viewing draft.
- [ ] `CodeSnippets` curl in all 4 tabs uses `/api/v1/workflows/:wid/execute` (never `/api/projects/...`).
- [ ] Async-poll curl's status URL uses `/api/v1/workflows/:wid/executions/{executionId}` (version-less).
- [ ] `WorkflowConfigForm` saves binding with `workflow_version: "v0.1.0"` when pinned; omits the key when "Latest active".
- [ ] Playwright E2E `workflow-webhook-versioning.spec.ts` passes.
- [ ] `pnpm build --filter=@abl/studio` succeeds.

**Test Strategy**:

- Playwright E2E against real Studio Next.js dev server; real runtime API mocked at the network layer only (external to Studio codebase).
- No `vi.mock` of Studio components.

**Rollback**: Revert commit. All changes are UI-only; no data or URL contracts persisted.

---

### Phase 5 — Semver-Sort Atomic (Behavior Change — Runtime + Engine)

**Goal**: Replace non-deterministic default resolution with semver-desc client-side sort in both runtime (`resolveDefaultVersion`) and engine (default branch). Ship as a **single coordinated release** across both services.

**Tasks**:

- **5.1** Add `"semver": "^7.7.4"` to `apps/runtime/package.json` dependencies. Run `pnpm install` at repo root.
- **5.2** Add `"semver": "^7.7.4"` to `apps/workflow-engine/package.json` dependencies. Run `pnpm install`.
- **5.3** Extract a pure helper `compareSemverDesc(a: string, b: string): number` — returns negative when `a < b` by semver (so `arr.sort(compareSemverDesc)` gives descending). Strip leading `v` before `semver.rcompare()`. Treat `'draft'` as sorting LAST regardless of other inputs. **Placement (pinned)**: runtime helper exported from `apps/runtime/src/services/workflow-version-service.ts` (co-located with `resolveDefaultVersion`); engine helper in a NEW file `apps/workflow-engine/src/lib/semver-compare.ts` (create the `lib/` dir if absent). Both copies are 8 lines; LD-5 justifies the duplication (per-app prod dep, only 2 consumers, no shared-kernel propagation cost).
- **5.4** In `apps/runtime/src/services/workflow-version-service.ts:695-733`, replace the `.findOne(... ).sort({ publishedAt: -1 }).lean()` call with:
  ```ts
  const candidates = await WorkflowVersion.find({
    workflowId,
    tenantId,
    projectId,
    state: 'active',
    deleted: false,
    version: { $ne: 'draft' },
  }).lean();
  candidates.sort((a, b) => compareSemverDesc(a.version, b.version));
  const activeVersion = candidates[0] ?? null;
  ```
  Preserve the existing draft-fallback branch + `workflow.version.resolution.miss` metric.
- **5.5** In `apps/workflow-engine/src/routes/workflow-executions.ts:309-324` (the default branch), replace `findOne({ workflowId, tenantId, projectId, state: 'active', deleted: { $ne: true } })` with an equivalent `find(filter).lean()` + client-side `compareSemverDesc` sort selecting the first. **The new `find()` filter MUST preserve `{ workflowId, tenantId, projectId, state: 'active', deleted: { $ne: true }, version: { $ne: 'draft' } }`** — the tenantId + projectId isolation is non-negotiable and identical to the current `:311-317` filter. **Emit `workflow.version.resolution.miss` log** (parity with runtime `workflow-version-service.ts:722-727`) when no active non-draft found and falling through to draft (today the engine silently falls through — this is a new observability addition).
- **5.6** Write `apps/runtime/src/__tests__/semver-compare.test.ts` unit test (Scenario 4a) — exercises the runtime copy of `compareSemverDesc`:
  - `v0.10.0 > v0.9.0` (descending sort → `v0.10.0` first)
  - `v1.0.0 > v0.99.99`
  - `draft` sorts LAST always
  - `v0.2.0` (leading `v`) parses correctly
    Also write `apps/workflow-engine/src/__tests__/semver-compare.test.ts` unit test — identical cases against the engine copy. Two copies of the test are deliberate: they document that both services carry the same comparator semantics.
- **5.7** Write `apps/runtime/src/__tests__/workflow-version-service-semver.integration.test.ts` (Scenario 4b, INT-3): seed 3 active versions (`v0.2.0`, `v0.9.0`, `v0.10.0` with `v0.9.0` most recently published); call `resolveDefaultVersion()` → assert returns `v0.10.0`. Deactivate `v0.10.0` → returns `v0.9.0`. Deactivate all → draft fallback + miss metric emitted.
- **5.8** Extend `apps/workflow-engine/src/__tests__/workflow-executions-semver.test.ts` (from Phase 3) with default-branch semver-sort assertions (Scenario 4, engine path).
- **5.9** **EXTEND** existing `apps/workflow-engine/src/__tests__/system-execute-version.test.ts` (keystone Scenario 5, E2E-4 parity): add a multi-active-version fixture test where both the runtime's `resolveDefaultVersion()` and the engine's default branch are exercised against the same MongoMemoryServer dataset; assert both return the **same** version doc. This file already exists (see `trigger-version-frozen-flow.test.ts` and the existing `system-execute-version.test.ts`) — extend it; do NOT create a new file. This is the **single most important test in the suite** — if it fails, the feature's primary reliability claim breaks.
- **5.10** Run full repo `pnpm build && pnpm test` — zero regressions.

**Files Touched** (single atomic commit — runtime + engine):

- `apps/runtime/package.json`
- `apps/workflow-engine/package.json`
- `pnpm-lock.yaml` (auto-updated)
- `apps/runtime/src/services/workflow-version-service.ts`
- `apps/workflow-engine/src/routes/workflow-executions.ts`
- `apps/runtime/src/__tests__/workflow-version-service-semver.integration.test.ts` — NEW
- `apps/runtime/src/__tests__/semver-compare.test.ts` — NEW (runtime-local per LD-5; co-located with the helper in `workflow-version-service.ts`)
- `apps/workflow-engine/src/__tests__/workflow-executions-semver.test.ts` — EXTEND (default-branch sort case added)
- `apps/workflow-engine/src/__tests__/system-execute-version.test.ts` — **EXTEND existing file** (add runtime↔engine parity case)

**Exit Criteria**:

- [ ] Semver comparator unit test passes: `v0.10.0 > v0.9.0`, `v1.0.0 > v0.99.99`, `draft` last.
- [ ] Runtime `resolveDefaultVersion()` with seeded 3-active-version fixture returns highest semver (not latest published).
- [ ] Engine default-branch seeded with same fixture returns the **same** version as runtime (parity assertion in `system-execute-version.test.ts` — keystone).
- [ ] Draft-fallback path emits `workflow.version.resolution.miss` metric in both services.
- [ ] All existing runtime + engine tests pass (no regression).
- [ ] Commit-scope guard passes: ~9 files, 2 packages (runtime + workflow-engine) — within limits.
- [ ] `pnpm install` produces a clean lockfile — no version drift.

**Test Strategy**:

- Unit: pure semver comparator — zero dependencies
- Integration: seeded MongoMemoryServer, real service classes, no mocks of codebase modules
- E2E parity (Scenario 5): both services running, assert same resolution

**Rollback**: Revert the atomic commit. Both services revert together to `publishedAt`-sort (runtime) / no-sort (engine) behavior — restores the pre-feature bug class, but no data corruption. Per-workflow mitigation (deactivate an unwanted version) remains available.

**Deploy coordination** (operational note, not a code task): Per `apps/workflow-engine/agents.md`, the engine runs in Docker. The Helm chart lives in `abl-platform-deploy`. Engine-first deploy is safe (semver-sort is a no-op when no caller sends mixed-active fixtures that today differ by publish-order); runtime follows within the same release window. Feature flag explicitly NOT used (per HLD Concern #11 + feature spec §11: sort change is a bug-class fix, not a feature toggle).

---

### Phase 6 — Observability + Doc Sync

**Goal**: Wire `version` field into logs, add `proxy.version.conflict` warning emitter verification, run `/post-impl-sync` to update doc status fields.

**Tasks**:

- **6.1** In `apps/runtime/src/routes/process-api.ts` (inside `handleWorkflowExecute` extracted in Phase 1), add `version: args.workflowVersion ?? null` to the log metadata for `Async execution started` (at current `:345-350` site) and `Sync execution completed` (at current `:434-439` site).
- **6.2** Verify `proxy.version.conflict` warning added in Phase 2 appears in test output; add an observability-check assertion to the Phase 2 test file if not already present.
- **6.3** Run `/post-impl-sync workflow-webhook-versioning`:
  - Update feature spec Section 17 "Required Test Coverage" status column from `NOT TESTED` → `PASS` for each scenario verified (FR-1 through FR-21).
  - Update feature spec Status from `PLANNED` → `ALPHA` (per CLAUDE.md Feature Status Lifecycle — criteria: first deterministic E2E regression in place, no observed production incidents).
  - Update testing guide coverage matrix status column.
  - Update `docs/features/sub-features/workflow-triggers.md` NG6 to cross-reference this sub-feature (FR-20).
- **6.4** Update package `agents.md` files (per CLAUDE.md package-learnings rules):
  - `apps/runtime/agents.md` — add entry for shared `handleWorkflowExecute()` helper + `workflows-execute.ts` route file + `findWorkflowVersion({excludeDeleted})` opts extension.
  - `apps/workflow-engine/agents.md` — add entry for semver-string resolver branch + semver-desc default sort + new `lib/semver-compare.ts` helper.
  - `packages/compiler/agents.md` — add entry documenting this feature's successful 3-site lockstep execution as an exemplar.
  - `packages/shared/agents.md` — add entry for `WorkflowBindingLocal.workflowVersion` + `buildWorkflowBindingFromProps` `workflow_version` prop (the 4th lockstep site of the compiler chain).
  - `apps/studio/agents.md` — add entry for viewed-version prop threading pattern + `WorkflowDetailPage` i18n introduction.

**Files Touched**:

- `apps/runtime/src/routes/process-api.ts` — log field additions
- `docs/features/sub-features/workflow-webhook-versioning.md` — status, coverage
- `docs/testing/sub-features/workflow-webhook-versioning.md` — status
- `docs/features/sub-features/workflow-triggers.md` — NG6 cross-ref
- `apps/runtime/agents.md`
- `apps/workflow-engine/agents.md`
- `packages/compiler/agents.md`
- `apps/studio/agents.md`

**Exit Criteria**:

- [ ] `Async execution started` log line in runtime test output contains `version: "v0.1.0"` (or `null` for unpinned).
- [ ] `/post-impl-sync` phase-auditor round returns APPROVED.
- [ ] Feature spec Status = `ALPHA`.
- [ ] All four `agents.md` files updated with new learnings.

**Test Strategy**:

- Manual log inspection during test runs
- `/post-impl-sync` skill validates doc consistency
- No new test suites

**Rollback**: Revert commit. Doc sync is reversible; log fields are additive (downstream log consumers tolerate absent fields).

---

## 4. Wiring Checklist

CRITICAL: Every new component must be wired into its callers. This section prevents the #1 agent failure mode: writing code that nothing calls.

### Runtime (`apps/runtime/`)

- [ ] `createWorkflowsExecuteRouter(deps)` factory **exported** from `src/routes/workflows-execute.ts`.
- [ ] `createWorkflowsExecuteRouter` **imported and mounted** in `src/server.ts` via `app.use('/api/v1/workflows', tenantAuthMiddleware, workflowsExecuteRouter)` (next to `/api/v1/process` mount at current line 785).
- [ ] `handleWorkflowExecute` **exported** from `src/routes/process-api.ts` (named export).
- [ ] `handleWorkflowExecute` **imported** by `src/routes/workflows-execute.ts`.
- [ ] Existing `findWorkflowVersion` signature **extended** with `opts?: { excludeDeleted?: boolean }` in `src/repos/workflow-repo.ts:54-62`.
- [ ] `findWorkflowVersion(..., { excludeDeleted: true })` **imported and called** by `src/routes/workflows-execute.ts` in the explicit-pin branch.
- [ ] Existing caller `deployments.ts:532` passes no opts — behavior preserved.
- [ ] `workflowsExecuteBodySchema` + `workflowsExecuteQuerySchema` **defined and consumed via `.safeParse()`** in `workflows-execute.ts` (not just documented).
- [ ] `workflow-engine-proxy.ts` `?version=` read wired to forward path (Phase 2) — verified by integration test INT-2.
- [ ] `WorkflowToolExecutor.execute()` body includes `workflowVersion` when `binding.workflowVersion` set (Phase 3) — verified by INT-5.
- [ ] `resolveDefaultVersion()` semver-sort update (Phase 5) is the ONLY caller change — no downstream signature change.

### Workflow Engine (`apps/workflow-engine/`)

- [ ] Semver-string resolver branch (Phase 3) added between `requestedVersionId` branch and default branch at `src/routes/workflow-executions.ts:275-324`.
- [ ] Default-branch semver-desc sort (Phase 5) replaces the existing `findOne({state:'active'})` call.
- [ ] `workflow.version.resolution.miss` log emitter added to default-fallback path (parity with runtime).
- [ ] Zod schema at `:97-106` **already accepts** `workflowVersion` — no schema edit needed (verified-by-reading during implementation).

### Compiler / Shared (`packages/`)

- [ ] `WorkflowBindingIR.workflowVersion?` field **added** to `packages/compiler/src/platform/ir/schema.ts:891-902`.
- [ ] `WorkflowBindingLocal.workflowVersion?` field **added** to `packages/shared/src/tools/dsl-property-parser.ts:519-525`.
- [ ] `buildWorkflowBindingFromProps()` at `:541-586` **reads** `props.workflow_version` and **includes** it in return object.
- [ ] `resolve-tool-implementations.ts:571` verified passing whole binding object — no edit.
- [ ] No new package exports — all fields are on existing interfaces.

### Studio (`apps/studio/`)

- [ ] `WorkflowDetailPage` memo split into `{version, state, activeSemverForInactive?}`.
- [ ] Two `<Badge>` components + optional caption rendered in header — replaces single-badge render at `:329-338`.
- [ ] `viewedVersion` + `viewedState` props threaded through `WorkflowTriggersTab` → `WebhookQuickStart` → `CodeSnippets`.
- [ ] `WebhookQuickStart` endpoint URL builder uses new short URL + `?version=`.
- [ ] `CodeSnippets.buildCurl()` base URL changed to short URL; all 4 tabs emit `?version=`; async-poll status URL version-less.
- [ ] `WorkflowConfigForm` onSave writes `workflow_version` DSL property when version selected (and omits when "Latest active").
- [ ] `useTranslations('workflows.versions')` **imported** in `WorkflowDetailPage.tsx` (new i18n hook binding).
- [ ] New i18n keys added to `packages/i18n/locales/en/studio.json`: `state.{active,inactive,draft}`, `servedVia`, `tooltip.{active,inactive}`, `versionBadgeLabel`.
- [ ] FR-17 tooltip `title` **prop wired** on state badge; `onClick` wired on version badge.
- [ ] Playwright E2E covers all three surfaces (header, Quick Start, binding form).

### Tests

- [ ] `workflows-execute.e2e.test.ts` mounted via factory — no test-only duplication of router setup.
- [ ] `system-execute-version.test.ts` (keystone) **extended** (not created) with runtime↔engine parity case — Phase 5 not complete until this assertion passes.
- [ ] E2E-8 (status-poll) wired in Phase 1; referenced by coverage matrix at FR-21.
- [ ] E2E-6 (agent tool binding round-trip) wired in Phase 3 via `workflow-tool-executor-versioning.e2e.test.ts` (full-stack against DI-mocked engine).
- [ ] Engine-copy `semver-compare.test.ts` exists at `apps/workflow-engine/src/__tests__/` (documents parity with runtime copy).

---

## 5. Cross-Phase Concerns

### Database Migrations

**None**. All changes are query-pattern changes on existing `WorkflowVersion` documents. `WorkflowBindingIR` is in-memory IR; no persisted schema migration. Existing indexes at `packages/database/src/models/workflow-version.model.ts:122-134` already cover the new semver-resolution query:

- `{ tenantId: 1, projectId: 1, workflowId: 1, state: 1, deleted: 1, publishedAt: -1 }` covers the `find({state:'active'})` shape (the `publishedAt` suffix is unused by the new sort but stays for the legacy path during transition).

### Feature Flags

**None** (per HLD Concern #11 + feature spec §11). The semver-sort is a deterministic bug-class fix, not a feature toggle. Rollback is via revert + redeploy; per-workflow mitigation is deactivate-unwanted-version.

### Configuration Changes

**None** (per feature spec §11). Existing env vars (`PROCESS_API_SYNC_TIMEOUT_MS`, `WORKFLOW_PROXY_SYNC_TIMEOUT_MS`) continue to apply.

### Dockerfile / Package.json sync

Per CLAUDE.md "Dockerfile package.json sync" rule: Phase 5 adds `semver` to two apps but does NOT add any new `packages/*` workspace — so no Dockerfile `COPY` changes needed. Verify `pnpm install` + `pnpm build` succeeds cleanly in both `apps/runtime/Dockerfile` and `apps/workflow-engine/Dockerfile` contexts.

### Compiler Lockstep Scope Note (Phase 3)

Phase 3's atomic commit touches **4 packages** (compiler, shared, workflow-engine, runtime), which exceeds CLAUDE.md's commit-scope guard of **max 3 packages per commit**. This is a deliberate exception required by `packages/compiler/agents.md`'s lockstep rule — the feature cannot ship safely if these 4 changes land in separate commits (silent property drop). Document the exception in the commit message: `[ABLP-2] feat(workflow-binding): add workflowVersion to WorkflowBindingIR + lockstep (compiler, shared, runtime, engine). Scope exception: DSL lockstep atomicity required per packages/compiler/agents.md.`

---

## 6. Acceptance Criteria (Whole Feature)

- [ ] All 6 phases' exit criteria met.
- [ ] All 8 E2E scenarios (E2E-1 through E2E-8) from the test spec pass against real infrastructure.
- [ ] All 6 integration scenarios (INT-1 through INT-6) from the test spec pass.
- [ ] Keystone test E2E-4 (`system-execute-version.test.ts`) asserts runtime ↔ engine parity and passes.
- [ ] `pnpm build && pnpm test` at repo root: zero regressions.
- [ ] Commit-scope guard: no single commit exceeds 40 non-doc files; Phase 3 scope-exception justified in commit message.
- [ ] Feature spec Status updated from `PLANNED` → `ALPHA`.
- [ ] Test spec coverage matrix updated: `NOT TESTED` → `PASS` across all FRs.
- [ ] `docs/features/sub-features/workflow-triggers.md` NG6 cross-references this sub-feature.
- [ ] 5 `agents.md` files (runtime, workflow-engine, compiler, shared, studio) updated with learnings.
- [ ] No new unconcealed 401/403 errors in production logs during 48h post-deploy observation window.
- [ ] `workflow.version.resolution.miss` metric baseline matches pre-deploy (indicates draft-fallback rate unchanged — confirms no regression in the happy path).

---

## 7. Open Questions

1. **Pre-release semver handling**: `semver` library's `rcompare` handles `v0.2.0-beta` correctly, but `workflow-version-service.ts:508-511` `nextVersion()` never produces pre-release identifiers. No action in this feature; revisit if product introduces pre-release publishing.
2. **Path-segment URL alternative** (`/api/v1/workflows/:id/versions/:v/execute`): Deferred per HLD §10 Open Question 2. The query-param form ships first; path segment can be added non-breakingly later.
3. **"Copy versionless URL" button in Studio**: Not in scope. Studio always pins the viewed version per US-1.
4. **Engine's body-level `workflowVersion` pre-feature consumers**: HLD §10 Open Question 5 — confirm during Phase 3 implementation via `rg 'workflowVersion' apps/workflow-engine/src` that no existing test/consumer relies on the field being silently ignored. Expected: 0 matches outside Zod schema + new resolver.
5. **Phase 5 deploy order** (engine-first vs runtime-first): Target engine-first per HLD §12 (safe no-op for pre-deploy runtime callers), but confirm with deploy-repo Helm chart review before cutting release. **Owner**: Runtime Team lead (coordinate with DevOps for Helm chart rollout window). Non-blocking for LLD approval.

---

## 8. References

- Feature spec: [`docs/features/sub-features/workflow-webhook-versioning.md`](../features/sub-features/workflow-webhook-versioning.md)
- HLD: [`docs/specs/workflow-webhook-versioning.hld.md`](../specs/workflow-webhook-versioning.hld.md)
- Test spec: [`docs/testing/sub-features/workflow-webhook-versioning.md`](../testing/sub-features/workflow-webhook-versioning.md)
- Related plans:
  - [`docs/plans/2026-04-14-workflow-versioning-impl-plan.md`](./2026-04-14-workflow-versioning-impl-plan.md) — `WorkflowVersion` state machine + `resolveDefaultVersion()` origin
  - [`docs/plans/2026-04-13-workflow-as-tool-impl-plan.md`](./2026-04-13-workflow-as-tool-impl-plan.md) — `WorkflowBindingIR` + `WorkflowToolExecutor` origin
- Key code references (verified against HEAD on 2026-04-18):
  - `apps/runtime/src/routes/process-api.ts:60-69` — `mintInternalJwt()` (reused by new route)
  - `apps/runtime/src/routes/process-api.ts:80-486` — `createProcessApiRouter()` + full handler body (handler extraction source)
  - `apps/runtime/src/repos/workflow-repo.ts:34-45` — `findWorkflowByIdAndTenant` (reused)
  - `apps/runtime/src/repos/workflow-repo.ts:69-84` — `findActiveWorkflowVersion` (adjacent to new `findWorkflowVersion(..., { excludeDeleted: true })`)
  - `apps/runtime/src/server.ts:780-785` — mount pattern for `/api/v1/process` (template for new mount)
  - `apps/runtime/src/services/workflow-version-service.ts:695-733` — `resolveDefaultVersion` (Phase 5 change site)
  - `apps/runtime/src/middleware/workflow-engine-proxy.ts:242-281` — proxy body/query shape (Phase 2 change site)
  - `apps/runtime/src/services/workflow/workflow-tool-executor.ts:128-141` — executor body builder (Phase 3 change site)
  - `apps/workflow-engine/src/routes/workflow-executions.ts:97-106` — Zod schema (already accepts `workflowVersion`)
  - `apps/workflow-engine/src/routes/workflow-executions.ts:275-324` — resolution logic (Phase 3 + Phase 5 change sites)
  - `packages/compiler/src/platform/ir/schema.ts:891-902` — `WorkflowBindingIR` (Phase 3)
  - `packages/shared/src/tools/dsl-property-parser.ts:519-586` — `WorkflowBindingLocal` + parser (Phase 3)
  - `packages/shared/src/tools/resolve-tool-implementations.ts:571` — verify-only propagation site
  - `apps/studio/src/components/workflows/WorkflowDetailPage.tsx:96-106,329-338` — header + memo (Phase 4)
  - `apps/studio/src/components/workflows/triggers/WebhookQuickStart.tsx:43-70` — URL builder (Phase 4)
  - `apps/studio/src/components/workflows/triggers/CodeSnippets.tsx:37-91` — curl builder (Phase 4)
- Repo guidance:
  - `packages/compiler/agents.md` — 3-site DSL lockstep rule
  - `apps/workflow-engine/agents.md` — Docker deploy coordination
  - CLAUDE.md — commit-scope guard, test-architecture rules, platform mock prohibition

# ABLP-612: Studio to Runtime Action Handler E2E Hardening

**Status**: IMPLEMENTED, WITH 2026-05-03 FOLLOW-UP HARDENING
**Date**: 2026-05-02 / updated 2026-05-03
**Jira**: ABLP-612

## 1. Design Contract

This plan closes the remaining end-to-end gaps after adding richer `ON_ACTION`
runtime actions. The target contract is:

1. Studio may save draft DSL with diagnostics, but runtime execution must not
   silently run drafts with validation errors.
2. Every runtime ProjectAgent read must remain tenant scoped through both the
   parent project lookup and the agent lookup/mutation.
3. SDK/channel action submits must preserve the full action envelope:
   `actionId`, scalar `value`, structured `formData`, source channel, and a
   render correlation token.
4. Stale/replayed action submits must not bind to a later waiting step with the
   same action id.
5. Diagnostics and source metadata must be generated consistently across DSL
   write paths or explicitly marked as unavailable.

## 2. Decisions

| Decision                                               | Rationale                                                                                                               | Alternative Rejected                                                                                   |
| ------------------------------------------------------ | ----------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------ |
| Reject invalid working-copy DSL at runtime boundaries  | Prevents Studio error drafts from becoming runtime compile failures or partial multi-agent sessions                     | Filtering out only invalid agents can execute partial projects and route to the wrong entry agent      |
| Keep deployment-resolved sessions unchanged            | Deployed artifacts are the production boundary; working-copy validation should not block immutable deployment execution | Revalidating deployment artifacts on every session adds latency and duplicates publish-time validation |
| Add action protocol v2 fields without removing `value` | Preserves older SDK/channel clients while enabling structured forms                                                     | Parsing only JSON strings keeps agent authors tied to transport quirks                                 |
| Use render correlation as a rollout guard              | Blocks stale SDK/web submits while allowing a narrow legacy lane                                                        | Matching only by `actionId` is unsafe for reconnects and repeated menus                                |
| Centralize readiness helpers                           | Avoids each channel making a different decision about invalid drafts                                                    | Ad hoc checks in only the SDK websocket path leave Twilio/LiveKit/session rehydrate behind             |

## 3. Slice Plan

### Slice 1: Runtime DSL Readiness and Tenant Scope

**Goal**: Runtime working-copy/session recovery paths refuse invalid DSL drafts
and all ProjectAgent repository operations stay tenant scoped.

**Files**

- `apps/runtime/src/repos/project-repo.ts`
- `apps/runtime/src/services/session/project-agent-dsl-readiness.ts`
- `apps/runtime/src/services/session/session-bootstrap.ts`
- `apps/runtime/src/channels/pipeline/session-factory.ts`
- `apps/runtime/src/services/runtime-executor.ts`
- `apps/runtime/src/websocket/sdk-handler.ts`
- `apps/runtime/src/__tests__/sessions/repos-project.test.ts`
- `apps/runtime/src/__tests__/channels/pipeline-session-factory.test.ts`

**Test Lock**

- Repository tests prove agent reads/mutations include tenant filters.
- Session factory tests prove invalid working-copy DSL is rejected before compile.
- Runtime/session-bootstrap tests prove invalid draft DSLs do not get returned for execution.

### Slice 2: SDK Action Envelope v2

**Goal**: Web SDK and runtime websocket preserve structured action submit data
and reject stale correlated submits once render ids are present.

**Files**

- `packages/web-sdk/src/transport/types.ts`
- `packages/web-sdk/src/core/types.ts`
- `packages/web-sdk/src/chat/ChatClient.ts`
- `packages/web-sdk/src/ui/action-handler.ts`
- `packages/web-sdk/src/ui/rich-renderer.ts`
- `packages/web-sdk/src/templates/types.ts`
- `packages/web-sdk/src/templates/renderers/actions.ts`
- `packages/web-sdk/src/templates/renderers/form.ts`
- `apps/runtime/src/services/channels/action-event.ts`
- `apps/runtime/src/services/execution/flow-step-executor.ts`
- `apps/runtime/src/websocket/sdk-handler.ts`
- `apps/runtime/src/types/index.ts`
- `packages/web-sdk/src/__tests__/chat-client-transport.test.ts`
- `packages/web-sdk/src/__tests__/rich-renderer-dom.test.ts`
- `apps/runtime/src/__tests__/execution/flow-action-dispatch.test.ts`
- `apps/runtime/src/__tests__/channels/channels-sdk-runtime.e2e.test.ts`

**Test Lock**

- Web SDK unit tests prove `formData` and `renderId` are emitted.
- Runtime executor tests prove `_action.formData` works for Web SDK form submits.
- Runtime executor tests prove stale `renderId` submits are rejected.
- Black-box SDK E2E proves a rendered/clicked SDK button reaches the child agent.

### Slice 3: Diagnostics and Write-Path Normalization

**Goal**: DSL write paths either update validation metadata or make missing
diagnostics explicit, so Studio/list/deploy/runtime decisions are explainable.

**Files**

- `apps/studio/src/app/api/projects/[id]/agents/[agentId]/dsl/route.ts`
- `apps/studio/src/app/api/projects/[id]/agents/[agentId]/edit/route.ts`
- `apps/studio/src/lib/arch-ai/tools/agent-ops.ts`
- `packages/project-io/src/import/core-direct-apply.ts`
- `apps/studio/src/repos/project-repo.ts`
- `apps/studio/src/__tests__/api-routes/api-project-agent-detail-routes.test.ts`
- `apps/studio/src/__tests__/project-services.test.ts`
- `packages/project-io/src/__tests__/core-direct-apply.test.ts`

**Test Lock**

- Save/list/detail tests prove diagnostics survive reload.
- Arch AI/import tests prove source hash and diagnostic status are intentional.
- Runtime boundary tests prove `dslValidationStatus: error` blocks working-copy execution.

### Slice 4: Deployment Resolver Readiness Parity

**Goal**: Every working-copy runtime entry point, including deployment resolver
fallbacks used by channel/session bootstrap code, applies the same DSL readiness
contract before compilation.

**Files**

- `apps/runtime/src/services/deployment-resolver.ts`
- `apps/runtime/src/services/session/project-agent-dsl-readiness.ts`
- `apps/runtime/src/__tests__/tools-deployment/deployment-resolver.test.ts`

**Test Lock**

- Failing-first resolver test proves `allowWorkingCopy` rejects agents with
  persisted `dslValidationStatus: error`.
- Existing working-copy compile tests prove valid/null legacy rows continue to
  execute during rollout.

### Slice 5: Rich Action Correlation Across Render Surfaces

**Goal**: Runtime-generated render ids are available to every interactive rich
surface, not just top-level `ACTIONS`, so carousel buttons and rich form
templates participate in stale-click protection.

**Files**

- `apps/runtime/src/services/execution/flow-step-executor.ts`
- `packages/web-sdk/src/templates/types.ts`
- `packages/web-sdk/src/ui/rich-renderer.ts`
- `packages/web-sdk/src/react/components/RichContent.tsx`
- `packages/web-sdk/src/templates/renderers/carousel.ts`
- `packages/web-sdk/src/templates/renderers/form.ts`
- `packages/web-sdk/src/__tests__/rich-renderer-dom.test.ts`
- `apps/runtime/src/__tests__/execution/flow-action-dispatch.test.ts`

**Test Lock**

- Runtime carousel-only waits return an empty action envelope with `renderId`.
- DOM renderer tests prove carousel card buttons submit `renderId`.
- DOM renderer tests prove rich form template submits include both `formData`
  and `renderId`.

### Slice 6: Channel Action Token Parity

**Goal**: External channels that support hidden action metadata echo render
correlation ids through their native payloads.

**Files**

- `apps/runtime/src/channels/adapters/slack-adapter.ts`
- `apps/runtime/src/channels/adapters/msteams-adapter.ts`
- `apps/runtime/src/__tests__/channels/adapters/slack-transform.test.ts`
- `apps/runtime/src/__tests__/channels/adapters/teams-transform.test.ts`

**Test Lock**

- Slack outbound Block Kit action blocks include the render id in `block_id`.
- Slack inbound block actions restore `actionEvent.renderId`.
- Teams outbound Adaptive Card `Action.Execute` data includes `_renderId`.
- Teams inbound invokes restore `actionEvent.renderId` and strip `_renderId`
  from generic `formData`.

### Slice 7: Authoring Guidance and Developer Mistake Prevention

**Goal**: Studio/Arch AI examples teach executable handler syntax and warn away
from prose-only legacy examples.

**Files**

- `apps/studio/src/lib/arch-ai/construct-catalog.ts`
- `docs/reference/ABL_SPEC.md`

**Test Lock**

- Spec/docs review confirms `_action.renderId`, channel echo behavior, and
  terminal-action ordering are documented.
- Arch AI construct catalog no longer emits the non-executable
  `- action: ... handler: ...` shape.

### Future Slice 8: Canonical Batch Validation Service

**Goal**: Replace parse-only import/repository fallback metadata with one
batch-aware, project-aware validation service shared by Studio save, Arch AI
apply, import apply, and repository fallbacks.

**Design**

- Accept pending agent drafts as an overlay on top of DB project agents.
- Parse all pending drafts first, preserving per-agent diagnostics.
- Compile the overlaid project once, then distribute targeted diagnostics back
  to each changed agent.
- Persist `dslValidationStatus`, `dslDiagnostics`, and `sourceHash` atomically
  with the DSL write.
- Treat validation-service failures as `warning` in authoring save paths and as
  blocking `error` for publish/deploy gates.

**Test Lock**

- Import two new agents where one `ON_ACTION HANDOFF` targets the other and
  prove validation sees the pending peer, not only the pre-import DB state.
- Import an undeclared `HANDOFF` target and prove the persisted agent is marked
  `error`.
- Publish/deploy tests prove versions cannot be promoted from invalid working
  copy metadata.

## 4. Propagation Matrix

| Field                 | Studio Save | DB  | Import/Arch AI                           | Runtime Load   | SDK Render        | SDK Submit        | Executor  |
| --------------------- | ----------- | --- | ---------------------------------------- | -------------- | ----------------- | ----------------- | --------- |
| `dslContent`          | Y           | Y   | Y                                        | Y              | -                 | -                 | Y         |
| `sourceHash`          | Y           | Y   | GAP                                      | read-only      | -                 | -                 | -         |
| `dslValidationStatus` | Y           | Y   | parse-only now; batch-aware future slice | block on error | -                 | -                 | -         |
| `dslDiagnostics`      | Y           | Y   | parse-only now; batch-aware future slice | traced/logged  | -                 | -                 | -         |
| `actionId`            | -           | -   | -                                        | -              | Y                 | Y                 | Y         |
| `value`               | -           | -   | -                                        | -              | Y                 | Y                 | Y         |
| `formData`            | -           | -   | -                                        | -              | Y                 | Y                 | Y         |
| `renderId`            | -           | -   | -                                        | generated      | SDK, Slack, Teams | SDK, Slack, Teams | validated |

## 5. Second-Pass Risk Closure

The follow-up audit found four propagation gaps that must be closed before this
is ready for broad channel rollout.

### Slice A: SDK Action Envelope Contract

- Test first: `ws-sdk-message-contract` must parse `formData` and `renderId`;
  `ws-sdk-handler` must forward `actionId`, scalar `value`, structured
  `formData`, `renderId`, and `source: "sdk"` into `executeMessage()`.
- Implementation: keep the legacy string `value` lane, but treat structured
  `formData` as the canonical form payload. JSON-in-`value` remains a narrow
  compatibility shim.
- Exit: child-agent routing and rich form submits receive the same action context
  across browser SDK, Slack, Teams, and Studio websocket paths.

### Slice B: Working-Copy Compile Fail-Closed

- Test first: `compileProjectWorkingCopy()` must reject semantic compiler errors,
  not return a partial `ResolvedAgent` that callers can accidentally execute.
- Implementation: log compiler diagnostics for operators, throw a sanitized
  `UNPROCESSABLE_ENTITY` `AppError`, and let channel factories/deployment
  resolver paths translate that into their existing runtime error envelope.
- Exit: Studio drafts with stale diagnostics or compiler-discovered target/tool
  mistakes cannot become runtime sessions.

### Slice C: Live Response Provenance and Rich Payload Availability

- Test first: websocket `response_end`, channel outcomes, async replay, HTTP
  chat, session detail, and SDK history hydration must preserve
  `responseMetadata` plus `richContent/actions`.
- Implementation: carry canonical response provenance as optional metadata at
  the response boundary, not as a side-channel log-only field.
- Exit: Slack, Teams, Web SDK, Studio, and async webhooks can make downstream
  decisions with the same visible-response provenance and rich payload.

### Slice D: Tenant Isolation and Model-Config Compatibility

- Test first: deployment resolver must validate `{ projectId, tenantId }` before
  reading mutable `ProjectAgent` rows, and the `ProjectAgent.find()` query must
  include `tenantId`.
- Implementation: scope deployment/working-copy `ProjectAgent` reads by tenant.
- Compatibility lane: `AgentModelConfig` is currently a project-scoped DB model
  while newer import/export/model-resolution call sites are drifting toward a
  tenant-scoped contract. Do not add a one-off tenant filter in only Studio
  import. The future-ready fix is a migration slice that adds `tenantId` to the
  schema, backfills existing rows from `Project.tenantId`, updates unique indexes
  to `{ tenantId, projectId, agentName }`, and then updates every read/write path
  together.
- Exit: cross-tenant project identifiers cannot reveal or reuse mutable draft
  agent state; model-config tenant scoping is handled atomically instead of as a
  partial filter.

## 6. Third-Pass Risk Closure: Studio Client Envelope Parity

The 2026-05-03 audit traced the now-canonical action envelope one hop further
upstream into Studio-owned client surfaces. Runtime, Web SDK, Slack, and Teams
already preserve `formData` and `renderId`, but Studio had two remaining
client-side narrowing points:

1. `useStudioTransport()` accepted the Web SDK `TransportClientMessage` shape
   but forwarded only `actionId/value` to the Studio websocket context.
2. `PreviewMessageList` rendered `ActionSet.renderId` but called `onAction`
   without passing the render correlation token to `/preview` websocket pages.

### Slice E: Studio SDK Bridge Envelope Parity

- Test first: `studio-transport.test.ts` submits an SDK `action_submit` with
  scalar `value`, structured `formData`, and `renderId`, and expects the Studio
  websocket send payload to preserve all three.
- Implementation: widen Studio `ClientMessage.action_submit` and forward
  optional `formData/renderId` through `useStudioTransport()`.
- Exit: Studio debug chat no longer behaves differently from published Web SDK
  widgets for rich action forms or stale-click protection.

### Slice F: Studio Preview Render Correlation

- Test first: `preview-message-list.test.tsx` renders an `ActionSet` with
  `renderId` and proves button clicks pass `{ renderId }` to the websocket
  submit handler.
- Implementation: make preview action callbacks accept `ActionSubmitOptions`,
  preserve render ids for buttons/select/input submits, and include
  `formData/renderId` in `/preview` and `/preview/[projectId]` websocket
  `action_submit` payloads.
- Exit: share-preview and project-preview action clicks participate in the same
  render-correlation contract as Web SDK, Slack, and Teams.

### Deferred Cleanup: Legacy Agent Registry Factory

The audit also found `MongoAgentRegistry` still exposes a `projectId`-only
factory. Current repo search shows no live production caller beyond the factory
itself and tests, while current runtime project repositories already use
tenant-scoped `ProjectAgent` queries. The future-ready cleanup is to change the
factory contract to require `{ tenantId, projectId }`, keep a narrow test-only
legacy path if needed, and add a regression that every `ProjectAgent` query from
the registry includes `tenantId`.

## 7. Fourth-Pass Risk Closure: Studio Repository Tenant-First Reads

The retry audit found a smaller Studio DB-layer drift: project-agent repository
helpers already received `tenantId`, but their first `_id` read used only
`_id` and relied on a later parent-project verification. That still violates
the Studio route-handler invariant that every Mongoose query should scope
explicitly by tenant when the tenant is known.

### Slice G: Tenant-Scoped ProjectAgent ID Reads

- Test first: `project-repo-draft-metadata.test.ts` proved direct ID lookups,
  update pre-reads, delete pre-reads, and post-create refresh reads include
  `tenantId`.
- Implementation: add `tenantId` to the initial `ProjectAgent.findOne()` calls
  in `findProjectAgentByIdAndTenant()`, `updateProjectAgent()`, and
  `deleteProjectAgent()`, and add `projectId/tenantId` to the post-create
  refresh read.
- Exit: Studio DB reads no longer expose a pre-validation agent row across
  tenant boundaries, and mutation paths remain atomically scoped by
  `_id/projectId/tenantId`.

## 8. Acceptance Criteria

- [x] Invalid Studio drafts cannot start working-copy runtime sessions.
- [x] Runtime ProjectAgent reads/mutations include `tenantId` when tenant context exists.
- [x] Current Web SDK form submits send structured `formData`, not only JSON strings.
- [x] Runtime supports a legacy JSON `value` shim with traceable context.
- [x] Stale `renderId` action submits fail closed with a sanitized user-facing error.
- [x] Carousel-only waits expose a render id to SDK renderers.
- [x] Slack and Teams native action payloads echo render ids.
- [x] DeploymentResolver working-copy fallback rejects persisted invalid DSL drafts.
- [x] Arch AI examples use executable `ACTION_HANDLERS` syntax.
- [x] Existing action button handoff E2E still passes.
- [x] Studio debug chat preserves `action_submit.formData` and `action_submit.renderId`.
- [x] Studio preview action clicks preserve `ActionSet.renderId` into websocket submits.
- [x] Studio project-agent repository ID reads include `tenantId` before parent-project joins.
- [x] Scoped builds/tests pass or failures are documented as unrelated existing worktree issues.

## 9. Verification Evidence

- `pnpm --filter @agent-platform/runtime build`
- `pnpm --filter @agent-platform/runtime exec vitest run --config vitest.core.config.ts --maxWorkers=1 src/__tests__/ws-sdk-message-contract.test.ts src/__tests__/channels/ws-sdk-handler.test.ts src/__tests__/project-working-copy-compiler.test.ts src/__tests__/tools-deployment/deployment-resolver.test.ts`
- `pnpm --filter @agent-platform/runtime exec vitest run --config vitest.core.config.ts --maxWorkers=1 src/__tests__/channels/websocket-events.test.ts src/services/channel/__tests__/outcome.test.ts`
- `pnpm --filter @agent-platform/runtime exec vitest run --config vitest.e2e.config.ts --maxWorkers=1 --no-file-parallelism --testTimeout=90000 --hookTimeout=180000 src/__tests__/channels/channels-sdk-runtime.e2e.test.ts`
- `pnpm --filter @agent-platform/studio build`
- `pnpm --filter @agent-platform/studio exec vitest run src/__tests__/studio-transport.test.ts src/__tests__/components/preview-message-list.test.tsx`
- `pnpm --filter @agent-platform/studio exec vitest run src/__tests__/project-repo-draft-metadata.test.ts`

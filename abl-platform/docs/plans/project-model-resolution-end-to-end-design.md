# Project Model Resolution End-to-End Design

Date: 2026-05-02

## Problem

Studio, project model configuration, DSL/import-export, and runtime resolution had drifted in ways that made individual files look valid while the full execution path could still choose the wrong model, wrong tier, wrong credentials, or wrong execution parameters.

The critical failures are:

- Studio can store a `voice` project model, but runtime project fallback can still select an arbitrary non-voice model for `realtime_voice`.
- Runtime tier lookup expects a default per tier, while Studio historically treated `isDefault` as a single project-wide flag.
- Studio exposes project-level credential overrides on `ModelConfig`, but runtime only consumed credentials through linked `TenantModel` connections.
- Studio project model create/update accepted or stored runtime metadata inconsistently, so settings such as `topP`, penalties, context window, pricing, capabilities, `useResponsesApi`, and `useStreaming` could disappear before execution.
- Studio project model listing built access intent but did not enforce the resulting project scope in the model-config query.
- Arch AI auto-created project model configs with a hardcoded `balanced` tier.
- DSL/export-import carries agent execution settings, but project model configs are operational tenant/project state and must not silently imply portable credential state.

## Contract

Project model resolution is tier-first:

- `ModelConfig.tier` is the routing key for project-level fallback.
- `isDefault` selects a preferred model within a tier only.
- If no default exists for a tier, runtime may use the highest-priority project model in that same tier.
- `realtime_voice` maps to `voice` and must not fall back to an arbitrary non-voice project model.
- Non-voice operations may continue to use the existing "any project model" fallback for one-model projects.

Project model metadata must propagate end to end:

- Studio API create/update/list/detail schemas include every execution-relevant `ModelConfig` field.
- Repository filters enforce accessible `projectId` values before returning model configs.
- Runtime resolution carries project `temperature`, `maxTokens`, `topP`, `frequencyPenalty`, `presencePenalty`, `contextWindow`, capabilities, pricing, `useResponsesApi`, and `useStreaming`.
- Session LLM execution forwards resolved generation parameters to the provider call.
- Agent-level hyperparameters override inherited project generation parameters only when explicitly set.

Credential overrides are explicit and executable:

- `ModelConfig.authProfileId` overrides linked TenantModel connection credentials.
- `ModelConfig.credentialId` is the legacy fallback override when no auth profile override is set.
- Overrides are validated before persistence against tenant, project inheritance, visibility, auth type, active state, and user ownership.
- Overrides are tenant-scoped at resolution time.
- Auth profile override failures fail closed and do not fall back to legacy credentials.
- Runtime metadata caches retain enough non-secret override metadata to rehydrate credentials without caching plaintext.

Studio defaults are tier-scoped:

- Marking a project model default clears defaults only for models in the same tier.
- The project model hero may summarize a primary text default, but mutation behavior must preserve other tier defaults.
- Voice defaults must not masquerade as the primary text/chat default in warning banners.
- Arch AI must preserve tenant model tier when creating project model configs.

DSL/import-export boundary:

- Agent execution model choices remain DSL/import-export state.
- Project `ModelConfig` records are portable runtime policy only after sanitization.
- Export/import includes project model names, model IDs, providers, tiers, defaults, capabilities, execution parameters, and tenant model links.
- Export/import must strip `credentialId` and `authProfileId`; credential bindings are not portable unless a later migration introduces an explicit credential remapping manifest.
- Import adapters may preserve `tenantModelId`, but runtime must tenant-verify the linked `TenantModel` before using its credentials.

Operation-tier override compatibility:

- `ProjectLLMConfig` is the canonical storage location for operation-to-tier routing overrides.
- `ProjectRuntimeConfig.operationTierOverrides` is a backward-compatible compatibility lane for older runtime-config clients and exported archives.
- New writes to either runtime route must mirror operation-tier overrides into both records during the compatibility period.
- Runtime resolution must read by `{ tenantId, projectId }`, prefer `ProjectLLMConfig`, and fall back to `ProjectRuntimeConfig` only when no canonical override document exists.
- A future migration may remove the compatibility lane only after archives and clients no longer rely on `runtime-config.json` for operation routing.

Cache freshness:

- Any successful mutation to project `ModelConfig`, agent model config, tenant model metadata, tenant LLM policy, or project operation routing must invalidate model-resolution caches for the tenant.
- Studio direct DB writes must notify runtime through an authenticated tenant-scoped invalidation endpoint because Studio and runtime may run in separate pods.
- Invalidation failures must be logged but must not roll back successful DB writes; the TTL cache remains the last-resort safety net.

Agent model safety:

- Agent model config APIs may only persist model IDs that exist in the same project `ModelConfig` pool.
- Runtime must not execute arbitrary agent-config model IDs that have no matching project `ModelConfig`; legacy bad records should fall through to project/tenant fallback instead of bypassing project model governance.
- Studio agent model default display and capability lookup must use the primary text default (`balanced`, then `powerful`, then `fast`) and must not treat a `voice` default as the generic text-agent default.

Credential revalidation:

- Create and update paths must validate the effective credential/auth-profile references that will be stored after the mutation, not only fields included in the request body.
- When both `authProfileId` and `credentialId` would be present, runtime continues to prefer `authProfileId`; Studio/API callers must explicitly clear `authProfileId` to switch to a legacy credential override.

## Test-Locked Slices

1. Runtime tier routing

- Lock `findModelConfigForTier()` to prefer same-tier defaults and fall back only within the same tier.
- Lock `realtime_voice` so a project tier miss skips `findAnyModelConfig()` and reaches voice-capable tenant model resolution.

2. Runtime project credential overrides

- Lock project `authProfileId` override for linked TenantModel project configs.
- Lock project `credentialId` override for linked TenantModel project configs.
- Lock cache rehydration so overrides survive cached metadata paths without storing plaintext.

3. Studio and Arch AI write paths

- Lock `voice` as a valid project model tier.
- Lock default mutation so it clears only same-tier defaults.
- Lock Arch AI project model creation so it forwards tenant model tier instead of hardcoding `balanced`.

4. Studio model listing isolation

- Lock `GET /api/models` so it first resolves accessible projects and then queries `ModelConfig` by direct `projectId` or `$in` project scope.
- Lock explicit inaccessible `projectId` requests to return an empty list without querying model configs.

5. Runtime execution metadata propagation

- Lock project model parameters, capabilities, and pricing in `ModelResolutionService.resolve()`.
- Lock agent hyperparameter overrides for inherited project generation fields.
- Lock `SessionLLMClient` so resolved generation fields reach `generateText()` and `streamText()`.

6. Studio project runtime policy fields

- Lock `POST /api/models` and `PATCH /api/models/:id` so `useResponsesApi` and `useStreaming` are preserved.
- Lock project model editing so these policies can be set to inherit, enabled, or disabled.
- Lock add-from-catalog so `supportsStreaming` and `contextWindow` survive the Studio UI payload.

7. Credential reference validation

- Lock create/update so inaccessible `authProfileId` and `credentialId` values fail before persistence.
- Fail closed with non-leaky 404s for foreign, inactive, or owner-mismatched references.

8. Per-tier Studio defaults

- Lock the project model hero to prefer text defaults over voice defaults when multiple tier defaults exist.
- Preserve separate default badges and mutation semantics per tier.

9. Operation-tier override canonicalization

- Lock `ProjectLLMConfig` as the canonical route/read source.
- Lock tenant-scoped resolver queries so a project ID collision cannot leak another tenant's overrides.
- Lock compatibility fallback from `ProjectRuntimeConfig` for imported archives and old runtime-config clients.
- Lock route writes to mirror operation overrides into both config records.

10. Cache invalidation after project model changes

- Lock runtime tenant-scoped cache invalidation endpoint behavior.
- Lock Studio `POST /api/models`, `PATCH /api/models/:id`, and `DELETE /api/models/:id` to notify runtime after successful persistence.
- Lock operation-tier override saves to invalidate runtime model-resolution caches.

11. Agent model config governance

- Lock runtime agent model config PUT to reject model IDs that are not in the project model pool.
- Lock runtime resolution to ignore legacy bad agent model IDs rather than executing them directly.
- Lock Studio `AgentModelTab` to use a text-primary project default for text-agent capability lookup and labels.

12. Effective credential reference validation

- Lock PATCH validation to revalidate existing credential/auth-profile refs when provider/model changes.
- Lock ambiguous auth-profile plus legacy credential updates so the saved effective reference is clear and executable.

## Future-Ready Implementation Plan

### Slice 1: Canonical Operation Routing

Test first:

- Repository integration test proves `findProjectOperationTierOverrides(tenantId, projectId)` prefers `ProjectLLMConfig`, falls back to `ProjectRuntimeConfig`, and never reads another tenant's project override.
- Route test proves `/api/projects/:projectId/llm-config` writes canonical `ProjectLLMConfig` and compatibility `ProjectRuntimeConfig`.

Implementation:

- Change the resolver repo signature to include `tenantId`.
- Update `ModelResolutionService` to pass tenant ID when fetching project tier overrides.
- Update the dedicated LLM-config route to read/write both records, with `ProjectLLMConfig` as canonical.
- Invalidate model-resolution caches after successful operation-routing writes.

### Slice 2: Runtime Cache Freshness

Test first:

- Runtime route test proves a tenant-scoped invalidation endpoint calls `invalidateModelResolutionCaches(tenantId)`.
- Studio API route tests prove model create/update/delete notify runtime only after successful persistence.

Implementation:

- Add a small authenticated runtime route under `/api/tenants/:tenantId/model-resolution-cache/invalidate`.
- Add a Studio server helper that calls the runtime invalidation route with the user token and tenant ID.
- Call the helper after successful project model create/update/delete.

### Slice 3: Agent Model Governance

Test first:

- Route test proves agent model config rejects unknown `defaultModel` and `operationModels` values.
- Model-resolution test proves legacy bad agent model config records fall through instead of executing arbitrary literal model IDs.
- Studio component test proves a `voice` default is not used as the generic project default for text agents.

Implementation:

- Validate all requested agent model IDs against `ModelConfig` for the project before upsert.
- Remove the Level 2 direct literal fallback when no project `ModelConfig` exists.
- Add tier to `AgentModelTab` project model data and centralize text-default selection.

### Slice 4: Effective Credential Validation

Test first:

- Studio PATCH route test proves changing provider/model revalidates existing stored credential/auth-profile refs.
- Studio PATCH route test proves setting `credentialId` while an existing `authProfileId` remains is rejected unless `authProfileId: null` is also sent.

Implementation:

- Compute the post-patch effective credential/auth-profile refs before calling `validateModelConfigCredentialRefs`.
- Fail ambiguous credential updates with a stable 400 validation error.
- Keep runtime's `authProfileId` precedence unchanged.

## Rollout Notes

This design is backward-compatible with existing records:

- Existing single-default projects continue to resolve because same-tier defaults still win and non-voice fallback remains.
- Existing project configs without credential overrides continue to use TenantModel connection credentials.
- Existing Arch AI-created configs keep their stored tier until edited or recreated.
- Existing project models without explicit `useResponsesApi` or `useStreaming` inherit runtime defaults.
- Existing project models without pricing or capability metadata continue to resolve; missing metadata simply remains undefined.

## Residual End-to-End Hardening Plan

### 2026-05-02 Follow-up: Voice Tier Contract Closure

The second audit found a remaining contract drift after project model CRUD began accepting
`voice`: downstream routing and support surfaces still carried local copies of the older
`fast | balanced | powerful` vocabulary.

#### Future-ready contract

- Model routing tiers are a shared platform contract: `fast`, `balanced`, `powerful`, `voice`.
- Operation routing keys are a shared platform contract: `extraction`, `validation`,
  `tool_selection`, `response_gen`, `summarization`, `reasoning`, `coordination`,
  `realtime_voice`.
- `realtime_voice` defaults to `voice`; text operations keep their existing defaults.
- Studio, Runtime HTTP validation, runtime model resolution, project import/export, diagnostics,
  and voice-specific runtime shortcuts must import the same routing vocabulary rather than
  maintaining local enum copies.
- Models that are tenant-scoped by parent `Project` must never be queried with a non-existent
  `tenantId` field; diagnostics must use the same tenant-safe repository helpers as execution.
- Voice-session side paths must pass `tenantId` into model-config lookups or skip the lookup and
  fall back safely.

#### Slice-by-slice implementation plan

1. Shared routing vocabulary
   - Test first: add shared-kernel tests for valid tiers, operations, defaults, and type guards.
   - Implement: add `@agent-platform/shared-kernel/model-routing` constants and exports.
   - Exit: shared-kernel test and build pass.

2. Runtime routing API and direct chat validation
   - Test first: lock `/api/projects/:projectId/llm-config` accepting
     `{ realtime_voice: "voice" }`, and lock `/api/v1/chat/complete` accepting `tier: "voice"`
     without failing Zod validation.
   - Implement: replace local route enum copies with shared routing constants.
   - Exit: targeted runtime route tests pass.

3. Studio operation-tier UI
   - Test first: covered by the shared routing contract and route test; Studio should render from
     the same constants so there is no local enum to drift.
   - Implement: render operation mappings and tier options from shared routing constants.
   - Exit: Studio model-management/API route tests continue to pass.

4. Diagnostics alignment
   - Test first: update diagnostics tests to require tenant-safe repository helpers rather than
     direct `tenantId` filters on `ModelConfig`/`AgentModelConfig`.
   - Implement: use `findAgentModelConfig`, `findAnyModelConfig`, and correct
     `AgentModelConfig.defaultModel` evidence.
   - Exit: model-resolution and credential-chain analyzer tests pass.

5. Voice streaming tenant safety
   - Test first: lock KoreVG session bootstrap so agent streaming config lookup passes
     `(projectId, agentName, tenantId)`.
   - Implement: pass `tenantId`, and skip the DB lookup when tenant context is missing.
   - Exit: KoreVG bootstrap test passes.

The first implementation closed the Studio model CRUD and route-backed runtime paths, but the data-flow audit found additional side doors that must be locked before the Studio -> DB -> DSL/import -> runtime execution contract is complete.

### Design Decisions

| #    | Decision                                                                                                                                                        | Rationale                                                                                                                                             | Rejected Alternative                                            |
| ---- | --------------------------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------- |
| D-13 | Direct project import must persist runtime config, LLM config, and agent model config files.                                                                    | Export already emits these files and the layered disassembler recognizes them; ignoring them during direct apply silently drops runtime model policy. | Keep configs export-only and document the gap.                  |
| D-14 | Import snapshots must include the same model-policy files they can restore.                                                                                     | Revert must round-trip the pre-import runtime policy, not only agents/tools.                                                                          | Revert only agents/tools and require manual config restoration. |
| D-15 | Runtime model-resolution repository lookups must receive `tenantId` and verify project ownership before reading project-bound records that lack a tenant field. | `ModelConfig` and `AgentModelConfig` are project-scoped collections; project-only queries are not a sufficient isolation boundary.                    | Rely on caller-side `requireProjectScope()` forever.            |
| D-16 | Direct import model-policy writes invalidate tenant model-resolution caches after successful apply.                                                             | Direct Studio DB writes bypass runtime route-side invalidation. Cache freshness should not depend on TTL after an import.                             | Let stale caches expire naturally.                              |
| D-17 | Existing legacy bad agent model rows are tolerated at runtime but should be visible to cleanup/migration tooling.                                               | Runtime must fail safe without breaking old projects abruptly.                                                                                        | Delete legacy rows automatically during execution.              |

### Slice Plan

#### Slice A: Import/Export Model Policy Round Trip

Test first:

- `buildCoreImportApplyPlanV2()` plans writes for `config/runtime-config.json`, `config/llm-config.json`, and `config/agent-model-configs/*.model-config.json`.
- `executeCoreImportApplyPlanV2()` calls adapter methods for those config writes and includes created IDs in rollback.
- Core import snapshots serialize and restore the same config files.
- Studio direct-apply support loads current config state and writes scoped upserts/deletes.

Implementation:

- Add typed config operations to `CoreImportApplyPlanV2`.
- Extend `CoreImportApplyAdapterV2` with runtime config, LLM config, and agent model config upsert/delete methods.
- Extend Studio and runtime adapters to upsert by `{ tenantId, projectId }` or `{ projectId, agentName }` after verifying the parent project tenant.
- Mirror `operationTierOverrides` between `ProjectLLMConfig` and `ProjectRuntimeConfig` when either config is imported.

Exit criteria:

- Project-IO core-direct-apply tests pass.
- Studio direct-apply support tests pass.
- Runtime project-io import adapter tests or existing route tests pass.

#### Slice B: Tenant-Safe Runtime Resolution Repositories

Test first:

- Repository unit tests assert `findAgentModelConfig()`, `findAgentModelConfigByDslName()`, `findModelConfigByModelId()`, `findModelConfigForTier()`, and `findAnyModelConfig()` include or verify `tenantId`.
- Model-resolution tests assert tenant-scoped calls pass `tenantId` through every project config lookup.

Implementation:

- Update repository signatures to accept `tenantId`.
- Verify parent `Project` by `{ _id: projectId, tenantId }` before querying project-scoped collections that do not store `tenantId`.
- Pass `context.tenantId` from `ModelResolutionService`.
- Keep route-level validation as defense in depth, not as the only isolation control.

Exit criteria:

- Runtime model-resolution targeted tests pass.
- Existing tenant/project isolation repo tests pass.

#### Slice C: Direct Import Cache Freshness

Test first:

- Studio import apply route invalidates runtime model-resolution caches after successful apply when model-policy files are present.
- Failed apply does not invalidate.
- Runtime project-io import invalidates local tenant caches after successful apply when model-policy files are present.

Implementation:

- Expose a plan predicate such as `hasModelPolicyOperations`.
- Call the runtime invalidation helper from Studio apply after a successful model-policy import.
- Call `invalidateModelResolutionCaches(tenantId)` from runtime project-io apply after successful model-policy import.

Exit criteria:

- Studio import apply route tests pass.
- Runtime project-io route tests pass.

#### Slice D: Cleanup Visibility

Test first:

- Runtime diagnostics detect agent model configs whose model IDs do not exist in project `ModelConfig`.

Implementation:

- Add a diagnostics-only stale reference report; do not mutate records during execution.

Exit criteria:

- Diagnostics tests pass and runtime execution remains fail-safe.

#### Slice E: Operation-Tier Override Validation Closure

Test first:

- Shared-kernel rejects unknown operation keys and unknown tier values while accepting canonical records/maps.
- Runtime `/runtime-config` rejects invalid `operationTierOverrides` before mirroring into canonical `ProjectLLMConfig`.
- Project import planning rejects invalid `config/runtime-config.json` or `config/llm-config.json` overrides before apply.
- Runtime model resolution ignores stale invalid persisted overrides and falls back to canonical defaults.

Implementation:

- Move operation-tier override normalization and error formatting into `@agent-platform/shared-kernel`.
- Re-export the pure contract from `@agent-platform/shared` for import tooling.
- Use the shared validator in runtime compatibility routes and project import planning.
- Use shared defaults in runtime `operationToTier()` so default routing cannot drift from Studio/API metadata.
- Replace local Studio model-tier route constants with the shared tier constant.

Exit criteria:

- Shared-kernel, shared, project-io, and runtime targeted builds pass.
- Shared-kernel, project-io, runtime route/resolution, and Studio focused model tests pass.

### 2026-05-03 Follow-up: Sanitized Model Policy Portability and Runtime Fail-Closed Closure

The third audit looked across the full Studio -> DB -> project archive/import -> runtime
execution path and found four remaining end-to-end gaps:

- Project `ModelConfig` rows were still not part of the project archive/import contract, so a
  voice model pool could exist in Studio/DB but disappear during direct import or rollback.
- `realtime_voice` skipped arbitrary project-model fallback, but could still fall through to the
  generic tenant-model fallback and select a non-voice default.
- Runtime tenant and platform-admin model creation paths did not consistently validate the shared
  routing tier vocabulary at the handler boundary.
- Tenant model creation could leave stale model-resolution cache entries and competing same-tier
  defaults.

#### Future-ready contract

- `config/project-model-configs/*.model-config.json` is the portable project model policy lane.
- Project model policy files must be sanitized: no `_id`, `tenantId`, `projectId`, timestamps,
  `credentialId`, or `authProfileId`.
- `tenantModelId` may round-trip as a best-effort environment link, but execution only uses it
  after tenant verification; foreign or missing links fail safe into the normal governed fallback.
- `realtime_voice` may use a project `voice` model or a voice-capable tenant model. It must never
  use generic project or tenant fallbacks.
- All tenant-model provisioning surfaces must import the shared `MODEL_ROUTING_TIERS` contract.
- Successful tenant model metadata mutations must invalidate tenant model-resolution caches.
- Marking a tenant model default clears defaults only inside the same tier.

#### Slice-by-slice implementation plan

1. Project model config portability
   - Test first: export includes sanitized `config/project-model-configs/*.model-config.json`;
     direct import plans project-model upserts/deletes; snapshots include the same files.
   - Implement: extend core assembler, direct apply planner, snapshot builder, Studio adapter, and
     runtime adapter with project model config state.
   - Exit: project-io core assembler/direct-apply/orchestrator tests pass.

2. Runtime voice fail-closed
   - Test first: `realtime_voice` with no voice model rejects instead of selecting a generic tenant
     default.
   - Implement: skip `resolveAnyTenantModel()` for `realtime_voice`.
   - Exit: model-resolution comprehensive test passes.

3. Tenant/platform model provisioning hardening
   - Test first: tenant route rejects unknown tiers and invalidates caches on successful voice
     model creation; platform-admin route rejects unknown tiers, clears same-tier defaults, and
     invalidates caches.
   - Implement: use shared `MODEL_ROUTING_TIERS` in both route schemas, explicitly parse request
     bodies, clear same-tier defaults before default writes, and invalidate caches after success.
   - Exit: tenant route and platform-admin route tests pass.

4. Import state sanitizer defense in depth
   - Test first: runtime import preview planner state strips `credentialId` and `authProfileId`
     from project model configs.
   - Implement: add Studio/runtime project-model-policy sanitizers and use them for snapshot state
     and adapter writes.
   - Exit: Studio direct-apply support and runtime project-io route tests pass.

#### Implementation status

- Slice 1: Implemented and test-locked.
- Slice 2: Implemented and test-locked.
- Slice 3: Implemented and test-locked for included runtime lanes.
- Slice 4: Implemented and test-locked.

#### Explicit residuals

- The Mongo schemas still store `tier` as a string to avoid breaking legacy records before a
  migration/backfill lane. Runtime/API/import boundaries now enforce the canonical vocabulary.
- Credential remapping for imported archives remains out of scope until a dedicated manifest exists.
- Existing excluded legacy route tests were not used as the primary lock; the included runtime
  auth/route lane now carries the platform-admin provisioning assertions.

# LLD: Model Policy Portability and Git Sync Parity

**Status**: IN PROGRESS
**Date**: 2026-05-03
**JIRA**: ABLP-540

## 1. Design Decisions

| #    | Decision                                                                                              | Rationale                                                                                                                           | Alternatives Rejected                                              |
| ---- | ----------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------ |
| D-1  | Treat exported runtime model bindings as portable descriptors, not tenant-local database IDs.         | Project archives can move across tenants; `tenantModelId` is only valid inside the source tenant.                                   | Preserve source IDs and hope destination IDs match.                |
| D-2  | Rebind portable runtime descriptors during import validation and persist only destination-scoped IDs. | Runtime execution should keep using existing `ProjectRuntimeConfig` shape without storing export-only metadata.                     | Persist `tenantModelRef` in Mongo and teach runtime to ignore it.  |
| D-3  | Keep webhook auto-sync behavior equivalent to manual git pull.                                        | Both paths apply the same imported DSL/config and must run the same validators, sync path handling, and runtime cache invalidation. | Maintain separate webhook shortcuts.                               |
| D-4  | Scope `ModelConfig` validation by verified `projectId`, not a nonexistent `tenantId` field.           | The database model explicitly enforces tenant isolation through the project join.                                                   | Add a shadow `tenantId` to `model_configs` in this patch.          |
| D-5  | Treat every project export surface as a runtime handoff boundary.                                     | Archives are executable inputs for another tenant/runtime; invalid agent drafts must not leave any export path.                     | Guard only Studio sync export and rely on consumers to reject.     |
| D-6  | Fail closed for unresolved prompt-library references during import planning.                          | Cross-tenant archives can include agent prompt references without prompt bundles; runtime compile should not discover the defect.   | Persist dangling refs and let runtime compilation fail later.      |
| D-7  | Separate routing tier existence from operation compatibility.                                         | `voice` is a valid model tier, but not every text operation can safely use realtime-only models.                                    | Keep a single global enum check for all operation overrides.       |
| D-8  | Define runtime config update visibility as "new sessions plus cache invalidation."                    | Active sessions hold an execution snapshot; updates must reliably affect new sessions and model-resolution caches.                  | Attempt implicit hot-reload of active sessions in this patch.      |
| D-9  | Validate runtime-config operation tiers at every readiness boundary, not only import planning.        | Legacy DB rows and direct config exports must fail before producing archives that later cannot import or execute.                   | Assume all persisted runtime config passed modern route checks.    |
| D-10 | Treat agent prompt-ref PATCH as a compile-affecting write.                                            | Updating `systemPromptLibraryRef` changes prompt materialization, source hashes, and execution readiness.                           | Rely on the picker UI to provide only valid references.            |
| D-11 | Keep runtime model-resolution fallback aligned with fail-closed draft readiness.                      | Resolver utilities can be used outside the normal session gate; stale/unvalidated drafts should never drive runtime model lookup.   | Skip only explicit `error` states.                                 |
| D-12 | Runtime public export readiness is a parity gate for both preview and full export.                    | API exports are tenant-portable execution artifacts just like Studio/Git exports.                                                   | Consider preview/readiness as Studio-only behavior.                |
| D-13 | Treat canonical `ProjectLLMConfig` as part of project execution readiness.                            | Runtime prefers `ProjectLLMConfig.operationTierOverrides`; validating only `ProjectRuntimeConfig` leaves stale invalid policy live. | Keep `ProjectLLMConfig` as an unchecked legacy compatibility row.  |
| D-14 | Gate versioned deployments at creation and resolution, not only working-copy execution.               | Cached/versioned IR can execute after runtime/model policy drift; every runtime entry path needs the same readiness boundary.       | Assume deployment creation permanently freezes all runtime policy. |
| D-15 | Project-scoped agent identity is mandatory for DSL lookup APIs.                                       | Agent names are only unique within a project; tenant-wide name lookup can compile the wrong project's DSL.                          | Preserve legacy tenant-wide name lookup for convenience.           |
| D-16 | Module release publishing is an executable artifact boundary.                                         | Module artifacts are imported/executed elsewhere; publish must share export/runtime readiness, prompt, and model-policy gates.      | Rely on parse/compile/publish-safety checks alone.                 |

### Future-Ready Boundary Contract

All paths that produce or consume executable project artifacts must call the same readiness contract before crossing a boundary:

1. **Studio write boundary**: API writes that change DSL, prompt refs, tools, runtime config, or model policy validate and refresh persisted draft metadata/source hashes.
2. **DB persistence boundary**: persisted model policy uses destination-scoped IDs only and validates both `ProjectRuntimeConfig` and canonical `ProjectLLMConfig`.
3. **Export/import boundary**: Studio export, async export, bundle export, git push, runtime public export, and project import preview/apply use the same artifact readiness helper.
4. **Deployment boundary**: deployment creation validates selected versions plus current runtime/model policy; deployment resolution rechecks runtime/model policy for new sessions before serving cached or versioned IR.
5. **Module boundary**: module release publish validates agent draft readiness, runtime/model policy readiness, prompt ref availability, and portable tool/model contracts before creating a release.
6. **Runtime execution boundary**: working-copy, versioned deployment, module-backed deployment, channel session bootstrap, and internal tool execution fail closed on unresolved config placeholders, invalid model policy, or ambiguous agent identity.

## 2. File-Level Change Map

| File                                                                  | Change                                                                                                        | Risk   |
| --------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------- | ------ |
| `apps/studio/src/app/api/webhooks/git/[projectId]/route.ts`           | Add tool/runtime validators, sync path parity, and runtime cache invalidation.                                | Medium |
| `packages/project-io/src/export/layer-assemblers/core-assembler.ts`   | Export runtime tenant model bindings as portable descriptors and remove source `tenantModelId`.               | Medium |
| `apps/studio/src/lib/project-runtime-config-import-validation.ts`     | Resolve portable runtime descriptors to destination `TenantModel` IDs and fix project model validation scope. | Medium |
| `apps/studio/src/__tests__/api-routes/api-webhook-git-routes.test.ts` | Lock webhook parity.                                                                                          | Low    |
| `packages/project-io/src/__tests__/core-assembler.test.ts`            | Lock portable runtime-config export.                                                                          | Low    |
| `packages/project-io/src/__tests__/core-direct-apply.test.ts`         | Lock validator normalization contract.                                                                        | Low    |
| `apps/studio/src/services/export-job-processor.ts`                    | Block async export jobs when saved agent drafts are invalid or unvalidated.                                   | Medium |
| `apps/runtime/src/routes/project-io.ts`                               | Block runtime export when saved agent drafts are invalid or unvalidated.                                      | Medium |
| `apps/runtime/src/services/session/project-agent-dsl-readiness.ts`    | Make execution readiness fail closed for non-empty DSL with missing/unknown validation state.                 | Medium |
| `apps/studio/src/lib/project-agent-export-readiness.ts`               | Share fail-closed readiness semantics with Studio export surfaces.                                            | Medium |
| `packages/shared-kernel/src/model-routing.ts`                         | Add operation-tier compatibility validation for `voice` overrides.                                            | Medium |
| `packages/project-io/src/import/core-direct-apply.ts`                 | Validate imported agent prompt refs against destination/imported prompt versions before planning writes.      | Medium |
| `packages/project-io/src/import/runtime-config-save-validation.ts`    | Validate and normalize runtime-config `operationTierOverrides` for save/export readiness.                     | Medium |
| `apps/studio/src/app/api/projects/[id]/agents/[agentId]/route.ts`     | Validate prompt refs before PATCH persistence and refresh draft metadata after prompt-ref changes.            | Medium |
| `apps/runtime/src/repos/llm-resolution-repo.ts`                       | Skip non-empty DSL mappings unless draft validation status is trusted.                                        | Medium |
| `packages/project-io/src/project-agent-export-readiness.ts`           | Expand readiness input to validate canonical `ProjectLLMConfig` alongside `ProjectRuntimeConfig`.             | Medium |
| `packages/project-io/src/import/runtime-config-save-validation.ts`    | Expose a model-policy validation helper that can validate runtime and LLM config shapes consistently.         | Medium |
| `packages/project-io/src/export/layer-assemblers/core-assembler.ts`   | Normalize and validate `config/llm-config.json` before export, including operation-tier compatibility.        | Medium |
| `apps/runtime/src/repos/llm-resolution-repo.ts`                       | Normalize/validate canonical operation-tier overrides before returning them to model resolution.              | Medium |
| `apps/runtime/src/routes/deployments.ts`                              | Block deployment creation when selected versions or current model policy are not execution-ready.             | Medium |
| `apps/runtime/src/services/deployment-resolver.ts`                    | Recheck project execution/model-policy readiness when resolving versioned deployments for new sessions.       | Medium |
| `apps/runtime/src/routes/agents.ts`                                   | Require `projectId` or redirect callers to project-scoped agent APIs for DSL details.                         | Medium |
| `apps/studio/src/app/api/agents/[name]/route.ts`                      | Remove tenant-wide agent-name lookup or require a project-scoped query parameter.                             | Medium |
| `apps/studio/src/app/api/projects/[id]/module/releases/route.ts`      | Gate module release publish through the shared executable-artifact readiness helper.                          | Medium |
| `packages/project-io/src/module-release/build-module-release.ts`      | Accept prevalidated readiness context and preserve warnings/errors in release output.                         | Low    |

## 3. Implementation Slices

### Slice 1: Webhook Parity

**Goal**: Webhook auto-sync must behave like manual git pull for import validation, sync path, and runtime cache invalidation.

**Tasks**:

1. Add failing route tests for validator wiring, `syncPath`, and model policy cache invalidation.
2. Import and pass the same validators used by manual git pull.
3. Pass `integration.syncPath` into `pullProjectFiles`.
4. Call `notifyRuntimeModelConfigChanged` after model policy mutations.

**Exit Criteria**:

- `api-webhook-git-routes.test.ts` passes.

### Slice 2: Portable Runtime Config Export

**Goal**: Runtime config export must not emit source tenant model IDs while retaining enough provider/model identity for destination rebinding.

**Tasks**:

1. Add a failing `CoreAssembler` test for nested `pipeline` and `filler` tenant model bindings.
2. Add a shallow runtime-config export normalizer that resolves referenced tenant models from the source tenant.
3. Emit `tenantModelRef` descriptors and remove nested source `tenantModelId`.

**Exit Criteria**:

- `core-assembler.test.ts` passes.

### Slice 3: Runtime Config Import Rebinding

**Goal**: Import validation should convert portable descriptors into destination `tenantModelId`s and reject ambiguous/missing destination bindings.

**Tasks**:

1. Add failing import-plan tests proving validator-returned normalized data is what gets planned.
2. Update Studio runtime-config validation to pre-normalize portable descriptors before strict schema validation.
3. Fix `ModelConfig` project-model lookup to avoid the nonexistent `tenantId` filter.

**Exit Criteria**:

- `core-direct-apply.test.ts` and focused Studio validation tests pass.

### Slice 4: Export Readiness Parity

**Goal**: Every export surface blocks invalid or unvalidated saved agent DSL before producing archives.

**Tasks**:

1. Add failing tests for Studio async export and runtime `/project-io/export`.
2. Reuse the same readiness helper semantics across Studio sync export, async export, git push, bundle export, and runtime export.
3. Include `dslValidationStatus` and `dslDiagnostics` in async/runtime export read paths.

**Exit Criteria**:

- Focused Studio export-job tests pass.
- Focused runtime project-io export tests pass.

### Slice 5: Prompt Reference Portability Guard

**Goal**: Import planning rejects agent `systemPromptLibraryRef` values that cannot resolve after the selected layer operations apply.

**Tasks**:

1. Add failing project-io planning tests for missing prompt bundles, prompts layer disabled, archived prompt versions, and `deleteUnmatched` dangling refs.
2. Validate refs against existing prompt state plus prompt create/update/delete operations.
3. Return a blocking import error before any DB write is attempted.

**Exit Criteria**:

- Focused `core-direct-apply.test.ts` prompt-ref tests pass.

### Slice 6: Fail-Closed DSL Readiness

**Goal**: Runtime/session/export readiness treats non-empty DSL with missing or unknown validation status as blocked.

**Tasks**:

1. Add failing unit/route tests for null or unknown `dslValidationStatus`.
2. Update shared readiness helpers to block both explicit errors and unvalidated non-empty DSL.
3. Preserve diagnostics for explicit errors and emit a stable synthetic diagnostic for unvalidated drafts.

**Exit Criteria**:

- Focused Studio export readiness tests pass.
- Focused runtime readiness tests pass.

### Slice 7: Voice Tier Operation Compatibility

**Goal**: Keep `voice` as a valid model tier while preventing accidental text-operation overrides to realtime voice models.

**Tasks**:

1. Add failing shared-kernel tests for `response_gen: "voice"` rejection and `realtime_voice: "voice"` acceptance.
2. Extend operation-tier validation to report incompatible operation/tier pairs.
3. Update import/API tests that previously used text-operation `voice` overrides.

**Exit Criteria**:

- Focused shared-kernel model-routing tests pass.
- Focused runtime/studio route validation tests pass.

### Slice 8: Runtime Config Invalidation Scope

**Goal**: Direct runtime config writes invalidate model-resolution caches whenever model-affecting runtime policy changes.

**Tasks**:

1. Add failing route tests for `pipeline` and `filler` model-source changes.
2. Invalidate caches for direct PUTs that include `operationTierOverrides`, `pipeline`, or `filler`.
3. Document that active sessions keep their initialized snapshot; new sessions observe the updated config.

**Exit Criteria**:

- Focused runtime project-runtime-config route tests pass.

### Slice 9: Runtime Public Export Runtime-Config Parity

**Goal**: Runtime `/project-io/export/preview` and `/project-io/export` use the same project-level readiness contract as Studio export surfaces.

**Tasks**:

1. Verify Runtime export fetches `ProjectRuntimeConfig` in preview and full export.
2. Verify both Runtime export paths call `getProjectExportReadinessIssues`.
3. Keep route tests for invalid runtime config state.

**Exit Criteria**:

- Focused runtime project-io export readiness tests pass.

### Slice 10: Runtime Config Operation-Tier Readiness

**Goal**: Runtime-config save/readiness validation rejects invalid or incompatible `operationTierOverrides`, including legacy DB rows.

**Tasks**:

1. Add failing runtime-config validation tests for `response_gen: "voice"` and allowed `realtime_voice: "voice"`.
2. Reuse shared operation-tier normalization inside `validateProjectRuntimeConfigWrite`.
3. Return a stable runtime-config validation error before export/import proceeds.

**Exit Criteria**:

- Focused project-io runtime-config validation tests pass.

### Slice 11: Agent Prompt-Ref PATCH Guard

**Goal**: Studio agent prompt-ref updates validate destination prompt availability and refresh draft metadata/source hash after persistence.

**Tasks**:

1. Add failing API-route tests for unavailable prompt refs and metadata refresh after prompt-ref updates.
2. Resolve prompt refs with the shared prompt-library resolver before persisting.
3. Refresh persisted Studio project-agent draft metadata after prompt-ref changes.

**Exit Criteria**:

- Focused Studio project-agent detail route tests pass.

### Slice 12: Model-Resolution Draft Readiness Parity

**Goal**: Runtime model-resolution fallback must not map model configs through unvalidated or unknown draft states.

**Tasks**:

1. Add a failing repo test for `dslValidationStatus: null` / unknown status mappings.
2. Update `findAgentModelConfigByDslName` to accept only `valid` or `warning` non-empty DSL mappings.
3. Preserve tenant/project scoping and explicit error behavior.

**Exit Criteria**:

- Focused runtime repos-data model-resolution tests pass.

### Slice 13: Canonical Project LLM Config Readiness

**Goal**: `ProjectLLMConfig` and `ProjectRuntimeConfig` share one operation-tier validation contract before export, import, deployment, or runtime resolution.

**Tasks**:

1. Add failing tests where `ProjectRuntimeConfig.operationTierOverrides` is valid but canonical `ProjectLLMConfig.operationTierOverrides` contains `response_gen: "voice"`.
2. Add a project-io helper that validates a model-policy config record independent of the storage model (`runtime` or `llm`).
3. Extend `getProjectExportReadinessIssues` to accept optional `llmConfig` and emit a `model_policy` readiness issue when canonical LLM config is invalid.
4. Update `CoreAssembler` to validate/normalize `config/llm-config.json` before writing it into the archive.
5. Update `findProjectOperationTierOverrides` to normalize canonical rows and fail closed or ignore invalid canonical values with traceable diagnostics.

**Files Touched**:

- `packages/project-io/src/project-agent-export-readiness.ts` — add `llmConfig` input and model-policy issue type.
- `packages/project-io/src/import/runtime-config-save-validation.ts` — extract reusable operation-tier/model-policy validation.
- `packages/project-io/src/export/layer-assemblers/core-assembler.ts` — validate serialized LLM config.
- `apps/runtime/src/repos/llm-resolution-repo.ts` — normalize canonical tier overrides before runtime use.
- `packages/project-io/src/__tests__/project-agent-export-readiness.test.ts` — lock invalid canonical LLM policy.
- `packages/project-io/src/__tests__/core-assembler.test.ts` — lock LLM config export normalization.
- `apps/runtime/src/__tests__/sessions/repos-data.test.ts` — lock runtime canonical override handling.

**Exit Criteria**:

- [x] Export readiness reports invalid canonical LLM policy even when runtime config is valid.
- [x] Exported `config/llm-config.json` cannot contain incompatible operation-tier overrides.
- [x] Runtime model resolution cannot route text operations to `voice` through stale canonical policy.
- [x] Focused project-io and runtime repo tests pass.

**Test Strategy**:

- Unit: operation-tier validation for runtime and LLM policy records.
- Integration: runtime repo lookup with invalid canonical `ProjectLLMConfig`.
- Route/export: project export readiness with invalid canonical row.

**Rollback**: Remove `llmConfig` readiness input and revert runtime normalization; existing runtime-config readiness remains intact.

### Slice 14: Versioned Deployment Readiness Parity

**Goal**: Versioned deployments, cached deployments, and deployment creation obey the same executable-artifact readiness as working-copy runtime execution.

**Tasks**:

1. Add failing deployment route tests proving deployment creation rejects invalid current runtime/model policy before creating or caching deployment IR.
2. Add failing deployment-resolver tests proving `resolveByDeployment` rejects invalid project runtime/model policy even when `deployment.compilationHash` cache hits.
3. Reuse `evaluateProjectExecutionReadiness` or a new `evaluateProjectArtifactReadiness` helper that accepts selected agents, runtime config, and LLM config.
4. Fetch `ProjectRuntimeConfig` and `ProjectLLMConfig` once per deployment creation/resolution path and pass them into the readiness helper.
5. Preserve deterministic rollback for existing deployments: rejection applies to new session resolution, not mutation of stored deployment records.

**Files Touched**:

- `apps/runtime/src/routes/deployments.ts` — validate readiness before deployment create/cache.
- `apps/runtime/src/services/deployment-resolver.ts` — validate readiness before cached/versioned deployment return.
- `apps/runtime/src/services/session/project-agent-dsl-readiness.ts` — rename/extend execution readiness helper to cover LLM config.
- `apps/runtime/src/__tests__/deployments.test.ts` or focused route test file — lock create-time rejection.
- `apps/runtime/src/__tests__/deployment-resolver.test.ts` — lock cache-hit and cache-miss rejection.

**Exit Criteria**:

- [x] Deployment creation rejects invalid runtime or canonical LLM operation-tier policy with a stable 422/400 response.
- [x] `resolveByDeployment` rejects invalid runtime/model policy before returning cached IR.
- [x] Working-copy resolution behavior remains unchanged and green.
- [x] Focused deployment route and resolver tests pass.

**Test Strategy**:

- Unit: readiness helper maps canonical model-policy diagnostics.
- Integration: deployment resolver cache-hit path with invalid policy.
- Route: deployment create with `agentVersionManifest` plus invalid policy.

**Rollback**: Remove deployment readiness calls; existing working-copy readiness and export gates remain active.

### Slice 15: Project-Scoped Legacy Agent Detail APIs

**Goal**: Agent detail and DSL compilation APIs never resolve by tenant + name alone when a project scope is available or required.

**Tasks**:

1. Add failing tests with two projects in the same tenant containing the same agent name and different DSL.
2. Change runtime `GET /api/agents/:name` to require `projectId` query/path context, or return a clear 400 instructing callers to use `/api/projects/:projectId/agents/:agentName`.
3. Change Studio `/api/agents/[name]` to require a project-scoped query parameter or migrate callers to project-scoped APIs.
4. Audit and update callers to pass project scope explicitly; do not silently choose the first tenant membership.
5. Keep backward compatibility narrow: if a legacy route remains, it must refuse ambiguous matches instead of selecting one.

**Files Touched**:

- `apps/runtime/src/routes/agents.ts` — require project scope or fail on ambiguity.
- `apps/studio/src/app/api/agents/[name]/route.ts` — require project scope or deprecate route.
- `apps/runtime/src/repos/project-repo.ts` — ensure project-scoped lookup helpers are the only runtime-facing DSL lookup path.
- `apps/studio/src/__tests__/api-routes/*agent*` — lock duplicate-name behavior.
- `apps/runtime/src/__tests__/repos.test.ts` or route tests — lock duplicate-name behavior.

**Exit Criteria**:

- [x] Tenant-wide agent detail APIs no longer compile arbitrary first-match DSL.
- [x] Duplicate agent names across projects return deterministic 400/404 instead of wrong DSL.
- [x] All Studio/runtime callers use project-scoped lookup where project context exists.
- [x] Focused route/repo tests pass.

**Test Strategy**:

- Unit: repo helpers reject or require project scope for duplicate names.
- Route: runtime and Studio legacy APIs with duplicate same-tenant names.
- Regression: project-scoped session/debug APIs still resolve the intended agent.

**Rollback**: Restore legacy route behavior only for non-ambiguous single-match tenants; keep project-scoped route as the preferred path.

### Slice 16: Module Release Executable-Artifact Readiness

**Goal**: Module release publishing cannot produce artifacts that export/runtime readiness would reject.

**Tasks**:

1. Add failing module-release route tests for unvalidated agent DSL, invalid prompt refs, invalid runtime config, and invalid canonical LLM config.
2. Fetch `ProjectRuntimeConfig` and `ProjectLLMConfig` during module publish and pass them with agents into the shared readiness helper.
3. Block publish before `buildModuleRelease` when readiness has blocking issues; return stable 422 error payload with issue details.
4. Preserve module-specific publish-safety checks after readiness passes.
5. Add release warnings for non-included model config only after readiness confirms the source project is executable.

**Files Touched**:

- `apps/studio/src/app/api/projects/[id]/module/releases/route.ts` — call shared readiness before compile/build.
- `packages/project-io/src/module-release/build-module-release.ts` — accept/readiness metadata only if builder-level warnings need to surface.
- `apps/studio/src/__tests__/api-routes/api-module-routes.test.ts` — lock readiness failures.
- `packages/project-io/src/__tests__/module-release-builder.test.ts` — lock builder remains focused on artifact assembly after prevalidation.

**Exit Criteria**:

- [x] Module publish rejects unvalidated or invalid saved agent drafts.
- [x] Module publish rejects invalid runtime/canonical LLM model policy.
- [x] Prompt-library ref resolution and publish safety still run after readiness passes.
- [x] Focused module route tests pass.

**Test Strategy**:

- Route: module publish failure cases with readiness issues.
- Unit: builder remains pure and does not independently query DB.
- Regression: successful module publish still produces the same contract/artifact shape.

**Rollback**: Disable module readiness call while leaving export/runtime readiness gates intact; published artifacts remain covered by import validation on consumers.

## 4. Wiring Checklist

- [x] Manual git pull remains unchanged and covered.
- [x] Webhook auto-sync uses the same validators as manual git pull.
- [x] Webhook auto-sync invalidates runtime model cache after model policy mutations.
- [x] Exported runtime config contains portable model descriptors, not source tenant IDs.
- [x] Imported runtime config persists destination tenant IDs only.
- [x] Project model validation follows the `ModelConfig` isolation contract.
- [ ] Async Studio export uses the same invalid-draft guard as sync export.
- [ ] Runtime project-io export uses the same invalid-draft guard as Studio export.
- [ ] Import planning blocks dangling agent prompt-library references.
- [ ] DSL readiness fails closed for non-empty DSL with missing or unknown validation status.
- [ ] Operation-tier overrides reject incompatible `voice` usage for text operations.
- [ ] Direct runtime config PUT invalidates model-resolution caches for model-affecting sections.
- [x] Runtime project-io export uses full project readiness, including runtime config state.
- [x] Runtime-config readiness rejects invalid or incompatible operation-tier overrides.
- [x] Studio agent prompt-ref PATCH validates prompt availability and refreshes draft metadata.
- [x] Model-resolution fallback skips unvalidated/unknown project-agent draft states.
- [x] Export readiness validates canonical `ProjectLLMConfig` alongside `ProjectRuntimeConfig`.
- [x] Runtime model resolution normalizes or rejects invalid canonical operation-tier overrides.
- [x] Deployment creation validates executable-artifact readiness before caching IR.
- [x] Deployment resolution validates executable-artifact readiness before serving cached/versioned IR.
- [x] Legacy agent detail APIs require project scope or fail deterministic ambiguity checks.
- [x] Module release publish uses the shared executable-artifact readiness helper.

## 5. Acceptance Criteria

- [x] Focused Studio route tests pass.
- [x] Focused project-io import/export tests pass.
- [x] Affected files are formatted with Prettier.
- [x] The design prevents source tenant IDs from crossing archive boundaries.
- [ ] Export archives cannot contain known-invalid or unvalidated saved agent drafts.
- [ ] Cross-tenant imports cannot persist dangling prompt-library references.
- [ ] `voice` model tiers are valid for model catalogs but constrained to compatible runtime operations.
- [ ] New runtime sessions observe direct runtime config model-policy updates after cache invalidation.
- [x] Legacy runtime config rows with invalid operation-tier overrides cannot be exported/imported as valid.
- [x] Prompt-ref updates cannot leave a saved agent marked valid while runtime prompt resolution fails.
- [x] Runtime model resolution cannot resolve agent DB configs through unvalidated DSL mappings.
- [x] Canonical `ProjectLLMConfig` cannot bypass runtime/export/import operation-tier compatibility checks.
- [x] Versioned deployment creation and resolution cannot serve sessions with invalid current runtime/model policy.
- [x] Agent detail APIs cannot compile the wrong DSL when duplicate agent names exist across projects in one tenant.
- [x] Module release artifacts cannot be published from a project that export/runtime readiness would reject.

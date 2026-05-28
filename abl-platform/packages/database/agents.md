# agents.md — packages / database

Agent learning journal for this package. Append-only log of architectural decisions, patterns, gotchas, and insights discovered during SDLC work.

Agents MUST read this file before modifying code in this package. Agents MUST append learnings after completing work.

## Lifecycle Inventory — Cross-Boundary Schemas

These Mongoose models and the interfaces describing their documents flow through every layer — write API → store → serializer → SDK → studio prefill → git import/export. Schema changes that miss a consumer historically required multi-commit hardening sweeps. **Before adding or changing a field on any of these, run the Omitted-Edit Audit from `.claude/agents/pr-reviewer.md`** — `rg -l --type ts -e '\bIFact\b' apps packages` and classify every match (UPDATED / CORRECT-UNCHANGED / MISSED).

| Model / Interface                            | Defined in                                     | Boundaries crossed                                                                                    | Past incident                                                                                                                                                                   |
| -------------------------------------------- | ---------------------------------------------- | ----------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `IFact` (Fact model)                         | `src/models/fact.model.ts`                     | runtime fact-store → workflow-engine fact-store-adapter → contact erasure cascade → project-io export | ABLP-643 introduced cross-package consumption (workflow-engine first-class memory); subsequent additive fields must be checked end-to-end                                       |
| All encrypted models (`LLMCredential`, etc.) | `src/models/*.model.ts` with encryption plugin | encryption hooks → store → API response → SDK                                                         | Never use `.lean()` on encrypted models — encryption plugin runs in post-find hooks; `.lean()` returns raw blobs. Hook `.claude/hooks/lean-on-encrypted-models.sh` blocks this. |
| Migration `validate()` methods               | `src/migrations/*`                             | migration runner → CI seed runner → production migration                                              | ABLP-612 (entry below): older `validate()` can become stale after a hardening migration intentionally supersedes an index; revalidation must accept superseding state.          |
| `ChangeLeaseOptions`, lease fence types      | lease-related files                            | migration runner → lease coordination → fence assertions                                              | Changes to lease semantics require coordinated migration runner + caller updates.                                                                                               |

Schema additions on any model also need: (a) tenant-isolation plugin compatibility verified; (b) migration if the field is required; (c) round-trip parity test under `src/__tests__/` exercising `.toJSON()` / `.toObject()`.

---

<!-- Append new entries below this line. Format:
## <DATE> — <Feature/Context>
**Category**: architecture | testing | pattern | gotcha | process
**Learning**: <what was learned — specific and actionable>
**Files**: <key files involved>
**Impact**: <how this affects future work in this package>
-->

## 2026-05-12 — Arch Session Surface-Scoped Index Repair

**Category**: gotcha
**Learning**: Arch AI session uniqueness is scoped by `{tenantId, userId, mode, projectId, surface, agentNameKey, threadId}`. A deployed MongoDB can still have the older `{tenantId, userId, mode, projectId}` unique index, or the intermediate surface-only index, which makes project-level, agent-editor, or hidden-thread sessions collide as `createSession: 409 Conflict`. The runtime Start New path creates a new hidden thread first and only force-archives the legacy scope after a stale-index collision as a pre-production recovery path; `20260512_033_scope_arch_sessions_to_surface` is the manual index repair for environments that can run migrations before production.
**Files**: `src/models/arch-session.model.ts`, `src/migrations/scripts/20260512_033_scope_arch_sessions_to_surface.ts`, `src/__tests__/arch-session-surface-index-migration.test.ts`
**Impact**: Future Arch session scope changes must keep the active Arch model, shared database model, runtime recovery path, and registered index migration aligned. If migrations are unavailable, the recovery button must clear the legacy uniqueness scope before create.

## 2026-05-03 — ABLP-612 Migration Validation Supersession

**Category**: gotcha
**Learning**: Older migration `validate()` methods can become stale after a later hardening migration intentionally supersedes an index. Validation should accept a stronger superseding index state when revalidating historical migrations, while still rejecting missing indexes or unsafe legacy indexes.
**Files**: `src/migrations/scripts/20260227_005_scope_agent_path_to_project.ts`, `src/__tests__/project-agent-path-migration-validation.test.ts`
**Impact**: Future tenant-hardening migrations that replace older project-scoped indexes should update historical validation or add supersession-aware checks so deployment validation does not fail on the intended final schema.

## 2026-04-28 — Authorize at Creation (ABLP-619, FR-9)

**Category**: pattern
**Learning**: Adding a value to the `AUTH_PROFILE_STATUSES` const is non-breaking for Mongoose — existing documents with the prior 4 values continue to validate. ABLP-619 added `'pending_authorization'` (5 values total) without a migration. The const is the single source of truth: `AuthProfileStatusSchema` in `packages/shared/src/services/auth-profile/auth-profile.schema.ts` is sourced from it via `z.enum(AUTH_PROFILE_STATUSES)`. Any caller mocking `@agent-platform/database/models` must declare the const literally in the mock factory (`vi.hoisted` pattern) or the schema's module-init `z.enum()` call will throw.
**Files**: `src/models/AuthProfile.ts`
**Impact**: Future enum extensions on AuthProfile fields should follow the same "additive const + Zod re-derives" pattern. When changing the const, run `rg "vi.mock.*@agent-platform/database/models"` across the repo and update each mock factory's literal in the same change — at least 5 stale-mock failures will surface otherwise (4 surfaced during ABLP-619 Phase 1B).

## 2026-03-22 — Reusable Agent Modules Phase 1

**Category**: architecture
**Learning**: Module schemas (ModuleRelease, ModulePointer, DeploymentModuleSnapshot) use `compressedPayload: Buffer` for storing gzipped IR snapshots. The compression/decompression lifecycle is: `zlib.gzipSync(JSON.stringify(ir))` on write, `JSON.parse(zlib.gunzipSync(buffer))` on read. When reading via Mongoose `.lean()`, the Buffer comes back as MongoDB `Binary` type — must convert with `Buffer.from(raw.buffer ?? raw)` before decompressing.
**Files**: `src/models/module-release.ts`, `src/models/module-pointer.ts`, `src/models/deployment-module-snapshot.ts`
**Impact**: Any new schema using `Buffer` fields will hit the same `.lean()` Binary conversion issue. Always use `Buffer.from(raw.buffer ?? raw)` when reading compressed fields via `.lean()`.

**Category**: testing
**Learning**: Database package has 66 module-related tests covering: ModuleRelease CRUD + version validation, ModulePointer resolution + alias uniqueness, DeploymentModuleSnapshot lifecycle + tenant isolation. Tests use MongoMemoryServer directly (no HTTP layer needed since this is a data-access package).
**Files**: `src/__tests__/module-release.test.ts`, `src/__tests__/module-pointer.test.ts`, `src/__tests__/deployment-module-snapshot.test.ts`
**Impact**: Follow the same MongoMemoryServer pattern for new model tests. Tenant isolation tests should verify cross-tenant queries return empty/null, not 403.

---

## 2026-03-22 — Reusable Agent Modules Phase 2 Sprint 1

**Category**: architecture
**Learning**: Added `moduleReleaseIds: [String]` to `DeploymentModuleSnapshotSchema` with index `{ moduleReleaseIds: 1 }`. This denormalized array enables reverse dependency queries ("which deployments use release X?") without decompressing gzip payloads. The field is populated by `deployment-build-service.ts` in runtime from the set of unique release IDs across mounted agents and tools. Additive change — no migration needed, default is `[]`.
**Files**: `src/models/deployment-module-snapshot.model.ts`
**Impact**: When adding similar denormalized fields for query optimization, use `[String]` with a separate index rather than embedding in the compressed payload. The schema remains backward-compatible with existing snapshots that lack this field.

---

## 2026-03-24 — SharePoint Connector UX Wave 1 (T-07)

**Category**: pattern
**Learning**: New models that need `getLazyModel()` in SearchAI must (1) call `ModelRegistry.registerModelDefinition()` in the model file itself, and (2) be exported from both `src/index.ts` (main barrel) and optionally `src/models/index.ts` (models barrel). The `import('@agent-platform/database')` in SearchAI's `initMongoBackend` triggers the side-effect registration before `bindModelsForSearchAI`. The ConnectorAuditEntry and ConnectorConfigVersion models both follow this pattern — they are NOT explicitly registered in `apps/search-ai/src/db/index.ts`.
**Files**: `src/models/connector-config-version.model.ts`, `src/index.ts`
**Impact**: When adding new platform-affinity models for SearchAI, export from `src/index.ts` and self-register with ModelRegistry in the model file. No manual registration in `db/index.ts` needed.

---

## 2026-03-24 — Omnichannel Gap Closure Phase 2 (GDPR Cascade)

**Category**: gotcha
**Learning**: When adding new models to the dynamic import destructuring in `cascade-delete.ts`, you MUST also add matching mock entries to ALL THREE cascade test files: `mongo-cascade.test.ts`, `cascade-delete-auth-profile.test.ts`, and `cascade-delete-modules.test.ts`. Each file has its own `vi.mock('../models/index.js', ...)` that must include every model used by any cascade function. Missing a mock entry causes "No export defined on mock" errors at runtime.
**Files**: `src/cascade/cascade-delete.ts`, `src/__tests__/mongo-cascade.test.ts`, `src/__tests__/cascade-delete-auth-profile.test.ts`, `src/__tests__/cascade-delete-modules.test.ts`
**Impact**: Any future additions to cascade-delete.ts (new model imports) must update all three test files' mocks.

**Category**: gotcha
**Learning**: The LLD referenced `OmnichannelAuditEvent` as a Mongoose model to anonymize in GDPR cascade, but this model does not exist. Omnichannel audit events use an in-memory ring buffer in `apps/runtime/src/services/omnichannel/omnichannel-audit.ts`, not a MongoDB collection. Always verify model existence in `packages/database/src/models/index.ts` before referencing in cascade delete.
**Files**: `src/models/index.ts`, `apps/runtime/src/services/omnichannel/omnichannel-audit.ts`
**Impact**: If omnichannel audit events are ever persisted to MongoDB, a new model and cascade entry will be needed.

---

## 2026-03-26 — Cross-pod DEK Cache Invalidation

**Category**: pattern
**Learning**: DEKManager follows the same `InvalidationTransport` injection pattern as KMSResolver for cross-pod cache invalidation. The transport is injected via `setInvalidationTransport()` (not constructor) so that `packages/database` never imports Redis directly. The channel `kms:dek:invalidate` is separate from `kms:config:invalidate` (used by KMSResolver). Both channels are needed — one invalidates DEK caches, the other invalidates KMS config resolution caches.
**Files**: `src/kms/dek-manager.ts`, `src/kms/kms-resolver.ts`
**Impact**: When adding new cache invalidation needs to KMS components, follow the same transport injection pattern. The app layer (runtime/server.ts) creates the Redis transport and injects it.

---

## 2026-04-05 — Web SDK Channel Parity Slice 2

**Category**: architecture
**Learning**: `WidgetConfig` is now a tenant-scoped model, not just project-scoped. The schema needs a required `tenantId`, the shared `tenantIsolationPlugin`, and a tenant-aware secondary index so repo code can enforce tenant scoping at query time instead of relying on upstream route checks.
**Files**: `src/models/widget-config.model.ts`, `src/__tests__/model-misc.test.ts`
**Impact**: Any future `WidgetConfig` read/write path must include `tenantId` in its filter or payload. Legacy records without `tenantId` need migration before non-scoped fallbacks can be removed safely.

## 2026-04-06 — Web SDK Channel Parity Slice 7

**Category**: gotcha
**Learning**: `PublicApiKey` needs setter-level normalization for `allowedOrigins` and `permissions` because old Studio writes could double-serialize those fields (`['["https://..."]']` and `'{"chat":true,...}'`). Export the normalizers from the models barrel so repos and repair scripts can reuse the exact same decode logic when reading legacy records or backfilling stored data.
**Files**: `src/models/public-api-key.model.ts`, `src/models/index.ts`
**Impact**: Future schema hardening for persisted SDK key metadata should happen at the model seam first, with reusable normalizers exposed for app-layer repos and migration tools instead of duplicating ad-hoc parsing in routes.

## 2026-04-06 — SDK Channel Config Should Carry Typed Convenience Fields

**Category**: architecture
**Learning**: `SDKChannel.config` remains a flexible `Schema.Types.Mixed` persistence seam, but the TypeScript model interface should still capture known contract fields such as `rateLimitRpm` instead of falling back to `any`. That keeps runtime route helpers and Studio admin clients aligned on additive config-backed fields without forcing a schema migration or creating a parallel top-level column.
**Files**: `src/models/sdk-channel.model.ts`
**Impact**: Future SDK-channel settings that live inside `config` should extend the typed config interface first. Preserve the mixed storage model in Mongo, but avoid `any` in the app contract so repo-layer convenience fields stay type-safe.

## 2026-04-14 -- ProjectMember Custom Role Schema Guards (ABLP-254)

**Category**: architecture, gotcha
**Learning**: The `ProjectMember` model now supports `role: 'custom'` with a mandatory `customRoleId` reference. Schema invariant: `role === 'custom' <=> customRoleId !== null`. This is enforced by both `pre('validate')` (for creates) and `pre('findOneAndUpdate')` (for updates). The update hook must read the current document to compute effective state when only one field is being updated. Without these guards, it is possible to set `role: 'custom'` without a `customRoleId`, or to have a stale `customRoleId` on a built-in role.
**Files**: `src/models/project-member.model.ts`
**Impact**: When extending `ProjectMember` with new fields that depend on `role`, follow the same dual-hook pattern. The `pre('findOneAndUpdate')` hook must reconstruct effective state from current + update to validate correctly.

## 2026-04-15 -- Seed Entrypoint Helper Modules

**Category**: gotcha
**Learning**: `packages/database/seed-mongo.ts` imports helper scripts as modules at runtime, not just as CLI entrypoints. Any helper used this way must export the exact functions that `seed-mongo` expects and must guard its CLI runner with an `isMainModule()` check. Otherwise the module will either auto-run on import or fail seed validation with missing exports, which breaks `seed-mongo.entrypoint.test.ts`.
**Files**: `packages/database/seed-mongo.ts`, `packages/database/seed-prompt-templates.ts`, `scripts/rbac-tool-permissions.ts`
**Impact**: When adding or refactoring seed helper scripts, treat them as dual-use modules: import-safe library surface first, CLI wrapper second. Always add explicit exported validators/manifest helpers if `seed-mongo` relies on them during validation.

## 2026-04-14 — Workflow-as-Tool Webhook Trigger Fields

**Category**: gotcha
**Learning**: `@agent-platform/database` cannot depend on `@agent-platform/shared` because of a circular dependency chain: database -> shared -> shared-auth-profile -> database. When database models need to mirror constants from shared (e.g., TRIGGER_TYPES, WEBHOOK_MODES), define them locally in the model file with a JSDoc comment noting the canonical source. The values in shared and database must be kept in sync manually.
**Files**: `src/models/workflow-execution.model.ts`, `src/models/trigger-registration.model.ts`
**Impact**: Any future addition of shared constants to database models must use local definitions, not imports from `@agent-platform/shared`. If a shared constants package below database in the dep graph is created, this constraint can be relaxed.

**Category**: architecture
**Learning**: `trigger-registration.model.ts` renamed `strategy` field to `triggerType` and narrowed the enum from `['webhook','polling','cron','event','connector']` to `['webhook','cron','event']` (REGISTRATION_TRIGGER_TYPES). The old values `polling` and `connector` are now mapped to `cron` and `event` respectively. A MongoDB migration is needed to update existing documents. Consumers in `apps/workflow-engine/` that reference `.strategy` must be updated to `.triggerType`.
**Files**: `src/models/trigger-registration.model.ts`, `src/models/index.ts`
**Impact**: Any code referencing `ITriggerRegistration.strategy` will get a TypeScript error and must be updated to use `.triggerType`.

## 2026-04-15 — Workflow Versioning Phase 1: Data Model & Indexes

**Category**: architecture
**Learning**: `WorkflowVersionStatus` (5-enum: draft/testing/staged/active/deprecated) replaced with `WorkflowVersionState` (2-enum: active/inactive). The `state` field is optional (not required in schema) because draft versions have no lifecycle state — only published versions use state. Old fields `status`, `promotedAt`, `promotedBy` removed; new fields added: `state`, `environment`, `deploymentId`, `triggers` (sub-schema array), `deleted`, `publishedAt`, `publishedBy`. Workflow model got soft-delete fields (`deleted`, `deletedAt`, `tags`). TriggerRegistration got `workflowVersionId`, `workflowVersion`, and `'inactive'` status.
**Files**: `src/models/workflow-version.model.ts`, `src/models/workflow.model.ts`, `src/models/trigger-registration.model.ts`, `src/models/index.ts`
**Impact**: Downstream consumers that used `WorkflowVersionStatus` need to switch to `WorkflowVersionState`. Any queries using the old `status` field on workflow versions need updating to use `state`. All new fields have defaults so existing documents remain backward-compatible without migration.

## 2026-04-16 — Mongoose strict:true Silent Field Drops

**Category**: gotcha
**Learning**: Mongoose `strict: true` (default) silently strips unknown fields from `$set` and `$setOnInsert`. This was found in `workflow-execution.model.ts` where route handlers wrote `cancelledAt` and 4 approval metadata fields to `nodeExecutions.$` but the schema didn't define them — all silently lost.
**Files**: `src/models/workflow-execution.model.ts`
**Impact**:

- When adding fields that are written by `findOneAndUpdate()` or `updateOne()`, always add them to both the TypeScript interface and the Mongoose schema definition in the same change.
- Sub-schemas (like `NodeExecutionSchema` with `{ _id: false }`) inherit the parent's strict setting. They are NOT exempt from this rule.

## 2026-04-19 — ABL Contract Hardening Phase 3 (session-state thread metadata)

**Category**: architecture
**Learning**: Runtime thread states and cold-store thread states must evolve together. Once runtime started persisting `suspended` / `human_agent` statuses plus per-thread resume metadata, `SessionStateThreadSchema` had to add both the widened status enum and a `threadMetadata` buffer or cold rehydration would silently drop the state needed for async handoff and attachment resume flows.
**Files**: `src/models/session-state.model.ts`
**Impact**: Any future thread-level runtime state added in `apps/runtime` must update the database thread schema in the same slice; otherwise Mongoose strict mode will silently discard it on save.

**Category**: gotcha
**Learning**: Embedded thread buffers in `session_states` still sit outside the application-layer encryption plugin. Adding `threadMetadata` means that metadata buffer follows the same protection model as `threads[].dataValues`, `threads[].state`, and `threads[].conversationHistory`: MongoDB at-rest encryption plus top-level `stateData` coverage for the core session state.
**Files**: `src/models/session-state.model.ts`
**Impact**: Future sensitive thread-only buffers should be treated as embedded cold-store data, not assumed to be covered by the top-level encryption plugin automatically.

## 2026-04-20 — `NodeExecutionSchema.mappingErrors` (ABLP-2, start/end first-class steps)

**Category**: reference
**Learning**: `NodeExecutionSchema` now declares `mappingErrors: { type: [Schema.Types.Mixed] }` — an optional per-record array used by boundary-step (Start/End) lifecycle persistence. On Start, stores field-level input validation errors (`{name, error}`, no `expression`). On End, stores per-output-mapping expression evaluation errors (`{name, expression, error}`). The matching TypeScript interface field is `INodeExecution.mappingErrors?: Array<{ name: string; expression?: string; error: string }>`.
**Files**: `src/models/workflow-execution.model.ts:92, 178`
**Impact**: When Mongoose defaults a Mixed array to `[]`, happy-path records carry `mappingErrors: []` (not `undefined`). Tests asserting "no errors" should use `mappingErrors ?? []).toEqual([])` rather than `toBeUndefined()`.

---

**Category**: architecture
**Learning**: Workflow Event Outbox collection (ABLP-2 Phase 2/3). `packages/database/src/models/workflow-event-outbox.model.ts` is the Mongo outbox collection for the workflow-execution-event-sourcing tiered-storage feature. `_id = event.event_id` (UUIDv7) — this is the dedup contract between the Mongo outbox and the Kafka event payload, carried through to CH. Three indexes: (1) `{occurredAt: 1}` with partial filter `{publishedAt: null}` — poller hot path for "oldest unpublished"; (2) `{expiresAt: 1}` TTL with partial filter `{publishedAt: {$type: 'date'}}` — reaps published rows without touching unpublished; (3) `{tenantId, entityKind, entityId, occurredAt}` for per-entity ordering. Partial-filter operator MUST be `$type: 'date'` — Mongo rejects `$ne` in partial filters.
**Files**: `src/models/workflow-event-outbox.model.ts`
**Impact**: Future outbox-style collections should follow this 3-index pattern (hot-path + TTL + per-entity). Never use `$ne` in a partial filter.

---

**Category**: architecture
**Learning**: Optional-method extension on `EventCascadeHook` (ABLP-2 Phase 3). `EventCascadeHook.deleteByExecutionIds?` is marked optional at the interface boundary, so existing hook implementations (e.g. the runtime's platform eventstore hook) continue to work without modification. Callers MUST use optional chaining: `hook.deleteByExecutionIds?.(tenantId, executionIds)`. This is the preferred pattern for additive interface extensions — avoid forcing consumers to update every implementation in the same commit.
**Files**: `src/cascade/event-cascade-hooks.ts`, `src/cascade/cascade-delete.ts`
**Impact**: Any new cascade method (e.g. `deleteByFoo`) should follow this pattern — mark the method `?`, document the optional-chaining contract on the interface, register real implementations in the owning app's `eventstore-singleton.ts`.

---

**Category**: gotcha
**Learning**: Flag-gated TTL indexes on `workflow_executions` + `human_tasks` (ABLP-2 Phase 6). The TTL `Schema.index()` calls are wrapped in `if (process.env.WORKFLOW_MONGO_TTL_ENABLED === 'true')`. This means the index is created at schema-load time ONLY when the flag is on at boot. Flipping the flag after boot does NOT retroactively create the index — a pod restart is required. Operators: set the flag before restart, not after. Also: the `expiresAt: Date | null` column is always present regardless of flag — only index creation + population (via `computeExecutionExpiresAt` / `computeHumanTaskExpiresAt`) is flag-gated.
**Files**: `src/models/workflow-execution.model.ts`, `src/models/human-task.model.ts`
**Impact**: Document the flag-flip-requires-restart behavior when the feature is rolled out. For tests: set the env var before importing the models.

---

**Category**: architecture
**Learning**: `cascade-delete.ts:deleteTenant()` now drops the 3 workflow-event-sourcing Mongo collections (`workflow_executions`, `human_tasks WHERE mailbox='workflow'`, `workflow_event_outbox`) in addition to its existing cascade chain. The eventstore hook (`getEventCascadeHook().deleteTenant`) handles the CH side separately. Scope guard: agent-mailbox human tasks (`mailbox !== 'workflow'`) are explicitly untouched — they belong to the Memory & Sessions feature's cascade.
**Files**: `src/cascade/cascade-delete.ts`
**Impact**: Any future Mongo collection added to the tenant cascade MUST be added here. Scoped deletes (like `human_tasks WHERE mailbox='workflow'`) need an explicit filter — blanket `deleteMany({tenantId})` would overreach into out-of-scope data.

---

## 2026-04-24 — New mongo migrations require a twin entry in `MONGO_MIGRATION_METADATA`

**Category**: gotcha
**Learning**: Adding a migration to `src/migrations/registry.ts` (new import + new entry in `mongoMigrationRegistry`) is only half the wiring. `src/change-management/manifest.ts` iterates `mongoMigrationRegistry.map((spec) => { const metadata = MONGO_MIGRATION_METADATA[spec.manifestId]; return createEntry({ ..., kind: metadata.kind, ... }); })`. If a new migration is not in `MONGO_MIGRATION_METADATA`, `metadata.kind` throws `TypeError: Cannot read properties of undefined (reading 'kind')` at module load. This surfaces not at typecheck time but during Next.js `Collecting page data` (Studio build) and during any test that imports `@agent-platform/database`'s barrel, so the failure looks unrelated to the migration at first glance.
**Files**: `src/migrations/registry.ts`, `src/change-management/manifest.ts`
**Impact**: Every new migration PR must touch BOTH files. When spawning agents to add a migration, include the manifest requirement explicitly. Reference incident: ABLP-529 (refresh-token family/generation) shipped the registry entry without the manifest entry; the studio Next.js build blew up with a compiled-chunk stack trace that gave no direct hint about the manifest; a follow-up commit (ABLP-144 `fix(runtime): unblock voice parity test loading`) added the missing metadata entry for `mongodb.20260423_020.refresh-token-family-generation`.

## 2026-04-26 — Tenant-aware `_id` lookups for ServiceNode and AgentLock

**Category**: architecture
**Learning**: When a previously project-only Mongo model becomes tenant-scoped, the hardening has to happen at the full seam: add a required `tenantId` field on the schema, apply `tenantIsolationPlugin`, update any encryption plugin config to use project scope if the model stores encrypted project data, and give callers an explicit replacement for `_id`-only reads. `BaseModel.findOneScoped({ _id, tenantId })` is the sanctioned replacement for tenant-scoped repos; `_id`-only `findById()` should remain deprecated, not reintroduced in new code.
**Files**: `src/models/service-node.model.ts`, `src/models/agent-lock.model.ts`, `src/mongo/base-model.ts`
**Impact**: Future tenant hardening work should ship schema/plugin/query-primitive updates together. Adding `tenantId` without a tenant-aware lookup API or plugin wiring just moves the isolation bug to the next caller.

## 2026-04-26 — ServiceNode/AgentLock Tenant Backfill Migration

**Category**: process
**Learning**: Backfilling newly required `tenantId` fields on historical collections should use batched `_id` pagination plus a `projectId -> Project.tenantId` map per batch, and validation should count only rows whose parent project actually has a tenant to copy from. The migration is deploy-order sensitive: ship the schema/index hardening first so new writes already carry `tenantId`, then run the backfill as a post-deploy change-management step.
**Files**: `src/migrations/scripts/20260426_022_backfill_service_node_agent_lock_tenant_ids.ts`, `src/migrations/registry.ts`, `src/change-management/manifest.ts`, `src/__tests__/service-node-agent-lock-tenant-backfill-migration.test.ts`
**Impact**: Future tenant-hardening migrations should pair the data backfill with both registry and manifest wiring in the same change and should document the “deploy schema first, backfill second” run order up front rather than leaving migration sequencing implicit.

## 2026-04-26 — Encryption-at-Rest Hardening: KMS AAD + Plaintext Backfill

**Category**: gotcha
**Learning**: The `authConfigEncrypted` decrypt path in `KMSProviderPool` only has tenant scope if callers pass it through. `DEKManager` must call `getProvider(config, tenantId)` so `resolveAuthConfig()` can bind the logical KMS AAD context `{ tenantId, resourceType: 'kms-provider', fieldName: 'authConfigEncrypted' }`. `decryptAuthConfig()` intentionally falls back to no-AAD only on GCM auth-tag mismatch so legacy blobs remain readable until the write path is upgraded.
**Files**: `src/kms/types.ts`, `src/kms/auth-config-crypto.ts`, `src/kms/kms-provider-pool.ts`, `src/kms/dek-manager.ts`, `src/kms/local-kms-provider.ts`, `src/__tests__/local-kms-provider.test.ts`
**Impact**: Any future writer of `authConfigEncrypted` (for example admin routes or materializers) must use the same logical AAD context or new decrypts will keep depending on the legacy fallback path.

**Category**: process
**Learning**: For Mongoose-plugin encryption backfills, do not hand-roll ciphertext in raw Mongo updates. The safe pattern is: initialize the DEK facade inside the migration, scan raw collections for plaintext candidates, load the matching docs through their tenant-scoped models, and call `save()` so the real plugin re-encrypts the fields. This avoids duplicating scope resolution and AAD logic in migration code.
**Files**: `src/migrations/scripts/20260426_023_backfill_encrypted_custom_headers_auth_config.ts`, `src/migrations/registry.ts`, `src/__tests__/encryption-at-rest-hardening.regression.test.ts`
**Impact**: Future encrypted-field migrations should reuse this “raw detect, model save, validate remaining plaintext count” pattern instead of patching ciphertext directly in migration scripts.

## 2026-04-26 — Session Source Ownership Discriminator

**Category**: architecture
**Learning**: `Session.source` is the ownership discriminator for session-derived resources. `source.type === 'studio'` means the session is project-owned and access should be checked with `tenantId + projectId + project RBAC`, not `initiatedById`. `source.type === 'public' | 'channel'` means access follows the end-user/contact identity carried by the session.
**Files**: `src/models/session.model.ts`
**Impact**: Any new session-derived collection should copy or join back to this discriminator before enforcing ACLs. Do not assume all session rows are workspace-user-owned just because they have `initiatedById`.

## 2026-04-28 — Prompt Library: tenantIsolationPlugin on Top-Level Resources

**Category**: pattern
**Learning**: Both `PromptLibraryItem` and `PromptLibraryVersion` models use `tenantIsolationPlugin` (matching `WorkflowVersion`, NOT `AgentVersion`). `AgentVersion` is a child-of-agent document that relies on its parent for tenant scoping — that pattern is wrong for top-level project resources. New project-scoped resource models must use `tenantIsolationPlugin` explicitly.
**Files**: `src/models/prompt-library-item.model.ts`, `src/models/prompt-library-version.model.ts`
**Impact**: When adding a new top-level project resource (not a child document), always apply `tenantIsolationPlugin` directly to the model. Do not assume parent-resource tenant scoping is inherited.

## 2026-04-28 — Prompt Library: Test Files Live in src/**tests**, Not src/models/**tests**

**Category**: gotcha
**Learning**: Database model unit tests live in `packages/database/src/__tests__/` (e.g., `model-prompt-library-item.test.ts`), not in `src/models/__tests__/`. Doc-generated test paths based on model file location (`src/models/__tests__/`) will be wrong. The naming convention is `model-<resource-name>.test.ts` in the package-level `__tests__` directory.
**Files**: `src/__tests__/model-prompt-library-item.test.ts`, `src/__tests__/model-prompt-library-version.test.ts`
**Impact**: When writing test specs or docs that reference database model tests, always use `src/__tests__/model-<name>.test.ts`, not `src/models/__tests__/<name>.model.test.ts`.

## 2026-04-28 — External Agent Registry: Model + Cascade Delete

**Category**: pattern
**Learning**: `ExternalAgentConfig` model follows the same pattern as `MCPServerConfig` — uuidv7 IDs, tenantIsolationPlugin + encryptionPlugin (project scope), timestamps with collection name. The cascade-delete.ts file was missing MCPServerConfig from both `deleteProject()` and `deleteTenant()` — both were added alongside ExternalAgentConfig. When adding new project-scoped models, always check cascade-delete.ts for BOTH functions.
**Files**: `src/models/external-agent-config.model.ts`, `src/models/index.ts`, `src/cascade/cascade-delete.ts`
**Impact**: Always add new models to both `deleteProject()` and `deleteTenant()` in cascade-delete.ts. The encryptionPlugin with `scope: 'project'` requires `scopeFields: { tenantId: 'tenantId', projectId: 'projectId' }`.

## 2026-04-28 — External Agent Registry: Model Schema Tests

**Category**: testing
**Learning**: LLD specified `packages/database/src/models/__tests__/external-agent-config.test.ts` but existing tests are at `packages/database/src/__tests__/`. Created the `models/__tests__/` directory per the LLD path. The test is a pure schema verification test (no MongoDB needed) — validates fields, indexes, enum constraints, plugins, collection name, timestamps, and defaults via `ExternalAgentConfig.schema`. When checking `schema.indexes()`, avoid destructuring array elements directly — use `idx[0]` and `idx[1]` with explicit type casts to `Record<string, unknown>` to avoid TS7031 implicit-any binding errors.
**Files**: `src/models/__tests__/external-agent-config.test.ts`
**Impact**: Future model schema tests can use the same pattern — pure schema tests are fast and require no infrastructure. The `schema.indexes()` return type is loosely typed in Mongoose — always cast index tuple elements.

---

**Date**: 2026-04-29
**Feature**: Agent Governance Dashboard (ABLP-698)
**Category**: architecture

**Learning**: Added three governance Mongoose models: `governance-policy.model.ts` (with METRIC_REGISTRY canonical column names), `governance-override.model.ts`, `governance-policy-version.model.ts`. All use `tenantIsolationPlugin`. METRIC_REGISTRY is the single source of truth for valid ClickHouse column names per pipeline type — Studio must mirror this exactly. Policy versions snapshot on every PUT via an append-only `governance_policy_versions` collection to support `thresholdAtTime` resolution in audit queries.
**Files**: `src/models/governance-policy.model.ts`, `src/models/governance-override.model.ts`, `src/models/governance-policy-version.model.ts`
**Impact**: Future compliance-related models that need historical point-in-time values should follow the same append-only version snapshot pattern.

## 2026-04-29 — Multimodal Vision Enhancement: frameStorageKeys on Attachment

**Category**: architecture
**Learning**: `IAttachment.frameStorageKeys: string[]` is a new `[String]` array field with `default: []`. Stores S3 keys for video key frame PNGs uploaded during `processVideo()`. The field is additive — no migration needed since Mongoose defaults missing values to `[]`. Frame keys follow the `deriveStorageKey(storageKey, 'frame-{i}')` pattern, producing paths like `{tenant}/{project}/{session}/{att}/frame-0`.
**Files**: `src/models/attachment.model.ts`
**Impact**: Consumers reading attachments should use optional chaining (`attachment.frameStorageKeys?.length`) for backward compatibility with documents created before this field existed.

---

## 2026-04-25 — Agent Assist binding model + per-project settings (ABLP-390)

**Category**: architecture
**Learning**: The Agent Assist V1 facade introduces two related models on `agent_assist_bindings` and `project_agent_assist_settings` collections. Key design points: (1) `agent-assist-binding.model.ts` uses kebab-case filename + `.model.ts` suffix to match the package convention; the Mongoose model name `AgentAssistBinding` (PascalCase, no suffix). The `mongoose.models.AgentAssistBinding ?? model('AgentAssistBinding', schema)` guard is required for HMR + repeated `connect()` calls in tests. (2) Both schemas use `tenantIsolationPlugin` + `auditTrailPlugin` so cross-tenant reads are blocked even when caller forgets the `tenantId` filter. (3) `apiKeyPrefix` (default null) was added in a follow-up so the UI can show the recognizable plaintext prefix of the API key (e.g. `abl_f931…`) instead of an opaque ApiKey doc-id last-4 — the prefix is written by the runtime route at mint/rotate time, never by the user. (4) Unique compound index `(tenantId, appId, environment)` enforces "one binding per app-environment per tenant"; duplicate inserts surface as Mongo E11000 → repo translates to `AgentAssistBindingDuplicateError`.
**Files**: `src/models/agent-assist-binding.model.ts`, `src/models/project-agent-assist-settings.model.ts`, `src/models/index.ts` (barrel export)
**Impact**: When adding a new binding-style model (one that maps an external identifier to a project), follow this template: kebab-case `*.model.ts` filename, PascalCase Mongoose model name, both isolation plugins applied, prefix or fingerprint column for any opaque credential the UI will display, a unique compound index that includes `tenantId`. The credential-prefix-on-binding pattern is reusable for any future "tenant-scoped opaque key" the UI needs to identify post-issuance.

## 2026-04-27 — Fact Tombstone Fields

**Category**: schema
**Learning**: `IFact` now carries optional `isDeleted: boolean` and `deletedAt: Date` tombstone fields. Both default to `undefined` so existing documents read identically; new fact-store reads filter on `{ isDeleted: { $ne: true } }`. The TTL index on `expiresAt` continues to govern document removal — tombstones still expire normally.
**Files**: `src/models/fact.model.ts`
**Impact**: Schema is purely additive — no migration required. Surviving documents post-rollback remain valid (the new fields are simply absent and the read filter `{ $ne: true }` correctly includes them). The unique compound index `{ tenantId, userId, projectId, scope, key }` is unchanged — a tombstone shares the same compound key as the live fact it replaced (one-or-the-other invariant preserved by the `_setInternal` upsert that `$unset`s the tombstone fields when a key is rewritten).

## 2026-05-09 — PII Detection Tiered Recognizers (Mongoose default convention)

**Category**: pattern
**Learning**: `IPIIRedactionConfig` (`packages/database/src/models/project-runtime-config.model.ts:49-53`) and its Mongoose schema `PIIRedactionConfigSchema` (lines 199-206) are extended additively for ABLP-921 (PII tiered recognizers) with four optional fields (`tier`, `latency_budget_ms`, `confidence_threshold`, `enabled_recognizer_packs`). Existing optional fields in this file consistently use **`default: undefined`** at the Mongoose layer (verified at `currency_api_url` line 194, `table_name` line 213, `endpoint` line 214). The new fields follow the same pattern; the actual defaults (`'basic'` / `200` / `0.5` / `['core']`) are applied at the runtime mapper layer (`mapProjectPIIRedactionConfig` in `apps/runtime/.../session-pii-context.ts`) via `??` fallbacks — single source of default truth. The schema-level `default: () => ({})` on `PIIRedactionConfigSchema` (existing) ensures the subdocument exists for legacy documents without `pii_redaction` at all.
**Files**: `src/models/project-runtime-config.model.ts`
**Impact**: When adding optional fields to existing Mongoose schemas in this package, prefer `default: undefined` and apply the real default in the runtime mapper. This keeps the DB shape minimal and the mapper authoritative for default semantics.

## 2026-05-09 — PII redaction config additive extensions (ABLP-921 Phase 1b)

Extending `IPIIRedactionConfig` and `PIIRedactionConfigSchema` with the four new fields (`tier`, `latency_budget_ms`, `confidence_threshold`, `enabled_recognizer_packs`) follows the existing **`default: undefined` Mongoose pattern** seen at `currency_api_url`, `table_name`, `endpoint` (lines 194/213/214 of project-runtime-config.model.ts). The defaults `'basic'` / `200` / `0.5` / `['core']` are applied at read time by `mapProjectPIIRedactionConfig()` in the runtime — no DB migration required (LLD D-10).

Indexes unchanged on `pii-audit-log.model.ts` and `pii-token-vault.model.ts` after adding `confidence` / `recognizer` columns; readers tolerating missing fields cover legacy documents.

## 2026-05-11 — ABLP-947 Session KnownSource Field

**Category**: schema
**Learning**: Added `KnownSessionSource` type (`'production' | 'eval' | 'synthetic'`) and `knownSource` field to `ISession` interface and Mongoose schema. The field is orthogonal to the existing `SessionSource` discriminated union — `SessionSource` captures WHERE traffic entered (studio/public/channel), `knownSource` captures WHY the session exists (production/eval/synthetic). The field uses `{ type: String, default: null, enum: [null, 'production', 'eval', 'synthetic'], index: true }` — null means "production" (backward-compatible default). The type is also exported from the barrel `index.ts`.
**Files**: `src/models/session.model.ts`, `src/models/index.ts`
**Impact**: When adding future session-purpose tags, extend the enum in both the Mongoose schema and the `KnownSessionSource` type. Consumers that need the type should import from `@agent-platform/database`. The parallel type in `@abl/compiler` (`packages/compiler/src/platform/core/types.ts`) must be kept in sync manually.

## 2026-05-11 — Eval Retention Tenant Contract

**Category**: architecture
**Learning**: Eval retention belongs in `Tenant.settings.evalRetention` as a typed mixed-settings slice rather than a separate collection. The shared resolver in `src/eval-retention.ts` centralizes defaults, min/max validation, and the invariant that synthetic retention must be shorter than normal eval retention.
**Files**: `src/eval-retention.ts`, `src/models/tenant.model.ts`, `src/constants/eval-limits.ts`
**Impact**: Future eval-retention consumers should call `resolveEvalRetentionContract()` instead of reading raw settings, otherwise bounds and synthetic-shorter validation can drift.

**Category**: pattern
**Learning**: Database model hooks cannot safely depend on runtime/compiler PII services without creating package cycles. Eval definition PII masking uses a small local regex scrubber as a v0 bridge and gates it by tenant settings via a raw `tenants` collection lookup.
**Files**: `src/eval-pii-scrubber.ts`, `src/models/eval-persona.model.ts`, `src/models/eval-scenario.model.ts`
**Impact**: If the richer PII detector is needed here, extract it into a dependency-safe shared package first; do not import runtime or compiler services from database models.

---

**Category**: architecture
**Learning**: The AuthProfile pre-save hook is the cache-invalidation contract for downstream credential caches keyed on `{tenantId, profileId, profileVersion, scopeHash}`. It increments `profileVersion` whenever ANY of `config`, `encryptedSecrets`, `status`, or `enabled` is modified. Touch-only writes (`lastUsedAt`, `lastValidatedAt`) deliberately do not bump it. `findOneAndUpdate` bypasses Mongoose middleware and therefore the hook — bulk operations that need the version bump must go through `doc.save()` instead.
**Files**: `src/models/auth-profile.model.ts` (pre-save hook), `src/__tests__/auth-profile-version-bump.test.ts`
**Impact**: Adding a new mutable field that should invalidate caches → add it to the OR chain in the pre-save hook AND add a corresponding test case. Adding a touch-only audit field → no hook change needed but add a regression test that it does NOT bump the version.

---

## ABLP-1145 — Platform Access Policy Extension (2026-05-21)

### What changed

Added email-level allowlisting and invitation bypass to `platform-access-policy.ts`:

- New functions: `addAllowedEmail`, `revokeAllowedEmail`, `listAllowedEmails`, `isAllowlistedEmail`, `hasValidInvitationForEmail`, `canUserCreateWorkspace`
- Updated `isEmailAllowedForAuth` signature: `(email, opts?: { bootstrapUserIds?, inviteToken? })`
- Updated `PlatformAccessPolicy` interface to include `allowedEmails`
- New model: `platform-allowed-email.model.ts`

### Learnings

**New functions must be re-exported from `src/index.ts`**: When adding exported functions to `platform-access-policy.ts`, they must also be added to the package's `src/index.ts` re-export block. This was missed initially and caught during spec compliance review.

**Token hashing location**: The `hashInviteToken` helper (SHA-256) lives in `platform-access-policy.ts` and is intentionally NOT exported. The DB layer handles all token hashing — callers pass raw tokens, the policy layer hashes them before DB lookup. The `WorkspaceInvitation` model stores hashed tokens.

**Test pattern for MongoMemoryServer**: Tests use `isMongoReady()` guard at the start of each test body to skip gracefully if Mongo setup failed. This pattern is in `__tests__/helpers/setup-mongo.ts`.

**`addAllowedEmail` uses upsert**: The implementation uses `findOneAndUpdate` with `{ upsert: true }` making re-allowlisting after revoke idempotent. Pattern is intentional — do NOT change to insert.

---

## 2026-05-15 — ConnectorConnection Cost-Cap Fields (Phase 3) — ABLP-1073

**Category**: pattern | gotcha
**Learning**: `ConnectorConnection` gained four optional fields for Azure DI cost capping: `usageCount`, `usagePeriodStart`, `usageSoftCap`, `usageHardCap`. Updates use Mongo `$inc` / `$set` directly — Mongoose `strict` mode does NOT block `$inc` on undeclared fields, so the schema declarations exist for TypeScript type-safety on `IConnectorConnection` (not for write-time validation). The month-boundary CAS reset pattern: `findOneAndUpdate({ _id, tenantId, projectId, status: 'active', $or: [{ usagePeriodStart: null }, { usagePeriodStart: { $exists: false } }, { usagePeriodStart: { $lt: currentMonthStart } }] }, { $set: { usageCount: 1, usagePeriodStart: currentMonthStart } })` — exactly one caller wins the race on day 1 of a new month; everyone else falls through to a `$inc`. `usageHardCap: 0` and `usageSoftCap: 0` are deliberately allowed by the route's Zod `min(0)` — admins use 0 as an emergency kill switch.
**Files**: `src/models/connector-connection.model.ts`, `apps/workflow-engine/src/services/azure-di-usage-counter.ts`.
**Impact**: Future per-connection counters should reuse the CAS-reset pattern (or the same counter service). Schema declarations are purely for TS typing — don't rely on Mongoose to validate undeclared writes.

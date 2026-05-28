# Reusable Agent Modules -- Phase 1 Implementation Plan

**Document:** `docs/plans/reusable-agent-modules-phase1-impl-plan.md`
**Status:** DONE (Sprints 1-5 complete)
**Date:** 2026-03-22
**Source specs:** LLD (`reusable-agent-modules-phase1.lld.md`), HLD (`reusable-agent-modules-phase-plan.hld.md`), Feature Doc (`reusable-agent-modules.md`), Test Guide (`reusable-agent-modules.md`)

**Post-Implementation Note (2026-04-15):** A follow-up remediation closed the production-wiring gaps that remained after the original phase closeout. Studio module pages are now reachable from the shell, dependency hydration runs at project load, and deployment create/promote materialize or clone module snapshots before cutover with rollback restoration on failure.

---

## 1. Sprint Overview

### Sprint 1: Foundation (Data Model + Release Builder)

**Duration:** 1 week
**Workstreams:** A + B (partial)

**Entry criteria:**

- `develop` branch is green (compiler 3,947/0, runtime 8,861/0, search-ai 1,430/0)
- All four spec documents approved

**Exit criteria:**

- 4 new Mongoose models created with indexes, registered in `packages/database/src/models/index.ts`
- `IProject` interface extended with `kind`, `moduleVisibility`, `moduleDependencyVersion`, `archivedAt`, `archivedBy`
- Cascade delete extended with two-path logic (module project vs consumer project)
- `TraceEventType` extended with `tool_auth_resolved`
- Shared runtime types (`ResolvedAgentIR`, `ResolvedToolDefinition`, `ModuleProvenance`) created
- Module release builder, contract extractor, selector, and publish safety validator created
- `sourceHash` computation implemented
- Tests P1-U01 through P1-U06 and P1-U11 passing
- `pnpm build --filter=database --filter=project-io --filter=shared-kernel` succeeds

---

### Sprint 2: Build Pipeline (Routes + Alias Rewriter + Deployment Build)

**Duration:** 1.5 weeks
**Workstreams:** C (partial) + D

**Entry criteria:**

- Sprint 1 exit criteria met
- All Sprint 1 unit tests passing

**Exit criteria:**

- 4 new Studio permissions and role mappings added
- 10 Studio API routes created with Zod validation
- Alias rewriter with exhaustive IR field coverage implemented and tested
- Deployment build service with Redis locking and non-module fast path
- Feature gate extended with fail-closed `reusable_modules` gate
- Studio feature resolution hook created
- Audit events for module lifecycle wired
- Tests P1-U07 through P1-U10, P1-U12, P1-U17 through P1-U21, P1-I01 through P1-I05 passing
- `pnpm build --filter=runtime --filter=studio` succeeds

---

### Sprint 3: Runtime + UX (Resolver + Provenance + Studio Components)

**Duration:** 1.5 weeks
**Workstreams:** C (remaining) + E + F (partial)

**Entry criteria:**

- Sprint 2 exit criteria met
- Deployment build service passing integration tests

**Exit criteria:**

- Deployment resolver merges mounted agents/tools from compressed snapshot
- Session provenance persisted and rehydrated across pods
- Trace events enriched with module provenance fields
- `tool_auth_resolved` trace event emitted for imported tools
- Studio project-store and module-store created
- ModuleSettingsPanel, PublishModuleDialog, ImportModuleDialog, ModuleDependencyList components
- ABL authoring surfaces (symbol tree, tool picker, coordination section) show imported symbols
- i18n `modules` key in studio.json
- Tests P1-I06 through P1-I15, P1-U13 through P1-U16 passing

---

### Sprint 4: E2E + Polish

**Duration:** 1 week
**Workstreams:** F (remaining) + G (partial)

**Entry criteria:**

- Sprint 3 exit criteria met
- Runtime resolution and Studio components functional

**Exit criteria:**

- E2E test bootstrap helper (`module-e2e-bootstrap.ts`) created
- All E2E tests P1-E01 through P1-E13 passing with real servers
- Browser smoke P1-B01 through P1-B03 passing
- Concurrency tests P1-R16 through P1-R18 passing
- All regression tests P1-R01 through P1-R28 passing (subset verified per relevant scope)

---

### Sprint 5: Rollout Safety

**Duration:** 0.5 weeks
**Workstreams:** G (remaining)

**Entry criteria:**

- Sprint 4 exit criteria met
- Full test suite green

**Exit criteria:**

- PLAN_FEATURES updated with `reusable_modules` for BUSINESS and ENTERPRISE tiers
- Studio SWR feature hook wired
- Kill switch verified: flag-off hides all module UI, blocks all module API routes, existing non-module projects unaffected
- Operational metrics stubs: publish/import error rates, snapshot sizes, compile latency
- Internal dogfood with single tenant + module + 2 consumers validated

---

## 2. Task Breakdown

### Sprint 1: Foundation

#### S1-T01: Extend Project Model with Module Fields

- **LLD Section:** 1.1
- **Files to modify:** `packages/database/src/models/project.model.ts`
- **Dependencies:** None
- **Acceptance criteria:**
  - `IProject` interface has `kind`, `moduleVisibility`, `moduleDependencyVersion`, `archivedAt`, `archivedBy` fields
  - Schema has `kind` with `enum: ['application', 'module']`, `default: 'application'`, `required: true`
  - Schema has `moduleVisibility` with `enum: ['private', 'tenant']`, `default: 'private'`
  - Schema has `moduleDependencyVersion` with `type: Number, default: 0`
  - Schema has `archivedAt` (Date, default null) and `archivedBy` (String, default null) -- explicit in schema so Mongoose `strict: true` does not drop them
  - Existing indexes unchanged; no new indexes needed on project itself
  - `pnpm build --filter=database` succeeds
- **Test IDs:** P1-R01 (verify default behavior for existing projects)
- **Estimated complexity:** S
- **Parallelizable with:** S1-T02, S1-T03, S1-T04, S1-T05
- **CLAUDE.md rules:** Zod ID validation (z.string().min(1) for IDs), tenant isolation, type safety (read source before using)

#### S1-T02: Create ModuleRelease Model

- **LLD Section:** 1.2
- **Files to create:** `packages/database/src/models/module-release.model.ts`
- **Dependencies:** None
- **Acceptance criteria:**
  - `IModuleRelease` interface matches LLD Section 1.2 exactly (tenantId, moduleProjectId, version, releaseNotes, artifact, compiledIR, contract, sourceHash, createdBy, createdAt, archivedAt, archivedBy)
  - Mongoose schema with `_id: uuidv7`, collection name `module_releases`
  - Unique compound index: `{ tenantId: 1, moduleProjectId: 1, version: 1 }`
  - Listing index: `{ tenantId: 1, moduleProjectId: 1, createdAt: -1 }`
  - `tenantIsolationPlugin` applied
  - `pnpm build --filter=database` succeeds
- **Test IDs:** P1-U01
- **Estimated complexity:** M
- **Parallelizable with:** S1-T01, S1-T03, S1-T04, S1-T05
- **CLAUDE.md rules:** Tenant isolation (every query includes tenantId), Zod ID validation

#### S1-T03: Create ModuleEnvironmentPointer Model

- **LLD Section:** 1.3
- **Files to create:** `packages/database/src/models/module-environment-pointer.model.ts`
- **Dependencies:** None
- **Acceptance criteria:**
  - `IModuleEnvironmentPointer` interface matches LLD Section 1.3 (tenantId, moduleProjectId, environment, moduleReleaseId, revision, updatedBy, updatedAt)
  - Unique compound index: `{ tenantId: 1, moduleProjectId: 1, environment: 1 }`
  - Environment enum: `['dev', 'staging', 'production']`
  - `revision` starts at 0 for optimistic concurrency
  - `tenantIsolationPlugin` applied
- **Test IDs:** P1-U06 (selector uses this model)
- **Estimated complexity:** S
- **Parallelizable with:** S1-T01, S1-T02, S1-T04, S1-T05
- **CLAUDE.md rules:** Tenant isolation

#### S1-T04: Create ProjectModuleDependency Model

- **LLD Section:** 1.4
- **Files to create:** `packages/database/src/models/project-module-dependency.model.ts`
- **Dependencies:** None
- **Acceptance criteria:**
  - `IProjectModuleDependency` interface matches LLD Section 1.4 (tenantId, projectId, moduleProjectId, alias, selector, resolvedReleaseId, configOverrides, contractSnapshot, createdBy, createdAt, updatedAt)
  - Unique compound index: `{ tenantId: 1, projectId: 1, alias: 1 }`
  - Reverse lookup index: `{ tenantId: 1, moduleProjectId: 1 }`
  - `configOverrides` typed as `Record<string, string>`
  - `tenantIsolationPlugin` applied
- **Test IDs:** P1-U02
- **Estimated complexity:** M
- **Parallelizable with:** S1-T01, S1-T02, S1-T03, S1-T05
- **CLAUDE.md rules:** Tenant isolation, project isolation

#### S1-T05: Create DeploymentModuleSnapshot Model

- **LLD Section:** 1.5
- **Files to create:** `packages/database/src/models/deployment-module-snapshot.model.ts`
- **Dependencies:** None
- **Acceptance criteria:**
  - `IDeploymentModuleSnapshot` interface matches LLD Section 1.5 (tenantId, projectId, deploymentId, snapshotHash, compressedPayload as Buffer, createdBy, createdAt)
  - Unique index: `{ tenantId: 1, deploymentId: 1 }`
  - Consumer listing index: `{ tenantId: 1, projectId: 1 }`
  - Uses gzip-compressed JSON in `compressedPayload` (Buffer type)
  - `tenantIsolationPlugin` applied
- **Test IDs:** P1-U03
- **Estimated complexity:** M
- **Parallelizable with:** S1-T01, S1-T02, S1-T03, S1-T04
- **CLAUDE.md rules:** Tenant isolation, performance (compress before storing)

#### S1-T06: Register New Models in Barrel Export

- **LLD Section:** 1.6
- **Files to modify:** `packages/database/src/models/index.ts`
- **Dependencies:** S1-T02, S1-T03, S1-T04, S1-T05
- **Acceptance criteria:**
  - New `// -- Modules` section in index.ts exporting all 4 models and their interfaces
  - `pnpm build --filter=database` succeeds
  - Existing model exports unchanged
- **Test IDs:** None (build verification)
- **Estimated complexity:** S
- **Parallelizable with:** None (depends on all model tasks)
- **CLAUDE.md rules:** Unused imports check

#### S1-T07: Extend Cascade Delete -- Module Project Path

- **LLD Section:** 2.1 (Path A), 2.2
- **Files to modify:** `packages/database/src/cascade/cascade-delete.ts`
- **Dependencies:** S1-T06
- **Acceptance criteria:**
  - `deleteProject` signature extended to `deleteProject(projectId: string, tenantId?: string)`
  - When `tenantId` not provided, resolved from Project document
  - For module projects: blocks if `ProjectModuleDependency.countDocuments({ tenantId, moduleProjectId }) > 0` -- returns 409 with consumer project IDs
  - When no consumers: deletes `ModuleEnvironmentPointer`, `ModuleRelease` before existing cascade
  - Soft-delete / archive path implemented (sets `archivedAt`, `archivedBy` on Project and ModuleRelease)
  - Consumer `DeploymentModuleSnapshots` are NOT deleted here
  - Import of 4 new models added to the file
- **Test IDs:** P1-R08, P1-R12
- **Estimated complexity:** L
- **Parallelizable with:** S1-T08
- **CLAUDE.md rules:** Tenant isolation (findOne with tenantId, never findById), error envelope format

#### S1-T08: Extend Cascade Delete -- Consumer Project and Tenant Paths

- **LLD Section:** 2.1 (Path B), 2.1 (Tenant)
- **Files to modify:** `packages/database/src/cascade/cascade-delete.ts`
- **Dependencies:** S1-T06
- **Acceptance criteria:**
  - Consumer project deletion: `ProjectModuleDependency.deleteMany({ tenantId, projectId })` and `DeploymentModuleSnapshot.deleteMany({ tenantId, projectId })` before existing Deployment cascade
  - Tenant deletion: adds 4 steps in order: `DeploymentModuleSnapshot`, `ProjectModuleDependency`, `ModuleEnvironmentPointer`, `ModuleRelease` -- all before existing tenant cascade
  - Deletion counts recorded for all 4 new models
- **Test IDs:** P1-R08
- **Estimated complexity:** M
- **Parallelizable with:** S1-T07
- **CLAUDE.md rules:** Tenant isolation

#### S1-T09: Create Shared Module Types (Runtime)

- **LLD Section:** 6.1 (types), 6.2
- **Files to create:** `apps/runtime/src/services/modules/types.ts`
- **Dependencies:** None
- **Acceptance criteria:**
  - `ModuleProvenance` interface with `alias`, `moduleProjectId`, `moduleReleaseId`, `sourceAgentName`
  - `ResolvedAgentIR` type = `AgentIR & { _moduleProvenance?: ModuleProvenance }`
  - `ResolvedToolDefinition` type = `ToolDefinitionLocal & { _moduleProvenance?: ... }`
  - `DeploymentModuleSnapshotPayload` type with `dependencies`, `mountedAgents`, `mountedTools`, `snapshotHash`
  - Types compile cleanly: `pnpm build --filter=runtime`
- **Test IDs:** None (type-only)
- **Estimated complexity:** S
- **Parallelizable with:** S1-T01 through S1-T08
- **CLAUDE.md rules:** Type safety (read IR schema.ts before defining types), no any

#### S1-T10: Extend TraceEventType with Module Events

- **LLD Section:** 6.3, 6.4
- **Files to modify:** `packages/shared-kernel/src/types/trace-event.ts`
- **Dependencies:** None
- **Acceptance criteria:**
  - `TraceEventType` union extended with `'tool_auth_resolved'`
  - `TraceEvent` interface extended with optional `moduleAlias`, `moduleProjectId`, `moduleReleaseId`, `sourceAgentName` fields
  - `pnpm build --filter=shared-kernel` succeeds
  - Existing trace consumers unaffected (fields optional)
- **Test IDs:** P1-R10
- **Estimated complexity:** S
- **Parallelizable with:** S1-T01 through S1-T09
- **CLAUDE.md rules:** Backward compatibility

#### S1-T11: Create Module Release Builder

- **LLD Section:** 3.1
- **Files to create:** `packages/project-io/src/module-release/build-module-release.ts`
- **Dependencies:** S1-T02 (ModuleRelease type reference)
- **Acceptance criteria:**
  - Implements the 9-step pipeline from LLD Section 3.1
  - Validates at least one agent exists (blocking error)
  - Validates `entryAgentName` is set and non-null (blocking error)
  - Compiles each agent DSL to IR using existing compiler
  - Strips `variableNamespaceIds` from tool references in compiled IR
  - Stores `dslContent` and per-agent `sourceHash` in artifact
  - Emits warning when `AgentModelConfig` records exist
  - Returns `{ artifact, compiledIR, contract, sourceHash, warnings }` or `{ errors, warnings }`
- **Test IDs:** P1-U04, P1-I01, P1-R05
- **Estimated complexity:** L
- **Parallelizable with:** S1-T12, S1-T13, S1-T14
- **CLAUDE.md rules:** Logger (createLogger, not console.log), error handling (no swallowed errors)

#### S1-T12: Create Contract Extractor

- **LLD Section:** 3.2
- **Files to create:** `packages/project-io/src/module-release/module-contract.ts`
- **Dependencies:** None
- **Acceptance criteria:**
  - Extracts `providedAgents`, `providedTools`, `requiredConfigKeys`, `requiredEnvVars`, `requiredAuthProfiles`, `requiredConnectors`, `requiredMcpServers`, `warnings`
  - Reuses `auth-requirement-collector.ts` patterns for auth profile extraction
  - Reuses `manifest-generator.ts` patterns for prerequisite scanning
  - Contract `requiredAuthProfiles` reuses `ProjectManifestV2.required_auth_profiles` shape (resolves MEDIUM-6)
- **Test IDs:** P1-U05
- **Estimated complexity:** M
- **Parallelizable with:** S1-T11, S1-T13, S1-T14
- **CLAUDE.md rules:** Type safety (read auth-requirement-collector.ts source before reusing)

#### S1-T13: Create Module Selector

- **LLD Section:** 3.3
- **Files to create:** `packages/project-io/src/module-release/module-selector.ts`
- **Dependencies:** S1-T02, S1-T03 (models)
- **Acceptance criteria:**
  - `resolveSelector` function implements version and environment resolution exactly per LLD Section 3.3
  - Version selector: `findOne({ tenantId, moduleProjectId, version, archivedAt: null })`
  - Environment selector: resolves pointer, then loads release, checks not archived
  - Actionable error messages for missing versions and unset pointers
  - Returns `{ releaseId, version }` or `{ error: string }`
- **Test IDs:** P1-U06
- **Estimated complexity:** M
- **Parallelizable with:** S1-T11, S1-T12, S1-T14
- **CLAUDE.md rules:** Tenant isolation (always includes tenantId), error envelope

#### S1-T14: Create Publish Safety Validator

- **LLD Section:** 11.1
- **Files to create:** `packages/project-io/src/module-release/module-publish-safety.ts`
- **Dependencies:** None
- **Acceptance criteria:**
  - Structural validation: HTTP tools must use `auth_profile_ref` or `{{env.*}}`/`{{config.*}}` templating; rejects non-templated literal auth values
  - Checks `custom_headers`, `query_params`, `body_template` for non-templated literals in auth-sensitive positions
  - Pattern-based validation: Base64 strings >20 chars, URL-embedded API keys, PEM private keys, common secret patterns
  - Non-portable binding warnings: SearchAI tools emit warning with `indexId`, Workflow tools emit warning with `workflowId`
  - Strips/rejects `variableNamespaceIds`, raw MongoDB `_id` references, source-project `projectId` fields
- **Test IDs:** P1-U11, P1-R13
- **Estimated complexity:** L
- **Parallelizable with:** S1-T11, S1-T12, S1-T13
- **CLAUDE.md rules:** Security scanning, no inline magic numbers

#### S1-T15: Create sourceHash Computation Utility

- **LLD Section:** 1.2 (sourceHash)
- **Files to create:** `packages/project-io/src/module-release/source-hash.ts`
- **Dependencies:** None
- **Acceptance criteria:**
  - `computeSourceHash(entryAgentName, agents, tools)` per LLD Section 1.2
  - Deep-sort keys for deterministic serialization
  - SHA-256, truncated to 16 hex chars
  - Includes `entryAgentName` per user decision override
- **Test IDs:** P1-U04 (included in release builder tests)
- **Estimated complexity:** S
- **Parallelizable with:** All Sprint 1 tasks
- **CLAUDE.md rules:** No inline magic numbers (use named constants)

#### S1-T16: Sprint 1 Unit Tests

- **LLD Section:** 13 (Sprint 1)
- **Files to create:**
  - `packages/database/src/__tests__/model-module-release.test.ts`
  - `packages/database/src/__tests__/model-project-module-dependency.test.ts`
  - `packages/database/src/__tests__/model-deployment-module-snapshot.test.ts`
  - `packages/project-io/src/__tests__/module-release-builder.test.ts`
  - `packages/project-io/src/__tests__/module-contract.test.ts`
  - `packages/project-io/src/__tests__/module-selector.test.ts`
  - `packages/project-io/src/__tests__/module-publish-safety.test.ts`
- **Dependencies:** S1-T02 through S1-T15
- **Acceptance criteria:**
  - P1-U01: release uniqueness, tenant scoping, immutable required fields
  - P1-U02: alias uniqueness per consumer project, resolved release pin storage
  - P1-U03: snapshot hash persistence and deployment linkage
  - P1-U04: correct artifact assembly from module project
  - P1-U05: prerequisite extraction for env vars, auth profiles, connectors, MCP servers, config slots
  - P1-U06: selector resolution from version or environment pointer
  - P1-U11: publish validator rejects inline secrets and source-only IDs
  - All tests pass via `pnpm test --filter=database` and `pnpm test --filter=project-io`
- **Test IDs:** P1-U01 through P1-U06, P1-U11
- **Estimated complexity:** L
- **Parallelizable with:** Partially -- test files for models can run parallel to test files for project-io
- **CLAUDE.md rules:** E2E test standards do NOT apply to these unit tests; but no `console.log` in tests, use proper assertions

---

### Sprint 2: Build Pipeline

#### S2-T01: Add Module Permissions

- **LLD Section:** 7.2
- **Files to modify:** `apps/studio/src/lib/permissions.ts`
- **Dependencies:** S1-T01 (project model must exist)
- **Acceptance criteria:**
  - `MODULE_READ`, `MODULE_MANAGE`, `MODULE_PUBLISH`, `MODULE_IMPORT` added to `StudioPermission`
  - Role mappings: OWNER: all 4; EDITOR: read+import; VIEWER: read only
  - `module:import` is distinct from `project:import`
- **Test IDs:** P1-U10
- **Estimated complexity:** S
- **Parallelizable with:** S2-T02, S2-T03, S2-T07, S2-T08
- **CLAUDE.md rules:** Type safety (read permissions.ts before modifying)

#### S2-T02: Create Module Settings Route

- **LLD Section:** 7.1 (POST /module)
- **Files to create:** `apps/studio/src/app/api/projects/[id]/module/route.ts`
- **Dependencies:** S1-T01, S2-T01
- **Acceptance criteria:**
  - POST handler: enables/disables module, sets visibility
  - Validates `kind` transition: application->module allowed; module->application blocked when consumer deps exist
  - Requires `module:manage` permission
  - Zod validation for request body
  - Emits `MODULE_ENABLED` / `MODULE_DISABLED` audit events
  - Uses `withRouteHandler({ requireProject: true, permissions: StudioPermission.MODULE_MANAGE })`
  - Returns 404 for cross-tenant, not 403
- **Test IDs:** P1-U10, P1-R28
- **Estimated complexity:** M
- **Parallelizable with:** S2-T03, S2-T04, S2-T05, S2-T06
- **CLAUDE.md rules:** Tenant isolation, project isolation, error envelope, Zod ID validation (z.string().min(1))

#### S2-T03: Create Release Listing and Publish Routes

- **LLD Section:** 7.1 (GET/POST releases), 7.5
- **Files to create:** `apps/studio/src/app/api/projects/[id]/module/releases/route.ts`
- **Dependencies:** S1-T02, S1-T11, S2-T01
- **Acceptance criteria:**
  - GET: lists releases for module project with pagination, requires `module:read`
  - POST: publishes new release per LLD Section 7.5 flow (validate kind=module, semver, build, create, handle E11000, optional promote, audit)
  - Zod validation: version as semver pattern, optional releaseNotes, optional promoteToEnvironment
  - Uses `Model.create` (not check-then-write) for dedup; catches MongoServerError code 11000 -> 409
  - Emits `MODULE_PUBLISHED` audit event
  - Returns `{ success: true, data: { releaseId, version, contract, warnings } }`
- **Test IDs:** P1-U10, P1-I02, P1-I08, P1-R17
- **Estimated complexity:** L
- **Parallelizable with:** S2-T02, S2-T04, S2-T05
- **CLAUDE.md rules:** Concurrency (insert+catch, not check-then-write), error envelope, security

#### S2-T04: Create Promote Route

- **LLD Section:** 7.1 (POST promote), 10.3
- **Files to create:** `apps/studio/src/app/api/projects/[id]/module/releases/[releaseId]/promote/route.ts`
- **Dependencies:** S1-T03, S2-T01
- **Acceptance criteria:**
  - POST handler moves environment pointer with optimistic concurrency via `revision` counter
  - Uses `findOneAndUpdate` with `revision: expectedRevision` condition
  - Returns 409 on revision conflict with actionable message
  - Creates pointer (upsert) if it doesn't exist yet
  - Requires `module:publish` permission
  - Emits `MODULE_PROMOTED` audit event
- **Test IDs:** P1-I02, P1-R16
- **Estimated complexity:** M
- **Parallelizable with:** S2-T02, S2-T03, S2-T05
- **CLAUDE.md rules:** Concurrency control, error envelope

#### S2-T05: Create Module Catalog Routes

- **LLD Section:** 7.3
- **Files to create:**
  - `apps/studio/src/app/api/projects/[id]/module-catalog/route.ts`
  - `apps/studio/src/app/api/projects/[id]/module-catalog/[moduleProjectId]/route.ts`
- **Dependencies:** S1-T02, S1-T03, S2-T01
- **Acceptance criteria:**
  - GET (list): returns summary listings per LLD Section 7.3, filtered by visibility (tenant or owned)
  - Enriched with latest release version, environment pointers, provided counts
  - GET (detail): returns full contract for a specific module
  - Both require `module:read` permission
  - Cross-tenant modules return empty list / 404
  - Archived modules excluded unless `includeArchived: true`
- **Test IDs:** P1-I07, P1-I13, P1-R09, P1-R14, P1-R20
- **Estimated complexity:** L
- **Parallelizable with:** S2-T02, S2-T03, S2-T04
- **CLAUDE.md rules:** Tenant isolation (tenantId in every query), cross-tenant returns 404

#### S2-T06: Create Import Routes (Preview + Confirm + Delete)

- **LLD Section:** 7.4, 7.1 (GET/POST/DELETE dependencies)
- **Files to create:**
  - `apps/studio/src/app/api/projects/[id]/module-dependencies/route.ts`
  - `apps/studio/src/app/api/projects/[id]/module-dependencies/preview/route.ts`
  - `apps/studio/src/app/api/projects/[id]/module-dependencies/[dependencyId]/route.ts`
- **Dependencies:** S1-T04, S1-T13, S2-T01
- **Acceptance criteria:**
  - POST preview: dry-run validation returning `resolvedReleaseId`, `mountedSymbols`, `prerequisites`, `collisions`
  - GET: lists current dependencies with contract snapshots
  - POST confirm: persists `ProjectModuleDependency`, increments `moduleDependencyVersion`, validates configOverrides per LLD Section 11.2
  - DELETE: validates no local DSL references to mounted names before removing; increments `moduleDependencyVersion`
  - All require `module:import` permission (except GET which requires `module:read`)
  - Emits `MODULE_IMPORTED` / `MODULE_REMOVED` audit events
  - Zod validation: alias pattern `^[a-z][a-z0-9_]{1,24}$`, no `__`, no reserved prefixes
  - Maximum 5 dependencies per consumer project
- **Test IDs:** P1-U12, P1-I03, P1-I10, P1-R11, P1-R19, P1-R24
- **Estimated complexity:** L
- **Parallelizable with:** S2-T02 through S2-T05
- **CLAUDE.md rules:** Tenant isolation, project isolation (projectId in every filter), Zod ID validation, error envelope, configOverrides validation

#### S2-T07: Create Alias Rewriter

- **LLD Section:** 4.1, 4.2, 4.3
- **Files to create:** `apps/runtime/src/services/modules/module-alias-rewriter.ts`
- **Dependencies:** S1-T09 (shared types)
- **Acceptance criteria:**
  - `rewriteModuleIR` function per LLD Section 4.2 algorithm
  - Alias validation: `^[a-z][a-z0-9_]{1,24}$`, no `__`, no reserved prefixes (`system_`, `internal_`, `test_`)
  - `deepRewriteIR` as recursive walker with helpers: `rewriteFlowStep`, `rewriteConstraint`
  - Covers ALL fields in `AGENT_NAME_FIELDS` and `TOOL_NAME_FIELDS` from LLD Section 4.2
  - Rewrites `metadata.name` FIRST
  - Collision detection at import time per LLD Section 4.3
  - Step names (not in renameMap) safely skipped
  - `when` condition strings (CEL) NOT rewritten
- **Test IDs:** P1-U07
- **Estimated complexity:** L
- **Parallelizable with:** S2-T08
- **CLAUDE.md rules:** Type safety (read IR schema.ts AgentIR interface before implementing)

#### S2-T08: Create Deployment Build Service

- **LLD Section:** 5.1, 5.2, 5.3, 10.1, 10.2
- **Files to create:** `apps/runtime/src/services/deployments/deployment-build-service.ts`
- **Dependencies:** S1-T05, S1-T09, S2-T07
- **Acceptance criteria:**
  - Implements 17-step flow from LLD Section 5.1
  - Non-module fast path: when `ProjectModuleDependency.countDocuments() === 0`, delegates to existing flow immediately (zero overhead)
  - Redis distributed lock: `module:deploy:{tenantId}:{projectId}`, 60s TTL, 30s renewal, Lua scripts for atomic compare-and-delete/renew
  - Size enforcement: 8 MB uncompressed limit, gzip compression, reject with 422 if exceeded
  - Validates total mounted symbol count <= 250
  - Module-aware deployment hash per LLD Section 5.3
  - Dependency version counter verification: atomic condition on `moduleDependencyVersion`
  - Structured diagnostics: `ModuleBuildDiagnostic` type, truncated to first 10 errors
  - Lock acquisition failure returns 409
- **Test IDs:** P1-U09, P1-I04, P1-R02, P1-R25
- **Estimated complexity:** L
- **Parallelizable with:** S2-T07
- **CLAUDE.md rules:** Redis distributed locks (SET NX PX), performance (compress before storing), error envelope, logger (createLogger)

#### S2-T09: Extend Feature Gate with Fail-Closed Module Gate

- **LLD Section:** 9.1, 9.2
- **Files to modify:** `apps/runtime/src/middleware/feature-gate.ts`
- **Dependencies:** None
- **Acceptance criteria:**
  - `reusable_modules` added to BUSINESS and ENTERPRISE tiers in `PLAN_FEATURES`
  - New `createModuleFeatureGate()` middleware function that fails CLOSED (returns 503 on error, not next())
  - Returns 403 with `FEATURE_DISABLED` code when tenant doesn't have the feature
  - Logs error with `createLogger('feature-gate')`, NOT console.log
- **Test IDs:** P1-R26
- **Estimated complexity:** M
- **Parallelizable with:** S2-T01 through S2-T08
- **CLAUDE.md rules:** Logger pattern, error envelope

#### S2-T10: Create Studio Feature Resolution

- **LLD Section:** 9.3
- **Files to create:**
  - `apps/studio/src/app/api/features/route.ts`
  - `apps/studio/src/hooks/use-features.ts`
- **Dependencies:** S2-T09
- **Acceptance criteria:**
  - Studio API route proxies to Runtime feature endpoint, caches 60s per tenant
  - `useFeatures()` hook returns `{ hasModules: boolean }` using SWR with 60s refresh
  - Fails closed: if Runtime unreachable, `hasModules` defaults to `false`
  - Uses `useSWR` with `dedupingInterval: 30_000`
- **Test IDs:** P1-R26
- **Estimated complexity:** M
- **Parallelizable with:** S2-T01 through S2-T08
- **CLAUDE.md rules:** Type safety

#### S2-T11: Add Audit Actions for Module Lifecycle

- **LLD Section:** 7.6
- **Files to modify:** `apps/studio/src/services/audit-service.ts`
- **Dependencies:** None
- **Acceptance criteria:**
  - 8 new audit actions added to `AuditActions`: `MODULE_ENABLED`, `MODULE_DISABLED`, `MODULE_PUBLISHED`, `MODULE_PROMOTED`, `MODULE_IMPORTED`, `MODULE_REMOVED`, `MODULE_RELEASE_ARCHIVED`, `MODULE_DELETE_BLOCKED`
  - All audit events sanitized -- no secret values, no full artifact content
- **Test IDs:** P1-U13, P1-I11
- **Estimated complexity:** S
- **Parallelizable with:** All Sprint 2 tasks
- **CLAUDE.md rules:** Compliance (audit logging)

#### S2-T12: configOverrides Validation Utility

- **LLD Section:** 11.2
- **Files to create:** `packages/project-io/src/module-release/config-overrides-validator.ts`
- **Dependencies:** S1-T12 (contract types)
- **Acceptance criteria:**
  - `validateConfigOverrides` function per LLD Section 11.2
  - Max 50 keys, max 1 KB per value
  - Validates keys against contract's declared non-secret config slots
  - Rejects values for declared secret keys (`isSecret: true`)
  - Rejects template injection (`/\{\{/` pattern)
  - Rejects control characters (`/[\x00-\x08\x0B\x0C\x0E-\x1F]/`)
  - Returns `{ blocking: string[], warnings: string[] }`
- **Test IDs:** P1-U12 (tested via import route tests)
- **Estimated complexity:** M
- **Parallelizable with:** All Sprint 2 tasks
- **CLAUDE.md rules:** Security (template injection prevention), no inline magic numbers

#### S2-T13: Sprint 2 Unit and Integration Tests

- **LLD Section:** 13 (Sprint 2)
- **Files to create:**
  - `apps/runtime/src/services/modules/__tests__/module-alias-rewriter.test.ts`
  - `apps/runtime/src/services/modules/__tests__/module-snapshot-service.test.ts`
  - `apps/runtime/src/services/deployments/__tests__/deployment-build-service.test.ts`
  - `apps/studio/src/__tests__/api-module-routes.test.ts`
  - `apps/studio/src/__tests__/api-module-dependencies.test.ts`
- **Dependencies:** S2-T01 through S2-T12
- **Acceptance criteria:**
  - P1-U07: deterministic alias rewriting for handoffs, tool references, routing, constraints, behavior profiles
  - P1-U08: mounted bundle generation and stable snapshot hash
  - P1-U09: combined compile path for local plus imported module sources
  - P1-U10: request validation, permissions, 404 isolation for module routes
  - P1-U12: dependency removal blocked when consumer DSL references mounted names
  - P1-I01 through P1-I05: integration scenarios
  - All pass via `pnpm test --filter=runtime` and `pnpm test --filter=studio`
- **Test IDs:** P1-U07 through P1-U10, P1-U12, P1-I01 through P1-I05
- **Estimated complexity:** L
- **Parallelizable with:** Partially -- runtime tests parallel to studio tests

---

### Sprint 3: Runtime + UX

#### S3-T01: Extend Deployment Resolver with Module Merge

- **LLD Section:** 6.1
- **Files to modify:** `apps/runtime/src/services/deployment-resolver.ts`
- **Dependencies:** S1-T05, S1-T09, S2-T08
- **Acceptance criteria:**
  - After existing agent resolution, loads `DeploymentModuleSnapshot.findOne({ tenantId, deploymentId })`
  - Decompresses payload with `zlib.gunzipSync`
  - Merges mounted agents into resolved agent set with `_moduleProvenance`
  - Merges mounted tools into resolved tool set with `_moduleProvenance`
  - When no module snapshot exists, behavior is exactly as before (P1-R07)
  - Uses `ResolvedAgentIR` / `ResolvedToolDefinition` types (not raw type assertions)
  - Eager load at session bootstrap per Decision 5c
- **Test IDs:** P1-R02, P1-R07
- **Estimated complexity:** L
- **Parallelizable with:** S3-T02, S3-T04, S3-T05

#### S3-T02: Add Session Provenance Persistence

- **LLD Section:** 6.2
- **Files to modify:** `apps/runtime/src/services/session/types.ts`
- **Dependencies:** S1-T09
- **Acceptance criteria:**
  - `SessionData` extended with `moduleProvenance?: Record<string, { alias, moduleProjectId, moduleReleaseId, sourceAgentName }>`
  - Set once at session bootstrap from deployment resolver output
  - Persisted to Redis with session state
  - Rehydrated sessions on other pods restore full provenance from serialized state
- **Test IDs:** P1-U15, P1-R21
- **Estimated complexity:** M
- **Parallelizable with:** S3-T01, S3-T03
- **CLAUDE.md rules:** Type safety (read SessionData source before modifying)

#### S3-T03: Enrich Trace Events with Module Provenance

- **LLD Section:** 6.3, 6.4
- **Files to modify:** `apps/runtime/src/services/trace-store.ts`
- **Dependencies:** S1-T10
- **Acceptance criteria:**
  - When emitting trace events for an agent with `_moduleProvenance`, adds `moduleAlias`, `moduleProjectId`, `moduleReleaseId`, `sourceAgentName`
  - Local agents produce traces with no module fields (backward compatible)
  - `tool_auth_resolved` trace event emitted for imported tools with resolution scope
  - Auth resolution for imported tools uses consumer `projectId` (NOT module source project)
- **Test IDs:** P1-R10, P1-R06
- **Estimated complexity:** M
- **Parallelizable with:** S3-T01, S3-T02
- **CLAUDE.md rules:** Backward compatibility, logger pattern

#### S3-T04: Create Module Store (Studio)

- **LLD Section:** 8.2
- **Files to create:** `apps/studio/src/store/module-store.ts`
- **Dependencies:** None
- **Acceptance criteria:**
  - Zustand store matching LLD Section 8.2 interface
  - Non-persisted (follows `tool-store.ts` pattern)
  - Catalog, dependencies, releases, pointers, publish state, import state
  - All actions call API client functions
- **Test IDs:** P1-I14
- **Estimated complexity:** M
- **Parallelizable with:** S3-T01, S3-T02, S3-T03, S3-T05
- **CLAUDE.md rules:** Zustand patterns (no persist middleware for this store)

#### S3-T05: Extend Project Store with Module Filter

- **LLD Section:** 8.1
- **Files to modify:** `apps/studio/src/store/project-store.ts`
- **Dependencies:** S1-T01
- **Acceptance criteria:**
  - `Project` interface extended with `kind` and `moduleVisibility` fields
  - `moduleFilter` state: `'all' | 'application' | 'module'`
  - `setModuleFilter`, `selectModuleProjects`, `selectApplicationProjects` selectors
  - Approximately 15 lines added
- **Test IDs:** P1-U16
- **Estimated complexity:** S
- **Parallelizable with:** S3-T01 through S3-T04
- **CLAUDE.md rules:** Type safety (read project-store.ts before modifying)

#### S3-T06: Create Module API Client

- **LLD Section:** 8.3
- **Files to create:** `apps/studio/src/api/modules.ts`
- **Dependencies:** S2-T02 through S2-T06 (route definitions)
- **Acceptance criteria:**
  - Centralizes all module API calls following `api/projects.ts` pattern
  - Functions for: enableModule, publishRelease, promotePointer, listCatalog, getModuleDetail, previewImport, confirmImport, listDependencies, removeDependency
  - All functions use proper error handling (not catch(() => {}))
- **Test IDs:** Used by all UI component tests
- **Estimated complexity:** M
- **Parallelizable with:** S3-T04, S3-T05

#### S3-T07: Create ModuleSettingsPanel Component

- **LLD Section:** 8.6 (ModuleSettingsPanel)
- **Files to create:** `apps/studio/src/components/modules/ModuleSettingsPanel.tsx`
- **Dependencies:** S3-T04, S3-T06
- **Acceptance criteria:**
  - Toggle: Application -> Module
  - Visibility: Private / Tenant dropdown
  - Disabled when `useFeatures().hasModules === false`
  - Kind downgrade blocked when consumer deps exist (P1-R28)
  - Uses i18n strings from `modules.settings.*`
- **Test IDs:** P1-I14
- **Estimated complexity:** M
- **Parallelizable with:** S3-T08, S3-T09, S3-T10
- **CLAUDE.md rules:** clsx for className composition, Framer Motion for transitions

#### S3-T08: Create PublishModuleDialog Component

- **LLD Section:** 8.6 (PublishModuleDialog)
- **Files to create:** `apps/studio/src/components/modules/PublishModuleDialog.tsx`
- **Dependencies:** S3-T04, S3-T06
- **Acceptance criteria:**
  - Single-page dialog per Decision 7c
  - Version input (semver), release notes textarea, target pointer dropdown
  - Collapsible "Release Preview" section: exported agents, tools, prerequisites, warnings
  - Submit triggers publish + optional pointer promotion
  - Loading states during publish
  - Uses i18n strings from `modules.publish.*`
- **Test IDs:** P1-B01
- **Estimated complexity:** M
- **Parallelizable with:** S3-T07, S3-T09, S3-T10

#### S3-T09: Create ImportModuleDialog Component

- **LLD Section:** 8.6 (ImportModuleDialog)
- **Files to create:** `apps/studio/src/components/modules/ImportModuleDialog.tsx`
- **Dependencies:** S3-T04, S3-T06
- **Acceptance criteria:**
  - Two-step UI mirroring two-step API
  - Step 1: Select module from catalog, select version/environment, enter alias, click "Preview"
  - Step 2: Review mounted symbols, prerequisites, collisions, satisfy missing config, click "Import"
  - Alias validation feedback in real-time
  - Uses i18n strings from `modules.import.*`
- **Test IDs:** P1-B02
- **Estimated complexity:** L
- **Parallelizable with:** S3-T07, S3-T08, S3-T10

#### S3-T10: Create ModuleDependencyList Component

- **LLD Section:** 8.6 (ModuleDependencyList)
- **Files to create:** `apps/studio/src/components/modules/ModuleDependencyList.tsx`
- **Dependencies:** S3-T04, S3-T06
- **Acceptance criteria:**
  - List of imported dependencies: alias, module name, pinned version, config overrides, remove button
  - Remove button triggers confirmation dialog with warning about mounted symbol removal
  - Empty state with i18n string `modules.dependencies.empty`
- **Test IDs:** P1-I14
- **Estimated complexity:** M
- **Parallelizable with:** S3-T07, S3-T08, S3-T09

#### S3-T11: Extend ABL Authoring Surfaces

- **LLD Section:** 8.6 (Imported Symbols in Authoring)
- **Files to modify:**
  - `apps/studio/src/components/abl/ABLSymbolTree.tsx`
  - `apps/studio/src/components/abl/ToolPickerDialog.tsx`
  - `apps/studio/src/components/agent-detail/CoordinationSection.tsx`
- **Dependencies:** S3-T04 (module store for dependency data)
- **Acceptance criteria:**
  - ABLSymbolTree: "Imported Modules" collapsible group with provenance badges and lock icon
  - ToolPickerDialog: imported tools with `[imported]` badge and module alias prefix
  - CoordinationSection: imported agents as handoff/delegate targets with provenance labels
  - All imported symbols marked read-only -- clicking opens info panel, not editor
- **Test IDs:** P1-I14
- **Estimated complexity:** L
- **Parallelizable with:** S3-T07 through S3-T10
- **CLAUDE.md rules:** Type safety (read each component source before modifying)

#### S3-T12: Add i18n Module Strings

- **LLD Section:** 8.5
- **Files to modify:** `packages/i18n/locales/en/studio.json`
- **Dependencies:** None
- **Acceptance criteria:**
  - `modules` key added with all nested keys from LLD Section 8.5
  - Covers: settings, publish, import, catalog, dependencies, badges, errors
- **Test IDs:** None (verified by component tests)
- **Estimated complexity:** S
- **Parallelizable with:** All Sprint 3 tasks
- **CLAUDE.md rules:** i18n guide

#### S3-T13: SWR Cache Invalidation Wiring

- **LLD Section:** 8.4
- **Files to modify:** `apps/studio/src/store/module-store.ts` (actions), `apps/studio/src/api/modules.ts`
- **Dependencies:** S3-T04, S3-T06
- **Acceptance criteria:**
  - Each mutation calls `mutate(key)` for affected SWR keys per LLD Section 8.4 table
  - Publish invalidates release list and catalog
  - Import/remove invalidates dependencies and topology
  - Enable/disable invalidates projects and catalog
- **Test IDs:** P1-I14
- **Estimated complexity:** M
- **Parallelizable with:** S3-T07 through S3-T11

#### S3-T14: Sprint 3 Integration Tests

- **LLD Section:** 13 (Sprint 3)
- **Files to create:**
  - `apps/runtime/src/__tests__/module-preview.e2e.test.ts`
  - `apps/runtime/src/services/session/__tests__/session-store-modules.test.ts`
  - `apps/studio/src/__tests__/api-module-catalog-routes.test.ts`
  - `apps/studio/src/__tests__/tool-picker-imported-tools.test.tsx`
  - `apps/studio/src/__tests__/coordination-section-imported-agents.test.tsx`
  - `apps/studio/src/__tests__/project-dashboard-modules.test.tsx`
  - `apps/studio/src/__tests__/module-audit-events.test.ts`
- **Dependencies:** S3-T01 through S3-T13
- **Acceptance criteria:**
  - P1-I06: preview uses module project and preview entry agent only
  - P1-I07: private module hidden until visibility changed to tenant
  - P1-I09: archive/delete blocked when pointed-to or depended-on
  - P1-I11: sanitized audit events for all lifecycle actions
  - P1-I13: project-scoped catalog returns only visible modules
  - P1-I14: imported tools/agents discoverable, read-only, provenance-labeled
  - P1-I15: auth preflight fails closed for missing/renamed profiles
  - P1-U13, P1-U15, P1-U16 passing
- **Test IDs:** P1-I06 through P1-I15, P1-U13, P1-U15, P1-U16
- **Estimated complexity:** L
- **Parallelizable with:** Runtime tests parallel to Studio tests

---

### Sprint 4: E2E + Polish

#### S4-T01: Create E2E Bootstrap Helper

- **LLD Section:** 12.1, 12.2
- **Files to create:** `apps/runtime/src/__tests__/helpers/module-e2e-bootstrap.ts`
- **Dependencies:** S3-T01 (runtime resolution must work)
- **Acceptance criteria:**
  - `ModuleE2EBootstrap` class per LLD Section 12.1
  - Starts real Studio + Runtime servers on random ports
  - Full middleware chain: auth, rate limiting, tenant isolation, validation
  - Helper methods: `createModuleProject`, `publishRelease`, `importModule`, `deployConsumer`, `startSession`, `teardown`
  - DSL fixtures: `SIMPLE_MODULE_AGENT_DSL`, `SIMPLE_MODULE_TOOL_DSL` per LLD Section 12.2
  - NO mocking, NO direct DB access, NO stubbed infrastructure
- **Test IDs:** Used by all E2E tests
- **Estimated complexity:** L
- **Parallelizable with:** None (required first for all E2E tests)
- **CLAUDE.md rules:** E2E test standards (no mocks, API-only, real servers, no TODO stubs)

#### S4-T02: E2E Lifecycle Tests

- **LLD Section:** 13 (Sprint 4 E2E)
- **Files to create:** `apps/runtime/src/__tests__/module-lifecycle.e2e.test.ts`
- **Dependencies:** S4-T01
- **Acceptance criteria:**
  - P1-E01: publish, import, deploy, execute full lifecycle
  - P1-E02: version pinning (consumer stays on 1.0.0 when 1.1.0 published)
  - P1-E08: source module changes don't affect existing consumer deployment
  - P1-E09: dependency removal caught if local DSL references stale
  - P1-E10: pointer promotion during build pins one release deterministically
  - All assertions per HLD detailed E2E expectations
- **Test IDs:** P1-E01, P1-E02, P1-E08, P1-E09, P1-E10
- **Estimated complexity:** L
- **Parallelizable with:** S4-T03, S4-T04, S4-T05, S4-T06

#### S4-T03: E2E Isolation Tests

- **LLD Section:** 13 (Sprint 4 E2E)
- **Files to create:** `apps/runtime/src/__tests__/module-runtime-isolation.e2e.test.ts`
- **Dependencies:** S4-T01
- **Acceptance criteria:**
  - P1-E03: two consumers, same module, different config -- behavior diverges where configured
  - P1-E04: missing prerequisite blocks import or deployment
  - P1-E05: two modules with overlapping names, different aliases, deterministic routing
  - P1-E07: cross-tenant browse/import/resolve returns 404
  - P1-E13: auth profile renamed/deleted fails closed
- **Test IDs:** P1-E03, P1-E04, P1-E05, P1-E07, P1-E13
- **Estimated complexity:** L
- **Parallelizable with:** S4-T02, S4-T04, S4-T05, S4-T06

#### S4-T04: E2E Provenance Tests

- **LLD Section:** 13 (Sprint 4 E2E)
- **Files to create:** `apps/runtime/src/__tests__/module-runtime-provenance.e2e.test.ts`
- **Dependencies:** S4-T01
- **Acceptance criteria:**
  - P1-E06: imported agent executes, traces and session detail expose module provenance
  - Provenance survives session rehydration (P1-R21)
- **Test IDs:** P1-E06, P1-R21
- **Estimated complexity:** M
- **Parallelizable with:** S4-T02, S4-T03, S4-T05, S4-T06

#### S4-T05: E2E Concurrency and Cutover Tests

- **LLD Section:** 13 (Sprint 4 E2E)
- **Files to create:**
  - `apps/runtime/src/__tests__/module-concurrency.e2e.test.ts`
  - `apps/runtime/src/__tests__/module-cutover-safety.e2e.test.ts`
- **Dependencies:** S4-T01
- **Acceptance criteria:**
  - P1-E11: concurrent publish produces one winner and one 409
  - P1-E12: failed module-backed deployment leaves previous deployment active
  - P1-R16 through P1-R18: no duplicate state from concurrent operations
  - P1-R25: no partial snapshot left by failed builds
- **Test IDs:** P1-E11, P1-E12, P1-R16 through P1-R18, P1-R25
- **Estimated complexity:** L
- **Parallelizable with:** S4-T02, S4-T03, S4-T04, S4-T06

#### S4-T06: Browser Smoke Tests

- **LLD Section:** 13 (Sprint 4 browser smoke)
- **Files to create:** `apps/studio/e2e/reusable-agent-modules-smoke.spec.ts`
- **Dependencies:** S3-T07 through S3-T11 (UI components must exist)
- **Acceptance criteria:**
  - P1-B01: create/open module project, publish release, import into consumer, verify dependency state in UI
  - P1-B02: hit alias conflict or missing prerequisite, verify actionable error copy
  - P1-B03: module project shows preview/publish affordances, hides deploy-first actions
  - Uses Playwright
- **Test IDs:** P1-B01 through P1-B03
- **Estimated complexity:** L
- **Parallelizable with:** S4-T02 through S4-T05

#### S4-T07: Regression Test Sweep

- **Dependencies:** S4-T01 through S4-T06
- **Acceptance criteria:**
  - P1-R01: existing project create/list/update defaults to application
  - P1-R02: deployment creation unchanged for non-module projects
  - P1-R03: non-module preview still works
  - P1-R04: project-io export/import v2 tests still pass
  - P1-R05: release artifacts omit source namespace IDs
  - P1-R06: existing auth profile resolution for local tools unchanged
  - P1-R07: deployment resolver loads correctly when no module snapshot exists
  - P1-R08: cascade delete removes all module records
  - P1-R09: cross-tenant returns 404
  - P1-R10: trace events backward compatible
  - All remaining P1-R tests verified
- **Test IDs:** P1-R01 through P1-R28
- **Estimated complexity:** L
- **Parallelizable with:** None (final sweep)

---

### Sprint 5: Rollout Safety

#### S5-T01: Wire Feature Flag to PLAN_FEATURES

- **LLD Section:** 9.1
- **Files to modify:** `apps/runtime/src/middleware/feature-gate.ts`
- **Dependencies:** S2-T09 (gate already created)
- **Acceptance criteria:**
  - `reusable_modules` present in BUSINESS and ENTERPRISE tier arrays
  - Module routes apply `createModuleFeatureGate()` middleware
  - Verified: TEAM and FREE tiers get 403 on module routes
- **Test IDs:** P1-R26
- **Estimated complexity:** S
- **Parallelizable with:** S5-T02, S5-T03

#### S5-T02: Kill Switch Verification

- **LLD Section:** 9
- **Files to create:** Test assertions within existing E2E tests
- **Dependencies:** S5-T01
- **Acceptance criteria:**
  - Feature flag off: all module Studio UI hidden (verified via useFeatures hook)
  - Feature flag off: all module API routes return 403 FEATURE_DISABLED
  - Feature flag off: existing non-module projects completely unaffected
  - Feature flag off: existing consumer deployments with frozen snapshots continue working
  - Feature flag on: module routes accessible
- **Test IDs:** P1-R26
- **Estimated complexity:** M
- **Parallelizable with:** S5-T03

#### S5-T03: Operational Metrics Stubs

- **LLD Section:** 13 (Sprint 5)
- **Files to modify:** Routes from Sprint 2 (add timing/counter hooks)
- **Dependencies:** S2-T02 through S2-T08
- **Acceptance criteria:**
  - Publish: success/failure counter, compile latency percentile
  - Import: success/failure counter, validation failure reason counts
  - Deploy: module snapshot size percentile, combined compile latency
  - All emitted via existing logging pattern (structured logs parseable by observability stack)
  - No new dependencies (use `createLogger` with structured fields)
- **Test IDs:** None (verified by log inspection)
- **Estimated complexity:** M
- **Parallelizable with:** S5-T01, S5-T02

#### S5-T04: Internal Dogfood Validation

- **Dependencies:** S5-T01, S5-T02
- **Acceptance criteria:**
  - Single tenant enabled with reusable_modules feature
  - One module project created with at least 1 agent + 1 tool
  - Two consumer projects importing the module with different aliases
  - Both consumers successfully deployed and executing imported agents
  - Traces show module provenance for both consumers
  - Source module change does not affect either consumer deployment
- **Test IDs:** All acceptance criteria from HLD Section "Phase 1 acceptance criteria"
- **Estimated complexity:** L
- **Parallelizable with:** None (end-to-end validation)

---

## 3. Critical Path

The longest dependency chain determines the earliest possible completion:

```
S1-T02 (ModuleRelease model)
  -> S1-T06 (register models)
    -> S1-T07 (cascade delete - module path)
      -> S1-T16 (Sprint 1 unit tests) [Sprint 1 gate]
        -> S2-T03 (publish routes)
          -> S2-T07 (alias rewriter)
            -> S2-T08 (deployment build service)
              -> S2-T13 (Sprint 2 tests) [Sprint 2 gate]
                -> S3-T01 (deployment resolver merge)
                  -> S3-T14 (Sprint 3 tests) [Sprint 3 gate]
                    -> S4-T01 (E2E bootstrap)
                      -> S4-T02 (E2E lifecycle tests)
                        -> S4-T07 (regression sweep) [Sprint 4 gate]
                          -> S5-T04 (dogfood) [Sprint 5 gate]
```

**Critical path length:** 13 sequential tasks across 5 sprints.

**Non-critical path items** (can slip without delaying overall delivery):

- i18n strings (S3-T12)
- Studio UI components (S3-T07 through S3-T10) -- parallel to runtime work
- Browser smoke tests (S4-T06) -- parallel to E2E tests
- Operational metrics (S5-T03)

---

## 4. Parallelization Strategy

### Sprint 1: Max Parallelism = 5

**Workstream Alpha (Data Models):** S1-T01, S1-T02, S1-T03, S1-T04, S1-T05 -- all independent, can run in parallel with 5 agents.
Then S1-T06 (serial gate), then S1-T07 || S1-T08 (2 parallel).

**Workstream Beta (project-io):** S1-T11, S1-T12, S1-T13, S1-T14, S1-T15 -- all independent, can start immediately in parallel.

**Workstream Gamma (types):** S1-T09, S1-T10 -- independent, can run in parallel with everything else.

**Sprint 1 max agents:** 5 on models (Alpha) + 5 on project-io (Beta) + 2 on types (Gamma) = 12 theoretical max; practical recommendation: 4-5 agents.

### Sprint 2: Max Parallelism = 4

**Workstream C (Studio Routes):** S2-T01, S2-T02, S2-T03, S2-T04, S2-T05, S2-T06, S2-T11, S2-T12 -- S2-T01 first (permissions), then routes can run 4-parallel.

**Workstream D (Runtime):** S2-T07, S2-T08 -- partially parallel (rewriter before build service).

**Workstream G (Feature Gate):** S2-T09, S2-T10 -- independent, 2 parallel.

**Sprint 2 max agents:** 4 (Studio routes) + 2 (Runtime) + 2 (Feature gate) = 8 theoretical; practical: 4-5 agents.

### Sprint 3: Max Parallelism = 5

**Workstream E (Runtime):** S3-T01, S3-T02, S3-T03 -- partially parallel (resolver, session, trace).

**Workstream C-UI (Studio):** S3-T04, S3-T05, S3-T06, S3-T07, S3-T08, S3-T09, S3-T10, S3-T11, S3-T12, S3-T13 -- store first, then 4 components in parallel.

**Sprint 3 max agents:** 3 (Runtime) + 5 (Studio UI) = 8 theoretical; practical: 4-5 agents.

### Sprint 4: Max Parallelism = 5

S4-T01 must complete first (bootstrap helper). Then S4-T02 through S4-T06 can run in parallel (5 agents).

### Sprint 5: Max Parallelism = 3

S5-T01, S5-T02, S5-T03 partially parallel; S5-T04 serial at end.

---

## 5. Risk Register

| ID  | Risk                                                                                                | Likelihood | Impact | Mitigation                                                                                                                                                                           |
| --- | --------------------------------------------------------------------------------------------------- | ---------- | ------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| R1  | `packages/agent-transfer` pre-existing build errors (TS2353) break `pnpm build` for runtime         | Medium     | Medium | Do NOT fix agent-transfer. Use `--filter=runtime` scope for builds. If it blocks, add `agent-transfer` to Turbo's `dependsOn` exclusion.                                             |
| R2  | `pipeline-engine` pre-existing test failure blocks CI gate                                          | Low        | Low    | Ignore -- env var issue. Document in CI config.                                                                                                                                      |
| R3  | IR schema changes in `packages/compiler` during implementation invalidate alias rewriter field list | Medium     | High   | Pin the IR schema at Sprint 2 start. If schema changes merge, update rewriter field list immediately. Add compile-time exhaustiveness test (P1-U07 should catch missing fields).     |
| R4  | Compressed snapshot payload exceeds 16 MB BSON limit even after gzip                                | Low        | High   | LLD enforces 8 MB uncompressed pre-validation. For typical 5-module scenarios, this is generous. Add telemetry for payload size in Sprint 5.                                         |
| R5  | Redis lock contention during parallel deployment builds for same project                            | Medium     | Medium | Lock is per-project. 409 response with "retry" guidance is acceptable UX. Lock TTL of 60s with 30s renewal handles long builds.                                                      |
| R6  | Studio `withRouteHandler` pattern doesn't support the feature gate middleware pattern               | Low        | Medium | Feature gate check can be done inside the handler body (call `useFeatures` equivalent server-side) rather than as Express middleware. Read `route-handler.ts` before implementation. |
| R7  | E2E tests require both Studio (Next.js) and Runtime (Express) servers running simultaneously        | High       | High   | The `ModuleE2EBootstrap` helper must start both. Use `{ port: 0 }` for random ports. Test infrastructure complexity is the biggest Sprint 4 risk. Allocate extra time.               |
| R8  | Mongoose `strict: true` silently drops `archivedAt`/`archivedBy` if not in schema                   | High       | High   | LLD explicitly calls this out. S1-T01 must add these fields to the Mongoose schema definition (not just the TypeScript interface).                                                   |

---

## 6. Audit Checkpoints

### After Sprint 1

- [ ] All 4 models created with correct indexes (verify with `db.collection.getIndexes()` in test)
- [ ] `Project` schema has `kind`, `moduleVisibility`, `moduleDependencyVersion`, `archivedAt`, `archivedBy` in BOTH interface and schema
- [ ] Cascade delete handles all 4 paths (module project, consumer project, tenant, soft-delete)
- [ ] `TraceEventType` includes `tool_auth_resolved`
- [ ] sourceHash is deterministic (run same input twice, get same hash)
- [ ] Publish safety rejects at least: Base64 secrets, PEM keys, non-templated auth_config, variableNamespaceIds
- [ ] `pnpm build --filter=database --filter=project-io --filter=shared-kernel` succeeds
- [ ] P1-U01 through P1-U06, P1-U11 all passing

### After Sprint 2

- [ ] All 10 Studio routes created with correct permission checks
- [ ] Alias rewriter covers ALL fields from LLD Section 4.2 (exhaustive list)
- [ ] Deployment build service has non-module fast path (zero overhead for non-module projects)
- [ ] Redis lock with Lua scripts for atomic operations
- [ ] Feature gate fails CLOSED (not open) for module routes
- [ ] configOverrides validation rejects: >50 keys, >1KB values, secret keys, template injection, control chars
- [ ] `pnpm build --filter=runtime --filter=studio` succeeds
- [ ] P1-U07 through P1-U12, P1-I01 through P1-I05 passing

### After Sprint 3

- [ ] Deployment resolver correctly merges mounted agents/tools from compressed snapshot
- [ ] Session provenance persists through Redis serialization/deserialization cycle
- [ ] Trace events include module fields only for imported agents (backward compatible)
- [ ] All 4 UI components render correctly with module data
- [ ] ABL authoring surfaces show imported symbols as read-only
- [ ] i18n strings present for all module UI text
- [ ] SWR invalidation triggers on all mutations per LLD Section 8.4 table
- [ ] P1-I06 through P1-I15, P1-U13 through P1-U16 passing

### After Sprint 4

- [ ] E2E bootstrap starts real servers (verify no mocks in test files)
- [ ] P1-E01 proves full lifecycle through public APIs
- [ ] P1-E03 proves consumer isolation (different config, same module)
- [ ] P1-E07 proves cross-tenant isolation (404 not 403)
- [ ] P1-E11 proves concurrent publish creates exactly one release
- [ ] P1-E12 proves failed deployment doesn't retire healthy one
- [ ] Browser smoke passes all 3 scenarios
- [ ] ALL regression tests P1-R01 through P1-R28 verified

### After Sprint 5

- [ ] Feature flag off: all module UI hidden, all module API returns 403
- [ ] Feature flag off: non-module projects completely unaffected
- [ ] Feature flag on: dogfood scenario (1 module + 2 consumers) works end to end
- [ ] Operational metrics emitted for publish, import, deploy
- [ ] Full test suite green: `pnpm build && pnpm test` (excluding known pre-existing failures)

---

### Critical Files for Implementation

- `/Users/prasannaarikala/projects/agent-platform/packages/database/src/models/project.model.ts` - Core model to extend with `kind`, `moduleVisibility`, `moduleDependencyVersion`, `archivedAt`, `archivedBy`
- `/Users/prasannaarikala/projects/agent-platform/packages/database/src/cascade/cascade-delete.ts` - Must add two-path cascade logic for module/consumer project deletion and tenant deletion
- `/Users/prasannaarikala/projects/agent-platform/apps/runtime/src/services/deployment-resolver.ts` - Must merge mounted agents/tools from compressed DeploymentModuleSnapshot at session bootstrap
- `/Users/prasannaarikala/projects/agent-platform/packages/compiler/src/platform/ir/schema.ts` - Authoritative IR field definitions that the alias rewriter must exhaustively cover (AgentIR, CoordinationConfig, FlowStep, Constraint, BehaviorProfileIR)
- `/Users/prasannaarikala/projects/agent-platform/apps/runtime/src/middleware/feature-gate.ts` - Must add `reusable_modules` to PLAN_FEATURES and create fail-closed module gate variant

# Feature: Reusable Agent Modules

**Doc Type**: MAJOR FEATURE
**Parent Feature**: N/A
**Status**: BETA
**Feature Area(s)**: `project lifecycle`, `agent lifecycle`, `enterprise`, `governance`
**Package(s)**: `apps/studio`, `apps/runtime`, `packages/database`, `packages/project-io`, `packages/shared-kernel`, `packages/compiler`
**Owner(s)**: Platform team
**Testing Guide**: [../testing/reusable-agent-modules.md](../testing/reusable-agent-modules.md)
**Last Updated**: 2026-04-16

---

## 1. Introduction / Overview

### Problem Statement

Enterprise teams building multi-agent applications on the ABL platform frequently need the same agent capabilities -- such as identity verification, benefits lookup, payment processing, or FAQ handling -- across several projects. Today, achieving this requires manually copying agent DSL, tool definitions, and configuration between projects. This copy-paste approach causes drift when the source is updated, has no mechanism to propagate fixes, and risks inconsistency in security-sensitive logic. Teams with 10+ agents sharing common patterns spend significant effort keeping duplicated implementations aligned.

### Goal Statement

Provide a first-class module system that lets a team define shared agent functionality once in a standard project, publish immutable releases of that project, and import pinned releases into multiple consumer projects. Consumer projects mount imported agents and tools under deterministic alias-based names and execute them entirely within the consumer project's tenant, security, audit, and retention boundaries. The module system must never export secrets, must fail closed on missing prerequisites, and must preserve full provenance through traces and deployment metadata.

### Summary

Reusable Agent Modules let a team define shared agent functionality once, publish immutable releases, and import those releases into multiple projects without copy-paste. The feature is designed for capabilities such as benefits lookup, identity verification, payment processing, or FAQ handling that should stay consistent across several agent applications inside the same tenant.

The design intentionally treats a module as a special kind of project rather than a separate authoring surface. Phase 1 focuses on the smallest end-to-end slice with sound architecture and simple UX: mark a project as a module, publish immutable releases, import a pinned release into a consumer project with an alias, freeze a deployment-time module snapshot, and execute imported agents and tools inside the consumer project's isolation, retention, and security boundaries. Later phases add safer upgrade UX, reverse dependency views, curated catalogs, and richer mapping contracts.

### Key Capabilities

- Turn an existing project into a reusable module with explicit module visibility
- Publish immutable module releases and promote them through `dev`, `staging`, and `production`
- Browse a consumer-project-scoped tenant catalog and import a pinned release with an alias
- Configure imported behavior through non-secret config overrides and consumer-owned credentials
- Mount imported agents and tools into consumer deployments with deterministic alias-based names
- Execute imported assets entirely inside the consumer project's runtime, audit, trace, and retention boundaries
- Preserve module provenance in traces, dependency metadata, and deployment snapshots

---

## 2. Scope

### Goals

- Enable a project to be designated as `kind='module'` with explicit visibility controls (`private` or `tenant`)
- Support immutable release publishing with deterministic source hashing and contract extraction
- Provide environment promotion pointers (`dev`, `staging`, `production`) for release lifecycle management
- Allow consumer projects to browse a tenant-scoped catalog and import module releases with a required alias
- Validate all prerequisites (env vars, auth profiles, connectors, MCP servers, config keys) before accepting an import
- Build frozen deployment-time module snapshots that decouple consumer runtime from source project mutable state
- Rewrite imported agent and tool names to deterministic `<alias>__<symbol>` mounted names across all routing surfaces
- Maintain full tenant, project, and user isolation throughout the module lifecycle
- Emit audit events and trace provenance for all module operations

### Non-Goals (Out of Scope for Phase 1)

- Transitive module dependencies (a module importing another module)
- Partial export selection from a module project
- Automatic consumer upgrades when an environment pointer moves
- Data-model field mapping UX for consumer customization
- Namespace binding UI beyond the default namespace
- Reusable workflows, channels, search indexes, vocabularies, or evals
- Cross-tenant module sharing
- Semver range resolution (`^1.0.0`, `latest`)
- Tenant-admin curated catalog controls
- External marketplace or distribution

---

## 3. User Stories

| ID    | Persona            | Story                                                                                                                                                                            | Acceptance Criteria                                                                                                                          |
| ----- | ------------------ | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------- |
| US-1  | Module Author      | As a module author, I want to mark my existing project as a reusable module so that other teams can import my agents and tools without me building a separate authoring surface. | Project settings allow toggling `kind` to `module`; visibility can be set to `private` or `tenant`; change is audited.                       |
| US-2  | Module Author      | As a module author, I want to publish an immutable release of my module so that consumers get a stable, versioned snapshot that won't change under them.                         | Publish creates an immutable `ModuleRelease` with artifact, contract, and source hash; duplicate version returns 409.                        |
| US-3  | Module Author      | As a module author, I want to promote a release through `dev`, `staging`, and `production` environment pointers so that consumers can choose their desired stability level.      | Pointer update succeeds with optimistic concurrency; promotion is audited; consumers pinned to a version do not move.                        |
| US-4  | Consumer Developer | As a consumer developer, I want to browse available modules from my project context so that I can discover reusable capabilities without asking module authors directly.         | Catalog endpoint returns only modules visible to the consumer project's tenant; private modules are excluded unless the caller owns them.    |
| US-5  | Consumer Developer | As a consumer developer, I want to import a module release with an alias and have all prerequisites validated before the import is accepted.                                     | Import validates env vars, auth profiles, connectors, MCP servers, and config keys; missing prerequisites return 422 with remediation.       |
| US-6  | Consumer Developer | As a consumer developer, I want to deploy my project and have all module dependencies frozen into a deployment snapshot so that runtime execution is deterministic.              | Deployment build resolves all dependencies, builds snapshot, and stores it; snapshot hash is deterministic.                                  |
| US-7  | Runtime Operator   | As a runtime operator, I want module provenance to appear in traces and deployment metadata so that I can diagnose issues in imported agent execution.                           | Traces include `moduleAlias`, `moduleProjectId`, `moduleReleaseId`, `sourceAgentName`; session rehydration preserves provenance.             |
| US-8  | Security Reviewer  | As a security reviewer, I want to be confident that module releases never export secrets and that imported execution stays within consumer project boundaries.                   | Publish rejects inline secrets; runtime runs in consumer tenant/project context; cross-tenant access returns 404.                            |
| US-9  | Consumer Developer | As a consumer developer, I want to preview a module in isolation before publishing so that I can validate behavior without affecting consumer projects.                          | Module preview uses existing preview workflow; no public endpoint is created; preview-only entry agent is honored.                           |
| US-10 | Platform Admin     | As a platform admin, I want the module feature to be gated behind a tenant feature flag so that I can control rollout without code changes.                                      | Feature gate returns 403 when disabled; 11 module routes are gated; feature resolution failure fails closed.                                 |
| US-11 | Consumer Developer | As a consumer developer, I want to upgrade my module dependency to a newer release and preview the contract changes before committing.                                           | PATCH upgrade shows contract diff with breaking/non-breaking classification; upgrade is audited; downgrade is also supported.                |
| US-12 | Module Author      | As a module author, I want to see which projects consume my module so that I can assess the impact of changes before publishing a new release.                                   | Consumers endpoint lists consumer projects with alias, version, and active deployment status; cursor-paginated.                              |
| US-13 | Module Author      | As a module author, I want to archive an old release so it stops appearing in the catalog, while existing pinned consumers are unaffected.                                       | Archive sets `archivedAt`; blocked by 409 if release is in use by pointers, snapshots, or dependencies; archived releases remain resolvable. |
| US-14 | Runtime Operator   | As a runtime operator, I want deployments to fail clearly when a module dependency requires an auth profile that doesn't exist in the consumer project.                          | Deploy-time preflight validates all required auth profiles; fails closed with actionable error naming the missing profile and dependency.    |

---

## 4. Functional Requirements

| ID    | Requirement                                                                                                                                                              | Testable Assertion                                                                                                                                                |
| ----- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | ----------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| FR-1  | The system SHALL allow a project owner to change `Project.kind` from `application` to `module` and back.                                                                 | POST `/api/projects/:id/module` with `kind='module'` succeeds; existing `kind='application'` projects are unaffected.                                             |
| FR-2  | The system SHALL enforce `moduleVisibility` as `private` (default) or `tenant` when `kind='module'`.                                                                     | Creating a module defaults to `private`; only `private` and `tenant` are accepted values.                                                                         |
| FR-3  | The system SHALL create an immutable `ModuleRelease` record with artifact, contract, source hash, and creation metadata.                                                 | POST to publish endpoint returns 201; same version returns 409; release fields are non-updatable after creation.                                                  |
| FR-4  | The system SHALL reject publish when the artifact contains inline secrets, source-only identifiers, or `variableNamespaceIds`.                                           | Publish with inline API keys or namespace IDs returns 422 with specific validation error.                                                                         |
| FR-5  | The system SHALL allow promoting a release to `dev`, `staging`, or `production` environment pointers with optimistic concurrency.                                        | Promote with correct revision succeeds; stale revision returns 409; pointer references the promoted release.                                                      |
| FR-6  | The system SHALL provide a consumer-project-scoped module catalog filtered by `moduleVisibility='tenant'` and owned modules.                                             | GET catalog returns only tenant-visible modules; cross-tenant module IDs return empty results.                                                                    |
| FR-7  | The system SHALL validate all module prerequisites (env vars, auth profiles, connectors, MCP servers, config keys) before accepting an import.                           | Import with missing prerequisites returns 422 with per-prerequisite remediation details.                                                                          |
| FR-8  | The system SHALL enforce alias uniqueness per consumer project and reject self-import.                                                                                   | Duplicate alias returns 409; importing own project returns 422; max 5 dependencies enforced.                                                                      |
| FR-9  | The system SHALL reject config overrides that contain secret key values.                                                                                                 | Import with `configOverrides` containing patterns matching secret names returns 422.                                                                              |
| FR-10 | The system SHALL build a frozen `DeploymentModuleSnapshot` at deployment creation time, stored separately from the deployment record with gzip-compressed payload.       | Deployment with module deps creates snapshot; snapshot `compressedPayload` is valid gzip; `moduleReleaseIds` populated.                                           |
| FR-11 | The system SHALL rewrite all imported agent and tool names to `<alias>__<symbol>` format across routing, delegation, fan-out, and tool lookup surfaces.                  | Alias rewriter transforms all IR routing fields consistently; 53 unit tests validate field coverage.                                                              |
| FR-12 | The system SHALL execute imported module agents and tools entirely within the consumer project's tenant, project, audit, and retention boundaries.                       | Cross-tenant fabrication returns 404; traces show consumer `projectId`; data stays in consumer scope.                                                             |
| FR-13 | The system SHALL preserve module provenance (`moduleAlias`, `moduleProjectId`, `moduleReleaseId`, `sourceAgentName`) in traces and session state.                        | Trace events include provenance fields; session rehydration preserves provenance across pod restarts.                                                             |
| FR-14 | The system SHALL emit audit events for module enable, publish, promote, import, and remove operations.                                                                   | Each lifecycle action produces a sanitized audit event; 10 audit event tests validate coverage.                                                                   |
| FR-15 | The system SHALL gate all module routes behind the `reusable_modules` tenant feature flag, failing closed on resolution errors.                                          | Feature disabled returns 403; feature error returns 403; all 11 routes are gated.                                                                                 |
| FR-16 | The system SHALL ensure source module working-copy changes do not affect existing consumer deployments.                                                                  | After deployment, modifying source module DSL does not change consumer deployment behavior.                                                                       |
| FR-17 | The system SHALL ensure failed module-backed deployment creation does not retire the previous active deployment.                                                         | Failed deployment leaves previous deployment active; no partial snapshot is created; error is actionable.                                                         |
| FR-18 | The system SHALL show imported tools as read-only with provenance badges in the Studio tool picker and imported agents in routing/handoff/delegation authoring surfaces. | Tool picker shows provenance labels; coordination section shows imported agents; both are non-editable.                                                           |
| FR-19 | The system SHALL support contract diff classification (breaking/non-breaking/warn) for upgrade preview.                                                                  | Contract diff correctly classifies removed agents as breaking, added agents as non-breaking, and metadata changes as warn.                                        |
| FR-20 | The system SHALL block module project deletion or release archive when active pointers, dependencies, or deployment snapshots reference the target.                      | Delete with active references returns 409 with dependency details; cascade delete handles both module and consumer paths.                                         |
| FR-21 | The system SHALL allow a consumer developer to upgrade or downgrade a module dependency to a different release via PATCH, recording the change in audit.                 | PATCH with new `releaseId` updates `resolvedReleaseId` and `contractSnapshot`; upgrade and downgrade both succeed; `MODULE_UPGRADED` audit event emitted.         |
| FR-22 | The system SHALL provide a reverse dependency query showing which consumer projects import a given module, with deployment status and cursor pagination.                 | GET consumers endpoint returns `{ consumers, totalConsumers, nextCursor }`; each entry includes `projectName`, `alias`, `version`, `hasActiveDeployment`.         |
| FR-23 | The system SHALL compute update-available indicators when listing a consumer project's module dependencies by comparing `resolvedReleaseId` to the latest release.       | GET dependencies enriches each dependency with `updateAvailable: boolean` and `latestVersion: string` when a newer release exists.                                |
| FR-24 | The system SHALL allow archiving a module release by setting `archivedAt`, guarded by a three-layer check (pointers, snapshots, dependencies).                           | POST archive returns 200 on success; returns 409 with `inUseBy` details when the release is referenced by any active pointer, deployment snapshot, or dependency. |
| FR-25 | The system SHALL validate all `requiredAuthProfiles` from module contracts against consumer project auth profiles at deployment time, failing closed on any mismatch.    | Deployment with missing auth profiles fails with actionable error naming the missing profile and originating dependency; DB errors also block deployment.         |

---

## 5. Feature Classification & Integration Matrix

### Feature Classification

| Dimension       | Value                                     |
| --------------- | ----------------------------------------- |
| Type            | Platform capability (cross-cutting)       |
| Scope           | Tenant-scoped, project-scoped             |
| Lifecycle stage | Project authoring, deployment, runtime    |
| Isolation level | Tenant + Project + User                   |
| Feature gate    | `reusable_modules` (BUSINESS, ENTERPRISE) |

### Integration Matrix

| Related Feature             | Integration Point                                                                                                      | Direction     |
| --------------------------- | ---------------------------------------------------------------------------------------------------------------------- | ------------- |
| Deployments & Versioning    | Module snapshot is created during deployment build; deployment resolver loads mounted module assets                    | Bidirectional |
| Auth Profiles               | Consumer-owned auth profiles resolve imported tool credentials at deploy/runtime; contract records required profiles   | Consumer      |
| Environment Variables       | Consumer env vars satisfy module prerequisites; config overrides provide non-secret customization                      | Consumer      |
| Agent Transfer / A2A        | Imported module agents participate in handoff, delegation, and fan-out routing via alias-rewritten names               | Consumer      |
| Tracing & Observability     | Module provenance fields enriched in trace events and session state; backward compatible when absent                   | Producer      |
| Project I/O (Import/Export) | Module release builder reuses project-io assemblers and prerequisite extraction; does NOT use staged import activation | Internal      |
| Studio Control Plane        | Module settings, catalog, dependency management, and authoring UX surfaces added to Studio                             | Producer      |
| Agent Development (Studio)  | Imported symbols appear in ABL symbol tree, tool picker, and coordination section with provenance labeling             | Producer      |

---

## 6. How to Consume

### Studio UI

**Phase 1 (Core lifecycle):**

- A project owner can convert an existing project into a module from a module settings surface
- Module authors can preview the module in isolation using the existing preview workflow
- Module authors can publish a release and promote environment pointers without creating a public deployment endpoint
- Consumer projects can browse visible modules from a project-scoped catalog, import a module with an alias, satisfy prerequisites, and inspect current dependencies
- Imported agents and tools appear as read-only, provenance-labeled symbols in authoring surfaces such as the editor symbol tree, tool picker, and coordination UI

**Phase 2 (Safer operations & adoption UX):**

- Consumer projects see update-available badges on imported dependencies when a newer release exists
- Clicking an update badge opens the **UpgradeModuleDialog** showing a structured contract diff with breaking/non-breaking/warn classification before committing the upgrade
- Module authors can view a **ReverseDepPanel** listing which consumer projects import their module, with alias, version, and active deployment status
- Module authors can archive old releases via the **ArchiveReleaseButton**, which is guarded by a 409 if the release is in use by pointers, snapshots, or dependencies

### End-to-End UI Flow

The UI flow is intentionally split across two projects: the project being published as a reusable module, and the existing project that will consume that module.

1. In the source project, open `Settings -> Modules`, turn module mode on, and choose visibility (`Private` or `Tenant`).
2. On that same page, click `Publish Release`, enter a semver version, optionally add release notes, and optionally promote that release to `dev`, `staging`, or `production`.
3. In the consumer project, open `Dependencies` and click `Import Module`.
4. In the two-step import dialog, choose the source module, choose either a pinned `version` or an `environment` selector, assign an alias, preview the resolved symbols and prerequisites, add any allowed non-secret config overrides, and confirm the import.
5. After import, the dependency row shows the alias plus either `pin: x.y.z` or `env: <environment>`. Imported agents and tools then appear as read-only module assets in contextual authoring surfaces such as the ABL symbol tree, tool picker, and coordination UI.
6. When the consumer project is ready, deploy it from the normal `Operate -> Deployments` page. Deployment resolves the dependency again, validates prerequisites, and freezes the resolved module release into a deployment snapshot so existing deployments remain stable even if the source module changes later.

For the cleanest workflow, use a dedicated source project as the module, publish versions there, import them into consumer projects with short aliases like `idv` or `payments`, wire `alias.agent_name` / `alias.tool_name()` into the consumer authoring flow, and deploy only the consumer project.

### Consumer Asset Surface Matrix

| Asset Type                       | Supported in Consumer Project? | Where It Appears in Studio                                                                                                        | Design-Time Consumption Model                                                                                                                   | Runtime Behavior                                                                                                                                                                         | Notes                                                                                      |
| -------------------------------- | ------------------------------ | --------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------ |
| Imported agents                  | Yes                            | `Dependencies` page, `Imported Modules` in the ABL symbol tree, imported targets in coordination / handoff / delegation authoring | Read-only symbols derived from the dependency contract snapshot. Authors reference them with the consumer-facing alias form `alias.agent_name`. | Deployment build rewrites them to deterministic mounted names (`<alias>__<agent>`), stores them in the deployment module snapshot, and resolver merges them back with provenance.        | Imported agents are not copied into the consumer project's editable local agent inventory. |
| Imported tools                   | Yes                            | `Dependencies` page, `Imported Modules` in the ABL symbol tree, imported rows in the tool picker                                  | Read-only symbols derived from the dependency contract snapshot. Authors insert and reference them as `alias.tool_name()`.                      | Deployment build rewrites them to deterministic mounted names (`<alias>__<tool>`), stores tool definitions in the deployment module snapshot, and runtime resolves them with provenance. | Imported tools are not copied into the consumer project's editable local tool inventory.   |
| Workflows                        | No                             | Not shown in the consumer workflow inventory or module authoring surfaces                                                         | Not consumable through reusable modules in Phase 1 or Phase 2.                                                                                  | No workflow mounting, snapshotting, or runtime resolution path exists.                                                                                                                   | Explicitly out of scope for the current feature phase.                                     |
| Knowledge bases / search indexes | No                             | Not shown in Search AI / knowledge-base inventory as imported module assets                                                       | Not consumable through reusable modules in Phase 1 or Phase 2.                                                                                  | No knowledge-base or search-index mounting, snapshotting, or runtime resolution path exists.                                                                                             | Explicitly out of scope for the current feature phase.                                     |

### Design-Time vs Runtime Semantics

- The consumer project imports a dependency record plus a contract snapshot. Studio exposes imported agents and tools from that dependency metadata instead of copying the source module's records into the consumer project's local agents or tools collections.
- Standard inventory pages remain local-project-owned. Imported agents do not become editable cards in the consumer `Agents` page, and imported tools do not become editable entries in the consumer `Tools` page. They appear only in module-aware authoring contexts plus the `Dependencies` page.
- Design-time naming is consumer-facing (`alias.agent_name`, `alias.tool_name()`), while deploy/runtime naming is execution-facing (`<alias>__<symbol>`). The alias rewriter makes the runtime form deterministic so mounted symbols avoid collisions with local project assets and other imported modules.
- If the dependency selector is a pinned version, the consumer stays on that version until the dependency is explicitly upgraded. If the selector is an environment pointer (`dev`, `staging`, `production`), future deployments re-resolve that pointer, but an existing deployment snapshot remains pinned to the already-resolved release.
- Runtime execution always happens inside the consumer project's tenant, project, auth, audit, trace, and retention boundaries, even when the source logic originated in a different module project.

### API (Runtime)

Phase 1 does not introduce a new public runtime-only module API surface. Instead, existing deployment, session, and trace APIs become module-aware.

| Method | Path                                                 | Purpose                                                                                                   |
| ------ | ---------------------------------------------------- | --------------------------------------------------------------------------------------------------------- |
| POST   | `/api/projects/:projectId/deployments`               | Create a deployment that resolves module dependencies and stores a frozen deployment module snapshot      |
| GET    | `/api/projects/:projectId/deployments/:deploymentId` | Inspect deployment metadata for a consumer project that may include mounted module dependencies           |
| POST   | `/api/projects/:projectId/sessions`                  | Create a test session for a consumer project agent that may route or delegate into imported module agents |
| GET    | `/api/projects/:projectId/sessions/:id/traces`       | Inspect execution traces, including module provenance fields when imported agents or tools execute        |

### API (Studio)

| Method | Path                                                       | Purpose                                                                                |
| ------ | ---------------------------------------------------------- | -------------------------------------------------------------------------------------- |
| POST   | `/api/projects/:id/module`                                 | Mark a project as a module and manage module-level settings such as visibility         |
| GET    | `/api/projects/:id/module/releases`                        | List releases for a module project                                                     |
| POST   | `/api/projects/:id/module/releases`                        | Publish a new immutable module release                                                 |
| POST   | `/api/projects/:id/module/releases/:releaseId/promote`     | Move an environment pointer to a specific release                                      |
| GET    | `/api/projects/:id/module-catalog`                         | Browse modules visible from the current consumer project context                       |
| GET    | `/api/projects/:id/module-dependencies`                    | List module dependencies for a consumer project (enriched with update-available)       |
| POST   | `/api/projects/:id/module-dependencies`                    | Import a module release into a consumer project with alias and prerequisite validation |
| DELETE | `/api/projects/:id/module-dependencies/:dependencyId`      | Remove a dependency after validating there are no remaining mounted-symbol references  |
| PATCH  | `/api/projects/:id/module-dependencies/:dependencyId`      | Upgrade/downgrade a dependency to a different release (Phase 2)                        |
| GET    | `/api/projects/:id/module-dependencies/:dependencyId/diff` | Preview contract diff between current and target release (Phase 2)                     |
| GET    | `/api/projects/:id/module/consumers`                       | List consumer projects that import this module with deployment status (Phase 2)        |
| GET    | `/api/projects/:id/module/releases/:releaseId`             | Release detail (excludes compiledIR for security) (Phase 2)                            |
| POST   | `/api/projects/:id/module/releases/:releaseId`             | Archive a release with three-layer guard (Phase 2)                                     |

### Admin Portal

No dedicated Admin Portal UX is planned for Phase 1. Governance relies on existing project-scoped RBAC, tenant feature gating, and audit visibility. Tenant-wide curation and richer admin controls are deferred to later phases.

### Channel Integration

Reusable modules flow through the same deployment and runtime path used by existing channels. Once a consumer deployment is created with a frozen module snapshot, the imported module logic becomes available to SDK and digital chat flows, voice channels, and A2A integrations. Channels remain unaware of module internals -- they resolve only the consumer deployment, and the deployment resolver loads the mounted module snapshot behind the scenes.

---

## 7. Data Model

### Collections / Tables

```
Collection: projects
New / updated fields:
  - kind: 'application' | 'module' (required, default 'application')
  - moduleVisibility: 'private' | 'tenant' (required when kind='module', default 'private')
Existing fields reused:
  - tenantId, name, slug, description, entryAgentName
Indexes:
  - existing project indexes remain
Notes:
  - A module is still a project; Phase 1 does not create a second authoring container
```

```
Collection: module_releases
Fields:
  - _id: string
  - tenantId: string (required, indexed)
  - moduleProjectId: string (required, indexed)
  - version: string (required)
  - artifact: ModuleReleaseArtifact (required)
  - contract: ModuleReleaseContract (required)
  - sourceHash: string (required)
  - createdBy: string (required)
  - archivedAt: Date | null
  - archivedBy: string | null
  - createdAt: Date
Indexes:
  - { tenantId: 1, moduleProjectId: 1, version: 1 } (unique)
```

```
Collection: module_environment_pointers
Fields:
  - _id: string
  - tenantId: string (required, indexed)
  - moduleProjectId: string (required, indexed)
  - environment: 'dev' | 'staging' | 'production' (required)
  - moduleReleaseId: string (required)
  - revision: number (required)
  - updatedBy: string (required)
  - updatedAt: Date
Indexes:
  - { tenantId: 1, moduleProjectId: 1, environment: 1 } (unique)
```

```
Collection: project_module_dependencies
Fields:
  - _id: string
  - tenantId: string (required, indexed)
  - projectId: string (required, indexed)
  - moduleProjectId: string (required)
  - alias: string (required)
  - selector: { type: 'version' | 'environment', value: string }
  - resolvedReleaseId: string (required)
  - configOverrides: Record<string, string>
  - createdBy: string (required)
  - updatedAt: Date
Indexes:
  - { tenantId: 1, projectId: 1, alias: 1 } (unique)
```

```
Collection: deployment_module_snapshots
Fields:
  - _id: string
  - tenantId: string (required, indexed)
  - projectId: string (required, indexed)
  - deploymentId: string (required, indexed)
  - snapshotHash: string (required)
  - moduleReleaseIds: string[] (denormalized for reverse dependency queries without payload decompression)
  - compressedPayload: Buffer (required, gzip-compressed JSON containing:
      - dependencies: Array<{ alias, moduleProjectId, moduleReleaseId, version }>
      - mountedAgents: Record<string, { sourceAgentName, alias, moduleProjectId, moduleReleaseId, ir }>
      - mountedTools: Record<string, { sourceToolName, alias, moduleProjectId, moduleReleaseId, definition }>
    )
  - createdBy: string (required)
  - createdAt: Date
Indexes:
  - { tenantId: 1, deploymentId: 1 } (unique)
  - { tenantId: 1, projectId: 1 }
  - { moduleReleaseIds: 1 }
```

### Key Relationships

- `Project.kind='module'` enables a project to publish rows in `module_releases`
- `module_environment_pointers` map a module project's environment to a single promoted release
- `project_module_dependencies` let a consumer project pin one or more module releases by alias
- `deployment_module_snapshots` freeze the exact mounted result used by a consumer deployment
- Runtime sessions, traces, audit events, and retention remain tied to the consumer project rather than the source module project

---

## 8. Key Implementation Files

### Domain / Core Logic

| File                                                                   | Purpose                                                                                                          |
| ---------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------- |
| `packages/database/src/models/project.model.ts`                        | Extended with `kind`, `moduleVisibility`, `moduleDependencyVersion`, `archivedAt`, `archivedBy`                  |
| `packages/database/src/models/module-release.model.ts`                 | Immutable module release model with artifact, compiledIR, contract                                               |
| `packages/database/src/models/module-environment-pointer.model.ts`     | Environment pointer model with optimistic concurrency (revision)                                                 |
| `packages/database/src/models/project-module-dependency.model.ts`      | Consumer-project dependency records with contractSnapshot                                                        |
| `packages/database/src/models/deployment-module-snapshot.model.ts`     | Frozen gzip-compressed deployment-time mounted bundle; `moduleReleaseIds` indexed for reverse dependency queries |
| `packages/database/src/cascade/cascade-delete.ts`                      | Two-path cascade delete + soft-delete for module projects                                                        |
| `packages/project-io/src/module-release/build-module-release.ts`       | Build module release artifacts and contracts from a module project                                               |
| `packages/project-io/src/module-release/module-contract.ts`            | Derive provided symbols and required prerequisites                                                               |
| `packages/project-io/src/module-release/module-selector.ts`            | Resolve version/environment selectors to immutable release IDs                                                   |
| `packages/project-io/src/module-release/module-publish-safety.ts`      | Structural + pattern-based publish safety validation                                                             |
| `packages/project-io/src/module-release/source-hash.ts`                | Deterministic SHA-256 source hash computation                                                                    |
| `packages/project-io/src/module-release/config-overrides-validator.ts` | Config override validation (size, secrets, injection)                                                            |
| `packages/project-io/src/module-release/module-contract-diff.ts`       | Contract diff with breaking-change classification for upgrade preview                                            |
| `apps/runtime/src/services/modules/module-alias-rewriter.ts`           | Rewrite imported symbols to deterministic alias-mounted names                                                    |
| `apps/runtime/src/services/modules/deployment-build-service.ts`        | Combined deployment build with module snapshot creation and auth preflight                                       |
| `apps/runtime/src/services/modules/contract-auth-validator.ts`         | Deploy-time auth profile preflight validation (Phase 2)                                                          |
| `apps/studio/src/api/modules.ts`                                       | Type-safe Studio API client for module operations (Phase 2)                                                      |
| `apps/runtime/src/services/modules/types.ts`                           | `ModuleProvenance`, `ResolvedAgentIR`, `ResolvedToolDefinition` types                                            |
| `apps/studio/src/lib/feature-resolver.ts`                              | Server-side feature resolution (Deal + Subscription to PLAN_FEATURES) with 60s TTL cache                         |
| `apps/studio/src/hooks/use-features.ts`                                | Client-side SWR hook (`useFeatures()`) returning `{ hasModules }` for UI kill switch                             |
| `apps/runtime/src/middleware/feature-gate.ts`                          | Runtime Express middleware `createModuleFeatureGate()` (defined, not yet wired)                                  |
| `packages/shared-kernel/src/constants/plan-features.ts`                | `PLAN_FEATURES` -- single source of truth for tier to feature mapping                                            |

### Routes / Handlers

| File                                                                                     | Purpose                                                           |
| ---------------------------------------------------------------------------------------- | ----------------------------------------------------------------- |
| `apps/studio/src/app/api/projects/[id]/module/route.ts`                                  | Module settings and enablement control plane                      |
| `apps/studio/src/app/api/projects/[id]/module/releases/route.ts`                         | Release listing and publish                                       |
| `apps/studio/src/app/api/projects/[id]/module/releases/[releaseId]/promote/route.ts`     | Environment promotion with optimistic concurrency                 |
| `apps/studio/src/app/api/projects/[id]/module-catalog/route.ts`                          | Consumer-project-scoped module catalog (list)                     |
| `apps/studio/src/app/api/projects/[id]/module-catalog/[moduleProjectId]/route.ts`        | Module detail with full contract                                  |
| `apps/studio/src/app/api/projects/[id]/module-dependencies/route.ts`                     | Dependency list (with update-available) and import confirm        |
| `apps/studio/src/app/api/projects/[id]/module-dependencies/preview/route.ts`             | Dry-run import validation                                         |
| `apps/studio/src/app/api/projects/[id]/module-dependencies/[dependencyId]/route.ts`      | Dependency removal and upgrade (PATCH) with reference check       |
| `apps/studio/src/app/api/projects/[id]/module-dependencies/[dependencyId]/diff/route.ts` | Contract diff preview for upgrade (Phase 2)                       |
| `apps/studio/src/app/api/projects/[id]/module/consumers/route.ts`                        | Reverse dependency consumer list with cursor pagination (Phase 2) |
| `apps/studio/src/app/api/projects/[id]/module/releases/[releaseId]/route.ts`             | Release detail and archive with three-layer guard (Phase 2)       |

### UI Components (Studio)

| File                                                              | Purpose                                                                      |
| ----------------------------------------------------------------- | ---------------------------------------------------------------------------- |
| `apps/studio/src/components/modules/ModuleSettingsPanel.tsx`      | Convert project to module and manage visibility                              |
| `apps/studio/src/components/modules/PublishModuleDialog.tsx`      | Publish immutable releases                                                   |
| `apps/studio/src/components/modules/ImportModuleDialog.tsx`       | Browse, validate, and import modules into consumer projects                  |
| `apps/studio/src/components/modules/ModuleDependencyList.tsx`     | Show imported module dependencies, pins, and update-available badges         |
| `apps/studio/src/components/modules/ModuleSettingsPage.tsx`       | Reachable settings page for module authoring and release management          |
| `apps/studio/src/components/modules/ModuleDependenciesPage.tsx`   | Reachable resource page for dependency import and management                 |
| `apps/studio/src/components/modules/UpgradeModuleDialog.tsx`      | Upgrade preview with structured contract diff (Phase 2)                      |
| `apps/studio/src/components/modules/ReverseDepPanel.tsx`          | Consumer project list with deployment status (Phase 2)                       |
| `apps/studio/src/components/modules/ArchiveReleaseButton.tsx`     | Archive release with 409 in-use handling (Phase 2)                           |
| `apps/studio/src/components/navigation/AppShell.tsx`              | Project-shell wiring for module pages and project-level dependency hydration |
| `apps/studio/src/components/navigation/ProjectSidebar.tsx`        | Sidebar entries for `Modules` and `Dependencies`                             |
| `apps/studio/src/components/projects/ProjectDashboard.tsx`        | Module-aware project dashboard actions                                       |
| `apps/studio/src/components/abl/ABLSymbolTree.tsx`                | Show imported read-only symbols with provenance                              |
| `apps/studio/src/components/abl/ToolPickerDialog.tsx`             | Surface imported tools during authoring                                      |
| `apps/studio/src/components/agent-detail/CoordinationSection.tsx` | Make imported agents available to routing, handoff, and delegation authoring |

### Tests

| File                                                                                 | Type               | Count |
| ------------------------------------------------------------------------------------ | ------------------ | ----- |
| `packages/database/src/__tests__/model-module-release.test.ts`                       | unit               | 15    |
| `packages/database/src/__tests__/model-project-module-dependency.test.ts`            | unit               | 18    |
| `packages/database/src/__tests__/model-deployment-module-snapshot.test.ts`           | unit               | 13    |
| `packages/database/src/__tests__/model-module-environment-pointer.test.ts`           | unit               | 14    |
| `packages/database/src/__tests__/cascade-delete-modules.test.ts`                     | unit               | 6     |
| `packages/project-io/src/__tests__/module-release-builder.test.ts`                   | unit / integration | 21    |
| `packages/project-io/src/__tests__/module-contract.test.ts`                          | unit               | 27    |
| `packages/project-io/src/__tests__/module-selector.test.ts`                          | unit               | 10    |
| `packages/project-io/src/__tests__/module-publish-safety.test.ts`                    | unit               | 20    |
| `packages/project-io/src/__tests__/module-contract-diff.test.ts`                     | unit               | 23    |
| `apps/runtime/src/services/modules/__tests__/module-alias-rewriter.test.ts`          | unit               | 53    |
| `apps/runtime/src/services/modules/__tests__/deployment-build-service.test.ts`       | unit / integration | 16    |
| `apps/runtime/src/services/session/__tests__/session-store-modules.test.ts`          | unit               | 16    |
| `apps/runtime/src/middleware/__tests__/feature-gate-modules.test.ts`                 | unit               | 11    |
| `apps/runtime/src/__tests__/tools-deployment/deployment-routes.test.ts`              | unit / integration | 26    |
| `apps/runtime/src/__tests__/tools-deployment/deployment-promotion.test.ts`           | unit / integration | 13    |
| `apps/runtime/src/__tests__/tools-deployment/module-lifecycle.e2e.test.ts`           | e2e                | 5     |
| `apps/runtime/src/__tests__/tools-deployment/module-runtime-isolation.e2e.test.ts`   | e2e                | 5     |
| `apps/runtime/src/__tests__/tools-deployment/module-runtime-provenance.e2e.test.ts`  | e2e                | 4     |
| `apps/runtime/src/__tests__/tools-deployment/module-concurrency.e2e.test.ts`         | e2e                | 5     |
| `apps/runtime/src/__tests__/tools-deployment/module-preview.e2e.test.ts`             | e2e / integration  | 9     |
| `apps/studio/src/__tests__/api-routes/api-module-routes.test.ts`                     | unit / integration | 18    |
| `apps/studio/src/__tests__/api-routes/api-module-catalog-routes.test.ts`             | unit / integration | 8     |
| `apps/studio/src/__tests__/module-audit-events.test.ts`                              | unit / integration | 10    |
| `apps/studio/src/__tests__/feature-gate-modules.test.ts`                             | unit               | 10    |
| `apps/studio/src/__tests__/components/project-dashboard-modules.test.tsx`            | unit               | 12    |
| `apps/studio/src/__tests__/module-studio-wiring.test.tsx`                            | unit               | 3     |
| `apps/studio/src/__tests__/module-settings-page.test.tsx`                            | unit               | 2     |
| `apps/studio/src/__tests__/module-dependencies-page.test.tsx`                        | unit               | 2     |
| `apps/studio/src/__tests__/module-dependency-loading.test.tsx`                       | integration        | 3     |
| `apps/studio/src/__tests__/api-routes/api-module-dependencies.test.ts`               | unit / integration | 21    |
| `apps/studio/src/__tests__/components/tool-picker-imported-tools.test.tsx`           | unit               | 5     |
| `apps/studio/src/__tests__/components/coordination-section-imported-agents.test.tsx` | unit               | 6     |
| `apps/runtime/src/__tests__/tools-deployment/module-cutover-safety.e2e.test.ts`      | e2e                | 5     |
| `apps/runtime/src/services/modules/__tests__/contract-auth-validator.test.ts`        | unit               | 12    |
| `apps/runtime/src/__tests__/tools-deployment/module-upgrade-lifecycle.e2e.test.ts`   | e2e                | 4     |
| `apps/studio/src/__tests__/api-routes/api-module-upgrade.test.ts`                    | unit / integration | 15    |
| `apps/studio/src/__tests__/api-routes/api-module-consumers.test.ts`                  | unit / integration | 11    |
| `apps/studio/e2e/reusable-agent-modules-smoke.spec.ts`                               | e2e (Playwright)   | 4     |
| `apps/runtime/src/__tests__/helpers/module-e2e-bootstrap.ts`                         | e2e helper         | --    |

---

## 9. Configuration

### Environment Variables

Phase 1 does not require a new module-specific environment variable contract for the platform itself. Consumer secrets remain in existing project environment variables and auth profiles.

| Variable                              | Default  | Description                                                                                                    |
| ------------------------------------- | -------- | -------------------------------------------------------------------------------------------------------------- |
| `reusable-agent-modules` feature gate | disabled | Logical tenant feature flag consumed through the existing feature-gate system rather than a new bespoke toggle |

### Runtime Configuration

- Phase 1 uses the existing tenant feature-gate infrastructure
- Consumer deployments resolve and freeze module releases at deployment creation time
- Imported agents run with the consumer project's runtime config, not the source module project's live runtime config

### DSL / Agent IR

- Phase 1 introduces no new import syntax in the ABL DSL
- Imported symbols are mounted as parser-safe names: `<alias>__<symbol>`
- Phase 1 customization relies on existing config variable indirection such as `{{config.KEY}}`
- Source-project-only DB configuration, including DB-side model overrides, is not assumed portable in Phase 1 unless it is represented in DSL or explicit release metadata

---

## 10. Runtime Integration

Reusable Agent Modules integrate at deployment build time rather than as a late runtime fetch.

### Lifecycle

1. Author module source in a normal project
2. Publish a module release artifact and contract
3. Promote an environment pointer if desired
4. Import the module into a consumer project using a release pin and alias
5. Create a consumer deployment that resolves dependencies and builds a frozen `DeploymentModuleSnapshot`
6. Promote a consumer deployment by cloning its frozen module snapshot when one already exists, or rebuilding it if needed
7. Resolve sessions and executions from the consumer deployment, loading mounted module assets from the frozen snapshot

### Dependencies

- `packages/project-io` for release artifact assembly and prerequisite extraction
- Deployment and snapshot services in Runtime for freezing mounted bundles
- Auth profile and config resolution services for consumer-owned bindings
- Trace store and session persistence for provenance visibility

### Event Flow

Phase 1 emits or enriches the following observability signals:

- Audit events for module enable, publish, promote, import, and remove
- Trace fields for `moduleAlias`, `moduleProjectId`, `moduleReleaseId`, and `sourceAgentName`
- Deployment metadata linking a consumer deployment to a frozen module snapshot

---

## 11. Admin Integration

Phase 1 admin responsibilities are intentionally light:

- Manage tenant feature availability through existing feature controls
- Review audit events and dependency metadata when changes are made
- Rely on project-scoped RBAC for publish/import authority

Tenant-wide curated catalogs, publisher governance workflows, and broader admin tooling are deferred to later phases.

---

## 12. Non-Functional Concerns

### Tenant Isolation

- Every module query (browse, publish, import, deploy) is scoped to `tenantId`
- Cross-tenant module access returns 404, never 403, to avoid leaking resource existence
- Module releases are tenant-scoped; a module in tenant A is invisible to tenant B

### Project Isolation

- Consumer project deployments carry their own module snapshot; no runtime coupling to source project
- Imported agents and tools run under consumer `projectId` for sessions, traces, audit, and data retention
- Module catalog browsing is scoped to the consumer project's tenant context
- Dependency records use compound index `{ tenantId, projectId, alias }` for isolation

### User Isolation

- `createdBy` is recorded on module releases, dependencies, and snapshots
- Publish, promote, import, and remove operations require project-level permissions
- Audit events include the acting user for traceability

### Security

- Secrets never travel in module artifacts; publish rejects inline secrets
- Config overrides are validated to be non-secret
- Missing prerequisites fail closed with actionable 422 validation
- Imported execution runs inside consumer project's data and retention boundaries
- Feature gate fails closed on resolution errors

### Performance

- Deployment creation cost increases for module-backed projects (resolve + rewrite + compile)
- Snapshot payload stored separately from deployment with gzip compression
- Conservative limits: max 5 dependencies per consumer project in Phase 1
- Feature resolution cached per tenant+feature with 60s TTL

### Reliability

- Immutable releases and frozen snapshots avoid runtime dependency on mutable source projects
- Failed deployment leaves previous active deployment intact (cutover safety)
- No partial snapshot on failed deployment
- Optimistic concurrency on environment pointer promotion prevents lost updates

### Observability

- Module provenance in runtime traces, deployment metadata, and audit events
- Backward compatible when module provenance fields are absent
- Session rehydration preserves module provenance across pods
- Feature gate logs structured metrics: `durationMs` for publish, import, promote, and deploy; `dependencyCount` and `compressedBytes` for snapshots
- Feature resolution failures log `tenantId`, `featureName`, and error details

### Data Lifecycle

- Immutable releases are never updated after creation; archival sets `archivedAt`
- Archived releases are hidden from catalog but resolvable by existing consumers
- Cascade delete handles both module-project and consumer-project deletion paths
- Deployment module snapshots follow deployment retention policy

---

## 13. Delivery Plan / Work Breakdown

### Phase 1: Core Module Lifecycle (DONE -- Sprints 1-5)

1. **Sprint 1: Foundation (Data Model + Release Builder)**
   1.1. Create 4 Mongoose models (module_releases, module_environment_pointers, project_module_dependencies, deployment_module_snapshots)
   1.2. Extend IProject interface with kind, moduleVisibility, archivedAt, archivedBy
   1.3. Extend cascade delete with two-path logic
   1.4. Create shared runtime types (ResolvedAgentIR, ModuleProvenance)
   1.5. Implement release builder, contract extractor, selector, publish safety
   1.6. Implement sourceHash computation

2. **Sprint 2: Build Pipeline (Routes + Alias Rewriter + Deployment Build)**
   2.1. Add 4 Studio permissions and role mappings
   2.2. Create 10 Studio API routes with Zod validation
   2.3. Implement alias rewriter with exhaustive IR field coverage
   2.4. Implement deployment build service with Redis locking
   2.5. Wire feature gate with fail-closed reusable_modules gate
   2.6. Create Studio feature resolution hook

3. **Sprint 3: Runtime + UX (Resolver + Provenance + Studio Components)**
   3.1. Implement deployment resolver merge for mounted agents/tools
   3.2. Implement session provenance persistence and rehydration
   3.3. Enrich trace events with module provenance fields
   3.4. Create Studio components (ModuleSettingsPanel, PublishModuleDialog, ImportModuleDialog, ModuleDependencyList)
   3.5. Extend ABL authoring surfaces with imported symbol visibility

4. **Sprint 4: E2E + Polish**
   4.1. Create E2E test bootstrap helper
   4.2. Implement all E2E lifecycle, isolation, provenance, and concurrency tests
   4.3. Verify regression matrix

5. **Sprint 5: Rollout Safety + Feature Gating**
   5.1. Implement runtime and Studio feature gate tests
   5.2. Add operational metrics stubs
   5.3. Wire kill switch and dogfood validation

### Phase 2: Safer Operations & Adoption UX (DONE)

6. **Sprint 1: Test Gap Closure + Data Foundations (DONE)**
   6.1. Contract diff implementation with breaking-change classification
   6.2. Cutover safety E2E tests
   6.3. Import validation Studio tests
   6.4. moduleReleaseIds denormalized array on snapshots

7. **Sprint 2: Upgrade Workflow + Reverse Dependencies (DONE)**
   7.1. In-place PATCH for dependency upgrade
   7.2. Upgrade preview endpoint with contract diff
   7.3. Reverse dependency query endpoint
   7.4. Update-available indicators in dependency list
   7.5. Release detail and archive endpoints with three-layer guard
   7.6. Deploy-time auth profile preflight (GAP-004 closure)

8. **Sprint 3: UI Components + Upgrade E2E + Browser Smoke (DONE)**
   8.1. UpgradeModuleDialog with structured diff and breaking indicators
   8.2. ReverseDepPanel with consumer projects and deployment status
   8.3. ArchiveReleaseButton with 409 in-use handling
   8.4. ModuleDependencyList update-available badge
   8.5. Upgrade lifecycle E2E tests (upgrade, downgrade, breaking change, auth preflight)
   8.6. Playwright browser smoke tests (publish, import, update badge, feature gate)

### Phase 3: Broader Reuse, Governance & Operational Maturity (DEFERRED — Future Release)

9. **Data-field mapping DSL and namespace binding UX** — structured field mapping between consumer and module contracts (GAP-003)
10. **Reusable non-core layers** — workflows, vocabularies, channels as module-exportable assets
11. **Tenant-admin curated catalog** — admin-curated module marketplace with approval workflows (GAP-007)
12. **Transitive module dependencies** — module-imports-module with cycle detection and diamond resolution (GAP-001)
13. **Internal-only agent/tool marking** — contract-level visibility attribute to exclude specific agents/tools from export (Open Question #3, GAP-002)
14. **Semver range selectors** — `^1.0.0` / `~1.2.0` auto-resolution instead of explicit pin-only (Open Question #1)
15. **Archived release retention policy** — TTL-based auto-purge for archived releases with no active references (Open Question #2)
16. **Explicit model config slots in contract** — portable `AgentModelConfig` representation in module releases (Open Question #4, GAP-005)
17. **Max snapshot size enforcement** — configurable `maxSnapshotBytes` with 413 rejection at publish time (Open Question #5)
18. **Richer observability UI** — dedicated module provenance panel, filter-by-module-alias in trace explorer (GAP-018)
19. **Operational metrics & performance checks** — module-level latency tracking, deploy-time performance gates
20. **Tech debt cleanup** — typed callbacks for Redis lock helpers, eliminate `any` in `deployment-build-service.ts` (GAP-014, GAP-015)

---

## 14. Success Metrics

| Metric                                  | Target              | Measurement                                                     |
| --------------------------------------- | ------------------- | --------------------------------------------------------------- |
| Module adoption (tenant-level)          | 3+ tenants in beta  | Count of tenants with at least one module project               |
| Module reuse factor                     | 2+ consumers/module | Average number of consumer projects per published module        |
| Deployment success rate (module-backed) | > 95%               | Ratio of successful module-backed deployments to total attempts |
| Secret leak incidents                   | 0                   | Audit scan for secrets in module release artifacts              |
| Cross-tenant isolation violations       | 0                   | Penetration test and E2E cross-tenant scenarios                 |
| Mean time to import                     | < 30s               | P95 latency for import + prerequisite validation                |
| Consumer deployment snapshot build time | < 60s               | P95 latency for deployment creation with module resolution      |

---

## 15. Open Questions

| #   | Question                                                                                                     | Status                                                                                                                                                                                                                                           |
| --- | ------------------------------------------------------------------------------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| 1   | Should Phase 2 support semver range selectors (`^1.0.0`) or remain explicit-pin only?                        | Deferred to Phase 3                                                                                                                                                                                                                              |
| 2   | What is the retention policy for archived releases that no active deployment references?                     | DECIDED: No auto-purge in Phase 1-2. Archived releases remain resolvable indefinitely. A retention TTL (e.g., 90 days post-archive with no references) is deferred to Phase 3 alongside tenant-admin curation.                                   |
| 3   | Should module authors be able to mark specific agents/tools as "internal" (not exported in the contract)?    | Deferred to Phase 3. Phase 1-2 exports the entire module project (GAP-002). Internal-only marking requires a contract-level visibility attribute and publish-time filtering.                                                                     |
| 4   | How should source-project DB-side `AgentModelConfig` be represented in module releases for Phase 2+?         | DECIDED: Not portable in Phase 1-2 (GAP-005). DB-side model overrides are consumer-project config; module releases carry only DSL-level config. Phase 3 may add explicit model config slots to the contract.                                     |
| 5   | What is the maximum supported module payload size before snapshot compression becomes a performance concern? | DECIDED: No hard limit enforced in Phase 1-2. Gzip compression + separate snapshot storage mitigates. Empirical threshold is ~5 MB compressed (~50 MB uncompressed IR). Phase 3 should add a configurable `maxSnapshotBytes` with 413 rejection. |

---

## 16. Gaps, Known Issues & Limitations

| ID      | Description                                                                                                                                                       | Severity | Status    |
| ------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------- | -------- | --------- |
| GAP-001 | Phase 1 does not support a module importing another module                                                                                                        | Medium   | Planned   |
| GAP-002 | Phase 1 exports the entire module project; partial export selection is deferred                                                                                   | Low      | Planned   |
| GAP-003 | Data-model field mapping UX is deferred to a later phase                                                                                                          | Medium   | Planned   |
| GAP-004 | Auth profile references validated at deploy time via `validateContractAuthProfiles()` (fail-closed)                                                               | High     | Resolved  |
| GAP-005 | Source-project DB-side `AgentModelConfig` is not portable in Phase 1 unless represented in DSL or release metadata                                                | Medium   | Planned   |
| GAP-006 | Imported tools mount only into the consumer default namespace in Phase 1                                                                                          | Medium   | Planned   |
| GAP-007 | Auto-upgrade and tenant-curated catalog controls deferred; reverse dependency UX and manual upgrade implemented in Phase 2                                        | Low      | Mitigated |
| GAP-008 | Deployment create/promote now materialize frozen module snapshots before cutover and restore the previous active deployment on module-build failures              | Medium   | Resolved  |
| GAP-009 | Browser smoke tests implemented — 4 Playwright scenarios (publish, import, update badge, feature gate)                                                            | Low      | Resolved  |
| GAP-010 | Sprint 5 rollout safety -- operational metrics, kill switch, feature gate implemented; dogfood validation pending                                                 | Low      | Mitigated |
| GAP-011 | `contract-auth-validator.ts` — 12 unit tests added (happy path, missing, type_mismatch, DB fail-closed, multi-dep, null contract)                                 | Medium   | Resolved  |
| GAP-012 | "Already archived" 400 path in release archive route — test added                                                                                                 | Low      | Resolved  |
| GAP-013 | `parseInt` NaN edge case in consumers route `limit` — fixed with NaN fallback to 20                                                                               | Low      | Resolved  |
| GAP-014 | `any` types in `deployment-build-service.ts:196-199` `_buildWithLock` models param — pre-existing, not Phase 2 code, but weakens type safety                      | Low      | Deferred  |
| GAP-015 | `Function` type on Redis lock helpers at `deployment-build-service.ts:52,70` — pre-existing, should be typed callbacks                                            | Low      | Deferred  |
| GAP-016 | `totalConsumers` in consumers route — fixed to use `countDocuments` for global count                                                                              | Low      | Resolved  |
| GAP-017 | `emptyContract` pattern — extracted to shared `EMPTY_MODULE_CONTRACT` constant in `project-io`                                                                    | Low      | Resolved  |
| GAP-018 | Richer observability UI for module provenance in traces (dedicated module provenance panel, filter by module alias) deferred to Phase 3                           | Low      | Planned   |
| GAP-019 | Studio module-management pages existed but were unreachable from project navigation; page wrappers, sidebar entries, and AppShell hydration now wire them in prod | High     | Resolved  |
| GAP-020 | Preview/import APIs previously bypassed private-module visibility when callers knew a module project ID                                                           | High     | Resolved  |
| GAP-021 | Environment-selector dependencies could drift from runtime truth in Studio because reads/imports trusted stale resolved-release fields                            | Medium   | Resolved  |
| GAP-022 | Deployment create/promote previously left the old active deployment retired/draining if `createDeployment()` failed after cutover began                           | High     | Resolved  |

**GAP-004 resolved:** Auth profile `requiredAuthProfiles` are validated at deploy time via `validateContractAuthProfiles()` in `contract-auth-validator.ts`. The validator is fail-closed: DB errors block deployment. E2E test `apps/runtime/src/__tests__/tools-deployment/module-upgrade-lifecycle.e2e.test.ts` (test d) exercises the full auth preflight chain.

---

## 17. Testing & Validation

### E2E Test Scenarios

| #   | Scenario                                                                                      | Status | Test File                                                                           |
| --- | --------------------------------------------------------------------------------------------- | ------ | ----------------------------------------------------------------------------------- |
| 1   | Publish a module, import it into a consumer project, deploy, and verify                       | Pass   | `apps/runtime/src/__tests__/tools-deployment/module-lifecycle.e2e.test.ts`          |
| 2   | Keep a consumer pinned to `1.0.0` while publishing `1.1.0` and verify behavior does not drift | Pass   | `apps/runtime/src/__tests__/tools-deployment/module-lifecycle.e2e.test.ts`          |
| 3   | Import the same module into two consumer projects with different config bindings              | Pass   | `apps/runtime/src/__tests__/tools-deployment/module-runtime-isolation.e2e.test.ts`  |
| 4   | Verify deployment snapshot includes module provenance after imported execution                | Pass   | `apps/runtime/src/__tests__/tools-deployment/module-runtime-provenance.e2e.test.ts` |
| 5   | Cross-tenant isolation (fabricated tenant2 ID, verify 404 behavior)                           | Pass   | `apps/runtime/src/__tests__/tools-deployment/module-runtime-isolation.e2e.test.ts`  |
| 6   | Concurrent release publishing, import, pointer promotion                                      | Pass   | `apps/runtime/src/__tests__/tools-deployment/module-concurrency.e2e.test.ts`        |
| 7   | Source module changes don't affect existing consumer deployment                               | Pass   | `apps/runtime/src/__tests__/tools-deployment/module-lifecycle.e2e.test.ts`          |
| 8   | Dependency removal verified                                                                   | Pass   | `apps/runtime/src/__tests__/tools-deployment/module-lifecycle.e2e.test.ts`          |
| 9   | Pointer promotion determinism (env:dev resolves to promoted, not latest)                      | Pass   | `apps/runtime/src/__tests__/tools-deployment/module-lifecycle.e2e.test.ts`          |
| 10  | Module preview in isolation                                                                   | Pass   | `apps/runtime/src/__tests__/tools-deployment/module-preview.e2e.test.ts`            |
| 11  | Cutover safety (failed deploy, no partial snapshot, actionable error, retry, compile error)   | Pass   | `apps/runtime/src/__tests__/tools-deployment/module-cutover-safety.e2e.test.ts`     |
| 12  | Upgrade dependency v1.0.0 → v1.1.0 and deploy                                                 | Pass   | `apps/runtime/src/__tests__/tools-deployment/module-upgrade-lifecycle.e2e.test.ts`  |
| 13  | Downgrade dependency v1.1.0 → v1.0.0 and deploy                                               | Pass   | `apps/runtime/src/__tests__/tools-deployment/module-upgrade-lifecycle.e2e.test.ts`  |
| 14  | Breaking change (removed agent) upgrade and deploy                                            | Pass   | `apps/runtime/src/__tests__/tools-deployment/module-upgrade-lifecycle.e2e.test.ts`  |
| 15  | Auth profile preflight failure blocks deployment                                              | Pass   | `apps/runtime/src/__tests__/tools-deployment/module-upgrade-lifecycle.e2e.test.ts`  |
| 16  | Browser smoke: publish, import, update badge, feature gate                                    | Pass   | `apps/studio/e2e/reusable-agent-modules-smoke.spec.ts`                              |

### Integration Test Scenarios

| #   | Scenario                                                                                                | Status | Test File                                                                                                                                                                                                                                           |
| --- | ------------------------------------------------------------------------------------------------------- | ------ | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 1   | Publish blocks inline secrets and source-only identifiers in artifacts                                  | Pass   | `packages/project-io/src/__tests__/module-publish-safety.test.ts`                                                                                                                                                                                   |
| 2   | Missing prerequisite detection blocks import                                                            | Pass   | `apps/runtime/src/__tests__/tools-deployment/module-runtime-isolation.e2e.test.ts` (P1-E04)                                                                                                                                                         |
| 3   | Combined deployment build creates a frozen module snapshot with resolved release metadata               | Pass   | `apps/runtime/src/services/modules/__tests__/deployment-build-service.test.ts`                                                                                                                                                                      |
| 4   | Cross-tenant module browse/import/resolve returns 404-style behavior                                    | Pass   | `apps/studio/src/__tests__/api-routes/api-module-catalog-routes.test.ts`                                                                                                                                                                            |
| 5   | Auth profile contract snapshot recorded in dependency                                                   | Pass   | `apps/runtime/src/__tests__/tools-deployment/module-runtime-isolation.e2e.test.ts` (P1-E13)                                                                                                                                                         |
| 6   | Contract diff classifies breaking/non-breaking/warn changes correctly                                   | Pass   | `packages/project-io/src/__tests__/module-contract-diff.test.ts`                                                                                                                                                                                    |
| 7   | Import validation: alias uniqueness, self-import, max deps, secrets                                     | Pass   | `apps/studio/src/__tests__/api-routes/api-module-dependencies.test.ts`                                                                                                                                                                              |
| 8   | Imported tools appear read-only with provenance badge                                                   | Pass   | `apps/studio/src/__tests__/components/tool-picker-imported-tools.test.tsx`                                                                                                                                                                          |
| 9   | Imported agents appear in routing/handoff/delegation authoring                                          | Pass   | `apps/studio/src/__tests__/components/coordination-section-imported-agents.test.tsx`                                                                                                                                                                |
| 10  | Upgrade PATCH: happy path, downgrade, audit, cross-module guard                                         | Pass   | `apps/studio/src/__tests__/api-routes/api-module-upgrade.test.ts`                                                                                                                                                                                   |
| 11  | Diff endpoint: breaking/non-breaking changes, prerequisites                                             | Pass   | `apps/studio/src/__tests__/api-routes/api-module-upgrade.test.ts`                                                                                                                                                                                   |
| 12  | Consumer listing with project names, pagination, active deployments                                     | Pass   | `apps/studio/src/__tests__/api-routes/api-module-consumers.test.ts`                                                                                                                                                                                 |
| 13  | Release archive: three-layer guard (pointer, snapshot, dependency)                                      | Pass   | `apps/studio/src/__tests__/api-routes/api-module-consumers.test.ts`                                                                                                                                                                                 |
| 14  | Studio module pages are reachable and hydrate imported symbols into authoring surfaces                  | Pass   | `apps/studio/src/__tests__/module-studio-wiring.test.tsx`, `apps/studio/src/__tests__/module-settings-page.test.tsx`, `apps/studio/src/__tests__/module-dependencies-page.test.tsx`, `apps/studio/src/__tests__/module-dependency-loading.test.tsx` |
| 15  | Preview/import enforce tenant-visible modules and reject stale environment-pointer imports              | Pass   | `apps/studio/src/__tests__/api-routes/api-module-dependencies.test.ts`                                                                                                                                                                              |
| 16  | Deployment create/promote restore the previous active deployment on module or deployment-record failure | Pass   | `apps/runtime/src/__tests__/tools-deployment/deployment-routes.test.ts`, `apps/runtime/src/__tests__/tools-deployment/deployment-promotion.test.ts`, `apps/runtime/src/__tests__/tools-deployment/module-cutover-safety.e2e.test.ts`                |

### Unit Test Coverage

| Package               | Tests                                                                                                                                    | Count |
| --------------------- | ---------------------------------------------------------------------------------------------------------------------------------------- | ----- |
| `packages/database`   | schema tests for releases, deps, snapshots, pointers, cascade delete                                                                     | 66    |
| `packages/project-io` | release-builder, contract, selector, publish-safety, contract-diff                                                                       | 101   |
| `apps/runtime`        | alias rewriter, deployment build, deployment-route rollback coverage, session store, feature gate, auth validator, and module E2E suites | 184   |
| `apps/studio`         | module routes, catalog, audit, dashboard, Studio wiring pages, dependency hydration, upgrade, consumers, authoring surfaces, and smoke   | 130   |

> Full testing details: [docs/testing/reusable-agent-modules.md](../testing/reusable-agent-modules.md)

---

## References

- Design doc: [../specs/reusable-agent-modules.hld.md](../specs/reusable-agent-modules.hld.md)
- Phase 1 LLD: [../plans/reusable-agent-modules-phase1-impl-plan.md](../plans/reusable-agent-modules-phase1-impl-plan.md)
- Phase 2 LLD: [../plans/2026-03-22-reusable-agent-modules-phase2-impl-plan.md](../plans/2026-03-22-reusable-agent-modules-phase2-impl-plan.md)
- Related features: [deployments-versioning.md](deployments-versioning.md), [agent-development-studio.md](agent-development-studio.md), [auth-profiles.md](auth-profiles.md), [environment-variables.md](environment-variables.md)

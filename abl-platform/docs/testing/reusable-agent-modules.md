# Feature Test Guide: Reusable Agent Modules

**Feature**: Module project authoring, immutable release publishing, consumer import, deployment snapshotting, runtime provenance
**Owner**: Platform team
**Branch**: develop
**First tested**: 2026-03-22
**Last updated**: 2026-04-16
**Overall status**: PARTIAL (BETA — production wiring remediated)

---

## Current State (as of 2026-04-16)

Phase 1 and Phase 2 remain functionally complete, and the April remediation closed the production-wiring gaps that were still preventing full Studio reachability and deployment-time module snapshot materialization. This pass added Studio wiring coverage, deployment-route rollback coverage, reran the locked module E2E suites against the real deployment API paths, and documented the consumer-surface design-time/runtime contract explicitly.

**Total test count: ~481 tests across 39 files** (66 database + 101 project-io + 184 runtime + 130 studio)

### Quick Health Dashboard

| Area                                       | Status    | Last Verified | Notes                                                                                               |
| ------------------------------------------ | --------- | ------------- | --------------------------------------------------------------------------------------------------- |
| Module data model                          | ✅ TESTED | 2026-04-15    | 4 models + cascade delete = 66 tests; `moduleReleaseIds` field added                                |
| Release builder and contract extraction    | ✅ TESTED | 2026-04-15    | 101 tests in project-io (+23 contract-diff tests)                                                   |
| Studio control-plane routes                | ✅ TESTED | 2026-04-15    | 18 route + 8 catalog + 21 dependency-route tests; private-module and pointer-drift guards verified  |
| Studio navigation and dependency hydration | ✅ TESTED | 2026-04-15    | 3 wiring tests + 2 settings-page tests + 2 dependencies-page tests + 3 dependency-loading tests     |
| Studio authoring UX                        | ✅ TESTED | 2026-04-15    | 12 dashboard + 5 tool picker + 6 coordination = 23 tests                                            |
| Runtime deployment snapshotting            | ✅ TESTED | 2026-04-15    | 16 deployment-build-service tests; snapshot metadata now uses resolved release truth                |
| Runtime deployment route rollback          | ✅ TESTED | 2026-04-15    | 26 create-route + 13 promotion-route tests; restores previous deployment on build or create failure |
| Runtime resolution and provenance          | ✅ TESTED | 2026-04-15    | 4 provenance E2E + 16 session store module tests                                                    |
| Runtime cutover safety                     | ✅ TESTED | 2026-04-15    | 5 cutover safety E2E tests plus targeted create/promote deployment-pipeline locks                   |
| Security and governance guards             | ✅ TESTED | 2026-04-15    | 20 publish safety + 53 alias rewriter + 6 cascade delete tests                                      |
| Rollout / feature gating                   | ✅ TESTED | 2026-04-15    | 11 runtime + 10 studio kill switch = 21 feature gate tests                                          |
| Browser smoke coverage                     | ✅ TESTED | 2026-04-15    | 4 Playwright scenarios (publish, import, update badge, feature gate)                                |
| Upgrade workflow                           | ✅ TESTED | 2026-04-15    | PATCH upgrade, diff preview, 15 route tests + 4 E2E lifecycle tests                                 |
| Reverse dependency and consumers           | ✅ TESTED | 2026-04-15    | Consumer listing, pagination, active deployment indicator, 11 route tests                           |
| Release archival                           | ✅ TESTED | 2026-04-15    | Three-layer guard (pointer, snapshot, dependency), 409 handling                                     |
| Auth profile preflight                     | ✅ TESTED | 2026-04-15    | Deploy-time validation, fail-closed, E2E test via upgrade lifecycle                                 |

---

## Test File Inventory

### Package Tests

| File                                                                       | Type               | Scenarios                                                           | Tests | Status  |
| -------------------------------------------------------------------------- | ------------------ | ------------------------------------------------------------------- | ----- | ------- |
| `packages/database/src/__tests__/model-module-release.test.ts`             | Unit               | Release uniqueness, tenant scoping, immutable fields                | 15    | ✅ PASS |
| `packages/database/src/__tests__/model-project-module-dependency.test.ts`  | Unit               | Alias uniqueness per consumer project, resolved release pin storage | 18    | ✅ PASS |
| `packages/database/src/__tests__/model-deployment-module-snapshot.test.ts` | Unit               | Snapshot linkage, hash persistence, deployment association          | 13    | ✅ PASS |
| `packages/database/src/__tests__/model-module-environment-pointer.test.ts` | Unit               | Environment pointer uniqueness, revision, promotion                 | 14    | ✅ PASS |
| `packages/database/src/__tests__/cascade-delete-modules.test.ts`           | Unit               | Module project, consumer project, and tenant cascade delete         | 6     | ✅ PASS |
| `packages/project-io/src/__tests__/module-release-builder.test.ts`         | Unit / Integration | Module artifact assembly from a module project                      | 21    | ✅ PASS |
| `packages/project-io/src/__tests__/module-contract.test.ts`                | Unit               | Prerequisite extraction for config, env vars, auth, connectors, MCP | 27    | ✅ PASS |
| `packages/project-io/src/__tests__/module-selector.test.ts`                | Unit               | Resolve version or environment selectors to immutable release IDs   | 10    | ✅ PASS |
| `packages/project-io/src/__tests__/module-publish-safety.test.ts`          | Unit               | Reject inline secrets and source-only identifiers                   | 20    | ✅ PASS |
| `packages/project-io/src/__tests__/module-contract-diff.test.ts`           | Unit               | Contract diff: breaking/non-breaking/warn classification, summaries | 23    | ✅ PASS |

### Runtime Tests

| File                                                                                | Type               | Scenarios                                                                      | Tests | Status  |
| ----------------------------------------------------------------------------------- | ------------------ | ------------------------------------------------------------------------------ | ----- | ------- |
| `apps/runtime/src/services/modules/__tests__/module-alias-rewriter.test.ts`         | Unit               | Deterministic `<alias>__<symbol>` rewriting across routing surfaces            | 53    | ✅ PASS |
| `apps/runtime/src/services/modules/__tests__/deployment-build-service.test.ts`      | Unit / Integration | Combined deployment build path for local plus imported sources                 | 16    | ✅ PASS |
| `apps/runtime/src/services/session/__tests__/session-store-modules.test.ts`         | Unit               | Serialized session state preserves module provenance across rehydration        | 16    | ✅ PASS |
| `apps/runtime/src/middleware/__tests__/feature-gate-modules.test.ts`                | Unit               | Feature gate fail-closed behavior, tenant resolution                           | 11    | ✅ PASS |
| `apps/runtime/src/__tests__/tools-deployment/deployment-routes.test.ts`             | Unit / Integration | Create route rollback, module build failure cleanup, deployment create guards  | 26    | ✅ PASS |
| `apps/runtime/src/__tests__/tools-deployment/deployment-promotion.test.ts`          | Unit / Integration | Promotion rollback, module snapshot cloning/build, channel auto-follow         | 13    | ✅ PASS |
| `apps/runtime/src/__tests__/tools-deployment/module-preview.e2e.test.ts`            | Integration / E2E  | Module project preview in isolation without public deployment endpoints        | 9     | ✅ PASS |
| `apps/runtime/src/__tests__/tools-deployment/module-lifecycle.e2e.test.ts`          | E2E                | Publish, import, deploy, pin stability, dependency removal, pointer promotion  | 5     | ✅ PASS |
| `apps/runtime/src/__tests__/tools-deployment/module-runtime-isolation.e2e.test.ts`  | E2E                | Consumer config isolation, alias collision, cross-tenant, auth profile         | 5     | ✅ PASS |
| `apps/runtime/src/__tests__/tools-deployment/module-runtime-provenance.e2e.test.ts` | E2E                | Deployment snapshot provenance, multi-agent, re-deployment, multi-module       | 4     | ✅ PASS |
| `apps/runtime/src/__tests__/tools-deployment/module-concurrency.e2e.test.ts`        | E2E                | Concurrent publish, import, immutability, pointer promotion, orphan detection  | 5     | ✅ PASS |
| `apps/runtime/src/__tests__/tools-deployment/module-cutover-safety.e2e.test.ts`     | E2E                | Failed deploy leaves prev active, no partial snapshot, actionable error, retry | 5     | ✅ PASS |
| `apps/runtime/src/__tests__/tools-deployment/module-upgrade-lifecycle.e2e.test.ts`  | E2E                | Upgrade, downgrade, breaking change, auth profile preflight                    | 4     | ✅ PASS |
| `apps/runtime/src/services/modules/__tests__/contract-auth-validator.test.ts`       | Unit               | Auth preflight: happy path, missing, type_mismatch, DB fail-closed, multi-dep  | 12    | ✅ PASS |

### Studio Tests

| File                                                                                 | Type               | Scenarios                                                                           | Tests | Status  |
| ------------------------------------------------------------------------------------ | ------------------ | ----------------------------------------------------------------------------------- | ----- | ------- |
| `apps/studio/src/__tests__/api-routes/api-module-routes.test.ts`                     | Unit / Integration | Publish, promote, permission checks, visibility, delete guards                      | 18    | ✅ PASS |
| `apps/studio/src/__tests__/api-routes/api-module-catalog-routes.test.ts`             | Unit / Integration | Consumer-project-scoped catalog behavior and visibility filtering                   | 8     | ✅ PASS |
| `apps/studio/src/__tests__/module-audit-events.test.ts`                              | Unit / Integration | Audit events emitted for publish, promote, import, remove                           | 10    | ✅ PASS |
| `apps/studio/src/__tests__/feature-gate-modules.test.ts`                             | Unit               | Kill switch: feature disabled → 403, enabled → pass, PLAN_FEATURES                  | 10    | ✅ PASS |
| `apps/studio/src/__tests__/components/project-dashboard-modules.test.tsx`            | Unit               | Project dashboard, card, and switcher show module-aware actions                     | 12    | ✅ PASS |
| `apps/studio/src/__tests__/module-studio-wiring.test.tsx`                            | Unit               | Sidebar entries, module page reachability, navigation config wiring                 | 3     | ✅ PASS |
| `apps/studio/src/__tests__/module-settings-page.test.tsx`                            | Unit               | Settings page composition, publish trigger, release list                            | 2     | ✅ PASS |
| `apps/studio/src/__tests__/module-dependencies-page.test.tsx`                        | Unit               | Dependencies page composition and import trigger                                    | 2     | ✅ PASS |
| `apps/studio/src/__tests__/module-dependency-loading.test.tsx`                       | Integration        | Project-level dependency hydration and graceful failure handling                    | 3     | ✅ PASS |
| `apps/studio/src/__tests__/api-routes/api-module-dependencies.test.ts`               | Unit / Integration | Import validation, visibility guards, pointer drift, removal safety, self-import    | 21    | ✅ PASS |
| `apps/studio/src/__tests__/components/tool-picker-imported-tools.test.tsx`           | Unit               | Imported tools appear read-only and provenance-labeled                              | 5     | ✅ PASS |
| `apps/studio/src/__tests__/components/coordination-section-imported-agents.test.tsx` | Unit               | Imported agents appear in routing / handoff / delegation authoring                  | 6     | ✅ PASS |
| `apps/studio/src/__tests__/api-routes/api-module-upgrade.test.ts`                    | Unit / Integration | Upgrade PATCH, diff endpoint, downgrade, audit, cross-module guard                  | 15    | ✅ PASS |
| `apps/studio/src/__tests__/api-routes/api-module-consumers.test.ts`                  | Unit / Integration | Consumer listing, release detail, archive three-layer guard, already-archived guard | 11    | ✅ PASS |
| `apps/studio/e2e/reusable-agent-modules-smoke.spec.ts`                               | Browser smoke      | Publish, import, update badge, feature gate (Playwright)                            | 4     | ✅ PASS |

---

## Test Coverage Map

### Module Authoring and Release Lifecycle

- [x] Mark an existing project as `kind='module'` (api-module-routes.test.ts)
- [x] Keep ordinary projects defaulted to `kind='application'` (model-module-release.test.ts)
- [x] Preview a module project without creating a public endpoint (module-preview.e2e.test.ts, 9 tests)
- [x] Publish an immutable release from a module project (module-lifecycle.e2e.test.ts P1-E01)
- [x] Promote a release pointer through `dev`, `staging`, and `production` (module-lifecycle.e2e.test.ts P1-E10)
- [x] Reject duplicate publish attempts for the same module version with a clean `409` (module-concurrency.e2e.test.ts R16)

### Consumer Import and Validation

- [x] Browse only modules visible from the current consumer project context (api-module-catalog-routes.test.ts)
- [x] Import a release with a required alias and explicit `resolvedReleaseId` (module-lifecycle.e2e.test.ts P1-E01)
- [x] Reject alias collisions within the same consumer project (module-alias-rewriter.test.ts, api-module-dependencies.test.ts)
- [x] Reject imports when required config, env vars, auth profiles, connectors, or MCP servers are missing (module-runtime-isolation.e2e.test.ts P1-E04)
- [x] Reject self-import (project importing itself) (api-module-dependencies.test.ts)
- [x] Enforce max dependency limit (5) per consumer project (api-module-dependencies.test.ts)
- [x] Reject config overrides that include secret key values (api-module-dependencies.test.ts)
- [x] Return 404 when module project does not exist or is not a module (api-module-dependencies.test.ts)
- [x] Reject preview/import for private modules even when the caller knows the module project ID (api-module-dependencies.test.ts)
- [x] Reject stale environment-pointer imports after the pointed release changes (api-module-dependencies.test.ts)
- [x] Handle duplicate alias via DB unique index (MongoDB 11000) (api-module-dependencies.test.ts)
- [ ] Block dependency removal or alias changes when local DSL still references mounted names (planned)

### Deployment Snapshotting and Runtime Resolution

- [x] Resolve dependency selectors to one immutable release per alias at deployment time (module-selector.test.ts, module-lifecycle.e2e.test.ts)
- [x] Build and persist a `DeploymentModuleSnapshot` separate from the `Deployment` record (deployment-build-service.test.ts)
- [x] Rewrite imported symbols consistently across routing, delegation, fan-out, and tool lookup (module-alias-rewriter.test.ts, 53 tests)
- [x] Keep non-module deployment behavior unchanged when a project has no module dependencies (deployment-build-service.test.ts fast path)
- [x] Ensure source module working-copy changes do not change an already-created consumer deployment (module-lifecycle.e2e.test.ts P1-E08)
- [x] Failed deployment leaves previous active deployment intact (module-cutover-safety.e2e.test.ts GAP-008a)
- [x] No partial snapshot exists after a failed deployment attempt (module-cutover-safety.e2e.test.ts GAP-008b)
- [x] Failed deployment returns actionable error identifying the problem (module-cutover-safety.e2e.test.ts GAP-008c)
- [x] Deployment succeeds on retry after fixing the issue (module-cutover-safety.e2e.test.ts GAP-008d)
- [x] Compile error during auto-version leaves previous deployment active (module-cutover-safety.e2e.test.ts GAP-008e)
- [x] Create/promotion route restores the previous deployment if `createDeployment()` fails after cutover begins (deployment-routes.test.ts, deployment-promotion.test.ts)
- [x] `moduleReleaseIds` denormalized array populated on snapshot creation (deployment-build-service.ts)

### Contract Diff (Phase 2)

- [x] Identical contracts produce no changes (module-contract-diff.test.ts)
- [x] Added agents/tools classified as non-breaking (module-contract-diff.test.ts)
- [x] Removed agents/tools classified as breaking (module-contract-diff.test.ts)
- [x] New required prerequisites (envVars, authProfiles, connectors, mcpServers, configKeys) classified as breaking (module-contract-diff.test.ts)
- [x] Removed prerequisites classified as non-breaking (module-contract-diff.test.ts)
- [x] Changed metadata (description, toolType, isSecret) classified as warn (module-contract-diff.test.ts)
- [x] Mixed breaking/non-breaking/warn diff correctly summarized (module-contract-diff.test.ts)
- [x] Realistic multi-category diff handles all categories correctly (module-contract-diff.test.ts)

### Upgrade Workflow (Phase 2)

- [x] In-place PATCH upgrade to a newer release (api-module-upgrade.test.ts, module-upgrade-lifecycle.e2e.test.ts)
- [x] Downgrade to an older release via PATCH (api-module-upgrade.test.ts, module-upgrade-lifecycle.e2e.test.ts)
- [x] Breaking change upgrade with removed agents (module-upgrade-lifecycle.e2e.test.ts)
- [x] Upgrade diff preview shows contract changes and prerequisite issues (api-module-upgrade.test.ts)
- [x] Archived release rejected during upgrade (api-module-upgrade.test.ts)
- [x] Cross-module guard: cannot upgrade to release from different module (api-module-upgrade.test.ts)
- [x] MODULE_UPGRADED audit event emitted (api-module-upgrade.test.ts)
- [x] moduleDependencyVersion incremented on upgrade (api-module-upgrade.test.ts)
- [x] Update-available indicators enriched on GET dependencies (api-module-dependencies.test.ts)

### Reverse Dependencies and Archival (Phase 2)

- [x] Consumer listing with project name enrichment (api-module-consumers.test.ts)
- [x] Cursor pagination on consumer listing (api-module-consumers.test.ts)
- [x] Active deployment indicator for consumers (api-module-consumers.test.ts)
- [x] Release detail excludes compiledIR (api-module-consumers.test.ts)
- [x] Archive blocked by environment pointer — 409 (api-module-consumers.test.ts)
- [x] Archive blocked by deployment snapshot — 409 (api-module-consumers.test.ts)
- [x] Archive blocked by dependency reference — 409 (api-module-consumers.test.ts)
- [x] Auth profile preflight blocks deployment when profiles missing (module-upgrade-lifecycle.e2e.test.ts)
- [x] "Already archived" 400 path when re-archiving an already-archived release (GAP-012, api-module-consumers.test.ts)

### Studio Wiring and Reachability

- [x] Project navigation exposes reachable `Modules` and `Dependencies` pages (module-studio-wiring.test.tsx)
- [x] Module settings page renders the settings panel, release list, and publish trigger (module-settings-page.test.tsx)
- [x] Module dependencies page renders the dependency list and import trigger (module-dependencies-page.test.tsx)
- [x] Project-level dependency hydration populates `useImportedSymbols` and degrades gracefully on load failure (module-dependency-loading.test.tsx)

### Two-Project UI Walkthrough Contract

- [x] Source project exposes a reachable `Settings -> Modules` authoring surface for turning a project into a module and publishing releases (module-studio-wiring.test.tsx, module-settings-page.test.tsx)
- [x] Consumer project exposes a reachable `Dependencies` surface for importing a module into an existing application project (module-studio-wiring.test.tsx, module-dependencies-page.test.tsx)
- [x] Import remains a two-step UX: choose module + selector + alias, then review resolved symbols / prerequisites / overrides before confirming (api-module-dependencies.test.ts, reusable-agent-modules-smoke.spec.ts)
- [x] Imported dependency rows show alias plus selector semantics (`pin` vs `env`) and update availability where applicable (api-module-dependencies.test.ts, api-module-upgrade.test.ts)
- [x] Imported symbols become available in contextual authoring surfaces after dependency hydration, rather than being copied into standard editable local inventories (module-dependency-loading.test.tsx, tool-picker-imported-tools.test.tsx, coordination-section-imported-agents.test.tsx)
- [x] Consumer deployment remains the runtime activation point: deployment re-resolves the dependency, validates prerequisites, and snapshots the resolved module release for stable execution (deployment-build-service.test.ts, deployment-routes.test.ts, deployment-promotion.test.ts, module-lifecycle.e2e.test.ts)

### Consumer Surface Semantics

| Asset Type                       | Design-Time Contract                                                                                                                                 | Runtime Contract                                                                                                                             | Verification Status               |
| -------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------- |
| Imported agents                  | Read-only imported symbols exposed from dependency contract snapshots in module-aware authoring surfaces such as the symbol tree and coordination UI | Mounted as deterministic `<alias>__<agent>` entries with provenance in deployment snapshots and merged into the resolved consumer deployment | ✅ TESTED                         |
| Imported tools                   | Read-only imported symbols exposed from dependency contract snapshots in the symbol tree and tool picker; inserted as `alias.tool_name()`            | Mounted as deterministic `<alias>__<tool>` definitions with provenance in deployment snapshots and runtime tool resolution                   | ✅ TESTED                         |
| Workflows                        | Not imported into consumer workflow inventory or authoring surfaces                                                                                  | No workflow mounting or snapshotting path                                                                                                    | ✅ TESTED (local-only regression) |
| Knowledge bases / search indexes | Not imported into consumer Search AI / knowledge-base inventory                                                                                      | No knowledge-base or search-index mounting or snapshotting path                                                                              | ✅ TESTED (local-only regression) |

- [x] Dependency hydration derives imported agents/tools from dependency contract snapshots and refreshes when the project context changes (module-dependency-loading.test.tsx)
- [x] Imported tools appear read-only with provenance labels in the tool picker and are inserted as alias-prefixed references (tool-picker-imported-tools.test.tsx)
- [x] Imported agents appear read-only with provenance labels in routing / handoff / delegation authoring using alias-prefixed names (coordination-section-imported-agents.test.tsx)
- [x] Runtime alias rewriting converts author-facing imported references into deterministic mounted `<alias>__<symbol>` names for snapshotting and execution (module-alias-rewriter.test.ts, deployment-build-service.test.ts)
- [x] Existing deployment snapshots remain pinned even after source-module publishes or environment-pointer movement (module-lifecycle.e2e.test.ts)
- [x] Dedicated UI regression proving the standard consumer `Agents` and `Tools` inventory pages exclude imported symbols (agent-list-page.test.tsx, tools-list-page-import.test.tsx)
- [x] Dedicated UI regression proving `Workflows` and `Knowledge Bases` remain local-only and are not imported through modules (empty-state-header-actions-regression.test.tsx)

### Auth Profile Preflight (Phase 2 — GAP-011)

- [x] Missing auth profile blocks deployment — E2E (module-upgrade-lifecycle.e2e.test.ts test d)
- [x] `validateContractAuthProfiles` — happy path: all profiles present (contract-auth-validator.test.ts)
- [x] `validateContractAuthProfiles` — fail: profile name mismatch / type mismatch (contract-auth-validator.test.ts)
- [x] `validateContractAuthProfiles` — fail-closed: DB error blocks deployment (contract-auth-validator.test.ts)
- [x] `validateContractAuthProfiles` — partial failures collected across multiple dependencies (contract-auth-validator.test.ts)

### Isolation, Security, and Governance

- [x] Keep all runtime execution inside the consumer project's tenant, project, audit, and retention boundaries (module-runtime-isolation.e2e.test.ts P1-E03)
- [x] Reject publish when a module artifact would export inline secrets (module-publish-safety.test.ts, 20 tests)
- [x] Reject publish when source-only identifiers such as namespace IDs leak into artifacts (module-publish-safety.test.ts)
- [x] Return 404-style behavior for cross-tenant browse, import, and runtime resolution attempts (module-runtime-isolation.e2e.test.ts P1-E07, api-module-catalog-routes.test.ts)
- [x] Block release archive or delete while releases are referenced by pointers, dependencies, or deployment snapshots (cascade-delete-modules.test.ts)
- [x] Auth profile contract snapshot recorded for deploy preflight validation (module-runtime-isolation.e2e.test.ts P1-E13)
- [x] Fail deploy preflight when name-based auth profile references are renamed or removed (module-upgrade-lifecycle.e2e.test.ts test d)

### Rollout and Feature Gating

- [x] Feature disabled returns 403 FEATURE_DISABLED on all module routes (feature-gate-modules.test.ts)
- [x] Feature enabled allows handler execution (feature-gate-modules.test.ts)
- [x] Feature resolution error fails closed to 403 (feature-gate-modules.test.ts, feature-resolver.ts fail-closed logic)
- [x] `reusable_modules` is in BUSINESS and ENTERPRISE tiers only (feature-gate-modules.test.ts PLAN_FEATURES coverage)
- [x] Feature gate fires before project access check — fail fast (route-handler.ts middleware ordering)
- [x] All 11 module route handlers gated with `requireFeature: 'reusable_modules'` (wiring verification)
- [x] Feature resolution cached per tenant+feature with 60s TTL (feature-resolver.ts)
- [x] Runtime feature gate middleware blocks module endpoints when disabled (feature-gate-modules.test.ts runtime, 11 tests)

### Observability and UX

- [x] Show imported tools as read-only with provenance badge in tool picker (tool-picker-imported-tools.test.tsx, 5 tests)
- [x] Show imported agents in routing/handoff/delegation authoring with provenance label (coordination-section-imported-agents.test.tsx, 6 tests)
- [x] Include module provenance in deployment snapshots (module-runtime-provenance.e2e.test.ts P1-E06)
- [x] Preserve module provenance through persisted session rehydration (session-store-modules.test.ts)
- [x] Emit sanitized audit events for module lifecycle actions (module-audit-events.test.ts, 10 tests)
- [x] Show actionable error copy for alias conflicts, missing prerequisites, and delete guards (api-module-routes.test.ts)

---

## Detailed E2E Scenarios

### P1-E01: Publish, Import, Deploy, Execute

**Goal**

Prove the entire customer story through public APIs.

**Setup**

- Project A in tenant T is converted to a module
- Project B in tenant T remains a normal application project
- Project A exposes one supervisor agent and one tool

**Assertions**

- Project A can preview in isolation
- Release `1.0.0` can be published
- Project B can import the release with alias `benefits`
- Deployment creation for Project B succeeds and persists a module snapshot
- A Project B session can route into the imported module agent
- Traces show module provenance
- Data remains scoped to Project B

### P1-E02: Explicit Pinning and Non-Drift

**Goal**

Prove consumers do not move when the module evolves.

**Setup**

- Consumer imports `1.0.0`
- Module author later publishes `1.1.0`

**Assertions**

- Existing consumer deployment behavior does not change
- A fresh consumer deployment remains pinned until the dependency is explicitly updated
- Pointer movement in the module project does not mutate the consumer deployment snapshot

### P1-E03: Same Module, Different Consumer Bindings

**Goal**

Prove shared logic and consumer-specific behavior can coexist safely.

**Setup**

- Two consumer projects import the same module release
- Each consumer provides different config overrides and credentials

**Assertions**

- Both consumers resolve the same `moduleReleaseId`
- Responses differ only according to consumer-supplied configuration
- Secrets and env values do not leak across consumer projects

### P1-E04: Alias Collision Safety

**Goal**

Prove two modules with overlapping symbol names can coexist in one consumer project.

**Setup**

- Module A and Module B both export the same tool and agent names
- Consumer imports them with different aliases

**Assertions**

- Mounted names remain deterministic and unique
- Routing and tool execution succeed against both aliases
- Studio authoring surfaces label the imported symbols with the correct provenance

### P1-E05: Cutover Safety

**Goal**

Prove failed module-backed deployment creation does not break the last healthy environment.

**Setup**

- Consumer project already has an active deployment
- A new module-backed deployment is attempted with a public API-visible validation failure

**Assertions**

- Previous deployment remains active
- No partially built snapshot is attached to the active deployment
- Error output is actionable and sanitized

---

## Regression Matrix

| ID     | Regression risk                                                                 | Required assertion                                                       | Planned test location                                                                                   |
| ------ | ------------------------------------------------------------------------------- | ------------------------------------------------------------------------ | ------------------------------------------------------------------------------------------------------- |
| P1-R01 | Existing projects break because `Project.kind` was added                        | Project create/list/update still defaults to `application`               | `apps/studio/src/__tests__/api-projects.test.ts`                                                        |
| P1-R02 | Existing deployment creation regresses for projects with no module dependencies | Deployment behavior is unchanged for non-module projects                 | `apps/runtime/src/__tests__/deployment-routes.test.ts`                                                  |
| P1-R03 | Existing preview flow regresses                                                 | Non-module preview still works exactly as before                         | `apps/runtime/src/__tests__/tools-deployment/module-preview.e2e.test.ts` plus existing preview coverage |
| P1-R04 | `project-io` export/import flows accidentally couple to module logic            | Existing portability tests continue to pass without module configuration | existing `packages/project-io` suites                                                                   |
| P1-R05 | Source namespace identifiers leak into module artifacts                         | Release artifacts omit source-only IDs                                   | `packages/project-io/src/__tests__/module-release-builder.test.ts`                                      |
| P1-R06 | Trace consumers break on new module provenance fields                           | Trace payloads remain backward compatible when module fields are absent  | `apps/runtime/src/__tests__/trace-store.test.ts`                                                        |
| P1-R07 | Auth profile rename/delete causes silent credential drift                       | Preflight fails closed with actionable remediation                       | `apps/runtime/src/services/auth-profile/auth-preflight.test.ts`                                         |
| P1-R08 | Session resume loses module provenance                                          | Rehydrated sessions still expose alias/release/source metadata           | `apps/runtime/src/__tests__/tools-deployment/module-runtime-provenance.e2e.test.ts`                     |
| P1-R09 | Failed module-backed deployment retires the last healthy deployment             | Previous deployment remains active after failure                         | `apps/runtime/src/__tests__/tools-deployment/module-cutover-safety.e2e.test.ts`                         |
| P1-R10 | Feature flag off-path regresses normal Studio UX                                | Module UI stays hidden cleanly when the feature is disabled              | `apps/studio/e2e/reusable-agent-modules-smoke.spec.ts`                                                  |

---

## Known Gaps and Next Tests

### Completed (Sprints 1-5)

1. ✅ Package-level schema and artifact tests (66 database + 78 project-io tests)
2. ✅ Runtime deployment-build and resolver tests (15 build service + 16 session store)
3. ✅ End-to-end runtime lifecycle tests (5 lifecycle + 5 isolation + 4 provenance + 5 concurrency)
4. ✅ Delete-guard, alias-conflict, and cross-tenant tests (6 cascade + 53 alias rewriter + 8 catalog)
5. ✅ Kill switch verification — Studio feature gate tests (10 tests) + Runtime feature gate tests (11 tests)
6. ✅ Operational metrics stubs — structured logging for publish, import, deploy, promote timing

7. ✅ Contract diff unit tests — 23 tests covering breaking/non-breaking/warn classification (Phase 2 Sprint 1)
8. ✅ Cutover safety E2E tests — 5 tests closing GAP-008 (Phase 2 Sprint 1)
9. ✅ Import validation Studio tests — 17 tests for alias uniqueness, self-import, max deps, secrets (Phase 2 Sprint 1)
10. ✅ Tool picker (5 tests) and coordination section (6 tests) imported symbol tests (Phase 1 Sprint 3, corrected status)

### Phase 2 Sprint 1-3 Completed

11. ✅ Browser smoke: 4 Playwright scenarios (publish, import, update badge, feature gate)
12. ✅ Upgrade workflow: 15 route tests + 4 E2E lifecycle tests
13. ✅ Consumer/archive: 10 route tests (listing, pagination, three-layer guard)
14. ✅ Auth profile preflight: fail-closed validation exercised via upgrade lifecycle E2E

### Remaining Coverage Gaps

15. ❌ Operational metrics validation (publish/import error rates, snapshot sizes) — Phase 3
16. ❌ Performance and snapshot-size checks once realistic module payloads exist — Phase 3
17. ✅ Dedicated unit test for `contract-auth-validator.ts` — 12 tests added (GAP-011 closed)
18. ✅ "Already archived" 400 path in archive route — test added (GAP-012 closed)
19. ✅ `parseInt` NaN fallback in consumers route — fixed (GAP-013 closed)
20. ✅ `totalConsumers` uses `countDocuments` — fixed (GAP-016 closed)
21. ✅ Shared `EMPTY_MODULE_CONTRACT` constant in `project-io` — extracted (GAP-017 closed)

---

## Running Tests

Run `pnpm build` before `pnpm test`. Use these commands for the remediated module surfaces:

```bash
# Package-level module tests
pnpm test --filter=project-io -- module-release
pnpm test --filter=database -- module

# Runtime module lifecycle and isolation
pnpm --filter @agent-platform/runtime build
pnpm --filter @agent-platform/runtime exec vitest run src/__tests__/tools-deployment/module-lifecycle.e2e.test.ts
pnpm --filter @agent-platform/runtime exec vitest run src/__tests__/tools-deployment/module-runtime-isolation.e2e.test.ts
pnpm --filter @agent-platform/runtime exec vitest run src/__tests__/tools-deployment/module-runtime-provenance.e2e.test.ts
pnpm --filter @agent-platform/runtime exec vitest run src/__tests__/tools-deployment/module-cutover-safety.e2e.test.ts
pnpm --filter @agent-platform/runtime exec vitest run src/__tests__/tools-deployment/deployment-routes.test.ts src/__tests__/tools-deployment/deployment-promotion.test.ts

# Studio control-plane, authoring, and kill switch coverage
pnpm --filter @agent-platform/studio build
pnpm --filter @agent-platform/studio exec vitest run src/__tests__/api-routes/api-module-routes.test.ts src/__tests__/api-routes/api-module-dependencies.test.ts src/__tests__/feature-gate-modules.test.ts src/__tests__/module-studio-wiring.test.tsx src/__tests__/module-settings-page.test.tsx src/__tests__/module-dependencies-page.test.tsx src/__tests__/module-dependency-loading.test.tsx

# Browser smoke
pnpm test --filter=studio -- apps/studio/e2e/reusable-agent-modules-smoke.spec.ts
```

---

## References

- Feature doc: [../features/reusable-agent-modules.md](../features/reusable-agent-modules.md)
- HLD: [../specs/reusable-agent-modules.hld.md](../specs/reusable-agent-modules.hld.md)

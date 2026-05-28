# LLD: Change Management

**Feature Spec**: `docs/features/change-management.md`
**HLD**: `docs/specs/change-management.hld.md`
**Test Spec**: `docs/testing/change-management.md`
**Status**: DRAFT
**Date**: 2026-04-15

---

## 0. Problem Statement

The implementation risk is not just writing a new runner. We need to land a shared change-management control plane without breaking the currently working Mongo migration or seed flows, while also closing the rollout-owner, readiness-gate, tenant-bootstrap, and fragmented-script gaps identified in the feature spec and HLD.

This plan therefore separates behavior-preserving refactors from behavior-changing integrations, keeps each implementation slice small enough to review safely, and preserves existing exports and entrypoints until the new control plane has proven parity.

---

## 1. Design Decisions

### Decision Log

| #    | Decision                                                                                                      | Rationale                                                                                                               | Alternatives Rejected                                                                                   |
| ---- | ------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------- |
| D-1  | Introduce a shared manifest and ledger contract first, then adapt existing runners behind it.                 | Lowest-risk path that preserves the working Mongo/seed foundations.                                                     | Full rewrite into one new runner from day one.                                                          |
| D-2  | Keep service compatibility requirements in code, not central config.                                          | Versioned dependency declarations should travel with the code that requires them.                                       | `MIGRATION_REQUIRED_VERSION`-style env-only configuration.                                              |
| D-3  | Default to soft readiness failure for missing required changes.                                               | Safer for diagnosis in clustered rollouts while still preventing traffic.                                               | Hard startup failure as the only mode.                                                                  |
| D-4  | Treat reference-data sync as a first-class change kind rather than overloading the existing seed CLI forever. | Separates code-required platform data from dev-only fixtures.                                                           | Leaving all seed behavior as a separate non-release-aware subsystem.                                    |
| D-5  | Use heartbeat plus fencing on the lease lock before expanding backfill scope.                                 | Correctness under clustered execution is more important than early parallelism.                                         | Adding resumable backfills before hardening the lock model.                                             |
| D-6  | Inventory and register existing orphaned SQL/scripts before deprecating them.                                 | We need a complete map of repo change surfaces before enforcing "manifest or fail".                                     | Immediate CI failure on any unregistered script without a migration path.                               |
| D-7  | Prefer deploy-owned ArgoCD `PreSync`/`PostSync` Jobs over init containers for shared-state mutation.          | One rollout-scoped Job is operationally correct; init containers execute per pod.                                       | Running migrations or global seeds inside per-pod init containers.                                      |
| D-8  | Keep Runtime and SearchAI as local readiness gates, while Admin stays proxy-first in phase 1.                 | Matches the current repo shape: Admin has proxy routes and no direct ledger access.                                     | Forcing Admin's local `/api/health` to become a second direct DB gate.                                  |
| D-9  | Treat the deploy repo's change-management application or hook as a required part of the rollout contract.     | Prevents independent app rollouts from racing shared-state hooks or shipping drift.                                     | Letting each application attach its own global `PreSync`/`PostSync` hooks.                              |
| D-10 | Add explicit execution trigger metadata (`deploy`, `tenant_lifecycle`, `manual`) to the manifest.             | The current seed model is intentionally split; phase + kind alone do not explain who or what initiated a change.        | Overloading `phase=continuous` to mean both deploy-time diff sync and tenant bootstrap lifecycle hooks. |
| D-11 | Keep Configuration Management as the source of truth for runtime config and promotion evidence.               | Change Management should correlate a release with config validation and diff evidence, not duplicate config state.      | Storing raw config or feature-flag values directly in the shared change ledger.                         |
| D-12 | Treat validation and observability as first-class release evidence, not post-hoc operator extras.             | Enterprise rollout safety depends on being able to prove what ran, what config accompanied it, and what is blocked now. | Relying on CLI logs or ad-hoc dashboards after the fact.                                                |

### Key Interfaces & Types

```typescript
export type ChangePhase = 'pre_deploy' | 'post_deploy' | 'continuous';

export type ChangeTrigger = 'deploy' | 'manual' | 'tenant_lifecycle';

export type ChangeKind =
  | 'schema'
  | 'backfill'
  | 'seed_platform'
  | 'seed_tenant'
  | 'seed_dev'
  | 'secret'
  | 'bridge';

export type ChangeEngine = 'mongodb' | 'clickhouse' | 'script' | 'secret';

export interface ChangeManifestEntry {
  id: string;
  description: string;
  phase: ChangePhase;
  trigger: ChangeTrigger;
  kind: ChangeKind;
  engine: ChangeEngine;
  scope: 'global' | 'tenant';
  envs: Array<'dev' | 'staging' | 'prod'>;
  requires: string[];
  blocking: 'deploy_required' | 'startup_required' | 'warn_only';
  destructive: boolean;
  reversibility: 'rollback' | 'compensating' | 'forward_only';
}

export interface ChangeHistoryRecord {
  id: string;
  status: 'applied' | 'failed' | 'verified' | 'skipped' | 'paused';
  checksum?: string;
  validationStatus?: 'passed' | 'failed' | 'not_configured' | 'never_run';
  runCount?: number;
  fence?: number;
  lastError?: string | null;
  ownerApplication?: string;
  artifactRef?: string;
  manifestDigest?: string;
  configSnapshotRef?: string;
  configDiffRef?: string;
  lowerEnvironmentValidationRef?: string;
  traceId?: string;
}

export interface ServiceChangeRequirement {
  service: 'runtime' | 'search-ai' | 'admin';
  required: string[];
  optional: string[];
  enforcementMode: 'soft_ready' | 'hard_fail' | 'warn_only' | 'proxy_only';
}
```

### Module Boundaries

| Module                                                     | Responsibility                                                           | Depends On                                  |
| ---------------------------------------------------------- | ------------------------------------------------------------------------ | ------------------------------------------- |
| `packages/database/src/change-management/types.ts`         | Shared manifest, history, and compatibility types                        | none                                        |
| `packages/database/src/change-management/manifest.ts`      | Registry loading, dependency validation, environment filtering           | `types.ts`                                  |
| `packages/database/src/change-management/lease.ts`         | Shared lock, heartbeat, fence handling                                   | MongoDB connection                          |
| `packages/database/src/change-management/history.ts`       | Read/write normalized ledger records                                     | MongoDB connection, `types.ts`              |
| `packages/database/src/change-management/runner.ts`        | Planner that sequences manifest entries and delegates to engine adapters | manifest, lease, history                    |
| `packages/database/src/change-management/observability.ts` | Emit TraceStore events, OTel metrics, and alert-friendly summaries       | history, manifest, TraceStore               |
| `packages/database/src/change-management/adapters/*`       | Mongo, seed/reference-data, ClickHouse, and script execution adapters    | existing runners/helpers                    |
| `packages/database/src/change-management/version-gate.ts`  | Service compatibility resolver for required change IDs                   | history, `types.ts`                         |
| `packages/config/src/validation/config-diff.ts`            | Existing config diff/validation helper consumed by release planning      | config schemas                              |
| `apps/runtime/src/change-management/*`                     | Runtime-local requirement declarations and readiness integration         | shared version gate                         |
| `apps/search-ai/src/change-management/*`                   | SearchAI-local requirement declarations and readiness integration        | shared version gate                         |
| `apps/admin/src/change-management/*`                       | Admin dependency declarations and proxy/system-health integration        | shared version gate                         |
| `apps/studio/src/repos/workspace-repo.ts`                  | Tenant lifecycle bootstrap caller for workspace creation                 | `@agent-platform/database`, pipeline engine |
| `apps/studio/src/app/api/auth/dev-login/route.ts`          | Tenant lifecycle bootstrap caller for dev-login / tenant attachment      | `workspace-repo.ts`, shared auth            |
| `apps/runtime/src/routes/platform-admin-tenants.ts`        | Tenant lifecycle bootstrap caller for admin-created tenants              | shared bootstrap helpers                    |

### Experience-to-Implementation Map

This section translates the design into "what code path delivers what user experience?"

| Change kind     | Primary implementation modules                                                                 | Execution experience to deliver                                                              | Blocking / visibility contract                                                           |
| --------------- | ---------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------- |
| `schema`        | `manifest.ts`, Mongo or ClickHouse adapter, `release-job.ts`, `version-gate.ts`                | One rollout-owned job applies the change once before compatible pods serve traffic.          | Status in `_change_history`; Runtime/SearchAI readiness can block on required IDs.       |
| `backfill`      | `manifest.ts`, `backfill-worker.ts`, `history.ts`, admin status/control routes                 | Long-running work resumes from checkpoints and can be paused, resumed, retried, or canaried. | Progress in `_change_backfill_progress`; operators see status, alerts, and future deps.  |
| `seed_platform` | seed adapter, `seed-mongo.ts` integration, `release-job.ts`, validation/status routes          | Deploy-time platform-core seed is treated as release work, not hidden pod init behavior.     | Global platform-core readiness is visible and can block when code depends on it.         |
| `seed_tenant`   | lifecycle callers in Studio and Runtime admin flows, seed adapter, `history.ts`                | Tenant bootstrap runs on workspace or tenant lifecycle events, not as global rollout work.   | Tenant completeness is visible separately from deploy readiness.                         |
| `seed_dev`      | seed adapter plus env filters                                                                  | Dev fixtures stay explicitly scoped to dev/lower environments.                               | Never block prod readiness; visible as lower-environment state only.                     |
| `secret`        | script adapter, secret metadata reporting, config-evidence refs, validation/status routes      | Secret operations remain external, but their execution and completeness are visible.         | Ledger stores metadata only; status surfaces missing secret evidence without raw values. |
| `bridge`        | manifest classification, service requirement modules, compatibility shims, deprecation markers | Temporary compatibility windows are tracked until cleanup is safe.                           | Operators can see whether bridge retirement is still blocked by rollout dependencies.    |

| Concern                        | Primary modules / phases                                                             | Expected experience                                                                                |
| ------------------------------ | ------------------------------------------------------------------------------------ | -------------------------------------------------------------------------------------------------- |
| Deployment ownership           | Phase 1 manifest, Phase 4 runner convergence, deploy repo hook wiring                | Exactly one rollout-owned artifact executes shared-state `pre_deploy` and `post_deploy` work.      |
| Service readiness              | Phase 3 `version-gate.ts`, service `requirements.ts`, Runtime/SearchAI `server.ts`   | Services verify compatibility locally and stay non-ready when mandatory changes are missing.       |
| Tenant bootstrap completeness  | Phase 4 lifecycle classification, Phase 5 status APIs                                | Global deploy seed and tenant lifecycle bootstrap appear as separate operator states.              |
| Validation and drift detection | Phase 2 shared history, Phase 5 validation APIs, re-validation flows                 | Operators can distinguish "applied", "validated", "stale", and "drifted" rather than one run flag. |
| Config-management alignment    | Phase 1 evidence contract, Phase 5 status payloads, config diff/snapshot integration | Release evidence ties change status to config validation and promotion proof.                      |
| Observability and alerting     | Phase 5 `observability.ts`, health routes, TraceStore and metric emission            | Blockers, validation age, heartbeat age, and stalled backfills show up in health, traces, metrics. |
| Rollback and compensation      | manifest metadata, adapter policies, manual control routes                           | Operators know whether a change is retryable, compensating, or forward-only before taking action.  |
| Manual operator actions        | Phase 5 runtime/admin control APIs, audit logging, auth and rate limits              | Operators use supported APIs to validate, pause, resume, or re-run allowed actions without SSH.    |

---

## 2. File-Level Change Map

### New Files

| File                                                                      | Purpose                                                                   | LOC Estimate |
| ------------------------------------------------------------------------- | ------------------------------------------------------------------------- | ------------ |
| `packages/database/src/change-management/types.ts`                        | Shared manifest, ledger, lock, validation, and requirement types          | 200          |
| `packages/database/src/change-management/manifest.ts`                     | Manifest registry, dependency validation, env filtering, planning helpers | 250          |
| `packages/database/src/change-management/history.ts`                      | Normalized `_change_history` and validation/backfill record access        | 200          |
| `packages/database/src/change-management/lease.ts`                        | Shared lock acquisition, heartbeat renewal, fence enforcement             | 220          |
| `packages/database/src/change-management/runner.ts`                       | Manifest-aware planner and execution coordinator                          | 300          |
| `packages/database/src/change-management/observability.ts`                | Shared health, tracing, and metric emission helper                        | 150          |
| `packages/database/src/change-management/version-gate.ts`                 | Service compatibility resolver                                            | 120          |
| `packages/database/src/change-management/adapters/mongo.ts`               | Adapter over current Mongo migration runner                               | 180          |
| `packages/database/src/change-management/adapters/seed.ts`                | Adapter over tracked seed/reference-data flows                            | 180          |
| `packages/database/src/change-management/adapters/clickhouse.ts`          | Adapter for ClickHouse migration functions and SQL files                  | 220          |
| `packages/database/src/change-management/adapters/script.ts`              | Adapter for registered TypeScript operational scripts                     | 180          |
| `packages/database/src/change-management/release-job.ts`                  | CLI/job entrypoint for pre/post-deploy phases                             | 150          |
| `packages/database/src/change-management/backfill-worker.ts`              | Resumable worker for long-running backfills                               | 250          |
| `apps/runtime/src/change-management/requirements.ts`                      | Runtime required change declarations                                      | 60           |
| `apps/search-ai/src/change-management/requirements.ts`                    | SearchAI required change declarations                                     | 60           |
| `apps/admin/src/change-management/requirements.ts`                        | Admin required change declarations                                        | 60           |
| `apps/runtime/src/routes/platform-admin-change-management.ts`             | Runtime platform-admin status/control endpoints                           | 260          |
| `apps/admin/src/app/api/change-management/[...path]/route.ts`             | Admin proxy to runtime change-management APIs                             | 120          |
| `apps/admin/src/app/(dashboard)/changes/page.tsx`                         | Admin dashboard page for change status                                    | 220          |
| `apps/studio/src/__tests__/workspace-bootstrap-change-management.test.ts` | Integration coverage for tenant lifecycle bootstrap classification        | 180          |
| `packages/database/src/__tests__/change-management/*`                     | Unit and integration tests for the new control plane                      | 600+         |

### Modified Files

| File                                                                           | Change Description                                                           | Risk |
| ------------------------------------------------------------------------------ | ---------------------------------------------------------------------------- | ---- |
| `packages/database/src/migrations/types.ts`                                    | Add compatibility fields or adapter mapping for manifest metadata            | Med  |
| `packages/database/src/migrations/runner.ts`                                   | Integrate shared lease heartbeat, ledger writes, and adapter hooks           | High |
| `packages/database/src/migrations/lock.ts`                                     | Either wrap or migrate into the shared lease module                          | Med  |
| `packages/database/src/migrations/cli.ts`                                      | Add adapter registration or handoff into the shared runner                   | Med  |
| `packages/database/src/seed/runner.ts`                                         | Normalize ledger semantics and optional locking through shared abstractions  | High |
| `packages/database/seed-mongo.ts`                                              | Register platform/tenant/dev seed entries through the shared manifest        | High |
| `apps/runtime/src/server.ts`                                                   | Add change compatibility to `/health/ready`                                  | High |
| `apps/search-ai/src/server.ts`                                                 | Add change compatibility to `/health/ready`                                  | Med  |
| `apps/admin/src/app/api/health/route.ts`                                       | Preserve local pod-health semantics and avoid direct DB-gating drift         | Low  |
| `apps/admin/src/app/api/system-health/route.ts`                                | Surface Runtime compatibility blockers through existing Admin proxy          | Med  |
| `apps/runtime/src/routes/platform-admin-health.ts`                             | Surface change blocker summary in system health                              | Med  |
| `apps/runtime/src/db/channel-connection-index-repair.ts`                       | Retire startup mutation path or register it under shared change management   | High |
| `packages/database/src/clickhouse-schemas/migrations/add-custom-dimensions.ts` | Register under manifest-compatible adapter contract                          | Low  |
| `apps/runtime/src/scripts/migrate-env-to-instances.ts`                         | Register or explicitly deprecate app-local credential/service migration      | Med  |
| `apps/search-ai/src/scripts/migrate-source-document-counts.ts`                 | Register or explicitly deprecate SearchAI reconciliation migration           | Med  |
| `apps/search-ai/src/scripts/backfill-entity-instances.ts`                      | Register as tracked backfill or explicitly retire                            | High |
| `apps/search-ai/scripts/add-job-execution-ttl-index.ts`                        | Register SearchAI TTL-index migration under manifest inventory               | Med  |
| `apps/studio/src/repos/workspace-repo.ts`                                      | Emit tenant lifecycle change records for workspace bootstrap                 | Med  |
| `apps/studio/src/app/api/auth/dev-login/route.ts`                              | Emit tenant lifecycle change records for dev-login bootstrap                 | Med  |
| `apps/studio/src/app/api/auth/create-workspace/route.ts`                       | Preserve workspace creation flow while wiring lifecycle bootstrap visibility | Med  |
| `apps/runtime/src/routes/platform-admin-tenants.ts`                            | Emit tenant lifecycle change records for admin-created tenants               | Med  |
| `scripts/migrate-pipeline-triggers.ts`                                         | Register under manifest-compatible script adapter                            | Med  |
| `scripts/migrate-chunkStrategy-to-tokenChunkStrategy.ts`                       | Register under manifest-compatible script adapter                            | Med  |
| `scripts/migrate-abl.ts`                                                       | Register under manifest-compatible script adapter                            | Med  |
| `scripts/rbac-tool-permissions.ts`                                             | Register RBAC permission migration under manifest-compatible script adapter  | Med  |
| `scripts/seed-secrets.ts`                                                      | Add execution metadata reporting into the shared status surface              | Med  |
| `scripts/validate-secrets-completeness.ts`                                     | Register secret completeness validation in the shared status surface         | Med  |
| `packages/config/src/validation/config-diff.ts`                                | Provide config promotion and diff evidence to release planning               | Med  |

### Deleted Files (if any)

| File            | Reason                                                                                             |
| --------------- | -------------------------------------------------------------------------------------------------- |
| None in phase 1 | Existing mechanisms are adapted first; deletion happens only after manifest convergence is proven. |

---

## 3. Implementation Phases

CRITICAL: Each phase must be independently deployable and testable. No phase should leave the system in a broken state.

Task 0.1 through task 6.7 are intentionally scoped to be reviewable implementation slices; for the larger convergence phases, each landed slice must stay within the documented file/package guardrails.

### Phase 0: Preflight and Plan Hardening

**Goal**: Freeze the implementation contract before `/implement` starts so code phases do not inherit doc drift or unresolved rollout semantics.

**Tasks**:
0.1. Run `tools/design-lint.sh` against the HLD and LLD, and resolve any blocking structural gaps before implementation begins.
0.2. Freeze exact HTTP endpoints, proxy paths, and auth contexts for the readiness, admin-status, validation, and backfill control surfaces in the feature spec and test spec.
0.3. Add FR-to-phase traceability so every FR is coverable by at least one phase, one task cluster, and one planned verification surface.
0.4. Normalize feature-index totals and HLD/LLD open questions so pipeline metadata is internally consistent.
0.5. Promote the HLD from `REVIEW` to `APPROVED` only after the preflight checks above pass.

**Files Touched**:

- `docs/features/README.md`
- `docs/features/change-management.md`
- `docs/specs/change-management.hld.md`
- `docs/plans/2026-04-15-change-management-impl-plan.md`
- `docs/testing/change-management.md`

**Exit Criteria**:

- [ ] `tools/design-lint.sh docs/specs/change-management.hld.md` passes.
- [ ] `tools/design-lint.sh docs/plans/2026-04-15-change-management-impl-plan.md` passes.
- [ ] HLD status is `APPROVED`.
- [ ] Feature spec, HLD, LLD, and test spec agree on endpoint names, auth context, and rollout-owner semantics.
- [ ] README totals are internally consistent.

**Test Strategy**:

- Manual: doc consistency review across feature spec, HLD, LLD, and test spec.
- Validation: run design lint on the HLD and LLD artifacts.

**Rollback**: Revert the documentation-only preflight edits; no runtime behavior changes are introduced.

---

### Phase 1: Registry Foundation

**Goal**: Introduce the shared manifest, ledger types, and repository inventory without changing rollout behavior yet.

**Tasks**:
1.1. Add `packages/database/src/change-management/types.ts` with manifest, history, and requirement types.
1.2. Add `packages/database/src/change-management/manifest.ts` with dependency validation and environment filtering.
1.3. Register current repo change surfaces in a first-pass manifest, including Mongo migration entries, tracked seed/reference-data entries, ClickHouse helpers, standalone scripts, app-local migration/backfill scripts, and tenant lifecycle bootstrap callers.
1.4. Add lint coverage for duplicate IDs, missing dependencies, illegal phase/kind combinations, and unregistered known change surfaces.
1.5. Add an explicit allowlist/deprecation registry for known non-release-coupled mutation utilities so the manifest inventory can distinguish exclusions from omissions.
1.6. Document the current split between deploy-time platform-core seeding, tenant lifecycle bootstrap, and secret/vault flows.
1.7. Document transitional mappings from `_migration_history` and `_seed_history` to the shared status contract.
1.8. Define the release-evidence contract for config snapshot/diff refs, lower-environment validation refs, and observability dimensions without taking ownership of config storage itself.

**Files Touched**:

- `packages/database/src/change-management/types.ts`
- `packages/database/src/change-management/manifest.ts`
- `packages/database/src/migrations/cli.ts`
- `packages/database/seed-mongo.ts`
- `apps/search-ai/migrations/clickhouse/006_json_path_index.sql` (inventory only, no logic change)
- `apps/runtime/src/scripts/migrate-env-to-instances.ts`
- `apps/search-ai/src/scripts/migrate-source-document-counts.ts`
- `apps/search-ai/src/scripts/backfill-entity-instances.ts`
- `apps/search-ai/scripts/add-job-execution-ttl-index.ts`
- `apps/studio/src/repos/workspace-repo.ts`
- `apps/studio/src/app/api/auth/dev-login/route.ts`
- `apps/studio/src/app/api/auth/create-workspace/route.ts`
- `apps/runtime/src/routes/platform-admin-tenants.ts`
- `scripts/migrate-pipeline-triggers.ts`
- `scripts/migrate-chunkStrategy-to-tokenChunkStrategy.ts`
- `scripts/migrate-abl.ts`
- `scripts/rbac-tool-permissions.ts`
- `scripts/seed-secrets.ts`
- `scripts/validate-secrets-completeness.ts`

**Exit Criteria**:

- [ ] A manifest exists and can enumerate every currently known release-coupled change surface in this repo.
- [ ] Duplicate or cyclic dependencies fail in automated tests.
- [ ] CI can detect the currently known orphaned script, SQL, and app-local migration paths if they are removed from the manifest.
- [ ] Known non-release-coupled mutation utilities are explicitly allowlisted or deprecated rather than silently ignored.
- [ ] The documented manifest distinguishes deploy-time platform-core seeds from tenant lifecycle bootstrap and separate secret flows.
- [ ] The shared types and manifest contract define how config-validation/promotion evidence is referenced from release records without storing raw config values.
- [ ] `pnpm build --filter=@agent-platform/database` succeeds.

**Test Strategy**:

- Unit: manifest type validation, dependency graph validation, inventory lint behavior.
- Integration: registry loads current Mongo, seed, ClickHouse, and known app-local/script entries without executing them.

**Rollback**: Remove the new `change-management` module and lint hook; existing runners continue unchanged.

---

### Phase 2: Shared Lease and Ledger Hardening

**Goal**: Introduce a shared lock/ledger abstraction with heartbeat and fence support, then adopt it in controlled slices without removing any existing exports or legacy entrypoints.

**Delivery Guardrails**:

- Split this work into `Phase 2A` and `Phase 2B`; each lands as its own implementation slice with no more than 40 files and no more than 3 packages.
- Additive only in this phase: no existing exports are removed, no existing CLI entrypoints are deleted, and legacy ledgers remain readable until a later cleanup phase.

#### Phase 2A: Lease and Ledger Primitives (Behavior-Preserving Refactor)

**Goal**: Add the new shared lease/history primitives without changing which runtime paths are authoritative yet.

**Tasks**:
2.1. Add `lease.ts` and `history.ts` for `_change_lock` and `_change_history`.
2.2. Wrap current `_migration_lock` semantics into the shared lease abstraction without changing current CLI or runner entrypoints.
2.3. Add heartbeat renewal, fence monotonicity, and stale-write rejection helpers as reusable primitives.
2.4. Add shadow-read/shadow-write helpers so later phases can opt into the shared ledger safely.

**Files Touched**:

- `packages/database/src/change-management/lease.ts`
- `packages/database/src/change-management/history.ts`
- `packages/database/src/migrations/lock.ts`
- `packages/database/src/migrations/types.ts`

**Exit Criteria**:

- [ ] Lease heartbeat renews during a simulated long-running execution in unit tests.
- [ ] Fence values are monotonic across reacquisition.
- [ ] Stale-fence writes are rejected in automated tests.
- [ ] No existing migration or seed command changes observable behavior yet.

**Test Strategy**:

- Unit: lease acquisition, heartbeat renewal, fence monotonicity, stale write rejection.
- Integration: shadow ledger/history helpers can serialize normalized records without taking ownership from legacy paths.

**Rollback**: Remove the new `lease.ts` and `history.ts` modules; existing runner behavior remains unchanged.

#### Phase 2B: Mongo and Seed Adoption (Behavior-Changing Integration)

**Goal**: Opt Mongo and tracked seed execution into the shared lease/ledger behavior behind adapter wiring while preserving all current exports.

**Tasks**:
2.5. Wire Mongo migration execution to heartbeat the shared lease and emit normalized history records.
2.6. Add equivalent locking support for tracked seed/reference-data flows.
2.7. Normalize status output from current Mongo and seed runners into the shared history shape.
2.8. Keep `_migration_history` and `_seed_history` readable during the transition so status consumers can compare results.

**Files Touched**:

- `packages/database/src/migrations/runner.ts`
- `packages/database/src/seed/runner.ts`
- `packages/database/seed-mongo.ts`
- `packages/database/src/migrations/cli.ts`

**Exit Criteria**:

- [ ] Lease heartbeat renews during a simulated long-running migration or seed task.
- [ ] Mongo and tracked seed execution both produce normalized shared-history records.
- [ ] Existing migration and seed unit tests still pass after adapter wiring.
- [ ] No public export, CLI alias, or legacy status surface is removed in this phase.

**Test Strategy**:

- Unit: Mongo/seed adapter write paths use fence-checked history writes.
- Integration: run one Mongo migration and one seed entry through the shared ledger wrappers.

**Rollback**: Turn off shared lease/ledger usage behind an adapter toggle while keeping the new modules on disk.

---

### Phase 3: Service Compatibility Gates

**Goal**: Prevent incompatible Runtime and SearchAI pods from becoming ready when required changes are missing, and define the Admin proxy contract for surfacing the same blockers.

**Tasks**:
3.1. Add `version-gate.ts` in `packages/database/src/change-management/`.
3.2. Create `requirements.ts` modules for Runtime, SearchAI, and Admin.
3.3. Update `apps/runtime/src/server.ts` readiness logic to include change compatibility.
3.4. Update `apps/search-ai/src/server.ts` readiness logic to include change compatibility.
3.5. Update `apps/admin/src/app/api/system-health/route.ts` and adjacent proxy wiring to include Admin-visible compatibility state without turning `/api/health` into a direct ledger gate.
3.6. Expose compatibility blockers through `apps/runtime/src/routes/platform-admin-health.ts`.

**Files Touched**:

- `packages/database/src/change-management/version-gate.ts`
- `apps/runtime/src/change-management/requirements.ts`
- `apps/search-ai/src/change-management/requirements.ts`
- `apps/admin/src/change-management/requirements.ts`
- `apps/runtime/src/server.ts`
- `apps/search-ai/src/server.ts`
- `apps/admin/src/app/api/health/route.ts`
- `apps/admin/src/app/api/system-health/route.ts`
- `apps/runtime/src/routes/platform-admin-health.ts`

**Exit Criteria**:

- [ ] Runtime readiness returns non-ready when a required change ID is missing.
- [ ] SearchAI readiness returns non-ready when a required change ID is missing.
- [ ] Admin system-health and proxy routes expose compatibility state, while `/api/health` remains a local pod-health probe.
- [ ] Compatibility enforcement mode supports at least `soft_ready` and `hard_fail`.

**Test Strategy**:

- Unit: requirement resolution and required/optional behavior.
- Integration: readiness endpoint tests for Runtime and SearchAI, plus Admin proxy/system-health coverage.
- E2E: staging-like rollout drill with missing required change IDs.

**Rollback**: Disable change compatibility enforcement mode and fall back to current infra-only readiness behavior.

---

### Phase 4: Runner Convergence and Startup Mutation Removal

**Goal**: Move fragmented and startup-time shared-state mutation into the manifest-driven control plane, while classifying deploy-time platform-core seeding separately from tenant lifecycle bootstrap and preserving existing exports throughout the transition.

**Delivery Guardrails**:

- Split this work into `Phase 4A` and `Phase 4B`; each lands as its own implementation slice with no more than 40 files and no more than 3 packages.
- Additive only in this phase: no existing exports are removed, no script entrypoint is deleted, and any cutover happens by registration, wiring, or deprecation markers first.

#### Phase 4A: Registration and Classification Convergence (Behavior-Preserving Refactor)

**Goal**: Register fragmented change surfaces and classify them under the manifest without cutting execution over yet.

**Tasks**:
4.1. Add adapter modules for Mongo, seed/reference-data, ClickHouse helper functions, and script-style runners.
4.2. Register `apps/search-ai/migrations/clickhouse/006_json_path_index.sql`, `packages/database/src/clickhouse-schemas/migrations/add-custom-dimensions.ts`, and the standalone top-level migration scripts under manifest inventory.
4.3. Classify `seed-mongo.ts` default execution as deploy-time `seed_platform`, classify workspace/bootstrap callers as `seed_tenant` with `trigger=tenant_lifecycle`, and add metadata-only tracking for `scripts/seed-secrets.ts` and `scripts/validate-secrets-completeness.ts`.

**Expected Commit Slices**:

- Slice 4A-1: `packages/database` + `apps/search-ai` + `scripts` for adapter contracts and orphaned script inventory.
- Slice 4A-2: `packages/database` + `apps/studio` + `apps/runtime` for deploy-core versus tenant-lifecycle seed classification.

**Files Touched**:

- `packages/database/src/change-management/adapters/mongo.ts`
- `packages/database/src/change-management/adapters/seed.ts`
- `packages/database/src/change-management/adapters/clickhouse.ts`
- `packages/database/src/change-management/adapters/script.ts`
- `packages/database/src/change-management/runner.ts`
- `packages/database/src/clickhouse-schemas/migrations/add-custom-dimensions.ts`
- `apps/runtime/src/scripts/migrate-env-to-instances.ts`
- `apps/search-ai/src/scripts/migrate-source-document-counts.ts`
- `apps/search-ai/src/scripts/backfill-entity-instances.ts`
- `apps/search-ai/scripts/add-job-execution-ttl-index.ts`
- `apps/studio/src/repos/workspace-repo.ts`
- `apps/studio/src/app/api/auth/dev-login/route.ts`
- `apps/studio/src/app/api/auth/create-workspace/route.ts`
- `apps/runtime/src/routes/platform-admin-tenants.ts`
- `scripts/migrate-pipeline-triggers.ts`
- `scripts/migrate-chunkStrategy-to-tokenChunkStrategy.ts`
- `scripts/migrate-abl.ts`
- `scripts/rbac-tool-permissions.ts`
- `scripts/seed-secrets.ts`
- `scripts/validate-secrets-completeness.ts`

**Exit Criteria**:

- [ ] Known orphaned repo change paths are now registered or explicitly deprecated.
- [ ] Shared status output can distinguish deploy-time platform-core, tenant lifecycle bootstrap, secrets validation, Mongo, ClickHouse, and script-backed entries.
- [ ] No legacy entrypoint or export is removed.

**Test Strategy**:

- Unit: adapter metadata and manifest classification tests.
- Integration: unified status surface across deploy-time platform-core, tenant lifecycle bootstrap, and at least three engine/kind combinations.

**Rollback**: Leave the manifest inventory in advisory/read-only mode and continue invoking legacy paths directly.

#### Phase 4B: Execution Cutover and Startup Mutation Removal (Behavior-Changing Integration)

**Goal**: Move actual execution ownership to the manifest-driven control plane and retire pod-startup shared-state mutation from the normal boot path.

**Tasks**:
4.4. Cut registered ClickHouse/script/seed entries over to manifest-driven execution where safe, while preserving legacy entrypoints as compatibility shims.
4.5. Register or explicitly deprecate `scripts/rbac-tool-permissions.ts`, `apps/runtime/src/scripts/migrate-env-to-instances.ts`, `apps/search-ai/src/scripts/migrate-source-document-counts.ts`, `apps/search-ai/src/scripts/backfill-entity-instances.ts`, and `apps/search-ai/scripts/add-job-execution-ttl-index.ts`.
4.6. Reclassify `apps/runtime/src/db/channel-connection-index-repair.ts` either as a proper change entry or move it out of startup entirely.

**Expected Commit Slices**:

- Slice 4B-1: `packages/database` + `apps/runtime` for startup mutation removal and runtime-owned cutover points.
- Slice 4B-2: `packages/database` + `apps/search-ai` + `scripts` for SearchAI/script execution cutover and deprecation markers.

**Files Touched**:

- `packages/database/src/change-management/runner.ts`
- `apps/runtime/src/db/channel-connection-index-repair.ts`
- `apps/runtime/src/scripts/migrate-env-to-instances.ts`
- `apps/search-ai/src/scripts/migrate-source-document-counts.ts`
- `apps/search-ai/src/scripts/backfill-entity-instances.ts`
- `apps/search-ai/scripts/add-job-execution-ttl-index.ts`
- `scripts/rbac-tool-permissions.ts`

**Exit Criteria**:

- [ ] No production pod-startup mutation path remains outside the change-management contract.
- [ ] Manifest-driven execution owns the migrated paths while legacy entrypoints remain as compatibility shims or explicit deprecations.
- [ ] `pnpm build` for affected packages succeeds.
- [ ] No public export or script alias is removed in this phase.

**Test Strategy**:

- Unit: execution cutover keeps manifest metadata and compatibility shims aligned.
- Integration: migrated paths execute through the shared runner and still surface consistent status.
- Manual: confirm startup repair code path is no longer needed in normal boot flow.

**Rollback**: Switch migrated paths back to their legacy direct invocation while keeping manifest registration in place.

---

### Phase 5: Backfill Orchestration and Operator APIs

**Goal**: Add resumable backfills, tenant canaries, and admin visibility/control.

**Tasks**:
5.1. Add `_change_backfill_progress` support and checkpoint helpers.
5.2. Implement `backfill-worker.ts` for resumable batch processing.
5.3. Add runtime platform-admin routes for status, validation, run, and backfill pause/resume.
5.4. Add admin proxy route and dashboard page for change-management status.
5.5. Add validation-age, checksum-drift, backfill-stall, and tenant-bootstrap completeness indicators to operator payloads.
5.6. Add `observability.ts` helpers that emit TraceStore events plus named OpenTelemetry metrics and health-summary dimensions for blocker count, validation age, heartbeat age, pending entries, and stalled backfills.

**Files Touched**:

- `packages/database/src/change-management/backfill-worker.ts`
- `packages/database/src/change-management/history.ts`
- `packages/database/src/change-management/observability.ts`
- `apps/runtime/src/routes/platform-admin-change-management.ts`
- `apps/admin/src/app/api/change-management/[...path]/route.ts`
- `apps/admin/src/app/(dashboard)/changes/page.tsx`
- `apps/runtime/src/routes/platform-admin-health.ts`

**Exit Criteria**:

- [ ] A backfill can pause and resume from checkpoint without duplicate processing.
- [ ] Tenant-scoped execution records per-tenant progress correctly.
- [ ] Admin UI and proxy routes show blockers, failures, validation age, progress, and the difference between global platform-core readiness and tenant bootstrap completeness.
- [ ] Manual operator actions are auditable and role-gated.
- [ ] Health/system-health payloads and OTel/TraceStore emission expose named signals for blocker count, validation age, heartbeat age, pending entries, and stalled backfills.

**Test Strategy**:

- Unit: checkpoint serialization and progress calculations.
- Integration: runtime admin route coverage and admin proxy route coverage.
- E2E: tenant canary backfill drill with pause/resume, plus tenant bootstrap status drill.

**Rollback**: Disable manual operator actions and backfill worker scheduling while preserving read-only status visibility.

---

### Phase 6: CI, Planning, and Release Hook Integration

**Goal**: Enforce safe change-management behavior before deploy and wire it into release automation.

**Tasks**:
6.1. Add `db:changes:lint` and `db:changes:plan` commands, including target-environment config-evidence checks.
6.2. Enforce checksum drift policy for applied blocking entries.
6.3. Define the single deploy-owned change-management application or hook in the deploy repo and prohibit duplicate shared-state hooks on other applications.
6.4. Integrate pre-deploy and post-deploy jobs with release metadata (`CHANGE_RELEASE_ID`, environment, build info, owner application, artifact ref).
6.5. Require lower-environment validation evidence plus configuration-management diff or snapshot evidence before promoting the same change set to production.
6.6. Add rollout runbooks and failure handling guidance for operators.
6.7. Document init containers as unsupported for shared-state mutation except optional read-only local self-checks.

**Files Touched**:

- `packages/database/package.json`
- `package.json`
- `packages/database/src/change-management/release-job.ts`
- `packages/database/src/change-management/manifest.ts`
- `packages/database/src/change-management/history.ts`
- `packages/config/src/validation/config-diff.ts`
- `.harness/` or equivalent CI configuration files
- `abl-platform-deploy` change-management application / hook manifests (external repo)
- `docs/features/change-management.md`
- `docs/testing/change-management.md`

**Exit Criteria**:

- [ ] CI fails on invalid manifest, dependency cycles, or checksum drift policy violations.
- [ ] Exactly one deploy-owned artifact carries shared-state `PreSync` and `PostSync` hooks per environment.
- [ ] Pre-deploy release job can execute required changes using the same artifact version as the app rollout.
- [ ] Promotion policy can prove lower-environment validation plus required configuration-management evidence for the same change set.
- [ ] Operator runbook exists for failed pre-deploy, stalled backfill, and readiness-blocked rollout.

**Test Strategy**:

- Unit: lint and plan rules.
- Integration: release-job dry-run and status persistence.
- Manual: staging release drill covering pre-deploy, readiness gate, and post-deploy behavior.

**Rollback**: Disable CI enforcement and release-hook integration while keeping the manifest and shared status surfaces available for advisory use.

---

## 4. Wiring Checklist

- [ ] Shared change-management types exported from `packages/database`
- [ ] Manifest loading wired into runtime/admin status code paths
- [ ] Shared lease module used by Mongo and seed/reference-data adapters
- [ ] Trigger metadata distinguishes deploy, manual, and tenant lifecycle execution
- [ ] Runtime readiness wired to compatibility resolver
- [ ] SearchAI readiness wired to compatibility resolver
- [ ] Admin health/proxy wired to Runtime compatibility summary without direct DB gating in phase 1
- [ ] Runtime platform-admin change-management route mounted in server/router wiring
- [ ] Admin proxy route added under `apps/admin/src/app/api/change-management/`
- [ ] Backfill worker registered in the correct worker startup path
- [ ] New CLI commands exported from root and package `package.json`

---

## 5. Cross-Phase Concerns

### Database Migrations

- Existing Mongo migration files stay intact initially and are wrapped through the manifest adapter.
- Mixed seed-like migrations, such as operational data seeding inside the migration registry, should be reclassified by `kind` during convergence.
- Default deploy-time seeding is classified separately from tenant lifecycle bootstrap so rollout readiness is not overstated.
- Startup repair flows should be evaluated as either real release-coupled changes or retired.

### Feature Flags

- `CHANGE_ENFORCEMENT_MODE`
- `CHANGE_CHECKSUM_ENFORCEMENT`
- Optional transition flag if the team wants to keep legacy ledgers authoritative while validating the shared ledger in shadow mode

### Configuration Changes

- Add change-management env vars to the relevant service config surfaces.
- Add service-local requirement declaration modules for Runtime, SearchAI, and Admin.
- Wire release metadata (`CHANGE_RELEASE_ID`, environment) into release jobs and status records.
- Wire rollout-owner metadata (`ownerApplication`, artifact ref, manifest digest) into shared history records.
- Wire configuration-management snapshot/diff and lower-environment evidence refs into release-job metadata and shared history without copying raw config values into the ledger.
- Document or inject trigger metadata for lifecycle callers such as workspace creation, dev login, and tenant admin flows.
- Continue using `packages/config/src/watcher.ts` and other config-management propagation primitives for dynamic runtime config; change-management must consume config evidence, not replace config propagation.

### Platform Validation

- The release contract is layered: config dry-run/diff validation, manifest lint/plan validation, rollout execution, readiness compatibility, and periodic re-validation.
- Promotion logic must treat missing config evidence and missing change evidence as equally blocking for environments that require strict rollout governance.
- Readiness gates remain service-local and code-declared; configuration-management may influence a release, but it must not become an opaque external dependency list that bypasses source control.

### Platform Observability

- Shared status payloads, TraceStore events, and OTel metrics must all carry `environment`, `releaseId`, `changeId`, and `service` dimensions so health, traces, and alerts can be correlated.
- Named metrics should cover at least blocker count, validation age, lease-heartbeat age, pending entry count, and stalled backfill count.
- Admin system-health and dashboards should show the same normalized blocker and freshness summary operators would page on.
- Wire release jobs, manual operator actions, and backfill lifecycle transitions into the shared `TraceStore` event pipeline.

---

## 6. Acceptance Criteria (Whole Feature)

- [ ] All release-coupled change surfaces in this repo are either registered in the manifest or explicitly deprecated.
- [ ] Runtime and SearchAI declare required change IDs and gate readiness on them; Admin surfaces the same blockers through proxy/system-health flows.
- [ ] Shared lease heartbeat and stale-fence protection are active for clustered execution.
- [ ] Operators can see unified status, validation, and backfill progress without SSH-ing into pods.
- [ ] Backfill changes can checkpoint, pause, resume, and target individual tenants.
- [ ] CI rejects invalid or unsafe change packages before deploy.
- [ ] Exactly one deploy-owned change-management artifact is configured per environment.
- [ ] Deployment-core readiness is distinguishable from tenant lifecycle bootstrap and secret completeness.
- [ ] Release records correlate shared-state execution with configuration-management evidence without storing raw config values in the ledger.
- [ ] Health, TraceStore, and OTel/alerting surfaces expose blocker, heartbeat-age, validation-age, and stalled-backfill state for every environment.
- [ ] A staged release can execute pre-deploy changes, pass readiness gates, and surface post-deploy status coherently.

### FR Traceability

| FR    | Primary Implementation Coverage             | Primary Verification Coverage       |
| ----- | ------------------------------------------- | ----------------------------------- |
| FR-1  | Phase 0.3, Phase 1.1-1.3, Phase 4A.1-4.2    | INT-1, E2E-6, E2E-7, UT-1 to UT-4   |
| FR-2  | Phase 1.1-1.4                               | INT-1, E2E-7, UT-1 to UT-8          |
| FR-3  | Phase 1.1-1.4, Phase 6.1                    | INT-1, E2E-1, E2E-7, UT-1 to UT-3   |
| FR-4  | Phase 1.1-1.4, Phase 4A.3                   | INT-1, E2E-8, UT-4, UT-38 to UT-41  |
| FR-5  | Phase 2A.1-2.4, Phase 2B.5-2.8              | INT-2, INT-4, E2E-3, UT-9 to UT-16  |
| FR-6  | Phase 2A.1-2.4, Phase 2B.5-2.6              | INT-2, E2E-3, E2E-4, UT-9 to UT-16  |
| FR-7  | Phase 1.3, Phase 4A.1-4.2, Phase 4B.4-4.5   | INT-4, E2E-6, UT-17 to UT-28        |
| FR-8  | Phase 3.1-3.4                               | INT-3, E2E-1, E2E-2, UT-29 to UT-34 |
| FR-9  | Phase 3.2-3.6, Phase 5.3-5.4                | INT-6, E2E-6, UT-35 to UT-37        |
| FR-10 | Phase 0.2-0.5, Phase 3.1-3.6, Phase 6.3-6.7 | E2E-1, E2E-2, E2E-7, UT-47 to UT-52 |
| FR-11 | Phase 4B.4-4.5, Phase 5.1-5.5               | INT-5, E2E-5, UT-42 to UT-46        |
| FR-12 | Phase 1.6-1.7, Phase 4A.3, Phase 5.5        | INT-4, E2E-6, E2E-8, UT-21 to UT-24 |
| FR-13 | Phase 1.4, Phase 5.3-5.5, Phase 6.1-6.2     | E2E-6, E2E-7, INT-7, UT-47 to UT-52 |
| FR-14 | Phase 3.5-3.6, Phase 5.3-5.5                | E2E-6, INT-6, UT-35 to UT-37        |
| FR-15 | Phase 1.4-1.5, Phase 6.1-6.5                | E2E-7, INT-1, UT-47 to UT-52        |
| FR-16 | Phase 5.3-5.5, Phase 6.6                    | INT-7, E2E-6, UT-50 to UT-52        |
| FR-17 | Phase 4A.3, Phase 5.5                       | INT-7, E2E-6, UT-24, UT-50          |
| FR-18 | Phase 1.3-1.5, Phase 4A.2-4.3               | INT-1, E2E-7, UT-5 to UT-8          |
| FR-19 | Phase 1.6, Phase 4A.3, Phase 5.5            | INT-8, INT-9, E2E-8, UT-38 to UT-41 |
| FR-20 | Phase 1.8, Phase 6.1-6.5                    | INT-1, E2E-7, UT-49 to UT-51        |
| FR-21 | Phase 5.3-5.6, Phase 6.6                    | INT-6, E2E-6, UT-52                 |

---

## 7. Open Questions

1. Should `_change_history` be the long-term single ledger, or should engine-specific ledgers remain canonical with a federated query layer?
2. Should the rollout owner live as a dedicated Argo application long-term, or eventually move into a separate platform control-plane service?
3. Should the first backfill implementation remain strictly sequential, or allow limited tenant-partition parallelism once fencing is proven?
4. Which destructive operations, if any, are allowed in automated release jobs versus manual approval only?
5. Which configuration-management evidence refs are required for production promotion: diff IDs, snapshot IDs, lower-environment promotion records, or a stricter composite proof?

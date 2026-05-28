# Test Spec: Change Management

**Feature:** [Change Management](../features/change-management.md)
**Status:** PLANNED
**Created:** 2026-04-15
**Last Updated:** 2026-04-15

---

## Current State

The repo currently has partial automated coverage for the MongoDB migration runner and tracked seed runner, but it does not yet have a unified test surface for cross-engine change registration, readiness compatibility gates, lease fencing, deploy-hook orchestration, configuration-evidence alignment, or named observability signals. This test spec is a planning placeholder that maps the new parent architecture into concrete unit, integration, and E2E coverage.

---

## Coverage Matrix

| Capability / Requirement Area                                               | Unit   | Integration | E2E / Release Drill | Status      |
| --------------------------------------------------------------------------- | ------ | ----------- | ------------------- | ----------- |
| Manifest schema, taxonomy, and dependency graph                             | 8      | 2           | --                  | PLANNED     |
| Shared lease lock, heartbeat, and stale-fence rejection                     | 8      | 3           | 1                   | PLANNED     |
| Mongo migration adapter under shared manifest                               | 4      | 3           | 1                   | PLANNED     |
| Seed/reference-data adapter under shared manifest                           | 4      | 3           | 1                   | PLANNED     |
| ClickHouse/script runner adapters                                           | 4      | 3           | 1                   | PLANNED     |
| Runtime compatibility gate                                                  | 3      | 2           | 1                   | PLANNED     |
| SearchAI compatibility gate                                                 | 3      | 2           | 1                   | PLANNED     |
| Admin health, change-management proxy surfaces, and observability summaries | 3      | 3           | 1                   | PLANNED     |
| Deploy-time platform-core vs tenant lifecycle bootstrap                     | 4      | 3           | 1                   | PLANNED     |
| Resumable backfill checkpoints and tenant canary targeting                  | 5      | 4           | 2                   | PLANNED     |
| CI lint / dry-run / plan enforcement + config evidence                      | 6      | 2           | 1                   | PLANNED     |
| **Totals**                                                                  | **52** | **30**      | **10**              | **PLANNED** |

---

## E2E Test Scenarios

All E2E scenarios should use real services, real persistence, and public HTTP or CLI surfaces. No codebase mocking for the feature under test.

### E2E-1: Pre-Deploy Change Job Blocks Incompatible Rollout

**Description:** Verify a release job runs all `pre_deploy` required changes before a new build is allowed to serve traffic.

**Endpoints / Commands:**

- `pnpm db:changes:run --phase=pre_deploy`
- `GET http://127.0.0.1:<runtime-port>/health/ready`
- `GET http://127.0.0.1:<runtime-port>/api/platform/admin/change-management/status`

**Auth Context:** The release job runs under cluster/deploy identity. `GET /health/ready` is an unauthenticated readiness probe. Runtime admin status uses platform-admin auth consistent with `requirePlatformAdmin()` and the platform-admin IP allow-list.

**Isolation / Scope Check:** Status responses must be filtered to the target environment and release, with no unrelated tenant-specific data leaking into the rollout summary.

**Steps:**

1. Start MongoDB, Redis, and any required worker infrastructure.
2. Register a manifest containing at least one deploy-blocking schema change.
3. Launch the release job entrypoint for `pre_deploy`.
4. Start a Runtime server version that requires that change ID.
5. Verify readiness succeeds only after the change history shows the entry as applied and validated.

**Expected:** The release job applies the required change first, and the new pod becomes ready only after compatibility is satisfied.

### E2E-2: Missing Required Change Keeps Pod Out of Readiness

**Description:** Verify Runtime or SearchAI refuses readiness when a required change is absent.

**Endpoints / Commands:**

- `GET http://127.0.0.1:<runtime-port>/health/ready`
- `GET http://127.0.0.1:<search-ai-port>/health/ready`

**Auth Context:** Both readiness endpoints are unauthenticated probe surfaces.

**Isolation / Scope Check:** Missing-change blocker payloads must not expose tenant, project, or user-scoped resource existence beyond the required change IDs and service-local blocker metadata.

**Steps:**

1. Start the service against a database where the required change ID is not present in `_change_history`.
2. Call `/health/ready`.
3. Verify the response is non-ready and includes a machine-readable blocker reason.
4. Apply the missing change entry through the shared runner or seeded test fixture.
5. Call `/health/ready` again.

**Expected:** The pod remains alive but not ready until the required change exists with a compatible status.

### E2E-3: Lease Heartbeat Prevents Second Runner From Taking Over

**Description:** Verify a long-running backfill or change job renews its lease and prevents concurrent takeover.

**Endpoints / Commands:**

- `POST http://127.0.0.1:<runtime-port>/api/platform/admin/change-management/run`
- `GET http://127.0.0.1:<runtime-port>/api/platform/admin/change-management/backfills`

**Auth Context:** Platform-admin auth plus the platform-admin IP allow-list on Runtime routes.

**Isolation / Scope Check:** A second runner or second admin request must observe lock contention for the same environment/change scope and must not produce duplicate history writes.

**Steps:**

1. Start a change job that intentionally sleeps between batches.
2. Observe the active lease heartbeat updating `_change_lock`.
3. Start a second runner against the same manifest and phase.
4. Verify the second runner does not apply the same entry or write history.

**Expected:** Only the current lease holder can continue execution; the second runner exits or reports lock contention.

### E2E-4: Stale Runner Cannot Persist Results After Fence Loss

**Description:** Verify stale history writes are rejected after lock ownership changes.

**Endpoints / Commands:**

- `POST http://127.0.0.1:<runtime-port>/api/platform/admin/change-management/run`
- `GET http://127.0.0.1:<runtime-port>/api/platform/admin/change-management/status`

**Auth Context:** Platform-admin auth plus the platform-admin IP allow-list on Runtime routes.

**Isolation / Scope Check:** Only the active fence owner may mutate or report success for the targeted change/environment combination.

**Steps:**

1. Start runner A and capture its fence.
2. Simulate fence loss by expiring or transferring the lease to runner B.
3. Let runner A attempt to write completion metadata after it has lost ownership.
4. Verify runner A's stale write is rejected and runner B is the only accepted writer.

**Expected:** No zombie runner can corrupt the shared change ledger after lease loss.

### E2E-5: Resumable Tenant-Scoped Backfill Canary

**Description:** Verify a `backfill` change can target one tenant, pause, resume, and later expand fleet-wide.

**Endpoints / Commands:**

- `POST http://127.0.0.1:<runtime-port>/api/platform/admin/change-management/run`
- `POST http://127.0.0.1:<runtime-port>/api/platform/admin/change-management/backfills/pause`
- `POST http://127.0.0.1:<runtime-port>/api/platform/admin/change-management/backfills/resume`
- `GET http://127.0.0.1:<runtime-port>/api/platform/admin/change-management/backfills?changeId=<id>&tenantId=<tenantId>`

**Auth Context:** Platform-admin auth plus the platform-admin IP allow-list on Runtime routes.

**Isolation / Scope Check:** Status for tenant A must not claim progress for tenant B; cross-tenant lookups outside the requested tenant scope must return empty results or 404-style absence semantics.

**Steps:**

1. Seed data for at least two tenants.
2. Start a tenant-scoped backfill for tenant A only.
3. Pause the backfill mid-run and verify `_change_backfill_progress` stores checkpoint state.
4. Resume the backfill and verify it completes without reprocessing completed batches.
5. Confirm tenant B remains untouched until explicitly targeted later.

**Expected:** Canary rollout is tenant-isolated, resumable, and checkpoint-backed.

### E2E-6: Unified Operator Status Across Engines

**Description:** Verify the runtime admin API and admin proxy show Mongo, seed/reference-data, ClickHouse, and script-backed changes in one response, along with the same blocker and freshness summaries operators use for observability.

**Endpoints / Commands:**

- `GET http://127.0.0.1:<runtime-port>/api/platform/admin/change-management/status`
- `GET http://127.0.0.1:<admin-port>/api/change-management/status`
- `GET http://127.0.0.1:<admin-port>/api/system-health`

**Auth Context:** Runtime status uses platform-admin auth plus IP allow-list. Admin proxy surfaces use an authenticated Admin session with at least viewer access; the admin proxy then forwards privileged runtime headers.

**Isolation / Scope Check:** Admin proxy responses must preserve the same environment and scope filtering as Runtime and must not expose more than the underlying authorized runtime response.

**Steps:**

1. Seed `_change_history` with representative entries for multiple engines and kinds.
2. Call the runtime admin change-status endpoint.
3. Call the admin proxy endpoint.
4. Verify the response groups entries by status, phase, trigger, kind, and engine.
5. Verify the runtime and admin responses preserve the same validation-age, checksum-drift, and blocker summary fields that feed health and alerting views.

**Expected:** Operators see one coherent status surface rather than multiple disconnected ledgers, and the status payload exposes the same blocker/freshness dimensions used in system-health and alerting.

### E2E-7: CI Plan and Lint Reject Unsafe Release

**Description:** Verify lint and planning commands reject unsafe or incomplete change packages before deploy, including releases missing required configuration-management evidence.

**Endpoints / Commands:**

- `pnpm db:changes:lint`
- `pnpm db:changes:plan --env staging`

**Auth Context:** CI runner or release-engineering identity; no end-user auth surface is involved in this scenario.

**Isolation / Scope Check:** Planning output must stay environment-scoped and must not expose production-only secret metadata when executed against staging inputs.

**Steps:**

1. Introduce a manifest with a dependency cycle or missing required validation metadata.
2. Run the lint command.
3. Run the plan command for a target environment where required config snapshot, diff, or lower-environment evidence is missing.
4. Verify the commands fail with actionable diagnostics for both shared-state and config-evidence gaps.
5. Fix the manifest, provide the required config evidence, and rerun lint and plan.

**Expected:** CI catches manifest, policy, and configuration-evidence violations before the release job runs.

### E2E-8: Deploy-Time Seed Does Not Imply Tenant Bootstrap Completeness

**Description:** Verify the default deploy-time seed path marks global platform-core readiness only, while tenant bootstrap remains incomplete until a tenant lifecycle or targeted seed flow runs.

**Endpoints / Commands:**

- `tsx packages/database/seed-mongo.ts`
- `GET http://127.0.0.1:<runtime-port>/api/platform/admin/change-management/status?scope=global`
- `GET http://127.0.0.1:<runtime-port>/api/platform/admin/change-management/status?scope=tenant&tenantId=<tenantId>`
- `POST http://127.0.0.1:<runtime-port>/api/platform/admin/tenants`

**Auth Context:** Default seed execution runs under deploy identity. Runtime status and tenant-creation routes use platform-admin auth plus the platform-admin IP allow-list.

**Isolation / Scope Check:** Global deploy-core readiness must not imply tenant readiness for unrelated tenants; tenant bootstrap visibility must remain scoped to the targeted tenant.

**Steps:**

1. Run the default deploy-time seed entrypoint with no `--tenant` and no `--dev`.
2. Verify status shows only the global platform-core and RBAC-alignment entries as satisfied.
3. Create or select a tenant that has not yet had tenant operational defaults applied.
4. Verify the unified status surface reports tenant bootstrap as missing or pending for that tenant.
5. Trigger tenant bootstrap through a real lifecycle path such as workspace creation, dev login attachment, or an explicitly targeted tenant seed command.
6. Verify the tenant-scoped status becomes satisfied without rerunning the global deploy seed.

**Expected:** Global deployment readiness and tenant readiness are represented separately, and operators can see that deploy success does not imply every tenant is fully bootstrapped.

---

## Integration Test Scenarios

### INT-1: Manifest Dependency Graph and Release-Evidence Validation

**Steps:**

1. Load manifest entries with valid and invalid dependency graphs plus release-plan inputs with valid and invalid config-evidence refs.
2. Verify acyclic graphs with valid evidence pass.
3. Verify cycles, missing IDs, invalid phase/trigger/kind combinations, and missing required config/promotion evidence fail with clear messages.

**Expected:** The manifest and planning layers enforce both dependency integrity and required release evidence before execution.

### INT-2: Lease Lock Heartbeat and Fence Monotonicity

**Steps:**

1. Acquire a shared change-management lock.
2. Extend the lease multiple times.
3. Release and reacquire the lock from a second holder.
4. Verify the fence value strictly increases and stale fence writes are rejected.

**Expected:** Fence-based stale-writer protection works across lease transitions.

### INT-3: Runtime Version-Gate Resolver

**Steps:**

1. Provide a list of required and optional change IDs.
2. Seed `_change_history` with partial status combinations.
3. Run the compatibility resolver used by Runtime or SearchAI.
4. Verify `ready`, `not_ready`, and `warn_only` outcomes are computed correctly.

**Expected:** The gate logic is deterministic and environment-aware.

### INT-4: Seed and Migration Adapters Share the Ledger Contract

**Steps:**

1. Execute a Mongo migration entry through the shared runner.
2. Execute a tracked reference-data or seed-platform entry through the shared runner.
3. Verify both results are normalized into the same history shape.

**Expected:** Different engines and kinds share the same status and validation contract.

### INT-5: Backfill Checkpoint Resume

**Steps:**

1. Start a backfill adapter that processes data in batches.
2. Stop after a partial batch set and persist checkpoint state.
3. Resume the job from checkpoint.
4. Verify completed items are not reprocessed and remaining work completes.

**Expected:** Resume starts from the last committed checkpoint.

### INT-6: Health Surfaces Include Change Blockers

**Steps:**

1. Simulate missing required change IDs for Runtime and SearchAI, plus the corresponding blocker state surfaced through Admin proxy health routes.
2. Call their health or readiness surfaces.
3. Verify the payload includes compatibility blocker detail, validation freshness, and release/environment identifiers in a stable shape.

**Expected:** Infra health, change compatibility, and alert-friendly freshness summaries are all visible to operators without requiring Admin to become a direct DB readiness gate.

### INT-7: Secret Operations Write Metadata But Not Values

**Steps:**

1. Execute a secret-management change entry in dry-run or test mode.
2. Verify `_change_history` records execution metadata.
3. Verify the secret value itself is not present in history, validation, or logs.

**Expected:** Operational traceability exists without leaking secret material.

### INT-8: Default Seed Task Set Is Classified as Deploy-Core Only

**Steps:**

1. Build the seed task set with no `--tenant`, no `--workspace-email`, and no `--dev`.
2. Verify the task list contains platform-core and RBAC alignment entries only.
3. Verify tenant defaults are absent from that default task set.
4. Verify targeted tenant arguments add tenant-scoped bootstrap tasks instead of mutating the default deploy-core set.

**Expected:** The control plane can classify the default deployment seed path as global platform-core only.

### INT-9: Tenant Lifecycle Bootstrap Emits Tenant-Scoped Change Status

**Steps:**

1. Trigger tenant bootstrap through workspace creation, dev login, or platform-admin tenant creation.
2. Verify the resulting change records are tenant-scoped and distinguishable from global deploy-time seed entries.
3. Verify status queries can filter or group by scope/trigger so tenant bootstrap completeness is visible independently.

**Expected:** Tenant lifecycle seed operations are tracked separately from deploy-time platform-core readiness.

---

## Unit Test Scenarios

This plan now enumerates 52 unit scenarios. An earlier 48-scenario review count became stale once deploy-core versus tenant-lifecycle bootstrap classification was split into its own capability area.

### Manifest Schema, Taxonomy, and Dependency Graph

| ID   | Module                                                | Scenario                                                                |
| ---- | ----------------------------------------------------- | ----------------------------------------------------------------------- |
| UT-1 | `packages/database/src/change-management/types.ts`    | Reject manifest entries missing required metadata keys.                 |
| UT-2 | `packages/database/src/change-management/manifest.ts` | Reject duplicate change IDs.                                            |
| UT-3 | `packages/database/src/change-management/manifest.ts` | Reject unsupported `phase` values.                                      |
| UT-4 | `packages/database/src/change-management/manifest.ts` | Reject unsupported `kind` or `trigger` values.                          |
| UT-5 | `packages/database/src/change-management/manifest.ts` | Reject dependency references to unknown change IDs.                     |
| UT-6 | `packages/database/src/change-management/manifest.ts` | Reject cyclic dependency graphs.                                        |
| UT-7 | `packages/database/src/change-management/manifest.ts` | Enforce legal `phase`/`kind`/`trigger` combinations.                    |
| UT-8 | `packages/database/src/change-management/manifest.ts` | Flag known orphaned script or SQL paths when omitted from the manifest. |

### Shared Lease Lock, Heartbeat, and Stale-Fence Rejection

| ID    | Module                                               | Scenario                                                      |
| ----- | ---------------------------------------------------- | ------------------------------------------------------------- |
| UT-9  | `packages/database/src/change-management/lease.ts`   | Acquire a free lease successfully.                            |
| UT-10 | `packages/database/src/change-management/lease.ts`   | Reject acquisition when another holder owns the active lease. |
| UT-11 | `packages/database/src/change-management/lease.ts`   | Extend an active lease without changing the fence.            |
| UT-12 | `packages/database/src/change-management/lease.ts`   | Reacquire after expiry with a strictly higher fence.          |
| UT-13 | `packages/database/src/change-management/lease.ts`   | Reject heartbeat attempts from a stale holder.                |
| UT-14 | `packages/database/src/change-management/history.ts` | Reject history writes with a stale fence value.               |
| UT-15 | `packages/database/src/change-management/history.ts` | Persist normalized history with owner/build metadata.         |
| UT-16 | `packages/database/src/change-management/history.ts` | Preserve last error and run count across retries.             |

### Mongo Migration Adapter Under Shared Manifest

| ID    | Module                                                      | Scenario                                                              |
| ----- | ----------------------------------------------------------- | --------------------------------------------------------------------- |
| UT-17 | `packages/database/src/change-management/adapters/mongo.ts` | Map a registered Mongo migration into a manifest entry correctly.     |
| UT-18 | `packages/database/src/change-management/adapters/mongo.ts` | Propagate validation results into the shared history contract.        |
| UT-19 | `packages/database/src/change-management/adapters/mongo.ts` | Preserve checksum information for applied migrations.                 |
| UT-20 | `packages/database/src/change-management/adapters/mongo.ts` | Surface `down()` or compensation metadata without executing rollback. |

### Seed / Reference-Data Adapter Under Shared Manifest

| ID    | Module                                                     | Scenario                                                              |
| ----- | ---------------------------------------------------------- | --------------------------------------------------------------------- |
| UT-21 | `packages/database/src/change-management/adapters/seed.ts` | Map tracked seed tasks into manifest entries with the correct `kind`. |
| UT-22 | `packages/database/src/change-management/adapters/seed.ts` | Preserve idempotent seed validation status in the shared ledger.      |
| UT-23 | `packages/database/src/change-management/adapters/seed.ts` | Distinguish deploy-core seed tasks from targeted tenant seed tasks.   |
| UT-24 | `packages/database/src/change-management/adapters/seed.ts` | Track secret-related seed metadata without persisting secret values.  |

### ClickHouse and Script Runner Adapters

| ID    | Module                                                           | Scenario                                                                |
| ----- | ---------------------------------------------------------------- | ----------------------------------------------------------------------- |
| UT-25 | `packages/database/src/change-management/adapters/clickhouse.ts` | Register raw SQL and function-backed ClickHouse entries uniformly.      |
| UT-26 | `packages/database/src/change-management/adapters/clickhouse.ts` | Preserve engine-specific validation or `not_configured` semantics.      |
| UT-27 | `packages/database/src/change-management/adapters/script.ts`     | Register top-level script changes with manifest metadata.               |
| UT-28 | `packages/database/src/change-management/adapters/script.ts`     | Require explicit deprecation markers for non-registered legacy scripts. |

### Runtime Compatibility Gate

| ID    | Module                                                    | Scenario                                                            |
| ----- | --------------------------------------------------------- | ------------------------------------------------------------------- |
| UT-29 | `packages/database/src/change-management/version-gate.ts` | Mark Runtime `not_ready` when any required change is missing.       |
| UT-30 | `packages/database/src/change-management/version-gate.ts` | Ignore optional changes when required changes are satisfied.        |
| UT-31 | `apps/runtime/src/change-management/requirements.ts`      | Resolve service-local Runtime requirements by environment and mode. |

### SearchAI Compatibility Gate

| ID    | Module                                                    | Scenario                                                                 |
| ----- | --------------------------------------------------------- | ------------------------------------------------------------------------ |
| UT-32 | `packages/database/src/change-management/version-gate.ts` | Mark SearchAI `not_ready` when a required change is missing.             |
| UT-33 | `packages/database/src/change-management/version-gate.ts` | Support `warn_only` outcomes for optional or non-blocking SearchAI deps. |
| UT-34 | `apps/search-ai/src/change-management/requirements.ts`    | Resolve SearchAI requirements by environment and deployment mode.        |

### Admin Health and Proxy Surfaces

| ID    | Module                                                        | Scenario                                                                  |
| ----- | ------------------------------------------------------------- | ------------------------------------------------------------------------- |
| UT-35 | `apps/admin/src/change-management/requirements.ts`            | Keep Admin in `proxy_only` mode for phase 1.                              |
| UT-36 | `apps/admin/src/app/api/change-management/[...path]/route.ts` | Proxy runtime change-management responses without reshaping blocker data. |
| UT-37 | `apps/admin/src/app/api/system-health/route.ts`               | Surface runtime compatibility blockers while `/api/health` stays local.   |

### Deploy-Time Platform-Core Versus Tenant Lifecycle Bootstrap

| ID    | Module                                              | Scenario                                                                   |
| ----- | --------------------------------------------------- | -------------------------------------------------------------------------- |
| UT-38 | `packages/database/seed-mongo.ts`                   | Default task set contains only platform-core and RBAC alignment entries.   |
| UT-39 | `packages/database/seed-mongo.ts`                   | Adding `--tenant` or `--workspace-email` injects tenant-scoped tasks only. |
| UT-40 | `apps/studio/src/repos/workspace-repo.ts`           | Workspace bootstrap emits tenant-scoped change metadata.                   |
| UT-41 | `apps/runtime/src/routes/platform-admin-tenants.ts` | Platform-admin tenant creation emits tenant-lifecycle change metadata.     |

### Resumable Backfill Checkpoints and Tenant Canary Targeting

| ID    | Module                                                       | Scenario                                                                |
| ----- | ------------------------------------------------------------ | ----------------------------------------------------------------------- |
| UT-42 | `packages/database/src/change-management/backfill-worker.ts` | Persist a checkpoint after a completed batch.                           |
| UT-43 | `packages/database/src/change-management/backfill-worker.ts` | Resume from the last committed checkpoint without replaying prior work. |
| UT-44 | `packages/database/src/change-management/backfill-worker.ts` | Pause a running backfill cleanly.                                       |
| UT-45 | `packages/database/src/change-management/backfill-worker.ts` | Restrict tenant canary execution to the targeted tenant only.           |
| UT-46 | `packages/database/src/change-management/history.ts`         | Surface stalled backfill metadata for operator status.                  |

### CI Lint, Dry-Run, and Plan Enforcement

| ID    | Module                                                   | Scenario                                                                                                                              |
| ----- | -------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------- |
| UT-47 | `packages/database/src/change-management/manifest.ts`    | Fail plan/lint when applied blocking entries drift from their recorded checksum.                                                      |
| UT-48 | `packages/database/src/change-management/manifest.ts`    | Fail lint when deploy-blocking changes lack validation or explicit `not_configured`.                                                  |
| UT-49 | `packages/database/src/change-management/release-job.ts` | Filter changes by environment and phase correctly for a dry-run plan and require config evidence when the target release declares it. |
| UT-50 | `packages/database/src/change-management/release-job.ts` | Require explicit approval flags for destructive or forward-only entries.                                                              |
| UT-51 | `packages/database/src/change-management/release-job.ts` | Stamp owner application, release, and manifest digest metadata on execution.                                                          |
| UT-52 | `packages/database/src/change-management/release-job.ts` | Emit trace/audit metadata and observability dimensions for run, validate, and backfill-control actions.                               |

---

## Manual Validation / Release Drills

1. Run a full pre-deploy plus readiness-gated rollout in a staging cluster with the same image tag used for the app rollout.
2. Run a tenant-scoped backfill canary for a non-production enterprise-like tenant snapshot and inspect admin status.
3. Simulate rollout interruption mid-backfill, then resume and verify no duplicate writes.
4. Verify lower-environment change validation plus configuration-management evidence is available before promoting the same manifest to production.
5. Verify a deploy-time seed run leaves tenant bootstrap incomplete for a newly created tenant until a lifecycle bootstrap path executes.

---

## Notes

- This placeholder intentionally focuses on black-box and operationally realistic validation.
- As implementation phases land, this file should be upgraded from a planning artifact into a live test spec with concrete file paths, pass/fail state, and iteration history.

# Feature: Change Management

**Doc Type**: HUB
**Parent Feature**: N/A
**Status**: PLANNED
**Feature Area(s)**: `governance`, `enterprise`, `admin operations`, `observability`
**Package(s)**: `packages/database`, `apps/runtime`, `apps/search-ai`, `apps/admin`, `packages/eventstore`
**Owner(s)**: `Platform team`, `SRE`
**Testing Guide**: `../testing/change-management.md`
**Last Updated**: 2026-04-16

---

## 1. Introduction / Overview

### Problem Statement

The platform currently has several different ways to mutate production state during upgrades: versioned MongoDB migrations in `packages/database/src/migrations/`, tracked seed tasks in `packages/database/src/seed/`, standalone operational scripts under `scripts/`, app-local migration scripts under `apps/runtime/src/scripts/` and `apps/search-ai/src/scripts/`, ad-hoc ClickHouse migration helpers under `packages/database/src/clickhouse-schemas/migrations/`, raw SQL files under `apps/search-ai/migrations/`, and startup repair flows such as `apps/runtime/src/db/channel-connection-index-repair.ts`. Only the Mongo migration runner and seed runner write durable ledgers today, and neither one is connected to a release-aware control plane that tells services, operators, or CI which changes are mandatory before a rollout can safely serve traffic.

In a multi-environment, multi-release, clustered deployment, this creates an enterprise risk surface: pods can start against incompatible schema or reference-data state, long-running changes can outlive the current lock model, release-coupled data changes are mixed together with environment-specific seeding, independently rolled applications can each try to own the same shared-state mutation phase, and operators must reason across multiple fragmented mechanisms to answer a basic question: "what changed, what still needs to run, and what is blocking safe traffic?"

### Goal Statement

Establish a single change-management control plane for the platform that unifies release-coupled database migrations, resumable backfills, reference-data synchronization, environment-conditional seed flows, and service compatibility gates under one deployable architecture. The platform should treat database and operational changes as first-class release artifacts: planned, validated, tracked, observable, and enforced by deployment and readiness mechanisms instead of relying on operator memory or pod-startup side effects.

### Summary

Change Management is the parent architecture that sits above Database Migrations and Seed Data. It introduces a shared taxonomy for change entries (`phase`, `trigger`, `kind`, `engine`, `scope`, `blocking`, `reversibility`), a manifest-driven registry, durable change history, distributed locking with heartbeat and fencing, service-local required-version assertions, admin visibility, and CI validation. It also defines how release-coupled shared-state changes align with Configuration Management, platform validation gates, and Tracing & Observability so rollout evidence, config promotion evidence, readiness, and operator telemetry tell one coherent story. The guiding model is:

- Release jobs mutate shared state.
- Service pods verify compatibility.
- Operators get one audit trail and one operational surface.

---

## 2. Scope

### Goals

- Unify release-coupled change definitions across MongoDB migrations, ClickHouse migrations, tracked seed/reference-data sync, and currently ad-hoc operational scripts.
- Introduce explicit execution metadata for every change entry: `phase` (when it runs relative to deployment), `trigger` (what causes it to run), and `kind` (what it does).
- Make service compatibility explicit in code so Runtime and SearchAI can refuse readiness when required changes are missing, while Admin surfaces the same blockers through its proxy-based health and operator flows.
- Replace best-effort "one runner at a time" behavior with production-safe lease management, heartbeat, and stale-writer protection.
- Support operator-safe backfills with resumability, validation, tenant canaries, and visibility into progress and blockers.
- Give CI and release automation a machine-readable contract for planning, validating, and enforcing changes before a rollout reaches customers.
- Align release-coupled shared-state changes with configuration-management validation, diff, and promotion evidence so a rollout can prove both schema/data state and required config state are safe for the target environment.
- Define exactly one rollout-scoped owner per environment for `pre_deploy` and `post_deploy` shared-state execution so independently deployed applications do not race each other with duplicate hooks.

### Non-Goals (Out of Scope)

- Auto-generating migrations from Mongoose schemas, ClickHouse schemas, or application diffs.
- Replacing AWS Secrets Manager or storing secret values inside the database change ledger.
- Solving cross-repository deployment orchestration in `abl-platform-deploy` and `abl-platform-infra` in this document; those repos are integration points, not the primary implementation target here.
- Building a full Studio UI for change management; the operator surface is CLI plus admin APIs first.
- Turning every long-lived bridge or compatibility adapter into a formal migration on day one if it is better modeled as a temporary runtime feature flag or dual-write path.

---

## 3. User Stories

1. As an `SRE`, I want every deploy-blocking change to be executed by a dedicated release job so that app pods never race each other to mutate shared state during a rollout.
2. As a `service owner`, I want Runtime and SearchAI to declare the exact change IDs they require, and Admin to surface the same blocker state through its proxy flows, so incompatible rollouts never look healthy.
3. As a `platform operator`, I want to see applied, pending, failed, and never-validated changes in one place so that I can answer release readiness questions without SSH-ing into pods.
4. As a `DBA`, I want schema changes, data backfills, and reference-data sync to be classified differently so that I can reason about risk, rollback, and blast radius before execution.
5. As a `compliance owner`, I want checksums, validation results, actor metadata, and environment-scoped history so that release activity is auditable for enterprise customers.
6. As a `platform developer`, I want a single manifest and CI gate that catch orphaned scripts, missing validation, and edited applied migrations before they reach production.
7. As an `operator`, I want tenant-scoped backfill canaries so that I can validate a large change against one enterprise customer before running it fleet-wide.

---

## 4. Functional Requirements

1. **FR-1**: The system must define a single change manifest contract for every release-coupled change shipped from this repo, including MongoDB changes, ClickHouse changes, tracked reference-data sync, and currently ad-hoc TypeScript or SQL migration scripts.
2. **FR-2**: The system must require every change entry to declare machine-readable metadata including `id`, `phase`, `trigger`, `kind`, `engine`, `scope`, `envs`, `requires`, `blocking`, `destructive`, and `reversibility`.
3. **FR-3**: The system must support at least these `phase` values: `pre_deploy`, `post_deploy`, and `continuous`, with optional backfill execution that can span releases.
4. **FR-4**: The system must support at least these `kind` values: `schema`, `backfill`, `seed_platform`, `seed_tenant`, `seed_dev`, `secret`, and `bridge`.
5. **FR-5**: The system must provide a shared change ledger that records execution state, checksum, validation state, actor/build metadata, run count, and last error for each change entry.
6. **FR-6**: The system must provide a distributed lease lock with heartbeat renewal and stale-writer protection so that only the active holder can persist change results during clustered rollouts.
7. **FR-7**: The system must allow MongoDB, ClickHouse, and script-style change runners to share the same manifest contract while using engine-specific execution implementations.
8. **FR-8**: The system must support service-local compatibility gates where Runtime and SearchAI declare required change IDs in code and refuse readiness when those requirements are not satisfied.
9. **FR-9**: The system must define an Admin compatibility contract that surfaces shared-state blockers through proxy and health semantics appropriate to the Admin runtime shape, without assuming direct database ownership in phase 1.
10. **FR-10**: The system must execute deploy-blocking `pre_deploy` changes outside the application pod lifecycle through a dedicated release job or deployment hook owned by exactly one rollout-scoped deployment artifact per environment.
11. **FR-11**: The system must support `backfill` changes with resumable checkpoints, validation, and optional tenant-scoped execution for canary rollout.
12. **FR-12**: The system must distinguish continuous reference-data sync from one-time schema/backfill changes and track it in the same operational surface without forcing identical rollback semantics.
13. **FR-13**: The system must require validation hooks or explicit `not_configured` declarations for all deploy-blocking changes, and it must support re-running validation separately from execution.
14. **FR-14**: The system must provide operator-facing status and validation surfaces through CLI and admin APIs, including environment-aware summaries and failure details.
15. **FR-15**: The system must provide CI/lint enforcement for uniqueness, dependency graph validity, checksum drift, missing validation, and idempotency safeguards appropriate to the change kind.
16. **FR-16**: The system must require explicit approval flags for destructive or forward-only operations whose rollback cannot be guaranteed.
17. **FR-17**: The system must keep secret values out of the shared change ledger while still tracking the execution metadata of secret-management operations.
18. **FR-18**: The system must require the manifest inventory to explicitly classify currently known mutation surfaces as registered, deprecated, or non-release-coupled so the registry does not silently miss live operational scripts.
19. **FR-19**: The system must distinguish global deployment-core readiness from tenant lifecycle bootstrap completeness and separate secret/vault setup so a successful deploy seed is not misreported as whole-environment readiness.
20. **FR-20**: The system must integrate with Configuration Management so release planning and promotion can reference validated config snapshots, diffs, and lower-environment promotion evidence without duplicating raw config values in the shared change ledger.
21. **FR-21**: The system must emit standardized observability signals for change execution and compatibility state, including health summaries, TraceStore events, OpenTelemetry metrics, and alert-friendly dimensions keyed by environment, release, and change ID.

---

## 5. Feature Classification & Integration Matrix

### Lifecycle / Platform Impact

| Area                       | Impact Level | Notes                                                                                                |
| -------------------------- | ------------ | ---------------------------------------------------------------------------------------------------- |
| Project lifecycle          | SECONDARY    | Project-scoped backfills and reference-data sync may touch project-owned records.                    |
| Agent lifecycle            | SECONDARY    | Agent schema evolution and deployment compatibility depend on change sequencing.                     |
| Customer experience        | PRIMARY      | Bad rollout sequencing can create downtime, hidden schema errors, or tenant-isolation regressions.   |
| Integrations / channels    | SECONDARY    | Connector and channel changes often require coordinated schema/data rollout.                         |
| Observability / tracing    | PRIMARY      | Change health, validation age, and rollout blockers must be visible to operators.                    |
| Governance / controls      | PRIMARY      | Unified registry, validation, auditability, and deployment gates are governance controls.            |
| Enterprise / compliance    | PRIMARY      | Enterprise customers require auditable, reversible, phased, environment-aware release management.    |
| Admin / operator workflows | PRIMARY      | Operators need status, control, pause/resume, approval, and diagnostics for release-coupled changes. |

### Related Feature Integration Matrix

| Related Feature                                         | Relationship Type | Why It Matters                                                                                                                                    | Key Touchpoints                                                                                                                                     | Current State                                                                                        |
| ------------------------------------------------------- | ----------------- | ------------------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------- |
| [Database Migrations](database-migrations.md)           | extends           | Change Management is the parent operational architecture for schema and backfill changes.                                                         | `packages/database/src/migrations/runner.ts`, `lock.ts`, `cli.ts`, migration scripts                                                                | Mongo migration runner exists, but phase/kind gating is still planned                                |
| [Seed Data](seed-data.md)                               | extends           | Tracked seed/reference-data work becomes one change kind instead of a separate ad-hoc system.                                                     | `packages/database/src/seed/runner.ts`, `packages/database/seed-mongo.ts`, `_seed_history`                                                          | Seed history/status exist, but no unified release control plane or distributed lock                  |
| [Deployments & Versioning](deployments-versioning.md)   | depends on        | Deployment hooks and release metadata are required to execute changes safely before rollout.                                                      | release jobs, build metadata, rollout sequencing                                                                                                    | No direct integration today                                                                          |
| [Configuration Management](configuration-management.md) | depends on        | Change Management must consume validated config snapshot/diff and promotion evidence without becoming a second config system.                     | `packages/config/src/loader.ts`, `packages/config/src/watcher.ts`, `packages/config/src/validation/config-diff.ts`, environment promotion workflows | Config validation/promotion are planned separately; releases do not yet carry linked config evidence |
| [Health Checks / Readiness Probes](health-checks.md)    | depends on        | Service readiness must include compatibility with required change IDs.                                                                            | `apps/runtime/src/server.ts`, `apps/search-ai/src/server.ts`, `apps/admin/src/app/api/health`                                                       | Current readiness checks infrastructure only, not schema/data compatibility                          |
| [CI/CD Pipeline](cicd-pipeline.md)                      | depends on        | CI is the right place to lint, plan, and enforce change integrity before deploy.                                                                  | pipeline checks, release metadata, deployment gating                                                                                                | No unified change lint/plan gate today                                                               |
| [Audit Logging](audit-logging.md)                       | emits into        | Change execution and operator actions must be audit logged for compliance.                                                                        | platform-admin routes, release jobs, validation events                                                                                              | Migration and seed events are not consistently emitted to audit today                                |
| [Secrets Management](secrets-management.md)             | configured by     | Secret bootstrap and verification must be visible operationally without leaking values.                                                           | `scripts/seed-secrets.ts`, secret manifests, environment-specific release workflows                                                                 | Secret seeding is separate and outside the current tracked ledgers                                   |
| [Tracing & Observability](tracing-observability.md)     | shares data with  | Change-management metrics and health need to plug into existing observability surfaces.                                                           | `/health`, `/health/ready`, platform-admin system health, OTel metrics                                                                              | Health endpoints exist, but they do not currently report compatibility against required changes      |
| [Alerts](alerts.md)                                     | emits into        | Failed pre-deploy jobs, missing required changes, stale validation, and stalled backfills must page operators through existing alerting surfaces. | OTel metrics, system-health summaries, alert rules, on-call escalation                                                                              | No change-management-specific alert set exists today                                                 |

---

## 6. Design Considerations (Optional)

- **Control plane, not pod-startup mutation:** The preferred operating model is "release jobs mutate, service pods verify." Pod-startup mutation should be treated as technical debt and moved behind the shared change-management contract over time.
- **Preferred deploy mechanism:** Deploy-blocking shared-state changes should run through an ArgoCD `PreSync` hook or equivalent deployment hook that launches a dedicated Kubernetes Job. `PostSync` hooks or dedicated workers are preferred for non-blocking cleanup and resumable backfills. Init containers are not the preferred mechanism for migrations or global seed/reference-data changes because they execute per pod and turn clustered rollout into a race.
- **Exactly one rollout owner:** Each environment must have one deployment-owned change-management artifact, such as a dedicated Argo application or singleton release Job manifest, that owns shared-state `PreSync` and `PostSync` execution. Application-specific Argo apps must not each attach their own global change hooks.
- **Three-axis execution model:** `phase` answers "when does this run relative to deploy?", `trigger` answers "what causes it to run?", and `kind` answers "what does it do?" All three are required to make safe rollout decisions.
- **Service requirements live in code:** Each service should declare required change IDs or dependency expectations in source control rather than central config so release dependencies are versioned with the code that needs them.
- **Admin is proxy-first in phase 1:** Runtime and SearchAI enforce local readiness against the ledger. Admin does not become a second direct database gate in phase 1; its local `/api/health` remains a pod-health probe while proxy/system-health routes surface shared-state blockers from Runtime.
- **Soft readiness by default, hard fail as an option:** For enterprise operations, the default should be to keep pods alive but not ready when required changes are missing. Hard-fail startup can remain an explicit enforcement mode for stricter environments.
- **Configuration Management is a sibling control plane:** Configuration Management remains the source of truth for runtime config values, diffs, snapshots, and watcher-driven propagation. Change Management consumes references to validated config evidence for a release, but it must not duplicate raw config storage or become a second feature-flag/config system.
- **Platform validation is layered:** The enterprise safety model is config dry-run/diff validation before promotion, change manifest lint/plan before deploy, readiness gating during rollout, and post-apply re-validation/drift detection after rollout. No single surface is sufficient on its own.
- **Observability must be release-aware:** Health, status APIs, TraceStore traces, metrics, and alerts should all carry the same `releaseId`, environment, and change identifiers so operators can correlate "what was deployed?" with "what is blocked?" and "what is failing?" quickly.
- **Reference data is not the same as dev seed:** Platform reference data expected by the codebase belongs under tracked, idempotent `continuous` or `seed_platform` change entries. Dev fixtures remain explicitly environment-restricted.
- **Deployment seeding is not whole-environment readiness:** The default deployment seed path currently runs only global platform-core plus RBAC alignment. Tenant defaults, workspace-specific pipeline config, secrets, vault-managed provider keys, and example encrypted env vars remain targeted or lifecycle-triggered flows.
- **Not every operational action belongs in the exact same rollback model:** A shared manifest and status surface are desirable, but secrets, bridges, and destructive engine-specific changes may need specialized execution and compensation policies.

---

## 7. Technical Considerations (Optional)

- **Tracked MongoDB migrations already exist:** `packages/database/src/migrations/runner.ts`, `types.ts`, `lock.ts`, and `cli.ts` provide sequential execution, history, checksum/validation support, and rollback hooks for the currently registered MongoDB migration list.
- **Tracked seed execution now exists, but without clustered locking:** `packages/database/src/seed/runner.ts` and `packages/database/seed-mongo.ts` provide `_seed_history`, validation, and status views, but there is no equivalent to `_migration_lock`.
- **Current lock model is incomplete for long-running work:** `packages/database/src/migrations/lock.ts` already exposes `extendLock()`, but the runner does not call it during execution. This leaves long-running backfills vulnerable to lease expiry.
- **Configuration Management already owns config validation and propagation primitives:** `packages/config/src/loader.ts`, `packages/config/src/validation/config-diff.ts`, and `packages/config/src/watcher.ts` are the right places for config schema validation, diffing, and propagation behavior. Change Management should consume their evidence and references rather than invent parallel storage or validation semantics.
- **Current deployment seeding is intentionally narrow:** The default init path runs `packages/database/seed-mongo.ts` without `--tenant` or `--dev`, which means the deploy-time task set only covers platform-core plus RBAC alignment (`apps/runtime/Dockerfile`, `packages/database/seed-mongo.ts`).
- **Tenant defaults are lifecycle-triggered today:** Tenant operational defaults only run when `seed-mongo.ts` is targeted with `--tenant` or `--workspace-email`, or when workspaces are created or attached during Studio and platform-admin flows (`packages/database/seed-mongo.ts`, `apps/studio/src/repos/workspace-repo.ts`, `apps/studio/src/app/api/auth/dev-login/route.ts`, `apps/runtime/src/routes/platform-admin-tenants.ts`).
- **Secrets and provider credentials are separate from deployment seeding:** `scripts/seed-secrets.ts` and `scripts/validate-secrets-completeness.ts` are separate flows, provider API keys are intentionally skipped from Mongo seeding as vault-managed values, and example encrypted env vars require the DEK facade before they can be written (`packages/database/seed-mongo.ts`, `packages/database/seed-examples.ts`).
- **Service compatibility is not enforced today:** Runtime and SearchAI readiness endpoints currently check infrastructure health, not required schema/data change state (`apps/runtime/src/server.ts`, `apps/search-ai/src/server.ts`). Admin's current `apps/admin/src/app/api/health/route.ts` is a static pod-health response, while `apps/admin/src/app/api/system-health/route.ts` proxies Runtime.
- **Deployment integration should be hook-driven, not pod-driven:** The intended operational path is one release-owned Job per sync phase, not per-pod init-container execution for shared-state mutation.
- **The repo already contains fragmented change surfaces outside the ledgers:** examples include `apps/search-ai/migrations/clickhouse/006_json_path_index.sql`, `packages/database/src/clickhouse-schemas/migrations/add-custom-dimensions.ts`, `scripts/migrate-pipeline-triggers.ts`, `scripts/migrate-chunkStrategy-to-tokenChunkStrategy.ts`, `scripts/migrate-abl.ts`, `scripts/rbac-tool-permissions.ts`, `scripts/seed-secrets.ts`, `apps/runtime/src/scripts/migrate-env-to-instances.ts`, `apps/search-ai/src/scripts/migrate-source-document-counts.ts`, `apps/search-ai/src/scripts/backfill-entity-instances.ts`, and `apps/search-ai/scripts/add-job-execution-ttl-index.ts`.
- **Some operational repair work still happens inside app startup paths:** `apps/runtime/src/db/channel-connection-index-repair.ts` uses `_migration_lock` directly to mutate indexes at runtime startup. That pattern should be folded into the shared change-management architecture.
- **Deploy ownership is currently underspecified outside this repo:** `abl-platform` can define the control plane contract, but the deploy repo must choose and enforce the single rollout owner per environment to avoid multi-application hook races.
- **Platform validation is still fragmented across features:** Mongo/seed validation can already be re-run, Configuration Management plans dry-run and promotion validation, and Health Checks plans readiness/state reporting, but the platform still lacks one release-level verdict that ties shared-state, config evidence, and readiness together.
- **Observability infrastructure exists but change-management signals are not yet wired through it:** the tracing/observability and health-check features already define TraceStore, OTel metrics, dashboards, and alerts, but they do not yet carry named change-management blocker, heartbeat-age, or validation-age signals.

---

## 8. How to Consume

### Studio UI

No direct Studio UI is required for the first implementation. Studio may eventually surface read-only change health or rollout blockers through existing admin or diagnostics surfaces, but that is not a phase-1 dependency.

### API (Runtime)

A rollout-owned release job is authoritative for shared-state execution. Runtime hosts the first platform-admin status and control APIs in this repo until a dedicated platform control-plane service exists.

| Method | Path                                                | Purpose                                                                 |
| ------ | --------------------------------------------------- | ----------------------------------------------------------------------- |
| GET    | `/health/ready`                                     | Include change-compatibility readiness checks for required entries.     |
| GET    | `/api/platform/admin/change-management/status`      | Return manifest-aware status for all relevant change entries.           |
| GET    | `/api/platform/admin/change-management/backfills`   | Return active and recent backfill progress.                             |
| GET    | `/api/platform/admin/change-management/validation`  | Return recent validation results and stale validation markers.          |
| POST   | `/api/platform/admin/change-management/run`         | Trigger manual execution for allowed change phases or kinds.            |
| POST   | `/api/platform/admin/change-management/validate`    | Re-run validation for targeted change entries without re-applying them. |
| POST   | `/api/platform/admin/change-management/backfills/*` | Pause, resume, or retry resumable backfills.                            |

### API (Studio)

No Studio-originated API is required for the first iteration beyond existing admin proxy patterns.

### Admin Portal

Admin should expose a dedicated change-management view backed by proxy routes, similar to the existing health and resilience surfaces. In phase 1, Admin's local `/api/health` remains a pod probe; shared-state compatibility is surfaced through proxied Runtime endpoints and system-health views:

- Manifest-aware status table
- Blocked/missing required changes by service
- Global deployment-core seed status vs tenant bootstrap completeness
- Validation freshness and checksum drift
- Active backfill progress with pause/resume
- Environment-scoped release and build metadata
- Linked configuration snapshot/diff and lower-environment promotion evidence for the same release

The expected Admin proxy surface mirrors the Runtime control-plane endpoints under the Admin app namespace:

| Method | Path                                      | Purpose                                                |
| ------ | ----------------------------------------- | ------------------------------------------------------ |
| GET    | `/api/change-management/status`           | Proxy manifest-aware status for operator views.        |
| GET    | `/api/change-management/backfills`        | Proxy active and recent backfill progress.             |
| GET    | `/api/change-management/validation`       | Proxy validation freshness and stale-validation state. |
| POST   | `/api/change-management/run`              | Proxy allowed manual execution actions.                |
| POST   | `/api/change-management/validate`         | Proxy manual validation actions.                       |
| POST   | `/api/change-management/backfills/pause`  | Proxy pause control for resumable backfills.           |
| POST   | `/api/change-management/backfills/resume` | Proxy resume control for resumable backfills.          |

### Experience by Change Kind

This section answers the practical question, "if I am shipping this kind of change, what actually happens?"

| Kind            | When teams use it                                                               | Default execution experience                                                                   | Blocking behavior                                                                  | Validation experience                                                               | Operator experience                                                                                |
| --------------- | ------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------- |
| `schema`        | Additive or contract-managed database shape changes required by code.           | Declared in the manifest and executed once by the rollout-owned `pre_deploy` release job.      | Usually `deploy_required`; may also be `startup_required` for service readiness.   | `validate()` proves the required collection, index, validator, or schema is live.   | Operators see pending/applied/failed state, checksum drift, validation age, and release ownership. |
| `backfill`      | Existing data must be rewritten, populated, or normalized over time.            | Planned as `post_deploy` or manual work and run by a resumable worker with checkpoints.        | Usually non-blocking for the current deploy, but later releases can depend on it.  | Validation proves completion and the target invariant, not just that a job started. | Operators see progress, tenant canaries, pause/resume, retries, and stalled-job alerts.            |
| `seed_platform` | Code-required global reference data such as RBAC, resource types, templates     | Runs as deploy-time platform-core seed or continuous diff-based sync owned by the release job. | Can block deploy or readiness if the new code expects the data to exist.           | Validation compares the source-of-truth definition with persisted state.            | Operators see whether global platform-core data is aligned, drifting, or missing.                  |
| `seed_tenant`   | Tenant defaults and workspace bootstrap behavior.                               | Runs on `tenant_lifecycle` events such as workspace creation, dev login, or admin bootstrap.   | Does not block whole-environment rollout by default.                               | Validation is tenant-targeted and proves the selected tenant is bootstrapped.       | Operators see tenant completeness separately from global deploy readiness.                         |
| `seed_dev`      | Dev-only fixtures, examples, or demo data.                                      | Runs only in allowed lower environments or explicit dev workflows.                             | Never blocks prod rollout or prod readiness.                                       | Validation is optional and lower-environment scoped.                                | Operators see it as dev-only state, not enterprise release evidence.                               |
| `secret`        | Secret bootstrap or completeness checks against an external secret system.      | Runs through tracked secret-management actions, but values remain outside the ledger.          | Blocks only when the target environment explicitly requires the secret evidence.   | Validation proves presence or completeness without surfacing secret values.         | Operators see missing refs or failed completeness checks, never the secret contents.               |
| `bridge`        | Temporary compatibility windows such as dual-write or old/new contract overlap. | Runs as a tracked release concern alongside code rollout and later retirement.                 | Usually `warn_only` during overlap, then becomes blocking before contract removal. | Validation proves the bridge is active, healthy, or safely retired.                 | Operators see whether old and new code paths are still allowed and what is blocking removal.       |

### Experience by Concern

This section answers the practical question, "what does this design do for each operational concern?"

| Concern                             | Engineer experience                                                                      | Platform behavior                                                                                       | Operator experience                                                                                    |
| ----------------------------------- | ---------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------ |
| Deployment ownership                | Engineers classify the change and declare `phase`, `trigger`, `kind`, and `requires`.    | Exactly one rollout-owned artifact runs shared-state changes for the environment.                       | Operators can point to one release job as the owner of what ran, when, and with which artifact.        |
| Service compatibility and readiness | Service teams declare required change IDs in code next to the code that depends on them. | Runtime and SearchAI read compatibility state and stay non-ready until mandatory entries are satisfied. | Operators see the same blockers in readiness and admin/system-health instead of inferring from logs.   |
| Tenant bootstrap completeness       | Teams classify tenant bootstrap as `seed_tenant` rather than mixing it into deploy seed. | Global deploy seed and tenant-lifecycle bootstrap are recorded separately.                              | Operators can say "platform core is ready, tenant X is not" instead of treating them as one status.    |
| Validation and drift detection      | Authors provide `validate()` or explicitly mark why validation is not configured.        | The platform can validate immediately after apply and re-run validation later to detect drift.          | Operators see freshness, drift, and re-validation history instead of trusting that a past run stuck.   |
| Configuration-management alignment  | Engineers reference config evidence; they do not duplicate config inside change entries. | Release records link to config snapshot, diff, and lower-environment promotion evidence.                | Operators inspect one release story that includes both shared-state change status and config evidence. |
| Observability and alerting          | Change authors use shared helpers rather than ad-hoc logging conventions.                | TraceStore events, metrics, health summaries, and alert dimensions are emitted consistently.            | Operators get blocker count, validation age, heartbeat age, and stalled-backfill signals by release.   |
| Rollback and compensation           | Engineers must declare reversibility and compensation expectations up front.             | Destructive or forward-only work requires explicit approval and compensation-aware execution.           | Operators know whether a change can be retried, rolled back, or only compensated forward.              |
| Manual operator control             | Engineers expose only supported manual actions for their change type.                    | The control plane limits manual runs to allowed phases and kinds with auth and audit logging.           | Operators can re-run validation, pause backfills, or trigger approved actions without SSH access.      |

### Concrete Journeys

1. **Deploy-time schema change**
   An engineer adds a new manifest entry for an additive MongoDB index needed by Runtime, marks it `phase=pre_deploy`, and adds the change ID to Runtime requirements. The rollout-owned `PreSync` job applies it once, writes `_change_history`, and Runtime pods stay non-ready until that ID is present and valid.
2. **Slow backfill that spans releases**
   An engineer ships new code that can tolerate both old and new data, then registers a `backfill` entry with resumable checkpoints. The deploy succeeds, operators watch progress and canary a tenant, and a later release declares a dependency on backfill completion before contract cleanup is allowed.
3. **Platform-core reference-data sync**
   A team changes RBAC or resource-type definitions that the platform expects globally. The release job runs the tracked `seed_platform` sync, validation confirms the persisted state matches the source of truth, and operators see global platform-core status without confusing it with tenant bootstrap.
4. **Tenant bootstrap on workspace creation**
   A new workspace is created in Studio or through platform-admin. That lifecycle path records a `seed_tenant` execution for the target tenant, and operators can see tenant completeness without re-running global deploy seed or claiming the entire environment is incomplete.
5. **Secrets completeness before promotion**
   A prod promotion requires a secrets completeness check. The secret-management task records only metadata in the ledger, the release carries config and secret evidence refs together, and operators can block promotion on missing secret readiness without exposing secret values.

### Channel / SDK / Voice / A2A / MCP Integration

Change Management is not channel-aware. It is a platform control-plane concern that protects all runtime surfaces indirectly by sequencing shared-state mutations safely.

### CLI

The long-term CLI surface should converge on a single namespace, even if the existing Mongo and seed commands continue to work during migration:

| Command                                   | Purpose                                                                                                                            |
| ----------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------- |
| `pnpm db:changes:status`                  | Show unified change status across manifest entries.                                                                                |
| `pnpm db:changes:plan --env <env>`        | Show which changes will execute for a target environment/release and whether required configuration/promotion evidence is present. |
| `pnpm db:changes:run --phase=pre_deploy`  | Execute deploy-blocking changes in a release job.                                                                                  |
| `pnpm db:changes:run --phase=post_deploy` | Execute cleanup, validation, or non-blocking post-deploy changes.                                                                  |
| `pnpm db:changes:validate`                | Re-run validation for applied entries.                                                                                             |
| `pnpm db:changes:backfill:start <id>`     | Start a resumable backfill.                                                                                                        |
| `pnpm db:changes:backfill:status <id>`    | Show progress and checkpoints for a backfill.                                                                                      |
| `pnpm db:changes:backfill:pause <id>`     | Pause a backfill.                                                                                                                  |
| `pnpm db:changes:backfill:resume <id>`    | Resume a paused backfill.                                                                                                          |
| `pnpm db:changes:lint`                    | Validate manifest integrity, dependencies, idempotency, and checksum policy.                                                       |

---

## 9. Data Model

### Collections / Tables

The shared control plane should introduce a manifest contract in code plus a single operational ledger surface in storage.

```typescript
interface ChangeManifestEntry {
  id: string;
  description: string;
  phase: 'pre_deploy' | 'post_deploy' | 'continuous';
  trigger: 'deploy' | 'manual' | 'tenant_lifecycle';
  kind: 'schema' | 'backfill' | 'seed_platform' | 'seed_tenant' | 'seed_dev' | 'secret' | 'bridge';
  engine: 'mongodb' | 'clickhouse' | 'script' | 'secret';
  scope: 'global' | 'tenant';
  envs: Array<'dev' | 'staging' | 'prod'>;
  requires: string[];
  blocking: 'deploy_required' | 'startup_required' | 'warn_only';
  destructive: boolean;
  reversibility: 'rollback' | 'compensating' | 'forward_only';
}
```

```text
Collection: _change_history (MongoDB — new shared ledger)
Fields:
  - _id: string (change id)
  - description: string
  - phase: string
  - kind: string
  - engine: string
  - scope: string
  - environment: string
  - status: string ("applied" | "failed" | "verified" | "skipped" | "paused")
  - checksum: string
  - validationStatus: string
  - validationSummary: string
  - validationDetails: object
  - appliedAt: Date
  - lastValidatedAt: Date
  - durationMs: number
  - runCount: number
  - fence: number
  - appliedBy: string
  - releaseId: string
  - buildInfo: object
  - configSnapshotRef: string | null
  - configDiffRef: string | null
  - lowerEnvEvidenceRef: string | null
  - traceId: string | null
  - lastError: string | null
Indexes:
  - { status: 1, phase: 1, environment: 1 }
  - { kind: 1, engine: 1, environment: 1 }
  - { lastValidatedAt: 1 }
```

```text
Collection: _change_lock (MongoDB — shared lease lock)
Fields:
  - _id: string ("global" or engine-scoped lock id)
  - lockedBy: string
  - lockedAt: Date
  - expiresAt: Date
  - fence: number
Indexes:
  - { expiresAt: 1 }
```

```text
Collection: _change_validation_results (MongoDB — validation audit)
Fields:
  - _id: ObjectId
  - changeId: string
  - environment: string
  - validatedAt: Date
  - status: string
  - summary: string
  - details: object
Indexes:
  - { changeId: 1, validatedAt: -1 }
```

```text
Collection: _change_backfill_progress (MongoDB — resumable progress)
Fields:
  - _id: string (change id + optional tenant target)
  - changeId: string
  - tenantId: string | null
  - environment: string
  - status: string ("queued" | "running" | "paused" | "completed" | "failed")
  - totalEstimated: number
  - totalProcessed: number
  - lastCursor: object
  - batchSize: number
  - startedAt: Date
  - updatedAt: Date
  - completedAt: Date | null
  - lastError: string | null
Indexes:
  - { status: 1, environment: 1 }
  - { tenantId: 1, changeId: 1 }
```

### Key Relationships

- Service readiness gates read `_change_history` to determine whether required change IDs are applied and validated.
- MongoDB migration runner, seed/reference-data runner, and future ClickHouse/script runners all write into `_change_history`.
- `_change_backfill_progress` is written by resumable workers and surfaced through admin APIs and health views.
- `_change_validation_results` stores periodic re-validation so operators can detect drift caused by out-of-band writes after initial rollout.
- Secret-management operations write metadata to `_change_history` but keep values in AWS Secrets Manager or equivalent external systems.
- Global deployment-core seed entries and tenant lifecycle seed entries share the same status surface, but must remain distinguishable by `scope` and `trigger`.
- Configuration Management remains canonical for config values, snapshots, diffs, and watcher-driven propagation; Change Management stores only the refs and validation evidence needed to correlate a release.
- Health, tracing, metrics, and alerting surfaces consume change history plus validation/progress metadata to expose blockers, heartbeat age, validation freshness, and stalled backfills coherently.

---

## 10. Key Implementation Files

### Domain / Core Logic

| File                                                                           | Purpose                                                                                                 |
| ------------------------------------------------------------------------------ | ------------------------------------------------------------------------------------------------------- |
| `packages/database/src/migrations/runner.ts`                                   | Current MongoDB migration runner to be adapted into the shared manifest contract.                       |
| `packages/database/src/migrations/lock.ts`                                     | Current distributed migration lock with `extendLock()` that should become shared lease.                 |
| `packages/database/src/seed/runner.ts`                                         | Current tracked seed runner to be converged into the shared ledger.                                     |
| `packages/database/seed-mongo.ts`                                              | Current seed orchestrator with status and validation modes.                                             |
| `packages/database/src/clickhouse-schemas/migrations/add-custom-dimensions.ts` | Current ad-hoc ClickHouse migration helper to be registered formally.                                   |
| `apps/search-ai/migrations/clickhouse/006_json_path_index.sql`                 | Raw SQL migration file currently outside tracked orchestration.                                         |
| `scripts/migrate-pipeline-triggers.ts`                                         | Standalone TypeScript migration script outside the current registry.                                    |
| `scripts/migrate-chunkStrategy-to-tokenChunkStrategy.ts`                       | Standalone TypeScript migration script outside the current registry.                                    |
| `scripts/migrate-abl.ts`                                                       | Standalone operational migration script outside the current registry.                                   |
| `scripts/rbac-tool-permissions.ts`                                             | Standalone RBAC migration flow that mutates code-required permissions.                                  |
| `scripts/seed-secrets.ts`                                                      | Secret-management operational flow that should be tracked without storing values.                       |
| `scripts/validate-secrets-completeness.ts`                                     | Secret completeness validator that should report operational metadata into the shared surface.          |
| `apps/runtime/src/scripts/migrate-env-to-instances.ts`                         | One-time credential/service-instance migration currently outside the tracked registry.                  |
| `apps/search-ai/src/scripts/migrate-source-document-counts.ts`                 | SearchAI reconciliation script that mutates persisted counts outside tracked history.                   |
| `apps/search-ai/src/scripts/backfill-entity-instances.ts`                      | SearchAI ClickHouse backfill script that should become a tracked `backfill` entry.                      |
| `apps/search-ai/scripts/add-job-execution-ttl-index.ts`                        | SearchAI TTL-index migration outside the central registry.                                              |
| `apps/runtime/src/db/channel-connection-index-repair.ts`                       | Runtime-startup mutation path that should migrate into the control plane.                               |
| `apps/studio/src/repos/workspace-repo.ts`                                      | Workspace creation path that bootstraps tenant defaults outside deploy-time seeding.                    |
| `apps/studio/src/app/api/auth/dev-login/route.ts`                              | Dev-login path that best-effort seeds tenant defaults during tenant attachment.                         |
| `apps/studio/src/app/api/auth/create-workspace/route.ts`                       | Workspace creation route that relies on lifecycle bootstrap rather than deploy seed.                    |
| `apps/runtime/src/routes/platform-admin-tenants.ts`                            | Tenant-creation/admin path that seeds operational defaults after tenant creation.                       |
| `packages/eventstore/src/migration/index.ts`                                   | Existing bridge layer that must be explicitly classified as `bridge`, not a migration.                  |
| `packages/database/src/change-management/*` (new)                              | Planned shared manifest, ledger, runner, lease, validation, and version-gate modules.                   |
| `packages/config/src/loader.ts`                                                | Existing configuration loader and schema-validation entrypoint that remains canonical for config state. |
| `packages/config/src/validation/config-diff.ts`                                | Existing config diff/masking helper that should provide promotion evidence to release planning.         |
| `packages/config/src/watcher.ts`                                               | Existing runtime config propagation boundary that Change Management must integrate with, not replace.   |

### Routes / Handlers

| File                                                          | Purpose                                                                                                        |
| ------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------- |
| `apps/runtime/src/server.ts`                                  | Runtime health and readiness gates; future change compatibility checks.                                        |
| `apps/search-ai/src/server.ts`                                | SearchAI readiness gate integration.                                                                           |
| `apps/admin/src/app/api/health/route.ts`                      | Admin local pod-health probe; not the authoritative shared-state gate.                                         |
| `apps/runtime/src/routes/platform-admin-health.ts`            | Existing system-health surface to extend with change-management state.                                         |
| `apps/admin/src/app/api/system-health/route.ts`               | Existing admin proxy pattern that should surface Runtime compatibility blockers.                               |
| `apps/admin/src/app/api/config/route.ts`                      | Existing config-management surface that should cross-link config evidence, not execute shared-state mutations. |
| `apps/runtime/src/routes/platform-admin-change-management.ts` | Planned runtime admin route surface for change status and control.                                             |
| `apps/admin/src/app/api/change-management/[...path]/route.ts` | Planned admin proxy for change-management APIs.                                                                |

### UI Components

| File                                       | Purpose                                                     |
| ------------------------------------------ | ----------------------------------------------------------- |
| `apps/admin/src/app/(dashboard)/health/*`  | Existing operator surface that can link to change blockers. |
| `apps/admin/src/app/(dashboard)/changes/*` | Planned admin change-management dashboard and detail views. |

### Jobs / Workers / Background Processes

| File                                                         | Purpose                                                               |
| ------------------------------------------------------------ | --------------------------------------------------------------------- |
| `packages/database/src/change-management/release-job.ts`     | Planned release-job entrypoint for pre/post-deploy execution.         |
| `packages/database/src/change-management/backfill-worker.ts` | Planned resumable backfill worker with checkpointing.                 |
| `packages/database/src/change-management/lease.ts`           | Planned shared lease, heartbeat renewal, and stale-fence enforcement. |
| `packages/database/src/change-management/observability.ts`   | Planned TraceStore, metric, and health-summary emission helper.       |

### Tests

| File                                                                     | Type              | Coverage Focus                                                       |
| ------------------------------------------------------------------------ | ----------------- | -------------------------------------------------------------------- |
| `packages/database/src/__tests__/change-management/manifest.test.ts`     | unit              | Dependency graph validation, metadata completeness, checksum policy  |
| `packages/database/src/__tests__/change-management/lease-lock.test.ts`   | unit              | Heartbeat renewal, fence monotonicity, stale-writer rejection        |
| `packages/database/src/__tests__/change-management/version-gate.test.ts` | unit              | Required change resolution for Runtime, SearchAI, and Admin          |
| `packages/database/src/__tests__/change-management/registry.e2e.test.ts` | integration       | Unified status across Mongo, seed/reference-data, and script runners |
| `apps/runtime/src/__tests__/change-management-readiness.test.ts`         | integration / e2e | Runtime readiness behavior when required changes are missing         |
| `apps/search-ai/src/__tests__/change-management-readiness.test.ts`       | integration / e2e | SearchAI readiness behavior under missing required change IDs        |
| `apps/admin/src/__tests__/change-management-health-proxy.test.ts`        | integration       | Admin proxy surfacing change blockers and validation state           |

---

## 11. Configuration

### Environment Variables

| Variable                        | Default      | Description                                                                      |
| ------------------------------- | ------------ | -------------------------------------------------------------------------------- |
| `CHANGE_LOCK_TTL_MS`            | `300000`     | Lease duration for shared change-management locks.                               |
| `CHANGE_LOCK_HEARTBEAT_MS`      | `60000`      | Heartbeat interval for renewing active leases.                                   |
| `CHANGE_BACKFILL_BATCH_SIZE`    | `500`        | Default batch size for resumable backfills.                                      |
| `CHANGE_BACKFILL_DELAY_MS`      | `100`        | Delay between batches to control database pressure.                              |
| `CHANGE_ENFORCEMENT_MODE`       | `soft_ready` | Compatibility gate behavior: `soft_ready`, `hard_fail`, or `warn_only`.          |
| `CHANGE_CHECKSUM_ENFORCEMENT`   | `warn`       | Behavior on checksum drift: `ignore`, `warn`, or `fail`.                         |
| `CHANGE_RELEASE_ID`             | `""`         | External release identifier written into change history.                         |
| `CHANGE_ENVIRONMENT`            | `""`         | Explicit environment label for status and validation records.                    |
| `CHANGE_CONFIG_SNAPSHOT_REF`    | `""`         | Configuration-management snapshot/version reference associated with the rollout. |
| `CHANGE_CONFIG_DIFF_REF`        | `""`         | Configuration diff/dry-run evidence reference for the target environment.        |
| `CHANGE_LOWER_ENV_EVIDENCE_REF` | `""`         | Lower-environment change/config validation evidence for promotion workflows.     |
| `CHANGE_PLAN_SNAPSHOT_URI`      | `""`         | Optional sanitized snapshot input for pre-merge plan/dry-run analysis.           |
| `OBS_STRICT_READINESS_GATES`    | existing     | Existing readiness strictness flag to be extended with compatibility checks      |

### Runtime Configuration

- Required change IDs belong in service-local code constants or requirement modules, not in a central environment variable.
- The rollout-owner identity and artifact reference should be injected by deployment automation so history can prove which single deployment artifact executed a change set.
- Configuration Management remains the source of truth for runtime config values, feature flags, and environment promotion workflows; change-management stores only config snapshot/diff/evidence references needed to audit a release.
- Admin/manual execution should be role-gated and environment-aware.
- Continuous reference-data sync may run every deploy, but must still honor environment scoping and idempotency policy.
- Tenant bootstrap flows should carry `trigger=tenant_lifecycle` or targeted manual execution metadata so the platform can distinguish global deployment readiness from per-tenant bootstrap completeness.
- Readiness should layer change compatibility on top of existing health-check infrastructure, not re-implement config propagation or watcher behavior inside the change-management control plane.

### DSL / Agent IR / Schema

Change Management is not an ABL DSL feature. The manifest and service requirement declarations are authored in TypeScript alongside the code that depends on them.

---

## 12. Non-Functional Concerns

### Isolation & Multitenancy

| Concern           | Requirement / Expectation                                                                                                                          |
| ----------------- | -------------------------------------------------------------------------------------------------------------------------------------------------- |
| Project isolation | Project-scoped backfills and reference-data sync must include `projectId` in filters and must not mutate cross-project state.                      |
| Tenant isolation  | Tenant-scoped change execution must include `tenantId` in all queries and progress records; canary rollout must never read or write other tenants. |
| User isolation    | User-owned data changes must filter by `createdBy` or `ownerId`; change-management APIs must not expose cross-user resource existence.             |

### Security & Compliance

- Platform-admin change APIs must require the same or stricter controls as existing platform-admin runtime routes.
- Secret values must never be stored in `_change_history`, `_change_validation_results`, or operator-facing payloads.
- Destructive operations must require explicit operator approval and audit logging.
- Checksums, validation outcomes, actor identity, environment, and release metadata must be retained as an audit trail.

### Performance & Scalability

- App pod startup should not become a serialized deployment bottleneck; pods should only read compatibility state, not run long mutations.
- Backfills must batch, checkpoint, and optionally target tenant subsets to keep write pressure controlled.
- Engine-scoped locks may be introduced later for independent parallelism, but the initial implementation should optimize for correctness first.
- Continuous reference-data sync must remain diff-based and idempotent so it can safely run every deploy.

### Reliability & Failure Modes

- Every deploy-blocking change must be safe to retry or explicitly marked forward-only with compensation requirements.
- Lease heartbeat loss must cause the active runner to stop writing results once its fence is stale.
- Missing required changes must keep pods out of readiness and visible through operator health surfaces.
- Resume-from-checkpoint must be the default for long-running backfills.

### Observability

- Change execution should emit structured logs and metrics for start, success, failure, heartbeat, validation, drift, and stall conditions.
- Release jobs, manual operator actions, and backfill lifecycle transitions should emit `TraceEvent`s through the shared `TraceStore` with `changeId`, `phase`, `trigger`, `environment`, `releaseId`, and outcome metadata.
- System health surfaces should expose change blockers alongside infra health.
- Operators need status by environment, by release, by service dependency, and by tenant for canary backfills.
- OpenTelemetry metrics should include at least blocker counts, validation age, lease-heartbeat age, pending-entry counts, and stalled-backfill indicators so alerts can be derived from the same dimensions as status views.
- Alerting should page on failed `pre_deploy` jobs, prolonged readiness blockers, heartbeat loss, stale validation for blocking entries, and stalled backfills.

### Data Lifecycle

- `_change_history` should be treated as permanent audit data.
- Validation results and backfill progress may have retention windows, but must preserve enough history for postmortems.
- Compensation artifacts for destructive or high-risk changes may need off-database retention (for example, snapshot storage).

---

## 13. Delivery Plan / Work Breakdown

1. **Registry and taxonomy foundation**
   1.1 Define the shared manifest contract and common metadata vocabulary.
   1.2 Inventory every current change surface in this repo and classify it by `phase`, `trigger`, `kind`, `engine`, and `scope`.
   1.3 Explicitly mark known mutation scripts as registered, deprecated, or non-release-coupled so CI can distinguish live operational debt from local refactoring utilities.
   1.4 Introduce a shared change ledger and compatibility helpers without removing current runners yet.
2. **Locking and safety hardening**
   2.1 Replace the current migration-only lease with shared heartbeat and stale-fence protection.
   2.2 Add equivalent locking for tracked seed/reference-data execution.
   2.3 Define destructive-operation and compensation policy.
3. **Service compatibility gates**
   3.1 Add service-local required change declarations for Runtime and SearchAI plus an Admin dependency contract.
   3.2 Extend Runtime and SearchAI readiness endpoints to report compatibility blockers, and extend Admin proxy/system-health surfaces to surface the same state.
   3.3 Move pod-startup mutation flows into the release control plane or formally register them as changes.
4. **Runner convergence**
   4.1 Adapt the Mongo migration runner to the shared manifest contract.
   4.2 Adapt tracked seed/reference-data flows into the same status surface.
   4.3 Add ClickHouse and script-engine runner adapters.
   4.4 Classify deployment-core seeding separately from tenant lifecycle bootstrap and secret flows.
   4.5 Register orphaned SQL and script-based changes or explicitly retire them.
5. **Backfill orchestration and operator surfaces**
   5.1 Add resumable backfill checkpoints and tenant-scoped canary support.
   5.2 Add runtime admin APIs and admin proxy routes for status, validate, run, and pause/resume.
   5.3 Add dashboards, alerts, validation-age visibility, and config-evidence correlation.
   5.4 Surface global deployment-core readiness separately from tenant bootstrap completeness.
6. **CI and release integration**
   6.1 Add lint and plan commands for manifest integrity, idempotency rules, and configuration-evidence checks.
   6.2 Define the single rollout owner in the deploy repo and ensure only that artifact carries shared-state `PreSync` and `PostSync` hooks.
   6.3 Integrate pre-deploy and post-deploy execution into the release pipeline using the same artifact version as the app rollout.
   6.4 Require lower-environment change validation plus configuration-management evidence before promoting the same release to higher environments.

---

## 14. Success Metrics

| Metric                        | Baseline                                       | Target                                                                                              | How Measured                                |
| ----------------------------- | ---------------------------------------------- | --------------------------------------------------------------------------------------------------- | ------------------------------------------- |
| Registered change coverage    | Fragmented; several scripts outside ledgers    | 100% of release-coupled changes represented in the manifest                                         | Manifest inventory vs repo search           |
| Pod compatibility enforcement | No service verifies required changes           | 100% of Runtime/SearchAI pods gate readiness; Admin surfaces the same blockers through proxy health | Readiness logs and health API status        |
| Rollout owner uniqueness      | No explicit owner for shared-state hooks       | Exactly 1 rollout-owned change-management artifact per environment                                  | Deploy config audit + release-job metadata  |
| Orphaned change mechanisms    | Multiple ad-hoc SQL and TS paths               | 0 unregistered release-coupled change scripts in the repo                                           | CI lint rule + periodic inventory audit     |
| Backfill resumability         | Mongo runner only; no shared checkpointing     | 100% of large backfills resume from stored checkpoints                                              | Backfill progress records + recovery tests  |
| Operator visibility           | CLI-only for tracked Mongo/seed flows          | Unified admin/API/CLI visibility for status and validation                                          | Admin API availability + dashboard adoption |
| Startup mutation debt         | Startup repair logic exists in app paths       | 0 production pod-startup mutation paths outside approved gate                                       | Code inventory and CI policy                |
| Drift detection               | Partial checksum and validation coverage       | Checksum drift and validation age surfaced for all blocking changes                                 | Change status surface and alerting          |
| Tenant readiness visibility   | Deploy seed can be mistaken for full readiness | Operators can distinguish global deployment-core seed from tenant lifecycle bootstrap               | Status API filters by scope and trigger     |
| Release evidence completeness | Release metadata is not linked to config state | Every promoted release carries change, config, and lower-environment evidence refs                  | Change history audit + promotion records    |
| Change observability coverage | No named change-management alert set today     | Health, trace, metric, and alert surfaces emit the same blocker and rollout dimensions              | OTel dashboards + alert rule coverage       |

---

## 15. Open Questions

1. Should the first implementation keep engine-specific history stores with a federated status API, or move immediately to a shared `_change_history` ledger in MongoDB for all engines?
2. Should the default compatibility behavior be soft readiness failure, or should production use hard startup failure by default?
3. For destructive or forward-only changes, should compensation snapshots live in MongoDB metadata, object storage, or environment-specific backup tooling?
4. Should secret bootstrap be represented as a first-class change kind in the same manifest, or remain a sibling operational registry that only contributes status into the shared admin surface?
5. How much parallelism is acceptable for tenant-scoped backfills before cursor coordination and blast radius become too risky?

---

## 16. Gaps, Known Issues & Limitations

| ID      | Description                                                                                                                                                                                                  | Severity | Status |
| ------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | -------- | ------ |
| GAP-001 | The repo currently has multiple change mechanisms with inconsistent tracking (`migrations`, `seed`, raw SQL, ad-hoc scripts).                                                                                | High     | Open   |
| GAP-002 | There is no shared service compatibility gate; pods do not verify required schema/data changes before serving traffic.                                                                                       | High     | Open   |
| GAP-003 | The current migration lock has a lease extension helper but no active heartbeat in the runner.                                                                                                               | High     | Open   |
| GAP-004 | Seed/reference-data execution has status and validation, but no distributed lock or shared release-job orchestration.                                                                                        | High     | Open   |
| GAP-005 | Some runtime mutations still happen during service startup instead of through a release control plane.                                                                                                       | High     | Open   |
| GAP-006 | ClickHouse and script-based changes are not represented in the current tracked ledgers.                                                                                                                      | Medium   | Open   |
| GAP-007 | Current health and admin health surfaces report infra availability, not change compatibility or validation freshness.                                                                                        | Medium   | Open   |
| GAP-008 | CI does not yet enforce manifest integrity, dependency validity, or idempotency guarantees across all change kinds.                                                                                          | Medium   | Open   |
| GAP-009 | Existing Database Migrations and Seed Data docs describe parts of the target architecture, but the parent control-plane contract is missing.                                                                 | Medium   | Open   |
| GAP-010 | The deploy topology does not yet define exactly one rollout owner for shared-state `PreSync` and `PostSync` execution.                                                                                       | High     | Open   |
| GAP-011 | The current repo inventory still contains app-local migration scripts outside the documented manifest inventory.                                                                                             | High     | Open   |
| GAP-012 | Deployment seeding currently covers platform-core only, but the platform has no unified status view that distinguishes tenant bootstrap, secrets completeness, and provider-vault setup.                     | High     | Open   |
| GAP-013 | Change-management planning is not yet linked to Configuration Management dry-run, diff, or promotion evidence, so a release can look green on shared-state checks while required config evidence is missing. | High     | Open   |
| GAP-014 | Existing health, tracing, and alerting surfaces do not yet define named change-management metrics or alerts for heartbeat age, validation age, readiness blockers, or stalled backfills.                     | Medium   | Open   |

---

## 17. Testing & Validation

### Required Test Coverage

| #   | Scenario                                                                       | Coverage Type | Status     | Test File / Note                                  |
| --- | ------------------------------------------------------------------------------ | ------------- | ---------- | ------------------------------------------------- |
| 1   | Manifest inventory catches unregistered release-coupled scripts                | unit          | NOT TESTED | Planned manifest lint suite                       |
| 2   | Dependency graph rejects cycles and missing referenced change IDs              | unit          | NOT TESTED | Planned manifest dependency tests                 |
| 3   | Inventory lint covers known app-local scripts and rejects silent exclusions    | unit          | NOT TESTED | Planned inventory allowlist/deprecation tests     |
| 4   | Default deploy seeding does not mark tenant lifecycle bootstrap as complete    | integration   | NOT TESTED | Planned targeted-seed vs deploy-seed status tests |
| 5   | Shared lease heartbeat renews and stale writers cannot persist results         | unit          | NOT TESTED | Planned lock/fence tests                          |
| 6   | Runtime readiness fails when required change IDs are missing                   | integration   | NOT TESTED | Planned Runtime readiness compatibility tests     |
| 7   | SearchAI readiness fails when required change IDs are missing                  | integration   | NOT TESTED | Planned SearchAI readiness compatibility tests    |
| 8   | Unified admin status surface reports Mongo, seed, ClickHouse, and script state | integration   | NOT TESTED | Planned runtime admin route and admin proxy tests |
| 9   | Backfill checkpoint resume works after interruption                            | integration   | NOT TESTED | Planned backfill worker lifecycle tests           |
| 10  | Pre-deploy release job blocks rollout when a required change fails             | e2e / manual  | NOT TESTED | Planned deployment-hook verification              |
| 11  | Continuous reference-data sync re-runs without duplicates or destructive drift | integration   | NOT TESTED | Planned seed-platform diff tests                  |
| 12  | Checksum drift and stale validation are surfaced in operator status payloads   | integration   | NOT TESTED | Planned status/validation API tests               |

### Testing Notes

The current repo has partial runner tests for Mongo migrations and tracked seed execution, but it does not yet test the full control-plane architecture described here. The matching testing guide is intentionally a planning artifact and should be expanded into real E2E and integration work as the implementation phases land.

> Full testing details: `../testing/change-management.md`

---

## 18. References

- Existing Mongo migration runner: `packages/database/src/migrations/runner.ts`
- Existing migration lock: `packages/database/src/migrations/lock.ts`
- Existing tracked seed runner: `packages/database/src/seed/runner.ts`
- Existing seed entrypoint: `packages/database/seed-mongo.ts`
- Existing ClickHouse helper: `packages/database/src/clickhouse-schemas/migrations/add-custom-dimensions.ts`
- Existing SQL migration artifact: `apps/search-ai/migrations/clickhouse/006_json_path_index.sql`
- Existing standalone scripts: `scripts/migrate-pipeline-triggers.ts`, `scripts/migrate-chunkStrategy-to-tokenChunkStrategy.ts`, `scripts/migrate-abl.ts`, `scripts/seed-secrets.ts`, `scripts/validate-secrets-completeness.ts`
- Existing startup mutation path: `apps/runtime/src/db/channel-connection-index-repair.ts`
- Existing readiness endpoints: `apps/runtime/src/server.ts`, `apps/search-ai/src/server.ts`, `apps/admin/src/app/api/health/route.ts`
- Related feature docs: [Database Migrations](database-migrations.md), [Seed Data](seed-data.md), [Deployments & Versioning](deployments-versioning.md), [Health Checks / Readiness Probes](health-checks.md), [CI/CD Pipeline](cicd-pipeline.md)

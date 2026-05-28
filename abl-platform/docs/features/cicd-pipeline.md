# Feature: CI/CD Pipeline Definition

**Doc Type**: MAJOR FEATURE
**Parent Feature**: N/A
**Status**: PLANNED
**Feature Area(s)**: `admin operations`, `enterprise`, `governance`
**Package(s)**: `.harness/`, `apps/runtime`, `apps/studio`, `apps/admin`, `apps/search-ai`, `apps/search-ai-runtime`, `services/*`, `packages/database`
**Owner(s)**: `Platform team`, `DevOps team`
**Testing Guide**: [docs/testing/cicd-pipeline.md](../testing/cicd-pipeline.md)
**Last Updated**: 2026-03-23

---

## 1. Introduction / Overview

### Problem Statement

The ABL platform is a multi-tenant, Kubernetes-deployed monorepo with 15+ deployable services across three repositories (abl-platform, abl-platform-deploy, abl-platform-infra). Today, the CI/CD pipeline exists as a single Harness CI pipeline (`ci-build.yaml`) that builds, tests, scans, and pushes Docker images, then updates the deploy repo's `values-dev.yaml` for ArgoCD auto-sync. While functional, this pipeline has significant gaps for enterprise production readiness:

1. **No PR validation pipeline** -- pull requests merge without automated lint, typecheck, test, and security gates enforced at the branch level.
2. **No staged environment promotion** -- images go directly to dev; staging and production promotions are manual, unaudited processes.
3. **No deployment gates** -- there are no health check verifications, smoke tests, or approval steps between environments.
4. **No rollback automation** -- rollbacks require manual Helm value edits and ArgoCD force-sync.
5. **No canary or progressive delivery** -- all deployments are full replacements with no traffic-weighted rollout.
6. **No DORA metrics** -- deployment frequency, lead time, change failure rate, and failed deployment recovery time are not tracked.
7. **No hotfix pipeline** -- critical production fixes follow the same slow path as feature work.
8. **Incomplete monorepo optimization** -- Turbo `--filter` is used for selective builds, but `--affected` for change-detection-based CI is not wired.

### Goal Statement

Define a comprehensive, enterprise-grade CI/CD pipeline system that provides automated PR validation, staged environment promotion (dev, staging, production) with deployment gates, progressive delivery via Argo Rollouts, automated rollback, hotfix fast-path, and DORA metrics instrumentation -- all orchestrated through Harness pipelines, Helm chart promotion in abl-platform-deploy, and ArgoCD GitOps sync in the Kubernetes cluster.

### Summary

This feature formalizes the CI/CD pipeline definition for the ABL platform across three pipeline types (PR, merge/CI, deployment/CD), three environments (dev, staging, production), and three repositories. It introduces PR validation gates, monorepo-aware selective testing with Turbo `--affected`, Docker image optimization with multi-stage builds and layer caching, Trivy container scanning with SBOM generation, Helm value promotion across environments, ArgoCD sync waves for ordered deployment (infra/migrations -> services -> post-deploy verification), progressive delivery via Argo Rollouts (canary for runtime, blue-green for Studio), automated rollback triggered by health check failures, deployment approval gates for production, and a DORA metrics dashboard for continuous improvement. The system spans Harness (pipeline orchestration), Azure Container Registry (image storage), Helm (configuration templating), ArgoCD (GitOps delivery), and Argo Rollouts (traffic management).

---

## 2. Scope

### Goals

- Implement a PR validation pipeline that runs lint, typecheck, affected-package tests, and security scans on every pull request before merge.
- Implement a merge/CI pipeline that builds, tests, scans, pushes Docker images, and triggers dev environment deployment via ArgoCD.
- Implement a CD pipeline with staged promotion: dev (auto-sync) -> staging (approval gate + smoke tests) -> production (approval gate + canary rollout + health verification).
- Implement progressive delivery using Argo Rollouts with canary strategy for stateless services (Runtime, SearchAI, Admin) and blue-green for stateful frontends (Studio).
- Implement automated rollback triggered by failed health checks, error rate spikes, or manual operator action.
- Implement a hotfix pipeline that fast-tracks critical fixes from a hotfix branch to production with abbreviated but non-skipped validation.
- Instrument DORA metrics: deployment frequency, change lead time, change failure rate, and failed deployment recovery time.
- Optimize monorepo CI with Turbo `--affected` for PR pipelines and Turbo `--filter` for selective merge builds.
- Standardize Docker image tagging with semantic version + commit SHA + date, and enforce image signing with Cosign.
- Implement ArgoCD sync waves to order deployments: Wave -1 (infrastructure/secrets) -> Wave 0 (DB migrations via init container) -> Wave 1 (core services) -> Wave 2 (dependent services) -> Wave 3 (post-deploy smoke tests).

### Non-Goals (Out of Scope)

- Multi-cluster deployment (single AKS cluster per environment for now).
- A/B testing or experiment-based traffic splitting (covered by future experiments feature).
- Custom CI/CD UI in Studio or Admin portal (pipelines are managed in Harness UI and pipeline-as-code YAML).
- Self-hosted runner infrastructure management (Harness manages CI pods on AKS).
- Cross-tenant deployment isolation (all tenants share the same platform deployment; tenant isolation is at the application layer).
- Terraform IaC pipeline automation for abl-platform-infra (managed separately by infrastructure team).

---

## 3. User Stories

1. As a `developer`, I want every pull request to automatically run lint, typecheck, and tests for affected packages so that I get fast feedback without running the full monorepo test suite.
2. As a `developer`, I want merge to main to automatically build and deploy to dev so that I can validate my changes in a real environment within minutes of merge.
3. As an `SRE`, I want staging deployments to require a smoke test pass and manual approval before promoting to production so that I can catch environment-specific issues before they reach customers.
4. As an `SRE`, I want canary deployments for Runtime that gradually shift traffic (10% -> 25% -> 50% -> 100%) with automatic rollback on error rate spikes so that production incidents from bad deployments are minimized.
5. As a `security engineer`, I want every Docker image to pass Trivy vulnerability scanning (CRITICAL/HIGH) and Gitleaks secret detection before being pushed to the registry so that known vulnerabilities and leaked secrets never reach production.
6. As a `release manager`, I want a hotfix pipeline that can promote a critical fix from hotfix branch to production within 30 minutes so that customer-impacting issues are resolved quickly.
7. As a `QA engineer`, I want post-deployment smoke tests to automatically verify health endpoints, critical API flows, and database migration status so that deployment failures are caught before traffic is shifted.
8. As a `platform operator`, I want a DORA metrics dashboard showing deployment frequency, lead time, change failure rate, and recovery time so that I can track and improve our delivery performance.
9. As a `release manager`, I want environment promotion to be auditable with records of who approved, what version was deployed, and what the deployment outcome was so that compliance requirements are met.
10. As a `developer`, I want Docker builds to use layer caching and Turbo remote caching so that CI pipeline duration stays under 15 minutes for full builds and under 5 minutes for affected-only PR checks.

---

## 4. Functional Requirements

1. **FR-1**: The system must run a PR validation pipeline on every pull request that executes: (a) Prettier format check, (b) TypeScript typecheck via `pnpm turbo typecheck --affected`, (c) unit tests via `pnpm turbo test:fast --affected`, (d) Semgrep SAST scan, (e) Gitleaks secret detection. The pipeline must block merge if any step fails.
2. **FR-2**: The system must run a merge/CI pipeline on every push to `main` that executes: (a) full build via `pnpm turbo build`, (b) unit tests, (c) integration tests with MongoDB and Redis sidecars, (d) Playwright E2E tests for Studio and Admin, (e) coverage enforcement, (f) Docker image builds for all services, (g) Trivy vulnerability scan with SBOM generation, (h) image push to ACR, (i) deploy repo update for dev environment.
3. **FR-3**: The system must tag Docker images with three tags: `{commitSha7}` (immutable), `main-{YYYYMMDD}` (date-based), and `latest` (rolling). Production images must additionally be tagged with `v{semver}`.
4. **FR-4**: The system must support selective service builds via the `build_services` pipeline variable, building only specified services while skipping unaffected ones to reduce CI time.
5. **FR-5**: The system must use Harness stage templates (`docker_build_node_app`, `docker_build_python_service`, `docker_build_standalone_app`) to standardize Docker build, scan, and push steps across all service types.
6. **FR-6**: The system must update the deploy repo (`abl-platform-deploy`) Helm values file for the target environment after successful image pushes, using `yq` to set image tags under the appropriate subchart keys.
7. **FR-7**: The system must implement ArgoCD sync waves with annotations: Wave -1 for infrastructure secrets and ConfigMaps, Wave 0 for database migration init containers, Wave 1 for core services (Runtime, SearchAI, Studio), Wave 2 for dependent services (Admin, Python services), Wave 3 for post-deploy verification hooks.
8. **FR-8**: The system must implement a staging promotion pipeline that: (a) copies image tags from dev values to staging values in the deploy repo, (b) triggers ArgoCD sync for staging, (c) runs smoke tests against staging endpoints, (d) requires manual approval from a designated approver group before proceeding to production.
9. **FR-9**: The system must implement progressive delivery for production deployments using Argo Rollouts: canary strategy for Runtime and SearchAI (10% -> 25% -> 50% -> 100% over 20 minutes with analysis at each step), blue-green for Studio (instant switchover after readiness verification).
10. **FR-10**: The system must implement automated rollback when: (a) Argo Rollouts analysis detects error rate > 5% or p99 latency > 2x baseline during canary steps, (b) post-deploy smoke tests fail, (c) health check endpoints return non-200 for > 30 seconds. Rollback must complete within 5 minutes.
11. **FR-11**: The system must implement a hotfix pipeline triggered from `hotfix/*` branches that: (a) runs abbreviated validation (typecheck + affected tests + security scan), (b) builds only the affected service, (c) promotes directly to staging with automated smoke tests, (d) promotes to production with expedited approval (single approver, 15-minute SLA).
12. **FR-12**: The system must record deployment events in a `deployment_records` collection including: pipeline execution ID, environment, services deployed, image tags, deployer identity, approval chain, start/end timestamps, outcome (success/failure/rollback), and rollback reference.
13. **FR-13**: The system must compute and expose DORA metrics: deployment frequency (deploys per day per environment), change lead time (commit timestamp to production deploy timestamp), change failure rate (deployments requiring rollback / total deployments), failed deployment recovery time (time from failure detection to successful remediation).
14. **FR-14**: The system must send deployment notifications to configured channels (Slack, Google Chat) on: deployment start, promotion approval required, deployment success, deployment failure, rollback triggered, and DORA metrics weekly summary.
15. **FR-15**: The system must enforce branch protection rules: `main` requires PR with at least 1 approval, passing CI checks, and no unresolved conversations. `release/*` branches require 2 approvals. Direct pushes to `main` are blocked except for the CI bot.

---

## 5. Feature Classification & Integration Matrix

### Lifecycle / Platform Impact

| Area                       | Impact Level | Notes                                                                                                       |
| -------------------------- | ------------ | ----------------------------------------------------------------------------------------------------------- |
| Project lifecycle          | SECONDARY    | Deployments affect all projects within a tenant; project-level deployment isolation is not in scope.        |
| Agent lifecycle            | SECONDARY    | Agent configuration deployments (DSL versions) are managed by deployments-versioning, not this pipeline.    |
| Customer experience        | PRIMARY      | Deployment failures, rollbacks, and progressive delivery directly affect end-user availability.             |
| Integrations / channels    | SECONDARY    | Deployment of Runtime affects all channel integrations (SDK, A2A, MCP, voice).                              |
| Observability / tracing    | PRIMARY      | DORA metrics, deployment events, and rollback triggers are core observability signals.                      |
| Governance / controls      | PRIMARY      | Approval gates, audit trails, branch protection, and security scanning are governance controls.             |
| Enterprise / compliance    | PRIMARY      | Image signing, vulnerability scanning, SBOM generation, and deployment audit logs are compliance controls.  |
| Admin / operator workflows | PRIMARY      | Operators manage promotions, approvals, rollbacks, and monitor DORA metrics through Harness and dashboards. |

### Related Feature Integration Matrix

| Related Feature                                         | Relationship Type | Why It Matters                                                                                         | Key Touchpoints                                                         | Current State                                            |
| ------------------------------------------------------- | ----------------- | ------------------------------------------------------------------------------------------------------ | ----------------------------------------------------------------------- | -------------------------------------------------------- |
| [Deployments & Versioning](deployments-versioning.md)   | extends           | Agent version deployments happen at the application layer; CI/CD deploys the platform infrastructure.  | Deployment records, version promotion, environment targeting            | ALPHA -- agent versioning exists, CI/CD promotion is not |
| [Seed Data](seed-data.md)                               | depends on        | DB migrations and seed data run as init containers during ArgoCD sync Wave 0.                          | `packages/database/src/migrations/cli.ts`, init container in Dockerfile | Implemented via Dockerfile init stage                    |
| [Audit Logging](audit-logging.md)                       | emits into        | Deployment events (who deployed, what, when, outcome) must be captured in audit logs.                  | `deployment_records` collection, Harness pipeline execution events      | Audit logging exists; deployment events not yet emitted  |
| [Circuit Breaker](circuit-breaker.md)                   | tested with       | Post-deployment health checks must verify circuit breaker state is healthy.                            | Health endpoints, Redis connectivity checks                             | Circuit breaker exists; not tested in deployment gates   |
| [Rate Limiting](rate-limiting.md)                       | tested with       | Post-deployment smoke tests should verify rate limiting middleware is functional.                      | Runtime `/health`, SearchAI `/health`, rate-limit header verification   | Rate limiting exists; not verified post-deploy           |
| [Configuration Management](configuration-management.md) | configured by     | Environment-specific configuration (secrets, env vars) is managed through Helm values and K8s secrets. | `values-dev.yaml`, `values-staging.yaml`, `values-prod.yaml`            | Dev values exist; staging/prod values are not formalized |
| [Environment Variables](environment-variables.md)       | configured by     | Service environment variables are injected via Helm values and K8s ConfigMaps/Secrets.                 | Helm `env` blocks, ArgoCD secret management                             | Dev environment configured; promotion path missing       |

---

## 6. Design Considerations (Optional)

### Pipeline Architecture

The CI/CD system is organized around three pipeline types, each triggered by different Git events:

```
PR Pipeline (on pull_request to main/develop)
  -> Lint + Typecheck + Affected Tests + Security Scan
  -> Status check required for merge

Merge/CI Pipeline (on push to main)
  -> Full Build + Test + Docker Build + Scan + Push
  -> Update deploy repo values-dev.yaml
  -> ArgoCD auto-syncs dev

CD Pipeline (manual trigger or scheduled)
  -> Promote dev -> staging (approval gate)
  -> Smoke tests on staging
  -> Promote staging -> production (approval gate)
  -> Argo Rollouts canary/blue-green
  -> Post-deploy verification
  -> DORA metric recording
```

### Three-Repository Model

| Repository          | Purpose                                     | CI/CD Role                                      |
| ------------------- | ------------------------------------------- | ----------------------------------------------- |
| abl-platform        | Source code, Harness pipeline definitions   | Build, test, scan, push images                  |
| abl-platform-deploy | Helm charts, ArgoCD app-of-apps, env values | GitOps target for image tag promotion           |
| abl-platform-infra  | Terraform IaC for AKS, ACR, networking      | Infrastructure provisioning (out of scope here) |

### ArgoCD Sync Wave Ordering

```
Wave -1: External secrets, ConfigMaps, PVCs
Wave  0: DB migration Job (init container), seed data Job
Wave  1: Runtime, SearchAI, SearchAI-Runtime, Studio (core services)
Wave  2: Admin, Workflow Engine, Python services (dependent services)
Wave  3: Post-sync hook: smoke test Job that verifies /health endpoints
```

---

## 7. Technical Considerations (Optional)

- **Monorepo-aware CI**: The PR pipeline should use `turbo run test:fast --affected` to detect which packages have changed since the base branch and only run tests for those packages plus their dependents. This reduces PR pipeline time from ~15 minutes (full) to ~3-5 minutes (affected).
- **Docker layer caching**: The existing Harness `caching` block uses pnpm-lock.yaml checksum to cache `node_modules`. Docker builds should leverage BuildKit inline caching (`BUILDKIT_INLINE_CACHE=1`) and Harness cache intelligence for layer reuse across builds.
- **Image signing**: Production images should be signed with Cosign using a KMS-backed key. ArgoCD should verify signatures before syncing production applications.
- **Helm value promotion**: Environment promotion is a Git commit to the deploy repo that copies image tags from one values file to another (e.g., `values-dev.yaml` -> `values-staging.yaml`). This provides a full audit trail via Git history.
- **Database migration safety**: The init container (Dockerfile `init` stage) acquires a distributed MongoDB lock before running migrations, ensuring only one pod runs migrations during a rolling deployment. Migrations must be backward-compatible (additive-only) to support blue-green deployment where old and new versions coexist.
- **Argo Rollouts integration**: Argo Rollouts replaces the standard Kubernetes Deployment resource with a Rollout CRD. The Helm chart must be updated to conditionally render Rollout resources for services that use progressive delivery and standard Deployments for others.
- **Secret management**: Secrets must not be stored in Helm values files. Use Kubernetes External Secrets Operator (ESO) or Harness secret references to inject secrets at deployment time.

---

## 8. How to Consume

### Studio UI

No dedicated CI/CD management surface in Studio. Developers interact with the pipeline through:

- Git push / PR creation triggers pipeline execution automatically.
- Deployment status is visible in Harness UI.
- Post-deploy health is visible via existing platform health endpoints.

### API (Runtime)

No Runtime API changes. Runtime is a deployment target, not a CI/CD control plane. Health endpoints consumed by deployment verification:

| Method | Path            | Purpose                                               |
| ------ | --------------- | ----------------------------------------------------- |
| GET    | `/health`       | Liveness probe -- confirms Runtime process is running |
| GET    | `/health/ready` | Readiness probe -- confirms DB and Redis connectivity |

### API (Studio)

No Studio API changes. Studio is a deployment target. Health endpoint:

| Method | Path      | Purpose                                 |
| ------ | --------- | --------------------------------------- |
| GET    | `/health` | Next.js health check for readiness gate |

### Admin Portal

Future phase: deployment history and DORA metrics dashboard. Initially, operators use Harness UI and Grafana dashboards.

| Method | Path                              | Purpose                                |
| ------ | --------------------------------- | -------------------------------------- |
| GET    | `/api/admin/deployments`          | List deployment records (planned)      |
| GET    | `/api/admin/deployments/:id`      | Get deployment record detail (planned) |
| GET    | `/api/admin/metrics/dora`         | DORA metrics summary (planned)         |
| POST   | `/api/admin/deployments/rollback` | Trigger manual rollback (planned)      |

### Channel / SDK / Voice / A2A / MCP Integration

CI/CD pipeline is not channel-aware. All channels are affected equally by platform deployments. Progressive delivery (canary) routes traffic at the Kubernetes ingress level, not the channel level -- all channels see the same canary percentage.

---

## 9. Data Model

### Collections / Tables

```text
Collection: deployment_records
Purpose: Audit trail of all platform deployments across environments
Fields:
  - _id: string (UUID)
  - pipelineExecutionId: string (Harness execution ID)
  - pipelineType: enum ('ci-build', 'cd-promote', 'hotfix', 'rollback')
  - environment: enum ('dev', 'staging', 'production')
  - services: array of {
      name: string (e.g., 'runtime', 'studio'),
      imageTag: string (e.g., 'abc1234'),
      imageDigest: string (sha256 digest),
      previousTag: string (tag before this deployment)
    }
  - gitCommitSha: string (source commit)
  - gitBranch: string (source branch)
  - deployedBy: string (user or bot identity)
  - approvals: array of {
      approver: string,
      approvedAt: Date,
      environment: string
    }
  - status: enum ('pending', 'in_progress', 'succeeded', 'failed', 'rolled_back')
  - rollbackOf: string (reference to deployment_record._id if this is a rollback)
  - startedAt: Date
  - completedAt: Date
  - healthCheckResults: array of {
      service: string,
      endpoint: string,
      status: number,
      checkedAt: Date
    }
  - doraMetrics: {
      leadTimeSeconds: number (commit to deploy duration),
      isFailure: boolean (required rollback or hotfix)
    }
  - createdAt: Date
  - updatedAt: Date
Indexes:
  - { environment: 1, status: 1, createdAt: -1 }
  - { pipelineExecutionId: 1 } (unique)
  - { gitCommitSha: 1 }
  - { createdAt: -1 }
```

```text
Collection: approval_gates
Purpose: Track approval requirements and decisions for environment promotions
Fields:
  - _id: string (UUID)
  - deploymentRecordId: string (FK to deployment_records)
  - environment: enum ('staging', 'production')
  - requiredApprovers: number (1 for staging, 2 for production)
  - approverGroup: string (e.g., 'sre-team', 'release-managers')
  - approvals: array of {
      userId: string,
      decision: enum ('approved', 'rejected'),
      comment: string,
      decidedAt: Date
    }
  - status: enum ('pending', 'approved', 'rejected', 'expired')
  - expiresAt: Date (approval request TTL, default 24h)
  - createdAt: Date
  - updatedAt: Date
Indexes:
  - { deploymentRecordId: 1 }
  - { status: 1, expiresAt: 1 }
```

```text
Collection: dora_metrics_daily
Purpose: Pre-aggregated daily DORA metrics for dashboard queries
Fields:
  - _id: string (UUID)
  - date: Date (day boundary)
  - environment: enum ('dev', 'staging', 'production')
  - deploymentFrequency: number (deploys this day)
  - avgLeadTimeSeconds: number (average commit-to-deploy)
  - changeFailureRate: number (0.0-1.0 ratio)
  - avgRecoveryTimeSeconds: number (failure-to-fix average)
  - deploymentCount: number
  - failureCount: number
  - rollbackCount: number
  - createdAt: Date
  - updatedAt: Date
Indexes:
  - { environment: 1, date: -1 }
```

### Key Relationships

- `deployment_records` references Harness pipeline execution IDs for cross-linking with Harness execution history.
- `approval_gates` references `deployment_records` to track which deployment required which approvals.
- `dora_metrics_daily` is aggregated from `deployment_records` via a scheduled background job (daily at 00:05 UTC).
- `deployment_records.services[].previousTag` enables rollback by recording the known-good tag for each service.
- The deploy repo (`abl-platform-deploy`) Git history serves as the source of truth for what was deployed when; `deployment_records` is a queryable mirror for API and dashboard access.

---

## 10. Key Implementation Files

### Domain / Core Logic

| File                                                  | Purpose                                            |
| ----------------------------------------------------- | -------------------------------------------------- |
| `.harness/pipelines/ci-build.yaml`                    | Existing merge/CI pipeline (to be extended)        |
| `.harness/pipelines/pr-validation.yaml`               | PR validation pipeline (planned)                   |
| `.harness/pipelines/cd-promote.yaml`                  | Environment promotion pipeline (planned)           |
| `.harness/pipelines/hotfix.yaml`                      | Hotfix fast-track pipeline (planned)               |
| `.harness/templates/docker-build-node-app.yaml`       | Existing Docker build template for Node.js apps    |
| `.harness/templates/docker-build-python-service.yaml` | Existing Docker build template for Python services |
| `.harness/templates/docker-build-standalone-app.yaml` | Existing Docker build template for standalone apps |
| `.harness/templates/smoke-test.yaml`                  | Post-deploy smoke test template (planned)          |
| `.harness/templates/promote-environment.yaml`         | Helm value promotion template (planned)            |

### Routes / Handlers

| File                                    | Purpose                                        |
| --------------------------------------- | ---------------------------------------------- |
| `apps/admin/src/routes/deployments.ts`  | Admin API for deployment records (planned)     |
| `apps/admin/src/routes/dora-metrics.ts` | Admin API for DORA metrics dashboard (planned) |

### UI Components

| File                                 | Purpose                               |
| ------------------------------------ | ------------------------------------- |
| `apps/admin/src/pages/deployments/`  | Deployment history page (planned)     |
| `apps/admin/src/pages/metrics/dora/` | DORA metrics dashboard page (planned) |

### Jobs / Workers / Background Processes

| File                                | Purpose                                                |
| ----------------------------------- | ------------------------------------------------------ |
| `scripts/post-deploy-smoke-test.ts` | Smoke test script run as K8s Job post-deploy (planned) |
| `scripts/aggregate-dora-metrics.ts` | Daily DORA metrics aggregation job (planned)           |
| `scripts/notify-deployment.ts`      | Deployment notification dispatcher (planned)           |

### Tests

| File                                       | Type        | Coverage Focus                               |
| ------------------------------------------ | ----------- | -------------------------------------------- |
| `scripts/__tests__/smoke-test.test.ts`     | unit        | Smoke test script logic (planned)            |
| `scripts/__tests__/dora-metrics.test.ts`   | unit        | DORA metric aggregation logic (planned)      |
| `tests/e2e/deployment-lifecycle.test.ts`   | e2e         | Full deploy-promote-rollback cycle (planned) |
| `tests/e2e/pr-pipeline-validation.test.ts` | e2e         | PR pipeline gate enforcement (planned)       |
| `tests/integration/helm-promotion.test.ts` | integration | Helm value file promotion logic (planned)    |

---

## 11. Configuration

### Environment Variables

| Variable                              | Default                | Description                                                  |
| ------------------------------------- | ---------------------- | ------------------------------------------------------------ |
| `HARNESS_ACCOUNT_ID`                  | (required)             | Harness account identifier for API calls                     |
| `HARNESS_ORG_ID`                      | `default`              | Harness organization identifier                              |
| `HARNESS_PROJECT_ID`                  | `ABLPlatform`          | Harness project identifier                                   |
| `ACR_REGISTRY`                        | `acrabldev.azurecr.io` | Azure Container Registry URL                                 |
| `DEPLOY_REPO_URL`                     | (required)             | Git URL for abl-platform-deploy                              |
| `DEPLOY_REPO_BRANCH`                  | `main`                 | Branch in deploy repo to update                              |
| `ARGOCD_SERVER`                       | (required)             | ArgoCD server URL for sync triggers                          |
| `ARGOCD_APP_NAME`                     | `abl-platform-stack`   | ArgoCD application name for the stack chart                  |
| `CANARY_STEP_WEIGHTS`                 | `10,25,50,100`         | Canary traffic weights (comma-separated percentages)         |
| `CANARY_STEP_PAUSE_SECONDS`           | `300`                  | Pause duration at each canary step (5 minutes)               |
| `CANARY_ERROR_RATE_THRESHOLD`         | `0.05`                 | Error rate threshold for automatic rollback (5%)             |
| `CANARY_LATENCY_THRESHOLD_MULTIPLIER` | `2.0`                  | P99 latency multiplier over baseline for rollback            |
| `ROLLBACK_TIMEOUT_SECONDS`            | `300`                  | Maximum time for rollback to complete (5 minutes)            |
| `APPROVAL_EXPIRY_HOURS`               | `24`                   | Hours before an unanswered approval request expires          |
| `SMOKE_TEST_TIMEOUT_SECONDS`          | `120`                  | Timeout for post-deploy smoke test execution                 |
| `DORA_AGGREGATION_CRON`               | `0 5 0 * * *`          | Cron schedule for DORA metrics aggregation (00:05 UTC daily) |
| `NOTIFICATION_SLACK_WEBHOOK`          | (optional)             | Slack webhook URL for deployment notifications               |
| `NOTIFICATION_GCHAT_WEBHOOK`          | (optional)             | Google Chat webhook URL for deployment notifications         |
| `COSIGN_KMS_KEY`                      | (optional)             | KMS key reference for Cosign image signing (production only) |

### Runtime Configuration

- **Pipeline selection**: The `build_services` variable on `ci-build.yaml` allows selective builds (`all`, or comma-separated service names: `runtime`, `studio`, `admin`, `search-ai`, etc.).
- **Environment targeting**: CD pipeline accepts `target_environment` variable (`staging` or `production`).
- **Approval groups**: Configured in Harness as user groups (`sre-team`, `release-managers`). Staging requires 1 approval, production requires 2.
- **Feature flags**: `ENABLE_CANARY_DEPLOY` (default: false) gates Argo Rollouts canary behavior. When false, standard rolling update is used.
- **Rollback policy**: Automatic rollback is enabled by default for canary deployments. Can be overridden with `AUTO_ROLLBACK=false` for manual control.

### DSL / Agent IR / Schema

CI/CD pipeline is not configurable via ABL DSL. Pipeline definitions are Harness YAML stored in `.harness/` directory. Helm chart values are YAML files in the `abl-platform-deploy` repository. ArgoCD Application CRDs are stored in the deploy repo under `argocd/`.

---

## 12. Non-Functional Concerns

### Isolation & Multitenancy

| Concern               | Requirement / Expectation                                                                                                                                                       |
| --------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Project isolation     | CI/CD operates at the platform level, not the project level. All projects within a tenant share the same deployed platform version.                                             |
| Tenant isolation      | All tenants share the same platform deployment. Tenant isolation is enforced at the application layer (middleware, DB queries), not the deployment layer.                       |
| User isolation        | Deployment approvals are user-scoped (approver identity recorded). Deployment records are accessible only to platform operators with admin permissions.                         |
| Environment isolation | Dev, staging, and production environments are isolated Kubernetes namespaces (or clusters) with separate ArgoCD applications, separate Helm values, and separate secret stores. |

### Security & Compliance

- **Image signing**: Production images must be signed with Cosign. ArgoCD admission controller verifies signatures before allowing deployment to production namespace.
- **Vulnerability scanning**: Trivy scans all images for CRITICAL and HIGH vulnerabilities. Builds fail if unfixed CRITICAL vulnerabilities are found. SBOM (SPDX-JSON) is generated and stored alongside images.
- **Secret detection**: Gitleaks runs on every CI pipeline to detect committed secrets. Pipeline fails on critical severity findings.
- **SAST**: Semgrep runs with default ruleset, failing on critical findings. Custom rules for ABL-specific patterns (tenant isolation, auth middleware) via `run-semgrep.sh`.
- **RBAC**: Deployment approvals require membership in designated Harness user groups. Production deployments require 2 approvals from the `release-managers` group.
- **Audit trail**: Every deployment is recorded in `deployment_records` with full provenance (who, what, when, approval chain, outcome). Deploy repo Git history provides an immutable record.
- **Secret injection**: Secrets are injected via Kubernetes External Secrets Operator or Harness secret references. No secrets in Helm values files, environment variable files, or Docker images.

### Performance & Scalability

- **PR pipeline**: Target < 5 minutes for affected-only runs. Full run < 15 minutes.
- **Merge/CI pipeline**: Target < 20 minutes for full build + test + Docker build + push (all services).
- **Selective build**: Individual service build + push < 8 minutes.
- **Docker image size**: Runtime production image < 300 MB (distroless base). Studio image < 500 MB (Next.js + static assets).
- **Deployment time**: Dev auto-sync < 5 minutes from merge. Staging promotion < 15 minutes (including smoke tests). Production canary rollout < 30 minutes (4 steps at 5 minutes each + analysis).
- **Concurrent pipelines**: Harness infrastructure supports up to 5 concurrent pipeline executions on dedicated CI node pool.
- **Cache hit rate**: Target > 80% cache hit rate for Turbo remote cache and Docker layer cache.

### Reliability & Failure Modes

- **Pipeline failure**: All Harness stages have `failureStrategies` defined. Build/test failures abort the pipeline. Docker push failures mark the stage as failed but do not abort other parallel stages.
- **Deployment failure**: If ArgoCD sync fails, the Application stays in `OutOfSync` or `Degraded` state. No automatic rollback at the ArgoCD level -- rollback is handled by Argo Rollouts analysis or manual operator action.
- **Canary failure**: Argo Rollouts automatically rolls back if analysis fails (error rate > threshold or latency > threshold). Rollback restores the previous ReplicaSet to 100% traffic.
- **Migration failure**: Init container migration job failure prevents the service pods from starting (Kubernetes init container contract). Manual intervention required to fix migration and re-trigger sync.
- **Deploy repo conflict**: If multiple pipelines try to update the deploy repo simultaneously, Git push will fail. Retry with rebase (up to 3 attempts with exponential backoff).
- **Approval timeout**: Unapproved promotion requests expire after 24 hours. The deployment record is marked as `expired`.

### Observability

- **Pipeline metrics**: Harness provides built-in pipeline execution duration, success rate, and stage-level timing metrics.
- **DORA metrics**: Custom dashboard (Grafana or Admin portal) showing deployment frequency, lead time, change failure rate, and recovery time with environment filtering and time-range selection.
- **Deployment events**: Structured log events emitted for deployment start, promotion, approval, success, failure, and rollback. Indexed in ClickHouse for analytics.
- **Health checks**: Kubernetes liveness and readiness probes on all services. Probe failures trigger pod restarts (liveness) or traffic removal (readiness).
- **Argo Rollouts metrics**: Canary analysis integrates with Prometheus for error rate and latency queries. Analysis results are visible in Argo Rollouts dashboard.
- **Alerting**: PagerDuty/Slack alerts for: production deployment failure, rollback triggered, canary analysis failure, health check degradation lasting > 5 minutes.

### Data Lifecycle

- **Deployment records**: Retained for 1 year in MongoDB. Records older than 1 year are archived to cold storage (Azure Blob).
- **DORA metrics daily**: Retained indefinitely (small cardinality -- 1 record per day per environment).
- **Approval gates**: Retained with their parent deployment record (1 year).
- **Docker images**: ACR retention policy: `latest` and last 30 tagged images per repository. Images older than 90 days without a semver tag are auto-pruned.
- **SBOM artifacts**: Stored alongside images in ACR. Same retention policy as images.
- **Pipeline execution logs**: Retained in Harness for 90 days (Harness platform default).

---

## 13. Delivery Plan / Work Breakdown

1. PR Validation Pipeline
   1.1 Create `.harness/pipelines/pr-validation.yaml` with lint, typecheck, affected tests, and security scan stages
   1.2 Configure Turbo `--affected` flag for PR-scoped test execution
   1.3 Configure branch protection rules requiring PR pipeline pass for merge to `main`
   1.4 Add Harness trigger for pull request events

2. Merge/CI Pipeline Hardening
   2.1 Add Playwright E2E stage to existing `ci-build.yaml` (already implemented)
   2.2 Add coverage enforcement stage (already implemented)
   2.3 Add tenant isolation lint stage (already implemented)
   2.4 Add config policy validation stage (already implemented)
   2.5 Implement Turbo remote caching for cross-pipeline cache sharing
   2.6 Add image signing with Cosign for all pushed images

3. CD Promotion Pipeline
   3.1 Create `.harness/pipelines/cd-promote.yaml` with staging and production promotion stages
   3.2 Create `.harness/templates/promote-environment.yaml` for Helm value promotion logic
   3.3 Implement staging promotion with deploy repo value copy and ArgoCD sync trigger
   3.4 Implement approval gates with Harness approval steps (1 for staging, 2 for production)
   3.5 Create `values-staging.yaml` and `values-prod.yaml` in deploy repo

4. ArgoCD Sync Waves
   4.1 Add sync-wave annotations to Helm chart templates in deploy repo
   4.2 Configure init container (migration/seed) as Wave 0 PreSync hook
   4.3 Configure core services (Runtime, SearchAI, Studio) as Wave 1
   4.4 Configure dependent services (Admin, Python services) as Wave 2
   4.5 Create post-sync smoke test Job as Wave 3 PostSync hook

5. Progressive Delivery
   5.1 Install Argo Rollouts controller in all environments
   5.2 Update Helm chart to render Rollout CRDs for Runtime and SearchAI (canary strategy)
   5.3 Update Helm chart to render Rollout CRDs for Studio (blue-green strategy)
   5.4 Configure AnalysisTemplate for error rate and latency checks via Prometheus
   5.5 Test canary rollout and automatic rollback in dev environment

6. Smoke Tests and Health Verification
   6.1 Create `scripts/post-deploy-smoke-test.ts` with health endpoint checks and critical API flow verification
   6.2 Create `.harness/templates/smoke-test.yaml` Harness stage template
   6.3 Wire smoke tests into staging promotion pipeline and production post-deploy
   6.4 Add database migration status check to smoke test suite

7. Hotfix Pipeline
   7.1 Create `.harness/pipelines/hotfix.yaml` with abbreviated validation and direct staging promotion
   7.2 Configure Harness trigger for `hotfix/*` branch pushes
   7.3 Implement expedited approval flow (single approver, 15-minute SLA notification)

8. Deployment Records and DORA Metrics
   8.1 Create `deployment_records` MongoDB collection and Mongoose model
   8.2 Add pipeline webhook/notification to record deployment events
   8.3 Create `scripts/aggregate-dora-metrics.ts` for daily DORA metric computation
   8.4 Create Admin API endpoints for deployment history and DORA metrics
   8.5 Create Grafana dashboard for DORA metrics visualization

9. Notifications and Alerting
   9.1 Create `scripts/notify-deployment.ts` for Slack and Google Chat notifications
   9.2 Wire notification script into Harness pipeline stages (start, approval, success, failure, rollback)
   9.3 Configure PagerDuty integration for production failure alerts
   9.4 Implement weekly DORA metrics summary notification

---

## 14. Success Metrics

| Metric                       | Baseline                  | Target                                    | How Measured                                            |
| ---------------------------- | ------------------------- | ----------------------------------------- | ------------------------------------------------------- |
| Deployment frequency (prod)  | ~1/week (manual)          | >= 3/week                                 | `dora_metrics_daily.deploymentFrequency` for production |
| Change lead time             | ~2 days (estimate)        | < 4 hours (commit to production)          | `deployment_records.doraMetrics.leadTimeSeconds`        |
| Change failure rate          | Unknown                   | < 10%                                     | `dora_metrics_daily.changeFailureRate` for production   |
| Failed deploy recovery time  | ~1 hour (manual rollback) | < 15 minutes (automated rollback)         | Time from failure detection to rollback completion      |
| PR pipeline duration         | N/A (no PR pipeline)      | < 5 minutes (affected-only)               | Harness pipeline execution duration                     |
| Merge/CI pipeline duration   | ~25 minutes (current)     | < 20 minutes (full), < 10 min (selective) | Harness pipeline execution duration                     |
| Docker image vulnerability   | Not tracked               | 0 unfixed CRITICAL, < 5 HIGH per image    | Trivy scan results in pipeline artifacts                |
| Deployment audit coverage    | 0% (no records)           | 100% of deployments recorded              | `deployment_records` count vs Harness execution count   |
| Canary rollback success rate | N/A                       | 100% automatic rollback on failure        | Argo Rollouts rollback events / analysis failures       |
| Cache hit rate               | ~50% (pnpm cache only)    | > 80% (Turbo remote + Docker layer)       | Turbo cache stats, Harness cache intelligence metrics   |

---

## 15. Open Questions

1. Should the platform adopt Argo Rollouts for all services, or only for customer-facing services (Runtime, SearchAI, Studio)? Background services (Python services, workflow engine) may not benefit from canary deployments.
2. What is the right approval group structure? Should staging approvals be self-service (deployer can approve their own staging promotion) or require a different person?
3. Should the deploy repo (`abl-platform-deploy`) use a branch-per-environment model (`dev`, `staging`, `prod` branches) or a single branch with environment-specific values files? The current design uses a single branch with values files.
4. How should database migration backward compatibility be enforced? Should there be a CI check that validates migrations are additive-only (no column drops, no type changes)?
5. Should DORA metrics be computed from Harness API data, deploy repo Git history, or the custom `deployment_records` collection? Each has different accuracy and implementation complexity tradeoffs.
6. What is the image retention policy for production images? Should semver-tagged images be retained indefinitely for rollback capability?
7. Should the hotfix pipeline bypass staging and go directly to production with a canary rollout, or should it always pass through staging first (even with an expedited timeline)?

---

## 16. Gaps, Known Issues & Limitations

| ID      | Description                                                                                                                                     | Severity | Status |
| ------- | ----------------------------------------------------------------------------------------------------------------------------------------------- | -------- | ------ |
| GAP-001 | No PR validation pipeline exists. Pull requests can merge without automated quality gates.                                                      | High     | Open   |
| GAP-002 | No staging or production environment promotion pipeline. Deployments beyond dev are manual and unaudited.                                       | High     | Open   |
| GAP-003 | No automated rollback mechanism. Rollbacks require manual Helm value edits and ArgoCD force-sync.                                               | High     | Open   |
| GAP-004 | No progressive delivery (canary/blue-green). All deployments are full replacements, risking full-blast production incidents.                    | High     | Open   |
| GAP-005 | No DORA metrics tracking. Deployment frequency, lead time, failure rate, and recovery time are not measured.                                    | Medium   | Open   |
| GAP-006 | No post-deployment smoke tests. Deployment success is determined only by Kubernetes readiness probe, not application-level health verification. | Medium   | Open   |
| GAP-007 | No image signing. Docker images are pushed to ACR without cryptographic signature verification.                                                 | Medium   | Open   |
| GAP-008 | No hotfix fast-path pipeline. Critical production fixes follow the same pipeline as feature work, delaying resolution.                          | Medium   | Open   |
| GAP-009 | Deploy repo Git push conflicts when multiple pipelines run concurrently. No retry/rebase mechanism implemented.                                 | Medium   | Open   |
| GAP-010 | Turbo `--affected` not used in CI. All PR builds run the full test suite regardless of which packages changed.                                  | Low      | Open   |
| GAP-011 | Docker layer caching is partially configured (pnpm cache) but not fully optimized (no BuildKit cache export/import between builds).             | Low      | Open   |
| GAP-012 | No deployment notification system. Operators must check Harness UI to know deployment status.                                                   | Low      | Open   |

---

## 17. Testing & Validation

### Required Test Coverage

| #   | Scenario                                                                     | Coverage Type | Status     | Test File / Note                        |
| --- | ---------------------------------------------------------------------------- | ------------- | ---------- | --------------------------------------- |
| 1   | PR pipeline blocks merge on typecheck failure                                | e2e           | NOT TESTED | `.harness/pipelines/pr-validation.yaml` |
| 2   | Merge pipeline builds, tests, pushes images, and updates deploy repo         | e2e           | NOT TESTED | Harness CI execution verification       |
| 3   | Staging promotion copies correct image tags and triggers ArgoCD sync         | integration   | NOT TESTED | Helm value file manipulation logic      |
| 4   | Production canary rollout shifts traffic through configured weight steps     | e2e           | NOT TESTED | Argo Rollouts canary behavior           |
| 5   | Automatic rollback triggers when canary error rate exceeds threshold         | e2e           | NOT TESTED | Argo Rollouts analysis template         |
| 6   | Hotfix pipeline promotes from hotfix branch to production within SLA         | e2e           | NOT TESTED | `.harness/pipelines/hotfix.yaml`        |
| 7   | Post-deploy smoke tests verify health endpoints after successful deployment  | integration   | NOT TESTED | `scripts/post-deploy-smoke-test.ts`     |
| 8   | Deployment records capture full provenance for every deployment              | integration   | NOT TESTED | `deployment_records` collection writes  |
| 9   | DORA metrics aggregation computes correct daily metrics                      | unit          | NOT TESTED | `scripts/aggregate-dora-metrics.ts`     |
| 10  | ArgoCD sync waves execute in correct order (migrations before services)      | e2e           | NOT TESTED | Kubernetes event ordering verification  |
| 11  | Docker images pass Trivy scan with no unfixed CRITICAL vulnerabilities       | e2e           | NOT TESTED | Existing Trivy step in CI pipeline      |
| 12  | Approval gate blocks production deployment until required approvals received | e2e           | NOT TESTED | Harness approval step behavior          |

### Testing Notes

CI/CD pipeline testing is inherently infrastructure-level and requires real pipeline executions against real environments. Most scenarios cannot be unit-tested in isolation; they require end-to-end verification through Harness pipeline runs. The testing strategy relies on:

1. **Pipeline execution tests**: Run pipelines against a dedicated test environment and verify outcomes via Harness API.
2. **Helm value manipulation tests**: Unit test the `yq`-based value promotion logic independently.
3. **Smoke test script tests**: Unit test the smoke test runner logic with mocked HTTP responses.
4. **DORA metric aggregation tests**: Unit test the aggregation logic against fixture data.
5. **Canary behavior tests**: Validated through Argo Rollouts simulation mode and dev environment canary deployments.

> Full testing details: [docs/testing/cicd-pipeline.md](../testing/cicd-pipeline.md)

---

## 18. References

- Existing CI pipeline: `.harness/pipelines/ci-build.yaml`
- Harness stage templates: `.harness/templates/docker-build-node-app.yaml`, `docker-build-python-service.yaml`, `docker-build-standalone-app.yaml`
- Runtime Dockerfile (multi-stage): `apps/runtime/Dockerfile`
- Turbo config: `turbo.json`
- Related feature docs: [Deployments & Versioning](deployments-versioning.md), [Audit Logging](audit-logging.md), [Seed Data](seed-data.md), [Circuit Breaker](circuit-breaker.md), [Rate Limiting](rate-limiting.md), [Configuration Management](configuration-management.md), [Environment Variables](environment-variables.md)
- DORA metrics guide: [dora.dev/guides/dora-metrics](https://dora.dev/guides/dora-metrics/)
- Harness pipeline design guide: [developer.harness.io/docs/continuous-delivery/cd-onboarding/new-user/pipeline-design-guide](https://developer.harness.io/docs/continuous-delivery/cd-onboarding/new-user/pipeline-design-guide/)
- ArgoCD sync waves: [argo-cd.readthedocs.io/en/stable/user-guide/sync-waves](https://argo-cd.readthedocs.io/en/stable/user-guide/sync-waves/)
- Argo Rollouts canary: [argo-rollouts.readthedocs.io/en/stable/features/canary](https://argo-rollouts.readthedocs.io/en/stable/features/canary/)

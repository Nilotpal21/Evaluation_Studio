# Feature Test Guide: CI/CD Pipeline Definition

**Feature**: CI/CD pipeline orchestration across PR validation, merge/CI, deployment/CD, and hotfix pipelines
**Owner**: Platform team, DevOps team
**Branch**: develop
**Related Feature Doc**: [docs/features/cicd-pipeline.md](../features/cicd-pipeline.md)
**First audited**: 2026-03-23
**Last updated**: 2026-03-23
**Overall status**: NOT TESTED

---

## Current State (as of 2026-03-23)

The CI/CD pipeline system currently consists of a single Harness CI pipeline (`ci-build.yaml`) that handles merge builds, tests, Docker image construction, Trivy scanning, and deploy repo updates for the dev environment. No PR validation pipeline exists. No staging or production promotion pipelines exist. No progressive delivery, automated rollback, deployment approval gates, smoke tests, DORA metrics, or deployment recording infrastructure exists.

The existing `ci-build.yaml` pipeline is production-operational: it runs on every push to `main`, executes build + typecheck + config validation + tenant isolation lint + unit tests + integration tests + Playwright E2E + coverage enforcement + Docker builds (15 services in parallel) + Semgrep SAST + Gitleaks secret detection, pushes images to ACR, and updates the deploy repo for ArgoCD dev auto-sync. The pipeline uses 3 Harness stage templates to standardize Docker builds across Node.js apps, Python services, and standalone apps.

No testing infrastructure exists for the CI/CD pipeline itself. Pipeline behavior is validated manually through Harness execution monitoring.

### Quick Health Dashboard

| Area                                           | Status     | Last Verified    | Notes                                                                   |
| ---------------------------------------------- | ---------- | ---------------- | ----------------------------------------------------------------------- |
| Merge/CI pipeline execution                    | PASS       | production usage | Pipeline runs on every push to main; builds, tests, pushes ~15 services |
| Selective service build (`build_services` var) | PASS       | production usage | Operators can select specific services to build                         |
| Docker image build (Node.js apps)              | PASS       | production usage | Multi-stage build with distroless production image                      |
| Docker image build (Python services)           | PASS       | production usage | Build, Trivy scan, push for Python services                             |
| Trivy vulnerability scanning                   | PASS       | production usage | CRITICAL/HIGH scan with SBOM generation on all images                   |
| Semgrep SAST scanning                          | PASS       | production usage | Runs with default ruleset, fails on critical                            |
| Gitleaks secret detection                      | PASS       | production usage | Scans codebase for committed secrets                                    |
| Deploy repo image tag update                   | PASS       | production usage | Updates `values-dev.yaml` with new image tags via yq                    |
| Playwright E2E (Studio + Admin)                | PASS       | production usage | Runs against real servers with MongoDB + Redis sidecars                 |
| PR validation pipeline                         | NOT TESTED | --               | Pipeline does not exist yet                                             |
| Staging environment promotion                  | NOT TESTED | --               | No promotion pipeline exists                                            |
| Production environment promotion               | NOT TESTED | --               | No promotion pipeline exists                                            |
| Deployment approval gates                      | NOT TESTED | --               | No approval workflow exists                                             |
| Post-deploy smoke tests                        | NOT TESTED | --               | No smoke test infrastructure exists                                     |
| Progressive delivery (canary/blue-green)       | NOT TESTED | --               | Argo Rollouts not installed                                             |
| Automated rollback                             | NOT TESTED | --               | No rollback automation exists                                           |
| Hotfix pipeline                                | NOT TESTED | --               | No hotfix pipeline exists                                               |
| Deployment records                             | NOT TESTED | --               | No deployment recording infrastructure exists                           |
| DORA metrics                                   | NOT TESTED | --               | No DORA metrics computation exists                                      |
| ArgoCD sync waves                              | NOT TESTED | --               | Sync wave annotations not configured in Helm chart                      |
| Deployment notifications                       | NOT TESTED | --               | No notification system exists                                           |

---

## Coverage Matrix

| FR    | Description                                                        | Unit       | Integration | E2E        | Manual     | Status      |
| ----- | ------------------------------------------------------------------ | ---------- | ----------- | ---------- | ---------- | ----------- |
| FR-1  | PR validation (lint, typecheck, affected tests, security scan)     | NOT TESTED | NOT TESTED  | NOT TESTED | NOT TESTED | Not Started |
| FR-2  | Merge/CI full pipeline (build, test, Docker, scan, push, deploy)   | NOT TESTED | NOT TESTED  | PASS       | PASS       | Partial     |
| FR-3  | Docker image tagging (commitSha, date, latest, semver)             | NOT TESTED | NOT TESTED  | NOT TESTED | PASS       | Partial     |
| FR-4  | Selective service builds via `build_services` variable             | NOT TESTED | NOT TESTED  | NOT TESTED | PASS       | Partial     |
| FR-5  | Harness stage templates for Docker build standardization           | NOT TESTED | NOT TESTED  | NOT TESTED | PASS       | Partial     |
| FR-6  | Deploy repo Helm values update after image push                    | NOT TESTED | NOT TESTED  | NOT TESTED | PASS       | Partial     |
| FR-7  | ArgoCD sync waves (ordered deployment)                             | NOT TESTED | NOT TESTED  | NOT TESTED | NOT TESTED | Not Started |
| FR-8  | Staging promotion with smoke tests and approval gate               | NOT TESTED | NOT TESTED  | NOT TESTED | NOT TESTED | Not Started |
| FR-9  | Progressive delivery (canary for Runtime, blue-green for Studio)   | NOT TESTED | NOT TESTED  | NOT TESTED | NOT TESTED | Not Started |
| FR-10 | Automated rollback on health check or analysis failure             | NOT TESTED | NOT TESTED  | NOT TESTED | NOT TESTED | Not Started |
| FR-11 | Hotfix pipeline (abbreviated validation, direct staging promotion) | NOT TESTED | NOT TESTED  | NOT TESTED | NOT TESTED | Not Started |
| FR-12 | Deployment event recording in `deployment_records` collection      | NOT TESTED | NOT TESTED  | NOT TESTED | NOT TESTED | Not Started |
| FR-13 | DORA metrics computation and exposure                              | NOT TESTED | NOT TESTED  | NOT TESTED | NOT TESTED | Not Started |
| FR-14 | Deployment notifications (Slack, Google Chat)                      | NOT TESTED | NOT TESTED  | NOT TESTED | NOT TESTED | Not Started |
| FR-15 | Branch protection rules enforcement                                | NOT TESTED | NOT TESTED  | NOT TESTED | NOT TESTED | Not Started |

---

## E2E Test Scenarios (minimum 5)

### E2E-1: Full Deployment Lifecycle (dev -> staging -> production)

**Preconditions**: All three pipelines exist (ci-build, cd-promote). Dev, staging, and production environments configured with separate ArgoCD applications. Deploy repo has `values-dev.yaml`, `values-staging.yaml`, `values-prod.yaml`.

**Steps**:

1. Push a commit to `main` that modifies `apps/runtime/src/` (e.g., add a comment to a file).
2. Verify Harness `ci-build` pipeline triggers automatically.
3. Wait for pipeline to reach "Build and Test" stage -- verify unit tests, integration tests, and typecheck pass.
4. Wait for "Docker - Runtime" stage -- verify Docker image is built, Trivy scanned (no CRITICAL), and pushed to ACR with correct tags (`{sha7}`, `main-{YYYYMMDD}`, `latest`).
5. Wait for "Update Dev Deploy" stage -- verify deploy repo `values-dev.yaml` is updated with new image tag.
6. Verify ArgoCD auto-syncs dev environment -- Runtime pods restart with new image.
7. Verify Runtime `/health` returns 200 in dev.
8. Trigger `cd-promote` pipeline targeting staging -- verify it copies the Runtime image tag from `values-dev.yaml` to `values-staging.yaml`.
9. Verify approval gate activates -- approve with 1 approver.
10. Wait for staging ArgoCD sync -- verify Runtime `/health` returns 200 in staging.
11. Verify post-staging smoke tests pass.
12. Trigger `cd-promote` pipeline targeting production -- verify it copies tags from `values-staging.yaml` to `values-prod.yaml`.
13. Verify approval gate requires 2 approvals -- approve with 2 different approvers.
14. Wait for production deployment -- verify Runtime `/health` returns 200 in production.
15. Verify `deployment_records` collection contains records for all three environment deployments with correct provenance (services, tags, approvers, timestamps).

**Expected Result**: A code change flows through dev -> staging -> production with automated builds, security scans, approval gates, and health verification at each stage. Full audit trail exists in deployment records and deploy repo Git history.

**Isolation Check**: Deployment to one environment does not affect other environments. Staging deployment does not modify dev or production values.

---

### E2E-2: Automated Rollback on Canary Failure

**Preconditions**: Argo Rollouts installed in dev environment. Runtime Helm chart renders Rollout CRD with canary strategy (10% -> 25% -> 50% -> 100%). AnalysisTemplate configured to query Prometheus for error rate. Prometheus metrics endpoint accessible.

**Steps**:

1. Deploy a known-good Runtime version to dev via ci-build pipeline. Verify all pods healthy.
2. Record the current Runtime image tag as `GOOD_TAG`.
3. Deploy a deliberately faulty Runtime version (e.g., one that returns 500 on `/api/v1/agents` for 20% of requests).
4. Verify Argo Rollouts creates a canary ReplicaSet with 10% traffic weight.
5. Send 100 requests to `/api/v1/agents` -- verify approximately 10 hit the canary (some return 500).
6. Wait for the AnalysisRun to evaluate error rate -- expect error rate > 5% threshold.
7. Verify Argo Rollouts aborts the rollout and scales canary ReplicaSet to 0.
8. Verify all traffic returns to the stable (known-good) ReplicaSet.
9. Send 100 requests to `/api/v1/agents` -- verify all return 200.
10. Verify the Rollout resource status shows `Degraded` with analysis failure reason.
11. Verify `deployment_records` contains an entry with `status: 'rolled_back'` and `doraMetrics.isFailure: true`.
12. Verify rollback completed within 5 minutes of failure detection.

**Expected Result**: Canary deployment with a faulty version is automatically rolled back when the error rate exceeds the threshold. No sustained production impact. Rollback is recorded as a deployment failure for DORA metrics.

**Isolation Check**: Canary rollback does not affect other services deployed alongside Runtime.

---

### E2E-3: Canary Progressive Delivery (Happy Path)

**Preconditions**: Argo Rollouts installed. Runtime Rollout CRD with canary strategy. Prometheus metrics available. Good Runtime version deployed as stable.

**Steps**:

1. Deploy a new Runtime version that passes all health checks and has normal error rates.
2. Verify Argo Rollouts creates canary ReplicaSet with initial weight (10%).
3. Wait for first analysis pause (5 minutes) -- verify AnalysisRun succeeds (error rate < 5%).
4. Verify traffic weight advances to 25%.
5. Wait for second analysis pause -- verify AnalysisRun succeeds.
6. Verify traffic weight advances to 50%.
7. Wait for third analysis pause -- verify AnalysisRun succeeds.
8. Verify traffic weight advances to 100% and old ReplicaSet scales to 0.
9. Verify Rollout status shows `Healthy`.
10. Verify all Runtime pods are running the new version.
11. Verify `deployment_records` contains an entry with `status: 'succeeded'` and `doraMetrics.leadTimeSeconds` populated.

**Expected Result**: A healthy canary deployment progresses through all weight steps and completes promotion to 100%. Each step is validated by Prometheus analysis.

**Isolation Check**: N/A (single service canary progression).

---

### E2E-4: Hotfix Pipeline End-to-End

**Preconditions**: Hotfix pipeline (`hotfix.yaml`) exists. Production environment has a known-good deployment. A critical bug is identified that requires immediate fix.

**Steps**:

1. Create a `hotfix/fix-critical-bug` branch from `main`.
2. Commit a fix to `apps/runtime/src/routes/chat.ts` on the hotfix branch.
3. Push the hotfix branch -- verify Harness `hotfix` pipeline triggers automatically.
4. Verify pipeline runs abbreviated validation: typecheck for Runtime, affected tests for Runtime, Semgrep SAST, Gitleaks.
5. Verify pipeline skips: full monorepo build, Playwright E2E, coverage enforcement, unrelated service Docker builds.
6. Verify only Runtime Docker image is built, scanned, and pushed.
7. Verify pipeline promotes directly to staging by updating `values-staging.yaml` with the hotfix image tag.
8. Verify staging smoke tests run and pass.
9. Verify expedited approval notification is sent with "HOTFIX - 15min SLA" urgency.
10. Approve with single approver within 15 minutes.
11. Verify pipeline promotes to production by updating `values-prod.yaml`.
12. Verify production deployment succeeds (canary or rolling, depending on configuration).
13. Verify total time from hotfix push to production deployment is < 30 minutes.
14. Verify `deployment_records` entry has `pipelineType: 'hotfix'`.

**Expected Result**: A critical fix is deployed from hotfix branch to production within 30 minutes, with security scanning maintained but non-essential validation skipped for speed.

**Isolation Check**: Hotfix deployment does not affect services other than the one being fixed.

---

### E2E-5: Multi-Service Coordinated Deployment

**Preconditions**: CI pipeline configured for full build (`build_services=all`). Deploy repo values file has consistent image tags across services. All services healthy in dev.

**Steps**:

1. Push a commit to `main` that modifies files in `packages/shared/` (affects Runtime, SearchAI, Studio, Admin as dependents).
2. Verify Harness `ci-build` pipeline triggers with `build_services=all`.
3. Verify all service Docker builds execute in parallel (Docker - Runtime, Docker - Studio, Docker - Search AI, Docker - Admin, etc.).
4. Verify all images are tagged with the same commit SHA.
5. Verify "Update Dev Deploy" stage sets `global.image.tag` in `values-dev.yaml` (not per-service overrides).
6. Verify ArgoCD syncs all services with the new global tag.
7. Verify ArgoCD respects sync wave ordering:
   a. Wave 0: Init container (migration/seed) completes first.
   b. Wave 1: Runtime, SearchAI, Studio start after migrations complete.
   c. Wave 2: Admin, Python services start after core services are ready.
   d. Wave 3: Post-deploy smoke test Job runs after all services are deployed.
8. Verify all services return 200 on their `/health` endpoints.
9. Verify per-service image overrides are cleared (no stale per-service tags from previous selective builds).
10. Verify `deployment_records` entry lists all deployed services with matching image tags.

**Expected Result**: A shared-package change triggers a coordinated multi-service deployment with correct sync ordering, consistent image tags, and post-deploy verification.

**Isolation Check**: Per-service tag overrides from previous selective builds are cleared when a full build runs.

---

### E2E-6: Selective Build and Deploy

**Preconditions**: Dev environment has services running at different image tags (from previous selective builds). CI pipeline is invoked with `build_services=runtime,search-ai`.

**Steps**:

1. Trigger Harness `ci-build` pipeline with `build_services=runtime,search-ai`.
2. Verify "Build and Test" stage runs selective build: `pnpm turbo build --filter=@agent-platform/runtime --filter=@agent-platform/search-ai`.
3. Verify unit tests run only for Runtime and SearchAI: `pnpm turbo test:fast --filter=@agent-platform/runtime --filter=@agent-platform/search-ai`.
4. Verify only "Docker - Runtime" and "Docker - Search AI" stages execute. All other Docker stages are skipped.
5. Verify skipped stages show "SKIPPED" in Harness execution (not "FAILED").
6. Verify "Update Dev Deploy" stage sets per-service overrides: `runtime.image.tag` and `searchAi.image.tag` in `values-dev.yaml`.
7. Verify global tag is NOT modified.
8. Verify ArgoCD syncs only Runtime and SearchAI pods (other services retain their existing image tags).
9. Verify Runtime and SearchAI `/health` return 200 with new image version.
10. Verify Studio and Admin are unaffected (same pods, same image tags as before).

**Expected Result**: Selective build compiles, tests, builds, and deploys only the specified services without affecting others. Pipeline skips unrelated stages efficiently.

**Isolation Check**: Services not included in `build_services` are not rebuilt, re-pushed, or re-deployed.

---

### E2E-7: Deploy Repo Conflict Resolution

**Preconditions**: Two pipelines are triggered near-simultaneously for different selective builds (e.g., Pipeline A builds `runtime`, Pipeline B builds `studio`).

**Steps**:

1. Trigger Pipeline A with `build_services=runtime`.
2. Trigger Pipeline B with `build_services=studio` within 30 seconds of Pipeline A.
3. Both pipelines proceed through build/test/Docker stages in parallel.
4. Both pipelines reach "Update Dev Deploy" stage approximately simultaneously.
5. One pipeline (say Pipeline A) successfully pushes to deploy repo first.
6. Pipeline B's git push fails due to conflict (deploy repo has changed).
7. Verify Pipeline B retries with git pull --rebase (up to 3 attempts).
8. Verify Pipeline B successfully pushes after rebase, preserving both Runtime and Studio tag updates.
9. Verify `values-dev.yaml` contains correct tags for both Runtime and Studio.
10. Verify ArgoCD syncs both services correctly.

**Expected Result**: Concurrent deploy repo updates are resolved via retry-with-rebase, ensuring both pipeline updates are preserved.

**Isolation Check**: One pipeline's deploy repo update does not overwrite another's changes.

---

## Integration Test Scenarios (minimum 5)

### INT-1: Helm Value Promotion Logic

**Boundary**: `yq`-based value promotion script that copies image tags between environment values files.

**Setup**: Create test `values-dev.yaml` and `values-staging.yaml` files with known initial values.

**Steps**:

1. Set `values-dev.yaml` with `abl-platform.global.image.tag: "abc1234"` and per-service override `abl-platform.runtime.image.tag: "def5678"`.
2. Run promotion script targeting staging.
3. Assert `values-staging.yaml` now has `abl-platform.global.image.tag: "abc1234"`.
4. Assert per-service override `abl-platform.runtime.image.tag: "def5678"` is also copied.
5. Assert other values in `values-staging.yaml` (non-image values like resource limits, replica counts) are NOT modified.
6. Run promotion script again with no changes -- assert `values-staging.yaml` is unchanged (idempotent).

**Expected Result**: Image tags are correctly copied between environment values files without affecting non-image configuration.

**Failure Mode**: If `yq` path expressions are incorrect, wrong values are modified or values are lost.

---

### INT-2: Deployment Record Creation and Querying

**Boundary**: Mongoose model for `deployment_records` + Admin API endpoints.

**Setup**: MongoDB instance (real or in-memory). Deployment record Mongoose model imported.

**Steps**:

1. Create a deployment record: `{ pipelineType: 'ci-build', environment: 'dev', services: [{ name: 'runtime', imageTag: 'abc1234', previousTag: 'xyz9876' }], status: 'in_progress', deployedBy: 'ci-bot' }`.
2. Assert record is created with `_id`, `createdAt`, `updatedAt`.
3. Update record status to `succeeded` and set `completedAt`.
4. Query records by environment: `GET /api/admin/deployments?environment=dev`.
5. Assert response contains the created record.
6. Query records by date range: `GET /api/admin/deployments?from=2026-03-23&to=2026-03-24`.
7. Assert response filters correctly.
8. Create a rollback record referencing the first deployment: `{ pipelineType: 'rollback', rollbackOf: firstRecord._id, status: 'succeeded' }`.
9. Query the first record -- verify it can resolve its rollback reference.

**Expected Result**: Deployment records are correctly created, updated, queried, and cross-referenced.

**Failure Mode**: If indexes are missing, queries over large datasets will be slow.

---

### INT-3: DORA Metrics Aggregation

**Boundary**: `aggregate-dora-metrics.ts` script + `dora_metrics_daily` collection.

**Setup**: Seed `deployment_records` with fixture data spanning 7 days:

- Day 1: 3 successful deploys to production (lead times: 3600s, 7200s, 5400s).
- Day 2: 2 successful deploys, 1 failed deploy (required rollback).
- Day 3: 0 deploys.
- Day 4: 1 hotfix deploy (lead time: 1800s, recovery from Day 2 failure: 43200s).

**Steps**:

1. Run aggregation script for the date range.
2. Assert Day 1 metrics: `deploymentFrequency: 3`, `avgLeadTimeSeconds: 5400`, `changeFailureRate: 0`, `rollbackCount: 0`.
3. Assert Day 2 metrics: `deploymentFrequency: 3`, `changeFailureRate: 0.333` (1 failure / 3 deploys), `failureCount: 1`.
4. Assert Day 3 metrics: `deploymentFrequency: 0`, all other metrics zero or null.
5. Assert Day 4 metrics: `deploymentFrequency: 1`, `avgRecoveryTimeSeconds: 43200`, `avgLeadTimeSeconds: 1800`.
6. Assert weekly summary: total deployments = 7, avg frequency = 1/day, overall failure rate = 1/7 = 14.3%.

**Expected Result**: DORA metrics are correctly computed from deployment records with proper handling of zero-deploy days and recovery time calculations.

**Failure Mode**: If rollback reference resolution fails, recovery time cannot be computed.

---

### INT-4: Post-Deploy Smoke Test Script

**Boundary**: `post-deploy-smoke-test.ts` script.

**Setup**: Mock HTTP server simulating service health endpoints.

**Steps**:

1. Configure smoke test with endpoints: `[{ service: 'runtime', url: 'http://localhost:3112/health' }, { service: 'search-ai', url: 'http://localhost:3005/health' }, { service: 'studio', url: 'http://localhost:5173/health' }]`.
2. Start mock servers: Runtime returns 200, SearchAI returns 200, Studio returns 200.
3. Run smoke test script -- assert exit code 0 (all healthy).
4. Stop SearchAI mock (connection refused).
5. Run smoke test script -- assert exit code 1 (failure).
6. Assert output identifies SearchAI as the failing service.
7. Start SearchAI mock returning 503.
8. Run smoke test script -- assert exit code 1 (non-200 response).
9. Assert output includes HTTP status code and service name.
10. Configure timeout = 2 seconds. Start Runtime mock with 5-second delay.
11. Run smoke test script -- assert exit code 1 (timeout).
12. Assert output identifies Runtime as timed out.

**Expected Result**: Smoke test script correctly reports pass/fail for each service with clear failure reasons.

**Failure Mode**: If timeout is too aggressive, transient startup delays cause false failures.

---

### INT-5: ArgoCD Application Sync Verification

**Boundary**: ArgoCD API client + Helm chart sync wave annotations.

**Setup**: ArgoCD server (or mock) with an Application configured for the dev environment. Helm chart templates with sync-wave annotations.

**Steps**:

1. Render Helm chart templates with `helm template` command.
2. Assert init-container Job has annotation `argocd.argoproj.io/sync-wave: "0"`.
3. Assert Runtime Deployment/Rollout has annotation `argocd.argoproj.io/sync-wave: "1"`.
4. Assert SearchAI Deployment/Rollout has annotation `argocd.argoproj.io/sync-wave: "1"`.
5. Assert Studio Deployment/Rollout has annotation `argocd.argoproj.io/sync-wave: "1"`.
6. Assert Admin Deployment has annotation `argocd.argoproj.io/sync-wave: "2"`.
7. Assert Python service Deployments have annotation `argocd.argoproj.io/sync-wave: "2"`.
8. Assert post-deploy smoke test Job has annotation `argocd.argoproj.io/sync-wave: "3"` and `argocd.argoproj.io/hook: PostSync`.
9. Assert ExternalSecret resources have annotation `argocd.argoproj.io/sync-wave: "-1"`.

**Expected Result**: Helm chart templates render correct sync-wave annotations ensuring ordered deployment.

**Failure Mode**: Missing annotations cause all resources to deploy in Wave 0 simultaneously, potentially causing migration races.

---

### INT-6: Deployment Notification Dispatch

**Boundary**: `notify-deployment.ts` script with Slack and Google Chat webhook integration.

**Setup**: Mock webhook endpoints capturing POST requests.

**Steps**:

1. Configure notification with Slack and Google Chat webhook URLs pointing to mock servers.
2. Trigger "deployment started" notification for Runtime to staging.
3. Assert Slack webhook received POST with payload containing: service name, environment, image tag, timestamp, pipeline link.
4. Assert Google Chat webhook received POST with equivalent payload in Google Chat card format.
5. Trigger "approval required" notification for production promotion.
6. Assert notification includes: list of services, required approver count, approval link, expiry time.
7. Trigger "deployment failed" notification with error details.
8. Assert notification includes: failure reason, affected services, rollback status.
9. Trigger "rollback completed" notification.
10. Assert notification includes: rolled-back-from tag, rolled-back-to tag, recovery time.
11. Configure only Slack webhook (no Google Chat) -- verify only Slack receives notifications.
12. Configure neither webhook -- verify script exits successfully without sending (no error).

**Expected Result**: Notifications are correctly formatted and dispatched to configured channels. Missing channels are handled gracefully.

**Failure Mode**: Webhook failures should be logged but not block pipeline execution.

---

### INT-7: Docker Image Tag Generation and Verification

**Boundary**: Image tag generation logic in pipeline and ACR image verification.

**Setup**: Access to ACR (or mock registry API).

**Steps**:

1. Given commit SHA `abcdef1234567890`, verify generated tags:
   - `IMAGE_TAG` = `abcdef1` (first 7 chars).
   - `IMAGE_TAG_DATE` = `main-20260323` (current date).
2. Push image to ACR with these tags plus `latest`.
3. Query ACR for repository `abl-runtime` tags.
4. Assert all three tags exist and point to the same image digest.
5. For a production promotion, verify additional `v1.2.3` semver tag is applied.
6. Verify OCI labels on the image:
   - `org.opencontainers.image.source` = repo URL.
   - `org.opencontainers.image.revision` = full commit SHA.

**Expected Result**: Images are tagged consistently and OCI labels provide traceability back to source.

**Failure Mode**: Tag collision if two different commits on the same day use the date-based tag (mitigated by SHA tag being the primary identifier).

---

## Unit Test Scenarios

### UNIT-1: DORA Metric Calculation - Change Failure Rate

**Module**: DORA metrics aggregation logic.

**Input**: Array of deployment records for one day: `[{ status: 'succeeded' }, { status: 'succeeded' }, { status: 'rolled_back' }, { status: 'succeeded' }, { status: 'failed' }]`.

**Expected Output**: `changeFailureRate = 2/5 = 0.4` (both rolled_back and failed count as failures).

---

### UNIT-2: DORA Metric Calculation - Lead Time

**Module**: DORA metrics aggregation logic.

**Input**: Deployment record with `gitCommitSha` whose commit timestamp is `2026-03-23T10:00:00Z` and `completedAt: 2026-03-23T14:30:00Z`.

**Expected Output**: `leadTimeSeconds = 16200` (4.5 hours).

---

### UNIT-3: Smoke Test Health Check Parser

**Module**: `post-deploy-smoke-test.ts` result parser.

**Input**: HTTP responses: `[{ service: 'runtime', status: 200, body: '{"status":"ok"}' }, { service: 'search-ai', status: 503, body: '{"status":"degraded"}' }]`.

**Expected Output**: `{ passed: false, results: [{ service: 'runtime', healthy: true }, { service: 'search-ai', healthy: false, reason: 'HTTP 503' }] }`.

---

### UNIT-4: Selective Build Filter Construction

**Module**: Build script `build_services` parsing logic.

**Input**: `build_services = "runtime,search-ai,admin"`.

**Expected Output**: Turbo filter flags: `--filter=@agent-platform/runtime --filter=@agent-platform/search-ai --filter=@agent-platform/admin`. Python services excluded from Node.js build.

---

### UNIT-5: Deploy Repo yq Value Path Resolution

**Module**: Helm value update script service-name-to-yq-path mapping.

**Input**: Service name `search-ai-runtime`.

**Expected Output**: yq path `.abl-platform.searchAiRuntime.image.tag`. Verify all 15 service name mappings resolve correctly.

---

## Security & Isolation Tests

- [ ] **SEC-1**: Trivy scan blocks image push when unfixed CRITICAL vulnerability is present in base image
- [ ] **SEC-2**: Gitleaks blocks pipeline when a secret pattern (e.g., `AKIA*` AWS key) is found in committed code
- [ ] **SEC-3**: Semgrep blocks pipeline on critical severity finding (e.g., SQL injection pattern)
- [ ] **SEC-4**: Production deployment requires 2 approvals from `release-managers` group -- single approval does not proceed
- [ ] **SEC-5**: Non-member of approval group cannot approve production deployments
- [ ] **SEC-6**: Deploy repo SSH key is not exposed in pipeline logs or step outputs
- [ ] **SEC-7**: Docker images use non-root user (`USER nonroot` for distroless, `USER node` for slim)
- [ ] **SEC-8**: No secrets are stored in Helm values files (verified by secret detection scan on deploy repo)
- [ ] **SEC-9**: Cosign signature verification rejects unsigned images in production ArgoCD application (planned)
- [ ] **SEC-10**: Branch protection prevents direct push to `main` without PR and CI checks

---

## Performance & Load Tests

- [ ] **PERF-1**: PR validation pipeline completes in < 5 minutes for a change affecting a single package
- [ ] **PERF-2**: Full merge/CI pipeline completes in < 20 minutes (build + test + Docker + scan + push + deploy repo update)
- [ ] **PERF-3**: Selective build for a single service completes in < 8 minutes (build + test + Docker + push)
- [ ] **PERF-4**: Docker image size: Runtime production < 300 MB, Studio production < 500 MB
- [ ] **PERF-5**: Turbo cache hit rate > 80% for consecutive builds with no source changes
- [ ] **PERF-6**: Canary rollout completes full promotion (10% -> 100%) within 25 minutes
- [ ] **PERF-7**: Automated rollback completes within 5 minutes of failure detection
- [ ] **PERF-8**: Deploy repo update (clone + yq + commit + push) completes in < 60 seconds
- [ ] **PERF-9**: Smoke test suite completes all health checks within 2 minutes

---

## Test Infrastructure

- **Required services**: Harness CI/CD platform, ArgoCD server, Argo Rollouts controller, ACR, Kubernetes cluster (AKS), MongoDB, Redis, Prometheus (for canary analysis).
- **Environments**: Dedicated test environment (separate from dev/staging/prod) for pipeline validation, or use dev environment for non-destructive tests.
- **Data seeding**: Deployment records seeded via direct MongoDB insert for unit/integration tests. E2E tests create records through actual pipeline execution.
- **Test triggers**: E2E tests require triggering Harness pipelines via API (`POST /pipeline/api/pipeline/execute/{pipelineIdentifier}`).
- **Cleanup**: After E2E tests, revert deploy repo changes and scale down any test-created ArgoCD Applications.
- **CI configuration**: Pipeline E2E tests should run in a separate Harness pipeline (meta-pipeline) that tests the other pipelines. Circular dependency is avoided by running meta-pipeline manually or on a schedule.

---

## Test File Mapping

| Test File                                                | Type        | Covers                                |
| -------------------------------------------------------- | ----------- | ------------------------------------- |
| `scripts/__tests__/smoke-test.test.ts` (PLANNED)         | unit        | FR-8 (smoke test logic)               |
| `scripts/__tests__/dora-metrics.test.ts` (PLANNED)       | unit        | FR-13 (DORA aggregation)              |
| `scripts/__tests__/notify-deployment.test.ts` (PLANNED)  | unit        | FR-14 (notification dispatch)         |
| `tests/integration/helm-promotion.test.ts` (PLANNED)     | integration | FR-6, FR-8 (value promotion)          |
| `tests/integration/deployment-records.test.ts` (PLANNED) | integration | FR-12 (deployment record CRUD)        |
| `tests/integration/sync-waves.test.ts` (PLANNED)         | integration | FR-7 (Helm template sync annotations) |
| `tests/e2e/deployment-lifecycle.test.ts` (PLANNED)       | e2e         | FR-2, FR-6, FR-8 (full lifecycle)     |
| `tests/e2e/canary-rollback.test.ts` (PLANNED)            | e2e         | FR-9, FR-10 (canary + rollback)       |
| `tests/e2e/hotfix-pipeline.test.ts` (PLANNED)            | e2e         | FR-11 (hotfix fast-path)              |
| `tests/e2e/selective-build.test.ts` (PLANNED)            | e2e         | FR-4 (selective service builds)       |
| `tests/e2e/multi-service-deploy.test.ts` (PLANNED)       | e2e         | FR-7 (sync waves + multi-service)     |

---

## Open Testing Questions

1. How should E2E pipeline tests be triggered? Harness API pipeline execution requires authentication and may have rate limits. A meta-pipeline approach avoids direct API calls but adds complexity.
2. Should canary rollback E2E tests use a real faulty image or a test double that returns errors? Real faulty images require building and pushing a "bad" image as part of the test setup.
3. How should deploy repo changes from E2E tests be cleaned up? Options: (a) revert commit after test, (b) use a test-only branch in deploy repo, (c) use a mock deploy repo.
4. Should performance benchmarks (pipeline duration, image size) be enforced as CI gates or tracked as advisory metrics?
5. What is the minimum Prometheus retention required for canary analysis to have historical baseline data?

---

## Test Coverage Map

### Pipeline Execution

- [ ] PR pipeline blocks merge on lint failure
- [ ] PR pipeline blocks merge on typecheck failure
- [ ] PR pipeline blocks merge on test failure
- [ ] PR pipeline blocks merge on security scan critical finding
- [ ] Merge pipeline runs full build and test suite
- [ ] Merge pipeline builds Docker images for all services in parallel
- [ ] Merge pipeline pushes images to ACR with correct tags
- [ ] Merge pipeline updates deploy repo with correct values
- [ ] Selective build skips unrelated services
- [ ] Selective build runs tests only for selected packages

### Environment Promotion

- [ ] Dev deployment auto-syncs after deploy repo update
- [ ] Staging promotion copies correct image tags from dev values
- [ ] Staging approval gate requires configured approver count
- [ ] Production promotion copies correct image tags from staging values
- [ ] Production approval gate requires 2 approvals
- [ ] Approval expiry marks deployment as expired after 24 hours

### Progressive Delivery

- [ ] Canary rollout creates correct ReplicaSet weights (10%, 25%, 50%, 100%)
- [ ] Canary analysis queries Prometheus for error rate at each step
- [ ] Canary auto-promotes when analysis succeeds at all steps
- [ ] Canary auto-rolls-back when analysis fails at any step
- [ ] Blue-green deployment switches traffic after readiness verification
- [ ] Rollback completes within 5 minutes

### Deployment Recording

- [ ] Every pipeline execution creates a deployment record
- [ ] Deployment record captures all services and image tags
- [ ] Deployment record captures approval chain
- [ ] Rollback records reference the original deployment
- [ ] DORA metrics are aggregated daily from deployment records
- [ ] Admin API exposes deployment history with filtering

### What the Current Coverage Actually Proves

- [x] The existing merge/CI pipeline successfully builds, tests, scans, and pushes images for all services
- [x] Selective service builds work correctly via the `build_services` variable
- [x] Trivy scanning catches vulnerabilities and generates SBOMs
- [x] Semgrep and Gitleaks run and fail on critical findings
- [x] Deploy repo updates correctly set image tags via yq
- [ ] No PR validation exists -- PRs can merge without CI checks
- [ ] No environment promotion beyond dev is automated
- [ ] No progressive delivery or automated rollback exists
- [ ] No deployment audit trail exists
- [ ] No DORA metrics are tracked

---

## Pending / Future Work

- [ ] Create PR validation pipeline (`pr-validation.yaml`)
- [ ] Implement Turbo `--affected` for PR-scoped test execution
- [ ] Create CD promotion pipeline (`cd-promote.yaml`)
- [ ] Create staging and production values files in deploy repo
- [ ] Install Argo Rollouts in all environments
- [ ] Update Helm charts with Rollout CRDs and sync-wave annotations
- [ ] Create post-deploy smoke test script and Harness template
- [ ] Create deployment records MongoDB model and Admin API
- [ ] Create DORA metrics aggregation job and dashboard
- [ ] Create deployment notification system
- [ ] Create hotfix pipeline
- [ ] Implement image signing with Cosign
- [ ] Configure branch protection rules on all repositories
- [ ] Build meta-pipeline for E2E testing of pipelines themselves

---

## References

- Related feature doc: [docs/features/cicd-pipeline.md](../features/cicd-pipeline.md)
- Existing CI pipeline: `.harness/pipelines/ci-build.yaml`
- Harness stage templates: `.harness/templates/docker-build-node-app.yaml`
- Runtime Dockerfile: `apps/runtime/Dockerfile`
- Turbo config: `turbo.json`
- DORA metrics guide: [dora.dev/guides/dora-metrics](https://dora.dev/guides/dora-metrics/)
- ArgoCD sync waves: [argo-cd.readthedocs.io/en/stable/user-guide/sync-waves](https://argo-cd.readthedocs.io/en/stable/user-guide/sync-waves/)
- Argo Rollouts: [argo-rollouts.readthedocs.io](https://argo-rollouts.readthedocs.io/)

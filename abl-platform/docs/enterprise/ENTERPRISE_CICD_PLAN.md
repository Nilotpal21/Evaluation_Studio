# ABL Platform: Infrastructure, CI/CD & Cloud Deployment Plan

## Context

The ABL Platform is a pnpm monorepo (14 packages, 4 apps) with existing Helm charts, ArgoCD GitOps, External Secrets Operator integration, and multi-stage Dockerfiles already in place. This plan replaces GitHub Actions with **Harness SaaS (CI module only)**, migrates source control to **Bitbucket Cloud**, provisions cloud infrastructure on **Azure** via **OpenTofu**, and uses **ArgoCD natively** for continuous deployment.

**CI Platform**: Harness SaaS (CI module) + Delegates in target clusters
**CD Platform**: ArgoCD (native GitOps — no Harness CD)
**IaC**: OpenTofu (Terraform-compatible, BUSL-free)
**Source Control**: Bitbucket Cloud (Harness connects via Bitbucket connector)
**Primary Cloud**: Azure (AKS, ACR, Azure Key Vault, Azure DNS)
**Target Databases**: Self-hosted MongoDB + ClickHouse on AKS (via Helm charts)
**Observability**: Grafana Cloud (managed Tempo, Loki, Mimir)

> **Repository Split (2026-02-12)**: All infrastructure code (Terraform/OpenTofu modules, platform composition, environment tfvars, and Harness infra pipelines) has been moved to the dedicated **[abl-platform-infra](https://bitbucket.org/koreteam1/abl-platform-infra)** repository. Phase 1 references below describe the infrastructure architecture but the actual code lives in `abl-platform-infra`. The `infra-apply` pipeline bridges the repos by cloning `abl-platform-deploy` to update Helm values files with tofu outputs after infrastructure changes.
>
> **Deploy Repo Split (2026-02-19)**: All deployment config (Helm charts, ArgoCD config, environment values files) has been moved to **[abl-platform-deploy](https://bitbucket.org/koreteam1/abl-platform-deploy)**. The app repo (`abl-platform`) now contains only source code, Dockerfiles, and CI pipelines. ArgoCD Image Updater has been fully removed — CI pushes image tags directly to the `develop` branch in the deploy repo. See Phase 3 for the multi-source ApplicationSet architecture.

### Key Architecture Decisions

| Decision                | Choice                                                                                                                                                                                                                        | Rationale                                                                                                                                                                                       |
| ----------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| IaC tool                | OpenTofu (not Terraform)                                                                                                                                                                                                      | Terraform BUSL license; OpenTofu is fully open-source and CLI-compatible                                                                                                                        |
| IaC structure           | OpenTofu workspaces (not Terragrunt)                                                                                                                                                                                          | Single shared config in `platform/`, per-env `.tfvars`, workspaces for state isolation — minimal tooling, zero duplication                                                                      |
| CD platform             | ArgoCD (not Harness CD)                                                                                                                                                                                                       | Native GitOps, dynamic environments via ApplicationSet, PostSync hooks for smoke tests, no need for manual approval pipeline stages                                                             |
| Databases               | Self-hosted on AKS (not managed Atlas/Cloud)                                                                                                                                                                                  | Cost control, single-cluster simplicity, no third-party SaaS dependencies                                                                                                                       |
| Environment model       | Dynamic via ArgoCD git file generator                                                                                                                                                                                         | Add `config.json` + `values-<name>.yaml` to create a new environment — no pipeline changes needed                                                                                               |
| Deployment approval     | PR merge = deployment (non-auto-sync envs)                                                                                                                                                                                    | ArgoCD syncs on git change; PR review gates staging/prod                                                                                                                                        |
| Smoke tests             | ArgoCD PostSync hooks (K8s Jobs)                                                                                                                                                                                              | Run automatically after every sync, no separate pipeline stage                                                                                                                                  |
| Notifications           | ArgoCD Notifications Controller                                                                                                                                                                                               | Slack alerts on sync success/failure/health degraded                                                                                                                                            |
| Rollback                | `git revert` on values file                                                                                                                                                                                                   | ArgoCD detects revert and syncs back to previous image                                                                                                                                          |
| WAF / Ingress           | Azure Application Gateway WAF_v2 → NGINX Ingress Controller (internal LB), single hostname per environment with path-based routing (/api→runtime, /admin→admin, /→studio), TLS termination at AppGW via Key Vault certificate | 1 DNS record per env (not 3), same-origin eliminates CORS, NGINX handles path routing + rewrite, AppGW provides WAF + TLS termination, works with Azure CNI Overlay (pod IPs not VNet-routable) |
| Shared DNS zone support | `create_dns` toggle + `upsert-only` policy + `txt_owner_id` ownership + `regex_domain_filter`                                                                                                                                 | Safe multi-tenant DNS: ABL writes only `abl-*` records into shared zone, never deletes others' records                                                                                          |

### What Already Exists (Pre-Plan)

| Component               | Status                                                                                                | Location                                                                     |
| ----------------------- | ----------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------- |
| Multi-stage Dockerfiles | Done (Node 22 distroless, non-root, no Dockerfile HEALTHCHECK — K8s probes handle liveness/readiness) | `apps/runtime/Dockerfile`, `apps/studio/Dockerfile`, `apps/admin/Dockerfile` |
| Helm charts             | Done (HPA, PDB, topology spread, ingress, network policies)                                           | `helm/abl-platform/` (in `abl-platform-deploy` repo)                         |
| ArgoCD configs          | Done (dev auto-sync, staging manual, prod ApplicationSet)                                             | `argocd/` (in `abl-platform-deploy` repo)                                    |
| ESO integration         | Done (Vault primary, Azure KV fallback, per-service + shared ExternalSecrets)                         | `helm/abl-platform/templates/secrets/` (in `abl-platform-deploy` repo)       |
| OTEL Collector          | Done (DaemonSet, env-specific sampling)                                                               | `helm/abl-platform/templates/infra/` (in `abl-platform-deploy` repo)         |
| Network Policies        | Done (per-component isolation)                                                                        | `helm/abl-platform/templates/network/` (in `abl-platform-deploy` repo)       |
| GitHub Actions CI       | Legacy — superseded by Harness CI, still present (cleanup pending)                                    | `.github/workflows/ci.yml`, `deploy.yml`                                     |

### What This Plan Does NOT Cover (Deferred)

- **FIPS 140-2 / FedRAMP Moderate compliance** — `--force-fips`, RS256 JWT migration, tamper-evident audit logging, NIST 800-53 control mapping
- **Air-gapped / on-premises deployment** — OCI bundles, CLI installer, Kyverno policies, customer-provided registry support
- **Multi-cloud expansion** — AWS and GCP modules (Azure first, patterns are reusable)
- **Argo Rollouts / canary deployment** — Start with standard rolling updates, add canary when traffic justifies it
- **Automated secret rotation** — Manual rotation is acceptable initially
- **OPA policy enforcement on OpenTofu plans** — Nice-to-have, not blocking deployment
- **SLO/SLI definitions and error budgets** — Day-2 observability concern
- **JWT HS256 to RS256 migration** — Current symmetric JWT works; asymmetric is a separate effort

---

## Implementation Status

| Phase   | Description                              | Status                                                                                                                                                                                                                                                                                                                                                                                                          |
| ------- | ---------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Phase 1 | Azure Infrastructure via OpenTofu        | **DONE**                                                                                                                                                                                                                                                                                                                                                                                                        |
| Phase 2 | Harness CI Pipelines + Dockerfiles       | **DONE**                                                                                                                                                                                                                                                                                                                                                                                                        |
| Phase 3 | ArgoCD-Native CD + Helm Fixes            | **PARTIAL** — Dev environment deploying via Harness GitOps + ArgoCD. Deploy config moved to `abl-platform-deploy` repo with two-branch strategy. Image Updater removed, replaced by CI push to deploy repo. Pending: staging/prod clusters.                                                                                                                                                                     |
| Phase 4 | Database Migration & Local Dev           | **DONE**                                                                                                                                                                                                                                                                                                                                                                                                        |
| Phase 5 | Security Scanning & Developer Experience | **PARTIAL** (5.1 security scanning: Trivy STO + SBOM done, Semgrep + Gitleaks in CI done; 5.2 precommit hooks done; release eng pending). DinD removed — Kaniko tar + STO local_archive scan. Trivy: esbuild Go CVEs fixed (vite 5→7), node-tar CVEs fixed (onnxruntime-node override ≥1.22). One `.trivyignore` remains: GHSA-h25m-26qc-wcjf (Next.js 14 EOL, fix requires 15+ migration — see Future Phases). |
| Phase 6 | Observability                            | PENDING                                                                                                                                                                                                                                                                                                                                                                                                         |
| Phase 7 | Production Hardening                     | **PARTIAL** (AppGW WAF_v2 → NGINX Ingress Controller, TLS via KV cert, network policies updated for NGINX namespace)                                                                                                                                                                                                                                                                                            |

---

## Phase 1: Azure Infrastructure via OpenTofu — DONE

_Goal: A running AKS cluster in Azure with all supporting services provisioned via code._

### 1.1 OpenTofu Bootstrap

State is managed automatically by **Harness IaCM** per-workspace — no backend block is needed in the Terraform code. Each IaCM workspace stores its own state file internally. The `terraform/platform/backend.tf` file contains only a comment explaining this.

See: https://developer.harness.io/docs/infra-as-code-management/remote-backends/state-migration/

### 1.2 Directory Structure (Implemented)

Uses **OpenTofu workspaces** — one shared configuration, per-environment `.tfvars` files, workspaces for state isolation:

```
deploy/terraform/
  platform/                              # Shared config (written ONCE, used by all envs)
    main.tf                              # All 12 module calls, fully parameterized
    variables.tf                         # All variables grouped by category
    outputs.tf                           # Key outputs (key_vault_uri, registry_url, etc.)
    providers.tf                         # All providers + versions
    backend.tf                           # Comment-only (state managed by Harness IaCM)
  environments/                          # Per-environment variable values
    dev-azure-eastus.tfvars
    dev-azure-centralus.tfvars           # Kore.ai shared infra (existing VNet, shared DNS zone)
    staging-azure-eastus.tfvars
    prod-azure-eastus.tfvars
  modules/
    kubernetes/azure/                    # AKS + managed identity + Key Vault CSI + Azure CNI
      main.tf, variables.tf, outputs.tf, versions.tf
    registry/azure/                      # ACR + lifecycle policies
      main.tf, variables.tf, outputs.tf
    secrets/azure/                       # Azure Key Vault + secret generation
      main.tf, variables.tf, outputs.tf
    iam/azure/                           # Managed identities + RBAC role assignments
      main.tf, variables.tf, outputs.tf
    database/
      mongodb/                           # Self-hosted MongoDB via Bitnami Helm chart
        main.tf, variables.tf, outputs.tf
      clickhouse/                        # Self-hosted ClickHouse via Bitnami Helm chart
        main.tf, variables.tf, outputs.tf
    livekit/                             # LiveKit server (official Helm chart) for real-time voice/video
      main.tf, variables.tf, outputs.tf
    argocd/                              # ArgoCD via Helm + AppProjects
      main.tf, variables.tf, outputs.tf
    external-dns/                        # external-dns Helm release + Azure config
      main.tf, variables.tf, versions.tf
    harness/                             # Harness Delegate deployment into cluster (with tags for connector selection)
      main.tf, variables.tf, outputs.tf
    appgw/azure/                         # Application Gateway WAF_v2 + public IP + WAF policy
      main.tf, variables.tf, outputs.tf, versions.tf
    dns/azure/                           # Azure DNS zones (public + private) + VNet link
      main.tf, variables.tf, outputs.tf, versions.tf
    kv-bridge/azure/                     # Bridge: DB connection strings + LiveKit creds → Key Vault secrets
      main.tf, variables.tf, outputs.tf
```

**Usage pattern** — all operations run from `terraform/platform/` (in `abl-platform-infra`):

```bash
# Plan for dev
tofu workspace select dev-azure-eastus
tofu plan -var-file=../environments/dev-azure-eastus.tfvars

# Apply for staging
tofu workspace select staging-azure-eastus
tofu apply -var-file=../environments/staging-azure-eastus.tfvars
```

**Adding a new region**: Create `environments/dev-azure-westeurope.tfvars` with region-specific values, create workspace `dev-azure-westeurope`, run plan/apply. Zero edits to existing files.

### 1.3 Key Module Details

**AKS Module** (`deploy/terraform/modules/kubernetes/azure/`):

- AKS cluster (Kubernetes 1.29+), Azure CNI Overlay networking
- Attaches to existing VNet/subnet (IDs via `.tfvars`)
- System + user + CI node pools, managed identity, Workload Identity, OIDC issuer
- **CI node pool** (optional): Dedicated `Standard_D8s_v3` (8 vCPU, 32 GiB) nodes for Harness CI build pods. Autoscales 0→2, tainted `workload=ci:NoSchedule` so only CI pods schedule there. Enabled via `ci_node_pool_enabled = true`.
- AGIC addon: dynamic block enabled when `appgw_id` is provided (programs Application Gateway from Ingress resources)
- Cluster autoscaler enabled on all pools
- All resources tagged with `managed-by = "opentofu"`, `environment`, `cost-center`

**ACR Module** (`deploy/terraform/modules/registry/azure/`):

- Standard SKU (dev/staging), Premium (prod)
- AKS kubelet identity gets `AcrPull` role assignment (pod image pulls). CI SPN `AcrPush` is in the IAM module.
- Image repositories: `abl-runtime`, `abl-studio`, `abl-admin`, `abl-seed`
- Lifecycle policies, admin user disabled

**Key Vault Module** (`deploy/terraform/modules/secrets/azure/`):

- Per-environment Key Vault, Workload Identity access
- Auto-generates: jwt-secret, encryption-key (32-byte hex via `random_id`), nextauth-secret, internal-api-key
- Google OAuth secrets (`google-client-id`, `google-client-secret`) created conditionally from `TF_VAR_google_client_id` / `TF_VAR_google_client_secret`
- Soft delete + purge protection enabled, `lifecycle { ignore_changes = [value] }`

**IAM Module** (`deploy/terraform/modules/iam/azure/`):

- Managed identities for ESO and external-dns
- Federated credentials for Workload Identity (ESO, external-dns)
- `Key Vault Secrets User` role assignment (ESO)
- `DNS Zone Contributor` role assignment on public DNS zone (external-dns, conditional)
- `Private DNS Zone Contributor` role assignment on private DNS zone (external-dns, conditional)
- AGIC addon RBAC: `Contributor` + `Reader` on AppGW resource group (conditional on AGIC enabled)
- `AcrPush` role assignment on ACR for CI SPN (`account.KoreaiAzure`, conditional on `ci_spn_object_id` — `AcrPush` includes pull)

**Database Modules** (self-hosted on AKS):

- `deploy/terraform/modules/database/mongodb/` — Bitnami MongoDB Helm chart, replica set
- `deploy/terraform/modules/database/clickhouse/` — Bitnami ClickHouse Helm chart
- Auto-generated credentials stored as K8s secrets
- PVC-backed persistent storage
- Connection strings written to Key Vault via the `kv-bridge` module (for ESO sync)

**Cache Module** (Azure managed PaaS):

- `deploy/terraform/modules/cache/redis/` — Azure Cache for Redis (Basic for dev, Standard/Premium for prod)
- Backs 6 runtime features: session store, trace store, BullMQ queue, circuit breaker, rate limiter, IR cache
- SSL-only (port 6380), TLS 1.2 minimum, allkeys-lru eviction
- Connection string written to Key Vault via the `kv-bridge` module (for ESO sync)

**LiveKit Module** (`deploy/terraform/modules/livekit/`):

- Deploys LiveKit server via official `livekit/livekit-server` Helm chart into `livekit` namespace
- Auto-generates API key (16-char alphanumeric) and API secret (32-char alphanumeric) via `random_password`
- In-cluster service: `livekit.livekit.svc.cluster.local:7880` (WebSocket)
- WebRTC UDP port range: 50000-60000
- Credentials written to Key Vault via the `kv-bridge` module (for ESO sync)

**KV Bridge Module** (`deploy/terraform/modules/kv-bridge/azure/`):

- Writes database/cache connection strings and LiveKit credentials to Azure Key Vault as secrets
- `azurerm_key_vault_secret` for MongoDB, ClickHouse, Redis connection strings and LiveKit API key/secret
- `lifecycle { ignore_changes = [value] }` to prevent overwrite on subsequent applies

**Composition-level Resources** (`deploy/terraform/platform/main.tf`):

- `data.azurerm_virtual_network.existing` — looks up existing VNet by ID (conditional: only when `appgw_subnet_id` is empty)
- `azurerm_subnet.appgw` — creates dedicated AppGW subnet in existing VNet (conditional: only when `appgw_subnet_id` is empty)
- `locals` block resolves `appgw_subnet_id` and `dns_zone_id` from either module outputs or existing resource variables

**Application Gateway Module** (`deploy/terraform/modules/appgw/azure/`):

- Azure Application Gateway WAF_v2 with autoscaling (env-specific min/max capacity)
- Azure Public IP (Standard SKU, static, zone-redundant for prod)
- WAF Policy: OWASP 3.2 + Microsoft BotManager 1.0 managed rule sets
- Custom WAF rule: blocks external access to admin hostname (allows only RFC 1918 private IPs)
- User-assigned managed identity with `Key Vault Secrets User` role for Key Vault access
- TLS certificates managed by AGIC: PEM cert+key stored as K8s TLS secrets, referenced in Ingress, AGIC configures AppGW `ssl_certificate` automatically. This aligns with existing Kore.ai infra patterns (no PFX, no Key Vault cert import).
- Dummy backend pool/listener/routing rule (AGIC manages real config at runtime)
- `lifecycle.ignore_changes` on all AGIC-managed fields (including `ssl_certificate`) to prevent drift

**DNS Module** (`deploy/terraform/modules/dns/azure/`):

- `azurerm_dns_zone` for public domain
- `azurerm_private_dns_zone` for internal domain
- `azurerm_private_dns_zone_virtual_network_link` to AKS VNet

**Conditional**: `create_dns = false` skips zone creation for shared DNS environments (e.g., deploying into existing `kore.ai` zone). When skipped, `existing_dns_zone_id` provides the zone reference for IAM role assignments.

| Env     | Hostname              | Paths                                      |
| ------- | --------------------- | ------------------------------------------ |
| Dev     | `agents-dev.kore.ai`  | `/api`→runtime, `/admin`→admin, `/`→studio |
| Staging | `abl-staging.kore.ai` | `/api`→runtime, `/admin`→admin, `/`→studio |
| Prod    | `abl.kore.ai`         | `/api`→runtime, `/admin`→admin, `/`→studio |

**ArgoCD Infra Apps Module** (`deploy/terraform/modules/external-dns/`):

- Deploys external-dns via Helm release with Azure-specific configuration
- Azure tenant/subscription/resource group params, domain filters, workload identity client ID
- DNS record management policy defaults to `upsert-only` (safe for shared zones). Shared-zone safety features: `txt_owner_id` for record ownership tracking, `regex_domain_filter` (e.g., `^abl-.*\.kore\.ai$`) to restrict which records external-dns manages

**Wrapper Helm Charts** (now Terraform-managed):

- `modules/external-dns/` (in `abl-platform-infra` repo) — external-dns v1.20.0 (kubernetes-sigs) Helm release + Azure config Secret for workload identity

### 1.5 Infra-to-App Bridge (OpenTofu → Helm Values)

The `kv-bridge` module in `platform/main.tf` writes database/cache connection strings to Key Vault:

```hcl
module "kv_bridge" {
  source = "../modules/kv-bridge/azure"

  key_vault_id                 = module.secrets.key_vault_id
  mongodb_connection_string    = module.mongodb.connection_string
  clickhouse_connection_string = module.clickhouse.connection_string
  redis_connection_string      = module.redis.connection_string
}
```

The kv-bridge module creates `azurerm_key_vault_secret` resources with `lifecycle { ignore_changes = [value] }`.

**Platform outputs** — `platform/outputs.tf` exports values read by the infra-opentofu pipeline:

```hcl
output "key_vault_uri"                        { value = module.secrets.key_vault_uri }
output "eso_identity_client_id"               { value = module.iam.eso_identity_client_id }
output "registry_url"                         { value = module.registry.registry_url }
output "appgw_public_ip"                      { value = module.appgw.public_ip_address }
output "dns_nameservers"                      { value = var.create_dns ? module.dns[0].public_zone_nameservers : [] }
```

The `infra-apply` pipeline post-apply step selects each workspace, reads `tofu output -json`, and updates `values-<env>.yaml` via `yq` (see Phase 2.5).

**Cluster Prerequisites**:

- `deploy/terraform/modules/argocd/` — ArgoCD Helm install into `argocd` namespace
- `deploy/terraform/modules/external-dns/` — external-dns Helm release with Azure config
- `deploy/terraform/modules/harness/` — Harness Delegate for CI pipeline execution (configurable tags for connector/pipeline delegate selectors, environment-based replica count)

### 1.4 Environment Sizing

| Environment   | System Pool | User Pool              | CI Pool               | VM SKUs                                  |
| ------------- | ----------- | ---------------------- | --------------------- | ---------------------------------------- |
| Dev           | 1 node      | 1-2 nodes              | —                     | Standard_D2s_v5                          |
| Dev (Kore.ai) | 2 nodes     | 2-4 nodes              | 0-2 nodes (autoscale) | D2s_v3 (sys), D4s_v3 (user), D8s_v3 (ci) |
| Staging       | 1 node      | 2-3 nodes              | —                     | Standard_D4s_v5 (user)                   |
| Prod          | 2 nodes     | 3-10 nodes (autoscale) | —                     | Standard_D4s_v5                          |

The CI node pool scales to zero when idle and only runs pods with `nodeSelector: { workload: ci }` and the matching `workload=ci:NoSchedule` toleration. This keeps build costs isolated from application workloads.

---

## Phase 2: Harness CI Pipelines + Dockerfiles — DONE

_Goal: Every PR and main branch push triggers automated build, test, and image push via Harness CI. ArgoCD handles deployment — no Harness CD needed._

### 2.1 Harness Project Structure

Single Harness project — CI only:

- `ABLPlatform` — all CI pipelines (build, test, scan, image push) + infrastructure pipelines (OpenTofu)

No `abl-cd` project. ArgoCD handles all deployment.

**Harness Connectors**:

| Connector              | Type            | Scope   | Auth Method           | Used By                                                                           |
| ---------------------- | --------------- | ------- | --------------------- | --------------------------------------------------------------------------------- |
| `ablplatformconnector` | Bitbucket Cloud | Project | App password          | Codebase clone + webhook triggers (both repos)                                    |
| `account.KoreaiAzure`  | Azure SPN       | Account | Service principal     | `BuildAndPushACR` (Kaniko, `AcrPush` on ACR) + IaCM workspaces (ARM for OpenTofu) |
| `ABL_AKS_Dev`          | Kubernetes      | Project | Inherit from Delegate | CI stage infrastructure — runs build pods on AKS                                  |
| `Docker`               | Docker Hub      | Project | Anonymous             | Pulls step container images (node:22-bookworm, alpine, etc.)                      |

**CI Infrastructure**: All CI stages run on the AKS cluster via `KubernetesDirect` infrastructure (`ABL_AKS_Dev` connector, `default` namespace). CI pods target the **dedicated CI node pool** (`Standard_D8s_v3`, 8 vCPU / 32 GiB) via `nodeSelector: { workload: ci }` and `tolerations: [{ key: workload, value: ci, effect: NoSchedule }]`. The CI pool autoscales 0→2 — scales up on build, scales to zero when idle. Each `Run` step executes in a dedicated container within a K8s pod, using images pulled via the `Docker` connector. Build/test step uses `node:22-bookworm` (full Debian 12 — required for mongodb-memory-server system libraries and Node.js 22 native ZSTD support) with `shell: Sh`. Resource limits set to `8Gi` memory / `4` CPU for the merged install+build+test step. Cache Intelligence enabled with pnpm lockfile checksum key for `node_modules` and `.turbo` cache paths.

**ACR Push Authentication**: The `BuildAndPushACR` step uses Kaniko internally, which **only supports Service Principal (access key) Azure connectors**. The existing `account.KoreaiAzure` connector (account-scoped) is reused for image push. The IAM module assigns `AcrPush` on the ACR to this SP via the `ci_spn_object_id` variable. Note: Azure `AcrPush` is a superset of `AcrPull` — it grants both push and pull permissions, so Kaniko can pull base images during builds.

### 2.2 Pipeline-as-Code

All pipeline YAML lives in the main repo under `.harness/`. Harness reads definitions via **Remote storage mode** from Bitbucket.

**Implemented structure**:

```
.harness/
  pipelines/
    ci-build.yaml              # Main branch: build, test, Docker push, update GitOps
```

No PR validation pipeline — the build pipeline on merge is the single quality gate. This keeps CI simple and fast. PR-level validation (lint, typecheck) can be added later as a Phase 5 enhancement if needed.

Infrastructure pipeline (`infra-opentofu.yaml`) lives in the `abl-platform-infra` repo and uses **Harness IaCM** with OpenTofu workspaces.

### 2.3 CI Pipeline — Build

**File**: `.harness/pipelines/ci-build.yaml`

```
Trigger: Bitbucket push to main (path filters: apps/, packages/)
         deploy/ directory removed — deploy config now in abl-platform-deploy repo
Infrastructure: KubernetesDirect (ABL_AKS_Dev, namespace: default, nodeSelector: workload=ci, toleration: workload=ci:NoSchedule)

Stage 1 — Generate Tag (alpine:3.19)
  - IMAGE_TAG = <commitSha>[0:7]
  - IMAGE_TAG_DATE = main-YYYYMMDD

Stage 2 — Build and Test (node:22-bookworm, caching: pnpm lockfile checksum key, node_modules + .turbo)
  Single merged step (8Gi/4CPU):
    1. corepack enable && pnpm install --frozen-lockfile
    2. pnpm turbo build test --concurrency=4
    3. JUnit report upload (**/junit-report.xml)

Stage 3 — Docker Build Scan Push (matrix: [runtime, studio, admin], maxConcurrency: 3)
  Build→Scan→Push workflow using Kaniko + Harness STO (no DinD, no privileged containers for scanning):
    1. Build Image (BuildAndPushACR with PLUGIN_NO_PUSH + PLUGIN_TAR_PATH)
       - Kaniko builds image, saves to abl-<app>.tar, skips push
       - OCI labels: source repo URL, commit SHA
    2. Trivy Container Scan (AquaTrivy STO step, image.type: local_archive)
       - Scans the local tar archive — no DinD, no ACR credentials needed
       - Severity: CRITICAL,HIGH, --ignore-unfixed
       - Fails pipeline on CRITICAL severity
       - Generates SBOM (SPDX JSON) via STO
    3. Push Image (BuildAndPushACR with PLUGIN_PUSH_ONLY + PLUGIN_SOURCE_TAR_PATH)
       - Kaniko reads from tar and pushes to ACR
       - Repository: acrabldev.azurecr.io/abl-<app>
       - Tags: <sha7>, main-<YYYYMMDD>, latest
       - Only runs if Trivy scan passes (sequential steps)

Stage 4 — Build Seed Image (BuildAndPushACR, Kaniko)
  - Repository: acrabldev.azurecr.io/abl-seed
  - Tags: <sha7>, latest
  - Dockerfile target: seed

Stage 5 — Code Security Scan (SecurityTests stage)
  - Semgrep SAST: OSS rules, fail on CRITICAL
  - Gitleaks Secret Detection: uses .gitleaks.toml allowlist, fail on CRITICAL
  - Results visible in Harness STO dashboard

Stage 6 — Update Dev Deploy (alpine/git:2.43.0 + yq)
  - Clones abl-platform-deploy repo, checks out develop branch
  - Updates global.image.tag in helm/abl-platform/values-dev.yaml with IMAGE_TAG
  - Commits with "[skip ci]" tag + source commit SHA + pipeline URL
  - Pushes to develop → ArgoCD detects git change → syncs dev environment
  - Only runs after successful Docker push (Stage 3)
```

### 2.4 OpenTofu Pipeline (Harness IaCM)

> **Note**: The infra pipeline now lives in the **[abl-platform-infra](https://bitbucket.org/koreteam1/abl-platform-infra)** repository. It uses **Harness IaCM** (Infrastructure as Code Management) with OpenTofu workspaces and the `koreazurespn` Azure connector — no manual tofu install or individual ARM\_\* secrets needed.

> **Harness IaCM Details**: The pipeline uses `IACMTerraformPlugin` step type with OpenTofu workspaces. Despite the "terraform" in the step type name, the workspace's provisioner setting determines the actual binary (OpenTofu 1.11.x). The `koreazurespn` Azure connector provides ARM credentials automatically — no manual secret configuration needed.

**File**: `abl-platform-infra/.harness/pipelines/infra-opentofu.yaml`

**Variables (runtime input):**

- `WORKSPACE_ID`: `abl_dev_centralus` | `abl_staging_eastus` | `abl_prod_eastus`
- `OPERATION`: `plan` (preview) | `provision` (plan + approve + apply)

**Stages:**

- Stage 1 (IACM): `init` + `plan` — plan output visible in Harness IaCM UI
- Stage 2 (Approval): Staging approval (1 approver from `platform_team`) — conditional on provision + staging
- Stage 3 (Approval): Production approval (2 approvers from `platform_leads`, executor excluded) — conditional on provision + prod
- Stage 4 (IACM): `init` + `apply` — conditional on provision. Dev auto-applies (no approval gate)
- Stage 5 (Custom/delegate): Post-apply validation:
  1. Verify AKS cluster health (kubectl on delegate)
  2. Verify ArgoCD health
  3. **Update Helm Values Files** — reads infra values from Azure, clones `abl-platform-deploy`, updates `values-<env>.yaml` with `yq`, commits and pushes with `[skip ci]`:
     - `secrets.enabled` → `true`
     - `global.image.registry` → from `registry_url` output
     - `secrets.azure.vaultUrl` / `secrets.azure.identityClientId` → from outputs (if provider is azure)
     - Commits + pushes with `[skip ci]` tag → ArgoCD auto-syncs dev
  4. ArgoCD health check

### 2.5 Dockerfiles — Distroless Migration (Done)

All three Dockerfiles migrated to Google Distroless:

| Stage      | Image                                 | Purpose                                             |
| ---------- | ------------------------------------- | --------------------------------------------------- |
| Builder    | `node:22-slim`                        | Full Node tooling for pnpm, turbo, native deps      |
| Production | `gcr.io/distroless/nodejs22-debian12` | Zero shell, no package manager, minimal CVE surface |

Key details:

- `CMD` uses exec form `["server.js"]` (no shell in distroless)
- Healthcheck handled by K8s probes (distroless has no `curl`/`wget`)
- Debug variant available: `gcr.io/distroless/nodejs22-debian12:debug`
- `.dockerignore` created for all three apps

---

## Phase 3: ArgoCD-Native CD + Helm Fixes — PARTIAL

_Goal: Code merged to main flows automatically to dev via ArgoCD. Staging/prod deploy via PR merge to update values file. No Harness CD pipelines._

### 3.0 Deployment Status & Pending Work

**What's working (dev cluster):**

- Harness GitOps agent deployed via Terraform (`gitops-agent` module)
- Bootstrap Application syncs `argocd/` from `abl-platform-deploy` repo (AppProject + ApplicationSet)
- ApplicationSet generates `abl-platform-dev` Application from `environments/dev/config.json`
- Dev Application syncs Helm chart from `helm/abl-platform/` in deploy repo with `values-dev.yaml`
- ArgoCD repo credentials stored as K8s secret (SSH RSA PEM key, `insecure: true` for host key skip)
- Ingress configured with `agents-dev.kore.ai`, AppGW → NGINX internal LB (10.32.65.200) → Pods
- AppGW public IP: `20.9.35.96`
- HTTPS working end-to-end (TLS cert imported to Key Vault, AppGW terminates TLS)

**Pending work:**

| #   | Task                          | Severity    | Details                                                                                                                                                                                           |
| --- | ----------------------------- | ----------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 1   | ~~**AKS→ACR pull access**~~   | ~~BLOCKER~~ | **DONE** — `tofu apply` reconciled AcrPull role.                                                                                                                                                  |
| 2   | ~~**DNS A record**~~          | ~~HIGH~~    | **DONE** — external-dns creating records.                                                                                                                                                         |
| 3   | ~~**TLS certificate**~~       | ~~HIGH~~    | **DONE** — PFX cert imported to Key Vault (`appgw-tls-cert`), AppGW references via `tls_kv_cert_name`. HTTP→HTTPS redirect working.                                                               |
| 4   | ~~**ApplicationSet branch**~~ | ~~MEDIUM~~  | **DONE** — Tracking `develop`. Infra tfvars and ApplicationSet updated.                                                                                                                           |
| 5   | **Staging cluster**           | MEDIUM      | Separate AKS cluster + ArgoCD instance. New IaCM workspace + tfvars. Add `environments/staging/config.json` back.                                                                                 |
| 6   | **Prod cluster**              | MEDIUM      | Same as staging — separate cluster, ArgoCD, GitOps agent. Add `environments/prod/config.json` back.                                                                                               |
| 7   | ~~**ArgoCD Image Updater**~~  | ~~LOW~~     | **REMOVED** — Replaced by separate deploy repo strategy. CI pushes image tags to `develop` branch in `abl-platform-deploy`. Image Updater module, Workload Identity, and all annotations deleted. |
| 8   | ~~**Secrets (ESO)**~~         | ~~LOW~~     | **DONE** — `secrets.enabled: true` in dev values. ESO syncing all secrets from Key Vault.                                                                                                         |

**Manual steps required per environment (one-time):**

1. **TLS Certificate Upload to Key Vault** — must be done **before** running `tofu apply` with `tls_kv_cert_name` set:

   ```bash
   # Convert PEM cert+key to PFX (Azure KV requires PKCS#12 format)
   openssl pkcs12 -export -out cert.pfx -inkey key.pem -in cert.pem -passout pass:
   # Import into Key Vault (requires Key Vault Certificates Officer role)
   az keyvault certificate import --vault-name kv-abl-<env> --name appgw-tls-cert --file cert.pfx --password ""
   ```

   - Cert name must match `tls_kv_cert_name` in tfvars (default: `appgw-tls-cert`)
   - To skip HTTPS initially, set `tls_kv_cert_name = ""` — AppGW runs HTTP-only
   - Cert renewal: re-import with the same name, AppGW auto-picks up new version

2. **NGINX Ingress Controller** — deployed manually via `kubectl apply` (not yet Terraform-managed):
   ```bash
   kubectl apply -f https://raw.githubusercontent.com/kubernetes/ingress-nginx/controller-v1.12.1/deploy/static/provider/cloud/deploy.yaml
   ```
   Then patch the service for internal Azure LB with a static IP matching `ingress_nginx_backend_ip` in tfvars.

### 3.1 ArgoCD Architecture

ArgoCD handles **all** deployment. There are no Harness CD pipelines.

**Multi-cluster model**: Each environment (dev, staging, prod) has its own AKS cluster with its own ArgoCD instance and Harness GitOps agent. The ApplicationSet in each cluster only generates Applications for that environment via `environments/<env>/config.json`.

**How deployment works**:

| Environment | Trigger                                                                    | Approval Method       |
| ----------- | -------------------------------------------------------------------------- | --------------------- |
| Dev         | CI pushes image tag to `develop` branch in deploy repo → ArgoCD auto-syncs | Auto (no manual step) |
| Staging     | PR to `main` in deploy repo updating `values-staging.yaml` image tag       | PR review approval    |
| Prod        | PR to `main` in deploy repo updating `values-prod-*.yaml` image tag(s)     | PR review approval    |

**Separate deploy repo**: All Helm charts, ArgoCD config, and values files live in **[abl-platform-deploy](https://bitbucket.org/koreteam1/abl-platform-deploy)**. The app repo (`abl-platform`) contains only source code and CI pipelines.

**Two-branch strategy**:

- `main` (protected — PR + approval): Helm chart, ArgoCD config, staging/prod values. CI bot has no push access.
- `develop` (unprotected — CI bot can push): Dev image tags only (`values-dev.yaml`).

**Multi-source ApplicationSet**: ArgoCD reads the chart from one revision (`chartRevision` in config.json — `main` for dev, pinned git tag for staging/prod) and overlays env-specific values from another revision (`targetRevision` — `develop` for dev, `main` for staging/prod). This eliminates the need for ArgoCD Image Updater and its token expiry issues.

**Dev deployment**: CI builds images → pushes tag to `develop` branch → ArgoCD detects git change → syncs dev. Full git audit trail for every image deployed.

**Staging/Prod deployment**: Manual PR to `main` updating the image tag in the appropriate values file. PR review serves as the approval gate. ArgoCD syncs on merge. Prod supports sequential canary (one region first) or simultaneous (all regions in one PR).

**Chart promotion**: Chart changes merge to `main` via PR → dev picks them up immediately (`chartRevision: main`). For staging/prod, create a git tag (e.g., `chart-v0.2.0`) and update `chartRevision` in the environment's config.json via PR.

**Rollback**: `git revert` the values file commit on the appropriate branch → ArgoCD syncs back to previous image/chart.

#### Harness GitOps Terraform Resources (abl-platform-infra)

The `gitops-agent` module (`terraform/modules/gitops-agent/`) manages the full GitOps pipeline:

| Resource                                           | Purpose                                                                                                       |
| -------------------------------------------------- | ------------------------------------------------------------------------------------------------------------- |
| `harness_platform_gitops_agent`                    | Deploys Harness GitOps agent Helm chart into ArgoCD namespace                                                 |
| `harness_platform_gitops_app_project_mapping` (×2) | Maps `abl-platform` and `default` ArgoCD projects to Harness project                                          |
| `kubernetes_secret_v1.argocd_repo_creds`           | Stores SSH key as ArgoCD repo credential (K8s secret with `argocd.argoproj.io/secret-type: repository` label) |
| `harness_platform_gitops_repository`               | Registers repo in Harness GitOps UI                                                                           |
| `harness_platform_gitops_applications.bootstrap`   | Bootstrap Application: syncs `argocd/` from deploy repo (project + ApplicationSet)                            |

**Key learnings**: Harness GitOps repo registration does NOT propagate SSH keys to ArgoCD's credential store. A `kubernetes_secret_v1` with the `repository` label is required for ArgoCD repo-server to clone. SSH keys must be RSA PEM format (`-----BEGIN RSA PRIVATE KEY-----`), not OpenSSH format. The bootstrap app uses the `default` ArgoCD project (no destination restrictions) since it deploys into the `argocd` namespace.

### 3.2 ArgoCD ApplicationSet (Dynamic Environments)

**File**: `argocd/applicationset.yaml` (in `abl-platform-deploy` repo)

Uses the **git file generator** with **multi-source** Applications to dynamically create ArgoCD Applications from config files:

```yaml
spec:
  goTemplate: true
  goTemplateOptions: ['missingkey=error']
  ignoreApplicationDifferences:
    - jqPathExpressions:
        - .spec.sources
  generators:
    - git:
        repoURL: git@bitbucket.org:koreteam1/abl-platform-deploy.git
        revision: main
        files:
          - path: argocd/environments/*/config.json
```

Each generated Application uses **two sources**:

- **Source 1 (chart)**: reads Helm chart from `chartRevision` (e.g., `main` for dev, `chart-v0.1.0` for staging/prod)
- **Source 2 (values, `$env` ref)**: reads env-specific values from `targetRevision` (e.g., `develop` for dev, `main` for staging/prod)

The ApplicationSet uses **go templates** (`goTemplate: true`) with strict error handling. The generator `repoURL` must be hardcoded (not a template variable — generator runs before template resolution). All environments get auto-sync with self-heal enabled.

**To add a new environment**, create two files in the deploy repo:

1. `argocd/environments/<name>/config.json`
2. `helm/abl-platform/values-<name>.yaml`

No pipeline changes, no ArgoCD Application YAML changes needed.

### 3.3 Environment Configuration

Each environment has a `config.json` in `argocd/environments/<name>/` (in `abl-platform-deploy` repo):

```json
{
  "name": "dev",
  "repoURL": "git@bitbucket.org:koreteam1/abl-platform-deploy.git",
  "chartRevision": "main",
  "targetRevision": "develop",
  "cluster": "https://kubernetes.default.svc",
  "namespace": "abl-platform-dev",
  "baseUrl": "https://agents-dev.kore.ai",
  "notifyChannel": "deploy-dev"
}
```

| Field            | Purpose                                                                           |
| ---------------- | --------------------------------------------------------------------------------- |
| `repoURL`        | Git repository URL for both chart and values sources                              |
| `chartRevision`  | Git revision for the Helm chart (`main` for dev, pinned git tag for staging/prod) |
| `targetRevision` | Git revision for env-specific values (`develop` for dev, `main` for staging/prod) |
| `baseValueFile`  | Optional shared base values file (e.g., `values-prod.yaml` for all prod regions)  |
| `cluster`        | Target K8s API server URL                                                         |
| `namespace`      | Target namespace (auto-created)                                                   |
| `notifyChannel`  | Slack channel for deployment notifications                                        |

**Current environments** (each on its own ArgoCD instance / AKS cluster):

| Environment | Cluster                 | Status                                      | Namespace            |
| ----------- | ----------------------- | ------------------------------------------- | -------------------- |
| dev         | `aks-abl-dev-centralus` | **Active** — ApplicationSet generating apps | abl-platform-dev     |
| staging     | TBD                     | Pending — separate cluster needed           | abl-platform-staging |
| prod        | TBD                     | Pending — separate cluster needed           | abl-platform-prod    |

### 3.4 ArgoCD Project & RBAC

**File**: `argocd/project.yaml` (in `abl-platform-deploy` repo)

- AppProject `abl-platform` with destination restriction to `argocd` + `abl-platform-*` namespaces
- Cluster resource whitelist: `Namespace`, `ClusterRole`, `ClusterRoleBinding`, `ClusterSecretStore`
- Roles: `admin` (platform-team group), `readonly` (developers group)
- Bootstrap app uses `default` ArgoCD project (mapped to Harness project via `harness_platform_gitops_app_project_mapping`)

### 3.5 PostSync Smoke Tests

**File**: `helm/abl-platform/templates/hooks/post-sync-smoke-test.yaml` (in `abl-platform-deploy` repo)

ArgoCD PostSync hook that runs automatically after every successful sync:

- K8s Job using `curlimages/curl:8.5.0`
- Health checks: runtime `/health`, studio `/health`, admin `/health`
- Service URLs use the fullname helper: `{{ include "abl-platform.fullname" . }}-{runtime,studio,admin}:80`
- Retry logic: `--retry 3 --retry-delay 5`
- Cleanup: `HookSucceeded` delete policy, `ttlSecondsAfterFinished: 300`
- Controlled by `smokeTest.enabled` in values.yaml

### 3.6 ArgoCD Notifications

**File**: `argocd/notifications/configmap.yaml` (in `abl-platform-deploy` repo)

Slack notifications for:

- **Sync succeeded** (green) — environment, revision, timestamp
- **Sync failed** (red) — environment, revision, error message
- **Health degraded** (yellow) — environment, health status

Each environment's `notifyChannel` in config.json controls which Slack channel receives alerts.

### 3.7 Secrets Management — Vault + ESO (Done)

_Goal: All sensitive configuration flows through a centralized secret manager (HashiCorp Vault primary, Azure Key Vault fallback) via External Secrets Operator. No manual secret injection._

#### Secret Provider Architecture

**ClusterSecretStore** (`helm/abl-platform/templates/secrets/cluster-secret-store.yaml` in `abl-platform-deploy` repo):

- Supports 3 providers: `vault` (primary), `azure` (fallback), `aws` (legacy)
- Provider selected by `secrets.provider` in values.yaml
- Store name is provider-agnostic: `{fullname}` (not `{fullname}-aws`)

```yaml
# values.yaml
secrets:
  enabled: false # Set to true by infra-opentofu pipeline
  provider: vault # vault | azure | aws
  vault:
    server: '' # e.g., https://vault.example.com
    role: '' # Vault Kubernetes auth role
    basePath: 'abl-platform/data' # KV v2 path prefix
    kvMountPath: secret
    authMountPath: kubernetes
  azure:
    vaultUrl: '' # Fallback: Azure Key Vault URL
    identityClientId: ''
  refreshInterval: 1h
```

#### Provider-Agnostic Secret References

**Helper** (`helm/abl-platform/templates/_helpers.tpl` in `abl-platform-deploy` repo):

```yaml
{{- define "abl-platform.secretRef" -}}
{{- if eq .root.Values.secrets.provider "vault" -}}
key: {{ .root.Values.secrets.vault.basePath }}/{{ .root.Values.global.environment }}/{{ .group }}
property: {{ .name }}
{{- else -}}
key: {{ .name }}
{{- end -}}
{{- end }}
```

- **Vault KV v2**: Groups secrets by path — `abl-platform/data/{env}/{group}` with `property` for individual keys
- **Azure Key Vault**: Flat namespace — secret name is the key directly

All ExternalSecrets use this helper, making them provider-agnostic.

#### Vault Secret Organization

```
abl-platform/data/
  dev/
    shared/       → JWT_SECRET, ENCRYPTION_MASTER_KEY, MONGODB_URL, CLICKHOUSE_URL
    runtime/      → INTERNAL_API_KEY, LIVEKIT_API_KEY, LIVEKIT_API_SECRET
    studio/       → NEXTAUTH_SECRET, GOOGLE_CLIENT_ID/SECRET, S3_*
  staging/
    shared/       → (same structure)
    runtime/      → (same structure)
    studio/       → (same structure)
  prod/
    ...
```

#### ExternalSecrets (3 per environment)

| ExternalSecret       | Target K8s Secret            | Key Secrets                                                                                     |
| -------------------- | ---------------------------- | ----------------------------------------------------------------------------------------------- |
| `{fullname}-shared`  | `{fullname}-shared-secrets`  | JWT_SECRET, ENCRYPTION_MASTER_KEY, MONGODB_URL, CLICKHOUSE_URL                                  |
| `{fullname}-runtime` | `{fullname}-runtime-secrets` | INTERNAL_API_KEY, LIVEKIT_API_KEY, LIVEKIT_API_SECRET                                           |
| `{fullname}-studio`  | `{fullname}-studio-secrets`  | NEXTAUTH_SECRET, GOOGLE_CLIENT_ID, GOOGLE_CLIENT_SECRET, S3_ACCESS_KEY_ID, S3_SECRET_ACCESS_KEY |

> **Note**: LLM provider keys (OpenAI, Google AI, Azure OpenAI) and voice provider keys (Twilio, Deepgram, ElevenLabs) are managed per-tenant via the Studio UI and stored encrypted in MongoDB. They are NOT in ExternalSecrets or Key Vault.

All `secretKey` values use `UPPER_SNAKE_CASE` (matching `process.env.*` names), not kebab-case.

#### Pod Secret Mounting

All 3 deployments (runtime, studio, admin) mount secrets via `envFrom`:

```yaml
envFrom:
  - configMapRef:
      name: {fullname}-{component}-config    # Non-sensitive config (e.g. abl-platform-runtime-config)
  - secretRef:                               # Shared secrets (conditional)
      name: {fullname}-shared-secrets
      optional: true
  - secretRef:                               # Service-specific secrets
      name: {fullname}-{component}-secrets   # e.g. abl-platform-runtime-secrets
      optional: true
```

Shared secrets are mounted conditionally when `secrets.enabled: true`. The `optional: true` flag ensures pods still start if ESO hasn't synced yet.

#### Secrets Inventory

The table below lists every secret referenced by ExternalSecrets, whether it's auto-generated by OpenTofu or must be manually provisioned in the secret store (Azure Key Vault or Vault).

##### Auto-Generated (Zero Manual Setup)

These are created automatically by `tofu apply`. No operator action needed.

| KV Secret Name                 | ExternalSecret | Env Var                 | Generator                                            |
| ------------------------------ | -------------- | ----------------------- | ---------------------------------------------------- |
| `jwt-secret`                   | shared         | `JWT_SECRET`            | `random_password` (64 chars, special)                |
| `encryption-key`               | shared         | `ENCRYPTION_MASTER_KEY` | `random_id` (32 bytes → 64-char hex for AES-256)     |
| `mongodb-connection-string`    | shared         | `MONGODB_URL`           | kv-bridge module (from MongoDB Helm chart output)    |
| `clickhouse-connection-string` | shared         | `CLICKHOUSE_URL`        | kv-bridge module (from ClickHouse Helm chart output) |
| `redis-connection-string`      | shared         | `REDIS_URL`             | kv-bridge module (from Redis Helm chart output)      |
| `nextauth-secret`              | studio         | `NEXTAUTH_SECRET`       | `random_password` (64 chars, special)                |
| `internal-api-key`             | runtime        | `INTERNAL_API_KEY`      | `random_password` (48 chars, alphanumeric)           |
| `livekit-api-key`              | runtime        | `LIVEKIT_API_KEY`       | kv-bridge module (from LiveKit module output)        |
| `livekit-api-secret`           | runtime        | `LIVEKIT_API_SECRET`    | kv-bridge module (from LiveKit module output)        |

##### Terraform Variable Secrets (Set in Harness IaCM Workspace)

These secrets are created in Key Vault by Terraform when the corresponding `TF_VAR_*` environment variable is set in the Harness IaCM workspace. They are conditionally created (skipped when the variable is empty).

| KV Secret Name         | Workspace Env Var             | ExternalSecret | Env Var                | Required?                     |
| ---------------------- | ----------------------------- | -------------- | ---------------------- | ----------------------------- |
| `google-client-id`     | `TF_VAR_google_client_id`     | studio         | `GOOGLE_CLIENT_ID`     | Required for Google SSO login |
| `google-client-secret` | `TF_VAR_google_client_secret` | studio         | `GOOGLE_CLIENT_SECRET` | Required for Google SSO login |

##### Manual — Required Before First Deployment

These must be created in Key Vault (or Vault) **before** deploying the application. If missing, the per-service ExternalSecret will fail to sync and the corresponding K8s Secret won't be created. Pods will still start (secrets are `optional: true`), but the features backed by these secrets won't work.

**Studio secrets** — create in Vault path `{env}/studio` or Azure KV:

| KV Secret Name         | Env Var                | Purpose                  | Required?                 |
| ---------------------- | ---------------------- | ------------------------ | ------------------------- |
| `s3-access-key-id`     | `S3_ACCESS_KEY_ID`     | S3/Azure Blob access key | Required for file uploads |
| `s3-secret-access-key` | `S3_SECRET_ACCESS_KEY` | S3/Azure Blob secret key | Required for file uploads |

##### UI-Managed Secrets (Not in Key Vault)

LLM provider keys and voice provider keys are now managed per-tenant via the Studio UI and stored encrypted in MongoDB. They do NOT need to be set in Key Vault.

- **LLM keys**: Anthropic, OpenAI, Google AI, Azure OpenAI
- **Voice keys**: Twilio (account SID, auth token, API key, TwiML app), Deepgram, ElevenLabs

##### Quick-Start: Minimum Viable Secrets

For a minimal deployment without voice or Google SSO, **zero manual secrets are needed** — all shared secrets are auto-generated. To enable specific features, add only the relevant manual secrets:

| Feature                           | Setup Required                                                                     |
| --------------------------------- | ---------------------------------------------------------------------------------- |
| Core platform (agents, chat, API) | None — all auto-generated                                                          |
| LiveKit voice/video               | None — auto-generated by LiveKit Terraform module                                  |
| Google SSO login                  | Set `TF_VAR_google_client_id` + `TF_VAR_google_client_secret` in Harness workspace |
| File uploads                      | Manual: `s3-access-key-id`, `s3-secret-access-key` in Key Vault                    |
| LLM providers                     | None in Key Vault — configure per-tenant in Studio UI                              |
| Voice providers                   | None in Key Vault — configure per-tenant in Studio UI                              |

##### How to Add a Manual Secret

**Azure Key Vault** (flat namespace):

```bash
az keyvault secret set --vault-name <kv-name> --name "s3-access-key-id" --value "<your-key>"
az keyvault secret set --vault-name <kv-name> --name "s3-secret-access-key" --value "<your-secret>"
```

**HashiCorp Vault** (grouped by path):

```bash
vault kv put abl-platform/data/dev/studio s3-access-key-id="<your-key>" s3-secret-access-key="<your-secret>"
```

After adding secrets, ESO syncs them within `refreshInterval` (default: 1 hour). To force an immediate sync:

```bash
kubectl annotate externalsecret abl-platform-runtime -n <namespace> force-sync=$(date +%s) --overwrite
```

### 3.8 ConfigMap URL Derivation (Done)

_Goal: URLs are derived from ingress config — single source of truth. No manual URL duplication across values files._

All three ConfigMap templates (`runtime`, `studio`, `admin`) auto-derive external/internal URLs from `ingress.host` + `ingress.paths.*` + `ingress.tls.enabled`:

```yaml
# runtime/configmap.yaml
{{- $scheme := ternary "https" "http" .Values.ingress.tls.enabled }}
{{- $baseUrl := printf "%s://%s" $scheme .Values.ingress.host }}
{{- $derived := dict
  "API_URL" (printf "%s%s" $baseUrl .Values.ingress.paths.runtime)
  "FRONTEND_URL" $baseUrl
}}
{{- $merged := merge .Values.runtime.configMap $derived }}
```

**Studio** derives: `RUNTIME_URL` (internal K8s), `NEXT_PUBLIC_RUNTIME_URL` (baseUrl + /api), `NEXT_PUBLIC_RUNTIME_WS_URL` (wss://host/api), `NEXT_PUBLIC_APP_URL` (baseUrl), `NEXTAUTH_URL`, `FRONTEND_URL`

> **Architecture note**: Studio proxies runtime API calls via Next.js middleware (`src/middleware.ts`), NOT via `next.config.mjs` rewrites. Rewrites are serialized at build time in `output: 'standalone'` Docker builds, which bakes the fallback `localhost:3112` permanently. Middleware reads `process.env.RUNTIME_URL` at request time, making it compatible with K8s ConfigMap injection. Runtime-bound paths (`/api/sessions`, `/api/chat`, `/api/transcripts`, `/api/tool-secrets`, `/api/proxy-configs`, `/api/oauth`, `/api/tenants`, and project sub-paths like deployments/channels/versions/model-config) are proxied via `NextResponse.rewrite()` in middleware.

**Admin** derives: `STUDIO_API_URL` (internal K8s), `NEXT_PUBLIC_BASE_URL`

Explicit `configMap` entries in values files override derived values (via Helm `merge`). This means:

- Changing `ingress.host` automatically updates all URL references across all services
- Changing `ingress.tls.enabled` automatically switches http↔https and ws↔wss
- Each env values file sets only `ingress.host` — all service URLs derived automatically, no duplication

### 3.9 End-to-End Infra → App Flow

```
tofu apply (infra-opentofu pipeline, per-workspace)
  ├── Creates AKS, ACR, Key Vault, MongoDB, ClickHouse, Redis, IAM
  ├── kv-bridge module writes to Key Vault:
  │   mongodb-connection-string, clickhouse-connection-string, redis-connection-string
  ├── secrets module auto-generates in Key Vault:
  │   jwt-secret, encryption-key (32-byte hex),
  │   nextauth-secret, internal-api-key
  │
  └── Post-apply step (infra-opentofu.yaml Stage 7):
      ├── Selects each workspace, reads tofu output -json
      ├── Updates values-<env>.yaml via yq:
      │     secrets.enabled: true
      │     secrets.azure.vaultUrl: <key_vault_uri>
      │     secrets.azure.identityClientId: <eso_identity_client_id>
      │     global.image.registry: <registry_url>
      └── git commit + push [skip ci] → ArgoCD syncs

ArgoCD syncs Helm chart
  ├── ClusterSecretStore → Vault KV v2 (or Azure Key Vault)
  ├── ExternalSecrets → K8s Secrets:
  │     {fullname}-shared-secrets:  JWT_SECRET, ENCRYPTION_MASTER_KEY, MONGODB_URL, CLICKHOUSE_URL (all auto-generated)
  │     {fullname}-runtime-secrets: OPENAI_API_KEY, TWILIO_*, DEEPGRAM_*, INTERNAL_API_KEY (manual + auto)
  │     {fullname}-studio-secrets:  NEXTAUTH_SECRET, GOOGLE_*, S3_*, TWILIO_* (manual + auto)
  ├── ConfigMaps (non-sensitive, URLs auto-derived from ingress):
  │     {fullname}-runtime-config: PORT, LOG_LEVEL, API_URL, FRONTEND_URL, MONGODB_DATABASE, MONGODB_AUTH_SOURCE, OTEL_*, ...
  │     {fullname}-studio-config:  PORT, NEXT_PUBLIC_*, NEXTAUTH_URL, MONGODB_DATABASE, MONGODB_AUTH_SOURCE, ...
  │     {fullname}-admin-config:   PORT, STUDIO_API_URL, NEXT_PUBLIC_BASE_URL, ...
  └── Deployments mount: configMapRef + shared-secrets + component-secrets

Pod env vars (precedence: direct env > service secret > shared secret > configMap):
  envFrom:
    - configMapRef: {fullname}-{component}-config   (non-sensitive: ports, URLs, feature flags)
    - secretRef: {fullname}-shared-secrets           (JWT, encryption key, DB connection strings)
    - secretRef: {fullname}-{component}-secrets      (API keys, OAuth creds — optional: true)
```

### 3.10 Helm Chart Production Readiness Fixes (Done)

**HPA improvements** (runtime, studio, admin):

- Added memory utilization metric alongside CPU
- Added scale-down stabilization window (300s, max 50% reduction per 60s)

**Admin deployment**:

- Added startup probe (`/health/startup`, 30 retries, 10s period)
- Added topology spread constraints (zone-aware scheduling)
- Enabled HPA in staging values

**Values files**: Added `smokeTest.enabled: true`, `targetMemoryUtilizationPercentage: 80` to all HPA configs

---

## Phase 4: Database Migration & Local Dev — DONE

_Goal: MongoDB and ClickHouse running, application migrated from Prisma/SQLite, local dev stack works with Docker Compose._

### 4.1 Local Development Stack — DONE

**File**: `docker-compose.yml` (root)

Services: MongoDB 7, ClickHouse 24, Redis 7-alpine, OTEL Collector, Jaeger

**File**: `scripts/setup-local-env.sh`

- Checks Docker, starts compose services
- Generates `.env` files from templates
- Sets MongoDB, ClickHouse, Redis connection strings
- Runs seed script

**File**: `deploy/otel/local-config.yaml` — OTEL Collector config for local dev

Apps run natively via `pnpm dev` for hot reload — not in Docker.

### 4.2 Database Provisioning via OpenTofu — DONE

Self-hosted on AKS (not managed Atlas/Cloud):

- `deploy/terraform/modules/database/mongodb/` — Bitnami MongoDB Helm chart with replica set
- `deploy/terraform/modules/database/clickhouse/` — Bitnami ClickHouse Helm chart
- `deploy/terraform/modules/cache/redis/` — Azure Cache for Redis (session store, BullMQ queue, circuit breaker, rate limiter, IR cache)

Database modules auto-generate credentials and store them as K8s secrets. Redis is Azure-managed with access keys.

### 4.3 Application Database Migration — DONE

Migration from Prisma/SQLite to MongoDB + ClickHouse is complete:

- **49 Mongoose models** in `packages/database/src/models/` covering users, sessions, projects, agents, conversations, messages, and all other entities
- **MongoConnectionManager** in `packages/database/src/` — singleton connection with retry logic
- **ClickHouse client** in `packages/database/src/` — configured for analytics writes
- **ClickHouse stores** in `apps/runtime/src/services/stores/`: message, metrics, trace, audit, fact
- **Seed script**: `packages/database/seed-mongo.ts` creates seed user `user-dev-001` / `dev@kore.ai`
- **All apps** (runtime, studio) use MongoDB exclusively — no Prisma dependencies or imports remain in active code

**Data role split** (as planned):

| Data Type                                 | Database   | Why                                        |
| ----------------------------------------- | ---------- | ------------------------------------------ |
| Users, sessions, projects, agents, config | MongoDB    | Transactional, document-oriented           |
| Conversations, messages                   | MongoDB    | Flexible schema, nested documents          |
| Audit events, metrics, analytics          | ClickHouse | Append-only, time-series, fast aggregation |
| LLM token usage, cost tracking            | ClickHouse | Columnar storage, efficient for analytics  |

> **Note**: Legacy SQLite files in `packages/database/prisma/` are unused artifacts and can be deleted.

---

## Phase 5: Security Scanning & Developer Experience — PARTIAL

_Goal: Security gates block vulnerable code from reaching production. Developer tooling enforces consistency._

### 5.1 Security Scanning in Harness CI

Security scans in `ci-build.yaml` use Harness STO native steps (no DinD). Container scanning uses Kaniko tar + AquaTrivy `local_archive` for pre-push gating:

| Scan      | Tool              | When                 | Blocking?                                                       |
| --------- | ----------------- | -------------------- | --------------------------------------------------------------- |
| SAST      | Semgrep (STO)     | Every main push      | Yes (CRITICAL) — ✅ in ci-build.yaml (Code Security Scan stage) |
| SCA       | pnpm audit        | Every PR             | Advisory (non-blocking) — already in ci-pr-validation.yaml      |
| SCA       | Trivy fs          | Every PR + main push | Yes (CRITICAL) — PENDING                                        |
| Secrets   | Gitleaks (STO)    | Every main push      | Yes (CRITICAL) — ✅ in ci-build.yaml (Code Security Scan stage) |
| Container | Trivy (STO)       | Image build (main)   | Yes (CRITICAL) — ✅ in ci-build.yaml (AquaTrivy local_archive)  |
| License   | license-checker   | PR                   | Advisory                                                        |
| SBOM      | Trivy (SPDX JSON) | Image build          | No (artifact only) — ✅ generated by AquaTrivy STO step         |

**Files** (all already exist):

- `.gitleaks.toml` — custom allowlist for known false positives ✅
- `.trivyignore` — accepted risk entries with justification comments ✅
- Semgrep uses `config: default` (OSS rules) — no `.semgrepconfig.yml` needed

### 5.2 Pre-commit & Developer Experience ✅ DONE

**New dependencies** (root `package.json`): `husky`, `lint-staged`, `@commitlint/cli`, `@commitlint/config-conventional`, `prettier`

**New files**:

- `.husky/pre-commit` → gitleaks secret scan (if installed) + `pnpm lint-staged` (Prettier auto-format)
- `.husky/commit-msg` → `pnpm commitlint --edit $1`
- `.husky/pre-push` → `pnpm vitest --changed --run` (only tests affected by changes)
- `commitlint.config.ts` → conventional commits with JIRA ticket prefix `[ABC-123]`, workspace scopes, merge-commit exemption
- `.lintstagedrc.json` → Prettier auto-fix on staged `*.{ts,tsx,js,jsx,json,md,yaml,yml,css,html}` files
- `.gitleaks.toml` → secret scan config with allowlist for `.env.example`, seed scripts, docker-compose
- `.prettierrc.json` → single quotes, trailing commas, 100 char width, LF line endings
- `.prettierignore` → excludes dist, .next, node_modules, coverage, Terraform/Helm templates
- `.editorconfig` → consistent indent (2 spaces), LF, UTF-8, trim trailing whitespace

**Commit message format**: `[JIRA-ID] type(scope): description` (e.g. `[ABL-123] feat(runtime): add health endpoint`)

**Root scripts added**: `prepare` (husky init), `format` (prettier --write .), `format:check` (prettier --check .)

**Turbo task added**: `format:check` (for CI integration)

**Note**: ESLint deferred to separate PR — requires rule selection and suppressing existing violations across all packages.

### 5.3 Release Engineering

**New dependencies**: `@changesets/cli`, `@changesets/changelog-git`
**New files**: `.changeset/config.json`, `.harness/pipelines/ci-release-build.yaml`

---

## Phase 6: Observability — PENDING

_Goal: Traces, metrics, and logs flowing to Grafana Cloud. Basic dashboards for service health._

### 6.1 Grafana Cloud Setup

Provision Grafana Cloud stack with Tempo (traces), Loki (logs), Mimir (metrics), Grafana (dashboards). Store API keys in Azure Key Vault.

### 6.2 OTEL Collector Configuration Update

Update `helm/abl-platform/templates/infra/otel-collector-configmap.yaml` (in `abl-platform-deploy` repo):

- Exporters: point to Grafana Cloud OTLP endpoints
- Add `otel.backends.tempo`, `otel.backends.loki`, `otel.backends.prometheus` to values

### 6.3 Grafana Dashboards

**New directory**: `observability/dashboards/` (in `abl-platform-deploy` repo)

- `service-health.json` — request rate, error rate, p50/p95/p99 latency, pod CPU/memory
- `agent-execution.json` — agent execution count/latency, LLM call duration, token usage

### 6.4 Alert Routing (Basic)

**New file**: `observability/alerting/grafana-alerts.yaml` (in `abl-platform-deploy` repo)

- 5xx error rate > 5% for 5 min -> Slack
- Pod restart count > 3 in 10 min -> Slack
- Pod CPU > 90% sustained for 10 min -> Slack

---

## Phase 7: Production Hardening — PARTIAL

_Goal: Prod environment is resilient, secrets are managed properly, network is locked down._

### 7.1 Network Policies Update — DONE

All three network policies updated to replace stale PostgreSQL `:5432` egress with correct database ports:

- **MongoDB** `:27017` — namespace-scoped pod selector (`app.kubernetes.io/name: mongodb`)
- **ClickHouse** `:8123` (HTTP) + `:9000` (native) — namespace-scoped pod selector (`app.kubernetes.io/name: clickhouse`)
- Database egress restricted to labeled pods within the cluster (no more `0.0.0.0/0` CIDR for DB traffic)

Modified files:

- `helm/abl-platform/templates/network/network-policy-runtime.yaml` (in `abl-platform-deploy` repo)
- `helm/abl-platform/templates/network/network-policy-studio.yaml` (in `abl-platform-deploy` repo)
- `helm/abl-platform/templates/network/network-policy-admin.yaml` (in `abl-platform-deploy` repo)

### 7.1a Ingress, WAF & Networking Infrastructure — DONE

Two-tier ingress architecture using Azure Application Gateway WAF_v2 + NGINX Ingress Controller:

```
Internet → AppGW WAF_v2 (TLS termination, WAF, public IP)
  → NGINX internal LB (VNet IP, e.g., 10.32.65.200:80)
    → Pods (overlay IPs, not VNet-routable)
```

**Why two-tier (AppGW → NGINX) instead of AGIC?** AKS uses Azure CNI Overlay + Cilium, where pod IPs (10.251.x.x) are overlay-only and **not VNet-routable**. AGIC programs AppGW to route directly to pod IPs → 502 errors. NGINX Ingress Controller runs inside the cluster with a VNet-routable internal LoadBalancer IP that AppGW can always reach.

**OpenTofu manages Azure resources:**

- **Application Gateway WAF_v2** — Azure-managed WAF at the edge with OWASP 3.2 + Microsoft BotManager 1.0
- **WAF Policy** — Detection mode (dev/staging), Prevention mode (prod), custom rule blocks external access to admin hostname
- **Azure Public IP** — Standard SKU, static, zone-redundant (prod: zones 1,2,3)
- **TLS Certificate** — Uploaded to Key Vault out-of-band (PFX format via `az keyvault certificate import`). AppGW references by name via `tls_kv_cert_name` variable. When empty, AppGW runs HTTP-only.
- **Conditional AppGW backend** — When `ingress_nginx_backend_ip` is set: backend pool → NGINX LB IP, health probe → `/healthz`, optional HTTPS listener + redirect. When empty: AGIC dummy backend (AGIC manages at runtime).
- **Azure DNS Zones** — Public + private DNS zones per environment, private zone linked to AKS VNet
- **external-dns** — Helm release with Azure config for workload identity, automatic DNS record creation/deletion
- **AppGW subnet auto-creation** — when `appgw_subnet_id` is empty, Terraform looks up the existing VNet via `data.azurerm_virtual_network` and creates `snet-abl-appgw-{env}` subnet using `appgw_subnet_address_prefix` CIDR. When provided, uses the existing subnet directly.
- **Shared DNS zone support** — `create_dns = false` skips DNS zone creation and uses `existing_dns_zone_id` for IAM role assignments. External DNS operates safely in shared zones via `upsert-only` policy, `txt_owner_id` ownership tracking, and `regex_domain_filter` prefix matching.

**Removed (replaced by AppGW WAF_v2 + NGINX):**

- ~~cert-manager + SelfSigned CA~~ — TLS handled at AppGW via Key Vault certificate
- ~~ModSecurity WAF~~ — replaced by Azure WAF with OWASP 3.2 + BotManager (runs at edge, not in cluster)
- ~~nginx configuration-snippet security headers~~ — moved to application layer (helmet middleware for Express, next.config.js headers for Next.js)

**Why AppGW + NGINX over AGIC-only:**

- AGIC requires VNet-routable pod IPs — incompatible with Azure CNI Overlay + Cilium
- NGINX provides in-cluster routing with a stable VNet-routable LB IP
- AppGW still provides WAF, TLS termination, DDoS protection, bot management at Azure edge
- NGINX handles path rewriting, regex routing, and health checks natively
- TLS certificate managed out-of-band (PFX in Key Vault) — no cert-manager or AGIC overhead
- Admin access restriction via WAF custom rules

**Environment sizing:**

| Setting            | Dev         | Staging     | Prod        |
| ------------------ | ----------- | ----------- | ----------- |
| WAF mode           | Detection   | Detection   | Prevention  |
| AppGW autoscale    | 0-2         | 1-3         | 2-10        |
| Availability zones | none        | none        | 1, 2, 3     |
| WAF custom rules   | admin block | admin block | admin block |
| Bot protection     | yes         | yes         | yes         |
| Ingress controller | NGINX       | NGINX       | NGINX       |

**Helm Ingress templates** — 3 Ingress resources share a single hostname with path-based routing, conditional on `ingress.className`:

When `className: nginx` (dev):

- NGINX annotations: `nginx.ingress.kubernetes.io/ssl-redirect: "false"` (AppGW handles TLS), `use-regex: "true"`, `rewrite-target: /$2`
- `ingressClassName: nginx`
- Path patterns: `/api(/|$)(.*)` → runtime, `/admin(/|$)(.*)` → admin, `/` → studio
- No TLS block (TLS terminated at AppGW)

When `className: ""` (AGIC fallback):

- AGIC annotations: `kubernetes.io/ingress.class: azure/application-gateway`, `backend-path-prefix`, `ssl-redirect`, `appgw-ssl-certificate`
- TLS block with single host — AGIC reads K8s TLS secret and configures AppGW ssl_certificate

**Network policies** conditional on `ingress.className`:

- **NGINX mode**: allows ingress from `ingress-nginx` namespace (traffic comes from NGINX pods in-cluster)
- **AGIC mode**: allows ingress from `ipBlock.cidr` matching AppGW subnet + AKS node subnet (traffic comes from Azure resource, SNAT'd through node IPs)

Pending: `helm/abl-platform/templates/network/network-policy-default-deny.yaml` (in `abl-platform-deploy` repo)
**Application-layer security headers** — DONE:

- **Runtime (Express)**: `helmet` middleware already configured with HSTS (prod), X-Content-Type-Options, X-Frame-Options, Referrer-Policy (`apps/runtime/src/server.ts`)
- **Studio (Next.js)**: `headers()` in `next.config.mjs` — X-Content-Type-Options, X-Frame-Options: SAMEORIGIN, Referrer-Policy, Permissions-Policy, HSTS (prod only)
- **Admin (Next.js)**: `headers()` in `next.config.mjs` — X-Content-Type-Options, X-Frame-Options: DENY (admin should never be framed), Referrer-Policy, Permissions-Policy (camera/mic/geo denied), HSTS (prod only)

### 7.2 Pod Security

- Add `seccompProfile: { type: RuntimeDefault }` on all pod specs
- Namespace-level PSA labels: `pod-security.kubernetes.io/enforce: restricted`

### 7.3 Pre-Deployment Secret Validation

`scripts/validate-secrets.sh` already exists. Wire it into ArgoCD PreSync hook or keep as manual check before promoting to prod.

**Note**: Secrets management infrastructure is already in place (Phase 3.7). This phase focuses on hardening: rotation policies, validation gates, and monitoring secret sync health.

### 7.4 Backup Strategy

- **MongoDB**: Helm chart backup CronJob + PVC snapshots
- **ClickHouse**: Daily snapshots via backup plugin
- **K8s config**: Git is the backup (ArgoCD re-sync restores everything)
- **Container images**: ACR retains all tagged images (lifecycle policy keeps last 10)

---

## Disaster Recovery

| Component        | RPO           | RTO    | Strategy                                                                                  |
| ---------------- | ------------- | ------ | ----------------------------------------------------------------------------------------- |
| MongoDB          | 5 min         | 10 min | Replica set + PVC snapshots                                                               |
| ClickHouse       | 24h           | 1h     | Daily snapshots to Azure Blob                                                             |
| Container images | 0 (immutable) | 5 min  | ACR retains all tagged images                                                             |
| K8s config       | 0 (Git)       | 15 min | ArgoCD re-sync from Bitbucket                                                             |
| Secrets          | 1h            | 15 min | Vault HA + snapshots (primary); Azure Key Vault soft-delete + purge protection (fallback) |

---

## Complete File Inventory

### Implemented Files

| File                                                                                     | Phase | Status                                                                                                            |
| ---------------------------------------------------------------------------------------- | ----- | ----------------------------------------------------------------------------------------------------------------- |
| `deploy/terraform/platform/main.tf`                                                      | 1     | DONE (moved to abl-platform-infra)                                                                                |
| `deploy/terraform/platform/variables.tf`                                                 | 1     | DONE (moved to abl-platform-infra)                                                                                |
| `deploy/terraform/platform/outputs.tf`                                                   | 1     | DONE (moved to abl-platform-infra)                                                                                |
| `deploy/terraform/platform/providers.tf`                                                 | 1     | DONE (moved to abl-platform-infra)                                                                                |
| `deploy/terraform/platform/backend.tf`                                                   | 1     | DONE (moved to abl-platform-infra)                                                                                |
| `deploy/terraform/environments/dev-azure-eastus.tfvars`                                  | 1     | DONE (moved to abl-platform-infra)                                                                                |
| `deploy/terraform/environments/dev-azure-centralus.tfvars`                               | 1     | DONE (moved to abl-platform-infra)                                                                                |
| `deploy/terraform/environments/staging-azure-eastus.tfvars`                              | 1     | DONE (moved to abl-platform-infra)                                                                                |
| `deploy/terraform/environments/prod-azure-eastus.tfvars`                                 | 1     | DONE (moved to abl-platform-infra)                                                                                |
| `deploy/terraform/modules/kubernetes/azure/*`                                            | 1     | DONE (moved to abl-platform-infra)                                                                                |
| `deploy/terraform/modules/registry/azure/*`                                              | 1     | DONE (moved to abl-platform-infra)                                                                                |
| `deploy/terraform/modules/secrets/azure/*`                                               | 1     | DONE (moved to abl-platform-infra)                                                                                |
| `deploy/terraform/modules/iam/azure/*`                                                   | 1     | DONE (moved to abl-platform-infra)                                                                                |
| `deploy/terraform/modules/database/mongodb/*`                                            | 1     | DONE (moved to abl-platform-infra)                                                                                |
| `deploy/terraform/modules/database/clickhouse/*`                                         | 1     | DONE (moved to abl-platform-infra)                                                                                |
| `deploy/terraform/modules/cache/redis/*`                                                 | 1     | DONE (moved to abl-platform-infra)                                                                                |
| `deploy/terraform/modules/argocd/*`                                                      | 1     | DONE (moved to abl-platform-infra)                                                                                |
| `deploy/terraform/modules/appgw/azure/*`                                                 | 7     | DONE (moved to abl-platform-infra)                                                                                |
| `deploy/terraform/modules/external-dns/*`                                                | 7     | DONE (moved to abl-platform-infra)                                                                                |
| `deploy/terraform/modules/harness/*`                                                     | 1     | DONE (moved to abl-platform-infra)                                                                                |
| `deploy/terraform/modules/dns/azure/*`                                                   | 7     | DONE (moved to abl-platform-infra)                                                                                |
| `deploy/terraform/modules/kv-bridge/azure/*`                                             | 1     | DONE (moved to abl-platform-infra)                                                                                |
| ~~`deploy/terraform/modules/ingress/nginx/*`~~                                           | ~~7~~ | **DELETED** — NGINX now deployed via `kubectl apply` (not Terraform); AppGW routes to NGINX internal LB           |
| ~~`deploy/terraform/modules/cert-manager/*`~~                                            | ~~1~~ | **DELETED** — TLS handled at AppGW via Key Vault certificate (no cert-manager needed)                             |
| ~~`deploy/helm/cert-manager/*`~~                                                         | ~~7~~ | **DELETED** — TLS handled at AppGW via Key Vault certificate (no cert-manager needed)                             |
| ~~`deploy/helm/external-dns/*`~~                                                         | ~~7~~ | **MOVED** to `abl-platform-infra` (external-dns managed by Terraform Helm release in `modules/external-dns/`)     |
| ~~`deploy/helm/abl-platform/templates/namespace.yaml`~~                                  | ~~3~~ | **DELETED** — ArgoCD CreateNamespace=true handles this                                                            |
| ~~`.harness/pipelines/ci-pr-validation.yaml`~~                                           | ~~2~~ | **REMOVED** — build pipeline on merge is the single quality gate; PR validation can be added later if needed      |
| `.harness/pipelines/ci-build.yaml`                                                       | 2     | DONE                                                                                                              |
| `.harness/pipelines/infra-opentofu.yaml`                                                 | 2     | DONE (moved to abl-platform-infra)                                                                                |
| `.harness/pipelines/infra-opentofu.yaml`                                                 | 2     | DONE (moved to abl-platform-infra)                                                                                |
| `apps/runtime/Dockerfile`                                                                | 2     | DONE (Distroless)                                                                                                 |
| `apps/studio/Dockerfile`                                                                 | 2     | DONE (Distroless)                                                                                                 |
| `apps/admin/Dockerfile`                                                                  | 2     | DONE (Distroless)                                                                                                 |
| `apps/runtime/.dockerignore`                                                             | 2     | DONE                                                                                                              |
| `apps/studio/.dockerignore`                                                              | 2     | DONE                                                                                                              |
| `apps/admin/.dockerignore`                                                               | 2     | DONE                                                                                                              |
| `argocd/applicationset.yaml` (abl-platform-deploy)                                       | 3     | DONE (moved to abl-platform-deploy repo, multi-source ApplicationSet)                                             |
| `argocd/project.yaml` (abl-platform-deploy)                                              | 3     | DONE (moved to abl-platform-deploy repo)                                                                          |
| `argocd/environments/dev/config.json` (abl-platform-deploy)                              | 3     | DONE (moved to abl-platform-deploy repo, chartRevision + targetRevision)                                          |
| `argocd/environments/staging/config.json` (abl-platform-deploy)                          | 3     | DONE (moved to abl-platform-deploy repo)                                                                          |
| `argocd/environments/prod-us-east-1/config.json` (abl-platform-deploy)                   | 3     | DONE (moved to abl-platform-deploy repo)                                                                          |
| `argocd/environments/prod-eu-west-1/config.json` (abl-platform-deploy)                   | 3     | DONE (moved to abl-platform-deploy repo)                                                                          |
| `argocd/environments/prod-ap-southeast-1/config.json` (abl-platform-deploy)              | 3     | DONE (moved to abl-platform-deploy repo)                                                                          |
| `argocd/notifications/configmap.yaml` (abl-platform-deploy)                              | 3     | DONE (moved to abl-platform-deploy repo)                                                                          |
| `helm/abl-platform/templates/hooks/pre-sync-seed-db.yaml` (abl-platform-deploy)          | 4     | DONE (ArgoCD PreSync hook — drops + re-seeds MongoDB/ClickHouse in dev)                                           |
| `helm/abl-platform/templates/hooks/post-sync-smoke-test.yaml` (abl-platform-deploy)      | 3     | DONE                                                                                                              |
| `helm/abl-platform/templates/runtime/hpa.yaml` (abl-platform-deploy)                     | 3     | DONE (memory + stabilization)                                                                                     |
| `helm/abl-platform/templates/studio/hpa.yaml` (abl-platform-deploy)                      | 3     | DONE (memory + stabilization)                                                                                     |
| `helm/abl-platform/templates/admin/hpa.yaml` (abl-platform-deploy)                       | 3     | DONE (memory + stabilization)                                                                                     |
| `helm/abl-platform/templates/admin/deployment.yaml` (abl-platform-deploy)                | 3     | DONE (startup probe + topology + shared-secrets mount)                                                            |
| `helm/abl-platform/templates/runtime/deployment.yaml` (abl-platform-deploy)              | 3     | DONE (shared-secrets mount)                                                                                       |
| `helm/abl-platform/templates/studio/deployment.yaml` (abl-platform-deploy)               | 3     | DONE (shared-secrets mount)                                                                                       |
| `helm/abl-platform/templates/_helpers.tpl` (abl-platform-deploy)                         | 3     | DONE (secretRef helper for provider-agnostic ESO)                                                                 |
| `helm/abl-platform/templates/secrets/cluster-secret-store.yaml` (abl-platform-deploy)    | 3     | DONE (Vault + Azure + AWS providers)                                                                              |
| `helm/abl-platform/templates/secrets/external-secret-shared.yaml` (abl-platform-deploy)  | 3     | DONE (UPPER_SNAKE_CASE, Vault refs, MongoDB/ClickHouse)                                                           |
| `helm/abl-platform/templates/secrets/external-secret-runtime.yaml` (abl-platform-deploy) | 3     | DONE (UPPER_SNAKE_CASE, full Twilio keys, Vault refs)                                                             |
| `helm/abl-platform/templates/secrets/external-secret-studio.yaml` (abl-platform-deploy)  | 3     | DONE (UPPER_SNAKE_CASE, voice secrets, no Stripe, Vault refs)                                                     |
| `helm/abl-platform/templates/runtime/configmap.yaml` (abl-platform-deploy)               | 3     | DONE (auto-derive URLs from ingress)                                                                              |
| `helm/abl-platform/templates/studio/configmap.yaml` (abl-platform-deploy)                | 3     | DONE (auto-derive URLs from ingress)                                                                              |
| `helm/abl-platform/templates/admin/configmap.yaml` (abl-platform-deploy)                 | 3     | DONE (auto-derive URLs from ingress)                                                                              |
| `apps/studio/next.config.mjs`                                                            | 7     | DONE (security headers: X-Content-Type-Options, X-Frame-Options, Referrer-Policy, Permissions-Policy, HSTS)       |
| `apps/admin/next.config.mjs`                                                             | 7     | DONE (security headers: X-Content-Type-Options, X-Frame-Options: DENY, Referrer-Policy, Permissions-Policy, HSTS) |
| `helm/abl-platform/values.yaml` (abl-platform-deploy)                                    | 3     | DONE (Vault config, URL derivation, smokeTest, admin fixes)                                                       |
| `helm/abl-platform/values-dev.yaml` (abl-platform-deploy)                                | 3     | DONE (NGINX className, secrets enabled, networkPolicy config)                                                     |
| `helm/abl-platform/values-staging.yaml` (abl-platform-deploy)                            | 3     | DONE (AGIC className default, admin HPA, secrets placeholder, networkPolicy.appgwSubnetCidr)                      |
| `helm/abl-platform/values-prod.yaml` (abl-platform-deploy)                               | 3     | DONE (shared prod config: AGIC className, targetMemory, secrets, networkPolicy.appgwSubnetCidr)                   |
| `helm/abl-platform/values-prod-us-east-1.yaml` (abl-platform-deploy)                     | 3     | DONE (region-specific overrides for US East)                                                                      |
| `helm/abl-platform/values-prod-eu-west-1.yaml` (abl-platform-deploy)                     | 3     | DONE (region-specific overrides for EU West)                                                                      |
| `helm/abl-platform/values-prod-ap-southeast-1.yaml` (abl-platform-deploy)                | 3     | DONE (region-specific overrides for AP Southeast)                                                                 |
| `helm/abl-platform/templates/network/network-policy-runtime.yaml` (abl-platform-deploy)  | 7     | DONE (conditional: NGINX namespace selector or AppGW/AKS ipBlock CIDR)                                            |
| `helm/abl-platform/templates/network/network-policy-studio.yaml` (abl-platform-deploy)   | 7     | DONE (conditional: NGINX namespace selector or AppGW/AKS ipBlock CIDR)                                            |
| `helm/abl-platform/templates/network/network-policy-admin.yaml` (abl-platform-deploy)    | 7     | DONE (conditional: NGINX namespace selector or AppGW/AKS ipBlock CIDR)                                            |
| `docker-compose.yml`                                                                     | 4     | DONE                                                                                                              |
| `scripts/setup-local-env.sh`                                                             | 4     | DONE                                                                                                              |
| ~~`deploy/otel/local-config.yaml`~~                                                      | ~~4~~ | **NOT CREATED** — was planned but never implemented; OTEL local dev not yet needed                                |
| `.husky/pre-commit`                                                                      | 5     | DONE (gitleaks + lint-staged)                                                                                     |
| `.husky/commit-msg`                                                                      | 5     | DONE (commitlint)                                                                                                 |
| `.husky/pre-push`                                                                        | 5     | DONE (vitest --changed)                                                                                           |
| `commitlint.config.ts`                                                                   | 5     | DONE (conventional commits + JIRA ticket + workspace scopes)                                                      |
| `.lintstagedrc.json`                                                                     | 5     | DONE (Prettier auto-fix on staged files)                                                                          |
| `.gitleaks.toml`                                                                         | 5     | DONE (secret scan config with allowlist)                                                                          |
| `.prettierrc.json`                                                                       | 5     | DONE (code formatter config)                                                                                      |
| `.prettierignore`                                                                        | 5     | DONE (excludes dist, .next, Terraform, Helm)                                                                      |
| `.editorconfig`                                                                          | 5     | DONE (consistent editor settings)                                                                                 |
| Root `package.json`                                                                      | 5     | DONE (husky, lint-staged, commitlint, prettier + scripts)                                                         |
| `turbo.json`                                                                             | 5     | DONE (format:check task)                                                                                          |

### Pending Files

| File                                                                                         | Phase | Purpose                          |
| -------------------------------------------------------------------------------------------- | ----- | -------------------------------- |
| `.semgrepconfig.yml`                                                                         | 5     | SAST config                      |
| `.trivyignore`                                                                               | 5     | Accepted CVE risk entries        |
| `.changeset/config.json`                                                                     | 5     | Release versioning               |
| `.harness/pipelines/ci-release-build.yaml`                                                   | 5     | Release tag builds               |
| `observability/dashboards/service-health.json` (abl-platform-deploy)                         | 6     | Grafana service health dashboard |
| `observability/dashboards/agent-execution.json` (abl-platform-deploy)                        | 6     | Grafana agent metrics dashboard  |
| `observability/alerting/grafana-alerts.yaml` (abl-platform-deploy)                           | 6     | Basic alert rules                |
| `helm/abl-platform/templates/network/network-policy-default-deny.yaml` (abl-platform-deploy) | 7     | Default deny network policy      |

### Pending Modifications

| File                                                                                    | Phase | Change                                                                                                         |
| --------------------------------------------------------------------------------------- | ----- | -------------------------------------------------------------------------------------------------------------- |
| ~~`deploy/helm/abl-platform/templates/secrets/cluster-secret-store.yaml`~~              | ~~3~~ | ~~Add Azure Key Vault provider~~ — **DONE** (Vault + Azure + AWS)                                              |
| ~~`deploy/helm/abl-platform/templates/secrets/external-secret-*.yaml`~~                 | ~~3~~ | ~~Update secret paths for Azure~~ — **DONE** (provider-agnostic via secretRef helper)                          |
| ~~`deploy/helm/abl-platform/templates/network/network-policy-runtime.yaml`~~            | ~~7~~ | ~~MongoDB/ClickHouse egress ports~~ — **DONE** (all 3 network policies updated)                                |
| `helm/abl-platform/templates/infra/otel-collector-configmap.yaml` (abl-platform-deploy) | 6     | Grafana Cloud export endpoints                                                                                 |
| ~~`packages/database/package.json`~~                                                    | ~~4~~ | ~~Add mongodb, @clickhouse/client~~ — **DONE** (mongoose + @clickhouse/client installed)                       |
| ~~`packages/database/src/index.ts`~~                                                    | ~~4~~ | ~~Replace Prisma with MongoDB client~~ — **DONE** (exports MongoConnectionManager)                             |
| ~~`packages/compiler/src/platform/stores/*.ts`~~                                        | ~~4~~ | ~~Implement MongoDB + ClickHouse backends~~ — **DONE** (concrete impls in `apps/runtime/src/services/stores/`) |
| ~~Root `package.json`~~                                                                 | ~~5~~ | ~~Add husky, lint-staged, commitlint~~ — **DONE** (+ prettier, format scripts, prepare script)                 |

---

## Verification Checklist

| #     | Test                                                                                                                                    | Phase | Status                                                                                 |
| ----- | --------------------------------------------------------------------------------------------------------------------------------------- | ----- | -------------------------------------------------------------------------------------- |
| 1     | `tofu workspace select dev-azure-eastus && tofu plan -var-file=../environments/dev-azure-eastus.tfvars` shows clean resource creation   | 1     | DONE                                                                                   |
| 2     | `tofu apply` provisions AKS + ACR + Key Vault + kv-bridge                                                                               | 1     | Ready to run                                                                           |
| 3     | `kubectl get nodes` returns healthy AKS nodes                                                                                           | 1     | Ready to run                                                                           |
| 4     | Docker push to ACR succeeds                                                                                                             | 1     | Ready to run                                                                           |
| 5     | Key Vault contains auto-generated secrets + DB connection strings (via kv-bridge)                                                       | 1     | Ready to run                                                                           |
| ~~6~~ | ~~Bitbucket PR triggers Harness CI -> lint/test/validate~~                                                                              | ~~2~~ | **REMOVED** — no PR validation pipeline                                                |
| 7     | Merge to main builds + pushes Docker images to ACR                                                                                      | 2     | Ready to run                                                                           |
| 8     | `values-dev.yaml` auto-updated with new image tag                                                                                       | 2     | Ready to run                                                                           |
| 9     | `tofu plan` posts summary as Bitbucket PR comment (per affected workspace)                                                              | 2     | Ready to run                                                                           |
| 10    | Merge to main -> dev cluster updated within 5 min (ArgoCD auto-sync)                                                                    | 3     | Ready to run                                                                           |
| 11    | Staging deploy via PR merge to update values file                                                                                       | 3     | Ready to run                                                                           |
| 12    | Prod deploy via PR merge to update values file                                                                                          | 3     | Ready to run                                                                           |
| 13    | Rollback via git revert -> ArgoCD syncs previous image                                                                                  | 3     | Ready to run                                                                           |
| 14    | PostSync smoke tests pass after deployment                                                                                              | 3     | Ready to run                                                                           |
| 15    | Slack notification on sync success/failure                                                                                              | 3     | Ready to run                                                                           |
| 16    | HPA scales on both CPU and memory pressure                                                                                              | 3     | Ready to run                                                                           |
| 16a   | `helm template` renders ClusterSecretStore with Vault provider                                                                          | 3     | Ready to run                                                                           |
| 16b   | `helm template` renders ExternalSecrets with correct UPPER_SNAKE_CASE keys                                                              | 3     | Ready to run                                                                           |
| 16c   | Shared secrets mounted in runtime, studio, admin deployments                                                                            | 3     | Ready to run                                                                           |
| 16d   | ConfigMap URLs auto-derived from ingress.hosts (no manual URL entries)                                                                  | 3     | Ready to run                                                                           |
| 16e   | `tofu apply` + post-apply step writes Vault/registry config to values files (workspace-based)                                           | 3     | Ready to run                                                                           |
| 16f   | ESO syncs secrets from Vault → K8s Secrets → pod env vars                                                                               | 3     | Ready to run                                                                           |
| 17    | `docker compose up` starts MongoDB/ClickHouse/Redis locally                                                                             | 4     | DONE                                                                                   |
| 18    | `setup-local-env.sh` generates working .env files                                                                                       | 4     | DONE                                                                                   |
| 19    | `pnpm dev` works against Docker Compose backends                                                                                        | 4     | DONE                                                                                   |
| 20    | Application reads/writes transactional data to MongoDB                                                                                  | 4     | DONE                                                                                   |
| 21    | Audit/analytics data flows to ClickHouse                                                                                                | 4     | DONE                                                                                   |
| 22    | PR with known CVE is blocked by Trivy/Semgrep                                                                                           | 5     | Ready to run (Trivy STO + Semgrep STO in ci-build.yaml)                                |
| 23    | Non-conventional commit message rejected by commitlint                                                                                  | 5     | DONE                                                                                   |
| 24    | Traces visible in Grafana Tempo end-to-end                                                                                              | 6     | PENDING                                                                                |
| 25    | Service health dashboard shows real-time metrics                                                                                        | 6     | PENDING                                                                                |
| 26    | 5xx spike triggers Slack alert                                                                                                          | 6     | PENDING                                                                                |
| 27    | Network policy blocks unauthorized pod traffic                                                                                          | 7     | Ready to run (policies updated — MongoDB/ClickHouse ports, namespace-scoped selectors) |
| 27a   | `tofu plan` shows AppGW WAF_v2 with NGINX backend pool, WAF policy, public IP, HTTPS listener with KV cert reference                    | 7     | **DONE**                                                                               |
| 27b   | external-dns Helm release deployed and healthy                                                                                          | 7     | Ready to run                                                                           |
| 27c   | `helm template` produces 3 Ingress resources with NGINX className, path regex routing (/api, /admin, /), rewrite-target annotations     | 7     | **DONE**                                                                               |
| 27d   | `nslookup agents-dev.kore.ai` resolves to AppGW public IP (single DNS record per env)                                                   | 7     | Ready to run                                                                           |
| 27e   | Prod: WAF Prevention mode enabled, OWASP 3.2 + BotManager 1.0 active                                                                    | 7     | Ready to run                                                                           |
| 27f   | Network policies conditional: NGINX mode uses namespace selector, AGIC mode uses `ipBlock.cidr`                                         | 7     | **DONE**                                                                               |
| 27g   | `helm dependency update deploy/helm/external-dns && helm template deploy/helm/external-dns` produces external-dns + azure-config Secret | 7     | Ready to run                                                                           |
| 27h   | WAF custom rule blocks non-private IP access to `/admin` URL path (not hostname-based)                                                  | 7     | Ready to run                                                                           |
| 27i   | `tofu plan` with `create_dns=false` shows zero DNS zone resources, external-dns still deploys with `upsert-only` policy                 | 7     | Ready to run                                                                           |
| 27j   | AppGW HTTPS listener references KV cert (`appgw-tls-cert`), HTTP→HTTPS redirect working                                                 | 7     | **DONE**                                                                               |
| 27k   | External DNS `txtOwnerId=abl-platform` and `regexDomainFilter=^abl-.*\.kore\.ai$` prevent managing non-ABL records                      | 7     | Ready to run                                                                           |
| 27l   | AppGW subnet auto-created in existing VNet when `appgw_subnet_id` is empty                                                              | 7     | Ready to run                                                                           |
| 28    | Node failure -> zero downtime (PDB + replicas)                                                                                          | 7     | PENDING                                                                                |

---

## Files Removed (From Original Plan)

These files were planned but are no longer needed due to architectural decisions:

| File                                                | Reason Removed                                                                                  |
| --------------------------------------------------- | ----------------------------------------------------------------------------------------------- |
| `.harness/pipelines/cd-deploy-dev.yaml`             | ArgoCD auto-sync replaces Harness CD                                                            |
| `.harness/pipelines/cd-deploy-staging.yaml`         | PR merge + ArgoCD sync replaces approval pipeline                                               |
| `.harness/pipelines/cd-deploy-prod.yaml`            | PR merge + ArgoCD sync replaces approval pipeline                                               |
| `.harness/pipelines/cd-rollback.yaml`               | `git revert` + ArgoCD sync replaces rollback pipeline                                           |
| `.harness/pipelines/ci-main-build.yaml`             | Renamed to `ci-build.yaml`                                                                      |
| `.harness/pipelines/ci-pr-validation.yaml`          | Removed — build pipeline on merge is the single quality gate; keeps CI simple                   |
| `.harness/services/abl-platform.yaml`               | Harness service entity not needed without Harness CD                                            |
| `.harness/environments/*.yaml`                      | Harness environment entities not needed without Harness CD                                      |
| `.harness/environment-groups/*.yaml`                | Harness environment groups not needed without Harness CD                                        |
| `deploy/argocd/dev.yaml`                            | Replaced by dynamic ApplicationSet                                                              |
| `deploy/argocd/staging.yaml`                        | Replaced by dynamic ApplicationSet                                                              |
| `deploy/argocd/prod-applicationset.yaml`            | Replaced by unified ApplicationSet                                                              |
| `terraform/modules/database/mongodb-atlas/`         | Switched to self-hosted MongoDB on AKS                                                          |
| `terraform/modules/database/clickhouse-cloud/`      | Switched to self-hosted ClickHouse on AKS                                                       |
| `deploy/terraform/modules/cert-manager/*`           | Replaced by TLS at AppGW via Key Vault certificate (no cert-manager needed)                     |
| `deploy/terraform/modules/ingress/nginx/*`          | NGINX Ingress Controller now deployed manually via `kubectl apply` (not Terraform module)       |
| `deploy/terraform/modules/argocd-infra-apps/*`      | Simplified — external-dns managed directly by Terraform Helm release in `modules/external-dns/` |
| `deploy/helm/cert-manager/*`                        | Replaced by TLS at AppGW via Key Vault certificate (no cert-manager needed)                     |
| `deploy/helm/abl-platform/templates/namespace.yaml` | ArgoCD `CreateNamespace=true` handles namespace creation                                        |
| `deploy/terraform/backends/azure.hcl`               | Replaced by Harness IaCM per-workspace state management (no backend block needed)               |
| `deploy/terraform/environments/dev/eastus/*`        | Replaced by workspace-based `platform/` + `environments/dev-azure-eastus.tfvars`                |
| `deploy/terraform/environments/staging/eastus/*`    | Replaced by workspace-based `platform/` + `environments/staging-azure-eastus.tfvars`            |
| `deploy/terraform/environments/prod/eastus/*`       | Replaced by workspace-based `platform/` + `environments/prod-azure-eastus.tfvars`               |
| `deploy/terraform/` (entire directory)              | Moved to `abl-platform-infra` repo                                                              |
| `.harness/pipelines/infra-opentofu.yaml`            | Moved to `abl-platform-infra` repo                                                              |
| `.harness/pipelines/infra-opentofu.yaml`            | Moved to `abl-platform-infra` repo                                                              |
| `deploy/terraform/modules/argocd-image-updater/*`   | **DELETED** — ArgoCD Image Updater fully removed; replaced by CI-push-to-deploy-repo strategy   |
| `deploy/helm/abl-platform/` (entire directory)      | Moved to `abl-platform-deploy` repo (`helm/abl-platform/`)                                      |
| `deploy/argocd/` (entire directory)                 | Moved to `abl-platform-deploy` repo (`argocd/`)                                                 |

---

## Future Phases (Deferred)

| Future Phase                       | What                                                                                                                                                                                                                                                                                                                                                                                                                      | Depends On                              |
| ---------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------- |
| **Istio Service Mesh (AKS addon)** | **mTLS, traffic policies, distributed tracing, authorization policies**                                                                                                                                                                                                                                                                                                                                                   | **Phase 7 complete, service count > 5** |
| FIPS / FedRAMP                     | UBI9 base images, `--force-fips`, RS256 JWT, tamper-evident audit                                                                                                                                                                                                                                                                                                                                                         | Phases 1-7 complete                     |
| Air-gap / On-prem                  | OCI bundles, CLI installer, Kyverno, customer registry (Vault already integrated)                                                                                                                                                                                                                                                                                                                                         | Phases 1-7 complete                     |
| Multi-cloud (AWS)                  | Replicate Azure modules for AWS (VPC, EKS, ECR, Secrets Manager)                                                                                                                                                                                                                                                                                                                                                          | Phase 1 patterns proven                 |
| Multi-cloud (GCP)                  | Replicate for GCP (VPC, GKE, GAR, Secret Manager)                                                                                                                                                                                                                                                                                                                                                                         | Phase 1 patterns proven                 |
| Argo Rollouts / Canary             | Progressive delivery with Prometheus-based analysis                                                                                                                                                                                                                                                                                                                                                                       | Phase 6 observability + Istio mesh      |
| Automated secret rotation          | Vault dynamic secrets or scheduled rotation + ESO sync + Reloader restart                                                                                                                                                                                                                                                                                                                                                 | Phase 3 Vault infra in place            |
| OPA policy enforcement             | Rego policies enforced on `tofu plan` output                                                                                                                                                                                                                                                                                                                                                                              | Phase 2 pipelines                       |
| SLO/SLI & error budgets            | Sloth-generated recording rules, burn-rate alerts                                                                                                                                                                                                                                                                                                                                                                         | Phase 6 dashboards                      |
| JWT RS256 migration                | Asymmetric signing, JWKS endpoint, key rotation pipeline                                                                                                                                                                                                                                                                                                                                                                  | Application refactor                    |
| Drift detection                    | Daily `tofu plan` pipeline, Slack alerts on drift                                                                                                                                                                                                                                                                                                                                                                         | Phase 2 pipelines                       |
| Multi-region prod                  | Additional Azure regions or cross-cloud regions — just add new `.tfvars` + workspace                                                                                                                                                                                                                                                                                                                                      | Phase 1 + Phase 3                       |
| **Next.js 14 → 15 migration**      | Upgrade studio, admin, spec-mock from Next.js 14.2.35 to 15.0.8+. Fixes GHSA-h25m-26qc-wcjf (CVE-2026-23864, DoS via RSC deserialization) — no 14.x patch exists (14 is EOL since Nov 2025). Requires React 18→19 bump. Low-medium effort: no async API breakage (all client components), no Pages Router usage, middleware compatible. Run `npx @next/codemod@canary upgrade latest`. Removes last `.trivyignore` entry. | Phase 5 security scanning complete      |

### Istio Service Mesh — Design Notes

**Trigger**: Add when the platform decomposes beyond 5 services (voice gateway, digital gateway, API gateway, BullMQ workers, runtime, studio, admin) or when SOC2/HIPAA certification requires mTLS between all services.

**Why Istio (AKS managed addon, not self-hosted)**:

- Azure manages the Istio control plane — no upgrade/patching burden
- Closes the "Encryption in Transit: TLS 1.3" gap in the Enterprise Roadmap (currently Pending)
- Native integration with AKS (AppGW + NGINX handles external traffic, Istio handles internal mesh)
- Required for SOC 2 Type II and HIPAA compliance (all inter-service communication encrypted)

**What Istio provides**:

| Capability          | Current State                         | With Istio                                                    |
| ------------------- | ------------------------------------- | ------------------------------------------------------------- |
| Internal mTLS       | None (plain HTTP between services)    | Automatic mTLS between all pods                               |
| Traffic policies    | None                                  | Per-service timeouts (voice: 30ms, digital: 5s, API: 30s)     |
| Circuit breakers    | App-level (RedisCircuitBreaker)       | Network-level (complements app-level)                         |
| Distributed tracing | OTEL SDK in apps                      | Auto-injected trace headers across all hops                   |
| Authorization       | Network policies (L3/L4)              | L7 authorization policies (method, path, headers)             |
| Traffic shifting    | None                                  | Canary deployments via VirtualService (enables Argo Rollouts) |
| Rate limiting       | App-level (per-tenant sliding window) | Network-level global rate limiting                            |

**Architecture with Istio**:

```
Internet → AppGW WAF_v2 (external, Azure-managed, TLS termination)
  → NGINX internal LB (VNet IP)
    → Pod backends (Istio sidecar injected)
      → Internal service-to-service: mTLS via Istio proxies

External traffic: AppGW WAF_v2 → NGINX LB → Pod (Envoy sidecar)
Internal traffic: Pod (Envoy sidecar) ↔ Pod (Envoy sidecar) — mTLS
```

**Implementation outline**:

1. **Enable AKS Istio addon** — Terraform: `service_mesh_profile { mode = "Istio" }` in `azurerm_kubernetes_cluster`
2. **Label namespaces** for sidecar injection: `istio.io/rev: asm-1-XX` on `abl-platform-*` namespaces
3. **PeerAuthentication** — STRICT mTLS policy for all `abl-platform-*` namespaces
4. **AuthorizationPolicy** — restrict which services can call which (e.g., only studio can call runtime `/api/deploy`)
5. **DestinationRule** — per-service connection pools, circuit breaker thresholds, TLS settings
6. **VirtualService** — traffic routing rules (timeout overrides for voice vs digital)
7. **Network policies** — keep existing NGINX namespace selector rules for ingress; Istio handles internal mesh

**Overhead estimate**:

- Control plane: managed by Azure (no cluster resources)
- Sidecar (Envoy): ~50MB RAM + 0.05 CPU per pod
- Latency: ~1-2ms per hop (acceptable for voice <50ms target)
- For 20 pods: ~1GB total sidecar RAM

**Not needed yet because**:

- Current service count is 3 (runtime, studio, admin) — mesh overhead exceeds benefit
- Platform is in development phase, not onboarding tenants yet
- Network policies already provide L3/L4 isolation
- App-level circuit breakers and rate limiting handle current needs

---

## Pending: Proper Health Check Endpoints

**Status**: Pending
**Priority**: Medium
**Tracking**: ABLP-TBD

### Current State

Health probe paths in Helm values are set to generic endpoints because the services lack dedicated startup/readiness/liveness routes:

| Service | Startup Probe     | Readiness Probe | Liveness Probe | Notes                                                                       |
| ------- | ----------------- | --------------- | -------------- | --------------------------------------------------------------------------- |
| Runtime | `/health`         | `/health`       | `/health`      | Single endpoint, checks MongoDB connection                                  |
| Studio  | `/health/startup` | `/health/ready` | `/health/live` | No health route — works by accident (Next.js returns 200 for unknown paths) |
| Admin   | `/api/health`     | `/api/health`   | `/api/health`  | Returns `{ status: "ok" }`, no dependency checks                            |

### Required Implementation

Each service should implement three separate health endpoints following Kubernetes probe semantics:

**1. Startup Probe** (`GET /health/startup`)

- Returns 200 once the process is ready to accept traffic
- For runtime: server listening + MongoDB connected + ClickHouse connected
- For studio: Next.js server ready
- For admin: Next.js server ready

**2. Readiness Probe** (`GET /health/ready`)

- Returns 200 when the service can handle requests
- Returns 503 when the service should be temporarily removed from load balancer
- For runtime: MongoDB connection healthy + ClickHouse reachable
- For studio: upstream runtime API reachable (optional)
- For admin: basic check

**3. Liveness Probe** (`GET /health/live`)

- Returns 200 if the process is alive (not deadlocked)
- Should NOT check external dependencies (to avoid cascade restarts)
- Lightweight check: process alive, event loop responsive

### Files to Modify

- `apps/runtime/src/server.ts` — Add `/health/startup`, `/health/ready`, `/health/live` routes
- `apps/studio/src/app/api/health/startup/route.ts` — New file
- `apps/studio/src/app/api/health/ready/route.ts` — New file
- `apps/studio/src/app/api/health/live/route.ts` — New file
- `apps/admin/src/app/api/health/startup/route.ts` — New file
- `apps/admin/src/app/api/health/ready/route.ts` — New file
- `apps/admin/src/app/api/health/live/route.ts` — New file
- `helm/abl-platform/values.yaml` (in `abl-platform-deploy`) — Update probe paths to new endpoints
- `helm/abl-platform/templates/admin/deployment.yaml` (in `abl-platform-deploy`) — Update hardcoded probe paths

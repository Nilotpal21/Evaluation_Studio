---
name: 'devops-query'
description: 'Use when querying Harness CI/CD builds, deployments, service health, logs, or production debugging data.'
---

# DevOps Query — Harness CI/CD + Coroot Observability

> Use this skill when querying build pipelines, deployment failures, service health, logs, or debugging production issues.

## Harness Context

```
Account:  mpHRLwiFS6aJ_4tBSlMv0w
Org:      default
Project:  ABLPlatform
```

Always pass `org_id: "default"` and `project_id: "ABLPlatform"` to every `harness_*` tool call.

### Pipelines

| Identifier       | Name                      | Trigger       | Purpose                                   |
| ---------------- | ------------------------- | ------------- | ----------------------------------------- |
| `ci_build`       | CI - Build                | push / manual | Build, test, Docker images, deploy to dev |
| `infra_opentofu` | Infrastructure - OpenTofu | manual        | Infrastructure provisioning via OpenTofu  |

### CI Build Stages (in order)

1. **generate_tag** — Generate image tag from git
2. **build_test** — `pnpm install`, `pnpm build`, `pnpm test` (integration tests)
3. **Docker builds** (parallel) — One per service:
   - `docker_runtime`, `docker_studio`, `docker_admin`
   - `docker_search_ai`, `docker_search_ai_runtime`
   - `docker_docling`, `docker_bge_m3`, `docker_preprocessing`
   - `docker_workflow_engine`, `docker_multimodal`, `docker_nlu_sidecar`
   - `docker_crawler_go_worker`, `docker_crawler_mcp_server`
   - `docker_codetool_sandbox`
4. **code_security_scan** — Trivy vulnerability scan
5. **update_dev_deploy** — Update Helm values for ArgoCD

### Execution Status Mapping

IMPORTANT: Harness uses these statuses — filter accordingly:

- `Failed` — Step/stage returned error
- `Aborted` — Pipeline cancelled (often after a failure in a prior stage)
- `IgnoreFailed` — Failed but configured to continue
- `Success`, `Running`, `Skipped`, `NotStarted`

When searching for "failed builds", include BOTH `Failed` AND `Aborted` statuses.

### Common Failure Patterns

| Stage        | Step                | Error                | Root Cause                             |
| ------------ | ------------------- | -------------------- | -------------------------------------- |
| `build_test` | `integration_tests` | `exit status 1`      | Test failures (check logs for details) |
| `build_test` | `integration_tests` | `ECONNREFUSED :6380` | Redis not available in CI              |
| `docker_*`   | `trivy_scan`        | `exit status 1`      | Vulnerability scan failure             |
| `docker_*`   | `liteEngineTask`    | `timeout`            | Docker build exceeded time limit       |

### Log Access Workaround

The Harness MCP API cannot download execution logs directly (HTTP 400). Use this curl pattern:

Use the `scripts/harness-logs.sh` helper (uses PAT from `$HARNESS_API_KEY`):

```bash
# Full logs (last 200 lines)
./scripts/harness-logs.sh <execution_id> <run_sequence> <stage_id> <step_id>

# Filtered logs
./scripts/harness-logs.sh <execution_id> <run_sequence> <stage_id> <step_id> "error|fail|ECONNREFUSED"
```

Examples:

```bash
# Mani's #228 unit test failures
./scripts/harness-logs.sh j3TdhsIpTiWEPg6UX4Iusg 228 build_test unit_tests "FAIL|Error"

# Mani's #224 integration test Redis errors
./scripts/harness-logs.sh wN2o3w0XQZK1_6hosMoBLg 224 build_test integration_tests "ECONNREFUSED|mongo|redis"

# Trivy scan failure
./scripts/harness-logs.sh -GfhQOhhR_atOmk9OHo8oA 230 docker_codetool_sandbox trivy_scan
```

The `harness_diagnose` MCP tool with `include_logs: true` only returns a single truncated error line. Always use `scripts/harness-logs.sh` for real log analysis.

## Coroot Context

```
Base URL:   https://coroot-agents-dev.kore.ai/
Project ID: vz762g8o
Project:    default
Auth:       Username/Password (env vars COROOT_USERNAME, COROOT_PASSWORD)
```

Always pass `project_id: "vz762g8o"` to every `coroot_*` tool call.

### ABL Platform Applications (29 total)

#### Core Services

| Coroot App ID                                                   | Service     | Type       |
| --------------------------------------------------------------- | ----------- | ---------- |
| `vz762g8o:abl-platform-dev:Deployment:abl-platform-dev-runtime` | Runtime     | Deployment |
| `vz762g8o:abl-platform-dev:Deployment:abl-platform-dev-studio`  | Studio (UI) | Deployment |
| `vz762g8o:abl-platform-dev:Deployment:abl-platform-dev-admin`   | Admin       | Deployment |

#### Search AI Services

| Coroot App ID                                                              | Service                  | Type       |
| -------------------------------------------------------------------------- | ------------------------ | ---------- |
| `vz762g8o:abl-platform-dev:Deployment:abl-platform-dev-search-ai`          | Search AI                | Deployment |
| `vz762g8o:abl-platform-dev:Deployment:abl-platform-dev-search-ai-runtime`  | Search AI Runtime        | Deployment |
| `vz762g8o:abl-platform-dev:Deployment:abl-platform-dev-bge-m3`             | BGE-M3 Embeddings        | Deployment |
| `vz762g8o:abl-platform-dev:Deployment:abl-platform-dev-docling`            | Docling (Doc Processing) | Deployment |
| `vz762g8o:abl-platform-dev:Deployment:abl-platform-dev-preprocessing`      | Preprocessing            | Deployment |
| `vz762g8o:abl-platform-dev:Deployment:abl-platform-dev-crawler-go-worker`  | Crawler Go Worker        | Deployment |
| `vz762g8o:abl-platform-dev:Deployment:abl-platform-dev-crawler-mcp-server` | Crawler MCP Server       | Deployment |

#### Agent/Workflow Services

| Coroot App ID                                                              | Service          | Type       |
| -------------------------------------------------------------------------- | ---------------- | ---------- |
| `vz762g8o:abl-platform-dev:Deployment:abl-platform-dev-workflow-engine`    | Workflow Engine  | Deployment |
| `vz762g8o:abl-platform-dev:Deployment:abl-platform-dev-multimodal-service` | Multimodal       | Deployment |
| `vz762g8o:abl-platform-dev:Deployment:abl-platform-dev-codetool-sandbox`   | Codetool Sandbox | Deployment |
| `vz762g8o:abl-platform-dev:Deployment:abl-platform-dev-livekit`            | LiveKit (WebRTC) | Deployment |

#### Infrastructure

| Coroot App ID                                                               | Service            | Type            |
| --------------------------------------------------------------------------- | ------------------ | --------------- |
| `vz762g8o:abl-platform-dev:StatefulSet:abl-platform-dev-mongodb`            | MongoDB            | StatefulSet     |
| `vz762g8o:abl-platform-dev:DatabaseCluster:abl-platform-dev-redis`          | Redis              | DatabaseCluster |
| `vz762g8o:abl-platform-dev:StatefulSet:abl-platform-dev-qdrant`             | Qdrant (Vector DB) | StatefulSet     |
| `vz762g8o:abl-platform-dev:StatefulSet:abl-platform-dev-restate`            | Restate            | StatefulSet     |
| `vz762g8o:abl-platform-dev:StatefulSet:abl-platform-dev-clickhouse-shard-0` | ClickHouse         | StatefulSet     |

#### Service Groups (for "search components" queries)

- **search**: search-ai, search-ai-runtime, bge-m3, docling, preprocessing, crawler-go-worker, crawler-mcp-server
- **core**: runtime, studio, admin
- **infra**: mongodb, redis, qdrant, restate, clickhouse

### Coroot Capabilities

- `get_application` — SLIs, resource usage, dependencies
- `get_application_logs` — Container logs (searchable)
- `get_application_traces` — Distributed tracing
- `get_application_profiling` — CPU/memory profiling
- `get_application_rca` — Root cause analysis for incidents
- `get_deployments_overview` — Recent deployments with rollout status
- `get_project_status` — Overall health dashboard

## Team Directory

### Core Team (ABL Platform / Search AI)

| Name               | Email                      | Harness Display Name | Focus                            |
| ------------------ | -------------------------- | -------------------- | -------------------------------- |
| Bharat Rekha       | bharat.rekha@kore.com      | Bharat               | Search AI, Platform Architecture |
| Mani Kumar Nadella | manikumar.nadella@kore.com | Mani Kumar Nadella   | Search AI                        |
| Mounika Vemula     | mounika.vemula@kore.com    | (check Harness)      | Search AI                        |

### Frequent Build Triggers

| Harness Display Name | Email                       |
| -------------------- | --------------------------- |
| Ershad Ali Mohammad  | ershadali.mohammad@kore.com |
| Sai Kumar Shetty     | saikumar.shetty@kore.com    |
| Prasanna Venkatesh   | prasanna.manoharan@kore.com |
| Sandeep Kasturi      | sandeep.kasturi@kore.com    |

### Name Aliases

When user says → Search for:

- "mani" → "Mani Kumar Nadella" or "manikumar.nadella"
- "bharat" → "Bharat" or "bharat.rekha"
- "mounika" → "mounika.vemula"
- "ershad" → "Ershad Ali Mohammad" or "ershadali.mohammad"
- "sai" → "saikumar.shetty" (also check saikumar.dooluri)
- "prasanna" → "Prasanna Venkatesh" or "prasanna.manoharan"

## Query Patterns

### 1. Find Failed Builds by Person

```
Step 1: harness_list(resource_type="execution", org_id="default", project_id="ABLPlatform", limit=50)
Step 2: For each execution, harness_diagnose(url=<execution_url>) to check triggered_by
Step 3: Match triggered_by against team directory
```

Note: The list API does NOT return triggered_by — you must diagnose each execution.

### 2. Get Failure Logs

```
Step 1: harness_diagnose(url=<url>, options={include_logs: true, log_snippet_lines: 200})
Step 2: If logs are truncated or blocked, use the curl workaround (see Log Access above)
```

### 3. Service Health Check (Coroot)

```
Step 1: get_application(project_id="vz762g8o", app_id="vz762g8o:abl-platform-dev:Deployment:abl-platform-dev-search-ai")
Step 2: get_application_logs(project_id="vz762g8o", app_id=<same>) for recent errors
```

### 4. Compound: Build Failed + Check Production Health

When a build fails for a search component:

```
Step 1: Diagnose Harness execution → identify failed component
Step 2: Map component to Coroot app:
        docker_search_ai → abl-platform-dev-search-ai
        docker_search_ai_runtime → abl-platform-dev-search-ai-runtime
        docker_bge_m3 → abl-platform-dev-bge-m3
        (etc.)
Step 3: get_application(project_id="vz762g8o", app_id=<mapped_id>) → check if previous version is healthy
Step 4: get_application_logs → check for related errors in production
```

### 5. Compound: Deployment Regression Detection

```
Step 1: get_deployments_overview(project_id="vz762g8o") → find recent deployments
Step 2: get_application(app_id=<deployed_app>) → check SLIs before/after
Step 3: get_application_traces(app_id=<deployed_app>) → look for slow/error traces
Step 4: Cross-reference with harness_diagnose → find which build introduced the change
```

### 6. Search Component Health Summary

```
For each search service:
  get_application(project_id="vz762g8o", app_id=<search_app_id>)
Summarize: CPU, memory, error rate, latency for all search services
```

### 7. Debug Production Error

```
Step 1: get_application_logs(project_id="vz762g8o", app_id=<service>) → find error patterns
Step 2: get_application_traces(project_id="vz762g8o", app_id=<service>) → trace the request
Step 3: get_application_rca(project_id="vz762g8o", app_id=<service>) → automated root cause
Step 4: get_deployments_overview → check if error correlates with a deployment
Step 5: harness_diagnose → find what changed in that deployment
```

## Harness-to-Coroot Service Mapping

| Harness Docker Stage        | Coroot Application Name               |
| --------------------------- | ------------------------------------- |
| `docker_runtime`            | `abl-platform-dev-runtime`            |
| `docker_studio`             | `abl-platform-dev-studio`             |
| `docker_admin`              | `abl-platform-dev-admin`              |
| `docker_search_ai`          | `abl-platform-dev-search-ai`          |
| `docker_search_ai_runtime`  | `abl-platform-dev-search-ai-runtime`  |
| `docker_docling`            | `abl-platform-dev-docling`            |
| `docker_bge_m3`             | `abl-platform-dev-bge-m3`             |
| `docker_preprocessing`      | `abl-platform-dev-preprocessing`      |
| `docker_workflow_engine`    | `abl-platform-dev-workflow-engine`    |
| `docker_multimodal`         | `abl-platform-dev-multimodal-service` |
| `docker_crawler_go_worker`  | `abl-platform-dev-crawler-go-worker`  |
| `docker_crawler_mcp_server` | `abl-platform-dev-crawler-mcp-server` |
| `docker_codetool_sandbox`   | `abl-platform-dev-codetool-sandbox`   |
| `docker_nlu_sidecar`        | (no direct Coroot mapping)            |

## PAT Token Scope

To check your Harness PAT permissions:

1. Go to https://app.harness.io → My Profile → My API Keys
2. Click on your token → View permissions
3. Required scopes: Pipeline Execute, Pipeline View, Connector View

The MCP `harness-mcp-v2` uses the PAT from `$HARNESS_API_KEY` env var. Session JWTs (from browser) have broader access but expire quickly.

# gVisor Sandbox — Architecture & Deployment

**Date:** 2026-03-05
**Status:** Implemented
**Branch:** `runtime-changes-v2`
**Source:** Migrated from `custom-code-executor` repo (`dockerfile_codetool` on `develop` branch)

## Summary

The gVisor sandbox provides isolated code execution for agent tools. User-authored Python and JavaScript code runs inside a gVisor (`runsc`) container with seccomp policies, resource limits, and network restrictions — no code ever executes in the runtime process itself.

This document covers the full system: Docker image, Kubernetes deployment (Helm), the memory API bridge that lets sandbox code read/write agent memory, and the security model.

## Architecture Overview

```
                    ┌─────────────────────────────────────────────────────────┐
                    │  Runtime Pod                                            │
                    │                                                         │
 User message ────► │  Express (3112) ──► GvisorSandboxRunner                │
                    │       │                    │                            │
                    │       │              POST /execute-script               │
                    │       │              + JWT + base_url                   │
                    │       │                    │                            │
                    │       │                    ▼                            │
                    │       │         ┌──────────────────────┐               │
                    │       │         │ Sandbox Pod (8001)   │               │
                    │       │         │  gVisor + runsc      │               │
                    │       │         │                      │               │
                    │       │         │  User code executes  │               │
                    │       │         │  memory.get/set ─────┼───┐           │
                    │       │         └──────────────────────┘   │           │
                    │       │                                    │           │
                    │       │         POST /api/v1/memory        │           │
                    │       │         (JWT auth)                 │           │
                    │       │                    ┌───────────────┘           │
                    │       │                    ▼                            │
                    │  nginx sidecar (3113)                                   │
                    │    ONLY: POST /api/v1/memory → localhost:3112           │
                    │    ALL OTHER PATHS → 403                               │
                    │       │                                                │
                    │       ▼                                                │
                    │  Memory API route ──► MemoryBridgeRegistry             │
                    │       │                    │                            │
                    │       │              sessionId lookup                   │
                    │       │                    ▼                            │
                    │       │              ToolMemoryBridge                   │
                    │       │              (session/user/project scope)       │
                    └───────┼────────────────────────────────────────────────┘
                            ▼
                    Response to user
```

## 1. Docker Image

The codetool sandbox is a **static Docker image** at `services/codetool-sandbox/` containing:

- **Host layer** (Ubuntu 22.04): Python 3.12, gVisor runtime (`runsc`), CNI networking, nginx reverse proxy
- **Sandbox rootfs** (debootstrap): Python 3.10 with venv, Node.js 20 via NVM, seccomp policies
- **Execution harness**: FastAPI server (`execute_script.py`) inside the sandbox that accepts code via `/execute-script` endpoint

When a pod starts:

1. `main.py` initializes: downloads service files, configures gVisor network, writes OCI config
2. `runsc` starts the sandboxed container with the execution harness
3. The harness serves `/execute-script` (POST) and `/health` (GET) on port 8001
4. `GvisorSandboxRunner` in `abl-platform` sends code to execute over HTTP

### File Structure

```
services/codetool-sandbox/
├── Dockerfile                      # Ubuntu 22.04 + gVisor + Python 3.10/3.12 + Node.js 20
├── requirements.txt                # Host deps: fastapi, uvicorn, httpx, starlette
├── requirements_codetool.txt       # Sandbox deps: fastapi, uvicorn, httpx, pyseccomp, boto3
├── memory_service_sdk-0.1.0-py3-none-any.whl  # Memory service SDK for sandbox
│
├── src/                            # Host-side code (runs outside sandbox)
│   ├── main.py                     # Entrypoint: init gVisor, download files, start runsc
│   ├── utils.py                    # Pod lifecycle: status API, file download, network setup
│   ├── constants.py                # All env var definitions and paths
│   ├── logger.py                   # JSON logging with OpenTelemetry support
│   └── config_template.json        # OCI runtime spec for runsc (seccomp, namespaces, mounts)
│
├── src/network_config/             # Network isolation
│   ├── network_build.sh            # CNI bridge + domain whitelisting via iptables
│   ├── nginx.conf.template         # Reverse proxy to sandbox (port 8001)
│   └── delete_network_namespace.sh # Network namespace cleanup
│
├── src/rootfs_py_codetool/         # Sandbox-side code (runs inside gVisor)
│   ├── execute_script.py           # FastAPI server: /health, /execute-script endpoints
│   ├── seccomp_policy.py           # Syscall restriction definitions
│   └── utils.py                    # Resource limits (CPU_TIME_LIMIT, MEMORY_LIMIT)
│
├── runtime/                        # Python execution runtime (inside sandbox)
│   ├── __init__.py
│   ├── main.py                     # KoreRuntime class with memory SDK integration
│   ├── utils.py                    # AST-based security validation (blocks dangerous modules)
│   └── runtime_constants.py        # Memory operation constants
│
├── runtime_js/                     # JavaScript execution runtime (inside sandbox)
│   ├── package.json                # AWS SDK, openai, axios, cheerio, redis, etc.
│   ├── index.js                    # KoreRuntime JS with global-agent proxy support
│   ├── memory_manager.js           # Memory management for JS (accepts configurable baseUrl)
│   └── utils.js                    # JS execution utilities
│
├── custom_logger_py/lib/           # Python logging
│   └── korelogger-0.1.0-py3-none-any.whl
│
└── custom_logger_js/               # JavaScript logging
    ├── package.json
    ├── index.js
    └── context.js
```

## 2. Memory API Bridge

Sandbox code calls `memory.get_content()` / `memory.set_content()` / `memory.delete_content()`. These need to reach the runtime's in-process `ToolMemoryBridge`, which resolves memory scopes (session, user, project) from MEMORY declarations.

The legacy system expected `http://agentic-design/api/v1/memory` — a monolithic backend. ABL replaces this with a direct HTTP callback to the runtime pod.

### How it works

1. **`GvisorSandboxRunner`** generates a short-lived JWT (sandbox secret, 5 min expiry) carrying `sessionId`, `accountId`, `userId`, `projectId`, `envId`. Sends it as `Authorization` header + `base_url` in request body.

2. **Sandbox runtimes** (Python `runtime/main.py`, JS `runtime_js/index.js`) receive `base_url` from execution context and pass it to their memory managers. Falls back to `http://agentic-design` if empty (legacy compat).

3. **Memory managers** (`MemoryContentManager` for Python, `MemoryManager` for JS) POST to `{base_url}/api/v1/memory` with `{ action, memoryStoreName, payload? }`.

4. **Runtime route** (`POST /api/v1/memory` in `routes/memory-api.ts`):
   - Verifies sandbox JWT (separate secret from main auth)
   - Looks up `ToolMemoryBridge` from `MemoryBridgeRegistry` by `sessionId`
   - Verifies `accountId` matches (tenant isolation — returns 404 on mismatch)
   - Routes by `action`: `get` / `set` / `delete`

5. **`MemoryBridgeRegistry`** (`memory-bridge-registry.ts`) is a bounded Map (max 10,000 entries, 1hr TTL, LRU eviction). Registered when tool executor is wired in `llm-wiring.ts`, unregistered in `endSession()`.

### Key files

| File                                                            | Purpose                                         |
| --------------------------------------------------------------- | ----------------------------------------------- |
| `apps/runtime/src/services/execution/memory-bridge-registry.ts` | Session → ToolMemoryBridge registry (singleton) |
| `apps/runtime/src/routes/memory-api.ts`                         | `POST /api/v1/memory` HTTP endpoint             |
| `packages/compiler/.../gvisor-sandbox-runner.ts`                | Sends `base_url` in request body to sandbox pod |
| `apps/runtime/src/services/execution/llm-wiring.ts`             | Registers bridge + passes `memoryApiBaseUrl`    |
| `apps/runtime/src/services/runtime-executor.ts`                 | Unregisters bridge on `endSession()`            |
| `packages/config/src/schemas/sandbox.schema.ts`                 | `memoryApiBaseUrl` config field                 |
| `apps/runtime/src/config/index.ts`                              | `SANDBOX_MEMORY_API_BASE_URL` env mapping       |
| `services/codetool-sandbox/runtime/main.py`                     | Reads `base_url` from context                   |
| `services/codetool-sandbox/runtime_js/index.js`                 | Passes `baseUrl` to MemoryManager               |
| `services/codetool-sandbox/runtime_js/memory_manager.js`        | Accepts configurable `baseUrl`                  |

### Runtime config

| Env Var                       | Config Path                | Default                | Purpose                     |
| ----------------------------- | -------------------------- | ---------------------- | --------------------------- |
| `SANDBOX_PYTHON_POD_URL`      | `sandbox.pythonPodUrl`     | `http://kr-python-svc` | Python sandbox pod URL      |
| `SANDBOX_JAVASCRIPT_POD_URL`  | `sandbox.javascriptPodUrl` | (dev URL)              | JS sandbox pod URL          |
| `SANDBOX_JWT_SECRET`          | `sandbox.jwtSecret`        | (none)                 | JWT secret for sandbox auth |
| `SANDBOX_JWT_EXPIRY_SECONDS`  | `sandbox.jwtExpirySeconds` | `300`                  | JWT token lifetime          |
| `SANDBOX_MEMORY_API_BASE_URL` | `sandbox.memoryApiBaseUrl` | `''`                   | Memory API callback URL     |

## 3. Kubernetes Deployment (Helm)

All Helm templates are in `abl-platform-deploy/helm/abl-platform/`. Gated by `codetoolSandbox.enabled`.

### Templates created

| Template                                                 | Purpose                                                                                                      |
| -------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------ |
| `templates/codetool-sandbox/configmap.yaml`              | Env vars from `values.codetoolSandbox.configMap`                                                             |
| `templates/codetool-sandbox/deployment.yaml`             | Pod spec with `privileged: true`, `runAsUser: 0` (gVisor needs root; container drops to UID 1024 internally) |
| `templates/codetool-sandbox/service.yaml`                | ClusterIP, port 80 → 8001                                                                                    |
| `templates/network/network-policy-codetool-sandbox.yaml` | Strict egress (see Security below)                                                                           |
| `templates/runtime/configmap-memory-proxy.yaml`          | Nginx config for memory API sidecar                                                                          |

### Templates modified

| Template                            | Change                                                                                        |
| ----------------------------------- | --------------------------------------------------------------------------------------------- |
| `templates/runtime/deployment.yaml` | Added nginx sidecar container (port 3113), volumes for config                                 |
| `templates/runtime/service.yaml`    | Added port 3113 (`memory-api`)                                                                |
| `templates/runtime/configmap.yaml`  | Derived `SANDBOX_PYTHON_POD_URL`, `SANDBOX_JAVASCRIPT_POD_URL`, `SANDBOX_MEMORY_API_BASE_URL` |
| `values.yaml`                       | Added `codetoolSandbox:` section (2 replicas, 250m-2 CPU, 512Mi-2Gi)                          |
| `values-dev.yaml`                   | Dev overrides (1 replica, debug, lower resources)                                             |

### Values structure

```yaml
codetoolSandbox:
  enabled: true
  replicas: 2
  image:
    repository: abl-codetool-sandbox
    tag: ''
  port: 8001
  resources:
    requests: { cpu: 250m, memory: 512Mi }
    limits: { cpu: '2', memory: 2Gi }
  configMap:
    EXECUTABLE_TYPE: codetool_python
    TIMEOUT: '60000'
    DEBUG: 'false'
    GALE_ENV: production
    PORT: '8001'
```

## 4. Security Model

Three-layer defense for sandbox pod egress:

### Layer 1: NetworkPolicy (port-level)

The `network-policy-codetool-sandbox.yaml` restricts sandbox pod traffic:

- **Ingress**: Only from runtime pods (component: `runtime`)
- **Egress**: Only to:
  - kube-dns (port 53, UDP/TCP) for DNS resolution
  - Runtime pods port 3113 (memory API sidecar)
- **All other egress denied** — no access to MongoDB, Redis, ClickHouse, admin, search-ai, external HTTPS, or runtime port 3112 (main API)

### Layer 2: Nginx sidecar (path-level)

An nginx sidecar on port 3113 in the runtime pod:

- **Only proxies** `POST /api/v1/memory` to `localhost:3112`
- **Returns 403** for all other HTTP methods and paths
- Even if sandbox code somehow reaches port 3113, it cannot call any other runtime API endpoint

### Layer 3: JWT (identity-level)

The memory API route verifies a sandbox-specific JWT:

- Signed with `sandbox.jwtSecret` (distinct from the main auth secret)
- Short-lived (5 min default via `sandbox.jwtExpirySeconds`)
- Carries `sessionId` + `accountId` for tenant isolation
- `accountId` mismatch returns 404 (no existence leaks)

### Result

Sandbox pods can **only** call `POST /api/v1/memory` with a valid session JWT. They cannot:

- Access any other runtime endpoint
- Reach MongoDB, Redis, or other infrastructure
- Make external HTTPS calls
- Access other tenants' memory

## 5. Harness CI Integration

### Pipeline changes (`.harness/pipelines/ci-build.yaml`)

1. **Selector**: `codetool-sandbox` added to `build_services` dropdown
2. **Build stage**: New parallel stage `Docker - Codetool Sandbox`
   - Uses `docker_build_python_service` template
   - **Opt-in only**: condition is `(","+build_services+",").contains(",codetool-sandbox,")`
   - Does NOT include `== "all"` check — never builds automatically
3. **Deploy mapping**: `codetoolSandbox.image.tag` added to dev deploy script
4. **Success condition**: `docker_codetool_sandbox` added to `update_dev_deploy` trigger

### Image details

| Property      | Value                                              |
| ------------- | -------------------------------------------------- |
| Registry      | `acrabldev.azurecr.io`                             |
| Repository    | `abl-codetool-sandbox`                             |
| Tags          | `<sha>`, `main-YYYYMMDD`, `latest`                 |
| Template      | `docker_build_python_service` (12Gi memory, 4 CPU) |
| Build context | `services/codetool-sandbox/`                       |

### How to build

**Harness CI:** Select `codetool-sandbox` from the `build_services` dropdown when running the pipeline manually.

**Local (amd64 Linux only):**

```bash
docker compose up codetool-sandbox
```

Note: Will not work on Apple Silicon — Dockerfile is hardcoded to amd64 (debootstrap, CNI plugins).

## 6. Connection to abl-platform

The `GvisorSandboxRunner` in `packages/compiler/src/platform/constructs/executors/gvisor-sandbox-runner.ts` communicates with the codetool sandbox over HTTP:

- Sends code to `POST /execute-script` with `{ script, args, envParams, executionMode, codeType, base_url }`
- Receives `{ response, logs, error }` from the sandbox
- Configured via `SANDBOX_PYTHON_POD_URL` and `SANDBOX_JAVASCRIPT_POD_URL` env vars
- Both point to the same codetool pod since `execute_script.py` handles Python and JavaScript
- `base_url` tells the sandbox where to send memory callbacks (the runtime's nginx sidecar)

## 7. Environment Variables

### Sandbox Pod

| Variable          | Purpose                                                  |
| ----------------- | -------------------------------------------------------- |
| `EXECUTABLE_TYPE` | `python`, `javascript`, `codetool_python`, `codetool_js` |
| `TIMEOUT`         | Execution timeout (seconds, default: 60)                 |
| `DEBUG`           | Debug logging (`True`/`False`)                           |
| `GALE_ENV`        | Environment identifier                                   |
| `PORT`            | Listen port (default: 8001)                              |

### Execution Limits (optional)

| Variable                 | Default      | Purpose                      |
| ------------------------ | ------------ | ---------------------------- |
| `CPU_TIME_LIMIT_SECONDS` | `30`         | CPU time limit per execution |
| `MEMORY_LIMIT_BYTES`     | `1073741824` | Memory limit (1GB)           |

### Proxy (optional)

| Variable                     | Default                   |
| ---------------------------- | ------------------------- |
| `PROXY_ENABLED`              | `true`                    |
| `PROXY_GLOBAL_NATIVE`        | `true`                    |
| `HTTP_PROXY` / `HTTPS_PROXY` | `http://squid:3128`       |
| `NO_PROXY`                   | `localhost,127.0.0.1,...` |
| `ALLOW_CUSTOM_AGENTS`        | `false`                   |

## 8. Known Limitations

- **amd64 only** — `debootstrap --arch=amd64` and `cni-plugins-linux-amd64` are hardcoded
- **Large image** (~2-5GB) due to full Ubuntu rootfs inside the image
- **Binary wheels in git** — `memory_service_sdk` and `korelogger` `.whl` files are checked in; should move to a private PyPI/artifact registry
- **Build time** — ~30+ min due to Python compilation from source, debootstrap, and NVM/Node.js installation
- **Privileged mode** — requires `securityContext.privileged: true` for gVisor (`runsc`)

## 9. Future Work

- Dynamic pod provisioning: backend creates/deletes pods per deployment via K8s API
- ArgoCD integration for auto-sync
- ARM64 support (requires multi-arch debootstrap + CNI plugins)
- Move `.whl` artifacts to private PyPI registry

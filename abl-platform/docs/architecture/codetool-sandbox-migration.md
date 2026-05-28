# Codetool Sandbox Image Migration

**Date:** 2026-03-04
**Status:** Implemented
**Branch:** `runtime-changes-v2`
**Source:** Migrated from `custom-code-executor` repo (`dockerfile_codetool` on `develop` branch)

## Summary

Migrated the gVisor-based codetool sandbox Docker image from the standalone `custom-code-executor` repository into the `abl-platform` monorepo at `services/codetool-sandbox/`. The image is built via the existing Harness CI pipeline as an opt-in service — it only builds when explicitly selected, never on `all`.

## Scope

**Implemented:**

- Copied 26 source files into `services/codetool-sandbox/`
- Dockerfile adapted for `services/codetool-sandbox/` build context
- Added to `docker-compose.yml` for local development
- Added opt-in Harness CI stage (excluded from `build_services=all`)
- Added to dev deploy tag mapping (`codetoolSandbox.image.tag`)

**Out of scope (future work):**

- Dynamic pod provisioning (K8s pod creation/deletion from backend)
- Helm chart templates in `abl-platform-deploy`
- ArgoCD auto-sync integration

## Architecture

The codetool sandbox is a **static Docker image** containing:

- **Host layer** (Ubuntu 22.04): Python 3.12, gVisor runtime (`runsc`), CNI networking, nginx reverse proxy
- **Sandbox rootfs** (debootstrap): Python 3.10 with venv, Node.js 20 via NVM, seccomp policies
- **Execution harness**: FastAPI server (`execute_script.py`) inside the sandbox that accepts code via `/execute-script` endpoint

The image is a sandboxed code execution environment. When a pod starts:

1. `main.py` initializes: downloads service files, configures gVisor network, writes OCI config
2. `runsc` starts the sandboxed container with the execution harness
3. The harness serves `/execute-script` (POST) and `/health` (GET) on port 8001
4. The `GvisorSandboxRunner` in `abl-platform` sends code to execute over HTTP

Pod lifecycle (deploy/undeploy) is managed externally — the image itself is static.

## File Structure

```
services/codetool-sandbox/          # 27 files total
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
│   ├── memory_manager.js           # Memory management for JS
│   └── utils.js                    # JS execution utilities
│
├── custom_logger_py/lib/           # Python logging
│   └── korelogger-0.1.0-py3-none-any.whl  # OpenTelemetry-based logger
│
└── custom_logger_js/               # JavaScript logging
    ├── package.json                # OpenTelemetry dependencies
    ├── index.js                    # OTEL logger implementation
    └── context.js                  # Context management
```

## Harness CI Integration

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

## docker-compose.yml

```yaml
codetool-sandbox:
  build:
    context: ./services/codetool-sandbox
    dockerfile: Dockerfile
  container_name: abl-codetool-sandbox
  restart: unless-stopped
  ports:
    - '8001:8001'
  privileged: true
  environment:
    EXECUTABLE_TYPE: codetool_python
    TIMEOUT: '60'
    DEBUG: 'True'
    GALE_ENV: local
  healthcheck:
    test: ['CMD', 'curl', '-f', 'http://localhost:8001/health']
    interval: 30s
    timeout: 10s
    retries: 3
    start_period: 120s
```

## Environment Variables

### Required (set per pod at creation time)

| Variable          | Purpose                                                  |
| ----------------- | -------------------------------------------------------- |
| `ACCOUNT_ID`      | Account ID for logging/tracing                           |
| `DEPLOYMENT_ID`   | Deployment identifier                                    |
| `X_TRACEID`       | Trace ID for request tracking                            |
| `ML_APP_HOST`     | ML app hostname (undeploy notification)                  |
| `APP_HOST`        | Backend hostname (status updates)                        |
| `API_KEY`         | Auth key for APP_HOST/ML_APP_HOST                        |
| `EXECUTABLE_TYPE` | `python`, `javascript`, `codetool_python`, `codetool_js` |

### Execution Limits (optional, have defaults)

| Variable                 | Default      | Purpose                      |
| ------------------------ | ------------ | ---------------------------- |
| `TIMEOUT`                | `60`         | Execution timeout (seconds)  |
| `CPU_TIME_LIMIT_SECONDS` | `30`         | CPU time limit per execution |
| `MEMORY_LIMIT_BYTES`     | `1073741824` | Memory limit (1GB)           |

### Service Files (optional)

| Variable                       | Default | Purpose                           |
| ------------------------------ | ------- | --------------------------------- |
| `SERVICE_FILES_PATH`           | None    | Path or URL to service files zip  |
| `GVISOR_ENVIRONMENT_VARIABLES` | `{}`    | Extra env vars for sandbox (JSON) |
| `HARDWARE_INFO`                | `{}`    | Hardware config (JSON)            |

### Network (optional)

| Variable              | Default | Purpose                               |
| --------------------- | ------- | ------------------------------------- |
| `WHITELISTED_DOMAINS` | `[]`    | Allowed external domains (JSON array) |

### Proxy (optional, all have defaults)

| Variable                          | Default                                                     |
| --------------------------------- | ----------------------------------------------------------- |
| `PROXY_ENABLED`                   | `true`                                                      |
| `PROXY_GLOBAL_NATIVE`             | `true`                                                      |
| `HTTPS_SQUID_PROXY`               | `http://squid:3128`                                         |
| `HTTP_PROXY`                      | (squid value)                                               |
| `HTTPS_PROXY`                     | (squid value)                                               |
| `NO_PROXY`                        | `localhost,127.0.0.1,0.0.0.0,inlinetool,agentic-design,...` |
| `GLOBAL_AGENT_HTTP_PROXY`         | (squid value)                                               |
| `GLOBAL_AGENT_HTTPS_PROXY`        | (squid value)                                               |
| `GLOBAL_AGENT_NO_PROXY`           | (NO_PROXY value)                                            |
| `GLOBAL_AGENT_FORCE_GLOBAL_AGENT` | `false`                                                     |
| `ALLOW_CUSTOM_AGENTS`             | `false`                                                     |

### Observability & K8s (optional)

| Variable        | Default        | Purpose                 |
| --------------- | -------------- | ----------------------- |
| `OTEL_ENDPOINT` | None           | OTEL collector endpoint |
| `GALE_ENV`      | None           | Environment identifier  |
| `DEBUG`         | `False`        | Debug logging           |
| `POD_NAME`      | (K8s fieldRef) | Pod name                |
| `POD_ID`        | (K8s fieldRef) | Pod UID                 |

## Connection to abl-platform

The `GvisorSandboxRunner` in `packages/compiler/src/platform/constructs/executors/gvisor-sandbox-runner.ts` communicates with the codetool sandbox over HTTP:

- Sends code to `POST /execute-script` with `{ script, args, envParams, executionMode, codeType }`
- Receives `{ response, logs, error }` from the sandbox
- Configured via `SANDBOX_PYTHON_POD_URL` and `SANDBOX_JAVASCRIPT_POD_URL` env vars
- Both can point to the same codetool pod since `execute_script.py` handles Python and JavaScript

## Known Limitations

- **amd64 only** — `debootstrap --arch=amd64` and `cni-plugins-linux-amd64` are hardcoded
- **Large image** (~2-5GB) due to full Ubuntu rootfs inside the image
- **Binary wheels in git** — `memory_service_sdk` and `korelogger` `.whl` files are checked in; should move to a private PyPI/artifact registry long-term
- **Build time** — ~30+ min due to Python compilation from source, debootstrap, and NVM/Node.js installation
- **Privileged mode** — requires `securityContext.privileged: true` at runtime for gVisor (`runsc`)

## Future Work

- Dynamic pod provisioning: backend creates/deletes pods per deployment via K8s API
- Helm chart templates in `abl-platform-deploy` for managed deployment
- ArgoCD integration for auto-sync
- ARM64 support (requires multi-arch debootstrap + CNI plugins)
- Move `.whl` artifacts to private PyPI registry

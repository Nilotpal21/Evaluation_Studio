# Feature: External Agent Host

**Doc Type**: MAJOR FEATURE
**Parent Feature**: N/A
**Status**: PLANNED
**Feature Area(s)**: `agent lifecycle`, `integrations`, `governance`, `enterprise`
**Package(s)**: `apps/runtime`, `packages/database`, `packages/shared-auth`, `packages/llm`, `packages/a2a`
**Owner(s)**: Platform Team
**Testing Guide**: `../testing/external-agent-host.md`
**Last Updated**: 2026-04-17

---

## 1. Introduction / Overview

### Problem Statement

Enterprise customers with existing investments in Python-based agent frameworks (LangGraph, CrewAI, Semantic Kernel, AutoGen, custom) cannot run those agents on the ABL Platform without rewriting them in ABL. Today, the platform's native authoring language is ABL (declarative YAML), and every runtime capability — model resolution, guardrails, budget enforcement, tracing, tenant isolation, RBAC, deployment versioning — is wired through the ABL compilation pipeline. This forces a binary choice: rewrite in ABL for full platform integration, or run externally and forfeit governance.

The A2A protocol provides interoperability (external agents can be invoked), but it does not provide **hosting** — the customer still deploys, monitors, and governs the external agent themselves. There is no credential management, no guardrails on LLM calls, no budget enforcement, and no lifecycle management from the platform's perspective.

### Goal Statement

Make external Python agents **first-class citizens** within the ABL Platform's existing tenant/project/RBAC/deployment/governance model. An external agent hosted on the platform gets the same project isolation, model resolution, guardrails, budget enforcement, tracing, audit logging, deployment promotion/rollback, and tenant isolation as a native ABL agent without requiring platform-specific wrapper code in the customer image. Zero-code onboarding is achieved by a platform-injected adapter sidecar plus a platform-managed workload bridge in `managed` mode and environment variable injection; optional HTTP passthrough remains available for workloads that already expose an internal HTTP API.

### Summary

The External Agent Host introduces:

1. **LLM Proxy** — An OpenAI-compatible endpoint (`/llm/v1/chat/completions`) that external agents point their `OPENAI_API_BASE` to. Transparently overlays model resolution, guardrails, budget enforcement, circuit breaking, tracing, and audit logging.

2. **Container Deployment Pipeline** — External agents are deployed as managed workload containers within the platform's Kubernetes infrastructure, with a platform-owned adapter sidecar, a platform-managed workload bridge in `managed` mode, health monitoring, and lifecycle management.

3. **Config Resolution API** — Returns the deployment's frozen configuration snapshot and secrets for external agents, re-materialized from the correct cloud vault at read time but not re-resolved from the live inheritance chain.

4. **Tool Proxy** — Exposes platform-registered MCP tools as OpenAI function-calling schema and standalone HTTP API, giving external agents governed tool access.

5. **Prompt Template Service** — Project-scoped versioned prompt storage with hot-reload, enabling prompt engineers to iterate without container redeployment.

6. **Thin Python Library** (`agent-platform-sdk` extension) — Optional ergonomic wrappers for all platform services. Agents work without it — everything is available as environment variables or raw HTTP.

External agents are represented by project-scoped `ExternalAgentConfig` and `ExternalAgentDeployment` resources that are projected into the shared agent catalog, Studio UI, and A2A routing surfaces. They are catalog peers to native ABL agents in Phase 1, not a simple `ProjectAgent` discriminator.

### Contract Vocabulary

| Term                       | Meaning                                                                                                                                                                                                                                                                                                |
| -------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| Workload container         | The customer-provided image and process. It is not required to expose platform-owned `/message`, `/health`, or A2A routes.                                                                                                                                                                             |
| Adapter sidecar            | The platform-injected sidecar that owns the stable platform-facing HTTP contract (`/message`, `/health`, connection-scoped A2A routes).                                                                                                                                                                |
| Deployment binding         | The immutable auth context derived from a deployment API key: `tenantId`, `projectId`, `environment`, and `deploymentId`.                                                                                                                                                                              |
| Deployment snapshot        | The immutable `DeploymentVariableSnapshot` captured at deploy time after resolving the configuration inheritance chain for that deployment.                                                                                                                                                            |
| Managed bootstrap launcher | A platform-owned launcher binary/script delivered into the workload container over a read-only projected volume in `managed` mode. Provisioning overrides the workload container command so this launcher starts first, binds the loopback bridge port, and then execs the preserved customer process. |
| Managed workload bridge    | The loopback HTTP surface exposed by the managed bootstrap launcher inside the workload container in `managed` mode. It adapts inbound requests to the customer process without customer-owned platform routes.                                                                                        |
| Managed adapter mode       | Default zero-code onboarding path. The sidecar owns the platform contract and forwards to the managed workload bridge over loopback HTTP.                                                                                                                                                              |
| HTTP passthrough mode      | Optional advanced mode where the sidecar proxies to an internal workload HTTP server via configured `port`, `messagePath`, and `healthPath`.                                                                                                                                                           |

---

## 2. Scope

### Goals

- G-1: External Python agents run on the platform without adding platform-specific `/message`, `/health`, or A2A handlers to customer code; zero-code onboarding is environment-variable injection plus the platform adapter sidecar
- G-2: All platform governance capabilities (model resolution, guardrails, budget, rate limiting, circuit breaker, audit, tracing) apply transparently via the LLM Proxy
- G-3: External agents are **project-scoped and tenant-isolated** — same RBAC, same deployment model, same budget enforcement as native ABL agents
- G-4: Deployment lifecycle (versioning, promote, rollback, drain) works identically for external agents
- G-5: External agents are discoverable and invocable via A2A, appearing in the agent catalog alongside native agents
- G-6: Platform-managed secret and config resolution eliminates the need for external agents to manage their own cloud credentials
- G-7: Optional thin Python library provides ergonomic access to platform services without being a hard dependency

### Non-Goals (Out of Scope)

- NG-1: **Modifying external agent source code** — the platform wraps, it does not instrument
- NG-2: **Step-level tracing inside external agent execution** — the platform traces at the LLM call boundary via the proxy; internal agent execution is opaque (acknowledged trade-off vs native ABL)
- NG-3: **Memory governance for external agents** — external agents manage their own memory; the platform cannot inspect or enforce TTLs on agent-internal state
- NG-4: **Visual debugging in Studio** — external agents do not produce step-level IR execution traces; Studio shows LLM call traces, health metrics, and audit logs only
- NG-5: **Hot-reload of prompts embedded in Python code** — only prompts fetched from the Prompt Template Service are hot-reloadable; hardcoded prompts require container redeployment
- NG-6: **Runtime process management inside the container** — the platform manages the container lifecycle (start/stop/health/drain), not the Python process inside it
- NG-7: **Framework-specific compilation or analysis** — the platform does not parse LangGraph state graphs or CrewAI crew definitions; it treats the container as a black box
- NG-8: **Customer-defined multi-container pod packaging in Phase 1** — Phase 1 supports one customer workload container plus one platform adapter sidecar only

---

## 3. User Stories

1. As an **ML engineer** with an existing LangGraph agent, I want to deploy it to the ABL Platform so that my agent gets enterprise guardrails, model governance, and tenant isolation without rewriting it in ABL.

2. As a **platform operator**, I want to manage external Python agents in the same Studio UI as native ABL agents so that I have a single pane of glass for all agents in a project — health, deployments, versions, and rollback state.

3. As a **project admin**, I want external agents to respect the same RBAC permissions and budget quotas as native agents so that I don't need a separate governance model for Python-based agents.

4. As a **prompt engineer**, I want to update prompt templates used by an external agent without redeploying its container so that I can iterate on agent behavior in production as fast as I do with ABL agents.

5. As a **security auditor**, I want every LLM call made by an external agent to pass through the platform's guardrails engine so that PII detection, toxicity filtering, and content policy enforcement apply regardless of how the agent was built.

6. As a **DevOps engineer**, I want promotion and rollback for external agents so that a bad release of a Python agent can be safely reversed using the same operational model as native ABL deployments.

7. As a **supervisor agent author**, I want to route conversations to external Python agents alongside native ABL agents so that multi-agent orchestration works across framework boundaries within the same project.

---

## 4. Functional Requirements

1. **FR-1**: The system must provide an OpenAI-compatible HTTP endpoint (`/llm/v1/chat/completions`) that accepts standard chat completion requests, authenticates them with a deployment API key, resolves the effective model through the platform model-resolution chain for that deployment binding, applies the guardrails pipeline (input and output), enforces budget via HybridBudgetEnforcer, and returns responses in OpenAI-compatible format. Both streaming (SSE) and non-streaming modes must be supported.

2. **FR-2**: The system must support deploying external agent workload containers to the platform's Kubernetes infrastructure with health monitoring (liveness + readiness probes), automatic adapter sidecar injection (via Helm chart template), and lifecycle management (pending → provisioning → active → draining → retired, with `failed` from any pre-active state).

3. **FR-2a**: In `managed` mode, deployment provisioning must inspect the OCI image config to capture the customer `Entrypoint`/`Cmd`, or use an explicit `startCommandOverride` when provided. Provisioning must mount the managed bootstrap launcher into the workload container through a read-only projected volume and override the workload container command so the launcher becomes PID 1, starts the in-container loopback bridge, and then execs the preserved customer process. If no launch command can be resolved, provisioning must fail before Kubernetes resources are created.

4. **FR-3**: The system must auto-generate a deployment API key per external agent deployment with least-privilege scopes (`llm:proxy`, `tools:execute`, `config:read`, `prompts:read`, `logs:write`), injected as the `ABL_API_KEY` environment variable. The key is a single-binding key: it must bind exactly one `tenantId`, one `projectId`, one `environment`, and the owning `deploymentId`. If the underlying `IApiKey` schema stores array scopes, deployment provisioning must enforce schema-level uniqueness (`projectIds.length === 1`, `environments.length === 1`) and proxy auth must reject zero-binding or multi-binding keys.

5. **FR-4**: The system must provide a Config Resolution API (`GET /api/v1/external-agents/:agentId/config`) that returns the authenticated deployment's frozen `DeploymentVariableSnapshot` values and decrypted secrets for that deployment binding. The snapshot is created at deploy time from the existing configuration inheritance chain. Runtime reads do not live-resolve current project or tenant values; secret material may be re-encrypted or re-materialized for transport only.

6. **FR-5**: The system must register external agents in the existing agent catalog, making them discoverable via the Agent Discovery API, visible in the Studio agent catalog (with a visual "External" badge), and invocable via A2A. A2A registration is deployment-scoped: every active deployment creates or updates a connection-scoped `ChannelConnection` and a sidecar-served agent card for that deployment endpoint.

7. **FR-6**: The system must translate inbound A2A messages and channel messages through a platform-owned adapter contract. The adapter sidecar, not the customer workload container, owns `POST /message`, `GET /health`, and connection-scoped A2A routes. In `managed` mode, the sidecar forwards those inbound deliveries over pod-local loopback HTTP to the platform-managed workload bridge running inside the workload container; the bridge is started by the managed bootstrap launcher defined in `FR-2a`, execs the preserved customer process, and adapts requests without customer-owned platform routes. Optional `http_passthrough` mode may instead proxy those calls to a workload-local HTTP server when explicitly configured.

8. **FR-7**: The system must provide a Tool Proxy that exposes platform-registered MCP tools in OpenAI function-calling schema format (via the LLM Proxy's `tools` parameter) and as a standalone HTTP API (`POST /api/v1/tool-proxy/execute`) for explicit tool invocation.

9. **FR-8**: The system must provide a project-scoped Prompt Template Service with versioned prompt storage (draft → testing → active → deprecated lifecycle), variable interpolation, ETag-based caching, and A/B split support. Templates must be fetchable via API and the thin Python library.

10. **FR-9**: The system must enforce the same deployment lifecycle for external agents as native ABL agents: explicit semantic versioning, promotion, rollback, and connection draining. Weighted canary and blue-green rollout semantics are out of scope until the shared deployment stack supports them natively.

11. **FR-9a**: The deployment status lifecycle must be: `pending` → `provisioning` → `active` → `draining` → `retired`. A deployment may transition to `failed` from any pre-active state. Phase 1 supports one active deployment per agent/environment pair, with explicit promote and rollback operations rather than weighted traffic splits.

12. **FR-10**: The system must capture external agent logs via stdout/stderr scraping (automatic, zero agent changes) and a structured logging API (opt-in via thin library) with trace context propagation to the platform's TraceStore.

13. **FR-11**: The system must gate the External Agent Host feature behind the `external_agents` feature flag, available on BUSINESS and ENTERPRISE plan tiers only, using the `createFailClosedFeatureGate` pattern.

14. **FR-12**: The system must provide an optional open-source Python library (distributed via PyPI, extending the existing `agent-platform-sdk`) with helpers for: LLM proxy client configuration, prompt template fetching, config/secret resolution, health reporting, trace enrichment, and tool proxy access.

15. **FR-12a**: Guardrail and budget dependency outages must use a project-scoped governance availability policy shared by native and external agents. The default policy is fail-closed: if a required governance dependency is unavailable, the LLM Proxy rejects the request before calling the upstream provider. Explicit fail-open configuration must be opt-in, project-scoped, and audit-logged.

---

## 5. Feature Classification & Integration Matrix

### Lifecycle / Platform Impact

| Area                       | Impact Level | Notes                                                                         |
| -------------------------- | ------------ | ----------------------------------------------------------------------------- |
| Project lifecycle          | SECONDARY    | External agents are project-scoped resources; project CRUD unchanged          |
| Agent lifecycle            | PRIMARY      | New agent source type, new deployment pipeline path, new container management |
| Customer experience        | PRIMARY      | Enables customers with Python agents to use the platform without rewriting    |
| Integrations / channels    | PRIMARY      | External agents participate in A2A, channels route to them via adapter        |
| Observability / tracing    | PRIMARY      | LLM Proxy emits trace events; sidecar captures health; logs forwarded         |
| Governance / controls      | PRIMARY      | Guardrails, budget, rate limiting, audit all apply via LLM Proxy              |
| Enterprise / compliance    | PRIMARY      | Tenant isolation, RBAC, KMS secret resolution, audit logging all apply        |
| Admin / operator workflows | SECONDARY    | Operators manage external agents in the same Studio UI                        |

### Related Feature Integration Matrix

| Related Feature                                                                | Relationship Type | Why It Matters                                                                | Key Touchpoints                                                                | Current State |
| ------------------------------------------------------------------------------ | ----------------- | ----------------------------------------------------------------------------- | ------------------------------------------------------------------------------ | ------------- |
| [Model Hub](model-hub.md)                                                      | depends on        | LLM Proxy delegates model resolution to ModelResolutionService                | `ModelResolutionService.resolve()`, `createVercelProvider()`                   | STABLE        |
| [Guardrails](guardrails.md)                                                    | depends on        | LLM Proxy runs 3-tier guardrails pipeline on every proxied call               | `createGuardrailPipeline()` → `GuardrailPipelineImpl` in `pipeline-factory.ts` | STABLE        |
| Budget Enforcement (see `apps/runtime/src/services/llm/budget-enforcement.ts`) | depends on        | LLM Proxy enforces budget via pre-debit pattern                               | `HybridBudgetEnforcer`                                                         | STABLE        |
| [A2A Integration](a2a-integration.md)                                          | extends           | External agents are invocable via A2A; platform translates protocol           | `AgentExecutorAdapter`, `A2AExpressHandlers`                                   | BETA          |
| [Deployments & Versioning](deployments-versioning.md)                          | shares data with  | External agents use parallel deployment model with shared lifecycle semantics | `IDeployment` pattern (new `IExternalAgentDeployment`)                         | BETA          |
| [MCP Support](mcp-support.md)                                                  | extends           | Tool Proxy exposes MCP tools to external agents                               | `MCPServerRegistryService`, `McpToolExecutor`                                  | STABLE        |
| [Channels](channels.md)                                                        | extends           | External agents are reachable via all channel adapters through A2A sidecar    | Channel manifest, `ChannelConnection`                                          | STABLE        |
| [Rate Limiting](rate-limiting.md)                                              | depends on        | External agent API key subject to tenant rate limits                          | 6 rate limiting surfaces                                                       | STABLE        |
| [Encryption at Rest](encryption-at-rest.md) + [KMS](kms.md)                    | depends on        | Config Resolution API decrypts secrets via tenant-scoped DEKs                 | `EncryptionService`, KMS providers                                             | STABLE        |
| [Auth Profiles](auth-profiles.md)                                              | depends on        | API key auth, project permissions, feature gating                             | `createUnifiedAuthMiddleware`, `IApiKey`                                       | STABLE        |

---

## 6. Design Considerations

### Studio UI

External agents appear in the Studio agent catalog alongside native ABL agents, visually distinguished by an "External" badge and framework hint icon. Clicking an external agent opens a detail view showing:

- Container configuration (image, tag, port, health path)
- Deployment status and version history
- Health metrics (liveness, readiness, error rate)
- LLM call traces (via proxy)
- Audit log
- Prompt templates (if using Prompt Template Service)
- Environment configuration

The DSL editor tab is replaced by a "Container Configuration" tab for external agents.

### Agent Authoring Flow

```
ML Engineer                              Platform
    │                                        │
    ├── 1. Build Python agent locally        │
    │   (LangGraph / CrewAI / custom)        │
    │                                        │
    ├── 2. Build container image             │
    │   docker build -t my-agent:1.0 .       │
    │                                        │
    ├── 3. Push to registry                  │
    │   docker push acme.azurecr.io/...      │
    │                                        │
    ├── 4. Register in Studio ──────────────►│
    │   (or CLI: platform agents register    │
    │    --name my-agent --image ...         │
    │    --adapter managed                   │
    │    --framework langgraph)              │
    │                                        │
    │◄────────────────────────── 5. Platform │
    │   Returns: ABL_API_KEY, LLM_PROXY_URL  │   auto-provisions
    │                                        │   API key + config
    │                                        │
    ├── 6. Deploy ──────────────────────────►│
    │   (Studio UI or CLI)                   │   Platform deploys
    │                                        │   container + sidecar
    │                                        │   + injects env vars
    │                                        │
    │◄────────────────────────── 7. Agent    │
    │   Agent live at deployment endpoint    │   registered in
    │   LLM calls routed through proxy       │   catalog, channels
    │   Guardrails + budget active           │   bound, A2A registered
```

---

## 7. Technical Considerations

### LLM Proxy Request Flow

```
External Agent (Python)
    │
    │  POST /llm/v1/chat/completions
    │  Authorization: Bearer abl_xxxxx
    │  { model: "gpt-4o", messages: [...], tools: [...] }
    │
    v
LLM Proxy Endpoint (new route in apps/runtime)
    │
    ├── 1. Auth: resolveDeploymentApiKey() → DeploymentBinding
    │       (tenantId, projectId, environment, deploymentId)
    │
    ├── 2. Rate Limit: check tenant + API key quotas
    │
    ├── 3. Input Guardrails: createGuardrailPipeline() → evaluate('input', messages)
    │       Tier 1 (local rules + PII) → Tier 2 (model classifiers) → Tier 3 (LLM eval)
    │       Action on violation: block / redact / warn / escalate / fix / reask
    │       If required guardrail dependency is unavailable and project policy is
    │       fail-closed (default) → reject with 503 before provider call
    │
    ├── 4. Model Resolution: ModelResolutionService.resolve()
    │       External-agent chain: deployment override → project default
    │       → tenant default → FAIL
    │       Request-level override is allowed only when project policy permits it
    │       Returns: ResolvedModel { modelId, provider, credential, parameters }
    │
    ├── 5. Budget: HybridBudgetEnforcer.preDebit(estimatedTokens)
    │       Atomic Lua script, daily + monthly check
    │       If the budget dependency is unavailable and project policy is
    │       fail-closed (default) → reject with 503 before provider call
    │
    ├── 6. Circuit Breaker: check provider health
    │       If OPEN → fail to fallback model
    │
    ├── 7. Provider Call: createVercelProvider() → generateText/streamText
    │       Platform credential injected (agent never sees raw API key)
    │
    ├── 8. Output Guardrails: createGuardrailPipeline() → evaluate('output', response)
    │
    ├── 9. Budget: HybridBudgetEnforcer.reconcile(actualTokens)
    │
    ├── 10. Trace: emit TraceEvent (llm_call) with full context
    │        prompt, response, tokens, cost, latency, model, guardrail results
    │
    ├── 11. Audit: emit audit event (fire-and-forget)
    │
    └── 12. Return OpenAI-compatible response
            { choices: [...], usage: { prompt_tokens, completion_tokens } }
```

### Container Deployment Architecture

```
Kubernetes Pod (External Agent)
┌──────────────────────────────────────────────────────┐
│                                                       │
│  ┌─────────────────────────────┐  ┌───────────────┐ │
│  │  Agent Container             │  │  Sidecar       │ │
│  │  (user's Python code)        │  │  (platform)    │ │
│  │                              │  │                │ │
│  │  ENV:                        │  │  - A2A adapter │ │
│  │  OPENAI_API_BASE=proxy-url   │  │  - Health mgr  │ │
│  │  ABL_API_KEY=abl_xxxxx       │  │  - Log fwd     │ │
│  │  ABL_TOOL_PROXY=proxy-url    │  │  - Lifecycle   │ │
│  │  ABL_CONFIG_URL=config-url   │  │                │ │
│  │                              │  │  Listens:      │ │
│  │  Optional internal runtime:  │  │  POST /message │ │
│  │  - framework process         │  │  GET  /health  │ │
│  │  - or loopback HTTP server   │  │  POST /a2a/:connectionId │ │
│  │                              │  │  GET  /a2a/:connectionId/sse │ │
│  │  No required platform routes │  │  GET  /a2a/:connectionId/.well-known/agent-card.json │ │
│  └─────────────────────────────┘  └───────────────┘ │
│                                                       │
│  Shared: network namespace, config volume, loopback   │
└──────────────────────────────────────────────────────┘
```

In `managed` mode, the sidecar's only in-pod target is the platform-managed workload bridge over loopback HTTP in the shared pod network namespace; it does not call customer-owned `/message`, `/health`, or A2A routes. The deployment controller mounts the managed bootstrap launcher into the workload container, resolves the customer launch command from the image metadata or `startCommandOverride`, and overrides the workload command so the launcher starts first and then execs the preserved customer process. In `http_passthrough` mode, the sidecar instead targets the customer workload's internal HTTP server using the configured `port`, `messagePath`, and `healthPath`.

### Managed Bridge Bootstrap Contract

`managed` mode is zero-code for the customer workload, but it is not zero-bootstrap for the platform. The stable bootstrap contract is:

1. Deployment provisioning inspects the image's OCI `Entrypoint` and `Cmd` and records the resolved customer launch command. If the image does not expose one, the project owner may supply `startCommandOverride`; otherwise provisioning fails before creating Kubernetes resources.
2. The deployment controller mounts a platform-owned bootstrap launcher into the workload container through a read-only projected volume.
3. The workload container command is overridden to run the bootstrap launcher as PID 1. The launcher binds the reserved loopback bridge port, starts the managed bridge HTTP surface, and then `exec`s the preserved customer process so signal handling and exit codes still reflect the customer workload.
4. `http_passthrough` mode skips the launcher and command override entirely; it is the only mode that targets customer-owned HTTP routes directly.

### Adapter Modes

| Mode               | Intended Use                             | Contract                                                                                                                                                                                                            |
| ------------------ | ---------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `managed`          | Default zero-code onboarding             | Sidecar owns `/message`, `/health`, and A2A routes and forwards them over loopback HTTP to the platform-managed workload bridge inside the customer container. Customer code does not implement platform endpoints. |
| `http_passthrough` | Advanced mode for existing HTTP services | Sidecar still owns the platform contract, but proxies to the workload's internal `port`, `messagePath`, and `healthPath` over loopback HTTP.                                                                        |

### Phase 1 Packaging and Versioning Contract

| Topic                   | Contract                                                                                                                                                                                          |
| ----------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Pod packaging           | Phase 1 supports exactly one customer workload container plus one platform adapter sidecar. Customer-defined multi-container pods are out of scope.                                               |
| Registry access         | Phase 1 pulls images directly from approved customer-managed or platform-managed OCI registries. Private customer registries require `registryCredentialId`. Mandatory mirroring is out of scope. |
| Version source of truth | Deployment `version` is an explicit semantic version supplied at deploy time and stored separately from `containerTag`. Image tags are frozen deployment metadata and are not rollout semantics.  |

### New API Key Scopes

| Scope           | Permission                       | Purpose                              |
| --------------- | -------------------------------- | ------------------------------------ |
| `llm:proxy`     | Access LLM Proxy endpoint        | Model resolution, guardrails, budget |
| `tools:execute` | Execute MCP tools via Tool Proxy | Platform-managed tool access         |
| `config:read`   | Read resolved config and secrets | Environment variable resolution      |
| `prompts:read`  | Read prompt templates            | Hot-reloadable prompt access         |
| `logs:write`    | Push structured logs             | Trace-correlated log forwarding      |

### Migration from A2A-Only to Hosted

Today, external agents can participate via A2A as standalone services. The External Agent Host adds a **hosting** layer:

| Capability         | A2A-Only (today)                  | Hosted External Agent                                           |
| ------------------ | --------------------------------- | --------------------------------------------------------------- |
| Deployment         | Customer-managed                  | Platform-managed (same as native)                               |
| Model resolution   | Customer provides own credentials | Platform resolves via deployment/project/tenant policy          |
| Guardrails         | None — customer's responsibility  | Platform guardrails on every LLM call                           |
| Budget enforcement | None                              | Platform budget enforcement per tenant                          |
| Tracing            | A2A trace events only             | Full LLM call traces via proxy                                  |
| Inbound contract   | Customer implements transport     | Platform sidecar owns `/message`, `/health`, and connection A2A |
| Health monitoring  | Customer's responsibility         | Platform liveness/readiness probes                              |
| Promote/rollback   | Customer's responsibility         | Platform deployment lifecycle                                   |
| Secret management  | Customer-managed                  | Deployment snapshot + platform KMS with cloud vault resolution  |
| RBAC               | Connection-level auth only        | Full project RBAC                                               |

---

## 8. How to Consume

### Studio UI

- **Agent Catalog**: External agents listed alongside native ABL agents with "External" badge
- **Register External Agent**: New form accessible from agent catalog — fields: name, container image, adapter mode, framework hint, optional passthrough port/paths, optional `startCommandOverride` (advanced, for managed mode when image metadata cannot be used as-is), registry credential, description
- **Agent Detail View**: Container config tab (replaces DSL editor), deployment history, health metrics, LLM traces, audit log
- **Deploy External Agent**: Same deployment wizard (enter semantic deployment version → select environment → confirm) with container-specific options (replica count, resource limits)
- **Prompt Templates**: New tab on external agent detail view for managing project-scoped prompt templates

### Surface Semantics Matrix

| Asset / Entity Type     | Source of Truth                         | Design-Time Surface           | Editable?                   | Consumer Reference              | Runtime Materialization                    | Notes                                               |
| ----------------------- | --------------------------------------- | ----------------------------- | --------------------------- | ------------------------------- | ------------------------------------------ | --------------------------------------------------- |
| ExternalAgentConfig     | `external_agent_configs` collection     | Studio Agent Catalog + Detail | Yes (image, adapter config) | By agent name within project    | Workload container deployed to K8s         | Catalog peer to `ProjectAgent`, not a discriminator |
| ExternalAgentDeployment | `external_agent_deployments` collection | Studio Deployments page       | Yes (environment, replicas) | By deploymentId/endpointSlug    | K8s Deployment + Service + Sidecar         | Parallel to native deployment records               |
| ProjectPromptTemplate   | `project_prompt_templates` collection   | Studio Prompt Templates tab   | Yes (content, variables)    | By template key + version       | Fetched via API at call time (ETag cached) | New model, not existing PromptTemplate              |
| Auto-generated API key  | `api_keys` collection                   | Studio Settings (read-only)   | No (auto-managed)           | Injected as ABL_API_KEY env var | Resolved by auth middleware on proxy calls | Per-deployment, single-binding, auto-rotatable      |

### Design-Time vs Runtime Behavior

- **Design-time**: Developer registers external agent (image, adapter mode, framework hint, optional passthrough port/health settings, optional `startCommandOverride`, registry credential) and configures deployment settings (environment, replicas, resource limits) in Studio. Prompt templates are authored and versioned in Studio.
- **Runtime**: Platform deploys the workload container with the adapter sidecar, injects environment variables (LLM proxy URL, API key, config URL), creates the deployment snapshot, and registers the deployment-scoped A2A connection. In `managed` mode, provisioning resolves the customer launch command from image metadata or `startCommandOverride`, mounts the managed bootstrap launcher, and overrides the workload command so the launcher starts the platform-managed loopback bridge before `exec`ing the customer process. In `http_passthrough` mode, the sidecar targets the configured workload HTTP server. The agent's LLM calls flow through the proxy. The sidecar owns inbound `/message`, `/health`, and A2A routes in both modes.
- **Key difference from ABL**: No compilation step. No AgentIR. The container image is the artifact, while semantic deployment version is an explicit deployment field that is frozen independently from the image tag.

### API (Runtime)

| Method | Path                                             | Purpose                                                                                 |
| ------ | ------------------------------------------------ | --------------------------------------------------------------------------------------- |
| POST   | `/llm/v1/chat/completions`                       | OpenAI-compatible LLM Proxy (model resolution + guardrails + budget)                    |
| POST   | `/llm/v1/completions`                            | Legacy completions format (proxy)                                                       |
| GET    | `/api/v1/external-agents/:agentId/config`        | Deployment snapshot values + decrypted secrets for the authenticated deployment binding |
| POST   | `/api/v1/tool-proxy/execute`                     | Execute MCP tool explicitly                                                             |
| GET    | `/api/v1/tool-proxy/tools`                       | List available MCP tools in OpenAI function schema format                               |
| POST   | `/api/v1/external-agents/:agentId/logs`          | Push structured logs with trace context                                                 |
| GET    | `/api/v1/prompts/:key`                           | Fetch prompt template (latest active version)                                           |
| GET    | `/api/v1/prompts/:key?version=N`                 | Fetch specific prompt template version                                                  |
| POST   | `/a2a/:connectionId`                             | Connection-scoped A2A JSON-RPC endpoint served by the adapter sidecar                   |
| GET    | `/a2a/:connectionId/sse`                         | Connection-scoped A2A SSE stream                                                        |
| GET    | `/a2a/:connectionId/.well-known/agent-card.json` | Connection-scoped agent card with optional per-connection inbound API-key validation    |

### API (Studio)

| Method | Path                                                                                   | Purpose                                      |
| ------ | -------------------------------------------------------------------------------------- | -------------------------------------------- |
| GET    | `/api/projects/:projectId/external-agents`                                             | List external agents in project              |
| POST   | `/api/projects/:projectId/external-agents`                                             | Register new external agent                  |
| GET    | `/api/projects/:projectId/external-agents/:agentId`                                    | Get external agent config                    |
| PUT    | `/api/projects/:projectId/external-agents/:agentId`                                    | Update external agent config                 |
| DELETE | `/api/projects/:projectId/external-agents/:agentId`                                    | Delete external agent                        |
| POST   | `/api/projects/:projectId/external-agents/:agentId/deploy`                             | Deploy external agent to environment         |
| GET    | `/api/projects/:projectId/external-agents/:agentId/deployments`                        | List deployments                             |
| POST   | `/api/projects/:projectId/external-agents/:agentId/deployments/:deploymentId/rollback` | Rollback deployment                          |
| GET    | `/api/projects/:projectId/prompt-templates`                                            | List prompt templates                        |
| POST   | `/api/projects/:projectId/prompt-templates`                                            | Create prompt template                       |
| PUT    | `/api/projects/:projectId/prompt-templates/:key`                                       | Update prompt template (creates new version) |

### Admin Portal

- **Tenant Settings**: Enable/disable `external_agents` feature flag per tenant (if plan allows)
- **Resource Quotas**: Configure per-tenant container resource limits (max replicas, max CPU/memory per external agent)
- **Audit**: External agent activity visible in tenant audit log alongside native agent activity

### Channel / SDK / Voice / A2A / MCP Integration

- **A2A**: External agents are invocable via A2A protocol. The sidecar exposes connection-scoped routes that match `A2AExpressHandlers` (`POST /a2a/:connectionId`, `GET /a2a/:connectionId/sse`, and `GET /a2a/:connectionId/.well-known/agent-card.json`) with optional per-connection inbound API-key validation. The workload container does not implement A2A.
- **Channels**: Any channel (web_chat, voice, API, WhatsApp, etc.) can route to an external agent via its deployment endpoint. The sidecar handles channel message translation.
- **MCP**: External agents access platform MCP tools via the Tool Proxy (function-calling format or explicit HTTP). No direct MCP server access (platform manages auth, circuit breaking, audit).
- **Voice**: External agents can serve voice channels if the adapter can present a text-in/text-out contract through the sidecar-owned `POST /message` endpoint. Voice-specific features (SSML, streaming audio, WebRTC) require native ABL voice configuration overlays and are not available for external agents in Phase 1.
- **SDK**: Web SDK sessions can route to external agents via deployment endpoints, same as native agents.

---

## 9. Data Model

### Collections / Tables

```text
Collection: external_agent_configs
Purpose: Stores external agent registration metadata (parallel to project_agents for ABL)
Fields:
  - _id: string (UUIDv7)
  - tenantId: string (required, indexed)
  - projectId: string (required, indexed)
  - name: string (required, unique within project)
  - description: string | null
  - containerImage: string (required — OCI registry/image without tag, from an approved customer-managed or platform-managed registry)
  - defaultTag: string (default: "latest" — frozen at deploy time, but not the source of truth for semantic version)
  - adapterMode: string (enum: 'managed' | 'http_passthrough', default: 'managed')
  - port: number | null (optional — internal workload HTTP port when adapterMode='http_passthrough')
  - healthPath: string | null (optional — internal passthrough health path; sidecar always exposes platform `/health`)
  - messagePath: string | null (optional — internal passthrough message path; sidecar always exposes platform `/message`)
  - registryCredentialId: string | null (ref to tenant-managed registry pull credential; required for private customer registries)
  - frameworkHint: string | null (e.g., "langgraph", "crewai", "custom")
  - startCommandOverride: string[] | null (optional — explicit customer start command for managed mode when image Entrypoint/Cmd cannot be used as-is)
  - capabilities: string[] (default: [] — for capability-based discovery)
  - channels: string[] (default: ["api"] — which channels this agent can serve)
  - resourceLimits: { cpuRequest, cpuLimit, memoryRequest, memoryLimit } | null
  - allowExternalEgress: boolean (default: false — declarative intent that the workload should use platform-managed egress only; enforcement does not become real until Phase 3 NetworkPolicy automation)
  - envOverrides: Record<string, string> (non-secret env vars injected into container)
  - createdBy: string (required)
  - lastEditedBy: string | null
  - _v: number
  - createdAt / updatedAt: Date
Indexes:
  - { tenantId: 1, projectId: 1 } (compound, for project listing)
  - { tenantId: 1, projectId: 1, name: 1 } (unique)
Plugins: tenantIsolationPlugin
```

```text
Collection: external_agent_deployments
Purpose: Tracks deployment lifecycle for external agents (parallel to deployments for ABL)
Fields:
  - _id: string (UUIDv7)
  - tenantId: string (required, indexed)
  - projectId: string (required, indexed)
  - externalAgentId: string (required — ref to external_agent_configs)
  - environment: string (required, enum: 'dev' | 'staging' | 'production')
  - containerImage: string (required — full image:tag at deploy time)
  - containerTag: string (required — frozen at deploy time)
  - version: string (required — explicit semantic version supplied at deployment time, e.g., "1.2.0")
  - status: string (enum: 'pending' | 'provisioning' | 'active' | 'draining' | 'retired' | 'failed')
  - endpointSlug: string (required, unique — for routing)
  - replicaCount: number (default: 1)
  - resourceLimits: { cpuRequest, cpuLimit, memoryRequest, memoryLimit }
  - resolvedLaunchCommand: string[] | null (frozen customer process command executed behind the managed bridge; required for `managed`, null for `http_passthrough`)
  - apiKeyId: string (required — ref to auto-generated API key)
  - variableSnapshotId: string (required — ref to deployment_variable_snapshots; immutable after deploy)
  - a2aConnectionId: string | null (ref to ChannelConnection registered for the active deployment endpoint)
  - previousDeploymentId: string | null
  - healthStatus: string (enum: 'healthy' | 'degraded' | 'unhealthy' | 'unknown')
  - lastHealthCheck: Date | null
  - createdBy: string (required)
  - retiredAt: Date | null
  - drainingStartedAt: Date | null
  - _v: number
  - createdAt / updatedAt: Date
Indexes:
  - { tenantId: 1, projectId: 1, environment: 1 }
  - { externalAgentId: 1, environment: 1 }
  - { endpointSlug: 1 } (unique)
Plugins: tenantIsolationPlugin
```

```text
Collection: project_prompt_templates
Purpose: Project-scoped versioned prompt templates (new — not the existing platform-wide prompt_templates)
Fields:
  - _id: string (UUIDv7)
  - tenantId: string (required, indexed)
  - projectId: string (required, indexed)
  - key: string (required — unique within project, e.g., "hr-system-prompt")
  - version: number (required, auto-incremented)
  - content: string (required — prompt text with {{variable}} placeholders)
  - variables: string[] (extracted from content — for documentation/validation)
  - description: string | null
  - status: string (enum: 'draft' | 'testing' | 'active' | 'deprecated')
  - abSplitPercent: number | null (0-100 — if set, this version gets N% of requests)
  - createdBy: string (required)
  - _v: number
  - createdAt / updatedAt: Date
Indexes:
  - { tenantId: 1, projectId: 1, key: 1, version: 1 } (unique)
  - { tenantId: 1, projectId: 1, key: 1, status: 1 }
Plugins: tenantIsolationPlugin
```

### Key Relationships

- `ExternalAgentConfig` → `Project` (via projectId) — project-scoped
- `ExternalAgentDeployment` → `ExternalAgentConfig` (via externalAgentId)
- `ExternalAgentDeployment` → `ApiKey` (via apiKeyId) — auto-generated single-binding key per deployment
- `ExternalAgentDeployment` → `DeploymentVariableSnapshot` (via variableSnapshotId) — required immutable deployment snapshot
- `ExternalAgentDeployment` → `ChannelConnection` (via a2aConnectionId) — deployment-scoped A2A registration
- `ProjectPromptTemplate` → `Project` (via projectId) — project-scoped
- LLM Proxy → `ModelResolutionService` (runtime dependency, not data relationship)
- LLM Proxy → `createGuardrailPipeline()` / `GuardrailPipelineImpl` (runtime dependency)
- LLM Proxy → `HybridBudgetEnforcer` (runtime dependency)

---

## 10. Key Implementation Files

### Domain / Core Logic

| File                                                              | Purpose                                              |
| ----------------------------------------------------------------- | ---------------------------------------------------- |
| `apps/runtime/src/routes/llm-proxy.ts`                            | NEW — OpenAI-compatible LLM Proxy endpoint           |
| `apps/runtime/src/routes/tool-proxy.ts`                           | NEW — Tool execution proxy endpoint                  |
| `apps/runtime/src/routes/external-agents.ts`                      | NEW — External agent CRUD + deployment routes        |
| `apps/runtime/src/routes/prompt-templates.ts`                     | NEW — Prompt template CRUD routes                    |
| `apps/runtime/src/services/external-agent/deployment-service.ts`  | NEW — Container deployment orchestration             |
| `apps/runtime/src/services/external-agent/config-resolver.ts`     | NEW — Config + secret resolution for external agents |
| `apps/runtime/src/services/external-agent/sidecar-manager.ts`     | NEW — Sidecar lifecycle and A2A adapter management   |
| `packages/database/src/models/external-agent-config.model.ts`     | NEW — ExternalAgentConfig Mongoose model             |
| `packages/database/src/models/external-agent-deployment.model.ts` | NEW — ExternalAgentDeployment Mongoose model         |
| `packages/database/src/models/project-prompt-template.model.ts`   | NEW — ProjectPromptTemplate Mongoose model           |

### Routes / Handlers

| File                                          | Purpose                                                                     |
| --------------------------------------------- | --------------------------------------------------------------------------- |
| `apps/runtime/src/routes/llm-proxy.ts`        | LLM Proxy: auth, guardrails, model resolution, budget, provider call, trace |
| `apps/runtime/src/routes/tool-proxy.ts`       | Tool Proxy: auth, MCP registry lookup, execute, audit                       |
| `apps/runtime/src/routes/external-agents.ts`  | CRUD for external agent config + deployment lifecycle                       |
| `apps/runtime/src/routes/prompt-templates.ts` | CRUD for prompt templates + version management                              |

### UI Components

| File                                                              | Purpose                                                  |
| ----------------------------------------------------------------- | -------------------------------------------------------- |
| `apps/studio/src/app/(app)/projects/[projectId]/agents/external/` | NEW — External agent list and detail pages               |
| `apps/studio/src/components/external-agent/register-form.tsx`     | NEW — Registration form (image, port, health, framework) |
| `apps/studio/src/components/external-agent/deploy-wizard.tsx`     | NEW — Deployment wizard for external agents              |
| `apps/studio/src/components/prompt-templates/editor.tsx`          | NEW — Prompt template editor with variable highlighting  |

### Jobs / Workers / Background Processes

| File                                                         | Purpose                                                           |
| ------------------------------------------------------------ | ----------------------------------------------------------------- |
| `apps/runtime/src/services/external-agent/health-monitor.ts` | NEW — Periodic health check worker for external agent deployments |
| `apps/runtime/src/services/external-agent/log-forwarder.ts`  | NEW — Aggregates container stdout/stderr into platform log store  |

### Tests

| File                                                           | Type        | Coverage Focus                                                   |
| -------------------------------------------------------------- | ----------- | ---------------------------------------------------------------- |
| `apps/runtime/src/__tests__/llm-proxy.test.ts`                 | integration | LLM Proxy auth, model resolution, guardrails, budget enforcement |
| `apps/runtime/src/__tests__/tool-proxy.test.ts`                | integration | Tool Proxy auth, MCP execution, audit logging                    |
| `apps/runtime/src/__tests__/external-agent-deployment.test.ts` | integration | Deployment lifecycle, API key provisioning, config resolution    |
| `apps/runtime/src/__tests__/prompt-templates.test.ts`          | integration | CRUD, versioning, A/B splits, ETag caching                       |
| `apps/runtime/src/__tests__/e2e/external-agent-host.test.ts`   | e2e         | Full lifecycle: register → deploy → LLM call → trace → rollback  |

---

## 11. Configuration

### Environment Variables

| Variable                            | Default  | Description                                    |
| ----------------------------------- | -------- | ---------------------------------------------- |
| `EXTERNAL_AGENT_HOST_ENABLED`       | `false`  | Master switch for external agent host feature  |
| `LLM_PROXY_MAX_TOKENS`              | `128000` | Maximum tokens per LLM Proxy request           |
| `LLM_PROXY_TIMEOUT_MS`              | `120000` | Timeout for proxied LLM calls                  |
| `EXTERNAL_AGENT_HEALTH_INTERVAL_MS` | `30000`  | Health check polling interval                  |
| `EXTERNAL_AGENT_DEFAULT_REPLICAS`   | `1`      | Default replica count for new deployments      |
| `EXTERNAL_AGENT_MAX_REPLICAS`       | `10`     | Maximum replicas per external agent deployment |
| `PROMPT_TEMPLATE_CACHE_TTL_MS`      | `60000`  | ETag cache TTL for prompt template lookups     |

### Runtime Configuration

- **Feature flag**: `external_agents` in `PLAN_FEATURES` (BUSINESS, ENTERPRISE tiers)
- **Per-tenant settings**: Max external agents per project, max total containers per tenant, allowed container registries
- **Per-project settings**: Default resource limits, default replica count, allowed frameworks, governance availability policy (default fail-closed)

### DSL / Agent IR / Schema

N/A — External agents bypass the ABL DSL and AgentIR compilation pipeline. The "manifest" is the `ExternalAgentConfig` record in the database, configured via Studio UI or API.

---

## 12. Non-Functional Concerns

### Isolation & Multitenancy

| Concern           | Requirement / Expectation                                                                                                                                                                                                                                                                   |
| ----------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Project isolation | Every `ExternalAgentConfig`, `ExternalAgentDeployment`, and `ProjectPromptTemplate` query must include `projectId`. Cross-project access returns 404. LLM Proxy derives `projectId` from the authenticated deployment binding, not from request body or path inference.                     |
| Tenant isolation  | Every query includes `tenantId` via `tenantIsolationPlugin`. LLM Proxy resolves tenant from the deployment API key. Cross-tenant access returns 404. Workloads run in tenant-scoped Kubernetes namespaces; explicit NetworkPolicy-based default-deny enforcement remains a Phase 3 control. |
| User isolation    | `createdBy` tracked on all records. RBAC controls who can register, deploy, and manage external agents within a project.                                                                                                                                                                    |

### Security & Compliance

- **Container security**: External agent containers run with read-only root filesystem, non-root user, dropped capabilities, and resource limits enforced by Kubernetes
- **Credential isolation**: Auto-generated API keys are single-binding deployment keys (one tenant, one project, one environment, one deployment) with least-privilege scopes. Platform LLM credentials are never exposed to the external agent — the proxy injects them server-side
- **SSRF / proxy bypass protection**: Phase 1 does not yet rely on enforced Kubernetes NetworkPolicy-based default-deny egress. Until Phase 3 ships explicit NetworkPolicy enforcement, external agent pods may still make direct outbound calls wherever cluster networking permits it. `allowExternalEgress` is declarative policy state in Phase 1 and becomes an enforced control only once NetworkPolicy automation lands; operators must treat direct LLM provider bypass as possible until then.
- **Audit logging**: Every LLM Proxy call, Tool Proxy call, config fetch, and deployment action is audit-logged with tenant + project + agent context
- **Secret handling**: Config Resolution API serves the deployment snapshot values and decrypts secrets via tenant-scoped DEKs. Secrets are injected as environment variables, never stored in plaintext in the container spec, and are not live-re-resolved from the mutable inheritance chain
- **Governance availability**: Guardrail and budget dependencies obey a project-scoped availability policy. Default fail-closed behavior rejects the request before provider call; explicit fail-open overrides are audit-logged
- **PII**: LLM Proxy applies PII detection/redaction guardrails on all proxied LLM calls

### Performance & Scalability

- **LLM Proxy latency overhead**: Target < 50ms added latency (auth + guardrails Tier 1 + budget check). Guardrails Tier 2/3 add latency proportional to their own SLAs (< 500ms / < 5s respectively)
- **Proxy throughput**: Must handle at least 1000 concurrent proxied LLM calls per runtime pod (streaming SSE)
- **Config Resolution caching**: ETag-based caching reduces redundant config fetches. TTL: 60s (matching existing platform cache patterns)
- **Prompt Template caching**: ETag-based, 60s TTL. A/B split resolution is stateless (percentage-based, no session affinity required)
- **Container scaling**: HPA on external agent pods (CPU 70%, memory 80% targets) with configurable min/max replicas

### Reliability & Failure Modes

- **LLM Proxy unavailable**: External agent's LLM calls fail with 503. Agent should implement retry with exponential backoff. Thin Python library handles this automatically.
- **Guardrail or budget dependency unavailable**: Project-scoped governance availability policy applies. Default fail-closed returns 503 and does not call the upstream provider. Explicit fail-open must be configured at the project level.
- **Config Resolution unavailable**: Agent continues with startup-injected deployment snapshot environment variables. Thin library falls back to cached snapshot values.
- **External agent container crash**: Kubernetes restarts container. Platform marks health as `unhealthy` and alerts. Traffic is not routed to unhealthy pods.
- **Sidecar crash**: A2A inbound routing fails (agent unreachable via channels), but agent's outbound LLM Proxy calls continue working (direct HTTP, no sidecar dependency).
- **Budget exhaustion**: LLM Proxy returns 429 with descriptive error. Agent receives standard rate-limit response.

### Observability

- **LLM Proxy traces**: Every proxied call emits a `TraceEvent` of type `llm_call` with: model, provider, tokens (input/output/reasoning/cached), cost, latency (TTFT, total), guardrail results, budget state
- **Health metrics**: Sidecar reports liveness/readiness to platform monitoring. Health status visible in Studio and agent catalog.
- **Audit events**: All proxy calls, tool executions, config fetches, deployment actions logged to dual-backend audit store
- **Container logs**: stdout/stderr forwarded to platform log store. Structured logs (via thin library) include trace context for correlation.
- **Alerts**: Configurable alerts on: health degradation, error rate spike, budget threshold, latency anomaly — same alert infrastructure as native agents
- **Analytics pipeline**: LLM Proxy trace events feed into the platform's analytics pipeline (intent classification, sentiment analysis, quality evaluation, anomaly detection) identically to native ABL agent traces. External agents benefit from the same analytics dashboards without additional instrumentation.

### Data Lifecycle

- **ExternalAgentConfig**: Retained as long as the project exists. Soft-delete supported.
- **ExternalAgentDeployment**: Retained indefinitely for audit trail. Retired deployments are not deleted.
- **ProjectPromptTemplate**: Deprecated versions retained for rollback. Configurable TTL for deprecated versions (default: 90 days).
- **Auto-generated API keys**: Revoked when deployment is retired. Expired/revoked keys retained for audit.
- **Container logs**: Retention follows tenant log retention policy (configurable: 30 days to indefinite).
- **LLM Proxy traces**: Same retention as native agent traces (configurable per tenant).

---

## 13. Delivery Plan / Work Breakdown

### Phase 1: Foundation (LLM Proxy + Container Deployment)

1. Data models and CRUD
   1.1 Create `ExternalAgentConfig` Mongoose model with tenant isolation plugin
   1.2 Create `ExternalAgentDeployment` Mongoose model with tenant isolation plugin
   1.3 Create CRUD routes for external agent registration (`/api/projects/:projectId/external-agents`)
   1.4 Create deployment routes (deploy, list, rollback, retire)
   1.5 Add `external_agents` to PLAN_FEATURES for BUSINESS/ENTERPRISE tiers

2. LLM Proxy endpoint
   2.1 Create `/llm/v1/chat/completions` route with API key auth
   2.2 Wire deployment API-key binding resolution (tenant/project/environment/deployment from API key)
   2.3 Wire `createGuardrailPipeline()` (input + output evaluation via `GuardrailPipelineImpl`)
   2.4 Wire HybridBudgetEnforcer (pre-debit + reconcile)
   2.5 Wire CircuitBreakerService for provider failover
   2.6 Implement OpenAI-compatible request/response translation
   2.7 Implement SSE streaming mode
   2.8 Emit TraceEvent for every proxied call
   2.9 Emit audit event for every proxied call
   2.10 Enforce project-scoped governance availability policy (default fail-closed)

3. Container deployment pipeline
   3.1 Implement deployment service (create K8s Deployment + Service + sidecar + managed bootstrap launcher volume/command override + managed workload bridge injection for `managed` mode)
   3.2 Implement API key auto-generation per deployment
   3.3 Implement environment variable injection (LLM proxy URL, API key, config URL)
   3.4 Implement health monitoring (periodic probe, status update)
   3.5 Implement deployment lifecycle (pending → provisioning → active → draining → retired; failed from any pre-active state)
   3.6 Implement rollback (restore previous deployment)

4. Config Resolution API
   4.1 Create `/api/v1/external-agents/:agentId/config` route
   4.2 Wire runtime reads to the frozen `DeploymentVariableSnapshot` (decrypt via tenant DEK at read time)
   4.3 Wire DeploymentVariableSnapshot creation on deploy

5. A2A inbound routing
   5.1 Create connection-scoped A2A adapter routes (`POST /a2a/:connectionId`, `GET /a2a/:connectionId/sse`, `GET /a2a/:connectionId/.well-known/agent-card.json`) that bridge to sidecar-owned `POST /message`, which targets the managed workload bridge in `managed` mode or the configured workload HTTP server in `http_passthrough` mode
   5.2 Auto-create deployment-scoped A2A `ChannelConnection` on external agent deployment
   5.3 Wire channel routing to external agent sidecar

### Phase 2: Developer Experience (Tool Proxy + Prompts + Python Library)

6. Tool Proxy
   6.1 Create `/api/v1/tool-proxy/tools` route (list MCP tools in function schema)
   6.2 Create `/api/v1/tool-proxy/execute` route (explicit tool invocation)
   6.3 Wire MCPServerRegistryService for tool discovery
   6.4 Wire McpToolExecutor for tool execution with audit

7. Prompt Template Service
   7.1 Create `ProjectPromptTemplate` Mongoose model
   7.2 Create CRUD routes for prompt templates
   7.3 Implement version lifecycle (draft → testing → active → deprecated)
   7.4 Implement ETag caching and A/B split resolution
   7.5 Create `/api/v1/prompts/:key` runtime fetch endpoint

8. Thin Python Library
   8.1 Create `abl-platform-sdk` Python package (or extend existing `agent-platform-sdk`)
   8.2 Implement LLM proxy client helper (auto-configures OpenAI base_url)
   8.3 Implement config/secret resolver
   8.4 Implement prompt template fetcher with local ETag cache
   8.5 Implement health reporter
   8.6 Implement structured log handler (Python logging.Handler)
   8.7 Implement tool proxy client
   8.8 Publish to PyPI

### Phase 3: Studio UI + Advanced Features

9. Studio UI
   9.1 External agent list page with "External" badge
   9.2 Register external agent form (image, adapter mode, optional passthrough port/health, framework)
   9.3 External agent detail view (container config, deployments, health, traces)
   9.4 Deploy wizard for external agents
   9.5 Prompt template editor with variable highlighting and version history

10. Advanced capabilities
    10.1 Anthropic Messages API format in LLM Proxy (`/llm/v1/messages`)
    10.2 Sidecar auto-injection via K8s admission webhook (MutatingWebhookConfiguration)
    10.3 Custom metrics collection from external agents (Prometheus `/metrics` scraping)
    10.4 `abl init` scaffolding command — `abl init --framework langgraph|crewai|custom` generates an optional passthrough wrapper project (Dockerfile, requirements.txt, internal HTTP handler, platform SDK wiring, .env.example). This is convenience only, not a requirement for managed zero-code onboarding.
    10.5 NetworkPolicy enforcement — default deny egress except platform services; opt-in `allowExternalEgress` flag

---

## 14. Success Metrics

| Metric                                       | Baseline                          | Target                                         | How Measured                         |
| -------------------------------------------- | --------------------------------- | ---------------------------------------------- | ------------------------------------ |
| External agent deployments                   | 0                                 | 50+ across tenants within 6 months             | Platform telemetry                   |
| LLM Proxy adoption                           | 0                                 | 80% of external agents route through proxy     | Proxy call count vs direct API calls |
| Deployment success rate                      | N/A                               | > 95% first-attempt success                    | Deployment status tracking           |
| LLM Proxy latency overhead                   | N/A                               | < 50ms p95 (auth + Tier 1 guardrails + budget) | Trace event latency breakdown        |
| Guardrail coverage on external agents        | 0%                                | 100% of LLM calls pass through guardrails      | Proxy trace events                   |
| RFI requirement coverage                     | AD-001/002 = Alternative Approach | AD-001/002 = Production                        | RFI response status                  |
| Customer migration from standalone to hosted | 0                                 | 10+ agents migrated within 3 months            | Customer success tracking            |

---

## 15. Resolved HLD Decisions

| Topic                          | Decision                                                                                                                                                                                                                                                                                     |
| ------------------------------ | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Container registry access      | Phase 1 pulls images directly from approved customer-managed or platform-managed OCI registries. Private customer registries require a referenced pull credential (`registryCredentialId`). Mandatory mirroring into a platform-managed registry is out of scope.                            |
| External agent versioning      | Deployment `version` is an explicit semantic version supplied at deployment time and stored separately from `containerTag`. Image tags are frozen metadata only and are not the source of truth for version semantics.                                                                       |
| Multi-container packaging      | Phase 1 supports exactly one customer workload container plus one platform adapter sidecar. Customer-defined multi-container pods are out of scope. Teams that need multiple internal processes must package them behind a single workload image for Phase 1.                                |
| Outbound network policy        | Phase 1 does not rely on enforced default-deny egress. NetworkPolicy-based default deny ships in Phase 3; until then, `allowExternalEgress` is declarative policy state only and operators must assume direct outbound provider access is possible wherever cluster networking permits it.   |
| Managed bridge bootstrap       | `managed` mode resolves the workload launch command from the OCI image config or `startCommandOverride`, mounts a platform-owned bootstrap launcher via read-only projected volume, and overrides the workload command so the launcher becomes PID 1 before `exec`ing the customer process.  |
| Managed adapter inbound IPC    | `managed` mode uses a platform-owned workload bridge injected into the workload container. The sidecar forwards `/message`, `/health`, and A2A deliveries to that bridge over pod-local loopback HTTP. `http_passthrough` is the only mode that targets customer-owned HTTP routes directly. |
| Deployment-scoped auth binding | Every deployment key binds exactly one tenant, one project, one environment, and one deployment. Proxy auth does not attempt to infer project or environment from request paths or multi-entry scopes.                                                                                       |
| Config Resolution semantics    | Runtime config reads return the frozen deployment snapshot. Live inheritance-chain changes do not mutate existing deployments; secret material is re-materialized for delivery only.                                                                                                         |
| Governance availability mode   | Guardrail and budget outages use a project-scoped policy shared by native and external agents. Default behavior is fail-closed.                                                                                                                                                              |
| A2A registration contract      | A2A is deployment-scoped and connection-scoped. The sidecar owns the `A2AExpressHandlers` route shape and optional per-connection inbound API-key validation.                                                                                                                                |

### Remaining Non-Blocking Operational Questions

1. **Resource quota enforcement**: HLD must choose whether per-tenant container quotas live primarily in Kubernetes ResourceQuotas, application-level deployment service checks, or both.

2. **Warm-up and readiness tuning**: HLD must set the default readiness timeout, startup probe thresholds, and failure budget for slow-starting model-heavy workloads.

---

## 16. Gaps, Known Issues & Limitations

| ID      | Description                                                                                                                                           | Severity | Status                                                                                                                                                                                                                                                                                                     |
| ------- | ----------------------------------------------------------------------------------------------------------------------------------------------------- | -------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| GAP-001 | Step-level tracing not available for external agents — only LLM call traces via proxy                                                                 | Medium   | Accepted (architectural trade-off)                                                                                                                                                                                                                                                                         |
| GAP-002 | Memory governance not available — external agents manage their own state                                                                              | Medium   | Accepted (architectural trade-off)                                                                                                                                                                                                                                                                         |
| GAP-003 | Visual debugging in Studio limited to LLM call traces, not agent-internal execution                                                                   | Medium   | Accepted (architectural trade-off)                                                                                                                                                                                                                                                                         |
| GAP-004 | Hot-reload only works for prompts fetched from Prompt Template Service, not hardcoded in Python code                                                  | Low      | Accepted (documented in user guide)                                                                                                                                                                                                                                                                        |
| GAP-005 | Voice-specific features (SSML, streaming audio, WebRTC) not available for external agents in Phase 1                                                  | Medium   | Open — Phase 3 consideration                                                                                                                                                                                                                                                                               |
| GAP-006 | No framework-specific analysis or optimization — platform treats container as black box                                                               | Low      | Accepted (by design)                                                                                                                                                                                                                                                                                       |
| GAP-007 | Tool call observability limited to Tool Proxy calls — direct HTTP tool calls from agent are invisible                                                 | Medium   | Mitigated (Tool Proxy provides governed path; direct calls are opt-out)                                                                                                                                                                                                                                    |
| GAP-008 | External agents can bypass LLM Proxy by making direct outbound calls to LLM providers (OpenAI, Anthropic, etc.) if container egress is not restricted | High     | Open until Phase 3: Phase 1 has no enforced default-deny egress guarantee. Direct outbound LLM calls remain possible wherever cluster networking permits them. Phase 3 adds NetworkPolicy-based default deny with opt-in `allowExternalEgress` for agents that legitimately need external outbound access. |
| GAP-009 | No `abl init` scaffolding command for external agent projects — developers must create Dockerfile and project structure manually                      | Low      | Planned: Phase 3 (10.4) — multi-framework project templates with `abl init --framework langgraph\|crewai\|custom` generating Dockerfile, requirements.txt, health endpoint, and platform SDK wiring                                                                                                        |
| GAP-010 | Weighted canary and blue-green rollout semantics are not part of the shared deployment stack used in Phase 1                                          | Medium   | Accepted for Phase 1. External agents use the same promote/rollback/drain lifecycle as native agents until shared rollout primitives expand.                                                                                                                                                               |

---

## 17. Testing & Validation

### Required Test Coverage

| #   | Scenario                                                                                                                                                                                       | Coverage Type | Status     | Test File / Note                                               |
| --- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------- | ---------- | -------------------------------------------------------------- |
| 1   | LLM Proxy authenticates a single-binding deployment API key, resolves tenant/project/environment, and returns the correct model response                                                       | e2e           | NOT TESTED | `apps/runtime/src/__tests__/e2e/external-agent-host.test.ts`   |
| 2   | LLM Proxy applies input guardrails (PII redaction) and blocks toxic content                                                                                                                    | integration   | NOT TESTED | `apps/runtime/src/__tests__/llm-proxy.test.ts`                 |
| 3   | LLM Proxy enforces budget — rejects request when budget exhausted (429)                                                                                                                        | integration   | NOT TESTED | `apps/runtime/src/__tests__/llm-proxy.test.ts`                 |
| 4   | LLM Proxy circuit breaker trips on provider failure, falls back to alternative                                                                                                                 | integration   | NOT TESTED | `apps/runtime/src/__tests__/llm-proxy.test.ts`                 |
| 5   | External agent deployment creates K8s resources, adapter sidecar, managed workload bridge or configured passthrough target, single-binding API key, deployment snapshot, and injected env vars | e2e           | NOT TESTED | `apps/runtime/src/__tests__/e2e/external-agent-host.test.ts`   |
| 6   | Config Resolution API returns deployment snapshot values and decrypted secrets scoped to the authenticated deployment binding                                                                  | integration   | NOT TESTED | `apps/runtime/src/__tests__/external-agent-deployment.test.ts` |
| 7   | Cross-tenant LLM Proxy call returns 404 (not 403)                                                                                                                                              | e2e           | NOT TESTED | Isolation test                                                 |
| 8   | Cross-project LLM Proxy call returns 404                                                                                                                                                       | e2e           | NOT TESTED | Isolation test                                                 |
| 9   | Deployment rollback restores previous container version and API key                                                                                                                            | integration   | NOT TESTED | `apps/runtime/src/__tests__/external-agent-deployment.test.ts` |
| 10  | A2A inbound message routes through connection-scoped sidecar endpoints and reaches the adapter-owned `POST /message` contract, which targets the managed workload bridge in `managed` mode     | e2e           | NOT TESTED | `apps/runtime/src/__tests__/e2e/external-agent-host.test.ts`   |
| 11  | Tool Proxy executes MCP tool with audit logging                                                                                                                                                | integration   | NOT TESTED | `apps/runtime/src/__tests__/tool-proxy.test.ts`                |
| 12  | Prompt Template Service returns active version with ETag caching                                                                                                                               | integration   | NOT TESTED | `apps/runtime/src/__tests__/prompt-templates.test.ts`          |
| 13  | Feature gate blocks external agent creation on FREE/TEAM plans                                                                                                                                 | integration   | NOT TESTED | `apps/runtime/src/__tests__/external-agent-deployment.test.ts` |
| 14  | External agent health degradation triggers alert within 30s                                                                                                                                    | integration   | NOT TESTED | Health monitoring test                                         |
| 15  | Deployment promote + rollback restores the previous active version without weighted traffic splitting                                                                                          | e2e           | NOT TESTED | Deployment lifecycle test                                      |
| 16  | Guardrail or budget dependency outage obeys project-scoped governance availability policy (default fail-closed)                                                                                | integration   | NOT TESTED | LLM proxy governance-availability test                         |
| 17  | Deployment provisioning rejects zero-binding or multi-binding API keys, includes `prompts:read` in the deployment scope set, and registers exactly one deployment-scoped A2A connection        | integration   | NOT TESTED | Deployment auth + A2A registration test                        |
| 18  | Managed-mode provisioning resolves the customer launch command, mounts the bootstrap launcher, and fails closed before rollout when no launch command can be derived                           | integration   | NOT TESTED | Deployment bootstrap contract test                             |

### Testing Notes

All tests must exercise real platform infrastructure — no mocking of `@agent-platform/*` or `@abl/*` packages (per CLAUDE.md Test Architecture). E2E tests interact via HTTP API only. Integration tests use real ModelResolutionService, `GuardrailPipelineImpl` (via `createGuardrailPipeline()`), and HybridBudgetEnforcer instances.

- Zero-code onboarding coverage must include a managed-adapter workload that does not implement platform-owned `/message`, `/health`, or A2A routes in customer code.
- Zero-code onboarding coverage must prove that `managed` mode sidecar delivery targets the platform-managed workload bridge over loopback HTTP rather than customer-owned platform routes.
- Managed-mode provisioning coverage must assert the bootstrap launcher volume mount, workload command override, persisted `resolvedLaunchCommand`, and preflight failure when neither OCI image metadata nor `startCommandOverride` yields a customer launch command.
- Optional passthrough coverage, when added, must prove the sidecar still owns the platform contract while proxying to internal workload HTTP paths.
- A2A coverage must exercise the connection-scoped `A2AExpressHandlers` route shape and per-connection inbound API-key validation; generic `/a2a` route coverage is insufficient.
- Config coverage must verify snapshot semantics explicitly: mutate live project or tenant configuration after deployment and prove existing deployments still receive their frozen snapshot values.
- Governance availability coverage must assert fail-closed default behavior and verify that no upstream provider call is attempted on blocked requests.
- Phase 1 security posture tests and rollout docs must not assume container egress is blocked by default; NetworkPolicy enforcement is a Phase 3 control.

> Full testing details: `../testing/external-agent-host.md`

---

## 18. References

- RFI Response: `/Users/prasannaarikala/projects/rfi-response-pepgenx.md` (AD-001, AD-002, AD-003, AD-005, AD-008, AD-010)
- Design docs: `docs/specs/` (to be created as HLD)
- Related feature docs: [A2A Integration](a2a-integration.md), [Model Hub](model-hub.md), [Guardrails](guardrails.md), [Deployments & Versioning](deployments-versioning.md), [MCP Support](mcp-support.md), [Channels](channels.md), [Encryption at Rest](encryption-at-rest.md), [KMS](kms.md)
- Existing Python SDK: `packages/academy/content/modules/python-sdk/`
- Provider Factory: `packages/llm/src/provider-factory.ts`
- Model Resolution: `apps/runtime/src/services/llm/model-resolution.ts`
- API Key model: `packages/database/src/models/api-key.model.ts`
- Deployment model: `packages/database/src/models/deployment.model.ts`

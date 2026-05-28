# Feature: Model Hub

**Doc Type**: MAJOR FEATURE
**Parent Feature**: N/A
**Status**: BETA
**Feature Area(s)**: `agent lifecycle`, `integrations`, `governance`, `enterprise`
**Package(s)**: `apps/runtime`, `apps/studio`, `apps/admin`, `packages/database`, `packages/compiler`, `packages/llm`
**Owner(s)**: `Platform team`
**Testing Guide**: [docs/testing/model-hub.md](../testing/model-hub.md)
**Last Updated**: 2026-04-15

---

## 1. Introduction / Overview

### Problem Statement

Every agent execution path in the platform -- reasoning, guardrails, evals, SearchAI, voice -- requires a resolved LLM model, decrypted credential, and capability profile before it can make an API call. Without a centralized model control plane, each execution path would independently manage provider integrations, credential storage, model selection, and capability discovery. This creates duplication, inconsistent behavior across features, credential sprawl, and no visibility into which model is being used or why.

Today, Model Hub is the platform layer that manages which LLMs are available, how they are provisioned at the tenant level, how model selection cascades from tenant defaults down through project tiers and agent overrides, and how the runtime resolves the effective provider, credential, and parameters for each LLM call.

### Goal Statement

The goal of Model Hub is to provide a consistent, scoped, provider-agnostic model control plane that decides which models are available, how they are configured, and how runtime resolution chooses the effective provider, credentials, and capability profile for each LLM call -- while enforcing tenant governance policies and providing diagnostic visibility into every resolution decision.

### Summary

Model Hub is built on the Vercel AI SDK for provider integration, giving a unified streaming, tool calling, and provider-agnostic interface across all supported providers. The `@agent-platform/llm` package provides a `createVercelProvider()` factory that maps platform provider names to their SDK-specific implementations (source: `packages/llm/src/provider-factory.ts`), while the compiler's `MODEL_REGISTRY` provides 147 models across 6 providers with hyperparameter definitions and structured capabilities (source: `packages/compiler/src/platform/llm/model-registry.ts`). The runtime's `ModelResolutionService` executes a deterministic 5-level resolution chain (source: `apps/runtime/src/services/llm/model-resolution.ts`) and the `ModelCatalogService` provides a hybrid catalog combining built-in models, LiteLLM data, and gateway discovery (source: `apps/runtime/src/services/llm/model-catalog.ts`).

---

## 2. Scope

### Goals

- Provide a unified public and tenant model catalog with scoped provisioning and capability metadata (147 built-in models, 6 providers, plus LiteLLM gateway discovery).
- Support project-tier and agent-level overrides on top of tenant defaults through a deterministic 5-level resolution chain.
- Expose provider-agnostic model execution through the Vercel AI SDK while preserving provider-specific capabilities and safety controls.
- Enforce tenant-level LLM governance policies including provider allowlists, token budgets, rate limits, and credential policies.
- Provide diagnostic visibility into every model resolution decision through the `ModelResolutionAnalyzer`.

### Non-Goals (Out of Scope)

- This feature does not replace downstream execution features like evals, guardrails, or voice; it configures the models they use.
- This feature does not yet automate model deprecation migration or tenant notification for deprecated models.
- This feature does not provide cross-tenant model sharing -- each tenant must independently provision models.
- This feature does not handle fine-tuning, model training, or custom model hosting.

---

## 3. User Stories

1. As a **tenant admin**, I want to provision and manage provider-backed models with encrypted credentials so that teams can use approved models without hand-wiring API keys everywhere.
2. As a **project owner**, I want project-level operation-tier mapping (e.g., "use powerful tier for reasoning, fast tier for extraction") so that different tasks can use the right model profile for cost and quality.
3. As a **agent developer**, I want per-agent model overrides (model, temperature, maxTokens, hyperParameters) so that I can fine-tune an agent's behavior without affecting the project defaults.
4. As a **runtime operator**, I want deterministic model and credential resolution with diagnostic tracing so that every LLM call can be explained and debugged when issues arise.
5. As a **platform admin**, I want cross-tenant model management via the admin portal so that I can provision, monitor, and manage model fleets at scale.
6. As a **tenant admin**, I want to set LLM governance policies (allowed providers, token budgets, rate limits) so that usage stays within approved boundaries.

---

## 4. Functional Requirements

1. **FR-1**: The system must provide a public model catalog listing 147+ built-in models across 6 providers (Anthropic, OpenAI, Google, Azure, Cohere, Groq) with capability metadata, hyperparameter definitions, and pricing data (source: `packages/compiler/src/platform/llm/model-registry.ts`).
2. **FR-2**: The system must support tenant model CRUD with multiple named connections per model, encrypted credential storage via AES-256-GCM, and health status tracking (source: `packages/database/src/models/tenant-model.model.ts`, `packages/database/src/models/llm-credential.model.ts`).
3. **FR-3**: The system must resolve the effective model through a deterministic 5-level chain: deployment override -> agent IR -> agent DB -> project DB -> tenant model, failing explicitly if no valid path exists (source: `apps/runtime/src/services/llm/model-resolution.ts`).
4. **FR-4**: The system must support project-level operation-tier overrides mapping operations (extraction, validation, tool_selection, response_gen, summarization, reasoning, coordination, realtime_voice) to tiers (fast, balanced, powerful) (source: `packages/database/src/models/project-llm-config.model.ts`).
5. **FR-5**: The system must support per-agent model configuration overrides including defaultModel, operationModels, temperature, maxTokens, hyperParameters, useResponsesApi, and useStreaming (source: `packages/database/src/models/agent-model-config.model.ts`).
6. **FR-6**: The system must expose capability-aware model selection via the catalog API, including modalities, features (streaming, tools, vision, reasoning, structured output, realtime voice), limits, and parameter support matrix (source: `packages/compiler/src/platform/llm/model-capabilities.ts`).
7. **FR-7**: The system must enforce tenant-level LLM policies including allowed provider lists, credential policies, monthly/daily token budgets, rate limits, and platform demo access control (source: `packages/database/src/models/tenant-llm-policy.model.ts`).
8. **FR-8**: The system must record per-call LLM usage metrics (provider, model, operation, input/output/total tokens, latency, estimated cost, status) for analytics and billing visibility (source: `packages/database/src/models/llm-usage-metric.model.ts`).
9. **FR-9**: The system must provide diagnostic analysis of the model resolution chain via `ModelResolutionAnalyzer` producing structured findings with severity and evidence for debugging (source: `apps/runtime/src/services/diagnostics/analyzers/model-resolution.ts`).
10. **FR-10**: The system must map 15 provider types to Vercel AI SDK factories via `createVercelProvider()` with proper handling of OpenAI Responses API auto-detection, Azure deployment URLs, and OpenAI-compatible providers (source: `packages/llm/src/provider-factory.ts`).

---

## 5. Feature Classification & Integration Matrix

### Lifecycle / Platform Impact

| Area                       | Impact Level | Notes                                                                                     |
| -------------------------- | ------------ | ----------------------------------------------------------------------------------------- |
| Project lifecycle          | SECONDARY    | Projects configure operation tiers and overrides through Model Hub.                       |
| Agent lifecycle            | PRIMARY      | Agent execution depends directly on the resolved model and parameters.                    |
| Customer experience        | SECONDARY    | Better model selection affects final runtime quality indirectly.                          |
| Integrations / channels    | PRIMARY      | Voice, SearchAI, guardrails, evals, and standard chat all rely on model resolution.       |
| Observability / tracing    | SECONDARY    | Usage metrics and diagnostic analyzers explain provider and model decisions.              |
| Governance / controls      | PRIMARY      | Tenant LLM policies, credential rules, and provider allowlists live here.                 |
| Enterprise / compliance    | PRIMARY      | Credential encryption, provider approval, and SSRF-safe gateway discovery matter heavily. |
| Admin / operator workflows | PRIMARY      | Tenant provisioning and connection management are core admin workflows.                   |

### Related Feature Integration Matrix

| Related Feature                                       | Relationship Type | Why It Matters                                                                                                        | Key Touchpoints                                                                       | Current State      |
| ----------------------------------------------------- | ----------------- | --------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------- | ------------------ |
| [Voice Capabilities](./voice-capabilities.md)         | configured by     | Realtime voice execution depends on model capabilities and realtime config.                                           | `realtime_voice`, tenant service instances, provider support                          | Active integration |
| [Agent Testing & Evals](./agent-testing-evals.md)     | configured by     | Persona simulation and judge flows need resolved model/credential choices.                                            | LLM judges, persona models, preflight checks                                          | Active integration |
| [Tracing & Observability](./tracing-observability.md) | emits into        | Model usage and resolution diagnostics feed observability workflows.                                                  | `llm_usage_metrics`, analyzers, logs                                                  | Active integration |
| [Auth Profiles](./auth-profiles.md)                   | shares data with  | `authProfileId` on connections resolved via `ModelResolutionService`; on service instances via `VoiceServiceFactory`. | `tenant_models.connections[].authProfileId`, `tenant_service_instances.authProfileId` | Active integration |
| [Guardrails](./guardrails.md)                         | configured by     | Guardrail providers that use LLM backends resolve models through Hub.                                                 | Model-based guardrail providers                                                       | Active integration |
| [SearchAI](./search-ai.md)                            | configured by     | Embedding and generation models resolved through the same credential chain.                                           | Worker LLM client, provider factory                                                   | Active integration |

---

## 6. Design Considerations (Optional)

- The UI separates tenant provisioning, project-level settings, and per-agent overrides so users can reason about scope.
- Capability-aware controls are intentionally dynamic, driven by model metadata rather than hardcoded per-provider UI branches.
- Admin and Studio both consume the same underlying model-management concepts even though their surfaces differ.
- The `ModelCapabilities` V2 interface provides structured metadata (modalities, features, limits, parameter support matrix, reasoning config, pricing) for JSON-based UI generation rather than simple string arrays.

---

## 7. Technical Considerations (Optional)

- The Vercel AI SDK gives the platform one provider-neutral execution interface while still allowing provider-specific base URLs and options.
- The 5-level resolution chain is the core technical contract and needs to stay explainable through diagnostics.
- LiteLLM gateway discovery is intentionally SSRF-protected because it reaches arbitrary configured endpoints (blocked: localhost, loopback, metadata endpoints, private IP ranges).
- Provider instances are cached in a process-level LRU cache (keyed by `providerType:sha256(apiKey):baseUrl`, max 500, TTL 30min) to avoid recreating Vercel AI SDK instances per call.
- Credential changes invalidate the provider cache via `clearProviderCache(tenantId?)` which uses a reverse index for tenant-scoped eviction.
- Cross-pod cache invalidation uses Redis pub/sub on the `model-hub:invalidation` channel with HMAC-SHA256 message signing (derived from `ENCRYPTION_MASTER_KEY`). Invalid messages are dropped without triggering cache flushes.
- Budget enforcement uses in-memory daily/monthly token counters with pre-debit on estimated tokens before each LLM call and post-call correction with actual token usage from the Vercel AI SDK response.
- Automated health checks run on a configurable `setInterval` cycle, using a lightweight `generateText()` call with `maxOutputTokens: 1` to verify credential validity.
- The `worker-llm-client.ts` in `packages/llm` enables SearchAI workers to share the same provider factory.

---

## 8. How to Consume

### Studio UI

Studio surfaces model hub behavior through model-management pages, project settings model tabs, and per-agent model config tabs.

- **Tenant Model Management**: Workspace settings for provisioning models and managing connections
- **Project Model Settings**: `/projects/:projectId/settings` -- ModelConfigTab for operation-tier mapping (source: `apps/studio/src/components/settings/ModelConfigTab.tsx`)
- **Agent Model Config**: Per-agent model tab (`AgentModelTab`) for overriding default model, temperature, max tokens, hyperparameters, streaming, and Responses API settings (source: `apps/studio/src/components/agents/AgentModelTab.tsx`)
- **Model Capabilities**: Dynamic hyperparameter controls rendered from `GET /api/model-capabilities/:modelId`
- **Model Resolution Inspector**: Observatory component for debugging resolution chain (source: `apps/studio/src/components/observatory/ModelResolutionInspector.tsx`)

### API (Runtime)

| Method | Path                                                      | Purpose                                              |
| ------ | --------------------------------------------------------- | ---------------------------------------------------- |
| GET    | `/api/model-catalog`                                      | List available models (optional `?provider=` filter) |
| GET    | `/api/model-catalog/:modelId`                             | Get specific model details                           |
| POST   | `/api/model-catalog/refresh`                              | Force refresh from LiteLLM (admin, credential:write) |
| POST   | `/api/model-catalog/gateway-discovery`                    | Discover models from LiteLLM gateway (admin)         |
| GET    | `/api/model-capabilities/:modelId`                        | Get hyperparameters and capability metadata          |
| GET    | `/api/tenants/:tenantId/models`                           | List tenant models                                   |
| POST   | `/api/tenants/:tenantId/models`                           | Create tenant model                                  |
| GET    | `/api/tenants/:tenantId/models/:id`                       | Get tenant model with connections                    |
| PUT    | `/api/tenants/:tenantId/models/:id`                       | Update tenant model                                  |
| DELETE | `/api/tenants/:tenantId/models/:id`                       | Delete tenant model                                  |
| POST   | `/api/tenants/:tenantId/models/:id/connections`           | Add connection to tenant model                       |
| PUT    | `/api/tenants/:tenantId/models/:id/connections/:connId`   | Update connection                                    |
| DELETE | `/api/tenants/:tenantId/models/:id/connections/:connId`   | Remove connection                                    |
| PUT    | `/api/tenants/:tenantId/models/:id/inference`             | Toggle inference enabled/disabled                    |
| GET    | `/api/projects/:projectId/llm-config`                     | Get project operation-tier overrides                 |
| PUT    | `/api/projects/:projectId/llm-config`                     | Upsert project operation-tier overrides              |
| GET    | `/api/projects/:projectId/agents/:agentName/model-config` | Get agent model config                               |
| PUT    | `/api/projects/:projectId/agents/:agentName/model-config` | Upsert agent model config                            |

### API (Studio)

| Method   | Path                                               | Purpose                             |
| -------- | -------------------------------------------------- | ----------------------------------- |
| GET      | `/api/model-catalog`                               | Studio proxy/catalog surface        |
| GET/POST | `/api/models`                                      | Studio model routes                 |
| GET/POST | `/api/tenant-models`                               | Tenant model management in Studio   |
| GET/POST | `/api/platform-admin/tenant-models`                | Platform-admin tenant model surface |
| GET/PUT  | `/api/projects/[id]/agents/[agentId]/model-config` | Agent model config proxy            |

### Admin Portal

Admin provides tenant model provisioning and tenant-model connection management through `apps/admin/src/app/(dashboard)/models/*` and related API routes. Admin capabilities include model listing, detail views, connection validation, and activation/deactivation. Platform admin routes at `/api/platform-admin/tenant-models` provide cross-tenant model management.

Admin routes require `credential:write` permission and tenant OWNER or ADMIN role.

### Channel / SDK / Voice / A2A / MCP Integration

Model selection is used by all execution paths. Channel-specific features depend on capability flags:

- **Digital channels**: Standard text completion with streaming and tool calling
- **Voice channels**: Realtime voice models resolved via `realtime_voice` operation type with `realtimeConfig` (audio format, VAD, voices)
- **SearchAI**: Embedding and generation models resolved through the same credential chain via `worker-llm-client.ts`
- **Guardrails / Evals**: Use operation-tier mapping to select appropriate models per task

---

## 9. Data Model

### Collections / Tables

```text
Collection: tenant_models
Purpose: Tenant-provisioned model definitions and connection metadata
Fields:
  - _id: string (UUID v7, auto-generated)
  - tenantId: string (required, indexed)
  - displayName: string (required)
  - integrationType: string (required -- 'easy' or 'api')
  - modelId: string | null (provider model identifier)
  - provider: string | null (e.g. 'anthropic', 'openai')
  - providerStructure: string | null (custom API structure type)
  - requestTemplate: Mixed (default {}, custom request template for API type)
  - responseMapping: Mixed (default {}, custom response field mapping)
  - gatewayConfig: Mixed (default {}, LiteLLM gateway configuration)
  - temperature: number (required)
  - maxTokens: number (required)
  - hyperParameters: Mixed (default {}, provider-specific key-value pairs)
  - supportsTools: boolean (required)
  - supportsStreaming: boolean (required)
  - supportsVision: boolean (required)
  - supportsStructured: boolean (required)
  - useResponsesApi: boolean | null (OpenAI only: null=auto, true=force Responses API, false=force Chat Completions)
  - useStreaming: boolean | null (null=auto from supportsStreaming, true/false=forced)
  - capabilities: string[] (default ['text'], e.g. ['text', 'imageToText'])
  - realtimeConfig: Mixed | null (voice-specific: audio format, VAD, voices)
  - tier: string (required -- 'fast', 'balanced', 'powerful')
  - isDefault: boolean (default false)
  - isActive: boolean (default true)
  - inferenceEnabled: boolean (default true)
  - createdBy: string (required)
  - connections: ITenantModelConnection[] (embedded subdocuments)
  - provisionedBy: string | null (admin who provisioned)
  - provisionedAt: Date | null
  - provisioningNote: string | null
  - _v: number (schema version, default 1)
  - createdAt: Date (auto)
  - updatedAt: Date (auto)

Embedded: ITenantModelConnection
  - id: string (required, UUID v7)
  - credentialId: string (required, references llm_credentials._id)
  - authProfileId: string | null (optional auth profile reference)
  - connectionType: 'http' | 'websocket' (default 'http')
  - isActive: boolean (required)
  - isPrimary: boolean (required)
  - lastHealthCheck: Date | null
  - healthStatus: 'healthy' | 'unhealthy' | 'unknown' | 'unchecked' (default 'unchecked')
  - healthMessage: string | null
  - createdBy: string (required)
  - createdAt: Date (required)
  - updatedAt: Date (required)

Plugins:
  - tenantIsolationPlugin -- enforces tenantId on all queries

Indexes:
  - UNIQUE: { tenantId: 1, displayName: 1 }
  - { tenantId: 1, tier: 1, isActive: 1 }
  - { tenantId: 1, provider: 1, isActive: 1 }
  - { tenantId: 1, capabilities: 1, isActive: 1 }
  - { provisionedBy: 1, createdAt: -1 } (sparse)
```

```text
Collection: model_configs
Purpose: Project-level model configuration with provider settings and tiering
Fields:
  - _id: string (UUID v7, auto-generated)
  - projectId: string (required, indexed)
  - name: string (required)
  - modelId: string (required)
  - provider: string (required)
  - credentialId: string | null (references llm_credentials._id)
  - authProfileId: string | null (reserved -- not yet wired)
  - tenantModelId: string | null (references tenant_models._id)
  - temperature: number (required)
  - maxTokens: number (required)
  - topP: number (required)
  - frequencyPenalty: number (required)
  - presencePenalty: number (required)
  - inputCostPer1k: number | null
  - outputCostPer1k: number | null
  - supportsTools: boolean (required)
  - supportsVision: boolean (required)
  - supportsStreaming: boolean (required)
  - useResponsesApi: boolean | null (project-level override)
  - useStreaming: boolean | null (project-level streaming override)
  - contextWindow: number (required)
  - tier: string (required -- 'fast', 'balanced', 'powerful')
  - isDefault: boolean (required)
  - priority: number (required -- higher = higher priority)
  - _v: number (default 1)
  - createdAt: Date (auto)
  - updatedAt: Date (auto)

Indexes:
  - UNIQUE: { projectId: 1, name: 1 }
  - { projectId: 1 }
  - { tier: 1 }
Note: No tenantIsolationPlugin -- isolation via projectId -> Project.tenantId join.
```

```text
Collection: project_llm_configs
Purpose: Per-project operation-to-tier mapping overrides
Fields:
  - _id: string (UUID v7, auto-generated)
  - tenantId: string (required, indexed)
  - projectId: string (required, indexed)
  - operationTierOverrides: Map<string, string> (operation -> tier)
  - _v: number (default 1)
  - createdAt: Date (auto)
  - updatedAt: Date (auto)

Plugins:
  - tenantIsolationPlugin

Indexes:
  - UNIQUE: { tenantId: 1, projectId: 1 }
```

```text
Collection: agent_model_configs
Purpose: Per-agent model overrides within a project
Fields:
  - _id: string (UUID v7, auto-generated)
  - projectId: string (required, indexed)
  - agentName: string (required, indexed)
  - defaultModel: string | null
  - operationModels: Mixed | null (operation -> model mapping)
  - temperature: number | null
  - maxTokens: number | null
  - hyperParameters: Mixed | null (flexible parameter bag)
  - useResponsesApi: boolean | null (OpenAI override)
  - useStreaming: boolean | null (streaming override)
  - _v: number (default 1)
  - createdAt: Date (auto)
  - updatedAt: Date (auto)

Indexes:
  - UNIQUE: { projectId: 1, agentName: 1 }
  - { projectId: 1 }
```

```text
Collection: llm_credentials
Purpose: Encrypted API keys and endpoint configurations for LLM providers
Fields:
  - _id: string (UUID v7, auto-generated)
  - credentialScope: 'user' | 'tenant' (required)
  - ownerId: string (required -- userId or tenantId)
  - tenantId: string (required, indexed)
  - provider: string (required)
  - name: string (required)
  - encryptedApiKey: string (required, encrypted at rest via encryption plugin)
  - encryptedEndpoint: string | null (encrypted, custom endpoint URL)
  - customHeaders: Mixed | null (additional HTTP headers)
  - authType: string (required, e.g. 'api_key', 'bearer')
  - authConfig: Mixed (default {}, provider-specific auth config)
  - isActive: boolean (default true)
  - isDefault: boolean (default false)
  - lastUsedAt: Date | null
  - lastValidatedAt: Date | null
  - _v: number (default 1)
  - createdAt: Date (auto)
  - updatedAt: Date (auto)

Plugins:
  - tenantIsolationPlugin
  - encryptionPlugin (encrypts: encryptedApiKey, encryptedEndpoint)
  - auditTrailPlugin

Indexes:
  - UNIQUE: { tenantId: 1, credentialScope: 1, ownerId: 1, provider: 1, name: 1 }
  - { tenantId: 1, credentialScope: 1, ownerId: 1 }
  - { provider: 1 }
  - { tenantId: 1 }
```

```text
Collection: tenant_llm_policies
Purpose: Tenant-level LLM usage governance
Fields:
  - _id: string (UUID v7, auto-generated)
  - tenantId: string (required, indexed)
  - allowedProviders: string[] (default [])
  - credentialPolicy: string (required)
  - monthlyTokenBudget: number (required)
  - dailyTokenBudget: number (required)
  - defaultModel: string | null
  - defaultFastModel: string | null
  - defaultVoiceModel: string | null
  - maxRequestsPerMinute: number (required)
  - allowProjectCredentials: boolean (required)
  - platformDemoEnabled: boolean (required)
  - _v: number (default 1)
  - createdAt: Date (auto)
  - updatedAt: Date (auto)

Plugins:
  - tenantIsolationPlugin

Indexes:
  - UNIQUE: { tenantId: 1 }
```

```text
Collection: llm_usage_metrics
Purpose: Per-call LLM invocation metrics for analytics and billing
Fields:
  - _id: string (UUID v7, auto-generated)
  - tenantId: string (required, indexed)
  - sessionId: string (required, indexed)
  - agentName: string (required)
  - provider: string (required)
  - model: string (required)
  - operation: string (required)
  - inputTokens: number (required)
  - outputTokens: number (required)
  - totalTokens: number (required)
  - latencyMs: number (required)
  - estimatedCost: number (required)
  - status: string (required)
  - errorMessage: string | null
  - metadata: Mixed | null
  - _v: number (default 1)
  - createdAt: Date (auto)
  - updatedAt: Date (auto)

Plugins:
  - tenantIsolationPlugin

Indexes:
  - { tenantId: 1, createdAt: -1 }
  - { sessionId: 1 }
  - { tenantId: 1, provider: 1, model: 1 }
  - { tenantId: 1, agentName: 1 }
  - { status: 1 }
```

```text
Collection: tenant_service_instances
Purpose: Third-party service configurations (Deepgram, ElevenLabs, Twilio)
Related: Voice models resolve through tenant service instances for STT/TTS
Fields:
  - _id: string (UUID v7)
  - tenantId: string (required)
  - displayName: string (required)
  - serviceType: string (required)
  - encryptedApiKey: string (required, encrypted)
  - authProfileId: string | null (reserved)
  - encryptedConfig: Mixed (encrypted)
  - jambonzSpeechCredentialSid: string | null
  - isDefault: boolean (default false)
  - isActive: boolean (default true)
  - createdBy: string (required)
  - _v: number (default 1)
  - createdAt/updatedAt: Date (auto)

Plugins:
  - tenantIsolationPlugin
  - encryptionPlugin (encrypts: encryptedApiKey, encryptedConfig)
```

### Key Relationships

- **tenant_models.connections[].credentialId** -> `llm_credentials._id` (each connection uses a specific credential)
- **model_configs.tenantModelId** -> `tenant_models._id` (project configs reference tenant models)
- **model_configs.credentialId** -> `llm_credentials._id` (project configs may pin a specific credential)
- **agent_model_configs.projectId** -> `projects._id` (agent overrides scoped to project)
- **project_llm_configs.projectId** -> `projects._id` (operation-tier mapping per project)
- **tenant_llm_policies.tenantId** -> `tenants._id` (one policy document per tenant)
- **llm_usage_metrics** references sessionId, agentName, provider, and model for analytics join

---

## 10. Key Implementation Files

### Domain / Core Logic

| File                                                                  | Purpose                                                                                      |
| --------------------------------------------------------------------- | -------------------------------------------------------------------------------------------- |
| `packages/compiler/src/platform/model-registry/registry.ts`           | `ModelRegistry` -- intelligent routing with scoring, fallback chains, 8 built-in models      |
| `packages/compiler/src/platform/llm/model-registry.ts`                | `MODEL_REGISTRY` -- 147 models, 6 providers, hyperparameter definitions, capabilities V2     |
| `packages/compiler/src/platform/llm/model-capabilities.ts`            | `ModelCapabilities` -- derives capability flags from model registry for runtime              |
| `packages/compiler/src/platform/llm/types.ts`                         | `LLMProviderType`, `ModelTier`, `LLMProvider` interface, `ProviderConfig` union              |
| `packages/llm/src/provider-factory.ts`                                | `createVercelProvider()` -- maps 15 provider types to Vercel AI SDK factories                |
| `packages/llm/src/worker-llm-client.ts`                               | Worker LLM client for SearchAI workers sharing the provider factory                          |
| `apps/runtime/src/services/llm/model-resolution.ts`                   | `ModelResolutionService` -- 5-level resolution chain with credential decryption              |
| `apps/runtime/src/services/llm/model-catalog.ts`                      | `ModelCatalogService` -- hybrid catalog: built-in + LiteLLM + gateway discovery              |
| `apps/runtime/src/services/llm/provider-cache.ts`                     | Dependency-free provider instance cache with tenant-scoped eviction and configurable max/TTL |
| `apps/runtime/src/services/llm/session-llm-client.ts`                 | `SessionLLMClient` -- per-session LLM client with provider caching and timeouts              |
| `apps/runtime/src/repos/tenant-model-repo.ts`                         | Tenant model persistence, connection CRUD, impact analysis, credential lookup                |
| `apps/runtime/src/services/llm/budget-enforcement.ts`                 | In-memory daily/monthly token budget enforcement with pre-debit and post-call correction     |
| `apps/runtime/src/services/llm/model-cache-invalidation.ts`           | Cross-pod cache invalidation via Redis pub/sub with HMAC-SHA256 message integrity            |
| `apps/runtime/src/services/llm/model-health-service.ts`               | Automated health check service with setInterval periodic job and connection validation       |
| `apps/runtime/src/services/llm/model-resolution-errors.ts`            | Typed error classes for model resolution failures                                            |
| `apps/runtime/src/services/llm/model-resolution-versioning.ts`        | Cache versioning contract for model resolution (see Model Resolution Contract in CLAUDE.md)  |
| `apps/runtime/src/services/llm/chat-resolution-service.ts`            | Chat-specific model resolution bridging session context to `ModelResolutionService`          |
| `apps/runtime/src/services/llm/classify-llm-error.ts`                 | LLM error classification (retryable, rate-limit, auth, etc.)                                 |
| `apps/runtime/src/services/llm/model-router.ts`                       | Model routing logic for operation-to-model mapping                                           |
| `apps/runtime/src/services/llm/vercel-ai-adapters.ts`                 | Adapter utilities bridging platform types to Vercel AI SDK types                             |
| `apps/runtime/src/services/llm/provider-semaphore.ts`                 | Per-provider concurrency limiter for LLM calls                                               |
| `apps/runtime/src/repos/llm-resolution-repo.ts`                       | Resolution data access layer for model/credential lookups across all 5 levels                |
| `apps/runtime/src/services/diagnostics/analyzers/model-resolution.ts` | `ModelResolutionAnalyzer` -- diagnostic 5-level chain walk for debugging                     |

### Database Models

| File                                                       | Purpose                            |
| ---------------------------------------------------------- | ---------------------------------- |
| `packages/database/src/models/tenant-model.model.ts`       | TenantModel schema (tenant_models) |
| `packages/database/src/models/model-config.model.ts`       | ModelConfig schema (model_configs) |
| `packages/database/src/models/project-llm-config.model.ts` | ProjectLLMConfig schema            |
| `packages/database/src/models/agent-model-config.model.ts` | AgentModelConfig schema            |
| `packages/database/src/models/llm-credential.model.ts`     | LLMCredential schema (encrypted)   |
| `packages/database/src/models/tenant-llm-policy.model.ts`  | TenantLLMPolicy schema             |
| `packages/database/src/models/llm-usage-metric.model.ts`   | LLMUsageMetric schema              |

### Routes / Handlers

| File                                                  | Purpose                                                   |
| ----------------------------------------------------- | --------------------------------------------------------- |
| `apps/runtime/src/routes/model-catalog.ts`            | Model catalog listing, detail, refresh, gateway discovery |
| `apps/runtime/src/routes/model-capabilities.ts`       | Model hyperparameter and capability API                   |
| `apps/runtime/src/routes/tenant-models.ts`            | Tenant model CRUD, connections, inference toggle          |
| `apps/runtime/src/routes/project-llm-config.ts`       | Project operation-tier override CRUD                      |
| `apps/runtime/src/routes/agent-model-config.ts`       | Agent-level model override CRUD                           |
| `apps/runtime/src/routes/platform-admin-models.ts`    | Platform admin cross-tenant model management              |
| `apps/runtime/src/routes/tenant-service-instances.ts` | Third-party service instance management (voice providers) |

### UI Components

| File                                                                  | Purpose                         |
| --------------------------------------------------------------------- | ------------------------------- |
| `apps/studio/src/components/agents/AgentModelTab.tsx`                 | Per-agent config UI             |
| `apps/studio/src/components/settings/ModelConfigTab.tsx`              | Project-level model settings    |
| `apps/studio/src/components/observatory/ModelResolutionInspector.tsx` | Resolution chain debugging UI   |
| `apps/studio/src/hooks/useModelResolution.ts`                         | React hook for model resolution |
| `apps/studio/src/components/icons/ProviderIcons.tsx`                  | Provider logo icons             |
| `apps/admin/src/app/(dashboard)/models/page.tsx`                      | Admin model list                |
| `apps/admin/src/app/(dashboard)/models/[id]/page.tsx`                 | Admin model detail              |

### Jobs / Workers / Background Processes

| File                                                        | Purpose                                                                 |
| ----------------------------------------------------------- | ----------------------------------------------------------------------- |
| `apps/runtime/src/services/credential-age-monitor.ts`       | Monitors credential age for rotation warnings                           |
| `apps/runtime/src/services/llm/model-health-service.ts`     | Automated health check job (`startModelHealthJob`/`stopModelHealthJob`) |
| `apps/runtime/src/services/llm/model-cache-invalidation.ts` | Redis pub/sub subscriber for cross-pod cache invalidation events        |

### Tests

| File                                                                                 | Type        | Coverage Focus                                         |
| ------------------------------------------------------------------------------------ | ----------- | ------------------------------------------------------ |
| `apps/runtime/src/__tests__/model-catalog.test.ts`                                   | integration | Catalog listing, filtering, detail, refresh, SSRF      |
| `apps/runtime/src/__tests__/tenant-model-routes.test.ts`                             | integration | Tenant model CRUD route flow                           |
| `apps/runtime/src/__tests__/tenant-models.test.ts`                                   | integration | Tenant model route validation                          |
| `apps/runtime/src/__tests__/auth/tenant-models-authz.test.ts`                        | integration | Tenant model authorization checks                      |
| `apps/runtime/src/__tests__/tenant-model-repo-isolation.test.ts`                     | integration | Repo-level tenant isolation verification               |
| `apps/runtime/src/__tests__/tenant-model-credential-ownership-route.test.ts`         | integration | Credential ownership validation on tenant model routes |
| `apps/runtime/src/__tests__/auth/agent-model-config-authz.test.ts`                   | integration | Agent model override authorization                     |
| `apps/runtime/src/__tests__/model-resolution-analyzer.test.ts`                       | integration | Diagnostic analyzer chain walk                         |
| `apps/runtime/src/__tests__/model-resolution-comprehensive.test.ts`                  | integration | End-to-end model resolution behavior                   |
| `apps/runtime/src/__tests__/model-resolution-versioning.test.ts`                     | integration | Model resolution cache versioning contract             |
| `apps/runtime/src/__tests__/auth/platform-admin-models-authz.test.ts`                | integration | Platform admin model route authorization               |
| `apps/runtime/src/__tests__/auth/tenant-service-instances-authz.test.ts`             | integration | Service instance authorization                         |
| `apps/runtime/src/__tests__/llm-wiring.test.ts`                                      | integration | LLM client wiring and provider resolution              |
| `apps/runtime/src/__tests__/llm-services.test.ts`                                    | integration | LLM service layer tests                                |
| `apps/runtime/src/__tests__/llm-integration.test.ts`                                 | integration | LLM integration flows                                  |
| `apps/runtime/src/__tests__/sessions/session-llm-client-timeout.test.ts`             | unit        | LLM call timeout and provider cache behavior           |
| `apps/runtime/src/__tests__/settings-resolution.test.ts`                             | integration | Settings resolution including model config             |
| `apps/runtime/src/__tests__/auth/auth-profile/model-resolution-auth-profile.test.ts` | integration | Auth profile integration with model resolution         |
| `apps/runtime/src/__tests__/streaming-guardrails-model-tier.test.ts`                 | integration | Streaming guardrails with model tier selection         |
| `apps/runtime/src/__tests__/cross-project-isolation.test.ts`                         | integration | Cross-project isolation for model config               |
| `apps/runtime/src/__tests__/credential-chain-analyzer.test.ts`                       | integration | Credential chain analysis diagnostics                  |
| `apps/runtime/src/__tests__/diagnostic-engine.test.ts`                               | integration | Diagnostic engine including model resolution analyzer  |
| `packages/compiler/src/__tests__/llm/model-registry.test.ts`                         | unit        | Model registry entries, capabilities, hyperparams      |
| `packages/compiler/src/platform/llm/__tests__/model-registry.test.ts`                | unit        | Model registry at platform level                       |
| `apps/runtime/src/__tests__/provider-cache-eviction.test.ts`                         | unit        | Provider cache scoped eviction and global clear        |
| `apps/runtime/src/__tests__/llm-budget-enforcement.test.ts`                          | unit        | Budget enforcement limits, passthrough, Redis fail     |
| `apps/runtime/src/__tests__/model-cache-invalidation.test.ts`                        | unit        | Cache invalidation pub/sub, HMAC, degradation          |
| `apps/runtime/src/__tests__/model-health-service.test.ts`                            | unit        | Health check cycle, status, feature flag               |
| `apps/runtime/src/__tests__/model-hub-provisioning.e2e.test.ts`                      | e2e         | Full provisioning flow via HTTP API                    |
| `apps/runtime/src/__tests__/model-hub-isolation.e2e.test.ts`                         | e2e         | Tenant isolation via HTTP API                          |
| `apps/runtime/src/__tests__/model-hub-overrides.e2e.test.ts`                         | e2e         | Project/agent override layering via HTTP API           |
| `apps/studio/src/__tests__/arch-ai/configure-model-helpers.test.ts`                  | unit        | Studio model configuration helper functions            |
| `apps/studio/e2e/model-guardrails-e2e.spec.ts`                                       | e2e         | Model guardrails browser E2E (Playwright)              |

---

## 11. Configuration

### Environment Variables

| Variable                                | Default    | Description                                                                                                                                            |
| --------------------------------------- | ---------- | ------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `LLM_CALL_TIMEOUT_MS`                   | `120000`   | Maximum time (ms) for a single generateText/streamText call. Prevents hung LLM providers.                                                              |
| `LLM_PROVIDER_CACHE_MAX`                | `500`      | Max entries in the process-level provider instance cache (keyed by providerType:apiKeyHash:baseUrl).                                                   |
| `LLM_PROVIDER_CACHE_TTL_SECONDS`        | `1800`     | TTL (seconds) for cached provider instances. Default 30 minutes.                                                                                       |
| `LLM_RESOLUTION_CACHE_TTL_SECONDS`      | `300`      | TTL (seconds) for model resolution cache. Default 5 minutes.                                                                                           |
| `LLM_RESOLUTION_COOLDOWN_SECONDS`       | `30`       | Per-session cooldown (seconds) after a resolution failure before retrying.                                                                             |
| `ENCRYPTION_MASTER_KEY`                 | (required) | 64-character hex string (256-bit) for encrypting LLM credential API keys at rest. Also used to derive HMAC key for cache invalidation message signing. |
| `FEATURE_ENABLE_LLM_BUDGET_ENFORCEMENT` | `false`    | Enable in-memory daily/monthly token budget enforcement in ModelResolutionService.resolve().                                                           |
| `FEATURE_ENABLE_HEALTH_CHECKS`          | `false`    | Enable automated periodic health checks for tenant model connections.                                                                                  |
| `FEATURE_HEALTH_CHECK_INTERVAL_HOURS`   | `4`        | Interval (hours) between automated health check cycles.                                                                                                |

### Runtime Configuration

- **Tenant model provisioning** defines the available provider/endpoint pool per tenant.
- **Tenant LLM policies** govern allowed providers, token budgets (`monthlyTokenBudget`, `dailyTokenBudget`), rate limits (`maxRequestsPerMinute`), credential policies, and platform demo access.
- **Project LLM config** maps operations (extraction, validation, tool_selection, response_gen, summarization, reasoning, coordination) to tiers (fast, balanced, powerful).
- **Agent model config** can override the project decision for one agent with a specific model, temperature, maxTokens, hyperParameters, and streaming/API mode toggles.
- **Model capabilities** expose support for tools, streaming, vision, structured output, realtime voice, reasoning, thinking, parallel tool calls, and web search.
- **Provider cache** is process-level with configurable max entries and TTL to avoid recreating Vercel AI SDK instances.
- **Catalog refresh** from LiteLLM is admin-triggered with 24-hour cache TTL; gateway discovery uses per-request SSRF-validated HTTP calls with 10-second timeout.

### DSL / Agent IR / Schema

Model hub influences IR execution settings. The agent IR can specify a `model` and `operation_models` mapping, which takes priority at Level 1 of the resolution chain. However, the authoritative credential and endpoint records live in tenant/project/agent config collections -- the DSL only declares intent, the runtime resolves the actual provider connection.

---

## 12. Non-Functional Concerns

### Isolation & Multitenancy

| Concern           | Requirement / Expectation                                                                                                                                                                               |
| ----------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Project isolation | Project-scoped model config (`model_configs`) and agent overrides (`agent_model_configs`) must always be filtered by `projectId`. Cross-project access returns 404.                                     |
| Tenant isolation  | Tenant models, credentials, policies, and usage metrics use `tenantIsolationPlugin` ensuring all queries include `tenantId`. Cross-tenant access returns 404.                                           |
| User isolation    | User-scoped credentials (`credentialScope: 'user'`) are filtered by `ownerId`. Credential management in admin requires OWNER/ADMIN role. Platform demo credentials use dedicated `__platform__` tenant. |

### Security & Compliance

- **Credentials encrypted at rest**: `encryptedApiKey` and `encryptedEndpoint` via AES-256-GCM encryption plugin with tenant-scoped key derivation.
- **Audit trail**: All credential mutations logged via `auditTrailPlugin` on `llm_credentials`.
- **SSRF protection**: Gateway discovery validates URLs against private IP ranges, metadata endpoints, and internal hostnames before making HTTP requests.
- **Blocked headers**: Custom headers on connections reject security-sensitive headers (Host, Authorization, Cookie, Transfer-Encoding, Proxy-\*, X-Forwarded-\*) to prevent request smuggling.
- **Tenant isolation**: `tenantIsolationPlugin` on tenant_models, llm_credentials, tenant_llm_policies, llm_usage_metrics. model_configs uses project-join isolation.
- **Rate limiting**: All model hub routes use `tenantRateLimit('request')`.
- **Permission checks**: Tenant model routes require OWNER/ADMIN role; project routes require `model_config:read/write`; catalog refresh requires `credential:write`.

### Performance & Scalability

- **Provider cache**: Process-level LRU cache (max 500, TTL 30min) avoids recreating Vercel AI SDK provider instances per call. Keyed by `providerType:sha256(apiKey):baseUrl`.
- **Resolution cache**: 5-minute TTL cache for model resolution results to avoid repeated DB lookups within a session.
- **Resolution cooldown**: 30-second cooldown after a resolution failure prevents thundering-herd retries.
- **LLM call timeout**: 2-minute AbortSignal-based timeout prevents hung LLM providers from blocking sessions indefinitely.
- **Catalog cache**: Built-in catalog is initialized once; LiteLLM refresh has 24-hour TTL.

### Reliability & Failure Modes

- Resolution failures can cascade into empty or failed runtime responses if no valid model/credential path is found.
- Gateway discovery and provider validation depend on remote services and require strong SSRF and timeout protections.
- Provider cache invalidation is cross-pod via Redis pub/sub with HMAC-signed messages. Stale entries are bounded by 30-minute TTL as a safety net if Redis is unavailable.
- Budget enforcement uses in-memory counters per pod; a tenant hitting their budget on one pod does not immediately block requests on another pod. Counters reset on pod restart. This is acceptable for soft limits; hard limits should use Redis-backed counters (future work).
- Model deprecation notifications and migration tooling are not yet automated.

### Observability

- **Diagnostic analyzer**: `ModelResolutionAnalyzer` walks the 5-level chain and produces structured findings with evidence for debugging empty responses or missing configurations.
- **LLM usage metrics**: Per-call recording of provider, model, operation, token counts (input/output/total), latency, estimated cost, status, and errors.
- **Structured logging**: All services use `createLogger()` with contextual metadata (tenantId, modelId, provider, requestId).
- **Route-level logging**: Request/response logging on all model hub routes with error detail.

### Data Lifecycle

- Model provisioning records, credentials, policy documents, and usage metrics are retained as operational system state.
- Credential records remain encrypted at rest and persist independently of any one session or project override.
- Usage metrics accumulate over time for analytics and billing-style visibility.
- No automated TTL or archival policy currently exists for usage metrics (GAP-003).

---

## 13. Delivery Plan / Work Breakdown

1. Close governance and policy gaps
   1.1 ~~Implement real-time tenant LLM policy enforcement (token budgets, allowed providers)~~ DONE — budget-enforcement.ts + provider allowlist in ModelResolutionService
   1.2 Surface cost/token alerts from `llm_usage_metrics` — OPEN
   1.3 Implement model deprecation notification and migration guidance for tenant admins — OPEN
2. Harden model operations
   2.1 ~~Add automated model health check scheduling~~ DONE — model-health-service.ts with setInterval periodic job
   2.2 Add allowlist support for on-prem LiteLLM proxy discovery (SSRF exception list) — OPEN
   2.3 ~~Wire reserved `authProfileId` fields to runtime credential resolution~~ DONE — already wired via dualReadCredentials
3. Expand end-to-end operator confidence
   3.1 Add full browser/admin provisioning E2E flows across all provider variants — OPEN
   3.2 Add live execution confirmation after provision/override changes — OPEN
   3.3 ~~Add cross-pod provider cache invalidation via Redis pub/sub~~ DONE — model-cache-invalidation.ts with HMAC signing

---

## 14. Success Metrics

| Metric                        | Baseline                                                                         | Target                                                               | How Measured                                  |
| ----------------------------- | -------------------------------------------------------------------------------- | -------------------------------------------------------------------- | --------------------------------------------- |
| Resolution confidence         | Route and analyzer coverage is strong, but some operator journeys remain partial | Provisioning, override, and execution flows are validated end to end | Runtime/admin/studio tests                    |
| Policy enforcement            | Budget and provider-governance data exists but enforcement is partial            | Tenant policy violations are blocked in real time                    | Policy enforcement tests and runtime behavior |
| Operational health visibility | Health checks and cost metrics exist, but alerting and automation are incomplete | Operators have actionable health and cost signals for model fleets   | Admin/runtime monitoring coverage             |

---

## 15. Open Questions

1. Should model deprecation and replacement guidance be automated for tenant admins, and if so, what notification channel (email, in-app, webhook)?
2. How should on-prem LiteLLM proxy allowlists be supported without weakening SSRF protections?
3. Which reserved `authProfileId` integration points should be wired first: model configs, tenant service instances, or both?
4. ~~Should cross-pod provider cache invalidation use Redis pub/sub or rely on TTL-based expiry?~~ ANSWERED: Redis pub/sub with HMAC-SHA256 message signing. TTL (30min) is kept as safety net for Redis unavailability.
5. Should usage metrics have a retention TTL and archival policy, or accumulate indefinitely?

---

## 16. Gaps, Known Issues & Limitations

| ID      | Description                                                                                                                                                                                                                                           | Severity | Status      |
| ------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | -------- | ----------- |
| GAP-001 | UI/browser test coverage is lighter than route and resolver coverage                                                                                                                                                                                  | Low      | Open        |
| GAP-002 | Provider-specific validation varies across custom endpoints and gateways -- no unified validation contract                                                                                                                                            | Medium   | In Progress |
| GAP-003 | Cost/token alerting data is collected in `llm_usage_metrics` but not surfaced as automated alerts                                                                                                                                                     | Medium   | Open        |
| GAP-004 | `model_configs.authProfileId` is reserved for future project-level credential overrides. Not a gap — runtime resolution goes through `tenantModelId → TenantModel → connection.authProfileId` which IS fully wired.                                   | Low      | By Design   |
| GAP-005 | Tenant LLM policy enforcement -- budget enforcement (daily/monthly token limits) now enforced in-memory in ModelResolutionService.resolve(), gated by enableLlmBudgetEnforcement flag. Provider allowlist was already enforced.                       | Medium   | Closed      |
| GAP-006 | Model deprecation handling: `ModelRegistry` tracks `deprecatedAt` and `replacementId` but no automated migration or tenant notification exists                                                                                                        | Medium   | Open        |
| GAP-007 | Model health check automation -- `model-health-service.ts` provides checkConnectionHealth() + setInterval periodic job (startModelHealthJob/stopModelHealthJob), gated by enableHealthChecks flag. Route handler refactored to use extracted service. | Low      | Closed      |
| GAP-008 | Gateway discovery SSRF protection blocks all private IPs but does not support allowlists for on-premise LiteLLM proxies                                                                                                                               | Medium   | Open        |
| GAP-009 | `tenant_service_instances.authProfileId` is wired — `VoiceServiceFactory.resolveAndDecrypt()` uses `dualReadCredentials({ authProfileId: instance.authProfileId })`. Stale JSDoc updated.                                                             | Low      | Closed      |
| GAP-010 | No cross-tenant model sharing -- each tenant must independently provision models even for common configurations                                                                                                                                       | Low      | Open        |
| GAP-011 | Cross-pod cache invalidation -- model-cache-invalidation.ts extended with ModelInvalidationTransport pub/sub on `model-hub:invalidation` channel. Redis transport wired in server.ts. PATCH /:id bug fixed (missing invalidation call).               | Medium   | Closed      |
| GAP-012 | Budget enforcement uses in-memory counters per pod — not shared across pods. Acceptable for soft limits; hard enforcement requires Redis-backed counters.                                                                                             | Low      | By Design   |
| GAP-013 | `recordActualUsage()` post-call correction is wired in all 4 LLM call sites. No integration test yet verifying budget drift correction end-to-end.                                                                                                    | Low      | Open        |
| GAP-014 | `tenantCacheKeys` reverse index has no independent max-size/TTL — bounded implicitly by the 500-entry `sharedProviderCache` max.                                                                                                                      | Low      | By Design   |

---

## 17. Testing & Validation

### Required Test Coverage

| #   | Scenario                                           | Coverage Type | Status | Test File / Note                                                                     |
| --- | -------------------------------------------------- | ------------- | ------ | ------------------------------------------------------------------------------------ |
| 1   | Model catalog listing and filtering                | integration   | PASS   | `apps/runtime/src/__tests__/model-catalog.test.ts`                                   |
| 2   | Tenant model CRUD + connection handling            | integration   | PASS   | `apps/runtime/src/__tests__/tenant-model-routes.test.ts`                             |
| 3   | Tenant model authorization                         | integration   | PASS   | `apps/runtime/src/__tests__/auth/tenant-models-authz.test.ts`                        |
| 4   | Tenant model repo isolation                        | integration   | PASS   | `apps/runtime/src/__tests__/tenant-model-repo-isolation.test.ts`                     |
| 5   | Agent model override authorization                 | integration   | PASS   | `apps/runtime/src/__tests__/auth/agent-model-config-authz.test.ts`                   |
| 6   | Model resolution analyzer                          | integration   | PASS   | `apps/runtime/src/__tests__/model-resolution-analyzer.test.ts`                       |
| 7   | Comprehensive model resolution behavior            | integration   | PASS   | `apps/runtime/src/__tests__/model-resolution-comprehensive.test.ts`                  |
| 8   | Platform admin model authorization                 | integration   | PASS   | `apps/runtime/src/__tests__/auth/platform-admin-models-authz.test.ts`                |
| 9   | LLM wiring and provider resolution                 | integration   | PASS   | `apps/runtime/src/__tests__/llm-wiring.test.ts`                                      |
| 10  | Model registry entries, capabilities, hyperparams  | unit          | PASS   | `packages/compiler/src/__tests__/llm/model-registry.test.ts`                         |
| 11  | Budget enforcement (limits, passthrough, Redis)    | unit          | PASS   | `apps/runtime/src/__tests__/llm-budget-enforcement.test.ts`                          |
| 12  | Cache invalidation (pub/sub, HMAC, degradation)    | unit          | PASS   | `apps/runtime/src/__tests__/model-cache-invalidation.test.ts`                        |
| 13  | Model health service (cycle, status, feature flag) | unit          | PASS   | `apps/runtime/src/__tests__/model-health-service.test.ts`                            |
| 14  | Model Hub provisioning E2E                         | e2e           | PASS   | `apps/runtime/src/__tests__/model-hub-provisioning.e2e.test.ts`                      |
| 15  | Model Hub tenant isolation E2E                     | e2e           | PASS   | `apps/runtime/src/__tests__/model-hub-isolation.e2e.test.ts`                         |
| 16  | Model Hub overrides E2E                            | e2e           | PASS   | `apps/runtime/src/__tests__/model-hub-overrides.e2e.test.ts`                         |
| 17  | Model resolution cache versioning contract         | integration   | PASS   | `apps/runtime/src/__tests__/model-resolution-versioning.test.ts`                     |
| 18  | Credential ownership on tenant model routes        | integration   | PASS   | `apps/runtime/src/__tests__/tenant-model-credential-ownership-route.test.ts`         |
| 19  | Auth profile integration with model resolution     | integration   | PASS   | `apps/runtime/src/__tests__/auth/auth-profile/model-resolution-auth-profile.test.ts` |
| 20  | Provider cache scoped eviction                     | unit          | PASS   | `apps/runtime/src/__tests__/provider-cache-eviction.test.ts`                         |
| 21  | Cross-project isolation for model config           | integration   | PASS   | `apps/runtime/src/__tests__/cross-project-isolation.test.ts`                         |
| 22  | Streaming guardrails with model tier               | integration   | PASS   | `apps/runtime/src/__tests__/streaming-guardrails-model-tier.test.ts`                 |
| 23  | Credential chain analysis diagnostics              | integration   | PASS   | `apps/runtime/src/__tests__/credential-chain-analyzer.test.ts`                       |
| 24  | Studio model configuration helpers                 | unit          | PASS   | `apps/studio/src/__tests__/arch-ai/configure-model-helpers.test.ts`                  |
| 25  | Model guardrails browser E2E                       | e2e           | PASS   | `apps/studio/e2e/model-guardrails-e2e.spec.ts`                                       |
| 26  | Full browser/admin provisioning across providers   | e2e           | OPEN   | Not yet automated                                                                    |
| 27  | Provision -> override -> execute live run          | e2e           | OPEN   | Not yet automated                                                                    |

### Testing Notes

Integration and unit test coverage is strong across runtime route tests, model resolution, compiler registry, and authorization checks. E2E tests cover provisioning, tenant isolation, override workflows via HTTP API with real servers, and browser-level model guardrails (Playwright). Budget enforcement, cache invalidation, health check services, provider cache eviction, and model resolution versioning all have dedicated test suites. Cross-project isolation and credential chain analysis have been added since the initial spec. The main remaining gaps are full browser-level E2E coverage for admin/studio provisioning flows across all provider variants and live provision-to-execution confirmation.

> Full testing details: [../testing/model-hub.md](../testing/model-hub.md)

---

## 18. References

- Design docs: `docs/specs/model-hub.hld.md`
- Plans: `docs/plans/2026-03-22-model-hub-impl-plan.md`
- Related feature docs: [Voice Capabilities](./voice-capabilities.md), [Agent Testing & Evals](./agent-testing-evals.md), [Tracing & Observability](./tracing-observability.md)
- Existing UI simplification design: `docs/plans/2026-03-09-models-ui-simplification-design.md`

# HLD: Model Hub

**Feature**: Model Hub -- LLM Management System
**Status**: BETA
**Date**: 2026-03-22
**Feature Spec**: [docs/features/model-hub.md](../features/model-hub.md)
**Test Spec**: [docs/testing/model-hub.md](../testing/model-hub.md)

---

## 1. Problem Statement

Every execution path in the platform (reasoning, guardrails, evals, SearchAI, voice) needs to resolve an LLM model, decrypt a credential, and determine capability parameters before making an API call. Without a centralized model control plane, each execution path would independently manage provider integrations, credential storage, model selection, and capability discovery -- leading to duplication, credential sprawl, inconsistent behavior, and no diagnostic visibility.

Model Hub exists today as the platform's LLM management layer. It manages a catalog of 147+ models across 6 providers, tenant-level model provisioning with encrypted credentials, scoped override cascading (tenant -> project -> agent), and a deterministic 5-level resolution chain executed before every LLM call. The remaining gaps are in governance enforcement (policy budgets, provider allowlists), operational automation (health checks, deprecation), and cross-pod cache coherence.

This HLD documents the existing architecture, addresses 12 architectural concerns, and designs solutions for the identified gaps.

---

## 2. Alternatives Considered

### Alternative A: Centralized Resolution Service (Current)

**Description**: A single `ModelResolutionService` in the runtime with a deterministic 5-level chain that resolves model, credential, and parameters before each LLM call. All configuration stored in MongoDB with tenant isolation plugins.

**Pros**:

- Single resolution path for all execution features -- consistent behavior
- Deterministic chain is debuggable via `ModelResolutionAnalyzer`
- Tenant isolation via Mongoose plugins is battle-tested
- Provider factory shared across runtime and SearchAI workers

**Cons**:

- Resolution cache is process-local -- stale in multi-pod deployments
- Governance enforcement is partial (budget tracking exists but not blocking)
- No active cache invalidation -- relies on TTL expiry

**Effort**: Existing -- zero additional effort for core resolution.

### Alternative B: Distributed Resolution with Redis-Backed Config

**Description**: Move model/credential configuration from MongoDB to Redis for sub-millisecond reads, with MongoDB as durable storage and Redis as the hot config layer.

**Pros**:

- Sub-millisecond resolution reads vs ~5-20ms MongoDB queries
- Redis pub/sub enables cross-pod cache invalidation
- Natural fit for rate-limiting enforcement (Redis counters)

**Cons**:

- Adds Redis as a critical dependency for model resolution (currently optional)
- Dual-write complexity between MongoDB and Redis
- Encryption plugin is Mongoose-specific -- would need Redis-side decryption
- Migration effort for existing tenants

**Effort**: Large (L) -- 4-6 weeks for dual-write, cache sync, and encryption adaptation.

### Alternative C: External LLM Gateway (LiteLLM Proxy)

**Description**: Delegate all model resolution, credential management, and provider routing to a LiteLLM proxy. Runtime sends all LLM calls through the proxy.

**Pros**:

- Offloads credential management and provider routing entirely
- LiteLLM handles retries, fallbacks, and load balancing
- Gateway-level observability (request logging, token counting)

**Cons**:

- Adds a network hop to every LLM call (~5-15ms latency increase)
- Loses fine-grained 5-level resolution (gateway has simpler routing)
- SSRF risk increases (gateway is a powerful outbound proxy)
- Operational complexity of managing the gateway service
- Loses Vercel AI SDK's streaming and structured output benefits

**Effort**: Large (L) -- 3-5 weeks for gateway deployment, migration, and testing.

### Recommendation

**Continue with Alternative A (Centralized Resolution Service)** with targeted improvements:

1. Add Redis pub/sub for cross-pod provider cache invalidation (from Alt B, without the full Redis config layer)
2. Add real-time policy enforcement middleware (blocking, not just tracking)
3. Add automated health check scheduling for connections

This preserves the proven architecture while addressing the specific gaps. The resolution service is already battle-tested with strong isolation, and the Vercel AI SDK integration provides the best streaming and structured output support.

---

## 3. Architecture

### System Context Diagram

```
                    ┌─────────────────────────────────────────────────┐
                    │                   Clients                        │
                    │  Studio UI / Admin Portal / SDK / Channels       │
                    └───────────┬─────────────────────────┬───────────┘
                                │                         │
                    ┌───────────▼───────────┐ ┌───────────▼───────────┐
                    │     Studio App        │ │    Admin App           │
                    │  ModelConfigTab       │ │  Model Management      │
                    │  AgentModelTab        │ │  Connection Mgmt       │
                    │  ModelResolution      │ │  Provisioning          │
                    │  Inspector            │ │                        │
                    └───────────┬───────────┘ └───────────┬───────────┘
                                │                         │
                    ┌───────────▼─────────────────────────▼───────────┐
                    │              Runtime (Express)                    │
                    │                                                   │
                    │  ┌──────────────┐  ┌──────────────────────────┐  │
                    │  │ Route Layer  │  │  Service Layer            │  │
                    │  │ model-catalog│  │  ModelCatalogService      │  │
                    │  │ tenant-models│  │  ModelResolutionService   │  │
                    │  │ agent-model  │  │  SessionLLMClient         │  │
                    │  │ project-llm  │  │  DiagnosticEngine         │  │
                    │  │ platform-adm │  │  CredentialAgeMonitor     │  │
                    │  └──────┬───────┘  └──────────┬───────────────┘  │
                    │         │                      │                  │
                    │  ┌──────▼──────────────────────▼───────────────┐  │
                    │  │         Repository Layer                     │  │
                    │  │  tenant-model-repo / llm-resolution-repo    │  │
                    │  └──────────────────┬──────────────────────────┘  │
                    └─────────────────────┼────────────────────────────┘
                                          │
            ┌─────────────────────────────┼─────────────────────────────┐
            │                             │                             │
   ┌────────▼────────┐         ┌─────────▼─────────┐        ┌─────────▼─────────┐
   │    MongoDB       │         │  Compiler Package  │        │   LLM Package      │
   │                  │         │                    │        │                    │
   │  tenant_models   │         │  MODEL_REGISTRY    │        │ createVercelProvider│
   │  model_configs   │         │  ModelCapabilities │        │ worker-llm-client  │
   │  llm_credentials │         │  model-registry    │        │                    │
   │  project_llm_cfg │         │  hyper-param-tmpl  │        └────────┬───────────┘
   │  agent_model_cfg │         │                    │                 │
   │  tenant_llm_pol  │         └────────────────────┘        ┌────────▼───────────┐
   │  llm_usage_metric│                                       │ Vercel AI SDK      │
   └──────────────────┘                                       │ @ai-sdk/anthropic  │
                                                              │ @ai-sdk/openai     │
                                                              │ @ai-sdk/google     │
                                                              │ @ai-sdk/azure      │
                                                              │ @ai-sdk/cohere     │
                                                              └────────────────────┘
```

### Component Diagram

```
┌─────────────────────────────────────────────────────────────────────┐
│                      Model Hub Components                            │
│                                                                      │
│  ┌─────────────────┐   ┌────────────────────┐   ┌───────────────┐  │
│  │ Model Catalog    │   │ Model Resolution   │   │ Provider      │  │
│  │ Service          │   │ Service            │   │ Factory       │  │
│  │                  │   │                    │   │               │  │
│  │ - Built-in       │   │ - 5-level chain    │   │ - 15 provider │  │
│  │   registry       │   │ - Credential       │   │   mappings    │  │
│  │ - LiteLLM data   │   │   decryption       │   │ - Vercel SDK  │  │
│  │ - Gateway        │   │ - Parameter merge  │   │   factories   │  │
│  │   discovery      │   │ - Policy check     │   │ - Cache (LRU) │  │
│  │ - SSRF protect   │   │ - Cooldown         │   │               │  │
│  └─────────────────┘   └────────────────────┘   └───────────────┘  │
│                                                                      │
│  ┌─────────────────┐   ┌────────────────────┐   ┌───────────────┐  │
│  │ Tenant Model    │   │ Diagnostic         │   │ Session LLM   │  │
│  │ Repository      │   │ Analyzer           │   │ Client         │  │
│  │                  │   │                    │   │               │  │
│  │ - CRUD + conns  │   │ - Chain walk       │   │ - Per-session │  │
│  │ - Impact        │   │ - Findings gen     │   │ - AbortSignal │  │
│  │   analysis      │   │ - Evidence         │   │ - Timeout     │  │
│  │ - Isolation     │   │   collection       │   │ - Streaming   │  │
│  └─────────────────┘   └────────────────────┘   └───────────────┘  │
│                                                                      │
│  ┌─────────────────┐   ┌────────────────────┐                       │
│  │ Credential      │   │ Usage Metrics      │                       │
│  │ Management      │   │ Recorder           │                       │
│  │                  │   │                    │                       │
│  │ - AES-256-GCM  │   │ - Per-call record  │                       │
│  │ - User/tenant   │   │ - Token counting   │                       │
│  │   scopes        │   │ - Cost estimation  │                       │
│  │ - Audit trail   │   │ - Latency tracking │                       │
│  └─────────────────┘   └────────────────────┘                       │
└─────────────────────────────────────────────────────────────────────┘
```

### Data Flow -- Model Resolution

```
Request arrives (agent execution, guardrail, eval, SearchAI)
    │
    ▼
ModelResolutionService.resolve(context)
    │
    ├─ Level 0: Check deploymentModelOverride → if present, use it
    │
    ├─ Level 1: Check agentIR.model / agentIR.operation_models
    │           → match by operation type
    │
    ├─ Level 2: Check AgentModelConfig in DB
    │           → findAgentModelConfig({ projectId, agentName })
    │           → if defaultModel or operationModels[op] found, use it
    │
    ├─ Level 3: Check ModelConfig (project DB)
    │           → findModelConfigForTier({ projectId, tier })
    │           → tier determined by ProjectLLMConfig.operationTierOverrides
    │
    ├─ Level 4: Check TenantModel
    │           → findDefaultTenantModelForTier({ tenantId, tier })
    │           → fallback: findAnyDefaultTenantModel({ tenantId })
    │
    └─ Level 5: FAIL → throw AppError(NO_MODEL_RESOLVED)

At matched level:
    │
    ├─ Resolve credential:
    │   1. User credential (credentialScope: 'user', ownerId: userId)
    │   2. Tenant credential (credentialScope: 'tenant', ownerId: tenantId)
    │   3. Connection credential (tenant_models.connections[].credentialId)
    │   4. Platform demo (__platform__ tenant, if enabled)
    │
    ├─ Decrypt credential via EncryptionService
    │
    ├─ Merge parameters (temperature, maxTokens, hyperParameters)
    │
    ├─ Check tenant LLM policy (allowed providers, budget)
    │
    └─ Return ResolvedModel { modelId, provider, source, credential, parameters }
            │
            ▼
    SessionLLMClient → createVercelProvider() → generateText/streamText
```

### Sequence Diagram -- Tenant Model Provisioning

```
Tenant Admin          Studio/Admin UI         Runtime API            MongoDB
    │                      │                      │                     │
    │──── Provision ──────►│                      │                     │
    │                      │──── POST /tenants/   │                     │
    │                      │     :id/models ──────►│                     │
    │                      │                      │── Validate input     │
    │                      │                      │── Check OWNER/ADMIN  │
    │                      │                      │── Create TenantModel─►│
    │                      │                      │                     │──► Save
    │                      │                      │◄─ Created ──────────│
    │                      │◄─── 201 Created ─────│                     │
    │                      │                      │                     │
    │──── Add Connection ─►│                      │                     │
    │                      │──── POST /tenants/   │                     │
    │                      │     :id/models/:id/  │                     │
    │                      │     connections ─────►│                     │
    │                      │                      │── Validate cred ref │
    │                      │                      │── Encrypt credential─►│
    │                      │                      │── Add connection ───►│
    │                      │                      │                     │──► Save
    │                      │                      │◄─ Updated ──────────│
    │                      │◄─── 200 OK ──────────│                     │
    │◄──── Connection ─────│                      │                     │
    │      Added           │                      │                     │
```

---

## 4. The 12 Architectural Concerns

### Structural Concerns

#### 1. Tenant Isolation

**Implementation**: All tenant-scoped collections (`tenant_models`, `llm_credentials`, `tenant_llm_policies`, `llm_usage_metrics`) use the `tenantIsolationPlugin` which automatically appends `tenantId` to every Mongoose query. This is verified in `tenant-model-repo-isolation.test.ts`.

**Evidence**: `packages/database/src/mongo/plugins/tenant-isolation.plugin.ts` applies `find`, `findOne`, `updateOne`, `deleteOne` hooks that inject `tenantId` from the query context.

**Cross-tenant access returns 404** (not 403) as required by platform principles. Verified in `tenant-models-authz.test.ts`.

**Project-scoped isolation**: `model_configs` and `agent_model_configs` use `projectId` filtering (no `tenantIsolationPlugin` -- isolation is via the project -> tenant join). `project_llm_configs` uses both `tenantId` and `projectId`.

#### 2. Data Access Pattern

**Pattern**: Repository layer (`tenant-model-repo.ts`, `llm-resolution-repo.ts`) wraps Mongoose models. Routes do not access models directly.

**Caching**:

- **Provider cache**: Process-level LRU (max 500, TTL 30min) keyed by `providerType:sha256(apiKey):baseUrl`. Source: `session-llm-client.ts`.
- **Resolution cache**: 5-minute TTL for resolved model results per session. Source: `model-resolution.ts`.
- **Catalog cache**: Built-in catalog loaded once at startup; LiteLLM refresh has 24-hour TTL. Source: `model-catalog.ts`.

**Gap**: All caches are process-local. In multi-pod deployments, credential rotation may not be reflected until TTL expiry (GAP-011).

#### 3. API Contract

**Request/response shapes**: All routes use Zod validation schemas for input and the standard error envelope `{ success, data?, error?: { code, message } }` for failures.

**Error codes**: Defined in `@agent-platform/shared-kernel` -- `ErrorCodes.NO_MODEL_RESOLVED`, `ErrorCodes.NO_CREDENTIAL`, `ErrorCodes.ENCRYPTION_ERROR`.

**Versioning**: Collections use `_v: number` field for schema versioning. No API version path prefix currently.

**OpenAPI**: Model catalog routes use `createOpenAPIRouter` for generated API documentation.

#### 4. Security Surface

- **Auth**: All routes use `authMiddleware` (centralized via `createUnifiedAuthMiddleware`). Tenant model routes require OWNER/ADMIN role. Project routes require `model_config:read/write` permission.
- **Input validation**: Zod schemas on all route inputs. Model IDs validated against the catalog. Connection credential IDs validated against existing credentials.
- **SSRF prevention**: `isAllowedGatewayUrl()` blocks localhost, loopback, private IP ranges (10.x, 172.16-31.x, 192.168.x), and cloud metadata endpoints before gateway discovery HTTP calls.
- **Encryption**: API keys encrypted at rest via AES-256-GCM with tenant-scoped key derivation (`encryptionPlugin`).
- **Blocked headers**: Custom headers on connections reject `Host`, `Authorization`, `Cookie`, `Transfer-Encoding`, `Proxy-*`, `X-Forwarded-*`.
- **Rate limiting**: All routes use `tenantRateLimit('request')`.

### Behavioral Concerns

#### 5. Error Model

| Failure                         | User Experience                             | Recovery                                           |
| ------------------------------- | ------------------------------------------- | -------------------------------------------------- |
| No model resolved (Level 5)     | Agent execution fails with clear error      | Admin provisions a model or configures an override |
| No credential found             | Agent execution fails with credential error | Admin adds a connection with valid credential      |
| Credential decryption fails     | Agent execution fails with encryption error | Check `ENCRYPTION_MASTER_KEY` configuration        |
| LLM call timeout (2min)         | Partial response or retry                   | Automatic AbortSignal-based timeout; can retry     |
| Gateway discovery SSRF block    | Discovery returns error for blocked URL     | Use valid external URL or configure allowlist      |
| Provider API error (rate limit) | Execution fails with provider error         | Resolution cooldown prevents thundering herd       |

#### 6. Failure Modes

- **MongoDB unavailable**: All resolution and CRUD operations fail. No in-memory fallback for configuration data.
- **Encryption service unavailable**: Credential decryption fails. Resolution returns `NO_CREDENTIAL` error. Sessions cannot make LLM calls.
- **LLM provider timeout**: 2-minute AbortSignal timeout. SessionLLMClient returns timeout error. 30-second cooldown prevents immediate retries.
- **Partial configuration**: Missing agent config -> falls through to project -> tenant. Missing tenant model -> resolution fails at Level 5.
- **Stale cache**: After credential rotation, process-local cache may serve stale entries until TTL expiry (30min for providers, 5min for resolution).

#### 7. Idempotency

- **Tenant model creation**: Unique index `{ tenantId, displayName }` prevents duplicate models. Retry-safe.
- **Connection operations**: Embedded subdocument with UUID `id` field. Add is not idempotent (duplicate connections possible if retried), but update/delete by `connId` is safe.
- **Agent model config upsert**: Uses `findOneAndUpdate` with `upsert: true` on `{ projectId, agentName }` -- idempotent.
- **Project LLM config upsert**: Uses `findOneAndUpdate` with `upsert: true` on `{ tenantId, projectId }` -- idempotent.
- **Usage metric recording**: Append-only, no dedup -- acceptable for metrics (duplicate records slightly inflate counts).

#### 8. Observability

- **Structured logging**: All services use `createLogger('module-name')` from `@abl/compiler/platform`. Log entries include tenantId, projectId, modelId, provider, requestId.
- **Diagnostic analyzer**: `ModelResolutionAnalyzer` walks the 5-level chain and produces `DiagnosticFinding[]` with severity, code, title, detail, suggestion, and evidence arrays.
- **Usage metrics**: `llm_usage_metrics` collection records per-call provider, model, operation, tokens (input/output/total), latency, cost, status, and errors.
- **Route logging**: Request/response logging on all model hub routes with error details.
- **Credential age monitoring**: `credential-age-monitor.ts` tracks credential age for rotation warnings.

### Operational Concerns

#### 9. Performance Budget

| Operation                    | Target      | Current      | Notes                      |
| ---------------------------- | ----------- | ------------ | -------------------------- |
| Model resolution (cached)    | <5ms        | ~2ms         | Process-local cache hit    |
| Model resolution (DB)        | <50ms       | ~15-30ms     | MongoDB query + decryption |
| Catalog listing (147 models) | <100ms      | ~20ms        | In-memory registry         |
| Provider creation (cached)   | <1ms        | <1ms         | LRU cache hit              |
| Provider creation (new)      | <50ms       | ~10-30ms     | SDK factory instantiation  |
| LLM call timeout             | 120s max    | configurable | AbortSignal-based          |
| Gateway discovery            | 10s timeout | N/A          | Per-request HTTP call      |

#### 10. Migration Path

**Current state**: Fully operational with 147 models, 6 providers, 15 provider type mappings, 7 data collections, and 18 test files.

**Target state**: Add real-time policy enforcement, automated health checks, cross-pod cache invalidation.

**Migration strategy**:

1. Policy enforcement is additive -- new middleware that reads existing `tenant_llm_policies` data. No schema changes.
2. Health check automation adds a new background worker. No changes to existing connection schema (uses existing `healthStatus`/`lastHealthCheck` fields).
3. Cross-pod cache invalidation adds Redis pub/sub messages on credential/model changes. Requires Redis connectivity (already used for rate limiting).

#### 11. Rollback Plan

- **Policy enforcement**: Feature-flagged middleware. Disable flag to revert to current behavior (tracking without blocking).
- **Health check automation**: Stop the background worker. Manual health checks continue to work.
- **Cache invalidation**: If Redis pub/sub fails, fall back to TTL-based expiry (current behavior). No data loss.

All changes are additive -- no destructive schema changes or data migrations required.

#### 12. Test Strategy

**Unit tests** (20% of effort):

- Model registry entry validation (147 entries, capabilities, hyperparameters)
- Provider inference from model ID
- SSRF URL validation
- Timeout configuration

**Integration tests** (60% of effort):

- 5-level resolution chain cascade with real MongoDB
- Tenant isolation via `tenantIsolationPlugin`
- Credential encryption round-trip
- Provider factory multi-provider mapping
- Diagnostic analyzer chain walk
- Route authorization (OWNER/ADMIN, model_config:read/write)

**E2E tests** (20% of effort):

- Full provisioning-to-execution journey
- Cross-tenant isolation
- Gateway discovery with SSRF protection
- Credential lifecycle and cache invalidation
- Operation-tier override layering

**Coverage target**: All 10 FRs mapped to at least one integration test. FR-7 (policy enforcement) currently untested -- highest priority gap.

---

## 5. Data Model

The data model is fully documented in the feature spec (Section 9). Key collections:

| Collection            | Purpose                                 | Isolation                                                         |
| --------------------- | --------------------------------------- | ----------------------------------------------------------------- |
| `tenant_models`       | Tenant-provisioned models + connections | `tenantIsolationPlugin`                                           |
| `model_configs`       | Project-level model configs             | `projectId` filter                                                |
| `project_llm_configs` | Operation-tier mapping per project      | `tenantIsolationPlugin` + `projectId`                             |
| `agent_model_configs` | Per-agent overrides                     | `projectId` + `agentName`                                         |
| `llm_credentials`     | Encrypted API keys                      | `tenantIsolationPlugin` + `encryptionPlugin` + `auditTrailPlugin` |
| `tenant_llm_policies` | Tenant governance rules                 | `tenantIsolationPlugin`                                           |
| `llm_usage_metrics`   | Per-call metrics                        | `tenantIsolationPlugin`                                           |

No new collections are needed. All changes for gap closure use existing schemas.

---

## 6. API Design

The API is fully documented in the feature spec (Section 8). Key route groups:

| Route Group                                               | Auth                      | Purpose                                  |
| --------------------------------------------------------- | ------------------------- | ---------------------------------------- |
| `GET /api/model-catalog/*`                                | Any authenticated         | Browse and query model catalog           |
| `POST /api/model-catalog/refresh`                         | `credential:write`        | Refresh catalog from LiteLLM             |
| `POST /api/model-catalog/gateway-discovery`               | `credential:write`        | Discover gateway models (SSRF-protected) |
| `/api/tenants/:tenantId/models/*`                         | OWNER/ADMIN               | Tenant model CRUD + connections          |
| `/api/projects/:projectId/llm-config`                     | `model_config:read/write` | Project operation-tier overrides         |
| `/api/projects/:projectId/agents/:agentName/model-config` | `model_config:read/write` | Agent model overrides                    |
| `/api/platform-admin/tenant-models`                       | Platform admin            | Cross-tenant model management            |

**New endpoints for gap closure**:

| Method | Path                                             | Purpose                                     | Auth        |
| ------ | ------------------------------------------------ | ------------------------------------------- | ----------- |
| POST   | `/api/tenants/:tenantId/models/:id/health-check` | Trigger health check for a model connection | OWNER/ADMIN |
| GET    | `/api/tenants/:tenantId/llm-policy`              | Get tenant LLM policy                       | OWNER/ADMIN |
| PUT    | `/api/tenants/:tenantId/llm-policy`              | Update tenant LLM policy                    | OWNER/ADMIN |
| GET    | `/api/tenants/:tenantId/llm-usage/summary`       | Get usage summary with budget status        | OWNER/ADMIN |

**Error responses**: All use standard envelope `{ success: false, error: { code: string, message: string } }`.

---

## 7. Cross-Cutting Concerns

### Audit Logging

- **LLM credentials**: `auditTrailPlugin` records all create/update/delete operations with before/after snapshots.
- **Tenant model changes**: Route-level logging captures all CRUD operations with tenant context.
- **Policy changes**: New policy routes will use `auditTrailPlugin`.
- **Usage metrics**: `llm_usage_metrics` provides a complete audit trail of all LLM API calls.

### Rate Limiting

- All model hub routes use `tenantRateLimit('request')` -- per-tenant rate limiting with configurable limits.
- LLM call rate limiting is governed by `tenant_llm_policies.maxRequestsPerMinute` (currently tracked but not enforced -- GAP-005).

### Caching

| Cache              | Strategy       | TTL      | Max Size      | Invalidation                                |
| ------------------ | -------------- | -------- | ------------- | ------------------------------------------- |
| Provider instances | LRU            | 30 min   | 500           | `clearProviderCache()` on credential change |
| Resolution results | Session-scoped | 5 min    | Per-session   | Session end or explicit clear               |
| Built-in catalog   | Static         | Infinite | 147 entries   | Platform release                            |
| LiteLLM data       | Lazy refresh   | 24 hours | ~4000 entries | Admin-triggered refresh                     |

### Encryption

- **At rest**: `encryptedApiKey` and `encryptedEndpoint` via AES-256-GCM using `encryptionPlugin` with tenant-scoped key derivation from `ENCRYPTION_MASTER_KEY`.
- **In transit**: TLS for all external provider API calls. SSRF protection on gateway discovery URLs.
- **Key management**: Single master key (`ENCRYPTION_MASTER_KEY`). Rotation requires re-encryption of all credentials.

---

## 8. Dependencies

### Upstream (Model Hub depends on)

| Dependency                      | Risk     | Impact if Unavailable                              |
| ------------------------------- | -------- | -------------------------------------------------- |
| MongoDB                         | Critical | All resolution and config operations fail          |
| `ENCRYPTION_MASTER_KEY` env var | Critical | Credential decryption fails, no LLM calls possible |
| Vercel AI SDK packages          | Medium   | Provider creation fails for affected providers     |
| `@abl/compiler` model registry  | Low      | Catalog and capabilities unavailable (static data) |
| Redis (for rate limiting)       | Low      | Rate limiting bypassed; resolution still works     |

### Downstream (depends on Model Hub)

| Consumer                    | Impact if Model Hub Fails                         |
| --------------------------- | ------------------------------------------------- |
| Runtime agent execution     | All LLM-backed operations fail                    |
| Guardrail LLM providers     | LLM-based guardrails cannot execute               |
| Eval engine (persona/judge) | Evaluation flows cannot resolve models            |
| SearchAI workers            | Embedding and generation pipelines fail           |
| Voice services              | Realtime voice model resolution fails             |
| Diagnostics engine          | `ModelResolutionAnalyzer` cannot produce findings |

---

## 9. Open Questions & Decisions Needed

1. ~~**Cross-pod cache invalidation**~~: **DECIDED** — Redis pub/sub on `model-hub:invalidation` channel, with graceful degradation to TTL-based consistency when Redis is unavailable. Implemented in `model-cache-invalidation.ts` with `ModelInvalidationTransport` interface. Redis is a soft dependency (fail-open).
2. **Policy enforcement strictness**: **DECIDED (partial)** — Budget overages currently hard-block with `TOO_MANY_REQUESTS` error. No soft-warn/developer mode yet. Open: should enterprise tenants have a separate soft-warn mode?
3. ~~**Health check automation cadence**~~: **DECIDED** — Configurable via `healthCheckIntervalHours` (default: 4 hours). Implemented in `model-health-service.ts` with `setInterval`. Uses `maxOutputTokens: 16` to minimize cost.
4. **Usage metric retention**: Still open — no TTL or archival policy for MongoDB `llm_usage_metrics` collection.
5. ~~**Auth profile wiring priority**~~: **DECIDED** — Tenant model connections are fully wired (`connection.authProfileId` in `ModelResolutionService`). Tenant service instances are wired (`VoiceServiceFactory.resolveAndDecrypt()`). `ModelConfig.authProfileId` is reserved for future project-level credential overrides (not needed — resolution goes through `tenantModelId → TenantModel → connection.authProfileId`).

---

## 10. Post-Implementation Notes (2026-03-27)

### Deviations from Plan

- Budget enforcement uses **in-memory** daily/monthly counters (not Redis) — acceptable for soft limits, consistent with rate-limiter pattern. Hard enforcement would need Redis-backed counters.
- `recordActualUsage()` post-call correction is wired into all 4 LLM call paths (generateText, streamText, SSE non-streaming, SSE streaming) — this was originally a deferred TODO.
- Cache invalidation messages use HMAC-SHA256 signing derived from `ENCRYPTION_MASTER_KEY` — this was added during audit review, not in the original HLD.
- Provider cache eviction is tenant-scoped via reverse index (`tenantCacheKeys` Map) — prevents full-cache flushes when only one tenant's credentials change.
- `catch (error: any)` patterns in tenant-models.ts were replaced with `catch (err: unknown)` + structured `{ code, message }` error format during audit remediation.

### Key Files Added

| File                                                            | Purpose                             |
| --------------------------------------------------------------- | ----------------------------------- |
| `apps/runtime/src/services/llm/budget-enforcement.ts`           | In-memory token budget enforcement  |
| `apps/runtime/src/services/llm/model-cache-invalidation.ts`     | Cross-pod Redis pub/sub with HMAC   |
| `apps/runtime/src/services/llm/model-health-service.ts`         | Automated health check periodic job |
| `apps/runtime/src/__tests__/llm-budget-enforcement.test.ts`     | 17 budget enforcement tests         |
| `apps/runtime/src/__tests__/model-cache-invalidation.test.ts`   | 13 cache invalidation tests         |
| `apps/runtime/src/__tests__/model-health-service.test.ts`       | 6 health check tests                |
| `apps/runtime/src/__tests__/model-hub-provisioning.e2e.test.ts` | Provisioning E2E                    |
| `apps/runtime/src/__tests__/model-hub-isolation.e2e.test.ts`    | Tenant isolation E2E                |
| `apps/runtime/src/__tests__/model-hub-overrides.e2e.test.ts`    | Override layering E2E               |

---

## 11. References

- Feature spec: `docs/features/model-hub.md`
- Test spec: `docs/testing/model-hub.md`
- Models UI simplification design: `docs/plans/2026-03-09-models-ui-simplification-design.md`
- Platform principles: `CLAUDE.md` Core Invariants
- Compiler model registry: `packages/compiler/src/platform/llm/model-registry.ts`
- Provider factory: `packages/llm/src/provider-factory.ts`
- Model resolution service: `apps/runtime/src/services/llm/model-resolution.ts`

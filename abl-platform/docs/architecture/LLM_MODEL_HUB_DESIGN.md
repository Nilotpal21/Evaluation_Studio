# LLM Model Hub — Implementation Design

**Feature:** ABLP-21 | **Branch:** `feature/llm-model-hub`
**Author:** ABL Platform Team | **Date:** February 2026

---

## Table of Contents

1. [Executive Summary](#1-executive-summary)
2. [Problem Statement](#2-problem-statement)
3. [Architecture Overview](#3-architecture-overview)
4. [Design Decisions](#4-design-decisions)
5. [Comparison: Before vs After](#5-comparison-before-vs-after)
6. [Feature Deep Dive](#6-feature-deep-dive)
   - 6.1 [Model Registry (Single Source of Truth)](#61-model-registry--single-source-of-truth)
   - 6.2 [6-Level Model Resolution Chain](#62-6-level-model-resolution-chain)
   - 6.3 [Vercel AI SDK Integration](#63-vercel-ai-sdk-integration)
   - 6.4 [Unified Credential Management](#64-unified-credential-management)
   - 6.5 [Tenant Model Catalog with Connections](#65-tenant-model-catalog-with-connections)
   - 6.6 [Per-Agent Model Overrides](#66-per-agent-model-overrides)
   - 6.7 [LLM Governance Policy](#67-llm-governance-policy)
   - 6.8 [Reasoning Model Support](#68-reasoning-model-support)
   - 6.9 [Hyper-Parameter Templates](#69-hyper-parameter-templates)
   - 6.10 [Provider Icons & UI Enhancements](#610-provider-icons--ui-enhancements)
   - 6.11 [Real-time Voice Model Support](#611-real-time-voice-model-support)
   - 6.12 [Cost Estimation](#612-cost-estimation)
   - 6.13 [Streaming Mode Control](#613-streaming-mode-control)
7. [Data Model](#7-data-model)
8. [API Surface](#8-api-surface)
9. [Security & Compliance](#9-security--compliance)
10. [Test Coverage](#10-test-coverage)
11. [Benefits Summary](#11-benefits-summary)
12. [Migration & Rollout](#12-migration--rollout)
13. [Appendix: File Inventory](#13-appendix-file-inventory)

---

## 1. Executive Summary

The LLM Model Hub replaces the platform's fragmented, hardcoded LLM integration with a **unified, multi-provider model management system**. It introduces:

- A **178-model registry** spanning **15 providers** as the single source of truth
- A **6-level model resolution chain** that resolves from deployment overrides down to tenant defaults
- **Vercel AI SDK** as the universal provider communication layer, replacing 7 custom provider implementations
- **Tenant-scoped model catalogs** with encrypted credential connections and health checks
- **Per-agent model overrides** with operation-level granularity
- **LLM governance policies** for credential policies and provider enforcement
- **Project-level operation-tier mapping** for routing operations (extraction, reasoning, etc.) to model tiers
- **Reasoning model support** (OpenAI o-series, Claude thinking, Gemini adaptive)
- **Streaming mode control** — per-model/per-agent toggle between `streamText()` and `generateText()`
- **Real-time voice model** resolution (Ultravox, OpenAI Realtime, Gemini Live)

**Scale of change:** +22,598 lines across 54 LLM-specific files, with 230+ dedicated tests.

**Change volume by layer:**

| Layer                                        | Files | Insertions | Deletions | Net     |
| -------------------------------------------- | ----- | ---------- | --------- | ------- |
| Compiler LLM (registry, types, providers)    | 17    | +12,196    | -262      | +11,934 |
| Runtime Services (resolution, routes, repos) | 28    | +1,750     | -1,698    | +52     |
| Studio UI (admin pages, stores, lib)         | 32    | +5,249     | -1,462    | +3,787  |
| Studio API Routes (proxy, new endpoints)     | 15    | +827       | -144      | +683    |
| Database (schemas, migrations, plugins)      | 14    | +374       | -67       | +307    |
| Tests (new suites, refactored existing)      | 38    | +3,570     | -1,133    | +2,437  |

---

## 2. Problem Statement

### What We Had Before

| Area                   | Previous State                                            | Risk/Impact                                                          |
| ---------------------- | --------------------------------------------------------- | -------------------------------------------------------------------- |
| **Model catalog**      | 8 hardcoded models in a flat array                        | Adding a model = code change + deploy                                |
| **Providers**          | 7 custom provider classes (anthropic.ts, openai.ts, etc.) | Each provider required ~200-500 lines of bespoke HTTP/streaming code |
| **Provider count**     | 3 providers (OpenAI, Anthropic, Gemini)                   | No Azure, Bedrock, Groq, Mistral, Cohere, etc.                       |
| **Credential storage** | Single API key in env vars or plaintext DB field          | No multi-credential, no per-model wiring, no rotation support        |
| **Model selection**    | Global config or hardcoded per-tenant                     | No project-level, no agent-level, no operation-level granularity     |
| **Resolution logic**   | Simple `if/else` with env-var fallback                    | Silent fallback masked missing configuration                         |
| **Reasoning models**   | Not supported                                             | o1, o3, Claude thinking, Gemini flash-thinking — all unsupported     |
| **Validation**         | Per-provider API-list endpoints (custom per provider)     | Each new provider needed a new validation implementation             |
| **Governance**         | None                                                      | No provider restrictions, no credential policies, no audit trail     |
| **Voice models**       | Not supported                                             | No real-time voice capability resolution                             |

### Core Pain Points

1. **Vendor lock-in risk** — Adding a new provider required writing a full provider class, streaming adapter, and tool-call handler
2. **No tenant control** — Admins couldn't restrict which providers or models their organization uses
3. **Credential sprawl** — API keys lived in env vars, not encrypted DB fields with rotation support
4. **No granularity** — Every agent in every project used the same model — no per-operation optimization
5. **Silent failures** — Env-var fallback meant misconfiguration was invisible until billing surprises

---

## 3. Architecture Overview

```
┌─────────────────────────────────────────────────────────────────────┐
│                        Studio (Next.js)                             │
│  ┌──────────────┐  ┌─────────────────┐  ┌────────────────────────┐ │
│  │  ModelsPage   │  │ AgentModelTab   │  │  LLMPolicySection      │ │
│  │  + AddModel   │  │ (per-agent      │  │  (governance)          │ │
│  │  + AddConn    │  │  overrides)     │  │                        │ │
│  └──────┬───────┘  └───────┬─────────┘  └───────────┬────────────┘ │
│         │                  │                        │              │
│  ┌──────▼──────────────────▼────────────────────────▼──────────┐   │
│  │          Studio API Routes (Proxy + Zod Validation)         │   │
│  └──────────────────────────┬──────────────────────────────────┘   │
└─────────────────────────────┼──────────────────────────────────────┘
                              │ HTTP (X-Tenant-Id header)
┌─────────────────────────────▼──────────────────────────────────────┐
│                       Runtime (Express)                             │
│  ┌───────────────────────────────────────────────────────────────┐ │
│  │                 Model Resolution Service                       │ │
│  │  Level 0: Deployment Override                                 │ │
│  │  Level 1: Agent IR (DSL-defined model)                        │ │
│  │  Level 2: Agent DB (AgentModelConfig)                         │ │
│  │  Level 3: Project DB (ModelConfig → TenantModel)              │ │
│  │  Level 4: Tenant Model (tier-specific → any default)          │ │
│  │  Level 5: Platform Demo (optional)                            │ │
│  │  Level 6: FAIL (explicit error — no silent fallback)          │ │
│  └───────────────────────────┬───────────────────────────────────┘ │
│                              │                                     │
│  ┌───────────────────────────▼───────────────────────────────────┐ │
│  │              SessionLLMClient (Vercel AI SDK)                  │ │
│  │  ┌─────────┐ ┌──────────┐ ┌────────┐ ┌──────┐ ┌───────────┐ │ │
│  │  │ OpenAI  │ │Anthropic │ │ Azure  │ │Google│ │  7 more   │ │ │
│  │  │(native) │ │(native)  │ │(native)│ │(nat.)│ │(OpenAI-   │ │ │
│  │  │         │ │          │ │        │ │      │ │compatible)│ │ │
│  │  └─────────┘ └──────────┘ └────────┘ └──────┘ └───────────┘ │ │
│  └───────────────────────────────────────────────────────────────┘ │
│                                                                    │
│  ┌────────────────┐  ┌─────────────────┐  ┌────────────────────┐  │
│  │ Vercel AI      │  │ EncryptionSvc   │  │ Tenant LLM Policy  │  │
│  │ Adapters       │  │ (AES-256-GCM)   │  │ Enforcement        │  │
│  └────────────────┘  └─────────────────┘  └────────────────────┘  │
└────────────────────────────────────────────────────────────────────┘
                              │
┌─────────────────────────────▼──────────────────────────────────────┐
│                      Data Layer (MongoDB)                           │
│  ┌──────────────┐  ┌──────────────┐  ┌──────────────────────────┐ │
│  │ TenantModel   │  │ ModelConfig  │  │ AgentModelConfig         │ │
│  │ (28 fields,   │  │ (project-    │  │ (per-agent override,     │ │
│  │  embedded     │  │  level model │  │  operation_models map)   │ │
│  │  connections) │  │  assignment) │  │                          │ │
│  └──────────────┘  └──────────────┘  └──────────────────────────┘ │
│  ┌──────────────┐  ┌──────────────┐  ┌──────────────────────────┐ │
│  │ LLMCredential │  │ TenantLLM    │  │ MODEL_REGISTRY           │ │
│  │ (encrypted,   │  │ Policy       │  │ (178 models, 15          │ │
│  │  tenant/user  │  │ (governance) │  │  providers, compile-time)│ │
│  │  scoped)      │  │              │  │                          │ │
│  └──────────────┘  └──────────────┘  └──────────────────────────┘ │
└────────────────────────────────────────────────────────────────────┘
```

---

## 4. Design Decisions

### Decision 1: Vercel AI SDK over Custom Provider Implementations

| Consideration                  | Custom Providers (Before)          | Vercel AI SDK (After)                     |
| ------------------------------ | ---------------------------------- | ----------------------------------------- |
| **Lines of code per provider** | 200–600 lines each                 | 5–10 lines (factory call)                 |
| **Streaming support**          | Manual SSE parsing per provider    | Built-in `streamText()`                   |
| **Tool calling**               | Custom serialization per vendor    | Unified `generateText({ tools })`         |
| **New provider onboarding**    | Days (write class, tests, adapter) | Minutes (add `createOpenAI({ baseURL })`) |
| **Maintenance burden**         | API changes break our code         | SDK team maintains compatibility          |
| **Provider count supported**   | 3 (with 7 files)                   | 15 (with 0 custom files)                  |

**Why:** The Vercel AI SDK provides a production-grade abstraction that covers 99% of our provider communication needs. The custom provider layer was the #1 source of integration bugs and the biggest barrier to adding new providers.

**Trade-off:** We depend on the `ai` npm package ecosystem. Mitigated by: the SDK is MIT-licensed, widely adopted, and our `vercel-ai-adapters.ts` layer provides a clean seam for replacement if needed.

### Decision 2: 6-Level Resolution Chain with Explicit Failure

**Why not just use a simple config lookup?**

The resolution chain supports the platform's multi-tenancy model where different stakeholders configure models at different levels:

| Level                   | Who Configures                | When Used                                |
| ----------------------- | ----------------------------- | ---------------------------------------- |
| 0 - Deployment Override | DevOps (deploy-time snapshot) | Immutable production deployments         |
| 1 - Agent IR            | Developer (DSL code)          | Agent explicitly specifies model         |
| 2 - Agent DB            | Project Admin (Studio UI)     | Per-agent override without code change   |
| 3 - Project DB          | Project Admin (Studio UI)     | Project-wide tier-based model assignment |
| 4 - Tenant Model        | Org Admin (Studio UI)         | Organization-wide default                |
| 5 - Platform Demo       | Platform Admin                | Evaluation/trial with platform credits   |
| 6 - FAIL                | —                             | Explicit error — no silent fallback      |

**Key design choice:** Level 6 **throws an error** instead of falling back to env-var API keys. This is intentional — silent fallbacks in production mask configuration problems and create billing surprises.

### Decision 3: Single Source of Truth — MODEL_REGISTRY

```
MODEL_REGISTRY (compile-time, 178 models)
    │
    ├── getModelCapabilities()  → runtime capability queries
    ├── getHyperParameters()    → UI form generation
    ├── getBuiltInCatalog()     → Studio model browser
    ├── MODEL_CAPABILITIES      → derived capability map
    └── isReasoningModel()      → reasoning mode detection
```

**Why a single registry?** Before this change, model metadata was scattered across:

- Hardcoded arrays in API routes
- Inline capability checks in provider classes
- Frontend constants in React components
- Ad-hoc model name matching in the resolution service

Now, every component that needs model metadata reads from `MODEL_REGISTRY`. Adding a new model is a single entry in one file — capabilities, parameters, pricing, and UI display all flow automatically.

### Decision 4: Embedded Connections on TenantModel

```
TenantModel (1)
  └── connections[] (N)  ← embedded sub-documents
        ├── credentialId → LLMCredential
        ├── isPrimary
        ├── isActive
        ├── healthStatus
        └── healthMessage
```

**Why embedded instead of a separate collection?**

- A model rarely has more than 2–3 connections (primary + failover)
- Connections are always read together with the model (no independent queries)
- Atomic updates on the parent document (no cross-collection consistency issues)
- Health check status stays co-located with the connection

### Decision 5: Universal Validation via Vercel AI SDK

**Before:** Per-provider validation endpoints — each provider had custom API-list calls (`GET /v1/models` for OpenAI, `POST /v1/messages/count_tokens` for Anthropic, etc.).

**After:** One universal validation path:

```typescript
await generateText({
  model: providerInstance,
  prompt: 'hi',
  maxTokens: 1,
  maxRetries: 0,
});
```

**Why:** This tests the full inference pipeline (auth, routing, model availability) with a single token. Works for all 15 providers with zero per-provider maintenance.

### Decision 6: Tenant-Scoped LLM Governance

Governance is enforced at resolution time, not at the UI level. Even if a model is somehow configured (API bypass, seed data), the resolution service will reject it if the provider is not in the tenant's allowlist.

```
Resolve model → Extract provider → Check allowedProviders[] → ALLOW or THROW
```

### Decision 7: Unified Credential Store (Migration 20260219_001)

Previously, `llm_credentials` was a user-only collection — one scope, one use case. The migration adds `credentialScope` (`user` | `tenant`) and `ownerId`, enabling a single collection for both user and tenant credentials.

**What the migration does:**

- Backfills `credentialScope = 'user'` on all existing records
- Renames `userId` → `ownerId` for scope-neutral ownership
- Extracts inline API keys from TenantModel connections into proper `LLMCredential` records (batch size 500, UUIDv7 for new IDs)
- Drops old indexes, creates new unified compound indexes

**Why:** TenantModel connections no longer store inline API keys — they store `credentialId` pointing to `llm_credentials`. This enables credential rotation without touching every model connection, and audit trail via the credential record.

### Decision 8: ContentBlock Simplification (IR Cleanup)

Removed `DocumentContent`, `AudioContent`, `VideoContent` from the compiler IR. Multimodal content is handled by the dedicated `multimodal-service` app, not by the LLM type system. Also removed `AttachmentFieldIR` and `AttachmentProcessingConfig` (moved to multimodal service). This keeps the core message types lean and the IR schema focused on LLM concerns only.

### Decision 9: Execution Engine Simplification

Net **-388 lines** across 6 execution files (`flow-step-executor.ts`, `memory-integration.ts`, `constraint-checker.ts`, `prompt-builder.ts`, `reasoning-executor.ts`, `preference-detector.ts`). Reasoning model support required cleaner execution paths — the simplification was a prerequisite, not an afterthought.

### Decision 10: Structured Logging in WebSocket Layer

All `console.*` calls in `websocket/handler.ts` replaced with `createLogger('ws-handler')`. The handler also enriches ClickHouse metrics with `tenantId`, `lastModelId`, `lastProvider` — enabling per-tenant, per-model cost attribution in the new BillingPage.

---

## 5. Comparison: Before vs After

### Provider Support

| Provider      | Before                   | After                        | Integration Method |
| ------------- | ------------------------ | ---------------------------- | ------------------ |
| OpenAI        | Custom class (238 lines) | `createOpenAI()`             | Native Vercel SDK  |
| Anthropic     | Custom class (265 lines) | `createAnthropic()`          | Native Vercel SDK  |
| Google Gemini | Custom class (142 lines) | `createGoogleGenerativeAI()` | Native Vercel SDK  |
| Azure OpenAI  | Not supported            | `createAzure()`              | Native Vercel SDK  |
| Groq          | Not supported            | `createOpenAI({ baseURL })`  | OpenAI-compatible  |
| Mistral       | Not supported            | `createOpenAI({ baseURL })`  | OpenAI-compatible  |
| Fireworks AI  | Not supported            | `createOpenAI({ baseURL })`  | OpenAI-compatible  |
| Together AI   | Not supported            | `createOpenAI({ baseURL })`  | OpenAI-compatible  |
| Perplexity    | Not supported            | `createOpenAI({ baseURL })`  | OpenAI-compatible  |
| DeepSeek      | Not supported            | `createOpenAI({ baseURL })`  | OpenAI-compatible  |
| xAI (Grok)    | Not supported            | `createOpenAI({ baseURL })`  | OpenAI-compatible  |
| AWS Bedrock   | Not supported            | `createAmazonBedrock()`      | Native Vercel SDK  |
| Google Vertex | Custom class (594 lines) | `createVertex()`             | Native Vercel SDK  |
| Cohere        | Custom class (481 lines) | `createCohere()`             | Native Vercel SDK  |
| Ultravox      | Not supported            | Custom realtime adapter      | Voice-specific     |

**Result:** 3 providers → **15 providers**. 1,700+ lines of custom provider code → **0 lines**.

### Model Catalog

| Metric                  | Before               | After                               |
| ----------------------- | -------------------- | ----------------------------------- |
| Total models            | 8 (hardcoded)        | 178 (registry)                      |
| Adding a model          | Code change + deploy | 1 registry entry                    |
| Capabilities per model  | None (boolean flags) | 30+ structured fields               |
| Hyper-parameters        | None                 | Provider-specific sliders/dropdowns |
| Pricing data            | None                 | Input/output cost per 1K tokens     |
| Reasoning model support | None                 | effort, thinking, budget, adaptive  |

### Model Resolution

| Aspect            | Before                  | After                                                                  |
| ----------------- | ----------------------- | ---------------------------------------------------------------------- |
| Resolution levels | 1 (tenant config)       | 6 (deployment → agent IR → agent DB → project → tenant → fail)         |
| Granularity       | Tenant-wide only        | Per-operation, per-agent, per-project, per-tenant                      |
| Failure mode      | Silent env-var fallback | Explicit error with actionable message                                 |
| Caching           | None                    | 5-minute TTL, max 10K entries, credential-free                         |
| Tier mapping      | None                    | Operation → tier (fast/balanced/powerful) with project-level overrides |

### Credential Management

| Aspect            | Before                        | After                                                   |
| ----------------- | ----------------------------- | ------------------------------------------------------- |
| Storage           | Plaintext in DB or env vars   | AES-256-GCM encrypted, tenant-scoped DEKs               |
| Scope             | Global                        | Tenant-scoped or user-scoped                            |
| Per-model wiring  | Not possible                  | Connection sub-documents with primary/failover          |
| Health checks     | None                          | Per-connection health status + last validated timestamp |
| Validation        | Per-provider custom endpoints | Universal Vercel AI SDK validation                      |
| Credential policy | None                          | org_first, user_first, org_only, user_only              |

### Governance

| Aspect                 | Before | After                                                    |
| ---------------------- | ------ | -------------------------------------------------------- |
| Provider restrictions  | None   | Per-tenant allowlist (enforced at resolution time)       |
| Credential policy      | None   | 4 policy modes controlling credential resolution order   |
| Operation-tier mapping | None   | Configurable per-tenant with 8 operation types × 4 tiers |
| Platform demo          | None   | Opt-in demo mode with platform-managed credentials       |
| Audit trail            | None   | Credential CRUD events logged to audit store             |

---

## 6. Feature Deep Dive

### 6.1 Model Registry — Single Source of Truth

**File:** `packages/compiler/src/platform/llm/model-registry.ts` (9,046 lines)

The registry defines every supported model with structured metadata:

```typescript
export const MODEL_REGISTRY: Record<string, ModelRegistryEntry> = {
  'gpt-4o': {
    provider: 'openai',
    displayName: 'GPT-4o',
    contextWindow: 128_000,
    maxOutputTokens: 16_384,
    capabilities: ['textToText', 'imageToText'],
    supportsTools: true,
    supportsParallelToolCalls: true,
    supportsStructuredOutput: true,
    pricing: { inputCostPer1k: 0.005, outputCostPer1k: 0.015 },
    hyperParameters: [
      createTemperatureParam(0, 2, 1),
      createMaxTokensParam(16384, 1600),
      createFrequencyPenaltyParam(-2, 2),
      createPresencePenaltyParam(-2, 2),
      createTopPParam(1),
    ],
  },
  // ... 177 more entries
};
```

**Models by provider:**

| Provider      | Models | Notable Models                                          |
| ------------- | ------ | ------------------------------------------------------- |
| OpenAI        | 60     | GPT-4o, GPT-4o Mini, o1, o3, o4-mini, GPT-5, GPT-5.1    |
| Azure         | 25     | GPT-4o, GPT-5.1, o4-mini (deployment-based)             |
| Google        | 18     | Gemini 2.5 Pro/Flash, Gemini 2.0 Flash, Gemini 3 Pro    |
| Mistral       | 12     | Mistral Large/Medium/Small, Codestral, Pixtral          |
| Groq          | 12     | LLaMA 3.x 8B/70B, Mixtral, Gemma 2, DeepSeek R1 Distill |
| Google Vertex | 11     | Claude 3.5/4 on Vertex, Gemini on Vertex                |
| Fireworks AI  | 8      | LLaMA 3.x, Mixtral, Qwen 2.5                            |
| Cohere        | 8      | Command R/R+, Command A, Aya Expanse                    |
| Anthropic     | 7      | Claude Opus 4, Sonnet 4, Haiku 4.5, Sonnet 3.5          |
| Together AI   | 6      | LLaMA 3.x 70B/405B, Qwen 2.5 Coder                      |
| xAI           | 5      | Grok 3, Grok 3 Mini, Grok 2                             |
| Perplexity    | 4      | Sonar Pro, Sonar, Sonar Deep Research                   |
| DeepSeek      | 3      | DeepSeek V3, DeepSeek R1, DeepSeek Coder V2             |
| AWS Bedrock   | 3      | Claude Sonnet 4, Claude Haiku 4.5, Claude Sonnet 3.5    |
| Ultravox      | 1      | Ultravox v0.5 (real-time voice)                         |

**IR Schema Changes** (`packages/compiler/src/platform/ir/schema.ts`):

The Agent IR was updated to support the new model capabilities:

- Added `summarization` to `OperationModelMap` (allows per-operation model for summarization tasks)
- Added `reasoning_effort`, `enable_thinking`, `thinking_budget` to `ExecutionConfig`
- Simplified `ContentBlock` union (removed Document/Audio/Video — handled by multimodal service)
- Simplified gather field compilation: removed `retry_prompt` and `max_retries`, simplified `extraction_hints` to `[f.prompt]`

### 6.2 6-Level Model Resolution Chain

**File:** `apps/runtime/src/services/llm/model-resolution.ts` (1,053 lines)

```
Request with operation type (e.g., "response_gen")
    │
    ▼
Level 0: Deployment Override ─────── Highest priority (immutable snapshot)
    │ (not set)
    ▼
Level 1: Agent IR ────────────────── DSL: operation_models.response_gen or execution.model
    │ (not set)
    ▼
Level 2: Agent DB ────────────────── AgentModelConfig: per-agent override via Studio UI
    │ (not set)                       Also resolves DSL name → slug mapping
    ▼
Level 3: Project DB ──────────────── ModelConfig: tier-based, linked to TenantModel
    │ (not set)                       Falls back to ANY project model
    ▼
Level 3b: Voice ──────────────────── Capability-based: finds models with realtime_voice
    │ (not applicable)
    ▼
Level 4: Tenant Model ────────────── Tier-specific default → any isDefault → ANY active model
    │ (not set)
    ▼
Level 5: Platform Demo ───────────── Optional: platform-managed __platform__ tenant
    │ (not enabled)
    ▼
Level 6: FAIL ────────────────────── Throws AppError with actionable message
```

**Key behaviors:**

- **Tier mapping:** `operationToTier()` maps operation → tier with project-level overrides (via `ProjectLLMConfig`)
- **Fallback within levels:** Level 4 has 4 sub-fallbacks: tier+isDefault → tier+any → anyDefault → anyActive
- **Credential resolution:** Happens after model is found, using tenant's credential policy
- **Provider allowlist:** Enforced after resolution, before API call
- **Override threading:** `useResponsesApi` and `useStreaming` are threaded through Levels 2-4 as tri-state overrides (agent → project → tenant), with the most specific non-null value winning
- **Cache:** Metadata cached (5-min TTL, 10K max), credentials never cached (re-decrypted every call)

### 6.3 Vercel AI SDK Integration

**Files:**

- `apps/runtime/src/services/llm/session-llm-client.ts` — Provider factory
- `apps/runtime/src/services/llm/vercel-ai-adapters.ts` — Type adapters

The `SessionLLMClient.createVercelProvider()` method handles all 15 providers:

```typescript
// Native SDK providers
case 'anthropic':  return createAnthropic({ apiKey, baseURL }).chat(modelId);
case 'openai': {
  // Auto-detect Responses API from MODEL_REGISTRY; DB override (true/false) takes precedence
  const factory = createOpenAI({ apiKey, baseURL });
  const useResponses = override !== false && (override === true || modelSupportsResponsesApi(modelId));
  return useResponses ? factory(modelId) : factory.chat(modelId);
}
case 'azure':      return createAzure({ apiKey, apiVersion, resourceName, useDeploymentBasedUrls: true }).chat(deploymentId);
case 'google':     return createGoogleGenerativeAI({ apiKey, baseURL }).chat(modelId);
case 'bedrock':    return createAmazonBedrock({ ... }).chat(modelId);
case 'cohere':     return createCohere({ apiKey, baseURL }).chat(modelId);

// OpenAI-compatible providers (7 providers, same pattern)
case 'groq':       return createOpenAI({ apiKey, baseURL: 'https://api.groq.com/openai/v1' }).chat(modelId);
case 'mistral':    return createOpenAI({ apiKey, baseURL: 'https://api.mistral.ai/v1' }).chat(modelId);
case 'fireworks':  return createOpenAI({ apiKey, baseURL: 'https://api.fireworks.ai/inference/v1' }).chat(modelId);
case 'togetherai': return createOpenAI({ apiKey, baseURL: 'https://api.together.xyz/v1' }).chat(modelId);
case 'perplexity': return createOpenAI({ apiKey, baseURL: 'https://api.perplexity.ai' }).chat(modelId);
case 'deepseek':   return createOpenAI({ apiKey, baseURL: 'https://api.deepseek.com/v1' }).chat(modelId);
case 'xai':        return createOpenAI({ apiKey, baseURL: 'https://api.x.ai/v1' }).chat(modelId);
```

**OpenAI Responses API — auto-detection:**

The Vercel AI SDK exposes two API modes for OpenAI: `factory(modelId)` (Responses API) vs `factory.chat(modelId)` (Chat Completions). The platform auto-selects using a three-way override chain:

| `useResponsesApi` value | Source                             | Behavior                                                             |
| ----------------------- | ---------------------------------- | -------------------------------------------------------------------- |
| `true`                  | DB override (tenant/project/agent) | Force Responses API                                                  |
| `false`                 | DB override (tenant/project/agent) | Force Chat Completions                                               |
| `null` / not set        | Default                            | Auto-detect from `OPENAI_RESPONSES_API_MODELS` set in MODEL_REGISTRY |

**Models auto-detected for Responses API:** GPT-4o family, GPT-4.1 family, GPT-5 family, o-series reasoning models (o1, o3, o4-mini), search models, and audio models. Older models (GPT-3.5 Turbo, GPT-4 Turbo) continue using Chat Completions.

**Streaming Mode — per-model toggle:**

The `useStreaming` field follows the same tri-state pattern as `useResponsesApi`, controlling whether the platform uses `streamText()` (streaming) or `generateText()` (non-streaming) when calling the LLM:

| `useStreaming` value | Source                             | Behavior                                                                        |
| -------------------- | ---------------------------------- | ------------------------------------------------------------------------------- |
| `true`               | DB override (tenant/project/agent) | Force streaming — always use `streamText()`                                     |
| `false`              | DB override (tenant/project/agent) | Force non-streaming — use `generateText()`, emit synthetic SSE events           |
| `null` / not set     | Default                            | Auto-detect from `supportsStreaming` in MODEL_REGISTRY (streaming if supported) |

When streaming is disabled, `chatWithToolUseStreamable()` falls back to `generateText()` but the SSE contract is preserved — callers (WebSocket handler, `/api/chat/stream` route) continue to work unchanged. Text is delivered as a single chunk rather than progressive deltas.

**Channel vs model streaming:** Channel `supportsStreaming` (can the transport deliver SSE?) is separate from model `useStreaming` (should the LLM API call stream?). They are orthogonal concerns.

**Type Adapter Layer** (`vercel-ai-adapters.ts`):

Converts between ABL platform types (Anthropic-style content blocks) and Vercel AI SDK format:

- `tool_use` → `{ type: 'tool-call', toolCallId, toolName, input }`
- `tool_result` → `{ type: 'tool-result', toolCallId, toolName, output }` with `role: 'tool'`
- `image` blocks → base64 `Buffer` or URL passthrough
- Builds `toolCallIdToName` reverse map for tool result correlation

### 6.4 Unified Credential Management

**Encryption:** AES-256-GCM with tenant-scoped Data Encryption Keys (DEKs)

```
┌────────────────────────────────────────┐
│           LLMCredential                │
│  ┌──────────────────────────────────┐  │
│  │ credentialScope: 'tenant'|'user' │  │
│  │ ownerId: tenantId or userId      │  │
│  │ provider: 'openai'               │  │
│  │ encryptedApiKey: 'Z1|N0|...'     │  │  ← AES-256-GCM encrypted
│  │ encryptedEndpoint: 'Z1|N0|...'   │  │  ← AES-256-GCM encrypted
│  │ authType: 'api_key'              │  │
│  │ authConfig: { ... }              │  │
│  │ isDefault: true                  │  │
│  │ isActive: true                   │  │
│  └──────────────────────────────────┘  │
└────────────────────────────────────────┘
```

**Credential Policy Resolution:**

| Policy       | First Attempt           | Fallback        | Use Case                                      |
| ------------ | ----------------------- | --------------- | --------------------------------------------- |
| `org_first`  | Org (tenant) credential | User credential | Default — org manages keys, user can override |
| `user_first` | User credential         | Org credential  | Users bring own keys, org provides fallback   |
| `org_only`   | Org credential          | None            | Strict org control — no BYOK                  |
| `user_only`  | User credential         | None            | Fully decentralized — each user manages keys  |

**Last-resort fallback:** If no standalone `LLMCredential` is found, the resolver looks for a `TenantModel` with an active connection for the target provider and uses that connection's credential.

### 6.5 Tenant Model Catalog with Connections

**Schema:** `TenantModel` (28 fields, embedded connections)

```
┌──────────────────────────────────────────┐
│            TenantModel                    │
│  displayName: "GPT-4o"                   │
│  modelId: "gpt-4o"                       │
│  provider: "openai"                      │
│  tier: "balanced"                        │
│  isDefault: true                         │
│  inferenceEnabled: true                  │
│  temperature: 0.7                        │
│  maxTokens: 4096                         │
│  hyperParameters: { top_p: 1, ... }      │
│  supportsTools: true                     │
│  supportsStreaming: true                 │
│  supportsVision: true                    │
│  capabilities: ['text', 'vision']        │
│  useResponsesApi: null                   │  ← null = auto-detect; true/false = force
│  useStreaming: null                       │  ← null = auto-detect; true/false = force
│                                          │
│  connections: [                          │
│    ┌────────────────────────────────┐    │
│    │  Connection #1 (Primary)       │    │
│    │  credentialId → LLMCredential  │    │
│    │  isPrimary: true               │    │
│    │  healthStatus: 'healthy'       │    │
│    │  lastHealthCheck: 2026-02-26   │    │
│    └────────────────────────────────┘    │
│    ┌────────────────────────────────┐    │
│    │  Connection #2 (Failover)      │    │
│    │  credentialId → LLMCredential  │    │
│    │  isPrimary: false              │    │
│    │  healthStatus: 'unchecked'     │    │
│    └────────────────────────────────┘    │
│  ]                                       │
└──────────────────────────────────────────┘
```

**Database Indexes (5 compound indexes):**

| Index                                   | Purpose                                |
| --------------------------------------- | -------------------------------------- |
| `{ tenantId, displayName }` (unique)    | No duplicate model names per tenant    |
| `{ tenantId, tier, isActive }`          | Tier-based resolution queries          |
| `{ tenantId, provider, isActive }`      | Provider-based credential fallback     |
| `{ tenantId, capabilities, isActive }`  | Voice and multimodal capability lookup |
| `{ provisionedBy, createdAt }` (sparse) | Platform provisioning admin queries    |

### 6.6 Per-Agent Model Overrides

**Schema:** `AgentModelConfig` — stored per (projectId, agentName) pair

```
AgentModelConfig {
  projectId: "proj_123"
  agentName: "customer-support"
  defaultModel: "gpt-4o"                    ← default for all operations
  operationModels: {
    "reasoning": "claude-opus-4-20250514",   ← use Opus for reasoning
    "extraction": "gpt-4o-mini",             ← use Mini for extraction
    "realtime_voice": "ultravox-v0.5"        ← use Ultravox for voice
  }
  temperature: 0.3
  maxTokens: 2048
  hyperParameters: { top_p: 0.95 }
  useResponsesApi: null                      ← null = auto-detect from registry; true/false = force
  useStreaming: null                          ← null = auto-detect from supportsStreaming; true/false = force
}
```

**DSL Name Resolution:** The Studio stores configs using project agent slugs (e.g., `"supervisor"`), but the runtime uses DSL names (e.g., `"TravelDesk_Supervisor"`). The resolution service handles this by:

1. Trying exact match: `findAgentModelConfig(projectId, agentName)`
2. Falling back to DSL name → slug mapping: `findAgentModelConfigByDslName(projectId, dslName)`

### 6.7 LLM Governance Policy

#### Tenant-Level Policy

**Schema:** `TenantLLMPolicy` — one per tenant

| Field                     | Type       | Purpose                                                                            |
| ------------------------- | ---------- | ---------------------------------------------------------------------------------- |
| `credentialPolicy`        | `string`   | `org_first` / `user_first` / `org_only` / `user_only`                              |
| `allowedProviders`        | `string[]` | Empty = all allowed; non-empty = allowlist (server-enforced, hidden from admin UI) |
| `allowProjectCredentials` | `boolean`  | Whether projects can use their own credentials                                     |
| `platformDemoEnabled`     | `boolean`  | Opt-in to platform demo credentials                                                |
| `monthlyTokenBudget`      | `number`   | Token budget (enforcement TBD)                                                     |
| `dailyTokenBudget`        | `number`   | Token budget (enforcement TBD)                                                     |
| `maxRequestsPerMinute`    | `number`   | Rate limiting (enforcement TBD)                                                    |

The admin UI exposes only the **Credential Policy** selector. Provider allowlisting is enforced server-side but hidden from the UI to reduce complexity — all providers are enabled by default.

#### Project-Level Operation-Tier Mapping

**Schema:** `ProjectLLMConfig` — one per project

| Field                    | Type                     | Purpose                                   |
| ------------------------ | ------------------------ | ----------------------------------------- |
| `tenantId`               | `string`                 | Owning tenant                             |
| `projectId`              | `string`                 | Owning project                            |
| `operationTierOverrides` | `Record<string, string>` | Override default operation → tier mapping |

Operation-tier mapping lives at the **project level**, not the tenant level. This gives project owners control over which model tier handles each operation type, while keeping tenant-level governance focused on credentials and provider policy. If a project has no overrides, platform defaults apply.

**Platform Default Mapping (hardcoded in resolution service):**

| Operation        | Default Tier | Typical Models                          |
| ---------------- | ------------ | --------------------------------------- |
| `extraction`     | fast         | GPT-4o Mini, Claude Haiku, Gemini Flash |
| `validation`     | fast         | GPT-4o Mini, Claude Haiku, Gemini Flash |
| `tool_selection` | fast         | GPT-4o Mini, Claude Haiku, Gemini Flash |
| `response_gen`   | balanced     | GPT-4o, Claude Sonnet, Gemini Pro       |
| `summarization`  | balanced     | GPT-4o, Claude Sonnet, Gemini Pro       |
| `reasoning`      | powerful     | o3, Claude Opus, Gemini 2.5 Pro         |
| `coordination`   | powerful     | o3, Claude Opus, Gemini 2.5 Pro         |

The `realtime_voice` operation always routes to the `voice` tier via dedicated voice resolution (`findDefaultTenantModelForVoice`) and is not user-configurable.

**UI:** The mapping appears in **Project Settings > Model Config** tab, below the model list. Each operation shows its effective tier pre-selected in a dropdown (Fast, Balanced, Powerful). Overridden tiers are visually distinguished with an accent border.

### 6.8 Reasoning Model Support

The registry and resolution chain support 4 reasoning paradigms:

| Paradigm            | Provider  | Models                   | Configuration                                          |
| ------------------- | --------- | ------------------------ | ------------------------------------------------------ |
| **Effort**          | OpenAI    | o1, o3, o4-mini          | `reasoningEffort: 'low' \| 'medium' \| 'high'`         |
| **Thinking**        | Anthropic | Claude Sonnet 4, Opus 4  | `enableThinking: true`, `thinkingBudget: N`            |
| **Thinking Levels** | Google    | Gemini 2.5 Pro/Flash     | `thinkingLevel: 'none' \| 'low' \| 'medium' \| 'high'` |
| **Adaptive**        | Anthropic | Claude 4.6 (Opus/Sonnet) | `adaptiveBuiltIn: true` (auto-decides thinking)        |

**Registry flags per model:**

```typescript
isReasoningModel?: boolean;
supportsReasoningEffort?: boolean;   // OpenAI effort dropdown
supportsThinking?: boolean;          // Anthropic thinking toggle
supportsThinkingBudget?: boolean;    // Anthropic thinking budget slider
temperatureDisabled?: boolean;       // Reasoning models that don't support temperature
```

**Runtime detection:**

```typescript
import { isReasoningModel, supportsThinking } from '@abl/compiler/platform/llm/model-capabilities';

if (isReasoningModel(modelId)) {
  // Skip temperature, use reasoning parameters instead
}
```

### 6.9 Hyper-Parameter Templates

**File:** `packages/compiler/src/platform/llm/hyper-parameter-templates.ts` (737 lines)

Factory functions that generate `HyperParameter[]` arrays with provider-specific ranges:

```typescript
// Temperature ranges differ by provider
createTemperatureParam(0, 1, 0.7); // Anthropic: 0–1
createTemperatureParam(0, 2, 1.0); // OpenAI/Gemini: 0–2

// Max tokens differ by model
createMaxTokensParam(16384, 1600); // GPT-4o
createMaxTokensParam(8192, 2048); // Claude Sonnet
createMaxTokensParam(65536, 4096); // Gemini 2.5 Pro

// Provider-specific parameters
createReasoningEffortParam(['low', 'medium', 'high'], 'medium'); // o3, o4-mini
createThinkingSection(128000); // Claude thinking budget
createGeminiThinkingBudgetParam(); // Gemini thinking level
```

**Pre-composed parameter sets** eliminate duplication across 178 models:

- `STANDARD_PARAMS_FULL` — temp, max_tokens, top_p, frequency_penalty, presence_penalty
- `GROQ_PARAMS_FULL` — includes seed, stop_sequences
- `DEEPSEEK_PARAMS_FULL` — includes frequency_penalty, presence_penalty
- `PERPLEXITY_ONLINE_PARAMS` — search_recency (dropdown: day/week/month/year)

### 6.10 Provider Icons & UI Enhancements

**File:** `apps/studio/src/components/icons/ProviderIcons.tsx` (266 lines)

17 SVG icon components with official brand marks:

| Provider      | Icon Style                                     |
| ------------- | ---------------------------------------------- |
| OpenAI        | Black/white logomark                           |
| Anthropic     | A-mark, `currentColor`                         |
| Azure         | Multi-gradient blue (#114A8B → #3CCBF4)        |
| Google        | 4-color G (#4285F4, #34A853, #FBBC05, #EA4335) |
| Gemini        | Blue-to-purple gradient                        |
| Groq          | Orange circle + lightning bolt (#E84C10)       |
| Mistral       | Orange-red grid (#F7D046 → #EB5829)            |
| AWS Bedrock   | External SVG asset                             |
| And 9 more... |                                                |

**Usage:** `getProviderIcon(providerId)` returns the correct component with fallback to `CustomProviderIcon`.

**UI Components:**

- `ModelsPage` — Full model management with expandable rows, inline connection wiring, settings editing
- `AddModelDialog` — Browse global catalog or add custom model
- `AddConnectionDialog` — Wire credentials to models with test button
- `AgentModelTab` — Per-agent model selection with operation-level overrides
- `LLMPolicySection` — Governance configuration with visual cards
- `ProviderSelect` — Reusable provider dropdown with icons
- `HyperParameterForm` — Dynamic form generated from model's `hyperParameters[]`

### 6.11 Real-time Voice Model Support

**Files:**

- `packages/compiler/src/platform/llm/realtime/` — Voice model adapters
- Resolution: Level 3b (capability-based voice lookup)

```typescript
interface RealtimeModelConfig {
  audioFormat?: 'pcm16' | 'g711_ulaw' | 'g711_alaw';
  voices?: string[];
  vadConfig?: {
    type?: 'server_vad' | 'none';
    threshold?: number;
    silenceDurationMs?: number;
  };
  maxSessionDurationMs?: number;
  connectionType?: 'http' | 'websocket';
}
```

**Supported voice providers:**

- **Ultravox** — HTTP-based real-time voice
- **OpenAI Realtime** — WebSocket-based
- **Gemini Live** — WebSocket-based

**Resolution:** `findDefaultTenantModelForVoice(tenantId)` queries for `capabilities: 'realtime_voice'`.

### 6.12 Cost Estimation

**File:** `apps/studio/src/utils/llm-cost.ts`

```typescript
estimateLLMCost(model, tokensIn, tokensOut) → number   // Dollar cost
formatCost(cost) → string                              // "$0.0024"
getModelDisplayName(modelId) → string                   // "Opus 4"
```

Pricing data sourced from `MODEL_REGISTRY.pricing` field — no separate maintenance.

### 6.13 Streaming Mode Control

**Files:**

- `packages/database/src/models/tenant-model.model.ts` — `useStreaming` field on TenantModel
- `packages/database/src/models/agent-model-config.model.ts` — `useStreaming` field on AgentModelConfig
- `packages/database/src/models/model-config.model.ts` — `useStreaming` field on ModelConfig (project-level)
- `apps/runtime/src/services/llm/model-resolution.ts` — Threads `useStreaming` through 6-level chain
- `apps/runtime/src/services/llm/session-llm-client.ts` — `chatWithToolUseStreamable()` method
- `apps/runtime/src/services/execution/reasoning-executor.ts` — Consumes streaming via `onChunk` callback

**Purpose:** Allows admins to control whether LLM API calls use streaming (`streamText()`) or non-streaming (`generateText()`) on a per-model, per-project, or per-agent basis. Some environments require non-streaming for proxy/firewall compatibility, cost control, or debugging.

**Tri-state field pattern** (mirrors `useResponsesApi`):

```
useStreaming: boolean | null

null  → auto-detect from supportsStreaming in MODEL_REGISTRY (streaming if supported)
true  → force streaming (streamText)
false → force non-streaming (generateText)
```

**Resolution chain integration:**

The `useStreaming` override flows through the same 6-level chain as all other model settings:

```
Level 2 (Agent DB)   → agentConfig.useStreaming overrides if non-null
Level 3 (Project DB) → modelConfig.useStreaming overrides if non-null
Level 4 (Tenant)     → tenantModel.useStreaming used as base default
Final                 → useStreamingOverride ?? tenantModelResult.useStreaming
```

**SessionLLMClient — `chatWithToolUseStreamable()`:**

This is the key method that bridges the streaming toggle with the executor layer. It accepts an `onChunk` callback and decides at runtime whether to stream:

```typescript
async chatWithToolUseStreamable(
  systemPrompt: string,
  messages: Message[],
  tools: ToolDefinition[],
  operationType: OperationType,
  onChunk?: (chunk: string) => void,
): Promise<ChatResult>
```

Decision logic:

- `config.useStreaming !== false && !!onChunk` → use `streamText()`, call `onChunk(delta)` for each token
- Otherwise → fall back to `generateText()` via `chatWithToolUse()`

Both paths return the same `ChatResult` shape (text, toolCalls, usage, finishReason), so the caller is unaffected.

**Executor integration:**

The `ReasoningExecutor` calls `chatWithToolUseStreamable()` with its `onChunk` callback. When streaming is enabled, text deltas flow in real-time through the WebSocket to the client. A `streamedText` flag prevents duplicate text emission — if deltas were already sent via `onChunk`, the final `result.text` is not re-sent.

**Studio UI:**

| Location          | Control                                              |
| ----------------- | ---------------------------------------------------- |
| **ModelsPage**    | "Response Mode" select (Streaming / Non-Streaming)   |
| **AgentModelTab** | Override checkbox + "Response Mode" select per agent |

Both controls only appear when the model's `supportsStreaming` capability is `true` in the registry.

---

## 7. Data Model

### Entity Relationship

```
Tenant
  │
  ├── TenantLLMPolicy (1:1)
  │     credentialPolicy, allowedProviders, platformDemoEnabled
  │
  ├── LLMCredential (1:N)
  │     provider, encryptedApiKey, authType, scope(tenant|user)
  │
  ├── TenantModel (1:N)
  │     modelId, provider, tier, hyperParameters, useResponsesApi, useStreaming
  │     └── Connection (1:N, embedded)
  │           credentialId → LLMCredential, isPrimary, healthStatus
  │
  └── Project (1:N)
        │
        ├── ProjectLLMConfig (0..1)
        │     operationTierOverrides (operation → tier mapping)
        │
        ├── ModelConfig (1:N)
        │     modelId, tier, isDefault, tenantModelId → TenantModel
        │
        └── Agent (1:N)
              └── AgentModelConfig (1:1)
                    defaultModel, operationModels{}, hyperParameters, useResponsesApi, useStreaming
```

### Schema Summary

| Collection            | Key Fields                                                                                 | Indexes    |
| --------------------- | ------------------------------------------------------------------------------------------ | ---------- |
| `tenant_models`       | tenantId, modelId, provider, tier, isDefault, connections[], useResponsesApi, useStreaming | 5 compound |
| `llm_credentials`     | tenantId, provider, encryptedApiKey, credentialScope, ownerId                              | 3 compound |
| `model_configs`       | projectId, modelId, tier, isDefault, tenantModelId, useResponsesApi, useStreaming          | 2 compound |
| `agent_model_configs` | projectId, agentName, defaultModel, operationModels, useResponsesApi, useStreaming         | 1 compound |
| `project_llm_configs` | tenantId, projectId, operationTierOverrides                                                | 1 unique   |
| `tenant_llm_policies` | tenantId, credentialPolicy, allowedProviders                                               | 1 unique   |

---

## 8. API Surface

### Runtime API (Express)

| Method  | Endpoint                                                         | Purpose                                      |
| ------- | ---------------------------------------------------------------- | -------------------------------------------- |
| GET     | `/api/tenants/:tenantId/models`                                  | List tenant models                           |
| POST    | `/api/tenants/:tenantId/models`                                  | Create tenant model (from catalog or custom) |
| GET     | `/api/tenants/:tenantId/models/:id`                              | Get model detail                             |
| PATCH   | `/api/tenants/:tenantId/models/:id`                              | Update model settings                        |
| DELETE  | `/api/tenants/:tenantId/models/:id`                              | Deactivate model                             |
| POST    | `/api/tenants/:tenantId/models/:id/connections`                  | Add connection                               |
| PATCH   | `/api/tenants/:tenantId/models/:id/connections/:connId`          | Update connection                            |
| POST    | `/api/tenants/:tenantId/models/:id/connections/:connId/validate` | Test connection                              |
| POST    | `/api/tenants/:tenantId/models/:id/toggle-inference`             | Toggle inference                             |
| GET     | `/api/tenants/:tenantId/models/:id/impact`                       | Impact analysis                              |
| GET     | `/api/model-capabilities`                                        | Global model catalog (from registry)         |
| GET/PUT | `/api/tenant-llm-policy`                                         | Tenant governance policy (credential policy) |
| GET/PUT | `/api/projects/:projectId/llm-config`                            | Project operation-tier mapping               |
| GET/PUT | `/api/projects/:projectId/agent-model-config/:agentName`         | Agent model config                           |
| POST    | `/api/platform-admin/models/validate-credential`                 | Platform-level validation                    |

### Studio API (Next.js Proxy Routes)

| Method           | Endpoint                                                | Proxies To                 |
| ---------------- | ------------------------------------------------------- | -------------------------- |
| GET/POST         | `/api/tenant-models`                                    | Runtime tenant models      |
| GET/PATCH/DELETE | `/api/tenant-models/[id]`                               | Runtime model detail       |
| POST             | `/api/tenant-models/[id]/connections`                   | Runtime add connection     |
| POST             | `/api/tenant-models/[id]/connections/[connId]/validate` | Runtime validate           |
| POST             | `/api/tenant-models/[id]/toggle-inference`              | Runtime toggle             |
| GET              | `/api/tenant-models/[id]/impact`                        | Runtime impact analysis    |
| GET/POST         | `/api/tenant-credentials`                               | Runtime credentials        |
| GET/PATCH/DELETE | `/api/tenant-credentials/[id]`                          | Runtime credential detail  |
| GET              | `/api/tenant-credentials/[id]/impact`                   | Credential impact analysis |
| GET/PUT          | `/api/projects/[id]/llm-config`                         | Runtime project LLM config |
| POST             | `/api/arch/validate-key`                                | Inline key validation      |

---

## 9. Security & Compliance

| Requirement                  | Implementation                                                                           |
| ---------------------------- | ---------------------------------------------------------------------------------------- |
| **Encryption at rest**       | API keys encrypted with AES-256-GCM, tenant-scoped DEKs via `EncryptionService`          |
| **No plaintext credentials** | `isEncryptedFormat()` detection — auto-encrypts on next save                             |
| **Tenant isolation**         | Every DB query scoped by `tenantId`; tenant isolation Mongoose plugin                    |
| **Credential-free cache**    | Resolution metadata cached, credentials re-decrypted on every call                       |
| **Provider allowlist**       | Enforced at resolution time (server-side); hidden from admin UI (all enabled by default) |
| **Audit trail**              | Credential CRUD events logged with actor, timestamp, IP                                  |
| **No env-var fallback**      | Production paths never fall back to env-var API keys                                     |
| **Input validation**         | Zod schemas on all API boundaries; max-length constraints on keys                        |
| **SSRF protection**          | Custom endpoints validated before use                                                    |

**MongoDB Plugin Enhancements:**

| Plugin                       | Enhancement                                                                                    |
| ---------------------------- | ---------------------------------------------------------------------------------------------- |
| `encryption.plugin.ts`       | Improved encrypted format detection (`isEncryptedFormat()`), added endpoint encryption support |
| `audit-trail.plugin.ts`      | Enhanced change tracking for credential CRUD operations                                        |
| `tenant-isolation.plugin.ts` | Stricter tenant scoping on new LLM-related collections                                         |

---

## 10. Test Coverage

### LLM-Specific Test Suites

| Test File                             | Tests   | Coverage Area                                       |
| ------------------------------------- | ------- | --------------------------------------------------- |
| `llm-services.test.ts`                | 22      | Provider inference, model capabilities, resolution  |
| `model-registry.test.ts`              | 242     | Registry integrity, all 178 models, capabilities V2 |
| `llm-queue-distributed.test.ts`       | 57      | Distributed LLM request queue                       |
| `tenant-model-routes.test.ts`         | 49      | Tenant model CRUD API                               |
| `tenant-models-authz.test.ts`         | 25      | Authorization: cross-tenant, permission checks      |
| `platform-admin-models-authz.test.ts` | 12      | Platform admin authorization                        |
| `agent-model-config-authz.test.ts`    | 16      | Agent config authorization                          |
| `llm-integration.test.ts`             | 6       | End-to-end LLM integration                          |
| `content-block.test.ts`               | 6       | Content block type conversion                       |
| **Total**                             | **435** |                                                     |

### What Tests Validate

- Every registry entry has required fields (provider, displayName, contextWindow, capabilities)
- No duplicate model IDs across providers
- Capabilities V2 structure is valid when present
- Reasoning model flags are consistent (isReasoningModel → has reasoning config)
- Provider inference returns correct provider for all model name patterns
- Cross-tenant model access returns 404 (not 403 — no existence leakage)
- Credential validation works for all 15 providers
- Resolution chain falls through levels correctly
- Cache eviction and TTL behavior

### Refactored Test Suites

These existing test files were significantly rewritten to cover the new model hub behavior:

| Test File                          | Change      | What Was Refactored                                                    |
| ---------------------------------- | ----------- | ---------------------------------------------------------------------- |
| `arch-config-api.test.ts`          | +435        | Covers new config fields, validate-key endpoint, MODEL_REGISTRY models |
| `arch-settings-page.test.tsx`      | +178        | HyperParameterForm integration, provider icons, validation             |
| `reasoning-gather-handoff.test.ts` | +203 / -203 | Rewritten for reasoning model support                                  |
| `error-handler-router.test.ts`     | +258 / -258 | Refactored error handling paths                                        |
| `e2e/fixtures/test-utils.ts`       | +245        | Multi-provider test utilities — abstracts provider-specific setup      |

**Consolidated tests:** `handoff-expect-return.test.ts` (-58 lines) and `parser-handoff-enhanced.test.ts` (-84 lines) were removed — their coverage is now handled by the refactored handoff and reasoning test suites.

---

## 11. Benefits Summary

### For Organization Admins

| Benefit                               | Description                                                          |
| ------------------------------------- | -------------------------------------------------------------------- |
| **Multi-provider choice**             | Choose from 15 providers, 178 models — not locked to 3               |
| **Centralized credential management** | One place to manage all API keys, encrypted and audited              |
| **Governance control**                | Restrict providers, set credential policies, map operations to tiers |
| **Cost visibility**                   | Per-model pricing data, cost estimation per call                     |
| **Health monitoring**                 | Per-connection health checks, last-validated timestamps              |

### For Project Admins

| Benefit                          | Description                                                    |
| -------------------------------- | -------------------------------------------------------------- |
| **Per-agent model selection**    | Different agents can use different models                      |
| **Operation-level optimization** | Use fast models for extraction, powerful for reasoning         |
| **No code changes**              | Switch models via Studio UI, not DSL code                      |
| **Model catalog browse**         | Visual model picker with capabilities, context window, pricing |

### For Developers

| Benefit                        | Description                                                       |
| ------------------------------ | ----------------------------------------------------------------- |
| **Zero-code provider support** | Adding a provider = adding entries to MODEL_REGISTRY              |
| **Reasoning model support**    | o-series effort, Claude thinking, Gemini adaptive — all supported |
| **Type-safe resolution**       | `ResolvedModel` type with provider, credential, parameters        |
| **Unified testing**            | One validation path for all providers (Vercel AI SDK)             |
| **Hyper-parameter forms**      | Dynamic UI forms generated from registry metadata                 |

### For Platform Engineers

| Benefit                     | Description                                                               |
| --------------------------- | ------------------------------------------------------------------------- |
| **No custom provider code** | Vercel AI SDK handles all provider communication                          |
| **Explicit failure**        | No silent fallbacks — misconfig is immediately visible                    |
| **Cache-safe credentials**  | Credentials never cached in memory                                        |
| **Distributed-ready**       | Resolution cache is pod-local with TTL eviction                           |
| **Extensible**              | New model = 1 registry entry; new provider = 1 `case` in SessionLLMClient |

---

## 12. Migration & Rollout

### Backward Compatibility

| Concern                         | Handling                                                                                                |
| ------------------------------- | ------------------------------------------------------------------------------------------------------- |
| **Existing plaintext API keys** | `isEncryptedFormat()` detects plaintext; auto-encrypts on next `.save()`                                |
| **Existing agent DSL models**   | Level 1 (Agent IR) still works — DSL-defined models resolve first                                       |
| **No TenantModel configured**   | Level 6 throws explicit error with message: "Configure a TenantModel"                                   |
| **Old provider enum values**    | Aliases added: `gemini` → `google`, `together` → `togetherai`, `vertex_ai` / `google_vertex` → `vertex` |

### Rollout Steps

1. **Deploy schema changes** — New collections auto-created by Mongoose on first access
2. **Seed tenant models** — Admin creates TenantModel entries via ModelsPage UI
3. **Wire connections** — Admin creates LLMCredentials and wires them to TenantModels
4. **Set policy** — Admin configures LLMPolicySection (credential policy, allowed providers)
5. **Agent overrides** — Project admins optionally set per-agent models via AgentModelTab
6. **Existing agents continue working** — DSL-defined models (Level 1) still resolve first

### Credential Store Migration (20260219_001)

**File:** `packages/database/src/migrations/scripts/20260219_001_unified_credential_store.ts` (239 lines)

This is the only migration script required. It transforms `llm_credentials` from a user-only collection to a unified tenant+user credential store:

| Step | Operation                                                                         |
| ---- | --------------------------------------------------------------------------------- |
| 1    | Backfill `credentialScope = 'user'` on all existing records                       |
| 2    | Rename `userId` → `ownerId` for scope-neutral ownership                           |
| 3    | Extract inline API keys from TenantModel connections into `LLMCredential` records |
| 4    | Drop old single-field indexes, create new compound indexes                        |

- **Batch size:** 500 records per batch (prevents OOM on large datasets)
- **ID generation:** UUIDv7 for new credential records (time-sortable, shard-safe)
- **Idempotent:** Safe to re-run — checks for existing records before backfill

### Zero-Downtime Adoption

The rest of the system requires no migration:

- `MODEL_REGISTRY` is compile-time data (no DB migration)
- `TenantModel` collection is new (auto-created by Mongoose on first access)
- Existing credential encryption is auto-detected and preserved via `isEncryptedFormat()`
- Provider name aliases handle all known naming inconsistencies

---

## 13. Appendix: File Inventory

### New Files (Created)

| File                                                              | Lines | Purpose                     |
| ----------------------------------------------------------------- | ----- | --------------------------- |
| `packages/compiler/src/platform/llm/model-registry.ts`            | 9,046 | 178-model registry          |
| `packages/compiler/src/platform/llm/model-capabilities.ts`        | 249   | Derived capability queries  |
| `packages/compiler/src/platform/llm/hyper-parameter-templates.ts` | 737   | Parameter factory functions |
| `apps/runtime/src/repos/llm-resolution-repo.ts`                   | 280   | Resolution DB queries       |
| `apps/runtime/src/services/llm/vercel-ai-adapters.ts`             | ~200  | Vercel AI SDK type adapters |
| `apps/runtime/src/routes/platform-admin-models.ts`                | 706   | Platform admin model API    |
| `apps/runtime/src/routes/agent-model-config.ts`                   | 224   | Agent model config API      |
| `apps/runtime/src/routes/model-capabilities.ts`                   | 110   | Model catalog API           |
| `apps/studio/src/components/admin/LLMPolicySection.tsx`           | 376   | LLM governance UI           |
| `apps/studio/src/components/admin/AddModelDialog.tsx`             | 766   | Model catalog browser       |
| `apps/studio/src/components/admin/AddConnectionDialog.tsx`        | 509   | Connection wiring UI        |
| `apps/studio/src/components/agents/AgentModelTab.tsx`             | 298   | Per-agent model config UI   |
| `apps/studio/src/components/icons/ProviderIcons.tsx`              | 266   | 17 provider SVG icons       |
| `apps/studio/src/components/ui/ProviderSelect.tsx`                | ~100  | Reusable provider dropdown  |
| `apps/studio/src/utils/llm-cost.ts`                               | 120   | Cost estimation utilities   |
| `packages/database/src/models/tenant-model.model.ts`              | 146   | TenantModel Mongoose schema |
| `packages/database/src/models/model-config.model.ts`              | 80    | ModelConfig schema          |
| `packages/database/src/models/agent-model-config.model.ts`        | 49    | AgentModelConfig schema     |

### Modified Files (Enhanced)

| File                                                        | Change | Purpose                                                           |
| ----------------------------------------------------------- | ------ | ----------------------------------------------------------------- |
| `apps/runtime/src/services/llm/model-resolution.ts`         | +599   | 6-level resolution chain + `useStreaming` threading               |
| `apps/runtime/src/services/llm/session-llm-client.ts`       | +314   | 15-provider Vercel AI SDK factory + `chatWithToolUseStreamable()` |
| `apps/runtime/src/services/execution/reasoning-executor.ts` | ~      | Streaming support via `chatWithToolUseStreamable()`               |
| `apps/runtime/src/routes/tenant-models.ts`                  | +1,956 | Full tenant model CRUD API                                        |
| `apps/studio/src/components/admin/ModelsPage.tsx`           | +1,728 | Unified model management page                                     |
| `apps/studio/src/components/admin/ArchSettingsPage.tsx`     | +588   | Arch assistant settings                                           |
| `apps/studio/src/components/agents/AgentDetailPage.tsx`     | +692   | Agent detail with model tab                                       |

### Deleted Files (Replaced by Vercel AI SDK)

| File                                                        | Lines Removed | Replaced By                  |
| ----------------------------------------------------------- | ------------- | ---------------------------- |
| `packages/compiler/src/platform/llm/providers/anthropic.ts` | 265           | `createAnthropic()`          |
| `packages/compiler/src/platform/llm/providers/openai.ts`    | 238           | `createOpenAI()`             |
| `packages/compiler/src/platform/llm/providers/azure.ts`     | 469           | `createAzure()`              |
| `packages/compiler/src/platform/llm/providers/gemini.ts`    | 142           | `createGoogleGenerativeAI()` |
| `packages/compiler/src/platform/llm/providers/vertex.ts`    | 594           | `createVertex()`             |
| `packages/compiler/src/platform/llm/providers/cohere.ts`    | 481           | `createCohere()`             |
| `packages/compiler/src/platform/llm/providers/litellm.ts`   | 211           | Direct provider SDKs         |
| **Total removed**                                           | **2,400**     | **~70 lines**                |

### Supporting Changes

| File                                                     | Change   | Purpose                                                                                                                                                                                                  |
| -------------------------------------------------------- | -------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `packages/i18n/locales/en/studio.json`                   | +94 keys | New i18n keys for model hub UI, policy section, settings, streaming mode controls. Removed stale keys (`progress_generating_specs`, `compilation_failed_*`). Renamed: `tab_agents` "ABL Code" → "Agents" |
| `packages/core/src/parser/agent-based-parser.ts`         | +231     | Parser enhancements for reasoning model DSL support                                                                                                                                                      |
| `packages/compiler/src/platform/stores/metrics-store.ts` | +48      | Metrics store interface updated with new fields for model/provider tracking                                                                                                                              |
| `packages/web-sdk/src/chat/ChatClient.ts`                | +9       | SDK client enhancements for model hub integration                                                                                                                                                        |
| `scripts/generate-model-registry.mjs`                    | +252     | Registry generator — reads external `ml-model-config` CJS library and generates typed ESM module. Uses `createRequire` for CJS interop, `normalizeProvider()` for enum mapping                           |

### Consolidated / Removed

| File                                                      | Lines Removed | Reason                                     |
| --------------------------------------------------------- | ------------- | ------------------------------------------ |
| `apps/runtime/src/services/stores/mongo-metrics-store.ts` | 150           | Consolidated into ClickHouse metrics store |
| `docs/MODEL_REGISTRY_AND_LLM_SERVICES.md`                 | 538           | Replaced by `LLM_MODEL_HUB.md`             |
| `ecosystem.config.js`                                     | 156           | Replaced by per-service PM2 configs        |

---

_End of document._

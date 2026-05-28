# Feature: Guardrails

**Doc Type**: MAJOR FEATURE
**Parent Feature**: N/A
**Status**: BETA
**Feature Area(s)**: `governance`, `agent lifecycle`, `customer experience`, `observability`
**Package(s)**: `apps/runtime`, `packages/compiler`, `packages/database`, `apps/studio`
**Owner(s)**: `Platform Team`
**Testing Guide**: `../testing/guardrails.md`
**Last Updated**: 2026-04-15

---

## 1. Introduction / Overview

### Problem Statement

LLM-powered agents can produce harmful, off-topic, or policy-violating outputs. Without runtime content safety checks, enterprises cannot deploy agents in regulated or customer-facing environments. A single unfiltered response can result in brand damage, legal liability, or regulatory fines. The challenge is compounded by streaming responses, multi-agent handoffs, and tool invocations — every content pathway needs protection. Currently, the platform has no built-in mechanism for content moderation, PII prevention, topic enforcement, or compliance gating that operates across the full agent execution lifecycle.

### Goal Statement

Provide a configurable, multi-tier content safety pipeline that evaluates agent inputs, outputs, tool calls, tool results, and handoff decisions against tenant-defined policies. The system must support local (zero-latency), model-based, and LLM-based evaluation with hierarchical policy inheritance, cost tracking, and fail-safe defaults. The pipeline must integrate seamlessly with streaming responses, multi-agent orchestration, and the existing observability infrastructure.

### Summary

Guardrails is a 3-tier content safety pipeline integrated into the ABL runtime execution path. Tier 1 uses local evaluators (CEL expressions, regex, built-in PII detection) for sub-millisecond checks. Tier 2 leverages dedicated classification models (OpenAI Moderation, custom HTTP endpoints). Tier 3 employs general-purpose LLMs for nuanced evaluation (constitution-based, topic drift, factual grounding). Policies cascade from platform defaults through tenant, project, and agent-level overrides. The pipeline supports 5 evaluation kinds: input validation, output validation, tool call screening, tool output filtering, and handoff blocking. Results are cached in Redis with tier-appropriate TTLs, costs are tracked per tenant with budget controls, and all evaluations emit structured trace events for observability.

---

## 2. Scope

### Goals

- 3-tier evaluation pipeline (local, model, LLM) with configurable provider backends
- 5 evaluation kinds: input, output, tool_input, tool_output, handoff
- Hierarchical policy inheritance: platform defaults -> tenant -> project -> agent DSL
- 7 violation actions: block, warn, redact, fix, reask, filter, escalate
- Streaming evaluation with sentence-boundary chunking and early termination on terminal violations
- Redis-backed caching with tier-specific TTLs (local: 24h, model: 1h, LLM: never)
- Cost tracking in microdollars with monthly budgets and downgrade/allow actions
- Circuit breaker per provider with configurable thresholds and fail modes
- Webhook delivery for violation events with HMAC-SHA256 signing and SSRF protection
- Full trace event coverage for every pipeline phase (15 event types)
- Studio UI for policy management, provider configuration, and audit viewing

### Non-Goals (Out of Scope)

- Real-time model training or fine-tuning of guardrail models
- Image/audio/video content moderation (text-only in current implementation)
- Automated remediation beyond reask/fix actions (no human-in-the-loop escalation workflow)
- Cross-tenant shared policies (each tenant manages independently)
- Semantic similarity caching (schema supports it; runtime does not implement it)

---

## 3. User Stories

1. As a **platform admin**, I want to register guardrail providers (OpenAI Moderation, custom HTTP) at the tenant level so that project builders can use them in their policies.
2. As a **tenant admin**, I want to define guardrail policies with rule overrides so that I can customize content safety for my organization.
3. As a **project builder**, I want to attach guardrail policies to specific agents via DSL or policy scope so that each agent has appropriate content controls.
4. As a **project builder**, I want to set cost budgets for guardrail evaluations so that I can control spend on model-based and LLM-based checks.
5. As an **agent user**, I want guardrails to evaluate my input before the agent processes it so that harmful content is blocked immediately.
6. As an **operations engineer**, I want to view guardrail evaluation traces (15 event types) so that I can debug why a response was blocked or modified.
7. As a **project builder**, I want guardrails to evaluate streaming output in real-time at sentence boundaries so that violations are caught before the full response is delivered.
8. As a **project builder**, I want to define guardrail rules inline in the agent DSL (`GUARDRAILS:` section) so that agent-specific safety rules live alongside agent logic.
9. As a **tenant admin**, I want circuit breakers on guardrail providers so that a failing external service does not block all agent responses.

---

## 4. Functional Requirements

1. **FR-1**: The system must evaluate content against a configurable pipeline of guardrail rules before and after LLM processing, with early termination on terminal violations (block/escalate).
2. **FR-2**: The system must support 3 evaluation tiers: local (CEL/regex/builtin-PII for <5ms), model (dedicated classifiers for <500ms), and LLM (general-purpose with prompts for <5s).
3. **FR-3**: The system must resolve guardrail policies through a 4-level inheritance chain: platform defaults -> tenant policies -> project policies -> agent DSL overrides, where lower-scope rules replace higher-scope rules for the same guardrail name.
4. **FR-4**: The system must support 5 evaluation kinds: `input`, `output`, `tool_input`, `tool_output`, `handoff`, each with kind-specific CEL context variables.
5. **FR-5**: The system must cache evaluation results in Redis with tier-specific TTLs (local: 24h, model: 1h, LLM: never cached) using tenant-isolated cache keys.
6. **FR-6**: The system must track evaluation costs per tenant/project in microdollars (1 USD = 1,000,000) with configurable monthly budgets and overspend actions (downgrade/disable_model_checks/alert_only).
7. **FR-7**: The system must support streaming evaluation with sentence-boundary or chunk-size buffering and early termination on terminal violations (block/escalate), with retract events for already-streamed content.
8. **FR-8**: The system must deliver violation events via webhooks with HMAC-SHA256 signatures, SSRF URL validation, and exponential backoff retry (1s, 4s, 16s).
9. **FR-9**: The system must support 7 violation actions: allow, block, warn, redact, fix, reask, filter, escalate. `reask` is valid only on `output` kind. `fix` and `filter` are not valid on `handoff` kind.
10. **FR-10**: The system must emit structured trace events for every guardrail check, violation, fix, reask, cache hit/miss, cost event, circuit breaker state change, and pipeline completion (15 event types total).
11. **FR-11**: The system must apply circuit breakers per provider with configurable failure thresholds and reset timeouts, transitioning through CLOSED -> OPEN -> HALF_OPEN states.
12. **FR-12**: The system must fail-open by default when guardrail evaluation errors occur (configurable per policy to fail-closed).
13. **FR-13**: The system must compile `GUARDRAILS:` DSL sections to IR `Guardrail[]` with compile-time validation of action-kind compatibility.
14. **FR-14**: The system must provide CRUD API routes for guardrail policies (project-scoped) and provider configs (tenant-scoped) behind auth middleware, rate limiting, and feature gates.

---

## 5. Feature Classification & Integration Matrix

### Lifecycle / Platform Impact

| Area                       | Impact Level | Notes                                                                                      |
| -------------------------- | ------------ | ------------------------------------------------------------------------------------------ |
| Project lifecycle          | SECONDARY    | Policies are project-scoped; activated per deployment                                      |
| Agent lifecycle            | PRIMARY      | Every agent execution triggers guardrail pipeline at input/output/tool/handoff checkpoints |
| Customer experience        | PRIMARY      | Directly impacts response quality, safety, and latency                                     |
| Integrations / channels    | SECONDARY    | Channel-agnostic; applies at runtime execution layer, not channel ingress                  |
| Observability / tracing    | PRIMARY      | 15 distinct trace event types for guardrail operations                                     |
| Governance / controls      | PRIMARY      | Core governance feature; policy inheritance enables organizational control                 |
| Enterprise / compliance    | PRIMARY      | Required for regulated deployments; audit trail for compliance                             |
| Admin / operator workflows | PRIMARY      | Studio UI for policy management, provider config, and audit                                |

### Related Feature Integration Matrix

| Related Feature           | Relationship Type | Why It Matters                                                           | Key Touchpoints                                                       | Current State |
| ------------------------- | ----------------- | ------------------------------------------------------------------------ | --------------------------------------------------------------------- | ------------- |
| PII Detection & Redaction | extends           | Built-in PII is a Tier 1 guardrail provider (`builtin_pii` adapter)      | `BuiltinPIIProvider` auto-registered in pipeline factory              | Implemented   |
| Auth Profiles             | depends on        | Provider API keys resolved through auth profiles                         | `authProfileId` in provider config, `resolveAuthProfileCredentials()` | Implemented   |
| Tracing & Observability   | emits into        | All evaluations emit TraceEvents via session callback                    | 15 `guardrail_*` trace event types in `trace-events.ts`               | Implemented   |
| Model Hub                 | depends on        | LLM tier uses model hub for credential resolution via `SessionLLMClient` | `createLLMEvalFromClient()` in pipeline factory                       | Implemented   |
| Multi-Agent Orchestration | shares data with  | Handoff blocking requires cross-agent policy evaluation                  | `handoff` kind with `source_agent`/`target_agent` context             | Implemented   |
| Deployments & Versioning  | configured by     | Policies are activated per deployment; status (draft/active/archived)    | Policy `status` field and `activatePolicy` route                      | Implemented   |
| Webhook System            | extends           | Violation webhooks use shared HMAC signing and SSRF protection           | `GuardrailWebhookDelivery` with `assertUrlSafeForSSRF`                | Implemented   |
| ABL Language (DSL)        | configured by     | `GUARDRAILS:` section in agent DSL compiles to IR guardrail definitions  | IR `Guardrail[]` in `AgentIR`                                         | Implemented   |

---

## 6. Design Considerations

### Evaluation Flow

```
User Input -> [Input Validation Pipeline] -> LLM Processing -> [Output Validation Pipeline] -> Response
                                                |
                                          Tool Calls -> [Tool Call Pipeline] -> Tool Execution -> [Tool Output Pipeline]
                                                |
                                          Handoffs -> [Handoff Pipeline]
```

### Streaming Evaluation

The `StreamingGuardrailEvaluator` buffers streaming tokens and evaluates at sentence boundaries (regex: `/[.!?]\s/`) or configurable chunk sizes (default 200 chars). Terminal violations (block/escalate) trigger early stream termination with a `terminate` event. Non-terminal violations (warn) produce `violation` events. Already-streamed content that fails later checks triggers `retract` events.

### Fail Modes

- **fail-open** (default): Evaluation errors allow content through, logged as warnings via trace events.
- **fail-closed**: Evaluation errors block content with a generic safety message. Configured per-policy via `settings.failMode`.

### Action-Kind Compatibility

Compile-time validation enforces these constraints (from `guardrail-validator.ts`):

- `reask` is only valid on `output` kind (requires LLM regeneration)
- `fix` and `filter` are not valid on `handoff` kind (content is opaque)
- `fix` without `fixStrategy` emits a compile warning (falls back to block at runtime)

---

## 7. Technical Considerations

- **Latency budget**: Tier 1 evaluations must complete in < 5ms. Tier 2 in < 500ms. Tier 3 in < 5s. Early termination ensures expensive higher-tier checks are skipped when a cheap local check already blocks.
- **Cache key design**: `guardrail:{tenantId}:{projectId}:{guardrailName}:{sha256_16(content)}` ensures tenant isolation in shared Redis.
- **Cost tracking**: Uses Redis INCRBY with microdollars (1 USD = 1,000,000) for atomic, race-condition-free budget tracking. Monthly keys with 35-day TTL auto-expire.
- **Provider registration**: Tenant-scoped provider registry with max 200 entries, LRU eviction, and 5-minute TTL for DB-loaded providers. Config fingerprinting (SHA-256) detects provider changes.
- **Auth profile dual-read**: Provider API keys are resolved from both `apiKeyCredentialId` and `authProfileId` fields for backward compatibility.
- **Port adapter pattern**: Compiler defines port interfaces (`GuardrailCachePort`, `CostCheckerPort`, `WebhookPort`); runtime provides tenant-scoped adapter implementations that bind `tenantId`/`projectId` at construction.
- **LLM eval fallback**: Tier 3 tries `validation` model tier first, then falls back to `response_gen` if unavailable.
- **Feature gate**: All guardrail routes require `requireFeature('guardrails')` middleware (TEAM tier or above).

---

## 8. How to Consume

### Studio UI

Navigate to **Project Settings > Guardrails** to manage policies, providers, and view audit logs. The `GuardrailsConfigPage` has 3 tabs:

- **Policies**: Create, edit, activate/archive guardrail policies via `GuardrailPolicyForm`. Set scope (project or agent), configure rules via `RuleCard` components, actions, thresholds, severity levels via `SeveritySelector`, and toggle YAML editing via `GuardrailYamlEditor`.
- **Providers**: Register and test guardrail providers via `GuardrailProviderForm` (OpenAI Moderation, custom HTTP, etc.).
- **Audit**: View guardrail evaluation history and violation events (stub -- not yet fully implemented).

Agent-level guardrails can also be configured inline in the agent editor via `GuardrailsEditor` section, which writes to the `GUARDRAILS:` DSL section.

### API (Runtime)

| Method | Path                                                       | Purpose                    |
| ------ | ---------------------------------------------------------- | -------------------------- |
| GET    | `/api/projects/:projectId/guardrail-policies`              | List policies for project  |
| POST   | `/api/projects/:projectId/guardrail-policies`              | Create policy              |
| GET    | `/api/projects/:projectId/guardrail-policies/:id`          | Get policy by ID           |
| PUT    | `/api/projects/:projectId/guardrail-policies/:id`          | Update policy              |
| DELETE | `/api/projects/:projectId/guardrail-policies/:id`          | Delete policy              |
| POST   | `/api/projects/:projectId/guardrail-policies/:id/activate` | Activate policy            |
| GET    | `/api/tenants/:tenantId/guardrail-providers`               | List providers for tenant  |
| POST   | `/api/tenants/:tenantId/guardrail-providers`               | Register provider          |
| GET    | `/api/tenants/:tenantId/guardrail-providers/:id`           | Get provider by ID         |
| PUT    | `/api/tenants/:tenantId/guardrail-providers/:id`           | Update provider            |
| DELETE | `/api/tenants/:tenantId/guardrail-providers/:id`           | Delete provider            |
| POST   | `/api/tenants/:tenantId/guardrail-providers/:id/test`      | Test provider connectivity |

### API (Studio)

| Method | Path                               | Purpose                           |
| ------ | ---------------------------------- | --------------------------------- |
| GET    | `/api/admin/guardrail-providers`   | Proxy to runtime provider list    |
| POST   | `/api/admin/guardrail-providers`   | Proxy to runtime provider create  |
| GET    | `/api/admin/guardrail-policies`    | Proxy to runtime policy list      |
| POST   | `/api/admin/guardrail-policies`    | Proxy to runtime policy create    |
| GET    | `/api/compiler/builtin-guardrails` | List built-in guardrail templates |

### Admin Portal

Tenant admins manage providers at the tenant level via the Admin sidebar (`AdminSidebar.tsx`) which links to `GuardrailsPage.tsx`. Project-level policies are managed within each project's settings.

### Channel / SDK / Voice / A2A / MCP Integration

Guardrails are channel-agnostic. They are evaluated at the runtime execution layer, not at the channel ingress. All channels benefit from the same guardrail pipeline without additional integration.

---

## 9. Data Model

### Collections / Tables

```text
Collection: guardrail_policies
Fields:
  - _id: string (UUIDv7)
  - tenantId: string (required, indexed)
  - name: string (required)
  - scope: { type: 'tenant'|'project'|'agent', projectId?: string, agentDefId?: string }
  - providerOverrides: Array<{ providerName, endpoint?, apiKeyCredentialId?, authProfileId?, defaultThreshold?, circuitBreaker?, retry?, costPerEvalUsd?, isActive? }>
  - rules: Array<{ guardrailName, override: 'disable'|'threshold'|'action'|'severity_actions'|'define', threshold?, action?, severityActions?, kind?, tier?, provider?, category?, check?, llmCheck?, description?, priority?, message? }>
  - constitution: Array<{ principle, weight, examples? }>
  - settings: { failMode: 'open'|'closed', timeouts: { local, model, llm }, webhookUrl?, webhookSecret?, streaming: { enabled, defaultInterval, chunkSize, maxLatencyMs, earlyTermination } }
  - caching: { enabled, exactMatch, semanticMatch, semanticThreshold, defaultTtlSeconds }
  - budget: { monthlyLimitUsd, currentSpendUsd, overspendAction: 'downgrade'|'disable_model_checks'|'alert_only' }
  - version: number
  - previousVersionId: string (optional)
  - changelog: string (optional)
  - status: 'draft' | 'active' | 'archived'
  - isActive: boolean
  - _v: number
  - createdAt: Date
  - updatedAt: Date
Indexes:
  - { tenantId: 1, name: 1, 'scope.type': 1 } (unique)
  - { tenantId: 1, 'scope.projectId': 1, status: 1 }
  - { tenantId: 1, 'scope.agentDefId': 1 }
  - { tenantId: 1, isActive: 1 }
Plugins: tenantIsolationPlugin
```

```text
Collection: tenant_guardrail_provider_configs
Fields:
  - _id: string (UUIDv7)
  - tenantId: string (required, indexed)
  - name: string (required)
  - displayName: string (required)
  - adapterType: enum (15 total: openai_compatible, openai_moderation, custom_http, custom_webhook, custom_llm, huggingface_inference, anthropic, google_cloud, vertex_ai, bedrock, azure_content_safety, lakera, aporia, builtin_pii, other)
  - endpoint: string (required)
  - apiKeyCredentialId: string (optional)
  - authProfileId: string (optional)
  - model: string (required)
  - hosting: 'self_hosted' | 'cloud_api' | 'managed_service'
  - selfHostedConfig: { runtime: 'vllm'|'tgi'|'ollama'|'triton'|'other', gpuType?, quantization?, maxBatchSize?, maxConcurrency? }
  - defaultCategory: string (required)
  - defaultThreshold: number (required)
  - supportedCategories: string[]
  - customMapping: { requestTemplate, responseScorePath, responseLabelPath?, responseExplanationPath? }
  - circuitBreaker: { failureThreshold: number (default 5), resetTimeoutMs: number (default 30000), failMode: 'open'|'closed' }
  - retry: { maxRetries: number (default 3), backoffBaseMs: number (default 1000) }
  - costPerEvalUsd: number (default 0)
  - isActive: boolean
  - lastHealthCheck: { status: 'healthy'|'unhealthy'|'unknown', latencyMs, checkedAt, error? }
  - _v: number
  - createdAt: Date
  - updatedAt: Date
Indexes:
  - { tenantId: 1, name: 1 } (unique)
  - { tenantId: 1, isActive: 1 }
  - { tenantId: 1, adapterType: 1 }
Plugins: tenantIsolationPlugin
```

```text
Redis Keys:
  - guardrail:{tenantId}:{projectId}:{guardrailName}:{sha256_16} -> CachedGuardrailResult (TTL: local=24h, model=1h, llm=never)
  - guardrail:cost:{tenantId}:{projectId}:{YYYY-MM} -> microdollars (integer, TTL: 35 days)
```

### Key Relationships

- **GuardrailPolicy -> TenantGuardrailProviderConfig**: Policies reference providers via `providerOverrides[].providerName`.
- **TenantGuardrailProviderConfig -> AuthProfile/Credential**: Provider configs reference auth profiles or credentials for API key resolution via `authProfileId` or `apiKeyCredentialId`.
- **GuardrailPolicy -> ProjectAgent**: Agent-scoped policies reference `scope.agentDefId`.
- **Pipeline execution -> TraceStore**: Every evaluation emits trace events linked to the session via `onTraceEvent` callback.
- **Agent DSL -> AgentIR**: `GUARDRAILS:` section compiles to `Guardrail[]` in IR, validated at compile time.

---

## 10. Key Implementation Files

### Domain / Core Logic

| File                                                                       | Purpose                                                                   |
| -------------------------------------------------------------------------- | ------------------------------------------------------------------------- |
| `packages/compiler/src/platform/guardrails/pipeline.ts`                    | 3-tier pipeline orchestrator with early termination                       |
| `packages/compiler/src/platform/guardrails/types.ts`                       | Core types: GuardrailContext, GuardrailViolation, GuardrailPipelineResult |
| `packages/compiler/src/platform/guardrails/tier1-evaluator.ts`             | Tier 1 local CEL evaluator                                                |
| `packages/compiler/src/platform/guardrails/tier2-evaluator.ts`             | Tier 2 model-based evaluator with provider registry dispatch              |
| `packages/compiler/src/platform/guardrails/tier3-evaluator.ts`             | Tier 3 LLM-based evaluator with injected LLM function                     |
| `packages/compiler/src/platform/guardrails/provider.ts`                    | GuardrailModelProvider interface and GuardrailProviderRegistry            |
| `packages/compiler/src/platform/guardrails/provider-registry.ts`           | Named provider registry with register/get/unregister                      |
| `packages/compiler/src/platform/guardrails/providers/builtin-pii.ts`       | Built-in PII detection provider                                           |
| `packages/compiler/src/platform/guardrails/providers/openai-moderation.ts` | OpenAI Moderation API provider                                            |
| `packages/compiler/src/platform/guardrails/providers/openai-compatible.ts` | Generic OpenAI-compatible provider                                        |
| `packages/compiler/src/platform/guardrails/providers/custom-http.ts`       | Custom HTTP endpoint provider with SSRF protection                        |
| `packages/compiler/src/platform/guardrails/action-applier.ts`              | Action application logic (block, warn, redact, fix, reask, filter)        |
| `packages/compiler/src/platform/guardrails/action-executors.ts`            | Fix strategies, redaction, filtering executors                            |
| `packages/compiler/src/platform/guardrails/circuit-breaker.ts`             | Per-provider circuit breaker (CLOSED/OPEN/HALF_OPEN)                      |
| `packages/compiler/src/platform/guardrails/result-aggregator.ts`           | Result aggregation across tiers                                           |
| `packages/compiler/src/platform/guardrails/messages.ts`                    | Default violation messages and i18n integration                           |
| `packages/compiler/src/platform/guardrails/constants.ts`                   | Action precedence and constants                                           |
| `packages/compiler/src/platform/guardrails/builtin-templates.ts`           | Built-in guardrail templates (content_safety, pii, topic, etc.)           |
| `apps/runtime/src/services/guardrails/pipeline-factory.ts`                 | Central factory; tenant-scoped registries, provider loading, LLM adapter  |
| `apps/runtime/src/services/guardrails/policy-resolver.ts`                  | 4-layer policy merge (platform -> tenant -> project -> agent DSL)         |
| `apps/runtime/src/services/guardrails/streaming-evaluator.ts`              | Streaming evaluation with sentence-boundary chunking                      |
| `apps/runtime/src/services/guardrails/cache.ts`                            | Redis-backed cache with tier-specific TTLs                                |
| `apps/runtime/src/services/guardrails/cost-tracker.ts`                     | Microdollar cost tracking with monthly budgets                            |
| `apps/runtime/src/services/guardrails/port-adapters.ts`                    | Adapters bridging compiler ports to runtime implementations               |
| `apps/runtime/src/services/guardrails/webhook.ts`                          | HMAC-SHA256 signed webhook delivery with retry                            |
| `apps/runtime/src/services/guardrails/trace-events.ts`                     | 15 trace event factory functions                                          |

### Routes / Handlers

| File                                                           | Purpose                                    |
| -------------------------------------------------------------- | ------------------------------------------ |
| `apps/runtime/src/routes/guardrail-policies.ts`                | CRUD + activate for guardrail policies     |
| `apps/runtime/src/routes/guardrail-providers.ts`               | CRUD + test for guardrail provider configs |
| `apps/studio/src/app/api/admin/guardrail-providers/route.ts`   | Studio proxy for provider management       |
| `apps/studio/src/app/api/admin/guardrail-policies/route.ts`    | Studio proxy for policy management         |
| `apps/studio/src/app/api/compiler/builtin-guardrails/route.ts` | Built-in guardrail template listing        |

### UI Components

| File                                                                    | Purpose                                |
| ----------------------------------------------------------------------- | -------------------------------------- |
| `apps/studio/src/components/guardrails/GuardrailsConfigPage.tsx`        | 3-tab page: Policies, Providers, Audit |
| `apps/studio/src/components/guardrails/GuardrailPolicyForm.tsx`         | Policy creation/edit dialog            |
| `apps/studio/src/components/guardrails/RuleCard.tsx`                    | Individual rule configuration card     |
| `apps/studio/src/components/guardrails/SeveritySelector.tsx`            | Severity level selector component      |
| `apps/studio/src/components/guardrails/GuardrailYamlEditor.tsx`         | YAML editor for policy rules           |
| `apps/studio/src/components/admin/GuardrailProviderForm.tsx`            | Provider registration form             |
| `apps/studio/src/components/admin/GuardrailsPage.tsx`                   | Admin-level guardrails page            |
| `apps/studio/src/components/agent-editor/sections/GuardrailsEditor.tsx` | Inline agent guardrail editor          |
| `apps/studio/src/components/abl/pickers/GuardrailPickerModal.tsx`       | Guardrail picker for DSL editor        |
| `apps/studio/src/hooks/useGuardrails.ts`                                | SWR hooks for policies and providers   |

### Jobs / Workers / Background Processes

| File                                              | Purpose                                                              |
| ------------------------------------------------- | -------------------------------------------------------------------- |
| `apps/runtime/src/services/guardrails/webhook.ts` | Async webhook delivery with retry (fire-and-forget via port adapter) |

### Tests

| File                                                                                     | Type        | Coverage Focus                                                |
| ---------------------------------------------------------------------------------------- | ----------- | ------------------------------------------------------------- |
| `apps/runtime/src/__tests__/guardrails/pipeline-factory.test.ts`                         | unit        | Factory creation, provider loading, fingerprint detection     |
| `apps/runtime/src/services/guardrails/__tests__/pipeline-factory-llmeval.test.ts`        | unit        | LLM eval adapter, validation/response_gen fallback            |
| `apps/runtime/src/services/guardrails/__tests__/pipeline-factory-ports.test.ts`          | unit        | Cache + cost checker port auto-wiring                         |
| `apps/runtime/src/__tests__/guardrails/pipeline-factory-policy.test.ts`                  | unit        | DB policy loading, toPipelinePolicy conversion                |
| `apps/runtime/src/__tests__/guardrails/policy-resolver.test.ts`                          | unit        | 4-layer merge, settings merge, disable/threshold/action rules |
| `apps/runtime/src/services/guardrails/__tests__/policy-resolver.test.ts`                 | unit        | Define-mode synthetic guardrails, DSL priority                |
| `apps/runtime/src/__tests__/guardrails/policy-define-rules.test.ts`                      | unit        | Synthetic guardrail creation from define rules                |
| `apps/runtime/src/__tests__/guardrails/streaming-evaluator.test.ts`                      | unit        | Sentence boundary, chunk mode, early termination              |
| `apps/runtime/src/__tests__/guardrails/cache.test.ts`                                    | unit        | Key building, tier TTLs, fail-open on Redis error             |
| `apps/runtime/src/services/guardrails/__tests__/cache-invalidation.test.ts`              | unit        | Per-guardrail and tenant-wide cache invalidation              |
| `apps/runtime/src/__tests__/guardrails/cost-tracker.test.ts`                             | unit        | Microdollar conversion, budget check, monthly key TTL         |
| `apps/runtime/src/services/guardrails/__tests__/port-adapters.test.ts`                   | unit        | CacheAdapter, CostCheckerAdapter, WebhookAdapter              |
| `apps/runtime/src/__tests__/guardrails/webhook.test.ts`                                  | unit        | HMAC signing, retry logic, SSRF validation                    |
| `apps/runtime/src/__tests__/guardrails/trace-events.test.ts`                             | unit        | All 15 trace event factory functions                          |
| `apps/runtime/src/__tests__/guardrails/output-guardrails.test.ts`                        | integration | Output validation in reasoning executor                       |
| `apps/runtime/src/__tests__/guardrails/tool-rails.test.ts`                               | integration | Tool call screening and tool output filtering                 |
| `apps/runtime/src/__tests__/guardrails/handoff-rails.test.ts`                            | integration | Handoff blocking with cross-agent evaluation                  |
| `apps/runtime/src/__tests__/guardrails/session-policy-inheritance.test.ts`               | integration | Session-level policy scope resolution                         |
| `apps/runtime/src/__tests__/guardrails/runtime-integration.test.ts`                      | integration | Runtime-level guardrail integration                           |
| `apps/runtime/src/__tests__/guardrails/policy-routes.test.ts`                            | integration | Policy CRUD route handlers                                    |
| `apps/runtime/src/__tests__/guardrails/provider-routes.test.ts`                          | integration | Provider CRUD route handlers                                  |
| `packages/compiler/src/__tests__/guardrails/pipeline.test.ts`                            | unit        | Pipeline orchestration, tier ordering                         |
| `packages/compiler/src/__tests__/guardrails/tier1-evaluator.test.ts`                     | unit        | CEL evaluation, fail modes, priority sorting                  |
| `packages/compiler/src/__tests__/guardrails/tier2-evaluator.test.ts`                     | unit        | Provider dispatch, threshold, severity mapping                |
| `packages/compiler/src/__tests__/guardrails/tier3-evaluator.test.ts`                     | unit        | LLM injection, prompt building, response parsing              |
| `packages/compiler/src/__tests__/guardrails/guardrail-validator.test.ts`                 | unit        | Action-kind compatibility matrix                              |
| `packages/compiler/src/__tests__/guardrails/circuit-breaker.test.ts`                     | unit        | CLOSED/OPEN/HALF_OPEN state transitions                       |
| `packages/compiler/src/__tests__/guardrails/action-executors.test.ts`                    | unit        | Fix strategies, redaction, filtering                          |
| `packages/compiler/src/__tests__/guardrails/action-applier.test.ts`                      | unit        | Action application logic                                      |
| `packages/compiler/src/__tests__/guardrails/result-aggregator.test.ts`                   | unit        | Multi-tier result aggregation                                 |
| `packages/compiler/src/__tests__/guardrails/guardrails-e2e.test.ts`                      | e2e         | Compiler-level end-to-end guardrail flow                      |
| `packages/compiler/src/__tests__/guardrails/multi-tier-cascade-e2e.test.ts`              | e2e         | Multi-tier cascade (Tier 1->2->3) evaluation                  |
| `packages/compiler/src/__tests__/guardrails/providers/builtin-pii.test.ts`               | unit        | Built-in PII detection provider                               |
| `packages/compiler/src/__tests__/guardrails/providers/builtin-pii-e2e.test.ts`           | e2e         | PII provider end-to-end                                       |
| `packages/compiler/src/__tests__/guardrails/providers/openai-moderation.test.ts`         | unit        | OpenAI Moderation provider                                    |
| `packages/compiler/src/__tests__/guardrails/providers/openai-moderation-e2e.test.ts`     | e2e         | OpenAI Moderation provider end-to-end                         |
| `packages/compiler/src/__tests__/guardrails/providers/openai-compatible.test.ts`         | unit        | OpenAI-compatible generic provider                            |
| `packages/compiler/src/__tests__/guardrails/providers/custom-http.test.ts`               | unit        | Custom HTTP provider                                          |
| `packages/compiler/src/__tests__/guardrails/custom-http-e2e.test.ts`                     | e2e         | Custom HTTP provider end-to-end                               |
| `packages/compiler/src/__tests__/guardrails/custom-http-ssrf.test.ts`                    | unit        | SSRF URL validation (15 cases)                                |
| `packages/compiler/src/platform/guardrails/providers/__tests__/custom-http-ssrf.test.ts` | unit        | Additional SSRF tests                                         |
| `apps/runtime/src/__tests__/streaming-guardrails-wiring.test.ts`                         | integration | Streaming buffer accumulation and chunk handling              |
| `apps/runtime/src/__tests__/streaming-guardrails-pipeline.test.ts`                       | integration | Streaming pipeline wiring                                     |
| `apps/runtime/src/__tests__/streaming-guardrails-policy.test.ts`                         | integration | Streaming with policy forwarding                              |
| `apps/runtime/src/__tests__/streaming-guardrails-model-tier.test.ts`                     | integration | Streaming with model-tier evaluators                          |
| `apps/runtime/src/__tests__/guardrail-pipeline-expanded.test.ts`                         | integration | Expanded pipeline factory + registry tests                    |
| `apps/runtime/src/__tests__/guardrail-policy-hierarchy.test.ts`                          | integration | Policy hierarchy resolution                                   |
| `apps/runtime/src/__tests__/guardrail-edge-cases.e2e.test.ts`                            | e2e         | Edge cases and error scenarios                                |
| `apps/runtime/src/__tests__/severity-actions-policy.test.ts`                             | integration | Severity-based action selection in policies                   |
| `apps/studio/e2e/guardrails-comprehensive-e2e.spec.ts`                                   | e2e         | Playwright E2E for Studio UI policy/provider CRUD             |
| `apps/studio/e2e/model-guardrails-e2e.spec.ts`                                           | e2e         | Playwright E2E for model-tier guardrails in Studio            |
| `apps/studio/src/__tests__/admin-guardrail-providers-route.test.ts`                      | unit        | Studio admin guardrail providers proxy route                  |
| `apps/runtime/src/services/execution/__tests__/flow-tool-guardrails.test.ts`             | integration | Tool guardrails in flow execution context                     |
| `apps/runtime/src/services/execution/__tests__/reasoning-guardrail-ordering.test.ts`     | unit        | Guardrail ordering in reasoning executor                      |
| `apps/runtime/src/services/execution/__tests__/tool-guardrail-llmeval.test.ts`           | unit        | Tool guardrail with LLM evaluation                            |
| `apps/runtime/src/services/execution/__tests__/flow-guardrail-actions.test.ts`           | unit        | Guardrail action handling in flow execution                   |
| `apps/runtime/src/services/execution/__tests__/handoff-guardrail-llmeval.test.ts`        | unit        | Handoff guardrail with LLM evaluation                         |
| `apps/runtime/src/services/execution/__tests__/output-guardrails.test.ts`                | unit        | Output guardrails in execution service                        |
| `apps/runtime/src/__tests__/post-guardrail-revalidation.test.ts`                         | integration | Post-guardrail revalidation flow                              |

---

## 11. Configuration

### Environment Variables

| Variable                        | Default | Description                                       |
| ------------------------------- | ------- | ------------------------------------------------- |
| `GUARDRAILS_ENABLED`            | `true`  | Feature gate for guardrails evaluation            |
| `GUARDRAILS_CACHE_ENABLED`      | `true`  | Enable/disable Redis cache for evaluation results |
| `GUARDRAILS_DEFAULT_TIMEOUT_MS` | `5000`  | Default per-guardrail evaluation timeout          |
| `GUARDRAILS_MAX_PROVIDERS`      | `200`   | Maximum provider registrations per tenant         |

### Runtime Configuration

- **Feature gate**: `guardrails` feature flag must be enabled (TEAM tier or above) via `requireFeature('guardrails')` middleware.
- **Policy settings**: Per-policy `failMode` (open/closed), `timeouts` (local/model/llm), `streaming` (enabled, interval, chunkSize, maxLatencyMs, earlyTermination).
- **Provider circuit breaker**: Per-provider `failureThreshold` (default 5), `resetTimeoutMs` (default 30000ms), `failMode` (open/closed).
- **Budget controls**: Per-policy `monthlyLimitUsd` with `overspendAction` (downgrade/disable_model_checks/alert_only).
- **Cache settings**: Per-policy `caching.enabled`, `exactMatch`, `semanticMatch` (not implemented), `defaultTtlSeconds`.

### DSL / Agent IR / Schema

```yaml
GUARDRAILS:
  - name: content-safety
    kind: output
    provider: openai-moderation
    threshold: 0.8
    action: block
    severity: critical
  - name: pii-redaction
    kind: input
    check: 'has_pii(input)'
    action: redact
  - name: topic-relevance
    kind: input
    provider: llm
    constitution:
      - 'Only respond to topics related to customer support'
    action: reask
```

Compiles to IR `Guardrail[]` in AgentIR with fields: `name`, `description`, `kind`, `priority`, `tier`, `check`, `llmCheck`, `provider`, `category`, `threshold`, `action` (type + params), `severityActions`.

---

## 12. Non-Functional Concerns

### Isolation & Multitenancy

| Concern           | Requirement / Expectation                                                                                                                                                         |
| ----------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Project isolation | Policies are project-scoped via `scope.projectId`. Cache keys include `projectId`. Cross-project access returns 404.                                                              |
| Tenant isolation  | Providers are tenant-scoped via `tenantId`. Cache keys include `tenantId`. Provider registries are per-tenant. Cross-tenant returns 404. Both models use `tenantIsolationPlugin`. |
| User isolation    | N/A -- guardrails operate on content, not user-owned resources. Policy mutations require `guardrails:manage` permission.                                                          |

### Security & Compliance

- Provider API keys are stored as encrypted credentials (via auth profiles or credential store), never in plaintext in the provider config.
- Webhook URLs are validated against SSRF allowlists via `assertUrlSafeForSSRF` from `@agent-platform/shared-kernel/security`.
- Webhook payloads are signed with HMAC-SHA256 using per-webhook secrets.
- All guardrail evaluations are logged via 15 trace event types for audit purposes.
- Policy mutations (create/update/delete/activate) trigger cache invalidation via `invalidateTenantProviderCache()` and `invalidateGuardrailEvalCache()`.
- Routes protected by `authMiddleware`, `tenantRateLimit`, `requireFeature('guardrails')`, and `requirePermission`.

### Performance & Scalability

- **Tier 1 (local)**: < 5ms evaluation latency. No network calls. CEL expressions compiled once and cached.
- **Tier 2 (model)**: < 500ms evaluation latency. 1h cache TTL reduces redundant calls.
- **Tier 3 (LLM)**: < 5s evaluation latency. No caching (content too variable).
- **Provider registry**: Max 200 entries per tenant with LRU eviction. 5-minute refresh interval. Config fingerprinting avoids unnecessary reloads.
- **Cost tracking**: Redis INCRBY is O(1). Monthly keys auto-expire after 35 days.
- **Streaming**: Sentence-boundary chunking minimizes redundant evaluations while catching violations mid-stream.
- **Early termination**: Terminal violations in lower tiers skip expensive higher-tier evaluations.

### Reliability & Failure Modes

- **Fail-open default**: Evaluation errors do not block content delivery. Configurable per-policy to fail-closed.
- **Circuit breaker**: Per-provider circuit breaker prevents cascading failures. States: CLOSED -> OPEN -> HALF_OPEN.
- **Webhook retry**: Exponential backoff (1s, 4s, 16s) with jitter. Non-retryable: 4xx except 429. Max 3 retries. 10s timeout per attempt.
- **Provider fallback**: LLM tier falls back from `validation` to `response_gen` model tier.
- **Cache failure**: Cache errors are caught and logged; evaluation proceeds without cache (fail-open).
- **Cost tracker failure**: Redis errors return 0 spend; evaluation continues without cost tracking.

### Observability

15 trace event types covering the full pipeline lifecycle:

| Event Type                      | Description                           |
| ------------------------------- | ------------------------------------- |
| `guardrail_check`               | Individual check result (pass/fail)   |
| `guardrail_violation`           | Check failed, action triggered        |
| `guardrail_warning`             | Non-blocking concern raised           |
| `guardrail_fix`                 | Content auto-modified to pass         |
| `guardrail_reask`               | LLM asked to retry                    |
| `guardrail_pipeline_complete`   | Pipeline run summary                  |
| `guardrail_cost`                | Cost and budget status                |
| `guardrail_circuit_breaker`     | Provider circuit breaker state change |
| `guardrail_cache_hit`           | Result served from cache              |
| `guardrail_cache_miss`          | Cache miss, will evaluate             |
| `guardrail_provider_error`      | Provider failed to respond            |
| `guardrail_tool_blocked`        | Tool call blocked by guardrail        |
| `guardrail_tool_output_blocked` | Tool output blocked by guardrail      |
| `guardrail_handoff_blocked`     | Agent handoff blocked by guardrail    |
| `guardrail_pipeline_error`      | Pipeline-level failure                |

### Data Lifecycle

- **Cache entries**: TTLs per tier (local: 24h, model: 1h, LLM: never cached).
- **Cost tracking keys**: Monthly keys with 35-day TTL auto-expire.
- **Policy changelog**: Retained indefinitely as part of the policy document.
- **Provider configs**: No automatic expiry; manually managed by tenant admins.
- **Trace events**: Governed by session trace retention policy.
- **Policy versions**: `previousVersionId` enables version chain traversal. No automatic cleanup.

---

## 13. Delivery Plan / Work Breakdown

1. **Core Pipeline**
   1.1 Tier 1 local evaluators (CEL, regex, built-in PII) -- DONE
   1.2 Tier 2 model evaluators (OpenAI Moderation, custom HTTP) -- DONE
   1.3 Tier 3 LLM evaluators (constitution, topic, grounding) -- DONE
   1.4 Pipeline factory with tenant-scoped registries -- DONE
   1.5 Action applier and executors (block, warn, redact, fix, filter) -- DONE
   1.6 Result aggregation across tiers -- DONE
2. **Policy System**
   2.1 Policy model and CRUD routes -- DONE
   2.2 4-level policy resolution chain -- DONE
   2.3 Policy activation workflow -- DONE
   2.4 Define-mode rule support (synthetic guardrails from DB) -- DONE
3. **Infrastructure**
   3.1 Redis-backed cache with tier TTLs -- DONE
   3.2 Cost tracker with microdollar budgets -- DONE
   3.3 Circuit breaker per provider -- DONE
   3.4 Webhook delivery with HMAC signing -- DONE
   3.5 Port adapter pattern (compiler ports to runtime) -- DONE
4. **Streaming**
   4.1 Streaming evaluator with sentence-boundary chunking -- DONE
   4.2 Early termination on terminal violations -- DONE
5. **Observability**
   5.1 15 trace event factory functions -- DONE
   5.2 Pipeline completion summaries -- DONE
6. **Studio UI**
   6.1 GuardrailsConfigPage with 3 tabs -- DONE
   6.2 GuardrailPolicyForm with rule cards and YAML editor -- DONE
   6.3 GuardrailProviderForm for provider registration -- DONE
   6.4 GuardrailsEditor for inline agent-level guardrails -- DONE
   6.5 GuardrailPickerModal for DSL editor -- DONE
   6.6 Audit tab (evaluation history, violations) -- STUB (not fully implemented)
7. **Test Coverage Gaps** (remaining work)
   7.1 Provider x kind E2E matrix coverage
   7.2 Runtime-level multi-tier cascade E2E tests
   7.3 Streaming + real model provider E2E tests
   7.4 Policy scoping hierarchy E2E tests
   7.5 Reask and escalate actions E2E tests
8. **Provider Expansion** (remaining work)
   8.1 Implement remaining adapter types (11 of 15 are stubs)

---

## 14. Success Metrics

| Metric                      | Baseline | Target  | How Measured                                  |
| --------------------------- | -------- | ------- | --------------------------------------------- |
| Evaluation latency (Tier 1) | N/A      | < 5ms   | P99 from `guardrail_check` trace events       |
| Evaluation latency (Tier 2) | N/A      | < 500ms | P99 from `guardrail_check` trace events       |
| Evaluation latency (Tier 3) | N/A      | < 5s    | P99 from `guardrail_check` trace events       |
| Cache hit rate              | N/A      | > 60%   | `guardrail_cache_hit` / total evaluations     |
| Policy coverage             | 0%       | 100%    | Agents with at least one active policy        |
| False positive rate         | N/A      | < 5%    | Manual review of `guardrail_violation` events |
| Provider uptime             | N/A      | > 99.5% | Circuit breaker state change events           |
| E2E test coverage           | ~16%     | > 80%   | Provider x kind matrix coverage               |

---

## 15. Open Questions

1. Should guardrail policies support cross-tenant sharing (e.g., platform-managed global policies)?
2. Should the cost tracker support per-project budgets in addition to per-tenant (current key includes projectId but budget is per-policy)?
3. Should image/audio content moderation be added to the pipeline (currently text-only)?
4. When should the remaining 11 unimplemented adapter types be prioritized vs removed from the DB enum?
5. Should the Audit tab in Studio UI be a full implementation or delegate to Observatory trace viewer?

---

## 16. Gaps, Known Issues & Limitations

| ID      | Description                                                                                 | Severity | Status |
| ------- | ------------------------------------------------------------------------------------------- | -------- | ------ |
| GAP-001 | 11 adapter types in DB enum have no runtime implementation                                  | Medium   | Open   |
| GAP-002 | No E2E tests for provider x kind matrix (147/175 untested at audit)                         | High     | Open   |
| GAP-003 | Multi-tier cascade (Tier 1->2->3) E2E only at compiler level, not runtime HTTP API          | High     | Open   |
| GAP-004 | Reask and escalate actions only unit-tested, not exercised via API                          | Medium   | Open   |
| GAP-005 | Policy scoping hierarchy (tenant->project->agent) not tested via API                        | Medium   | Open   |
| GAP-006 | Semantic similarity caching defined in schema but not implemented                           | Low      | Open   |
| GAP-007 | Audit tab in Studio UI is a stub -- no real evaluation history viewer                       | Medium   | Open   |
| GAP-008 | `authProfileId` on provider config is reserved but not wired to runtime consumer            | Low      | Open   |
| GAP-009 | `settings.timeouts` and `settings.webhookUrl` in PolicyResolver are deprecated/not consumed | Low      | Open   |
| GAP-010 | Streaming with real model-tier providers never tested E2E                                   | High     | Open   |

---

## 17. Testing & Validation

### Required Test Coverage

| #   | Scenario                              | Coverage Type | Status     | Test File / Note                                                       |
| --- | ------------------------------------- | ------------- | ---------- | ---------------------------------------------------------------------- |
| 1   | Pipeline factory creation             | unit          | PASS       | `pipeline-factory.test.ts`                                             |
| 2   | LLM eval adapter + fallback           | unit          | PASS       | `pipeline-factory-llmeval.test.ts`                                     |
| 3   | Port adapter auto-wiring              | unit          | PASS       | `pipeline-factory-ports.test.ts`, `port-adapters.test.ts`              |
| 4   | Policy resolver 4-layer merge         | unit          | PASS       | `policy-resolver.test.ts` (both locations)                             |
| 5   | Define-mode synthetic guardrails      | unit          | PASS       | `policy-define-rules.test.ts`                                          |
| 6   | Streaming evaluator                   | unit          | PASS       | `streaming-evaluator.test.ts`                                          |
| 7   | Cache hit/miss/invalidation           | unit          | PASS       | `cache.test.ts`, `cache-invalidation.test.ts`                          |
| 8   | Cost tracker budgets                  | unit          | PASS       | `cost-tracker.test.ts`                                                 |
| 9   | Webhook HMAC signing + retry          | unit          | PASS       | `webhook.test.ts`                                                      |
| 10  | Trace events (15 types)               | unit          | PASS       | `trace-events.test.ts`                                                 |
| 11  | Output guardrails in reasoning        | integration   | PASS       | `output-guardrails.test.ts`                                            |
| 12  | Tool call/output guardrails           | integration   | PASS       | `tool-rails.test.ts`                                                   |
| 13  | Handoff guardrails                    | integration   | PASS       | `handoff-rails.test.ts`                                                |
| 14  | Session policy inheritance            | integration   | PASS       | `session-policy-inheritance.test.ts`                                   |
| 15  | Policy + provider CRUD routes         | integration   | PASS       | `policy-routes.test.ts`, `provider-routes.test.ts`                     |
| 16  | Compiler guardrail validator          | unit          | PASS       | `guardrail-validator.test.ts`                                          |
| 17  | Multi-tier cascade (compiler)         | e2e           | PASS       | `multi-tier-cascade-e2e.test.ts`                                       |
| 18  | Studio UI E2E                         | e2e           | PASS       | `guardrails-comprehensive-e2e.spec.ts`, `model-guardrails-e2e.spec.ts` |
| 19  | Studio admin provider route           | unit          | PASS       | `admin-guardrail-providers-route.test.ts`                              |
| 20  | Flow tool guardrails                  | integration   | PASS       | `flow-tool-guardrails.test.ts`                                         |
| 21  | Reasoning guardrail ordering          | unit          | PASS       | `reasoning-guardrail-ordering.test.ts`                                 |
| 22  | Tool guardrail LLM eval               | unit          | PASS       | `tool-guardrail-llmeval.test.ts`                                       |
| 23  | Provider x kind E2E (runtime)         | e2e           | NOT TESTED | 147/175 combinations untested                                          |
| 24  | Multi-tier cascade E2E (runtime HTTP) | e2e           | NOT TESTED | Tier 1->2->3 via real HTTP API                                         |
| 25  | Streaming + model provider            | e2e           | NOT TESTED | Real provider in streaming path                                        |
| 26  | Policy scoping via API                | e2e           | NOT TESTED | Tenant->project->agent override chain                                  |
| 27  | Reask + escalate via API              | e2e           | NOT TESTED | Full action lifecycle through HTTP                                     |

### Testing Notes

Unit test coverage is comprehensive for individual components (factory, resolver, cache, cost tracker, streaming evaluator, webhook, trace events, port adapters, circuit breaker, action applier/executors). Integration tests cover output guardrails, tool guardrails (including flow-level tool guardrails), handoff guardrails, session policy inheritance, CRUD routes, and reasoning guardrail ordering. Studio route proxy tests cover admin guardrail provider routes. Compiler-level E2E tests cover multi-tier cascade and individual provider flows. The primary gaps are runtime-level E2E: provider-kind combinations via HTTP API, multi-tier cascading through the full Express middleware chain, and streaming with real providers.

> Full testing details: `../testing/guardrails.md`

---

## 18. References

- Design docs: `docs/specs/guardrails.hld.md`, `docs/plans/guardrails.lld.md`
- Audit: `docs/audit/guardrails-coverage-matrix-2026-03-09.md`
- Compiler guardrail types: `packages/compiler/src/platform/guardrails/`
- Compiler IR schema: `packages/compiler/src/platform/ir/schema.ts` (GuardrailKind, GuardrailTier, Guardrail interface)
- Guardrail adapter constants: `packages/database/src/constants/guardrail-adapters.ts`
- Related feature docs: [PII Detection](./pii-detection.md), [Auth Profiles](./auth-profiles.md), [Tracing & Observability](./tracing-observability.md), [Model Hub](./model-hub.md)

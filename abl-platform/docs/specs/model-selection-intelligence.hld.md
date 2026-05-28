# HLD: Model Selection Intelligence

**Feature Spec**: `docs/features/model-selection-intelligence.md`
**Test Spec**: `docs/testing/model-selection-intelligence.md`
**Status**: APPROVED
**Author**: Sri Harsha
**Date**: 2026-04-05

---

## 1. Problem Statement

Arch assigns models using a static 4-model short-list that ignores tenant provisioning, compliance requirements, capability matching, fallback chains, and cost. Users overspend on simple agents or underperform on complex ones. The existing `getModelRecommendation()` helper at `apps/studio/src/lib/arch-ai/helpers/get-model-recommendation.ts` uses hardcoded switch-case logic that doesn't consult the platform's 147+ model `MODEL_REGISTRY`.

---

## 2. Alternatives Considered

### Option A: Enhance existing helper in-place

- **Description**: Refactor `getModelRecommendation()` to use `MODEL_REGISTRY` for scoring, add tenant filtering and fallback chain logic. Keep it as a server-side helper called during agent generation. Add a specialist-visible tool wrapping the same logic for IN_PROJECT.
- **Pros**: Minimal blast radius — same file, same callers, same function signature. No new services. Existing tests and callers unaffected.
- **Cons**: Growing complexity in a single helper. May need extraction later if logic exceeds ~300 LOC.
- **Effort**: S

### Option B: New recommendation microservice

- **Description**: Extract model recommendation into a standalone API endpoint (`/api/model-recommendation`) that both BUILD and IN_PROJECT call via HTTP.
- **Pros**: Clean separation. Reusable across surfaces (CLI, MCP). Independently scalable.
- **Cons**: Adds a network hop to every agent generation. Over-engineering for a design-time feature with sub-millisecond computation. Introduces a new service to deploy/monitor.
- **Effort**: L

### Option C: LLM-driven recommendation (no code logic)

- **Description**: Give the specialist LLM access to the full model registry as context and let it reason about model selection in the prompt.
- **Pros**: Most flexible — handles edge cases via reasoning. No deterministic logic to maintain.
- **Cons**: Non-deterministic — same agent profile may get different recommendations. Expensive (30K+ tokens for registry). Can't enforce tenant policy filtering reliably. Hallucination risk on pricing.
- **Effort**: M

### Recommendation: Option A (Enhance existing helper)

**Rationale**: Model recommendation is a deterministic scoring problem — tenant filtering, capability matching, and cost comparison don't benefit from LLM reasoning. The existing helper's signature is already correct (input: agent profile, output: `ModelRecommendation`). Enhancement is additive. If complexity grows, extraction to a separate module (not microservice) is trivial later.

---

## 3. Architecture

### System Context Diagram

```
┌──────────────────────────────────────────────────────────┐
│                     Studio (Next.js)                      │
│                                                           │
│  ┌─────────────────┐     ┌───────────────────────────┐   │
│  │  useArchChat     │────>│ POST /api/arch-ai/message │   │
│  │  (client hook)   │     │    (message route)        │   │
│  └─────────────────┘     └──────────┬────────────────┘   │
│                                      │                    │
│                           ┌──────────▼────────────────┐   │
│                           │ Specialist Executor        │   │
│                           │  ├── BUILD: auto-inject    │   │
│                           │  └── IN_PROJECT: tool call │   │
│                           └──────────┬────────────────┘   │
│                                      │                    │
│                           ┌──────────▼────────────────┐   │
│                           │ getModelRecommendation()   │   │
│                           │  ├── Score against REGISTRY│   │
│                           │  ├── Filter by tenant      │   │
│                           │  ├── Match capabilities    │   │
│                           │  ├── Build fallback chain  │   │
│                           │  └── Compute cost delta    │   │
│                           └──────────┬────────────────┘   │
│                                      │                    │
│              ┌───────────────────────┼──────────────┐     │
│              ▼                       ▼              ▼     │
│  ┌──────────────────┐  ┌──────────────────┐  ┌────────┐ │
│  │ MODEL_REGISTRY   │  │ Tenant Models    │  │Journal │ │
│  │ (compiler, static│  │ (runtime API or  │  │(Mongo) │ │
│  │  147+ models)    │  │  session cache)  │  └────────┘ │
│  └──────────────────┘  └──────────────────┘              │
└──────────────────────────────────────────────────────────┘
```

### Component Diagram

```
get-model-recommendation.ts (ENHANCED)
├── analyzeComplexity(agent) → 'simple' | 'moderate' | 'complex'
├── matchCapabilities(agent, registry) → Model[]
├── filterByTenantPolicy(models, tenantModels, llmPolicy) → Model[]
├── filterByCompliance(models, constraints) → Model[]
├── scoreCandidates(models, complexityTier) → ScoredModel[]
├── selectPrimaryAndFallback(scored) → { primary, fallback }
├── computeCostComparison(primary, alternatives) → CostComparison
└── buildRecommendation(...) → ModelRecommendation

types.ts (ENHANCED)
├── ModelRecommendation { primary, fallback?, perOperation?, executionConfig, costComparison }
└── ScoredModel { model, provider, score, capabilities, costTier, reasons }

recommend-model-tool.ts (NEW)
└── Specialist-visible tool wrapping getModelRecommendation() for IN_PROJECT

ModelComparisonWidget.tsx (NEW)
└── React component rendering 2-4 model comparison cards with Apply button
```

### Data Flow

**BUILD phase (automatic):**

1. `generateSingleAgent()` calls `getModelRecommendation()` with agent profile
2. Helper scores `MODEL_REGISTRY`, filters by tenant, builds fallback chain
3. Returns `ModelRecommendation` → injected into ABL EXECUTION section
4. Journal event `model_recommendation` persisted

**IN_PROJECT mode (on-demand):**

1. User asks "what model for billing_agent?"
2. Specialist LLM calls `recommend_model` tool with agent name
3. Tool reads agent profile from project, calls `getModelRecommendation()`
4. Returns structured comparison → rendered as `ModelComparisonWidget`
5. User clicks "Apply" → triggers IP-F01 agent modification flow

---

## 4. The 12 Architectural Concerns

### Structural Concerns

| #   | Concern                 | Design Decision                                                                                                                                                                                                                                                                   |
| --- | ----------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 1   | **Tenant Isolation**    | Recommendations filter by `tenantModels` (fetched per-session, cached). A tenant never sees another tenant's provisioned models. Tenant LLM policy (`allowedProviders`, `tokenBudgets`) enforced server-side before candidates are returned.                                      |
| 2   | **Data Access Pattern** | No new data access. `MODEL_REGISTRY` is a static in-memory import from `@abl/compiler/platform/llm/model-registry`. Tenant models cached in session metadata (fetched once at session creation via runtime API). No direct DB queries in the recommendation helper.               |
| 3   | **API Contract**        | No new API endpoints. `MessageRequest` gains optional `pageContext` (separate feature). `recommend_model` tool follows existing tool schema: `{ name: 'recommend_model', input: { agentName: string }, output: ModelRecommendation }`. Response uses standard SSE event protocol. |
| 4   | **Security Surface**    | No credentials in recommendation output — only model names, providers, cost tiers. `recommend_model` tool validates `agentName` against project agents (prevent IDOR). Tenant policy enforcement is server-side (client cannot bypass).                                           |

### Behavioral Concerns

| #   | Concern           | Design Decision                                                                                                                                                                                                                                             |
| --- | ----------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 5   | **Error Model**   | If recommendation fails (registry import error, tenant fetch failure): fall back to existing static short-list. Never block agent generation. Recommendation is advisory — errors logged, not surfaced as user-facing errors.                               |
| 6   | **Failure Modes** | Registry import failure: use static fallback. Tenant model fetch timeout: use full registry with `tenantFilterUnavailable` flag. No models match all constraints: relax cost preference (keep capability + compliance), explain the trade-off in reasoning. |
| 7   | **Idempotency**   | Same agent profile + same tenant config → same recommendation. Deterministic scoring (no randomness). Safe to retry.                                                                                                                                        |
| 8   | **Observability** | Journal event `model_recommendation` persists full recommendation payload. `createLogger('arch-ai:model-recommendation')` for debug traces. Activity feed shows model selection during BUILD.                                                               |

### Operational Concerns

| #   | Concern                | Design Decision                                                                                                                                                                                                                                                                                                                                 |
| --- | ---------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 9   | **Performance Budget** | Single recommendation: <100ms (in-memory scoring, no I/O). Topology-wide (10 agents): <500ms. Registry scan of 147 models is O(N) ≈ sub-ms. Token budget for recommendation output: ~500 tokens per 4 candidates.                                                                                                                               |
| 10  | **Migration Path**     | In-place enhancement of `getModelRecommendation()`. Function signature stays compatible — existing callers (`generateSingleAgent`) unaffected. New `recommend_model` tool registered alongside existing IN_PROJECT tools. No data migration.                                                                                                    |
| 11  | **Rollback Plan**      | Revert to static short-list by setting `arch.modelRecommendation.enabled = false`. Feature flag checked at the top of `getModelRecommendation()`. No data to roll back — recommendations are ephemeral session journal events.                                                                                                                  |
| 12  | **Test Strategy**      | Unit: scoring logic, capability matching, cost calculation (fast, deterministic). Integration: `getModelRecommendation()` + real `MODEL_REGISTRY` + tenant filtering. E2E: full Arch message flow via `POST /api/arch-ai/message` with auth, verifying journal events and SSE responses. No mocking of registry or recommendation logic in E2E. |

---

## 5. Data Model

### New Collections/Tables

None. `MODEL_REGISTRY` is a static TypeScript constant (no database).

### Modified Collections/Tables

**arch_sessions (existing)** — journal gains a new event type:

```
Journal event: model_recommendation
Fields:
  - type: 'model_recommendation'
  - agentName: string
  - recommendations: { primary: ScoredModel, fallback?: ScoredModel, alternatives: ScoredModel[] }
  - reasoning: string
  - costComparison: { relativeTo: string, savings: string }
  - timestamp: Date
```

This is an additive journal event — no schema migration needed.

### Key Relationships

- `MODEL_REGISTRY` (static) → source of model capabilities and pricing
- `tenant_models` (runtime) → filters available models per tenant
- `tenant_llm_policies` (runtime) → constrains allowed providers
- Session journal → stores recommendation events

---

## 6. API Design

### New Endpoints

None. Recommendation logic runs within the existing Arch AI message pipeline.

### Modified Endpoints

| Method | Path                   | Change        | Details                                                   |
| ------ | ---------------------- | ------------- | --------------------------------------------------------- |
| POST   | `/api/arch-ai/message` | Tool addition | New `recommend_model` tool registered for IN_PROJECT mode |

### Tool Schema

```typescript
{
  name: 'recommend_model',
  description: 'Recommend optimal LLM models for an agent based on complexity, capabilities, cost, and tenant policy',
  parameters: {
    agentName: z.string().min(1).describe('Agent name or "all" for topology-wide'),
    conversationVolume: z.number().optional().describe('Monthly conversations for absolute cost estimate'),
  },
  returns: {
    primary: { model: string, provider: string, reasoning: string, costTier: string },
    fallback: { model: string, provider: string, reasoning: string },
    alternatives: [{ model: string, provider: string, strengths: string[], weaknesses: string[], costTier: string }],
    costComparison: { relativeSavings: string, absoluteEstimate?: string },
    topologyConsistency?: { warnings: string[] },
  }
}
```

### Error Responses

| Code | Condition                       | Response                                                 |
| ---- | ------------------------------- | -------------------------------------------------------- |
| N/A  | Recommendation failure          | Graceful fallback to static list; no HTTP error surfaced |
| 404  | Agent name not found in project | `{ error: { code: 'AGENT_NOT_FOUND', message: '...' } }` |

---

## 7. Cross-Cutting Concerns

- **Audit Logging**: Journal event `model_recommendation` provides full audit trail per recommendation
- **Rate Limiting**: No separate rate limit — covered by existing Arch message rate limiting
- **Caching**: Tenant model list cached per-session (fetched once). `MODEL_REGISTRY` is already a static import.
- **Encryption**: No sensitive data in recommendations. Tenant model credentials never leave the runtime.

---

## 8. Dependencies

### Upstream (this feature depends on)

| Dependency                         | Type          | Risk                                                   |
| ---------------------------------- | ------------- | ------------------------------------------------------ |
| `MODEL_REGISTRY` (compiler)        | Static import | Low — stable, well-tested                              |
| Tenant model catalog (runtime API) | HTTP fetch    | Medium — network dependency; fallback to full registry |
| Tenant LLM policy (runtime API)    | HTTP fetch    | Medium — same as above                                 |
| Arch session + journal (MongoDB)   | Write         | Low — existing infrastructure                          |

### Downstream (depends on this feature)

| Consumer                        | Impact                                                      |
| ------------------------------- | ----------------------------------------------------------- |
| `generateSingleAgent()` (BUILD) | Enhanced model selection in generated ABL                   |
| IP-F01 (Agent Modification)     | "Apply" action from comparison widget triggers modification |
| B14 (Cost & Latency Estimator)  | Reuses cost comparison logic                                |

---

## 9. Open Questions & Decisions Needed

1. Should `fallback` field be added to ABL EXECUTION IR formally (compiler change) or stored as agent metadata?
2. How to refresh `MODEL_REGISTRY` pricing data? Currently compiled into the package — stale after model price changes.
3. Should topology-wide recommendation weight inter-agent provider consistency (less latency) over per-agent optimal cost?

---

## 10. References

- Feature spec: `docs/features/model-selection-intelligence.md`
- Test spec: `docs/testing/model-selection-intelligence.md`
- Existing helper: `apps/studio/src/lib/arch-ai/helpers/get-model-recommendation.ts`
- Model registry: `packages/compiler/src/platform/llm/model-registry.ts`
- Model capabilities: `packages/compiler/src/platform/llm/model-capabilities.ts`
- Staging pipeline design: `docs/superpowers/specs/2026-04-03-arch-specialist-enhancement-design.md`
- IP-F03 spec: `docs/arch/features/IP-F03-model-recommendation.md`

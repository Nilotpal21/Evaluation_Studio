# Feature: Model Selection Intelligence

**Doc Type**: MAJOR FEATURE
**Parent Feature**: N/A
**Status**: ALPHA
**Feature Area(s)**: `agent lifecycle`, `governance`, `customer experience`
**Package(s)**: `apps/studio`, `packages/compiler`
**Owner(s)**: `Platform team`
**Testing Guide**: [docs/testing/model-selection-intelligence.md](../testing/model-selection-intelligence.md)
**Last Updated**: 2026-04-05

---

## 1. Introduction / Overview

### Problem Statement

The ABL platform supports 147+ LLM models across 6 providers with dramatically different cost, latency, and capability profiles. When developers design multi-agent systems in Arch, they must choose a model for each agent — but they lack the cross-model knowledge to make informed decisions. A triage agent doing keyword routing doesn't need Claude Opus ($15/M tokens) — Haiku ($0.25/M) handles it fine. A complex reasoning agent with 5+ tools and multi-step FLOW needs a strong model, not a cheap one.

Today, Arch assigns models using a static helper (`getModelRecommendation()` in `apps/studio/src/lib/arch-ai/helpers/get-model-recommendation.ts`) that maps complexity tiers to a hardcoded short-list of 4 models. It doesn't consider tenant-provisioned models, compliance requirements, tool capability matching, fallback chains, or cost comparison. Users discover they're overspending — or underperforming — after deployment.

### Goal Statement

Add intelligence to Arch's model selection so that every agent gets the right model for its role, complexity, and constraints — with cost transparency, capability matching, fallback chain design, and tenant policy compliance. The recommendation should be automatic during BUILD and available on-demand in IN_PROJECT mode.

### Summary

Model Selection Intelligence enhances Arch's existing `getModelRecommendation()` helper from a static lookup into a context-aware recommendation engine. During BUILD, it automatically selects optimal models for each generated agent based on role analysis, tool requirements, compliance constraints, and tenant-provisioned model availability. In IN_PROJECT mode, it exposes a specialist-visible tool that developers can invoke to get comparison tables with cost/latency/capability trade-offs, apply model changes, and receive proactive upgrade suggestions.

The feature builds on existing infrastructure: the compiler's `MODEL_REGISTRY` (147+ models with capabilities and pricing), the `ModelCapabilities` type system, the model-capabilities REST API (`/api/model-capabilities`), and the runtime's `ModelResolutionService` 5-level resolution chain.

---

## 2. Scope

### Goals

- Enhance `getModelRecommendation()` to use the full `MODEL_REGISTRY` capabilities data instead of hardcoded model lists
- Filter recommendations by tenant-provisioned models and LLM policy constraints (provider allowlists, token budgets)
- Match model capabilities to agent requirements: vision tools need vision models, streaming agents need streaming models, voice channels need low-TTFT models
- Design fallback chains per agent: primary model failure routes to a compatible alternative (different provider, similar capability)
- Provide relative cost comparison ("3x cheaper than...") with optional absolute estimates when conversation volume is specified
- Expose a specialist-visible `recommend_model` tool for IN_PROJECT mode queries
- Persist recommendations in the session journal for audit and replay
- Support topology-wide recommendation: per-agent model table with total cost estimate

### Non-Goals (Out of Scope)

- Fine-tuning, custom model hosting, or model training — B20 recommends from available models only
- Cross-provider migration tooling — switching a deployed agent's provider is a runtime concern
- Model benchmarking or live A/B testing — that's the Experiments feature
- Model health monitoring or auto-failover — that's the Model Hub's operational concern
- Cross-tenant model sharing — each tenant provisions independently
- Absolute pricing guarantees — pricing changes frequently; estimates are informational

---

## 3. User Stories

1. As an **agent developer**, I want Arch to automatically select the right model for each agent during BUILD so that I don't overspend on simple agents or underperform on complex ones.
2. As an **agent developer**, I want to ask Arch "what model should I use for the billing agent?" in IN_PROJECT mode and receive a comparison table with 2-4 options, trade-offs, and a primary recommendation with reasoning.
3. As a **project owner**, I want to request a topology-wide model recommendation so I can see the total estimated cost per conversation and identify optimization opportunities across all agents.
4. As an **agent developer**, I want model recommendations to respect my tenant's LLM policy (allowed providers, token budgets) so that I don't configure models that will be rejected at runtime.
5. As an **agent developer**, I want a fallback model recommendation for each agent so that runtime failures on the primary model degrade gracefully to a compatible alternative.
6. As an **agent developer**, I want Arch to proactively suggest model upgrades in IN_PROJECT mode when an agent's error rate or latency indicates the current model is insufficient.

---

## 4. Functional Requirements

1. **FR-1**: The system must analyze each agent's complexity profile (FLOW depth, tool count, GATHER requirements, CONSTRAINTS presence, execution mode) and map it to a model capability tier (simple → fast/cheap, moderate → balanced, complex → powerful/reasoning).
2. **FR-2**: The system must match agent tool requirements to model capabilities: agents with vision tools must get vision-capable models; agents with parallel tool calls must get models supporting `supportsParallelToolCalls`; voice channel agents must get streaming-capable models with low TTFT.
3. **FR-3**: The system must filter candidate models by tenant-provisioned models (from the tenant model catalog) and tenant LLM policy constraints (allowed providers, token budgets). Models not available to the tenant must not appear as primary recommendations.
4. **FR-4**: The system must produce a fallback chain per agent: at minimum a primary model and one fallback from a different provider with equivalent capabilities. The fallback must also pass tenant policy filtering.
5. **FR-5**: The system must present cost comparisons using relative terms ("3x cheaper than Claude Opus") as the primary signal, with optional absolute cost estimates ($X per 1K conversations) when the user provides conversation volume.
6. **FR-6**: The system must expose a specialist-visible `recommend_model` tool in IN_PROJECT mode that accepts an agent name (or "all" for topology-wide) and returns a structured comparison with primary recommendation, alternatives, reasoning, cost, and latency profiles.
7. **FR-7**: The system must present IN_PROJECT recommendations as a rich comparison widget showing 2-4 model options with strengths, weaknesses, cost tier, latency tier, and compliance fit per option.
8. **FR-8**: The system must persist model recommendations in the session journal as `model_recommendation` events, including the agent name, recommended models, reasoning, and timestamp.
9. **FR-9**: The system must validate compliance requirements from agent CONSTRAINTS (PCI-DSS, HIPAA, GDPR) and exclude or flag models that cannot meet those compliance needs.
10. **FR-10**: The system must support topology-wide recommendations that produce a per-agent model table with inter-agent consistency checks (compatible providers across handoff paths to minimize provider-switching latency).
11. **FR-11**: The system must generate proactive model upgrade suggestions in IN_PROJECT mode when trace data indicates high error rates (>10%) or latency exceeding target SLAs for the current model assignment.

---

## 5. Feature Classification & Integration Matrix

### Lifecycle / Platform Impact

| Area                       | Impact Level | Notes                                                               |
| -------------------------- | ------------ | ------------------------------------------------------------------- |
| Project lifecycle          | SECONDARY    | Affects project cost and performance profile                        |
| Agent lifecycle            | PRIMARY      | Core to agent design — every agent gets a model recommendation      |
| Customer experience        | SECONDARY    | Better models → better agent responses → better end-user experience |
| Integrations / channels    | SECONDARY    | Voice/streaming channels influence model selection                  |
| Observability / tracing    | SECONDARY    | Recommendations persisted in journal; trace data feeds suggestions  |
| Governance / controls      | PRIMARY      | Respects tenant LLM policy and compliance constraints               |
| Enterprise / compliance    | SECONDARY    | Compliance-aware filtering (PCI-DSS, HIPAA)                         |
| Admin / operator workflows | NONE         | Tenant model provisioning is Model Hub, not this feature            |

### Related Feature Integration Matrix

| Related Feature                                                              | Relationship Type | Why It Matters                                                                 | Key Touchpoints                                                 | Current State                 |
| ---------------------------------------------------------------------------- | ----------------- | ------------------------------------------------------------------------------ | --------------------------------------------------------------- | ----------------------------- |
| [Model Hub](model-hub.md)                                                    | depends on        | Provides model catalog, capabilities, pricing, tenant provisioning             | `MODEL_REGISTRY`, `ModelCapabilities`, tenant model CRUD        | STABLE — full registry exists |
| [Tenant LLM Policy](tenant-llm-policy.md)                                    | configured by     | Policy constraints filter which models can be recommended                      | `TenantLLMPolicy` model — allowed providers, token budgets      | ALPHA — policy model exists   |
| [Tracing & Observability](tracing-observability.md)                          | shares data with  | Trace data feeds proactive upgrade suggestions (error rates, latency)          | `TraceStore` events — per-agent error rate, latency percentiles | ALPHA — trace events exist    |
| [Guardrails](guardrails.md)                                                  | shares data with  | Compliance CONSTRAINTS inform model filtering                                  | ABL CONSTRAINTS section — PCI-DSS, HIPAA, GDPR flags            | BETA — constraint types exist |
| [Arch AI Assistant](arch-ai-assistant.md)                                    | extends           | B20 is a capability enhancement to the Arch specialist system                  | `getModelRecommendation()` helper, specialist tool registry     | BETA — static helper exists   |
| [Cost & Latency Estimator](docs/arch/backlogs/B14-cost-latency-estimator.md) | shares data with  | B14 reuses the cost estimation logic from B20 for full conversation cost views | Cost-per-model data, conversation volume estimates              | PLANNED — not yet implemented |

---

## 6. Design Considerations

### UX Patterns

**BUILD phase (automatic):** Model recommendations are injected silently into agent generation. The generated EXECUTION section includes the recommended model with a brief reason shown in the activity feed (B05):

```
⚙️ Generating billing_agent (2/4)...
  🧠 Model: claude-sonnet-4 (complex agent, 4 tools, reasoning needed)
  💰 Cost: ~$0.08/conversation (3x cheaper than Opus)
```

**IN_PROJECT mode (on-demand):** Developer asks "what model for billing_agent?" → Arch returns a comparison widget:

```
┌─────────────────────────────────────────────────────────┐
│  Model Recommendation: billing_agent                    │
│                                                         │
│  ★ Claude Sonnet 4        Anthropic    $0.08/conv       │
│    Strong reasoning + tool use. Best balance.           │
│                                                         │
│  ○ GPT-4o                 OpenAI       $0.12/conv       │
│    Excellent tool reliability. 50% more expensive.      │
│                                                         │
│  ○ Claude Haiku 4.5       Anthropic    $0.02/conv       │
│    ⚠️ May struggle with complex FLOW. 75% cheaper.      │
│                                                         │
│  Fallback: GPT-4o (different provider, similar caps)    │
│                                                         │
│  [Apply Sonnet 4]  [See All Models]  [Compare More]    │
└─────────────────────────────────────────────────────────┘
```

### Accessibility

- Comparison widget must be keyboard-navigable (Tab between options, Enter to select)
- Color indicators (cost tier) must have text labels, not color-only
- Screen reader: each option announced with model name, provider, cost, and status (recommended/alternative)

---

## 7. Technical Considerations

### Architecture Decision: Server-Side Filtering, Client-Side Rendering

The `getModelRecommendation()` helper runs server-side in the Studio Next.js API route. It accesses the `MODEL_REGISTRY` directly (imported from `@abl/compiler/platform/llm/model-capabilities`), filters by tenant policy, scores candidates, and returns 2-4 options. The LLM never sees the full 147-entry registry — it receives a pre-filtered, pre-scored recommendation.

### Migration from Static to Dynamic

The existing `getModelRecommendation()` in `apps/studio/src/lib/arch-ai/helpers/get-model-recommendation.ts` will be enhanced in-place. The function signature stays compatible — callers pass agent requirements, receive a `ModelRecommendation`. The internal logic changes from hardcoded switch-case to registry-based scoring.

### Tenant Model Awareness

To filter by tenant-provisioned models, the helper needs the tenant's model catalog. During BUILD, this is available in the session metadata (`session.tenantId` → query tenant models). During IN_PROJECT, the same data is available through the project context.

---

## 8. How to Consume

### Studio UI

- **BUILD phase**: Automatic — model recommendations injected into generated agents. Shown in activity feed.
- **IN_PROJECT mode**: Developer asks Arch about model selection → comparison widget rendered in chat.
- **Topology view**: "Recommend models for all agents" → per-agent table widget.
- **Routes**: No new routes — uses existing `POST /api/arch-ai/message` with the `recommend_model` tool.

### API (Runtime)

No new runtime endpoints. Existing endpoints used:

| Method | Path                          | Purpose                                  |
| ------ | ----------------------------- | ---------------------------------------- |
| GET    | `/api/model-capabilities/:id` | Model capability lookup (already exists) |
| GET    | `/api/tenant-models`          | Tenant-provisioned model list            |

### API (Studio)

No new Studio API routes. The `recommend_model` tool runs within the existing Arch AI message processing pipeline.

### Admin Portal

N/A — tenant model provisioning is managed through Model Hub, not this feature.

### Channel / SDK / Voice / A2A / MCP Integration

- Voice channels: model recommendations strongly prefer streaming-capable models with low TTFT
- MCP: when Arch is available via MCP (B56), the `recommend_model` tool will be exposed as an MCP tool
- Not directly channel-facing — this is a design-time feature

---

## 9. Data Model

### Collections / Tables

No new collections. B20 uses existing data:

```text
Collection: tenant_models (existing — from Model Hub)
  Used for: filtering recommendations to tenant-provisioned models

Collection: tenant_llm_policies (existing — from Tenant LLM Policy)
  Used for: filtering by allowed providers, token budgets

Collection: arch_sessions (existing — session journal)
  Extended with: model_recommendation journal event type
  Fields (new event):
    - type: 'model_recommendation'
    - agentName: string
    - recommendations: ModelRecommendation[]
    - reasoning: string
    - timestamp: Date
```

### Key Relationships

- `tenant_models` → filters available models per tenant
- `tenant_llm_policies` → constrains allowed providers and budgets
- `MODEL_REGISTRY` (static, in-memory) → provides capabilities, pricing metadata
- Session journal → persists recommendation events for audit

---

## 10. Key Implementation Files

### Domain / Core Logic

| File                                                              | Purpose                                                                   |
| ----------------------------------------------------------------- | ------------------------------------------------------------------------- |
| `apps/studio/src/lib/arch-ai/helpers/get-model-recommendation.ts` | Catalog-based scoring engine with tenant filtering, fallback chains, cost |
| `apps/studio/src/lib/arch-ai/types.ts`                            | `ModelRecommendation`, `ScoredModel` types with costTier/latencyTier      |
| `packages/compiler/src/platform/llm/model-capabilities.ts`        | Model capabilities registry (READ — source of truth)                      |
| `packages/compiler/src/platform/llm/model-registry.ts`            | 147+ model entries with pricing and capabilities (READ)                   |

### Routes / Handlers

| File                                            | Purpose                                      |
| ----------------------------------------------- | -------------------------------------------- |
| `apps/runtime/src/routes/model-capabilities.ts` | Model capabilities REST API (existing, READ) |
| `apps/runtime/src/routes/tenant-models.ts`      | Tenant model CRUD (existing, READ)           |

### UI Components

| File                                                                   | Purpose                                               |
| ---------------------------------------------------------------------- | ----------------------------------------------------- |
| `apps/studio/src/components/arch-v3/widgets/ModelComparisonWidget.tsx` | PLANNED — comparison table widget for IN_PROJECT mode |
| `apps/studio/src/components/arch-v3/panels/JournalPanel.tsx`           | PLANNED — render model_recommendation events          |

### Jobs / Workers / Background Processes

N/A — all recommendation logic is synchronous within the Arch message processing flow.

### Tests

| File                                                                         | Type        | Coverage Focus                                  |
| ---------------------------------------------------------------------------- | ----------- | ----------------------------------------------- |
| `apps/studio/src/__tests__/arch-ai/model-recommendation.test.ts`             | unit        | Recommendation engine logic, scoring, filtering |
| `apps/studio/src/__tests__/arch-ai/model-recommendation-integration.test.ts` | integration | Tenant policy filtering, registry integration   |
| TBD                                                                          | e2e         | Full BUILD + IN_PROJECT recommendation flow     |

---

## 11. Configuration

### Environment Variables

No new environment variables. Model pricing and capabilities are compiled into `MODEL_REGISTRY`.

### Runtime Configuration

| Setting                                       | Default | Description                                              |
| --------------------------------------------- | ------- | -------------------------------------------------------- |
| `arch.modelRecommendation.enabled`            | `true`  | Enable/disable model recommendation during BUILD         |
| `arch.modelRecommendation.maxCandidates`      | `4`     | Maximum models shown in comparison widget                |
| `arch.modelRecommendation.proactiveUpgrade`   | `false` | Enable proactive model upgrade suggestions in IN_PROJECT |
| `arch.modelRecommendation.errorRateThreshold` | `0.10`  | Error rate threshold triggering proactive suggestions    |

### DSL / Agent IR / Schema

Model recommendations map to the existing ABL EXECUTION section:

```yaml
EXECUTION:
  model: claude-sonnet-4-20250514
  provider: anthropic
  temperature: 0.5
  maxTokens: 4096
  fallback:
    model: gpt-4o
    provider: openai
```

The `fallback` field is a proposed extension to the EXECUTION IR. If the compiler doesn't support it yet, it's stored in agent metadata and resolved by the runtime's `ModelResolutionService`.

---

## 12. Non-Functional Concerns

### Isolation & Multitenancy

| Concern           | Requirement / Expectation                                                                                              |
| ----------------- | ---------------------------------------------------------------------------------------------------------------------- |
| Project isolation | Recommendations are scoped to the project's agent topology. Cross-project model data is never leaked.                  |
| Tenant isolation  | Recommendations filter by the tenant's provisioned models and LLM policy. A tenant never sees another tenant's models. |
| User isolation    | Session journal events are user-scoped within the Arch session. N/A for broader user isolation.                        |

### Security & Compliance

- Model recommendations never expose raw API keys or credentials — only model names and providers
- Compliance filtering (PCI-DSS, HIPAA) uses the agent's CONSTRAINTS section as input, not user-supplied claims
- Tenant LLM policy is enforced server-side — the client cannot bypass policy restrictions
- No PII in recommendation data — only model names, cost tiers, and capability flags

### Performance & Scalability

- Recommendation computation is O(N) over the model registry (~147 entries) — sub-millisecond
- No external API calls during recommendation — all data is in-memory from `MODEL_REGISTRY`
- Tenant model list is cached per-session (fetched once at session start)
- Token budget: recommendation output is ~500 tokens for 4 candidates — well within context limits

### Reliability & Failure Modes

- If model registry is unavailable (import error): fall back to the existing static short-list
- If tenant model query fails: recommend from the full registry with a warning "unable to filter by tenant models"
- If no models match all constraints: relax non-critical constraints (cost preference) and explain the trade-off
- Recommendation is advisory — it never blocks agent generation

### Observability

- Journal events: `model_recommendation` with full recommendation payload
- Activity feed: model selection shown in real-time during BUILD
- Logging: `createLogger('arch-ai:model-recommendation')` for debug-level traces
- No new metrics or dashboards — B20 is a design-time feature

### Data Lifecycle

- Session journal events follow existing Arch session retention policy
- No new persistent data outside the session — recommendations are ephemeral design-time artifacts
- Model registry data is compiled into the package — no runtime data lifecycle concerns

---

## 13. Delivery Plan / Work Breakdown

1. **Enhance recommendation engine**
   1.1 Refactor `getModelRecommendation()` to score against `MODEL_REGISTRY` instead of hardcoded switch-case
   1.2 Add capability matching logic: vision, streaming, parallel tools, structured output
   1.3 Add compliance filtering: scan agent CONSTRAINTS for PCI-DSS/HIPAA/GDPR, exclude non-compliant models
   1.4 Add tenant model filtering: accept tenant model list, restrict candidates to provisioned models
   1.5 Add fallback chain generation: pick fallback from different provider with equivalent capabilities
   1.6 Add cost comparison: relative cost tiers from `MODEL_REGISTRY` pricing data

2. **Expose specialist-visible tool**
   2.1 Register `recommend_model` tool in the Arch tool registry for IN_PROJECT mode
   2.2 Define tool schema: input (agentName or "all"), output (comparison structure)
   2.3 Wire tool to enhanced `getModelRecommendation()` with tenant context from session
   2.4 Add topology-wide mode: iterate agents, check inter-agent provider consistency

3. **Build comparison widget**
   3.1 Create `ModelComparisonWidget.tsx` using design tokens
   3.2 Render 2-4 model options with strengths, weaknesses, cost, latency, compliance fit
   3.3 Add "Apply" action button that triggers agent model change via IP-F01 flow
   3.4 Add keyboard navigation and accessibility labels

4. **Journal integration**
   4.1 Define `model_recommendation` journal event type
   4.2 Persist recommendation events in session journal
   4.3 Render recommendation events in JournalPanel

5. **Proactive suggestions (stretch)**
   5.1 Add trace data analysis hook for IN_PROJECT mode
   5.2 Detect high error rate / high latency for current model assignment
   5.3 Surface upgrade suggestion in activity feed

---

## 14. Success Metrics

| Metric                               | Baseline           | Target               | How Measured                                           |
| ------------------------------------ | ------------------ | -------------------- | ------------------------------------------------------ |
| Model cost per conversation (avg)    | Unknown (no data)  | 30% reduction        | Compare before/after B20 across projects               |
| Agent error rate from model mismatch | Unknown            | <5%                  | Trace events with model-related errors                 |
| Time to select model (developer)     | Manual (~5 min)    | Automatic (<1s)      | BUILD phase: automatic; IN_PROJECT: tool response time |
| Recommendation acceptance rate       | N/A                | >70%                 | "Apply" button clicks / recommendations shown          |
| Fallback utilization rate            | No fallbacks exist | Fallbacks configured | Count agents with fallback chains after B20            |

---

## 15. Open Questions

1. Should the `fallback` field be added to the ABL EXECUTION IR formally, or stored as agent metadata until compiler support is added?
2. How should model pricing data be kept current? The `MODEL_REGISTRY` is static — should there be a periodic sync from provider APIs?
3. For topology-wide recommendations, how should inter-agent provider consistency be weighted against per-agent optimal cost? (e.g., mixing Anthropic and OpenAI adds latency from provider switching)
4. Should proactive upgrade suggestions (FR-11) require opt-in via workspace settings (B18), or be enabled by default?
5. When a tenant has no models provisioned (new tenant), should recommendations show "configure models first" or recommend from the public catalog?

---

## 16. Gaps, Known Issues & Limitations

| ID      | Description                                                                                     | Severity | Status |
| ------- | ----------------------------------------------------------------------------------------------- | -------- | ------ |
| GAP-001 | Existing `getModelRecommendation()` uses hardcoded short-list — needs full registry refactor    | High     | Open   |
| GAP-002 | No tenant model awareness in current implementation — recommendations ignore provisioned models | High     | Open   |
| GAP-003 | No fallback chain support in ABL EXECUTION IR — needs compiler extension or metadata workaround | Medium   | Open   |
| GAP-004 | Model pricing in `MODEL_REGISTRY` may be stale — no automated refresh mechanism                 | Medium   | Open   |
| GAP-005 | Proactive upgrade suggestions depend on trace data which may not exist for newly created agents | Low      | Open   |
| GAP-006 | No specialist-visible tool for IN_PROJECT model queries — only internal BUILD helper exists     | High     | Open   |

---

## 17. Testing & Validation

### Required Test Coverage

| #   | Scenario                                                      | Coverage Type | Status     | Test File / Note                         |
| --- | ------------------------------------------------------------- | ------------- | ---------- | ---------------------------------------- |
| 1   | Simple agent (scripted, 1 tool) gets fast/cheap model         | unit          | NOT TESTED | model-recommendation.test.ts             |
| 2   | Complex agent (5 tools, multi-step FLOW) gets reasoning model | unit          | NOT TESTED | model-recommendation.test.ts             |
| 3   | Vision tool agent gets vision-capable model                   | unit          | NOT TESTED | model-recommendation.test.ts             |
| 4   | PCI-DSS constraint excludes non-compliant models              | unit          | NOT TESTED | model-recommendation.test.ts             |
| 5   | Tenant policy restricts to allowed providers only             | integration   | NOT TESTED | model-recommendation-integration.test.ts |
| 6   | Fallback chain uses different provider than primary           | unit          | NOT TESTED | model-recommendation.test.ts             |
| 7   | IN_PROJECT recommend_model tool returns comparison structure  | integration   | NOT TESTED | TBD                                      |
| 8   | Topology-wide recommendation produces per-agent table         | integration   | NOT TESTED | TBD                                      |
| 9   | Recommendation persisted in session journal                   | integration   | NOT TESTED | TBD                                      |
| 10  | Full BUILD flow assigns appropriate models to all agents      | e2e           | NOT TESTED | TBD                                      |
| 11  | IN_PROJECT "what model for X?" returns widget with comparison | e2e           | NOT TESTED | TBD                                      |
| 12  | Tenant with no provisioned models gets appropriate guidance   | e2e           | NOT TESTED | TBD                                      |

### Testing Notes

E2E tests must exercise the real Arch AI message pipeline through HTTP — no mocking of `getModelRecommendation()` or `MODEL_REGISTRY`. Tests should:

- Start a real Studio server with the Arch AI route mounted
- Send messages via `POST /api/arch-ai/message` with auth context
- Verify the response contains model recommendations with correct structure
- Verify tenant isolation: Tenant A's provisioned models don't leak into Tenant B's recommendations

> Full testing details: [../testing/model-selection-intelligence.md](../testing/model-selection-intelligence.md)

---

## 18. References

- Design docs: [`docs/superpowers/specs/2026-04-03-arch-specialist-enhancement-design.md`](../superpowers/specs/2026-04-03-arch-specialist-enhancement-design.md)
- Arch feature spec: [`docs/arch/features/IP-F03-model-recommendation.md`](../arch/features/IP-F03-model-recommendation.md)
- Backlog item: [`docs/arch/backlogs/B20-model-selection-intelligence.md`](../arch/backlogs/B20-model-selection-intelligence.md)
- Model Hub feature: [`docs/features/model-hub.md`](model-hub.md)
- Tenant LLM Policy: [`docs/features/tenant-llm-policy.md`](tenant-llm-policy.md)
- Model capabilities source: [`packages/compiler/src/platform/llm/model-capabilities.ts`](../../packages/compiler/src/platform/llm/model-capabilities.ts)
- Existing helper: [`apps/studio/src/lib/arch-ai/helpers/get-model-recommendation.ts`](../../apps/studio/src/lib/arch-ai/helpers/get-model-recommendation.ts)

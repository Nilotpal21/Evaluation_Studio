# Guardrails -- High-Level Design

**Status**: BETA (implemented)
**Feature Spec**: [docs/features/guardrails.md](../features/guardrails.md)
**Test Spec**: [docs/testing/guardrails.md](../testing/guardrails.md)
**LLD**: [docs/plans/guardrails.lld.md](../plans/guardrails.lld.md)
**Last Updated**: 2026-03-26

---

## 1. Problem Statement

LLM-powered agents can produce harmful, off-topic, or policy-violating outputs. Without runtime content safety checks, enterprises cannot deploy agents in regulated or customer-facing environments. The challenge is compounded by:

- **Multiple content pathways**: User inputs, LLM outputs, tool call parameters, tool results, and agent handoffs all need protection.
- **Latency sensitivity**: Content safety checks must not degrade user experience, especially in streaming mode.
- **Cost variability**: Model-based and LLM-based checks incur per-evaluation costs that must be tracked and bounded.
- **Organizational hierarchy**: Enterprise deployments require policy inheritance from platform through tenant, project, and agent levels.
- **Provider diversity**: Different evaluation providers have different strengths, reliability characteristics, and costs.

The guardrails system must provide configurable, multi-tier content safety across all content pathways with hierarchical policy management, cost controls, and comprehensive observability.

---

## 2. Alternatives Considered

### Alternative A: Single-Tier Evaluation (LLM-Only)

**Description**: Route all content through a single LLM-based evaluator with a safety prompt.

**Pros**:

- Simple architecture -- one evaluation path
- High-quality nuanced evaluation
- No provider registry needed

**Cons**:

- 2-5 second latency per evaluation -- unacceptable for input validation
- Every check incurs LLM cost -- no free tier
- Single point of failure for evaluation
- Cannot leverage specialized models (PII detection, content classification)
- No caching benefit (context-dependent)

**Effort**: Small

### Alternative B: 3-Tier Pipeline with Early Termination (Chosen)

**Description**: Tiered evaluation: Tier 1 (local CEL/regex/PII, <5ms), Tier 2 (model classifiers, <500ms), Tier 3 (LLM evaluation, <5s). Lower tiers run first; terminal violations skip expensive higher tiers.

**Pros**:

- Optimal latency: most content checked in <5ms by Tier 1
- Cost-efficient: expensive checks only run when cheap checks pass
- Fault-tolerant: each tier can fail independently
- Provider-diverse: different providers at different tiers
- Cacheable: Tier 1 and 2 results are deterministic enough to cache

**Cons**:

- More complex architecture (3 evaluator implementations, registry, adapters)
- Policy resolution is complex (4-level merge with override types)
- Testing surface is large (provider x kind x action matrix)

**Effort**: Large

### Alternative C: External Guardrail Service

**Description**: Delegate all evaluation to an external guardrail-as-a-service platform (e.g., LakeraGuard, Guardrails AI).

**Pros**:

- No implementation burden for evaluation logic
- Access to continuously updated threat models
- Vendor manages model drift and false positive rates

**Cons**:

- External dependency for every agent interaction
- Data leaves platform boundary (compliance risk)
- No customization for tenant-specific policies
- Vendor lock-in and cost unpredictability
- Latency from external round-trip

**Effort**: Medium

### Recommendation

**Alternative B** was chosen because it provides the best balance of latency, cost, and customizability. Local CEL checks handle 80%+ of evaluations at zero cost and sub-millisecond latency. Model-based checks provide specialized classification. LLM checks handle the long tail of nuanced evaluations. The tier-based approach also enables graceful degradation: if model providers fail, local checks still protect, and the system can downgrade to lower tiers when budgets are exceeded.

---

## 3. Architecture

### System Context Diagram

```
                              +------------------+
                              |   Studio UI      |
                              | (GuardrailsPage) |
                              +--------+---------+
                                       |
                           REST API (proxy)
                                       |
                 +---------------------v---------------------+
                 |              Runtime Server                |
                 |                                           |
                 |  +-------+   +--------+   +----------+   |
                 |  |Policy |   |Provider|   | Pipeline  |   |
                 |  |Routes |   |Routes  |   | Factory   |   |
                 |  +---+---+   +---+----+   +-----+-----+  |
                 |      |           |              |          |
                 |  +---v-----------v--------------v------+  |
                 |  |     Guardrail Pipeline Impl          |  |
                 |  |  +------+  +------+  +------+       |  |
                 |  |  |Tier 1|  |Tier 2|  |Tier 3|       |  |
                 |  |  |Local |  |Model |  | LLM  |       |  |
                 |  |  +------+  +------+  +------+       |  |
                 |  +--+------+------+------+------+------+  |
                 |     |      |      |      |      |         |
                 |  +--v-+ +--v-+ +--v-+ +--v-+ +--v-+      |
                 |  |Cache| |Cost| |Wbhk| |Circ| |Trace|    |
                 |  |Port | |Port| |Port| |Brkr| |Evts |    |
                 |  +--+--+ +--+-+ +--+-+ +----+ +--+--+    |
                 +-----|-------|-------|-----------|----------+
                       |       |       |           |
                 +-----v-+ +--v--+ +--v---+  +----v----+
                 | Redis  | |Redis| |HTTP  |  | Trace   |
                 | Cache  | |Cost | |Endpt |  | Store   |
                 +--------+ +-----+ +------+  +---------+

                 +-------------+  +--------------------------+
                 |  MongoDB    |  | External Providers       |
                 | Policies &  |  | (OpenAI, Custom HTTP,    |
                 | Providers   |  |  Self-hosted models)     |
                 +-------------+  +--------------------------+
```

### Component Architecture

```
packages/compiler/src/platform/guardrails/
  pipeline.ts              -- GuardrailPipelineImpl (orchestrator)
  tier1-evaluator.ts       -- CEL/regex local evaluation
  tier2-evaluator.ts       -- Model-based provider dispatch
  tier3-evaluator.ts       -- LLM-based evaluation with injection
  provider.ts              -- GuardrailModelProvider interface
  provider-registry.ts     -- Named provider registry
  action-applier.ts        -- Post-evaluation action application
  action-executors.ts      -- Fix/redact/filter strategy implementations
  circuit-breaker.ts       -- Per-provider CLOSED/OPEN/HALF_OPEN
  result-aggregator.ts     -- Cross-tier result merging
  types.ts                 -- Core types (GuardrailViolation, PipelineResult)
  messages.ts              -- Violation message templates
  constants.ts             -- Action precedence

  providers/
    builtin-pii.ts         -- Built-in PII detection (Tier 2, zero cost)
    openai-moderation.ts   -- OpenAI Moderation API
    openai-compatible.ts   -- Generic OpenAI-compatible endpoint
    custom-http.ts         -- Custom HTTP with response mapping

apps/runtime/src/services/guardrails/
  pipeline-factory.ts      -- Tenant-scoped factory, provider loading, LLM adapter
  policy-resolver.ts       -- 4-layer policy merge
  streaming-evaluator.ts   -- Sentence-boundary/chunk streaming checks
  cache.ts                 -- Redis cache with tier TTLs
  cost-tracker.ts          -- Microdollar budget tracking
  port-adapters.ts         -- Compiler port -> runtime implementation bridge
  webhook.ts               -- HMAC-SHA256 signed delivery with retry
  trace-events.ts          -- 15 trace event factories
```

### Data Flow -- Input Evaluation

```
1. User sends message to agent
2. Runtime receives message via channel/API
3. Pipeline factory loads/creates tenant provider registry
4. Policy resolver merges: platform -> tenant -> project -> agent DSL
5. Pipeline filters guardrails by kind=input
6. Tier 1 (local):
   a. CEL expressions evaluated against input context
   b. Terminal violation? -> early termination, return blocked
   c. Cache check (24h TTL)
7. Tier 2 (model):
   a. Provider registry dispatches to registered model providers
   b. Score compared against threshold
   c. Terminal violation? -> early termination, return blocked
   d. Cache check (1h TTL)
   e. Cost tracked in microdollars
8. Tier 3 (LLM):
   a. Injected LLM function called with safety prompt
   b. Response parsed (JSON or heuristic fallback)
   c. Score clamped to [0,1] range
   d. No caching (context-dependent)
   e. Cost tracked in microdollars
9. Results aggregated: pass/fail, violations, modified content
10. Trace events emitted for every check/violation/cache operation
11. If passed: message forwarded to LLM reasoning loop
12. If failed: action applied (block/warn/fix/redact/reask/escalate)
```

### Data Flow -- Output + Streaming Evaluation

```
1. LLM generates response (streaming or buffered)
2. If streaming:
   a. StreamingGuardrailEvaluator buffers tokens
   b. At sentence boundary (regex: /[.!?]\s/): evaluate buffer
   c. Terminal violation? -> emit 'terminate' event, stop stream
   d. Non-terminal violation? -> emit 'violation' event, continue
   e. After stream complete: evaluateFinal() for remaining buffer
3. If buffered:
   a. Output pipeline evaluates complete response
   b. Same Tier 1->2->3 flow as input
4. Violations trigger configured actions
5. Trace events emitted
```

---

## 4. The 12 Architectural Concerns

### Structural Concerns

| #   | Concern             | How Addressed                                                                                                                                                                                                                                                 |
| --- | ------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 1   | Tenant Isolation    | Both MongoDB models use `tenantIsolationPlugin`. Cache keys include `tenantId`. Provider registries are per-tenant `Map<string, GuardrailProviderRegistry>`. Cross-tenant access returns 404.                                                                 |
| 2   | Data Access Pattern | Direct Mongoose model access in route handlers. No repository layer. Pipeline factory loads providers with 5-minute TTL cache and config fingerprinting. Redis for evaluation caching and cost tracking.                                                      |
| 3   | API Contract        | REST endpoints with `{ success: true/false, data?, error?: { code, message } }` envelope. Policy routes are project-scoped (`/api/projects/:projectId/guardrail-policies`). Provider routes are tenant-scoped (`/api/tenants/:tenantId/guardrail-providers`). |
| 4   | Security Surface    | Auth middleware + rate limiting + feature gate on all routes. Provider API keys stored encrypted (auth profiles). Webhook URLs validated for SSRF. HMAC-SHA256 webhook signing. Protected fields stripped from request bodies.                                |

### Behavioral Concerns

| #   | Concern       | How Addressed                                                                                                                                                                                                                                                   |
| --- | ------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 5   | Error Model   | Fail-open by default: evaluation errors allow content through. Configurable fail-closed per policy. Provider errors emit `guardrail_provider_error` trace events. Pipeline errors emit `guardrail_pipeline_error`. Route errors return standard error envelope. |
| 6   | Failure Modes | Circuit breaker per provider (CLOSED->OPEN->HALF_OPEN). Cache failures are non-blocking (fail-open). Cost tracker failures return 0. Webhook delivery retries with exponential backoff. LLM tier falls back from validation to response_gen model.              |
| 7   | Idempotency   | Policy CRUD is standard REST (PUT is full replace). Cache is content-addressable (same content = same key). Cost tracking uses atomic INCRBY (idempotent by design). Webhook delivery is at-least-once (not exactly-once).                                      |
| 8   | Observability | 15 trace event types covering every pipeline phase. Events emitted via session `onTraceEvent` callback. Cost events track per-evaluation spend. Circuit breaker events track state transitions. Pipeline completion events summarize the full run.              |

### Operational Concerns

| #   | Concern            | How Addressed                                                                                                                                                                                                                                                                                                                 |
| --- | ------------------ | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 9   | Performance Budget | Tier 1: <5ms (CEL compiled, no network). Tier 2: <500ms (HTTP to model provider). Tier 3: <5s (LLM round-trip). Early termination skips expensive tiers on local violations. Cache reduces redundant evaluations. Provider registry refresh every 5 minutes.                                                                  |
| 10  | Migration Path     | N/A for initial implementation. For provider expansion: new adapter types only require implementing `GuardrailModelProvider` interface and registering in factory. No schema migration needed -- `adapterType` enum is extensible.                                                                                            |
| 11  | Rollback Plan      | Feature gate (`requireFeature('guardrails')`) can disable all routes. `GUARDRAILS_ENABLED=false` env var disables pipeline evaluation. Policy status (draft/active/archived) allows deactivation without deletion. Provider `isActive` flag for soft disable.                                                                 |
| 12  | Test Strategy      | Unit tests for every component (evaluators, cache, cost, webhook, adapters). Integration tests for execution paths (output, tool, handoff guardrails). Compiler E2E for multi-tier cascade. Runtime E2E gaps: provider x kind matrix, streaming + model, policy scoping. Target: 80%+ E2E coverage of provider x kind matrix. |

---

## 5. Data Model

### guardrail_policies (MongoDB)

```
_id: string (UUIDv7)
tenantId: string (required)
name: string (required)
scope: {
  type: 'tenant' | 'project' | 'agent'
  projectId?: string
  agentDefId?: string
}
providerOverrides: [{
  providerName: string
  endpoint?: string
  apiKeyCredentialId?: string
  authProfileId?: string
  defaultThreshold?: number
  circuitBreaker?: { failureThreshold, resetTimeoutMs }
  retry?: { maxRetries, backoffBaseMs }
  costPerEvalUsd?: number
  isActive?: boolean
}]
rules: [{
  guardrailName: string
  override: 'disable' | 'threshold' | 'action' | 'severity_actions' | 'define'
  threshold?: number
  action?: Record<string, unknown>
  severityActions?: Record<string, unknown>
  kind?, tier?, provider?, category?, check?, llmCheck?, description?, priority?, message?
}]
constitution: [{ principle: string, weight: number, examples?: string[] }]
settings: {
  failMode: 'open' | 'closed'
  timeouts: { local: number, model: number, llm: number }
  webhookUrl?: string
  webhookSecret?: string
  streaming: { enabled, defaultInterval, chunkSize, maxLatencyMs, earlyTermination }
}
caching: { enabled, exactMatch, semanticMatch, semanticThreshold, defaultTtlSeconds }
budget: { monthlyLimitUsd, currentSpendUsd, overspendAction }
version: number
status: 'draft' | 'active' | 'archived'
isActive: boolean

Indexes:
  { tenantId, name, 'scope.type' } unique
  { tenantId, 'scope.projectId', status }
  { tenantId, 'scope.agentDefId' }
  { tenantId, isActive }
```

### tenant_guardrail_provider_configs (MongoDB)

```
_id: string (UUIDv7)
tenantId: string (required)
name: string (required)
displayName: string (required)
adapterType: enum (15 types, 4 implemented)
endpoint: string (required)
apiKeyCredentialId?: string
authProfileId?: string
model: string (required)
hosting: 'self_hosted' | 'cloud_api' | 'managed_service'
selfHostedConfig?: { runtime, gpuType?, quantization?, maxBatchSize?, maxConcurrency? }
defaultCategory: string
defaultThreshold: number
supportedCategories: string[]
customMapping?: { requestTemplate, responseScorePath, responseLabelPath?, responseExplanationPath? }
circuitBreaker: { failureThreshold: 5, resetTimeoutMs: 30000, failMode: 'open' | 'closed' }
retry: { maxRetries: 3, backoffBaseMs: 1000 }
costPerEvalUsd: number
isActive: boolean
lastHealthCheck?: { status, latencyMs, checkedAt, error? }

Indexes:
  { tenantId, name } unique
  { tenantId, isActive }
  { tenantId, adapterType }
```

### Redis Keys

```
guardrail:{tenantId}:{projectId}:{guardrailName}:{sha256_16}
  -> CachedGuardrailResult { passed, action?, message?, modifiedContent?, score?, severity?, cachedAt }
  TTL: local=86400s (24h), model=3600s (1h), llm=never

guardrail:cost:{tenantId}:{projectId}:{YYYY-MM}
  -> integer (microdollars)
  TTL: 35 days (auto-expire)
```

---

## 6. API Design

### Policy Routes (Project-scoped)

Mount: `/api/projects/:projectId/guardrail-policies`
Auth: `authMiddleware` + `tenantRateLimit('request')` + `requireFeature('guardrails')`

| Method | Path            | Purpose         | Auth                           |
| ------ | --------------- | --------------- | ------------------------------ |
| GET    | `/`             | List policies   | Authenticated user in project  |
| POST   | `/`             | Create policy   | `guardrails:manage` permission |
| GET    | `/:id`          | Get policy      | Authenticated user in project  |
| PUT    | `/:id`          | Update policy   | `guardrails:manage` permission |
| DELETE | `/:id`          | Delete policy   | `guardrails:manage` permission |
| POST   | `/:id/activate` | Activate policy | `guardrails:manage` permission |

### Provider Routes (Tenant-scoped)

Mount: `/api/tenants/:tenantId/guardrail-providers`
Auth: Same middleware chain

| Method | Path        | Purpose           | Auth                           |
| ------ | ----------- | ----------------- | ------------------------------ |
| GET    | `/`         | List providers    | Authenticated tenant user      |
| POST   | `/`         | Register provider | `guardrails:manage` permission |
| GET    | `/:id`      | Get provider      | Authenticated tenant user      |
| PUT    | `/:id`      | Update provider   | `guardrails:manage` permission |
| DELETE | `/:id`      | Delete provider   | `guardrails:manage` permission |
| POST   | `/:id/test` | Test connectivity | `guardrails:manage` permission |

### Error Responses

All routes return standard error envelope:

```json
{
  "success": false,
  "error": {
    "code": "GUARDRAIL_POLICY_NOT_FOUND",
    "message": "Guardrail policy not found"
  }
}
```

- 400: Validation error (missing required fields, invalid adapter type)
- 401: No authentication
- 403: Feature gate not met (requires TEAM tier)
- 404: Resource not found OR cross-tenant/cross-project access
- 500: Internal server error

---

## 7. Cross-Cutting Concerns

### Audit Logging

All policy and provider mutations emit audit log entries via `writeAuditLog()`:

- `guardrail_policy_created`, `guardrail_policy_updated`, `guardrail_policy_deleted`, `guardrail_policy_activated`
- `guardrail_provider_created`, `guardrail_provider_updated`, `guardrail_provider_deleted`

### Rate Limiting

All guardrail routes use `tenantRateLimit('request')` middleware for per-tenant request throttling.

### Caching Strategy

- **Evaluation results**: Redis exact-match cache with content SHA-256. TTLs: local=24h, model=1h, LLM=never. Cache key: `guardrail:{tenantId}:{projectId}:{guardrailName}:{sha256_16}`.
- **Provider registry**: In-memory `Map<string, GuardrailProviderRegistry>` with 5-minute TTL and config fingerprinting. Max 200 tenants with LRU eviction.
- **Cache invalidation**: Policy mutations call `invalidateGuardrailEvalCache()`. Provider mutations call `invalidateTenantProviderCache()`.

### Encryption

- Provider API keys stored as encrypted credentials via auth profiles or credential store -- never in plaintext in provider config documents.
- Redis cache stores evaluation results (pass/fail/scores) -- no sensitive content stored.
- Webhook payloads signed with HMAC-SHA256 using per-webhook secrets.

---

## 8. Dependencies

### Upstream (This Feature Depends On)

| Dependency         | Package                       | Risk   | Impact if Unavailable                                      |
| ------------------ | ----------------------------- | ------ | ---------------------------------------------------------- |
| Redis              | `apps/runtime` (redis client) | Medium | Cache and cost tracking disabled; evaluation still works   |
| MongoDB            | `packages/database`           | High   | No policy/provider CRUD; pipeline uses DSL guardrails only |
| Auth Profiles      | `@agent-platform/shared-auth` | Low    | Provider API keys must use apiKeyCredentialId instead      |
| Session LLM Client | `apps/runtime` (llm service)  | Medium | Tier 3 LLM evaluation unavailable; Tier 1 and 2 still work |
| Trace Store        | `@agent-platform/observatory` | Low    | Trace events not persisted; evaluation still works         |
| Compiler IR        | `packages/compiler`           | High   | DSL guardrails cannot compile to IR                        |
| Feature Gate       | `apps/runtime` (feature-gate) | Low    | Routes return 403 if guardrails feature not enabled        |

### Downstream (Depends On This Feature)

| Dependent             | Package                     | Impact                                                     |
| --------------------- | --------------------------- | ---------------------------------------------------------- |
| Reasoning Executor    | `apps/runtime` (execution)  | Input/output guardrails integrate at execution checkpoints |
| Flow Step Executor    | `apps/runtime` (execution)  | Tool call/output guardrails on flow-step tool execution    |
| Handoff Orchestration | `apps/runtime` (execution)  | Handoff guardrails can block agent transfers               |
| Studio Guardrails UI  | `apps/studio`               | Studio pages consume runtime guardrail API endpoints       |
| Observatory           | `apps/studio` (observatory) | Guardrail trace events displayed in session debug views    |

---

## 9. Decisions & Tradeoffs

| Decision                       | Choice                                                 | Rationale                                                                                | Alternative Rejected                                         |
| ------------------------------ | ------------------------------------------------------ | ---------------------------------------------------------------------------------------- | ------------------------------------------------------------ |
| D-1: Tier architecture         | 3 tiers (local/model/LLM)                              | Optimal latency-cost tradeoff; most content handled by free Tier 1                       | Single-tier LLM (too slow/expensive)                         |
| D-2: Provider registry scope   | Per-tenant                                             | Core Invariant #1 (tenant isolation); prevents cross-tenant provider access              | Global registry (violates isolation)                         |
| D-3: Compiler/runtime boundary | Port adapter pattern                                   | Decouples compiler from Redis/MongoDB; enables unit testing without infra                | Direct coupling (untestable)                                 |
| D-4: Default fail mode         | Fail-open                                              | Prevents guardrail infra failures from causing service outages                           | Fail-closed (too risky for availability)                     |
| D-5: Cache TTL strategy        | Tier-specific (24h/1h/never)                           | Matches evaluation determinism: local=deterministic, model=drifts, LLM=context-dependent | Uniform TTL (wastes cache for LLM, stale for model)          |
| D-6: Cost unit                 | Microdollars (1 USD = 1M)                              | Integer arithmetic avoids floating-point rounding; Redis INCRBY is atomic                | Fractional USD (floating-point drift)                        |
| D-7: Webhook security          | HMAC-SHA256 + SSRF allowlist                           | Industry-standard webhook signing; SSRF prevention required for user-provided URLs       | Basic auth (less secure), no validation (SSRF risk)          |
| D-8: Policy merge strategy     | Lower scope replaces higher scope (per guardrail name) | Intuitive: agent-level override takes precedence over project, project over tenant       | Additive merge (confusing when same rule at multiple scopes) |

---

## 10. Open Questions & Decisions Needed

1. **Cross-tenant shared policies**: Should platform-managed global policies be supported? This would require a new policy scope type and shared policy visibility rules.
2. **Per-project budgets**: Current budget is per-policy. Should there be per-project aggregate budget tracking?
3. **Provider expansion**: When should the 11 unimplemented adapter types be implemented vs removed from the DB enum?
4. **Semantic caching**: Schema supports semantic similarity matching; should it be implemented, and with what embedding model?
5. **Audit tab completion**: Should the Studio Audit tab be a full implementation or delegate to the Observatory trace viewer?

---

## 11. References

- Feature Spec: [docs/features/guardrails.md](../features/guardrails.md)
- Test Spec: [docs/testing/guardrails.md](../testing/guardrails.md)
- LLD: [docs/plans/guardrails.lld.md](../plans/guardrails.lld.md)
- Coverage Audit: [docs/audit/guardrails-coverage-matrix-2026-03-09.md](../audit/guardrails-coverage-matrix-2026-03-09.md)
- Compiler guardrails: `packages/compiler/src/platform/guardrails/`
- Runtime guardrails: `apps/runtime/src/services/guardrails/`
- DB models: `packages/database/src/models/guardrail-policy.model.ts`, `guardrail-provider-config.model.ts`
- Adapter constants: `packages/database/src/constants/guardrail-adapters.ts`

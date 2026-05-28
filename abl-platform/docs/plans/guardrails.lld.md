# Guardrails -- Low-Level Design

**Status**: Implemented (BETA)
**Feature Spec**: [docs/features/guardrails.md](../features/guardrails.md)
**HLD**: [docs/specs/guardrails.hld.md](../specs/guardrails.hld.md)
**Testing Guide**: [docs/testing/guardrails.md](../testing/guardrails.md)
**Last Updated**: 2026-03-26

---

## 1. Design Decisions

### Decision Log

| Decision                        | Rationale                                                                                                    | Alternative Rejected                          |
| ------------------------------- | ------------------------------------------------------------------------------------------------------------ | --------------------------------------------- |
| Compiler owns evaluation logic  | Keeps pipeline testable without runtime infrastructure                                                       | Runtime-only evaluation (requires Redis/DB)   |
| Port adapter pattern            | Decouples compiler from Redis/MongoDB; each runtime feature is a port implementation                         | Direct dependency injection (tight coupling)  |
| Lazy singleton backing services | GuardrailCache and CostTracker created on first use, shared across all pipeline executions                   | Per-request instances (wasteful)              |
| Config fingerprinting           | SHA-256 of provider config detects changes without full equality check; triggers registry refresh            | Polling on timer (misses changes between TTL) |
| Microdollar integers            | Redis INCRBY on integers avoids floating-point rounding; 1 USD = 1,000,000 microdollars                      | Fractional USD (drift over many operations)   |
| Sentence-boundary streaming     | Regex `/[.!?]\s/` catches natural sentence breaks; better than fixed-size chunks for readability             | Fixed-size chunks (mid-word violations)       |
| Define-mode rules               | Allows DB policies to create synthetic guardrails that do not exist in DSL; never overwrites DSL definitions | DSL-only guardrails (limited admin control)   |

### Key Interfaces & Types

#### Compiler (`packages/compiler`)

```typescript
// packages/compiler/src/platform/ir/schema.ts
interface Guardrail {
  name: string;
  description: string;
  kind: 'input' | 'output' | 'tool_input' | 'tool_output' | 'handoff';
  priority: number;
  tier: 'local' | 'model' | 'llm';
  check?: string; // CEL expression (Tier 1)
  llmCheck?: string; // LLM prompt (Tier 3)
  provider?: string; // Provider name (Tier 2)
  category?: string;
  threshold?: number;
  action: GuardrailAction;
  severityActions?: Record<string, GuardrailAction>;
}

// packages/compiler/src/platform/guardrails/types.ts
interface GuardrailPipelineResult {
  passed: boolean;
  violations: GuardrailViolation[];
  primaryViolation?: GuardrailViolation;
  modifiedContent?: string;
  warnings: GuardrailViolation[];
  metrics: PipelineMetrics;
}

// packages/compiler/src/platform/guardrails/pipeline.ts
interface PipelinePolicy {
  disabledGuardrails?: string[];
  ruleOverrides?: Array<{
    guardrailName: string;
    override: 'threshold' | 'action' | 'severity_actions';
    threshold?: number;
    action?: GuardrailAction;
    severityActions?: Record<string, GuardrailAction>;
  }>;
  providerOverrides?: Array<{
    providerName: string;
    endpoint?: string;
    circuitBreaker?: { failureThreshold?: number; resetTimeoutMs?: number };
    retry?: { maxRetries?: number; backoffBaseMs?: number };
  }>;
  settings?: { failMode?: 'open' | 'closed' };
  additionalGuardrails?: Guardrail[];
}

// Port interfaces
interface GuardrailCachePort {
  get(guardrailName: string, content: string, tier: string): Promise<unknown | null>;
  set(guardrailName: string, content: string, tier: string, result: unknown): Promise<void>;
}

interface CostCheckerPort {
  trackCost(guardrailName: string, costUsd: number, tier: string): Promise<void>;
  checkBudget(): Promise<{
    exceeded: boolean;
    action: 'downgrade' | 'allow' | 'none';
  }>;
}

interface WebhookPort {
  deliver(eventType: string, payload: unknown): Promise<void>;
}
```

#### Runtime (`apps/runtime`)

```typescript
// apps/runtime/src/services/guardrails/policy-resolver.ts
interface PolicyInput {
  tenantId: string;
  projectId: string;
  agentDefId: string;
  agentGuardrails: Guardrail[];
  tenantPolicies: PolicyData[];
  projectPolicies: PolicyData[];
}

interface ResolvedGuardrailPolicy {
  guardrails: Guardrail[];
  disabledGuardrails: string[];
  ruleOverrides: PolicyRule[];
  settings: PolicySettings;
  providerOverrides: ProviderOverride[];
}

// apps/runtime/src/services/guardrails/streaming-evaluator.ts
interface StreamingEvalEvent {
  type: 'pass' | 'violation' | 'terminate' | 'retract';
  evaluatedContent?: string;
  violation?: {
    guardrailName: string;
    action: GuardrailActionType;
    message: string;
  };
  retractContent?: string;
}
```

### Module Boundaries

```
packages/compiler (evaluation logic)
  |-- guardrails/pipeline.ts          Orchestrates 3-tier evaluation
  |-- guardrails/tier1-evaluator.ts   CEL expression evaluation
  |-- guardrails/tier2-evaluator.ts   Model provider dispatch
  |-- guardrails/tier3-evaluator.ts   LLM-based evaluation
  |-- guardrails/provider*.ts         Provider interface + registry
  |-- guardrails/action-*.ts          Action application + execution
  |-- guardrails/circuit-breaker.ts   Per-provider failure tracking
  |-- guardrails/types.ts             Core types (no runtime deps)

apps/runtime (infrastructure + integration)
  |-- services/guardrails/pipeline-factory.ts   Creates pipeline, loads providers
  |-- services/guardrails/policy-resolver.ts    4-layer merge
  |-- services/guardrails/streaming-evaluator.ts  Stream-time evaluation
  |-- services/guardrails/cache.ts              Redis cache
  |-- services/guardrails/cost-tracker.ts       Redis cost tracking
  |-- services/guardrails/port-adapters.ts      Compiler ports -> runtime
  |-- services/guardrails/webhook.ts            HMAC delivery
  |-- services/guardrails/trace-events.ts       Trace event factories
  |-- routes/guardrail-policies.ts              Policy CRUD
  |-- routes/guardrail-providers.ts             Provider CRUD

packages/database (persistence)
  |-- models/guardrail-policy.model.ts          Policy schema + indexes
  |-- models/guardrail-provider-config.model.ts Provider schema + indexes
  |-- constants/guardrail-adapters.ts           Adapter type constants

apps/studio (UI)
  |-- components/guardrails/*                   Policy + provider UI
  |-- components/admin/Guardrail*.tsx            Admin pages
  |-- hooks/useGuardrails.ts                    SWR hooks
  |-- app/api/admin/guardrail-*/route.ts        Studio proxy routes
```

---

## 2. Implementation Structure (As-Built)

### Compiler Layer (`packages/compiler`)

#### IR Schema (`packages/compiler/src/platform/ir/schema.ts`)

The `Guardrail` interface defines the compile-time representation with: `name`, `description`, `kind` (5 types), `priority`, `tier` (3 types), `check` (CEL), `llmCheck` (prompt), `provider`, `category`, `threshold`, `action` (GuardrailAction), `severityActions`.

#### Action Types (`packages/compiler/src/platform/ir/guardrail-action.ts`)

7 action types: `block`, `warn`, `redact`, `fix`, `reask`, `filter`, `escalate`. Terminal actions: `block`, `escalate`, `reask`. Each has specific parameters (e.g., `fixStrategy` for fix, `maxReasks` for reask, `redactMode` for redact).

#### Compile-Time Validator (`packages/compiler/src/platform/ir/guardrail-validator.ts`)

Enforces action-kind compatibility:

- `reask` only valid on `output` kind
- `fix` and `filter` not valid on `handoff` kind
- `fix` without `fixStrategy` emits warning

#### Pipeline Implementation (`packages/compiler/src/platform/guardrails/pipeline.ts`)

`GuardrailPipelineImpl.execute()` runs 3-tier evaluation:

1. Filter guardrails by `kind`
2. Apply policy: disable rules, threshold/action overrides, additional guardrails
3. Sort by priority (lower = first) within each tier
4. Tier 1: CEL evaluation in parallel. Terminal violation -> stop.
5. Tier 2: Provider dispatch in parallel. Terminal violation -> stop.
6. Tier 3: Injected LLM function. Terminal violation -> stop.
7. Apply actions (block/warn/fix/redact/reask/filter/escalate)
8. Aggregate results into `GuardrailPipelineResult`

#### Provider Registry (`packages/compiler/src/platform/guardrails/provider-registry.ts`)

Named registry with `register(name, provider)`, `get(name)`, `unregister(name)`, `listProviders()`.

#### Built-in Providers

| Provider            | File                             | Tier  | Cost   | Implementation                                              |
| ------------------- | -------------------------------- | ----- | ------ | ----------------------------------------------------------- |
| `builtin-pii`       | `providers/builtin-pii.ts`       | Model | Free   | Local PII pattern matching, returns score 0.0-1.0           |
| `openai-moderation` | `providers/openai-moderation.ts` | Model | Paid   | OpenAI Moderation API, maps categories to scores            |
| `openai-compatible` | `providers/openai-compatible.ts` | Model | Paid   | Generic OpenAI-compatible chat endpoint                     |
| `custom-http`       | `providers/custom-http.ts`       | Model | Varies | Custom HTTP POST with configurable request/response mapping |

### Runtime Layer (`apps/runtime`)

#### Pipeline Factory (`apps/runtime/src/services/guardrails/pipeline-factory.ts`)

Key responsibilities:

- **Tenant-scoped registries**: `Map<string, GuardrailProviderRegistry>` with max 200 entries, LRU eviction
- **Provider loading**: `ensureTenantProvidersLoaded()` loads from DB with 5-minute TTL cache, deduplicates concurrent loads via in-flight promise map, config fingerprinting for change detection
- **LLM eval adapter**: `createLLMEvalFromClient()` wraps `SessionLLMClient` for Tier 3, tries `validation` tier then falls back to `response_gen`
- **Policy resolution**: `resolveGuardrailPolicy()` loads from DB, delegates to `GuardrailPolicyResolver`, converts to `PipelinePolicy`
- **Port auto-wiring**: Creates `CacheAdapter` and `CostCheckerAdapter` from lazy singleton backing services
- **Cache invalidation**: `invalidateTenantProviderCache()` and `invalidateGuardrailEvalCache()` called on mutations

#### Policy Resolver (`apps/runtime/src/services/guardrails/policy-resolver.ts`)

4-layer merge:

1. Platform defaults (`failMode: 'open'`, default timeouts)
2. Tenant policies (base layer)
3. Project policies (overrides tenant)
4. Agent DSL guardrails (highest priority, always included)

Rule types: `disable` (removes), `define` (creates synthetic), `threshold`/`action`/`severity_actions` (overrides). Define rules never overwrite DSL-defined guardrails.

#### Streaming Evaluator (`apps/runtime/src/services/guardrails/streaming-evaluator.ts`)

Buffers tokens, evaluates at sentence boundaries (`/[.!?]\s/`) or chunk sizes (default 200 chars). Terminal violations (block/escalate) trigger early termination. `evaluateFinal()` checks remaining buffer.

#### Cache (`apps/runtime/src/services/guardrails/cache.ts`)

Redis-backed exact-match cache. Key: `guardrail:{tenantId}:{projectId}:{guardrailName}:{sha256_16}`. TTLs: local=86400s, model=3600s, llm=never. Invalidation via SCAN+DEL. All operations fail-open.

#### Cost Tracker (`apps/runtime/src/services/guardrails/cost-tracker.ts`)

Redis INCRBY with microdollars. Key: `guardrail:cost:{tenantId}:{projectId}:{YYYY-MM}`. 35-day TTL. Budget check returns exceeded flag and action.

#### Port Adapters (`apps/runtime/src/services/guardrails/port-adapters.ts`)

- `CacheAdapter`: binds tenantId/projectId to GuardrailCache
- `CostCheckerAdapter`: binds tenant/project/budget to CostTracker
- `WebhookAdapter`: delegates to WebhookDelivery with error swallowing

#### Webhook (`apps/runtime/src/services/guardrails/webhook.ts`)

HMAC-SHA256 signing, event filtering, exponential backoff retry (1s, 4s, 16s), SSRF validation, 10s timeout per attempt, traceparent header propagation.

#### Trace Events (`apps/runtime/src/services/guardrails/trace-events.ts`)

15 factory functions producing `GuardrailTraceEvent` objects. Types from `@agent-platform/observatory`.

### Database Layer (`packages/database`)

- `guardrail_policies` collection with `tenantIsolationPlugin`, UUIDv7 IDs, scoped indexes
- `tenant_guardrail_provider_configs` collection with 15 adapter types (4 implemented), tenant isolation

### Route Layer (`apps/runtime/src/routes/`)

- Policy routes: `/api/projects/:projectId/guardrail-policies` (CRUD + activate)
- Provider routes: `/api/tenants/:tenantId/guardrail-providers` (CRUD + test)
- Both use `authMiddleware` + `tenantRateLimit` + `requireFeature('guardrails')`
- Mutations trigger cache invalidation and audit logging

---

## 3. Remaining Work -- Phased Implementation Plan

### Phase 1: E2E Test Infrastructure (Priority: P0)

**Goal**: Build the runtime-level E2E test harness for guardrails.

**Exit Criteria**:

- [ ] E2E test bootstrap that starts Express on random port with full middleware
- [ ] Tenant + project + agent seeding via API
- [ ] At least 1 guardrail E2E test passing through full HTTP API

**File Changes**:

| File                                                                 | Change                                   | Risk |
| -------------------------------------------------------------------- | ---------------------------------------- | ---- |
| `apps/runtime/src/__tests__/guardrails/e2e/guardrail-e2e-helpers.ts` | NEW: E2E bootstrap, seeding, teardown    | Low  |
| `apps/runtime/src/__tests__/guardrails/e2e/builtin-pii-input.e2e.ts` | NEW: First E2E test (PII input blocking) | Low  |

### Phase 2: Provider x Kind E2E Matrix (Priority: P0)

**Goal**: Cover all implemented provider x kind combinations via runtime HTTP API.

**Exit Criteria**:

- [ ] `builtin_pii` x {input, output, tool_input, tool_output} E2E tests passing
- [ ] `custom_http` x {input, output} E2E tests passing (mock HTTP server)
- [ ] At least 10 provider-kind E2E combinations covered

**File Changes**:

| File                                                                  | Change                                        | Risk   |
| --------------------------------------------------------------------- | --------------------------------------------- | ------ |
| `apps/runtime/src/__tests__/guardrails/e2e/builtin-pii-matrix.e2e.ts` | NEW: PII provider across all 4 kinds          | Low    |
| `apps/runtime/src/__tests__/guardrails/e2e/custom-http-matrix.e2e.ts` | NEW: Custom HTTP provider across input/output | Medium |

### Phase 3: Multi-Tier Cascade E2E (Priority: P0)

**Goal**: Verify Tier 1 -> 2 -> 3 sequential evaluation with early termination via HTTP API.

**Exit Criteria**:

- [ ] Tier 1 block prevents Tier 2/3 execution (verified via trace events)
- [ ] All 3 tiers execute when Tier 1 passes
- [ ] Cost tracked across tiers

**File Changes**:

| File                                                                  | Change                                   | Risk   |
| --------------------------------------------------------------------- | ---------------------------------------- | ------ |
| `apps/runtime/src/__tests__/guardrails/e2e/multi-tier-cascade.e2e.ts` | NEW: Cascade E2E with trace verification | Medium |

### Phase 4: Policy Scoping E2E (Priority: P1)

**Goal**: Verify 4-level policy inheritance via API.

**Exit Criteria**:

- [ ] Tenant policy applies when no project/agent override exists
- [ ] Project policy overrides tenant for same guardrail name
- [ ] Agent DSL overrides project policy
- [ ] Disable rule removes guardrail

**File Changes**:

| File                                                              | Change                       | Risk   |
| ----------------------------------------------------------------- | ---------------------------- | ------ |
| `apps/runtime/src/__tests__/guardrails/e2e/policy-scoping.e2e.ts` | NEW: 4-level inheritance E2E | Medium |

### Phase 5: Streaming + Model Provider E2E (Priority: P1)

**Goal**: Verify streaming evaluation with model-tier provider.

**Exit Criteria**:

- [ ] Streaming output evaluated at sentence boundaries
- [ ] Terminal violation causes stream termination
- [ ] Non-terminal violation allows stream to continue

**File Changes**:

| File                                                                    | Change                             | Risk   |
| ----------------------------------------------------------------------- | ---------------------------------- | ------ |
| `apps/runtime/src/__tests__/guardrails/e2e/streaming-model-eval.e2e.ts` | NEW: Streaming with model provider | Medium |

### Phase 6: Action Coverage E2E (Priority: P1)

**Goal**: Cover reask and escalate actions via API.

**Exit Criteria**:

- [ ] Output guardrail with reask triggers LLM retry
- [ ] Escalate action emits escalation trace event
- [ ] Block, warn, redact, fix verified in E2E context

**File Changes**:

| File                                                               | Change                          | Risk   |
| ------------------------------------------------------------------ | ------------------------------- | ------ |
| `apps/runtime/src/__tests__/guardrails/e2e/action-coverage.e2e.ts` | NEW: All 7 actions E2E coverage | Medium |

### Phase 7: Infrastructure E2E (Priority: P2)

**Goal**: Cover circuit breaker, budget enforcement, cache invalidation via API.

**Exit Criteria**:

- [ ] Circuit breaker opens after N failures
- [ ] Budget exceeded triggers downgrade action
- [ ] Cache invalidation on policy update clears stale results

**File Changes**:

| File                                                                  | Change                              | Risk   |
| --------------------------------------------------------------------- | ----------------------------------- | ------ |
| `apps/runtime/src/__tests__/guardrails/e2e/circuit-breaker.e2e.ts`    | NEW: Circuit breaker E2E            | Medium |
| `apps/runtime/src/__tests__/guardrails/e2e/budget-enforcement.e2e.ts` | NEW: Budget + cost downgrade E2E    | Medium |
| `apps/runtime/src/__tests__/guardrails/e2e/cache-invalidation.e2e.ts` | NEW: Cache invalidation on mutation | Low    |

### Phase 8: Cross-Tenant Isolation E2E (Priority: P2)

**Goal**: Verify tenant isolation for policies and providers via full HTTP API.

**Exit Criteria**:

- [ ] Cross-tenant provider access returns 404
- [ ] Cross-tenant policy access returns 404
- [ ] Cross-project policy access returns 404
- [ ] Provider API key never leaked in response

**File Changes**:

| File                                                         | Change                         | Risk |
| ------------------------------------------------------------ | ------------------------------ | ---- |
| `apps/runtime/src/__tests__/guardrails/e2e/isolation.e2e.ts` | NEW: Cross-tenant/project 404s | Low  |

---

## 4. Known Gaps

| ID     | Description                                                          | Severity | Status | Phase to Address |
| ------ | -------------------------------------------------------------------- | -------- | ------ | ---------------- |
| GAP-1  | `projectId` hardcoded to `'default'` in pipeline factory auto-wiring | Medium   | Open   | Bug fix          |
| GAP-2  | WebhookAdapter not auto-wired from DB config                         | Medium   | Open   | Future work      |
| GAP-3  | 11 adapter types in DB enum with no runtime implementation           | Medium   | Open   | Future work      |
| GAP-4  | Semantic cache matching not implemented                              | Low      | Open   | Future work      |
| GAP-5  | Policy `timeouts` and `webhookUrl` settings not consumed             | Low      | Open   | Future work      |
| GAP-6  | No per-project aggregate budget tracking                             | Low      | Open   | Future work      |
| GAP-7  | E2E coverage gap: provider x kind matrix                             | High     | Open   | Phase 2          |
| GAP-8  | E2E coverage gap: multi-tier cascade                                 | High     | Open   | Phase 3          |
| GAP-9  | Audit tab in Studio UI is a stub                                     | Medium   | Open   | Future work      |
| GAP-10 | Streaming with real model provider untested                          | High     | Open   | Phase 5          |

---

## 5. Wiring Checklist

### Compiler -> Runtime Wiring

- [x] `GuardrailPipelineImpl` imported from `@abl/compiler` in `pipeline-factory.ts`
- [x] `GuardrailProviderRegistry` imported from `@abl/compiler` in `pipeline-factory.ts`
- [x] `CustomHTTPProvider` imported from `@abl/compiler` in `pipeline-factory.ts`
- [x] Port interfaces (`GuardrailCachePort`, `CostCheckerPort`, `WebhookPort`) imported from `@abl/compiler`
- [x] Guardrail IR types imported from `@abl/compiler` (Guardrail, GuardrailAction, PipelinePolicy)

### Runtime -> Database Wiring

- [x] `GuardrailPolicy` model imported in `guardrail-policies.ts` routes
- [x] `TenantGuardrailProviderConfig` model imported in `guardrail-providers.ts` routes
- [x] `IMPLEMENTED_GUARDRAIL_ADAPTER_TYPES` imported in provider routes for validation
- [x] Pipeline factory loads providers via `TenantGuardrailProviderConfig.find()`
- [x] Policy resolver loads policies via `GuardrailPolicy.find()`

### Runtime -> Studio Wiring

- [x] Studio `useGuardrailPolicies` hook calls runtime policy endpoints
- [x] Studio `useGuardrailProviders` hook calls runtime provider endpoints
- [x] Studio admin routes proxy to runtime API

### Execution -> Guardrails Wiring

- [x] `constraint-checker.ts` calls `createGuardrailPipeline()` for input validation
- [x] `reasoning-executor.ts` calls pipeline for output validation
- [x] Tool execution calls pipeline for tool_input and tool_output validation
- [x] Handoff orchestration calls pipeline for handoff validation

---

## 6. Rollback Strategy

1. **Immediate**: Set `GUARDRAILS_ENABLED=false` -- disables all pipeline evaluation without route changes
2. **Route-level**: Feature gate `requireFeature('guardrails')` returns 403 if guardrails tier not available
3. **Per-policy**: Set policy `status: 'archived'` to deactivate individual policies
4. **Per-provider**: Set provider `isActive: false` to soft-disable a provider
5. **Data cleanup**: No destructive rollback needed; policies and providers remain in DB

---

## 7. Key Files Reference

| File                                                              | Purpose                                                         |
| ----------------------------------------------------------------- | --------------------------------------------------------------- |
| `packages/compiler/src/platform/ir/schema.ts`                     | `Guardrail`, `GuardrailKind`, `GuardrailTier` type definitions  |
| `packages/compiler/src/platform/guardrails/pipeline.ts`           | `GuardrailPipelineImpl` -- 3-tier orchestrator                  |
| `packages/compiler/src/platform/guardrails/types.ts`              | Core types, `isTerminalAction()`, `createEmptyPipelineResult()` |
| `packages/compiler/src/platform/guardrails/tier1-evaluator.ts`    | Tier 1 local CEL evaluator                                      |
| `packages/compiler/src/platform/guardrails/tier2-evaluator.ts`    | Tier 2 model provider dispatch                                  |
| `packages/compiler/src/platform/guardrails/tier3-evaluator.ts`    | Tier 3 LLM evaluation with injection                            |
| `packages/compiler/src/platform/guardrails/provider.ts`           | `GuardrailModelProvider` interface                              |
| `packages/compiler/src/platform/guardrails/provider-registry.ts`  | Named provider registry                                         |
| `packages/compiler/src/platform/guardrails/circuit-breaker.ts`    | Per-provider CLOSED/OPEN/HALF_OPEN                              |
| `apps/runtime/src/services/guardrails/pipeline-factory.ts`        | Factory, registries, LLM adapter, policy resolution             |
| `apps/runtime/src/services/guardrails/policy-resolver.ts`         | 4-layer policy merge                                            |
| `apps/runtime/src/services/guardrails/streaming-evaluator.ts`     | Sentence/chunk boundary streaming evaluation                    |
| `apps/runtime/src/services/guardrails/cache.ts`                   | Redis cache with tier TTLs                                      |
| `apps/runtime/src/services/guardrails/cost-tracker.ts`            | Microdollar budget tracking                                     |
| `apps/runtime/src/services/guardrails/port-adapters.ts`           | Cache, cost, webhook port adapters                              |
| `apps/runtime/src/services/guardrails/webhook.ts`                 | HMAC-signed webhook delivery                                    |
| `apps/runtime/src/services/guardrails/trace-events.ts`            | 15 trace event factories                                        |
| `apps/runtime/src/routes/guardrail-policies.ts`                   | Policy CRUD + activate routes                                   |
| `apps/runtime/src/routes/guardrail-providers.ts`                  | Provider CRUD + test routes                                     |
| `packages/database/src/models/guardrail-policy.model.ts`          | GuardrailPolicy Mongoose model                                  |
| `packages/database/src/models/guardrail-provider-config.model.ts` | TenantGuardrailProviderConfig Mongoose model                    |
| `packages/database/src/constants/guardrail-adapters.ts`           | Adapter type constants (15 total, 4 implemented)                |
| `apps/studio/src/components/guardrails/GuardrailsConfigPage.tsx`  | 3-tab guardrails page                                           |
| `apps/studio/src/hooks/useGuardrails.ts`                          | SWR hooks for policies and providers                            |

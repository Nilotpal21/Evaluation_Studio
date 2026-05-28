# Feature Spec: Circuit Breaker — Resilience Patterns for External Service Calls

**Feature ID:** #44
**Status:** ALPHA
**Created:** 2026-03-22
**Last Updated:** 2026-03-22

---

## 1. Problem Statement

The ABL platform makes external service calls across multiple boundaries: LLM providers (OpenAI, Anthropic, Google), HTTP tool endpoints (webhooks, REST APIs), MCP servers, SearchAI connectors, and pipeline evaluation services. When any of these external dependencies experience degraded performance or outages, cascading failures propagate through the platform — blocking agent sessions, exhausting connection pools, and causing tenant-wide outages from a single provider failure.

**Current state:** The platform has **four independent, inconsistent circuit breaker implementations** with no unified strategy:

1. **`@agent-platform/circuit-breaker`** (Redis-backed, hierarchical, Lua-script atomic) — exists as a package but is **not wired** into runtime LLM calls or tool execution
2. **`packages/project-io/src/git/git-circuit-breaker.ts`** — lightweight in-memory, git-sync only
3. **`apps/runtime/src/services/pipeline/circuit-breaker.ts`** — in-memory per-tenant, pipeline LLM calls only
4. **`packages/pipeline-engine/src/pipeline/services/eval/eval-circuit-breakers.ts`** — in-memory with windowed failure counting, eval pipeline only

The **most critical call paths lack protection entirely**: runtime LLM calls (`SessionLLMClient`), HTTP tool execution, webhook delivery, and MCP server calls. A single LLM provider outage can block all agents for all tenants.

**Impact:**

- **Availability:** Provider outages cause cascading failures across unrelated tenants
- **Latency:** Requests queue behind hung external calls (up to 120s LLM timeout)
- **Resource exhaustion:** Connection pools and memory consumed by failing requests
- **No fallback:** LLM provider outage = complete agent unavailability

---

## 2. Scope

### In Scope

- **FR-CB-1:** Integrate `@agent-platform/circuit-breaker` (Redis-backed) into the runtime's `SessionLLMClient` for all LLM provider calls
- **FR-CB-2:** Integrate circuit breaker into HTTP tool execution (webhooks, REST API tools)
- **FR-CB-3:** Integrate circuit breaker into MCP server calls (`InlineMcpProvider`, `RuntimeMcpProvider`)
- **FR-CB-4:** Integrate circuit breaker into SearchAI connector sync operations
- **FR-CB-5:** LLM provider fallback — when primary provider circuit opens, attempt secondary provider if configured
- **FR-CB-6:** Per-tenant, per-provider circuit isolation (tenant A's OpenAI outage does not affect tenant B)
- **FR-CB-7:** Per-tenant, per-tool-service circuit isolation for HTTP tools and MCP servers
- **FR-CB-8:** Circuit breaker health API — `GET /api/projects/:projectId/circuit-breakers/health` returns state of all breakers for the tenant
- **FR-CB-9:** Admin force-reset API — `POST /api/admin/circuit-breakers/:tenantId/reset` for emergency manual override
- **FR-CB-10:** Circuit state change events emitted as `TraceEvent`s for observability
- **FR-CB-11:** DSL-level circuit breaker configuration for HTTP tools (`circuit_breaker:` block already parsed)
- **FR-CB-12:** Configurable thresholds per breaker level (tenant defaults + per-tenant overrides)
- **FR-CB-13:** Graceful degradation — open circuits return structured errors with retry-after hints, not generic 500s
- **FR-CB-14:** Consolidate the in-memory pipeline circuit breaker to use the Redis-backed implementation
- **FR-CB-15:** Studio UI health indicator showing circuit breaker state for connected services

### Out of Scope

- Custom circuit breaker logic in the compiler/DSL beyond the existing `circuit_breaker:` block
- Rate limiting (separate concern, already partially implemented)
- Retry logic (already handled by BullMQ for async jobs, Vercel AI SDK for LLM calls)
- Bulkhead/thread-pool isolation (future feature)
- Circuit breaker for internal service-to-service calls within the platform

---

## 3. User Stories

### US-CB-1: Platform Operator — LLM Provider Outage Resilience

**As a** platform operator,
**I want** the system to automatically detect LLM provider outages and stop sending requests to failing providers,
**So that** healthy providers and tenants are unaffected by a single provider's downtime.

**Acceptance Criteria:**

- Given OpenAI is returning 503 errors, when 10 consecutive failures occur within a 30s window, then the circuit opens for that tenant's OpenAI calls
- Given the circuit is open, when a new LLM call is requested, then the system attempts the fallback provider (if configured) or returns a structured error with `retryAfterMs`
- Given the circuit has been open for 60s, when the next request arrives, then one probe request is allowed through (half-open)
- Given the probe succeeds, then the circuit closes and normal operation resumes

### US-CB-2: Tenant Admin — Tool Service Resilience

**As a** tenant admin,
**I want** failing HTTP tool endpoints to be automatically bypassed,
**So that** one broken webhook doesn't block agent conversations.

**Acceptance Criteria:**

- Given an HTTP tool endpoint returns 5xx errors 10 times in 30s, then the tool's circuit opens
- Given the circuit is open, when the agent tries to use the tool, then it receives a structured error explaining the tool is temporarily unavailable
- Given the tool's circuit is open, other tools for the same agent continue working normally
- Circuit state is per-tenant per-tool-service, not global

### US-CB-3: Platform Operator — Monitoring Circuit Health

**As a** platform operator,
**I want** to see the circuit breaker state for all external dependencies,
**So that** I can proactively identify and respond to service degradation.

**Acceptance Criteria:**

- `GET /circuit-breakers/health` returns state for tenant, app, LLM provider, and tool service levels
- Each entry includes: state (CLOSED/OPEN/HALF_OPEN), failure count, failure rate, opened-at timestamp, retry-after-ms
- Circuit state changes emit `TraceEvent`s visible in the trace timeline

### US-CB-4: Platform Operator — Emergency Reset

**As a** platform operator,
**I want** to force-reset a stuck circuit breaker,
**So that** I can recover from false positives without restarting pods.

**Acceptance Criteria:**

- Admin API allows force-resetting all breakers for a tenant or a specific breaker key
- Reset action is logged as a `TraceEvent` with the operator identity
- Reset is atomic (Redis Lua script)

### US-CB-5: Developer — DSL-Configured Circuit Breaker

**As a** developer writing ABL tools,
**I want** to configure circuit breaker thresholds per tool in the DSL,
**So that** I can tune resilience settings for tools with different reliability profiles.

**Acceptance Criteria:**

- The existing `circuit_breaker: { threshold, reset_ms }` DSL block is respected at runtime
- DSL config overrides the default `tool_service` breaker config for that tool
- If no DSL config is provided, the platform default `tool_service` config applies

---

## 4. Functional Requirements

| ID       | Requirement                                                                                              | Priority | User Story       |
| -------- | -------------------------------------------------------------------------------------------------------- | -------- | ---------------- |
| FR-CB-1  | Integrate Redis-backed circuit breaker into `SessionLLMClient` for all `generateText`/`streamText` calls | P0       | US-CB-1          |
| FR-CB-2  | Integrate circuit breaker into HTTP tool execution path                                                  | P0       | US-CB-2          |
| FR-CB-3  | Integrate circuit breaker into MCP server call paths                                                     | P1       | US-CB-2          |
| FR-CB-4  | Integrate circuit breaker into SearchAI connector sync                                                   | P1       | US-CB-2          |
| FR-CB-5  | LLM provider fallback when primary circuit opens                                                         | P0       | US-CB-1          |
| FR-CB-6  | Per-tenant, per-provider isolation for LLM breakers                                                      | P0       | US-CB-1          |
| FR-CB-7  | Per-tenant, per-service isolation for tool breakers                                                      | P0       | US-CB-2          |
| FR-CB-8  | Health API endpoint for circuit breaker state                                                            | P1       | US-CB-3          |
| FR-CB-9  | Admin force-reset API                                                                                    | P1       | US-CB-4          |
| FR-CB-10 | TraceEvent emission on circuit state changes                                                             | P1       | US-CB-3          |
| FR-CB-11 | DSL `circuit_breaker:` config respected at runtime                                                       | P1       | US-CB-5          |
| FR-CB-12 | Configurable thresholds per level with per-tenant overrides                                              | P2       | US-CB-1          |
| FR-CB-13 | Structured error responses with retry-after hints                                                        | P0       | US-CB-1, US-CB-2 |
| FR-CB-14 | Consolidate pipeline in-memory breaker to Redis-backed                                                   | P2       | US-CB-1          |
| FR-CB-15 | Studio UI health indicator for circuit state                                                             | P2       | US-CB-3          |

---

## 5. Non-Functional Requirements

| ID       | Requirement                                 | Target                                                        |
| -------- | ------------------------------------------- | ------------------------------------------------------------- |
| NFR-CB-1 | Circuit state check latency                 | < 5ms (Redis round-trip via Lua script)                       |
| NFR-CB-2 | No data loss on circuit open                | Structured error returned, no silent drops                    |
| NFR-CB-3 | Cross-pod consistency                       | All pods share breaker state via Redis within 1 state check   |
| NFR-CB-4 | Memory bound for Redis keys                 | TTL on all breaker keys (monitorWindow + resetTimeout)        |
| NFR-CB-5 | Graceful degradation when Redis unavailable | Fall back to in-memory breaker (allow-all)                    |
| NFR-CB-6 | Observability                               | Every state transition logged + emitted as TraceEvent         |
| NFR-CB-7 | Zero config for basic protection            | Default thresholds work out-of-box, no tenant config required |

---

## 6. Existing Implementation Inventory

### `@agent-platform/circuit-breaker` Package (Production-Ready)

- **Location:** `packages/circuit-breaker/`
- **Type:** Redis-backed, Lua-script atomic transitions
- **Hierarchy:** `tenant` > `app` > `llm_provider` > `tool_service`
- **Key classes:** `CircuitBreakerRegistry`, `RedisCircuitBreaker`, `BreakerHandle`
- **Events:** `BreakerStateChangeEvent`, `BreakerExecutionEvent`
- **Error:** `CircuitOpenError` with `level`, `key`, `retryAfterMs`
- **Status:** Implemented and tested but NOT wired into runtime call paths

### Pipeline Circuit Breaker (In-Memory, Runtime)

- **Location:** `apps/runtime/src/services/pipeline/circuit-breaker.ts`
- **Type:** In-memory, per-tenant Map with LRU eviction (max 500)
- **Gap:** Not distributed, state lost on pod restart

### Eval Circuit Breakers (In-Memory, Pipeline Engine)

- **Location:** `packages/pipeline-engine/src/pipeline/services/eval/eval-circuit-breakers.ts`
- **Type:** In-memory with windowed failure counting, ring buffer for recent errors
- **Gap:** Not distributed, duplicates core logic

### Git Circuit Breaker (In-Memory, Project IO)

- **Location:** `packages/project-io/src/git/git-circuit-breaker.ts`
- **Type:** Simple in-memory, per-instance
- **Status:** Appropriate for its use case (git sync is per-request)

### DSL Integration

- **Location:** `packages/shared/src/tools/dsl-property-parser.ts` (line 396)
- **Parses:** `circuit_breaker: { threshold, reset_ms }` from tool DSL
- **Form type:** `HttpToolFormData.circuitBreaker: { threshold: number; resetMs: number }`
- **Gap:** Parsed and serialized in Studio but NOT consumed at runtime

---

## 7. Risk Assessment

| Risk                                                       | Impact | Likelihood | Mitigation                                                           |
| ---------------------------------------------------------- | ------ | ---------- | -------------------------------------------------------------------- |
| Redis unavailability breaks all circuit breakers           | High   | Medium     | NFR-CB-5: in-memory fallback (allow-all)                             |
| False positives open circuits during normal traffic spikes | High   | Medium     | Windowed failure counting + minimum request count threshold          |
| Circuit breaker adds latency to every external call        | Medium | Low        | Lua scripts are O(1), ~2ms overhead                                  |
| Stale circuit state after Redis key expiry                 | Medium | Low        | Keys auto-created on next call, default to CLOSED                    |
| Per-tenant overrides create config sprawl                  | Low    | Medium     | Sensible defaults, overrides stored in Redis alongside breaker state |

---

## 8. Decision Log

| Decision                                                                  | Classification | Rationale                                                                                                   |
| ------------------------------------------------------------------------- | -------------- | ----------------------------------------------------------------------------------------------------------- |
| Use existing `@agent-platform/circuit-breaker` package, do not create new | ANSWERED       | Package already implements Redis-backed hierarchical breakers with Lua scripts                              |
| Keep git circuit breaker in-memory (do not migrate)                       | DECIDED        | Git sync is per-request, in-memory is appropriate. No cross-pod coordination needed                         |
| Fallback only for LLM providers, not tool services                        | DECIDED        | Tools are user-configured endpoints — no guaranteed fallback exists. LLM providers have known alternates    |
| Consolidation of pipeline/eval breakers is P2                             | DECIDED        | They work adequately for their narrow scope; runtime integration is the critical gap                        |
| DSL `circuit_breaker:` config overrides tool_service defaults             | INFERRED       | Follows existing pattern of DSL-level tool config (timeout, retry, rate_limit) overriding platform defaults |

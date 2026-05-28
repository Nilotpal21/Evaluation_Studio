# LLD & Implementation Plan: Circuit Breaker — Resilience Patterns for External Service Calls

**Feature ID:** #44
**Status:** PLANNED
**Created:** 2026-03-22
**Feature Spec:** `docs/features/circuit-breaker.md`
**Test Spec:** `docs/testing/circuit-breaker.md`
**HLD:** `docs/specs/circuit-breaker.hld.md`

---

## Phase Overview

| Phase | Name                        | Description                                                  | Dependencies | Est. Effort |
| ----- | --------------------------- | ------------------------------------------------------------ | ------------ | ----------- |
| 1     | Foundation & Singleton      | CircuitBreakerRegistry singleton, feature flag, Redis wiring | None         | S           |
| 2     | LLM Provider Integration    | Wrap SessionLLMClient calls, provider fallback               | Phase 1      | M           |
| 3     | HTTP Tool Integration       | Wrap tool execution, DSL config override                     | Phase 1      | M           |
| 4     | MCP Server Integration      | Wrap MCP provider calls                                      | Phase 1      | S           |
| 5     | Health & Admin API          | Health endpoint, admin force-reset                           | Phase 1      | M           |
| 6     | Observability & TraceEvents | Event-to-TraceEvent bridge, logging                          | Phase 1      | S           |
| 7     | Tests & Verification        | E2E + integration tests                                      | Phases 1-6   | L           |

---

## Phase 1: Foundation & Singleton

**Goal:** Create the `CircuitBreakerRegistry` singleton and wire it to the runtime's Redis connection. Establish the feature flag for safe rollout.

### Task 1.1: Add `@agent-platform/circuit-breaker` to runtime dependencies

**Files:**

- Modify: `apps/runtime/package.json`

**Steps:**

- [ ] Add `"@agent-platform/circuit-breaker": "workspace:*"` to `dependencies`
- [ ] Run `pnpm install` to update lockfile
- [ ] Run `pnpm build --filter=@agent-platform/circuit-breaker` to ensure package builds

### Task 1.2: Create CircuitBreakerRegistry singleton

**Files:**

- Create: `apps/runtime/src/services/circuit-breaker-singleton.ts`

**Steps:**

- [ ] Read `packages/circuit-breaker/src/registry.ts` to verify `CircuitBreakerRegistry` constructor signature
- [ ] Read the runtime's Redis client module to find the correct import path for `getRedisClient`
- [ ] Create singleton module with lazy initialization:

  ```typescript
  import { CircuitBreakerRegistry } from '@agent-platform/circuit-breaker';
  import { createLogger } from '@abl/compiler/platform';

  const log = createLogger('circuit-breaker-singleton');

  let registry: CircuitBreakerRegistry | null = null;

  export function getCircuitBreakerRegistry(): CircuitBreakerRegistry | null {
    if (!isCircuitBreakerEnabled()) return null;
    if (!registry) {
      try {
        const redis = getRedisClient();
        registry = new CircuitBreakerRegistry(redis, {
          defaults: {
            llm_provider: buildLlmProviderConfig(),
            tool_service: buildToolServiceConfig(),
          },
        });
        log.info('CircuitBreakerRegistry initialized');
      } catch (err) {
        log.error('Failed to initialize CircuitBreakerRegistry', {
          error: err instanceof Error ? err.message : String(err),
        });
        return null;
      }
    }
    return registry;
  }

  function isCircuitBreakerEnabled(): boolean {
    return process.env.CIRCUIT_BREAKER_ENABLED !== 'false';
  }
  ```

- [ ] Add env-var-based config overrides: `CB_LLM_FAILURE_THRESHOLD`, `CB_LLM_RESET_TIMEOUT_MS`, `CB_TOOL_FAILURE_THRESHOLD`, `CB_TOOL_RESET_TIMEOUT_MS`
- [ ] Export `resetRegistryForTesting()` for test cleanup
- [ ] Run `pnpm build --filter=@agent-platform/runtime`

### Task 1.3: Add Dockerfile dependency line

**Files:**

- Modify: `apps/runtime/Dockerfile`
- Modify: `apps/search-ai/Dockerfile` (if SearchAI uses it)

**Steps:**

- [ ] Add `COPY packages/circuit-breaker/package.json packages/circuit-breaker/package.json` line to each Dockerfile that uses `pnpm install --frozen-lockfile`

### Exit Criteria Phase 1:

- [ ] `getCircuitBreakerRegistry()` returns a valid `CircuitBreakerRegistry` when `CIRCUIT_BREAKER_ENABLED=true` and Redis is available
- [ ] Returns `null` when `CIRCUIT_BREAKER_ENABLED=false`
- [ ] Returns `null` (with error log) when Redis is unavailable
- [ ] `pnpm build --filter=@agent-platform/runtime` passes
- [ ] Unit test covers enabled/disabled/Redis-error scenarios

---

## Phase 2: LLM Provider Integration

**Goal:** Wrap all `SessionLLMClient` LLM calls in the circuit breaker with provider fallback.

### Task 2.1: Identify LLM call sites in SessionLLMClient

**Files:**

- Read: `apps/runtime/src/services/llm/session-llm-client.ts`

**Steps:**

- [ ] Read the full `SessionLLMClient` implementation
- [ ] Identify `generateText()` and `streamText()` call sites
- [ ] Identify how `tenantId` and `providerName` are available in the call context
- [ ] Identify the existing error handling pattern

### Task 2.2: Wrap LLM calls in circuit breaker

**Files:**

- Modify: `apps/runtime/src/services/llm/session-llm-client.ts`

**Steps:**

- [ ] Import `getCircuitBreakerRegistry` from the singleton module
- [ ] Import `CircuitOpenError` from `@agent-platform/circuit-breaker`
- [ ] Extract `tenantId` and `providerName` from the session/model context
- [ ] Wrap `generateText()` call:
  ```typescript
  const registry = getCircuitBreakerRegistry();
  if (registry) {
    return await registry.llmProvider(tenantId, providerName).execute(() =>
      generateText({ model, messages, tools, ... })
    );
  }
  // Fallback: no circuit breaker, direct call
  return await generateText({ model, messages, tools, ... });
  ```
- [ ] Wrap `streamText()` call similarly
- [ ] Handle `CircuitOpenError`:
  - If fallback provider is configured, attempt fallback
  - If not, throw structured error with `retryAfterMs`
- [ ] Ensure error extraction follows the pattern: `err instanceof Error ? err.message : String(err)`

### Task 2.3: Implement LLM provider fallback

**Files:**

- Modify: `apps/runtime/src/services/llm/session-llm-client.ts`

**Steps:**

- [ ] Read `ModelResolutionService` to understand how provider models are resolved
- [ ] When `CircuitOpenError` is caught for primary provider:
  1. Determine fallback provider name (if primary is 'openai', try 'anthropic' and vice versa — or read from tenant config)
  2. Attempt to resolve fallback model via `ModelResolutionService`
  3. If fallback model available, call through `registry.llmProvider(tenantId, fallbackProvider).execute(...)`
  4. If fallback also fails (CircuitOpenError or execution error), return structured error
- [ ] Log fallback attempt: `log.info('LLM provider fallback attempted', { primary, fallback, tenantId })`
- [ ] Log fallback success/failure

### Task 2.4: Unit test for SessionLLMClient circuit breaker integration

**Files:**

- Create: `apps/runtime/src/services/llm/__tests__/session-llm-client-circuit-breaker.test.ts`

**Steps:**

- [ ] Test: LLM call succeeds normally when circuit is CLOSED
- [ ] Test: Circuit opens after failure threshold, next call throws CircuitOpenError
- [ ] Test: Fallback provider attempted on primary CircuitOpenError
- [ ] Test: Structured error returned when both primary and fallback fail
- [ ] Test: No circuit breaker wrapping when `CIRCUIT_BREAKER_ENABLED=false`
- [ ] Run `pnpm build --filter=@agent-platform/runtime && pnpm test --filter=@agent-platform/runtime`

### Exit Criteria Phase 2:

- [ ] All `generateText()` and `streamText()` calls are wrapped in circuit breaker
- [ ] LLM provider fallback works when primary circuit opens
- [ ] Structured error with `retryAfterMs` returned when all providers unavailable
- [ ] No regression in existing LLM client tests
- [ ] Build passes

---

## Phase 3: HTTP Tool Integration

**Goal:** Wrap HTTP tool execution in circuit breaker with DSL config override support.

### Task 3.1: Identify HTTP tool execution path

**Files:**

- Read: `apps/runtime/src/services/execution/` — find the HTTP tool executor
- Read: `apps/runtime/src/tools/` — check for tool execution logic

**Steps:**

- [ ] Locate the function that makes HTTP calls for tools
- [ ] Identify how `tenantId` and tool endpoint URL are available
- [ ] Identify how DSL properties (timeout, retry, circuit_breaker) are passed through

### Task 3.2: Derive toolServiceKey from endpoint

**Steps:**

- [ ] Parse the tool's endpoint URL to extract the hostname
- [ ] Use `{tenantId}:{hostname}` as the `toolServiceKey`
- [ ] Handle edge cases: IP addresses, localhost, ports
- [ ] Create a utility function: `deriveToolServiceKey(tenantId: string, endpoint: string): string`

### Task 3.3: Wrap HTTP tool calls in circuit breaker

**Files:**

- Modify: HTTP tool executor identified in Task 3.1

**Steps:**

- [ ] Import `getCircuitBreakerRegistry` and `CircuitOpenError`
- [ ] Before making the HTTP call:
  1. Check if DSL `circuit_breaker` config exists on the tool
  2. If yes, create a tenant-override breaker with DSL thresholds
  3. If no, use default `tool_service` level breaker
  4. Wrap the HTTP call: `registry.toolService(tenantId, toolServiceKey).execute(() => httpCall(...))`
- [ ] On `CircuitOpenError`, return a structured tool error:
  ```typescript
  {
    error: `Tool service '${toolName}' temporarily unavailable (circuit open). Retry after ${error.retryAfterMs}ms.`,
    retryAfterMs: error.retryAfterMs,
  }
  ```
- [ ] Ensure other tools for the same agent are not affected

### Task 3.4: DSL circuit_breaker config override

**Steps:**

- [ ] Read `packages/shared/src/tools/dsl-property-parser.ts` to verify the parsed `circuit_breaker` shape
- [ ] Read how DSL properties flow from compilation to runtime (IR → tool definition → executor)
- [ ] Map DSL `threshold` to `failureThreshold` and `reset_ms` to `resetTimeout`
- [ ] Apply as per-tenant override via `registry.setTenantOverride()` or direct config merge

### Task 3.5: Unit test for HTTP tool circuit breaker

**Files:**

- Create: `apps/runtime/src/services/execution/__tests__/tool-circuit-breaker.test.ts`

**Steps:**

- [ ] Test: HTTP tool call succeeds when circuit CLOSED
- [ ] Test: Circuit opens after tool endpoint failures
- [ ] Test: Structured tool error returned on circuit open
- [ ] Test: DSL config override (threshold: 3 instead of default 10)
- [ ] Test: Other tools unaffected by one tool's circuit
- [ ] Test: `deriveToolServiceKey` correctly extracts hostname

### Exit Criteria Phase 3:

- [ ] HTTP tool calls wrapped in circuit breaker
- [ ] DSL `circuit_breaker:` config respected at runtime
- [ ] Tool-level isolation verified (one tool's circuit does not affect others)
- [ ] Build passes
- [ ] Tests pass

---

## Phase 4: MCP Server Integration

**Goal:** Wrap MCP server calls in circuit breaker.

### Task 4.1: Identify MCP call sites

**Files:**

- Read: `apps/runtime/src/services/mcp/inline-mcp-provider.ts`
- Read: `apps/runtime/src/services/mcp/runtime-mcp-provider.ts`

**Steps:**

- [ ] Identify the method that makes outbound calls to MCP servers
- [ ] Identify how the MCP server URL/name is available
- [ ] Determine appropriate `toolServiceKey` for MCP servers

### Task 4.2: Wrap MCP calls in circuit breaker

**Files:**

- Modify: `apps/runtime/src/services/mcp/inline-mcp-provider.ts`
- Modify: `apps/runtime/src/services/mcp/runtime-mcp-provider.ts`

**Steps:**

- [ ] Import `getCircuitBreakerRegistry` and `CircuitOpenError`
- [ ] Use `tool_service` level with key `{tenantId}:{mcpServerName}`
- [ ] Wrap the MCP call:
  ```typescript
  const registry = getCircuitBreakerRegistry();
  if (registry) {
    return await registry
      .toolService(tenantId, mcpServerKey)
      .execute(() => mcpClient.callTool(toolName, args));
  }
  return await mcpClient.callTool(toolName, args);
  ```
- [ ] On `CircuitOpenError`, return structured MCP tool error

### Task 4.3: Unit test for MCP circuit breaker

**Files:**

- Create: `apps/runtime/src/services/mcp/__tests__/mcp-circuit-breaker.test.ts`

**Steps:**

- [ ] Test: MCP call succeeds when circuit CLOSED
- [ ] Test: Circuit opens after MCP server failures
- [ ] Test: Structured error returned on circuit open
- [ ] Test: Different MCP servers have independent circuits

### Exit Criteria Phase 4:

- [ ] MCP server calls wrapped in circuit breaker
- [ ] Per-server circuit isolation verified
- [ ] Build and tests pass

---

## Phase 5: Health & Admin API

**Goal:** Add REST endpoints for monitoring circuit state and emergency reset.

### Task 5.1: Create health endpoint route

**Files:**

- Create: `apps/runtime/src/routes/circuit-breaker.ts`

**Steps:**

- [ ] Read existing route patterns in `apps/runtime/src/routes/` for middleware conventions
- [ ] Create route module with:
  ```
  GET /api/projects/:projectId/circuit-breakers/health
  ```
- [ ] Use `requireProjectPermission` middleware (or the appropriate auth middleware used in the runtime)
- [ ] Call `registry.getTenantHealth(tenantId)` and return the result
- [ ] Handle case where registry is null (circuit breaker disabled): return `{ success: true, data: { disabled: true } }`

### Task 5.2: Create admin reset endpoint

**Files:**

- Modify or create: admin route file in `apps/runtime/src/routes/`

**Steps:**

- [ ] Create route:
  ```
  POST /api/admin/circuit-breakers/:tenantId/reset
  ```
- [ ] Use admin-level auth middleware
- [ ] Validate request body with Zod:
  ```typescript
  const resetSchema = z.object({
    targetState: z.enum(['CLOSED', 'OPEN', 'HALF_OPEN']),
    level: z.enum(['tenant', 'app', 'llm_provider', 'tool_service']).optional(),
    key: z.string().min(1).optional(),
  });
  ```
- [ ] If `level` and `key` provided: reset specific breaker
- [ ] If only `targetState`: reset all breakers for tenant via `forceResetTenant()`
- [ ] Log the reset action with operator identity

### Task 5.3: Register routes

**Files:**

- Modify: `apps/runtime/src/routes/index.ts` (or equivalent route registration file)

**Steps:**

- [ ] Import and mount the new circuit breaker routes
- [ ] Ensure static route registration order (before parameterized routes)

### Task 5.4: Tests for API endpoints

**Files:**

- Create: `apps/runtime/src/routes/__tests__/circuit-breaker-routes.test.ts`

**Steps:**

- [ ] Test: Health endpoint returns circuit state
- [ ] Test: Health endpoint returns `disabled: true` when feature flag off
- [ ] Test: Admin reset endpoint resets circuit
- [ ] Test: Admin reset requires admin auth (403 for non-admin)
- [ ] Test: Tenant isolation — tenant A cannot see tenant B's circuits

### Exit Criteria Phase 5:

- [ ] Health endpoint returns accurate circuit state per tenant
- [ ] Admin reset endpoint works with proper auth
- [ ] Zod validation on request bodies
- [ ] Build and tests pass

---

## Phase 6: Observability & TraceEvents

**Goal:** Bridge circuit breaker events to the platform's TraceEvent system.

### Task 6.1: Create event-to-TraceEvent bridge

**Files:**

- Create: `apps/runtime/src/services/circuit-breaker-trace-bridge.ts`

**Steps:**

- [ ] Read `apps/runtime/src/services/trace-emitter.ts` to understand the TraceEvent emission pattern
- [ ] Read `apps/runtime/src/services/trace-event-types.ts` for existing event type definitions
- [ ] Create bridge function:
  ```typescript
  export function emitBreakerTraceEvent(event: BreakerEvent): void {
    if ('from' in event && 'to' in event) {
      // BreakerStateChangeEvent
      traceEmitter.emit({
        type: 'circuit_breaker_state_change',
        level: event.level,
        key: event.key,
        from: event.from,
        to: event.to,
        failureCount: event.failureCount,
        failureRate: event.failureRate,
        timestamp: event.timestamp,
      });
    }
  }
  ```
- [ ] Register bridge in the singleton module: `registry.onEvent(emitBreakerTraceEvent)`

### Task 6.2: Add circuit breaker TraceEvent type

**Files:**

- Modify: `apps/runtime/src/services/trace-event-types.ts`

**Steps:**

- [ ] Add `'circuit_breaker_state_change'` to the TraceEvent type union
- [ ] Define the event payload shape

### Task 6.3: Structured logging for all state transitions

**Steps:**

- [ ] Verify the singleton's event listener logs all state changes
- [ ] Log format: `log.warn('Circuit breaker state change', { level, key, from, to, failureCount })`
- [ ] Log `info` for CLOSED transitions, `warn` for OPEN transitions

### Exit Criteria Phase 6:

- [ ] Circuit state changes emit TraceEvents
- [ ] All state transitions are logged
- [ ] Build passes

---

## Phase 7: Tests & Verification

**Goal:** Implement E2E and integration tests per the test spec. Verify end-to-end functionality.

### Task 7.1: Integration tests

**Files:**

- Create: `apps/runtime/src/__tests__/circuit-breaker-integration.test.ts`

**Steps:**

- [ ] INT-CB-1: Registry wired into SessionLLMClient
- [ ] INT-CB-2: DSL config override
- [ ] INT-CB-3: Event system
- [ ] INT-CB-4: Redis unavailability fallback
- [ ] INT-CB-5: BreakerHandle getMetrics
- [ ] INT-CB-6: TenantHealth aggregation
- [ ] INT-CB-7: Concurrent half-open probe limiting

### Task 7.2: E2E tests

**Files:**

- Create: `apps/runtime/src/__tests__/circuit-breaker-e2e.test.ts`

**Steps:**

- [ ] E2E-CB-1: LLM circuit opens after threshold
- [ ] E2E-CB-2: LLM provider fallback
- [ ] E2E-CB-3: HTTP tool circuit opens
- [ ] E2E-CB-4: Health API returns correct state
- [ ] E2E-CB-5: Admin force-reset
- [ ] E2E-CB-6: Half-open probe after timeout
- [ ] E2E-CB-7: Half-open probe failure re-opens
- [ ] E2E-CB-8: Tenant isolation

### Task 7.3: Full build and test verification

**Steps:**

- [ ] Run `pnpm build` (full monorepo)
- [ ] Run `pnpm test --filter=@agent-platform/runtime`
- [ ] Run `pnpm test --filter=@agent-platform/circuit-breaker`
- [ ] Verify no regressions in existing test suites
- [ ] Run `npx prettier --write` on all changed files
- [ ] Run `./tools/run-semgrep.sh` for security scan

### Exit Criteria Phase 7:

- [ ] All 8 E2E tests pass
- [ ] All 7 integration tests pass
- [ ] No regressions in existing test suites
- [ ] Full build passes
- [ ] Security scan clean

---

## Wiring Checklist

This checklist ensures all integration points are connected:

| Wiring Point                      | Source                            | Target                            | Verified |
| --------------------------------- | --------------------------------- | --------------------------------- | -------- |
| Runtime → circuit-breaker package | `apps/runtime/package.json`       | `@agent-platform/circuit-breaker` | [ ]      |
| Singleton → Redis                 | `circuit-breaker-singleton.ts`    | `getRedisClient()`                | [ ]      |
| SessionLLMClient → Singleton      | `session-llm-client.ts`           | `getCircuitBreakerRegistry()`     | [ ]      |
| Tool Executor → Singleton         | HTTP tool executor                | `getCircuitBreakerRegistry()`     | [ ]      |
| MCP Provider → Singleton          | MCP provider files                | `getCircuitBreakerRegistry()`     | [ ]      |
| Health Route → App                | Route registration file           | Express router mount              | [ ]      |
| Admin Route → App                 | Route registration file           | Express router mount              | [ ]      |
| Event Bridge → Singleton          | `circuit-breaker-trace-bridge.ts` | `registry.onEvent()`              | [ ]      |
| TraceEvent Type → Types           | `trace-event-types.ts`            | Type union                        | [ ]      |
| Dockerfile → package.json         | `apps/runtime/Dockerfile`         | COPY circuit-breaker/package.json | [ ]      |

---

## Risk Mitigation During Implementation

| Risk                              | Mitigation                                                                                    |
| --------------------------------- | --------------------------------------------------------------------------------------------- |
| Breaking existing LLM call flow   | Feature flag defaults to `true`, but `null` registry check skips circuit breaker entirely     |
| Redis connection issues in tests  | Use `ioredis-mock` for unit/integration, real Redis only for E2E                              |
| Vercel AI SDK wrapper complexity  | Keep circuit breaker wrapping at the outermost layer — do not interleave with streaming logic |
| Tool executor signature diversity | Abstract the circuit breaker wrapping into a utility function `withToolCircuitBreaker()`      |
| Premature optimization concerns   | Phase 1 establishes foundation with minimal overhead — measure before optimizing              |

---

## File Change Summary

### New Files (9)

1. `apps/runtime/src/services/circuit-breaker-singleton.ts`
2. `apps/runtime/src/services/circuit-breaker-trace-bridge.ts`
3. `apps/runtime/src/routes/circuit-breaker.ts`
4. `apps/runtime/src/services/llm/__tests__/session-llm-client-circuit-breaker.test.ts`
5. `apps/runtime/src/services/execution/__tests__/tool-circuit-breaker.test.ts`
6. `apps/runtime/src/services/mcp/__tests__/mcp-circuit-breaker.test.ts`
7. `apps/runtime/src/routes/__tests__/circuit-breaker-routes.test.ts`
8. `apps/runtime/src/__tests__/circuit-breaker-integration.test.ts`
9. `apps/runtime/src/__tests__/circuit-breaker-e2e.test.ts`

### Modified Files (8-10)

1. `apps/runtime/package.json` — add dependency
2. `apps/runtime/Dockerfile` — add COPY line
3. `apps/runtime/src/services/llm/session-llm-client.ts` — wrap LLM calls
4. `apps/runtime/src/services/execution/<tool-executor>.ts` — wrap HTTP tool calls
5. `apps/runtime/src/services/mcp/inline-mcp-provider.ts` — wrap MCP calls
6. `apps/runtime/src/services/mcp/runtime-mcp-provider.ts` — wrap MCP calls
7. `apps/runtime/src/routes/index.ts` — register new routes
8. `apps/runtime/src/services/trace-event-types.ts` — add event type

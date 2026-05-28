# Feature Test Guide: Health Checks / Readiness Probes

**Feature**: Standardized liveness, readiness, and startup probes across all Node.js services with dependency health matrix, graceful shutdown coordination, and health metrics export
**Owner**: Platform team
**Branch**: develop
**Related Feature Doc**: [docs/features/health-checks.md](../features/health-checks.md)
**First audited**: 2026-03-23
**Last updated**: 2026-03-23
**Overall status**: NOT TESTED

---

## Current State (as of 2026-03-23)

Health checking across the ABL platform is fragmented and inconsistent. Runtime has a `/health` endpoint that checks MongoDB and reports ClickHouse/Redis status, plus a `/health/ready` endpoint that gates on shutdown state, heap pressure, MongoDB (when `OBS_STRICT_READINESS_GATES=true`), and Redis ping. SearchAI has a `/health` endpoint checking dual-MongoDB and a `/health/ready` that gates on shutdown and database availability. SearchAI-Runtime has a minimal `/health` returning uptime and database connection status with no readiness or startup probes.

No service has a `/health/startup` probe. Response formats are inconsistent (`{ status: 'healthy' }` vs `{ status: 'ok' }` vs `{ ok: true }`). No health metrics are exported to OpenTelemetry. The platform-admin system-health endpoint aggregates service status via HTTP probes and native checks (MongoDB, Redis, ClickHouse) but uses an auth-gated route unsuitable for Kubernetes probes.

There are no dedicated health check test files. The existing `/health` and `/health/ready` behavior is tested indirectly through server startup tests and wiring tests, but not through probe-specific test suites that verify dependency failure scenarios, shutdown coordination, or response schema compliance.

### Quick Health Dashboard

| Area                                             | Status     | Last Verified | Notes                                                                         |
| ------------------------------------------------ | ---------- | ------------- | ----------------------------------------------------------------------------- |
| Runtime `/health` liveness endpoint              | PARTIAL    | indirect      | Returns 200 with MongoDB check; no event-loop check; no standardized format   |
| Runtime `/health/ready` readiness endpoint       | PARTIAL    | indirect      | Checks shutdown, heap, MongoDB (gated), Redis; no startup completion gate     |
| Runtime `/health/startup` startup probe          | NOT TESTED | --            | Does not exist yet                                                            |
| SearchAI `/health` liveness endpoint             | PARTIAL    | indirect      | Checks dual-MongoDB; returns ad-hoc format                                    |
| SearchAI `/health/ready` readiness endpoint      | PARTIAL    | indirect      | Checks shutdown + database; no BullMQ worker or Redis check                   |
| SearchAI-Runtime health endpoints                | PARTIAL    | indirect      | Only `/health` exists; no readiness or startup probe                          |
| Studio health endpoints                          | NOT TESTED | --            | May have `/api/health`; no dedicated tests                                    |
| Admin health endpoints                           | NOT TESTED | --            | May have `/api/health`; no dedicated tests                                    |
| Multimodal Service health endpoints              | NOT TESTED | --            | Minimal or missing                                                            |
| Workflow Engine health endpoints                 | NOT TESTED | --            | Referenced in service registry; not verified                                  |
| Standardized JSON response format                | NOT TESTED | --            | Responses vary across services; no schema validation                          |
| HealthCheckRegistry shared framework             | NOT TESTED | --            | Does not exist yet                                                            |
| Dependency health matrix (per-service)           | NOT TESTED | --            | Runtime has ad-hoc checks; no formal matrix or criticality classification     |
| Circuit-breaker integration with health signals  | NOT TESTED | --            | No integration exists                                                         |
| Graceful shutdown + readiness coordination       | NOT TESTED | --            | SIGTERM sets flag in Runtime/SearchAI but readiness delay is not configurable |
| WebSocket connection draining during shutdown    | NOT TESTED | --            | Close frames sent but drain timeout not verified                              |
| BullMQ worker graceful stop during shutdown      | NOT TESTED | --            | `stopWorkers()` called but in-flight job completion not verified              |
| Health metrics export (OTel gauges/histograms)   | NOT TESTED | --            | No health metrics exist                                                       |
| Platform-admin health aggregation (standardized) | PARTIAL    | indirect      | Endpoint exists with service registry; not using standardized format          |
| Admin portal health dashboard                    | NOT TESTED | --            | Does not exist yet                                                            |
| Kubernetes probe configuration validation        | NOT TESTED | --            | No Helm values or staging validation                                          |

---

## Coverage Matrix

| FR    | Description                                                        | Unit       | Integration | E2E        | Manual     | Status      |
| ----- | ------------------------------------------------------------------ | ---------- | ----------- | ---------- | ---------- | ----------- |
| FR-1  | All services expose /health, /health/ready, /health/startup        | NOT TESTED | NOT TESTED  | NOT TESTED | NOT TESTED | Not Started |
| FR-2  | Liveness performs shallow check only (no deps, < 2s)               | NOT TESTED | NOT TESTED  | NOT TESTED | NOT TESTED | Not Started |
| FR-3  | Readiness checks all critical dependencies, returns 503 on failure | NOT TESTED | NOT TESTED  | NOT TESTED | NOT TESTED | Not Started |
| FR-4  | Startup returns 503 until initialization complete                  | NOT TESTED | NOT TESTED  | NOT TESTED | NOT TESTED | Not Started |
| FR-5  | Standardized JSON response schema on all endpoints                 | NOT TESTED | NOT TESTED  | NOT TESTED | NOT TESTED | Not Started |
| FR-6  | Dependency matrix with critical vs non-critical classification     | NOT TESTED | NOT TESTED  | NOT TESTED | NOT TESTED | Not Started |
| FR-7  | Readiness returns 503 immediately on SIGTERM before shutdown       | NOT TESTED | NOT TESTED  | NOT TESTED | NOT TESTED | Not Started |
| FR-8  | Shared HealthCheckRegistry in packages/shared-kernel               | NOT TESTED | NOT TESTED  | NOT TESTED | N/A        | Not Started |
| FR-9  | Readiness check caching (configurable TTL, default 5s)             | NOT TESTED | NOT TESTED  | NOT TESTED | N/A        | Not Started |
| FR-10 | Platform-admin aggregation with standardized format                | NOT TESTED | NOT TESTED  | NOT TESTED | NOT TESTED | Not Started |
| FR-11 | OTel metrics export (status gauge + latency histogram)             | NOT TESTED | NOT TESTED  | NOT TESTED | NOT TESTED | Not Started |
| FR-12 | Dependency unhealthy -> structured log + circuit-breaker trigger   | NOT TESTED | NOT TESTED  | NOT TESTED | N/A        | Not Started |
| FR-13 | WebSocket close frame + drain period during graceful shutdown      | NOT TESTED | NOT TESTED  | NOT TESTED | NOT TESTED | Not Started |
| FR-14 | BullMQ worker stop + in-flight job completion during shutdown      | NOT TESTED | NOT TESTED  | NOT TESTED | NOT TESTED | Not Started |
| FR-15 | Liveness/readiness unauthenticated; details/admin authenticated    | NOT TESTED | NOT TESTED  | NOT TESTED | NOT TESTED | Not Started |
| FR-16 | Per-dependency configurable check timeouts                         | NOT TESTED | NOT TESTED  | NOT TESTED | N/A        | Not Started |

---

## E2E Test Scenarios (minimum 5)

### E2E-1: All probes pass — healthy Runtime with all dependencies available

**Preconditions**: Runtime server started on random port (`{ port: 0 }`) with real MongoDB, Redis, and ClickHouse connections. Full initialization sequence completed (DB connected, workers started, background probes running).

**Steps**:

1. GET `/health` — assert HTTP 200.
2. Assert response body matches standardized schema: `{ status: 'pass', version: <string>, uptime: <number>, checks: {} }`.
3. Assert response Content-Type includes `application/json`.
4. Assert response latency < 100ms (liveness must be shallow and fast).
5. GET `/health/ready` — assert HTTP 200.
6. Assert response body: `{ status: 'pass', checks: { mongodb: [{ status: 'pass' }], redis: [{ status: 'pass' }] } }`.
7. Assert readiness check latency < 5s.
8. GET `/health/startup` — assert HTTP 200.
9. Assert response body: `{ status: 'pass' }`.
10. GET `/health/details` with valid platform-admin auth headers — assert HTTP 200.
11. Assert details response includes per-dependency latency measurements, component types, and timestamps.

**Expected Result**: All three probes return pass status. The details endpoint provides granular dependency information. Response format is standardized across all endpoints.

**Auth Context**: Liveness, readiness, and startup probes are unauthenticated. Details endpoint uses `Authorization: Bearer <platform-admin-token>`.

**Isolation Check**: N/A (infrastructure-level check, no tenant context).

---

### E2E-2: Dependency failure degrades readiness — MongoDB unavailable

**Preconditions**: Runtime server started on random port with MongoDB, Redis, and ClickHouse. MongoDB is a critical dependency in the dependency matrix.

**Steps**:

1. GET `/health/ready` — assert HTTP 200 (all dependencies healthy).
2. Disconnect MongoDB (stop container or close connection).
3. Wait for readiness cache TTL to expire (default 5s, use `HEALTH_CHECK_CACHE_TTL_MS=1000` for faster test).
4. GET `/health/ready` — assert HTTP 503.
5. Assert response body: `{ status: 'fail', checks: { mongodb: [{ status: 'fail', output: <error message> }] } }`.
6. GET `/health` — assert HTTP 200 (liveness is still passing; process is alive).
7. Reconnect MongoDB.
8. Wait for cache TTL to expire.
9. GET `/health/ready` — assert HTTP 200 (readiness recovers).
10. Assert structured log contains health transition events: `mongodb: pass -> fail` and `mongodb: fail -> pass`.

**Expected Result**: MongoDB failure causes readiness to fail while liveness continues passing. Readiness recovers when MongoDB reconnects. Health transitions are logged.

**Auth Context**: No auth required for probe endpoints.

**Isolation Check**: N/A (infrastructure-level scenario).

---

### E2E-3: Graceful shutdown — readiness fails before connections drain

**Preconditions**: Runtime server started on random port. A WebSocket client connected via `/ws/sdk`. An HTTP request in-flight (long-running agent execution mock).

**Steps**:

1. GET `/health/ready` — assert HTTP 200 (healthy).
2. Establish WebSocket connection to `/ws/sdk` — assert connected.
3. Send SIGTERM to the Runtime process.
4. Within 1 second, GET `/health/ready` — assert HTTP 503 with `{ status: 'fail', output: 'shutting_down' }`.
5. Assert GET `/health` still returns HTTP 200 (process is alive during drain).
6. Assert WebSocket client receives close frame with code 1001 and reason "Server shutting down" within `SHUTDOWN_WS_DRAIN_TIMEOUT_MS`.
7. Assert the Runtime process exits cleanly (exit code 0) within `SHUTDOWN_FORCE_TIMEOUT_MS`.
8. Assert no new HTTP connections are accepted after step 3 (new GET `/health` returns connection refused or timeout).

**Expected Result**: Readiness fails immediately on SIGTERM. WebSocket connections receive close frames. The process exits cleanly after draining. The ordering is: readiness fail -> connection drain -> server close -> process exit.

**Auth Context**: No auth for probes. WebSocket connection uses SDK auth.

**Isolation Check**: N/A (infrastructure-level shutdown scenario).

---

### E2E-4: Startup sequencing — startup probe gates liveness and readiness

**Preconditions**: Runtime server started on random port but with a _delayed_ MongoDB connection (e.g., MongoDB starts after a 10-second delay, or use a mock that delays `connect()`).

**Steps**:

1. Immediately after server process starts (before MongoDB connects), GET `/health/startup` — assert HTTP 503 with `{ status: 'fail', output: 'initializing' }`.
2. GET `/health/ready` — assert HTTP 503 (readiness should also fail before startup completes).
3. GET `/health` — assert HTTP 200 (liveness should pass as soon as the HTTP server is listening).
4. Wait for MongoDB to connect and initialization to complete.
5. GET `/health/startup` — assert HTTP 200 with `{ status: 'pass' }`.
6. GET `/health/ready` — assert HTTP 200 (readiness passes now that startup is complete and deps are healthy).
7. Subsequent GET `/health/startup` calls continue to return 200 for the lifetime of the process.

**Expected Result**: The startup probe gates readiness. Liveness passes independently. Once startup completes, the startup probe never returns to fail state (it is a one-way transition). Kubernetes would use this to prevent premature liveness kills during slow startups.

**Auth Context**: No auth required.

**Isolation Check**: N/A (infrastructure-level startup scenario).

---

### E2E-5: Health aggregation — admin endpoint reports multi-service status

**Preconditions**: Runtime server started on random port. At least one additional service (SearchAI) started on a separate random port. Runtime's `SERVICE_REGISTRY` configured to point to the SearchAI instance.

**Steps**:

1. GET `/api/platform/admin/system-health` with platform-admin auth — assert HTTP 200.
2. Assert response body contains `{ success: true, services: [...], summary: { healthy: N, degraded: N, down: N, unknown: N, total: N } }`.
3. Assert the services array contains an entry for Runtime (status: 'healthy', checkMethod: 'self').
4. Assert the services array contains an entry for SearchAI (status: 'healthy', latencyMs: > 0).
5. Assert each service entry includes `id`, `name`, `group`, `status`, `latencyMs`, `lastCheck`, `configured`, and `dependsOn` fields.
6. Stop the SearchAI server.
7. GET `/api/platform/admin/system-health` again — assert SearchAI entry shows status: 'down'.
8. Assert the summary counts update accordingly (one fewer healthy, one more down).

**Expected Result**: The admin aggregation endpoint provides a comprehensive view of all platform services. When a service goes down, its status is accurately reflected. Summary counts are correct.

**Auth Context**: Requires `requirePlatformAdmin()` + `requirePlatformAdminIp()` middleware. Use valid platform admin credentials.

**Isolation Check**: The endpoint is platform-level, not tenant-scoped. A regular tenant auth token should return 403 or 401.

---

### E2E-6: Non-critical dependency failure — service remains ready with warning

**Preconditions**: Runtime server started on random port. ClickHouse is configured as a non-critical dependency (analytics can degrade gracefully). MongoDB and Redis are critical.

**Steps**:

1. GET `/health/ready` — assert HTTP 200 with `{ status: 'pass' }`.
2. Disconnect ClickHouse (stop container or simulate connection failure).
3. Wait for cache TTL expiry.
4. GET `/health/ready` — assert HTTP 200 with `{ status: 'warn', checks: { clickhouse: [{ status: 'fail' }], mongodb: [{ status: 'pass' }], redis: [{ status: 'pass' }] } }`.
5. Assert the overall status is `warn` (not `fail`) because only a non-critical dependency is down.
6. Verify the service continues to accept and process regular API requests (agent execution works, analytics writes are skipped).
7. Reconnect ClickHouse.
8. Wait for cache TTL expiry.
9. GET `/health/ready` — assert HTTP 200 with `{ status: 'pass' }`.

**Expected Result**: Non-critical dependency failure degrades the service to `warn` status but does not remove it from load balancing (HTTP 200 is returned). Only critical dependency failures return 503.

**Auth Context**: No auth for probes.

**Isolation Check**: N/A (infrastructure-level scenario).

---

### E2E-7: Standardized response format validation across services

**Preconditions**: Runtime, SearchAI, and SearchAI-Runtime servers started on random ports.

**Steps**:

1. For each service, GET `/health` and validate response against the schema: `{ status: 'pass' | 'fail' | 'warn', version?: string, uptime?: number }`.
2. For each service, GET `/health/ready` and validate response against the schema: `{ status: 'pass' | 'fail' | 'warn', checks?: Record<string, Array<{ componentId?: string, componentType?: string, status: 'pass' | 'fail' | 'warn', observedValue?: number, observedUnit?: string, time?: string, output?: string }>> }`.
3. For each service, GET `/health/startup` and validate response against the schema: `{ status: 'pass' | 'fail' }`.
4. Assert HTTP status codes are consistent: 200 for pass/warn, 503 for fail.
5. Assert Content-Type is `application/json` for all responses.
6. Assert no response contains internal hostnames, connection strings, or credentials.

**Expected Result**: All services use the same response schema. No information leakage in unauthenticated endpoints.

**Auth Context**: All probes are unauthenticated.

**Isolation Check**: N/A (schema validation scenario).

---

## Integration Test Scenarios (minimum 5)

### INT-1: HealthCheckRegistry — registration, execution, and timeout isolation

**Boundary**: `HealthCheckRegistry` class in `packages/shared-kernel`.

**Setup**: Create a `HealthCheckRegistry` instance. Register three checks: `fast-check` (resolves in 10ms), `slow-check` (resolves in 3s), `timeout-check` (never resolves, simulating a hung dependency).

**Steps**:

1. Register `fast-check` with `timeoutMs: 5000, critical: true`.
2. Register `slow-check` with `timeoutMs: 5000, critical: false`.
3. Register `timeout-check` with `timeoutMs: 1000, critical: true`.
4. Call `registry.runReadiness()`.
5. Assert `fast-check` result: `{ status: 'pass' }`.
6. Assert `slow-check` result: `{ status: 'pass' }` (completed within timeout).
7. Assert `timeout-check` result: `{ status: 'fail', output: 'Health check timed out after 1000ms' }`.
8. Assert overall readiness status is `fail` (because `timeout-check` is critical and failed).
9. Assert total readiness execution time is approximately 3s (bounded by `slow-check`, not blocked by `timeout-check` since it timed out at 1s).

**Expected Result**: Checks run in parallel. Individual timeouts prevent a hung check from blocking others. Critical check failure causes overall readiness failure.

**Failure Mode**: If `Promise.allSettled` is not used, a thrown check could prevent other results from being collected.

---

### INT-2: Readiness check caching — prevents check storms

**Boundary**: `HealthCheckRegistry` caching mechanism.

**Setup**: Create a `HealthCheckRegistry` with `HEALTH_CHECK_CACHE_TTL_MS=2000`. Register a check that increments a counter each time it is called.

**Steps**:

1. Call `registry.runReadiness()` — assert check counter = 1, result cached.
2. Immediately call `registry.runReadiness()` again — assert check counter still = 1 (cached result returned).
3. Assert the second call returns the same result object as the first.
4. Wait 2.1 seconds (cache expires).
5. Call `registry.runReadiness()` — assert check counter = 2 (fresh check executed).
6. Call `registry.markShuttingDown()`.
7. Call `registry.runReadiness()` — assert returns `{ status: 'fail' }` immediately without running checks (shutdown overrides cache).

**Expected Result**: Caching prevents redundant dependency checks. Cache is bypassed when shutting down.

**Failure Mode**: If cache invalidation on shutdown is missing, Kubernetes could continue routing traffic to a shutting-down pod.

---

### INT-3: Event loop liveness check — detects blocked event loop

**Boundary**: Event loop check utility in `packages/shared-kernel`.

**Setup**: Import the event loop check function.

**Steps**:

1. Call `checkEventLoop(100)` (100ms timeout) with an idle event loop — assert returns `{ status: 'pass' }`.
2. Block the event loop with a synchronous `while` loop for 200ms.
3. During the block, call `checkEventLoop(100)` from a pre-scheduled `setTimeout` — assert returns `{ status: 'fail', output: 'Event loop blocked' }`.
4. After the block releases, call `checkEventLoop(100)` again — assert returns `{ status: 'pass' }`.

**Expected Result**: The check detects when the event loop is blocked and recovers when it is free.

**Failure Mode**: If `setImmediate` is used instead of `setTimeout`, the check may not detect CPU-bound blocks correctly on all Node.js versions.

---

### INT-4: Graceful shutdown ordering — readiness fails before server.close()

**Boundary**: Runtime server shutdown sequence.

**Setup**: Start Runtime server on random port. Connect a test HTTP client.

**Steps**:

1. GET `/health/ready` — assert HTTP 200.
2. Send SIGTERM to the process (or call `shutdownRuntimeServer({ exitProcess: false })`).
3. Immediately (within 100ms) GET `/health/ready` — assert HTTP 503.
4. Assert the HTTP server is still accepting connections (GET `/health` returns 200) for up to `SHUTDOWN_READINESS_DELAY_MS`.
5. After `SHUTDOWN_READINESS_DELAY_MS`, assert new connections are refused (server.close() has been called).
6. Assert shutdown completes without hanging (within `SHUTDOWN_FORCE_TIMEOUT_MS`).
7. Verify shutdown log events are emitted in order: "readiness failed", "server closing", "WebSocket drain", "database disconnect", "shutdown complete".

**Expected Result**: Readiness fails immediately. There is a configurable delay before the server stops accepting connections (allowing Kubernetes to propagate endpoint removal). Shutdown events are logged in the correct order.

**Failure Mode**: If readiness delay is missing, Kubernetes may still route traffic to the pod after server.close() is called, causing connection refused errors.

---

### INT-5: Circuit-breaker integration — dependency health failure opens breaker

**Boundary**: `HealthCheckRegistry` + `HybridCircuitBreakerRegistry` integration.

**Setup**: Create a `HealthCheckRegistry` with circuit-breaker sync enabled. Register a dependency check for `clickhouse` that can be toggled to fail. Create a corresponding circuit breaker for ClickHouse writes.

**Steps**:

1. Run readiness check — `clickhouse` passes, circuit breaker is CLOSED.
2. Toggle ClickHouse check to fail.
3. Run readiness check — `clickhouse` fails.
4. Assert circuit breaker for ClickHouse has transitioned to OPEN state.
5. Assert structured log contains `{ event: 'circuit_breaker_opened', dependency: 'clickhouse', trigger: 'health_check' }`.
6. Toggle ClickHouse check to pass.
7. Run readiness check — `clickhouse` passes.
8. Assert circuit breaker transitions to HALF-OPEN, then CLOSED after success threshold.

**Expected Result**: Health check failures automatically trigger circuit-breaker state transitions. Recovery is also automatic when health checks pass.

**Failure Mode**: If the integration is one-directional (health -> breaker but not breaker -> health), the readiness probe may not reflect circuit-breaker state.

---

### INT-6: Platform-admin aggregation with mixed service states

**Boundary**: `platform-admin-health.ts` route handler + `SERVICE_REGISTRY`.

**Setup**: Start Runtime on random port. Mock HTTP responses for registered services: SearchAI returns 200, Studio returns 503, ClickHouse returns connection refused.

**Steps**:

1. GET `/api/platform/admin/system-health` with platform-admin auth.
2. Assert Runtime entry: `status: 'healthy'` (self-check).
3. Assert MongoDB entry: `status: 'healthy'` (native check via mongoose).
4. Assert SearchAI entry: `status: 'healthy'` (mocked HTTP 200).
5. Assert Studio entry: `status: 'degraded'` (mocked HTTP 503).
6. Assert ClickHouse entry: `status: 'down'` (connection refused).
7. Assert summary: `{ healthy: 3, degraded: 1, down: 1 }` (or similar counts based on full registry).
8. Assert each entry includes `latencyMs > 0` and `lastCheck` ISO timestamp.
9. Assert response completes within 10s (even with connection-refused services timing out at 4s).

**Expected Result**: The aggregation endpoint correctly reports mixed states. Per-check timeouts prevent the entire request from hanging. Summary counts are accurate.

**Failure Mode**: If checks run serially instead of in parallel, the aggregation could exceed the HTTP timeout when multiple services are unresponsive.

---

### INT-7: Dependency check timeout does not block other checks

**Boundary**: `HealthCheckRegistry` parallel execution.

**Setup**: Register a check that takes 10s (exceeds its 3s timeout) and a check that takes 50ms.

**Steps**:

1. Call `registry.runReadiness()`.
2. Measure total execution time.
3. Assert total time is approximately 3s (bounded by the slow check's timeout), not 10s.
4. Assert the fast check completed successfully.
5. Assert the slow check returned `{ status: 'fail', output: 'timed out' }`.

**Expected Result**: `AbortController` timeouts and `Promise.allSettled` ensure slow or hung checks are cut off without blocking others.

**Failure Mode**: Without `AbortController`, the timeout promise resolves but the actual check continues consuming resources.

---

## Manual Verification Scenarios

### MANUAL-1: Rolling deployment zero-downtime verification

**Setup**: Kubernetes cluster with 3 Runtime pods behind a Service. Load generator sending steady traffic.

**Steps**:

1. Start a rolling deployment (update image tag or trigger restart).
2. Monitor error rate during the rollout.
3. Verify that no 5xx errors occur during pod replacement.
4. Verify that Kubernetes events show readiness probes failing before pods are terminated.
5. Verify that new pods pass startup probes before receiving traffic.

**Expected Result**: Zero 5xx errors during rolling deployment. Pod lifecycle events match expected probe behavior.

---

### MANUAL-2: Admin portal health dashboard verification

**Setup**: Admin portal running and authenticated as platform admin.

**Steps**:

1. Navigate to `/admin/system-health`.
2. Verify all configured services are displayed with status indicators (green/yellow/red).
3. Verify the dependency tree visualization shows correct relationships.
4. Stop a service (e.g., SearchAI).
5. Verify the dashboard updates within 15-30 seconds to show the service as "down".
6. Restart the service.
7. Verify the dashboard recovers to "healthy" status.
8. Click on a service card to verify the drill-down shows dependency details and latency.

**Expected Result**: Dashboard accurately reflects real-time service health with auto-refresh.

---

## Test Infrastructure Requirements

### Docker Compose Test Profile

E2E and integration tests require a Docker Compose profile with:

- MongoDB (port 27017)
- Redis (port 6379)
- ClickHouse (port 8123 for HTTP, 9000 for native)
- A second Redis instance for testing Redis failure/recovery scenarios

### Test Utilities

- **Server harness**: Starts Runtime/SearchAI on random ports with configurable dependency availability.
- **Dependency toggle**: Ability to disconnect/reconnect individual dependencies (MongoDB, Redis, ClickHouse) during test execution.
- **WebSocket test client**: Connects to `/ws/sdk` and validates close frame receipt during shutdown.
- **Schema validator**: JSON Schema or Zod validator for the standardized health response format.

### Environment Variable Overrides for Testing

| Variable                       | Test Value | Purpose                                         |
| ------------------------------ | ---------- | ----------------------------------------------- |
| `HEALTH_CHECK_CACHE_TTL_MS`    | `500`      | Speed up cache expiry for test assertions       |
| `SHUTDOWN_READINESS_DELAY_MS`  | `1000`     | Reduce shutdown delay for faster test execution |
| `SHUTDOWN_WS_DRAIN_TIMEOUT_MS` | `2000`     | Reduce WebSocket drain wait for faster tests    |
| `SHUTDOWN_FORCE_TIMEOUT_MS`    | `10000`    | Reduce force-exit timeout for faster tests      |
| `OBS_STRICT_READINESS_GATES`   | `true`     | Enable strict MongoDB readiness gate            |

---

## Anti-Patterns to Avoid

1. **No mocking codebase components in E2E tests**: Do not mock `HealthCheckRegistry`, `mongoose.connection`, or `getRedisClient()`. Use real database connections and test dependency failures by stopping/starting actual containers or connections.
2. **No direct DB access in E2E tests**: Seed data via API endpoints. Assert health via HTTP responses, not by querying internal state.
3. **No TODO stubs**: Every test file must have working infrastructure. `// TODO: add MongoDB failure test` is not acceptable.
4. **No testing health endpoints through middleware mocks**: Start real Express servers with the full middleware chain. Health endpoints must exercise the actual auth exclusion (unauthenticated), the actual dependency checks, and the actual response serialization.
5. **No hardcoded ports**: Always use `{ port: 0 }` for test servers. Health check tests must not conflict with running development servers.

---

## Test Priority and Execution Order

| Priority | Test ID | Rationale                                                                  |
| -------- | ------- | -------------------------------------------------------------------------- |
| P0       | INT-1   | HealthCheckRegistry is the foundation; everything else depends on it       |
| P0       | INT-2   | Caching prevents check storms; critical for production probe frequency     |
| P0       | E2E-1   | Happy path validation; proves the three-probe model works end-to-end       |
| P1       | E2E-2   | Dependency failure is the most common real-world scenario                  |
| P1       | E2E-3   | Graceful shutdown is critical for zero-downtime deployments                |
| P1       | INT-4   | Shutdown ordering must be verified to prevent dropped requests             |
| P1       | E2E-4   | Startup probe prevents premature liveness kills (common production issue)  |
| P2       | INT-3   | Event loop check adds defense-in-depth for liveness                        |
| P2       | E2E-5   | Admin aggregation is an operator workflow, not a Kubernetes-critical path  |
| P2       | INT-5   | Circuit-breaker integration is a future enhancement                        |
| P2       | E2E-6   | Non-critical dependency classification is a refinement of basic readiness  |
| P3       | E2E-7   | Schema validation is important but can be a post-implementation audit      |
| P3       | INT-6   | Admin aggregation integration is lower priority than per-service probes    |
| P3       | INT-7   | Timeout isolation is an edge case; basic timeout behavior covered in INT-1 |

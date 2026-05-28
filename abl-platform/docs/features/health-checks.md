# Feature: Health Checks / Readiness Probes

**Doc Type**: MAJOR FEATURE
**Parent Feature**: N/A
**Status**: PLANNED
**Feature Area(s)**: `observability`, `enterprise`, `admin operations`
**Package(s)**: `apps/runtime`, `apps/search-ai`, `apps/search-ai-runtime`, `apps/studio`, `apps/admin`, `apps/multimodal-service`, `apps/crawler-mcp-server`, `apps/workflow-engine`, `packages/shared-kernel`, `packages/config`
**Owner(s)**: `Platform team`
**Testing Guide**: [docs/testing/health-checks.md](../testing/health-checks.md)
**Last Updated**: 2026-03-23

---

## 1. Introduction / Overview

### Problem Statement

The ABL platform runs 7+ services across multiple Kubernetes pods, each depending on shared infrastructure (MongoDB, Redis, ClickHouse, Qdrant, OpenSearch, Neo4j) and external providers (LLM APIs, OAuth endpoints). Today, health checking is inconsistent across services:

- **Runtime** has a `/health` endpoint that checks MongoDB and reports ClickHouse/Redis status, plus a `/health/ready` endpoint that gates on shutdown state, heap pressure, MongoDB, and Redis. However, there is no `/startup` probe, no standardized response format, and no circuit-breaker integration.
- **SearchAI** has a `/health` endpoint checking dual-MongoDB and a `/health/ready` that gates on shutdown and database availability. It lacks dependency-specific health (Redis, ClickHouse, BullMQ workers).
- **SearchAI-Runtime** has a minimal `/health` returning uptime and database status with no readiness probe.
- **Studio**, **Admin**, **Multimodal Service**, and **Crawler MCP Server** have ad-hoc or missing health endpoints.
- **Python services** (Docling, BGE-M3, Preprocessing) are checked by Runtime's admin health endpoint via HTTP but do not expose standardized probes.

The platform admin health endpoint (`/api/platform/admin/system-health`) aggregates service status but requires platform-admin authentication, making it unsuitable for Kubernetes probes. Graceful shutdown exists in Runtime, SearchAI, SearchAI-Runtime, and Multimodal Service but lacks coordination with readiness probes (the readiness probe should fail _before_ connections start draining). There is no startup probe to protect slow-starting services from premature liveness kills, no health-based circuit-breaker integration, no standardized health response schema, and no health metrics export for SLA dashboards.

SREs cannot answer "is this pod safe to receive traffic?" or "which dependency is degraded?" without SSH-ing into pods or reading scattered logs.

### Goal Statement

Deliver a unified, Kubernetes-native health check framework across all ABL services that provides standardized `/health` (liveness), `/health/ready` (readiness), and `/health/startup` (startup) probe endpoints with a consistent JSON response schema inspired by the IETF Health Check Response Format draft (RFC draft-inadarei-api-health-check-06). Integrate health signals with circuit breakers for graceful degradation, export health metrics for SLA reporting, and provide a platform-admin aggregation endpoint for the admin dashboard.

### Summary

Health Checks / Readiness Probes is the platform's foundational observability layer for service availability. It introduces:

1. **Three-probe model** per service: liveness (process alive), readiness (can serve traffic), startup (initialization complete).
2. **Dependency health matrix**: each service declares its dependencies and checks them with configurable timeouts, feeding into readiness decisions.
3. **Standardized response format**: consistent JSON schema with status, version, uptime, checks (per-dependency), and links.
4. **Circuit-breaker integration**: unhealthy dependencies trigger circuit-breaker state transitions for graceful degradation instead of hard failures.
5. **Graceful shutdown coordination**: SIGTERM sets a shutdown flag that immediately fails readiness probes, drains in-flight requests and WebSocket connections, stops BullMQ workers, flushes buffers, and closes database connections in dependency order.
6. **Health aggregation**: a platform-admin endpoint and admin-portal dashboard showing real-time health across all services and dependencies.
7. **Health metrics export**: OpenTelemetry gauges and counters for probe results, dependency latency, and failure rates, enabling SLA dashboards and alerting.

---

## 2. Scope

### Goals

- Standardize health check endpoints (`/health`, `/health/ready`, `/health/startup`) across all Node.js services (Runtime, SearchAI, SearchAI-Runtime, Studio, Admin, Multimodal Service, Crawler MCP Server, Workflow Engine).
- Define a dependency health matrix per service with configurable check timeouts and failure thresholds.
- Adopt a standardized JSON response format inspired by IETF RFC draft-inadarei-api-health-check-06 with `status`, `version`, `uptime`, `checks`, and `output` fields.
- Integrate health signals with the existing circuit-breaker framework (`HybridCircuitBreakerRegistry`) so that dependency failures trigger graceful degradation.
- Coordinate graceful shutdown with readiness probes: readiness fails immediately on SIGTERM, then connections drain within `terminationGracePeriodSeconds`.
- Provide recommended Kubernetes probe configurations (timing, thresholds) for each service in a shared Helm values template.
- Export health check results as OpenTelemetry metrics (gauges for status, histograms for check latency) for SLA reporting.
- Enhance the existing platform-admin system-health endpoint with the new standardized format and expose it in the admin portal dashboard.

### Non-Goals (Out of Scope)

- Health checks for external LLM providers (OpenAI, Anthropic, etc.) -- these are covered by the circuit-breaker feature and provider-specific error handling.
- Health checks for third-party SaaS integrations (HubSpot, Salesforce connectors) -- these are connector-specific concerns.
- Implementing health checks inside Python services (Docling, BGE-M3, Preprocessing) -- those services are owned by ML/infra teams and already expose basic `/health` endpoints. This feature covers _probing_ them from Node.js services.
- Automatic remediation or self-healing (e.g., restarting a crashed dependency) -- that is the Kubernetes controller's responsibility based on probe signals.
- Per-tenant health isolation (one tenant's workload cannot degrade another tenant's health checks) is addressed by ensuring health checks never touch tenant data or acquire tenant-scoped locks, but per-tenant "is my agent healthy?" is out of scope.

---

## 3. User Stories

1. As an `SRE`, I want every service to expose a `/health/ready` endpoint that returns 503 when critical dependencies are unavailable so that Kubernetes automatically removes unhealthy pods from the load balancer.
2. As an `SRE`, I want a `/health/startup` probe on slow-starting services so that Kubernetes does not kill pods that are still initializing (loading caches, running migrations, warming connections).
3. As a `platform operator`, I want a single aggregated health dashboard in the admin portal showing all services and their dependency statuses so that I can diagnose outages without SSH-ing into individual pods.
4. As a `Kubernetes orchestrator`, I want standardized probe configurations (initialDelaySeconds, periodSeconds, failureThreshold, timeoutSeconds) documented per service so that Helm charts can be configured correctly.
5. As a `developer`, I want a shared `HealthCheckRegistry` class that I can use to register dependency checks in any service so that I do not need to reimplement health checking logic per service.
6. As a `monitoring system`, I want health check results exported as OpenTelemetry gauges so that I can build SLA dashboards and set up PagerDuty alerts when services degrade.
7. As an `SRE`, I want readiness probes to fail immediately when a SIGTERM is received so that no new traffic is routed to a pod that is shutting down, preventing request failures during rolling deployments.
8. As a `developer`, I want health check responses to include dependency-level details (MongoDB latency, Redis status, ClickHouse probe result) so that I can quickly identify which dependency is causing a service degradation.
9. As a `platform operator`, I want health checks integrated with circuit breakers so that when a dependency (e.g., ClickHouse) goes down, the service degrades gracefully (disabling analytics writes) instead of returning 503 for all requests.
10. As an `SRE`, I want WebSocket connections to be drained gracefully during shutdown (close frame sent, in-flight messages completed) so that SDK clients can reconnect to healthy pods without data loss.
11. As a `platform operator`, I want BullMQ workers to stop accepting new jobs and complete in-flight jobs before pod termination so that no ingestion or processing jobs are lost during deployments.
12. As a `security engineer`, I want the detailed health check endpoint (with dependency details) to be authentication-gated while the Kubernetes probe endpoints remain unauthenticated so that internal infrastructure details are not leaked to unauthenticated callers.

---

## 4. Functional Requirements

1. **FR-1**: Every Node.js service must expose `GET /health` (liveness), `GET /health/ready` (readiness), and `GET /health/startup` (startup) endpoints that return HTTP 200 on success and HTTP 503 on failure.
2. **FR-2**: The liveness endpoint (`/health`) must perform only a shallow check (process is alive, event loop is responsive) and must complete within 2 seconds. It must NOT check external dependencies.
3. **FR-3**: The readiness endpoint (`/health/ready`) must check all critical dependencies for the service (as defined in the dependency matrix) and return 503 if any critical dependency is unavailable. It must complete within 5 seconds.
4. **FR-4**: The startup endpoint (`/health/startup`) must return 503 until the service has completed its initialization sequence (database connections established, caches warmed, BullMQ workers started, background probes running). Once startup is complete, it must return 200 for the lifetime of the process.
5. **FR-5**: All health check responses must follow a standardized JSON schema: `{ status: 'pass' | 'fail' | 'warn', version: string, uptime: number, checks: Record<string, CheckResult[]>, output?: string }` where `CheckResult` includes `{ componentId: string, componentType: 'datastore' | 'system' | 'http', status: 'pass' | 'fail' | 'warn', observedValue?: number, observedUnit?: string, time: string, output?: string }`.
6. **FR-6**: Each service must declare a dependency matrix specifying which dependencies are `critical` (block readiness) vs `non-critical` (reported as warnings). The matrix must be configurable via environment variables.
7. **FR-7**: Readiness probes must return 503 immediately when the process receives a SIGTERM signal, before any shutdown logic begins, ensuring Kubernetes removes the pod from Service endpoints before connections start draining.
8. **FR-8**: The system must provide a shared `HealthCheckRegistry` in `packages/shared-kernel` that services use to register dependency checks, configure timeouts, and generate standardized responses.
9. **FR-9**: Health check results for readiness checks must be cached for a configurable period (default 5 seconds) to prevent dependency check storms from high-frequency Kubernetes probes.
10. **FR-10**: The platform-admin system-health endpoint must aggregate health from all services using the standardized format, including per-service dependency details, overall status, and a summary of healthy/degraded/down counts.
11. **FR-11**: Health check results must be exported as OpenTelemetry metrics: `health_check_status` gauge (0=fail, 1=warn, 2=pass) per service per dependency, and `health_check_latency_ms` histogram per dependency check.
12. **FR-12**: When a dependency transitions from healthy to unhealthy, the health check system must emit a structured log event and, if circuit-breaker integration is enabled, trigger the corresponding circuit breaker to open state.
13. **FR-13**: During graceful shutdown, WebSocket connections must receive a close frame (code 1001, reason "Server shutting down") and be given a configurable drain period (default 10 seconds) before forceful termination.
14. **FR-14**: During graceful shutdown, BullMQ workers must stop accepting new jobs, complete or re-enqueue in-flight jobs, and close connections within the termination grace period.
15. **FR-15**: The liveness and readiness probe endpoints must be unauthenticated (no auth middleware). The detailed health endpoint (`/health/details`) and the admin aggregation endpoint must require authentication.
16. **FR-16**: Health check timeouts per dependency must be independently configurable via environment variables, with sensible defaults: MongoDB 3s, Redis 2s, ClickHouse 4s, HTTP services 4s.

---

## 5. Feature Classification & Integration Matrix

### Lifecycle / Platform Impact

| Area                       | Impact Level | Notes                                                                                         |
| -------------------------- | ------------ | --------------------------------------------------------------------------------------------- |
| Project lifecycle          | NONE         | Health checks are infrastructure-level; they do not interact with project authoring.          |
| Agent lifecycle            | SECONDARY    | Agent execution degrades gracefully when dependencies are unhealthy (via circuit breakers).   |
| Customer experience        | PRIMARY      | Unhealthy pods are removed from load balancing; rolling deployments cause zero downtime.      |
| Integrations / channels    | SECONDARY    | WebSocket drain ensures SDK/channel clients reconnect cleanly during deployments.             |
| Observability / tracing    | PRIMARY      | Health metrics, structured health logs, and SLA dashboards are core observability signals.    |
| Governance / controls      | SECONDARY    | Health-gated deployments prevent rolling out to clusters with degraded infrastructure.        |
| Enterprise / compliance    | PRIMARY      | SLA reporting, uptime guarantees, and audit-grade health history are enterprise requirements. |
| Admin / operator workflows | PRIMARY      | Admin portal health dashboard is a primary operator workflow.                                 |

### Related Feature Integration Matrix

| Related Feature                           | Relationship Type | Why It Matters                                                                                                          | Key Touchpoints                                                                   | Current State                                                      |
| ----------------------------------------- | ----------------- | ----------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------- | ------------------------------------------------------------------ |
| [Circuit Breaker](circuit-breaker.md)     | shares data with  | Dependency health transitions feed circuit-breaker state changes; circuit-breaker open state feeds readiness decisions. | `HybridCircuitBreakerRegistry`, `HealthCheckRegistry`                             | Circuit breakers exist but are not wired to health check signals.  |
| [Rate Limiting](rate-limiting.md)         | depends on        | Rate limiting depends on Redis; if Redis health check fails, rate limiter falls back to in-memory mode.                 | `HybridRateLimiter.startRecoveryTimer()`, Redis health check                      | Redis recovery exists independently; not coordinated with probes.  |
| [Tracing & Observability](observatory.md) | emits into        | Health check metrics are exported as OTel gauges/histograms into the observability pipeline.                            | `otel-setup.ts`, `health_check_status` gauge, `health_check_latency_ms` histogram | OTel setup exists; health metrics not yet exported.                |
| [Alerts](alerts.md)                       | emits into        | Health check failures trigger alert rules (e.g., PagerDuty when a service is down for >60s).                            | Alert config routes, health metric thresholds                                     | Alert infrastructure exists; health-based rules not configured.    |
| [Diagnostics](diagnostics.md)             | extends           | The `/health/details` endpoint extends diagnostics with real-time dependency status.                                    | `diagnosticsRouter`, `HealthCheckRegistry`                                        | Diagnostics exist but do not include structured dependency health. |
| [Platform Admin](platform-admin.md)       | configured by     | Admin portal configures health check thresholds and views the aggregated dashboard.                                     | `platformAdminHealthRouter`, admin UI components                                  | Admin health endpoint exists with service registry; needs upgrade. |

---

## 6. Design Considerations (Optional)

### Admin Portal Health Dashboard

The admin portal should display a real-time health dashboard with:

- **Service grid**: cards for each service (Runtime, SearchAI, Studio, etc.) showing status (healthy/degraded/down), uptime, and last check time.
- **Dependency tree**: visual representation of the dependency graph (e.g., Runtime depends on MongoDB, Redis, ClickHouse; SearchAI depends on MongoDB, Redis, BullMQ, OpenSearch).
- **Drill-down**: clicking a service shows its dependency check details with latency, status history, and error messages.
- **Auto-refresh**: polls the aggregation endpoint every 15 seconds with visual countdown.

### Probe Endpoint UX

- `/health` — no query parameters, always fast, always unauthenticated.
- `/health/ready` — no query parameters, checks critical dependencies, always unauthenticated.
- `/health/startup` — no query parameters, returns 200 only after initialization, always unauthenticated.
- `/health/details` — requires authentication, returns full dependency matrix with latencies and error details. Accepts `?include=mongodb,redis` query parameter to check specific dependencies.

---

## 7. Technical Considerations (Optional)

### Shared Health Check Registry

A `HealthCheckRegistry` class in `packages/shared-kernel` provides the core framework:

```typescript
interface HealthCheck {
  name: string;
  componentType: 'datastore' | 'system' | 'http';
  critical: boolean; // if true, failure blocks readiness
  timeoutMs: number;
  check: () => Promise<HealthCheckResult>;
}

interface HealthCheckResult {
  status: 'pass' | 'fail' | 'warn';
  observedValue?: number;
  observedUnit?: string;
  output?: string;
}

class HealthCheckRegistry {
  register(check: HealthCheck): void;
  unregister(name: string): void;
  runLiveness(): Promise<HealthResponse>;
  runReadiness(): Promise<HealthResponse>;
  runStartup(): Promise<HealthResponse>;
  runDetails(include?: string[]): Promise<HealthResponse>;
  markStartupComplete(): void;
  markShuttingDown(): void;
  getCachedReadiness(): HealthResponse | null;
}
```

### Caching Strategy

Readiness checks are cached for `HEALTH_CHECK_CACHE_TTL_MS` (default 5000ms). Kubernetes probes typically hit every 5-10 seconds, so caching prevents dependency check storms. The cache is invalidated when:

- A SIGTERM is received (immediate readiness failure).
- A circuit breaker transitions state (re-check dependencies).
- The TTL expires naturally.

### Event Loop Liveness

The liveness check includes an event-loop responsiveness check: schedule a `setImmediate` with a 100ms timeout. If the callback does not fire within the timeout, the event loop is blocked and the liveness check fails. This catches infinite loops and CPU-bound operations that freeze the process.

### Dependency Check Timeout Isolation

Each dependency check runs with an independent `AbortController` timeout. A slow ClickHouse check (4s timeout) does not block a fast Redis check (2s timeout). Checks run in parallel via `Promise.allSettled`.

### Graceful Shutdown Ordering

The existing shutdown sequences in Runtime, SearchAI, and other services follow a correct pattern but need one addition: **readiness must fail before the HTTP server closes**. The updated sequence:

1. Receive SIGTERM.
2. Set `isShuttingDown = true` (readiness immediately returns 503).
3. Wait `SHUTDOWN_READINESS_DELAY_MS` (default 5s) for Kubernetes to propagate the endpoint removal.
4. Stop accepting new HTTP connections (`server.close()`).
5. Send WebSocket close frames, drain in-flight messages (10s timeout).
6. Stop BullMQ workers (`worker.close()`), wait for in-flight jobs.
7. Flush buffered writes (EventStore, ClickHouse batches).
8. Close database connections in reverse dependency order (ClickHouse, Redis, MongoDB).
9. Exit process.

### Kubernetes Probe Configuration Recommendations

| Service            | Startup Probe                                                                        | Liveness Probe                                              | Readiness Probe                                                                 |
| ------------------ | ------------------------------------------------------------------------------------ | ----------------------------------------------------------- | ------------------------------------------------------------------------------- |
| Runtime            | `initialDelaySeconds: 5, periodSeconds: 5, failureThreshold: 30, timeoutSeconds: 3`  | `periodSeconds: 10, failureThreshold: 3, timeoutSeconds: 2` | `periodSeconds: 5, failureThreshold: 2, timeoutSeconds: 5, successThreshold: 2` |
| SearchAI           | `initialDelaySeconds: 10, periodSeconds: 5, failureThreshold: 36, timeoutSeconds: 3` | `periodSeconds: 10, failureThreshold: 3, timeoutSeconds: 2` | `periodSeconds: 5, failureThreshold: 2, timeoutSeconds: 5, successThreshold: 2` |
| SearchAI-Runtime   | `initialDelaySeconds: 5, periodSeconds: 5, failureThreshold: 24, timeoutSeconds: 3`  | `periodSeconds: 10, failureThreshold: 3, timeoutSeconds: 2` | `periodSeconds: 5, failureThreshold: 2, timeoutSeconds: 5, successThreshold: 2` |
| Studio             | `initialDelaySeconds: 10, periodSeconds: 5, failureThreshold: 24, timeoutSeconds: 3` | `periodSeconds: 10, failureThreshold: 3, timeoutSeconds: 2` | `periodSeconds: 5, failureThreshold: 2, timeoutSeconds: 5, successThreshold: 2` |
| Admin              | `initialDelaySeconds: 5, periodSeconds: 5, failureThreshold: 12, timeoutSeconds: 3`  | `periodSeconds: 10, failureThreshold: 3, timeoutSeconds: 2` | `periodSeconds: 5, failureThreshold: 2, timeoutSeconds: 5, successThreshold: 2` |
| Workflow Engine    | `initialDelaySeconds: 10, periodSeconds: 5, failureThreshold: 36, timeoutSeconds: 3` | `periodSeconds: 10, failureThreshold: 3, timeoutSeconds: 2` | `periodSeconds: 5, failureThreshold: 2, timeoutSeconds: 5, successThreshold: 2` |
| Multimodal Service | `initialDelaySeconds: 5, periodSeconds: 5, failureThreshold: 12, timeoutSeconds: 3`  | `periodSeconds: 10, failureThreshold: 3, timeoutSeconds: 2` | `periodSeconds: 5, failureThreshold: 2, timeoutSeconds: 5, successThreshold: 2` |

---

## 8. How to Consume

### Studio UI

No direct Studio UI interaction with health checks. Studio's own health probes are consumed by Kubernetes. The admin portal (see Admin Portal below) provides the operator-facing health dashboard.

### API (Runtime)

| Method | Path                                | Purpose                                                     |
| ------ | ----------------------------------- | ----------------------------------------------------------- |
| GET    | `/health`                           | Liveness probe — process alive, event loop responsive       |
| GET    | `/health/ready`                     | Readiness probe — critical dependencies available           |
| GET    | `/health/startup`                   | Startup probe — initialization complete                     |
| GET    | `/health/details`                   | Authenticated detailed health with per-dependency breakdown |
| GET    | `/api/platform/admin/system-health` | Platform-admin aggregated health across all services        |

### API (Studio)

| Method | Path                | Purpose                                                 |
| ------ | ------------------- | ------------------------------------------------------- |
| GET    | `/api/health`       | Liveness probe for Studio (Next.js API route)           |
| GET    | `/api/health/ready` | Readiness probe — Studio backend dependencies available |

### API (SearchAI)

| Method | Path              | Purpose                                                  |
| ------ | ----------------- | -------------------------------------------------------- |
| GET    | `/health`         | Liveness probe                                           |
| GET    | `/health/ready`   | Readiness probe — MongoDB, Redis, BullMQ workers checked |
| GET    | `/health/startup` | Startup probe — database connected, workers started      |

### Admin Portal

- **Health Dashboard page**: `/admin/system-health` — real-time service grid with dependency tree visualization, auto-refreshing every 15 seconds.
- **Service detail drill-down**: `/admin/system-health/:serviceId` — per-service check history, latency trends, error logs.
- Consumes the `/api/platform/admin/system-health` endpoint from Runtime.

### Channel / SDK / Voice / A2A / MCP Integration

Health checks are infrastructure-level and not channel-aware. Channel-specific behavior:

- **SDK WebSocket**: receives close frame (code 1001) during graceful shutdown; client SDK should reconnect to a healthy pod.
- **A2A**: A2A task endpoints benefit from readiness-based load balancing; no A2A-specific health logic.
- **MCP**: MCP debug tools (`debug_get_current_state`) already inspect Runtime health; no additional integration needed.

---

## 9. Data Model

### Collections / Tables

Health check state is primarily ephemeral (in-memory + metrics). No new MongoDB collections are required.

```text
Store: In-memory HealthCheckRegistry (per process)
Fields:
  - checks: Map<string, HealthCheck>       — registered dependency checks
  - startupComplete: boolean               — flipped once after initialization
  - shuttingDown: boolean                   — set on SIGTERM
  - cachedReadiness: { result: HealthResponse, expiresAt: number } | null
  - lastCheckResults: Map<string, HealthCheckResult & { checkedAt: number }>
Lifecycle:
  - Created at process start, destroyed at process exit
  - Not persisted across restarts
```

```text
Store: OpenTelemetry metrics (exported to collector)
Metrics:
  - health_check_status (gauge): labels = { service, dependency, status }
  - health_check_latency_ms (histogram): labels = { service, dependency }
  - health_check_startup_duration_ms (gauge): labels = { service }
  - health_check_shutdown_duration_ms (gauge): labels = { service }
```

```text
Store: Existing service registry (apps/runtime/src/health/service-registry.ts)
Purpose:
  - Central registry of all platform services for admin health aggregation
  - Extended with new fields: criticality, dependency matrix, probe paths
Existing Fields:
  - id, name, group, description, port, healthPath, checkMethod, dependsOn, envVar
New Fields:
  - criticality: 'critical' | 'non-critical'
  - probes: { liveness: string, readiness: string, startup: string }
```

### Key Relationships

- `HealthCheckRegistry` instances are per-process singletons, not shared across pods.
- The platform-admin aggregation endpoint queries each service's `/health/details` endpoint via HTTP (using the existing `SERVICE_REGISTRY` from `service-registry.ts`).
- Health metrics flow into the existing OpenTelemetry pipeline (`otel-setup.ts`) and are scraped by Prometheus/Coroot.
- Circuit-breaker state transitions are triggered by health check failures via an event listener pattern (`registry.on('dependency:unhealthy', cb)`).

---

## 10. Key Implementation Files

### Domain / Core Logic

| File                                                         | Purpose                                                             |
| ------------------------------------------------------------ | ------------------------------------------------------------------- |
| `packages/shared-kernel/src/health/health-check-registry.ts` | Shared HealthCheckRegistry class with registration, caching, probes |
| `packages/shared-kernel/src/health/types.ts`                 | Standardized HealthResponse, HealthCheck, HealthCheckResult types   |
| `packages/shared-kernel/src/health/event-loop-check.ts`      | Event loop responsiveness check for liveness probes                 |
| `packages/shared-kernel/src/health/index.ts`                 | Public API barrel export                                            |
| `apps/runtime/src/health/service-registry.ts`                | Extended service registry with probe paths and criticality          |
| `apps/runtime/src/health/clickhouse-probe.ts`                | Existing ClickHouse periodic probe (to be integrated)               |
| `apps/runtime/src/health/auth-profile-health.ts`             | Existing auth-profile subsystem health check (to be integrated)     |

### Routes / Handlers

| File                                               | Purpose                                                            |
| -------------------------------------------------- | ------------------------------------------------------------------ |
| `apps/runtime/src/server.ts`                       | Runtime health endpoints (upgrade existing /health, /health/ready) |
| `apps/search-ai/src/routes/health.ts`              | SearchAI health endpoints (upgrade existing)                       |
| `apps/search-ai-runtime/src/routes/health.ts`      | SearchAI-Runtime health endpoints (upgrade existing)               |
| `apps/runtime/src/routes/platform-admin-health.ts` | Admin aggregation endpoint (upgrade to standardized format)        |

### UI Components

| File                                                  | Purpose                                  |
| ----------------------------------------------------- | ---------------------------------------- |
| `apps/admin/src/pages/system-health.tsx`              | Admin portal health dashboard page (new) |
| `apps/admin/src/components/health/ServiceCard.tsx`    | Service status card component (new)      |
| `apps/admin/src/components/health/DependencyTree.tsx` | Dependency graph visualization (new)     |
| `apps/admin/src/components/health/HealthTimeline.tsx` | Check history timeline component (new)   |

### Jobs / Workers / Background Processes

| File                                                    | Purpose                                                           |
| ------------------------------------------------------- | ----------------------------------------------------------------- |
| `apps/runtime/src/health/clickhouse-probe.ts`           | Periodic ClickHouse background probe (existing, to be wired in)   |
| `packages/shared-kernel/src/health/background-probe.ts` | Generic periodic background probe utility for long-running checks |

### Tests

| File                                                                 | Type        | Coverage Focus                                        |
| -------------------------------------------------------------------- | ----------- | ----------------------------------------------------- |
| `packages/shared-kernel/src/__tests__/health-check-registry.test.ts` | unit        | Registry registration, caching, timeout isolation     |
| `apps/runtime/src/__tests__/health-probes.test.ts`                   | unit        | Runtime liveness, readiness, startup probe logic      |
| `apps/runtime/src/__tests__/health-probes-e2e.test.ts`               | e2e         | Full server health endpoints with real dependencies   |
| `apps/search-ai/src/__tests__/health-probes.test.ts`                 | unit        | SearchAI probe logic                                  |
| `apps/runtime/src/__tests__/graceful-shutdown.test.ts`               | integration | Shutdown ordering, WebSocket drain, BullMQ stop       |
| `apps/runtime/src/__tests__/health-aggregation.test.ts`              | integration | Admin aggregation endpoint with multi-service probing |

---

## 11. Configuration

### Environment Variables

| Variable                             | Default | Description                                                       |
| ------------------------------------ | ------- | ----------------------------------------------------------------- |
| `HEALTH_CHECK_CACHE_TTL_MS`          | `5000`  | Readiness check result cache duration                             |
| `HEALTH_CHECK_MONGODB_TIMEOUT_MS`    | `3000`  | MongoDB ping timeout for health checks                            |
| `HEALTH_CHECK_REDIS_TIMEOUT_MS`      | `2000`  | Redis ping timeout for health checks                              |
| `HEALTH_CHECK_CLICKHOUSE_TIMEOUT_MS` | `4000`  | ClickHouse probe timeout for health checks                        |
| `HEALTH_CHECK_HTTP_TIMEOUT_MS`       | `4000`  | HTTP service probe timeout for health checks                      |
| `HEALTH_HEAP_LIMIT_MB`               | `1536`  | Heap usage threshold for readiness failure (existing)             |
| `HEALTH_EVENT_LOOP_TIMEOUT_MS`       | `100`   | Event loop responsiveness threshold for liveness                  |
| `SHUTDOWN_READINESS_DELAY_MS`        | `5000`  | Delay between readiness failure and server.close() on SIGTERM     |
| `SHUTDOWN_WS_DRAIN_TIMEOUT_MS`       | `10000` | WebSocket connection drain timeout during shutdown                |
| `SHUTDOWN_FORCE_TIMEOUT_MS`          | `30000` | Force-exit timeout after SIGTERM (existing)                       |
| `CLICKHOUSE_PROBE_INTERVAL_MS`       | `30000` | ClickHouse background probe interval (existing)                   |
| `OBS_STRICT_READINESS_GATES`         | `false` | Enable strict MongoDB check in readiness probe (existing)         |
| `HEALTH_CHECK_CIRCUIT_BREAKER_SYNC`  | `true`  | Sync health check failures with circuit-breaker state transitions |
| `HEALTH_METRICS_ENABLED`             | `true`  | Enable OpenTelemetry health metric export                         |

### Runtime Configuration

- Health check dependency criticality is declared per-service in code (HealthCheckRegistry) and can be overridden via environment variables (`HEALTH_CHECK_{NAME}_CRITICAL=true|false`).
- The admin aggregation endpoint respects the existing `SERVICE_REGISTRY` in `apps/runtime/src/health/service-registry.ts`.
- Kubernetes probe timing is configured in Helm values; recommended values are documented in Section 7.

### DSL / Agent IR / Schema

Health checks are infrastructure-level and not exposed in the ABL DSL or agent IR. No schema changes required.

---

## 12. Non-Functional Concerns

### Isolation & Multitenancy

| Concern           | Requirement / Expectation                                                                                                                           |
| ----------------- | --------------------------------------------------------------------------------------------------------------------------------------------------- |
| Tenant isolation  | Health check endpoints do not access tenant data. One tenant's workload cannot affect health probe results (probes check infrastructure, not data). |
| Project isolation | Not applicable. Health checks are service-level, not project-scoped.                                                                                |
| User isolation    | Not applicable. Health checks do not involve user-owned resources.                                                                                  |

### Security & Compliance

- **Unauthenticated probes**: `/health`, `/health/ready`, and `/health/startup` are unauthenticated to allow Kubernetes kubelet access. They return minimal information (status only, no dependency details) to prevent information leakage.
- **Authenticated details**: `/health/details` requires `requireAuth` middleware. The admin aggregation endpoint requires `requirePlatformAdmin()`.
- **Information leakage prevention**: Unauthenticated probe responses contain only `{ status: 'pass' | 'fail' }` and `{ uptime: number }`. Dependency names, latencies, and error messages are only returned on authenticated endpoints.
- **No secrets in responses**: Health check responses must never include connection strings, credentials, or internal hostnames.

### Performance & Scalability

- **Liveness check latency budget**: < 50ms (shallow check, no I/O).
- **Readiness check latency budget**: < 5s (parallel dependency checks with individual timeouts).
- **Caching**: Readiness results are cached for 5s to prevent check storms from frequent Kubernetes probes.
- **No hot path impact**: Health checks run on dedicated endpoints, not in the request middleware chain. They do not affect agent execution latency.
- **Horizontal scaling**: Health state is per-pod (not shared across pods). Each pod independently reports its own health.
- **Background probes**: ClickHouse and other slow dependencies use periodic background probes (30s interval) with cached results, so readiness checks read from cache instead of probing on every request.

### Reliability & Failure Modes

- **Cascading failure prevention**: Health checks use independent timeouts per dependency. A slow ClickHouse (4s) does not block a fast Redis check (2s). `Promise.allSettled` ensures all checks complete even if one throws.
- **Check failure isolation**: A failing non-critical dependency (e.g., ClickHouse for Runtime) returns `warn` status but does not fail the readiness probe. Only critical dependencies fail readiness.
- **Graceful degradation**: When a critical dependency transitions to unhealthy, the circuit breaker opens, allowing the service to serve degraded responses (e.g., returning cached data, skipping analytics writes) instead of returning 503 for all requests.
- **Shutdown race condition prevention**: The readiness-failure-before-server-close pattern (with configurable delay) ensures Kubernetes has time to propagate endpoint removal before connections are drained.
- **Probe timeout safety**: All probes have timeouts shorter than the Kubernetes probe `timeoutSeconds` to prevent kubelet from declaring the probe failed due to response timeout.

### Observability

- **Structured logs**: Health check transitions (pass->fail, fail->pass) are logged via `createLogger('health')` with dependency name, latency, and error context.
- **OTel metrics**: `health_check_status` gauge (per service, per dependency), `health_check_latency_ms` histogram (per dependency), `health_check_startup_duration_ms` gauge.
- **Tracing integration**: Health check endpoints are excluded from request tracing (they are high-frequency infrastructure endpoints that would generate noise).
- **Admin dashboard**: Real-time health grid in the admin portal with auto-refresh.
- **Alert integration**: Health metrics feed into the existing alert infrastructure. Recommended alert rules: service down for >60s (critical), dependency degraded for >5min (warning).

### Data Lifecycle

- Health check state is ephemeral (in-memory per process). No persistence, no TTLs, no archival.
- Health metrics are exported to the OTel collector and follow the collector's retention policy (typically 15 days for raw metrics, 90 days for aggregated).
- The ClickHouse background probe result is stored in a module-level variable and reset on probe stop (existing behavior in `clickhouse-probe.ts`).

---

## 13. Delivery Plan / Work Breakdown

1. **Shared framework (`packages/shared-kernel`)**
   1.1 Define `HealthCheckRegistry` class with registration, caching, and probe execution.
   1.2 Define standardized types (`HealthResponse`, `HealthCheck`, `HealthCheckResult`).
   1.3 Implement event-loop responsiveness check utility.
   1.4 Implement background probe utility for periodic dependency checks.
   1.5 Add unit tests for registry, caching, timeout isolation, event-loop check.
   1.6 Export public API from `packages/shared-kernel/src/health/index.ts`.

2. **Runtime health endpoints (upgrade)**
   2.1 Integrate `HealthCheckRegistry` into Runtime server startup.
   2.2 Register MongoDB, Redis, ClickHouse, BullMQ dependency checks.
   2.3 Upgrade `/health` to use event-loop liveness check (shallow, no deps).
   2.4 Upgrade `/health/ready` to use registry-based readiness with dependency matrix.
   2.5 Add `/health/startup` endpoint gated by `markStartupComplete()`.
   2.6 Add `/health/details` authenticated endpoint with full dependency breakdown.
   2.7 Wire circuit-breaker integration for dependency state transitions.
   2.8 Add unit and integration tests.

3. **SearchAI health endpoints (upgrade)**
   3.1 Integrate `HealthCheckRegistry` into SearchAI server startup.
   3.2 Register MongoDB, Redis, ClickHouse, BullMQ workers, OpenSearch dependency checks.
   3.3 Upgrade `/health` and `/health/ready` to standardized format.
   3.4 Add `/health/startup` endpoint.
   3.5 Add unit tests.

4. **SearchAI-Runtime, Multimodal Service, Crawler MCP Server, Workflow Engine (upgrade)**
   4.1 Integrate `HealthCheckRegistry` into each service.
   4.2 Register service-specific dependency checks.
   4.3 Add standardized probe endpoints.
   4.4 Add unit tests per service.

5. **Graceful shutdown coordination**
   5.1 Ensure SIGTERM sets `shuttingDown` flag before any shutdown logic.
   5.2 Add configurable readiness delay before `server.close()`.
   5.3 Verify WebSocket drain sends close frames and waits for drain timeout.
   5.4 Verify BullMQ worker stop completes in-flight jobs.
   5.5 Add integration tests for shutdown sequencing.

6. **Admin health aggregation & dashboard**
   6.1 Upgrade `platform-admin-health.ts` to use standardized format.
   6.2 Extend `SERVICE_REGISTRY` with probe paths and criticality.
   6.3 Build admin portal health dashboard page.
   6.4 Build service card, dependency tree, and timeline components.
   6.5 Add integration tests for aggregation endpoint.

7. **Health metrics export**
   7.1 Add OTel gauge and histogram instruments to `HealthCheckRegistry`.
   7.2 Wire metric recording into check execution.
   7.3 Add startup and shutdown duration gauges.
   7.4 Verify metrics are scraped by Prometheus/Coroot.

8. **Kubernetes configuration**
   8.1 Document recommended probe configurations per service.
   8.2 Add probe configurations to Helm chart values templates.
   8.3 Validate probe behavior with simulated pod lifecycle in staging.

---

## 14. Success Metrics

| Metric                                   | Baseline                                         | Target                                                               | How Measured                                         |
| ---------------------------------------- | ------------------------------------------------ | -------------------------------------------------------------------- | ---------------------------------------------------- |
| Services with standardized 3-probe model | 1 partial (Runtime has /health + /health/ready)  | All 7+ Node.js services have /health, /health/ready, /health/startup | Endpoint inventory audit                             |
| Zero-downtime rolling deployments        | Not proven (manual smoke testing)                | 100% of rolling deployments show zero 5xx during transition          | Kubernetes event logs + error rate metrics           |
| Mean readiness check latency             | Not measured                                     | p99 < 3s across all services                                         | `health_check_latency_ms` histogram                  |
| Health-based alert MTTR                  | Not measured (manual discovery of degraded deps) | Automated alerts within 60s of dependency failure                    | Alert manager incident timeline                      |
| Admin health dashboard availability      | No dashboard exists                              | Dashboard shows real-time health for all configured services         | Manual verification + uptime monitor on admin portal |
| Graceful shutdown completion rate        | Not measured                                     | 99%+ of pod terminations complete within grace period (no SIGKILL)   | Kubernetes pod termination logs                      |
| Health metric export coverage            | 0 health metrics exported                        | All services export status gauge + latency histogram per dependency  | Prometheus metric scrape validation                  |

---

## 15. Open Questions

1. **Qdrant health check method**: Qdrant is listed in the service registry with HTTP check to `/`, but the standard health endpoint may be `/healthz` or `/readyz`. Need to verify the correct Qdrant health endpoint for the version deployed.
2. **Studio health check architecture**: Studio runs on Next.js with server components. Should health checks be implemented as Next.js API routes (`/api/health`) or as a separate Express sidecar? Next.js API routes may have cold-start latency that interferes with probe timing.
3. **Cross-cluster health aggregation**: In multi-cluster deployments, should the admin health dashboard aggregate across clusters (requiring a federation endpoint) or only show the local cluster?
4. **Health check history persistence**: Should health check results be persisted to ClickHouse for SLA reporting (enabling queries like "what was the uptime of Runtime in the last 30 days"), or is OTel metric retention sufficient?
5. **Python service probe standardization**: Should the platform define a health check contract for Python services (Docling, BGE-M3, Preprocessing), or accept their existing ad-hoc `/health` endpoints as-is?
6. **BullMQ worker health granularity**: Should the readiness probe distinguish between "no workers running" (fail) and "workers running but queue is paused" (warn), or treat both as ready?
7. **Health check endpoint rate limiting**: Should the probe endpoints themselves be rate-limited to prevent abuse, or is the kubelet's probe interval sufficient protection?

---

## 16. Gaps, Known Issues & Limitations

| ID      | Description                                                                                                                                                                                                                                             | Severity | Status |
| ------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | -------- | ------ |
| GAP-001 | Runtime has no `/health/startup` endpoint; slow initialization (ClickHouse schema, BullMQ workers) can cause premature liveness kills.                                                                                                                  | High     | Open   |
| GAP-002 | SearchAI-Runtime has no readiness probe; Kubernetes cannot distinguish between a starting pod and a ready pod.                                                                                                                                          | High     | Open   |
| GAP-003 | Health check responses are inconsistent across services: Runtime returns `{ status: 'healthy' }`, SearchAI returns `{ status: 'ok' }`, SearchAI-Runtime returns `{ status: 'ok' }`.                                                                     | High     | Open   |
| GAP-004 | No health metrics are exported to OpenTelemetry; SLA dashboards cannot be built from health data.                                                                                                                                                       | High     | Open   |
| GAP-005 | Readiness probe in Runtime does not fail during the SIGTERM-to-server.close() gap when `OBS_STRICT_READINESS_GATES` is false (the default).                                                                                                             | Medium   | Open   |
| GAP-006 | The admin health aggregation endpoint (`platform-admin-health.ts`) runs all service checks serially via `Promise.all(SERVICE_REGISTRY.map(checkService))` but does not set per-check timeouts, risking slow aggregation when a service is unresponsive. | Medium   | Open   |
| GAP-007 | No circuit-breaker integration with health checks; dependency failures are reported but do not trigger automatic graceful degradation.                                                                                                                  | Medium   | Open   |
| GAP-008 | Studio, Admin, Workflow Engine, and Multimodal Service have minimal or missing health endpoints with no dependency checking.                                                                                                                            | Medium   | Open   |
| GAP-009 | WebSocket drain during shutdown sends close frames but does not wait for in-flight message acknowledgments; SDK clients may lose the last message.                                                                                                      | Low      | Open   |
| GAP-010 | BullMQ worker shutdown in SearchAI calls `stopWorkers()` but does not verify that in-flight jobs have completed or been re-enqueued before process exit.                                                                                                | Low      | Open   |

---

## 17. Testing & Validation

### Required Test Coverage

| #   | Scenario                                                                  | Coverage Type | Status     | Test File / Note                                                     |
| --- | ------------------------------------------------------------------------- | ------------- | ---------- | -------------------------------------------------------------------- |
| 1   | HealthCheckRegistry registers checks and runs them with timeout isolation | unit          | NOT TESTED | `packages/shared-kernel/src/__tests__/health-check-registry.test.ts` |
| 2   | Readiness check caching prevents check storms                             | unit          | NOT TESTED | Same as above                                                        |
| 3   | Event loop liveness check detects blocked event loop                      | unit          | NOT TESTED | `packages/shared-kernel/src/__tests__/event-loop-check.test.ts`      |
| 4   | Runtime /health returns 200 when process is alive                         | e2e           | NOT TESTED | `apps/runtime/src/__tests__/health-probes-e2e.test.ts`               |
| 5   | Runtime /health/ready returns 503 when MongoDB is down                    | e2e           | NOT TESTED | Same as above                                                        |
| 6   | Runtime /health/ready returns 503 during shutdown                         | integration   | NOT TESTED | `apps/runtime/src/__tests__/graceful-shutdown.test.ts`               |
| 7   | Runtime /health/startup returns 503 before initialization completes       | e2e           | NOT TESTED | `apps/runtime/src/__tests__/health-probes-e2e.test.ts`               |
| 8   | SearchAI /health/ready returns 503 when database unavailable              | e2e           | NOT TESTED | `apps/search-ai/src/__tests__/health-probes.test.ts`                 |
| 9   | Admin aggregation endpoint returns per-service health with latencies      | integration   | NOT TESTED | `apps/runtime/src/__tests__/health-aggregation.test.ts`              |
| 10  | WebSocket connections receive close frame during graceful shutdown        | integration   | NOT TESTED | `apps/runtime/src/__tests__/graceful-shutdown.test.ts`               |
| 11  | Health metrics exported as OTel gauges                                    | integration   | NOT TESTED | Metric scrape validation test                                        |
| 12  | Circuit breaker transitions on dependency health change                   | unit          | NOT TESTED | Circuit-breaker integration test                                     |
| 13  | Standardized JSON response format on all probe endpoints                  | e2e           | NOT TESTED | Schema validation across all services                                |
| 14  | Concurrent readiness checks use cached results within TTL                 | unit          | NOT TESTED | `packages/shared-kernel/src/__tests__/health-check-registry.test.ts` |

### Testing Notes

No health-check-specific test files exist today. The existing Runtime `/health` and `/health/ready` behavior is tested indirectly through server tests and wiring tests but not through dedicated health probe test suites. The platform-admin health endpoint has a test file (`apps/runtime/src/__tests__/platform-admin-resilience.test.ts`) but it covers the resilience router, not the health aggregation router specifically.

> Full testing details: [docs/testing/health-checks.md](../testing/health-checks.md)

---

## 18. References

- IETF Health Check Response Format draft: [RFC draft-inadarei-api-health-check-06](https://datatracker.ietf.org/doc/html/draft-inadarei-api-health-check-06)
- Kubernetes probe documentation: [Configure Liveness, Readiness and Startup Probes](https://kubernetes.io/docs/tasks/configure-pod-container/configure-liveness-readiness-startup-probes/)
- Kubernetes best practices for graceful termination: [Google Cloud Blog](https://cloud.google.com/blog/products/containers-kubernetes/kubernetes-best-practices-terminating-with-grace)
- Microservices health check pattern: [microservices.io](https://microservices.io/patterns/observability/health-check-api.html)
- AWS health check circuit breaker pattern: [Advanced Multi-AZ Resilience Patterns](https://docs.aws.amazon.com/whitepapers/latest/advanced-multi-az-resilience-patterns/pattern-1-health-check-circuit-breaker.html)
- Existing service registry: `apps/runtime/src/health/service-registry.ts`
- Existing ClickHouse probe: `apps/runtime/src/health/clickhouse-probe.ts`
- Existing auth-profile health: `apps/runtime/src/health/auth-profile-health.ts`
- Existing platform-admin health: `apps/runtime/src/routes/platform-admin-health.ts`
- Related features: [Circuit Breaker](circuit-breaker.md), [Rate Limiting](rate-limiting.md), [Observatory](observatory.md), [Alerts](alerts.md), [Platform Admin](platform-admin.md)

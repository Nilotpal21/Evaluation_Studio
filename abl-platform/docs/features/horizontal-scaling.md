# Feature: Horizontal Scaling / Pod Autoscaling

**Doc Type**: MAJOR FEATURE
**Parent Feature**: N/A
**Status**: PLANNED
**Feature Area(s)**: `enterprise`, `admin operations`, `observability`
**Package(s)**: `abl-platform-deploy` (Helm/ArgoCD), `apps/runtime`, `apps/search-ai`, `apps/studio`, `apps/admin`, `packages/config`
**Owner(s)**: `Platform team`, `SRE team`
**Testing Guide**: [docs/testing/horizontal-scaling.md](../testing/horizontal-scaling.md)
**Last Updated**: 2026-03-23

---

## 1. Introduction / Overview

### Problem Statement

The ABL platform currently runs with static replica counts defined in Helm values across all services (Runtime, SearchAI, Studio, Admin, Python ML services). When traffic surges from a large tenant onboarding, a spike in agent executions, or a mass connector sync, operators must manually scale deployments via `kubectl scale` or Helm re-deploys. This creates three critical problems:

1. **Reactive scaling**: By the time an operator notices degradation and scales manually, end users have already experienced latency spikes, 503 errors, or session drops. For WebSocket-heavy workloads (Runtime SDK/chat), connection failures are especially disruptive.
2. **Over-provisioning waste**: To compensate for the lack of autoscaling, operators over-provision by 40-60% (industry average per Sedai 2025 benchmarks). For a platform running 11+ services across multiple node pools, this translates to significant wasted cloud spend.
3. **Noisy-neighbor amplification**: Without workload-aware scaling, a single tenant running a mass eval pipeline or connector sync can saturate shared pods. Rate limiting constrains the tenant's request rate but cannot add capacity when legitimate aggregate demand exceeds static provisioning.

### Goal Statement

Provide a comprehensive, production-grade autoscaling framework for the ABL platform that combines Kubernetes HPA (CPU/memory), KEDA (event-driven scaling for BullMQ queues, Redis metrics, and custom application metrics), VPA (right-sizing recommendations), Pod Disruption Budgets (safe rollouts), and cluster-level node autoscaling -- all orchestrated through Helm values in `abl-platform-deploy` and observable through the Admin portal.

### Summary

Horizontal Scaling is the platform's capacity-management layer. It automatically adjusts pod replica counts and resource allocations across all services based on real-time demand signals:

1. **HPA (CPU/Memory)**: Standard Kubernetes HPA for Runtime, SearchAI, Studio, and Admin with configurable thresholds, stabilization windows, and scale-down cooldowns.
2. **KEDA Event-Driven Scaling**: ScaledObject CRDs for BullMQ queue workers (SearchAI crawl/sync workers, Runtime LLM queue, message persistence queue, channel inbound/delivery queues), Redis-based metrics (active sessions, rate-limit pressure), and custom Prometheus metrics (p99 latency, active WebSocket connections).
3. **VPA Right-Sizing**: VPA in recommendation mode for all services, providing resource request/limit suggestions based on observed usage patterns without automatic pod restarts.
4. **Pod Disruption Budgets**: PDBs for every stateful or session-holding service to ensure graceful scaling and safe rolling updates.
5. **Cluster Autoscaler / Karpenter**: Node-level autoscaling to provision infrastructure when pod autoscaling demands nodes that do not yet exist.
6. **Scale-to-Zero (Dev/Staging)**: KEDA-powered scale-to-zero for non-critical services in development and staging environments to minimize cost.
7. **Observability**: Scaling event dashboards, cost-impact projections, and alerting for scaling failures or oscillation.

---

## 2. Scope

### Goals

- Implement HPA for all HTTP-serving deployments (Runtime, SearchAI, Studio, Admin) with CPU and memory targets.
- Implement KEDA ScaledObjects for all BullMQ-backed workers and queue consumers with queue-depth triggers.
- Implement KEDA ScaledObjects with custom Prometheus metrics (active sessions, WebSocket connections, p99 latency) for Runtime.
- Configure VPA in recommendation-only mode for all services to guide right-sizing without disruptive restarts.
- Define Pod Disruption Budgets for every deployment ensuring at least 1 pod (or N-1 for services with 3+ replicas) remains available during voluntary disruptions.
- Integrate cluster autoscaler or Karpenter NodePool definitions for automatic node provisioning.
- Provide Helm value overrides for all scaling parameters (min/max replicas, thresholds, cooldowns, stabilization windows).
- Enable scale-to-zero for non-production environments via KEDA with configurable activation thresholds.
- Expose scaling metrics, events, and health in the Admin portal and via Prometheus/Grafana dashboards.
- Ensure graceful shutdown and connection draining work correctly during scale-down events.

### Non-Goals (Out of Scope)

- Per-tenant dedicated pod pools or per-tenant autoscaling policies (tenant isolation is handled by rate limiting, not pod affinity).
- Custom autoscaler controller development -- this feature relies on standard Kubernetes HPA, KEDA, VPA, and cluster autoscaler.
- Automatic cost optimization or FinOps integration (cost visibility is in scope; automated cost-driven scaling is not).
- GPU autoscaling for self-hosted LLM inference (covered by the ML infrastructure roadmap).
- Multi-cluster federation or cross-region autoscaling.
- Modifying application code for scaling -- this feature is infrastructure-only. Application-level graceful shutdown already exists.

---

## 3. User Stories

1. As a `platform operator`, I want Runtime pods to scale automatically when CPU utilization exceeds 70% so that agent execution latency remains within SLO during traffic spikes.
2. As a `platform operator`, I want SearchAI crawl workers to scale based on BullMQ queue depth so that large connector sync jobs are processed without blocking the ingestion pipeline.
3. As an `SRE engineer`, I want Pod Disruption Budgets on all services so that rolling updates and node drains do not cause user-facing downtime.
4. As an `SRE engineer`, I want VPA recommendations for all services so that I can right-size resource requests quarterly without guesswork.
5. As a `platform operator`, I want KEDA to scale Runtime based on active WebSocket connections so that SDK/chat capacity matches real-time demand rather than just CPU load.
6. As a `tenant admin`, I want to see current scaling status for the services my agents depend on so that I can understand platform capacity during high-load periods.
7. As a `developer`, I want non-production environments to scale to zero when idle so that dev/staging costs are minimized without manual intervention.
8. As an `SRE engineer`, I want alerts when autoscaling reaches max replicas or fails to scale so that I can intervene before capacity is exhausted.
9. As a `platform operator`, I want cluster nodes to auto-provision when pod autoscaling demands more capacity than currently available so that scale-up is not blocked by insufficient node resources.
10. As a `platform operator`, I want configurable scale-down stabilization windows so that transient load dips do not cause premature scale-down and subsequent re-scaling oscillation.

---

## 4. Functional Requirements

1. **FR-1**: The system must deploy HPA resources for Runtime, SearchAI, Studio, and Admin with configurable CPU target utilization (default 70%), memory target utilization (default 75%), minimum replicas (default 2 for production), and maximum replicas (configurable per service).
2. **FR-2**: The system must deploy KEDA ScaledObject resources for BullMQ queue workers (SearchAI crawl worker, SearchAI sync worker, Runtime LLM queue worker, Runtime message persistence queue, Runtime channel inbound queue, Runtime channel delivery queue) that scale based on queue length with configurable `listLength` thresholds.
3. **FR-3**: The system must deploy KEDA ScaledObject resources for Runtime that use custom Prometheus metrics (`abl_runtime_active_sessions`, `abl_runtime_ws_connections`, `abl_runtime_request_p99_latency_ms`) as scaling triggers alongside standard CPU/memory.
4. **FR-4**: The system must deploy VPA resources in `Off` mode (recommendation only) for all services, exposing resource recommendations via the VPA status API without automatically applying them.
5. **FR-5**: The system must deploy PodDisruptionBudget resources for every deployment, ensuring `minAvailable` of at least 1 pod for services with fewer than 3 replicas and `minAvailable` of N-1 for services with 3+ replicas.
6. **FR-6**: The system must configure HPA scale-down stabilization windows (default 300 seconds) to prevent oscillation, and scale-up stabilization windows (default 0 seconds for immediate response).
7. **FR-7**: The system must support KEDA scale-to-zero for all worker deployments in non-production environments, with configurable `minReplicaCount: 0`, `cooldownPeriod` (default 300s), and `pollingInterval` (default 30s).
8. **FR-8**: The system must define Karpenter NodePool or Cluster Autoscaler node group configurations for automatic node provisioning when pod scheduling fails due to insufficient resources.
9. **FR-9**: The system must configure `terminationGracePeriodSeconds` (default 60s for Runtime, 30s for others) and `preStop` lifecycle hooks to allow in-flight requests and WebSocket connections to drain before pod termination.
10. **FR-10**: The system must deploy anti-affinity rules (preferred, not required) for Runtime and SearchAI to spread pods across nodes and availability zones for fault tolerance.
11. **FR-11**: The system must expose scaling metrics via Prometheus (`kube_hpa_status_current_replicas`, `kube_hpa_status_desired_replicas`, `keda_scaledobject_ready`, custom scaling event counters) and provide Grafana dashboard definitions.
12. **FR-12**: The system must configure readiness probes with appropriate `initialDelaySeconds` (Runtime: 15s, SearchAI: 10s, Studio: 5s) and `periodSeconds` (5s) to ensure new pods receive traffic only after initialization is complete.
13. **FR-13**: The system must support per-environment scaling profiles (development, staging, production) with different min/max replicas, thresholds, and scale-to-zero settings via Helm values overlays.
14. **FR-14**: The system must configure topology spread constraints to distribute pods evenly across failure domains (zones, nodes) when running in multi-zone clusters.
15. **FR-15**: The system must emit Kubernetes events and structured logs when scaling actions occur (scale-up, scale-down, scale-to-zero, scale-from-zero) including the trigger metric, current value, threshold, and resulting replica count.

---

## 5. Feature Classification & Integration Matrix

### Lifecycle / Platform Impact

| Area                       | Impact Level | Notes                                                                                                      |
| -------------------------- | ------------ | ---------------------------------------------------------------------------------------------------------- |
| Project lifecycle          | NONE         | Autoscaling is transparent to project authoring workflows.                                                 |
| Agent lifecycle            | SECONDARY    | Agent execution latency improves with proper scaling; scale-down must not terminate active executions.     |
| Customer experience        | PRIMARY      | End users benefit from consistent latency under load; scale-down without draining causes session drops.    |
| Integrations / channels    | SECONDARY    | WebSocket, SDK, voice, and A2A connections must survive scale events via proper connection draining.       |
| Observability / tracing    | PRIMARY      | Scaling metrics, events, dashboards, and alerts are core operational signals.                              |
| Governance / controls      | SECONDARY    | Scaling policies enforce resource budgets; PDBs protect availability SLOs.                                 |
| Enterprise / compliance    | PRIMARY      | Enterprise customers require autoscaling for SLA guarantees, cost efficiency, and capacity planning.       |
| Admin / operator workflows | PRIMARY      | Operators configure scaling via Helm values and monitor via dashboards; scaling failures require alerting. |

### Related Feature Integration Matrix

| Related Feature                                 | Relationship Type | Why It Matters                                                                                          | Key Touchpoints                                                                     | Current State                                                |
| ----------------------------------------------- | ----------------- | ------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------- | ------------------------------------------------------------ |
| [Rate Limiting](rate-limiting.md)               | shares data with  | Rate limiters use Redis; HPA/KEDA must not scale beyond what rate limits allow per tenant.              | Redis rate-limit keys, tenant budget resolution, `HybridRateLimiter`                | Rate limiting is STABLE; no scaling integration yet          |
| [Circuit Breaker](circuit-breaker.md)           | depends on        | Circuit breakers trip during overload; scaling should reduce trips by adding capacity.                  | `HybridCircuitBreakerRegistry`, Redis circuit state                                 | Circuit breaker is STABLE; no scaling feedback loop          |
| [Session Compaction](session-compaction.md)     | depends on        | Active sessions must survive scale-down; connection registry must be Redis-backed for multi-pod.        | `WebSocketConnectionRegistry`, `sessions:active:{tenantId}` Redis sets              | Session state is Redis-backed; connection registry is local  |
| [Tracing & Observability](diagnostics.md)       | emits into        | Scaling events must be traceable; custom metrics feed KEDA triggers.                                    | Prometheus metrics, OpenTelemetry spans, ClickHouse scaling event logs              | Metrics infrastructure exists; scaling metrics not yet added |
| [Sizing Calculator](sizing-calculator.md)       | configured by     | Sizing calculator outputs inform initial scaling parameters (min replicas, resource requests).          | Helm values generator, service sizer, tier classifier                               | Sizing calculator engine exists; no autoscaling integration  |
| [Graceful Shutdown](horizontal-scaling.md#fr-9) | depends on        | `shutdownRuntimeServer()` and SearchAI shutdown handlers must complete within `terminationGracePeriod`. | `process.on('SIGTERM')`, HTTP server close, WebSocket drain, BullMQ worker close    | Runtime: 30s force timeout; SearchAI: 30s force timeout      |
| [BullMQ Workers](connectors.md)                 | extends           | KEDA scales workers based on queue depth; workers must handle graceful shutdown on scale-down.          | SearchAI `workers/index.ts`, Runtime `llm-queue.ts`, `message-persistence-queue.ts` | Workers exist; no autoscaling triggers                       |
| [Alerts](alerts.md)                             | emits into        | Scaling failures and max-replica events must trigger operator alerts.                                   | Alert config routes, alert evaluation pipeline                                      | Alert framework exists; scaling alert rules not defined      |

---

## 6. Design Considerations (Optional)

### Scaling Strategy per Service

| Service                 | Primary Trigger    | Secondary Trigger         | Min (Prod) | Max (Prod) | Scale-to-Zero (Dev) |
| ----------------------- | ------------------ | ------------------------- | ---------- | ---------- | ------------------- |
| Runtime                 | CPU (70%)          | Active sessions, WS conns | 2          | 20         | No                  |
| SearchAI                | CPU (70%)          | Memory (75%)              | 2          | 10         | No                  |
| SearchAI Crawl Worker   | BullMQ queue depth | N/A                       | 1          | 10         | Yes                 |
| SearchAI Sync Worker    | BullMQ queue depth | N/A                       | 1          | 8          | Yes                 |
| Studio                  | CPU (70%)          | Memory (75%)              | 2          | 8          | No                  |
| Admin                   | CPU (70%)          | N/A                       | 1          | 4          | Yes                 |
| Runtime LLM Queue       | BullMQ queue depth | N/A                       | 1          | 8          | Yes                 |
| Runtime Msg Persistence | BullMQ queue depth | N/A                       | 1          | 4          | Yes                 |
| Docling (Python)        | CPU (60%)          | Memory (80%)              | 1          | 6          | Yes                 |
| BGE-M3 (Python)         | CPU (60%)          | Request queue depth       | 1          | 4          | Yes                 |
| Preprocessing (Python)  | CPU (60%)          | Memory (80%)              | 1          | 4          | Yes                 |

### Scale-Down Safety

- Runtime pods hold WebSocket connections and in-flight agent executions. The `preStop` hook must signal the readiness probe to return 503 (already implemented via `isShuttingDown` flag), then wait for `terminationGracePeriodSeconds` minus 5s buffer before SIGTERM.
- BullMQ workers must finish their current job before exiting. KEDA's `cooldownPeriod` prevents premature scale-down during job processing.
- SearchAI crawl workers processing large documents must signal "busy" to KEDA via an activation metric to prevent scale-down mid-crawl.

### HPA vs KEDA Decision Matrix

| Use Case                                      | Mechanism | Rationale                                                                          |
| --------------------------------------------- | --------- | ---------------------------------------------------------------------------------- |
| HTTP service under CPU/memory load            | HPA       | Standard, well-understood, minimal additional infrastructure                       |
| Queue worker scaling                          | KEDA      | HPA cannot read BullMQ queue depth; KEDA Redis list scaler can                     |
| Custom application metric (sessions, latency) | KEDA      | HPA custom metrics require metrics adapter; KEDA provides native Prometheus scaler |
| Scale-to-zero                                 | KEDA      | HPA minimum is 1; KEDA supports `minReplicaCount: 0`                               |
| VPA right-sizing                              | VPA       | Neither HPA nor KEDA adjusts resource requests; VPA fills this gap                 |

---

## 7. Technical Considerations (Optional)

### Prerequisites

- **Metrics Server**: Must be installed in the cluster for HPA CPU/memory metrics. Already standard in managed Kubernetes (EKS, AKS, GKE).
- **KEDA Operator**: Must be installed (Helm chart: `kedacore/keda`). KEDA v2.19+ recommended for Redis list scaler stability.
- **VPA Controller**: Must be installed for recommendation mode. Does not conflict with HPA when VPA is in `Off` (recommendation-only) mode.
- **Prometheus**: Required for KEDA Prometheus scaler triggers. The platform already uses Prometheus via OpenTelemetry.
- **Cluster Autoscaler or Karpenter**: Must be configured for the cloud provider (EKS, AKS, GKE).

### BullMQ Queue Depth Metric Exposure

BullMQ does not natively expose queue depth as a Kubernetes metric. Two approaches:

1. **KEDA Redis List Scaler**: KEDA can directly query Redis `LLEN` on BullMQ queue keys (`bull:{queueName}:wait` and `bull:{queueName}:active`). This requires no application changes -- KEDA connects to Redis directly.
2. **Prometheus Exporter Sidecar**: A lightweight sidecar or separate deployment that exposes BullMQ metrics (`bull_queue_waiting`, `bull_queue_active`, `bull_queue_delayed`) as Prometheus metrics. This is more observable but adds deployment complexity.

Recommendation: Use approach (1) for initial implementation due to zero application changes, with approach (2) as a Phase 2 enhancement for richer observability.

### Custom Prometheus Metrics for Runtime

Runtime must expose the following metrics for KEDA Prometheus scaler:

- `abl_runtime_active_sessions` (gauge): Count of active sessions from `sessions:active:{tenantId}` Redis sets.
- `abl_runtime_ws_connections` (gauge): Count of active WebSocket connections from `WebSocketConnectionRegistry`.
- `abl_runtime_request_p99_latency_ms` (histogram): Request latency for scaling decisions.

These metrics should be exposed on the existing `/metrics` Prometheus endpoint.

### Graceful Shutdown Compatibility

Both Runtime (`shutdownRuntimeServer()`) and SearchAI already handle SIGTERM with:

- HTTP server close (stops accepting new connections)
- WebSocket client notification (`server_shutdown` message)
- BullMQ worker drain
- Redis/MongoDB disconnection
- 30-second force-exit timeout

The `terminationGracePeriodSeconds` in the pod spec must be at least 35s (30s app timeout + 5s buffer for preStop hook) to avoid SIGKILL before graceful shutdown completes.

### Redis Connection Scaling

As pods scale, each pod opens Redis connections. With 20 Runtime pods, each maintaining 2-3 Redis connections, the Redis server must handle 60+ connections. Ensure Redis `maxclients` is sized appropriately (default 10000 is usually sufficient) and connection pooling is used.

---

## 8. How to Consume

### Studio UI

No dedicated Studio UI for autoscaling. Scaling is transparent to Studio users. Studio benefits from autoscaling through improved backend responsiveness.

### API (Runtime)

No new Runtime API endpoints. Runtime benefits from autoscaling through:

| Method | Path            | Purpose                                                        |
| ------ | --------------- | -------------------------------------------------------------- |
| GET    | `/health/ready` | Readiness probe used by HPA/KEDA to determine pod readiness    |
| GET    | `/health/live`  | Liveness probe used by Kubernetes to detect stuck pods         |
| GET    | `/metrics`      | Prometheus metrics endpoint consumed by KEDA Prometheus scaler |

### API (Studio)

No new Studio API endpoints. Studio's existing readiness probe is used by HPA.

| Method | Path            | Purpose                                          |
| ------ | --------------- | ------------------------------------------------ |
| GET    | `/health/ready` | Readiness probe for HPA scale-up traffic routing |

### Admin Portal

The Admin portal exposes scaling visibility for platform operators:

| Method | Path                                 | Purpose                                                  |
| ------ | ------------------------------------ | -------------------------------------------------------- |
| GET    | `/api/admin/scaling/status`          | Current replica counts, HPA status, KEDA scaler status   |
| GET    | `/api/admin/scaling/events`          | Recent scaling events with trigger details               |
| GET    | `/api/admin/scaling/recommendations` | VPA resource recommendations for all services            |
| GET    | `/api/admin/scaling/config`          | Current scaling configuration (thresholds, limits, PDBs) |

### Channel / SDK / Voice / A2A / MCP Integration

Autoscaling is transparent to all channels and integration surfaces. Key behaviors:

- **SDK WebSocket**: New connections are load-balanced to available pods. Scale-down triggers graceful WebSocket close with `server_shutdown` message; SDK clients should reconnect automatically.
- **Voice/LiveKit**: Voice connections are stateful. PDBs ensure voice pods are not disrupted during scaling. `terminationGracePeriodSeconds` must exceed maximum expected call duration or connections must be drained to other pods.
- **A2A / MCP**: Stateless HTTP; no special scaling considerations.
- **Connectors**: Sync workers scale via KEDA based on queue depth. Long-running sync jobs must complete before pod termination.

---

## 9. Data Model

### Collections / Tables

This feature is primarily infrastructure-defined (Kubernetes CRDs) rather than application-data-driven. The following Kubernetes resources are created:

```text
CRD: HorizontalPodAutoscaler (autoscaling/v2)
Resources:
  - runtime-hpa
  - search-ai-hpa
  - studio-hpa
  - admin-hpa
  - docling-hpa
  - bge-m3-hpa
  - preprocessing-hpa
Fields:
  - scaleTargetRef: { apiVersion, kind, name }
  - minReplicas: number
  - maxReplicas: number
  - metrics: [{ type: Resource, resource: { name: cpu|memory, target: { type: Utilization, averageUtilization: number } } }]
  - behavior:
    - scaleDown: { stabilizationWindowSeconds: 300, policies: [{ type: Percent, value: 25, periodSeconds: 60 }] }
    - scaleUp: { stabilizationWindowSeconds: 0, policies: [{ type: Pods, value: 4, periodSeconds: 60 }] }
```

```text
CRD: ScaledObject (keda.sh/v1alpha1)
Resources:
  - searchai-crawl-worker-scaledobject
  - searchai-sync-worker-scaledobject
  - runtime-llm-queue-scaledobject
  - runtime-msg-persistence-scaledobject
  - runtime-channel-inbound-scaledobject
  - runtime-channel-delivery-scaledobject
  - runtime-custom-metrics-scaledobject
Fields:
  - scaleTargetRef: { name: <deployment> }
  - pollingInterval: 30
  - cooldownPeriod: 300
  - minReplicaCount: 0 | 1
  - maxReplicaCount: number
  - triggers:
    - type: redis | prometheus
    - metadata: { address, listName, listLength } | { serverAddress, metricName, threshold, query }
```

```text
CRD: VerticalPodAutoscaler (autoscaling.k8s.io/v1)
Resources:
  - runtime-vpa
  - search-ai-vpa
  - studio-vpa
  - admin-vpa
Fields:
  - targetRef: { apiVersion, kind, name }
  - updatePolicy: { updateMode: "Off" }  # Recommendation only
  - resourcePolicy:
    - containerPolicies:
      - containerName: "*"
      - minAllowed: { cpu: "100m", memory: "128Mi" }
      - maxAllowed: { cpu: "4", memory: "8Gi" }
```

```text
CRD: PodDisruptionBudget (policy/v1)
Resources:
  - runtime-pdb
  - search-ai-pdb
  - studio-pdb
  - admin-pdb
Fields:
  - spec:
    - minAvailable: 1 | N-1
    - selector: { matchLabels: { app: <service> } }
```

```text
Collection: scaling_events (ClickHouse -- for historical analysis)
Fields:
  - timestamp: DateTime
  - service: String
  - event_type: Enum('scale_up', 'scale_down', 'scale_to_zero', 'scale_from_zero', 'max_reached', 'pdb_blocked')
  - trigger_metric: String
  - trigger_value: Float64
  - threshold: Float64
  - replicas_before: UInt16
  - replicas_after: UInt16
  - environment: String
Indexes:
  - (timestamp, service)
  - (service, event_type)
TTL: 90 days
```

### Key Relationships

- HPA targets Deployment resources defined in Helm charts.
- KEDA ScaledObjects target Deployment resources and connect to Redis (BullMQ queues) and Prometheus (custom metrics).
- VPA targets Deployment resources in recommendation-only mode.
- PDBs reference Deployment label selectors.
- Scaling events are logged to ClickHouse for historical analysis and Admin portal dashboards.
- Readiness probes in Deployment specs gate traffic routing during scale-up.
- Graceful shutdown handlers in application code handle SIGTERM during scale-down.

---

## 10. Key Implementation Files

### Domain / Core Logic

| File                                                                  | Purpose                                                    |
| --------------------------------------------------------------------- | ---------------------------------------------------------- |
| `abl-platform-deploy/charts/runtime/templates/hpa.yaml`               | Runtime HPA definition                                     |
| `abl-platform-deploy/charts/runtime/templates/pdb.yaml`               | Runtime PodDisruptionBudget                                |
| `abl-platform-deploy/charts/runtime/templates/vpa.yaml`               | Runtime VPA (recommendation mode)                          |
| `abl-platform-deploy/charts/runtime/templates/keda-scaledobject.yaml` | Runtime KEDA ScaledObject (custom metrics + queue workers) |
| `abl-platform-deploy/charts/search-ai/templates/hpa.yaml`             | SearchAI HPA definition                                    |
| `abl-platform-deploy/charts/search-ai/templates/pdb.yaml`             | SearchAI PodDisruptionBudget                               |
| `abl-platform-deploy/charts/search-ai/templates/keda-workers.yaml`    | SearchAI worker KEDA ScaledObjects                         |
| `abl-platform-deploy/charts/studio/templates/hpa.yaml`                | Studio HPA definition                                      |
| `abl-platform-deploy/charts/admin/templates/hpa.yaml`                 | Admin HPA definition                                       |
| `abl-platform-deploy/charts/karpenter/templates/nodepool.yaml`        | Karpenter NodePool definitions for auto-provisioning       |
| `abl-platform-deploy/environments/production/scaling-values.yaml`     | Production scaling overrides                               |
| `abl-platform-deploy/environments/staging/scaling-values.yaml`        | Staging scaling overrides (scale-to-zero enabled)          |
| `abl-platform-deploy/environments/development/scaling-values.yaml`    | Development scaling overrides (aggressive scale-to-zero)   |

### Routes / Handlers

| File                                      | Purpose                                              |
| ----------------------------------------- | ---------------------------------------------------- |
| `apps/admin/src/routes/scaling-status.ts` | Admin API for scaling status and events (PLANNED)    |
| `apps/runtime/src/server.ts`              | Readiness probe (`/health/ready`) and shutdown logic |
| `apps/search-ai/src/server.ts`            | Readiness probe and shutdown logic                   |

### UI Components

| File                                                         | Purpose                                   |
| ------------------------------------------------------------ | ----------------------------------------- |
| `apps/admin/src/components/scaling/ScalingDashboard.tsx`     | Admin scaling dashboard (PLANNED)         |
| `apps/admin/src/components/scaling/ScalingEventTimeline.tsx` | Timeline view of scaling events (PLANNED) |
| `apps/admin/src/components/scaling/VPARecommendations.tsx`   | VPA recommendation viewer (PLANNED)       |

### Jobs / Workers / Background Processes

| File                                                     | Purpose                                                           |
| -------------------------------------------------------- | ----------------------------------------------------------------- |
| `apps/search-ai/src/workers/index.ts`                    | BullMQ worker entry point; must handle graceful shutdown for KEDA |
| `apps/runtime/src/services/llm/llm-queue.ts`             | Runtime LLM queue worker; KEDA scales based on queue depth        |
| `apps/runtime/src/services/message-persistence-queue.ts` | Message persistence queue; KEDA scales based on queue depth       |
| `apps/runtime/src/services/queues/channel-queues.ts`     | Channel inbound/delivery queues; KEDA scales based on queue depth |

### Tests

| File                                                                     | Type        | Coverage Focus                                 |
| ------------------------------------------------------------------------ | ----------- | ---------------------------------------------- |
| `abl-platform-deploy/tests/hpa-rendering.test.ts` (PLANNED)              | unit        | Helm template rendering for HPA resources      |
| `abl-platform-deploy/tests/pdb-rendering.test.ts` (PLANNED)              | unit        | Helm template rendering for PDB resources      |
| `abl-platform-deploy/tests/keda-rendering.test.ts` (PLANNED)             | unit        | Helm template rendering for KEDA ScaledObjects |
| `apps/runtime/src/__tests__/e2e/scaling-readiness.e2e.test.ts` (PLANNED) | e2e         | Readiness probe behavior during shutdown       |
| `apps/runtime/src/__tests__/scaling-metrics.test.ts` (PLANNED)           | integration | Custom Prometheus metrics exposure for KEDA    |

---

## 11. Configuration

### Environment Variables

| Variable                           | Default | Description                                                         |
| ---------------------------------- | ------- | ------------------------------------------------------------------- |
| `SCALING_ENABLED`                  | `true`  | Master toggle for autoscaling resources in Helm templates           |
| `HPA_ENABLED`                      | `true`  | Enable/disable HPA resources                                        |
| `KEDA_ENABLED`                     | `false` | Enable/disable KEDA ScaledObject resources (requires KEDA operator) |
| `VPA_ENABLED`                      | `false` | Enable/disable VPA resources (requires VPA controller)              |
| `PDB_ENABLED`                      | `true`  | Enable/disable PodDisruptionBudget resources                        |
| `KEDA_REDIS_ADDRESS`               | (none)  | Redis address for KEDA queue depth scalers (host:port)              |
| `KEDA_PROMETHEUS_SERVER`           | (none)  | Prometheus server address for KEDA Prometheus scalers               |
| `SCALING_METRICS_ENABLED`          | `true`  | Enable custom Prometheus metrics for KEDA triggers in Runtime       |
| `TERMINATION_GRACE_PERIOD_RUNTIME` | `60`    | Runtime pod termination grace period in seconds                     |
| `TERMINATION_GRACE_PERIOD_DEFAULT` | `30`    | Default pod termination grace period in seconds                     |

### Runtime Configuration (Helm Values)

```yaml
# Production scaling values (abl-platform-deploy)
scaling:
  global:
    enabled: true
    environment: production # production | staging | development

  hpa:
    enabled: true
    runtime:
      minReplicas: 2
      maxReplicas: 20
      targetCPUUtilization: 70
      targetMemoryUtilization: 75
      scaleDown:
        stabilizationWindowSeconds: 300
        percentPerMinute: 25
      scaleUp:
        stabilizationWindowSeconds: 0
        podsPerMinute: 4
    searchAi:
      minReplicas: 2
      maxReplicas: 10
      targetCPUUtilization: 70
      targetMemoryUtilization: 75
    studio:
      minReplicas: 2
      maxReplicas: 8
      targetCPUUtilization: 70
    admin:
      minReplicas: 1
      maxReplicas: 4
      targetCPUUtilization: 70

  keda:
    enabled: true
    pollingInterval: 30
    cooldownPeriod: 300
    workers:
      searchAiCrawl:
        minReplicas: 1
        maxReplicas: 10
        queueName: 'crawl'
        listLength: 5 # Scale up when > 5 items in queue
        activationListLength: 1 # Scale from zero when > 0 items
      searchAiSync:
        minReplicas: 1
        maxReplicas: 8
        queueName: 'sync'
        listLength: 3
        activationListLength: 1
      runtimeLlmQueue:
        minReplicas: 1
        maxReplicas: 8
        queueName: 'llm'
        listLength: 10
        activationListLength: 1
      runtimeMsgPersistence:
        minReplicas: 1
        maxReplicas: 4
        queueName: 'message-persistence'
        listLength: 20
        activationListLength: 1
    customMetrics:
      runtime:
        activeSessions:
          threshold: 100 # Scale when > 100 active sessions per pod
          query: 'sum(abl_runtime_active_sessions)'
        wsConnections:
          threshold: 500 # Scale when > 500 WS connections per pod
          query: 'sum(abl_runtime_ws_connections)'
        p99Latency:
          threshold: 2000 # Scale when p99 > 2000ms
          query: 'histogram_quantile(0.99, rate(abl_runtime_request_duration_seconds_bucket[5m])) * 1000'

  vpa:
    enabled: true
    updateMode: 'Off' # Recommendation only
    minAllowed:
      cpu: '100m'
      memory: '128Mi'
    maxAllowed:
      cpu: '4'
      memory: '8Gi'

  pdb:
    enabled: true
    runtime:
      minAvailable: 1
    searchAi:
      minAvailable: 1
    studio:
      minAvailable: 1
    admin:
      minAvailable: 1

  nodeAutoscaling:
    enabled: true
    provider: karpenter # karpenter | cluster-autoscaler
    karpenter:
      nodePool:
        limits:
          cpu: '128'
          memory: '512Gi'
        instanceTypes:
          - m6i.xlarge
          - m6i.2xlarge
          - m6i.4xlarge
          - m7i.xlarge
          - m7i.2xlarge
        zones:
          - us-east-1a
          - us-east-1b
          - us-east-1c
        consolidationPolicy: WhenUnderutilized
        ttlSecondsAfterEmpty: 30
```

### DSL / Agent IR / Schema

Horizontal scaling is not configurable in ABL DSL. It is a platform infrastructure concern managed through Helm values and Kubernetes CRDs. The sizing calculator's output (`packages/sizing-calculator`) can inform initial scaling parameters.

---

## 12. Non-Functional Concerns

### Isolation & Multitenancy

| Concern           | Requirement / Expectation                                                                                                                                                                                 |
| ----------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Tenant isolation  | Autoscaling is service-level, not tenant-level. One tenant's load spike causes all tenants on that service to benefit from scale-up. Rate limiting (existing) prevents any single tenant from dominating. |
| Noisy neighbor    | HPA/KEDA scale the shared pod pool. Combined with per-tenant rate limits, this prevents one tenant from both consuming all existing capacity AND preventing new capacity from being added.                |
| Project isolation | Not applicable. Scaling operates at the Kubernetes deployment level, not per-project.                                                                                                                     |
| User isolation    | Not applicable. Scaling operates at the infrastructure level.                                                                                                                                             |

### Security & Compliance

- **RBAC**: KEDA service account requires read access to Redis (for queue depth) and Prometheus (for custom metrics). KEDA must NOT have write access to application Redis keys.
- **Secrets Management**: Redis connection strings for KEDA must be stored in Kubernetes Secrets, not in ScaledObject metadata. KEDA supports `TriggerAuthentication` CRDs for this.
- **Audit Logging**: All scaling events are logged to ClickHouse with timestamps and trigger details for compliance auditing.
- **Network Policy**: KEDA operator pods must be allowed to connect to Redis and Prometheus. Network policies must permit this traffic.
- **Resource Quotas**: Kubernetes `ResourceQuota` and `LimitRange` objects should be set per namespace to prevent autoscaling from consuming unbounded resources.

### Performance & Scalability

- **Scale-Up Latency**: Target < 30 seconds from metric threshold breach to new pod receiving traffic (pod scheduling + image pull + readiness probe).
- **Scale-Down Latency**: Target 300-second stabilization window to prevent oscillation. Aggressive scale-down (25% per minute) after stabilization.
- **KEDA Polling**: 30-second polling interval balances responsiveness with API server load. For latency-sensitive triggers (p99 latency), consider 15-second polling.
- **Connection Warming**: New Runtime pods need 10-15 seconds to establish Redis and MongoDB connections. Readiness probe `initialDelaySeconds` must cover this.
- **Image Pull**: Use `imagePullPolicy: IfNotPresent` with pre-pulled images on node pools to minimize scale-up cold start.
- **Max Replicas Ceiling**: Set per-service max replicas to prevent runaway scaling. Runtime max 20, others max 4-10 depending on service.

### Reliability & Failure Modes

| Failure Mode                     | Impact                                                | Mitigation                                                                                |
| -------------------------------- | ----------------------------------------------------- | ----------------------------------------------------------------------------------------- |
| Metrics Server unavailable       | HPA cannot scale; pods stay at current count          | Alert on metrics-server health; pods continue serving at current capacity                 |
| KEDA operator crash              | Queue workers stop scaling; queues may grow           | KEDA runs as HA deployment (2 replicas); alert on KEDA pod health                         |
| Prometheus unavailable           | KEDA custom metric triggers fail                      | KEDA falls back to `fallback` replica count; alert on Prometheus health                   |
| Redis connection from KEDA fails | Queue depth triggers stop working                     | KEDA supports `authenticationRef` with retry; alert on trigger errors                     |
| Scale-up blocked by nodes        | Pods pending due to insufficient node resources       | Cluster autoscaler/Karpenter provisions nodes; alert on pending pods > 2 minutes          |
| PDB blocking node drain          | Node drain stalled because minAvailable cannot be met | Alert on stalled drains; operator manually adjusts PDB or adds capacity                   |
| Scaling oscillation              | Pods scale up/down repeatedly (thrashing)             | Stabilization windows (300s down, 0s up); gradual scale-down (25%/min)                    |
| Scale-from-zero cold start       | First request after scale-to-zero sees high latency   | KEDA `activationListLength: 1` triggers before queue grows; readiness probe gates traffic |

### Observability

- **Prometheus Metrics** (exposed by kube-state-metrics and KEDA):
  - `kube_hpa_status_current_replicas` / `kube_hpa_status_desired_replicas`
  - `kube_hpa_spec_min_replicas` / `kube_hpa_spec_max_replicas`
  - `keda_scaledobject_ready` / `keda_scaledobject_errors_total`
  - `keda_trigger_totals` (per trigger type)
  - `abl_scaling_events_total` (custom counter by service and event type)
- **Grafana Dashboards**:
  - Autoscaling Overview: Current vs desired replicas per service, scaling events timeline
  - Queue Depth: BullMQ queue lengths vs KEDA thresholds
  - VPA Recommendations: Recommended vs actual resource requests per container
  - Scaling Cost Impact: Estimated cost delta from scaling events (pod-hours)
- **Alerts**:
  - `ScalingMaxReplicasReached`: Service at max replicas for > 10 minutes
  - `ScalingOscillation`: More than 4 scale events in 10 minutes for same service
  - `KEDAScalerError`: KEDA scaler returning errors for > 5 minutes
  - `PDBBlockingDrain`: Node drain blocked by PDB for > 15 minutes
  - `PodPendingTooLong`: Pod in Pending state for > 3 minutes (node capacity issue)

### Data Lifecycle

- Scaling events in ClickHouse: 90-day TTL, partitioned by month.
- VPA recommendations are ephemeral (stored in VPA status; no persistence needed).
- HPA/KEDA state is Kubernetes-native (etcd); no additional persistence.
- Prometheus metrics retained per Prometheus retention policy (default 15 days).

---

## 13. Delivery Plan / Work Breakdown

1. **Phase 1: Foundation (Sprint 1)**
   1.1 Define HPA Helm templates for Runtime, SearchAI, Studio, Admin with CPU/memory targets.
   1.2 Define PDB Helm templates for all services with appropriate `minAvailable` values.
   1.3 Configure `terminationGracePeriodSeconds` and `preStop` hooks in all Deployment templates.
   1.4 Add readiness probe tuning (`initialDelaySeconds`, `periodSeconds`) to all Deployment templates.
   1.5 Add per-environment scaling value overlays (production, staging, development).
   1.6 Write Helm template rendering tests for HPA and PDB resources.

2. **Phase 2: Event-Driven Scaling (Sprint 2)**
   2.1 Install KEDA operator in staging cluster.
   2.2 Define KEDA ScaledObject templates for SearchAI crawl and sync workers (Redis list scaler).
   2.3 Define KEDA ScaledObject templates for Runtime LLM queue, message persistence, and channel queues.
   2.4 Configure `TriggerAuthentication` CRDs for Redis credentials.
   2.5 Validate BullMQ Redis key patterns (`bull:{name}:wait`) match KEDA Redis list scaler expectations.
   2.6 Enable scale-to-zero for worker deployments in staging environment.
   2.7 Write Helm template rendering tests for KEDA ScaledObjects.

3. **Phase 3: Custom Metrics & VPA (Sprint 3)**
   3.1 Add custom Prometheus metrics to Runtime (`abl_runtime_active_sessions`, `abl_runtime_ws_connections`, `abl_runtime_request_p99_latency_ms`).
   3.2 Define KEDA Prometheus scaler triggers for Runtime custom metrics.
   3.3 Define VPA Helm templates in recommendation-only mode for all services.
   3.4 Write integration tests for custom metric exposure.

4. **Phase 4: Node Autoscaling & Topology (Sprint 4)**
   4.1 Define Karpenter NodePool templates (or Cluster Autoscaler node group configs) in Helm.
   4.2 Configure topology spread constraints for Runtime and SearchAI.
   4.3 Configure pod anti-affinity rules (preferred) for session-holding services.
   4.4 Validate node provisioning latency under simulated pod-pending scenarios.

5. **Phase 5: Observability & Admin (Sprint 5)**
   5.1 Create Grafana dashboard definitions for autoscaling overview, queue depth, and VPA recommendations.
   5.2 Define Prometheus alerting rules for scaling failures, oscillation, and max-replica events.
   5.3 Implement scaling event logging to ClickHouse.
   5.4 Implement Admin portal scaling status and event endpoints.
   5.5 Implement Admin portal scaling dashboard UI components.

6. **Phase 6: Production Rollout & Validation (Sprint 6)**
   6.1 Deploy Phase 1-5 to staging; run load tests validating scale-up/down behavior.
   6.2 Validate PDB behavior during rolling updates and node drains.
   6.3 Validate graceful shutdown and connection draining during scale-down.
   6.4 Validate scale-to-zero and scale-from-zero latency for worker deployments.
   6.5 Deploy to production with conservative thresholds; monitor for 1 week.
   6.6 Tune thresholds based on production telemetry.

---

## 14. Success Metrics

| Metric                                  | Baseline                                              | Target                                            | How Measured                                                    |
| --------------------------------------- | ----------------------------------------------------- | ------------------------------------------------- | --------------------------------------------------------------- |
| Scale-up latency (threshold to serving) | Manual (minutes to hours)                             | < 60 seconds (HPA), < 90 seconds (KEDA from zero) | Prometheus: time from desired > current to ready replicas       |
| Runtime p99 latency during load spikes  | Degrades to > 5s during spikes (static replicas)      | Stays < 2s with autoscaling                       | Prometheus: `abl_runtime_request_p99_latency_ms`                |
| Over-provisioning ratio                 | 40-60% wasted capacity (estimated)                    | < 20% wasted capacity                             | VPA recommendations vs actual requests; pod utilization metrics |
| Dev/staging monthly compute cost        | Full static provisioning (100% of prod-like replicas) | 40-60% reduction via scale-to-zero                | Cloud cost reports; pod-hours in non-prod environments          |
| Scaling oscillation incidents           | N/A (no autoscaling)                                  | < 1 per week per service                          | Prometheus alert: `ScalingOscillation`                          |
| PDB-blocked drain incidents             | N/A (no PDBs)                                         | < 1 per month                                     | Prometheus alert: `PDBBlockingDrain`                            |
| Queue processing latency (BullMQ)       | Minutes during large sync jobs (static workers)       | < 30 seconds (KEDA scales workers to demand)      | BullMQ queue wait time metrics                                  |
| Zero-downtime rolling updates           | Manual coordination required                          | 100% zero-downtime with PDBs                      | Deployment event logs; zero 5xx during deploys                  |

---

## 15. Open Questions

1. **Karpenter vs Cluster Autoscaler**: Which node autoscaler should be the default? Karpenter is faster and more flexible but requires EKS (or compatible). Cluster Autoscaler is more portable. Should we support both via Helm conditionals?
2. **KEDA Redis authentication**: Should KEDA connect to the same Redis instance as the application, or a separate read replica? Connecting to the primary adds load; a read replica adds infrastructure complexity.
3. **VPA auto-apply**: Should VPA eventually move from recommendation-only (`Off`) to `Auto` mode for non-critical services (Admin, workers)? This would automatically restart pods with better resource requests but introduces risk.
4. **BullMQ key format**: BullMQ stores waiting jobs in `bull:{queueName}:wait` as a Redis list. Does this key format match across all queue instances in Runtime and SearchAI? Need to verify the exact key patterns.
5. **Multi-cluster scaling**: For enterprise customers with multi-region deployments, should scaling policies be federated across clusters? This is out of scope now but affects Helm value structure.
6. **Python service scaling**: Docling, BGE-M3, and Preprocessing are Python services with different scaling characteristics (GPU for some). Should they use HPA, KEDA, or a custom controller?
7. **Cost attribution**: Should scaling events be attributed to specific tenants whose traffic triggered the scale-up? This would require correlating scaling triggers with tenant-level metrics.
8. **WebSocket sticky sessions**: When Runtime scales up, should a session-affinity mechanism route existing SDK clients to their original pod? Or is the current "reconnect to any pod" approach sufficient given Redis-backed session state?

---

## 16. Gaps, Known Issues & Limitations

| ID      | Description                                                                                                                                                                | Severity | Status |
| ------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | -------- | ------ |
| GAP-001 | WebSocket connections are not gracefully migrated during scale-down -- clients receive `server_shutdown` and must reconnect, causing a brief disruption.                   | High     | Open   |
| GAP-002 | BullMQ Redis key patterns are not documented or validated for KEDA compatibility. KEDA Redis list scaler requires exact key names.                                         | High     | Open   |
| GAP-003 | Runtime `WebSocketConnectionRegistry` is in-memory (pod-local), not Redis-backed. This means the custom metric `abl_runtime_ws_connections` only counts local pods.        | Medium   | Open   |
| GAP-004 | No existing Prometheus metrics endpoint in Runtime for custom application metrics. The `/metrics` endpoint must be added or extended.                                      | Medium   | Open   |
| GAP-005 | SearchAI workers do not currently signal "busy" status to prevent KEDA from scaling down during long-running crawl jobs.                                                   | Medium   | Open   |
| GAP-006 | VPA and HPA conflict risk: if both target CPU, VPA may adjust requests in ways that cause HPA to oscillate. Must ensure VPA remains in `Off` mode when HPA is active.      | Medium   | Open   |
| GAP-007 | Python services (Docling, BGE-M3, Preprocessing) use different base images and startup patterns than Node.js services; scaling templates may need service-specific tuning. | Low      | Open   |
| GAP-008 | No existing integration tests for graceful shutdown behavior under Kubernetes SIGTERM; current tests use in-process shutdown calls, not actual pod termination signals.    | Low      | Open   |

---

## 17. Testing & Validation

### Required Test Coverage

| #   | Scenario                                                                         | Coverage Type | Status     | Test File / Note                                                           |
| --- | -------------------------------------------------------------------------------- | ------------- | ---------- | -------------------------------------------------------------------------- |
| 1   | HPA Helm template renders correctly with default and custom values               | unit          | NOT TESTED | `abl-platform-deploy/tests/hpa-rendering.test.ts` (PLANNED)                |
| 2   | PDB Helm template renders correctly with minAvailable for each service           | unit          | NOT TESTED | `abl-platform-deploy/tests/pdb-rendering.test.ts` (PLANNED)                |
| 3   | KEDA ScaledObject renders with correct Redis trigger configuration               | unit          | NOT TESTED | `abl-platform-deploy/tests/keda-rendering.test.ts` (PLANNED)               |
| 4   | VPA renders in Off mode with correct resource bounds                             | unit          | NOT TESTED | `abl-platform-deploy/tests/vpa-rendering.test.ts` (PLANNED)                |
| 5   | Runtime readiness probe returns 503 during shutdown                              | integration   | PASS       | `apps/runtime/src/server.ts` (existing `/health/ready` + `isShuttingDown`) |
| 6   | Runtime custom Prometheus metrics exposed correctly                              | integration   | NOT TESTED | `apps/runtime/src/__tests__/scaling-metrics.test.ts` (PLANNED)             |
| 7   | Graceful shutdown completes within terminationGracePeriodSeconds                 | e2e           | NOT TESTED | `apps/runtime/src/__tests__/e2e/scaling-readiness.e2e.test.ts` (PLANNED)   |
| 8   | KEDA scales worker from 0 to 1 when queue has items                              | e2e           | NOT TESTED | Requires KEDA in test cluster                                              |
| 9   | HPA scales Runtime from 2 to 4 under sustained CPU load                          | e2e           | NOT TESTED | Requires load testing harness + HPA in test cluster                        |
| 10  | PDB prevents all pods from being evicted simultaneously                          | e2e           | NOT TESTED | Requires node drain simulation in test cluster                             |
| 11  | Scale-down does not terminate pods with active WebSocket connections prematurely | e2e           | NOT TESTED | Requires WebSocket client + SIGTERM simulation                             |
| 12  | Per-environment scaling profiles render different values                         | unit          | NOT TESTED | Helm template tests with production/staging/dev value overrides            |

### Testing Notes

Testing autoscaling is inherently more complex than unit testing application logic because it requires Kubernetes infrastructure. The testing strategy is layered:

1. **Helm template unit tests**: Validate that templates render correct YAML for all scaling resources with various value combinations. These run in CI without a cluster.
2. **Integration tests**: Validate that Runtime exposes custom Prometheus metrics, readiness probes behave correctly during shutdown, and graceful shutdown completes within bounds.
3. **E2E tests**: Require a Kubernetes cluster (minikube/kind with KEDA installed) to validate actual scaling behavior. These run in a dedicated CI pipeline or manually in staging.
4. **Load tests**: k6 or similar tool to generate sustained load and validate that HPA/KEDA scale as expected. Run in staging before production rollout.

> Full testing details: [docs/testing/horizontal-scaling.md](../testing/horizontal-scaling.md)

---

## 18. References

- Kubernetes HPA documentation: https://kubernetes.io/docs/concepts/workloads/autoscaling/horizontal-pod-autoscale/
- KEDA documentation: https://keda.sh/docs/2.19/concepts/scaling-deployments/
- KEDA Redis scaler: https://keda.sh/docs/2.19/scalers/redis-lists/
- KEDA Prometheus scaler: https://keda.sh/docs/2.19/scalers/prometheus/
- Kubernetes VPA: https://github.com/kubernetes/autoscaler/tree/master/vertical-pod-autoscaler
- Kubernetes PDB: https://kubernetes.io/docs/concepts/workloads/pods/disruptions/
- Karpenter: https://karpenter.sh/docs/
- Cluster Autoscaler: https://github.com/kubernetes/autoscaler/tree/master/cluster-autoscaler
- Platform deploy repo: `abl-platform-deploy` (Helm charts + ArgoCD)
- Related features: [Rate Limiting](rate-limiting.md), [Circuit Breaker](circuit-breaker.md), [Sizing Calculator](sizing-calculator.md), [Diagnostics](diagnostics.md), [Alerts](alerts.md)
- Existing graceful shutdown: `apps/runtime/src/server.ts` (lines 1921-2133), `apps/search-ai/src/server.ts` (lines 461-530)

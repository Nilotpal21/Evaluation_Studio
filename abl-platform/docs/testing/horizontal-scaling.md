# Feature Test Guide: Horizontal Scaling / Pod Autoscaling

**Feature**: HPA, KEDA, VPA, PDB, and cluster autoscaling for all platform services
**Owner**: Platform team, SRE team
**Branch**: develop
**Related Feature Doc**: [docs/features/horizontal-scaling.md](../features/horizontal-scaling.md)
**First audited**: 2026-03-23
**Last updated**: 2026-03-23
**Overall status**: NOT TESTED

---

## Current State (as of 2026-03-23)

Horizontal scaling is a PLANNED feature with no autoscaling infrastructure deployed yet. The platform currently runs with static replica counts defined in Helm values. The application-level prerequisites are partially in place: Runtime and SearchAI both have graceful shutdown handlers (`SIGTERM` / `SIGINT`), readiness probes (`/health/ready` that return 503 during shutdown), and BullMQ-backed job queues. However, no HPA, KEDA ScaledObject, VPA, or PDB resources exist in the Helm charts, no custom Prometheus metrics are exposed for KEDA triggers, and no scaling-specific tests exist.

### Quick Health Dashboard

| Area                                        | Status     | Last Verified | Notes                                                                           |
| ------------------------------------------- | ---------- | ------------- | ------------------------------------------------------------------------------- |
| HPA Helm templates (CPU/memory)             | NOT TESTED | --            | Templates not yet created                                                       |
| PDB Helm templates                          | NOT TESTED | --            | Templates not yet created                                                       |
| KEDA ScaledObject templates (queue workers) | NOT TESTED | --            | Templates not yet created; KEDA operator not installed                          |
| KEDA custom metrics triggers (Runtime)      | NOT TESTED | --            | Custom Prometheus metrics not yet exposed                                       |
| VPA templates (recommendation mode)         | NOT TESTED | --            | Templates not yet created; VPA controller not installed                         |
| Runtime readiness probe during shutdown     | PASS       | checked-in    | `/health/ready` returns 503 when `isShuttingDown` is true                       |
| SearchAI readiness probe during shutdown    | PASS       | checked-in    | `/health/ready` returns 503 when `isShuttingDown` is true                       |
| Runtime graceful shutdown (SIGTERM)         | PASS       | checked-in    | `shutdownRuntimeServer()` handles SIGTERM with 30s timeout                      |
| SearchAI graceful shutdown (SIGTERM)        | PASS       | checked-in    | `shutdown()` handles SIGTERM with 30s timeout                                   |
| BullMQ queue key format validation          | NOT TESTED | --            | Key patterns not validated for KEDA Redis list scaler compatibility             |
| Custom Prometheus metrics (Runtime)         | NOT TESTED | --            | `abl_runtime_active_sessions`, `abl_runtime_ws_connections` not yet implemented |
| Scaling event logging (ClickHouse)          | NOT TESTED | --            | ClickHouse schema and logging not yet implemented                               |
| Node autoscaling (Karpenter/CA)             | NOT TESTED | --            | NodePool definitions not yet created                                            |
| Scale-to-zero (KEDA, dev/staging)           | NOT TESTED | --            | KEDA not installed; scale-to-zero not configured                                |
| Topology spread / anti-affinity             | NOT TESTED | --            | Pod topology constraints not yet configured                                     |
| Admin scaling dashboard                     | NOT TESTED | --            | Admin endpoints and UI not yet implemented                                      |

---

## Coverage Matrix

| FR    | Description                                                  | Unit       | Integration | E2E        | Manual | Status      |
| ----- | ------------------------------------------------------------ | ---------- | ----------- | ---------- | ------ | ----------- |
| FR-1  | HPA for HTTP services with CPU/memory targets                | NOT TESTED | NOT TESTED  | NOT TESTED | N/A    | Not Started |
| FR-2  | KEDA ScaledObjects for BullMQ queue workers                  | NOT TESTED | NOT TESTED  | NOT TESTED | N/A    | Not Started |
| FR-3  | KEDA custom Prometheus metrics triggers for Runtime          | NOT TESTED | NOT TESTED  | NOT TESTED | N/A    | Not Started |
| FR-4  | VPA in recommendation-only mode                              | NOT TESTED | NOT TESTED  | NOT TESTED | N/A    | Not Started |
| FR-5  | PodDisruptionBudgets for all services                        | NOT TESTED | NOT TESTED  | NOT TESTED | N/A    | Not Started |
| FR-6  | HPA scale-down stabilization windows                         | NOT TESTED | NOT TESTED  | NOT TESTED | N/A    | Not Started |
| FR-7  | KEDA scale-to-zero for workers in non-production             | NOT TESTED | NOT TESTED  | NOT TESTED | N/A    | Not Started |
| FR-8  | Karpenter/CA node auto-provisioning                          | NOT TESTED | NOT TESTED  | NOT TESTED | N/A    | Not Started |
| FR-9  | terminationGracePeriod and preStop hooks                     | NOT TESTED | PARTIAL     | NOT TESTED | N/A    | Partial     |
| FR-10 | Anti-affinity and topology spread                            | NOT TESTED | NOT TESTED  | NOT TESTED | N/A    | Not Started |
| FR-11 | Scaling metrics via Prometheus + Grafana dashboards          | NOT TESTED | NOT TESTED  | NOT TESTED | N/A    | Not Started |
| FR-12 | Readiness probe tuning for new pods                          | NOT TESTED | PARTIAL     | NOT TESTED | N/A    | Partial     |
| FR-13 | Per-environment scaling profiles                             | NOT TESTED | NOT TESTED  | NOT TESTED | N/A    | Not Started |
| FR-14 | Topology spread constraints for multi-zone                   | NOT TESTED | NOT TESTED  | NOT TESTED | N/A    | Not Started |
| FR-15 | Scaling event emission (Kubernetes events + structured logs) | NOT TESTED | NOT TESTED  | NOT TESTED | N/A    | Not Started |

---

## E2E Test Scenarios (minimum 5)

### E2E-1: HPA scales Runtime under sustained CPU load

**Preconditions**: Kubernetes cluster with metrics-server installed. Runtime deployed with HPA (`minReplicas: 2`, `maxReplicas: 6`, `targetCPUUtilization: 50%` -- lowered for test). k6 or equivalent load generator available. Prometheus scraping Runtime metrics.

**Steps**:

1. Verify Runtime has 2 running pods (`kubectl get pods -l app=runtime` shows 2 Ready pods).
2. Start k6 load test: 100 concurrent virtual users sending POST `/api/v1/chat` requests with valid tenant auth headers for 5 minutes.
3. Monitor HPA status: `kubectl get hpa runtime-hpa -w` -- wait for `desiredReplicas` to increase above 2.
4. Assert new pods reach Ready state (readiness probe passes).
5. Assert k6 reports no HTTP 503 errors during the scale-up transition.
6. Stop the load test.
7. Wait for scale-down stabilization window (300 seconds or test override).
8. Assert Runtime scales back down toward `minReplicas: 2` (may not reach exactly 2 due to stabilization).

**Expected Result**: HPA detects CPU utilization above 50%, scales Runtime from 2 to 3+ pods. New pods start receiving traffic after readiness probe passes. No 503 errors during scale-up. Pods scale down after stabilization window.

**Auth Context**: Load test uses valid tenant auth tokens via `createUnifiedAuthMiddleware`. Multiple tenants can be used to distribute load.

**Isolation Check**: Scaling is service-level; all tenants benefit equally from additional pods. Verify no single tenant's requests are preferentially routed to new pods.

---

### E2E-2: KEDA scales SearchAI crawl worker from zero on queue activity

**Preconditions**: Kubernetes cluster with KEDA operator installed. SearchAI crawl worker deployed with KEDA ScaledObject (`minReplicaCount: 0`, `maxReplicaCount: 5`, `listLength: 3`, `activationListLength: 1`). Redis accessible with BullMQ queues. Worker currently scaled to 0 pods.

**Steps**:

1. Verify SearchAI crawl worker has 0 running pods (`kubectl get pods -l app=searchai-crawl-worker` shows 0).
2. Enqueue 5 crawl jobs via SearchAI API: POST `/api/connectors/{connectorId}/sync` for a configured connector with 5 documents.
3. Verify Redis key `bull:crawl:wait` has 5 items (`redis-cli LLEN bull:crawl:wait`).
4. Wait for KEDA polling interval (30 seconds).
5. Assert KEDA ScaledObject status shows `isActive: true`.
6. Assert crawl worker pods scale from 0 to at least 2 (5 items / listLength 3 = 2 desired replicas).
7. Wait for pods to reach Ready state and begin processing jobs.
8. Assert all 5 crawl jobs complete successfully (check job status via SearchAI API).
9. Wait for KEDA cooldown period (300 seconds or test override).
10. Assert crawl worker scales back to 0 pods after queue is empty.

**Expected Result**: KEDA detects queue items above `activationListLength`, scales worker from 0 to appropriate replica count. Jobs are processed. Worker scales back to 0 after cooldown.

**Auth Context**: Crawl jobs created with valid tenant auth. KEDA uses `TriggerAuthentication` for Redis credentials.

**Isolation Check**: Multiple tenants' crawl jobs can be enqueued; all are processed by the shared worker pool.

---

### E2E-3: PDB prevents all pods from being evicted during node drain

**Preconditions**: Kubernetes cluster with at least 2 nodes. Runtime deployed with 3 replicas spread across nodes. PDB configured with `minAvailable: 2`. All 3 pods are Ready.

**Steps**:

1. Verify Runtime has 3 Running/Ready pods distributed across at least 2 nodes.
2. Identify the node running 2 Runtime pods (the "majority node").
3. Start a continuous HTTP health check loop against Runtime service endpoint (1 request/second).
4. Initiate node drain: `kubectl drain <majority-node> --ignore-daemonsets --delete-emptydir-data`.
5. Assert that the drain respects the PDB: only 1 pod is evicted at a time (since `minAvailable: 2`).
6. Assert the evicted pod is rescheduled on the remaining node before the second pod on the drained node is evicted.
7. Assert the health check loop reports 0 failed requests during the entire drain operation.
8. Assert all 3 Runtime pods are eventually Running/Ready (possibly on fewer nodes).
9. Uncordon the drained node: `kubectl uncordon <majority-node>`.

**Expected Result**: PDB ensures at least 2 Runtime pods remain available throughout the drain. No service disruption observed by the health check client.

**Auth Context**: N/A -- infrastructure test, not application auth.

**Isolation Check**: N/A -- PDB is service-level, not tenant-level.

---

### E2E-4: Graceful shutdown drains WebSocket connections during scale-down

**Preconditions**: Runtime deployed with 3 replicas. 10 SDK WebSocket clients connected (distributed across pods). HPA or manual scale-down about to reduce replicas from 3 to 2.

**Steps**:

1. Establish 10 SDK WebSocket connections via `/ws/sdk` with valid SDK tokens, distributed across all 3 Runtime pods.
2. Verify all 10 connections are active (send ping, receive pong).
3. Trigger scale-down: `kubectl scale deployment runtime --replicas=2` (or wait for HPA to scale down after load reduction).
4. Assert that the terminating pod:
   a. Sends `{ type: 'server_shutdown', message: 'Server is shutting down' }` to all connected WebSocket clients.
   b. Returns 503 on `/health/ready` (readiness probe fails, no new connections routed).
   c. Closes HTTP server (stops accepting new connections).
   d. Allows in-flight requests to complete.
5. Assert WebSocket clients on the terminating pod receive the shutdown message and can reconnect to remaining pods.
6. Assert clients reconnected to surviving pods have their session state intact (Redis-backed).
7. Assert the terminating pod exits within `terminationGracePeriodSeconds` (60s for Runtime).
8. Assert 0 message loss: all messages sent before shutdown are persisted, all messages sent after reconnection are received.

**Expected Result**: Scale-down triggers graceful WebSocket disconnection. Clients reconnect to surviving pods. Session state is preserved via Redis. No message loss.

**Auth Context**: SDK tokens authenticate WebSocket connections. Session state is Redis-backed.

**Isolation Check**: WebSocket clients from different tenants are all gracefully disconnected; no tenant's connections are prioritized.

---

### E2E-5: Per-environment scaling profiles apply correct values

**Preconditions**: Helm chart with scaling value overlays for production, staging, and development environments. `helm template` available locally or in CI.

**Steps**:

1. Render Helm templates with production values: `helm template runtime ./charts/runtime -f environments/production/scaling-values.yaml`.
2. Assert HPA resource has `minReplicas: 2`, `maxReplicas: 20`, `targetCPUUtilization: 70`.
3. Assert KEDA ScaledObjects have `minReplicaCount: 1` (no scale-to-zero in production).
4. Assert PDB has `minAvailable: 1`.
5. Render Helm templates with staging values: `helm template runtime ./charts/runtime -f environments/staging/scaling-values.yaml`.
6. Assert HPA resource has `minReplicas: 1`, `maxReplicas: 5`.
7. Assert KEDA ScaledObjects have `minReplicaCount: 0` (scale-to-zero enabled).
8. Render Helm templates with development values: `helm template runtime ./charts/runtime -f environments/development/scaling-values.yaml`.
9. Assert HPA is disabled or `maxReplicas: 2`.
10. Assert KEDA ScaledObjects have `minReplicaCount: 0` and `cooldownPeriod: 60` (aggressive scale-to-zero).
11. Assert PDB is disabled in development (optional).

**Expected Result**: Each environment profile produces different scaling configurations. Production is conservative (no scale-to-zero, high max replicas). Development is aggressive (scale-to-zero, low max).

**Auth Context**: N/A -- Helm template rendering test.

**Isolation Check**: N/A -- infrastructure template test.

---

### E2E-6: KEDA scales Runtime based on custom Prometheus metric (active sessions)

**Preconditions**: Kubernetes cluster with KEDA and Prometheus installed. Runtime deployed with KEDA ScaledObject using Prometheus trigger for `abl_runtime_active_sessions` with `threshold: 50`. Runtime currently at 2 replicas.

**Steps**:

1. Verify Runtime has 2 Running/Ready pods and `abl_runtime_active_sessions` metric is 0.
2. Create 60 active sessions via POST `/api/v1/sdk/init` with valid tenant SDK tokens.
3. Verify Prometheus query `sum(abl_runtime_active_sessions)` returns 60.
4. Wait for KEDA polling interval (30 seconds).
5. Assert KEDA ScaledObject status shows `isActive: true` and desired replicas > 2.
6. Assert new Runtime pods are created and reach Ready state.
7. Close 50 sessions (release session slots).
8. Verify `abl_runtime_active_sessions` drops to 10.
9. Wait for KEDA cooldown period.
10. Assert Runtime scales back toward 2 replicas.

**Expected Result**: KEDA reads active session count from Prometheus, scales Runtime when sessions exceed threshold, and scales back down when sessions decrease.

**Auth Context**: SDK init calls use valid tenant auth. Prometheus scrapes Runtime `/metrics` endpoint.

**Isolation Check**: Sessions from multiple tenants contribute to the aggregate metric. Scaling benefits all tenants.

---

### E2E-7: Cluster autoscaler provisions node when pods are pending

**Preconditions**: Kubernetes cluster with Karpenter (or Cluster Autoscaler) configured. Existing nodes are near capacity. Runtime HPA `maxReplicas: 10`.

**Steps**:

1. Generate sustained load to trigger HPA scale-up beyond current node capacity.
2. Assert new Runtime pods enter Pending state due to insufficient CPU/memory on existing nodes.
3. Assert Karpenter/CA detects unschedulable pods within 60 seconds.
4. Assert new node is provisioned within 3-5 minutes (cloud provider dependent).
5. Assert pending pods are scheduled on the new node and reach Ready state.
6. Assert end-to-end latency (load spike to pod serving) is < 5 minutes.
7. Stop load test.
8. Wait for pods to scale down (HPA) and node to be reclaimed (Karpenter consolidation / CA scale-down).
9. Assert the extra node is terminated after `ttlSecondsAfterEmpty` (Karpenter) or scale-down delay (CA).

**Expected Result**: Pod autoscaling triggers node autoscaling seamlessly. Pending pods are resolved by new nodes. Nodes are reclaimed when no longer needed.

**Auth Context**: N/A -- infrastructure capacity test.

**Isolation Check**: N/A -- node autoscaling is cluster-level.

---

## Integration Test Scenarios (minimum 5)

### INT-1: Runtime custom Prometheus metrics are correctly exposed

**Boundary**: Runtime `/metrics` endpoint + Prometheus metric format.

**Setup**: Start Runtime server on random port. Redis available for session tracking.

**Steps**:

1. GET `/metrics` -- assert response contains `abl_runtime_active_sessions` metric with value 0.
2. GET `/metrics` -- assert response contains `abl_runtime_ws_connections` metric with value 0.
3. Create 3 sessions via internal session creation (call `claimSessionSlot()` directly or via SDK init).
4. GET `/metrics` -- assert `abl_runtime_active_sessions` is 3.
5. Establish 2 WebSocket connections.
6. GET `/metrics` -- assert `abl_runtime_ws_connections` is 2.
7. Release 1 session.
8. GET `/metrics` -- assert `abl_runtime_active_sessions` is 2.

**Expected Result**: Custom Prometheus metrics accurately reflect real-time session and connection counts.

**Failure Mode**: If Redis is unavailable, session count falls back to in-memory tracking (single-pod accuracy only).

---

### INT-2: Readiness probe fails during graceful shutdown

**Boundary**: Runtime `/health/ready` endpoint + `shutdownRuntimeServer()`.

**Setup**: Start Runtime server on random port with full middleware chain.

**Steps**:

1. GET `/health/ready` -- assert HTTP 200 with `{ status: 'ready' }`.
2. Call `shutdownRuntimeServer({ exitProcess: false })` (trigger graceful shutdown without exiting).
3. GET `/health/ready` -- assert HTTP 503 with `{ status: 'not_ready', reason: 'shutting_down' }`.
4. Assert that new TCP connections are still accepted (server is closing but not yet closed).
5. Wait for HTTP server close to complete.
6. Assert that the server stops accepting new connections.

**Expected Result**: Readiness probe returns 503 immediately on shutdown trigger. Kubernetes stops routing new traffic. In-flight requests complete normally.

**Failure Mode**: If `isShuttingDown` is not set before readiness check, new traffic may be routed to a draining pod.

---

### INT-3: BullMQ queue key format matches KEDA Redis list scaler expectations

**Boundary**: BullMQ Redis key structure + KEDA Redis list scaler `listName` parameter.

**Setup**: Start a BullMQ queue instance. Redis available.

**Steps**:

1. Create a BullMQ `Queue` instance with name `crawl`.
2. Add 3 jobs to the queue.
3. Assert Redis key `bull:crawl:wait` exists and is a list (`redis-cli TYPE bull:crawl:wait` returns `list`).
4. Assert `redis-cli LLEN bull:crawl:wait` returns 3.
5. Create a BullMQ `Worker` for the same queue. Process 1 job.
6. Assert `bull:crawl:wait` has 2 items and `bull:crawl:active` has 1 item (or 0 if job completed).
7. Repeat for all queue names used in the platform: `sync`, `llm`, `message-persistence`, `channel-inbound`, `channel-delivery`.
8. Document the exact key pattern for each queue.

**Expected Result**: BullMQ uses predictable Redis key patterns (`bull:{name}:wait`) that KEDA Redis list scaler can query via `LLEN`. All platform queues follow this pattern.

**Failure Mode**: If BullMQ uses a custom prefix (e.g., `bull:{prefix}:{name}:wait`), KEDA `listName` must include the full key path.

---

### INT-4: Graceful shutdown completes within termination grace period

**Boundary**: Runtime `shutdownRuntimeServer()` + configurable timeout.

**Setup**: Start Runtime server with active HTTP connections, WebSocket connections, and BullMQ workers. Redis and MongoDB available.

**Steps**:

1. Start Runtime server on random port.
2. Establish 5 WebSocket connections via `/ws/sdk`.
3. Start a long-running HTTP request (e.g., agent execution that takes 5 seconds).
4. Record `startTime = Date.now()`.
5. Call `shutdownRuntimeServer({ exitProcess: false })`.
6. Wait for shutdown to complete (promise resolves).
7. Record `endTime = Date.now()`.
8. Assert `endTime - startTime < 30000` (must complete within 30-second timeout).
9. Assert all WebSocket connections received `server_shutdown` message.
10. Assert the in-flight HTTP request completed (not aborted mid-response).
11. Assert Redis connections are closed (`disconnectRedis()` was called).
12. Assert MongoDB connections are closed (`disconnectDatabase()` was called).

**Expected Result**: Graceful shutdown completes within the application timeout (30s). All connections are properly drained. No orphaned connections.

**Failure Mode**: If a BullMQ worker is stuck on a long job, the 30-second force-exit timeout kills the process. The `terminationGracePeriodSeconds` in the pod spec must be 35s+ to allow this.

---

### INT-5: HPA Helm template renders correct YAML for production values

**Boundary**: Helm template rendering + YAML validation.

**Setup**: Helm CLI available. Chart templates and values files accessible.

**Steps**:

1. Run `helm template runtime ./charts/runtime -f values.yaml -f environments/production/scaling-values.yaml --show-only templates/hpa.yaml`.
2. Parse the output YAML.
3. Assert `apiVersion: autoscaling/v2`.
4. Assert `spec.scaleTargetRef.name` matches the Runtime Deployment name.
5. Assert `spec.minReplicas: 2`.
6. Assert `spec.maxReplicas: 20`.
7. Assert `spec.metrics` contains a CPU target with `averageUtilization: 70`.
8. Assert `spec.metrics` contains a memory target with `averageUtilization: 75`.
9. Assert `spec.behavior.scaleDown.stabilizationWindowSeconds: 300`.
10. Assert `spec.behavior.scaleDown.policies` contains `{ type: Percent, value: 25, periodSeconds: 60 }`.
11. Assert `spec.behavior.scaleUp.stabilizationWindowSeconds: 0`.
12. Assert `spec.behavior.scaleUp.policies` contains `{ type: Pods, value: 4, periodSeconds: 60 }`.

**Expected Result**: Helm template produces valid HPA YAML with correct production scaling parameters.

**Failure Mode**: If Helm values are not properly templated, the HPA will use default Kubernetes values (which may cause oscillation or insufficient scaling).

---

### INT-6: KEDA ScaledObject Helm template renders with Redis trigger authentication

**Boundary**: Helm template rendering + KEDA CRD validation.

**Setup**: Helm CLI available. KEDA CRDs installed (for schema validation).

**Steps**:

1. Run `helm template searchai-worker ./charts/search-ai -f values.yaml -f environments/production/scaling-values.yaml --show-only templates/keda-workers.yaml`.
2. Parse the output YAML.
3. Assert a `ScaledObject` resource is rendered for the crawl worker.
4. Assert `spec.scaleTargetRef.name` matches the SearchAI crawl worker Deployment name.
5. Assert `spec.pollingInterval: 30`.
6. Assert `spec.cooldownPeriod: 300`.
7. Assert `spec.minReplicaCount: 1` (production, no scale-to-zero).
8. Assert `spec.maxReplicaCount: 10`.
9. Assert `spec.triggers[0].type: "redis"`.
10. Assert `spec.triggers[0].metadata.listName: "bull:crawl:wait"`.
11. Assert `spec.triggers[0].metadata.listLength: "5"`.
12. Assert `spec.triggers[0].authenticationRef` references a `TriggerAuthentication` resource.
13. Assert a `TriggerAuthentication` resource is rendered that references a Kubernetes Secret for Redis credentials.

**Expected Result**: KEDA ScaledObject is correctly configured with Redis trigger, authentication, and production-appropriate scaling bounds.

**Failure Mode**: Missing `TriggerAuthentication` would cause KEDA to fail connecting to Redis. Incorrect `listName` would cause KEDA to never trigger scaling.

---

### INT-7: PDB Helm template renders with correct minAvailable

**Boundary**: Helm template rendering + PDB validation.

**Setup**: Helm CLI available.

**Steps**:

1. Render PDB for Runtime with production values (3 replicas): assert `minAvailable: 2`.
2. Render PDB for Admin with production values (1 replica): assert `minAvailable: 1`.
3. Render PDB for Runtime with development values: assert PDB is not rendered (disabled).
4. Assert PDB `selector.matchLabels` matches the corresponding Deployment labels.
5. Validate rendered YAML against `policy/v1` PodDisruptionBudget schema.

**Expected Result**: PDBs render with correct `minAvailable` based on replica count and environment. Development environments can disable PDBs.

**Failure Mode**: If `minAvailable` equals `maxReplicas`, no pods can ever be evicted (node drains will stall).

---

### INT-8: VPA Helm template renders in recommendation-only mode

**Boundary**: Helm template rendering + VPA CRD validation.

**Setup**: Helm CLI available.

**Steps**:

1. Render VPA for Runtime: `helm template runtime ./charts/runtime --show-only templates/vpa.yaml`.
2. Assert `spec.updatePolicy.updateMode: "Off"` (recommendation only, no auto-apply).
3. Assert `spec.targetRef` references the Runtime Deployment.
4. Assert `spec.resourcePolicy.containerPolicies[0].minAllowed.cpu: "100m"`.
5. Assert `spec.resourcePolicy.containerPolicies[0].maxAllowed.cpu: "4"`.
6. Render VPA with `vpa.enabled: false` and assert no VPA resource is rendered.

**Expected Result**: VPA is configured in recommendation-only mode with bounded resource policies. Can be disabled via values.

**Failure Mode**: If `updateMode` is accidentally set to `Auto`, VPA will restart pods to apply recommendations, potentially conflicting with HPA.

---

## Unit Test Scenarios

### UNIT-1: Scaling values schema validation

**Module**: Helm values schema (JSON Schema or Zod in `packages/config`).

**Input**: Scaling configuration values with various valid and invalid combinations.

**Expected Output**:

- `hpa.runtime.minReplicas: 0` -- validation error (minimum 1).
- `hpa.runtime.maxReplicas: 1000` -- validation warning (unusually high).
- `hpa.runtime.targetCPUUtilization: 150` -- validation error (must be 1-100).
- `keda.workers.searchAiCrawl.minReplicas: -1` -- validation error (minimum 0).
- `pdb.runtime.minAvailable: 0` -- validation error (minimum 1).
- Valid production config -- passes validation.

---

### UNIT-2: Scaling event ClickHouse schema compliance

**Module**: ClickHouse scaling event insert function.

**Input**: Scaling event objects with various field values.

**Expected Output**:

- Event with `event_type: 'scale_up'` inserts successfully.
- Event with `event_type: 'invalid_type'` rejects (invalid enum).
- Events are queryable by `(timestamp, service)` and `(service, event_type)` indexes.

---

### UNIT-3: Admin scaling status endpoint response format

**Module**: `apps/admin/src/routes/scaling-status.ts` (PLANNED).

**Input**: GET request to `/api/admin/scaling/status`.

**Expected Output**: Response matches schema:

```json
{
  "services": [
    {
      "name": "runtime",
      "currentReplicas": 3,
      "desiredReplicas": 3,
      "minReplicas": 2,
      "maxReplicas": 20,
      "hpaStatus": "active",
      "kedaStatus": "active",
      "pdbStatus": { "minAvailable": 2, "disruptionsAllowed": 1 },
      "vpaRecommendation": { "cpu": "500m", "memory": "1Gi" }
    }
  ]
}
```

---

### UNIT-4: Custom Prometheus metric registration

**Module**: Runtime Prometheus metrics registry.

**Input**: Metric registration calls for `abl_runtime_active_sessions`, `abl_runtime_ws_connections`.

**Expected Output**:

- Metrics are registered as Prometheus gauges.
- `abl_runtime_active_sessions.set(5)` updates the gauge to 5.
- `abl_runtime_ws_connections.inc()` and `.dec()` work atomically.
- `/metrics` endpoint includes both metrics in Prometheus exposition format.

---

## Security & Isolation Tests

- [ ] KEDA service account has read-only access to Redis (cannot write or delete application keys)
- [ ] KEDA `TriggerAuthentication` references Kubernetes Secrets (not inline credentials)
- [ ] Admin scaling endpoints require platform-admin auth (`requirePermission('platform:admin')`)
- [ ] Scaling metrics endpoint (`/metrics`) is not exposed to external traffic (internal service port only)
- [ ] VPA recommendations do not automatically apply (updateMode remains "Off")
- [ ] PDB prevents eviction below `minAvailable` even during forced drain
- [ ] Scaling event ClickHouse table has appropriate TTL (90 days; no indefinite retention)
- [ ] Network policies allow KEDA-to-Redis and KEDA-to-Prometheus traffic but block KEDA-to-application-DB

---

## Performance & Load Tests

- [ ] **LOAD-1**: Sustained 1000 req/sec to Runtime for 15 minutes -- verify HPA scales to expected replica count and p99 latency stays < 2s
- [ ] **LOAD-2**: Enqueue 1000 BullMQ crawl jobs simultaneously -- verify KEDA scales workers to `maxReplicaCount` and all jobs complete within 10 minutes
- [ ] **LOAD-3**: Scale-from-zero cold start latency -- verify first request after KEDA scale-from-zero completes within 90 seconds
- [ ] **LOAD-4**: Rolling update with PDB -- verify zero 5xx responses during a Deployment rollout with 3 replicas and `minAvailable: 2`
- [ ] **LOAD-5**: Scale-down stabilization -- verify that a 30-second load spike followed by idle does NOT trigger scale-up (too brief for stabilization window)
- [ ] **LOAD-6**: Multi-pod Redis connection count -- scale Runtime to 20 replicas and verify Redis `connected_clients` stays within `maxclients` limit

---

## Test Infrastructure

- **Required services**: Kubernetes cluster (minikube or kind for local, managed cluster for staging), metrics-server, KEDA operator, VPA controller, Prometheus, Redis, MongoDB, ClickHouse.
- **Local testing**: Helm template unit tests require only `helm` CLI. Integration tests require Runtime/SearchAI running with Redis.
- **CI testing**: Helm template tests run in standard CI. E2E scaling tests require a Kubernetes cluster in CI (kind + KEDA Helm chart).
- **Staging testing**: Full E2E and load tests run against the staging environment with all scaling infrastructure deployed.
- **Environment variables for tests**: Lower thresholds for faster test execution:
  - `HPA_TARGET_CPU: 30` (trigger scaling at 30% CPU in tests)
  - `KEDA_POLLING_INTERVAL: 10` (10-second polling for faster trigger)
  - `KEDA_COOLDOWN_PERIOD: 30` (30-second cooldown for faster scale-to-zero)
  - `HPA_SCALEDOWN_STABILIZATION: 30` (30-second stabilization in tests)
- **Data seeding**: Create tenants, sessions, and queue jobs via API for E2E scenarios.

---

## Test File Mapping

| Test File                                                                        | Type        | Covers            |
| -------------------------------------------------------------------------------- | ----------- | ----------------- |
| `abl-platform-deploy/tests/hpa-rendering.test.ts` (PLANNED)                      | unit        | FR-1, FR-6, FR-13 |
| `abl-platform-deploy/tests/pdb-rendering.test.ts` (PLANNED)                      | unit        | FR-5              |
| `abl-platform-deploy/tests/keda-rendering.test.ts` (PLANNED)                     | unit        | FR-2, FR-3, FR-7  |
| `abl-platform-deploy/tests/vpa-rendering.test.ts` (PLANNED)                      | unit        | FR-4              |
| `abl-platform-deploy/tests/topology-rendering.test.ts` (PLANNED)                 | unit        | FR-10, FR-14      |
| `abl-platform-deploy/tests/scaling-values-schema.test.ts` (PLANNED)              | unit        | FR-13             |
| `apps/runtime/src/__tests__/scaling-metrics.test.ts` (PLANNED)                   | integration | FR-3, FR-11       |
| `apps/runtime/src/__tests__/e2e/scaling-readiness.e2e.test.ts` (PLANNED)         | e2e         | FR-9, FR-12       |
| `apps/runtime/src/__tests__/e2e/scaling-graceful-shutdown.e2e.test.ts` (PLANNED) | e2e         | FR-9              |
| `apps/runtime/src/__tests__/integration/bullmq-key-format.test.ts` (PLANNED)     | integration | FR-2              |
| `apps/admin/src/__tests__/scaling-status.test.ts` (PLANNED)                      | integration | FR-11, FR-15      |
| `tests/e2e/hpa-runtime-scaling.e2e.test.ts` (PLANNED)                            | e2e         | FR-1, FR-6        |
| `tests/e2e/keda-queue-scaling.e2e.test.ts` (PLANNED)                             | e2e         | FR-2, FR-7        |
| `tests/e2e/keda-custom-metrics.e2e.test.ts` (PLANNED)                            | e2e         | FR-3              |
| `tests/e2e/pdb-node-drain.e2e.test.ts` (PLANNED)                                 | e2e         | FR-5              |
| `tests/e2e/scaling-environment-profiles.e2e.test.ts` (PLANNED)                   | e2e         | FR-13             |
| `tests/load/runtime-hpa-scaling.k6.ts` (PLANNED)                                 | load        | FR-1, FR-6        |
| `tests/load/keda-queue-scaling.k6.ts` (PLANNED)                                  | load        | FR-2, FR-7        |

---

## Test Coverage Map

### Helm Templates (abl-platform-deploy)

- [ ] HPA renders for Runtime, SearchAI, Studio, Admin with correct targets
- [ ] HPA behavior (stabilization, policies) renders correctly
- [ ] PDB renders with correct `minAvailable` per service
- [ ] KEDA ScaledObject renders for each queue worker with Redis trigger
- [ ] KEDA ScaledObject renders for Runtime with Prometheus trigger
- [ ] KEDA `TriggerAuthentication` renders with Secret reference
- [ ] VPA renders in Off mode with resource bounds
- [ ] Topology spread constraints render for Runtime and SearchAI
- [ ] Anti-affinity rules render as preferred (not required)
- [ ] Per-environment value overrides produce different rendered output
- [ ] Scale-to-zero is disabled in production, enabled in staging/dev
- [ ] Disabled features (HPA, KEDA, VPA, PDB) produce no resources when `enabled: false`

### Application (Runtime, SearchAI)

- [x] Runtime readiness probe returns 503 during shutdown (existing test)
- [x] SearchAI readiness probe returns 503 during shutdown (existing test)
- [x] Runtime graceful shutdown handles SIGTERM (existing code, tested via `shutdownRuntimeServer`)
- [x] SearchAI graceful shutdown handles SIGTERM (existing code)
- [ ] Runtime exposes `abl_runtime_active_sessions` Prometheus metric
- [ ] Runtime exposes `abl_runtime_ws_connections` Prometheus metric
- [ ] Runtime exposes `abl_runtime_request_p99_latency_ms` Prometheus metric
- [ ] BullMQ queue key patterns match KEDA Redis list scaler expectations
- [ ] Graceful shutdown completes within `terminationGracePeriodSeconds`
- [ ] WebSocket clients receive shutdown notification during scale-down

### Infrastructure (Kubernetes Cluster)

- [ ] HPA scales pods up under sustained CPU load
- [ ] HPA scales pods down after stabilization window
- [ ] KEDA scales queue workers based on Redis list length
- [ ] KEDA scale-to-zero activates and deactivates correctly
- [ ] PDB prevents eviction below `minAvailable`
- [ ] Karpenter/CA provisions nodes for pending pods
- [ ] Rolling updates produce zero downtime with PDBs

### What the Current Coverage Actually Proves

- [x] Runtime and SearchAI handle SIGTERM gracefully with proper shutdown sequencing
- [x] Readiness probes correctly report shutdown state
- [ ] No autoscaling infrastructure is deployed or tested
- [ ] No custom Prometheus metrics exist for KEDA triggers
- [ ] No Helm templates for HPA, KEDA, VPA, or PDB exist
- [ ] No end-to-end scaling behavior has been validated

---

## Pending / Future Work

- [ ] Create HPA Helm templates for all HTTP-serving deployments (Phase 1)
- [ ] Create PDB Helm templates for all deployments (Phase 1)
- [ ] Install KEDA operator in staging and create ScaledObject templates (Phase 2)
- [ ] Validate BullMQ Redis key patterns for KEDA compatibility (Phase 2)
- [ ] Add custom Prometheus metrics to Runtime (Phase 3)
- [ ] Create VPA Helm templates in recommendation mode (Phase 3)
- [ ] Configure Karpenter NodePool templates (Phase 4)
- [ ] Build Grafana scaling dashboards (Phase 5)
- [ ] Implement Admin portal scaling status API (Phase 5)
- [ ] Run load tests in staging to validate scaling behavior (Phase 6)
- [ ] Write comprehensive Helm template unit tests (all phases)
- [ ] Write E2E scaling tests with kind + KEDA in CI (Phase 6)

---

## Open Testing Questions

1. Should E2E scaling tests run in CI (kind cluster + KEDA Helm install) or only in staging? CI adds infrastructure complexity but catches regressions earlier.
2. What is the minimum Kubernetes version required for `autoscaling/v2` HPA and `policy/v1` PDB? Need to verify cluster compatibility.
3. Should BullMQ key format tests use a real Redis instance or mock the key structure? Real Redis ensures accuracy but adds test dependency.
4. How should load tests be parameterized to be reproducible across different cluster sizes?
5. Should KEDA operator installation be part of the Helm chart (subchart dependency) or a separate prerequisite?
6. What is the acceptable scale-from-zero latency for customer-facing services (Runtime, SearchAI)? This determines whether scale-to-zero should be limited to workers only.

---

## References

- Related feature doc: [docs/features/horizontal-scaling.md](../features/horizontal-scaling.md)
- Related test doc: [docs/testing/rate-limiting.md](rate-limiting.md) (rate limiting interacts with scaling)
- Kubernetes HPA testing: https://kubernetes.io/docs/tasks/run-application/horizontal-pod-autoscale-walkthrough/
- KEDA testing guide: https://keda.sh/docs/2.19/concepts/scaling-deployments/
- Existing graceful shutdown code: `apps/runtime/src/server.ts`, `apps/search-ai/src/server.ts`

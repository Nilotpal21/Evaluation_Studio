# Runtime Load Balancing — Full Overhaul Design

## Problem Statement

The ABL platform runtime uses stateless round-robin routing with shared Redis for session state. At scale (15-40 pods), this causes:

1. **MongoDB write contention** — multiple pods persist messages for the same session, causing transient transaction errors in `withTransaction` retries
2. **Wasted Redis round-trips** — every request on every pod loads session state from Redis, even though most sessions have repeat callers
3. **WebSocket reconnect scatter** — clients reconnecting after a pod restart land on a random pod, requiring Redis pub/sub cross-delivery
4. **No load-aware scaling** — HPA uses CPU/memory only, blind to session count, queue depth, or connection density
5. **No graceful drain** — scale-down kills pods with active sessions; clients see abrupt disconnects

## Design Constraints (from codebase)

| Constraint                                                                  | Impact                                                                         |
| --------------------------------------------------------------------------- | ------------------------------------------------------------------------------ |
| WebSocket `sessionId` arrives in first message, not at connect time         | NGINX can't hash-route WS upgrades by session                                  |
| HTTP chat `POST /api/v1/chat/stream` has `sessionId` in request body        | NGINX can't read request bodies for hash routing                               |
| Session state is fully in Redis with execution locks                        | Any pod CAN serve any session — affinity is an optimization, not a requirement |
| `lock:exec:{tenantId}:{sessionId}` with 5s TTL ensures single-pod execution | Concurrent execution is already prevented                                      |
| OTel metrics exist: `agent.active_sessions`, `http.server.active_requests`  | Available for KEDA scaling triggers                                            |
| KEDA template exists with Redis queue depth trigger                         | Infrastructure is ready, just needs configuration                              |
| Pod identity uses `pod_${process.pid}_${Date.now()}`                        | Not pod-stable; needs Kubernetes `HOSTNAME`                                    |

## Architecture Overview

Four layers, each independent and incrementally deployable:

```
┌─────────────────────────────────────────────────────────┐
│ Layer 1: Session Affinity Registry (Redis)              │
│   Redis hash: session-owner:{sessionId} → podId         │
│   Written on session create, read on subsequent requests │
│   TTL = session TTL. Fallback = process locally.        │
├─────────────────────────────────────────────────────────┤
│ Layer 2: Pod-Aware Request Routing (Application)        │
│   HTTP middleware: read owner registry → if not me,     │
│     process locally (no forwarding, just optimize       │
│     persistence queue to batch by owner pod)            │
│   WebSocket: after session bind, register ownership     │
├─────────────────────────────────────────────────────────┤
│ Layer 3: Partitioned Persistence Queue (BullMQ)         │
│   Queue per pod: message-persistence:{podId}            │
│   Messages for owned sessions → local queue             │
│   Messages for non-owned sessions → owner's queue       │
│   Eliminates MongoDB write contention entirely          │
├─────────────────────────────────────────────────────────┤
│ Layer 4: Load-Aware Scaling + Graceful Drain            │
│   KEDA: scale on active_sessions + queue depth          │
│   preStop: drain state, deregister from ring            │
│   Health: /health?ready=false during drain               │
└─────────────────────────────────────────────────────────┘
```

## Layer 1: Session Affinity Registry

### Design

A lightweight Redis registry that tracks which pod owns each session. This is the foundation — all other layers read from it.

```
Redis key:   session-owner:{tenantId}:{sessionId}
Value:       {podId}
TTL:         same as session TTL (30 minutes, refreshed on activity)
```

### Pod Identity

Each pod reads its Kubernetes hostname from the `HOSTNAME` env var (automatically set by K8s to the pod name). This replaces the current `pod_${process.pid}_${Date.now()}` pattern.

```typescript
// New: stable pod identity
const POD_ID = process.env.HOSTNAME || `local_${process.pid}`;
```

This is also used for the execution lock owner, making lock ownership pod-stable across restarts of the Node.js process within the same pod.

### Ownership Lifecycle

| Event            | Action                                                                   |
| ---------------- | ------------------------------------------------------------------------ |
| Session created  | `SET session-owner:{tenantId}:{sessionId} {podId} EX {sessionTtl}`       |
| Session accessed | `EXPIRE session-owner:{tenantId}:{sessionId} {sessionTtl}` (refresh TTL) |
| Session ended    | `DEL session-owner:{tenantId}:{sessionId}`                               |
| Pod draining     | Bulk delete all owned keys (via SCAN + match)                            |
| Owner pod gone   | Key expires naturally via TTL — next accessor becomes new owner          |

### Ownership Transfer

When a request arrives for a session owned by another pod:

1. **Try to acquire execution lock** — if lock is held by another pod, that pod is actively processing; queue the message normally
2. **If lock is free** — claim ownership: `SET session-owner:{tenantId}:{sessionId} {myPodId} EX {ttl}` and process locally
3. **No cross-pod HTTP forwarding** — every pod CAN process any session (state is in Redis). Ownership is an optimization hint for the persistence queue, not a hard routing constraint.

This is critical: **ownership is advisory, not mandatory.** If the owner pod is dead or slow, any pod picks up the session. The system degrades gracefully to the current round-robin behavior.

### Redis Cost

- One key per active session (~7,500 sessions at 300 VUs in the saturation test)
- Each key is ~80 bytes (key + value + TTL metadata)
- Total: ~600KB — negligible

## Layer 2: Pod-Aware Request Routing

### HTTP Requests

No request forwarding. Every pod processes every request it receives. The optimization is downstream in the persistence queue (Layer 3).

Middleware added to session-bound routes:

```typescript
// Lightweight middleware — runs on every session-bound request
async function refreshSessionOwnership(req, res, next) {
  const sessionId = req.params.sessionId || req.params.id;
  const tenantId = req.tenantContext?.tenantId;
  if (!sessionId || !tenantId) return next();

  // Refresh TTL if we own it; claim if unclaimed
  const ownerKey = `session-owner:${tenantId}:${sessionId}`;
  const currentOwner = await redis.get(ownerKey);
  if (!currentOwner || currentOwner === POD_ID) {
    await redis.set(ownerKey, POD_ID, 'EX', SESSION_TTL_SECONDS);
  }
  // Attach owner info for Layer 3 (persistence queue routing)
  req.sessionOwnerPodId = currentOwner || POD_ID;
  next();
}
```

### WebSocket

On `load_agent` (new session) or `resume_session` (existing):

```typescript
// In websocket/handler.ts after session is bound
await redis.set(
  `session-owner:${session.tenantId}:${session.id}`,
  POD_ID,
  'EX',
  SESSION_TTL_SECONDS,
);
```

WebSocket connections are inherently sticky once established. The ownership registration ensures that if the client reconnects to a different pod (after pod restart/scaling), the new pod claims ownership and the persistence queue routes accordingly.

### Why Not Forward Requests?

Cross-pod HTTP forwarding (pod A receives request → forwards to pod B) adds:

- Latency (extra network hop)
- Complexity (service discovery, health checking, retry logic)
- Failure modes (forwarding pod goes down mid-request)

Since any pod can process any session (state is in Redis), forwarding has no correctness benefit. The only benefit would be persistence queue locality, which Layer 3 achieves without forwarding.

## Layer 3: Partitioned Persistence Queue

### The Core Fix for MongoDB Contention

Currently: all pods produce to and consume from one shared `message-persistence` queue. Any worker on any pod may process any session's messages.

Proposed: each pod has its own persistence queue. Messages are routed to the **owner pod's queue**, so only one pod ever writes a given session's messages to MongoDB.

### Queue Naming

```
message-persistence:{podId}
```

Example with 3 pods:

```
message-persistence:runtime-abc123    → worker on pod runtime-abc123
message-persistence:runtime-def456    → worker on pod runtime-def456
message-persistence:runtime-ghi789    → worker on pod runtime-ghi789
```

### Routing Logic

In `flushAllBuffers()`, after batching messages by session:

```typescript
// Group messages by owner pod
const messagesByOwner = new Map<string, MessageJobData[]>();

for (const [sessionId, messages] of msgSnapshot) {
  const tenantId = messages[0]?.tenantId;
  const ownerKey = `session-owner:${tenantId}:${sessionId}`;
  const owner = (await redis.get(ownerKey)) || POD_ID; // fallback: process locally

  let batch = messagesByOwner.get(owner);
  if (!batch) {
    batch = [];
    messagesByOwner.set(owner, batch);
  }
  batch.push(...messages);
}

// Enqueue each batch to the owner's queue
for (const [ownerPodId, messages] of messagesByOwner) {
  const queueName = `message-persistence:${ownerPodId}`;
  const queue = getOrCreateQueue(queueName);
  // ... encrypt and enqueue as before
}
```

### Queue Lifecycle

| Event        | Action                                                                                    |
| ------------ | ----------------------------------------------------------------------------------------- |
| Pod starts   | Create `Queue` + `Worker` for `message-persistence:{POD_ID}`                              |
| Pod starts   | Also create `Worker` for `message-persistence:orphaned` (see below)                       |
| Pod draining | Stop accepting new jobs; finish in-flight jobs                                            |
| Pod stopping | Move remaining jobs from `message-persistence:{POD_ID}` to `message-persistence:orphaned` |
| Any pod      | Runs a worker on `message-persistence:orphaned` as fallback                               |

### Orphan Queue

When a pod is removed (scale-down, crash), its queue may have pending jobs. The `message-persistence:orphaned` queue is the safety net:

- During graceful shutdown, the pod moves its remaining jobs to the orphan queue
- All pods run a low-priority worker on the orphan queue
- For ungraceful crashes, a background sweeper (runs on every pod, leader-elected via Redis lock) checks for queues belonging to dead pods and moves their jobs to orphaned

### Benefits

| Before (shared queue)                          | After (partitioned)                 |
| ---------------------------------------------- | ----------------------------------- |
| Any pod writes any session                     | Only the owner pod writes a session |
| `applySessionTurnUpdate` conflicts across pods | Zero cross-pod write conflicts      |
| `withTransaction` retries under load           | No retries needed (single writer)   |
| 15 pods × concurrent writes = contention       | 1 pod per session = serial writes   |

### Fallback

If the ownership registry is unavailable (Redis outage), all messages route to the local pod's queue. This degrades to the current behavior — shared writes with potential contention, protected by `structuredClone`.

## Layer 4: Load-Aware Scaling + Graceful Drain

### KEDA Composite Scaling

Replace CPU-only HPA with KEDA using multiple triggers:

```yaml
runtime:
  keda:
    enabled: true
    minReplicas: 2
    maxReplicas: 40
    triggers:
      # 1. Active sessions per pod (primary)
      - type: prometheus
        metadata:
          serverAddress: http://prometheus:9090
          query: |
            avg(agent_active_sessions) by (pod)
          threshold: '200' # Scale up when avg sessions > 200/pod
          activationThreshold: '50'

      # 2. LLM queue depth (burst detection)
      - type: redis
        metadata:
          address: redis-master:6379
          listName: 'bull:llm-requests:wait'
          listLength: '50'
          activationListLength: '10'

      # 3. Message persistence queue depth (backpressure)
      - type: redis
        metadata:
          address: redis-master:6379
          listName: 'bull:message-persistence:orphaned:wait'
          listLength: '100'
          activationListLength: '20'
```

**Note:** OTel metrics need to be exposed to Prometheus for KEDA to read them. This requires either:

- An OTel Collector with Prometheus exporter (likely already running for Groundcover/Coroot)
- Or a `/metrics` Prometheus endpoint on the runtime (add `prom-client` as a secondary exporter)

### Graceful Drain

**Phase 1: preStop hook (Kubernetes)**

```yaml
# In deployment template
lifecycle:
  preStop:
    exec:
      command: ['/bin/sh', '-c', 'curl -s -X POST http://localhost:3112/admin/drain && sleep 30']
```

**Phase 2: Drain endpoint (application)**

New internal endpoint `POST /admin/drain` (admin-only, not exposed via ingress):

```typescript
app.post('/admin/drain', requireInternalOnly, async (req, res) => {
  // 1. Mark as draining — health check returns 503
  isDraining = true;

  // 2. Stop accepting new sessions
  //    (existing sessions continue until completion or timeout)

  // 3. Deregister from ownership registry
  //    SCAN for session-owner:*:{POD_ID} → delete or reassign
  await deregisterAllOwnedSessions();

  // 4. Move pending persistence jobs to orphan queue
  await migrateQueueToOrphan();

  res.json({ status: 'draining' });
});
```

**Phase 3: Health check drain state**

```typescript
app.get('/health', (req, res) => {
  if (isDraining) {
    // Return 503 so NGINX/K8s stop sending new requests
    // but don't terminate yet (preStop sleep gives time to finish)
    return res.status(503).json({ status: 'draining' });
  }
  // ... existing health check
});
```

**Drain timeline:**

```
t=0     SIGTERM received, preStop calls /admin/drain
t=0     isDraining=true → /health returns 503
t=0     K8s removes pod from Service endpoints (no new traffic)
t=0-5s  Deregister owned sessions, migrate queue jobs
t=5-30s Finish in-flight requests and WebSocket messages
t=30s   preStop sleep ends → K8s sends SIGKILL
t=30s   shutdownRuntimeServer() runs (already started at SIGTERM)
```

The existing `shutdownRuntimeServer()` (server.ts:3586) already handles WebSocket close, worker drain, and DB disconnect. The preStop hook adds the ownership deregistration and queue migration before the existing shutdown sequence.

### Pod Disruption Budget

```yaml
runtime:
  pdb:
    enabled: true
    minAvailable: '75%' # At 40 pods, always keep 30 running
```

This prevents K8s from evicting too many pods simultaneously during node upgrades or cluster autoscaler drain.

## Migration Strategy

All four layers are **independently deployable**. Each layer improves the system without requiring the others.

### Phase 1: Pod Identity + Ownership Registry (Layer 1)

- Add `HOSTNAME` env var to deployment spec
- Replace `pod_${process.pid}_${Date.now()}` with `HOSTNAME`
- Add session ownership SET/GET to session create/load
- **Zero breaking changes** — just writes new Redis keys

### Phase 2: Partitioned Persistence Queue (Layer 3)

- Each pod creates its own named queue + worker
- `flushAllBuffers` routes by owner
- Add orphan queue + sweeper
- **Depends on Layer 1** — needs ownership registry to route

### Phase 3: Load-Aware Scaling (Layer 4 - KEDA)

- Enable KEDA with composite triggers
- Add Prometheus metric export
- Disable HPA (KEDA replaces it)
- **Independent** — can deploy before or after Layers 1-2

### Phase 4: Graceful Drain (Layer 4 - Drain)

- Add `/admin/drain` endpoint
- Add preStop hook to deployment template
- Update health check for drain state
- Enable PDB
- **Depends on Layers 1-2** — needs ownership deregistration and queue migration

## Estimated Impact

| Metric                        | Before (round-robin)                | After (affinity + partitioned queue)                  |
| ----------------------------- | ----------------------------------- | ----------------------------------------------------- |
| MongoDB write conflicts       | ~2-5/sec at 40 pods                 | ~0 (single writer per session)                        |
| Redis round-trips per request | 3-5 (load session + lock + release) | 2-3 (+ 1 ownership check, but session cached locally) |
| WebSocket reconnect latency   | 50-200ms (pub/sub cross-delivery)   | <10ms (same pod if affinity holds)                    |
| Scale-down session disruption | Abrupt disconnect                   | 30s graceful drain                                    |
| HPA responsiveness            | CPU-reactive (lagging)              | Session-count proactive (leading)                     |

## Non-Goals

- **No cross-pod HTTP forwarding** — adds latency and complexity for no correctness benefit
- **No NGINX-level session affinity** — sessionId not available at NGINX routing time for the primary traffic paths (WS and HTTP chat body)
- **No StatefulSet** — runtime pods are functionally identical; the ownership registry provides soft affinity without requiring stable pod names
- **No session migration protocol** — unnecessary because state is in Redis; new owner just reads it

## Risks

| Risk                                     | Mitigation                                                           |
| ---------------------------------------- | -------------------------------------------------------------------- |
| Redis ownership registry unavailable     | Fallback to local processing (current behavior)                      |
| Orphan queue grows unbounded after crash | Sweeper runs on all pods; alert on orphan queue depth                |
| KEDA misconfigured → over-scaling        | Set hard `maxReplicas`, `cooldownPeriod: 300`                        |
| Pod identity collision after restart     | K8s assigns unique pod names; `HOSTNAME` is stable per pod lifecycle |
| Ownership registry adds latency          | Single `GET` per request (~0.1ms on local Redis); negligible         |

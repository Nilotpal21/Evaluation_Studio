# Capacity Planning Knobs Reference

Every knob that affects runtime throughput (msg/s) and latency (p95), how to measure its effect, and what to test.

---

## The Request Pipeline — What Happens Per Message

Every chat message traverses this pipeline. Each layer adds latency and consumes resources:

```
Client
  │
  ▼
┌─────────────────┐
│ Ingress-NGINX    │  → CPU, connections, worker_connections
│ (L7 proxy)       │
└────────┬────────┘
         │
         ▼
┌─────────────────┐
│ Runtime Pod      │  → CPU, memory, event loop, heap, sessions
│ (Node.js)        │
│                  │
│  ┌─ Auth         │  → JWT verify, Redis lookup for token metadata
│  ├─ Rate Limit   │  → Redis INCR + TTL per tenant (5000 req/min ENTERPRISE)
│  ├─ Session      │  → MongoDB read/write (find-or-create session doc)
│  │  └─ In-memory │  → Map<sessionId, RuntimeSession> (max 10,000 per pod)
│  ├─ Agent IR     │  → MongoDB read (agent config, model config, prompt templates)
│  ├─ Model Resolve│  → MongoDB read (tenant model, credentials) + cache
│  ├─ LLM Call     │  → External HTTP to LLM provider (1-30s depending on model)
│  ├─ Stream/Buffer│  → SSE connection hold OR REST buffer (memory per connection)
│  ├─ Persistence  │  → MongoDB write (message doc, trace events, session update)
│  └─ Response     │  → JSON serialize + send
└────────┬────────┘
         │
    ┌────┴────┐
    ▼         ▼
┌────────┐ ┌────────┐
│MongoDB │ │ Redis  │
│(primary)│ │(master)│
└────────┘ └────────┘
```

**Per-message resource consumption:**

- ~3-6 MongoDB operations (session find, agent config read, model config read, message write, trace write, session update)
- ~2-4 Redis operations (auth token lookup, rate limit check, pub/sub notification)
- ~1 LLM HTTP call (1s mock, 2-30s real)
- ~50-200ms platform overhead (auth + session + persistence) with warm caches
- ~1-5MB peak memory per concurrent connection (session object + message buffer + trace events)

---

## The Knobs — Organized by Layer

### Layer 1: Runtime Pod Resources

| Knob               | Current (dev)               | Effect on Throughput                                                                                           | Effect on p95                                                | How to Test                                                                            |
| ------------------ | --------------------------- | -------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------ | -------------------------------------------------------------------------------------- |
| **CPU request**    | 1 core                      | Sets HPA scaling trigger. Lower request = HPA scales sooner = more pods = more total throughput                | No direct effect on per-pod p95                              | Baseline run at 1 core, then 500m, compare HPA trigger point                           |
| **CPU limit**      | 2 cores (Tier S: 2, dev: 4) | Hard ceiling on per-pod compute. When CPU hits limit, CFS throttling kicks in → event loop stalls → p95 spikes | Direct: limit 2 → throttling at ~1.5 cores of sustained load | Run saturation at limit=2 vs limit=4, compare max safe msg/s                           |
| **Memory request** | 2Gi                         | Scheduling guarantee. Too low = pod evicted under memory pressure                                              | Indirect: OOM kills cause request failures                   | Monitor heap ratio + RSS during saturation                                             |
| **Memory limit**   | 4Gi                         | OOM kill threshold. Sessions + heap + native buffers must fit                                                  | Direct: OOM = pod restart = p95 spike + dropped connections  | Run saturation and watch RSS vs limit. If RSS > 80% of limit, you'll OOM at higher VUs |
| **Replica count**  | 2 (default)                 | Linear scaling up to datastore ceiling: 2 pods ≈ 2x throughput                                                 | No effect per-pod. Reduces p95 if pods were overloaded       | Single-pod saturation → 2-pod → 3-pod. Compare total msg/s and per-pod msg/s           |

### Layer 2: Node.js Runtime Internals

| Knob                        | Current                 | Effect on Throughput                                                                                                           | Effect on p95                                                   | How to Test                                                                                                         |
| --------------------------- | ----------------------- | ------------------------------------------------------------------------------------------------------------------------------ | --------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------- |
| **MAX_IN_MEMORY_SESSIONS**  | 10,000                  | Cap on concurrent sessions per pod. At limit, forced eviction — evicted sessions need full MongoDB reload on next message      | Indirect: eviction + reload adds ~50-100ms per affected message | Run with high VUs (30+) for 10+ minutes, monitor `localCachedSessions` in poll JSON. If it hits 10K, sessions churn |
| **SESSION_STALE_THRESHOLD** | 30 min                  | How long idle sessions stay in memory. Shorter = more eviction = more MongoDB reloads, but lower memory                        | Trade-off: shorter saves memory, longer saves MongoDB reads     | Not easily tested in saturation (sessions are active). Matters for mixed-traffic production patterns                |
| **Event loop**              | N/A (V8)                | Single-threaded — all request handling shares one event loop. Blocking work (sync I/O, heavy JSON parse, GC) blocks everything | Direct: event loop lag > 100ms = all concurrent requests stall  | Monitor via Coroot `get_app_nodejs`. If event loop lag is RED but CPU is GREEN, there's blocking work               |
| **Heap / GC**               | V8 default (~1.5GB max) | V8 GC pauses increase with heap size. Above 0.85 heap ratio, GC runs frequently and aggressively                               | Direct: GC pause > 50ms avg = p95 spikes during GC              | Monitor heap ratio in poll JSON `/health`. Heap ratio > 0.85 = approaching GC death spiral                          |

### Layer 3: MongoDB

| Knob                                  | Current (dev)                            | Effect on Throughput                                                                                                                                 | Effect on p95                                                                                                                                            | How to Test                                                                                        |
| ------------------------------------- | ---------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------- |
| **MONGODB_MAX_POOL_SIZE**             | 10-20 per pod                            | Connections per runtime pod to MongoDB. Total connections = pods × pool_size. MongoDB handles ~10K connections but each adds context-switch overhead | Higher pool = more concurrent DB ops = higher throughput... until MongoDB CPU saturates. Lower pool = requests queue in runtime waiting for a connection | Saturation test at pool_size=10 vs 20 vs 50. Watch Coroot MongoDB connections + write latency      |
| **MongoDB CPU limit**                 | 16 cores (dev) / 4 cores (Tier S)        | Primary write path is single-writer (WiredTiger). CPU limit determines how fast ops execute                                                          | Direct: write latency rises when CPU > 80% of limit                                                                                                      | Monitor `mongodb.top[0].cpu` vs limit in poll JSON. Compare write latency at different load levels |
| **MongoDB memory / WiredTiger cache** | 4GB cache (Tier S)                       | Determines how much of the working set fits in RAM. Cache miss = disk read = 10-30ms latency                                                         | Direct: cache misses add 10-30ms per affected operation                                                                                                  | Monitor Coroot disk read latency. If read latency spikes, working set exceeds cache                |
| **MongoDB disk (IOPS)**               | StandardSSD E10: 500 IOPS, 60 MBps (dev) | Journal fsync + data writes compete for IOPS. At 500 IOPS limit, writes queue                                                                        | Direct: write latency > 100ms when IOPS > 450                                                                                                            | Monitor Coroot `storage.iopsWrite`. Known bottleneck on dev cluster                                |
| **MongoDB replicas**                  | 3 (replica set)                          | Replication doesn't help write throughput (single primary). Helps read throughput if reads go to secondaries                                         | Indirect: replication lag affects failover safety, not p95                                                                                               | Monitor Coroot replication lag. Not a saturation knob                                              |

### Layer 4: Redis

| Knob                       | Current (dev)    | Effect on Throughput                                                                                | Effect on p95                                                              | How to Test                                                                                    |
| -------------------------- | ---------------- | --------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------- |
| **Redis master CPU limit** | 2 cores (Tier S) | Redis is single-threaded for commands. One core = the ceiling. Above 70% CPU, command latency rises | Direct: all auth + rate-limit + pub/sub operations go through master       | Monitor `redis.top[0].cpu` in poll JSON. If master CPU > 70% of limit, Redis is the bottleneck |
| **Redis maxmemory**        | 3GB (Tier S)     | When memory hits limit, behavior depends on eviction policy. With `noeviction`, writes fail         | Critical: write failures = auth failures = cascading errors                | Monitor Redis memory via Coroot. If approaching maxmemory, sessions/caches fail                |
| **Redis connections**      | Pool per pod     | Each runtime pod maintains a Redis connection pool. Total = pods × pool_size                        | Indirect: too many connections = Redis CPU wasted on connection management | Not usually a bottleneck for < 50 pods                                                         |

### Layer 5: LLM Provider

| Knob                  | Current (test)     | Effect on Throughput                                                                                                                                                               | Effect on p95                                                                                                       | How to Test                                                                             |
| --------------------- | ------------------ | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------- |
| **LLM latency**       | 1s (mock)          | The dominant factor in per-message time. With 1s mock: time_per_turn ≈ 1s + 0.1s overhead + 1s inter-message delay = 2.1s. With real LLM (3-10s): time_per_turn = 3-10s + overhead | Inverse: higher LLM latency = lower msg/s per VU (each VU is blocked longer). But less platform pressure per second | Run with different mock delays: 500ms, 1000ms, 2000ms, 5000ms. Plot msg/s vs mock delay |
| **Streaming vs REST** | REST (test script) | Streaming holds connections open for seconds, consuming event loop cycles and memory per connection. REST blocks and returns                                                       | Streaming: lower throughput due to connection hold. REST: higher throughput but unrealistic                         | Need streaming test script (not built yet)                                              |

### Layer 6: Test Configuration

| Knob                    | Current          | Effect on Throughput                                                                                                    | Effect on p95                                                                                        | How to Test                                                                  |
| ----------------------- | ---------------- | ----------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------- |
| **TURNS per session**   | 5                | More turns = more messages per session = session stays in memory longer. First turn (create) is heavier than follow-ups | Higher turns = higher follow-up-to-create ratio = slightly higher msg/s (creates are more expensive) | Run with TURNS=1 (create-only) vs TURNS=5 vs TURNS=10. Compare msg/s and p95 |
| **INTER_MESSAGE_DELAY** | 1s               | Pause between messages. Lower = more pressure per VU. Higher = more realistic but slower throughput                     | Direct: delay 0 = max pressure per VU (unrealistic). Delay 1s = realistic. Delay 2s = conservative   | Run with delay=0 vs delay=1 vs delay=2. Delay=0 finds the hard ceiling       |
| **VU count**            | variable (steps) | Each VU = one concurrent conversation. More VUs = more concurrent load                                                  | Linear until saturation: msg/s increases with VUs until a bottleneck caps it                         | The saturation test ladder IS this experiment                                |
| **Multi-tenant**        | false (single)   | Single tenant = one rate limit bucket (5000 req/min). Multi-tenant = N buckets                                          | Required when VUs × turns/s > 83 msg/s (5000/60). Below that, single tenant is fine                  | For per-pod saturation at 10-30 VUs, single tenant is fine                   |

### Layer 7: Cluster / Infrastructure

| Knob                           | Current (dev)          | Effect on Throughput                                                                      | Effect on p95                                                         | How to Test                                                                      |
| ------------------------------ | ---------------------- | ----------------------------------------------------------------------------------------- | --------------------------------------------------------------------- | -------------------------------------------------------------------------------- |
| **Node CPU**                   | 8 cores per node (dev) | All pods on a node share the CPU. Runtime + MongoDB on same node = contention             | Indirect: node CPU > 85% = scheduler delays for ALL pods on that node | Monitor `cluster.nodesTop[*].cpuPercent` in poll JSON                            |
| **HPA targetCPU**              | 50% (dev)              | Trigger threshold for auto-scaling. Lower = more responsive (scales sooner) but more pods | Indirect: slow HPA = pods overloaded during ramp                      | Not relevant for pinned-replica saturation tests. Matters for auto-scaling tests |
| **HPA maxReplicas**            | varies                 | Ceiling on pod count. Once hit, no more scaling                                           | If reached while CPU > target, system is at HPA ceiling               | Monitor in poll JSON: `hpa.currentReplicas == hpa.maxReplicas` AND CPU > target  |
| **Ingress worker_connections** | default                | Limits concurrent connections through ingress                                             | Becomes bottleneck at high pod counts (>50 pods, >1000 VUs)           | Monitor ingress CPU. Not relevant for single-pod tests                           |

---

## The Experiment Matrix — What to Test and In What Order

### Phase 1: Baseline (First Run)

**Goal:** Establish the per-pod saturation point with default config.

```
Config: 1 pod, mock 1s, TURNS=5, delay=1s, pool_size=default
Steps:  5, 10, 15, 20, 25, 30 VUs
Target: p95 < 1500ms
Output: max safe msg/s per pod, bottleneck identification
```

This is the number all other experiments compare against.

### Phase 2: Isolate the LLM Delay Effect

**Goal:** Understand how LLM latency affects throughput.

| Run | Mock Delay | Expected msg/s per VU                             | Why                                            |
| --- | ---------- | ------------------------------------------------- | ---------------------------------------------- |
| 2a  | 500ms      | ~1.33/VU (time_per_turn = 0.5 + 0.1 + 1.0 = 1.6s) | Faster LLM = more platform pressure per second |
| 2b  | 1000ms     | ~0.48/VU (time_per_turn = 1.0 + 0.1 + 1.0 = 2.1s) | Baseline delay                                 |
| 2c  | 2000ms     | ~0.32/VU (time_per_turn = 2.0 + 0.1 + 1.0 = 3.1s) | Slower LLM = less platform pressure            |
| 2d  | 5000ms     | ~0.16/VU (time_per_turn = 5.0 + 0.1 + 1.0 = 6.1s) | Approximates real LLM                          |

**Key insight:** Faster LLMs generate MORE platform pressure per second (more msg/s per VU), so the saturation point in VUs will be LOWER with faster LLMs but msg/s may be HIGHER.

### Phase 3: Isolate the Turn Structure Effect

**Goal:** Understand create-vs-followup cost ratio.

| Run | Turns           | Expected Behavior                                                                                                  |
| --- | --------------- | ------------------------------------------------------------------------------------------------------------------ |
| 3a  | 1 (create only) | Every message creates a new session. Heaviest on MongoDB (session write + agent config read). Lowest msg/s per VU. |
| 3b  | 5 (default)     | 1 create + 4 follow-ups. Follow-ups reuse cached session.                                                          |
| 3c  | 10              | 1 create + 9 follow-ups. High cache hit ratio. Sessions stay in memory longer.                                     |

**Key insight:** The create-to-followup ratio directly determines MongoDB write pressure. Production traffic patterns matter.

### Phase 4: CPU Limit Sensitivity

**Goal:** Find the relationship between CPU limit and saturation point.

| Run | CPU Limit | Expected Effect                                              |
| --- | --------- | ------------------------------------------------------------ |
| 4a  | 1 core    | Tight — CFS throttling starts early. Lower saturation point. |
| 4b  | 2 cores   | Standard Tier S. Baseline for production sizing.             |
| 4c  | 4 cores   | Dev default. More headroom before throttling.                |

Compare: max safe msg/s, CPU delay (Coroot), event loop lag, p95.

### Phase 5: MongoDB Pool Size Sensitivity

**Goal:** Find the optimal connection pool size.

| Run | Pool Size | Expected Effect                                                                                             |
| --- | --------- | ----------------------------------------------------------------------------------------------------------- |
| 5a  | 5         | Requests queue in runtime waiting for a connection. Lower throughput but lower MongoDB connection overhead. |
| 5b  | 10        | Default. Moderate parallelism.                                                                              |
| 5c  | 20        | More concurrent DB ops. Higher throughput until MongoDB CPU saturates.                                      |
| 5d  | 50        | Risk: 50 connections × N pods may overwhelm MongoDB.                                                        |

Monitor: MongoDB CPU, write latency, runtime event loop lag (queueing for connections shows as event loop lag).

### Phase 6: Multi-Pod Linear Scaling

**Goal:** Validate that N pods = N × per-pod throughput, or find the scaling ceiling.

| Run | Pods | Expected Total msg/s | Watch For                                                                 |
| --- | ---- | -------------------- | ------------------------------------------------------------------------- |
| 6a  | 1    | baseline             | Per-pod baseline                                                          |
| 6b  | 2    | 2 × baseline         | Does total msg/s double? If not, MongoDB or Redis is the shared ceiling.  |
| 6c  | 3    | 3 × baseline         | At what pod count does scaling become sub-linear?                         |
| 6d  | 5    | 5 × baseline         | MongoDB connections = 5 × pool_size. Watch MongoDB CPU and write latency. |

**Key insight:** This finds the datastore ceiling. If 2 pods = 1.8x (not 2x), the 10% loss is MongoDB or Redis.

### Phase 7: Inter-Message Delay Sensitivity

**Goal:** Understand think-time effect.

| Run | Delay | Effect                                                                   |
| --- | ----- | ------------------------------------------------------------------------ |
| 7a  | 0s    | Maximum pressure per VU. Unrealistic but finds the hard compute ceiling. |
| 7b  | 0.5s  | Moderate pressure.                                                       |
| 7c  | 1s    | Default. Realistic typing delay.                                         |
| 7d  | 2s    | Conservative. Simulates slow users.                                      |

---

## How to Read Results Across Experiments

After running multiple experiments, build this master comparison:

```markdown
| Experiment  | Config Change  | Pods | Max VUs | Max msg/s | msg/s per pod | p95 at max | Bottleneck       | vs Baseline          |
| ----------- | -------------- | ---- | ------- | --------- | ------------- | ---------- | ---------------- | -------------------- |
| Baseline    | default        | 1    | 20      | 11.2      | 11.2          | 1250ms     | Runtime CPU      | --                   |
| Mock 500ms  | faster LLM     | 1    | 15      | 13.8      | 13.8          | 1350ms     | Runtime CPU      | +23% msg/s, -25% VUs |
| Mock 2000ms | slower LLM     | 1    | 35      | 8.5       | 8.5           | 1180ms     | MongoDB          | -24% msg/s, +75% VUs |
| TURNS=1     | create only    | 1    | 15      | 8.0       | 8.0           | 1400ms     | MongoDB writes   | -29% msg/s           |
| TURNS=10    | more followups | 1    | 25      | 12.5      | 12.5          | 1200ms     | Runtime CPU      | +12% msg/s           |
| CPU limit 1 | tight CPU      | 1    | 12      | 7.5       | 7.5           | 1450ms     | CPU throttle     | -33% msg/s           |
| CPU limit 4 | loose CPU      | 1    | 28      | 14.0      | 14.0          | 1180ms     | MongoDB          | +25% msg/s           |
| Pool 5      | small pool     | 1    | 18      | 10.0      | 10.0          | 1350ms     | Connection queue | -11% msg/s           |
| Pool 20     | large pool     | 1    | 22      | 12.0      | 12.0          | 1200ms     | MongoDB CPU      | +7% msg/s            |
| 2 pods      | scaling        | 2    | 40      | 22.0      | 11.0          | 1270ms     | MongoDB          | 98% linear           |
| 3 pods      | scaling        | 3    | 55      | 30.0      | 10.0          | 1350ms     | MongoDB          | 89% linear           |
| 5 pods      | scaling        | 5    | 70      | 40.0      | 8.0           | 1450ms     | MongoDB IOPS     | 71% linear           |
```

This table IS your capacity planning model. From it you can derive:

1. **Per-pod capacity** at any CPU limit and LLM latency
2. **Scaling factor** — how many pods before MongoDB becomes the ceiling
3. **Optimal pool size** — the sweet spot between connection queueing and MongoDB overload
4. **Production sizing** — for X target msg/s with Y-second LLM latency: `pods = ceil(X / per_pod_msg_s_at_Y_delay)`

---

## Capacity Planning Formula

Once you have the experiment data:

```
# Per-pod capacity depends on LLM latency and CPU limit
per_pod_msg_s = f(cpu_limit, llm_latency, pool_size, turns)

# Total cluster capacity depends on pod count and scaling factor
scaling_factor(n_pods) = measured_total_msg_s(n_pods) / (n_pods * per_pod_msg_s)
  # typically: 1.0 at 1 pod, ~0.98 at 2, ~0.90 at 5, ~0.70 at 10+

# Target sizing
target_msg_s = peak_concurrent_users * messages_per_user_per_second
required_pods = ceil(target_msg_s / (per_pod_msg_s * scaling_factor(estimated_pods)))
required_mongo_iops = required_pods * ops_per_message * per_pod_msg_s
required_redis_ops = required_pods * redis_ops_per_message * per_pod_msg_s
```

---

## Quick Reference: Which Knob to Turn

| Symptom                      | First Knob                                            | Second Knob                        | Third Knob                              |
| ---------------------------- | ----------------------------------------------------- | ---------------------------------- | --------------------------------------- |
| p95 too high, CPU < 50%      | Check MongoDB write latency                           | Check event loop lag               | Check LLM latency                       |
| p95 too high, CPU > 75%      | Increase CPU limit                                    | Add more pods                      | Reduce pool_size (less DB contention)   |
| msg/s plateaus, CPU < 50%    | MongoDB is the ceiling — check write latency and IOPS | Reduce pool_size                   | Optimize DB queries (fewer ops/message) |
| msg/s plateaus, CPU > 75%    | Add more pods                                         | Increase CPU limit                 | —                                       |
| Scaling sub-linear at N pods | MongoDB IOPS or CPU is shared ceiling                 | Upgrade MongoDB disk (Premium SSD) | Reduce pool_size per pod                |
| Memory growing linearly      | Sessions accumulating                                 | Check MAX_IN_MEMORY_SESSIONS       | Check heap ratio                        |
| OOM kills during test        | Memory limit too low for concurrent sessions          | Increase memory limit              | Reduce MAX_IN_MEMORY_SESSIONS           |
| Rate limiting (429s)         | Enable multi-tenant mode                              | Upgrade tenant plan                | —                                       |

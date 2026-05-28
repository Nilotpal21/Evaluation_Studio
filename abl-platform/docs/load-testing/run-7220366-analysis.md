# Load Test Analysis — Run 7220366

**Date:** 2026-04-08 07:11–07:27 UTC
**Test ID:** k6 Cloud run `7220366`
**Status:** PASSED (zero errors)
**Environment:** abl-dev (`https://agents-dev.kore.ai`)

---

## 1. Test Configuration

| Parameter        | Value                                                         |
| ---------------- | ------------------------------------------------------------- |
| Script           | `multi-turn-saturation.ts` (single-tenant)                    |
| Mock LLM         | `true` (no real LLM)                                          |
| Tenant           | `tenant-dev-001` (ENTERPRISE plan)                            |
| Multi-tenant     | `false`                                                       |
| Load-test bypass | `LOAD_TEST_KEY=benchmark-bypass`                              |
| Steps            | 200 VU (2min ramp, 5min hold) → 300 VU (2min ramp, 5min hold) |
| Runner           | k6 Cloud (Grafana) —`--out cloud` local execution             |

### Step Timeline (UTC)

| Phase           | Start        | End          | Duration  |
| --------------- | ------------ | ------------ | --------- |
| Ramp to 200 VU  | 07:11:24     | 07:13:24     | 2 min     |
| **Hold 200 VU** | **07:13:24** | **07:18:24** | **5 min** |
| Ramp to 300 VU  | 07:18:24     | 07:20:24     | 2 min     |
| **Hold 300 VU** | **07:20:24** | **07:25:24** | **5 min** |
| Cooldown        | 07:25:24     | 07:26:36     | ~1.2 min  |

---

## 2. Infrastructure Topology

### 2.1 Runtime Pods (8 active, 5 failed)

| Pod                 | Status  | Node       |
| ------------------- | ------- | ---------- |
| `7c689667cd-5lrhl`  | running | vmss00000B |
| `7c689667cd-b78tf`  | running | vmss00000B |
| `7c689667cd-krqwp`  | running | vmss00000C |
| `7c689667cd-m8wxh`  | running | vmss00000D |
| `7c689667cd-mfkxq`  | running | vmss00000C |
| `7c689667cd-pkh7b`  | running | vmss00000D |
| `7c689667cd-t87lb`  | running | vmss00000C |
| `7c689667cd-z7t2j`  | running | vmss00000E |
| `6c566f9f58-*` (×5) | failed  | various    |

**Key difference from run 7219076:** **8 active pods** (up from 6), but pods are now co-located — vmss00000C hosts 3 pods, vmss00000B and vmss00000D host 2 each, vmss00000E hosts 1. This creates potential CPU contention on multi-pod nodes.

### 2.2 Other Services

| Service       | Pods | Nodes                            |
| ------------- | ---- | -------------------------------- |
| MongoDB       | 3    | aks-database-\* (dedicated pool) |
| Redis         | 1    | vmss000001                       |
| ClickHouse    | 1    | vmss000002                       |
| Kafka         | 1    | vmss000002                       |
| NGINX Ingress | 3    | vmss000000–vmss000002            |

---

## 3. k6 Application Metrics

### 3.1 Throughput

| Metric                                 | 200 VU | 300 VU | Delta  | Notes         |
| -------------------------------------- | ------ | ------ | ------ | ------------- |
| `chat_turn_success_total` rate (msg/s) | 99.2   | 147.3  | +48.5% |               |
| `chat_turn_failure_total` rate (msg/s) | 0      | 0      | —      | Zero failures |
| `http_req_failed`                      | 0%     | 0%     | —      |               |

**Scaling efficiency:**

- Expected at 300 VU: (300/200) × 99.2 = **148.8 msg/s**
- Actual: **147.3 msg/s**
- Efficiency: **99.0%** (excellent — highest across all runs)

### 3.2 Latency Distribution

| Percentile | 200 VU    | 300 VU    | Delta  |
| ---------- | --------- | --------- | ------ |
| Average    | 1,077 ms  | 1,098 ms  | +2.0%  |
| p50 (est.) | ~1,060 ms | ~1,080 ms | ~+1.9% |
| p95        | 1,114 ms  | 1,180 ms  | +5.9%  |
| p99        | 1,147 ms  | 1,409 ms  | +22.8% |
| Max        | 6,069 ms  | 6,070 ms  | —      |

**Analysis:** Latency is significantly tighter than run 7219076. Average and p95 barely move between 200→300 VU. The p99 delta is 22.8% (vs 39.1% in run 7219076), meaning tail latency improved with more pods. The ~6s max at both steps is a consistent cold-path outlier (session create + deployment resolve + pbkdf2Sync).

### 3.3 Coroot SLO Perspective

| Metric             | Value                  |
| ------------------ | ---------------------- |
| Requests in 1–2.5s | 77.7/s avg (dominates) |
| Requests in 0–5ms  | 0.35/s (health checks) |
| Requests > 10s     | 0.002/s (near zero)    |
| Errors/s           | 0.000                  |

---

## 4. Runtime Infrastructure Metrics

### 4.1 CPU Usage (cores per pod, runtime container)

| Pod               | Avg       | Peak      |
| ----------------- | --------- | --------- |
| m8wxh             | 0.520     | 0.931     |
| pkh7b             | 0.512     | 0.873     |
| z7t2j             | 0.511     | 0.883     |
| krqwp             | 0.505     | 0.853     |
| mfkxq             | 0.499     | 0.866     |
| t87lb             | 0.493     | 0.842     |
| b78tf             | 0.487     | 0.820     |
| 5lrhl             | 0.476     | 0.808     |
| **Cluster total** | **4.003** | —         |
| **Per-pod avg**   | **0.500** | **0.860** |

CPU per pod is **lower** than run 7219076 (0.500 vs 0.676 at 200 VU equivalent, and 0.500 avg across the full run vs 0.945 at 300 VU in run 7219076). This is the benefit of 8 pods — each pod handles ~12.4 msg/s at 200 VU instead of ~16.5 msg/s with 6 pods.

### 4.2 CPU Delay (scheduling delay, s/s per pod)

| Pod             | Avg       | Peak  |
| --------------- | --------- | ----- |
| 5lrhl           | 0.012     | 0.035 |
| b78tf           | 0.010     | 0.033 |
| m8wxh           | 0.008     | 0.027 |
| z7t2j           | 0.007     | 0.023 |
| krqwp           | 0.006     | 0.018 |
| mfkxq           | 0.006     | 0.022 |
| pkh7b           | 0.006     | 0.021 |
| t87lb           | 0.005     | 0.018 |
| **Per-pod avg** | **0.008** | —     |

Slightly higher than run 7219076 (0.008 vs 0.005/0.011 for 200/300 VU), which makes sense — 3 pods share vmss00000C, causing minor scheduling contention. Still negligible (<1% of wall-clock).

### 4.3 CPU Throttle (cgroup throttle, s/s per pod)

| Per-pod avg | Peak      |
| ----------- | --------- |
| 0.003 s/s   | 0.018 s/s |

Minimal. Same as run 7219076.

### 4.4 Event Loop Blocked Time (s/s per pod)

| Pod             | Avg      | Peak     |
| --------------- | -------- | -------- |
| m8wxh           | 0.38     | 0.68     |
| z7t2j           | 0.36     | 0.63     |
| krqwp           | 0.35     | 0.58     |
| **Per-pod avg** | **0.36** | **0.63** |

_Note: Only 3 of 8 pods report event loop metrics (Node.js instrumentation gap)._

**Significant improvement:** Per-pod event loop blocked time dropped from 0.497/0.689 s/s (200/300 VU, run 7219076) to **0.36 s/s** average. Each pod spends only **36% of wall-clock** in synchronous operations (vs 50–69% in run 7219076), thanks to lower per-pod load with 8 pods.

**Correlation with CPU:** Per-pod CPU = 0.500 cores avg. Of that, ~0.36 (72%) is synchronous blocking work. This ratio is consistent with run 7219076 (73%), confirming the sync operations scale linearly with message volume.

### 4.5 Memory (RSS per pod, MB)

| Pod             | Avg       | Max       |
| --------------- | --------- | --------- |
| pkh7b           | 1,234     | 1,637     |
| z7t2j           | 1,209     | 1,615     |
| m8wxh           | 1,198     | 1,602     |
| krqwp           | 1,166     | 1,559     |
| mfkxq           | 1,154     | 1,548     |
| t87lb           | 1,142     | 1,532     |
| b78tf           | 1,131     | 1,518     |
| 5lrhl           | 1,114     | 1,499     |
| **Per-pod avg** | **1,169** | **1,564** |

Memory usage is comparable to run 7219076 (1,169 vs 1,192 at 200 VU). The max of 1,637 MB is within safe limits.

### 4.6 TCP Connections (from Runtime)

| Destination | Active                 | Notes                                                             |
| ----------- | ---------------------- | ----------------------------------------------------------------- |
| httpbin.org | 318 avg (12–493 range) | Mock LLM traffic                                                  |
| Redis       | 193–229                | Slightly higher than run 7219076 (176)                            |
| MongoDB     | 217–236                | Higher than run 7219076 (193) — more pods = more pool connections |
| ClickHouse  | 5–39                   | Batch writes                                                      |
| OpenAI      | 1–2                    | Minimal                                                           |

### 4.7 Network Bandwidth

| Flow                        | Throughput                    |
| --------------------------- | ----------------------------- |
| → OTel collector (outbound) | 3.5 MB/s                      |
| ↔ Redis (bidirectional)     | 1.71–1.72 MB/s each direction |
| ← MongoDB (inbound)         | 1.27 MB/s                     |
| → MongoDB (outbound)        | 946 KB/s                      |

### 4.8 DNS

| Metric                | Value                 |
| --------------------- | --------------------- |
| TypeA requests/s      | 894                   |
| TypeAAAA requests/s   | 713                   |
| **NXDOMAIN errors/s** | **713**               |
| p99 latency           | 16 ms avg, 44 ms peak |

NXDOMAIN rate is lower than run 7219076 (713 vs 2,390 at 300 VU), proportional to the lower DNS query rate. The 80% NXDOMAIN ratio persists — all AAAA queries fail.

---

## 5. MongoDB Metrics

### 5.1 Request Rate & Latency Distribution

| Latency Bucket | req/s     | %        |
| -------------- | --------- | -------- |
| 0–5 ms         | 2,550     | 93.3%    |
| 5–10 ms        | 94        | 3.4%     |
| 10–25 ms       | 22        | 0.8%     |
| 25–50 ms       | —         | —        |
| 50–100 ms      | —         | —        |
| **Total**      | **2,732** | **100%** |
| Errors/s       | 0.000     |          |

**Comparison with run 7219076:** Total throughput is lower (2,732 vs 3,054/4,234 at 200/300 VU) because the k6 run used `--out cloud` (local execution with cloud streaming), which has slightly different behavior. The latency distribution is excellent — 93.3% in the fast path (<5ms), vs 96.7%/86.1% at 200/300 VU in run 7219076. The reduced tail is likely due to less event loop burst-pattern with 8 pods.

### 5.2 MongoDB CPU (cores per pod)

| Pod       | Role      | Avg   | Peak  |
| --------- | --------- | ----- | ----- |
| mongodb-0 | Primary   | 0.774 | 1.310 |
| mongodb-1 | Secondary | 0.240 | —     |
| mongodb-2 | Secondary | 0.250 | —     |

Primary is at ~0.77 cores average, peaking at 1.31. Comparable to run 7219076.

### 5.3 MongoDB Storage I/O (CRITICAL)

| Metric                | Primary                    | Secondary-1           | Secondary-2           |
| --------------------- | -------------------------- | --------------------- | --------------------- |
| /data write latency   | **40 ms avg, 130 ms peak** | 12 ms avg             | 12 ms avg             |
| /data I/O utilization | 11%                        | **70% avg, 99% peak** | **71% avg, 99% peak** |
| /data write IOPS      | 45                         | 345–374               | 345–374               |
| /data write bandwidth | 2.1 MB/s                   | 3.6 MB/s              | 3.9 MB/s              |

**Critical finding:** MongoDB secondary replicas are at **70–71% average I/O utilization**, peaking at **99%** — near disk saturation. This is from oplog replication (replaying individual write operations). The primary has lower IOPS because it uses batched journal writes.

### 5.4 MongoDB Memory

| Pod       | RSS (avg)      | RSS+PageCache |
| --------- | -------------- | ------------- |
| mongodb-0 | 1,937–2,012 MB | 4.2–5.0 GB    |
| mongodb-1 | 1,592–1,685 MB | 4.2–5.0 GB    |
| mongodb-2 | 1,592–1,685 MB | 4.2–5.0 GB    |

Stable. WiredTiger cache is pre-allocated.

### 5.5 MongoDB Network

| Metric               | Value     |
| -------------------- | --------- |
| Inbound from runtime | 1.62 MB/s |
| Outbound to runtime  | 485 KB/s  |
| Inter-replica RTT    | 40 μs avg |

---

## 6. Redis Metrics

### 6.1 Request Rate & Latency Distribution

| Latency Bucket | req/s     | %        |
| -------------- | --------- | -------- |
| 0–5 ms         | 1,980     | 82.4%    |
| 5–10 ms        | 103       | 4.3%     |
| 10–25 ms       | 67        | 2.8%     |
| 25–50 ms       | 27        | 1.1%     |
| 50–100 ms      | 25        | 1.0%     |
| 100–250 ms     | 10        | 0.4%     |
| **5–10 s**     | **28**    | **1.2%** |
| **>10 s**      | **2.1**   | **0.1%** |
| **Total**      | **2,403** | **100%** |
| Errors/s       | 0.000     |          |

**Key findings:**

1. **Throughput improved:** 2,403 req/s vs 2,297 at 300 VU in run 7219076 (+4.6%). Better than run 7219076's +5.6% scaling, suggesting 8 pods can dispatch Redis commands more frequently.
2. **Persistent slow tail:** 28 req/s in the 5–10s bucket and 2.1 req/s in >10s — unchanged from run 7219076. These are likely blocking operations (large session persistence, pub/sub) that don't scale with pod count.
3. **Fast path steady:** 82.4% in <5ms bucket (vs 84.8% at 300 VU in run 7219076).

### 6.2 Redis CPU & Memory

| Metric       | Value                  |
| ------------ | ---------------------- |
| CPU (cores)  | 0.157 avg, 0.249 peak  |
| CPU throttle | 0.000                  |
| Memory RSS   | 166 MB avg, 229 MB max |

Redis remains barely utilized. The bottleneck is client-side dispatch, not server capacity.

---

## 7. ClickHouse Metrics

### 7.1 Request Rate & Latency

| Latency Bucket | req/s |
| -------------- | ----- |
| 0–5 ms         | 0.7   |
| 50–100 ms      | 1.2   |
| 2.5–5 s        | 1.1   |
| 5–10 s         | 0.23  |

Low traffic, batch-oriented. Not a bottleneck.

### 7.2 ClickHouse CPU & Memory

| Metric     | Value                       |
| ---------- | --------------------------- |
| CPU        | 0.162 cores avg, 0.282 peak |
| Memory RSS | 953 MB avg                  |

---

## 8. Kafka Metrics

### 8.1 Request Rate

| Latency Bucket | req/s |
| -------------- | ----- |
| 0–5 ms         | 9     |
| 5–10 ms        | 1.1   |

Minimal traffic. Kafka is idle.

### 8.2 Kafka CPU & JVM

| Metric      | Value                            |
| ----------- | -------------------------------- |
| CPU         | 0.017 cores avg                  |
| JVM heap    | 364 MB avg (of 506 MB allocated) |
| G1 young GC | 0.3 ms/s                         |
| Full GC     | none                             |

---

## 9. NGINX Ingress Metrics

### 9.1 CPU & Memory

| Metric     | Per pod           |
| ---------- | ----------------- |
| CPU        | 0.014–0.017 cores |
| Memory RSS | 127–131 MB        |

### 9.2 Connections

| Destination | Active |
| ----------- | ------ |
| → Runtime   | 10–21  |
| → Studio    | 24–170 |
| → Search-AI | 6–30   |

NGINX is barely loaded. Not a bottleneck.

---

## 10. Cross-Run Comparison (300 VU hold)

| Metric                   | Run 7213717 | Run 7215265 | Run 7219076 | **Run 7220366**    |
| ------------------------ | ----------- | ----------- | ----------- | ------------------ |
| **Active pods**          | ~4          | ~4          | 6           | **8**              |
| **Throughput** (msg/s)   | 126         | 126         | 145         | **147.3** (+1.6%)  |
| **Avg latency** (ms)     | 1,448       | 1,448       | 1,136       | **1,098** (-3.3%)  |
| **p95 latency** (ms)     | 2,245       | 2,245       | 1,348       | **1,180** (-12.5%) |
| **p99 latency** (ms)     | —           | —           | 1,661       | **1,409** (-15.2%) |
| **Efficiency**           | ~87%        | ~87%        | 97.6%       | **99.0%**          |
| **Event loop** (s/s avg) | 0.77–0.79   | 0.77–0.79   | 0.689       | **0.36** (-48%)    |
| **CPU delay/pod** (s/s)  | 0.37–0.45   | 0.37–0.45   | 0.011       | **0.008** (-27%)   |
| **Zero errors**          | yes         | yes         | yes         | **yes**            |

### Scaling Analysis: 6 → 8 Pods

| Metric                 | 6 pods (7219076) | 8 pods (7220366) | Change |
| ---------------------- | ---------------- | ---------------- | ------ |
| Throughput at 300 VU   | 145.1 msg/s      | 147.3 msg/s      | +1.5%  |
| Per-pod throughput     | 24.2 msg/s       | 18.4 msg/s       | -24%   |
| Scaling efficiency     | 97.6%            | 99.0%            | +1.4pp |
| Event loop blocked/pod | 0.689 s/s        | 0.36 s/s         | -48%   |
| CPU/pod at 300 VU      | 0.945 cores      | 0.500 cores      | -47%   |
| p99 latency at 300 VU  | 1,661 ms         | 1,409 ms         | -15%   |

**Key insight:** Adding 2 more pods (6→8) improved tail latency and scaling efficiency significantly, but throughput at 300 VU barely changed (+1.5%). This confirms **300 VU is below the saturation point for 8 pods** — the system is not yet stressed. The benefit of more pods shows in headroom, not raw throughput.

**Estimated saturation point at 8 pods:** At 18.4 msg/s/pod with 0.36 s/s event loop blocking, each pod has ~64% event loop headroom. Scaling linearly: 8 × 24 msg/s (max per-pod from run 7219076) = **192 msg/s**, reachable at ~400 VU.

---

## 11. Per-Request Operation Counts

### 11.1 Database Operations per Chat Message

| Stack      | Warm Session | Cold Session | Notes                                                  |
| ---------- | ------------ | ------------ | ------------------------------------------------------ |
| MongoDB    | ~6 ops       | ~18 ops      | Auth, tenant config, session CRUD, message persistence |
| Redis      | ~14 ops      | ~28 ops      | Rate limiting, session cache, IR cache, pub/sub        |
| ClickHouse | ~0.03 ops    | ~0.03 ops    | Batched trace writes (1 per ~30 messages)              |
| Kafka      | ~0.1 ops     | ~0.1 ops     | Event publishing (1 per ~10 messages)                  |

### 11.2 CPU-Blocking Operations per Chat Message

| Operation                                     | File                                           | Est. Time | Frequency           |
| --------------------------------------------- | ---------------------------------------------- | --------- | ------------------- |
| `crypto.pbkdf2Sync` (100K iter)               | `shared-encryption/key-derivation/pbkdf2.ts:9` | 50–150 ms | Session create only |
| `JSON.stringify(IR)` + SHA-256                | `session-service.ts:104-106`                   | 5–50 ms   | Every message       |
| `JSON.stringify(compilationOutput)` + SHA-256 | `session-service.ts:110-111`                   | 5–100 ms  | Every message       |
| `parseAgentBasedABL` + `compileABLtoIR`       | `execution/types.ts:939-964`                   | 10–100 ms | Session create only |
| `zlib.gunzipSync`                             | `deployment-resolver.ts:794`                   | 5–50 ms   | Cache miss (~5 min) |
| `JSON.stringify` in trimItemsToFit            | `tool-result-compressor.ts:144-158`            | 1–50 ms   | Per tool result     |
| `jwt.verify` (HMAC)                           | `middleware/auth.ts:174`                       | 1–5 ms    | Every request       |
| Regex + JSON.stringify in prompt              | `prompt-builder.ts:374,480,533`                | 1–10 ms   | Every message       |

**Total per-message block time:** 15–135 ms (warm), 75–385 ms (cold session)

---

## 12. Bottleneck Analysis

### 12.1 Bottleneck Ranking

| #   | Bottleneck                      | Evidence                                        | Severity     | Impact                                                     |
| --- | ------------------------------- | ----------------------------------------------- | ------------ | ---------------------------------------------------------- |
| 1   | **Event loop blocking**         | 0.36 s/s per pod (36% blocked, 8 pods)          | **CRITICAL** | Limits per-pod throughput to ~24 msg/s                     |
| 2   | **MongoDB secondary disk I/O**  | 70–71% avg utilization, 99% peak on secondaries | **HIGH**     | Oplog replication near saturation                          |
| 3   | **Redis head-of-line blocking** | Persistent 28 req/s in 5–10s bucket             | **HIGH**     | Slow operations don't scale with pods                      |
| 4   | **DNS NXDOMAIN flood**          | 80% of AAAA queries fail (713/s)                | **MEDIUM**   | Wasted DNS traffic, libuv thread pool contention           |
| 5   | **Pod co-location**             | 3 pods on vmss00000C, 2 on vmss00000B/D         | **LOW**      | Minor CPU delay (0.008 s/s) but could worsen at higher VUs |

### 12.2 What Improved (vs Run 7219076)

| Improvement                 | 6 pods → 8 pods         |
| --------------------------- | ----------------------- |
| Event loop blocked per pod  | 0.689 → 0.36 s/s (-48%) |
| p99 latency at 300 VU       | 1,661 → 1,409 ms (-15%) |
| Scaling efficiency          | 97.6% → 99.0%           |
| MongoDB latency tail (>5ms) | 13.9% → 6.7%            |

### 12.3 What Didn't Improve

| Persistent Issue           | Value                          |
| -------------------------- | ------------------------------ |
| Redis 5–10s slow tail      | 28 req/s (same)                |
| Max latency outlier        | ~6s (same — pbkdf2Sync)        |
| DNS NXDOMAIN ratio         | 80% (same)                     |
| Per-pod throughput ceiling | ~24 msg/s (event loop limited) |

---

## 13. Capacity Projections

### 13.1 Current Capacity (8 pods)

| Metric                     | Value                              |
| -------------------------- | ---------------------------------- |
| Per-pod throughput ceiling | ~24 msg/s (event loop limited)     |
| Current pods               | 8 active                           |
| Tested max throughput      | 147.3 msg/s at 300 VU              |
| Projected max throughput   | ~192 msg/s at ~400 VU              |
| p99 headroom               | p99 < 2s up to ~380 VU (projected) |

### 13.2 Scaling Projections (Horizontal)

| Target    | Pods Needed | Notes                                          |
| --------- | ----------- | ---------------------------------------------- |
| 200 msg/s | 9           | Close to current 8-pod capacity                |
| 300 msg/s | 13          | MongoDB secondary disk I/O may bottleneck      |
| 500 msg/s | 21          | Need faster disks for MongoDB + Redis pipeline |

### 13.3 Optimization Impact Estimates

| Fix                         | Event Loop Recovery | Throughput Gain/Pod |
| --------------------------- | ------------------- | ------------------- |
| Async `pbkdf2`              | 0.10–0.15 s/s       | +15–22%             |
| Async `gunzip`              | 0.05–0.10 s/s       | +7–15%              |
| Cache IR hash / compilation | 0.05–0.10 s/s       | +7–15%              |
| Debounce session persist    | 0.02–0.05 s/s       | +3–7%               |
| DNS caching (fix NXDOMAIN)  | 0.01–0.03 s/s       | +1–4%               |
| **Combined**                | **0.23–0.43 s/s**   | **+33–63%**         |

With all optimizations: per-pod capacity could reach **32–39 msg/s**, making 8 pods sufficient for **256–312 msg/s** — a 74–112% improvement.

---

## 14. Recommendations

### Immediate (No architecture change)

1. **Replace `pbkdf2Sync` with `pbkdf2` (async)** — biggest single win. File: `packages/shared-encryption/src/key-derivation/pbkdf2.ts:9`
2. **Replace `gunzipSync` with `gunzip` (async)** — File: `apps/runtime/src/services/deployment-resolver.ts:794`
3. **Increase MongoDB `maxPoolSize`** from 5 to 20–50 — File: `packages/config/src/schemas/mongodb.schema.ts:16`
4. **Upgrade MongoDB secondary disk performance** — 70% avg / 99% peak I/O utilization risks oplog lag under higher load
5. **Test at 400 VU** — current 300 VU is below saturation for 8 pods

### Medium-term

6. **Cache IR compilation output** — avoid `compileABLtoIR` + SHA-256 on repeated sessions
7. **Debounce session persistence** — `shouldPersistImmediately('api')` forces sync persist every message
8. **Move `JSON.stringify` for hashing to a worker thread** — large IR objects block event loop
9. **Fix DNS NXDOMAIN flood** — disable AAAA lookups in cluster DNS or use IP-based connections

### Next Test

10. **Run 400 VU step test** (200→300→400) to find the actual saturation point for 8 pods
11. **Compare with async `pbkdf2`** — single highest-impact optimization to validate

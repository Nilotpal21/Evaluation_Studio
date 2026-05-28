# Tier Validation Plan — Saturation Runs Per Tier

**Created:** 2026-04-30
**Goal:** Measure real per-tier capacity using exact Helm values configs. No extrapolations — measured data only.
**Constraint:** Each pod handles up to 25 VUs max.

---

## Run Structure

Each tier gets **3 steps**: 2 within capacity + 1 overload step (~25% beyond max) to find the break point.

| Step           | Purpose                                          |
| -------------- | ------------------------------------------------ |
| Step 1         | 50% of tier pod capacity — warm-up baseline      |
| Step 2         | 100% of tier pod capacity — full rated load      |
| Step 3 (extra) | ~125% overload — find latency knee / error cliff |

**Hold:** 5 min/step | **Ramp:** 60s | **Turns:** 5 | **LLM:** mock (1s httpbin)
**p95 target:** 1500ms

---

## Per-Tier Run Configs

### Tier S (Starter)

| Setting                 | Value               |
| ----------------------- | ------------------- |
| **Runtime pods**        | 2 (fixed, no HPA)   |
| **CPU req/limit**       | 1 / 2               |
| **Memory req/limit**    | 2Gi / 4Gi           |
| **Max VUs at capacity** | 50 (2 pods x 25 VU) |

| Step         | VUs | Expected msg/s | What to watch                            |
| ------------ | --- | -------------- | ---------------------------------------- |
| 1            | 25  | ~12-15         | Baseline per-pod metrics at 50% load     |
| 2            | 50  | ~24-28         | Full capacity — CPU%, heap, p95          |
| 3 (overload) | 65  | ~28-35         | Break point — GC pressure, p95 > 1500ms? |

**Deploy config:** Pin runtime replicas=2, HPA disabled, image=latest stable.
**MongoDB:** 3-node RS, 100Gi gp3 (3000 IOPS baseline).
**Redis:** 3-node sentinel.

---

### Tier M (Mid-Market)

| Setting                 | Value                       |
| ----------------------- | --------------------------- |
| **Runtime pods**        | 3 min → 6 max (HPA enabled) |
| **CPU req/limit**       | 2 / 4                       |
| **Memory req/limit**    | 4Gi / 8Gi                   |
| **HPA target**          | CPU 70%                     |
| **Max VUs at capacity** | 150 (6 pods x 25 VU)        |

| Step         | VUs | Expected msg/s | What to watch                          |
| ------------ | --- | -------------- | -------------------------------------- |
| 1            | 75  | ~45-55         | Does HPA scale 3→6 fast enough?        |
| 2            | 150 | ~90-100        | Full capacity at 6 pods — CPU%, heap   |
| 3 (overload) | 185 | ~110-130       | HPA ceiling hit — latency degradation? |

**Deploy config:** Pin runtime HPA min=3 max=6, CPU target=70%.
**MongoDB:** 3-node RS + hidden member, 500Gi gp3.
**Redis:** 6-node cluster.

**Key question:** Does doubling CPU request (2 vs 1 in benchmarks) improve per-pod throughput, or does Node.js single-thread cap it regardless?

---

### Tier L (Enterprise)

| Setting                 | Value                        |
| ----------------------- | ---------------------------- |
| **Runtime pods**        | 6 min → 20 max (HPA enabled) |
| **CPU req/limit**       | 4 / 8                        |
| **Memory req/limit**    | 8Gi / 16Gi                   |
| **HPA target**          | CPU 65%                      |
| **Max VUs at capacity** | 500 (20 pods x 25 VU)        |

| Step         | VUs | Expected msg/s | What to watch                           |
| ------------ | --- | -------------- | --------------------------------------- |
| 1            | 250 | ~150-200       | HPA behavior 6→20, scale-up speed       |
| 2            | 500 | ~300-400       | Full capacity at 20 pods — MongoDB IOPS |
| 3 (overload) | 625 | ~350-450       | HPA ceiling — break point               |

**Deploy config:** Pin runtime HPA min=6 max=20, CPU target=65%.
**MongoDB:** 3 shards x 3 RS, 2Ti gp3.
**Redis:** 12-node cluster.

**Key questions:**

- Does 4 CPU request help or waste scheduler capacity vs 1-2 CPU?
- Does 8Gi memory help or is 4Gi sufficient (RSS peaked at 1.5Gi in prior runs)?
- At 300+ msg/s, does MongoDB IOPS become the bottleneck again?

---

### Tier XL (Hyperscale)

| Setting                 | Value                         |
| ----------------------- | ----------------------------- |
| **Runtime pods**        | 12 min → 40 max (HPA enabled) |
| **CPU req/limit**       | 4 / 8                         |
| **Memory req/limit**    | 8Gi / 16Gi                    |
| **HPA target**          | CPU 60%                       |
| **Max VUs at capacity** | 1000 (40 pods x 25 VU)        |

| Step         | VUs  | Expected msg/s | What to watch                              |
| ------------ | ---- | -------------- | ------------------------------------------ |
| 1            | 500  | ~300-400       | Baseline at 50% — HPA 12→40 scale speed    |
| 2            | 1000 | ~600-800       | Full capacity at 40 pods                   |
| 3 (overload) | 1250 | ~700-900       | HPA ceiling — break point vs claimed 500K+ |

**Deploy config:** Pin runtime HPA min=12 max=40, CPU target=60%.
**MongoDB:** 5 shards x 3 RS, 4Ti io2.
**Redis:** 36-node cluster + cache cluster.

**Key question:** Can 40 pods sustain the claimed 500K+ conv/day? Prior benchmarks hit 782 msg/s at 60 pods — 40 pods will likely cap lower.

---

## Execution Order

1. **Tier S** — cheapest, fastest, establishes per-pod baseline at Tier S resource spec
2. **Tier M** — validates HPA behavior + mid-market capacity
3. **Tier L** — tests MongoDB sharding under load
4. **Tier XL** — final hyperscale validation

Each tier: deploy config → run saturation → collect report → revert config → next tier.

---

## Success Criteria

| Metric                             | PASS                            | FAIL                               |
| ---------------------------------- | ------------------------------- | ---------------------------------- |
| p95 at Step 2 (100% capacity)      | < 1500ms                        | >= 1500ms                          |
| Error rate at Step 2               | < 0.1%                          | >= 0.1%                            |
| HPA reaches max before Step 2 hold | Yes (for M/L/XL)                | No (means HPA too slow)            |
| Step 3 shows clear degradation     | Yes (proves we found the limit) | No (means we need higher overload) |

---

## Metrics to Capture Per Run

- k6: msg/s, p50/p90/p95/p99, error rate, VU count
- Runtime: CPU%, RSS, heap used/rss ratio, GC pause max, event loop lag
- MongoDB: read/write IOPS, checkpoint latency, WiredTiger cache usage
- Redis: ops/s, memory usage, connected clients
- HPA: replica count timeline, scale-up/down events
- Nodes: count, pending pods, CPU/memory pressure

---

## Prior Benchmark Reference

| Run            | Pods      | Config                     | Peak msg/s | Per-pod | p95    |
| -------------- | --------- | -------------------------- | ---------- | ------- | ------ |
| 7308523 (best) | 60 fixed  | 1 req / 4 limit CPU, 2-4Gi | 781.8      | 13.0    | 1245ms |
| 7301545        | 50→60 HPA | 1 req / 4 limit CPU, 2-4Gi | 769.5      | 12.8    | 1368ms |
| 7281213        | 1 fixed   | 1 req / 4 limit CPU, 2-4Gi | 12.03      | 12.03   | 1106ms |

All prior runs used **1 CPU request / 4 CPU limit**. Tier M/L/XL use 2-4 CPU request — this is the first time we'll measure whether higher CPU requests improve throughput.

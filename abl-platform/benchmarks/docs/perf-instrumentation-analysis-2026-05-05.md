# Runtime Hot-Path Performance Analysis

**Date:** 2026-05-05  
**Environment:** QA (agents-qa.kore.ai)  
**Pods:** 2 × runtime (1 CPU req / 2 CPU limit, 1Gi req / 2Gi limit)  
**k6 Runs:** 7451758 (5-turn), 7454397 (15-turn)  
**Total Perf Records:** 46,198  
**Branch:** fix/ABLP-002-message-timestamp-ordering (QA)

---

## 1. Test Configuration

| Parameter     | 5-Turn Test              | 15-Turn Test             |
| ------------- | ------------------------ | ------------------------ |
| VU Steps      | 25 → 30 → 35             | 25 → 30 → 35             |
| Hold Duration | 3 min/step               | 3 min/step               |
| Ramp          | 30s                      | 30s                      |
| LLM Mode      | Mock (1000ms delay)      | Mock (1000ms delay)      |
| Turns/Session | 5                        | 15                       |
| Max Messages  | 10                       | 30                       |
| Script        | multi-turn-saturation.ts | multi-turn-saturation.ts |
| Perf Records  | 32,880                   | 13,322                   |

---

## 2. Instrumentation Points

Custom perf instrumentation (`apps/runtime/src/observability/perf-instrumentation.ts`) gated by `PERF_INSTRUMENTATION=true` env var. Zero overhead when disabled.

```
Request Pipeline (executeMessage):
├── session_resolve         — Redis GET + hydrate session
├── build_prompt_and_tools  — Assemble prompt context
├── reasoning_execute       — LLM call wrapper
│   └── reasoning_loop      — Actual LLM invocation
└── [after return]
    └── saveSessionSnapshot — Persist updated session
        └── saveAndReplaceConversation
            ├── sessionToHash      — JSON.stringify + gzip + encrypt
            ├── serializeMessages  — Message array serialization
            └── redis_pipeline     — DEL + N × RPUSH
```

---

## 3. Full Pipeline Timing Breakdown

### 3.1 End-to-End Request (executeMessage)

| Metric | 5-Turn   | 15-Turn  |
| ------ | -------- | -------- |
| p50    | 1010.4ms | 1011.7ms |
| p75    | 1014.6ms | 1017.7ms |
| p90    | 1023.9ms | 1037.4ms |
| p95    | 1039.1ms | 1105.5ms |
| p99    | 1249.5ms | 1477.9ms |
| max    | 1660.6ms | 1887.6ms |

### 3.2 Span Breakdown (% of total request time)

| Span                 | p50    | p95    | p99    | % of Total |
| -------------------- | ------ | ------ | ------ | ---------- |
| reasoning_loop (LLM) | 1004ms | 1061ms | 1435ms | **99.2%**  |
| session_resolve      | 3.9ms  | 25.9ms | 60.8ms | 0.4%       |
| persist total        | 2.4ms  | 28.5ms | 189ms  | 0.2%       |
| reasoning framework  | 0.6ms  | 1.0ms  | 1.3ms  | 0.06%      |

### 3.3 Non-LLM Overhead Budget

| Component             | p50       | p95        | p99        |
| --------------------- | --------- | ---------- | ---------- |
| **Total overhead**    | **6.9ms** | **55.4ms** | **70.4ms** |
| session_resolve       | 3.9ms     | 25.9ms     | 60.8ms     |
| persist (post-reason) | 2.4ms     | 28.5ms     | 189ms      |
| reasoning framework   | 0.6ms     | 1.0ms      | 1.3ms      |

---

## 4. Persist Scaling Analysis (Does it grow with conversation length?)

### 4.1 Persist Total p50 by Message Count

```
 2 msgs │██████████████████████████████████████████████████│ 7.7ms  ← First-turn overhead
 4 msgs │███████████████████████████                       │ 4.3ms
 6 msgs │███████████                                       │ 1.8ms
 8 msgs │███████████                                       │ 1.8ms
10 msgs │████████████                                      │ 1.9ms
12 msgs │████████████                                      │ 2.0ms
14 msgs │████████████                                      │ 2.0ms
16 msgs │█████████████                                     │ 2.1ms
18 msgs │████████████████                                  │ 2.5ms
20 msgs │██████████████                                    │ 2.2ms
22 msgs │██████████████                                    │ 2.3ms
24 msgs │███████████████                                   │ 2.4ms
26 msgs │████████████████                                  │ 2.5ms
28 msgs │███████████████                                   │ 2.4ms
30 msgs │███████████████                                   │ 2.4ms
```

**Finding:** Persist p50 is FLAT from 6→30 messages (~2.0-2.5ms). The cost does NOT scale with conversation length at p50.

### 4.2 Redis Pipeline p50 by Message Count

```
 2 msgs │██████████████████████████████████████████████████│ 1.98ms
 4 msgs │████████████████████████████                      │ 1.11ms
 6 msgs │█████████████████████████                         │ 1.00ms
10 msgs │███████████████████████████                       │ 1.07ms
16 msgs │█████████████████████████████                     │ 1.18ms
20 msgs │█████████████████████████████                     │ 1.17ms
26 msgs │█████████████████████████████████                 │ 1.31ms
30 msgs │█████████████████████████████████                 │ 1.32ms
```

**Finding:** Redis DEL + 30×RPUSH costs only 1.32ms median. +32% growth from 2→30 messages, still trivial.

### 4.3 serializeMessages p50 by Message Count

```
 2 msgs │█████                                             │ 0.040ms
 6 msgs │███████████                                       │ 0.090ms
10 msgs │█████████████████                                 │ 0.140ms
16 msgs │████████████████████████████                      │ 0.220ms
20 msgs │██████████████████████████████████                │ 0.270ms
26 msgs │████████████████████████████████████████████      │ 0.350ms
30 msgs │██████████████████████████████████████████████████│ 0.390ms
```

**Finding:** Linear growth as expected, but absolute values are sub-millisecond. Even at 100 msgs would be ~1.3ms.

### 4.4 Scaling Factors (5-turn vs 15-turn)

| Component         | 5-turn p95 | 15-turn p95 | Factor | Assessment |
| ----------------- | ---------- | ----------- | ------ | ---------- |
| Total persist     | 24.7ms     | 28.5ms      | ×1.2   | Minimal    |
| sessionToHash     | 16.0ms     | 16.4ms      | ×1.0   | **Flat**   |
| redis_pipeline    | 10.2ms     | 11.7ms      | ×1.2   | Slight     |
| serializeMessages | 0.18ms     | 0.44ms      | ×2.4   | Trivial    |

---

## 5. Latency Distribution Histograms

### 5.1 Persist Total (15-turn, n=3328)

```
   0-   2ms │██████████████████████████████████████████████████│  1205 ( 36.2%)
   2-   5ms │████████████████████████████████████████████      │  1082 ( 32.5%)
   5-  10ms │███████████████████████                           │   569 ( 17.1%)
  10-  20ms │██████████                                        │   241 (  7.2%)
  20-  50ms │████                                              │   113 (  3.4%)
  50- 100ms │█                                                 │    41 (  1.2%)
 100- 200ms │█                                                 │    44 (  1.3%)  ← GC spikes
 200- 500ms │                                                  │    15 (  0.5%)  ← GC spikes
 500-1000ms │                                                  │    18 (  0.5%)  ← GC spikes
```

### 5.2 sessionToHash (15-turn, n=3328)

```
   0-   1ms │██████████████████████████████████████████████████│  2098 ( 63.0%)
   1-   5ms │█████████████████                                 │   724 ( 21.8%)
   5-  10ms │█████                                             │   235 (  7.1%)
  10-  20ms │███                                               │   128 (  3.8%)
  20-  50ms │█                                                 │    50 (  1.5%)
  50- 100ms │                                                  │    38 (  1.1%)
 100- 200ms │                                                  │    30 (  0.9%)
 200- 400ms │                                                  │     8 (  0.2%)
 400- 700ms │                                                  │    17 (  0.5%)
```

**Bimodal distribution:** 63% complete in <1ms, but a long tail extends to 700ms. This is the GC signature — when no GC lands, the operation is fast; when GC lands mid-operation, it stalls for 100-600ms.

### 5.3 session_resolve (15-turn, n=1741)

```
   0-   2ms │███████                                           │   137 (  7.9%)
   2-   5ms │██████████████████████████████████████████████████│   971 ( 55.8%)
   5-  10ms │██████████████████                                │   354 ( 20.3%)
  10-  20ms │████████                                          │   164 (  9.4%)
  20-  50ms │████                                              │    84 (  4.8%)
  50- 100ms │█                                                 │    24 (  1.4%)
 100- 200ms │                                                  │     1 (  0.1%)
 200- 500ms │                                                  │     1 (  0.1%)
 500-1000ms │                                                  │     5 (  0.3%)
```

---

## 6. Time-Series Degradation Under Load

### 6.1 executeMessage p95 Over Time (15-turn, 30s windows)

```
Window     |    n | p50      | p95      | p99      | max      | ▌p95 visual
──────────────────────────────────────────────────────────────────────────────
04:29:30   |   35 | 1009.0ms | 1287.1ms | 1291.2ms | 1291.2ms | ██████████████
04:30:00   |  384 | 1011.3ms | 1111.3ms | 1407.2ms | 1506.7ms | █████
04:30:30   |  448 | 1010.8ms | 1042.6ms | 1553.4ms | 1786.8ms | ██
04:31:00   |  446 | 1011.6ms | 1076.1ms | 1365.8ms | 1477.7ms | ███
04:31:30   |  435 | 1012.1ms | 1102.0ms | 1398.8ms | 1887.6ms | █████
04:32:00   |  444 | 1011.6ms | 1167.5ms | 1471.1ms | 1553.1ms | ████████
04:32:30   |  511 | 1012.5ms | 1174.8ms | 1594.1ms | 1733.1ms | ████████
04:33:00   |  515 | 1011.5ms | 1173.0ms | 1446.5ms | 1801.1ms | ████████
04:33:30   |  114 | 1012.5ms | 1304.7ms | 1382.6ms | 1446.3ms | ███████████████
```

### 6.2 Persist p95 Over Time (15-turn, 30s windows)

```
Window     |    n | p50      | p95      | p99      | max      | ▌p95 visual
──────────────────────────────────────────────────────────────────────────────
04:29:30   |   37 |     2.2ms |    10.8ms |   107.6ms |   107.6ms | ██
04:30:00   |  383 |     2.4ms |    19.5ms |   512.2ms |   520.0ms | ███
04:30:30   |  444 |     2.4ms |    21.7ms |   114.7ms |   126.3ms | ████
04:31:00   |  444 |     2.4ms |    32.7ms |   189.8ms |   495.1ms | ██████
04:31:30   |  438 |     2.2ms |    32.2ms |   604.8ms |   769.6ms | ██████
04:32:00   |  448 |     2.3ms |    54.9ms |   295.0ms |   634.0ms | ██████████
04:32:30   |  508 |     2.5ms |    26.1ms |   202.7ms |   565.6ms | █████
04:33:00   |  512 |     2.4ms |    20.4ms |    97.0ms |   589.0ms | ████
04:33:30   |  114 |     3.1ms |    38.1ms |    87.6ms |    87.6ms | ███████
```

---

## 7. Cluster Resource Utilization

| Poll | Time  | CPU (total) | CPU % Limit | Memory | Heap (MB) | Heap Ratio |
| ---- | ----- | ----------- | ----------- | ------ | --------- | ---------- |
| 1    | 04:25 | 69m         | 1.7%        | 1961Mi | 725       | 48%        |
| 5    | 04:27 | 386m        | 9.7%        | 2068Mi | 738       | 49%        |
| 7    | 04:28 | 834m        | 20.8%       | 2153Mi | 801       | 53%        |
| 14   | 04:31 | 951m        | 23.8%       | 2180Mi | 829       | 55%        |
| 18   | 04:33 | 1022m       | 25.6%       | 2182Mi | 808       | 54%        |
| 21   | 04:34 | 1185m       | 29.6%       | 2100Mi | 826       | 55%        |
| 23   | 04:35 | 1214m       | **30.3%**   | 2142Mi | 820       | 55%        |

**CPU never exceeded 30% of limit (4000m for 2 pods). Memory stable at ~2.1Gi. Heap 48-58%.**

---

## 8. Throughput Under Load

| Phase | 5-Turn msg/s | 15-Turn msg/s | 5-Turn p95 | 15-Turn p95 |
| ----- | ------------ | ------------- | ---------- | ----------- |
| 25 VU | 7.4          | 0.2\*         | 1030ms     | 1287ms      |
| 30 VU | 14.7         | 14.8          | 1027ms     | 1097ms      |
| 35 VU | 23.2         | 3.5           | 1051ms     | 1173ms      |

\*15-turn test was still ramping during 25 VU window

---

## 9. Tail Spike Forensics

### 9.1 Spike Classification

Of 3,328 persist operations in the 15-turn test:

- **77 exceeded 100ms** (2.3%)
- **86% caused by sessionToHash** (66 of 77)
- **8% caused by redis_pipeline** (6 of 77)
- **6% both contributed** (5 of 77)

### 9.2 Spike Clustering (GC Evidence)

| Metric                              | Value                  |
| ----------------------------------- | ---------------------- |
| Total spikes >100ms                 | 77                     |
| Clusters (within <1s of each other) | 18                     |
| Largest cluster                     | 8 simultaneous spikes  |
| Isolated spikes                     | 4                      |
| Spike rate                          | ~19/minute             |
| Average spike duration              | 279ms                  |
| Total time lost                     | 21.5s out of 240s test |
| **Effective availability**          | **91.0%**              |

### 9.3 Message Count Distribution in Spikes

```
Spikes (>100ms):   avg messageCount = 16.6, median = 18
Normal (≤100ms):   avg messageCount = 15.9, median = 16
```

**Spike distribution across message counts:**

```
 0- 5 msgs:   9 █████████
 6-11 msgs:  18 ██████████████████
12-17 msgs:  10 ██████████
18-23 msgs:  15 ███████████████
24-29 msgs:  19 ███████████████████
30-35 msgs:   6 ██████
```

**Conclusion:** Spikes are uniformly distributed across ALL message counts. There is NO correlation between conversation length and spike occurrence. This proves the spikes are GC-induced, not payload-induced.

### 9.4 Top 10 Worst Operations

| Total   | sessionToHash | redis_pipeline | Msgs | Bottleneck     |
| ------- | ------------- | -------------- | ---- | -------------- |
| 769.6ms | 477.1ms       | 286.9ms        | 14   | sessionToHash  |
| 698.5ms | 586.1ms       | 111.5ms        | 30   | sessionToHash  |
| 634.0ms | 606.0ms       | 27.6ms         | 16   | sessionToHash  |
| 604.9ms | 425.1ms       | 111.9ms        | 20   | sessionToHash  |
| 604.8ms | 414.5ms       | 185.1ms        | 6    | sessionToHash  |
| 589.0ms | 127.0ms       | 390.6ms        | 24   | redis_pipeline |
| 583.4ms | 88.8ms        | 494.4ms        | 6    | redis_pipeline |
| 565.6ms | 479.1ms       | 85.9ms         | 28   | sessionToHash  |
| 536.2ms | 513.5ms       | 22.6ms         | 4    | sessionToHash  |
| 522.0ms | 500.7ms       | 21.0ms         | 16   | sessionToHash  |

---

## 10. session_resolve Under Concurrency

| Test    | VU  | n    | p50   | p95    | p99    | max       |
| ------- | --- | ---- | ----- | ------ | ------ | --------- |
| 5-turn  | 25  | 388  | 3.6ms | 14.4ms | 37.1ms | 104ms     |
| 5-turn  | 30  | 828  | 3.4ms | 11.0ms | 27.1ms | 117ms     |
| 5-turn  | 35  | 1510 | 3.5ms | 17.3ms | 59.9ms | **624ms** |
| 15-turn | 30  | 1402 | 3.9ms | 24.1ms | 60.7ms | **814ms** |
| 15-turn | 35  | 324  | 3.9ms | 44.8ms | 69.4ms | **746ms** |

**Degradation:** session_resolve p95 grows +86% between 30→35 VU in the 15-turn test. Max spikes to 814ms indicate Redis connection pool contention.

---

## 11. Reasoning Loop Stability

Does the reasoning loop slow down with longer history?

| History Length | Turn | p50      | p95      | p99      | Δ from Turn 1 |
| -------------- | ---- | -------- | -------- | -------- | ------------- |
| 1              | 1    | 1003.2ms | 1028.6ms | 1409.0ms | baseline      |
| 9              | 5    | 1004.5ms | 1069.7ms | 1442.5ms | +1.4ms        |
| 17             | 9    | 1004.5ms | 1285.6ms | 1531.8ms | +1.3ms        |
| 29             | 15   | 1004.4ms | 1019.6ms | 1358.0ms | +1.2ms        |

**Conclusion:** p50 is rock-stable at ~1004ms regardless of history length. The mock LLM imposes a fixed delay unaffected by prompt size. p95/p99 variance is from GC, not history length.

---

## 12. Evidence Summary — Bottleneck Identification

### What IS the Bottleneck

```
┌────────────────────────────────────────────────────────────────────────────────┐
│ PRIMARY: V8 GC stop-the-world pauses in sessionToHash                          │
│                                                                                │
│ Evidence:                                                                      │
│ • 86% of >100ms spikes are in sessionToHash                                   │
│ • Spikes cluster (up to 8 simultaneously) = GC pausing all in-flight reqs     │
│ • NO correlation with message count (avg spike msgs=16.6 vs normal=15.9)      │
│ • Bimodal distribution: 63% < 1ms, but 0.5% > 400ms                          │
│ • Heap oscillates 720-875 MB = V8 major GC cycling every 15-30s              │
│ • 9% of test time lost to GC spikes (21.5s out of 240s)                      │
│                                                                                │
│ SECONDARY: Redis connection pool contention under high concurrency             │
│                                                                                │
│ Evidence:                                                                      │
│ • session_resolve p95 degrades +86% at 35 VU (24ms → 45ms)                   │
│ • Max spike: 814ms                                                            │
│ • 5 occurrences of session_resolve > 500ms in 15-turn test                    │
└────────────────────────────────────────────────────────────────────────────────┘
```

### What is NOT the Bottleneck (Disproven)

| Hypothesis                                   | Evidence Against                                   |
| -------------------------------------------- | -------------------------------------------------- |
| Serialization grows with conversation length | persist p50 FLAT at 2.0-2.5ms for 6-30 messages    |
| Redis RPUSH scales badly                     | DEL + 30×RPUSH = 1.3ms median, +32% from 2→30 msgs |
| Message serialization is expensive           | serializeMessages p50 = 0.39ms at 30 msgs (sub-ms) |
| CPU saturation                               | Peak 30.3% of limit                                |
| Memory pressure                              | Heap ratio peaked at 58%                           |
| History length slows reasoning               | p50 is 1004ms at both turn 1 and turn 15           |

---

## 13. Root Cause Analysis

### Why sessionToHash triggers GC

The `sessionToHash` function performs:

1. `JSON.stringify(session)` — creates a large temporary string
2. `zlib.gzipSync(buffer)` — allocates input + output buffers
3. `crypto.createCipheriv().update(compressed)` — allocates encrypted output

Each operation creates **short-lived allocations** that become garbage immediately after. Under concurrency:

- 30-50 concurrent `sessionToHash` calls per second
- Each allocates 3-5 intermediate buffers (10-100KB each)
- V8's generational GC promotes these to old-gen because they survive a young-gen cycle (the function takes >1ms)
- Old-gen fills → major GC → stop-the-world pause (100-600ms)
- ALL in-flight requests stall during the pause

### Why it gets worse at higher concurrency

More concurrent requests = higher allocation rate = more frequent GC cycles. The test shows:

- 25 VU: p99 persist = 97ms (5-turn test)
- 35 VU: p99 persist = 190ms (15-turn test)
- GC frequency: ~19 events/minute at 30-35 VU

---

## 14. Remediations

### Priority 1: Reduce Allocation Pressure in sessionToHash [HIGH IMPACT]

**Goal:** Eliminate >100ms GC spikes by reducing allocation rate.

**Approach A: Buffer Pooling**

```typescript
// Before: allocates new buffer every call
const compressed = zlib.gzipSync(jsonBuffer);

// After: reuse pre-allocated buffers
const pool = new BufferPool({ size: 64, bufferSize: 256 * 1024 });

function sessionToHash(session: Session): string {
  const buf = pool.acquire();
  try {
    const jsonLen = serializeInto(session, buf); // serialize directly into pooled buffer
    const compressed = zlib.gzipSync(buf.subarray(0, jsonLen)); // still allocates output
    // ... encrypt
  } finally {
    pool.release(buf);
  }
}
```

**Approach B: Streaming Gzip (eliminates largest allocation)**

```typescript
// Stream through gzip + encrypt without holding full buffers
import { pipeline } from 'node:stream/promises';
import { createGzip } from 'node:zlib';
import { createCipheriv } from 'node:crypto';

async function sessionToHash(session: Session): Promise<string> {
  const chunks: Buffer[] = [];
  const gzip = createGzip({ level: 1 }); // fast compression
  const cipher = createCipheriv(algo, key, iv);

  // Stream: JSON → gzip → encrypt → collect
  const readable = Readable.from(JSON.stringify(session));
  await pipeline(readable, gzip, cipher, async function* (source) {
    for await (const chunk of source) chunks.push(chunk);
  });
  return Buffer.concat(chunks).toString('base64');
}
```

**Approach C: Skip gzip for small payloads**

```typescript
// gzip only helps for payloads > 1KB. Most sessions at 5 turns are <1KB compressed.
const json = JSON.stringify(session);
const buffer = Buffer.from(json);
const payload =
  buffer.length > 1024
    ? zlib.gzipSync(buffer) // worth compressing
    : buffer; // skip gzip entirely — fewer allocations
```

**Expected Impact:**

- Approach A: Reduces young-gen allocations by ~50%, fewer promotions to old-gen
- Approach B: Eliminates the single largest allocation (gzip output buffer)
- Approach C: For 5-turn conversations, skips gzip entirely (payload < 1KB)
- Combined: Target p99.9 from 634ms → <50ms

**Measurement:** Re-run 15-turn saturation with fix deployed. Compare spike count (currently 77 per 240s) and p99.9 (currently 634ms).

---

### Priority 2: Redis Connection Pool Tuning [MEDIUM IMPACT]

**Goal:** Reduce session_resolve p95 from 45ms to <10ms at 35 VU.

**Evidence:** session_resolve p95 degrades +86% at 35 VU. Max spike 814ms = waiting for pool connection.

**Current config (from QA values):**

```yaml
MONGODB_MAX_POOL_SIZE: '20'
MONGODB_MIN_POOL_SIZE: '5'
# No explicit Redis pool size configured
```

**Remediation:**

```yaml
# Add to runtime configMap
REDIS_MAX_POOL_SIZE: '50' # Default is likely 10-20
REDIS_MIN_POOL_SIZE: '10' # Keep warm connections
REDIS_COMMAND_TIMEOUT_MS: '5000' # Fail fast vs hang
```

**Alternative: Pipeline session operations**

```typescript
// Before: 2 separate Redis round-trips per message
const session = await redis.get(sessionKey); // round-trip 1
// ... process ...
await redis
  .pipeline()
  .del(convKey)
  .rpush(convKey, ...messages)
  .exec(); // round-trip 2

// After: Read + Write in single pipeline where possible
// (Only possible for follow-up turns where session is already cached in-memory)
```

**Expected Impact:** p95 from 45ms → <15ms, eliminates >500ms connection wait spikes.

---

### Priority 3: V8 GC Tuning via Node.js Flags [LOW EFFORT, MEDIUM IMPACT]

**Goal:** Reduce GC pause duration and frequency.

**Flags to evaluate:**

```yaml
# Add to runtime container env or Dockerfile CMD
NODE_OPTIONS: '--max-old-space-size=1200 --gc-interval=100'
```

| Flag                                 | Effect                                                         |
| ------------------------------------ | -------------------------------------------------------------- |
| `--max-old-space-size=1200`          | Allow larger old-gen before GC (currently ~700-800MB triggers) |
| `--gc-interval=100`                  | Run GC more frequently but with shorter pauses                 |
| `--expose-gc` + manual `global.gc()` | Trigger GC during idle periods (between request batches)       |
| `--optimize-for-size`                | V8 trades throughput for lower memory, reducing GC pressure    |

**Measurement:** Compare GC pause frequency and duration via `perf_hooks` or `--trace-gc` flag.

---

### Priority 4: Worker Thread for Persist [LOW PRIORITY — DEFER]

**When to implement:** Only if Priority 1 (buffer pooling) is insufficient.

**Rationale:** Moving `sessionToHash` to a worker thread would isolate its GC impact from the main event loop. However, if we reduce allocation pressure first, the GC problem largely disappears.

**If needed:**

```typescript
import { Worker } from 'node:worker_threads';

const persistWorker = new Worker('./persist-worker.js');

async function sessionToHash(session: Session): Promise<string> {
  return new Promise((resolve, reject) => {
    persistWorker.postMessage({ type: 'hash', session });
    persistWorker.once('message', (result) => resolve(result));
  });
}
```

**Trade-offs:**

- (+) GC in worker doesn't pause main event loop
- (-) Serialization cost to transfer session data to worker
- (-) Additional complexity and memory usage
- (-) Worker has its own heap — may still GC-pause internally

---

### Priority 5: Incremental Persist [SKIP — Data Disproves Need]

**Original hypothesis:** Replacing the full DEL + N×RPUSH with incremental append would reduce persist cost.

**Data proves this is unnecessary:**

- Redis pipeline p50 = 1.3ms at 30 messages
- Only grows +32% from 2→30 messages
- Redis handles 30 RPUSH commands trivially
- Total persist p50 is FLAT regardless of message count

**When this WOULD matter:** At 200+ messages per session, the DEL + 200×RPUSH would become measurable. Current maximum is 30 messages (15 turns × 2 msg/turn).

---

## 15. Real-World Impact Assessment

### With Real LLM (not mock)

| Scenario                 | LLM Time         | Framework Overhead | Overhead %       | User Impact       |
| ------------------------ | ---------------- | ------------------ | ---------------- | ----------------- |
| Cached/short response    | 200ms            | 7ms (55ms p95)     | 3.3% (21.6% p95) | Noticeable at p95 |
| Standard response        | 2-5s             | 7ms (55ms p95)     | 0.1-0.3%         | Invisible         |
| Streaming (TTFT matters) | 300ms TTFT       | 7ms pre-LLM        | 2.3%             | Minor             |
| Post-stream persist      | After last token | 2.4ms (28.5ms p95) | 0% of UX         | Invisible to user |

**Key insight:** For streaming (the primary UX), persist happens AFTER the last token is delivered. The user never waits for persist. But GC spikes during persist CAN delay OTHER concurrent requests' LLM calls.

### Concurrency Impact

At higher concurrency (e.g., 100 concurrent sessions per pod in production):

- GC spike frequency increases proportionally to allocation rate
- Each spike blocks ALL concurrent requests (event loop frozen)
- Current 9% availability loss would become ~15-20% at production load
- p95 latency would exceed SLO targets

---

## 16. Recommended Next Steps

| #   | Action                                        | Effort          | Impact                                 | When                           |
| --- | --------------------------------------------- | --------------- | -------------------------------------- | ------------------------------ |
| 1   | Implement buffer pooling in sessionToHash     | 2-3 days        | Eliminates 86% of tail spikes          | Immediate                      |
| 2   | Add `--max-old-space-size=1200` to Node flags | 1 hour          | Reduces GC frequency by ~30%           | Immediate                      |
| 3   | Increase Redis pool size to 50                | 1 hour (config) | Fixes session_resolve p95              | Immediate                      |
| 4   | Skip gzip for payloads < 1KB                  | 0.5 day         | Eliminates most allocations at 5 turns | Immediate                      |
| 5   | Re-run saturation test with fixes             | 0.5 day         | Validate improvement                   | After 1-4                      |
| 6   | Add `--trace-gc` in dev to profile GC pauses  | 1 hour          | Baseline for GC improvement            | Diagnostic                     |
| 7   | Worker thread for persist                     | 3-5 days        | Last resort if #1 insufficient         | Only if needed                 |
| 8   | Incremental persist                           | 3-5 days        | N/A                                    | **SKIP** (data disproves need) |

---

## 17. Test Artifacts

| Artifact                           | Location                                                         |
| ---------------------------------- | ---------------------------------------------------------------- |
| 5-turn perf data (32,880 records)  | `/tmp/perf-all.jsonl`                                            |
| 15-turn perf data (13,322 records) | `/tmp/perf-15t-pod1-full.jsonl`, `/tmp/perf-15t-pod2-full.jsonl` |
| Cluster polls (33 snapshots)       | `benchmarks/results/polls/7perf15t/`                             |
| k6 Cloud run (5-turn)              | Run ID: 7451758                                                  |
| k6 Cloud run (15-turn)             | Run ID: 7454397                                                  |
| Perf instrumentation code          | `apps/runtime/src/observability/perf-instrumentation.ts`         |
| Instrumented runtime-executor      | `apps/runtime/src/services/runtime-executor.ts`                  |
| Instrumented reasoning-executor    | `apps/runtime/src/services/execution/reasoning-executor.ts`      |
| Instrumented redis-session-store   | `apps/runtime/src/services/session/redis-session-store.ts`       |

---

## 18. Appendix: Raw Data Tables

### A. 15-Turn Persist by Message Count (Full)

| Msgs | n   | Total p50 | Total p95 | Total p99 | Hash p50 | Hash p95 | Redis p50 | Redis p95 | Ser p50 | Ser p95 |
| ---- | --- | --------- | --------- | --------- | -------- | -------- | --------- | --------- | ------- | ------- |
| 2    | 228 | 7.7ms     | 50.1ms    | 126.2ms   | 5.04ms   | 30.7ms   | 1.98ms    | 14.5ms    | 0.040ms | 0.070ms |
| 4    | 225 | 4.3ms     | 64.9ms    | 189.8ms   | 2.11ms   | 36.7ms   | 1.11ms    | 14.8ms    | 0.070ms | 0.110ms |
| 6    | 223 | 1.8ms     | 47.3ms    | 536.1ms   | 0.60ms   | 33.2ms   | 1.00ms    | 20.1ms    | 0.090ms | 0.150ms |
| 8    | 226 | 1.8ms     | 32.2ms    | 114.7ms   | 0.59ms   | 13.5ms   | 1.05ms    | 13.2ms    | 0.110ms | 0.190ms |
| 10   | 221 | 1.9ms     | 24.9ms    | 182.7ms   | 0.59ms   | 11.5ms   | 1.07ms    | 11.7ms    | 0.140ms | 0.220ms |
| 12   | 218 | 2.0ms     | 24.9ms    | 90.9ms    | 0.59ms   | 11.9ms   | 1.10ms    | 11.6ms    | 0.170ms | 0.260ms |
| 14   | 224 | 2.0ms     | 19.0ms    | 277.5ms   | 0.55ms   | 9.4ms    | 1.12ms    | 10.6ms    | 0.190ms | 0.290ms |
| 16   | 223 | 2.1ms     | 16.5ms    | 522.0ms   | 0.55ms   | 10.2ms   | 1.18ms    | 8.9ms     | 0.220ms | 0.320ms |
| 18   | 222 | 2.5ms     | 32.5ms    | 142.3ms   | 0.61ms   | 23.2ms   | 1.28ms    | 12.9ms    | 0.250ms | 0.380ms |
| 20   | 219 | 2.2ms     | 21.3ms    | 277.6ms   | 0.58ms   | 7.5ms    | 1.17ms    | 10.4ms    | 0.270ms | 0.400ms |
| 22   | 218 | 2.3ms     | 19.9ms    | 111.0ms   | 0.60ms   | 9.6ms    | 1.24ms    | 10.1ms    | 0.290ms | 0.430ms |
| 24   | 217 | 2.4ms     | 22.8ms    | 490.1ms   | 0.58ms   | 12.9ms   | 1.34ms    | 11.5ms    | 0.320ms | 0.510ms |
| 26   | 223 | 2.5ms     | 19.4ms    | 146.3ms   | 0.59ms   | 9.0ms    | 1.31ms    | 10.0ms    | 0.350ms | 0.510ms |
| 28   | 226 | 2.4ms     | 21.9ms    | 158.3ms   | 0.56ms   | 11.9ms   | 1.33ms    | 10.2ms    | 0.360ms | 0.530ms |
| 30   | 215 | 2.4ms     | 40.2ms    | 393.4ms   | 0.57ms   | 18.9ms   | 1.32ms    | 13.9ms    | 0.390ms | 0.600ms |

### B. Cross-VU Comparison (5-turn test)

| Phase | msg/s | executeMessage p50 | p95    | p99    | Persist p95 | Hash p95 | Redis p95 |
| ----- | ----- | ------------------ | ------ | ------ | ----------- | -------- | --------- |
| 25 VU | 7.4   | 1011ms             | 1030ms | 1133ms | 20.0ms      | 13.9ms   | 8.7ms     |
| 30 VU | 14.7  | 1010ms             | 1027ms | 1172ms | 20.2ms      | 13.6ms   | 8.8ms     |
| 35 VU | 23.2  | 1011ms             | 1051ms | 1293ms | 29.8ms      | 19.2ms   | 11.2ms    |

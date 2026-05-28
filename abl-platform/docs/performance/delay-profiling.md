# Chat Endpoint Delay Profiling

> Per-request cost breakdown, optimization scope, and load test expectations.

---

## HTTP: `POST /api/v1/chat/agent`

### Session Create (First Message)

```
Request ──► Auth ──► RBAC ──► Session Create ──► Model Resolve ──► LLM ──► Response
            │        │        │                  │                 │
            5-15ms   2-5ms    10-30ms            5-15ms            500-1000ms (mock)
            3-4 DB   0-2 DB   4-8 DB             1-5 DB            2-10s (real LLM)
```

| Phase          | What Happens                                                  | DB Queries         | Cached?                        |
| -------------- | ------------------------------------------------------------- | ------------------ | ------------------------------ |
| **Auth**       | `findUserById`                                                | 1                  | NO                             |
|                | `resolveTenantMembership` (TenantMember + Tenant)             | 2                  | NO                             |
|                | `resolveEffectivePermissions`                                 | 0-2                | Yes (1-min)                    |
| **RBAC**       | `findProjectByIdAndTenant`                                    | 1                  | Yes (in-memory)                |
|                | `findProjectMember`                                           | 1                  | Yes (in-memory)                |
| **Session**    | `checkSessionQuota` (Redis + TenantConfig)                    | 1                  | Partial                        |
|                | `DeploymentResolver.resolve` (Deployment + Agents + Versions) | 2-4                | Compilation cached             |
|                | `mergeModuleSnapshot` (DB + gunzip)                           | 1                  | NO                             |
|                | `resolveSessionTimeouts` (TenantConfig)                       | 1                  | REDUNDANT — same data as quota |
|                | `convStore.createSession`                                     | 1                  | N/A (write)                    |
| **Model**      | Metadata cache check                                          | 0                  | Yes (5-min)                    |
|                | (miss) tenantPolicy + tiers + enableThinking                  | 3                  | Parallel, good                 |
|                | (miss) agent → project → tenant fallback chain                | 1-3                | Sequential                     |
|                | `rehydrateCredential` (DB + AES decrypt)                      | 1-2                | NEVER CACHED                   |
| **Guardrails** | `getSessionPolicy`                                            | 1                  | NO                             |
| **LLM**        | Mock provider delay                                           | 0                  | 500-1000ms                     |
| **Persist**    | Messages + metrics (fire-and-forget)                          | 2-3                | Non-blocking                   |
| **Total**      |                                                               | **12-16 blocking** |                                |

### Follow-up Turn (Session Resume)

```
Request ──► Auth ──► Session Lookup ──► Model Resolve ──► LLM ──► Response
            │        │                  │                 │
            5-15ms   2-5ms              3-8ms             500-1000ms (mock)
            3-4 DB   1-2 DB             1-2 DB
```

| Phase          | What Happens                        | DB Queries       | Cached?                          |
| -------------- | ----------------------------------- | ---------------- | -------------------------------- |
| **Auth**       | Same 3-4 queries as create          | 3-4              | NO — runs every request          |
| **Session**    | `executor.getSession` (in-memory)   | 0                | Yes                              |
|                | `findSessionById` (for dbSessionId) | 1                | REDUNDANT — session is in memory |
|                | `getVersion` stale check            | 0 DB, 1 Redis    |                                  |
| **Model**      | Metadata cache                      | 0                | HIT                              |
|                | `rehydrateCredential`               | 1-2              | NEVER CACHED                     |
| **Guardrails** | `getSessionPolicy`                  | 1                | NO                               |
| **LLM**        | Mock provider delay                 | 0                | 500-1000ms                       |
| **Persist**    | Fire-and-forget                     | 2-3              | Non-blocking                     |
| **Total**      |                                     | **5-8 blocking** |                                  |

---

## WebSocket: `/ws` and `/ws/sdk`

### Connect + First Message

```
Upgrade ──► Auth ──► load_agent ──► send_message ──► LLM ──► Response
            │        │              │                 │
            5-15ms   10-30ms        5-10ms            500-1000ms (mock)
            3-4 DB   5-8 DB         3-4 DB
```

| Phase            | What Happens                                         | DB Queries         | Cached?                     |
| ---------------- | ---------------------------------------------------- | ------------------ | --------------------------- |
| **Auth** (once)  | JWT verify + `resolveTenantMembership` + permissions | 3-4                | Membership: NO              |
| **load_agent**   | `findProjectAgentByPath`                             | 1                  | NO                          |
|                  | `findProjectByIdAndTenant`                           | 1                  | NO                          |
|                  | `checkSessionQuota`                                  | 1                  | Partial                     |
|                  | `DeploymentResolver.resolve`                         | 2-4                | Compilation cached          |
|                  | `resolveSessionTimeouts`                             | 1                  | REDUNDANT                   |
|                  | `resolveProjectTools`                                | 1-2                | Redis cached                |
| **send_message** | `ensureDbSession` → `createSession`                  | 1                  | N/A (write)                 |
|                  | `hasActiveAuthGateAsync`                             | 0 DB, 1 Redis      | REDUNDANT (checked on load) |
|                  | Model resolution + `rehydrateCredential`             | 1-2                | NEVER CACHED                |
| **LLM**          | Mock provider delay                                  | 0                  | 500-1000ms                  |
| **Total**        |                                                      | **12-18 blocking** |                             |

### Follow-up Message (same connection)

```
message ──► Auth Gate ──► LLM ──► Response
            │              │
            <1ms           500-1000ms (mock)
            0 DB           1-2 DB (credential)
```

| Phase         | What Happens             | DB Queries       | Cached?          |
| ------------- | ------------------------ | ---------------- | ---------------- |
| **Auth**      | Already authenticated    | 0                | Connection-level |
| **Session**   | Already in memory        | 0                | Connection-level |
| **Auth gate** | `hasActiveAuthGateAsync` | 0                | In-memory first  |
| **Model**     | `rehydrateCredential`    | 1-2              | NEVER CACHED     |
| **LLM**       | Mock provider delay      | 0                | 500-1000ms       |
| **Persist**   | Fire-and-forget          | 2-3              | Non-blocking     |
| **Total**     |                          | **2-3 blocking** |                  |

---

## Optimization Scope

### Things That Are NOT Cached (should be)

| Operation                 | Queries/call   | Frequency                       | Proposed Fix                                                    | Expected Savings       |
| ------------------------- | -------------- | ------------------------------- | --------------------------------------------------------------- | ---------------------- |
| `findUserById`            | 1              | Every HTTP request              | 60s in-memory cache, key: `userId`                              | ~1 query/req           |
| `resolveTenantMembership` | 2 (sequential) | Every HTTP request + WS connect | 60s cache, key: `userId:tenantId` + `Promise.all` the 2 queries | ~2 queries/req + 1 RTT |
| `rehydrateCredential`     | 1-2            | Every LLM call (both paths)     | 30s cache, key: `tenantId:connectionId`                         | ~1-2 queries/LLM call  |
| `getSessionPolicy`        | 1              | Every message (both paths)      | Cache on session object after first call                        | ~1 query/msg           |
| `mergeModuleSnapshot`     | 1 + gunzip     | Every session create            | Cache alongside compilation output                              | ~1 query/create        |

### Things That Are REDUNDANT (queried twice)

| Operation                 | Called In              | Also Called In                             | Fix                                   |
| ------------------------- | ---------------------- | ------------------------------------------ | ------------------------------------- |
| `getProjectConfig`        | `checkSessionQuota`    | `resolveSessionTimeouts` AND trace emitter | Pass resolved config                  |
| `resolveTenantMembership` | Auth middleware        | `requireProjectPermission`                 | Reuse from `req.tenantContext`        |
| `findSessionById`         | HTTP follow-up handler | Session is already in-memory               | Store `dbSessionId` on RuntimeSession |
| `hasActiveAuthGateAsync`  | `load_agent`           | First `send_message`                       | Skip on same connection               |
| Stale check               | `executeMessage`       | Route handler already verified             | Pass `skipStaleCheck` flag            |

### Things That Are SEQUENTIAL (should be parallel)

| Operations                                          | Current                                 | Fix                | Saves              |
| --------------------------------------------------- | --------------------------------------- | ------------------ | ------------------ |
| `TenantMember.findOne` → `Tenant.findOne`           | Sequential in `resolveTenantMembership` | `Promise.all`      | ~1 DB RTT (~2-5ms) |
| `checkSessionQuota` → `DeploymentResolver.resolve`  | Sequential in session create            | `Promise.all`      | ~1 DB RTT          |
| `resolveSessionTimeouts` → `resolveProjectTools`    | Sequential                              | `Promise.all`      | ~1 DB RTT          |
| `findProjectAgentByPath` → `findProjectAgentByName` | Sequential fallback                     | Single `$or` query | ~1 DB RTT          |

---

## Achievable RPS Targets

### Test Shape: multi-turn-saturation.ts

```
50 VUs, 20 min, 5 messages per session, 0.1s inter-message delay
Ramp: 0→5 VUs (3m) → 5→40 VUs (9m) → 40→50 VUs (5m) → 50→0 (3m)

Per VU iteration:
  1 session create  (msg 1)     → heavier (12-16 DB queries)
  4 follow-up turns (msg 2-5)   → lighter (5-8 DB queries each)
  4 × 0.1s inter-message delay  → 0.4s idle time
```

### Ideal Calculation (HTTP path, mock LLM)

```
Session create latency:
  Platform overhead:  30-50ms
  Mock LLM:           500-1000ms (avg 750ms)
  Total:              ~780ms avg

Follow-up turn latency:
  Platform overhead:  15-35ms
  Mock LLM:           500-1000ms (avg 750ms)
  Total:              ~775ms avg

Full conversation (1 create + 4 turns + 4 × 0.1s delay):
  = 780 + (4 × 775) + (4 × 100)
  = 780 + 3100 + 400
  = ~4280ms per conversation

Messages per conversation: 5
Time per conversation:     ~4.3s
Messages per VU per sec:   5 / 4.3 = ~1.16 msg/s/VU
```

### RPS Targets by Phase

| Test Phase                | Active VUs | Expected RPS | Messages/sec | DB Queries/sec |
| ------------------------- | ---------- | ------------ | ------------ | -------------- |
| **Warm-up** (0-3 min)     | 1→5        | 1-6          | 1-6          | 15-50          |
| **Ramp** (3-12 min)       | 5→40       | 6-46         | 6-46         | 50-370         |
| **Peak** (12-17 min)      | 40→50      | 46-58        | 46-58        | 370-460        |
| **Cool-down** (17-20 min) | 50→0       | 58→0         | 58→0         | 460→0          |

### Peak RPS Breakdown (50 VUs)

```
50 VUs × 1.16 msg/s/VU = ~58 messages/sec (theoretical max)

Message mix at peak:
  Session creates:   ~12/sec (20% of messages — 1 per 5-msg conversation)
  Follow-up turns:   ~46/sec (80% of messages)

DB query load at peak:
  Creates: 12/sec × 14 queries = ~168 queries/sec
  Turns:   46/sec × 6.5 queries = ~299 queries/sec
  Total:   ~467 MongoDB queries/sec

Redis load at peak:
  Creates: 12/sec × 4 calls  = ~48 calls/sec
  Turns:   46/sec × 3 calls  = ~138 calls/sec
  Total:   ~186 Redis calls/sec
```

### Achievable Targets — Current State

| Metric                  | Target            | Rationale                                                                         |
| ----------------------- | ----------------- | --------------------------------------------------------------------------------- |
| **Peak RPS**            | **45-58 msg/sec** | 50 VUs ÷ ~0.86s avg turn time (best case 500ms LLM + 15ms overhead + 100ms delay) |
| **Sustained RPS**       | **35-50 msg/sec** | Avg across ramp+peak phases, accounting for LLM variance                          |
| **p95 turn latency**    | **< 1200ms**      | 1000ms (mock LLM p95) + 35ms overhead + margin                                    |
| **p99 turn latency**    | **< 1500ms**      | Tail includes DB contention under load                                            |
| **p95 session create**  | **< 1500ms**      | 1000ms LLM + 50ms overhead + DB contention margin                                 |
| **Error rate**          | **< 1%**          | Auth 429s eliminated with 30m JWT                                                 |
| **MongoDB queries/sec** | **~400-470**      | Bounded by connection pool (default 100 connections)                              |

### Achievable Targets — After P0 Optimizations

| Metric                        | Current  | After P0 | Improvement               |
| ----------------------------- | -------- | -------- | ------------------------- |
| **Peak RPS**                  | 45-58    | 50-62    | +5-10% (LLM is the floor) |
| **p95 turn latency**          | < 1200ms | < 1100ms | -100ms overhead reduction |
| **p95 session create**        | < 1500ms | < 1300ms | -200ms overhead reduction |
| **MongoDB queries/sec**       | ~467     | ~180     | **-60% DB load**          |
| **Follow-up DB queries/turn** | 5-8      | 2-3      | -60%                      |
| **Create DB queries**         | 12-16    | 7-10     | -40%                      |

### Achievable Targets — After P0+P1 Optimizations

| Metric                        | Current  | After P0+P1 | Improvement      |
| ----------------------------- | -------- | ----------- | ---------------- |
| **Peak RPS**                  | 45-58    | 52-65       | +10-15%          |
| **p95 turn latency**          | < 1200ms | < 1080ms    | -10%             |
| **MongoDB queries/sec**       | ~467     | ~110        | **-76% DB load** |
| **Follow-up DB queries/turn** | 5-8      | 1-2         | -80%             |

### Why RPS Doesn't Jump Dramatically

```
Current turn time:    750ms (LLM avg) + 25ms (overhead) + 100ms (delay) = 875ms
Optimized turn time:  750ms (LLM avg) + 8ms (overhead)  + 100ms (delay) = 858ms
                                          ↑                                  ↑
                                     saves 17ms                        still 100ms idle

RPS improvement: 875ms → 858ms = ~2% faster per turn
The real win is DB load: 467 → 110 queries/sec = MongoDB stays healthy at scale
```

The mock LLM (500-1000ms) and inter-message delay (100ms) dominate. Platform overhead is ~3% of turn time. Optimizations keep MongoDB from becoming the bottleneck when scaling to 100-200+ VUs.

### Real LLM Targets (for reference)

| LLM                              | Avg Latency | Peak RPS at 50 VUs | DB Overhead % |
| -------------------------------- | ----------- | ------------------ | ------------- |
| Mock (500-1000ms)                | 750ms       | 45-58              | ~3%           |
| Fast (GPT-4o-mini, Claude Haiku) | 1-3s        | 15-30              | ~1%           |
| Standard (GPT-4o, Claude Sonnet) | 3-8s        | 5-15               | <0.5%         |
| Slow (GPT-4, Claude Opus)        | 5-15s       | 3-8                | <0.3%         |

### What to Watch in Grafana

| Metric                               | Healthy    | Warning     | Saturated |
| ------------------------------------ | ---------- | ----------- | --------- |
| `http_req_failed`                    | < 1%       | 1-5%        | > 5%      |
| `chat_turn_latency_ms` p95           | < 1200ms   | 1200-2000ms | > 2000ms  |
| `chat_session_create_latency_ms` p95 | < 1500ms   | 1500-3000ms | > 3000ms  |
| MongoDB query latency (Coroot)       | < 5ms avg  | 5-20ms      | > 20ms    |
| MongoDB connections (Coroot)         | < 80% pool | 80-95%      | > 95%     |
| Runtime CPU (Coroot)                 | < 70%      | 70-85%      | > 85%     |
| Runtime memory (Coroot)              | < 80%      | 80-90%      | > 90%     |

---

## Missing Indexes (Added)

4 indexes were missing or suboptimal for hot-path queries:

| Collection           | Missing Index                                | Query                                                            | Frequency                           |
| -------------------- | -------------------------------------------- | ---------------------------------------------------------------- | ----------------------------------- |
| `subscriptions`      | `{ tenantId, status }`                       | `findOne({ tenantId, status: 'active' })`                        | Every request (tenant-config)       |
| `model_configs`      | `{ projectId, modelId }`                     | `findOne({ projectId, modelId })`                                | Every LLM call (resolution level 2) |
| `model_configs`      | `{ projectId, tier, isDefault, priority }`   | `findOne({ projectId, tier, isDefault }).sort({ priority: -1 })` | Every LLM call (resolution level 3) |
| `guardrail_policies` | `{ tenantId, isActive, status, scope.type }` | `find({ tenantId, isActive, status, $or: [scope variants] })`    | Every message                       |

**Already well-indexed (no action needed):** `users` (\_id), `tenant_members` (tenantId+userId unique), `tenants` (\_id), `sessions` (\_id), `deployments` (projectId+environment+status partial unique), `project_agents` (tenantId+projectId), `agent_versions` (agentId+version unique), `project_members` (projectId+userId unique).

---

## Priority Roadmap

| Priority | What                                             | DB Queries Saved   | Complexity | Impact                                     |
| -------- | ------------------------------------------------ | ------------------ | ---------- | ------------------------------------------ |
| **P0**   | Cache `findUserById` + `resolveTenantMembership` | 3/HTTP request     | Low        | Eliminates 150 queries/sec at 50 VUs       |
| **P0**   | Cache `rehydrateCredential`                      | 1-2/LLM call       | Medium     | Eliminates 50-100 queries/sec at 50 VUs    |
| **P1**   | Store `dbSessionId` on RuntimeSession            | 1/HTTP follow-up   | Low        | Removes redundant DB call                  |
| **P1**   | Cache `getSessionPolicy` on session              | 1/message          | Low        | Removes per-message DB call                |
| **P1**   | Deduplicate `getProjectConfig` calls             | 1-2/session create | Low        | Pass config through instead of re-fetching |
| **P2**   | Parallelize auth queries                         | 1 RTT/request      | Low        | Shaves ~2-5ms from auth phase              |
| **P2**   | Cache `mergeModuleSnapshot`                      | 1/session create   | Low        | Removes DB + gunzip per create             |
| **P2**   | Static imports (replace dynamic `import()`)      | ~20 microtasks/req | Medium     | Reduces GC pressure under load             |

### Net Effect at 50 VUs (follow-up turns)

|                          | Current  | After P0 | After P0+P1 |
| ------------------------ | -------- | -------- | ----------- |
| Blocking DB queries/turn | 5-8      | 2-3      | 1-2         |
| DB queries/sec at 50 VUs | 250-400  | 100-150  | 50-100      |
| Per-turn overhead        | ~30-50ms | ~10-15ms | ~5-10ms     |

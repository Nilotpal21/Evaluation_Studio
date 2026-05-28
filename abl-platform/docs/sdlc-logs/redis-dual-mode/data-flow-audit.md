# Data-Flow & Dependency-Wiring Audit: Redis Dual-Mode

**Date**: 2026-05-09
**Auditor**: Claude (automated — PR #885 review)
**Round**: 1
**Feature**: `docs/features/redis-dual-mode.md`
**PR**: #885 — `[ABLP-2] feat(redis): Redis dual-mode support — standalone + cluster`

---

## Sensitive Values Audited

- **Redis connection credentials** (`password`, `username`, TLS `key`/`cert`/`ca` material) — DATA CLASS: CREDENTIAL
- **Redis key names** (contain `tenantId`, `sessionId`, `contactId`) — DATA CLASS: INTERNAL
- **BullMQ job payloads** (`tenantId`, `message content`, `connectionId`) — DATA CLASS: BUSINESS

---

## Round 1: Path Trace Findings

### VALUE 1: Redis connection credentials (`password`, TLS key material)

**DATA CLASS**: CREDENTIAL
**APPROVED CONSUMERS**: ioredis (auth only), TLS handshake

#### 1. Source

- `resolveRedisOptionsFromEnv` (`packages/redis/src/connection.ts:324`) — reads `REDIS_PASSWORD` from `process.env`
- `resolveRedisOptionsFromConfig` (`packages/redis/src/connection.ts:366`) — reads URL from app config (may embed password)
- `parseRedisUrl` (`connection.ts:123`) — extracts `password` from URL via `decodeURIComponent(parsed.password)`
- `createRedisConnection` (`connection.ts:155`) — builds `baseOpts.password = password`
- **TLS key material**: `buildTlsOptions` (`connection.ts:91`) — `fs.readFileSync(tls.keyFile)` → `baseOpts.tls.key`

#### 2. Writes

- `baseOpts` (in-memory, `connection.ts:186`) — password stored as plaintext `string` in the options object
- `clusterBaseOptions` (`connection.ts:236`) — **SAME object** captured as `handle.baseOptions` on the returned `RedisConnectionHandle`
- `redisHandle` (singleton, `apps/runtime/src/services/redis/redis-client.ts`) — module-level singleton retaining the handle
- **NOT written to MongoDB, Redis, ClickHouse, or any persistent store** — in-memory only

#### 3. Serialization Boundaries

- `handle.baseOptions` → `createSubscriber` → ioredis `newCluster(nodes, { redisOptions: handle.baseOptions })` — password flows into ioredis auth; NOT serialized to any external system
- `handle.baseOptions` → `buildClusterForBullMQ` → `merged = { ...baseOptions }` → ioredis `newCluster` — same; ioredis uses it for auth only
- `handle.baseOptions` → `handle.duplicate()` → `{ ...clusterBaseOptions, ...dupOpts }` → ioredis — auth only

**No cross-process serialization of credentials found.**

#### 4. Read Paths

- `getRedisHandle()` returns the `RedisConnectionHandle` which has `baseOptions` as a public readonly field
- Any module that calls `getRedisHandle()` can access `handle.baseOptions.password` directly
- Current callers: `inbound-worker.ts`, `delivery-worker.ts`, `channel-queues.ts`, `promote-context-{producer,worker}.ts`, `websocket/handler.ts`, `trace/redis-trace-store.ts`, `agent-transfer/index.ts`, `kms/reencryption-queue.ts`
- None of the current callers log `baseOptions` or pass it to external APIs

#### 5. Policy Boundary

| Consumer                                  | Sees credentials?             | Verdict           |
| ----------------------------------------- | ----------------------------- | ----------------- |
| ioredis Cluster constructor               | Yes — for auth                | CORRECT           |
| ioredis client.duplicate                  | Yes — for auth                | CORRECT           |
| Module-level callers via getRedisHandle() | Can access handle.baseOptions | LATENT RISK (F-1) |
| Logs / traces                             | Not currently logged          | PASS              |
| API responses                             | Not included                  | PASS              |

#### 6. Consumers / Sinks

- **ioredis** (auth) — correct
- **No external API calls, no HTTP outbound, no Kafka** carry credentials

#### 7. Dependency Wiring

```
DEPENDENCY: RedisConnectionHandle (with baseOptions containing password)
  Constructed at: packages/redis/src/connection.ts:258 (createRedisConnection)
  Stored at: apps/runtime/src/services/redis/redis-client.ts (module-level singleton)
  Returned by: getRedisHandle() — no null-safety issue; returns null when uninit
  Consumer: createSubscriber(handle) — uses baseOptions for Cluster auth — WIRED ✓
  Consumer: createBullMQPair(handle) → buildClusterForBullMQ — uses baseOptions for auth — WIRED ✓
  Consumer: handle.duplicate() — spreads baseOptions — WIRED ✓
  Null-handling: All consumers guard against null handle with early return
```

#### 8. Parallel Paths

- `apps/runtime` and `apps/multimodal-service` both use `createRedisConnection` — parity ✓
- `apps/search-ai` uses `resolveRedisOptionsFromEnv` + `createRedisConnection` — parity ✓
- Standalone path: `Redis(port, host, baseOpts)` — `baseOpts` contains password; passed to ioredis for auth ✓
- Cluster path: `newCluster(nodes, { redisOptions: baseOpts })` — same; ioredis uses `redisOptions.password` ✓

#### 9. Boundary Tests

- ✗ No test asserts that `handle.baseOptions.password` cannot be extracted and logged by accident
- ✗ No `toJSON` / serialization guard test on `RedisConnectionHandle`
- ✓ Existing tests verify that cluster connections authenticate successfully (cluster harness uses password: 'x' for test clusters)

---

### VALUE 2: Redis key names (tenantId, sessionId in key components)

**DATA CLASS**: INTERNAL
**APPROVED CONSUMERS**: Redis server, structured server logs

#### 1. Source

- Keys constructed in application code: `session:lock:{sessionId}`, `agent_transfer:{tenantId}:{contactId}:{channel}`, `breaker:{level:key}:state`, etc.
- Passed to `runLuaScript(client, script, keys, args)` at `packages/redis/src/lua.ts:44`

#### 2. Writes

- `RedisCrossSlotError` (`packages/redis/src/errors.ts:25`) — stores `keys` array as `this.keys: readonly string[]`
- `crossslotErrors` OTel counter — attributes include `{ script: script.name }` only — keys NOT included in metrics — CORRECT

#### 3. Serialization Boundaries

- `runLuaScript` → ioredis `client.eval(script.body, numberOfKeys, ...keys, ...stringArgs)` → sent to Redis server — correct (Redis server is a trusted internal system)
- `RedisCrossSlotError` propagates up the call stack if thrown — key names in error message + `this.keys`

#### 4. Read Paths

- `RedisCrossSlotError.keys` and `RedisCrossSlotError.message` — readable by any catch block that receives the error
- `AppError` base class: `statusCode: 503` — HTTP layer should return the status code but NOT the raw error message to untrusted callers

#### 5. Policy Boundary

| Consumer              | Sees key names?                         | Policy                                | Verdict |
| --------------------- | --------------------------------------- | ------------------------------------- | ------- |
| Redis server          | Yes — required                          | Internal trusted system               | PASS    |
| ioredis eval response | No (keys are input-only)                | N/A                                   | PASS    |
| Structured server log | Yes — via error.message                 | Acceptable (server logs are internal) | PASS    |
| API error response    | Potentially — via express error handler | Risk (F-3)                            | WARN    |
| OTel metrics          | No — only script.name attribute         | CORRECT                               | PASS    |

#### 6. Consumers / Sinks

- Redis server (correct)
- `runLuaScript` error handler logs via `crossslotErrors.add(1, { script: script.name })` — no key names in metrics ✓

#### 7. Dependency Wiring

```
DEPENDENCY: runLuaScript
  Defined at: packages/redis/src/lua.ts:44
  Exported from: packages/redis/src/index.ts
  Consumer: packages/circuit-breaker — all 4 scripts — WIRED ✓
  Consumer: packages/agent-transfer — single-key scripts — WIRED ✓
  Consumer: apps/runtime/session-lock.ts (RELEASE_SCRIPT) — WIRED ✓
  Null-handling: throws typed errors (RedisCrossSlotError, RedisOperationError) — callers must handle
```

#### 8. Parallel Paths

- `circuit-breaker` uses `runLuaScript` for all 4 breaker scripts — consistent ✓
- `agent-transfer` uses `runLuaScript` for single-key session operations — consistent ✓
- `session-lock` uses `runLuaScript` for RELEASE_SCRIPT — consistent ✓
- **OLD**: `session-lock.ts` previously called `(redis as any).eval(RELEASE_SCRIPT, 1, lockKey, lockOwner)` directly — now migrated ✓

#### 9. Boundary Tests

- ✓ `ERR-1` integration test: CROSSSLOT on un-tagged Lua keys (negative test) — exists per testing spec
- ✗ No test asserts that `RedisCrossSlotError.keys` does not reach the Express error handler response body
- ✓ `runLuaScript` throws typed errors that `AppError` base class maps to 503 status

---

### VALUE 3: BullMQ job payloads (tenantId, message content, connectionId)

**DATA CLASS**: BUSINESS
**APPROVED CONSUMERS**: BullMQ worker processors (same service), no external consumers

#### 1. Source

- `InboundJobPayload` constructed in runtime channel handlers
- Contains: `connectionId`, `tenantId`, `projectId`, `agentId`, `channelType`, `message.text`, `message.metadata`, `idempotencyKey`
- `DeliveryJobPayload` contains: `tenantId`, `subscriptionId`, `deliveryId`, `payload` (webhook body)

#### 2. Writes

- BullMQ writes job data to Redis under `{bull}:channel-inbound:*` and `{bull}:webhook-delivery:*` keys
- In cluster mode, `{bull}` hash tag routes ALL these keys to the same slot(s) — shared hot slot (GAP-006)
- Job data is stored as JSON-serialized object in Redis — **in-memory at Redis, not encrypted at rest in standard Redis**

#### 3. Serialization Boundaries

- HTTP/WebSocket → BullMQ Queue (`channel-inbound`) → Redis cluster
- BullMQ Redis → BullMQ Worker processor (same process)
- No cross-service boundary for job payloads — Queue and Worker are in the same app process

#### 4. Read Paths

- BullMQ Worker processor function receives job data — process-internal only
- BullMQ dashboard (if deployed) could read job data — not changed by this PR

#### 5. Policy Boundary

| Consumer                      | Policy                                     | Verdict        |
| ----------------------------- | ------------------------------------------ | -------------- |
| Same-process Worker processor | Authorized (tenantId checked in processor) | PASS           |
| Redis cluster nodes           | Encrypted if TLS, plaintext otherwise      | Same as pre-PR |
| BullMQ dashboard              | Out of scope; not changed                  | N/A            |

**Tenant isolation in processor**: Worker processors check `tenantId` per job payload — not changed by this PR. Queue isolation is unchanged (same queue names, same processor logic). Cross-tenant job delivery is not possible because each job carries its own tenantId.

#### 6. Consumers / Sinks

- BullMQ processors (same process, correct consumers)
- Redis cluster storage (job queue backing store — consistent with pre-PR behavior)
- No external API calls carry job payload data

#### 7. Dependency Wiring

The critical wiring is `{bull}` prefix consistency across all Queue/Worker pairs:

```
DEPENDENCY: prefix: '{bull}' — must be consistent across Queue + Worker pairs
  apps/runtime: channel-queues.ts (Queue) + inbound-worker.ts (Worker) — CONSISTENT ✓
  apps/runtime: channel-queues.ts (Queue) + delivery-worker.ts (Worker) — CONSISTENT ✓
  apps/runtime: promote-context-producer.ts (Queue) + promote-context-worker.ts (Worker) — CONSISTENT ✓
  apps/runtime: message-persistence-queue.ts (Queue+Worker) — CONSISTENT ✓
  apps/workflow-engine: index.ts line 1372 + trigger-scheduler + callback-delivery — CONSISTENT ✓
  apps/multimodal-service: jobs/queues.ts (createQueue uses prefix via handle.duplicate) — ✓
  apps/search-ai: queue-factory.ts + worker files — CONSISTENT ✓
```

**GAP**: `apps/runtime/src/services/kms/reencryption-queue.ts` — does NOT set `prefix: '{bull}'` explicitly.

```
DEPENDENCY: KMS reencryption queue prefix
  Constructed at: apps/runtime/src/services/kms/reencryption-queue.ts
  prefix: '{bull}' — NOT SET (uses default BullMQ prefix 'bull' without braces)
  Status: NOT WIRED (F-4)
```

#### 8. Parallel Paths

- `inbound-worker` (Queue → Worker) and `delivery-worker` (Queue → Worker) — both use `{bull}` prefix ✓
- `promote-context-producer` (Queue) + `promote-context-worker` (Worker) — both use `{bull}` prefix ✓
- `reencryption-queue` — prefix NOT set (F-4)

#### 9. Boundary Tests

- ✓ Cluster E2E tests verify BullMQ enqueue+dequeue on real cluster
- ✗ No test asserts that `reencryption-queue` uses `prefix: '{bull}'` in cluster mode

---

## Findings Summary

| ID  | Severity           | Dimension       | Finding                                                                                                                                                                                                                                                    |
| --- | ------------------ | --------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | --- | ---------------------------------------------------------------------------------------------------------------------- |
| F-1 | MEDIUM             | Policy Boundary | `handle.baseOptions.password` is a plain string on the public `RedisConnectionHandle` interface — no serialization guard. Accidental logging of the handle object would expose credentials.                                                                |
| F-2 | MEDIUM             | Source          | `fs.readFileSync` at `connection.ts:103-105` for TLS key/cert/CA loading — sync I/O violation per CLAUDE.md.                                                                                                                                               |
| F-3 | MEDIUM             | Policy Boundary | `RedisCrossSlotError.keys` (containing tenant-scoped Redis key names) is a public readonly field. If the error propagates to an Express route handler without going through the runtime's sanitizer, key names could appear in the HTTP 503 response body. |
| F-4 | ~~HIGH~~ RETRACTED | Wiring          | Initially flagged as missing `prefix: '{bull}'` in reencryption-queue. **Code inspection confirmed prefix IS set** at `reencryption-queue.ts:133` (Queue) and `:150` (Worker). False positive.                                                             |
| F-5 | LOW                | Stale Code      | `apps/runtime/src/services/queues/channel-queues.ts` standalone fallback to `parseRedisUrl` from deprecated `redis-utils.js` is dead code (the `!connection                                                                                                |     | typeof connection !== 'object'`guard can never be true given`createBullMQConnectionOptions` always returns an object). |

---

### Per-Finding Details

#### FINDING: F-1

````
SEVERITY: MEDIUM
DIMENSION: Policy Boundary / Writes
PATH: REDIS_PASSWORD env → resolveRedisOptionsFromEnv → createRedisConnection → handle.baseOptions → getRedisHandle() caller
EVIDENCE: packages/redis/src/types.ts:91 — `readonly baseOptions?: Partial<RedisOptions>` — plain public field
         packages/redis/src/connection.ts:260 — `baseOptions: clusterBaseOptions` stored on returned handle
IMPACT: Any code calling getRedisHandle() and logging the result would expose the Redis password.
        No current code does this, but there is no type-level protection against it.
FIX: Add a `toJSON()` method to the handle that redacts password:
     ```typescript
     toJSON() { return { client: '[RedisClient]', nodes: this.nodes?.map(n => ({ host: n.host, port: n.port })) }; }
     ```
     Or make `baseOptions` a private closure variable (not on the returned object) and expose only the methods that use it.
TEST: Add a unit test: `expect(JSON.stringify(handle)).not.toContain(password)` where password is a known test value.
````

#### FINDING: F-2 — RETRACTED

```
SEVERITY: MEDIUM → RETRACTED (hook exemption confirmed)
EVIDENCE: .claude/hooks/sync-io-lint.sh explicitly exempts */redis/src/connection*:
          `*/redis/src/connection*) exit 0 ;;  # Connection setup`
          TLS file loading at connection setup time is a documented, approved sync I/O use.
```

#### FINDING: F-3

```
SEVERITY: MEDIUM
DIMENSION: Policy Boundary
PATH: runLuaScript CROSSSLOT → RedisCrossSlotError.keys → Express error handler → HTTP 503 response body
EVIDENCE: packages/redis/src/errors.ts:29 — `this.keys = [...keys]` (public readonly field)
         packages/redis/src/errors.ts:32 — error message includes key names:
         `Lua script "${scriptName}" keys span multiple cluster slots: ${keys.join(', ')}`
IMPACT: If a route handler catches this error and calls res.json(err), tenant-scoped Redis key names
        (e.g., `breaker:{tenant-1:session-123}:state`) could appear in the API response body.
FIX: Either (a) strip `keys` from RedisCrossSlotError.message (replace with count only),
     or (b) ensure the runtime's top-level error handler calls the sanitizer on this error type.
     The AppError base already maps to statusCode:503, so the HTTP status is correct — only the
     message text needs sanitizing at the boundary.
TEST: Add a test that catches RedisCrossSlotError in a simulated Express handler and asserts
      the response body does not contain the raw key names.
```

#### FINDING: F-4 — RETRACTED

```
SEVERITY: HIGH → RETRACTED (false positive)
EVIDENCE: apps/runtime/src/services/kms/reencryption-queue.ts:133 — Queue has prefix: '{bull}'
          apps/runtime/src/services/kms/reencryption-queue.ts:150 — Worker has prefix: '{bull}'
          Both are already correctly set.
```

#### FINDING: F-5

```
SEVERITY: LOW
DIMENSION: Stale Code
PATH: standalone path → createBullMQConnectionOptions → parseRedisUrl (dead fallback)
EVIDENCE: apps/runtime/src/services/queues/channel-queues.ts:75-80
          `if (!connection || typeof connection !== 'object') { connection = parseRedisUrl(...); }`
          createBullMQConnectionOptions always returns a ConnectionOptions object (never null/undefined).
IMPACT: None functional — this code is never reached. But it keeps the deprecated parseRedisUrl import alive.
FIX: Remove the dead fallback block and the import of parseRedisUrl from channel-queues.ts.
TEST: N/A (dead code removal)
```

---

## Round 1 Summary

| Finding                                                  | Severity | Status                                 |
| -------------------------------------------------------- | -------- | -------------------------------------- |
| F-1: handle.baseOptions exposes password as plain string | MEDIUM   | Open                                   |
| F-2: fs.readFileSync for TLS files in connection.ts      | MEDIUM   | Open                                   |
| F-3: RedisCrossSlotError.keys in API response path       | MEDIUM   | Open                                   |
| F-4: reencryption-queue missing prefix: '{bull}'         | HIGH     | **Requires fix before cluster enable** |
| F-5: Dead parseRedisUrl fallback in channel-queues       | LOW      | Open                                   |

---

---

## Round 2: Fix Verification (2026-05-09)

### Retracted Findings

| Finding | Original Severity | Retraction Reason                                                                |
| ------- | ----------------- | -------------------------------------------------------------------------------- |
| F-2     | MEDIUM            | sync-io-lint.sh explicitly exempts `*/redis/src/connection*` — approved pattern  |
| F-4     | HIGH              | `reencryption-queue.ts:133,150` already sets `prefix: '{bull}'` — false positive |

### Verified Active Findings

#### F-1: handle.baseOptions credential exposure (MEDIUM — defense-in-depth)

**Round 2 verification**: Confirmed no current code path logs or serializes `handle.baseOptions`.

- All 8 callers of `getRedisHandle()` use only `handle.duplicate()`, `handle.nodes`, `handle.isReady()` — never access `baseOptions` directly
- No current logging of the handle object found
- **Risk level**: Latent (requires future developer mistake to manifest)
- **Status**: Open recommendation — no blocking gate

**Proposed fix** (non-blocking): Add `toJSON()` to the returned handle object that strips credentials:

```typescript
toJSON() {
  return { mode: client instanceof Cluster ? 'cluster' : 'standalone', ready: this.isReady() };
}
```

#### F-3: RedisCrossSlotError key names in API response body (MEDIUM — defense-in-depth)

**Round 2 verification**:

- `packages/shared-kernel/src/errors.ts:151` — `errorToResponse()` passes `err.message` to response body for all `AppError` subclasses
- `RedisCrossSlotError.message` includes key names: `Lua script "X" keys span multiple cluster slots: key1, key2`
- Key names contain tenant-scoped identifiers (e.g., `breaker:{tenant-1:session-456}:state`)
- **Practical impact**: CROSSSLOT is a programming error that should never occur with correctly hash-tagged keys; in correct operation this code path is unreachable at production
- **Risk level**: Theoretical (requires a programming bug + unhandled route boundary)
- **Status**: Open recommendation — no blocking gate

**Proposed fix** (non-blocking): Override `message` in `RedisCrossSlotError` to strip key names:

```typescript
constructor(scriptName: string, keys: string[], cause?: unknown) {
  super(
    `Lua script "${scriptName}" keys span multiple cluster slots (${keys.length} keys)`,
    cause,
    'REDIS_CROSSSLOT_ERROR',
  );
  // Keep keys on the instance for debugging, but not in the human-readable message
  this.keys = [...keys];
}
```

#### F-5: Dead parseRedisUrl fallback in channel-queues.ts (LOW)

**Round 2 verification**: Confirmed dead — `createBullMQConnectionOptions` always returns a `ConnectionOptions` object; the `typeof connection !== 'object'` guard can never be true.

- **Status**: Open cleanup item — no functional impact

### Boundary Test Coverage Assessment

| Test needed                                                        | Exists? | Notes                                     |
| ------------------------------------------------------------------ | ------- | ----------------------------------------- |
| handle serialization does not expose password                      | ✗       | Should add as unit test in packages/redis |
| RedisCrossSlotError message does not contain key names in 503 body | ✗       | Theoretical risk; low priority            |
| All 9 BullMQ queue/worker pairs use prefix '{bull}'                | ✗       | Could add a static analysis test          |
| createSubscriber correctly rejects .duplicate() for Cluster        | ✓       | ERR-3 test in testing spec                |

---

## Final Verdict (Round 2)

- [x] No CRITICAL findings open — ✓
- [x] No HIGH findings open — ✓ (F-4 retracted; code already correct)
- [ ] MEDIUM findings addressed — F-1, F-3 open as defense-in-depth recommendations (non-blocking)
- [ ] Boundary tests for F-1, F-3 — not yet added (non-blocking)
- [x] Parallel paths verified identical — all BullMQ queue/worker pairs use `{bull}` prefix ✓
- [x] Audit log complete — Round 1 + Round 2 done

**Phase gate result**: PASS. No CRITICAL or HIGH findings remain open.

**Before BETA promotion**: Address F-1 (credential serialization guard) and F-3 (RedisCrossSlotError key name sanitization) as defense-in-depth. Neither is a blocking issue for ALPHA → BETA transition, but both improve the security posture against future developer mistakes.

---

# Audit Re-Run: Standalone ↔ Cluster Toggle (Rounds 3 + 4)

**Date**: 2026-05-10
**Auditor**: data-flow-audit skill (automated, two passes)
**Branch**: `worktree-redis-cluster-dual-mode`
**Trigger**: User-requested full audit of all packages and components for dual-mode compatibility.

This re-audit looked at the **whole codebase** (apps + packages) rather than only
the dual-mode feature surface. It found new issues that the previous Round 1/2
did not cover — five cross-slot pipelines and a config-coercion bug.

## Round 3 — Findings (full path trace)

### Connection construction inventory (whole repo)

| Bucket                | Count                    | Notes                                                                                                                                                                                |
| --------------------- | ------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| Cluster-aware factory | 8 production apps        | Each app constructs its primary client via `createRedisConnection(resolveRedisOptionsFromConfig\|FromEnv())`.                                                                        |
| BullMQ (safe)         | 38 sites                 | Every Queue/Worker/FlowProducer/QueueEvents derives its connection from `createBullMQPair(handle)`, `handle.duplicate()`, or `createWorkerOptions()` — all carry `prefix: '{bull}'`. |
| Standalone-only       | 5 non-production scripts | `apps/crawler-go-worker/test-*.js` (×3), `apps/search-ai/test-crawl-simple.js`, `apps/runtime/scripts/agent-assist-dlq-inspect.ts`. Not on any code path that runs in production.    |
| Parse-only            | 2                        | URL parsers internal to the factory + DLQ-inspect helper.                                                                                                                            |

### Multi-key operations / Lua / locks / pub-sub / KEYS

| ID     | Severity | File:line                                                             | Issue                                                                                                                               | Status (Round 4)                                                                                                                                                                  |
| ------ | -------- | --------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| F-1\*  | CRITICAL | `apps/runtime/src/services/trace/redis-trace-store.ts:247`            | Pipeline mixes `trace:stream:…` + `trace:channel:…` (different slots).                                                              | **FIXED** — pipeline now wraps `xadd+expire` on `streamKey` only; `publish(channelKey)` is a separate top-level call (matches the existing memory-pressure path).                 |
| F-2\*  | CRITICAL | `packages/agent-transfer/src/session/session-recovery-service.ts:245` | Pipeline HGETALL on per-tenant session keys (different slots).                                                                      | **FIXED** — `Promise.all(batchKeys.map(k => redis.hgetall(k).then([null, hash], [err, {}])))`. Result shape unchanged for downstream reader at `:271-274`.                        |
| F-3\*  | CRITICAL | `packages/agent-transfer/src/session/session-recovery-service.ts:299` | Pipeline EXISTS on per-host pod heartbeat keys (different slots).                                                                   | **FIXED** — `Promise.all(checks.map(c => redis.exists(podHeartbeatKey(...)).then([null, n], [err, 0])))`.                                                                         |
| F-4\*  | CRITICAL | `apps/search-ai/src/workers/bulk-crawl-worker.ts:834`                 | Pipeline DEL on per-URL checkpoint keys (different slots).                                                                          | **FIXED** — `Promise.all(urls.map(url => redis.del(...)))`. Best-effort cleanup; no caller depends on result shape.                                                               |
| F-5\*  | CRITICAL | `apps/search-ai/src/routes/intelligence.ts:994`                       | Pipeline GET on per-page keys (different slots).                                                                                    | **FIXED** — `Promise.all(pageKeys.map(k => redisClient.get(k).then([null, val], [err, null])))`. Downstream `for ([err, val] of results)` shape preserved.                        |
| F-6\*  | HIGH     | `deploy/helm-values/tier-{m,l,xl}/values.yaml`                        | `REDIS_CLUSTER` not set; `REDIS_URL` is single host:port.                                                                           | DEFERRED — touches deployed infra; one-line YAML change pairs with cluster provisioning.                                                                                          |
| F-7\*  | HIGH     | `packages/config/src/env-mapping.ts:166`                              | `coerceValue` splits comma-separated `REDIS_URL` into `string[]`; Zod schema rejects arrays. Affects Runtime + Studio config paths. | **FIXED** — added `STRING_VALUED_ENV_KEYS = {REDIS_URL, MONGODB_URI}`; `coerceValue(value, envKey?)` skips comma-split for those keys; `mapEnvToConfig` threads `envKey` through. |
| F-7b   | HIGH     | `apps/admin/src/app/api/config/{route,diff/route}.ts`                 | Stale duplicate `coerceValue` (Turbopack workaround) had the same bug.                                                              | **FIXED** — same guard added to both copies; comment points at the canonical version.                                                                                             |
| F-8\*  | HIGH     | `apps/runtime/src/services/agent-transfer/index.ts:702`               | `CONFIG SET notify-keyspace-events Ex` only reaches one master.                                                                     | DOCUMENTED — runbook: configure notification policy in the cluster parameter group. Code already explains this at the call site.                                                  |
| F-9\*  | MEDIUM   | `apps/runtime/src/services/trace/redis-trace-store.ts:123`            | `INFO memory` samples a single node in cluster mode.                                                                                | DOCUMENTED — best-effort heuristic for the trace-store memory-pressure shedder.                                                                                                   |
| F-10\* | LOW      | `apps/{search-ai,search-ai-runtime,workflow-engine}/.env.example`     | Missing `REDIS_CLUSTER` example entries.                                                                                            | DEFERRED — docs only; runtime read `process.env` directly.                                                                                                                        |

(\*) IDs in this section are scoped to Rounds 3+4 and do not collide with the Round 1/2 findings above.

### Verified-safe patterns (no findings)

- All `runLuaScript` call-sites are single-key (`numberOfKeys: 1`) or hash-tagged via `breakerKeys()` / `hashTag(barrierId)`.
- All distributed locks use single-key `SET NX [PX|EX]` plus single-key Lua release (verified across 14 lock sites).
- All 14 production subscribers use `createSubscriber(handle)`; the one caller-injected subscriber pattern (`packages/connectors/base/.../cancellation-checker.ts:68`) receives a `createSubscriber`-built client from its only production caller.
- All 21 pattern-iterating call sites use the cluster-safe `scanKeys` helper. No direct `KEYS`, `FLUSHDB`, `FLUSHALL`, `DBSIZE` in production.
- `circuit-breaker/redis-circuit-breaker.ts:190` pipeline targets five hash-tagged keys (`{level:key}`) — same slot.
- `session-recovery-service.ts:290` SREM batch targets the single set `at_active_sessions` — same slot.

## Round 4 — Fix Verification + Tests

### Production code review (per fix)

| Fix   | Verdict | Notes                                                                                 |
| ----- | ------- | ------------------------------------------------------------------------------------- |
| F-1\* | PASS    | Group preserved (xadd-then-expire, then publish). `await` chain serializes correctly. |
| F-2\* | PASS    | Tuple shape `[null, hash]` / `[err, {}]` matches `result?.[1]` reader.                |
| F-3\* | PASS    | Tuple shape `[null, n]` / `[err, 0]` matches `heartbeatResults?.[i]?.[1] as number`.  |
| F-4\* | PASS    | Best-effort cleanup; wrapped in try/catch; no caller depends on results.              |
| F-5\* | PASS    | Tuple shape `[null, val]` / `[err, null]` matches `for ([err, val] of results)`.      |
| F-7\* | PASS    | CORS_ORIGINS / CORS_METHODS still split correctly (not in exemption set).             |
| F-7b  | PASS    | Both admin route copies updated; comment points at canonical source.                  |

### Build + test results

| Surface                                                                          | Result                                                                                    |
| -------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------- |
| `pnpm build --filter=@agent-platform/redis --filter=@agent-platform/config`      | green (3 packages)                                                                        |
| `pnpm build --filter=@agent-platform/agent-transfer`                             | green (16 packages, 8 cached)                                                             |
| `pnpm build --filter=@agent-platform/runtime --filter=@agent-platform/search-ai` | green (38 packages, 23 cached)                                                            |
| `pnpm build --filter=@agent-platform/admin`                                      | green (16 packages, 8 cached)                                                             |
| `vitest run packages/config env-mapping.test.ts`                                 | 19/19 pass — includes 2 new regression tests for REDIS_URL + MONGODB_URI seed-list shape. |
| `vitest run packages/agent-transfer recovery-sscan-pipeline.test.ts`             | 6/6 pass — assertions rewritten to verify parallel HGETALL/EXISTS instead of pipeline.    |
| `vitest run apps/runtime redis-trace-store.test.ts`                              | 32/32 pass — mock now exposes top-level `publish`; assertion checks `mock.redis.publish`. |

### Boundary test gaps (carried forward)

| Path                                  | Status | Recommended test                                                                                        |
| ------------------------------------- | ------ | ------------------------------------------------------------------------------------------------------- |
| `bulk-crawl-worker.ts` checkpoint DEL | GAP    | Unit: assert `redis.del` called once per URL (mocked).                                                  |
| `intelligence.ts` page-key GET        | GAP    | Unit: assert `Promise.all` GETs and downstream `[err, val]` consumption.                                |
| Trace-store against real cluster      | GAP    | Integration via `tools/cluster-test-harness.ts`: write 100 events from one tenant, assert no CROSSSLOT. |
| Session-recovery against real cluster | GAP    | Integration: pre-seed 50 session keys spanning multiple tenants, run `recoverOrphanedSessions`.         |

These are non-blocking: the `pipeline → Promise.all` rewrites are mechanically equivalent in standalone mode (no behavior change), and per-key routing in cluster mode is an ioredis-Cluster contract guarantee.

## Final Verdict (Rounds 3 + 4)

- [x] No CRITICAL findings open
- [x] All HIGH findings closed except F-6\* (helm values, deferred to deployment-pairing)
- [x] All affected unit tests green (57 tests across three files; updated mocks reflect cluster-safe code)
- [x] Builds green for redis, config, agent-transfer, runtime, search-ai, admin
- [x] Audit log complete

**Operator runbook to switch a deployment to cluster mode:**

1. Provision the Redis Cluster (3+ masters).
2. Set `REDIS_URL` to a comma-separated seed list, e.g. `redis://h1:6379,redis://h2:6379,redis://h3:6379`.
3. Set `REDIS_CLUSTER=true`.
4. Configure `notify-keyspace-events=Ex` in the cluster parameter group (CONFIG SET via the runtime client only reaches one master).
5. Roll out. The platform code now routes per-key in cluster mode and degrades cleanly (no CROSSSLOT) on previously-unsafe pipelines.

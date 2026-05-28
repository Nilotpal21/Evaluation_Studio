# ClickHouse Schema Init — Leader-Elected, Non-Blocking

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Eliminate the startup bottleneck where every pod independently runs ~45 sequential DDL statements against ClickHouse, blocking `server.listen()` for 30+ seconds.

**Architecture:** Two-layer fix. Layer 1: configurable `request_timeout` on the ClickHouse client (immediate band-aid). Layer 2: leader-elected schema init via Redis distributed lock — one pod runs DDL, others wait for a `schema-ready` signal. Services with graceful fallback (runtime, search-ai, search-ai-runtime) run init in the background; pipeline-engine (which requires ClickHouse) keeps the await but benefits from leader election.

**Tech Stack:** `@clickhouse/client` request_timeout, `DistributedLockManager` from `@agent-platform/shared-observability`, `@agent-platform/redis` for standalone lock connection.

---

### Task 1: Add request_timeout config to ClickHouse client

**Files:**

- Modify: `packages/database/src/clickhouse.ts:48-68`
- Test: `packages/database/src/__tests__/clickhouse-client-config.test.ts`

- [ ] **Step 1: Write failing tests**

Create `packages/database/src/__tests__/clickhouse-client-config.test.ts` with tests for:

- Default 30s timeout when env var not set
- Custom timeout from `CLICKHOUSE_REQUEST_TIMEOUT_MS`
- NaN fallback to 30s default

- [ ] **Step 2: Run tests to verify they fail**

Run: `cd packages/database && npx vitest run src/__tests__/clickhouse-client-config.test.ts`
Expected: FAIL — `request_timeout` is `undefined`

- [ ] **Step 3: Implement request_timeout in createConfiguredClickHouseClient**

In `packages/database/src/clickhouse.ts`, add env var parsing and pass `request_timeout` to `createClient()`.

- [ ] **Step 4: Run tests to verify they pass**

Run: `cd packages/database && npx vitest run src/__tests__/clickhouse-client-config.test.ts`
Expected: PASS

- [ ] **Step 5: Build**

Run: `pnpm build --filter=@agent-platform/database`

- [ ] **Step 6: Commit**

```
[ABLP-002] fix(database): add configurable request_timeout to ClickHouse client
```

---

### Task 2: Create initClickHouseSchemaWithLeaderElection wrapper

**Files:**

- Create: `packages/database/src/clickhouse-schemas/leader-init.ts`
- Test: `packages/database/src/__tests__/clickhouse-leader-init.test.ts`

- [ ] **Step 1: Write the leader-init module**

Create `packages/database/src/clickhouse-schemas/leader-init.ts` exporting:

```typescript
export interface LeaderSchemaInitOptions {
  lockTtlMs?: number; // default 120_000
  readyKeyTtlSec?: number; // default 3600
  pollIntervalMs?: number; // default 500
  pollTimeoutMs?: number; // default 120_000
}

export async function initClickHouseSchemaWithLeaderElection(
  client: ClickHouseClient,
  redis: RedisClient,
  options?: LeaderSchemaInitOptions,
): Promise<{ role: 'leader' | 'follower' | 'fallback'; durationMs: number }>;
```

Flow:

1. Try acquire lock `clickhouse:schema-init:schema` with TTL
2. **Leader**: run `initClickHouseSchema(client)`, set `clickhouse:schema-ready` key, release lock
3. **Follower**: poll `clickhouse:schema-ready` key until it appears or timeout
4. **Fallback** (Redis error): run `initClickHouseSchema(client)` directly (current behavior)

- [ ] **Step 2: Write tests**

Test cases:

- Leader acquires lock, runs schema init, sets ready key
- Follower finds lock held, polls ready key, returns success
- Follower times out waiting for ready key
- Redis unavailable — falls back to direct init
- Leader fails during init — lock released, no ready key set

- [ ] **Step 3: Run tests**

Run: `cd packages/database && npx vitest run src/__tests__/clickhouse-leader-init.test.ts`

- [ ] **Step 4: Export from package**

Add export to the appropriate package entry point.

- [ ] **Step 5: Build**

Run: `pnpm build --filter=@agent-platform/database`

- [ ] **Step 6: Commit**

```
[ABLP-002] feat(database): add leader-elected ClickHouse schema initialization
```

---

### Task 3: Make runtime ClickHouse init non-blocking

**Files:**

- Modify: `apps/runtime/src/server.ts:2886-2970` (ClickHouse init block)
- Modify: `apps/runtime/src/server.ts:2975-3230` (downstream clickhouseReady gates)

- [ ] **Step 1: Extract downstream wiring into onClickHouseReady function**

Extract all `clickhouseReady`-gated blocks (EventBus, audit store, event store, workflow tables, workflow sink, hybrid reader, test diagnostics) into a standalone `async function onClickHouseReady(chClient, app)`.

- [ ] **Step 2: Replace blocking init with background init**

Replace `await initClickHouseSchema(chClient)` with:

1. Create a standalone Redis connection for the lock
2. Fire-and-forget `initClickHouseSchemaWithLeaderElection(chClient, redis)`
3. On success: set `clickhouseReady = true`, call `onClickHouseReady()`
4. On failure: set `clickhouseInitializationFailure`, log warning
5. `server.listen()` proceeds immediately regardless

- [ ] **Step 3: Build**

Run: `pnpm build --filter=@agent-platform/runtime`

- [ ] **Step 4: Commit**

```
[ABLP-002] feat(runtime): non-blocking leader-elected ClickHouse schema init
```

---

### Task 4: Update search-ai and search-ai-runtime services

**Files:**

- Modify: `apps/search-ai/src/server.ts:453-472`
- Modify: `apps/search-ai-runtime/src/server.ts:348-371`

- [ ] **Step 1: Update search-ai-runtime**

search-ai-runtime already has Redis before ClickHouse (line 324). Replace `await initClickHouseSchema(chClient)` with background `initClickHouseSchemaWithLeaderElection`.

- [ ] **Step 2: Update search-ai**

search-ai has Redis after ClickHouse (line 510). Create a standalone Redis connection for the lock (same pattern as runtime). Replace with background init.

- [ ] **Step 3: Build both**

Run: `pnpm build --filter=@agent-platform/search-ai --filter=@agent-platform/search-ai-runtime`

- [ ] **Step 4: Commit**

```
[ABLP-002] feat(search-ai): non-blocking leader-elected ClickHouse schema init
```

---

### Task 5: Update pipeline-engine (blocking but leader-elected)

**Files:**

- Modify: `packages/pipeline-engine/src/pipeline/server.ts:470-488`

- [ ] **Step 1: Keep await but use leader-elected init**

Pipeline-engine requires ClickHouse — keep the `await` but wrap with `initClickHouseSchemaWithLeaderElection`. Uses existing `redisClient` (line 454). Add try/catch so a transient failure doesn't crash the pod.

- [ ] **Step 2: Build**

Run: `pnpm build --filter=@agent-platform/pipeline-engine`

- [ ] **Step 3: Commit**

```
[ABLP-002] feat(pipeline-engine): leader-elected ClickHouse schema init
```

---

### Task 6: Write tests for leader-elected schema init

**Files:**

- Test: `packages/database/src/__tests__/clickhouse-leader-init.test.ts`

This is covered in Task 2 step 2. This task is for additional edge-case and integration-level tests if needed after all services are wired up.

- [ ] **Step 1: Verify all builds pass**

Run: `pnpm build`

- [ ] **Step 2: Run full database test suite**

Run: `cd packages/database && npx vitest run`

- [ ] **Step 3: Final commit if any fixes needed**

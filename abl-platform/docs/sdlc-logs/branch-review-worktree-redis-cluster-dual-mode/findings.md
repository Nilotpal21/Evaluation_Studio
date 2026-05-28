# Helix branch-review findings: worktree-redis-cluster-dual-mode

Session `ac5810fb` -- branch review of `origin/worktree-redis-cluster-dual-mode` vs `origin/develop`.
Helix Oracle Analysis loop hit ABLP-850 (Codebase Oracle + Industry Research Oracle stalls every iteration;
AMBIGUOUS decisions not persisting after CLI unsettled-await exit). Findings captured here as the
operator-driven workaround.

Date: 2026-05-06
Findings: 15 active -- 1 critical, 3 high, 8 medium, 3 low

Reviewed follow-up: 2026-05-06. The active list below reflects a manual verification pass against
`origin/worktree-redis-cluster-dual-mode` after fetch. Speculative items from the first pass were either
tightened into concrete bugs or moved to the dropped/replaced section at the end.

## [CRITICAL] Crawler Go worker BullMQ polling is not Redis Cluster-safe

- **id:** `acf4a93e`
- **category:** bug
- **files:** {"path":"apps/crawler-go-worker/internal/config/config.go"}, {"path":"apps/crawler-go-worker/internal/queue/consumer.go"}, {"path":"apps/crawler-go-worker/.env.example"}

The Go crawler switches to `redis.ClusterClient` when `REDIS_CLUSTER=true`, but it manually builds BullMQ
keys as `bull:<queue>:wait`, `bull:<queue>:active`, `bull:<queue>:<jobId>`,
`bull:<queue>:<jobId>:lock`, `bull:<queue>:completed`, `bull:<queue>:failed`, and
`bull:<queue>:events`. `pollJob()` then calls `RPopLPush(waitKey, activeKey)` across untagged keys.
In Redis Cluster this will fail with `CROSSSLOT` because the queue keys are not guaranteed to share a
hash slot. Completion/failure pipelines have the same issue across job, active, completed/failed, lock,
stalled, and event keys. If the Node BullMQ side uses hash-tagged queue keys in cluster mode, the Go
worker will also poll the wrong untagged keys and never see jobs.

**Suggested fix:** Centralize the Go worker's BullMQ key builder and make every queue key use the same
hash tag, for example `bull:{<queue>}:wait`, `bull:{<queue>}:active`,
`bull:{<queue>}:<jobId>`, `bull:{<queue>}:<jobId>:lock`, and `bull:{<queue>}:events`. Add a real
cluster regression that performs poll -> complete/fail against Redis Cluster.

## [HIGH] Runtime channel and promote-context BullMQ workers are not cluster-aware

- **id:** `04504612`
- **category:** bug
- **files:** {"path":"apps/runtime/src/services/queues/channel-queues.ts"}, {"path":"apps/runtime/src/services/queues/redis-utils.ts"}, {"path":"apps/runtime/src/services/queues/delivery-worker.ts"}, {"path":"apps/runtime/src/services/queues/inbound-worker.ts"}, {"path":"apps/runtime/src/services/queues/promote-context-producer.ts"}, {"path":"apps/runtime/src/services/queues/promote-context-worker.ts"}

`channel-queues.ts` creates producer queues with a duplicated shared handle in cluster mode, but the
workers that actually consume those queues still call the local `parseRedisUrl(config.redis.url)`.
`parseRedisUrl()` is a single-node `new URL()` parser, while the dual-mode cluster contract documents
`REDIS_URL` as a comma-separated seed list. With `REDIS_CLUSTER=true`, `startInboundWorker()`,
`startDeliveryWorker()`, `initPromoteContextQueue()`, and `startPromoteContextWorker()` either throw on
cluster seed URLs such as `redis://host1:6379,redis://host2:6379`, or construct a standalone connection
from a malformed single URL. The result is that channel inbound, webhook delivery, and promote-context
jobs can enqueue but not be processed in cluster deployments.

**Suggested fix:** Build these queues/workers from `getRedisHandle()` + `createBullMQPair()` and pass
explicit queue/worker connections into each lifecycle. Remove the `parseRedisUrl()` fallback from new
BullMQ construction paths or restrict it to standalone-only code with tests.

## [HIGH] Cluster Redis URLs drop or corrupt auth/TLS settings

- **id:** `39c738f1`
- **category:** bug
- **files:** {"path":"packages/redis/src/\_\_tests\_\_/connection.test.ts"}, {"path":"packages/redis/src/connection.ts"}, {"path":".env.example"}, {"path":"apps/search-ai/.env.example"}, {"path":"apps/search-ai-runtime/.env.example"}, {"path":"apps/runtime/.env.example"}, {"path":"apps/studio/.env.example"}

In `createRedisConnection()`, URL parsing is skipped when `opts.cluster` is true. The cluster seed parser
then strips only the scheme and splits each seed on `:`, so credentials in
`redis://user:pass@host:6379` are not merely ignored: the parser can treat `user` as the host and parse
`pass@host` as the port. `rediss://` seed URLs also do not set TLS because `urlTls` is only populated on
the standalone path. Separately, `resolveRedisOptionsFromEnv()` only copies `REDIS_PASSWORD` when
`REDIS_URL` is absent and does not read the documented `REDIS_TLS_ENABLED` env setting. Authenticated or
TLS Redis Cluster deployments therefore cannot be configured reliably through either URL credentials,
`REDIS_PASSWORD`, or `REDIS_TLS_ENABLED`.

**Suggested fix:** Parse each cluster seed with URL parsing that preserves host/port and extracts shared
auth/TLS options from the first URL when present. Let explicit env options override or fill URL-derived
values consistently. Add tests for `redis://user:pass@host:6379`, `rediss://host:6379`, `REDIS_URL` +
`REDIS_PASSWORD`, and `REDIS_URL` + `REDIS_TLS_ENABLED`.

## [HIGH] Runtime BullMQ connection pairs are not stopped or disconnected on shutdown

- **id:** `runtime-bullmq-pair-leak`
- **category:** lifecycle-bug
- **files:** {"path":"apps/runtime/src/server.ts"}, {"path":"apps/runtime/src/services/queues/resumption-worker.ts"}, {"path":"apps/runtime/src/workers/agent-assist-callback-worker.ts"}, {"path":"packages/redis/src/bullmq.ts"}

`server.ts` creates `resumptionPair = createBullMQPair(redisHandle)` and `agentAssistPair =
createBullMQPair(redisHandle)`, then passes their queue/worker connections into BullMQ queues and
workers. Shutdown closes only `agentAssistCallbackQueue`; it does not close the `execution-resume` queue,
does not call `stopResumptionWorker()`, does not call `stopAgentAssistCallbackWorker()`, and never calls
either pair's `disconnect()`. The `createBullMQPair()` contract explicitly says BullMQ `.close()` does not
disconnect duplicated Redis/Cluster clients. In cluster mode, each pair also owns independent Cluster
connections and a watchdog interval that is only cleared by `disconnect()`.

**Suggested fix:** Retain both BullMQ pairs and queues in server-level state, call worker stop functions,
close queues/DLQs, and call `pair.disconnect()` after BullMQ objects are closed. Add a shutdown unit test
that asserts pair disconnects are invoked.

## [MEDIUM] Channel queue shutdown skips cleanup after partial worker startup failure

- **id:** `channel-partial-startup-leak`
- **category:** lifecycle-bug
- **files:** {"path":"apps/runtime/src/services/queues/index.ts"}, {"path":"apps/runtime/src/services/queues/channel-queues.ts"}, {"path":"apps/runtime/src/services/queues/promote-context-producer.ts"}

`startChannelQueues()` calls `initChannelQueues()` before starting inbound, delivery, and promote-context
workers. If queue initialization succeeds but one worker throws during startup -- which is exactly what
the cluster `parseRedisUrl()` bug can trigger -- `workersStarted` remains false. `stopChannelQueues()`
then returns immediately when `workersStarted` is false, skipping `closeChannelQueues()` and
`closePromoteContextQueue()`. Already-created Queue objects and their Redis connections can therefore
survive shutdown/restart after a partial startup failure.

**Suggested fix:** Track queue initialization separately from worker startup. Shutdown should always
attempt to close initialized queues, even when workers never reached the "started" state.

## [MEDIUM] Multimodal service BullMQ Redis clients leak

- **id:** `multimodal-bullmq-client-leak`
- **category:** lifecycle-bug
- **files:** {"path":"apps/multimodal-service/src/jobs/queues.ts"}, {"path":"apps/multimodal-service/src/server.ts"}, {"path":"apps/multimodal-service/src/services/queues.ts"}

`createQueue()` and `createWorkerOptions()` allocate fresh `handle.duplicate({ maxRetriesPerRequest:
null })` connections for each BullMQ Queue/Worker. The service stores and closes Worker objects on
shutdown, but it does not retain the Queue instances created for `scan`, `validate`, `process`, `index`,
`cleanup`, and sweep jobs, and it does not disconnect the duplicated Redis/Cluster clients. The only
queue lifecycle called during shutdown is `closeAttachmentQueues()`, which manages a different legacy
singleton queue. This bypasses the cleanup contract introduced by `createBullMQPair()`.

**Suggested fix:** Use `createBullMQPair()` per queue/worker pair or retain every duplicated connection
and disconnect it after closing BullMQ objects. Make shutdown close all created Queue instances, including
cleanup and sweep queues.

## [MEDIUM] Python preprocessing seed parser corrupts redis:// hosts

- **id:** `preprocessing-seed-lstrip`
- **category:** bug
- **files:** {"path":"services/preprocessing-service/src/cache/redis_cache.py"}

In cluster mode, preprocessing parses `REDIS_URL` seeds with
`node.strip().lstrip('redis://').lstrip('rediss://')`. Python `str.lstrip(chars)` removes any leading
characters contained in the provided string, not the exact prefix. A seed such as
`redis://redis-0:6379` can become `-0:6379`, breaking the documented scheme-bearing seed format.

**Suggested fix:** Use `removeprefix('redis://')` / `removeprefix('rediss://')` or `urllib.parse`
instead of `lstrip()`. Add a cluster seed parsing unit test for scheme-bearing hosts.

## [MEDIUM] Pipeline engine bypasses the Redis cluster factory

- **id:** `pipeline-engine-direct-ioredis`
- **category:** wiring-gap
- **files:** {"path":"packages/pipeline-engine/src/pipeline/server.ts"}, {"path":"packages/redis/src/\_\_tests\_\_/migration-completeness.static.test.ts"}

`packages/pipeline-engine/src/pipeline/server.ts` dynamically imports `ioredis`, resolves
`RedisConstructor`, and calls `new RedisConstructor(redisUrl, ...)` for the definition cache. This bypasses
`createRedisConnection()` and therefore ignores the Redis Cluster dual-mode factory, cluster seed parsing,
shared auth/TLS handling, cluster helper metrics, and operation wrappers. The static guard only catches
literal `new Redis(...)` / `new IORedis(...)` patterns, so this dynamic constructor evades the migration
completeness test.

**Suggested fix:** Route the definition cache through `@agent-platform/redis` connection helpers, or make
the cache accept an injected `RedisClient`/handle. Extend the static guard to catch dynamic ioredis
constructor aliases.

## [MEDIUM] Redis init error reporting misses connection failures

- **id:** `6817f295`
- **category:** bug
- **files:** {"path":"packages/redis/src/singleton.ts"}

`getRedisInitError()` is documented as returning the last failed `initializeRedis` error for health checks
and diagnostics. But `initializeRedis()` catches `handle.client.connect()` failures inside the success path,
logs them, and never assigns `initError`. That means diagnostics return `null` for the common failure mode
where options parse correctly but Redis is unreachable. `initError` is only set when
`createRedisConnection()` itself throws synchronously.

**Suggested fix:** Record the initial connection failure in a diagnostic field without nulling the handle,
or clarify the API contract and expose a separate "last connect failure" value for health endpoints.

## [MEDIUM] Two distributed lock implementations now diverge on Lua execution

- **id:** `ec24a028`
- **category:** inconsistency
- **files:** {"path":"packages/shared/src/redis/distributed-lock.ts"}, {"path":"packages/shared-observability/src/distributed-lock.ts"}

`packages/shared/src/redis/distributed-lock.ts` was migrated to `runLuaScript()` for release/extend, but
`packages/shared-observability/src/distributed-lock.ts` still carries a duplicate lock manager that calls
`redis.eval()` directly. The operations are single-key, so this is not a `CROSSSLOT` failure today, but it
bypasses the shared `RedisOperationError` / `RedisCrossSlotError` wrapping and metrics path and leaves two
nearly identical lock implementations with different runtime behavior.

**Suggested fix:** Either consolidate the duplicate lock managers or migrate the observability copy to the
same `runLuaScript()` wrapper and tests.

## [MEDIUM] Runtime channel/promote queue lifecycle lacks real cluster coverage

- **id:** `980fe2cf`
- **category:** missing-test
- **files:** {"path":"apps/runtime/src/\_\_tests\_\_/inbound-worker.test.ts"}, {"path":"apps/runtime/src/\_\_tests\_\_/inbound-worker-twilio-sms.test.ts"}, {"path":"apps/runtime/src/services/queues/channel-queues.ts"}, {"path":"apps/runtime/src/services/queues/promote-context-producer.ts"}, {"path":"apps/runtime/src/services/queues/promote-context-worker.ts"}

The scoped tests for inbound workers are unit tests with mocked Redis/BullMQ behavior. There is no real
cluster test for `startChannelQueues()` / `stopChannelQueues()`, inbound worker startup, delivery worker
startup, or promote-context producer/worker startup. That gap allowed `parseRedisUrl()` single-node wiring
to remain in the cluster path even though other Redis surfaces in the branch have dedicated
`*.cluster.test.ts` coverage.

**Suggested fix:** Add a Redis Cluster test that initializes channel queues, starts the workers, enqueues
one inbound/delivery/promote job, and then shuts down while asserting all queue and connection cleanup runs.

## [MEDIUM] Resumption worker wiring is cluster-aware but lacks cluster lifecycle coverage

- **id:** `resumption-worker-cluster-lifecycle-test`
- **category:** missing-test
- **files:** {"path":"apps/runtime/src/services/queues/resumption-worker.ts"}, {"path":"apps/runtime/src/server.ts"}

The PR branch does wire `resumption-worker.ts` with `workerConnection` from `createBullMQPair()`, so this
is not a confirmed cluster wiring bug. It is still missing coverage for the real cluster lifecycle:
creating the queue/worker pair, enqueueing a resume job, closing the worker and queue, and disconnecting
the pair. The server shutdown gap above shows why this lifecycle coverage matters.

**Suggested fix:** Add a focused cluster lifecycle test for the execution-resume queue and assert worker,
queue, and pair cleanup.

## [LOW] apps/runtime/agents.md has no entry for Redis cluster dual-mode queue subsystem

- **id:** `85e07517`
- **category:** missing-doc
- **files:** {"path":"apps/runtime/agents.md"}, {"path":"apps/runtime/src/services/queues/channel-queues.ts"}, {"path":"apps/runtime/src/services/queues/index.ts"}

`apps/runtime/agents.md` does not document the channel queue lifecycle, inbound/delivery workers, promote
context queue, resumption queue, or Agent Assist callback queue as Redis cluster dual-mode surfaces. Given
past omitted-consumer incidents and the number of independent BullMQ lifecycle paths in runtime, this
inventory gap makes future review passes less likely to catch raw `parseRedisUrl()` or missing disconnect
regressions.

**Suggested fix:** Add a runtime queue subsystem inventory entry that names the producer, worker, startup,
shutdown, and cluster-test owner for each BullMQ queue.

## [LOW] ESLint guard does not match the documented Redis SCAN restriction

- **id:** `a8938c2d`
- **category:** inconsistency
- **files:** {"path":".eslintrc.base.json"}, {"path":"packages/redis/src/\_\_tests\_\_/migration-completeness.static.test.ts"}, {"path":"docs/guides/redis-cluster-mode.md"}

The runbook and migration-completeness test say both ESLint and static tests forbid direct Redis scan
usage. `.eslintrc.base.json` restricts `.keys()` and `.duplicate()`, but not `.scan()`. Direct `.scan()` is
caught later by a grep-based test, not at edit/lint time. This weakens the intended pre-commit feedback
for a known cluster partial-result hazard.

**Suggested fix:** Add a no-restricted-syntax selector for `.scan()` on Redis-shaped receivers, aligned
with the migration completeness test.

## [LOW] Redis env parsing lacks auth/TLS regression coverage

- **id:** `e9919121`
- **category:** missing-test
- **files:** {"path":"packages/redis/src/\_\_tests\_\_/connection.test.ts"}, {"path":"packages/redis/src/\_\_tests\_\_/cluster-helpers.cluster.test.ts"}, {"path":"packages/redis/src/connection.ts"}

The connection tests cover URL parsing, explicit TLS options, and `REDIS_CLUSTER` boolean parsing, but not
the documented env combinations `REDIS_URL` plus `REDIS_PASSWORD` or `REDIS_TLS_ENABLED`. That gap allowed
the env propagation bug to survive despite broad cluster-helper coverage.

**Suggested fix:** Add regression tests for env-derived auth/TLS combinations in both standalone and
cluster option resolution.

## Dropped or replaced from first pass

- **Dropped:** `search-ai-runtime/agents.md cluster learnings reference getdel cast removal but wiring not
confirmed`. `apps/search-ai-runtime/src/services/cache/redis-client.ts` already uses typed
  `this.redis.getdel(key)` with no `(this.redis as any).getdel(...)` cast.
- **Replaced:** `inbound-worker SSRF check scope unclear in cluster context`. The SSRF/cluster-cache concern
  was speculative. The confirmed bug is the raw `parseRedisUrl()` BullMQ worker wiring captured above.
- **Replaced:** `inbound-worker job payload tenantId/connectionId isolation not cluster-tested`. No concrete
  cross-slot tenant/connection key operation was found in the worker path. The actionable issue is the
  missing real cluster lifecycle coverage for channel/promote queues.
- **Reworded:** `promote-context-producer and promote-context-worker cluster-safety unverified`. Verification
  confirmed both files use `parseRedisUrl()`, so this is now part of the high-severity runtime worker
  cluster-awareness finding.
- **Reworded:** `resumption-worker.ts has no cluster-mode test`. The worker is cluster-aware in this branch;
  the remaining concern is lifecycle coverage plus the server shutdown/disconnect bug.

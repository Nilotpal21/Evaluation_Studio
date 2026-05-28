# Redis Cluster Mode — Operator Runbook

**Audience**: Platform operators, SRE, on-call engineers
**Scope**: Operating Redis in cluster mode (tier-M / tier-L / tier-XL / SIT). Tier-S keeps Sentinel.
**Related**: [`docs/features/redis-dual-mode.md`](../features/redis-dual-mode.md), [`docs/specs/redis-dual-mode.hld.md`](../specs/redis-dual-mode.hld.md), [`docs/plans/2026-05-04-redis-dual-mode-impl-plan.md`](../plans/2026-05-04-redis-dual-mode-impl-plan.md)

---

## 1. Overview

The platform supports two Redis topologies behind a single application abstraction (`@agent-platform/redis`):

| Mode       | Toggle                          | Used by                        | Connection class  |
| ---------- | ------------------------------- | ------------------------------ | ----------------- |
| Standalone | `REDIS_CLUSTER=false` (default) | tier-S, dev, CI                | `ioredis.Redis`   |
| Cluster    | `REDIS_CLUSTER=true`            | SIT, tier-M / tier-L / tier-XL | `ioredis.Cluster` |

The flag is read in `packages/redis/src/connection.ts` via `resolveRedisOptionsFromEnv()`. All consumers go through `createRedisConnection(opts)` and receive a cluster-aware `RedisConnectionHandle` with `client`, `duplicate()`, `disconnect()`, and `nodes()`.

### When to enable cluster mode

- **Tier-M, tier-L, tier-XL**: required (configured by default in their helm values).
- **SIT**: required for parity validation before each prod cutover.
- **Tier-S, local dev, CI**: not recommended. Cluster adds operational cost (3+ masters, 3+ replicas) and the smaller workloads do not justify it.

---

## 2. Flag flip procedure

### 2.1 Per-tier helm values

Edit the tier's values file:

```yaml
# deploy/helm-values/tier-m/values.yaml (or tier-l, tier-xl)
runtime:
  env:
    REDIS_CLUSTER: 'true'
    REDIS_URL: 'redis://redis-cluster.abl-data.svc:6379' # any seed node
```

Re-deploy via the standard release process. Each runtime / worker pod will start a fresh `ioredis.Cluster` client on next boot. **No data migration required** — cluster and standalone are alternative connection topologies, not different data formats.

### 2.2 SIT environment

SIT does not have a tier-specific values file. The flag is set in whichever environment-overlay is used to boot the SIT release (typically a SIT overlay layered on tier-M values). Confirm the path with the deploy lead before flipping. Once verified, the change is one line.

### 2.3 Verify after flip

After redeploy, confirm cluster mode is active:

```bash
# 1. Check pod logs for the cluster banner
kubectl logs -n abl-runtime deploy/runtime | grep -E 'redis.cluster|REDIS_CLUSTER'

# Expected: a 'redis cluster connection ready' style log within 10 s of pod start.

# 2. Verify metrics
# - redis.crossslot.errors should remain 0 (any non-zero means a code defect; see §6).
# - redis.cluster.failover increments only on triggered failovers.
# - redis.subscriber.reconnect increments only when a master is replaced.
```

Roll back: set `REDIS_CLUSTER: 'false'` and redeploy. Reshaped keys self-expire within their TTLs (session ≤ 1 h, BullMQ jobs ≤ retention).

---

## 3. Architectural facts an operator needs

### 3.1 Hash tags

Cluster mode shards keys across slots based on the CRC-16 of the key (or, if present, the substring inside `{...}`). Two keys in the same hash tag are guaranteed to share a slot.

Tagged keys used by the platform:

| Family                 | Key shape                                                            | Why tagged                                                       |
| ---------------------- | -------------------------------------------------------------------- | ---------------------------------------------------------------- |
| Agent-transfer session | `agent_transfer:{tenantId:contactId:channel}`                        | Lua script reads/writes session hash + provider index atomically |
| Provider index         | `at_by_provider:{tenantId:contactId:channel}:<provider>:<sessionId>` | Same slot as session hash                                        |
| Circuit breaker        | `breaker:{tenant:resource}:state` (and counters)                     | Single-slot CAS on counters + state                              |
| Fan-out barrier        | `fanout:{executionId}:*`                                             | Per-execution counter + branch keys                              |

Untagged keys (intentionally spread across slots):

- `at_active_sessions` (global SET) — recovered via SCAN, not on the hot path.
- `at_pod:<hostname>` (per-pod SET) — recovered via SCAN.
- BullMQ job keys — BullMQ handles its own routing.

### 3.2 No `KEYS pattern` in production code

Top-level `KEYS` returns partial results in cluster (it only hits the node it was sent to). The platform forbids it: use `scanKeys()` from `@agent-platform/redis`. Two backstops enforce this — the ESLint `no-restricted-syntax` rule in `.eslintrc.base.json` and the static-grep test in `packages/redis/src/__tests__/migration-completeness.static.test.ts`. If either fires, **do not bypass** — the call site is unsafe.

### 3.3 No `.duplicate()` on a Redis client

Cluster instances do not expose `.duplicate()`. The platform forbids `redis.duplicate()` / `client.duplicate()` / `redisClient.duplicate()` / `subscriber.duplicate()` — the same ESLint rule and static-grep guard cover this. Use:

- `createSubscriber(handle)` for pub/sub subscribers.
- `createBullMQPair(handle)` for BullMQ Queue + Worker pairs.
- `handle.duplicate({ maxRetriesPerRequest: null })` for a single isolated connection (e.g., a Worker recreated after error).

`handle.duplicate()` (on a `RedisConnectionHandle`, not on a `Redis` client) is cluster-aware and is the only allowed duplicate path.

### 3.4 No `multi()` for cross-slot writes

`client.multi()` requires same-slot keys in cluster mode and throws `CROSSSLOT` otherwise. For cross-slot batched writes (e.g., agent-transfer index updates across `at_active_sessions` + `at_pod:*`), use `client.pipeline()` instead. Pipeline auto-routes each command to its correct node and tolerates partial failure.

---

## 4. Failure-mode runbook

### 4.1 Master loss / forced failover

**Symptom**: `redis.cluster.failover` counter increments. ioredis follows `MOVED` redirects internally (no per-redirect counter — those responses are not surfaced as events). Per-node connection errors during the failover surface via `redis.cluster.node_error`. Brief application-side stalls of ~1–5 s while ioredis refreshes its slot cache.

**Expected behavior**:

- ioredis Cluster auto-detects via `+node` / `-node` events and refreshes its slot cache.
- Pub/sub subscribers (created via `createSubscriber(handle)`) reconnect automatically — `redis.subscriber.reconnect` increments once per affected subscriber. SLO: ≤ 30 s end-to-end recovery.
- BullMQ Workers reconnect on next heartbeat. **Caveat**: see §4.2.

**Operator action**: usually none. Watch `redis.crossslot.errors` (must remain 0) and `redis.subscriber.reconnect` (should plateau within 30 s of the failover event). If subscribers continue reconnecting > 60 s, escalate.

### 4.2 BullMQ Worker stalls after master failover (GAP-008)

**Symptom**: A BullMQ Worker stays connected but processes 0 jobs for > 30 s after a failover. `redis.subscriber.reconnect` is normal; the Worker's heartbeat is silent.

**Cause**: ioredis-cluster occasionally retains a stale connection to the failed master after promotion. The platform ships an opt-in watchdog for this case.

**Mitigation**: enable the watchdog by setting `WATCHDOG_ENABLED: 'true'` in the affected tier's values and redeploy. The watchdog forces a `client.disconnect()` + reconnect on Workers that go silent past the threshold.

The watchdog decision was recorded during SIT validation — see Phase 4 exit criteria in the implementation plan.

### 4.3 Slot resharding mid-traffic

**Symptom**: Running `CLUSTER RESHARD` or scaling masters while traffic is live. Expected p95 impact ≤ 20% during the reshard window.

**Expected behavior**: writes to migrating slots get `ASK` redirects (handled transparently by ioredis). p50 stays within 1.1× standalone; p95 within 2× standalone (see SLOs in [HLD §7](../specs/redis-dual-mode.hld.md)).

**Operator action**: schedule reshards during low-traffic windows. Capture `jemalloc` fragmentation metrics during and after the reshard. Houzz's migration retrospective reported memory fragmentation requiring rolling restarts post-reshard — if `rss/used_memory` exceeds 1.5× baseline, schedule a rolling restart of the affected masters.

### 4.4 Cluster-bus partition

**Symptom**: minority of masters become unreachable. Cluster keeps serving writes to majority slots because we run with `cluster-require-full-coverage: 'no'` (see [tier-M values §669](../../deploy/helm-values/tier-m/values.yaml)).

**Trade-off**: writes to **available** slots succeed during the partition; writes to **unavailable** slots fail. After the partition heals, **minority-side writes are silently lost** (last-writer-wins on the majority quorum). For session-state keys (agent-transfer), this can produce divergent state across pods.

**Operator action during partition**:

1. Confirm the partition via `CLUSTER NODES` from a majority-side node.
2. Do not promote minority masters manually — let the cluster's gossip-based promotion handle it.
3. Capture the affected slot range from `CLUSTER SLOTS`.
4. After heal, reconcile orphan agent-transfer sessions per §5.

### 4.5 CROSSSLOT error in logs

**Symptom**: `redis.crossslot.errors` counter > 0. Stack trace shows a Lua script error.

**This is always a code defect** — every Lua script in the platform has been audited to use a single hash slot, and the static-grep test enforces no future regression. The fix is to:

1. Identify the offending script (the error log includes the script name).
2. Inspect its `KEYS[]` array — they must share a hash tag.
3. If they don't, the script is broken in cluster mode. Either narrow the script to a single key, or move the cross-slot work outside the Lua boundary into a `pipeline()` call.

Roll back the offending release while patching.

---

## 5. Recovery-gap reconciliation (FR-9 / D-5)

### 5.1 Background

The agent-transfer Lua scripts (`LUA_CREATE_SESSION`, `LUA_END_SESSION`, `LUA_CLAIM_SESSION`, `LUA_EXTEND_TTL`) operate on per-session keys (session hash + provider index, hash-tagged on `{tenantId:contactId:channel}`). The global `at_active_sessions` SET and per-pod `at_pod:<hostname>` SET are written **outside** the Lua boundary via cluster-safe `pipeline()`. This means there is a small window between the Lua call succeeding and the index pipeline succeeding — if the runtime pod crashes between those two moments, the session exists but is not in either index. Per FR-9 this is an acceptable trade-off because:

- The session key has its own TTL and self-expires within minutes to ~1 hour.
- The indexes are advisory (used for recovery scans and pod-crash cleanup), not on the request critical path.

The runbook below is for incident response when an operator needs to force-reconcile.

### 5.2 Reconciliation snippet

Run on a runtime pod that has redis-cli configured against the cluster. **Substitute the seed node host:port for your environment.**

```bash
# 1. Enumerate every existing session key across all primaries.
#    --cluster scans every master in turn; output is one key per line.
SEED_HOST=redis-cluster.abl-data.svc
SEED_PORT=6379

redis-cli -h "$SEED_HOST" -p "$SEED_PORT" --cluster call "$SEED_HOST:$SEED_PORT" \
  --no-auth-warning SCAN 0 MATCH 'agent_transfer:*' COUNT 1000 \
  | grep -E '^agent_transfer:' \
  | sort -u > /tmp/at-keys.txt

# 2. Re-add each into the global active-sessions set. SADD is idempotent.
xargs -a /tmp/at-keys.txt -I{} \
  redis-cli -h "$SEED_HOST" -p "$SEED_PORT" SADD at_active_sessions {}

# 3. Optional: rebuild per-pod indexes by reading session hash field 'ownerPod'.
while read -r key; do
  pod=$(redis-cli -h "$SEED_HOST" -p "$SEED_PORT" HGET "$key" ownerPod)
  if [ -n "$pod" ]; then
    redis-cli -h "$SEED_HOST" -p "$SEED_PORT" SADD "at_pod:$pod" "$key"
  fi
done < /tmp/at-keys.txt
```

Run during a maintenance window or after a confirmed pod crash. Safe to repeat — every operation is idempotent.

---

## 6. Observability

### 6.1 Counters published by `@agent-platform/redis`

| Metric                          | When it increments                                          | Alert threshold                                |
| ------------------------------- | ----------------------------------------------------------- | ---------------------------------------------- |
| `redis.crossslot.errors`        | A Lua script's `KEYS[]` span multiple slots — code defect   | **> 0 in any 5 min window** — page             |
| `redis.cluster.node_error`      | ioredis Cluster `'node error'` (TCP-level per-node failure) | Sustained > 10 / s — investigate               |
| `redis.cluster.failover`        | `+node` / `-node` event from ioredis Cluster                | > 1 per hour outside maintenance — investigate |
| `redis.subscriber.reconnect`    | A `createSubscriber()` reconnects to a new master           | Sustained > 1 / min — investigate              |
| `redis.scan_keys.node_error`    | `scanKeys()` per-node SCAN failed                           | > 0 — investigate (results may be partial)     |
| `redis.bullmq.watchdog.recover` | BullMQ Worker watchdog forced a reconnect (GAP-008)         | > 0 in any 1 hr window — investigate           |

> Note: ioredis follows MOVED redirects internally and does not emit a per-redirect event, so there is no `redis.moved.redirects` counter. Slot-cache churn surfaces indirectly as request latency and `redis.cluster.node_error` spikes.

Source: `packages/redis/src/observability.ts`.

### 6.2 Dashboards / alerts

Dashboard ownership and panel layout are tracked in OQ-5 of the implementation plan. Confirm with the SRE team before a tier flip — at minimum the dashboard should plot the five counters above plus standard ioredis connection / latency panels.

### 6.3 BullMQ `getWorkers()` / `getWorkersCount()` is undercount

Cluster-mode `CLIENT LIST` only enumerates clients on the receiving node. BullMQ's `getWorkers()` and `getWorkersCount()` therefore undercount in cluster mode (BullMQ issue #3340). Any health check or operational tooling that calls these APIs must be marked as advisory in cluster mode. **Do not page on Worker-count anomalies in cluster** — use queue depth and job-throughput counters instead.

---

## 7. Capacity and architectural limits

### 7.1 Pub/sub broadcast scaling cliff

Traditional pub/sub publishes propagate to every master in the cluster (broadcast). Cost is `O(masters × message size)`. At 50 nodes with 5 KB messages, throughput drops to ~500 RPS (Redis issue #2672).

For the platform's current message sizes the inflection point is approximately **12 masters** — the upper bound of tier-XL today. If pub/sub traffic grows or message sizes increase, the next remediation is **sharded pub/sub** (`SPUBLISH` / `SSUBSCRIBE`), tracked as GAP-007 in the feature spec. Treat sharded pub/sub as operationally urgent if any of the following hold:

- tier-XL needs to scale beyond 12 masters.
- p99 publish latency exceeds 50 ms during steady state.
- pub/sub message size grows materially (e.g., > 5 KB at p99).

### 7.2 Slot count is fixed at 16,384

Cluster has 16,384 slots regardless of master count. This is fine for any plausible platform size — the practical limit is master count, not slot count.

### 7.3 Memory fragmentation post-reshard

Resharding can leave high `mem_fragmentation_ratio`. If sustained > 1.5× baseline, schedule a rolling restart of the affected masters during a maintenance window. ActiveDefrag is enabled by default in tier values (`activedefrag: 'yes'`) but does not eliminate the need for occasional rolling restarts under heavy reshard activity.

---

## 8. Open questions / outstanding items

These carry forward from the implementation plan and HLD:

1. **OQ-2** — Tier-S Sentinel direction. Decision: keep Sentinel for tier-S in current scope. Re-evaluate when tier-S workloads grow into the cluster-justifying range.
2. **OQ-5** — Dashboard ownership. Confirm with SRE before each tier flip.
3. **OQ-H-2** — Canary path SIT → tier-M direct. If the SIT result is borderline, add a 7d soak step in a pre-prod overlay before tier-M.
4. **OQ-LLD-7** — Pod-level percentage canary inside a tier. Currently not required for tier-M based on SIT outcomes; recorded as an option if Phase 4 surfaces unanticipated failure modes.

---

## 9. References

- ioredis Cluster docs: https://github.com/redis/ioredis#cluster
- BullMQ #3340 (CLIENT LIST in cluster): https://github.com/taskforcesh/bullmq/issues/3340
- Redis #2672 (pub/sub broadcast cost): https://github.com/redis/redis/issues/2672
- Houzz Redis migration retrospective: cited in implementation plan, Appendix A round-7 findings.
- Sharded pub/sub (`SPUBLISH` / `SSUBSCRIBE`): https://redis.io/docs/manual/pubsub/#sharded-pubsub

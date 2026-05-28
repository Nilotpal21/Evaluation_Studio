# Local `/api/v1/chat/agent` Datastore Baseline

This document explains what was actually measured in
[`local-chat-agent-datastore-baseline.json`](./local-chat-agent-datastore-baseline.json)
so the theoretical math is tied to a concrete request shape instead of a blind
per-turn number.

## What One Measured Session Contains

One measured session is exactly `16` sequential HTTP requests to
`POST /api/v1/chat/agent`:

1. `1` session-creation request
2. `15` follow-up turns using the same `sessionId`

The goal was to isolate local platform datastore overhead for the chat-agent
path, not external LLM latency or KB/tool variability.

## Exact Request Shape

All requests used the same local runtime and project:

- `studioUrl`: `http://localhost:5173`
- `runtimeUrl`: `http://localhost:3112`
- `projectName`: `chat-agent-qps-baseline`
- `projectId`: `019d9005-af19-7f21-9bca-2df019e8ff97`
- `agentName`: `benchmark_agent`
- `modelId`: `mock-model`
- `tenantId`: `tenant-dev-001`

Shared request characteristics:

- Authenticated local dev-login JWT
- `agentId` explicitly set to `benchmark_agent`
- No attachments
- No `deploymentId`
- No `environment`
- No `metadata`
- No tool payloads
- No KB-specific prompt content
- Mock LLM response path enabled

## Session-Creation Request

The first request intentionally had no `sessionId`, so runtime created the
session:

```json
{
  "projectId": "019d9005-af19-7f21-9bca-2df019e8ff97",
  "agentId": "benchmark_agent",
  "message": "Start the session with a short hello."
}
```

Why it costs more:

- session record creation
- initial conversation/session state writes
- first-turn runtime/session bootstrap reads
- first-turn queue and trace initialization

That is why the first-turn datastore cost is recorded separately from the
follow-up average.

## Follow-Up Turn Shape

Each of the next `15` requests reused the returned `sessionId` and changed only
the message text:

```json
{
  "projectId": "019d9005-af19-7f21-9bca-2df019e8ff97",
  "agentId": "benchmark_agent",
  "sessionId": "<same session id for all 15 follow-up turns>",
  "message": "Turn N: respond briefly."
}
```

Examples:

- `Turn 1: respond briefly.`
- `Turn 2: respond briefly.`
- ...
- `Turn 15: respond briefly.`

What this represents:

- steady-state chat turns on an already-created session
- repeated session lookup + message persistence + queue activity
- mock-model execution without external provider variance

## Observed Mongo Operation And Collection Mix

For this baseline, MongoDB was captured from `system.profile`. That lets us
break the turn down by operation family and by collection namespace.

Observed Mongo operation families:

- reads: mostly `query`
- writes: mostly `insert` and `update`
- occasional `aggregate` / `distinct` on follow-up turns at low frequency

### First Turn Mongo Breakdown

Representative first-turn Mongo read namespaces:

- `abl_platform.tenant_llm_policies x8`
- `abl_platform.project_settings x5`
- `abl_platform.dek_registry x4`
- `abl_platform.agent_model_configs x3`
- `abl_platform.llm_credentials x3`
- `abl_platform.materialized_kms_configs x3`
- `abl_platform.model_configs x3`
- `abl_platform.project_llm_configs x3`
- `abl_platform.project_settings_versions x3`
- `abl_platform.projects x3`
- `abl_platform.subscriptions x3`
- `abl_platform.tenant_kms_configs x3`
- `abl_platform.tenant_models x3`
- `abl_platform.project_runtime_configs x2`
- `abl_platform.session_states x2`
- `abl_platform.tenants x2`
- `abl_platform.environment_variables x1`
- `abl_platform.guardrail_policies x1`
- `abl_platform.project_agents x1`
- `abl_platform.resource_permissions x1`
- `abl_platform.tenant_members x1`
- `abl_platform.users x1`

Representative first-turn Mongo write namespaces:

- `abl_platform.dek_registry x3`
- `abl_platform.session_states x2`
- `abl_platform.sessions x2`
- `abl_platform.audit_logs x1`
- `abl_platform.messages x1`

Representative first-turn Mongo command mix:

- reads:
  - `query x59`
- writes:
  - `update x5`
  - `insert x4`

### Follow-Up Turn Mongo Breakdown

Average Mongo read namespaces across the `15` follow-up turns:

- `abl_platform.tenant_llm_policies x5.6`
- `abl_platform.tenant_members x3.33`
- `abl_platform.tenants x3.33`
- `abl_platform.users x3.33`
- `abl_platform.subscriptions x2.6`
- `abl_platform.sessions x2.4`
- `abl_platform.llm_credentials x2`
- `abl_platform.tenant_models x2`
- `abl_platform.projects x1.47`
- `abl_platform.session_states x1`
- `abl_platform.resource_permissions x0.13`
- `abl_platform.human_tasks x0.07`
- `abl_platform.role_definitions x0.07`
- `abl_platform.suspensions x0.07`

Average Mongo write namespaces across the `15` follow-up turns:

- `abl_platform.audit_logs x1.4`
- `abl_platform.messages x1`
- `abl_platform.session_states x1`
- `abl_platform.sessions x1`
- `abl_platform.human_tasks x0.13`

Average follow-up Mongo command mix:

- reads:
  - `query x27`
  - `aggregate x0.33`
  - `distinct x0.07`
- writes:
  - `insert x2.4`
  - `update x2.13`

Interpretation:

- Mongo reads are not only session reads. A turn also touches tenant/model/policy
  configuration, auth/membership context, and KMS/dek-related state.
- Mongo writes are relatively small compared to reads, and are dominated by
  message persistence, session/session-state updates, and audit logging.
- First-turn reads are higher because more project/model/runtime bootstrap data
  is resolved before the session is warm.

Important:

- exact namespace counts can drift slightly between runs because background
  platform work may overlap the capture window
- the namespace mix above is still useful because the same hot collections
  repeated across reruns
- these are collection-level profiler observations, not prettified
  application-level labels like "load session" or "resolve tenant model"

## Observed Redis Command Mix

Redis was captured with `MONITOR`, so we can describe the command families much
more explicitly. For clarity, `EVAL` and `EVALSHA` are kept in a separate
`scripts` bucket instead of being forced into reads or writes.

### First Turn

Representative first-turn Redis command mix:

- reads:
  - `get x13`
  - `hmget x8`
  - `hget x6`
  - `zcard x5`
  - `llen x4`
  - `zrangebyscore x4`
  - `zrange x3`
  - `hgetall x2`
  - `exists x1`
  - `lrange x1`
  - `scard x1`
  - `zrevrange x1`
- writes:
  - `expire x12`
  - `del x7`
  - `set x7`
  - `hmset x6`
  - `zadd x6`
  - `xadd x5`
  - `hincrby x4`
  - `rpoplpush x4`
  - `rpush x3`
  - `zpopmin x3`
  - `zremrangebyscore x3`
  - `bzpopmin x2`
  - `lpop x2`
  - `hset x1`
  - `incr x1`
  - `lpush x1`
  - `lrem x1`
  - `srem x1`
  - `xtrim x1`
  - `zremrangebyrank x1`
- scripts:
  - `evalsha x9`
  - `eval x2`

### Follow-Up Turn Average

Average Redis command mix across the `15` follow-up turns:

- reads:
  - `hmget x10.13`
  - `get x8`
  - `zrangebyscore x6.13`
  - `zrange x5.13`
  - `zcard x5`
  - `hget x5`
  - `llen x4`
  - `exists x1.33`
  - `hgetall x1`
  - `scard x1`
  - `zrevrange x1`
- writes:
  - `rpush x19`
  - `del x9.13`
  - `expire x9`
  - `rpoplpush x6.13`
  - `zadd x6`
  - `zpopmin x5.13`
  - `xadd x5`
  - `bzpopmin x4.13`
  - `hmset x3`
  - `set x3`
  - `zremrangebyscore x3`
  - `hincrby x3`
  - `lpop x2`
  - `hset x1`
  - `incr x1`
  - `lpush x1`
  - `lrem x1`
  - `srem x1`
  - `xtrim x1`
  - `zremrangebyrank x1`
- scripts:
  - `evalsha x11.47`
  - `eval x1`

Interpretation:

- `get`, `hmget`, `hget`, and `hgetall` represent direct key/hash lookups
- `expire`, `set`, `hmset`, and `hset` represent state refresh and cache/session
  mutation
- `rpush`, `lpop`, `rpoplpush`, `bzpopmin`, `zadd`, `zpopmin`, and
  `zremrangebyscore` reflect queue and ordered-set activity around asynchronous
  runtime work
- `xadd` and `xtrim` reflect Redis stream usage
- `eval` and `evalsha` represent Lua-backed compound operations

## Missed Paths Now Accounted For

The first Redis explanation was directionally right, but incomplete. The
write-heavy Redis profile is not coming from a single cache layer. It is the
combined effect of multiple runtime subsystems participating in one chat turn.

The main Redis-backed paths now accounted for are:

- session store state
- session conversation list maintenance
- session reverse-lookup and resolution keys
- per-session execution lock acquisition and release
- LLM BullMQ queue activity
- message-persistence BullMQ queue activity
- trace stream + pub/sub writes
- session TTL refreshes
- session-slot / concurrency guard traffic

## Why Redis Writes Are High

One logical `/api/v1/chat/agent` turn fans out into several Redis mutation paths:

- runtime session state is updated
- conversation history is appended or replaced
- multiple TTLs are refreshed
- the LLM execution is enqueued through BullMQ
- the user message is enqueued for persistence
- the assistant message is enqueued for persistence
- turn metrics are enqueued for persistence
- trace events are written to a Redis stream and published

That combination is why follow-up turns show high counts for commands like
`rpush`, `del`, `expire`, `zadd`, `zpopmin`, `rpoplpush`, `bzpopmin`, `xadd`,
and `evalsha`.

## BullMQ And Mongo Paths

BullMQ matters twice in this request path, and only one of those queues writes
Mongo directly.

### 1. LLM BullMQ Path

The LLM queue uses Redis heavily for job lifecycle and ordering, but it is not a
dedicated "Mongo writer" by itself. It exists to serialize and execute the turn.

What it contributes:

- Redis job enqueue / dequeue / completion churn
- ordered-set and list traffic typical of BullMQ
- per-session execution lock traffic

What it does not directly do:

- it does not directly batch-insert messages into Mongo

### 2. Message-Persistence BullMQ Path

The message-persistence queue does write to Mongo after the Redis queue stage.
This is the most important BullMQ-to-Mongo path for this baseline.

What the route enqueues per chat turn:

- `1` user message
- `1` assistant message
- `1` turn-metrics payload

What the worker then writes:

- message documents into `abl_platform.messages`
- session counters / last-activity / token / trace aggregates into
  `abl_platform.sessions`

That is why the Mongo write side includes `messages`, `sessions`, and related
state collections even though the request handler itself does not synchronously
write all of them inline.

## Redis Path Attribution

The dominant Redis write commands line up with the following runtime paths:

- `hmset`, `set`, `expire`, `rpush`, `del`
  session store hash/list writes, reverse lookup keys, and TTL refreshes
- `set` plus `eval` / `evalsha`
  execution locks and other Lua-backed atomic operations
- `rpush`, `zadd`, `rpoplpush`, `bzpopmin`, `zpopmin`, `zremrangebyscore`, `del`
  BullMQ internals for the LLM queue and the message-persistence queue
- `xadd`, `xtrim`
  trace stream persistence
- `publish`
  realtime trace fan-out, though this was not counted in the read/write totals

## Mongo Path Attribution

The dominant Mongo namespaces line up with the following runtime paths:

- `abl_platform.sessions`
  session lookup and post-turn session aggregate updates
- `abl_platform.session_states`
  persisted session-state / runtime state writes
- `abl_platform.messages`
  asynchronous persisted chat messages
- `abl_platform.audit_logs`
  audit side effects associated with the turn path
- `abl_platform.tenant_llm_policies`, `abl_platform.tenant_models`,
  `abl_platform.llm_credentials`, `abl_platform.model_configs`,
  `abl_platform.project_llm_configs`
  model-resolution and credential/policy reads
- `abl_platform.tenants`, `abl_platform.tenant_members`,
  `abl_platform.users`, `abl_platform.resource_permissions`
  tenant/authz context reads
- `abl_platform.dek_registry`, `abl_platform.tenant_kms_configs`,
  `abl_platform.materialized_kms_configs`
  encryption and key-resolution related reads and writes

## Why This Is Better Than A Blind Total

The raw totals alone tell you only that one follow-up turn is about
`15.73` Mongo reads, `4.13` Mongo writes, `48.4` Redis reads, `84.27` Redis
writes, and `12.6` Redis script calls.

The command mix tells you what kind of datastore pressure is being created:

- Mongo is dominated by ordinary read-side lookups plus a small number of
  inserts and updates
- Redis pressure is heavily queue/state-management oriented, not just simple
  key-value reads
- a meaningful part of Redis load is hidden inside Lua script execution, which
  matters when reasoning about CPU saturation and latency

## What The Session Did Not Include

This baseline should not be treated as the universal cost of every
`/api/v1/chat/agent` session. It intentionally excludes several expensive or
variable behaviors:

- attachments
- retrieval / KB grounding
- explicit tool execution
- multi-agent delegation/handoffs
- real provider latency and provider-specific credential resolution failures
- large prompt/context growth beyond the simple 15-turn pattern
- voice / multimodal payloads

If any of those are added, the datastore cost can move materially.

## Measurement Window

Each request window included more than raw HTTP latency:

- request start -> HTTP response
- plus `1500ms` post-response drain time
- plus `200ms` pause before the next request

This was done so async persistence and queue writes that happen immediately
after the response are still counted against the turn.

## How To Use The Numbers

Use the JSON file for the math itself:

- `firstTurn`: session-creation overhead
- `followUpAverage`: best input for steady-state turn-per-second math
- `overallAverage`: blended figure across the exact `1 + 15` scenario

Recommended math inputs:

- session creation sizing: use `firstTurn`
- steady-state chat throughput sizing: use `followUpAverage`
- mixed workload using this exact scenario shape: use `overallAverage`

## Interpretation Of Redis Scripts

Redis `EVAL` and `EVALSHA` are broken out as `scripts` instead of being forced
into read or write counts. Those scripts can perform both reads and writes
internally, so separating them makes the math clearer and avoids false
precision.

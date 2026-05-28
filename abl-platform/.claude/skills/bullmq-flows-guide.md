---
name: bullmq-flows-guide
description: Use when debugging BullMQ Flows issues, implementing PipelineFlowBuilder, troubleshooting Redis memory, or investigating flow-specific problems. Trigger on mentions of "flow stuck", "waiting-children", "FlowProducer", "lockDuration", "stalled jobs", "flow scaling", "Redis memory BullMQ", "parent job", "flow cleanup", "backpressure", or "circuit breaker for flows". Provides deep production knowledge for BullMQ Flows in SearchAI.
---

# BullMQ Flows Production Guide

> **Source of Truth:** This skill contains the canonical BullMQ Flows knowledge.
> Rules summarized in `search-ai-development`, checklists in `search-ai-architect`,
> and anti-patterns in `code-standards` are derived from this guide.
> When updating, update this file first, then propagate to others.

Deep reference for BullMQ Flows in SearchAI's distributed pipeline. For quick rules, see the BullMQ Flows section in `search-ai-development` skill. For the full document with troubleshooting runbooks, see `docs/searchai/BULLMQ-FLOWS-PRODUCTION-GUIDE.md`.

## How Flows Work Internally

BullMQ Flows use **shared queues** for all flow instances. Each document's flow creates regular jobs in shared queues, with Redis metadata tracking parent-child relationships.

```
1000 documents → 1000 flow parents in Redis
              → All create jobs in SAME "search-enrichment" queue
              → Redis tracks parent-child via parentKey
              → Workers process jobs without knowing about flows
```

**Flow lifecycle:** `FlowProducer.add(flow)` → parent created (status: `waiting-children`) → child jobs created in shared queues → worker completes child → BullMQ Lua script notifies parent → parent checks if all children done → creates next stage or completes.

**PipelineFlowBuilder:** Reads `PipelineDefinition` from MongoDB, recursively builds flow tree, maps stage types to queue names. Caller just provides pipeline + document context.

## Known Open Issues (Verified 2026-03-04)

| Issue | Title                             | Severity | Status            | Implication                           |
| ----- | --------------------------------- | -------- | ----------------- | ------------------------------------- |
| #3851 | FlowProducer.add() fails silently | CRITICAL | OPEN              | Must validate parent exists after add |
| #3761 | No flow parent deduplication      | MEDIUM   | OPEN (assigned)   | Deduplicate at application level      |
| #2610 | Worker thread memory leak         | HIGH     | OPEN (stale 21mo) | Never use `useWorkerThreads: true`    |
| #3017 | No AbortSignal for shutdown       | MEDIUM   | OPEN              | Build own graceful shutdown           |
| #632  | Can't abort running job           | MEDIUM   | OPEN (4.5 years)  | Own shutdown logic required           |
| #1099 | Duplicate flow race condition     | LOW      | OPEN (stale 4yr)  | Deduplicate via MongoDB contentHash   |

## Critical Configuration

### Flow Child Job Defaults (MANDATORY)

```typescript
const FLOW_CHILD_DEFAULTS: JobsOptions = {
  failParentOnFailure: true, // Parent waits FOREVER without this
  removeOnComplete: { age: 3600, count: 200 }, // Prevent Redis memory accumulation
  removeOnFail: { age: 86400, count: 1000 },
  attempts: 3,
  backoff: { type: 'exponential', delay: 5000 },
};
```

### Per-Worker Lock Duration

Default 30s causes stalled jobs → duplicate processing for long-running workers.

**Rule of thumb:** `lockDuration = 2× P95 job duration`. Measure via `JobExecution.metrics.durationMs` once tracking is live, then adjust.

**Starting points (adjust based on your workload):**

| Worker Category                         | Starting lockDuration | stalledInterval | Factors                     |
| --------------------------------------- | --------------------- | --------------- | --------------------------- |
| Document extraction (Docling)           | 5-10 min              | Half of lock    | Scales with page count      |
| Neo4j writes (KG, tree-building)        | 3-5 min               | Half of lock    | Scales with entity count    |
| LLM API calls (enrichment, synthesis)   | 1-3 min               | Half of lock    | Depends on provider latency |
| Batch API calls (embedding, multimodal) | 2-5 min               | Half of lock    | Depends on batch size       |
| Fast stages (all others)                | 30s-1 min             | Half of lock    | Default usually sufficient  |

### FlowProducer Validation Wrapper

One approach — adapt to your service structure:

```typescript
// Use a queue cache to avoid creating new Queue instances per call
async function safeAddFlow(
  flowProducer: FlowProducer,
  flow: FlowJob,
  queueCache: Map<string, Queue>,
): Promise<JobNode> {
  const result = await flowProducer.add(flow);

  let parentQueue = queueCache.get(flow.queueName);
  if (!parentQueue) {
    parentQueue = new Queue(flow.queueName, { connection });
    queueCache.set(flow.queueName, parentQueue);
  }

  const job = await parentQueue.getJob(result.job.id);
  if (!job) {
    throw new Error(`Flow creation failed silently for ${flow.name}`);
  }
  return result;
}
```

### Backpressure Check

Threshold depends on Redis memory, worker drain rate, and acceptable queue latency. Configure per queue:

```typescript
// Example — adapt threshold to your workload
async function checkBackpressure(
  queue: Queue,
  maxDepth = 500, // Configure based on: Redis memory, drain rate, acceptable delay
): Promise<void> {
  const waiting = await queue.getWaitingCount();
  if (waiting > maxDepth) {
    throw new BackpressureError(`Queue ${queue.name} depth ${waiting} exceeds limit ${maxDepth}`);
  }
}

// Factors for choosing threshold:
// - Redis memory: ~2KB per job → 500 jobs ≈ 1MB
// - Worker drain rate: 5 workers × 1 job/min = 5 jobs/min
// - Acceptable delay: 500 jobs / 5 drain = ~100 min queue time
```

### Circuit Breaker for Flow Failures

**Principle:** Flow creation should degrade gracefully to legacy (direct enqueue) when BullMQ Flows are failing. The fallback is `queue.add()` — workers process jobs identically, only orchestration changes.

**Use the platform circuit breaker pattern** (`packages/circuit-breaker/`) for Redis-backed distributed circuit breaking. See `docs/plans/2026-02-28-rate-limits-circuit-breakers-gap-fixes.md` for the design.

**Simple pod-local example** (each pod tracks its own failures — acceptable because all pods see the same Redis failures):

```typescript
// Pod-local circuit breaker — for distributed, use packages/circuit-breaker/
class FlowCircuitBreaker {
  private failureCount = 0;
  private lastFailure: Date | null = null;

  async executeWithFallback<T>(flowFn: () => Promise<T>, legacyFn: () => Promise<T>): Promise<T> {
    if (
      this.failureCount >= 3 &&
      this.lastFailure &&
      Date.now() - this.lastFailure.getTime() < 5 * 60 * 1000
    ) {
      return legacyFn(); // Circuit open — use legacy
    }
    try {
      const result = await flowFn();
      this.failureCount = 0;
      return result;
    } catch (error) {
      this.failureCount++;
      this.lastFailure = new Date();
      return legacyFn();
    }
  }
}
```

## Redis Constraints

- **`maxmemory-policy` MUST be `noeviction`** — any eviction corrupts BullMQ queue data
- **Redis Cluster does NOT help** — all ops for a queue serialize on same hash slot
- **Memory sizing:** 20 queues × 10K docs/day × 8 stages at ~2KB/job = ~3.2GB peak with 24h cleanup. Recommend 16GB Redis.
- **Event streams:** Set `streams: { events: { maxLen: 1000 } }` on every queue
- **Connection count:** ~66 per pod (20 queue producers + 40 worker connections + FlowProducer + events). At 10 pods = 660 connections.

## Scaling Patterns

**I/O-bound workers (LLM calls, embedding):**

- Rate limiting is per-queue global — use application-level per-tenant limiting
- Connection sharing via `getRedisConnection()` (already implemented)
- Backpressure at producer (queue depth check before add)

**CPU-intensive workers (extraction, tree-building):**

- Event loop blocking → lock expires → stalled → duplicate processing
- Use function-reference workers (current pattern is safe)
- Never `useWorkerThreads: true` (Issue #2610 memory leak)
- Increase `lockDuration` to match expected job duration

**Distributed environment:**

- Graceful shutdown: `worker.pause()` then `worker.close()` with timeout
- Kubernetes `terminationGracePeriodSeconds: 180` (match longest worker)
- PodDisruptionBudget for controlled scale-down

## Anti-Patterns

| Don't                                        | Do                                          |
| -------------------------------------------- | ------------------------------------------- |
| Flow child without `failParentOnFailure`     | Always set — parent waits forever otherwise |
| `removeOnComplete` only on parent            | Set on every child individually             |
| Default `lockDuration` (30s) for Docling/LLM | Per-worker lock matching expected duration  |
| `useWorkerThreads: true`                     | Function reference or child process         |
| Trust `FlowProducer.add()` return            | Verify parent job exists after add          |
| BullMQ limiter for per-tenant rates          | Application-level rate limiting             |
| Redis Cluster for BullMQ performance         | Single large Redis instance                 |
| No backpressure on producers                 | Check queue depth before adding flows       |
| Hardcoded flow tree structure                | PipelineFlowBuilder from PipelineDefinition |
| Large payloads in job.data                   | Store in MongoDB, pass IDs                  |

## Troubleshooting Quick Reference

**Flow parents stuck in `waiting-children`:**

1. Check if children failed without `failParentOnFailure`
2. Check BullMQ version >= 5.7.2 (stall notification fix)
3. Verify `lockDuration` sufficient for worker type
4. Manual fix: `await job.moveToFailed(new Error('manual'), 'manual')`

**Redis memory growing unboundedly:**

1. Verify `removeOnComplete`/`removeOnFail` on ALL child jobs
2. Trim event streams: `await queue.trimEvents(1000)`
3. Check `bull:*:processed` key accumulation
4. Monitor with `redis-cli --bigkeys`

**Jobs processing twice (stalled):**

1. Increase `lockDuration` for affected worker
2. Reduce concurrency if CPU-bound
3. Add idempotency check (MongoDB `contentHash`)

**FlowProducer.add() returns but no jobs exist:**

1. Check Redis READONLY mode (`redis-cli INFO replication`)
2. Implement validation wrapper (see above)
3. Check managed Redis maintenance windows

## File References

| File                                                                  | Purpose                                            |
| --------------------------------------------------------------------- | -------------------------------------------------- |
| `docs/searchai/BULLMQ-FLOWS-PRODUCTION-GUIDE.md`                      | Full production guide with verified issue tracking |
| `docs/searchai/rfcs/RFC-005-Job-Tracking-Architecture.md`             | Flat schema design for job tracking                |
| `docs/searchai/rfcs/RFC-006-Job-Tracking-BullMQ-Flows-Integration.md` | Flow integration with 3 optional fields            |
| `apps/search-ai/src/workers/shared.ts`                                | Redis connection, worker options                   |
| `apps/search-ai/src/workers/index.ts`                                 | Worker initialization, concurrency                 |
| `apps/search-ai/src/queues/index.ts`                                  | Queue creation                                     |
| `packages/search-ai-sdk/src/constants.ts`                             | Queue name constants                               |

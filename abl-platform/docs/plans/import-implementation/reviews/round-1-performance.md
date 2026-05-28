# Round 1 Review: Performance & Operability

**Reviewer:** Auditor 3 — Performance & Operability
**Date:** 2026-03-15
**Scope:** Sections 1-5 of the import implementation plan
**Cross-referenced:** `staged-importer.ts`, `project-io.ts`, `docker-compose.yml`, SearchAI worker patterns, BullMQ usage across the platform

---

## Critical Performance Issues (Must Fix)

### [PERF-1] Cross-Reference Resolution Causes N+1 Query Explosion — Severity: HIGH

- **Location:** Section 3.12 (Two-Pass Cross-Reference Resolution)
- **Scenario:** After staging, the cross-reference resolver must query staged records to build name-to-newId maps for 5 anchor collections (workflows, search_indexes, channel_connections, eval_scenarios, eval_personas). Each anchor collection requires at least one query. Then every referring record must be updated individually.
- **Impact:** For a max-size import with 200 workflows + versions, 100 search indexes + sources + knowledge bases, 50 channels + webhooks, and 500 eval scenarios/personas, the cross-ref pass generates approximately:
  - 5 anchor queries to build maps
  - 200 workflow version updates (workflowId)
  - 100+ search source/KB updates (indexId, searchIndexId)
  - 50+ webhook subscription updates (channelConnectionId)
  - 500+ eval set updates (scenarioIds, personaIds arrays)
  - **Total: ~850+ individual update operations** after staging is "complete"
- **Suggested fix:** Batch the cross-reference updates. Instead of updating each record individually, group updates by collection and issue a single `bulkWrite` with `updateOne` operations per collection. The plan describes the algorithm conceptually but does not specify batching — the naive implementation will be sequential `updateOne` calls. Add an explicit `bulkWrite` step in the resolver: collect all updates per collection, then execute one `bulkWrite` per collection with `{ ordered: false }`. This collapses ~850 operations into ~5-8 `bulkWrite` calls.

### [PERF-2] 50MB Decompressed File Map Held in Memory for Entire Import Duration — Severity: HIGH

- **Location:** Section 5, Section 3.2 (Streaming File Processing)
- **Scenario:** The plan stores compressed files in MongoDB (ImportFileStore), then decompresses the full Map<string, string> at the start of the worker job (step 6). This decompressed map stays in memory while each layer is processed sequentially. With 3 concurrent imports at concurrency=3, peak memory is 3 x 50MB = 150MB just for raw file content, before any parsed objects.
- **Impact:** The plan claims a 150MB per-import memory budget (Section 5, 3.4), but 50MB is consumed by the raw file map alone. Parsed JSON objects typically expand 2-3x versus their string representation. A single vocabulary layer with 10,000 entries at 200 bytes each (2MB strings) becomes ~5MB parsed objects. Combined with the file map, a single import easily exceeds 80MB. Three concurrent imports will push a pod well above 450MB heap, likely triggering OOM on pods with typical 512MB-1GB limits.
- **Suggested fix:**
  1. After decompression, partition the file map by layer prefix and discard the full map immediately. Process layer file subsets one at a time.
  2. Alternatively, store files per-layer in ImportFileStore (8 separate compressed chunks) so only one layer's files need to be in memory at a time.
  3. Reduce default `IMPORT_V2_WORKER_CONCURRENCY` from 3 to 2, and document the minimum pod memory requirement (at least 1GB heap for the runtime pod when import is enabled).

### [PERF-3] Activation Phase Sequential Per-Layer bulkWrite Without Unordered Mode — Severity: HIGH

- **Location:** `staged-importer.ts` lines 355-409, Section 1 activation order
- **Scenario:** The `activate` method iterates layers in ACTIVATION_ORDER and, within each layer, iterates all collections calling `this.db.activateLayer(collection, staged, superseded)` sequentially. For 8 layers spanning ~20 collections with potentially thousands of records, each bulkWrite is sequential and presumably ordered (the plan does not specify `{ ordered: false }`).
- **Impact:** Ordered bulkWrite short-circuits on first error, which is correct for activation integrity. However, the staged-to-active and old-to-superseded status updates within a single collection are independent operations. With 1000 agents being activated, an ordered bulkWrite of 2000 update operations (1000 staged->active + 1000 old->superseded) will take significantly longer than unordered. Worst case for max entities across all layers: ~13,000 update operations sequentially.
- **Suggested fix:** Use `{ ordered: false }` for the activation bulkWrite since the two sets of updates (staged->active, old->superseded) are independent within a single collection. If one fails, the entire layer rolls back regardless. Document this in the `ImportDbAdapter.activateLayer` contract. Estimate: 2-3x speedup on the activation phase.

### [PERF-4] ImportFileStore 50MB BSON Documents Exceed MongoDB 16MB Limit — Severity: CRITICAL

- **Location:** Section 5, 1.3 (File Storage Strategy)
- **Scenario:** The plan states files are compressed with gzip achieving "5-10x compression on JSON/YAML text, yielding ~5-10MB BSON documents." However, this is optimistic. DSL content (ABL files) and complex JSON with unique field values compress at 3-4x, not 5-10x. A 50MB import payload would compress to ~12-17MB. MongoDB's maximum BSON document size is 16MB.
- **Impact:** Imports in the 40-50MB range will fail at the storage step with a `BSONObjectTooLarge` error. The plan's own MAX_IMPORT_TOTAL_SIZE is 50MB, which directly conflicts with the 16MB BSON limit.
- **Suggested fix:** Use GridFS for ImportFileStore instead of a single BSON document, OR chunk the compressed data into multiple documents (e.g., 8MB chunks), OR reduce MAX_IMPORT_TOTAL_SIZE to 30MB (which after compression at worst-case 2x would be ~15MB, under the limit). GridFS is the cleanest solution and already supported by Mongoose. Alternatively, store per-layer compressed chunks as separate documents.

---

## Scalability Concerns

### [SCALE-1] Single Queue for All Tenants Creates Head-of-Line Blocking

- **Location:** Section 5, 1.1
- **Description:** All v2 imports use a single BullMQ queue `import-v2` with concurrency=3. If Tenant A submits 5 large imports and Tenant B submits 1 small import, Tenant B's import waits behind Tenant A's queue despite having different resource isolation. The per-tenant limit is checked at enqueue time (max 2 active + 5 queued per tenant), but BullMQ processes in FIFO order within a priority level.
- **Impact:** A noisy tenant can consume all 3 worker slots for 10+ minutes, starving other tenants.
- **Suggested fix:** Consider using BullMQ's rate limiter feature (`limiter: { max: 2, duration: 600000 }`) scoped per tenant via job groups, OR use separate priority levels per tenant tier, OR document this as a known limitation with a mitigation plan for scaling to dedicated worker pods per tenant tier.

### [SCALE-2] findActiveRecordIds Queries Scale Linearly with Entity Types

- **Location:** Section 1 orchestrator, Section 3 disassemblers
- **Description:** Before disassembly, the orchestrator must call `ImportDbAdapter.findActiveRecordIds()` for every collection in every layer to populate `existingRecordIds` in the `DisassembleContext`. For 8 layers spanning ~20 collections, this is 20+ queries before any import work begins. Each query filters by `{ projectId, tenantId, status: 'active' }` and returns all matching IDs.
- **Impact:** For a project with 1000 agents + 500 tools + thousands of eval scenarios, these queries return large result sets. The plan does not specify whether these queries use `.lean()` or project only `{ _id: 1, name: 1 }`. Without projection, they load full documents, wasting memory and time.
- **Suggested fix:**
  1. Confirm all `findActiveRecordIds` queries project only `{ _id: 1, [matchField]: 1 }`.
  2. Parallelize these queries with `Promise.all` grouped by wave (dependencies first, then independent layers in parallel).
  3. Ensure compound indexes exist: `{ projectId: 1, tenantId: 1, status: 1, name: 1 }` for each relevant collection.

### [SCALE-3] Horizontal Scaling — Worker on Runtime Pod vs Dedicated Worker

- **Location:** Section 5, 1.5 and 1.6
- **Description:** The plan places the import worker inside the runtime process (it references existing BullMQ patterns in `apps/runtime/src/services/queues/`). Import operations are memory-intensive and can run for 10 minutes. Running the import worker on the same pod as the runtime (which serves live API traffic) creates resource contention.
- **Impact:** A large import consuming 150MB+ of heap on the runtime pod will increase GC pause times, potentially causing latency spikes for live API requests. The `INTER_BATCH_DELAY_MS = 10` helps but does not prevent heap pressure from large objects.
- **Suggested fix:** Either (a) document the memory overhead and require runtime pods to be sized accordingly (minimum 1.5GB heap when import is enabled), or (b) design the worker as a separate deployable unit (like search-ai workers) that can be scaled independently. The existing SearchAI architecture (`apps/search-ai/src/workers/`) already demonstrates this pattern. At minimum, add a feature flag `IMPORT_V2_WORKER_ENABLED` defaulting to `false` so operators can selectively enable import workers on specific pods.

---

## Operational Risks

### [OPS-1] BullMQ Job Retry After Activation Failure Causes Duplicate Staging

- **Location:** Section 5, 5.1 and 5.3
- **Description:** The plan sets `attempts: 2` with exponential backoff. However, the retry policy table says activation is NOT retryable because it's not idempotent. If the job fails during activation, BullMQ will retry the entire job from the beginning. The retry will attempt to re-stage records that may already exist (from the first attempt's staging phase). The staging phase does not check for pre-existing staged records from a prior attempt.
- **Impact:** Duplicate staged records in the database, potential unique constraint violations, and a corrupted import state. The `StagedImporter.stage()` cleanup only runs on staging failure — if staging succeeded on attempt 1 but activation failed, attempt 2's staging will insert duplicates.
- **Suggested fix:** Either (a) set `attempts: 1` (no retry) and rely on the DLQ for manual recovery, or (b) make the worker idempotent by checking for existing staged records at the start of each attempt and resuming from the correct phase, or (c) track the current phase in `ImportOperationState` and skip completed phases on retry. Option (c) is the most robust and aligns with the existing state machine.

### [OPS-2] Redis Lock TTL (10 min) Matches Job Timeout (10 min) — No Buffer

- **Location:** Section 5, 1.6 and 4.3
- **Description:** The per-project distributed lock has a TTL of 600,000ms (10 minutes), and the BullMQ job timeout is also 600,000ms (10 minutes). If a job runs close to the timeout limit, the lock expires at the same time the job is being killed. During the brief window between lock expiry and job termination, another import for the same project could acquire the lock and start, leading to two concurrent imports for the same project.
- **Impact:** Concurrent imports for the same project cause data corruption — both will stage records and attempt activation, resulting in duplicate or conflicting state transitions.
- **Suggested fix:** Set the lock TTL to at least 1.5x the job timeout: `ttlMs: 900_000` (15 minutes). Alternatively, refresh the lock periodically during long-running imports using a heartbeat (call `lockManager.extend()` every 2 minutes).

### [OPS-3] v1 and v2 Import Locks Are Independent — Concurrent v1+v2 Possible

- **Location:** Section 5, 4.3
- **Description:** The plan explicitly uses a separate lock key prefix (`import-v2-lock`) from the existing v1 lock (`import:lock:{projectId}`). During the migration period, a user could initiate a v1 import and a v2 import simultaneously for the same project, since neither checks the other's lock.
- **Impact:** Both imports write to the same collections (e.g., `project_agents`, `project_tools`). The v2 staged import and v1 direct write would race, leaving the project in an inconsistent state.
- **Suggested fix:** During the migration period, the v2 worker should also check for (and respect) the v1 lock. Add a guard: `if (await redis.exists('import:lock:' + projectId)) throw new Error('v1 import in progress')`. Remove this after v1 is fully deprecated. Alternatively, have v2 acquire BOTH locks.

### [OPS-4] ImportOperationState TTL of 1 Hour May Delete Active Operations

- **Location:** Section 5, 2.1 and staged-importer.ts line 31
- **Description:** `IMPORT_OPERATION_TTL_MS = 60 * 60 * 1000` (1 hour). The `expiresAt` is set at operation creation time. But a max-size import can be queued for up to 10+ minutes (if other imports are in progress) plus take 10 minutes to execute. If the queue is backed up, the operation record could expire via MongoDB TTL index before the worker even picks it up.
- **Impact:** The worker picks up a BullMQ job but the ImportOperationState document has been TTL-deleted. The worker cannot update progress or state, causing silent failure.
- **Suggested fix:** Either (a) set `expiresAt` to 2 hours instead of 1, or (b) refresh `expiresAt` when the worker starts processing (extend by another hour), or (c) compute `expiresAt` as `enqueuedAt + MAX_QUEUE_WAIT + MAX_JOB_DURATION + buffer = now + 30min + 10min + 20min = now + 60min`. Option (b) is the most resilient.

### [OPS-5] No Feature Flag for Gradual v2 Rollout

- **Location:** All sections
- **Description:** The plan does not mention a feature flag to enable/disable v2 import. There is no canary strategy described — it is assumed v2 is deployed and immediately active.
- **Impact:** If v2 has a critical bug in production, the only rollback option is a code deploy reverting to v1. There is no way to disable v2 per-tenant or per-environment without a deploy.
- **Suggested fix:** Add an `IMPORT_V2_ENABLED` feature flag (environment variable or tenant-level config). When disabled, the v2 route returns `501 Not Implemented` and all imports use the v1 path. Add a tenant-level override `tenant.features.importV2: boolean` for per-tenant rollout.

---

## Missing Monitoring

### [MON-1] No Metric for Cross-Reference Resolution Duration

- **Description:** Section 5, 6.3 lists metrics for phase/layer durations but does not include a metric for the cross-reference resolution pass. This pass queries staged records and performs bulk updates — a potentially expensive operation that occurs between staging and activation.
- **Impact:** If cross-ref resolution becomes a bottleneck (e.g., due to missing indexes on staged record queries), operators cannot identify it from metrics.
- **Suggested fix:** Add `import_v2_crossref_duration_ms` histogram with labels `{ collection, tenant_id }`.

### [MON-2] No Metric for ImportFileStore Compression Ratio

- **Description:** The plan assumes 5-10x compression but provides no metric to validate this assumption in production.
- **Impact:** If actual compression ratios are lower than expected, the 16MB BSON limit (see PERF-4) will be hit more frequently, and operators will not have data to adjust MAX_IMPORT_TOTAL_SIZE.
- **Suggested fix:** Add `import_v2_compression_ratio` gauge with labels `{ tenant_id }`, calculated as `originalSizeBytes / compressedSizeBytes`.

### [MON-3] No Metric Distinguishing Queue Wait Time from Processing Time

- **Description:** `import_v2_duration_ms` tracks phase/layer durations but there is no metric for the time a job spends waiting in the BullMQ queue before being picked up.
- **Impact:** Operators cannot distinguish between "imports are slow because of processing" and "imports are slow because the queue is backed up." Both appear as high end-to-end latency.
- **Suggested fix:** Add `import_v2_queue_wait_ms` histogram, calculated as `job.processedOn - job.timestamp` (BullMQ provides both). This is standard practice for queue-based systems.

### [MON-4] No Health Check Endpoint for Import Worker

- **Description:** The plan does not describe a health check for the import worker. If the worker crashes or becomes unresponsive, there is no proactive detection beyond the stale import checker (which runs every 5 minutes with a 15-minute threshold).
- **Impact:** Up to 20 minutes before a dead worker is detected (5-minute check interval + 15-minute staleness threshold). During this time, imports queue up silently.
- **Suggested fix:** Add a `/health/import-worker` endpoint that checks: (a) the BullMQ worker is connected, (b) the last job was processed within the last N minutes, (c) Redis connection is healthy. Wire this into the existing pod health checks.

### [MON-5] No SLO Definition for Import Duration

- **Description:** The alert conditions (Section 5, 6.5) include a p99 > 5min warning, but there is no SLO definition. Without an SLO, operators cannot measure whether the import system is meeting its reliability targets.
- **Suggested fix:** Define SLOs: e.g., "95% of imports with <= 100 entities complete within 60 seconds" and "99% of imports complete within 5 minutes regardless of size." Use these to drive alert thresholds rather than arbitrary numbers.

---

## Timeout & Deadline Analysis

### [TIME-1] Phase Timeouts Sum Exceeds Job Timeout

- **Location:** Section 5, 5.2
- **Description:** Per-phase timeouts: validation (30s) + staging per layer (120s x 8 layers = 960s) + activation per layer (60s x 8 layers = 480s) + cleanup (60s) = **1530 seconds (25.5 minutes)**. The job timeout is 600 seconds (10 minutes). The per-phase timeouts are meaningless because the job will be killed by BullMQ long before all phases could exhaust their individual timeouts.
- **Impact:** Misleading timeout configuration. The stated phase timeouts suggest the system can handle 25 minutes of work, but the job will be terminated at 10 minutes.
- **Suggested fix:** Either (a) increase the job timeout to 30 minutes (matching the sum of phase timeouts), or (b) reduce per-layer staging timeout to 60 seconds (60s x 8 = 480s total staging, + 30s validation + 480s activation + 60s cleanup = 1050s = 17.5 minutes, still exceeding 10 minutes), or (c) accept 10 minutes as the hard ceiling and reduce per-phase timeouts accordingly: validation 15s, staging 45s/layer, activation 30s/layer, cleanup 30s. Sum: 15 + 360 + 240 + 30 = 645s, which fits in 10 minutes with minimal buffer.

### [TIME-2] No Gateway/Load Balancer Timeout Consideration for Initial POST

- **Location:** Section 5, 1.4
- **Description:** The initial `POST /import/v2` accepts a 50MB payload, stores it in MongoDB, creates the ImportOperationState, enqueues a BullMQ job, and returns 202. The plan estimates this at "fast — ~100ms" but does not account for: (a) the time to compress and store a 50MB payload in MongoDB, (b) nginx/ingress default timeouts (typically 60s), (c) client-side request timeouts.
- **Impact:** Storing a 50MB payload with gzip compression + MongoDB write could take 2-5 seconds. This is within typical gateway timeouts, but the plan should explicitly state expected latency and verify it against infrastructure config.
- **Suggested fix:** Add a latency budget for the synchronous portion: payload validation (50ms) + gzip compression (500-1500ms for 50MB) + MongoDB write (200-500ms for 5-10MB compressed) + BullMQ enqueue (50ms) = ~1-2.5 seconds total. Document this and verify that nginx `proxy_read_timeout` exceeds this budget.

---

## Resource Contention

### [CONTENTION-1] Import Writes Compete with Runtime Reads on Shared MongoDB

- **Location:** Section 5, 4.6
- **Description:** The plan uses `writeConcern: { w: 1 }` for staging and `writeConcern: { w: 'majority' }` for activation. During activation, bulk writes with `w: 'majority'` on many collections simultaneously will increase write latency on the replica set. Live runtime queries (e.g., agent resolution, tool lookup) read from the same replica set.
- **Impact:** During a large import's activation phase, read latency for live agent executions may spike by 50-200ms. For a platform serving real-time conversation AI, this is noticeable.
- **Suggested fix:**
  1. Use `readPreference: 'secondaryPreferred'` for non-critical reads during import (the plan already has this as a platform principle).
  2. Add the `INTER_BATCH_DELAY_MS` to activation as well (not just staging). Currently, the 10ms delay is mentioned only for staging.
  3. Consider adding a configurable `ACTIVATION_INTER_BATCH_DELAY_MS` (default 20ms) to reduce burst write pressure during activation.

### [CONTENTION-2] Redis pub/sub Progress Spam for Large Imports

- **Location:** Section 5, 2.2 and 3.3
- **Description:** Progress updates are published via Redis pub/sub after each batch during staging. With a batch size of 100 and 13,000 entities across 8 layers, that is ~130 Redis PUBLISH commands. Each publish is a broadcast to all subscribed clients.
- **Impact:** Minimal for a single import, but with 3 concurrent imports each publishing progress, the pub/sub channel receives ~390 messages in a short time. If multiple Studio clients are subscribed (e.g., team watching the import), each message is fanned out.
- **Suggested fix:** Throttle progress updates to at most 1 per second per import. Use a simple debounce: only publish if more than 1000ms have elapsed since the last publish for this operationId. This reduces 130 publishes to approximately 1 per second of processing time.

### [CONTENTION-3] No Connection Pool Limit Documentation

- **Location:** Section 5
- **Description:** Each concurrent import opens MongoDB connections for staging, activation, state updates, and cross-reference queries. The plan does not specify how many MongoDB connections an import uses or whether connections are shared via a pool.
- **Impact:** With 3 concurrent imports, if each uses 5+ connections, the import worker alone consumes 15+ connections from the pool. Runtime's default Mongoose pool size is typically 5-10. This could exhaust the pool, causing connection timeout errors for live traffic.
- **Suggested fix:** Document the expected connection usage per import and ensure the runtime's Mongoose pool size accounts for import worker concurrency. Recommendation: `poolSize >= 5 (base) + 3 (per concurrent import) * concurrency = 5 + 9 = 14` minimum.

---

## Failure Modes & Recovery

### [FAIL-1] Pod Crash During Activation Leaves Half-Activated State

- **Description:** If the pod crashes after activating layers 1-4 (connections, core, search, workflows) but before activating layers 5-8 (guardrails, evals, channels, vocabulary), the project is in a mixed state: some layers have new data (active), some have old data (still active). The import operation is stuck in 'activating' status. The stale import detector will mark it as 'failed' after 15 minutes, but the partial activation is not rolled back.
- **Impact:** The project has inconsistent data. New agents reference new connections (correct), but old guardrails reference old agents that may be superseded (incorrect). This is a data integrity issue.
- **Suggested fix:** The stale import detector should attempt rollback for operations stuck in 'activating' status, not just mark them as 'failed'. Extend the cleanup job to: (a) identify operations in 'activating' with `activatedLayers` partially populated, (b) call `StagedImporter.rollback()` for the activated layers, (c) then mark as 'failed'. This requires the `stagedRecordIds` and `supersededRecordIds` to be persisted in ImportOperationState (which they are, per Section 5, 2.1).

### [FAIL-2] Redis Crash During Lock Hold — Lock Expiry Correct but State Inconsistent

- **Description:** If Redis crashes while a lock is held, the lock data is lost. On Redis restart, no lock exists, so another import can start. But the original import worker is still running (it only checks the lock at acquisition, not periodically).
- **Impact:** Two concurrent imports for the same project, with potential data corruption.
- **Suggested fix:** Add a lock heartbeat: the worker refreshes the lock TTL every 2 minutes via `lockManager.extend()`. If the extend fails (Redis was restarted, lock was lost), the worker should abort the current import gracefully rather than continuing without a lock.

### [FAIL-3] Cleanup Job Cascading Deletes — No Limit on Batch Size

- **Location:** Section 5, 8.2
- **Description:** The cleanup job queries orphaned/stale records with `.limit(100)` for files and `.limit(50)` for operations, but each operation's `stagedRecordIds` could contain thousands of IDs. The cleanup iterates all IDs and deletes them. For 50 stale operations x 1000 records each = 50,000 delete operations in a single cleanup run.
- **Impact:** The 15-minute cleanup job could take several minutes, during which it generates significant MongoDB write load. If it runs concurrently with an active import, write contention is amplified.
- **Suggested fix:** Cap the total deletions per cleanup run (e.g., 5000 records). If more remain, let the next run pick them up. Add a `import_v2_cleanup_duration_ms` metric to track cleanup job performance.

---

## Positive Design Choices

1. **File storage in MongoDB with compression** (Section 5, 1.3): Avoiding large Redis job payloads is the right call. The 512KB practical limit for Redis job data is well-documented and the plan correctly routes file content through MongoDB.

2. **Per-project lock + per-tenant concurrency limit** (Section 5, 4.2-4.3): The two-level locking (project mutual exclusion + tenant concurrency cap) is a sound design that prevents both intra-project conflicts and noisy-tenant abuse.

3. **Layered phase model with rollback** (staged-importer.ts): The stage->activate->cleanup phase model with per-layer rollback is a proven pattern for atomic multi-collection updates without distributed transactions. The existing implementation in `staged-importer.ts` is clean and well-tested.

4. **Circuit breakers for MongoDB** (Section 5, 7.2): Wrapping import DB operations in the existing `RedisCircuitBreaker` prevents cascading failures when MongoDB is degraded. The tuning parameters (15 failures, 40% rate) are appropriate for a high-operation-count workload.

5. **BullMQ DLQ pattern** (Section 5, 5.5): Dead letter queue with admin endpoints for inspection and re-enqueue is an excellent operational practice. The 30-day retention for DLQ jobs gives operators ample time to investigate.

6. **Two-wave disassembly respecting dependencies** (Section 1, 2.5): Processing connections before core, and core before downstream layers, prevents dangling references during import. The wave-3 parallelization for independent layers (guardrails, evals, channels, vocabulary) is a good optimization.

7. **Comprehensive observability spec** (Section 5, 6.1-6.5): The metrics table, dashboard design, and alert conditions are unusually thorough for a design doc. The structured logging with phase transitions, layer completions, and error context will make debugging straightforward.

8. **Stale import detection** (Section 5, 5.4): The scheduled cleanup that detects orphaned imports is a necessary safety net for worker crashes and job loss scenarios.

9. **Import-specific rate limit** (Section 5, 4.5): Separating import rate limits from general API rate limits prevents import traffic from consuming the general API quota.

10. **MongoDB write concern differentiation** (Section 5, 4.6): Using `w: 1` for staging (recoverable from ImportFileStore) and `w: 'majority'` for activation (must be durable) is the correct trade-off between speed and data safety.

---

## Database Load Analysis: Worst-Case Numbers

For the specified max-size import (1000 agents, 500 tools, 200 connections, 100 guardrails, 200 workflows, 500 eval scenarios, 100 search indexes, 50 channels, 10000 vocabulary entries):

| Phase                | Operation                     | Estimated DB Ops           | Notes                                        |
| -------------------- | ----------------------------- | -------------------------- | -------------------------------------------- |
| Pre-import queries   | findActiveRecordIds (20 coll) | ~20 queries                | Should be parallelized                       |
| Staging              | insertMany (batches of 100)   | ~127 insertMany            | 12,650 entities / 100 = 127 batches          |
| Cross-ref resolution | Query anchors + bulkWrite     | ~10 queries + 8 bulkWrites | If batched properly (see PERF-1)             |
| Activation           | bulkWrite per collection      | ~20 bulkWrites             | One per collection, ~25,300 update ops total |
| Cleanup              | deleteMany                    | ~20 deleteMany             | Async, bounded by superseded record count    |
| State updates        | updateOne per phase/layer     | ~25 updateOne              | ImportOperationState tracking                |
| **Total**            |                               | **~230 DB round trips**    | Plus ~38,000 individual document operations  |

This is manageable for MongoDB, but the 38,000 document operations during activation will take approximately 30-60 seconds at typical latency. The 1-minute per-layer activation timeout (Section 5, 5.2) is tight if a single layer has thousands of entities (e.g., vocabulary with 10,000 entries).

---

## Verdict

**PASS WITH CONDITIONS**

The plan demonstrates strong architectural choices: async BullMQ processing, staged import with rollback, circuit breakers, comprehensive observability, and layered rate limiting. These are the right patterns for a production-grade import system.

However, four issues must be resolved before implementation:

1. **PERF-4 (CRITICAL):** The 50MB payload in a single BSON document exceeds MongoDB's 16MB limit. This is a blocking architectural issue that must be resolved (GridFS or chunked storage).
2. **OPS-1 (HIGH):** BullMQ retry after activation failure will cause duplicate staging. Either disable retries or make the worker resume-aware.
3. **PERF-1 (HIGH):** Cross-reference resolution must use batched bulkWrite, not individual updates. Without this, large imports will be unacceptably slow.
4. **OPS-2 (HIGH):** Lock TTL must exceed job timeout to prevent concurrent import races.

The remaining issues (PERF-2, PERF-3, SCALE-1 through SCALE-3, OPS-3 through OPS-5, TIME-1, TIME-2, CONTENTION-1 through CONTENTION-3, FAIL-1 through FAIL-3, MON-1 through MON-5) are important but can be addressed during implementation as refinements. They should be tracked as follow-up tasks with the implementation tickets.

# Follow-ups — workflow-execution-event-sourcing

Pre-existing defects and scoped-out items surfaced during ABLP-2 implementation. Not blockers for the feature itself.

---

## FU-1: `system-human-task-store.test.ts` — string vs string[] `assignedTo` mismatch

**Status**: OPEN — needs Jira ticket in ABLP

**File**: `apps/workflow-engine/src/__tests__/system-human-task-store.test.ts`

**Failing sites**:

- Line 91: `createTask({ ..., assignedTo: 'bob' })` — `CreateHumanTaskParams.assignedTo` is typed `string[]`
- Line 95: `expect(doc.assignedTo).toBe('bob')` — asserts string when persisted value is an array
- Line 217: `updateTaskStatus(..., { claimedBy: 'bob', assignedTo: 'bob' })` — extra-param `assignedTo` is also typed `string[]`
- Line 221: `expect(updated!.assignedTo).toBe('bob')` — same string/array assertion mismatch

**Production type** (`apps/workflow-engine/src/persistence/human-task-store.ts:38-39`):

```ts
/** Empty / undefined = open pool; [u] = direct; [u1, u2, ...] = scoped pool. */
assignedTo?: string[];
```

Array is the canonical shape — the test is wrong, not the production type.

**Root cause**: Confirmed pre-existing via git stash/compare during ABLP-2 Phase 3 work (workflow-execution-event-sourcing). The tests were authored in `ec080b6cee` and the ABLP-2 refactor at `2b73eb2b26` touched the file for the `projectId` gap fix but did not surface this orthogonal defect. Not introduced by ABLP-2.

**Fix**:

1. Line 91: `assignedTo: 'bob'` → `assignedTo: ['bob']`
2. Line 95: `.toBe('bob')` → `.toEqual(['bob'])`
3. Line 217: `assignedTo: 'bob'` → `assignedTo: ['bob']`
4. Line 221: `.toBe('bob')` → `.toEqual(['bob'])`

No production-code change required.

**Verification**:

```bash
pnpm --filter=@agent-platform/workflow-engine test --run src/__tests__/system-human-task-store.test.ts
```

**Ready-to-file ticket** (paste into a shell with `JIRA_BASE_URL`/`JIRA_EMAIL`/`JIRA_API_TOKEN` set):

```bash
pnpm jira:create -- \
  --type Bug \
  --labels "workflow-engine,test-debt,tech-debt" \
  --summary "test(workflow-engine): fix string/string[] assignedTo mismatch in system-human-task-store.test.ts" \
  --description "$(cat <<'EOF'
Two pre-existing tests in apps/workflow-engine/src/__tests__/system-human-task-store.test.ts fail because they pass assignedTo: 'bob' (string), but the production type is string[] (CreateHumanTaskParams.assignedTo?: string[] at apps/workflow-engine/src/persistence/human-task-store.ts:39).

Failing sites:
- Line 91: createTask({ ..., assignedTo: 'bob' }) — type error
- Line 217: updateTaskStatus(..., { claimedBy: 'bob', assignedTo: 'bob' }) — extra-param type

Line 38 documents the intended semantic: "Empty/undefined = open pool; [u] = direct; [u1, u2, ...] = scoped pool" — array is the canonical shape.

Confirmed pre-existing via git stash/compare during ABLP-2 Phase 3 (workflow-execution-event-sourcing). Not introduced by ABLP-2. Scoped out of Phase 3; tracking here.

Fix: update both call-sites to pass ['bob'] and change assertions (expect(doc.assignedTo).toBe('bob') → toEqual(['bob'])). No production code change required.

Verify: pnpm --filter=@agent-platform/workflow-engine test --run src/__tests__/system-human-task-store.test.ts

Context: docs/sdlc-logs/workflow-execution-event-sourcing/implementation.log.md
EOF
)"
```

---

## FU-2: Outbox poller — no poison-pill cap on `retryCount` (MEDIUM)

**Status**: OPEN — needs Jira ticket in ABLP

**File**: `apps/workflow-engine/src/outbox/outbox-poller.ts:202-206`

**Source**: pr-reviewer Round 5 (production readiness). VERDICT was APPROVED; explicitly called "non-blocking for merge, recommended for a follow-up hardening ticket."

**Problem**: `drain()` selects `{ publishedAt: null }` with no upper bound on `retryCount`. A persistent per-row failure (malformed payload, topic ACL mismatch for a specific partition key) keeps the row in the same first slot of every batch forever — `retryCount` is incremented but never checked. Wastes cycles and floods logs under degraded Kafka operation.

**Fix**:

1. Introduce `MAX_OUTBOX_RETRY_COUNT` (e.g., `50`) in the config block alongside `DEFAULT_BATCH_SIZE`.
2. Add `retryCount: { $lt: MAX_OUTBOX_RETRY_COUNT }` to the `find` filter on line 203.
3. On the failure bookkeeping path, if the post-increment `retryCount` reaches the cap, emit a **CRITICAL** structured log (`workflow.outbox.dead_lettered`) with `{event_id, topic, entity_kind, retryCount, lastError}` so operators can inspect dead rows in Mongo manually.
4. Optional future: add a `deadLetteredAt: Date` stamp on cap-exceeded rows so the observable gauge can split backlog vs dead-letter.

No data-loss risk — dead rows stay in the outbox collection until the 72h TTL or manual intervention.

**Impact**: Under normal Kafka operation this never fires. Under degraded conditions (ACL misconfig, single bad partition) a bad row monopolises the first batch slot. Not a correctness issue — just operational noise.

**Verification**:

```bash
pnpm --filter=@agent-platform/workflow-engine test --run src/outbox/__tests__/outbox-poller.test.ts
```

Add a new test case: row with `retryCount === MAX - 1` that fails Kafka publish gets incremented past the cap and is excluded from the next `find` result.

---

## FU-3: Consumer shutdown ordering — narrow unflushed-events window (MEDIUM)

**Status**: OPEN — needs Jira ticket in ABLP

**File**: `apps/runtime/src/services/workflow-events-consumer.ts` (shutdown path)

**Source**: pr-reviewer Round 5.

**Problem**: `shutdown()` calls `flushAll()` then `close()` on the buffered writers, then disconnects the Kafka consumers. KafkaJS does not stop message delivery until `disconnect()` returns, so an `eachMessage` handler can fire **between** `flushAll()` resolving and `executionQueue.close()` completing. Late-arriving events land in a writer whose timer has been cleared.

**Mitigation already present**: `BufferedClickHouseWriter.close()` itself calls `flush()` before returning, so a single late event usually still writes. The window is microseconds wide and Kafka redelivers uncommitted offsets on restart. The defect is in ordering, not in data durability.

**Fix**:

1. In `WorkflowEventsConsumer.shutdown()`: disconnect the Kafka consumers **first** (`kafkaQueue.shutdown()` / `humanTaskQueue.shutdown()`), so `onProcess` is guaranteed not to fire.
2. Then `flushAll()`.
3. Then `close()` on the writers.
4. Add a `this.isShuttingDown` flag checked at the top of the `onProcess` handlers as belt-and-braces.

**Impact**: LOW in practice (sub-millisecond window, Kafka offset tracking recovers). Correctness matters for graceful-shutdown in k8s pod rotation.

**Verification**: hard to unit test directly. Add an integration test in the Phase 6 dockerized-CH follow-up that publishes a burst during `shutdown()` and asserts all events land in CH after restart (via Kafka redelivery).

---

## FU-4: Parity-check CLI — `error_code` hardcoded as empty string (LOW)

**Status**: OPEN — tooling defect, no production impact

**File**: `tools/test-infra/parity-check.ts:215`

**Source**: pr-reviewer Round 5.

**Problem**: The CH query selects `'' AS error_code` rather than reading the column from `workflow_executions_latest`. The field-level parity check therefore always reports clean on `error_code` even when Mongo and CH genuinely diverge.

**Fix** (pick one):

- **Option A**: Add `error_code` to the `workflow_executions_latest` MV projection, then swap the CLI to read the column.
- **Option B**: Drop `error_code` from `CANONICAL_FIELDS` until the column is projected. Keeps the CLI honest.

Option B is the less invasive fix and matches what the CLI is actually measuring today.

**Impact**: Operator running parity-check gets a false green on error_code drift. No production traffic impact.

---

## FU-5: Observable gauge — silent error in unpublished-rows callback (LOW)

**Status**: OPEN — cosmetic

**File**: `apps/workflow-engine/src/outbox/metrics.ts:50-56`

**Source**: pr-reviewer Round 5.

**Problem**: The `_unpublishedGauge` observation callback uses `catch {}`. CLAUDE.md forbids swallowed catches. The comment explains the reasoning (observation failures must not tear down the OTel meter reader) but a `log.debug` or a small `metric.observation.failed` counter would make transient Mongo connectivity issues visible in the metric pipeline.

**Mitigation already present**: The poller's own `countDocuments` call at `outbox-poller.ts:168` logs failures separately, and the `publish_failed` counter / `publish_latency` histogram will surface Mongo issues indirectly.

**Fix**: Replace `catch {}` with a debug-level log + a dedicated counter:

```ts
catch (err) {
  log.debug('workflow.outbox.gauge_observation_failed', {
    error: err instanceof Error ? err.message : String(err),
  });
}
```

**Impact**: Cosmetic. Does not affect metric reader stability because the catch still prevents exception propagation.

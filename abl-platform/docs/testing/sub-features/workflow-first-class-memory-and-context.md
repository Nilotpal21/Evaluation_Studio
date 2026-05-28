# Test Specification: Workflow First-Class Memory, Agent Session, and Context

**Feature Spec**: [`../../features/sub-features/workflow-first-class-memory-and-context.md`](../../features/sub-features/workflow-first-class-memory-and-context.md)
**HLD**: [`../../specs/workflow-first-class-memory-and-context.hld.md`](../../specs/workflow-first-class-memory-and-context.hld.md)
**LLD**: [`../../plans/2026-04-27-workflow-first-class-memory-and-context-impl-plan.md`](../../plans/2026-04-27-workflow-first-class-memory-and-context-impl-plan.md)
**Status**: STABLE — 19/21 FRs DONE, 2 NOT TESTED by design per GAP-012/013 (concurrency / retry — out of v1 scope)
**Last Updated**: 2026-04-28 (STABLE promotion — GAP-018 contract closed, GAP-019 closed)
**Parent Testing Guide**: [`../workflows.md`](../workflows.md)

---

## 1. Coverage Matrix

Every functional requirement (FR-1 .. FR-23) from the feature spec maps to at least one landed or scaffolded test. Status legend: `DONE` = at least one test in the Type column passes against real services; `PARTIAL` = some Type columns covered, others deferred to a documented gap; `NOT TESTED` = explicitly out of v1 scope per a documented gap.

| FR    | Description                                                       | Unit | Integration | E2E | Manual | Status  |
| ----- | ----------------------------------------------------------------- | ---- | ----------- | --- | ------ | ------- |
| FR-1  | First-class top-level objects in workflow expressions             | ✅   | ✅          | ✅  |        | DONE    |
| FR-2  | `agentSession` populated for agent runs                           | ✅   | ✅          | ⚠   |        | PARTIAL |
| FR-3  | `agentContext` populated for agent runs                           | ✅   | ✅          | ⚠   |        | PARTIAL |
| FR-4  | Non-agent triggers do not fabricate agent objects                 | ✅   | ✅          | ✅  |        | DONE    |
| FR-5  | Function-node direct globals (`memory`/`agentSession`/`Context`)  | ✅   | ✅          |     |        | DONE    |
| FR-6  | Function nodes reject writes to `agentSession`/`agentContext`     | ✅   | ✅          |     |        | DONE    |
| FR-7  | `memory` available across all trigger types                       | ✅   | ✅          | ✅  |        | DONE    |
| FR-8  | Typed dot-path expression reads on `memory`                       | ✅   | ✅          | ✅  |        | DONE    |
| FR-9  | Function-node `memory.{scope}.get/set/delete` API                 | ✅   | ✅          | ✅  |        | DONE    |
| FR-10 | Workflow scope isolation via `wf:<workflowId>:<key>`              | ✅   | ✅          | ✅  |        | DONE    |
| FR-11 | Project + user scope isolation per §4a User Identity Matrix       | ✅   | ✅          | ✅  |        | DONE    |
| FR-12 | Default 90-day TTL inherited from fact-store                      | ✅   | ✅          |     |        | DONE    |
| FR-13 | Per-write TTL override + ceiling clamp + warning trace            | ✅   | ✅          |     |        | DONE    |
| FR-14 | In-run memory projection updates after writes                     | ✅   | ✅          |     |        | DONE    |
| FR-15 | Agent objects exclude secrets / tokens / transcripts / binaries   |      | ✅          |     | ✅     | DONE    |
| FR-16 | Fail-closed cross-tenant / cross-project / cross-user isolation   | ✅   | ✅          |     |        | DONE    |
| FR-17 | Deterministic interpolation; no hidden I/O outside memory ops     | ✅   | ✅          |     |        | DONE    |
| FR-18 | Positive-list projection schema for `agentSession`/`agentContext` | ✅   | ✅          |     |        | DONE    |
| FR-19 | No template re-interpolation of resolved values                   | ✅   | ✅          |     |        | DONE    |
| FR-20 | Per-write quotas (key/value/count) + reserved-prefix guard        | ✅   | ✅          |     |        | DONE    |
| FR-21 | Memory failures throw to function node — no silent swallow        | ✅   | ✅          |     |        | DONE    |
| FR-22 | Audit log for `set`/`delete` + tombstone semantics                |      | ✅          |     |        | DONE    |
| FR-23 | Right-to-erasure cascade for `memory.user.*`                      |      | ✅          | ✅  |        | DONE    |

`⚠` = E2E coverage is via a `test.skip` scaffold gated on GAP-018 (agent-bound chat → workflow-tool E2E harness). The unit + integration columns for FR-2 / FR-3 are fully covered; only the live HTTP-end-to-end exercise of `agentSession`/`agentContext` populated by a real chat → agent → workflow-tool invocation is deferred.

Risk ranking (oracle decision T1, D-1): FR-10 > FR-11 > FR-2/3 > FR-19 > FR-20 > FR-23 > FR-22.

---

## 2. E2E Test Scenarios (MANDATORY)

CRITICAL: E2E tests exercise the real system through HTTP API only. No `vi.mock` of platform components, no direct Mongoose access, no stubbed servers. Per CLAUDE.md "E2E Test Standards" and HLD Concern #12.

### E2E-1: Agent-triggered workflow reads first-class agent objects + writes memory

- **Preconditions**: One Studio user, one project. One workflow `agent-bound-wf` with a function node body that reads `agentSession.channel`, `agentContext.invocation.tool`, and writes `memory.workflow.set('lastCursor', { id: 1, at: Date.now() }, { ttl: '7d' })`. Workflow registered as a tool on agent `support-agent`.
- **Steps**:
  1. `POST /api/projects/:projectId/agents/support-agent/sessions` — create a real agent session with channel `web` and a known `contactId`.
  2. Send a chat message that invokes the workflow tool. Runtime's `workflow-tool-executor.ts` materializes `agentSession`/`agentContext` projections (positive-list, deep-frozen) and invokes the workflow.
  3. Poll `GET /api/projects/:projectId/workflows/:wfId/executions/:execId` until `status === 'completed'`.
  4. Re-trigger the same workflow tool from the same agent session.
  5. Assert the second run's debug panel shows the `lastCursor` value persisted from run 1 via `{{memory.workflow.lastCursor.id}} = 1`.
- **Expected Result**: Run 1 succeeds; `agentSession.channel === 'web'`, `agentSession.endUserId === <contactId>`, `agentContext.invocation.tool` matches the workflow tool name. Run 2's expression resolves the persisted cursor.
- **Auth Context**: tenant `tA` + project `pA` + Studio user `u1`; agent invocation uses real channel session JWT.
- **Isolation Check**: A duplicate run from project `pB` with the same workflow name returns 404.
- **Covers**: FR-1, FR-2, FR-3, FR-5, FR-7, FR-9, FR-10, FR-14, FR-18.

### E2E-2: Cross-trigger memory continuity (`webhook` write → `cron` read → `agent` read)

- **Preconditions**: Workflow `cross-trigger-wf` with three trigger configurations (webhook, cron, agent) and one function node that reads `memory.project.subscriberCount` and one that conditionally writes `memory.project.subscriberCount = (memory.project.subscriberCount ?? 0) + 1`.
- **Steps**:
  1. `POST /api/webhook/:wfTriggerId` with a payload — the webhook function node writes `memory.project.subscriberCount = 1`.
  2. Trigger the cron path via `POST /api/projects/:projectId/workflows/:wfId/run` (Studio operator path) — the cron function node reads `{{memory.project.subscriberCount}}` and asserts `=== 1`.
  3. Invoke the workflow as an agent tool — the agent path reads `{{memory.project.subscriberCount}}` and asserts `=== 1`.
- **Expected Result**: All three runs see the same `memory.project.subscriberCount === 1`; trace events on each run show projection-load with this key.
- **Auth Context**: webhook uses the workflow's registered API key; Studio direct-run uses Studio user `u1`; agent path uses agent session JWT. All resolve to `tA` + `pA`.
- **Isolation Check**: Same workflow run from project `pB` reads `memory.project.subscriberCount === undefined`.
- **Covers**: FR-1, FR-7, FR-8, FR-9, FR-11 (project scope), FR-14, FR-16.

### E2E-3: Non-agent trigger surfaces `agentSession`/`agentContext` as `undefined` safely

- **Preconditions**: Workflow `non-agent-wf` with a webhook trigger; function node reads `agentSession?.channel ?? 'no-agent'` and asserts equal to `'no-agent'`. A second function node calls `memory.user.get('foo')` (must throw `UNAVAILABLE_SCOPE`).
- **Steps**:
  1. `POST /api/webhook/:wfTriggerId`.
  2. Poll execution to terminal state.
  3. Assert run completes the first node successfully and the second node fails with the documented error code; expression at `{{agentSession.channel}}` resolves to `undefined` (not throw).
- **Expected Result**: First node succeeds with `'no-agent'`; second node fails with `WorkflowMemoryError { code: 'UNAVAILABLE_SCOPE' }` surfaced via workflow error policy.
- **Auth Context**: webhook API key; tenant `tA` + project `pA`.
- **Isolation Check**: N/A (single-tenant scenario).
- **Covers**: FR-4, FR-7, FR-11 (unavailable user scope), FR-21.

### E2E-4: Right-to-erasure cascade purges `memory.user.*` for an erased contact

- **Preconditions**: Agent-triggered workflow that writes `memory.user.set('preferredLang', 'fr', { ttl: '90d' })`. One contact `c1` with `contactId` resolved as `endUserId` per §4a. Run the workflow once so `memory.user.preferredLang` is persisted for `c1`.
- **Steps**:
  1. `POST /api/projects/:projectId/contacts` — create `c1`.
  2. Invoke the agent tool from a public-channel session whose `Session.source.contactId === c1.id`. Workflow writes the user-scoped fact.
  3. `GET /api/projects/:projectId/workflows/:wfId/run/:runId/memory-projection` (or a debug API surfaced by the test harness) confirms `memory.user.preferredLang === 'fr'` is reachable.
  4. `DELETE /api/projects/:projectId/contacts/:c1Id?gdpr=true` — triggers `CascadeDeleteContact` extended with the new fact-erasure step.
  5. Re-invoke the workflow with the same `endUserId` (now erased) and assert `memory.user.preferredLang === undefined`.
- **Expected Result**: After GDPR delete, `memory.user.*` keyed on `c1`'s `endUserId` is purged. `memory.workflow.*` and `memory.project.*` keys are unaffected (asserted by reading another key written before the delete).
- **Auth Context**: GDPR delete uses Studio admin JWT with `pii:erase` permission; agent invocation uses public-channel session. Tenant `tA` + project `pA`.
- **Isolation Check**: A different contact `c2` in the same project still has its `memory.user.*` intact post-delete.
- **Covers**: FR-11 (user scope), FR-23, FR-22 (audit emission verified via log capture in supplemental integration test).

### E2E-6: Cross-run workflow-scope memory persistence (Studio direct-run × 2)

- **Preconditions**: One workflow with a single function node whose body reads `memory.workflow.get(<sentinel>)` into `previous`, then writes `memory.workflow.set(<sentinel>, { ts: Date.now() })`, then `workflow.setOutput({ previousIsDefined, previousTs, currentTs })`. Sentinel key is randomized per test invocation to avoid cross-test interference. No agent / no webhook / no cron — pure Studio direct-run.
- **Steps**:
  1. Studio direct-run #1 — `previous` resolves to `undefined`; `setOutput.previousIsDefined === false`.
  2. Studio direct-run #2 — same workflow, fresh trigger; `previous` MUST be the value run 1 persisted; `setOutput.previousIsDefined === true` AND `setOutput.previousTs` is a numeric timestamp.
- **Expected Result**: Both runs reach a terminal state. The second run sees the value the first run wrote — proving end-to-end persistence through the V8 isolate ↔ `runtime-memory-client` ↔ `/api/internal/memory/{set,get}` ↔ Mongo `Fact` document chain.
- **Auth Context**: tenant `tA` + project `pA` + Studio user `u1`. Actor envelope on each run is `{kind: 'workflow-author'}` (Studio direct-run is non-agent).
- **Isolation Check**: Workflow-scope keys are stored under `wf:<workflowId>:<key>` (FR-10) so distinct workflows in the same project see disjoint values for the same author key — covered structurally by `fact-store-workflow-adapter.test.ts`. The randomized sentinel keeps E2E-6 robust against cross-test residue too.
- **Covers**: FR-9, FR-10, FR-14, FR-7 (memory available across all trigger types — Studio direct-run is one of those types).

### E2E-5: Workflow-as-tool nesting propagates outermost agent context

- **Preconditions**: Two workflows. `outer-wf` is a tool on agent `concierge-agent`; `outer-wf` invokes `inner-wf` via the workflow-as-tool node. Both have function nodes that capture `agentSession.endUserId` and write to `memory.workflow.lastSeen` (their respective scopes).
- **Steps**:
  1. End user (contact `c-nest`) sends a chat message; `concierge-agent` invokes `outer-wf` as a tool.
  2. `outer-wf` invokes `inner-wf`.
  3. After both runs complete, fetch each run's debug snapshot.
- **Expected Result**: `outer-wf.agentSession.endUserId === c-nest.contactId`; `inner-wf.agentSession.endUserId === c-nest.contactId` (NOT the outer workflow's id). `outer-wf.memory.workflow.lastSeen` is keyed under `wf:<outerWfId>:lastSeen`; `inner-wf.memory.workflow.lastSeen` is keyed under `wf:<innerWfId>:lastSeen` — verified by reading from a third workflow that namespace-walks (negative test: it cannot read either).
- **Auth Context**: end user public-channel session, tenant `tA` + project `pA`.
- **Isolation Check**: Both `wf:` keys are NOT visible to `tool-memory-bridge.ts`-style readers reading `memory.project.lastSeen` (covered structurally in INT-7).
- **Covers**: FR-2, FR-3, FR-10, FR-18, plus workflow-as-tool nesting paragraph in feature spec §8.

---

## 3. Integration Test Scenarios (MANDATORY)

Integration tests use real isolated-vm, real `MongoMemoryServer`, real Express routes mounted via supertest, and real service JWTs from `createServiceToken`. No `vi.mock` of `@agent-platform/*`, `@abl/*`, or relative imports. Per CLAUDE.md "Test Architecture" and HLD Concern #12.

### INT-1: `runtime-memory-client` ↔ `/api/internal/memory` round-trip with real service-auth JWT

- **Boundary**: `apps/workflow-engine/src/clients/runtime-memory-client.ts` (NEW) → HTTP → `apps/runtime/src/middleware/internal-service-auth.ts` → `apps/runtime/src/routes/internal-memory.ts` (NEW).
- **Setup**: Mount the memory route on a supertest Express app. Generate a real JWT via `createServiceToken({ tenantId, projectId, ... })` from `@agent-platform/shared-auth`. Use `MongoMemoryServer` for fact persistence.
- **Steps**:
  1. POST `/projection` with `{ tenantId, projectId, workflowId, endUserId }` returns `{ workflow: {}, project: {}, user: {} }` for a clean tenant.
  2. POST `/set` for a `workflow`-scope key, then POST `/get` returns the value.
  3. POST `/projection` again returns the new key under `workflow`.
  4. POST `/delete` then POST `/get` returns `undefined`.
- **Expected Result**: All four operations succeed end-to-end through the real middleware and Mongo; `wf:<workflowId>:<key>` translation visible on the underlying `Fact` document.
- **Failure Mode**: When MongoMemoryServer is stopped mid-test, `/set` returns `503` and the client throws `WorkflowMemoryError { code: 'STORAGE_UNAVAILABLE' }`.
- **Covers**: FR-7, FR-8, FR-9, FR-10, FR-14, FR-21; HLD §6.1 (4 routes); HLD §8.1 (`requireServiceAuth` PREREQUISITE).

### INT-2: `requireServiceAuth` body-`tenantId` cross-check (PREREQUISITE)

- **Boundary**: `apps/runtime/src/middleware/internal-service-auth.ts` (extended).
- **Setup**: Mount the memory route. Issue two JWTs: `jwtA` for tenant `tA`, `jwtB` for tenant `tB`.
- **Steps**:
  1. POST `/set` with `Authorization: jwtA` and body `{ tenantId: 'tA', ... }` → 200.
  2. POST `/set` with `Authorization: jwtA` and body `{ tenantId: 'tB', ... }` → 403 `INVALID_TENANT`.
  3. POST `/set` with `Authorization: jwtA` and body `{ projectId: 'pB', ... }` (existing projectId mismatch path) → 403 `INVALID_PROJECT`.
  4. POST `/set` with an expired JWT → 401.
- **Expected Result**: New tenantId cross-check fails closed with 403; existing projectId cross-check unchanged. The fix benefits all internal route groups (tools, chat, callback, memory).
- **Failure Mode**: Without the cross-check, `jwtA + body.tenantId='tB'` would erroneously authorize a cross-tenant write — this is the exact gap closed by the prerequisite.
- **Covers**: FR-16, HLD §8.1 (PREREQUISITE), HLD Concern #1.

### INT-3: Function executor isolate ↔ runtime memory client via `ivm.Reference.applySyncPromise`

- **Boundary**: `apps/workflow-engine/src/executors/function-executor.ts` (extended) → real `isolated-vm` isolate → `runtime-memory-client.ts` → mounted runtime memory route.
- **Setup**: Real isolate created per `function-executor.test.ts` pattern; mounted memory route on supertest with real Mongo.
- **Steps**:
  1. Run a function node body: `memory.workflow.set('cnt', 1); memory.workflow.set('cnt', (memory.workflow.get('cnt') ?? 0) + 1); return memory.workflow.get('cnt');`.
  2. Inspect the return value of `executeFunctionStep`.
  3. Inspect the trace events emitted (`memory_op` × 3 ops).
- **Expected Result**: Return value is `2`. From the script's perspective the `set`/`get` calls were synchronous; the host blocked the isolate's worker thread for each round-trip. Trace events show the three operations in order with correct keys, scope, and TTL.
- **Failure Mode**: When the runtime route hangs (configured via test fixture to delay > client timeout), the script throws `WorkflowMemoryError { code: 'STORAGE_UNAVAILABLE' }` and the function-node step fails — verifying isolate-thread does not deadlock.
- **Covers**: FR-5, FR-9, FR-14, FR-21; HLD Concern #9 (isolate-thread budget).

### INT-4: Reserved-prefix two-layer guard (route + `MongoDBFactStore.set`)

- **Boundary**: `apps/runtime/src/routes/internal-memory.ts` (route guard) AND `apps/runtime/src/services/stores/mongodb-fact-store.ts` (deep guard with `__originAdapter` marker).
- **Setup**: Mount both the new memory route and a test fixture that simulates a `tool-memory-bridge.ts`-style caller writing directly into `MongoDBFactStore.set()` without the `__originAdapter: 'workflow'` marker.
- **Steps**:
  1. POST `/api/internal/memory/set` with `key='wf:abc:foo'` from the workflow-author surface → 400 `RESERVED_PREFIX`.
  2. POST `/api/internal/memory/set` with `key='_meta:foo'` → 400 `RESERVED_PREFIX`.
  3. POST `/api/internal/memory/set` with `key='_audit:foo'` → 400 `RESERVED_PREFIX`.
  4. Direct call `MongoDBFactStore.set({ key: 'wf:abc:bar', ... })` (simulating tool-memory-bridge) without the marker → throws `RESERVED_PREFIX`.
  5. `FactStoreWorkflowAdapter.set('foo', ..., workflowId='abc')` (passes `__originAdapter: 'workflow'` internally) → succeeds; document's `key === 'wf:abc:foo'`.
- **Expected Result**: Author writes to any reserved prefix fail at the route layer. Even bypassing the route, direct fact-store writes to `wf:` fail unless via the adapter — closing the cross-surface forge vector.
- **Failure Mode**: Without the deep guard at `MongoDBFactStore.set()`, scenario 4 would silently succeed, allowing `tool-memory-bridge.ts` to plant `wf:` keys and let later `memory.workflow.bar` reads return tool-written data — privacy / trust violation.
- **Covers**: FR-20, FR-10; HLD Concern #4 (c.1, c.2).

### INT-5: Per-write quota enforcement (key length / value size / write count)

- **Boundary**: Runtime memory route quota middleware → `WorkflowMemoryError`.
- **Setup**: Mount the memory route. Issue a service JWT carrying a `runId` for write-count tracking.
- **Steps**:
  1. POST `/set` with `key.length === 257` → 400 `QUOTA_KEY_LENGTH`.
  2. POST `/set` with serialized `value` size > 64 KB → 400 `QUOTA_VALUE_SIZE`.
  3. Loop POST `/set` 100 times with the same `runId` → 100th write returns 200; 101st write returns 400 `QUOTA_WRITE_COUNT`.
  4. With a fresh `runId`, the counter resets — first write under it succeeds.
- **Expected Result**: All three quota classes throw with their documented codes; counter is per-`runId`.
- **Failure Mode**: Storage unavailable mid-loop should not corrupt the counter (asserted via subsequent run starting fresh).
- **Covers**: FR-20, FR-21; spec §17 scenario 11.

### INT-6: Per-write TTL clamp + warning trace

- **Boundary**: Runtime memory route TTL parser → `MongoDBFactStore.set()` with clamped `expiresAt`.
- **Setup**: Mount the memory route. Configure the fact-store maximum-retention ceiling via env config (per existing fact-store contract).
- **Steps**:
  1. POST `/set` with `ttl: '5d'` → 200; the underlying fact's `expiresAt = now + 5d`; trace event has `appliedTtlMs === 5d`.
  2. POST `/set` with `ttl: '999d'` (well above the ceiling) → 200; `expiresAt` clamped to `now + ceiling`; trace event has `appliedTtlMs === ceiling` AND a warning trace `{ event: 'ttl_clamped', requested: '999d', applied: '<ceiling>' }`.
  3. POST `/set` with `ttl: 'banana'` (invalid) → 400 `TTL_INVALID`.
  4. POST `/set` with no `ttl` → 200; `expiresAt = now + 90d` (fact-store default).
- **Expected Result**: Out-of-bounds TTL is silently clamped (not rejected) with warning trace; invalid TTL throws.
- **Failure Mode**: A TTL parser bug that returns `Infinity` would bypass the ceiling — covered by the trace assertion.
- **Covers**: FR-12, FR-13.

### INT-7: Cross-surface fact namespace (intentional sharing for project/user; isolation for workflow)

- **Boundary**: `tool-memory-bridge.ts` write path AND `runtime-memory-client.ts` write path → same `MongoDBFactStore`.
- **Setup**: Mount both surfaces against the same `MongoMemoryServer`. Issue service JWTs for both surfaces with matching tenantId + projectId.
- **Steps**:
  1. Tool-memory-bridge writes `memory.project.foo = 1`.
  2. Workflow memory client reads `memory.project.foo` → returns `1` (intentional sharing).
  3. Workflow memory client writes `memory.workflow.bar = 2` (under `wf:<workflowId>:bar`, project scope).
  4. Tool-memory-bridge calls `getContent('bar')` (no `wf:` prefix awareness) → returns `undefined`.
  5. Tool-memory-bridge calls `getContent('wf:<workflowId>:bar')` → fails the deep prefix guard at `MongoDBFactStore.get`-time — actually, since reads don't have the guard, the test must verify the bridge has no API to specify a `wf:` key. (Verified by reading the bridge's public surface.)
- **Expected Result**: project and user scopes intentionally share namespace; workflow scope is origin-isolated. Bridge-side reads cannot target `wf:` keys via its public API.
- **Failure Mode**: A leak in the bridge that exposes raw key access would let it read workflow-scoped facts — guarded by the bridge's API shape, not by reader-time prefix checks.
- **Covers**: FR-10, spec §9 cross-surface trust model, spec §17 scenario 21.

### INT-8: Audit log emission + tombstone semantics

- **Boundary**: Runtime memory route → `createLogger('workflow-memory')` → tombstone path in `MongoDBFactStore.set`.
- **Setup**: Mount the memory route. Capture log output via a structured-log test sink (no mocks of the logger module — DI a sink). Run real Mongo.
- **Steps**:
  1. POST `/set` `{ scope: 'project', key: 'k1', value: 'v1' }`. Capture log entry: `{ level: 'info', event: 'memory_op', tenantId, projectId, workflowId, runId, scope: 'project', key: 'k1', actor, appliedTtlMs, op: 'set' }`. Assert NO `value` field.
  2. POST `/delete` `{ scope: 'project', key: 'k1' }`. Capture log entry with `op: 'delete', tombstone: true`.
  3. Inspect the underlying fact document: `isDeleted: true`, `deletedAt: <Date>`, `value` retained for audit reconstruction within retention window.
  4. POST `/get` `{ scope: 'project', key: 'k1' }` → `undefined` (tombstone filtered).
  5. POST `/delete` again → 200 (idempotent tombstone).
- **Expected Result**: Audit log fields exact; tombstone visible to internal audit reconstruction but invisible to live reads.
- **Failure Mode**: A tombstone visible to `get` would re-introduce the deleted value — covered by step 4. Audit entry with `value` would leak PII — covered by step 1 negative assertion.
- **Covers**: FR-22; HLD §5.1, Concern #8.

### INT-9: Right-to-erasure cascade — `CascadeDeleteContact` purges `memory.user.*`

- **Boundary**: `apps/runtime/src/contexts/contact/use-cases/cascade-delete-contact.ts` (extended) → fact-store erasure step.
- **Setup**: Real Mongo; seeded contact `c1` with `endUserId === c1.id`; seed three facts: `memory.user.foo` keyed on `c1.id` (scope=user), `memory.workflow.bar` keyed on `wf:abc:bar` (scope=project), and `memory.project.baz` (scope=project).
- **Steps**:
  1. Trigger `CascadeDeleteContact(c1)`.
  2. `MongoDBFactStore.get({ userId: c1.id, scope: 'user', key: 'foo' })` → `undefined`.
  3. Read the underlying fact-store: `wf:abc:bar` and `baz` are still present.
- **Expected Result**: Only user-scoped facts keyed on the erased identity are purged; workflow- and project-scoped facts unaffected.
- **Failure Mode**: A regex-based purge that incorrectly matches `wf:abc:bar` would delete cross-user state — covered by step 3.
- **Covers**: FR-23; HLD §7 Compliance.

### INT-10: No template re-interpolation of resolved `agentContext` / `memory` values

- **Boundary**: `apps/workflow-engine/src/context/expression-resolver.ts` (single-pass evaluator).
- **Setup**: Build a `WorkflowContextData` where `agentContext.attachments[0].name === '{{memory.project.secret}}'` and `memory.project.secret === 'TOPSECRET'`.
- **Steps**:
  1. `resolveExpressionTyped('{{agentContext.attachments[0].name}}', ctx)` → `'{{memory.project.secret}}'` (literal).
  2. `resolveExpressionTyped('Hello {{agentContext.attachments[0].name}}', ctx)` → `'Hello {{memory.project.secret}}'` (literal).
  3. `resolveExpressionTyped('{{memory.workflow.greeting}}', ctx)` where `memory.workflow.greeting === '{{agentContext.invocation.tool}}'` → returns `'{{agentContext.invocation.tool}}'` (literal — no second pass).
- **Expected Result**: Resolved values are inert; the resolver never recursively walks into them.
- **Failure Mode**: A bug introducing a second `String.replace` pass would leak `memory.project.secret` into the resolved expression — covered by step 1's negative assertion that `'TOPSECRET'` does NOT appear.
- **Covers**: FR-19, FR-17; spec §17 scenario 9.

### INT-11: Concurrent writes to the same key are last-write-wins

- **Boundary**: Runtime memory route → MongoDB upsert.
- **Setup**: Mount the memory route, real Mongo, two service JWTs sharing tenantId/projectId.
- **Steps**:
  1. Fire `Promise.all([client1.set('k', 'A'), client2.set('k', 'B')])`.
  2. Read `client1.get('k')`.
- **Expected Result**: Returned value is `'A'` OR `'B'` (deterministic per Mongo upsert ordering, not a merge or error).
- **Failure Mode**: Any partial-write or merge behavior would surface as neither `'A'` nor `'B'`.
- **Covers**: FR-21 (concurrency last-write-wins disclaimer); spec §17 scenario 17.

### INT-12: Replay/retry idempotency contract

- **Boundary**: Function-executor retry path in `function-executor.ts`.
- **Setup**: Real isolate; configure the function node's retry policy to retry once on synthetic transient failure.
- **Steps**:
  1. Function body calls `memory.workflow.set('counter', (memory.workflow.get('counter') ?? 0) + 1)` then throws on the first attempt.
  2. The retry executes the body again — `set` runs twice.
  3. Read `memory.workflow.counter`.
- **Expected Result**: Final value is `2` (writes are NOT once-only). Test asserts the v1 contract that authors must use deterministic keys.
- **Failure Mode**: An accidental dedup at the route layer would return `1` — not the documented contract.
- **Covers**: FR-21 (idempotency note); spec §17 scenario 18.

### INT-13: Positive-list projection schema enforcement

- **Boundary**: `apps/runtime/src/services/workflow/workflow-tool-executor.ts` projection step.
- **Setup**: Drive a fake agent invocation with extra fields on the underlying session metadata (e.g., `Session.source.creditCardLast4 = '1234'`, `Session.source.modelId = 'gpt-4'`).
- **Steps**:
  1. Invoke the workflow tool. Capture the materialized `agentSession`/`agentContext` from `triggerMetadata`.
  2. Assert: only the §9 positive-list fields present (`sessionId`, `agentName`, `channel`, `source`, `endUserId`, `locale`, `startedAt`, `lastActivityAt` on `agentSession`).
  3. Assert: `creditCardLast4`, `modelId` are NOT present.
  4. Mutation attempt `agentSession.foo = 'x'` in the function node throws (deep-frozen).
- **Expected Result**: Implicit field bleed is structurally impossible.
- **Failure Mode**: Spread-style materialization would let `Session.source.*` extras leak — guarded by explicit positive-list construction.
- **Covers**: FR-15, FR-18, FR-6; spec §17 scenarios 8, 20.

### INT-14: Unavailable `memory.user` per §4a User Identity Resolution Matrix

- **Boundary**: Runtime memory route + workflow-handler context construction.
- **Setup**: Seven mounted scenarios — one row per §4a matrix line: agent (public-channel with contactId), agent (Studio debug session), studio (direct run), webhook, cron, event (with `event.userId` set), event (without `event.userId`).
- **Steps**:
  1. For each scenario, POST `/projection`; inspect the `user` view in the response.
  2. For each scenario, attempt `memory.user.get('foo')` from a function node.
- **Expected Result**:
  - public-channel: `user` view present, get succeeds (returns `undefined` for a missing key, NOT `UNAVAILABLE_SCOPE`).
  - Studio debug: `user` view absent, get throws `UNAVAILABLE_SCOPE`.
  - studio direct run: `user` view absent, get throws `UNAVAILABLE_SCOPE`.
  - webhook: `user` view absent, get throws `UNAVAILABLE_SCOPE`.
  - cron: same as webhook.
  - event with `event.userId` set: `user` view present, get succeeds (returns `undefined` for missing key); `endUserId` echoes `event.userId`.
  - event without `event.userId`: `user` view absent, get throws `UNAVAILABLE_SCOPE`.
  - In every "absent" case, `{{memory.user.foo}}` in expressions short-circuits to `undefined` instead of throwing.
- **Failure Mode**: Studio admin user being mistaken for `endUserId` would leak admin-keyed facts into agent-triggered runs — covered by Studio-debug case asserting NO user view. An event handler defaulting to a fallback identity would resolve `memory.user.*` for events that don't carry one — covered by the event-without-userId case.
- **Covers**: FR-11, §4a matrix (all 6 trigger rows including `event` conditional branch); spec §17 scenario 6.

### INT-15: Cookie-reset `anonymousId` rotation isolates `memory.user.*`

- **Boundary**: `Session.source` end-user identity resolution (§4a).
- **Setup**: Two public-channel sessions for the same workflow — `s1` with `anonymousId = a1`, `s2` with `anonymousId = a2` (simulating cookie reset). Same tenantId + projectId, no contactId, no customerId.
- **Steps**:
  1. From `s1`, write `memory.user.set('cart', ['itemA'])`. Endured under `endUserId === a1`.
  2. From `s2`, read `memory.user.cart` → `undefined`.
  3. From `s1`, read again → `['itemA']`.
- **Expected Result**: Cookie-reset (new `anonymousId`) means prior `memory.user.*` is unreachable. Documented behavior.
- **Failure Mode**: A fallback to `tenantId+projectId`-only scoping would leak `cart` to `s2` — covered by step 2.
- **Covers**: FR-11 anonymousId paragraph in §4a; oracle decision D-7.

### INT-16: `memory.workflow.*` workflow-global privacy regression (two end users, same workflow)

- **Boundary**: `FactStoreWorkflowAdapter` `wf:<workflowId>:<key>` translation — confirms the v1 design contract that workflow-scope is workflow-global, NOT per-invoker.
- **Setup**: One workflow `shared-cache-wf` with one function node that reads/writes `memory.workflow.lastQuery`. Two distinct end-user identities — contact `c-alice` (channel `web`) and contact `c-bob` (channel `web`) — same tenantId + projectId.
- **Steps**:
  1. Trigger `shared-cache-wf` from `c-alice`'s public-channel agent session. Function node writes `memory.workflow.set('lastQuery', 'alice-secret-search')`.
  2. Trigger `shared-cache-wf` from `c-bob`'s public-channel agent session. Function node reads `memory.workflow.get('lastQuery')`.
  3. Assert: bob's read returns `'alice-secret-search'`. This confirms the v1 contract that `memory.workflow.*` is shared across all invokers of the same workflow.
  4. Inspect the underlying fact-store: a single document exists with `key === 'wf:<shared-cache-wf-id>:lastQuery'`, `userId === '__project__'` sentinel — NOT keyed on either contactId.
  5. Negative isolation check: a different workflow `other-wf` reading `memory.workflow.lastQuery` returns `undefined` (the `wf:` prefix includes workflowId).
- **Expected Result**: Two different end users on the same workflow see each other's `memory.workflow.*` writes — by design. The test is a privacy regression confirming the v1 anti-pattern is enforced consistently and authors who use this scope for per-user state will hit the documented hazard.
- **Failure Mode**: A future change that silently keys workflow-scope on `endUserId` would break this test (alice's value would not be visible to bob) — failure here flags an unintended scope tightening that authors may already depend on.
- **Covers**: FR-10 (workflow scope is workflow-global), feature spec §6 anti-pattern note, spec §17 scenario 7.

---

## 4. Unit Test Scenarios

### UT-1: `expression-resolver.ts` — first-class top-level keys

- **Module**: `apps/workflow-engine/src/context/expression-resolver.ts`.
- **Input**: `WorkflowContextData` with `agentSession`, `agentContext`, `memoryProjection.workflow`, `.project`, `.user` populated.
- **Expected Output**: `{{agentSession.channel}}`, `{{memory.workflow.foo}}`, `{{memory.project.bar}}`, `{{memory.user.baz}}` all resolve typed; unknown-prefix expressions still throw `UNKNOWN_TOP_LEVEL_KEY`.
- **Negative**: `{{agentSession.foo}}` where `agentSession === undefined` resolves to `undefined`, not throws.
- **Covers**: FR-1, FR-7, FR-8.

### UT-2: TTL clamping pure function

- **Module**: New TTL parser/clamp helper in the runtime memory route.
- **Input**: TTL strings (`'5d'`, `'999d'`, `'banana'`, `''`, `undefined`) + ceiling `30d`.
- **Expected Output**: `5d` → `5d`; `999d` → `30d` + warning flag; invalid → throw `TTL_INVALID`; `''`/`undefined` → fact-store default `90d` (via fall-through).
- **Covers**: FR-12, FR-13.

### UT-3: `wf:<workflowId>:<key>` translation

- **Module**: `FactStoreWorkflowAdapter` (NEW).
- **Input**: `(workflowId='abc', key='foo')`, `(workflowId='wf-with-special:colon', key='bar')`.
- **Expected Output**: `'wf:abc:foo'`, `'wf:wf-with-special:colon:bar'` (workflowId is opaque — no escaping in v1; LLD documents the rule).
- **Covers**: FR-10, HLD §5.2.

### UT-4: Deep freeze enforcement

- **Module**: `agentSession`/`agentContext` materializer.
- **Input**: A nested object `{ foo: { bar: { baz: 1 } } }`.
- **Expected Output**: All depths frozen; `obj.foo.bar.baz = 2` throws in strict mode.
- **Covers**: FR-6, FR-18; spec §17 scenario 20.

### UT-5: Reserved-prefix validator

- **Module**: Route-layer key validator.
- **Input**: `'foo'` (allowed), `'wf:abc'` (reserved), `'_meta:x'` (reserved), `'_audit:y'` (reserved), `'_system:z'` (reserved), `'wfoo'` (allowed — no colon).
- **Expected Output**: First and last allowed; rest throw `RESERVED_PREFIX`.
- **Covers**: FR-20.

### UT-6: Function-node global injection (in-isolate, real ivm)

- **Module**: `function-executor.ts` global setup.
- **Input**: A function node body that asserts `typeof memory === 'object'`, `typeof memory.workflow.get === 'function'`, `typeof agentSession === 'object'`.
- **Expected Output**: Body returns true. Direct write `memory.workflow = null` throws (frozen reference).
- **Covers**: FR-5, FR-6.

### UT-7: Single-pass interpolation regex

- **Module**: `expression-resolver.ts` `EXPRESSION_PATTERN` evaluator.
- **Input**: A resolved value containing `{{...}}` is fed back into a second `String.replace` pass.
- **Expected Output**: The structural property holds — running `.replace(pattern, fn)` once on the input returns the resolved value verbatim, even if the value contains `{{...}}` syntax.
- **Covers**: FR-19.

---

## 5. Security & Isolation Tests

These checks are mandatory; each maps to at least one scenario above.

- [x] Cross-tenant memory access returns 404 / `INVALID_TENANT` (INT-2 + INT-1)
- [x] Cross-project memory access returns 404 / `INVALID_PROJECT` (existing `requireServiceAuth` projectId path; INT-2)
- [x] Cross-user `memory.user.*` access returns `undefined` for the wrong `endUserId` (INT-14, INT-15)
- [x] Missing service JWT returns 401 (INT-2 step 4)
- [x] Tampered service JWT (signature mismatch) returns 401 (covered by `createServiceToken` + supertest negative case in INT-2)
- [x] Insufficient permissions on the GDPR delete returns 403 (E2E-4 negative path)
- [x] Input validation rejects oversized keys, oversized values, and reserved-prefix keys (INT-4, INT-5)
- [x] Audit log never contains `value` (INT-8 step 1 negative assertion)
- [x] `agentSession` / `agentContext` exclude secrets, model IDs, transcripts, attachment binaries (INT-13)
- [x] No template re-interpolation of resolved `agentContext`/`memory` values (INT-10, UT-7)
- [x] `tool-memory-bridge.ts` cannot forge `wf:` keys (INT-4 step 4-5)
- [x] Cookie-reset `anonymousId` does NOT inherit prior user-scoped facts (INT-15)
- [x] `memory.workflow.*` is workflow-global by design — privacy regression test with two distinct end-user identities (alice and bob, both contacts) on the same workflow confirms each sees the other's writes (INT-16; spec §17 scenario 7 explicit)

---

## 6. Performance & Load Tests

V1 ships **enforcement assertions**, not load tests (oracle decision D-6, E5).

| Assertion                             | Source              | Test                                                                       |
| ------------------------------------- | ------------------- | -------------------------------------------------------------------------- |
| Single memory op < 200ms in CI        | HLD Concern #9      | INT-1 (assert `t < 200ms` on warm Mongo)                                   |
| Projection load < 256 KB serialized   | HLD Concern #9      | INT-1 step 1 — synthetic 1k-key fixture rejects projection-load with error |
| 100 writes per run cap enforced       | FR-20               | INT-5 step 3                                                               |
| Per-tenant aggregate budget           | Existing fact-store | Inherits — not re-tested at workflow-memory layer                          |
| Isolate-thread budget per-tenant pool | HLD Concern #9      | LLD must lock pool size; test deferred until LLD specifies the cap         |

Cross-system load tests (k6 throughput, multi-pod saturation) are deferred to post-implementation performance validation per `saturation-finder` skill workflow.

---

## 7. Test Infrastructure

### Required services

- **MongoDB**: `MongoMemoryServer` via `apps/workflow-engine/src/__tests__/helpers/setup-mongo.ts`. Same helper for runtime-side integration tests once they import via the workspace.
- **isolated-vm**: real, no mock. Existing `apps/workflow-engine/src/__tests__/function-executor.test.ts` is the reference pattern.
- **Express + supertest**: route is mounted into a test app — no separate HTTP process. Pattern: `apps/workflow-engine/src/__tests__/route-integration.test.ts`.
- **Studio E2E (Playwright)**: real running stack — Studio, Runtime, Workflow Engine, Restate, MongoDB, Redis. Per `apps/studio/e2e/workflows/workflow-function-node.spec.ts` header.

### Data seeding

- **Workflow fixtures**: created via `helpers.ts:createWorkflowViaUI` then function-node body configured via the Zustand store helper `configureFunctionNode` from `workflow-function-node.spec.ts`.
- **Agent + workflow tool binding**: seeded via the runtime API (POST agent + register workflow as tool) using the project API key.
- **Contact `c1` for E2E-4**: seeded via `POST /api/projects/:projectId/contacts`.
- **Prior memory state**: seeded by running the workflow once with a memory write (no direct DB seeding — per CLAUDE.md E2E rule).
- **Service JWTs** (integration): generated via `createServiceToken` from `@agent-platform/shared-auth` (`packages/shared-auth/src/middleware/jwt-verify.ts:163`) using a test-only `PLATFORM_INTERNAL_SHARED_SECRET`.

### Environment variables

| Variable                          | Purpose                                              |
| --------------------------------- | ---------------------------------------------------- |
| `PLATFORM_INTERNAL_SHARED_SECRET` | Test secret for `createServiceToken` JWT signing     |
| `MONGO_TEST_RETENTION_CEILING`    | Override fact-store TTL ceiling for INT-6 clamp test |
| `WORKFLOW_MEMORY_FACT_STORE_URL`  | Internal route base for `runtime-memory-client.ts`   |

Defaults are documented in the integration-test setup file; no real cluster credentials are required.

### CI configuration

- **Unit tests** (UT-1..UT-7): `pnpm test:fast --filter=apps/workflow-engine` and `--filter=apps/runtime`.
- **Integration tests** (INT-1..INT-16): `pnpm test --filter=apps/workflow-engine` and `--filter=apps/runtime`. Requires `MongoMemoryServer` (transparent — guard via `requireMongo(skip)` if unavailable).
- **Studio E2E** (E2E-1..E2E-5): `pnpm e2e:workflows` per `apps/studio/e2e/workflows/agents.md`. Tier classification: heavy / nightly given the multi-service dependency. New tests added to the workflow-canvas tier tracker in `agents.md` once they exist.

### Test reporting

- Use `pnpm test:report` for failure capture per CLAUDE.md. Failures land in `test-reports/SUMMARY.md`.

---

## 8. Test File Mapping

| Test File                                                                                        | Type        | Covers                                                                                                                            |
| ------------------------------------------------------------------------------------------------ | ----------- | --------------------------------------------------------------------------------------------------------------------------------- |
| `apps/workflow-engine/src/__tests__/expression-resolver.test.ts` _(LANDED Phase 3, extended)_    | unit        | UT-1, UT-2, UT-7; FR-1, FR-7, FR-8, FR-19                                                                                         |
| `apps/workflow-engine/src/__tests__/function-executor.test.ts` _(LANDED Phase 4, extended)_      | integration | UT-4, UT-6, INT-3 (real ivm boundary), INT-12 (trace event coverage); FR-5, FR-6, FR-9, FR-14, FR-18, FR-21                       |
| `apps/workflow-engine/src/__tests__/runtime-memory-client.test.ts` _(LANDED Phase 4)_            | unit        | UT-3 (translation only — pure); FR-21 error classification                                                                        |
| `apps/workflow-engine/src/__tests__/runtime-memory-client-http.test.ts` _(LANDED Phase 4)_       | integration | INT-1 (workflow-engine side; real HTTP roundtrip via undici); FR-7, FR-12 perf assertion `t<200ms`                                |
| `apps/workflow-engine/src/__tests__/workflow-memory-isolate.test.ts` _(LANDED Phase 4)_          | integration | UT-5, UT-6, INT-3 partial; FR-5, FR-6 (deep-freeze enforcement), FR-21 (transferability)                                          |
| `apps/runtime/src/__tests__/internal-memory-route.test.ts` _(LANDED Phase 2)_                    | integration | INT-1, INT-4, INT-5, INT-6, INT-8, INT-11, INT-12; FR-7, FR-9, FR-13, FR-19, FR-20, FR-22                                         |
| `apps/runtime/src/__tests__/fact-store-workflow-adapter.test.ts` _(LANDED Phase 1)_              | unit        | UT-3, UT-5, INT-7 (cross-surface namespace), INT-16 (workflow-scope global regression); FR-10, FR-20                              |
| `apps/runtime/src/__tests__/mongodb-fact-store-prefix-guard.test.ts` _(LANDED Phase 1+1b)_       | unit        | UT-4, INT-4 step 4-5 (deep `wf:` guard + tombstone semantics); FR-10, FR-20, FR-22                                                |
| `apps/runtime/src/__tests__/internal-service-auth-tenant-cross-check.test.ts` _(LANDED Phase 0)_ | integration | INT-2; HLD §8.1 PREREQUISITE; FR-16                                                                                               |
| `apps/runtime/src/__tests__/cascade-delete-contact-memory-erasure.test.ts` _(LANDED Phase 5)_    | integration | INT-9; FR-23 (right-to-erasure cascade + cross-tenant isolation + fail-soft on port throw)                                        |
| `apps/runtime/src/__tests__/workflow-tool-executor-projection.test.ts` _(LANDED Phase 3)_        | integration | INT-13, INT-14 partial (§4a contact + customer + anonymous + channel-artifact rows); FR-2, FR-3, FR-11, FR-15, FR-18              |
| `apps/studio/e2e/workflows/workflow-first-class-memory.spec.ts` _(LANDED Phase 6 + BETA-prep)_   | e2e         | E2E-3 (full), E2E-6 (full — cross-run workflow-scope continuity); E2E-1 + E2E-2 are `test.skip` scaffolds — see GAP-018 / GAP-019 |
| `apps/studio/e2e/workflows/workflow-memory-erasure.spec.ts` _(LANDED Phase 6)_                   | e2e         | E2E-4 (full); FR-23 end-to-end through real HTTP + Mongo                                                                          |
| `apps/studio/e2e/workflows/workflow-as-tool-nesting-memory.spec.ts` _(LANDED Phase 6, scaffold)_ | e2e         | E2E-5 — `test.skip` scaffold per GAP-018                                                                                          |

> **Coverage absorption note (post-impl-sync 2026-04-28).** During implementation, three originally-planned standalone files were absorbed into broader existing files rather than created as separate suites: (a) **INT-7 cross-surface fact namespace** is covered inside `fact-store-workflow-adapter.test.ts` because the adapter IS the cross-surface boundary; a separate spec would have duplicated identical fixtures. (b) **INT-14 / INT-15 end-user identity matrix** is covered in `workflow-tool-executor-projection.test.ts` (the projection step is where the matrix executes); the channel-artifact path is also exercised by the E2E-4 erasure test. (c) **INT-16 workflow-scope global regression** is the same surface as UT-3 and lives in `fact-store-workflow-adapter.test.ts`. The original §8 mapping listed all three as separate `*.integration.test.ts` files; the mapping above reflects what actually shipped.

Existing test files referenced for pattern (not modified):

- `apps/workflow-engine/src/__tests__/route-integration.test.ts` (supertest route mount pattern)
- `apps/workflow-engine/src/__tests__/helpers/setup-mongo.ts` (`MongoMemoryServer` helper)
- `apps/studio/e2e/workflows/helpers.ts` (`loginAndSetup`, `createWorkflowViaUI`, `runWorkflow`)
- `apps/studio/e2e/workflows/workflow-function-node.spec.ts` (function-node Zustand configuration pattern)

---

## 9. Open Testing Questions

1. **Isolate-thread pool sizing**: HLD Concern #9 calls for per-tenant isolate-thread budgeting but defers the exact pool size to LLD. The test for `applySyncPromise` blocking behavior depends on knowing the cap. **Action**: re-visit once LLD locks the pool size; add a deadlock-prevention regression test.
2. **Audit log queryability**: HLD §9 Open Question #1 — if v1.1 promotes the audit log from stdout-only to a queryable surface (`fact_audit` collection), the audit assertions in INT-8 should switch from log-sink reads to collection reads. **Action**: defer; revisit at v1.1 RFC.
3. **Non-contact identity erasure (`customerId`, `anonymousId`, channel-artifact)**: HLD §9 Open Question #4 — if a non-contact cascade entry point doesn't exist, LLD will scope a new one. The INT-9 cascade test currently covers the contact path only; parallel coverage must be added once LLD enumerates the additional entry points.
4. **Studio E2E timing**: Studio E2E tier (`pnpm e2e:workflows`) currently runs nightly. The five new E2E specs add ~15 min of wall-clock time. **Action**: confirm with Studio E2E owners whether they belong in the `tier-1` smoke pack or stay in the nightly tier.

---

## 10. Test Notes

- Per CLAUDE.md "Test Architecture": all integration tests use real fact-store (`MongoMemoryServer`), real isolated-vm, real Express middleware. No `vi.mock` of `@agent-platform/*`, `@abl/*`, or relative imports.
- Per CLAUDE.md "E2E Test Standards": E2E tests interact only via HTTP API. No Mongoose models imported. No TODO stubs. Real running services start at `port: 0`.
- The `requireServiceAuth` body-`tenantId` cross-check is a **prerequisite infrastructure change** (HLD §8.1). It lands in a separate first commit and benefits every internal route group (tools, chat, callback, memory). INT-2 covers it.
- The `__originAdapter: 'workflow'` marker on `MongoDBFactStore.set()` is a deep guard closing the cross-surface forge vector (HLD Concern #4 c.2). Direct fact-store callers without the marker fail. Only `FactStoreWorkflowAdapter` may bypass.
- Cookie-reset `anonymousId` is intentional: each rotation is a fresh `endUserId` and `memory.user.*` is unreachable across rotations (per spec §4a). INT-15 codifies this so future regressions don't quietly fall back to a tenant-wide scope.
- The keystone regression for this feature is the combination of (a) cross-trigger memory continuity (E2E-2) and (b) fail-closed isolation across tenant/project/user/workflow scopes (INT-2 + INT-7 + INT-14). If those four pass, the rest is enforcement detail.

---

## 11. References

- Feature spec: [`../../features/sub-features/workflow-first-class-memory-and-context.md`](../../features/sub-features/workflow-first-class-memory-and-context.md) (FR-1 .. FR-23)
- HLD: [`../../specs/workflow-first-class-memory-and-context.hld.md`](../../specs/workflow-first-class-memory-and-context.hld.md)
- Oracle log: [`../../sdlc-logs/workflow-first-class-memory-and-context/test-spec.log.md`](../../sdlc-logs/workflow-first-class-memory-and-context/test-spec.log.md)
- CLAUDE.md sections: "Test Architecture — Fix the Code, Not the Test"; "E2E Test Standards"; "Test Integrity"
- Test infrastructure: `apps/workflow-engine/src/__tests__/helpers/setup-mongo.ts`; `apps/studio/e2e/workflows/helpers.ts`
- Service auth: `packages/shared-auth/src/middleware/jwt-verify.ts:163` (`createServiceToken`); `apps/runtime/src/middleware/internal-service-auth.ts:59-73`

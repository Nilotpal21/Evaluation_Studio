# HLD Clarifying Questions Log: Workflow First-Class Memory, Agent Session, and Context

**Feature**: workflow-first-class-memory-and-context
**Phase**: HLD
**Date**: 2026-04-27
**Oracle**: product-oracle (Claude Opus 4.6)

---

## Context Consulted

- `docs/features/sub-features/workflow-first-class-memory-and-context.md` (feature spec)
- `docs/testing/sub-features/workflow-first-class-memory-and-context.md` (test spec)
- `docs/specs/workflows.hld.md` (parent HLD)
- `docs/specs/workflow-as-tool.hld.md` (workflow-as-tool HLD)
- `docs/specs/workflow-function-node.hld.md` (function node HLD)
- `docs/specs/memory-sessions.hld.md` (memory/sessions HLD)
- `docs/specs/session-scope-enforcement.hld.md` (session scope HLD)
- `apps/workflow-engine/src/context/expression-resolver.ts` (expression resolver)
- `apps/workflow-engine/src/handlers/workflow-handler.ts` (workflow handler, context construction)
- `apps/workflow-engine/src/executors/function-executor.ts` (function executor, isolated-vm)
- `apps/runtime/src/services/workflow/workflow-tool-executor.ts` (WF tool executor)
- `apps/runtime/src/services/execution/tool-memory-bridge.ts` (tool memory bridge)
- `apps/runtime/src/services/stores/mongodb-fact-store.ts` (fact store)
- `apps/runtime/src/middleware/internal-service-auth.ts` (internal service auth)
- `apps/runtime/src/routes/internal-tools.ts` (internal tools route)
- `apps/runtime/src/routes/internal-chat.ts` (internal chat route)
- `apps/runtime/src/server.ts` (route mounts at L959-976)
- `packages/database/src/cascade/cascade-delete.ts` (cascade delete)
- `packages/database/src/models/fact.model.ts` (fact model schema)
- `apps/runtime/src/contexts/contact/use-cases/cascade-delete-contact.ts` (contact erasure)
- `apps/runtime/src/contexts/contact/infrastructure/contact-mongo-repository.ts` (contact repo)
- `apps/workflow-engine/src/diagnose/flag-catalog.ts` (feature flag catalog)
- `CLAUDE.md` (platform invariants)

---

## Answers

### A1: Memory write-through model in function nodes

**Classification**: DECIDED
**Answer**: Use option (b) — sync host-callback per op via `ivm.Reference` / `ivm.Callback`. Each memory operation (`memory.workflow.get()`, `.set()`, `.delete()`) crosses the isolate boundary as a synchronous host callback, which then makes an async HTTP call to runtime. The reconciliation with FR-21 is straightforward: the host-side callback returns success/failure synchronously to the isolate (via the `ivm.Callback` return value or by throwing), so mid-step errors propagate into the script as exceptions.

**Reasoning**: The existing function-executor already uses the `ivm.Callback` pattern for `_contextWrite` (function-executor.ts L116-120) and `_console_log` (L103-109). Each callback crosses the isolate boundary synchronously and buffers host-side. For memory, the callback wraps an async HTTP call (workflow-engine to runtime memory route); the script execution pauses at the callback invocation point until the host resolves.

However, `ivm.Callback` is inherently synchronous inside the isolate. The memory HTTP call is async on the host side. The implementation must use `ivm.Reference` with `applySync()` calling back from the host, or compile the user script as async and use `ivm.Module` evaluation with async callbacks. The simpler path is: serialize memory ops as synchronous host callbacks where the host blocks on the HTTP call (using synchronous waiting or a dedicated thread). This is the pattern `isolated-vm` supports natively via `new ivm.Callback(fn, { async: false })` combined with the host-side HTTP call.

Key constraints:

- Each `memory.set/get/delete` is one cross-isolate + one HTTP roundtrip (~5-20ms per op).
- FR-20 caps at 100 writes per run, so worst case is ~2s total for writes — within the function-node timeout budget (5-60s).
- FR-21 is satisfied: each op throws on failure at the call site. No buffered-flush ambiguity.
- The in-run memory projection is updated after each successful write (FR-14), so subsequent reads in the same function node see updated values.

**Risk**: LOW. The existing `ivm.Callback` pattern is proven in this codebase. HTTP roundtrip per op is acceptable given the 100-write cap.

---

### A2: Workflow-engine to runtime memory seam

**Classification**: DECIDED
**Answer**: New dedicated route group `/api/internal/memory` on runtime, NOT extending `/api/internal/tools`.

**Reasoning**: The existing internal route layout (runtime `server.ts` L959-976) has clear separation of concerns:

- `/api/internal/tools` — tool execution (one route: `POST /execute`)
- `/api/internal/chat` — agent invocation (one route: `POST /agent`)
- `/api/internal/workflow-callback` — push callbacks from workflow-engine

Memory operations are a distinct domain from tool execution. The `/api/internal/tools/execute` route loads project tools via `loadProjectToolsAsIR`, wires MCP clients, creates a `ToolBindingExecutor`, and runs a tool — none of which applies to memory get/set/delete. Mixing memory verbs into this route would require conditional branching that violates single-responsibility.

The new route group should be:

- `POST /api/internal/memory/get` — read a fact
- `POST /api/internal/memory/set` — write a fact (with TTL, audit)
- `POST /api/internal/memory/delete` — delete a fact (tombstone, audit)
- `POST /api/internal/memory/get-many` — batch read for projection loading

All protected by the existing `requireServiceAuth` middleware (same pattern as L965-966).

Mount: `app.use('/api/internal/memory', requireServiceAuth, internalMemoryRouter);`

**Source**: `apps/runtime/src/server.ts:965-976` (internal route layout), `apps/runtime/src/middleware/internal-service-auth.ts` (auth pattern).
**Risk**: LOW. Follows established internal route pattern exactly.

---

### A3: `wf:<workflowId>:<key>` prefix application point

**Classification**: DECIDED
**Answer**: Apply the prefix at the **runtime memory route** (option i — the new `/api/internal/memory` translation layer on runtime). The reserved-prefix author-write guard also lives at the runtime memory route.

**Reasoning**:

1. The workflow-engine memory client sends the logical memory operation: `{ scope: 'workflow', workflowId, key: 'foo', value: ... }`.
2. The runtime memory route translates `scope: 'workflow'` into `key = 'wf:<workflowId>:foo'` and delegates to the project-scoped `MongoDBFactStore` with `userId = '__project__'` (the existing `PROJECT_SCOPE_USER_ID` sentinel from `mongodb-fact-store.ts` L86).
3. For `scope: 'project'`, the key passes through unchanged to the project-scoped fact store.
4. For `scope: 'user'`, the route uses the `endUserId` as the `userId` parameter to the user-scoped `MongoDBFactStore`.

This keeps the `MongoDBFactStore` clean and reusable — it has no knowledge of workflow prefixes. The prefix is a workflow-specific concern owned by the translation layer where both the fact store and the workflow contract are visible.

The reserved-prefix write guard (`wf:`, `_meta:`, `_system:`, `_audit:`) also lives at this translation layer because:

- It intercepts author-submitted keys before they reach the fact store.
- The `wf:` prefix is applied BY the translation layer for workflow scope; authors writing `wf:*` keys directly would collide with the system prefix.
- Other reserved prefixes are future-reserved for system metadata.

**Source**: Feature spec section 9 Data Model (key relationships), `mongodb-fact-store.ts` L86 (`PROJECT_SCOPE_USER_ID`).
**Risk**: LOW. Clean separation of concerns.

---

### A4: agentSession/agentContext enrichment source

**Classification**: DECIDED
**Answer**: Push-at-invoke. The `workflow-tool-executor.ts` enriches `triggerMetadata` at invocation time with the full session projection needed for `agentSession` and `agentContext`.

**Reasoning**:

1. **Latency**: Push-at-invoke adds zero latency to workflow execution start. Pull-at-exec would add one HTTP roundtrip (~10-50ms) at the start of every agent-triggered workflow run plus a new internal endpoint to maintain.
2. **Existing pattern**: The workflow-tool-executor already pushes context into `triggerMetadata` (L182-198): `source`, `sessionId`, `agentName`, `triggerId`. This is the established seam for agent-to-workflow context transfer.
3. **Coupling is acceptable**: The projection schema is a positive-list (FR-18) with ~12 fields that change rarely. The `triggerMetadata` contract is already version-coupled to the executor — adding `agentSession` and `agentContext` sub-objects follows the same pattern.
4. **Data freshness**: The projection is a snapshot at invocation time. The feature spec explicitly states "No live pull-through reads against arbitrary runtime session state after workflow start" (Non-Goals, section 2). So a stale-by-design snapshot is correct.
5. **Security**: The positive-list projection is applied at the push site (workflow-tool-executor), not at the workflow-engine. This keeps the sanitization logic co-located with the session access — the workflow-engine never needs to know which session fields are safe.

The enriched `triggerMetadata` shape:

```
triggerMetadata: {
  source: 'agent_tool',
  sessionId, agentName, triggerId,
  agentSession: { sessionId, agentName, channel, source, endUserId, locale, startedAt, lastActivityAt },
  agentContext: { caller, invocation, attachments, messageMetadata }
}
```

The workflow-handler's `buildWorkflowContext()` (workflow-handler.ts L240-282) then lifts `triggerMetadata.agentSession` and `triggerMetadata.agentContext` into the top-level `WorkflowContextData` during context construction.

**Source**: `workflow-tool-executor.ts` L182-198 (existing triggerMetadata push), `workflow-handler.ts` L240-282 (context construction).
**Risk**: LOW. Existing pattern, additive change.

---

### I1: Fact-store value size limit

**Classification**: DECIDED
**Answer**: Option (b) — keep `MAX_FACT_VALUE_SIZE = 10 KB` in `MongoDBFactStore` unchanged, enforce the 64 KB limit at the workflow memory route boundary only.

**Reasoning**:

1. The 10 KB limit in `MongoDBFactStore` (L36-37) was chosen deliberately: "FactStore is for preferences and small values, not blob storage" (comment in the error message, L128). Bumping to 64 KB globally changes the contract for ALL fact-store consumers — code tools, REMEMBER/RECALL, and any future callers.
2. Tool-memory-bridge callers (`tool-memory-bridge.ts`) currently expect the 10 KB limit. Bumping globally would silently allow larger writes from code tools, which was never the intent.
3. The workflow memory route is a new boundary that can enforce its own limit. FR-20 says "value size <= 64 KB serialized" — this is a workflow-specific quota.
4. Implementation: the runtime memory route validates serialized value size <= 64 KB before delegating to the fact store. For the fact store to accept values > 10 KB, the workflow memory route constructs a `MongoDBFactStore` with a custom config that overrides the value-size limit, OR bypasses the fact-store size check by calling the Mongoose model directly (less clean), OR the `MongoDBFactStore` is extended to accept a configurable `maxValueSize` parameter (cleanest).

**Preferred approach**: Add an optional `maxValueSize` parameter to `FactStoreConfig` / `MongoDBFactStore` constructor, defaulting to 10 KB. The workflow memory route passes `maxValueSize: 64 * 1024` when constructing its fact store instance. All existing callers continue to use the 10 KB default.

**Source**: `mongodb-fact-store.ts` L36-37 (`MAX_FACT_VALUE_SIZE`), feature spec FR-20.
**Risk**: LOW. Existing callers unaffected; workflow boundary enforces its own contract.

---

### I2: End-user erasure cascade

**Classification**: ANSWERED
**Answer**: There IS an existing cascade for end-user (contact) erasure: `CascadeDeleteContact` at `apps/runtime/src/contexts/contact/use-cases/cascade-delete-contact.ts`. However, it does NOT currently cascade to facts.

The `CascadeDeleteContact.execute()` method (L58-121) performs: load contact -> clean up resolution keys -> scrub messages -> ClickHouse cleanup -> nullify encryption salt -> hard-delete contact document -> audit. It does NOT call `Fact.deleteMany()` for the contact's facts.

The `cascade-delete.ts:deleteUser()` (L438-489) operates on `User._id` — workspace/admin users, not end-user contacts. It also does NOT cascade to facts.

Facts for end-users are stored with `userId = contactId` (or `customerId`/`anonymousId` depending on resolution) in the fact store. Erasure of `memory.user.*` requires a new step in the `CascadeDeleteContact` pipeline.

**Precedent for adding**: `CascadeDeleteContact` already accepts optional callbacks via constructor injection (L50-56): `scrubMessages`, `clickhouseCleanup`, `resolutionKeyCleanup`. The pattern for adding fact erasure is to add another optional callback: `eraseFacts?: (tenantId: string, contactId: string) => Promise<number>` — or to add it directly in the `execute()` method before `hardDelete`.

**Trigger event**: The existing GDPR route is `DELETE /:id/gdpr` in `apps/runtime/src/routes/contact-merge.ts:139`. This calls `cascadeDeleteContact.execute()`. The fact-erasure step would be wired during context creation (the `createContactContext()` factory).

**Source**: `cascade-delete-contact.ts` L49-121, `contact-mongo-repository.ts` L218-220, `contact-merge.ts` L139, feature spec FR-23.
**Confidence**: HIGH

---

### I3: Audit log destination + tombstone implementation

**Classification**: DECIDED
**Answer**: (a) Structured logs via `createLogger` to stdout for audit entries; (i) soft-delete via `deletedAt`/`isDeleted` on the existing `Fact` model for tombstones.

**Audit destination reasoning**:

1. Option (a) is the simplest and most aligned with the platform. The workflow-engine already uses `createLogger('workflow-engine:...')` everywhere. Audit entries go to stdout structured JSON -> log aggregator (ELK/Loki). This is the same pattern as the existing workflow execution events (workflows.hld.md section 3.11: "execution records serve as audit trail").
2. Option (b) (new MongoDB collection `fact_audit`) adds a new collection, write amplification on every memory op, and a new retention/cleanup concern. The feature spec says audit is "separate from operational tracing" — but structured logs already go to a separate pipeline from traces.
3. Option (c) (ClickHouse) would be ideal for high-volume forensic queries, but the workflow-engine does not have a ClickHouse client today, and the audit volume (capped at 100 writes/run) does not justify the infrastructure.

Implementation: the runtime memory route emits `log.info('memory.audit', { tenantId, projectId, workflowId, runId, scope, key, actorType, actorId, endUserId, ttl, operation: 'set'|'delete' })` on every `set` and `delete`. The structured log format makes it queryable in the log aggregator.

**Tombstone reasoning**:

1. Option (i) (soft-delete via `deletedAt`/`isDeleted`) on the existing `Fact` model is simpler and keeps audit reconstruction possible with a single collection query. Adding `deletedAt: Date | null` and `isDeleted: boolean` fields to the `Fact` schema is a non-breaking additive change.
2. Option (ii) (separate `fact_tombstones` collection) adds a new collection, cross-collection join logic for audit reconstruction, and a new cleanup concern.
3. The existing `Fact` model's TTL index (`expiresAt`, L64) can be leveraged: tombstoned facts set `expiresAt` to a retention window (e.g., 90 days from deletion) so they auto-expire.

**Note**: The existing `MongoDBFactStore.delete()` (L202-208) does a hard `deleteOne`. For tombstone semantics, this becomes a soft-delete: `updateOne({ ...ownerFilter(), key }, { $set: { isDeleted: true, deletedAt: new Date(), expiresAt: new Date(Date.now() + TOMBSTONE_TTL) } })`. A new `getIncludingDeleted()` method supports audit reconstruction. Regular `get()` filters out `isDeleted: true`.

**Source**: `mongodb-fact-store.ts` L202-208, `fact.model.ts` L39-57 (schema), feature spec FR-22.
**Risk**: LOW for structured logs; MEDIUM for tombstone (requires Fact schema migration, existing `delete` callers need review).

---

### I4: Naming collision check

**Classification**: ANSWERED
**Answer**: No collision found. No existing workflow in the codebase uses `memory`, `agentSession`, or `agentContext` as top-level expression names via `vars` or `trigger.metadata`.

**Evidence**:

- `KNOWN_TOP_LEVEL_KEYS` in `expression-resolver.ts` L157 is `['trigger', 'workflow', 'tenant', 'steps', 'vars']`. The names `memory`, `agentSession`, `agentContext` are NOT in this set.
- Searched `apps/workflow-engine/src/` (all `.ts` and `.json` files) for string literals `"memory"`, `"agentSession"`, `"agentContext"` — zero results.
- Searched `apps/workflow-engine/src/__tests__/` for the same — zero results.
- Searched `apps/runtime/src/__tests__/` and `apps/studio/e2e/` — zero results.
- Searched `apps/workflow-engine/` for `.json`/`.yaml`/`.yml` data files — zero results.

**Current behavior if collision existed**: Because `memory`/`agentSession`/`agentContext` are NOT in `KNOWN_TOP_LEVEL_KEYS`, the expression resolver's `getNestedValue()` (L184) would currently route `{{memory.foo}}` to either `steps.memory.foo` (if a step named "memory" exists) or `vars.memory.foo`. Adding these as new known top-level keys takes precedence and would shadow any `vars.memory` that might exist in a user's workflow.

**Breaking change mitigation**: Since no existing usage was found in the codebase, and the names are sufficiently distinctive that real-world collision is unlikely, no breaking-change strategy is needed. However, the HLD should document that adding `memory`, `agentSession`, `agentContext` to `KNOWN_TOP_LEVEL_KEYS` shadows any same-named vars — existing workflows referencing `{{memory}}` as a vars shorthand would break. Authors can use `{{vars.memory}}` to disambiguate.

**Source**: `expression-resolver.ts` L157 (KNOWN_TOP_LEVEL_KEYS), L184-191 (fallback routing), grep results.
**Confidence**: HIGH

---

### R1: Feature flag granularity

**Classification**: DECIDED
**Answer**: Ship un-flagged. The contract is additive — existing workflows continue to resolve only `trigger`/`workflow`/`tenant`/`steps`/`vars`.

**Reasoning**:

1. **Precedent**: The workflow-as-tool feature (workflow-as-tool.hld.md, section on rollback, concern #11) shipped without a feature flag: "No feature flag in v1." The function-node feature (workflow-function-node.hld.md, concern #10 migration) shipped without a feature flag — the mapping change applies at execution time. Both were additive.
2. **This feature is additive**: The new top-level keys (`memory`, `agentSession`, `agentContext`) only resolve when explicitly referenced in expressions. Existing workflows that don't reference them see zero behavior change. The `KNOWN_TOP_LEVEL_KEYS` set expansion is purely additive.
3. **Existing workflow-engine flags** (`flag-catalog.ts`) are all infrastructure/operational flags (outbox, dual-read, TTL, Kafka). There is no precedent for feature-level flags in the workflow-engine.
4. **Rollback**: If a critical issue is found, revert the commit(s). The feature is fully additive and opt-in (a workflow author must explicitly use the new expression names or memory API). No data migration is involved.

**Risk**: LOW. Matches two prior additive workflow-context expansions.

---

### R2: Phased rollout within v1

**Classification**: DECIDED
**Answer**: Ship reads-only first (agentSession + agentContext read-only in expressions and function nodes, plus memory reads in expressions), then writes (memory.set/delete in function nodes + audit + tombstones) in a second commit.

**Reasoning**:

1. **Feature spec section 13** work breakdown stages the work: step 1-2 are contract + expression/function-node read surfaces; step 3 is persistent memory writes; step 4 is agent context wiring; step 5 is authoring; step 6 is governance.
2. **Risk separation**: The read path (expression resolution, context materialization, deep-freeze) is lower risk — it's pure data projection with no persistence side effects. The write path (HTTP to runtime, fact-store mutation, audit emission, tombstone semantics, TTL enforcement, quota enforcement) has more failure modes and more integration surface.
3. **Commit discipline**: Per CLAUDE.md, "one concern per commit, max 40 files, max 3 packages." Splitting reads from writes naturally produces two focused commits that each stay within these bounds.
4. **Testability**: Read-only behavior can be fully tested with unit and integration tests against the expression resolver and function executor. Write behavior requires integration with the runtime memory route and fact store. Splitting allows the first commit to land with confidence before wiring the full persistence path.

**Recommended commit sequence**:

- Commit 1: `WorkflowContextData` expansion + expression resolver + function-node read-only globals + agentSession/agentContext materialization + memory projection loading. Zero writes.
- Commit 2: Runtime internal memory route + workflow-engine memory client + function-node memory.set/delete/get + audit emission + tombstone semantics + quota enforcement + erasure cascade wiring.

**Risk**: LOW. Natural split along the read/write boundary.

---

### R3: Biggest technical risk

**Classification**: DECIDED
**Answer**: Ranked from highest to lowest risk:

**(a) isolated-vm async memory ops correctness — HIGHEST RISK.**

The function-executor today runs user scripts synchronously (`script.runSync`, function-executor.ts L217). Memory operations require HTTP calls to runtime, which are inherently async. The `ivm.Callback` mechanism supports async callbacks, but integrating async host callbacks with the synchronous script execution model is the most novel engineering in this feature. Incorrect implementation could cause:

- Script deadlocks (callback waits for HTTP, script waits for callback)
- Silent data loss (callback returns before HTTP completes)
- Timeout miscounting (HTTP latency not accounted in script timeout)

Mitigation: prototype the async callback pattern early; run isolated-vm smoke tests before full implementation.

**(b) Fact-store contention under high workflow-write load — MEDIUM RISK.**

Project-scoped facts are now write-shared between code tools (`tool-memory-bridge.ts`) and workflow memory. The `MongoDBFactStore.set()` uses `findOneAndUpdate` with upsert (L136-156), which is atomic per key but contends on the compound unique index `{ tenantId, userId, projectId, scope, key }` (fact.model.ts L63). Under high concurrent workflow load (many runs writing the same project-scoped key), MongoDB write locks on that index could cause latency spikes. The 100-writes-per-run cap helps, but projects with many concurrent workflows hitting the same keys could still contend.

Mitigation: document last-write-wins semantics clearly; recommend unique keys per event.

**(d) Cross-user leakage in `memory.workflow.*` — MEDIUM RISK.**

`memory.workflow.*` is intentionally workflow-global (shared across all invokers). If an author stores per-user PII in workflow scope instead of user scope, it leaks across end users. This is a documentation/education risk, not a code bug, but the consequence (privacy violation) is severe.

Mitigation: authoring docs, Studio helper copy, lint warning if key pattern suggests per-user intent in workflow scope.

**(c) Expression-resolver perf regression from new top-level objects — LOW RISK.**

The expression resolver (L51, L63) uses `String.replace(EXPRESSION_PATTERN, ...)` which iterates over matches and calls `getNestedValue()`. Adding 3 new entries to `KNOWN_TOP_LEVEL_KEYS` (L157) changes a `Set.has()` check — O(1). The memory projection is loaded once at workflow start and injected into `WorkflowContextData`; it's not fetched per-expression. No meaningful perf regression.

**Source**: function-executor.ts L88-217 (isolated-vm usage), mongodb-fact-store.ts L136-156 (write path), fact.model.ts L63 (unique index), expression-resolver.ts L51-77 (resolution loop).

---

## Decisions Made

| #   | Decision                                                             | Rationale                                                                                                                | Risk |
| --- | -------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------ | ---- |
| D-1 | Sync host-callback per memory op in isolated-vm (A1)                 | FR-21 requires mid-step error semantics; existing ivm.Callback pattern proven; 100-write cap bounds latency              | Med  |
| D-2 | New `/api/internal/memory` route group on runtime (A2)               | Separation of concerns; matches existing internal route layout; tool-execute route is wrong abstraction for memory       | Low  |
| D-3 | Apply `wf:<workflowId>:<key>` prefix at runtime memory route (A3)    | Keeps MongoDBFactStore clean; translation layer owns both workflow contract and fact-store delegation                    | Low  |
| D-4 | Push-at-invoke for agentSession/agentContext (A4)                    | Zero latency at workflow start; matches existing triggerMetadata push pattern; snapshot-by-design per non-goals          | Low  |
| D-5 | Keep fact store at 10KB, enforce 64KB at workflow memory route (I1)  | Protects existing callers; workflow-specific quota at workflow-specific boundary; configurable maxValueSize on FactStore | Low  |
| D-6 | Structured logs for audit, soft-delete tombstones on Fact model (I3) | Simplest audit path; tombstones keep audit reconstructible; additive schema change on Fact                               | Med  |
| D-7 | Ship un-flagged (R1)                                                 | Precedent: workflow-as-tool and function-node shipped un-flagged; fully additive; no migration                           | Low  |
| D-8 | Reads-only first, writes second commit (R2)                          | Risk separation; commit discipline; testability; natural read/write boundary                                             | Low  |
| D-9 | Biggest risk is isolated-vm async memory ops (R3)                    | Novel integration pattern; must prototype early                                                                          | Med  |

## Escalations

None. All questions were resolvable from existing code patterns, feature spec, and platform principles.

---

## Note on Decision Drift

Decisions A1 / R3 / D-9 above reference `ivm.Callback` as the cross-isolate sync mechanism. The HLD round-1 audit established that `ivm.Callback` cannot make synchronous HTTP calls; the design was switched to `ivm.Reference.applySyncPromise()`. The intent of those oracle decisions (sync-from-script semantics, errors propagate to call site) is preserved; only the specific `isolated-vm` API is updated. The HLD itself is the normative source.

---

## HLD Audit Rounds (phase-auditor)

### Round 1 — NEEDS_REVISION

Three CRITICAL findings:

- `requireServiceAuth` does NOT cross-check `tenantId` body→JWT today (only `projectId`). v1 must extend the middleware as a prerequisite first commit.
- Reserved-prefix bypass via `tool-memory-bridge.ts`: any caller could write `wf:`-prefix keys forging `memory.workflow.*`. Add a second prefix guard at `MongoDBFactStore.set()` itself.
- `ivm.Callback` cannot perform synchronous HTTP I/O. Switch to `ivm.Reference.applySyncPromise()` (blocks isolate worker thread; isolate-pool budgeting required).

Plus HIGH: Mermaid HTTPS→HTTP and label cleanup; non-agent trigger projection-load coverage; rollback plan needs pre-revert tombstone cleanup; snapshot-isolation note; `requireServiceAuth` extension as sequenced prerequisite; `WorkflowExecution.triggerMetadata` Mongoose field row.

### Round 2 — APPROVED

All round-1 fixes verified. One MEDIUM remaining: FR-N traceability — only 9 of 23 FRs were explicitly tagged. Round 3 fix.

### Round 3 — APPROVED

§4a FR Traceability table added (23 rows, FR-1..FR-23). Two MEDIUM and two LOW labeling cleanups (FR-12/13/17 traceability cells, two cross-document section refs) — all applied.

### Final state

- Design-lint: 19 PASS, 1 WARN (open questions remaining — expected), 0 missing. 95% completeness.
- Verdict: APPROVED for LLD.
- 4 open questions remain (audit retention, projection-load cardinality, test-spec drift to `/test-spec`, non-contact erasure paths) — all scoped to LLD or follow-up tickets.

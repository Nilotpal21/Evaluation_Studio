# Trace Event Consolidation — Single ClickHouse Table

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** Eliminate the `abl_platform.traces` table and the `trace-bridge.ts` translation layer. All persistent events go to `platform_events` via the EventStore. Memory TraceStore exists only for real-time WebSocket broadcast to the connected debug panel on the same pod.

**Architecture:** The trace-emitter emits events in the platform event vocabulary (dotted names like `llm.call.completed`) directly. The EventStore writes to `platform_events` in ClickHouse — the single persistent store. `span_id` and `parent_span_id` columns are added to `platform_events` so it can serve Observatory debugging. The `traces` table, `ClickHouseTraceStore`, `trace-bridge.ts`, and all reverse-mapping code are removed. Memory TraceStore remains for WebSocket broadcast only (not persistence — it does not survive pod restarts or multi-pod deployments).

**Tech Stack:** ClickHouse, TypeScript, Express, WebSocket, Zod, `@agent-platform/shared-observability` (ALS-based trace context via `createObservabilityMiddleware` + `getCurrentTraceId`/`getCurrentSpanId` from `@abl/compiler/platform`)

**Dependency:** This plan assumes the Trace Readiness plan is complete — i.e., `createObservabilityMiddleware` from `@agent-platform/shared-observability` is mounted on all Express servers, WebSocket handlers enter `runWithObservabilityContext` per-turn, and BullMQ workers restore trace context from job payloads. With that in place, `getCurrentTraceId()` and `getCurrentSpanId()` are available in all async code paths, and the trace-emitter can read trace/span IDs from the ALS rather than threading them through function parameters.

**Performance considerations:**

- `platform_events` already uses `BufferedClickHouseWriter` (10K batch / 5s flush) — same write performance as traces table
- Adding `span_id`/`parent_span_id` are two String columns with ZSTD compression — negligible storage overhead
- Bloom filter index on `span_id` enables efficient span-tree queries
- Removing the trace-bridge eliminates per-event async bridge loading + JSON serialize/parse round-trip
- Memory TraceStore remains for zero-latency WebSocket broadcast (no ClickHouse query on live sessions)

**Retention & compliance:**

- `platform_events` has 730-day retention (vs 90-day on traces) — better for compliance and audit
- GDPR cascade hooks already wired on EventStore (`deleteBySessionIds`, `deleteTenant`)
- Encryption-at-rest via `_enc` column and `ClickHouseEncryptionInterceptor` already present on `platform_events`
- Category-based TTL can be added later if debug events need shorter retention than analytics events

---

## Review Findings & Decisions

This section documents gaps found during review and decisions made after the original plan was drafted.

### Decision: ClickHouse is mandatory infrastructure

ClickHouse is required at startup, like MongoDB and Redis. If unavailable, the server fails to start.

**Impact on `USE_MONGO_CLICKHOUSE`:** This flag gates MORE than just traces — it also gates:

1. `dual-write-message-store.ts` — messages written to ClickHouse
2. `clickhouse-metrics.ts` — metrics collection
3. `gdpr-cascade.ts` — GDPR cleanup in ClickHouse
4. `apps/runtime/src/index.ts` — ClickHouse client initialization
5. `apps/runtime/.env.example` — documented as optional
6. Several test files that toggle this flag

**Decision:** Rename `USE_MONGO_CLICKHOUSE` → `CLICKHOUSE_ENABLED` (default `true`) OR simply remove the flag entirely and make ClickHouse mandatory. The trace-specific gates (`isClickHouseTraceEnabled`) are deleted. The non-trace gates need individual evaluation — they protect non-trace features (messages, metrics) that may have their own readiness concerns.

**OPEN QUESTION 1:** Should we make ALL ClickHouse features mandatory in one pass (messages, metrics, GDPR cleanup), or only make trace/event persistence mandatory and leave the others gated for now?

### Decision: Kill `logDecision()`, keep only `emitDecision()`

Two decision emission paths exist:

- `logDecision()` in `trace-emitter.ts` (OLD) — emits `data.decisionType`, used by 2 compiler runtimes via trace-forwarder
- `emitDecision()` in `trace-emitter.ts` (NEW) — emits `data.decisionKind`, used by 20+ executor call sites, has verbosity gating and span context

**Decision:** Kill `logDecision()`. Migrate the 2 compiler runtime callers to emit `decisionKind` instead.

**Files requiring migration:**

- `packages/compiler/src/platform/runtimes/digital-runtime.ts:337` — `logDecision({decisionType: 'routing'})` → emit with `decisionKind: 'handoff'`
- `packages/compiler/src/platform/runtimes/workflow-runtime.ts:391` — `logDecision({decisionType: 'escalation'})` → emit with `decisionKind: 'escalation'`
- `packages/compiler/src/platform/core/types.ts:319-327` — `DecisionEvent.data.decisionType` → `decisionKind`
- `packages/compiler/src/platform/stores/trace-store.ts:79` — `LogDecisionParams.decisionType` → update or remove
- `packages/observatory/src/schema/trace-events.ts:240` — `DecisionData.decisionType` → `decisionKind`
- `apps/runtime/src/services/execution/trace-forwarder.ts:47-52` — `logDecision` interface uses `decisionType`

### Decision: Canonical decision field name is `decisionKind`

Three field names exist across the system:
| Location | Field | Values |
|----------|-------|--------|
| `emitDecision()` (trace-emitter) | `data.decisionKind` | 11 DecisionKind values |
| `logDecision()` (trace-emitter) | `data.decisionType` | `'routing' \| 'escalation' \| 'handoff' \| 'constraint'` |
| UI (SpanTree, NodeDetailPanel) | `data.kind` | whatever arrives |
| trace-bridge `mapDecisionData()` | `data.decision_type` | always `'routing'` (broken) |

**Canonical:** `decisionKind` everywhere. The 11 `DecisionKind` values from `trace-helpers.ts` are the source of truth:
`handoff`, `delegation`, `flow_transition`, `field_validation`, `escalation`, `completion`, `constraint_check`, `guardrail_check`, `gather_extraction`, `correction`, `data_mutation`

### Decision: Metadata contract for decision events

Executors emit varying metadata fields alongside `decisionKind`. The UI needs a consistent contract.

**Current state (what executors emit):**
| Field | Emitted by | Description |
|-------|-----------|-------------|
| `decisionKind` | all | required — the decision type |
| `outcome` | most executors | what was decided ("approved", "rejected", agent name) |
| `reason` / `reasoning` | most executors | why the decision was made |
| `candidates` | handoff, delegation | list of possible targets |
| `selected` / `selectedReason` | handoff, delegation | which candidate was chosen and why |
| `conditions` | constraint_check, guardrail | conditions that were evaluated |
| `passed` / `success` | constraint_check, guardrail | whether the check passed |
| `model` | LLM-based decisions | which model made the decision |
| `agentName` | handoff, delegation | target agent |
| `fromAgent` / `toAgent` | handoff | handoff source and target |
| `constraint` | constraint_check | the constraint expression |
| `fieldName` / `fieldValue` | field_validation, gather_extraction | extracted field info |

**OPEN QUESTION 2:** Should we standardize on `outcome` vs `reason` vs `reasoning`? Currently executors use all three inconsistently. The UI reads `reason` but most executors emit `outcome`.

**OPEN QUESTION 3:** Should we define a TypeScript interface for each `DecisionKind`'s expected metadata, or keep it as `Record<string, unknown>` with documentation?

### Decision: No backward compatibility required (DB / Runtime / Studio)

**Assumptions:**

- **DB:** Old `abl_platform.traces` data is acceptable to lose. No backfill script. New deployments never create the table.
- **Runtime:** All callers change in the same pass. No migration shims, no dual-emit, no feature flags.
- **Studio:** UI components can be recreated for better design. The `DecisionCard` rewrite is folded into the main plan (not a post-consolidation backlog item).

**Impact:** This resolves C4 (no backfill needed) and simplifies every other task — no conditional code paths, no old-field fallbacks.

### Decision: Fix EventRegistry silent drops (C1)

The EventRegistry rejects unknown event types and silently drops them (`event-emitter.ts:54`). After consolidation, trace-emitter writes dotted types like `agent.decision`, `flow.step.entered`, `system.error` — most of which are not registered.

**Fix:** Register all mapped dotted event types in EventRegistry (29 source keys map to 27 unique dotted targets; `llm.call.failed` and `tool.call.failed` are generated at emit time and rely on the permissive fallback since they share data shapes with their `.completed` counterparts). Add a permissive fallback for unmapped types (log warning, don't drop). This is a new Task 3b.

### Decision: Fix Zod schema rejection (C2 + C3)

Two related problems:

- C2: `AgentDecisionDataSchema` requires `{ decision_type, decision }` — rejects `{ decisionKind, outcome }`
- C3: trace-bridge normalized camelCase→snake_case (e.g., `tokensIn`→`input_tokens`). Without it, Zod schemas reject raw executor data.

**Fix:** Drop data normalization entirely. Update Zod schemas to accept camelCase field names.

Rationale: No backward compat means no existing snake_case data in `platform_events` to worry about. Executors emit camelCase → ClickHouse stores camelCase (in the JSON `data` column) → UI reads camelCase. One vocabulary throughout. This avoids the read-side denormalization problem: if we normalized to snake_case for storage, the UI would get snake_case from ClickHouse but camelCase from live WS sessions — two different field name conventions for the same data.

The 14 Zod schema files in `packages/eventstore/src/schema/events/` are updated to accept camelCase field names with `.passthrough()` for forward compatibility. Pipeline-engine queries (Task 7b) use camelCase `JSONExtract*()` calls.

### Decision: Resolve trace-forwarder bypass (H12, was OQ-5)

`trace-forwarder.ts` writes to memory TraceStore only — compiler runtime events never reach ClickHouse.

**Fix:** Wire trace-forwarder through `trace-emitter.emit()` so events flow through the unified pipeline (ClickHouse persistence + WS broadcast). The forwarder becomes a thin adapter that maps compiler `TraceContextManager` events to `trace-emitter.emit()` calls. This is a new Task 7c.

### Decision: Resolve `USE_MONGO_CLICKHOUSE` scope (was OQ-1)

Only remove trace-specific gates in this plan. Leave `USE_MONGO_CLICKHOUSE` for non-trace features (messages, metrics, GDPR). Rename deferred to a separate follow-up.

### Decision: Decision metadata fields (was OQ-2 + OQ-3)

Keep `Record<string, unknown>` with documentation (no typed interfaces per kind — too much overhead for 11 kinds). Standardize on `outcome` (what was decided) + `reasoning` (why). Deprecate `reason`.

### Review gap: Additional files missed by original plan

**67 total gaps found** across three categories:

#### A. Decision field alignment (17 gaps)

Files not in original plan that read decision fields:

1. `apps/studio/src/components/observatory/EventTimeline.tsx:311` — reads `data.decisionType`
2. `apps/studio/src/components/analytics/TracesExplorerTab.tsx:1661-1662` — reads `data.decision_type` (snake_case!)
3. `apps/studio/src/components/observatory/SpanTree.tsx:482` — decisions list reads `data?.kind` (plan had SpanTree:364 but missed this second occurrence)
4. Compiler type definitions (5 files listed in "Kill logDecision" section above)

#### B. Trace consolidation (30 gaps)

Files that reference ClickHouse traces table or `isClickHouseTraceEnabled`:

1. `apps/runtime/src/routes/sessions.ts:739` — export endpoint uses `queryClickHouseCanonicalTraces()`
2. `apps/runtime/src/routes/sessions.ts:877` — generations endpoint uses `queryClickHouseCanonicalTraces()`
3. `apps/runtime/src/routes/sessions.ts:1068` — span-tree via `getClickHouseTraceStore().getTrace()` (NOT `queryClickHouseCanonicalTraces` — uses ClickHouseTraceStore directly, removed in Task 8)
4. `apps/runtime/src/routes/sessions.ts:2640` — metrics endpoint uses `queryClickHouseCanonicalTraces()`
5. `packages/pipeline-engine/src/pipeline/services/conversation-reader.ts:358` — queries `abl_platform.traces`
6. `packages/pipeline-engine/src/pipeline/services/read-message-window.service.ts:152` — queries `abl_platform.traces`
7. `packages/pipeline-engine/src/pipeline/services/compute-tool-effectiveness.service.ts:71` — queries `abl_platform.traces`
8. `apps/runtime/src/services/execution/trace-forwarder.ts` — writes to memory TraceStore only, events never reach ClickHouse (trace-forwarder must also emit to EventStore, or be wired through trace-emitter)

**OPEN QUESTION 4:** The pipeline-engine services (items 5-7) query `abl_platform.traces` directly with raw SQL. These must be rewritten to query `platform_events` instead. Should this be a separate task or folded into Phase 2?

**OPEN QUESTION 5:** `trace-forwarder.ts` bridges compiler TraceContextManager → memory TraceStore. Events from this path never reach ClickHouse. Should the forwarder call `trace-emitter.emit()` instead of writing directly to TraceStore, so events flow through the unified pipeline?

#### C. Test coverage (20 gaps)

Test files that will break and need updating:

1. `apps/runtime/src/__tests__/trace-emitter.test.ts` — mocks lazy bridge loader
2. `apps/runtime/src/__tests__/dual-write-message-store.test.ts` — toggles `USE_MONGO_CLICKHOUSE`
3. `apps/runtime/src/__tests__/clickhouse-stores.test.ts` — contains `ClickHouseTraceStore` test section (file is `clickhouse-stores`, not `clickhouse-trace-store`)
4. `apps/runtime/src/routes/__tests__/sessions-platform-events.test.ts` — tests reverse type mapping
5. `packages/eventstore/src/__tests__/trace-bridge.test.ts` — tests deleted bridge
6. ~~`sessions-traces.test.ts`~~ — does not exist (removed)
7. ~~`eventstore-singleton.test.ts`~~ — does not exist (removed)

Missing test categories:

- No tests for materialized views after schema changes
- No integration test for trace-forwarder → EventStore path
- No E2E test for Observatory rendering from platform_events

---

## UI Rewrite: Unified Decision Card

### Decision: Option B — Unified card with conditional sections

Instead of 6 separate components with duplicated logic, create one `DecisionCard` component that renders conditional sections based on which metadata fields are present.

### Current state

All 11 decision kinds render identically in `NodeDetailPanel.tsx` — no kind-specific differentiation. The components read `data?.kind` (wrong field), `data?.reason`, `data?.candidates`, `data?.selected`, `data?.conditions`.

### Rewrite scope: 6 components

| Component          | File                              | Current Lines | What Changes                                   |
| ------------------ | --------------------------------- | ------------- | ---------------------------------------------- |
| `DecisionBadge`    | `SpanTree.tsx:363-376`            | 14            | Read `decisionKind`, kind-specific color/icon  |
| `DecisionDetail`   | `NodeDetailPanel.tsx:350-414`     | 65            | Replace with unified `DecisionCard`            |
| Decision header    | `NodeDetailPanel.tsx:169-172`     | 4             | Read `decisionKind`                            |
| Decision summary   | `EventTimeline.tsx:311`           | 1             | Read `decisionKind` instead of `decisionType`  |
| Decision filter    | `useSessionDetail.ts:514`         | 1             | Read `decisionKind` instead of `decisionType`  |
| Decision analytics | `TracesExplorerTab.tsx:1661-1662` | 2             | Read `decisionKind` instead of `decision_type` |

**Excluded:** `StateMachineView` — separate concern, not a decision renderer.

### Unified `DecisionCard` design

```
┌─────────────────────────────────────────────┐
│ [Icon] {DecisionKind label}    [outcome]    │  ← header (always)
├─────────────────────────────────────────────┤
│ Reason: {reason/reasoning/outcome}          │  ← reasoning (if present)
├─────────────────────────────────────────────┤
│ Candidates:                                 │  ← candidates section (if present)
│   ○ agent-a                                 │
│   ● agent-b (selected) — {selectedReason}   │
│   ○ agent-c                                 │
├─────────────────────────────────────────────┤
│ Conditions:                                 │  ← conditions section (if present)
│   ✓ budget > 0                              │
│   ✗ age >= 18                               │
├─────────────────────────────────────────────┤
│ Field: {fieldName} = {fieldValue}           │  ← field section (if present)
├─────────────────────────────────────────────┤
│ Model: gpt-4  Duration: 230ms              │  ← footer metadata (if present)
└─────────────────────────────────────────────┘
```

Kind-specific rendering rules:
| DecisionKind | Icon | Sections shown |
|-------------|------|----------------|
| handoff | ArrowRight | candidates, reasoning |
| delegation | Users | candidates, reasoning |
| flow_transition | GitBranch | reasoning |
| field_validation | CheckSquare | field, conditions |
| escalation | AlertTriangle | reasoning |
| completion | CheckCircle | reasoning |
| constraint_check | Shield | conditions |
| guardrail_check | ShieldAlert | conditions |
| gather_extraction | FormInput | field |
| correction | RotateCcw | reasoning |
| data_mutation | Database | field |

### UI Rewrite (folded into Task 7)

All items below are now part of Task 7 (Phase 2), not a separate backlog:

1. **Create `DecisionCard` component** — `apps/studio/src/components/observatory/DecisionCard.tsx`
2. **Create kind-specific icon/color map** — `apps/studio/src/lib/event-types.ts` (`DECISION_KIND_META`)
3. **Replace `DecisionDetail` in NodeDetailPanel** — swap inline component with `<DecisionCard>`
4. **Replace `DecisionBadge` in SpanTree** — use kind-specific icons and colors from `DECISION_KIND_META`
5. **Update EventTimeline decision summary** — read `decisionKind` + `outcome` (not `decisionType` + `chosen`)
6. **Update TracesExplorerTab** — decision kind filter dropdown with all 11 kinds

---

## Phase 1: Add span columns to platform_events + fix field-name mismatch (non-breaking)

### Task 1: Add `span_id` and `parent_span_id` to `platform_events` schema

**Files:**

- Modify: `packages/database/src/clickhouse-schemas/init.ts` (lines 325-378)
- Modify: `scripts/clickhouse-init/01-init.sql` (platform_events DDL)

**Step 1: Add columns to DDL in init.ts**

In the `platform_events` table DDL (after `agent_name` on line ~338), add:

```sql
    span_id           String               DEFAULT '' CODEC(ZSTD(1)),
    parent_span_id    String               DEFAULT '' CODEC(ZSTD(1)),
```

Add a bloom filter index (after `idx_trace`):

```sql
    INDEX idx_span         span_id                 TYPE bloom_filter           GRANULARITY 4,
```

**Step 2: Mirror changes in `01-init.sql`**

Same column + index additions.

**Step 3: Add ALTER TABLE migration for existing deployments**

Add to the schema init code after the CREATE TABLE statements (idempotent, safe to re-run):

```sql
ALTER TABLE abl_platform.platform_events ADD COLUMN IF NOT EXISTS span_id String DEFAULT '' CODEC(ZSTD(1));
ALTER TABLE abl_platform.platform_events ADD COLUMN IF NOT EXISTS parent_span_id String DEFAULT '' CODEC(ZSTD(1));
```

**Step 4: Build and verify**

Run: `pnpm build --filter=@agent-platform/database`

**Step 5: Commit**

```
feat(database): add span_id and parent_span_id to platform_events table
```

---

### Task 2: Propagate span_id/parent_span_id through EventStore write path

**Files:**

- Modify: `packages/eventstore/src/schema/platform-event.ts` — add `span_id`, `parent_span_id` to PlatformEvent interface
- Modify: `packages/eventstore/src/stores/clickhouse/clickhouse-row-mapper.ts` — map span fields to row
- Modify: `packages/eventstore/src/stores/clickhouse/platform-events-table.ts` — add span columns to DDL
- Modify: `apps/runtime/src/services/trace-emitter.ts` — pass span context in analytics dual-write

**Step 1: Read PlatformEvent interface and row mapper to verify actual signatures**

**Step 2: Add span fields to PlatformEvent**

```typescript
// In PlatformEvent interface:
span_id?: string;
parent_span_id?: string;
```

**Step 3: Add to `ClickHouseEventRow` interface (H8)**

```typescript
// In ClickHouseEventRow interface (clickhouse-row-mapper.ts:16-37), add:
span_id: string;
parent_span_id: string;
```

**Step 4: Map span fields in toRow()**

```typescript
// In toRow():
span_id: event.span_id ?? '',
parent_span_id: event.parent_span_id ?? '',
```

**Step 5: Map span fields in fromRow() (H9)**

```typescript
// In fromRow(), add to the returned PlatformEvent:
...(row.span_id && { span_id: row.span_id }),
...(row.parent_span_id && { parent_span_id: row.parent_span_id }),
```

**Step 6: Update divergent DDL in platform-events-table.ts (M1)**

Add `span_id` and `parent_span_id` columns to the DDL in `packages/eventstore/src/stores/clickhouse/platform-events-table.ts` to match `init.ts`.

**Step 7: Pass span context from trace-emitter dual-write**

In `trace-emitter.ts` `emit()` function (line ~178), add to the analytics event object:

```typescript
span_id: storedEvent.spanId,
parent_span_id: storedEvent.parentSpanId,
```

**Step 8: Build and test**

```bash
pnpm build --filter=@abl/eventstore --filter=@agent-platform/database
pnpm test --filter=@abl/eventstore
```

**Step 9: Commit**

```
feat(eventstore): propagate span_id/parent_span_id to platform_events
```

---

### Task 3: Fix decision field-name mismatch

The runtime emits `data.decisionKind`. The UI reads `data.kind`. The bridge reads `data.decisionType`. All three are different. Align everything on `decisionKind`.

**Files:**

- Modify: `apps/studio/src/components/observatory/SpanTree.tsx:364,482` — `data?.kind` → `data?.decisionKind`
- Modify: `apps/studio/src/components/observatory/NodeDetailPanel.tsx:170,352` — `data?.kind` → `data?.decisionKind`
- Modify: `apps/studio/src/components/observatory/EventTimeline.tsx:311` — `data.decisionType` → `data.decisionKind`
- Modify: `apps/studio/src/components/analytics/TracesExplorerTab.tsx:1661-1662` — `data.decision_type` → `data.decisionKind`
- Modify: `apps/studio/src/hooks/useSessionDetail.ts:514` — `eventData.decisionType` → `eventData.decisionKind`
- Modify: `packages/compiler/src/platform/core/types.ts:319-327` — `DecisionEvent.data.decisionType` → `decisionKind`
- Modify: `packages/compiler/src/platform/stores/trace-store.ts:79` — `LogDecisionParams.decisionType` → `decisionKind`
- Modify: `packages/compiler/src/platform/runtimes/digital-runtime.ts:337` — update logDecision call
- Modify: `packages/compiler/src/platform/runtimes/workflow-runtime.ts:391` — update logDecision call
- Modify: `packages/observatory/src/schema/trace-events.ts:240` — `DecisionData.decisionType` → `decisionKind`
- Modify: `apps/runtime/src/services/execution/trace-forwarder.ts:47-52` — update logDecision interface

**Step 1: Fix all UI consumers**

```typescript
// SpanTree.tsx:364 — Before:
const kind = typeof event.data?.kind === 'string' ? event.data.kind : 'decision';
// After:
const kind = typeof event.data?.decisionKind === 'string' ? event.data.decisionKind : 'decision';

// NodeDetailPanel.tsx:170-171 — Before:
decisions.length > 0 && typeof decisions[0].data?.kind === 'string'
  ? decisions[0].data.kind
// After:
decisions.length > 0 && typeof decisions[0].data?.decisionKind === 'string'
  ? decisions[0].data.decisionKind

// NodeDetailPanel.tsx:352 — same pattern

// SpanTree.tsx:482 — same pattern (second `data?.kind` in decisions list)

// EventTimeline.tsx:311 — Before:
return `${data.decisionType || 'decision'}: ${data.chosen || 'unknown'}`;
// After:
return `${data.decisionKind || 'decision'}: ${data.chosen || 'unknown'}`;

// TracesExplorerTab.tsx:1661-1662 — Before:
data.decision_type
// After:
data.decisionKind

// useSessionDetail.ts:514 — Before:
const decisionType = (eventData.decisionType as string) || 'decision';
// After:
const decisionType = (eventData.decisionKind as string) || 'decision';
```

**Step 2: Fix compiler types and runtimes**

```typescript
// types.ts — DecisionEvent.data.decisionType → decisionKind
// trace-store.ts — LogDecisionParams.decisionType → decisionKind
// digital-runtime.ts:337 — logDecision({decisionType: 'routing'}) → logDecision({decisionKind: 'handoff'})
// workflow-runtime.ts:391 — logDecision({decisionType: 'escalation'}) → logDecision({decisionKind: 'escalation'})
// trace-events.ts:240 — DecisionData.decisionType → decisionKind
// trace-forwarder.ts:47-52 — logDecision interface decisionType → decisionKind
```

**Step 3: Run prettier and build**

```bash
npx prettier --write <all modified files>
pnpm build --filter=studio --filter=@abl/eventstore --filter=@abl/compiler --filter=@abl/observatory
```

**Step 4: Commit**

```
fix(observatory): align decision field name to decisionKind across all consumers
```

---

### Task 3b: Fix EventRegistry + Zod schemas (C1, C2, C3)

**Files:**

- Modify: `packages/eventstore/src/emitter/event-emitter.ts` — permissive fallback for unregistered types
- Modify: `packages/eventstore/src/schema/events/agent-events.ts` — fix schemas to accept camelCase, create missing schemas
- Modify: `packages/eventstore/src/schema/events/llm-events.ts` — camelCase field names
- Modify: `packages/eventstore/src/schema/events/tool-events.ts` — camelCase field names
- Modify: `packages/eventstore/src/schema/events/session-events.ts` — camelCase field names
- Modify: `packages/eventstore/src/schema/events/flow-events.ts` — camelCase field names
- Modify: `packages/eventstore/src/schema/events/gather-events.ts` — camelCase field names

**IMPORTANT: Do NOT add duplicate `register()` calls.** The existing schema files register themselves as side-effects when imported through `events/index.ts`. Adding duplicate `register()` in `event-registry.ts` will throw `Event type already registered` at startup.

**Step 1: Make EventEmitter permissive for unregistered types**

This is the critical safety net — unregistered types pass through instead of being silently dropped.

In `event-emitter.ts`, restructure the validation block:

```typescript
// Before (lines 41-56):
if (validationEnabled) {
  const validation = this.registry.validate(platformEvent);
  if (!validation.valid) {
    // ...
    console.warn(`${errorMsg} (dropped)`, { errors });
    return; // ← DROPS the event
  }
}

// After:
if (validationEnabled) {
  if (!this.registry.has(platformEvent.event_type)) {
    // Unknown type — pass through without data validation (extensibility)
    log.debug('Unregistered event type, skipping data validation', {
      eventType: platformEvent.event_type,
    });
    // Don't return — let it through to the writer
  } else {
    // Known type — validate data, warn on failure but don't drop
    // NOTE: validate() takes Partial<PlatformEvent> and returns { valid, errors?, eventType? }
    const dataValidation = this.registry.validate({
      event_type: platformEvent.event_type,
      data: platformEvent.data,
    });
    if (!dataValidation.valid) {
      log.warn('Event data validation failed (passing through)', {
        eventType: platformEvent.event_type,
        errors: dataValidation.errors?.map((i) => `${i.path.join('.')}: ${i.message}`),
      });
      // Don't return — pass through with raw data
    }
  }
}
```

**Step 2: Create missing event type schemas**

Two event types in `TRACE_TO_PLATFORM_TYPE` have no corresponding schema. Create them:

In `agent-events.ts`, add and register:

```typescript
export const AgentDelegateCompletedDataSchema = z
  .object({
    agentName: z.string().optional(),
    durationMs: z.number().optional(),
    taskSummary: z.string().optional(),
  })
  .passthrough();

// Register:
eventRegistry.register('agent.delegate.completed', AgentDelegateCompletedDataSchema, {
  version: '1.0.0',
  category: EVENT_CATEGORIES.AGENT,
  containsPII: false,
  description: 'Agent delegation completed',
});
```

Create `packages/eventstore/src/schema/events/system-events.ts`:

```typescript
import { z } from 'zod';
import { eventRegistry } from '../event-registry.js';

export const SystemErrorDataSchema = z
  .object({
    errorType: z.string().optional(),
    errorMessage: z.string().optional(),
    stack: z.string().optional(),
    agentName: z.string().optional(),
  })
  .passthrough();

eventRegistry.register('system.error', SystemErrorDataSchema, {
  version: '1.0.0',
  category: EVENT_CATEGORIES.SYSTEM,
  containsPII: false,
  description: 'System error occurred',
});
```

Add `export * from './system-events.js';` to `events/index.ts`.

**Step 3: Update all Zod schemas to accept camelCase**

All 14 schema files currently use snake_case (`input_tokens`, `from_agent`, etc.). Update them to accept camelCase (what executors actually emit). Add `.passthrough()` to all schemas for forward compatibility.

**All 14 schema files requiring `.passthrough()` and camelCase field audit:**

| File                   | Key Fields to Check                                                                              | Executor Emits                                                  |
| ---------------------- | ------------------------------------------------------------------------------------------------ | --------------------------------------------------------------- |
| `agent-events.ts`      | `decision_type`, `from_agent`, `to_agent`, `return_expected`                                     | `decisionKind`, `fromAgent`, `toAgent`                          |
| `llm-events.ts`        | `input_tokens`, `output_tokens`, `latency_ms`, `finish_reason`                                   | `tokensIn`, `tokensOut`, `durationMs`, `finishReason`           |
| `tool-events.ts`       | `tool_name`, `tool_type`, `latency_ms`, `result_size_bytes`                                      | `toolName`, `toolType`, `durationMs`, `resultSize`              |
| `session-events.ts`    | `update_source`, `keys_updated`, `update_count`, `total_duration_ms` (in SessionEndedDataSchema) | `updateSource`, `keysUpdated`, `updateCount`, `totalDurationMs` |
| `flow-events.ts`       | `step_name`, `step_type`, `from_step`, `to_step`                                                 | `stepName`, `stepType`, `fromStep`, `toStep`                    |
| `gather-events.ts`     | `field_name`, `extraction_method`, `clarification_count`                                         | `fieldName`, `extractionMethod`, `clarificationCount`           |
| `voice-events.ts`      | `voice_provider`, `call_sid`, `turn_number`, `call_duration_ms`                                  | `voiceProvider`, `callSid`, `turnNumber`, `callDurationMs`      |
| `message-events.ts`    | `content_length`, `has_attachments`, `attachment_count`                                          | `contentLength`, `hasAttachments`, `attachmentCount`            |
| `evaluation-events.ts` | `evaluation_id`, `evaluator_type`, `latency_ms`, `tokens_used`                                   | `evaluationId`, `evaluatorType`, `latencyMs`, `tokensUsed`      |
| `auth-events.ts`       | Read to verify — may already match                                                               | Verify                                                          |
| `channel-events.ts`    | Read to verify                                                                                   | Verify                                                          |
| `deployment-events.ts` | Read to verify                                                                                   | Verify                                                          |
| `feedback-events.ts`   | Read to verify                                                                                   | Verify                                                          |
| `search-events.ts`     | Read to verify                                                                                   | Verify                                                          |

Key schema changes (representative examples — apply same pattern to all files):

```typescript
// agent-events.ts — AgentDecisionDataSchema
// Before:
export const AgentDecisionDataSchema = z.object({
  decision_type: z.enum(['routing', 'escalation', 'constraint']),
  decision: z.string(),
  reasoning: z.string().optional(),
});
// After:
export const AgentDecisionDataSchema = z
  .object({
    decisionKind: z.enum([
      'handoff',
      'delegation',
      'flow_transition',
      'field_validation',
      'escalation',
      'completion',
      'constraint_check',
      'guardrail_check',
      'gather_extraction',
      'correction',
      'data_mutation',
    ]),
    outcome: z.string().optional(),
    reasoning: z.string().optional(),
  })
  .passthrough();

// agent-events.ts — AgentHandoffDataSchema
// Before:
export const AgentHandoffDataSchema = z.object({
  from_agent: z.string(),
  to_agent: z.string(),
  return_expected: z.boolean(),
  context_fields_passed: z.array(z.string()).optional(),
});
// After:
export const AgentHandoffDataSchema = z
  .object({
    fromAgent: z.string().optional(),
    toAgent: z.string(),
    reason: z.string().optional(),
    contextMeta: z.record(z.unknown()).optional(),
  })
  .passthrough();

// llm-events.ts — LLMCallCompletedDataSchema
// Before: input_tokens, output_tokens, latency_ms, etc.
// After: tokensIn, tokensOut, durationMs, etc. (matching executor output)

// tool-events.ts — ToolCallCompletedDataSchema
// Before: tool_name, tool_type, latency_ms, result_size_bytes
// After: toolName, toolType, durationMs, resultSize

// session-events.ts — SessionUpdatedDataSchema
// Before: update_source, keys_updated, update_count
// After: updateSource, keysUpdated, updateCount

// flow-events.ts — FlowStepEnteredDataSchema
// Before: step_name, step_type
// After: stepName, stepType
```

**Step 4: Build and test**

```bash
npx prettier --write packages/eventstore/src/schema/events/*.ts packages/eventstore/src/emitter/event-emitter.ts
pnpm build --filter=@abl/eventstore
pnpm test --filter=@abl/eventstore
```

**Step 5: Commit**

```
feat(eventstore): update schemas to camelCase, permissive EventEmitter, register missing types
```

---

## Phase 2: Emit dotted event types at source, eliminate trace-bridge

### Task 4: Create canonical event-type mapping module

Replace the 692-line trace-bridge with a 30-line mapping.

**Files:**

- Create: `apps/runtime/src/services/trace-event-types.ts`

**Step 1: Create the mapping**

```typescript
/**
 * Canonical event type mapping — trace types to platform event types.
 * Used by trace-emitter to emit platform events directly (no bridge).
 */
export const TRACE_TO_PLATFORM_TYPE: Record<string, string> = {
  llm_call: 'llm.call.completed', // override to .failed at emit site when has_error
  tool_call: 'tool.call.completed', // override to .failed at emit site when has_error
  agent_enter: 'agent.entered',
  agent_exit: 'agent.exited',
  handoff: 'agent.handoff',
  escalation: 'agent.escalated',
  delegate: 'agent.delegated',
  delegate_start: 'agent.delegated',
  delegate_complete: 'agent.delegate.completed',
  decision: 'agent.decision',
  constraint_check: 'agent.constraint.checked',
  flow_step_enter: 'flow.step.entered',
  flow_step_exit: 'flow.step.exited',
  flow_transition: 'flow.transition',
  session_created: 'session.started',
  session_ended: 'session.ended',
  session_updated: 'session.updated',
  user_message: 'message.user.received',
  agent_response: 'message.agent.sent',
  voice_session_start: 'voice.session.started',
  voice_session_end: 'voice.session.ended',
  voice_turn: 'voice.turn.completed',
  voice_stt: 'voice.stt.completed',
  voice_tts: 'voice.tts.completed',
  voice_barge_in: 'voice.barge_in.detected',
  voice_asr_quality: 'voice.asr_quality.analyzed',
  voice_tts_quality: 'voice.tts_quality.measured',
  voice_asr_cascade: 'voice.asr_cascade.detected',
  error: 'system.error',
};

/** Infer category from dotted event type (first segment) */
export function inferCategory(eventType: string): string {
  return eventType.split('.')[0];
}
```

**Step 2: Commit**

```
feat(runtime): add canonical event type mapping module
```

---

### Task 5: Refactor trace-emitter to emit platform events directly

**Files:**

- Modify: `apps/runtime/src/services/trace-emitter.ts`

The trace-emitter `emit()` function currently:

1. Stores in TraceStore (memory) — **keep** (WebSocket broadcast to connected debug panel)
2. Sends over WebSocket — **keep**
3. Lazy-loads trace-bridge + EventStore, translates types — **replace** with direct EventStore emit

**Step 1: Remove lazy bridge loader (lines 27-56)**

Delete the `EventStoreBridge` interface, `_eventStoreBridge` variable, and `loadEventStoreBridge()` function.

Replace with direct imports:

```typescript
import { getEventStore } from './eventstore-singleton.js';
import { TRACE_TO_PLATFORM_TYPE, inferCategory } from './trace-event-types.js';
import { getCurrentTraceId, getCurrentSpanId } from '@abl/compiler/platform';
```

**Note:** `getCurrentTraceId()` and `getCurrentSpanId()` read from the `@agent-platform/shared-observability` ALS context that is populated by `createObservabilityMiddleware` (HTTP) or `runWithObservabilityContext` (WebSocket/BullMQ). These are available after the Trace Readiness plan is complete. Using the ALS context as the source of truth for trace/span IDs means the trace-emitter doesn't need to thread these values through function parameters — they're ambient in the async context.

**Step 2: Rewrite dual-write section in emit() (lines 163-198)**

Replace the `loadEventStoreBridge().then(...)` block with:

```typescript
// Persist to EventStore → ClickHouse platform_events (fire-and-forget, non-fatal)
if (tenantId) {
  try {
    const eventStore = getEventStore();
    if (eventStore) {
      const rawData = (storedEvent.data as Record<string, unknown>) || {};
      const scrubbedData = scrubSecrets(rawData);
      const analyticsData = enableScrub
        ? JSON.parse(redactPII(JSON.stringify(scrubbedData)))
        : scrubbedData;

      const hasError = Boolean(rawData.error || rawData.errorType);
      const baseType = TRACE_TO_PLATFORM_TYPE[storedEvent.type] || storedEvent.type;
      let platformType = baseType;
      if (storedEvent.type === 'llm_call' && hasError) platformType = 'llm.call.failed';
      if (storedEvent.type === 'tool_call' && hasError) platformType = 'tool.call.failed';

      // Read trace/span context from @agent-platform/shared-observability ALS
      // (populated by createObservabilityMiddleware on HTTP, runWithObservabilityContext on WS/BullMQ)
      const alsTraceId = getCurrentTraceId();
      const alsSpanId = getCurrentSpanId();

      const dimRecord = getDimensionRecord();
      eventStore.emitter.emit({
        event_id: storedEvent.id,
        event_type: platformType,
        category: inferCategory(platformType),
        tenant_id: tenantId,
        project_id: projectId ?? '',
        session_id: sessionId,
        trace_id: storedEvent.traceId || alsTraceId || '',
        agent_name: storedEvent.agentName,
        timestamp: storedEvent.timestamp,
        duration_ms: storedEvent.durationMs,
        has_error: hasError,
        data: analyticsData,
        span_id: storedEvent.spanId || alsSpanId || '',
        parent_span_id: storedEvent.parentSpanId ?? '',
        ...(dimRecord && { metadata: { custom_dimensions: dimRecord } }),
      });
    }
  } catch (err) {
    log.warn('EventStore write failed', {
      sessionId,
      eventType: storedEvent.type,
      error: err instanceof Error ? err.message : String(err),
    });
  }
}
```

**Step 3: Remove `logDecision()` method (lines 287-303)**

Delete entirely. The 2 compiler callers are already migrated in Task 3.

**Step 4: Remove `@abl/eventstore/migration` import** — no longer needed.

**Step 5: Migrate other direct trace-bridge callers**

Two production files directly lazy-import `@abl/eventstore/migration` and call `emitTraceEventAsAnalytics`, bypassing trace-emitter entirely. These MUST be migrated before Task 9 deletes `trace-bridge.ts`, or they will throw at runtime.

- `apps/runtime/src/services/runtime-executor.ts` — two call sites (~lines 797 and 1480). The `session_created` emit happens before `TraceEmitter` exists for the session — use `getEventStore().emitter.emit({ event_type: 'session.started', ... })` directly with `TRACE_TO_PLATFORM_TYPE`.
- `apps/runtime/src/services/voice/korevg/korevg-session.ts` — one call site (~line 413). Same pattern — replace with direct `getEventStore().emitter.emit()`.

**Step 6: Build and test**

```bash
pnpm build --filter=runtime
pnpm test --filter=runtime -- --grep "trace-emitter"
```

**Step 7: Commit**

```
refactor(runtime): emit platform events directly, remove trace-bridge dependency
```

---

### Task 6: Update sessions.ts query layer — single ClickHouse source

**Files:**

- Modify: `apps/runtime/src/routes/sessions.ts`

Current fallback chain: memory → `abl_platform.traces` → `abl_platform.platform_events`.
New chain: memory → `abl_platform.platform_events`.

**Step 1: Delete `queryClickHouseCanonicalTraces()` function (lines 1730-1821)**

This queries the `abl_platform.traces` table. No longer needed.

**Step 2: Update ALL 4 call sites of `queryClickHouseCanonicalTraces()`**

The original plan only covered the traces endpoint. There are 3 additional call sites:

- Line 739 — export endpoint
- Line 877 — generations endpoint
- Line 1556-1598 — traces endpoint (the one in the original plan)
- Line 2640 — metrics endpoint

All must be redirected to `queryClickHousePlatformEvents()`.

**NOTE:** Line 1068 uses `getClickHouseTraceStore(tenantId).getTrace()` — a different mechanism via `ClickHouseTraceStore`, NOT `queryClickHouseCanonicalTraces()`. This call site is removed in Task 8 when `ClickHouseTraceStore` is deleted, and replaced with `queryClickHousePlatformEvents()` as part of the simplified fallback chain.

**Step 3: Simplify trace retrieval logic (lines 1556-1598)**

Remove the middle tier (`isClickHouseTraceEnabled()` block). Keep memory first, then platform_events:

```typescript
// If in-memory store has data, return it immediately (live session on this pod)
if (storeEvents && Array.isArray(storeEvents) && storeEvents.length > 0) {
  sendTracesResponse(res, req, storeEvents, 'memory');
  return;
}

// Historical session: query ClickHouse platform_events
try {
  const chEvents = await queryClickHousePlatformEvents(runtimeSessionId || sessionId, tenantId);
  if (chEvents.length > 0) {
    sendTracesResponse(res, req, chEvents, 'clickhouse_platform_events');
    return;
  }
} catch (err) {
  log.warn('ClickHouse platform_events query failed', {
    sessionId,
    error: err instanceof Error ? err.message : String(err),
  });
}

sendTracesResponse(res, req, [], 'memory');
```

**Step 4: Remove `isClickHouseTraceEnabled()` import**

**Step 5: Update `queryClickHousePlatformEvents()` to include span columns**

Add to SELECT: `span_id, parent_span_id`

Add to result mapping:

```typescript
spanId: row.span_id || undefined,
parentSpanId: row.parent_span_id || undefined,
```

**Step 6: Fix category filter to include `flow` and `system` (H5)**

```typescript
// Before (line ~1850):
WHERE category IN ('voice','session','llm','tool','agent')
// After:
WHERE category IN ('voice','session','llm','tool','agent','flow','system')
```

**Step 7: Increase LIMIT from 500 to 1000 (H7)**

```typescript
// Before:
LIMIT 500
// After:
LIMIT 1000
```

**Step 8: Add encryption/decryption parity (H13)**

`queryClickHouseCanonicalTraces()` decrypts via `getClickHouseEncryptionInterceptor()`. The platform_events path must do the same:

```typescript
// Add to queryClickHousePlatformEvents():
const encInterceptor = getClickHouseEncryptionInterceptor();
// After reading rows, decrypt data field if encrypted:
const data = encInterceptor ? await encInterceptor.decryptRow(row, tenantId) : JSON.parse(row.data);
```

**Step 9: Add ClickHouse fallback to span children endpoint (H6)**

The `/:id/traces/:spanId/children` endpoint (line ~2560) only queries in-memory TraceStore. Add ClickHouse fallback:

```typescript
// After memory lookup returns empty:
if (!children || children.length === 0) {
  const allEvents = await queryClickHousePlatformEvents(sessionId, tenantId);
  children = allEvents.filter((e) => e.parentSpanId === spanId);
}
```

**Step 10: Remove the reverse type mapping (lines 1869-1900)**

**DEPLOY ORDERING: Task 7 (client-side normalizer) MUST land before or simultaneously with this step.** If Task 6 deploys with the typeMap removed but Task 7 hasn't landed yet, historical sessions return raw dotted types and all UI type comparisons silently fail — empty timelines. Either:

- (a) Deploy Task 7 first, or
- (b) Keep the typeMap as a temporary shim in Task 6, remove it as the last step of Task 7

Delete the `typeMap` object that converts dotted→underscore names. The response now returns dotted event types directly. The UI (Task 7) handles both forms.

**Step 11: Remove `'traces'` from `TABLES_NEEDING_ENC_COLUMN` (H10)**

In `packages/database/src/clickhouse-schemas/init.ts:910`, remove `'traces'` from the array. Otherwise `ALTER TABLE abl_platform.traces ADD COLUMN ...` throws after the table is dropped.

**Step 12: Update TraceSource type**

```typescript
type TraceSource = 'memory' | 'clickhouse_platform_events';
```

**Step 13: Build**

```bash
pnpm build --filter=runtime --filter=@agent-platform/database
```

**Step 14: Commit**

```
refactor(runtime): remove traces table query, use platform_events as single ClickHouse source
```

---

### Task 7: Recreate Studio Observatory UI for dotted event types + DecisionCard

Live sessions (WebSocket) emit underscore types. Historical sessions from ClickHouse return dotted types. Rather than patching 50+ scattered type checks, recreate the Observatory components with a normalizer at the ingestion edge and a unified `DecisionCard`.

**Files:**

- Create: `apps/studio/src/lib/event-types.ts` — normalizer + color/icon maps
- Create: `apps/studio/src/components/observatory/DecisionCard.tsx` — unified decision renderer
- Recreate: `apps/studio/src/store/observatory-store.ts` — normalize at ingestion (H3: 22 type-switch branches)
- Recreate: `apps/studio/src/components/observatory/SessionTimeline.tsx` — (H4: 11 bare `.type ===`)
- Recreate: `apps/studio/src/components/observatory/SpanTree.tsx` — decision badge uses `decisionKind`
- Recreate: `apps/studio/src/components/observatory/NodeDetailPanel.tsx` — replace inline decision detail with `<DecisionCard>`
- Recreate: `apps/studio/src/components/observatory/EventTimeline.tsx` — read `decisionKind` (M8: `data.chosen` never populated)
- Modify: `apps/studio/src/hooks/useSessionDetail.ts` — all 14 bare `.type ===` checks (M4), not just line 514
- Modify: `apps/studio/src/components/analytics/TracesExplorerTab.tsx` — lines 252 AND 1661-1662 (M7)
- Modify: `apps/studio/src/components/session/SessionSummaryPanel.tsx:519` — `decisionType` → `decisionKind` (M6)
- Modify: `apps/studio/src/components/observatory/event-colors.ts` — add dotted type keys (M5)
- Modify: `apps/studio/src/utils/replay-trace-events.ts` — normalize type in `formatTraceEventLog()` (MISSED in original plan)

**Step 1: Create event type normalizer + decision kind maps**

```typescript
// apps/studio/src/lib/event-types.ts
import type { LucideIcon } from 'lucide-react';
import {
  ArrowRight,
  Users,
  GitBranch,
  CheckSquare,
  AlertTriangle,
  CheckCircle,
  Shield,
  ShieldAlert,
  FormInput,
  RotateCcw,
  Database,
} from 'lucide-react';

/** Dotted → underscore mapping (applied at ingestion edge) */
const DOTTED_TO_SIMPLE: Record<string, string> = {
  'agent.decision': 'decision',
  'llm.call.completed': 'llm_call',
  'llm.call.failed': 'llm_call',
  'tool.call.completed': 'tool_call',
  'tool.call.failed': 'tool_call',
  'agent.entered': 'agent_enter',
  'agent.exited': 'agent_exit',
  'agent.handoff': 'handoff',
  'agent.escalated': 'escalation',
  'agent.delegated': 'delegate_start',
  'agent.delegate.completed': 'delegate_complete',
  'agent.constraint.checked': 'constraint_check',
  'flow.step.entered': 'flow_step_enter',
  'flow.step.exited': 'flow_step_exit',
  'flow.transition': 'flow_transition',
  'session.started': 'session_created',
  'session.ended': 'session_ended',
  'session.updated': 'session_updated',
  'message.user.received': 'user_message',
  'message.agent.sent': 'agent_response',
  'system.error': 'error',
  // Voice events (M3: 9 missing types)
  'voice.session.started': 'voice_session_start',
  'voice.session.ended': 'voice_session_end',
  'voice.turn.completed': 'voice_turn',
  'voice.stt.completed': 'voice_stt',
  'voice.tts.completed': 'voice_tts',
  'voice.barge_in.detected': 'voice_barge_in',
  'voice.asr_quality.analyzed': 'voice_asr_quality',
  'voice.tts_quality.measured': 'voice_tts_quality',
  'voice.asr_cascade.detected': 'voice_asr_cascade',
};

/** Normalize event type — accepts both dotted and underscore forms, returns underscore */
export function normalizeEventType(type: string): string {
  return DOTTED_TO_SIMPLE[type] ?? type;
}

/** Decision kind metadata for UI rendering */
export type DecisionKind =
  | 'handoff'
  | 'delegation'
  | 'flow_transition'
  | 'field_validation'
  | 'escalation'
  | 'completion'
  | 'constraint_check'
  | 'guardrail_check'
  | 'gather_extraction'
  | 'correction'
  | 'data_mutation';

export interface DecisionKindMeta {
  label: string;
  icon: LucideIcon;
  color: string; // tailwind color class
  sections: ('candidates' | 'reasoning' | 'conditions' | 'field' | 'footer')[];
}

export const DECISION_KIND_META: Record<DecisionKind, DecisionKindMeta> = {
  handoff: {
    label: 'Handoff',
    icon: ArrowRight,
    color: 'text-blue-500',
    sections: ['candidates', 'reasoning'],
  },
  delegation: {
    label: 'Delegation',
    icon: Users,
    color: 'text-indigo-500',
    sections: ['candidates', 'reasoning'],
  },
  flow_transition: {
    label: 'Flow Transition',
    icon: GitBranch,
    color: 'text-purple-500',
    sections: ['reasoning'],
  },
  field_validation: {
    label: 'Field Validation',
    icon: CheckSquare,
    color: 'text-teal-500',
    sections: ['field', 'conditions'],
  },
  escalation: {
    label: 'Escalation',
    icon: AlertTriangle,
    color: 'text-amber-500',
    sections: ['reasoning'],
  },
  completion: {
    label: 'Completion',
    icon: CheckCircle,
    color: 'text-green-500',
    sections: ['reasoning'],
  },
  constraint_check: {
    label: 'Constraint',
    icon: Shield,
    color: 'text-orange-500',
    sections: ['conditions'],
  },
  guardrail_check: {
    label: 'Guardrail',
    icon: ShieldAlert,
    color: 'text-red-500',
    sections: ['conditions'],
  },
  gather_extraction: {
    label: 'Extraction',
    icon: FormInput,
    color: 'text-cyan-500',
    sections: ['field'],
  },
  correction: {
    label: 'Correction',
    icon: RotateCcw,
    color: 'text-yellow-500',
    sections: ['reasoning'],
  },
  data_mutation: {
    label: 'Data Mutation',
    icon: Database,
    color: 'text-slate-500',
    sections: ['field'],
  },
};
```

**Step 2: Create unified `DecisionCard` component**

```typescript
// apps/studio/src/components/observatory/DecisionCard.tsx
// Renders conditional sections based on which metadata fields are present.
// See "UI Rewrite: Unified Decision Card" section above for wireframe.
// Read existing NodeDetailPanel.tsx decision rendering (lines 350-414) before implementing.
```

**Step 3: Normalize at ingestion edge in observatory-store.ts (H3)**

In `observatory-store.ts`, `addEvent()` receives events from two paths:

1. WebSocket (live sessions) — underscore types
2. `replayTraceEventsIntoObservatory()` in `replay-trace-events.ts` — dotted types from ClickHouse

Normalize at the top of `addEvent()` and **store the normalized event** (not the original):

```typescript
addEvent(event: TraceEvent) {
  const normalized = { ...event, type: normalizeEventType(event.type) };
  // CRITICAL: use `normalized` everywhere below, including the boundedPush call:
  set((state) => ({ events: boundedPush(state.events, normalized, MAX_EVENTS) }));
  // ... rest of addEvent uses normalized.type for all 10 branches
}
```

**Important:** The `set()` call at line ~291 currently stores `event` — it MUST store `normalized` instead. Otherwise EventTimeline and getTimeline() receive dotted types from the raw events array and all their switch branches silently fail.

Similarly, `getTimeline()`'s 12-case switch works with underscore types after normalization.

**Step 4: Recreate SessionTimeline.tsx (H4)**

All 11 `.type ===` comparisons use underscore types (already normalized at ingestion). No dotted types reach these comparisons.

**Step 5: Update all remaining UI consumers**

- `useSessionDetail.ts` — **THREE separate normalization points:**
  1. Line 514: `decisionType` → `decisionKind` (decision field name)
  2. Line ~160 (`traceEvents.map()`): Add `normalizeEventType(event.type)` before the map feeds into `buildConversationTree()`. This is a **third ingestion path** (separate from observatory-store and replay-trace-events) — `buildAgentSubtree()` at lines 414-656 has 14 bare `.type ===` checks that consume raw REST response data directly, never through the store.
  3. Line ~670 (`computeMetrics()`): Also reads `event.type === 'llm_call'` directly from raw trace events.
- `TracesExplorerTab.tsx` — lines 252 AND 1661-1662 (M7), read `decisionKind`
- `SessionSummaryPanel.tsx:519` — `decisionType` → `decisionKind` (M6)
- `event-colors.ts` — add dotted type keys as aliases pointing to same colors (M5)
- `SpanTree.tsx` — decision badge reads `data?.decisionKind`, uses `DECISION_KIND_META` for icon/color
- `NodeDetailPanel.tsx` — replace inline decision detail with `<DecisionCard data={event.data} />`
- `EventTimeline.tsx` — decision summary reads `decisionKind` + `outcome` (not `decisionType` + `chosen`)
- `replay-trace-events.ts` — `formatTraceEventLog()` at line 155 has 14 `case` branches on underscore types. Call `normalizeEventType()` on `event.type` before passing to `formatTraceEventLog()`. Without this, the Observatory Logs panel is empty for all historical sessions.

**Step 6: Build and visually verify**

```bash
npx prettier --write apps/studio/src/lib/event-types.ts apps/studio/src/components/observatory/DecisionCard.tsx
pnpm build --filter=studio
```

**Step 7: Commit**

```
feat(studio): recreate Observatory UI with dotted event type support and unified DecisionCard
```

---

### Task 7b: Update pipeline-engine queries to use platform_events

**Files:**

- Modify: `packages/pipeline-engine/src/pipeline/services/conversation-reader.ts:358`
- Modify: `packages/pipeline-engine/src/pipeline/services/read-message-window.service.ts:152`
- Modify: `packages/pipeline-engine/src/pipeline/services/compute-tool-effectiveness.service.ts:71`

These services query `abl_platform.traces` with raw SQL. All must be rewritten to query `platform_events` instead, using dotted event type names.

**Step 1: Read each file to understand the exact query patterns**

**Step 2: Rewrite queries**

- Change table name: `abl_platform.traces` → `abl_platform.platform_events`
- Change event type names: underscore → dotted (use `TRACE_TO_PLATFORM_TYPE` mapping as reference)
- **CRITICAL: `compute-tool-effectiveness.service.ts` column structure change.** The `traces` table had `tool_name`, `success`, `retry_attempt` as top-level columns. `platform_events` stores these inside the JSON `data` column. Rewrite using `JSONExtract*()`:

```sql
-- Before (traces table — top-level columns):
SELECT tool_name, count() AS total_calls, countIf(success = 1) ...
FROM abl_platform.traces WHERE event_type = 'tool.call'

-- After (platform_events — JSON data column, camelCase fields):
SELECT JSONExtractString(data, 'toolName') AS tool_name,
       count() AS total_calls,
       countIf(JSONExtractUInt(data, 'success') = 1) AS successful_calls,
       countIf(JSONExtractUInt(data, 'retryAttempt') > 0) AS retried_calls,
       avg(duration_ms) AS avg_duration_ms
FROM abl_platform.platform_events
WHERE event_type IN ('tool.call.completed', 'tool.call.failed')
GROUP BY tool_name
```

- `read-message-window.service.ts:149` — `event_type = 'tool_call'` → `event_type IN ('tool.call.completed', 'tool.call.failed')`
- `conversation-reader.ts:358` — change table name and event type names; verify encryption path works with `platform_events`

**Step 3: Build and test**

```bash
pnpm build --filter=@abl/pipeline-engine
pnpm test --filter=@abl/pipeline-engine
```

**Step 4: Commit**

```
refactor(pipeline-engine): query platform_events instead of traces table
```

---

### Task 7c: Wire trace-forwarder through trace-emitter (H12)

**Files:**

- Modify: `apps/runtime/src/services/execution/trace-forwarder.ts`
- Modify: `apps/runtime/src/__tests__/trace-forwarder.test.ts`

Currently `trace-forwarder.ts` writes to memory TraceStore only. Compiler runtime events (handoff, escalation, LLM calls from digital-runtime and workflow-runtime) never reach ClickHouse.

**Prerequisite:** The `@agent-platform/shared-observability` ALS context must be active when compiler runtimes execute (ensured by Trace Readiness plan). When `trace-emitter.emit()` is called from the forwarder, `getCurrentTraceId()` reads the trace ID from the ALS — so forwarded events are automatically stamped with the correct `trace_id` in ClickHouse without explicit parameter threading from the compiler runtimes.

**Step 1: Read trace-forwarder.ts to understand current interface**

Key methods: `logDecision()` (line 124), `logLLMCall()` (line 100), `logToolCall()` (line 112), plus the general `addEvent()` (line 66/178).

**Step 2: Wire all methods through trace-emitter**

Instead of writing directly to memory TraceStore, call `trace-emitter.emit()` which handles both memory store (WS broadcast) AND EventStore (ClickHouse persistence):

```typescript
// Before (TraceForwarder.addEvent):
addEvent(type: string, data: Record<string, unknown>) {
  this.traceStore.addEvent(this.sessionId, { type, data, timestamp: new Date() });
}

// After:
addEvent(type: string, data: Record<string, unknown>) {
  // trace-emitter handles: memory store + WS broadcast + EventStore write
  this.traceEmitter.emit({ type, data, timestamp: new Date() });
}
```

**Step 3: Remove `logDecision()` from TraceForwarder (runtime)**

The `TraceForwarder` (`apps/runtime/src/services/execution/trace-forwarder.ts`) has its own `logDecision()`. Remove it — callers in the runtime use `trace-emitter.emitDecision()` instead:

```typescript
// TraceForwarder — Before:
logDecision(params: { decisionType: string; ... }) {
  this.traceStore.addEvent(this.sessionId, {
    type: 'decision',
    data: { decisionType: params.decisionType, ... },
  });
}

// After: (method removed from TraceForwarder — runtime callers use trace-emitter.emitDecision())
```

**Step 4: Rename `decisionType` → `decisionKind` in compiler's TraceContextManager**

**IMPORTANT:** `digital-runtime.ts:337` and `workflow-runtime.ts:391` call `TraceContextManager.logDecision()` (from `packages/compiler/src/platform/stores/trace-store.ts:170`), NOT the TraceForwarder. These are compiler-package calls that go through the compiler's own `TraceStore` interface. The fix is to RENAME the field, NOT delete the method:

- `packages/compiler/src/platform/stores/trace-store.ts:170` — rename `decisionType` → `decisionKind` in `logDecision()` params and event data
- `packages/compiler/src/platform/core/types.ts:319-327` — rename `LogDecisionParams.decisionType` → `decisionKind`, `DecisionEvent.data.decisionType` → `decisionKind`
- `digital-runtime.ts:337` — `trace.logDecision({decisionType: 'routing'})` → `trace.logDecision({decisionKind: 'handoff'})`
- `workflow-runtime.ts:391` — `trace.logDecision({decisionType: 'escalation'})` → `trace.logDecision({decisionKind: 'escalation'})`

**Step 5: Update `logDecision()` callers in runtime + test mocks**

Two categories of `logDecision` updates:

**A. Runtime TraceForwarder callers** (method removed — replace with `emitDecision()`):

- `apps/runtime/src/services/adapters/trace-manager-adapter.ts:64` — this is a `TestTraceManager` adapter (test/demo utility, not production). Rename `decisionType` → `decisionKind` in its `logDecision()` method signature to match the updated `LogDecisionParams` type.
- `apps/runtime/src/services/execution/trace-forwarder.ts:47-52` — update interface to remove `logDecision`

**B. Compiler TraceContextManager callers** (method stays, field renamed):

- `packages/observatory/src/schema/trace-events.ts:240` — `DecisionData.decisionType` → `decisionKind`

**C. Test files** — update mocks to match the changes above:

Runtime-side (remove `logDecision` from TraceForwarder mock shapes):

- `apps/runtime/src/__tests__/trace-forwarder.test.ts` (actual path: `apps/runtime/src/__tests__/`, NOT `services/execution/`) — delete `logDecision` test; add behavioral test that `forwarder.addEvent()` calls `traceEmitter.emit()` (this is the central guarantee of Task 7c)
- `apps/runtime/src/__tests__/trace-emitter.test.ts:520-576` — handled in Task 12 (delete `logDecision` block, add `emitDecision` block)
- `apps/runtime/src/__tests__/trace-emitter.test.ts:987-988` — second `logDecision` call outside the main describe block; also needs removal
- `apps/runtime/src/__tests__/trace-wiring.test.ts:35` — remove `logDecision: vi.fn()` from `mockTrace` object
- `apps/runtime/src/__tests__/trace-forwarder-integration.test.ts:81` — remove `logDecision: vi.fn()` from `explicitTrace` mock

Compiler-side (rename `decisionType` → `decisionKind` in mock shapes):

- `packages/compiler/src/__tests__/runtimes/base-runtime.test.ts` — update `logDecision` mock to use `decisionKind`
- `packages/compiler/src/__tests__/constructs/middleware-chain.test.ts` — update `logDecision` mock to use `decisionKind`
- `packages/compiler/src/__tests__/e2e/fixtures/test-utils.ts:652` — update `logDecision` stub to use `decisionKind`
- `packages/compiler/src/__tests__/compiler-stores-extended.test.ts:601` — update `logDecision({ decisionType: 'routing' })` → `logDecision({ decisionKind: 'handoff' })`
- `apps/runtime/src/__tests__/platform.e2e.test.ts:385` — update `traceCtx.logDecision({ decisionType: 'routing' })` → `traceCtx.logDecision({ decisionKind: 'handoff' })`

**Step 6: Build and test**

```bash
pnpm build --filter=runtime --filter=@abl/compiler
pnpm test --filter=runtime -- --grep "trace-forwarder"
```

**Step 7: Commit**

```
refactor(runtime): wire trace-forwarder through trace-emitter for ClickHouse persistence
```

---

## Phase 3: Remove dead code

### Task 8: Delete ClickHouseTraceStore, singleton, and trace-specific gates

**Files:**

- Delete: `apps/runtime/src/services/stores/clickhouse-trace-store.ts` (338 lines)
- Delete: `apps/runtime/src/services/stores/clickhouse-trace-singleton.ts` (68 lines)
- Modify: all files that reference `isClickHouseTraceEnabled` or `getClickHouseTraceStore`

**NOTE on `USE_MONGO_CLICKHOUSE`:** This flag gates non-trace features too (messages, metrics, GDPR). Only remove the trace-specific usages (`isClickHouseTraceEnabled`, `getClickHouseTraceStore`). See Open Question 1 for the broader flag cleanup.

**Step 1: Find all references**

```bash
grep -r "isClickHouseTraceEnabled\|getClickHouseTraceStore\|clickhouse-trace-singleton\|clickhouse-trace-store" apps/runtime/src/ --include="*.ts" -l
```

**Step 2: Update these specific files that import ClickHouseTraceStore directly**

These files will fail at import time if not updated before deletion:

- `apps/runtime/src/services/stores/clickhouse-store-factory.ts` — remove `ClickHouseTraceStore` import and instantiation
- `apps/runtime/src/services/stores/index.ts` — remove `ClickHouseTraceStore` and `ClickHouseTraceStoreOptions` re-exports
- `apps/runtime/src/websocket/handler.ts` — remove `ClickHouseTraceStore` import, remove `traceStore` from `ChStores` interface (~line 128)
- `apps/runtime/src/server.ts` — remove `closeClickHouseTraceStores` import from `clickhouse-trace-singleton.ts` and its call in shutdown (~line 1855)

**Step 3: Remove all `isClickHouseTraceEnabled()` conditional blocks**

The `if (isClickHouseTraceEnabled()) { ... }` blocks are dead code — EventStore now handles ClickHouse writes.

**Step 4: Delete the two store files**

- Delete: `apps/runtime/src/services/stores/clickhouse-trace-store.ts` (338 lines)
- Delete: `apps/runtime/src/services/stores/clickhouse-trace-singleton.ts` (68 lines)

**Step 5: Update test files**

- `clickhouse-stores.test.ts` — delete ONLY the `describe('ClickHouseTraceStore')` block (~lines 532-end). Keep the other 3 store test blocks (message, metrics, audit) intact.
- `clickhouse-enterprise.test.ts` — remove the `createTraceStore()` helper and any describe blocks that exercise it
- `stress/runtime-channel-stress.test.ts` — change `abl_platform.traces` assertions to `abl_platform.platform_events`
- `helpers/stress-test-server.ts` — change `_addRows('abl_platform.traces', ...)` to `_addRows('abl_platform.platform_events', ...)`
- `sessions-platform-events.test.ts` — remove the `clickhouse-trace-singleton` mock (line ~60) since that module is deleted

**Step 6: Remove from docs**

- Delete: `docs/MONGO_CLICKHOUSE_SETUP.md`
- Update: `apps/runtime/.env.example` — remove `USE_MONGO_CLICKHOUSE` comment about traces (keep if used for messages/metrics)

**Step 7: Update tests that mock this flag**

Tests like `dual-write-message-store.test.ts` that toggle `USE_MONGO_CLICKHOUSE` for non-trace purposes should remain. Only remove trace-specific test mocks.

**Step 8: Build and test**

```bash
pnpm build --filter=runtime
pnpm test --filter=runtime
```

**Step 9: Commit**

```
chore(runtime): remove ClickHouseTraceStore, singleton, and trace-specific gates
```

---

### Task 9: Delete trace-bridge.ts

**Files:**

- Delete: `packages/eventstore/src/migration/trace-bridge.ts` (692 lines)
- Modify: `packages/eventstore/src/migration/index.ts` — remove re-export of trace-bridge

**Step 1: Find all remaining references**

```bash
grep -r "trace-bridge\|emitTraceEventAsAnalytics\|mapTraceEventToPlatformEvent" --include="*.ts" -l
```

After Task 5, nothing should import from trace-bridge.

**Step 2: Delete the file and update index.ts**

**Step 3: Build and test**

```bash
pnpm build --filter=@abl/eventstore
pnpm test --filter=@abl/eventstore
```

**Step 4: Commit**

```
chore(eventstore): remove trace-bridge migration layer (692 lines)
```

---

### Task 10: Simplify eventstore-singleton — remove unnecessary config flags

**Files:**

- Modify: `apps/runtime/src/services/eventstore-singleton.ts`

**Step 1: Remove `EVENTSTORE_ENABLED` check (lines 23-28)**

EventStore is always enabled.

**Step 2: Remove memory backend fallback (lines 85-106)**

ClickHouse is the only backend.

**Step 3: Hardcode mode and backend**

```typescript
export async function initializeEventStore(opts: { clickhouseReady: boolean }): Promise<void> {
  if (_initialized) return;

  if (!opts.clickhouseReady) {
    log.error('ClickHouse not ready — EventStore cannot initialize');
    _initialized = true;
    return;
  }

  const { getClickHouseClient } = await import('@agent-platform/database/clickhouse');
  const client = getClickHouseClient();

  const config: EventStoreConfig = {
    mode: 'embedded',
    backend: 'clickhouse',
    clickhouse: { client },
    ...(process.env.EVENTSTORE_RESILIENCE_ENABLED === 'true' && {
      resilience: {
        enabled: true,
        wal: { directory: process.env.EVENTSTORE_WAL_DIR ?? '/tmp/eventstore-wal' },
      },
    }),
  };

  _eventStore = createEventStore(config);
  _initialized = true;

  // WAL recovery
  if (_eventStore.recovery) {
    try {
      await _eventStore.recovery.recoverFromWAL();
      _eventStore.recovery.startPeriodicRecovery();
    } catch (walErr) {
      log.warn('WAL recovery failed (non-fatal)', {
        error: walErr instanceof Error ? walErr.message : String(walErr),
      });
    }
  }

  // GDPR cascade hooks
  registerEventCascadeHook({
    deleteBySessionIds: (tenantId, sessionIds) =>
      _eventStore!.gdpr.deleteBySessionIds(tenantId, sessionIds),
    deleteTenant: (tenantId) => _eventStore!.gdpr.deleteTenant(tenantId),
  });

  log.info('EventStore initialized with ClickHouse backend');
}
```

Keep WAL recovery and GDPR hooks — those are genuine production concerns.

**Step 4: Build and test**

**Step 5: Commit**

```
chore(runtime): simplify eventstore-singleton — remove unnecessary config flags
```

---

### Task 11: Drop `abl_platform.traces` table from schema

**Files:**

- Modify: `packages/database/src/clickhouse-schemas/init.ts` — remove traces table DDL
- Modify: `scripts/clickhouse-init/01-init.sql` — remove traces table DDL
- Modify: `apps/runtime/src/routes/analytics.ts:592` — remove `'abl_platform.traces'` from `ALLOWED_TABLES` allowlist

**NOTE:** Do NOT run `DROP TABLE` in production. Remove from schema init so new deployments don't create it. Existing deployments can manually drop after verifying platform_events has data.

**Step 1: Remove traces DDL from both files**

**Step 2: Build**

```bash
pnpm build --filter=@agent-platform/database
```

**Step 3: Commit**

```
chore(database): remove traces table DDL from schema init

Existing deployments should manually DROP TABLE after verifying
platform_events contains all expected trace data.
```

---

## Phase 4: Integration & Real-Data Testing

The unit tests (mocked ClickHouse, mocked WS) already exist and get updated per-task. This phase adds the tests that catch real integration failures: data actually landing in ClickHouse, the Observatory actually rendering it, and the fallback chain working end-to-end.

### Task 12: Trace-emitter direct-emit unit tests

**Files:**

- Modify: `apps/runtime/src/__tests__/trace-emitter.test.ts`

The existing 1,159-line test file tests the old lazy-bridge path. After Task 5, the dual-write section is rewritten. These tests must be updated.

**Step 1: Remove deleted-method tests**

- Delete the `describe('logDecision()')` block (lines 520-576) — 3 tests that call `emitter.logDecision({ decisionType: ... })`. Method deleted in Task 5.
- Delete the second `emitter.logDecision()` call at lines 987-988 (outside the main describe block). Without this, the test file won't compile after `logDecision()` is removed.
- Delete any test that mocks `loadEventStoreBridge()` or `emitTraceEventAsAnalytics` (bridge deleted in Task 9).

**Step 2: Add `emitDecision()` tests (replacing logDecision coverage)**

```typescript
describe('emitDecision()', () => {
  test('emits decision event with decisionKind field', () => {
    const emitter = createTraceEmitter(baseConfig({ tenantId: 'tenant-1' }));
    emitter.emitDecision('handoff', { outcome: 'agent-b', candidates: ['a', 'b'] });

    expect(mockEventStoreEmit).toHaveBeenCalledWith(
      expect.objectContaining({
        event_type: 'agent.decision',
        data: expect.objectContaining({ decisionKind: 'handoff', outcome: 'agent-b' }),
      }),
    );
  });

  test('respects verbosity gating — no emit below threshold', () => {
    const emitter = createTraceEmitter(
      baseConfig({ tenantId: 'tenant-1', traceVerbosity: 'minimal' }),
    );
    emitter.emitDecision('gather_extraction', { fieldName: 'budget' });

    // gather_extraction requires verbose level
    expect(mockEventStoreEmit).not.toHaveBeenCalled();
  });

  test('propagates span context', () => {
    const emitter = createTraceEmitter(baseConfig({ tenantId: 'tenant-1' }));
    emitter.logAgentEnter({ agentName: 'travel' }); // sets span
    emitter.emitDecision('constraint_check', { constraint: 'budget > 0' });

    expect(mockEventStoreEmit).toHaveBeenCalledWith(
      expect.objectContaining({
        span_id: expect.any(String),
        parent_span_id: expect.any(String),
      }),
    );
  });
});
```

**Step 3: Add direct EventStore emit tests**

```typescript
describe('direct EventStore emit (post-bridge removal)', () => {
  test('maps llm_call → llm.call.completed in EventStore write', () => {
    const emitter = createTraceEmitter(baseConfig({ tenantId: 'tenant-1' }));
    emitter.emit({
      type: 'llm_call',
      timestamp: new Date(),
      data: { model: 'gpt-4', tokensIn: 100 },
    });

    // Assert EventStore.emitter.emit was called with dotted type
    expect(mockEventStoreEmit).toHaveBeenCalledWith(
      expect.objectContaining({
        event_type: 'llm.call.completed',
        category: 'llm',
        tenant_id: 'tenant-1',
      }),
    );
  });

  test('maps llm_call with error → llm.call.failed', () => {
    const emitter = createTraceEmitter(baseConfig({ tenantId: 'tenant-1' }));
    emitter.emit({
      type: 'llm_call',
      timestamp: new Date(),
      data: { model: 'gpt-4', error: 'timeout' },
    });

    expect(mockEventStoreEmit).toHaveBeenCalledWith(
      expect.objectContaining({ event_type: 'llm.call.failed' }),
    );
  });

  test('passes span_id and parent_span_id to EventStore', () => {
    const emitter = createTraceEmitter(baseConfig({ tenantId: 'tenant-1' }));
    // Enter a span first (this sets currentSpanId)
    emitter.logAgentEnter({ agentName: 'travel' });
    emitter.emit({
      type: 'constraint_check',
      timestamp: new Date(),
      data: { constraint: 'budget > 0', passed: true },
      spanId: 'span-123',
      parentSpanId: 'span-parent',
    });

    expect(mockEventStoreEmit).toHaveBeenCalledWith(
      expect.objectContaining({
        span_id: 'span-123',
        parent_span_id: 'span-parent',
      }),
    );
  });

  test('unmapped event types pass through as-is', () => {
    const emitter = createTraceEmitter(baseConfig({ tenantId: 'tenant-1' }));
    emitter.emit({
      type: 'custom_thing' as any,
      timestamp: new Date(),
      data: { foo: 'bar' },
    });

    expect(mockEventStoreEmit).toHaveBeenCalledWith(
      expect.objectContaining({
        event_type: 'custom_thing',
        category: 'custom_thing', // inferCategory returns first segment
      }),
    );
  });

  test('PII scrubbing applies before EventStore write', () => {
    const emitter = createTraceEmitter(baseConfig({ tenantId: 'tenant-1', scrubPII: true }));
    emitter.emit({
      type: 'user_message',
      timestamp: new Date(),
      data: { text: 'my SSN is 123-45-6789' },
    });

    const emittedData = mockEventStoreEmit.mock.calls[0][0].data;
    expect(emittedData.text).not.toContain('123-45-6789');
  });

  test('no EventStore write when tenantId is missing', () => {
    const emitter = createTraceEmitter(baseConfig()); // no tenantId
    emitter.emit({
      type: 'llm_call',
      timestamp: new Date(),
      data: {},
    });

    expect(mockEventStoreEmit).not.toHaveBeenCalled();
  });

  test('camelCase data fields pass through to EventStore unchanged (no normalization)', () => {
    const emitter = createTraceEmitter(baseConfig({ tenantId: 'tenant-1' }));
    emitter.emit({
      type: 'llm_call',
      timestamp: new Date(),
      data: { tokensIn: 100, tokensOut: 50, model: 'gpt-4', durationMs: 230 },
    });

    const emittedData = mockEventStoreEmit.mock.calls[0][0].data;
    // camelCase preserved — no snake_case normalization
    expect(emittedData.tokensIn).toBe(100);
    expect(emittedData.tokensOut).toBe(50);
    expect(emittedData.durationMs).toBe(230);
    expect(emittedData.input_tokens).toBeUndefined(); // no normalization
  });
});
```

**Step 3: Run**

```bash
cd apps/runtime && pnpm vitest run src/__tests__/trace-emitter.test.ts
```

**Step 4: Commit**

```
test(runtime): update trace-emitter tests for direct EventStore emit path
```

---

### Task 13: Event type mapping unit tests

**Files:**

- Create: `apps/runtime/src/__tests__/trace-event-types.test.ts`

**Step 1: Write tests for the mapping module**

```typescript
import { describe, test, expect } from 'vitest';
import { TRACE_TO_PLATFORM_TYPE, inferCategory } from '../services/trace-event-types.js';

describe('TRACE_TO_PLATFORM_TYPE', () => {
  test('maps all core trace types', () => {
    expect(TRACE_TO_PLATFORM_TYPE['llm_call']).toBe('llm.call.completed');
    expect(TRACE_TO_PLATFORM_TYPE['tool_call']).toBe('tool.call.completed');
    expect(TRACE_TO_PLATFORM_TYPE['agent_enter']).toBe('agent.entered');
    expect(TRACE_TO_PLATFORM_TYPE['handoff']).toBe('agent.handoff');
    expect(TRACE_TO_PLATFORM_TYPE['decision']).toBe('agent.decision');
    expect(TRACE_TO_PLATFORM_TYPE['constraint_check']).toBe('agent.constraint.checked');
    expect(TRACE_TO_PLATFORM_TYPE['error']).toBe('system.error');
  });

  test('voice events all map to voice.* namespace', () => {
    const voiceKeys = Object.keys(TRACE_TO_PLATFORM_TYPE).filter((k) => k.startsWith('voice_'));
    for (const key of voiceKeys) {
      expect(TRACE_TO_PLATFORM_TYPE[key]).toMatch(/^voice\./);
    }
  });
});

describe('inferCategory', () => {
  test('extracts first segment of dotted type', () => {
    expect(inferCategory('llm.call.completed')).toBe('llm');
    expect(inferCategory('agent.entered')).toBe('agent');
    expect(inferCategory('system.error')).toBe('system');
  });

  test('returns full string if no dots', () => {
    expect(inferCategory('custom_thing')).toBe('custom_thing');
  });
});
```

**Step 2: Run and commit**

```bash
cd apps/runtime && pnpm vitest run src/__tests__/trace-event-types.test.ts
```

```
test(runtime): add unit tests for canonical event type mapping
```

---

### Task 13b: EventRegistry permissive fallback test

**Files:**

- Create: `packages/eventstore/src/__tests__/event-emitter-permissive.test.ts`

**Step 1: Write tests for permissive fallback behavior**

```typescript
import { describe, test, expect, vi } from 'vitest';

describe('EventEmitter permissive fallback', () => {
  test('unregistered event type passes through without validation', async () => {
    // Setup: create emitter with validation enabled
    // Emit an event with an unregistered type like 'custom.unknown.type'
    // Assert: event reaches the writer (not silently dropped)
    // Assert: warning logged about unregistered type
  });

  test('registered event type with invalid data passes through with warning', async () => {
    // Setup: create emitter with validation enabled
    // Emit agent.decision event with wrong field names
    // Assert: event reaches the writer (not dropped)
    // Assert: warning logged about validation failure
  });

  test('registered event type with valid data passes through without warnings', async () => {
    // Emit agent.decision with correct camelCase fields
    // Assert: no warnings logged
  });

  test('updated Zod schemas accept camelCase fields after Task 3b', async () => {
    // Emit agent.decision with { decisionKind: 'handoff', outcome: 'agent-b' }
    // Assert: event reaches the writer without validation warnings
    // This confirms the schema update (not just the permissive fallback)
    // Without this test, a broken schema would silently pass through the
    // permissive fallback and mask the issue
  });

  test('updated AgentHandoffDataSchema accepts camelCase fields', async () => {
    // Emit agent.handoff.completed with { fromAgent: 'a', toAgent: 'b', reason: '...' }
    // Assert: event reaches the writer without validation warnings
  });
});
```

**Step 2: Run and commit**

```bash
cd packages/eventstore && pnpm vitest run src/__tests__/event-emitter-permissive.test.ts
```

```
test(eventstore): add EventEmitter permissive fallback tests
```

---

### Task 14: Sessions.ts query layer tests — single source

**Files:**

- Modify: `apps/runtime/src/routes/__tests__/sessions-platform-events.test.ts`

**Step 1: Update existing tests**

The existing test file tests `queryClickHousePlatformEvents()` with the old `typeMap` reverse mapping. After Task 6, the reverse mapping is gone and dotted types are returned directly.

Update assertions:

```typescript
// Before: expected mapped types
expect(event.type).toBe('llm_call');
// After: dotted types returned directly (UI normalizes them)
expect(event.type).toBe('llm.call.completed');
```

**Step 2: Add span column tests**

```typescript
test('includes span_id and parent_span_id from ClickHouse rows', async () => {
  mockQueryResult([
    {
      event_type: 'agent.constraint.checked',
      span_id: 'span-abc',
      parent_span_id: 'span-parent',
      // ...other fields
    },
  ]);

  const events = await queryClickHousePlatformEvents('session-1', 'tenant-1');

  expect(events[0].spanId).toBe('span-abc');
  expect(events[0].parentSpanId).toBe('span-parent');
});
```

**Step 3: Add fallback chain test**

```typescript
test('falls through to platform_events when memory is empty', async () => {
  // Mock empty memory store
  mockTraceStore.getEvents.mockReturnValue([]);
  // Mock platform_events with data
  mockClickHouseQuery.mockResolvedValue([{ event_type: 'agent.entered', ... }]);

  const res = await request(app).get('/api/sessions/sess-1/traces');

  expect(res.body._meta.source).toBe('clickhouse_platform_events');
  expect(res.body.traces).toHaveLength(1);
});

test('returns empty when both memory and platform_events are empty', async () => {
  mockTraceStore.getEvents.mockReturnValue([]);
  mockClickHouseQuery.mockResolvedValue([]);

  const res = await request(app).get('/api/sessions/sess-1/traces');

  expect(res.body.traces).toHaveLength(0);
});
```

**Step 4: Add span children endpoint fallback test (H6)**

```typescript
test('/:id/traces/:spanId/children falls back to platform_events when memory is empty', async () => {
  mockTraceStore.getSpanChildren.mockReturnValue([]);
  mockClickHouseQuery.mockResolvedValue([
    { event_type: 'agent.constraint.checked', span_id: 'child-1', parent_span_id: 'parent-1', ... },
    { event_type: 'agent.decision', span_id: 'child-2', parent_span_id: 'parent-1', ... },
  ]);

  const res = await request(app).get('/api/sessions/sess-1/traces/parent-1/children');

  expect(res.body).toHaveLength(2);
  expect(res.body[0].spanId).toBe('child-1');
});
```

**Step 5: Add encryption interceptor test (H13)**

```typescript
test('encryption interceptor is applied to queryClickHousePlatformEvents()', async () => {
  // Mock getClickHouseEncryptionInterceptor to return a spy
  const interceptorSpy = vi.fn((rows) => rows.map((r) => ({ ...r, data: '{"decrypted":true}' })));
  mockGetEncryptionInterceptor.mockReturnValue(interceptorSpy);

  // Mock platform_events with encrypted data
  mockClickHouseQuery.mockResolvedValue([
    { event_type: 'agent.decision', data: 'encrypted-blob', ... },
  ]);

  const res = await request(app).get('/api/sessions/sess-1/traces');

  expect(interceptorSpy).toHaveBeenCalledTimes(1);
  expect(res.body.traces[0].data.decrypted).toBe(true);
});
```

**Step 6: Run and commit**

```bash
cd apps/runtime && pnpm vitest run src/routes/__tests__/sessions-platform-events.test.ts
```

```
test(runtime): update sessions query tests for single ClickHouse source
```

---

### Task 15: Studio event type normalizer tests

**Files:**

- Create: `apps/studio/src/__tests__/event-types.test.ts`

**Step 1: Write tests**

```typescript
import { describe, test, expect } from 'vitest';
import { normalizeEventType } from '../lib/event-types';

describe('normalizeEventType', () => {
  test('normalizes dotted types to underscore', () => {
    expect(normalizeEventType('llm.call.completed')).toBe('llm_call');
    expect(normalizeEventType('llm.call.failed')).toBe('llm_call');
    expect(normalizeEventType('agent.decision')).toBe('decision');
    expect(normalizeEventType('agent.constraint.checked')).toBe('constraint_check');
    expect(normalizeEventType('system.error')).toBe('error');
  });

  test('passes through underscore types unchanged', () => {
    expect(normalizeEventType('llm_call')).toBe('llm_call');
    expect(normalizeEventType('decision')).toBe('decision');
    expect(normalizeEventType('constraint_check')).toBe('constraint_check');
  });

  test('passes through unknown types unchanged', () => {
    expect(normalizeEventType('custom_thing')).toBe('custom_thing');
    expect(normalizeEventType('some.unknown.type')).toBe('some.unknown.type');
  });
});
```

**Step 2: Run and commit**

```bash
cd apps/studio && pnpm vitest run src/__tests__/event-types.test.ts
```

```
test(studio): add normalizeEventType unit tests
```

---

### Task 15b: Studio ingestion point tests

**Files:**

- Create: `apps/studio/src/__tests__/observatory-store-ingestion.test.ts`
- Create: `apps/studio/src/__tests__/replay-trace-events.test.ts`

These tests verify that `normalizeEventType()` is correctly applied at the 3 UI ingestion points (not just as a pure function in Task 15).

**Step 1: Write observatory-store addEvent() normalization test (ingestion point 1)**

```typescript
import { describe, test, expect, beforeEach } from 'vitest';
import { useObservatoryStore } from '../store/observatory-store';

describe('observatory-store ingestion', () => {
  beforeEach(() => {
    useObservatoryStore.getState().reset();
  });

  test('addEvent() normalizes dotted event types at ingestion', () => {
    const store = useObservatoryStore.getState();
    store.addEvent({
      type: 'agent.decision',
      sessionId: 's1',
      timestamp: Date.now(),
      data: { decisionKind: 'handoff', outcome: 'agent-b' },
    });

    const events = store.events;
    expect(events).toHaveLength(1);
    // The stored event must have the normalized underscore type
    expect(events[0].type).toBe('decision');
  });

  test('addEvent() passes through underscore types unchanged', () => {
    const store = useObservatoryStore.getState();
    store.addEvent({
      type: 'decision',
      sessionId: 's1',
      timestamp: Date.now(),
      data: { decisionKind: 'handoff' },
    });

    expect(store.events[0].type).toBe('decision');
  });
});
```

**Step 2: Write replay-trace-events normalization test (ingestion point 2)**

```typescript
import { describe, test, expect, vi, beforeEach } from 'vitest';
import { replayTraceEventsIntoObservatory } from '../utils/replay-trace-events';
import { useObservatoryStore } from '../store/observatory-store';

describe('replayTraceEventsIntoObservatory', () => {
  beforeEach(() => {
    useObservatoryStore.getState().clearEvents();
  });

  test('normalizes dotted event types at ingestion', () => {
    // NOTE: replayTraceEventsIntoObservatory(events, sessionId) takes a string sessionId,
    // NOT a callback. It calls useObservatoryStore.getState().addEvent() internally.
    // Normalization happens INSIDE addEvent() (Task 7 Step 3), so we check the
    // stored events in the Zustand store, not the spy arguments.
    const events = [
      { type: 'agent.decision', data: { decisionKind: 'handoff' }, timestamp: 1 },
      { type: 'llm.call.completed', data: { model: 'gpt-4' }, timestamp: 2 },
      { type: 'constraint_check', data: {}, timestamp: 3 }, // already underscore
    ];

    replayTraceEventsIntoObservatory(events as any, 'test-session-id');

    // Check the store's stored events — addEvent() normalizes types internally
    const storedEvents = useObservatoryStore.getState().events;
    expect(storedEvents).toHaveLength(3);
    expect(storedEvents[0].type).toBe('decision');
    expect(storedEvents[1].type).toBe('llm_call');
    expect(storedEvents[2].type).toBe('constraint_check');
  });
});
```

**Step 3: Run and commit**

```bash
cd apps/studio && pnpm vitest run src/__tests__/observatory-store-ingestion.test.ts src/__tests__/replay-trace-events.test.ts
```

```
test(studio): add ingestion point normalization tests for observatory-store and replay
```

---

### Task 16: ClickHouse round-trip integration test (requires Docker)

**Files:**

- Create: `apps/runtime/src/__tests__/integration/trace-platform-events.integration.test.ts`

This test writes trace events through the real pipeline and reads them back via the sessions query layer. Runs only when ClickHouse is available (Docker).

**Step 1: Write the integration test**

```typescript
import { describe, test, expect, beforeAll, afterAll } from 'vitest';

const skipIntegration = !process.env.CLICKHOUSE_URL && !process.env.CI;

describe.skipIf(skipIntegration)('Trace → platform_events round-trip', () => {
  let clickhouse: ReturnType<typeof getClickHouseClient>;
  const testTenantId = `test-tenant-${Date.now()}`;
  const testSessionId = `test-session-${Date.now()}`;

  beforeAll(async () => {
    const { getClickHouseClient } = await import('@agent-platform/database/clickhouse');
    clickhouse = getClickHouseClient();
    // Ensure schema exists
    const { initializeClickHouseSchemas } =
      await import('@agent-platform/database/clickhouse-schemas');
    await initializeClickHouseSchemas(clickhouse);
  });

  afterAll(async () => {
    // Cleanup test data
    if (clickhouse) {
      await clickhouse.command({
        query: `DELETE FROM abl_platform.platform_events WHERE tenant_id = '${testTenantId}'`,
      });
    }
  });

  test('span_id and parent_span_id survive write/read cycle', async () => {
    const { BufferedClickHouseWriter } = await import('@agent-platform/database/clickhouse');
    const writer = new BufferedClickHouseWriter(clickhouse, {
      table: 'abl_platform.platform_events',
      batchSize: 1,
    });

    await writer.insert({
      event_id: crypto.randomUUID(),
      event_type: 'agent.constraint.checked',
      category: 'agent',
      tenant_id: testTenantId,
      project_id: 'project-1',
      session_id: testSessionId,
      agent_name: 'travel',
      timestamp: new Date().toISOString(),
      span_id: 'span-test-123',
      parent_span_id: 'span-test-parent',
      data: JSON.stringify({ constraint: 'budget > 0', passed: true }),
    });

    await writer.flush();

    // Wait for async insert to settle
    await new Promise((r) => setTimeout(r, 2000));

    const result = await clickhouse.query({
      query: `SELECT span_id, parent_span_id FROM abl_platform.platform_events
              WHERE session_id = {sessionId:String} AND tenant_id = {tenantId:String}`,
      query_params: { sessionId: testSessionId, tenantId: testTenantId },
      format: 'JSONEachRow',
    });

    const rows = await result.json<{ span_id: string; parent_span_id: string }[]>();
    expect(rows).toHaveLength(1);
    expect(rows[0].span_id).toBe('span-test-123');
    expect(rows[0].parent_span_id).toBe('span-test-parent');
  });

  test('dotted event types survive write/read and are queryable by category', async () => {
    const { BufferedClickHouseWriter } = await import('@agent-platform/database/clickhouse');
    const writer = new BufferedClickHouseWriter(clickhouse, {
      table: 'abl_platform.platform_events',
      batchSize: 10,
    });

    const eventTypes = [
      { event_type: 'llm.call.completed', category: 'llm' },
      { event_type: 'agent.decision', category: 'agent' },
      { event_type: 'flow.step.entered', category: 'flow' },
    ];

    for (const et of eventTypes) {
      await writer.insert({
        event_id: crypto.randomUUID(),
        event_type: et.event_type,
        category: et.category,
        tenant_id: testTenantId,
        project_id: 'project-1',
        session_id: testSessionId,
        agent_name: 'travel',
        timestamp: new Date().toISOString(),
        span_id: '',
        parent_span_id: '',
        data: '{}',
      });
    }

    await writer.flush();
    await new Promise((r) => setTimeout(r, 2000));

    // Query by category
    const result = await clickhouse.query({
      query: `SELECT event_type FROM abl_platform.platform_events
              WHERE session_id = {sessionId:String} AND tenant_id = {tenantId:String}
              AND category = 'agent'`,
      query_params: { sessionId: testSessionId, tenantId: testTenantId },
      format: 'JSONEachRow',
    });

    const rows = await result.json<{ event_type: string }[]>();
    const types = rows.map((r) => r.event_type);
    expect(types).toContain('agent.decision');
    expect(types).toContain('agent.constraint.checked');
    expect(types).not.toContain('llm.call.completed');
  });
});
```

**Step 2: Run with Docker**

```bash
docker compose up -d clickhouse
CLICKHOUSE_URL=http://localhost:8124 cd apps/runtime && pnpm vitest run src/__tests__/integration/trace-platform-events.integration.test.ts
```

**Step 3: Commit**

```
test(runtime): add ClickHouse round-trip integration test for platform_events
```

---

### Task 17: Manual Observatory verification checklist

No code — this is a manual testing protocol for after all tasks are complete.

**Prerequisites:**

- `docker compose up` (ClickHouse, MongoDB, Redis)
- `pnpm dev` (runtime + studio)
- Load a multi-agent project (Travel agent with constraints + handoff targets is ideal)

**Checklist:**

1. **Live session (WebSocket path):**
   - [ ] Send a message → Observatory timeline shows events in real-time
   - [ ] Decision badges show actual kind (e.g., "handoff", "constraint_check") — NOT just "decision"
   - [ ] Constraint check events show Shield icon with pass/fail status
   - [ ] Handoff condition checks appear once per target (not doubled)
   - [ ] SpanTree shows proper parent-child nesting

2. **Historical session (ClickHouse path):**
   - [ ] Close the session tab, reopen it → traces reload from ClickHouse
   - [ ] Event types display correctly (dotted types normalized to icons/labels)
   - [ ] Span tree reconstructs from `span_id`/`parent_span_id` columns
   - [ ] `_meta.source` in network tab shows `clickhouse_platform_events`

3. **Regression checks:**
   - [ ] No `abl_platform.traces` queries in ClickHouse query log
   - [ ] EventStore WAL directory exists and is written to
   - [ ] `USE_MONGO_CLICKHOUSE` env var has no effect on trace persistence
   - [ ] PII scrubbing still works (send SSN in message, check ClickHouse data doesn't contain it)

4. **Volume check:**
   - [ ] Query `SELECT count() FROM abl_platform.platform_events WHERE session_id = '...'`
   - [ ] Compare event count to what Observatory shows — should match
   - [ ] Verify no duplicate events (same event_id appearing twice)

---

## Open Questions (Resolved)

| OQ   | Question                        | Decision                                                                    | Task    |
| ---- | ------------------------------- | --------------------------------------------------------------------------- | ------- |
| OQ-1 | `USE_MONGO_CLICKHOUSE` scope    | Only remove trace-specific gates. Leave flag for messages/metrics/GDPR.     | Task 8  |
| OQ-2 | Metadata field standardization  | `outcome` (what) + `reasoning` (why). Deprecate `reason`.                   | Task 3  |
| OQ-3 | Decision metadata typing        | `Record<string, unknown>` with `.passthrough()` on Zod schemas.             | Task 3b |
| OQ-4 | Pipeline-engine trace queries   | Included as Task 7b in this plan.                                           | Task 7b |
| OQ-5 | Trace-forwarder EventStore path | Wire through trace-emitter (Option A).                                      | Task 7c |
| OQ-6 | Materialized view compatibility | Verify as part of Task 16 integration test. Views already use dotted types. | Task 16 |

---

## Review Findings: 67 Gaps Across 5 Risk Surfaces

Compiled from 5 parallel review agents. Gaps organized by severity, then by surface.

### CRITICAL — Showstoppers That Cause Silent Data Loss (ALL RESOLVED)

| #   | Gap                                                    | Resolution                                                                                                                         | Task     |
| --- | ------------------------------------------------------ | ---------------------------------------------------------------------------------------------------------------------------------- | -------- |
| C1  | **EventRegistry silently drops unmapped event types**  | Register all 27 dotted types + make emitter permissive for unknown types (warn, don't drop)                                        | Task 3b  |
| C2  | **`agent.decision` Zod schema rejects `decisionKind`** | Rewrite `AgentDecisionDataSchema` to accept camelCase `decisionKind` + `.passthrough()`                                            | Task 3b  |
| C3  | **trace-bridge data transformations silently lost**    | Drop normalization. Update all 14 Zod schemas to accept camelCase (what executors emit). Both WS and CH data use same field names. | Task 3b  |
| C4  | **No historical data backfill**                        | Accepted — no backward compat required. Old traces data is lost. Document cutover date.                                            | Decision |

### HIGH — Will Break Functionality or Tests (ALL RESOLVED)

| #   | Gap                                                | Resolution                                      | Task    |
| --- | -------------------------------------------------- | ----------------------------------------------- | ------- |
| H1  | `system.error` not registered in EventRegistry     | Registered in Task 3b + permissive fallback     | Task 3b |
| H2  | `agent.delegate.completed` not registered          | Registered in Task 3b + permissive fallback     | Task 3b |
| H3  | `observatory-store.ts` 22 type-switch branches     | Normalize at ingestion edge in `addEvent()`     | Task 7  |
| H4  | `SessionTimeline.tsx` 11 bare `.type ===`          | Recreated with normalizer                       | Task 7  |
| H5  | Category filter excludes `flow` and `system`       | Added to WHERE clause                           | Task 6  |
| H6  | Span children endpoint has no ClickHouse fallback  | Added ClickHouse fallback                       | Task 6  |
| H7  | LIMIT 500 vs 1000 discrepancy                      | Increased to 1000                               | Task 6  |
| H8  | `ClickHouseEventRow` missing span fields           | Added to interface                              | Task 2  |
| H9  | `fromRow()` not updated for span fields            | Added span field mapping                        | Task 2  |
| H10 | `TABLES_NEEDING_ENC_COLUMN` contains `'traces'`    | Removed in Task 6                               | Task 6  |
| H11 | `logDecision()` has 5+ untracked callers           | All callers listed in Task 7c                   | Task 7c |
| H12 | trace-forwarder bypasses EventStore                | Wired through trace-emitter                     | Task 7c |
| H13 | Encryption/decryption divergence                   | Added encryption parity to platform_events read | Task 6  |
| H14 | pipeline-engine queries nonexistent columns        | Rewritten with `JSONExtract*()` + dotted types  | Task 7b |
| H15 | `conversation-reader.ts` different encryption path | Addressed with pipeline-engine rewrite          | Task 7b |

### MEDIUM — Incorrect But Won't Crash (ALL RESOLVED)

| #   | Gap                                                       | Resolution                                                                          | Task     |
| --- | --------------------------------------------------------- | ----------------------------------------------------------------------------------- | -------- |
| M1  | Divergent DDL in `platform-events-table.ts`               | Span columns added to both DDL files                                                | Task 2   |
| M2  | ORDER BY doesn't include `session_id`                     | Accepted — bloom filter sufficient for current scale. Revisit if perf issues arise. | Deferred |
| M3  | 9 voice event types missing from normalizer               | Added all voice types to `DOTTED_TO_SIMPLE`                                         | Task 7   |
| M4  | `useSessionDetail.ts` has 14 bare `.type ===`             | All 14 checks updated                                                               | Task 7   |
| M5  | `event-colors.ts` keyed by underscore names               | Dotted type aliases added                                                           | Task 7   |
| M6  | `SessionSummaryPanel.tsx` reads `decisionType`            | Updated to `decisionKind`                                                           | Task 7   |
| M7  | `TracesExplorerTab.tsx` second decision read at line 252  | Both locations updated                                                              | Task 7   |
| M8  | `EventTimeline.tsx` reads `data.chosen` (never populated) | Reads `outcome` instead                                                             | Task 7   |
| M9  | Compiler `DecisionEvent` type union wrong vocabulary      | Updated to 11 `DecisionKind` values                                                 | Task 3   |
| M10 | Observatory `DecisionData` type union wrong vocabulary    | Updated to 11 `DecisionKind` values                                                 | Task 3   |
| M11 | `read-message-window.service.ts` needs `IN` not `=`       | Rewritten with dotted types                                                         | Task 7b  |
| M12 | `01-init.sql` needs span columns                          | Mirror changes from init.ts                                                         | Task 1   |
| M13 | `logHandoff()` data shape incompatible                    | Schema updated with `.passthrough()` + normalization                                | Task 3b  |

### Test Files That Will Break (20 files — ALL accounted for in tasks)

| File                                                 | Breaks Because                                                                                        | Resolved In |
| ---------------------------------------------------- | ----------------------------------------------------------------------------------------------------- | ----------- |
| `e2e/observatory-api-e2e.test.ts`                    | Mocks deleted `clickhouse-trace-singleton`                                                            | Task 8      |
| `session-routes.test.ts`                             | Mocks deleted `clickhouse-trace-singleton`                                                            | Task 8      |
| `runtime-lifecycle.test.ts`                          | Mocks deleted `clickhouse-trace-singleton`                                                            | Task 8      |
| `clickhouse-stores.test.ts`                          | Imports deleted `ClickHouseTraceStore` (4 store tests — only remove trace section)                    | Task 8      |
| `clickhouse-enterprise.test.ts`                      | `createTraceStore()` helper uses deleted store                                                        | Task 8      |
| `stress/runtime-channel-stress.test.ts`              | Asserts rows in `abl_platform.traces`                                                                 | Task 8      |
| `helpers/stress-test-server.ts`                      | Writes to `abl_platform.traces`                                                                       | Task 8      |
| `trace-emitter.test.ts`                              | `logDecision()` block (lines 520-576) + bridge mocks                                                  | Task 12     |
| `trace-forwarder.test.ts`                            | `logDecision` call + `decisionType` assertion                                                         | Task 7c     |
| `trace-forwarder-integration.test.ts`                | `logDecision: vi.fn()` mock shape                                                                     | Task 7c     |
| `compiler-stores-extended.test.ts`                   | `logDecision({ decisionType })` after rename                                                          | Task 7c     |
| `constructs/middleware-chain.test.ts`                | `logDecision: vi.fn()` mock shape                                                                     | Task 7c     |
| `runtimes/base-runtime.test.ts`                      | `logDecision: vi.fn()` mock shape                                                                     | Task 7c     |
| `sessions-platform-events.test.ts`                   | Mocks deleted `clickhouse-trace-singleton`                                                            | Task 14     |
| `pipeline-engine/conversation-reader.test.ts`        | Underscore event types in mocks                                                                       | Task 7b     |
| `pipeline-engine/compute-tool-effectiveness.test.ts` | Underscore event types in mocks                                                                       | Task 7b     |
| `eventstore/trace-bridge.test.ts`                    | Module deleted                                                                                        | Task 9      |
| `trace-wiring.test.ts`                               | `logDecision: vi.fn()` mock shape in TraceContextManager mock                                         | Task 7c     |
| `platform.e2e.test.ts`                               | `traceCtx.logDecision({ decisionType: 'routing' })` at line 385 — rename to `decisionKind: 'handoff'` | Task 7c     |
| `e2e/fixtures/test-utils.ts`                         | `logDecision: async () => {}` stub uses old `decisionType` field                                      | Task 7c     |

### Phantom File References (corrected)

| Wrong Reference                  | Correct File                | Note                                                                                     |
| -------------------------------- | --------------------------- | ---------------------------------------------------------------------------------------- |
| `clickhouse-trace-store.test.ts` | `clickhouse-stores.test.ts` | Contains 4 store tests — only remove trace section                                       |
| `sessions-traces.test.ts`        | Does not exist              | Removed from plan                                                                        |
| `eventstore-singleton.test.ts`   | Does not exist              | Removed from plan                                                                        |
| `wiring.test.ts`                 | Not affected                | Imports `otel-trace-bridge` (OpenTelemetry), NOT eventstore `trace-bridge` — false break |

---

## Summary

| Phase                   | Tasks  | Lines Removed   | Lines Added      |
| ----------------------- | ------ | --------------- | ---------------- |
| Phase 1 (non-breaking)  | 1-3b   | ~10             | ~200             |
| Phase 2 (refactor + UI) | 4-7c   | ~350            | ~500             |
| Phase 3 (cleanup)       | 8-11   | ~1,200+         | ~0               |
| Phase 4 (testing)       | 12-17  | ~50 (old tests) | ~450 (new tests) |
| **Total**               | **23** | **~1,610+**     | **~1,150**       |

**Net: ~460 lines removed, one ClickHouse table, one event vocabulary, zero translation layers, unified DecisionCard UI.**

### Review gap status (after Round 2 review)

- **4 Critical showstoppers:** ALL RESOLVED (C1-C4)
- **15 High gaps:** ALL RESOLVED (H1-H15)
- **13 Medium gaps:** 12 RESOLVED, 1 DEFERRED (M2 — ORDER BY optimization)
- **20 Broken test files:** ALL accounted for in tasks (was 17, found 3 more in Round 2)
- **3 Phantom file references:** ALL corrected
- **6 Open questions:** ALL RESOLVED
- **Round 2 findings:** 17 issues across 3 reviewers → ALL addressed (see below)

### Round 2 Review Findings (addressed)

| #   | Finding                                                                   | Fix Applied                                                                                                 |
| --- | ------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------- |
| S1  | Missing `AgentDelegateCompletedDataSchema` and `SystemErrorDataSchema`    | Task 3b Step 2: create both schemas                                                                         |
| S2  | Duplicate `register()` calls throw at startup                             | Task 3b Step 1: only register genuinely missing types, NOT already-registered ones                          |
| S3  | `decision_kind` (snake_case CH) vs `decisionKind` (camelCase UI) mismatch | Decision: drop normalizer entirely, update Zod schemas to accept camelCase                                  |
| S4  | `session_updated` and other types have no normalizer case                 | Resolved by S3 — no normalizer needed                                                                       |
| S5  | `fromRow()` H9 depends on Task 6 query changes                            | Sequencing note added; not a data loss issue                                                                |
| S6  | `projectId \|\| 'unknown'` corrupts analytics                             | Changed to `projectId ?? ''` in Task 5                                                                      |
| U1  | `addEvent()` stores original event, not normalized                        | Task 7 Step 3: explicit note to store `normalized` in `boundedPush`                                         |
| U2  | SessionTimeline depends on U1 fix                                         | Dependent — resolved when U1 fixed                                                                          |
| U3  | `useSessionDetail.ts` `buildAgentSubtree()` is 3rd ingestion path         | Task 7 Step 5: explicit three-point fix for useSessionDetail                                                |
| U4  | EventTimeline depends on U1 fix                                           | Dependent — resolved when U1 fixed                                                                          |
| U5  | `replay-trace-events.ts` `formatTraceEventLog()` missing                  | Added to Task 7 file list                                                                                   |
| T1  | `trace-wiring.test.ts` missing from table                                 | Added to 20-file table                                                                                      |
| T2  | `platform.e2e.test.ts` not tracked in table                               | Added to 20-file table                                                                                      |
| T3  | `wiring.test.ts` missing from table                                       | False break — imports `otel-trace-bridge`, not eventstore `trace-bridge`. Moved to Phantom File References. |
| T4  | Task 12 missing `normalizeTraceData()` test                               | Changed: test camelCase passthrough (no normalization)                                                      |
| T5  | Task 16 bypasses normalizer                                               | No longer applicable — no normalizer                                                                        |
| T6  | No test for EventRegistry permissive fallback                             | Added Task 13b                                                                                              |

### Round 3 Review Findings (Structural Coherence + Test Impact)

| #   | Finding                                                                                     | Fix Applied                                                                                                 |
| --- | ------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------- |
| R1  | `runtime-executor.ts` + `korevg-session.ts` directly import trace-bridge, bypassing emitter | Task 5 Step 5: migrate both files to `getEventStore().emitter.emit()`                                       |
| R2  | Task 8 missing 4 ClickHouseTraceStore import files (`store-factory`, `stores/index`, etc.)  | Task 8 Step 1: all 4 files listed with specific update instructions                                         |
| R3  | `compute-tool-effectiveness` queries top-level columns absent from `platform_events`        | Task 7b: explicit `JSONExtract*()` example with camelCase field names                                       |
| R4  | Task 6 removes `typeMap` before Task 7 adds `normalizeEventType()` — deploy gap             | Task 6: deploy ordering warning added                                                                       |
| R5  | Task 3b missing explicit list of all 14 Zod schema files                                    | Task 3b: full table of all 14 files with snake_case→camelCase field mappings                                |
| R6  | Task 7c `logDecision` caller list incomplete                                                | Task 7c: expanded to 10+ files (production callers + test files with mock shapes)                           |
| T7  | Task 12 missing `emitDecision()` test block                                                 | Task 12: 3 test cases added (emit with decisionKind, verbosity gating, span propagation)                    |
| T8  | Task 12 missing `logDecision()` deletion step                                               | Task 12: explicit step to delete `logDecision` test block (lines 520–576)                                   |
| T9  | Task 14 missing children endpoint ClickHouse fallback test                                  | Task 14: added children fallback test case                                                                  |
| T10 | `clickhouse-stores.test.ts` needs span column assertions                                    | Task 8: listed in 5-file test update block                                                                  |
| T11 | `clickhouse-enterprise.test.ts` needs encryption parity assertion                           | Task 8: listed in 5-file test update block                                                                  |
| T12 | `sessions-platform-events.test.ts` not tracked                                              | Task 8: added to test file updates                                                                          |
| T13 | Stress tests reference `ClickHouseTraceStore` directly                                      | Task 8: listed in 5-file test update block                                                                  |
| T14 | `trace-wiring.test.ts` mock shapes reference `logDecision`                                  | Task 7c: included in logDecision caller list for migration                                                  |
| T15 | `platform.e2e.test.ts` assertions check `traces` table                                      | Task 8: redirected to `platform_events` assertions                                                          |
| T16 | No camelCase passthrough test for Zod schemas                                               | Task 12: camelCase passthrough test added                                                                   |
| T17 | Task 13b EventRegistry permissive fallback has no test                                      | Task 13b: test verifies warn-and-pass for unknown types                                                     |
| T18 | `wiring.test.ts` missing from test file table                                               | False break — imports `otel-trace-bridge`, not eventstore `trace-bridge`. Moved to Phantom File References. |
| T19 | No test that updated Zod schemas accept camelCase (not just permissive fallback)            | Task 13b: 2 schema acceptance tests added (AgentDecision + AgentHandoff camelCase)                          |
| T20 | Task 7c's central behavioral guarantee (forwarder→EventStore) has no test                   | Task 7c: trace-forwarder.test.ts note expanded with critical behavioral test requirement                    |
| T21 | Observatory-store `addEvent()` normalization (ingestion point 1) untested                   | New Task 15b: `observatory-store-ingestion.test.ts`                                                         |
| T22 | `replay-trace-events.ts` normalization (ingestion point 2) has no test file at all          | New Task 15b: `replay-trace-events.test.ts`                                                                 |
| T23 | Encryption interceptor in rewritten `queryClickHousePlatformEvents()` untested              | Task 14 Step 5: encryption interceptor spy test added                                                       |
| T24 | `useSessionDetail.ts` normalization (ingestion point 3) untested                            | Deferred — requires complex SWR/hook test setup; covered by 15b pattern + Task 15 unit                      |

### What's preserved

- Memory TraceStore — ephemeral WebSocket broadcast (not persistence, not cross-pod). Note: `packages/mcp-debug/src/tools/decisions.ts` reads from memory TraceStore using underscore types — unaffected since memory store still receives underscore types. If MCP debug is later extended to query ClickHouse, its `decisionTypes` filter array will need dotted types.
- EventStore WAL recovery — genuine production resilience
- GDPR cascade hooks — compliance requirement
- Zod event schemas — updated to accept camelCase, wired into write path via permissive EventRegistry
- Materialized views — already on platform_events, untouched
- Encryption-at-rest — already on platform_events via `_enc` column

### What's removed

- `abl_platform.traces` table and all code that writes/reads it (no backfill — old data is lost)
- `trace-bridge.ts` (692 lines) — deleted entirely (no normalizer needed; Zod schemas accept camelCase directly)
- `ClickHouseTraceStore` (338 lines) and singleton (68 lines)
- `isClickHouseTraceEnabled()` and trace-specific gate sites
- Reverse type mapping in sessions.ts (30 lines)
- Lazy EventStore bridge loader in trace-emitter.ts (30 lines)
- `logDecision()` method and all `decisionType` field references
- `EVENTSTORE_ENABLED`, `EVENTSTORE_MODE`, `EVENTSTORE_BACKEND` config flags
- Memory backend fallback in eventstore-singleton
- Scattered inline decision rendering in Observatory (replaced by unified `DecisionCard`)

### What's new

- `DecisionCard` component — unified decision renderer with kind-specific icons, colors, and sections
- `normalizeEventType()` — edge normalizer for dotted↔underscore types (applied at 3 UI ingestion points)
- `DECISION_KIND_META` — icon/color/section map for all 11 decision kinds
- Permissive EventRegistry — warns on unknown types instead of silently dropping
- Zod schemas accept camelCase — consistent with executor output, no normalization layer

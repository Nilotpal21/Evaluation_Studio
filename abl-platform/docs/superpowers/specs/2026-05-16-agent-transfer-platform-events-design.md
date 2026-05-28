# Agent Transfer → Platform Events Design

**Ticket:** ABLP-511
**Date:** 2026-05-16
**Branch:** `feature/ABLP-511-agent-transfer-platform-events`

## Problem

Agent Transfer conversations are invisible in `abl_platform.platform_events` (ClickHouse). Three categories of data are missing:

1. **Transfer lifecycle events** — `transfer_initiated`, `agent_connected`, `transfer_completed`, `transfer_failed`, `agent_disconnected`, `csat_completed` — only reach Redis TraceStore via `createTraceStoreAdapter`, never ClickHouse.
2. **Messages during transfer** — user messages forwarded to human agents, and human agent replies — only go to MongoDB transcript (`persistMessageRecord`), never platform_events.
3. **ACW (After Contact Work) completion** — disposition codes, close reason, wrap-up notes — only update Redis transfer session state, never platform_events.

## Approach: Composite Adapter in the Runtime

All ClickHouse wiring lives in the runtime. The `packages/agent-transfer/` package stays clean — no EventStore dependency introduced.

---

## Section 1: New Event Types

### Transfer Lifecycle Events

7 new platform event types registered in `packages/eventstore/src/schema/events/agent-events.ts` and mapped in `packages/observatory/src/schema/trace-event-mappings.ts`:

| Internal trace type                    | Platform event type                 | Category |
| -------------------------------------- | ----------------------------------- | -------- |
| `agent_transfer.transfer_initiated`    | `agent.transfer.initiated`          | `agent`  |
| `agent_transfer.agent_connected`       | `agent.transfer.agent_connected`    | `agent`  |
| `agent_transfer.transfer_completed`    | `agent.transfer.completed`          | `agent`  |
| `agent_transfer.transfer_failed`       | `agent.transfer.failed`             | `agent`  |
| `agent_transfer.agent_disconnected`    | `agent.transfer.agent_disconnected` | `agent`  |
| `agent_transfer.csat_completed`        | `agent.transfer.csat_completed`     | `agent`  |
| `agent_transfer.acw_completed` _(new)_ | `agent.transfer.acw_completed`      | `agent`  |

### Message Events During Transfer

No new types. Reuse existing types with transfer-specific metadata in `data`:

| Direction          | Platform event type     | Key `data` fields added                                                                       |
| ------------------ | ----------------------- | --------------------------------------------------------------------------------------------- |
| User → human agent | `message.user.received` | `participantType: 'user'`, `source: 'agent-transfer'`, `transferSessionId`, `provider`        |
| Human agent → user | `message.agent.sent`    | `participantType: 'human_agent'`, `source: 'agent-transfer'`, `transferSessionId`, `provider` |

No raw message content — metadata only (`contentLength`, `channel`, `participantType`, `source`, `transferSessionId`, `provider`). PII never enters platform_events.

---

## Section 2: Composite Adapter (Lifecycle Events)

### New File

`apps/runtime/src/services/agent-transfer/eventstore-trace-adapter.ts`

Implements `TraceEventEmitter` (from `@agent-platform/agent-transfer`). On each `emit()`:

1. Calls `traceStore.addEvent()` — **identical to today, unchanged**.
2. Calls `emitToEventStore()` — **new, fire-and-forget, non-fatal**.

### Session Context Resolution

The `transferTraceEmitter` is a module-level singleton (not per-session). `tenantId` and `projectId` are extracted from `event.data` at emit time — `BaseTransferTrace` always carries both. `session_id` comes from `event.data.runtimeSessionId`, which call sites enrich when emitting (available as `routing.runtimeSessionId` in transfer session data). Falls back to `contactId` if absent.

### Boot Wiring

In `apps/runtime/src/services/agent-transfer/index.ts`, replace:

```ts
transferTraceEmitter = createTraceStoreAdapter(traceStore, 'agent-transfer');
```

with:

```ts
transferTraceEmitter = createEventStoreTraceAdapter(traceStore, getEventStore());
```

### Call Site Enrichment

**DSL path (`transfer-tool-executor.ts`):** `transfer_failed` is already emitted here. Enrich with `runtimeSessionId` (available as the tool executor's session context). Add `transfer_initiated` emit before the transfer call begins.

**Provider path (`apps/runtime/src/services/agent-transfer/index.ts`):** `agent_connected`, `agent_disconnected`, `transfer_completed`, and `csat_completed` are **currently never emitted** — the `emitTransferTraceEvent` call sites for these kinds do not exist yet. Add them in the `AgentEvent` handler in `index.ts` where `agent:connected`, `agent:disconnected`, and CSAT events are already processed. `runtimeSessionId` is available there as `runtimeSessionId` (from the session key parse or transfer session routing context).

---

## Section 3: Message Events

### Wiring Point

`AgentTransferTranscriptPersistenceService.persistTransferTranscriptMessage()` in `apps/runtime/src/services/agent-transfer/transcript-persistence.ts`.

This private method is the single chokepoint for all transfer messages. It already has `tenantId`, `projectId`, `parentConversationSessionId` (used as `session_id`), `role`, `channel`, `participantType`, and `transferSessionId` fully resolved.

Add `emitToEventStore()` **after** `persistMessageRecord()` succeeds (fire-and-forget):

```
role === 'user'    → event_type: 'message.user.received'
role === 'assistant' → event_type: 'message.agent.sent'

data: {
  contentLength: params.content.length,
  channel,
  participantType,      // 'user' | 'human_agent'
  source: 'agent-transfer',
  transferSessionId: params.transferSessionId,
  provider: params.transferSession.provider
}
```

### ACW Event

In `apps/runtime/src/services/agent-transfer/index.ts`, after `transferSessionStore.update(ablKey, sessionUpdate)` where ACW fields are applied (triggered by `agent:disconnected` with `isACWEnabled`):

```
event_type: 'agent.transfer.acw_completed'
data: {
  acwCloseReason,       // 'timeout' | 'agent_closed'
  acwTimedOut,
  dispositionCode,      // from event.data.closeStatus (disposition code set by human agent)
  reason,               // from event.data.closeRemarks (human agent wrap-up notes / reason)
  provider,
  channel,
  transferSessionId: ablKey,
  runtimeSessionId
}
```

`dispositionCode` maps to `closeStatus` and `reason` maps to `closeRemarks` in the incoming ACW event data — both are present in `PERSISTED_AGENT_TRANSFER_EVENT_DATA_KEYS` and available on `event.data` at the point of ACW processing in `index.ts`.

---

## Data Flow Summary

```
Transfer lifecycle event
  └─► emitTransferTraceEvent(emitter, event)
        ├─► traceStore.addEvent()              [Redis — unchanged]
        └─► emitToEventStore()                 [ClickHouse — new]
              ↳ tenantId, projectId from event.data
              ↳ session_id from event.data.runtimeSessionId

User/human-agent message
  └─► persistTransferTranscriptMessage()
        ├─► persistMessageRecord()             [MongoDB — unchanged]
        └─► emitToEventStore()                 [ClickHouse — new]
              ↳ event_type: message.user.received | message.agent.sent
              ↳ data: metadata only, no content

ACW completion
  └─► transferSessionStore.update()            [Redis — unchanged]
  └─► emitToEventStore()                       [ClickHouse — new]
        ↳ event_type: agent.transfer.acw_completed
```

---

## Files to Change

| File                                                                   | Change                                                                                                                                                                   |
| ---------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `packages/observatory/src/schema/trace-event-mappings.ts`              | Add 7 `agent_transfer.*` → `agent.transfer.*` mappings                                                                                                                   |
| `packages/eventstore/src/schema/events/agent-events.ts`                | Register 7 new event types with Zod schemas                                                                                                                              |
| `apps/runtime/src/services/agent-transfer/eventstore-trace-adapter.ts` | **New file** — composite TraceEventEmitter                                                                                                                               |
| `apps/runtime/src/services/agent-transfer/index.ts`                    | Wire composite adapter at boot; add new `emitTransferTraceEvent` calls for `agent_connected`, `agent_disconnected`, `transfer_completed`, `csat_completed`; add ACW emit |
| `apps/runtime/src/services/agent-transfer/transcript-persistence.ts`   | Add message EventStore emit in `persistTransferTranscriptMessage()`                                                                                                      |
| `apps/runtime/src/services/execution/transfer-tool-executor.ts`        | Add `transfer_initiated` emit; enrich `transfer_failed` emit with `runtimeSessionId`                                                                                     |

---

## Invariants Preserved

- **No breaking changes** — all existing TraceStore and MongoDB writes are unchanged. EventStore writes are additive, fire-and-forget.
- **No PII in platform_events** — message content never enters `data`; only `contentLength` and metadata.
- **Tenant isolation** — `tenant_id` sourced from `event.data.tenantId` (always present in `BaseTransferTrace`).
- **Ephemeral sessions excluded** — `_ephemeralExecution` guard applied on EventStore path (same as all other emitters).
- **agent-transfer package stays clean** — no EventStore or runtime dependency added to `packages/agent-transfer/`.

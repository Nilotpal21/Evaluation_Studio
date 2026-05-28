# High-Level Design: Agent Transfer Message Persistence

- **Feature ID:** F014-PERSIST
- **Parent Feature:** `docs/features/agent-transfer.md`
- **Related HLD:** `docs/specs/agent-transfer.hld.md`
- **Status:** PROPOSED
- **Created:** 2026-04-24

---

## 1. Overview

Agent Transfer already stores live transfer session state in Redis and persists parent conversation session terminal metadata in MongoDB when a transfer ends. What is missing is durable transcript persistence for the messages exchanged while a human agent is active. Today, those messages are routed live to the user channel, but they are not written through the standard runtime message persistence path into MongoDB and optional ClickHouse.

This design adds durable, per-message persistence for agent-transfer traffic while preserving the current Redis-backed transfer-session lifecycle model.

### 1.1 Goals

1. Persist human-agent transcript messages under the existing parent conversation session in MongoDB.
2. Reuse the existing message persistence queue and dual-write behavior for ClickHouse instead of creating a parallel transcript store.
3. Preserve message ordering, tenant isolation, idempotency, and retention behavior.
4. Make transfer-origin messages queryable and distinguishable from bot-origin messages.
5. Keep active transfer session state ephemeral in Redis.

### 1.2 Non-Goals

1. Replace Redis as the source of truth for active transfer sessions.
2. Persist provider webhook payloads verbatim as transcript messages.
3. Redesign post-agent disposition or CSAT flows.
4. Backfill historical transfer conversations that were never persisted.

---

## 2. Current State

### 2.1 What Exists Today

- Active transfer session state is stored in Redis via `TransferSessionStore` under `agent_transfer:{tenantId}:{ownerId}:{channel}`.
- Parent conversation messages are persisted asynchronously through `message-persistence-queue.ts`, which batches Mongo writes and optionally dual-writes to ClickHouse.
- Parent conversation session terminal metadata can be written to MongoDB at transfer end as `metadata.transferEnd`.
- User messages during an active transfer are forwarded to the provider adapter via `RuntimeExecutor`, bypassing normal bot execution.
- Agent desktop events are routed back to the user through `AgentTransferMessageBridge`.

### 2.2 Current Gap

The bridge and forwarding paths deliver transfer traffic live, but they do not durably persist that traffic as transcript messages in the parent conversation session. The existing queue API also does not carry enough metadata to represent transfer-specific provenance cleanly.

### 2.3 Why This Matters

- Session history shown in Studio and APIs is incomplete during human handoff.
- Analytics and audit views miss the human-agent portion of the conversation.
- ClickHouse reporting cannot distinguish bot-only sessions from transferred sessions at message granularity.
- Transfer end metadata exists without the corresponding transcript body.

---

## 3. Design Summary

Persist transfer messages into the existing parent conversation `messages` collection, not into a new transfer-specific durable collection.

The transfer session in Redis remains the live routing record. It supplies the routing context needed to resolve the parent conversation session and to annotate each persisted message with transfer metadata.

### 3.1 Core Decision

Use the existing message persistence queue as the only durable write path for transfer transcript messages, but extend its envelope so it can carry transcript metadata beyond the current `{ tenantId }` placeholder.

### 3.2 New Runtime Component

Add `AgentTransferTranscriptPersistenceService` in `apps/runtime/src/services/agent-transfer/`.

Responsibilities:

- Resolve the parent conversation session identity from the transfer session.
- Build a persistence envelope for transfer-origin messages.
- Generate stable idempotency keys for replay-safe writes.
- Call the standard queue API for Mongo and ClickHouse durability.
- Keep provider payload normalization out of route handlers and out of the generic message bridge.

---

## 4. Architecture

### 4.1 Write Paths

#### User -> Human Agent

1. Runtime detects `session.transferInitiated && session.isEscalated`.
2. Runtime forwards the user message to `adapter.sendUserMessage(...)`.
3. After provider send success, runtime persists the message through `AgentTransferTranscriptPersistenceService`.
4. The service writes into the parent conversation session, with role `user`.

This preserves the rule that the transcript should reflect messages actually accepted for transfer, not speculative local intent before provider handoff.

#### Human Agent -> User

1. Provider webhook is normalized into an `AgentEvent`.
2. `AgentTransferMessageBridge` delivers the event to WebSocket, channel adapter, or voice gateway.
3. After successful local delivery attempt, the bridge invokes `AgentTransferTranscriptPersistenceService`.
4. The service writes into the parent conversation session, typically with role `assistant`.

The persisted role stays `assistant` for compatibility with existing session transcript consumers, while metadata marks the message as human-agent authored.

#### Transfer System Events

Do not persist every provider lifecycle event as transcript content. Persist only user-visible text or structured transcript items:

- `agent:message`
- `agent:form`
- optional future system transcript entries for queue/wait messages when product explicitly wants them visible

### 4.2 Source of Parent Session Identity

The persistence service resolves the parent conversation session from transfer-session routing data:

- preferred: `routing.runtimeSessionId`
- fallback: `ownerId` when it is the runtime session id
- validated against `tenantId` and `projectId`

If the parent session cannot be resolved, the write fails closed and logs a structured warning. It must not write into an inferred cross-tenant or cross-project session.

### 4.3 Reused Durable Path

The service writes through `persistScopedMessage(...)` or an extended equivalent in `message-persistence-queue.ts`.

Why reuse:

- existing batching and BullMQ buffering
- existing Mongo idempotency handling
- existing retention resolution
- existing ClickHouse dual-write integration
- existing encryption and PII handling behavior

---

## 5. Data Contract

### 5.1 Required Message Metadata

Extend the persistence queue envelope and repository mapping so durable message rows can store:

```json
{
  "source": "agent-transfer",
  "transferSessionId": "agent_transfer:tenant:session:chat",
  "provider": "kore",
  "providerSessionId": "sa-123",
  "participantType": "user | human_agent | system",
  "direction": "user_to_agent | agent_to_user | system_to_user",
  "transferState": "pending | queued | active | post_agent",
  "deliveryChannels": ["websocket", "slack"],
  "agentInfo": {
    "agentId": "optional-provider-agent-id",
    "displayName": "optional-human-agent-name"
  }
}
```

Minimum requirement for Phase 1:

- `source`
- `transferSessionId`
- `provider`
- `providerSessionId`
- `participantType`
- `direction`

### 5.2 Queue Contract Changes

Extend `MessageJobData` and `batchCreateMessages(...)` inputs to carry:

- `metadata?: Record<string, unknown>`
- `sourceChannel?: string`
- `inputMode?: 'voice' | 'typed' | 'tool' | 'system'`
- `participantId?: string`
- `deliveryChannels?: string[]`
- `final?: boolean`

This aligns the queue with fields that already exist on the `Message` model but are not populated by the current batch path.

### 5.3 ClickHouse Contract

The ClickHouse dual-write path should receive the same metadata payload, not just `tenantId`.

This keeps transfer-origin analytics consistent across MongoDB and ClickHouse.

---

## 6. Ordering, Idempotency, and Delivery Semantics

### 6.1 Ordering

- Preserve per-session ordering by continuing to use the existing session-scoped promise chain in `message-persistence-queue.ts`.
- Use the parent conversation session id as the queue key, not the transfer session key.
- Use the original message generation timestamp when available from the provider event.

### 6.2 Idempotency

The current queue derives idempotency from `(sessionId, role, content, contentEnvelope, timestamp)`. For transfer persistence, extend this to include transfer provenance:

- `transferSessionId`
- `providerSessionId`
- provider event id or provider message id when available

This prevents duplicate writes during webhook retries or cross-pod relay replay.

### 6.3 Delivery Policy

- User -> provider: persist after adapter send success.
- Provider -> user: persist after successful local delivery attempt.
- If delivery fails on the current pod and the event is cross-pod relayed, persist only on the pod that actually delivers.

This avoids double writes and avoids storing messages that were never surfaced to the user.

---

## 7. Failure Handling

### 7.1 Fail-Closed Rules

- Missing `tenantId` or unresolved parent session: do not persist.
- Parent session outside project scope: do not persist.
- Transfer session missing provider provenance: persist only if `transferSessionId` and parent session can still be trusted; otherwise drop and log.

### 7.2 Runtime Failure Behavior

- Persistence failure must not block live message delivery.
- Errors should be logged and traced with `source=agent-transfer`.
- BullMQ fallback-to-direct-write behavior remains acceptable, but only when the same tenant/project validation has already passed.

### 7.3 Observability

Add trace events:

- `agent_transfer_message_persist_queued`
- `agent_transfer_message_persist_succeeded`
- `agent_transfer_message_persist_failed`
- `agent_transfer_message_persist_deduplicated`

Useful dimensions:

- `tenantId`
- `projectId`
- `parentSessionId`
- `transferSessionId`
- `provider`
- `direction`

---

## 8. Security and Compliance

- Tenant isolation stays anchored on the parent conversation session and transfer session tenant match.
- The persistence service must never infer parent session identity from provider payload alone.
- Reuse existing PII scrubbing and encryption behavior from the message persistence queue.
- Retention should continue to follow the parent conversation session tenant/project retention policy.
- Right-to-erasure stays unchanged because transfer transcript rows live in the same message store already covered by session/contact scrubbing.

---

## 9. Rollout Plan

### Phase 1

- Add transcript persistence service.
- Persist text messages for user -> agent and agent -> user.
- Extend queue metadata contract.
- Extend ClickHouse dual-write metadata propagation.

### Phase 2

- Persist structured form events with `contentEnvelope`.
- Populate `deliveryChannels`, `participantId`, and `inputMode`.
- Add Studio transcript badges for transfer-origin messages.

### Phase 3

- Optional persistence of selected system events such as waiting messages or queue updates.
- Optional sequence numbering improvements for omnichannel merged transcripts.

---

## 10. Testing Strategy

### Integration

- User message forwarded to provider is persisted into Mongo under the parent session.
- Agent webhook message delivered through bridge is persisted into Mongo under the parent session.
- Duplicate webhook replay does not create duplicate message rows.
- ClickHouse dual-write receives transfer metadata.
- Cross-tenant transfer-session mismatch returns no write.

### E2E

- Full transfer lifecycle produces a complete transcript in session history, not just `metadata.transferEnd`.
- Studio transcript view shows bot messages and human-agent messages in one ordered timeline.
- Voice transfer transcript persists TTS-visible human-agent messages under the same parent session.

---

## 11. Open Decisions

1. Whether human-agent messages should remain `role: 'assistant'` for compatibility, or whether transcript consumers are ready for a richer participant model.
2. Whether failed local delivery attempts should be persisted as hidden audit/system transcript rows.
3. Whether queue/wait events should be user-visible transcript messages or trace-only observability events.

---

## 12. Recommended Implementation Shape

1. Extend `message-persistence-queue.ts` and `session-repo.ts` to accept rich message metadata and existing `Message` model fields.
2. Add `AgentTransferTranscriptPersistenceService`.
3. Call it from `RuntimeExecutor` after `adapter.sendUserMessage(...)`.
4. Call it from `AgentTransferMessageBridge` after successful delivery for `agent:message` and `agent:form`.
5. Add regression tests for Mongo persistence, ClickHouse propagation, dedupe, and tenant isolation.

This keeps one durable transcript path for all conversation traffic while preserving Redis as the live coordination layer for active transfers.

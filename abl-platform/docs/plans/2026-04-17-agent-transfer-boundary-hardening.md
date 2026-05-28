# LLD: Agent Transfer Boundary Hardening

- **Feature Specs:** `docs/features/agent-transfer.md`, `docs/features/omnichannel-session-continuity.md`
- **HLDs:** `docs/specs/agent-transfer.hld.md`, `docs/specs/omnichannel-session-continuity.hld.md`
- **Test Specs:** `docs/testing/agent-transfer.md`, `docs/testing/omnichannel-session-continuity.md`
- **Status:** PROPOSED
- **Created:** 2026-04-17
- **Baseline Audited:** `origin/develop@f7edf4014`
- **Primary Scope:** Close the remaining correctness and architectural gaps in the AI-to-human transfer boundary after the `agent-transfer-voice-v2` merge.

---

## 1. Why This Plan Exists

`origin/develop` now has the voice transfer and SmartAssist disconnect fixes from `agent-transfer-voice-v2`, but the transfer boundary is still inconsistent in four places that matter operationally:

1. transfer initiation does not use one canonical routing identity
2. non-WebSocket omnichannel return delivery is not wired end to end
3. active-transfer forwarding drops attachments plus message/session context
4. disconnect cleanup and cross-pod relay validation are still split across partially duplicated paths

These are not isolated bugs. They come from the same architectural gap: the transfer session does not persist a strongly typed routing and context envelope that every initiation path, relay path, delivery path, and teardown path can trust.

This plan introduces that contract and phases the rollout so we can harden behavior without a risky storage migration.

---

## 2. Terminology and Canonical Contract

### 2.1 Canonical Terms

| Term                        | Meaning                                                                        | Notes                                                                             |
| --------------------------- | ------------------------------------------------------------------------------ | --------------------------------------------------------------------------------- |
| `runtimeSessionId`          | The runtime session identifier used by the active AI session                   | This is the canonical transfer owner and the primary key for resuming the AI path |
| `contactId`                 | The verified or resolved business identity of the end user                     | Important for CRM/contact context, but not safe as the sole routing key           |
| `conversationSessionId`     | The persisted Mongo session row created by channel/session bootstrap           | This is where omnichannel return-route metadata already lives today               |
| `providerSessionId`         | The human-agent platform session/conversation identifier                       | Kore/Five9/provider-owned identifier                                              |
| `transferSessionKey`        | Redis key for the agent transfer session                                       | Remains `agent_transfer:{tenantId}:{ownerId}:{channel}` during rollout            |
| `normalizedTransferChannel` | Canonical transfer channel (`chat`, `messaging`, `email`, `voice`, `campaign`) | All initiation paths must normalize through one helper                            |
| `returnRoute`               | The channel-specific data needed to deliver agent output back to the customer  | WebSocket, channel adapter, or voice gateway                                      |

### 2.2 Proposed Typed Envelope

Add a strongly typed handoff contract in `packages/agent-transfer` and persist it on transfer sessions:

```ts
interface TransferRoutingContext {
  runtimeSessionId: string;
  conversationSessionId?: string;
  resolvedContactId?: string;
  normalizedTransferChannel: TransferChannel;
  sourceChannelType?: string;
  channelConnectionId?: string;
  externalSessionKey?: string;
  voice?: {
    callSid?: string;
    sipCallId?: string;
    gateway?: string;
  };
}

interface TransferContextSnapshot {
  identityHints?: {
    customerId?: string;
    anonymousId?: string;
    identityTier?: number;
    verificationMethod?: string;
    channelArtifactType?: string;
  };
  contact?: TransferContact & {
    displayName?: string;
  };
  interactionContext?: {
    language?: string;
    locale?: string;
    timezone?: string;
  };
  sessionContext?: Record<string, unknown>;
  messageMetadata?: Record<string, unknown>;
}
```

Update `TransferSessionData`, `CreateTransferSessionInput`, and `UpdateTransferSessionFields` to carry:

- `routing: TransferRoutingContext`
- `contextSnapshot?: TransferContextSnapshot`

`metadata` remains available for provider-specific or workflow-specific keys, but routing and core context stop living in an untyped bag.

### 2.3 Canonical Rules

1. `runtimeSessionId` is the canonical owner for transfer initiation, relay, delivery, and teardown.
2. `contactId` is business identity only; it may enrich the transfer but must not be the primary return-routing lookup key.
3. `conversationSessionId` is the authoritative source for digital return-route hydration when `channelConnectionId` or `sourceChannelType` are missing.
4. All provider disconnect signals normalize to one teardown flow.
5. All active-transfer user messages use one builder that carries text, attachments, and sanitized metadata.

---

## 3. Current Gaps on `develop`

### 3.1 Correctness Gaps

1. `routing-executor.ts` direct `ESCALATE` uses `session.id` as both `contactId` and `sessionId`, while `llm-wiring.ts` transfer tool context uses `contact_id ?? resolvedUserId` plus raw channel naming.
2. `runtime-executor.ts` active forwarding looks transfer sessions up by `session.id` plus caller channel, so tool-initiated transfers can be stored under an identity that the forward path does not later query.
3. `message-bridge.ts` relay validation checks the session key shape and tenant, but it still trusts event payload `contactId` and `channel` for local delivery.
4. `message-bridge.ts` non-WS digital delivery requires `event.data.channelType` and `event.data.connectionId`, but provider events do not populate those fields in production.
5. `runtime-executor.ts` forwards only text content to the human agent and drops attachments, interaction context, message metadata, and attachment references.
6. Kore cleanup still ends the Redis session only on the legacy raw close events, while the runtime now also clears flags on normalized `agent:disconnected`.

### 3.2 Architectural Gaps

1. identity and routing semantics are spread across runtime session state, caller context, conversation session metadata, transfer session metadata, and provider payloads
2. return-routing is implemented separately for WebSocket, channel adapters, and voice without a single routing primitive
3. message context lives in several existing subsystems, but the transfer boundary does not intentionally capture or propagate it

---

## 4. Goals and Non-Goals

### 4.1 Goals

1. Make transfer initiation, active forwarding, relay, delivery, and teardown agree on one canonical routing contract.
2. Make omnichannel return delivery work for WebSocket, channel adapters, and voice using persisted routing context.
3. Preserve attachments, interaction context, and message metadata across the AI-to-human boundary.
4. Eliminate stale transfer sessions caused by disconnect path drift.
5. Add extended coverage for identity, session management, context propagation, attachments, and cross-pod behavior.

### 4.2 Non-Goals

1. Rework the whole agent-transfer package or replace Redis with MongoDB for transfer sessions.
2. Redesign provider-specific UX behavior beyond what is needed for parity and explicit unsupported-field handling.
3. Expand omnichannel live-session features outside the transfer boundary.

---

## 5. Design Decisions

| ID  | Decision                                                                                                           | Rationale                                                                                                                                      |
| --- | ------------------------------------------------------------------------------------------------------------------ | ---------------------------------------------------------------------------------------------------------------------------------------------- |
| D-1 | Keep the existing Redis key format during rollout                                                                  | Minimizes migration risk; transfer sessions are TTL-bounded and do not justify a hard cutover                                                  |
| D-2 | Canonicalize on `runtimeSessionId` as transfer owner                                                               | This is the one identifier shared by runtime forwarding, WS lookup, and AI resume semantics                                                    |
| D-3 | Persist a typed `routing` object on the transfer session                                                           | Avoids reconstructing return-route state from partially overlapping sources                                                                    |
| D-4 | Dual-write routing context from both initiation paths before enforcing relay and delivery changes                  | Allows compatibility with existing sessions until they age out                                                                                 |
| D-5 | Durable `channel_sessions` stores a safe allowlisted subset of `sessionMetadata` plus digital return-route context | The channel-session record is the continuity surface that outlives Redis runtime sessions, but it must not become a dump for arbitrary secrets |
| D-6 | Introduce a single active-transfer message builder                                                                 | Ensures attachments, reserved metadata filtering, and interaction context are handled consistently                                             |
| D-7 | Normalize all provider disconnect signals to one teardown helper                                                   | Prevents drift between event-handler mapping, runtime flag reset, and Redis session cleanup                                                    |
| D-8 | Five9 gets real metadata parity                                                                                    | Metadata propagation is part of the transfer contract, not a provider-specific optional extra                                                  |

---

## 6. Proposed Module Changes

### 6.1 New Runtime Helpers

Create:

- `apps/runtime/src/services/agent-transfer/transfer-routing-context.ts`
- `apps/runtime/src/services/agent-transfer/transfer-message-builder.ts`
- `apps/runtime/src/services/agent-transfer/transfer-teardown.ts`

Responsibilities:

- normalize channel and owner identity
- assemble `TransferRoutingContext` from runtime session, caller context, and conversation session metadata
- build forwarded `UserMessage` payloads with attachments and sanitized metadata
- centralize disconnect and cleanup behavior

### 6.2 Package Contract Changes

Update:

- `packages/agent-transfer/src/session/types.ts`
- `packages/agent-transfer/src/types.ts`
- `packages/agent-transfer/src/session/transfer-session-store.ts`
- related Lua serialization/parsing helpers and tests

Key additions:

- typed `routing` and `contextSnapshot` session fields
- helpers like `normalizeTransferChannel()` and `resolveTransferOwnerId()`
- parse/write support that dual-reads legacy sessions without the new fields

### 6.3 Durable Channel Session and Conversation Session Repository Changes

Update:

- `apps/runtime/src/repos/channel-session-repo.ts`
- `apps/runtime/src/repos/session-repo.ts`
- `apps/runtime/src/channels/session-resolver.ts`

Add a targeted helper that can safely load transfer-relevant metadata for one durable channel session:

```ts
findTransferChannelSessionContext(channelConnectionId, externalSessionKey, tenantId);
```

This helper should return the fields the transfer layer needs to rehydrate transfer routing and the durable allowlisted subset of `sessionMetadata`:

- `_id`
- `tenantId`
- `channelConnectionId`
- `externalSessionKey`
- `sessionId`
- `projectId`
- `metadata.channelConnectionId`
- `metadata.channelType`
- `metadata.externalSessionKey`
- `metadata.sessionMetadata` (durable allowlisted subset only)

Current hybrid implementation target:

- top-level `language`, `locale`, `timezone`
- nested `clientInfo.{language, locale, timezone}`
- nested `interactionContext.{language, locale, timezone}`

Add a second targeted helper for conversation-session linkage when transfer logic needs persisted runtime session context:

```ts
findTransferConversationSessionContext(sessionId, tenantId);
```

This helper should return only the fields the transfer layer needs from the conversation session:

- `_id`
- `tenantId`
- `projectId`
- `contactId`
- `channel`

Do not widen the generic `findSessionById()` projection for unrelated callers.
Update `session-resolver.ts` so durable channel sessions persist a reloadable allowlisted subset of `sessionMetadata`, while fresh ingress metadata continues to overlay that durable base at runtime.

---

## 7. Phased Implementation Plan

### Phase 1: Canonical Routing Contract

**Goal:** define the transfer owner and routing envelope once, then write it from both initiation paths.

**Files**

- `packages/agent-transfer/src/session/types.ts`
- `packages/agent-transfer/src/session/transfer-session-store.ts`
- `packages/agent-transfer/src/types.ts`
- `packages/agent-transfer/src/tools/transfer-to-agent.ts`
- `apps/runtime/src/services/agent-transfer/transfer-routing-context.ts`

**Changes**

1. Add `TransferRoutingContext` and `TransferContextSnapshot` to the package contract.
2. Add shared helpers for channel normalization and owner resolution.
3. Make the transfer session store parse and persist `routing` plus `contextSnapshot`.
4. Keep the legacy Redis session key format, but define `ownerId = runtimeSessionId` in all new writes.
5. Dual-read older sessions that do not yet have `routing`.

**Exit Criteria**

- both legacy and new transfer sessions can be read
- new transfer sessions always persist `routing.runtimeSessionId`
- new transfer sessions always persist `routing.normalizedTransferChannel`

### Phase 2: Unify Transfer Initiation

**Goal:** make direct escalation and tool-driven transfer produce the same transfer contract.

**Files**

- `apps/runtime/src/services/execution/routing-executor.ts`
- `apps/runtime/src/services/execution/llm-wiring.ts`
- `apps/runtime/src/services/execution/transfer-tool-executor.ts`
- `packages/agent-transfer/src/tools/transfer-to-agent.ts`

**Changes**

1. Replace ad hoc contact/channel assembly in `routing-executor.ts` and `llm-wiring.ts` with one runtime helper.
2. Ensure both paths pass:
   - canonical `runtimeSessionId`
   - normalized transfer channel
   - `conversationSessionId` when available
   - resolved contact details
   - identity hints needed for omnichannel-safe routing and audit
   - interaction context snapshot
3. Make tool-driven transfers explicitly mark the runtime session with the same post-success state transition used by direct escalation.
4. Preserve existing voice transfer data extraction, but attach it under `routing.voice`.
5. Extend `TransferToolContext` so the tool path can carry the same routing envelope as direct escalation instead of rebuilding it from `contactId` plus raw caller channel.

**Exit Criteria**

- both initiation paths produce the same `transferSessionKey`
- both initiation paths persist equivalent `routing` data
- tool-driven transfers are discoverable by the active-forwarding path

### Phase 3: Omnichannel Return Routing and Relay Hardening

**Goal:** deliver agent output through a trusted return route instead of reconstructing it from mixed payload fields.

**Files**

- `apps/runtime/src/services/agent-transfer/message-bridge.ts`
- `apps/runtime/src/services/agent-transfer/index.ts`
- `apps/runtime/src/repos/channel-session-repo.ts`
- `apps/runtime/src/repos/session-repo.ts`
- `apps/runtime/src/channels/session-resolver.ts`

**Changes**

1. Update `routeAgentEvent()` to resolve delivery targets from stored `routing`.
2. For WebSocket delivery, use `routing.runtimeSessionId` as the primary lookup.
3. For digital channels, use `routing.channelConnectionId` and `routing.sourceChannelType`; if missing, hydrate once from durable channel-session first, including the allowlisted durable subset of `sessionMetadata`, and use the conversation session only for secondary linkage fields.
4. For voice, use `routing.voice.callSid` first and `routing.runtimeSessionId` second.
5. Strengthen `handleCrossPodEvent()` so relayed payload `contactId` and `channel` must match the stored or parsed routing context before delivery.
6. When local delivery fails, publish the event with the canonical routing data needed by the receiving pod.
7. Cache hydrated durable channel-session routing plus the allowlisted durable metadata subset back onto the transfer session so later events do not repeat the lookup.

**Exit Criteria**

- channel-adapter delivery no longer depends on test-only metadata injection
- durable channel-session can rehydrate the allowlisted `sessionMetadata` subset needed for transfer continuity
- cross-pod relay rejects mismatched same-tenant `contactId` and `channel`
- voice delivery prefers stored voice identifiers over event payload fallbacks

### Phase 4: Message Envelope, Metadata, and Attachments

**Goal:** forward the real user message to the human agent, not just plain text.

**Files**

- `apps/runtime/src/services/runtime-executor.ts`
- `apps/runtime/src/services/agent-transfer/transfer-message-builder.ts`
- `apps/runtime/src/services/execution/interaction-context.ts`
- `apps/runtime/src/services/identity/sdk-message-metadata.ts`
- `packages/agent-transfer/src/types.ts`
- `packages/agent-transfer/src/adapters/kore/index.ts`
- `packages/agent-transfer/src/adapters/five9/index.ts`

**Changes**

1. Add a builder that assembles `UserMessage` with:
   - `content`
   - `attachments`
   - sanitized `metadata`
2. Build from `ExecuteMessageOptions` plus attachment-preprocess output, not from late-mutated session state.
   - The active-transfer intercept runs before `applyMessageMetadataToSession()`.
   - The active-transfer intercept also runs before `session.currentAttachmentIds` is populated for flow executors.
3. Metadata should include only transfer-safe fields:
   - normalized SDK message metadata
   - resolved interaction context
   - attachment identifiers or URLs already allowed for the channel
   - transfer-safe channel/session hints
4. Exclude reserved transport-only keys from the forwarded metadata bag.
5. Update active-transfer forwarding in `runtime-executor.ts` to call the builder.
6. Kore continues forwarding attachments and metadata.
7. Implement real metadata parity for Five9 using the same provider-neutral transfer metadata envelope.
8. If attachment parity is constrained by provider behavior, surface that explicitly via capability checks and traces instead of silently dropping data.
9. Replace the current channel-session stripping behavior with hybrid persistence/reload semantics: durable allowlisted subset in `channel_sessions`, fresh ingress overlay at runtime, and updated tests for both paths.

**Exit Criteria**

- forwarded transfer messages can include attachments
- forwarded transfer messages can include sanitized metadata
- Five9 receives real transfer metadata parity
- durable channel-session `sessionMetadata` subset survives and can be reloaded for transfer continuity

### Phase 5: Unified Disconnect and Session Teardown

**Goal:** one disconnect event ends the transfer lifecycle everywhere.

**Files**

- `packages/agent-transfer/src/adapters/kore/event-handler.ts`
- `packages/agent-transfer/src/adapters/kore/index.ts`
- `apps/runtime/src/services/agent-transfer/index.ts`
- `apps/runtime/src/services/agent-transfer/transfer-teardown.ts`

**Changes**

1. Introduce a teardown helper that:
   - ends the transfer session
   - clears runtime transfer flags
   - updates voice disconnect reason when present
   - emits trace/log context once
2. Make Kore inbound handling invoke teardown for all normalized disconnect forms, including:
   - `closed`
   - `conversation_closed`
   - `agent_disconnect`
   - `start_kore_agent_chat_close_for_user`
   - synthetic close-message disconnects
   - `remove_id_to_acc_identity`
3. For `postAgentAction=return`, perform resume cleanup, clear runtime transfer flags, then transition the transfer session into a short terminal audit/debug state with its own bounded TTL before final expiry.
4. Preserve immediate cleanup semantics for `postAgentAction=end`.

**Exit Criteria**

- no normalized disconnect path leaves a stale Redis transfer session behind
- runtime transfer flags are cleared exactly once
- voice disconnect reasons remain available for post-call inspection
- `postAgentAction=return` sessions remain inspectable for a short bounded audit/debug window after resume cleanup

### Phase 6: Extended Coverage and Observability

**Goal:** lock the boundary down with focused tests and traceability.

**Unit Coverage**

- session type parse/write backward compatibility
- channel normalization and owner resolution
- relay validation against routing context
- transfer message builder metadata filtering
- disconnect normalization and teardown fan-in

**Integration Coverage**

- direct escalation and tool-driven transfer produce the same routing contract
- durable channel-session allowlisted `sessionMetadata` subset and routing metadata round-trip through persistence and reload
- conversation-session metadata hydration fills remaining secondary linkage fields
- active-transfer forwarding carries attachments and metadata into Kore
- active-transfer forwarding carries transfer metadata into Five9 with parity to the shared contract
- relay and delivery work with Redis-backed session store reads

**E2E Coverage**

1. WebSocket transfer return path by `runtimeSessionId`
2. `http_async` or channel-adapter return path using persisted `channelConnectionId`
3. voice transfer with `callSid`-based delivery
4. tool-driven transfer followed by active user message forwarding
5. attachment forwarding during active transfer
6. cross-pod relay rejection for mismatched same-tenant payloads
7. SmartAssist synthetic close-message disconnect cleanup
8. `remove_id_to_acc_identity` cleanup
9. `postAgentAction=return` resume path
10. tenant and project isolation for transfer-session lookup and conversation-session hydration
11. durable channel-session rehydrates the allowlisted `sessionMetadata` subset after runtime session expiry

**Observability**

Add trace or structured log fields for:

- `runtimeSessionId`
- `conversationSessionId`
- `transferSessionKey`
- `normalizedTransferChannel`
- `returnRouteKind`
- `deliveryResolutionSource` (`transfer_session`, `conversation_session`, `legacy_fallback`)
- `unsupportedTransferFields`

**Exit Criteria**

- new tests cover the identity, routing, metadata, attachments, and teardown seams called out in this plan
- every delivery path can be debugged from traces without inferring hidden routing state

---

## 8. Rollout, Compatibility, and Migration

### 8.1 Rollout Strategy

Use a narrow compatibility lane:

1. **dual-read / dual-write**
   - new sessions write `routing` and `contextSnapshot`
   - reads support both new and legacy sessions
2. **enforce canonical delivery**
   - delivery prefers stored routing context
   - legacy fallback remains only when routing is absent
3. **remove legacy fallback**
   - after existing transfer sessions have naturally expired and production traces show no fallback use

### 8.2 Migration Magnitude

- **Redis transfer sessions:** no backfill; sessions are TTL-bounded and naturally age out
- **Mongo channel sessions:** write semantics change because an allowlisted durable subset of `sessionMetadata` must now persist for reload; evaluate whether a targeted backfill is needed only for active long-lived channel sessions
- **Mongo conversation sessions:** no schema migration required if we only read existing metadata fields
- **Provider adapters:** no external protocol migration required for Kore; Five9 metadata parity is in scope for this plan and should not be deferred to a follow-up

### 8.3 Rollback

Rollback is low risk because:

- Redis key format stays unchanged
- the new routing envelope is additive
- delivery can retain a temporary legacy fallback while the rollout is verified

---

## 9. Implementation Clarifications

These points are now fixed decisions for implementation:

1. Five9 receives real transfer metadata parity through the shared provider-neutral metadata envelope.
2. `postAgentAction=return` keeps a short terminal transfer-session state for audit/debug visibility after resume cleanup.
3. Durable channel-session is the reload source for the allowlisted `sessionMetadata` subset needed by transfer continuity, while fresh input-channel metadata still overlays it turn by turn.

Remaining implementation choice:

1. Should channel-adapter return delivery cache the hydrated durable channel-session route back into the transfer session after the first successful lookup, or re-read the durable record on every event?

Recommended default for the remaining choice:

- hydrate once, then update the transfer session so later events do not repeat the Mongo lookup

---

## 10. Extended Coverage Audit Checklist

This plan is not complete unless every category below has at least one explicit implementation step and one explicit test target.

| Coverage Area                               | Implementation Phase | Test Coverage                            |
| ------------------------------------------- | -------------------- | ---------------------------------------- |
| Omnichannel identity and contact resolution | Phases 1-3           | Phase 6 unit + integration + E2E 4, 10   |
| Runtime session management                  | Phases 1, 2, 5       | Phase 6 unit + integration + E2E 7, 8, 9 |
| Conversation session context hydration      | Phase 3              | Phase 6 integration + E2E 2, 10          |
| Interaction context propagation             | Phase 4              | Phase 6 unit + integration               |
| Message metadata propagation                | Phase 4              | Phase 6 unit + integration               |
| Other transfer metadata fields              | Phases 1, 4, 6       | Phase 6 unit + integration               |
| Attachments                                 | Phase 4              | Phase 6 integration + E2E 5              |
| Voice routing and disconnects               | Phases 2, 3, 5       | Phase 6 integration + E2E 3, 7, 8        |
| Cross-pod relay hardening                   | Phase 3              | Phase 6 unit + integration + E2E 6       |
| Architectural rollback and compatibility    | Phase 8              | rollout validation                       |

---

## 11. Recommended Execution Order

1. Phase 1 and Phase 2 together
2. Phase 3 once canonical routing writes are stable
3. Phase 5 before broad rollout so cleanup semantics stop drifting
4. Phase 4 after routing is stable, because the message builder depends on the new contract
5. Phase 6 after each phase, not only at the end

The critical path is not provider UX. It is canonical routing identity plus teardown correctness. Once those two are stable, the rest of the transfer boundary becomes much easier to reason about.

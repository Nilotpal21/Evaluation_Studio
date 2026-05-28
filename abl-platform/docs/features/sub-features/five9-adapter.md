# Feature: Five9 Agent Transfer Adapter

**Doc Type**: SUB-FEATURE
**Parent Feature**: [Agent Transfer](../agent-transfer.md)
**Status**: ALPHA
**Feature Area(s)**: `integrations`, `customer experience`
**Package(s)**: `packages/agent-transfer`, `apps/runtime`, `apps/studio`
**Owner(s)**: Platform Team
**Testing Guide**: `../../testing/sub-features/five9-adapter.md`
**Last Updated**: 2026-03-25

---

## 1. Introduction / Overview

### Problem Statement

The ABL platform's agent transfer subsystem only has a production adapter for Kore SmartAssist. Enterprise customers using Five9 — a major CCaaS provider — cannot transfer AI conversations to human agents on Five9's Virtual Contact Center. This blocks go-live for any customer whose contact center runs on Five9. Additionally, the Agent Transfer settings page lacks the ability to edit a selected connection's details inline; users must navigate away to modify credentials or configuration.

### Goal Statement

Deliver a Five9 agent desktop adapter that enables core escalation (create conversation, relay messages bidirectionally, end session) via Five9's Messaging REST API, and add an inline connection edit capability to the Agent Transfer settings dropdown that works for all providers.

### Summary

This sub-feature adds a `Five9Adapter` implementing the existing `AgentDesktopAdapter` interface, a `Five9Client` for Five9 REST API communication, Five9 event handling for inbound webhooks, Studio UI registration of Five9 as a provider, and a cross-provider `EditConnectionDialog` for inline editing of any agent desktop connection. No new database models are required — the adapter uses the existing Redis session store, webhook route, message bridge, and encryption infrastructure.

---

## 2. Scope

### Goals

- Implement `Five9Adapter` following the `AgentDesktopAdapter` interface for core escalation (v1)
- Support two Five9 auth modes: anonymous token and supervisor credentials
- Enable bidirectional message relay between end users and Five9 human agents
- Register Five9 as a configurable provider in Studio's agent desktop registry
- Add inline connection editing in the Agent Transfer default routing dropdown (all providers — bundled here because it was discovered as a UX gap while implementing Five9 provider UI; delivering together avoids two PRs touching the same Agent Transfer settings component)
- Reuse the existing webhook route (`POST /api/v1/agent-transfer/webhooks/:provider`) with Five9 payload normalization
- Check agent availability via Five9 `/logged_in_profiles` endpoint before creating conversations — block transfer with user-facing message when no agents are logged in
- Handle Five9 HTTP 435 "Service migrated" errors across all API methods with automatic datacenter re-discovery and retry
- Forward user messages to Five9 after successful transfer (intercept in runtime executor) instead of processing them through the bot
- Return transfer failure messages (e.g. "no agents available") to the end user's chat window
- Pass end-user contact details (name, email, phone) and conversation history to Five9 `createConversation` payload for agent context
- Resolve contact `displayName` from the Contact entity during SDK session init and propagate via `CallerContext.contactDisplayName`
- Send user typing indicators to Five9 via `PUT /conversations/{id}/messages/typing` (best-effort, non-blocking)

### Non-Goals (Out of Scope)

- Skill/queue-based routing beyond `campaignName`
- File/attachment support
- Comfort messages (typing indicators from Five9 agents to users are not yet surfaced in chat UI)
- Webhook signature verification (Five9 anonymous API does not support signing)
- Token caching / refresh (auth is per-conversation; ~2 extra round-trips accepted for v1 simplicity)
- Post-agent dialog (return to bot after agent disconnect)
- Health check endpoint for Five9 connectivity
- Reconnection / session recovery for Five9 sessions
- Circuit breaker wrapping for Five9 API calls

---

## 3. User Stories

1. As a **Studio admin**, I want to add Five9 as an agent desktop connection with my tenant name, campaign, and auth credentials so that I can route escalations to Five9 human agents.
2. As an **AI agent** (system), I want to transfer a conversation to a Five9 human agent via `transfer_to_agent` so that the end user receives human assistance when the AI cannot resolve their issue.
3. As an **end user**, I want my messages to be relayed to the Five9 human agent (and vice versa) during a transfer so that the conversation continues seamlessly.
4. As a **Studio admin**, I want to edit an existing agent desktop connection's details (for any provider) directly from the Agent Transfer settings dropdown without navigating away.
5. As a **Five9 human agent**, I want to receive the conversation context and user messages in my Five9 VCC desktop so that I can assist the user without asking them to repeat information.

---

## 4. Functional Requirements

1. **FR-1**: The system must authenticate with Five9 using anonymous token mode (`POST /appsvcs/rs/svc/auth/anon?cookieless=true` with `tenantName`) when `authMode` is `anonymous`.
2. **FR-2**: The system must authenticate with Five9 using supervisor credentials (`tenantName`, `username`, `password`) when `authMode` is `supervisor`.
3. **FR-3**: The system must perform Five9 metadata discovery (`GET /appsvcs/rs/svc/auth/metadata`) after authentication to resolve `orgId`, `farmId`, and `targetHost` for the correct data center.
4. **FR-4**: The system must create a Five9 conversation via `POST /appsvcs/rs/svc/conversations` with `campaignName`, `callbackUrl`, contact info, priority, and optional conversation history as attributes.
5. **FR-5**: The system must forward user messages to Five9 via `POST /appsvcs/rs/svc/conversations/{id}/messages` using the `UserMessage.content` field.
6. **FR-6**: The system must receive inbound Five9 agent messages/events via the existing webhook route (`POST /api/v1/agent-transfer/webhooks/five9`) and normalize them to `XOEvent` format before dispatching to the adapter.
7. **FR-7**: The system must map Five9 event types to ABL `AgentEventType` values: agent text → `agent:message`, agent joins → `agent:joined`, agent disconnects → `agent:disconnected`, conversation queued → `agent:queued`. The event type mapping must be provider-aware — the existing webhook route calls `KoreEventHandler.mapEventType()` for all providers, which must be dispatched to `Five9EventHandler.mapEventType()` when `provider === 'five9'`.
8. **FR-8**: The system must route Five9 agent messages to the end user's active channel via the existing message bridge (`bridge.routeAgentEvent()`).
9. **FR-9**: The system must end a Five9 conversation when the session is terminated (via API or agent disconnect) and clean up the Redis session store entry.
10. **FR-10**: The system must store Five9 session metadata (`conversationId`, `token`, `targetHost`, `farmId`, `orgId`) in the existing Redis session store with the `token` field encrypted via `TenantScopedSessionEncryptor`.
11. **FR-11**: The system must register Five9 as a provider in `agent-desktop-registry.ts` with fields: `tenantName`, `campaignName`, `host`, `authMode`, `username`, `password`, `callbackUrl`.
12. **FR-12**: The system must validate Five9 provider configuration at runtime, enforcing `tenantName` and `campaignName` as required, `authMode` as one of `anonymous` or `supervisor`, and conditionally requiring `username`/`password` when `authMode` is `supervisor`. Invalid configuration must produce a descriptive error at adapter initialization.
13. **FR-13**: The system must display an edit icon next to the default routing connection dropdown in Agent Transfer settings; clicking it must open a modal dialog pre-populated with the selected connection's fields (all providers, not Five9-specific).
14. **FR-14**: The `EditConnectionDialog` must leave password/secret fields empty (never pre-populated from API) and only include user-filled fields in the save payload via the existing connection PUT API (`updateConnection()`).
15. **FR-15**: The system must resolve tenant isolation for Five9 webhooks by embedding `tenantId` in the callback URL query parameter (`?tid=<tenantId>`) AND validating that a matching session exists for the `conversationId` in the payload under that tenant. If no session exists or the tenant does not match, return 404.
16. **FR-16**: The system must check agent availability via `GET /appsvcs/rs/svc/agents/{tokenId}/logged_in_profiles?profiles={campaignName}` before creating a Five9 conversation. If no agents are logged in (`agentLoggedIn === false` for all profiles), the transfer must be blocked and a user-facing message returned: "We are currently unable to service your request. Please contact us during normal business hours."
17. **FR-17**: The system must handle Five9 HTTP 435 "Service migrated" responses across all API methods (`checkAgentAvailability`, `createConversation`, `sendMessage`, `endConversation`) by: (1) retrieving updated metadata from the current host, (2) re-retrieving metadata with `farmId` header on the active datacenter host, (3) retrying the original API call on the new host with `farmId` header.
18. **FR-18**: After a successful transfer (`session.transferInitiated === true` and `session.isEscalated === true`), subsequent user messages must be intercepted in the runtime executor and forwarded to Five9 via `adapter.sendUserMessage()` instead of being processed by the bot.
19. **FR-19**: When an agent transfer fails (e.g. no agents available, API error), the session flags `isEscalated` and `transferInitiated` must be reset to `false` so subsequent user messages are processed normally by the bot.
20. **FR-20**: The `handleEscalate` method in `routing-executor.ts` must be async and return `{ success, message, error? }` so that transfer failure messages can be propagated to the user's chat window via the execution pipeline.
21. **FR-21**: The Five9 `createConversation` payload must include end-user contact details (firstName, lastName, email, phone, customerId) resolved from session `callerContext.contactContext` and `session.data.values`, with fallback defaults (`Anonymous User`).
22. **FR-22**: The Five9 `createConversation` payload must include conversation history (last 20 turns) as a `Custom.external_history` attribute, giving the human agent context about the prior bot conversation.
23. **FR-23**: The `contactDisplayName` must be resolved from the Contact entity during SDK session initialization (via `resolveAndLinkContact`) and stored on `CallerContext.contactDisplayName` for downstream use in agent transfer and trace events.
24. **FR-24**: The Five9Adapter must support sending typing indicators to Five9 via `PUT /conversations/{id}/messages/typing`. The `sendTypingIndicator()` method is best-effort — failures are logged at WARN level but do not throw, matching the optional `sendTypingIndicator?()` method on `AgentDesktopAdapter`.

---

## 5. Feature Classification & Integration Matrix

### Lifecycle / Platform Impact

| Area                       | Impact Level | Notes                                                                     |
| -------------------------- | ------------ | ------------------------------------------------------------------------- |
| Project lifecycle          | NONE         | No project lifecycle changes                                              |
| Agent lifecycle            | SECONDARY    | Agents can now escalate to Five9 in addition to SmartAssist               |
| Customer experience        | PRIMARY      | End users on Five9-backed deployments can reach human agents              |
| Integrations / channels    | PRIMARY      | New CCaaS provider integration                                            |
| Observability / tracing    | SECONDARY    | Trace events emitted through existing agent-transfer trace infrastructure |
| Governance / controls      | NONE         | No new governance features                                                |
| Enterprise / compliance    | SECONDARY    | Encrypted credentials, tenant isolation for Five9 sessions                |
| Admin / operator workflows | SECONDARY    | New provider in Studio + inline edit for all connections                  |

### Related Feature Integration Matrix

| Related Feature                                | Relationship Type | Why It Matters                                                          | Key Touchpoints                                                | Current State |
| ---------------------------------------------- | ----------------- | ----------------------------------------------------------------------- | -------------------------------------------------------------- | ------------- |
| [Agent Transfer](../agent-transfer.md)         | extends           | Five9 adapter extends the adapter registry with a new provider          | `AgentDesktopAdapter` interface, session store, message bridge | ALPHA         |
| [Encryption at Rest](../encryption-at-rest.md) | depends on        | Five9 bearer tokens must be encrypted at rest in Redis                  | `TenantScopedSessionEncryptor`, `SessionFieldEncryptor`        | BETA          |
| [Channels](../channels.md)                     | shares data with  | Message bridge routes Five9 agent events to user's active channel       | `bridge.routeAgentEvent()`, WebSocket, channel adapters        | ALPHA         |
| [Voice Capabilities](../voice-capabilities.md) | shares data with  | Five9 conversations may originate from voice channels via voice gateway | Voice gateway, transfer tools                                  | ALPHA         |

---

## 6. Design Considerations

- **Studio UI**: Five9 provider uses `PhoneCall` icon (lucide-react) — `Headset` was specified but unavailable in Studio's lucide-react v0.303.0. `PhoneCall` distinguishes from Genesys (`Phone`) and SmartAssist (`Headphones`)
- **Provider authType**: Five9 uses `authType: 'custom'` from the existing `'api_key' | 'oauth2' | 'custom'` union, since Five9's auth pattern (anonymous token / supervisor credentials) doesn't map to API key or OAuth2.
- **Auth mode field**: Current `AgentDesktopProviderDef.fields` schema only supports `text | password | url` types — no `select` type. The `authMode` field uses `text` with validation hint ("anonymous or supervisor"). Adapter validates at `initialize()` and returns a clear error for invalid values. A `select` field type can be added in a future UI enhancement.
- **EditConnectionDialog**: Opens as a modal from the pencil icon next to the dropdown. Reuses `getProviderDef(providerId).fields` for rendering — no field duplication. Password fields show masked placeholder with "Change" toggle.

---

## 7. Technical Considerations

- **Per-conversation authentication**: Each transfer runs the full auth → metadata → conversation flow (~2 extra HTTP round-trips). Accepted for v1 simplicity; token caching with TTL is a future optimization.
- **XOEvent compatibility**: The `handleInboundEvent` interface parameter is `XOEvent` (from Kore). `XOEvent` is generic enough (`type: string`, `conversationId: string`, `orgId?: string`, `data?: Record<string, unknown>`) to carry Five9 payloads. The webhook route normalizes Five9 payloads to `XOEvent` shape before calling the adapter.
- **Webhook route control-flow change**: The existing webhook route at `agent-transfer-webhooks.ts` (line 119) casts `req.body` directly as `XOEvent` and (line 129-138) rejects events without `orgId` with a 400 error. Five9 payloads lack `orgId`. The route must be restructured: for `provider === 'five9'`, extract `tid` from the query string and inject it as `orgId` into the parsed event BEFORE the existing validation check. Additionally, line 141 calls `KoreEventHandler.mapEventType()` for all providers — this must be made provider-aware, dispatching to `Five9EventHandler.mapEventType()` when `provider === 'five9'`. This is a control-flow change, not just an additive block. Backward compatibility with existing Kore webhooks must be verified by E2E tests.
- **Fetch timeouts**: All Five9 API calls use `AbortController` with a 30-second timeout (configurable via `timeoutMs` constructor parameter) to prevent hung connections from blocking worker threads.
- **No new npm dependencies**: Five9 API integration uses native `fetch` — no SDK required.
- **Backward compatibility**: Core adapter code is additive. The webhook route change is the only modification to existing production code and is guarded by `provider === 'five9'` checks. Existing KoreAdapter behavior must be verified unchanged via existing tests.

---

## 8. How to Consume

### Studio UI

- **Connections page**: Five9 appears as a new provider in the agent desktop connections list. Admin fills in `tenantName`, `campaignName`, `host` (default: `app.five9.com`), `authMode`, and optionally `username`/`password`/`callbackUrl`.
- **Agent Transfer settings**: Default routing connection dropdown lists Five9 connections alongside other providers. Pencil icon next to the dropdown opens `EditConnectionDialog` for inline editing (works for all providers).

### API (Runtime)

| Method | Path                                              | Purpose                                                            |
| ------ | ------------------------------------------------- | ------------------------------------------------------------------ |
| POST   | `/api/v1/agent-transfer/webhooks/five9?tid={tid}` | Receive inbound events from Five9 (agent messages, session events) |

No new runtime endpoints. The existing webhook route handles Five9 via the `:provider` parameter.

### API (Studio)

No new Studio API routes. Five9 connections use the existing connection CRUD API:

- `POST /api/projects/:id/connections` — create Five9 connection
- `PUT /api/projects/:id/connections/:connId` — update Five9 connection (used by EditConnectionDialog via `updateConnection()`)
- `GET /api/projects/:id/connections` — list connections (includes Five9)

### Admin Portal

N/A — Five9 configuration is project-level, not platform-wide.

### Channel / SDK / Voice / A2A / MCP Integration

Five9 agent transfer is channel-agnostic — it works across all channels (web chat, voice, messaging) via the message bridge. The bridge routes agent events to whatever channel the end user is on. No channel-specific logic in the Five9 adapter.

---

## 9. Data Model

### Collections / Tables

No new MongoDB collections. Five9 uses the existing Redis session hash:

```text
Redis Key: agent_transfer:{tenantId}:{contactId}:{channel}
Fields:
  - tenantId: string (required)
  - contactId: string (required)
  - channel: string (required)
  - provider: 'five9'
  - providerSessionId: string (Five9 conversationId)
  - agentId: string
  - providerData: { token, targetHost, farmId, orgId }
    - token: string (Five9 bearer token — entire providerData blob ENCRYPTED via SessionFieldEncryptor)
    - targetHost: string (Five9 data center host)
    - farmId: string (Five9 farm ID)
    - orgId: string (Five9 org ID)

Provider Reverse Index:
  at_by_provider:five9:{tenantId}:{conversationId} → session key
```

### Key Relationships

- Five9 sessions use the same `TransferSessionStoreHandle` as KoreAdapter
- Provider reverse index enables webhook → session lookup by `conversationId`. Reverse index keys inherit the same TTL as the parent session hash, set atomically via the existing Lua create script
- Session TTLs follow the existing channel-specific defaults (chat: 30min, voice: session-duration)

---

## 10. Key Implementation Files

### Domain / Core Logic

| File                                                                | Purpose                                                                   |
| ------------------------------------------------------------------- | ------------------------------------------------------------------------- |
| `packages/agent-transfer/src/adapters/five9/index.ts`               | Five9Adapter — `AgentDesktopAdapter` impl                                 |
| `packages/agent-transfer/src/adapters/five9/five9-client.ts`        | Five9 REST API client (auth, conversations, typing)                       |
| `packages/agent-transfer/src/adapters/interface.ts`                 | `AgentDesktopAdapter` interface — added optional `sendTypingIndicator?()` |
| `packages/agent-transfer/src/adapters/five9/types.ts`               | Five9-specific types and credential shape                                 |
| `packages/agent-transfer/src/adapters/five9/five9-event-handler.ts` | Five9 event type mapping to ABL AgentEventType                            |
| `packages/agent-transfer/src/config/schema.ts`                      | Five9ProviderConfigSchema (Zod validation)                                |
| `packages/agent-transfer/src/types.ts`                              | `TransferContact`, `TransferPayload` types                                |
| `packages/agent-transfer/src/tools/transfer-to-agent.ts`            | Transfer tool — wires contact + history to payload                        |

### Routes / Handlers

| File                                                        | Purpose                                                                                 |
| ----------------------------------------------------------- | --------------------------------------------------------------------------------------- |
| `apps/runtime/src/routes/agent-transfer-webhooks.ts`        | Modified — Five9 payload normalization pre-processing                                   |
| `apps/runtime/src/services/agent-transfer/index.ts`         | Modified — Five9Adapter registration + bridge wiring                                    |
| `apps/runtime/src/services/execution/routing-executor.ts`   | Modified — async `handleEscalate`, agent-transfer wiring, session flag reset on failure |
| `apps/runtime/src/services/execution/reasoning-executor.ts` | Modified — await `handleEscalate`, propagate transfer failure messages to user          |
| `apps/runtime/src/services/runtime-executor.ts`             | Modified — transfer message intercept (forward user messages to Five9 post-transfer)    |
| `apps/runtime/src/services/execution/llm-wiring.ts`         | Modified — wires contact details + conversation history into TransferToolExecutor       |
| `apps/runtime/src/websocket/sdk-handler-contact-linking.ts` | Modified — returns `ContactLinkingResult` with `displayName`                            |
| `apps/runtime/src/websocket/sdk-handler.ts`                 | Modified — stores `contactDisplayName` on `CallerContext`                               |

### Shared Types

| File                                        | Purpose                                                  |
| ------------------------------------------- | -------------------------------------------------------- |
| `packages/shared-auth/src/types/index.ts`   | Modified — added `contactDisplayName` to `CallerContext` |
| `packages/shared-kernel/src/types/index.ts` | Modified — added `contactDisplayName` to `CallerContext` |

### UI Components

| File                                                                | Purpose                                              |
| ------------------------------------------------------------------- | ---------------------------------------------------- |
| `apps/studio/src/components/connections/agent-desktop-registry.ts`  | Modified — add Five9 provider definition             |
| `apps/studio/src/components/connections/EditConnectionDialog.tsx`   | New — inline connection edit modal (all providers)   |
| `apps/studio/src/components/settings/AgentTransferSettingsPage.tsx` | Modified — add edit icon + wire EditConnectionDialog |

### Jobs / Workers / Background Processes

N/A — Five9 adapter uses no background jobs. Session timeout and event queue are existing infrastructure.

### Tests

| File                                                                                              | Type        | Coverage Focus                                         |
| ------------------------------------------------------------------------------------------------- | ----------- | ------------------------------------------------------ |
| `packages/agent-transfer/src/adapters/five9/__tests__/five9-client.test.ts`                       | unit        | API client auth, conversation CRUD, error handling     |
| `packages/agent-transfer/src/adapters/five9/__tests__/five9-event-handler.test.ts`                | unit        | Event type mapping (8 types + unknown)                 |
| `packages/agent-transfer/src/adapters/five9/__tests__/five9-adapter.test.ts`                      | unit        | Adapter lifecycle, session store interactions          |
| `packages/agent-transfer/src/adapters/five9/__tests__/five9-client.integration.test.ts`           | integration | Real HTTP server, auth flows, SSRF guard, error codes  |
| `packages/agent-transfer/src/adapters/five9/__tests__/five9-adapter-cleanup.integration.test.ts`  | integration | Session cleanup on Five9 API failure                   |
| `packages/agent-transfer/src/adapters/five9/__tests__/five9-adapter-registry.integration.test.ts` | integration | Adapter registration, multi-provider coexistence       |
| `apps/runtime/src/__tests__/five9-webhook.e2e.test.ts`                                            | e2e         | Full webhook flow with real Express server             |
| `apps/runtime/src/__tests__/five9-transfer.e2e.test.ts`                                           | e2e         | End-to-end transfer lifecycle (anonymous + supervisor) |
| `apps/runtime/src/__tests__/escalation-transfer-wiring.test.ts`                                   | unit        | handleEscalate → agent-transfer wiring, HITL fallback  |

---

## 11. Configuration

### Environment Variables

No new environment variables required. Five9 credentials are per-connection, stored via the Studio connections system (encrypted at rest).

### Runtime Configuration

Five9 adapter is registered at boot time in `doInitializeAgentTransfer()`. It activates when a project's Agent Transfer settings reference a Five9 connection. No feature flag needed — the adapter is inert until configured.

### DSL / Agent IR / Schema

No DSL changes. The existing `transfer_to_agent` tool works with Five9 via the adapter registry — the tool executor resolves the adapter by provider name from the project's transfer settings.

---

## 12. Non-Functional Concerns

### Isolation & Multitenancy

| Concern           | Requirement / Expectation                                                                                                                                                                                                                                                         |
| ----------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Project isolation | Five9 connections are project-scoped. Transfer settings reference connections by ID within the project. Cross-project access returns 404.                                                                                                                                         |
| Tenant isolation  | Five9 webhook payloads lack `orgId`. Tenant is resolved by embedding `tenantId` in the callback URL (`?tid=<tenantId>`). The webhook route validates tenant matches the session's `tenantId` — mismatch returns 404 (not 403, per platform invariant to avoid leaking existence). |
| User isolation    | Transfer sessions are scoped to `contactId` + `channel`. A user can only interact with their own active transfer session. Session lookup by provider requires both `tenantId` and `conversationId`.                                                                               |

### Security & Compliance

| Concern                        | Requirement / Expectation                                                                                                                                                                                                   |
| ------------------------------ | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Credential storage             | Five9 connection credentials (`password`, `tenantName`) stored encrypted in MongoDB via the connection model's `encryptionPlugin`. Decrypted only at runtime when the adapter is initialized.                               |
| Bearer token at rest           | Five9 auth tokens stored in Redis session hash are encrypted via `TenantScopedSessionEncryptor`. The `token` field is registered as a sensitive field for field-level encryption.                                           |
| Webhook authentication         | v1 does NOT verify Five9 webhook signatures (Five9 anonymous API lacks signing). Security relies on: (a) callback URL uniqueness per conversation, (b) `tenantId` in URL validated against session, (c) session must exist. |
| SSRF protection                | All outbound HTTP calls from `Five9Client` go through the existing SSRF guard that validates URLs before adapter HTTP calls (FR-17 of parent spec).                                                                         |
| Log redaction                  | `createLogger('five9-adapter')` is used for all logging. Bearer tokens, passwords, and PII are NEVER included in log context. Error messages use `err instanceof Error ? err.message : String(err)` pattern.                |
| Supervisor credential exposure | Supervisor `username`/`password` are only used in the auth request body (HTTPS). They are never stored in Redis sessions — only the resulting `token` (which is encrypted) is stored.                                       |
| Callback URL predictability    | Callback URLs contain the `connectionId` and `tenantId` — both are UUIDs, making the URL effectively unguessable. An attacker would need to guess two UUIDs to forge a webhook call.                                        |
| Input validation               | All Five9 API responses are validated before use. `conversationId` from Five9 is treated as opaque — never used in MongoDB queries or filesystem operations. Zod schema validates config at initialization.                 |

### Error Handling

| Scenario                              | Behavior                                                                                                                                                                                                                                 |
| ------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Five9 auth failure (401/403)          | Return `TransferResult` with `status: 'failed'`, `error: { code: 'FIVE9_AUTH_FAILED', message: '<detail>' }`. Log at ERROR level with `tenantId` context.                                                                                |
| Five9 auth network timeout            | Return `TransferResult` with `status: 'failed'`, `error: { code: 'FIVE9_AUTH_TIMEOUT', message }`. Log at ERROR level.                                                                                                                   |
| Five9 metadata discovery failure      | Return `TransferResult` with `status: 'failed'`, `error: { code: 'FIVE9_DISCOVERY_FAILED', message }`. Log at ERROR with the `metaHost` attempted.                                                                                       |
| Five9 conversation creation failure   | Return `TransferResult` with `status: 'failed'`, `error: { code: 'FIVE9_CONVERSATION_FAILED', message }`. Include Five9's HTTP status code in log context.                                                                               |
| Five9 send message failure            | Log at ERROR level, throw error (caller in execution pipeline handles retries/fallback per existing agent-transfer patterns).                                                                                                            |
| Five9 end conversation failure        | Log at WARN level (best-effort cleanup). Session store entry is still cleaned up locally even if Five9 API call fails.                                                                                                                   |
| Webhook: unknown conversationId       | Log at WARN level, return 404. No session exists — event is dropped.                                                                                                                                                                     |
| Webhook: tenant mismatch              | Log at WARN level, return 404 (not 403). Per platform invariant: cross-tenant access returns 404 to avoid leaking existence.                                                                                                             |
| Webhook: malformed payload            | Log at WARN level, return 400 with `{ code: 'INVALID_EVENT', message }`.                                                                                                                                                                 |
| Webhook: adapter processing error     | Log at ERROR level, return 500. Five9 will retry delivery per its retry policy.                                                                                                                                                          |
| Invalid `authMode` value              | `initialize()` throws with descriptive error. Adapter fails to start — connection is unusable until corrected.                                                                                                                           |
| Supervisor auth with missing username | Zod schema validation rejects at config load time. `refine()` rule: "username and password required for supervisor auth mode".                                                                                                           |
| Session store lookup failure (Redis)  | `sendUserMessage` and `endSession` throw. Caller handles. Log at ERROR with session key.                                                                                                                                                 |
| Five9 returns unexpected HTTP status  | All non-2xx responses are treated as errors. Response body is included in the error message (truncated to 200 chars) for debugging.                                                                                                      |
| Five9 435 "Service migrated"          | Handled automatically: re-discover metadata with `farmId` header on active datacenter, retry original API call on new host. Applied to availability check, conversation creation, sendMessage, and endConversation.                      |
| No agents logged in (availability)    | Return `TransferResult` with `status: 'failed'`, `error: { code: 'FIVE9_NO_AGENTS_AVAILABLE', message }`. Session flags `isEscalated`/`transferInitiated` reset to `false`. User sees "We are currently unable to service your request." |
| Availability check network failure    | Non-fatal — proceed with conversation creation. Logged at WARN level. Retry flow: auth host first, then metadata host.                                                                                                                   |
| Transfer failure after escalation     | `handleEscalate` returns `{ success: false, message, error }`. `routing-executor` resets `session.isEscalated` and `session.transferInitiated` to `false`. Bot resumes normal operation on next message.                                 |

### Performance & Scalability

| Concern               | Expectation                                                                                                                               |
| --------------------- | ----------------------------------------------------------------------------------------------------------------------------------------- |
| Transfer initiation   | ~2 extra HTTP round-trips for Five9 auth + metadata discovery per conversation. Expected total < 3s including conversation creation.      |
| Concurrent sessions   | Five9 adapter shares the existing session store — same 1,000 concurrent sessions per tenant limit applies.                                |
| Webhook throughput    | Existing webhook route handles Five9 events with minimal overhead (payload normalization is O(1)). Same rate limiting applies.            |
| No connection pooling | `Five9Client` uses stateless `fetch`. No persistent connections to Five9. Acceptable for v1; connection pooling is a future optimization. |

### Reliability & Failure Modes

| Concern              | Expectation                                                                                                                                                                                                         |
| -------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Idempotency          | Webhook processing is idempotent — reprocessing the same event extends TTL and re-fires handlers (no side effects beyond message delivery, which is also idempotent).                                               |
| Session cleanup      | If Five9 API call to end conversation fails, local session store is still cleaned up. Orphaned Five9 conversations will time out on Five9's side per their TTL policy.                                              |
| Token expiry         | Per-conversation auth means tokens are short-lived (one conversation lifecycle). If a token expires mid-conversation, `sendUserMessage` detects 401/403 and re-authenticates once before retrying the message send. |
| Five9 downtime       | Transfer initiation fails with `FIVE9_AUTH_FAILED`. The execution pipeline's existing fallback executor can route to an alternative adapter if configured.                                                          |
| Redis unavailability | Session store operations fail — same failure mode as all agent-transfer adapters. Existing circuit breaker on Redis applies.                                                                                        |

### Observability

| Concern      | Implementation                                                                                                                                                                                                             |
| ------------ | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Logging      | `createLogger('five9-adapter')` and `createLogger('five9-client')` — structured JSON logs with `tenantId`, `conversationId`, `provider` fields                                                                             |
| Trace events | Five9 adapter emits trace events via the `TraceEventEmitter` interface (`packages/agent-transfer/src/observability/trace-events.ts`), wired through `createTraceStoreAdapter()` — same trace infrastructure as KoreAdapter |
| Metrics      | Reuses existing agent-transfer metrics (transfer count, duration, status distribution). Five9 is a new `provider` label value.                                                                                             |
| Debugging    | `debug_diagnose` MCP tool shows Five9 adapter registration status. Session inspection shows Five9-specific fields.                                                                                                         |

### Data Lifecycle

| Concern            | Expectation                                                                                                                                                                      |
| ------------------ | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Session TTL        | Channel-specific TTLs from parent feature: chat 30min, voice session-duration, messaging 30min, email 24hr.                                                                      |
| Token lifetime     | Five9 tokens live in the session hash — they expire when the session expires or is ended. No separate token TTL management.                                                      |
| Connection cleanup | Deleting a Five9 connection via Studio removes the encrypted credentials. Active sessions using that connection continue until TTL expiry but no new transfers can be initiated. |

---

## 13. Delivery Plan / Work Breakdown

1. **Five9 API Client**
   1.1 Implement `Five9Client` with `authenticate()` (anonymous + supervisor modes)
   1.2 Implement metadata discovery (`targetHost`, `orgId`, `farmId` resolution)
   1.3 Implement `createConversation()`, `sendMessage()`, `endConversation()`
   1.4 Add Five9-specific types (`Five9Credentials`, `Five9AuthResult`, `Five9WebhookPayload`)

2. **Five9Adapter**
   2.1 Implement `Five9Adapter` class with `AgentDesktopAdapter` interface
   2.2 Implement `initialize()` with Zod config validation
   2.3 Implement `execute()` — full auth → conversation → session store flow
   2.4 Implement `sendUserMessage()` — session lookup → Five9 message POST
   2.5 Implement `endSession()` — Five9 conversation end → session cleanup
   2.6 Implement `handleInboundEvent()` — XOEvent processing → handler dispatch
   2.7 Implement `Five9EventHandler` with event type mapping
   2.8 Implement `close()` to clear handler arrays for shutdown cleanup, matching KoreAdapter.close() pattern

3. **Webhook Route Enhancement**
   3.1 Add Five9 payload normalization in `agent-transfer-webhooks.ts`
   3.2 Add `tid` query parameter extraction for tenant resolution
   3.3 Ensure backward compatibility — existing Kore webhooks unaffected

4. **Runtime Wiring**
   4.1 Register `Five9Adapter` in `doInitializeAgentTransfer()`
   4.2 Wire `onAgentMessage` handler through message bridge
   4.3 Wire `onSessionEvent` handler through message bridge
   4.4 Add `Five9ProviderConfigSchema` to `config/schema.ts`

5. **Studio UI — Five9 Provider**
   5.1 Add `'five9'` to `AgentDesktopProvider` union type
   5.2 Add Five9 provider definition to `AGENT_DESKTOP_PROVIDERS` array
   5.3 Verify `getConnectionCategory('five9')` returns `'agent_desktop'`

6. **Studio UI — EditConnectionDialog**
   6.1 Create `EditConnectionDialog.tsx` component
   6.2 Implement field rendering from `getProviderDef()` with password masking
   6.3 Implement save via PUT API (`updateConnection()`) with user-filled-fields-only logic
   6.4 Add pencil icon to Agent Transfer settings dropdown
   6.5 Wire dialog open/close/save lifecycle

7. **Testing**
   7.1 Unit tests for `Five9Client` (auth modes, API calls, error handling)
   7.2 Unit tests for `Five9Adapter` (lifecycle, session management)
   7.3 Unit tests for `Five9EventHandler` (event mapping)
   7.4 E2E tests for webhook flow (real Express server, full middleware chain)
   7.5 E2E tests for transfer lifecycle (initiation → messaging → end)
   7.6 Integration tests for `EditConnectionDialog` (rendering, save, masking)

8. **Post-Initial Implementation Enhancements**
   8.1 Add agent availability check via `/logged_in_profiles` endpoint (Step 3 in adapter flow)
   8.2 Add 435 "Service migrated" handling with automatic datacenter re-discovery + retry across all Five9 API methods
   8.3 Convert `handleEscalate` to async, return `{ success, message, error? }` for transfer failure propagation
   8.4 Add transfer message intercept in `runtime-executor.ts` to forward user messages to Five9 post-transfer
   8.5 Reset `session.isEscalated` and `session.transferInitiated` on transfer failure to resume normal bot operation
   8.6 Add `Five9AgentProfileResponse` type for `/logged_in_profiles` response
   8.7 Add `Five9MetadataResponse` type for `/metadata` response
   8.8 Add `handleServiceMigrated()` method for 3-step Five9 migration flow
   8.9 Add dual-host retry for availability check (auth host first, fallback to metadata host)

---

## 14. Success Metrics

| Metric                         | Baseline | Target  | How Measured                                                    |
| ------------------------------ | -------- | ------- | --------------------------------------------------------------- |
| Five9 transfer success rate    | N/A      | > 95%   | `TransferResult.success` ratio from trace events                |
| Transfer initiation latency    | N/A      | < 3s    | Time from `execute()` call to `TransferResult` return           |
| Webhook processing latency     | N/A      | < 500ms | Time from webhook receipt to `200 OK` response                  |
| Inline edit adoption           | 0        | > 50%   | Ratio of connection edits via dialog vs navigation to edit page |
| Zero cross-tenant data leakage | 0        | 0       | Security audit of webhook + session isolation                   |

---

## 15. Open Questions

1. What is the exact Five9 webhook callback payload structure? The design spec's `Five9WebhookPayload` type is a best-guess based on the Messaging API script. Validation against live Five9 API documentation or a test tenant is needed during implementation.
2. Should the `authMode` field in Studio be upgraded to a `select` dropdown (requires extending `AgentDesktopProviderDef.fields` type union) or is text input with validation sufficient for v1?
3. Does Five9 retry failed webhook deliveries? If so, what is the retry policy and should we implement deduplication beyond session TTL extension?
4. What is the Five9 token expiry duration for anonymous vs supervisor auth? This affects whether mid-conversation token expiry is a realistic failure mode.

---

## 16. Gaps, Known Issues & Limitations

| ID      | Description                                                                                   | Severity | Status    |
| ------- | --------------------------------------------------------------------------------------------- | -------- | --------- |
| GAP-001 | No webhook signature verification — callback URL uniqueness is the only security layer        | Medium   | Open      |
| GAP-002 | Per-conversation auth adds ~2 round-trips latency vs pre-authenticated adapters like Kore     | Low      | Open      |
| GAP-003 | `authMode` field is text input instead of select dropdown due to field type schema limitation | Low      | Open      |
| GAP-004 | Five9 webhook payload structure is inferred, not validated against live Five9 API             | Medium   | Open      |
| GAP-005 | No circuit breaker on Five9 API calls in v1 — transient Five9 failures propagate directly     | Low      | Open      |
| GAP-006 | Token expiry mid-conversation — `sendUserMessage` detects 401/403 and re-authenticates once   | Medium   | Mitigated |
| GAP-007 | Agent availability check added — uses `/logged_in_profiles` API with 435 migration handling   | N/A      | Resolved  |
| GAP-008 | 435 "Service migrated" handling added across all Five9 API methods                            | N/A      | Resolved  |
| GAP-009 | Transfer failure messages now reach end user via async `handleEscalate` return value          | N/A      | Resolved  |
| GAP-010 | Post-transfer user messages forwarded to Five9 via runtime executor intercept                 | N/A      | Resolved  |
| GAP-011 | Session flags (`isEscalated`, `transferInitiated`) reset on transfer failure                  | N/A      | Resolved  |

---

## 17. Testing & Validation

### Required Test Coverage

| #   | Scenario                                            | Coverage Type | Status   | Test File / Note                                   |
| --- | --------------------------------------------------- | ------------- | -------- | -------------------------------------------------- |
| 1   | Five9 anonymous auth + metadata discovery           | unit          | PASSING  | `five9-client.test.ts`                             |
| 2   | Five9 supervisor auth + metadata discovery          | unit          | PASSING  | `five9-client.test.ts`                             |
| 3   | Conversation creation with campaign routing         | unit          | PASSING  | `five9-client.test.ts`                             |
| 4   | Auth failure returns structured error               | unit          | PASSING  | `five9-client.test.ts`                             |
| 5   | Network timeout returns structured error            | unit          | PASSING  | `five9-client.test.ts`                             |
| 6   | Adapter execute() creates session in store          | unit          | PASSING  | `five9-adapter.test.ts`                            |
| 7   | Adapter sendUserMessage() with valid session        | unit          | PASSING  | `five9-adapter.test.ts`                            |
| 8   | Adapter endSession() cleans up session + Five9 call | unit          | PASSING  | `five9-adapter.test.ts`                            |
| 9   | Event handler maps Five9 types to AgentEventType    | unit          | PASSING  | `five9-event-handler.test.ts`                      |
| 10  | Webhook: valid Five9 event → agent message routed   | e2e           | PASSING  | `five9-webhook.e2e.test.ts` (AGENT_TRANSFER_E2E)   |
| 11  | Webhook: unknown conversationId → 404               | e2e           | PASSING  | `five9-webhook.e2e.test.ts`                        |
| 12  | Webhook: tenant mismatch → 404 (not 403)            | e2e           | PASSING  | `five9-webhook.e2e.test.ts`                        |
| 13  | Webhook: malformed payload → 400                    | e2e           | PASSING  | `five9-webhook.e2e.test.ts`                        |
| 14  | Full transfer lifecycle: initiate → message → end   | e2e           | PASSING  | `five9-transfer.e2e.test.ts`                       |
| 15  | Zod validation rejects invalid authMode             | unit          | PASSING  | `five9-client.test.ts` (schema tests)              |
| 16  | Zod validation rejects supervisor without password  | unit          | PASSING  | `five9-client.test.ts` (schema tests)              |
| 17  | Session token is encrypted in Redis                 | integration   | DEFERRED | Encryption handled by TenantScopedSessionEncryptor |
| 18  | EditConnectionDialog renders fields from provider   | integration   | DEFERRED | No React test setup for settings pages             |
| 19  | EditConnectionDialog masks password fields          | integration   | DEFERRED | No React test setup for settings pages             |
| 20  | EditConnectionDialog saves only changed fields      | integration   | DEFERRED | No React test setup for settings pages             |
| 21  | Agent availability check blocks when no agents      | manual        | PASSING  | Tested live — returns FIVE9_NO_AGENTS_AVAILABLE    |
| 22  | 435 migration retry succeeds on new datacenter      | manual        | PASSING  | Tested live — availability + conversation creation |
| 23  | Transfer failure message reaches end user chat      | manual        | PASSING  | Error message propagated via async handleEscalate  |
| 24  | Post-transfer messages forwarded to Five9           | manual        | PASSING  | Verified via runtime-executor intercept            |
| 25  | Bot resumes after failed transfer (flags reset)     | manual        | PASSING  | session.isEscalated reset to false on failure      |
| 26  | handleEscalate wiring with agent-transfer           | unit          | PASSING  | `escalation-transfer-wiring.test.ts`               |

### Testing Notes

E2E tests must start real Express servers on random ports with full middleware chain (auth, rate limiting, tenant isolation). Five9 API calls are the only external dependency that may be mocked via dependency injection in the `Five9Client` constructor. No `vi.mock()` or `jest.mock()` of codebase components. No direct Redis/MongoDB access in test assertions — interact only via HTTP API.

> Full testing details: [../../testing/sub-features/five9-adapter.md](../../testing/sub-features/five9-adapter.md)

---

## 18. References

- Design spec: [docs/superpowers/specs/2026-03-24-five9-adapter-design.md](../../superpowers/specs/2026-03-24-five9-adapter-design.md)
- Parent feature: [docs/features/agent-transfer.md](../agent-transfer.md)
- Adapter interface: `packages/agent-transfer/src/adapters/interface.ts`
- Reference adapter: `packages/agent-transfer/src/adapters/kore/index.ts`
- Five9 Messaging API: `POST /appsvcs/rs/svc/conversations` (REST, no SDK)

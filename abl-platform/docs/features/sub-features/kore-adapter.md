# Feature: Kore SmartAssist Agent Transfer Adapter

**Doc Type**: SUB-FEATURE
**Parent Feature**: [Agent Transfer](../agent-transfer.md)
**Status**: BETA
**Feature Area(s)**: `integrations`, `customer experience`, `enterprise`
**Package(s)**: `packages/agent-transfer`, `apps/runtime`, `apps/studio`
**Owner(s)**: Platform Team
**Testing Guide**: `../../testing/sub-features/kore-adapter.md`
**Last Updated**: 2026-03-30

---

## 1. Introduction / Overview

### Problem Statement

Enterprise customers using Kore.ai SmartAssist as their contact center platform need a way to seamlessly escalate AI agent conversations to live human agents on the SmartAssist desktop. Without a production-grade adapter, ABL AI agents cannot hand off conversations, leaving end users stuck when the AI cannot resolve their issue. The adapter must handle the full transfer lifecycle including pre-checks (business hours, agent availability, queue validation), synthetic user creation, bidirectional message forwarding, session management, and webhook-based event delivery — all with tenant isolation, credential encryption, and fault tolerance.

### Goal Statement

Deliver a production-ready Kore SmartAssist adapter that implements the `AgentDesktopAdapter` interface for the full agent transfer lifecycle: pre-flight validation, transfer initiation via the SmartAssist Conversations API, bidirectional message relay via webhook events, session state management in Redis, and graceful cleanup. The adapter must support per-connection credentials from the Studio UI with lazy orgId resolution, and expose ABL tools for agent-controlled business hours and queue selection.

### Summary

The Kore SmartAssist adapter (`KoreAdapter`) is the primary agent desktop integration in the ABL platform. It connects to the Kore SmartAssist/AgentAssist APIs for live agent escalation, using an HTTP client (`SmartAssistClient`) with connection pooling, circuit breaker, and retry logic. The adapter supports 8 SmartAssist API integrations, 22 XO event type mappings, provider alias indexing for webhook routing, lazy orgId resolution, synthetic user creation, and two ABL tools (`check-hours`, `set-queue`). Session state is managed in Redis with atomic Lua scripts, field-level encryption, and channel-specific TTLs. The Studio UI provides a connection form for configuring SmartAssist credentials per project.

---

## 2. Scope

### Goals

- Implement `KoreAdapter` following the `AgentDesktopAdapter` interface for full transfer lifecycle
- Support 3 pre-check APIs: business hours, agent availability, queue validation
- Create synthetic users in KoreServer before transfer initiation for valid userId mapping
- Lazily resolve orgId from KoreServer when not provided in connection config, and persist to DB
- Initiate transfers via SmartAssist Conversations API with full XO payload support (metaInfo, skills, queue, language, conversation history, contact details)
- Forward user messages to SmartAssist agents via event handle API
- Receive agent messages/events via webhook route with HMAC signature verification
- Map 22 XO event type entries to ABL `AgentEventType` values
- Manage transfer sessions in Redis with atomic Lua scripts and channel-specific TTLs
- Expose `check-hours` and `set-queue` ABL tools for agent-controlled transfer routing
- Register SmartAssist as a configurable provider in Studio's agent desktop connection form
- Support per-connection credentials (from Studio UI) merged over global env config
- Create provider alias index keyed by Kore orgId for webhook session lookup
- Embed ABL webhook URL in transfer payload (metaInfo.abl) for direct event dispatch
- Support post-agent actions: `end` (default) and `return` (resume AI agent)

### Non-Goals (Out of Scope)

- Translation support (`supportsTranslation: false` in adapter capabilities)
- OAuth-based authentication (uses internal API key auth)
- Polling-based event transport (webhook-only)
- Human-to-human transfers (AI-to-human only)
- File upload from ABL to SmartAssist (capability declared but not implemented end-to-end)
- Comfort messages (agent typing indicators surfaced in chat UI)
- Token caching / credential refresh (API key is long-lived)
- Multi-region failover (single SmartAssist instance per connection)
- Voice gateway integration (handled by separate KoreVG adapter)
- Campaign routing (Five9-specific concept)

---

## 3. User Stories

1. As a **Studio admin**, I want to add SmartAssist as an agent desktop connection with my instance URL, API key, and App ID so that I can route escalations to SmartAssist human agents.
2. As an **AI agent** (system), I want to transfer a conversation to a SmartAssist human agent via `transfer_to_agent` so that the end user receives human assistance when the AI cannot resolve their issue.
3. As an **end user**, I want my messages to be relayed to the SmartAssist human agent (and vice versa) during a transfer so that the conversation continues seamlessly.
4. As a **SmartAssist human agent**, I want to receive the conversation context, history, and user contact details in my SmartAssist desktop so that I can assist the user without asking them to repeat information.
5. As an **AI agent** (system), I want to check business hours and agent availability before attempting a transfer so that I can provide an appropriate message when transfer is not possible.
6. As a **Studio admin**, I want the Organization ID to be auto-resolved from the App ID so that I don't need to manually find and enter it.

---

## 4. Functional Requirements

1. **FR-1**: The system must authenticate with SmartAssist using an internal API key passed in the `apiKey` header for all SmartAssist API calls.
2. **FR-2**: The system must authenticate with KoreServer using `koreApiKey` (falling back to `apiKey`) for synthetic user creation and orgId resolution.
3. **FR-3**: The system must check business hours via `POST /agentassist/api/v1/internal/flows/nodes/businessHours` with `hoursId` and `botId` when a `hoursId` is configured.
4. **FR-4**: The system must check agent availability via `POST /agentassist/api/v1/internal/flows/nodes/agentsAvailability` with `botId`, `userId`, `orgId`, `accountId`, `skills`, `queue`, and `language` when no queue is specified.
5. **FR-5**: The system must validate queue via `POST /agentassist/api/v1/internal/flows/nodes/queueAvailability` with `queueId` and `botId` when a queue is specified.
6. **FR-6**: The system must create a synthetic user in KoreServer via `POST /api/1.1/internal/agentassist/user` before transfer initiation, falling back to contactId if creation fails.
7. **FR-7**: The system must lazily resolve orgId via `POST /api/1.1/internal/agentassist/accounts/getAccountIdByBotId` with `{ streamId: appId }` when orgId is not in the connection config, and persist the resolved value back to the encrypted connection credentials.
8. **FR-8**: The system must initiate transfers via `POST /agentassist/api/v1/conversations` (configurable path) with full XO payload: orgId, userId, accountId, botId, source, language, metaInfo (contact details, conversation history, agentTransferConfig), conversationType, queue, skills, skillsIds, automationBotId.
9. **FR-9**: The system must embed the ABL webhook URL in `metaInfo.abl` when `ablWebhookBaseUrl` is configured, so SmartAssist dispatches events directly to ABL.
10. **FR-10**: The system must forward user messages to SmartAssist via `POST /agentassist/api/v1/internal/events/handle/` (configurable path) using the `start_kore_agent_chat_message_for_agent` event name with attachment support.
11. **FR-11**: The system must forward control events (typing, close) to SmartAssist via the same events/handle endpoint with appropriate event names (`start_control_message_for_agent`, `close_conversation`).
12. **FR-12**: The system must receive inbound SmartAssist events via `POST /api/v1/agent-transfer/webhooks/smartassist` with HMAC signature verification when a webhook secret is configured.
13. **FR-13**: The system must map 22 XO event type entries to ABL `AgentEventType` values (mapping to 10 distinct ABL event types) (agent_message→agent:message, agent_accepted→agent:connected, conversation_queued→agent:queued, closed→agent:disconnected, typing→agent:typing, form_message→agent:form, etc.).
14. **FR-14**: The system must create Redis transfer sessions with provider index keys and optional Kore orgId alias keys for webhook session lookup.
15. **FR-15**: The system must support channel-specific session TTLs (chat: 1800s, email: 14400s, voice: 0, messaging: 1800s) with atomic Lua script-based TTL extension.
16. **FR-16**: The system must expose a `check-hours` ABL tool that allows AI agents to check SmartAssist business hours before escalation.
17. **FR-17**: The system must expose a `set-queue` ABL tool that allows AI agents to validate and select a SmartAssist queue for routing.
18. **FR-18**: The system must support two post-agent actions: `end` (cleanup session on agent disconnect) and `return` (preserve session for AI agent resumption).
19. **FR-19**: The system must map ABL channel types to SmartAssist source values (chat→rtm, voice→voice, email→email, whatsapp→whatsapp, slack→slack, msteams→msteams).
20. **FR-20**: The system must map languages using the LANGUAGE_MAP (e.g., `pt-pt` → `pt_pt`) with passthrough for unmapped languages.
21. **FR-21**: The system must update transfers via `POST /agentassist/api/v1/internal/flows/nodes/updateTransfer` with conversationId and updated fields.
22. **FR-22**: The system must enforce tenant isolation on webhook events by validating `event.orgId` against both the ABL `tenantId` and the stored `providerData.orgId`, returning 404 on mismatch.

---

## 5. Feature Classification & Integration Matrix

### Lifecycle / Platform Impact

| Area                       | Impact Level | Notes                                                         |
| -------------------------- | ------------ | ------------------------------------------------------------- |
| Project lifecycle          | SECONDARY    | Connection config is project-scoped                           |
| Agent lifecycle            | PRIMARY      | Adapter is invoked during agent escalation flow               |
| Customer experience        | PRIMARY      | Seamless AI-to-human handoff                                  |
| Integrations / channels    | PRIMARY      | Core SmartAssist integration with multi-channel support       |
| Observability / tracing    | SECONDARY    | Trace events emitted for transfer lifecycle                   |
| Governance / controls      | SECONDARY    | Pre-checks enforce business rules                             |
| Enterprise / compliance    | SECONDARY    | Credential encryption, tenant isolation, webhook verification |
| Admin / operator workflows | SECONDARY    | Connection form in Studio settings                            |

### Related Feature Integration Matrix

| Related Feature                                            | Relationship Type | Why It Matters                                              | Key Touchpoints                           | Current State |
| ---------------------------------------------------------- | ----------------- | ----------------------------------------------------------- | ----------------------------------------- | ------------- |
| [Agent Transfer](../agent-transfer.md)                     | extends           | Kore adapter is the primary implementation of the interface | AgentDesktopAdapter, TransferSessionStore | BETA          |
| [Five9 Adapter](./five9-adapter.md)                        | shares data with  | Both adapters share session store, webhook route, types     | TransferSessionStoreHandle, XOEvent       | ALPHA         |
| [Session Management](../multi-agent-session-management.md) | depends on        | Transfer sessions extend the core session lifecycle         | SessionService, RuntimeExecutor           | STABLE        |
| [Encryption at Rest](../encryption-at-rest.md)             | depends on        | Connection credentials encrypted in MongoDB                 | getEncryptionService                      | STABLE        |
| [Webhook System](../webhook-system.md)                     | extends           | Inbound events via webhook route                            | agent-transfer-webhooks route             | STABLE        |

---

## 6. Design Considerations

- The adapter follows the same `AgentDesktopAdapter` interface as Five9, enabling runtime to treat all providers uniformly
- The Studio connection form uses a registry pattern (`AGENT_DESKTOP_PROVIDERS`) for dynamic field rendering
- The `metaInfo.abl` webhook embedding pattern allows ABL to receive events directly from SmartAssist without a separate webhook registration API
- Lazy orgId resolution avoids requiring users to manually look up and enter the orgId — it's fetched from KoreServer on first escalation and cached in the encrypted credentials

---

## 7. Technical Considerations

- **Connection pooling**: `undici.Pool` with 50 connections, 30s keep-alive for SmartAssist API calls
- **Circuit breaker**: 5 failures threshold, 30s reset, 3 half-open max (configurable via schema)
- **Retry**: 2 max attempts with 500ms base backoff and 2x multiplier (initTransfer is non-retryable)
- **SSRF guard**: All outbound URLs validated via `assertAllowedUrlSync` before requests
- **Synthetic user**: Created in KoreServer before each transfer to get a valid `u-xxxx` userId; falls back to contactId on failure
- **Provider alias**: A secondary Redis index keyed by Kore orgId (instead of ABL tenantId) enables webhook session lookup when SmartAssist sends events with its own orgId
- **Atomic Lua scripts**: All Redis session mutations (create, end, extend TTL, claim, update) use Lua scripts to prevent TOCTOU races

---

## 8. How to Consume

### Studio UI

- Navigate to **Project Settings > Agent Transfer > Default Routing**
- Select "Kore SmartAssist" from the provider dropdown
- Fill in connection form fields: Base URL (required), API Key (optional), Webhook Secret (optional), App ID (required), Organization ID (optional — auto-resolved)
- Save the connection — credentials are encrypted at rest

### API (Runtime)

| Method | Path                                            | Purpose                          |
| ------ | ----------------------------------------------- | -------------------------------- |
| POST   | `/api/v1/agent-transfer/webhooks/smartassist`   | Inbound SmartAssist agent events |
| WS     | WebSocket `send_message` during active transfer | User messages forwarded to agent |

### API (Studio)

| Method | Path                                                  | Purpose                       |
| ------ | ----------------------------------------------------- | ----------------------------- |
| POST   | `/api/organizations/:orgId/connections`               | Create SmartAssist connection |
| PUT    | `/api/organizations/:orgId/connections/:connectionId` | Update connection credentials |
| GET    | `/api/organizations/:orgId/connections`               | List connections              |

### Admin Portal

N/A — connection management is project-scoped via Studio.

### Channel / SDK / Voice / A2A / MCP Integration

The adapter is channel-aware via `mapChannelToSource()` and `mapChannelToConversationType()`:

- **Web/Chat**: source=`rtm`, conversationType=`livechat`
- **Voice**: source=`voice`, conversationType=`call`
- **Email**: source=`email`, conversationType=`email`
- **WhatsApp/Slack/MSTeams**: mapped to respective source values

---

## 9. Data Model

### Collections / Tables

No new MongoDB collections. Uses existing `ConnectorConnection` for encrypted credentials:

```text
Collection: ConnectorConnection (existing)
Fields:
  - _id: string
  - tenantId: string (required, indexed)
  - projectId: string (required, indexed)
  - connectorName: 'smartassist'
  - encryptedCredentials: string (AES-encrypted JSON blob)
  - authType: 'api_key'
  - status: 'active' | 'expired' | 'revoked'
```

Redis session hash:

```text
Key: agent_transfer:{tenantId}:{contactId}:{channel}
Fields:
  - tenantId, contactId, channel, provider ('smartassist')
  - providerSessionId (conversationId from SmartAssist)
  - agentId, state (pending/queued/active/post_agent/ended)
  - metadata (JSON: postAgentAction, sourceAgentId, parentAgentId)
  - providerData (JSON: syntheticUserId, orgId, botId)
  - ownerPod, createdAt, lastActivityAt
  TTL: channel-specific (chat=1800s, email=14400s, voice=0, messaging=1800s)

Index: at_by_provider:smartassist:{tenantId}:{providerSessionId} → session key
Alias: at_by_provider:smartassist:{koreOrgId}:{providerSessionId} → session key
```

### Key Relationships

- `ConnectorConnection._id` referenced by `ProjectSettings.agentTransfer.defaultRouting.connectionId`
- Session `providerSessionId` maps to SmartAssist `conversationId`
- Session `providerData.syntheticUserId` maps to KoreServer `userId` (u-xxxx format)
- Session `providerData.orgId` maps to SmartAssist organization ID (o-xxxx format)

---

## 10. Key Implementation Files

### Domain / Core Logic

| File                                                               | Purpose                                                           |
| ------------------------------------------------------------------ | ----------------------------------------------------------------- |
| `packages/agent-transfer/src/adapters/kore/index.ts`               | KoreAdapter — orchestrates prechecks, transfer, session, events   |
| `packages/agent-transfer/src/adapters/kore/smartassist-client.ts`  | SmartAssistClient — HTTP client with pool, circuit breaker, retry |
| `packages/agent-transfer/src/adapters/kore/event-handler.ts`       | KoreEventHandler — XO event type mapping and dispatch             |
| `packages/agent-transfer/src/adapters/interface.ts`                | AgentDesktopAdapter interface definition                          |
| `packages/agent-transfer/src/config/schema.ts`                     | SmartAssistConfigSchema, ProviderConfigSchema                     |
| `packages/agent-transfer/src/session/transfer-session-store.ts`    | Redis session store with atomic Lua scripts                       |
| `packages/agent-transfer/src/session/types.ts`                     | Session key builders, TTL defaults, data types                    |
| `packages/agent-transfer/src/session/lua-scripts.ts`               | Lua scripts for atomic Redis operations                           |
| `packages/agent-transfer/src/tools/check-hours.ts`                 | CheckHoursTool — ABL tool for business hours check                |
| `packages/agent-transfer/src/tools/set-queue.ts`                   | SetQueueTool — ABL tool for queue validation/selection            |
| `packages/agent-transfer/src/security/ssrf-guard.ts`               | SSRF URL validation for outbound requests                         |
| `packages/agent-transfer/src/security/session-field-encryption.ts` | Field-level encryption for Redis session data                     |

### Routes / Handlers

| File                                                         | Purpose                                                             |
| ------------------------------------------------------------ | ------------------------------------------------------------------- |
| `apps/runtime/src/routes/agent-transfer-webhooks.ts`         | Inbound webhook route with HMAC verification and tenant isolation   |
| `apps/runtime/src/services/agent-transfer/index.ts`          | Boot service — adapter registry, session store, message bridge init |
| `apps/runtime/src/services/agent-transfer/message-bridge.ts` | Agent→user message routing via WebSocket/channel/voice              |
| `apps/runtime/src/services/execution/routing-executor.ts`    | Escalation flow — connection resolution, adapter init, execute()    |
| `apps/runtime/src/config/agent-transfer.ts`                  | Env var config loader for SmartAssist                               |
| `apps/runtime/src/websocket/handler.ts`                      | WebSocket handler — intercepts messages during active transfer      |

### UI Components

| File                                                                | Purpose                                                  |
| ------------------------------------------------------------------- | -------------------------------------------------------- |
| `apps/studio/src/components/connections/agent-desktop-registry.ts`  | SmartAssist provider field definitions for connection UI |
| `apps/studio/src/components/connections/CreateConnectionModal.tsx`  | Connection creation modal (dynamic field rendering)      |
| `apps/studio/src/components/connections/EditConnectionDialog.tsx`   | Connection credential editing dialog                     |
| `apps/studio/src/components/settings/AgentTransferSettingsPage.tsx` | Agent transfer settings with default routing dropdown    |

### Jobs / Workers / Background Processes

| File                                                              | Purpose                                                                  |
| ----------------------------------------------------------------- | ------------------------------------------------------------------------ |
| `packages/agent-transfer/src/session/session-recovery-service.ts` | SSCAN-based session recovery on pod restart — reclaims orphaned sessions |

### Tests

| File                                                                             | Type        | Coverage Focus                                            |
| -------------------------------------------------------------------------------- | ----------- | --------------------------------------------------------- |
| `packages/agent-transfer/src/__tests__/kore-adapter-wiring.test.ts`              | unit        | KoreAdapter wiring (send, control, precheck)              |
| `packages/agent-transfer/src/__tests__/kore-adapter-key-fixes.test.ts`           | unit        | Session key format, postAgentAction extraction            |
| `packages/agent-transfer/src/__tests__/smartassist-client-protocol.test.ts`      | unit        | SmartAssistClient API protocol conformance                |
| `packages/agent-transfer/src/__tests__/event-mapping-fixes.test.ts`              | unit        | KoreEventHandler XO→ABL event mapping                     |
| `packages/agent-transfer/src/__tests__/unit/event-handler-attachments.test.ts`   | unit        | Attachment extraction from XO events                      |
| `packages/agent-transfer/src/__tests__/unit/smartassist-update-transfer.test.ts` | unit        | updateTransfer endpoint and error propagation             |
| `packages/agent-transfer/src/__tests__/integration/kore-transfer-flow.test.ts`   | integration | Transfer flow orchestration with DI-injected mock adapter |
| `packages/agent-transfer/src/__tests__/e2e/kore-e2e.test.ts`                     | e2e         | Full lifecycle against real Redis                         |
| `packages/agent-transfer/src/__tests__/integration/backward-compat.test.ts`      | integration | agentId→botId, tenantId→orgId backward compat             |
| `apps/runtime/src/__tests__/agent-transfer-webhooks.test.ts`                     | unit        | Webhook endpoint validation and routing                   |
| `apps/runtime/src/__tests__/agent-transfer-webhook-routing.test.ts`              | unit        | Webhook routing, no double-delivery                       |
| `apps/runtime/src/__tests__/agent-transfer-bridge.test.ts`                       | unit        | Message bridge WebSocket delivery                         |
| `apps/runtime/src/__tests__/agent-transfer-boot.test.ts`                         | unit        | Boot config loading and initialization                    |
| `apps/runtime/src/__tests__/auth/agent-transfer-routes-authz.test.ts`            | unit        | Route authorization enforcement                           |

---

## 11. Configuration

### Environment Variables

| Variable                     | Default | Description                                                        |
| ---------------------------- | ------- | ------------------------------------------------------------------ |
| `AGENT_TRANSFER_ENABLED`     | `false` | Enable the agent transfer subsystem at boot                        |
| `SMARTASSIST_API_URL`        | —       | SmartAssist instance base URL (also: `SMARTASSIST_URL`)            |
| `SMARTASSIST_API_KEY`        | —       | SmartAssist API key for authenticated requests                     |
| `SMARTASSIST_TIMEOUT_MS`     | `5000`  | Request timeout for SmartAssist API calls                          |
| `SMARTASSIST_WEBHOOK_SECRET` | —       | HMAC secret for verifying inbound webhook payloads                 |
| `KORE_HOST`                  | —       | KoreServer host URL for synthetic user creation / orgId resolution |
| `KORE_INTERNAL_API_KEY`      | —       | Internal API key for KoreServer calls (falls back to API key)      |
| `ABL_WEBHOOK_BASE_URL`       | —       | ABL runtime public URL for webhook embedding in transfer payload   |
| `RUNTIME_PUBLIC_BASE_URL`    | —       | Fallback for ABL_WEBHOOK_BASE_URL                                  |
| `TRANSFER_SESSION_TTL_CHAT`  | `1800`  | Session TTL for chat channel (seconds)                             |
| `TRANSFER_SESSION_TTL_EMAIL` | `14400` | Session TTL for email channel (seconds)                            |

### Runtime Configuration

- **Per-connection credentials**: Stored in `ConnectorConnection.encryptedCredentials` — baseUrl, apiKey, appId, orgId (auto-resolved), webhookSecret, koreHost, koreApiKey
- **Per-project routing**: `ProjectSettings.agentTransfer.defaultRouting.connectionId` → references ConnectorConnection
- **Agent IR routing**: `escalation.routing.connection` in agent ABL source overrides project defaults

### DSL / Agent IR / Schema

```yaml
# Agent ABL escalation configuration
coordination:
  escalation:
    routing:
      connection: smartassist # adapter registry key
      queue: support-queue # optional queue routing
      skills: [billing, vip] # optional skill routing
```

---

## 12. Non-Functional Concerns

### Isolation & Multitenancy

| Concern           | Requirement / Expectation                                                                                         |
| ----------------- | ----------------------------------------------------------------------------------------------------------------- |
| Project isolation | Connection credentials are project-scoped via `ConnectorConnection.projectId`                                     |
| Tenant isolation  | Session keys include `tenantId`; webhook validation checks `event.orgId` against both ABL tenantId and Kore orgId |
| User isolation    | Sessions keyed by `contactId`; user messages only forwarded for the active session's contact                      |

### Security & Compliance

- **Credential encryption**: Connection credentials AES-encrypted at rest in MongoDB via `encryptJsonForTenant`
- **Session field encryption**: Sensitive Redis session fields encrypted via `SessionFieldEncryptor`
- **HMAC webhook verification**: Inbound webhooks verified with configurable webhook secret and nonce replay detection
- **SSRF guard**: All outbound URLs validated via `assertAllowedUrlSync` — blocks internal IPs, localhost, private ranges
- **API key security**: Keys stored encrypted, never logged, passed in headers only
- **Handler limits**: Max 10 agent message handlers and 10 session event handlers to prevent memory amplification

### Performance & Scalability

- **Connection pooling**: undici Pool with 50 connections, 1 pipelining, 30s keep-alive
- **Request timeout**: 5000ms default with AbortController-based cancellation
- **Redis timeout**: 5000ms per operation with `withTimeout` wrapper
- **Session TTLs**: Channel-specific TTLs prevent Redis memory growth
- **Atomic operations**: Lua scripts eliminate round-trip overhead for multi-step Redis operations

### Reliability & Failure Modes

| Error Code                   | Cause                            | Recovery                                 |
| ---------------------------- | -------------------------------- | ---------------------------------------- |
| `ADAPTER_NOT_CONFIGURED`     | Client not initialized           | Configure connection credentials         |
| `APP_ID_NOT_CONFIGURED`      | appId missing for synthetic user | Add appId to connection form             |
| `OUTSIDE_HOURS`              | Business hours check failed      | Inform user, retry during business hours |
| `NO_AGENTS`                  | No agents available              | Inform user, retry later                 |
| `QUEUE_INVALID`              | Queue validation failed          | Check queue configuration                |
| `KORE_USER_CREATION_FAILED`  | Synthetic user creation failed   | Falls back to contactId                  |
| `KORE_GET_ACCOUNT_ID_FAILED` | orgId resolution failed          | Proceeds without orgId (degraded)        |
| `SMARTASSIST_ERROR`          | Server error after retries       | Circuit breaker opens, retries exhausted |
| `SMARTASSIST_CLIENT_ERROR`   | 4xx client error (non-retryable) | Check configuration, fix request         |
| `SMARTASSIST_PARSE_ERROR`    | Non-JSON response                | Log and report structured error          |

### Observability

- **Logger**: `createLogger('kore-adapter')`, `createLogger('smartassist-client')` — structured JSON logging
- **Request/response logging**: Every SmartAssist API call logs path, payload, status code, and response (truncated to 500 chars)
- **Trace events**: `agent_transfer_initiated` emitted with success/status/provider/sessionKey
- **Session lifecycle logging**: Create, extend TTL, end, cleanup events logged with session context

### Data Lifecycle

- **Session TTL**: Auto-expires per channel (chat: 30min, email: 4hr, voice: infinite, messaging: 30min)
- **Provider index TTL**: Matches session TTL, cleaned up atomically on session end
- **Alias key TTL**: Extended on every agent event, cleaned up on session end
- **Encrypted credentials**: Persist until connection is deleted or updated
- **No PII retention**: Conversation history passed to SmartAssist but not stored beyond session lifetime

---

## 13. Delivery Plan / Work Breakdown

1. **SmartAssist HTTP Client**
   1.1 Implement `SmartAssistClient` with undici Pool, circuit breaker, retry
   1.2 Add pre-check APIs (business hours, availability, queue)
   1.3 Add `initTransfer` with full XO payload support
   1.4 Add `sendEvent` for user message and control event forwarding
   1.5 Add `updateTransfer` for mid-conversation updates
   1.6 Add `createSyntheticUser` for KoreServer user creation
   1.7 Add `getAccountIdByBotId` for lazy orgId resolution

2. **KoreAdapter Core**
   2.1 Implement `KoreAdapter` with `AgentDesktopAdapter` interface
   2.2 Add `execute()` flow: resolveOrgId → preChecks → syntheticUser → initTransfer → session
   2.3 Add `sendUserMessage()` with session resolution and event construction
   2.4 Add `sendControlEvent()` for typing and close events
   2.5 Add `endSession()` with close notification and session cleanup
   2.6 Add `handleInboundEvent()` with event mapping and post-agent action handling
   2.7 Add `resolveOrgId()` with lazy fetch and DB persistence callback

3. **Event Handler**
   3.1 Implement `KoreEventHandler` with 22 XO event type mappings
   3.2 Add attachment extraction from XO event payloads
   3.3 Add agent message handler dispatch with handler count limits

4. **Session Management**
   4.1 Extend `TransferSessionStore` with provider alias indexing
   4.2 Add alias key TTL extension on agent events
   4.3 Add alias key cleanup on session end
   4.4 Implement atomic Lua scripts for create, end, extend, claim, update

5. **Runtime Integration**
   5.1 Add webhook route with HMAC verification and tenant isolation
   5.2 Wire adapter registry and session store in boot service
   5.3 Add message bridge for agent→user routing via WebSocket/channel/voice
   5.4 Add escalation flow in routing-executor with connection resolution and orgId persistence
   5.5 Add transfer interception in WebSocket handler

6. **Studio UI**
   6.1 Register SmartAssist provider in `agent-desktop-registry.ts`
   6.2 Define connection form fields (baseUrl, apiKey, appId, orgId, webhookSecret)

7. **ABL Tools**
   7.1 Implement `CheckHoursTool` with SmartAssistClient access
   7.2 Implement `SetQueueTool` with queue validation

8. **Testing**
   8.1 Unit tests for SmartAssistClient protocol
   8.2 Unit tests for KoreAdapter wiring
   8.3 Unit tests for event handler mapping
   8.4 Integration tests for transfer flow
   8.5 E2E tests for session lifecycle against real Redis
   8.6 Backward compatibility tests
   8.7 Webhook routing and authorization tests

---

## 14. Success Metrics

| Metric                        | Baseline | Target    | How Measured                                  |
| ----------------------------- | -------- | --------- | --------------------------------------------- |
| Transfer success rate         | N/A      | > 95%     | Trace events (success/total)                  |
| Pre-check accuracy            | N/A      | 100%      | No false positives blocking valid transfers   |
| Message delivery latency      | N/A      | < 2s      | Timestamp diff between send and webhook event |
| Session leak rate             | N/A      | 0         | Redis session count vs active transfers       |
| Test coverage (Kore-specific) | 0        | 86+ tests | vitest run count                              |
| orgId auto-resolution rate    | N/A      | 100%      | Logs — fetch success vs failure               |

---

## 15. Open Questions

1. Should the adapter support webhook secret rotation without downtime (accept both old and new secrets during a transition window)?
2. Should the `check-hours` and `set-queue` tools be discoverable in the Studio tool catalog, or only available via ABL DSL?
3. Is there a need for a health check endpoint that validates SmartAssist connectivity before escalation?
4. Should the adapter support multi-region SmartAssist deployments with automatic failover?
5. Should conversation history forwarding be configurable (e.g., last N messages, or all)?

---

## 16. Gaps, Known Issues & Limitations

| ID      | Description                                                                                                                                                         | Severity | Status      |
| ------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------- | -------- | ----------- |
| GAP-001 | File upload capability declared but not implemented end-to-end                                                                                                      | Medium   | Open        |
| GAP-002 | Agent typing indicators from SmartAssist not surfaced in chat UI                                                                                                    | Low      | Open        |
| GAP-003 | No webhook secret rotation support                                                                                                                                  | Medium   | Open        |
| GAP-004 | Session recovery on pod restart is best-effort (SSCAN-based)                                                                                                        | Medium   | Mitigated   |
| GAP-005 | Circuit breaker state is per-process, not shared across pods                                                                                                        | Low      | Open        |
| GAP-006 | No dedicated health check for SmartAssist connectivity                                                                                                              | Low      | Open        |
| GAP-007 | TODO marker in event-handler.ts:452 for agent_disconnect handling                                                                                                   | Low      | In Progress |
| GAP-008 | orgId resolution persists to ConnectorConnection but adapter is singleton — stale config from previous project can leak (fixed on kore-adapter-enhancements branch) | High     | Mitigated   |

---

## 17. Testing & Validation

### Required Test Coverage

| #   | Scenario                                    | Coverage Type | Status     | Test File / Note                       |
| --- | ------------------------------------------- | ------------- | ---------- | -------------------------------------- |
| 1   | SmartAssistClient initTransfer path/payload | unit          | PASS       | smartassist-client-protocol.test.ts    |
| 2   | SmartAssistClient sendEvent path/payload    | unit          | PASS       | smartassist-client-protocol.test.ts    |
| 3   | SmartAssistClient updateTransfer            | unit          | PASS       | smartassist-update-transfer.test.ts    |
| 4   | SmartAssistClient accountId mapping         | unit          | PASS       | smartassist-client-protocol.test.ts    |
| 5   | KoreAdapter sendUserMessage wiring          | unit          | PASS       | kore-adapter-wiring.test.ts            |
| 6   | KoreAdapter sendControlEvent mapping        | unit          | PASS       | kore-adapter-wiring.test.ts            |
| 7   | KoreAdapter endSession ordering             | unit          | PASS       | kore-adapter-wiring.test.ts            |
| 8   | KoreAdapter runPreChecks logic              | unit          | PASS       | kore-adapter-wiring.test.ts            |
| 9   | KoreAdapter handleInboundEvent cleanup      | unit          | PASS       | kore-adapter-wiring.test.ts            |
| 10  | KoreAdapter session key format              | unit          | PASS       | kore-adapter-key-fixes.test.ts         |
| 11  | KoreAdapter postAgentAction extraction      | unit          | PASS       | kore-adapter-key-fixes.test.ts         |
| 12  | KoreEventHandler 22 XO event type mappings  | unit          | PASS       | event-mapping-fixes.test.ts            |
| 13  | KoreEventHandler attachment extraction      | unit          | PASS       | event-handler-attachments.test.ts      |
| 14  | Full transfer flow (mock adapter)           | integration   | PASS       | kore-transfer-flow.test.ts             |
| 15  | Backward compatibility (10 guarantees)      | integration   | PASS       | backward-compat.test.ts                |
| 16  | Session lifecycle (real Redis)              | e2e           | PASS       | kore-e2e.test.ts                       |
| 17  | Webhook endpoint validation                 | unit          | PASS       | agent-transfer-webhooks.test.ts        |
| 18  | Webhook routing no double-delivery          | unit          | PASS       | agent-transfer-webhook-routing.test.ts |
| 19  | Message bridge WebSocket delivery           | unit          | PASS       | agent-transfer-bridge.test.ts          |
| 20  | Boot config loading                         | unit          | PASS       | agent-transfer-boot.test.ts            |
| 21  | Route authorization                         | unit          | PASS       | agent-transfer-routes-authz.test.ts    |
| 22  | Tenant isolation enforcement                | unit          | PASS       | tenant-isolation.test.ts               |
| 23  | SSRF guard validation                       | unit          | PASS       | ssrf-guard.test.ts                     |
| 24  | Session Lua script atomicity                | unit          | PASS       | session-lua-fixes.test.ts              |
| 25  | Webhook nonce replay detection              | unit          | PASS       | security-hardening.test.ts             |
| 26  | orgId lazy resolution (getAccountIdByBotId) | unit          | NOT TESTED | Needs dedicated test                   |

### Testing Notes

The Kore adapter has 86+ directly-focused tests across 14 test files, plus 400+ shared infrastructure tests. E2E tests require live Redis (`AGENT_TRANSFER_E2E=1`). The orgId lazy resolution feature (FR-7) added on the `kore-adapter-enhancements` branch needs dedicated test coverage. BETA criteria met: 1 E2E scenario (session lifecycle with real Redis), 2 integration scenarios (transfer flow, backward compat). Additional E2E scenarios needed for STABLE promotion.

> Full testing details: `../../testing/sub-features/kore-adapter.md`

---

## 18. References

- Design docs: `docs/enterprise/ABL_AGENT_TRANSFER_REFERENCE.md`, `docs/enterprise/KORESERVER_AGENTASSIST_TRANSFER_FLOW.md`
- Plan docs: `docs/plans/2026-03-28-agentassist-abl-webhook-integration-plan.md`, `docs/plans/2026-03-29-agentassist-webhook-changes.md`
- Related feature docs: [Agent Transfer](../agent-transfer.md), [Five9 Adapter](./five9-adapter.md)
- Config schema: `packages/agent-transfer/src/config/schema.ts`

# Feature Spec: Agent Transfer

- **Feature ID:** F014
- **Status:** BETA
- **Owner:** Platform Team
- **Created:** 2026-03-23
- **Last Updated:** 2026-04-14

---

## 1. Problem Statement

When AI agents encounter situations beyond their capability (e.g., complex billing disputes, emotional distress, regulatory-required human oversight), the conversation must be seamlessly transferred to a human agent on an external agent desktop platform. The ABL platform needs a robust, multi-channel, multi-provider agent transfer subsystem that handles the complete lifecycle: pre-transfer checks, transfer initiation, bidirectional messaging during the transfer, session management, post-agent workflows (CSAT surveys, disposition codes), and graceful session termination.

**Why now:** The ABL platform targets enterprise customers migrating from the XO platform. Agent transfer is table-stakes for contact center deployments. Without it, no enterprise customer can go live.

---

## 2. Scope

### 2.1 In-Scope

| Area                        | Description                                                                                                                                                 |
| --------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **Transfer Lifecycle**      | End-to-end session management: initiation, queuing, active transfer, post-agent, and cleanup                                                                |
| **Adapter Pattern**         | Pluggable `AgentDesktopAdapter` interface supporting Kore SmartAssist (primary) and extensible to other desktops                                            |
| **Bidirectional Messaging** | User-to-agent and agent-to-user message routing across chat, messaging, voice, and email channels                                                           |
| **Transfer Tools**          | DSL-exposed tools: `transfer_to_agent`, `check_hours`, `check_availability`, `set_queue`, `ivr_menu`, `ivr_digit_input`, `call_transfer`, `deflect_to_chat` |
| **Session Store**           | Redis-backed session store with Lua-atomic operations, field-level encryption, TTL-based expiry, and provider reverse-index                                 |
| **Message Bridge**          | Routes agent desktop events to user channels (WebSocket, channel adapters, voice gateway)                                                                   |
| **Webhook Ingestion**       | `POST /api/v1/agent-transfer/webhooks/:provider` with signature verification and tenant isolation                                                           |
| **Session Management API**  | `GET /api/v1/agent-transfer/sessions`, `POST /api/v1/agent-transfer/sessions/:id/end`                                                                       |
| **Settings API**            | `GET/PUT /api/v1/agent-transfer/settings` for project-level configuration                                                                                   |
| **Security**                | Webhook signature verification (HMAC + nonce), SSRF guard, rate limiting, session field encryption, log redaction                                           |
| **Observability**           | Trace events emitted to platform TraceStore, structured logging, metrics                                                                                    |
| **Voice Integration**       | Voice gateway registry, SIP REFER/PSTN transfers, IVR tools, voice-to-chat deflection                                                                       |
| **Post-Agent Workflows**    | CSAT survey handler, disposition metadata primitives, configurable post-agent actions                                                                       |
| **Session Recovery**        | Leader-elected recovery service that reclaims orphaned sessions from crashed pods                                                                           |
| **Durable Events**          | BullMQ-backed durable event queue with dead-letter store for failed deliveries                                                                              |
| **Studio UI**               | Settings page, transfer sessions list, session detail modal                                                                                                 |
| **Studio Proxy Routes**     | `/api/projects/:id/agent-transfer/sessions`, `/api/projects/:id/agent-transfer/settings`                                                                    |

### 2.2 Out-of-Scope

| Area                                     | Rationale                                                                                                          |
| ---------------------------------------- | ------------------------------------------------------------------------------------------------------------------ |
| Multi-provider simultaneous transfers    | Single active transfer per contact+channel. Multi-provider support is adapter-registry-ready but not orchestrated. |
| Video channel transfers                  | No agent desktop supports video handoff today.                                                                     |
| Agent-initiated conversations (outbound) | Inbound transfer only; outbound campaigns are a separate feature.                                                  |
| Agent desktop UI                         | The human agent uses an external desktop (SmartAssist, Salesforce, etc.). ABL does not provide one.                |
| A2A (Agent-to-Agent) protocol            | Covered by `packages/a2a`, separate feature scope.                                                                 |

---

## 3. Requirements

### 3.1 Functional Requirements

| ID    | Requirement                                                                                                                  | Priority | Status      |
| ----- | ---------------------------------------------------------------------------------------------------------------------------- | -------- | ----------- |
| FR-01 | AI agent can initiate a transfer via `transfer_to_agent` tool with queue, skills, and priority routing                       | P0       | Implemented |
| FR-02 | System checks agent availability and business hours before transfer via `check_availability` and `check_hours` tools         | P0       | Implemented |
| FR-03 | Transfer session is created atomically in Redis with Lua scripts, preventing duplicate sessions for the same contact+channel | P0       | Implemented |
| FR-04 | Webhook endpoint receives inbound events from agent desktop providers with tenant isolation and signature verification       | P0       | Implemented |
| FR-05 | Message bridge routes agent messages to user's active channel (WebSocket, chat adapter, voice gateway)                       | P0       | Implemented |
| FR-06 | User messages are forwarded to the human agent via `adapter.sendUserMessage()` during active transfer                        | P0       | Implemented |
| FR-07 | Session can be ended via API (`POST .../sessions/:id/end`) or by the agent desktop (webhook event)                           | P0       | Implemented |
| FR-08 | Transfer sessions have channel-specific TTLs (chat: 30min, email: 24hr, voice: session-duration, messaging: 30min)           | P1       | Partial     |
| FR-09 | Session field encryption protects sensitive metadata (PII, custom data) at rest in Redis using tenant-scoped keys            | P1       | Implemented |
| FR-10 | Post-agent workflows: CSAT survey initiation and disposition code capture after agent disconnect                             | P1       | Partial     |
| FR-11 | Voice channel tools: IVR menu, IVR digit input, SIP/PSTN call transfer, voice-to-chat deflection                             | P1       | Implemented |
| FR-12 | Session recovery service reclaims orphaned sessions from crashed pods via leader election                                    | P1       | Implemented |
| FR-13 | Durable event queue ensures agent events are not lost during transient failures (BullMQ + dead-letter)                       | P1       | Implemented |
| FR-14 | Studio UI displays project-level transfer settings (TTLs, routing defaults, voice config, PII handling)                      | P1       | Implemented |
| FR-15 | Studio UI lists active transfer sessions with filtering and pagination                                                       | P1       | Implemented |
| FR-16 | Rate limiting on `transfer_to_agent` prevents abuse (per-tenant Redis-based sliding window)                                  | P2       | Implemented |
| FR-17 | SSRF guard validates URLs before adapter HTTP calls to prevent server-side request forgery                                   | P2       | Implemented |
| FR-18 | Configuration reloader allows runtime config changes via Redis pub/sub without restart                                       | P2       | Implemented |
| FR-19 | Conversation history is formatted per provider strategy before being sent with the transfer                                  | P2       | Implemented |
| FR-20 | Fallback executor retries failed transfers with configurable fallback adapters                                               | P2       | Implemented |

### 3.2 Non-Functional Requirements

| ID     | Requirement                                                                          | Priority | Status      |
| ------ | ------------------------------------------------------------------------------------ | -------- | ----------- |
| NFR-01 | Session creation must complete in < 100ms (Redis Lua atomic operation)               | P0       | Met         |
| NFR-02 | Webhook endpoint must respond in < 500ms under normal conditions                     | P0       | Met         |
| NFR-03 | System must handle 1,000 concurrent transfer sessions per tenant without degradation | P1       | Untested    |
| NFR-04 | Session field encryption must not add > 10ms per operation                           | P1       | Untested    |
| NFR-05 | Dead-letter store must retain failed events for at least 7 days                      | P2       | Implemented |
| NFR-06 | Session recovery must detect and reclaim orphaned sessions within 60 seconds         | P1       | Implemented |
| NFR-07 | All sensitive fields (API keys, PII) must be redacted from logs                      | P0       | Implemented |

---

## 4. User Stories

### US-01: AI Agent Initiates Transfer

**As** an AI agent processing a conversation, **when** the user's issue requires human intervention, **I want** to use the `transfer_to_agent` tool to hand off the conversation to a human agent with relevant context (queue, skills, priority, conversation history), **so that** the user gets seamless support continuity.

**Acceptance Criteria:**

- Transfer tool validates required fields (tenantId, projectId, channel, contactId)
- Session is created atomically in Redis
- Conversation history is formatted per provider strategy
- Provider adapter initiates the transfer via SmartAssist API
- Transfer result includes status, session ID, estimated wait time, and queue position

### US-02: Human Agent Sends Message to User

**As** a human agent on SmartAssist, **when** I send a message to a transferred user, **I want** the message to be delivered to the user's active channel in real-time, **so that** the conversation feels natural.

**Acceptance Criteria:**

- SmartAssist webhook delivers the event to `POST /api/v1/agent-transfer/webhooks/kore`
- Webhook signature is verified (HMAC + nonce)
- Event is normalized from XO format to ABL format
- Message bridge delivers to user via WebSocket (Studio), channel adapter (Slack/WhatsApp), or voice gateway

### US-03: User Sends Message to Human Agent

**As** a user in a transferred conversation, **when** I type a message, **I want** it forwarded to the human agent on their desktop, **so that** I can communicate directly with the agent.

**Acceptance Criteria:**

- Runtime intercepts user messages during active transfer state
- Messages are sent via `adapter.sendUserMessage()` to SmartAssist API
- Attachments are handled if supported by the channel and provider

### US-04: Session Ends and Post-Agent Workflow Runs

**As** an AI agent, **when** the human agent disconnects, **I want** the system to run post-agent workflows (CSAT survey, disposition capture) and then resume or end the conversation, **so that** quality feedback is collected and the session is properly closed.

**Acceptance Criteria:**

- Agent disconnect event triggers state transition to `post_agent`
- CSAT handler initiates survey if configured
- Disposition handler captures agent notes
- Session transitions to `ended` state
- Redis session hash is cleaned up after TTL

Current status note: CSAT wiring exists, but runtime disposition metadata capture is not yet wired end-to-end.

### US-05: Studio Admin Configures Transfer Settings

**As** a Studio admin, **when** I navigate to project settings, **I want** to configure agent transfer defaults (TTLs, routing, voice gateway, PII handling), **so that** transfer behavior is consistent across all agents in the project.

**Acceptance Criteria:**

- Settings page loads current configuration from Runtime API
- Changes are saved to project settings via `PUT /api/v1/agent-transfer/settings`
- Validation prevents invalid TTL values or unknown voice gateway types

Current status note: settings are persisted successfully, but transfer-session TTL enforcement still falls back to store defaults unless an explicit TTL is passed into the live store path.

---

## 5. Architecture Summary

### 5.1 Package Structure

| Package/Path                                                               | Purpose                                                                         |
| -------------------------------------------------------------------------- | ------------------------------------------------------------------------------- |
| `packages/agent-transfer/`                                                 | Core SDK: adapters, session store, tools, security, events, voice, post-agent   |
| `packages/agent-transfer/src/adapters/kore/event-handler.ts`               | XO event type normalization (expanded mapping with 25+ event types)             |
| `packages/agent-transfer/src/adapters/kore/smartassist-client.ts`          | SmartAssist HTTP client (configurable paths, sendEvent, initTransfer)           |
| `packages/agent-transfer/src/voice/voice-gateway.ts`                       | Abstract voice gateway interface (dialAgent, endAgentCall capabilities)         |
| `apps/runtime/src/config/agent-transfer.ts`                                | Config loader from environment variables with Zod validation                    |
| `apps/runtime/src/services/agent-transfer/`                                | Boot service, message bridge, timeout queue, event queue                        |
| `apps/runtime/src/services/agent-transfer/message-bridge.ts`               | Multi-channel bridge: WebSocket, channel adapters, voice gateway, form renderer |
| `apps/runtime/src/services/execution/routing-executor.ts`                  | Routing executor wired for escalation and connection-backed transfer lookup     |
| `apps/runtime/src/routes/agent-transfer-*.ts`                              | REST API routes (webhooks, sessions, settings)                                  |
| `apps/runtime/src/services/execution/transfer-tool-executor.ts`            | Wires transfer tools into the execution pipeline                                |
| `apps/studio/src/components/connections/AgentDesktopConnectionDialog.tsx`  | Dialog for creating agent desktop connections (SmartAssist, Five9, etc.)        |
| `apps/studio/src/components/connections/agent-desktop-connection-utils.ts` | Builds auth profiles and connection config for agent desktop providers          |
| `apps/studio/src/components/connections/ConnectionsPage.tsx`               | Connections page with agent desktop grouping and catalog integration            |
| `apps/studio/src/components/connections/EditConnectionDialog.tsx`          | Edit dialog supporting agent desktop connection updates                         |
| `apps/studio/src/components/settings/AgentTransferSettingsPage.tsx`        | Studio settings UI                                                              |
| `apps/studio/src/components/operate/TransferSessions*.tsx`                 | Studio session monitoring UI                                                    |
| `apps/studio/src/api/agent-transfer.ts`                                    | Studio API client for transfer endpoints                                        |
| `packages/database/src/models/connector-connection.model.ts`               | MongoDB model for connector connections (supports agent desktop type)           |
| `packages/connectors/src/services/connection-service.ts`                   | Connection CRUD service (agent desktop connection support)                      |
| `packages/database/src/models/tenant-transfer.model.ts`                    | MongoDB model for persistent transfer config                                    |

### 5.2 Key Flows

1. **Transfer Initiation:** DSL ESCALATE construct -> `transfer_to_agent` tool -> `TransferToolExecutor` -> `KoreAdapter.execute()` -> SmartAssist API -> Session created in Redis
2. **Inbound Webhook:** SmartAssist -> `POST /webhooks/kore` -> signature verification -> session lookup -> `adapter.handleInboundEvent()` -> `onAgentMessage` callback -> `MessageBridge.routeAgentEvent()` -> WebSocket/channel adapter/voice gateway
3. **Voice Transfer:** `routing-executor.ts` detects ESCALATE with voice channel -> boot service resolves voice gateway session -> `KorevgSession.dialAgent()` initiates SIP REFER/PSTN transfer -> message bridge routes agent events back through voice TTS
4. **Connection-Backed Transfer:** Studio `ConnectionsPage` -> `AgentDesktopConnectionDialog` creates connection + auth profile -> `routing-executor.ts` resolves agent desktop adapter via connection lookup -> adapter executes transfer using connection credentials
5. **Session Management:** Studio UI -> `/api/projects/:id/agent-transfer/sessions` -> Runtime sessions API -> Redis session store for list/end; TTL settings are persisted separately and are not yet the authoritative live source for expiry
6. **Session Recovery:** Pod crash -> leader-elected recovery service -> orphaned session detection -> session reclaim to healthy pod

### 5.3 Data Model

**Redis Session Hash** (`agent_transfer:{tenantId}:{contactId}:{channel}`):

- Identity: `tenantId`, `contactId`, `channel`, `provider`, `providerSessionId`
- State: `state` (pending | queued | active | post_agent | ended)
- Routing: `queue`, `skills`, `priority`, `agentId`, `projectId`
- Lifecycle: `createdAt`, `updatedAt`, `lastHeartbeat`, `ttl`, `ownerPod`
- Metadata: `metadata` (encrypted), `providerData` (encrypted)
- Post-agent: `postAgentConfig`, `csatSurveyType`, `csatDialogId`, `dispositionCode`, `wrapUpNotes` (fields exist in the hash, but runtime disposition write paths are still partial)

**Provider Reverse Index** (`at_by_provider:{provider}:{tenantId}:{providerSessionId}`) -> session key

---

## 6. Known Gaps and Risks

| ID      | Gap                                                                                                                                                                                             | Severity     | Reference                                                               |
| ------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------ | ----------------------------------------------------------------------- |
| GAP-01  | 47 findings from XO platform comparison: 12 critical, 19 important, 8 moderate, 4 test gaps                                                                                                     | HIGH         | `docs/plans/2026-03-13-agent-transfer-gap-closure.md`                   |
| GAP-02  | ~~`packages/agent-transfer` has TS build errors (TS2353 in ivr-digit-input.ts, ivr-menu.ts)~~ **Mitigated** in ABLP-142: voice transfer port resolved build issues                              | ~~HIGH~~     | MEMORY.md                                                               |
| GAP-03  | E2E test coverage gap: no real Redis or SmartAssist integration tests                                                                                                                           | HIGH         | RFC-014 verification section                                            |
| GAP-04  | ~~User-to-agent message forwarding path not fully wired~~ **Mitigated** in ABLP-142: routing-executor now detects active transfers and routes through connection-backed adapters                | ~~CRITICAL~~ | `docs/plans/2026-03-13-agent-transfer-gap-closure.md` Phase 1           |
| GAP-05  | Attachment handling (file transfer both directions) incomplete                                                                                                                                  | MEDIUM       | Gap closure Phase 3                                                     |
| GAP-06  | NFR-03/NFR-04 (performance under load, encryption overhead) not validated                                                                                                                       | MEDIUM       | -                                                                       |
| GAP-07  | Project transfer TTL settings are stored in `ProjectSettings`, but live `TransferSessionStore` create/extend paths still fall back to hardcoded channel defaults when no explicit TTL is passed | HIGH         | `docs/features/sub-features/session-timeout-disposition-unification.md` |
| GAP-08  | `DispositionHandler` exists as a package primitive, but runtime does not currently construct or invoke it in a supported flow                                                                   | HIGH         | `docs/features/sub-features/session-timeout-disposition-unification.md` |
| GAP-09  | `POST /api/v1/agent-transfer/sessions/:id/end` ends blindly and does not yet accept structured reason or wrap-up metadata                                                                       | MEDIUM       | `docs/features/sub-features/session-timeout-disposition-unification.md` |
| GAP-10  | Transfer TTL defaults disagree between schema and store fallback for `email` when no explicit TTL is supplied                                                                                   | MEDIUM       | `docs/features/sub-features/session-timeout-disposition-unification.md` |
| RISK-01 | SmartAssist API availability: circuit breaker is implemented but fallback adapter strategy is untested E2E                                                                                      | MEDIUM       | -                                                                       |
| RISK-02 | Redis keyspace notifications for session expiry require `CONFIG SET` permission, which may be restricted in managed Redis                                                                       | LOW          | -                                                                       |

---

## 7. Success Metrics

| Metric                                 | Target  | Measurement                                                   |
| -------------------------------------- | ------- | ------------------------------------------------------------- |
| Transfer initiation success rate       | > 99%   | TraceStore `transfer:completed` / `transfer:initiated` events |
| Webhook processing latency (p99)       | < 500ms | Runtime request metrics                                       |
| Session recovery time                  | < 60s   | Recovery service trace events                                 |
| Message delivery success rate (bridge) | > 99.5% | Dead-letter queue depth trend                                 |
| Studio settings save success rate      | > 99.9% | Studio API error rate                                         |

---

## 8. Dependencies

| Dependency                               | Type             | Status                    |
| ---------------------------------------- | ---------------- | ------------------------- |
| Redis (ioredis)                          | Infrastructure   | Available                 |
| BullMQ                                   | Infrastructure   | Available                 |
| Kore SmartAssist API                     | External         | Configured per-deployment |
| `@agent-platform/circuit-breaker`        | Internal package | Available                 |
| `@agent-platform/shared/encryption`      | Internal package | Available                 |
| `@abl/compiler` (ToolExecutor interface) | Internal package | Available                 |
| Platform TraceStore                      | Internal service | Available                 |
| Channel adapter registry                 | Internal service | Available                 |
| Voice gateway registry                   | Internal service | Available                 |

---

## 9. Feature Status Lifecycle

| Status  | Criteria                                                                         | Current                                                                                                        |
| ------- | -------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------- |
| PLANNED | Feature spec approved                                                            | Done                                                                                                           |
| ALPHA   | Core transfer flow works (initiate, webhook, message bridge); unit tests pass    | **Current** -- voice transfer ported, connection-backed desktop flow restored, routing executor wired (Apr 14) |
| BETA    | Gap closure findings resolved; E2E tests pass; Studio UI functional              | Not yet -- E2E tests with real Redis still needed; GAP-07/08 (TTL enforcement, disposition) still open         |
| STABLE  | Performance validated (NFR-03/04); zero critical gaps; production traffic served | Not yet                                                                                                        |

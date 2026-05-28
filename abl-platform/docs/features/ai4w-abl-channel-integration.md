# Feature: AI4W-ABL Channel Integration

**Doc Type**: MAJOR FEATURE
**Parent Feature**: N/A
**Status**: PLANNED
**Feature Area(s)**: `integrations`, `customer experience`, `agent lifecycle`, `admin operations`, `enterprise`
**Package(s)**: `apps/runtime`, `packages/database`, `apps/studio`, `KoreServer/api/services/AgentsService`, `KoreServer/services/ABLGatewayService`
**Owner(s)**: Platform team
**Testing Guide**: [docs/testing/ai4w-abl-channel-integration.md](../testing/ai4w-abl-channel-integration.md)
**Last Updated**: 2026-04-22

---

## 1. Introduction / Overview

### Problem Statement

AIforWork (AI4W / KoreServer) orchestrates AI agents built internally or integrated from external platforms. ABL Platform is a purpose-built agent development and runtime platform with advanced capabilities: multi-agent orchestration, reasoning, suspension/resumption, A2A protocol, and rich channel delivery. Today, AI4W cannot invoke ABL-built agents. AI4W users must manually duplicate agent logic or maintain separate interfaces to leverage ABL agents. ABL agents cannot reach AI4W users for proactive tasks like human approvals or notifications.

### Goal Statement

Make ABL agents natively invocable from AI4W as a first-class agent type (`ablAgent`), enabling AI4W's orchestration layer to route conversations to ABL agents with full support for synchronous, streaming, and asynchronous response modes. Simultaneously, make AI4W a first-class channel in ABL (`ai4w` channel type), enabling ABL agents to deliver responses, proactive notifications, and human-approval challenges back to AI4W users.

### Summary

This feature creates a bidirectional integration bridge between AI4W and ABL Platform:

- **AI4W side**: A new `ablAgent` type in `AgentsService` and a new `ABLGatewayService` that handles outbound HTTP calls to ABL runtime, SSE stream consumption, async callback reception, and proactive notification delivery to users.
- **ABL side**: A new `ai4w` channel type in the channel manifest with a dedicated adapter that verifies AI4W JWTs, normalizes inbound payloads, transforms rich content output, and delivers async/proactive messages to AI4W's callback endpoints.
- **Auth**: Dual-layer — HMAC request signing with ABL-issued `connectionSecret` (authorization) + AI4W-issued JWT (identity). Global JWKS for JWT validation (`AI4W_JWKS_URI` env var). OAuth2 client-credentials for cross-environment deployments (P6).
- **Session**: ABL maintains its own session, trusting the user identity (email) from AI4W's signed JWT. Session key uses `ai4w:{connectionId}:{base64url(email)}:{agentContextId}` composite to prevent cross-connection collision.
- **Discovery**: ABL exposes internal-only **project** discovery APIs. AI4W users browse accessible ABL projects (one AI4W "agent" maps to one ABL project) and auto-provision a project-bound connection in one click. The admin tunes the pinned `environment` or `deploymentId` afterwards via the standard ABL channel-customization UI — exactly like peer channels (Genesys, VXML, Audiocodes). See §4 FR-9 / FR-10 / FR-19–22 and §8 API tables for the current endpoints.

---

## 2. Scope

### Goals

- Enable AI4W to invoke ABL agents via sync request-response, SSE streaming, and async callback response modes.
- Enable ABL to push proactive notifications (human-approval tasks, execution results) to AI4W users who did not initiate a conversation.
- Provide 1-click **project** discovery and provisioning for same-environment deployments (AI4W agent ↔ ABL project).
- Expose lifecycle APIs (deactivate, unlink) + `/info` health-check so AI4W can pause, reap, and verify provisioned connections.
- Support file exchange between platforms via signed URL exchange.
- Support auth challenge flows where ABL agents can request additional user authentication (OAuth consent) rendered through AI4W's UI.
- Support cross-environment integration via OAuth2 client-credentials for organizations with separate deployments.

### Non-Goals (Out of Scope)

- Replacing AI4W's existing agent types (`aAAgent`, `gptAgent`, etc.) — `ablAgent` is additive.
- Migrating existing AI4W agent configurations to ABL.
- Building a shared MongoDB or Redis between platforms — each platform maintains its own infrastructure.
- Real-time WebSocket streaming _between ABL and AI4W platforms_ — SSE covers the inter-platform streaming use case. (AI4W's internal Socket.IO delivery to end users is unaffected.)
- ABL invoking AI4W agents (reverse direction) — this feature is AI4W-as-orchestrator, ABL-as-worker only.
- Rendering ABL's full Studio UI within AI4W — AI4W renders markdown and can be extended for specific template types.

---

## 3. User Stories

1. As an **AI4W admin**, I want to configure a connection to an ABL Platform instance so that AI4W users in my account can access ABL agents.
2. As an **AI4W user**, I want to browse available ABL agents and add one to my workspace in one click so that I can start using it immediately without manual credential exchange.
3. As an **AI4W user**, I want to chat with an ABL agent through AI4W's conversation interface and receive responses in real-time (streaming) so that the experience feels native.
4. As an **ABL agent designer**, I want to publish my agent to the `ai4w` channel so that AI4W users can discover and invoke it.
5. As an **AI4W user**, I want to receive and act on human-approval notifications from ABL agents (even when I didn't initiate the conversation) so that agent workflows aren't blocked waiting for my input.
6. As an **AI4W user**, I want to upload files through AI4W that ABL agents can process, and receive files generated by ABL agents, so that document-based workflows work seamlessly.
7. As an **AI4W user**, I want to complete OAuth authorization challenges requested by ABL agents so that agents can access external services on my behalf.
8. As an **ABL admin**, I want to control which agents are visible to AI4W and which AI4W accounts can access them, so that I maintain governance over agent exposure.

---

## 4. Functional Requirements

1. **FR-1**: The system must register `ai4w` as a new channel type in ABL's `CHANNEL_MANIFEST` with `ingress: 'api'`, `delivery: 'async_queue'`, `authMode: 'hmac_jwt'`, and appropriate capability flags (streaming, media, rich output). **Implementation note**: The `authMode` value `'hmac_jwt'` does not exist in the current `AuthMode` type (`'hmac' | 'jwt' | 'token' | 'api_key' | 'sdk_auth' | 'none'`) defined in `apps/runtime/src/channels/types.ts`. The `AuthMode` type must be extended to include `'hmac_jwt'` before registering the manifest entry.
2. **FR-2**: The system must implement an `ai4w` channel adapter in ABL that verifies inbound requests via dual-layer auth: (a) HMAC request signing using ABL-issued `connectionSecret` (authorization — proves the request is from an authorized connection), and (b) AI4W-issued JWT validated against global `AI4W_JWKS_URI` (identity — proves which end-user is sending the message). The `connectionId` is extracted from the URL path, not the request body.
3. **FR-3**: The system must support three response modes for ABL → AI4W message delivery: (a) synchronous HTTP response body, (b) SSE streaming on the open request, (c) async POST to AI4W's registered callback URL.
4. **FR-4**: The system must create and maintain ABL sessions scoped by the composite key `ai4w:{connectionId}:{base64url(userEmail)}:{agentContextId}`, trusting the user identity (email) from AI4W's signed JWT without requiring separate ABL login. Email is base64url-encoded to prevent delimiter collision (RFC 5321 allows colons in quoted local parts). The `connectionId` replaces `ai4wAccountId` in the session key because connections are the unit of access control.
5. **FR-5**: The system must register `ablAgent` as a new agent type in AI4W's `AgentsService` with configuration fields for ABL connection (base URL, connectionId, connectionSecret). AI4W signs each request with HMAC-SHA256 using the connectionSecret and generates a per-request JWT with the end-user's email and accountId.
6. **FR-6**: The system must implement an `ABLGatewayService` in AI4W that sends messages to ABL's chat API, consumes SSE streams, and handles async callback responses.
7. **FR-7**: The system must deliver SSE streaming chunks from ABL to AI4W users in real-time via `liveUpdates.notifyViewers(userId, "answerChunk", ...)` matching the existing `aaAgent` streaming pattern.
8. **FR-8**: The system must support proactive notifications from ABL to AI4W: ABL POSTs human-approval tasks to AI4W's notification endpoint with target user email, and AI4W delivers via `KANotificationService` (push + bell + presence channels).
9. **FR-9**: The system must expose an internal-only **project** discovery API on ABL (`GET /api/internal/v1/tenants/{tenantId}/projects/discoverable`) that returns projects filtered by: (a) tenant-level trust (AI4W `accountId` → ABL `tenantId` mapping), and (b) project-level visibility (only projects where the requesting email is a member). Each project entry includes `id`, `name`, `description`, and `agentCount` (count of active deployments in that project). The endpoint supports stable ordering (`name` ascending, with optional `?sort=recent`) and pagination + search (`?limit`, `?cursor`, `?q`). An analogous tenant endpoint (`GET /api/internal/v1/tenants/by-membership`) returns the list of tenants accessible to the caller's email — also sorted by `name` ascending.
10. **FR-10**: The system must support 1-click **project-level** provisioning: AI4W calls ABL's internal provisioning API with `{tenantId, projectId, connectionName?, environment?, deploymentId?, callbackBaseUrl, responseMode?}` to auto-create a `ChannelConnection` of type `ai4w` bound to a project. `environment` and `deploymentId` are mutually exclusive (matches peer channels; enforced by ABL); if both are omitted the connection is created without a pin and the admin sets one via the ABL channel-customization UI. `connectionName` is optional — when omitted, ABL defaults to `Connection N+1` per project. AI4W registers the returned `connectionId` + `connectionSecret` on the ablAgent record. No `agentId` / `deploymentId` is required at provision time.
11. **FR-11**: The system must support file exchange via signed URLs: AI4W shares signed download URLs for uploaded files in the message payload; ABL's `ai4w` adapter downloads the file and ingests it through the multimodal processing pipeline (new `downloadFromSignedUrl` capability required — see delivery plan 3.2). ABL includes signed download URLs for agent-generated files in responses.
12. **FR-12**: The system must support auth challenge flows: ABL suspends execution with `SuspensionReason: human_input` containing an auth URL, pushes the challenge to AI4W, AI4W renders the challenge UI (OAuth button/link), and the user's completion triggers ABL's callback to resume execution.
13. **FR-13**: The system must deduplicate proactive notifications using a unique `notificationId` with Redis `SET NX` to prevent duplicate delivery on ABL retry.
14. **FR-14**: The system must wrap ABL's outbound HTTP calls to AI4W in the existing Redis-backed circuit breaker (`packages/circuit-breaker/`) scoped per `connectionId` (breaker key: `ai4w:{connectionId}`) at the `tool_service` level (10 failures → open, 30s reset). Per-connection scoping prevents one flaky AI4W callback URL from opening the breaker for all AI4W connections in the tenant.
15. **FR-15**: The system must enforce per-connection rate limiting on both sides: ABL uses existing `HybridRateLimiter` scoped to tenantId (via `getHybridRateLimiter().check()`); AI4W rate-limits the `ABLGatewayService` callback receiver. Additionally, ABL must implement auth failure rate limiting: track consecutive HMAC/JWT failures per source-IP+connectionId pair in Redis (key: `ai4w:auth:fail:{ip}:{connectionId}`), block after 10 failures in 60s for 5 minutes.
16. **FR-16**: The system must use allowlist-based SSRF policy for same-VPC AI4W callback URLs, registering the AI4W callback base URL as a trusted internal endpoint during provisioning.
17. **FR-17**: The system must support cross-environment integration via OAuth2 client-credentials flow, where AI4W provisions an OAuth client in ABL and uses token exchange for each request.
18. **FR-18**: The system must fall back to `KANotificationService.notify()` with `publishTo: ["push", "bell", "presence"]` when an AI4W user has no active WebSocket connection, ensuring offline users receive async ABL responses as push notifications.
19. **FR-19**: (superseded by FR-20) The system originally defined a separate `POST /ping` endpoint. It has been folded into `GET /info` (FR-20), which performs the same auth chain with the same side-effect profile and additionally returns the metadata AI4W needs. The separate ping endpoint no longer exists.
20. **FR-20**: The system must expose `GET /api/v1/channels/ai4w/{connectionId}/info` — a **public** channel endpoint authenticated with the same HMAC + JWT + accountId-binding chain as `/message` (no internal service token required). It executes the full auth chain but performs **no** session resolution, agent execution, trace writes, or tenant-rate-limit consumption. The auth-failure counter still increments on failure. On success it returns: `connectionId`, `channelType`, `status`, `displayName`, `tenantId`, `tenantName`, `projectId`, `projectName`, `agentCount` (live count of active deployments), `config.{callbackBaseUrl, responseMode}`, `pinning.{deploymentId, environment}` (exactly one non-null, or both null for unpinned), and `currentDeployment.{deploymentId, entryAgentName, label, createdAt}` resolved live via the same query path as `DeploymentResolver`. `connectionSecret` is never returned. `goToAppUrl` and `toolCount` are intentionally out of scope — AI4W constructs the app URL client-side. This endpoint serves both the linked-app banner and the "Test & Continue" health-check use cases in a single round-trip.
21. **FR-21**: The system must expose a **deactivate** endpoint (`POST /api/internal/v1/channel-connections/{connectionId}/deactivate`) that sets `status='inactive'` on a project-bound ai4w connection. Inactive connections reject new inbound requests with a uniform 401 (no existence oracle); in-flight sessions drain naturally. The row is retained and may be reactivated through the standard ABL channel-customization UI. Authz: same service-auth + tenant-membership check as provisioning. Scoped to `channelType='ai4w'`.
22. **FR-22**: The system must expose an **unlink** endpoint (`DELETE /api/internal/v1/channel-connections/{connectionId}`) that removes the ai4w connection row. It is intended for AI4W's orphan-reaper job (§12 of the open-items doc). Authz: same as FR-21. Scoped to `channelType='ai4w'`.

---

## 5. Feature Classification & Integration Matrix

### Lifecycle / Platform Impact

| Area                       | Impact Level | Notes                                                                                     |
| -------------------------- | ------------ | ----------------------------------------------------------------------------------------- |
| Project lifecycle          | SECONDARY    | AI4W channel connections are project-scoped in ABL; agent publishing affects project ops. |
| Agent lifecycle            | PRIMARY      | ABL agents become invocable from AI4W; agent discovery and provisioning are core flows.   |
| Customer experience        | PRIMARY      | AI4W end users directly interact with ABL agents through the integration.                 |
| Integrations / channels    | PRIMARY      | New channel type in ABL, new agent type in AI4W — core integration surface.               |
| Observability / tracing    | SECONDARY    | Cross-platform trace propagation, callback tracing, and circuit breaker metrics.          |
| Governance / controls      | SECONDARY    | Tenant-level trust, user-level RBAC for agent discovery, rate limiting.                   |
| Enterprise / compliance    | SECONDARY    | JWT/JWKS auth, encrypted credentials, SSRF protection, proactive notification consent.    |
| Admin / operator workflows | PRIMARY      | Admin provisioning journey, connection management, agent visibility controls.             |

### Related Feature Integration Matrix

| Related Feature                               | Relationship Type | Why It Matters                                                                                   | Key Touchpoints                                                    | Current State                  |
| --------------------------------------------- | ----------------- | ------------------------------------------------------------------------------------------------ | ------------------------------------------------------------------ | ------------------------------ |
| [Channels](channels.md)                       | extends           | AI4W is a new channel type following the manifest-driven architecture.                           | `CHANNEL_MANIFEST`, `ChannelAdapter`, `channel-connections` CRUD   | ABL channels are STABLE        |
| [A2A Integration](a2a-integration.md)         | shares data with  | AI4W channel reuses suspension/resumption, callback registry, and async patterns from A2A infra. | `SuspendedExecution`, `RedisCallbackRegistry`, `ChannelDispatcher` | A2A is BETA                    |
| [Auth Profiles](auth-profiles.md)             | depends on        | JWT/JWKS validation and credential encryption use the shared auth infrastructure.                | `createUnifiedAuthMiddleware`, `encryptionPlugin`                  | Auth Profiles are STABLE       |
| [Circuit Breaker](circuit-breaker.md)         | depends on        | Outbound AI4W delivery uses Redis-backed circuit breaker for resilience.                         | `RedisCircuitBreaker`, `tool_service` level config                 | Circuit Breaker is ALPHA       |
| [Webhook System](webhook-system.md)           | shares data with  | Async callback delivery reuses webhook-delivery BullMQ queue and HMAC signing.                   | `webhook-delivery` queue, `buildSignatureHeaders`                  | Webhook System is ALPHA        |
| [Rate Limiting](rate-limiting.md)             | depends on        | Per-connection rate limiting uses `HybridRateLimiter` infrastructure.                            | `HybridRateLimiter`, tenant rate config                            | Rate Limiting is STABLE        |
| [Proactive Messaging](proactive-messaging.md) | extends           | Proactive AI4W notifications leverage the planned proactive messaging pipeline.                  | `ChannelDispatcher`, proactive delivery mode                       | Proactive Messaging is PLANNED |

---

## 6. Design Considerations

### AI4W Conversation Flow

```
AI4W User → AI4W Client (Web/Mobile) → KoreServer
  → KoraConversationService routes to ablAgent
  → ABLGatewayService: generate JWT (email+accountId), HMAC-sign request
  → HTTP POST /api/v1/channels/ai4w/{connectionId}/message
  → ABL Runtime: check auth rate limit → lookup connection by connectionId
    → verify HMAC (nonce + timestamp + body) → verify JWT (global JWKS)
    → enforce accountId binding → rate limit → session resolve → execute agent
  → Response via: sync body | SSE stream | async callback
  → AI4W: liveUpdates.notifyViewers() → Socket.IO → User
```

### Proactive Notification Flow (Human Approval)

```
ABL Agent suspends (human_approval)
  → ChannelDispatcher routes to ai4w adapter
  → ai4w adapter POSTs to AI4W notification endpoint
    (target: user email, payload: approval task + callbackId)
  → AI4W KANotificationService delivers (push + bell + presence)
  → User acts on approval in AI4W UI
  → AI4W POSTs result to ABL callback endpoint
  → ABL ResumptionService resumes execution
  → Result delivered async to AI4W
```

### 1-Click Discovery Flow (revised — project-level)

```
AI4W User → AI4W Browse Projects UI (V2 autonomous-agent builder)
  → ABLGatewayService.discoverProjects() → GET /api/internal/v1/tenants/{tenantId}/projects/discoverable
    (JWT with accountId + email for RBAC filtering; ?limit/?cursor/?q for paginated browse)
  → ABL returns filtered project list: [{id, name, description, agentCount}, ...]
  → User clicks "Link"
  → ABLGatewayService.provisionConnection()
    → POST /api/internal/v1/channel-connections/provision
      body: { tenantId, projectId, connectionName?, environment?, deploymentId?, callbackBaseUrl, responseMode? }
    → ABL creates ChannelConnection (type: ai4w, agentId: null)
    → Returns { connectionId, connectionSecret } (secret shown once)
  → AI4W stores connectionId + connectionSecret on the ablAgent record
  → (optional) AI4W calls GET /connections/{connectionId}/info to render linked-app banner
  → Agent immediately usable; admin can later change environment/deploymentId via ABL channel-customization UI
```

---

## 7. Technical Considerations

### Why a Custom Channel (Not Existing aaAgent + ABL Chat API)

ABL already exposes `/api/v1/chat/agent` (sync) and `http_async` (async with callbacks). AI4W's `aaAgent` could call these endpoints today with zero code changes on either side. However, a dedicated `ai4w` channel is justified because:

1. **UX simplification**: ABL's current API & webhook channel setup in Studio is disconnected and complex. A dedicated `ai4w` channel provides a streamlined provisioning UX (browse agents, 1-click add) that hides the underlying protocol details from end users.
2. **Protocol abstraction**: A dedicated channel gives us flexibility to change the underlying protocol between AI4W and ABL at any time without affecting user configuration. The channel adapter is the abstraction boundary.
3. **User-identity trust**: Existing API/webhook channels are tenant-scoped via API keys. The `ai4w` channel enables user-scoped sessions via JWT email claims — critical for per-user session isolation and proactive notifications.
4. **Platform convergence**: AI4W and ABL may eventually merge components. A dedicated integration surface provides a clean seam for that convergence.
5. **Proactive delivery**: Existing channels cannot push human-approval notifications to specific users on AI4W. The `ai4w` adapter enables targeted proactive delivery.

### Protocol Decision: Custom HTTP REST (not A2A JSON-RPC)

ABL already has a full A2A implementation as a separate channel type. For the AI4W integration, we use custom HTTP REST because:

- AI4W's existing patterns (`RequestAgent`, `makeRequest`, `executeApi`) are HTTP-based, not JSON-RPC.
- A2A JSON-RPC would require AI4W to implement a full A2A client (task state machine, JSON-RPC parsing, SSE event protocol).
- Custom HTTP REST is simpler for P0 and matches AI4W's existing `aaAgent` integration style.
- A2A can be layered later if cross-organization interop becomes a requirement.

### Session Ownership Model

AI4W orchestrates agents across multiple platforms (ABL, external APIs, internal bots), so it maintains its own conversation history as the orchestration-layer source of truth. ABL maintains its own session for agent execution context (tool state, memory, multi-agent state). This dual-session model is intentional:

- **AI4W is the orchestration source of truth**: Stores the full conversation across all agents (ABL, gptAgent, dataAgent, etc.). This is what the end user sees.
- **ABL is the execution source of truth**: Stores agent-specific execution context, traces, and tool state. This is what the agent designer debugs.
- **History handoff**: On each AI4W → ABL request, AI4W includes recent conversation history in the payload (via `additionalArgs.conversationHistory`, matching the existing `aaAgent` pattern). ABL uses this for agent context continuity without requiring persistent cross-platform session sync.
- **No cross-platform session sync**: Sessions are not synchronized. If a user accesses the same agent directly via ABL Studio, they get a separate session. This is acceptable — the integration is AI4W-centric.

### Session Key Design

Session key (external session key): `ai4w:{connectionId}:{base64url(userEmail)}:{agentContextId}` where `agentContextId` is an opaque string from AI4W (board ID, session ID, or conversation thread). Email is base64url-encoded to prevent delimiter collision (RFC 5321 allows colons in quoted local parts). The `connectionId` replaces `ai4wAccountId` because connections are the unit of access control. This prevents:

- Cross-connection session collision (different connections cannot share sessions)
- Cross-user session collision (different users in same connection)
- Cross-conversation session collision (same user, different conversations)

### SSRF Policy for Same-VPC

ABL's default SSRF policy blocks private IP ranges. For same-VPC AI4W deployments, the `ai4w` channel uses an allowlist-based policy:

- During provisioning, the AI4W callback base URL is registered as a trusted internal endpoint.
- Only callback URLs matching the registered base URL prefix are allowed.
- All other URLs go through the default SSRF blocklist.

### Internal-Only API Security (P4)

The discovery and provisioning APIs (`/api/internal/v1/...`) simplify UX for the browse-and-add flow. Security enforcement options (to be finalized in HLD):

- **Separate port** (preferred): Mount internal routes on a dedicated Express app (e.g., `:3113`) not exposed via Kubernetes ingress. Standard pattern for service-to-service APIs.
- **Service-to-service token**: The user JWT proves identity (for RBAC filtering), but a separate service token (mTLS or shared secret) proves the request originates from a trusted AI4W instance. Provisioning requires both.
- **Discovery is read-only**: Filtered by user RBAC — lower risk. Can use user JWT alone.
- **Provisioning is a write operation**: Creates `ChannelConnection` records — requires elevated auth (service token + user JWT).

### Response Mode Negotiation

AI4W sends `X-Response-Mode: sync | stream | async`. ABL responds with `X-Response-Mode-Used` indicating the actual mode used. Fallback order when the requested mode is unavailable:

- `stream` requested but agent doesn't support streaming → falls back to `sync`
- `async` requested but agent completes instantly → returns sync response with `X-Response-Mode-Used: sync`
- Header missing → defaults to connection-level `responseMode` config, or `sync` if unset

### File Ingestion Timing

ABL must download files from AI4W signed URLs at **message ingestion time** (when the request arrives), not at execution time. This prevents signed URL expiry during queued/async processing. AI4W should set signed URL expiry to match ABL's session timeout value (configurable per project, default 24h) to provide sufficient margin.

### Proactive Notification Error Contract

When ABL pushes a notification to AI4W, AI4W's notification endpoint must return structured error codes:

- `200 OK` — notification accepted and will be delivered
- `404 Not Found` — target email not found in AI4W account. ABL logs the failure and falls back: AI4W should attempt email channel delivery as a last resort.
- `409 Conflict` — duplicate `notificationId` (already delivered)
- `410 Gone` — user has deactivated/left the AI4W account. ABL deactivates the proactive notification path for this user.
- `429 Too Many Requests` — AI4W rate-limiting the notification endpoint. ABL retries with backoff.

### Deployment Order

1. **ABL first** (passive) — exposes endpoints, no behavior change until configured.
2. **AI4W second** (active) — starts calling ABL. Integration activates only when both sides are configured.
3. Rolling deployment safe — purely additive on both platforms.

---

## 8. How to Consume

### Studio UI

- **Channel Catalog**: New `ai4w` entry in `apps/studio/src/components/deployments/channels/channel-registry.tsx` with streamlined create form (display name + callback URL + deployment selector). No JWKS URL or account ID fields — JWKS is global env var, accountId is auto-backfilled from first runtime JWT.
- **Post-Creation Credential Reveal**: After creation, shows ABL endpoint + connectionId + connectionSecret using the SDK `hosted_exchange` pattern (shown once, never retrievable again).
- **Connection List View**: Table with columns: Name, Status, Deployment, Last Active (relative time since last successful request, e.g., "3 min ago"), Source (shows "Manual" vs "API" based on `provisionedBy`). Supports filtering by status.
- **Connection Detail Tabs**: Overview (status, endpoint, connectionId, connection health/diagnostics: last successful request timestamp, error rate last 24h, auth block status indicator), Configuration (name, callback URL with inline SSRF validation error: "Callback URL must be a publicly routable address. Private/internal IP ranges are not allowed." shown below the input field on validation failure, response mode), Deployment (pin version), Security (key rotation with confirmation dialog, secret reveal). The Security tab must integrate with Studio's existing `TAB_DEFINITIONS` framework for consistent tab navigation.
- **Secret Rotation Confirmation**: Dialog: "Are you sure? This will immediately invalidate the current secret. Any integration using the old secret will stop working." with Confirm/Cancel buttons.
- **Deactivation Confirmation**: Dialog: "This will reject all incoming requests. You can reactivate later." with Deactivate/Cancel buttons.
- **Deletion Confirmation**: Dialog: "This will permanently remove the connection and all associated session data. This cannot be undone." with Delete/Cancel buttons (Delete button uses destructive styling).
- **Channel Connection Management**: Standard channel connection CRUD at project level — create, configure, activate/deactivate, delete.
- **Agent Publishing**: Agents become available to AI4W when a `ai4w` channel connection is active on a deployment.

### API (Runtime)

| Method | Path                                                             | Purpose                                                                                                                                                                               |
| ------ | ---------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| POST   | `/api/v1/channels/ai4w/{connectionId}/message`                   | Inbound message from AI4W (sync, SSE, or async response) — HMAC + JWT                                                                                                                 |
| GET    | `/api/v1/channels/ai4w/{connectionId}/info`                      | Connection meta + pinning + live currentDeployment (FR-20). HMAC + JWT. Doubles as health check. Replaces both the former internal `/connections/{id}/info` and the separate `/ping`. |
| GET    | `/api/internal/v1/tenants/by-membership?email={email}`           | Discover tenants accessible by email; sorted by `name` ascending (internal-only)                                                                                                      |
| GET    | `/api/internal/v1/tenants/{tenantId}/projects/discoverable`      | Project discovery — replaces legacy agent discovery; paginated + searchable (FR-9)                                                                                                    |
| POST   | `/api/internal/v1/channel-connections/provision`                 | Project-level provisioning (connectionName optional, env/deployment optional) (FR-10)                                                                                                 |
| POST   | `/api/internal/v1/channel-connections/{connectionId}/deactivate` | Soft-disable an ai4w connection (reversible via ABL UI) (FR-21)                                                                                                                       |
| DELETE | `/api/internal/v1/channel-connections/{connectionId}`            | Hard-remove an ai4w connection (for AI4W orphan reaper) (FR-22)                                                                                                                       |
| POST   | `/api/v1/callbacks/:callbackId`                                  | Callback receiver for async results (existing)                                                                                                                                        |

**Removed in this revision**:

- `GET /api/internal/v1/tenants/{tenantId}/agents/discoverable` — superseded by `/projects/discoverable`.
- `GET /api/internal/v1/connections/{connectionId}/info` — moved to the public channel namespace at `GET /api/v1/channels/ai4w/{connectionId}/info` so callers that hold the connection credentials don't need the internal service token.
- `POST /api/v1/channels/ai4w/{connectionId}/ping` — folded into `/info`, which does the same auth chain plus returns the metadata AI4W needs for the "Test & Continue" and linked-app-banner flows.

### API (Studio)

| Method | Path                                                     | Purpose                                   |
| ------ | -------------------------------------------------------- | ----------------------------------------- |
| GET    | `/api/projects/:projectId/channel-connections?type=ai4w` | List AI4W channel connections             |
| POST   | `/api/projects/:projectId/channel-connections`           | Create AI4W channel connection (existing) |

### Admin Portal

- Tenant-level configuration for allowed AI4W account IDs (trust establishment).
- Monitoring dashboard for AI4W channel health (circuit breaker state, delivery success rate).

### Channel / SDK / Voice / A2A / MCP Integration

- AI4W is a **channel integration** — it follows the same manifest-driven pattern as Slack, Teams, and other messaging channels.
- AI4W channel does NOT interact with SDK, Voice, or MCP surfaces directly. Agent execution uses the standard runtime pipeline regardless of channel.
- A2A protocol is used for the separate `a2a` channel type; AI4W uses custom HTTP REST as described in §7.

---

## 9. Data Model

### Collections / Tables

#### ABL Platform

```text
Collection: channel_connections (existing — new documents with channelType: 'ai4w')
Fields:
  - _id: ObjectId (internal, never exposed externally)
  - connectionId: string (required, unique — public identifier in URL path)
    Format: 'ai4w_c_' + crypto.randomBytes(16).toString('hex')
    Example: 'ai4w_c_7f3a9b2e4d1c8f5a6b0e3d2c1a9f8e7d'
  - tenantId: string (required, indexed)
  - projectId: string (required, indexed)
  - channelType: 'ai4w'
  - externalIdentifier: string (auto-generated UUID, not used for lookup)
  - displayName: string (e.g., 'AI4W Production')
  - agentId: null (always null for ai4w — project is the binding)
  - deploymentId: string | null (deployment-pinned routing; set by channel-customization UI)
  - environment: string | null (e.g., 'production'; mutually exclusive with deploymentId)
    Note: `agentId` is always null for ai4w connections. Runtime dispatch resolves the
    live deployment via the shared `DeploymentResolver` pipeline using `deploymentId`
    or `environment` at message time (same pattern as Genesys / VXML / Audiocodes).
    If both are null, the resolver falls back to dev-mode working copy.
  - status: 'active' | 'inactive'
  - encryptedCredentials: string (AES-256-GCM encrypted { connectionSecret })
    Secret format: 'abl_cs_' + base64url(crypto.randomBytes(32))
    ABL generates, shown once, never retrievable again
  - config:
    - callbackBaseUrl: string (required — AI4W's callback endpoint base URL, SSRF validated)
    - notificationUrl: string (optional — AI4W's proactive notification endpoint, P3)
    - responseMode: 'sync' | 'stream' | 'async' (default preference)
    - ai4wAccountId: string (null — backfilled from JWT on first request, enforced after)
    - provisionedBy: 'manual' | 'api' (how this connection was created)
    - lastUsedAt: Date (updated periodically, sampled)
  - createdBy: string
  - createdAt: Date
  - updatedAt: Date
Indexes:
  - { connectionId: 1 } (unique, partial filter: { connectionId: { $type: 'string' } })
    Note: Partial filter expression required because not all channel connections
    have a connectionId — only ai4w connections use this field. Standard sparse
    index is insufficient; use partial filter for correctness.
  - { tenantId: 1, projectId: 1, channelType: 1 }

Implementation notes (existing model changes required):
  - The `connectionId` field must be added to the `IChannelConnection` interface
    and Mongoose schema in `channel-connection.model.ts`. This is a new field —
    existing channel connection types do not have it.
  - The `'ai4w'` value must be added to the `CHANNEL_CONNECTION_TYPES` array in
    `channel-connection.model.ts` (currently defined around L14-36). Without this,
    Mongoose validation will reject documents with `channelType: 'ai4w'`.
  - A dedicated `resolveConnectionByConnectionId` function is needed in the
    channel connection service layer. The existing `resolveConnectionByIdInternal`
    queries by `_id` (MongoDB ObjectId), not by the public `connectionId` string.
    This new resolver must look up by `{ connectionId, tenantId }`, decrypt
    credentials, and return the full connection document. Alternatively, the
    ai4w adapter's auth flow must include an explicit credential decryption step
    after the connectionId-based lookup.
```

```text
Collection: sessions (existing — new sessions with ai4w channel binding)
Fields:
  - externalSessionKey: 'ai4w:{connectionId}:{base64url(userEmail)}:{agentContextId}'
  - channelType: 'ai4w'
  - channelBinding: { connectionId, userEmail, agentContextId }
Indexes:
  - { tenantId: 1, externalSessionKey: 1 } (existing, covers ai4w sessions)
```

#### AI4W (KoreServer)

```text
Collection: agents (existing — new ablAgent type documents)
Fields:
  - type: 'ablAgent'
  - config.ablConfig:
    - ablBaseUrl: string (required — ABL runtime base URL, e.g., 'https://runtime.abl.com/api/v1/channels/ai4w')
    - connectionId: string (required — ABL-generated connectionId)
    - connectionSecret: string (encrypted — ABL-generated secret for HMAC signing)
    - responseMode: 'sync' | 'stream' | 'async'
    Note: projectId, agentName, deploymentId are NOT stored — ABL resolves them from the connection.
    AI4W signs each request: HMAC-SHA256(connectionSecret, requestId + "." + timestamp + "." + body)
    AI4W generates a per-request JWT with end-user email + accountId.
```

```text
Collection: abl_connections (new — account-level ABL platform trust)
Fields:
  - _id: string
  - accountId: string (required, indexed — AI4W account ID)
  - ablTenantId: string (required — ABL tenant identifier)
  - ablBaseUrl: string (required)
  - jwksUri: string (AI4W's JWKS endpoint for ABL to verify)
  - callbackBaseUrl: string (AI4W's callback endpoint)
  - notificationUrl: string (AI4W's notification endpoint)
  - status: 'active' | 'inactive'
  - createdBy: string
  - createdAt: Date
Indexes:
  - { accountId: 1 } (unique)
  - { ablTenantId: 1 }
```

### Key Relationships

- `channel_connections.connectionId` → `agents.config.ablConfig.connectionId` (AI4W agent → ABL connection, via public connectionId not MongoDB \_id)
- `channel_connections.config.ai4wAccountId` → `abl_connections.accountId` (cross-platform link, backfilled at runtime)
- `sessions.channelBinding.connectionId` → `channel_connections.connectionId` (session → connection)

---

## 10. Key Implementation Files

### Domain / Core Logic

| File                                                                   | Purpose                                                                               |
| ---------------------------------------------------------------------- | ------------------------------------------------------------------------------------- |
| `apps/runtime/src/channels/manifest.ts`                                | Add `ai4w` entry to `CHANNEL_MANIFEST`                                                |
| `apps/runtime/src/channels/adapters/ai4w-adapter.ts` (new)             | AI4W channel adapter: verify, parse, send, transform                                  |
| `apps/runtime/src/channels/adapters/ai4w-auth.ts` (new)                | HMAC verification, JWT/JWKS validation, accountId binding, auth failure rate limiting |
| `apps/runtime/src/channels/adapters/ai4w-content-transformer.ts` (new) | RichContentIR → AI4W template format transformation                                   |
| `KoreServer/services/ABLGatewayService/index.js` (new)                 | AI4W gateway: connection management, HTTP client, callback handler                    |
| `KoreServer/services/ABLGatewayService/client.js` (new)                | Outbound HTTP client: sync, SSE, async modes                                          |
| `KoreServer/services/ABLGatewayService/callbackHandler.js` (new)       | Inbound callback receiver: async responses, proactive notifications                   |
| `KoreServer/services/ABLGatewayService/authManager.js` (new)           | JWT signing, JWKS publication, credential management                                  |
| `KoreServer/services/ABLGatewayService/agentDiscovery.js` (new)        | Browse ABL agents, cache agent metadata                                               |
| `KoreServer/api/services/AgentsService/ablAgents.js` (new)             | ABL agent type: start conversation, follow-up, streaming, async                       |

### Routes / Handlers

| File                                                  | Purpose                                                 |
| ----------------------------------------------------- | ------------------------------------------------------- |
| `apps/runtime/src/routes/ai4w-channel.ts` (new)       | ABL inbound routes for AI4W messages                    |
| `apps/runtime/src/routes/internal-discovery.ts` (new) | Internal-only agent discovery and provisioning API      |
| `KoreServer/api/rest/ABLGateway.rest.js` (new)        | AI4W REST endpoints for ABL callbacks and notifications |

### UI Components

| File                                                                    | Purpose                              |
| ----------------------------------------------------------------------- | ------------------------------------ |
| `apps/studio/src/components/deployments/channels/channel-registry.tsx`  | Add `ai4w` channel to Studio catalog |
| `apps/studio/src/components/deployments/channels/ai4w/` (new directory) | AI4W connection setup wizard         |

### Jobs / Workers / Background Processes

| File                                                    | Purpose                                                     |
| ------------------------------------------------------- | ----------------------------------------------------------- |
| `apps/runtime/src/services/queues/delivery-worker.ts`   | Existing — handles async delivery to AI4W callback URLs     |
| `apps/runtime/src/services/queues/resumption-worker.ts` | Existing — resumes suspended executions after AI4W callback |

### Tests

| File                                                          | Type        | Coverage Focus                                           |
| ------------------------------------------------------------- | ----------- | -------------------------------------------------------- |
| `apps/runtime/src/__tests__/ai4w-channel.e2e.test.ts` (new)   | e2e         | Full message round-trip: AI4W → ABL → response           |
| `apps/runtime/src/__tests__/ai4w-auth.test.ts` (new)          | integration | JWT/JWKS verification, invalid tokens, expired tokens    |
| `apps/runtime/src/__tests__/ai4w-proactive.e2e.test.ts` (new) | e2e         | Proactive notification delivery, dedup, offline fallback |
| `apps/runtime/src/__tests__/ai4w-discovery.e2e.test.ts` (new) | e2e         | Agent discovery filtering, 1-click provisioning          |
| `apps/runtime/src/__tests__/ai4w-streaming.e2e.test.ts` (new) | e2e         | SSE streaming end-to-end, chunk delivery                 |

---

## 11. Configuration

### Environment Variables

| Variable                              | Default                          | Description                                                                                                                                               |
| ------------------------------------- | -------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `AI4W_CHANNEL_ENABLED`                | `false`                          | Enable ai4w channel (route mounting + adapter registration)                                                                                               |
| `AI4W_JWKS_URI`                       | `https://work.kore.ai/oidc/jwks` | Global JWKS endpoint for JWT validation                                                                                                                   |
| `AI4W_INTERNAL_API_ENABLED`           | `false`                          | Enable discovery + provisioning APIs (P4)                                                                                                                 |
| `AI4W_HMAC_TIMESTAMP_TOLERANCE_MS`    | `30000`                          | Max age of X-Timestamp (±30 seconds)                                                                                                                      |
| `AI4W_MAX_SSE_CONNECTIONS_PER_TENANT` | `50`                             | Concurrent SSE connections per tenant                                                                                                                     |
| `AI4W_CALLBACK_TIMEOUT_MS`            | `30000`                          | Outbound HTTP timeout for async/proactive delivery                                                                                                        |
| `AI4W_TRUSTED_CALLBACK_CIDRS`         | (empty)                          | Allowlist for private-range callback URLs (same-VPC). Validated on startup: reject overly broad ranges (/0, /8), log warning for ranges broader than /16. |
| `AI4W_JWT_ISSUER`                     | `https://work.kore.ai`           | Expected JWT issuer claim — passed to `jwtVerify` `issuer` option                                                                                         |
| `AI4W_JWT_AUDIENCE`                   | `urn:kore:agentic`               | Expected JWT `aud` claim — passed to `jwtVerify` `audience` option                                                                                        |
| `AI4W_AUTH_BLOCK_THRESHOLD`           | `10`                             | Consecutive auth failures before blocking connectionId                                                                                                    |
| `AI4W_AUTH_BLOCK_DURATION_MS`         | `300000`                         | Block duration after threshold (5 minutes)                                                                                                                |
| `AI4W_CIRCUIT_BREAKER_LEVEL`          | `tool_service`                   | Circuit breaker preset level for AI4W outbound calls                                                                                                      |

### Runtime Configuration

- **Tenant-level**: `tenantConfig.channels.ai4w.enabled` — enable/disable AI4W channel per tenant.
- **Tenant-level**: `tenantConfig.channels.ai4w.trustedAccounts` — list of allowed AI4W account IDs for this tenant.
- **Connection-level**: Response mode preference (`sync` | `stream` | `async`) — per channel connection.
- **Connection-level**: Proactive notification opt-in — whether ABL can push notifications to AI4W users.

### DSL / Agent IR / Schema

N/A — AI4W channel connections are managed through CRUD API, not the agent DSL. Agent designers do not need DSL changes to publish agents to AI4W.

---

## 12. Non-Functional Concerns

### Isolation & Multitenancy

| Concern                | Requirement / Expectation                                                                                                                                                                                                                     |
| ---------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Project isolation      | AI4W channel connections are project-scoped. Agent discovery filters by project. Cross-project access returns 404.                                                                                                                            |
| Tenant isolation       | Every query includes `tenantId`. AI4W `accountId` maps to exactly one ABL `tenantId`. Cross-tenant access returns 404.                                                                                                                        |
| User isolation         | Session key includes `connectionId:userEmail`. One user cannot access another user's sessions even within the same connection. Cross-user access returns 404.                                                                                 |
| Connection isolation   | `connectionId` in the session key prevents cross-connection session collision. JWT-connection binding (`config.ai4wAccountId`) prevents stolen secret + wrong-account JWT from accessing the connection.                                      |
| AI4W account isolation | AI4W `ablAgent` configurations are scoped to `accountId`. One AI4W account cannot invoke ABL agents provisioned for a different account. AI4W must validate `accountId` from the authenticated session before routing to `ABLGatewayService`. |

### Security & Compliance

- **Authentication**: Dual-layer auth — HMAC request signing with ABL-issued `connectionSecret` (authorization) + AI4W-issued JWT validated against global `AI4W_JWKS_URI` (identity). Analogous to how `msteams-auth.ts` verifies Bot Framework tokens, but adds HMAC for payload integrity. Cross-env uses OAuth2 client-credentials (P6).
- **HMAC signing**: `HMAC-SHA256(connectionSecret, direction + ":" + nonce + "." + timestamp + "." + rawBody)` where `direction` is `inbound` for AI4W→ABL requests and `outbound` for ABL→AI4W callbacks/notifications. The direction prefix prevents replay of inbound requests as outbound callbacks (and vice versa). The nonce travels in the dedicated `X-Signature-Nonce` UUID header (NOT `X-Request-Id` — tracing-namespace headers are routinely rewritten by ingress-nginx, service meshes, and APIMs, which would silently break verification). Replay protection via Redis SET, 60s TTL, and ±30s timestamp window. Raw body preserved via `express.json({ verify })` for stable HMAC input.
- **JWT-connection binding**: First request backfills `config.ai4wAccountId` from JWT's `accountId` claim. Subsequent requests enforce `jwt.accountId === connection.config.ai4wAccountId` — prevents stolen secret + wrong-account JWT.
- **Credential storage**: ABL generates `connectionSecret` (`crypto.randomBytes(32)`), stores AES-256-GCM encrypted in `encryptedCredentials`. Shown once after creation (SDK `hosted_exchange` pattern), never retrievable again. Hard cut on rotation (no grace period).
- **SSRF protection**: Callback URLs validated on create + update + delivery. Block private IP ranges (RFC 1918, link-local, loopback). Override: `AI4W_TRUSTED_CALLBACK_CIDRS` for same-VPC. DNS re-validated at delivery time. **DNS rebinding mitigation**: At delivery time, resolve DNS explicitly, validate the resolved IP against the blocklist, and connect to the validated IP (not the hostname). This prevents TOCTOU attacks where DNS resolves to a public IP at validation time but to a private IP at connection time.
- **JWT claims**: Short-lived tokens (5-minute expiry). Claims: `sub` (AI4W userId), `email`, `accountId`, `iss`, `aud`, `iat`, `exp`. ABL uses `email` (session scoping) and `accountId` (connection binding). No PII beyond email. **Issuer / audience validation**: JWT verification passes explicit `issuer` + `audience` options to `jwtVerify`, configurable via `AI4W_JWT_ISSUER` / `AI4W_JWT_AUDIENCE` env vars (defaults `https://work.kore.ai` / `urn:kore:agentic`). Rejecting tokens from unexpected issuers or audiences prevents token confusion attacks.
- **Auth failure rate limiting**: Redis counter per source-IP+connectionId pair (key: `ai4w:auth:fail:{ip}:{connectionId}`), block after 10 failures in 60s for 5 minutes. Per-IP scoping prevents a single attacker from locking out a legitimate connection for all callers. All auth failures (HMAC, JWT, blocked, not found) return identical 401 — no existence oracle.
- **Outbound auth**: ABL signs async callbacks and proactive notifications with the same `connectionSecret` (symmetric bidirectional HMAC).
- **Notification dedup**: Redis `SET NX` with unique `notificationId` prevents duplicate proactive notifications on retry.
- **Timing side-channel mitigation**: On the connection-not-found path, perform a synthetic HMAC computation (with a dummy key) before returning 401. This ensures the response time is indistinguishable from a valid-connection-but-wrong-secret path, preventing attackers from using timing differences to enumerate valid connectionIds.
- **Uniform error responses**: All auth failures return `{ success: false, error: { code: 'UNAUTHORIZED', message: 'Authentication failed' } }` — never reveal which layer failed or whether a connectionId exists.
- **Audit logging**: Security-sensitive operations emit audit events: connection lifecycle (created, rotated, deactivated, deleted), callback URL changes, auth failures, auth blocks, accountId binding.

### Performance & Scalability

- **Sync latency target**: Sub-3s for non-reasoning agents, up to 30s for complex agents (matching ABL's existing chat API).
- **SSE time-to-first-byte**: Under 1s for streaming responses.
- **Rate limiting**: ABL's existing tenant-scoped rate limiter applies to AI4W traffic. Default: 100 req/min per tenant. AI4W requests count against the ABL tenant quota.
- **Circuit breaker**: Redis-backed circuit breaker on ABL outbound calls to AI4W, scoped per `connectionId` (`ai4w:{connectionId}`). `tool_service` level: 10 failures → open, 30s reset, 1 half-open probe. Per-connection scoping isolates failures.
- **Connection caching**: AI4W's `ABLGatewayService` caches ABL connection metadata (endpoints, credentials) with 5-minute TTL.
- **JWKS caching**: JWKS keys cached with 5-minute TTL to avoid per-request key fetch. **JWKS as single point of compromise (accepted risk)**: If the JWKS endpoint is compromised, an attacker can inject signing keys. Mitigations: short cache TTL (5 min) limits exposure window, monitoring for JWKS fetch failures (alert on consecutive 5xx or DNS failures), and a circuit breaker on the JWKS endpoint (fail closed — reject JWTs when JWKS is unreachable rather than using stale keys indefinitely).

### Reliability & Failure Modes

| Failure Mode                     | Handling                                                                                                                                      |
| -------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------- |
| AI4W unreachable                 | Circuit breaker opens after 10 failures. New deliveries fast-fail. Async results stored in `PendingDeliveryStore` (24h TTL) for later pickup. |
| ABL unreachable                  | AI4W `ABLGatewayService` retries once on 502/503/504 with 2s delay. On failure, returns error to user via `liveUpdates`.                      |
| JWT validation failure           | Returns 401 immediately. No retry. AI4W must re-authenticate.                                                                                 |
| Async callback lost              | ABL's `webhook-delivery` queue retries 5 times with exponential backoff (3s, 6s, 12s, 24s, 48s). Terminal failure logged.                     |
| Proactive notification duplicate | Redis `SET NX` on `notificationId` — idempotent. Duplicates silently dropped.                                                                 |
| SSE stream disconnection         | ABL detects broken pipe, marks execution for async delivery. Final result delivered via callback URL.                                         |
| Human approval timeout           | ABL's `suspension-timeout-worker` expires the suspension after configurable timeout (default: 10 minutes). Timeout notification sent to AI4W. |

### Observability

- **Trace propagation**: AI4W includes `traceparent` header (W3C Trace Context) in requests to ABL. ABL logs the trace ID for cross-platform correlation.
- **ABL trace events**: `ai4w.inbound`, `ai4w.delivery.sync`, `ai4w.delivery.stream`, `ai4w.delivery.async`, `ai4w.delivery.proactive`, `ai4w.callback.received` events emitted via `TraceStore`.
- **Circuit breaker metrics**: State transitions (`closed→open`, `open→half_open`, `half_open→closed`) logged and metered.
- **AI4W analytics**: `ABLGatewayService` emits analytics events (`ablAgent.startConversation`, `ablAgent.streamingChunk`, `ablAgent.asyncResponse`, `ablAgent.proactiveNotification`) for AI4W's analytics pipeline.

### Data Lifecycle

- **Sessions**: Follow ABL's existing session TTL policy (configurable per project, default 24h inactive expiry).
- **Callback registrations**: Redis keys with TTL matching suspension timeout (default 10 minutes).
- **Pending deliveries**: Redis LIST with 24h TTL, cleaned up after successful delivery.
- **JWKS cache**: 5-minute TTL, automatically refreshed.
- **Connection metadata cache**: 5-minute TTL in AI4W's `ABLGatewayService`.
- **Proactive notification dedup keys**: Redis keys with 1h TTL (covers retry window).

---

## 13. Delivery Plan / Work Breakdown

1. **P0: Foundation (Sync Messaging + Auth)**
   1.1 Add `ai4w` entry to `CHANNEL_MANIFEST` in `manifest.ts`
   1.2 Implement `ai4w-adapter.ts` with `verifyRequest`, `parseIncoming`, `sendResponse` (sync mode)
   1.3 Implement `ai4w-auth.ts` with HMAC verification, JWT/JWKS validation, accountId binding, auth failure rate limiting, replay protection (nonce + timestamp)
   1.4 Create `ai4w-channel.ts` route handler (`POST /api/v1/channels/ai4w/{connectionId}/message`) with raw body preservation
   1.5 Add `ai4w` to Studio channel catalog (`channel-registry.tsx`) with streamlined create form (name + callback URL + deployment), post-creation credential reveal (endpoint + connectionId + secret), Security tab (key rotation with hard cut)
   1.6 Implement session resolution with session key `ai4w:{connectionId}:{base64url(email)}:{agentContextId}`
   1.7 Add `connectionId` field to ChannelConnection model with unique partial index, `externalIdentifier` auto-generation. **Required wiring**: Add `'ai4w'` to the `CHANNEL_CONNECTION_TYPES` array in `channel-connection.model.ts` — without this, Mongoose schema validation rejects ai4w documents.
   1.8 Create `ablAgents.js` in AI4W `AgentsService` with sync invocation + HMAC signing
   1.9 Create `ABLGatewayService/client.js` with sync HTTP client + per-request JWT generation
   1.10 Wire `KoraConversationService` routing for `ablAgent` type
   1.11 E2E tests: sync message round-trip, HMAC + JWT auth verification, accountId binding, replay protection, session isolation, uniform 401 responses
   **P0 Exit**: Sync message round-trip E2E test passes with dual-auth (HMAC + JWT), accountId binding, and session isolation verified on both platforms.

2. **P1: Streaming + Async**
   2.1 Implement SSE streaming in `ai4w-adapter.ts` (ABL → AI4W)
   2.2 Implement SSE consumer in `ABLGatewayService/client.js`
   2.3 Wire streaming chunks to `liveUpdates.notifyViewers` in AI4W
   2.4 Implement async callback mode in `ai4w-adapter.ts` (POST to callback URL)
   2.5 Create `ABLGatewayService/callbackHandler.js` for async response reception
   2.6 Wire async responses to Redis `botMessage` channel in AI4W
   2.7 Add `X-Response-Mode` header negotiation
   2.8 E2E tests: streaming chunk delivery, async callback round-trip
   **P1 Exit**: SSE streaming E2E delivers chunks to AI4W. Async callback round-trip completes with HMAC verification.

3. **P2: Rich Content + Files**
   3.1 Implement `ai4w-content-transformer.ts` for `RichContentIR` (from `packages/compiler/src/platform/ir/schema.ts`) → markdown + structured templates
   3.2 Implement signed URL file ingestion in `ai4w-adapter.ts` (new `downloadFromSignedUrl` method — downloads file from AI4W signed URL and ingests via multimodal processing pipeline)
   3.3 Implement signed URL file output in ABL response payload
   3.4 Wire file handling in `ABLGatewayService` (download from ABL signed URLs, upload to AI4W FileDB)
   3.5 E2E tests: file upload round-trip, rich content rendering
   **P2 Exit**: File upload via signed URL round-trip passes. Markdown + structured template output verified in AI4W.

4. **P3: Proactive Notifications + Human Approval**
   4.1 Implement proactive notification endpoint in `ai4w-adapter.ts` (`sendProactive`)
   4.2 Wire `ChannelDispatcher` to route human-approval suspensions to AI4W adapter
   4.3 Create AI4W notification receiver endpoint in `ABLGateway.rest.js`
   4.4 Wire notification delivery to `KANotificationService` with push+bell+presence
   4.5 Implement notification dedup with Redis `SET NX`
   4.6 Implement offline user fallback (no active socket → push notification)
   4.7 Wire approval result POST back to ABL callback endpoint
   4.8 E2E tests: proactive notification delivery, dedup, approval round-trip
   **P3 Exit**: Human-approval notification delivered to AI4W user. User approval resumes ABL execution. Dedup prevents duplicate notifications.

5. **P4: 1-Click Project Discovery + Provisioning**
   5.1 Implement `GET /api/internal/v1/tenants/{tenantId}/projects/discoverable` with tenant + user RBAC filtering, stable ordering (`name` ascending, optional `?sort=recent`), pagination + search (`?limit`, `?cursor`, `?q`), and live `agentCount`
   5.2 Implement `POST /api/internal/v1/channel-connections/provision` for project-level auto-creation — accepts `{tenantId, projectId, connectionName?, environment?, deploymentId?, callbackBaseUrl, responseMode?}`; enforces `environment` / `deploymentId` mutual exclusivity; stores with `agentId: null`; defaults `connectionName` to `Connection N+1` when omitted
   5.3 Enrich `GET /api/internal/v1/connections/{connectionId}/info` per FR-20 (tenant/project meta + live-resolved `currentDeployment`)
   5.4 Implement `POST /api/v1/channels/ai4w/{connectionId}/ping` per FR-19
   5.5 Sort `GET /api/internal/v1/tenants/by-membership` by `name` ascending
   5.6 E2E tests: project discovery RBAC filtering, pagination + search, provisioning with optional fields, info enrichment live resolution, ping success + failure paths
   **P4 Exit**: AI4W user browses ABL projects filtered by RBAC. Project-level provisioning creates a ChannelConnection bound to the project. `/info` reports live-resolved deployment. Ping validates auth without side effects.

6. **P7: Lifecycle APIs (Deactivate + Unlink)** _(new phase, sits between P4 and P5 in the legacy numbering)_
   7.1 Implement `POST /api/internal/v1/channel-connections/{connectionId}/deactivate` — sets `status='inactive'`, rejects new inbound requests with uniform 401, retains the row (FR-21)
   7.2 Implement `DELETE /api/internal/v1/channel-connections/{connectionId}` — hard-removes the row, scoped to `channelType='ai4w'` (FR-22)
   7.3 Audit events: `ai4w.connection.deactivated`, `ai4w.connection.deleted` (both already defined in HLD §7)
   7.4 E2E tests: deactivate rejects next message with 401, unlink returns 404 on subsequent `/info` lookup
   **P7 Exit**: AI4W orphan reaper can call DELETE successfully on an abandoned connection. ABL admin can reactivate a deactivated connection via the existing channel-customization UI.

7. **P5: Auth Challenge**
   6.1 Implement auth challenge payload in proactive notification (auth URL, form fields)
   6.2 Render auth challenge UI in AI4W (OAuth button/link)
   6.3 Wire OAuth completion callback to ABL's callback endpoint
   6.4 Handle challenge timeout (suspension expiry → timeout notification)
   6.5 E2E tests: auth challenge round-trip, timeout handling
   **P5 Exit**: OAuth auth challenge renders in AI4W. User completion resumes ABL execution. Timeout triggers expiry notification.

8. **P6: Cross-Environment**
   7.1 Implement OAuth2 client-credentials flow in `ai4w-auth.ts`
   7.2 Implement OAuth2 token exchange in `ABLGatewayService/authManager.js`
   7.3 Update SSRF policy for cross-env (default blocklist instead of allowlist)
   7.4 Add manual provisioning UI in both platforms for cross-env setup
   7.5 E2E tests: cross-env auth flow, SSRF enforcement
   **P6 Exit**: Cross-environment OAuth2 client-credentials flow authenticates successfully. SSRF blocklist enforced for non-VPC URLs.

---

## 14. Success Metrics

| Metric                               | Baseline | Target  | How Measured                                                   |
| ------------------------------------ | -------- | ------- | -------------------------------------------------------------- |
| ABL agents invoked from AI4W         | 0        | 10+/day | AI4W analytics: `ablAgent.startConversation` events            |
| Sync response latency (P95)          | N/A      | < 3s    | ABL trace events: `ai4w.delivery.sync` duration                |
| SSE time-to-first-byte (P95)         | N/A      | < 1s    | ABL trace events: `ai4w.delivery.stream` first chunk timestamp |
| Async delivery success rate          | N/A      | > 99.5% | ABL webhook-delivery queue: success/total ratio                |
| Proactive notification delivery rate | N/A      | > 99%   | ABL trace events: `ai4w.delivery.proactive` success/total      |
| 1-click provisioning success rate    | N/A      | > 95%   | ABL internal API: provision endpoint success/total             |
| Circuit breaker open events / week   | N/A      | < 5     | ABL circuit breaker metrics: `tool_service` state transitions  |
| Human approval response time (P50)   | N/A      | < 5min  | ABL suspension store: resume timestamp - suspend timestamp     |

---

## 15. Open Questions

0. **`/info` rate-limit policy (EVA-6527)**: `GET /api/v1/channels/ai4w/{connectionId}/info` (which replaces the former `/ping`) currently does not consume tenant rate-limit quota. Should it (a) remain exempt (cheap periodic health probes), (b) share the `/message` bucket, or (c) sit on its own generous bucket (e.g. 60/min)? All three options still feed the auth-failure counter so brute-forced bad creds remain blocked. To be decided with Prasanna before the AI4W V2 builder ships its periodic health-probe feature; tracked in `docs/sdlc-logs/ai4w-abl-channel-integration/open-items-eva-6527.log.md`. Default until decided: option (a) — exempt.
1. **Timeline**: What is the target delivery date or sprint for P0? This affects whether streaming (P1) should be bundled with P0 or kept separate.
2. **AI4W agent type naming**: Should the new agent type be called `ablAgent` or `ablPlatformAgent` to avoid confusion with other `abl` references in the codebase?
3. **Cross-environment trust establishment**: For P6, should the trust be established via an admin UI in both platforms, or via a configuration file / environment variable? P6 may warrant a separate mini-spec given the fundamentally different security model (public endpoints, OAuth2 flows, no internal APIs).
4. **AI4W notification payload format**: What is the exact payload structure `KoraNotificationService` (extends `KANotificationService`) expects for interactive approval notifications? Need to verify the approval UI rendering capability.
5. **ABL tenant ↔ AI4W account mapping**: Should this mapping be 1:1 or can one AI4W account connect to multiple ABL tenants? Multiple tenants would complicate discovery filtering.
6. **SSE vs chunked transfer encoding**: Should streaming use SSE (text/event-stream) or chunked transfer encoding (application/json with newline-delimited chunks)? AI4W's existing `sseNormalizer.js` suggests SSE is the natural fit.
7. **Internal API port strategy**: Should internal-only APIs (discovery, provisioning) run on a separate Express app/port (e.g., `:3113`), or use middleware-based enforcement on the main port? Separate port is more secure but adds deployment complexity.
8. **Platform convergence roadmap**: If AI4W and ABL may eventually merge components, should the `ai4w` channel adapter be designed as a thin shim that's easy to remove, or as a durable integration surface?

---

## 16. Gaps, Known Issues & Limitations

| ID      | Description                                                                                                        | Severity | Status |
| ------- | ------------------------------------------------------------------------------------------------------------------ | -------- | ------ |
| GAP-001 | No circuit breaker on AI4W's outbound fetch to ABL — `RequestAgent` has no circuit breaker. Only 1 retry.          | Medium   | Open   |
| GAP-002 | AI4W has no global API rate limiter — only specific endpoints (auth, signup, media) are rate-limited.              | Medium   | Open   |
| GAP-003 | AI4W's async response handler (`asyncAAAgentResponseHandler`) loses real-time messages for offline users.          | High     | Open   |
| GAP-004 | ABL's webhook-delivery worker has no circuit breaker on outbound fetch — only BullMQ retry exhaustion.             | Medium   | Open   |
| GAP-005 | ABL's proactive messaging system is PLANNED but not implemented — proactive delivery to AI4W must be custom.       | Medium   | Open   |
| GAP-006 | No dead-letter queue in ABL — failed webhook deliveries are retained in BullMQ's failed set but not reprocessable. | Low      | Open   |
| GAP-007 | AI4W `RequestAgent` has no general retry for 5xx errors — only auth-refresh retries on 401.                        | Medium   | Open   |

---

## 17. Testing & Validation

### Required Test Coverage

| #   | Scenario                                                   | Coverage Type | Status     | Test File / Note             |
| --- | ---------------------------------------------------------- | ------------- | ---------- | ---------------------------- |
| 1   | Sync message round-trip (AI4W → ABL → response)            | e2e           | NOT TESTED | `ai4w-channel.e2e.test.ts`   |
| 2   | JWT/JWKS verification (valid, expired, wrong issuer)       | integration   | NOT TESTED | `ai4w-auth.test.ts`          |
| 3   | Session isolation (cross-account, cross-user returns 404)  | e2e           | NOT TESTED | `ai4w-channel.e2e.test.ts`   |
| 4   | SSE streaming chunk delivery                               | e2e           | NOT TESTED | `ai4w-streaming.e2e.test.ts` |
| 5   | Async callback round-trip                                  | e2e           | NOT TESTED | `ai4w-channel.e2e.test.ts`   |
| 6   | Proactive notification delivery + dedup                    | e2e           | NOT TESTED | `ai4w-proactive.e2e.test.ts` |
| 7   | Offline user notification fallback (push notification)     | integration   | NOT TESTED | `ai4w-proactive.e2e.test.ts` |
| 8   | Agent discovery with RBAC filtering                        | e2e           | NOT TESTED | `ai4w-discovery.e2e.test.ts` |
| 9   | 1-click provisioning flow                                  | e2e           | NOT TESTED | `ai4w-discovery.e2e.test.ts` |
| 10  | File upload via signed URL (AI4W → ABL)                    | e2e           | NOT TESTED | `ai4w-channel.e2e.test.ts`   |
| 11  | Auth challenge round-trip (suspend → challenge → complete) | e2e           | NOT TESTED | `ai4w-channel.e2e.test.ts`   |
| 12  | Circuit breaker activation on AI4W outage                  | integration   | NOT TESTED | `ai4w-channel.e2e.test.ts`   |
| 13  | Cross-tenant access returns 404                            | e2e           | NOT TESTED | `ai4w-channel.e2e.test.ts`   |
| 14  | Rate limiting enforcement                                  | integration   | NOT TESTED | `ai4w-channel.e2e.test.ts`   |

### Testing Notes

Coverage expectations: Minimum 5 E2E scenarios and 5 integration scenarios per SDLC pipeline requirements. This spec defines 14 scenarios (8 E2E, 6 integration).

All scenarios require real ABL runtime instances (no mocking platform components). AI4W side may be simulated via a lightweight Express server implementing the callback and notification endpoints. Cross-platform E2E tests should verify the full middleware chain: auth, rate limiting, tenant isolation, session resolution, execution, and delivery.

> Full testing details: [../testing/ai4w-abl-channel-integration.md](../testing/ai4w-abl-channel-integration.md)

---

## 18. References

- Design docs: [AI4W-ABL Channel Revised Design](../design/ai4w-abl-channel-ux-design.md) (authoritative for auth model, Studio UX, endpoint design), [HLD](../specs/ai4w-abl-channel-integration.hld.md), [LLD](../plans/2026-04-18-ai4w-abl-channel-integration-impl-plan.md)
- Related feature docs: [Channels](channels.md), [A2A Integration](a2a-integration.md), [Auth Profiles](auth-profiles.md), [Circuit Breaker](circuit-breaker.md), [Webhook System](webhook-system.md), [Proactive Messaging](proactive-messaging.md)
- ABL channel manifest: `apps/runtime/src/channels/manifest.ts`
- ABL channel adapter interface: `apps/runtime/src/channels/types.ts`
- AI4W agent service: `KoreServer/api/services/AgentsService/apiAgents.js` (aaAgent reference pattern)
- AI4W conversation service: `KoreServer/services/KoraConversationService/lib/SearchService.js`

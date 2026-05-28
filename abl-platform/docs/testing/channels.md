# Test Spec: Channels

**Feature**: Channels
**Status**: STABLE
**Last Updated**: 2026-04-03

---

## 1. Test Overview

This test spec covers the ABL platform's channel integration system -- the unified abstraction that connects agents to messaging platforms, voice gateways, SDK embeddings, and inter-agent protocols. The system spans the Runtime (adapters, queues, session resolution, dispatch) and Studio (channel management UI).

### Test Scope

- Channel connection CRUD (create, read, update, deactivate)
- Webhook ingress and signature verification
- Message normalization and BullMQ pipeline
- Session resolution (new session, existing session, stale recovery, email threading)
- Outbound delivery (async queue, direct send, WebSocket, sync response)
- Channel OAuth flow (Slack, MS Teams, Meta)
- SDK channel management with HMAC identity verification
- Channel dispatcher multi-tier delivery
- Cross-channel session continuity
- Studio channel catalog and configuration UI
- Tenant/project isolation

### Test Categories

| Category    | Coverage Level                   | Description                                                                                    |
| ----------- | -------------------------------- | ---------------------------------------------------------------------------------------------- |
| E2E         | Representative existing coverage | Control plane, HTTP Async identity continuity, voice ingress/live flows                        |
| Integration | Broad existing coverage          | Dispatcher, resolver, OAuth/provider routing, identity normalization, Studio provider-aware UI |
| Unit        | Deep existing coverage           | Manifest/behavior contract, adapters, WebSocket handlers, transforms, voice helpers            |

### Current State (2026-04-03)

The March 2026 test spec understated the current branch. The repository now carries 150+ channel/voice/sdk-handler-related runtime test files plus Studio channel UI coverage. Post-2026-03-30 work added or hardened the most load-bearing seams for current channel work:

- `apps/runtime/src/channels/channel-behavior-contract.ts` is covered by `apps/runtime/src/__tests__/channels/channel-behavior-contract.test.ts`.
- `identityVerification.providerVerificationStrength` normalization is covered by `apps/runtime/src/__tests__/routes/channel-connection-identity-utils.test.ts`.
- Bounded SDK/debug WebSocket delivery is covered by `apps/runtime/src/__tests__/channels/ws-sdk-handler.test.ts`.
- Control-plane CRUD and HTTP Async identity continuity both have end-to-end coverage in `apps/runtime/src/__tests__/channels/channels-control-plane.e2e.test.ts` and `apps/runtime/src/__tests__/channels/http-async-identity-continuity.e2e.test.ts`.

---

## 2. E2E Test Scenarios

All E2E tests exercise the real system through HTTP API. No `vi.mock()`, no direct DB queries, no stubbed servers. Servers start on random ports with full middleware chains.

### E2E-CH-01: Channel Connection Lifecycle (CRUD)

**Priority**: P0
**Preconditions**: Running runtime server with MongoDB and Redis, authenticated user with project admin permissions.

| Step | Action                                                                                                             | Expected Result                                                                                        |
| ---- | ------------------------------------------------------------------------------------------------------------------ | ------------------------------------------------------------------------------------------------------ |
| 1    | POST `/api/projects/:projectId/channel-connections` with `channel_type: 'slack'`, credentials, external identifier | 201, connection returned with `id`, `status: 'active'`, `hasCredentials: true`, `webhookUrl` populated |
| 2    | GET `/api/projects/:projectId/channel-connections`                                                                 | 200, array includes the created connection                                                             |
| 3    | GET `/api/projects/:projectId/channel-connections/:id`                                                             | 200, returns the specific connection with all fields                                                   |
| 4    | PATCH `/api/projects/:projectId/channel-connections/:id` with `display_name: 'Updated'`                            | 200, `displayName` updated                                                                             |
| 5    | PATCH with `credentials: { bot_token: 'new-token', signing_secret: 'new-secret' }`                                 | 200, `hasCredentials: true`, old credentials replaced                                                  |
| 6    | DELETE `/api/projects/:projectId/channel-connections/:id`                                                          | 200, connection status changes to `inactive`                                                           |
| 7    | GET the deactivated connection                                                                                     | Returns `status: 'inactive'`                                                                           |
| 8    | POST with same external identifier                                                                                 | 201, new connection created (old one is inactive, unique index allows)                                 |

**Assertion Focus**: Correct HTTP status codes, tenant isolation (cross-tenant GET returns 404), credential encryption (response never contains raw secrets), project scope enforcement.

### E2E-CH-02: Webhook Ingress and Message Pipeline

**Priority**: P0
**Preconditions**: Active Slack channel connection, BullMQ inbound queue initialized, runtime executor ready.

| Step | Action                                                                                                 | Expected Result                                                          |
| ---- | ------------------------------------------------------------------------------------------------------ | ------------------------------------------------------------------------ |
| 1    | Create a Slack channel connection via API                                                              | Connection created with `status: 'active'`                               |
| 2    | POST to `/api/v1/channels/slack/webhook/:identifier` with valid Slack event payload and HMAC signature | 200 `{ ok: true }` returned within 3 seconds                             |
| 3    | Wait for BullMQ job processing                                                                         | Job processed, session created in DB                                     |
| 4    | Query channel sessions for the connection                                                              | Channel session exists with correct `externalSessionKey` and `sessionId` |
| 5    | POST a second message with same thread ID                                                              | Same channel session reused, `lastMessageAt` updated                     |
| 6    | POST with invalid HMAC signature                                                                       | 401 `{ error: 'Invalid signature' }`                                     |
| 7    | POST to non-existent connection identifier                                                             | 404 `{ error: 'Channel not configured for this workspace' }`             |
| 8    | POST with unknown channel type                                                                         | 400 `{ error: 'Unsupported channel type: ...' }`                         |

**Assertion Focus**: Fast ACK (< 3s), correct BullMQ job creation, session creation, signature verification rejects invalid requests, error responses match expected format.

### E2E-CH-03: SDK Channel with HMAC Identity Verification

**Priority**: P0
**Preconditions**: Running runtime, authenticated user.

| Step | Action                                                                                    | Expected Result                            |
| ---- | ----------------------------------------------------------------------------------------- | ------------------------------------------ |
| 1    | POST `/api/projects/:projectId/sdk-channels` with `name`, `channelType`, `publicApiKeyId` | 201, SDK channel created                   |
| 2    | PATCH to set `hmacEnforcement: 'required'` and generate `secretKey`                       | 200, HMAC enforcement updated              |
| 3    | Connect via WebSocket with valid HMAC token                                               | Connection accepted, session established   |
| 4    | Connect via WebSocket with invalid HMAC token                                             | Connection rejected with auth error        |
| 5    | Connect via WebSocket with no HMAC token when enforcement is `required`                   | Connection rejected                        |
| 6    | Set `hmacEnforcement: 'optional'` and connect with no HMAC                                | Connection accepted (graceful degradation) |
| 7    | Set `hmacEnforcement: 'disabled'` and connect with no HMAC                                | Connection accepted                        |
| 8    | DELETE the SDK channel                                                                    | 200, channel deleted                       |

**Assertion Focus**: HMAC enforcement modes behave correctly, SDK auth middleware validates tokens, error messages are appropriate for each mode.

### E2E-CH-04: Channel OAuth Flow (Slack)

**Priority**: P1
**Preconditions**: Running runtime with Redis (for OAuth state store), configured Slack OAuth credentials.

| Step | Action                                                                       | Expected Result                                                    |
| ---- | ---------------------------------------------------------------------------- | ------------------------------------------------------------------ |
| 1    | POST `/api/v1/channel-oauth/slack/authorize` with `projectId`, `redirectUri` | 200, `authUrl` and `state` returned                                |
| 2    | Verify `state` is stored in Redis with correct metadata                      | State contains `channelType`, `tenantId`, `projectId`, `expiresAt` |
| 3    | GET `/api/v1/channel-oauth/slack/callback` with valid `code` and `state`     | 200, credentials, external identifier, and display name returned   |
| 4    | Verify state is consumed (cannot be reused)                                  | Second callback with same state fails                              |
| 5    | GET callback with invalid/expired state                                      | 400 or 404, appropriate error                                      |
| 6    | POST authorize for unsupported channel type                                  | 400, "No OAuth provider registered"                                |

**Assertion Focus**: OAuth state lifecycle (create, consume, expire), CSRF protection, credential exchange. Note: actual Slack OAuth code exchange requires mock Slack OAuth server or test fixture.

### E2E-CH-05: Deployment/Environment Binding

**Priority**: P0
**Preconditions**: Project with active deployment in `production` environment.

| Step | Action                                                                       | Expected Result                                        |
| ---- | ---------------------------------------------------------------------------- | ------------------------------------------------------ |
| 1    | Create channel connection with `deployment_id` pointing to active deployment | Connection created with `deploymentId`                 |
| 2    | Create channel connection with `environment: 'production'` (no deployment)   | Connection created with environment binding            |
| 3    | Simulate inbound webhook for deployment-bound connection                     | Session created using deployment's agent versions      |
| 4    | Simulate inbound webhook for environment-bound connection                    | Session created using environment's active versions    |
| 5    | Create connection with no deployment or environment                          | Session falls through to working copy                  |
| 6    | Deactivate the deployment, then send another webhook                         | Session creation handles missing deployment gracefully |

**Assertion Focus**: Deployment resolver correctly resolves agent IR for each binding mode, session creation respects `allowWorkingCopy` flag.

### E2E-CH-06: Tenant and Project Isolation

**Priority**: P0
**Preconditions**: Two tenants (A, B) each with a project and channel connections.

| Step | Action                                                          | Expected Result                                      |
| ---- | --------------------------------------------------------------- | ---------------------------------------------------- |
| 1    | Create connection in Tenant A's project                         | 201 success                                          |
| 2    | GET Tenant A's connection using Tenant B's auth                 | 404 (not 403)                                        |
| 3    | PATCH Tenant A's connection using Tenant B's auth               | 404                                                  |
| 4    | DELETE Tenant A's connection using Tenant B's auth              | 404                                                  |
| 5    | List connections in Tenant A's project using Tenant B's auth    | 200 with empty array (project scope prevents access) |
| 6    | Create connection with Tenant A's auth but Tenant B's projectId | 403 or 404                                           |

**Assertion Focus**: Cross-tenant access always returns 404 (not 403), project scope middleware enforces project membership, no information leakage.

### E2E-CH-07: Webhook Delivery Pipeline

**Priority**: P1
**Preconditions**: HTTP Async channel with active webhook subscription, BullMQ delivery queue running.

| Step | Action                                                | Expected Result                                              |
| ---- | ----------------------------------------------------- | ------------------------------------------------------------ |
| 1    | Create HTTP Async connection and webhook subscription | Subscription active                                          |
| 2    | Send inbound message via HTTP Async API               | Message processed, agent responds                            |
| 3    | Verify webhook delivery job created in delivery queue | Job payload contains correct event data                      |
| 4    | Set up mock callback server, verify delivery          | POST received with HMAC signature headers, correct payload   |
| 5    | Return 5xx from callback                              | Delivery retried with exponential backoff (up to 5 attempts) |
| 6    | Return 410 from callback                              | Subscription deactivated, no further retries                 |
| 7    | Return 4xx (non-410) from callback                    | Delivery marked failed, no retry                             |

**Assertion Focus**: HMAC signature correctness, retry behavior, subscription lifecycle, delivery status tracking.

**Planned follow-up for named `renderables[]`:** once the structured webhook contract lands, extend this scenario to assert that `voiceConfig`, `richContent`, and `renderables[]` are included directly in the delivery payload alongside legacy `channel_output`.

### E2E-CH-08: Meta Webhook Verification (GET Challenge)

**Priority**: P1
**Preconditions**: Active WhatsApp channel connection with verify_token configured.

| Step | Action                                                                                                    | Expected Result                              |
| ---- | --------------------------------------------------------------------------------------------------------- | -------------------------------------------- |
| 1    | Create WhatsApp connection with `verify_token` in credentials                                             | Connection created, `verifyTokenHash` stored |
| 2    | GET `/api/v1/channels/whatsapp/webhook?hub.mode=subscribe&hub.verify_token=<token>&hub.challenge=test123` | 200, response body is `test123`              |
| 3    | GET with incorrect verify_token                                                                           | 403 "Verification failed"                    |
| 4    | GET for non-Meta channel type (e.g., slack)                                                               | 404 "GET verification not supported"         |
| 5    | Create second WhatsApp connection with different verify_token                                             | Both connections independently verifiable    |

**Assertion Focus**: Verify token hash lookup, challenge echo, incorrect token rejection, per-connection isolation.

---

## 3. Integration Test Scenarios

Integration tests test real service boundaries but may use in-memory databases (MongoMemoryServer) and real Redis. No mocking of codebase components.

### INT-CH-01: Channel Adapter Registry and Normalization

**Priority**: P0
**Components**: `ChannelRegistry`, all adapter implementations.

| Step | Action                                                       | Expected Result                                         |
| ---- | ------------------------------------------------------------ | ------------------------------------------------------- |
| 1    | Initialize `ChannelRegistry`                                 | All 18 adapters registered                              |
| 2    | `registry.get('slack')`                                      | Returns `SlackAdapter` instance                         |
| 3    | Call `adapter.verifyRequest()` with correct HMAC             | Returns `true`                                          |
| 4    | Call `adapter.verifyRequest()` with incorrect HMAC           | Returns `false`                                         |
| 5    | Call `adapter.buildNormalizedMessage()` with Slack event     | Returns `NormalizedIncomingMessage` with correct fields |
| 6    | Call `adapter.transformOutput()` with text and ActionSetIR   | Returns `ChannelOutput` with `kind: 'slack_blocks'`     |
| 7    | Repeat for each critical adapter (Teams, WhatsApp, Telegram) | All produce correct output                              |

**Assertion Focus**: Registry completeness, signature verification correctness, normalization accuracy, output transformation validity.

### INT-CH-02: Session Resolution with Email Threading

**Priority**: P1
**Components**: `session-resolver.ts`, `ChannelSession` model.

| Step | Action                                                                            | Expected Result                                          |
| ---- | --------------------------------------------------------------------------------- | -------------------------------------------------------- |
| 1    | Create email channel connection                                                   | Connection active                                        |
| 2    | Call `resolveSession()` with first email (no threading headers)                   | New channel session created, `emailMessageIds` seeded    |
| 3    | Call `resolveSession()` with reply (In-Reply-To matches first email's Message-ID) | Same channel session returned, `emailMessageIds` updated |
| 4    | Call `resolveSession()` with reply using References header                        | Same channel session returned                            |
| 5    | Call `resolveSession()` with unrelated email (no threading match)                 | New channel session created                              |
| 6    | Call `resolveSession()` with subject-based fallback                               | Session resolved via subject key                         |

**Assertion Focus**: RFC 5322 threading resolution, emailMessageIds accumulation, subject-based fallback, new session creation on no match.

### INT-CH-03: Connection Resolver with Auth Profile Dual-Read

**Priority**: P0
**Components**: `connection-resolver.ts`, `dualReadCredentials()`.

| Step | Action                                                                | Expected Result                                                            |
| ---- | --------------------------------------------------------------------- | -------------------------------------------------------------------------- |
| 1    | Create connection with legacy encrypted credentials (no auth profile) | `resolveChannelConnection()` returns decrypted credentials via legacy path |
| 2    | Create connection with `authProfileId` set                            | `resolveChannelConnection()` resolves credentials via auth profile         |
| 3    | Set auth profile that fails resolution                                | Falls back to legacy encrypted credentials                                 |
| 4    | Connection with neither auth profile nor encrypted credentials        | Returns `credentials: null`                                                |
| 5    | Resolve connection by verify token hash                               | Correct connection returned                                                |
| 6    | Resolve inactive connection                                           | Returns `null`                                                             |

**Assertion Focus**: Dual-read fallback chain, credential decryption, auth profile integration, inactive connection filtering.

### INT-CH-04: Channel Dispatcher Multi-Tier Delivery

**Priority**: P1
**Components**: `ChannelDispatcher`, `WebSocketConnectionRegistry`, `PendingDeliveryStore`.

| Step | Action                                                | Expected Result                                       |
| ---- | ----------------------------------------------------- | ----------------------------------------------------- |
| 1    | Deliver to active local WebSocket                     | Message delivered via WS, `sendStudioProtocol` called |
| 2    | Deliver to disconnected WebSocket                     | Falls to Tier 2 (Redis Pub/Sub)                       |
| 3    | Deliver with no Redis Pub/Sub                         | Falls to Tier 3 (PendingDeliveryStore)                |
| 4    | Deliver for async channel (Slack) with connectionId   | Marked as delivered (handled by webhook pipeline)     |
| 5    | Deliver for A2A channel with push notification config | Push notification sent                                |
| 6    | Verify message persistence                            | Message persisted to DB regardless of delivery tier   |

**Assertion Focus**: Tier fallback chain, protocol correctness (response_start/chunk/end), pending delivery storage, message persistence.

### INT-CH-05: Channel Manifest Derived Helpers

**Priority**: P0
**Components**: `manifest.ts` helper functions.

| Step | Action                                                         | Expected Result                                                         |
| ---- | -------------------------------------------------------------- | ----------------------------------------------------------------------- |
| 1    | `getWebhookChannelTypes()`                                     | Returns all types with ingress `webhook` or `sync_webhook`              |
| 2    | `getRealtimeChannelTypes()`                                    | Returns all types with ingress `websocket`                              |
| 3    | `getConnectionChannelTypes()`                                  | Returns all types with `isConnectionEligible: true`                     |
| 4    | `getVoiceChannelTypes()`                                       | Returns all types with `isVoice: true`                                  |
| 5    | `getRequiredCredentials('slack')`                              | Returns `['bot_token', 'signing_secret']`                               |
| 6    | `buildWebhookUrl('slack', 'https://example.com', 'T051:A0AE')` | Returns `https://example.com/api/v1/channels/slack/webhook/T051%3AA0AE` |
| 7    | `isKnownChannelType('slack')`                                  | Returns `true`                                                          |
| 8    | `isKnownChannelType('unknown')`                                | Returns `false`                                                         |

**Assertion Focus**: Manifest-derived sets match expected values, webhook URL construction handles encoding and provider routing.

### INT-CH-06: Inbound Worker Message Deduplication

**Priority**: P1
**Components**: `inbound-worker.ts`, Redis.

| Step | Action                                              | Expected Result                          |
| ---- | --------------------------------------------------- | ---------------------------------------- |
| 1    | Process first message with idempotency key          | Message processed normally               |
| 2    | Process duplicate message with same key             | Message skipped (dedup via Redis SET NX) |
| 3    | Process retry of same BullMQ job (attemptsMade > 0) | Dedup bypassed, message processed        |
| 4    | Process message with different key                  | Message processed normally               |

**Assertion Focus**: Redis SET NX dedup, retry bypass logic, key format correctness.

### INT-CH-07: Stale Session Recovery

**Priority**: P1
**Components**: `session-resolver.ts`, `reuseOrRefreshSession()`.

| Step | Action                                                        | Expected Result                                                             |
| ---- | ------------------------------------------------------------- | --------------------------------------------------------------------------- |
| 1    | Create channel session pointing to a valid runtime session    | `resolveSession()` returns existing session                                 |
| 2    | Expire the runtime session (simulate Redis TTL expiry)        | Channel session still exists in MongoDB                                     |
| 3    | Call `resolveSession()` with same external session key        | Detects stale session, creates new runtime session, updates channel session |
| 4    | Verify new session has correct deployment/environment binding | Same binding as original connection                                         |

**Assertion Focus**: Stale detection via `getSession()` + `rehydrateSession()`, automatic recovery, session mapping update.

### INT-CH-08: WhatsApp Multi-Provider Routing

**Priority**: P1
**Components**: `whatsapp-provider.ts`, WhatsApp provider adapters.

| Step | Action                                                                   | Expected Result                                    |
| ---- | ------------------------------------------------------------------------ | -------------------------------------------------- |
| 1    | Register all 4 providers (MetaCloud, Infobip, Gupshup, Netcore)          | Providers registered                               |
| 2    | POST to `/api/v1/channels/whatsapp/infobip/webhook` with Infobip payload | Correct provider used for normalization            |
| 3    | POST to `/api/v1/channels/whatsapp/webhook` with Meta Cloud payload      | Default (meta_cloud) provider used                 |
| 4    | POST with unknown provider                                               | 400 "Unknown provider"                             |
| 5    | Each provider extracts external identifier correctly                     | `extractExternalIdentifier()` returns phone number |
| 6    | Each provider builds correct normalized message                          | `buildNormalizedMessage()` returns valid structure |

**Assertion Focus**: Provider routing correctness, identifier extraction, message normalization per provider.

---

## 4. Unit Test Scenarios

### UNIT-CH-01: Output Transform per Channel

**Components**: Each adapter's `transformOutput()` method.

| Adapter   | Input                           | Expected Output Kind                     |
| --------- | ------------------------------- | ---------------------------------------- |
| Slack     | text + ActionSetIR with buttons | `slack_blocks` with Button blocks        |
| MS Teams  | text + ActionSetIR              | `adaptive_card` with Action.Submit       |
| WhatsApp  | text + ActionSetIR              | `whatsapp_interactive` with buttons      |
| Telegram  | text + ActionSetIR              | `telegram_keyboard` with inline keyboard |
| Zendesk   | text + ActionSetIR              | `zendesk_actions` with action buttons    |
| Messenger | text only                       | `text` fallback                          |
| AG-UI     | text + events                   | `ag_ui_events`                           |

### UNIT-CH-02: Voice Text Stripping

**Components**: `stripForVoice()` in `channel-adapter.ts`.

| Input                        | Expected Output |
| ---------------------------- | --------------- |
| `**Bold** text`              | `Bold text`     |
| `*Italic* text`              | `Italic text`   |
| `[Link](http://example.com)` | `Link`          |
| `# Header`                   | `Header`        |
| `- List item`                | `List item`     |
| Text with emoji              | Emoji removed   |
| Whitespace collapse          | Single spaces   |

### UNIT-CH-03: Webhook URL Builder

**Components**: `buildWebhookUrl()` in `manifest.ts`.

| Channel  | Base URL                  | Identifier               | Expected                                                            |
| -------- | ------------------------- | ------------------------ | ------------------------------------------------------------------- |
| slack    | `https://api.example.com` | `T051:A0AE`              | `https://api.example.com/api/v1/channels/slack/webhook/T051%3AA0AE` |
| whatsapp | `https://api.example.com` | null                     | `https://api.example.com/api/v1/channels/whatsapp/webhook`          |
| vxml     | `https://api.example.com` | `stream-1`               | `https://api.example.com/api/v1/channels/vxml/hooks/stream-1`       |
| email    | `https://api.example.com` | null                     | `null` (no webhook pattern)                                         |
| whatsapp | `https://api.example.com` | null, provider=`infobip` | `https://api.example.com/api/v1/channels/whatsapp/infobip/webhook`  |

### UNIT-CH-04: Channel Connection Type Validation

**Components**: `VALID_CHANNEL_TYPES` derived from manifest.

| Input           | Expected                          |
| --------------- | --------------------------------- |
| `'slack'`       | Valid                             |
| `'whatsapp'`    | Valid                             |
| `'web_debug'`   | Invalid (not connection-eligible) |
| `'api'`         | Invalid (not connection-eligible) |
| `'nonexistent'` | Invalid                           |

### UNIT-CH-05: Caller Context Extraction

**Components**: `extractCallerContextFromChannel()` in `session-resolver.ts`.

| Channel Type | Metadata                          | Expected anonymousId |
| ------------ | --------------------------------- | -------------------- |
| `slack`      | `{ slackUserId: 'U123' }`         | `'U123'`             |
| `whatsapp`   | `{ whatsappFrom: '+1234567890' }` | `'+1234567890'`      |
| `msteams`    | `{ fromId: 'aad-id-123' }`        | `'aad-id-123'`       |
| `email`      | `{ from: 'user@example.com' }`    | `'user@example.com'` |
| `telegram`   | `{ telegramUserId: 12345 }`       | `'12345'`            |
| unknown      | `{}`                              | `externalSessionKey` |

### UNIT-CH-06: ActionEvent Source Types

**Components**: `ActionEvent` type in `action-event.ts`.

| Source             | Valid           |
| ------------------ | --------------- |
| `'websocket'`      | Yes             |
| `'slack'`          | Yes             |
| `'teams'`          | Yes             |
| `'whatsapp'`       | Yes             |
| `'genesys'`        | Yes             |
| `'unknown_source'` | No (type error) |

---

## 5. Test Coverage Map

| Component               | E2E                                           | Integration                            | Unit                        | Status   |
| ----------------------- | --------------------------------------------- | -------------------------------------- | --------------------------- | -------- |
| Channel Connection CRUD | `channels-control-plane.e2e.test.ts`          | authz + repo/resolver coverage         | validation helpers          | Existing |
| Webhook Ingress         | representative per-channel route/E2E coverage | adapter/provider routing               | manifest/url builders       | Existing |
| SDK Channels            | control-plane + WS lifecycle coverage         | `ws-sdk-handler.test.ts`               | repo/auth helpers           | Existing |
| Channel OAuth           | provider tests + service tests                | service/provider coverage              | provider units              | Existing |
| Deployment Binding      | voice/channel environment suites              | environment resolution                 | route validation            | Existing |
| Tenant Isolation        | control-plane E2E and authz tests             | resolver tests                         | route guards                | Existing |
| Webhook Delivery        | HTTP Async callback continuity                | dispatcher / delivery worker coverage  | callback-url policy         | Partial  |
| Meta Verification       | webhook route/provider tests                  | provider routing                       | URL / token hashing helpers | Existing |
| Session Resolution      | HTTP Async identity continuity, voice ingress | resolver suites                        | caller-context helpers      | Existing |
| Channel Dispatcher      | voice / ws flows exercise delivery            | `execution/channel-dispatcher.test.ts` | -                           | Existing |
| Manifest Helpers        | -                                             | behavior-contract alignment            | manifest helpers            | Existing |
| Message Dedup           | indirect E2E coverage                         | inbound worker / queue tests           | -                           | Partial  |
| Output Transform        | voice and provider flows                      | adapter/provider integration           | adapter units               | Existing |
| Voice Stripping         | voice pipeline coverage                       | voice integration                      | text-strip helper tests     | Existing |
| WhatsApp Providers      | provider-specific webhook suites              | provider tests                         | -                           | Existing |

---

## 6. Existing Test Coverage

Representative existing suites:

| File                                                                                       | Type        | Coverage                                                          |
| ------------------------------------------------------------------------------------------ | ----------- | ----------------------------------------------------------------- |
| `apps/runtime/src/__tests__/channels/channels-control-plane.e2e.test.ts`                   | E2E         | Channel control-plane CRUD and isolation                          |
| `apps/runtime/src/__tests__/channels/http-async-identity-continuity.e2e.test.ts`           | E2E         | HTTP Async session continuity / identity handling                 |
| `apps/runtime/src/__tests__/channels/channels-voice-ingress.e2e.test.ts`                   | E2E         | Voice ingress path                                                |
| `apps/runtime/src/__tests__/channels/voice-ir-resolution.e2e.test.ts`                      | E2E         | Voice deployment / IR resolution                                  |
| `apps/runtime/src/__tests__/channels/channel-behavior-contract.test.ts`                    | Unit        | Channel parity contract alignment                                 |
| `apps/runtime/src/__tests__/channels/ws-sdk-handler.test.ts`                               | Integration | SDK WebSocket lifecycle, auth, delivery                           |
| `apps/runtime/src/__tests__/execution/channel-dispatcher.test.ts`                          | Integration | Multi-tier channel delivery                                       |
| `apps/runtime/src/__tests__/routes/channel-connection-identity-utils.test.ts`              | Unit        | `identityVerification.providerVerificationStrength` normalization |
| `apps/runtime/src/__tests__/channels/adapters/infobip-provider.test.ts`                    | Unit        | WhatsApp provider routing                                         |
| `apps/runtime/src/__tests__/channels/adapters/gupshup-provider.test.ts`                    | Unit        | WhatsApp provider routing                                         |
| `apps/studio/src/__tests__/channel-normalizer.test.ts`                                     | Unit        | Studio channel normalization                                      |
| `apps/studio/src/__tests__/components/channel-provider-awareness.test.tsx`                 | Unit        | Provider-aware Studio UI                                          |
| `apps/runtime/src/services/channel-oauth/__tests__/channel-oauth-service.test.ts`          | Unit        | OAuth service layer                                               |
| `apps/runtime/src/services/channel-oauth/providers/__tests__/slack-oauth-provider.test.ts` | Unit        | Slack provider                                                    |

### Gaps

- **Full webhook → BullMQ → execute → delivery parity** is still broader in unit/integration coverage than in exhaustive black-box E2E coverage.
- **Per-connection health checks and connectivity probes** remain product gaps, not just test gaps.
- **SDK HMAC/browser-style lifecycle coverage** is strong in runtime/WebSocket tests, but still lighter in end-to-end browser harnesses than the core channel control plane.

---

## 7. Testing Infrastructure Requirements

### For E2E Tests

- Runtime server started on random port (`{ port: 0 }`) with full middleware chain
- Real MongoDB (or MongoMemoryServer for CI)
- Real Redis for BullMQ, dedup, session locks, OAuth state
- Test fixtures for channel webhooks (Slack event payloads, WhatsApp webhook payloads)
- Mock external APIs only for OAuth code exchange (Slack API, MS Teams API)
- HMAC signature generation utilities for Slack, WhatsApp, Twilio

### For Integration Tests

- MongoMemoryServer for channel connection / session models
- Real Redis for dedup and session locks
- In-process adapter instances (no HTTP)
- Test encryption keys for credential encryption/decryption

### Environment Variables

```
ENCRYPTION_MASTER_KEY=test-key-for-channel-tests
CHANNEL_SESSION_RETENTION_DAYS=0
CHANNEL_EXECUTE_TIMEOUT_MS=30000
```

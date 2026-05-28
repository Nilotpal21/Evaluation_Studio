# Feature: Channels

**Doc Type**: MAJOR FEATURE
**Parent Feature**: N/A
**Status**: STABLE
**Feature Area(s)**: `customer experience`, `integrations`, `agent lifecycle`, `admin operations`, `observability`
**Package(s)**: `apps/runtime`, `packages/database`, `apps/studio`
**Owner(s)**: Platform team
**Testing Guide**: [docs/testing/channels.md](../testing/channels.md)
**Focused Sub-Feature(s)**: [docs/features/sub-features/sdk-channel-creation.md](./sub-features/sdk-channel-creation.md), [docs/features/sub-features/localized-interaction-context.md](./sub-features/localized-interaction-context.md)
**Last Updated**: 2026-04-16

---

## 1. Introduction / Overview

### Problem Statement

Without a shared channel layer, every external surface would need its own connection model, auth handling, webhook routing, session resolution, and response transformation path. That would make the runtime brittle, duplicate integration logic across messaging, voice, SDK, and protocol channels, and make it much harder to preserve tenant/project isolation consistently.

### Goal Statement

The goal of the Channels feature is to give the platform one manifest-driven control plane for ingress, delivery, credential handling, session continuity, and adapter-specific output transformation across every supported communication surface. It should let project owners add or operate channels without rebuilding runtime-specific plumbing for each provider.

### Summary

Channels are the connective tissue between the ABL Platform's agent runtime and external communication platforms. Every conversation between a user and an agent flows through a channel, whether that is a Slack workspace, a WhatsApp number, a telephony system, an embedded web widget, or another AI agent.

The channel system is built on a **manifest-driven architecture**: a single `CHANNEL_MANIFEST` defines every channel type's capabilities, authentication mode, ingress/delivery patterns, credential requirements, and webhook URL templates. All derived behavior (webhook routing, voice detection, connection eligibility, credential validation) is computed from this manifest rather than hardcoded in scattered locations.

The platform supports **27 channel types** organized into five categories: messaging (Slack, Teams, WhatsApp, Messenger, Instagram, LINE, Telegram, Twilio SMS, Zendesk, Email), voice (VXML, AudioCodes, Kore Voice Gateway, Pipeline Voice, Twilio Voice, LiveKit Voice), SDK (Web Chat, SDK WebSocket, Web Debug), protocol (A2A agent-to-agent, AG-UI, HTTP Async), and API (direct HTTP/API access).

### Key Capabilities

- **Unified adapter interface**: All channels implement `ChannelAdapter` with `verifyRequest`, `parseIncoming`, `sendResponse`, and optional `transformOutput` / `sendTypingIndicator`
- **Encrypted credential storage**: Channel credentials are encrypted at rest using tenant-scoped encryption (via `encryptionPlugin` on the model or manual `encryptForTenant`)
- **Session continuity**: `ChannelSession` maps external session keys (Slack thread IDs, call IDs, email subjects) to internal runtime session IDs
- **Async message processing**: Webhook-based channels enqueue to BullMQ (`channel-inbound` queue) for reliable processing with retries
- **Multi-provider support**: WhatsApp supports four providers (Meta Cloud API, Infobip, Gupshup, Netcore) via a pluggable provider system
- **OAuth integration**: Channels like Slack support OAuth-based connection setup via `channel-oauth` routes
- **Rich output transformation**: Adapters transform plain text + `ActionSetIR` into platform-native formats (Block Kit, Adaptive Cards, interactive messages, templates)
- **SDK widget embedding**: SDK channels provide project/channel control-plane metadata while canonical browser/session bootstrap flows use Runtime `POST /api/v1/sdk/init` plus fragment-based Studio preview/share artifacts

---

## 2. Scope

### Goals

- Provide one platform-wide abstraction for connection management, ingress verification, session continuity, and outbound delivery across supported channel families.
- Keep channel behavior manifest-driven so new channel types can be added or updated without scattering provider logic across the runtime.
- Preserve tenant, project, and session ownership guarantees while still supporting asynchronous webhooks, synchronous IVR flows, and real-time SDK or voice transports.

### Non-Goals (Out of Scope)

- Replacing provider-native infrastructure such as Twilio, LiveKit, SMTP, or Slack with ABL-owned transport infrastructure.
- Offering a separate admin-only creation flow for every channel family; most lifecycle management remains project-scoped.
- Guaranteeing built-in health monitoring, per-connection rate limiting, or exhaustive browser/UI validation for every supported provider today.

---

## 3. User Stories

1. As a project operator, I want to configure a channel connection once so an agent can receive and respond to messages on that external platform without custom runtime wiring.
2. As a platform engineer, I want channel behavior defined in one manifest so provider capabilities, auth modes, and webhook patterns stay consistent across the runtime and Studio.
3. As an end user, I want multi-turn conversations to keep context whether I talk through chat, voice, SDK, or protocol channels.

---

## 4. Functional Requirements

1. **FR-1**: The system must allow project-scoped creation, update, listing, and deactivation of supported channel connections and SDK channels.
2. **FR-2**: The system must resolve inbound channel traffic to the correct tenant, project, deployment, and session before runtime execution begins.
3. **FR-3**: The system must verify ingress authentication according to the channel manifest and fail closed when required secrets or signatures are invalid.
4. **FR-4**: The system must transform normalized runtime output into provider-native response formats for the target channel.
5. **FR-5**: The system must preserve session continuity by mapping external session identifiers to internal runtime sessions.
6. **FR-6**: The system must support asynchronous, synchronous, and real-time channel execution patterns without bypassing shared auth, isolation, and tracing rules.

---

## 5. Feature Classification & Integration Matrix

### Lifecycle / Platform Impact

| Area                       | Impact Level | Notes                                                                 |
| -------------------------- | ------------ | --------------------------------------------------------------------- |
| Project lifecycle          | PRIMARY      | Channels are project-owned deployment surfaces and connection records |
| Agent lifecycle            | SECONDARY    | Channel type and session context shape execution and prompts          |
| Customer experience        | PRIMARY      | Channels are the user-facing ingress and delivery layer               |
| Integrations / channels    | PRIMARY      | This feature is the core integration surface                          |
| Observability / tracing    | SECONDARY    | Channel delivery emits trace events and structured logs               |
| Governance / controls      | SECONDARY    | Ingress auth, encryption, and scoped CRUD are enforced here           |
| Enterprise / compliance    | SECONDARY    | Credential storage, auditability, and isolation matter materially     |
| Admin / operator workflows | PRIMARY      | Studio and admin surfaces expose catalog, config, and lifecycle flows |

### Related Feature Integration Matrix

| Related Feature                                                                | Relationship Type | Why It Matters                                                                                             | Key Touchpoints                                                          | Current State |
| ------------------------------------------------------------------------------ | ----------------- | ---------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------ | ------------- |
| [SDK](sdk.md)                                                                  | extends           | SDK uses the shared channel/session model for web and embedded clients                                     | `sdk_channels`, `/api/v1/sdk/*`, `/ws/sdk`                               | Active        |
| [SDK Channel Creation](sub-features/sdk-channel-creation.md)                   | configured by     | SDK-specific channel records are managed through the broader channel control plane                         | `/api/projects/:projectId/sdk-channels`, admin proxy flows               | Active        |
| [Localized Interaction Context](sub-features/localized-interaction-context.md) | extends           | Channel-native locale and language hints should normalize into one execution contract across ingress paths | Teams `locale`, AudioCodes `language`, SDK/A2A metadata, session factory | Planned       |
| [Voice Capabilities](voice-capabilities.md)                                    | extends           | Voice ingress and telephony adapters are channel implementations                                           | Twilio, LiveKit, VXML, AudioCodes, KoreVG routes                         | Active        |
| [A2A Integration](a2a-integration.md)                                          | tested with       | A2A is one of the protocol channel families                                                                | A2A channel manifest entries and execution path                          | Active        |
| [Auth Profiles](auth-profiles.md)                                              | depends on        | Channel credentials can resolve through auth profiles and dual-read credential paths                       | `dualReadCredentials`, encrypted connection material                     | Active        |

---

## 6. Design Considerations (Optional)

- Studio intentionally presents channels as a three-level navigation model: catalog, instance list, and instance configuration.
- Channel type grouping and capability labels should stay consistent with the manifest so Studio does not drift from runtime truth.
- Provider-specific complexity stays in adapters; UI surfaces should stay channel-family aware but not re-encode provider logic.

---

## 7. Technical Considerations (Optional)

- The manifest-driven architecture is the main extensibility contract. Adding a channel should start with `CHANNEL_MANIFEST`, then route/adaptor wiring, not ad-hoc route branches.
- Async webhook channels should keep enqueue-only request paths fast and offload processing to BullMQ workers.
- Session resolution and ingress auth must keep honoring the same tenant/project isolation guarantees regardless of whether the channel is webhook, synchronous IVR, or WebSocket based.

---

## 8. How to Consume

### Studio UI

Channel management lives in the **Channels Tab** within the project deployment view:

- **Level 1 — Channel Catalog** (`ChannelCatalog`): Grid of all available channel types organized by category (messaging, SDK, webhook, voice, protocol), showing instance counts per type.
- **Level 2 — Instance List** (`ChannelInstanceList`): Table of configured connections for a selected channel type. Shows status, environment, external identifier, and creation date.
- **Level 3 — Instance Config** (`ChannelInstanceConfig`): Full-width tabbed configuration for a single channel instance. Includes credential management, webhook URL display, config editing, and test capabilities.

Navigation state is managed by `ChannelsTab` via a `ChannelNavLevel` discriminated union (`catalog` | `list` | `config`).

Studio pages for channel management:

- `/projects/[projectId]` → Deployments → Channels tab

### API (Runtime)

#### Channel Connections (Project-Scoped CRUD)

| Method | Path                                               | Purpose                  |
| ------ | -------------------------------------------------- | ------------------------ |
| POST   | `/api/projects/:projectId/channel-connections`     | Create connection        |
| GET    | `/api/projects/:projectId/channel-connections`     | List connections         |
| GET    | `/api/projects/:projectId/channel-connections/:id` | Get connection           |
| PATCH  | `/api/projects/:projectId/channel-connections/:id` | Update connection        |
| DELETE | `/api/projects/:projectId/channel-connections/:id` | Deactivate (soft delete) |

Auth: `authMiddleware` → `requireProjectScope` → `requireProjectPermission('channel:*')`.

#### SDK Channels (Project-Scoped CRUD)

| Method | Path                                               | Purpose                       |
| ------ | -------------------------------------------------- | ----------------------------- |
| GET    | `/api/projects/:projectId/sdk-channels`            | List SDK channels (paginated) |
| POST   | `/api/projects/:projectId/sdk-channels`            | Create SDK channel            |
| GET    | `/api/projects/:projectId/sdk-channels/:channelId` | Get channel details           |
| PATCH  | `/api/projects/:projectId/sdk-channels/:channelId` | Update channel config         |
| DELETE | `/api/projects/:projectId/sdk-channels/:channelId` | Delete channel                |

Deprecated compatibility endpoint (non-canonical for SDK session bootstrap):

- `POST /api/projects/:projectId/sdk-channels/:channelId/token`

Auth: `authMiddleware` → `requireProjectScope` → `requireProjectPermission('channel:*')`.

#### SDK Init & Widget Config

| Method | Path                            | Purpose                                       |
| ------ | ------------------------------- | --------------------------------------------- |
| POST   | `/api/v1/sdk/init`              | Exchange `pk_*` API key for SDK session token |
| POST   | `/api/v1/sdk/refresh`           | Refresh SDK session token                     |
| GET    | `/api/v1/sdk/config/:projectId` | Get widget config (public, X-API-Key auth)    |

#### Inbound Webhooks

| Method | Path                                                                    | Purpose                                    |
| ------ | ----------------------------------------------------------------------- | ------------------------------------------ |
| GET    | `/api/v1/channels/:channelType/webhook`                                 | Meta webhook verification (GET challenge)  |
| POST   | `/api/v1/channels/:channelType/webhook`                                 | Generic webhook (identifier from body)     |
| POST   | `/api/v1/channels/:channelType/webhook/:connectionIdentifier`           | Explicit identifier webhook                |
| POST   | `/api/v1/channels/:channelType/:provider/webhook`                       | Provider-specific (e.g., WhatsApp/Infobip) |
| POST   | `/api/v1/channels/:channelType/:provider/webhook/:connectionIdentifier` | Provider-specific with identifier          |
| POST   | `/api/v1/channels/slack/slash/:connectionIdentifier`                    | Slack slash commands                       |

#### Voice Channels

| Method | Path                                                                                      | Purpose                                   |
| ------ | ----------------------------------------------------------------------------------------- | ----------------------------------------- |
| POST   | `/api/v1/channels/vxml/hooks/:streamId`                                                   | VXML/IVR synchronous webhook              |
| POST   | `/api/v1/channels/genesys/hooks/:streamId`                                                | Genesys Bot Connector synchronous webhook |
| POST   | `/api/v1/channels/audiocodes/webhook/:identifier`                                         | AudioCodes conversation creation          |
| POST   | `/api/v1/channels/audiocodes/webhook/:identifier/conversation/:conversationId/activities` | AudioCodes activities                     |
| POST   | `/api/v1/channels/audiocodes/webhook/:identifier/conversation/:conversationId/refresh`    | AudioCodes session refresh                |
| POST   | `/api/v1/channels/audiocodes/webhook/:identifier/conversation/:conversationId/disconnect` | AudioCodes disconnect                     |
| GET    | `/api/v1/voice/capabilities`                                                              | Check configured voice services           |
| POST   | `/api/v1/voice/token`                                                                     | Generate Twilio access token              |
| POST   | `/api/v1/voice/connect`                                                                   | Twilio call connect webhook               |
| POST   | `/api/v1/voice/status`                                                                    | Twilio status callback                    |

#### HTTP Async Channel

| Method | Path                                            | Purpose                    |
| ------ | ----------------------------------------------- | -------------------------- |
| POST   | `/api/v1/channels/http-async/subscribe`         | Register callback URL      |
| GET    | `/api/v1/channels/http-async/subscriptions`     | List subscriptions         |
| GET    | `/api/v1/channels/http-async/subscriptions/:id` | Get subscription details   |
| PATCH  | `/api/v1/channels/http-async/subscriptions/:id` | Update subscription        |
| DELETE | `/api/v1/channels/http-async/subscriptions/:id` | Deactivate subscription    |
| POST   | `/api/v1/channels/http-async/message`           | Send message (returns 202) |
| GET    | `/api/v1/channels/http-async/deliveries/:id`    | Check delivery status      |

#### Channel OAuth

| Method | Path                                           | Purpose               |
| ------ | ---------------------------------------------- | --------------------- |
| POST   | `/api/v1/channel-oauth/:channelType/authorize` | Initiate OAuth flow   |
| GET    | `/api/v1/channel-oauth/:channelType/callback`  | Handle OAuth callback |

#### A2A (Agent-to-Agent)

| Method | Path                                        | Purpose                   |
| ------ | ------------------------------------------- | ------------------------- |
| GET    | `/a2a/:connectionId/.well-known/agent.json` | Agent card discovery      |
| POST   | `/a2a/:connectionId`                        | JSON-RPC message endpoint |

WebSocket:

- `ws://host:port/ws/sdk` — SDK WebSocket connections
- `ws://host:port/ws/audiocodes/:identifier/conversation/:conversationId` — AudioCodes response streaming
- `ws://host:port/voice/media` — Twilio voice media streaming

### API (Studio)

| Method           | Path                                    | Purpose                           |
| ---------------- | --------------------------------------- | --------------------------------- |
| GET/POST         | `/api/runtime/sdk-channels`             | Proxy SDK channel CRUD to runtime |
| GET/PATCH/DELETE | `/api/runtime/sdk-channels/[channelId]` | Proxy single channel ops          |
| GET              | `/api/admin/channel-connections`        | Admin view of all connections     |
| GET              | `/api/admin/sdk-channels`               | Admin view of all SDK channels    |
| POST/GET         | `/api/sdk/keys`                         | Manage public API keys            |
| GET/DELETE       | `/api/sdk/keys/[keyId]`                 | Manage single API key             |
| POST             | `/api/sdk/share`                        | Generate share URL                |
| POST             | `/api/sdk/share/exchange`               | Exchange share token              |
| GET              | `/api/sdk/embed/[projectId]`            | Embed script                      |
| GET              | `/api/sdk/widget/[projectId]`           | Widget config                     |
| POST             | `/api/sdk/preview-token`                | Preview token generation          |

### Admin Portal

Admin endpoints provide cross-tenant visibility:

- `GET /api/admin/channel-connections` — List all connections across tenants
- `GET /api/admin/sdk-channels` — List all SDK channels across tenants

Tenant-scoped admin routes:

- `GET /api/tenants/:tenantId/sdk-channels` — List SDK channels for a tenant

### Channel Integration

Channels are organized by their ingress and delivery patterns:

| Pattern                 | Channels                                                                          | Description                                                 |
| ----------------------- | --------------------------------------------------------------------------------- | ----------------------------------------------------------- |
| Async webhook → BullMQ  | Slack, LINE, Teams, WhatsApp, Messenger, Instagram, Twilio SMS, Telegram, Zendesk | Inbound webhook enqueued, response delivered asynchronously |
| Synchronous webhook     | VXML, Genesys                                                                     | Response returned in the same HTTP response                 |
| WebSocket bidirectional | SDK, AG-UI, Kore VG, Pipeline Voice, LiveKit, AudioCodes (response only)          | Real-time streaming via WebSocket                           |
| SMTP inbound            | Email                                                                             | Embedded SMTP server receives inbound email                 |
| API (request/response)  | HTTP, API, HTTP Async                                                             | Direct API access or webhook subscription model             |
| Protocol                | A2A                                                                               | JSON-RPC with SSE streaming support                         |

---

## 9. Data Model

### Collections / Tables

```
Collection: channel_connections
Fields:
  - _id: string (UUID v7)
  - tenantId: string (required, indexed)
  - projectId: string (required, indexed)
  - agentId: string | null
  - deploymentId: string | null
  - environment: string | null
  - channelType: string (required, enum: 22 types)
  - externalIdentifier: string (required, 1-255 chars)
  - displayName: string | null
  - encryptedCredentials: string | null (encrypted via plugin)
  - authProfileId: string | null (references auth_profiles)
  - verifyTokenHash: string | null (SHA-256 for Meta webhook verification)
  - config: Mixed (channel-specific config, may contain encryptedInboundAuthToken)
  - status: 'active' | 'inactive'
  - _v: number
  - createdAt, updatedAt: Date
Indexes:
  - { channelType: 1, externalIdentifier: 1 } (unique, partial: status=active)
  - { tenantId: 1, channelType: 1 }
  - { tenantId: 1, projectId: 1 }
  - { tenantId: 1, deploymentId: 1 }
  - { tenantId: 1, projectId: 1, createdAt: -1 }
  - { channelType: 1, verifyTokenHash: 1 } (unique, sparse)
Plugins: tenantIsolationPlugin, encryptionPlugin (on encryptedCredentials)
```

```
Collection: sdk_channels
Fields:
  - _id: string (UUID v7)
  - tenantId: string (required, indexed)
  - projectId: string (required, indexed)
  - deploymentId: string | null
  - name: string (required)
  - channelType: string (required)
  - publicApiKeyId: string (required, references public API keys)
  - config: Mixed
  - isActive: boolean (default true)
  - environment: 'dev' | 'staging' | 'production' | null
  - followEnvironment: boolean (default true)
  - secretKey: string | null (encrypted HMAC secret for identity verification)
  - hmacEnforcement: 'disabled' | 'optional' | 'required'
  - _v: number
  - createdAt, updatedAt: Date
Indexes:
  - { tenantId: 1, projectId: 1, name: 1 } (unique)
  - { tenantId: 1, projectId: 1 }
  - { publicApiKeyId: 1 }
  - { projectId: 1, environment: 1, followEnvironment: 1 }
Plugins: tenantIsolationPlugin
```

```
Collection: channel_sessions
Fields:
  - _id: string (UUID v7)
  - tenantId: string (required, indexed)
  - channelConnectionId: string (required)
  - externalSessionKey: string (required, 1-512 chars)
  - sessionId: string (required, references runtime session)
  - projectId: string (required)
  - agentId: string | null
  - metadata: Mixed
  - emailMessageIds: string[] (RFC 5322 Message-IDs for email threading)
  - status: 'active' | 'inactive' | 'ended'
  - lastMessageAt: Date
  - _v: number
  - createdAt, updatedAt: Date
Indexes:
  - { tenantId: 1, externalSessionKey: 1 } (unique)
  - { channelConnectionId: 1 }
  - { sessionId: 1 }
  - { tenantId: 1, status: 1 }
  - { tenantId: 1, channelConnectionId: 1, lastMessageAt: -1 }
  - { tenantId: 1, channelConnectionId: 1, emailMessageIds: 1 } (partial)
  - { lastMessageAt: 1 } (TTL, conditional on CHANNEL_SESSION_RETENTION_DAYS > 0)
Plugins: tenantIsolationPlugin
```

### Key Relationships

- `channel_connections.authProfileId` → `auth_profiles._id` (credential resolution via dual-read)
- `channel_connections.deploymentId` → `deployments._id` (optional pinned deployment)
- `sdk_channels.publicApiKeyId` → `public_api_keys._id` (API key for auth)
- `channel_sessions.channelConnectionId` → `channel_connections._id`
- `channel_sessions.sessionId` → runtime session (in Redis)
- `channel_sessions.projectId` → `projects._id`

---

## 10. Key Implementation Files

### Domain / Core Logic

| File                                                        | Purpose                                                                                                   |
| ----------------------------------------------------------- | --------------------------------------------------------------------------------------------------------- |
| `apps/runtime/src/channels/manifest.ts`                     | Single source of truth: defines all 27 channel types' capabilities, auth modes, ingress/delivery patterns |
| `apps/runtime/src/channels/types.ts`                        | Core types: `ChannelType`, `ChannelAdapter`, `ResolvedConnection`, `InboundJobPayload`, `ChannelOutput`   |
| `apps/runtime/src/channels/channel-behavior-contract.ts`    | Source-of-truth parity contract for channel families, auth/delivery expectations, and manifest alignment  |
| `apps/runtime/src/channels/registry.ts`                     | Singleton registry of channel adapters; initializes all adapters at startup                               |
| `apps/runtime/src/channels/connection-resolver.ts`          | Resolves connections by type+identifier, by ID, or by verify_token; decrypts credentials                  |
| `apps/runtime/src/channels/session-resolver.ts`             | Maps external session keys to runtime sessions; handles email thread resolution                           |
| `apps/runtime/src/channels/pipeline/`                       | Message processing pipeline: session factory, lifecycle manager, message pipeline                         |
| `apps/runtime/src/channels/security/callback-url-policy.ts` | SSRF protection for webhook callback URLs                                                                 |

### Channel Adapters

| File                                                       | Channel                                                                      |
| ---------------------------------------------------------- | ---------------------------------------------------------------------------- |
| `apps/runtime/src/channels/adapters/slack-adapter.ts`      | Slack (+ `slack-stream-buffer.ts`, `slack-stream-client.ts`, `slack-file-*`) |
| `apps/runtime/src/channels/adapters/msteams-adapter.ts`    | MS Teams (+ `msteams-auth.ts`, `msteams-stream-*`, `msteams-file-*`)         |
| `apps/runtime/src/channels/adapters/whatsapp-adapter.ts`   | WhatsApp meta adapter (delegates to providers)                               |
| `apps/runtime/src/channels/adapters/whatsapp-provider.ts`  | WhatsApp provider registry (Meta Cloud, Infobip, Gupshup, Netcore)           |
| `apps/runtime/src/channels/adapters/messenger-adapter.ts`  | Facebook Messenger                                                           |
| `apps/runtime/src/channels/adapters/instagram-adapter.ts`  | Instagram Direct                                                             |
| `apps/runtime/src/channels/adapters/line-adapter.ts`       | LINE                                                                         |
| `apps/runtime/src/channels/adapters/telegram-adapter.ts`   | Telegram                                                                     |
| `apps/runtime/src/channels/adapters/twilio-sms-adapter.ts` | Twilio SMS                                                                   |
| `apps/runtime/src/channels/adapters/email-adapter.ts`      | Email (SMTP inbound, SMTP/Graph outbound)                                    |
| `apps/runtime/src/channels/adapters/zendesk-adapter.ts`    | Zendesk                                                                      |
| `apps/runtime/src/channels/adapters/http-async-adapter.ts` | HTTP Async                                                                   |
| `apps/runtime/src/channels/adapters/vxml-adapter.ts`       | VXML/IVR                                                                     |
| `apps/runtime/src/channels/adapters/audiocodes-adapter.ts` | AudioCodes VoiceAI Connect                                                   |
| `apps/runtime/src/channels/adapters/genesys-adapter.ts`    | Genesys Bot Connector                                                        |
| `apps/runtime/src/channels/adapters/korevg-adapter.ts`     | Kore Voice Gateway                                                           |
| `apps/runtime/src/channels/adapters/ag-ui-adapter.ts`      | AG-UI protocol                                                               |

### Routes / Handlers

| File                                                           | Purpose                                                                                              |
| -------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------- |
| `apps/runtime/src/routes/channel-connections.ts`               | CRUD for channel connections (project-scoped)                                                        |
| `apps/runtime/src/routes/channel-connection-identity-utils.ts` | Normalizes `identityVerification.providerVerificationStrength` and rejects legacy top-level payloads |
| `apps/runtime/src/routes/sdk-channels.ts`                      | CRUD for SDK channels + deprecated compatibility token route                                         |
| `apps/runtime/src/routes/sdk-init.ts`                          | SDK init (key exchange) + token refresh                                                              |
| `apps/runtime/src/routes/sdk.ts`                               | Widget config endpoint (public)                                                                      |
| `apps/runtime/src/routes/channel-webhooks.ts`                  | Generic webhook ingestion for all async channels                                                     |
| `apps/runtime/src/routes/channel-vxml.ts`                      | VXML/IVR synchronous voice webhook                                                                   |
| `apps/runtime/src/routes/channel-genesys.ts`                   | Genesys Bot Connector synchronous webhook                                                            |
| `apps/runtime/src/routes/channel-audiocodes.ts`                | AudioCodes Bot API (HTTP + WebSocket)                                                                |
| `apps/runtime/src/routes/channel-oauth.ts`                     | OAuth flow for channel connections (Slack, etc.)                                                     |
| `apps/runtime/src/routes/http-async-channel.ts`                | HTTP Async subscription management + message ingestion                                               |
| `apps/runtime/src/routes/voice.ts`                             | Twilio voice webhooks + token generation                                                             |
| `apps/runtime/src/services/queues/channel-queues.ts`           | BullMQ queues: `channel-inbound`, `webhook-delivery`                                                 |
| `apps/runtime/src/services/execution/channel-dispatcher.ts`    | 3-tier outbound delivery orchestration                                                               |
| `apps/runtime/src/websocket/connection-manager.ts`             | Bounded WebSocket connection manager used by SDK/debug handlers                                      |

### UI Components (Studio)

| File                                                                        | Purpose                                                                                   |
| --------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------- |
| `apps/studio/src/components/deployments/ChannelsTab.tsx`                    | Three-level navigation router (catalog → list → config)                                   |
| `apps/studio/src/components/deployments/channels/ChannelCatalog.tsx`        | Grid of channel types with instance counts                                                |
| `apps/studio/src/components/deployments/channels/ChannelInstanceList.tsx`   | Table of connections for a channel type                                                   |
| `apps/studio/src/components/deployments/channels/ChannelInstanceConfig.tsx` | Tabbed config view for a single instance                                                  |
| `apps/studio/src/components/deployments/channels/CreateInstanceDialog.tsx`  | New-instance creation flow with nested identity verification controls                     |
| `apps/studio/src/components/deployments/channels/tabs/ConfigurationTab.tsx` | Existing-instance edit flow for `identityVerification.providerVerificationStrength`       |
| `apps/studio/src/components/deployments/channels/channel-registry.tsx`      | Studio-side channel type definitions (icons, setup instructions, credential schemas)      |
| `apps/studio/src/components/deployments/channels/channel-icons.tsx`         | SVG icons for each channel type                                                           |
| `apps/studio/src/components/deployments/channels/types.ts`                  | Type definitions: `ChannelTypeId`, `ChannelTypeDef`, `ChannelInstance`, `ChannelNavLevel` |
| `apps/studio/src/components/deployments/ChannelCard.tsx`                    | Card component for channel display                                                        |
| `apps/studio/src/components/deployments/ChannelDetail.tsx`                  | Detail view for a single channel                                                          |

### Tests

| File                                                                              | Type        | Scenarios                               |
| --------------------------------------------------------------------------------- | ----------- | --------------------------------------- |
| `apps/runtime/src/__tests__/channel-adapter.test.ts`                              | unit        | Adapter interface conformance           |
| `apps/runtime/src/__tests__/channel-manifest.test.ts`                             | unit        | Manifest data integrity                 |
| `apps/runtime/src/__tests__/channel-manifest-conformance.test.ts`                 | unit        | Manifest-registry alignment             |
| `apps/runtime/src/__tests__/channel-connections-authz.test.ts`                    | unit        | Connection CRUD authorization           |
| `apps/runtime/src/__tests__/channels-authz.test.ts`                               | unit        | Channel authorization patterns          |
| `apps/runtime/src/__tests__/channel-environment.test.ts`                          | unit        | Environment-based deployment resolution |
| `apps/runtime/src/__tests__/channel-oauth-routes.test.ts`                         | unit        | OAuth flow routes                       |
| `apps/runtime/src/__tests__/channel-trace-utils.test.ts`                          | unit        | Channel tracing utilities               |
| `apps/runtime/src/__tests__/channel-voice-ingress-auth.test.ts`                   | unit        | Voice channel ingress token auth        |
| `apps/runtime/src/__tests__/channels-session-resolver.test.ts`                    | unit        | Session resolver logic                  |
| `apps/runtime/src/__tests__/session-resolver.test.ts`                             | unit        | Session resolver                        |
| `apps/runtime/src/__tests__/sdk-channels-authz.test.ts`                           | unit        | SDK channel authorization               |
| `apps/runtime/src/__tests__/middleware-sdk-auth.test.ts`                          | unit        | SDK auth middleware                     |
| `apps/runtime/src/__tests__/ws-sdk-handler.test.ts`                               | unit        | SDK WebSocket handler                   |
| `apps/runtime/src/__tests__/inbound-worker.test.ts`                               | unit        | BullMQ inbound worker processing        |
| `apps/runtime/src/__tests__/http-async-channel-authz.test.ts`                     | unit        | HTTP Async authorization                |
| `apps/runtime/src/__tests__/connection-resolver-isolation.test.ts`                | unit        | Connection resolver tenant isolation    |
| `apps/runtime/src/__tests__/webhook-url-generation.test.ts`                       | unit        | Webhook URL generation from manifest    |
| `apps/runtime/src/__tests__/callback-url-policy.test.ts`                          | unit        | SSRF protection for callbacks           |
| `apps/runtime/src/__tests__/typing-indicators.test.ts`                            | unit        | Typing indicator dispatch               |
| `apps/runtime/src/__tests__/escalation-channel-templates.test.ts`                 | unit        | Escalation templates per channel        |
| `apps/runtime/src/__tests__/actions-channel-roundtrip.test.ts`                    | unit        | Action set round-trip through channels  |
| `apps/runtime/src/__tests__/email-channel-e2e.test.ts`                            | integration | Email channel end-to-end                |
| `apps/runtime/src/__tests__/webhooks/channel-webhooks-route.test.ts`              | unit        | Webhook route handling                  |
| `apps/runtime/src/__tests__/webhooks/channel-webhooks-twilio-route.test.ts`       | unit        | Twilio webhook routing                  |
| `apps/runtime/src/__tests__/webhooks/slack-events.test.ts`                        | unit        | Slack event processing                  |
| `apps/runtime/src/__tests__/webhooks/gupshup-webhook-route.test.ts`               | unit        | Gupshup WhatsApp webhooks               |
| `apps/runtime/src/__tests__/webhooks/infobip-webhook-route.test.ts`               | unit        | Infobip WhatsApp webhooks               |
| `apps/runtime/src/__tests__/adapters/*.test.ts`                                   | unit        | ~30+ adapter-specific tests             |
| `apps/studio/src/__tests__/channel-integration.test.ts`                           | unit        | Studio channel integration              |
| `apps/studio/src/__tests__/channel-normalizer.test.ts`                            | unit        | Channel data normalization              |
| `apps/studio/src/__tests__/channel-provider-awareness.test.tsx`                   | unit        | Provider-aware UI components            |
| `apps/studio/src/__tests__/channel-registry.test.ts`                              | unit        | Studio channel registry                 |
| `apps/runtime/src/services/channel-oauth/__tests__/channel-oauth-service.test.ts` | unit        | OAuth service                           |

---

## 11. Configuration

### Environment Variables

| Variable                         | Default        | Description                                                   |
| -------------------------------- | -------------- | ------------------------------------------------------------- |
| `RUNTIME_PUBLIC_BASE_URL`        | (none)         | Public URL for webhook URL generation                         |
| `RUNTIME_BASE_URL`               | (none)         | Fallback base URL                                             |
| `CHANNEL_SESSION_RETENTION_DAYS` | `0` (disabled) | TTL for channel sessions (MongoDB TTL index)                  |
| `VXML_SHARED_SECRET`             | (none)         | Shared secret for VXML ingress auth                           |
| `TWILIO_ACCOUNT_SID`             | (none)         | Twilio account SID                                            |
| `TWILIO_AUTH_TOKEN`              | (none)         | Twilio auth token                                             |
| `DEEPGRAM_API_KEY`               | (none)         | Deepgram API key for voice STT                                |
| `ELEVENLABS_API_KEY`             | (none)         | ElevenLabs API key for voice TTS                              |
| `LIVEKIT_URL`                    | (none)         | LiveKit server URL                                            |
| `LIVEKIT_API_KEY`                | (none)         | LiveKit API key                                               |
| `LIVEKIT_API_SECRET`             | (none)         | LiveKit API secret                                            |
| `NODE_ENV`                       | (none)         | Controls ingress auth enforcement (relaxed in non-production) |

### Runtime Configuration

- **Channel manifest** (`CHANNEL_MANIFEST`): Static, code-defined. To add a new channel, add a row to `manifest.ts`.
- **Per-connection config**: Stored in `channel_connections.config` (Mixed type). Voice channels store `bargeIn`, `language`, `voiceName`, `userNoInputTimeoutMs`, `expiresSeconds`, `publicBaseUrl`.
- **Identity verification config**: Channel connection create/update flows normalize verification policy under `identityVerification.providerVerificationStrength`; legacy top-level `providerVerificationStrength` is rejected by the runtime route utils.
- **SDK channel config**: Stored in `sdk_channels.config`. Widget configuration includes `mode`, `position`, `theme`, `welcomeMessage`, `placeholderText`, `voiceEnabled`, `chatEnabled`.
- **HMAC enforcement**: Configured per SDK channel (`hmacEnforcement`: `disabled` | `optional` | `required`) and persisted on `sdk_channels`; stale `authProfileId` input is stripped by the repo layer rather than stored.
- **OAuth providers**: Registered at startup via `registerChannelOAuthProviders()`. Currently supports Slack OAuth.

### DSL / Agent IR

Channels are referenced in the IR via `channelType` fields on sessions and execution contexts. The channel type flows through:

1. SDK init → `channelType: 'web'` (or `mobile_ios`, `mobile_android`, `voice`, `api`)
2. Channel connection → `channelType` from the connection record
3. Runtime session → `channelType` stored on session creation
4. Prompt builder → Channel-aware prompt modifications (e.g., voice prompts are shorter)

---

## 12. Runtime Integration

### Lifecycle

Channel processing follows one of three patterns:

**Async Webhook Pattern** (Slack, Teams, WhatsApp, Messenger, Instagram, LINE, Telegram, Twilio SMS, Zendesk):

1. External platform POSTs to webhook endpoint
2. Adapter verifies signature (HMAC, JWT, or token)
3. Connection resolver maps `channelType` + `externalIdentifier` → tenant/project
4. Message normalized to `NormalizedIncomingMessage`
5. Job enqueued to `channel-inbound` BullMQ queue (idempotent via job ID)
6. Inbound worker processes: session resolution → runtime execution → response delivery

**Synchronous Webhook Pattern** (VXML, Genesys):

1. Telephony platform POSTs with call/conversation ID
2. Connection resolved, ingress token verified
3. Session resolved or created (with lock acquisition)
4. `executeMessage()` called synchronously
5. Response formatted (VXML XML or Genesys JSON) and returned in same HTTP response
6. Lock released

**WebSocket/Real-time Pattern** (SDK, AG-UI, Voice):

1. Client establishes WebSocket connection (`/ws/sdk`, `/voice/media`)
2. Auth verified (SDK token, Twilio signature)
3. Messages flow bidirectionally with streaming support
4. Session managed in-memory with Redis backing

### Dependencies

- **Redis**: BullMQ queues, session locks (`SET NX PX`), session storage
- **MongoDB**: Channel connections, SDK channels, channel sessions
- **Encryption Service**: Credential encryption/decryption
- **Auth Profiles**: Credential resolution via `dualReadCredentials` (auth profile first, legacy fallback)
- **Runtime Executor**: `executeMessage()` for agent response generation
- **Session Factory**: `createRuntimeSession()` for new session creation

### Event Flow

Channel operations emit trace events via `emitChannelResponseSent()`:

- `channel.response.sent` — emitted after successful response delivery
- Includes: `sessionId`, `channelType`, `latencyMs`, `tenantId`, `projectId`, `configHash`

Webhook processing events:

- Enqueue: logged with `channelType`, `messageCount`, `connectionId`
- Signature failures: logged as warnings
- Connection resolution failures: logged as warnings

---

## 13. Admin Integration

Admin endpoints provide cross-tenant operational visibility:

- **Channel Connections**: `GET /api/admin/channel-connections` lists all connections with tenant/project context
- **SDK Channels**: `GET /api/admin/sdk-channels` lists all SDK channels
- **Tenant-scoped**: `GET /api/tenants/:tenantId/sdk-channels` for tenant-specific views

No admin-level channel creation or modification is supported — all management is project-scoped through the standard CRUD endpoints.

---

## 14. Non-Functional Concerns

### Isolation & Multitenancy

| Concern           | Requirement / Expectation                                                                                                                                       |
| ----------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Project isolation | Channel CRUD routes are project-scoped and must include `projectId`; cross-project CRUD access returns `404`.                                                   |
| Tenant isolation  | Channel connections, SDK channels, and ingress resolution must stay bounded to the owning tenant even when external identifiers are guessable.                  |
| User isolation    | SDK-backed channel sessions and downstream session/message APIs must enforce caller/session ownership instead of treating all channel traffic as tenant-global. |

### Performance

- Webhook endpoints return 200 within ~50ms (enqueue only, no processing)
- VXML/Genesys synchronous channels: latency depends on LLM execution time
- BullMQ inbound queue: 3 retry attempts with exponential backoff (2s base)
- Channel session resolution: single MongoDB query with compound index
- SDK init: ~100ms (key validation + optional channel creation + JWT signing)

### Security

- **Credential encryption**: All channel credentials encrypted at rest via `encryptionPlugin` or manual `encryptForTenant`
- **Webhook signature verification**: Per-adapter HMAC/JWT/token validation
- **Ingress auth enforcement**: Fail closed when ingress secrets are missing; query-token auth is allowlisted only for `audiocodes_http`, `audiocodes_ws`, `korevg_ws`, and `vxml_http` until those providers migrate off URL tokens
- **SDK HMAC verification**: Optional identity verification for embedded widgets
- **OAuth CSRF protection**: State parameter with allowlisted redirect URIs
- **Callback URL validation**: SSRF protection via `assertAllowedCallbackUrl`
- **Token security**: SDK session tokens expire after 4 hours; first-party preview/share artifacts are fragment-delivered and exchanged through Runtime; legacy `sdk_share` control-plane token routes are compatibility-only and not canonical bootstrap
- **Origin validation**: SDK widget config validates origin against allowed origins
- **Project isolation**: All CRUD operations scoped to `tenantId` + `projectId`

### Scalability

- **Horizontal scaling**: Stateless webhook handlers; BullMQ distributes work across workers
- **Connection resolution**: Indexed lookups (compound unique index on `channelType` + `externalIdentifier`)
- **Queue management**: `removeOnComplete: 1000`, `removeOnFail: 5000` prevents queue growth
- **Session lock**: Redis distributed lock (`SET NX PX`) prevents concurrent processing of same session

### Observability

- **Structured logging**: All channel routes use `createLogger('channel-*')` with context fields
- **Trace events**: `channel.response.sent` events with latency and context
- **Masked identifiers**: External identifiers masked in warning logs (`maskIdentifier`)
- **Audit logging**: OAuth flows emit audit events via `writeAuditLog`
- **OpenAPI documentation**: OAuth and SDK routes use `createOpenAPIRouter` for auto-generated docs

### Data Lifecycle

- `ChannelSession` records can outlive Redis runtime sessions when `CHANNEL_SESSION_RETENTION_DAYS` is unset or `0`, so stale mappings can accumulate until manual cleanup or later session reuse.
- Runtime sessions expire out of Redis after roughly 30 minutes, while channel-session mappings live in MongoDB and are reused or refreshed on later inbound traffic.
- Connection records are soft-deactivated rather than immediately hard-deleted in some flows so ingress resolution can fail safely without losing audit context.

---

## 15. Delivery Plan / Work Breakdown

1. Close control-plane and ingress gaps
   1.1 Add channel health and connectivity validation where gaps are currently documented.
   1.2 Revisit stale-session TTL behavior between Redis runtime sessions and Mongo channel-session mappings.
2. Improve security and operational guardrails
   2.1 Add per-connection rate limiting or equivalent abuse controls where tenant-level limits are insufficient.
   2.2 Harden bootstrap lookup paths that currently rely on uniqueness rather than fully scoped tenant filters.
3. Expand verification depth
   3.1 Add broader end-to-end coverage across webhook, voice, and non-SDK digital channels.
   3.2 Add browser-level and provider-level validation where only integration coverage exists today.

---

## 16. Success Metrics

| Metric                               | Baseline                    | Target                                                      | How Measured                          |
| ------------------------------------ | --------------------------- | ----------------------------------------------------------- | ------------------------------------- |
| Channel connection CRUD success rate | TBD                         | High success with low operator retries                      | Runtime/admin API error rates         |
| Inbound delivery correctness         | TBD                         | No duplicate sessions or cross-scope leaks in audited flows | E2E coverage plus trace/event review  |
| Manifest coverage                    | Existing 27 supported types | All supported types remain represented in tests/docs        | Manifest vs docs/test inventory audit |

---

## 17. Open Questions

1. Should channel-level health checks and connectivity probes become first-class control-plane features instead of remaining a gap?
2. Should per-connection rate limiting live inside the channel layer or stay entirely in shared tenant-level rate limiting?
3. Should bootstrap connection resolution stop relying on uniqueness assumptions and require explicit tenant scoping everywhere?

---

## 18. Gaps, Known Issues & Limitations

| ID      | Description                                                                                                                                                  | Severity | Status                       |
| ------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------ | -------- | ---------------------------- |
| GAP-001 | Channel session TTL (`CHANNEL_SESSION_RETENTION_DAYS`) defaults to 0 (disabled) — stale sessions accumulate                                                  | Medium   | Open                         |
| GAP-002 | Runtime sessions expire in Redis (30 min) but channel sessions in MongoDB have no TTL, causing `reuseOrRefreshSession` to recreate runtime sessions          | Medium   | Mitigated (auto-refresh)     |
| GAP-003 | `voice` and `voice_livekit` channel types are not connection-eligible — no CRUD management                                                                   | Low      | By Design                    |
| GAP-004 | No built-in rate limiting per channel connection (only tenant-level rate limits apply)                                                                       | Medium   | Open                         |
| GAP-005 | WhatsApp provider resolution relies on URL path (`/:channelType/:provider/webhook`) — only WhatsApp supports multi-provider                                  | Low      | By Design                    |
| GAP-006 | Email channel ingress auth is `none` — relies on SMTP server level authentication                                                                            | Low      | By Design                    |
| GAP-007 | No channel health monitoring or connectivity checks                                                                                                          | Medium   | Open                         |
| GAP-008 | Connection resolver bootstrap paths still rely on unique identifiers for some lookups rather than explicit tenant-qualified caller context                   | Low      | By Design (bootstrap lookup) |
| GAP-009 | WebSocket connection state is now bounded through `WebSocketConnectionManager`; keep the limit/cleanup settings aligned with production traffic expectations | Medium   | Mitigated                    |
| GAP-010 | Provider API base URL override for channel adapters lacks SSRF validation — test-mode override could redirect live credentials to arbitrary hosts (Audit M7) | Medium   | Open                         |

---

## 19. WebSocket and SDK Transport Hardening (2026-03-20 Audit)

The 2026-03-20 five-auditor review confirmed several hardening measures now in place for WebSocket and SDK channel transports:

### WebSocket Auth: Subprotocol-Based Token Transport

SDK WebSocket authentication has been moved from query-string parameters to the `Sec-WebSocket-Protocol` subprotocol header. The live contract on `/ws/sdk` now requires `Sec-WebSocket-Protocol: sdk-auth,<sdk_session_token>`. Query-string token transport is explicitly rejected for SDK flows. The internal Studio/Runtime debug socket (`/ws`) similarly uses `Sec-WebSocket-Protocol: web-debug-auth,<access_token>`.

### Provider API Base URL Override

Channel adapters (LINE, Telegram, Slack, Twilio) now support configurable provider API base URLs. This is gated by environment variable and intended for test-mode usage so that E2E tests can redirect provider calls to local harnesses without hitting live APIs. The override is applied per-connection via the connection config.

**Known issue (M7):** The provider API base override does not currently validate the target URL against SSRF protections. In test mode this is acceptable, but the override path should be hardened before any production use.

### Pre-Auth Message Buffering

WebSocket handlers implement pre-auth message buffering with both count and byte-size limits. Messages received before authentication completes are buffered up to a configured maximum count and total byte threshold. Messages exceeding either limit are dropped. This prevents memory exhaustion from unauthenticated senders.

### SDK Connection Limits

The SDK WebSocket handler enforces a `MAX_SDK_CLIENTS` limit on concurrent connections. New connections beyond the limit are rejected during the upgrade handshake.

**2026-04-03 note:** The old unbounded-map finding is now mitigated. Both `websocket/handler.ts` and `websocket/sdk-handler.ts` use `WebSocketConnectionManager`, so connection counts are bounded and stale-state cleanup is centralized.

---

## 20. Testing

### E2E Test Scenarios

| #   | Scenario                                         | Status | Test File                                                                                                                                       |
| --- | ------------------------------------------------ | ------ | ----------------------------------------------------------------------------------------------------------------------------------------------- |
| 1   | Channel control-plane CRUD + project isolation   | PASS   | `apps/runtime/src/__tests__/channels/channels-control-plane.e2e.test.ts`                                                                        |
| 2   | HTTP Async identity continuity and callback flow | PASS   | `apps/runtime/src/__tests__/channels/http-async-identity-continuity.e2e.test.ts`                                                                |
| 3   | Voice ingress and session/IR wiring              | PASS   | `apps/runtime/src/__tests__/channels/channels-voice-ingress.e2e.test.ts`, `apps/runtime/src/__tests__/channels/voice-ir-resolution.e2e.test.ts` |
| 4   | Voice live pipeline smoke                        | PASS   | `apps/runtime/src/__tests__/channels/voice-pipeline-twilio.live.e2e.test.ts`                                                                    |
| 5   | A2A message lifecycle (covered in A2A feature)   | PASS   | `packages/a2a/src/__tests__/cross-tenant-e2e.test.ts`                                                                                           |

### Integration Test Scenarios

| #   | Scenario                                            | Status | Test File                                                                                                                                                                                                                           |
| --- | --------------------------------------------------- | ------ | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 1   | Channel behavior contract / manifest alignment      | PASS   | `apps/runtime/src/__tests__/channels/channel-behavior-contract.test.ts`, `apps/runtime/src/__tests__/channel-manifest-conformance.test.ts`                                                                                          |
| 2   | SDK channel CRUD + HMAC/WebSocket handling          | PASS   | `apps/runtime/src/__tests__/sdk-channels-authz.test.ts`, `apps/runtime/src/__tests__/channels/ws-sdk-handler.test.ts`                                                                                                               |
| 3   | Channel dispatcher multi-tier delivery              | PASS   | `apps/runtime/src/__tests__/execution/channel-dispatcher.test.ts`                                                                                                                                                                   |
| 4   | Channel connection identity normalization           | PASS   | `apps/runtime/src/__tests__/routes/channel-connection-identity-utils.test.ts`                                                                                                                                                       |
| 5   | Channel environment / session resolution            | PASS   | `apps/runtime/src/__tests__/channel-environment.test.ts`, `apps/runtime/src/__tests__/channels-session-resolver.test.ts`                                                                                                            |
| 6   | Provider routing and OAuth providers                | PASS   | `apps/runtime/src/__tests__/channels/adapters/infobip-provider.test.ts`, `apps/runtime/src/__tests__/channels/adapters/gupshup-provider.test.ts`, `apps/runtime/src/services/channel-oauth/__tests__/channel-oauth-service.test.ts` |
| 7   | Studio channel normalization and provider awareness | PASS   | `apps/studio/src/__tests__/channel-normalizer.test.ts`, `apps/studio/src/__tests__/components/channel-provider-awareness.test.tsx`                                                                                                  |

### Unit Test Coverage

| Package        | Tests                                                  | Area                                                                                             |
| -------------- | ------------------------------------------------------ | ------------------------------------------------------------------------------------------------ |
| `apps/runtime` | 150+ relevant channel / voice / sdk-handler test files | Adapter behavior, control plane, voice ingress, dispatcher, provider routing, session continuity |
| `apps/runtime` | representative E2E coverage                            | Control plane, HTTP Async identity continuity, voice ingress, voice live pipeline                |
| `apps/studio`  | provider-aware channel UI coverage                     | Registry, normalizer, provider awareness, integration                                            |

> Full testing details: [docs/testing/channels.md](../testing/channels.md)

---

## 21. References

- Design docs: `docs/archive/plans-2026-03-early/2026-03-02-channel-hardening-plan.md`
- Related features: [A2A Integration](./a2a-integration.md), [SDK Channel Creation](./sub-features/sdk-channel-creation.md)
- Setup guides: `docs/setup/KOREVG_SETUP_GUIDE.md`
- Channel manifest: `apps/runtime/src/channels/manifest.ts`

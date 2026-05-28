# Feature: Connectors Platform

**Doc Type**: MAJOR FEATURE
**Parent Feature**: N/A
**Feature ID:** F006
**Slug:** connectors
**Status:** BETA
**Feature Area(s):** `integrations`, `agent lifecycle`, `enterprise`
**Package(s):** `packages/connectors`, `packages/connectors/base`, `packages/connectors/sharepoint`, `apps/runtime`, `apps/search-ai`, `apps/studio`
**Owner(s):** Platform Team
**Testing Guide:** `../testing/connectors.md`
**Last Updated:** 2026-03-25

---

## 1. Introduction / Overview

### Problem Statement

Enterprise customers need to connect their agents and SearchAI knowledge bases to dozens of external data sources (SharePoint, Slack, Salesforce, Jira, etc.) and workflow tools. Without a unified connector framework, each integration requires bespoke auth, sync, and error-handling code -- leading to inconsistent behavior, security gaps (token handling), and unsustainable maintenance as the catalog grows.

The Connectors Platform provides a single SDK, runtime, and UI surface for:

- Declaring and registering connectors (actions + triggers + auth)
- Managing connections (CRUD, OAuth2, credential encryption)
- Executing connector actions as agent tools during conversations
- Orchestrating data sync (full, delta, checkpoint-based pause/resume) for SearchAI ingestion
- Handling inbound webhooks, polling, and cron triggers for workflow automation

### Goal Statement

Provide a unified, secure, and extensible connector framework that enables agents to interact with external services, knowledge bases to sync enterprise data, and workflows to trigger on external events — all with encrypted credentials, tenant isolation, and observability built in.

### Summary

The Connectors Platform spans three use cases: (1) agent tool execution via `ConnectorToolExecutor` (credential resolution, decryption, timeout enforcement), (2) enterprise data sync via `IConnector` interface (full/delta sync, permission crawling, checkpoint-based pause/resume), and (3) workflow triggers via `TriggerEngine` (webhook with HMAC, polling, cron). It wraps 25 Activepieces pieces and imports 600+ Nango OAuth provider configs. Connections are encrypted at rest with tenant-scoped AES-256-GCM keys. The Studio UI provides a connections page with catalog, OAuth flows, and enterprise connector wizards.

---

## 2. Scope

### 2.1 Goals

- **Connector SDK** (`packages/connectors/`): types, property builder, registry, loader, compiler bridge
- **Connection Management**: CRUD service, OAuth2 flows (authorization code, device code, PKCE), encrypted credential storage, token refresh with distributed locking
- **Connector Execution**: `ConnectorToolExecutor` (agent-side), `WorkflowToolExecutor` (workflow-side), timeout enforcement
- **Trigger Engine**: webhook handler (HMAC, replay protection, dedup), polling scheduler, cron scheduler
- **Activepieces Adapter**: wraps 25 AP piece packages as native connectors
- **Nango Adapter**: imports 600+ OAuth2 provider configs for token URL, refresh URL, scopes, PKCE
- **Enterprise Connectors** (`packages/connectors/base/`, `packages/connectors/sharepoint/`): IConnector interface, base sync coordinator, filter engine, permission crawler, Graph client
- **SearchAI Integration**: connector CRUD routes, discovery, recommendations, delta sync scheduler, webhook renewal, connector repository
- **Studio UI**: connections page (status bar, connection cards, catalog grid), connector detail panel, connector filter section, create connection modal, OAuth callback page, enterprise connector wizard
- **Runtime Channel Connections**: channel OAuth service, provider-specific OAuth (Slack, MS Teams, Meta), channel connection routes
- **Workflow Engine Connections**: connection CRUD, OAuth callback, connection test, connector catalog API
- **CLI**: `connector create|list|delete|auth|filter|permission|sync` commands
- **Database Models**: ConnectorConfig, ConnectorConnection, ConnectorKVStore, ConnectorSchema, ConnectorDiscovery, ConnectorRecommendation, DocumentPermission, SyncCheckpoint, DriveDeltaToken, WebhookSubscription, EndUserOAuthToken, ChannelConnection, WebhookDelivery

### 2.2 Non-Goals (Out of Scope)

- Agent execution engine (uses connectors but not part of this feature)
- SearchAI ingestion pipeline (embedding, chunking, vector storage)
- BullMQ flow orchestration internals
- DSL/ABL language features beyond connector tool declarations

## 3. User Stories

### US-1: Platform Admin Manages Connections

As a platform admin, I want to create, test, and manage connections to external services so that agents and knowledge bases can use them without exposing raw credentials.

**Acceptance Criteria:**

- Can create connections with API key, bearer token, OAuth2, or custom auth
- Credentials are encrypted with tenant-scoped keys before storage
- Connection test validates the credentials against the external service
- Expired OAuth2 tokens are automatically refreshed with distributed locking
- Connections can be revoked or deleted, cascading to dependent resources

### US-2: Agent Uses Connector Actions as Tools

As an agent author, I want to declare connector actions as tools in ABL DSL so that agents can call Slack, Stripe, Jira, etc. during conversations.

**Acceptance Criteria:**

- Connector actions are converted to tool definitions via `connectorActionToToolDefinition`
- `ConnectorToolExecutor` resolves the connection, decrypts credentials, and executes with timeout
- Tool name format is `connector.action` (e.g., `slack.send_message`)
- User-scoped connections take priority over tenant-scoped ones
- Execution errors are propagated to the agent with structured error format

### US-3: Knowledge Base Sync via Enterprise Connectors

As a SearchAI user, I want to connect SharePoint (and future sources) to automatically sync documents into my knowledge base, with filters, permissions, and incremental updates.

**Acceptance Criteria:**

- Full sync enumerates all sites/drives/items with checkpoint-based pause/resume
- Delta sync uses provider-specific delta tokens for incremental updates
- Filters by date, size, content type, site URL, library name
- Permission crawling creates per-document ACLs for query-time filtering
- Webhook subscription enables real-time change notifications
- Sync errors are tracked with consecutive failure counts and auto-pause

### US-4: Workflow Triggers Fire on External Events

As a workflow author, I want to trigger workflows when external events happen (webhook POST, polling interval, cron schedule).

**Acceptance Criteria:**

- Webhook triggers validate signatures (HMAC-SHA256 or connector-specific)
- Replay protection via timestamp check, idempotency via event ID dedup in Redis
- Polling triggers run at configurable intervals via BullMQ repeatable jobs
- Cron triggers fire at configured cron expressions
- Auto-pause after configurable consecutive failure threshold

### US-5: Connector Catalog Discovery

As a user, I want to browse available connectors, see their actions and triggers, and quickly connect to the ones I need.

**Acceptance Criteria:**

- Static catalog generated at build time from AP pieces + Nango OAuth metadata
- Catalog entries include name, category, auth type, action/trigger summaries
- Studio connections page shows status bar, connected list, and catalog grid
- Already-connected connectors show checkmark badge in catalog

## 4. Requirements

### 4.1 Functional Requirements

| ID    | Requirement                                                                                                                                                                                                            | Priority |
| ----- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | -------- |
| FR-01 | The system must provide a ConnectorRegistry that loads connector definitions at boot, exposing lookup by name, action, and trigger, with per-piece error isolation so a single failed piece does not crash the loader. | P0       |
| FR-02 | The system must support create, read, update, and delete operations on connections, encrypting credentials with AES-256-GCM using tenant-scoped keys before storage and redacting encrypted fields from API responses. | P0       |
| FR-03 | The system must implement OAuth2 authorization code flow with optional PKCE, redirecting to providers and storing encrypted tokens on callback.                                                                        | P0       |
| FR-04 | The system must implement OAuth2 device code flow (RFC 8628) with polling interval and expiration enforcement.                                                                                                         | P1       |
| FR-05 | The system must refresh expired OAuth2 tokens using distributed Redis locks (`SET NX PX`) to prevent concurrent refresh across pods, marking the connection `expired` on failure.                                      | P0       |
| FR-06 | The system must resolve the correct connection (user-scoped > tenant-scoped fallback), decrypt credentials, execute the connector action, and enforce a configurable timeout (default 30s).                            | P0       |
| FR-07 | The system must provide a WorkflowToolExecutor that invokes workflow-side connector actions synchronously or asynchronously from agent tool calls.                                                                     | P1       |
| FR-08 | The system must route trigger registrations to the correct strategy (webhook, polling, or cron) and manage their lifecycle (create, enable, disable, delete).                                                          | P1       |
| FR-09 | The system must verify inbound webhooks using HMAC-SHA256 with timing-safe comparison, reject replayed events via timestamp tolerance, and deduplicate via Redis event ID TTL.                                         | P1       |
| FR-10 | The system must wrap 25+ Activepieces piece packages as native connectors via the Activepieces adapter, mapping AP auth/actions/triggers to the SDK type system.                                                       | P0       |
| FR-11 | The system must import 600+ OAuth2 provider configurations from Nango (token URL, refresh URL, scopes, PKCE) and expose them via ProviderConfigRegistry.                                                               | P1       |
| FR-12 | The system must define an IConnector interface supporting full sync, delta sync, pause/resume, permission crawling, and webhook subscription lifecycle for enterprise connectors.                                      | P0       |
| FR-13 | The system must implement a SharePoint enterprise connector using Microsoft Graph API, supporting site/drive/item traversal, delta tokens, and document permission crawling.                                           | P0       |
| FR-14 | The system must persist sync checkpoints enabling pause/resume of long-running syncs with progress tracking (documents processed, ETA).                                                                                | P1       |
| FR-15 | The system must provide a configurable filter engine supporting date range, file size, content type, and site/library include/exclude filters for enterprise sync.                                                     | P1       |
| FR-16 | The system must crawl document-level ACLs in full or simplified mode and store them as DocumentPermission records for query-time permission filtering.                                                                 | P2       |
| FR-17 | The system must schedule hourly delta sync runs for enterprise connectors with stale `lastDeltaSyncAt` timestamps.                                                                                                     | P1       |
| FR-18 | The system must provide discovery (enumerate sites, drives, libraries) and recommendation (AI-generated configuration suggestions) APIs for enterprise connectors.                                                     | P2       |
| FR-19 | The system must render a Studio connections page with connection status bar, connected connection cards, and a searchable/filterable catalog grid of available connectors.                                             | P0       |
| FR-20 | The system must generate a static connector catalog JSON at build time from AP piece metadata and Nango OAuth provider configs.                                                                                        | P1       |
| FR-21 | The system must provide CLI commands (`connector create/list/delete/auth/filter/permission/sync`) for managing connectors outside the Studio UI.                                                                       | P2       |

### 4.2 Non-Functional Requirements

| ID     | Requirement                                                   | Target                    |
| ------ | ------------------------------------------------------------- | ------------------------- |
| NFR-01 | Credential encryption at rest with tenant-scoped keys         | AES-256-GCM               |
| NFR-02 | Token refresh latency (including lock acquisition)            | < 5s p99                  |
| NFR-03 | Connector action execution timeout (configurable)             | Default 30s               |
| NFR-04 | Rate limiting per connector (token bucket)                    | Configurable per type     |
| NFR-05 | Retry with exponential backoff and jitter                     | Max 3 retries default     |
| NFR-06 | SSRF protection on HTTP connector                             | Block RFC 1918 + metadata |
| NFR-07 | Webhook signature verification timing-safe                    | crypto.timingSafeEqual    |
| NFR-08 | Full sync throughput for SharePoint                           | > 100 docs/min            |
| NFR-09 | Delta sync detection latency (webhook mode)                   | < 5 min                   |
| NFR-10 | Connector loader boot time (25 AP pieces)                     | < 3s                      |
| NFR-11 | Connection resolution (user-scoped -> tenant-scoped fallback) | < 100ms p99               |

## 5. Feature Classification & Integration Matrix

### Lifecycle / Platform Impact

| Area                       | Impact Level | Notes                                                                    |
| -------------------------- | ------------ | ------------------------------------------------------------------------ |
| Project lifecycle          | SECONDARY    | Connections are project-scoped resources; not core to project CRUD       |
| Agent lifecycle            | PRIMARY      | Connector actions serve as agent tools (`tool_type: 'connector'` in IR)  |
| Customer experience        | PRIMARY      | Powers real-time integrations during conversations (Slack, Stripe, Jira) |
| Integrations / channels    | PRIMARY      | This IS the integrations feature — 25+ AP pieces, 600+ OAuth providers   |
| Observability / tracing    | SECONDARY    | OTel spans on executor + webhook handler; sync metrics; error tracking   |
| Governance / controls      | SECONDARY    | Credential encryption, SSRF protection, webhook HMAC verification        |
| Enterprise / compliance    | PRIMARY      | Enterprise connectors (SharePoint), document permissions, encryption     |
| Admin / operator workflows | SECONDARY    | Admin ConnectorsPage for channel connections; connection CRUD            |

### Related Feature Integration Matrix

| Related Feature                             | Relationship Type | Why It Matters                                                 | Key Touchpoints                                          | Current State |
| ------------------------------------------- | ----------------- | -------------------------------------------------------------- | -------------------------------------------------------- | ------------- |
| [Auth Profiles](auth-profiles.md)           | depends on        | ConnectionResolver delegates to AuthProfileResolver for creds  | `connection-resolver.ts:resolveAuth()`, `authProfileId`  | Working       |
| [Tool Invocations](tool-invocations.md)     | extends           | Connector actions ARE tool invocations; `tool_type: connector` | `tool-binding-executor.ts`, `ConnectorToolExecutor`      | Working       |
| [Encryption at Rest](encryption-at-rest.md) | depends on        | All credentials encrypted via `EncryptionServiceLike`          | `ConnectionService`, `key-rotation.ts`                   | Working       |
| [Webhook System](webhook-system.md)         | shares data with  | Trigger engine handles inbound webhooks with shared patterns   | `webhook-handler.ts`, `TriggerEngine`, `WebhookDelivery` | Working       |
| [Channels](channels.md)                     | extends           | Channel connections are a specialized connector subsystem      | `channel-connections.ts`, `ChannelOAuthProvider`         | Working       |

---

## 6. Data Model

### 6.1 Core Models

**ConnectorConfig** (SearchAI enterprise connectors):

- `_id`, `tenantId`, `connectorType`, `sourceId`
- `filterConfig` (date, size, content type filters)
- `permissionConfig` (mode: enabled/disabled)
- `syncState` (lastFullSyncAt, lastDeltaSyncAt)
- `errorState` (isPaused, consecutiveFailures, lastErrorAt, lastErrorMessage)
- **Indexes**: `{ tenantId, sourceId }` (unique), `{ tenantId, connectorType }`, `{ errorState.isPaused, oauthTokenId }`, `{ errorState.consecutiveFailures }`

**ConnectorConnection** (Connector SDK connections):

- `_id`, `tenantId`, `projectId`, `connectorName`, `displayName`
- `scope` (tenant/user), `userId`, `authType`, `status`
- `encryptedCredentials`, `encryptionKeyVersion`
- `oauth2TokenExpiresAt`, `oauth2RefreshToken`, `oauth2Provider`, `scopes`
- `authProfileId` (optional, links to auth profile service)
- **Indexes**: `{ tenantId, projectId, connectorName, scope, userId }` (unique), `{ tenantId, projectId }`

**ChannelConnection** (Runtime channel integrations):

- `_id`, `tenantId`, `projectId`, `channelType`, `channelConfig`
- OAuth credentials for Slack, MS Teams, Meta/WhatsApp

### 6.2 Supporting Models

- **EndUserOAuthToken**: per-user OAuth tokens for user-scoped connections
- **ConnectorKVStore**: per-connection key-value store for trigger state, polling cursors
- **SyncCheckpoint**: pause/resume state with progress tracking and ETA
- **DriveDeltaToken**: per-drive delta tokens for incremental sync
- **DocumentPermission**: per-document ACL for query-time permission filtering
- **WebhookSubscription**: active webhook subscriptions with renewal tracking
- **WebhookDelivery**: delivery log for inbound webhook events
- **ConnectorSchema**: schema definitions for connector-specific configuration
- **ConnectorDiscovery**: resource discovery results (sites, drives, libraries)
- **ConnectorRecommendation**: AI-generated recommendations for connector configuration

## 7. How to Consume

### Studio UI

- **Connections Page**: `apps/studio/src/components/connections/ConnectionsPage.tsx` — status bar, connection cards, catalog grid
- **Create Connection Modal**: `apps/studio/src/components/connections/CreateConnectionModal.tsx`
- **OAuth Flow Dialog**: `apps/studio/src/components/connections/OAuthFlowDialog.tsx`
- **OAuth Callback**: `apps/studio/src/app/oauth/connection-callback/page.tsx`
- **SearchAI Enterprise Connectors**: `apps/studio/src/components/search-ai/sharepoint/` (30+ components — wizard, sync progress, security tab, proposals)
- **Admin Connectors Page**: `apps/studio/src/components/admin/ConnectorsPage.tsx` — workspace-level channel connection management
- **Navigation**: `apps/studio/src/config/navigation.ts` — `connections` entry under resource nav

### API (Runtime)

| Method | Endpoint                                              | Purpose                   |
| ------ | ----------------------------------------------------- | ------------------------- |
| GET    | `/api/projects/:projectId/connections`                | List project connections  |
| POST   | `/api/projects/:projectId/connections`                | Create connection         |
| GET    | `/api/projects/:projectId/connections/:id`            | Get connection details    |
| PUT    | `/api/projects/:projectId/connections/:id`            | Update connection         |
| DELETE | `/api/projects/:projectId/connections/:id`            | Delete connection         |
| POST   | `/api/projects/:projectId/connections/:id/test`       | Test connection           |
| POST   | `/api/projects/:projectId/connections/oauth/callback` | OAuth callback            |
| GET    | `/api/projects/:projectId/connectors`                 | List available connectors |
| GET    | `/api/projects/:projectId/connectors/:name`           | Get connector details     |
| POST   | `/webhooks/:connectorName/:registrationId`            | Inbound webhook handler   |

### API (SearchAI)

| Method | Endpoint                                          | Purpose                  |
| ------ | ------------------------------------------------- | ------------------------ |
| GET    | `/api/indexes/:indexId/connectors`                | List index connectors    |
| POST   | `/api/indexes/:indexId/connectors`                | Create connector config  |
| POST   | `/api/connectors/:id/auth/initiate`               | Initiate OAuth flow      |
| POST   | `/api/connectors/:id/sync/start`                  | Start sync               |
| GET    | `/api/connectors/:id/sync/status`                 | Check sync status        |
| POST   | `/api/connectors/:id/discover`                    | Discover resources       |
| POST   | `/api/connectors/:id/recommendations`             | Generate recommendations |
| POST   | `/api/connectors/:id/recommendations/:rid/accept` | Accept recommendation    |

### Admin Portal

Connector administration is handled within Studio's admin section (`ConnectorsPage.tsx`). The standalone Admin Portal only has model-level connection routes for LLM provider API keys.

### Channel / SDK / Voice / A2A / MCP Integration

Connector tool execution is **channel-agnostic**. The same connector action produces identical behavior regardless of whether the conversation originates from SDK, Voice, A2A, or any other channel. Channel connections (Slack bot, MS Teams bot, Meta/WhatsApp) are a separate subsystem using `ChannelOAuthProvider`.

---

## 8. Architecture

### 8.1 Package Structure

```
packages/connectors/             # Connector SDK (core)
  src/
    types.ts                     # Canonical types: Connector, Action, Trigger, Auth
    registry.ts                  # In-memory ConnectorRegistry
    loader.ts                    # Boot-time loader: HTTP + 25 AP pieces
    properties.ts                # Property builder (static factory)
    logger.ts                    # Scoped logger
    auth/                        # ConnectionResolver, ProviderConfigRegistry, KeyRotation
    executor/                    # ConnectorToolExecutor, WorkflowToolExecutor
    triggers/                    # TriggerEngine, WebhookHandler, PollingScheduler, CronScheduler, WebhookDeliveryRetention
    services/                    # ConnectionService (CRUD), ConnectorListingService
    compiler/                    # connectorActionToToolDefinition (ABL bridge)
    adapters/
      activepieces/              # AP piece wrapper (25 pieces)
      nango/                     # OAuth provider config import (600+ providers)
        generated/providers.json # 600+ OAuth2 provider configs (generated)
    connectors/http/             # Native HTTP connector
    generated/                   # connector-catalog.json

packages/connectors/base/        # Enterprise connector infrastructure
  src/
    interfaces/                  # IConnector, ISyncCoordinator, IFilterEngine, IPermissionCrawler
    auth/                        # DeviceCodeFlow, TokenManager
    client/                      # RateLimiter, RetryHandler, HttpClient, CircuitBreaker
    sync/                        # BaseSyncCoordinator
    filters/                     # BaseFilterEngine

packages/connectors/sharepoint/  # SharePoint connector implementation
  src/
    auth/                        # MicrosoftOAuthProvider
    client/                      # GraphClient (Graph API wrapper)
    sync/                        # FullSyncCoordinator, DeltaSyncCoordinator
    filters/                     # SharePointFilterEngine
    permissions/                 # SharePointPermissionCrawler
```

### 8.2 Data Flow

```
Agent conversation:
  Agent → ConnectorToolExecutor → ConnectionResolver → decrypt → Action.run()

Workflow trigger:
  Webhook/Poll/Cron → TriggerEngine → Restate workflow invocation

SearchAI sync:
  Studio UI → ConnectorConfig → IConnector.performFullSync() → SearchDocuments → Ingestion pipeline

OAuth flow:
  Studio → /auth/initiate → redirect → provider → /auth/callback → encrypt + store tokens
```

## 9. Key Implementation Files

### Domain / Core Logic

| File                                                          | Purpose                                                     |
| ------------------------------------------------------------- | ----------------------------------------------------------- |
| `packages/connectors/src/types.ts`                            | Canonical types: Connector, Action, Trigger, Auth, Context  |
| `packages/connectors/src/registry.ts`                         | In-memory ConnectorRegistry (lookup by name/action/trigger) |
| `packages/connectors/src/loader.ts`                           | Boot-time loader: HTTP connector + 25 AP pieces             |
| `packages/connectors/src/executor/connector-tool-executor.ts` | Agent-side action execution with timeout, OTel tracing      |
| `packages/connectors/src/auth/connection-resolver.ts`         | Credential resolution: user > tenant scope, OAuth2 refresh  |
| `packages/connectors/src/services/connection-service.ts`      | Connection CRUD with encrypted credential storage           |
| `packages/connectors/src/triggers/webhook-handler.ts`         | Inbound webhook: HMAC, replay protection, dedup, OTel       |
| `packages/connectors/src/triggers/trigger-engine.ts`          | Routes trigger registration to webhook/polling/cron         |
| `packages/connectors/src/auth/key-rotation.ts`                | Batch re-encryption on key rotation                         |
| `packages/connectors/base/src/sync/base-sync-coordinator.ts`  | Template method for checkpoint-based full/delta sync        |

### Routes / Handlers

| File                                               | Purpose                                           |
| -------------------------------------------------- | ------------------------------------------------- |
| `apps/runtime/src/routes/connections.ts`           | Runtime connection CRUD (project-scoped, auth MW) |
| `apps/search-ai/src/routes/connectors.ts`          | SearchAI enterprise connector routes              |
| `apps/search-ai/src/repos/connector.repository.ts` | Data access for connector configs, tokens         |

### UI Components

| File                                                               | Purpose                                     |
| ------------------------------------------------------------------ | ------------------------------------------- |
| `apps/studio/src/components/connections/ConnectionsPage.tsx`       | Main connections page (status, cards, grid) |
| `apps/studio/src/components/connections/CreateConnectionModal.tsx` | New connection creation with auth selection |

### Jobs / Workers / Background Processes

| File                                                       | Purpose                                |
| ---------------------------------------------------------- | -------------------------------------- |
| `apps/search-ai/src/workers/connector-sync-worker.ts`      | BullMQ worker for full/delta sync jobs |
| `apps/search-ai/src/workers/connector-discovery-worker.ts` | BullMQ worker for resource discovery   |
| `apps/search-ai/src/scheduler/connector-delta-sync.ts`     | Hourly delta sync scheduler            |

---

## 10. Configuration

### Environment Variables

| Variable                                  | Default | Description                                               |
| ----------------------------------------- | ------- | --------------------------------------------------------- |
| `ENCRYPTION_MASTER_KEY`                   | (none)  | AES-256 master key for encrypting connector credentials   |
| `ENCRYPTION_ENABLED`                      | `true`  | Set to `false` to disable encryption                      |
| `OAUTH_PROVIDER_<PROVIDER>_CLIENT_ID`     | (none)  | OAuth2 client ID per provider (e.g., `_GOOGLE_CLIENT_ID`) |
| `OAUTH_PROVIDER_<PROVIDER>_CLIENT_SECRET` | (none)  | OAuth2 client secret per provider                         |
| `CHANNEL_OAUTH_SLACK_CLIENT_ID`           | (none)  | Slack bot OAuth client ID (channel connections)           |
| `CHANNEL_OAUTH_SLACK_CLIENT_SECRET`       | (none)  | Slack bot OAuth client secret                             |
| `CHANNEL_OAUTH_SLACK_SIGNING_SECRET`      | (none)  | Slack request signing secret for webhook verification     |

### Runtime Configuration

No tenant-level feature flags or runtime toggles for connectors. Configuration is per-connection (DB records) and per-connector-config (enterprise). Individual connectors can be excluded by removing from `PIECE_PACKAGES` in `loader.ts`.

### DSL / Agent IR / Schema

Connector actions are bound via the IR `connector_binding` field:

```typescript
interface ConnectorBindingIR {
  connector: string; // e.g., 'slack'
  action: string; // e.g., 'send_message'
}
```

Note: `connector_binding` is not yet expressible in DSL syntax — it is set at the IR level. The `connectorActionToToolDefinition()` bridge converts `ConnectorAction` to IR `ToolDefinition` format.

---

## 11. Non-Functional Concerns

### Isolation & Multitenancy

| Concern           | Requirement / Expectation                                                                                                 |
| ----------------- | ------------------------------------------------------------------------------------------------------------------------- |
| Project isolation | Every project-scoped read/write includes `projectId`; cross-project access returns 404. Routes use `requireProjectScope`. |
| Tenant isolation  | Every query includes `tenantId` in filter; `findOne({_id, tenantId})` not `findById()`. Cross-tenant returns 404.         |
| User isolation    | User-scoped connections filtered by `userId`; resolution priority: user > tenant. Different users see own connections.    |

### Security & Compliance

- **Credential Encryption**: AES-256-GCM with tenant-scoped keys; key version tracked for rotation
- **OAuth2 Token Refresh**: Distributed locking via Redis `SET NX PX`; connection marked `expired` on failure
- **SSRF Protection**: HTTP connector blocks RFC 1918, loopback, link-local, IPv4-mapped IPv6, cloud metadata
- **Webhook Verification**: HMAC-SHA256 with `crypto.timingSafeEqual`; connector-specific `verify()` callbacks
- **Credential Redaction**: API responses never include `encryptedCredentials` or `oauth2RefreshToken`
- **Key Rotation**: `key-rotation.ts` batch re-encryption utility; processes in batches of 100 with per-connection error isolation
- **Circuit Breaker**: In-process circuit breaker (`circuit-breaker.ts`) protects external API calls with CLOSED→OPEN→HALF_OPEN state machine; configurable failure threshold and reset timeout

### Performance & Scalability

- **Boot-time Loading**: 25 AP pieces loaded with per-piece error isolation; target < 3s
- **Rate Limiting**: Token bucket per connector instance (configurable)
- **Checkpoint-based Sync**: Pause/resume without restarting; progress tracking with ETA
- **Connection Resolution**: Two DB queries max (user-scoped, then tenant-scoped); < 100ms p99

### Reliability & Failure Modes

- **Retry with Backoff**: Exponential backoff with jitter; Retry-After header respected
- **Auto-pause**: Triggers auto-pause after `TRIGGER_AUTO_PAUSE_THRESHOLD` (10) consecutive failures
- **OAuth2 Failure**: Connection marked `expired`; lock released in `finally`; graceful degradation
- **Per-piece Isolation**: Failed AP piece imports are logged and skipped without crashing

### Observability

- **Structured Logging**: All modules use `createLogger('module-name')`
- **OpenTelemetry**: `connector.execute` span (6 attrs) + `connector.webhook` span (3 attrs); error states recorded
- **Sync Metrics**: documentsProcessed, documentsFailed, durationMs per sync run
- **Trigger Health**: `lastFiredAt`, `consecutiveErrors` on registrations; auto-pause at threshold
- **Circuit Breaker**: Logs state transitions (CLOSED→OPEN→HALF_OPEN) with structured metadata

### Data Lifecycle

- **WebhookDelivery Retention**: 30-day default TTL with tenant-scoped cleanup
- **Delta Tokens**: Per-drive tokens cleaned up weekly by `cleanupOrphanedDeltaTokens()`
- **Sync Checkpoints**: Retained for resume; cleaned up on sync completion
- **Connection Deletion**: Cascades to dependent trigger registrations

---

## 12. Delivery Plan / Work Breakdown

Implementation complete (BETA status). Phases delivered:

1. **Connector SDK Foundation** (pre-existing)
   1.1 Types, Property builder, Registry, Loader (25 AP pieces + Nango)
   1.2 HTTP connector with SSRF protection
   1.3 `ConnectorToolExecutor` + `WorkflowToolExecutor`
   1.4 `ConnectionResolver` with user > tenant scope fallback
   1.5 `ConnectionService` CRUD with encryption
2. **Trigger Engine** (pre-existing)
   2.1 `TriggerEngine`, `WebhookHandler`, `PollingScheduler`, `CronScheduler`
   2.2 HMAC verification, replay protection, Redis dedup
3. **Enterprise Connectors** (pre-existing)
   3.1 `IConnector` interface, `BaseSyncCoordinator`, `BaseFilterEngine`
   3.2 SharePoint connector (Graph client, full/delta sync, permission crawler)
4. **Code Quality + Observability Hardening** (2026-03-25)
   4.1 `console.log` → `createLogger`, `findById` → `findOne({_id, tenantId})`
   4.2 OTel spans, circuit breaker, key rotation, webhook delivery retention
5. **E2E + Integration Test Suite** (2026-03-25)
   5.1 69 integration tests (8 files), 66 HTTP E2E tests (5 files), 35 svc E2E tests (3 files)
   5.2 38 skipped tests fixed, runtime connection routes wired
6. **Audit Hardening + Review** (2026-03-25)
   6.1 5 review rounds completed, round 1 fixes committed
   6.2 Token manager rewrite, OAuth consolidation path documented

---

## 13. Success Metrics

| Metric                            | Baseline | Target         | How Measured                                       |
| --------------------------------- | -------- | -------------- | -------------------------------------------------- |
| Connector catalog size            | 0        | 25+ AP pieces  | `loadConnectors()` boot count                      |
| OAuth2 token refresh success rate | N/A      | > 99%          | `refreshOAuth2()` success vs `expired` transitions |
| Tool execution latency (p99)      | N/A      | < 30s          | OTel span `connector.execute` duration             |
| Webhook processing latency (p99)  | N/A      | < 500ms        | OTel span `connector.webhook` duration             |
| Enterprise sync throughput        | N/A      | > 100 docs/min | `SyncResult.documentsProcessed / durationMs`       |
| E2E test count                    | 0        | 66+            | HTTP E2E test count across runtime + search-ai     |
| Integration test count            | 0        | 69+            | Integration test count across 8 files              |

---

## 14. Open Questions

1. **OQ-9**: `startScheduledJobs()` is never called from `startServer()` — all scheduled jobs are dead code in production. P0 wiring issue.
2. **OQ-10**: Three parallel OAuth implementations need consolidation. Path documented at `docs/plans/oauth-consolidation-path.md`.
3. **OQ-16**: `connector_binding` not yet expressible in DSL syntax — only settable at IR level.

---

## 15. Gaps, Known Issues & Limitations

| ID      | Description                                                                                                                                                                                       | Severity | Status     |
| ------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | -------- | ---------- |
| GAP-001 | `startScheduledJobs()` dead code — scheduled jobs never wired                                                                                                                                     | High     | Open       |
| GAP-002 | Encryption key rotation CLI not wired (utility exists, no route)                                                                                                                                  | Medium   | Open       |
| GAP-003 | Webhook renewal uses hardcoded mock token — Graph calls will fail                                                                                                                                 | High     | Open       |
| GAP-004 | Three parallel OAuth implementations need consolidation                                                                                                                                           | Medium   | Documented |
| GAP-005 | `circuit-breaker.ts` uses `console.*` (package boundary)                                                                                                                                          | Low      | Deferred   |
| GAP-006 | No HTTP E2E for polling trigger lifecycle                                                                                                                                                         | Low      | Open       |
| GAP-007 | WorkflowToolExecutor: no integration or E2E tests                                                                                                                                                 | Low      | Open       |
| GAP-008 | SearchAI `webhooks.ts` missing `tenantId` in ConnectorConfig lookup (line 71). Mitigated by clientState HMAC verification — Graph callbacks don't carry tenantId. INT-8 deferred for same reason. | Medium   | By Design  |
| GAP-009 | CLI commands for connector lifecycle management (FR-21) not yet implemented — no CLI package or command handlers exist.                                                                           | Low      | Planned    |

---

## 16. Testing & Validation

### Required Test Coverage

| #   | Scenario                    | Coverage Type | Status | Test File                                   |
| --- | --------------------------- | ------------- | ------ | ------------------------------------------- |
| 1   | Connection CRUD lifecycle   | E2E (HTTP)    | PASS   | `connector-connection-crud.e2e.test.ts`     |
| 2   | OAuth2 flow                 | E2E (HTTP)    | PASS   | `connector-oauth-flow.e2e.test.ts`          |
| 3   | Tool execution + scope      | E2E (HTTP)    | PASS   | `connector-tool-execution.e2e.test.ts`      |
| 4   | Trigger lifecycle + webhook | E2E (HTTP)    | PASS   | `connector-trigger-lifecycle.e2e.test.ts`   |
| 5   | SearchAI discovery-to-sync  | E2E (HTTP)    | PASS   | `connector-discovery-sync.e2e.test.ts`      |
| 6   | Credential encryption       | Integration   | PASS   | `credential-encryption.integration.test.ts` |
| 7   | Tenant isolation            | Integration   | PASS   | `tenant-isolation.integration.test.ts`      |
| 8   | OAuth refresh + lock        | Integration   | PASS   | `oauth-refresh-lock.integration.test.ts`    |
| 9   | Webhook dispatch + dedup    | Integration   | PASS   | `webhook-dispatch.integration.test.ts`      |
| 10  | Polling trigger             | Integration   | PASS   | `polling-trigger.integration.test.ts`       |

### Testing Notes

226 unit + 69 integration + 35 svc-E2E + 66 HTTP-E2E. Zero skipped tests. All E2E tests use real Express servers with full middleware — no mocks of codebase components.

> Full testing details: `../testing/connectors.md`

---

## 17. Dependencies

### Internal

- `@agent-platform/database`: ConnectorConfig, ConnectorConnection, EndUserOAuthToken, SyncCheckpoint, DriveDeltaToken, DocumentPermission models
- `@agent-platform/shared`: EncryptionService, LockManager interfaces
- `@agent-platform/compiler`: tool definition types for ABL bridge
- `@agent-platform/config`: port constants, environment config

### External

- 25 Activepieces piece packages (`@activepieces/piece-*`)
- Nango providers.yaml (OAuth2 metadata for 600+ providers)
- Microsoft Graph API (SharePoint connector)
- Redis (distributed locking, webhook dedup, trigger state)
- MongoDB (all connector data models)

---

## 18. Risks and Mitigations

| Risk                                        | Likelihood | Impact | Mitigation                                                                   |
| ------------------------------------------- | ---------- | ------ | ---------------------------------------------------------------------------- |
| AP piece dynamic import fails under bundler | Medium     | High   | Static catalog generation; per-piece error isolation                         |
| OAuth2 token refresh race condition         | Medium     | High   | Distributed locking via Redis SET NX PX; wait-and-read fallback              |
| External API rate limits during sync        | High       | Medium | Token bucket rate limiter; exponential backoff with jitter                   |
| Credential encryption key rotation          | Low        | High   | **Mitigated**: `key-rotation.ts` implemented; `encryptionKeyVersion` tracked |
| Webhook replay attacks                      | Medium     | Medium | Timestamp tolerance check; Redis event ID dedup with TTL                     |

---

## 19. Decision Log

| Decision                                           | Rationale                                                                                                    |
| -------------------------------------------------- | ------------------------------------------------------------------------------------------------------------ |
| Static catalog (build-time) over dynamic loading   | AP piece dynamic imports fail under Turbopack; static JSON is deterministic and fast                         |
| Two connector tracks (SDK + Enterprise IConnector) | SDK connectors are lightweight (actions/triggers); enterprise connectors need full sync/permission lifecycle |
| Nango provider configs over hand-maintained list   | 600+ providers maintained upstream; reduces our maintenance burden                                           |
| Template method pattern for sync coordinators      | 90% code reuse across connectors; only provider-specific fetch/delta logic differs                           |
| Distributed lock for OAuth refresh                 | Multi-pod deployment; without lock, concurrent refresh causes token revocation                               |
| HMAC-SHA256 as fallback webhook verification       | Not all connectors define custom `verify()` methods; generic HMAC provides baseline security                 |

## 20. Glossary

| Term                 | Definition                                                                       |
| -------------------- | -------------------------------------------------------------------------------- |
| Connector            | SDK definition with name, auth, actions, triggers                                |
| Connection           | Tenant/user-scoped instance of a connector with encrypted credentials            |
| Action               | A discrete operation a connector can perform (e.g., send message, create issue)  |
| Trigger              | An event source (webhook, polling, cron) that fires workflow executions          |
| Enterprise Connector | Full-lifecycle connector implementing IConnector (sync, permissions, webhooks)   |
| Delta Sync           | Incremental sync using provider-specific change tokens                           |
| AP Piece             | An Activepieces piece package wrapped via the Activepieces adapter               |
| Provider Config      | OAuth2 metadata (auth URL, token URL, scopes) imported from Nango                |
| Connection Resolver  | Service that finds and decrypts the correct connection for a tool execution      |
| Trigger Registration | Database record linking a trigger to a workflow with its schedule/webhook config |

---

## 21. References

- HLD: `docs/specs/connectors.hld.md`
- LLD: `docs/plans/2026-03-22-connectors-testing-gaps-impl-plan.md`
- Test Spec: `docs/testing/connectors.md`
- SDLC Logs: `docs/sdlc-logs/connectors/`
- Activepieces SDK: https://www.activepieces.com/docs/developers/overview
- Microsoft Graph API: https://learn.microsoft.com/en-us/graph/overview

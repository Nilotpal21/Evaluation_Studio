# High-Level Design: Connectors Platform

**Feature ID:** F006
**Slug:** connectors
**Status:** BETA
**Last Updated:** 2026-03-25

---

## 1. Overview

The Connectors Platform provides a unified framework for integrating the ABL platform with external services. It spans three primary use cases:

1. **Agent Tools**: Connector actions executed during agent conversations (Slack, Stripe, Jira, etc.)
2. **Knowledge Base Sync**: Enterprise connectors that synchronize documents from data sources (SharePoint, Confluence) into SearchAI
3. **Workflow Triggers**: Event-driven workflow execution via webhooks, polling, and cron

The system is designed around a shared Connector SDK (`packages/connectors/`) with specialized subsystems for each use case.

## 2. Architecture Diagram

```
                                    ┌──────────────────────────────┐
                                    │       Studio (Next.js)       │
                                    │  ┌──────────────────────────┐│
                                    │  │  ConnectionsPage         ││
                                    │  │  CatalogGrid             ││
                                    │  │  CreateConnectionModal   ││
                                    │  │  OAuthCallbackPage       ││
                                    │  └──────────────────────────┘│
                                    └──────────┬───────────────────┘
                                               │ HTTP API
                         ┌─────────────────────┼─────────────────────┐
                         │                     │                     │
                  ┌──────▼──────┐     ┌────────▼──────┐     ┌───────▼────────┐
                  │   Runtime   │     │   SearchAI    │     │ Workflow Engine │
                  │  (Express)  │     │  (Express)    │     │   (Express)    │
                  │             │     │               │     │                │
                  │ Channel     │     │ Connector     │     │ Connection     │
                  │ Connections │     │ Routes        │     │ Routes         │
                  │ Channel     │     │ Discovery     │     │ Connector      │
                  │ OAuth       │     │ Sync Routes   │     │ Listing        │
                  └──────┬──────┘     └───────┬───────┘     └───────┬────────┘
                         │                    │                     │
                         └────────────┬───────┘─────────────────────┘
                                      │
                         ┌────────────▼────────────┐
                         │   packages/connectors   │
                         │                         │
                         │  ┌──────────────────┐   │
                         │  │ ConnectorRegistry │   │
                         │  │ (in-memory)       │   │
                         │  └────────┬─────────┘   │
                         │           │              │
                         │  ┌────────┴─────────┐   │
                         │  │                  │   │
                         │  ▼                  ▼   │
                         │ Executor          Trigger│
                         │ ┌──────────┐  ┌────────┐│
                         │ │ToolExec  │  │Engine  ││
                         │ │WfExec    │  │Webhook ││
                         │ └────┬─────┘  │Polling ││
                         │      │        │Cron    ││
                         │      │        └───┬────┘│
                         │  ┌───▼────────────▼──┐  │
                         │  │ ConnectionResolver│  │
                         │  │ + EncryptionSvc   │  │
                         │  │ + LockManager     │  │
                         │  └───────────────────┘  │
                         │                         │
                         │  ┌───────────────────┐  │
                         │  │ ConnectionService │  │
                         │  │ (CRUD)            │  │
                         │  └───────────────────┘  │
                         │                         │
                         │  ┌───────────────────┐  │
                         │  │ Adapters          │  │
                         │  │ ├─ Activepieces   │  │
                         │  │ └─ Nango          │  │
                         │  └───────────────────┘  │
                         └─────────────────────────┘

                         ┌─────────────────────────┐
                         │ packages/connectors/base │
                         │  IConnector interface    │
                         │  BaseSyncCoordinator     │
                         │  BaseFilterEngine        │
                         │  TokenManager            │
                         │  RateLimiter             │
                         │  RetryHandler            │
                         └────────────┬────────────┘
                                      │
                         ┌────────────▼────────────┐
                         │ packages/connectors/     │
                         │   sharepoint             │
                         │  MicrosoftOAuthProvider  │
                         │  GraphClient             │
                         │  FullSyncCoordinator     │
                         │  DeltaSyncCoordinator    │
                         │  SharePointFilterEngine  │
                         └─────────────────────────┘

External:
  ┌───────────┐  ┌─────────┐  ┌──────────┐  ┌───────┐
  │ SharePoint│  │  Slack   │  │  Stripe  │  │  ...  │
  │ Graph API │  │   API    │  │   API    │  │ (25+) │
  └───────────┘  └─────────┘  └──────────┘  └───────┘

Data Stores:
  ┌─────────┐  ┌───────┐
  │ MongoDB │  │ Redis │
  │ (state) │  │ (lock,│
  │         │  │ dedup)│
  └─────────┘  └───────┘
```

## 3. Component Decomposition

### 3.1 Connector SDK Core (`packages/connectors/src/`)

| Component                               | Responsibility                                             | Key Interfaces                     |
| --------------------------------------- | ---------------------------------------------------------- | ---------------------------------- |
| `types.ts`                              | Canonical types: Connector, Action, Trigger, Auth, Context | `Connector`, `ConnectorAction`     |
| `registry.ts`                           | In-memory connector lookup by name, action, trigger        | `ConnectorRegistry`                |
| `loader.ts`                             | Boot-time registration of HTTP + 25 AP pieces              | `loadConnectors(registry)`         |
| `properties.ts`                         | Static factory for typed property declarations             | `Property.string()`, `.dropdown()` |
| `auth/connection-resolver.ts`           | Credential resolution: user > tenant scope, OAuth2 refresh | `ConnectionResolver`               |
| `auth/provider-config-registry.ts`      | 600+ OAuth2 provider metadata from Nango                   | `getProviderConfig(name)`          |
| `executor/connector-tool-executor.ts`   | Agent-side action execution with timeout                   | `ConnectorToolExecutor`            |
| `executor/workflow-tool-executor.ts`    | Workflow invocation (sync/async) from agent tools          | `WorkflowToolExecutor`             |
| `triggers/trigger-engine.ts`            | Routes trigger registration to webhook/polling/cron        | `TriggerEngine`                    |
| `triggers/webhook-handler.ts`           | Inbound webhook processing with security                   | `handleWebhook(req, deps)`         |
| `triggers/polling-scheduler.ts`         | BullMQ repeatable job for polling triggers                 | `registerPollingTrigger()`         |
| `triggers/cron-scheduler.ts`            | BullMQ repeatable job for cron triggers                    | `registerCronTrigger()`            |
| `services/connection-service.ts`        | CRUD for connections with encryption                       | `ConnectionService`                |
| `services/connector-listing-service.ts` | Read-only connector catalog queries                        | `ConnectorListingService`          |
| `compiler/connector-to-tool.ts`         | ABL DSL bridge: action -> tool definition                  | `connectorActionToToolDefinition`  |
| `connectors/http/`                      | Native HTTP connector with SSRF protection                 | `httpConnector: Connector`         |
| `adapters/activepieces/`                | Wraps AP piece modules into Connector interface            | `wrapActivepiecesPiece()`          |
| `adapters/nango/`                       | Imports OAuth2 provider configs from Nango YAML            | `ProviderConfig`                   |

### 3.2 Enterprise Connector Infrastructure (`packages/connectors/base/`)

| Component                           | Responsibility                                                 |
| ----------------------------------- | -------------------------------------------------------------- |
| `interfaces/connector.interface.ts` | IConnector contract: lifecycle, sync, permissions, webhooks    |
| `auth/device-code-flow.ts`          | RFC 8628 device code flow for OAuth2                           |
| `auth/token-manager.ts`             | Token refresh with 5-min buffer, encrypted storage             |
| `client/rate-limiter.ts`            | Token bucket rate limiter                                      |
| `client/retry-handler.ts`           | Exponential backoff with jitter and Retry-After                |
| `client/http-client.ts`             | Standard HTTP methods with automatic JSON parsing              |
| `sync/base-sync-coordinator.ts`     | Template method: checkpoint, progress, SearchDocument creation |
| `filters/base-filter-engine.ts`     | Date, size, content type filtering with statistics             |
| `permissions/`                      | BasePermissionCrawler for document ACLs                        |

### 3.3 SharePoint Connector (`packages/connectors/sharepoint/`)

| Component                                      | Responsibility                                                |
| ---------------------------------------------- | ------------------------------------------------------------- |
| `auth/microsoft-oauth-provider.ts`             | Azure AD OAuth: device code, token exchange, refresh          |
| `client/graph-client.ts`                       | Microsoft Graph API: sites, drives, items, delta, permissions |
| `sync/full-sync-coordinator.ts`                | Site -> drive -> item enumeration with checkpoints            |
| `sync/delta-sync-coordinator.ts`               | Incremental sync via Graph delta tokens                       |
| `filters/sharepoint-filter-engine.ts`          | Site URL, library, SharePoint content type filters            |
| `permissions/sharepoint-permission-crawler.ts` | Graph API permission crawling                                 |

### 3.4 Data Access Layer

| App / Package | Component                       | Responsibility                                                                                                                          |
| ------------- | ------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------- |
| SearchAI      | `repos/connector.repository.ts` | Connector CRUD, OAuth tokens, delta tokens, checkpoints                                                                                 |
| Database      | 15+ Mongoose models             | ConnectorConfig, ConnectorConnection, EndUserOAuthToken, SyncCheckpoint, DriveDeltaToken, DocumentPermission, WebhookSubscription, etc. |

## 4. Twelve Architectural Concerns

### 4.1 Tenant Isolation

Every database query includes `tenantId` in the filter. The `ConnectionResolver`, `ConnectionService`, `ConnectorRepository`, and all route handlers enforce tenant scoping. Cross-tenant access returns 404, not 403. The `ConnectionService.getById()` signature requires `(tenantId, projectId, id)` -- there is no `findById(id)` path.

**Code reference:** `ConnectionResolver.resolve()` at line 78 uses `{ _id: opts.connectionId, tenantId: opts.tenantId, projectId: opts.projectId, status: 'active' }`.

### 4.2 Authentication and Authorization

- **Platform auth**: All connector routes use `createUnifiedAuthMiddleware` / `requireAuth`
- **OAuth2 flows**: Authorization code (with PKCE), device code (RFC 8628), token refresh with distributed locking
- **Provider-specific**: Channel OAuth providers (Slack, MS Teams, Meta) implement `ChannelOAuthProvider` interface
- **Auth profiles**: `ConnectionResolver.resolveAuth()` checks for `authProfileId` and delegates to `AuthProfileResolver` when present

### 4.3 Data Encryption

- Credentials encrypted at rest using `EncryptionServiceLike.encryptForTenant(plaintext, tenantId)` before storage
- `encryptionKeyVersion` tracked per connection for key rotation support
- OAuth2 refresh tokens encrypted separately via the same tenant-scoped key
- Decryption happens just-in-time in `ConnectionResolver.decrypt()` and `ConnectionService.test()`

### 4.4 Scalability

- **Stateless execution**: `ConnectorToolExecutor` and `ConnectionResolver` hold no pod-local state beyond the in-memory ConnectorRegistry (read-only after boot)
- **Distributed sync**: Full sync and delta sync operate via BullMQ jobs, distributable across worker pods
- **Rate limiting**: Token bucket per connector instance prevents API quota exhaustion
- **Checkpoint-based sync**: Long-running syncs can be paused/resumed across different pods using `SyncCheckpoint` model

### 4.5 Reliability

- **Retry with backoff**: `RetryHandler` implements exponential backoff with jitter and Retry-After header support
- **Auto-pause**: Triggers auto-pause after `TRIGGER_AUTO_PAUSE_THRESHOLD` consecutive failures; connectors auto-pause via `errorState.isPaused`
- **Distributed lock for OAuth refresh**: Prevents thundering herd on token refresh across pods; fallback: wait 2s then read updated token from DB
- **Per-piece error isolation**: `loadConnectors()` catches individual AP piece import failures without crashing the process

### 4.6 Observability

- **Structured logging**: All modules use `createLogger('module-name')` producing JSON logs
- **Sync metrics**: `SyncResult` captures documentsProcessed, documentsFailed, durationMs, paused, checkpointId
- **Connection health**: `TestResult.latencyMs`, `ConnectionRecord.status` (active/expired/revoked)
- **Trigger health**: `TriggerRegistration.lastFiredAt`, `consecutiveErrors`
- **Error state tracking**: `ConnectorConfig.errorState` with `lastErrorAt`, `lastErrorMessage`, `consecutiveFailures`

**Resolved**: OpenTelemetry spans added to both `ConnectorToolExecutor.execute()` (6 attributes: connector.name, action.name, tenant.id, project.id, execution.id, connection.scope) and `handleWebhook()` (3 attributes: connector.name, registration.id, tenant.id). Error states recorded with `SpanStatusCode.ERROR` and `recordException()`.

### 4.7 Security

- **SSRF protection**: HTTP connector blocks RFC 1918, loopback, link-local, IPv4-mapped IPv6, cloud metadata endpoints
- **Webhook signature verification**: HMAC-SHA256 with `crypto.timingSafeEqual`; connector-specific `verify()` callback takes priority
- **Replay protection**: Webhook timestamp check within `WEBHOOK_REPLAY_TOLERANCE_MS`
- **Idempotency**: Redis-based event ID dedup within `WEBHOOK_DEDUP_WINDOW_MS`
- **Credential redaction**: `ConnectionService` strips `encryptedCredentials` and `oauth2RefreshToken` from all API responses

### 4.8 Performance

- **Boot time**: 25 AP pieces loaded via sequential `import()` with per-piece error isolation; target < 3s
- **Static catalog**: `connector-catalog.json` generated at build time; Studio never imports AP piece code
- **Rate limiting**: Token bucket algorithm with configurable capacity and refill rate (e.g., SharePoint: 10K req/10min)
- **Delta sync**: Incremental updates via provider delta tokens; hourly scheduler checks for stale connectors
- **Connection resolution**: Two DB queries max (user-scoped, then tenant-scoped); < 100ms p99

### 4.9 Error Handling

- **Typed errors**: `ConnectionServiceError` with codes: `NOT_FOUND`, `VALIDATION_ERROR`, `UNKNOWN_CONNECTOR`, `DECRYPT_FAILED`
- **Structured results**: `SyncResult`, `ConnectionTestResult`, `ValidationResult`, `PermissionCrawlResult` all include success flag + error details
- **Graceful degradation**: OAuth2 refresh failure marks connection as `expired` rather than crashing; failed AP piece imports are logged and skipped
- **Timeout enforcement**: `ConnectorToolExecutor.executeWithTimeout()` wraps every action; configurable per call

### 4.10 Data Integrity

- **Atomic credential updates**: `findOneAndUpdate` with tenant filter ensures credentials are never partially written
- **Checkpoint consistency**: `SyncCheckpoint` stores pagination state, progress, and ETA; `resumeSync()` loads from checkpoint
- **Delta token management**: Per-drive tokens stored in `DriveDeltaToken` model; orphaned tokens cleaned up weekly by `cleanupOrphanedDeltaTokens()`
- **Idempotent webhook processing**: Redis-based dedup ensures each event is processed exactly once within the dedup window

### 4.11 Extensibility

- **Plugin architecture**: New connectors implement the `Connector` interface (SDK track) or `IConnector` interface (enterprise track)
- **Template method pattern**: `BaseSyncCoordinator` requires only `fetchDocuments()` and `getDeltaToken()` overrides for new enterprise connectors
- **Adapter pattern**: `wrapActivepiecesPiece()` can wrap any AP piece without modifying its code
- **Provider registry**: Nango's 600+ provider configs are imported once; new providers added by updating `providers.yaml`
- **90% code reuse**: New enterprise connectors need only ~450 LOC (OAuth provider ~100, API client ~200-300, sync coordinator ~150)

### 4.12 Migration and Backward Compatibility

- The connector SDK is additive -- no existing agent tools or workflows are affected
- AP piece adapter preserves the upstream piece interface; upgrades to AP piece packages are transparent
- Enterprise connectors (IConnector) operate independently of SDK connectors
- Static catalog generation is a build optimization; if the generated file is missing, the system falls back to dynamic loading
- `encryptionKeyVersion` on connections enables future key rotation without breaking existing encrypted credentials

## 5. Data Flow Diagrams

### 5.1 Agent Tool Execution Flow

```
Agent sends tool call: "slack.send_message"
  │
  ▼
ConnectorToolExecutor.execute(toolName, params, timeout)
  │
  ├── parseToolName("slack.send_message") → { connectorName: "slack", actionName: "send_message" }
  │
  ├── registry.getAction("slack", "send_message") → ConnectorAction
  │
  ├── connectionResolver.resolve({ connectorName, tenantId, projectId, userId })
  │   ├── Try user-scoped: findOne({ connectorName, tenantId, projectId, scope: "user", userId })
  │   └── Fallback tenant-scoped: findOne({ connectorName, tenantId, projectId, scope: "tenant" })
  │
  ├── connectionResolver.resolveAuth(connection)
  │   ├── If authProfileId → authProfileResolver.resolve()
  │   ├── If OAuth2 near-expiry → refreshOAuth2() with distributed lock
  │   └── Otherwise → decrypt(connection)
  │
  ├── Build ActionContext { auth, params, tenantId, projectId, userId, connectionScope, executionId, store }
  │
  └── executeWithTimeout(action.run(ctx), timeoutMs)
      └── Returns tool result to agent
```

### 5.2 OAuth2 Authorization Code Flow

```
Studio UI: user clicks "Connect"
  │
  ▼
POST /api/connectors/:id/auth/initiate
  │
  ├── Build authorization URL with client_id, redirect_uri, scope, state=connectionId
  ├── If PKCE: generate code_verifier, code_challenge
  └── Return { authorizationUrl }
  │
  ▼
Browser redirects to OAuth provider → user authorizes
  │
  ▼
Provider redirects to /api/connectors/auth/callback?code=xxx&state=connectionId
  │
  ├── Exchange code for tokens (POST to tokenUrl)
  ├── Encrypt access token → encryptedCredentials
  ├── Encrypt refresh token → oauth2RefreshToken
  ├── Set oauth2TokenExpiresAt
  └── Update connection status → "active"
```

### 5.3 Webhook Trigger Processing Flow

```
External service sends POST /webhooks/:connectorName/:registrationId
  │
  ▼
handleWebhook(req, deps)
  │
  ├── 1. Load registration: findOne({ _id, connectorName, status: "active" })
  │   └── 404 if not found
  │
  ├── 2. Connector-specific verify (if trigger.verify exists)
  │   └── 401 if invalid
  │
  ├── 3. Generic HMAC-SHA256 fallback (if no verify && webhookSecret exists)
  │   ├── Compare x-signature-256 header with computed HMAC
  │   └── 401 if mismatch (timing-safe comparison)
  │
  ├── 4. Replay protection: check x-webhook-timestamp
  │   └── 401 if stale (> WEBHOOK_REPLAY_TOLERANCE_MS)
  │
  ├── 5. Idempotency: Redis SET NX on event ID
  │   └── 200 { deduplicated: true } if already seen
  │
  ├── 6. Invoke Restate: startWorkflow(executionId, { workflowId, tenantId, triggerPayload })
  │   └── 503 if Restate unavailable
  │
  └── 7. Update trigger health: reset consecutiveErrors OR increment + auto-pause
```

## 6. Alternatives Considered

### 6.1 Dynamic Loading vs. Static Catalog

**Considered**: Dynamic import of all AP pieces at Studio boot.
**Rejected**: Turbopack bundler fails to resolve 24+ dynamic imports; Studio shows only the HTTP connector. Runtime dynamic loading works because it runs in Node.js without bundler constraints.
**Chosen**: Static `connector-catalog.json` generated at build time; Studio reads static JSON; Runtime dynamically loads for execution.

### 6.2 Unified Connector Interface vs. Two Tracks

**Considered**: Single interface for both SDK connectors (actions/triggers) and enterprise connectors (sync/permissions).
**Rejected**: The lifecycle requirements differ fundamentally -- SDK connectors are stateless action executors; enterprise connectors manage long-running sync state, checkpoints, permissions, and webhooks.
**Chosen**: SDK `Connector` interface for lightweight integrations; `IConnector` interface for enterprise data-source connectors. Both share `ConnectionResolver` for credential management.

### 6.3 Custom OAuth vs. Nango-Managed OAuth

**Considered**: Delegating all OAuth2 flows to Nango's managed service.
**Rejected**: Nango adds an external dependency and doesn't support device code flow; we need full control for tenant-scoped encryption and distributed lock refresh.
**Chosen**: Self-managed OAuth with Nango's `providers.yaml` imported for metadata only (token URLs, scopes, PKCE support).

### 6.4 BullMQ vs. Temporal/Restate for Trigger Scheduling

**Considered**: Using Restate or Temporal for all trigger scheduling.
**Rejected**: Polling and cron triggers are simple repeatable jobs that don't benefit from workflow orchestration overhead. BullMQ repeatable jobs are lightweight and already in the stack.
**Chosen**: BullMQ for polling/cron scheduling; Restate for workflow execution after trigger fires. Webhooks are push-based and need neither.

## 7. Open Questions and Known Gaps

| ID    | Question/Gap                                                                             | Status                                                                                                                             |
| ----- | ---------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------- |
| OQ-1  | No OpenTelemetry spans in connector execution                                            | **Resolved** — both `ConnectorToolExecutor` and webhook handler emit OTel spans via `@opentelemetry/api` (`abl-connectors` tracer) |
| OQ-2  | `token-manager.test.ts.skip` -- token manager test skipped                               | **Resolved** — tests rewritten against current TokenManager API (18 tests, all passing). Old `.skip` file retained for history     |
| OQ-3  | Delta sync scheduler uses `console.log` instead of `createLogger`                        | **Resolved** — migrated to `createLogger('connector-delta-sync')` in hardening phase 1                                             |
| OQ-4  | Delta sync scheduler uses `findById`-like patterns                                       | **Resolved** — switched to `findOne({ _id, tenantId })` pattern in hardening phase 1                                               |
| OQ-5  | No retention policy for WebhookDelivery logs                                             | **Resolved** — `webhook-delivery-retention.ts` provides tenant-scoped cleanup with configurable TTL                                |
| OQ-6  | ConnectorRegistry has no max size, TTL, or eviction policy                               | Violates CLAUDE.md rule (low risk — registry is read-only after boot with bounded 25 AP pieces)                                    |
| OQ-7  | Encryption key rotation procedure not implemented                                        | **Resolved** — `key-rotation.ts` provides batch re-encryption utility with per-connection error isolation                          |
| OQ-8  | No circuit breaker for external API calls                                                | **Resolved** — `circuit-breaker.ts` in-process breaker (CLOSED→OPEN→HALF_OPEN) added to base client                                |
| OQ-9  | Webhook renewal scheduler exists but wiring to specific connectors needs verification    | **Verified with gaps** — see Post-Implementation Notes §9.1                                                                        |
| OQ-10 | Channel OAuth providers (runtime) and Connector OAuth (SDK) are parallel implementations | **Documented** — consolidation path in `docs/plans/oauth-consolidation-path.md`; Phase 1 (shared exchange lib) recommended         |

## 8. Post-Implementation Notes (Hardening — 2026-03-25)

Three hardening commits resolved 5 of 10 open questions and added first E2E test coverage:

**Phase 1 — Code Quality** (`7d412d63f`): Replaced `console.log` with `createLogger`, fixed `findById`-like patterns to `findOne({_id, tenantId})` in delta-sync scheduler, added structured error codes to connector-tool-executor.

**Phase 2 — Observability & Security** (`ccb29ae08`): Added circuit breaker (`circuit-breaker.ts`), encryption key rotation utility (`key-rotation.ts`), webhook delivery retention policy (`webhook-delivery-retention.ts`), OpenTelemetry tracing in webhook handler.

**Phase 3 — E2E Tests** (`6ab45097f`): Added 3 E2E test suites: connection CRUD lifecycle (555 LOC), connection test lifecycle (499 LOC), webhook trigger processing (544 LOC). All exercise real HTTP API with full middleware chain. No mocks of codebase components.

**Phase 5 — Consolidation** (2026-03-25): Token manager test rewritten (18 tests), OAuth consolidation path documented, webhook renewal wiring verified with gaps identified.

**Phase 6-7 — HTTP-Level E2E + Skipped Test Fixes** (2026-03-25): Added 5 HTTP-level E2E test files across runtime (4) and search-ai (1) covering 8 E2E scenarios. Fixed 47 previously skipped tests across 5 files.

### 8.1 Runtime Connection Route Permissions

Runtime connection CRUD routes (created in Phase 4 for E2E testability) use **singular** permission strings per `apps/studio/src/lib/permissions.ts`:

| Operation          | Permission          |
| ------------------ | ------------------- |
| List connections   | `connection:read`   |
| Get connection     | `connection:read`   |
| Create connection  | `connection:write`  |
| Update connection  | `connection:write`  |
| Delete connection  | `connection:delete` |
| Test connection    | `connection:read`   |
| Trigger management | `connection:write`  |

**Note:** The codebase has no trigger-specific permissions (`triggers:read/write`). Trigger management routes reuse `connection:read` / `connection:write`. This is intentional — triggers are a sub-resource of connections.

### 9.1 Webhook Renewal Wiring Verification (OQ-9)

**Summary:** The webhook renewal scheduler code exists and is correctly structured, but has three gaps preventing production operation.

**What works:**

- `apps/search-ai/src/scheduler/webhook-renewal.ts` exports `renewExpiringWebhookSubscriptions()` and `cleanupExpiredWebhookSubscriptions()`
- `apps/search-ai/src/scheduler/index.ts` wires both into BullMQ repeatable jobs: renewal every 12h (`0 */12 * * *`), cleanup daily at 2 AM (`0 2 * * *`)
- The scheduler correctly groups subscriptions by connector and calls `SharePointWebhookManager.renewSubscriptions(24)` per connector
- `SharePointWebhookManager` correctly renews Graph API subscriptions and tracks renewal failures (auto-fails after 3 consecutive failures)
- Cleanup correctly deletes subscriptions expired for 7+ days and attempts Graph API unsubscription first

**Gap 1 — Scheduler not started:** `startScheduledJobs()` is exported from `apps/search-ai/src/scheduler/index.ts` but is **never called** from `startServer()` in `apps/search-ai/src/server.ts`. The ingestion workers start via `startWorkers()` but the scheduler is not wired in. **Impact:** Webhook subscriptions will expire after 24 hours without renewal.

**Gap 2 — Hardcoded mock token:** Both `renewExpiringWebhookSubscriptions()` and `cleanupExpiredWebhookSubscriptions()` create `GraphClient` instances with `accessToken: 'mock-token'` (lines 67-69, 147-149 in `webhook-renewal.ts`). The TODO comments say "Load OAuth token from EndUserOAuthToken model". **Impact:** Graph API calls will fail with 401 Unauthorized.

**Gap 3 — Missing tenant isolation:** `renewExpiringWebhookSubscriptions()` queries `WebhookSubscriptionConnector.find({ status: 'active', expiresAt: ... })` without `tenantId` filter. Similarly, `ConnectorConfig.findOne({ _id: connectorId })` lacks `tenantId`. **Impact:** Violates CLAUDE.md tenant isolation rule; however, since this is a background job processing all tenants, cross-tenant data leakage is mitigated by the fact that each subscription already tracks its `connectorId` which links to a specific tenant.

**Gap 4 — Uses `console.log` instead of `createLogger`:** All logging in `webhook-renewal.ts` uses `console.log`/`console.error`/`console.warn` instead of the platform `createLogger` pattern.

**Recommendations:**

1. **P0**: Wire `startScheduledJobs()` into `startServer()` in `server.ts` (after Redis initialization)
2. **P0**: Replace mock token with actual OAuth token loaded from `EndUserOAuthToken` model (requires tenant-scoped encryption service)
3. **P1**: Add `tenantId` to the `ConnectorConfig.findOne()` call (the subscription already tracks `connectorId` which is per-tenant, but explicit filtering is safer)
4. **P1**: Replace `console.log` with `createLogger('webhook-renewal')`

**Test coverage:** No unit or integration tests exist for the webhook renewal scheduler. The `SharePointWebhookManager.renewSubscriptions()` method is tested indirectly through the webhook manager's subscription lifecycle.

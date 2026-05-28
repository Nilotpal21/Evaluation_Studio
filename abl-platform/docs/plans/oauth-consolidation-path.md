# OAuth Consolidation Path (OQ-10)

**Date:** 2026-03-25
**Status:** Proposal (documentation only)
**HLD Reference:** `docs/specs/connectors.hld.md` — OQ-10

---

## 1. Problem Statement

The ABL Platform has **three parallel OAuth implementations** that share significant overlap in token exchange, state management, refresh, and revocation logic. This creates maintenance burden and inconsistency risk.

## 2. Current OAuth Implementations

### 2.1 Tool OAuth Service (`apps/runtime/src/services/tool-oauth-service.ts`)

**Purpose:** End-user OAuth for agent tools (Google Calendar, Slack user tokens, Microsoft Graph user access).

| Aspect                       | Detail                                                                                   |
| ---------------------------- | ---------------------------------------------------------------------------------------- |
| **Flow**                     | Authorization Code + PKCE                                                                |
| **State management**         | `OAuthStateStore` (Redis-backed) with CSRF state                                         |
| **Token storage**            | `OAuthTokenStore` interface (pluggable, backed by `EndUserOAuthToken` model)             |
| **Token encryption**         | Tenant-scoped AES-256-GCM via `EncryptionService.encryptForTenant()`                     |
| **Refresh**                  | Automatic refresh on `getAccessToken()` when token near expiry                           |
| **Revocation**               | Provider-specific revoke + DB deletion                                                   |
| **Provider config**          | `OAuthProviderConfig` objects registered at boot; env vars for `clientId`/`clientSecret` |
| **Routes**                   | `POST /api/v1/oauth/authorize/:provider`, `GET /api/v1/oauth/callback`                   |
| **Auth profile integration** | Yes — resolves via `AuthProfileOAuthResolver` when `authProfileId` present               |
| **JIT delivery**             | Yes — pauses agent execution, delivers token via WebSocket on callback                   |

### 2.2 Channel OAuth Service (`apps/runtime/src/services/channel-oauth/`)

**Purpose:** Channel connection OAuth for Slack bots, MS Teams bots, Meta (WhatsApp/Messenger).

| Aspect               | Detail                                                                                                 |
| -------------------- | ------------------------------------------------------------------------------------------------------ |
| **Flow**             | Authorization Code (provider-specific)                                                                 |
| **State management** | Reuses `OAuthStateStore` from ToolOAuthService                                                         |
| **Token storage**    | Returned to caller; stored in `ChannelConnection.encryptedCredentials`                                 |
| **Token encryption** | Caller encrypts; not handled by the service itself                                                     |
| **Refresh**          | Not implemented (channel tokens are long-lived or managed externally)                                  |
| **Revocation**       | Not implemented (channel disconnection deletes the connection)                                         |
| **Provider config**  | Channel-specific providers: `SlackOAuthProvider`, `MSTeamsOAuthProvider`, `MetaOAuthProvider`          |
| **Routes**           | `POST /api/v1/channel-oauth/:channelType/authorize`, `GET /api/v1/channel-oauth/:channelType/callback` |
| **Interface**        | `ChannelOAuthProvider { buildAuthorizeUrl, exchangeCode }`                                             |

### 2.3 Connector SDK OAuth (`packages/connectors/src/auth/`)

**Purpose:** OAuth for connector actions and enterprise data source connectors (SharePoint, Jira, etc.).

| Aspect               | Detail                                                                                              |
| -------------------- | --------------------------------------------------------------------------------------------------- |
| **Flow**             | Authorization Code (with PKCE), Device Code (RFC 8628), Client Credentials                          |
| **State management** | N/A (initiation done via API routes in SearchAI)                                                    |
| **Token storage**    | `ConnectorConnection.encryptedCredentials` + `oauth2RefreshToken`                                   |
| **Token encryption** | `EncryptionService.encryptForTenant()` in `ConnectionService` and `ConnectionResolver`              |
| **Refresh**          | `ConnectionResolver.refreshOAuth2()` with distributed locking via Redis `SET NX PX`                 |
| **Revocation**       | Connection deletion                                                                                 |
| **Provider config**  | Nango `ProviderConfigRegistry` (600+ providers from `providers.yaml`)                               |
| **Routes**           | `POST /api/indexes/:indexId/connectors/:id/auth/initiate`, callback via SearchAI routes             |
| **Enterprise base**  | `TokenManager` class in `packages/connectors/base/src/auth/` for enterprise connectors (SharePoint) |

## 3. Overlap Analysis

### Shared Logic

| Concern                 | Tool OAuth                                              | Channel OAuth                             | Connector OAuth                                      |
| ----------------------- | ------------------------------------------------------- | ----------------------------------------- | ---------------------------------------------------- |
| CSRF state generation   | `crypto.randomBytes(32)`                                | Reuses Tool OAuth's `OAuthStateStore`     | N/A (state in DB)                                    |
| Code → token exchange   | `fetch(tokenUrl, { grant_type: 'authorization_code' })` | Same pattern per provider                 | Same in `ConnectionResolver.refreshOAuth2()`         |
| Token refresh           | `ToolOAuthService.refreshAndStore()`                    | None                                      | `ConnectionResolver.refreshOAuth2()` with dist. lock |
| Redirect URI validation | `isAllowedRedirectUri()` in oauth route                 | Same function in channel-oauth route      | N/A                                                  |
| Provider config lookup  | `OAuthProviderConfig` registered at boot                | `ChannelOAuthProvider` registered at boot | `getProviderConfig()` from Nango registry            |
| Token encryption        | `encryptForTenant()`/`decryptForTenant()`               | Caller handles                            | `encryptForTenant()`/`decryptForTenant()`            |

### Key Differences

| Concern                          | Why It Differs                                                                                                    |
| -------------------------------- | ----------------------------------------------------------------------------------------------------------------- |
| **JIT delivery**                 | Only Tool OAuth needs to pause agent execution and deliver tokens via WebSocket mid-conversation                  |
| **Auth profiles**                | Only Tool OAuth integrates with auth profile resolution (dual-read migration)                                     |
| **Device code flow**             | Only Connector OAuth supports RFC 8628 (CLI-initiated, no browser redirect)                                       |
| **Distributed lock on refresh**  | Only Connector OAuth uses Redis locks for refresh (multi-pod concern for long-running syncs)                      |
| **Channel-specific credentials** | Channel OAuth returns structured credentials (bot_token + signing_secret for Slack) rather than raw access tokens |
| **Provider metadata**            | Connector OAuth uses Nango's 600+ provider registry; Tool OAuth and Channel OAuth use hardcoded configs           |

## 4. Consolidation Path

### Phase 1: Shared OAuth Token Exchange Library (Low Risk)

**Extract a shared `OAuthTokenExchange` utility** into `packages/shared/src/oauth/`.

```
packages/shared/src/oauth/
├── token-exchange.ts       # exchangeAuthorizationCode(), refreshAccessToken()
├── state-manager.ts        # OAuthStateStore (already exists in runtime, make it shared)
├── redirect-validator.ts   # isAllowedRedirectUri() (identical in both route files)
└── index.ts
```

**What moves:**

- `exchangeAuthorizationCode(tokenUrl, { code, clientId, clientSecret, redirectUri })` — generic fetch-based exchange
- `refreshAccessToken(tokenUrl, { refreshToken, clientId, clientSecret })` — generic refresh
- `OAuthStateStore` interface + Redis implementation — currently runtime-only
- `isAllowedRedirectUri()` + `getAllowedRedirectOrigins()` — duplicated across routes

**What stays per-service:**

- Tool OAuth: JIT delivery, auth profile resolution, WebSocket integration
- Channel OAuth: Provider-specific credential mapping (Slack bot_token, Meta page_access_token)
- Connector OAuth: Device code flow, distributed lock refresh, Nango provider registry

**Breaking changes:** None. Each service imports the shared utility and delegates the HTTP exchange to it. Existing APIs and behavior are unchanged.

**Estimated effort:** 2-3 days

### Phase 2: Unified Provider Registry (Medium Risk)

**Merge channel OAuth providers into the Nango-based `ProviderConfigRegistry`.**

Currently, `SlackOAuthProvider`, `MSTeamsOAuthProvider`, and `MetaOAuthProvider` hardcode their authorize/token URLs. The Nango registry already has configs for these providers.

**Steps:**

1. Add `channelType` field to `ProviderConfig` for channel-specific providers
2. Register Slack, MSTeams, Meta in the provider registry with their `channelType`
3. Refactor `ChannelOAuthProvider` implementations to use `getProviderConfig()` for URLs/scopes
4. Keep `exchangeCode()` custom per channel (credential mapping is provider-specific)

**Breaking changes:** None externally. Internal refactor only.

**Estimated effort:** 3-4 days

### Phase 3: ConnectionResolver as Universal OAuth Resolver (Higher Risk)

**Extend `ConnectionResolver` to handle channel connections and tool OAuth tokens, not just connector connections.**

This phase is more speculative and should be evaluated after Phases 1-2.

**Considerations:**

- `ConnectionResolver.resolve()` already supports user-scoped and tenant-scoped resolution
- Adding `scope: 'channel'` would allow channel connections to use the same resolution logic
- Tool OAuth tokens could be modeled as `ConnectionRecord` entries with `authType: 'oauth2'`
- JIT delivery and auth profile resolution would need to remain in the runtime layer

**Risk:** This conflates three currently independent data models (`EndUserOAuthToken`, `ChannelConnection`, `ConnectorConnection`) into a single abstraction. The benefit is query simplification but the cost is coupling.

**Recommendation:** Defer Phase 3 until Phases 1-2 prove the shared library pattern works. Evaluate based on real usage patterns.

## 5. Migration Strategy

### For Each Phase

1. **Extract shared code** to new location (no behavior change)
2. **Add imports** in existing services, delegating to shared code
3. **Verify** all existing tests pass (no API changes)
4. **Remove duplicated code** from original locations
5. **Update SDLC docs** (HLD, test spec)

### Backward Compatibility

- No API endpoint changes in any phase
- No data model changes in Phases 1-2
- Token format and encryption remain unchanged
- Existing provider registrations continue to work

## 6. Decision: Not Consolidating Yet

The three OAuth implementations serve genuinely different use cases with different lifecycle requirements:

- **Tool OAuth** is session-scoped (JIT delivery during agent conversation)
- **Channel OAuth** is connection-scoped (one-time setup, long-lived credentials)
- **Connector OAuth** is sync-scoped (distributed, needs lock coordination)

Full consolidation into a single service would conflate these lifecycles and increase coupling without proportional benefit. The recommended path is **Phase 1 only** (shared token exchange library) which eliminates code duplication without introducing coupling.

## 7. References

| File                                                                          | Implementation                           |
| ----------------------------------------------------------------------------- | ---------------------------------------- |
| `apps/runtime/src/services/tool-oauth-service.ts`                             | Tool OAuth Service                       |
| `apps/runtime/src/services/channel-oauth/channel-oauth-service.ts`            | Channel OAuth Service                    |
| `apps/runtime/src/services/channel-oauth/channel-oauth-provider.ts`           | Channel OAuth Provider interface         |
| `apps/runtime/src/services/channel-oauth/providers/slack-oauth-provider.ts`   | Slack OAuth                              |
| `apps/runtime/src/services/channel-oauth/providers/msteams-oauth-provider.ts` | MSTeams OAuth                            |
| `apps/runtime/src/services/channel-oauth/providers/meta-oauth-provider.ts`    | Meta (WhatsApp/Messenger) OAuth          |
| `apps/runtime/src/routes/oauth.ts`                                            | Tool OAuth routes                        |
| `apps/runtime/src/routes/channel-oauth.ts`                                    | Channel OAuth routes                     |
| `packages/connectors/src/auth/connection-resolver.ts`                         | Connector OAuth (ConnectionResolver)     |
| `packages/connectors/src/auth/provider-config-registry.ts`                    | Nango provider registry (600+ providers) |
| `packages/connectors/base/src/auth/token-manager.ts`                          | Enterprise connector token management    |
| `packages/connectors/base/src/auth/device-code-flow.ts`                       | RFC 8628 device code flow                |

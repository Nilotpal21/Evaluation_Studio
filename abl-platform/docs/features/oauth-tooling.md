# Feature Spec: OAuth Tooling

**Date:** 2026-03-23
**Status:** ALPHA
**Owner:** Platform Team
**Slug:** `oauth-tooling`

---

## 1. Problem Statement

ABL Platform agents call external APIs via HTTP tools (Google Calendar, Slack, Salesforce, etc.) that require OAuth 2.0 authentication. Today, the platform has fragmented OAuth support spread across multiple subsystems:

1. **ToolOAuthService** (`apps/runtime/src/services/tool-oauth-service.ts`) handles end-user authorization code flows, but is tightly coupled to runtime-local state and has no Studio UI for management.
2. **Auth Profiles** (`packages/shared/src/services/auth-profile/`) provide a comprehensive credential management system (`oauth2_app`, `oauth2_token`, `oauth2_client_credentials`) with encrypted storage, token refresh, and distributed locking -- but are not wired into the Studio tool configuration UI.
3. **Project Tool Schemas** (`packages/shared/src/validation/project-tool-schemas.ts`) define `oauth2_client` and `oauth2_user` auth types for HTTP tools, but the Studio `HttpConfigForm` only renders basic auth fields (token, apiKey) without OAuth-specific configuration.
4. **Connector OAuth** (`apps/studio/src/lib/connector-oauth.ts`) handles OAuth for SearchAI connectors with in-memory pending state (violating the stateless distributed invariant for multi-pod deployments).

Users cannot:

- Configure OAuth-authenticated HTTP tools through the Studio UI
- Link tools to Auth Profiles for centralized credential management
- See which tools require end-user OAuth consent and which use shared client credentials
- Monitor token health (expired, revoked, approaching expiry) per tool
- Test OAuth-authenticated tools from the Studio tool editor

### Impact

| Gap                                          | Severity | Impact                                                        |
| -------------------------------------------- | -------- | ------------------------------------------------------------- |
| No Studio UI for OAuth tool configuration    | Critical | Users must manually configure OAuth via API or DSL            |
| ToolOAuthService not linked to Auth Profiles | High     | Duplicate credential management, no centralized rotation      |
| Connector OAuth uses in-memory state         | High     | Multi-pod deployments lose OAuth state on pod restart/scaling |
| No token health visibility                   | Medium   | Silent failures when tokens expire without monitoring         |
| No tool-level OAuth testing in Studio        | Medium   | Users cannot verify OAuth setup before deployment             |

---

## 2. Scope

### In Scope

1. **Studio OAuth Tool Configuration UI** -- OAuth-specific panels in the HTTP tool editor for configuring `oauth2_client` and `oauth2_user` auth types, including Auth Profile linking.
2. **Auth Profile Integration for Tools** -- Wire tool auth resolution to use Auth Profiles (`oauth2_app` + `oauth2_token` for user flows, `oauth2_client_credentials` for M2M) instead of legacy `ToolOAuthService` ad-hoc provider configs.
3. **End-User OAuth Consent Flow (Studio)** -- A complete consent flow within Studio: initiate authorization, redirect to provider, handle callback, store tokens as Auth Profile `oauth2_token` linked to the `oauth2_app`.
4. **Token Health Dashboard** -- Per-tool token status indicators (active, expiring, expired, revoked) in the Studio tool list and detail views.
5. **Tool OAuth Test Runner** -- "Test Connection" button in the Studio tool editor that executes a health-check request using the resolved OAuth credentials.
6. **Connector OAuth Migration to Auth Profiles** -- Migrate `connector-oauth.ts` in-memory state to Redis-backed Auth Profile flow, unifying connector and tool OAuth under one system.

### Out of Scope

- OAuth 2.0 Device Authorization Grant (RFC 8628) -- already implemented in `device-auth-service.ts`
- SAML, Kerberos, or other Phase 3 enterprise auth types
- Auth Profile key rotation and grace period logic (tracked in `docs/plans/2026-03-13-auth-profile-infrastructure-gaps.md`)
- Multi-tenant OAuth app marketplace (tenant-shared OAuth app definitions)

---

## 3. Requirements

### Functional Requirements

| ID    | Requirement                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                    | Priority |
| ----- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | -------- |
| FR-1  | Studio HTTP tool editor MUST render OAuth-specific config fields when auth type is `oauth2_client` or `oauth2_user`                                                                                                                                                                                                                                                                                                                                                                                                                            | P0       |
| FR-2  | OAuth tool config MUST support linking to an existing `oauth2_app` Auth Profile for provider credentials                                                                                                                                                                                                                                                                                                                                                                                                                                       | P0       |
| FR-3  | For `oauth2_user` tools, Studio MUST provide a "Connect Account" button that initiates the authorization code flow with PKCE                                                                                                                                                                                                                                                                                                                                                                                                                   | P0       |
| FR-4  | OAuth callback MUST create/update an `oauth2_token` Auth Profile linked to the `oauth2_app`, scoped to the current user                                                                                                                                                                                                                                                                                                                                                                                                                        | P0       |
| FR-5  | For `oauth2_client` tools, Studio MUST show the token URL and scopes from the linked `oauth2_app` Auth Profile                                                                                                                                                                                                                                                                                                                                                                                                                                 | P1       |
| FR-6  | Tool list view MUST show token health status (active/expiring/expired/revoked) for OAuth-authenticated tools                                                                                                                                                                                                                                                                                                                                                                                                                                   | P1       |
| FR-7  | Studio tool editor MUST provide a "Test Connection" button that executes a test request with resolved OAuth credentials                                                                                                                                                                                                                                                                                                                                                                                                                        | P1       |
| FR-8  | Runtime tool execution MUST resolve OAuth credentials via Auth Profile chain: `oauth2_token` (user) or `oauth2_client_credentials` (M2M) -> linked `oauth2_app`                                                                                                                                                                                                                                                                                                                                                                                | P0       |
| FR-9  | Token refresh MUST be handled transparently during tool execution using the existing `token-refresh-service.ts` with distributed locking                                                                                                                                                                                                                                                                                                                                                                                                       | P0       |
| FR-10 | Connector OAuth flows MUST be migrated from in-memory state store to Redis-backed state (reuse `RedisOAuthStateStore`)                                                                                                                                                                                                                                                                                                                                                                                                                         | P1       |
| FR-11 | Tools that resolve credentials via an existing `oauth2_app` or `oauth2_token` profile MUST NOT initiate a new OAuth user-consent flow at bind or run time. Re-consent only happens when the underlying token is missing/expired and `usageMode = 'preflight' \| 'jit'` requires it. Mirrors the auth-profile FR-10 contract (see [auth-profiles FR-10, ABLP-619](./auth-profiles.md#4-functional-requirements)) and is regression-tested for workflow integration nodes by `apps/studio/e2e/auth-profiles/integration-bind-no-consent.e2e.ts`. | P0       |

### Non-Functional Requirements

| ID    | Requirement                                                                                                     | Priority |
| ----- | --------------------------------------------------------------------------------------------------------------- | -------- |
| NFR-1 | OAuth state parameters MUST use CSPRNG (32 bytes hex) and expire within 10 minutes                              | P0       |
| NFR-2 | All tokens MUST be encrypted at rest via tenant-scoped AES-256-GCM (existing `encryptionPlugin`)                | P0       |
| NFR-3 | OAuth redirect URIs MUST be validated against a configurable allowlist (`security.oauthAllowedRedirectOrigins`) | P0       |
| NFR-4 | Token refresh MUST use distributed Redis locks to prevent concurrent refresh from multiple pods                 | P0       |
| NFR-5 | Studio OAuth UI MUST not expose `clientSecret` in the browser -- all token exchanges happen server-side         | P0       |
| NFR-6 | PKCE (`S256` method) MUST be used for all authorization code flows initiated from Studio                        | P0       |
| NFR-7 | Token health checks MUST complete within 5 seconds (fail-open: show "unknown" status on timeout)                | P1       |
| NFR-8 | All OAuth operations MUST emit `TraceEvent`s via the existing `auth-profile/trace-events.ts` system             | P1       |

---

## 4. User Stories

### US-1: Configure OAuth Client Credentials Tool

**As a** platform builder,
**I want to** configure an HTTP tool to use OAuth2 client credentials,
**So that** the tool can authenticate with a third-party API using M2M credentials without user interaction.

**Acceptance Criteria:**

- Select `oauth2_client` as auth type in HTTP tool editor
- Link to an existing `oauth2_app` Auth Profile
- Configure scopes for the client credentials grant
- Token is automatically obtained and refreshed at runtime

### US-2: Configure End-User OAuth Tool

**As a** platform builder,
**I want to** configure an HTTP tool that requires end-user OAuth consent,
**So that** each user's interactions with the tool use their own OAuth tokens.

**Acceptance Criteria:**

- Select `oauth2_user` as auth type in HTTP tool editor
- Link to an existing `oauth2_app` Auth Profile
- Configure required scopes
- "Connect Account" button initiates OAuth flow
- Callback stores tokens as user-scoped `oauth2_token` Auth Profile

### US-3: Monitor Token Health

**As a** platform builder,
**I want to** see the health status of OAuth tokens for my tools,
**So that** I can proactively address expired or revoked tokens before they cause runtime failures.

**Acceptance Criteria:**

- Tool list shows status badge (active/expiring/expired/revoked)
- Tool detail shows token expiry timestamp
- "Expiring" status triggers when token expires within 24 hours
- Clicking a revoked/expired token shows "Reconnect" action

### US-4: Test OAuth Tool Connection

**As a** platform builder,
**I want to** test my OAuth-configured tool from the Studio editor,
**So that** I can verify the OAuth setup works before deploying the agent.

**Acceptance Criteria:**

- "Test Connection" button visible when tool has OAuth config
- Executes a lightweight health-check request (HEAD or GET to endpoint)
- Shows success/failure with HTTP status and latency
- Displays clear error message if token is missing, expired, or invalid

### US-5: End-User Connects OAuth Account at Runtime (Deferred)

**As an** end user interacting with an agent,
**I want to** be prompted to connect my account when the agent needs OAuth access,
**So that** the agent can perform actions on my behalf with my credentials.

**Note:** This user story requires runtime session pause/resume, WebSocket consent protocol, and cross-service callback coordination. It is deferred to a follow-up iteration. For the initial release, end-user OAuth tokens must be connected via Studio before agent deployment. The existing `auth-profile-handoff.ts` validation will report missing tokens at handoff time.

**Acceptance Criteria (deferred):**

- Runtime detects missing user token for `per_user` tool
- WebSocket message sent to client with authorization URL
- User completes OAuth flow in browser
- Runtime receives token via callback and resumes execution
- Session is paused during OAuth flow (no timeout)

---

## 5. Design Decisions

| Decision                               | Choice                                                     | Rationale                                                                                                          |
| -------------------------------------- | ---------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------ |
| Auth Profile as single source of truth | All OAuth credentials stored as Auth Profiles              | Eliminates duplication between `EndUserOAuthToken` and `AuthProfile`; single encryption, rotation, and audit path  |
| PKCE mandatory for browser flows       | `S256` PKCE for all Studio-initiated flows                 | Security best practice; prevents authorization code interception                                                   |
| Server-side token exchange             | Studio API routes handle code-for-token exchange           | `clientSecret` never exposed to browser                                                                            |
| Redis-backed OAuth state               | Reuse `RedisOAuthStateStore` from `tool-oauth-service.ts`  | Multi-pod safe; already production-tested                                                                          |
| Gradual migration                      | `authProfileId` enables the new path per consumer          | Allows incremental rollout while `AuthProfileOAuthResolver` retains legacy fallback where no profile is configured |
| Token health polling                   | Studio polls token status on tool list load (no WebSocket) | Simpler implementation; token status changes infrequently                                                          |

---

## 6. Dependencies

| Dependency                                                                         | Status      | Impact                                        |
| ---------------------------------------------------------------------------------- | ----------- | --------------------------------------------- |
| Auth Profile Phase 1-3 (`oauth2_app`, `oauth2_token`, `oauth2_client_credentials`) | Implemented | Foundation for credential storage             |
| `token-refresh-service.ts` with distributed locking                                | Implemented | Token refresh during execution                |
| `RedisOAuthStateStore`                                                             | Implemented | Multi-pod OAuth state management              |
| `applyAuth` dispatcher                                                             | Implemented | Applies resolved credentials to HTTP requests |
| Studio `HttpConfigForm` component                                                  | Implemented | UI extension point for OAuth fields           |
| `project-tool-schemas.ts` with `oauth2_client`/`oauth2_user` types                 | Implemented | Validation schemas for tool auth types        |

---

## 7. Success Metrics

| Metric                         | Target                    | Measurement                                                                 |
| ------------------------------ | ------------------------- | --------------------------------------------------------------------------- |
| OAuth tool configuration time  | < 5 minutes end-to-end    | Time from "New Tool" to successful test                                     |
| Token refresh success rate     | > 99.5%                   | `REFRESH_SUCCESS` / (`REFRESH_SUCCESS` + `REFRESH_ERROR`) from trace events |
| OAuth-related runtime errors   | < 0.1% of tool executions | Error rate from `tool_execution_error` traces with OAuth-related codes      |
| Studio test connection latency | < 3 seconds p95           | Measured from button click to result display                                |

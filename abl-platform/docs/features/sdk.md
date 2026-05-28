# Feature: SDK

**Doc Type**: MAJOR FEATURE
**Parent Feature**: N/A
**Status**: BETA
**Feature Area(s)**: `customer experience`, `integrations`, `agent lifecycle`, `admin operations`, `observability`
**Package(s)**: `packages/web-sdk`, `apps/runtime`, `apps/studio`, `packages/shared-auth`, `packages/config`
**Owner(s)**: `Platform team`
**Testing Guide**: [docs/testing/sdk.md](../testing/sdk.md)
**HLD Spec**: [docs/specs/sdk-auth-session-unification.hld.md](../specs/sdk-auth-session-unification.hld.md)
**LLD Spec**: [docs/specs/sdk-auth-session-unification.lld.md](../specs/sdk-auth-session-unification.lld.md)
**Last Updated**: 2026-04-14

---

## 1. Introduction / Overview

### Problem Statement

Embedded agent experiences need one secure, reusable SDK surface for chat, voice, widget rendering, preview/share flows, and session bootstrap. Without a unified contract, every integrator would rebuild bootstrap, transport, identity, auth-preflight, and widget behavior differently, which raises risk and creates operational drift.

### Goal Statement

Provide one supported SDK architecture in which every session is authenticated at the tenant, project, and channel level, optional end-user identity is verified before it affects authorization, anonymous users can still authenticate tools at session scope, and all browser and Studio flows converge on one Runtime-trusted `sdk_session` path.

### Summary

The SDK feature includes the browser package in `packages/web-sdk`, Runtime bootstrap and transport in `apps/runtime`, and Studio-managed widget, preview, and share surfaces in `apps/studio`.

Planned follow-up work for this feature is a named `renderables[]` wire contract for customer-defined UI payloads. The goal is to let sync API clients, raw `sdk_websocket` consumers, custom UIs built on the Web SDK, and `http_async` webhook consumers all receive the same structured payload with a stable external name such as `com.bank.account_summary.v1`, instead of depending only on the fixed built-in `richContent` schema.

The required long-term model is:

- Runtime is the only trusted issuer of `sdk_session`.
- `sdk_session` always carries tenant, project, channel, and least-privilege permission scope.
- Verified end-user identity is optional and separate from channel/session authorization.
- Anonymous SDK callers are allowed, but any OAuth or auth-preflight grants must remain session-scoped.
- The browser SDK fails closed on missing configuration and only reports `connect()` success after the Runtime session is ready.

Current repo status is now substantially aligned with that model:

- The checked-in browser SDK already uses `POST /api/v1/sdk/init`, `POST /api/v1/sdk/refresh`, `/ws/sdk` with `Sec-WebSocket-Protocol: sdk-auth,<token>`, and `X-SDK-Token` for HTTP SDK routes.
- Query-string bearer transport for supported SDK browser flows is removed.
- Studio preview/share routes now create bootstrap artifacts and exchange them through Runtime; Studio no longer signs Runtime-trusted `sdk_session` tokens directly.
- Share links are fragment-delivered on initial load, and the `/preview` surface only keeps the share artifact in `sessionStorage` long enough to survive same-tab retry before a successful exchange clears it.
- Studio preview/share bootstrap artifacts now bind to a real active SDK channel; an explicit `channelId` wins when supplied, otherwise Studio first uses a valid widget-configured default channel, then auto-resolves when exactly one active channel remains, and only returns `409` when multiple active channels still remain ambiguous.
- Studio SDK control-plane routes now share the same project-scoped SDK access helper for preview/share, keys, embed, widget management, and Runtime SDK channel proxy access instead of mixing owner-only and tenant-level checks.
- Studio SDK control-plane access no longer treats generic tenant permissions such as `project:read` as a project-membership bypass. Only the project owner, an allowed project member, or true project-wide authority such as `project:*` can cross the helper.
- The current Studio Runtime SDK channel proxy contract requires `projectId` as a query param on list/create routes only; detail/update/delete recover project scope from the tenant-bound channel record before forwarding through the tenant-scoped Runtime admin path.
- SDK session issuance now separates `sessionPrincipal`, `verifiedUserId`, and `authScope`, and unsigned `userContext` is treated as metadata rather than an ownership key.
- Runtime enforces config-backed `userContext` limits plus signed-identity envelope shape (`hmac`, Unix-seconds `timestamp`) at bootstrap/token-normalization boundaries, shared-auth consumes the normalized token state, and the published browser SDK mirrors those local limits without duplicating Runtime freshness-window checks.
- Public-key `sdk_session` refresh now fails closed when the bound SDK channel is deactivated, even if the previously issued bearer token is still unexpired.
- Public-key `sdk_session` refresh now carries the originating bootstrap key reference and fails closed if the channel is rebound away from that key.
- SDK/browser-facing JIT OAuth callbacks now require an explicit `RUNTIME_PUBLIC_BASE_URL`; Runtime no longer falls back to localhost or internal server URLs when building browser OAuth callback targets.
- Runtime now selects distributed OAuth callback state outside tests for both `ToolOAuthService` and `ChannelOAuthService` only when Redis is actually ready, with in-memory fallback limited to test mode; deployment/failover proof is still open.
- Runtime session browsing/close/delete routes now have route-module proof that traces/export/generations fail closed when project-scoped authorization or session ownership cannot be verified, RuntimeExecutor-only session-list fallback preserves SDK and non-elevated-user ownership scoping during DB unavailability, SDK callers and non-elevated user callers do not fall back to active in-memory runtime sessions for explicit trace/export/generation lookups without persisted ownership proof, and explicit close/delete cleanup uses the stored `runtimeSessionId` for executor/trace cleanup instead of the request alias. The separate `runtimeSessionId` path is a legacy/compatibility lane for records that still differ from the unified session `_id`.
- Shared-auth and project-scoped session access now treat session-scoped SDK ownership as principal-only: legacy channel-artifact-only rows no longer match anonymous/session-scoped callers by shared device artifact.
- Shared-auth session ownership middleware now truly passes elevated users through without a persisted-session lookup, so runtime-only `:id` routes keep working for project-authorized admins while non-admin and SDK callers still require ownership proof.
- The browser SDK now fails closed when `endpoint` is missing and resolves `connect()` only after Runtime emits `session_start`.
- The authoritative success envelope for both `POST /api/v1/sdk/init` and `POST /api/v1/sdk/refresh` is `{ token, tenantId, projectId, deploymentId?, channelId, permissions, expiresIn }`, and the browser SDK rejects refresh responses that omit required scope or mutate the resolved scope unexpectedly.
- The browser SDK SessionManager now clears resolved Runtime project/channel scope on disconnect and auth-close instead of leaking stale session scope between connections.
- Explicit SDK `end_session` now overrides the default `web_chat` detach lifecycle, ends the Runtime session with `completed` disposition, and clears session-scoped auth state instead of leaving detached anonymous session artifacts behind.
- Studio preview pages now treat the session as connected only after Runtime emits `session_start`; raw WebSocket open is no longer treated as readiness.
- Studio preview/share/embed bootstrap now ignores a stale widget-configured SDK channel and falls back to the single remaining active SDK channel when the project is otherwise unambiguous.
- Studio embed generation now fails closed when the widget disables both chat and voice, instead of handing an unusable snippet to the browser.
- The browser SDK React/provider and widget surfaces now recreate SDK state for the bootstrap-shaping fields currently covered by tests instead of silently reusing stale sessions.
- Runtime WebSocket message timeouts now fail closed by sending `Request timed out`, closing the socket, propagating cooperative cancellation through the execution coordinator, LLM queue, and direct executor paths, and suppressing late response/persistence side effects after timeout; broader black-box, deployment, and multi-pod proof are still open.
- The legacy control-plane token route now returns `410 LEGACY_ROUTE_REMOVED`, and there is no current Studio proxy token route for it.
- Studio-to-Runtime SDK channel and LiveKit proxy routes now require an explicit Runtime URL and fail closed instead of silently targeting a fallback Runtime origin. The embed snippet route uses same-origin fallback only for browser-consumed snippet generation when Runtime is intentionally fronted through Studio.
- Runtime SDK channel control-plane APIs now have executed proof for HMAC identity-policy authoring and secret lifecycle behavior, including project-scoped and tenant-scoped create/read/update flows, secret rotation, disablement, and secret non-disclosure in API responses.
- The Studio browser E2E lane can now self-start an isolated Studio + Runtime + MongoMemory stack, and the widget, share-link preview, and authenticated project preview specs pass against that stack for live bootstrap, session readiness, local in-browser message-send visibility, and outbound SDK `chat_message` visibility. The share-link preview spec also proves preview mode-toggle continuity without reconnecting the SDK session, while the authenticated project preview spec currently proves readiness plus local send visibility only. The current browser specs do not yet assert assistant/model response completion.
- The same browser specs can also attach to existing Studio/Runtime services, but that mode requires a reachable Studio login page, a healthy Runtime, Studio dev-login enabled, and writable Studio SDK/project APIs. It creates real resources in the target environment and is not a persistent-state-isolation proof lane.
- The Studio WebSocket provider has been relocated from the app root (`page.tsx`) to the chat-tab level (`AppShell.tsx` wrapping `ChatWithDebugPanel`), so WS connections only exist during active chat sessions. `App.tsx` no longer depends on WebSocket state for its splash screen, and `CommandPalette` fetches apps via HTTP instead of WebSocket context. See [WS Relocation sub-feature](sub-features/ws-relocation.md).
- The SDK WebSocket handler preserves legacy application-level ping compatibility: older published SDK bundles that still send `{ type: 'ping' }` after `session_start` receive a raw `{ type: 'pong' }` response, but the JSON heartbeat timer was removed from the browser SDK `SessionManager`. Connection liveness is now owned entirely by the server-side protocol-level WebSocket heartbeat.
- The internal Studio `/ws` handler does not have application-level ping/pong (the initial WS relocation commit added it, but the hardening follow-up reverted it from `handler.ts` and `events.ts`). Studio client-side keepalive was also removed during hardening. The Runtime protocol-level heartbeat (`ws.ping()` control frames) remains the keepalive mechanism for internal Studio connections.
- Remaining gaps are now mostly black-box or operational hardening: public-API/browser anonymous auth-preflight/OAuth proof beyond the current integration coverage, broader user-scoped continuity/resume proof beyond initial verified bootstrap, browser voice E2E, ingress redaction verification, multi-pod/failover validation, and Studio-side application-level keepalive for L7 proxy idle timeout survival.

---

## 2. Scope

### Goals

- Provide one supported embeddable browser/client surface for chat, voice, and widget use cases.
- Enforce tenant, project, and channel auth for every SDK bootstrap and runtime request.
- Support optional verified end-user identity without requiring identity for all SDK traffic.
- Preserve anonymous OAuth and auth-preflight, but bind anonymous grants to the SDK session rather than a reusable user identity.
- Keep the architecture stateless and safe for multi-pod Runtime deployments.
- Align Runtime, Studio preview/share, docs, and tests around one session model.

### Non-Goals (Out of Scope)

- This feature does not replace the broader channel control plane that provisions `sdk_channels`.
- This feature does not make the SDK authorable directly in ABL DSL.
- This feature does not yet guarantee immediate invalidation of already-issued bearer tokens after bootstrap-key revocation.
- This feature does not claim full browser, voice, or deployment-ingress proof until those tests exist.

---

## 3. User Stories

1. As an application developer, I want a secure SDK and widget surface so I can embed an ABL agent without building my own bootstrap and transport stack.
2. As a tenant/platform owner, I want SDK access enforced at tenant, project, and channel scope so browser clients cannot drift outside the resources they were issued for.
3. As a tenant application, I want to optionally attach a signed end-user identity when I have one, without forcing identity on anonymous guest flows.
4. As a platform engineer, I want anonymous users to authenticate external tools safely, but only for the lifetime and scope of the current SDK session.
5. As a Studio operator, I want preview/share flows to behave like the real SDK contract instead of creating a parallel trust path.

---

## 4. Functional Requirements

**Status legend:** **Implemented** = code is in place and tested. **Partial** = code exists but does not yet cover the full requirement. **Gap** = the required behavior is not implemented or the current implementation violates it.

| ID    | Requirement                                                                                                                                           | Status (2026-04-14) |
| ----- | ----------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------- |
| FR-1  | Every SDK session must be authenticated at the tenant, project, and channel level.                                                                    | Implemented         |
| FR-2  | Verified end-user identity is optional, but unsigned `userContext` must not affect authorization, ownership, resume, or user-scoped auth.             | Partial             |
| FR-3  | Anonymous SDK callers must still support OAuth and auth-preflight, but anonymous grants must be limited to the session scope.                         | Partial             |
| FR-4  | The platform must expose exactly one Runtime-trusted `sdk_session` issuance path.                                                                     | Implemented         |
| FR-5  | `/ws/sdk` must require `Sec-WebSocket-Protocol: sdk-auth,<sdk_session_token>` and reject query-token fallback for supported SDK flows.                | Implemented         |
| FR-6  | SDK HTTP routes must require `X-SDK-Token` and enforce session, project, and attachment ownership boundaries.                                         | Implemented         |
| FR-7  | Share URLs must carry share artifacts in the URL fragment rather than query-string bearer material.                                                   | Implemented         |
| FR-8  | The browser SDK must fail closed when `endpoint` is missing instead of defaulting to a hosted SaaS origin.                                            | Implemented         |
| FR-9  | `await sdk.connect()` must mean “Runtime session is ready” and only resolve after `session_start`.                                                    | Implemented         |
| FR-10 | `userContext` must be validated at the request boundary with externalized size and shape limits.                                                      | Implemented         |
| FR-11 | Studio preview/share inputs must be validated at the request boundary and return deterministic `400` responses for malformed payloads.                | Implemented         |
| FR-12 | Preview/share flows must converge on the same Runtime issuance path as the packaged SDK, even if their initial artifact creation happens in Studio.   | Implemented         |
| FR-13 | The SDK must preserve tenant/project/user isolation semantics across chat, attachments, voice, and session browsing APIs.                             | Partial             |
| FR-14 | Tests and docs must distinguish between route/integration proof, runtime transport E2E, browser E2E, and deployment validation.                       | Implemented         |
| FR-15 | Control-plane APIs must expose and document a stable contract for SDK channel HMAC identity policy configuration and lifecycle.                       | Implemented         |
| FR-16 | Explicit SDK `end_session` must force a real session end and session-scoped auth cleanup even when the channel default disconnect behavior is detach. | Implemented         |
| FR-17 | Studio WebSocket connections must be scoped to the chat tab, not opened at app startup.                                                               | Implemented         |
| FR-18 | Legacy SDK bundles sending application-level `{ type: 'ping' }` must receive a `{ type: 'pong' }` response for backward compatibility.                | Implemented         |

---

## 5. Required Security Model

### Principals

| Principal                  | Source                                                    | Purpose                                                                                       | Authorization Effect                 |
| -------------------------- | --------------------------------------------------------- | --------------------------------------------------------------------------------------------- | ------------------------------------ |
| Channel auth principal     | Runtime-issued `sdk_session`                              | Binds the caller to `tenantId`, `projectId`, `channelId`, and least-privilege SDK permissions | Always required                      |
| Verified end-user identity | Tenant-signed identity or another verified auth mechanism | Enables user-scoped continuity and user-scoped tool auth                                      | Optional; only applies when verified |
| Session principal          | Runtime-generated unique session scope                    | Owns anonymous grants, attachment scope, and per-session auth artifacts                       | Always required                      |

### Scope Rules

| Caller Shape                | Allowed Scope                                                  | Disallowed Behavior                                                  |
| --------------------------- | -------------------------------------------------------------- | -------------------------------------------------------------------- |
| Anonymous SDK caller        | Session-scoped auth only                                       | Must not inherit or reuse another caller’s user-scoped auth          |
| Verified SDK caller         | Session-scoped auth plus user-scoped continuity/auth           | Verified identity must not be inferred from unsigned client metadata |
| Studio preview/share caller | Same Runtime-issued `sdk_session` contract as the packaged SDK | Must not create a separate trusted token issuer path in Studio       |

### Required Behaviors

- `tenantId`, `projectId`, `channelId`, and permissions are always authoritative in the Runtime-issued token.
- `userContext` is caller metadata. It may personalize behavior, but it must not become an auth key unless it is bound to verified identity.
- Anonymous OAuth and auth-preflight are valid product behaviors, but the resulting grants must be stored and checked against the session principal, not a channel-wide synthetic user.
- Preview/share flows may create preview/share artifacts in Studio, but the final Runtime-trusted `sdk_session` must come from Runtime.

---

## 6. Current Implementation vs Required Target

| Area                                 | Current Implementation                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                    | Required Target                                                                                                    | Status         |
| ------------------------------------ | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------ | -------------- |
| Browser bootstrap                    | `packages/web-sdk` bootstraps via `/api/v1/sdk/init` and refreshes via `/api/v1/sdk/refresh`                                                                                                                                                                                                                                                                                                                                                                                                                                                                                              | Keep this path and make it the canonical issuer path                                                               | Aligned        |
| WebSocket auth                       | `/ws/sdk` requires `sdk-auth,<token>` and rejects query-token fallback                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                    | Keep as the only supported SDK WS auth contract                                                                    | Aligned        |
| SDK HTTP auth                        | HTTP SDK routes use `X-SDK-Token` and session ownership checks                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                            | Keep and extend to future browser/voice flows                                                                      | Aligned        |
| Preview/share issuer                 | Studio issues preview/share bootstrap artifacts, then exchanges them through Runtime for the final token                                                                                                                                                                                                                                                                                                                                                                                                                                                                                  | Runtime remains the only trusted issuer of `sdk_session`                                                           | Aligned        |
| Preview/share channel binding        | Studio preview/share bootstrap now binds to a real active SDK channel; explicit `channelId` wins, otherwise Studio prefers a valid widget-configured default channel, otherwise auto-resolves a single active channel, and only returns `409` when multiple active channels still remain ambiguous                                                                                                                                                                                                                                                                                        | Preview/share should never mint channel-less or synthetic-channel Runtime sessions                                 | Aligned        |
| Preview/share stale-channel fallback | Studio preview/share/embed ignore a stale widget-configured SDK channel and fall back to the single remaining active SDK channel when the project is otherwise unambiguous                                                                                                                                                                                                                                                                                                                                                                                                                | Studio bootstrap should stay deterministic without binding to deleted channels                                     | Aligned        |
| Identity model                       | `sessionPrincipal`, `verifiedUserId`, and `authScope` are explicit; unsigned `userContext` is metadata                                                                                                                                                                                                                                                                                                                                                                                                                                                                                    | Only verified identity may affect user scope; unsigned `userContext` is metadata only                              | Mostly aligned |
| Anonymous auth scope                 | Anonymous SDK sessions now resolve to session-scoped principals in Runtime/shared-auth                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                    | Anonymous auth/preflight must be session-scoped                                                                    | Partial        |
| Browser OAuth callback URLs          | SDK/browser-facing JIT OAuth callbacks now require explicit `RUNTIME_PUBLIC_BASE_URL` and never fall back to localhost/internal Runtime addresses                                                                                                                                                                                                                                                                                                                                                                                                                                         | Browser-facing OAuth redirects must use an explicit public Runtime base                                            | Aligned        |
| OAuth callback state storage         | Runtime selects Redis-backed OAuth state outside tests and only permits in-memory state in test mode for ToolOAuthService and ChannelOAuthService, but readiness/failover proof is still incomplete                                                                                                                                                                                                                                                                                                                                                                                       | Multi-pod callback state must never rely on pod-local memory outside tests                                         | Mostly aligned |
| Studio control-plane authz           | Studio SDK routes and Runtime SDK channel proxy routes share one helper; generic tenant read/write permissions no longer bypass project membership                                                                                                                                                                                                                                                                                                                                                                                                                                        | Only project owner, allowed member, or true project-wide authority may manage SDK state                            | Aligned        |
| Studio Runtime exchange URLs         | Studio SDK channel proxy and LiveKit exchange routes require an explicit Runtime URL; embed snippets fall back to same-origin only for browser-consumed embed code                                                                                                                                                                                                                                                                                                                                                                                                                        | Server-side Runtime exchanges fail closed; browser snippets stay environment-safe                                  | Mostly aligned |
| Browser endpoint config              | Missing `endpoint` now throws instead of defaulting to a hosted SaaS URL                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                  | Missing `endpoint` must fail closed                                                                                | Aligned        |
| `connect()` semantics                | `connect()` resolves only after `session_start`, with a timeout if readiness never arrives                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                | `connect()` resolves after `session_start`                                                                         | Aligned        |
| Browser preview readiness            | Studio preview/share pages now set “connected” state on `session_start` instead of raw socket open                                                                                                                                                                                                                                                                                                                                                                                                                                                                                        | Browser surfaces should only expose session-ready UI after Runtime readiness                                       | Aligned        |
| Browser reconfiguration              | React/provider recreates SDK state on tested `userContext` / `channelId` / `channelName` changes; widget surfaces recreate on tested `endpoint` and channel-attribute changes and pass through `deployment-slug` / `user-context` bootstrap fields                                                                                                                                                                                                                                                                                                                                        | Clients should not keep stale Runtime sessions after bootstrap config changes                                      | Mostly aligned |
| Validation                           | Runtime/shared-auth enforce config-backed `userContext` limits, signed-identity envelope shape (`hmac`, Unix-seconds `timestamp`), and deterministic Studio request validation; the browser SDK mirrors those local limits without reimplementing Runtime freshness windows                                                                                                                                                                                                                                                                                                               | Request-boundary validation with consistent limits and deterministic `400`s                                        | Mostly aligned |
| Session route compatibility          | Persisted session browsing/close/delete routes now have route-module proof for fail-closed traces/export/generations authorization, RuntimeExecutor-only session-list fallback scoping for SDK callers and non-elevated user callers during DB unavailability, SDK ownership enforcement on explicit collection-route session filters, denial of runtime-memory fallback when persisted ownership cannot be proven, and cleanup via the stored `runtimeSessionId`; distinct `runtimeSessionId` lookup remains a legacy/compatibility path rather than the primary persisted-session model | SDK and Studio clients should be able to address persisted sessions consistently without orphaning Runtime cleanup | Mostly aligned |
| Testing posture                      | Runtime transport proof, focused timeout-cancellation hardening proof, Studio API proof, and isolated browser widget plus share-link preview E2E are now in place; browser specs currently prove bootstrap/readiness plus local send visibility, not assistant/model response completion                                                                                                                                                                                                                                                                                                  | Keep browser E2E green, then add voice E2E, ingress redaction, and multi-pod validation                            | Mostly aligned |
| Legacy share token path              | Legacy project-scoped token route now returns `410 LEGACY_ROUTE_REMOVED`; there is no current Studio proxy token route                                                                                                                                                                                                                                                                                                                                                                                                                                                                    | Keep the route removed and prevent new compatibility surfaces from reappearing                                     | Aligned        |

---

## 7. How to Consume

### Runtime APIs

| Method | Path                            | Purpose                                                                         |
| ------ | ------------------------------- | ------------------------------------------------------------------------------- |
| POST   | `/api/v1/sdk/init`              | Exchange public API key plus request context for a Runtime-issued `sdk_session` |
| POST   | `/api/v1/sdk/refresh`           | Refresh an existing Runtime-issued `sdk_session`                                |
| GET    | `/api/v1/sdk/config/:projectId` | Fetch public widget configuration                                               |
| WS     | `/ws/sdk`                       | Establish chat/voice WebSocket session using `sdk-auth,<token>`                 |
| POST   | `/api/livekit/token`            | Mint voice-session material for SDK flows with `session:voice` permission       |

Legacy control-plane endpoint note: `POST /api/projects/:projectId/sdk-channels/:channelId/token` now returns `410 LEGACY_ROUTE_REMOVED`, and there is no current Studio proxy route for that path. It is not part of the canonical Runtime-trusted `sdk_session` browser flow.

Runtime SDK session response contract note: both `/api/v1/sdk/init` and `/api/v1/sdk/refresh` currently return the authoritative envelope `{ token, tenantId, projectId, deploymentId?, channelId, permissions, expiresIn }`. The browser SDK treats that envelope as authoritative and rejects refresh responses that omit required scope fields or mutate the resolved scope.

### Studio APIs — Control-Plane (Studio-Authenticated)

These routes require a Studio user session and operate at the project management level. They do not issue Runtime-trusted session tokens.

All of the current SDK control-plane routes are expected to use the same project-scoped SDK access policy, implemented in `apps/studio/src/lib/sdk-project-access.ts`, so route behavior does not drift. That helper now allows only:

- the project owner
- an allowed project member
- true project-wide authority such as `project:*`

Generic tenant permissions such as `project:read`, `project:write`, or `channel:read` are intentionally not treated as a project-membership bypass for these SDK control-plane surfaces.

| Method | Path                                      | Purpose                                             |
| ------ | ----------------------------------------- | --------------------------------------------------- |
| GET    | `/api/sdk/embed/:projectId`               | Generate embed snippet                              |
| GET    | `/api/sdk/widget/:projectId`              | Read widget config                                  |
| PUT    | `/api/sdk/widget/:projectId`              | Update widget config                                |
| GET    | `/api/sdk/keys`                           | List public API keys                                |
| POST   | `/api/sdk/keys`                           | Create public API key                               |
| DELETE | `/api/sdk/keys/:keyId`                    | Revoke public API key                               |
| GET    | `/api/runtime/sdk-channels?projectId=...` | Proxy Runtime SDK channel list under Studio authz   |
| POST   | `/api/runtime/sdk-channels?projectId=...` | Proxy Runtime SDK channel create under Studio authz |
| GET    | `/api/runtime/sdk-channels/:channelId`    | Proxy Runtime SDK channel detail under Studio authz |
| PATCH  | `/api/runtime/sdk-channels/:channelId`    | Proxy Runtime SDK channel update under Studio authz |
| DELETE | `/api/runtime/sdk-channels/:channelId`    | Proxy Runtime SDK channel delete under Studio authz |

Studio-to-Runtime SDK control-plane proxy routes fail closed if `RUNTIME_URL` / `NEXT_PUBLIC_RUNTIME_URL` is not configured. They do not silently default to a localhost Runtime target.
The current proxy contract requires `projectId` only on list/create. Detail/update/delete resolve the tenant-scoped Runtime admin path under Studio tenant auth and normalize concealed `404` responses so missing channels and unauthorized project access stay indistinguishable.
Runtime’s project-scoped and tenant-scoped SDK channel APIs now provide a tested control-plane contract for `identityVerification.hmacEnforcement` and `secretKey`, including create/read/update, secret rotation, disablement, and secret non-disclosure in returned channel payloads.

### Studio APIs — Preview/Share Bootstrap

These routes create bootstrap artifacts for preview/share flows and converge on Runtime for final `sdk_session` issuance. Studio remains the control-plane authz gate for preview/share creation, but it no longer signs Runtime-trusted session tokens directly.

| Method | Path                      | Purpose                                                                   | Current Issuer | Target Issuer                                        |
| ------ | ------------------------- | ------------------------------------------------------------------------- | -------------- | ---------------------------------------------------- |
| POST   | `/api/sdk/share`          | Create a share artifact and fragment-based share URL for initial delivery | Studio         | Studio (artifact only; Runtime issues final session) |
| POST   | `/api/sdk/share/exchange` | Exchange a share artifact for a Runtime-issued SDK session                | Runtime        | Runtime                                              |
| POST   | `/api/sdk/preview-token`  | Bootstrap Studio preview through Runtime issuance                         | Runtime        | Runtime                                              |

Preview/share channel binding note: these bootstrap routes now require a real active SDK channel. If callers omit `channelId`, Studio first tries a valid widget-configured default channel. If there is no valid widget-bound default and exactly one active SDK channel exists, Studio auto-resolves it. If multiple active SDK channels still remain ambiguous, the route returns `409` and requires explicit `channelId`.
Preview/share browser note: the share URL is fragment-based on first load. After the `/preview` page consumes it, the page can keep the same share artifact in `sessionStorage` long enough to survive same-tab retry until exchange succeeds, and then clears it.

### Client Surfaces

- `packages/web-sdk` is the supported browser/client package for chat, voice, widgets, and React helpers.
- `apps/studio/src/app/preview/page.tsx` is the current browser preview surface for share-based widget validation, now marks the UI connected only after Runtime `session_start`, and clears any tab-scoped persisted share artifact after a successful exchange.
- `apps/studio/src/app/preview/[projectId]/page.tsx` is the authenticated project preview surface and also gates readiness on `session_start`; it accepts an optional `channelId` for explicit selection and otherwise follows the same widget-default then single-active-channel resolution contract as the preview/share APIs.
- `apps/studio/src/app/preview-livekit/page.tsx` is the current browser voice preview surface; it uses SDK bootstrap plus Runtime LiveKit token issuance rather than opening `/ws/sdk` for media itself.

---

## 8. Data Model and Token Boundaries

### Persisted Resources

| Resource          | Purpose                                    | Key Fields                                                                                                   |
| ----------------- | ------------------------------------------ | ------------------------------------------------------------------------------------------------------------ |
| `sdk_channels`    | Channel/deployment binding for SDK traffic | `tenantId`, `projectId`, `deploymentId`, `channelType`, `publicApiKeyId`                                     |
| `public_api_keys` | Project-scoped bootstrap credentials       | `projectId`, `keyPrefix`, `keyHash`, `allowedOrigins`, `permissions`, `isActive`, `expiresAt`                |
| `widget_configs`  | Widget behavior and presentation           | `projectId`, `mode`, `position`, `theme`, `welcomeMessage`, `placeholderText`, `voiceEnabled`, `chatEnabled` |

### Ephemeral Tokens and Artifacts

| Artifact                 | Purpose                                                        | Current State                                                                                                                                    |
| ------------------------ | -------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------ |
| `sdk_session`            | Runtime-trusted bearer token for SDK WebSocket and HTTP access | Runtime issues it for packaged SDK and for Studio preview/share exchange                                                                         |
| Share token              | Preview/share bootstrap artifact                               | Fragment-based URL artifact on initial delivery; the `/preview` surface may persist it only until successful exchange clears the tab-scoped copy |
| Preview bootstrap token  | Short-lived preview bootstrap artifact                         | Studio-signed bootstrap artifact exchanged through Runtime                                                                                       |
| Legacy `sdk_share` route | Historical control-plane token path                            | Removed; current route returns `410 LEGACY_ROUTE_REMOVED`                                                                                        |

### Required Token Semantics

- `sdk_session` must always carry tenant, project, channel, and least-privilege permission scope.
- `sdk_session` must always bind to a unique Runtime session principal so anonymous ownership and auth artifacts remain isolated.
- Verified end-user identity must be represented separately from `userContext` metadata.
- Preview/share artifacts are bootstrap artifacts, not parallel long-lived auth systems.

---

## 9. Key Implementation Files

Detailed implementation inventory and rollout notes live in [docs/specs/sdk-auth-session-unification.hld.md](../specs/sdk-auth-session-unification.hld.md) and [docs/specs/sdk-auth-session-unification.lld.md](../specs/sdk-auth-session-unification.lld.md). The key files are summarized here.

### Runtime

| File                                                                  | Purpose                                                                                               |
| --------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------- |
| `apps/runtime/src/routes/sdk-init.ts`                                 | Runtime bootstrap and refresh issuance path                                                           |
| `apps/runtime/src/routes/sdk.ts`                                      | Public widget config endpoint                                                                         |
| `apps/runtime/src/middleware/sdk-auth.ts`                             | Public API key validation and bootstrap permission mapping                                            |
| `apps/runtime/src/middleware/auth.ts`                                 | Parses and authenticates `X-SDK-Token` on HTTP routes                                                 |
| `apps/runtime/src/middleware/session-access.ts`                       | Project-scoped session authorization helper for SDK-adjacent session routes                           |
| `apps/runtime/src/websocket/sdk-handler.ts`                           | SDK WebSocket auth, session lifecycle, and message execution                                          |
| `apps/runtime/src/routes/chat.ts`                                     | SDK chat access, auth-preflight, and session-scoped HTTP behavior                                     |
| `apps/runtime/src/routes/sessions.ts`                                 | Project-scoped session browsing, trace/export/generation authorization, and explicit cleanup behavior |
| `apps/runtime/src/repos/session-repo.ts`                              | Stored-session lookup helpers, including the legacy/compatibility `runtimeSessionId` path             |
| `apps/runtime/src/services/identity/stored-session-caller-context.ts` | Rebuilds persisted caller ownership context for shared auth evaluation                                |
| `apps/runtime/src/routes/livekit.ts`                                  | Voice-session token issuance under SDK scope                                                          |
| `apps/runtime/src/services/identity/sdk-session-token.ts`             | `userContext` validation, legacy normalization, and session-principal issuance                        |
| `apps/runtime/src/services/identity/sdk-secret-config.ts`             | Split signer resolution for Runtime `sdk_session` and Studio bootstrap artifacts                      |
| `apps/runtime/src/services/identity/artifact-hasher.ts`               | Caller/session identity derivation used by session ownership                                          |
| `apps/runtime/src/services/auth-profile/auth-preflight.ts`            | Auth-preflight grant behavior keyed to effective session/user principal                               |
| `apps/runtime/vitest.sdk-auth.config.ts`                              | Dedicated serial Runtime proof lane for SDK auth/session coverage                                     |

### Studio

| File                                                                | Purpose                                                                                                                                                                                                                                                                                              |
| ------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `apps/studio/src/lib/studio-sdk-session.ts`                         | Studio bootstrap permission/TTL helpers                                                                                                                                                                                                                                                              |
| `apps/studio/src/lib/sdk-bootstrap-channel.ts`                      | Resolves the active SDK channel for preview/share/embed bootstrap, preferring a valid widget-configured default channel and falling back from stale widget channels when one active channel remains                                                                                                  |
| `apps/studio/src/lib/runtime-sdk-session.ts`                        | Runtime exchange helper for preview/share bootstrap artifacts                                                                                                                                                                                                                                        |
| `apps/studio/src/lib/sdk-runtime-channel-proxy.ts`                  | Shared Studio authz + Runtime URL resolution for SDK channel proxy routes; list/create stay project-scoped, while detail/update/delete use tenant-scoped Runtime admin forwarding                                                                                                                    |
| `apps/studio/src/lib/sdk-share-token.ts`                            | Share bootstrap artifact signing and verification                                                                                                                                                                                                                                                    |
| `apps/studio/src/app/api/sdk/preview-token/route.ts`                | Preview bootstrap API that exchanges through Runtime                                                                                                                                                                                                                                                 |
| `apps/studio/src/app/api/sdk/share/route.ts`                        | Share artifact creation                                                                                                                                                                                                                                                                              |
| `apps/studio/src/app/api/sdk/share/exchange/route.ts`               | Share artifact exchange through Runtime                                                                                                                                                                                                                                                              |
| `apps/studio/src/app/api/runtime/sdk-channels/route.ts`             | Studio-authenticated Runtime SDK channel proxy list/create route (`projectId` query param required today)                                                                                                                                                                                            |
| `apps/studio/src/app/api/runtime/sdk-channels/[channelId]/route.ts` | Studio-authenticated Runtime SDK channel proxy detail/update/delete route via the tenant-scoped Runtime admin path with concealed `404` normalization                                                                                                                                                |
| `apps/studio/src/app/api/sdk/keys/route.ts`                         | SDK public-key list/create control-plane route                                                                                                                                                                                                                                                       |
| `apps/studio/src/app/api/sdk/keys/[keyId]/route.ts`                 | SDK public-key revoke control-plane route                                                                                                                                                                                                                                                            |
| `apps/studio/src/app/api/sdk/embed/[projectId]/route.ts`            | Embed snippet generation under shared SDK project access                                                                                                                                                                                                                                             |
| `apps/studio/src/app/preview/page.tsx`                              | Browser preview page that scrubs the initial share-link fragment and clears any tab-scoped persisted share artifact after successful exchange                                                                                                                                                        |
| `apps/studio/src/app/preview/[projectId]/page.tsx`                  | Authenticated browser project preview page                                                                                                                                                                                                                                                           |
| `apps/studio/src/app/preview-livekit/page.tsx`                      | Browser voice preview page                                                                                                                                                                                                                                                                           |
| `apps/studio/src/__tests__/sdk-preview-share-api.e2e.test.ts`       | HTTP integration proof for preview/share authz, same-tenant non-member denial, fragment-first share delivery, widget-configured default channel selection, stale-channel fallback, fail-closed embed generation, and Studio Runtime SDK channel proxy denial across list/create/detail/update/delete |
| `apps/studio/e2e/sdk-preview-share.spec.ts`                         | Real browser preview/share E2E via the isolated self-started stack                                                                                                                                                                                                                                   |
| `apps/studio/e2e/sdk-widget.spec.ts`                                | Real browser widget E2E via the isolated self-started stack                                                                                                                                                                                                                                          |
| `apps/studio/e2e/helpers/sdk-browser-e2e.ts`                        | Shared browser E2E bootstrap and prerequisite checks                                                                                                                                                                                                                                                 |
| `apps/studio/e2e/helpers/sdk-browser-stack.ts`                      | Self-started isolated Studio + Runtime + MongoMemory browser stack                                                                                                                                                                                                                                   |
| `apps/studio/src/contexts/WebSocketContext.tsx`                     | WebSocket provider relocated to chat-tab-level; exports `useOptionalWebSocketContext` for components that may render outside the provider tree                                                                                                                                                       |
| `apps/studio/src/components/navigation/AppShell.tsx`                | Wraps `ChatWithDebugPanel` with `WebSocketProvider` (WS relocation target)                                                                                                                                                                                                                           |
| `apps/studio/src/hooks/useAvailableApps.ts`                         | HTTP-based app fetching hook that replaced WS-dependent app loading in CommandPalette                                                                                                                                                                                                                |
| `apps/studio/src/lib/app-graph-loader.ts`                           | Standalone app graph loading utility extracted during WS relocation                                                                                                                                                                                                                                  |
| `apps/studio/src/__tests__/components/command-palette.test.tsx`     | CommandPalette test verifying HTTP-based app fetching without WebSocket dependency                                                                                                                                                                                                                   |

### Browser SDK

| File                                                                | Purpose                                                                                            |
| ------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------- |
| `packages/web-sdk/src/core/AgentSDK.ts`                             | Main SDK entry point                                                                               |
| `packages/web-sdk/src/core/SessionManager.ts`                       | WebSocket connection, readiness gating, and reconnect                                              |
| `packages/web-sdk/src/core/TokenManager.ts`                         | `sdk_session` bootstrap and refresh                                                                |
| `packages/web-sdk/src/core/endpoint.ts`                             | Endpoint normalization with fail-closed validation                                                 |
| `packages/web-sdk/src/core/types.ts`                                | Public config and `userContext` type surface                                                       |
| `packages/web-sdk/src/core/websocket-auth.ts`                       | `sdk-auth,<token>` subprotocol builder                                                             |
| `packages/web-sdk/src/chat/ChatClient.ts`                           | Chat send/upload APIs                                                                              |
| `packages/web-sdk/src/voice/browser-support.ts`                     | Shared pipeline-voice browser capability detection                                                 |
| `packages/web-sdk/src/voice/VoiceClient.ts`                         | Voice/session APIs                                                                                 |
| `packages/web-sdk/src/react/AgentProvider.tsx`                      | React lifecycle and auto-connect wrapper                                                           |
| `packages/web-sdk/src/ui/ChatWidget.ts`                             | Chat widget bootstrap/re-bootstrap lifecycle                                                       |
| `packages/web-sdk/src/ui/UnifiedWidget.ts`                          | Unified widget bootstrap/re-bootstrap lifecycle                                                    |
| `packages/web-sdk/src/ui/VoiceWidget.ts`                            | Voice widget bootstrap/re-bootstrap lifecycle                                                      |
| `packages/web-sdk/src/__tests__/endpoint-config.test.ts`            | Package proof for fail-closed endpoint semantics                                                   |
| `packages/web-sdk/src/__tests__/session-manager-connect.test.ts`    | Package proof for `connect()` readiness contract                                                   |
| `packages/web-sdk/src/__tests__/token-manager-contract.test.ts`     | Package proof for init/refresh scope validation                                                    |
| `packages/web-sdk/src/__tests__/agent-provider-config.test.ts`      | Package proof for React/provider config re-bootstrap                                               |
| `packages/web-sdk/src/__tests__/widget-bootstrap-retry.test.ts`     | Package proof for widget re-bootstrap behavior                                                     |
| `packages/web-sdk/src/__tests__/token-manager-user-context.test.ts` | Package proof for browser-side validation parity, HMAC envelope shape, and Unix-seconds timestamps |

### Shared Auth / Config

| File                                                       | Purpose                                                                                                          |
| ---------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------- |
| `packages/shared-auth/src/middleware/session-ownership.ts` | Session ownership resolution and enforcement, including elevated-user pass-through for runtime-only `:id` routes |
| `packages/shared-auth/src/middleware/unified-auth.ts`      | Common auth context shaping across auth types                                                                    |
| `packages/shared/src/sdk-bootstrap-artifact.ts`            | Shared preview/share bootstrap artifact signing utilities                                                        |
| `packages/shared/src/sdk-widget-capabilities.ts`           | Shared browser/widget capability normalization helpers                                                           |
| `packages/config/src/constants.ts`                         | Authoritative Runtime/shared-auth SDK limits/constants                                                           |
| `packages/web-sdk/src/core/sdk-user-context-validation.ts` | Browser SDK local mirror of Runtime limits with parity tests                                                     |
| `packages/openapi/src/nextjs/validate-body.ts`             | Shared Next.js request-body validation helper                                                                    |
| `packages/openapi/src/nextjs/with-openapi.ts`              | Metadata wrapper; intentionally separate from validation                                                         |

### Current High-Value Tests

| File                                                                             | Current Proof Level   | Focus                                                                                                                                                                                                                                                                  |
| -------------------------------------------------------------------------------- | --------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `apps/runtime/src/__tests__/sdk-bootstrap-auth.integration.test.ts`              | HTTP integration      | `sdk/init`, `sdk/refresh`, origin allowlists, validation, refresh, least privilege                                                                                                                                                                                     |
| `apps/runtime/src/__tests__/channels-sdk-runtime.e2e.test.ts`                    | Runtime transport E2E | Packaged SDK bootstrap, `/ws/sdk`, attachment scope, project/session isolation                                                                                                                                                                                         |
| `apps/runtime/src/__tests__/ws-sdk-handler.test.ts`                              | Handler integration   | Low-level WebSocket auth, identity propagation, explicit `end_session` cleanup override, and session lifecycle                                                                                                                                                         |
| `apps/runtime/src/__tests__/ws-message-timeout.test.ts`                          | Unit                  | In-process `/ws/sdk` timeout-handler fail-closed behavior, timeout-triggered cancellation signal propagation, and suppression of late response/persistence side effects                                                                                                |
| `apps/runtime/src/__tests__/execution-coordinator.test.ts`                       | Unit                  | Execution coordinator cancellation bridging from caller abort signals into active coordinated runs                                                                                                                                                                     |
| `apps/runtime/src/__tests__/llm-queue-distributed.test.ts`                       | Unit                  | In-process local-fallback queue/direct-executor cancellation behavior, including fail-closed abort handling before direct LLM execution starts; the Redis-disabled suite does not separately execute the BullMQ worker path                                            |
| `apps/runtime/src/__tests__/session-routes.test.ts`                              | Integration           | Route-module proof for fail-closed traces/export/generation authorization, scoped session-list fallback, cleanup via stored `runtimeSessionId`, and the legacy `runtimeSessionId` compatibility lane                                                                   |
| `apps/runtime/src/__tests__/middleware/session-access.test.ts`                   | Integration           | Project-scoped session authorization helper proof, including concealment semantics and denial of session-scoped SDK callers against legacy channel-artifact-only sessions                                                                                              |
| `apps/runtime/src/__tests__/sdk-session-token.test.ts`                           | Unit                  | Legacy normalization and metadata-only `userContext` semantics                                                                                                                                                                                                         |
| `apps/runtime/src/__tests__/contexts/orchestration/chat-identity-wiring.test.ts` | Unit                  | Verified identity vs session principal caller wiring                                                                                                                                                                                                                   |
| `packages/shared-auth/src/__tests__/session-ownership.test.ts`                   | Unit                  | Session-principal ownership matching, denial of session-scope fallback to legacy channel-artifact rows, impossible-filter behavior for SDK callers without a stable identity, and elevated-user pass-through for runtime-only `:id` routes                             |
| `apps/studio/src/__tests__/sdk-preview-share-api.e2e.test.ts`                    | API integration       | Preview/share authz, validation, Runtime exchange, least privilege, widget-configured default channel selection, stale-channel fallback, and Studio Runtime SDK channel proxy denial for outsiders and same-tenant non-members across list/create/detail/update/delete |
| `packages/shared/src/__tests__/sdk-widget-capabilities.test.ts`                  | Unit                  | Shared voice/chat capability normalization used by widget and preview surfaces                                                                                                                                                                                         |
| `packages/web-sdk/src/__tests__/endpoint-config.test.ts`                         | Unit                  | Fail-closed endpoint semantics                                                                                                                                                                                                                                         |
| `packages/web-sdk/src/__tests__/session-manager-connect.test.ts`                 | Unit                  | `connect()` readiness semantics, plus regression guard that no heartbeat frames are sent after `session_start` (post-heartbeat-removal)                                                                                                                                |
| `packages/web-sdk/src/__tests__/token-manager-contract.test.ts`                  | Unit                  | Init/refresh response contract and scope validation                                                                                                                                                                                                                    |
| `packages/web-sdk/src/__tests__/default-transport.test.ts`                       | Unit                  | DefaultTransport message translation; confirms internal messages like `pong` are dropped, not surfaced to consumers                                                                                                                                                    |
| `apps/runtime/src/__tests__/channels/websocket-events.test.ts`                   | Unit                  | `parseClientMessage` and `ServerMessages` factory coverage; confirms `ping` is rejected as an invalid/internal message type at the parse layer                                                                                                                         |
| `apps/runtime/src/__tests__/channels/ws-sdk-handler.test.ts`                     | Handler integration   | SDK WS handler including legacy ping compatibility shim (`sendLegacyPong`), auth, identity propagation, `end_session` cleanup                                                                                                                                          |
| `apps/studio/src/__tests__/components/command-palette.test.tsx`                  | Unit                  | CommandPalette renders and fetches apps via HTTP hook without WebSocket dependency                                                                                                                                                                                     |
| `apps/studio/src/__tests__/hooks/project-agent-session-launcher.test.ts`         | Unit                  | Project agent session launcher hook behavior post-WS relocation                                                                                                                                                                                                        |

---

## 10. Non-Functional Concerns

### Isolation and Role-Based Security

| Concern                | Required Behavior                                                                                                       |
| ---------------------- | ----------------------------------------------------------------------------------------------------------------------- |
| Tenant isolation       | Every Runtime lookup stays tenant-scoped; cross-tenant access returns `404` where appropriate                           |
| Project isolation      | Every SDK bootstrap and route access stays bound to the project in the issued token                                     |
| User/session isolation | Anonymous ownership is session-scoped; verified user scope is only enabled for verified identities                      |
| Least privilege        | Public key permissions, preview/share permissions, and voice/chat permissions all narrow rather than expand             |
| Role-based security    | Studio control-plane actions remain user-authenticated and project-scoped; Runtime data-plane access stays token-scoped |

### Defense in Depth

- Public bootstrap keys remain hashed at rest, revocable, and origin-constrained.
- Runtime transport stays off query strings and uses `Sec-WebSocket-Protocol` plus `X-SDK-Token`.
- Share URLs keep bearer material out of the initial request URL by using fragments, and any tab-scoped share artifact persistence is cleared after successful exchange.
- Validation must happen at every request boundary, not only in docs/OpenAPI metadata.
- The Runtime must remain the sole trust boundary for issuing Runtime-trusted session tokens.
- Runtime now enforces split secrets: Runtime-only `AUTH_SDK_SESSION_SIGNING_SECRET` for `sdk_session`, and `AUTH_SDK_BOOTSTRAP_SIGNING_SECRET` for Studio bootstrap artifacts exchanged through Runtime.

### Performance, Scale, and Statelessness

- `sdk_session` validation and session ownership must remain safe under multi-pod Runtime deployments.
- Session-scoped auth artifacts must live in shared infrastructure rather than pod-local memory.
- Validation limits on `userContext` protect proxies, ingress, logs, and WebSocket handshake size.
- `connect()` readiness semantics should reduce client-side race handling instead of pushing more retry complexity to integrators.

### Observability and Data Lifecycle

- SDK sessions should continue emitting the same trace and persisted message events as other Runtime sessions.
- Sensitive transport material such as `Sec-WebSocket-Protocol` and `X-SDK-Token` must be redacted in deployed ingress and telemetry layers before this feature can claim full operational proof.
- `sdk_session`, preview, and share artifacts remain short-lived tokens rather than standalone persisted documents.

---

## 11. Delivery Priorities

0. **[Completed on this branch]** Cross-tenant share exchange isolation and tenant-scoped share lookup are now fixed in the live Studio preview/share routes.
1. Add anonymous auth-preflight/OAuth session scoping proof and broader verified-identity continuity/resume proof through public APIs.
2. Adopt `test:e2e:sdk-browser:isolated` as the canonical CI browser lane and keep widget/preview-share flows green.
3. Add browser voice/LiveKit E2E plus deployment-level ingress/log redaction verification.
4. Add shared-state multi-pod/failover proof before claiming full operational readiness.
5. Evaluate whether bounded bearer replay, immediate revocation, and bootstrap retry/backoff should become beta-exit requirements.

---

## 12. Testing & Validation Summary

| Area                            | Current Proof                                                                                                                                                                                                                                                                                   | Remaining Gap                                                                                           |
| ------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------- |
| Runtime bootstrap and transport | Strong integration/runtime E2E proof, including public-key/HMAC verified bootstrap and expired refresh/session-list rejection                                                                                                                                                                   | Anonymous auth-preflight and broader user-scoped continuity/resume proof remain open                    |
| Studio preview/share APIs       | Route-harness integration proof for authz, validation, Runtime exchange, least privilege, and Studio Runtime SDK channel proxy denial across the full list/create/detail/update/delete proxy surface, plus isolated real-browser proof for share-link preview and authenticated project preview | Preview-token route remains API-level proof, which is appropriate for the current contract              |
| Browser SDK package             | Package-level contract tests, Node-based runtime transport proof, focused timeout-cancellation proof, isolated real-browser widget proof for bootstrap/readiness and local send visibility, heartbeat removal regression guard, and legacy ping compat in SDK handler                           | Browser voice proof, assistant-response browser proof, and CI adoption of the isolated lane remain open |
| Voice                           | Permission-boundary coverage exists                                                                                                                                                                                                                                                             | No full browser-to-Runtime voice proof                                                                  |
| Studio WS relocation            | WS provider relocated to chat-tab, App.tsx/CommandPalette decoupled, unit tests for CommandPalette HTTP fetching and session launcher                                                                                                                                                           | No E2E or integration tests for WS relocation scenarios yet (all planned tests remain unwritten)        |
| Docs                            | Feature/testing/HLD/LLD docs distinguish target state vs proof level                                                                                                                                                                                                                            | Must stay synchronized with each new executed suite                                                     |

> Detailed scenario-by-scenario status lives in [docs/testing/sdk.md](../testing/sdk.md).

---

## 13. Audit Findings and Current Status

The 2026-03-20 review surfaced the highest-risk SDK issues. The current branch closes most of the architectural findings and leaves a smaller residual set.

### Resolved on This Branch

| ID  | Finding                                                                                                         | Status |
| --- | --------------------------------------------------------------------------------------------------------------- | ------ |
| C3  | Share exchange used a tenant-less project lookup path                                                           | Fixed  |
| C4  | Share creation used `ownerId` instead of `tenantId` for project lookup                                          | Fixed  |
| H7  | Preview/share request validation was incomplete                                                                 | Fixed  |
| M8  | Share token generation lacked route-level rate limiting                                                         | Fixed  |
| M10 | Studio directly signed Runtime-trusted preview/share `sdk_session` tokens instead of exchanging through Runtime | Fixed  |
| M11 | Browser SDK failed open on missing `endpoint` and `connect()` resolved before Runtime session readiness         | Fixed  |

### Residual Risks

| ID  | Finding                                                                                                                                                                                           | Severity | Status | Tracking                                       |
| --- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | -------- | ------ | ---------------------------------------------- |
| R1  | Verified identity bootstrap is now proven for token issuance, but broader user-scoped continuity/resume/auth behavior still lacks dedicated black-box proof                                       | Medium   | Open   | Delivery priority 1 and docs/testing scenarios |
| R2  | Anonymous auth-preflight/OAuth session scoping is implemented in principal resolution paths but lacks black-box public-API proof                                                                  | Medium   | Open   | Delivery priority 1 and docs/testing scenarios |
| R3  | Browser widget, share-link preview, and authenticated project preview flows now pass via the isolated Playwright stack, but required CI adoption of that lane is still operational follow-through | Low      | Open   | Delivery priority 2                            |
| R4  | Browser voice, ingress/log redaction, and multi-pod/failover claims remain unproven                                                                                                               | Medium   | Open   | Delivery priorities 3 and 4                    |
| R5  | `TokenManager` still has no retry/backoff policy for transient bootstrap failure; decide whether this is a beta-exit requirement                                                                  | Low      | Open   | Delivery priority 5                            |

---

## 14. References

- Testing guide: [docs/testing/sdk.md](../testing/sdk.md)
- Threat model: [docs/security/abl-platform-threat-model.md](../security/abl-platform-threat-model.md)
- HLD: [docs/specs/sdk-auth-session-unification.hld.md](../specs/sdk-auth-session-unification.hld.md)
- LLD: [docs/specs/sdk-auth-session-unification.lld.md](../specs/sdk-auth-session-unification.lld.md)
- Cross-channel auth consolidation plan: [docs/plans/2026-03-19-cross-channel-auth-threat-model-consolidation-plan.md](../plans/2026-03-19-cross-channel-auth-threat-model-consolidation-plan.md)
- Related features: [Channels](channels.md), [SDK Channel Creation](sub-features/sdk-channel-creation.md), [Deployments & Versioning](deployments-versioning.md), [Voice Capabilities](voice-capabilities.md), [Proactive Messaging](proactive-messaging.md)
- Sub-features: [WS Relocation](sub-features/ws-relocation.md), [SDK Rich Content Templates](sub-features/sdk-rich-content-templates.md), [SDK Chat UI Consolidation](sub-features/sdk-chat-ui-consolidation.md)
- WS Relocation HLD: [docs/specs/ws-relocation.hld.md](../specs/ws-relocation.hld.md)
- WS Relocation LLD: [docs/plans/2026-04-13-ws-relocation-impl-plan.md](../plans/2026-04-13-ws-relocation-impl-plan.md)
- Historical context: [docs/plans/2026-03-14-web-sdk-jwt-jwe-auth.md](../plans/2026-03-14-web-sdk-jwt-jwe-auth.md)

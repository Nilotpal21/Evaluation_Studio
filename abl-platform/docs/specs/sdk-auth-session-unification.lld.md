# SDK Auth and Session Unification — Low-Level Design

**Status**: Active implementation baseline
**Date**: 2026-03-22
**Owner**: Platform team
**Related Feature Doc**: [docs/features/sdk.md](../features/sdk.md)
**Related Testing Guide**: [docs/testing/sdk.md](../testing/sdk.md)
**Related HLD Spec**: [docs/specs/sdk-auth-session-unification.hld.md](./sdk-auth-session-unification.hld.md)

## 1. Scope

This LLD captures the concrete SDK/browser/Studio/Runtime implementation for the current branch. It is the file-level companion to the HLD and should answer:

- which files implement each part of the unified session model
- the exact request, token, and readiness contracts
- what is already implemented versus what is still a proof or hardening gap

This LLD is intentionally implementation-first. It does not repeat the full problem statement from the HLD.

## 2. Non-Negotiable Invariants

1. Runtime is the only trusted issuer of `sdk_session`.
2. `sdk_session` is the authorization source for tenant, project, channel, permissions, and session scope.
3. Unsigned `userContext` is metadata only.
4. Verified identity is explicit and separate from session principal.
5. Anonymous auth artifacts must bind to session scope, not a synthetic channel-wide user.
6. Preview/share artifacts are bootstrap inputs only, not parallel Runtime session tokens.
7. Supported browser SDK transport does not use query-string bearer credentials.

## 3. Contracts

### 3.1 Runtime bootstrap

`POST /api/v1/sdk/init`

- Public-key bootstrap:
  - header: `X-Public-Key: pk_*`
  - body: optional `deploymentSlug`, `channelId`, `channelName`, `userContext`
- Studio bootstrap:
  - body: `bootstrapToken`
  - `bootstrapToken` is mutually exclusive with `X-Public-Key`
  - `bootstrapToken` cannot be combined with `deploymentSlug`, `channelId`, or `channelName`

Response:

```json
{
  "token": "<sdk_session>",
  "tenantId": "<tenantId>",
  "projectId": "<projectId>",
  "deploymentId": "<deploymentId?>",
  "channelId": "<channelId>",
  "permissions": ["session:send_message"],
  "expiresIn": 14400
}
```

### 3.2 Refresh

`POST /api/v1/sdk/refresh`

- header: `X-SDK-Token`
- returns a new `sdk_session` with the same claims and a renewed TTL
- expired tokens return `401`
- preview/share refresh also re-checks bootstrap expiry and current widget permissions
- authoritative success envelope:

```json
{
  "token": "<sdk_session>",
  "tenantId": "<tenantId>",
  "projectId": "<projectId>",
  "deploymentId": "<deploymentId?>",
  "channelId": "<channelId>",
  "permissions": ["session:send_message"],
  "expiresIn": 14400
}
```

### 3.3 WebSocket

`WS /ws/sdk`

- required auth transport: `Sec-WebSocket-Protocol: sdk-auth,<sdk_session>`
- query-string `?token=` is rejected for supported SDK flows
- `connect()` is complete only after Runtime emits `session_start`
- current timeout path is transport fail-closed: Runtime sends `Request timed out`, closes the socket, propagates cooperative cancellation through the execution coordinator, LLM queue, and direct executor paths, and suppresses late response/persistence side effects after timeout; broader browser/public-surface, deployment, and multi-pod proof remains open

### 3.4 HTTP SDK routes

- required auth header: `X-SDK-Token`
- session/project/attachment ownership is resolved from:
  - verified user identity when `authScope=user`
  - `sessionPrincipal` when `authScope=session`

### 3.4a Persisted session route compatibility

- Runtime session browsing/close/delete routes use the unified session `_id` as the primary persisted identifier; the separate `runtimeSessionId` lookup remains a legacy/compatibility path for records that still carry both identifiers
- explicit close/delete cleanup uses the stored `runtimeSessionId` for executor and trace cleanup instead of the caller-supplied alias
- trace/export/generation routes now fail closed when project-scoped authorization or session ownership cannot be verified before querying ClickHouse
- RuntimeExecutor-only session-list fallback applies the same ownership evaluation for SDK callers and non-elevated user callers when DB-backed listing is unavailable
- SDK callers and non-elevated user callers using explicit trace/export/generation lookups do not fall back to active in-memory runtime sessions when no persisted ownership proof exists
- explicit SDK `end_session` overrides the default `web_chat` detach lifecycle so Runtime ends the session and clears session-scoped auth state
- elevated user `:id` routes bypass the persisted-session ownership lookup so project-authorized admins can still inspect active runtime-only sessions

### 3.5 Studio preview/share bootstrap

`POST /api/sdk/preview-token`

- authenticated Studio user
- validates project access
- resolves a real active SDK channel for the project
  - prefers a valid widget-configured default channel when present
  - otherwise auto-resolves when exactly one active SDK channel exists
  - returns `409` and requires explicit `channelId` only when multiple active SDK channels remain ambiguous
- signs preview bootstrap artifact
- exchanges bootstrap artifact with Runtime
- returns Runtime-issued `sdkToken`

`POST /api/sdk/share`

- authenticated Studio user
- validates project access
- resolves a real active SDK channel for the project
- uses the requested `channelId` when provided
- otherwise prefers a valid widget-configured default channel when present
- otherwise auto-resolves when exactly one active SDK channel exists
- returns `422` when no active SDK channel exists
- returns `409` only when multiple active SDK channels still remain ambiguous after widget-default resolution and `channelId` is omitted
- returns fragment-based share URL and bootstrap artifact for initial delivery
- the `/preview` page currently scrubs the fragment after first load and may retain the same share artifact in `sessionStorage` only until a successful exchange clears it

`POST /api/sdk/share/exchange`

- unauthenticated share-link consumer
- validates share artifact
- optionally narrows permissions
- always forwards the signed `channelId` to Runtime
- exchanges bootstrap artifact with Runtime

### 3.6 Studio Runtime SDK channel proxy

- `GET /api/runtime/sdk-channels?projectId=<projectId>`
- `POST /api/runtime/sdk-channels?projectId=<projectId>`
- `GET /api/runtime/sdk-channels/:channelId`
- `PATCH /api/runtime/sdk-channels/:channelId`
- `DELETE /api/runtime/sdk-channels/:channelId`

Current state:

- list/create require `projectId` in the query string because they stay project-scoped
- detail/update/delete forward to the tenant-scoped Runtime admin path under Studio tenant auth and normalize concealed `404` responses
- authenticated outsiders and same-tenant non-members are expected to receive the same concealed `404` shape as a missing project

### 3.7 Legacy control-plane token route (removed)

`POST /api/projects/:projectId/sdk-channels/:channelId/token`

- now returns `410 LEGACY_ROUTE_REMOVED`
- there is no current Studio proxy token route for this path
- it is not part of the supported browser SDK session model
- removal is explicitly covered by `apps/runtime/src/__tests__/sdk-channels-authz.test.ts`

## 4. Token Model

`sdk_session` claims implemented on this branch:

- `tenantId`
- `projectId`
- `channelId`
- `deploymentId?`
- `permissions[]`
- `sessionId`
- `sessionPrincipal`
- `verifiedUserId?`
- `identityTier`
- `verificationMethod`
- `authScope`
- `channelArtifact?`
- `bootstrapType`
- `bootstrapKeyId?`
- `bootstrapExpiresAt?`
- `userContext?`

Semantics:

- `sessionPrincipal` is always present after normalization.
- `verifiedUserId` is the only end-user identity that can unlock user-scoped behavior.
- `authScope` is `session` for anonymous callers and `user` only for verified identity.
- legacy tokens are normalized through `normalizeLegacySdkSessionPayload()`.

## 5. Validation Limits

Implemented in `packages/config/src/constants.ts` and consumed by Runtime bootstrap/token-normalization logic. Shared-auth consumes the resulting normalized token state. The browser SDK mirrors the same values locally in `packages/web-sdk/src/core/sdk-user-context-validation.ts`, with parity covered by package tests.

- `SDK_USER_CONTEXT_MAX_BYTES = 4096`
- `SDK_USER_CONTEXT_MAX_ATTRIBUTES = 32`
- `SDK_USER_CONTEXT_KEY_MAX_CHARS = 128`
- `SDK_USER_CONTEXT_STRING_MAX_CHARS = 512`
- `SDK_USER_CONTEXT_ARRAY_MAX_ITEMS = 16`
- `SDK_USER_CONTEXT_MAX_DEPTH = 2` (reserved for future nested-object support; current implementation rejects nested objects outright)
- `SDK_USER_CONTEXT_HMAC_MAX_CHARS = 128`
- `SDK_USER_CONTEXT_HMAC_HEX_CHARS = 64`
- `SDK_USER_CONTEXT_TIMESTAMP_MAX_SECONDS = 9999999999`

Allowed values:

- `userId?: string`
- `customAttributes?: Record<string, string | number | boolean | null | primitive[]>`
- `hmac?: string` (`64` hex characters for the current SHA-256 signed-identity envelope)
- `timestamp?: number` (Unix seconds; freshness window remains Runtime-only)

Disallowed:

- nested objects
- unbounded arrays
- oversized strings or payloads

## 6. File Inventory

### Runtime

| File                                                                  | Responsibility                                                            | Current State                                                                                                                                                                                                                                                                                                                                                                                                                                                                                      |
| --------------------------------------------------------------------- | ------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `apps/runtime/src/routes/sdk-init.ts`                                 | canonical Runtime issuer for public-key and Studio bootstrap flows        | implemented; validates bootstrap method exclusivity, userContext, HMAC identity, preview/share artifacts, and refresh                                                                                                                                                                                                                                                                                                                                                                              |
| `apps/runtime/src/middleware/sdk-auth.ts`                             | public-key bootstrap resolution                                           | implemented; helper-only module used by `sdk/init`                                                                                                                                                                                                                                                                                                                                                                                                                                                 |
| `apps/runtime/src/websocket/sdk-handler.ts`                           | `/ws/sdk` authentication and session lifecycle                            | implemented; subprotocol auth only, session-ready gating, explicit public OAuth callback-base enforcement, and explicit `end_session` lifecycle override for default-detach channels                                                                                                                                                                                                                                                                                                               |
| `apps/runtime/src/services/execution/execution-coordinator.ts`        | coordinated execution lifecycle and cancellation bridging                 | implemented; caller abort signals now bridge into coordinated execution and cleanup paths                                                                                                                                                                                                                                                                                                                                                                                                          |
| `apps/runtime/src/services/llm/llm-queue.ts`                          | queued/direct LLM execution and cancellation handling                     | implemented; carries abort-aware execution options through direct fallback and distributed queue paths                                                                                                                                                                                                                                                                                                                                                                                             |
| `apps/runtime/src/services/oauth-callback-url.ts`                     | SDK/browser-facing OAuth callback URL normalization                       | implemented; requires explicit `RUNTIME_PUBLIC_BASE_URL`                                                                                                                                                                                                                                                                                                                                                                                                                                           |
| `apps/runtime/src/services/oauth-state-store-factory.ts`              | shared Runtime OAuth callback state selection                             | implemented; Redis outside tests, in-memory only in test mode                                                                                                                                                                                                                                                                                                                                                                                                                                      |
| `apps/runtime/src/routes/chat.ts`                                     | HTTP SDK chat and session principal propagation                           | implemented                                                                                                                                                                                                                                                                                                                                                                                                                                                                                        |
| `apps/runtime/src/middleware/session-access.ts`                       | project-scoped session authorization helper                               | implemented; denies session-scoped SDK callers against legacy channel-artifact-only session rows and is reused by LiveKit/analytics/diagnostics-style routes                                                                                                                                                                                                                                                                                                                                       |
| `apps/runtime/src/routes/sessions.ts`                                 | persisted session browsing/close/delete compatibility                     | implemented; fails closed for trace/export/generation authorization when project scope or session ownership cannot be verified, keeps RuntimeExecutor-only session-list fallback scoped for SDK callers and non-elevated user callers during DB unavailability, denies in-memory fallback on explicit trace/export/generation lookups without persisted ownership proof, and cleans up using the stored runtime id while keeping distinct `runtimeSessionId` lookup as a legacy/compatibility path |
| `apps/runtime/src/services/identity/stored-session-caller-context.ts` | persisted caller-context reconstruction                                   | implemented; preserves legacy rows while allowing shared-auth to evaluate reconstructed ownership state                                                                                                                                                                                                                                                                                                                                                                                            |
| `apps/runtime/src/routes/sdk-channels.ts`                             | project-scoped SDK channel control-plane APIs                             | implemented; exercised by API-level proof for `identityVerification`, secret rotation, disablement, and concealment                                                                                                                                                                                                                                                                                                                                                                                |
| `apps/runtime/src/routes/tenant-sdk-channels.ts`                      | tenant-scoped SDK channel control-plane APIs                              | implemented; exercised by tenant-admin API proof for policy/secret lifecycle paths                                                                                                                                                                                                                                                                                                                                                                                                                 |
| `apps/runtime/src/routes/sdk-channel-identity-utils.ts`               | shared SDK channel identity-policy and HMAC helper logic                  | implemented; API-level proof now covers the current secret lifecycle contract                                                                                                                                                                                                                                                                                                                                                                                                                      |
| `apps/runtime/src/routes/project-runtime-config.ts`                   | project runtime config API exposing SDK channel/runtime settings          | implemented; operationally important for Studio/runtime endpoint resolution                                                                                                                                                                                                                                                                                                                                                                                                                        |
| `apps/runtime/src/services/identity/sdk-session-token.ts`             | userContext normalization and legacy token normalization                  | implemented                                                                                                                                                                                                                                                                                                                                                                                                                                                                                        |
| `apps/runtime/src/services/identity/sdk-secret-config.ts`             | split signer resolution for Runtime `sdk_session` and bootstrap artifacts | implemented; enforces dedicated non-test signing secrets                                                                                                                                                                                                                                                                                                                                                                                                                                           |
| `apps/runtime/src/services/identity/artifact-hasher.ts`               | caller/session artifact derivation                                        | implemented                                                                                                                                                                                                                                                                                                                                                                                                                                                                                        |
| `apps/runtime/src/repos/session-repo.ts`                              | persisted-session lookup helpers                                          | implemented; adds unified-id lookup plus a legacy/compatibility `runtimeSessionId` path used by session routes                                                                                                                                                                                                                                                                                                                                                                                     |
| `apps/runtime/src/services/auth-profile/auth-preflight.ts`            | auth-preflight state keyed to effective caller principal                  | implemented, with integration proof for session-scope suppression but still missing final public-API/browser proof                                                                                                                                                                                                                                                                                                                                                                                 |

### Studio

| File                                                                | Responsibility                                                                                   | Current State                                                                                                                                                                                                                              |
| ------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `apps/studio/src/lib/studio-sdk-session.ts`                         | bootstrap TTL and permission helpers                                                             | implemented                                                                                                                                                                                                                                |
| `apps/studio/src/lib/sdk-bootstrap-channel.ts`                      | resolves the active SDK channel for preview/share/embed bootstrap                                | implemented; prefers a valid widget-configured default channel, otherwise auto-resolves a single active channel, rejects remaining ambiguity, and falls back when a widget-configured channel becomes stale but one active channel remains |
| `apps/studio/src/lib/runtime-sdk-session.ts`                        | Runtime exchange client for bootstrap artifacts                                                  | implemented; now fails closed if Runtime URL is not configured                                                                                                                                                                             |
| `apps/studio/src/lib/sdk-project-access.ts`                         | shared SDK control-plane project authorization                                                   | implemented; preview/share, keys, embed, widget, and Runtime SDK channel proxy routes converge here, and generic tenant read/write permissions no longer bypass project membership                                                         |
| `apps/studio/src/lib/sdk-runtime-channel-proxy.ts`                  | shared Studio authz + strict Runtime URL resolution for SDK channel proxy routes                 | implemented; requires project-scoped access plus explicit Runtime URL                                                                                                                                                                      |
| `apps/studio/src/lib/sdk-share-token.ts`                            | share artifact signing and verification                                                          | implemented                                                                                                                                                                                                                                |
| `apps/studio/src/app/api/sdk/preview-token/route.ts`                | authenticated preview bootstrap API                                                              | implemented                                                                                                                                                                                                                                |
| `apps/studio/src/app/api/sdk/share/route.ts`                        | share artifact creation                                                                          | implemented; always binds to a real active SDK channel                                                                                                                                                                                     |
| `apps/studio/src/app/api/sdk/share/exchange/route.ts`               | share exchange through Runtime                                                                   | implemented                                                                                                                                                                                                                                |
| `apps/studio/src/app/api/runtime/sdk-channels/route.ts`             | Studio-authenticated Runtime SDK channel proxy list/create                                       | implemented; shares project auth helper, fails closed on missing Runtime URL, and requires `projectId` query param                                                                                                                         |
| `apps/studio/src/app/api/runtime/sdk-channels/[channelId]/route.ts` | Studio-authenticated Runtime SDK channel proxy detail/update/delete                              | implemented; shares project auth helper, fails closed on missing Runtime URL, forwards through the tenant-scoped Runtime admin path, and normalizes concealed `404` responses                                                              |
| `apps/studio/src/app/api/sdk/keys/route.ts`                         | SDK public-key list/create under shared project access                                           | implemented                                                                                                                                                                                                                                |
| `apps/studio/src/app/api/sdk/keys/[keyId]/route.ts`                 | SDK public-key revoke under shared project access                                                | implemented                                                                                                                                                                                                                                |
| `apps/studio/src/app/api/sdk/embed/[projectId]/route.ts`            | embed snippet route under shared project access                                                  | implemented; fails closed when no widget capability remains and uses same-origin fallback only for browser-consumed snippet generation when Runtime URL is not explicitly configured                                                       |
| `apps/studio/src/app/api/sdk/widget/[projectId]/route.ts`           | widget config read/write under shared SDK project access                                         | implemented                                                                                                                                                                                                                                |
| `apps/studio/src/app/api/livekit/token/route.ts`                    | Studio-authenticated Runtime LiveKit token proxy                                                 | implemented; now fails closed when Runtime URL is missing                                                                                                                                                                                  |
| `apps/studio/src/app/api/livekit/capabilities/route.ts`             | Studio-authenticated Runtime LiveKit capabilities proxy                                          | implemented; now fails closed when Runtime URL is missing                                                                                                                                                                                  |
| `apps/studio/src/app/preview/page.tsx`                              | preview/share browser entry page                                                                 | implemented; marks ready/connected state on Runtime `session_start`, not raw socket open, and clears any tab-scoped persisted share artifact after successful exchange                                                                     |
| `apps/studio/src/app/preview/[projectId]/page.tsx`                  | project-targeted preview browser entry page                                                      | implemented; accepts optional `channelId` and marks ready/connected state on `session_start`                                                                                                                                               |
| `apps/studio/src/app/preview-livekit/page.tsx`                      | voice preview browser entry page                                                                 | implemented, but browser voice E2E is still open                                                                                                                                                                                           |
| `apps/studio/src/app/layout.tsx`                                    | injects resolved Runtime API/WS/SDK-WS config into browser surfaces                              | implemented; now resolves request-time runtime config for preview/widget flows                                                                                                                                                             |
| `apps/studio/src/config/runtime.ts`                                 | Runtime URL helpers                                                                              | implemented; strict SDK-exchange helpers fail closed, while browser embed/public config can intentionally fall back to same-origin/empty values                                                                                            |
| `apps/studio/src/proxy.ts`                                          | keeps public preview/share pages and public browser-E2E host assets out of Studio auth redirects | implemented; `/preview` stays public and file-extension assets such as `sdk-browser-e2e-host.html` are not redirected or rewritten to the Studio SPA                                                                                       |

### Browser SDK

| File                                                       | Responsibility                        | Current State                                                                                                       |
| ---------------------------------------------------------- | ------------------------------------- | ------------------------------------------------------------------------------------------------------------------- |
| `packages/web-sdk/src/core/endpoint.ts`                    | explicit endpoint normalization       | implemented; fails closed                                                                                           |
| `packages/web-sdk/src/core/TokenManager.ts`                | bootstrap and refresh HTTP client     | implemented; browser-side validation mirrors Runtime limits                                                         |
| `packages/web-sdk/src/core/SessionManager.ts`              | WebSocket readiness and reconnect     | implemented; resolves `connect()` on `session_start`                                                                |
| `packages/web-sdk/src/core/AgentSDK.ts`                    | public package contract               | implemented                                                                                                         |
| `packages/web-sdk/src/react/AgentProvider.tsx`             | React lifecycle wrapper               | implemented; recreates SDK on currently tested config changes such as `userContext`, `channelId`, and `channelName` |
| `packages/web-sdk/src/voice/browser-support.ts`            | shared browser voice support helper   | implemented; keeps widget and client voice-support checks aligned                                                   |
| `packages/web-sdk/src/ui/ChatWidget.ts`                    | chat widget entry point               | implemented; reinitializes on bootstrap attribute changes                                                           |
| `packages/web-sdk/src/ui/UnifiedWidget.ts`                 | unified widget entry point            | implemented; reinitializes on bootstrap attribute changes                                                           |
| `packages/web-sdk/src/ui/VoiceWidget.ts`                   | voice widget entry point              | implemented; reinitializes on bootstrap attribute changes                                                           |
| `packages/web-sdk/src/core/sdk-user-context-validation.ts` | browser-side validation parity helper | implemented                                                                                                         |

### Shared packages

| File                                                         | Responsibility                                                                                                | Current State |
| ------------------------------------------------------------ | ------------------------------------------------------------------------------------------------------------- | ------------- |
| `packages/shared/src/sdk-bootstrap-artifact.ts`              | preview/share bootstrap artifact format                                                                       | implemented   |
| `packages/shared-auth/src/middleware/unified-auth.ts`        | SDK token -> auth context bridge                                                                              | implemented   |
| `packages/shared-auth/src/middleware/auth-context-bridge.ts` | legacy context normalization                                                                                  | implemented   |
| `packages/shared-auth/src/middleware/session-ownership.ts`   | session ownership matching/filtering plus elevated-user middleware pass-through for runtime-only `:id` routes | implemented   |
| `packages/openapi/src/nextjs/validate-body.ts`               | deterministic Studio request validation                                                                       | implemented   |

## 7. Tests Mapped To Implementation

### Passing today

- `packages/shared-auth/src/__tests__/auth-context-bridge.test.ts`
- `packages/shared-auth/src/__tests__/session-ownership.test.ts`
- `packages/shared-auth/src/__tests__/unified-auth.test.ts`
- `apps/runtime/src/__tests__/sdk-session-token.test.ts`
- `apps/runtime/src/__tests__/contexts/orchestration/chat-identity-wiring.test.ts`
- `apps/runtime/src/__tests__/ws-sdk-handler.test.ts`
- `apps/runtime/src/__tests__/sdk-bootstrap-auth.integration.test.ts`
- `apps/runtime/src/__tests__/oauth-callback-url.test.ts`
- `apps/runtime/src/__tests__/oauth-state-store-factory.test.ts`
- `apps/runtime/src/__tests__/wiring.test.ts`
- `apps/runtime/src/__tests__/channels-sdk-runtime.e2e.test.ts`
- `apps/runtime/src/__tests__/channels-control-plane.e2e.test.ts`
- `apps/runtime/src/__tests__/session-routes.test.ts`
- `apps/runtime/src/__tests__/execution-coordinator.test.ts`
- `apps/runtime/src/__tests__/llm-queue-distributed.test.ts`
- `apps/runtime/src/__tests__/ws-message-timeout.test.ts`
- `apps/runtime/src/__tests__/middleware/session-access.test.ts`
- `packages/web-sdk/src/__tests__/token-manager-contract.test.ts`
- `apps/runtime/src/__tests__/integration/auth-preflight-multichannel.test.ts`
- `apps/runtime/src/__tests__/middleware/sdk-auth.test.ts`
- `apps/studio/src/__tests__/sdk-preview-share-api.e2e.test.ts`
- `apps/studio/src/__tests__/runtime-sdk-session.test.ts`
- `apps/studio/src/__tests__/sdk-widget-capabilities.test.ts`
- `packages/shared/src/__tests__/sdk-widget-capabilities.test.ts`
- `apps/studio/src/__tests__/runtime-config.test.ts`
- `apps/studio/src/__tests__/api-deployment-routes.test.ts`
- `apps/studio/e2e/sdk-widget.spec.ts`
- `apps/studio/e2e/sdk-preview-share.spec.ts`
- `packages/web-sdk/src/__tests__/endpoint-config.test.ts`
- `packages/web-sdk/src/__tests__/session-manager-connect.test.ts`
- `packages/web-sdk/src/__tests__/agent-provider-config.test.ts`
- `packages/web-sdk/src/__tests__/widget-bootstrap-retry.test.ts`
- `packages/web-sdk/src/__tests__/token-manager-user-context.test.ts`

### Supporting browser E2E infrastructure

- `apps/studio/e2e/helpers/sdk-browser-e2e.ts`
- `apps/studio/e2e/helpers/sdk-browser-env.ts`
- `apps/studio/e2e/helpers/sdk-browser-stack.ts`
- `apps/studio/public/sdk-browser-e2e-host.html`

### Shared browser/widget capability helpers

- `packages/shared/src/sdk-widget-capabilities.ts`
- `packages/web-sdk/src/voice/browser-support.ts`

### Isolated browser stack prerequisites and prebuilt artifacts

- `apps/runtime/dist/index.js` (Runtime built output required by isolated stack launcher)
- `apps/studio/.next/BUILD_ID` (Studio production build artifact required by isolated stack launcher)
- `packages/web-sdk/dist/agent-sdk.umd.js` (SDK UMD bundle required by widget browser spec)
- `SDK_BROWSER_E2E_STRICT` and `SDK_BROWSER_E2E_ISOLATED` (strict prerequisite gating and isolated stack mode controls)

### Attach-to-existing-services browser mode

- uses the configured `STUDIO_URL` / `RUNTIME_URL` instead of the self-started isolated stack
- requires Studio `/auth/login`, Runtime `/health`, Studio dev-login enabled, and writable Studio APIs used by the bootstrap helpers
- writes real users/projects/keys/channels/share artifacts into the target environment
- is not a proof of persistent-state cleanup or cross-run order-independence

## 8. Known Gaps After This Baseline

1. Anonymous auth-preflight and OAuth still need final public-API/browser proof; current multichannel integration coverage is not the end-state proof level.
2. Canonical CI adoption of the isolated browser E2E lane is still pending.
3. Browser voice/LiveKit E2E is still missing.
4. Ingress/header redaction proof is still operational, not in-repo.
5. Multi-pod/failover proof is still missing.

## 9. Immediate Next Steps

1. Add black-box anonymous auth-preflight/OAuth proof.
2. Optionally adopt the isolated browser E2E lane as a required CI job.
3. Optionally fold `sdk-channels-authz.test.ts` into the dedicated SDK CI lane so legacy-route removal proof stays close to the canonical SDK suites.

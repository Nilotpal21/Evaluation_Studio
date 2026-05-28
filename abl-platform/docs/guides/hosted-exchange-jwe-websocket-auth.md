# Hosted Exchange JWE And WebSocket Ticket Auth

This note describes the current Hosted Exchange JWE and browser WebSocket ticket flow from Studio configuration through Runtime handshakes. It is grounded in the implementation under `apps/runtime`, `apps/studio`, `packages/web-sdk`, and `packages/shared`.

## Current Status

The code path is wired end to end for configuration, capability preflight, Hosted Exchange token envelope policy, SDK WebSocket ticket minting, ticket consumption, and live WebSocket reauthorization.

The broad Runtime SDK auth E2E lane is green. The packaged SDK E2E harness installs an in-memory Redis-compatible ticket store for `/api/v1/sdk/ws-ticket`, so the secure fail-closed browser WebSocket ticket path is exercised without requiring external Redis during tests. Integration assertions were also updated to validate encrypted SDK session tokens through Runtime auth helpers instead of assuming signed JWT payload inspection.

## Relevant Code

- Studio channel API and capability client: `apps/studio/src/api/channels.ts`
- Studio create flow: `apps/studio/src/components/deployments/channels/CreateInstanceDialog.tsx`
- Studio configuration flow: `apps/studio/src/components/deployments/channels/tabs/ConfigurationTab.tsx`
- Studio Runtime proxy: `apps/studio/src/app/api/runtime/sdk-jwe-capability/route.ts`
- Runtime JWE capability route: `apps/runtime/src/routes/sdk-jwe-capability.ts`
- Runtime SDK init and refresh: `apps/runtime/src/routes/sdk-init.ts`
- Runtime hosted exchange bootstrap route: `apps/runtime/src/routes/sdk-customer-sessions.ts`
- Runtime WebSocket ticket route: `apps/runtime/src/routes/sdk-ws-ticket.ts`
- Runtime WebSocket ticket store: `apps/runtime/src/services/identity/sdk-ws-ticket-store.ts`
- Runtime SDK session live auth: `apps/runtime/src/services/identity/sdk-session-token-auth.ts`
- Runtime SDK WebSocket handler: `apps/runtime/src/websocket/sdk-handler.ts`
- Shared WebSocket auth protocol helpers: `packages/shared/src/websocket-auth.ts`
- Browser SDK connection flow: `packages/web-sdk/src/core/SessionManager.ts`
- Browser SDK WebSocket protocol helpers: `packages/web-sdk/src/internal/websocket-auth.ts`
- Runtime browser SDK CORS resolver: `apps/runtime/src/lib/sdk-browser-cors.ts`

## Policy Modes

Hosted Exchange channel config supports these token envelope policies:

| Policy          | Meaning                                                                                                             |
| --------------- | ------------------------------------------------------------------------------------------------------------------- |
| `inherit`       | Use the project default Hosted Exchange token envelope policy.                                                      |
| `signed`        | Issue signed bootstrap/session tokens.                                                                              |
| `jwe_preferred` | Use JWE when Runtime capability is ready, otherwise remain compatible with signed tokens.                           |
| `jwe_required`  | Require JWE issuance and verification; fail closed when Runtime cannot issue encrypted bootstrap or session tokens. |

Studio warns for `jwe_required` when Runtime reports that either bootstrap or session JWE issuance is unavailable. The warning is driven by `canIssueBootstrap` and `canIssueSession`, not only by generic JWE support.

## Applicability Boundary

The Hosted Exchange token envelope policy applies only to Hosted Exchange customer bootstrap flows: channels with `auth.mode = hosted_exchange` where Runtime resolves the SDK bootstrap type as `customer`.

Public-key SDK initialization remains signed by design. If a browser calls `/api/v1/sdk/init` directly with a public SDK key, Runtime resolves `bootstrapType = public_key` and the token envelope policy is not applied. Seeing a 2-part signed token in that path is expected and does not validate JWE rollout.

To validate JWE behavior, use the Hosted Exchange journey:

1. Configure an SDK channel with Hosted Exchange auth.
2. Set `sdkTokenEnvelopePolicy` to `jwe_preferred` or `jwe_required`.
3. Have the customer backend create a customer bootstrap artifact with the channel server secret.
4. Exchange that customer bootstrap through Runtime.
5. Assert `tokenEnvelope: "jwe"` and a 5-part token when Runtime capability is ready.

For `jwe_required`, a Hosted Exchange customer flow should never return a signed token with HTTP 200. It should either return JWE or fail closed with a JWE/auth error.

## Studio Setup Flow

1. In Studio, create or edit an SDK channel.
2. Select Hosted Exchange authentication for the SDK channel.
3. Choose the Hosted Exchange token envelope policy:
   - Use `jwe_preferred` for compatibility rollout.
   - Use `jwe_required` when encrypted bootstrap and encrypted session tokens must be enforced.
   - Use `signed` only for rollback or explicit compatibility.
4. Studio calls `fetchSdkJweCapability(projectId)` in `apps/studio/src/api/channels.ts`.
5. The Studio Next route `GET /api/runtime/sdk-jwe-capability?projectId=...` proxies to Runtime at `/api/projects/:projectId/sdk-jwe-capability`.
6. Runtime requires user auth, project scope, tenant rate limiting, and `channel:read` permission before returning coarse JWE readiness.
7. On create, Studio reveals the Hosted Exchange server secret once. The customer backend stores that secret server-side and uses it to mint bootstrap artifacts for browsers.

## Runtime Readiness Preflight

Runtime capability is exposed by `apps/runtime/src/routes/sdk-jwe-capability.ts`.

The response intentionally avoids key IDs, key material, decrypted claims, and tenant internals. It returns:

```json
{
  "success": true,
  "supported": true,
  "canIssueBootstrap": true,
  "canIssueSession": true,
  "canVerify": true,
  "maxEncryptedBootstrapBytes": 0,
  "maxEncryptedSessionBytes": 0
}
```

Possible `blockedReason` values are:

- `provider_disabled`
- `key_provider_unavailable`
- `transport_budget_unverified`
- `diagnostics_unready`
- `redaction_unverified`

For `jwe_required`, both `canIssueBootstrap` and `canIssueSession` must be true. `canVerify` must also remain true for Runtime to accept encrypted artifacts.

## Browser And Customer Backend Handshakes

### Hosted Exchange Bootstrap

1. Customer backend uses the Hosted Exchange server secret to create a customer bootstrap artifact.
2. Browser passes the bootstrap artifact to the Web SDK.
3. The Web SDK calls Runtime SDK init/customer-session endpoints.
4. Runtime validates the Hosted Exchange channel, origin, channel state, customer identity, and token envelope policy.
5. When the policy resolves to JWE, Runtime issues encrypted SDK bootstrap/session material. When policy is `jwe_required`, signed tokens are rejected.

Relevant Runtime code lives in `apps/runtime/src/routes/sdk-customer-sessions.ts`, `apps/runtime/src/routes/sdk-init.ts`, and the token envelope services under `apps/runtime/src/services/identity/`.

### SDK Session Token Refresh

The browser SDK uses `X-SDK-Token` for SDK HTTP routes. Refresh goes through `/api/v1/sdk/refresh` in `apps/runtime/src/routes/sdk-init.ts`.

Live refresh authorization rechecks the channel and its current binding. Tokens issued before a channel is disabled, rebound, or moved to `jwe_required` should not continue to authorize refresh indefinitely.

### WebSocket Ticket Handshake

The preferred browser WebSocket flow no longer sends the reusable SDK session token in `Sec-WebSocket-Protocol`.

1. Browser SDK has an SDK session token.
2. Before opening WebSocket, `SessionManager.resolveWebSocketProtocols()` calls:

   ```http
   POST /api/v1/sdk/ws-ticket
   Content-Type: application/json
   X-SDK-Token: <sdk_session_token>

   {}
   ```

3. Runtime verifies the SDK session token with `verifyRuntimeSdkSessionForAuth()`.
4. Runtime applies tenant/project rate limiting for ticket minting.
5. Runtime stores a minimized ticket record in Redis with a 60 second TTL.
6. Runtime returns:

   ```json
   {
     "ticket": "<one_time_ticket>",
     "expiresIn": 60
   }
   ```

7. Browser SDK opens WebSocket with:

   ```http
   Sec-WebSocket-Protocol: sdk-ticket,<one_time_ticket>
   ```

8. Runtime consumes the ticket with Redis `GETDEL`, so the ticket is one-time use.
9. Runtime re-runs live SDK session authorization using the minimized payload and envelope stored in the ticket record.
10. Runtime builds WebSocket client state from the authorized session and prefers the current live channel binding over token-carried deployment/environment values.

The legacy `sdk-auth,<sdk_session_token>` subprotocol remains in Runtime and shared helpers only for compatibility with older published SDK bundles.

## CORS Requirements

Browser SDK routes are recognized by `packages/shared/src/sdk-browser-routes.ts` and handled by `apps/runtime/src/lib/sdk-browser-cors.ts`.

For browser SDK routes, Runtime reflects the caller origin so customer sites can complete preflight. The actual allowlist and channel policy are enforced later by SDK auth after Runtime knows the SDK key/channel.

Runtime now also guarantees SDK browser routes include required methods and headers even when deployment CORS config overrides defaults:

- `POST`
- `OPTIONS`
- `Content-Type`
- `Authorization`
- `X-SDK-Token`
- `X-Public-Key`
- `X-Tenant-Id`
- `X-Request-Id`

Non-SDK routes continue to use the configured deployment CORS methods and headers unchanged.

## Operational Gotchas

- Redis is required for `/api/v1/sdk/ws-ticket`. If Redis is unavailable, ticket minting returns `503 SDK_WS_TICKET_UNAVAILABLE`.
- The Web SDK fails closed for ticket endpoint failures except compatibility-only statuses `404`, `405`, and `501`. It does not silently downgrade on `401`, `403`, `429`, `500`, `503`, malformed JSON, or missing tickets.
- `jwe_required` requires both bootstrap and session JWE readiness. A Runtime that can issue session JWE but not bootstrap JWE is not ready for strict Hosted Exchange.
- Tickets are short-lived and one-time use. Reuse, expiry, malformed Redis records, or Redis unavailability all reject WebSocket auth with close code `4003`.
- The Redis ticket record intentionally stores only a minimized SDK session payload plus the token envelope mode, issue time, and expiry time.
- The WebSocket path performs live authorization after consuming the ticket. This is required so channel disable, key revoke, permission changes, policy changes, and channel rebinding are observed at handshake time.
- The legacy `sdk-auth` WebSocket subprotocol is deprecated but still present for older SDK bundles. New Web SDK builds use `sdk-ticket`.
- Exact user-facing refresh error strings changed in some paths to generic invalid/expired token responses. Tests and support docs should avoid relying on overly specific internal revocation strings unless the API contract explicitly requires them.

## Verification Run

Passing checks run locally:

```bash
pnpm --filter @agent-platform/runtime build
pnpm --filter @agent-platform/web-sdk build
pnpm --filter @agent-platform/studio build
pnpm --dir apps/runtime test:smoke
pnpm --filter @agent-platform/runtime run test:sdk-auth
pnpm --filter @agent-platform/runtime exec vitest run --config vitest.core.config.ts --maxWorkers=1 src/__tests__/sdk-browser-cors.test.ts src/__tests__/identity/sdk-ws-ticket-store.test.ts src/__tests__/routes/sdk-ws-ticket-route.test.ts src/__tests__/identity/sdk-session-token-auth.test.ts src/__tests__/channels/ws-sdk-handler.test.ts src/__tests__/channels/channels-sdk-runtime.e2e.test.ts
pnpm --filter @agent-platform/web-sdk exec vitest run src/__tests__/session-manager-connect.test.ts
pnpm --filter @agent-platform/shared exec vitest run src/__tests__/websocket-auth.test.ts
```

The pre-push gate for `develop` also passed branch protection, independent checks, architecture fitness, build verification, typecheck, runtime smoke, and remaining package tests before the implementation was pushed.

Resolved test-harness compatibility notes:

- Packaged SDK E2E no longer depends on external Redis; the harness injects an in-memory `RedisTicketClient` into the SDK WebSocket ticket store and resets it during cleanup.
- Tests no longer inspect SDK session tokens with `jwt.verify()` when the channel can issue JWE. They verify tokens through Runtime SDK auth helpers so signed and encrypted envelopes follow the production validation path.
- Exact refresh error assertions were relaxed to the stable invalid/expired token contract where Runtime intentionally sanitizes internal revocation details.

## Rollout Guidance

1. Deploy Runtime with JWE key provider support enabled and verified.
2. Verify `/api/projects/:projectId/sdk-jwe-capability` reports `canIssueBootstrap=true`, `canIssueSession=true`, and `canVerify=true`.
3. Verify Redis is available to Runtime before enabling new Web SDK bundles that require `sdk-ticket`.
4. Start with `jwe_preferred` for low-risk channels.
5. Move targeted Hosted Exchange channels to `jwe_required` after confirming customer backend bootstrap, browser init, refresh, `/api/v1/sdk/ws-ticket`, and WebSocket connect.
6. Keep legacy `sdk-auth` compatibility until older published SDK bundles are no longer supported.
7. For local and CI E2E, keep the test ticket-store injection limited to test harnesses. Production Runtime should use Redis-backed ticket storage so one-time tickets remain pod-independent.

# ABL Platform Threat Note: SDK Auth Transport and Session Replay

## Executive summary

The browser-facing SDK now has one supported WebSocket authentication path: clients present a signed `sdk_session` JWT on `/ws/sdk` using `Sec-WebSocket-Protocol: sdk-auth,<sdk_session_token>`. The checked-in browser package obtains that token through `POST /api/v1/sdk/init`, while Studio preview/share flows currently mint or exchange runtime-compatible `sdk_session` tokens through Studio-managed APIs before connecting with the same subprotocol contract. The internal Studio/runtime debug socket also moved off URL tokens and now uses `Sec-WebSocket-Protocol: web-debug-auth,<access_token>`.

The removed paths are no longer part of the live first-party surface:

- No direct `?apiKey=pk_xxx&projectId=...` WebSocket bootstrap on `/ws/sdk`
- No query-string `?token=` SDK WebSocket authentication
- No `x-api-key` attachment upload path from the browser SDK
- No query-string `?token=` auth on the internal Studio/runtime `/ws` socket
- No query-string share-token exchange on `/api/sdk/share`
- No legacy `?token=` share-link compatibility path on `/preview`

That means the primary remaining SDK threat is no longer transport drift. It is bearer-token replay if a valid `sdk_session` leaks from browser memory, malicious extensions, XSS, copied preview/share flows, or unsanitized access logs. The main operational follow-up is to ensure ingress, proxy, and telemetry layers scrub `Sec-WebSocket-Protocol` and `X-SDK-Token`.

Preview/share flows now also enforce least privilege in depth:

- Share tokens snapshot the widget's chat/voice capability at creation time.
- Share exchange intersects that snapshot with the widget's current config before issuing an SDK session.
- LiveKit token issuance requires the authenticated SDK session to carry `session:voice` and to target the same `projectId` that was bound into the SDK session token.

## Current live contract

| Surface               | Live contract                                                                                                                                                      | Evidence                                                                                                                                                                                                                                              |
| --------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------ | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| SDK bootstrap         | `POST /api/v1/sdk/init` with `X-Public-Key` exchanges a scoped public key for a signed `sdk_session` JWT                                                           | `apps/runtime/src/routes/sdk-init.ts`, `apps/runtime/src/middleware/sdk-auth.ts`                                                                                                                                                                      |
| SDK refresh           | `POST /api/v1/sdk/refresh` with `X-SDK-Token` refreshes an existing SDK session                                                                                    | `apps/runtime/src/routes/sdk-init.ts`                                                                                                                                                                                                                 |
| SDK WebSocket         | `WS /ws/sdk` requires `Sec-WebSocket-Protocol: sdk-auth,<sdk_session_token>`                                                                                       | `apps/runtime/src/websocket/sdk-handler.ts`, `apps/runtime/src/server.ts`                                                                                                                                                                             |
| SDK attachment upload | `POST /api/projects/:projectId/sessions/:sessionId/attachments` with `X-SDK-Token`                                                                                 | `packages/web-sdk/src/chat/ChatClient.ts`, `apps/runtime/src/routes/attachments.ts`                                                                                                                                                                   |
| Studio preview/share  | Share URLs carry the token in the URL fragment, preview clients exchange it via `POST /api/sdk/share/exchange`, then connect with subprotocol-based WebSocket auth | `apps/studio/src/app/api/sdk/preview-token/route.ts`, `apps/studio/src/app/api/sdk/share/route.ts`, `apps/studio/src/app/api/sdk/share/exchange/route.ts`, `apps/studio/src/app/preview/page.tsx`, `apps/studio/src/app/preview/[projectId]/page.tsx` |
| Studio internal `/ws` | Internal debug WebSocket requires `Sec-WebSocket-Protocol: web-debug-auth,<access_token>`                                                                          | `apps/studio/src/contexts/WebSocketContext.tsx`, `apps/runtime/src/websocket/handler.ts`, `apps/runtime/src/server.ts`                                                                                                                                |

## Removed or stale paths

| Path                                           | Status  | Why it mattered                                                                    |
| ---------------------------------------------- | ------- | ---------------------------------------------------------------------------------- |
| `/ws/sdk?apiKey=pk_xxx&projectId=...`          | Removed | Mixed bootstrap and session transport, encouraged weaker compatibility behavior    |
| `/ws/sdk?token=<sdk_session>`                  | Removed | Put bearer credentials in URLs, browser history, copied links, and downstream logs |
| Browser SDK attachment upload with `x-api-key` | Removed | Bypassed the session-authenticated, project-scoped attachment route shape          |

## Primary threats

| Threat ID | Threat                                      | What still has to go wrong                                                                                                     | Impact                                                                          | Current controls                                                                                                                                  | Remaining gap                                                             |
| --------- | ------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------ | ------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------- |
| TM-001    | SDK bearer replay                           | Attacker gets a valid `sdk_session` JWT from XSS, malicious extensions, malware, copied preview/share flows, or leaked headers | Session impersonation until expiry                                              | Signed JWTs, issuer/audience/expiry checks, tenant/project scoping, 4h TTL, session ownership filters                                             | No proof-of-possession or per-token replay revocation                     |
| TM-002    | Header/log leakage                          | `Sec-WebSocket-Protocol` or `X-SDK-Token` is captured in proxy logs, telemetry, support tooling, or traces                     | Observability systems become credential exfiltration paths                      | Query-string token auth removed, first-party clients no longer send SDK tokens in URLs                                                            | Deployed ingress/log pipelines still need explicit redaction verification |
| TM-003    | Bootstrap abuse with broad public-key scope | A `pk_*` key is exposed and `allowedOrigins` or permissions are too broad                                                      | Unauthorized session minting for one project/channel scope                      | Public keys hashed at rest, origin checks, rate limits, server-side project/tenant resolution                                                     | Misconfigured origins or over-broad permissions remain an operator risk   |
| TM-004    | Preview/share token misuse                  | A user obtains a valid share link or preview flow result and reuses the resulting SDK session token                            | Anonymous or semi-trusted access to live agent interaction within granted scope | Signed share-token validation, capability snapshots, exchange-time permission intersection, project-bound `session:voice` enforcement, 4h SDK TTL | Share/preview-issued SDK tokens are still bearer credentials once minted  |

## Attack paths that are no longer relevant

- “Session cloning requires both a session token and a browser fingerprint hash” is not the right model for the current SDK surface. The runtime does not enforce a second browser fingerprint factor on every use.
- “The published browser package still uses `?apiKey=` on `/ws/sdk`” is no longer true in this repo.
- “Attachment upload requires public-key auth from the browser SDK” is no longer true in this repo.

## Security properties now enforced in code

- Runtime only accepts SDK WebSocket auth from the subprotocol header on `/ws/sdk`
- Runtime only accepts Studio internal WebSocket auth from the subprotocol header on `/ws`
- First-party browser clients no longer place SDK bearer tokens in WebSocket URLs
- Studio share links no longer send the share token to the server in the initial `/preview` request, and the browser no longer persists the raw share token in `history.state`
- Attachment upload from the browser SDK now uses a session-authenticated, project-scoped route
- SDK bootstrap, refresh, and WebSocket auth all converge on the same signed `sdk_session` token type
- Session access remains scoped by tenant, project, and session ownership middleware
- Share exchange can mint narrower page-specific SDK sessions, and voice preview/share flows must explicitly obtain `session:voice`
- LiveKit token issuance rejects SDK callers that lack `session:voice` or try to switch to another project in the same tenant
- Query-token ingress fallback is now explicitly allowlisted only for the remaining provider transports documented in `docs/security/query-token-transport-allowlist.md`, with a runtime source guard test that blocks new accidental query-token surfaces

## Comprehensive Audit Results (2026-03-20)

A five-auditor review of 22 commits plus uncommitted changes on the develop branch was completed on 2026-03-20. The audit covered SDK auth, channels, session management, analytics, share flows, archive isolation, and cross-cutting security patterns.

### Critical Findings (OPEN)

| ID  | Finding                                                                                                           | Status |
| --- | ----------------------------------------------------------------------------------------------------------------- | ------ |
| C1  | `clients` Map in `websocket/handler.ts` has no max-size bound -- unbounded connections can cause OOM              | OPEN   |
| C2  | ClickHouse SQL query endpoint in analytics routes leaks raw error messages to callers                             | OPEN   |
| C3  | Share exchange legacy fallback performs tenant-less `Project.findById` -- cross-tenant leak via stale tokens      | OPEN   |
| C4  | Share POST route uses `ownerId` instead of `tenantId` for project lookup -- cross-tenant risk if user IDs overlap | OPEN   |

### High Findings (OPEN)

| ID  | Finding                                                                                                        | Status |
| --- | -------------------------------------------------------------------------------------------------------------- | ------ |
| H1  | `getAuthorizedRuntimeSession` skips ownership check when `messageType` is falsy                                | OPEN   |
| H2  | N+1 Redis sequential GET in agent-transfer sessions listing                                                    | OPEN   |
| H3  | Swallowed errors `.catch(() => {})` in runtime-executor and paused-execution-store                             | OPEN   |
| H4  | `console.log`/`console.warn` in production server code (should use `createLogger`)                             | OPEN   |
| H5  | Inconsistent error format in analytics routes (string vs `{code, message}`)                                    | OPEN   |
| H6  | `console.error` in all 6 archive API routes instead of `createLogger`                                          | OPEN   |
| H7  | Share route body not validated with Zod -- `expiresIn` can be NaN                                              | OPEN   |
| H8  | Missing barrel re-exports for `buildSessionListFilter`, `evaluateSessionOwnershipAccess`, `AccessDeniedConfig` | OPEN   |

### Medium Findings (OPEN)

| ID  | Finding                                                                                                      | Status |
| --- | ------------------------------------------------------------------------------------------------------------ | ------ |
| M1  | Redis Pub/Sub cross-pod delivery has no `tenantId` in channel key                                            | OPEN   |
| M2  | `requireWriteAccess` uses non-null assertion `userId!` instead of explicit check                             | OPEN   |
| M3  | `platformAdminAuthMiddleware` does not check `isSuperAdmin`                                                  | OPEN   |
| M4  | ClickHouse SQL validation is regex-based (not a proper SQL parser)                                           | OPEN   |
| M5  | `findProjectsUsingTenantModel` query does not include `tenantId` in initial filter                           | OPEN   |
| M6  | `_chStores` singleton never resets on init failure -- permanent ClickHouse degradation after transient error | OPEN   |
| M7  | Provider API base override lacks SSRF validation                                                             | OPEN   |
| M8  | No rate limiting on share token generation POST endpoint                                                     | OPEN   |
| M9  | `TokenManager` in web-sdk lacks retry/backoff on init failure                                                | OPEN   |
| M10 | `console.warn` in default access-denial logger                                                               | OPEN   |
| M11 | CI sidecar starts all services even for lint-only runs                                                       | OPEN   |

### Security Improvements Confirmed by Audit

The audit confirmed the following security properties are now implemented and working:

1. **Centralized access-denied auditing** -- `AccessDeniedReporter` pattern provides structured denial events across all auth checks
2. **Fail-closed defaults everywhere** -- Authorization checks deny access on error or ambiguity, never fail open
3. **404 not 403 for cross-tenant access** -- Cross-scope access returns 404 to avoid leaking resource existence
4. **WebSocket token transport hardened** -- Subprotocol-based auth on `/ws/sdk` and `/ws`; query-string token transport rejected
5. **Mandatory tenant context** -- `requireAuthWithTenant` enforces tenant membership on all tenant-scoped routes
6. **Platform admin sentinel blocked** -- Platform admin tokens are explicitly rejected from tenant-scoped routes
7. **Timing-safe token comparison** -- `crypto.timingSafeEqual()` used for webhook signature verification and token comparison
8. **SDK connection limits enforced** -- `MAX_SDK_CLIENTS` cap on concurrent SDK WebSocket connections
9. **Pre-auth buffer limits** -- WebSocket handlers enforce count and byte limits on pre-authentication messages
10. **SSRF protection on tenant model endpoints** -- SSRF validation on callback URLs and OAuth token endpoints
11. **Archive tenant isolation** -- Archive routes enforce tenant scoping with path traversal protection
12. **Share token two-phase architecture** -- HMAC share token must be exchanged for a scoped JWT; capability snapshots intersected at exchange
13. **Backward compatibility in shared-auth** -- New auth middleware maintains backward compatibility with existing callers

### Remaining Attack Surface

The primary remaining attack surface areas identified by the audit:

- **WebSocket memory exhaustion (C1):** Unbounded `clients` Map allows connection flooding
- **Cross-tenant data leakage via share fallback (C3, C4):** Legacy code paths in share exchange and creation bypass tenant scoping
- **Information disclosure via error messages (C2, H5):** Raw database errors and inconsistent error formats can leak internal state
- **Session ownership bypass (H1):** Optional message type allows skipping ownership validation
- **Redis Pub/Sub tenant leakage (M1):** Shared Redis channel keys may deliver events across tenant boundaries
- **Platform admin privilege escalation (M3):** Missing `isSuperAdmin` check on platform admin middleware

---

## Recommended follow-up work

1. Add `jti` and server-side replay detection or revocation for `sdk_session` tokens.
2. Shorten TTLs further for preview/share-issued SDK sessions or make them single-use where practical.
3. Verify that every ingress, CDN, ALB, proxy, and trace sink redacts `Sec-WebSocket-Protocol` and `X-SDK-Token`.
4. Keep origin restrictions and permission scopes tight on public `pk_*` keys.
5. Add a browser DOM/widget E2E so UI-level SDK flows are verified against the same live runtime contract.
6. Fix all Critical and High findings from the 2026-03-20 audit (see table above).
7. Add max-size bound and eviction to the `clients` Map in `websocket/handler.ts`.
8. Add tenant scoping to share exchange legacy fallback and share creation project lookup.
9. Replace regex-based SQL validation in analytics with parameterized queries or a proper SQL parser.

## Test evidence in this repo

- `apps/runtime/src/__tests__/channels-sdk-runtime.e2e.test.ts` proves the SDK package source path bootstraps through `/api/v1/sdk/init`, authenticates with `Sec-WebSocket-Protocol`, and uploads attachments through the scoped session route.
- `apps/runtime/src/__tests__/channels-sdk-runtime.e2e.test.ts` also proves query-string SDK token transport is rejected.
- `apps/runtime/src/__tests__/channels-sdk-runtime.e2e.test.ts` proves SDK callers cannot mint LiveKit voice tokens without `session:voice` and cannot reuse an SDK session token against a different project.
- `apps/runtime/src/__tests__/channels-web-debug-runtime.e2e.test.ts` proves the internal `/ws` route authenticates via `Sec-WebSocket-Protocol`, rejects query-string token transport, and rejects invalid bearer tokens during handshake.
- `apps/runtime/src/__tests__/ws-sdk-handler.test.ts` covers accepted subprotocol auth and rejects missing-token or query-token-only requests.
- `docs/testing/sdk.md` records the current coverage and remaining SDK-specific gaps.

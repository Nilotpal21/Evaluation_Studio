# SDK Auth and Session Unification — High-Level Design

**Status**: Partially implemented / active rollout
**Date**: 2026-03-22
**Owner**: Platform team
**Related Feature Doc**: [docs/features/sdk.md](../features/sdk.md)
**Related Testing Guide**: [docs/testing/sdk.md](../testing/sdk.md)
**Related LLD Spec**: [docs/specs/sdk-auth-session-unification.lld.md](./sdk-auth-session-unification.lld.md)
**Related Plan**: [docs/plans/2026-03-19-cross-channel-auth-threat-model-consolidation-plan.md](../plans/2026-03-19-cross-channel-auth-threat-model-consolidation-plan.md)

## What

This HLD defines the SDK auth and session model across the browser SDK, Runtime, and Studio preview/share surfaces. The core architecture is now largely implemented on this branch; the remaining work is concentrated in proof gaps and operational validation.

The specific problems being solved are:

- The old cross-tenant share lookup issues (audit C3/C4) needed to be eliminated and kept eliminated in the unified flow.
- Runtime must remain the only trusted issuer of `sdk_session`, including preview/share flows.
- Unsigned `userContext` must remain metadata only, while verified identity remains explicit and separately represented.
- Anonymous SDK callers must retain session-scoped auth behavior without collapsing into shared user scope.
- The browser SDK contract must fail closed on missing `endpoint` and expose a session-ready `connect()` contract.
- Validation must be deterministic at the Runtime and Studio request boundaries.
- Studio SDK control-plane authorization must stay project-scoped: generic tenant permissions such as `project:read` must not bypass project membership for SDK routes.
- Studio-to-Runtime exchange routes must fail closed on missing Runtime configuration; only browser-consumed embed snippets may use same-origin fallback when Runtime is intentionally fronted through Studio.
- Current test coverage is strong at the Runtime transport, Runtime control-plane/authz, Studio API, and isolated browser layers. The browser proof now covers the share-link preview page, the authenticated project preview page, and the Studio-hosted widget path, with local message-send visibility rather than a full model-response assertion. It still does not provide final public-API/browser proof for anonymous auth-preflight/OAuth session scope, broader verified-identity continuity/resume behavior, deployed redaction, or multi-pod behavior.
- Runtime session-route compatibility is now also exercised directly at the route-module level: trace/export/generation routes fail closed when project-scoped authorization or session ownership cannot be verified, RuntimeExecutor-only session-list fallback preserves SDK and non-elevated-user ownership scoping during DB unavailability, SDK callers and non-elevated user callers do not fall back to active in-memory runtime sessions for explicit trace/export/generation lookups without persisted ownership proof, explicit close/delete cleanup uses the stored `runtimeSessionId`, and the separate `runtimeSessionId` lookup path is treated as a legacy/compatibility lane rather than the primary persisted-session model.
- Shared-auth ownership middleware now explicitly passes elevated users through without a persisted-session lookup so project-authorized admins can still reach runtime-only `:id` routes while SDK and non-admin callers remain ownership-gated.
- Current Runtime timeout behavior is transport fail-closed with focused cancellation-hardening proof: `/ws/sdk` sends `Request timed out`, closes the socket, propagates cooperative cancellation through the execution coordinator, LLM queue, and direct executor paths, and suppresses late response/persistence side effects after timeout. Broader browser/public-surface, deployment, and multi-pod proof is still open.
- The legacy control-plane `sdk_share` token route has already been converted into a hard `410 LEGACY_ROUTE_REMOVED` response, and there is no current Studio proxy token route for it. Docs and tests need to keep treating it as removed, not as a compatibility surface.

This document is the architecture reference for the implemented baseline plus the remaining rollout plan.

## Design Inputs

These are the design requirements locked in with the product/architecture direction:

| Input                           | Requirement                                                                                                                                                |
| ------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Tenant / project / channel auth | Every SDK session must be authenticated at tenant, project, and channel scope                                                                              |
| Optional identity               | End-user identity is optional, but if present it must be signed by the tenant or backed by another verified auth mechanism before it affects authorization |
| Anonymous auth                  | Anonymous SDK users must still support OAuth and auth-preflight                                                                                            |
| Anonymous scope                 | Anonymous auth results must be limited to the session scope rather than user scope                                                                         |
| One issuer path                 | Runtime-trusted `sdk_session` must follow one issuer path                                                                                                  |
| Breaking changes allowed        | The SDK is not customer-hosted yet, so contract cleanup is acceptable                                                                                      |
| Simplicity                      | `sdk.connect()` should move to the simplest robust contract, even if breaking                                                                              |
| Limits                          | Validation limits should be externalized to config/constants rather than hardcoded in route logic                                                          |

## Architecture Approach

### Packages That Change

| Package                | Why It Changes                                                                                                                               |
| ---------------------- | -------------------------------------------------------------------------------------------------------------------------------------------- |
| `apps/runtime`         | Becomes the sole Runtime-trusted `sdk_session` issuer and fixes the session/identity/auth-scope model                                        |
| `apps/studio`          | Stops signing Runtime bearer tokens directly and moves preview/share onto Runtime issuance                                                   |
| `packages/web-sdk`     | Fails closed on missing `endpoint`, changes `connect()` readiness semantics, and mirrors Runtime validation limits locally with parity tests |
| `packages/shared-auth` | Distinguishes session principal, verified identity, and anonymous session scope in shared auth/ownership logic                               |
| `packages/config`      | Hosts externalized SDK validation constants                                                                                                  |
| `packages/openapi`     | Gains a shared validation helper that composes with metadata without silently changing all route behavior                                    |
| `docs/`                | Documents target requirements, status, file inventory, and proof levels honestly                                                             |

### Core Principles

- **Defense in depth**: origin checks, hashed public keys, request-boundary validation, least-privilege permissions, and transport hygiene all stay in place together.
- **Explicit principals**: channel auth, verified identity, and session scope are separate concepts and must remain separate in code and tokens.
- **Stateless multi-pod design**: Runtime pods must not rely on pod-local memory as the source of truth for session-scoped auth artifacts.
- **Least privilege**: public key, preview/share artifact, and voice/chat permissions only narrow scope, never widen it.
- **Tenant / project / user isolation**: every lookup remains scoped to the right isolation level, and cross-scope behavior remains `404` where appropriate.
- **Truthful proof**: tests and docs must distinguish Runtime transport E2E from browser E2E and deployment validation.

### Principal Model

| Principal                   | Source                                               | Required | Purpose                                                               |
| --------------------------- | ---------------------------------------------------- | -------- | --------------------------------------------------------------------- |
| Channel auth principal      | Runtime-issued `sdk_session`                         | Yes      | Carries `tenantId`, `projectId`, `channelId`, and SDK permissions     |
| Session principal           | Runtime-generated unique session scope               | Yes      | Owns anonymous grants, attachments, and per-session auth artifacts    |
| Verified identity principal | Tenant-signed identity or other verified auth method | No       | Enables user-scoped continuity and user-scoped auth only when present |

### Auth Scope Model

| Caller Type                 | Allowed Auth Scope                                   | Notes                                                                                  |
| --------------------------- | ---------------------------------------------------- | -------------------------------------------------------------------------------------- |
| Anonymous SDK caller        | Session-scoped auth only                             | Can authenticate tools, but grants die with the session scope                          |
| Verified SDK caller         | Session-scoped auth plus user-scoped continuity/auth | Verified identity is explicit and cryptographically or otherwise authoritatively bound |
| Studio preview/share caller | Same Runtime-issued session contract as packaged SDK | Preview/share artifacts are bootstrap inputs, not parallel auth systems                |

### Target End-to-End Flows

#### Flow 1: Browser SDK Bootstrap and Connect

```text
Host App
  -> AgentSDK(config: endpoint, projectId, apiKey, optional verified identity)
  -> TokenManager POST /api/v1/sdk/init
       runtime validates:
         - public key / bootstrap artifact
         - tenant/project/channel resolution
         - origin and permission constraints
         - userContext limits
         - optional verified identity
       runtime issues sdk_session with:
         - tenant/project/channel scope
         - least-privilege permissions
         - session principal
         - auth scope (session or user)
         - optional verified identity
  -> SessionManager opens /ws/sdk with sdk-auth,<token>
  -> Runtime authenticates token, materializes/loads durable session
  -> Runtime sends session_start
  -> connect() resolves
  -> HTTP SDK routes use X-SDK-Token with the same session token
```

The authoritative success envelope for both `sdk/init` and `sdk/refresh` is:

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

#### Flow 2: Studio Preview / Share Target Flow

```text
Studio user
  -> POST /api/sdk/share or POST /api/sdk/preview-token
       Studio authenticates user and project access
       Studio resolves a real active SDK channel
         - prefer a valid widget-configured default channel when present
         - otherwise auto-resolve if exactly one active SDK channel exists
         - require explicit channelId only when multiple active SDK channels remain ambiguous
       Studio creates preview/share artifact only
       Studio does NOT sign sdk_session directly
  -> Browser preview page exchanges artifact through Runtime issuance path
       Runtime validates artifact + project/channel/widget constraints
       Runtime issues sdk_session
  -> Browser connects with sdk-auth,<sdk_session>
  -> Voice preview calls Runtime /api/livekit/token with X-SDK-Token
```

The public URL shape can remain Studio-friendly if Studio proxies Runtime issuance server-side, but the trusted issuer logic must live only in Runtime.
The current `/preview` browser surface scrubs the fragment after first load and may retain the same share artifact in `sessionStorage` only until a successful exchange clears it. That improves same-tab retry behavior without changing the initial URL transport contract.

#### Flow 3: Anonymous OAuth / Auth-Preflight

```text
Anonymous sdk_session
  -> Runtime/auth-profile route starts auth challenge
  -> Challenge state is stored against session principal
  -> User completes provider auth
  -> Runtime binds resulting grant to session principal only
  -> Subsequent tool calls from the same session may use the grant
  -> A different SDK session, even on the same channel, cannot reuse it
```

## Key Decisions and Tradeoffs

### Decision 1: Runtime is the Only Trusted `sdk_session` Issuer

**Chose** one Runtime-side issuer service **over** direct Studio signing **because** it restores a single trust boundary, makes revocation/rotation logic consistent, and prevents Studio auth bugs or secret exposure from becoming Runtime session-minting capability.

**Tradeoff:** Studio preview/share flows need a new exchange/proxy path and cannot keep signing tokens locally.

### Decision 2: Separate Channel Auth, Verified Identity, and Session Principal

**Chose** three explicit principals **over** reusing `userContext.userId` for everything **because** channel authorization, verified end-user identity, and anonymous session ownership are different trust domains. Collapsing them is what created the current security gaps.

**Tradeoff:** Shared auth and ownership code becomes more explicit, but that is desirable complexity rather than accidental complexity.

### Decision 3: Anonymous Auth Remains Supported but Session-Scoped

**Chose** session-scoped anonymous auth **over** disabling anonymous OAuth/preflight **because** the product requirement is to support anonymous SDK users, and the SDK itself is already authenticated at tenant/project/channel scope.

**Tradeoff:** Auth-profile storage and lookup must key off session principal, not a shared synthetic user.

### Decision 4: Fail Closed on Missing `endpoint`

**Chose** explicit endpoint requirement **over** defaulting to a hosted SaaS URL **because** silent fallbacks are operationally dangerous, especially for self-hosted, staging, and multi-environment deployments.

**Tradeoff:** This is a breaking SDK config change, but that is acceptable before customer hosting.

### Decision 5: `connect()` Resolves After `session_start`

**Chose** “session ready” semantics **over** “socket open” semantics **because** integrators should not need their own ready-state polling to safely send messages or start voice flows.

**Tradeoff:** This changes the package contract, but it is simpler and safer long term.

### Decision 6: Validation is Explicit and Boundary-Enforced

**Chose** a shared validation helper that composes with `withOpenAPI` **over** changing `withOpenAPI` to validate every route implicitly **because** `withOpenAPI` is already used as metadata only. A silent global behavior change would have a wide blast radius and make rollout harder to reason about.

**Tradeoff:** Route owners must opt into the helper, but the behavior is explicit and incremental.

### Decision 7: Limits Live in Config / Constants

**Chose** central constants **over** scattered inline numbers **because** Runtime bootstrap/token-normalization logic needs one authoritative source of truth, and shared-auth should consume already-normalized token state rather than inventing its own validation rules. The published browser SDK mirrors those limits locally and parity-tests them because it cannot safely depend on the private config package at runtime.

### Decision 8: Black-Box Tests Must Stay API / Browser First

**Chose** API and browser proof **over** direct DB setup/assertions or mocking platform code **because** the gaps we are fixing are cross-layer auth and contract issues, not isolated unit logic bugs.

## Required Data Contract Changes

### `sdk_session` Security Semantics

The exact TypeScript field names can be finalized during implementation, but the token must carry these semantics:

| Semantic            | Required Behavior                                                        | Notes                                                                                                                |
| ------------------- | ------------------------------------------------------------------------ | -------------------------------------------------------------------------------------------------------------------- |
| Channel scope       | `tenantId`, `projectId`, `channelId`, and permissions are always present | This is the primary authorization scope                                                                              |
| Session principal   | A unique session-scope identifier is always present                      | Used for anonymous ownership and session-scoped auth artifacts                                                       |
| Auth scope          | Token distinguishes session-scoped vs user-scoped grants                 | Anonymous callers must always be session-scoped                                                                      |
| Verified identity   | Optional verified identity is carried separately from `userContext`      | Only this identity can enable user-scoped behavior                                                                   |
| Bootstrap reference | Token can trace which bootstrap credential/artifact was used             | `bootstrapKeyId` is now carried for public-key sessions; preview/share artifact provenance still needs broader proof |
| `userContext`       | Treated as metadata only                                                 | Must not be the authorization source unless verified identity is present and explicitly mapped                       |
| HMAC envelope       | `hmac` is a 64-hex SHA-256 digest and `timestamp` is Unix seconds        | Freshness windows remain Runtime-only; browser/package validation mirrors shape, not age checks                      |

### Session Lifecycle Semantics

- Explicit SDK `end_session` is a stronger contract than channel disconnect. It must override the default `web_chat` detach behavior, end the Runtime session, and clear session-scoped auth artifacts.
- Passive disconnects still follow channel lifecycle config, which remains `detach` for `web_chat` unless the platform owner changes the channel defaults.
- The explicit-end override is intentionally localized to the connection state so multi-pod Runtime behavior stays stateless and driven by the shared session/auth stores.

### Initial Validation Constants (Implemented Defaults)

These values are implemented in `packages/config/src/constants.ts` and mirrored in the published browser SDK:

| Constant                                 | Implemented Default | Purpose                                                                                           |
| ---------------------------------------- | ------------------- | ------------------------------------------------------------------------------------------------- |
| `SDK_USER_CONTEXT_MAX_BYTES`             | `4096`              | Prevent oversized request bodies and oversized JWT/header payloads                                |
| `SDK_USER_CONTEXT_MAX_ATTRIBUTES`        | `32`                | Prevent unbounded custom attribute maps                                                           |
| `SDK_USER_CONTEXT_KEY_MAX_CHARS`         | `128`               | Keep keys small and predictable                                                                   |
| `SDK_USER_CONTEXT_STRING_MAX_CHARS`      | `512`               | Prevent extremely large individual values                                                         |
| `SDK_USER_CONTEXT_ARRAY_MAX_ITEMS`       | `16`                | Keep arrays bounded if arrays are allowed                                                         |
| `SDK_USER_CONTEXT_MAX_DEPTH`             | `2` (reserved)      | Reserved for future nested-object support; current implementation rejects nested objects outright |
| `SDK_USER_CONTEXT_HMAC_MAX_CHARS`        | `128`               | Guard the raw bootstrap envelope before exact digest-shape validation                             |
| `SDK_USER_CONTEXT_HMAC_HEX_CHARS`        | `64`                | Enforce the current SHA-256 digest shape for signed identity envelopes                            |
| `SDK_USER_CONTEXT_TIMESTAMP_MAX_SECONDS` | `9999999999`        | Keep `timestamp` in Unix-seconds space and reject millisecond-style envelope values               |

Recommended allowed value types:

- string
- number
- boolean
- null
- bounded arrays of primitive values

Disallowed by default:

- arbitrarily nested objects
- unbounded arrays
- binary/blob payloads

### Request Validation Approach

- Keep `packages/openapi/src/nextjs/with-openapi.ts` as metadata-only for backwards compatibility.
- Use a shared request validation helper in `packages/openapi/src/nextjs/validate-body.ts` that parses JSON bodies with Zod and returns deterministic `400` responses.
- Route owners opt in explicitly — no silent global behavior change.
- The Studio SDK preview/share routes now use this helper. Runtime Express routes still use inline validation because the helper is Next.js-specific.

**Helper API shape (implemented):**

```ts
// packages/openapi/src/nextjs/validate-body.ts
import { type ZodSchema } from 'zod';

interface JsonRequestLike {
  json(): Promise<unknown>;
}

export async function validateBody<T>(request: JsonRequestLike, schema: ZodSchema<T>) {
  let body: unknown;

  try {
    body = await request.json();
  } catch {
    return {
      success: false,
      response: new Response(
        JSON.stringify({
          success: false,
          errors: [{ code: 'VALIDATION_ERROR', msg: 'Invalid JSON body' }],
        }),
        { status: 400, headers: { 'Content-Type': 'application/json' } },
      ),
    };
  }

  const parsed = schema.safeParse(body);
  if (!parsed.success) {
    return {
      success: false,
      response: new Response(
        JSON.stringify({
          success: false,
          errors: parsed.error.issues.map((issue) => ({
            code: 'VALIDATION_ERROR',
            msg: issue.path.length ? `${issue.path.join('.')}: ${issue.message}` : issue.message,
          })),
        }),
        { status: 400, headers: { 'Content-Type': 'application/json' } },
      ),
    };
  }

  return { success: true, data: parsed.data };
}
```

For Express routes (Runtime), an equivalent Express middleware or inline helper follows the same pattern using `req.body` and returning `res.status(400).json(...)`.

- Use that helper first on:
  - `apps/studio/src/app/api/sdk/preview-token/route.ts`
  - `apps/studio/src/app/api/sdk/share/route.ts`
  - `apps/studio/src/app/api/sdk/share/exchange/route.ts`
- Runtime `apps/runtime/src/routes/sdk-init.ts` enforces equivalent validation inline (Express route).

## Detailed File Inventory

### Runtime Inventory

| File                                                                  | Current Branch State                                                                                                                                                                                                                                                                                                                                                              | Remaining Work                                                                            |
| --------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------- |
| `apps/runtime/src/routes/sdk-init.ts`                                 | Canonical Runtime issuer for public-key and Studio bootstrap flows                                                                                                                                                                                                                                                                                                                | Add explicit end-to-end verified-identity/HMAC proof and any future revocation tightening |
| `apps/runtime/src/services/identity/sdk-session-token.ts`             | Normalizes metadata-only `userContext` and emits explicit session principals                                                                                                                                                                                                                                                                                                      | Keep legacy compatibility and extend only if verified-identity formats expand             |
| `apps/runtime/src/services/identity/sdk-secret-config.ts`             | Enforces split signing secrets for Runtime `sdk_session` and Studio bootstrap artifact exchange                                                                                                                                                                                                                                                                                   | Keep dedicated non-test secrets and document rotation expectations                        |
| `apps/runtime/src/websocket/sdk-handler.ts`                           | Authenticates `/ws/sdk`, propagates `sessionPrincipal` / `verifiedUserId`, gates readiness on `session_start`, requires an explicit public Runtime base for SDK/browser-facing JIT OAuth callbacks, closes timed-out sockets, propagates cooperative cancellation through coordinator/queue/direct execution, and suppresses late response/persistence side effects after timeout | Add broader browser/public-surface plus deployment and multi-pod timeout proof            |
| `apps/runtime/src/services/oauth-callback-url.ts`                     | Normalizes explicit `RUNTIME_PUBLIC_BASE_URL` for SDK/browser-facing OAuth callbacks                                                                                                                                                                                                                                                                                              | Keep browser/public OAuth proof aligned                                                   |
| `apps/runtime/src/services/oauth-state-store-factory.ts`              | Selects Redis-backed OAuth callback state outside tests and permits in-memory state only in test mode                                                                                                                                                                                                                                                                             | Add deployment-level multi-pod/failover proof                                             |
| `apps/runtime/src/routes/chat.ts`                                     | Handles SDK chat HTTP flows with session/user principal separation                                                                                                                                                                                                                                                                                                                | Add public-API auth-preflight/OAuth proof                                                 |
| `apps/runtime/src/middleware/session-access.ts`                       | Shared project-scoped session authorization helper used by LiveKit, analytics, diagnostics, and other SDK-adjacent session routes                                                                                                                                                                                                                                                 | Keep ownership semantics aligned with shared-auth/session route proof                     |
| `apps/runtime/src/routes/sessions.ts`                                 | Session browsing/close/delete routes now fail closed for trace/export/generation authorization when project scope or session ownership cannot be verified and use the stored `runtimeSessionId` for executor/trace cleanup; distinct `runtimeSessionId` lookup remains a legacy/compatibility path                                                                                | Optional broader black-box proof beyond the targeted route suite                          |
| `apps/runtime/src/services/identity/stored-session-caller-context.ts` | Reconstructs persisted caller ownership context for shared-auth checks                                                                                                                                                                                                                                                                                                            | Keep legacy row normalization aligned with session-scope ownership rules                  |
| `apps/runtime/src/routes/livekit.ts`                                  | Issues voice-session material under SDK scope                                                                                                                                                                                                                                                                                                                                     | Add browser voice proof                                                                   |
| `apps/runtime/src/middleware/auth.ts`                                 | Parses `X-SDK-Token` and builds auth context with session principal semantics                                                                                                                                                                                                                                                                                                     | Keep aligned with SDK route coverage and auth-context contract                            |
| `apps/runtime/src/middleware/sdk-auth.ts`                             | Validates public-key bootstrap headers for Runtime issuance via helper-only resolution                                                                                                                                                                                                                                                                                            | None beyond proof/operational hardening                                                   |
| `apps/runtime/src/routes/sdk-channels.ts`                             | Project-scoped SDK channel control-plane route (create/list/update/delete)                                                                                                                                                                                                                                                                                                        | Keep project-scoped identity-policy API contract aligned with the exercised E2E coverage  |
| `apps/runtime/src/routes/tenant-sdk-channels.ts`                      | Tenant-scoped SDK channel control-plane listing/lookup route                                                                                                                                                                                                                                                                                                                      | Keep tenant/project isolation proof explicit in control-plane coverage                    |
| `apps/runtime/src/routes/sdk-channel-identity-utils.ts`               | Shared channel identity policy helpers for `hmacEnforcement` and secret handling                                                                                                                                                                                                                                                                                                  | Keep secret lifecycle behavior aligned with API-level tests                               |
| `apps/runtime/src/routes/sdk-public-keys.ts`                          | Project-scoped API key CRUD for SDK bootstrap credentials                                                                                                                                                                                                                                                                                                                         | None beyond keeping key/channel binding coverage aligned                                  |
| `apps/runtime/src/routes/sdk.ts`                                      | Public SDK config route                                                                                                                                                                                                                                                                                                                                                           | Minor alignment only; mostly unchanged                                                    |
| `apps/runtime/src/services/auth-profile/auth-preflight.ts`            | Stores auth-preflight state keyed to effective caller principal                                                                                                                                                                                                                                                                                                                   | Add black-box anonymous session-scope proof                                               |
| `apps/runtime/src/services/identity/artifact-hasher.ts`               | Derives caller/session ownership artifacts without trusting unsigned metadata                                                                                                                                                                                                                                                                                                     | None beyond proof coverage                                                                |
| `apps/runtime/src/repos/session-repo.ts`                              | Provides persisted-session lookup helpers, including legacy/compatibility `runtimeSessionId` resolution used by the session routes                                                                                                                                                                                                                                                | Keep route compatibility aligned with stored-session invariants                           |
| `apps/runtime/src/websocket/session-ownership.ts`                     | Enforces session ownership at Runtime WS layer                                                                                                                                                                                                                                                                                                                                    | None beyond proof coverage                                                                |

### Studio Inventory

| File                                                                | Current Branch State                                                                                                                                                                                                                       | Remaining Work                                          |
| ------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | ------------------------------------------------------- |
| `apps/studio/src/lib/studio-sdk-session.ts`                         | Bootstrap permission/TTL helper only; no direct Runtime bearer signing                                                                                                                                                                     | Keep as helper or rename for clarity                    |
| `apps/studio/src/lib/sdk-bootstrap-channel.ts`                      | Resolves the active SDK channel for preview/share/embed bootstrap by preferring a valid widget-configured default channel, then falling back from stale widget-configured channels to the single remaining active channel when unambiguous | Keep preview/share/embed channel binding explicit       |
| `apps/studio/src/lib/runtime-sdk-session.ts`                        | Exchanges preview/share bootstrap artifacts through Runtime                                                                                                                                                                                | None beyond operational hardening                       |
| `apps/studio/src/lib/sdk-project-access.ts`                         | Shared project-scoped SDK control-plane authorization helper; only project owner, allowed member, or `project:*` authority may bypass membership                                                                                           | Keep all Studio SDK routes converged on this helper     |
| `apps/studio/src/lib/sdk-runtime-channel-proxy.ts`                  | Shared Studio authz plus strict Runtime URL resolution for SDK channel proxy routes                                                                                                                                                        | Keep Runtime exchange routes fail-closed                |
| `apps/studio/src/lib/sdk-share-token.ts`                            | Signs/verifies share bootstrap artifacts                                                                                                                                                                                                   | Revisit only if artifact-secret rotation changes        |
| `apps/studio/src/app/api/sdk/preview-token/route.ts`                | Authenticated preview bootstrap API that exchanges through Runtime                                                                                                                                                                         | Keep API-level proof aligned with preview contract      |
| `apps/studio/src/app/api/sdk/share/route.ts`                        | Creates fragment-based share artifacts with boundary validation                                                                                                                                                                            | Maintain browser/API proof and active-channel binding   |
| `apps/studio/src/app/api/sdk/share/exchange/route.ts`               | Validates share artifacts and delegates final token issuance to Runtime                                                                                                                                                                    | Maintain browser/API proof                              |
| `apps/studio/src/app/api/runtime/sdk-channels/route.ts`             | Studio-authenticated Runtime SDK channel proxy list/create route; the current contract requires `projectId` in the query string                                                                                                            | Keep aligned with shared project access and concealment |
| `apps/studio/src/app/api/runtime/sdk-channels/[channelId]/route.ts` | Studio-authenticated Runtime SDK channel proxy detail/update/delete route via the tenant-scoped Runtime admin path with concealed `404` normalization                                                                                      | Keep aligned with shared project access and concealment |
| `apps/studio/src/app/api/sdk/keys/route.ts`                         | Lists and creates project-scoped SDK public keys under shared access rules                                                                                                                                                                 | Keep route authorization aligned with preview/share     |
| `apps/studio/src/app/api/sdk/keys/[keyId]/route.ts`                 | Revokes project-scoped SDK public keys under shared access rules                                                                                                                                                                           | Keep route authorization aligned with preview/share     |
| `apps/studio/src/app/api/sdk/embed/[projectId]/route.ts`            | Generates project-scoped embed snippets under shared access rules, fails closed when the widget has no usable capability, and uses same-origin fallback only for browser-consumed snippet output                                           | Keep route authorization aligned with preview/share     |
| `apps/studio/src/app/api/sdk/widget/[projectId]/route.ts`           | Reads and writes widget config under the shared SDK project access policy                                                                                                                                                                  | Keep aligned with the rest of the Studio SDK routes     |
| `apps/studio/src/app/api/livekit/token/route.ts`                    | Studio-authenticated Runtime LiveKit token proxy that now requires explicit Runtime URL                                                                                                                                                    | Add browser voice proof                                 |
| `apps/studio/src/app/api/livekit/capabilities/route.ts`             | Studio-authenticated Runtime LiveKit capability proxy that now requires explicit Runtime URL                                                                                                                                               | Add browser voice proof                                 |
| `apps/studio/src/app/preview/page.tsx`                              | Browser preview page using share exchange + Runtime-issued `sdk_session`, with UI readiness gated on `session_start` and tab-scoped share-artifact persistence cleared after successful exchange                                           | Keep browser E2E green                                  |
| `apps/studio/src/app/preview/[projectId]/page.tsx`                  | Project-scoped preview entry page that resolves Runtime-backed SDK config, optional `channelId`, and `session_start` readiness gating                                                                                                      | Keep preview contract aligned across both URL shapes    |
| `apps/studio/src/app/preview-livekit/page.tsx`                      | Browser voice preview page                                                                                                                                                                                                                 | Add browser voice E2E                                   |
| `apps/studio/src/__tests__/helpers/studio-api-harness.ts`           | Studio HTTP integration harness with real Runtime exchange path                                                                                                                                                                            | Keep API-only; no direct DB usage                       |
| `apps/studio/e2e/helpers/sdk-browser-stack.ts`                      | Self-started isolated Studio + Runtime + MongoMemory browser stack                                                                                                                                                                         | Optional CI adoption as a required lane                 |

### Browser SDK Inventory

| File                                                       | Current Branch State                                                                | Remaining Work                                          |
| ---------------------------------------------------------- | ----------------------------------------------------------------------------------- | ------------------------------------------------------- |
| `packages/web-sdk/src/core/types.ts`                       | Public config now requires `endpoint`; `userContext` remains metadata-shaped        | Keep examples/docs synchronized                         |
| `packages/web-sdk/src/core/endpoint.ts`                    | Fail-closed endpoint normalization for HTTP and WS                                  | None beyond broader docs/example cleanup                |
| `packages/web-sdk/src/core/TokenManager.ts`                | Performs `sdk/init` and `sdk/refresh` against explicit endpoint                     | Decide whether bootstrap retry/backoff becomes required |
| `packages/web-sdk/src/core/SessionManager.ts`              | Opens `/ws/sdk`, tracks session IDs, reconnects, and resolves after `session_start` | Maintain browser E2E coverage                           |
| `packages/web-sdk/src/core/AgentSDK.ts`                    | High-level SDK entry point with session-ready `connect()` contract                  | None beyond docs/examples                               |
| `packages/web-sdk/src/react/AgentProvider.tsx`             | React wrapper around SDK lifecycle                                                  | Keep config-change re-bootstrap proof aligned           |
| `packages/web-sdk/src/ui/ChatWidget.ts`                    | Chat widget bootstrap lifecycle                                                     | Keep config-change re-bootstrap proof aligned           |
| `packages/web-sdk/src/ui/UnifiedWidget.ts`                 | Unified widget bootstrap lifecycle                                                  | Keep config-change re-bootstrap proof aligned           |
| `packages/web-sdk/src/ui/VoiceWidget.ts`                   | Voice widget bootstrap lifecycle                                                    | Keep config-change re-bootstrap proof aligned           |
| `packages/web-sdk/src/chat/ChatClient.ts`                  | Chat send/upload client                                                             | Maintain browser E2E coverage                           |
| `packages/web-sdk/src/voice/VoiceClient.ts`                | Voice lifecycle client                                                              | Browser voice proof                                     |
| `packages/web-sdk/src/core/websocket-auth.ts`              | Builds `sdk-auth,<token>` protocol list                                             | No planned change                                       |
| `packages/web-sdk/src/core/sdk-user-context-validation.ts` | Browser-side `userContext` validation parity helper                                 | Keep parity tests aligned with Runtime constants        |

### Shared Auth / Config / Validation Inventory

| File                                                       | Current Branch State                                                                                                         | Remaining Work                                            |
| ---------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------- |
| `packages/shared-auth/src/middleware/session-ownership.ts` | Shared ownership checks distinguish session vs user scope and allow elevated-user pass-through for runtime-only `:id` routes | Add only more black-box proof                             |
| `packages/shared-auth/src/middleware/unified-auth.ts`      | Shared auth-context shaping carries session-principal / verified-identity semantics                                          | Add only more black-box proof                             |
| `packages/shared/src/sdk-bootstrap-artifact.ts`            | Shared preview/share bootstrap artifact signing and verification                                                             | Keep as the canonical artifact format                     |
| `packages/shared/src/sdk-widget-capabilities.ts`           | Shared browser/widget capability normalization for chat/voice surfaces                                                       | Keep preview and published SDK capability checks aligned  |
| `packages/config/src/constants.ts`                         | Shared platform constants now include SDK validation limits                                                                  | Add more SDK constants only if new contracts require them |
| `packages/openapi/src/nextjs/validate-body.ts`             | Explicit Next.js request validation helper                                                                                   | Broaden adoption only where route owners opt in           |
| `packages/openapi/src/nextjs/with-openapi.ts`              | Metadata wrapper only                                                                                                        | Remain metadata-only by design                            |

### Test Inventory

| File                                                                         | Current Branch State                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                        | Remaining Work                                                           |
| ---------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------ |
| `apps/runtime/src/__tests__/sdk-bootstrap-auth.integration.test.ts`          | Bootstrap, refresh, revocation, validation, verified HMAC bootstrap, and HTTP/refresh expiry proof                                                                                                                                                                                                                                                                                                                                                                                                                                                                                          | Broader verified-identity continuity/resume/auth proof                   |
| `apps/runtime/src/__tests__/channels-sdk-runtime.e2e.test.ts`                | Runtime transport E2E with Node SDK client                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                  | Add broader anonymous auth-preflight/OAuth public-API proof              |
| `apps/runtime/src/__tests__/channels-control-plane.e2e.test.ts`              | Runtime control-plane E2E for project-scoped SDK/public-key/channel-connection behavior plus HMAC identity-policy authoring and secret lifecycle proof                                                                                                                                                                                                                                                                                                                                                                                                                                      | Keep aligned with the shipped control-plane contract                     |
| `apps/runtime/src/__tests__/session-routes.test.ts`                          | Focused route-module proof for fail-closed trace/export/generation authorization, RuntimeExecutor-only session-list fallback scoping for SDK callers and non-elevated user callers during DB unavailability, SDK ownership enforcement on explicit collection-route session filters, denial of runtime-memory fallback for SDK callers and non-elevated user callers without persisted ownership proof, explicit close/delete cleanup using the stored `runtimeSessionId`, and legacy/compatibility alias handling for records that still differ between database id and `runtimeSessionId` | Keep aligned with any future session route contract changes              |
| `apps/runtime/src/__tests__/execution-coordinator.test.ts`                   | Coordinator-level proof that caller abort signals bridge into active coordinated executions and resolve as cancelled runs                                                                                                                                                                                                                                                                                                                                                                                                                                                                   | Add broader public-surface timeout proof                                 |
| `apps/runtime/src/__tests__/llm-queue-distributed.test.ts`                   | Queue/direct-executor proof for abort handling before local LLM execution starts. The executed suite currently forces Redis unavailable, so it does not separately execute the BullMQ worker path.                                                                                                                                                                                                                                                                                                                                                                                          | Add explicit distributed-worker and broader public-surface timeout proof |
| `apps/runtime/src/__tests__/ws-message-timeout.test.ts`                      | In-process handler-level Runtime `/ws/sdk` timeout proof for abort-signal propagation and suppression of late response/persistence side effects after timeout                                                                                                                                                                                                                                                                                                                                                                                                                               | Add browser/public-surface and multi-pod timeout proof                   |
| `apps/runtime/src/__tests__/middleware/session-access.test.ts`               | Helper-level proof for project-scoped session authorization, concealment semantics, and denial of session-scoped SDK callers against legacy channel-artifact-only session rows                                                                                                                                                                                                                                                                                                                                                                                                              | Keep aligned with shared-auth ownership semantics                        |
| `packages/shared-auth/src/__tests__/session-ownership.test.ts`               | Unit proof for session-principal ownership matching, denial of session-scope fallback to legacy channel-artifact rows, impossible-filter behavior for SDK callers without a stable identity, and elevated-user pass-through for runtime-only `:id` routes                                                                                                                                                                                                                                                                                                                                   | Keep aligned with auth-context and runtime-only route contract changes   |
| `apps/runtime/src/__tests__/integration/auth-preflight-multichannel.test.ts` | In-process proof for session-scoped auth-preflight gate behavior and consent-state suppression                                                                                                                                                                                                                                                                                                                                                                                                                                                                                              | Add browser/public-API OAuth round-trip proof                            |
| `apps/runtime/src/__tests__/ws-sdk-handler.test.ts`                          | Handler-level auth/session regression coverage, including explicit `end_session` cleanup override for default-detach channels                                                                                                                                                                                                                                                                                                                                                                                                                                                               | Maintain coverage as contract evolves                                    |
| `apps/studio/src/__tests__/sdk-preview-share-api.e2e.test.ts`                | API integration for preview/share authz, validation, Runtime exchange, outsider denial, same-tenant non-member denial, widget-configured default channel selection, Studio Runtime SDK channel proxy denial across list/create/detail/update/delete, fail-closed embed generation, and stale widget-configured channel fallback to the single remaining active SDK channel                                                                                                                                                                                                                  | Keep aligned with browser/share surface                                  |
| `apps/studio/src/__tests__/runtime-sdk-session.test.ts`                      | Mocked helper-contract proof for Studio->Runtime exchange scope validation                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                  | Keep aligned with Runtime claim semantics                                |
| `apps/studio/src/__tests__/sdk-widget-capabilities.test.ts`                  | Studio widget capability normalization/clamping for deploy/embed and preview surfaces                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                       | Keep browser and route surfaces capability-consistent                    |
| `packages/shared/src/__tests__/sdk-widget-capabilities.test.ts`              | Shared widget/browser capability normalization reused by Studio preview and web-sdk voice support                                                                                                                                                                                                                                                                                                                                                                                                                                                                                           | Keep shared capability policy as the single source of truth              |
| `apps/studio/src/__tests__/api-deployment-routes.test.ts`                    | Supporting Studio SDK control-plane regression coverage for keys, preview/share, embed, widget, and Runtime config fallback behavior                                                                                                                                                                                                                                                                                                                                                                                                                                                        | Keep aligned with current helper-based auth and validation               |
| `packages/web-sdk/src/__tests__/widget-streaming.test.ts`                    | Package unit coverage                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                       | Remains as supporting package coverage                                   |
| `packages/web-sdk/src/__tests__/rich-content-sdk.test.ts`                    | Package unit coverage                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                       | Remains as supporting package coverage                                   |
| `packages/web-sdk/src/__tests__/endpoint-config.test.ts`                     | Unit coverage for required endpoint semantics                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                               | Browser proof only                                                       |
| `packages/web-sdk/src/__tests__/session-manager-connect.test.ts`             | Unit coverage for `connect()` resolving after `session_start`                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                               | Browser proof only                                                       |
| `packages/web-sdk/src/__tests__/token-manager-contract.test.ts`              | Unit coverage for init/refresh scope-shape validation and refresh scope drift rejection                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                     | Keep aligned with Runtime response contract                              |
| `packages/web-sdk/src/__tests__/agent-provider-config.test.ts`               | Unit coverage for React/provider config re-bootstrap                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                        | None for the current package contract                                    |
| `packages/web-sdk/src/__tests__/widget-bootstrap-retry.test.ts`              | Unit coverage for widget re-bootstrap on tested `endpoint` / channel-attribute changes plus bootstrap-field pass-through                                                                                                                                                                                                                                                                                                                                                                                                                                                                    | None for the current package contract                                    |
| `packages/web-sdk/src/__tests__/token-manager-user-context.test.ts`          | Unit coverage for browser-side validation parity, HMAC envelope shape, and Unix-seconds timestamp bounds                                                                                                                                                                                                                                                                                                                                                                                                                                                                                    | None for the current package contract                                    |
| `apps/runtime/vitest.sdk-auth.config.ts`                                     | Serial Runtime proof lane for SDK auth/session coverage                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                     | Keep aligned with the canonical SDK suites                               |
| `apps/studio/e2e/sdk-widget.spec.ts`                                         | Passing via the isolated self-started browser stack for bootstrap/readiness and local send visibility, not assistant/model response completion                                                                                                                                                                                                                                                                                                                                                                                                                                              | Optional CI adoption                                                     |
| `apps/studio/e2e/sdk-preview-share.spec.ts`                                  | Passing via the isolated self-started browser stack for bootstrap/readiness, local send visibility, and mode-toggle continuity, not assistant/model response completion                                                                                                                                                                                                                                                                                                                                                                                                                     | Optional CI adoption                                                     |
| `apps/studio/e2e/helpers/sdk-browser-e2e.ts`                                 | Shared browser-E2E bootstrap and prerequisite checks                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                        | Keep as the canonical browser E2E setup path                             |
| `apps/studio/e2e/helpers/sdk-browser-env.ts`                                 | Isolated-vs-attached browser base URL selection for Runtime/Studio                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                          | Keep deterministic defaults and strict mode behavior aligned             |
| `apps/studio/e2e/helpers/sdk-browser-stack.ts`                               | Self-started isolated Studio + Runtime + MongoMemory browser harness                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                        | Keep deterministic and CI-friendly                                       |
| `apps/studio/public/sdk-browser-e2e-host.html`                               | Plain same-origin host page for widget browser E2E, outside React hydration                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                 | Keep stable and public-asset-safe through Studio proxy                   |
| `apps/studio/src/proxy.ts`                                                   | Studio auth/static-asset middleware and rewrite layer                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                       | Keep public file-extension assets out of auth redirects and SPA rewrites |

### Isolated Browser Stack Prerequisites and Prebuilt Artifacts

| Item                                                 | Purpose                                                       | Current State                                                    |
| ---------------------------------------------------- | ------------------------------------------------------------- | ---------------------------------------------------------------- |
| `apps/runtime/dist/index.js`                         | Runtime executable used by isolated browser stack harness     | Required and enforced by `sdk-browser-stack.ts` preflight checks |
| `apps/studio/.next/BUILD_ID`                         | Studio production build artifact for isolated Playwright lane | Required and enforced by `sdk-browser-stack.ts` preflight checks |
| `packages/web-sdk/dist/agent-sdk.umd.js`             | UMD bundle loaded by widget browser E2E                       | Required by `sdk-browser-e2e.ts` and `sdk-widget.spec.ts`        |
| `apps/studio/public/widget-test.html`                | Static host page used for local/manual widget verification    | Supporting artifact; not a primary proof lane artifact           |
| `SDK_BROWSER_E2E_STRICT`, `SDK_BROWSER_E2E_ISOLATED` | Controls strict prerequisite gating and isolated stack mode   | Implemented; isolated lane is passing locally but optional in CI |

### Attach-to-existing-services Browser Mode

- Uses the currently configured `STUDIO_URL` and `RUNTIME_URL` instead of the self-started isolated stack
- Requires a reachable Studio login page (`/auth/login`) and a healthy Runtime (`/health` returning `ok` or `healthy`)
- Requires Studio dev-login enabled plus writable Studio APIs used by the browser bootstrap helpers (`/api/projects`, `/api/sdk/keys`, `/api/runtime/sdk-channels`, `/api/sdk/share`, `/api/sdk/embed`)
- Creates real users/projects/keys/channels/share artifacts in the target environment and is not proof of persistent-state cleanup or cross-run order-independence

### Documentation Inventory

| File                                             | Purpose                                                |
| ------------------------------------------------ | ------------------------------------------------------ |
| `docs/features/sdk.md`                           | Feature requirements, scope, current-vs-target posture |
| `docs/testing/sdk.md`                            | Scenario-by-scenario test status and proof levels      |
| `docs/specs/sdk-auth-session-unification.hld.md` | This HLD and file inventory                            |
| `docs/specs/sdk-auth-session-unification.lld.md` | Low-level implementation inventory and rollout details |

## Test Plan

All new E2E work must follow the repo’s API-only/browser-only rules:

- no direct DB writes or DB assertions
- no mocks of existing platform code
- real Runtime and Studio servers
- only external dependencies may be stubbed, and only if platform interactions remain real

### Scenario Inventory and Remaining Work

| ID         | Scenario                                                                                                                  | Proof Level                                               | Likely File                                                                                                                                                  | Status   | Phase |
| ---------- | ------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------ | -------- | ----- |
| HOTFIX-01  | Share exchange enforces tenant-scoped project lookup (no tenant-less `findById` fallback) — audit C3                      | Integration                                               | `apps/studio/src/__tests__/sdk-preview-share-api.e2e.test.ts`                                                                                                | Complete | 0     |
| HOTFIX-02  | Share `POST` route uses `tenantId` (not `ownerId`) for project lookup — audit C4                                          | Integration                                               | `apps/studio/src/__tests__/sdk-preview-share-api.e2e.test.ts`                                                                                                | Complete | 0     |
| RUNTIME-01 | Verified identity enables user-scoped continuity; unsigned `userContext` does not                                         | Integration + Runtime transport E2E                       | `apps/runtime/src/__tests__/sdk-bootstrap-auth.integration.test.ts`, `apps/runtime/src/__tests__/channels-sdk-runtime.e2e.test.ts`                           | Partial  | 1     |
| RUNTIME-02 | Anonymous auth-preflight grants are session-scoped                                                                        | Integration + future Runtime transport E2E                | `apps/runtime/src/__tests__/integration/auth-preflight-multichannel.test.ts`, `apps/runtime/src/__tests__/sdk-auth-preflight-scope.e2e.test.ts`              | Partial  | 1     |
| RUNTIME-06 | Control-plane exposes stable project-scoped API(s) to configure SDK channel HMAC identity policy                          | Integration                                               | `apps/runtime/src/__tests__/channels-control-plane.e2e.test.ts`, `apps/runtime/src/routes/sdk-channels.ts`, `apps/runtime/src/routes/tenant-sdk-channels.ts` | Complete | 1     |
| RUNTIME-03 | `sdk/init` rejects oversized or malformed `userContext` with deterministic `400`                                          | Integration                                               | `apps/runtime/src/__tests__/sdk-bootstrap-auth.integration.test.ts`                                                                                          | Complete | 4     |
| RUNTIME-04 | Expired `sdk_session` token is rejected on HTTP SDK routes (chat, sessions, attachments)                                  | Integration                                               | `apps/runtime/src/__tests__/sdk-bootstrap-auth.integration.test.ts`                                                                                          | Complete | 1     |
| RUNTIME-05 | Expired `sdk_session` token on refresh returns 401 with re-init directive                                                 | Integration                                               | `apps/runtime/src/__tests__/sdk-bootstrap-auth.integration.test.ts`                                                                                          | Complete | 1     |
| STUDIO-01  | Authenticated outsider is denied preview/share access to another project                                                  | Integration                                               | `apps/studio/src/__tests__/sdk-preview-share-api.e2e.test.ts`                                                                                                | Complete | 5     |
| STUDIO-02  | Preview/share malformed inputs return `400` validation failures                                                           | Integration                                               | `apps/studio/src/__tests__/sdk-preview-share-api.e2e.test.ts`                                                                                                | Complete | 4     |
| PACKAGE-01 | Missing `endpoint` throws/fails closed                                                                                    | Unit                                                      | `packages/web-sdk/src/__tests__/endpoint-config.test.ts`                                                                                                     | Complete | 3     |
| PACKAGE-02 | `connect()` resolves only after `session_start`                                                                           | Unit + Runtime transport E2E                              | `packages/web-sdk/src/__tests__/session-manager-connect.test.ts`, `apps/runtime/src/__tests__/channels-sdk-runtime.e2e.test.ts`                              | Complete | 3     |
| BROWSER-01 | Widget chat flow works in a real browser against live Runtime                                                             | Browser E2E                                               | `apps/studio/e2e/sdk-widget.spec.ts`, `apps/studio/e2e/helpers/sdk-browser-stack.ts`                                                                         | Complete | 5     |
| BROWSER-02 | Preview surfaces (share-link preview and authenticated project preview) work in a real browser with the final issuer flow | Browser E2E                                               | `apps/studio/e2e/sdk-preview-share.spec.ts`, `apps/studio/e2e/helpers/sdk-browser-stack.ts`                                                                  | Complete | 5     |
| VOICE-01   | Browser voice/LiveKit flow works end to end                                                                               | Browser E2E                                               | New Studio browser voice spec                                                                                                                                | Open     | 6     |
| OPS-01     | Ingress/logging layers redact `Sec-WebSocket-Protocol` and `X-SDK-Token`                                                  | Deployment verification                                   | Runbook / deployed validation                                                                                                                                | Open     | 6     |
| OPS-02     | Session/auth behavior remains correct across multi-pod/failover                                                           | Deployment verification or dedicated shared-state harness | New harness or staging validation                                                                                                                            | Open     | 6     |

## Migration Phases and Exit Criteria

### Phase 0: Hotfix Cross-Tenant Share Exchange Isolation (C3, C4) — Completed on This Branch

**Depends on:** Nothing — this is an immediate hotfix.
**Rollback:** Revert the hotfix commit. The vulnerable code path is restored, but no new data structures are introduced.

Scope:

- Add `tenantId` scoping to `Project.findById` in the share exchange legacy fallback (C3)
- Replace `ownerId` with `tenantId` for project lookup in the share `POST` route (C4)
- Add integration tests proving cross-tenant share resolution is blocked

Exit criteria:

- Share exchange queries always include `tenantId` — no tenant-less `findById` path remains
- Share `POST` route uses `tenantId` (not `ownerId`) for project lookup
- Integration tests (T-015a, T-015b) pass for cross-tenant denial
- Existing share flows for same-tenant callers remain functional

### Phase 1: Fix Runtime Identity Model — Largely Implemented

**Depends on:** Phase 0 (hotfix should land first so the most exploitable paths are closed).
**Rollback:** Revert to the pre-phase-1 session token issuance. Anonymous callers revert to the current shared-scope behavior. No data migration is needed — there are no existing anonymous auth-preflight grants persisted in storage, so the new session-principal keying is a clean start.

Scope:

- session principal becomes explicit
- unsigned `userContext` loses auth/ownership authority
- anonymous auth-preflight becomes session-scoped

**Auth-preflight storage note:** There are no existing persisted anonymous auth-preflight grants to migrate. The new session-principal keying is a clean deployment with no migration step required.

Exit criteria:

- Runtime tests prove verified identity vs unsigned metadata separation
- anonymous auth grants cannot cross session boundaries

### Phase 2: Move Preview / Share to Runtime Issuance — Implemented

**Depends on:** Phase 1 (the Runtime issuer must understand the new session-principal and verified-identity semantics before preview/share tokens are routed through it).
**Rollback:** Reverting this phase would require reintroducing direct Studio signing of Runtime-trusted bearer tokens, which is intentionally not recommended. Safe rollback should preserve Runtime as the final issuer boundary.

Scope:

- Studio stops signing Runtime bearer tokens directly
- preview/share delegate final `sdk_session` issuance to Runtime

Exit criteria:

- `apps/studio/src/lib/studio-sdk-session.ts` remains bootstrap-artifact-only and is not a Runtime bearer issuer
- preview/share tests and route wiring prove delegation through the Runtime exchange path; independent signer-boundary proof across separated trust domains remains an operational gap
- Audit findings C3 and C4 remain resolved via tenant-scoped lookups and removal of owner-based fallback behavior in live share flows

### Phase 3: Clean Up Browser SDK Contract — Implemented

**Depends on:** Phase 1 (the session-ready semantics depend on the new session principal model). Independent of Phase 2 — can run in parallel with Phase 2 if needed.
**Rollback:** Revert the browser SDK package changes. Internal consumers revert to the previous `connect()` semantics and optional `endpoint`. No server-side state is affected.

Scope:

- `endpoint` becomes required
- `connect()` resolves after `session_start`

Exit criteria:

- package tests and Runtime transport tests pass for the new contract
- examples and docs are updated

### Phase 4: Add Validation and Limits — Implemented

**Depends on:** Phase 1 (validation constants interact with the identity model, e.g., `userContext` limits apply to the new metadata-only semantics). Independent of Phase 2 and Phase 3.
**Rollback:** Remove the validation helper opt-in from affected routes. Routes revert to pre-validation behavior. Constants remain in `packages/config` (harmless).

Scope:

- authoritative Runtime/shared-auth SDK limits/constants plus browser SDK parity tests
- request-boundary validation helper
- preview/share and Runtime bootstrap validation coverage

Exit criteria:

- malformed inputs return deterministic `400`s
- oversized `userContext` is rejected consistently

### Phase 5: Add Browser and Authz Black-Box Proof — Implemented on This Branch

**Depends on:** Phases 1–4 (tests should prove the final implemented behavior, not intermediate states).
**Rollback:** Not applicable — this phase adds tests only, no production code changes.

Scope:

- widget browser E2E
- preview/share browser E2E
- authenticated-outsider Studio authz coverage

Exit criteria:

- browser and authz scenarios are green without DB access or platform mocks

### Phase 6: Operational Proof — Open

**Depends on:** Phase 5 (browser proof is now green; operational readiness still requires voice/redaction/failover proof).
**Rollback:** Not applicable — this phase adds deployment verification, no production code changes.

Scope:

- voice/browser E2E
- deployed ingress/log redaction verification
- multi-pod/failover confidence

Exit criteria:

- docs can honestly claim operational readiness rather than Runtime-only transport readiness

## Risks and Mitigations

| Risk                                                                   | Mitigation                                                                                                                                   |
| ---------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------- |
| C3/C4 cross-tenant share exchange is exploitable before Phase 2 lands  | Phase 0 hotfix patches the queries immediately; Phase 2 replaces the entire path. Even on Phase 2 rollback, the Phase 0 fix remains in place |
| Breaking browser SDK changes can disrupt existing internal consumers   | Make the contract change explicit in docs and examples before rollout; breaking changes are acceptable now                                   |
| Bearer tokens still have bounded replay risk                           | Keep TTL short, keep transport off URLs, and revisit immediate invalidation only if product/security requirements demand it                  |
| Preview/share migration can break Studio flows                         | Preserve share-artifact semantics while keeping Runtime as final issuer; avoid rollback patterns that reintroduce Studio bearer signing      |
| Session-scoped auth can accidentally drift into pod-local state        | Require shared storage for auth-preflight and session-bound artifacts                                                                        |
| Validation rollout could change behavior on existing malformed clients | Return deterministic `400` errors and document the contract clearly                                                                          |

## Out of Scope

- Historical customer-signed JWT/JWE work captured in `docs/plans/2026-03-14-web-sdk-jwt-jwe-auth.md`
- Removing non-SDK `?token=` flows for other channels in this HLD
- Immediate invalidation of already-issued SDK bearer tokens unless that becomes a hard requirement later

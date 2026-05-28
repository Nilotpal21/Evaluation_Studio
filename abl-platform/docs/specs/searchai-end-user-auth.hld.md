# SearchAI End-User Authentication — High-Level Design

## What

Enable **direct end-user access** to SearchAI's `/query` API with identity-based
document-level access control (RACL). Today, only platform users (admins/developers)
with API keys can call `/query`. End-users accessing SearchAI from customer-facing
apps receive only public documents because there's no way to authenticate them.

This feature adds:

1. **Project-level admin toggle** — admins enable public API scopes per project
2. **Auth endpoint** — `POST /api/search/auth/token` for IdP token → search session exchange
3. **Auth-profile-driven IdP validation** — reuses existing auth profiles (`oauth2_app`,
   `azure_ad`) to validate incoming end-user tokens. Supports any OIDC provider.
4. **Search session token** — short-lived JWT (configurable, default 15 min) scoped to
   **projectId** (works across all indexes in the project) — issued after IdP validation.
   Discriminated with `type: 'search_session'`, `iss: 'abl:search-runtime'`, `aud: 'abl:search-query'`.
5. **Shared IdP validation** — move IdP token validation to `packages/shared-auth/idp/`
   so all services (search-ai-runtime, Studio, Runtime) can reuse it
6. **No API key required for end-users** — `indexId` in URL resolves tenant/project.
   IdP token cryptographic validation is the security gate.
7. **Contact card creation** — platform invariant: `identityTier >= 2 → create Contact`.
   IdP-validated users are Tier 2. Contact card is created/found after successful validation.

## Architecture Approach

### Design Principle: Single Authentication Layer

End-users do NOT need an API key. For end-user paths:

- **`indexId` (from URL)** → resolves `tenantId` + `projectId` via SearchIndex lookup
- **IdP token (from header)** → authenticates the user via auth profile OIDC config
- **No API key needed** — indexId identifies the project, IdP token proves identity

Why this is secure (6-layer defense):

1. **IdP signature** — token must be signed by the trusted provider's private key
2. **Issuer match** — `iss` must match auth profile's configured issuer
3. **Audience match** — `aud` must match auth profile's `clientId`
4. **Domain restriction** — user's email domain must be in `allowedDomains`
5. **Rate limiting** — per-user + per-project aggregate limits
6. **RACL filter** — user only sees documents they have permission to access

Same model as Firebase, Algolia, Stripe — public identifiers for routing,
cryptographic tokens for security.

### Packages Changed

| Package                  | Change                                                                                                                         |
| ------------------------ | ------------------------------------------------------------------------------------------------------------------------------ |
| `packages/shared-auth`   | New: `IdPTokenValidator` (moved from search-ai-runtime) in `idp/` entry point, `SearchSessionToken` issuer/verifier            |
| `packages/database`      | Add `publicApiAccess` field to `IProjectSettings` model (scope-based for future extensibility)                                 |
| `apps/search-ai-runtime` | New: end-user auth middleware, `/api/search/auth/token` route, dynamic CORS, end-user rate limiting, updated permission filter |
| `apps/studio`            | New: Project Settings UI for enabling public API access scopes + auth profile picker                                           |

### Data Model: `publicApiAccess` on ProjectSettings

Scope-based design supports future scopes (files.upload, chat.execute) without schema changes:

```typescript
interface IPublicApiAccessSettings {
  /** Per-scope access control — extensible for future APIs */
  scopes: {
    /** Enable end-user search query access */
    'search.query'?: {
      enabled: boolean;
      /** References AuthProfile._id (must be oauth2_app or azure_ad type) */
      authProfileId: string;
      /** Restrict end-user email domains (e.g., ["acme.com", "contoso.com"]).
       *  Empty array = allow all domains. */
      allowedDomains: string[];
      /** CORS origins for browser-based access.
       *  E.g., ["https://portal.acme.com", "https://search.acme.com"] */
      allowedOrigins: string[];
      /** Search session token TTL in seconds (default: 900 = 15 min) */
      sessionTokenTtlSeconds: number;
      /** Rate limits for end-user paths */
      rateLimits: {
        /** Per authenticated user per minute (default: 60) */
        perUserPerMinute: number;
        /** Aggregate per project per minute (default: 1000) */
        perProjectPerMinute: number;
      };
    };
    // Future: 'files.upload'?, 'chat.execute'?
  };
}
```

### Data Flow

```
┌─────────────────────────────────────────────────────────────────────┐
│  ADMIN SETUP (one-time in Studio)                                   │
│                                                                     │
│  1. Admin already has auth profile "Acme Azure AD" (oauth2_app)     │
│     → has authorizationUrl, tokenUrl, clientId, clientSecret        │
│                                                                     │
│  2. Admin → Project Settings → "Public API Access"                  │
│     → Scope: search.query → Toggle: ON                              │
│     → Auth Profile: "Acme Azure AD" (dropdown of OIDC profiles)    │
│     → Allowed Domains: ["acme.com"]                                 │
│     → Allowed Origins: ["https://portal.acme.com"]                  │
│     → Save                                                          │
└─────────────────────────────────────────────────────────────────────┘

┌─────────────────────────────────────────────────────────────────────┐
│  PATH A: TOKEN EXCHANGE  (user's app already has IdP token)         │
│                                                                     │
│  End-User App                    SearchAI Runtime                   │
│  ───────────                     ───────────────                    │
│  1. User logs into customer      2. POST /api/search/auth/token     │
│     app via Azure AD/Okta/etc.      Headers:                       │
│     → receives IdP JWT               X-End-User-Token: {idpJWT}    │
│                                       X-Index-Id: {indexId}         │
│                                                                     │
│  3. SearchAI validates:                                             │
│     a. indexId → SearchIndex → tenantId, projectId                  │
│     b. ProjectSettings.publicApiAccess.scopes['search.query'].enabled?
│     c. allowedDomains check → user's domain must be in list         │
│     d. Load auth profile → OIDC config (issuer, clientId)           │
│     e. Validate IdP token (signature, issuer, audience, expiry)     │
│     f. Extract email, groups, domain from token claims              │
│     g. Create/resolve Contact card (identityTier=2, provider-verified)
│                                                                     │
│  4. Issue search session token (project-scoped):                    │
│     JWT {                                                           │
│       type: 'search_session',                                       │
│       iss: 'abl:search-runtime',                                    │
│       aud: 'abl:search-query',                                      │
│       sub: email,                                                   │
│       projectId, tenantId, domain, groups,                          │
│       contactId,                                                    │
│       exp: now + sessionTokenTtlSeconds                             │
│     }                                                               │
│     (works across ALL indexes in the project)                       │
│                                                                     │
│  5. Subsequent /query calls (NO API key needed):                    │
│     X-Auth-Mode: user                                               │
│     X-Search-Session-Token: {searchSessionJWT}                      │
│     → Verify indexId belongs to token's projectId                   │
│     → Permission filter builds 4-clause RACL filter                 │
└─────────────────────────────────────────────────────────────────────┘

┌─────────────────────────────────────────────────────────────────────┐
│  PATH C: RAW IdP TOKEN on /query (direct, per-request)              │
│                                                                     │
│  POST /api/search/{indexId}/query                                   │
│  X-Auth-Mode: user                                                  │
│  X-End-User-Token: {rawIdPJWT}                                      │
│  (no Authorization header — no API key)                             │
│                                                                     │
│  → indexId → tenantId, projectId                                    │
│  → ProjectSettings.publicApiAccess.scopes['search.query'].enabled?  │
│  → allowedDomains check                                             │
│  → Validate IdP token against auth profile OIDC config              │
│  → Create/resolve Contact card                                      │
│  → Build RACL filter from extracted identity                        │
│  → Execute query                                                    │
└─────────────────────────────────────────────────────────────────────┘

┌─────────────────────────────────────────────────────────────────────┐
│  PATH D: API KEY + user mode (existing, backward-compatible)        │
│                                                                     │
│  Authorization: Bearer {apiKey}                                     │
│  X-Auth-Mode: user                                                  │
│  X-End-User-Token: {rawIdPJWT}                                      │
│  → Existing API key auth → tenantId                                 │
│  → Existing IdP validator validates token                           │
│  → RACL filter applied (unchanged behavior)                         │
└─────────────────────────────────────────────────────────────────────┘
```

### Authentication Path Decision Logic

```
Incoming request to /api/search/:indexId/query
│
├─ Has Authorization header (Bearer apiKey/jwt)?
│  └─ YES → Existing auth middleware (API key or platform JWT)
│          ├─ X-Auth-Mode: user + X-End-User-Token? → PATH D (existing)
│          └─ No X-Auth-Mode? → public mode (existing)
│
└─ NO Authorization header?
   ├─ X-Auth-Mode: user?
   │  └─ YES → NEW end-user auth path
   │          ├─ indexId → SearchIndex → tenantId, projectId
   │          ├─ ProjectSettings.publicApiAccess.scopes['search.query'].enabled?
   │          │  └─ NO → 403 "End-user search access not enabled"
   │          ├─ X-Search-Session-Token present?
   │          │  └─ YES → Validate session JWT locally
   │          │          → Verify type='search_session', iss, aud
   │          │          → Verify indexId belongs to token's projectId
   │          │          → RACL filter from token claims
   │          ├─ X-End-User-Token present?
   │          │  └─ YES → Validate IdP token via auth profile OIDC
   │          │          → allowedDomains check
   │          │          → Create/resolve Contact card
   │          │          → RACL filter from extracted identity
   │          └─ Neither token? → 401 "Authentication required"
   │
   └─ NO X-Auth-Mode? → 401 "Authentication required"
```

### Middleware Chain for End-User Requests

The query router's middleware chain is modified to support both paths:

```
Query Router middleware chain:
│
├─ 1. endUserAuthMiddleware (NEW — runs first)
│     ├─ Checks: no Authorization header + X-Auth-Mode: user?
│     │  └─ YES → Resolves tenant from indexId, validates tokens,
│     │           sets req.tenantContext + req.authMode + req.userIdentity
│     │           → calls next() (skips authMiddleware via guard)
│     │  └─ NO → passes through (does nothing, lets authMiddleware run)
│     └─ On failure: returns 401/403 error response
│
├─ 2. authMiddleware (existing — guarded: skips if req.tenantContext already set)
│     └─ API key / JWT → req.tenantContext
│
├─ 3. verifyIndexOwnership (existing — works with either path's tenantContext)
│
├─ 4. permissionFilterMiddleware (existing + enhanced)
│     ├─ Reads req.authMode and req.userIdentity (set by either path)
│     └─ Builds appropriate RACL filter
│
└─ 5. Query handler
```

### CORS for Browser Access

End-user requests from browsers (Paths A & C) need CORS support. The
`publicApiAccess.scopes['search.query'].allowedOrigins` config drives dynamic per-project CORS:

- **Static CORS** (existing): Platform origins from config
- **Dynamic CORS** (new): For `/api/search/auth/*` and `/api/search/:indexId/query`
  when `X-Auth-Mode: user`, check `Origin` header against project's `allowedOrigins`
- Implemented as early middleware before auth — OPTIONS preflight must not require auth
- This is an established platform pattern: `apps/runtime/src/middleware/sdk-auth.ts:114`
  already does per-request DB-based origin checks for SDK keys.

### Rate Limiting for End-User Paths

Two-layer rate limiting keyed differently from the existing API key limiter:

| Layer       | Key                         | Default Limit | Purpose                    |
| ----------- | --------------------------- | ------------- | -------------------------- |
| Per-user    | `eu:{tenantId}:{email}`     | 60 req/min    | Prevent single user abuse  |
| Per-project | `eu:{tenantId}:{projectId}` | 1000 req/min  | Prevent project-level DDoS |

Configurable via `publicApiAccess.scopes['search.query'].rateLimits`. Applied after
identity extraction.

### OIDC Discovery

The shared IdP validator resolves JWKS URI via standard OIDC discovery:

1. Derive discovery URL from auth profile's `tokenUrl` domain:
   `https://{domain}/.well-known/openid-configuration`
2. Fetch and cache discovery document (1 hour TTL in Redis)
3. Extract `jwks_uri`, `issuer`, `token_endpoint` from discovery
4. Fall back to hardcoded patterns for Azure AD/Okta/Google (backward compat)

### Contact Card Creation

**Platform invariant**: `identityTier >= 2 → create Contact`. IdP-validated users are Tier 2
(verification via trusted external provider).

After successful IdP token validation:

1. Search for existing Contact by `{ tenantId, email }`
2. If not found → create Contact with: `{ tenantId, email, name, identityTier: 2, source: 'search_public_api', idpProvider }`
3. Include `contactId` in the search session token for downstream use
4. Contact enables future cross-session analytics and personalization

### Search Session Token

Discriminated JWT format prevents token confusion attacks:

```typescript
interface SearchSessionTokenPayload {
  type: 'search_session'; // Discriminator — distinct from 'sdk_session', 'access'
  iss: 'abl:search-runtime'; // Issuer — rejects tokens from other services
  aud: 'abl:search-query'; // Audience — rejects tokens meant for other purposes
  sub: string; // User email (lowercase)
  tenantId: string;
  projectId: string;
  domain: string; // Email domain
  groups?: string[]; // Group memberships from IdP
  contactId?: string; // Platform Contact ID
  idpProvider: string; // Which IdP validated the user
  iat: number;
  exp: number;
}
```

### Audit Logging

All end-user auth events emit audit trail entries:

| Event                    | Data Logged                                        |
| ------------------------ | -------------------------------------------------- |
| Token exchange           | tenantId, projectId, email, provider, success/fail |
| Query with session token | tenantId, projectId, indexId, email                |
| Query with raw IdP token | tenantId, projectId, indexId, email, provider      |

### IdP Token Passing: Headers Only

All tokens are passed **exclusively via HTTP headers**. Request body is reserved
for search parameters (query, filters, topK, etc.).

| Header                   | Purpose                                         |
| ------------------------ | ----------------------------------------------- |
| `X-Auth-Mode`            | `"user"` to activate end-user auth path         |
| `X-End-User-Token`       | Raw IdP JWT (Azure AD, Okta, any OIDC provider) |
| `X-Search-Session-Token` | Search session JWT (issued by auth endpoint)    |
| `X-Index-Id`             | Index ID for `/auth/token` endpoint             |

### Key Integration Points

1. **ProjectSettings ↔ AuthProfile**: `publicApiAccess.scopes['search.query'].authProfileId`
   references an AuthProfile document. The auth profile stores IdP config (issuer, clientId,
   audience, tokenUrl, authorizationUrl, scopes). Reuses existing auth profiles already
   created for connectors/tools.

2. **Permission Filter Middleware**: Extended to accept `X-Search-Session-Token`.
   Session tokens validated locally (shared JWT secret) — no IdP round-trip.

3. **Shared IdP Validator**: `packages/shared-auth/idp/` — separate entry point.
   `jwks-rsa` as dependency of shared-auth (correct per CLAUDE.md: "auth packages
   own JWT verification"). All services import from `@agent-platform/shared-auth/idp`.

4. **Auth Profile Types**: Existing `oauth2_app` and `azure_ad` types store the
   OIDC config needed. Same auth profile can be used for both connector crawling
   AND end-user authentication.

5. **Session Token**: Scoped to `projectId` (not indexId). User authenticates
   once per project, can query any index within that project. Per-query validation
   checks `indexId` belongs to the token's `projectId`.

6. **Contact Card**: Created on first successful IdP validation per email per tenant.
   Platform invariant preserved. Contact used for cross-session identity correlation.

7. **`verifyIndexOwnership` middleware**: Already reads `req.tenantContext.tenantId`
   (line 26) — works unchanged with both auth paths since `endUserAuthMiddleware`
   sets the same `req.tenantContext` shape.

## Decisions & Tradeoffs

| #   | Decision               | Chose                                            | Over                  | Reason                                                                                                                        |
| --- | ---------------------- | ------------------------------------------------ | --------------------- | ----------------------------------------------------------------------------------------------------------------------------- |
| 1   | Admin gate             | Scope-based `publicApiAccess` on ProjectSettings | Simple boolean toggle | Extensible — future scopes (files.upload) don't require schema changes                                                        |
| 2   | End-user auth          | No API key — indexId + IdP token                 | API key + IdP token   | API keys are for machines. indexId resolves tenant; IdP token is security.                                                    |
| 3   | Token validation       | Auth-profile-driven OIDC                         | Hardcoded providers   | Supports any OIDC provider via existing auth profiles.                                                                        |
| 4   | Session token scope    | projectId                                        | indexId               | User searches multiple KBs in one project. Authenticate once per project.                                                     |
| 5   | Session token TTL      | 15 min default, configurable                     | Fixed TTL             | Balance between security (short expiry) and UX (no re-auth every minute).                                                     |
| 6   | Token revocation       | TTL-based (15 min max exposure)                  | Redis deny-list       | Standard JWT practice. Disable toggle = immediate reject for new requests; in-flight tokens expire within TTL. Accepted risk. |
| 7   | IdP validator location | `packages/shared-auth/idp/`                      | Separate package      | Correct package boundary — auth packages own JWT verification.                                                                |
| 8   | Token discriminators   | `type`, `iss`, `aud` in session token            | Plain JWT             | Prevents token confusion attacks across services.                                                                             |
| 9   | Token delivery         | JSON response with `{ token, expiresIn }`        | URL fragment          | Simpler client integration. OAuth redirect flow (Path B) deferred.                                                            |
| 10  | Token headers          | All tokens via HTTP headers only                 | Body or mixed         | Body reserved for search parameters.                                                                                          |
| 11  | Backward compat        | PATH D preserved                                 | Breaking change       | Existing API key + X-End-User-Token integrations unchanged.                                                                   |
| 12  | Contact creation       | Mandatory (platform invariant)                   | Optional/deferred     | `identityTier >= 2 → create Contact`. IdP-validated = Tier 2. Not optional.                                                   |
| 13  | Data model naming      | `publicApiAccess` with scope objects             | `endUserAuth`         | Extensible for future public API scopes without renaming.                                                                     |
| 14  | Middleware ordering    | endUserAuth first, authMiddleware guarded        | Conditional bypass    | Clean separation — endUserAuth handles its path, authMiddleware handles existing paths.                                       |

## Task Decomposition

| Task | Package(s)               | Independent?       | Est. Files | Description                                                                                        |
| ---- | ------------------------ | ------------------ | ---------- | -------------------------------------------------------------------------------------------------- |
| T-1  | `packages/shared-auth`   | Yes                | 5-6        | Move IdP validator to `shared-auth/idp/`, add OIDC discovery, auth-profile-aware validation        |
| T-2  | `packages/shared-auth`   | Yes                | 2-3        | Search session token issuer/verifier (project-scoped, discriminated JWT)                           |
| T-3  | `packages/database`      | Yes                | 2-3        | Add `publicApiAccess` field to ProjectSettings (scope-based schema + interface)                    |
| T-4  | `apps/search-ai-runtime` | No (T-1, T-2, T-3) | 8-10       | End-user auth middleware, auth/token route, dynamic CORS, end-user rate limiting, contact creation |
| T-5  | `apps/studio`            | No (T-3)           | 3-4        | Project Settings UI: scope toggles + auth profile picker + domain/origin config                    |
| T-6  | Integration + E2E        | No (T-4)           | 3-4        | E2E tests for Paths A, C, D                                                                        |

## Out of Scope

- **OAuth redirect flow (Path B)** — complex PKCE + callback requires additional security review. Deferred to v2.
- **Runtime → SearchAI identity bridging** — separate feature (Internal Trusted Identity Assertion)
- **User-specific query analytics** — recording which end-user queried what. Future.
- **Token refresh endpoint** — clients re-authenticate when session token expires. Refresh flow deferred.
- **Auth profile creation UI** — already exists in Studio. This feature only adds the project settings toggle.
- **End-user access to other endpoints** (suggest, browse, similar) — start with `/query` only, extend later.
- **Immediate token revocation** — TTL-based revocation is accepted risk. Redis deny-list deferred.

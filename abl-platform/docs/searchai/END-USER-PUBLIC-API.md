# SearchAI End-User Public API Reference

**Service:** search-ai-runtime
**Port:** 3004 (default)
**Base URL:** `http://localhost:3004/api/search`
**Status:** Implemented (ABLP-432, ABLP-366)
**Jira:** [ABLP-432](https://kore-abl.atlassian.net/browse/ABLP-432)

---

## Table of Contents

1. [Overview](#overview)
2. [Authentication Paths](#authentication-paths)
3. [Admin Setup (Prerequisites)](#admin-setup-prerequisites)
4. [Auth Endpoints](#auth-endpoints)
5. [Query Endpoint (Extended)](#query-endpoint-extended)
6. [Runtime RACL Propagation (Internal)](#runtime-racl-propagation-internal)
7. [Complete Request/Response Reference](#complete-requestresponse-reference)
8. [Middleware Validation Chain](#middleware-validation-chain)
9. [Error Handling](#error-handling)
10. [Rate Limiting](#rate-limiting)
11. [CORS Configuration](#cors-configuration)
12. [Collections & Data Model](#collections--data-model)
13. [Security Model](#security-model)
14. [SDK Examples](#sdk-examples)
15. [Migration from Existing API](#migration-from-existing-api)

---

## Overview

The End-User Public API allows **end-users to call SearchAI's query API directly** from browser applications without requiring a platform API key. Instead, users authenticate via their organization's Identity Provider (Azure AD, Google, Okta) and the system resolves tenant/project context from the `indexId` route parameter.

### Key Differences from Existing API

| Aspect                | Existing (Path D)                    | New End-User Paths (A/C)                                         |
| --------------------- | ------------------------------------ | ---------------------------------------------------------------- |
| Tenant identification | API key                              | `indexId` route param resolves tenant                            |
| User authentication   | `X-End-User-Token` header (optional) | Session token or IdP token (required)                            |
| Admin gate            | None (API key grants access)         | `ProjectSettings.publicApiAccess.scopes['search.query'].enabled` |
| Browser-friendly      | No (API key in frontend is insecure) | Yes (no secrets in frontend code)                                |
| IdP validation source | Hardcoded provider detection         | Auth profile-driven (admin selects which IdP)                    |

### Auth Profile Usage

The system uses **existing auth profiles** with zero schema changes. When an admin configures end-user access, they select an `oauth2_app` or `azure_ad` auth profile that already exists in the platform. The system reads:

- `config.issuer` — IdP issuer URL (for token validation)
- `config.clientId` — Audience (`aud`) claim validation
- Provider detection uses issuer URL pattern matching (Azure AD, Okta, Google, or custom OIDC)

No new auth types. No schema changes. No migration.

---

## Authentication Paths

### Path Summary

| Path | Name                    | Use Case                      | Headers on Query                         | Status      |
| ---- | ----------------------- | ----------------------------- | ---------------------------------------- | ----------- |
| A    | Token Exchange          | SPAs, mobile apps             | `X-Search-Session-Token`                 | Implemented |
| B    | Internal Service        | Runtime agent sessions (RACL) | `X-Auth-Mode: user` + `X-User-Identity`  | Implemented |
| C    | Direct IdP Token        | Simple integrations           | `X-Auth-Mode: user` + `X-End-User-Token` | Implemented |
| D    | Legacy (unchanged)      | Server-to-server via API key  | `Authorization` + `X-Auth-Mode` + IdP    | Unchanged   |
| E    | Public only (unchanged) | Anonymous search              | `Authorization`                          | Unchanged   |

### Decision Flowchart

```
Is this an internal service-to-service call (Runtime → SearchAI)?
├─ YES → Use Path B (service JWT + X-User-Identity header)
└─ NO
   │
   Is this a server-to-server call with an API key?
   ├─ YES → Use Path D (API key + IdP token) or Path E (API key only)
   └─ NO (browser/frontend)
      │
      Does your app already have the user's IdP token?
      ├─ YES → Use Path A (token exchange) — best performance
      └─ NO
         │
         Is simplicity > performance?
         └─ YES → Use Path C (direct IdP token per-request)
```

---

## Admin Setup (Prerequisites)

Before end-users can access the API, an admin must:

### 1. Create an Auth Profile (existing feature)

The admin creates (or already has) an `oauth2_app` or `azure_ad` auth profile:

```
Studio → Auth Profiles → Create New
  Type: OAuth 2.0 App (or Azure AD)
  Config:
    issuer: https://login.microsoftonline.com/{tenant-id}/v2.0
    clientId: <from Azure AD / Okta app registration>
  Scopes: openid, email, profile
```

### 2. Enable Public API Access (new feature)

```
Studio → Project Settings → Public API Access
  Enable Search Query Access: ON
  Auth Profile: <select the auth profile above>
  Allowed Email Domains: acme.com, contoso.com
  Allowed Origins (CORS): https://portal.acme.com, https://search.acme.com
  Session Token TTL: 900 (seconds, default: 15 minutes)
  Rate Limit (per user): 60 req/min
  Rate Limit (per project): 1000 req/min
```

### Admin API (programmatic setup)

```http
PUT /api/projects/:projectId/settings
Authorization: Bearer <admin-jwt>
Content-Type: application/json

{
  "publicApiAccess": {
    "scopes": {
      "search.query": {
        "enabled": true,
        "authProfileId": "019d01ef-xxxx-xxxx-xxxx-xxxxxxxxxxxx",
        "allowedDomains": ["acme.com", "contoso.com"],
        "allowedOrigins": ["https://portal.acme.com"],
        "sessionTokenTtlSeconds": 900,
        "rateLimits": {
          "perUserPerMinute": 60,
          "perProjectPerMinute": 1000
        }
      }
    }
  }
}
```

**Response (200):**

```json
{
  "success": true,
  "settings": {
    "projectId": "019d022e-dd34-74d6-9f9f-e4456e4d15db",
    "enableThinking": false,
    "thinkingBudget": null,
    "thoughtDescription": null,
    "promptOverrides": {},
    "traceDimensions": [],
    "publicApiAccess": {
      "scopes": {
        "search.query": {
          "enabled": true,
          "authProfileId": "019d01ef-xxxx-xxxx-xxxx-xxxxxxxxxxxx",
          "allowedDomains": ["acme.com", "contoso.com"],
          "allowedOrigins": ["https://portal.acme.com"],
          "sessionTokenTtlSeconds": 900,
          "rateLimits": { "perUserPerMinute": 60, "perProjectPerMinute": 1000 }
        }
      }
    }
  }
}
```

---

## Auth Endpoints

### POST /api/search/auth/token — Token Exchange (Path A)

Exchange an IdP token for a short-lived search session token.

**Request:**

```http
POST /api/search/auth/token
Host: search-ai-runtime:3004
X-End-User-Token: eyJhbGciOiJSUzI1NiIsInR5cCI6IkpXVCJ9...
X-Index-Id: 019d01ef-8dab-7164-9736-0d606675d3ff
Content-Type: application/json
```

| Header             | Required | Description                                           |
| ------------------ | -------- | ----------------------------------------------------- |
| `X-End-User-Token` | Yes      | Raw JWT from user's IdP (Azure AD, Google, Okta)      |
| `X-Index-Id`       | Yes      | Knowledge base index ID — resolves tenant and project |

**Validation performed:**

| #   | Check                                                               | Fails With                     |
| --- | ------------------------------------------------------------------- | ------------------------------ |
| 1   | `X-Index-Id` exists in `search_indexes`                             | `404 INDEX_NOT_FOUND`          |
| 2   | `ProjectSettings.publicApiAccess.scopes['search.query'].enabled`    | `403 END_USER_ACCESS_DISABLED` |
| 3   | Auth profile loaded and valid                                       | `500 AUTH_PROFILE_NOT_FOUND`   |
| 4   | IdP token signature valid (JWKS from provider's discovery endpoint) | `401 INVALID_IDP_TOKEN`        |
| 5   | `iss` matches auth profile's issuer (if configured)                 | `401 INVALID_IDP_TOKEN`        |
| 6   | `aud` includes auth profile's `clientId` (if configured)            | `401 AUDIENCE_MISMATCH`        |
| 7   | `exp` not past                                                      | `401 INVALID_IDP_TOKEN`        |
| 8   | Email domain in `allowedDomains` (if non-empty)                     | `403 DOMAIN_NOT_ALLOWED`       |

**Success Response (200):**

```json
{
  "success": true,
  "token": "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9...",
  "expiresIn": 900,
  "user": {
    "email": "alice@acme.com",
    "domain": "acme.com"
  }
}
```

**Session token payload (internal, signed with platform JWT_SECRET):**

```json
{
  "type": "search_session",
  "iss": "abl:search-runtime",
  "aud": "abl:search-query",
  "sub": "alice@acme.com",
  "tenantId": "019d01ec-5986-7d25-b39a-ef8a17b5ee5a",
  "projectId": "019d022e-dd34-74d6-9f9f-e4456e4d15db",
  "domain": "acme.com",
  "groups": ["okta:engineering", "okta:platform-team"],
  "contactId": "019d034a-xxxx-xxxx-xxxx-xxxxxxxxxxxx",
  "idpProvider": "okta",
  "iat": 1713500000,
  "exp": 1713500900
}
```

**Token Discrimination:** The triple discriminator (`type` + `iss` + `aud`) prevents token confusion attacks. A platform access token or SDK session token will never be accepted as a search session token, even if signed with the same secret.

---

## Query Endpoint (Extended)

### POST /api/search/:indexId/query

**Route unchanged.** `indexId` is a route parameter (existing behavior). The endpoint now accepts end-user authentication in addition to API key authentication.

---

### Path A Query — Session Token (No Authorization Header)

```http
POST /api/search/019d01ef-8dab-7164-9736-0d606675d3ff/query
Host: search-ai-runtime:3004
Content-Type: application/json
X-Auth-Mode: user
X-Search-Session-Token: eyJhbGciOiJIUzI1NiIs...

{
  "query": "How do I reset my password?",
  "topK": 5
}
```

| Header                   | Required | Description                      |
| ------------------------ | -------- | -------------------------------- |
| `X-Search-Session-Token` | Yes      | Session token from `/auth/token` |
| `X-Auth-Mode`            | Yes      | Must be `user`                   |
| `Content-Type`           | Yes      | `application/json`               |

**No `Authorization` header. No API key.**

The `endUserAuthMiddleware` handles this request:

1. No `Authorization` header → enters end-user auth path
2. Detects `X-Auth-Mode: user` and `X-Search-Session-Token` present
3. Verifies session JWT (signature, expiration, `iss`, `aud`, `type`)
4. Sets `req.tenantContext` and `req.userIdentity`
5. Permission filter applies RACL filtering based on user's email/groups/domain

---

### Path C Query — Direct IdP Token (No Authorization Header)

```http
POST /api/search/019d01ef-8dab-7164-9736-0d606675d3ff/query
Host: search-ai-runtime:3004
Content-Type: application/json
X-Auth-Mode: user
X-End-User-Token: eyJhbGciOiJSUzI1NiIs...

{
  "query": "Q3 revenue numbers",
  "topK": 10
}
```

| Header             | Required | Description                          |
| ------------------ | -------- | ------------------------------------ |
| `X-Auth-Mode`      | Yes      | Must be `user`                       |
| `X-End-User-Token` | Yes      | Raw IdP JWT (Azure AD, Google, Okta) |
| `Content-Type`     | Yes      | `application/json`                   |

**No `Authorization` header. No API key.** Every request validates the IdP token (slower than Path A).

---

### Path B Query — Internal Service Identity (Runtime → SearchAI)

```http
POST /api/search/019d01ef-8dab-7164-9736-0d606675d3ff/query
Host: search-ai-runtime:3004
Content-Type: application/json
Authorization: Bearer <service-jwt with sub: 'service:runtime'>
X-Auth-Mode: user
X-User-Identity: {"email":"alice@acme.com","name":"Alice","domain":"acme.com","groups":["engineering"]}

{
  "query": "internal docs",
  "topK": 5
}
```

| Header            | Required | Description                                               |
| ----------------- | -------- | --------------------------------------------------------- |
| `Authorization`   | Yes      | Service JWT (must have `sub: 'service:...'`)              |
| `X-Auth-Mode`     | Yes      | Must be `user`                                            |
| `X-User-Identity` | Yes      | JSON object with `email` (required), plus optional fields |
| `Content-Type`    | Yes      | `application/json`                                        |

**Security:** Only accepted from internal services (JWT `sub` starts with `service:`). If a non-service caller sends `X-User-Identity`, it receives `403 FORBIDDEN`.

---

### Path D Query — Legacy (API Key + IdP Token, unchanged)

```http
POST /api/search/019d01ef-8dab-7164-9736-0d606675d3ff/query
Host: search-ai-runtime:3004
Content-Type: application/json
Authorization: Bearer <service-jwt or platform-jwt>
X-Auth-Mode: user
X-End-User-Token: eyJhbGciOiJSUzI1NiIs...

{
  "query": "My pending approvals",
  "topK": 5
}
```

**This is the existing behavior. No changes.**

---

### Path E Query — Public Only (API Key, no user token)

```http
POST /api/search/019d01ef-8dab-7164-9736-0d606675d3ff/query
Host: search-ai-runtime:3004
Content-Type: application/json
Authorization: Bearer <service-jwt or platform-jwt>

{
  "query": "Company holiday calendar",
  "topK": 5
}
```

Returns only documents where `permissions.publicEverywhere = true` in the OpenSearch index.

---

### Query Request Body

The request body is identical across all paths:

```typescript
{
  query: string;                    // Required. Search query text.
  queryType?: 'vector' | 'semantic' | 'hybrid' | 'structured' | 'aggregation';
  topK?: number;                    // Max results (default: 10)
  filters?: object;                 // Metadata filters
  rerank?: boolean;                 // Enable reranking
  sort?: object;                    // Sort configuration
  offset?: number;                  // Pagination offset
  limit?: number;                   // Pagination limit
  debug?: boolean;                  // Include debug info in response
}
```

### Query Response Body

```typescript
{
  results: Array<{
    chunkId: string;
    documentId: string;
    content: string;
    score: number;
    metadata: object;
    canonicalMetadata?: object;
  }>;
  total: number;
  latency: {
    vectorSearchMs: number;
    totalMs: number;
  };
  debug?: object;                   // Only if debug=true
}
```

---

## Runtime RACL Propagation (Internal)

When a user interacts with an agent via Runtime (chat, voice, SDK), and the agent uses SearchAI KB tools, the system automatically propagates the user's identity for RACL permission filtering.

### How It Works

```
User Session (identityTier >= 2, Contact card exists)
  → Runtime: llm-wiring.ts extracts { email, name, domain, groups } from contactContext
  → SearchAIKBToolExecutor builds headers: X-Auth-Mode + X-User-Identity
  → HTTP POST to SearchAI-Runtime with service JWT + identity headers
  → SearchAI-Runtime validates service JWT (sub: 'service:runtime')
  → Permission filter trusts X-User-Identity (caller is internal service)
  → Query pipeline applies RACL filter (allowedUsers, allowedGroups, allowedDomains)
  → Only content accessible to the identified user is returned
```

### Identity Tier Requirements

| Tier | Description                               | RACL Behavior                    |
| ---- | ----------------------------------------- | -------------------------------- |
| 0    | Anonymous (no identity)                   | Public mode — no RACL filtering  |
| 1    | Partially identified (channel claim only) | Public mode — insufficient trust |
| 2    | Fully identified (Contact card, verified) | User mode — full RACL filtering  |

### What Gets Forwarded

```json
{
  "email": "alice@acme.com",
  "name": "Alice Smith",
  "domain": "acme.com",
  "groups": ["engineering", "platform-team"],
  "idpProvider": "platform",
  "idpUserId": "alice@acme.com"
}
```

Fields are extracted from `session.resolvedCallerContext.contactContext` which is populated from the Contact card when `identityTier >= 2`.

### Both Executor Types

Identity propagation works for **both** SearchAI tool executor patterns:

1. **SearchAIKBToolExecutor** — KB-as-tool pattern (`tool_type: 'searchai'`)
   - Receives `userIdentity` in config
   - Builds headers in constructor

2. **SearchAIAwareToolExecutor** — Legacy search tools (`search_vector`, `search_structured`)
   - Receives pre-built `headers` via `SearchAIClientConfig`
   - Same X-Auth-Mode + X-User-Identity headers

### Backward Compatibility

- `identityTier < 2` or undefined → no identity headers → public mode (unchanged)
- SDK sessions without `callerContext` → public mode (unchanged)
- Existing API key + IdP token flow (Path D) → unchanged, uses X-End-User-Token

---

## Complete Request/Response Reference

### Headers Summary

| Header                           | Paths      | Direction | Purpose                                |
| -------------------------------- | ---------- | --------- | -------------------------------------- |
| `Authorization: Bearer <jwt>`    | B, D, E    | Request   | Service/platform JWT → tenant access   |
| `X-Search-Session-Token: eyJ...` | A          | Request   | Session token → tenant + user identity |
| `X-End-User-Token: eyJ...`       | C, D       | Request   | Raw IdP JWT → user identity            |
| `X-User-Identity: {...}`         | B          | Request   | Pre-validated identity (services only) |
| `X-Auth-Mode: user\|public`      | A, B, C, D | Request   | Tells middleware to apply RACL filter  |
| `Content-Type: application/json` | All        | Request   | Standard                               |
| `Origin: https://...`            | A, C       | Request   | CORS enforcement (browser only)        |

### Access Matrix

| Has Authorization? | Has Session Token? | Has End-User Token? | Has X-User-Identity? | Result                       |
| :----------------: | :----------------: | :-----------------: | :------------------: | :--------------------------- |
|         No         |         No         |         No          |          No          | `401` — no identity          |
|        Yes         |         No         |         No          |          No          | Public results only (Path E) |
|        Yes         |         No         |         Yes         |          No          | RACL results (Path D)        |
|        Yes         |         No         |         No          |      Yes (svc)       | RACL results (Path B)        |
|         No         |        Yes         |         No          |          No          | RACL results (Path A)        |
|         No         |         No         |         Yes         |          No          | RACL results (Path C)        |

---

## Middleware Validation Chain

### End-User Auth Middleware (`endUserAuthMiddleware`)

Inserted BEFORE the existing `authMiddleware`. Handles end-user paths (A/C) when no `Authorization` header is present.

```
Request arrives at POST /api/search/:indexId/query
│
├─ Has `Authorization` header?
│   └─ YES → SKIP end-user middleware → existing authMiddleware handles it (Paths B, D, E)
│
├─ Has `X-Auth-Mode: user`?
│   └─ NO → SKIP (pass through to authMiddleware)
│
├─ Has `X-Search-Session-Token`?
│   └─ YES → Validate session JWT
│             ├─ Verify signature (HMAC, JWT_SECRET)
│             ├─ Verify iss = 'abl:search-runtime'
│             ├─ Verify aud = 'abl:search-query'
│             ├─ Verify type = 'search_session'
│             ├─ Verify not expired
│             ├─ Verify tenantId matches index
│             └─ Valid → set req.tenantContext + req.userIdentity → NEXT
│
├─ Has `X-End-User-Token`?
│   └─ YES → Resolve indexId → SearchIndex → tenantId, projectId
│             ├─ Index found? ───────────── NO → 404
│             ├─ publicApiAccess.scopes['search.query'].enabled?
│             │   └─ NO → 403 END_USER_ACCESS_DISABLED
│             ├─ Load AuthProfile → build IdP validation config
│             ├─ Validate IdP JWT (JWKS signature, issuer, audience, expiry)
│             │   └─ Invalid → 401
│             ├─ Check email domain against allowedDomains
│             │   └─ Not allowed → 403
│             └─ Valid → set req.tenantContext + req.userIdentity → NEXT
│
└─ Neither token present?
    └─ 401 AUTH_REQUIRED
```

### Permission Filter Middleware (`permissionFilterMiddleware`)

Runs AFTER auth. Determines search mode and applies RACL.

```
Request arrives (tenantContext already set by auth)
│
├─ Was identity pre-resolved by endUserAuthMiddleware?
│   └─ YES → authMode = 'user', identity = pre-resolved → NEXT
│
├─ Read X-Auth-Mode header (default: 'public')
│   ├─ 'public' → authMode = 'public' → NEXT (no RACL filter)
│   └─ 'user' →
│       ├─ Has X-User-Identity? (Path B — internal service)
│       │   ├─ Caller is service:* ? → Parse JSON, validate email → NEXT
│       │   └─ Not a service → 403 FORBIDDEN (spoofing attempt)
│       │
│       ├─ Has X-End-User-Token? (Path D — legacy)
│       │   └─ Validate via IdP JWKS → extract identity → NEXT
│       │
│       └─ Neither? → 400 MISSING_END_USER_TOKEN
```

### Full Chain

```
endUserAuthMiddleware → authMiddleware → permissionFilterMiddleware → rateLimitMiddleware → handler
        │                     │                    │                        │               │
  End-user paths        API key/JWT         Sets authMode           Per-user/project    Query with
  (A, C)               paths (B, D, E)     + userIdentity          rate check          RACL filter
```

---

## Error Handling

### Error Response Format

```json
{
  "success": false,
  "error": {
    "code": "ERROR_CODE",
    "message": "Human-readable description (sanitized, no internal details)"
  }
}
```

### Error Codes

| Code                       | HTTP Status | When                                            | Solution                                    |
| -------------------------- | ----------- | ----------------------------------------------- | ------------------------------------------- |
| `AUTH_REQUIRED`            | 401         | No auth tokens at all                           | Provide session token or IdP token          |
| `INVALID_TOKEN`            | 401         | Session or IdP token signature fails            | Re-authenticate                             |
| `INVALID_IDP_TOKEN`        | 401         | IdP JWT signature or claims invalid             | Get fresh token from IdP                    |
| `AUDIENCE_MISMATCH`        | 401         | Token `aud` doesn't match expected clientId     | Check IdP app registration                  |
| `MISSING_IDP_TOKEN`        | 400         | `/auth/token` called without `X-End-User-Token` | Include the IdP token header                |
| `MISSING_INDEX_ID`         | 400         | `/auth/token` called without `X-Index-Id`       | Include the index ID header                 |
| `INVALID_USER_IDENTITY`    | 400         | X-User-Identity malformed or missing email      | Fix JSON structure                          |
| `MISSING_END_USER_TOKEN`   | 400         | X-Auth-Mode: user but no token provided         | Provide X-End-User-Token or X-User-Identity |
| `INDEX_NOT_FOUND`          | 404         | `indexId` doesn't exist                         | Verify index ID                             |
| `END_USER_ACCESS_DISABLED` | 403         | Public API not enabled for this project         | Admin must enable in Project Settings       |
| `DOMAIN_NOT_ALLOWED`       | 403         | Email domain not in `allowedDomains`            | Admin must add domain to allowed list       |
| `FORBIDDEN`                | 403         | Non-service caller using X-User-Identity        | Only internal services can forward identity |
| `AUTH_PROFILE_NOT_FOUND`   | 500         | Auth profile referenced but not found           | Admin must fix auth profile                 |
| `RATE_LIMIT_EXCEEDED`      | 429         | Too many requests                               | Wait for rate limit window to reset         |

---

## Rate Limiting

End-user requests are rate-limited at two levels:

| Level            | Redis Key Pattern                              | Default      |
| ---------------- | ---------------------------------------------- | ------------ |
| Per-user (email) | `eu:ratelimit:{tenantId}:{email}:{minute}`     | 60 req/min   |
| Per-project      | `eu:ratelimit:{tenantId}:{projectId}:{minute}` | 1000 req/min |

Both are configurable per project via `publicApiAccess.scopes['search.query'].rateLimits`.

**Fallback:** If Redis is unavailable, in-memory rate limiting is used with the same fixed-window algorithm.

**Rate limit response:**

```json
{
  "success": false,
  "error": {
    "code": "RATE_LIMIT_EXCEEDED",
    "message": "Rate limit exceeded"
  }
}
```

---

## CORS Configuration

For browser-based end-user access (Paths A, C), CORS is enforced dynamically per project:

- **Allowed Origins:** From `publicApiAccess.scopes['search.query'].allowedOrigins`
- **Allowed Methods:** `GET, POST, OPTIONS`
- **Allowed Headers:** `Content-Type, X-Search-Session-Token, X-Auth-Mode, X-End-User-Token, X-Index-Id, Origin`
- **Max Age:** 3600 (1 hour preflight cache)

CORS is **per-project** — each project's `allowedOrigins` list is checked dynamically based on the `indexId` in the request URL.

The CORS middleware extracts `indexId` from the request URL path (`/api/search/{indexId}/...`) and resolves allowed origins from ProjectSettings. An in-memory cache (5-minute TTL, 500 entries max, LRU eviction) prevents repeated DB lookups.

---

## Collections & Data Model

### Collections Read (existing, no schema changes)

| Collection       | Model         | Purpose                                     | Query Pattern                               |
| ---------------- | ------------- | ------------------------------------------- | ------------------------------------------- |
| `search_indexes` | `SearchIndex` | Resolve `indexId` → `tenantId`, `projectId` | `findOne({ _id: indexId })`                 |
| `auth_profiles`  | `AuthProfile` | Load OIDC config for IdP validation         | `findOne({ _id: authProfileId, tenantId })` |
| `contacts`       | `Contact`     | Contact card creation + group resolution    | `findOne({ tenantId, ... })`                |

### Collections Extended

| Collection         | Model             | New Field         | Purpose                                 |
| ------------------ | ----------------- | ----------------- | --------------------------------------- |
| `project_settings` | `ProjectSettings` | `publicApiAccess` | Admin configuration for end-user access |

**`publicApiAccess` field schema:**

```typescript
publicApiAccess: {
  scopes: {
    'search.query': {
      enabled: boolean;                    // Master toggle (default: false)
      authProfileId: string;              // References AuthProfile._id
      allowedDomains: string[];           // ["acme.com", "contoso.com"]
      allowedOrigins: string[];           // ["https://portal.acme.com"]
      sessionTokenTtlSeconds: number;     // Default: 900 (15 min)
      rateLimits: {
        perUserPerMinute: number;         // Default: 60
        perProjectPerMinute: number;      // Default: 1000
      }
    }
  }
} | null  // null = feature disabled (default)
```

**Schema type:** `Schema.Types.Mixed` with `default: null` — no migration required.

### Redis Keys

| Key Pattern                                 | Purpose                  | TTL         |
| ------------------------------------------- | ------------------------ | ----------- |
| `searchai:jwks:{tenantId}:{issuer}:{kid}`   | Cached JWKS public keys  | 3600s (1hr) |
| `eu:ratelimit:{tenantId}:{email}:{window}`  | Per-user rate counter    | 60s         |
| `eu:ratelimit:{tenantId}:{projId}:{window}` | Per-project rate counter | 60s         |

---

## Security Model

### Defense Layers

| Layer                   | What It Does                                         | Prevents                   |
| ----------------------- | ---------------------------------------------------- | -------------------------- |
| 1. IdP Signature        | JWKS verification (RS256/ES256) of external JWT      | Token forgery              |
| 2. Issuer Validation    | `iss` must match auth profile config                 | Cross-IdP token reuse      |
| 3. Audience Validation  | `aud` must match auth profile's `clientId`           | Tokens from other apps     |
| 4. Domain Restriction   | Email domain must be in `allowedDomains`             | Unauthorized organizations |
| 5. Service Trust Gate   | `X-User-Identity` only from `sub: 'service:...'`     | Identity spoofing          |
| 6. Token Discrimination | `type` + `iss` + `aud` triple check on session token | Token confusion attacks    |
| 7. Rate Limiting        | Per-user + per-project limits                        | DDoS, abuse                |
| 8. RACL Filter          | 4-clause permission filter on OpenSearch             | Unauthorized data access   |

### RACL 4-Clause Filter

When `authMode = 'user'`, the query pipeline injects this OpenSearch bool filter:

```json
{
  "bool": {
    "should": [
      { "term": { "permissions.publicEveryone": true } },
      { "term": { "permissions.allowedUsers": "alice@acme.com" } },
      { "terms": { "permissions.allowedGroups": ["engineering", "platform"] } },
      { "term": { "permissions.allowedDomains": "acme.com" } }
    ],
    "minimum_should_match": 1
  }
}
```

A document is visible to the user if ANY of the 4 clauses match:

1. **publicEveryone** — visible to all authenticated users
2. **allowedUsers** — user's email is explicitly listed
3. **allowedGroups** — user belongs to a listed group
4. **allowedDomains** — user's email domain matches

### Group Resolution (3-Tier)

Groups are resolved with a tiered fallback for performance:

| Tier | Source      | Latency | When Used                          |
| ---- | ----------- | ------- | ---------------------------------- |
| 1    | JWT claims  | 0ms     | Groups in token's `groups` claim   |
| 2    | Redis cache | ~0.5ms  | Cached from previous resolution    |
| 3    | MongoDB     | ~1-3ms  | Contact card `acl.effectiveGroups` |

**Fail-closed:** If MongoDB lookup fails, returns empty groups (strictest access).

---

## SDK Examples

### JavaScript (Path A — Token Exchange)

```javascript
class SearchClient {
  constructor({ baseUrl, indexId }) {
    this.baseUrl = baseUrl;
    this.indexId = indexId;
    this.sessionToken = null;
    this.tokenExpiry = 0;
  }

  async authenticate(idpToken) {
    const res = await fetch(`${this.baseUrl}/api/search/auth/token`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'X-End-User-Token': idpToken,
        'X-Index-Id': this.indexId,
      },
    });

    if (!res.ok) throw new Error(`Auth failed: ${res.status}`);

    const data = await res.json();
    this.sessionToken = data.token;
    this.tokenExpiry = Date.now() + data.expiresIn * 1000;
    return data.user;
  }

  async query(queryText, options = {}) {
    if (!this.sessionToken || Date.now() > this.tokenExpiry) {
      throw new Error('Session expired. Call authenticate() again.');
    }

    const res = await fetch(`${this.baseUrl}/api/search/${this.indexId}/query`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'X-Auth-Mode': 'user',
        'X-Search-Session-Token': this.sessionToken,
      },
      body: JSON.stringify({
        query: queryText,
        topK: options.topK || 10,
        filters: options.filters,
      }),
    });

    if (res.status === 401) {
      this.sessionToken = null;
      throw new Error('Session expired');
    }

    return res.json();
  }
}

// Usage with Azure AD (MSAL.js)
const search = new SearchClient({
  baseUrl: 'https://search.company.com',
  indexId: '019d01ef-8dab-7164-9736-0d606675d3ff',
});

const idpToken = await msalInstance.acquireTokenSilent({
  scopes: ['openid', 'email', 'profile'],
});
await search.authenticate(idpToken.accessToken);

// Query multiple times (session token valid for 15 min)
const results = await search.query('How do I submit expenses?');
console.log(results.results);
```

### JavaScript (Path C — Direct IdP Token)

```javascript
async function searchWithIdpToken(indexId, query, idpToken) {
  const res = await fetch(`https://search.company.com/api/search/${indexId}/query`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'X-Auth-Mode': 'user',
      'X-End-User-Token': idpToken,
    },
    body: JSON.stringify({ query, topK: 10 }),
  });

  return res.json();
}

// Usage — simplest integration (validates IdP token on every request)
const token = await msalInstance.acquireTokenSilent({ scopes: ['openid'] });
const results = await searchWithIdpToken(
  '019d01ef-8dab-7164-9736-0d606675d3ff',
  'vacation policy',
  token.accessToken,
);
```

### React Hook (Path A)

```javascript
import { useState, useCallback, useRef } from 'react';
import { useMsal } from '@azure/msal-react';

function useSearch(indexId) {
  const { instance } = useMsal();
  const [sessionToken, setSessionToken] = useState(null);
  const tokenExpiry = useRef(0);

  const authenticate = useCallback(async () => {
    const { accessToken } = await instance.acquireTokenSilent({
      scopes: ['openid', 'email'],
    });

    const res = await fetch('/api/search/auth/token', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'X-End-User-Token': accessToken,
        'X-Index-Id': indexId,
      },
    });

    const data = await res.json();
    setSessionToken(data.token);
    tokenExpiry.current = Date.now() + data.expiresIn * 1000;
    return data;
  }, [indexId, instance]);

  const search = useCallback(
    async (query, options = {}) => {
      if (!sessionToken || Date.now() > tokenExpiry.current) {
        await authenticate();
      }

      const res = await fetch(`/api/search/${indexId}/query`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'X-Auth-Mode': 'user',
          'X-Search-Session-Token': sessionToken,
        },
        body: JSON.stringify({ query, ...options }),
      });

      if (res.status === 401) {
        await authenticate();
        return search(query, options);
      }

      return res.json();
    },
    [indexId, sessionToken, authenticate],
  );

  return { authenticate, search };
}
```

### cURL Examples

```bash
# ─── Path A: Token Exchange + Query ───────────────────────────────
# Step 1: Get session token
TOKEN_RESPONSE=$(curl -s -X POST http://localhost:3004/api/search/auth/token \
  -H "Content-Type: application/json" \
  -H "X-End-User-Token: $AZURE_AD_TOKEN" \
  -H "X-Index-Id: 019d01ef-8dab-7164-9736-0d606675d3ff")

SESSION=$(echo "$TOKEN_RESPONSE" | jq -r '.token')
echo "Session token: ${SESSION:0:20}..."

# Step 2: Query (reuse session token for 15 min)
curl -s -X POST http://localhost:3004/api/search/019d01ef-8dab-7164-9736-0d606675d3ff/query \
  -H "Content-Type: application/json" \
  -H "X-Auth-Mode: user" \
  -H "X-Search-Session-Token: $SESSION" \
  -d '{"query": "onboarding steps", "topK": 5}' | jq .

# ─── Path C: Direct IdP Token ────────────────────────────────────
curl -s -X POST http://localhost:3004/api/search/019d01ef-8dab-7164-9736-0d606675d3ff/query \
  -H "Content-Type: application/json" \
  -H "X-Auth-Mode: user" \
  -H "X-End-User-Token: $AZURE_AD_TOKEN" \
  -d '{"query": "team tasks", "topK": 5}' | jq .

# ─── Path B: Internal Service (Runtime) ──────────────────────────
curl -s -X POST http://localhost:3004/api/search/019d01ef-8dab-7164-9736-0d606675d3ff/query \
  -H "Content-Type: application/json" \
  -H "Authorization: Bearer $SERVICE_TOKEN" \
  -H "X-Auth-Mode: user" \
  -H 'X-User-Identity: {"email":"alice@acme.com","domain":"acme.com","groups":["engineering"]}' \
  -d '{"query": "internal docs", "topK": 5}' | jq .

# ─── Path D: Legacy (API Key + IdP Token) ────────────────────────
curl -s -X POST http://localhost:3004/api/search/019d01ef-8dab-7164-9736-0d606675d3ff/query \
  -H "Content-Type: application/json" \
  -H "Authorization: Bearer $PLATFORM_TOKEN" \
  -H "X-Auth-Mode: user" \
  -H "X-End-User-Token: $AZURE_AD_TOKEN" \
  -d '{"query": "pending approvals", "topK": 5}' | jq .

# ─── Path E: Public Results Only ─────────────────────────────────
curl -s -X POST http://localhost:3004/api/search/019d01ef-8dab-7164-9736-0d606675d3ff/query \
  -H "Content-Type: application/json" \
  -H "Authorization: Bearer $PLATFORM_TOKEN" \
  -d '{"query": "holiday calendar", "topK": 5}' | jq .
```

---

## Migration from Existing API

### For Existing Clients (Zero Changes Required)

Clients using **Path D** (API key + IdP token) or **Path E** (API key only) continue working without any changes. The new middleware is a no-op when `Authorization` header is present.

### For New Frontend Integrations

**Before (Path D — requires API key in frontend, insecure):**

```javascript
// BAD: API key exposed in browser
fetch('/api/search/idx-001/query', {
  headers: {
    Authorization: 'Bearer abl_sk_...', // Secret in frontend!
    'X-Auth-Mode': 'user',
    'X-End-User-Token': idpToken,
  },
  body: JSON.stringify({ query: '...' }),
});
```

**After (Path A — no secrets in frontend):**

```javascript
// GOOD: No secrets, session token is short-lived and user-scoped
const { token } = await fetch('/api/search/auth/token', {
  method: 'POST',
  headers: {
    'X-End-User-Token': idpToken,
    'X-Index-Id': 'idx-001',
  },
}).then((r) => r.json());

fetch('/api/search/idx-001/query', {
  headers: {
    'Content-Type': 'application/json',
    'X-Auth-Mode': 'user',
    'X-Search-Session-Token': token, // No secret, expires in 15 min
  },
  body: JSON.stringify({ query: '...' }),
});
```

### Prerequisites Checklist

1. [ ] Admin has created an `oauth2_app` or `azure_ad` auth profile with OIDC config
2. [ ] Admin has enabled Public API Access (`publicApiAccess.scopes['search.query'].enabled`)
3. [ ] `allowedDomains` includes your users' email domains (or leave empty for all)
4. [ ] `allowedOrigins` includes your frontend's origin (for CORS)
5. [ ] Your frontend can obtain IdP tokens (MSAL.js, Auth0, Okta SDK, etc.)

---

## Backward Compatibility Guarantee

| Scenario                               | Before | After              | Changed?    |
| -------------------------------------- | ------ | ------------------ | ----------- |
| API key + public query                 | Works  | Works              | No          |
| API key + IdP token (user query)       | Works  | Works              | No          |
| Runtime → SearchAI (service token)     | Works  | Works + RACL       | Enhanced    |
| No auth headers at all                 | 401    | 401                | No          |
| Session token (new)                    | N/A    | Works              | New feature |
| Direct IdP token without API key (new) | N/A    | Works (if enabled) | New feature |
| X-User-Identity from service (new)     | N/A    | Works              | New feature |

**The only way new behavior activates:**

- End-user paths (A, C): `publicApiAccess.scopes['search.query'].enabled === true` for the project
- Internal path (B): Service JWT with `sub: 'service:...'` + user has `identityTier >= 2`
- All existing projects: no `publicApiAccess` field → feature is off by default

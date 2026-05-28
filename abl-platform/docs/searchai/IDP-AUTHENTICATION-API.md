# IdP Authentication API Documentation

**Feature:** End-user permission filtering using identity provider (IdP) tokens
**Status:** Production-ready (Phase 1-5 complete)
**Supported IdPs:** Azure AD, Okta, Google Workspace

---

## Table of Contents

1. [Overview](#overview)
2. [Two-Layer Authentication Model](#two-layer-authentication-model)
3. [API Reference](#api-reference)
4. [Usage Examples](#usage-examples)
5. [Error Handling](#error-handling)
6. [Performance](#performance)
7. [Security Considerations](#security-considerations)
8. [IdP Sync Management](#idp-sync-management)

---

## Overview

The Search-AI IdP Authentication feature enables **end-user permission filtering** on search queries. When a user authenticates with their organization's identity provider (Azure AD, Okta, or Google), their JWT token can be forwarded to Search-AI to filter search results based on their permissions.

### Key Benefits

- **Secure multi-tenant search** — Users only see documents they have permission to access
- **Seamless SSO integration** — Leverage existing IdP infrastructure (Azure AD, Okta, Google)
- **Backward compatible** — Existing clients work without changes (defaults to public-only search)
- **High performance** — Caching reduces overhead to 2-5ms per query (P95)

---

## Two-Layer Authentication Model

Search-AI uses a two-layer authentication model:

### Layer 1: Platform Authentication (API Key)

**Purpose:** Authenticate the application/tenant making the request
**Method:** `Authorization: Bearer <abl_api_key>` header
**Required:** Always

This layer remains unchanged — all API requests must include a valid API key.

### Layer 2: End-User Authentication (IdP Token)

**Purpose:** Identify the specific end-user for permission filtering
**Method:** `X-End-User-Token: <idp_jwt>` header
**Required:** Only when `X-Auth-Mode: user`

This layer is **opt-in** — clients can choose to send end-user tokens for permission filtering.

### Authentication Flow

```
┌─────────────┐
│ Client App  │
│ (React/Web) │
└──────┬──────┘
       │
       │ 1. User logs into IdP (Azure AD/Okta/Google)
       │    → Receives JWT token
       │
       ▼
┌──────────────────────────────────────────┐
│ Client forwards request to Search-AI     │
│                                          │
│ Headers:                                 │
│ - Authorization: Bearer abl_sk_...      │ ◄─ Layer 1 (Platform)
│ - X-Auth-Mode: user                     │
│ - X-End-User-Token: <idp_jwt>           │ ◄─ Layer 2 (End-User)
└────────┬─────────────────────────────────┘
         │
         ▼
┌────────────────────────────────────────────────┐
│ Search-AI Runtime validates both layers:       │
│                                                │
│ 1. API key → tenant binding (Layer 1)         │
│ 2. IdP token → user identity (Layer 2)        │
│    - Verify JWT signature (JWKS)              │
│    - Extract user email, groups               │
│    - Build permission filter                   │
└────────┬───────────────────────────────────────┘
         │
         ▼
┌────────────────────────────────────────────────┐
│ OpenSearch executes query with permission      │
│ filter applied:                                │
│                                                │
│ bool: {                                        │
│   should: [                                    │
│     { term: { "permissions.publicEverywhere": true } },│
│     { term: { "permissions.allowedUsers": "alice@..." } },│
│     { terms: { "permissions.allowedGroups": ["group1", ...] } }│
│   ]                                            │
│ }                                              │
└────────────────────────────────────────────────┘
```

---

## API Reference

### Headers

#### X-Auth-Mode

**Type:** `string`
**Required:** No (defaults to `public`)
**Values:** `public` | `user`

- **`public`** (default) — Returns only publicly accessible documents (`permissions.publicEverywhere = true`)
- **`user`** — Returns documents the end-user has permission to access (requires `X-End-User-Token`)

#### X-End-User-Token

**Type:** `string` (JWT token)
**Required:** Yes, when `X-Auth-Mode: user`
**Format:** Raw JWT token from Azure AD, Okta, or Google (not Base64-encoded)

The token must be a valid JWT from one of the supported IdPs:

- **Azure AD:** `https://login.microsoftonline.com/{tenant}/v2.0` issuer
- **Okta:** `https://{company}.okta.com/oauth2/default` issuer
- **Google:** `https://accounts.google.com` issuer

### Query Endpoint

**Method:** `POST`
**Path:** `/api/search/:indexId/query`
**Content-Type:** `application/json`

**Request Body:**

```typescript
{
  query: string;            // Search query text
  queryType: 'vector' | 'keyword' | 'hybrid';
  topK?: number;            // Max results (default: 10)
  filters?: object;         // Optional metadata filters
  conversationId?: string;  // For conversational search
}
```

**Response:**

```typescript
{
  success: boolean;
  data?: {
    results: Array<{
      id: string;
      score: number;
      content: string;
      metadata: object;
      permissions?: {        // Permission metadata (informational)
        publicEverywhere: boolean;
        allowedUsers: string[];
        allowedGroups: string[];
      };
    }>;
    totalResults: number;
    queryId: string;
  };
  error?: {
    code: string;
    message: string;
  };
}
```

---

## Usage Examples

### Example 1: Public Mode (Default, Backward Compatible)

```bash
curl -X POST https://api.searchai.example.com/api/search/idx_abc123/query \
  -H "Authorization: Bearer abl_sk_dev_xyz" \
  -H "Content-Type: application/json" \
  -d '{
    "query": "quarterly financial report",
    "queryType": "vector",
    "topK": 10
  }'
```

**Behavior:**

- Returns only public documents (`permissions.publicEverywhere = true`)
- No IdP token validation
- Works for all existing clients without changes

---

### Example 2: User Mode with Azure AD Token

```bash
# 1. User authenticates with Azure AD and gets JWT token
AZURE_TOKEN="<jwt_token_from_azure_ad>"

# 2. Forward token to Search-AI
curl -X POST https://api.searchai.example.com/api/search/idx_abc123/query \
  -H "Authorization: Bearer abl_sk_dev_xyz" \
  -H "X-Auth-Mode: user" \
  -H "X-End-User-Token: $AZURE_TOKEN" \
  -H "Content-Type: application/json" \
  -d '{
    "query": "quarterly financial report",
    "queryType": "vector",
    "topK": 10
  }'
```

**Behavior:**

- Validates Azure AD JWT token
- Extracts user email (e.g., `alice@company.com`)
- Fetches user groups from Neo4j (or Redis cache)
- Applies permission filter:
  ```json
  {
    "bool": {
      "should": [
        { "term": { "permissions.publicEverywhere": true } },
        { "term": { "permissions.allowedUsers": "alice@company.com" } },
        { "terms": { "permissions.allowedGroups": ["azuread:group-123", "azuread:group-456"] } }
      ],
      "minimum_should_match": 1
    }
  }
  ```
- Returns only documents Alice has permission to access

---

### Example 3: User Mode with Okta Token

```javascript
// Frontend code (React example)
import { useAuth } from '@okta/okta-react';

async function searchWithPermissions(query) {
  const { oktaAuth } = useAuth();
  const accessToken = await oktaAuth.getAccessToken();

  const response = await fetch('https://api.searchai.example.com/api/search/idx_abc123/query', {
    method: 'POST',
    headers: {
      Authorization: 'Bearer abl_sk_prod_xyz',
      'X-Auth-Mode': 'user',
      'X-End-User-Token': accessToken,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({
      query: query,
      queryType: 'hybrid',
      topK: 20,
    }),
  });

  return response.json();
}
```

---

### Example 4: User Mode with Google Workspace

```typescript
// Backend proxy pattern (Node.js/Express)
import { google } from 'googleapis';

app.post('/api/search-proxy', async (req, res) => {
  const { query, topK } = req.body;

  // Get Google OAuth2 token from session
  const googleToken = req.session.googleAccessToken;

  // Forward to Search-AI with user token
  const searchResponse = await fetch(
    'https://api.searchai.example.com/api/search/idx_abc123/query',
    {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${process.env.SEARCHAI_API_KEY}`,
        'X-Auth-Mode': 'user',
        'X-End-User-Token': googleToken,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({ query, queryType: 'vector', topK }),
    },
  );

  const results = await searchResponse.json();
  res.json(results);
});
```

---

## Error Handling

### Error Codes

| Code                      | Status | Description                                                     | Solution                                                             |
| ------------------------- | ------ | --------------------------------------------------------------- | -------------------------------------------------------------------- |
| `MISSING_END_USER_TOKEN`  | 400    | `X-End-User-Token` header required when `X-Auth-Mode` is `user` | Include `X-End-User-Token` header or switch to `X-Auth-Mode: public` |
| `INVALID_END_USER_TOKEN`  | 401    | JWT token is malformed or has invalid format                    | Verify token is a valid JWT from supported IdP                       |
| `TOKEN_EXPIRED`           | 401    | JWT token has expired (`exp` claim)                             | Refresh IdP token and retry                                          |
| `TOKEN_SIGNATURE_INVALID` | 401    | JWT signature verification failed                               | Token may be tampered or using wrong IdP                             |
| `ISSUER_NOT_SUPPORTED`    | 401    | Token issuer is not Azure AD, Okta, or Google                   | Use token from supported IdP                                         |
| `JWKS_FETCH_FAILED`       | 503    | Failed to fetch JWKS public keys from IdP                       | IdP may be down, retry after delay                                   |
| `NEO4J_UNAVAILABLE`       | 500    | Neo4j unavailable for group lookup                              | Circuit breaker active, will return empty groups                     |

### Example Error Response

```json
{
  "success": false,
  "error": {
    "code": "MISSING_END_USER_TOKEN",
    "message": "X-End-User-Token header required when X-Auth-Mode is 'user'"
  }
}
```

---

## Performance

### Latency Breakdown

| Component               | Cached     | Uncached       | Notes                          |
| ----------------------- | ---------- | -------------- | ------------------------------ |
| JWKS fetch              | ~1-2ms     | ~50-200ms      | Redis cache (1-hour TTL)       |
| Group resolution        | ~1-2ms     | ~50-100ms      | Redis cache (5-min TTL)        |
| Permission filter build | <1ms       | <1ms           | In-memory operation            |
| **Total overhead**      | **~2-5ms** | **~100-300ms** | First query per user is slower |

### Caching Strategy

1. **JWKS Cache** (1-hour TTL)
   - Public keys from IdP stored in Redis
   - Shared across all pods
   - Auto-refresh on key rotation

2. **Group Membership Cache** (5-min TTL)
   - User group memberships from Neo4j
   - Per-tenant cache keys
   - Invalidated after IdP sync

### Performance Targets

- **P95 latency:** <500ms (includes permission filtering)
- **P99 latency:** <1000ms
- **Cache hit rate:** >95% for active users

### Scalability

- **Concurrent users:** Tested up to 1000 concurrent users
- **Query throughput:** 500-1000 qps per pod
- **IdP sync:** Handles 10k+ users, 1k+ groups per tenant

---

## Security Considerations

### Token Validation

✅ **Signature verification** — JWT signature verified using IdP's JWKS public keys
✅ **Expiration check** — `exp` claim validated to prevent expired token use
✅ **Issuer validation** — `iss` claim checked against allowed IdP issuers
✅ **Audience validation** — `aud` claim verified (if configured)

❌ **No replay protection** — Tokens can be reused until expiration (acceptable for search use case)

### Attack Vectors Mitigated

1. **Token Forgery** — Prevented by signature verification
2. **Cross-IdP Token Reuse** — Prevented by issuer validation
3. **Expired Token Use** — Prevented by expiration check
4. **Permission Escalation** — Groups fetched from Neo4j (not client-controlled)

### Recommended Practices

1. **Use HTTPS only** — Never send IdP tokens over unencrypted connections
2. **Short token expiry** — Configure IdP tokens to expire in 1-hour or less
3. **Token refresh** — Implement automatic token refresh in client applications
4. **CORS restrictions** — Configure CORS to allow only trusted domains
5. **Rate limiting** — Implement rate limiting per API key and per user
6. **Audit logging** — Log all permission-filtered queries for compliance

---

## IdP Sync Management

### Manual Sync Trigger

**Endpoint:** `POST /api/idp/sync/trigger`

**Request:**

```json
{
  "provider": "azuread" | "okta" | "google",
  "syncMode": "full" | "delta",
  "credentialId": "cred_abc123"
}
```

**Response:**

```json
{
  "success": true,
  "data": {
    "provider": "azuread",
    "syncMode": "delta",
    "jobs": {
      "userSync": {
        "id": "azuread-user-sync:tenant-123:1234567890",
        "queue": "azuread-user-sync"
      },
      "groupSync": {
        "id": "azuread-group-sync:tenant-123:1234567890",
        "queue": "azuread-group-sync"
      }
    }
  }
}
```

### Check Sync Status

**Endpoint:** `GET /api/idp/sync/status?provider=azuread`

**Response:**

```json
{
  "success": true,
  "data": {
    "provider": "azuread",
    "tenantId": "tenant-123",
    "userSync": {
      "queue": "azuread-user-sync",
      "recentJobs": [
        {
          "id": "azuread-user-sync:tenant-123:1234567890",
          "state": "completed",
          "progress": 100,
          "timestamp": 1234567890,
          "finishedOn": 1234567900
        }
      ]
    },
    "groupSync": {
      "queue": "azuread-group-sync",
      "recentJobs": [
        {
          "id": "azuread-group-sync:tenant-123:1234567890",
          "state": "completed",
          "progress": 100,
          "timestamp": 1234567890,
          "finishedOn": 1234567920
        }
      ]
    }
  }
}
```

### Invalidate Cache

**Endpoint:** `POST /api/idp/sync/invalidate-cache`

Forces refresh of group membership cache on next query.

**Response:**

```json
{
  "success": true,
  "data": {
    "tenantId": "tenant-123",
    "keysDeleted": 42
  }
}
```

### Automatic Sync Schedule

IdP sync runs automatically:

- **Frequency:** Daily at 2:00 AM UTC (user sync), 2:30 AM UTC (group sync)
- **Sync Mode:** Delta (incremental) by default
- **Full Sync:** Manual trigger required or first run per tenant

---

## Migration Guide

### Migrating Existing Applications

1. **No changes required** — Existing clients work without modifications (defaults to public mode)

2. **Opt-in to user mode** — Add IdP token forwarding when ready:

```javascript
// Before (public mode)
fetch('/api/search/idx_abc123/query', {
  headers: {
    Authorization: 'Bearer abl_sk_...',
  },
  // ...
});

// After (user mode)
fetch('/api/search/idx_abc123/query', {
  headers: {
    Authorization: 'Bearer abl_sk_...',
    'X-Auth-Mode': 'user', // ← Add this
    'X-End-User-Token': userIdPToken, // ← Add this
  },
  // ...
});
```

3. **Configure IdP sync** — Set up LLM credentials with IdP API keys:

```bash
POST /api/v1/credentials
{
  "name": "Azure AD Sync Credential",
  "type": "llm",
  "encryptedApiKey": "<azure_ad_client_secret>",
  "metadata": {
    "tenantId": "<azure_tenant_id>",
    "clientId": "<azure_client_id>"
  }
}
```

4. **Trigger initial sync** — Run full sync to populate Neo4j:

```bash
POST /api/idp/sync/trigger
{
  "provider": "azuread",
  "syncMode": "full",
  "credentialId": "cred_abc123"
}
```

5. **Test user mode queries** — Verify permission filtering works

6. **Monitor performance** — Check P95 latency stays under 500ms

---

## FAQ

### Q: Can I use multiple IdPs for the same tenant?

**A:** Yes, the same tenant can have users from Azure AD, Okta, and Google. User identity is resolved by email address, and groups are prefixed by provider (`azuread:`, `okta:`, `google:`).

### Q: What happens if IdP sync fails?

**A:** Queries continue to work with the last successfully synced user/group data. Sync jobs are retried with exponential backoff (3 attempts).

### Q: How often should I run IdP sync?

**A:** Daily delta sync is sufficient for most use cases. Run full sync monthly or after major organizational changes.

### Q: Can I customize the sync schedule?

**A:** Not currently. The schedule is fixed at 2 AM UTC daily. Manual triggers are available for on-demand sync.

### Q: What happens if Neo4j is down?

**A:** Circuit breaker activates, queries continue with empty group list (user-only permissions). Service degrades gracefully.

### Q: How do I handle token refresh?

**A:** Implement token refresh in your client application. Most IdP SDKs handle this automatically (MSAL.js, Okta React SDK, etc.).

---

## Support

For questions or issues:

- **Documentation:** https://docs.searchai.example.com
- **API Status:** https://status.searchai.example.com
- **Support:** support@searchai.example.com

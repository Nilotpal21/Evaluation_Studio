# RFC: IdP-Based Authentication & Permission Filtering for Search-AI

**Status:** Draft
**Author:** ABL Platform Team
**Date:** 2026-03-03
**Target Release:** TBD

---

## Executive Summary

This RFC proposes adding **Identity Provider (IdP) based authentication** to Search-AI query routes while maintaining backward compatibility with the existing public search mode. The system will enforce **document-level permissions** at query time by combining platform authentication with end-user identity verification.

### Two-Layer Authentication Model

**Layer 1 — Platform Authentication** (existing):

- Validates that the **calling application** has access to the tenant/index
- Uses API keys (`Authorization: Bearer abl_sk_*`) or User JWTs
- Enforces tenant isolation (cryptographically bound)

**Layer 2 — End-User Identity** (new):

- Validates **which end user** is making the request
- Uses IdP tokens from Azure AD, Okta, or Google (`X-End-User-Token` header)
- Resolves user's group memberships from Neo4j
- Filters OpenSearch results to documents user has access to

### Key Benefits

✅ **Security & Compliance:**

- Document-level access control (least privilege)
- Leverages existing SharePoint/Drive ACLs crawled into Neo4j
- Prevents unauthorized access to sensitive documents
- Audit trail of who accessed what

✅ **Backward Compatibility:**

- Zero breaking changes — defaults to public mode
- Opt-in via `X-Auth-Mode: user` header
- Existing API keys and JWTs continue to work

✅ **Performance:**

- Query latency target: <500ms (P95)
- Redis caching for group memberships (5-min TTL, 95% hit rate)
- JWKS caching for IdP public keys (1-hour TTL)
- No re-indexing required when group memberships change

✅ **Multi-Tenant & Multi-IdP:**

- Supports multiple tenants with different IdP providers
- Works with Azure AD, Okta, Google (standard OIDC/SAML)
- Tenant isolation enforced at platform and end-user layers

### Implementation Scope

**Timeline:** 8-9 weeks (5 weeks development + 3-4 weeks testing/rollout)

**Revised from 6 weeks:** Gap analysis revealed missing IdP sync workers (+2-3 weeks)

**New Components (8 total):**

**Authentication & Query (Week 1-2):**

- IdP token validator (JWKS-based JWT verification with Redis cache)
- Permission filter service (Neo4j group resolution + OpenSearch filtering)
- Permission filter middleware (X-Auth-Mode routing)
- Group membership cache (Redis with 5-min TTL)

**IdP Integration Workers (Week 3-5) — ⚠️ CRITICAL GAP IDENTIFIED:**

- Azure AD user sync worker (Microsoft Graph API integration)
- Azure AD group sync worker (group + membership sync)
- Okta user/group sync workers (Okta API integration)
- Google user/group sync workers (Directory API integration)

**Note:** Neo4j permission graph client is **RFC-ready** (verified via gap analysis). The gap is purely in IdP sync workers to populate User/Group nodes.

**Supporting Services:**

- Document permission resolver (embedding worker integration)
- Permission re-sync API (manual + scheduled)
- Domain verification workflow (IdP trust for MVP)

**Database Changes:**

- OpenSearch: Add `permissions` field to chunk schema mapping
- Neo4j: Leverage existing permission graph ✅ **NO CHANGES** (schema 100% RFC-compliant)
- MongoDB: No changes (tenant isolation already enforced)

**No New Infrastructure Required:**

- Reuses existing Neo4j permission graph (verified via test coverage)
- Reuses existing Redis for caching
- Reuses existing OpenSearch indexes

**Pre-Production Simplification:**

Since the product is not yet in production, migration complexity is eliminated:

- ❌ No backfill script needed (recreate indexes with new mapping)
- ❌ No index versioning required (no production data to migrate)
- ❌ No zero-downtime migration strategy needed
- ✅ Simply update mapping template and recreate dev/staging indexes

**See Also:**

- `RFC-SEARCHAI-IDP-AUTHENTICATION-GAP-ANALYSIS.md` — Detailed gap analysis with 23 affected files
- `RFC-SEARCHAI-IDP-AUTHENTICATION-MIGRATION-ANALYSIS.md` — Pre-production vs production migration strategies

---

## High-Level Authentication Flow

### Query Flow with End-User Identity

```
┌──────────────┐
│ End User     │ (alice@company.com logged into internal portal)
│ Application  │
└──────┬───────┘
       │ 1. User searches "Q4 budget" in company intranet
       │
       ▼
┌──────────────────────────────────────────────────────────────────┐
│  Custom Application (Intranet Portal)                             │
│  ┌────────────────────────────────────────────────────────────┐  │
│  │ Portal Backend                                             │  │
│  │ - Has platform API key: abl_sk_prod_xyz123                │  │
│  │ - Has end-user session with Azure AD token                │  │
│  └────────────────────────────────────────────────────────────┘  │
└──────┬───────────────────────────────────────────────────────────┘
       │ 2. Portal makes search API call with BOTH credentials
       │
       ▼
┌──────────────────────────────────────────────────────────────────┐
│  POST /api/search/idx_abc123/query                               │
│                                                                   │
│  Headers:                                                         │
│    Authorization: Bearer abl_sk_prod_xyz123  ← Platform auth     │
│    X-Auth-Mode: user                          ← Enable user mode │
│    X-End-User-Token: <Azure AD JWT>          ← End-user identity│
│                                                                   │
│  Body:                                                            │
│    { "query": "Q4 budget", "queryType": "vector" }               │
└──────┬───────────────────────────────────────────────────────────┘
       │
       ▼
┌──────────────────────────────────────────────────────────────────┐
│  Search-AI-Runtime (apps/search-ai-runtime/, port 3004)          │
│                                                                   │
│  ┌─────────────────────────────────────────────────────────────┐ │
│  │ LAYER 1: Platform Authentication (existing)                 │ │
│  │ ────────────────────────────────────────────────────────────│ │
│  │ 1. Verify API key signature (SHA256)                        │ │
│  │ 2. Query ApiKey collection → tenantId: "tenant_abc"         │ │
│  │ 3. Verify API key has access to idx_abc123                  │ │
│  │ 4. Set req.tenantContext = { tenantId: "tenant_abc" }       │ │
│  │                                                              │ │
│  │ ✅ Platform authentication succeeded                         │ │
│  └─────────────────────────────────────────────────────────────┘ │
│                                                                   │
│  ┌─────────────────────────────────────────────────────────────┐ │
│  │ LAYER 2: End-User Identity Verification (NEW)              │ │
│  │ ────────────────────────────────────────────────────────────│ │
│  │ 1. Check X-Auth-Mode header → "user"                        │ │
│  │ 2. Extract X-End-User-Token → Azure AD JWT                  │ │
│  │                                                              │ │
│  │ IdPTokenValidator:                                           │ │
│  │   3. Decode JWT header → iss, kid                           │ │
│  │   4. Get JWKS from Redis cache or fetch from Azure AD       │ │
│  │   5. Verify JWT signature using JWKS public key             │ │
│  │   6. Validate exp, iss, aud claims                          │ │
│  │   7. Extract email: alice@company.com                       │ │
│  │                                                              │ │
│  │ ✅ End-user identity verified                                │ │
│  │ req.userIdentity = { email: "alice@company.com" }           │ │
│  └─────────────────────────────────────────────────────────────┘ │
│                                                                   │
│  ┌─────────────────────────────────────────────────────────────┐ │
│  │ STEP 3: Permission Resolution                               │ │
│  │ ────────────────────────────────────────────────────────────│ │
│  │ PermissionFilterService:                                     │ │
│  │   1. Check Redis cache for user's groups:                   │ │
│  │      Key: "searchai:groups:tenant_abc:alice@company.com"    │ │
│  │                                                              │ │
│  │   2. If CACHE MISS → Query Neo4j:                           │ │
│  │      MATCH (u:User {email: "alice@company.com"})            │ │
│  │            -[:MEMBER_OF*1..20]->(g:Group)                   │ │
│  │      RETURN g.groupId                                        │ │
│  │                                                              │ │
│  │      Result: ["azuread:g_finance", "azuread:g_employees"]   │ │
│  │                                                              │ │
│  │   3. Cache result in Redis (5-min TTL)                      │ │
│  │                                                              │ │
│  │   4. Build OpenSearch permission filter:                    │ │
│  │      {                                                       │ │
│  │        "bool": {                                             │ │
│  │          "should": [                                         │ │
│  │            { "term": { "permissions.publicEverywhere": true }},│ │
│  │            { "term": { "permissions.allowedUsers":           │ │
│  │                        "alice@company.com" }},               │ │
│  │            { "terms": { "permissions.allowedGroups":         │ │
│  │                         ["azuread:g_finance",                │ │
│  │                          "azuread:g_employees"] }}           │ │
│  │          ],                                                  │ │
│  │          "minimum_should_match": 1                           │ │
│  │        }                                                     │ │
│  │      }                                                       │ │
│  └─────────────────────────────────────────────────────────────┘ │
│                                                                   │
│  ┌─────────────────────────────────────────────────────────────┐ │
│  │ STEP 4: Query Pipeline (with permission filter)            │ │
│  │ ────────────────────────────────────────────────────────────│ │
│  │ 1. Generate query embedding (BGE-M3)                        │ │
│  │ 2. OpenSearch k-NN search with permission filter:           │ │
│  │    {                                                         │ │
│  │      "query": {                                              │ │
│  │        "bool": {                                             │ │
│  │          "must": [                                           │ │
│  │            { "knn": { "vector": [...], "k": 10 } }          │ │
│  │          ],                                                  │ │
│  │          "filter": <permission filter from step 3>           │ │
│  │        }                                                     │ │
│  │      }                                                       │ │
│  │    }                                                         │ │
│  │ 3. OpenSearch returns only chunks Alice can access          │ │
│  │ 4. Rerank results                                            │ │
│  │ 5. Return to application                                     │ │
│  └─────────────────────────────────────────────────────────────┘ │
└──────┬───────────────────────────────────────────────────────────┘
       │
       ▼
┌──────────────────────────────────────────────────────────────────┐
│  Response:                                                        │
│  {                                                                │
│    "results": [                                                   │
│      {                                                            │
│        "content": "Q4 budget approved at $2.5M...",              │
│        "source": "Finance/Budget_Q4.pdf",                        │
│        "score": 0.89                                              │
│        // Alice has access via azuread:g_finance group           │
│      },                                                           │
│      {                                                            │
│        "content": "Q4 OKRs for engineering team...",             │
│        "source": "Engineering/OKRs_Q4.docx",                     │
│        "score": 0.85                                              │
│        // Alice has access via publicInDomain=true               │
│      }                                                            │
│      // HR Salaries doc was filtered out (Alice not in HR group) │
│    ]                                                              │
│  }                                                                │
└──────────────────────────────────────────────────────────────────┘
```

### Public Mode Flow (Backward Compatible)

```
┌──────────────┐
│ Application  │
└──────┬───────┘
       │
       ▼
┌──────────────────────────────────────────────────────────────────┐
│  POST /api/search/idx_abc123/query                               │
│                                                                   │
│  Headers:                                                         │
│    Authorization: Bearer abl_sk_prod_xyz123  ← Platform auth     │
│    (no X-Auth-Mode header, defaults to public)                   │
│                                                                   │
│  Body:                                                            │
│    { "query": "company handbook", "queryType": "vector" }        │
└──────┬───────────────────────────────────────────────────────────┘
       │
       ▼
┌──────────────────────────────────────────────────────────────────┐
│  Search-AI-Runtime                                               │
│                                                                   │
│  1. Platform authentication (same as before)                      │
│  2. No X-Auth-Mode → defaults to public mode                     │
│  3. Permission filter:                                            │
│     { "term": { "permissions.publicEverywhere": true } }         │
│  4. Returns ONLY public documents                                │
└──────┬───────────────────────────────────────────────────────────┘
       │
       ▼
┌──────────────────────────────────────────────────────────────────┐
│  Response: Only public documents (backward compatible)           │
└──────────────────────────────────────────────────────────────────┘
```

### IdP Sync Flow (Background Process)

```
┌──────────────────────────────────────────────────────────────────┐
│  PREREQUISITE: IdP Sync Workers (NEW - GAP IDENTIFIED)          │
│  ──────────────────────────────────────────────────────────────  │
│  These workers populate Neo4j User/Group nodes from IdP          │
└──────────────────────────────────────────────────────────────────┘

┌──────────────┐
│ Azure AD     │ (Microsoft Graph API)
│ Tenant       │
└──────┬───────┘
       │ Scheduled daily sync (12:00 AM UTC)
       │
       ▼
┌──────────────────────────────────────────────────────────────────┐
│  azuread-user-sync-worker (apps/search-ai/src/workers/)         │
│  ──────────────────────────────────────────────────────────────  │
│  1. Get tenant's Azure AD credentials from LLMCredential         │
│  2. Fetch users from Microsoft Graph API (paginated):            │
│     GET /v1.0/users?$select=id,mail,displayName                  │
│  3. Batch upsert to Neo4j (100 users per batch):                 │
│     CREATE User nodes with email, idpUserId, idpProvider         │
│                                                                   │
│  Result: User nodes created/updated in Neo4j                     │
└──────────────────────────────────────────────────────────────────┘

┌──────────────────────────────────────────────────────────────────┐
│  azuread-group-sync-worker                                       │
│  ──────────────────────────────────────────────────────────────  │
│  1. Fetch security groups from Microsoft Graph API:              │
│     GET /v1.0/groups?$filter=securityEnabled eq true             │
│  2. For each group, fetch members:                               │
│     GET /v1.0/groups/{groupId}/members                           │
│  3. Create Group nodes in Neo4j with groupId: "azuread:g_*"      │
│  4. Create MEMBER_OF relationships (User → Group, Group → Group) │
│                                                                   │
│  Result: Group nodes + MEMBER_OF relationships in Neo4j          │
└──────────────────────────────────────────────────────────────────┘

┌──────────────────────────────────────────────────────────────────┐
│  Neo4j Permission Graph (packages/search-ai-internal/)           │
│  ──────────────────────────────────────────────────────────────  │
│  ✅ Nodes populated by IdP sync workers:                         │
│     - User(email: "alice@company.com", idpProvider: "azuread")   │
│     - Group(groupId: "azuread:g_finance")                        │
│     - MEMBER_OF: (User)-[:MEMBER_OF]->(Group)                    │
│                                                                   │
│  ✅ Nodes populated by connector permission crawl (existing):    │
│     - Document(documentId: "doc_123", publicInDomain: true)      │
│     - HAS_PERMISSION: (Group)-[:HAS_PERMISSION]->(Document)      │
│                                                                   │
│  Ready for query-time permission resolution!                     │
└──────────────────────────────────────────────────────────────────┘
```

### Key Takeaways from Authentication Flow

1. **Two independent auth layers:**
   - Platform auth (tenant/index access) — existing, unchanged
   - End-user identity (document permissions) — new, opt-in

2. **Three data sources:**
   - **MongoDB ApiKey** → tenant access (platform auth)
   - **Neo4j User/Group** → group memberships (end-user permissions)
   - **OpenSearch permissions field** → pre-computed document ACLs

3. **Performance critical path:**
   - Redis cache hit → 20ms overhead (95% of requests)
   - Redis cache miss → 100ms overhead (Neo4j query)
   - Circuit breaker on Neo4j → fallback to public mode

4. **Missing components (identified via gap analysis):**
   - ⚠️ IdP sync workers (Azure AD, Okta, Google) — **CRITICAL**
   - ⚠️ IdP token validator (JWKS verification) — **CRITICAL**
   - ⚠️ Permission filter service — **CRITICAL**
   - Domain verification workflow — **MEDIUM**
   - Permission re-sync API — **MEDIUM**

**See `RFC-SEARCHAI-IDP-AUTHENTICATION-GAP-ANALYSIS.md` for detailed implementation plan.**

---

## Table of Contents

1. [Background](#background)
2. [Motivation](#motivation)
3. [Design Overview](#design-overview)
4. [Authentication Modes](#authentication-modes)
5. [Architecture](#architecture)
6. [Implementation Details](#implementation-details)
7. [API Changes](#api-changes)
8. [Permission Resolution](#permission-resolution)
9. [Performance Optimizations](#performance-optimizations)
10. [Security Considerations](#security-considerations)
11. [Migration Strategy](#migration-strategy)
12. [Testing Strategy](#testing-strategy)
13. [Rollout Plan](#rollout-plan)
14. [Alternatives Considered](#alternatives-considered)

---

## Background

### Current State

**Search-AI Architecture:**

```
┌─────────────────────────────────────────────────────────────────┐
│  Developer Users (Studio)  │  End Users (Custom Applications)   │
│  - Configure indexes        │  - Search via API                  │
│  - Upload documents         │  - Authenticate via IdP            │
│  - Admin operations         │  - Query documents                 │
└─────────────────────────────────────────────────────────────────┘
                    │                              │
                    ▼                              ▼
              Search-AI (3005)          Search-AI-Runtime (3004)
              Ingestion (admin)         Query execution (public API)
                    │                              │
                    └──────────────────┬───────────┘
                                       ▼
                          OpenSearch + MongoDB + Neo4j
```

**Current Authentication (Platform Layer):**

Search-AI-Runtime uses **Unified Auth Middleware** (`@agent-platform/shared`) with three authentication flows:

1. **API Key Flow** (most common for public API access):
   - Format: `Authorization: Bearer abl_sk_<env>_<random>`
   - API keys are stored in `ApiKey` collection with SHA256 hash
   - Each key is permanently bound to a **tenantId**
   - Keys include: scopes, projectIds, environments, expiration, revocation
   - Example: `abl_sk_prod_abc123xyz`

2. **User JWT Flow** (for platform users accessing Studio/Admin):
   - Format: `Authorization: Bearer <jwt>`
   - JWT contains: `{ sub: userId, tenantId, orgId }`
   - Verifies user is member of tenant via `TenantMember` collection
   - Returns 403 if user not member of specified tenant

3. **SDK Session Flow** (for runtime agent sessions):
   - Format: `X-SDK-Token: <token>`
   - Used by agent runtime, not relevant for Search-AI

**Tenant Isolation Mechanism:**

```typescript
// API Key Flow (apps/search-ai-runtime/src/middleware/auth.ts:88-106)
const keyHash = crypto.createHash('sha256').update(rawKey).digest('hex');
const apiKey = await ApiKey.findOne({ keyHash, revokedAt: null });
// ↑ apiKey.tenantId is the ONLY source of truth for tenant access
// Headers like X-Tenant-Id are NEVER trusted (line 348-350 in unified-auth.ts)

req.tenantContext = {
  tenantId: apiKey.tenantId, // ← Verified tenant access
  scopes: apiKey.scopes,
  projectIds: apiKey.projectIds,
};
```

**Current Limitation:**

- ✅ **Platform authentication works** — validates tenant access via API keys
- ❌ **No end-user identity awareness** — all API key holders see ALL documents in the index
- ❌ **Document-level permissions ignored** — Neo4j permission graph exists but not used at query time
- ❌ **Compliance risk** — sensitive SharePoint/Drive documents visible to all tenant members

**Existing Permission Infrastructure:**

- Neo4j graph stores document permissions from SharePoint/Google Drive connectors
- Permission crawler populates: Users, Groups, Documents, MEMBER_OF, HAS_PERMISSION relationships
- Graph supports transitive group membership queries
- **However:** Query pipeline doesn't use this data

### Problem Statement

**Current limitations:**

1. **No document-level security** — all users see all documents in an index
2. **Connector permissions ignored** — SharePoint/Drive ACLs are crawled but not enforced
3. **Compliance risk** — sensitive documents from connectors are visible to unauthorized users

---

## Motivation

### Use Cases

**UC-1: Enterprise Intranet Search**

- Company builds an intranet portal using Search-AI APIs
- Employees authenticate via Azure AD SSO in the portal
- Portal calls Search-AI-Runtime with employee's IdP token
- Results are filtered to SharePoint documents the employee can access

**UC-2: Multi-Tenant SaaS Application**

- SaaS company builds a product with embedded search
- End customers authenticate via the SaaS app (Okta/Google)
- SaaS app calls Search-AI-Runtime with end user's IdP token
- Each end user sees only documents they have permission to access

**UC-3: Public Documentation + Private Content**

- Company has a docs site with public articles + private internal docs
- Public articles: anonymous access (no IdP token)
- Private docs: requires employee login, filters by user permissions
- Same search index, different access modes

### Benefits

1. **Security & Compliance** — enforce least-privilege access at query time
2. **Unified Search** — search across public content + user's private documents
3. **Zero Trust Architecture** — validate permissions on every query
4. **Audit Trail** — log which user accessed which documents

---

## Design Overview

### High-Level Approach

**Two Authentication Modes:**

| Mode                 | Token Required  | Behavior                                  |
| -------------------- | --------------- | ----------------------------------------- |
| **public** (default) | No              | Returns only `publicEverywhere` documents |
| **user**             | Yes (IdP token) | Returns documents user has access to      |

**Permission Resolution Flow:**

```
1. Extract user email from IdP token (SAML/OIDC)
2. Query Neo4j for user's groups (direct + transitive)
3. Construct OpenSearch filter: (publicEverywhere OR user_email OR user_groups)
4. Execute vector search with permission filter
5. Return filtered results
```

**Backward Compatibility:**

- Existing API behavior unchanged (defaults to `public` mode)
- No breaking changes to request/response schemas
- Opt-in via new header: `X-Auth-Mode: user`

---

## Two-Layer Authentication Model

This RFC introduces a **two-layer authentication system** that separates platform access from end-user identity:

### Layer 1: Platform Authentication (Existing)

**Purpose:** Verify that the **calling application** has access to the tenant/index.

**Header:** `Authorization: Bearer <token>`

**Token Types:**

1. **API Key** (recommended for end-user applications):
   - Format: `abl_sk_prod_<random>` or `abl_pk_prod_<random>`
   - Stored in `ApiKey` collection with SHA256 hash
   - Permanently bound to a `tenantId`
   - Includes scopes (e.g., `['search:read', 'search:query']`)
   - Optional project/environment restrictions

2. **User JWT** (for platform users):
   - Format: Standard JWT with claims `{ sub: userId, tenantId, orgId }`
   - Verifies user is member of tenant via `TenantMember` lookup
   - Used by Studio/Admin UI, not typically by end-user applications

**Enforcement:**

```typescript
// Tenant isolation is enforced at platform layer
const apiKey = await ApiKey.findOne({ keyHash, revokedAt: null });
if (!apiKey) return 401; // Invalid API key

// tenantId comes ONLY from verified credential (never from headers)
req.tenantContext.tenantId = apiKey.tenantId;

// All downstream queries are automatically scoped to this tenant
```

**Security Properties:**

- ✅ Prevents cross-tenant access (API key bound to tenant)
- ✅ Cannot be bypassed via headers (X-Tenant-Id ignored)
- ✅ Supports revocation and expiration
- ✅ Granular scopes and project restrictions

---

### Layer 2: End-User Identity (New)

**Purpose:** Identify **which end user** is making the request to filter documents by their permissions.

**Header:** `X-End-User-Token: <idp-jwt>`

**Token Format:**

- SAML assertion or OIDC ID token (JWT) from IdP
- Contains user identity claims: `email`, `sub`, `name`, etc.
- Issued by: Azure AD, Okta, Google, or other OIDC providers
- **NOT** issued by ABL Platform (issued by customer's IdP)

**Validation:**

```typescript
// apps/search-ai-runtime/src/middleware/idp-auth.ts
async function validateIdPToken(token: string): Promise<UserIdentity> {
  // 1. Decode JWT without verification (to get issuer)
  const decoded = jwt.decode(token, { complete: true });

  // 2. Detect IdP provider from issuer claim
  const provider = detectIdPProvider(decoded.payload.iss);
  // Examples:
  // - "https://login.microsoftonline.com/{tenant}/v2.0" → azuread
  // - "https://{domain}.okta.com" → okta
  // - "https://accounts.google.com" → google

  // 3. Fetch JWKS keys from IdP's well-known endpoint
  const jwks = await fetchJWKS(provider);

  // 4. Verify JWT signature using JWKS
  const verified = await jose.jwtVerify(token, jwks);

  // 5. Extract email from standard claims
  const email =
    verified.payload.email ||
    verified.payload.preferred_username || // Azure AD
    verified.payload.upn; // Alternative

  return {
    email: email.toLowerCase(),
    idpProvider: provider,
    idpUserId: verified.payload.sub,
    displayName: verified.payload.name,
  };
}
```

**Usage in Query Pipeline:**

```typescript
// Extract end-user identity (if provided)
const userIdentity = req.userIdentity; // Set by idpAuthMiddleware

if (userIdentity) {
  // Resolve user's groups from Neo4j
  const groups = await permissionFilterService.getUserGroups(tenantId, userIdentity.email);

  // Apply permission filter to OpenSearch query
  query.filter = {
    bool: {
      should: [
        { term: { 'permissions.publicEverywhere': true } },
        { term: { 'permissions.allowedUsers': userIdentity.email } },
        { terms: { 'permissions.allowedGroups': groups } },
      ],
      minimum_should_match: 1,
    },
  };
}
```

**Security Properties:**

- ✅ IdP signature verification (JWKS-based)
- ✅ Supports multiple IdP providers (Azure AD, Okta, Google)
- ✅ No shared secrets (public key verification)
- ✅ Standard OIDC/SAML flows
- ✅ Optional (graceful degradation to public mode)

---

### Combined Flow Example

```http
POST /api/search/idx_abc123/query
Authorization: Bearer abl_sk_prod_xyz123       ← Layer 1: Platform auth (tenant access)
X-Auth-Mode: user                              ← Enable end-user filtering
X-End-User-Token: eyJhbGci...                  ← Layer 2: End-user identity
Content-Type: application/json

{
  "query": "Q3 financial report",
  "queryType": "vector",
  "topK": 10
}
```

**Processing Steps:**

1. **Platform auth** (existing): Verify `abl_sk_prod_xyz123` → extract `tenantId`
2. **End-user auth** (new): Verify `X-End-User-Token` → extract `email`
3. **Group resolution** (new): Query Neo4j → get user's groups
4. **Permission filter** (new): Inject into OpenSearch query
5. **Execute query**: Vector search with permission filter
6. **Return results**: Only documents user has access to

**Key Insight:**

- **Layer 1** answers: "Does this application have access to this tenant's data?"
- **Layer 2** answers: "Which documents can this end user see?"
- Both layers are independent and complementary

---

## Authentication Modes

### Mode 1: Public Search (Existing)

**Description:** Returns only documents marked as `publicEverywhere`.

**Use Cases:**

- Unauthenticated users
- Public knowledge base searches
- Anonymous API access

**Request:**

```http
POST /api/search/:indexId/query
Authorization: Bearer <api-key-or-jwt>
Content-Type: application/json

{
  "query": "How do I reset my password?",
  "queryType": "vector",
  "topK": 10
}
```

**Authorization Header Options:**

- API Key: `Bearer abl_sk_...` — For service-to-service calls
- JWT: `Bearer eyJhbGci...` — For authenticated users (platform users, not end users)

**Filter Applied:**

```json
{
  "term": {
    "permissions.publicEverywhere": true
  }
}
```

**No Changes Required** — this is the default behavior.

---

### Mode 2: User-Scoped Search (New)

**Description:** Returns documents user has access to based on IdP identity + Neo4j permissions.

**Use Cases:**

- SSO-authenticated users
- Enterprise search with permission enforcement
- Connector-sourced documents (SharePoint, Google Drive)

**Request:**

```http
POST /api/search/:indexId/query
Authorization: Bearer <api-key-or-jwt>
X-Auth-Mode: user
X-End-User-Token: <saml-or-oidc-jwt>
Content-Type: application/json

{
  "query": "Q3 financial report",
  "queryType": "vector",
  "topK": 10
}
```

**Headers:**

- `Authorization: Bearer <token>` — Platform authentication (API key or platform JWT)
- `X-Auth-Mode: user` — Enables user-scoped search
- `X-End-User-Token` — **End user's** SAML assertion or OIDC ID token (JWT from Azure AD/Okta/Google)

**Critical Distinction:**

- `Authorization` header = **Developer/Application** authentication (validates API access)
- `X-End-User-Token` header = **End User** identity (for permission filtering)

**Filter Applied:**

```json
{
  "bool": {
    "should": [
      { "term": { "permissions.publicEverywhere": true } },
      { "term": { "permissions.allowedUsers": "john.doe@company.com" } },
      { "terms": { "permissions.allowedGroups": ["sharepoint:g_123", "sharepoint:g_456"] } }
    ],
    "minimum_should_match": 1
  }
}
```

---

## Architecture

### Component Diagram

```
┌──────────────────────────────────────────────────────────────────────────┐
│                    End-User Application (Web/Mobile)                      │
│                                                                           │
│  1. End user authenticates via company SSO (Azure AD/Okta/Google)         │
│  2. Application receives IdP token from SSO provider                      │
│  3. Application calls Search-AI-Runtime with:                             │
│     - Authorization: Bearer <api-key> (validates app access)              │
│     - X-End-User-Token: <idp-token> (identifies end user)                 │
└──────────────────────────────────────────────────────────────────────────┘
                                    ↓
┌──────────────────────────────────────────────────────────────────────────┐
│                    Search-AI-Runtime Middleware                           │
│                                                                           │
│  ┌────────────────────────────────────────────────────────────────────┐  │
│  │  idpAuthMiddleware                                                  │  │
│  │  - Extract X-Auth-Mode header                                       │  │
│  │  - If mode=user: validate X-IdP-Token                               │  │
│  │  - Extract email from token claims                                  │  │
│  │  - Attach to req.userIdentity                                       │  │
│  └────────────────────────────────────────────────────────────────────┘  │
└──────────────────────────────────────────────────────────────────────────┘
                                    ↓
┌──────────────────────────────────────────────────────────────────────────┐
│                       Query Pipeline (Enhanced)                           │
│                                                                           │
│  ┌────────────────────────────────────────────────────────────────────┐  │
│  │  Step 1: Check auth mode                                            │  │
│  │  - If mode=public: inject publicEverywhere filter                   │  │
│  │  - If mode=user: call PermissionFilterService                       │  │
│  └────────────────────────────────────────────────────────────────────┘  │
│                                                                           │
│  ┌────────────────────────────────────────────────────────────────────┐  │
│  │  PermissionFilterService                                            │  │
│  │  1. Check GroupCache for cached groups                              │  │
│  │  2. If miss: query Neo4j for user groups                            │  │
│  │  3. Construct OpenSearch filter                                     │  │
│  │  4. Cache groups (5-min TTL)                                        │  │
│  └────────────────────────────────────────────────────────────────────┘  │
│                                                                           │
│  ┌────────────────────────────────────────────────────────────────────┐  │
│  │  Step 2-6: Execute query pipeline (unchanged)                       │  │
│  │  - Vocabulary resolution                                            │  │
│  │  - Query embedding                                                  │  │
│  │  - Vector search (with permission filter)                           │  │
│  │  - Reranking                                                        │  │
│  │  - Format & return                                                  │  │
│  └────────────────────────────────────────────────────────────────────┘  │
└──────────────────────────────────────────────────────────────────────────┘
                                    ↓
┌──────────────────────────────────────────────────────────────────────────┐
│                        Neo4j Permission Graph                             │
│                                                                           │
│  Query: Get all groups for user                                           │
│  MATCH (u:User {email: $email, tenantId: $tenantId})                      │
│        -[:MEMBER_OF*1..20]->(g:Group)                                     │
│  RETURN DISTINCT g.groupId                                                │
│                                                                           │
│  Result: ["sharepoint:g_123", "okta:g_456"]                               │
└──────────────────────────────────────────────────────────────────────────┘
                                    ↓
┌──────────────────────────────────────────────────────────────────────────┐
│                           OpenSearch                                      │
│                                                                           │
│  Vector search with permission filter:                                    │
│  {                                                                        │
│    "query": {                                                             │
│      "bool": {                                                            │
│        "must": [ /* vector query */ ],                                    │
│        "filter": {                                                        │
│          "bool": {                                                        │
│            "should": [                                                    │
│              { "term": { "permissions.publicEverywhere": true } },        │
│              { "term": { "permissions.allowedUsers": "user@..." } },      │
│              { "terms": { "permissions.allowedGroups": [...] } }          │
│            ]                                                              │
│          }                                                                │
│        }                                                                  │
│      }                                                                    │
│    }                                                                      │
│  }                                                                        │
└──────────────────────────────────────────────────────────────────────────┘
```

---

## Implementation Details

### 1. IdP Token Validation

**File:** `apps/search-ai-runtime/src/middleware/idp-auth.ts`

```typescript
import { Request, Response, NextFunction } from 'express';
import { AppError, ErrorCodes } from '@agent-platform/shared/errors';

export interface UserIdentity {
  email: string;
  idpProvider: 'azuread' | 'okta' | 'google';
  idpUserId: string;
  displayName?: string;
}

export interface AuthenticatedRequest extends Request {
  authMode: 'public' | 'user';
  userIdentity?: UserIdentity;
}

export async function idpAuthMiddleware(
  req: Request,
  res: Response,
  next: NextFunction,
): Promise<void> {
  const authMode = req.header('X-Auth-Mode') || 'public';

  // Validate auth mode
  if (authMode !== 'public' && authMode !== 'user') {
    throw new AppError('Invalid X-Auth-Mode header', { ...ErrorCodes.BAD_REQUEST });
  }

  (req as AuthenticatedRequest).authMode = authMode;

  // Public mode: no end-user token required
  if (authMode === 'public') {
    return next();
  }

  // User mode: validate end-user IdP token
  const endUserToken = req.header('X-End-User-Token');
  if (!endUserToken) {
    throw new AppError('X-End-User-Token header required for user mode', {
      ...ErrorCodes.UNAUTHORIZED,
    });
  }

  try {
    // Validate and extract end-user identity
    const userIdentity = await validateIdPToken(endUserToken);
    (req as AuthenticatedRequest).userIdentity = userIdentity;
    next();
  } catch (error) {
    throw new AppError('Invalid end-user IdP token', { ...ErrorCodes.UNAUTHORIZED });
  }
}

async function validateIdPToken(token: string): Promise<UserIdentity> {
  // Step 1: Decode JWT
  const decoded = decodeJWT(token);

  // Step 2: Determine IdP provider from issuer
  const provider = detectIdPProvider(decoded.iss);

  // Step 3: Verify signature (JWKS endpoint)
  await verifyJWTSignature(token, provider);

  // Step 4: Extract email from claims
  const email = extractEmail(decoded, provider);

  return {
    email: email.toLowerCase(),
    idpProvider: provider,
    idpUserId: decoded.sub || decoded.oid || decoded.nameid,
    displayName: decoded.name || decoded.displayName,
  };
}

function detectIdPProvider(issuer: string): 'azuread' | 'okta' | 'google' {
  if (issuer.includes('login.microsoftonline.com')) return 'azuread';
  if (issuer.includes('okta.com')) return 'okta';
  if (issuer.includes('accounts.google.com')) return 'google';
  throw new Error('Unsupported IdP provider');
}

function extractEmail(decoded: any, provider: string): string {
  // OIDC standard claim
  if (decoded.email) return decoded.email;

  // Azure AD fallback
  if (provider === 'azuread' && decoded.preferred_username) {
    return decoded.preferred_username;
  }

  // SAML NameID fallback
  if (decoded.nameid) return decoded.nameid;

  throw new Error('Email not found in IdP token');
}

async function verifyJWTSignature(token: string, provider: string): Promise<void> {
  // Implementation: Fetch JWKS and verify signature
  // Use jose library for JWT verification
  // Cache JWKS keys (1 hour TTL)
}
```

---

### 2. Permission Filter Service

**File:** `apps/search-ai-runtime/src/services/permissions/permission-filter.ts`

```typescript
import { PermissionGraphService } from '@agent-platform/search-ai-internal';
import { GroupCache } from './group-cache.js';
import type { UserIdentity } from '../../middleware/idp-auth.js';

export interface PermissionFilter {
  bool: {
    should: Array<{
      term?: Record<string, any>;
      terms?: Record<string, any>;
    }>;
    minimum_should_match: number;
  };
}

export class PermissionFilterService {
  private permissionService: PermissionGraphService;
  private groupCache: GroupCache;

  constructor() {
    this.permissionService = PermissionGraphService.getInstance();
    this.groupCache = new GroupCache();
  }

  /**
   * Build OpenSearch permission filter for user-scoped search
   */
  async buildPermissionFilter(
    tenantId: string,
    userIdentity: UserIdentity,
  ): Promise<PermissionFilter> {
    // Step 1: Get user's groups (with caching)
    const groups = await this.getUserGroups(tenantId, userIdentity.email);

    // Step 2: Construct OpenSearch filter
    return {
      bool: {
        should: [
          // Public documents
          { term: { 'permissions.publicEverywhere': true } },

          // Direct user permission
          { term: { 'permissions.allowedUsers': userIdentity.email } },

          // Group permissions
          { terms: { 'permissions.allowedGroups': groups } },
        ],
        minimum_should_match: 1,
      },
    };
  }

  /**
   * Get all groups for user (direct + transitive)
   * Uses cache to avoid repeated Neo4j queries
   */
  private async getUserGroups(tenantId: string, email: string): Promise<string[]> {
    // Check cache
    const cached = await this.groupCache.get(tenantId, email);
    if (cached) return cached;

    // Query Neo4j
    const groups = await this.permissionService.getUserGroups(tenantId, email);

    // Cache for 5 minutes
    await this.groupCache.set(tenantId, email, groups, 300);

    return groups;
  }

  /**
   * Build filter for public mode (existing behavior)
   */
  buildPublicFilter(): PermissionFilter {
    return {
      bool: {
        should: [{ term: { 'permissions.publicEverywhere': true } }],
        minimum_should_match: 1,
      },
    };
  }
}
```

---

### 3. Group Membership Cache

**File:** `apps/search-ai-runtime/src/services/permissions/group-cache.ts`

```typescript
import { getRedisClient } from '../../services/redis/redis-client.js';

export class GroupCache {
  private redis = getRedisClient();

  /**
   * Get cached groups for user
   */
  async get(tenantId: string, email: string): Promise<string[] | null> {
    const key = this.getCacheKey(tenantId, email);
    const cached = await this.redis.get(key);

    if (!cached) return null;

    return JSON.parse(cached);
  }

  /**
   * Cache groups for user
   */
  async set(tenantId: string, email: string, groups: string[], ttlSeconds: number): Promise<void> {
    const key = this.getCacheKey(tenantId, email);
    await this.redis.setex(key, ttlSeconds, JSON.stringify(groups));
  }

  /**
   * Invalidate cache for user (call when group memberships change)
   */
  async invalidate(tenantId: string, email: string): Promise<void> {
    const key = this.getCacheKey(tenantId, email);
    await this.redis.del(key);
  }

  private getCacheKey(tenantId: string, email: string): string {
    return `searchai:permissions:groups:${tenantId}:${email}`;
  }
}
```

---

### 4. Neo4j Query for User Groups

**File:** `packages/search-ai-internal/src/permissions/permission-graph-client.ts`

Add new method:

```typescript
/**
 * Get all groups for a user (direct + transitive via MEMBER_OF)
 * Returns group IDs in format "source:id" (e.g., "sharepoint:g_123")
 */
async getUserGroups(tenantId: string, email: string): Promise<string[]> {
  const query = `
    MATCH (u:User {tenantId: $tenantId, email: $email})
          -[:MEMBER_OF*1..20]->(g:Group)
    RETURN DISTINCT g.groupId AS groupId
  `;

  const result = await this.session.run(query, {
    tenantId,
    email: email.toLowerCase(),
  });

  return result.records.map((record) => record.get('groupId'));
}
```

---

### 5. Update Query Pipeline

**File:** `apps/search-ai-runtime/src/services/query/query-pipeline.ts`

```typescript
import { PermissionFilterService } from '../permissions/permission-filter.js';
import type { AuthenticatedRequest } from '../../middleware/idp-auth.js';

export class QueryPipeline {
  private permissionFilter: PermissionFilterService;

  constructor() {
    this.permissionFilter = new PermissionFilterService();
  }

  async execute(
    query: VectorSearchQuery,
    tenantId: string,
    callerContext: CallerContext,
    req?: AuthenticatedRequest,
  ): Promise<SearchResponse> {
    const startTime = Date.now();

    // Step 1: Build permission filter
    let permissionFilter: PermissionFilter;

    if (req?.authMode === 'user' && req.userIdentity) {
      // User-scoped search
      permissionFilter = await this.permissionFilter.buildPermissionFilter(
        tenantId,
        req.userIdentity,
      );
    } else {
      // Public search (default)
      permissionFilter = this.permissionFilter.buildPublicFilter();
    }

    // Step 2-6: Execute pipeline with permission filter
    const vocabularyResult = await this.vocabularyResolver.resolve(query.query);
    const embedding = await this.embeddingService.embed(query.query);

    const searchResults = await this.vectorSearch.search({
      indexId: query.indexId,
      tenantId,
      vector: embedding,
      topK: query.topK || 10,
      filters: [
        ...vocabularyResult.filters,
        ...(query.filters || []),
        permissionFilter, // Inject permission filter
      ],
    });

    // ... reranking, formatting, etc.
  }
}
```

---

### 6. OpenSearch Schema Changes

**File:** `packages/search-ai-internal/src/opensearch/schema.ts`

Add `permissions` field to chunk schema:

```typescript
export const CHUNK_INDEX_MAPPING = {
  properties: {
    // ... existing fields (chunkId, content, embedding, metadata, etc.) ...

    permissions: {
      type: 'object',
      properties: {
        // Public access flags
        publicEverywhere: {
          type: 'boolean',
          // true = accessible to all users (no authentication required)
        },
        publicInDomain: {
          type: 'boolean',
          // true = accessible to all users with verified domain email
        },

        // Direct user permissions (array of emails)
        allowedUsers: {
          type: 'keyword',
          // Example: ["john.doe@company.com", "jane.smith@company.com"]
        },

        // Group permissions (array of group IDs)
        allowedGroups: {
          type: 'keyword',
          // Example: ["sharepoint:g_finance", "okta:g_executives", "azuread:role_admin"]
        },

        // Domain-based access (array of verified domains)
        allowedDomains: {
          type: 'keyword',
          // Example: ["company.com", "subsidiary.com"]
        },

        // Source metadata (for debugging)
        source: {
          type: 'keyword',
          // Example: "sharepoint", "google-drive", "manual"
        },
        lastSyncedAt: {
          type: 'date',
          // Last time permissions were synced from source
        },
      },
    },
  },
};
```

**Index Creation:**

```typescript
// Create index with permission-aware mappings
await openSearchClient.indices.create({
  index: `search-chunks-${indexId}`,
  body: {
    mappings: CHUNK_INDEX_MAPPING,
    settings: {
      'index.knn': true,
      'index.knn.algo_param.ef_search': 512,
      number_of_shards: 3,
      number_of_replicas: 1,
    },
  },
});
```

**Example Document:**

```json
{
  "chunkId": "doc_123_chunk_5",
  "content": "Q3 Financial Report - Revenue increased by 23%...",
  "embedding": [0.123, -0.456, ...],
  "metadata": {
    "title": "Q3 Financial Report",
    "sourceType": "sharepoint",
    "sourceId": "sites/finance/Documents/Q3-Report.docx"
  },
  "permissions": {
    "publicEverywhere": false,
    "publicInDomain": false,
    "allowedUsers": ["cfo@company.com", "finance-director@company.com"],
    "allowedGroups": ["sharepoint:g_finance_team", "azuread:role_executives"],
    "allowedDomains": [],
    "source": "sharepoint",
    "lastSyncedAt": "2026-03-03T10:30:00Z"
  }
}
```

**Query with Permission Filter:**

```json
{
  "query": {
    "bool": {
      "must": [
        {
          "knn": {
            "embedding": {
              "vector": [0.234, -0.567, ...],
              "k": 10
            }
          }
        }
      ],
      "filter": {
        "bool": {
          "should": [
            { "term": { "permissions.publicEverywhere": true } },
            { "term": { "permissions.allowedUsers": "john.doe@company.com" } },
            { "terms": { "permissions.allowedGroups": ["sharepoint:g_finance_team"] } }
          ],
          "minimum_should_match": 1
        }
      }
    }
  }
}
```

**Performance Considerations:**

- `keyword` type for exact matching (no tokenization)
- Permission filters executed AFTER vector search (post-filter)
- Index sizes: ~50-100 bytes per chunk for permission metadata
- Query latency impact: <10ms for permission filter evaluation

---

### 7. Populate Permissions at Ingestion

**File:** `apps/search-ai/src/workers/embedding-worker.ts`

Update chunk upsert to include permissions:

```typescript
import { PermissionGraphService } from '@agent-platform/search-ai-internal';

async function upsertChunkToOpenSearch(
  chunk: SearchChunk,
  openSearchClient: OpenSearchClient,
): Promise<void> {
  // Query Neo4j for document permissions
  const permissions = await getDocumentPermissions(chunk.tenantId, chunk.documentId);

  await openSearchClient.index({
    index: getIndexName(chunk.indexId),
    id: chunk.vectorId,
    body: {
      chunkId: chunk._id,
      content: chunk.content,
      embedding: chunk.embedding,
      metadata: chunk.metadata,
      tokenCount: chunk.tokenCount,

      // NEW: Permission metadata
      permissions: {
        publicEverywhere: permissions.publicEverywhere,
        publicInDomain: permissions.publicInDomain,
        allowedUsers: permissions.allowedUsers,
        allowedGroups: permissions.allowedGroups,
        allowedDomains: permissions.allowedDomains,
        source: permissions.source,
        lastSyncedAt: new Date().toISOString(),
      },
    },
  });
}

async function getDocumentPermissions(
  tenantId: string,
  documentId: string,
): Promise<FlattenedPermissions> {
  const permissionService = PermissionGraphService.getInstance();
  return permissionService.getFlattenedPermissions(tenantId, documentId);
}
```

**File:** `packages/search-ai-internal/src/permissions/permission-graph.service.ts`

Add method to flatten Neo4j permissions for OpenSearch:

```typescript
/**
 * Get flattened permissions for a document (for OpenSearch indexing)
 */
async getFlattenedPermissions(
  tenantId: string,
  documentId: string,
): Promise<FlattenedPermissions> {
  const query = `
    MATCH (d:Document {tenantId: $tenantId, documentId: $documentId})

    // Get public access flags from document properties
    WITH d,
         COALESCE(d.publicEverywhere, false) AS publicEverywhere,
         COALESCE(d.publicInDomain, false) AS publicInDomain

    // Get direct user permissions
    OPTIONAL MATCH (d)-[:HAS_PERMISSION]->(u:User)
    WITH d, publicEverywhere, publicInDomain,
         COLLECT(DISTINCT u.email) AS allowedUsers

    // Get group permissions (no need to expand transitively here)
    OPTIONAL MATCH (d)-[:HAS_PERMISSION]->(g:Group)
    WITH d, publicEverywhere, publicInDomain, allowedUsers,
         COLLECT(DISTINCT g.groupId) AS allowedGroups

    RETURN
      publicEverywhere,
      publicInDomain,
      allowedUsers,
      allowedGroups,
      d.source AS source
  `;

  const result = await this.session.run(query, { tenantId, documentId });

  if (result.records.length === 0) {
    // Document not in permission graph — default to public
    return {
      publicEverywhere: true,
      publicInDomain: false,
      allowedUsers: [],
      allowedGroups: [],
      allowedDomains: [],
      source: 'default',
    };
  }

  const record = result.records[0];
  return {
    publicEverywhere: record.get('publicEverywhere'),
    publicInDomain: record.get('publicInDomain'),
    allowedUsers: record.get('allowedUsers'),
    allowedGroups: record.get('allowedGroups'),
    allowedDomains: [], // TODO: Extract from domain verification service
    source: record.get('source') || 'unknown',
  };
}

export interface FlattenedPermissions {
  publicEverywhere: boolean;
  publicInDomain: boolean;
  allowedUsers: string[];      // Direct user emails
  allowedGroups: string[];     // Group IDs (transitive expansion happens at query time)
  allowedDomains: string[];    // Verified domains
  source: string;              // "sharepoint", "google-drive", "manual", etc.
}
```

**Key Design Decision:**

**Why not expand groups transitively at ingestion time?**

- Groups can have 1000s of members (especially company-wide groups)
- Group memberships change frequently (joiners/leavers)
- Re-indexing all documents on membership changes is expensive
- **Solution:** Store group IDs in OpenSearch, expand at query time from Neo4j + cache

**Example Permission Graph:**

```
Document: "Q3 Financial Report"
└─ HAS_PERMISSION → Group: "finance_team"
   └─ MEMBER_OF ← User: john.doe@company.com
   └─ MEMBER_OF ← User: jane.smith@company.com
   └─ MEMBER_OF ← Group: "finance_leadership"
      └─ MEMBER_OF ← User: cfo@company.com
```

**What gets stored in OpenSearch:**

```json
{
  "permissions": {
    "publicEverywhere": false,
    "allowedGroups": ["sharepoint:finance_team"] // ← Only direct group, not members
  }
}
```

**What happens at query time:**

```typescript
// User john.doe@company.com makes a search request
// 1. Query Neo4j: What groups is john.doe member of?
//    Result: ["sharepoint:finance_team"]
// 2. Query OpenSearch: Filter by allowedGroups IN ["sharepoint:finance_team"]
//    Result: Document is returned
```

---

## API Changes

### Request Headers (New)

| Header             | Required    | Values                     | Description                                                |
| ------------------ | ----------- | -------------------------- | ---------------------------------------------------------- |
| `Authorization`    | Yes         | `Bearer <api-key\|jwt>`    | **Platform authentication** (existing)                     |
| `X-Auth-Mode`      | No          | `public` (default), `user` | Authentication mode for document filtering                 |
| `X-End-User-Token` | Conditional | JWT string                 | **End user's** IdP token (required if `X-Auth-Mode: user`) |

### Backward Compatibility

**✅ No breaking changes:**

- Existing requests without `X-Auth-Mode` default to `public` mode
- `Authorization` header validation unchanged (existing JWT/API key flow)
- Response schema unchanged
- Query parameter schema unchanged

**Example Migration:**

**Before (existing - returns all documents):**

```http
POST /api/search/:indexId/query
Authorization: Bearer abl_sk_...    ← API key for platform auth

{ "query": "...", "queryType": "vector" }
```

**After (opt-in to user-scoped search):**

```http
POST /api/search/:indexId/query
Authorization: Bearer abl_sk_...           ← API key (platform auth)
X-Auth-Mode: user                          ← Enable permission filtering
X-End-User-Token: eyJhbGci...              ← End user's Azure AD token

{ "query": "...", "queryType": "vector" }
```

**Example: End-User Application Flow**

```typescript
// End-user application (e.g., company intranet portal)

// Step 1: End user authenticates via Azure AD SSO
const azureToken = await authenticateWithAzureAD(user.email, user.password);

// Step 2: Call Search-AI-Runtime API
const response = await fetch('https://api.abl-platform.com/search/idx_123/query', {
  method: 'POST',
  headers: {
    Authorization: 'Bearer abl_sk_prod_abc123', // Your API key
    'X-Auth-Mode': 'user',
    'X-End-User-Token': azureToken, // End user's Azure AD token
    'Content-Type': 'application/json',
  },
  body: JSON.stringify({
    query: 'Q3 financial report',
    queryType: 'vector',
    topK: 10,
  }),
});

// Step 3: Results filtered to documents user has access to
const results = await response.json();
```

---

## Permission Resolution

### Neo4j Query Performance

**Query:** Get user groups (transitive)

```cypher
MATCH (u:User {tenantId: $tenantId, email: $email})
      -[:MEMBER_OF*1..20]->(g:Group)
RETURN DISTINCT g.groupId
```

**Indexes Required:**

```cypher
CREATE INDEX user_tenant_email IF NOT EXISTS
FOR (u:User) ON (u.tenantId, u.email);

CREATE INDEX group_tenant_id IF NOT EXISTS
FOR (g:Group) ON (g.tenantId, g.groupId);
```

**Performance:**

- **Cold query:** ~50-100ms (100 groups, depth 5)
- **Warm query:** ~10-20ms
- **With caching:** ~1-2ms (Redis lookup)

### Cache Invalidation

**When to invalidate:**

1. User joins/leaves a group (MEMBER_OF relationship added/removed)
2. Group deleted
3. Permission crawl completes (batch invalidate all users)

**Implementation:**

```typescript
// In connector-permission-crawl-worker.ts
async function onPermissionCrawlComplete(tenantId: string): Promise<void> {
  const groupCache = new GroupCache();

  // Invalidate all cached groups for tenant
  await groupCache.invalidateTenant(tenantId);
}
```

---

## Performance Optimizations

### 1. Group Membership Caching

**Strategy:** Cache user groups in Redis with 5-minute TTL

**Benefits:**

- Avoid Neo4j query on every search request
- ~480ms → ~20ms latency improvement

**Cache key pattern:**

```
searchai:permissions:groups:{tenantId}:{email} → ["sharepoint:g_1", "okta:g_2"]
```

**Invalidation triggers:**

- Permission crawl completes
- User/group sync from IdP
- Manual cache clear via admin API

---

### 2. Permission Filter Precompilation

**Strategy:** Pre-compute permission filters at ingestion time

**Approach:**

1. Embedding worker queries Neo4j for document permissions
2. Store flattened permissions in OpenSearch `permissions` field
3. Query pipeline constructs filter from cached data

**Trade-off:**

- ✅ Fast query-time (no Neo4j lookup)
- ❌ Stale permissions until re-index
- **Mitigation:** Periodic re-index (daily) + on-demand re-index API

---

### 3. Batch Permission Resolution

**Strategy:** Resolve permissions for multiple documents in one Neo4j query

**Use case:** Reranking phase (filter out unauthorized results)

**Query:**

```cypher
MATCH (d:Document)
WHERE d.documentId IN $documentIds
  AND d.tenantId = $tenantId
OPTIONAL MATCH (d)<-[:HAS_PERMISSION]-(u:User {email: $userEmail})
OPTIONAL MATCH (d)<-[:HAS_PERMISSION]-(g:Group)<-[:MEMBER_OF*1..20]-(u2:User {email: $userEmail})
RETURN d.documentId,
       CASE WHEN u IS NOT NULL OR g IS NOT NULL THEN true ELSE false END AS hasAccess
```

**Performance:** ~50ms for 100 documents

---

## Security Considerations

### 1. IdP Token Validation

**Threats:**

- Forged tokens
- Expired tokens
- Token replay attacks

**Mitigations:**

- ✅ Verify JWT signature using JWKS
- ✅ Check `exp` claim (expiration)
- ✅ Check `iss` claim (issuer)
- ✅ Validate `aud` claim (audience)
- ❌ **No token replay protection** (stateless JWT, acceptable for search)

---

### 2. Permission Escalation

**Threat:** User modifies `X-Auth-Mode` or `X-IdP-Token` to gain unauthorized access

**Mitigations:**

- ✅ Search-AI-Runtime validates platform auth (existing)
- ✅ Search-AI-Runtime validates end-user IdP token signature (new)
- ✅ Email extracted from verified token claims only
- ✅ Neo4j queries scoped to tenant

---

### 3. Cache Poisoning

**Threat:** Attacker injects malicious group memberships into Redis cache

**Mitigations:**

- ✅ Cache keys include tenant ID (multi-tenant isolation)
- ✅ Cache TTL (5 minutes max staleness)
- ✅ Redis access restricted to internal network
- ✅ Cache invalidation on permission changes

---

### 4. Information Leakage

**Threat:** Error messages reveal unauthorized document existence

**Mitigations:**

- ✅ Unauthorized documents return 404, not 403 (consistent with CLAUDE.md)
- ✅ Search results exclude unauthorized documents (no partial data)
- ✅ Aggregations scoped to accessible documents only

---

### 5. Tenant Isolation (Critical)

**Threat:** Cross-tenant access via token manipulation

**Platform Layer Protections (Existing):**

```typescript
// packages/shared/src/middleware/unified-auth.ts:348-350
// SECURITY: Never read tenant hints from request headers (X-Tenant-Id,
// X-Organization-Id) or query params. TenantId must come exclusively
// from verified credentials (JWT claims, SDK tokens, API key lookups).

// API Key Flow (search-ai-runtime/src/middleware/auth.ts:88-106)
const keyHash = crypto.createHash('sha256').update(rawKey).digest('hex');
const apiKey = await ApiKey.findOne({ keyHash, revokedAt: null });
// ↑ apiKey.tenantId is cryptographically bound to the key

req.tenantContext.tenantId = apiKey.tenantId; // ← ONLY source of truth
```

**End-User Layer Protections (New):**

```typescript
// All Neo4j queries scoped to tenant
const query = `
  MATCH (u:User {tenantId: $tenantId, email: $email})  // ← Tenant filter
        -[:MEMBER_OF*1..20]->(g:Group {tenantId: $tenantId})  // ← Tenant filter
  RETURN DISTINCT g.groupId
`;

// All OpenSearch queries scoped to tenant index
const indexName = `search-chunks-${indexId}`; // Index is tenant-scoped
```

**Enforcement Points:**

1. **API Key → Tenant binding** (immutable, stored in DB)
2. **Neo4j Cypher queries** (all queries include `{tenantId: $tenantId}`)
3. **OpenSearch indexes** (one index per search index, no cross-index queries)
4. **MongoDB queries** (tenant isolation plugin enforces `tenantId` filter)

**Attack Scenarios Prevented:**

- ❌ Attacker cannot forge API key for different tenant (SHA256 hash + DB lookup)
- ❌ Attacker cannot inject `X-Tenant-Id` header (header ignored, only credential matters)
- ❌ Attacker cannot query other tenant's groups in Neo4j (all queries scoped)
- ❌ Attacker cannot see other tenant's documents in OpenSearch (separate indexes)

---

### 6. JWKS Key Caching

**Threat:** Performance degradation from repeated JWKS fetches

**Implementation:**

```typescript
// apps/search-ai-runtime/src/services/jwks/jwks-cache.ts
const jwksCache = new Map<string, { keys: JsonWebKeySet; expiresAt: number }>();

async function fetchJWKS(issuer: string): Promise<JsonWebKeySet> {
  const cached = jwksCache.get(issuer);
  if (cached && cached.expiresAt > Date.now()) {
    return cached.keys;
  }

  // Fetch from IdP's well-known endpoint
  const wellKnown = `${issuer}/.well-known/openid-configuration`;
  const config = await fetch(wellKnown).then((r) => r.json());
  const jwksUri = config.jwks_uri;
  const jwks = await fetch(jwksUri).then((r) => r.json());

  // Cache for 1 hour
  jwksCache.set(issuer, {
    keys: jwks,
    expiresAt: Date.now() + 3600_000,
  });

  return jwks;
}
```

**Security Properties:**

- ✅ Fresh keys fetched if cache expired
- ✅ TTL limits exposure window if keys rotated
- ✅ Per-issuer caching (multi-tenant IdP support)

---

### 7. Rate Limiting & DoS Protection

**Threat:** Excessive permission lookups overwhelm Neo4j/Redis

**Mitigations:**

```typescript
// Rate limit per tenant per user
const rateLimiter = new RateLimiter({
  points: 100, // 100 queries
  duration: 60, // per 60 seconds
  keyPrefix: 'perm',
});

await rateLimiter.consume(`${tenantId}:${userEmail}`);
```

**Additional Protection:**

- Neo4j query timeout: 5 seconds
- Max group depth: 20 levels (prevents infinite loops)
- OpenSearch query timeout: 10 seconds
- Redis connection pooling with max connections

---

## Migration Strategy

### Phase 1: Infrastructure (Week 1)

**Tasks:**

1. Add `permissions` field to OpenSearch schema
2. Implement `idpAuthMiddleware`
3. Implement `PermissionFilterService`
4. Implement `GroupCache`
5. Add Neo4j `getUserGroups()` query

**Validation:**

- Unit tests for all new components
- Integration test: mock IdP token → permission filter

---

### Phase 2: OpenSearch Schema Update (2 Days)

> **Note:** Since the product is not yet in production, we can use a simplified approach instead of complex migration scripts.

**Tasks:**

1. Update OpenSearch mapping template to include `permissions` field
2. Recreate dev/staging indexes with new mapping
3. Update `embedding-worker` to populate `permissions` field on new documents
4. Re-ingest test data with permissions

**Step 1: Update Mapping Template**

**File:** `packages/search-ai-internal/src/vector-store/opensearch-mappings.ts`

```typescript
export const VECTOR_INDEX_MAPPING = {
  settings: {
    /* existing settings */
  },
  mappings: {
    dynamic: 'strict',
    properties: {
      vector: {
        /* existing */
      },
      content: {
        /* existing */
      },
      metadata: {
        /* existing */
      },

      // ✅ NEW: Permission metadata field
      permissions: {
        type: 'object',
        properties: {
          publicEverywhere: { type: 'boolean' },
          publicInDomain: { type: 'boolean' },
          allowedUsers: { type: 'keyword' }, // Array of emails
          allowedGroups: { type: 'keyword' }, // Array of group IDs
          allowedDomains: { type: 'keyword' }, // Array of domains
          source: { type: 'keyword' }, // "sharepoint", "manual"
          lastSyncedAt: { type: 'date' },
        },
      },
    },
  },
};
```

**Step 2: Recreate Indexes**

```bash
# Drop existing dev/staging indexes (no production data)
pnpm run search-ai:drop-indexes --env dev --confirm
pnpm run search-ai:drop-indexes --env staging --confirm

# Recreate with new mapping (uses updated VECTOR_INDEX_MAPPING)
pnpm run search-ai:create-indexes --env dev
pnpm run search-ai:create-indexes --env staging

# Verify permissions field exists in mapping
curl -X GET "localhost:9200/search-chunks-*/_mapping" | jq '.*.mappings.properties.permissions'
```

**Step 3: Update Embedding Worker**

**File:** `apps/search-ai/src/workers/embedding-worker.ts`

```typescript
async function upsertChunkToOpenSearch(chunk: SearchChunk): Promise<void> {
  // Query Neo4j for document permissions
  const permissions = await getDocumentPermissions(chunk.tenantId, chunk.documentId);

  await openSearchClient.index({
    index: getIndexName(chunk.indexId),
    id: chunk.vectorId,
    body: {
      vector: chunk.embedding,
      content: chunk.content,
      metadata: chunk.metadata,

      // ✅ NEW: Populate permissions on index
      permissions: {
        publicEverywhere: permissions.publicEverywhere,
        publicInDomain: permissions.publicInDomain,
        allowedUsers: permissions.allowedUsers,
        allowedGroups: permissions.allowedGroups,
        allowedDomains: permissions.allowedDomains,
        source: permissions.source,
        lastSyncedAt: new Date().toISOString(),
      },
    },
  });
}

async function getDocumentPermissions(
  tenantId: string,
  documentId: string,
): Promise<FlattenedPermissions> {
  const permissionService = PermissionGraphService.getInstance();
  return permissionService.getFlattenedPermissions(tenantId, documentId);
}
```

**Step 4: Re-ingest Test Data**

```bash
# Ingest sample documents (permissions will be populated automatically)
pnpm run search-ai:ingest-sample-docs --env dev --count 100

# Verify permissions are populated
curl -X GET "localhost:9200/search-chunks-dev-*/_search?size=1" | \
  jq '.hits.hits[0]._source.permissions'

# Expected output:
# {
#   "publicEverywhere": true,
#   "allowedUsers": [],
#   "allowedGroups": [],
#   "source": "manual",
#   "lastSyncedAt": "2026-03-03T10:30:00Z"
# }
```

**Validation:**

- ✅ Mapping includes `permissions` field
- ✅ New documents have permissions populated
- ✅ Neo4j permissions match OpenSearch permissions
- ✅ Test queries with permission filtering work

**For Future Production Deployment:**

If production data exists at GA launch, use the migration strategy documented in:
`docs/plans/RFC-SEARCHAI-IDP-AUTHENTICATION-MIGRATION-ANALYSIS.md`

This includes:

- Backfill script with checkpoints
- Index versioning (v1 → v2)
- Zero-downtime cutover
- Rollback capability

---

### Phase 2B: IdP User Sync Workers (Week 3-4) — ⚠️ NEW PHASE (GAP IDENTIFIED)

**Background:** Gap analysis revealed that while Neo4j permission graph is 100% RFC-ready, no IdP sync workers exist to populate User/Group nodes from Azure AD, Okta, or Google.

**Tasks:**

**Week 3: Azure AD Integration (MVP)**

1. **azuread-user-sync-worker.ts** (NEW FILE)
   - Microsoft Graph API client integration
   - Fetch users with pagination (handle 10k+ users)
   - Delta query support for incremental sync
   - Batch upsert to Neo4j (100 users per batch)
   - Error handling + retry logic

2. **azuread-group-sync-worker.ts** (NEW FILE)
   - Fetch security groups from Graph API
   - Fetch group memberships (including nested groups)
   - Create Group nodes with `azuread:` prefix
   - Create MEMBER_OF relationships
   - Handle group hierarchy (up to 20 levels)

3. **IdP Sync API Endpoints** (NEW FILE: `apps/search-ai-runtime/src/routes/idp-sync.ts`)
   - `POST /api/idp/sync/trigger` — Manual sync trigger
   - `GET /api/idp/sync/status` — Sync status + errors
   - `POST /api/idp/sync/schedule` — Configure sync schedule

4. **Scheduled Sync Job**
   - BullMQ repeat job (daily at 12:00 AM UTC)
   - Tenant-scoped sync (parallel execution)
   - Monitoring + alerting on sync failures

**Week 4: Testing + Validation**

5. Test with real Azure AD tenant (1000+ users, 50+ groups)
6. Test nested group resolution (5 levels deep)
7. Test permission queries after sync
8. Performance benchmarking (sync time, Neo4j load)
9. Error handling (API rate limits, network failures)

**Validation:**

- ✅ User nodes populated in Neo4j with idpUserId, email, idpProvider
- ✅ Group nodes created with correct groupId format (`azuread:g_*`)
- ✅ MEMBER_OF relationships correctly established
- ✅ `getUserGroups()` returns correct groups for test users
- ✅ Scheduled sync runs successfully
- ✅ Manual sync API works
- ✅ Sync errors logged and monitored

**Deliverables:**

- `apps/search-ai/src/workers/azuread-user-sync-worker.ts`
- `apps/search-ai/src/workers/azuread-group-sync-worker.ts`
- `apps/search-ai-runtime/src/routes/idp-sync.ts`
- Test coverage >90% for all new code
- Documentation: IdP configuration guide

**Future Phases:**

- **Phase 5: Okta + Google Support** (Week 6-7) — Same pattern as Azure AD
- **Phase 6: Webhook-Driven Sync** (Post-MVP) — Real-time updates instead of daily batch

---

### Phase 3: Query Pipeline Integration (Week 2, overlaps with Phase 2B)

**Tasks:**

1. Update `QueryPipeline` to inject permission filters
2. Add `X-Auth-Mode` header support
3. Add group cache invalidation hooks
4. Performance testing (query latency <500ms)

**Validation:**

- Benchmark: 1000 queries with user mode
- P50: <200ms, P95: <400ms, P99: <500ms

---

### Phase 4: Documentation & Client SDKs (Week 5)

**Tasks:**

1. Update API documentation with new headers
2. Add code examples for common IdP providers (Azure AD, Okta, Google)
3. Create SDK helpers for token forwarding
4. Admin API for cache invalidation
5. Integration guides for:
   - React web apps
   - Mobile apps (iOS/Android)
   - Server-side applications

**Validation:**

- Sample application: Intranet portal with Azure AD
- End-to-end test: SSO login → user-scoped search
- Public mode unchanged
- User sees only authorized documents

---

## Testing Strategy

### Unit Tests

**Files to test:**

1. **`apps/search-ai-runtime/src/middleware/idp-auth.ts`**
   - `validateIdPToken()` with Azure AD, Okta, Google tokens
   - `detectIdPProvider()` with various issuer formats
   - `extractEmail()` from different claim structures
   - Invalid signature rejection
   - Expired token rejection
   - Missing email claim handling

2. **`apps/search-ai-runtime/src/services/permissions/permission-filter.ts`**
   - `buildPermissionFilter()` with user identity
   - `buildPublicFilter()` for public mode
   - `getUserGroups()` cache hit/miss
   - Empty groups list handling
   - Filter structure validation

3. **`apps/search-ai-runtime/src/services/permissions/group-cache.ts`**
   - `get()` returns cached groups
   - `get()` returns null on miss
   - `set()` stores groups with TTL
   - `invalidate()` clears tenant cache
   - `invalidateUser()` clears user cache

4. **`packages/search-ai-internal/src/permissions/permission-graph.service.ts`**
   - `getFlattenedPermissions()` extracts document permissions
   - `getUserGroups()` returns transitive groups
   - Handles document not in graph (default to public)
   - Neo4j query timeout handling

**Coverage target:** 90%+ on all new code

**Test fixtures:**

```typescript
// Mock IdP tokens
const MOCK_AZURE_TOKEN = jwt.sign(
  {
    iss: 'https://login.microsoftonline.com/tenant-id/v2.0',
    sub: 'user-123',
    email: 'john.doe@company.com',
    name: 'John Doe',
    exp: Math.floor(Date.now() / 1000) + 3600,
  },
  MOCK_PRIVATE_KEY,
  { algorithm: 'RS256' },
);

const MOCK_OKTA_TOKEN = jwt.sign(
  {
    iss: 'https://dev-123456.okta.com',
    sub: 'user-456',
    email: 'jane.smith@company.com',
    name: 'Jane Smith',
    exp: Math.floor(Date.now() / 1000) + 3600,
  },
  MOCK_PRIVATE_KEY,
  { algorithm: 'RS256' },
);
```

---

### Integration Tests

**Test scenarios:**

1. **Public mode (backward compatibility)**

   ```typescript
   // No X-Auth-Mode header → defaults to public
   const response = await request(app)
     .post('/api/search/idx_123/query')
     .set('Authorization', 'Bearer abl_sk_test_xyz')
     .send({ query: 'test', queryType: 'vector' });

   expect(response.status).toBe(200);
   expect(response.body.results.every((r) => r.permissions.publicEverywhere)).toBe(true);
   ```

2. **User mode with valid Azure AD token**

   ```typescript
   const response = await request(app)
     .post('/api/search/idx_123/query')
     .set('Authorization', 'Bearer abl_sk_test_xyz')
     .set('X-Auth-Mode', 'user')
     .set('X-End-User-Token', AZURE_TOKEN)
     .send({ query: 'financial report', queryType: 'vector' });

   expect(response.status).toBe(200);
   // Results include public + user's documents
   expect(response.body.results.length).toBeGreaterThan(0);
   ```

3. **User mode with invalid token (forged signature)**

   ```typescript
   const response = await request(app)
     .post('/api/search/idx_123/query')
     .set('Authorization', 'Bearer abl_sk_test_xyz')
     .set('X-Auth-Mode', 'user')
     .set('X-End-User-Token', FORGED_TOKEN)
     .send({ query: 'test', queryType: 'vector' });

   expect(response.status).toBe(401);
   expect(response.body.error).toContain('Invalid end-user IdP token');
   ```

4. **User mode with expired token**

   ```typescript
   const expiredToken = jwt.sign(
     { email: 'john@company.com', exp: Math.floor(Date.now() / 1000) - 3600 },
     PRIVATE_KEY,
     { algorithm: 'RS256' },
   );

   const response = await request(app)
     .post('/api/search/idx_123/query')
     .set('X-Auth-Mode', 'user')
     .set('X-End-User-Token', expiredToken)
     .send({ query: 'test', queryType: 'vector' });

   expect(response.status).toBe(401);
   ```

5. **Group membership resolution (direct group)**

   ```typescript
   // Setup: User is direct member of finance_team
   // Document has allowedGroups: ["sharepoint:finance_team"]

   const response = await request(app)
     .post('/api/search/idx_123/query')
     .set('X-Auth-Mode', 'user')
     .set('X-End-User-Token', USER_TOKEN)
     .send({ query: 'Q3 report', queryType: 'vector' });

   const docIds = response.body.results.map((r) => r.documentId);
   expect(docIds).toContain('doc_with_finance_team_permission');
   ```

6. **Group membership resolution (nested 3 levels)**

   ```typescript
   // Setup: User → finance_team → finance_dept → company_all
   // Document has allowedGroups: ["company_all"]

   const response = await request(app)
     .post('/api/search/idx_123/query')
     .set('X-Auth-Mode', 'user')
     .set('X-End-User-Token', USER_TOKEN)
     .send({ query: 'company policy', queryType: 'vector' });

   expect(response.body.results.length).toBeGreaterThan(0);
   ```

7. **Cache hit scenario**

   ```typescript
   // First query → Neo4j lookup + cache set
   await request(app)
     .post('/api/search/idx_123/query')
     .set('X-Auth-Mode', 'user')
     .set('X-End-User-Token', USER_TOKEN)
     .send({ query: 'test', queryType: 'vector' });

   // Mock Neo4j to track calls
   const neo4jSpy = jest.spyOn(permissionService, 'getUserGroups');

   // Second query → cache hit, no Neo4j call
   await request(app)
     .post('/api/search/idx_123/query')
     .set('X-Auth-Mode', 'user')
     .set('X-End-User-Token', USER_TOKEN)
     .send({ query: 'test 2', queryType: 'vector' });

   expect(neo4jSpy).not.toHaveBeenCalled();
   ```

8. **Tenant isolation (cross-tenant attack prevention)**

   ```typescript
   // Tenant A creates document
   await uploadDocument(TENANT_A_API_KEY, { content: 'Secret A' });

   // Tenant B tries to search Tenant A's index
   const response = await request(app)
     .post('/api/search/tenant_a_index/query')
     .set('Authorization', `Bearer ${TENANT_B_API_KEY}`)
     .send({ query: 'Secret', queryType: 'vector' });

   expect(response.status).toBe(403); // Forbidden
   ```

9. **User not in Neo4j graph (graceful degradation)**

   ```typescript
   // User exists in IdP but not in Neo4j permission graph
   const response = await request(app)
     .post('/api/search/idx_123/query')
     .set('X-Auth-Mode', 'user')
     .set('X-End-User-Token', NEW_USER_TOKEN)
     .send({ query: 'test', queryType: 'vector' });

   expect(response.status).toBe(200);
   // Only public documents returned
   expect(response.body.results.every((r) => r.permissions.publicEverywhere)).toBe(true);
   ```

10. **Multiple IdP providers in single tenant**

    ```typescript
    // User authenticates with Azure AD
    const azureResponse = await request(app)
      .post('/api/search/idx_123/query')
      .set('X-End-User-Token', AZURE_TOKEN)
      .send({ query: 'test', queryType: 'vector' });

    // Different user authenticates with Okta
    const oktaResponse = await request(app)
      .post('/api/search/idx_123/query')
      .set('X-End-User-Token', OKTA_TOKEN)
      .send({ query: 'test', queryType: 'vector' });

    expect(azureResponse.status).toBe(200);
    expect(oktaResponse.status).toBe(200);
    // Results differ based on user permissions
    expect(azureResponse.body.results).not.toEqual(oktaResponse.body.results);
    ```

---

### Performance Tests

**Load test:**

- 1000 concurrent users
- 10 queries per user
- Mixed public (50%) + user mode (50%)

**Acceptance criteria:**

- P95 latency < 500ms
- Neo4j CPU < 70%
- Redis hit rate > 95%

---

## Rollout Plan

### Stage 1: Internal Testing (Week 5)

**Scope:** ABL Platform team only

**Steps:**

1. Deploy to staging environment
2. Run 1-week dogfooding test
3. Collect feedback on usability
4. Fix critical bugs

**Success criteria:**

- Zero critical bugs
- Query latency within SLA

---

### Stage 2: Beta Customers (Week 6-7)

**Scope:** 3-5 beta customers with SharePoint connectors

**Steps:**

1. Deploy to production (feature flag OFF by default)
2. Enable feature flag for beta customers
3. Monitor query latency, error rates
4. Collect customer feedback

**Success criteria:**

- 100% of beta customers can search with user mode
- No P0/P1 incidents

---

### Stage 3: General Availability (Week 8)

**Scope:** All customers

**Steps:**

1. Enable feature flag for all tenants
2. Announce in release notes
3. Update documentation
4. Monitor for 1 week

**Rollback plan:**

- Feature flag OFF → all queries revert to public mode

---

## Alternatives Considered

### Alternative 1: Embed Permissions in Vector Embeddings

**Approach:** Encode user/group IDs in embedding space

**Pros:**

- No separate permission filter
- Fully vector-based search

**Cons:**

- ❌ **Embedding space contamination** — user IDs have no semantic meaning
- ❌ **Scalability** — embedding space grows with number of users
- ❌ **No dynamic updates** — changing permissions requires re-embedding

**Decision:** Rejected

---

### Alternative 2: Post-Query Filtering in Application Layer

**Approach:** Fetch all results, filter in Node.js

**Pros:**

- Simple implementation
- No OpenSearch schema changes

**Cons:**

- ❌ **Performance** — requires fetching 10x results to return topK
- ❌ **Pagination breaks** — can't guarantee consistent results
- ❌ **Memory overhead** — large result sets in memory

**Decision:** Rejected

---

### Alternative 3: Separate Indexes per User/Group

**Approach:** Create dedicated OpenSearch index per user

**Pros:**

- Perfect isolation
- No query-time filtering

**Cons:**

- ❌ **Index explosion** — 10,000 users = 10,000 indexes
- ❌ **Storage overhead** — duplicate documents across indexes
- ❌ **Ingestion complexity** — write to multiple indexes

**Decision:** Rejected

---

### Alternative 4: Platform-Issued End-User Tokens

**Approach:** ABL Platform issues its own end-user tokens instead of accepting IdP tokens

**Flow:**

1. End-user application sends IdP token to ABL Platform token exchange endpoint
2. Platform validates IdP token and issues its own JWT
3. End-user application uses platform JWT for search requests

**Pros:**

- ✅ Centralized token validation (one-time IdP verification)
- ✅ Controlled token format and claims
- ✅ Token revocation support

**Cons:**

- ❌ **Additional latency** — token exchange adds round-trip
- ❌ **State management** — need to store issued tokens (Redis/DB)
- ❌ **Token expiration sync** — platform tokens may outlive IdP session
- ❌ **Complexity** — additional endpoint, token management logic

**Decision:** Rejected for MVP, consider for future optimization

**Why rejected:**

- Initial implementation should be stateless (no token storage)
- Direct IdP token validation is simpler and more secure (no intermediate trust)
- Applications already have IdP tokens from user login flow
- Can add token exchange later if JWKS validation becomes bottleneck

**Future consideration:**

- If JWKS fetching adds latency (>50ms P95), implement token exchange
- If token format standardization needed (multi-IdP normalization)
- If token revocation becomes requirement (search audit compliance)

---

### Alternative 5: OpenSearch Document-Level Security (DLS)

**Approach:** Use OpenSearch native document-level security feature

**Pros:**

- ✅ Native OpenSearch feature
- ✅ No custom filter logic

**Cons:**

- ❌ **Limited flexibility** — DLS uses roles, not dynamic user/group resolution
- ❌ **Role explosion** — need one role per user for dynamic permissions
- ❌ **Neo4j integration** — DLS doesn't integrate with external permission graphs
- ❌ **Performance** — DLS evaluated on every shard, not cached

**Decision:** Rejected

**Why rejected:**

- Our permissions are in Neo4j, not OpenSearch
- Group memberships are transitive (up to 20 levels)
- DLS role-based model doesn't fit dynamic group expansion
- Custom filter with Redis caching is faster

---

## Monitoring & Observability

### Metrics to Track

**Query Performance:**

```typescript
// OpenTelemetry metrics
const queryLatencyHistogram = meter.createHistogram('search.query.latency', {
  description: 'Search query latency in milliseconds',
  unit: 'ms',
});

const permissionFilterLatencyHistogram = meter.createHistogram('search.permission_filter.latency', {
  description: 'Permission filter construction latency',
  unit: 'ms',
});

const neo4jQueryLatencyHistogram = meter.createHistogram('neo4j.query.latency', {
  description: 'Neo4j group query latency',
  unit: 'ms',
});
```

**Cache Performance:**

```typescript
const cacheHitCounter = meter.createCounter('redis.cache.hits', {
  description: 'Redis cache hits for group lookups',
});

const cacheMissCounter = meter.createCounter('redis.cache.misses', {
  description: 'Redis cache misses for group lookups',
});

const cacheHitRate = (hits / (hits + misses)) * 100; // Target: >95%
```

**Security Events:**

```typescript
const invalidTokenCounter = meter.createCounter('auth.invalid_token', {
  description: 'Invalid IdP token rejections',
});

const unauthorizedAccessCounter = meter.createCounter('auth.unauthorized_access', {
  description: 'Unauthorized document access attempts',
});

const tenantIsolationViolationCounter = meter.createCounter('auth.tenant_isolation_violation', {
  description: 'Cross-tenant access attempts',
});
```

**Usage Analytics:**

```typescript
const userModeQueryCounter = meter.createCounter('search.query.user_mode', {
  description: 'Queries in user mode',
});

const publicModeQueryCounter = meter.createCounter('search.query.public_mode', {
  description: 'Queries in public mode',
});

const idpProviderCounter = meter.createCounter('auth.idp_provider', {
  description: 'IdP provider usage',
  attributes: { provider: 'azuread' | 'okta' | 'google' },
});
```

### Dashboards

**1. Query Performance Dashboard**

- P50, P95, P99 query latency (split by auth mode)
- Permission filter construction time
- Neo4j query latency
- OpenSearch query latency
- Cache hit rate

**2. Security Dashboard**

- Invalid token rejections (rate per hour)
- Unauthorized access attempts
- Tenant isolation violations
- Failed authentication rate

**3. Usage Dashboard**

- Queries by auth mode (public vs user)
- Queries by IdP provider
- Unique users per tenant
- Cache efficiency (hit rate, eviction rate)

### Alerts

**Critical Alerts (PagerDuty):**

```yaml
- name: High Query Latency
  condition: P95 > 1000ms for 5 minutes
  severity: critical
  action: Page on-call engineer

- name: Cache Unavailable
  condition: Redis connection errors > 10 in 1 minute
  severity: critical
  action: Page on-call engineer

- name: Neo4j Unavailable
  condition: Neo4j connection errors > 5 in 1 minute
  severity: critical
  action: Page on-call engineer
```

**Warning Alerts (Slack):**

```yaml
- name: Low Cache Hit Rate
  condition: Hit rate < 90% for 15 minutes
  severity: warning
  action: Notify search team channel

- name: Elevated Invalid Tokens
  condition: Invalid token rate > 100/minute for 10 minutes
  severity: warning
  action: Notify security team channel

- name: Slow Permission Resolution
  condition: Neo4j query P95 > 200ms for 10 minutes
  severity: warning
  action: Notify search team channel
```

### Logging

**Structured Logs (JSON format):**

```typescript
logger.info('IdP token validated', {
  tenantId,
  userEmail,
  idpProvider: 'azuread',
  tokenExpiry: token.exp,
  validationLatencyMs: 45,
});

logger.info('Permission filter applied', {
  tenantId,
  indexId,
  userEmail,
  groupCount: 5,
  authMode: 'user',
  cacheHit: true,
});

logger.warn('Invalid IdP token', {
  tenantId,
  reason: 'signature_verification_failed',
  issuer: token.iss,
  ipAddress: req.ip,
});

logger.error('Neo4j query timeout', {
  tenantId,
  userEmail,
  queryTimeoutMs: 5000,
  groupDepth: 20,
});
```

**Log Retention:**

- Security logs (invalid tokens, unauthorized access): 90 days
- Performance logs: 30 days
- Debug logs: 7 days

---

## Open Questions

1. **IdP Token Refresh:**
   - How long should we accept cached IdP tokens?
   - Should we support token refresh flow?

2. **Public + User Hybrid:**
   - Should users in "user mode" also see `publicEverywhere` documents?
   - **Proposed:** Yes (implemented in filter)

3. **Domain-Scoped Permissions:**
   - Should we support `publicInDomain` (all users in `@company.com`)?
   - **Proposed:** Future enhancement (not in MVP)

4. **Cross-Tenant Search:**
   - Should super-admins search across multiple tenants?
   - **Proposed:** Out of scope (per-tenant search only)

5. **Production Migration Strategy:**
   - When should we implement the complex migration (backfill, versioning)?
   - **Decision:** Only if production data exists at GA launch
   - **Current Status:** Pre-production, using simplified approach (recreate indexes)
   - **Documentation:** Migration strategy documented in `RFC-SEARCHAI-IDP-AUTHENTICATION-MIGRATION-ANALYSIS.md` for future reference

---

## Success Metrics

| Metric                    | Target | Measurement                         |
| ------------------------- | ------ | ----------------------------------- |
| Query latency (P95)       | <500ms | OpenTelemetry                       |
| Neo4j query latency       | <100ms | OpenTelemetry                       |
| Redis cache hit rate      | >95%   | Redis INFO stats                    |
| Permission match accuracy | 100%   | Manual audit (sample 100 documents) |
| Zero security incidents   | 0      | Security audit log                  |

---

## Timeline

**Revised Timeline:** 8-9 weeks (was 6 weeks before gap analysis)

**Timeline increase reason:** Gap analysis identified missing IdP sync workers (Azure AD, Okta, Google) required to populate Neo4j User/Group nodes. Added Phase 2B (Week 3-4) to implement Azure AD sync MVP.

| Phase                        | Duration     | Owner            | Deliverables                                                                 |
| ---------------------------- | ------------ | ---------------- | ---------------------------------------------------------------------------- |
| Phase 1: Infrastructure      | Week 1       | Backend Team     | IdP token validator, permission filter service, middleware                   |
| Phase 2: Schema Update       | 2 days       | Search Team      | OpenSearch mapping update, index recreation                                  |
| **Phase 2B: IdP Sync (NEW)** | **Week 3-4** | **Backend Team** | **Azure AD user/group sync workers, sync API, scheduled jobs**               |
| Phase 3: Query Pipeline      | Week 2       | Search Team      | Pipeline integration, permission filtering, caching (overlaps with Phase 2B) |
| Phase 4: Documentation       | Week 5       | Docs Team        | API docs, SDK examples, integration guides, IdP configuration                |
| Testing & Integration        | Week 6-7     | QA + Backend     | End-to-end testing, performance benchmarking, monitoring                     |
| Rollout                      | Week 8-9     | DevOps           | Staging deployment, beta testing, GA launch                                  |

**Total:** 8-9 weeks (3 weeks added for IdP sync implementation)

**Timeline Savings vs Production Migration:**

- ✅ No backfill script development (saved ~4 hours)
- ✅ No backfill execution (saved ~2.5 hours for 1M docs)
- ✅ No index versioning setup (saved ~4 hours)
- ✅ No zero-downtime migration testing (saved ~8 hours)
- **Total pre-production savings:** ~2 weeks

**Timeline Impact of Gaps:**

| Component                    | Status         | Impact        |
| ---------------------------- | -------------- | ------------- |
| Neo4j Permission Graph       | ✅ Ready       | No delay      |
| IdP Token Validator          | ❌ Missing     | +6 hours      |
| Permission Filter Service    | ❌ Missing     | +8 hours      |
| **IdP Sync Workers**         | **❌ Missing** | **+48 hours** |
| Document Permission Resolver | ❌ Missing     | +6 hours      |
| Permission Re-sync API       | ❌ Missing     | +6 hours      |

**Critical Path:** IdP sync workers (Week 3-4) are on critical path. Cannot fully test user-mode queries without User/Group nodes populated in Neo4j.

**See Also:** `RFC-SEARCHAI-IDP-AUTHENTICATION-GAP-ANALYSIS.md` for detailed 105-hour effort breakdown

- ✅ **Total savings: ~2 weeks** of migration complexity

---

## Implementation Checklist

**Based on gap analysis (`RFC-SEARCHAI-IDP-AUTHENTICATION-GAP-ANALYSIS.md`):**

### Files to CREATE (8 new files)

**Authentication & Query Services:**

- [ ] `apps/search-ai-runtime/src/services/idp/idp-token-validator.ts`
  - JWKS-based JWT verification
  - Multi-IdP support (Azure AD, Okta, Google)
  - Redis-backed JWKS cache
  - Effort: 6 hours

- [ ] `apps/search-ai-runtime/src/middleware/permission-filter.middleware.ts`
  - X-Auth-Mode header routing
  - User mode vs public mode switching
  - Effort: 2 hours

- [ ] `apps/search-ai-runtime/src/services/query/permission-filter-service.ts`
  - Build OpenSearch permission filter from user groups
  - Neo4j getUserGroups() integration
  - Redis group cache
  - Effort: 8 hours

- [ ] `apps/search-ai-runtime/src/services/cache/group-membership-cache.ts`
  - Redis-backed group membership cache
  - 5-min TTL, tenant-scoped keys
  - Cache invalidation API
  - Effort: 4 hours

**IdP Sync Workers (Critical Gap):**

- [ ] `apps/search-ai/src/workers/azuread-user-sync-worker.ts`
  - Microsoft Graph API integration
  - User sync with pagination
  - Delta query support
  - Batch upsert to Neo4j
  - Effort: 12 hours

- [ ] `apps/search-ai/src/workers/azuread-group-sync-worker.ts`
  - Security group + membership sync
  - Nested group support
  - MEMBER_OF relationship creation
  - Effort: 16 hours

- [ ] `apps/search-ai/src/services/document-permissions/document-permission-resolver.ts`
  - Wrap PermissionGraphClient.getFlattenedPermissions()
  - Document-level caching (avoid Neo4j per-chunk)
  - Effort: 4 hours

- [ ] `apps/search-ai-runtime/src/routes/idp-sync.ts`
  - POST /api/idp/sync/trigger
  - GET /api/idp/sync/status
  - POST /api/idp/sync/schedule
  - Effort: 6 hours

### Files to MODIFY (15 existing files)

**Authentication Middleware:**

- [ ] `apps/search-ai-runtime/src/middleware/auth.ts`
  - Add X-Auth-Mode + X-End-User-Token handling
  - Integrate IdPTokenValidator
  - Set req.userIdentity on successful validation
  - Effort: 3 hours

**Query Pipeline:**

- [ ] `apps/search-ai-runtime/src/services/query/query-pipeline.ts`
  - Inject permission filter before vector search
  - Check req.authMode to decide filter type
  - Circuit breaker integration
  - Effort: 6 hours

- [ ] `apps/search-ai-runtime/src/routes/query.ts`
  - Add permission filter middleware to route
  - Effort: 1 hour

**Ingestion Pipeline:**

- [ ] `apps/search-ai/src/workers/embedding-worker.ts`
  - Query Neo4j for document permissions
  - Populate permissions field in OpenSearch
  - Document-level caching
  - Effort: 4 hours

**OpenSearch Schema:**

- [ ] `packages/search-ai-internal/src/vector-store/opensearch-mappings.ts`
  - Add permissions field to VECTOR_INDEX_MAPPING
  - Effort: 1 hour

- [ ] `apps/search-ai/scripts/recreate-dev-indexes.ts`
  - Drop + recreate dev/staging indexes
  - Effort: 1 hour

**Worker Registration:**

- [ ] `packages/search-ai-sdk/src/constants.ts`
  - Add QUEUE_AZUREAD_USER_SYNC, QUEUE_AZUREAD_GROUP_SYNC
  - Effort: 0.5 hours

- [ ] `apps/search-ai/src/workers/index.ts`
  - Register azuread-user-sync-worker, azuread-group-sync-worker
  - Effort: 0.5 hours

- [ ] `apps/search-ai/src/workers/shared.ts`
  - Add AzureADSyncJobData type
  - Effort: 0.5 hours

**API Routes:**

- [ ] `apps/search-ai-runtime/src/routes/index.ts`
  - Add idp-sync route
  - Add permission-resync route
  - Effort: 1 hour

**Monitoring:**

- [ ] `apps/search-ai-runtime/src/services/metrics/index.ts`
  - Add permissionFilterLatencyHistogram
  - Add idpSyncCounter
  - Add jwksCacheHitRateCounter
  - Effort: 3 hours

**Documentation:**

- [ ] `docs/searchai/SERVICES-INVENTORY.md`
  - Document new IdP sync workers
  - Document new routes
  - Effort: 2 hours

- [ ] `packages/database/src/models/llm-credential.model.ts`
  - No changes, but validate encryption works for IdP credentials
  - Effort: 0 hours (validation only)

- [ ] `packages/database/src/models/tenant-model.model.ts`
  - No changes, but validate IdP metadata fields exist
  - Effort: 0 hours (validation only)

### Files to READ (No Changes, Verify Compatibility)

These files are verified RFC-compliant via gap analysis:

- [x] `packages/search-ai-internal/src/permissions/permission-graph-client.ts` ✅ RFC-ready
- [x] `packages/search-ai-internal/src/permissions/permission-graph-service.ts` ✅ Has circuit breaker
- [x] `packages/search-ai-internal/src/permissions/types.ts` ✅ Schema complete
- [x] `apps/search-ai-runtime/src/services/cache/redis-client.ts` ✅ Works as-is

### Testing Checklist

**Unit Tests:**

- [ ] IdPTokenValidator (JWKS validation, multi-IdP support)
- [ ] PermissionFilterService (filter building, cache hit/miss)
- [ ] GroupMembershipCache (Redis operations, TTL)
- [ ] azuread-user-sync-worker (Graph API, Neo4j upsert)
- [ ] azuread-group-sync-worker (membership sync, nested groups)

**Integration Tests:**

- [ ] End-to-end user-mode query with real Azure AD token
- [ ] Public mode query (backward compatibility)
- [ ] Permission filter with 100+ groups
- [ ] IdP sync with 1000+ users
- [ ] Cache invalidation flow
- [ ] Circuit breaker triggering on Neo4j failure

**Performance Tests:**

- [ ] Query latency <500ms P95 with permission filtering
- [ ] Redis cache hit rate >95%
- [ ] Neo4j query <100ms
- [ ] IdP sync completes in <5 minutes for 10k users

### Deployment Checklist

**Pre-Deployment:**

- [ ] Update OpenSearch mapping template
- [ ] Drop + recreate dev/staging indexes
- [ ] Configure Azure AD credentials in LLMCredential collection
- [ ] Test IdP sync with production tenant
- [ ] Verify Neo4j User/Group nodes populated
- [ ] Test sample queries in user mode

**Deployment:**

- [ ] Deploy search-ai-runtime with new authentication middleware
- [ ] Deploy search-ai with IdP sync workers
- [ ] Configure scheduled IdP sync (daily 12:00 AM UTC)
- [ ] Enable monitoring dashboards
- [ ] Test end-to-end flow in staging

**Post-Deployment:**

- [ ] Monitor query latency
- [ ] Monitor IdP sync success rate
- [ ] Monitor cache hit rates
- [ ] Audit permission filtering accuracy
- [ ] Train customer success on IdP configuration

---

## References

- [Neo4j Permission Graph Schema](/packages/search-ai-internal/src/permissions/types.ts)
- [SharePoint Permission Crawler](/packages/connectors/sharepoint/src/permissions/sharepoint-permission-crawler.ts)
- [Query Pipeline Design](/docs/searchai/design/QUERY-PIPELINE-DESIGN.md)
- [CLAUDE.md Platform Principles](/CLAUDE.md) — Resource isolation (404 not 403)

---

## Approval

- [ ] Backend Team Lead
- [ ] Search Team Lead
- [ ] Security Team
- [ ] Product Manager

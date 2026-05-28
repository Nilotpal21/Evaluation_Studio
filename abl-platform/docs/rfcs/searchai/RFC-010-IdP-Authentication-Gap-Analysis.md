# Architecture Review #2: IdP Authentication Design Impact & Neo4j User Graph Gap Analysis

**Date:** 2026-03-03
**RFC:** RFC-SEARCHAI-IDP-AUTHENTICATION.md
**Focus:** Cross-reference existing implementation vs RFC requirements, identify gaps, impact analysis

---

## Executive Summary

**Overall Assessment:** The RFC design is **architecturally sound** and leverages existing Neo4j permission graph infrastructure effectively. However, there are **CRITICAL gaps** in IdP user/group synchronization that must be implemented before the RFC can work.

**Key Finding:** The Neo4j permission graph client has all required query capabilities, but **no IdP sync workers exist** to populate User and Group nodes from Azure AD, Okta, or Google.

**Impact:** 8 domains affected across 15+ files. Majority of required functionality exists, but 5 new components must be built.

---

## Part 1: Neo4j User Graph Gap Analysis

### What EXISTS (✅ READY)

#### 1. Permission Graph Client — COMPLETE

**File:** `packages/search-ai-internal/src/permissions/permission-graph-client.ts` (952 lines)

**Capabilities:**

- ✅ All CRUD operations for User, Group, Document, Domain nodes
- ✅ Batch operations (batchUpsertUsers, batchUpsertGroups)
- ✅ Transitive group resolution (getUserGroups) with 20-level depth
- ✅ Cycle detection (prevents infinite loops in group hierarchies)
- ✅ Flattened permissions query (getFlattenedPermissions)
- ✅ Tenant isolation enforced in all queries
- ✅ Schema initialization (constraints, indexes)
- ✅ Connection pooling and verification

**Evidence from code:**

```typescript
// Line 666-684: getUserGroups with recursive traversal
async getUserGroups(tenantId: string, email: string, maxDepth?: number): Promise<string[]> {
  const depth = maxDepth || this.maxDepth; // 20 levels max

  const result = await session.run(
    `
    MATCH (u:User {tenantId: $tenantId, email: $email})
          -[:MEMBER_OF*1..${depth}]->(g:Group)
    WHERE NOT (g)-[:MEMBER_OF*]->(u)  // Cycle detection
    RETURN DISTINCT g.groupId AS groupId
    `,
    { tenantId, email: email.toLowerCase() }
  );
}

// Line 751-797: getFlattenedPermissions - exact RFC requirement
async getFlattenedPermissions(tenantId: string, documentId: string): Promise<FlattenedPermissions> {
  // Returns: allowedUsers, allowedGroups, allowedDomains, publicInDomain, publicEverywhere
  // Matches RFC OpenSearch schema exactly!
}
```

**Performance validation from tests:**

- ✅ 100 groups resolved in <50ms (line 645-681 of permission-graph-usergroups.test.ts)
- ✅ 1000 groups resolved in <100ms (line 683-727)
- ✅ Diamond hierarchies supported (line 257-318)
- ✅ Tenant isolation tested (line 581-638)

**Verdict:** ✅ **NO GAPS** — Permission graph client is RFC-compliant.

---

#### 2. User Node Schema — COMPLETE

**File:** `packages/search-ai-internal/src/permissions/types.ts` (lines 14-37)

**Schema:**

```typescript
export interface UserNode {
  tenantId: string; // ✅ Tenant isolation
  email: string; // ✅ Universal identity key (RFC Section 2.1)
  idpUserId?: string; // ✅ Azure AD object ID / Okta user ID
  idpProvider?: 'azuread' | 'okta' | 'google'; // ✅ Multi-IdP support
  displayName?: string; // ✅ Display name
  domain: string; // ✅ Extracted from email (RFC Section 2.2)
  status: 'active' | 'suspended' | 'deleted'; // ✅ User lifecycle
  lastSyncAt?: Date; // ✅ Sync tracking
  createdAt: Date; // ✅ Audit trail
}
```

**RFC Requirements vs Implementation:**

| RFC Requirement         | Implementation                 | Status |
| ----------------------- | ------------------------------ | ------ |
| Email as identity key   | ✅ email field (lowercase)     | PASS   |
| IdP provider tracking   | ✅ idpProvider enum            | PASS   |
| IdP user ID mapping     | ✅ idpUserId field             | PASS   |
| Domain extraction       | ✅ domain field (auto-derived) | PASS   |
| Multi-IdP support       | ✅ azuread, okta, google       | PASS   |
| User status lifecycle   | ✅ active, suspended, deleted  | PASS   |
| Sync timestamp tracking | ✅ lastSyncAt field            | PASS   |

**Verdict:** ✅ **NO GAPS** — User node schema is RFC-compliant.

---

#### 3. Group Node Schema — COMPLETE

**File:** `packages/search-ai-internal/src/permissions/types.ts` (lines 39-59)

**Schema:**

```typescript
export interface GroupNode {
  tenantId: string;
  groupId: string; // Composite: "{source}:{id}" (RFC Section 2.3)
  idpGroupId?: string; // Azure AD group ID (optional)
  source: 'azuread' | 'okta' | 'google' | 'sharepoint' | 'jira' | 'confluence';
  displayName?: string;
  email?: string;
  lastSyncAt?: Date;
  createdAt: Date;
}
```

**Key design matches RFC:**

- ✅ Composite groupId with source prefix (`azuread:g_engineering`)
- ✅ Multi-source support (IdP + connectors)
- ✅ IdP group ID mapping for sync
- ✅ Sync tracking with lastSyncAt

**Verdict:** ✅ **NO GAPS** — Group node schema is RFC-compliant.

---

#### 4. Domain Node Schema — COMPLETE

**File:** `packages/search-ai-internal/src/permissions/types.ts` (lines 89-106)

**Schema:**

```typescript
export interface DomainNode {
  tenantId: string;
  domain: string; // e.g., "contoso.com" (lowercase)
  verified: boolean;
  verificationMethod: 'dns' | 'email' | 'manual' | 'idp-trust';
  verifiedAt?: Date;
  createdAt: Date;
}
```

**Verdict:** ✅ **NO GAPS** — Domain node exists (but workflow missing, see GAP #4 below).

---

#### 5. Permission Queries — COMPLETE

**All three RFC-required queries implemented:**

1. **Query 1: Get user groups** (lines 666-684)
   - ✅ Recursive traversal (up to 20 levels)
   - ✅ Cycle detection
   - ✅ Tenant-scoped

2. **Query 2: Get accessible documents** (lines 696-743)
   - ✅ Four access paths: direct user, group, domain-scoped, public
   - ✅ Recursive group membership
   - ✅ Performance optimized

3. **Query 3: Get flattened permissions** (lines 751-797)
   - ✅ Returns exact RFC schema: allowedUsers, allowedGroups, allowedDomains, publicInDomain, publicEverywhere
   - ✅ Used by embedding worker to populate OpenSearch

**Verdict:** ✅ **NO GAPS** — All required queries exist and are RFC-compliant.

---

### What is MISSING (❌ CRITICAL GAPS)

#### GAP #1: No IdP User Sync Workers

**Impact:** ❌ **CRITICAL** — Without this, User nodes don't get populated from Azure AD/Okta/Google

**What's needed:**

```typescript
// apps/search-ai/src/workers/azuread-user-sync-worker.ts (NEW FILE)

/**
 * Azure AD User Sync Worker
 *
 * Syncs users from Azure AD into Neo4j permission graph.
 * Runs periodically (daily) + on-demand via API.
 */

export async function processAzureADUserSync(job: Job<AzureADSyncJobData>): Promise<void> {
  const { tenantId, credentialId } = job.data;

  // 1. Get tenant's Azure AD credentials
  const credential = await LLMCredential.findOne({
    _id: credentialId,
    tenantId,
    provider: 'azuread',
    isActive: true,
  });

  if (!credential) throw new Error('Azure AD credential not found');

  // 2. Initialize Microsoft Graph client
  const graphClient = new GraphClient({
    tenantId: credential.metadata.azureTenantId,
    clientId: credential.metadata.clientId,
    clientSecret: credential.apiKey, // decrypted by mongoose plugin
  });

  // 3. Fetch all users from Azure AD (paginated)
  const users: AzureADUser[] = [];
  let nextLink: string | null = null;

  do {
    const response = await graphClient.get('/users', {
      $select: 'id,mail,displayName,userPrincipalName',
      $top: 100,
      $skiptoken: nextLink,
    });

    users.push(...response.value);
    nextLink = response['@odata.nextLink'];
  } while (nextLink);

  // 4. Batch upsert to Neo4j (100 users per batch)
  const client = new PermissionGraphClient(getNeo4jConfig());

  for (let i = 0; i < users.length; i += 100) {
    const batch = users.slice(i, i + 100).map((u) => ({
      tenantId,
      email: u.mail || u.userPrincipalName,
      idpUserId: u.id,
      idpProvider: 'azuread' as const,
      displayName: u.displayName,
      status: 'active' as const,
    }));

    await client.batchUpsertUsers(tenantId, batch);
  }

  await client.close();

  logger.info('Azure AD user sync completed', { tenantId, userCount: users.length });
}

export default function createAzureADUserSyncWorker(concurrency = 1): Worker {
  return new Worker(
    QUEUE_AZUREAD_USER_SYNC,
    processAzureADUserSync,
    createWorkerOptions(concurrency),
  );
}
```

**Required for:**

- Azure AD user sync: `azuread-user-sync-worker.ts` (NEW)
- Okta user sync: `okta-user-sync-worker.ts` (NEW)
- Google user sync: `google-user-sync-worker.ts` (NEW)

**Estimated effort:** ~8 hours per IdP (24 hours total for 3 IdPs)

---

#### GAP #2: No IdP Group Sync Workers

**Impact:** ❌ **CRITICAL** — Without this, Group nodes and MEMBER_OF relationships don't get synced

**What's needed:**

```typescript
// apps/search-ai/src/workers/azuread-group-sync-worker.ts (NEW FILE)

/**
 * Azure AD Group Sync Worker
 *
 * Syncs security groups + memberships from Azure AD into Neo4j.
 */

export async function processAzureADGroupSync(job: Job<AzureADSyncJobData>): Promise<void> {
  const { tenantId, credentialId } = job.data;

  // 1-2. Get credentials + Graph client (same as user sync)

  // 3. Fetch all groups
  const groups = await graphClient.get('/groups', {
    $select: 'id,displayName,mail',
    $filter: 'securityEnabled eq true',
  });

  // 4. Fetch group memberships for each group
  for (const group of groups) {
    const members = await graphClient.get(`/groups/${group.id}/members`, {
      $select: 'id,mail,userPrincipalName',
    });

    // 5. Upsert group
    await client.upsertGroup({
      tenantId,
      groupId: `azuread:${group.id}`,
      idpGroupId: group.id,
      source: 'azuread',
      displayName: group.displayName,
      email: group.mail,
    });

    // 6. Upsert memberships
    for (const member of members.value) {
      await client.setMembership({
        tenantId,
        memberEmail: member.mail || member.userPrincipalName,
        parentGroupId: `azuread:${group.id}`,
        source: 'azuread',
      });
    }
  }
}
```

**Also needs:**

- Nested group support (Azure AD supports group-in-group)
- Incremental sync (delta queries)
- Webhook support for real-time updates

**Estimated effort:** ~12 hours per IdP (36 hours total)

---

#### GAP #3: No IdP Token Validation Service

**Impact:** ❌ **CRITICAL** — RFC requires JWKS-based JWT validation, not implemented

**What's needed:**

```typescript
// apps/search-ai-runtime/src/services/idp/idp-token-validator.ts (NEW FILE)

/**
 * IdP Token Validator
 *
 * Validates end-user IdP tokens (Azure AD, Okta, Google).
 * Uses JWKS for signature verification.
 */

export class IdPTokenValidator {
  private jwksCache: Map<string, { keys: JsonWebKeySet; expiresAt: number }>;
  private redis: RedisClient;

  constructor() {
    this.jwksCache = new Map();
    this.redis = getRedisClient();
  }

  /**
   * Validate IdP token and extract user identity
   */
  async validateToken(token: string, tenantId: string): Promise<UserIdentity> {
    // 1. Decode JWT header to get kid (key ID)
    const decoded = jwt.decode(token, { complete: true });
    if (!decoded) throw new UnauthorizedError('Invalid token format');

    const { iss, kid } = decoded.header;

    // 2. Get JWKS from cache or fetch
    const jwks = await this.getJWKS(iss);

    // 3. Find matching key
    const key = jwks.keys.find((k) => k.kid === kid);
    if (!key) throw new UnauthorizedError('Token signing key not found');

    // 4. Verify signature
    const verified = jwt.verify(token, jwkToPem(key), {
      issuer: iss,
      algorithms: ['RS256'],
    });

    // 5. Extract user identity
    return {
      email: verified.email || verified.preferred_username,
      idpUserId: verified.sub,
      idpProvider: this.detectProvider(iss),
      displayName: verified.name,
    };
  }

  /**
   * Get JWKS from Redis cache or fetch from IdP
   */
  private async getJWKS(issuer: string): Promise<JsonWebKeySet> {
    // Check Redis first (shared across pods)
    const cacheKey = `searchai:jwks:${issuer}`;
    const cached = await this.redis.get(cacheKey);

    if (cached) {
      return JSON.parse(cached);
    }

    // Fetch from IdP
    const wellKnownUrl = `${issuer}/.well-known/openid-configuration`;
    const config = await fetch(wellKnownUrl).then((r) => r.json());
    const jwks = await fetch(config.jwks_uri).then((r) => r.json());

    // Cache for 1 hour
    await this.redis.setex(cacheKey, 3600, JSON.stringify(jwks));

    return jwks;
  }

  private detectProvider(issuer: string): 'azuread' | 'okta' | 'google' {
    if (issuer.includes('login.microsoftonline.com')) return 'azuread';
    if (issuer.includes('.okta.com')) return 'okta';
    if (issuer.includes('accounts.google.com')) return 'google';
    throw new Error(`Unsupported IdP issuer: ${issuer}`);
  }
}
```

**Key requirements:**

- ✅ JWKS caching (Redis, not in-memory Map) — fixes HIGH issue H1 from first review
- ✅ Multi-IdP support (Azure AD, Okta, Google)
- ✅ JWT signature verification
- ✅ Claims validation (exp, iss, aud)

**Estimated effort:** ~6 hours

---

#### GAP #4: No Domain Verification Workflow

**Impact:** ⚠️ **MEDIUM** — Domain nodes exist but no verification process

**What's needed:**

1. **DNS verification:** TXT record check
2. **Email verification:** Send verification link to admin@domain.com
3. **Manual verification:** Admin approval in Studio UI
4. **IdP trust verification:** Auto-verify domains from IdP tenant configuration

**Current state:**

- ✅ Domain node exists in schema
- ✅ `upsertDomain()` method exists
- ❌ No verification workflow implemented

**RFC assumption:** RFC Section 2.4 mentions domain verification but doesn't detail workflow.

**Recommendation:** Start with **IdP trust** verification (auto-verify domains from Azure AD tenant config), implement DNS/email verification in Phase 2.

**Estimated effort:** ~8 hours for IdP trust, ~16 hours for DNS/email

---

#### GAP #5: No Permission Re-Sync API

**Impact:** ⚠️ **MEDIUM** — RFC mentions periodic re-indexing but no implementation

**What's needed:**

```typescript
// apps/search-ai-runtime/src/routes/permission-resync.ts (NEW FILE)

/**
 * POST /api/permissions/:documentId/resync
 *
 * Re-sync permissions for a document (fetch from Neo4j, update OpenSearch).
 */

router.post(
  '/:documentId/resync',
  requireAuth,
  requirePermission('search:index:write'),
  async (req, res) => {
    const { documentId } = req.params;
    const { tenantId } = req.tenantContext;

    // 1. Fetch flattened permissions from Neo4j
    const client = new PermissionGraphClient(getNeo4jConfig());
    const permissions = await client.getFlattenedPermissions(tenantId, documentId);
    await client.close();

    // 2. Update all chunks for this document in OpenSearch
    const chunks = await SearchChunk.find({ tenantId, documentId });

    for (const chunk of chunks) {
      await openSearchClient.update({
        index: getIndexName(chunk.indexId),
        id: chunk.vectorId,
        body: {
          doc: {
            permissions: {
              allowedUsers: permissions.allowedUsers,
              allowedGroups: permissions.allowedGroups,
              allowedDomains: permissions.allowedDomains,
              publicInDomain: permissions.publicInDomain,
              publicEverywhere: permissions.publicEverywhere,
              source: 'manual_resync',
              lastSyncedAt: new Date().toISOString(),
            },
          },
        },
      });
    }

    res.json({ success: true, chunksUpdated: chunks.length });
  },
);
```

**Also needs:**

- Bulk re-sync API (all documents in an index)
- Scheduled periodic re-sync (BullMQ worker, daily)
- Webhook trigger on permission changes

**Estimated effort:** ~6 hours

---

## Part 2: Design Impact Analysis

### Impact Summary Table

| Domain                 | Files Affected | Changes Required                                    | Risk         | Effort   |
| ---------------------- | -------------- | --------------------------------------------------- | ------------ | -------- |
| **Authentication**     | 3 files        | New IdP token validator, middleware updates         | HIGH         | 8h       |
| **Neo4j Sync**         | 6 files        | 3 new IdP sync workers (users, groups, memberships) | CRITICAL     | 60h      |
| **Query Pipeline**     | 4 files        | Permission filter integration, caching              | MEDIUM       | 12h      |
| **Ingestion Pipeline** | 2 files        | Embedding worker updates (populate permissions)     | MEDIUM       | 6h       |
| **OpenSearch**         | 2 files        | Schema update, mapping template                     | LOW          | 2h       |
| **Redis Caching**      | 3 files        | Group cache, JWKS cache                             | MEDIUM       | 6h       |
| **API Routes**         | 2 files        | New endpoints (permission resync, domain verify)    | LOW          | 8h       |
| **Monitoring**         | 1 file         | OpenTelemetry metrics                               | LOW          | 3h       |
| **TOTAL**              | **23 files**   | **8 new components, 15 modified**                   | **CRITICAL** | **105h** |

**Timeline with gaps:**

- **Original RFC:** 6 weeks (with pre-production simplification)
- **With gaps:** **8-9 weeks** (+2-3 weeks for IdP sync implementation)

---

### Domain 1: Authentication (HIGH RISK)

#### Affected Files

1. **apps/search-ai-runtime/src/middleware/auth.ts** (MODIFY)
   - Add IdP token validation flow
   - Extract user identity from verified token
   - Set req.userIdentity for downstream use

2. **apps/search-ai-runtime/src/services/idp/idp-token-validator.ts** (NEW)
   - Implements JWKS-based JWT validation
   - Multi-IdP support (Azure AD, Okta, Google)
   - Redis-backed JWKS cache

3. **apps/search-ai-runtime/src/middleware/permission-filter.middleware.ts** (NEW)
   - Checks X-Auth-Mode header
   - Routes to public mode vs user mode
   - Integrates with PermissionFilterService

#### Changes Required

**Before (current):**

```typescript
// Only platform authentication
if (!req.apiKeyContext) {
  return res.status(401).json({ error: 'Unauthorized' });
}
```

**After (RFC Section 2.1):**

```typescript
// Two-layer authentication
if (!req.apiKeyContext) {
  return res.status(401).json({ error: 'Unauthorized' });
}

// NEW: Check for end-user identity
const authMode = req.headers['x-auth-mode'];
const endUserToken = req.headers['x-end-user-token'] as string;

if (authMode === 'user' && endUserToken) {
  // Validate IdP token
  const validator = new IdPTokenValidator();
  req.userIdentity = await validator.validateToken(endUserToken, req.tenantContext.tenantId);
}
```

#### Risk Assessment

- **HIGH**: New critical path in request flow
- **Failure mode**: 401 errors if token validation fails (acceptable)
- **Performance**: +50ms per request on cache miss (JWKS fetch)
- **Security**: Tight JWT validation prevents token forgery

#### Mitigation

- ✅ Graceful degradation to public mode on token validation failure
- ✅ Redis-backed JWKS cache (fixes H1 from first review)
- ✅ Circuit breaker for IdP JWKS endpoints
- ✅ Comprehensive error logging

---

### Domain 2: Neo4j Sync (CRITICAL RISK)

#### Affected Files

1. **apps/search-ai/src/workers/azuread-user-sync-worker.ts** (NEW)
2. **apps/search-ai/src/workers/azuread-group-sync-worker.ts** (NEW)
3. **apps/search-ai/src/workers/okta-user-sync-worker.ts** (NEW)
4. **apps/search-ai/src/workers/okta-group-sync-worker.ts** (NEW)
5. **apps/search-ai/src/workers/google-user-sync-worker.ts** (NEW)
6. **apps/search-ai/src/workers/google-group-sync-worker.ts** (NEW)

#### Implementation Strategy

**Phase 1: Azure AD Only (Week 1-2)**

- Implement azuread-user-sync-worker (delta query support)
- Implement azuread-group-sync-worker (nested groups)
- Test with real Azure AD tenant
- Manual trigger API + scheduled daily sync

**Phase 2: Okta + Google (Week 3-4)**

- Replicate for Okta (uses different API)
- Replicate for Google (Directory API)
- Test multi-IdP scenarios

**Phase 3: Incremental Sync (Week 5)**

- Implement delta queries (avoid full re-sync)
- Webhook support for real-time updates
- Conflict resolution (user belongs to multiple IdPs)

#### Data Flow

```
Azure AD / Okta / Google
    ↓ (Microsoft Graph API / Okta API / Directory API)
IdP Sync Workers (NEW)
    ↓ (batchUpsertUsers, batchUpsertGroups, setMembership)
Neo4j Permission Graph
    ↓ (getUserGroups, getFlattenedPermissions)
Query Pipeline + Embedding Worker
```

#### Risk Assessment

- **CRITICAL**: Entire RFC depends on this data pipeline
- **Failure mode**: Empty User/Group nodes → all documents filtered out
- **Performance**: Full sync takes ~30s for 1000 users + 100 groups
- **Consistency**: Race condition between user sync and permission queries

#### Mitigation

- ✅ BullMQ retry with exponential backoff
- ✅ Checkpoint/resume for large tenants (>10k users)
- ✅ Dry-run mode for testing before production
- ✅ Monitoring dashboards for sync status
- ✅ Fallback to public mode if Neo4j unavailable

---

### Domain 3: Query Pipeline (MEDIUM RISK)

#### Affected Files

1. **apps/search-ai-runtime/src/services/query/query-pipeline.ts** (MODIFY)
   - Inject permission filter before vector search
   - Check req.authMode to decide filter type

2. **apps/search-ai-runtime/src/services/query/permission-filter-service.ts** (NEW)
   - Builds OpenSearch filter from user groups
   - Caches group memberships in Redis

3. **apps/search-ai-runtime/src/services/cache/group-membership-cache.ts** (NEW)
   - Redis-backed cache (5-min TTL)
   - Tenant-scoped keys

4. **packages/search-ai-internal/src/permissions/permission-graph-service.ts** (READ ONLY)
   - Already exists with circuit breaker
   - No changes needed!

#### Changes Required

**Before:**

```typescript
// No permission filtering
const results = await openSearchClient.search({
  index: indexName,
  body: {
    query: {
      knn: { vector: embedding, k: 10 },
    },
  },
});
```

**After (RFC Section 3.5):**

```typescript
// With permission filtering
const permissionFilter =
  req.authMode === 'user'
    ? await this.permissionFilterService.buildPermissionFilter(tenantId, req.userIdentity)
    : await this.permissionFilterService.buildPublicFilter();

const results = await openSearchClient.search({
  index: indexName,
  body: {
    query: {
      bool: {
        must: [{ knn: { vector: embedding, k: 10 } }],
        filter: permissionFilter, // NEW: Permission filter
      },
    },
  },
});
```

#### Permission Filter Structure

```json
{
  "bool": {
    "should": [
      { "term": { "permissions.publicEverywhere": true } },
      { "term": { "permissions.allowedUsers": "john.doe@company.com" } },
      { "terms": { "permissions.allowedGroups": ["azuread:g_hr", "azuread:g_finance"] } }
    ],
    "minimum_should_match": 1
  }
}
```

#### Risk Assessment

- **MEDIUM**: Core query path modified
- **Performance**: +1-2ms per query (post-filter on top-K)
- **Failure mode**: Falls back to public mode if Neo4j circuit open (H3 fix)
- **Consistency**: 5-min cache staleness acceptable for search

#### Mitigation

- ✅ Circuit breaker integration (fixes H3)
- ✅ Fast-fail on cache miss (M1 fix)
- ✅ Monitoring latency breakdown
- ✅ Load test with 80% cache hit rate

---

### Domain 4: Ingestion Pipeline (MEDIUM RISK)

#### Affected Files

1. **apps/search-ai/src/workers/embedding-worker.ts** (MODIFY)
   - Query Neo4j for document permissions
   - Populate permissions field in OpenSearch

2. **apps/search-ai/src/services/document-permissions/document-permission-resolver.ts** (NEW)
   - Wraps PermissionGraphClient.getFlattenedPermissions()
   - Caching layer (avoid Neo4j query per chunk)

#### Changes Required

**Before:**

```typescript
await openSearchClient.index({
  index: getIndexName(chunk.indexId),
  id: chunk.vectorId,
  body: {
    vector: chunk.embedding,
    content: chunk.content,
    metadata: chunk.metadata,
    // No permissions field
  },
});
```

**After (RFC Section 2.2):**

```typescript
// Query Neo4j for document permissions
const permissions = await this.permissionResolver.getDocumentPermissions(tenantId, documentId);

await openSearchClient.index({
  index: getIndexName(chunk.indexId),
  id: chunk.vectorId,
  body: {
    vector: chunk.embedding,
    content: chunk.content,
    metadata: chunk.metadata,
    permissions: {
      // NEW: Permission metadata
      allowedUsers: permissions.allowedUsers,
      allowedGroups: permissions.allowedGroups,
      allowedDomains: permissions.allowedDomains,
      publicInDomain: permissions.publicInDomain,
      publicEverywhere: permissions.publicEverywhere,
      source: permissions.source,
      lastSyncedAt: new Date().toISOString(),
    },
  },
});
```

#### Performance Optimization

**Problem:** Embedding worker processes chunks, not documents. If document has 100 chunks, querying Neo4j 100 times is inefficient.

**Solution:** Document-level caching in permission resolver:

```typescript
export class DocumentPermissionResolver {
  private cache = new Map<string, FlattenedPermissions>();

  async getDocumentPermissions(
    tenantId: string,
    documentId: string,
  ): Promise<FlattenedPermissions> {
    const key = `${tenantId}:${documentId}`;

    if (this.cache.has(key)) {
      return this.cache.get(key)!;
    }

    const permissions = await this.client.getFlattenedPermissions(tenantId, documentId);
    this.cache.set(key, permissions);

    return permissions;
  }
}
```

**Result:** 1 Neo4j query per document (not per chunk) → 100x reduction.

#### Risk Assessment

- **MEDIUM**: Ingestion throughput may decrease
- **Performance**: +20ms per document (Neo4j query)
- **Failure mode**: Documents indexed without permissions → excluded from user-mode queries (safe failure)

#### Mitigation

- ✅ Circuit breaker on Neo4j queries
- ✅ Graceful skip on permission query failure (log + continue)
- ✅ Batch permission resolution (future optimization)

---

### Domain 5: OpenSearch Schema (LOW RISK)

#### Affected Files

1. **packages/search-ai-internal/src/vector-store/opensearch-mappings.ts** (MODIFY)
   - Add permissions field to VECTOR_INDEX_MAPPING

2. **apps/search-ai/scripts/recreate-dev-indexes.ts** (MODIFY)
   - Drop existing dev/staging indexes
   - Recreate with new mapping

#### Changes Required

**Before:**

```typescript
export const VECTOR_INDEX_MAPPING = {
  mappings: {
    dynamic: 'strict',
    properties: {
      vector: {
        /* ... */
      },
      content: {
        /* ... */
      },
      metadata: {
        /* ... */
      },
      // No permissions field
    },
  },
};
```

**After (RFC Section 2.2):**

```typescript
export const VECTOR_INDEX_MAPPING = {
  mappings: {
    dynamic: 'strict',
    properties: {
      vector: {
        /* ... */
      },
      content: {
        /* ... */
      },
      metadata: {
        /* ... */
      },
      permissions: {
        // NEW
        type: 'object',
        properties: {
          publicEverywhere: { type: 'boolean' },
          publicInDomain: { type: 'boolean' },
          allowedUsers: { type: 'keyword' }, // Array
          allowedGroups: { type: 'keyword' }, // Array
          allowedDomains: { type: 'keyword' }, // Array
          source: { type: 'keyword' },
          lastSyncedAt: { type: 'date' },
        },
      },
    },
  },
};
```

#### Pre-Production Migration (SIMPLE)

**Per RFC-SEARCHAI-IDP-AUTHENTICATION-MIGRATION-ANALYSIS.md:**

```bash
# 1. Update mapping template (code change)
git add packages/search-ai-internal/src/vector-store/opensearch-mappings.ts

# 2. Drop existing dev indexes
pnpm run search-ai:drop-indexes --env dev --confirm

# 3. Recreate with new mapping
pnpm run search-ai:create-indexes --env dev

# 4. Re-ingest test data
pnpm run search-ai:ingest-sample-docs --env dev --count 100

# 5. Verify permissions field exists
curl -X GET "localhost:9200/search-chunks-dev-*/_mapping" | jq '.*.mappings.properties.permissions'
```

**No backfill needed!** (Product not in production)

#### Risk Assessment

- **LOW**: Schema change is additive (not breaking)
- **Storage overhead**: +3% per chunk (~150 bytes)
- **Query performance**: +1-2ms (post-filter on keyword fields)

#### Mitigation

- ✅ Pre-production environment allows destructive changes
- ✅ Schema change documented in migration analysis
- ✅ Rollback: Drop indexes and recreate with old mapping

---

### Domain 6: Redis Caching (MEDIUM RISK)

#### Affected Files

1. **apps/search-ai-runtime/src/services/cache/group-membership-cache.ts** (NEW)
   - Caches user → groups mapping
   - 5-min TTL, tenant-scoped keys

2. **apps/search-ai-runtime/src/services/cache/jwks-cache.ts** (NEW)
   - Caches JWKS keys per IdP issuer
   - 1-hour TTL, shared across pods

3. **apps/search-ai-runtime/src/services/cache/redis-client.ts** (READ ONLY)
   - Already exists, no changes needed

#### Cache Key Patterns

```typescript
// Group membership cache
`searchai:groups:${tenantId}:${email}` → JSON.stringify(groupIds)

// JWKS cache
`searchai:jwks:${issuer}` → JSON.stringify(jwks)

// Query cache (existing, not modified)
`searchai:query:${tenantId}:${queryHash}` → JSON.stringify(results)
```

#### Cache Invalidation Strategy

**Group membership cache:**

- ✅ TTL-based expiration (5 minutes)
- ✅ Manual invalidation API (on group membership change)
- ✅ Tenant-scoped (safe to flush per tenant)

**JWKS cache:**

- ✅ TTL-based expiration (1 hour)
- ✅ Fetch-on-miss fallback
- ✅ Shared across all tenants (issuer-based key)

#### Risk Assessment

- **MEDIUM**: Cache misses cause Neo4j load
- **Performance**: 95% cache hit rate → 20ms P95 (target)
- **Consistency**: 5-min staleness acceptable for search

#### Mitigation

- ✅ Circuit breaker on cache failures (fall back to Neo4j direct)
- ✅ Monitoring cache hit rate per tenant
- ✅ Graceful degradation to public mode on both cache + Neo4j failure

---

### Domain 7: API Routes (LOW RISK)

#### New Endpoints

1. **POST /api/permissions/:documentId/resync**
   - Manually re-sync permissions for a document
   - Updates OpenSearch from Neo4j
   - Requires `search:index:write` permission

2. **POST /api/domains/verify**
   - Trigger domain verification (DNS/email/manual)
   - Creates Domain node in Neo4j
   - Returns verification status

3. **GET /api/idp/sync/status**
   - Check IdP sync status (last sync time, errors)
   - Returns user/group counts
   - Debugging endpoint for admins

#### Risk Assessment

- **LOW**: New endpoints, no existing functionality broken
- **Failure mode**: 404 if not implemented (acceptable)

---

### Domain 8: Monitoring (LOW RISK)

#### Metrics to Add

```typescript
// Permission filter latency histogram
permissionFilterLatencyHistogram.record(latency, {
  tenantId,
  authMode: 'user' | 'public',
  cacheHit: boolean,
});

// IdP sync success/failure counter
idpSyncCounter.add(1, {
  tenantId,
  idpProvider: 'azuread' | 'okta' | 'google',
  syncType: 'users' | 'groups',
  status: 'success' | 'failure',
});

// JWKS cache hit rate
jwksCacheHitRateCounter.add(1, {
  issuer,
  hit: boolean,
});
```

#### Dashboards Needed

1. **Permission Filter Performance**
   - P50/P95/P99 latency breakdown
   - Cache hit rate by tenant
   - Neo4j circuit breaker status

2. **IdP Sync Health**
   - Last sync time per IdP
   - User/group count trends
   - Sync error rate

3. **Security Audit**
   - Invalid token attempts
   - Permission filter bypasses
   - Cross-tenant access attempts

---

## Part 3: Implementation Roadmap

### Phase 1: Core Authentication (Week 1-2) — 40h

**Goal:** Get IdP token validation working

1. **Day 1-2:** Implement IdPTokenValidator (6h)
   - JWKS fetching + caching (Redis)
   - JWT signature verification
   - Multi-IdP support (Azure AD, Okta, Google)

2. **Day 3-4:** Update auth middleware (4h)
   - Add X-Auth-Mode + X-End-User-Token handling
   - Integrate IdPTokenValidator
   - Error handling + logging

3. **Day 5-6:** Implement PermissionFilterService (8h)
   - buildPermissionFilter() for user mode
   - buildPublicFilter() for public mode
   - Redis group cache integration

4. **Day 7-8:** Query pipeline integration (8h)
   - Inject permission filter in QueryPipeline
   - Circuit breaker integration (fix H3)
   - Load testing

5. **Day 9-10:** OpenSearch schema update (4h)
   - Update VECTOR_INDEX_MAPPING
   - Recreate dev/staging indexes
   - Verify mapping with sample docs

**Deliverables:**

- ✅ IdP token validation working
- ✅ Permission filter injected in query pipeline
- ✅ OpenSearch schema updated

---

### Phase 2: Neo4j Sync (Week 3-4) — 48h

**Goal:** Get users and groups syncing from Azure AD

1. **Day 1-3:** Azure AD user sync worker (12h)
   - Microsoft Graph client integration
   - Pagination (handle 10k+ users)
   - Delta query support (incremental sync)
   - Error handling + retry logic

2. **Day 4-6:** Azure AD group sync worker (12h)
   - Group + membership sync
   - Nested group support
   - Batch operations (100 groups per batch)

3. **Day 7-8:** Manual trigger API (6h)
   - POST /api/idp/sync/trigger
   - Enqueue BullMQ job
   - Return sync status

4. **Day 9-10:** Scheduled sync (4h)
   - Daily cron job (BullMQ repeat)
   - Monitoring + alerting
   - Dry-run mode for testing

5. **Day 11-12:** Testing with real Azure AD tenant (14h)
   - Test with 1000+ users
   - Test nested groups (5 levels)
   - Test permission queries
   - Performance benchmarking

**Deliverables:**

- ✅ Azure AD user/group sync working
- ✅ Scheduled daily sync
- ✅ Users visible in Neo4j graph

---

### Phase 3: Ingestion Integration (Week 5) — 16h

**Goal:** Populate permissions field in OpenSearch

1. **Day 1-2:** DocumentPermissionResolver (4h)
   - Wrap PermissionGraphClient.getFlattenedPermissions()
   - Document-level caching
   - Error handling

2. **Day 3-4:** Update embedding worker (6h)
   - Call permissionResolver.getDocumentPermissions()
   - Populate permissions field
   - Graceful skip on Neo4j failure

3. **Day 5:** Re-ingest test documents (3h)
   - Drop + recreate dev index
   - Re-ingest with permissions populated
   - Verify permissions field in OpenSearch

4. **Day 6:** Permission re-sync API (3h)
   - POST /api/permissions/:documentId/resync
   - Update existing documents
   - Bulk re-sync endpoint

**Deliverables:**

- ✅ Permissions field populated on new documents
- ✅ Re-sync API working for existing documents

---

### Phase 4: Okta + Google Support (Week 6-7) — 32h

**Goal:** Add Okta and Google IdP support

1. **Week 6:** Okta sync workers (16h)
   - Replicate Azure AD implementation
   - Okta API client
   - User + group sync

2. **Week 7:** Google sync workers (16h)
   - Google Directory API client
   - User + group sync
   - OAuth2 flow for service accounts

**Deliverables:**

- ✅ All 3 IdPs supported (Azure AD, Okta, Google)
- ✅ Multi-IdP tenant testing

---

### Phase 5: Testing & Rollout (Week 8-9) — 24h

**Goal:** Production readiness

1. **Week 8:** Integration testing (12h)
   - End-to-end user flow
   - Multi-tenant isolation
   - Performance benchmarking
   - Security testing

2. **Week 9:** Monitoring + docs (12h)
   - OpenTelemetry dashboards
   - Runbook for IdP sync failures
   - API documentation
   - User guide (how to configure IdP)

**Deliverables:**

- ✅ RFC fully implemented
- ✅ All tests passing
- ✅ Documentation complete

---

## Part 4: Critical Decisions Needed

### Decision #1: IdP Sync Strategy

**Options:**

1. **Full sync every 24 hours** (simple, current plan)
   - ✅ Easy to implement
   - ❌ Up to 24h staleness for new users
   - ❌ Expensive for large tenants (10k+ users)

2. **Delta sync every 1 hour** (recommended)
   - ✅ Lower latency (1h max staleness)
   - ✅ Cheaper (only syncs changes)
   - ❌ Requires delta query API support (Azure AD has it, Okta/Google may not)

3. **Webhook-driven real-time sync**
   - ✅ Near real-time (seconds)
   - ✅ Most efficient
   - ❌ Complex setup (webhook endpoints, signature verification)
   - ❌ Not all IdPs support webhooks

**Recommendation:** Start with **#1 (full sync daily)** for MVP, migrate to **#2 (delta hourly)** in Phase 2, add **#3 (webhooks)** for enterprise tier.

---

### Decision #2: Domain Verification Method

**Options:**

1. **IdP trust** (recommended for MVP)
   - Auto-verify domains from Azure AD tenant config
   - ✅ Zero user friction
   - ❌ Only works for primary domain

2. **DNS TXT record**
   - User adds TXT record to domain DNS
   - ✅ Industry standard
   - ❌ Requires DNS access

3. **Email verification**
   - Send verification link to admin@domain.com
   - ✅ Simple
   - ❌ Requires email access

**Recommendation:** **#1 (IdP trust)** for MVP, add #2/#3 for custom domains in Phase 2.

---

### Decision #3: Permission Staleness Tolerance

**Question:** How stale can permissions be before re-indexing?

**Current RFC:** 5-minute cache TTL for group memberships

**Trade-offs:**

- **Shorter TTL (1 min):** More Neo4j load, fresher data
- **Longer TTL (15 min):** Less load, staler data
- **Event-driven:** Webhook triggers cache invalidation (complex)

**Recommendation:** Keep **5-minute TTL** for query cache, add manual cache invalidation API for urgent permission changes.

---

### Decision #4: Fallback Behavior on Neo4j Unavailability

**Options:**

1. **Return 503 Service Unavailable**
   - ✅ Honest error reporting
   - ❌ Breaks user experience

2. **Fall back to public mode**
   - ✅ Graceful degradation
   - ❌ May leak private documents (if public mode too permissive)

3. **Return cached results (stale OK)**
   - ✅ Best UX
   - ❌ May show outdated results

**RFC choice:** **#2 (fall back to public mode)** with circuit breaker

**Recommendation:** **#2** is correct, but add audit logging to track when fallback occurs.

---

## Part 5: Risk Summary

### CRITICAL Risks (Block Implementation)

| Risk                                           | Impact                                    | Mitigation                                     |
| ---------------------------------------------- | ----------------------------------------- | ---------------------------------------------- |
| **R1: IdP sync workers missing**               | RFC cannot work without User/Group data   | Implement in Phase 2 (48h)                     |
| **R2: IdP credentials not configured**         | No data to sync                           | Require LLMCredential setup in onboarding      |
| **R3: Neo4j circuit open for extended period** | All user-mode queries fall back to public | Monitoring + alerting, auto-recovery after 60s |
| **R4: Permission cache poisoning**             | Unauthorized access                       | Tenant-scoped keys, Redis ACLs, audit logging  |

### HIGH Risks (Monitor Closely)

| Risk                                             | Impact                            | Mitigation                                            |
| ------------------------------------------------ | --------------------------------- | ----------------------------------------------------- |
| **R5: JWKS fetch fails during token validation** | All user-mode queries return 401  | Redis cache, 1h TTL, circuit breaker on JWKS endpoint |
| **R6: Neo4j query timeout in query path**        | Slow queries exceed 500ms budget  | Fast-fail on cache miss, 200ms Neo4j timeout          |
| **R7: IdP sync fails silently**                  | Stale user/group data             | Monitoring dashboard, alerting on sync age >48h       |
| **R8: Domain verification bypassed**             | Unauthorized domain-scoped access | Require verified=true in Neo4j query                  |

### MEDIUM Risks (Acceptable with Mitigation)

| Risk                                       | Impact                                          | Mitigation                            |
| ------------------------------------------ | ----------------------------------------------- | ------------------------------------- |
| **R9: Cache staleness (5 min)**            | User doesn't see permission changes immediately | Manual cache invalidation API         |
| **R10: OpenSearch storage overhead (+3%)** | Increased costs                                 | Acceptable for security feature       |
| **R11: Permission re-sync lag**            | Documents indexed without permissions           | Graceful skip, background re-sync job |

---

## Part 6: Final Recommendations

### ✅ APPROVE RFC WITH MODIFICATIONS

**Core design is sound, but implementation requires 5 new components:**

1. **IdPTokenValidator** (6h) — CRITICAL
2. **3x IdP Sync Workers** (48h) — CRITICAL
3. **PermissionFilterService** (8h) — CRITICAL
4. **DocumentPermissionResolver** (4h) — HIGH
5. **Permission Re-sync API** (6h) — MEDIUM

**Revised Timeline:**

- **Original RFC:** 6 weeks (pre-production simplified)
- **With gaps:** **8-9 weeks** (+2-3 weeks for IdP sync workers)

**Implementation Priority:**

1. **Phase 1 (Week 1-2):** Authentication + Query Pipeline (no IdP sync yet)
2. **Phase 2 (Week 3-4):** Azure AD sync (CRITICAL blocker removed)
3. **Phase 3 (Week 5):** Ingestion integration
4. **Phase 4 (Week 6-7):** Okta + Google sync
5. **Phase 5 (Week 8-9):** Testing + rollout

**Must-Fix Before Merge:**

- ✅ Implement IdPTokenValidator with Redis JWKS cache (fixes H1)
- ✅ Implement Azure AD user/group sync workers
- ✅ Update embedding worker to populate permissions field
- ✅ Add circuit breaker integration in query pipeline (fixes H3)

**Can Defer to Phase 2:**

- Okta + Google sync workers (only Azure AD needed for MVP)
- Domain verification workflow (use IdP trust for MVP)
- Permission re-sync API (can manually re-ingest documents)
- Webhook-driven sync (start with daily full sync)

---

## Appendix: File Change Checklist

### Files to CREATE (8 new files)

- [ ] `apps/search-ai-runtime/src/services/idp/idp-token-validator.ts`
- [ ] `apps/search-ai-runtime/src/middleware/permission-filter.middleware.ts`
- [ ] `apps/search-ai-runtime/src/services/query/permission-filter-service.ts`
- [ ] `apps/search-ai-runtime/src/services/cache/group-membership-cache.ts`
- [ ] `apps/search-ai-runtime/src/services/cache/jwks-cache.ts`
- [ ] `apps/search-ai/src/workers/azuread-user-sync-worker.ts`
- [ ] `apps/search-ai/src/workers/azuread-group-sync-worker.ts`
- [ ] `apps/search-ai/src/services/document-permissions/document-permission-resolver.ts`

### Files to MODIFY (15 existing files)

- [ ] `apps/search-ai-runtime/src/middleware/auth.ts` (add IdP token handling)
- [ ] `apps/search-ai-runtime/src/services/query/query-pipeline.ts` (inject permission filter)
- [ ] `apps/search-ai-runtime/src/routes/query.ts` (add permission filter middleware)
- [ ] `apps/search-ai/src/workers/embedding-worker.ts` (populate permissions field)
- [ ] `packages/search-ai-internal/src/vector-store/opensearch-mappings.ts` (add permissions field)
- [ ] `apps/search-ai/scripts/recreate-dev-indexes.ts` (drop + recreate with new mapping)
- [ ] `packages/search-ai-sdk/src/constants.ts` (add new queue names)
- [ ] `apps/search-ai/src/workers/index.ts` (register new workers)
- [ ] `apps/search-ai/src/workers/shared.ts` (add new job data types)
- [ ] `apps/search-ai-runtime/src/routes/index.ts` (add permission resync route)
- [ ] `apps/search-ai-runtime/src/services/metrics/index.ts` (add permission metrics)
- [ ] `packages/database/src/models/llm-credential.model.ts` (no changes, but validate encryption works)
- [ ] `packages/database/src/models/tenant-model.model.ts` (no changes, but validate IdP metadata fields)
- [ ] `docs/searchai/SERVICES-INVENTORY.md` (document new workers)
- [ ] `docs/plans/RFC-SEARCHAI-IDP-AUTHENTICATION.md` (add implementation checklist)

### Files to READ (No Changes, Verify Compatibility)

- [x] `packages/search-ai-internal/src/permissions/permission-graph-client.ts` (✅ RFC-compliant)
- [x] `packages/search-ai-internal/src/permissions/permission-graph-service.ts` (✅ has circuit breaker)
- [x] `packages/search-ai-internal/src/permissions/types.ts` (✅ schema complete)
- [x] `apps/search-ai-runtime/src/services/cache/redis-client.ts` (✅ works as-is)

---

**End of Gap Analysis Report**

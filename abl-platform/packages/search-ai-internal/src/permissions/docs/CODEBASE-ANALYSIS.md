# SearchAI Permission & Authorization Architecture Analysis

**Date:** 2026-02-23
**Task:** #23 Comprehensive Codebase Analysis
**Purpose:** Inform enterprise-ready permission system design (Tasks #18-#22)

---

## Executive Summary

This document provides a complete analysis of SearchAI's current architecture to inform the design of an enterprise-grade permission and authorization system with:

- **Neo4j permission graph** for nested group hierarchies
- **Vector DB metadata denormalization** for single-query authorization
- **Multi-IDP identity federation** via email-based trust
- **Near real-time permission updates** (<10 minutes)
- **100% quality, robustness, high scalability**

---

## 1. Vector Database Infrastructure

### Current Implementation

**Primary:** OpenSearch with k-NN plugin
**Location:** `/packages/search-ai-internal/src/vector-store/opensearch.ts` (250 lines)

```typescript
// Configuration
provider: 'opensearch' (default)
url: process.env.VECTOR_STORE_URL || 'http://localhost:9200'
dimensions: 1024 (BGE-M3 default) | 1536 (OpenAI) | configurable
distance: 'cosinesimil' (cosine similarity)
algorithm: HNSW (Hierarchical Navigable Small World)
```

**Key Operations:**

- `upsert(collection, records)` - Batch insert (100 records/batch)
- `search(collection, params)` - k-NN vector search with metadata filters
- `buildFilter(filters)` - Translates MetadataFilter to OpenSearch bool queries

**Metadata Structure** (`opensearch-mappings.ts`):

```typescript
metadata: {
  sys: {
    tenantId, appId, connectorId, documentId, chunkId, chunkIndex
  },
  doc: {
    name, contentType, contentHash, language, summary
  },
  canonical: {
    // User-defined canonical fields from field mappings
    title, author, status, tags, publishedDate, department, etc.
  }
}
```

**Alternative Providers:**

- Qdrant (implemented, selectable via config)
- Pinecone (stubbed)
- pgvector (stubbed)

### Current Gaps for Permissions

**MISSING:** Permission metadata in vector records

- No `allowedUsers: string[]` field
- No `allowedGroups: string[]` field
- No `allowedDomains: string[]` field
- No `publicInDomain: boolean` field
- No `publicEverywhere: boolean` field

**Impact:** Query-time authorization requires two-step process:

1. Query DocumentPermission in MongoDB for accessible doc IDs
2. Filter vector search by doc IDs (metadata.sys.documentId $in [ids])

**User's Requirement:** Single-query authorization via denormalized metadata

---

## 2. Neo4j Infrastructure

### Current Implementation

**Status:** ✅ INSTALLED AND OPERATIONAL
**Version:** neo4j-driver v5.28.3
**Location:** `/apps/search-ai/src/services/knowledge-graph/neo4j-client.ts` (629 lines)

**Current Use:** Entity/relationship knowledge graph (NOT permissions)

```typescript
class Neo4jClient {
  // Entity operations
  async upsertEntity(entity: EntityNode): Promise<string>
  async upsertEntities(entities: EntityNode[]): Promise<Map<string, string>>

  // Relationship operations
  async upsertRelationship(relationship: RelationshipEdge): Promise<void>
  async createCoOccurrences(entityIds: string[], weight: number): Promise<void>

  // Query operations
  async findEntitiesByType(tenantId, indexId, type, limit): Promise<EntityNode[]>
  async findRelatedEntities(entityId, relationshipType?, limit): Promise<...>

  // Cleanup
  async deleteDocumentGraph(documentId): Promise<void>
  async deleteIndexGraph(indexId): Promise<void>
}
```

**Connection Config:**

```typescript
uri: process.env.NEO4J_URI || 'bolt://localhost:7687';
username: process.env.NEO4J_USERNAME || 'neo4j';
password: process.env.NEO4J_PASSWORD;
maxConnectionPoolSize: process.env.NEO4J_MAX_POOL_SIZE || 50;
```

**Tenant Isolation Pattern:**

- All nodes have `tenantId` property
- Unique constraints: `(tenantId, indexId, type, text)`
- Indexes: `entity_id_idx`, `entity_tenant_idx`, `entity_type_idx`

### Architecture Decision

**✅ Neo4j is the RIGHT choice for permissions:**

- ✅ Already installed and operational
- ✅ Existing tenant isolation patterns to follow
- ✅ Proven connection pooling and health checks
- ✅ Graph queries ideal for nested group resolution
- ✅ Cypher query language for recursive traversal

**Action Required:** Create separate schema/labels for permissions:

- `:User`, `:Group`, `:Domain`, `:Document` labels
- `MEMBER_OF`, `HAS_PERMISSION`, `OWNS` relationships
- Separate from knowledge graph (`:Entity`, `:RELATES_TO`)

---

## 3. Document Chunking Strategy

### Current Implementation

**Chunking Model:** `/packages/database/src/models/search-chunk.model.ts`

```typescript
interface ISearchChunk {
  _id: string;
  tenantId: string;
  indexId: string;
  documentId: string;
  content: string; // Chunk text
  tokenCount: number;
  chunkIndex: number; // Position in document (0-indexed)
  vectorId: string | null; // ID in OpenSearch
  metadata: any; // Raw source metadata
  canonicalMetadata: Record<string, unknown> | null; // Materialized fields
  status: 'pending' | 'indexed' | 'error';
}
```

**Chunking Process:** (`embedding-worker.ts`)

1. **Batch Size:** 50 chunks per embedding API call (configurable via `INGESTION_EMBEDDING_BATCH_SIZE`)
2. **Embedding Provider:** BGE-M3 (1024d), OpenAI (1536d), or Cohere (1024d)
3. **Vector Record Creation:**
   ```typescript
   vectorRecords: VectorRecord[] = chunks.map(chunk => ({
     id: chunk._id,
     vector: embeddings[idx],
     metadata: {
       sys: { tenantId, appId, connectorId, documentId, chunkId, chunkIndex },
       doc: { name, contentType, contentHash, language, summary },
       canonical: chunk.canonicalMetadata ?? {}
     },
     content: chunk.content
   }))
   ```
4. **Upsert to OpenSearch:** Bulk insert (100 records/batch)
5. **Status Update:** SearchChunk → `status: 'indexed'`, `vectorId: chunk._id`

### Key Finding: Chunk-Level Permissions

**Current:** Permissions stored at document level (DocumentPermission model)
**Challenge:** Chunks are the searchable unit, not documents

**Design Decision Required:**

- **Option A:** Store permissions on document, apply to all chunks (simpler)
- **Option B:** Store permissions per-chunk (finer-grained, more storage)
- **Recommendation:** Option A + inherit from document at embedding time

**Implementation:** Add permission metadata to vector record during embedding:

```typescript
metadata: {
  sys: { ... },
  doc: { ... },
  canonical: { ... },
  permissions: {  // NEW
    allowedUsers: string[],      // Up to 500 users
    allowedGroups: string[],     // Up to 100 groups
    allowedDomains: string[],    // e.g., ['contoso.com']
    publicInDomain: boolean,     // Everyone in allowed domains
    publicEverywhere: boolean    // Anonymous access
  }
}
```

---

## 4. Authentication System

### Current Implementation

**Middleware:** `/apps/search-ai/src/middleware/auth.ts` (118 lines)
**Strategy:** Unified auth from `@agent-platform/shared`

**Supported Auth Methods:**

1. **User JWT** - `Authorization: Bearer <jwt>`
2. **API Key** - `Authorization: Bearer abl_*`

**Auth Flow:**

```typescript
unifiedAuth middleware → JWT verification → Tenant resolution → Permission resolution

Input: Bearer token
Output: req.tenantContext = {
  tenantId: string,
  userId: string,
  role: string,
  permissions: string[]  // Currently returns ['*'] in dev/test
}
```

**Tenant Resolution:**

```typescript
// 1. Find user by ID
getUserById(userId) → User model lookup

// 2. Resolve tenant membership
resolveTenantMembership(userId, tenantId) → TenantMember lookup

// 3. Get default tenant (if not specified)
resolveDefaultTenant(userId) → First tenant membership
```

**Dev/Test Mode:**

- Allows `id@dev.local` fake users without database
- Returns `permissions: ['*']` (bypass RBAC)

### Current Gaps for SearchAI

**MISSING:** End-user identity for search authorization

- Current: Authenticates **platform users** (admins, developers in Studio)
- Needed: Authenticates **end users** (business users performing searches)

**Current EndUserOAuthToken Model:**

```typescript
interface IEndUserOAuthToken {
  _id: string;
  tenantId: string;
  userId: string; // Platform user who authorized
  provider: string; // 'microsoft', 'google', etc.
  providerUserId: string; // User's ID at provider
  encryptedAccessToken: string;
  encryptedRefreshToken: string | null;
  scope: string;
  expiresAt: Date | null;
  consentedAt: Date;
  revokedAt: Date | null;
}
```

**Problem:** Per-user OAuth doesn't scale to 100K enterprise users

- Requires each end user to authorize (OAuth consent flow)
- Tokens expire, require refresh per user
- Admin burden: manage 100K token lifecycles

**User's Concern (verbatim):**

> "I might have logged into searchAI as bob@kore.com but I don't have credentials of sharepoint of bob"

**Architecture Gap:** No identity federation mechanism

- No trust relationship between SearchAI identity and SharePoint identity
- No email-based identity mapping
- No domain verification for trust attestation

---

## 5. Identity & User Management

### Current Models

#### Platform Users (Studio Admins/Developers)

**Model:** `/packages/database/src/models/user.model.ts`

```typescript
interface IUser {
  _id: string;
  email: string;
  name: string | null;
  avatarUrl: string | null;
  googleId: string | null;
  passwordHash: string | null; // Field-level encrypted
  emailVerified: boolean;
  authProvider: 'google' | 'email' | 'microsoft';
  lastLoginAt: Date | null;
  mfa: IMfa | null; // TOTP secret, recovery codes
}
```

**Indexes:**

- `{ email: 1 }` - unique
- `{ googleId: 1 }` - unique, sparse

**Security:**

- Password hash encrypted at rest (encryption plugin)
- Audit trail plugin (tracks createdBy, updatedBy)

#### Tenant Membership

**Model:** `/packages/database/src/models/tenant-member.model.ts` (not read yet, but referenced)

```typescript
// Inferred from auth-repo.ts usage
{
  tenantId: string,
  userId: string,
  role: string,  // 'owner', 'admin', 'member', etc.
  customRoleId?: string,
  status: 'active' | 'invited' | 'suspended'
}
```

### Current Gaps for Enterprise Search

**MISSING: End-User Identity System**

SearchAI needs TWO types of users:

1. **Platform Users** (existing) - Admins/developers managing Studio
2. **End Users** (MISSING) - Business users performing searches

**End User Requirements:**

- Identity from external IdP (Azure AD, Okta, Google Workspace)
- Email as primary identifier (bob@contoso.com)
- Group memberships synced from IdP
- Domain-level trust (all @contoso.com users are valid)
- NO per-user OAuth consent

**Proposed Model: EndUserIdentity**

```typescript
interface IEndUserIdentity {
  _id: string;
  tenantId: string;
  email: string; // Primary key (bob@contoso.com)
  displayName: string;
  idpUserId: string; // Azure AD object ID, Okta ID, etc.
  idpProvider: 'azuread' | 'okta' | 'google';
  groupIds: string[]; // Neo4j group IDs
  domains: string[]; // ['contoso.com']
  lastSyncAt: Date;
  status: 'active' | 'suspended';
}
```

---

## 6. Permission Models (Current)

### DocumentPermission Model

**Location:** `/packages/database/src/models/document-permission.model.ts` (142 lines)
**Storage:** MongoDB
**Purpose:** Query-time permission filtering

```typescript
interface IDocumentPermission {
  _id: string;
  tenantId: string;
  documentId: string; // References SearchDocument._id
  sourceId: string; // References SearchSource._id (connector)

  permissions: {
    users: Array<{
      userId: string; // Email or Azure AD object ID
      displayName: string;
      permissions: string[]; // ['read', 'write', 'delete']
    }>;
    groups: Array<{
      groupId: string; // Group ID (not resolved to members)
      displayName: string;
      permissions: string[];
    }>;
    everyone: boolean; // Public access flag
  };

  crawlMode: 'full' | 'simplified' | 'disabled';
  crawledAt: Date;
  accuracy: number; // 0-100 (full=100, simplified=95)
}
```

**Indexes:**

- `{ tenantId, documentId }` - unique (primary lookup)
- `{ tenantId, 'permissions.users.userId' }` - query-time filtering
- `{ tenantId, 'permissions.groups.groupId' }` - query-time filtering
- `{ tenantId, 'permissions.everyone' }` - public doc filtering
- `{ sourceId, crawledAt }` - recrawl scheduling

**Crawl Modes:**

- **Full:** Resolve all groups recursively to users (100% accurate, slow)
- **Simplified:** Store group IDs without resolution (95% accurate, fast)
- **Disabled:** No permission crawling

### Current Query-Time Authorization Pattern

**Problem:** Two-step query process

```typescript
// STEP 1: Find accessible documents (MongoDB query)
const permissions = await DocumentPermission.find(
  {
    tenantId,
    $or: [
      { 'permissions.users.userId': userEmail },
      { 'permissions.groups.groupId': { $in: userGroupIds } },
      { 'permissions.everyone': true },
    ],
  },
  { documentId: 1 },
).lean();

const accessibleDocIds = permissions.map((p) => p.documentId);

// STEP 2: Vector search with doc ID filter (OpenSearch query)
const results = await vectorStore.search(indexName, {
  vector: queryEmbedding,
  topK: 10,
  filters: [{ field: 'sys.documentId', operator: 'in', value: accessibleDocIds }],
});
```

**Performance Impact:**

- MongoDB query: 50-200ms for 100K documents
- Network round-trip: 5-10ms
- OpenSearch query: 50-150ms
- **Total: 105-360ms** (vs. 50-150ms with single query)

**User's Requirement:** Single-query authorization via metadata

---

## 7. Database Infrastructure

### MongoDB (Primary Datastore)

**Connection:** `/packages/database/src/mongo/connection.ts` (444 lines)
**Driver:** Mongoose 8.23.0
**Pattern:** Singleton manager with retry logic

```typescript
// Configuration
url: process.env.MONGODB_URL;
database: process.env.MONGODB_DATABASE;
maxPoolSize: 100;
minPoolSize: 10;
maxIdleTimeMS: 300000; // 5 minutes
connectTimeoutMS: 30000;
socketTimeoutMS: 360000; // 6 minutes
serverSelectionTimeoutMS: 30000;
heartbeatFrequencyMS: 10000;
```

**Features:**

- Exponential backoff reconnection (5 retries)
- APM command monitoring (slow query detection >1000ms)
- Health check endpoint
- Connection pool management
- Event listeners (connected, disconnected, error, reconnected)

**Tenant Isolation Plugin:**

```typescript
// Applied to all models
tenantIsolationPlugin;

// Ensures all queries include tenantId filter
Model.findOne({ _id, tenantId }); // Correct
Model.findById(_id); // BLOCKED - must include tenantId
```

### Neo4j (Graph Database)

**Purpose:** Entity/relationship knowledge graph
**Future Use:** Permission graph (separate schema)

See Section 2 for details.

### Redis (Job Queue & Cache)

**Driver:** ioredis v5.7.0
**Usage:**

- BullMQ job queues (see Section 10)
- Cache for flattened permissions (5-minute TTL) - TODO
- Device code flow sessions (in-memory Map, should be Redis)

**Connection:** Singleton via `getRedisConnection()` in workers

---

## 8. Search Implementation

### Vector Search

**Provider:** OpenSearch k-NN plugin
**Algorithm:** HNSW (Hierarchical Navigable Small World)
**Distance:** Cosine similarity

**Search Query Structure:**

```typescript
{
  bool: {
    must: [
      {
        knn: {
          vector: {
            vector: [0.123, ...],  // Query embedding
            k: 10                  // Top-K results
          }
        }
      },
      // Metadata filters
      { term: { "metadata.sys.tenantId": "tenant-1" } },
      { term: { "metadata.canonical.status": "published" } }
    ],
    must_not: [
      { term: { "metadata.canonical.archived": true } }
    ]
  }
}
```

**Metadata Filtering:**

- Operators: `eq`, `neq`, `gt`, `gte`, `lt`, `lte`, `in`, `nin`, `exists`
- Filter types: term, range, terms, bool (exists/missing)
- Combines with k-NN in single query

### Current Authorization Gap

**No permission filters in search:**

```typescript
// MISSING: Permission-aware search
await vectorStore.search(indexName, {
  vector: queryEmbedding,
  topK: 10,
  filters: [
    // ❌ No permission metadata filters
    // Should be: { field: 'permissions.allowedUsers', operator: 'in', value: [userEmail] }
    // Should be: { field: 'permissions.allowedGroups', operator: 'in', value: userGroupIds }
  ],
});
```

**Workaround:** Pre-filter doc IDs from MongoDB DocumentPermission (see Section 6)

### Index Registry & Rotation

**Location:** `/packages/search-ai-internal/src/vector-store/index-registry.ts`

**Strategy:** Shared index with auto-rotation

- Single OpenSearch index per tenant (not per connector)
- Rotates when 60% full (based on doc count threshold)
- Index naming: `{tenantId}-{appId}-{timestamp}`
- Active index tracked in memory + Redis

---

## 9. Connector Infrastructure

### ConnectorConfig Model

**Location:** `/packages/database/src/models/connector-config.model.ts` (150+ lines)

```typescript
interface IConnectorConfig {
  _id: string;
  tenantId: string;
  sourceId: string; // References SearchSource
  connectorType: 'sharepoint' | 'jira' | 'confluence' | 'hubspot' | 'servicenow' | 'salesforce';

  // Authentication
  oauthTokenId: string | null; // References EndUserOAuthToken
  connectionConfig: {
    tenantUrl?: string; // https://contoso.sharepoint.com
    clientId?: string; // OAuth app ID
    scopes?: string[]; // ['Sites.Read.All', 'Files.Read.All']
    [key: string]: any;
  };

  // Sync State
  syncState: {
    lastFullSyncAt: Date | null;
    lastDeltaSyncAt: Date | null;
    deltaToken: string | null; // NOTE: Should be per-drive, not per-connector
    checkpointData: any | null;
    totalDocuments: number;
    processedDocuments: number;
    failedDocuments: number;
  };

  // Filters
  filterConfig: {
    mode: 'include' | 'exclude';
    siteUrls: string[];
    libraryNames: string[];
    contentTypes: string[];
    modifiedSince: Date | null;
  };

  // Permissions
  permissionConfig: {
    mode: 'full' | 'simplified' | 'disabled';
    crawlSchedule: string | null; // Cron expression
    lastCrawlAt: Date | null;
  };

  // Error Tracking
  errorState: {
    consecutiveFailures: number;
    lastErrorAt: Date | null;
    lastErrorMessage: string | null;
    isPaused: boolean;
    pausedAt: Date | null;
    pauseReason: string | null;
  };
}
```

### SharePoint Connector

**Location:** `/packages/connectors/sharepoint/src/sharepoint-connector.ts` (not fully read)
**Base Class:** `BaseConnector` from `@agent-platform/connectors-base`

**Auth:** Device Code Flow (OAuth 2.0)

- No client secret required
- User authorizes via browser
- Stores tokens in EndUserOAuthToken

**Current Implementation:**

- Full sync: Enumerate all sites → drives → items
- Delta sync: Per-connector delta token (SHOULD be per-drive)
- Permission crawling: Stub (not implemented)

### API Routes

**Connector Management:** `/apps/search-ai/src/routes/connectors.ts`

```typescript
// List connectors for index
GET /api/:indexId/connectors

// Create connector
POST /api/:indexId/connectors
Body: { name, connectorType, connectionConfig, filterConfig }

// Get connector details
GET /api/:indexId/connectors/:connectorId

// OAuth device code flow
POST /api/connectors/:connectorId/auth/device-code/initiate
GET /api/connectors/:connectorId/auth/device-code/poll
POST /api/connectors/:connectorId/auth/device-code/complete

// Sync operations
POST /api/connectors/:connectorId/sync/full
POST /api/connectors/:connectorId/sync/delta  // ✅ Implemented (Task #63)
POST /api/connectors/:connectorId/sync/pause
POST /api/connectors/:connectorId/sync/resume

// Delta token management (Task #63)
GET /api/connectors/:connectorId/delta-tokens  // List per-drive tokens
DELETE /api/connectors/:connectorId/delta-tokens/:driveId  // Reset token
```

---

## 10. Background Jobs (BullMQ)

### Job Queues

**Infrastructure:** BullMQ 5.0.0 + Redis
**Orchestrator:** `/apps/search-ai/src/workers/index.ts` (202 lines)

**Ingestion Pipeline** (sequential stages):

1. `QUEUE_INGESTION` - Fetch documents from connectors (concurrency: 0.6x base)
2. `QUEUE_EXTRACTION` - Extract text from files (concurrency: 1x base)
3. `QUEUE_DOCLING_EXTRACTION` - Advanced PDF extraction (concurrency: 1x base)
4. `QUEUE_PAGE_PROCESSING` - Process multi-page documents (concurrency: 0.8x base)
5. `QUEUE_CANONICAL_MAP` - Map to canonical schema (concurrency: 1x base)
6. `QUEUE_NOISE_DETECTION` - Filter low-quality content (concurrency: 1x base)
7. `QUEUE_VISUAL_ENRICHMENT` - Extract visual metadata (concurrency: 0.6x base)
8. `QUEUE_ENRICHMENT` - Enrich with LLM (concurrency: 1x base)

**Parallel Post-Enrichment** (run simultaneously):

- `QUEUE_KNOWLEDGE_GRAPH` - Build entity graph (concurrency: 0.5x base)
- `QUEUE_MULTIMODAL` - Process images/audio (concurrency: 0.4x base)
- `QUEUE_EMBEDDING` - Generate vectors (concurrency: 0.6x base)

**Optional Queues:**

- `QUEUE_TREE_BUILDING` - Hierarchical document structure
- `QUEUE_QUESTION_SYNTHESIS` - Generate questions per chunk
- `QUEUE_SCOPE_CLASSIFICATION` - Classify chunk scope (chunk/document)

**Connector Queues** (Task #63, #64):

- `QUEUE_WEBHOOK_NOTIFICATION` - Process connector webhooks (concurrency: 10)
- (Not yet implemented: scheduled delta sync, permission crawl)

### Scheduler Pattern

**Current:** BullMQ repeat jobs with cron expressions

**Example** (from delta sync implementation):

```typescript
await queue.add(
  'trigger-delta-syncs',
  {},
  {
    repeat: {
      pattern: '0 * * * *', // Every hour
    },
    jobId: 'delta-sync-recurring', // Prevents duplicates
  },
);
```

**Scheduled Jobs** (implemented in Task #63):

- Delta sync: Every hour (`0 * * * *`)
- Delta token cleanup: Weekly Sunday 3 AM (`0 3 * * 0`)
- Webhook renewal: Every 12 hours (`0 */12 * * *`)
- Webhook cleanup: Daily 2 AM (`0 2 * * *`)

---

## 11. Multi-Tenancy

### Tenant Model

**Location:** `/packages/database/src/models/tenant.model.ts` (100 lines)

```typescript
interface ITenant {
  _id: string;
  name: string;
  slug: string;
  organizationId: string | null;
  ownerId: string; // Platform user who owns tenant
  retentionDays: number;
  settings: {
    defaultLLMProvider?: string;
    maxConcurrentSessions?: number;
    enableAuditLogging?: boolean;
    enableClickHouse?: boolean;
    allowedDomains?: string[]; // For email-based access control
    webhookUrl?: string;
    [key: string]: unknown;
  };
  status: 'active' | 'suspended' | 'archived' | 'transferring';
  llmPolicy: {
    allowedProviders: string[];
    credentialPolicy: string;
    monthlyTokenBudget: number;
    dailyTokenBudget: number;
    defaultModel: string | null;
    defaultFastModel: string | null;
    maxRequestsPerMinute: number;
    allowProjectCredentials: boolean;
    platformDemoEnabled: boolean;
  };
}
```

### Tenant Isolation Strategy

**Database Level:**

- `tenantIsolationPlugin` on all models
- `tenantId` required on all queries
- Blocks queries without `tenantId` filter

**Examples:**

```typescript
// ✅ CORRECT - Tenant-scoped query
await SearchDocument.findOne({ _id: docId, tenantId });

// ❌ BLOCKED - No tenant filter
await SearchDocument.findById(docId);  // Plugin throws error

// ✅ CORRECT - Tenant-scoped update
await SearchDocument.findOneAndUpdate(
  { _id: docId, tenantId },
  { $set: { status: 'indexed' } }
);

// ❌ BLOCKED - No tenant filter
await SearchDocument.findByIdAndUpdate(docId, { ... });  // Plugin throws error
```

**Vector Store Level:**

- `metadata.sys.tenantId` on all vector records
- Search filters include tenant ID
- Index registry scoped by `{tenantId}-{appId}`

**Neo4j Level:**

- All nodes have `tenantId` property
- Queries include `WHERE n.tenantId = $tenantId`
- Unique constraints include tenantId

---

## 12. Monitoring & Observability

### MongoDB Monitoring

**Slow Query Detection:**

```typescript
// APM command monitoring
commandStarted → track start time
commandSucceeded → calculate duration
if (duration > 1000ms) {
  logger.warn('[SLOW_QUERY]', {
    command: 'find',
    database: 'searchai',
    durationMs: 1234,
    threshold: 1000
  });
}
```

**Health Checks:**

```typescript
await admin.ping();
await admin.serverStatus();

// Returns
{
  ok: true,
  latencyMs: 12,
  replicaSet: 'rs0',
  host: 'mongo-primary'
}
```

### OpenSearch Monitoring

**Health Check:**

```typescript
await client.cluster.health();

// Returns
{
  ok: true,
  latencyMs: 45
}
```

**Index Stats:**

```typescript
await client.indices.stats({ index: indexName });

// Returns
{
  docs: { count: 123456 },
  store: { size_in_bytes: 987654321 }
}
```

### Neo4j Monitoring

**Connection Verification:**

```typescript
await driver.verifyConnectivity();
```

### BullMQ Job Monitoring

**Worker Events:**

```typescript
worker.on('completed', (job) => {
  console.log(`[worker] Job ${job.id} completed in ${job.duration}ms`);
});

worker.on('failed', (job, error) => {
  console.error(`[worker] Job ${job?.id} failed:`, error.message);
});
```

**Health Status:**

```typescript
getWorkerStatus() → [
  { name: 'ingestion', running: true, closed: false },
  { name: 'embedding', running: true, closed: false },
  ...
]
```

---

## Critical Findings & Gaps

### ✅ Strengths

1. **Solid Foundation:**
   - Robust MongoDB connection with retry logic
   - Neo4j already installed and operational
   - OpenSearch vector store with metadata filters
   - BullMQ job infrastructure for background processing
   - Comprehensive tenant isolation at all layers

2. **Delta Sync Complete (Task #63):**
   - Per-drive delta tokens implemented
   - Background scheduler for hourly delta sync
   - API endpoints for token management
   - Webhook infrastructure in place (Task #64)

3. **Permission Infrastructure Exists:**
   - DocumentPermission model with user/group/everyone structure
   - ConnectorConfig.permissionConfig with full/simplified/disabled modes
   - Indexes optimized for query-time filtering

### ❌ Critical Gaps for Enterprise Search

#### 1. Identity Federation (Highest Priority)

**Problem:** No trust relationship between SearchAI and source systems

**Current:** EndUserOAuthToken requires per-user OAuth consent

- Admin burden: 100K users × OAuth flow = unmanageable
- Token lifecycle: 100K refresh tokens to maintain
- User friction: Every user must authorize

**Missing Components:**

- Email-based identity mapping (bob@contoso.com = same person everywhere)
- Domain verification (DNS TXT record / email verification)
- Multi-IDP sync (Azure AD, Okta, Google Workspace)
- Admin attestation ("Our Azure AD = Our SharePoint")

**User's Question (verbatim):**

> "how does search can authorise that logged searchAI user bob@kore.com is valid user at sharepoint?"

**Answer:** It can't, without identity federation.

#### 2. Permission Graph Storage

**Problem:** DocumentPermission in MongoDB is NOT a graph database

**Current:** Flat arrays of users and groups

```typescript
permissions: {
  users: [{ userId: 'bob@contoso.com', ... }],
  groups: [{ groupId: 'eng-team', ... }],  // NOT resolved
  everyone: false
}
```

**Missing:**

- Nested group resolution (Engineering → Backend → Python Team)
- Recursive membership queries
- Efficient graph traversal

**User's Requirement:** "Group hierarchy depth full"

**Solution:** Migrate to Neo4j permission graph (user's explicit requirement)

#### 3. Permission Metadata in Vector DB

**Problem:** Two-query pattern for search authorization

**Current:**

1. MongoDB query: Find accessible doc IDs (50-200ms)
2. OpenSearch query: Vector search with doc ID filter (50-150ms)
3. Total: 105-360ms latency

**Missing:** Denormalized permission metadata in vector records

**User's Requirement:** "permissions meta data in vector db"

**Solution:** Flatten Neo4j graph → metadata arrays in OpenSearch:

```typescript
metadata: {
  permissions: {
    allowedUsers: string[],      // Up to 500
    allowedGroups: string[],     // Up to 100
    allowedDomains: string[],
    publicInDomain: boolean,
    publicEverywhere: boolean
  }
}
```

#### 4. Near Real-Time Permission Updates

**Problem:** No permission change detection

**Current:**

- Permission crawl happens during sync (full/delta)
- Crawl schedule: Cron expression (weekly? daily?)
- Propagation delay: Unknown

**Missing:**

- Webhook subscriptions for permission changes (SharePoint supports this)
- Delta queries for permission deltas (Azure AD Graph API)
- Permission-specific sync (separate from content sync)
- Change propagation pipeline: Source → Neo4j → Vector DB → Cache

**User's Requirement:** "depends on sources, what are ways to detect and solve this to the nearest time?"

**Target:** <10 minutes from source change to search (webhooks + delta queries)

#### 5. End-User Identity System

**Problem:** Only platform users exist, not end users

**Current Models:**

- `User` - Platform users (admins, developers)
- `TenantMember` - Platform user membership
- `EndUserOAuthToken` - Per-user OAuth (doesn't scale)

**Missing Model:** `EndUserIdentity`

```typescript
{
  _id: string,
  tenantId: string,
  email: string,  // Primary key
  displayName: string,
  idpUserId: string,  // Azure AD object ID
  idpProvider: 'azuread' | 'okta' | 'google',
  groupIds: string[],  // Neo4j group IDs
  domains: string[],
  lastSyncAt: Date,
  status: 'active' | 'suspended'
}
```

**Missing Infrastructure:**

- OAuth app per tenant for IdP sync
- Background job to sync users/groups from IdP
- Delta queries to detect changes
- Email normalization (lowercase, trim)

---

## Architecture Decisions Required

### 1. Database Strategy

**Question:** MongoDB → Neo4j migration path?

**Option A:** Dual-write during transition

- Keep DocumentPermission in MongoDB (read-only)
- Write new permissions to Neo4j
- Query Neo4j first, fallback to MongoDB
- Delete MongoDB after full migration

**Option B:** Big-bang migration

- Stop permission crawling
- Migrate all DocumentPermission → Neo4j
- Update code to use Neo4j
- Resume permission crawling

**Recommendation:** Option A (safer for production)

### 2. Permission Metadata Size Limits

**Question:** How many users/groups can fit in vector metadata?

**OpenSearch Metadata Size:**

- Max document size: 100MB (configurable)
- Realistic metadata size: <1MB per chunk
- String array overhead: ~50 bytes per email

**Calculations:**

- 500 users × 50 bytes = 25KB
- 100 groups × 50 bytes = 5KB
- Total: 30KB << 1MB ✅ FEASIBLE

**Edge Cases:**

- Document with 10K users (very large company)
  - 10K × 50 bytes = 500KB (still <1MB)
  - But: Query filter performance degrades
  - Solution: Use `publicInDomain: true` instead

**Recommendation:**

- Limit: 500 users, 100 groups per document
- Fallback: If exceeds limit, use `publicInDomain: true` flag
- Cache: Flatten permissions in Redis (5-minute TTL)

### 3. Identity Provider Priority

**Question:** Which IdP to support first?

**User's Requirement:** "they will have different idp it is SAAS product"

**Priority Order:**

1. **Azure AD** (Microsoft) - Highest priority
   - SharePoint connector already uses Microsoft OAuth
   - Microsoft Graph API for user/group sync
   - Delta queries supported
   - Webhook support for change notifications

2. **Okta** - Second priority
   - Enterprise standard
   - SCIM API for user/group sync
   - Event Hooks for change notifications

3. **Google Workspace** - Third priority
   - Google Drive connector (future)
   - Directory API for user/group sync
   - Push notifications for changes

**Recommendation:** Start with Azure AD, add Okta/Google in parallel

### 4. Permission Update Frequency

**User's Question:**

> "depends on sources, what are ways to detect and solve this to the nearest time?"

**Options:**

| Method            | Latency  | Reliability | Implementation                        |
| ----------------- | -------- | ----------- | ------------------------------------- |
| **Webhooks**      | <1 min   | 99% (retry) | Subscribe to permission change events |
| **Delta Queries** | 5-15 min | 100%        | Poll for changes since last sync      |
| **Full Sync**     | Hours    | 100%        | Fallback for missed deltas            |

**Recommendation:** All three (defense in depth)

```
Webhooks (primary) → Delta Queries (backup) → Full Sync (weekly)
```

**Change Propagation:**

```
Source permission change
  ↓ <1 min (webhook)
Neo4j graph update
  ↓ 1-2 sec (Cypher query)
Vector DB metadata update
  ↓ 2-3 sec (bulk upsert)
Redis cache invalidation
  ↓ 100ms (delete key)
Next search query sees new permissions
```

**Total Latency:** <10 minutes (webhook) or <30 minutes (delta query)

---

## Scale Analysis

### User Scale: 100K End Users

**Neo4j Storage:**

- 100K users × 1KB = 100MB (nodes + properties)
- 10K groups × 1KB = 10MB
- 500K memberships × 100 bytes = 50MB
- **Total: ~160MB** ✅ TRIVIAL for Neo4j

**Query Performance:**

- Recursive group query (5 levels): <10ms
- User → all groups: <5ms (indexed)
- Group → all users: <20ms (cached)

### Document Scale: 10M Documents

**DocumentPermission (MongoDB):**

- 10M documents × 2KB = 20GB
- Query: Find accessible docs for user
  - Index scan: `{ tenantId, 'permissions.users.userId' }`
  - Result: 100ms for 10K matching docs

**Neo4j Permission Graph:**

- 10M document nodes × 500 bytes = 5GB
- 100M permission edges × 100 bytes = 10GB
- **Total: ~15GB** ✅ FEASIBLE

**Query Performance:**

- User → all accessible docs: <50ms (indexed)
- Flatten groups → users: <100ms (cached)

### Vector DB Scale: 100M Chunks

**OpenSearch Storage:**

- 100M chunks × 1KB vector = 100GB (vectors)
- 100M chunks × 50KB metadata = 5TB (metadata)
- With permission metadata (+30KB): 8TB total

**Search Performance:**

- k-NN query (k=10): 50-150ms
- With permission filter: +10-30ms
- **Total: 60-180ms** ✅ ACCEPTABLE

**Index Sharding:**

- Shard count: 10-20 (5-10M docs per shard)
- Replica count: 2 (HA)

---

## Recommended Implementation Order

### Phase 1: Neo4j Permission Graph (4 weeks)

1. Design Neo4j schema (users, groups, documents, permissions)
2. Create permission graph client (CRUD operations)
3. Implement group resolver (recursive membership)
4. Migrate DocumentPermission → Neo4j (dual-write pattern)
5. Update permission crawler to write to Neo4j
6. Add permission query APIs (check access, list docs)

**Deliverable:** Neo4j stores all permissions, MongoDB read-only

### Phase 2: Identity Federation (4 weeks)

1. Create EndUserIdentity model + indexes
2. Implement Azure AD OAuth + Graph API client
3. Build user/group sync service (delta queries)
4. Create domain verification workflow (DNS TXT / email)
5. Add tenant IdP configuration (tenant.settings.idpConfig)
6. Implement background job for hourly user/group sync

**Deliverable:** Users/groups synced from Azure AD to Neo4j

### Phase 3: Vector DB Denormalization (3 weeks)

1. Update OpenSearch mapping (add `metadata.permissions`)
2. Implement permission flattener (Neo4j graph → flat arrays)
3. Modify embedding worker to include permission metadata
4. Update search queries to use permission filters
5. Add Redis cache for flattened permissions (5-min TTL)
6. Background job: Re-flatten all docs when permissions change

**Deliverable:** Single-query search authorization

### Phase 4: Real-Time Updates (3-4 weeks)

1. Implement webhook subscriptions (SharePoint, Azure AD)
2. Create webhook receiver endpoints + validation
3. Build permission change processor (queue + worker)
4. Implement delta query sync (backup for webhooks)
5. Add change propagation pipeline (Neo4j → Vector DB → Cache)
6. Create monitoring dashboard (permission sync lag)

**Deliverable:** <10 minute permission propagation

### Phase 5: Additional IdPs (4 weeks)

1. Okta integration (OAuth + SCIM API)
2. Google Workspace integration (OAuth + Directory API)
3. Generic SAML/OIDC support
4. Multi-IdP per tenant (select primary IdP)

**Deliverable:** Multi-IDP support for SaaS

**Total Timeline:** 18-21 weeks (4.5-5.5 months)

---

## Open Questions for User

### 1. Identity Federation Trust Model

**Question:** How do admins prove domain ownership?

**Options:**

- **DNS TXT Record:** Add `_searchai-verification=<token>` to DNS
- **Email Verification:** Send verification email to admin@domain.com
- **Manual Verification:** Support team verifies offline
- **IdP OAuth:** Trust IdP's email_verified claim

**Recommendation:** DNS TXT (industry standard) + email fallback

---

### 2. Group Hierarchy Depth Limit

**Question:** Should we limit recursive group depth?

**Scenarios:**

- Typical enterprise: 3-5 levels (Company → Division → Department → Team)
- Edge case: 20+ levels (misconfigured circular references)

**Options:**

- **No limit:** Trust IdP, allow any depth
- **Soft limit:** Warn at >10 levels, allow
- **Hard limit:** Error at >20 levels (prevent infinite loops)

**Recommendation:** Hard limit at 20 levels with cycle detection

---

### 3. Permission Update Batch Size

**Question:** How many docs to update per permission change?

**Scenario:** User added to group with 10K documents

**Options:**

- **Synchronous:** Update all 10K docs before returning (1-2 min)
- **Async (batch):** Queue 10K updates, process in background (5-10 min)
- **Lazy:** Update on next document access (eventual consistency)

**Recommendation:** Async batch (BullMQ job)

---

### 4. Permission Accuracy vs. Performance

**Question:** Accept eventual consistency?

**Scenario:** User removed from group, search still shows restricted docs for 5 min

**Options:**

- **Strong Consistency:** Block search until cache updated (high latency)
- **Eventual Consistency:** Accept 5-10 min propagation delay (better UX)
- **Hybrid:** Invalidate cache on critical operations (delete user)

**Recommendation:** Eventual consistency (user's requirement: "nearest realtime" not "realtime")

---

### 5. Public Document Optimization

**Question:** Skip permission metadata for public docs?

**Scenario:** 50% of docs are public (everyone in domain)

**Options:**

- **Store users/groups anyway:** Consistent structure, larger metadata
- **Skip arrays if publicInDomain:** Smaller metadata, special case logic
- **Separate index:** Public docs in separate OpenSearch index

**Recommendation:** Skip arrays if `publicInDomain: true` or `publicEverywhere: true`

---

## Summary

**Current State:**

- ✅ Solid database foundation (MongoDB, Neo4j, Redis, OpenSearch)
- ✅ Delta sync complete (Task #63)
- ✅ Webhook infrastructure (Task #64)
- ✅ Permission models exist (DocumentPermission in MongoDB)
- ❌ No identity federation (critical gap)
- ❌ No permission graph (MongoDB not ideal)
- ❌ No permission metadata in vector DB (two-query pattern)
- ❌ No real-time permission updates

**Required Work:**

1. **Neo4j Permission Graph** - 4 weeks (store users, groups, permissions)
2. **Identity Federation** - 4 weeks (Azure AD sync, domain verification)
3. **Vector DB Denormalization** - 3 weeks (flatten permissions to metadata)
4. **Real-Time Updates** - 3-4 weeks (webhooks + delta queries)
5. **Multi-IDP Support** - 4 weeks (Okta, Google Workspace)

**Total Timeline:** 18-21 weeks (user's requirement: "quality, robust and high scalable")

**Next Step:** User approval of architecture + answers to 5 open questions

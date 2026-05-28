# RFC-001: SearchAI Enterprise Permission & Authorization Architecture

**Status:** DRAFT
**Author:** Claude (AI Assistant)
**Created:** 2026-02-24
**Updated:** 2026-02-24
**Stakeholders:** Bharat Rekha (Product Owner), Engineering Team

---

## Table of Contents

1. [Executive Summary](#executive-summary)
2. [Problem Statement](#problem-statement)
3. [Goals & Non-Goals](#goals--non-goals)
4. [Architecture Overview](#architecture-overview)
5. [Detailed Design](#detailed-design)
6. [Data Models](#data-models)
7. [API Design](#api-design)
8. [Security & Privacy](#security--privacy)
9. [Performance & Scale](#performance--scale)
10. [Implementation Plan](#implementation-plan)
11. [Open Questions](#open-questions)
12. [References](#references)

---

## Executive Summary

This RFC proposes an enterprise-grade permission and authorization system for SearchAI that enables:

- **Identity Federation** via IDP (Azure AD, Okta, Google Workspace) - NO per-user OAuth
- **Neo4j Permission Graph** for nested group hierarchies (unlimited depth)
- **Vector DB Permission Metadata** for single-query authorization (no MongoDB pre-filter)
- **Near Real-Time Updates** (<10 minutes via webhooks + delta queries)
- **Multi-Connector Support** with unified user identity across systems

**Timeline:** 18-21 weeks (quality-first, enterprise-ready)

**Key Decision:** IDP-based authentication eliminates spoofing risks, making domain verification optional for security (only needed for tenant-connector attestation).

---

## Problem Statement

### Current State

SearchAI has:

- ✅ DocumentPermission model in MongoDB (stores permissions)
- ✅ Neo4j infrastructure (used for knowledge graph, NOT permissions)
- ✅ OpenSearch vector store with metadata filters
- ✅ ConnectorConfig with permission crawling stubs
- ❌ NO identity federation (only platform users, not end users)
- ❌ NO permission graph (flat user/group arrays in MongoDB)
- ❌ NO permission metadata in vectors (two-query authorization)
- ❌ NO real-time permission updates (only during content sync)

### Problems

1. **Identity Gap:** Platform users (admins) exist, end users (searchers) don't
   - EndUserOAuthToken requires per-user consent (doesn't scale to 100K users)
   - No trust model linking SearchAI identity to source system identity
   - User logged in as "bob@contoso.com" can't prove they're the SAME bob@contoso.com in SharePoint

2. **Permission Graph Limitation:** MongoDB is not a graph database
   - Can't efficiently resolve nested groups (Engineering → Backend → Python Team)
   - Flat arrays: `groups: [{ groupId: 'eng-team' }]` (not resolved to members)
   - Query "all users in group hierarchy" requires application-level recursion

3. **Search Performance:** Two-query authorization pattern

   ```typescript
   // Step 1: MongoDB query (50-200ms)
   const accessibleDocs = await DocumentPermission.find({...});

   // Step 2: OpenSearch query with doc filter (50-150ms)
   const results = await vectorStore.search({
     filters: [{ field: 'documentId', operator: 'in', value: accessibleDocs }]
   });

   // Total: 105-360ms
   ```

4. **Stale Permissions:** No change detection
   - Permissions only updated during content sync (full/delta)
   - User added to group → sees restricted docs after hours/days
   - User removed from group → still sees docs until next sync

### Impact

- **Enterprise Blocker:** Can't deploy without identity federation (100K user scale)
- **Security Risk:** Without IDP, spoofing attacks possible (user claims ceo@contoso.com)
- **UX Issue:** Slow search (105-360ms vs 60-180ms with single query)
- **Compliance Risk:** Stale permissions = data leakage (former employee still has access)

---

## Goals & Non-Goals

### Goals

1. **Identity Federation**
   - ✅ Authenticate end users via IDP (Azure AD, Okta, Google Workspace)
   - ✅ Sync users/groups from IDP to SearchAI (hourly delta queries)
   - ✅ Email as universal identity key across all systems
   - ✅ NO per-user OAuth consent (admin-level app consent only)

2. **Neo4j Permission Graph**
   - ✅ Store users, groups, documents, permissions in Neo4j
   - ✅ Support unlimited group nesting depth (with cycle detection)
   - ✅ Recursive group membership queries (<10ms)
   - ✅ Efficient "all accessible docs for user" queries (<50ms)

3. **Single-Query Authorization**
   - ✅ Denormalize permissions to OpenSearch metadata
   - ✅ Vector search with permission filters in single query
   - ✅ Target: 60-180ms total latency (vs 105-360ms current)

4. **Near Real-Time Updates**
   - ✅ Webhook subscriptions for permission changes (<1 min latency)
   - ✅ Delta queries as backup (5-15 min latency)
   - ✅ Full sync as fallback (weekly)
   - ✅ Change propagation: Source → Neo4j → Vector DB → Cache (<10 min total)

5. **Multi-IDP Support**
   - ✅ Azure AD (primary, SharePoint native)
   - ✅ Okta (enterprise standard)
   - ✅ Google Workspace (Google Drive)
   - ✅ Tenant selects primary IDP

6. **Scale Targets**
   - ✅ 100K end users per tenant
   - ✅ 10M documents per tenant
   - ✅ 100M vector chunks across all tenants
   - ✅ <100ms added latency for permission checks

### Non-Goals

1. ❌ **Fine-grained object permissions** (e.g., row-level, cell-level)
   - Scope: Document-level permissions only
   - Rationale: Matches source system granularity (SharePoint, Jira)

2. ❌ **Custom RBAC roles in SearchAI**
   - Scope: Use source system roles (SharePoint roles, Jira roles)
   - Rationale: Don't override source security model

3. ❌ **Real-time permission updates** (<1 second)
   - Scope: Near real-time (<10 minutes) is sufficient
   - Rationale: User expectation is "eventual consistency" for search

4. ❌ **Cross-tenant user federation**
   - Scope: Users belong to single tenant
   - Rationale: SaaS isolation model

5. ❌ **Permission auditing UI** (Phase 1)
   - Scope: APIs only in Phase 1, UI in Phase 2
   - Rationale: Focus on core functionality first

---

## Architecture Overview

### High-Level Components

```
┌─────────────────────────────────────────────────────────────────┐
│                         SearchAI Platform                        │
├─────────────────────────────────────────────────────────────────┤
│                                                                   │
│  ┌──────────────┐     ┌──────────────┐     ┌──────────────┐    │
│  │   Studio     │     │  Search API  │     │  Admin API   │    │
│  │  (UI/UX)     │────▶│ (End Users)  │────▶│  (Admins)    │    │
│  └──────────────┘     └──────────────┘     └──────────────┘    │
│         │                     │                     │            │
│         └─────────────────────┴─────────────────────┘            │
│                              │                                   │
│                    ┌─────────▼─────────┐                        │
│                    │  Auth Middleware  │                        │
│                    │  (JWT/IDP/API Key)│                        │
│                    └─────────┬─────────┘                        │
│                              │                                   │
│         ┌────────────────────┼────────────────────┐             │
│         │                    │                    │             │
│    ┌────▼─────┐      ┌──────▼──────┐     ┌──────▼──────┐      │
│    │ Identity │      │ Permission  │     │   Search    │      │
│    │ Service  │      │  Service    │     │  Service    │      │
│    └────┬─────┘      └──────┬──────┘     └──────┬──────┘      │
│         │                   │                    │             │
└─────────┼───────────────────┼────────────────────┼─────────────┘
          │                   │                    │
     ┌────▼─────┐        ┌────▼─────┐        ┌────▼─────┐
     │   IDP    │        │  Neo4j   │        │OpenSearch│
     │(Azure AD)│        │(Perm     │        │(Vectors  │
     │  Okta    │        │ Graph)   │        │+ Perm    │
     │  Google  │        │          │        │Metadata) │
     └────┬─────┘        └────┬─────┘        └──────────┘
          │                   │
     ┌────▼─────┐        ┌────▼─────┐
     │ MongoDB  │        │  Redis   │
     │(Identity │        │ (Cache)  │
     │  State)  │        │          │
     └──────────┘        └──────────┘

┌─────────────────────────────────────────────────────────────────┐
│                      External Systems                            │
├─────────────────────────────────────────────────────────────────┤
│  ┌──────────────┐     ┌──────────────┐     ┌──────────────┐    │
│  │  SharePoint  │     │     Jira     │     │   Webhook    │    │
│  │ (Connector)  │────▶│ (Connector)  │────▶│   Receiver   │    │
│  └──────────────┘     └──────────────┘     └──────────────┘    │
│         │                     │                     │            │
│         └─────────────────────┴─────────────────────┘            │
│                              │                                   │
│                    ┌─────────▼─────────┐                        │
│                    │ Permission Change │                        │
│                    │    Processor      │                        │
│                    │  (BullMQ Worker)  │                        │
│                    └───────────────────┘                        │
└─────────────────────────────────────────────────────────────────┘
```

### Data Flow

#### 1. User Sync Flow (Hourly)

```
Azure AD/Okta/Google
  ↓ Delta Query API
Identity Sync Worker (BullMQ)
  ↓ Create/Update
MongoDB (EndUserIdentity model)
  ↓ Create nodes
Neo4j (User, Group nodes)
  ↓
Redis (Cache: user → groups)
```

#### 2. Permission Crawl Flow (During Content Sync)

```
SharePoint Document
  ↓ getItemPermissions() API
Permission Crawler
  ↓ Parse permissions
Neo4j (Document, User, Group nodes + HAS_PERMISSION edges)
  ↓ Flatten graph
Permission Flattener (Redis cached)
  ↓ Denormalize
OpenSearch Metadata (allowedUsers, allowedGroups, allowedDomains)
```

#### 3. Search Authorization Flow (Query Time)

```
User Search Query
  ↓ Authenticate
Auth Middleware → req.tenantContext { userId, tenantId, email, groupIds }
  ↓ Generate embedding
Embedding Provider
  ↓ Single query with filters
OpenSearch k-NN Search
  Query: {
    knn: { vector: [...], k: 10 },
    filter: {
      OR: [
        { allowedUsers: user.email },
        { allowedGroups IN user.groupIds },
        { allowedDomains: user.domain AND publicInDomain: true },
        { publicEverywhere: true }
      ]
    }
  }
  ↓ Return results (60-180ms)
Search Results
```

#### 4. Permission Update Flow (Real-Time)

```
SharePoint Permission Change
  ↓ Webhook (< 1 min)
Webhook Receiver
  ↓ Queue job
BullMQ Worker: Permission Update
  ↓ Fetch new permissions
SharePoint API
  ↓ Update graph
Neo4j (update HAS_PERMISSION edges)
  ↓ Flatten
Permission Flattener
  ↓ Bulk update
OpenSearch (update metadata for all document chunks)
  ↓ Invalidate
Redis (delete cached permissions)
  ↓
Next search sees updated permissions (< 10 min total)
```

---

## Detailed Design

### 1. Identity Federation

#### 1.1 IDP Integration

**Supported IDPs:**

- Azure AD (Microsoft Graph API)
- Okta (SCIM API + Event Hooks)
- Google Workspace (Directory API)

**Authentication Flow:**

```typescript
// Admin configures IDP (one-time setup per tenant)
POST /api/admin/tenants/:tenantId/idp-config
{
  provider: 'azuread',
  clientId: 'azure-app-id',
  clientSecret: 'encrypted-secret',
  tenantId: 'azure-tenant-id',
  scopes: ['User.Read.All', 'Group.Read.All'],
  syncSchedule: '0 * * * *'  // Every hour
}

// End user login (every search session)
GET /api/auth/login/azuread
  ↓ Redirect to Azure AD OAuth
  ↓ User authorizes (if first time)
  ↓ Azure returns: { email, name, email_verified }
  ↓ SearchAI creates session

// Session JWT
{
  userId: 'user-uuid',
  email: 'bob@contoso.com',
  tenantId: 'tenant-1',
  groupIds: ['group-1', 'group-2'],  // From Neo4j
  domain: 'contoso.com'
}
```

**Key Decision:** IDP authentication ELIMINATES spoofing risk

- ✅ User can't fake "ceo@contoso.com" (must pass Azure AD login)
- ✅ IDP already verified email ownership
- ✅ Groups synced from IDP (trusted source)

**Domain Verification is OPTIONAL** (only for tenant-connector attestation):

- Purpose: Prove "My Azure AD tenant = My SharePoint tenant"
- Not for security (IDP already handles authentication)

#### 1.2 User/Group Sync

**Sync Strategy:**

| Sync Type        | Frequency    | API                | Latency       |
| ---------------- | ------------ | ------------------ | ------------- |
| **Initial Sync** | Once (setup) | Full list API      | Minutes-hours |
| **Delta Sync**   | Hourly       | Delta query API    | <5 min        |
| **Webhook**      | Real-time    | Event subscription | <1 min        |

**Azure AD Delta Query:**

```typescript
// GET https://graph.microsoft.com/v1.0/users/delta
// Returns: Added, updated, deleted users since last sync

{
  "@odata.deltaLink": "https://...?$deltatoken=abc123",
  "value": [
    {
      "@odata.type": "#microsoft.graph.user",
      "id": "user-guid",
      "mail": "alice@contoso.com",
      "displayName": "Alice Smith",
      "@removed": undefined  // User exists
    },
    {
      "@odata.type": "#microsoft.graph.user",
      "id": "user-guid-2",
      "@removed": { "reason": "deleted" }  // User deleted
    }
  ]
}
```

**Sync Worker:**

```typescript
async function syncUsersFromAzureAD(tenantId: string) {
  const config = await getIDPConfig(tenantId);
  const lastDeltaLink = await redis.get(`idp:delta:${tenantId}`);

  // Fetch delta
  const delta = await graphClient.getUsersDelta(lastDeltaLink);

  for (const user of delta.value) {
    if (user['@removed']) {
      // User deleted in Azure AD
      await EndUserIdentity.updateOne(
        { tenantId, idpUserId: user.id },
        { $set: { status: 'deleted', deletedAt: new Date() } },
      );
      await neo4j.run(
        `
        MATCH (u:User {tenantId: $tenantId, idpUserId: $idpUserId})
        SET u.status = 'deleted', u.deletedAt = datetime()
      `,
        { tenantId, idpUserId: user.id },
      );
    } else {
      // User added/updated
      await EndUserIdentity.updateOne(
        { tenantId, email: user.mail },
        {
          $set: {
            idpUserId: user.id,
            displayName: user.displayName,
            idpProvider: 'azuread',
            lastSyncAt: new Date(),
            status: 'active',
          },
        },
        { upsert: true },
      );

      await neo4j.run(
        `
        MERGE (u:User {tenantId: $tenantId, email: $email})
        SET u.idpUserId = $idpUserId,
            u.displayName = $displayName,
            u.lastSyncAt = datetime()
      `,
        { tenantId, email: user.mail, idpUserId: user.id, displayName: user.displayName },
      );
    }
  }

  // Save delta link for next sync
  await redis.set(`idp:delta:${tenantId}`, delta['@odata.deltaLink']);
}
```

**Group Sync:**

```typescript
async function syncGroupsFromAzureAD(tenantId: string) {
  // Similar to user sync
  const delta = await graphClient.getGroupsDelta(lastDeltaLink);

  for (const group of delta.value) {
    // Sync group node
    await neo4j.run(
      `
      MERGE (g:Group {tenantId: $tenantId, idpGroupId: $idpGroupId})
      SET g.displayName = $displayName,
          g.email = $email,
          g.lastSyncAt = datetime()
    `,
      { tenantId, idpGroupId: group.id, displayName: group.displayName, email: group.mail },
    );

    // Sync members
    const members = await graphClient.getGroupMembers(group.id);
    for (const member of members) {
      await neo4j.run(
        `
        MATCH (u:User {tenantId: $tenantId, idpUserId: $memberId})
        MATCH (g:Group {tenantId: $tenantId, idpGroupId: $groupId})
        MERGE (u)-[:MEMBER_OF]->(g)
      `,
        { tenantId, memberId: member.id, groupId: group.id },
      );
    }
  }
}
```

#### 1.3 Unified Identity Across Connectors

**Decision:** Email as universal identity key

**Scenario:** Tenant has SharePoint + Jira connectors

```
User: alice@contoso.com

Neo4j Graph:
  (alice:User {email: 'alice@contoso.com'})
    -[:MEMBER_OF]-> (sales:Group {source: 'azuread'})
    -[:MEMBER_OF]-> (devs:Group {source: 'jira'})
    -[:HAS_PERMISSION]-> (doc1:Document {source: 'sharepoint'})
    -[:HAS_PERMISSION]-> (ticket1:Document {source: 'jira'})
```

**Search Query:**

```typescript
// User searches, sees results from BOTH connectors
const results = await vectorStore.search({
  vector: queryEmbedding,
  filters: [
    { field: 'permissions.allowedUsers', operator: 'eq', value: 'alice@contoso.com' },
    // Matches docs from SharePoint AND Jira
  ],
});
```

**Key Decision Rationale:**

- ✅ **Unified UX:** Single search, sees all results (across connectors)
- ✅ **Consistent identity:** alice@contoso.com is SAME person everywhere
- ✅ **Simpler permission model:** One user node, multiple group memberships
- ✅ **Industry standard:** Email as universal key (OAuth, SAML, OIDC all use email)

**Edge Case Handling:**

| Scenario                                                         | Resolution                                 |
| ---------------------------------------------------------------- | ------------------------------------------ |
| Email exists in Connector A but not IDP                          | Ignore (orphaned account)                  |
| Email exists in IDP but not Connector                            | Sync to Neo4j (ready for future connector) |
| Email case mismatch (`Alice@Contoso.com` vs `alice@contoso.com`) | Normalize to lowercase                     |
| Multiple emails for one person                                   | Admin maps aliases in IDP                  |

---

### 2. Neo4j Permission Graph

#### 2.1 Schema Design

**Node Labels:**

```cypher
// User nodes (from IDP)
(:User {
  tenantId: String!,
  email: String!,           // Primary key (lowercase)
  idpUserId: String,        // Azure AD object ID
  idpProvider: String,      // 'azuread', 'okta', 'google'
  displayName: String,
  domain: String,           // Extracted from email
  status: String,           // 'active', 'suspended', 'deleted'
  lastSyncAt: DateTime,
  createdAt: DateTime
})

// Group nodes (from IDP + connectors)
(:Group {
  tenantId: String!,
  groupId: String!,         // Composite: {source}:{id}
  idpGroupId: String,       // Azure AD group ID (if from IDP)
  source: String,           // 'azuread', 'sharepoint', 'jira'
  displayName: String,
  email: String?,
  lastSyncAt: DateTime,
  createdAt: DateTime
})

// Document nodes (from connectors)
(:Document {
  tenantId: String!,
  documentId: String!,      // SearchDocument._id (MongoDB)
  sourceId: String!,        // Connector ID
  source: String,           // 'sharepoint', 'jira', 'confluence'
  name: String,
  path: String,
  publicInDomain: Boolean,
  publicEverywhere: Boolean,
  lastPermissionCrawlAt: DateTime,
  createdAt: DateTime
})

// Domain nodes (for domain-level permissions)
(:Domain {
  tenantId: String!,
  domain: String!,          // 'contoso.com'
  verified: Boolean,
  verificationMethod: String,  // 'dns', 'email', 'manual'
  verifiedAt: DateTime,
  createdAt: DateTime
})
```

**Relationship Types:**

```cypher
// User belongs to groups
(:User)-[:MEMBER_OF]->(:Group)

// Group nested in parent group (unlimited depth)
(:Group)-[:MEMBER_OF]->(:Group)

// User has direct permission to document
(:User)-[:HAS_PERMISSION {
  role: String,              // 'read', 'write', 'owner'
  source: String,            // 'sharepoint', 'jira'
  grantedAt: DateTime
}]->(:Document)

// Group has permission to document
(:Group)-[:HAS_PERMISSION {
  role: String,
  source: String,
  grantedAt: DateTime
}]->(:Document)

// Document is public in domain
(:Document)-[:PUBLIC_IN]->(:Domain)
```

**Indexes & Constraints:**

```cypher
// Unique constraints
CREATE CONSTRAINT user_unique ON (u:User) ASSERT (u.tenantId, u.email) IS UNIQUE;
CREATE CONSTRAINT group_unique ON (g:Group) ASSERT (g.tenantId, g.groupId) IS UNIQUE;
CREATE CONSTRAINT document_unique ON (d:Document) ASSERT (d.tenantId, d.documentId) IS UNIQUE;
CREATE CONSTRAINT domain_unique ON (d:Domain) ASSERT (d.tenantId, d.domain) IS UNIQUE;

// Indexes for fast lookups
CREATE INDEX user_idp ON :User(tenantId, idpUserId);
CREATE INDEX user_domain ON :User(tenantId, domain);
CREATE INDEX group_source ON :Group(tenantId, source);
CREATE INDEX document_source ON :Document(tenantId, sourceId);
```

#### 2.2 Query Patterns

**Query 1: Get all groups for user (with recursive parent groups)**

```cypher
// Up to 20 levels deep (hard limit with cycle detection)
MATCH (u:User {tenantId: $tenantId, email: $email})
       -[:MEMBER_OF*1..20]->(g:Group)
WHERE NOT (g)-[:MEMBER_OF*]->(u)  // Cycle detection
RETURN DISTINCT g.groupId
```

**Query 2: Get all accessible documents for user**

```cypher
MATCH (u:User {tenantId: $tenantId, email: $email})

// Option 1: Direct user permission
OPTIONAL MATCH (u)-[:HAS_PERMISSION]->(doc:Document)

// Option 2: Group permission (recursive)
OPTIONAL MATCH (u)-[:MEMBER_OF*1..20]->(g:Group)
                  -[:HAS_PERMISSION]->(doc:Document)

// Option 3: Public in domain
OPTIONAL MATCH (doc:Document {tenantId: $tenantId, publicInDomain: true})
                  -[:PUBLIC_IN]->(d:Domain)
WHERE u.domain = d.domain

// Option 4: Public everywhere
OPTIONAL MATCH (doc:Document {tenantId: $tenantId, publicEverywhere: true})

RETURN DISTINCT doc.documentId
LIMIT 10000
```

**Performance:** <50ms for 10M documents with proper indexes

**Query 3: Get flattened permissions for document**

```cypher
MATCH (doc:Document {tenantId: $tenantId, documentId: $documentId})

// Direct users
OPTIONAL MATCH (u:User)-[:HAS_PERMISSION]->(doc)
WITH doc, COLLECT(DISTINCT u.email) AS allowedUsers

// Groups (recursive members flattened)
OPTIONAL MATCH (g:Group)-[:HAS_PERMISSION]->(doc)
WITH doc, allowedUsers, COLLECT(DISTINCT g.groupId) AS allowedGroups

// Domains (if public in domain)
OPTIONAL MATCH (doc)-[:PUBLIC_IN]->(d:Domain)
WITH doc, allowedUsers, allowedGroups, COLLECT(DISTINCT d.domain) AS allowedDomains

RETURN {
  allowedUsers: allowedUsers,
  allowedGroups: allowedGroups,
  allowedDomains: allowedDomains,
  publicInDomain: doc.publicInDomain,
  publicEverywhere: doc.publicEverywhere
}
```

**Used by:** Permission flattener (for vector DB denormalization)

#### 2.3 Group Hierarchy with Cycle Detection

**Hard Limit:** 20 levels (configurable)

**Cycle Detection Strategy:**

```typescript
async function resolveGroupMembers(
  groupId: string,
  visited: Set<string> = new Set(),
  depth: number = 0,
): Promise<string[]> {
  // Hard limit
  if (depth > 20) {
    throw new Error(`Group hierarchy exceeds limit (20 levels): ${groupId}`);
  }

  // Cycle detection
  if (visited.has(groupId)) {
    console.warn(`Circular group reference detected: ${groupId}`);
    return [];
  }

  visited.add(groupId);

  // Fetch direct members (users + child groups)
  const result = await neo4j.run(
    `
    MATCH (g:Group {tenantId: $tenantId, groupId: $groupId})
    OPTIONAL MATCH (u:User)-[:MEMBER_OF]->(g)
    OPTIONAL MATCH (child:Group)-[:MEMBER_OF]->(g)
    RETURN COLLECT(DISTINCT u.email) AS users,
           COLLECT(DISTINCT child.groupId) AS childGroups
  `,
    { tenantId, groupId },
  );

  const users = result.records[0].get('users');
  const childGroups = result.records[0].get('childGroups');

  // Recursively resolve child groups
  let allUsers = [...users];
  for (const childGroupId of childGroups) {
    const childUsers = await resolveGroupMembers(childGroupId, visited, depth + 1);
    allUsers.push(...childUsers);
  }

  return [...new Set(allUsers)]; // Deduplicate
}
```

**Rationale for 20-level limit:**

- Typical enterprise: 3-5 levels (Company → Division → Department → Team)
- Microsoft Azure AD: No documented limit (but warns about performance >10 levels)
- Prevents infinite loops from misconfigured circular references
- Configurable via environment variable if needed

---

### 3. Vector DB Permission Metadata

#### 3.1 OpenSearch Mapping Extension

**Add `permissions` namespace to metadata:**

```typescript
// Current mapping (from opensearch-mappings.ts)
{
  metadata: {
    sys: { tenantId, appId, connectorId, documentId, chunkId },
    doc: { name, contentType, contentHash, language },
    canonical: { /* user-defined fields */ }
  }
}

// NEW mapping (with permissions)
{
  metadata: {
    sys: { ... },
    doc: { ... },
    canonical: { ... },
    permissions: {
      allowedUsers: string[],        // Up to 500 users
      allowedGroups: string[],       // Up to 100 groups
      allowedDomains: string[],      // e.g., ['contoso.com', 'fabrikam.com']
      publicInDomain: boolean,       // True = everyone in allowedDomains
      publicEverywhere: boolean      // True = anonymous access
    }
  }
}
```

**OpenSearch Field Types:**

```json
{
  "mappings": {
    "properties": {
      "metadata": {
        "properties": {
          "permissions": {
            "properties": {
              "allowedUsers": {
                "type": "keyword",
                "index": true
              },
              "allowedGroups": {
                "type": "keyword",
                "index": true
              },
              "allowedDomains": {
                "type": "keyword",
                "index": true
              },
              "publicInDomain": {
                "type": "boolean",
                "index": true
              },
              "publicEverywhere": {
                "type": "boolean",
                "index": true
              }
            }
          }
        }
      }
    }
  }
}
```

#### 3.2 Permission Flattener

**Purpose:** Convert Neo4j graph to flat arrays for OpenSearch

```typescript
class PermissionFlattener {
  async flattenDocument(tenantId: string, documentId: string): Promise<FlatPermissions> {
    // Check cache first (5-minute TTL)
    const cached = await redis.get(`perm:flat:${tenantId}:${documentId}`);
    if (cached) return JSON.parse(cached);

    // Query Neo4j for flattened permissions
    const result = await neo4j.run(
      `
      MATCH (doc:Document {tenantId: $tenantId, documentId: $documentId})

      // Direct users
      OPTIONAL MATCH (u:User)-[:HAS_PERMISSION]->(doc)
      WITH doc, COLLECT(DISTINCT u.email) AS allowedUsers

      // Groups (store group IDs, NOT resolved members)
      OPTIONAL MATCH (g:Group)-[:HAS_PERMISSION]->(doc)
      WITH doc, allowedUsers, COLLECT(DISTINCT g.groupId) AS allowedGroups

      // Domains (if public in domain)
      OPTIONAL MATCH (doc)-[:PUBLIC_IN]->(d:Domain)
      WITH doc, allowedUsers, allowedGroups, COLLECT(DISTINCT d.domain) AS allowedDomains

      RETURN {
        allowedUsers: CASE
          WHEN doc.publicInDomain OR doc.publicEverywhere THEN []
          ELSE allowedUsers[..500]  // Limit to 500 users
        END,
        allowedGroups: CASE
          WHEN doc.publicInDomain OR doc.publicEverywhere THEN []
          ELSE allowedGroups[..100]  // Limit to 100 groups
        END,
        allowedDomains: allowedDomains,
        publicInDomain: COALESCE(doc.publicInDomain, false),
        publicEverywhere: COALESCE(doc.publicEverywhere, false)
      } AS permissions
    `,
      { tenantId, documentId },
    );

    const permissions = result.records[0].get('permissions');

    // Cache for 5 minutes
    await redis.setex(
      `perm:flat:${tenantId}:${documentId}`,
      300, // 5 minutes
      JSON.stringify(permissions),
    );

    return permissions;
  }
}
```

**Key Decision:** Store **group IDs**, not resolved members

- **Rationale:** User's groups are known at query time (in session JWT)
- **Benefit:** Smaller metadata (100 group IDs vs 10,000 user emails)
- **Trade-off:** Must resolve user → groups before search (but cached)

#### 3.3 Embedding Worker Integration

**Modify `embedding-worker.ts` to include permissions:**

```typescript
async function processEmbeddingJob(job: Job<EmbeddingJobData>): Promise<void> {
  const { documentId, chunkIds, tenantId, indexId } = job.data;

  // Load document
  const document = await SearchDocument.findOne({ _id: documentId, indexId });

  // Load chunks
  const chunks = await SearchChunk.find({ _id: { $in: chunkIds }, indexId });

  // **NEW: Flatten permissions for this document**
  const permissions = await permissionFlattener.flattenDocument(tenantId, documentId);

  // Generate embeddings
  const embeddings = await embeddingProvider.embedBatch(chunks.map(c => c.content));

  // Build vector records WITH permissions
  const vectorRecords: VectorRecord[] = chunks.map((chunk, idx) => ({
    id: chunk._id,
    vector: embeddings[idx],
    metadata: {
      sys: { tenantId, appId: indexId, connectorId: document.sourceId, documentId, chunkId: chunk._id },
      doc: { name: document.originalReference, contentType: document.contentType, ... },
      canonical: chunk.canonicalMetadata ?? {},
      permissions  // **NEW: Add flattened permissions**
    },
    content: chunk.content
  }));

  // Upsert to OpenSearch (existing code)
  await vectorStore.upsert(vectorIndexName, vectorRecords);
}
```

#### 3.4 Search Query with Permission Filter

**Modify search queries to include permission checks:**

```typescript
async function search(
  tenantId: string,
  userId: string,
  query: string,
  options: SearchOptions,
): Promise<SearchResult[]> {
  // Authenticate user
  const user = await EndUserIdentity.findOne({ tenantId, userId });
  if (!user) throw new Error('User not found');

  // Get user's groups (from Neo4j, cached in Redis)
  const groupIds = await getUserGroups(tenantId, user.email);

  // Generate query embedding
  const queryEmbedding = await embeddingProvider.embed(query);

  // **Build permission filter**
  const permissionFilter = {
    bool: {
      should: [
        // Option 1: User has direct permission
        { term: { 'metadata.permissions.allowedUsers': user.email } },

        // Option 2: User's group has permission
        { terms: { 'metadata.permissions.allowedGroups': groupIds } },

        // Option 3: Public in user's domain
        {
          bool: {
            must: [
              { term: { 'metadata.permissions.publicInDomain': true } },
              { term: { 'metadata.permissions.allowedDomains': user.domain } },
            ],
          },
        },

        // Option 4: Public everywhere
        { term: { 'metadata.permissions.publicEverywhere': true } },
      ],
      minimum_should_match: 1,
    },
  };

  // **Execute single query with k-NN + permission filter**
  const results = await vectorStore.search(vectorIndexName, {
    vector: queryEmbedding,
    topK: options.topK || 10,
    filters: [
      { field: 'metadata.sys.tenantId', operator: 'eq', value: tenantId },
      // Add custom permission filter (OpenSearch-specific)
      { customFilter: permissionFilter },
    ],
    scoreThreshold: options.similarityThreshold || 0.7,
  });

  return results;
}
```

**Performance:**

- Single query: 60-180ms (vs 105-360ms two-query pattern)
- **40-50% faster!**

---

### 4. Real-Time Permission Updates

#### 4.1 Webhook Subscriptions

**SharePoint Webhook:**

```typescript
// Subscribe during connector setup
async function subscribeToSharePointChanges(connectorId: string, driveId: string) {
  const notificationUrl = `${config.webhookBaseUrl}/api/webhooks/sharepoint/${connectorId}`;
  const clientState = crypto.randomBytes(16).toString('hex');

  const subscription = await graphClient.subscribeToDriveChanges(
    driveId,
    notificationUrl,
    clientState,
  );

  // Store subscription in DB
  await WebhookSubscriptionConnector.create({
    tenantId,
    connectorId,
    driveId,
    subscriptionId: subscription.id,
    notificationUrl,
    clientState: encrypt(clientState), // Encrypted at rest
    expiresAt: subscription.expirationDateTime,
    status: 'active',
  });
}
```

**Webhook Receiver:**

```typescript
// POST /api/webhooks/sharepoint/:connectorId
router.post('/webhooks/sharepoint/:connectorId', async (req, res) => {
  const { connectorId } = req.params;
  const notifications = req.body.value;

  // Validate clientState (security check)
  const subscription = await WebhookSubscriptionConnector.findOne({
    connectorId,
    clientState: req.body.clientState,
  });
  if (!subscription) {
    return res.status(401).send('Invalid clientState');
  }

  // Queue permission update jobs (batched)
  for (const notification of notifications) {
    await permissionQueue.add(
      'process-permission-change',
      {
        connectorId,
        driveId: notification.driveId,
        itemId: notification.itemId,
        changeType: notification.changeType,
      },
      {
        jobId: `perm:${connectorId}:${notification.itemId}`, // Deduplicate
        delay: 30000, // 30-second batch window
      },
    );
  }

  // Return 202 Accepted (< 30s response required by SharePoint)
  res.status(202).send('Accepted');
});
```

#### 4.2 Permission Change Processor

```typescript
async function processPermissionChange(job: Job) {
  const { connectorId, driveId, itemId, changeType } = job.data;

  // 1. Fetch new permissions from source
  const permissions = await graphClient.getItemPermissions(driveId, itemId);

  // 2. Parse and normalize
  const normalized = parseSharePointPermissions(permissions);

  // 3. Update Neo4j graph
  await updatePermissionGraph(connectorId, itemId, normalized);

  // 4. Find all chunks for this document
  const document = await SearchDocument.findOne({
    'sourceMetadata.sharepoint.itemId': itemId,
    sourceId: connectorId,
  });

  if (!document) {
    console.warn(`Document not found for itemId ${itemId}, skipping permission update`);
    return;
  }

  const chunks = await SearchChunk.find(
    {
      documentId: document._id,
      tenantId: document.tenantId,
    },
    { vectorId: 1 },
  ).lean();

  // 5. Flatten permissions
  const flatPerms = await permissionFlattener.flattenDocument(document.tenantId, document._id);

  // 6. Bulk update OpenSearch (100 chunks per API call)
  const batchSize = 100;
  for (let i = 0; i < chunks.length; i += batchSize) {
    const batch = chunks.slice(i, i + batchSize);

    await vectorStore.bulkUpdateMetadata(
      vectorIndexName,
      batch.map((chunk) => ({
        id: chunk.vectorId,
        metadata: {
          permissions: flatPerms,
        },
      })),
    );
  }

  // 7. Invalidate cache
  await redis.del(`perm:flat:${document.tenantId}:${document._id}`);

  console.log(`Updated permissions for document ${document._id} (${chunks.length} chunks)`);
}
```

**Batching Logic:**

```
10:00:00.000 - Webhook: file001 permission changed → Queue job (delay: 30s)
10:00:00.050 - Webhook: file002 permission changed → Queue job (delay: 30s)
10:00:00.100 - Webhook: file003 permission changed → Queue job (delay: 30s)
...
10:00:05.000 - Last webhook received

10:00:30.000 - First job executes (30s delay expired)
10:00:30.050 - Second job executes
10:00:30.100 - Third job executes
...
10:00:35.000 - All jobs processed
```

**Result:** Batch window collects related changes, reduces API calls

#### 4.3 Delta Query Backup

**Runs hourly as fallback (catches missed webhooks):**

```typescript
// Scheduled job: every hour
async function syncPermissionDeltas(connectorId: string) {
  const lastSyncAt = await redis.get(`perm:lastSync:${connectorId}`);

  // Fetch delta from SharePoint
  const delta = await graphClient.getPermissionDeltas(lastSyncAt);

  for (const change of delta.changes) {
    // Queue permission update (same processor as webhooks)
    await permissionQueue.add('process-permission-change', {
      connectorId,
      driveId: change.driveId,
      itemId: change.itemId,
      changeType: 'updated',
    });
  }

  // Save last sync timestamp
  await redis.set(`perm:lastSync:${connectorId}`, new Date().toISOString());
}
```

**Rationale:**

- Webhooks can be missed (network issues, subscription expiry)
- Delta queries ensure 100% reliability
- Deduplication via jobId prevents double-processing

---

## Data Models

### MongoDB Models

#### EndUserIdentity (NEW)

```typescript
interface IEndUserIdentity {
  _id: string;
  tenantId: string;
  email: string; // Normalized (lowercase)
  displayName: string;
  idpUserId: string; // Azure AD object ID, Okta ID, etc.
  idpProvider: 'azuread' | 'okta' | 'google';
  domain: string; // Extracted from email
  groupIds: string[]; // Neo4j group IDs (cached, synced hourly)
  lastSyncAt: Date;
  status: 'active' | 'suspended' | 'deleted';
  createdAt: Date;
  updatedAt: Date;
}

// Indexes
{
  (tenantId, email);
}
-unique;
{
  (tenantId, idpUserId);
}
-unique;
{
  (tenantId, domain);
}
{
  (tenantId, status);
}
```

#### TenantIDPConfig (NEW)

```typescript
interface ITenantIDPConfig {
  _id: string;
  tenantId: string;
  provider: 'azuread' | 'okta' | 'google';
  clientId: string;
  encryptedClientSecret: string; // Field-level encrypted
  tenantId: string; // Azure AD tenant ID
  scopes: string[];
  syncSchedule: string; // Cron expression
  lastSyncAt: Date | null;
  deltaLink: string | null; // For delta queries
  status: 'active' | 'paused' | 'error';
  errorState: {
    lastErrorAt: Date | null;
    lastErrorMessage: string | null;
    consecutiveFailures: number;
  };
  createdAt: Date;
  updatedAt: Date;
}

// Indexes
{
  tenantId;
}
-unique;
```

#### ConnectorConfig (MODIFY)

```typescript
// Add permission sync tracking
interface IConnectorConfig {
  // ... existing fields ...

  permissionConfig: {
    mode: 'full' | 'simplified' | 'disabled';
    crawlSchedule: string | null;
    lastCrawlAt: Date | null;
    lastPermissionChangeAt: Date | null; // NEW: Last webhook/delta update
    permissionDeltaLink: string | null; // NEW: Delta query cursor
  };
}
```

### Neo4j Schema

**See Section 2.1 for complete schema**

Key nodes:

- `:User` - End users from IDP
- `:Group` - Groups from IDP + connectors
- `:Document` - Documents from connectors
- `:Domain` - Verified domains

Key relationships:

- `(:User)-[:MEMBER_OF]->(:Group)` - User group membership
- `(:Group)-[:MEMBER_OF]->(:Group)` - Nested groups
- `(:User|Group)-[:HAS_PERMISSION]->(:Document)` - Permissions
- `(:Document)-[:PUBLIC_IN]->(:Domain)` - Public documents

### OpenSearch Metadata Extension

```typescript
// Vector record metadata
{
  sys: {
    tenantId: string,
    appId: string,
    connectorId: string,
    documentId: string,
    chunkId: string
  },
  doc: {
    name: string,
    contentType: string,
    // ... existing fields
  },
  canonical: {
    // User-defined fields
  },
  permissions: {  // NEW
    allowedUsers: string[],      // Up to 500
    allowedGroups: string[],     // Up to 100
    allowedDomains: string[],
    publicInDomain: boolean,
    publicEverywhere: boolean
  }
}
```

---

## API Design

### Identity APIs

```typescript
// Admin: Configure IDP
POST /api/admin/tenants/:tenantId/idp-config
{
  provider: 'azuread',
  clientId: string,
  clientSecret: string,
  tenantId: string,
  scopes: string[],
  syncSchedule: string
}

// Admin: Trigger manual sync
POST /api/admin/tenants/:tenantId/idp/sync
{}

// Admin: List end users
GET /api/admin/tenants/:tenantId/end-users
Query: { status, domain, search, page, limit }

// Admin: Get end user
GET /api/admin/tenants/:tenantId/end-users/:userId
Returns: { user, groups, permissions }
```

### Permission APIs

```typescript
// Admin: Get document permissions
GET /api/admin/documents/:documentId/permissions
Returns: {
  document: { id, name, source },
  permissions: {
    users: [{ email, displayName, role }],
    groups: [{ groupId, displayName, role }],
    domains: string[],
    publicInDomain: boolean,
    publicEverywhere: boolean
  }
}

// Admin: Manually trigger permission crawl
POST /api/admin/connectors/:connectorId/permissions/crawl
{}

// Admin: Get permission sync status
GET /api/admin/connectors/:connectorId/permissions/status
Returns: {
  lastCrawlAt: Date,
  lastChangeAt: Date,
  webhookStatus: 'active' | 'expired',
  pendingJobs: number
}
```

### Search APIs (MODIFY)

```typescript
// End user search (with permission filtering)
POST /api/search
Headers: { Authorization: Bearer <jwt> }
Body: {
  query: string,
  indexId: string,
  topK: number,
  filters?: MetadataFilter[]
}
Returns: {
  results: SearchResult[],
  totalResults: number,
  searchTimeMs: number
}

// JWT payload includes:
{
  userId: string,
  email: string,
  tenantId: string,
  groupIds: string[],  // Cached from Neo4j
  domain: string
}
```

---

## Security & Privacy

### Authentication

1. **Platform Users** (admins, developers)
   - Current JWT-based auth (unchanged)
   - Permissions: Tenant-level RBAC

2. **End Users** (searchers) - NEW
   - IDP-based authentication (Azure AD, Okta, Google)
   - Session JWT includes: `userId, email, tenantId, groupIds, domain`
   - NO per-user OAuth (admin-level app consent only)

### Authorization

**Three-tier model:**

1. **Tenant-level** (existing)
   - All data scoped by `tenantId`
   - Enforced at database query level (tenantIsolationPlugin)

2. **Connector-level** (NEW)
   - User must belong to tenant that owns connector
   - Verified during IDP sync (user synced to correct tenant)

3. **Document-level** (NEW)
   - User must have permission to document (via Neo4j graph + vector metadata)
   - Enforced at search query level (permission filter in OpenSearch)

### Data Encryption

1. **At Rest**
   - MongoDB: Field-level encryption (clientSecret, accessToken)
   - Neo4j: Encryption at rest (OS-level, not Neo4j feature)
   - OpenSearch: Encryption at rest (OS-level)
   - Redis: Encryption at rest (Redis Enterprise feature)

2. **In Transit**
   - All services communicate over TLS
   - Webhook endpoints require HTTPS
   - IDP communication over HTTPS (OAuth 2.0)

### Compliance

1. **GDPR**
   - User deletion: Cascade to Neo4j, OpenSearch metadata, Redis cache
   - Right to access: API to retrieve all user's accessible documents
   - Data minimization: Only store email + displayName (no PII)

2. **SOC 2**
   - Audit trail: All permission changes logged
   - Access logging: Search queries logged with user identity
   - Monitoring: Permission sync failures alerted

### Secrets Management

- IDP client secrets: Field-level encrypted in MongoDB
- Webhook clientState: Field-level encrypted
- Neo4j password: Environment variable (Kubernetes secret)
- OpenSearch credentials: Environment variable (Kubernetes secret)

---

## Performance & Scale

### Target Metrics

| Metric               | Target       | Measurement                   |
| -------------------- | ------------ | ----------------------------- |
| **Search Latency**   | <180ms (p95) | Including permission check    |
| **Permission Sync**  | <10 min      | Webhook → OpenSearch update   |
| **User Sync**        | <5 min       | IDP delta → Neo4j             |
| **Group Resolution** | <10ms        | Recursive query in Neo4j      |
| **Cache Hit Rate**   | >95%         | Flattened permissions (Redis) |

### Scale Targets

| Resource                | Target          | Notes                       |
| ----------------------- | --------------- | --------------------------- |
| **End Users**           | 100K per tenant | Neo4j: ~160MB, 10ms queries |
| **Documents**           | 10M per tenant  | Neo4j: ~15GB, 50ms queries  |
| **Vector Chunks**       | 100M total      | OpenSearch: ~8TB, 60-180ms  |
| **Groups**              | 10K per tenant  | Neo4j: ~10MB                |
| **Group Depth**         | 20 levels max   | With cycle detection        |
| **Concurrent Searches** | 1000 qps        | OpenSearch horizontal scale |

### Optimization Strategies

1. **Caching**
   - Flattened permissions: Redis (5-minute TTL)
   - User → groups: Redis (1-hour TTL)
   - Neo4j query results: Redis (query-specific TTL)

2. **Batching**
   - Webhook processing: 30-second batch window
   - OpenSearch bulk updates: 100 records per API call
   - Neo4j batch queries: 20 documents per query

3. **Indexing**
   - Neo4j: Composite indexes on (tenantId, email), (tenantId, groupId)
   - OpenSearch: Keyword indexes on permission arrays
   - MongoDB: Compound indexes on (tenantId, status)

4. **Denormalization**
   - Permissions flattened to OpenSearch (avoid two-query pattern)
   - User groupIds cached in session JWT (avoid Neo4j lookup per search)

---

## Implementation Plan

### Phase 1: Neo4j Permission Graph (4 weeks)

**Week 1: Schema & Infrastructure**

- Task 1.1: Design Neo4j schema (users, groups, documents)
- Task 1.2: Create PermissionGraphClient (CRUD operations)
- Task 1.3: Implement unique constraints & indexes
- Task 1.4: Add tenant isolation to all queries
- Task 1.5: Write unit tests for client

**Week 2: Graph Queries & Resolvers**

- Task 2.1: Implement getUserGroups (recursive, with cycle detection)
- Task 2.2: Implement getAccessibleDocuments (multi-path query)
- Task 2.3: Implement getFlattenedPermissions (for vector DB)
- Task 2.4: Add Redis caching layer (5-min TTL)
- Task 2.5: Performance benchmarks (10M docs, 100K users)

**Week 3: Migration & Dual-Write**

- Task 3.1: Create migration script (DocumentPermission → Neo4j)
- Task 3.2: Implement dual-write (MongoDB + Neo4j)
- Task 3.3: Run migration on staging (verify data parity)
- Task 3.4: Add feature flag (read from Neo4j vs MongoDB)
- Task 3.5: Integration tests for migration

**Week 4: Permission Crawler Integration**

- Task 4.1: Modify SharePoint permission crawler to write to Neo4j
- Task 4.2: Update DeltaSyncCoordinator to trigger permission crawl
- Task 4.3: Add permission diff detection (only update if changed)
- Task 4.4: API endpoints: GET /documents/:id/permissions
- Task 4.5: End-to-end test: crawl → Neo4j → query

**Deliverable:** Neo4j stores all permissions, queryable via APIs

---

### Phase 2: Identity Federation (4 weeks)

**Week 5: MongoDB Models & IDP Config**

- Task 5.1: Create EndUserIdentity model + indexes
- Task 5.2: Create TenantIDPConfig model + encryption
- Task 5.3: Add domain verification models (DNS TXT, email)
- Task 5.4: Admin API: POST /tenants/:id/idp-config
- Task 5.5: Admin API: GET /tenants/:id/end-users

**Week 6: Azure AD Integration**

- Task 6.1: Implement AzureADClient (OAuth + Graph API)
- Task 6.2: User delta query (GET /users/delta)
- Task 6.3: Group delta query (GET /groups/delta)
- Task 6.4: Group member enumeration (GET /groups/:id/members)
- Task 6.5: Store deltaLink for incremental sync

**Week 7: User/Group Sync Worker**

- Task 7.1: Create BullMQ queue: idp-sync
- Task 7.2: Implement syncUsersFromAzureAD worker
- Task 7.3: Implement syncGroupsFromAzureAD worker
- Task 7.4: Scheduled job: hourly delta sync
- Task 7.5: Handle user/group deletions (soft delete)

**Week 8: Authentication Flow**

- Task 8.1: End-user login route: GET /auth/login/azuread
- Task 8.2: OAuth callback: GET /auth/callback/azuread
- Task 8.3: Session JWT generation (include groupIds)
- Task 8.4: Modify authMiddleware to support end-user JWTs
- Task 8.5: E2E test: login → sync → search

**Deliverable:** End users authenticate via Azure AD, synced to Neo4j

---

### Phase 3: Vector DB Denormalization (3 weeks)

**Week 9: OpenSearch Mapping & Flattener**

- Task 9.1: Extend OpenSearch mapping (add metadata.permissions)
- Task 9.2: Implement PermissionFlattener service
- Task 9.3: Add Redis caching (5-min TTL)
- Task 9.4: Handle size limits (500 users, 100 groups)
- Task 9.5: Unit tests for flattener

**Week 10: Embedding Worker Integration**

- Task 10.1: Modify embedding-worker.ts to include permissions
- Task 10.2: Call permissionFlattener.flattenDocument()
- Task 10.3: Add permissions to vector record metadata
- Task 10.4: Test with 10K document ingestion
- Task 10.5: Verify OpenSearch metadata schema

**Week 11: Search Query Integration**

- Task 11.1: Modify search API to build permission filter
- Task 11.2: Get user groups from Neo4j (cached)
- Task 11.3: OpenSearch query with permission filter
- Task 11.4: Performance benchmark (vs two-query pattern)
- Task 11.5: E2E test: user searches, sees only authorized docs

**Deliverable:** Single-query search with permission authorization

---

### Phase 4: Real-Time Updates (3-4 weeks)

**Week 12: Webhook Infrastructure**

- Task 12.1: Create WebhookSubscriptionConnector model
- Task 12.2: Subscribe to SharePoint drive changes
- Task 12.3: Webhook receiver endpoint: POST /webhooks/sharepoint/:id
- Task 12.4: Validate clientState (security check)
- Task 12.5: Queue permission update jobs (30s batch delay)

**Week 13: Permission Change Processor**

- Task 13.1: Create BullMQ queue: permission-updates
- Task 13.2: Implement processPermissionChange worker
- Task 13.3: Fetch new permissions from SharePoint
- Task 13.4: Update Neo4j graph
- Task 13.5: Bulk update OpenSearch metadata (100 chunks/batch)

**Week 14: Delta Query Backup**

- Task 14.1: Implement SharePoint permission delta query
- Task 14.2: Scheduled job: hourly permission sync
- Task 14.3: Deduplication (skip if already processed by webhook)
- Task 14.4: Store deltaLink for incremental queries
- Task 14.5: Monitoring: permission sync lag metrics

**Week 15: Webhook Renewal & Cleanup**

- Task 15.1: Scheduled job: renew webhooks (every 12 hours)
- Task 15.2: Webhook expiry detection and re-subscription
- Task 15.3: Cleanup expired subscriptions (weekly)
- Task 15.4: Alert on renewal failures (PagerDuty)
- Task 15.5: E2E test: permission change → webhook → update → search

**Deliverable:** <10 min permission propagation via webhooks + delta

---

### Phase 5: Additional IDPs (4 weeks)

**Week 16-17: Okta Integration**

- Task 16.1: Implement OktaClient (OAuth + SCIM API)
- Task 16.2: User sync via SCIM
- Task 16.3: Group sync via SCIM
- Task 16.4: Event Hooks for real-time updates
- Task 16.5: E2E test: Okta login → search

**Week 18-19: Google Workspace Integration**

- Task 18.1: Implement GoogleClient (OAuth + Directory API)
- Task 18.2: User sync via Directory API
- Task 18.3: Group sync via Directory API
- Task 18.4: Push notifications for changes
- Task 18.5: E2E test: Google login → search

**Deliverable:** Multi-IDP support (Azure AD, Okta, Google)

---

### Milestones

| Milestone                   | Week    | Deliverable                          |
| --------------------------- | ------- | ------------------------------------ |
| **M1: Neo4j Foundation**    | Week 4  | Permission graph operational         |
| **M2: Identity Federation** | Week 8  | Azure AD users synced, searchable    |
| **M3: Single-Query Auth**   | Week 11 | Vector metadata includes permissions |
| **M4: Real-Time Updates**   | Week 15 | <10 min permission propagation       |
| **M5: Multi-IDP**           | Week 19 | Okta + Google support                |

**Total: 19 weeks (4.75 months)**

---

## Open Questions

### Question 1: Identity Federation Trust Model ✅ RESOLVED

**Decision:** IDP-based authentication eliminates spoofing risk

- Domain verification OPTIONAL (only for tenant-connector attestation)
- Use DNS TXT (primary) + email verification (fallback) for attestation

---

### Question 2: Group Hierarchy Depth ✅ RESOLVED

**Decision:** Hard limit at 20 levels with cycle detection

- Typical: 3-5 levels
- Prevents infinite loops from circular references

---

### Question 3: Permission Update Batch Strategy ✅ RESOLVED

**Decision:** Async batch processing with 30-second delay

- Collect related webhooks in batch window
- Process in background (BullMQ)
- Bulk update OpenSearch (100 chunks per API call)

**Folder Inheritance:** Yes, recursively enumerate children and update

---

### Question 4: Permission Consistency ✅ RESOLVED

**Decision:** Eventual consistency (5-10 min propagation)

- Aligns with "near real-time" requirement
- Better UX (no blocking search)
- Acceptable for search use case

---

### Question 5: Public Document Optimization ✅ RESOLVED

**Decision:** Skip user/group arrays if `publicInDomain: true` OR `publicEverywhere: true`

- Significant storage savings (30KB → 200 bytes)
- Faster queries (skip array checks)

**Clarification:**

- `publicEverywhere: true` → Anonymous access, empty arrays
- `publicInDomain: true` + `allowedDomains` → Everyone in domains, empty arrays
- `publicInDomain: false` + `allowedDomains` → Specific users/groups from domains, populated arrays

---

### Question 6: Multi-Connector Identity ✅ RESOLVED

**Decision:** Unified identity (email as universal key)

- `alice@contoso.com` = same person across SharePoint + Jira
- Single Neo4j User node with multiple group memberships
- Search returns results from all connectors

---

### Question 7: Permission Inheritance ✅ RESOLVED

**Decision:** Denormalize at crawl time (Option A)

- Resolve folder permissions to all child files
- Store flattened permissions in Neo4j
- Simpler queries (no multi-hop traversal)
- Must recrawl when folder permission changes (handled by webhooks)

---

### Question 8: Conflict Resolution ✅ RESOLVED

**Decision:** Follow source system rules (Option C)

- Don't override security model from SharePoint/Jira
- Explicit DENY wins (if source system has deny)
- Most permissive wins (if source system allows)
- Preserve original behavior to avoid security bypass

---

## References

### Internal Documents

- `/tmp/searchai-permission-architecture-analysis.md` - Codebase analysis (98KB)
- Task #23 - Comprehensive codebase analysis (completed)
- Tasks #18-22 - Permission system master tasks

### External Standards

- **OAuth 2.0** - RFC 6749 (authorization framework)
- **OIDC** - OpenID Connect Core 1.0 (authentication layer)
- **SCIM 2.0** - RFC 7643/7644 (user provisioning)
- **Microsoft Graph API** - User/group delta queries
- **Neo4j Cypher** - Graph query language
- **OpenSearch k-NN** - Vector similarity search

### Architecture Patterns

- **Identity Federation** - SAML, OIDC, OAuth
- **Permission Graph** - Graph-based ACLs
- **Vector Search** - Metadata filtering at query time
- **Event-Driven** - Webhook subscriptions + delta queries
- **Multi-Tenancy** - Tenant isolation at all layers

---

**END OF RFC-001**

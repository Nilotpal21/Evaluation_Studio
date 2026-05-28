# Neo4j Permission Graph Schema

**Version:** 1.0.0
**Last Updated:** 2026-02-24
**Package:** `@agent-platform/search-ai-internal`

---

## Overview

This document defines the Neo4j graph database schema for SearchAI's enterprise permission and authorization system. The graph stores:

- **User identities** (from Identity Providers like Azure AD, Okta, Google)
- **Group hierarchies** (with unlimited nesting, 20-level depth limit)
- **Document permissions** (from connectors like SharePoint, Jira, Confluence)
- **Domain relationships** (for domain-scoped public access)

**Design Principles:**

1. **Tenant Isolation:** All nodes include `tenantId` property, all queries filtered by tenant
2. **Email-Based Identity:** User email (lowercase) is universal key across all systems
3. **Recursive Group Resolution:** Support unlimited group nesting with cycle detection
4. **Performance:** All queries <50ms target for 10M documents with proper indexes

---

## Node Labels

### 1. User Node

Represents an end-user identity from the Identity Provider (IDP).

```cypher
(:User {
  // Compound primary key
  tenantId: String!,           // Tenant isolation
  email: String!,              // Universal identity key (LOWERCASE)

  // IDP metadata
  idpUserId: String,           // IDP-specific ID (e.g., Azure AD object ID)
  idpProvider: String,         // 'azuread' | 'okta' | 'google'
  displayName: String,         // User's display name

  // Derived fields
  domain: String,              // Extracted from email (lowercase)

  // Status tracking
  status: String,              // 'active' | 'suspended' | 'deleted'
  lastSyncAt: DateTime,        // Last synced from IDP
  createdAt: DateTime          // First seen in system
})
```

**Example:**

```cypher
(:User {
  tenantId: "tenant-123",
  email: "alice@contoso.com",
  idpUserId: "00000000-0000-0000-0000-000000000001",
  idpProvider: "azuread",
  displayName: "Alice Johnson",
  domain: "contoso.com",
  status: "active",
  lastSyncAt: datetime("2026-02-24T12:00:00Z"),
  createdAt: datetime("2026-01-15T08:00:00Z")
})
```

**Key Design Decisions:**

- **Email as primary key:** OAuth, SAML, OIDC all use email as universal identifier
- **Lowercase normalization:** `Alice@Contoso.com` → `alice@contoso.com` for consistency
- **IDP-agnostic model:** Same schema works for Azure AD, Okta, Google Workspace
- **Soft deletes:** `status: 'deleted'` preserves history (audit trail)

---

### 2. Group Node

Represents a security group from IDP or connector.

```cypher
(:Group {
  // Compound primary key
  tenantId: String!,           // Tenant isolation
  groupId: String!,            // Composite: "{source}:{id}"

  // IDP metadata (if from IDP)
  idpGroupId: String?,         // Azure AD group ID (null if from connector)
  source: String!,             // 'azuread' | 'okta' | 'google' | 'sharepoint' | 'jira'
  displayName: String,         // Group display name
  email: String?,              // Group email (if available)

  // Status tracking
  lastSyncAt: DateTime,        // Last synced from source
  createdAt: DateTime          // First seen in system
})
```

**Examples:**

```cypher
// IDP group
(:Group {
  tenantId: "tenant-123",
  groupId: "azuread:00000000-0000-0000-0000-000000000002",
  idpGroupId: "00000000-0000-0000-0000-000000000002",
  source: "azuread",
  displayName: "Engineering Team",
  email: "engineering@contoso.com",
  lastSyncAt: datetime("2026-02-24T12:00:00Z"),
  createdAt: datetime("2026-01-15T08:00:00Z")
})

// SharePoint group (connector-specific)
(:Group {
  tenantId: "tenant-123",
  groupId: "sharepoint:site-owners-123",
  idpGroupId: null,
  source: "sharepoint",
  displayName: "Site Owners - Engineering",
  email: null,
  lastSyncAt: datetime("2026-02-24T12:00:00Z"),
  createdAt: datetime("2026-02-20T10:00:00Z")
})
```

**Key Design Decisions:**

- **Composite groupId:** Ensures uniqueness across sources (`azuread:group1` vs `sharepoint:group1`)
- **Source tracking:** Distinguish IDP groups (universal) from connector-specific groups
- **Optional IDP linkage:** Connector groups may map to IDP groups via admin configuration
- **Support for nested hierarchies:** Groups can contain other groups (unlimited depth)

---

### 3. Document Node

Represents a searchable document from a connector.

```cypher
(:Document {
  // Compound primary key
  tenantId: String!,           // Tenant isolation
  documentId: String!,         // SearchDocument._id (MongoDB)

  // Connector metadata
  sourceId: String!,           // Connector ID (ConnectorConfig._id)
  source: String,              // 'sharepoint' | 'jira' | 'confluence'

  // Document metadata
  name: String,                // Document name/title
  path: String,                // Document path (for debugging)

  // Permission flags
  publicInDomain: Boolean,     // Accessible to all users in allowedDomains
  publicEverywhere: Boolean,   // Accessible to everyone (anonymous)

  // Tracking
  lastPermissionCrawlAt: DateTime,  // Last permission crawl
  createdAt: DateTime               // First indexed
})
```

**Example:**

```cypher
(:Document {
  tenantId: "tenant-123",
  documentId: "doc-456",
  sourceId: "connector-789",
  source: "sharepoint",
  name: "Q1 Sales Report.docx",
  path: "/sites/Sales/Shared Documents/Q1 Sales Report.docx",
  publicInDomain: true,
  publicEverywhere: false,
  lastPermissionCrawlAt: datetime("2026-02-24T12:00:00Z"),
  createdAt: datetime("2026-02-20T14:30:00Z")
})
```

**Key Design Decisions:**

- **documentId maps to MongoDB:** Links to SearchDocument for vector data
- **Permission flags for optimization:** Avoid graph traversal for public documents
- **sourceId for multi-connector:** Track which connector owns the document

---

### 4. Domain Node

Represents a verified email domain (for domain-scoped permissions).

```cypher
(:Domain {
  // Compound primary key
  tenantId: String!,           // Tenant isolation
  domain: String!,             // Email domain (lowercase, e.g., "contoso.com")

  // Verification metadata
  verified: Boolean,           // Whether domain is verified
  verificationMethod: String,  // 'dns' | 'email' | 'manual' | 'idp-trust'
  verifiedAt: DateTime,        // When verification completed

  // Tracking
  createdAt: DateTime          // First seen
})
```

**Example:**

```cypher
(:Domain {
  tenantId: "tenant-123",
  domain: "contoso.com",
  verified: true,
  verificationMethod: "idp-trust",
  verifiedAt: datetime("2026-01-15T08:00:00Z"),
  createdAt: datetime("2026-01-15T08:00:00Z")
})
```

**Key Design Decisions:**

- **IDP-trust verification:** If tenant uses Azure AD with domain, auto-verify (see RFC-003 Question 1)
- **Optional domain verification:** Only required for tenant-connector attestation, not security
- **Domain-scoped public access:** Documents marked `publicInDomain: true` accessible to all users in domain

---

## Relationship Types

### 1. MEMBER_OF (User → Group)

User belongs to a group.

```cypher
(:User)-[:MEMBER_OF {
  source: String,              // 'azuread' | 'sharepoint' | 'jira'
  syncedAt: DateTime           // When membership was synced
}]->(:Group)
```

**Example:**

```cypher
(alice:User {email: "alice@contoso.com"})
  -[:MEMBER_OF {source: "azuread", syncedAt: datetime("2026-02-24T12:00:00Z")}]->
(engineering:Group {groupId: "azuread:engineering"})
```

---

### 2. MEMBER_OF (Group → Group)

Group nested within parent group (supports unlimited depth).

```cypher
(:Group)-[:MEMBER_OF {
  source: String,              // 'azuread' | 'sharepoint'
  syncedAt: DateTime
}]->(:Group)
```

**Example (Nested Groups):**

```cypher
(devTeam:Group {groupId: "azuread:dev-team"})
  -[:MEMBER_OF]->
(engineering:Group {groupId: "azuread:engineering"})
  -[:MEMBER_OF]->
(allStaff:Group {groupId: "azuread:all-staff"})
```

**Cycle Detection:** Cypher queries include `WHERE NOT (g)-[:MEMBER_OF*]->(u)` to prevent infinite loops.

---

### 3. HAS_PERMISSION (User → Document)

User has direct permission to document.

```cypher
(:User)-[:HAS_PERMISSION {
  role: String,                // 'read' | 'write' | 'owner'
  source: String,              // 'sharepoint' | 'jira'
  grantedAt: DateTime          // When permission was granted
}]->(:Document)
```

**Example:**

```cypher
(alice:User {email: "alice@contoso.com"})
  -[:HAS_PERMISSION {role: "owner", source: "sharepoint", grantedAt: datetime()}]->
(doc:Document {documentId: "doc-456"})
```

---

### 4. HAS_PERMISSION (Group → Document)

Group has permission to document (applies to all members recursively).

```cypher
(:Group)-[:HAS_PERMISSION {
  role: String,
  source: String,
  grantedAt: DateTime
}]->(:Document)
```

**Example:**

```cypher
(engineering:Group {groupId: "azuread:engineering"})
  -[:HAS_PERMISSION {role: "read", source: "sharepoint", grantedAt: datetime()}]->
(doc:Document {documentId: "doc-456"})
```

**Recursive Resolution:** If Alice is in DevTeam, DevTeam is in Engineering, and Engineering has permission to doc → Alice has permission.

---

### 5. PUBLIC_IN (Document → Domain)

Document is accessible to all users in domain.

```cypher
(:Document)-[:PUBLIC_IN]->(:Domain)
```

**Example:**

```cypher
(doc:Document {documentId: "doc-456", publicInDomain: true})
  -[:PUBLIC_IN]->
(domain:Domain {domain: "contoso.com"})

// All users with @contoso.com email can access this document
```

---

## Constraints & Indexes

### Unique Constraints

Enforce uniqueness on compound keys (tenant + primary key).

```cypher
// Prevent duplicate users
CREATE CONSTRAINT user_unique IF NOT EXISTS
FOR (u:User) REQUIRE (u.tenantId, u.email) IS UNIQUE;

// Prevent duplicate groups
CREATE CONSTRAINT group_unique IF NOT EXISTS
FOR (g:Group) REQUIRE (g.tenantId, g.groupId) IS UNIQUE;

// Prevent duplicate documents
CREATE CONSTRAINT document_unique IF NOT EXISTS
FOR (d:Document) REQUIRE (d.tenantId, d.documentId) IS UNIQUE;

// Prevent duplicate domains
CREATE CONSTRAINT domain_unique IF NOT EXISTS
FOR (d:Domain) REQUIRE (d.tenantId, d.domain) IS UNIQUE;
```

**Why compound keys?**

- Multi-tenancy: Same email/groupId can exist in different tenants
- Data integrity: Prevents duplicate inserts

---

### Performance Indexes

Optimize common query patterns.

```cypher
// Fast user lookup by IDP ID (for IDP sync)
CREATE INDEX user_idp IF NOT EXISTS
FOR (u:User) ON (u.tenantId, u.idpUserId);

// Fast user lookup by domain (for domain-scoped queries)
CREATE INDEX user_domain IF NOT EXISTS
FOR (u:User) ON (u.tenantId, u.domain);

// Fast group lookup by source (for connector sync)
CREATE INDEX group_source IF NOT EXISTS
FOR (g:Group) ON (g.tenantId, g.source);

// Fast document lookup by connector (for permission updates)
CREATE INDEX document_source IF NOT EXISTS
FOR (d:Document) ON (d.tenantId, d.sourceId);
```

**Index Selection Rationale:**

- `user_idp`: IDP delta sync looks up users by `idpUserId`
- `user_domain`: Domain-scoped permission checks filter by domain
- `group_source`: Connector sync filters groups by source
- `document_source`: Permission updates filter documents by connector

---

## Query Patterns

### Query 1: Get All Groups for User (Recursive)

Resolves all groups user belongs to (direct + inherited).

```cypher
MATCH (u:User {tenantId: $tenantId, email: $email})
      -[:MEMBER_OF*1..20]->(g:Group)
WHERE NOT (g)-[:MEMBER_OF*]->(u:User)  // Cycle detection
RETURN DISTINCT g.groupId
```

**Performance:** <10ms for 100 groups, <50ms for 1000 groups

**Example Result:**

```json
["azuread:dev-team", "azuread:engineering", "azuread:all-staff", "sharepoint:site-members-123"]
```

---

### Query 2: Get All Accessible Documents for User

Finds all documents user can access (4 paths: direct, group, domain, public).

```cypher
MATCH (u:User {tenantId: $tenantId, email: $email})

// Path 1: Direct user permission
OPTIONAL MATCH (u)-[:HAS_PERMISSION]->(doc1:Document)

// Path 2: Group permission (recursive up to 20 levels)
OPTIONAL MATCH (u)-[:MEMBER_OF*1..20]->(g:Group)
                  -[:HAS_PERMISSION]->(doc2:Document)

// Path 3: Public in user's domain
OPTIONAL MATCH (doc3:Document {tenantId: $tenantId, publicInDomain: true})
                  -[:PUBLIC_IN]->(d:Domain)
WHERE u.domain = d.domain

// Path 4: Public everywhere
OPTIONAL MATCH (doc4:Document {tenantId: $tenantId, publicEverywhere: true})

RETURN COLLECT(DISTINCT doc1.documentId) +
       COLLECT(DISTINCT doc2.documentId) +
       COLLECT(DISTINCT doc3.documentId) +
       COLLECT(DISTINCT doc4.documentId) AS documentIds
LIMIT 10000
```

**Performance:** <50ms for 10M documents with indexes

**Use Case:** Authorization filter for search queries

---

### Query 3: Get Flattened Permissions for Document

Returns all users, groups, and domains that can access a document (for vector DB denormalization).

```cypher
MATCH (doc:Document {tenantId: $tenantId, documentId: $documentId})

// Collect direct users
OPTIONAL MATCH (u:User)-[:HAS_PERMISSION]->(doc)
WITH doc, COLLECT(DISTINCT u.email) AS allowedUsers

// Collect groups (users are resolved at query time)
OPTIONAL MATCH (g:Group)-[:HAS_PERMISSION]->(doc)
WITH doc, allowedUsers, COLLECT(DISTINCT g.groupId) AS allowedGroups

// Collect domains (if public in domain)
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

**Performance:** <20ms per document

**Use Case:** Permission flattener writes this to OpenSearch `metadata.permissions`

---

## Cycle Detection & Depth Limits

### Depth Limit

**Hard Limit:** 20 levels (configurable via `NEO4J_MAX_GROUP_DEPTH`)

**Rationale:**

- Typical enterprise: 3-5 levels (Company → Division → Department → Team)
- Microsoft Azure AD: No documented limit, warns about performance >10 levels
- Prevents infinite loops from misconfigured circular references

**Cypher Implementation:**

```cypher
MATCH (u:User {tenantId: $tenantId, email: $email})
      -[:MEMBER_OF*1..20]->(g:Group)  // Max 20 hops
RETURN g.groupId
```

---

### Cycle Detection

**Strategy:** Exclude paths that loop back to the starting node.

**Cypher Implementation:**

```cypher
MATCH (u:User {tenantId: $tenantId, email: $email})
      -[:MEMBER_OF*1..20]->(g:Group)
WHERE NOT (g)-[:MEMBER_OF*]->(u)  // Prevent cycles
RETURN g.groupId
```

**Example Cycle:**

```
GroupA -[:MEMBER_OF]-> GroupB -[:MEMBER_OF]-> GroupA  (cycle!)
```

Without cycle detection, query would loop infinitely. The `WHERE NOT` clause breaks the cycle.

---

## Migration Strategy

### Phase 1: Initial Schema Setup

1. Create constraints (unique keys)
2. Create indexes (performance)
3. Verify schema with test data

### Phase 2: Data Migration

1. Migrate existing `DocumentPermission` (MongoDB) → Neo4j
2. Dual-write during migration (both MongoDB + Neo4j)
3. Verify data consistency

### Phase 3: Cutover

1. Switch queries to Neo4j
2. Deprecate MongoDB permission queries
3. Archive old `DocumentPermission` collection

---

## Tenant Isolation

**Critical:** All queries MUST filter by `tenantId` to prevent cross-tenant data leakage.

**Example (Safe):**

```cypher
MATCH (u:User {tenantId: $tenantId, email: $email})  // ✅ Includes tenantId
RETURN u
```

**Example (UNSAFE):**

```cypher
MATCH (u:User {email: $email})  // ❌ Missing tenantId - SECURITY VULNERABILITY
RETURN u
```

**Validation:** All production queries must include `tenantId` in the first MATCH clause.

---

## Related Documentation

- **RFC-003**: Complete permission architecture specification
- **Permission Implementation Plan**: Task breakdown and timeline
- **Codebase Analysis**: Current state and gaps

---

**Schema Version:** 1.0.0
**Next Review:** After Phase 1 implementation (Week 4)
